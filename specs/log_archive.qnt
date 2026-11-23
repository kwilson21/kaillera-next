// Archiving a match's session log to R2 and evicting it from D1
// (server/src/log_archive.py: archive_match, evict_match, sweep; the
// readers in db.py, which switch on match_retention.evicted_at; and
// retention.py's tombstoned delete).
//
// D1's free 500 MB holds about 23 ten-minute two-player matches, and a
// match's chunks stayed in D1 for its whole retention window. Now, once a
// match's ingest window has closed (no more HTTP uploads), its log is
// archived to R2 (one object per slot for the log, the input audit and the
// context, under matches/<id>/), and D1_HOT_DAYS after the archive its
// chunks leave D1.
//
// - archive: note the newest chunk id, upload what D1 holds up to it under
//   keys that carry a token of this attempt's own, then record archived_at,
//   archived_max_chunk_id and the token in one statement, only if every
//   upload succeeded, no other attempt recorded first and no delete has
//   started meanwhile. A failed upload or a refused record takes back what
//   this attempt uploaded: retention's prefix delete may have run before the
//   upload landed. Two attempts can run at once (two servers sweep during a
//   deploy); keyed by the chunk id alone they would share keys, and the one
//   refused would take back the other's recorded objects. An archive can stop
//   anywhere (a crash, a deploy); the next sweep starts again.
// - evict: one batch sets evicted_at, then deletes the chunks the archive
//   holds: an id up to archived_max_chunk_id AND a created_at no later than
//   archived_at. D1's HTTP batch is not documented as a transaction, so the
//   delete may run with the mark or not (a batch that stopped part-way), and
//   again later (the sweep finishing a partial batch, or a second server's
//   sweep).
// - a chunk can land after the archive or after the eviction: the socket
//   path takes a room's live match past its upload window. SQLite gives a
//   new row max(id) + 1, so once the eviction has deleted the newest rows a
//   later chunk can take an id the archive covers. Ids here follow that rule
//   over this match's rows alone, the worst case for reuse (other matches'
//   rows only push max(id) up). created_at comes from a clock at one-second
//   resolution: everything up to and including the archive shares a time
//   (the same-second case created_at has to get right), and the clock moves
//   on when D1_HOT_DAYS pass.
// - read: D1 until evicted_at; after it, the archive the record's token names, then
//   the chunks the archive does not hold (an id past archived_max_chunk_id
//   OR a created_at after archived_at). Each chunk is read from exactly one
//   place.
// - retention deletes the match's R2 prefix, then its D1 rows; the archive
//   objects go with the prefix.
// - the blob store is durable (R2) or not (a local folder, which a deploy
//   wipes). The archive and the eviction run only into a durable one
//   (log_archive.archive_enabled; LOG_ARCHIVE_LOCAL=1 lets tests and local
//   dev use the folder), so a non-durable store leaves the log in D1.
//
// Not modelled: more than one slot (each slot's objects and chunks follow
// the same steps), the input audit and context (archived and read the same
// way as the log), the size caps and eviction records (the archived log
// starts with its SERVER-LOG-EVICTED lines, as a D1 read does, and a reader
// adds D1's when a cap deleted more after the archive), and retention's
// interrupted deletes (retention_sweep's own tests).
//
// Known gap (orphaned): an archive whose upload lands after retention's
// prefix delete, and which then stops before it can take the upload back,
// leaves those objects behind; nothing points at them and nothing reads
// them. Within one server the archive and the delete run one after the other
// in the same sweep, so this needs two servers (a deploy) and a crash in the
// same seconds. The design doc's orphan sweep (§8 item 6) is the fix.
//
// Rejected variants:
// RECORD_FIRST: archived_at is recorded before the uploads are confirmed.
// EVICT_ALL: eviction deletes every chunk, not just those the archive holds.
// ARCHIVE_ONLY: once evicted, readers read the archive alone.
// IGNORE_TOMBSTONE: an archive that finds a delete started keeps its objects.
// READ_ALL_TAIL: once evicted, readers read the archive and then every chunk
//   still in D1, trusting the delete to have run.
// DELETE_BY_ID_ONLY: the eviction deletes by id alone (id <= max), so a
//   delete that runs again after a chunk reused an id removes it.
// KEY_BY_THROUGH: an attempt's keys carry only the chunk id it archived
//   through, so two attempts at once share them.
// ANY_STORE: archives and evicts into whatever blob store it has. Without R2
//   configured that is a folder on the instance's disk, which a deploy
//   wipes (`wipe`): the chunks are gone from D1 and the archive with it.
module log_archive {
  const RECORD_FIRST: bool
  const EVICT_ALL: bool
  const ARCHIVE_ONLY: bool
  const IGNORE_TOMBSTONE: bool
  const READ_ALL_TAIL: bool
  const DELETE_BY_ID_ONLY: bool
  const KEY_BY_THROUGH: bool
  const ANY_STORE: bool

