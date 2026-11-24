/**
 * The host's follow-up to a resync answer it sent unconfirmed
 * (specs/sync_follow_up.qnt).
 *
 * A state taken while some input at or before its frame was still predicted
 * can change when that input arrives and differs from the prediction. The
 * host then follows the answer with a fresh state. These decide whether an
 * arriving input changed the frame sent, and whether the follow-up is
 * needed at all.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * Whether an input fed for `inputFrame` changed the state sent for
 * `watchFrame`: it ran before that frame, and C's count of mispredictions
 * moved while it was fed (`before` to `after`).
 *
 * The state sent for F is the state at the start of F. An input labelled f
 * first runs at frame f + delay, so that state holds only inputs labelled at
 * most F - 1 - delay: one labelled F - delay .. F runs at F or later and
 * cannot change it (specs/sync_follow_up.qnt, DELAY_AWARE). `delay` is the
 * delay that state ran under (delayOfStateAt). A count that could not be read
 * (-1) counts as a change: that can only cost a follow-up, never keep a state
 * that changed.
 */
//@ requires delay >= 0
//@ ensures \result === (inputFrame <= watchFrame - 1 - delay && (before < 0 || after < 0 || after !== before))
export function changesWatchedFrame(
  inputFrame: number,
  watchFrame: number,
  delay: number,
  before: number,
  after: number,
): boolean {
  return inputFrame <= watchFrame - 1 - delay && (before < 0 || after < 0 || after !== before);
}

/**
 * The delay the state at the start of `watchFrame` ran under, for
 * changesWatchedFrame: the newest input that state holds is labelled
 * watchFrame - 1 - result. With the delay `delay` since the last change,
 * that is watchFrame - 1 - delay, unless a frame before the change ran a
 * newer one: `ranBeforeChange`, the newest label any frame before the last
 * delay change ran (-1 when the delay never changed in this match). A delay
 * raised mid-match (the re-arm at a late join, 0 to D; a live re-tune) leaves
 * frames just before the change having run inputs newer than
 * watchFrame - 1 - delay for the next few frames. Never above `delay` nor
 * below 0: a smaller result only counts more inputs, at the cost of a
 * follow-up.
 */
//@ requires delay >= 0
//@ ensures 0 <= \result && \result <= delay
//@ ensures \result === 0 || watchFrame - 1 - \result >= ranBeforeChange
//@ ensures \result === delay || watchFrame - 1 - \result <= ranBeforeChange
export function delayOfStateAt(watchFrame: number, delay: number, ranBeforeChange: number): number {
  if (ranBeforeChange <= watchFrame - 1 - delay) return delay;
  if (ranBeforeChange >= watchFrame - 1) return 0;
  return watchFrame - 1 - ranBeforeChange;
}

/**
 * Whether the host still owes a correction as it takes a state: a replay in
 * flight (`replayDepth` above 0, or -1 when it cannot be read), a rollback
 * pending in C (`pendingRollback` at or above 0), or a deferred replay out to
 * the shadow worker (`deferredReplayOut`). A state taken then is already not
 * the host's, and the input that differed was fed before the watch existed,
 * so no later feed flags it: its watch starts changed
 * (specs/sync_follow_up.qnt, OWED_AT_TAKE). That can only cost a follow-up.
 */
//@ ensures \result === (replayDepth !== 0 || pendingRollback >= 0 || deferredReplayOut)
export function correctionOwed(replayDepth: number, pendingRollback: number, deferredReplayOut: boolean): boolean {
  return replayDepth !== 0 || pendingRollback >= 0 || deferredReplayOut;
}

/**
 * Whether a follow-up that has come due can be dropped: it follows a state
 * the host is watching and handed over whole (`watched`), no input at or
 * before that state's frame differed from its prediction (`changed` false),
 * and the frame is now confirmed with no player a phantom (`confirmed`). One
 * due at its deadline with the frame unconfirmed cannot know yet, and goes
 * out; so does one with no watch, or whose state did not all go out.
 */
//@ ensures \result === (followUp > 0 && watched && !changed && confirmed)
export function followUpIsUnneeded(followUp: number, watched: boolean, changed: boolean, confirmed: boolean): boolean {
  return followUp > 0 && watched && !changed && confirmed;
}

/**
 * Whether a direct resync answer (a `sync-request-full` with no frame,
 * answered at once) gets a follow-up. Every direct answer is watched: whether
 * its frame was confirmed is judged once the state was actually taken, by
 * followUpIsUnneeded. It is followed up when its guest is still the one it
 * was sent to (`current`: same connection and match), the state went out to
 * it (`sent`), no newer request from it is queued (`replaced`), and it is not
 * a phantom (`targetPhantom`): a phantom's recovery replaces any request
 * queued for it with its own resync, so following up meanwhile would only
 * send it full states at every deadline.
 */
//@ ensures \result === (current && sent && !replaced && !targetPhantom)
export function directFollowUpDue(current: boolean, sent: boolean, replaced: boolean, targetPhantom: boolean): boolean {
  return current && sent && !replaced && !targetPhantom;
}

/**
 * Whether a direct answer's watch is dropped: it was not sent to its guest
 * while that guest is still the one it was for and no newer request from it
 * is queued. Its watch then follows no state that went out.
 */
//@ ensures \result === (current && !sent && !replaced)
export function directWatchIsStale(current: boolean, sent: boolean, replaced: boolean): boolean {
  return current && !sent && !replaced;
}
