// -*- mode: Bluespec; -*-
//
// A resync from request to apply: the guest asking the host for its state,
// the host scheduling and sending it, and the guest holding it until the
// agreed frame (the `sync-request*` handler, _dispatchScheduledSyncs and the
// coordinated-injection block of tick() in web/static/netplay-rollback.js).
//
// The guest asks in one of two ways:
//   - "at frame T" (a desync was detected, or a dropped peer came back): T is
//     a few frames ahead; the host captures at T and the guest stops at T
//     until the state arrives, so the state lands on the frame it is for;
//   - "now" (reconnect, network change).
// While a request is out the guest sends no other (_resyncRequestInFlight).
// The host answers at most one request per guest every 5 s and drops the
// rest without a word (_SYNC_REQUEST_COOLDOWN_MS). The guest's own gap
// between requests can be as short as 400 ms.
//
// What is modelled: one guest and the host, their frame counters, the
// request and state channels (each in order), the host's rate limit, its
// scheduled capture with a deadline and one follow-up, the guest's target
// frame with its deadline, the hold, the stall at the target, and the stale
// state check.
//
// Not modelled: what the state contains, deltas, chunks and their timeout,
// proactive pushes, more than one guest, the inputs around the apply
// (specs/resync_inputs.qnt), a replay delaying the apply, and the 15 s guard
// the request sent when a hidden tab is shown again already has (the
// requests after a desync, a dropped peer's return, a reconnect and a
// network change have none).
//
// REQUEST_HAS_DEADLINE: a request that is out has a deadline of its own,
//   after which the guest may ask again. false = today: only an arriving
//   state ends it.
module resync_flow {
  const REQUEST_HAS_DEADLINE: bool

  pure val DELTA = 2        // how far ahead the guest sets its target
  pure val HOLD = 1         // a state this far ahead is held, not applied early
  pure val FOLLOW_UPS = 1   // syncs the host sends again after an unconfirmed one
  pure val LAST_FRAME = 8
  pure val NONE = -1
  pure val NOW = -1         // a request with no target frame

  type Pending = { frame: int, held: bool }
  type Scheduled = { target: int, followUp: int }

  var guestFrame: int
  var hostFrame: int
  // guest
  var target: int            // stop here until the state arrives; NONE = no target
  var targetDeadline: bool
  var asked: bool            // a request is out
  var askDeadline: bool
  var stalled: bool          // stopped at the target, waiting for the state
  var pending: Pending       // a state received and not yet applied; frame NONE = none
  var lastApplied: int
  var appliedOlder: bool     // history: applied a state no newer than the last
  // host
  var scheduled: Scheduled   // a capture owed to the guest; target NONE = none
  var cooling: bool          // answered this guest less than 5 s ago
  // channels
  var requests: List[int]
  var states: List[int]

  pure val noPending: Pending = { frame: NONE, held: false }
  pure val noSchedule: Scheduled = { target: NONE, followUp: 0 }

  action init = all {
    guestFrame' = 0, hostFrame' = 0,
    target' = NONE, targetDeadline' = false, asked' = false, askDeadline' = false,
    stalled' = false, pending' = noPending, lastApplied' = NONE, appliedOlder' = false,
    scheduled' = noSchedule, cooling' = false,
    requests' = [], states' = [],
  }

  action framesUnchanged = all { guestFrame' = guestFrame, hostFrame' = hostFrame }
  action hostUnchanged = all { scheduled' = scheduled, cooling' = cooling }
  action guestUnchanged = all {
    target' = target, targetDeadline' = targetDeadline, asked' = asked, askDeadline' = askDeadline,
    stalled' = stalled, pending' = pending, lastApplied' = lastApplied, appliedOlder' = appliedOlder,
  }

  // ── the guest asks ─────────────────────────────────────────────────────

  // A desync was detected: ask for the state at a frame a little ahead.
  action guestAsksAt = all {
    not(asked),
    guestFrame + DELTA <= LAST_FRAME,
    asked' = true, askDeadline' = REQUEST_HAS_DEADLINE,
    target' = guestFrame + DELTA, targetDeadline' = true,
    requests' = requests.append(guestFrame + DELTA),
    stalled' = stalled, pending' = pending, lastApplied' = lastApplied, appliedOlder' = appliedOlder,
    framesUnchanged, hostUnchanged, states' = states,
  }

