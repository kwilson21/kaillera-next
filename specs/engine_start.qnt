// -*- mode: Bluespec; -*-
//
// How a page's C engine starts: the arming handshake in
// web/static/netplay-rollback.js (startLockstep, tryInitRollback,
// doRollbackInit, _requestRollbackInit, the `rb-delay:` and `rb-init-frame:`
// handlers, the late-join state handler, and the RB-INIT-CATCHUP and
// RB-INIT-TIMEOUT branches of tick()).
//
// The C engine (kn_rollback_init) runs every frame of a match: it saves the
// state, applies each player's input at frame + delay, and predicts and
// replays when it has to. Every page must arm it with the same delay and at
// the frame its emulator is on, labelled as the host labels it, or the pages
// apply inputs at different frames and split.
//
// This starts where specs/start_group.qnt ends: a page in the start group
// whose match runs (startLockstep, once every player it waits for has booted
// and is lockstep-ready). A player the host left out of the start, or one
// that rejoins late, is held as a late joiner and arms through the late join
// (lateJoin below): the host's state carries the frame and the delay the host
// runs at. The host may have started alone (a delay of 0) or with others.
//
// The host arms at its start (startLockstep) with the delay it negotiated and
// tells each guest the delay (`rb-delay:`, sent at "GO") and its start frame
// (`rb-init-frame:`, sent when it arms). A guest holds until it has both,
// then arms. A late joiner learns both from the host's state.
//
// Before, a page did not always arm:
//   - a page with a delay of 0 never armed and ran on the old JS lockstep
//     path. Alone in a room the delay is 0 (SOLO_FRAME_DELAY), so every solo
//     match ran there, and so did a friend who joined it late;
//   - a guest that had not heard the host 3 s after its start armed anyway
//     (RB-INIT-TIMEOUT), with its own delay when `rb-delay:` was lost: the
//     host sent each message once, and a channel that closed took it with it;
//   - a guest told a start frame other than its own stepped to it on the old
//     path (RB-INIT-CATCHUP) or armed where it was. Nothing makes the two
//     differ: no page runs a frame before it arms, and a late joiner is told
//     the frame of the state it loads (`theHostsStartIsWhereTheGuestIs`), so
//     those branches are dead and go.
//
// What is modelled: the host, one guest that starts with it or joins its
// match late (the host started alone, or with others and left this guest out), the host's messages to the guest in order on one data channel
// that can close (losing what is in flight) and open again, the guest's wait
// and its deadline. Messages on an open channel arrive before the wait's
// clock moves (milliseconds against seconds).
//
// Not modelled: inputs, prediction and replay (the C engine itself), the
// delay re-tune once a second player is in (_retuneDelay), more than one
// guest, spectators.
//
// ARM_AT_ZERO_DELAY: a page arms the C engine at a delay of 0 too.
//   false = before: a delay of 0 meant the old JS lockstep path.
// HOST_SENDS_BOTH: the armed host sends the delay and its start frame
//   together, when it arms and on every channel to a guest that opens.
//   false = before: `rb-delay:` once at "GO", `rb-init-frame:` once at arming.
// STOP_AT_THE_DEADLINE: a guest that has not heard the host's delay by the
//   deadline stops and says so; it never arms with a delay of its own. One
//   that has the delay arms with it at its own frame, which is the host's
//   start (theHostsStartIsWhereTheGuestIs), as before.
//   false = before: with no delay heard, it armed with its own.
//
// The deadline is checked in the tick loop, after the page has taken in what
// arrived, so it too waits for nothing to be in flight. A host that arms
// only after a guest's deadline has passed leaves that guest stopped: the
// deadline must be well past the time between two pages' starts.
module engine_start {
  const ARM_AT_ZERO_DELAY: bool
  const HOST_SENDS_BOTH: bool
  const STOP_AT_THE_DEADLINE: bool

  pure val MATCH_DELAY = 2 // the delay the host negotiates with a guest in
  pure val OWN_DELAY = 3   // what the guest worked out for itself
  pure val SOLO_DELAY = 0  // alone in the room (SOLO_FRAME_DELAY)
  pure val DEADLINE = 3
  pure val MAX_FRAME = 3