  pure val MAX_CHUNKS = 2
  pure val SERIALS = 0.to(MAX_CHUNKS - 1)
  pure val MAX_TIME = 1
  pure val NONE = -1
  // Two servers' sweeps, and the attempts they may make.
  pure val ARCHIVERS = Set(0, 1)
  pure val MAX_ATTEMPTS = 2
  // What an attempt's keys can carry: a chunk id (rejected) or a token.
  pure val KEYS = 0.to(MAX_CHUNKS + MAX_ATTEMPTS)

  type Archiver = {
    running: bool,
    snapshot: Set[int],  // the chunks this attempt set out to upload
    through: int,        // their newest id
    key: int,            // what this attempt's object keys carry
    uploaded: bool,
  }
  pure val IDLE: Archiver = { running: false, snapshot: Set(), through: NONE, key: NONE, uploaded: false }

  type State = {
    // D1. A chunk's serial is its identity; its id is the row id SQLite gave it.
    d1: Set[int],
    nextChunk: int,
    idOf: int -> int,
    createdOf: int -> int,
    written: Set[int],
    clock: int,
    live: bool,          // the room's live match: socket flushes still land
    windowOpen: bool,    // the ingest window: HTTP uploads accepted
    hotOver: bool,       // D1_HOT_DAYS since the archive
    // The archive
    archivers: int -> Archiver,
    attempts: int,             // attempts begun, for their tokens
    objects: int -> Set[int],  // R2: the chunks under each key an attempt's objects carry
    archivedThrough: int,      // archived_max_chunk_id; NONE until recorded
    archivedKey: int,          // the recorded attempt's key (archive_token)
    archivedAt: int,
    recorded: Set[int],        // the chunks the recorded archive holds
    evicted: bool,             // evicted_at
    // Retention
    deleting: bool,      // the tombstone, deleting_at
    gone: bool,          // the delete finished: match_retention is deleted
    // An archive stopped after its upload landed past a delete (Known gap).
    orphaned: bool,
    // The blob store survives a deploy (R2), or not (a local folder).
    durable: bool,
  }

  var s: State

  pure def newestId(st: State, chunks: Set[int]): int =
    chunks.fold(0, (m, c) => if (st.idOf.get(c) > m) st.idOf.get(c) else m)

  // The objects under one key.
  pure def attempt(st: State, key: int): Set[int] = if (KEYS.contains(key)) st.objects.get(key) else Set()

  pure def allObjects(st: State): Set[int] = KEYS.fold(Set(), (acc, k) => acc.union(st.objects.get(k)))

  pure def without(st: State, key: int): int -> Set[int] =
    if (KEYS.contains(key)) st.objects.set(key, Set()) else st.objects

  pure def anyArchiving(st: State): bool = ARCHIVERS.exists(a => st.archivers.get(a).running)

  // The chunks a recorded archive holds, as the eviction's DELETE and the
  // readers pick them out of D1.
  pure def held(st: State, c: int): bool =
    st.idOf.get(c) <= st.archivedThrough
      and (DELETE_BY_ID_ONLY or st.createdOf.get(c) <= st.archivedAt)

