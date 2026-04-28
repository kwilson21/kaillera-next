#!/usr/bin/env node
/**
 * Same-tab ROM switch smoke test.
 *
 * Reproduces the user path:
 *   1. Host + guest load SSB64 and boot lockstep.
 *   2. Host ends the game, leaving both tabs in the lobby.
 *   3. Both tabs load Smash Remix in the same browser pages.
 *   4. Host starts again; both peers must enter lockstep without the stale
 *      SSB64 core or a stuck EmulatorJS start button.
 *
 * Usage:
 *   node tests/same-tab-rom-switch-automation.mjs --room=SWITCH123 --headless
 */
import { chromium } from 'playwright';
import { existsSync, writeFileSync } from 'fs';

const SSB64_ROM = '/Users/kazon/Downloads/Super Smash Bros. (USA)/Super Smash Bros. (USA).z64';
const REMIX_ROM = '/Users/kazon/Downloads/Smash Remix 2.0.1.z64';
const SSB64_HASH = 'S15592e79d3c5295cef4371d4992f0bd25bec2102fc29644c93e682f7ea99ef3d';
const REMIX_HASH = 'S7efec9e0983656bb0219a23c511cd1505a5f84d524e50ad4284dc1c7eb4d1403';

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const ROOM = argValue('room', process.env.KN_ROOM || `SWITCH${Date.now() % 10000}`);
const BASE_URL = argValue('base-url', process.env.KN_BASE_URL || 'https://localhost:27888');
const HEADLESS = process.argv.includes('--headless');
const TIMEOUT_MS = Number(argValue('timeout-ms', process.env.KN_TIMEOUT_MS || '180000'));
const REMIX_POST_BOOT_GUARD_FRAME = 1300;

const chromiumArgs = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
  '--no-sandbox',
];

const interestingLog =
  /ROM changed while emulator hibernated|controller present mask|emulator ready|state loaded|lockstep started|Emulator failed|thread|interrupt|yellow|CANVAS-HEALTH|audio-empty|FATAL|ABORT/i;

function assertRom(path) {
  if (!existsSync(path)) throw new Error(`ROM not found: ${path}`);
}

function collectLogs(page, label, logs) {
  page.on('console', (msg) => {
    const text = msg.text();
    if (interestingLog.test(text)) {
      const line = `[${label}] ${text.slice(0, 240)}`;
      logs.push(line);
      if (!/audio-empty/i.test(text)) console.log(line);
    }
  });
  page.on('pageerror', (err) => {
    const line = `[${label}] PAGE ERROR: ${(err.stack || err.message || String(err)).slice(0, 500)}`;
    logs.push(line);
    console.log(line);
  });
}

async function setupPeer(browser, query, label, logs) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  collectLogs(page, label, logs);
  await page.goto(`${BASE_URL}/play.html?${query}&name=${encodeURIComponent(label)}&mode=lockstep`, {
    waitUntil: 'domcontentloaded',
  });
  await page.evaluate(() => {
    try {
      localStorage.removeItem('KN_DEV_BUILD');
      localStorage.setItem('kn-debug', '1');
    } catch {}
  });
  await page.waitForFunction('window.__test_socket && window.__test_socket.connected', { timeout: 20000 });
  await page.waitForTimeout(1500);
  return { context, page, label };
}

async function loadRom(peer, romPath, label, expectedHash) {
  console.log(`  ${peer.label}: loading ${label}`);
  await peer.page.locator('#rom-drop input[type="file"]').setInputFiles(romPath);
  await peer.page.waitForFunction(
    (hash) => window.KNState?.romHash === hash && document.querySelector('#rom-drop')?.classList.contains('loaded'),
    expectedHash,
    { timeout: 90000 },
  );
  const state = await peer.page.evaluate(() => ({
    hash: window.KNState?.romHash || null,
    gameId: window.KNState?.gameId || null,
    ejs: !!window.EJS_emulator,
  }));
  console.log(
    `  ${peer.label}: ${label} loaded hash=${state.hash?.slice(0, 16)} gameId=${state.gameId} ejs=${state.ejs}`,
  );
  return state;
}

