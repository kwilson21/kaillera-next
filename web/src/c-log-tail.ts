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

export interface CLogDrain {
  /** The text to send. */
  tail: string;
  /** How much of the buffer counts as drained once it is sent. */
  drained: number;
  /** Empty the C buffer once the text is read (kn_clear_debug_log). */
  clear: boolean;
}

/**
 * What one drain of the C log sends. A core that can empty its log gives the
 * whole buffer up each time, so the buffer only has to hold what is logged
 * between two drains; an older core keeps everything, and only its new tail
 * is sent (cLogTail).
 *
 * @param full      the whole C buffer as it is now
 * @param drained   how much of it was drained before (an older core only)
 * @param canClear  the core has kn_clear_debug_log
 */
export function cLogDrain(full: string, drained: number, canClear: boolean): CLogDrain {
  if (canClear) return { tail: full, drained: 0, clear: full.length > 0 };
  const next = cLogTail(full, drained);
  return { tail: next.tail, drained: next.drained, clear: false };
}

/**
 * Lines the C log dropped since the last drain, from its count since
 * kn_rollback_init (kn_get_debug_log_dropped). A count lower than before is
 * a new init's, all of it new.
 */
export function cLogDroppedSince(before: number, now: number): number {
  return now >= before ? now - before : now;
}
