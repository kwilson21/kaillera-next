// -*- mode: Bluespec; -*-
//
// The tick loop's deadlines and a page that freezes (tick() and
// _creditLocalFreeze in web/static/netplay-rollback.js).
//
// Every wait in the tick loop has a wall-clock deadline (netplay invariant
// I1). Three of them end by dropping a peer: the page marks it a phantom and
// plays on without it, and the two resync when it is heard from again.
//   peer-stale       no input from the peer for 5 s        (PEER-PHANTOM)
//   input-stall      waiting on one input of the peer 5 s  (RB-INPUT-STALL-TIMEOUT)
//   pacing-throttle  held back for the peer for 5 s        (PACING-THROTTLE-TIMEOUT)
//
// A deadline is measured from a time stamp. When the page itself stops for a
// while (a long garbage collection, a blocked main thread: 4 to 6 s at a
// time in the cloud test container) the stamp keeps ageing although the peer
// did nothing wrong and the page was not there to see what it did. The first
// tick after the freeze would then drop a peer that is alive. So the tick
// loop measures the gap since the last tick and, when it is a second or
// more, moves the stamps forward by it ("crediting" the freeze).
//
// It used to credit two of the three. The pacing-throttle stamp was not
// moved, and its deadline is checked in the tick before anything can end the
// throttle: a page that froze for 5 s while it was being held back dropped
// its peer on the first tick after. All three are credited now.
//
// What is modelled: one page, the three deadlines as clocks, seconds passing
// while the page runs, a freeze of several seconds, the credit, a wait
// ending, the deadline firing.
//
// Not modelled: the deadlines that do not drop a peer and are not credited
// either (the resync target, the wait before the rollback engine is shut
// down for a menu, the wait for the host's rollback settings, the phase
// lock), what makes each wait begin and end, a hidden tab (by design not
// credited: its handlers keep running), more than one peer.
//
// CREDIT_ALL: a freeze is credited to every deadline that drops a peer.
//   false = before: peer-stale and input-stall only.
module tick_deadlines {
  const CREDIT_ALL: bool

  pure val LIMIT = 5
  pure val GATES = Set("peer-stale", "input-stall", "pacing-throttle")
  pure val CREDITED = if (CREDIT_ALL) GATES else Set("peer-stale", "input-stall")
  pure val IDLE = -1

  // Seconds since each wait began, by the time stamp; IDLE = not waiting.
  var stamped: str -> int
  // Seconds of that the page was running for.
  var awake: str -> int
  var dropped: bool
  // history: a peer was dropped on a deadline the page had not run through
  var unfair: bool

  action init = all {
    stamped' = GATES.mapBy(_ => IDLE),
    awake' = GATES.mapBy(_ => IDLE),
    dropped' = false, unfair' = false,
  }

  action begin(g: str): bool = all {
    not(dropped),
    stamped.get(g) == IDLE,
    stamped' = stamped.set(g, 0), awake' = awake.set(g, 0),
    dropped' = dropped, unfair' = unfair,
  }

  // The peer's input arrived, the page is no longer ahead: the wait is over.
  action end(g: str): bool = all {
    stamped.get(g) != IDLE,
    stamped' = stamped.set(g, IDLE), awake' = awake.set(g, IDLE),
    dropped' = dropped, unfair' = unfair,
  }

  pure def plus(clocks: str -> int, n: int, which: Set[str]): str -> int =
    clocks.keys().mapBy(g => if (clocks.get(g) != IDLE and which.contains(g)) clocks.get(g) + n else clocks.get(g))

  // A second passes with the page running.
  action second = all {
    not(dropped),
    GATES.exists(g => stamped.get(g) != IDLE and stamped.get(g) < LIMIT),
    stamped' = plus(stamped, 1, GATES), awake' = plus(awake, 1, GATES),
    dropped' = dropped, unfair' = unfair,
  }

