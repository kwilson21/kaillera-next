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
// A direct answer to a guest that is a
// phantom gets no follow-up: its recovery replaces any request queued for it
// with its own resync (directFollowUpDue in web/src/sync-follow-up.ts).
//
// The input delay: an input labelled f first runs at frame f + DELAY, so the
// state at the start of F (the state taken for F) depends only on inputs
// labelled at most F - 1 - DELAY. One labelled F - DELAY .. F runs at F or
// later: it differing from its prediction leaves the state sent for F as it
// was. The model labels each arriving input by its offset below F (0 = F
// itself).
//
// DELAY_AWARE: the host records a difference only for an input labelled at
//   most F - 1 - DELAY (changesWatchedFrame's delay). Without it (today), every
//   input at or before F counts: one in the band F - DELAY .. F sends a
//   follow-up that carries no new state, a full state for nothing. Every live
//   SYNC_FOLLOW_UP run before this fix hit that band (its misprediction's
//   replay target was F itself).
//
// OWED_AT_TAKE: a state taken while the host still owes a correction (a
//   rollback pending in C, a replay in flight, or a deferred replay out to the
//   shadow worker) is already not the host's: the input that differed was fed
//   before the watch existed, so no later feed flags it. With OWED_AT_TAKE the
//   watch starts changed. Without it (today) the follow-up is skipped once
//   the frame is confirmed, and the guest keeps a state the host itself
//   rolls back. Before DELAY_AWARE, an input in the band F - DELAY .. F that
//   arrived later sometimes flagged it by accident; DELAY_AWARE removes that
//   cover, so the two go together (owedAtTakeTest).
//
// SKIP_UNCHANGED: a follow-up whose frame is confirmed is sent only if an
//   input at or before F differed from its prediction after the state was
//   taken. The fix.
//
// FLAG_FROM_TAKEN: that difference is recorded from the moment the state is
//   taken. Without it, from the send only: a misprediction while the state
//   is being compressed is missed.
//
// SOCKET_WATCHED, SOCKET_DELIVERED: the same request asked and answered over
//   the signaling socket (`sync-request-full-socket`: the guest's return from a
//   hidden tab, a chunk timeout, a missing delta base, the re-ask fallback) is
//   watched and followed up like a direct one, over the socket, and its send
//   records the state as delivered so an unchanged follow-up can be skipped.
//   Today it is neither (#305 review).
//
// SOCKET_FOLLOW_UP_BY_SOCKET: that follow-up goes back over the socket, the
//   way the request came. Without it, _dispatchScheduledSyncs sends it on the
//   channel only, and holds it while the channel is not open (`reachable`):
//   the channel being down is why the guest asked over the socket, so the
//   follow-up can wait for good (I1). From #307's model.
//
// DIRECT_WATCHED: a direct request (`sync-request-full`, no target frame:
//   the guest's BOOT-SYNC after a late join, reconnect, visibility and
//   network change) is answered at once at the frame the host has reached,
//   and is watched and followed up like a coordinated answer. Without it
//   (today), the direct answer is final however unconfirmed: a late joiner
//   whose BOOT-SYNC was answered while the host still predicted its input,
//   with that prediction wrong, played on split for the rest of the match
//   (ASK_UNANSWERED_ACKS on 3cdb9ff, 2026-11: taken at 1986 with the host
//   confirmed to 1972; MISPREDICTION slot=1 f=1977 replayed 47 ms later).

module sync_follow_up {
  const SKIP_UNCHANGED: bool
  const FLAG_FROM_TAKEN: bool
  const DIRECT_WATCHED: bool
  const SOCKET_WATCHED: bool
  const SOCKET_DELIVERED: bool
  const SOCKET_FOLLOW_UP_BY_SOCKET: bool
  const DELAY_AWARE: bool
  const OWED_AT_TAKE: bool

