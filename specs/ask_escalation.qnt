// -*- mode: Bluespec; -*-
//
// An ask for a missing input that is never answered (`resend:<frame>`,
// _askForMissingInputs in web/static/netplay-rollback.js), and what follows.
//
// A page missing a peer's input asks for it every 500 ms (RB-INPUT-ASK) and
// meanwhile predicts it. If the answer never comes (the input went out on a
// channel that died, or the ask did), it predicted that input for the rest of
// the match: the peer ran on its real value, and nothing corrected the
// difference (#272's HEAL_BOTH_SIDES run: the host asked the guest for 1817
// twice, then the pages split at 1821).
//
// ESCALATE: after MIN_ASKS asks and MIN_AGE since the first (3 asks over
//   1.5 s: an answer comes in under 170 ms in good runs, and asks go out
//   every 500 ms, so a slow answer is never mistaken for a lost one), the
//   page escalates to a resync, decided by KNCore resyncRequest
//   (overdueAskStep): the host pushes its state to that guest unasked
//   (pushSyncState(sid, false), which the guest applies as a state the host
//   sent for its own reasons); a guest asks for a coordinated resync (#257's
//   owed request, with its own deadline). Both pages end on the host's
//   state, which holds the host's prediction of the input: they agree.
//
// PUSH_HAS_DEADLINE: the host's push is answered by the guest's
//   `inputs-settled:` (it applied the state); without it by the deadline the
//   host pushes again, up to MAX_PUSHES, then drops the player through the
//   normal path (hardDisconnectPeer, the player told why), who rejoins onto
//   the host's state (pushDeadlineStep). An event alone would leave the guest
//   playing on split. Without the deadline a lost push was the end of it.
//
// A second way in: the input arrives, but past the rollback window and
// different from what was predicted (C's DEEP-MISPREDICT-SKIP: too deep to
// roll back). It cannot be applied, so the pages have split for certain.
// That was silent until the hashes diverged; it is now logged
// (INPUT-PAST-WINDOW-MISMATCH) and is overdue at once, escalating as an
// unanswered ask does (lateMismatchTest).
//
// What is modelled: one ask for one input; its answer arriving or being
// lost for good; the escalation; the push, its acknowledgement arriving or
// being lost, its deadline and retry. Time is abstract: `aged` turns true
// once MIN_AGE has passed since the first ask.
//
// Not modelled: the guest's coordinated request's own deadline (specs/
// resync_reask.qnt), the transfer of the state itself (specs/
// sync_follow_up.qnt), more than one missing input (each is the same).

module ask_escalation {
  const ESCALATE: bool
  const PUSH_HAS_DEADLINE: bool
  const IS_HOST: bool

  pure val MIN_ASKS = 3
  pure val MAX_ASKS = 6        // asks go on every 500 ms; bounded for the model
  pure val MAX_PUSHES = 3

  var asks: int
  var aged: bool              // MIN_AGE has passed since the first ask
  var answered: bool          // the input arrived
  var lost: bool              // the answer will never come (its channel died)
  var resyncOut: bool         // a push (host) or a coordinated request (guest) is out
  var pushes: int
  var ackLost: bool           // this push's acknowledgement will never come
  var applied: bool           // the resync was applied: both pages on the host's state
  var dropped: bool           // the host gave up pushing and dropped the player

  action init = all {
    asks' = 0, aged' = false, answered' = false, lost' = false,
    resyncOut' = false, pushes' = 0, ackLost' = false, applied' = false, dropped' = false,
  }

  def open: bool = not(answered) and not(applied) and not(dropped)

  action ask = all {
    open, not(resyncOut), asks < MAX_ASKS,
    asks' = asks + 1,
    aged' = aged, answered' = answered, lost' = lost, resyncOut' = resyncOut,
    pushes' = pushes, ackLost' = ackLost, applied' = applied, dropped' = dropped,
  }

  action age = all {
    open, asks > 0, not(aged),
    aged' = true,
    asks' = asks, answered' = answered, lost' = lost, resyncOut' = resyncOut,
    pushes' = pushes, ackLost' = ackLost, applied' = applied, dropped' = dropped,
  }

  action answer = all {
    open, asks > 0, not(lost),
    answered' = true,
    asks' = asks, aged' = aged, lost' = lost, resyncOut' = resyncOut,
    pushes' = pushes, ackLost' = ackLost, applied' = applied, dropped' = dropped,
  }

  // It came, past the rollback window and different: as good as lost, and
  // overdue at once.
  action lateMismatch = all {
    open, not(lost),
    lost' = true,
    asks' = if (asks < MIN_ASKS) MIN_ASKS else asks,
    aged' = true,
    answered' = answered, resyncOut' = resyncOut,
    pushes' = pushes, ackLost' = ackLost, applied' = applied, dropped' = dropped,
  }

  action loseAnswer = all {
    open, not(lost), not(answered),
    lost' = true,
    asks' = asks, aged' = aged, answered' = answered, resyncOut' = resyncOut,
    pushes' = pushes, ackLost' = ackLost, applied' = applied, dropped' = dropped,
  }

