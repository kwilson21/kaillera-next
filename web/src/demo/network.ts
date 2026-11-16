/**
 * The demo's one network dial: the RTT slider, and the synthetic peer's
 * network it stands for. Moved from web/static/demo.js unchanged in
 * behaviour; demo.js still reads the slider and hands the result to the fake
 * peer, so nothing here may clamp, round or scale differently.
 */

/** The RTT a match starts at when the player has not chosen one. */
export const DEFAULT_MATCH_RTT_MS = 100;

/**
 * The slider's top. Past 110 ms a lag spike needs a rollback deeper than the
 * engine shows (KN_MAX_VISIBLE_ROLLBACK_DEPTH = 7 in
 * build/kn_rollback/kn_rollback.c), and the rollback counter would stop
 * moving as the lag grew.
 */
export const RTT_SLIDER_MAX = 110;

/** A slider's value as the page finds it; undefined when the page has no slider. */
type SliderValue = string | number | null | undefined;

/** The RTT in milliseconds the slider stands at: 0 to 110, and 0 for anything that is not a number. */
export const rttFromSlider = (value: SliderValue): number => {
  const rtt = Number(value ?? 0);
  return Number.isFinite(rtt) ? Math.max(0, Math.min(RTT_SLIDER_MAX, rtt)) : 0;
};

/** The words beside the slider. */
export const rttLabel = (rtt: number): string => `${rtt.toFixed(0)} ms RTT`;

/** The network the fake peer simulates (web/static/fake-peer.js, `setNetwork`). */
export type DemoNetwork = {
  readonly latencyMs: number;
  readonly jitterMs: number;
  readonly lossProb: number;
  readonly reorderProb: number;
  readonly mispredictProb: number;
};

/**
 * The network for an RTT. Every knob grows with the slider, so more RTT means
 * more rollbacks and not only more latency:
 *   - latency is the one-way trip, half the RTT;
 *   - jitter runs from 10 % of the RTT at the low end to about 13 % at the top;
 *   - loss and reordering follow (rtt / 110)^1.5 up to 2 %.
 * `mispredictProb` stays 0: outside a match the fake peer would use it to
 * press random buttons, which derails the menu autopilot.
 */
export const networkForRtt = (rtt: number): DemoNetwork => {
  const ramp = rtt > 0 ? Math.pow(rtt / RTT_SLIDER_MAX, 1.5) : 0;
  return {
    latencyMs: rtt / 2,
    jitterMs: rtt * (0.1 + rtt * 0.0003),
    lossProb: Math.min(0.02, ramp * 0.02),
    reorderProb: Math.min(0.02, ramp * 0.02),
    mispredictProb: 0,
  };
};

/**
 * The RTT a player chose in an earlier visit, as stored under `kn-demo-rtt`;
 * null when the stored text is not an RTT the slider can show.
 */
export const savedRttPreference = (stored: string): number | null => {
  const rtt = Number(stored);
  return Number.isFinite(rtt) && rtt >= 0 && rtt <= RTT_SLIDER_MAX ? rtt : null;
};

/**
 * The same preference from the older `kn-demo-lag` key, which held one-way
 * milliseconds: doubled, and held to the slider's top. Null when the stored
 * text is not a lag.
 */
export const legacyRttPreference = (stored: string): number | null => {
  const lag = Number(stored);
  return Number.isFinite(lag) && lag >= 0 ? Math.min(RTT_SLIDER_MAX, lag * 2) : null;
};

/** Where a slider animation starts: the slider's value, 0 when it is not a number. */
export const lagAnimationStart = (value: SliderValue): number => Number(value) || 0;

/** A move of under 1 ms is made at once instead of animated. */
export const lagMoveIsInstant = (start: number, target: number): boolean => Math.abs(target - start) < 1;

/** One frame of the slider's move from `start` to `target`. */
export type LagAnimationFrame = {
  /** The slider's value this frame. */
  readonly value: string;
  /** The move has arrived; no further frame is needed. */
  readonly done: boolean;
};

/** The slider's position `elapsedMs` into a move that takes `durationMs`: fast at first, slowing to a stop. */
export const lagAnimationFrame = (
  start: number,
  target: number,
  elapsedMs: number,
  durationMs: number,
): LagAnimationFrame => {
  const t = Math.min(1, elapsedMs / durationMs);
  const eased = 1 - Math.pow(1 - t, 3);
  return { value: String(Math.round(start + (target - start) * eased)), done: !(t < 1) };
};