  // The page stops for n seconds. At the next tick the gap is credited to
  // the stamps the tick loop knows to move.
  action freeze(n: int): bool = all {
    not(dropped),
    stamped' = plus(stamped, n, GATES.exclude(CREDITED)),
    awake' = awake,
    dropped' = dropped, unfair' = unfair,
  }

  // A deadline is reached: the peer is dropped.
  action fire(g: str): bool = all {
    not(dropped),
    stamped.get(g) >= LIMIT,
    dropped' = true,
    unfair' = (unfair or awake.get(g) < LIMIT),
    stamped' = stamped, awake' = awake,
  }

  action step = any {
    second,
    nondet n = 1.to(6).oneOf()
    freeze(n),
    nondet g = oneOf(GATES)
    any { begin(g), end(g), fire(g) },
  }

  // A peer is dropped only on a deadline the page ran through: its own
  // freeze is never held against the peer.
  // Violated before the pacing-throttle deadline was credited.
  val ownFreezeIsNotHeldAgainstAPeer = not(unfair)

  // The page is held back for its peer, then freezes for 5 s. The peer was
  // sending all along; the first tick after the freeze drops it.
  run freezeWhileHeldBackTest =
    init
      .then(begin("pacing-throttle"))
      .then(freeze(5))
      .expect((stamped.get("pacing-throttle") >= LIMIT) == not(CREDIT_ALL))
      .then(if (CREDIT_ALL) end("pacing-throttle") else fire("pacing-throttle"))
      .expect(dropped == not(CREDIT_ALL) and unfair == not(CREDIT_ALL))

  // The same freeze during the two waits that are credited: nothing fires.
  run freezeWhileWaitingForInputTest =
    init
      .then(begin("input-stall"))
      .then(begin("peer-stale"))
      .then(second)
      .then(freeze(6))
      .expect(stamped.get("input-stall") == 1 and stamped.get("peer-stale") == 1)

  // A peer that really is silent for 5 s is dropped, freeze or not.
  run silentPeerIsDroppedTest =
    init
      .then(begin("peer-stale"))
      .then(2.reps(_ => second))
      .then(freeze(4))
      .then(3.reps(_ => second))
      .then(fire("peer-stale"))
      .expect(dropped and not(unfair))
}

// Before: the pacing-throttle deadline was not credited.
module tick_deadlines_before {
  import tick_deadlines(CREDIT_ALL = false).*
}

// Today.
module tick_deadlines_current {
  import tick_deadlines(CREDIT_ALL = true).*
}

