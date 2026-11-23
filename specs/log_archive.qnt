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
// - archive: note the newest chunk id, upload what D1 holds up to it, then
//   record archived_at and archived_max_chunk_id in one statement, only if
//   every upload succeeded and no delete has started meanwhile. If the
//   record is refused, the archive deletes what it uploaded: retention's
//   prefix delete may have run before the upload landed. It can also be
//   refused for a reason the model leaves open (`quiet`; in the code, a
//   write to the match while the archive ran): the match stays un-archived
//   for the next sweep.
// - evict: one batch deletes the chunks up to archived_max_chunk_id and sets
//   evicted_at. A chunk can come after the archive, or after the eviction:
//   the socket path takes a room's live match past its upload window. It
//   stays in D1.
// - read: D1 until evicted_at; after it, the archive for the chunks up to
//   archived_max_chunk_id and D1 for any later. Each chunk is read from
//   exactly one place.
// - retention deletes the match's R2 prefix, then its D1 rows; the archive
//   objects go with the prefix.
//
// Not modelled: more than one slot (each slot's objects and chunks follow
// the same steps), the input audit and context (archived and read the same
// way as the log), the size caps and eviction records (the archived log
// starts with its SERVER-LOG-EVICTED lines, as a D1 read does), retention's
// interrupted deletes (retention_sweep's own tests), two archives of one
// match at once (each writes under its own snapshot's chunk id, so neither
// overwrites a recorded archive with other content), the eviction batch's
// statements running apart (D1's HTTP batch is not documented as a
// transaction: the delete and the context clear act only once evicted_at is
// set, and a reader past evicted_at skips D1's chunks up to the archived id,
// so every prefix of the batch reads the same), and SQLite reusing the id of
// a deleted newest chunk (a chunk written after the eviction is read by its
// created_at too).
//
// RECORD_FIRST: archived_at is recorded before the uploads are confirmed.
// EVICT_ALL: eviction deletes every chunk, not just those the archive holds.
// ARCHIVE_ONLY: once evicted, readers read the archive alone.
// IGNORE_TOMBSTONE: an archive that finds a delete started keeps its objects.
module log_archive {
  const RECORD_FIRST: bool
  const EVICT_ALL: bool
  const ARCHIVE_ONLY: bool
  const IGNORE_TOMBSTONE: bool

  pure val MAX_CHUNKS = 4
  pure val IDS = 0.to(MAX_CHUNKS - 1)
  pure val NONE = -1

  pure def largest(s: Set[int]): int = s.fold(NONE, (m, x) => if (x > m) x else m)

  // D1
  var d1: Set[int]          // chunk ids in D1
  var nextChunk: int
  var written: Set[int]     // every chunk ever stored
  var live: bool            // the room's live match: socket flushes still land
  var windowOpen: bool      // the ingest window: HTTP uploads accepted
  var hotOver: bool         // D1_HOT_DAYS since the match ended
  // The archive
  var archiving: bool       // an archive step is in progress
  var snapshot: Set[int]    // the chunks it set out to upload
  var uploaded: bool        // every one of its uploads succeeded
  var r2: Set[int]          // chunk ids in the archive objects in R2
  var archivedMax: int      // archived_max_chunk_id; NONE until archived_at is set
  var evicted: bool         // evicted_at
  // Retention
  var deleting: bool        // the tombstone, deleting_at
  var gone: bool            // the delete finished: match_retention is deleted

  action init = all {
    d1' = Set(), nextChunk' = 0, written' = Set(), live' = true, windowOpen' = true, hotOver' = false,
    archiving' = false, snapshot' = Set(), uploaded' = false, r2' = Set(), archivedMax' = NONE,
    evicted' = false, deleting' = false, gone' = false,
  }