  // Reconnect or network change: ask for it now. This one
  // goes out even when a request is already out.
  action guestAsksNow = all {
    asked' = true, askDeadline' = REQUEST_HAS_DEADLINE,
    target' = NONE, targetDeadline' = false, stalled' = false,
    requests' = requests.append(NOW),
    pending' = pending, lastApplied' = lastApplied, appliedOlder' = appliedOlder,
    framesUnchanged, hostUnchanged, states' = states,
  }

  // ── the host ───────────────────────────────────────────────────────────

  action hostHearsRequest = {
    val t = requests.head()
    all {
      requests.length() > 0,
      requests' = requests.tail(),
      if (cooling) all {
        // Rate limited: dropped, and the guest is not told.
        scheduled' = scheduled, cooling' = cooling, states' = states,
      } else if (t > hostFrame) all {
        scheduled' = { target: t, followUp: 0 }, cooling' = true, states' = states,
      } else all {
        scheduled' = scheduled, cooling' = true, states' = states.append(hostFrame),
      },
      framesUnchanged, guestUnchanged,
    }
  }

  action cooldownEnds = all {
    cooling, cooling' = false,
    scheduled' = scheduled, framesUnchanged, guestUnchanged, requests' = requests, states' = states,
  }

  // The host's own reason to send: a guest it had dropped is back.
  action hostOwesASync = all {
    scheduled' = { target: hostFrame, followUp: 0 },
    cooling' = cooling, framesUnchanged, guestUnchanged, requests' = requests, states' = states,
  }

  // The target frame is reached and the state there is final: send it.
  action hostSendsConfirmed = all {
    scheduled.target != NONE,
    scheduled.target <= hostFrame,
    states' = states.append(hostFrame),
    scheduled' = noSchedule,
    cooling' = cooling, framesUnchanged, guestUnchanged, requests' = requests,
  }

  // The capture's 3 s deadline: send what there is, and once more later if
  // a follow-up is left (what went out may still change here).
  action hostDeadline = all {
    scheduled.target != NONE,
    states' = states.append(hostFrame),
    scheduled' = if (scheduled.followUp < FOLLOW_UPS) { target: hostFrame, followUp: scheduled.followUp + 1 }
      else noSchedule,
    cooling' = cooling, framesUnchanged, guestUnchanged, requests' = requests,
  }

  action hostTick = all {
    hostFrame < LAST_FRAME,
    hostFrame' = hostFrame + 1,
    guestFrame' = guestFrame, hostUnchanged, guestUnchanged, requests' = requests, states' = states,
  }

  // ── the guest's tick ───────────────────────────────────────────────────

  action apply = all {
    guestFrame' = pending.frame,
    lastApplied' = pending.frame,
    appliedOlder' = (appliedOlder or pending.frame <= lastApplied),
    pending' = noPending, target' = NONE, targetDeadline' = false, stalled' = false,
    asked' = asked, askDeadline' = askDeadline,
  }

  action advance = all {
    guestFrame < LAST_FRAME,
    guestFrame' = guestFrame + 1,
    target' = target, targetDeadline' = targetDeadline, stalled' = stalled, pending' = pending,
    lastApplied' = lastApplied, appliedOlder' = appliedOlder, asked' = asked, askDeadline' = askDeadline,
  }

  action hold = all {
    target' = pending.frame, targetDeadline' = true, stalled' = false,
    pending' = { ...pending, held: true },
    guestFrame' = guestFrame, lastApplied' = lastApplied, appliedOlder' = appliedOlder,
    asked' = asked, askDeadline' = askDeadline,
  }

  action stall = all {
    not(stalled),
    stalled' = true,
    guestFrame' = guestFrame, target' = target, targetDeadline' = targetDeadline, pending' = pending,
    lastApplied' = lastApplied, appliedOlder' = appliedOlder, asked' = asked, askDeadline' = askDeadline,
  }

  def ahead: int = pending.frame - guestFrame

  action guestTick = all {
    if (target != NONE and guestFrame >= target) {
      // At the target.
      if (pending.frame != NONE and ahead > 0 and ahead <= HOLD) hold
      else if (pending.frame != NONE) apply
      else stall
    } else if (target != NONE) {
      // Not there yet: keep running, a state that has arrived waits.
      advance
    } else if (pending.frame != NONE) {
      if (not(pending.held) and ahead > 0 and ahead <= HOLD) hold else apply
    } else advance,
    hostFrame' = hostFrame, hostUnchanged, requests' = requests, states' = states,
  }