// ── A state transfer and the inputs behind it ───────────────────────────────
//
// The host's state for a resync (1.4 MB compressed, 24 chunks of 64 KB) and
// its inputs leave on different data channels of one peer connection, but
// share its transport: in the two-player run that found this (DELAY_SYNC_
// ANSWER_MS=10000 BATTLE_SECONDS=90, 2026-11) two answers, 2.9 MB, went into
// the connection at once, and the host's input channel then held 5.7 KB it
// could not send (TICK-STUCK `buffered=5719`). The guest heard nothing from
// the host for 9.6 s: ROLLBACK-STALL at 3 s, PEER-PHANTOM at 5 s (the
// peer-stale deadline above, doing its job), and from there it ran on alone,
// 84 frames, past the prediction window. When the host's inputs came back
// they were 83 frames deep: 76 DEEP-MISPREDICT-SKIP, a desync until the next
// resync. A second run (BATTLE_SECONDS=60) did the same: 6.8 s without the
// host's inputs after a burst of state, PEER-PHANTOM at 5 s, 20
// DEEP-MISPREDICT-SKIP. The window's guard held in both; the deadline that
// ends it (a phantom is left out of the guard, by design) fired on a host
// that had been sending all along, its inputs queued behind its own state.
//
// What is modelled: the host's outgoing transport as one queue (the order
// that run showed: an input waits for the chunks handed over before it), a
// link that each second carries the inputs at the head of the queue and one
// chunk, the host making one input a second, the guest's peer-stale clock
// and its deadline (LIMIT seconds here), and the host stopping for good.
// A page that gave up on its peer runs past the window, so an input reaching
// it after that arrived deeper than the cap.
//
// Not modelled: chunk sizes and link speed (a chunk is a second of link
// time), the guest's own freezes (credited, above), the stall before the
// deadline, the guest's inputs, more than one guest (each guest's transfer
// goes on a chain of its own, so one guest's congested link cannot hold
// another's: a source test, tests/test_sync_send_source.py).
//
// Also modelled, for what a transfer may do once it is under way: the
// guest's connection being replaced (a reconnect: resetPeerState, which
// ends the transfer on the old channel and deletes the guest's input floor),
// a transfer queued behind the one in hand (a proactive push on the same
// chain), the paced sender giving a transfer up (SYNC-SEND-STALLED, no room
// for a chunk within SYNC_SEND_STALL_MS), and the host settling the guest's
// inputs for a state (_settleInputsBefore: it stops waiting for the guest's
// inputs from before the state's frame, which the state already holds;
// specs/resync_inputs.qnt). Settled for a state the guest never gets, the
// guest's late inputs from before that frame are dropped at the host, which
// predicted them: input loss after a congestion episode.
//
// PACED: the host hands its channel a chunk only while no chunk of its is
//   waiting there (sendSyncChunks waits for the channel's bufferedAmount to
//   fall below SYNC_SEND_LOW_WATER: a "chunk" here is that much, four of
//   the engine's), and starts a transfer only once the last one has gone
//   (_pushingSyncState queues a request until then).
//   false = before: every chunk is handed over at once, and a second answer
//   behind the first. Nothing waits, so nothing is queued, outlives a
//   reconnect or is given up.
// GUARD_QUEUED: a queued transfer remembers the connection it was queued for
//   (the match epoch and the guest's _syncQueueGen, which resetPeerState
//   bumps) and is dropped when it comes up if that connection was replaced.
//   false = #236 as first written: the target was looked up when the
//   transfer came up, and the old state and request id went over the new
//   connection.
// SETTLE_WHEN_SENT: the host settles the guest's inputs for a state only once
//   its last chunk is handed over (sendPaced `sent`). false = #236 as first
//   written: settled before the first chunk, and left settled when the
//   transfer was given up.
// PROGRESS_DEADLINE: the guest's chunk deadline (SYNC_CHUNK_TIMEOUT_MS, 3 s;
//   CHUNK_LIMIT seconds here) restarts with each chunk that reaches it, so
//   it gives a transfer up only when the transfer stops moving. false = a
//   deadline on the whole state, from its header: the engine's before this.
//   Paced, a 1.4 MB state needs more than 3 s on any link slower than about
//   3.9 Mbit/s, so the guest gave up on transfers that were still arriving,
//   asked for the state over Socket.IO, and the host went on pacing the
//   transfer the guest had dropped, its inputs queued behind it (the
//   LINK_KBPS=2000 two-player run, 2026-11: `sync chunks timeout: 5/15
//   chunks after 3000ms`, then the host's inputs up to 1 s late and
//   DEEP-MISPREDICT-SKIP after the forward jump the socket state made).
//   The guest's give-up and its socket request are modelled; the socket
//   transfer itself is not (it does not use this connection).
module input_link {
  const PACED: bool
  const GUARD_QUEUED: bool
  const SETTLE_WHEN_SENT: bool
  const PROGRESS_DEADLINE: bool

  pure val LIMIT = 2
  // Chunks one transfer is cut into (any number up to this).
  pure val MAX_CHUNKS = 3
  // Bound on the queue, for the checker.
  pure val MAX_QUEUE = 8
  // Bound on reconnects, for the checker.
  pure val MAX_RESETS = 2
  // The guest's chunk deadline, in seconds of link time.
  pure val CHUNK_LIMIT = 2

