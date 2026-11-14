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
// Not checked: an unasked state applied below the frame the guest asked at
// (see beforeTheFrameAsked). Not modelled: what the state contains, deltas,
// chunks and their timeout,
// proactive pushes, more than one guest, the inputs around the apply
// (specs/resync_inputs.qnt), a replay delaying the apply, and the 15 s guard
// the request sent when a hidden tab is shown again already has (the
// requests after a desync, a dropped peer's return, a reconnect and a
// network change have none). Nor a host on a version that does not number
// its answers: until the host has numbered one, the guest treats its states
// as with ANSWERS_CARRY_REQUEST false. Nor the two requests the guest sends
// without marking a request as out (boot sync, input stall): they have no
// number, and their answers are UNASKED to the guest.
//
// ANSWERS_CARRY_REQUEST: a request has a number and the state that answers
//   it carries that number (`sync-request-id:` / `sync-answer-id:` ahead of
//   the request and of the state's header, `requestId` over Socket.IO).
//   false = before: any state that arrived ended whatever request was out
//   and was taken as its answer. Since a request can be given up on (its
//   deadline, or a reconnect that asks again over it) while its answer is
//   still on the way, a late answer then ended the newer request, and was
//   applied at the newer request's target (or at once, after that target's
//   deadline), which took the guest back below the frame it was told to
//   wait at; or it replaced the newer request's answer while that waited to
//   be applied. true = today: only its own answer ends a request
//   (_endsResyncRequest); the guest drops an answer to an older request
//   that is from before the frame the newest request named, wherever it is
//   (SYNC-LATE-ANSWER-DROPPED, _resyncRequestAt); and an older request's
//   answer does not replace the newest one's (SYNC-LATE-ANSWER-IGNORED).
//   Not modelled, fixed with it: the stale-state check keeps a lifecycle
//   guard an older request's answer does not end, and a chunk timeout on an
//   older request's transfer leaves the newer request alone.
//
// REQUEST_HAS_DEADLINE: a request that is out has a deadline of its own,
//   after which the guest may ask again (RESYNC-REQUEST-TIMEOUT). false =
//   before: only an arriving state ended it.
module resync_flow {
  const REQUEST_HAS_DEADLINE: bool
  const ANSWERS_CARRY_REQUEST: bool

  pure val DELTA = 2        // how far ahead the guest sets its target
  pure val HOLD = 1         // a state this far ahead is held, not applied early
  pure val FOLLOW_UPS = 1   // syncs the host sends again after an unconfirmed one
  pure val LAST_FRAME = 8
  pure val NONE = -1
  pure val NOW = -1         // a request with no target frame
  // Requests are numbered; the bound keeps the model finite.
  pure val MAX_REQUESTS = 3
  pure val UNASKED = 0      // a state the host sent for its own reasons

  // `req`: the request the state answers (UNASKED for one the host sent
  // for its own reasons).
  type Pending = { frame: int, held: bool, req: int }
  type Scheduled = { target: int, followUp: int, req: int }
  type Request = { at: int, id: int }
  type State = { frame: int, req: int }

  var guestFrame: int
  var hostFrame: int
  // guest
  var target: int            // stop here until the state arrives; NONE = no target
  var targetDeadline: bool
  var asked: bool            // a request is out
  var askedId: int           // the number of the newest request
  var askedAt: int           // the frame the newest request named; NONE = it named none
  var askDeadline: bool
  var stalled: bool          // stopped at the target, waiting for the state
  var pending: Pending       // a state received and not yet applied; frame NONE = none
  var lastApplied: int
  var appliedOlder: bool     // history: applied a state no newer than the last
  var lateEnded: bool        // history: an answer to an older request ended the one that was out
  var takenBack: bool        // history: a late answer was applied, from before the frame the newest request named
  var lostOwn: bool          // history: a late answer replaced the awaited one before it was applied
  // host
  var scheduled: Scheduled   // a capture owed to the guest; target NONE = none
  var cooling: bool          // answered this guest less than 5 s ago
  // channels
  var requests: List[Request]
  var states: List[State]

  pure val noPending: Pending = { frame: NONE, held: false, req: UNASKED }
  pure val noSchedule: Scheduled = { target: NONE, followUp: 0, req: UNASKED }

  action init = all {
    guestFrame' = 0, hostFrame' = 0,
    target' = NONE, targetDeadline' = false, asked' = false, askedId' = 0, askedAt' = NONE, askDeadline' = false,
    stalled' = false, pending' = noPending, lastApplied' = NONE, appliedOlder' = false,
    lateEnded' = false, takenBack' = false, lostOwn' = false,
    scheduled' = noSchedule, cooling' = false,
    requests' = [], states' = [],
  }

