/**
 * Per-step cost profiler. Runs the demo with several configurations
 * for the in-replay tick path and reports median/p95 replay tick
 * duration for each, so we can identify which (if any) per-step
 * cost knobs actually reduce the structural freeze.
 *
 * Configs (all share replayBurst=2, cap=7 in deployed WASM, spike=60):
 *   1. baseline             — defaults (audio mode=0, rdp-skip off)
 *   2. replayAudioMode=1    — RSP audio outright skipped during replay
 *                              (PROBE-ONLY, not deterministic in netplay)
 *   3. replayAudioMode=2    — snapshot+restore RSP audio during replay
 *                              (deterministic; preserves DRAM around alist call)
 *   4. replaySkipRdp=1      — GLideN64 raster short-circuited during replay
 *   5. replayAudioMode=1+replaySkipRdp=1 — both
 *
 * For each config, runs ~10 s in match, dumps replay-tick total
 * median/p95/max plus the visible freeze duration measured by
 * the rb-probe (gap from last fresh canvas paint pre-rollback to
 * first fresh paint post-rollback).
 */
import { chromium } from 'playwright';

const ROM_PATH = '/Users/kazon/Downloads/Smash Remix 2.0.1.z64';
const BASE = 'https://localhost:27888/demo.html?p1Random=1&rbProbe=1&tickProfile=1';
const CONFIGS = [
  { name: 'baseline', extra: '' },
  { name: 'audioMode=1 (skip RSP audio)', extra: '&replayAudioMode=1' },
  { name: 'audioMode=2 (RSP snapshot+restore)', extra: '&replayAudioMode=2' },
  { name: 'replaySkipRdp=1', extra: '&replaySkipRdp=1' },
  { name: 'audioMode=1+replaySkipRdp=1', extra: '&replayAudioMode=1&replaySkipRdp=1' },
];

async function runConfig(name, url) {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  // Suppress log noise except errors.
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [page-error] ${msg.text().slice(0, 120)}`);
  });

  await page.goto(url);
  // Direct setInputFiles on the hidden input — bypasses the OS file picker.
  await page.locator('#rom-file').setInputFiles(ROM_PATH);
  await page.waitForSelector('#gesture-button', { state: 'visible', timeout: 10_000 });
  await page.evaluate(() => document.getElementById('gesture-button')?.click());

  // Wait for in-match.
  await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 60_000) {
      if (window.NetplayRollback?.isInMatch?.()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('never reached match');
  });

  // Slider default; reset profile buffers.
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

  // Collect for ~12 s (≈ 720 ticks @ 60 Hz).
  await new Promise((r) => setTimeout(r, 12_000));

  const result = await page.evaluate(() => {
    const profile = window.knTickProfileSummary?.(720);
    const probe = window.__knRbProbe || [];
    // Find ALL rollback boundaries and compute visible-freeze durations
    // (gap between last fresh hash pre-rollback and first fresh hash post-replay).
    const freezes = [];
    for (let i = 1; i < probe.length; i++) {
      if (probe[i].path === 'replay' && probe[i - 1].path !== 'replay') {
        // Walk back: most recent hashChanged tick before this rollback.
        let preIdx = i - 1;
        let prePath = probe[preIdx];
        while (preIdx > 0 && probe[preIdx].hash === prePath.hash) preIdx--;
        const preT = probe[preIdx]?.t ?? probe[i - 1].t;
        // Walk forward: first hashChanged tick after replay ends.
        let postIdx = i;
        while (postIdx < probe.length && probe[postIdx].path === 'replay') postIdx++;
        const replayEndT = probe[postIdx - 1]?.t ?? probe[i].t;
        // Find first hash change after replay.
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
      replayBurstMs: profile?.replay?.burstMs,
      replayBurstSteps: profile?.replay?.burstSteps,
      normalTickTotal: profile?.normal?.total,
      overVsync: profile?.overVsyncCount ?? 0,
      rollbacks: freezes.length,
      freezeMedianMs: median(freezes.map((f) => f.wallClockFreezeMs)),
      freezeMaxMs: freezes.length ? Math.max(...freezes.map((f) => f.wallClockFreezeMs)) : null,
      replayWallClockMedianMs: median(freezes.map((f) => f.replayWallClockMs)),
      postReplayPaintGapMedianMs: median(freezes.map((f) => f.postReplayPaintGapMs)),
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
    console.log(`url: ${url}`);
    try {
      const r = await runConfig(cfg.name, url);
      results.push({ name: cfg.name, ...r });
      console.log('result:', JSON.stringify(r, null, 2));
    } catch (e) {
      console.log('  failed:', e.message);
      results.push({ name: cfg.name, error: e.message });
    }
  }

  console.log('\n\n========== SUMMARY ==========');
  console.log(
    'Config                                   | replay tick (ms)         | freeze (ms)            | rollbacks',
  );
  console.log(
    '-----------------------------------------+--------------------------+------------------------+----------',
  );
  for (const r of results) {
    if (r.error) {
      console.log(`${r.name.padEnd(40)} | ERROR: ${r.error}`);
      continue;
    }
    const tt = r.replayTickTotal;
    const tickStr = tt ? `med=${tt.median}, p95=${tt.p95}, max=${tt.max}` : '—';
    const fStr = r.freezeMedianMs != null ? `med=${r.freezeMedianMs}, max=${r.freezeMaxMs}` : '—';
    console.log(`${r.name.padEnd(40)} | ${tickStr.padEnd(24)} | ${fStr.padEnd(22)} | ${r.rollbacks}`);
  }
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