  var queue: List[str]     // "chunk" or "input", oldest first
  var toSend: int          // chunks of the current transfer not handed over yet
  var stale: int           // seconds since an input from the host reached the guest
  var dropped: bool        // the guest gave up on the host (PEER-PHANTOM)
  var hostStopped: bool    // the host stopped sending (crashed, left)
  // history: an input from a host that never stopped reached a guest that
  // had given up on it, i.e. deeper than the cap
  var deep: bool
  var conn: int            // the guest's connection; a reconnect replaces it
  var sendingFor: int      // the connection the transfer in hand was made for
  var queued: int          // chunks of a transfer queued behind it (0: none)
  var queuedFor: int       // the connection that one was made for
  var settled: bool        // the guest's inputs are settled for the transfer in hand
  // history: a chunk of a transfer made for one connection was handed to another
  var reachedNewConn: bool
  // history: a transfer was given up while the guest's inputs were settled for it
  var settledUndelivered: bool
  var receiving: bool      // the guest is receiving the transfer in hand
  var expecting: int       // chunks of it the guest has yet to get
  var sinceStart: int      // seconds since that transfer started (capped)
  var sinceChunk: int      // seconds since a chunk of it last reached the guest (capped)
  var discarded: bool      // the guest gave the transfer in hand up and asked over Socket.IO
  var heard: bool          // the host has that request
  // history: the guest gave up on a transfer whose chunks were still arriving
  var abandonedProgressing: bool
  // history: the host handed over a chunk of a transfer it knew the guest had dropped
  var deadChunk: bool

  action init = all {
    queue' = List(), toSend' = 0, stale' = 0,
    dropped' = false, hostStopped' = false, deep' = false,
    conn' = 0, sendingFor' = 0, queued' = 0, queuedFor' = 0, settled' = false,
    reachedNewConn' = false, settledUndelivered' = false,
    receiving' = false, expecting' = 0, sinceStart' = 0, sinceChunk' = 0,
    discarded' = false, heard' = false, abandonedProgressing' = false, deadChunk' = false,
  }

  pure def chunksIn(q: List[str]): int = q.foldl(0, (n, x) => if (x == "chunk") n + 1 else n)

  pure def withChunks(q: List[str], n: int): List[str] =
    range(1, MAX_CHUNKS + 1).foldl(q, (acc, i) => if (i <= n) acc.append("chunk") else acc)

  // Settled when the transfer starts, unless only once it is sent; a burst
  // is sent as it starts.
  pure val SETTLE_AT_START = not(PACED) or not(SETTLE_WHEN_SENT)

  // The host answers a resync request with a state of n chunks.
  action transfer(n: int): bool = all {
    not(hostStopped),
    if (PACED) toSend == 0 and queued == 0 else queue.length() + n <= MAX_QUEUE,
    queue' = if (PACED) queue else withChunks(queue, n),
    toSend' = if (PACED) n else toSend,
    sendingFor' = conn,
    settled' = SETTLE_AT_START,
    stale' = stale, dropped' = dropped, hostStopped' = hostStopped, deep' = deep,
    conn' = conn, queued' = queued, queuedFor' = queuedFor,
    reachedNewConn' = reachedNewConn, settledUndelivered' = settledUndelivered,
    // The guest starts receiving it (its header).
    receiving' = true, expecting' = n, sinceStart' = 0, sinceChunk' = 0,
    discarded' = false, heard' = false, abandonedProgressing' = abandonedProgressing, deadChunk' = deadChunk,
  }

  // Another transfer (a proactive push) waits behind the one in hand.
  action enqueue(n: int): bool = all {
    PACED,
    not(hostStopped),
    toSend > 0,
    queued == 0,
    queued' = n,
    queuedFor' = conn,
    queue' = queue, toSend' = toSend, stale' = stale, dropped' = dropped, hostStopped' = hostStopped,
    deep' = deep, conn' = conn, sendingFor' = sendingFor, settled' = settled,
    reachedNewConn' = reachedNewConn, settledUndelivered' = settledUndelivered,
    receiving' = receiving, expecting' = expecting, sinceStart' = sinceStart, sinceChunk' = sinceChunk,
    discarded' = discarded, heard' = heard, abandonedProgressing' = abandonedProgressing, deadChunk' = deadChunk,
  }

