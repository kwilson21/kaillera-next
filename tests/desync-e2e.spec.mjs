/**
 * Forces a desync via in-tab RDRAM mutation in one of two browser tabs,
 * then verifies the full pipeline: detector flag → vision-client POST →
 * server coalesce → vision call (mocked) → SQLite row → admin endpoint
 * surfaces the row.
 *
 * Run: ANTHROPIC_API_KEY=test_only ADMIN_KEY=1234 just dev &
 *      node tests/desync-e2e.spec.mjs
 */
import { chromium } from 'playwright';

const PLAY_URL = 'https://localhost:27888/play.html?desync=b';
const ADMIN_URL = 'https://localhost:27888/admin/api/desync-events';
const ADMIN_KEY = process.env.ADMIN_KEY || '1234';

async function newCtx(browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('console', (msg) => console.log(`[${msg.type()}]`, msg.text()));
  return { ctx, page };
}

async function waitForInGame(page, timeoutMs = 60_000) {
  await page.waitForFunction(() => window.KNState && KNState.frameNum > 60, null, { timeout: timeoutMs });
}

(async () => {
  const browser = await chromium.launch();
  const host = await newCtx(browser);
  const guest = await newCtx(browser);

  await host.page.goto(`${PLAY_URL}&host=1`);
  await host.page.waitForFunction(() => window.KNState?.matchId);
  const matchId = await host.page.evaluate(() => KNState.matchId);
  const roomId = await host.page.evaluate(() => KNState.room);

  await guest.page.goto(`${PLAY_URL}&room=${roomId}`);
  await Promise.all([waitForInGame(host.page), waitForInGame(guest.page)]);

  await host.page.evaluate(() => {
    const ptr = Module._kn_get_rdram_ptr();
    Module.HEAPU8[ptr + 0xa4f23] ^= 0x10;
  });

  await new Promise((r) => setTimeout(r, 2000));

  const res = await fetch(`${ADMIN_URL}?match_id=${matchId}&key=${ADMIN_KEY}`, {
    headers: { Accept: 'application/json', 'X-Admin-Key': ADMIN_KEY },
  });
  const body = await res.json();
  const stockEvents = body.events.filter((e) => e.field === 'stocks' && e.slot === 0);
  if (stockEvents.length === 0) {
    console.error('FAIL: no stocks[0] events found. body =', body);
    process.exit(1);
  }
  console.log(`PASS: ${stockEvents.length} stocks[0] events`);
  await browser.close();
})();
