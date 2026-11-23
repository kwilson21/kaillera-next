// -*- mode: Bluespec; -*-
//
// After a reconnect, the frames one page runs before it has the other's
// inputs for them: the rollback input stall in tick() and resetPeerState in
// web/static/netplay-rollback.js.
//
// The reconnected channel's open handler resets the peer (I2,
// resetPeerState(slot, 'reconnect')): the frame last heard from it, the
// frames it was heard to have made ahead (_inputDroppedAheadUpTo), and the C
// engine's slot (kn_rollback_slot_reset: the slot inactive, its predictions
// erased). The peer may be far ahead: during the drop it held this page as a
// phantom and ran on alone (CATCH_UP_HOLE_MS run, host reset at 1320, guest
// at 1574).
//
// A frame this page runs without the peer's input is predicted. That is safe
// only while a rollback can still correct it: the C slot records the
// prediction, and the real input arrives before the frame leaves the
// rollback window. The stall on frames ahead of the peer's last input is
// sized to the window (threshold DELAY + 7 + 1, window edge f - DELAY - 7),
// so with a recorded prediction the second always holds. The first did not:
// right after the reset the C slot is inactive, and a frame run then on a
// missing input records no prediction. The real input, when it comes, is
// compared with nothing: no rollback, no failed rollback counted
// (INPUT-PAST-WINDOW-MISMATCH cannot fire either). The stall did not fire
// because the reset had also cleared the frame last heard, so the page did
// not know how far ahead it was. The host ran 1320 → 1362 like that and the
// pages split at 1344.
//
// WAIT_FIRST_INPUT: after a reconnect reset, a frame (at or above the input
//   floor) that lacks the peer's input waits until one real input from it
//   has been taken in (the C slot active again), within the stall's own
//   deadline (I1: RB-INPUT-STALL-TIMEOUT, then the phantom and its resync).
//
// The reset still clears what the page knew of the peer (I2): nothing is
// lost by it, because from the reset to the first input no frame runs on a
// missing input, and from then on the frame-ahead stall bounds the run. A
// peer heard only as ahead (its packets dropped as too far ahead,
// _inputDroppedAheadUpTo) needs nothing more: counting those frames in the
// edge stall (peerHas, considered) changes no outcome here
// (heardAheadOnlyTest).
//
// KEEPS_HISTORY: on the scheduled roster rule the reset (de361fd) puts back
//   the inputs the frames still in the ring ran with, re-fed as real ones
//   (_ringInputsRan), so the C slot can be active right after it: frames run
//   on a missing input then record a prediction. The first-input wait is
//   JS's (_awaitFirstInputAfterReset, cleared by the first input taken in
//   through _feedWatched; the re-feed goes through _feedWatchedFrame and does
//   not clear it), so it is `firstTaken`, apart from `cActive`. Nothing here
//   changes: the property holds with it (reconnect_inputs_keeps_history).
//   What the re-fed inputs do to the frames run before the reset is
//   `reconnect_history`, below.
//
// What is modelled: one peer, after the reset; frames from 0; the peer's
// inputs as a contiguous prefix this page has (`have`); the peer heard as
// ahead (`heardAhead`); the C slot active or not; this page running frames
// on its inputs or on predictions. Not modelled: the stall's deadline and
// the phantom path after it (specs/tick_deadlines.qnt), the state the host
// pushes (specs/resync_flow.qnt), the floor (frames are above it).

module reconnect_inputs {
  const WAIT_FIRST_INPUT: bool
  const KEEPS_HISTORY: bool

  // The rollback window (frames a prediction can still be corrected within).
  pure val W = 2
  // The stall threshold on frames ahead of the peer's last input: the frame
  // after the last one heard reaches the window's edge exactly then.
  pure val T = W + 1
  // The peer made every frame up to this one before the reset.
  pure val MADE = 6
  // Bound on this page's frame for the model.
  pure val MAX_F = 8

  var f: int                // this page's next frame to run
  var have: int             // the peer's inputs this page has: frames 0..have
  var heardAhead: int       // the furthest frame the peer was heard to have made; -1 none
  var cActive: bool         // the C slot records predictions again
  var firstTaken: bool      // a real input of the peer has been taken in since the reset
  var predicted: Set[int]   // frames run on a prediction, still recorded
  var lost: bool            // history: a frame the peer made was run on a prediction nothing corrects

