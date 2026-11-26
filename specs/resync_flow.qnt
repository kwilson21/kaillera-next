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
// Not checked: an unasked state applied below the guest's frame or the frame
// the guest asked at (see lateAnswerHeld). Not modelled: what the state
// contains, deltas, chunks and their timeout, proactive pushes, more than
// one guest, the inputs around the apply (specs/resync_inputs.qnt), a
// replay delaying the apply, and the 15 s guard
// the request sent when a hidden tab is shown again already has (the
// requests after a desync, a dropped peer's return, a reconnect and a
// network change have none). Nor a host on a version that does not number
// its answers: until the host has numbered one, the guest treats its states
// as with ANSWERS_CARRY_REQUEST false.
//
// EVERY_REQUEST_NUMBERED: the two requests the guest sends on its own
//   account, with no desync detected (the boot sync after the boot grace,
//   and the input stall's after it made up a peer's input), are "now"
//   requests like the others: numbered, marked as out, and owed until a host
//   state is applied. They are sent only when no request is out. false = before: they went out bare, so the guest did
//   not mark a request as out and the host's answer carried no number. To
//   the guest that answer was a state the host sent for its own reasons, and
//   was applied wherever it found the guest. A two-player run with the guest
//   frozen in the menus found it: the boot sync's answer, the host's state at
//   frame 124, arrived after the guest had asked again at 246 (a dropped
//   peer back), and took it back from 241 to 124
//   (bootAnswerAfterANewerRequestTest). Numbered, it answers an older
//   request, and LATE_RULE drops it.
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
//   that would take it back (LATE_RULE, SYNC-LATE-ANSWER-DROPPED); and an
//   older request's answer does not replace the newest one's
//   (SYNC-LATE-ANSWER-IGNORED).
//   Not modelled, fixed with it: the stale-state check keeps a lifecycle
//   guard an older request's answer does not end, and a chunk timeout on an
//   older request's transfer leaves the newer request alone.
//
// REQUEST_HAS_DEADLINE: a request that is out has a deadline of its own,
//   after which the guest may ask again (RESYNC-REQUEST-TIMEOUT). false =
//   before: only an arriving state ended it.
//
// LATE_RULE: which answers to an older request the guest drops (with
//   ANSWERS_CARRY_REQUEST; without it the guest cannot tell them apart).
//   "frameNamed" = before: one from before the frame the newest request
//   named; when the newest request named none (asked "now": a reconnect, a
//   network change, a lifecycle return, a missing delta base, the late-join
//   lost-host resync) every late answer was applied, whatever its frame. A
//   test run found it: an immediate request went unanswered past its
//   deadline, the guest asked again, and the first answer (the host's state
//   at frame 864) arrived with the guest at 994 and took it back 130 frames
//   (immediateLateAnswerTest).
//   "behind" = today: one from before the guest's own frame, or before the
//   frame the newest request named. It is dropped on the tick that would
//   apply it, so a late answer is applied only where it does not take the
//   guest back: at or ahead of it (a hold), and not below the frame asked.
//   Two other rules were checked and not taken:
//   "older" (rule a): every answer to an older request. It holds the
//   properties too, but it also drops a late answer that is ahead of the
//   guest when it is the only state coming: the newest request asked "now"
//   over a request at a frame, and the host's rate limit dropped it
//   (onlyStateComingTest). The guest is left with its deadline, and only
//   the late-join lost-host resync asks again at that deadline.
//   "askedFrom" (rule b): one from before the frame the guest was on when it
//   asked the newest request (or the frame that request named). The guest
//   moves on after asking, so a late answer from between the two still takes
//   it back (lateAnswerFromAfterTheAskTest).
//
// CATCH_UP: a state from before the guest's frame is applied where it is
//   from and the frames between it and the guest's frame are run again,
//   unseen, with the inputs both pages already have (one step here; slices
//   over a few ticks in the engine); the guest goes on from the frame it was
//   on. Only MAX_CATCH_UP frames are run again: a state
//   further back is not applied (SYNC-TOO-OLD-DROPPED) and the guest asks
//   again if it is owed one. false = before: the guest's frame went back to
//   the state's and the frames between were played again in sight, at the
//   game's pace, while the host waited for the guest's inputs. Even the
//   answer to the request that is out comes from the frame the host was on
//   when it heard the request, and the guest has moved on by the time it
//   arrives: a few frames on a fast link, seconds on a slow one. A two-player
//   run with the boot sync's answer held 12 s (rb-two-player.mjs,
//   DELAY_SYNC_ANSWER_AT=boot) took the guest back 272 frames, past the
//   engine's 256-frame input ring, and the pages split
//   (ownAnswerBehindTest).
module resync_flow {
  const REQUEST_HAS_DEADLINE: bool
  const ANSWERS_CARRY_REQUEST: bool
  const LATE_RULE: str
  const EVERY_REQUEST_NUMBERED: bool
  const CATCH_UP: bool

