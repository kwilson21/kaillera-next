// The server's store for one player's session log in a match
// (server/src/db.py: append_session_flush, _chunk_statements,
// _chunk_cap_statement, iter_chunk_entries; read by the admin detail and
// export endpoints in api/app.py and by match_rotation.py).
//
// The page numbers its log entries in one stream (`seq`, from 0 in each
// ring, which a reload or reconnect starts over under a new `epoch`) and
// sends every entry the server has not acked. The C rollback engine's lines
// ride in the same stream: the page drains them into its log as "[C] "
// lines (netplay-rollback.js, _drainCDebugLog). The server drops what it
// already has (a seq at or below the last one it stored in the same epoch),
// stores the rest as chunks in id order, and acks the highest seq. A chunk
// is one database row; its entries keep the order they were sent in.
//
// Each store has a cap. Past it, the oldest chunks of that store are
// deleted: the newest are kept while their sizes, counted from the newest
// back, fit. A reader takes the log's chunks in id order.
//
// Today every entry goes into one store under one cap, so a burst of C lines
// pushes the oldest JS lines out, and a long match's JS lines push out the C
// lines. The change gives the C lines a store of their own, as the input
// audit has (kind 'audit'), so each kind is evicted only by its own volume.
// The page and the wire do not change.
//
// Rejected: each flush stored as one chunk of its JS lines, then one of its C
// lines. A flush's C lines are not always its last entries: a re-init drains
// the C log in the middle of a flush window (doRollbackInit), and JS lines
// follow. Read in id order, such a flush comes back out of order. Each run of
// one kind becomes a chunk instead, in order.
//
// Not modelled: entry sizes (each entry counts 1 against a cap), the split of
// a large run into several chunks of at most _SESSION_LOG_CHUNK_MAX (each is
// a run of one kind in order, so a reader sees the same order), the page's
// own ring cap, the input audit (its own seq, epoch and store, as before),
// concurrent flushes (an append lock serializes them per player), the
// refusal of a flush whose rows, size splits included, pass
// _MAX_FLUSH_ROWS (only a payload larger than either transport takes can:
// such a flush is stored nowhere and acked never, as a lost one).
//
// What a cap deleted is recorded apart from the chunks, per store (table
// session_log_evictions): how many entries and the seq of the last one. The
// log's readers show it as the log's first line, so a log whose oldest lines
// are gone does not read as one that started late. The record is updated in
// the cap DELETE's own batch, from the rows it removes.
//
// SPLIT: "none" (today: one store), "per_flush" (rejected: a JS chunk and a
// C chunk per flush), "runs" (each run of one kind a chunk, in order; one
// store per kind).
// RECORD: each store keeps a record of what its cap deleted.
// BOUND: one flush adds at most MAX_ROWS rows, whatever its lines' kinds:
// past MAX_ROWS - 1 runs, the rest of the flush is one JS row, still in
// order (_MAX_KIND_RUNS). Its C lines then count against the JS lines' cap.
// Each row is a statement in the flush's one batch, and a modified client
// alternating its lines could make one per line.
module session_log_store {
  const SPLIT: str
  const RECORD: bool
  const BOUND: bool

  pure val MAX_N = 6      // entries the page logs in one run of the model
  pure val ENTRIES = 0.to(MAX_N - 1)
  pure val MAX_EPOCH = 1  // reloads
  pure val CAP_LOG = 3    // the JS lines' store (today the only one), in entries
  pure val CAP_C = 2      // the C lines' store, in entries
  pure val MAX_ROWS = 3   // rows one flush may add (_MAX_KIND_RUNS)
  pure val NO_EPOCH = -1
  pure val NONE = -1

