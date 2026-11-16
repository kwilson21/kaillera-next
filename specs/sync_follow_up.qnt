// -*- mode: Bluespec; -*-
//
// The host's answer to a coordinated resync request, and the follow-up it
// sends when that answer went out unconfirmed: _dispatchScheduledSyncs,
// pushSyncState and _sendSyncChunksTo in web/static/netplay-rollback.js.
//
// A coordinated request (`sync-request-full-at:T`, from the guest's peer
// recovery or its desync check) is answered with the host's state at T once
// T is confirmed, or at the request's deadline (SYNC_COORD_TIMEOUT_MS) at the
// frame the host has reached, confirmed or not. A state taken while some
// input at or before its frame F was still predicted can change: when that
// input arrives and differs from the prediction, the host rolls back (or
// cannot: DEEP-MISPREDICT-SKIP) and its own state at F is no longer the one
// it sent. So the host follows an unconfirmed answer with a fresh state,
// sent once confirmed or at its own deadline, at most SYNC_FOLLOW_UP_MAX in
// a row.
//
// Today the follow-up always goes out, even when every input at or before F
// arrived as predicted and the guest already has the right state: a second
// full state (1.4 MB compressed, 8 MB raw) under the same request number,
// found in a run of UNANSWERED_SOCKET_RESYNC=letgo (2026-11). The fix sends
// it only when an input at or before F differed from its prediction after
// the state was taken. Taken, not sent: the state is compressed between the
// two (~170 ms), and a misprediction in that window changes F as much as one
// after the send (FLAG_FROM_TAKEN).
//
// A follow-up dispatched at its deadline while F is still unconfirmed cannot
// know whether F will change, so it is sent; it is itself unconfirmed and is
// followed up in turn, within the bound.
//
// The host never pushes two states at once (_pushingSyncState), and since
// #236 hands a state's chunks to the channel only while less than the low
// water mark is queued (web/src/sync-send.ts). So at most one answer is in
// flight to the guest; the model keeps that as a property, so a change that
// sends answers side by side shows up here.
//
// What is modelled: one guest; the inputs at or before the sent frame that
// are still predicted when its state is taken, each arriving later as
// predicted or not; the take, the send, the channel draining, confirmation,
// the follow-up's deadline, and the bound on follow-ups.
//
// Not modelled: the guest applying a state (it applies each in order; the
// guest's side is specs/resync_flow.qnt). Whether the guest moves back to
// F or, since #261, applies the state at F and runs the frames up to its
// own again unseen (CATCH_UP, theGuestIsNeverRewound), it starts from the
// state sent for F. So whether that state is still the host's, the one
// thing a follow-up decides, is the same either way; a follow-up, skipped
// or sent, is applied the same way as the answer. More than one guest, a channel
// closing (resetPeerState drops the request, I2), and the rollback itself
// (only whether the host's state at F changed).
//
// SKIP_UNCHANGED: a follow-up whose frame is confirmed is sent only if an
//   input at or before F differed from its prediction after the state was
//   taken. The fix.
//
// FLAG_FROM_TAKEN: that difference is recorded from the moment the state is
//   taken. Without it, from the send only: a misprediction while the state
//   is being compressed is missed.

module sync_follow_up {
  const SKIP_UNCHANGED: bool
  const FLAG_FROM_TAKEN: bool

  pure val FOLLOW_UP_MAX = 3
  // Inputs at or before the frame that may still be predicted (bound for the model).
  pure val MAX_PENDING = 2

  // "idle": nothing out. "taken": the state is taken and being compressed.
  // "sending": its chunks are on the channel. "waiting": sent unconfirmed, a
  // follow-up scheduled. "done": answered for good, or follow-ups exhausted.
  var phase: str
  var pending: int        // inputs at or before F still predicted
  var changed: bool       // the host's state at F is no longer the one taken (the truth)
  var flagged: bool       // what the host recorded of that
  var confirmedAtTake: bool
  var inFlight: int       // answers on the channel to the guest
  var followUps: int
  var guestRight: bool    // the last state sent is the host's state at its frame now
  var wasted: bool        // a follow-up went out for a frame that had not changed
  var gaveUp: bool        // follow-ups exhausted with the frame unconfirmed