  pure val DELTA = 2        // how far ahead the guest sets its target
  pure val HOLD = 1         // a state this far ahead is held, not applied early
  pure val MAX_CATCH_UP = 2 // frames run again at most after a state from before the guest's frame
  pure val FOLLOW_UPS = 1   // syncs the host sends again after an unconfirmed one
  pure val LAST_FRAME = 8
  pure val NONE = -1
  pure val NOW = -1         // a request with no target frame
  // Requests are numbered; the bound keeps the model finite.
  pure val MAX_REQUESTS = 3
  pure val UNASKED = 0      // a state the host sent for its own reasons

  // `req`: the request the state answers (UNASKED for one the host sent
  // for its own reasons, or for a request that went out with no number).
  // `ask`, not seen by the guest or the host: which of the guest's requests,
  // counted in the order sent, numbered or not, the state answers (UNASKED
  // for one the host sent for its own reasons). With every request
  // numbered it is `req`.
  type Pending = { frame: int, held: bool, req: int, ask: int }
  type Scheduled = { target: int, followUp: int, req: int, ask: int }
  type Request = { at: int, id: int, ask: int }
  type State = { frame: int, req: int, ask: int }

  var guestFrame: int
  var hostFrame: int
  // guest
  var target: int            // stop here until the state arrives; NONE = no target
  var targetDeadline: bool
  var asked: bool            // a request is out
  var askedId: int           // the number of the newest request
  var askedAt: int           // the frame the newest request named; NONE = it named none
  var askedFrom: int         // the guest's frame when it sent the newest request (rule b only)
  var askDeadline: bool
  var stalled: bool          // stopped at the target, waiting for the state
  var pending: Pending       // a state received and not yet applied; frame NONE = none
  var lastApplied: int
  var appliedOlder: bool     // history: applied a state no newer than the last
  var lateEnded: bool        // history: an answer to an older request ended the one that was out
  var takenBack: bool        // history: a late answer was applied below the guest's frame or the frame the newest request named
  var asks: int              // history: the requests the guest has sent, numbered or not
  var lostOwn: bool          // history: a late answer replaced the awaited one before it was applied
  var rewound: bool          // history: applying a state moved the guest's frame back
  // host
  var scheduled: Scheduled   // a capture owed to the guest; target NONE = none
  var cooling: bool          // answered this guest less than 5 s ago
  // channels
  var requests: List[Request]
  var states: List[State]

  pure val noPending: Pending = { frame: NONE, held: false, req: UNASKED, ask: UNASKED }
  pure val noSchedule: Scheduled = { target: NONE, followUp: 0, req: UNASKED, ask: UNASKED }

  action init = all {
    guestFrame' = 0, hostFrame' = 0,
    target' = NONE, targetDeadline' = false, asked' = false, askedId' = 0, askedAt' = NONE, askedFrom' = NONE, askDeadline' = false,
    stalled' = false, pending' = noPending, lastApplied' = NONE, appliedOlder' = false,
    lateEnded' = false, takenBack' = false, lostOwn' = false, asks' = 0, rewound' = false,
    scheduled' = noSchedule, cooling' = false,
    requests' = [], states' = [],
  }

  action framesUnchanged = all { guestFrame' = guestFrame, hostFrame' = hostFrame }
  action hostUnchanged = all { scheduled' = scheduled, cooling' = cooling }
  action historyUnchanged = all {
    appliedOlder' = appliedOlder, lateEnded' = lateEnded, takenBack' = takenBack, lostOwn' = lostOwn, asks' = asks,
    rewound' = rewound,
  }
  action guestUnchanged = all {
    target' = target, targetDeadline' = targetDeadline, asked' = asked, askedId' = askedId, askedAt' = askedAt,
    askedFrom' = askedFrom, askDeadline' = askDeadline, stalled' = stalled, pending' = pending, lastApplied' = lastApplied,
    historyUnchanged,
  }

  // ── the guest asks ─────────────────────────────────────────────────────

  // The bound counts every request, numbered or not.
  action history(newAsks) = all {
    appliedOlder' = appliedOlder, lateEnded' = lateEnded, takenBack' = takenBack, lostOwn' = lostOwn, asks' = newAsks,
    rewound' = rewound,
  }

