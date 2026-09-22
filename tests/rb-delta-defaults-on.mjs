/**
 * Phase A2 — verify defaults-ON build is correct.
 *
 * Same as rb-delta-validate.mjs but does NOT enable any toggles via JS.
 * Just navigates to demo + plays. Defaults should auto-enable delta
 * restore + validation. Asserts 0 validationFailures.
 */
import { chromium } from 'playwright';

const ROM_PATH = '/Users/kazon/kaillera-next/.playwright-mcp/smash_remix.z64';
const URL = process.env.URL || 'https://localhost:27888/demo.html?p1Random=1&autoCompare=0&knDiag=1';
const PLAY_MS = Number(process.env.PLAY_MS || 60_000);

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();

  let mismatchCount = 0;
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('DELTA-RESTORE-MISMATCH')) {
      mismatchCount++;
      console.log(`  [page MISMATCH] ${t.slice(0, 400)}`);
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

  // Verify defaults ARE on without any JS toggling
  const flagsCheck = await page.evaluate(() => {
    const m = window.EJS_emulator?.gameManager?.Module;
    return {
      restore: m?._kn_get_delta_restore?.(),
      validate: m?._kn_get_delta_validate?.(),
    };
  });
  console.log('→ default flags:', flagsCheck);
  if (!flagsCheck.restore || !flagsCheck.validate) {
    throw new Error(`defaults not on: ${JSON.stringify(flagsCheck)}`);
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
  await page.evaluate(() => window.knDiag.setDeltaPhase(1));

  console.log(`→ play for ${PLAY_MS}ms (defaults already ON)`);
  await page.waitForTimeout(PLAY_MS);

  const stats = await page.evaluate(() => window.knDiag.deltaStats());
  console.log('\n========== DEFAULTS-ON STATS ==========');
  console.log(JSON.stringify(stats, null, 2));
  console.log('========================================');
  console.log(`mismatchCount: ${mismatchCount}`);
  console.log(`validationFailures: ${stats?.restore?.validationFailures}`);
  console.log(`delta restores: ${stats?.restore?.countDelta}, full: ${stats?.restore?.countFull}`);
  console.log(`avg blocks skipped: ${stats?.restore?.avgSkippedPct}%`);

  await browser.close();

  const failures = (stats?.restore?.validationFailures ?? 0) | mismatchCount;
  if (failures > 0) {
    console.error(`✗ FAILED: ${failures} validation mismatches`);
    process.exit(1);
  }
  console.log('✓ PASS: defaults-on build is bit-correct');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