  // After the eviction, the D1 chunks a reader takes after the archive.
  pure def d1Tail(st: State): Set[int] =
    if (ARCHIVE_ONLY) Set()
    else if (READ_ALL_TAIL) st.d1
    else st.d1.filter(c => st.idOf.get(c) > st.archivedThrough or st.createdOf.get(c) > st.archivedAt)

  pure def fromArchive(st: State): Set[int] = attempt(st, st.archivedKey)

  action initWith(durable: bool): bool = s' = {
    d1: Set(), nextChunk: 0, idOf: SERIALS.mapBy(_ => 0), createdOf: SERIALS.mapBy(_ => 0),
    written: Set(), clock: 0, live: true, windowOpen: true, hotOver: false,
    archivers: ARCHIVERS.mapBy(_ => IDLE), attempts: 0, objects: KEYS.mapBy(_ => Set()),
    archivedThrough: NONE, archivedKey: NONE, archivedAt: 0, recorded: Set(), evicted: false,
    deleting: false, gone: false, orphaned: false, durable: durable,
  }

  action init = { nondet durable = Set(true, false).oneOf() initWith(durable) }

  // The archive and the eviction run only into a durable store.
  def storeOk: bool = s.durable or ANY_STORE

  // A flush lands a chunk: the socket path while the room's live match is
  // this one, the HTTP path while the window is open. SQLite's id: one past
  // the largest id left in the table.
  action flush = all {
    s.live or s.windowOpen, not(s.deleting), not(s.gone), s.nextChunk < MAX_CHUNKS,
    val c = s.nextChunk
    s' = { ...s,
      d1: s.d1.union(Set(c)),
      idOf: s.idOf.set(c, newestId(s, s.d1) + 1),
      createdOf: s.createdOf.set(c, s.clock),
      written: s.written.union(Set(c)),
      nextChunk: c + 1,
    },
  }

  // The room moves on (game-ended, a new match).
  action matchEnds = all { s.live, s' = { ...s, live: false } }

  // The ingest window closes: 30 min after the end, or 4 h after the start
  // when no end was recorded (the room may still be on the match).
  action windowCloses = all { s.windowOpen, s' = { ...s, windowOpen: false } }

  // D1_HOT_DAYS pass after the archive: the clock moves on (everything
  // before shares one second, the archive's own included, which is the case
  // created_at has to get right). The room may still be on the match.
  action hotPasses = all {
    s.archivedThrough != NONE, not(s.hotOver), s.clock < MAX_TIME,
    s' = { ...s, hotOver: true, clock: s.clock + 1 },
  }

  // An archive sweep picks the match: its window has closed, it is not
  // archived, and no delete has started. It notes the newest chunk id, and
  // its keys carry a token of its own (or, rejected, that id alone).
  action archiveBegin(a: int): bool = all {
    storeOk, not(s.windowOpen), s.archivedThrough == NONE, not(s.archivers.get(a).running), not(s.deleting), not(s.gone),
    s.attempts < MAX_ATTEMPTS,
    val through = newestId(s, s.d1)
    val key = if (KEY_BY_THROUGH) through else MAX_CHUNKS + 1 + s.attempts
    s' = { ...s,
      archivers: s.archivers.set(a, { running: true, snapshot: s.d1, through: through, key: key, uploaded: false }),
      attempts: s.attempts + 1,
      archivedThrough: if (RECORD_FIRST) through else s.archivedThrough,
      archivedKey: if (RECORD_FIRST) key else s.archivedKey,
      archivedAt: if (RECORD_FIRST) s.clock else s.archivedAt,
      recorded: if (RECORD_FIRST) s.d1 else s.recorded,
    },
  }

  // Its uploads land, or one fails and it takes back what landed under its
  // keys. They are in flight: a delete, or another attempt, may have run
  // meanwhile.
  action archiveUpload(a: int, ok: bool): bool = all {
    val me = s.archivers.get(a)
    all {
      me.running, not(me.uploaded),
      s' = { ...s,
        archivers: s.archivers.set(a, { ...me, uploaded: ok }),
        objects: if (ok) s.objects.set(me.key, me.snapshot) else without(s, me.key),
      },
    },
  }

  // One statement records archived_at, only if every upload succeeded, no
  // attempt recorded first, nothing else refuses it (`quiet`) and no delete
  // has started. Refused, the attempt takes back what is under its keys.
  action archiveFinish(a: int, quiet: bool): bool = all {
    val me = s.archivers.get(a)
    all {
      me.running,
      // No other attempt has recorded (recording first, this one did at its start).
      val first = s.archivedThrough == NONE or (RECORD_FIRST and s.archivedKey == me.key)
      val recordable = me.uploaded and quiet and first and not(s.deleting) and not(s.gone)
      val record = recordable and not(RECORD_FIRST)
      val keep = recordable or ((s.deleting or s.gone) and IGNORE_TOMBSTONE)
      s' = { ...s,
        archivers: s.archivers.set(a, IDLE),
        archivedThrough: if (record) me.through else s.archivedThrough,
        archivedKey: if (record) me.key else s.archivedKey,
        archivedAt: if (record) s.clock else s.archivedAt,
        recorded: if (record) me.snapshot else s.recorded,
        objects: if (keep) s.objects else without(s, me.key),
      },
    },
  }

  // The archive stops (a crash, a deploy) wherever it is: what landed stays.
  action archiveCrash(a: int): bool = all {
    val me = s.archivers.get(a)
    all {
      me.running,
      s' = { ...s,
        archivers: s.archivers.set(a, IDLE),
        orphaned: s.orphaned or ((s.deleting or s.gone) and attempt(s, me.key) != Set()),
      },
    },
  }

  pure def afterDelete(st: State): Set[int] = if (EVICT_ALL) Set() else st.d1.filter(c => not(held(st, c)))

  // The eviction batch: evicted_at, once, and its DELETE, which acts only
  // once evicted_at is set — or not, when the batch stops part-way.
  action evict(deleteToo: bool): bool = all {
    storeOk, s.archivedThrough != NONE, s.hotOver, not(s.evicted), not(s.deleting), not(s.gone),
    s' = { ...s, evicted: true, d1: if (deleteToo) afterDelete(s) else s.d1 },
  }

  // The DELETE again later: the sweep finishing a partial batch, or a
  // second server's eviction (and then it may find nothing).
  action evictDelete = all {
    storeOk, s.evicted, not(s.deleting), not(s.gone), s' = { ...s, d1: afterDelete(s) },
  }

  // Nothing happens: a scenario's step where a variant has nothing to do.
  action stutter = s' = s

  // Retention: the match expires and is tombstoned; then the R2 prefix and
  // the D1 rows go, match_retention last.
  action tombstone = all {
    not(s.live), not(s.windowOpen), not(s.deleting), not(s.gone), s' = { ...s, deleting: true },
  }

  // A deploy wipes a store that isn't durable.
  action wipe = all { not(s.durable), s' = { ...s, objects: KEYS.mapBy(_ => Set()) } }

  action finishDelete = all {
    s.deleting, not(s.gone), s' = { ...s, objects: KEYS.mapBy(_ => Set()), d1: Set(), gone: true },
  }

  action step = {
    nondet a = ARCHIVERS.oneOf()
    nondet ok = Set(true, false).oneOf()
    nondet quiet = Set(true, false).oneOf()
    nondet deleteToo = Set(true, false).oneOf()
    any {
      flush, matchEnds, windowCloses, hotPasses,
      archiveBegin(a), archiveUpload(a, ok), archiveFinish(a, quiet), archiveCrash(a),
      evict(deleteToo), evictDelete, tombstone, finishDelete, wipe,
    }
  }

  // ── Properties ────────────────────────────────────────────────────────

  // What a reader gets: D1 until evicted_at; after it, the archive the
  // record names, then the chunks it does not hold.
  def readable: Set[int] = if (not(s.evicted)) s.d1 else fromArchive(s).union(d1Tail(s))

  // Until retention deletes the match, a reader gets every chunk ever
  // stored, each from exactly one place. Violated by an eviction of every
  // chunk, a reader of the archive alone, a reader of every chunk left in
  // D1 (a partial eviction reads twice), a DELETE by id alone (a rerun
  // removes a chunk that reused an id), and a record before the uploads.
  val logAlwaysReadable =
    (not(s.deleting) and not(s.gone)) implies (
      readable == s.written and (s.evicted implies fromArchive(s).intersect(d1Tail(s)) == Set())
    )

  // archived_at is set only once the archive holds every chunk the record
  // says it does, and nothing takes them back after, so the eviction
  // deletes only what R2 has. Violated when it is recorded before the
  // uploads are confirmed, and when two attempts share keys (the refused one
  // takes back the recorded one's objects).
  val archivedOnlyWhenComplete =
    (s.archivedThrough != NONE and not(s.deleting) and not(s.gone))
      implies s.recorded.forall(c => fromArchive(s).contains(c))

  // Once a delete has finished and no archive is in flight, nothing of the
  // match is left, in D1 or R2 — but for the Known gap. Violated by an
  // archive that keeps its objects after finding the match tombstoned.
  val retentionLeavesNothing =
    (s.gone and not(anyArchiving(s)) and not(s.orphaned)) implies (allObjects(s) == Set() and s.d1 == Set())

  val allHold = logAlwaysReadable and archivedOnlyWhenComplete and retentionLeavesNothing

  // ── Scenarios ─────────────────────────────────────────────────────────

  run archived = archiveBegin(0).then(archiveUpload(0, true)).then(archiveFinish(0, true))

  // Two chunks, the match ends, its window closes: archived, then evicted.
  // A reader gets both from the archive.
  run archiveThenEvictTest =
    initWith(true).then(flush).then(flush).then(matchEnds).then(windowCloses)
      .then(archived)
      .expect(s.archivedThrough == 2 and fromArchive(s) == Set(0, 1) and readable == Set(0, 1))
      .then(hotPasses).then(evict(true))
      .expect(s.evicted and readable == Set(0, 1) and s.d1 == Set())

  // The window closes while the room is still on the match: archived, then
  // a chunk lands. Eviction leaves it in D1, and a reader gets it there.
  run lateChunkTest =
    initWith(true).then(flush).then(windowCloses).then(archived)
      .then(flush).then(hotPasses).then(evict(true))
      .expect(s.written == Set(0, 1))
      .expect(s.d1 == (if (EVICT_ALL) Set() else Set(1)))
      .expect(logAlwaysReadable == not(EVICT_ALL or ARCHIVE_ONLY))

  // A chunk lands after the eviction, taking the id of the chunk it deleted:
  // a reader gets the archive, then it, by its created_at.
  run chunkAfterEvictionTest =
    initWith(true).then(flush).then(windowCloses).then(archived)
      .then(hotPasses).then(evict(true)).then(flush)
      .expect(s.d1 == Set(1) and s.idOf.get(1) == s.idOf.get(0))
      .expect(logAlwaysReadable == not(ARCHIVE_ONLY))

  // The eviction batch stops after its mark: the archived chunk is still in
  // D1. A reader takes it once, from the archive; reading every chunk left
  // in D1 takes it twice. The sweep then finishes the DELETE.
  run partialEvictionTest =
    initWith(true).then(flush).then(windowCloses).then(archived)
      .then(hotPasses).then(evict(false))
      .expect(s.evicted and s.d1 == Set(0))
      .expect(logAlwaysReadable == not(READ_ALL_TAIL))
      .then(evictDelete)
      .expect(s.d1 == Set() and logAlwaysReadable)

  // The delete runs again (the sweep finishing a partial batch, or a second
  // server) after a chunk reused the archived id: it stays. By id alone, the
  // second delete takes it.
  run deleteAgainAfterReuseTest =
    initWith(true).then(flush).then(windowCloses).then(archived)
      .then(hotPasses).then(evict(true)).then(flush)
      .then(evictDelete)
      .expect(logAlwaysReadable == not(DELETE_BY_ID_ONLY or EVICT_ALL or ARCHIVE_ONLY))

  // A write lands while the archive runs and the record is refused: nothing
  // is recorded and nothing is left in R2; the next archive takes the match
  // as it is then.
  run refusedRecordTest =
    initWith(true).then(flush).then(matchEnds).then(windowCloses)
      .then(archiveBegin(0)).then(archiveUpload(0, true)).then(archiveFinish(0, false))
      .expect(s.archivedThrough == (if (RECORD_FIRST) 1 else NONE))
      .expect(s.d1 == Set(0) and allObjects(s) == Set())

  // An upload fails: the match stays un-archived and in D1. Recorded first,
  // the record names an archive that holds nothing.
  run failedUploadTest =
    initWith(true).then(flush).then(matchEnds).then(windowCloses)
      .then(archiveBegin(0)).then(archiveUpload(0, false)).then(archiveFinish(0, true))
      .expect(s.archivedThrough == (if (RECORD_FIRST) 1 else NONE))
      .expect(archivedOnlyWhenComplete == not(RECORD_FIRST))
      .expect(s.d1 == Set(0))

  // The archive stops after its upload, before the record: its objects stay,
  // unread. The next sweep archives the match again, under keys of its own.
  run crashAfterUploadTest =
    initWith(true).then(flush).then(matchEnds).then(windowCloses)
      .then(archiveBegin(0)).then(archiveUpload(0, true)).then(archiveCrash(0))
      .expect(s.archivedThrough == (if (RECORD_FIRST) 1 else NONE) and allObjects(s) == Set(0))
      .then(if (RECORD_FIRST) stutter else archived)
      .expect(s.archivedThrough == 1 and readable == Set(0) and fromArchive(s) == Set(0))

  // A delete starts and finishes while the uploads are in flight; they land
  // after the R2 prefix delete. The archive finds the match gone and deletes
  // what it uploaded.
  run deleteDuringArchiveTest =
    initWith(true).then(flush).then(matchEnds).then(windowCloses)
      .then(archiveBegin(0)).then(tombstone).then(finishDelete)
      .then(archiveUpload(0, true)).then(archiveFinish(0, true))
      .expect(s.archivedThrough == (if (RECORD_FIRST) 1 else NONE))
      .expect(allObjects(s) == (if (IGNORE_TOMBSTONE) Set(0) else Set()))
      .expect(retentionLeavesNothing == not(IGNORE_TOMBSTONE))

  // The Known gap: the same, but the archive stops before it can take the
  // upload back.
  run orphanedByACrashTest =
    initWith(true).then(flush).then(matchEnds).then(windowCloses)
      .then(archiveBegin(0)).then(tombstone).then(finishDelete)
      .then(archiveUpload(0, true)).then(archiveCrash(0))
      .expect(s.orphaned and allObjects(s) == Set(0))

  // Two servers archive the match at once and both upload; one records, the
  // other is refused and takes back what is under its keys. With keys of
  // their own the recorded archive is intact; keyed by the chunk id alone
  // they share keys, and the refused one takes the recorded one's objects.
  run twoArchiversAtOnceTest =
    initWith(true).then(flush).then(matchEnds).then(windowCloses)
      .then(archiveBegin(0))
      .then(if (RECORD_FIRST) stutter else archiveBegin(1))
      .then(archiveUpload(0, true))
      .then(if (RECORD_FIRST) stutter else archiveUpload(1, true))
      .then(archiveFinish(0, true))
      .then(if (RECORD_FIRST) stutter else archiveFinish(1, true))
      .expect(s.archivedThrough == 1)
      .expect(archivedOnlyWhenComplete == not(KEY_BY_THROUGH))

  // No R2: the store is a folder a deploy wipes. Nothing is archived or
  // evicted, and the log stays in D1. Archived and evicted all the same, the
  // next deploy takes the only copy.
  run localStoreTest =
    initWith(false).then(flush).then(windowCloses)
      .then(if (ANY_STORE and not(RECORD_FIRST)) archived else stutter)
      .then(if (ANY_STORE and not(RECORD_FIRST)) hotPasses.then(evict(true)).then(wipe) else wipe)
      .expect(logAlwaysReadable == not(ANY_STORE and not(RECORD_FIRST)))
}

