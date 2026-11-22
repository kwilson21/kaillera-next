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
//     path (RB-INIT-CATCHUP) or armed where it was. Only one thing made the
//     two differ: a tab that came back to the front while its page waited
//     to arm moved the page's frame forward to the last remote frame it had
//     seen (the lifecycle return's fast-forward, meant for the old path). No
//     page runs a frame before it arms, and a late joiner is told the frame
//     of the state it loads; with that jump gone the host's start is always
//     the guest's own (`theHostsStartIsWhereTheGuestIs`), so those branches
//     are dead and go.
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
// WAIT_KEEPS_FRAME: a page waiting to arm keeps its frame when its tab
//   comes back to the front. false = before: the lifecycle return moved it
//   forward to the last remote frame it had seen and asked for a full
//   resync, as for the old path. On the new rule the guest is then told a
//   start frame other than its own, and stops (START-FAIL start-frame).
// REARM_AT_JOIN: a match that runs at a delay of 0 (the host alone) moves
//   to a match delay when its first player joins: during the late-join
//   pause, at the frame H of the state it sends, the host arms its C engine
//   again with the delay the join negotiates (from the RTT both pages
//   measured on their new channel), its own inputs for H..H+delay-1 are
//   neutral (it made none for them), and the joiner arms with the same delay
//   at H. false = the friend plays at 0 for the rest of the match: every
//   input of the other page arrives late and is rolled back.
// BRIDGE_AT_ZERO_DELAY: the late join's input bridge (#286) has a window at
//   a delay of 0 too: the host lists itself as the source of the inputs
//   around the state's frame, and the joiner waits for them (with that wait's
//   own deadline) as it does at any delay. false = the bridge's window was
//   defined only for a delay of 1 or more: at 0 the host sent no source, and
//   a joiner with no source to wait for failed its input wait at once
//   (LATE-JOIN-INPUT-FAILED) and left the match, though the host had just
//   sent it the state. Only a page that arms at 0 meets it: a friend joining
//   a solo match.
//
// The deadline is checked in the tick loop, after the page has taken in what
// arrived, so it too waits for nothing to be in flight. A host that arms
// only after a guest's deadline has passed leaves that guest stopped: the
// deadline must be well past the time between two pages' starts.
module engine_start {
  const ARM_AT_ZERO_DELAY: bool
  const HOST_SENDS_BOTH: bool
  const STOP_AT_THE_DEADLINE: bool
  const WAIT_KEEPS_FRAME: bool
  const REARM_AT_JOIN: bool
  const BRIDGE_AT_ZERO_DELAY: bool

  pure val MATCH_DELAY = 2 // the delay the host negotiates with a guest in
  pure val OWN_DELAY = 3   // what the guest worked out for itself
  pure val SOLO_DELAY = 0  // alone in the room (SOLO_FRAME_DELAY)
  pure val DEADLINE = 3
  pure val MAX_FRAME = 3

  // A message from the host: its delay (rb-delay:) or its start frame
  // (rb-init-frame:). A record, not a variant: `deliver` reads the head of the
  // queue, which Apalache evaluates even where the queue is empty, and it
  // cannot match a variant on that head ("non-existing variant option").
  type Msg = { isDelay: bool, n: int }
  pure def delayIs(n: int): Msg = { isDelay: true, n: n }
  pure def startsAt(n: int): Msg = { isDelay: false, n: n }
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
  var firstGuestInput: int   // the frame of the guest's first input, -1 before it has made one
  var stoppedReachable: bool // history: a guest stopped while the armed host's channel was open

  // ── actions ────────────────────────────────────────────────────────────

  action init = all {
    started' = false, alone' = false, hostDelay' = 0, delaySent' = false,
    hostRunning' = false, hostArmed' = false, hostStart' = -1, hostFrame' = 0,
    guest' = NotIn, guestFrame' = 0, heardDelay' = -1, heardStart' = -1,
    armDelay' = -1, armFrame' = -1, waited' = 0,
    open' = true, toGuest' = [],
    ranUnarmed' = false, stoppedReachable' = false, firstGuestInput' = -1,
  }

