/**
 * Input-driven freeze + twitch detector for the Mode 2 rollback demo.
 *
 * The freeze detector runs the demo with autopilot only (no real key
 * presses) — that hits the auto-compare lockstep blip path. The user
 * reports two distinct issues we don't catch there:
 *
 *  1. "Stuck on stage select" — sometimes the autopilot or post-autopilot
 *     navigation freezes mid-menu.
 *  2. "Serious twitches" once the user presses keys.
 *
 * This harness:
 *  - Boots the demo via the existing flow.
 *  - Autopilots through menus (no input).
 *  - When the demo hits gameplay, starts spamming a button mash pattern
 *    (mash A + analog stick) to provoke mispredictions and rollbacks.
 *  - Every rAF, capture {t, knFrame, paintedFrame, rollbacks, replayDepth,
 *    visualFreezeActive, _frameNum-changeWasBackward}.
 *  - At the end, walk the records and emit:
 *      - Sim-freeze windows (frame stuck >= threshold).
 *      - Twitch windows (frame went backward then forward more than
 *        depth N within a short wall-clock window).
 *      - Rollback depth distribution.
 *      - Worker coproc dispatch / completion gaps.
 */
import { chromium } from 'playwright';

const ROM_PATH = '/Users/kazon/kaillera-next/.playwright-mcp/smash_remix.z64';
const SIM_FREEZE_THRESHOLD_MS = 60; // tighter than detector's 80 ms — twitches are shorter
const PAINT_FREEZE_THRESHOLD_MS = 60;
const TWITCH_BACKWARD_FRAMES = 1; // any backward step counts
const RUN_TOTAL_MS = 35_000;
const INPUT_START_MS = 12_000; // after autopilot finishes (~15 s) and gameplay begins