  // overdueAskStep: 'push' (host) or 'ask' (guest) once both thresholds pass.
  def overdue: bool = asks >= MIN_ASKS and aged
  action escalate = all {
    ESCALATE, open, not(resyncOut), overdue,
    resyncOut' = true,
    pushes' = if (IS_HOST) pushes + 1 else pushes,
    ackLost' = false,
    asks' = asks, aged' = aged, answered' = answered, lost' = lost,
    applied' = applied, dropped' = dropped,
  }

  // The state arrives and is applied; the guest's `inputs-settled:` (host's
  // push) or the answer (guest's request) ends it.
  action applyResync = all {
    resyncOut, not(applied), not(ackLost),
    applied' = true, resyncOut' = false,
    asks' = asks, aged' = aged, answered' = answered, lost' = lost,
    pushes' = pushes, ackLost' = ackLost, dropped' = dropped,
  }

  // The push (or its acknowledgement) is lost.
  action loseAck = all {
    resyncOut, not(applied), not(ackLost), IS_HOST,
    ackLost' = true,
    asks' = asks, aged' = aged, answered' = answered, lost' = lost,
    resyncOut' = resyncOut, pushes' = pushes, applied' = applied, dropped' = dropped,
  }

  // pushDeadlineStep: push again, or give up visibly after MAX_PUSHES.
  action pushDeadline = all {
    PUSH_HAS_DEADLINE, IS_HOST, resyncOut, ackLost, not(applied),
    pushes' = if (pushes < MAX_PUSHES) pushes + 1 else pushes,
    ackLost' = false,
    dropped' = pushes >= MAX_PUSHES,
    resyncOut' = pushes < MAX_PUSHES,
    asks' = asks, aged' = aged, answered' = answered, lost' = lost, applied' = applied,
  }

  // Nothing happens (keeps the checker from calling a finished run a deadlock;
  // everyAskEnds does not count it as a move).
  action stutter = all {
    asks' = asks, aged' = aged, answered' = answered, lost' = lost, resyncOut' = resyncOut,
    pushes' = pushes, ackLost' = ackLost, applied' = applied, dropped' = dropped,
  }

  action step = any { ask, age, answer, loseAnswer, lateMismatch, escalate, applyResync, loseAck, pushDeadline, stutter }

  // ── Properties ───────────────────────────────────────────────────────────

  def canMove: bool = or {
    open and not(resyncOut) and asks < MAX_ASKS,
    open and asks > 0 and not(aged),
    open and asks > 0 and not(lost),
    ESCALATE and open and not(resyncOut) and overdue,
    resyncOut and not(applied) and not(ackLost),
    PUSH_HAS_DEADLINE and IS_HOST and resyncOut and ackLost and not(applied),
  }
  // Every ask ends: answered, a resync applied, or the player dropped (to
  // rejoin onto the host's state). Never a page predicting that input for
  // the rest of the match, and never two pages playing on split.
  val everyAskEnds = canMove or answered or applied or dropped
  // No escalation before both thresholds: a slow answer is not a lost one.
  val noEarlyEscalation = (resyncOut or applied) implies (asks >= MIN_ASKS and aged)
  // The host never pushes more than MAX_PUSHES times.
  val pushesAreBounded = pushes <= MAX_PUSHES

  val allHold = and { everyAskEnds, noEarlyEscalation, pushesAreBounded }

  // ── Scenarios ────────────────────────────────────────────────────────────

  // The answer is lost for good; the page asks until it stops.
  run lostForGoodTest =
    init.then(ask).then(loseAnswer).then(ask).then(ask).then(age)
      .then(ask).then(ask).then(ask)
      .expect(everyAskEnds == ESCALATE)

  // A late input that differs past the window: escalated at once (today: the
  // split nothing corrects).
  run lateMismatchTest =
    if (ESCALATE)
      init.then(lateMismatch).then(escalate).then(applyResync)
        .expect(applied and allHold)
    else
      init.then(lateMismatch).expect(not(everyAskEnds) or canMove)

  // A slow answer after one ask never escalates.
  run slowAnswerTest =
    init.then(ask).then(answer)
      .expect(answered and not(resyncOut) and allHold)

  // The escalation's push, its acknowledgement lost, then pushed again.
  run pushAckLostTest =
    if (ESCALATE and IS_HOST)
      init.then(ask).then(loseAnswer).then(ask).then(ask).then(age).then(escalate)
        .then(loseAck)
        .expect(everyAskEnds == PUSH_HAS_DEADLINE)
    else
      init.then(ask)
}

// Today: an unanswered ask is predicted for the rest of the match.
module ask_escalation_current {
  import ask_escalation(ESCALATE = false, PUSH_HAS_DEADLINE = false, IS_HOST = true).*
}

// Escalating, but a lost push is the end of it.
module ask_escalation_push_once {
  import ask_escalation(ESCALATE = true, PUSH_HAS_DEADLINE = false, IS_HOST = true).*
}

// The fix, on the host (push) and on a guest (coordinated request).
module ask_escalation_fixed_host {
  import ask_escalation(ESCALATE = true, PUSH_HAS_DEADLINE = true, IS_HOST = true).*
}

module ask_escalation_fixed_guest {
  import ask_escalation(ESCALATE = true, PUSH_HAS_DEADLINE = true, IS_HOST = false).*
}