  // The queued transfer comes up once the one before it is done. Guarded, it
  // is dropped if its connection was replaced meanwhile.
  action startQueued = {
    val stillOurs = not(GUARD_QUEUED) or queuedFor == conn
    all {
      PACED,
      toSend == 0,
      queued > 0,
      queued' = 0,
      toSend' = if (stillOurs) queued else 0,
      sendingFor' = if (stillOurs) queuedFor else sendingFor,
      settled' = if (stillOurs) SETTLE_AT_START else settled,
      queue' = queue, stale' = stale, dropped' = dropped, hostStopped' = hostStopped,
      deep' = deep, conn' = conn, queuedFor' = queuedFor,
      reachedNewConn' = reachedNewConn, settledUndelivered' = settledUndelivered,
      receiving' = if (stillOurs) true else receiving,
      expecting' = if (stillOurs) queued else expecting,
      sinceStart' = if (stillOurs) 0 else sinceStart,
      sinceChunk' = if (stillOurs) 0 else sinceChunk,
      discarded' = if (stillOurs) false else discarded,
      heard' = if (stillOurs) false else heard,
      abandonedProgressing' = abandonedProgressing, deadChunk' = deadChunk,
    }
  }

  // The link takes the inputs at the head of the queue and the chunk after them.
  pure def firstChunk(q: List[str]): int =
    q.indices().fold(q.length(), (i, j) => if (q[j] == "chunk" and j < i) j else i)

  // A second passes: the host makes its input and the paced sender hands
  // over its next chunk, then the link carries what it can.
  action second = {
    val handed = PACED and toSend > 0 and chunksIn(queue) == 0
    val q1 = if (handed) queue.append("chunk") else queue
    val q2 = if (hostStopped) q1 else q1.append("input")
    val upTo = firstChunk(q2)
    // Everything before the first chunk, and that chunk.
    val carried = if (upTo < q2.length()) upTo + 1 else upTo
    val gotInput = q2.slice(0, carried).foldl(false, (b, x) => b or x == "input")
    val gotChunk = q2.slice(0, carried).foldl(false, (b, x) => b or x == "chunk")
    all {
      q2.length() <= MAX_QUEUE + 1,
      queue' = q2.slice(carried, q2.length()),
      toSend' = if (handed) toSend - 1 else toSend,
      stale' = if (gotInput) 0 else stale + 1,
      deep' = (deep or (gotInput and dropped and not(hostStopped))),
      dropped' = dropped, hostStopped' = hostStopped,
      conn' = conn, sendingFor' = sendingFor, queued' = queued, queuedFor' = queuedFor,
      // The last chunk handed over: the transfer is sent.
      settled' = (settled or (handed and toSend == 1)),
      reachedNewConn' = (reachedNewConn or (handed and sendingFor != conn)),
      settledUndelivered' = settledUndelivered,
      // The last chunk has reached the guest: it has the state.
      receiving' = (receiving and not(gotChunk and expecting <= 1)),
      expecting' = if (gotChunk and expecting > 0) expecting - 1 else expecting,
      sinceStart' = if (sinceStart > CHUNK_LIMIT) sinceStart else sinceStart + 1,
      sinceChunk' = if (gotChunk) 0 else if (sinceChunk > CHUNK_LIMIT) sinceChunk else sinceChunk + 1,
      discarded' = discarded, heard' = heard, abandonedProgressing' = abandonedProgressing,
      deadChunk' = (deadChunk or (handed and heard)),
    }
  }

  // The peer-stale deadline.
  action fire = all {
    not(dropped),
    stale >= LIMIT,
    dropped' = true,
    queue' = queue, toSend' = toSend, stale' = stale, hostStopped' = hostStopped, deep' = deep,
    conn' = conn, sendingFor' = sendingFor, queued' = queued, queuedFor' = queuedFor, settled' = settled,
    reachedNewConn' = reachedNewConn, settledUndelivered' = settledUndelivered,
    receiving' = receiving, expecting' = expecting, sinceStart' = sinceStart, sinceChunk' = sinceChunk,
    discarded' = discarded, heard' = heard, abandonedProgressing' = abandonedProgressing, deadChunk' = deadChunk,
  }