  // The reset leaves the C slot inactive, or (KEEPS_HISTORY) active again
  // when the ring held inputs of the peer that it puts back.
  action initWith(active: bool): bool = all {
    f' = 0, have' = -1, heardAhead' = -1, cActive' = active, firstTaken' = false, predicted' = Set(), lost' = false,
  }

  action init = {
    nondet active = (if (KEEPS_HISTORY) Set(false, true) else Set(false)).oneOf()
    initWith(active)
  }

  // A packet from the peer too far ahead: dropped, but the frame counted.
  action hearAhead = all {
    heardAhead < MADE,
    heardAhead' = MADE,
    f' = f, have' = have, cActive' = cActive, firstTaken' = firstTaken, predicted' = predicted, lost' = lost,
  }

  // The peer's next input arrives and is taken in (fed to C: the slot is
  // active). A prediction for that frame, if recorded, is corrected by a
  // rollback; it was within the window or `lost` is already set.
  action deliver = all {
    have < MADE,
    have' = have + 1,
    cActive' = true,
    firstTaken' = true,
    predicted' = predicted.exclude(Set(have + 1)),
    f' = f, heardAhead' = heardAhead, lost' = lost,
  }

  // tick(): does this page run frame f now?
  def missing: bool = have < f
  def lastHeard: int = have
  def edge: int = f - W
  // A hole below the last frame heard (none here: `have` is contiguous).
  def gapAtEdge: bool = edge >= 0 and edge < lastHeard and have < edge
  def awaitingFirst: bool = WAIT_FIRST_INPUT and not(firstTaken)
  def stalls: bool = missing and (gapAtEdge or awaitingFirst or (lastHeard >= 0 and f - lastHeard >= T))

  action runFrame = all {
    f < MAX_F, not(stalls),
    f' = f + 1,
    // A missing input is predicted; recorded only if the C slot is active.
    predicted' = if (missing and cActive) predicted.union(Set(f)) else predicted,
    lost' = (
      lost
        // Predicted with the C slot inactive: nothing records it, and the
        // peer made it.
        or (missing and not(cActive) and f <= MADE)
        // A recorded prediction leaves the window without its input.
        or (edge >= 0 and predicted.contains(edge) and have < edge and edge <= MADE)
    ),
    have' = have, heardAhead' = heardAhead, cActive' = cActive, firstTaken' = firstTaken,
  }

  action stutter = all {
    f' = f, have' = have, heardAhead' = heardAhead, cActive' = cActive, firstTaken' = firstTaken,
    predicted' = predicted, lost' = lost,
  }

  action step = any { hearAhead, deliver, runFrame, stutter }

  // ── Properties ───────────────────────────────────────────────────────────

  // After a reconnect, this page never runs a frame the peer has made on a
  // prediction that nothing will correct.
  val theHostNeverPredictsAFrameThePeerHasMade = not(lost)
  val allHold = theHostNeverPredictsAFrameThePeerHasMade

  // ── Scenarios ────────────────────────────────────────────────────────────

  // The CATCH_UP_HOLE_MS split: right after the reset, frames run before the
  // peer's first input (C slot inactive).
  run runBeforeFirstInputTest =
    if (WAIT_FIRST_INPUT)
      initWith(false).expect(stalls)
    else
      initWith(false).then(runFrame).expect(not(theHostNeverPredictsAFrameThePeerHasMade))

  // The reset put inputs back (the C slot active): the page still waits for
  // the peer's first input, as JS does.
  run keptHistoryStillWaitsTest =
    if (WAIT_FIRST_INPUT and KEEPS_HISTORY)
      initWith(true).expect(stalls)
        .then(deliver).then(runFrame).then(runFrame)
        .expect(allHold)
    else
      initWith(false)

  // The peer heard only as ahead: one input in, then nothing in range; the
  // page runs on until a predicted frame leaves the window.
  // The frame-ahead stall catches it before a predicted frame leaves the
  // window, in every variant.
  run heardAheadOnlyTest =
    initWith(false).then(deliver).then(hearAhead).then(runFrame).then(runFrame).then(runFrame)
      .expect(stalls and allHold)

  // Both: the page waits for the first input, then stalls at the edge until
  // the rest arrive, and never loses a frame.
  run bothTest =
    if (WAIT_FIRST_INPUT)
      initWith(false).then(hearAhead).then(deliver).then(runFrame).then(runFrame).then(runFrame)
        .expect(stalls and allHold)
        .then(deliver).then(runFrame)
        .expect(allHold)
    else
      initWith(false)
}