  type Msg = DelayIs(int) | StartsAt(int)
  type Guest = NotIn | Waiting | Armed | RunsUnarmed | Stopped

  var started: bool         // the host's match has begun
  var alone: bool           // the guest was not in the start (alone in the room, or left out)
  var hostDelay: int
  var delaySent: bool       // the host has been through "GO"
  var hostRunning: bool
  var hostArmed: bool
  var hostStart: int        // the frame the host armed at
  var hostFrame: int
  var guest: Guest
  var guestFrame: int
  var heardDelay: int       // -1: not heard
  var heardStart: int       // -1: not heard
  var armDelay: int
  var armFrame: int
  var waited: int
  var open: bool            // the host's channel to the guest
  var toGuest: List[Msg]
  var ranUnarmed: bool       // history: a page ran a frame without its C engine
  var stoppedReachable: bool // history: a guest stopped while the armed host's channel was open

  // ── actions ────────────────────────────────────────────────────────────

  action init = all {
    started' = false, alone' = false, hostDelay' = 0, delaySent' = false,
    hostRunning' = false, hostArmed' = false, hostStart' = -1, hostFrame' = 0,
    guest' = NotIn, guestFrame' = 0, heardDelay' = -1, heardStart' = -1,
    armDelay' = -1, armFrame' = -1, waited' = 0,
    open' = true, toGuest' = [],
    ranUnarmed' = false, stoppedReachable' = false,
  }

  action hostSame = all {
    started' = started, alone' = alone, hostDelay' = hostDelay, delaySent' = delaySent,
    hostRunning' = hostRunning, hostArmed' = hostArmed, hostStart' = hostStart, hostFrame' = hostFrame,
  }
  action guestSame = all {
    guest' = guest, guestFrame' = guestFrame, heardDelay' = heardDelay, heardStart' = heardStart,
    armDelay' = armDelay, armFrame' = armFrame, waited' = waited,
  }
  action historySame = all { ranUnarmed' = ranUnarmed, stoppedReachable' = stoppedReachable }

  pure def canArm(delay: int): bool = delay > 0 or ARM_AT_ZERO_DELAY

  // What the host sends when it arms, or when a channel opens while armed.
  def onArm(start: int): List[Msg] =
    if (HOST_SENDS_BOTH) [DelayIs(hostDelay), StartsAt(start)] else [StartsAt(start)]

  // The host and a guest start together. The guest holds for the host.
  action startTogether = all {
    not(started),
    started' = true, alone' = false, hostDelay' = MATCH_DELAY,
    delaySent' = false, hostRunning' = false, hostArmed' = false, hostStart' = -1, hostFrame' = 0,
    guest' = Waiting, guestFrame' = 0, heardDelay' = -1, heardStart' = -1,
    armDelay' = -1, armFrame' = -1, waited' = 0,
    open' = open, toGuest' = toGuest, historySame,
  }

  // The host starts without the guest: alone in the room at a delay of 0,
  // or with other players at the delay it negotiated with them.
  action startWithout(d: int): bool = all {
    not(started),
    started' = true, alone' = true, hostDelay' = d,
    delaySent' = true, hostRunning' = false, hostArmed' = false, hostStart' = -1, hostFrame' = 0,
    guestSame, open' = open, toGuest' = toGuest, historySame,
  }

  // "GO": the host tells the guest the delay (rb-delay:).
  action hostGo = all {
    started, not(alone), not(delaySent),
    delaySent' = true,
    toGuest' = if (open) toGuest.append(DelayIs(hostDelay)) else toGuest,
    started' = started, alone' = alone, hostDelay' = hostDelay, hostRunning' = hostRunning,
    hostArmed' = hostArmed, hostStart' = hostStart, hostFrame' = hostFrame,
    guestSame, open' = open, historySame,
  }

  // startLockstep: the host arms (or, before, runs unarmed at a delay of 0)
  // and tells the guest its start frame.
  action hostStarts = all {
    started, delaySent, not(hostRunning),
    hostRunning' = true,
    hostArmed' = canArm(hostDelay),
    hostStart' = if (canArm(hostDelay)) hostFrame else -1,
    toGuest' = if (open and not(alone) and canArm(hostDelay)) toGuest.concat(onArm(hostFrame)) else toGuest,
    started' = started, alone' = alone, hostDelay' = hostDelay, delaySent' = delaySent, hostFrame' = hostFrame,
    guestSame, open' = open, historySame,
  }