  action guestHearsState = {
    val f = states.head()
    all {
      states.length() > 0,
      states' = states.tail(),
      asked' = false, askDeadline' = false,
      // A state no newer than the last one applied is dropped.
      pending' = if (f <= lastApplied) pending else { frame: f, held: false },
      target' = target, targetDeadline' = targetDeadline, stalled' = stalled,
      lastApplied' = lastApplied, appliedOlder' = appliedOlder,
      framesUnchanged, hostUnchanged, requests' = requests,
    }
  }

  // The target's 3 s deadline: give the target up; a state that has arrived
  // applies on the next tick wherever the guest is.
  action targetDeadlineFires = all {
    target != NONE, targetDeadline,
    target' = NONE, targetDeadline' = false, stalled' = false,
    asked' = asked, askDeadline' = askDeadline, pending' = pending,
    lastApplied' = lastApplied, appliedOlder' = appliedOlder,
    framesUnchanged, hostUnchanged, requests' = requests, states' = states,
  }

  action askDeadlineFires = all {
    asked, askDeadline,
    asked' = false, askDeadline' = false,
    target' = target, targetDeadline' = targetDeadline, stalled' = stalled, pending' = pending,
    lastApplied' = lastApplied, appliedOlder' = appliedOlder,
    framesUnchanged, hostUnchanged, requests' = requests, states' = states,
  }

  action step = any {
    guestAsksAt, guestAsksNow, hostHearsRequest, cooldownEnds, hostOwesASync,
    hostSendsConfirmed, hostDeadline, hostTick, guestTick, guestHearsState,
    targetDeadlineFires, askDeadlineFires,
  }

  // ── properties ─────────────────────────────────────────────────────────

  // A guest stopped at its target has a deadline (netplay invariant I1).
  val everyStallHasADeadline = stalled implies (target != NONE and targetDeadline)

  // A state no newer than the last one applied is never applied.
  val neverAppliesAnOlderState = not(appliedOlder)

  // A request that is out can still end: it is on its way, the host owes or
  // has sent an answer, or it has a deadline. Otherwise the guest never asks
  // again, however many desyncs it detects.
  // VIOLATED today: the host drops a request inside its 5 s rate limit and
  // nothing tells the guest.
  val aRequestCanAlwaysEnd = asked implies or {
    requests.length() > 0,
    scheduled.target != NONE,
    states.length() > 0,
    askDeadline,
  }

  val holdToday = everyStallHasADeadline and neverAppliesAnOlderState
  val allHold = holdToday and aRequestCanAlwaysEnd

  // ── scenarios ──────────────────────────────────────────────────────────

  // A request at a frame ahead, answered on time: the state lands on the
  // frame it is for.
  run coordinatedSyncTest =
    init
      .then(guestAsksAt)
      .then(hostHearsRequest)
      .then(2.reps(_ => hostTick))
      .then(2.reps(_ => guestTick))
      .then(guestTick)
      .expect(stalled and guestFrame == 2)
      .then(hostSendsConfirmed)
      .then(guestHearsState)
      .then(guestTick)
      .expect(guestFrame == 2 and lastApplied == 2 and not(stalled) and not(asked))

  // The state does not come: the stall ends at its deadline.
  run stallEndsAtItsDeadlineTest =
    init
      .then(guestAsksAt)
      .then(3.reps(_ => guestTick))
      .expect(stalled)
      .then(targetDeadlineFires)
      .then(guestTick)
      .expect(guestFrame == 3)

  // A second request inside the host's rate limit: the host drops it and
  // nothing tells the guest.
  run requestDroppedByTheRateLimitTest =
    init
      .then(guestAsksAt)
      .then(hostHearsRequest)
      .then(2.reps(_ => hostTick))
      .then(hostSendsConfirmed)
      .then(guestHearsState)
      .then(3.reps(_ => guestTick))
      .expect(lastApplied == 2 and not(asked))
      .then(guestAsksAt)
      .then(hostHearsRequest)
      .expect(aRequestCanAlwaysEnd == REQUEST_HAS_DEADLINE)
      // The target times out and the guest plays on, still unable to ask.
      .then(targetDeadlineFires)
      .then(guestTick)
      .expect(asked and askDeadline == REQUEST_HAS_DEADLINE)
}

// Today.
module resync_flow_current {
  import resync_flow(REQUEST_HAS_DEADLINE = false).*
}

// With a deadline on the request itself.
module resync_flow_fixed {
  import resync_flow(REQUEST_HAS_DEADLINE = true).*
}
