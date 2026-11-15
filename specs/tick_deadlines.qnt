// -*- mode: Bluespec; -*-
//
// The tick loop's deadlines and a page that freezes (tick() and
// _creditLocalFreeze in web/static/netplay-rollback.js).
//
// Every wait in the tick loop has a wall-clock deadline (netplay invariant
// I1). Four of them end by dropping a peer: the page marks it a phantom and
// plays on without it, and the two resync when it is heard from again.
//   peer-stale       no input from the peer for 5 s        (PEER-PHANTOM)
//   input-stall      waiting on one input of the peer 5 s  (RB-INPUT-STALL-TIMEOUT)
//   pacing-throttle  held back for the peer for 5 s        (PACING-THROTTLE-TIMEOUT)
//   lockstep-wait    in lockstep mode, waiting on the peer's input for the
//                    frame about to run, 5 s                (LOCKSTEP-WAIT-TIMEOUT)
//
// The lockstep wait is new with lockstep as a mode the host picks: the page
// predicts nothing and runs a frame only with every player's input for it.
// The demo page's paused predictions waited the same way with no deadline:
// its peer is simulated and never stops. In a real match a peer whose input
// for one frame never arrives (it is still sending later ones, so peer-stale
// does not fire) would hold the page for ever.
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
// either (the resync target, the wait for the host's rollback settings),
// what makes each wait begin and end, a hidden tab (by design not credited:
// its handlers keep running), more than one peer.
//
// CREDIT_ALL: a freeze is credited to every deadline that drops a peer.
//   false = before: peer-stale and input-stall only.
// LOCKSTEP_DEADLINE: the lockstep wait drops the peer at the limit, and is
//   credited like the others. false = before: it had no deadline.
module tick_deadlines {
  const CREDIT_ALL: bool
  const LOCKSTEP_DEADLINE: bool

  pure val LIMIT = 5
  pure val GATES = Set("peer-stale", "input-stall", "pacing-throttle", "lockstep-wait")
  // The waits that end at the limit by dropping the peer.
  pure val DEADLINED = if (LOCKSTEP_DEADLINE) GATES else GATES.exclude(Set("lockstep-wait"))
  pure val CREDITED =
    if (CREDIT_ALL) DEADLINED else Set("peer-stale", "input-stall")
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
    GATES.exists(g => stamped.get(g) != IDLE and (stamped.get(g) < LIMIT or not(DEADLINED.contains(g)))),
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
    DEADLINED.contains(g),
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

  // A page waiting on a peer past the limit can still end the wait: no wait
  // outlasts its deadline without one. (Before the lockstep wait had one, a
  // page could stand at frame f for ever on one lost input.)
  // Violated before the lockstep wait had a deadline.
  val everyWaitHasADeadline =
    GATES.forall(g => (stamped.get(g) != IDLE and stamped.get(g) >= LIMIT) implies DEADLINED.contains(g))

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

  // Lockstep: one input of the peer never arrives. Before, the page waited
  // past the limit with nothing to end the wait; now the peer is dropped.
  run lockstepLostInputTest =
    init
      .then(begin("lockstep-wait"))
      .then(5.reps(_ => second))
      .expect(everyWaitHasADeadline == LOCKSTEP_DEADLINE)
      .then(if (LOCKSTEP_DEADLINE) fire("lockstep-wait") else second)
      .expect(dropped == LOCKSTEP_DEADLINE)

  // Lockstep: the page freezes while it waits. The freeze is credited, so
  // the peer is not dropped for it.
  run lockstepFreezeIsCreditedTest =
    init
      .then(begin("lockstep-wait"))
      .then(second)
      .then(freeze(6))
      .expect((stamped.get("lockstep-wait") == 1) == (LOCKSTEP_DEADLINE and CREDIT_ALL))

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

// Before: the pacing-throttle deadline was not credited, and the lockstep
// wait had no deadline.
module tick_deadlines_before {
  import tick_deadlines(CREDIT_ALL = false, LOCKSTEP_DEADLINE = false).*
}

// Before lockstep was a mode: every deadline credited, the lockstep wait (the
// demo's paused predictions) with none.
module tick_deadlines_before_lockstep_mode {
  import tick_deadlines(CREDIT_ALL = true, LOCKSTEP_DEADLINE = false).*
}

// Today.
module tick_deadlines_current {
  import tick_deadlines(CREDIT_ALL = true, LOCKSTEP_DEADLINE = true).*
}