  // The page. Entry n (the n-th logged, over every epoch) is a C line or a
  // JS line, with its seq in its epoch.
  var logged: int            // entries logged so far: the next n
  var isCOf: int -> bool
  var seqOf: int -> int      // NONE before it is logged
  var epoch: int             // the ring's epoch
  var nextSeq: int
  var firstOfEpoch: int      // the first n of this epoch
  var ackedSeq: int          // the highest seq the server acked in this epoch
  var acked: Set[int]        // entries the page saw acked
  // The server. A chunk is a row: a reader takes the rows in id order, and
  // a row's entries in the order they were sent.
  var serverEpoch: int       // the epoch of the last flush stored
  var lastSeq: int           // the highest seq stored in that epoch
  var stored: Set[int]       // the entries the store holds now
  var chunkOf: int -> int    // the row an entry was stored in; NONE if never
  var nextId: int            // the next row id
  var storedEver: Set[int]
  var storedTwice: bool
  var cEvictedUnderCap: bool  // a C line evicted while the C lines fit their cap
  var jsEvictedUnderCap: bool // a JS line evicted while the JS lines fit theirs
  var recordLog: Set[int]     // the JS lines' store's record: the entries its cap deleted
  var recordC: Set[int]       // the C lines' store's record
  var cRow: Set[int]          // entries stored in a C row: the C lines' store
  var coalesced: Set[int]     // C or JS lines stored in the rest of a flush past the bound
  var tooManyRows: bool       // a flush added more than MAX_ROWS rows

  action init = all {
    logged' = 0, isCOf' = ENTRIES.mapBy(n => false), seqOf' = ENTRIES.mapBy(n => NONE),
    epoch' = 0, nextSeq' = 0, firstOfEpoch' = 0, ackedSeq' = -1, acked' = Set(),
    serverEpoch' = NO_EPOCH, lastSeq' = -1, stored' = Set(), chunkOf' = ENTRIES.mapBy(n => NONE),
    nextId' = 0, storedEver' = Set(), storedTwice' = false,
    cEvictedUnderCap' = false, jsEvictedUnderCap' = false,
    recordLog' = Set(), recordC' = Set(), cRow' = Set(), coalesced' = Set(), tooManyRows' = false,
  }

  // _syncLog: a JS line, or a "[C] " line the C log drain writes.
  action log(isC: bool): bool = all {
    logged < MAX_N,
    isCOf' = isCOf.set(logged, isC),
    seqOf' = seqOf.set(logged, nextSeq),
    logged' = logged + 1,
    nextSeq' = nextSeq + 1,
    epoch' = epoch, firstOfEpoch' = firstOfEpoch, ackedSeq' = ackedSeq, acked' = acked,
    serverEpoch' = serverEpoch, lastSeq' = lastSeq, stored' = stored, chunkOf' = chunkOf,
    nextId' = nextId, storedEver' = storedEver, storedTwice' = storedTwice,
    cEvictedUnderCap' = cEvictedUnderCap, jsEvictedUnderCap' = jsEvictedUnderCap,
    recordLog' = recordLog, recordC' = recordC, cRow' = cRow, coalesced' = coalesced, tooManyRows' = tooManyRows,
  }

  // A reload or a reconnect: a new ring, a new epoch, seqs from 0 again.
  // What the old ring had not sent is gone with it.
  action reload = all {
    epoch < MAX_EPOCH,
    epoch' = epoch + 1, nextSeq' = 0, ackedSeq' = -1, firstOfEpoch' = logged,
    logged' = logged, isCOf' = isCOf, seqOf' = seqOf, acked' = acked,
    serverEpoch' = serverEpoch, lastSeq' = lastSeq, stored' = stored, chunkOf' = chunkOf,
    nextId' = nextId, storedEver' = storedEver, storedTwice' = storedTwice,
    cEvictedUnderCap' = cEvictedUnderCap, jsEvictedUnderCap' = jsEvictedUnderCap,
    recordLog' = recordLog, recordC' = recordC, cRow' = cRow, coalesced' = coalesced, tooManyRows' = tooManyRows,
  }

  def capOf(cStore: bool): int = if (cStore) CAP_C else CAP_LOG

  // Where a run of one kind starts in one flush's new entries. They are
  // consecutive: the epoch's entries past the last seq the server stored.
  def runStarts(fresh: Set[int]): Set[int] =
    fresh.filter(n => not(fresh.contains(n - 1)) or isCOf.get(n) != isCOf.get(n - 1))

  // With the bound, the rest of a flush past MAX_ROWS - 1 runs: one JS row.
  def restOf(fresh: Set[int]): Set[int] =
    val starts = runStarts(fresh)
    if (SPLIT == "runs" and BOUND and starts.size() > MAX_ROWS)
      val cut = starts.filter(s => starts.filter(t => t < s).size() == MAX_ROWS - 1).fold(NONE, (m, s) => if (s > m) s else m)
      fresh.filter(n => n >= cut)
    else Set()

