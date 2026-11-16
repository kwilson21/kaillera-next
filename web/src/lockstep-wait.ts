/**
 * Lockstep, the mode a host can pick instead of rollback: the page predicts
 * nothing and runs a frame only once it holds every player's input for it.
 * This is what a tick does in that mode, one frame at a time.
 *
 * A missing input is waited for. After `askAgainMs` the page asks the player
 * for it again; at `giveUpMs` it stops waiting and drops that player (marks
 * it a phantom, as the rollback deadlines do), plays on without it, and the
 * two resync when it is heard from again. Without the last step a single lost
 * input would hold the match for ever (specs/tick_deadlines.qnt,
 * `everyWaitHasADeadline`).
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * `run`: every input for the frame is here. `wait`: one is missing.
 * `askAgain`: still missing, ask the player for it again (and keep waiting).
 * `drop`: missing for too long; drop the player and run the frame without it.
 */
export type LockstepStep = 'run' | 'wait' | 'askAgain' | 'drop';

/**
 * `missing`: how many players the page is still missing this frame's input
 * from (players already dropped are not counted). `waitedMs`: how long it
 * has been waiting for it, with any freeze of its own credited.
 */
//@ requires missing >= 0 && askAgainMs <= giveUpMs
//@ ensures missing === 0 ==> \result === "run"
//@ ensures missing > 0 && waitedMs >= giveUpMs ==> \result === "drop"
//@ ensures \result === "drop" ==> missing > 0 && waitedMs >= giveUpMs
//@ ensures \result === "askAgain" ==> missing > 0 && askAgainMs <= waitedMs && waitedMs < giveUpMs
//@ ensures missing > 0 && waitedMs < askAgainMs ==> \result === "wait"
export function lockstepStep(missing: number, waitedMs: number, askAgainMs: number, giveUpMs: number): LockstepStep {
  if (missing === 0) return 'run';
  if (waitedMs >= giveUpMs) return 'drop';
  if (waitedMs >= askAgainMs) return 'askAgain';
  return 'wait';
}
