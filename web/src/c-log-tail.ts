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

export interface CLogTailFrom extends CLogTail {
  /** Bytes the core dropped before they were drained. */
  missed: number;
}

/**
 * The same for a core whose log keeps its newest lines
 * (`kn_get_debug_log_dropped`): when its buffer is full it drops its oldest
 * lines and counts the bytes, and it runs on across inits. The buffer then
 * starts at the absolute offset `dropped`, and what was drained is an
 * absolute offset too.
 *
 * With `dropped` 0 the tail and the count are `cLogTail`'s.
 *
 * @param full     the whole C buffer as it is now
 * @param drained  the absolute offset drained before
 * @param dropped  the bytes the core has dropped from the front of its log
 */
export function cLogTailFrom(full: string, drained: number, dropped: number): CLogTailFrom {
  const end = dropped + full.length;
  if (end < drained) return { tail: full, drained: end, missed: 0 };
  const from = drained - dropped;
  if (from < 0) return { tail: full, drained: end, missed: -from };
  return { tail: full.slice(from), drained: end, missed: 0 };
}