  action stop = all {
    not(hostStopped),
    hostStopped' = true,
    queue' = queue, toSend' = toSend, stale' = stale, dropped' = dropped, deep' = deep,
    conn' = conn, sendingFor' = sendingFor, queued' = queued, queuedFor' = queuedFor, settled' = settled,
    reachedNewConn' = reachedNewConn, settledUndelivered' = settledUndelivered,
    receiving' = receiving, expecting' = expecting, sinceStart' = sinceStart, sinceChunk' = sinceChunk,
    discarded' = discarded, heard' = heard, abandonedProgressing' = abandonedProgressing, deadChunk' = deadChunk,
  }

  // The guest's connection is replaced (resetPeerState): the transfer in
  // hand ends with the old channel (sendPaced `closed`), what the old
  // connection held is gone, the guest's input floor is deleted, and the
  // guest hears the host again on the new one. A queued transfer stays on
  // the chain.
  action reset = all {
    conn < MAX_RESETS,
    conn' = conn + 1,
    toSend' = 0,
    queue' = List(),
    settled' = false,
    stale' = 0,
    dropped' = false,
    hostStopped' = hostStopped, deep' = deep, sendingFor' = sendingFor,
    queued' = queued, queuedFor' = queuedFor,
    reachedNewConn' = reachedNewConn, settledUndelivered' = settledUndelivered,
    // The new connection's guest is receiving nothing yet.
    receiving' = false, expecting' = 0, sinceStart' = sinceStart, sinceChunk' = sinceChunk,
    discarded' = false, heard' = false, abandonedProgressing' = abandonedProgressing, deadChunk' = deadChunk,
  }

  // The paced sender finds no room for a chunk within its deadline and gives
  // the transfer up (SYNC-SEND-STALLED). Whatever is settled for it stays so.
  action abandon = all {
    PACED,
    toSend > 0,
    toSend' = 0,
    settledUndelivered' = (settledUndelivered or settled),
    queue' = queue, stale' = stale, dropped' = dropped, hostStopped' = hostStopped, deep' = deep,
    conn' = conn, sendingFor' = sendingFor, queued' = queued, queuedFor' = queuedFor, settled' = settled,
    reachedNewConn' = reachedNewConn,
    receiving' = receiving, expecting' = expecting, sinceStart' = sinceStart, sinceChunk' = sinceChunk,
    discarded' = discarded, heard' = heard, abandonedProgressing' = abandonedProgressing, deadChunk' = deadChunk,
  }

  // The guest's chunk deadline: it drops the transfer and asks for the state
  // over Socket.IO (`sync chunks timeout ... requesting socket full sync`).
  action chunkTimeout = all {
    receiving,
    if (PROGRESS_DEADLINE) sinceChunk >= CHUNK_LIMIT else sinceStart >= CHUNK_LIMIT,
    receiving' = false,
    expecting' = 0,
    discarded' = true,
    abandonedProgressing' = (abandonedProgressing or sinceChunk < CHUNK_LIMIT),
    queue' = queue, toSend' = toSend, stale' = stale, dropped' = dropped, hostStopped' = hostStopped,
    deep' = deep, conn' = conn, sendingFor' = sendingFor, queued' = queued, queuedFor' = queuedFor,
    settled' = settled, reachedNewConn' = reachedNewConn, settledUndelivered' = settledUndelivered,
    sinceStart' = sinceStart, sinceChunk' = sinceChunk, heard' = heard, deadChunk' = deadChunk,
  }

  // That request reaches the host.
  action hearDiscard = all {
    discarded,
    not(heard),
    heard' = true,
    queue' = queue, toSend' = toSend, stale' = stale, dropped' = dropped, hostStopped' = hostStopped,
    deep' = deep, conn' = conn, sendingFor' = sendingFor, queued' = queued, queuedFor' = queuedFor,
    settled' = settled, reachedNewConn' = reachedNewConn, settledUndelivered' = settledUndelivered,
    receiving' = receiving, expecting' = expecting, sinceStart' = sinceStart, sinceChunk' = sinceChunk, discarded' = discarded,
    abandonedProgressing' = abandonedProgressing, deadChunk' = deadChunk,
  }

