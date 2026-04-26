#!/usr/bin/env node
/**
 * Automated nav recording — scripted navigation through menus to VS gameplay.
 * All keyboard events are captured with frame-exact timing for use with
 * determinism-automation.mjs --replay. By default this records navigation
 * only; pass --include-random to also append a short gameplay input stream.
 *
 * Usage:  node tests/record-nav-auto.mjs
 * Output: tests/fixtures/nav-recording.json
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROM_PATH = '/Users/kazon/Downloads/Smash Remix 2.0.1.z64';
const BASE_URL = 'https://localhost:27888';
const ROOM = 'REC' + (Date.now() % 10000);
const RECORDING_FILE = join(__dirname, 'fixtures', 'nav-recording.json');
const RECORD_RANDOM_AFTER_MATCH = process.argv.includes('--include-random');
const GAMEPLAY_DURATION_MS = RECORD_RANDOM_AFTER_MATCH ? 60_000 : 0;
const RANDOM_INTERVAL_MS = 200;
const SCENE_TITLE = 1; // nSCKindTitle
const SCENE_MODE_SELECT = 7; // nSCKindModeSelect
const SCENE_VS_MODE = 9; // nSCKindVSMode
const SCENE_VS_OPTIONS = 10; // nSCKindVSOptions
const SCENE_PLAYERS_VS = 16; // nSCKindPlayersVS
const SCENE_MAPS = 21; // nSCKindMaps
const SCENE_VS_BATTLE = 22; // nSCKindVSBattle

const KEY = {
  A: 'c',
  B: 'x',
  START: 'Enter',
  Z: 'z',
  DUP: 'ArrowUp',
  DDOWN: 'ArrowDown',
  DLEFT: 'ArrowLeft',
  DRIGHT: 'ArrowRight',
  ANA_UP: 'w',
  ANA_DOWN: 's',
  ANA_LEFT: 'a',
  ANA_RIGHT: 'd',
  L: 't',
  R: 'y',
};

function randomInt(n) {
  return Math.floor(Math.random() * n);
}

async function setupPeer(browser, urlSuffix, label) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await page.goto(`${BASE_URL}/play.html?${urlSuffix}&name=${label}&mode=rollback`, {
    waitUntil: 'domcontentloaded',
  });
  await page.evaluate(() => {
    try {
      localStorage.removeItem('KN_DEV_BUILD');
      localStorage.setItem('kn-debug', '1');
    } catch {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#rom-drop')]);
  await fc.setFiles(ROM_PATH);
  await page.waitForTimeout(2000);
  return { ctx, page, label };
}

async function installRecorder(page, label, sharedState) {
  await page.exposeFunction('_recordKey', (ev) => {
    sharedState.events.push({ ...ev, window: label });
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
    };
    document.addEventListener('keydown', onKey('down'), true);
    document.addEventListener('keyup', onKey('up'), true);
  });
}

async function waitForFrame(page, minFrame, timeoutMs = 90000, pollMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = await page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
    if (frame >= minFrame) return frame;
    await page.waitForTimeout(pollMs);
  }
  const cur = await page.evaluate(() => window.KNState?.frameNum || 0).catch(() => -1);
  throw new Error(`Timeout waiting for frame ${minFrame}, current=${cur}`);
}

async function currentScene(page) {
  return page
    .evaluate(() => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      return mod?._kn_get_scene_curr?.() ?? null;
    })
    .catch(() => null);
}

async function waitForScene(page, targetScene, timeoutMs = 60000, pollMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = await currentScene(page);
    if (cur === targetScene) return cur;
    await page.waitForTimeout(pollMs);
  }
  throw new Error(`Timeout waiting for scene ${targetScene}, current=${await currentScene(page)}`);
}

async function waitForAnyScene(page, targetScenes, timeoutMs = 60000, pollMs = 50) {
  const targets = new Set(targetScenes);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = await currentScene(page);
    if (targets.has(cur)) return cur;
    await page.waitForTimeout(pollMs);
  }
  throw new Error(`Timeout waiting for scenes ${[...targets].join(',')}, current=${await currentScene(page)}`);
}

async function waitForBothScene(host, guest, targetScene, label, timeoutMs = 60000) {
  await Promise.all([
    waitForScene(host.page, targetScene, timeoutMs, 50),
    waitForScene(guest.page, targetScene, timeoutMs, 50),
  ]);
  const [hf, gf] = await Promise.all([
    host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0),
    guest.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0),
  ]);
  console.log(`  [scene ${targetScene} ${label}: host f=${hf} guest f=${gf}]`);
}

async function requireBothInVsBattle(host, guest, label, timeoutMs = 90000) {
  await Promise.all([
    waitForScene(host.page, SCENE_VS_BATTLE, timeoutMs, 50),
    waitForScene(guest.page, SCENE_VS_BATTLE, timeoutMs, 50),
  ]);
  const [hs, gs, hf, gf] = await Promise.all([
    currentScene(host.page),
    currentScene(guest.page),
    host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0),
    guest.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0),
  ]);
  if (hs !== SCENE_VS_BATTLE || gs !== SCENE_VS_BATTLE) {
    throw new Error(`${label}: peers did not reach VS Battle (host=${hs}, guest=${gs})`);
  }
  console.log(`  [VS Battle ${label}: host f=${hf} guest f=${gf}]`);
}

async function press(page, key, holdMs = 120) {
  await page.keyboard.down(key);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(key);
  await page.waitForTimeout(180);
}

async function main() {
  const startTs = Date.now();
  console.log(`Room: ${ROOM}`);

  const chromiumArgs = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ];

  console.log('Launching host (chromium)...');
  const hostBrowser = await chromium.launch({ headless: false, args: chromiumArgs });
  const host = await setupPeer(hostBrowser, `room=${ROOM}&host=1`, 'host');

  console.log('Launching guest (chromium)...');
  const guestBrowser = await chromium.launch({ headless: false, args: chromiumArgs });
  const guest = await setupPeer(guestBrowser, `room=${ROOM}`, 'guest');

  await host.page.waitForTimeout(3000);
  await guest.page.waitForTimeout(3000);

  // Select rollback mode + Start Game
  console.log('Setting rollback mode + Start Game...');
  await host.page.bringToFront();
  await host.page.waitForTimeout(500);
  const modeSelect = host.page.locator('select').first();
  await modeSelect.selectOption('lockstep');
  await host.page.waitForTimeout(1000);
  await host.page.locator('button:has-text("Start Game")').first().click();
  await host.page.waitForTimeout(3000);

  // Click "Tap to start" on both
  for (const page of [host.page, guest.page]) {
    await page.bringToFront();
    await page.waitForTimeout(500);
    try {
      await page.locator('text=/Tap to start/i').first().click({ timeout: 5000 });
      console.log('  clicked tap-to-start');
    } catch {
      await page.click('body', { position: { x: 640, y: 360 } }).catch(() => {});
    }
    await page.waitForTimeout(1500);
  }

  // Install recorders
  const shared = { events: [] };
  await installRecorder(host.page, 'host', shared);
  await installRecorder(guest.page, 'guest', shared);

  // === SCRIPTED NAVIGATION (scene-gated to match determinism-automation.mjs) ===
  console.log('\n=== Scripted Navigation ===');

  console.log('Waiting for intro (f=1900)...');
  await waitForFrame(host.page, 1900, 90000);
  await waitForFrame(guest.page, 1900, 90000);
  await host.page.waitForTimeout(1000);

  async function hostPress(key, holdMs = 200, waitAfter = 2500) {
    await host.page.bringToFront();
    await host.page.focus('body').catch(() => {});
    await press(host.page, key, holdMs);
    await host.page.waitForTimeout(waitAfter);
    const f = await host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
    console.log(`  [host f=${f} after ${key}]`);
  }
  async function guestPress(key, holdMs = 200, waitAfter = 2500) {
    await guest.page.bringToFront();
    await guest.page.focus('body').catch(() => {});
    await press(guest.page, key, holdMs);
    await guest.page.waitForTimeout(waitAfter);
    const f = await guest.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
    console.log(`  [guest f=${f} after ${key}]`);
  }

  console.log('Step 1: Wait for title screen, START → Mode Select');
  await waitForBothScene(host, guest, SCENE_TITLE, 'title', 120000).catch(() => {
    console.log('  [warn] title scene not observed; falling back to frame gate');
  });
  await hostPress(KEY.START, 300, 500);
  await waitForBothScene(host, guest, SCENE_MODE_SELECT, 'mode-select', 30000);

  console.log('Step 2: Analog down → VS MODE');
  await hostPress(KEY.ANA_DOWN, 300, 1000);

  console.log('Step 3: A → enter VS MODE');
  await hostPress(KEY.A, 300, 500);
  await waitForBothScene(host, guest, SCENE_VS_MODE, 'vs-mode', 30000);

  console.log('Step 4: A → confirm VS MODE entry');
  await hostPress(KEY.A, 300, 500);
  const postVsScene = await waitForAnyScene(host.page, [SCENE_VS_OPTIONS, SCENE_PLAYERS_VS], 30000, 50);
  if (postVsScene === SCENE_VS_OPTIONS) {
    await waitForBothScene(host, guest, SCENE_VS_OPTIONS, 'vs-options', 30000);
    console.log('Step 4b: A → enter CSS from VS options');
    await hostPress(KEY.A, 300, 500);
  }
  await waitForBothScene(host, guest, SCENE_PLAYERS_VS, 'css', 30000);

  console.log('Step 5: Host A → pick P1');
  await hostPress(KEY.A, 300, 1500);

  console.log('Step 6: Guest A → pick P2');
  await guestPress(KEY.A, 300, 1500);

  console.log('Step 7: Host START → Stage Select');
  await hostPress(KEY.START, 300, 500);
  await waitForBothScene(host, guest, SCENE_MAPS, 'stage-select', 30000);

  console.log('Step 8: A → pick stage → MATCH BEGIN');
  await hostPress(KEY.A, 300, 500);
  await requireBothInVsBattle(host, guest, 'recorded-nav');

  const matchFrame = await host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
  console.log(`Match started at frame ${matchFrame}`);

  let inputCount = 0;
  if (RECORD_RANDOM_AFTER_MATCH) {
    console.log(`\n=== Random input for ${GAMEPLAY_DURATION_MS / 1000}s ===`);
    const keys = [KEY.A, KEY.B, KEY.Z, KEY.L, KEY.R, KEY.ANA_LEFT, KEY.ANA_RIGHT, KEY.ANA_UP, KEY.ANA_DOWN];
    const endAt = Date.now() + GAMEPLAY_DURATION_MS;
    while (Date.now() < endAt) {
      const hostKey = keys[randomInt(keys.length)];
      const guestKey = keys[randomInt(keys.length)];
      await Promise.all([host.page.keyboard.down(hostKey), guest.page.keyboard.down(guestKey)]).catch(() => {});
      await new Promise((r) => setTimeout(r, 80));
      await Promise.all([host.page.keyboard.up(hostKey), guest.page.keyboard.up(guestKey)]).catch(() => {});
      await new Promise((r) => setTimeout(r, RANDOM_INTERVAL_MS - 80));
      inputCount++;
      if (inputCount % 20 === 0) {
        const hf = await host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
        const gf = await guest.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
        process.stdout.write(`\r  inputs=${inputCount} host_f=${hf} guest_f=${gf} gap=${Math.abs(hf - gf)}   `);
      }
    }
    console.log(`\n  Fed ${inputCount} random inputs.`);
  } else {
    console.log('\n=== Nav-only fixture saved at match start; determinism test will add random inputs ===');
  }

  // Final state
  const finalFrameHost = await host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
  const finalFrameGuest = await guest.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
  await host.page.screenshot({ path: '/tmp/nav-final-host.png' }).catch(() => {});
  await guest.page.screenshot({ path: '/tmp/nav-final-guest.png' }).catch(() => {});

  const events = shared.events.map((e) => ({
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

  console.log(`\nSaved ${events.length} events to ${RECORDING_FILE}`);
  console.log(`Final frames: host=${finalFrameHost} guest=${finalFrameGuest}`);
  console.log(`Total duration: ${((Date.now() - startTs) / 1000).toFixed(1)}s`);

  await host.page.waitForTimeout(2000);
  await hostBrowser.close();
  await guestBrowser.close();
}

main().catch((err) => {
  console.error('RECORDER ERROR:', err);
  process.exit(1);
});
