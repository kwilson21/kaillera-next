/**
 * Phase A1 measurement run — captures dirty-block stats from a real
 * Smash Remix demo session and prints them at the end.
 *
 * Usage: node tests/rb-delta-stats.mjs
 *   PLAY_MS=20000  duration of in-match sampling (default 20s)
 *   MENU_MS=10000  duration of out-of-match sampling at boot (default 10s)
 */
import { chromium } from 'playwright';

const ROM_PATH = '/Users/kazon/kaillera-next/.playwright-mcp/smash_remix.z64';
const URL = process.env.URL || 'https://localhost:27888/demo.html?p1Random=1&autoCompare=0&knDiag=1';
const PLAY_MS = Number(process.env.PLAY_MS || 20_000);
const MENU_MS = Number(process.env.MENU_MS || 10_000);

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('knDiag.deltaStats') || t.includes('delta_phase')) {
      console.log(`  [page] ${t.slice(0, 400)}`);
    }
  });

  console.log('→ navigate', URL);
  await page.goto(URL);
  await page.locator('#rom-file').setInputFiles(ROM_PATH);
  await page.waitForSelector('#gesture-button', { state: 'visible', timeout: 10_000 });
  await page.evaluate(() => document.getElementById('gesture-button')?.click());

  console.log('→ wait for emulator running');
  await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 60_000) {
      const m = window.EJS_emulator?.gameManager?.Module;
      if (m?._kn_get_split_state_stats) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('emulator never became ready');
  });

  // Verify exports present
  const hasExports = await page.evaluate(() => {
    const m = window.EJS_emulator?.gameManager?.Module;
    return {
      setDeltaPhase: typeof m?._kn_set_delta_phase === 'function',
      getDeltaStats: typeof m?._kn_get_delta_stats === 'function',
      hasKnDiagSetDeltaPhase: typeof window.knDiag?.setDeltaPhase === 'function',
      hasKnDiagDeltaStats: typeof window.knDiag?.deltaStats === 'function',
    };
  });
  console.log('→ exports check:', hasExports);
  if (!hasExports.setDeltaPhase) throw new Error('WASM missing _kn_set_delta_phase');

  // Phase 1: out-of-match (boot/menu/loading)
  console.log(`→ phase=0 (out-of-match) for ${MENU_MS}ms`);
  await page.evaluate(() => window.knDiag.setDeltaPhase(0));
  await page.waitForTimeout(MENU_MS);

  // Phase 2: wait until in-match, then measure
  console.log('→ wait for in-match');
  await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 60_000) {
      if (window.NetplayRollback?.isInMatch?.()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('never reached match');
  });

  console.log(`→ phase=1 (in-match) for ${PLAY_MS}ms`);
  await page.evaluate(() => window.knDiag.setDeltaPhase(1));
  await page.waitForTimeout(PLAY_MS);

  // Read stats
  const stats = await page.evaluate(() => window.knDiag.deltaStats());
  await page.evaluate(() => window.knDiag.setDeltaPhase(0));

  console.log('\n========== DELTA STATS ==========');
  console.log(JSON.stringify(stats, null, 2));
  console.log('=================================\n');

  await browser.close();
  return stats;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