  action step = any {
    second,
    fire,
    stop,
    reset,
    abandon,
    startQueued,
    chunkTimeout,
    hearDiscard,
    nondet n = 1.to(MAX_CHUNKS).oneOf()
    any { transfer(n), enqueue(n) },
  }

  // No input from a host that is sending arrives deeper than the cap: the
  // guest never gives up on a host whose inputs are queued behind the
  // host's own state, and so never runs past the window on it.
  // Violated while a state went into the connection all at once.
  val noInputArrivesDeeperThanTheCap = not(deep)

  // A host that is sending is never given up on.
  val aSendingHostIsNotDropped = dropped implies hostStopped

  // A transfer queued before a reset never reaches the new connection: its
  // state and request id are the old connection's. Violated while a queued
  // transfer looked its target up only when it came up (input_link_paced_unguarded).
  val aTransferQueuedBeforeAResetNeverReachesTheNewConnection = not(reachedNewConn)

  // Inputs are settled only for a state that was delivered: a transfer given
  // up leaves nothing settled. Violated while the floor moved before the
  // first chunk (input_link_paced_unguarded).
  val inputsAreSettledOnlyForADeliveredState = not(settledUndelivered)

  // A transfer still making progress is not abandoned: the guest gives a
  // transfer up only when no chunk of it has arrived for the deadline.
  // Violated while the deadline ran over the whole state
  // (input_link_paced_whole_deadline).
  val aTransferMakingProgressIsNotAbandoned = not(abandonedProgressing)

  // The host never goes on handing over a transfer the guest has told it it
  // dropped, its inputs queuing behind the dead chunks. Violated with the
  // deadline over the whole state (input_link_paced_whole_deadline).
  val noChunkForATransferTheGuestDropped = not(deadChunk)

  val allHold = and {
    noInputArrivesDeeperThanTheCap,
    aSendingHostIsNotDropped,
    aTransferQueuedBeforeAResetNeverReachesTheNewConnection,
    inputsAreSettledOnlyForADeliveredState,
    aTransferMakingProgressIsNotAbandoned,
    noChunkForATransferTheGuestDropped,
  }

  // The run that found it: two answers back to back, and the inputs behind
  // them. Before: the deadline fires while the host is sending, and its
  // next input arrives at a guest that has run past the window. Paced: the
  // second answer waits for the first, the inputs go between the chunks,
  // and the deadline never comes due.
  run twoAnswersBackToBackTest =
    init
      .then(transfer(2))
      .then(if (PACED) second else transfer(2))
      .then(2.reps(_ => second))
      .expect((stale >= LIMIT) == not(PACED))
      .then(if (PACED) second else fire)
      .then(4.reps(_ => second))
      .expect(deep == not(PACED) and noInputArrivesDeeperThanTheCap == PACED)

  // One answer is enough when it is long.
  run oneLongAnswerTest =
    init
      .then(transfer(3))
      .then(2.reps(_ => second))
      .expect((stale >= LIMIT) == not(PACED))

  // A host that stops is given up on, paced or not, and nothing of it
  // arrives deep afterwards.
  run stoppedHostIsDroppedTest =
    init
      .then(transfer(1))
      .then(second)
      .then(stop)
      .then((LIMIT + 1).reps(_ => second))
      .then(fire)
      .then(3.reps(_ => second))
      .expect(dropped and not(deep) and allHold)

  // Finding 2 on #236: a push queued behind a transfer, the guest reconnects,
  // the push comes up. Unguarded, its chunk goes over the new connection.
  // A burst queues nothing: its chunks went with the old connection.
  run transferQueuedBeforeAResetTest =
    init
      .then(transfer(2))
      .then(if (PACED) enqueue(1) else second)
      .then(reset)
      .then(if (PACED) startQueued else second)
      .then(second)
      .expect(
        reachedNewConn == (PACED and not(GUARD_QUEUED)) and
        aTransferQueuedBeforeAResetNeverReachesTheNewConnection == (not(PACED) or GUARD_QUEUED)
      )