  action framesUnchanged = all { guestFrame' = guestFrame, hostFrame' = hostFrame }
  action hostUnchanged = all { scheduled' = scheduled, cooling' = cooling }
  action historyUnchanged = all {
    appliedOlder' = appliedOlder, lateEnded' = lateEnded, takenBack' = takenBack, lostOwn' = lostOwn,
  }
  action guestUnchanged = all {
    target' = target, targetDeadline' = targetDeadline, asked' = asked, askedId' = askedId, askedAt' = askedAt,
    askDeadline' = askDeadline, stalled' = stalled, pending' = pending, lastApplied' = lastApplied,
    historyUnchanged,
  }

  // ── the guest asks ─────────────────────────────────────────────────────

  // A desync was detected: ask for the state at a frame a little ahead.
  action guestAsksAt = all {
    not(asked),
    askedId < MAX_REQUESTS,
    guestFrame + DELTA <= LAST_FRAME,
    asked' = true, askedId' = askedId + 1, askedAt' = guestFrame + DELTA, askDeadline' = REQUEST_HAS_DEADLINE,
    target' = guestFrame + DELTA, targetDeadline' = true,
    requests' = requests.append({ at: guestFrame + DELTA, id: askedId + 1 }),
    stalled' = stalled, pending' = pending, lastApplied' = lastApplied, historyUnchanged,
    framesUnchanged, hostUnchanged, states' = states,
  }

  // Reconnect or network change: ask for it now. This one
  // goes out even when a request is already out.
  action guestAsksNow = all {
    askedId < MAX_REQUESTS,
    asked' = true, askedId' = askedId + 1, askedAt' = NONE, askDeadline' = REQUEST_HAS_DEADLINE,
    target' = NONE, targetDeadline' = false, stalled' = false,
    requests' = requests.append({ at: NOW, id: askedId + 1 }),
    pending' = pending, lastApplied' = lastApplied, historyUnchanged,
    framesUnchanged, hostUnchanged, states' = states,
  }

  // ── the host ───────────────────────────────────────────────────────────

