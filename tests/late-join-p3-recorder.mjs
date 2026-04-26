#!/usr/bin/env node
/**
 * Manual P3 late-join recorder.
 *
 * Use when the two-player setup is already at CSS and we only need to capture
 * what happens when a third player joins and the user drives P3 manually.
 *
 * Usage:
 *   node tests/late-join-p3-recorder.mjs --room=ROOMID
 *   node tests/late-join-p3-recorder.mjs --room=ROOMID --duration=120
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const DEFAULT_ROM_PATH = '/Users/kazon/Downloads/Smash Remix 2.0.1.z64';
const DEFAULT_BASE_URL = 'https://localhost:27888';

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const ROOM = argValue('room', process.env.KN_ROOM || '');
const ROM_PATH = argValue('rom', process.env.KN_ROM_PATH || DEFAULT_ROM_PATH);
const BASE_URL = argValue('base-url', process.env.KN_BASE_URL || DEFAULT_BASE_URL);
const DURATION_SEC = Number(argValue('duration', process.env.KN_RECORD_SECONDS || '90'));
const NAME = argValue('name', 'late');

if (!ROOM) {
  console.error('Missing --room=ROOMID');
  process.exit(2);
}

const CHROMIUM_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
];

async function loadRom(page) {
  const drop = page.locator('#rom-drop');
  await drop.waitFor({ state: 'visible', timeout: 45000 });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), drop.click()]);
  await chooser.setFiles(ROM_PATH);
  await page.waitForTimeout(2500);
}

async function clickGesturePrompt(page) {
  await page.bringToFront();
  await page.waitForTimeout(250);
  const clicked =
    (await page
      .locator('#gesture-prompt')
      .click({ timeout: 2500 })
      .then(() => true)
      .catch(() => false)) ||
    (await page
      .getByText(/tap to start/i)
      .first()
      .click({ timeout: 2500 })
      .then(() => true)
      .catch(() => false));
  if (!clicked) await page.click('body', { position: { x: 640, y: 360 } }).catch(() => {});
  await page.focus('body').catch(() => {});
  await page.waitForTimeout(1000);
}

async function debugState(page) {
  return page
    .evaluate(() => {
      const debug = window.NetplayLockstep?.getDebugState?.() || null;
      const text = (id) => document.getElementById(id)?.textContent?.trim() || '';
      const mod = window.EJS_emulator?.gameManager?.Module;
      let scene = null;
      try {
        scene = mod?._kn_get_scene_curr?.() ?? null;
      } catch {}
      return {
        frame: debug?.frameNum ?? window.KNState?.frameNum ?? 0,
        slot: debug?.playerSlot ?? window._playerSlot ?? null,
        running: debug?.running ?? null,
        runSubstate: debug?.runSubstate ?? null,
        activeRoster: debug?.activeRoster ?? null,
        inputPeerSlots: debug?.inputPeerSlots ?? null,
        heldKeyCodes: debug?.heldKeyCodes ?? [],
        localInputNow: debug?.localInputNow ?? null,
        peersDetail: debug?.peersDetail ?? null,
        scene,
        status: text('toolbar-status') || text('engine-status') || text('game-loading-text'),
      };
    })
    .catch((err) => ({ error: String(err) }));
}

async function installRecorder(page) {
  await page.evaluate(() => {
    window.__p3ManualRecording = [];
    const keyCodeMap = {
      c: 67,
      x: 88,
      v: 86,
      Enter: 13,
      ArrowUp: 38,
      ArrowDown: 40,
      ArrowLeft: 37,
      ArrowRight: 39,
      t: 84,
      y: 89,
      z: 90,
      a: 65,
      s: 83,
      d: 68,
      w: 87,
      j: 74,
      l: 76,
      k: 75,
      i: 73,
    };
    const snapshot = (event) => {
      const debug = window.NetplayLockstep?.getDebugState?.() || null;
      window.__p3ManualRecording.push({
        type: event.type,
        key: event.key,
        code: event.code,
        keyCode: event.keyCode || keyCodeMap[event.key] || 0,
        repeat: !!event.repeat,
        ts: Date.now(),
        frame: debug?.frameNum ?? window.KNState?.frameNum ?? 0,
        slot: debug?.playerSlot ?? window._playerSlot ?? null,
        scene: window.EJS_emulator?.gameManager?.Module?._kn_get_scene_curr?.() ?? null,
        heldKeyCodes: debug?.heldKeyCodes ?? [],
        localInputNow: debug?.localInputNow ?? null,
        activeRoster: debug?.activeRoster ?? null,
        inputPeerSlots: debug?.inputPeerSlots ?? null,
      });
    };
    document.addEventListener('keydown', snapshot, true);
    document.addEventListener('keyup', snapshot, true);
  });
}

async function main() {
  console.log(`Room: ${ROOM}`);
  console.log(`ROM: ${ROM_PATH}`);
  console.log(`Duration: ${DURATION_SEC}s`);

  const browser = await chromium.launch({ headless: false, args: CHROMIUM_ARGS });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    const text = msg.text();
    if (/late-join|requesting game state|received late-join|ready|resume|fatal|mismatch|diverge/i.test(text)) {
      console.log(`[p3] ${text.substring(0, 240)}`);
    }
  });
  page.on('pageerror', (err) => console.log(`[p3] PAGE ERROR: ${err.message}`));

  const url = `${BASE_URL}/play.html?room=${encodeURIComponent(ROOM)}&name=${encodeURIComponent(NAME)}&mode=rollback`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try {
      localStorage.removeItem('KN_DEV_BUILD');
      localStorage.setItem('kn-debug', '1');
    } catch {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });

  console.log('Loading ROM for P3...');
  await loadRom(page);
  await installRecorder(page);
  await clickGesturePrompt(page);
  await page.bringToFront();
  await page.focus('body').catch(() => {});

  console.log('P3 window is focused. Drive P3 manually now.');
  const startedAt = Date.now();
  let lastLog = 0;
  while (Date.now() - startedAt < DURATION_SEC * 1000) {
    const state = await debugState(page);
    const now = Date.now();
    if (now - lastLog >= 2000) {
      lastLog = now;
      console.log(
        `  t=${Math.round((now - startedAt) / 1000)}s f=${state.frame} scene=${state.scene} slot=${state.slot} ` +
          `local=${JSON.stringify(state.localInputNow)} held=${JSON.stringify(state.heldKeyCodes)} status="${state.status}"`,
      );
    }
    await page.waitForTimeout(250);
  }

  const recording = await page.evaluate(() => window.__p3ManualRecording || []);
  const finalState = await debugState(page);
  const out = `/tmp/latejoin-p3-recording-${ROOM}.json`;
  writeFileSync(out, JSON.stringify({ room: ROOM, name: NAME, finalState, events: recording }, null, 2));
  await page.screenshot({ path: `/tmp/latejoin-p3-recording-${ROOM}.png` }).catch(() => {});
  console.log(`Saved ${recording.length} events to ${out}`);
  console.log(`Screenshot: /tmp/latejoin-p3-recording-${ROOM}.png`);
  console.log(`Final: ${JSON.stringify(finalState)}`);
  await ctx.close();
  await browser.close();
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