  action hostStep = all {
    hostRunning, hostFrame < MAX_FRAME,
    hostFrame' = hostFrame + 1,
    ranUnarmed' = (ranUnarmed or not(hostArmed)),
    started' = started, alone' = alone, hostDelay' = hostDelay, delaySent' = delaySent,
    hostRunning' = hostRunning, hostArmed' = hostArmed, hostStart' = hostStart,
    guestSame, open' = open, toGuest' = toGuest, stoppedReachable' = stoppedReachable,
  }

  // The guest joins the match late: a friend joining a solo match, or a
  // player the host left out of the start. The host's state tells it the
  // frame and the delay; it starts where the state is.
  action lateJoin = all {
    alone, hostRunning, guest == NotIn,
    guest' = if (canArm(hostDelay)) Armed else RunsUnarmed,
    guestFrame' = hostFrame, heardDelay' = hostDelay, heardStart' = hostFrame,
    armDelay' = if (canArm(hostDelay)) hostDelay else -1,
    armFrame' = if (canArm(hostDelay)) hostFrame else -1,
    waited' = 0,
    hostSame, open' = open, toGuest' = toGuest, historySame,
  }

  // A guest arms once it has the delay and the start frame. Before, a delay
  // of 0 was not taken as heard (`_rbHostDelay > 0`).
  def armsOn(d: int, s: int): bool = d >= 0 and s >= 0 and canArm(d)

  action deliver = all {
    open, toGuest.length() > 0, guest != NotIn,
    val m = toGuest.head()
    val d = match m { | DelayIs(x) => x | StartsAt(_) => heardDelay }
    val s = match m { | DelayIs(_) => heardStart | StartsAt(x) => x }
    all {
      toGuest' = toGuest.tail(),
      heardDelay' = d, heardStart' = s,
      // Waiting, with both: arm where it is, with the host's delay.
      guest' = if (guest == Waiting and armsOn(d, s)) Armed else guest,
      armDelay' = if (guest == Waiting and armsOn(d, s)) d else armDelay,
      armFrame' = if (guest == Waiting and armsOn(d, s)) guestFrame else armFrame,
      guestFrame' = guestFrame, waited' = waited,
      hostSame, open' = open, historySame,
    },
  }

  action channelCloses = all {
    open,
    open' = false, toGuest' = [],
    hostSame, guestSame, historySame,
  }

  action channelOpens = all {
    not(open),
    open' = true,
    toGuest' = if (HOST_SENDS_BOTH and hostArmed and not(alone)) onArm(hostStart) else [],
    hostSame, guestSame, historySame,
  }

  // The guest's wait: its clock moves only once nothing is in flight to it.
  action tick = all {
    guest == Waiting, waited < DEADLINE, not(open) or toGuest.length() == 0,
    waited' = waited + 1,
    guest' = guest, guestFrame' = guestFrame, heardDelay' = heardDelay, heardStart' = heardStart,
    armDelay' = armDelay, armFrame' = armFrame,
    hostSame, open' = open, toGuest' = toGuest, historySame,
  }

  // RB-INIT-TIMEOUT.
  action deadline = all {
    guest == Waiting, waited == DEADLINE, not(open) or toGuest.length() == 0,
    guest' = if (STOP_AT_THE_DEADLINE and heardDelay < 0) Stopped else Armed,
    armDelay' = if (STOP_AT_THE_DEADLINE and heardDelay < 0) armDelay else if (heardDelay >= 0) heardDelay else OWN_DELAY,
    armFrame' = if (STOP_AT_THE_DEADLINE and heardDelay < 0) armFrame else guestFrame,
    stoppedReachable' = (stoppedReachable or (STOP_AT_THE_DEADLINE and heardDelay < 0 and open and hostArmed)),
    guestFrame' = guestFrame, heardDelay' = heardDelay, heardStart' = heardStart, waited' = waited,
    hostSame, open' = open, toGuest' = toGuest, ranUnarmed' = ranUnarmed,
  }

