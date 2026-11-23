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
// concurrent flushes (an append lock serializes them per player), the bound
// on runs per flush (_MAX_KIND_RUNS, 64: a page's flush has two runs per 5 s
// window it covers; past the bound, which only a modified client alternating
// its lines reaches, the rest of the flush is one JS run, still in order).
//
// SPLIT: "none" (today: one store), "per_flush" (rejected: a JS chunk and a
// C chunk per flush), "runs" (each run of one kind a chunk, in order; one
// store per kind).
module session_log_store {
  const SPLIT: str

  pure val MAX_N = 6      // entries the page logs in one run of the model
  pure val ENTRIES = 0.to(MAX_N - 1)
  pure val MAX_EPOCH = 1  // reloads
  pure val CAP_LOG = 3    // the JS lines' store (today the only one), in entries
  pure val CAP_C = 2      // the C lines' store, in entries
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

  action init = all {
    logged' = 0, isCOf' = ENTRIES.mapBy(n => false), seqOf' = ENTRIES.mapBy(n => NONE),
    epoch' = 0, nextSeq' = 0, firstOfEpoch' = 0, ackedSeq' = -1, acked' = Set(),
    serverEpoch' = NO_EPOCH, lastSeq' = -1, stored' = Set(), chunkOf' = ENTRIES.mapBy(n => NONE),
    nextId' = 0, storedEver' = Set(), storedTwice' = false,
    cEvictedUnderCap' = false, jsEvictedUnderCap' = false,
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
  }

  // Which store an entry counts against: the C lines' own with a split.
  def inCStore(n: int): bool = SPLIT != "none" and isCOf.get(n)

  def capOf(cStore: bool): int = if (cStore) CAP_C else CAP_LOG

  // Where a run of one kind starts in one flush's new entries. They are
  // consecutive: the epoch's entries past the last seq the server stored.
  def runStarts(fresh: Set[int]): Set[int] =
    fresh.filter(n => not(fresh.contains(n - 1)) or isCOf.get(n) != isCOf.get(n - 1))

  // The row a new entry of one flush goes in.
  def rowOf(fresh: Set[int], n: int): int =
    if (SPLIT == "none") nextId
    else if (SPLIT == "per_flush")
      if (isCOf.get(n) and fresh.exists(m => not(isCOf.get(m)))) nextId + 1 else nextId
    else nextId + runStarts(fresh).filter(s => s <= n).size() - 1

  // How many rows one flush adds.
  def rowsAdded(fresh: Set[int]): int =
    if (fresh == Set()) 0
    else if (SPLIT == "none") 1
    else if (SPLIT == "per_flush")
      (if (fresh.exists(m => not(isCOf.get(m)))) 1 else 0) + (if (fresh.exists(m => isCOf.get(m))) 1 else 0)
    else runStarts(fresh).size()

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
    val rows = ENTRIES.mapBy(n => if (fresh.contains(n)) rowOf(fresh, n) else chunkOf.get(n))
    val held = stored.union(fresh)
    // _chunk_cap_statement, for each store: keep its newest rows while their
    // sizes, counted from the newest back, fit its cap.
    val keep = held.filter(n =>
      held.filter(m => inCStore(m) == inCStore(n) and rows.get(m) >= rows.get(n)).size() <= capOf(inCStore(n)))
    val evicted = held.exclude(keep)
    all {
      stored' = keep,
      chunkOf' = rows,
      nextId' = nextId + rowsAdded(fresh),
      serverEpoch' = epoch,
      lastSeq' = ack,
      storedEver' = storedEver.union(fresh),
      storedTwice' = (storedTwice or fresh.exists(n => storedEver.contains(n))),
      cEvictedUnderCap' = (cEvictedUnderCap or (evicted.exists(n => isCOf.get(n)) and held.filter(n => isCOf.get(n)).size() <= CAP_C)),
      jsEvictedUnderCap' = (jsEvictedUnderCap or (evicted.exists(n => not(isCOf.get(n))) and held.filter(n => not(isCOf.get(n))).size() <= CAP_LOG)),
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
  // lines never push it out. Violated with one store.
  val cLinesKeepTheirOwnRoom = not(cEvictedUnderCap)

  // A JS line is evicted only when the JS lines stored are over their cap: C
  // lines never push it out. Violated with one store.
  val jsLinesKeepTheirOwnRoom = not(jsEvictedUnderCap)

  // Every entry the page saw acked reached the store (a cap may have evicted
  // it since), and none was stored twice.
  val everyAckedEntryWasStored = acked.subseteq(storedEver)
  val noEntryStoredTwice = not(storedTwice)

  val allHold =
    readInOrder and cLinesKeepTheirOwnRoom and jsLinesKeepTheirOwnRoom and everyAckedEntryWasStored and noEntryStoredTwice

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
}

// Today: every entry in one store under one cap.
module session_log_store_before {
  import session_log_store(SPLIT = "none").*
}

// Rejected: each flush stored as a row of its JS lines, then one of its C
// lines, each kind under its own cap.
module session_log_store_per_flush {
  import session_log_store(SPLIT = "per_flush").*
}

// The change: each run of one kind its own chunk, in order; the C lines'
// chunks under their own cap.
module session_log_store_current {
  import session_log_store(SPLIT = "runs").*
}