// Rejected: archived_at recorded before the uploads are confirmed.
module log_archive_record_first {
  import log_archive(RECORD_FIRST = true, EVICT_ALL = false, ARCHIVE_ONLY = false, IGNORE_TOMBSTONE = false,
    READ_ALL_TAIL = false, DELETE_BY_ID_ONLY = false, KEY_BY_THROUGH = false, ANY_STORE = false).*
}

// Rejected: eviction deletes every chunk of the match.
module log_archive_evict_all {
  import log_archive(RECORD_FIRST = false, EVICT_ALL = true, ARCHIVE_ONLY = false, IGNORE_TOMBSTONE = false,
    READ_ALL_TAIL = false, DELETE_BY_ID_ONLY = false, KEY_BY_THROUGH = false, ANY_STORE = false).*
}

// Rejected: once evicted, readers read the archive alone.
module log_archive_archive_only {
  import log_archive(RECORD_FIRST = false, EVICT_ALL = false, ARCHIVE_ONLY = true, IGNORE_TOMBSTONE = false,
    READ_ALL_TAIL = false, DELETE_BY_ID_ONLY = false, KEY_BY_THROUGH = false, ANY_STORE = false).*
}

// Rejected: an archive that finds a delete started keeps what it uploaded.
module log_archive_ignore_tombstone {
  import log_archive(RECORD_FIRST = false, EVICT_ALL = false, ARCHIVE_ONLY = false, IGNORE_TOMBSTONE = true,
    READ_ALL_TAIL = false, DELETE_BY_ID_ONLY = false, KEY_BY_THROUGH = false, ANY_STORE = false).*
}