  // A desync was detected: ask for the state at a frame a little ahead.
  action guestAsksAt = all {
    not(asked),
    asks < MAX_REQUESTS,
    guestFrame + DELTA <= LAST_FRAME,
    asked' = true, askedId' = askedId + 1, askedAt' = guestFrame + DELTA, askedFrom' = guestFrame,
    askDeadline' = REQUEST_HAS_DEADLINE,
    target' = guestFrame + DELTA, targetDeadline' = true,
    requests' = requests.append({ at: guestFrame + DELTA, id: askedId + 1, ask: asks + 1 }),
    stalled' = stalled, pending' = pending, lastApplied' = lastApplied, history(asks + 1),
    framesUnchanged, hostUnchanged, states' = states,
  }

  // Reconnect or network change: ask for it now. This one
  // goes out even when a request is already out.
  action guestAsksNow = all {
    asks < MAX_REQUESTS,
    asked' = true, askedId' = askedId + 1, askedAt' = NONE, askedFrom' = guestFrame,
    askDeadline' = REQUEST_HAS_DEADLINE,
    target' = NONE, targetDeadline' = false, stalled' = false,
    requests' = requests.append({ at: NOW, id: askedId + 1, ask: asks + 1 }),
    pending' = pending, lastApplied' = lastApplied, history(asks + 1),
    framesUnchanged, hostUnchanged, states' = states,
  }

  // The boot sync, or the input stall's after a peer's input was made up:
  // ask for it now, on the guest's own account. Today it is a "now" request,
  // numbered and out, but only when no request is out: the one that is out
  // brings a host state already. Asked over it, it would make that answer an
  // older request's, dropped once the guest is past it, while the host's
  // rate limit may drop the new one. Nor does it give up a target, unlike a
  // reconnect: a state held a few frames ahead would be applied early.
  // Before, it went out with no number whatever was out, nothing marked it
  // as out, and its answer came back as UNASKED.
  action guestAsksOnItsOwn = if (EVERY_REQUEST_NUMBERED) all {
    not(asked),
    asks < MAX_REQUESTS,
    asked' = true, askedId' = askedId + 1, askedAt' = NONE, askedFrom' = guestFrame,
    askDeadline' = REQUEST_HAS_DEADLINE,
    requests' = requests.append({ at: NOW, id: askedId + 1, ask: asks + 1 }),
    target' = target, targetDeadline' = targetDeadline, stalled' = stalled,
    pending' = pending, lastApplied' = lastApplied, history(asks + 1),
    framesUnchanged, hostUnchanged, states' = states,
  } else all {
    asks < MAX_REQUESTS,
    requests' = requests.append({ at: NOW, id: UNASKED, ask: asks + 1 }),
    target' = target, targetDeadline' = targetDeadline, asked' = asked, askedId' = askedId, askedAt' = askedAt,
    askedFrom' = askedFrom, askDeadline' = askDeadline, stalled' = stalled, pending' = pending, lastApplied' = lastApplied,
    history(asks + 1),
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
        scheduled' = { target: t, followUp: 0, req: r.id, ask: r.ask }, cooling' = true, states' = states,
      } else all {
        scheduled' = scheduled, cooling' = true, states' = states.append({ frame: hostFrame, req: r.id, ask: r.ask }),
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
    scheduled' = { target: hostFrame, followUp: 0, req: UNASKED, ask: UNASKED },
    cooling' = cooling, framesUnchanged, guestUnchanged, requests' = requests, states' = states,
  }

  // The target frame is reached and the state there is final: send it.
  action hostSendsConfirmed = all {
    scheduled.target != NONE,
    scheduled.target <= hostFrame,
    states' = states.append({ frame: hostFrame, req: scheduled.req, ask: scheduled.ask }),
    scheduled' = noSchedule,
    cooling' = cooling, framesUnchanged, guestUnchanged, requests' = requests,
  }

  // The capture's 3 s deadline: send what there is, and once more later if
  // a follow-up is left (what went out may still change here).
  action hostDeadline = all {
    scheduled.target != NONE,
    states' = states.append({ frame: hostFrame, req: scheduled.req, ask: scheduled.ask }),
    scheduled' = if (scheduled.followUp < FOLLOW_UPS)
      { target: hostFrame, followUp: scheduled.followUp + 1, req: scheduled.req, ask: scheduled.ask }
    else noSchedule,
    cooling' = cooling, framesUnchanged, guestUnchanged, requests' = requests,
  }

  action hostTick = all {
    hostFrame < LAST_FRAME,
    hostFrame' = hostFrame + 1,
    guestFrame' = guestFrame, hostUnchanged, guestUnchanged, requests' = requests, states' = states,
  }

  // ── the guest's tick ───────────────────────────────────────────────────

  // The guest's frame after the state is applied: the state's, or, catching
  // up, the one it was on.
  def landsAt: int = if (CATCH_UP and pending.frame < guestFrame) guestFrame else pending.frame

