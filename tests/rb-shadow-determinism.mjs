/**
 * Determinism check for the worker-as-replay-coprocessor experiment.
 * Boots the demo with ?shadowEmu=1, plays through the autopilot into
 * a match, lets ~10 s of gameplay accumulate, then calls the new
 * window.knShadowHashCheck() helper periodically to compare the
 * worker's hashes against main's at matching frames.
 *
 * Three outcomes:
 *   gp matches, game matches, full matches  → bit-exact, ideal
 *   gp matches, game matches, full differs  → tainted regions only,
 *                                              coprocessor VIABLE via
 *                                              selective adoption
 *   gp differs                               → game state diverged,
 *                                              coprocessor NOT viable
 */
import { chromium } from 'playwright';

const ROM_PATH = '/Users/kazon/kaillera-next/.playwright-mcp/smash_remix.z64';
const URL = 'https://localhost:27888/demo.html?p1Random=1&shadowFrameBlit=1';

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

  console.log('→ wait for shadow worker to boot');
  const bootStatus = await page.evaluate(async () => {
    const start = performance.now();
    while (performance.now() - start < 30_000) {
      const stats = window.NetplayRollback?.getShadowStats?.();
      if (stats?.ready > 0) return { ready: true, bootMs: performance.now() - start, stats };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ready: false, stats: window.NetplayRollback?.getShadowStats?.() };
  });
  console.log('  shadow boot:', JSON.stringify(bootStatus, null, 0).slice(0, 200));

  if (!bootStatus.ready) {
    console.error(
      'FAILED: shadow worker never booted. shadowEmu=1 may need shadowFrameBlit or shadowMotionOracle to actually start the boot path.',
    );
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

  console.log('→ play 8 s, then sample worker/main hash matches every 1 s for 6 samples');
  await page.evaluate(() => {
    const slider = document.getElementById('lag');
    if (slider) {
      slider.value = '100';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await new Promise((r) => setTimeout(r, 8_000));

  // Recheck stats after playtime — see if worker is actually being driven.
  const postPlayStats = await page.evaluate(() => window.NetplayRollback?.getShadowStats?.());
  console.log('  shadow stats after 8s playtime:', JSON.stringify(postPlayStats, null, 0).slice(0, 400));

  for (let i = 0; i < 6; i++) {
    const sample = await page.evaluate(async () => {
      return await window.knShadowHashCheck?.();
    });
    console.log(`sample ${i + 1}:`, JSON.stringify(sample, null, 0));
    await new Promise((r) => setTimeout(r, 1_000));
  }

  await browser.close();
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