  action hostHearsRequest = {
    val r = requests.head()
    val t = r.at
    all {
      requests.length() > 0,
      requests' = requests.tail(),
      if (cooling) all {
        // Rate limited: dropped, and the guest is not told.
        scheduled' = scheduled, cooling' = cooling, states' = states,
      } else if (t > hostFrame) all {
        scheduled' = { target: t, followUp: 0, req: r.id }, cooling' = true, states' = states,
      } else all {
        scheduled' = scheduled, cooling' = true, states' = states.append({ frame: hostFrame, req: r.id }),
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
    scheduled' = { target: hostFrame, followUp: 0, req: UNASKED },
    cooling' = cooling, framesUnchanged, guestUnchanged, requests' = requests, states' = states,
  }

  // The target frame is reached and the state there is final: send it.
  action hostSendsConfirmed = all {
    scheduled.target != NONE,
    scheduled.target <= hostFrame,
    states' = states.append({ frame: hostFrame, req: scheduled.req }),
    scheduled' = noSchedule,
    cooling' = cooling, framesUnchanged, guestUnchanged, requests' = requests,
  }

  // The capture's 3 s deadline: send what there is, and once more later if
  // a follow-up is left (what went out may still change here).
  action hostDeadline = all {
    scheduled.target != NONE,
    states' = states.append({ frame: hostFrame, req: scheduled.req }),
    scheduled' = if (scheduled.followUp < FOLLOW_UPS)
      { target: hostFrame, followUp: scheduled.followUp + 1, req: scheduled.req }
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
    takenBack' = (takenBack or beforeTheFrameAsked),
    lateEnded' = lateEnded, lostOwn' = lostOwn,
    pending' = noPending, target' = NONE, targetDeadline' = false, stalled' = false,
    asked' = asked, askedId' = askedId, askedAt' = askedAt, askDeadline' = askDeadline,
  }

  action advance = all {
    guestFrame < LAST_FRAME,
    guestFrame' = guestFrame + 1,
    target' = target, targetDeadline' = targetDeadline, stalled' = stalled, pending' = pending,
    lastApplied' = lastApplied, historyUnchanged, asked' = asked, askedId' = askedId, askedAt' = askedAt, askDeadline' = askDeadline,
  }

  action hold = all {
    target' = pending.frame, targetDeadline' = true, stalled' = false,
    pending' = { ...pending, held: true },
    guestFrame' = guestFrame, lastApplied' = lastApplied, historyUnchanged,
    asked' = asked, askedId' = askedId, askedAt' = askedAt, askDeadline' = askDeadline,
  }

  action stall = all {
    not(stalled),
    stalled' = true,
    guestFrame' = guestFrame, target' = target, targetDeadline' = targetDeadline, pending' = pending,
    lastApplied' = lastApplied, historyUnchanged, asked' = asked, askedId' = askedId, askedAt' = askedAt, askDeadline' = askDeadline,
  }

  def ahead: int = pending.frame - guestFrame

  // The state held is the answer to a request older than the newest one, and
  // is from before the frame the newest request named. The frame is the
  // request's, not the live target: the target's deadline gives the target
  // up, and the state is as old after it as before.
  // A state the host sent for its own reasons (UNASKED) is left out on
  // purpose, and is still applied as today, though it too can be from
  // before that frame. The host sends one when it has decided this guest
  // needs its state (a dropped peer is back); the guest's own request for
  // the same event may be the one the host's rate limit drops, and then the
  // unasked state is the only one coming. Nor can a guest tell it from an
  // answer when the host is on a build that does not number its answers.
  def beforeTheFrameAsked: bool = and {
    pending.frame != NONE, askedAt != NONE,
    pending.req != UNASKED, pending.req != askedId,
    pending.frame < askedAt,
  }

  // Such a state is not what the guest is waiting for. It is dropped
  // wherever the guest is; a wait at the target goes on, to its own deadline.
  action dropLate = all {
    pending' = noPending, stalled' = stalled,
    guestFrame' = guestFrame, target' = target, targetDeadline' = targetDeadline,
    lastApplied' = lastApplied, historyUnchanged, asked' = asked, askedId' = askedId, askedAt' = askedAt, askDeadline' = askDeadline,
  }

  action guestTick = all {
    if (ANSWERS_CARRY_REQUEST and beforeTheFrameAsked) dropLate
    else if (target != NONE and guestFrame >= target) {
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
    val st = states.head()
    val f = st.frame
    // The answer to the request that is out, or to one given up on before it.
    val own = asked and st.req == askedId
    val late = asked and st.req != UNASKED and st.req != askedId
    // Before, any state ended the request that was out. Now only its own.
    val ends = if (ANSWERS_CARRY_REQUEST) own else true
    all {
      states.length() > 0,
      states' = states.tail(),
      asked' = if (ends) false else asked,
      askDeadline' = if (ends) false else askDeadline,
      askedId' = askedId, askedAt' = askedAt,
      lateEnded' = (lateEnded or (late and ends)),
      // A state no newer than the last one applied is dropped.
      // Nor does a late answer take the place of the awaited one.
      val older = st.req != UNASKED and st.req != askedId
      val overAwaited = older and pending.frame != NONE and pending.req == askedId
      val kept = f <= lastApplied or (ANSWERS_CARRY_REQUEST and overAwaited)
      all {
        pending' = if (kept) pending else { frame: f, held: false, req: st.req },
        lostOwn' = (lostOwn or (overAwaited and not(kept))),
      },
      target' = target, targetDeadline' = targetDeadline, stalled' = stalled,
      lastApplied' = lastApplied, appliedOlder' = appliedOlder, takenBack' = takenBack,
      framesUnchanged, hostUnchanged, requests' = requests,
    }
  }

  // The target's 3 s deadline: give the target up; a state that has arrived
  // applies on the next tick wherever the guest is.
  action targetDeadlineFires = all {
    target != NONE, targetDeadline,
    target' = NONE, targetDeadline' = false, stalled' = false,
    asked' = asked, askedId' = askedId, askedAt' = askedAt, askDeadline' = askDeadline, pending' = pending,
    lastApplied' = lastApplied, historyUnchanged,
    framesUnchanged, hostUnchanged, requests' = requests, states' = states,
  }

  action askDeadlineFires = all {
    asked, askDeadline,
    asked' = false, askedId' = askedId, askedAt' = askedAt, askDeadline' = false,
    target' = target, targetDeadline' = targetDeadline, stalled' = stalled, pending' = pending,
    lastApplied' = lastApplied, historyUnchanged,
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
  // Violated before the request had a deadline: the host drops a request
  // inside its 5 s rate limit and nothing tells the guest.
  val aRequestCanAlwaysEnd = asked implies or {
    requests.length() > 0,
    scheduled.target != NONE,
    states.length() > 0,
    askDeadline,
  }

  // Only its own answer ends a request.
  // Violated before requests were numbered (resync_flow_any_answer): the
  // answer to a request the guest gave up on (its deadline, or a reconnect
  // asking again over it) ended the request that was out, so the guest could
  // ask a third time while the second was still to be answered.
  val onlyItsAnswerEndsARequest = not(lateEnded)

  // A late answer does not take the guest back below the frame its newest
  // request named, whether the guest is still waiting at that frame or its
  // target's deadline has passed.
  // Violated before requests were numbered (resync_flow_any_answer): it was
  // held until the newer request's target and applied there, or applied at
  // once after that target's deadline, although it is the host's state from
  // before that frame.
  val aLateAnswerDoesNotTakeTheGuestBack = not(takenBack)

  // A late answer does not take the place of the awaited one while that one
  // waits to be applied.
  // Violated before requests were numbered (resync_flow_any_answer;
  // lateAnswerOverTheAwaitedOneTest holds the ordering).
  val theAwaitedAnswerIsNotLost = not(lostOwn)

  // What held once a request had a deadline, before requests had numbers.
  val holdWithoutNumbers = everyStallHasADeadline and neverAppliesAnOlderState and aRequestCanAlwaysEnd
  val allHold = and {
    holdWithoutNumbers, onlyItsAnswerEndsARequest, aLateAnswerDoesNotTakeTheGuestBack, theAwaitedAnswerIsNotLost,
  }

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
  // The guest gives up on its first request and asks again at a later
  // frame; the host then answers the first.
  run lateAnswerTest =
    init
      .then(guestAsksAt)
      .then(hostHearsRequest)
      .then(targetDeadlineFires)
      .then(if (REQUEST_HAS_DEADLINE) askDeadlineFires else guestAsksNow)
      .then(2.reps(_ => guestTick))
      .then(if (REQUEST_HAS_DEADLINE) guestAsksAt else guestTick)
      .expect(asked and askedId == 2)
      .then(hostTick)
      .then(hostDeadline)
      // The state on its way is the host's at frame 1, for request 1.
      .then(guestHearsState)
      .expect(asked == ANSWERS_CARRY_REQUEST)
      .expect(onlyItsAnswerEndsARequest == ANSWERS_CARRY_REQUEST)
      .then(3.reps(_ => guestTick))
      .expect(REQUEST_HAS_DEADLINE implies (aLateAnswerDoesNotTakeTheGuestBack == ANSWERS_CARRY_REQUEST))

  // The same, but the second request's target deadline passes before the
  // first request's answer arrives: the target is gone, the state is as old.
  run lateAnswerAfterTheTargetDeadlineTest =
    init
      .then(guestAsksAt)
      .then(hostHearsRequest)
      .then(targetDeadlineFires)
      .then(if (REQUEST_HAS_DEADLINE) askDeadlineFires else guestAsksNow)
      .then(2.reps(_ => guestTick))
      .then(if (REQUEST_HAS_DEADLINE) guestAsksAt else guestTick)
      .expect(asked and askedId == 2)
      .then(hostTick)
      .then(hostDeadline)
      .then(if (REQUEST_HAS_DEADLINE) targetDeadlineFires else guestTick)
      .expect(target == NONE)
      .then(guestHearsState)
      .then(guestTick)
      .expect(REQUEST_HAS_DEADLINE implies (aLateAnswerDoesNotTakeTheGuestBack == ANSWERS_CARRY_REQUEST))
      .expect(ANSWERS_CARRY_REQUEST implies (pending == noPending and guestFrame > lastApplied))

  // The guest asks at a frame, then asks for a state now (a reconnect). The
  // host answers the second at once and the first when it reaches that
  // frame, so the first's answer arrives after the second's, while the
  // second's waits to be applied.
  run lateAnswerOverTheAwaitedOneTest =
    init
      .then(guestAsksAt)
      .then(hostTick)
      .then(hostHearsRequest)
      .then(guestAsksNow)
      .then(cooldownEnds)
      .then(hostHearsRequest)
      .then(cooldownEnds)
      .then(2.reps(_ => hostTick))
      .then(hostSendsConfirmed)
      .expect(states.length() == 2 and states[0].req == 2 and states[1].req == 1)
      .then(guestHearsState)
      .expect(pending.req == 2)
      .then(guestHearsState)
      .expect(theAwaitedAnswerIsNotLost == ANSWERS_CARRY_REQUEST)
      .expect(ANSWERS_CARRY_REQUEST implies pending.req == 2)
}

// Before: a request that was out had no deadline.
module resync_flow_before {
  import resync_flow(REQUEST_HAS_DEADLINE = false, ANSWERS_CARRY_REQUEST = false).*
}

// Before requests were numbered: any state that arrived ended the request
// that was out.
module resync_flow_any_answer {
  import resync_flow(REQUEST_HAS_DEADLINE = true, ANSWERS_CARRY_REQUEST = false).*
}

// Today: a request has a deadline and a number, and its answer carries the
// number.
module resync_flow_current {
  import resync_flow(REQUEST_HAS_DEADLINE = true, ANSWERS_CARRY_REQUEST = true).*
}