  action hostSame = all {
    started' = started, alone' = alone, hostDelay' = hostDelay, delaySent' = delaySent,
    hostRunning' = hostRunning, hostArmed' = hostArmed, hostStart' = hostStart, hostFrame' = hostFrame,
  }
  action guestSame = all {
    guest' = guest, guestFrame' = guestFrame, heardDelay' = heardDelay, heardStart' = heardStart,
    armDelay' = armDelay, armFrame' = armFrame, waited' = waited,
  }
  action historySame = all { ranUnarmed' = ranUnarmed, stoppedReachable' = stoppedReachable, firstGuestInput' = firstGuestInput }

  pure def canArm(delay: int): bool = delay > 0 or ARM_AT_ZERO_DELAY

  // What the host sends when it arms, or when a channel opens while armed.
  def onArm(start: int): List[Msg] =
    if (HOST_SENDS_BOTH) [delayIs(hostDelay), startsAt(start)] else [startsAt(start)]

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
    toGuest' = if (open) toGuest.append(delayIs(hostDelay)) else toGuest,
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
    firstGuestInput' = firstGuestInput,
  }

  // The guest joins the match late: a friend joining a solo match, or a
  // player the host left out of the start. The host's state tells it the
  // frame and the delay; it starts where the state is.
  // A joiner that arms at a delay its input bridge has no window for finds
  // no source to wait for and stops at once, though the host has just sent
  // it the state.
  action lateJoin = all {
    alone, hostRunning, guest == NotIn,
    val armed = canArm(hostDelay)
    // The first player into a match at 0: the host arms again at H with the
    // joined delay, and the joiner arms with it.
    val rearm = armed and hostDelay == SOLO_DELAY and REARM_AT_JOIN
    val delay = if (rearm) MATCH_DELAY else hostDelay
    val bridgeFails = armed and delay == 0 and not(BRIDGE_AT_ZERO_DELAY)
    all {
      guest' = if (bridgeFails) Stopped else if (armed) Armed else RunsUnarmed,
      guestFrame' = hostFrame, heardDelay' = delay, heardStart' = hostFrame,
      armDelay' = if (armed and not(bridgeFails)) delay else -1,
      armFrame' = if (armed and not(bridgeFails)) hostFrame else -1,
      waited' = 0,
      started' = started, alone' = alone, delaySent' = delaySent, hostRunning' = hostRunning,
      hostArmed' = hostArmed, hostFrame' = hostFrame,
      hostDelay' = delay,
      hostStart' = if (rearm) hostFrame else hostStart,
      open' = open, toGuest' = toGuest,
      ranUnarmed' = ranUnarmed, firstGuestInput' = firstGuestInput,
      stoppedReachable' = (stoppedReachable or (bridgeFails and hostArmed)),
    },
  }

  // A guest arms once it has the delay and the start frame. Before, a delay
  // of 0 was not taken as heard (`_rbHostDelay > 0`).
  def armsOn(d: int, s: int): bool = d >= 0 and s >= 0 and canArm(d)

  action deliver = all {
    open, toGuest.length() > 0, guest != NotIn,
    val m = toGuest.head()
    val d = if (m.isDelay) m.n else heardDelay
    val s = if (m.isDelay) heardStart else m.n
    // Told a start frame other than its own: the rule stops it (stopFrame);
    // before, it armed where it was once it had the delay (the overshoot).
    val otherFrame = guest == Waiting and s >= 0 and s != guestFrame
    val stops = otherFrame and STOP_AT_THE_DEADLINE
    val arms = guest == Waiting and armsOn(d, s) and not(stops)
    all {
      toGuest' = toGuest.tail(),
      heardDelay' = d, heardStart' = s,
      // Waiting, with both: arm where it is, with the host's delay.
      guest' = if (stops) Stopped else if (arms) Armed else guest,
      armDelay' = if (arms) d else armDelay,
      armFrame' = if (arms) guestFrame else armFrame,
      guestFrame' = guestFrame, waited' = waited,
      hostSame, open' = open,
      ranUnarmed' = ranUnarmed, firstGuestInput' = firstGuestInput,
      stoppedReachable' = (stoppedReachable or (stops and hostArmed)),
    },
  }

  // The guest's tab comes back to the front while it waits to arm. Before,
  // the lifecycle return moved its frame to the last remote frame it had
  // seen (the host's, which runs).
  action tabReturns = all {
    guest == Waiting, hostRunning,
    guestFrame' = if (WAIT_KEEPS_FRAME) guestFrame else hostFrame,
    guest' = guest, heardDelay' = heardDelay, heardStart' = heardStart,
    armDelay' = armDelay, armFrame' = armFrame, waited' = waited,
    hostSame, open' = open, toGuest' = toGuest, historySame,
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
    hostSame, open' = open, toGuest' = toGuest, ranUnarmed' = ranUnarmed, firstGuestInput' = firstGuestInput,
  }

