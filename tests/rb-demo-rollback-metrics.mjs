/**
 * Rollback cost metrics for the static demo — for comparing engine or core
 * changes on the same ROM. Boots the demo, lets the menu autopilot reach a
 * match, holds rollback ON (no auto-compare), then after N seconds reports:
 *   - rollbacks, average/max depth, failed (skipped) rollbacks
 *   - share of ticks spent replaying (the picture holds on those)
 *   - integrity events (R2-R5 in docs/netplay-invariants.md) from the
 *     console and the C engine log — these must stay at zero
 *
 *   KN_ROM=/path/rom.z64 [KN_BASE_URL=http://localhost:8787] [KN_SECONDS=45] \
 *     node tests/rb-demo-rollback-metrics.mjs
 *
 * Serve the demo first (`just demo-dev`). Headless without a GPU the game
 * runs well below 60 fps, so compare ratios between runs, not absolute
 * timings; on a real machine the tick timings are meaningful too.
 */
import { chromium } from 'playwright';

const ROM = process.env.KN_ROM;
const BASE = process.env.KN_BASE_URL || 'http://localhost:8787';
const SECONDS = Number(process.env.KN_SECONDS || 45);
const EXTRA = process.env.KN_QUERY || '';
const INTEGRITY = /REPLAY-NORUN|RB-INVARIANT-VIOLATION|FATAL-RING-STALE|RB-LIVE-MISMATCH|RESTORE-FAILED/;

if (!ROM) {
  console.error('set KN_ROM to a ROM path');
  process.exit(2);
}

const launchOpts = process.env.CHROMIUM_PATH
  ? {
      executablePath: process.env.CHROMIUM_PATH,
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
    }
  : { args: ['--autoplay-policy=no-user-gesture-required'] };
const browser = await chromium.launch(launchOpts);
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const consoleIntegrity = [];
page.on('console', (m) => {
  if (INTEGRITY.test(m.text())) consoleIntegrity.push(m.text().slice(0, 300));
});

await page.goto(`${BASE}/?tickProfile=1&autoCompare=0${EXTRA}`);
await page.locator('#rom-file').setInputFiles(ROM);
await page.waitForSelector('#gesture-button', { state: 'visible', timeout: 60_000 });
await page.evaluate(() => document.getElementById('gesture-button').click());
await page.waitForFunction(() => window.NetplayRollback?.isInMatch?.(), null, { timeout: 400_000, polling: 500 });
const before = await page.evaluate(() => window.NetplayRollback.getHudCounters());
await page.waitForTimeout(SECONDS * 1000);

const r = await page.evaluate(() => {
  const m = window.EJS_emulator.gameManager.Module;
  const ptr = m._kn_get_debug_log?.();
  return {
    hud: window.NetplayRollback.getHudCounters(),
    profile: window.knTickProfileSummary(100_000),
    cLog: ptr ? m.UTF8ToString(ptr) : '',
  };
});
await browser.close();

const cIntegrity = r.cLog.split('\n').filter((l) => INTEGRITY.test(l));
const depths = r.cLog
  .split('\n')
  .map((l) => /C-REPLAY-START .*depth=(\d+)/.exec(l)?.[1])
  .filter(Boolean)
  .map(Number);
const dist = r.profile.pathDist || {};
const ticks = (dist.normal || 0) + (dist.replay || 0) + (dist.pacing || 0);
const out = {
  matchFrames: r.hud.currentFrame - before.currentFrame,
  rollbacks: r.hud.rollbackEventsTotal - before.rollbackEventsTotal,
  avgDepth: +(r.hud.avgRollbackDepth ?? 0).toFixed(2),
  maxDepth: r.hud.maxDepth,
  replayStartDepthsInLog: depths.length
    ? { n: depths.length, avg: +(depths.reduce((a, b) => a + b, 0) / depths.length).toFixed(2) }
    : null,
  failedRollbacks: r.hud.failedRollbacks - (before.failedRollbacks || 0),
  replayTickShare: ticks ? +((dist.replay / ticks) * 100).toFixed(1) : null,
  gameFps: r.profile.gameFps ?? null,
  normalTickMedianMs: r.profile.normal?.total?.median ?? null,
  replayTickMedianMs: r.profile.replay?.total?.median ?? null,
  integrityEvents: { console: consoleIntegrity.length, cLog: cIntegrity.length },
};
console.log(JSON.stringify(out, null, 2));
for (const l of [...consoleIntegrity, ...cIntegrity].slice(0, 10)) console.log('  ', l);
process.exit(out.integrityEvents.console + out.integrityEvents.cLog > 0 ? 1 : 0);