  pure val FOLLOW_UP_MAX = 3
  // Inputs at or before the frame that may still be predicted (bound for the model).
  pure val MAX_PENDING = 2
  // The input delay (DELAY_FRAMES); the model's inputs are labelled from F
  // down to F - 1 - DELAY, the first that can change the state at F.
  pure val DELAY = 2
  pure val MAX_OFFSET = DELAY + 1
  // Whether an input labelled `offset` frames before F ran before F: the
  // state taken for F depends on it.
  pure def runsBeforeF(offset: int): bool = offset >= DELAY + 1

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
  var direct: bool        // the request had no target frame (answered at once)
  var viaSocket: bool     // asked and answered over the signaling socket
  var dcOpen: bool        // the guest's data channel to the host is open
  var owed: bool          // an input that ran differed, and the host has not yet corrected for it

  action initWith(p: int, d: bool): bool = all {
    phase' = "idle",
    pending' = p,
    direct' = d,
    viaSocket' = false,
    dcOpen' = true,
    owed' = false,
    changed' = false, flagged' = false, confirmedAtTake' = false,
    inFlight' = 0, followUps' = 0, guestRight' = false, wasted' = false, gaveUp' = false,
  }

  // Asked over the socket: the guest's channel may be down (`open`).
  action initWithSocket(p: int, open: bool): bool = all {
    phase' = "idle",
    pending' = p,
    direct' = true,
    viaSocket' = true,
    dcOpen' = open,
    owed' = false,
    changed' = false, flagged' = false, confirmedAtTake' = false,
    inFlight' = 0, followUps' = 0, guestRight' = false, wasted' = false, gaveUp' = false,
  }

  action init = {
    nondet p = 0.to(MAX_PENDING).oneOf()
    nondet d = oneOf(Set(true, false))
    nondet sock = oneOf(Set(true, false))
    nondet open = oneOf(Set(true, false))
    if (d and sock) initWithSocket(p, open) else initWith(p, d)
  }

  // The request is answered: the state at F is taken (kn_sync_read). From
  // here a misprediction at or before F changes it.
  // Taken while a correction is owed, the state is already not the host's.
  action take = all {
    phase == "idle",
    inFlight == 0,
    phase' = "taken",
    changed' = owed, flagged' = (OWED_AT_TAKE and owed),
    // Confirmed only with every input in and nothing left to correct
    // (_liveStateConfirmed).
    confirmedAtTake' = (pending == 0 and not(owed)),
    pending' = pending, inFlight' = inFlight, followUps' = followUps, guestRight' = guestRight,
    wasted' = wasted, gaveUp' = gaveUp, direct' = direct, viaSocket' = viaSocket, dcOpen' = dcOpen, owed' = owed,
  }

  // Compressed and handed to the channel.
  action send = all {
    phase == "taken",
    phase' = "sending",
    inFlight' = inFlight + 1,
    guestRight' = not(changed),
    pending' = pending, changed' = changed, flagged' = flagged, confirmedAtTake' = confirmedAtTake,
    followUps' = followUps, wasted' = wasted, gaveUp' = gaveUp, direct' = direct, viaSocket' = viaSocket, dcOpen' = dcOpen, owed' = owed,
  }

  // The last chunk leaves the channel. Unconfirmed: a follow-up is scheduled.
  action drained = all {
    phase == "sending",
    inFlight' = inFlight - 1,
    // A direct answer is followed up only when watched: DIRECT_WATCHED on
    // the data channel, SOCKET_WATCHED over the signaling socket.
    val watched = if (viaSocket) SOCKET_WATCHED else DIRECT_WATCHED
    phase' = if (confirmedAtTake or (direct and not(watched))) "done" else "waiting",
    pending' = pending, changed' = changed, flagged' = flagged, confirmedAtTake' = confirmedAtTake,
    followUps' = followUps, guestRight' = guestRight, wasted' = wasted, gaveUp' = gaveUp, direct' = direct, viaSocket' = viaSocket, dcOpen' = dcOpen, owed' = owed,
  }