// Today: after the reset, frames run on the peer's missing input with the C
// slot inactive.
module reconnect_inputs_current {
  import reconnect_inputs(WAIT_FIRST_INPUT = false, KEEPS_HISTORY = false).*
}

// The fix.
module reconnect_inputs_fixed {
  import reconnect_inputs(WAIT_FIRST_INPUT = true, KEEPS_HISTORY = false).*
}

// The fix with the reset that keeps history (de361fd, the scheduled rule).
module reconnect_inputs_keeps_history {
  import reconnect_inputs(WAIT_FIRST_INPUT = true, KEEPS_HISTORY = true).*
}

// ── The frames run before the reset ───────────────────────────────────────
//
// What a reconnect reset does to the frames this page ran for the peer
// before it: the C slot's input ring (kn_rollback_slot_reset, the re-feed in
// resetPeerState) and what C checks when the peer's real inputs come after
// the reset (kn_feed_input).
//
// C checks a real input only against a recorded prediction
// (rb_is_prediction_of): a frame run on a prediction is corrected when the
// real input comes, by a rollback inside the window or a failed rollback
// counted past it (DEEP-MISPREDICT-SKIP, escalated by _onPastWindowMismatch).
// An entry that is no recorded prediction, or no entry, is overwritten
// without a check. JS takes in again what the reset made it forget
// (_clearSlotInputState empties _remoteInputs, so the peer's resent inputs
// are fed to C again).
//
// RESET:
//   "empty" (before de361fd, and the immediate rule today):
//     kn_rollback_slot_reset empties the slot: no entry, no prediction, the
//     slot inactive. A frame run before it on a prediction is not checked
//     when its real input comes, and a replay of a frame before it runs it
//     neutral (the slot inactive) and records nothing.
//   "asReal" (de361fd, the scheduled rule): _ringInputsRan reads the entries
//     of the tags the frames still in the ring ran with (kn_get_input: the
//     value, prediction or not), the slot is reset, and each goes back in
//     through kn_feed_input as a real input. A replay runs them again
//     unchanged, but a prediction among them is now a real input: the peer's
//     real input for that tag, when it comes, is stored over it with no
//     check, and the frame that ran on the prediction is never corrected.
//   "kept" (the fix): a reconnect (the same player in the same slot) does
//     not reset the C slot: its entries, their prediction records, the slot
//     active and its newest real input stay, so every frame run on a
//     prediction is checked when the real input comes, and a replay runs
//     the real entries again unchanged.
//
// The property: this page never has run a frame for the peer with an input
// the peer did not make unless C holds that input as a recorded prediction
// (it checks it when the real one comes) or a failed rollback was counted
// for it (everyInputItDidNotMakeIsChecked).
//
// What is modelled: one peer and this page; a reset at any time (one); the
// peer's inputs (any value per tag) reaching this page in any order, before
// or after the reset, again after it (JS forgot them); frames run forward
// on the ring (a real entry, else C's prediction, recorded while the slot
// is active, else neutral); rollbacks of up to W frames on a misprediction
// and on another player's input; the first-input wait after the reset
// (WAIT_FIRST_INPUT above, today's code). Not modelled: the input delay (a
// frame stands for the tag it applies), the stall on frames ahead of the
// peer (above), the host's state a guest asks for after a reconnect (it
// replaces this page's frames on a guest; the host runs on, and so does a
// guest the reconnect did not involve).

module reconnect_history {
  const RESET: str

  pure val MAX_F = 5
  // The rollback window.
  pure val W = 2
  // The span _ringInputsRan puts back: tags within the window plus two below
  // the frame.
  pure val KEEP = W + 2
  pure val FRAMES = 0.to(MAX_F - 1)
  pure val INPUTS = Set(0, 1)

  var real: int -> int        // the input the peer made for each tag
  var f: int                  // the next frame this page runs
  var ringVal: int -> int     // the C ring's entries for the peer's slot
  var ringPred: Set[int]      // the entries that are recorded predictions
  var active: bool            // C slot_active
  var newest: int             // C last_known: the newest real tag fed, -1 none
  var lastVal: int            // its value (C predicts repeat-last)
  var held: Set[int]          // JS _remoteInputs: tags taken in since the reset
  var ran: int -> int         // the input each frame last ran with
  var detected: Set[int]      // tags a failed rollback was counted for
  var resets: int             // reconnect resets so far
  var awaitFirst: bool        // the first-input wait after the reset