async function clickBootPrompt(peer) {
  await peer.page.bringToFront().catch(() => {});
  await peer.page
    .evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const candidates = [
        document.querySelector('#gesture-prompt:not(.hidden)'),
        document.querySelector('.ejs_start_button'),
        [...document.querySelectorAll('button, [role="button"]')].find(
          (el) => visible(el) && /tap to start|start game/i.test(el.textContent || el.getAttribute('aria-label') || ''),
        ),
      ];
      for (const el of candidates) {
        if (visible(el)) {
          el.click();
          return true;
        }
      }
      return false;
    })
    .catch(() => false);
}

async function debugState(peer) {
  return peer.page.evaluate(() => {
    const debug = window.NetplayLockstep?.getDebugState?.() || {};
    const mod = window.EJS_emulator?.gameManager?.Module;
    return {
      frame: debug.frameNum ?? window.KNState?.frameNum ?? 0,
      running: !!debug.running,
      state: debug.state || null,
      slot: debug.playerSlot ?? window.KNState?.slot ?? null,
      activeRoster: debug.activeRoster || null,
      romHash: window.KNState?.romHash || null,
      gameId: window.KNState?.gameId || null,
      ejs: !!window.EJS_emulator,
      coreFrame: mod?._get_current_frame_count?.() ?? null,
      hasStartButton: !!document.querySelector('.ejs_start_button'),
      gestureVisible: !!document.querySelector('#gesture-prompt:not(.hidden)'),
      errorText: document.querySelector('#error-msg:not(.hidden)')?.textContent?.trim() || '',
      loadingText: document.querySelector('#game-loading-text')?.textContent?.trim() || '',
    };
  });
}

async function waitForRunning(host, guest, label) {
  const start = Date.now();
  let lastLog = 0;
  let lastClick = 0;
  let last = null;
  while (Date.now() - start < TIMEOUT_MS) {
    if (Date.now() - lastClick > 1500) {
      lastClick = Date.now();
      await Promise.all([clickBootPrompt(host), clickBootPrompt(guest)]);
    }
    const states = await Promise.all([debugState(host), debugState(guest)]);
    last = states;
    const ok = states.every((s) => s.running && s.frame >= 30 && !/failed|error/i.test(s.errorText + s.loadingText));
    if (ok) {
      console.log(
        `  ${label}: running host f=${states[0].frame} core=${states[0].coreFrame} guest f=${states[1].frame} core=${states[1].coreFrame}`,
      );
      return states;
    }
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      console.log(
        `  ${label}: waiting host=${JSON.stringify(states[0])} guest=${JSON.stringify(states[1])}`.slice(0, 1200),
      );
    }
    if (states.some((s) => /Emulator failed|failed to start/i.test(s.loadingText + s.errorText))) break;
    await host.page.waitForTimeout(500);
  }
  throw new Error(`${label} did not reach running state; last=${JSON.stringify(last)}`);
}

async function waitForLobby(peers) {
  await Promise.all(
    peers.map((peer) =>
      peer.page.waitForFunction(
        () => {
          const overlayVisible = !document.querySelector('#overlay')?.classList.contains('hidden');
          const running = window.NetplayLockstep?.getDebugState?.().running === true;
          return overlayVisible && !running;
        },
        { timeout: 30000 },
      ),
    ),
  );
}

async function startGame(host) {
  await host.page.waitForFunction(
    () => {
      const btn = document.querySelector('#start-btn');
      return btn && !btn.disabled;
    },
    { timeout: 30000 },
  );
  await host.page.selectOption('#mode-select', 'lockstep').catch(() => {});
  await host.page.click('#start-btn');
}

async function endGame(host, peers) {
  await host.page.evaluate(() => new Promise((resolve) => window.__test_socket.emit('end-game', {}, resolve)));
  await waitForLobby(peers);
}