  // A predicted input at or before F, labelled `offset` frames before it,
  // arrives, as predicted or not. It changes the state at F only if it ran
  // before F.
  action inputArrives(differs: bool, offset: int): bool = all {
    // Inputs keep arriving whatever became of the answer.
    pending > 0,
    pending' = pending - 1,
    val after = phase != "idle"
    val records = if (FLAG_FROM_TAKEN) after else phase == "sending" or phase == "waiting"
    val changes = differs and after and runsBeforeF(offset)
    // What the host counts: with DELAY_AWARE the same test as the truth;
    // without, any input at or before F that differed.
    val counts = differs and records and (runsBeforeF(offset) or not(DELAY_AWARE))
    all {
      changed' = (changed or changes),
      flagged' = (flagged or counts),
      // The guest's state stops matching the host's once F changes.
      guestRight' = (guestRight and not(changes)),
    },
    phase' = phase, confirmedAtTake' = confirmedAtTake, inFlight' = inFlight,
    followUps' = followUps, wasted' = wasted, gaveUp' = gaveUp, direct' = direct, viaSocket' = viaSocket, dcOpen' = dcOpen, // Fed: C owes a rollback for it until its next tick.
    owed' = (owed or (differs and runsBeforeF(offset))),
  }

  // The host's next tick: the owed rollback runs (or a replay ends). The
  // state at F becomes the corrected one; a state already taken is not.
  action correct = all {
    owed,
    owed' = false,
    phase' = phase, pending' = pending, changed' = changed, flagged' = flagged,
    confirmedAtTake' = confirmedAtTake, inFlight' = inFlight, followUps' = followUps,
    guestRight' = guestRight, wasted' = wasted, gaveUp' = gaveUp, direct' = direct, viaSocket' = viaSocket, dcOpen' = dcOpen,
  }

  // Where a waiting follow-up can go: back over the socket, or the channel
  // while it is open. The dispatcher holds one it cannot reach, with no
  // deadline (`reachable`).
  val followUpReachable = (viaSocket and SOCKET_FOLLOW_UP_BY_SOCKET) or dcOpen

  // F is confirmed and the follow-up is due: sent fresh (confirmed now, so
  // final), or, with SKIP_UNCHANGED and nothing recorded, not sent.
  action followUpConfirmed = all {
    phase == "waiting",
    followUpReachable,
    pending == 0,
    not(owed),
    followUps < FOLLOW_UP_MAX,
    // Skipped only for a state recorded as handed over whole: a socket send
    // records it only with SOCKET_DELIVERED.
    val delivered = not(viaSocket) or SOCKET_DELIVERED
    val sends = not(SKIP_UNCHANGED) or flagged or not(delivered)
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
    pending' = pending, gaveUp' = gaveUp, direct' = direct, viaSocket' = viaSocket, dcOpen' = dcOpen, owed' = owed,
  }

  // The follow-up's deadline with F still unconfirmed: a fresh state is
  // taken at the frame reached, itself unconfirmed. Past the bound, nothing
  // more is sent.
  action followUpDeadline = all {
    phase == "waiting",
    followUpReachable,
    pending > 0,
    if (followUps < FOLLOW_UP_MAX) all {
      phase' = "taken",
      followUps' = followUps + 1,
      changed' = owed, flagged' = (OWED_AT_TAKE and owed), confirmedAtTake' = false,
      gaveUp' = gaveUp,
    } else all {
      phase' = "done",
      followUps' = followUps,
      changed' = changed, flagged' = flagged, confirmedAtTake' = confirmedAtTake,
      gaveUp' = true,
    },
    pending' = pending, inFlight' = inFlight, guestRight' = guestRight, wasted' = wasted, direct' = direct, viaSocket' = viaSocket, dcOpen' = dcOpen, owed' = owed,
  }

