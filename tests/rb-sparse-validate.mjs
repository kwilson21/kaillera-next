/**
 * Phase A3 — validate sparse-save mode.
 *
 * Enables delta_save_sparse + validate, plays demo, asserts 0
 * validation mismatches. Confirms slot[idx] sparse storage +
 * chain-walk restore are bit-equivalent to full-snapshot mode.
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
    if (t.includes('DELTA-RESTORE-MISMATCH') || t.includes('  block=') || t.includes('    slot[')) {
      if (t.includes('DELTA-RESTORE-MISMATCH')) mismatchCount++;
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
      if (m?._kn_set_delta_save_sparse) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('emulator never became ready (or sparse export missing)');
  });

  console.log('→ wait for in-match');
  await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 60_000) {
      if (window.NetplayRollback?.isInMatch?.()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('never reached match');
  });

  console.log('→ enable sparse + validate (restore already on by default)');
  await page.evaluate(() => {
    window.knDiag.setDeltaPhase(1);
    window.knDiag.setDeltaValidate(1);
    window.knDiag.setDeltaSaveSparse(1);
  });

  // Verify all flags stuck
  const flagsCheck = await page.evaluate(() => {
    const m = window.EJS_emulator?.gameManager?.Module;
    return {
      restore: m?._kn_get_delta_restore?.(),
      validate: m?._kn_get_delta_validate?.(),
      sparse: m?._kn_get_delta_save_sparse?.(),
    };
  });
  console.log('→ flags:', flagsCheck);
  if (!flagsCheck.sparse || !flagsCheck.validate) {
    throw new Error(`flags didn't stick: ${JSON.stringify(flagsCheck)}`);
  }

  console.log(`→ play for ${PLAY_MS}ms with sparse + validate ON`);
  await page.waitForTimeout(PLAY_MS);

  const stats = await page.evaluate(() => window.knDiag.deltaStats());
  /* Pull the C-side debug log to see DELTA-RESTORE-MISMATCH details. */
  const debugLog = await page.evaluate(() => {
    const m = window.EJS_emulator?.gameManager?.Module;
    if (!m?._kn_get_debug_log || !m.HEAPU8) return null;
    const ptr = m._kn_get_debug_log();
    if (!ptr) return null;
    /* Manual UTF-8 string read from HEAPU8 — UTF8ToString not always exposed. */
    let end = ptr;
    while (end < ptr + 8 * 1024 * 1024 && m.HEAPU8[end] !== 0) end++;
    const bytes = m.HEAPU8.subarray(ptr, end);
    return new TextDecoder('utf-8').decode(bytes);
  });
  if (debugLog) {
    console.log(`debug log length: ${debugLog.length}`);
    const lines = debugLog
      .split('\n')
      .filter((l) => l.includes('DELTA-RESTORE-MISMATCH') || l.includes('block=') || l.includes('slot['));
    if (lines.length) {
      console.log('\n--- C-side mismatch trace ---');
      lines.slice(-100).forEach((l) => console.log(l));
      console.log('--- end trace ---');
    } else {
      console.log('NO mismatch trace in debug log (might be ring-buffered out)');
      console.log('Sample of debug log tail:');
      console.log(debugLog.slice(-2000));
    }
  }
  const histogram = await page.evaluate(() => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._kn_get_delta_mismatch_histogram) return null;
    const ptr = mod._malloc(128);
    if (!ptr) return null;
    try {
      const n = mod._kn_get_delta_mismatch_histogram(ptr, 128);
      if (n <= 0) return null;
      return Array.from(new Uint8Array(mod.HEAPU8.buffer, ptr, 128));
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
  console.log('\n========== SPARSE-MODE STATS ==========');
  console.log(JSON.stringify(stats, null, 2));
  console.log('========================================');
  if (histogram) {
    const bad = histogram
      .map((c, i) => ({ block: i, count: c, addr: '0x' + (i * 0x10000).toString(16).padStart(8, '0') }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count);
    console.log('\nMISMATCH HISTOGRAM:');
    bad.forEach((x) => console.log(`  block ${String(x.block).padStart(3)} (${x.addr}): ${x.count} mismatches`));
  }
  if (lastMismatch && lastMismatch.targetFrame >= 0) {
    console.log('LAST MISMATCH:', lastMismatch);
  }
  console.log(`mismatchCount: ${mismatchCount}`);
  console.log(`validationFailures: ${stats?.restore?.validationFailures}`);
  console.log(`delta restores: ${stats?.restore?.countDelta}, full: ${stats?.restore?.countFull}`);
  console.log(`avg blocks skipped per restore: ${stats?.restore?.avgSkippedPct}%`);

  await browser.close();

  const failures = (stats?.restore?.validationFailures ?? 0) | mismatchCount;
  if (failures > 0) {
    console.error(`✗ FAILED: ${failures} validation mismatches`);
    process.exit(1);
  }
  if (!stats?.restore?.countDelta) {
    console.warn('⚠ no delta restores happened — bump PLAY_MS');
    process.exit(2);
  }
  console.log('✓ PASS: sparse save + chain-walk restore = bit-correct');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