  // The row a new entry of one flush goes in.
  def rowOf(fresh: Set[int], rest: Set[int], n: int): int =
    if (SPLIT == "none") nextId
    else if (SPLIT == "per_flush")
      if (isCOf.get(n) and fresh.exists(m => not(isCOf.get(m)))) nextId + 1 else nextId
    else if (rest.contains(n)) nextId + MAX_ROWS - 1
    else nextId + runStarts(fresh).filter(s => s <= n).size() - 1

  // How many rows one flush adds.
  def rowsAdded(fresh: Set[int], rest: Set[int]): int =
    if (fresh == Set()) 0
    else if (SPLIT == "none") 1
    else if (SPLIT == "per_flush")
      (if (fresh.exists(m => not(isCOf.get(m)))) 1 else 0) + (if (fresh.exists(m => isCOf.get(m))) 1 else 0)
    else if (rest != Set()) MAX_ROWS
    else runStarts(fresh).size()

  // The lines the C lines' cap is for: a line in the rest of a flush past
  // the bound is stored as a JS line, whatever its kind.
  def cLineIn(merged: Set[int], n: int): bool = isCOf.get(n) and not(merged.contains(n))

  // Whether a new entry goes in a C row: the C lines' own store.
  def inCRow(rest: Set[int], n: int): bool = SPLIT != "none" and isCOf.get(n) and not(rest.contains(n))

  // The page sends what the server has not acked; the server stores what it
  // does not have yet, evicts past each cap, and acks its highest seq. The
  // ack can be lost on the way back; the page then sends the same entries
  // again.
  action flush(ackLost: bool): bool = all {
    ENTRIES.exists(n => n < logged and n >= firstOfEpoch and seqOf.get(n) > ackedSeq),
    val sent = ENTRIES.filter(n => n < logged and n >= firstOfEpoch and seqOf.get(n) > ackedSeq)
    val from = if (epoch == serverEpoch) lastSeq else -1
    val fresh = sent.filter(n => seqOf.get(n) > from)
    val ack = fresh.fold(from, (m, n) => if (seqOf.get(n) > m) seqOf.get(n) else m)
    val rest = restOf(fresh)
    val rows = ENTRIES.mapBy(n => if (fresh.contains(n)) rowOf(fresh, rest, n) else chunkOf.get(n))
    val cRows = cRow.union(fresh.filter(n => inCRow(rest, n)))
    val merged = coalesced.union(rest)
    val held = stored.union(fresh)
    // _chunk_cap_statement, for each store: keep its newest rows while their
    // sizes, counted from the newest back, fit its cap.
    val keep = held.filter(n =>
      held.filter(m => cRows.contains(m) == cRows.contains(n) and rows.get(m) >= rows.get(n)).size()
        <= capOf(cRows.contains(n)))
    val evicted = held.exclude(keep)
    all {
      stored' = keep,
      chunkOf' = rows,
      nextId' = nextId + rowsAdded(fresh, rest),
      cRow' = cRows,
      coalesced' = merged,
      tooManyRows' = (tooManyRows or rowsAdded(fresh, rest) > MAX_ROWS),
      serverEpoch' = epoch,
      lastSeq' = ack,
      storedEver' = storedEver.union(fresh),
      storedTwice' = (storedTwice or fresh.exists(n => storedEver.contains(n))),
      cEvictedUnderCap' = (cEvictedUnderCap or (evicted.exists(n => cLineIn(merged, n)) and held.filter(n => cLineIn(merged, n)).size() <= CAP_C)),
      jsEvictedUnderCap' = (jsEvictedUnderCap or (evicted.exists(n => not(isCOf.get(n))) and held.filter(n => not(cLineIn(merged, n))).size() <= CAP_LOG)),
      // Each store's record takes the entries in the rows its DELETE removes.
      recordLog' = if (RECORD) recordLog.union(evicted.filter(n => not(cRows.contains(n)))) else recordLog,
      recordC' = if (RECORD) recordC.union(evicted.filter(n => cRows.contains(n))) else recordC,
      ackedSeq' = if (ackLost) ackedSeq else ack,
      acked' = if (ackLost) acked else acked.union(sent.filter(n => seqOf.get(n) <= ack)),
      logged' = logged, isCOf' = isCOf, seqOf' = seqOf, epoch' = epoch,
      nextSeq' = nextSeq, firstOfEpoch' = firstOfEpoch,
    }
  }