  action guestStep = all {
    guest == Armed or guest == RunsUnarmed, guestFrame < MAX_FRAME,
    guestFrame' = guestFrame + 1,
    ranUnarmed' = (ranUnarmed or guest == RunsUnarmed),
    guest' = guest, heardDelay' = heardDelay, heardStart' = heardStart,
    armDelay' = armDelay, armFrame' = armFrame, waited' = waited,
    hostSame, open' = open, toGuest' = toGuest, stoppedReachable' = stoppedReachable,
  }

  action startAlone = startWithout(SOLO_DELAY)

  action step = any {
    startTogether, nondet d = oneOf(Set(SOLO_DELAY, MATCH_DELAY)) startWithout(d), hostGo, hostStarts, hostStep, lateJoin,
    deliver, channelCloses, channelOpens, tick, deadline, guestStep,
  }

  // ── properties ─────────────────────────────────────────────────────────

  // Every frame of a match runs on the C engine. Violated before: a solo
  // match, and a friend who joined it, ran on the old JS lockstep path.
  val everyFrameRunsOnTheCEngine = not(ranUnarmed)

  // A guest arms with the host's delay. Violated before: a guest that lost
  // `rb-delay:` armed at the deadline with its own.
  val armsWithTheHostsDelay = guest == Armed implies armDelay == hostDelay

  // A guest arms where it is, on the frame the host gave it. Holds before
  // too: no page runs a frame before it arms, and a late joiner is given the
  // frame of the state it loads, so the start frame it is told is always its
  // own. That is why RB-INIT-CATCHUP (step to a later one on the old path)
  // and the overshoot (arm at a frame other than the host's) can go.
  val theHostsStartIsWhereTheGuestIs =
    (guest == Waiting and heardStart >= 0) implies heardStart == guestFrame
  val armsOnTheHostsFrame = guest == Armed implies (armFrame == heardStart or heardStart < 0)

  // A guest stops only when it cannot reach the armed host. Violated when
  // the host sends each message once: a channel that closes and opens again
  // has lost them for good.
  val aGuestStopsOnlyWhenTheHostIsUnreachable = not(stoppedReachable)

  val allHold = and {
    everyFrameRunsOnTheCEngine, armsWithTheHostsDelay, theHostsStartIsWhereTheGuestIs,
    armsOnTheHostsFrame, aGuestStopsOnlyWhenTheHostIsUnreachable,
  }

  // ── scenarios ──────────────────────────────────────────────────────────

  run startsTogetherTest =
    init.then(startTogether).then(hostGo).then(hostStarts)
      .then(deliverIfAny).then(deliverIfAny).then(deliverIfAny)
      .expect(guest == Armed and armDelay == MATCH_DELAY and armFrame == 0)

  // Alone in the room: before, the old path; now the C engine at delay 0.
  run soloTest =
    init.then(startAlone).then(hostStarts).then(hostStep)
      .expect(ranUnarmed == not(ARM_AT_ZERO_DELAY))
      .expect(hostArmed == ARM_AT_ZERO_DELAY)

  // A friend joins the solo match late and plays on the delay it runs at.
  run lateJoinIntoSoloTest =
    init.then(startAlone).then(hostStarts).then(hostStep).then(lateJoin).then(guestStep)
      .expect(guest == (if (ARM_AT_ZERO_DELAY) Armed else RunsUnarmed))
      .expect(ARM_AT_ZERO_DELAY implies (armDelay == SOLO_DELAY and armFrame == 1))

  action unchangedAll = all { hostSame, guestSame, open' = open, toGuest' = toGuest, historySame }
  action deliverIfAny = if (open and toGuest.length() > 0 and guest != NotIn) deliver else unchangedAll
  action tickIfWaiting = if (guest == Waiting and waited < DEADLINE) tick else unchangedAll
  action deadlineIfDue =
    if (guest == Waiting and waited == DEADLINE and (not(open) or toGuest.length() == 0)) deadline else unchangedAll

  // A player the host left out of the start joins late: it arms with the
  // delay the match runs at, at the frame of the host's state, as before.
  run leftOutJoinsLateTest =
    init.then(startWithout(MATCH_DELAY)).then(hostStarts).then(hostStep).then(hostStep).then(lateJoin)
      .expect(guest == Armed and armDelay == MATCH_DELAY and armFrame == 2 and hostArmed)