  pure def maxInt(a: int, b: int): int = if (a > b) a else b

  pure def isRealIn(rv: int -> int, rp: Set[int], g: int): bool = rv.keys().contains(g) and not(rp.contains(g))

  // The input frame g runs with (forward or in a replay) on this ring.
  pure def valueIn(rv: int -> int, rp: Set[int], act: bool, pv: int, g: int): int =
    if (isRealIn(rv, rp, g)) rv.get(g)
    else if (act) pv
    else if (rv.keys().contains(g)) rv.get(g)
    else 0

  // Whether running frame g records a prediction (C: the slot active, the
  // entry missing or itself a prediction).
  pure def recordsIn(rv: int -> int, rp: Set[int], act: bool, g: int): bool = act and not(isRealIn(rv, rp, g))

  // Frames `from` to `upto - 1` run again on this ring: (ran, ringVal, ringPred).
  pure def replayed(
    rv: int -> int, rp: Set[int], act: bool, pv: int, r: int -> int, from: int, upto: int
  ): (int -> int, int -> int, Set[int]) =
    val again = FRAMES.filter(g => g >= from and g < upto)
    val recorded = again.filter(g => recordsIn(rv, rp, act, g))
    (
      r.keys().mapBy(g => if (g >= from) valueIn(rv, rp, act, pv, g) else r.get(g)),
      rv.keys().union(recorded).mapBy(g => if (recorded.contains(g)) pv else rv.get(g)),
      rp.union(recorded),
    )

  action initWith(inputs: int -> int): bool = all {
    real' = inputs,
    f' = 0,
    // The peer's first input is in: the slot is active.
    ringVal' = Map(0 -> inputs.get(0)),
    ringPred' = Set(),
    active' = true,
    newest' = 0,
    lastVal' = inputs.get(0),
    held' = Set(0),
    ran' = Map(),
    detected' = Set(),
    resets' = 0,
    awaitFirst' = false,
  }

  action init = {
    nondet inputs = FRAMES.setOfMaps(INPUTS).oneOf()
    initWith(inputs)
  }

  def predicted: int = if (newest < 0) 0 else lastVal

  // This page runs its next frame. After the reset a frame without the
  // peer's real input waits for its first one (WAIT_FIRST_INPUT).
  action runFrame = all {
    f < MAX_F,
    not(awaitFirst and not(isRealIn(ringVal, ringPred, f))),
    f' = f + 1,
    ran' = ran.put(f, valueIn(ringVal, ringPred, active, predicted, f)),
    ringVal' = if (recordsIn(ringVal, ringPred, active, f)) ringVal.put(f, predicted) else ringVal,
    ringPred' = if (recordsIn(ringVal, ringPred, active, f)) ringPred.union(Set(f)) else ringPred,
    real' = real, active' = active, newest' = newest, lastVal' = lastVal, held' = held, detected' = detected,
    resets' = resets, awaitFirst' = awaitFirst,
  }

  // The peer's real input of tag t is taken in and fed to C (kn_feed_input):
  // checked against a recorded prediction, then stored.
  action deliver(t: int): bool = {
    val v = real.get(t)
    val wasPred = ringPred.contains(t) and ringVal.keys().contains(t)
    val mismatch = wasPred and ringVal.get(t) != v and t < f
    val rv1 = ringVal.put(t, v)
    val rp1 = ringPred.exclude(Set(t))
    val moves = not(active) or t >= newest
    val newest1 = if (moves) t else newest
    val last1 = if (moves) v else lastVal
    val rolled = replayed(rv1, rp1, true, last1, ran, t, f)
    all {
      not(held.contains(t)),
      held' = held.union(Set(t)),
      awaitFirst' = false,
      active' = true,
      newest' = newest1,
      lastVal' = last1,
      if (mismatch and f - t <= W) all {
        ran' = rolled._1, ringVal' = rolled._2, ringPred' = rolled._3, detected' = detected,
      } else all {
        ran' = ran, ringVal' = rv1, ringPred' = rp1,
        detected' = if (mismatch) detected.union(Set(t)) else detected,
      },
      real' = real, f' = f, resets' = resets,
    }
  }

