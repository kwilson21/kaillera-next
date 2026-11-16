/**
 * Which frame the desync detector may report field hashes for.
 *
 * A rollback peer simulates a frame before the other players' inputs for it
 * arrive. Until they do, the frame may be replayed, and its state is not
 * the state the match keeps. A digest built for the newest frame made two
 * healthy peers disagree whenever one of them had mispredicted, which the
 * detector reported as a desync. The engine never replays further back than
 * its rollback window, so the frame that many ticks behind is final.
 *
 * specs/desync_digest.qnt has the property (`neverReportsAnUnconfirmedHash`)
 * as violated without this rule and as holding with it; `reportFrame` there
 * is `digestFrame` without the cadence.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/** Returned when no digest is due on this tick. */
export const NO_DIGEST = -1;

/**
 * The frame to build and broadcast a digest for on this tick, or
 * `NO_DIGEST`.
 *
 * @param tick     the frame the engine has just simulated
 * @param window   the engine's rollback window in frames (0 in lockstep)
 * @param cadence  digests are sent for frames divisible by this
 */
//@ requires tick >= 0 && window >= 0 && cadence >= 1
//@ ensures \result === -1 || (\result >= 0 && \result + window === tick && \result % cadence === 0)
//@ ensures tick >= window && (tick - window) % cadence === 0 ==> \result === tick - window
export function digestFrame(tick: number, window: number, cadence: number): number {
  if (tick < window) return -1;
  const frame = tick - window;
  if (frame % cadence !== 0) return -1;
  return frame;
}
