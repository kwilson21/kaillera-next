/**
 * Did a `stepOneFrame()` runner call emulate the frame it was called for?
 *
 * Issue #62 (a click during a match desynced it): the engine's
 * requestAnimationFrame interceptor captured any callback, so a UI callback
 * could replace the captured Emscripten runner, and the next step then ran
 * nothing. The interceptor now captures only the runner; this classifier
 * stays as the check for any other cause of a stale one. Two signals:
 *
 *   - `rescheduled`: a fresh runner was captured during the call. A real
 *     step always schedules its own next frame.
 *   - `cycleBefore` / `cycleAfter`: the core's CP0 Count in ms
 *     (`kn_get_cycle_time_ms`) sampled around the call. A real step moves
 *     it; a step that ran nothing leaves it where it was.
 */

/**
 * `unknown`: a stock core without the cycle-time export, where a stale
 * runner cannot be told from a legitimate mid-frame pause, so the engine
 * does not step again.
 */
export type RunnerStep = 'unknown' | 'stale' | 'emulated';

export function classifyRunnerStep(
  rescheduled: boolean,
  cycleBefore: number | null | undefined,
  cycleAfter: number | null | undefined,
): RunnerStep {
  if (cycleBefore === null || cycleBefore === undefined || cycleAfter === null || cycleAfter === undefined) {
    return 'unknown';
  }
  if (!rescheduled && cycleAfter === cycleBefore) return 'stale';
  return 'emulated';
}
