// Run on a solo host. Two remote input streams are delivered to the packaged
// core directly so their order is deterministic even on a fast connection.
window.__replayTest.run = (delay) => {
  const mod = window.EJS_emulator.gameManager.Module;
  const driver = window.__replayTest;
  // The engine finds each pad's button-zero address at boot. Reading the
  // actual bytes covers both the normal JS writer and the native replay.
  const addresses = window.KNDiag.playerAddrs.slice(0, 3);
  if (addresses.some((address) => !address)) throw Error('Missing controller address');

  let kind;
  let rows;
  const pre = mod._kn_pre_tick;
  const post = mod._kn_post_tick;
  mod._kn_pre_tick = (...args) => (kind = pre(...args));
  mod._kn_post_tick = () => {
    const frame = mod._kn_get_frame();
    const pads = addresses.map((address) => mod.HEAPU8[address]);
    const next = post();
    if (next !== frame + 1) throw Error('Native frame did not advance');
    rows.push({ frame, kind, pads });
    return next;
  };

  const feed = (slot, tag, value) => mod._kn_feed_input(slot, tag, value, 0, 0, 0, 0);
  const step = () => {
    const count = rows.length;
    driver.tick(Number(mod._kn_get_frame() === 5));
    if (rows.length !== count + 1) throw Error('Expected exactly one core frame per page tick');
    return rows.at(-1);
  };
  const run = (late) => {
    rows = [];
    driver.reset();
    mod._kn_rollback_init(8, 1, 0, 3);
    mod._kn_set_true_rollback(1);
    mod._kn_set_rdram_preserve(mod._kn_get_rdram_ptr());
    for (let frame = 0; frame < 8; frame++) {
      if (!late || frame < 4) feed(1, frame, Number(frame >= 4));
      if (!late || frame < 2) feed(2, frame, Number(frame >= 2));
      step();
    }
    driver.setDelay(delay);
    if (mod._kn_set_delay_frames(delay) !== delay) throw Error('Delay retune failed');
    const corrections = [];
    if (late) {
      corrections.push(feed(1, 4, 1));
      const interrupted = step();
      if (interrupted.kind !== 2 || interrupted.frame !== 5) throw Error('Expected replay to start at 5');
      corrections.push(feed(2, 2, 1));
    }
    const after = rows.length;
    while (rows.at(-1).frame < 8 && rows.length < 24) step();
    const pads = [];
    for (const row of rows) pads[row.frame] = row.pads;
    return {
      corrections,
      replay: rows.filter((r) => r.kind === 2).map((r) => r.frame),
      firstLive: rows.slice(after).find((r) => r.kind === 0)?.frame,
      pads,
      failed: mod._kn_get_failed_rollbacks(),
    };
  };

  try {
    const reference = run(false);
    if (!mod._kn_restore_frame(0)) throw Error('Original ROM state is missing from the ring');
    // Restoring a state can invalidate the browser's captured frame runner.
    mod.pauseMainLoop();
    mod.resumeMainLoop();
    return { reference, delayed: run(true) };
  } finally {
    mod._kn_pre_tick = pre;
    mod._kn_post_tick = post;
  }
};
