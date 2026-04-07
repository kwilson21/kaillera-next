#!/usr/bin/env node
/**
 * Rollback RNG test: start a 2-player rollback game, navigate to CSS,
 * select Random characters, select Random stage, start match, compare
 * screenshots between host and guest.
 *
 * Usage: node tests/rollback-rng-test.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const ROM_PATH = '/Users/kazon/Downloads/Smash Remix 2.0.1.z64';
const BASE_URL = 'https://localhost:27888';
const ROOM = 'RNGAUTO' + (Date.now() % 10000);

// N64 button indices (RetroArch JOYPAD)
const BTN = { A: 0, B: 1, START: 3, DUP: 4, DDOWN: 5, DLEFT: 6, DRIGHT: 7, L: 10, R: 11, Z: 12 };

async function press(page, slot, btn, holdMs = 100) {
  await page.evaluate(
    ([s, b]) => {
      window.EJS_emulator?.gameManager?.Module?._simulate_input(s, b, 1);
    },
    [slot, btn],
  );
  await page.waitForTimeout(holdMs);
  await page.evaluate(
    ([s, b]) => {
      window.EJS_emulator?.gameManager?.Module?._simulate_input(s, b, 0);
    },
    [slot, btn],
  );
}

async function waitForFrame(page, minFrame, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = await page.evaluate(() => window.KNState?.frameNum || 0);
    if (frame >= minFrame) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error(`Timeout waiting for frame ${minFrame}`);
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });

  console.log(`Room: ${ROOM}`);

  // Host
  console.log('Starting host...');
  const host = await ctx.newPage();
  await host.goto(`${BASE_URL}/play.html?room=${ROOM}&host=1&name=Host&mode=rollback`, {
    waitUntil: 'domcontentloaded',
  });
  await host.waitForTimeout(2000);
  const [fc] = await Promise.all([host.waitForEvent('filechooser'), host.click('#rom-drop')]);
  await fc.setFiles(ROM_PATH);
  await host.waitForTimeout(2000);

  // Guest
  console.log('Starting guest...');
  const guest = await ctx.newPage();
  await guest.goto(`${BASE_URL}/play.html?room=${ROOM}&name=Guest`, { waitUntil: 'domcontentloaded' });
  await guest.waitForTimeout(1000);
  const [fc2] = await Promise.all([guest.waitForEvent('filechooser'), guest.click('#rom-drop')]);
  await fc2.setFiles(ROM_PATH);
  await guest.waitForTimeout(2000);

  // Start game
  console.log('Starting game...');
  await host.bringToFront();
  await host.waitForTimeout(500);
  await host.click('button:has-text("Start")');
  await host.waitForTimeout(2000);

  // Guest gesture
  await guest.bringToFront();
  await guest.waitForTimeout(500);
  const hasGesture = await guest
    .locator('#gesture-prompt')
    .isVisible()
    .catch(() => false);
  if (hasGesture) await guest.click('#gesture-prompt');

  // Wait for emulators to boot
  console.log('Waiting for boot...');
  await waitForFrame(host, 100);
  console.log('Game running!');

  // === MENU NAVIGATION ===
  // Title screen: press Start
  console.log('Title screen → Start');
  await press(host, 0, BTN.START);
  await host.waitForTimeout(2000);

  // Screenshot to see where we are
  await host.screenshot({ path: '/tmp/rng-step1-host.png' });

  // CSS: Move cursor to Random (far right in top row)
  // Default cursor starts on Mario. Move right many times to reach "?"
  console.log('CSS: Moving to Random...');
  for (let i = 0; i < 15; i++) {
    await press(host, 0, BTN.DRIGHT, 50);
    await host.waitForTimeout(150);
  }
  await host.waitForTimeout(500);
  await host.screenshot({ path: '/tmp/rng-step2-css-random.png' });

  // Press A to select Random character
  console.log('Selecting Random character...');
  await press(host, 0, BTN.A);
  await host.waitForTimeout(2000);
  await host.screenshot({ path: '/tmp/rng-step3-char-selected.png' });

  // Press Start to go to SSS
  console.log('Going to SSS...');
  await press(host, 0, BTN.START);
  await host.waitForTimeout(2000);
  await host.screenshot({ path: '/tmp/rng-step4-sss.png' });

  // Press Start again to confirm stage
  console.log('Confirming stage...');
  await press(host, 0, BTN.START);
  await host.waitForTimeout(5000);

  // Screenshot both in gameplay
  console.log('Taking gameplay screenshots...');
  await host.screenshot({ path: '/tmp/rng-step5-host-game.png' });
  await guest.screenshot({ path: '/tmp/rng-step5-guest-game.png' });

  // Wait a bit more and take another pair
  await host.waitForTimeout(3000);
  await host.screenshot({ path: '/tmp/rng-step6-host-game2.png' });
  await guest.screenshot({ path: '/tmp/rng-step6-guest-game2.png' });

  console.log('Screenshots saved to /tmp/rng-step*.png');
  console.log('Compare host vs guest to verify same characters and stage.');

  // Keep alive for manual inspection
  await host.waitForTimeout(5000);

  await ctx.close();
  await browser.close();
}

main().catch(console.error);
