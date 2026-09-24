/**
 * Loads the demo with ?p1Random=1&rbProbe=1, drives the autopilot
 * past menu into a match, lets rollbacks fire for ~12 s at the slider
 * default (100 ms RTT), then dumps the result of window.knProbeRollback()
 * for root-cause analysis of the perceived rollback "pause/jump."
 *
 * Run: node tests/rb-probe.mjs
 *      (will lazy-install playwright if missing)
 */
import { chromium } from 'playwright';

const URL = 'https://localhost:27888/demo.html?p1Random=1&rbProbe=1&tickProfile=1';
const ROM_PATH = '/Users/kazon/Downloads/Smash Remix 2.0.1.z64';

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    const t = msg.type();
    if (t === 'error' || t === 'warning') console.log(`[${t}]`, msg.text().slice(0, 200));
  });

  console.log('→ navigate', URL);
  await page.goto(URL);

  console.log('→ upload ROM');
  await page.evaluate(() => document.getElementById('rom-file')?.click());
  // Brief wait for the file chooser; then attach via setInputFiles.
  await page
    .locator('#rom-file')
    .setInputFiles(ROM_PATH)
    .catch(async () => {
      // fallback: chooser already attached
      await new Promise((r) => setTimeout(r, 500));
    });

  console.log('→ click gesture button');
  await page.waitForSelector('#gesture-button', { state: 'visible', timeout: 10_000 });
  await page.evaluate(() => document.getElementById('gesture-button')?.click());

  console.log('→ wait for autopilot to deliver into a match (~25 s)');
  const inMatchAt = await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 60_000) {
      if (window.NetplayRollback?.isInMatch?.()) return performance.now() - start;
      await new Promise((r) => setTimeout(r, 250));
    }
    return -1;
  });
  console.log(`  in-match after ${inMatchAt.toFixed(0)} ms`);

  if (inMatchAt < 0) {
    console.error('FAILED: never reached match');
    await browser.close();
    process.exit(1);
  }

  console.log('→ run for 12 s at slider default to collect rollback samples');
  await page.evaluate(() => {
    const slider = document.getElementById('lag');
    if (slider) {
      slider.value = '100';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (window.__knRbProbe) window.__knRbProbe.length = 0;
    if (window.__knTickProfile) window.__knTickProfile.length = 0;
  });
  await new Promise((r) => setTimeout(r, 12_000));

  console.log('→ dump probe output');
  const dump = await page.evaluate(() => {
    const probe = window.knProbeRollback?.(60, 60);
    const profile = window.knTickProfileSummary?.(720);
    const hud = window.NetplayRollback?.getHudCounters?.();
    const rbBufLen = window.__knRbProbe?.length ?? 0;
    return { hud, probe, profile, rbBufLen };
  });

  console.log('────────── HUD ──────────');
  console.log(JSON.stringify(dump.hud, null, 2));
  console.log('────────── tickProfile summary ──────────');
  console.log(JSON.stringify(dump.profile, null, 2));
  console.log('────────── rb-probe summary (most recent rollback) ──────────');
  console.log(`probe buffer size: ${dump.rbBufLen}`);
  if (dump.probe) {
    console.log('rollbackBoundary:', JSON.stringify(dump.probe.rollbackBoundary, null, 2));
    console.log('replayWindow:    ', JSON.stringify(dump.probe.replayWindow, null, 2));
    console.log('postReplay:      ', JSON.stringify(dump.probe.postReplay, null, 2));
    console.log('────────── timeline (sample of ±60 ticks around boundary) ──────────');
    const cols = ['relTick', 't', 'jsF', 'rbF', 'rep', 'path', 'hash', 'dt', 'd_jsF', 'd_rbF', 'hashChanged'];
    console.log(cols.join('\t'));
    for (const r of dump.probe.timeline ?? []) {
      console.log(
        cols
          .map((c) => {
            const v = r[c];
            if (typeof v === 'number') return c === 'hash' || c === 't' ? v.toString() : v.toFixed(c === 'dt' ? 1 : 0);
            return v;
          })
          .join('\t'),
      );
    }
  } else {
    console.log('no rollback found');
  }

  await browser.close();
}

main().catch((e) => {
  console.error('error:', e);
  process.exit(1);
});
