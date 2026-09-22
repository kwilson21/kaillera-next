/**
 * Worker-as-replay-coprocessor smoke test.
 * Loads the demo with ?p1Random=1&shadowFrameBlit=1&workerCoproc=1,
 * waits for in-match, plays for ~12 s at slider=100ms RTT, then
 * dumps:
 *   - HUD counters (rollback events, fps, depth)
 *   - rb-probe summary (visible freeze duration around recent rollbacks)
 *   - knWorkerCoprocStats (dispatched / completed / failed / avg roundtrip)
 *
 * Compares freeze duration against the static-burst-2 baseline
 * (~98 ms) and the in-session adaptive (~65 ms).
 */
import { chromium } from 'playwright';

const ROM_PATH = '/Users/kazon/kaillera-next/.playwright-mcp/smash_remix.z64';
const URL = 'https://localhost:27888/demo.html?p1Random=1&shadowFrameBlit=1&workerCoproc=1&rbProbe=1&tickProfile=1';

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [page-error] ${msg.text().slice(0, 200)}`);
  });

  console.log('→ navigate', URL);
  await page.goto(URL);
  await page.locator('#rom-file').setInputFiles(ROM_PATH);
  await page.waitForSelector('#gesture-button', { state: 'visible', timeout: 10_000 });
  await page.evaluate(() => document.getElementById('gesture-button')?.click());

  console.log('→ wait for shadow worker boot');
  const bootStatus = await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 30_000) {
      const stats = window.NetplayRollback?.getShadowStats?.();
      if (stats?.ready > 0) return { ready: true, bootMs: performance.now() - start };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ready: false };
  });
  console.log('  boot:', JSON.stringify(bootStatus));
  if (!bootStatus.ready) {
    console.error('FAILED: worker did not boot');
    await browser.close();
    process.exit(1);
  }

  console.log('→ wait for in-match');
  await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 60_000) {
      if (window.NetplayRollback?.isInMatch?.()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('never reached match');
  });

  console.log('→ set slider 100, reset buffers, play 12 s');
  await page.evaluate(() => {
    const slider = document.getElementById('lag');
    if (slider) {
      slider.value = '100';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (window.__knTickProfile) window.__knTickProfile.length = 0;
    if (window.__knRbProbe) window.__knRbProbe.length = 0;
  });
  await new Promise((r) => setTimeout(r, 12_000));

  const result = await page.evaluate(() => {
    const profile = window.knTickProfileSummary?.(720);
    const probe = window.__knRbProbe || [];
    const hud = window.NetplayRollback?.getHudCounters?.();
    const adaptive = window.knAdaptiveDebug?.();
    const coproc = window.knWorkerCoprocStats?.();
    const freezes = [];
    for (let i = 1; i < probe.length; i++) {
      if (probe[i].path === 'replay' && probe[i - 1].path !== 'replay') {
        const preHash = probe[i - 1].hash;
        const preT = probe[i - 1].t;
        let firstPaintT = -1;
        for (let j = i; j < probe.length; j++) {
          if (probe[j].hash !== preHash) {
            firstPaintT = probe[j].t;
            break;
          }
        }
        let postIdx = i;
        while (postIdx < probe.length && probe[postIdx].path === 'replay') postIdx++;
        if (firstPaintT > 0) {
          freezes.push({
            wallClockFreezeMs: +(firstPaintT - preT).toFixed(1),
            replayTicks: postIdx - i,
          });
        }
      }
    }
    const median = (arr) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      return +s[Math.floor(s.length / 2)].toFixed(1);
    };
    return {
      hud: {
        rollbacks: hud?.rollbackEventsTotal,
        avgDepth: hud?.avgRollbackDepth,
        maxDepth: hud?.maxDepth,
        fps: hud?.fps,
      },
      adaptive,
      coproc,
      freezeCount: freezes.length,
      freezeMedianMs: median(freezes.map((f) => f.wallClockFreezeMs)),
      freezeMaxMs: freezes.length ? Math.max(...freezes.map((f) => f.wallClockFreezeMs)) : null,
      replayTicksMedian: median(freezes.map((f) => f.replayTicks)),
      replayTickStats: profile?.replay?.total,
    };
  });

  console.log('\n────────── RESULT ──────────');
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