  action apply = all {
    guestFrame' = landsAt,
    lastApplied' = pending.frame,
    appliedOlder' = (appliedOlder or pending.frame <= lastApplied),
    takenBack' = (takenBack or staleAndBehind),
    rewound' = (rewound or landsAt < guestFrame),
    lateEnded' = lateEnded, lostOwn' = lostOwn, asks' = asks,
    pending' = noPending, target' = NONE, targetDeadline' = false, stalled' = false,
    asked' = asked, askedId' = askedId, askedAt' = askedAt, askedFrom' = askedFrom, askDeadline' = askDeadline,
  }

  action advance = all {
    guestFrame < LAST_FRAME,
    guestFrame' = guestFrame + 1,
    target' = target, targetDeadline' = targetDeadline, stalled' = stalled, pending' = pending,
    lastApplied' = lastApplied, historyUnchanged, asked' = asked, askedId' = askedId, askedAt' = askedAt, askedFrom' = askedFrom, askDeadline' = askDeadline,
  }

  action hold = all {
    target' = pending.frame, targetDeadline' = true, stalled' = false,
    pending' = { ...pending, held: true },
    guestFrame' = guestFrame, lastApplied' = lastApplied, historyUnchanged,
    asked' = asked, askedId' = askedId, askedAt' = askedAt, askedFrom' = askedFrom, askDeadline' = askDeadline,
  }

  action stall = all {
    not(stalled),
    stalled' = true,
    guestFrame' = guestFrame, target' = target, targetDeadline' = targetDeadline, pending' = pending,
    lastApplied' = lastApplied, historyUnchanged, asked' = asked, askedId' = askedId, askedAt' = askedAt, askedFrom' = askedFrom, askDeadline' = askDeadline,
  }

  def ahead: int = pending.frame - guestFrame

  // The state held is the answer to a request older than the newest one.
  // A state the host sent for its own reasons (UNASKED) is left out on
  // purpose, and is still applied as today, though it too can be from
  // before the guest's frame. The host sends one when it has decided this
  // guest needs its state (a dropped peer is back); the guest's own request
  // for the same event may be the one the host's rate limit drops, and then
  // the unasked state is the only one coming. Nor can a guest tell it from
  // an answer when the host is on a build that does not number its answers.
  def lateAnswerHeld: bool = and {
    pending.frame != NONE, pending.req != UNASKED, pending.req != askedId,
  }

  // Such a state, applied now, would take the guest back: below the frame
  // it is on, or below the frame the newest request named. The frame named
  // is the request's, not the live target: the target's deadline gives the
  // target up, and the state is as old after it as before.
  def lateAndBehind: bool = and {
    lateAnswerHeld,
    or { pending.frame < guestFrame, and { askedAt != NONE, pending.frame < askedAt } },
  }

  // What the property checks, seen from outside: the state held answers a
  // request older than the guest's newest, numbered or not, and would take
  // the guest back. With every request numbered it is lateAndBehind; before,
  // the answer to a request that went out with no number was UNASKED to the
  // guest and not checked.
  def staleAndBehind: bool = and {
    pending.frame != NONE, pending.ask != UNASKED, pending.ask != asks,
    or { pending.frame < guestFrame, and { askedAt != NONE, pending.frame < askedAt } },
  }

  // The late answers the guest drops, by LATE_RULE.
  def lateToDrop: bool = and {
    ANSWERS_CARRY_REQUEST,
    lateAnswerHeld,
    if (LATE_RULE == "older") true
    else if (LATE_RULE == "askedFrom") or {
      pending.frame < askedFrom, and { askedAt != NONE, pending.frame < askedAt },
    }
    else if (LATE_RULE == "behind") lateAndBehind
    else and { askedAt != NONE, pending.frame < askedAt },
  }

  // A state further back than the guest can run again (CATCH_UP).
  def tooOldToCatchUp: bool = and {
    CATCH_UP, pending.frame != NONE, guestFrame - pending.frame > MAX_CATCH_UP,
  }

  // Such a state is not what the guest is waiting for. It is dropped
  // wherever the guest is; a wait at the target goes on, to its own deadline.
  // A state too old to catch up from is dropped the same way.
  action dropLate = all {
    pending' = noPending, stalled' = stalled,
    guestFrame' = guestFrame, target' = target, targetDeadline' = targetDeadline,
    lastApplied' = lastApplied, historyUnchanged, asked' = asked, askedId' = askedId, askedAt' = askedAt, askedFrom' = askedFrom, askDeadline' = askDeadline,
  }