  // Each frame the guest makes an input for frame + its delay; a rollback on
  // the host reaches back at most to the frame of the guest's first input.
  action guestStep = all {
    guest == Armed or guest == RunsUnarmed, guestFrame < MAX_FRAME,
    guestFrame' = guestFrame + 1,
    ranUnarmed' = (ranUnarmed or guest == RunsUnarmed),
    firstGuestInput' = if (firstGuestInput < 0 and guest == Armed) guestFrame + armDelay else firstGuestInput,
    guest' = guest, heardDelay' = heardDelay, heardStart' = heardStart,
    armDelay' = armDelay, armFrame' = armFrame, waited' = waited,
    hostSame, open' = open, toGuest' = toGuest, stoppedReachable' = stoppedReachable,
  }

  action startAlone = startWithout(SOLO_DELAY)

  action step = any {
    startTogether, nondet d = oneOf(Set(SOLO_DELAY, MATCH_DELAY)) startWithout(d), hostGo, hostStarts, hostStep, lateJoin,
    deliver, channelCloses, channelOpens, tick, deadline, guestStep, tabReturns,
  }

  // ── properties ─────────────────────────────────────────────────────────

  // Every frame of a match runs on the C engine. Violated before: a solo
  // match, and a friend who joined it, ran on the old JS lockstep path.
  val everyFrameRunsOnTheCEngine = not(ranUnarmed)

  // A guest arms with the host's delay. Violated before: a guest that lost
  // `rb-delay:` armed at the deadline with its own.
  val armsWithTheHostsDelay = guest == Armed implies armDelay == hostDelay

  // A guest arms where it is, on the frame the host gave it. No page runs a
  // frame before it arms, and a late joiner is given the frame of the state
  // it loads, so the start frame it is told is its own, unless its tab came
  // back while it waited and the lifecycle return moved its frame (violated
  // before and in engine_start_jump_on_return; tabReturnWhileWaitingTest).
  // With that gone, RB-INIT-CATCHUP (step to a later one on the old path)
  // and the overshoot (arm at a frame other than the host's) are dead.
  val theHostsStartIsWhereTheGuestIs =
    (guest == Waiting and heardStart >= 0) implies heardStart == guestFrame
  val armsOnTheHostsFrame = guest == Armed implies (armFrame == heardStart or heardStart < 0)

  // A guest stops only when it cannot reach the armed host. Violated when
  // the host sends each message once: a channel that closes and opens again
  // has lost them for good. Violated too when the late join's input bridge
  // has no window at a delay of 0: a friend joining a solo match stops as it
  // arrives (engine_start_no_zero_bridge; lateJoinIntoSoloTest).
  val aGuestStopsOnlyWhenTheHostIsUnreachable = not(stoppedReachable)

  // A match a friend joined runs at a match delay, not 0. Violated without
  // the re-arm: the friend plays at 0, and every input the other page makes
  // arrives late and is rolled back (engine_start_no_rearm).
  val aJoinedMatchRunsAboveZero = guest == Armed implies (armDelay > 0 and hostDelay > 0)

  // After the re-arm, no rollback on the host reaches back before the frame
  // it armed at again: the joiner's slot was inactive before H, and its first
  // input is for H + delay.
  val noRollbackBeforeTheRearm = firstGuestInput < 0 or firstGuestInput >= hostStart