  action initWith(p: int): bool = all {
    phase' = "idle",
    pending' = p,
    changed' = false, flagged' = false, confirmedAtTake' = false,
    inFlight' = 0, followUps' = 0, guestRight' = false, wasted' = false, gaveUp' = false,
  }

  action init = {
    nondet p = 0.to(MAX_PENDING).oneOf()
    initWith(p)
  }

  // The request is answered: the state at F is taken (kn_sync_read). From
  // here a misprediction at or before F changes it.
  action take = all {
    phase == "idle",
    inFlight == 0,
    phase' = "taken",
    changed' = false, flagged' = false,
    confirmedAtTake' = pending == 0,
    pending' = pending, inFlight' = inFlight, followUps' = followUps, guestRight' = guestRight,
    wasted' = wasted, gaveUp' = gaveUp,
  }

  // Compressed and handed to the channel.
  action send = all {
    phase == "taken",
    phase' = "sending",
    inFlight' = inFlight + 1,
    guestRight' = not(changed),
    pending' = pending, changed' = changed, flagged' = flagged, confirmedAtTake' = confirmedAtTake,
    followUps' = followUps, wasted' = wasted, gaveUp' = gaveUp,
  }

  // The last chunk leaves the channel. Unconfirmed: a follow-up is scheduled.
  action drained = all {
    phase == "sending",
    inFlight' = inFlight - 1,
    phase' = if (confirmedAtTake) "done" else "waiting",
    pending' = pending, changed' = changed, flagged' = flagged, confirmedAtTake' = confirmedAtTake,
    followUps' = followUps, guestRight' = guestRight, wasted' = wasted, gaveUp' = gaveUp,
  }

  // A predicted input at or before F arrives, as predicted or not.
  action inputArrives(differs: bool): bool = all {
    pending > 0,
    phase != "done",
    pending' = pending - 1,
    val after = phase != "idle"
    val records = if (FLAG_FROM_TAKEN) after else phase == "sending" or phase == "waiting"
    all {
      changed' = (changed or (differs and after)),
      flagged' = (flagged or (differs and records)),
      // The guest's state stops matching the host's once F changes.
      guestRight' = (guestRight and not(differs and after)),
    },
    phase' = phase, confirmedAtTake' = confirmedAtTake, inFlight' = inFlight,
    followUps' = followUps, wasted' = wasted, gaveUp' = gaveUp,
  }

  // F is confirmed and the follow-up is due: sent fresh (confirmed now, so
  // final), or, with SKIP_UNCHANGED and nothing recorded, not sent.
  action followUpConfirmed = all {
    phase == "waiting",
    pending == 0,
    followUps < FOLLOW_UP_MAX,
    val sends = not(SKIP_UNCHANGED) or flagged
    all {
      phase' = if (sends) "sending" else "done",
      inFlight' = if (sends) inFlight + 1 else inFlight,
      followUps' = if (sends) followUps + 1 else followUps,
      guestRight' = if (sends) true else guestRight,
      wasted' = (wasted or (sends and not(changed))),
      confirmedAtTake' = if (sends) true else confirmedAtTake,
      changed' = if (sends) false else changed,
      flagged' = if (sends) false else flagged,
    },
    pending' = pending, gaveUp' = gaveUp,
  }

  // The follow-up's deadline with F still unconfirmed: a fresh state is
  // taken at the frame reached, itself unconfirmed. Past the bound, nothing
  // more is sent.
  action followUpDeadline = all {
    phase == "waiting",
    pending > 0,
    if (followUps < FOLLOW_UP_MAX) all {
      phase' = "taken",
      followUps' = followUps + 1,
      changed' = false, flagged' = false, confirmedAtTake' = false,
      gaveUp' = gaveUp,
    } else all {
      phase' = "done",
      followUps' = followUps,
      changed' = changed, flagged' = flagged, confirmedAtTake' = confirmedAtTake,
      gaveUp' = true,
    },
    pending' = pending, inFlight' = inFlight, guestRight' = guestRight, wasted' = wasted,
  }

  action nothingHappens = all {
    phase' = phase, pending' = pending, changed' = changed, flagged' = flagged,
    confirmedAtTake' = confirmedAtTake, inFlight' = inFlight, followUps' = followUps,
    guestRight' = guestRight, wasted' = wasted, gaveUp' = gaveUp,
  }

