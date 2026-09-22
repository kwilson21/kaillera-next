/**
 * High-resolution freeze detector — runs an in-page rAF probe that
 * records every (timestamp, frameCounter) pair during demo setup, so
 * sub-250ms freezes (rollback bursts, worker-coproc gate stalls,
 * wasm-step hiccups) get captured. The previous 250ms-interval trace
 * misses freezes shorter than its sample period.
 *
 * Each rAF the probe checks:
 *  - knFrame: NetplayRollback._frameNum (sim frame)
 *  - perfNow: high-res timestamp
 *  - paintedFrame: a counter incremented by a hooked overrideRAF that
 *    fires every browser composite tick (separates sim freeze from
 *    paint freeze)
 *
 * After the run we walk the records and emit any window where:
 *  - knFrame didn't advance for ≥ 80 ms (sim freeze) — 5 frames at
 *    60 Hz, well above one-rollback noise
 *  - paintedFrame didn't advance for ≥ 100 ms (paint freeze)
 */
import { chromium } from 'playwright';

const ROM_PATH = '/Users/kazon/kaillera-next/.playwright-mcp/smash_remix.z64';
const SIM_FREEZE_THRESHOLD_MS = 80;
const PAINT_FREEZE_THRESHOLD_MS = 100;

async function trace(url) {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  const errors = [];
  const stuckEvents = [];
  const syncLog = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() === 'error') errors.push(t.slice(0, 240));
    if (t.includes('TICK-STUCK') || t.includes('REPLAY-NORUN') || t.includes('FATAL') || t.includes('STALL')) {
      stuckEvents.push(t.slice(0, 1500));
    }
    if (
      t.includes('WORKER-COPROC') ||
      t.includes('AUTOPILOT') ||
      t.includes('ROLLBACK-STALL') ||
      t.includes('PEER-PHANTOM') ||
      t.includes('PEER-RECOVERED') ||
      t.includes('C-REPLAY') ||
      t.includes('REPLAY-NORUN') ||
      t.includes('INPUT-FIRST') ||
      t.includes('peer-tracking-reset')
    ) {
      syncLog.push(t.slice(0, 280));
    }
  });

  console.log('→ navigate', url);
  await page.goto(url);

  // Inject the high-res probe BEFORE any other JS runs the rAF loop —
  // hooks paintedFrame counter onto window.requestAnimationFrame.
  await page.evaluate(() => {
    window.__knFreezeProbe = {
      records: [],
      paintedFrame: 0,
      running: false,
      fakePeerSends: [],
    };
    window.__knFakePeerProbe = [];
    // Hook fake-peer's _scheduleFrame to capture every input it sends.
    // KNFakePeer is the public API; we instrument by wrapping start.
    const origStart = window.KNFakePeer?.start;
    if (origStart) {
      window.KNFakePeer.start = function (opts) {
        const wrapped = { ...opts };
        const origGetFrame = opts.getCurrentFrame;
        wrapped.getCurrentFrame = () => {
          const f = origGetFrame ? origGetFrame() : 0;
          // Record each rAF read so we can correlate with main's advance.
          window.__knFreezeProbe.fakePeerSends.push({ t: performance.now(), readFrame: f });
          if (window.__knFreezeProbe.fakePeerSends.length > 4_000) {
            window.__knFreezeProbe.fakePeerSends.shift();
          }
          return f;
        };
        return origStart.call(this, wrapped);
      };
    }
    const realRAF = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      return realRAF((ts) => {
        window.__knFreezeProbe.paintedFrame++;
        return cb(ts);
      });
    };
    const tick = () => {
      if (!window.__knFreezeProbe.running) return;
      const hud = window.NetplayRollback?.getHudCounters?.() || {};
      const coproc = window.knWorkerCoprocStats?.() || {};
      window.__knFreezeProbe.records.push({
        t: performance.now(),
        knFrame: hud.currentFrame ?? -1,
        paintedFrame: window.__knFreezeProbe.paintedFrame,
        rollbacks: hud.rollbackEventsTotal ?? 0,
        delay: hud.delay ?? 0,
        coprocPending: coproc.pending?.seq ?? null,
        coprocDispatched: coproc.dispatched ?? 0,
        coprocCompleted: coproc.completed ?? 0,
        coprocFailed: coproc.failed ?? 0,
        coprocTimeouts: coproc.timeouts ?? 0,
        coprocWatchdogTrips: coproc.watchdogTrips ?? 0,
        coprocAborted: coproc.enabled === false || coproc.aborted ? 1 : 0,
      });
      // Cap records to last ~60s of data so we don't blow memory.
      if (window.__knFreezeProbe.records.length > 12_000) window.__knFreezeProbe.records.shift();
      realRAF(tick);
    };
    window.__knFreezeProbeStart = () => {
      window.__knFreezeProbe.running = true;
      window.__knFreezeProbe.t0 = performance.now();
      realRAF(tick);
    };
    window.__knFreezeProbeStop = () => {
      window.__knFreezeProbe.running = false;
    };
  });

  await page.locator('#rom-file').setInputFiles(ROM_PATH);
  await page.waitForSelector('#gesture-button', { state: 'visible', timeout: 10_000 });

  console.log('→ start probe + click gesture');
  await page.evaluate(() => {
    window.__knFreezeProbeStart();
    document.getElementById('gesture-button')?.click();
  });

  // Run for 35 s — enough to cover boot + autopilot + first match start.
  await new Promise((r) => setTimeout(r, 35_000));

  const { records, syncLogTail, freezeState, fakePeerSends, tickReturnStats, fakePeerProbe, cRollbackThrowSamples } =
    await page.evaluate(() => {
      window.__knFreezeProbeStop();
      // _syncLog writes to a private circular buffer; only "critical" messages
      // hit console.log. Pull the ring directly to capture ROLLBACK-STALL,
      // PEER-PHANTOM, etc.
      const ring = window._knSyncLogRing || window.NetplayRollback?._syncLogRing;
      let tail = [];
      try {
        const all = ring?.entries?.() ?? ring?.snapshot?.() ?? [];
        tail = all.slice(-200).map((e) => `t=${e.t | 0} f=${e.f} ${e.msg}`);
      } catch (_) {}
      // Snapshot the engine's view of peer freshness — the rollback-stall
      // condition reads `_peerLastAdvanceTime[slot]`, fake-peer's
      // `getCurrentFrame()` reads `_frameNum`. Capture both via the
      // exposed HUD + introspection paths.
      const hud = window.NetplayRollback?.getHudCounters?.() || {};
      const peerSnap = window.NetplayRollback?.getPeerSnap?.() || null;
      const fakePeerStats = window.KNFakePeer?.getStats?.() || null;
      const fakePeerFrame = window.KNFakePeer?.getCurrentSendingFrame?.() || null;
      const tickReturnStats = window.knTickReturnStats?.() || null;
      const fakePeerProbe = (window.__knFakePeerProbe || []).slice();
      const cRollbackThrowSamples = (window.__knCRollbackThrowSamples || []).slice();
      return {
        records: window.__knFreezeProbe.records.slice(),
        syncLogTail: tail,
        fakePeerSends: window.__knFreezeProbe.fakePeerSends.slice(),
        tickReturnStats,
        fakePeerProbe,
        cRollbackThrowSamples,
        freezeState: {
          knFrame: hud.currentFrame ?? -1,
          peerSnap,
          fakePeerStats,
          fakePeerFrame,
        },
      };
    });
  // Mix in-page sync-ring entries with the console-captured ones.
  for (const e of syncLogTail) syncLog.push(`[ring] ${e.slice(0, 280)}`);

  // Walk records to find sim-freeze + paint-freeze windows.
  const simFreezes = [];
  const paintFreezes = [];
  let lastSimAdvanceIdx = 0;
  let lastPaintAdvanceIdx = 0;
  for (let i = 1; i < records.length; i++) {
    const cur = records[i];
    const lastSim = records[lastSimAdvanceIdx];
    if (cur.knFrame !== lastSim.knFrame) {
      const dt = cur.t - lastSim.t;
      if (dt >= SIM_FREEZE_THRESHOLD_MS) {
        simFreezes.push({
          startT: Math.round(lastSim.t),
          endT: Math.round(cur.t),
          durationMs: +dt.toFixed(1),
          frame: lastSim.knFrame,
          rollbacksDelta: cur.rollbacks - lastSim.rollbacks,
        });
      }
      lastSimAdvanceIdx = i;
    }
    const lastPaint = records[lastPaintAdvanceIdx];
    if (cur.paintedFrame !== lastPaint.paintedFrame) {
      const dt = cur.t - lastPaint.t;
      if (dt >= PAINT_FREEZE_THRESHOLD_MS) {
        paintFreezes.push({
          startT: Math.round(lastPaint.t),
          endT: Math.round(cur.t),
          durationMs: +dt.toFixed(1),
          paintedFrame: lastPaint.paintedFrame,
          knFrame: lastPaint.knFrame,
        });
      }
      lastPaintAdvanceIdx = i;
    }
  }
  // Annotate freeze windows with coproc-pending state at the moment the
  // freeze started. If pending is non-null at freeze start AND the last
  // record still shows pending non-null, the worker reply never arrived
  // and the safety timeouts didn't fire — that's a different bug than
  // a peer-stale freeze that happens with pending=null.
  for (const f of simFreezes) {
    const startRec = records.find((r) => Math.round(r.t) === f.startT);
    const endRec = records.find((r) => Math.round(r.t) === f.endT) || records.at(-1);
    f.pendingAtStart = startRec?.coprocPending ?? null;
    f.pendingAtEnd = endRec?.coprocPending ?? null;
    f.coprocCompletedDelta = (endRec?.coprocCompleted ?? 0) - (startRec?.coprocCompleted ?? 0);
    f.coprocTimeoutsDelta = (endRec?.coprocTimeouts ?? 0) - (startRec?.coprocTimeouts ?? 0);
    f.coprocWatchdogTripsDelta = (endRec?.coprocWatchdogTrips ?? 0) - (startRec?.coprocWatchdogTrips ?? 0);
  }
  // Tail freeze: if the last sample never advanced from the last-known
  // advance, that's a still-active freeze (frame stuck through end of
  // run). The forward walk above only records freezes that ENDED; this
  // catches the persistent "demo frozen to end" case the user sees.
  if (records.length > 1) {
    const last = records.at(-1);
    const lastSim = records[lastSimAdvanceIdx];
    if (last.knFrame === lastSim.knFrame) {
      const dt = last.t - lastSim.t;
      if (dt >= SIM_FREEZE_THRESHOLD_MS) {
        simFreezes.push({
          startT: Math.round(lastSim.t),
          endT: Math.round(last.t),
          durationMs: +dt.toFixed(1),
          frame: lastSim.knFrame,
          rollbacksDelta: last.rollbacks - lastSim.rollbacks,
          stillActive: true,
        });
      }
    }
  }

  console.log('\n────────── FREEZE DETECTOR ──────────');
  console.log(`records: ${records.length}`);
  if (records.length > 0) {
    console.log(`first sample t=${records[0].t.toFixed(0)}ms frame=${records[0].knFrame}`);
    console.log(
      `last sample  t=${records.at(-1).t.toFixed(0)}ms frame=${records.at(-1).knFrame} rollbacks=${records.at(-1).rollbacks}`,
    );
  }
  // Boot freeze (sim freeze where frame stays 0/-1) is expected — call it out separately.
  const bootFreeze = simFreezes.find((f) => f.frame <= 0);
  const realSimFreezes = simFreezes.filter((f) => f.frame > 0);
  console.log(`\nboot freeze (frame=0): ${bootFreeze ? `${bootFreeze.durationMs}ms (expected, ~2.5s)` : 'none'}`);
  console.log(`\nsim freezes (frame>0, ≥${SIM_FREEZE_THRESHOLD_MS}ms): ${realSimFreezes.length}`);
  for (const f of realSimFreezes.slice(0, 30)) {
    console.log(
      `  t=${f.startT}-${f.endT}ms (${f.durationMs}ms) atFrame=${f.frame} rbΔ=${f.rollbacksDelta}` +
        ` pendingStart=${f.pendingAtStart} pendingEnd=${f.pendingAtEnd}` +
        ` cpCompletedΔ=${f.coprocCompletedDelta ?? 0} cpTimeoutsΔ=${f.coprocTimeoutsDelta ?? 0} cpWatchdogΔ=${f.coprocWatchdogTripsDelta ?? 0}`,
    );
  }
  if (realSimFreezes.length > 30) console.log(`  ... +${realSimFreezes.length - 30} more`);
  // Paint freezes deeper than the sim freezes mean rendering is the
  // bottleneck (sim ticking but no composite). Filter out anything that
  // overlaps a known sim freeze (those are the same event from a
  // different lens).
  const standalonePaint = paintFreezes.filter(
    (p) => !simFreezes.some((s) => s.startT <= p.startT && p.endT <= s.endT + 50),
  );
  console.log(
    `\nstandalone paint freezes (≥${PAINT_FREEZE_THRESHOLD_MS}ms, no overlapping sim freeze): ${standalonePaint.length}`,
  );
  for (const p of standalonePaint.slice(0, 20)) {
    console.log(`  t=${p.startT}-${p.endT}ms (${p.durationMs}ms) atFrame=${p.knFrame}`);
  }
  if (standalonePaint.length > 20) console.log(`  ... +${standalonePaint.length - 20} more`);

  console.log(`\nstuck events: ${stuckEvents.length}`);
  for (const e of stuckEvents.slice(0, 5)) console.log(`  ${e}`);
  console.log(`\nfreeze state at end:`);
  console.log(`  knFrame=${freezeState.knFrame}`);
  console.log(`  fakePeerFrame=${JSON.stringify(freezeState.fakePeerFrame)}`);
  console.log(`  fakePeerStats=${JSON.stringify(freezeState.fakePeerStats)?.slice(0, 240)}`);
  console.log(`  peerSnap=${JSON.stringify(freezeState.peerSnap)?.slice(0, 360)}`);
  // Show what fake-peer was reading from main around the freeze.
  if (fakePeerSends.length > 0 && realSimFreezes.length > 0) {
    const f = realSimFreezes[0];
    const around = fakePeerSends.filter((s) => s.t >= f.startT - 500 && s.t <= f.startT + 3000);
    console.log(`\nfake-peer reads near first sim freeze (${around.length} samples in window):`);
    let lastReadFrame = -1;
    let unchangedCount = 0;
    for (const s of around) {
      if (s.readFrame === lastReadFrame) {
        unchangedCount++;
      } else {
        if (unchangedCount > 0) {
          console.log(`  ... (read same frame ${unchangedCount} more times)`);
        }
        console.log(`  t=${s.t.toFixed(0)}ms readFrame=${s.readFrame}`);
        lastReadFrame = s.readFrame;
        unchangedCount = 0;
      }
    }
    if (unchangedCount > 0) console.log(`  ... (read same frame ${unchangedCount} more times)`);
  }
  if (fakePeerProbe?.length && realSimFreezes.length > 0) {
    const freeze = realSimFreezes[0];
    console.log(`\nfake-peer ticks around first freeze (${freeze.startT}-${freeze.endT}ms):`);
    const around = fakePeerProbe.filter((p) => p.t >= freeze.startT - 200 && p.t <= freeze.endT + 200);
    let lastEng = -1;
    for (const p of around.slice(0, 60)) {
      const marker = p.engineFrame !== lastEng ? '↑' : ' ';
      console.log(
        `  t=${p.t.toFixed(0)}ms ${marker}eng=${p.engineFrame} last=${p.lastSeenFrame} stall=${p.stallTicks} la=${p.lookahead} sched=${p.scheduledThisTick} q=${p.queueLen}`,
      );
      lastEng = p.engineFrame;
    }
    if (around.length > 60) console.log(`  ... +${around.length - 60} more`);
  } else if (fakePeerProbe?.length) {
    console.log(`\nfake-peer last 20 ticks (no freeze detected):`);
    for (const p of fakePeerProbe.slice(-20)) {
      console.log(
        `  t=${p.t.toFixed(0)}ms eng=${p.engineFrame} last=${p.lastSeenFrame} stall=${p.stallTicks} la=${p.lookahead} sched=${p.scheduledThisTick} q=${p.queueLen}`,
      );
    }
  }
  if (tickReturnStats) {
    console.log(`\ntick early-return counts (entered=${tickReturnStats.tickEntered}):`);
    const sorted = Object.entries(tickReturnStats.counts).sort((a, b) => b[1] - a[1]);
    for (const [tag, n] of sorted) console.log(`  ${tag}: ${n}`);
    if (tickReturnStats.checkpointCounts) {
      console.log(`\ntick checkpoint counts (lastCp=${tickReturnStats.lastCheckpoint}):`);
      const cpSorted = Object.entries(tickReturnStats.checkpointCounts).sort((a, b) => b[1] - a[1]);
      for (const [cp, n] of cpSorted) console.log(`  ${cp}: ${n}`);
    }
    console.log(`\ntick recent-history (last ${tickReturnStats.recent.length}):`);
    for (const r of tickReturnStats.recent) {
      console.log(`  t=${r.t.toFixed(0)}ms frame=${r.frame} ${r.tag}`);
    }
  }
  if (cRollbackThrowSamples?.length) {
    console.log(`\nC-ROLLBACK-THROW samples (${cRollbackThrowSamples.length}):`);
    for (const s of cRollbackThrowSamples) {
      console.log(
        `  t=${s.t.toFixed(0)}ms f=${s.f} cp=${s.cp} fAdv=${s.frameAdv} replayDepth=${s.replayDepth} pendingRb=${s.pendingRb} rbFrame=${s.rbFrame} rbCount=${s.rollbackCount} failed=${s.failedRollbacks} diagPhase=${s.diagPhase} diagSlot=0x${(s.diagSlot >>> 0).toString(16)} pcRaw=0x${(s.diagSerCount >>> 0).toString(16)} memSize=0x${(s.wasmMemSize >>> 0).toString(16)} msg=${s.msg}`,
      );
      console.log(`    stack: ${s.stack.slice(0, 800).replace(/\n/g, '\n           ')}`);
      if (s.cDebugTail) {
        console.log(`    C-debug tail (last 2400 chars):`);
        for (const ln of s.cDebugTail.split('\n').slice(-30)) {
          if (ln.trim()) console.log(`       [C] ${ln}`);
        }
      }
    }
  }
  console.log(`\nrelevant log lines: ${syncLog.length}`);
  for (const e of syncLog.slice(-40)) console.log(`  ${e}`);
  console.log(`\npage errors: ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log(`  ${e}`);

  await browser.close();
  return { realSimFreezes, standalonePaint, errors, stuckEvents };
}

const URL = process.env.URL || 'https://localhost:27888/demo.html';
trace(URL).catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
