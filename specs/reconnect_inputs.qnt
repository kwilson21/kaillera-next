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
// What is modelled: one peer, after the reset; frames from 0; the peer's
// inputs as a contiguous prefix this page has (`have`); the peer heard as
// ahead (`heardAhead`); the C slot active or not; this page running frames
// on its inputs or on predictions. Not modelled: the stall's deadline and
// the phantom path after it (specs/tick_deadlines.qnt), the state the host
// pushes (specs/resync_flow.qnt), the floor (frames are above it).

module reconnect_inputs {
  const WAIT_FIRST_INPUT: bool

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
  var predicted: Set[int]   // frames run on a prediction, still recorded
  var lost: bool            // history: a frame the peer made was run on a prediction nothing corrects

  action init = all {
    f' = 0, have' = -1, heardAhead' = -1, cActive' = false, predicted' = Set(), lost' = false,
  }

  // A packet from the peer too far ahead: dropped, but the frame counted.
  action hearAhead = all {
    heardAhead < MADE,
    heardAhead' = MADE,
    f' = f, have' = have, cActive' = cActive, predicted' = predicted, lost' = lost,
  }

  // The peer's next input arrives and is taken in (fed to C: the slot is
  // active). A prediction for that frame, if recorded, is corrected by a
  // rollback; it was within the window or `lost` is already set.
  action deliver = all {
    have < MADE,
    have' = have + 1,
    cActive' = true,
    predicted' = predicted.exclude(Set(have + 1)),
    f' = f, heardAhead' = heardAhead, lost' = lost,
  }

  // tick(): does this page run frame f now?
  def missing: bool = have < f
  def lastHeard: int = have
  def edge: int = f - W
  // A hole below the last frame heard (none here: `have` is contiguous).
  def gapAtEdge: bool = edge >= 0 and edge < lastHeard and have < edge
  def awaitingFirst: bool = WAIT_FIRST_INPUT and not(cActive)
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
    have' = have, heardAhead' = heardAhead, cActive' = cActive,
  }

  action stutter = all {
    f' = f, have' = have, heardAhead' = heardAhead, cActive' = cActive, predicted' = predicted, lost' = lost,
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
      init.expect(stalls)
    else
      init.then(runFrame).expect(not(theHostNeverPredictsAFrameThePeerHasMade))

  // The peer heard only as ahead: one input in, then nothing in range; the
  // page runs on until a predicted frame leaves the window.
  // The frame-ahead stall catches it before a predicted frame leaves the
  // window, in every variant.
  run heardAheadOnlyTest =
    init.then(deliver).then(hearAhead).then(runFrame).then(runFrame).then(runFrame)
      .expect(stalls and allHold)

  // Both: the page waits for the first input, then stalls at the edge until
  // the rest arrive, and never loses a frame.
  run bothTest =
    if (WAIT_FIRST_INPUT)
      init.then(hearAhead).then(deliver).then(runFrame).then(runFrame).then(runFrame)
        .expect(stalls and allHold)
        .then(deliver).then(runFrame)
        .expect(allHold)
    else
      init
}

// Today: after the reset, frames run on the peer's missing input with the C
// slot inactive.
module reconnect_inputs_current {
  import reconnect_inputs(WAIT_FIRST_INPUT = false).*
}

// The fix.
module reconnect_inputs_fixed {
  import reconnect_inputs(WAIT_FIRST_INPUT = true).*
}
