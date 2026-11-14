/**
 * The stick dead-band: the local filter between a player's analog stick and
 * the input that is recorded, sent and applied on every peer.
 *
 * The rollback engine only accepts an exact stick prediction (see "Never
 * tolerate a prediction mismatch" in CLAUDE.md), and a held analog stick
 * jitters by a unit or so every frame, so without a filter each frame would
 * mispredict and roll back. The filter holds each axis's last value until the
 * stick either moves `band` units away from it or settles on a new value for
 * `settleFrames` consecutive reads; then it takes the exact value. Centering
 * always returns 0. Alternating jitter never settles, but a deliberate
 * one-unit change (onto an SSB64 threshold such as 53) goes through after
 * `settleFrames`, so no value is held indefinitely.
 *
 * A fixed grid would move SSB64's thresholds (53, 56, 26, ...): the core maps
 * JS axes to N64 bytes in polar form, so no per-axis grid lines up.
 *
 * This file is the rule for one axis and one read, verified with LemmaScript
 * (Dafny backend; see LemmaScript-files.txt). `createStickDeadband` in
 * stick-deadband.ts keeps the four axes' state and is not verified.
 */

/** What the filter remembers about one axis. */
export interface AxisState {
  /** The value the filter is returning. */
  held: number;
  /** The last value read that was near `held` but not equal to it. */
  cand: number;
  /** How many reads in a row have been `cand`. */
  count: number;
}

/**
 * One read of one axis. The contract: the filter never invents a value (it
 * returns the value read or the one it held), centering and a move of `band`
 * or more go through at once, and the read that completes `settleFrames` in
 * a row of the same value goes through.
 */
//@ requires settleFrames >= 1 && 0 <= state.count && state.count < settleFrames
//@ ensures \result.held === raw || \result.held === state.held
//@ ensures raw === 0 ==> \result.held === 0
//@ ensures raw - state.held >= band || state.held - raw >= band ==> \result.held === raw
//@ ensures raw === state.cand && state.count + 1 >= settleFrames ==> \result.held === raw
//@ ensures \result.held === raw ==> \result.count === 0
//@ ensures 0 <= \result.count && \result.count < settleFrames
export function stepAxis(state: AxisState, raw: number, band: number, settleFrames: number): AxisState {
  if (raw === state.held) {
    return { held: state.held, cand: state.cand, count: 0 };
  }
  if (raw === 0 || raw - state.held >= band || state.held - raw >= band) {
    return { held: raw, cand: state.cand, count: 0 };
  }
  const count = raw === state.cand ? state.count + 1 : 1;
  if (count >= settleFrames) {
    return { held: raw, cand: raw, count: 0 };
  }
  return { held: state.held, cand: raw, count };
}