function requireNoFatalLogs(logs) {
  const fatal = logs.filter((line) =>
    /Emulator failed|memory access out of bounds|thread\s*5|interrupt|FATAL|ABORT/i.test(line),
  );
  if (fatal.length) {
    throw new Error(`Fatal emulator log(s):\n${fatal.join('\n')}`);
  }
}

function metric(line, name) {
  const match = line.match(new RegExp(`${name}=([0-9.]+)`));
  return match ? Number(match[1]) : null;
}

function frameMetric(line) {
  return metric(line, 'f');
}

function summarizeCanvasHealth(lines) {
  const health = lines.filter((line) => /CANVAS-HEALTH/i.test(line));
  const pale = health.map((line) => metric(line, 'paleRatio')).filter((value) => Number.isFinite(value));
  const yellowGreen = health.map((line) => metric(line, 'yellowGreenRatio')).filter((value) => Number.isFinite(value));
  return {
    healthCount: health.length,
    audioEmptyCount: lines.filter((line) => /audio-empty/i.test(line)).length,
    maxPale: pale.length ? Math.max(...pale) : 0,
    maxYellowGreen: yellowGreen.length ? Math.max(...yellowGreen) : 0,
    lastHealth: health.at(-1) || null,
  };
}

async function sampleRenderedCanvas(peer, room) {
  const canvas = peer.page.locator('canvas#canvas, canvas.ejs_canvas, canvas').first();
  const buffer = await canvas.screenshot({ timeout: 5000 });
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  const metrics = await peer.page.evaluate(
    async ({ src }) => {
      const img = await new Promise((resolve, reject) => {
        const node = new Image();
        node.onload = () => resolve(node);
        node.onerror = () => reject(new Error('screenshot decode failed'));
        node.src = src;
      });
      const sampleW = 160;
      const sampleH = 120;
      const scratch = document.createElement('canvas');
      scratch.width = sampleW;
      scratch.height = sampleH;
      const ctx = scratch.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, sampleW, sampleH);
      const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let minY = 255;
      let maxY = 0;
      let palePixels = 0;
      const ys = [];
      for (let i = 0; i < data.length; i += 4) {
        const rr = data[i];
        const gg = data[i + 1];
        const bb = data[i + 2];
        const y = (rr + gg + bb) / 3;
        r += rr;
        g += gg;
        b += bb;
        ys.push(y);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        if (rr >= 120 && gg >= 125 && bb >= 100 && gg >= bb + 5 && Math.max(rr, gg, bb) - Math.min(rr, gg, bb) <= 95) {
          palePixels++;
        }
      }
      const n = ys.length || 1;
      const meanR = r / n;
      const meanG = g / n;
      const meanB = b / n;
      const brightness = (meanR + meanG + meanB) / 3;
      let variance = 0;
      for (const y of ys) variance += (y - brightness) * (y - brightness);
      return {
        mean: { r: Number(meanR.toFixed(1)), g: Number(meanG.toFixed(1)), b: Number(meanB.toFixed(1)) },
        brightness: Number(brightness.toFixed(1)),
        stdev: Number(Math.sqrt(variance / n).toFixed(1)),
        range: Number((maxY - minY).toFixed(1)),
        paleRatio: Number((palePixels / n).toFixed(3)),
      };
    },
    { src: dataUrl },
  );
  const file = `/tmp/kn-remix-${room}-${peer.label.toLowerCase()}.png`;
  return { ...metrics, file, buffer };
}