  action nothingHappens = all {
    phase' = phase, pending' = pending, changed' = changed, flagged' = flagged,
    confirmedAtTake' = confirmedAtTake, inFlight' = inFlight, followUps' = followUps,
    guestRight' = guestRight, wasted' = wasted, gaveUp' = gaveUp, direct' = direct, viaSocket' = viaSocket, dcOpen' = dcOpen, owed' = owed,
  }

  action step = any {
    take, send, drained, followUpConfirmed, followUpDeadline, correct,
    nondet differs = oneOf(Set(true, false))
    nondet offset = 0.to(MAX_OFFSET).oneOf()
    inputArrives(differs, offset),
    // Nothing more to do: stutter so a run can end here.
    all { phase == "done", pending == 0, not(owed), nothingHappens },
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

  // A waiting follow-up can be handed to a transport. Held for a channel
  // that is not open, it waits with no deadline: the guest asked over the
  // socket because that channel was down (I1). Violated when the follow-up
  // of a socket answer goes on the channel only (socketUnconfirmedAnswerTest).
  val aWatchedAnswerCanBeFollowedUp = phase == "waiting" implies followUpReachable

  val allHold = atMostOneAnswerInFlight and aFollowUpCarriesANewState and theGuestEndsOnTheHostsState and
    followUpsAreBounded and aWatchedAnswerCanBeFollowedUp

  // ── scenarios ──────────────────────────────────────────────────────────

  // One input still predicted when the state is taken; it arrives as
  // predicted. Today a second full state goes out; fixed, none.
  run unchangedFollowUpTest =
    initWith(1, false)
      .then(take).then(send).then(drained)
      .expect(phase == "waiting")
      .then(inputArrives(false, MAX_OFFSET))
      .then(followUpConfirmed)
      .expect(aFollowUpCarriesANewState == SKIP_UNCHANGED)
      .expect(if (SKIP_UNCHANGED) phase == "done" and followUps == 0 and guestRight else followUps == 1)

  // The input arrives and differs after the send: the follow-up goes out
  // and carries the host's new state.
  run changedFollowUpTest =
    initWith(1, false)
      .then(take).then(send).then(drained)
      .then(inputArrives(true, MAX_OFFSET)).then(correct)
      .expect(not(guestRight))
      .then(followUpConfirmed)
      .expect(followUps == 1 and phase == "sending")
      .then(drained)
      .expect(phase == "done" and guestRight and allHold)

  // The input differs while the state is being compressed, before the send.
  // Recorded from the send only, the follow-up is skipped and the guest is
  // left on a state the host no longer has.
  run mispredictWhileCompressingTest =
    initWith(1, false)
      .then(take)
      .then(inputArrives(true, MAX_OFFSET)).then(correct)
      .then(send).then(drained)
      .then(followUpConfirmed)
      .expect(theGuestEndsOnTheHostsState == (FLAG_FROM_TAKEN or not(SKIP_UNCHANGED)))

  // Confirmed when taken: answered once, no follow-up.
  run confirmedAnswerTest =
    initWith(0, false)
      .then(take).then(send).then(drained)
      .expect(phase == "done" and followUps == 0 and guestRight and allHold)

  // A direct request (BOOT-SYNC after a late join) answered while an input
  // was still predicted; the input differs after the answer went out. Today
  // the answer is final and the guest stays on a state the host no longer
  // has; watched, it is followed up with the host's state.
  run directUnconfirmedAnswerTest =
    initWith(1, true)
      .then(take).then(send).then(drained)
      .expect(phase == (if (DIRECT_WATCHED) "waiting" else "done"))
      .then(inputArrives(true, MAX_OFFSET)).then(correct)
      .then(if (DIRECT_WATCHED) followUpConfirmed.then(drained) else nothingHappens)
      .expect(theGuestEndsOnTheHostsState == DIRECT_WATCHED)

  // The same over the signaling socket (a guest back from a hidden tab, a
  // chunk timeout), its channel down: today never followed up. Watched, the
  // follow-up must go back over the socket: on the channel it is held for
  // good.
  run socketUnconfirmedAnswerTest =
    initWithSocket(1, false)
      .then(take).then(send).then(drained)
      .expect(phase == (if (SOCKET_WATCHED) "waiting" else "done"))
      .expect(aWatchedAnswerCanBeFollowedUp == (not(SOCKET_WATCHED) or SOCKET_FOLLOW_UP_BY_SOCKET))
      .then(inputArrives(true, MAX_OFFSET)).then(correct)
      .then(if (SOCKET_WATCHED and SOCKET_FOLLOW_UP_BY_SOCKET) followUpConfirmed.then(drained) else nothingHappens)
      .expect(phase == "done" implies (theGuestEndsOnTheHostsState == SOCKET_WATCHED))
      .expect((SOCKET_WATCHED and SOCKET_FOLLOW_UP_BY_SOCKET) implies (phase == "done" and guestRight and allHold))

  // The same with the channel open: on the channel or the socket, the
  // follow-up goes out.
  run socketFollowUpOverChannelTest =
    initWithSocket(1, true)
      .then(take).then(send).then(drained)
      .then(inputArrives(true, MAX_OFFSET)).then(correct)
      .then(if (SOCKET_WATCHED) followUpConfirmed.then(drained) else nothingHappens)
      .expect(theGuestEndsOnTheHostsState == SOCKET_WATCHED)

  // Watched over the socket but never recorded delivered: an unchanged
  // follow-up is not skipped, a full state sent for nothing.
  run socketUnchangedFollowUpTest =
    initWithSocket(1, true)
      .then(take).then(send).then(drained)
      .then(if (SOCKET_WATCHED) inputArrives(false, MAX_OFFSET).then(followUpConfirmed) else nothingHappens)
      .expect(aFollowUpCarriesANewState == ((SKIP_UNCHANGED and SOCKET_DELIVERED) or not(SOCKET_WATCHED)))

  // A direct request answered confirmed needs no follow-up either way.
  run directConfirmedAnswerTest =
    initWith(0, true)
      .then(take).then(send).then(drained)
      .expect(phase == "done" and followUps == 0 and guestRight and allHold)

  // The boundary: an input labelled F - DELAY (runs at F, after the state
  // was taken) differs. Today it sends a follow-up carrying the same state;
  // delay-aware, none goes out and the guest already has the host's state.
  run differsAtFMinusDelayTest =
    initWith(1, false)
      .then(take).then(send).then(drained)
      .then(inputArrives(true, DELAY))
      .expect(guestRight and not(changed))
      .expect(flagged == not(DELAY_AWARE))
      .then(followUpConfirmed)
      .expect(aFollowUpCarriesANewState == (DELAY_AWARE and SKIP_UNCHANGED))
      .expect(if (DELAY_AWARE and SKIP_UNCHANGED) phase == "done" and followUps == 0 and guestRight else followUps == 1)

  // The same for the frame F itself: it runs DELAY frames after F.
  run differsAtFTest =
    initWith(1, false)
      .then(take).then(send).then(drained)
      .then(inputArrives(true, 0))
      .expect(guestRight and flagged == not(DELAY_AWARE))
      .then(followUpConfirmed)
      .expect(aFollowUpCarriesANewState == (DELAY_AWARE and SKIP_UNCHANGED))

  // The other side of the boundary: an input labelled F - 1 - DELAY ran at
  // F - 1, so it differing changes the state at F. Flagged either way, and the
  // follow-up carries the host's new state.
  run differsAtFMinusOneMinusDelayTest =
    initWith(1, false)
      .then(take).then(send).then(drained)
      .then(inputArrives(true, DELAY + 1)).then(correct)
      .expect(changed and flagged and not(guestRight))
      .then(followUpConfirmed)
      .expect(followUps == 1 and phase == "sending" and not(wasted))
      .then(drained)
      .expect(phase == "done" and guestRight and allHold)

  // An input that ran before F differs and is fed; the host answers before its
  // next tick, with the rollback still owed. The state sent is not the
  // host's, and nothing fed after the take flags it. Flagged at the take,
  // the follow-up carries the corrected state; not flagged, it is skipped
  // once F is confirmed and the guest keeps a state the host rolled back.
  run owedAtTakeTest =
    initWith(1, false)
      .then(inputArrives(true, MAX_OFFSET))
      .expect(owed)
      .then(take)
      .expect(changed and flagged == OWED_AT_TAKE and not(confirmedAtTake))
      .then(send).then(drained)
      .expect(phase == "waiting" and not(guestRight))
      .then(correct)
      .then(followUpConfirmed)
      .then(if (phase == "sending") drained else nothingHappens)
      .expect(theGuestEndsOnTheHostsState == (OWED_AT_TAKE or not(SKIP_UNCHANGED)))

  // The rollback runs before the take: the state taken is corrected, and
  // needs no follow-up.
  run correctedBeforeTakeTest =
    initWith(1, false)
      .then(inputArrives(true, MAX_OFFSET))
      .then(correct)
      .then(take).then(send).then(drained)
      .expect(phase == "done" and guestRight and allHold)

  // Still unconfirmed at every deadline: fresh states up to the bound, then
  // given up visibly.
  run unconfirmedToTheBoundTest =
    initWith(1, false)
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
  import sync_follow_up(SKIP_UNCHANGED = false, FLAG_FROM_TAKEN = true, DIRECT_WATCHED = true, SOCKET_WATCHED = true, SOCKET_DELIVERED = true, SOCKET_FOLLOW_UP_BY_SOCKET = true, DELAY_AWARE = true, OWED_AT_TAKE = true).*
}

// Skipping an unchanged follow-up, the difference recorded from the send only.
module sync_follow_up_from_send {
  import sync_follow_up(SKIP_UNCHANGED = true, FLAG_FROM_TAKEN = false, DIRECT_WATCHED = true, SOCKET_WATCHED = true, SOCKET_DELIVERED = true, SOCKET_FOLLOW_UP_BY_SOCKET = true, DELAY_AWARE = true, OWED_AT_TAKE = true).*
}

// Today: coordinated answers are followed up only when changed, but a direct
// answer is never followed up (directUnconfirmedAnswerTest).
module sync_follow_up_direct_unwatched {
  import sync_follow_up(SKIP_UNCHANGED = true, FLAG_FROM_TAKEN = true, DIRECT_WATCHED = false, SOCKET_WATCHED = true, SOCKET_DELIVERED = true, SOCKET_FOLLOW_UP_BY_SOCKET = true, DELAY_AWARE = true, OWED_AT_TAKE = true).*
}

// Today: a direct answer over the signaling socket is never followed up.
module sync_follow_up_socket_unwatched {
  import sync_follow_up(SKIP_UNCHANGED = true, FLAG_FROM_TAKEN = true, DIRECT_WATCHED = true, SOCKET_WATCHED = false, SOCKET_DELIVERED = false, SOCKET_FOLLOW_UP_BY_SOCKET = false, DELAY_AWARE = true, OWED_AT_TAKE = true).*
}

// Watched over the socket, but its follow-up sent on the channel only: held
// for good while the channel is down (#307's variant).
module sync_follow_up_socket_over_channel {
  import sync_follow_up(SKIP_UNCHANGED = true, FLAG_FROM_TAKEN = true, DIRECT_WATCHED = true, SOCKET_WATCHED = true, SOCKET_DELIVERED = true, SOCKET_FOLLOW_UP_BY_SOCKET = false, DELAY_AWARE = true, OWED_AT_TAKE = true).*
}

// Watched over the socket, but its send not recorded as delivered.
module sync_follow_up_socket_undelivered {
  import sync_follow_up(SKIP_UNCHANGED = true, FLAG_FROM_TAKEN = true, DIRECT_WATCHED = true, SOCKET_WATCHED = true, SOCKET_DELIVERED = false, SOCKET_FOLLOW_UP_BY_SOCKET = true, DELAY_AWARE = true, OWED_AT_TAKE = true).*
}

// Today: every input at or before F counts as a change, the band
// F - DELAY .. F included (differsAtFMinusDelayTest), and a state taken with
// a correction owed is not flagged (owedAtTakeTest).
module sync_follow_up_delay_unaware {
  import sync_follow_up(SKIP_UNCHANGED = true, FLAG_FROM_TAKEN = true, DIRECT_WATCHED = true, SOCKET_WATCHED = true, SOCKET_DELIVERED = true, SOCKET_FOLLOW_UP_BY_SOCKET = true, DELAY_AWARE = false, OWED_AT_TAKE = false).*
}

// Delay-aware, but a state taken with a correction owed not flagged: the
// accidental cover the band gave is gone (owedAtTakeTest).
module sync_follow_up_owed_unflagged {
  import sync_follow_up(SKIP_UNCHANGED = true, FLAG_FROM_TAKEN = true, DIRECT_WATCHED = true, SOCKET_WATCHED = true, SOCKET_DELIVERED = true, SOCKET_FOLLOW_UP_BY_SOCKET = true, DELAY_AWARE = true, OWED_AT_TAKE = false).*
}

// The fix.
module sync_follow_up_fixed {
  import sync_follow_up(SKIP_UNCHANGED = true, FLAG_FROM_TAKEN = true, DIRECT_WATCHED = true, SOCKET_WATCHED = true, SOCKET_DELIVERED = true, SOCKET_FOLLOW_UP_BY_SOCKET = true, DELAY_AWARE = true, OWED_AT_TAKE = true).*
}

// Selecting a send and reading native state are separated by transfer admission.
// Replay can start between them, including while another transfer drains.
module sync_capture_boundary {
  const FENCE: bool
  var replaying: bool
  var admitted: bool
  var captured: bool
  var capturedDuringReplay: bool