  // A flush lands a chunk: the socket path while the room's live match is
  // this one, the HTTP path while the window is open.
  action flush = all {
    live or windowOpen, not(deleting), not(gone), nextChunk < MAX_CHUNKS,
    d1' = d1.union(Set(nextChunk)), written' = written.union(Set(nextChunk)), nextChunk' = nextChunk + 1,
    live' = live, windowOpen' = windowOpen, hotOver' = hotOver,
    archiving' = archiving, snapshot' = snapshot, uploaded' = uploaded, r2' = r2,
    archivedMax' = archivedMax, evicted' = evicted, deleting' = deleting, gone' = gone,
  }

  // The room moves on (game-ended, a new match).
  action matchEnds = all {
    live, live' = false,
    d1' = d1, nextChunk' = nextChunk, written' = written, windowOpen' = windowOpen, hotOver' = hotOver,
    archiving' = archiving, snapshot' = snapshot, uploaded' = uploaded, r2' = r2,
    archivedMax' = archivedMax, evicted' = evicted, deleting' = deleting, gone' = gone,
  }

  // The ingest window closes: 30 min after the end, or 4 h after the start
  // when no end was recorded (the room may still be on the match).
  action windowCloses = all {
    windowOpen, windowOpen' = false,
    d1' = d1, nextChunk' = nextChunk, written' = written, live' = live, hotOver' = hotOver,
    archiving' = archiving, snapshot' = snapshot, uploaded' = uploaded, r2' = r2,
    archivedMax' = archivedMax, evicted' = evicted, deleting' = deleting, gone' = gone,
  }

  // D1_HOT_DAYS pass after the archive. The room may still be on the match.
  action hotPasses = all {
    archivedMax != NONE, not(hotOver), hotOver' = true,
    d1' = d1, nextChunk' = nextChunk, written' = written, live' = live, windowOpen' = windowOpen,
    archiving' = archiving, snapshot' = snapshot, uploaded' = uploaded, r2' = r2,
    archivedMax' = archivedMax, evicted' = evicted, deleting' = deleting, gone' = gone,
  }

  // The archive sweep picks the match: its window has closed, it is not
  // archived, and no delete has started. It notes the newest chunk id.
  action archiveBegin = all {
    not(windowOpen), archivedMax == NONE, not(archiving), not(deleting), not(gone),
    archiving' = true, snapshot' = d1, uploaded' = false,
    archivedMax' = if (RECORD_FIRST) largest(d1) else archivedMax,
    d1' = d1, nextChunk' = nextChunk, written' = written, live' = live, windowOpen' = windowOpen,
    hotOver' = hotOver, r2' = r2, evicted' = evicted, deleting' = deleting, gone' = gone,
  }

  // The uploads land, or one fails. They are in flight: a delete may have
  // started, or finished, meanwhile.
  action archiveUpload(ok: bool): bool = all {
    archiving, not(uploaded),
    uploaded' = ok,
    r2' = if (ok) snapshot else r2,
    archiving' = archiving, snapshot' = snapshot, archivedMax' = archivedMax,
    d1' = d1, nextChunk' = nextChunk, written' = written, live' = live, windowOpen' = windowOpen,
    hotOver' = hotOver, evicted' = evicted, deleting' = deleting, gone' = gone,
  }

  // One statement records archived_at, only if every upload succeeded,
  // nothing refuses it (`quiet`) and no delete has started. Refused, the
  // archive deletes what it uploaded.
  action archiveFinish(quiet: bool): bool = all {
    archiving,
    val recordable = uploaded and quiet and not(deleting) and not(gone)
    all {
      archivedMax' = if (recordable and not(RECORD_FIRST)) largest(snapshot) else archivedMax,
      r2' = if (recordable or ((deleting or gone) and IGNORE_TOMBSTONE)) r2 else Set(),
      archiving' = false, snapshot' = Set(), uploaded' = false,
      d1' = d1, nextChunk' = nextChunk, written' = written, live' = live, windowOpen' = windowOpen,
      hotOver' = hotOver, evicted' = evicted, deleting' = deleting, gone' = gone,
    },
  }