// Smash 64 keyboard map (from web/static/shared.js DEFAULT_N64_KEYMAP):
//   C=A, X=B, Enter=Start, arrows=D-pad, A/D/S/W=analog stick.
// Pattern: alternate analog-direction + A button to provoke many small
// mispredictions during gameplay.
const INPUT_PATTERN = [
  { down: 'KeyD', dur: 80 }, // analog right
  { down: 'KeyC', dur: 60 }, // A button
  { down: 'KeyA', dur: 80 }, // analog left
  { down: 'KeyC', dur: 60 }, // A button
  { down: 'KeyW', dur: 80 }, // analog up
  { down: 'KeyX', dur: 60 }, // B button
  { down: 'KeyS', dur: 80 }, // analog down
  { down: 'KeyC', dur: 60 }, // A
];

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
      stuckEvents.push(t.slice(0, 1200));
    }
    if (
      t.includes('WORKER-COPROC') ||
      t.includes('AUTOPILOT') ||
      t.includes('ROLLBACK-STALL') ||
      t.includes('PEER-PHANTOM') ||
      t.includes('C-REPLAY') ||
      t.includes('REPLAY-NORUN') ||
      t.includes('predictions ') ||
      t.includes('MENU-LOCKSTEP') ||
      t.includes('PHASE-LOCK') ||
      t.includes('C-ROLLBACK-THROW')
    ) {
      syncLog.push(t.slice(0, 280));
    }
  });

  console.log('→ navigate', url);
  await page.goto(url);

  await page.evaluate(() => {
    window.__knTwitchProbe = {
      records: [],
      paintedFrame: 0,
      running: false,
      backwardJumps: [], // { t, prevFrame, newFrame, depth }
      lastKnFrame: -1,
    };
    const realRAF = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      return realRAF((ts) => {
        window.__knTwitchProbe.paintedFrame++;
        return cb(ts);
      });
    };
    const tick = () => {
      if (!window.__knTwitchProbe.running) return;
      const hud = window.NetplayRollback?.getHudCounters?.() || {};
      const coproc = window.knWorkerCoprocStats?.() || {};
      const knFrame = hud.currentFrame ?? -1;
      const prev = window.__knTwitchProbe.lastKnFrame;
      // Backward jump = rollback restore took _frameNum below previous max.
      if (prev > 0 && knFrame > 0 && knFrame < prev) {
        window.__knTwitchProbe.backwardJumps.push({
          t: performance.now(),
          prevFrame: prev,
          newFrame: knFrame,
          depth: prev - knFrame,
        });
        if (window.__knTwitchProbe.backwardJumps.length > 1_000) window.__knTwitchProbe.backwardJumps.shift();
      }
      if (knFrame > prev) window.__knTwitchProbe.lastKnFrame = knFrame;
      const tickMod = window.EJS_emulator?.gameManager?.Module;
      window.__knTwitchProbe.records.push({
        t: performance.now(),
        knFrame,
        paintedFrame: window.__knTwitchProbe.paintedFrame,
        rollbacks: hud.rollbackEventsTotal ?? 0,
        replayDepth: tickMod?._kn_get_replay_depth?.() ?? -1,
        replayCount: tickMod?._kn_get_rollback_count?.() ?? -1,
        coprocDispatched: coproc.dispatched ?? 0,
        coprocCompleted: coproc.completed ?? 0,
        visualFreeze: window.NetplayRollback?.getVisualFreezeStats?.()?.active ? 1 : 0,
      });
      if (window.__knTwitchProbe.records.length > 12_000) window.__knTwitchProbe.records.shift();
      realRAF(tick);
    };
    window.__knTwitchProbeStart = () => {
      window.__knTwitchProbe.running = true;
      window.__knTwitchProbe.t0 = performance.now();
      realRAF(tick);
    };
    window.__knTwitchProbeStop = () => {
      window.__knTwitchProbe.running = false;
    };
  });

  await page.locator('#rom-file').setInputFiles(ROM_PATH);
  await page.waitForSelector('#gesture-button', { state: 'visible', timeout: 10_000 });

  console.log('→ start probe + click gesture');
  await page.evaluate(() => {
    window.__knTwitchProbeStart();
    document.getElementById('gesture-button')?.click();
  });

  // Wait for autopilot to finish + gameplay to start.
  console.log(`→ wait ${INPUT_START_MS} ms before starting input mash...`);
  await new Promise((r) => setTimeout(r, INPUT_START_MS));

  // Mash inputs for the remainder of the run.
  const mashEnd = Date.now() + (RUN_TOTAL_MS - INPUT_START_MS - 500);
  console.log(`→ mashing inputs until t≈${RUN_TOTAL_MS}ms...`);
  let i = 0;
  while (Date.now() < mashEnd) {
    const step = INPUT_PATTERN[i++ % INPUT_PATTERN.length];
    try {
      await page.keyboard.down(step.down);
      await new Promise((r) => setTimeout(r, step.dur));
      await page.keyboard.up(step.down);
    } catch (e) {
      console.log('→ keyboard event failed:', e?.message || e);
      break;
    }
  }

  await new Promise((r) => setTimeout(r, 500));

  const result = await page.evaluate(() => {
    window.__knTwitchProbeStop();
    const ring = window._knSyncLogRing || window.NetplayRollback?._syncLogRing;
    let tail = [];
    try {
      const all = ring?.entries?.() ?? ring?.snapshot?.() ?? [];
      tail = all.slice(-200).map((e) => `t=${e.t | 0} f=${e.f} ${e.msg}`);
    } catch (_) {}
    const tickReturnStats = window.knTickReturnStats?.() || null;
    return {
      records: window.__knTwitchProbe.records.slice(),
      backwardJumps: window.__knTwitchProbe.backwardJumps.slice(),
      syncLogTail: tail,
      tickReturnStats,
      hud: window.NetplayRollback?.getHudCounters?.() || {},
    };
  });
  for (const e of result.syncLogTail) syncLog.push(`[ring] ${e.slice(0, 280)}`);

  const records = result.records;
  // Walk for sim freezes.
  const simFreezes = [];
  let lastIdx = 0;
  for (let i = 1; i < records.length; i++) {
    const cur = records[i];
    const last = records[lastIdx];
    if (cur.knFrame !== last.knFrame) {
      const dt = cur.t - last.t;
      if (dt >= SIM_FREEZE_THRESHOLD_MS) {
        simFreezes.push({
          startT: Math.round(last.t),
          endT: Math.round(cur.t),
          durationMs: +dt.toFixed(1),
          frame: last.knFrame,
          rollbacksDelta: cur.rollbacks - last.rollbacks,
          coprocCompletedDelta: cur.coprocCompleted - last.coprocCompleted,
        });
      }
      lastIdx = i;
    }
  }
  // Trailing freeze.
  if (records.length > 1) {
    const lastSample = records.at(-1);
    const lastAdv = records[lastIdx];
    if (lastSample.knFrame === lastAdv.knFrame) {
      const dt = lastSample.t - lastAdv.t;
      if (dt >= SIM_FREEZE_THRESHOLD_MS) {
        simFreezes.push({
          startT: Math.round(lastAdv.t),
          endT: Math.round(lastSample.t),
          durationMs: +dt.toFixed(1),
          frame: lastAdv.knFrame,
          rollbacksDelta: lastSample.rollbacks - lastAdv.rollbacks,
          coprocCompletedDelta: lastSample.coprocCompleted - lastAdv.coprocCompleted,
          stillActive: true,
        });
      }
    }
  }

  // Backward-jump distribution.
  const depthHistogram = {};
  for (const j of result.backwardJumps) {
    depthHistogram[j.depth] = (depthHistogram[j.depth] || 0) + 1;
  }

  console.log('\n────────── INPUT TWITCH DETECTOR ──────────');
  console.log(`records: ${records.length}`);
  if (records.length > 0) {
    console.log(`first  t=${records[0].t.toFixed(0)}ms frame=${records[0].knFrame}`);
    console.log(
      `last   t=${records.at(-1).t.toFixed(0)}ms frame=${records.at(-1).knFrame} rollbacks=${records.at(-1).rollbacks} coprocCompleted=${records.at(-1).coprocCompleted}`,
    );
  }
  // Split by phase: pre-input vs during-input.
  const inputStartT = INPUT_START_MS;
  const preInput = records.filter((r) => r.t < inputStartT);
  const duringInput = records.filter((r) => r.t >= inputStartT);
  const preFreezes = simFreezes.filter((f) => f.startT < inputStartT);
  const inputFreezes = simFreezes.filter((f) => f.startT >= inputStartT);
  const preBackJumps = result.backwardJumps.filter((j) => j.t < inputStartT);
  const inputBackJumps = result.backwardJumps.filter((j) => j.t >= inputStartT);

  console.log(`\n── PRE-INPUT phase (autopilot, ${preInput.length} samples, t<${inputStartT}ms) ──`);
  console.log(`sim freezes ≥${SIM_FREEZE_THRESHOLD_MS}ms: ${preFreezes.length}`);
  for (const f of preFreezes.slice(0, 12)) {
    console.log(
      `  t=${f.startT}-${f.endT}ms (${f.durationMs}ms) atFrame=${f.frame} rbΔ=${f.rollbacksDelta} cpΔ=${f.coprocCompletedDelta}`,
    );
  }
  console.log(`backward jumps (rollback restores): ${preBackJumps.length}`);

  console.log(`\n── DURING-INPUT phase (${duringInput.length} samples, t≥${inputStartT}ms) ──`);
  console.log(`sim freezes ≥${SIM_FREEZE_THRESHOLD_MS}ms: ${inputFreezes.length}`);
  for (const f of inputFreezes.slice(0, 30)) {
    console.log(
      `  t=${f.startT}-${f.endT}ms (${f.durationMs}ms) atFrame=${f.frame} rbΔ=${f.rollbacksDelta} cpΔ=${f.coprocCompletedDelta}`,
    );
  }
  if (inputFreezes.length > 30) console.log(`  ... +${inputFreezes.length - 30} more`);
  console.log(`backward jumps (rollback restores): ${inputBackJumps.length}`);
  console.log(`backward-jump depth histogram:`);
  const depths = Object.keys(depthHistogram)
    .map(Number)
    .sort((a, b) => a - b);
  for (const d of depths) console.log(`  depth=${d}: ${depthHistogram[d]} jumps`);

  if (result.tickReturnStats) {
    console.log(`\ntick early-return counts (entered=${result.tickReturnStats.tickEntered}):`);
    const sorted = Object.entries(result.tickReturnStats.counts).sort((a, b) => b[1] - a[1]);
    for (const [tag, n] of sorted) console.log(`  ${tag}: ${n}`);
  }

  console.log(`\nrelevant log lines: ${syncLog.length}`);
  for (const e of syncLog.slice(-30)) console.log(`  ${e}`);
  console.log(`\nstuck events: ${stuckEvents.length}`);
  for (const e of stuckEvents.slice(0, 5)) console.log(`  ${e}`);
  console.log(`\npage errors: ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log(`  ${e}`);

  await browser.close();
  return { simFreezes, backwardJumps: result.backwardJumps, errors, stuckEvents };
}

const URL =
  process.env.URL || 'https://localhost:27888/demo.html?rollbackMode=2&autoCompare=0&verbose=1&tickReturnTrace=1';
trace(URL).catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