  action step = any {
    nondet isC = Set(true, false).oneOf()
    log(isC),
    nondet ackLost = Set(true, false).oneOf()
    flush(ackLost),
    reload,
  }

  // ── Properties ────────────────────────────────────────────────────────

  // A reader taking the rows in id order gets the entries in the order the
  // page logged them. Violated with a JS row and a C row per flush.
  val readInOrder = stored.forall(m => stored.forall(n => chunkOf.get(m) < chunkOf.get(n) implies m < n))

  // A C line is evicted only when the C lines stored are over their cap: JS
  // lines never push it out. Violated with one store. (A line in the rest of
  // a flush past the bound is stored, and counted, as a JS line.)
  val cLinesKeepTheirOwnRoom = not(cEvictedUnderCap)

  // A JS line is evicted only when the JS lines stored are over their cap: C
  // lines never push it out. Violated with one store.
  val jsLinesKeepTheirOwnRoom = not(jsEvictedUnderCap)

  // No flush adds more than MAX_ROWS rows, however its lines alternate.
  // Violated with no bound: one row per run.
  val rowsPerFlushBounded = not(tooManyRows)

  // Every entry the page saw acked reached the store (a cap may have evicted
  // it since), and none was stored twice.
  val everyAckedEntryWasStored = acked.subseteq(storedEver)
  val noEntryStoredTwice = not(storedTwice)

  // A reader can always tell a store's log is incomplete, and where: its
  // record counts exactly the entries its cap deleted, and every one of them
  // is older (in an earlier row) than any line the store still holds, so
  // "everything up to seq X is gone" is true. Violated with no record.
  val truncationIsVisible = all {
    recordLog == storedEver.exclude(stored).filter(n => not(cRow.contains(n))),
    recordC == storedEver.exclude(stored).filter(n => cRow.contains(n)),
    stored.forall(n => (if (cRow.contains(n)) recordC else recordLog).forall(m => chunkOf.get(m) < chunkOf.get(n))),
  }

  val allHold = all {
    readInOrder, cLinesKeepTheirOwnRoom, jsLinesKeepTheirOwnRoom, everyAckedEntryWasStored, noEntryStoredTwice,
    truncationIsVisible, rowsPerFlushBounded,
  }

  // ── Scenarios ─────────────────────────────────────────────────────────

  // A C line, then three JS lines in a later flush. In one store the JS
  // lines push the C line out though it is the only one.
  run jsLinesPushACLineOutTest =
    init.then(log(true)).then(flush(false))
      .then(log(false)).then(log(false)).then(log(false)).then(flush(false))
      .expect(cEvictedUnderCap == (SPLIT == "none"))
      .expect(stored == (if (SPLIT == "none") Set(1, 2, 3) else Set(0, 1, 2, 3)))
      .expect(readInOrder and everyAckedEntryWasStored and noEntryStoredTwice)

  // A JS line, then a burst of C lines and one more JS line. In one store the
  // C lines push the first JS line out though the JS lines fit their cap.
  // With a JS row and a C row per flush, the C lines come back after the JS
  // line logged after them.
  run cLinesPushAJsLineOutTest =
    init.then(log(false)).then(flush(false))
      .then(log(true)).then(log(true)).then(log(false)).then(flush(false))
      .expect(jsEvictedUnderCap == (SPLIT == "none"))
      .expect(readInOrder == (SPLIT != "per_flush"))

  // C lines in the middle of a flush (a re-init drained the C log, and JS
  // lines followed). Each run of one kind is its own row, in order.
  run cLinesInTheMiddleOfAFlushTest =
    init.then(log(false)).then(log(true)).then(log(false)).then(flush(false))
      .expect(readInOrder == (SPLIT != "per_flush"))
      .expect(SPLIT != "runs" or (chunkOf.get(0) == 0 and chunkOf.get(1) == 1 and chunkOf.get(2) == 2 and nextId == 3))

  // The ack is lost and the page sends the same entries again with a new
  // one: only the new one is stored.
  run lostAckTest =
    init.then(log(false)).then(log(true)).then(flush(true))
      .then(log(false)).then(flush(false))
      .expect(storedEver == Set(0, 1, 2) and acked == Set(0, 1, 2))
      .expect(noEntryStoredTwice and readInOrder)