  // D1_HOT_DAYS after the end, one batch deletes the archived chunks and
  // sets evicted_at.
  action evict = all {
    archivedMax != NONE, hotOver, not(evicted), not(deleting), not(gone),
    d1' = if (EVICT_ALL) Set() else d1.filter(id => id > archivedMax),
    evicted' = true,
    nextChunk' = nextChunk, written' = written, live' = live, windowOpen' = windowOpen, hotOver' = hotOver,
    archiving' = archiving, snapshot' = snapshot, uploaded' = uploaded, r2' = r2,
    archivedMax' = archivedMax, deleting' = deleting, gone' = gone,
  }

  // Retention: the match expires and is tombstoned; then the R2 prefix and
  // the D1 rows go, match_retention last.
  action tombstone = all {
    not(live), not(windowOpen), not(deleting), not(gone),
    deleting' = true,
    d1' = d1, nextChunk' = nextChunk, written' = written, live' = live, windowOpen' = windowOpen,
    hotOver' = hotOver, archiving' = archiving, snapshot' = snapshot, uploaded' = uploaded, r2' = r2,
    archivedMax' = archivedMax, evicted' = evicted, gone' = gone,
  }

  action finishDelete = all {
    deleting, not(gone),
    r2' = Set(), d1' = Set(), gone' = true,
    nextChunk' = nextChunk, written' = written, live' = live, windowOpen' = windowOpen, hotOver' = hotOver,
    archiving' = archiving, snapshot' = snapshot, uploaded' = uploaded,
    archivedMax' = archivedMax, evicted' = evicted, deleting' = deleting,
  }

  action step = any {
    flush, matchEnds, windowCloses, hotPasses,
    archiveBegin,
    nondet ok = Set(true, false).oneOf()
    archiveUpload(ok),
    nondet quiet = Set(true, false).oneOf()
    archiveFinish(quiet),
    evict, tombstone, finishDelete,
  }

  // ── Properties ────────────────────────────────────────────────────────

  // What a reader gets: D1 until evicted_at; after it, the archive up to
  // archived_max_chunk_id and D1 past it.
  def readable: Set[int] =
    if (not(evicted)) d1
    else if (ARCHIVE_ONLY) r2.filter(id => id <= archivedMax)
    else r2.filter(id => id <= archivedMax).union(d1.filter(id => id > archivedMax))

  // Until retention deletes the match, a reader gets every chunk ever
  // stored, each from exactly one place (after eviction no chunk the
  // archive covers is left in D1). Violated by an eviction of every chunk,
  // a reader of the archive alone, and a record before the uploads.
  val logAlwaysReadable =
    (not(deleting) and not(gone)) implies (readable == written and (evicted implies d1.forall(id => id > archivedMax)))

  // archived_at is set only once the archive holds every chunk up to
  // archived_max_chunk_id, so eviction deletes only what R2 has. Violated
  // when it is recorded before the uploads are confirmed.
  val archivedOnlyWhenComplete =
    (archivedMax != NONE and not(deleting) and not(gone))
      implies written.filter(id => id <= archivedMax).forall(id => r2.contains(id))

  // Once a delete has finished and no archive is in flight, nothing of the
  // match is left, in D1 or R2. Violated by an archive that keeps what it
  // uploaded after finding the match tombstoned.
  val retentionLeavesNothing = (gone and not(archiving)) implies (r2 == Set() and d1 == Set())

  // No archive object outlives an archive that wasn't recorded.
  val noStrayObjects = (not(archiving) and archivedMax == NONE) implies r2 == Set()

  val allHold = logAlwaysReadable and archivedOnlyWhenComplete and retentionLeavesNothing and noStrayObjects

  // ── Scenarios ─────────────────────────────────────────────────────────

  // Two chunks, the match ends, its window closes: archived, then evicted.
  // A reader gets both from the archive.
  run archiveThenEvictTest =
    init.then(flush).then(flush).then(matchEnds).then(windowCloses)
      .then(archiveBegin).then(archiveUpload(true)).then(archiveFinish(true))
      .expect(archivedMax == 1 and r2 == Set(0, 1) and readable == Set(0, 1))
      .then(hotPasses).then(evict)
      .expect(evicted and readable == Set(0, 1))
      .expect(d1 == Set() and r2 == Set(0, 1))

