export interface CLogTail {
  /** The text not yet drained. */
  tail: string;
  /** How much of the buffer has been drained once this tail is sent. */
  drained: number;
}

/**
 * The part of the C rollback engine's debug log not yet drained into the
 * sync log (netplay-rollback.js, `_drainCDebugLog`).
 *
 * The C buffer (`rb.debug_log`, kn_rollback.c `rb_log`) only grows between
 * inits: lines are appended until it is full, then new ones are dropped.
 * `kn_rollback_init` starts it over, and the engine drains it just before and
 * resets its count just after. A buffer shorter than what was drained can only
 * be a new one, so it is drained from its start rather than skipped.
 *
 * @param full     the whole C buffer as it is now
 * @param drained  how much of it was drained before
 */
export function cLogTail(full: string, drained: number): CLogTail {
  if (full.length < drained) return { tail: full, drained: full.length };
  return { tail: full.slice(drained), drained: full.length };
}
