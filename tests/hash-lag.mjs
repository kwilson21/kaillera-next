/**
 * How far behind the newest frame the two-player and mesh runs read a
 * frame's hashes, so that every frame they compare is one the engine can no
 * longer change.
 *
 * The hashes (kn_gameplay_hash, kn_game_state_hash, kn_full_state_hash) read
 * the state the C engine saved for a frame in its ring
 * (build/kn_rollback/kn_rollback.c). Ring slot `f` holds the state before
 * frame f ran: kn_pre_tick saves it, then the frame is stepped, then
 * kn_post_tick increments rb.frame and returns it. The harness reads at
 * that return, `r`. At that moment:
 *
 *   - The ring holds max + 1 slots (kn_rollback_init: ring_size =
 *     max_frames + 1), the states saved before frames r-1-max .. r-1. The
 *     next kn_pre_tick overwrites the oldest of them (r-1-max) with r's.
 *   - A later misprediction is found by kn_feed_input while rb.frame >= r.
 *     It rewinds to rb_rollback_target(), t, only when
 *     depth = rb.frame - t <= max_frames (kn_feed_input; kn_pre_tick checks
 *     the same bound again before it restores). So t >= r - max.
 *   - The replay restores slot t and saves every slot from t to the frame
 *     it started from again (rb_save_slot on each C-REPLAY-FRAME): t's from
 *     the restored bytes, every later one from a re-run frame.
 *
 * So the newest slot no rollback can ever write again is r - max - 1, which
 * is also the oldest the ring still holds at that moment: the lag is
 * max + 1. A smaller lag (the old constant 12, with max = 22) reads frames a
 * late input 13 to 22 frames back can still rewrite, and compares one page's
 * speculative state with another's final one. The tighter cap on how deep a
 * misprediction is rewound (KN_MAX_VISIBLE_ROLLBACK_DEPTH, a compile-time
 * flag) is not relied on: max is the bound the ring itself enforces.
 *
 * max is the page's own: whatever it passed to kn_rollback_init
 * (netplay-rollback.js: max(12, ROLLBACK_MAX_DELAY_FRAMES + 10,
 * delay + 10), 22 in practice). A page that arms again mid-match (the
 * late-join re-arm calls kn_rollback_init again) takes the new value from
 * then on. Not covered: Mode 2's deferred apply (?workerCoproc=1, off by
 * default), which sets the worker's corrected state live without saving it
 * into main's ring.
 */

/** The lag for a page whose engine was armed with this rollback window. */
export const hashLagOf = (rollbackMax) => rollbackMax + 1;

/**
 * Runs in the page (page.evaluate). Keeps window.__knHashLag = {max, lag,
 * inits} current: from the last `C-ROLLBACK init: max=` line in the sync log
 * (an engine armed before this ran) and from every later kn_rollback_init
 * call, which it wraps. `lag` is null until the engine has been armed.
 * Returns the lag known now.
 */
export function trackHashLag() {
  const T = window.__knHashLag ?? (window.__knHashLag = { max: null, lag: null, inits: [] });
  const set = (max, source) => {
    T.max = max;
    T.lag = max + 1;
    T.inits.push({ max, lag: T.lag, source });
  };
  if (T.max === null) {
    const armed = [...(window.NetplayRollback?.exportSyncLog?.() || '').matchAll(/C-ROLLBACK init: max=(\d+)/g)];
    if (armed.length) set(Number(armed.at(-1)[1]), 'sync-log');
  }
  const m = window.EJS_emulator?.gameManager?.Module;
  if (m?._kn_rollback_init && !m._kn_rollback_init.__knHashLag) {
    const init = m._kn_rollback_init;
    const wrapped = function (max, ...rest) {
      set(Number(max), 'kn_rollback_init');
      return init.call(this, max, ...rest);
    };
    wrapped.__knHashLag = true;
    m._kn_rollback_init = wrapped;
  }
  return T.lag;
}

/**
 * Of the frames from `from` to `to` (inclusive), how many a page left with
 * no hashes (`missing`: never read, as when the lag was not yet known or a
 * resync took the page past them) or with a gameplay hash of 0 (`zero`: the
 * frame was not in the ring when read, as right after a resync or when the
 * engine skipped its saves).
 */
export const unrecordedIn = (hashes, from, to) => {
  let missing = 0,
    zero = 0;
  for (let f = from; f <= to; f++) {
    const h = hashes[f];
    if (!h) missing++;
    else if (!h[0]) zero++;
  }
  return { missing, zero };
};
