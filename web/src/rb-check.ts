/**
 * RB-CHECK: what the rollback engine does with a frame's pair of gameplay
 * hashes, its own and a peer's.
 *
 * Each page files the hash of a frame once that frame can no longer be
 * rolled back on it: the frame one rollback window behind the newest
 * (`digestFrame` in desync-confirm.ts, the field detector's rule). It sends
 * the peer that value and keeps it. Both values are then final, so the pair
 * is compared as soon as the second one is here: equal is MATCH, different
 * is MISMATCH. A value whose counterpart has not come within `history`
 * frames is given up on (expired) and logged as not compared.
 *
 * Before, a page sent the hash of the frame it had just simulated, which
 * may have run on a predicted input, and the receiver compared it with its
 * ring's hash of that frame a few frames later. A misprediction on the
 * sender logged MISMATCH on a healthy match, and a value that arrived after
 * the frame left the receiver's window was dropped (STALE) uncompared.
 * specs/rb_check.qnt has both rules (`rbCheckIsSound`).
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/** No value for this side yet. Filed hashes are unsigned 32-bit, so never negative. */
export const RB_ABSENT = -1;
/** Hold the value: its counterpart may still come. */
export const RB_WAIT = 0;
/** Both values are here and equal. */
export const RB_MATCH = 1;
/** Both values are here and differ: the peers' final states differ. */
export const RB_MISMATCH = 2;
/** One value is here, and its counterpart has not come within the history. */
export const RB_EXPIRED = 3;

/**
 * The verdict on a frame's pair of values.
 *
 * @param local    this page's filed hash for the frame, or RB_ABSENT
 * @param peer     the peer's hash for the frame, or RB_ABSENT
 * @param frame    the frame
 * @param tick     the frame the engine has just simulated
 * @param history  how many frames past `frame` a lone value waits
 */
//@ requires local >= -1 && peer >= -1 && frame >= 0 && history >= 0
//@ ensures local >= 0 && peer >= 0 && local === peer ==> \result === 1
//@ ensures local >= 0 && peer >= 0 && local !== peer ==> \result === 2
//@ ensures (local < 0 || peer < 0) && tick - frame > history ==> \result === 3
//@ ensures (local < 0 || peer < 0) && tick - frame <= history ==> \result === 0
export function pairVerdict(local: number, peer: number, frame: number, tick: number, history: number): number {
  if (local >= 0 && peer >= 0) {
    if (local === peer) return 1;
    return 2;
  }
  if (tick - frame > history) return 3;
  return 0;
}