async function guardRemixPostBoot(host, guest, logs, logStartIndex) {
  const start = Date.now();
  let lastStates = null;
  let lastSummary = null;
  while (Date.now() - start < Math.min(30000, TIMEOUT_MS)) {
    await host.page.waitForTimeout(1000);
    lastStates = await Promise.all([debugState(host), debugState(guest)]);
    const recent = logs.slice(logStartIndex);
    const fatal = recent.filter((line) =>
      /Emulator failed|memory access out of bounds|thread\s*5|interrupt|FATAL|ABORT/i.test(line),
    );
    if (fatal.length) throw new Error(`Remix fatal post-boot log(s):\n${fatal.join('\n')}`);
    lastSummary = summarizeCanvasHealth(recent);
    const oldEnough = lastStates.every((state) => (state.frame || 0) >= REMIX_POST_BOOT_GUARD_FRAME);
    if (oldEnough) {
      const visuals = await Promise.all([sampleRenderedCanvas(host, ROOM), sampleRenderedCanvas(guest, ROOM)]);
      const paleVisual = visuals.find((v) => v.paleRatio >= 0.45 && v.brightness >= 95 && v.mean.g >= v.mean.b + 5);
      if (paleVisual) {
        for (const visual of visuals) writeFileSync(visual.file, visual.buffer);
        throw new Error(`Remix pale/yellow canvas detected: ${JSON.stringify(visuals.map(({ buffer, ...v }) => v))}`);
      }
    }
    const paleCrash = lastSummary.maxPale >= 0.5 || lastSummary.maxYellowGreen >= 0.5;
    const audioStuck = lastSummary.audioEmptyCount >= 40;
    if (oldEnough && paleCrash && audioStuck) {
      throw new Error(
        `Remix visual/audio crash detected: ${JSON.stringify(lastSummary)} states=${JSON.stringify(lastStates)}`,
      );
    }
    if (oldEnough && lastSummary.healthCount >= 4) {
      console.log(`  Smash Remix post-boot guard: ${JSON.stringify(lastSummary)}`);
      return lastSummary;
    }
    if (oldEnough && lastSummary.healthCount === 0) {
      console.log(
        `  Smash Remix post-boot guard: frames ok without console health states=${JSON.stringify(lastStates)}`,
      );
      return lastSummary;
    }
  }
  throw new Error(
    `Remix post-boot guard did not collect enough health data; summary=${JSON.stringify(lastSummary)} states=${JSON.stringify(lastStates)}`,
  );
}

async function main() {
  assertRom(SSB64_ROM);
  assertRom(REMIX_ROM);
  console.log(`Room: ${ROOM}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Headless: ${HEADLESS}`);
  const logs = [];
  const browser = await chromium.launch({ headless: HEADLESS, args: chromiumArgs });
  try {
    const host = await setupPeer(browser, `room=${encodeURIComponent(ROOM)}&host=1`, 'Host', logs);
    const guest = await setupPeer(browser, `room=${encodeURIComponent(ROOM)}`, 'Guest', logs);

    await Promise.all([loadRom(host, SSB64_ROM, 'SSB64', SSB64_HASH), loadRom(guest, SSB64_ROM, 'SSB64', SSB64_HASH)]);
    await startGame(host);
    await waitForRunning(host, guest, 'SSB64 first boot');

    await endGame(host, [host, guest]);
    const hibernated = await Promise.all([debugState(host), debugState(guest)]);
    console.log(`  after end-game: host ejs=${hibernated[0].ejs} guest ejs=${hibernated[1].ejs}`);

    const remixLoad = [
      await loadRom(host, REMIX_ROM, 'Smash Remix', REMIX_HASH),
      await loadRom(guest, REMIX_ROM, 'Smash Remix', REMIX_HASH),
    ];
    if (remixLoad.some((s) => s.ejs)) {
      throw new Error(`Old EJS core still present after Remix load: ${JSON.stringify(remixLoad)}`);
    }

    const remixLogStart = logs.length;
    await startGame(host);
    const remixRunning = await waitForRunning(host, guest, 'Smash Remix second boot');
    if (remixRunning.some((s) => s.gameId !== 'smash-remix')) {
      throw new Error(`Remix boot did not carry smash-remix gameId: ${JSON.stringify(remixRunning)}`);
    }
    await guardRemixPostBoot(host, guest, logs, remixLogStart);
    requireNoFatalLogs(logs);
    console.log(`RESULT same-tab ROM switch OK room=${ROOM}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`RESULT same-tab ROM switch FAIL room=${ROOM}`);
  console.error(err?.stack || err);
  process.exit(1);
});