  action init = all {
    replaying' = false,
    admitted' = false,
    captured' = false,
    capturedDuringReplay' = false,
  }

  action replay(active: bool): bool = all {
    replaying' = active,
    admitted' = admitted,
    captured' = captured,
    capturedDuringReplay' = capturedDuringReplay,
  }

  action admit = all {
    not(admitted),
    admitted' = true,
    replaying' = replaying,
    captured' = captured,
    capturedDuringReplay' = capturedDuringReplay,
  }

  action attemptCapture = all {
    admitted,
    admitted' = false,
    replaying' = replaying,
    captured' = not(FENCE and replaying),
    capturedDuringReplay' = (capturedDuringReplay or (replaying and not(FENCE))),
  }

  action step = any { replay(true), replay(false), admit, attemptCapture }

  val onlyStableSnapshots = not(capturedDuringReplay)

  run queuedAnswerDuringReplayTest =
    init.then(admit).then(replay(true)).then(attemptCapture)
      .expect(captured == not(FENCE) and onlyStableSnapshots == FENCE)
      .then(replay(false)).then(admit).then(attemptCapture)
      .expect(captured)
}

module sync_capture_boundary_before {
  import sync_capture_boundary(FENCE = false).*
}

module sync_capture_boundary_fixed {
  import sync_capture_boundary(FENCE = true).*
}

// Compression and per-recipient queueing happen before the first wire byte.
// An invalidated payload is refused at handoff. An already-started channel
// transfer finishes its framing and can still be corrected by a follow-up.
module sync_publication_boundary {
  const FENCE: bool
  var phase: str
  var invalidated: bool
  var publishedInvalid: bool

