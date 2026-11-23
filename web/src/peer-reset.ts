/**
 * What a peer's reset (resetPeerState, I2) does to the C engine's slot of
 * that peer: whether the slot's input ring, its record of which inputs were
 * predictions, and the newest real input C predicts from are kept.
 *
 * C checks a real input only against a recorded prediction
 * (rb_is_prediction_of in kn_feed_input): a frame run on a prediction is
 * corrected when the real input comes, by a rollback inside the window or a
 * failed rollback counted past it (DEEP-MISPREDICT-SKIP, escalated by
 * _onPastWindowMismatch). Every reset used to empty the slot
 * (kn_rollback_slot_reset), and on the scheduled roster rule put the inputs
 * the frames still in the ring ran with back in as real ones
 * (_ringInputsRan). Either way the record of which of them were predictions
 * was gone, so after a reconnect the peer's real input for a frame this page
 * ran on a prediction was stored with no check and no rollback: the pages
 * split and nothing noticed.
 *
 * Now a reset where the same player goes on in the same slot keeps the C
 * slot as it is: a reconnect of its channel (`reconnect`), a mesh heal of a
 * guest link (`mesh-heal`), and a guest's hard disconnect of another guest
 * (`hard-disconnect-non-host`: the player stays in the slot until the host's
 * roster removes it, and that roster's cut or reset is what empties it).
 * Only while the roster this page holds still lists the slot: a slot the
 * roster no longer lists may be taken by another player. Every other reset
 * (the host dropping a player, a roster removal on the immediate rule, a page
 * replaced by a new one, a late joiner's reconnect) empties it as before.
 * The JS side of the reset (I2) is the same for every reason.
 *
 * specs/reconnect_inputs.qnt, module reconnect_history: reconnect_history_before
 * (the emptied slot, violated), reconnect_history_as_real (the ring's inputs
 * put back as real ones, violated), reconnect_history_current (this rule:
 * everyInputItDidNotMakeIsChecked; predictionPutBackAsRealTest).
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * Whether resetPeerState(slot, reason) leaves the C engine's slot as it is.
 *
 * @param reason  the reset's reason, as resetPeerState is called with it
 * @param listed  the roster this page holds lists the slot (or there is no roster yet)
 */
//@ ensures \result <==> listed && (reason === "reconnect" || reason === "mesh-heal" || reason === "hard-disconnect-non-host")
//@ ensures \result ==> listed
export function keepsCoreSlot(reason: string, listed: boolean): boolean {
  if (!listed) return false;
  return reason === 'reconnect' || reason === 'mesh-heal' || reason === 'hard-disconnect-non-host';
}