  action guestTick = all {
    if (lateToDrop or tooOldToCatchUp) dropLate
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
      askedId' = askedId, askedAt' = askedAt, askedFrom' = askedFrom,
      lateEnded' = (lateEnded or (late and ends)),
      // A state no newer than the last one applied is dropped.
      // Nor does a late answer take the place of the awaited one.
      val older = st.req != UNASKED and st.req != askedId
      val overAwaited = older and pending.frame != NONE and pending.req == askedId
      val kept = f <= lastApplied or (ANSWERS_CARRY_REQUEST and overAwaited)
      all {
        pending' = if (kept) pending else { frame: f, held: false, req: st.req, ask: st.ask },
        lostOwn' = (lostOwn or (overAwaited and not(kept))),
      },
      target' = target, targetDeadline' = targetDeadline, stalled' = stalled,
      lastApplied' = lastApplied, appliedOlder' = appliedOlder, takenBack' = takenBack, asks' = asks, rewound' = rewound,
      framesUnchanged, hostUnchanged, requests' = requests,
    }
  }

  // The target's 3 s deadline: give the target up; a state that has arrived
  // applies on the next tick wherever the guest is.
  action targetDeadlineFires = all {
    target != NONE, targetDeadline,
    target' = NONE, targetDeadline' = false, stalled' = false,
    asked' = asked, askedId' = askedId, askedAt' = askedAt, askedFrom' = askedFrom, askDeadline' = askDeadline, pending' = pending,
    lastApplied' = lastApplied, historyUnchanged,
    framesUnchanged, hostUnchanged, requests' = requests, states' = states,
  }

  action askDeadlineFires = all {
    asked, askDeadline,
    asked' = false, askedId' = askedId, askedAt' = askedAt, askedFrom' = askedFrom, askDeadline' = false,
    target' = target, targetDeadline' = targetDeadline, stalled' = stalled, pending' = pending,
    lastApplied' = lastApplied, historyUnchanged,
    framesUnchanged, hostUnchanged, requests' = requests, states' = states,
  }

  action step = any {
    guestAsksAt, guestAsksNow, guestAsksOnItsOwn, hostHearsRequest, cooldownEnds, hostOwesASync,
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

  // A late answer (to a request older than the newest) does not take the
  // guest back: it is not applied below the frame the guest is on, nor
  // below the frame its newest request named, whether the guest is still
  // waiting at that frame or its target's deadline has passed. This holds
  // whether or not the newest request named a frame.
  // Violated before requests were numbered (resync_flow_any_answer): it was
  // held until the newer request's target and applied there, or applied at
  // once after that target's deadline, although it is the host's state from
  // before that frame. Violated too while only the frame named was checked
  // (resync_flow_frame_named): after a request asked "now", a late answer
  // was applied whatever its frame (immediateLateAnswerTest). And by rule b
  // (resync_flow_asked_from; lateAnswerFromAfterTheAskTest). And while the
  // boot sync and the input stall's request went out with no number
  // (resync_flow_unnumbered; bootAnswerAfterANewerRequestTest).
  val aLateAnswerDoesNotTakeTheGuestBack = not(takenBack)

  // A late answer does not take the place of the awaited one while that one
  // waits to be applied.
  // Violated before requests were numbered (resync_flow_any_answer;
  // lateAnswerOverTheAwaitedOneTest holds the ordering).
  val theAwaitedAnswerIsNotLost = not(lostOwn)

  // No state applied moves the guest's frame back, whichever request it
  // answers, its own included.
  // Violated before the guest caught up (resync_flow_rewinds;
  // ownAnswerBehindTest): the answer to the request that is out is the
  // host's state from when the host heard it, and the guest had moved on.
  val theGuestIsNeverRewound = not(rewound)

  // What held once a request had a deadline, before requests had numbers.
  val holdWithoutNumbers = everyStallHasADeadline and neverAppliesAnOlderState and aRequestCanAlwaysEnd
  val allHold = and {
    holdWithoutNumbers, onlyItsAnswerEndsARequest, aLateAnswerDoesNotTakeTheGuestBack, theAwaitedAnswerIsNotLost,
    theGuestIsNeverRewound,
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

  // The ordering a test run found: an immediate request; its deadline
  // passes; a second immediate request; then the first one's answer, the
  // host's state from well before the guest's frame, arrives late. Applied,
  // it takes the guest back; today it is dropped, and the second request's
  // own answer is applied when it comes.
  run immediateLateAnswerTest =
    init
      .then(guestAsksNow)
      .then(hostTick)
      .then(hostHearsRequest)
      .expect(states.length() == 1 and states[0].req == 1 and states[0].frame == 1)
      .then(if (REQUEST_HAS_DEADLINE) askDeadlineFires else guestTick)
      .then(3.reps(_ => guestTick))
      .then(guestAsksNow)
      .expect(askedId == 2 and askedAt == NONE)
      .then(guestHearsState)
      .then(guestTick)
      .expect(aLateAnswerDoesNotTakeTheGuestBack == (ANSWERS_CARRY_REQUEST and LATE_RULE != "frameNamed"))
      .expect((ANSWERS_CARRY_REQUEST and LATE_RULE != "frameNamed") implies (pending == noPending and lastApplied == NONE and asked))
      // The second request's own answer.
      .then(cooldownEnds)
      .then(hostTick)
      .then(hostHearsRequest)
      .then(guestHearsState)
      .then(guestTick)
      .expect((ANSWERS_CARRY_REQUEST and LATE_RULE != "frameNamed") implies (lastApplied == 2 and not(asked)))

  // Rule b: the guest moves on after asking, and a late answer from between
  // the frame it asked at and the frame it is on still takes it back.
  run lateAnswerFromAfterTheAskTest =
    init
      .then(guestAsksNow)
      .then(guestAsksNow)
      .then(hostTick)
      .then(hostHearsRequest)
      .then(2.reps(_ => guestTick))
      .expect(guestFrame == 2 and askedFrom == 0 and states[0].frame == 1 and states[0].req == 1)
      .then(guestHearsState)
      .then(guestTick)
      .expect(ANSWERS_CARRY_REQUEST implies (aLateAnswerDoesNotTakeTheGuestBack == (LATE_RULE == "older" or LATE_RULE == "behind")))

  // Rule a: the guest asks at a frame, then asks "now" over it (a network
  // change); the host's rate limit drops the second request. The first one's
  // answer is the only state coming, and it is for a frame the guest has not
  // reached. Every rule but a applies it there; rule a drops it, and
  // nothing is left on its way: only the second request's deadline.
  run onlyStateComingTest =
    init
      .then(guestAsksAt)
      .then(hostHearsRequest)
      .then(guestAsksNow)
      .then(hostHearsRequest)
      .expect(requests.length() == 0 and scheduled.req == 1 and cooling)
      .then(2.reps(_ => hostTick))
      .then(hostSendsConfirmed)
      .then(guestHearsState)
      .expect(pending.frame == 2 and guestFrame == 0)
      .then(guestTick)
      .expect(aLateAnswerDoesNotTakeTheGuestBack)
      .expect((ANSWERS_CARRY_REQUEST and LATE_RULE == "older") implies and {
        lastApplied == NONE, pending == noPending, asked,
        requests.length() == 0, scheduled == noSchedule, states.length() == 0,
      })
      .expect(not(ANSWERS_CARRY_REQUEST and LATE_RULE == "older") implies (lastApplied == 2 and guestFrame == 2))

  // The ordering a two-player run found, the guest frozen in the menus: the
  // boot sync asks for the host's state now, and the host answers with its
  // state at frame 0. The guest plays on and the answer is slow to come (in
  // the run the guest froze for 14 s); the guest asks again at a frame (a
  // dropped peer is back), and only then does the boot sync's answer arrive.
  // Unnumbered, it is a state the host sent for its own reasons to the
  // guest, so it waits for the target and is applied there, taking the guest
  // back. Numbered, it answers an older request, is dropped, and the newer
  // request's own answer is applied at its frame.
  run bootAnswerAfterANewerRequestTest =
    init
      .then(guestAsksOnItsOwn)
      .then(hostHearsRequest)
      .expect(states.length() == 1 and states[0].frame == 0 and states[0].ask == 1)
      .expect(asked == EVERY_REQUEST_NUMBERED)
      .then(3.reps(_ => guestTick))
      // The boot sync's deadline passes while its answer is on its way;
      // before it was numbered, nothing was out.
      .then(if (EVERY_REQUEST_NUMBERED and REQUEST_HAS_DEADLINE) askDeadlineFires else hostTick)
      .then(cooldownEnds)
      // Before a request had a deadline, only a reconnect asked over one.
      .then(if (EVERY_REQUEST_NUMBERED and not(REQUEST_HAS_DEADLINE)) guestAsksNow else guestAsksAt)
      .expect(guestFrame == 3 and asks == 2)
      .then(guestHearsState)
      .expect(pending.frame == 0 and pending.ask == 1)
      .expect(pending.req == (if (EVERY_REQUEST_NUMBERED) 1 else UNASKED))
      .then(3.reps(_ => guestTick))
      .expect(aLateAnswerDoesNotTakeTheGuestBack == (EVERY_REQUEST_NUMBERED and ANSWERS_CARRY_REQUEST))
      .expect(not(EVERY_REQUEST_NUMBERED) implies (guestFrame == 0 and lastApplied == 0))
      .expect((EVERY_REQUEST_NUMBERED and ANSWERS_CARRY_REQUEST) implies and {
        guestFrame == 5, lastApplied == NONE, pending == noPending, asked,
      })
      // The newer request's own answer, at its frame.
      .then(hostHearsRequest)
      .then(5.reps(_ => hostTick))
      .then(if (scheduled.target != NONE) hostSendsConfirmed else hostTick)
      .then(guestHearsState)
      .then(guestTick)
      .expect((EVERY_REQUEST_NUMBERED and ANSWERS_CARRY_REQUEST) implies and {
        lastApplied == 5, guestFrame == 5, not(asked),
      })

  // The answer to the request that is out, from before the guest's frame:
  // the host answers a "now" request with its state from when it heard it,
  // and the guest has played on by the time the state arrives. Before, the
  // guest's frame went back to the state's; catching up, the state is
  // applied and the frames between run again, and the guest stays where it
  // was.
  run ownAnswerBehindTest =
    init
      .then(guestAsksNow)
      .then(hostHearsRequest)
      .expect(states.length() == 1 and states[0].frame == 0 and states[0].req == 1)
      .then(2.reps(_ => guestTick))
      .then(guestHearsState)
      .expect(not(asked) and pending.frame == 0 and guestFrame == 2)
      .then(guestTick)
      .expect(lastApplied == 0 and pending == noPending)
      .expect(theGuestIsNeverRewound == CATCH_UP)
      .expect(guestFrame == (if (CATCH_UP) 2 else 0))

  // The same answer, from further back than the guest runs again: it is not
  // applied, and the guest plays on from where it is.
  run tooOldToCatchUpTest =
    init
      .then(guestAsksNow)
      .then(hostHearsRequest)
      .then(3.reps(_ => guestTick))
      .then(guestHearsState)
      .expect(pending.frame == 0 and guestFrame == 3)
      .then(guestTick)
      .expect(theGuestIsNeverRewound == CATCH_UP)
      .expect(CATCH_UP implies (lastApplied == NONE and pending == noPending and guestFrame == 3))
      .expect(not(CATCH_UP) implies (lastApplied == 0 and guestFrame == 0))
}

// The variants below up to resync_flow_unnumbered check the rule each was
// about with every request numbered, which leaves out the two the guest sent
// bare until resync_flow_unnumbered's fix; their results stand as recorded.
// All but resync_flow_drop_older and resync_flow_current leave out catching
// up, which came last; resync_flow_drop_older keeps it so that it is checked
// against the same properties as today.

// Before: a request that was out had no deadline.
module resync_flow_before {
  import resync_flow(
    REQUEST_HAS_DEADLINE = false, ANSWERS_CARRY_REQUEST = false, LATE_RULE = "frameNamed", EVERY_REQUEST_NUMBERED = true,
    CATCH_UP = false,
  ).*
}

// Before requests were numbered: any state that arrived ended the request
// that was out.
module resync_flow_any_answer {
  import resync_flow(
    REQUEST_HAS_DEADLINE = true, ANSWERS_CARRY_REQUEST = false, LATE_RULE = "frameNamed", EVERY_REQUEST_NUMBERED = true,
    CATCH_UP = false,
  ).*
}

// Before late answers were dropped after a request that named no frame: a
// request has a deadline and a number, and the guest drops a late answer
// only when it is from before the frame the newest request named. Violates
// aLateAnswerDoesNotTakeTheGuestBack (immediateLateAnswerTest).
module resync_flow_frame_named {
  import resync_flow(
    REQUEST_HAS_DEADLINE = true, ANSWERS_CARRY_REQUEST = true, LATE_RULE = "frameNamed", EVERY_REQUEST_NUMBERED = true,
    CATCH_UP = false,
  ).*
}

// Rule a, not taken: every answer to an older request is dropped. Holds
// allHold, and drops the only state coming in onlyStateComingTest.
module resync_flow_drop_older {
  import resync_flow(
    REQUEST_HAS_DEADLINE = true, ANSWERS_CARRY_REQUEST = true, LATE_RULE = "older", EVERY_REQUEST_NUMBERED = true,
    CATCH_UP = true,
  ).*
}

// Rule b, not taken: a late answer is dropped when it is from before the
// frame the guest was on when it sent the newest request. Violates
// aLateAnswerDoesNotTakeTheGuestBack (lateAnswerFromAfterTheAskTest).
module resync_flow_asked_from {
  import resync_flow(
    REQUEST_HAS_DEADLINE = true, ANSWERS_CARRY_REQUEST = true, LATE_RULE = "askedFrom", EVERY_REQUEST_NUMBERED = true,
    CATCH_UP = false,
  ).*
}

// Before the boot sync and the input stall's request were numbered: their
// answers came back unnumbered and were applied wherever they found the
// guest. Violates aLateAnswerDoesNotTakeTheGuestBack
// (bootAnswerAfterANewerRequestTest).
module resync_flow_unnumbered {
  import resync_flow(
    REQUEST_HAS_DEADLINE = true, ANSWERS_CARRY_REQUEST = true, LATE_RULE = "behind", EVERY_REQUEST_NUMBERED = false,
    CATCH_UP = false,
  ).*
}

// Before the guest caught up: a state from before the guest's frame took the
// guest's frame back to it. Violates theGuestIsNeverRewound
// (ownAnswerBehindTest).
module resync_flow_rewinds {
  import resync_flow(
    REQUEST_HAS_DEADLINE = true, ANSWERS_CARRY_REQUEST = true, LATE_RULE = "behind", EVERY_REQUEST_NUMBERED = true,
    CATCH_UP = false,
  ).*
}

// Today: every request has a deadline and a number, its answer carries the
// number, a late answer is dropped wherever it would take the guest back,
// and any other state from before the guest's frame is caught up from, or
// dropped when it is too far back.
module resync_flow_current {
  import resync_flow(
    REQUEST_HAS_DEADLINE = true, ANSWERS_CARRY_REQUEST = true, LATE_RULE = "behind", EVERY_REQUEST_NUMBERED = true,
    CATCH_UP = true,
  ).*
}

// A buffered snapshot cannot replace replay until its install boundary is
// open. Waiting for a future frame does not spend the replay deadline.
module resync_replay_boundary {
  const START_BEFORE_TARGET: bool
  const CHECK_ELIGIBILITY: bool
  pure val LIMIT = 2
  var ready: bool
  var waited: int
  var replaying: bool
  var applied: bool
  var eligible: bool
  var rejectedDiscard: bool

  action init = all {
    ready' = false, waited' = 0, replaying' = true, applied' = false, eligible' = true, rejectedDiscard' = false,
  }
  action reachBoundary = all {
    ready' = true, waited' = waited, replaying' = replaying, applied' = applied, eligible' = eligible, rejectedDiscard' = rejectedDiscard,
  }
  action completeReplay = all {
    ready' = ready, waited' = waited, replaying' = false, applied' = applied, eligible' = eligible, rejectedDiscard' = rejectedDiscard,
  }
  action invalidateSnapshot = all {
    not(applied),
    ready' = ready, waited' = waited, replaying' = replaying, applied' = applied,
    eligible' = false, rejectedDiscard' = rejectedDiscard,
  }
  action tick = {
    val service = (ready or START_BEFORE_TARGET) and (eligible or not(CHECK_ELIGIBILITY))
    val expired = replaying and service and waited == LIMIT
    all {
      ready' = ready,
      waited' = if (replaying and service and waited < LIMIT) waited + 1 else waited,
      replaying' = (replaying and not(expired)),
      applied' = (applied or (ready and eligible and (not(replaying) or expired))),
      eligible' = eligible,
      rejectedDiscard' = (rejectedDiscard or (expired and not(eligible))),
    }
  }
  action step = any { reachBoundary, completeReplay, invalidateSnapshot, tick }

  val futureStateHasNoReplayDeadline = ready or waited == 0
  val rejectedStateKeepsReplay = not(rejectedDiscard)

  run unavailableInstallBufferTest =
    init.then(reachBoundary).then(invalidateSnapshot).then(tick).then(tick).then(tick)
      .expect(replaying == CHECK_ELIGIBILITY and not(applied))

  run invalidatedWhileWaitingTest =
    init.then(reachBoundary).then(tick).then(invalidateSnapshot).then(tick).then(tick)
      .expect(replaying == CHECK_ELIGIBILITY and not(applied))

  run futureStateKeepsReplayTest =
    init.then(tick).then(tick).then(tick)
      .expect(replaying == not(START_BEFORE_TARGET) and not(applied))
      .then(reachBoundary)
      .then(tick)
      .expect(applied == START_BEFORE_TARGET)
      .then(tick).then(tick)
      .expect(applied and not(replaying))
}

module resync_replay_boundary_before {
  import resync_replay_boundary(START_BEFORE_TARGET = true, CHECK_ELIGIBILITY = false).*
}

module resync_replay_boundary_fixed {
  import resync_replay_boundary(START_BEFORE_TARGET = false, CHECK_ELIGIBILITY = true).*
}

module resync_replay_boundary_revoked_before {
  import resync_replay_boundary(START_BEFORE_TARGET = false, CHECK_ELIGIBILITY = false).*
}