  action init = all {
    phase' = "captured",
    invalidated' = false,
    publishedInvalid' = false,
  }

  action invalidate = all {
    phase != "done",
    phase' = phase,
    invalidated' = true,
    publishedInvalid' = publishedInvalid,
  }

  action move(from: str, nextPhase: str): bool = all {
    phase == from,
    phase' = nextPhase,
    invalidated' = invalidated,
    publishedInvalid' = publishedInvalid,
  }

  action start = all {
    phase == "queued",
    phase' = if (FENCE and invalidated) "done" else "sending",
    invalidated' = invalidated,
    publishedInvalid' = (invalidated and not(FENCE)),
  }

  action step = any {
    invalidate,
    move("captured", "queued"),
    start,
    move("sending", "done"),
    move("done", "done"),
  }

  val onlyCurrentSnapshotsStart = not(publishedInvalid)

  run invalidationBeforeHandoffTest =
    init.then(invalidate).then(move("captured", "queued")).then(start)
      .expect(onlyCurrentSnapshotsStart == FENCE)

  run invalidationOnChainTest =
    init.then(move("captured", "queued")).then(invalidate).then(start)
      .expect(onlyCurrentSnapshotsStart == FENCE)

  run startedTransferDrainsTest =
    init.then(move("captured", "queued")).then(start).then(invalidate)
      .then(move("sending", "done")).expect(onlyCurrentSnapshotsStart and phase == "done")
}

module sync_publication_boundary_before {
  import sync_publication_boundary(FENCE = false).*
}

module sync_publication_boundary_fixed {
  import sync_publication_boundary(FENCE = true).*
}

// A coordinated request expires even when the browser is live and the frame
// scheduler has stopped. Replay can still withhold the native capture.
module coordinated_capture_clock {
  const RECOVERY_CLOCK: bool
  const CONFIRM_ON_CLOCK: bool
  var elapsed: bool
  var replaying: bool
  var confirmed: bool
  var sent: bool
  var stopped: bool
  action init = all {
    elapsed' = false,
    replaying' = false,
    confirmed' = false,
    sent' = false,
    stopped' = false,
  }
  action advance(active: bool, ended: bool): bool = all {
    elapsed' = true,
    replaying' = active,
    confirmed' = confirmed,
    stopped' = (stopped or ended),
    sent' = sent,
  }
  action confirm(aligned: bool): bool = all {
    elapsed' = elapsed,
    replaying' = replaying,
    confirmed' = aligned,
    stopped' = stopped,
    sent' = sent,
  }
  action service(frameTick: bool): bool = all {
    elapsed' = elapsed,
    replaying' = replaying,
    confirmed' = confirmed,
    stopped' = stopped,
    sent' = (sent or (not(stopped) and not(replaying) and (
      (elapsed and (RECOVERY_CLOCK or frameTick)) or (confirmed and (CONFIRM_ON_CLOCK or frameTick))
    ))),
  }
  action step = any { advance(true, false), advance(false, false), advance(false, true), confirm(false), confirm(true), service(false), service(true) }
  run deadlineWithoutFrameTickTest =
    init.then(advance(false, false)).then(service(false)).expect(sent == RECOVERY_CLOCK)
  run confirmedTargetDoesNotNeedAFrameTickTest =
    init.then(confirm(false)).then(service(false)).expect(not(sent))
      .then(confirm(true)).then(service(false)).expect(sent == CONFIRM_ON_CLOCK)
  run waitsForReplayAndHonorsStopTest =
    init.then(advance(true, false)).then(service(false)).expect(not(sent))
      .then(advance(false, true)).then(service(true)).expect(not(sent))
}

module coordinated_capture_clock_before {
  import coordinated_capture_clock(RECOVERY_CLOCK = false, CONFIRM_ON_CLOCK = false).*
}

module coordinated_capture_clock_fixed {
  import coordinated_capture_clock(RECOVERY_CLOCK = true, CONFIRM_ON_CLOCK = false).*
}


module coordinated_capture_clock_confirmed {
  import coordinated_capture_clock(RECOVERY_CLOCK = true, CONFIRM_ON_CLOCK = true).*
}