  // Another player's misprediction: this page runs its last d frames again.
  action replay(d: int): bool = {
    val again = replayed(ringVal, ringPred, active, predicted, ran, f - d, f)
    all {
      f - d >= 0,
      ran' = again._1, ringVal' = again._2, ringPred' = again._3,
      real' = real, f' = f, active' = active, newest' = newest, lastVal' = lastVal, held' = held,
      detected' = detected, resets' = resets, awaitFirst' = awaitFirst,
    }
  }

  // The reconnect reset (resetPeerState 'reconnect').
  action reset: bool = {
    val keepTags = ringVal.keys().filter(g => g >= f - KEEP and g < f)
    val top = keepTags.fold(-1, (acc, g) => maxInt(acc, g))
    all {
      resets < 1,
      resets' = resets + 1,
      held' = Set(),
      awaitFirst' = true,
      if (RESET == "empty") all {
        ringVal' = Map(), ringPred' = Set(), active' = false, newest' = -1, lastVal' = 0,
      } else if (RESET == "asReal") all {
        ringVal' = keepTags.mapBy(g => ringVal.get(g)),
        ringPred' = Set(),
        active' = keepTags.size() > 0,
        newest' = top,
        lastVal' = if (top >= 0) ringVal.get(top) else 0,
      } else all {
        ringVal' = ringVal, ringPred' = ringPred, active' = active, newest' = newest, lastVal' = lastVal,
      },
      real' = real, f' = f, ran' = ran, detected' = detected,
    }
  }

  action stutter = all {
    real' = real, f' = f, ringVal' = ringVal, ringPred' = ringPred, active' = active, newest' = newest,
    lastVal' = lastVal, held' = held, ran' = ran, detected' = detected, resets' = resets, awaitFirst' = awaitFirst,
  }

  action step = any {
    runFrame,
    nondet t = FRAMES.oneOf()
    deliver(t),
    nondet d = 1.to(W).oneOf()
    replay(d),
    reset,
    stutter,
  }

  // ── Properties ───────────────────────────────────────────────────────────

  // Every frame ran with the input the peer made, or with one C holds as a
  // recorded prediction (checked when the real one comes), or a failed
  // rollback was counted for it.
  val everyInputItDidNotMakeIsChecked =
    ran.keys().forall(g =>
      ran.get(g) == real.get(g) or detected.contains(g) or
      (ringPred.contains(g) and ringVal.keys().contains(g) and ringVal.get(g) == ran.get(g))
    )
  val allHold = everyInputItDidNotMakeIsChecked

  // ── Scenarios ────────────────────────────────────────────────────────────

  pure val STEP_UP = FRAMES.mapBy(g => if (g == 0) 0 else 1)
  pure val MOVING = FRAMES.mapBy(g => 1)

  // Frame 1 runs on a prediction (0) of an input the peer made as 1, then
  // the reconnect resets the slot and the real input comes. Empty: the
  // prediction is gone and the real input is stored with no check. As real:
  // the prediction went back in as a real input and the real one is stored
  // over it with no check. Kept: the prediction is checked and rolled back.
  run predictionPutBackAsRealTest =
    initWith(STEP_UP)
      .then(runFrame).then(runFrame)
      .expect(allHold and ringPred.contains(1))
      .then(reset)
      .expect(if (RESET == "kept") allHold else not(allHold))
      .then(deliver(1))
      .expect(
        if (RESET == "kept") allHold and ran.get(1) == 1
        else not(everyInputItDidNotMakeIsChecked) and ran.get(1) == 0
      )

  // Frames 0 and 1 ran on the peer's real inputs; after the reset another
  // player's input makes the page run them again. Empty: the slot is
  // inactive and they run neutral, recording nothing. As real and kept: the
  // real inputs again.
  run replayAfterResetTest =
    initWith(MOVING)
      .then(deliver(1))
      .then(runFrame).then(runFrame)
      .then(reset)
      .then(replay(2))
      .expect(if (RESET == "empty") not(allHold) and ran.get(0) == 0 else allHold and ran.get(0) == 1)
}

// Before de361fd (and on the immediate rule): the reset empties the slot.
module reconnect_history_before {
  import reconnect_history(RESET = "empty").*
}

// Today on the scheduled rule: the ring's inputs go back in as real ones.
module reconnect_history_current {
  import reconnect_history(RESET = "asReal").*
}

// The fix: a reconnect keeps the C slot.
module reconnect_history_fixed {
  import reconnect_history(RESET = "kept").*
}