  val allHold = and {
    everyFrameRunsOnTheCEngine, armsWithTheHostsDelay, theHostsStartIsWhereTheGuestIs,
    armsOnTheHostsFrame, aGuestStopsOnlyWhenTheHostIsUnreachable, aJoinedMatchRunsAboveZero,
    noRollbackBeforeTheRearm,
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

  // The guest's tab comes back while it waits, after the host has run a
  // frame; then the host's start frame arrives. Before: its frame had jumped
  // to the host's, and it armed there (the overshoot), on a frame other than
  // the host's start. Jumping with the new rule: it stops though the host is
  // there. Now: it keeps its frame and arms on the host's start.
  run tabReturnWhileWaitingTest =
    init.then(startTogether).then(hostGo).then(deliverIfAny).then(channelCloses)
      .then(hostStarts).then(hostStep).then(tabReturns).then(channelOpens).then(deliverIfAny).then(deliverIfAny)
      .expect(
        if (not(HOST_SENDS_BOTH)) guest == Waiting and guestFrame == (if (WAIT_KEEPS_FRAME) 0 else 1)
        else if (WAIT_KEEPS_FRAME) guest == Armed and armFrame == hostStart
        else guest == Stopped and stoppedReachable
      )

  // A friend joins the solo match late and plays on the delay it runs at.
  // Without a bridge window at 0, it stops as it arrives.
  // With the re-arm, both pages move to the match delay at the join frame.
  run lateJoinIntoSoloTest =
    init.then(startAlone).then(hostStarts).then(hostStep).then(lateJoin).then(guestStepIfRunning)
      .expect(
        guest == (
          if (not(ARM_AT_ZERO_DELAY)) RunsUnarmed
          else if (REARM_AT_JOIN or BRIDGE_AT_ZERO_DELAY) Armed
          else Stopped
        )
      )
      .expect(
        (ARM_AT_ZERO_DELAY and REARM_AT_JOIN) implies
          (armDelay == MATCH_DELAY and hostDelay == MATCH_DELAY and armFrame == 1 and hostStart == 1)
      )
      .expect(
        (ARM_AT_ZERO_DELAY and not(REARM_AT_JOIN) and BRIDGE_AT_ZERO_DELAY) implies
          (armDelay == SOLO_DELAY and armFrame == 1)
      )
      .expect(stoppedReachable == (ARM_AT_ZERO_DELAY and not(REARM_AT_JOIN) and not(BRIDGE_AT_ZERO_DELAY)))
      .expect(ARM_AT_ZERO_DELAY implies firstGuestInput == (if (REARM_AT_JOIN) 1 + MATCH_DELAY else if (BRIDGE_AT_ZERO_DELAY) 1 else -1))

  action unchangedAll = all { hostSame, guestSame, open' = open, toGuest' = toGuest, historySame }
  action deliverIfAny = if (open and toGuest.length() > 0 and guest != NotIn) deliver else unchangedAll
  action tickIfWaiting = if (guest == Waiting and waited < DEADLINE) tick else unchangedAll
  action guestStepIfRunning =
    if ((guest == Armed or guest == RunsUnarmed) and guestFrame < MAX_FRAME) guestStep else unchangedAll
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
    ARM_AT_ZERO_DELAY = false, HOST_SENDS_BOTH = false, STOP_AT_THE_DEADLINE = false, WAIT_KEEPS_FRAME = false,
    REARM_AT_JOIN = false, BRIDGE_AT_ZERO_DELAY = false
  ).*
}

// Stopping at the deadline alone: a guest whose channel closed and opened
// again stops though the host is there, because nothing is sent again.
module engine_start_stop_only {
  import engine_start(
    ARM_AT_ZERO_DELAY = true, HOST_SENDS_BOTH = false, STOP_AT_THE_DEADLINE = true, WAIT_KEEPS_FRAME = true,
    REARM_AT_JOIN = true, BRIDGE_AT_ZERO_DELAY = true
  ).*
}

// The new rule with the lifecycle return still moving a waiting page's
// frame: a guest whose tab came back while it waited stops on the host's
// start frame, though the host is there.
module engine_start_jump_on_return {
  import engine_start(
    ARM_AT_ZERO_DELAY = true, HOST_SENDS_BOTH = true, STOP_AT_THE_DEADLINE = true, WAIT_KEEPS_FRAME = false,
    REARM_AT_JOIN = true, BRIDGE_AT_ZERO_DELAY = true
  ).*
}

// Arming at 0, a friend who joins a solo match joins at 0, and the late
// join's input bridge was defined only for a delay of 1 or more (#286): it
// has no source to wait for, fails its input wait at once and leaves, though
// the host is there.
module engine_start_no_zero_bridge {
  import engine_start(
    ARM_AT_ZERO_DELAY = true, HOST_SENDS_BOTH = true, STOP_AT_THE_DEADLINE = true, WAIT_KEEPS_FRAME = true,
    REARM_AT_JOIN = false, BRIDGE_AT_ZERO_DELAY = false
  ).*
}

// Arming at 0 with the bridge's window at 0 but no re-arm: a friend who joins
// a solo match plays at 0 for the rest of it.
module engine_start_no_rearm {
  import engine_start(
    ARM_AT_ZERO_DELAY = true, HOST_SENDS_BOTH = true, STOP_AT_THE_DEADLINE = true, WAIT_KEEPS_FRAME = true,
    REARM_AT_JOIN = false, BRIDGE_AT_ZERO_DELAY = true
  ).*
}

// Today: every page arms, at a delay of 0 too; the armed host sends the
// delay and its start frame together, when it arms and on every channel that
// opens; a guest that has heard nothing by the deadline stops and says so; a
// waiting page keeps its frame when its tab comes back; the first player into
// a match at 0 moves it to a match delay at the join frame.
module engine_start_current {
  import engine_start(
    ARM_AT_ZERO_DELAY = true, HOST_SENDS_BOTH = true, STOP_AT_THE_DEADLINE = true, WAIT_KEEPS_FRAME = true,
    REARM_AT_JOIN = true, BRIDGE_AT_ZERO_DELAY = true
  ).*
}
