/**
 * What a guest does with a host state from before the frame it is on.
 *
 * The host answers a resync with its state from the frame it was on when it
 * heard the request, or from the frame the request named, and the guest has
 * played on by the time the state arrives: a few frames on a fast link,
 * seconds on a slow one or after the page froze. Moving the guest's frame
 * back to the state's played those frames again in sight, at the game's
 * pace, while the host waited for the guest's inputs, and past the engine's
 * 256-frame input ring the inputs it predicted for them were never
 * corrected and the pages split (a two-player run, the boot sync's answer
 * held 12 s: 396 -> 124).
 *
 * Instead the state is applied where it is from and the frames up to the
 * guest's are run again at once, unseen, with the inputs both pages already
 * have, so the guest goes on from the frame it was on
 * (netplay-rollback.js, _catchUpAfterResync). That takes time on the main
 * thread for each frame, so at most `max` are run again; a state further
 * back is not applied. specs/resync_flow.qnt models it: CATCH_UP,
 * MAX_CATCH_UP, `theGuestIsNeverRewound` (violated by resync_flow_rewinds,
 * ownAnswerBehindTest; tooOldToCatchUpTest).
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * `apply`: the state is from this frame or later (held until the guest is
 * there, or applied as it is); `catchUp`: applied, then the frames up to
 * the guest's run again; `refuse`: too far back, not applied.
 */
export type CatchUpStep = 'apply' | 'catchUp' | 'refuse';

/**
 * @param stateFrame  the frame the host's state is from
 * @param guestFrame  the frame this guest is on
 * @param max         the most frames the guest runs again
 */
//@ requires max >= 0
//@ ensures \result === "apply" <==> stateFrame >= guestFrame
//@ ensures \result === "catchUp" <==> stateFrame < guestFrame && guestFrame - stateFrame <= max
//@ ensures \result === "refuse" <==> guestFrame - stateFrame > max
export function catchUpStep(stateFrame: number, guestFrame: number, max: number): CatchUpStep {
  if (stateFrame >= guestFrame) return 'apply';
  if (guestFrame - stateFrame > max) return 'refuse';
  return 'catchUp';
}
