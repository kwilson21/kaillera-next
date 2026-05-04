/**
 * Test the adaptive replayBurst sizer. Compares:
 *   1. Old static burst=2 (URL param override)
 *   2. New adaptive default (no override) — should pick burst=3 if
 *      step cost ~4 ms, possibly 4 if cost is lower.
 *
 * Both run for 12 s in match at slider=100 ms RTT and report freeze
 * duration distribution + actual burst step counts achieved.
 */
import { chromium } from 'playwright';

const ROM_PATH = '/Users/kazon/Downloads/Smash Remix 2.0.1.z64';
const BASE = 'https://localhost:27888/demo.html?p1Random=1&rbProbe=1&tickProfile=1';
const CONFIGS = [
  { name: 'static burst=2 (old default)', extra: '&replayBurst=2' },
  { name: 'adaptive (new default)', extra: '' }, // no replayBurst → adaptive
  { name: 'static burst=3', extra: '&replayBurst=3' },
  { name: 'static burst=4', extra: '&replayBurst=4' },
];

async function runConfig(name, url) {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [page-error] ${msg.text().slice(0, 120)}`);
  });

  await page.goto(url);
  // Direct setInputFiles on the hidden input — bypasses the OS file
  // picker that .click() would open.
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
    for (let i = 1; i < probe.length; i++) {
      if (probe[i].path === 'replay' && probe[i - 1].path !== 'replay') {
        // Last fresh paint before rollback: probe[i-1].hash IS that
        // fresh paint (it changed from the prior tick's hash). So preT
        // is probe[i-1].t directly.
        const preHash = probe[i - 1].hash;
        const preT = probe[i - 1].t;
        // Find ANY subsequent tick whose hash differs from preHash —
        // catches both the paint-last-replay-frame (last replay tick's
        // hash != preHash) and the standard post-replay forward paint.
        let firstPaintT = -1;
        let firstPaintIdx = -1;
        for (let j = i; j < probe.length; j++) {
          if (probe[j].hash !== preHash) {
            firstPaintT = probe[j].t;
            firstPaintIdx = j;
            break;
          }
        }
        // Replay window bounds: track post-replay separately for diag.
        let postIdx = i;
        while (postIdx < probe.length && probe[postIdx].path === 'replay') postIdx++;
        const replayEndT = probe[postIdx - 1]?.t ?? probe[i].t;
        if (firstPaintT > 0) {
          freezes.push({
            wallClockFreezeMs: +(firstPaintT - preT).toFixed(1),
            firstPaintIsReplayTick: firstPaintIdx < postIdx, // paint-last-replay-frame fired
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
      adaptive: window.knAdaptiveDebug?.() ?? null,
      replayTickTotal: profile?.replay?.total,
      replayBurstSteps: profile?.replay?.burstSteps,
      normalTickP95: profile?.normal?.total?.p95,
      overVsync: profile?.overVsyncCount ?? 0,
      rollbacks: freezes.length,
      freezeMedianMs: median(freezes.map((f) => f.wallClockFreezeMs)),
      freezeMaxMs: freezes.length ? Math.max(...freezes.map((f) => f.wallClockFreezeMs)) : null,
      replayWallClockMedianMs: median(freezes.map((f) => f.replayWallClockMs)),
      postReplayPaintGapMedianMs: median(freezes.map((f) => f.postReplayPaintGapMs)),
      replayTicksMedian: median(freezes.map((f) => f.replayTicks)),
      lastFramePaintWorked: freezes.filter((f) => f.firstPaintIsReplayTick).length,
      lastFramePaintTotal: freezes.length,
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
    'Config                          | tick (med/p95/max ms)    | actual burst steps   | overVsync | freeze (med/max ms)   | replayTicks',
  );
  console.log(
    '--------------------------------+--------------------------+----------------------+-----------+-----------------------+------------',
  );
  for (const r of results) {
    if (r.error) {
      console.log(`${r.name.padEnd(32)} | ERROR: ${r.error}`);
      continue;
    }
    const tt = r.replayTickTotal;
    const tickStr = tt ? `${tt.median}/${tt.p95}/${tt.max}` : '—';
    const bs = r.replayBurstSteps;
    const bsStr = bs ? `med=${bs.median}, max=${bs.max}` : '—';
    const fStr = r.freezeMedianMs != null ? `${r.freezeMedianMs}/${r.freezeMaxMs}` : '—';
    console.log(
      `${r.name.padEnd(32)} | ${tickStr.padEnd(24)} | ${bsStr.padEnd(20)} | ${String(r.overVsync).padEnd(9)} | ${fStr.padEnd(21)} | ${r.replayTicksMedian}`,
    );
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