  action step = any {
    take, send, drained, followUpConfirmed, followUpDeadline,
    nondet differs = oneOf(Set(true, false))
    inputArrives(differs),
    // Nothing more to do: stutter so a run can end here.
    all { phase == "done", pending == 0, nothingHappens },
  }

  // ── properties ─────────────────────────────────────────────────────────

  // At most one answer is on the channel to the guest at a time.
  val atMostOneAnswerInFlight = inFlight <= 1

  // A follow-up whose frame is confirmed goes out only for a state that
  // changed. Violated today: it always goes out (unchangedFollowUpTest).
  val aFollowUpCarriesANewState = not(wasted)

  // Once nothing more is coming, the guest has the host's state, unless the
  // follow-ups ran out with the frame unconfirmed (visible: gaveUp).
  // Violated when the difference is recorded only from the send
  // (mispredictWhileCompressingTest).
  val theGuestEndsOnTheHostsState = (phase == "done" and pending == 0 and not(gaveUp)) implies guestRight

  val followUpsAreBounded = followUps <= FOLLOW_UP_MAX

  val allHold = atMostOneAnswerInFlight and aFollowUpCarriesANewState and theGuestEndsOnTheHostsState and
    followUpsAreBounded

  // ── scenarios ──────────────────────────────────────────────────────────

  // One input still predicted when the state is taken; it arrives as
  // predicted. Today a second full state goes out; fixed, none.
  run unchangedFollowUpTest =
    initWith(1)
      .then(take).then(send).then(drained)
      .expect(phase == "waiting")
      .then(inputArrives(false))
      .then(followUpConfirmed)
      .expect(aFollowUpCarriesANewState == SKIP_UNCHANGED)
      .expect(if (SKIP_UNCHANGED) phase == "done" and followUps == 0 and guestRight else followUps == 1)

  // The input arrives and differs after the send: the follow-up goes out
  // and carries the host's new state.
  run changedFollowUpTest =
    initWith(1)
      .then(take).then(send).then(drained)
      .then(inputArrives(true))
      .expect(not(guestRight))
      .then(followUpConfirmed)
      .expect(followUps == 1 and phase == "sending")
      .then(drained)
      .expect(phase == "done" and guestRight and allHold)

  // The input differs while the state is being compressed, before the send.
  // Recorded from the send only, the follow-up is skipped and the guest is
  // left on a state the host no longer has.
  run mispredictWhileCompressingTest =
    initWith(1)
      .then(take)
      .then(inputArrives(true))
      .then(send).then(drained)
      .then(followUpConfirmed)
      .expect(theGuestEndsOnTheHostsState == (FLAG_FROM_TAKEN or not(SKIP_UNCHANGED)))

  // Confirmed when taken: answered once, no follow-up.
  run confirmedAnswerTest =
    initWith(0)
      .then(take).then(send).then(drained)
      .expect(phase == "done" and followUps == 0 and guestRight and allHold)

  // Still unconfirmed at every deadline: fresh states up to the bound, then
  // given up visibly.
  run unconfirmedToTheBoundTest =
    initWith(1)
      .then(take).then(send).then(drained)
      .then(followUpDeadline).then(send).then(drained)
      .then(followUpDeadline).then(send).then(drained)
      .then(followUpDeadline).then(send).then(drained)
      .expect(followUps == FOLLOW_UP_MAX and phase == "waiting")
      .then(followUpDeadline)
      .expect(phase == "done" and gaveUp and followUpsAreBounded)
}

// Today: every unconfirmed answer is followed up.
module sync_follow_up_current {
  import sync_follow_up(SKIP_UNCHANGED = false, FLAG_FROM_TAKEN = true).*
}

// Skipping an unchanged follow-up, the difference recorded from the send only.
module sync_follow_up_from_send {
  import sync_follow_up(SKIP_UNCHANGED = true, FLAG_FROM_TAKEN = false).*
}

// The fix.
module sync_follow_up_fixed {
  import sync_follow_up(SKIP_UNCHANGED = true, FLAG_FROM_TAKEN = true).*
}