// Rejected: once evicted, readers read every chunk left in D1 after the archive.
module log_archive_read_all_tail {
  import log_archive(RECORD_FIRST = false, EVICT_ALL = false, ARCHIVE_ONLY = false, IGNORE_TOMBSTONE = false,
    READ_ALL_TAIL = true, DELETE_BY_ID_ONLY = false, KEY_BY_THROUGH = false, ANY_STORE = false).*
}

// Rejected: the eviction's DELETE picks the archived chunks by id alone.
module log_archive_delete_by_id_only {
  import log_archive(RECORD_FIRST = false, EVICT_ALL = false, ARCHIVE_ONLY = false, IGNORE_TOMBSTONE = false,
    READ_ALL_TAIL = false, DELETE_BY_ID_ONLY = true, KEY_BY_THROUGH = false, ANY_STORE = false).*
}

// Rejected: an attempt's keys carry only the chunk id it archived through.
module log_archive_key_by_through {
  import log_archive(RECORD_FIRST = false, EVICT_ALL = false, ARCHIVE_ONLY = false, IGNORE_TOMBSTONE = false,
    READ_ALL_TAIL = false, DELETE_BY_ID_ONLY = false, KEY_BY_THROUGH = true, ANY_STORE = false).*
}

// Rejected: archives and evicts into whatever store it has, durable or not.
module log_archive_any_store {
  import log_archive(RECORD_FIRST = false, EVICT_ALL = false, ARCHIVE_ONLY = false, IGNORE_TOMBSTONE = false,
    READ_ALL_TAIL = false, DELETE_BY_ID_ONLY = false, KEY_BY_THROUGH = false, ANY_STORE = true).*
}

// The change.
module log_archive_current {
  import log_archive(RECORD_FIRST = false, EVICT_ALL = false, ARCHIVE_ONLY = false, IGNORE_TOMBSTONE = false,
    READ_ALL_TAIL = false, DELETE_BY_ID_ONLY = false, KEY_BY_THROUGH = false, ANY_STORE = false).*
}