  // A reload starts a new ring at seq 0 under a new epoch: the server stores
  // its entries after the old ones, though their seqs are lower.
  run reloadTest =
    init.then(log(true)).then(flush(false)).then(reload)
      .then(log(false)).then(log(true)).then(flush(false))
      .expect(storedEver == Set(0, 1, 2) and everyAckedEntryWasStored)
      .expect(readInOrder and noEntryStoredTwice)

  // Four JS lines over two flushes, past the JS store's cap: its oldest row
  // is deleted. With the record, the reader can tell it is gone; the C
  // lines' record stays empty.
  run evictionIsRecordedTest =
    init.then(log(false)).then(flush(false))
      .then(log(false)).then(log(false)).then(log(false)).then(flush(false))
      .expect(stored == Set(1, 2, 3))
      .expect(recordLog == (if (RECORD) Set(0) else Set()) and recordC == Set())
      .expect(truncationIsVisible == RECORD)

  // Four lines alternating in one flush, as only a modified client sends.
  // With the bound, the rest past the second run is one JS row, in order.
  run alternatingLinesTest =
    init.then(log(false)).then(log(true)).then(log(false)).then(log(true)).then(flush(false))
      .expect(rowsPerFlushBounded == (SPLIT != "runs" or BOUND))
      .expect(readInOrder == (SPLIT != "per_flush"))
      .expect(SPLIT != "runs" or not(BOUND) or (nextId == 3 and cRow == Set(1) and coalesced == Set(2, 3)))
      .expect(everyAckedEntryWasStored and noEntryStoredTwice)
}

// Today: every entry in one store under one cap.
module session_log_store_before {
  import session_log_store(SPLIT = "none", RECORD = false, BOUND = false).*
}

// Rejected: each flush stored as a row of its JS lines, then one of its C
// lines, each kind under its own cap.
module session_log_store_per_flush {
  import session_log_store(SPLIT = "per_flush", RECORD = true, BOUND = true).*
}

// Each run of one kind its own chunk, in order, the C lines' chunks under
// their own cap, but no record of what a cap deleted: a log whose oldest
// lines are gone reads as one that started late.
module session_log_store_unrecorded {
  import session_log_store(SPLIT = "runs", RECORD = false, BOUND = true).*
}

// Each run of one kind its own row, with no bound on how many: a flush of
// alternating lines adds one row, and one statement, per line.
module session_log_store_unbounded {
  import session_log_store(SPLIT = "runs", RECORD = true, BOUND = false).*
}

// The change: each run of one kind its own chunk, in order, at most MAX_ROWS
// a flush; the C lines' chunks under their own cap; each store's record of
// what its cap deleted.
module session_log_store_current {
  import session_log_store(SPLIT = "runs", RECORD = true, BOUND = true).*
}

// A keepalive already submitted can reach the collector after the document
// goes away. Only a live document can start another request after an ack.
module session_log_page_exit {
  const NEWEST: bool
  pure val PENDING = 0.to(5)
  pure val CAPACITY = 2
  var alive: bool
  var submitted: Set[int]
  var delivered: Set[int]

  action init = all { alive' = true, submitted' = Set(), delivered' = Set() }
  action pagehide = all {
    alive, submitted == Set(),
    alive' = alive,
    submitted' = PENDING.filter(n => if (NEWEST) n >= PENDING.size() - CAPACITY else n < CAPACITY),
    delivered' = delivered,
  }
  action destroy = all { alive, alive' = false, submitted' = submitted, delivered' = delivered }
  action collect = all { alive' = alive, submitted' = submitted, delivered' = submitted }
  action step = any { pagehide, destroy, collect }

  val newestWasSubmitted = submitted != Set() implies
    (submitted.contains(5) and submitted.size() <= CAPACITY)

  run delayedCollectorTest =
    init.then(pagehide).then(destroy).then(collect)
      .expect(delivered.contains(5) == NEWEST and delivered.size() == CAPACITY)
}

module session_log_page_exit_before {
  import session_log_page_exit(NEWEST = false).*
}

module session_log_page_exit_current {
  import session_log_page_exit(NEWEST = true).*
}
