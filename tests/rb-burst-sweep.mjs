/**
 * Sweeps replayBurst from 2 → 5 to find the optimal number of replay
 * frames per JS tick before vsync overruns become destructive.
 *
 * burst=N effective tick cost ≈ N × per-step (~4 ms with current
 * settings). Vsync is 16.67 ms. Above vsync the browser drops a
 * frame so the tick effectively dilates to 33 ms — at that point
 * higher burst doesn't help.
 *
 * Measures: replay tick total median/p95/max, vsync overruns,
 * visible freeze duration (gap between last fresh paint pre-rollback
 * and first fresh paint post-replay).
 */
import { chromium } from 'playwright';

const ROM_PATH = '/Users/kazon/Downloads/Smash Remix 2.0.1.z64';
const BASE = 'https://localhost:27888/demo.html?p1Random=1&rbProbe=1&tickProfile=1';
const CONFIGS = [
  { name: 'burst=2 (current default)', extra: '&replayBurst=2' },
  { name: 'burst=3', extra: '&replayBurst=3' },
  { name: 'burst=4', extra: '&replayBurst=4' },
  { name: 'burst=5', extra: '&replayBurst=5' },
  { name: 'burst=4 + audioMode=2', extra: '&replayBurst=4&replayAudioMode=2' },
];

async function runConfig(name, url) {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [page-error] ${msg.text().slice(0, 120)}`);
  });

  await page.goto(url);
  // Direct setInputFiles on the hidden input — bypasses the OS file picker.
  await page.locator('#rom-file').setInputFiles(ROM_PATH);
  await page.waitForSelector('#gesture-button', { state: 'visible', timeout: 10_000 });
  await page.evaluate(() => document.getElementById('gesture-button')?.click());

  await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 60_000) {
      if (window.NetplayRollback?.isInMatch?.()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('never reached match');
  });

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
    const freezes = [];
    const replayBurstSteps = [];
    for (let i = 1; i < probe.length; i++) {
      if (probe[i].path === 'replay' && probe[i - 1].path !== 'replay') {
        let preIdx = i - 1;
        while (preIdx > 0 && probe[preIdx].hash === probe[i - 1].hash) preIdx--;
        const preT = probe[preIdx]?.t ?? probe[i - 1].t;
        let postIdx = i;
        while (postIdx < probe.length && probe[postIdx].path === 'replay') postIdx++;
        const replayEndT = probe[postIdx - 1]?.t ?? probe[i].t;
        const replayEndHash = probe[postIdx - 1]?.hash;
        let firstPaintT = -1;
        for (let j = postIdx; j < probe.length; j++) {
          if (probe[j].hash !== replayEndHash) {
            firstPaintT = probe[j].t;
            break;
          }
        }
        if (firstPaintT > 0) {
          freezes.push({
            wallClockFreezeMs: +(firstPaintT - preT).toFixed(1),
            replayWallClockMs: +(replayEndT - probe[i].t).toFixed(1),
            replayTicks: postIdx - i,
            postReplayPaintGapMs: +(firstPaintT - replayEndT).toFixed(1),
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
      replayTickTotal: profile?.replay?.total,
      replayBurstStepsActual: profile?.replay?.burstSteps,
      normalTickP95: profile?.normal?.total?.p95,
      overVsync: profile?.overVsyncCount ?? 0,
      rollbacks: freezes.length,
      freezeMedianMs: median(freezes.map((f) => f.wallClockFreezeMs)),
      freezeMaxMs: freezes.length ? Math.max(...freezes.map((f) => f.wallClockFreezeMs)) : null,
      freezeP95Ms: (() => {
        if (!freezes.length) return null;
        const s = freezes.map((f) => f.wallClockFreezeMs).sort((a, b) => a - b);
        return +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(1);
      })(),
      replayWallClockMedianMs: median(freezes.map((f) => f.replayWallClockMs)),
      postReplayPaintGapMedianMs: median(freezes.map((f) => f.postReplayPaintGapMs)),
      replayTicksMedian: median(freezes.map((f) => f.replayTicks)),
    };
  });

  await browser.close();
  return result;
}

async function main() {
  const results = [];
  for (const cfg of CONFIGS) {
    const url = BASE + cfg.extra;
    console.log(`\n=== ${cfg.name} ===`);
    try {
      const r = await runConfig(cfg.name, url);
      results.push({ name: cfg.name, ...r });
      console.log('  result:', JSON.stringify(r, null, 0));
    } catch (e) {
      console.log('  failed:', e.message);
      results.push({ name: cfg.name, error: e.message });
    }
  }

  console.log('\n========== SUMMARY ==========');
  console.log(
    'Config                              | replay tick (med/p95/max) | overVsync | freeze (med/p95/max ms) | replayTicks',
  );
  console.log(
    '------------------------------------+---------------------------+-----------+-------------------------+------------',
  );
  for (const r of results) {
    if (r.error) {
      console.log(`${r.name.padEnd(35)} | ERROR: ${r.error}`);
      continue;
    }
    const tt = r.replayTickTotal;
    const tickStr = tt ? `${tt.median}/${tt.p95}/${tt.max}` : '—';
    const fStr = r.freezeMedianMs != null ? `${r.freezeMedianMs}/${r.freezeP95Ms}/${r.freezeMaxMs}` : '—';
    console.log(
      `${r.name.padEnd(35)} | ${tickStr.padEnd(25)} | ${String(r.overVsync).padEnd(9)} | ${fStr.padEnd(23)} | ${r.replayTicksMedian}`,
    );
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