  // `rb-delay:` is lost to a channel that closes before the host arms, and
  // the channel opens again. Before: the guest hears only the start frame
  // and at the deadline arms with its own delay. Stopping alone: it stops,
  // though the host is there. Now: the host sends the delay again with its
  // start frame, and the guest arms with it.
  run lostDelayTest =
    init.then(startTogether).then(hostGo).then(channelCloses).then(channelOpens)
      .then(hostStarts).then(deliverIfAny).then(deliverIfAny)
      .then(tickIfWaiting).then(tickIfWaiting).then(tickIfWaiting).then(deadlineIfDue)
      .expect(
        if (HOST_SENDS_BOTH) guest == Armed and armDelay == MATCH_DELAY
        else if (STOP_AT_THE_DEADLINE) guest == Stopped and stoppedReachable
        else guest == Armed and armDelay == OWN_DELAY
      )

  // Both messages are lost to a close after the host armed; the channel opens again.
  run reopenAfterArmTest =
    init.then(startTogether).then(hostGo).then(hostStarts).then(channelCloses).then(channelOpens)
      .expect(if (HOST_SENDS_BOTH) toGuest.length() == 2 else toGuest.length() == 0)

  // The channel opens again just as the wait runs out, with the host armed.
  // When the host sends both on every open, the guest takes them in before
  // the deadline is checked and arms; before, nothing came and it armed with
  // its own delay; stopping alone, it stops though the host is there.
  run opensAsTheWaitRunsOutTest =
    init.then(startTogether).then(channelCloses).then(hostGo).then(hostStarts)
      .then(tick).then(tick).then(tick).then(channelOpens)
      .then(deliverIfAny).then(deliverIfAny).then(deadlineIfDue)
      .expect(
        if (HOST_SENDS_BOTH) guest == Armed and armDelay == MATCH_DELAY
        else if (STOP_AT_THE_DEADLINE) guest == Stopped and stoppedReachable
        else guest == Armed and armDelay == OWN_DELAY
      )

  // The host arms only after the guest's wait has run out: the guest stops,
  // and the host was not yet there to reach.
  run hostArmsLateTest =
    init.then(startTogether).then(tick).then(tick).then(tick).then(deadline)
      .then(hostGo).then(hostStarts)
      .expect(if (STOP_AT_THE_DEADLINE) guest == Stopped and not(stoppedReachable) else guest == Armed)

  // The delay arrives and the channel closes before the start frame does:
  // at the deadline the guest arms with the host's delay at its own frame,
  // which is the host's start.
  run lostStartFrameTest =
    init.then(startTogether).then(hostGo).then(deliver).then(channelCloses).then(hostStarts)
      .then(tick).then(tick).then(tick).then(deadline)
      .expect(guest == Armed and armDelay == MATCH_DELAY and armFrame == hostStart)

  // The channel never comes back: the guest's wait ends at the deadline.
  run hostUnreachableTest =
    init.then(startTogether).then(channelCloses).then(hostGo).then(hostStarts)
      .then(tick).then(tick).then(tick).then(deadline)
      .expect(if (STOP_AT_THE_DEADLINE) guest == Stopped else guest == Armed)
      .expect(not(stoppedReachable))
}

// Before: a delay of 0 ran on the old JS lockstep path, the host sent each
// message once, and a guest that heard nothing by the deadline armed anyway.
module engine_start_before {
  import engine_start(
    ARM_AT_ZERO_DELAY = false, HOST_SENDS_BOTH = false, STOP_AT_THE_DEADLINE = false
  ).*
}

// Stopping at the deadline alone: a guest whose channel closed and opened
// again stops though the host is there, because nothing is sent again.
module engine_start_stop_only {
  import engine_start(
    ARM_AT_ZERO_DELAY = true, HOST_SENDS_BOTH = false, STOP_AT_THE_DEADLINE = true
  ).*
}

// Today: every page arms, at a delay of 0 too; the armed host sends the
// delay and its start frame together, when it arms and on every channel that
// opens; a guest that has heard nothing by the deadline stops and says so.
module engine_start_current {
  import engine_start(
    ARM_AT_ZERO_DELAY = true, HOST_SENDS_BOTH = true, STOP_AT_THE_DEADLINE = true
  ).*
}
