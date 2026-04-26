#!/usr/bin/env node
/**
 * Input recorder — 2-peer version (matches determinism test topology).
 *
 * Opens TWO chromium browsers (host + guest) connected via real lockstep
 * netplay. You navigate manually. Every key you press is captured with:
 *   - which window (host/guest)
 *   - emulator frame number
 *   - wall-clock timestamp
 *
 * Press F10 in EITHER window when you're at a safe random-input starting
 * point (match underway, chars + stage chosen). Recording saves to
 * /tmp/nav-recording.json.
 *
 * Usage:  node tests/record-nav.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ROM_PATH = '/Users/kazon/Downloads/Smash Remix 2.0.1.z64';
const BASE_URL = 'https://localhost:27888';
const ROOM = 'REC' + (Date.now() % 10000);
// Persistent location (survives /tmp wipes). Stored in-tree under tests/fixtures/.
const RECORDING_FILE = join(__dirname, 'fixtures', 'nav-recording.json');

async function setupPeer(browser, urlSuffix, label) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('pageerror', () => {}); // silent
  await page.goto(`${BASE_URL}/play.html?${urlSuffix}&name=${label}&mode=rollback&knperf=light`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(1500);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#rom-drop')]);
  await fc.setFiles(ROM_PATH);
  await page.waitForTimeout(2000);
  return { ctx, page, label };
}

async function installRecorder(page, label, sharedState) {
  await page.exposeFunction('_recordKey', (ev) => {
    sharedState.events.push({ ...ev, window: label });
    if (ev.key === 'F10' && ev.type === 'down') {
      sharedState.done = true;
      console.log(`[RECORDER] F10 pressed in ${label} — stopping`);
    }
  });
  await page.evaluate(() => {
    const onKey = (type) => (e) => {
      window._recordKey({
        type,
        key: e.key,
        code: e.code,
        frame: window.KNState?.frameNum || 0,
        ts: Date.now(),
      });
      if (e.key === 'F10') e.preventDefault();
    };
    document.addEventListener('keydown', onKey('down'), true);
    document.addEventListener('keyup', onKey('up'), true);
  });
}

async function main() {
  const startTs = Date.now();
  console.log(`Room: ${ROOM}`);
  console.log(`Launching host (chromium)...`);
  const hostBrowser = await chromium.launch({ headless: false });
  const host = await setupPeer(hostBrowser, `room=${ROOM}&host=1`, 'host');

  console.log(`Launching guest (chromium) — 2-peer lockstep like real play...`);
  const guestBrowser = await chromium.launch({ headless: false });
  const guest = await setupPeer(guestBrowser, `room=${ROOM}`, 'guest');

  await host.page.waitForTimeout(2500);

  // Set lockstep mode + Start Game
  console.log('Setting lockstep + Start Game...');
  await host.page.bringToFront();
  await host.page
    .locator('select')
    .first()
    .selectOption('lockstep')
    .catch(() => {});
  await host.page.waitForTimeout(500);
  await host.page.locator('button:has-text("Start Game")').first().click();
  await host.page.waitForTimeout(2500);

  // Auto-click Tap-to-start on both
  for (const page of [host.page, guest.page]) {
    try {
      await page.bringToFront();
      await page.locator('text=/Tap to start/i').first().click({ timeout: 5000 });
    } catch {
      await page.click('body', { position: { x: 640, y: 360 } }).catch(() => {});
    }
    await page.waitForTimeout(800);
  }

  const shared = { events: [], done: false };
  await installRecorder(host.page, 'host', shared);
  await installRecorder(guest.page, 'guest', shared);

  console.log(`
==========================================================
  RECORDING ACTIVE — both windows are live and lockstep'd.

  Navigate into a VS match:
    • Click into the HOST window to drive the game
    • When on CSS, click into the GUEST window + press A
      to pick P2 character
    • Click back into HOST for START → stage select → A

  Press F10 in either window when you're at a good random-
  input starting point (match begins, all picks done).
==========================================================
`);

  // Poll for completion (no intermediate screenshots — those caused window flashing)
  while (!shared.done) {
    await new Promise((r) => setTimeout(r, 500));
  }

  // Final state capture
  const finalFrameHost = await host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
  const finalFrameGuest = await guest.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
  await host.page.screenshot({ path: '/tmp/nav-final-host.png' }).catch(() => {});
  await guest.page.screenshot({ path: '/tmp/nav-final-guest.png' }).catch(() => {});

  const events = shared.events
    .filter((e) => e.key !== 'F10')
    .map((e) => ({
      type: e.type,
      key: e.key,
      code: e.code,
      frame: e.frame,
      window: e.window,
      dt_ms: e.ts - startTs,
    }));

  writeFileSync(
    RECORDING_FILE,
    JSON.stringify(
      {
        room: ROOM,
        rom: ROM_PATH,
        final_frame_host: finalFrameHost,
        final_frame_guest: finalFrameGuest,
        duration_ms: Date.now() - startTs,
        event_count: events.length,
        events,
      },
      null,
      2,
    ),
  );

  console.log(`
==========================================================
  Recorded ${events.length} key events over ${((Date.now() - startTs) / 1000).toFixed(1)}s
  Final frames: host=${finalFrameHost} guest=${finalFrameGuest}
  Saved to:     ${RECORDING_FILE}
  Final shots:  /tmp/nav-final-host.png / /tmp/nav-final-guest.png
==========================================================
`);

  await host.page.waitForTimeout(1500);
  await hostBrowser.close();
  await guestBrowser.close();
}

main().catch((err) => {
  console.error('RECORDER ERROR:', err);
  process.exit(1);
});
