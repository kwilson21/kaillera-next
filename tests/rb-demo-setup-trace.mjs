/**
 * Demo setup trace: load demo, watch the autopilot phase, dump any
 * frame-stuck windows and console errors. The user reports "demo tends
 * to freeze and sometimes the inputs drop when setting up the demo" —
 * this harness watches frame advance + autopilot indicator + sync-log
 * lines to localize the root cause.
 */
import { chromium } from 'playwright';

const ROM_PATH = '/Users/kazon/kaillera-next/.playwright-mcp/smash_remix.z64';

async function trace(url) {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  const stuckEvents = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() === 'error') errors.push(t.slice(0, 240));
    if (t.includes('TICK-STUCK') || t.includes('REPLAY-NORUN') || t.includes('FATAL'))
      stuckEvents.push(t.slice(0, 240));
  });
  console.log('→ navigate', url);
  await page.goto(url);
  await page.locator('#rom-file').setInputFiles(ROM_PATH);
  await page.waitForSelector('#gesture-button', { state: 'visible', timeout: 10_000 });
  console.log('→ click gesture');
  await page.evaluate(() => document.getElementById('gesture-button')?.click());

  // Sample every 250 ms. Track _frameNum advance, autopilot active flag,
  // is-in-match, current scene/status.
  const samples = [];
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    await new Promise((r) => setTimeout(r, 250));
    const snap = await page.evaluate(() => {
      const hud = window.NetplayRollback?.getHudCounters?.() || {};
      const isInMatch = window.NetplayRollback?.isInMatch?.() ?? false;
      const scene = window.NetplayRollback?.readSceneCurr?.() ?? -1;
      const gameStatus = window.NetplayRollback?.readGameStatus?.() ?? -1;
      const coproc = window.knWorkerCoprocStats?.() || {};
      const indicator = document.getElementById('input-indicator')?.textContent || '';
      return {
        frame: hud.currentFrame ?? -1,
        delay: hud.delay ?? 0,
        rollbacks: hud.rollbackEventsTotal ?? 0,
        fps: hud.fps ?? 0,
        isInMatch,
        scene,
        gameStatus,
        coprocPending: coproc.pending ? 1 : 0,
        coprocDispatched: coproc.dispatched ?? 0,
        coprocCompleted: coproc.completed ?? 0,
        coprocTimeouts: coproc.timeouts ?? 0,
        indicator,
      };
    });
    samples.push({ t: Date.now() - startedAt, ...snap });
    if (snap.isInMatch && samples.filter((s) => s.isInMatch).length > 8) break;
  }

  // Walk samples to detect frame-counter freezes (>500 ms with no advance).
  const freezeWindows = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (a.frame === b.frame && b.t - a.t >= 250) {
      // Extend the freeze window
      const lastWindow = freezeWindows[freezeWindows.length - 1];
      if (lastWindow && lastWindow.endIdx === i - 1) {
        lastWindow.endIdx = i;
        lastWindow.endT = b.t;
        lastWindow.durationMs = b.t - lastWindow.startT;
      } else {
        freezeWindows.push({
          startIdx: i - 1,
          endIdx: i,
          startT: a.t,
          endT: b.t,
          durationMs: b.t - a.t,
          frame: a.frame,
          scene: a.scene,
          gameStatus: a.gameStatus,
          isInMatch: a.isInMatch,
          indicator: a.indicator,
          coprocPending: a.coprocPending,
        });
      }
    }
  }
  const significant = freezeWindows.filter((w) => w.durationMs >= 500);

  console.log('\n────────── TRACE ──────────');
  console.log(`samples: ${samples.length}`);
  console.log(`first sample: t=${samples[0]?.t}ms frame=${samples[0]?.frame} scene=${samples[0]?.scene}`);
  console.log(
    `last sample:  t=${samples.at(-1)?.t}ms frame=${samples.at(-1)?.frame} scene=${samples.at(-1)?.scene} inMatch=${samples.at(-1)?.isInMatch}`,
  );
  const reachedMatch = samples.find((s) => s.isInMatch);
  console.log(`reached match: ${reachedMatch ? `t=${reachedMatch.t}ms frame=${reachedMatch.frame}` : 'NO'}`);
  console.log(`\nfreeze windows (>500ms): ${significant.length}`);
  for (const w of significant) {
    console.log(
      `  t=${w.startT}-${w.endT}ms (${w.durationMs}ms) frame=${w.frame} scene=${w.scene} status=${w.gameStatus} inMatch=${w.isInMatch} indicator="${w.indicator}" coprocPending=${w.coprocPending}`,
    );
  }
  console.log(`\nstuck events: ${stuckEvents.length}`);
  for (const e of stuckEvents.slice(0, 5)) console.log(`  ${e}`);
  console.log(`\npage errors: ${errors.length}`);
  for (const e of errors.slice(0, 5)) console.log(`  ${e}`);

  await browser.close();
  return { samples, significant, errors, stuckEvents, reachedMatch };
}

const URL = process.env.URL || 'https://localhost:27888/demo.html';
trace(URL).catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
