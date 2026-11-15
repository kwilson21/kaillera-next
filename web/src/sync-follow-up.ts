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
 * `watchFrame`: it is at or before that frame, and C's count of
 * mispredictions moved while it was fed (`before` to `after`). A count that
 * could not be read (-1) counts as a change: that can only cost a follow-up,
 * never keep a state that changed.
 */
//@ ensures \result === (inputFrame <= watchFrame && (before < 0 || after < 0 || after !== before))
export function changesWatchedFrame(inputFrame: number, watchFrame: number, before: number, after: number): boolean {
  return inputFrame <= watchFrame && (before < 0 || after < 0 || after !== before);
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