  // The window closes while the room is still on the match: archived, then
  // a chunk lands. Eviction leaves it in D1, and a reader gets it there.
  run lateChunkTest =
    init.then(flush).then(windowCloses)
      .then(archiveBegin).then(archiveUpload(true)).then(archiveFinish(true))
      .then(flush).then(hotPasses).then(evict)
      .expect(written == Set(0, 1))
      .expect(d1 == (if (EVICT_ALL) Set() else Set(1)))
      .expect(logAlwaysReadable == not(EVICT_ALL or ARCHIVE_ONLY))

  // A chunk lands after the eviction: a reader gets the archive, then it.
  run chunkAfterEvictionTest =
    init.then(flush).then(windowCloses)
      .then(archiveBegin).then(archiveUpload(true)).then(archiveFinish(true))
      .then(hotPasses).then(evict).then(flush)
      .expect(d1 == Set(1) and r2 == Set(0))
      .expect(logAlwaysReadable == not(ARCHIVE_ONLY))

  // A write lands while the archive runs: nothing is recorded, and the next
  // archive takes the match as it is then.
  run refusedRecordTest =
    init.then(flush).then(matchEnds).then(windowCloses)
      .then(archiveBegin).then(archiveUpload(true)).then(archiveFinish(false))
      .expect(archivedMax == (if (RECORD_FIRST) 0 else NONE))
      .expect(d1 == Set(0) and r2 == Set())

  // An upload fails: the match stays un-archived and in D1. Recorded first,
  // the eviction deletes a chunk R2 never got.
  run failedUploadTest =
    init.then(flush).then(matchEnds).then(windowCloses)
      .then(archiveBegin).then(archiveUpload(false)).then(archiveFinish(true))
      .expect(archivedMax == (if (RECORD_FIRST) 0 else NONE))
      .expect(archivedOnlyWhenComplete == not(RECORD_FIRST))
      .expect(d1 == Set(0))

  // A delete starts and finishes while the uploads are in flight; they land
  // after the R2 prefix delete. The archive finds the match gone and deletes
  // what it uploaded.
  run deleteDuringArchiveTest =
    init.then(flush).then(matchEnds).then(windowCloses)
      .then(archiveBegin).then(tombstone).then(finishDelete)
      .then(archiveUpload(true)).then(archiveFinish(true))
      .expect(archivedMax == (if (RECORD_FIRST) 0 else NONE))
      .expect(r2 == (if (IGNORE_TOMBSTONE) Set(0) else Set()))
      .expect(retentionLeavesNothing == not(IGNORE_TOMBSTONE))
}

// Rejected: archived_at recorded before the uploads are confirmed.
module log_archive_record_first {
  import log_archive(RECORD_FIRST = true, EVICT_ALL = false, ARCHIVE_ONLY = false, IGNORE_TOMBSTONE = false).*
}

// Rejected: eviction deletes every chunk of the match.
module log_archive_evict_all {
  import log_archive(RECORD_FIRST = false, EVICT_ALL = true, ARCHIVE_ONLY = false, IGNORE_TOMBSTONE = false).*
}

// Rejected: once evicted, readers read the archive alone.
module log_archive_archive_only {
  import log_archive(RECORD_FIRST = false, EVICT_ALL = false, ARCHIVE_ONLY = true, IGNORE_TOMBSTONE = false).*
}

// Rejected: an archive that finds a delete started keeps what it uploaded.
module log_archive_ignore_tombstone {
  import log_archive(RECORD_FIRST = false, EVICT_ALL = false, ARCHIVE_ONLY = false, IGNORE_TOMBSTONE = true).*
}

// The change.
module log_archive_current {
  import log_archive(RECORD_FIRST = false, EVICT_ALL = false, ARCHIVE_ONLY = false, IGNORE_TOMBSTONE = false).*
}
