/**
 * Phase A2 validation harness — enables delta restore + parallel
 * full-restore hash compare. Plays a Smash Remix demo session and
 * asserts zero DELTA-RESTORE-MISMATCH events.
 *
 * Pass = delta restore is bit-equivalent to full restore for every
 * rollback that fired during the run.
 *
 * Usage:
 *   node tests/rb-delta-validate.mjs
 *   PLAY_MS=30000  duration of in-match validation (default 30s)
 */
import { chromium } from 'playwright';

const ROM_PATH = '/Users/kazon/kaillera-next/.playwright-mcp/smash_remix.z64';
const URL = process.env.URL || 'https://localhost:27888/demo.html?p1Random=1&autoCompare=0&knDiag=1';
const PLAY_MS = Number(process.env.PLAY_MS || 30_000);

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

  // Verify exports present
  const hasExports = await page.evaluate(() => {
    return {
      hasSetDeltaRestore: typeof window.knDiag?.setDeltaRestore === 'function',
      hasSetDeltaValidate: typeof window.knDiag?.setDeltaValidate === 'function',
    };
  });
  console.log('→ exports check:', hasExports);
  if (!hasExports.hasSetDeltaRestore) throw new Error('knDiag.setDeltaRestore missing');

  console.log('→ wait for in-match');
  await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 60_000) {
      if (window.NetplayRollback?.isInMatch?.()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('never reached match');
  });

  console.log('→ enable delta restore + validation');
  await page.evaluate(() => {
    window.knDiag.setDeltaPhase(1);
    window.knDiag.setDeltaValidate(1); // enable validation FIRST
    window.knDiag.setDeltaRestore(1); // then enable delta restore
  });

  // Verify flags actually took effect
  const flagsCheck = await page.evaluate(() => {
    const m = window.EJS_emulator?.gameManager?.Module;
    return {
      restore: m?._kn_get_delta_restore?.(),
      validate: m?._kn_get_delta_validate?.(),
      phase: m?._kn_get_delta_phase?.(),
    };
  });
  console.log('→ flags after enable:', flagsCheck);
  if (!flagsCheck.restore || !flagsCheck.validate) {
    throw new Error(`flags didn't stick: ${JSON.stringify(flagsCheck)}`);
  }

  console.log(`→ play for ${PLAY_MS}ms with delta+validate enabled`);
  await page.waitForTimeout(PLAY_MS);

  // Re-verify flags are still set (in case a match restart wiped them)
  const flagsCheck2 = await page.evaluate(() => {
    const m = window.EJS_emulator?.gameManager?.Module;
    return {
      restore: m?._kn_get_delta_restore?.(),
      validate: m?._kn_get_delta_validate?.(),
    };
  });
  console.log('→ flags after play window:', flagsCheck2);

  const stats = await page.evaluate(() => window.knDiag.deltaStats());
  const histogram = await page.evaluate(() => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._kn_get_delta_mismatch_histogram) return null;
    const ptr = mod._malloc(128);
    if (!ptr) return null;
    try {
      const n = mod._kn_get_delta_mismatch_histogram(ptr, 128);
      if (n <= 0) return null;
      const v = new Uint8Array(mod.HEAPU8.buffer, ptr, 128);
      return Array.from(v);
    } finally {
      mod._free?.(ptr);
    }
  });
  const lastMismatch = await page.evaluate(() => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._kn_get_delta_last_mismatch) return null;
    const ptr = mod._malloc(16);
    if (!ptr) return null;
    try {
      const n = mod._kn_get_delta_last_mismatch(ptr, 4);
      if (n <= 0) return null;
      const v = new Int32Array(mod.HEAPU8.buffer, ptr, 4);
      return { targetFrame: v[0], blockCount: v[1], firstBlock: v[2], lastBlock: v[3] };
    } finally {
      mod._free?.(ptr);
    }
  });

  console.log('\n========== A2 STATS ==========');
  console.log(JSON.stringify(stats, null, 2));
  console.log('===============================');
  console.log(`mismatchCount (DELTA-RESTORE-MISMATCH log lines): ${mismatchCount}`);
  console.log(`stats.restore.validationFailures: ${stats?.restore?.validationFailures}`);
  console.log(`delta restores: ${stats?.restore?.countDelta}, full restores: ${stats?.restore?.countFull}`);
  console.log(`avg blocks skipped per restore: ${stats?.restore?.avgSkippedPct}%`);
  if (histogram) {
    const blocksWithMismatches = histogram
      .map((count, idx) => ({ block: idx, count, addr: '0x' + (idx * 0x10000).toString(16).padStart(8, '0') }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count);
    console.log('\nMISMATCH HISTOGRAM (block-by-block):');
    blocksWithMismatches.forEach((x) => {
      console.log(
        `  block ${String(x.block).padStart(3)} (${x.addr}-${'0x' + (x.block * 0x10000 + 0xffff).toString(16).padStart(8, '0')}): ${x.count} mismatches`,
      );
    });
    console.log(`Total distinct blocks ever mismatched: ${blocksWithMismatches.length}`);
  }
  if (lastMismatch && lastMismatch.targetFrame >= 0) {
    console.log('\nLAST MISMATCH:', lastMismatch);
  }

  await browser.close();

  const failures = (stats?.restore?.validationFailures ?? 0) | mismatchCount;
  if (failures > 0) {
    console.error(`✗ FAILED: ${failures} validation mismatches`);
    process.exit(1);
  }
  if (!stats?.restore?.countDelta) {
    console.warn(
      '⚠ no delta restores happened — no rollbacks fired during the run. Try a longer PLAY_MS or enable rollback inducement.',
    );
    process.exit(2);
  }
  console.log('✓ PASS: delta restore = full restore for all rollbacks');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