  // The same push after a transfer that ended on its own: it still goes.
  run transferQueuedWithoutAResetGoesTest =
    init
      .then(transfer(1))
      .then(if (PACED) enqueue(1) else second)
      .then(second)
      .then(if (PACED) startQueued else second)
      .then(second)
      .expect(not(reachedNewConn) and toSend == 0 and queued == 0)

  // Finding 3 on #236: a chunk goes, then the channel has no room for the
  // next within the deadline and the transfer is given up. Settled at the
  // start, the guest's inputs from before the state's frame stay settled
  // for a state it never gets.
  run abandonedTransferTest =
    init
      .then(transfer(2))
      .then(second)
      .then(if (PACED) abandon else second)
      .expect(
        settledUndelivered == (PACED and not(SETTLE_WHEN_SENT)) and
        inputsAreSettledOnlyForADeliveredState == (not(PACED) or SETTLE_WHEN_SENT)
      )

  // The LINK_KBPS=2000 run: a state longer than the deadline, its chunks
  // arriving one a second. With a deadline over the whole state the guest
  // drops it mid-way and asks over Socket.IO, and the paced host hands over
  // the next chunk of the transfer it has just heard was dropped. With a
  // progress deadline the guest keeps receiving it to the end.
  run progressingTransferAbandonedTest =
    init
      .then(transfer(3))
      .then(2.reps(_ => second))
      .then(if (PROGRESS_DEADLINE) second else chunkTimeout)
      .then(if (PROGRESS_DEADLINE) second else hearDiscard)
      .then(second)
      .expect(and {
        abandonedProgressing == not(PROGRESS_DEADLINE),
        deadChunk == (PACED and not(PROGRESS_DEADLINE)),
        receiving == false,
        discarded == not(PROGRESS_DEADLINE),
      })

  // A transfer that stops moving is still given up, deadline on progress or
  // not: the paced sender gave it up (SYNC-SEND-STALLED) after one chunk.
  run stalledTransferIsGivenUpTest =
    init
      .then(transfer(3))
      .then(second)
      .then(if (PACED) abandon else second)
      .then(2.reps(_ => second))
      .then(if (PACED) chunkTimeout else second)
      .expect((discarded == PACED) and aTransferMakingProgressIsNotAbandoned and noChunkForATransferTheGuestDropped)

  // A transfer that is sent settles the guest's inputs, whenever it does so.
  run sentTransferSettlesTest =
    init
      .then(transfer(2))
      .then(2.reps(_ => second))
      .expect(toSend == 0 and settled and allHold)
}

// Before: a state went into the connection all at once.
module input_link_burst {
  import input_link(PACED = false, GUARD_QUEUED = false, SETTLE_WHEN_SENT = false, PROGRESS_DEADLINE = false).*
}

// #236 as first written: a chunk at a time, but a queued transfer looked its
// target up when it came up, and the guest's inputs were settled before the
// first chunk.
module input_link_paced_unguarded {
  import input_link(PACED = true, GUARD_QUEUED = false, SETTLE_WHEN_SENT = false, PROGRESS_DEADLINE = false).*
}

// #236 with those two fixed, the guest's chunk deadline still over the whole
// state.
module input_link_paced_whole_deadline {
  import input_link(PACED = true, GUARD_QUEUED = true, SETTLE_WHEN_SENT = true, PROGRESS_DEADLINE = false).*
}

// Today: a chunk at a time, a queued transfer dropped if its connection was
// replaced, the guest's inputs settled once the state is sent, and the
// guest's chunk deadline on progress.
module input_link_paced {
  import input_link(PACED = true, GUARD_QUEUED = true, SETTLE_WHEN_SENT = true, PROGRESS_DEADLINE = true).*
}
