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
// It credits two of the three. The pacing-throttle stamp is not moved, and
// its deadline is checked in the tick before anything can end the throttle:
// a page that froze for 5 s while it was being held back drops its peer on
// the first tick after.
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
//   false = today: peer-stale and input-stall only.
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
  // VIOLATED today, by the pacing-throttle deadline.
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

// Today.
module tick_deadlines_current {
  import tick_deadlines(CREDIT_ALL = false).*
}

// With the freeze credited to every deadline that drops a peer.
module tick_deadlines_fixed {
  import tick_deadlines(CREDIT_ALL = true).*
}
