#!/usr/bin/env node
/**
 * Automated cross-instance determinism harness.
 *
 * Launches 2 browsers (chromium+chromium currently; can swap to webkit for
 * V8-vs-JSC once installed). Navigates both through title → VS mode →
 * stock match → CSS → SSS → gameplay, feeds random inputs for N seconds,
 * then pulls admin API logs and reports MM / DIVERGE counts.
 *
 * Takes screenshots at each navigation step into /tmp/det-step-*.png so
 * failures can be inspected visually.
 *
 * Run: node tests/determinism-automation.mjs
 */
import { chromium, webkit } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import https from 'https';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Persistent recording (in-tree). Used when --replay has no explicit path.
const DEFAULT_REPLAY = join(__dirname, 'fixtures', 'nav-recording.json');
const HOST_RANDOM_SELECT_START_FRAME = 826;
const HOST_RANDOM_SELECT_END_FRAME = 1068;
const GUEST_RANDOM_SELECT_START_FRAME = 1265;
const NAV_P2_SELECTED_FRAME = 1444;
const GUEST_STAGE_SELECT_START_FRAME = 1495;
const GUEST_STAGE_PICK_END_FRAME = 1726;

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const MANUAL_SETUP = process.argv.includes('--manual-setup');
const REPLAY_ARG_IDX = process.argv.indexOf('--replay');
const REPLAY_FILE =
  REPLAY_ARG_IDX !== -1
    ? MANUAL_SETUP
      ? null
      : process.argv[REPLAY_ARG_IDX + 1] && !process.argv[REPLAY_ARG_IDX + 1].startsWith('--')
        ? process.argv[REPLAY_ARG_IDX + 1]
        : existsSync(DEFAULT_REPLAY)
          ? DEFAULT_REPLAY
          : null
    : null;
const USE_WEBKIT_GUEST = !process.argv.includes('--no-webkit');
const LIGHT_CAPTURE = !process.argv.includes('--heavy-capture') && !process.argv.includes('--full-capture');
const CSS_PROBE = process.argv.includes('--css-probe');
const CSS_PROBE_FRAME_ARG_IDX = process.argv.indexOf('--css-probe-frame');
const CSS_PROBE_MIN_FRAME =
  CSS_PROBE_FRAME_ARG_IDX !== -1 ? Number(process.argv[CSS_PROBE_FRAME_ARG_IDX + 1] || 0) : 900;
const GUEST_DSF2 = process.argv.includes('--guest-dsf2');
const GFX_PROFILE_ARG_IDX = process.argv.indexOf('--gfx-profile');
const GFX_PROFILE = GFX_PROFILE_ARG_IDX !== -1 ? process.argv[GFX_PROFILE_ARG_IDX + 1] : null;
const CORE_DATA_ARG_IDX = process.argv.indexOf('--core-data');
const CORE_DATA = CORE_DATA_ARG_IDX !== -1 ? process.argv[CORE_DATA_ARG_IDX + 1] : null;
const CORE_DATA_URL = CORE_DATA ? (CORE_DATA.startsWith('/') ? CORE_DATA : `/static/ejs/cores/${CORE_DATA}`) : null;
const DURATION_ARG_IDX = process.argv.indexOf('--duration-ms');
const GAMEPLAY_DURATION_MS =
  DURATION_ARG_IDX !== -1 ? Math.max(1_000, Number(process.argv[DURATION_ARG_IDX + 1] || 0)) : 180_000;
const TRANSPORT_ARG_IDX = process.argv.indexOf('--transport');
const TRANSPORT_OVERRIDE = TRANSPORT_ARG_IDX !== -1 ? process.argv[TRANSPORT_ARG_IDX + 1] : null;
const NETSIM_JITTER_ARG_IDX = process.argv.indexOf('--netsim-jitter-ms');
const NETSIM_JITTER_MS = NETSIM_JITTER_ARG_IDX !== -1 ? Number(process.argv[NETSIM_JITTER_ARG_IDX + 1] || 0) : 0;
const NETSIM_DROP_ARG_IDX = process.argv.indexOf('--netsim-drop-pct');
const NETSIM_DROP_PCT = NETSIM_DROP_ARG_IDX !== -1 ? Number(process.argv[NETSIM_DROP_ARG_IDX + 1] || 0) : 0;
const NETSIM_ENABLED = NETSIM_JITTER_MS > 0 || NETSIM_DROP_PCT > 0;
const DESYNC_MODE_ARG_IDX = process.argv.indexOf('--desync-mode');
const DESYNC_MODE =
  DESYNC_MODE_ARG_IDX !== -1 ? String(process.argv[DESYNC_MODE_ARG_IDX + 1] || '').toLowerCase() : null;
const VERBOSE_DEEP_LOGS = process.argv.includes('--verbose-diag') || DESYNC_MODE === 'deep';
const LATE_JOIN_MIDMATCH = process.argv.includes('--late-join-midmatch');
const LATE_JOIN_DELAY_MS = Number(argValue('late-join-delay-ms', process.env.KN_LATE_JOIN_DELAY_MS || '3000'));
const KEEP_OPEN = process.argv.includes('--keep-open');
const STARTUP_STATE_PROBE = process.argv.includes('--startup-state-probe');
const SETUP_ONLY = process.argv.includes('--setup-only');

const ROM_PATH = '/Users/kazon/Downloads/Smash Remix 2.0.1.z64';
const BASE_URL = argValue('base-url', process.env.KN_BASE_URL || 'https://localhost:27888');
const ADMIN_KEY = '1234';
const ROOM = argValue('room', process.env.KN_ROOM || 'AUTO' + (Date.now() % 10000));
/* 2026-04-25: extended from 60s → 180s (3 min) per user request to
 * "let random inputs play out for a few mins and continuously capture
 * screenshots". Combined with kn-diagnostics.js SCREENSHOT_INTERVAL=60
 * (~1s upload cadence), this gives us ~180 cross-peer screenshot pairs
 * to feed DeepSeek for visual desync detection beyond what SSIM catches. */
const RANDOM_INPUT_INTERVAL_MS = 200; // every 200ms, new input
/* Diagnostic: disable random inputs entirely. With no inputs, fighters
 * stand idle. If cross-peer state stays clean (zero state-diff + zero
 * fighter-diff through all CPs), the residual divergence we've been
 * seeing is entirely test-input asymmetry. If divergence STILL appears
 * idle, there's a real simulation drift source independent of inputs. */
const NO_RANDOM_INPUTS = process.argv.includes('--no-inputs');
const DESYNC_POLL_MS = 500; // how often to check for window._kn_desyncDetectedGameFrame
const DESYNC_GRACE_FRAMES = 60; // after desync detected, capture ~1s more RDRAM before exiting
/* SSIM early-exit threshold. The server flags is_desync at ssim<0.95 but
 * 0.94 is consistently visually identical (pixel-level JPEG/shader noise
 * between V8+Chromium GPU and JSC+WebKit GPU). A real "player-visible"
 * desync (fighters in different positions, different timer, different
 * damage) shows up at ssim<0.70. Using 0.70 here so the test only
 * early-exits on meaningful divergence, not on rendering variance. */
const SSIM_EARLY_EXIT_THRESHOLD = 0.7;
const SETUP_VISUAL_MEAN_ABS_LIMIT = 30;
const SETUP_VISUAL_MISMATCH_RATIO_LIMIT = 0.3;
const SETUP_VISUAL_STRONG_MISMATCH_LIMIT = 0.12;
const REPORT_FILE = '/tmp/determinism-report.json';
const STARTUP_STATE_REPORT_FILE = '/tmp/startup-state-probe.json';
const CSS_PROBE_FILE = '/tmp/css-graphics-probe.json';
const SHOT_DIR = '/tmp';
const SCENE_TITLE = 1; // nSCKindTitle
const SCENE_MODE_SELECT = 7; // nSCKindModeSelect
const SCENE_VS_MODE = 9; // nSCKindVSMode
const SCENE_VS_OPTIONS = 10; // nSCKindVSOptions
const SCENE_PLAYERS_VS = 16; // nSCKindPlayersVS
const SCENE_MAPS = 21; // nSCKindMaps
const SCENE_VS_BATTLE = 22; // nSCKindVSBattle
const CSS_RANDOM_CHAR_ID = 0x1b000000;
const REPLAY_MIN_HOLD_FRAMES = 2;
const YELLOW_SCREEN_SAMPLE_ATTEMPTS = 5;
const YELLOW_SCREEN_SAMPLE_DELAY_MS = 500;
const RENDERED_CANVAS_SAMPLE_W = 48;
const RENDERED_CANVAS_SAMPLE_H = 36;

// Keyboard-based input (matches DEFAULT_N64_KEYMAP in web/static/shared.js).
// Using real keyboard events routes through the netplay engine's local-input
// capture (readLocalInput → heldKeys), which is what gets sent to peers.
// Calling _simulate_input directly bypasses the netplay capture layer and
// gets overwritten every frame by the netplay loop.
const KEY = {
  A: 'c',
  B: 'x',
  START: 'Enter',
  START_ALT: 'v',
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

const KEYCODE_MAP = {
  c: 67,
  x: 88,
  v: 86,
  z: 90,
  Enter: 13,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  t: 84,
  y: 89,
  a: 65,
  s: 83,
  d: 68,
  w: 87,
  j: 74,
  l: 76,
  k: 75,
  i: 73,
};

const SYNTHETIC_INPUT = {
  [KEY.A]: { bit: 0, value: 1 },
  [KEY.B]: { bit: 1, value: 1 },
  [KEY.START]: { bit: 3, value: 1 },
  [KEY.START_ALT]: { bit: 3, value: 1 },
  [KEY.DUP]: { bit: 4, value: 1 },
  [KEY.DDOWN]: { bit: 5, value: 1 },
  [KEY.DLEFT]: { bit: 6, value: 1 },
  [KEY.DRIGHT]: { bit: 7, value: 1 },
  [KEY.L]: { bit: 10, value: 1 },
  [KEY.R]: { bit: 11, value: 1 },
  [KEY.Z]: { bit: 12, value: 1 },
  [KEY.ANA_RIGHT]: { bit: 16, value: 32767 },
  [KEY.ANA_LEFT]: { bit: 17, value: 32767 },
  [KEY.ANA_DOWN]: { bit: 18, value: 32767 },
  [KEY.ANA_UP]: { bit: 19, value: 32767 },
};

async function setSyntheticInput(page, key, down) {
  const spec = SYNTHETIC_INPUT[key];
  if (!spec) return;
  await page
    .evaluate(
      ({ bit, value, down }) => {
        if (!window.KNState?.touchInput) return;
        window.KNState.touchInput[bit] = down ? value : 0;
      },
      { ...spec, down },
    )
    .catch(() => {});
}

async function pulseSyntheticInput(page, key, value, holdMs = 80) {
  const spec = SYNTHETIC_INPUT[key];
  if (!spec) return;
  await page
    .evaluate(
      ({ bit, value }) => {
        if (!window.KNState?.touchInput) return;
        window.KNState.touchInput[bit] = value;
      },
      { bit: spec.bit, value },
    )
    .catch(() => {});
  await page.waitForTimeout(holdMs);
  await page
    .evaluate(
      ({ bit }) => {
        if (!window.KNState?.touchInput) return;
        window.KNState.touchInput[bit] = 0;
      },
      { bit: spec.bit },
    )
    .catch(() => {});
  await page.waitForTimeout(120);
}

async function keyDown(page, key) {
  await page.keyboard.down(key).catch(() => {});
  await setSyntheticInput(page, key, true);
}

async function keyUp(page, key) {
  await setSyntheticInput(page, key, false);
  await page.keyboard.up(key).catch(() => {});
}

async function press(page, key, holdMs = 120) {
  await keyDown(page, key);
  await page.waitForTimeout(holdMs);
  await keyUp(page, key);
  await page.waitForTimeout(180);
}

async function installReplayEvents(page, events, label) {
  await page.evaluate(
    ({ events, label, minHoldFrames, keyCodeMap, syntheticInput }) => {
      const sorted = [...events].sort((a, b) => a.frame - b.frame);
      window._replayEvents = sorted;
      window._replayNext = 0;
      window._replayFired = 0;
      window._replayLabel = label;
      window._replayLastFrame = 0;
      window._replayPendingUps = [];
      const setTouchInput = (event) => {
        const spec = syntheticInput[event.key];
        if (!spec || !window.KNState?.touchInput) return;
        window.KNState.touchInput[spec.bit] = event.type === 'down' ? spec.value : 0;
      };
      const dispatch = (event) => {
        const kc = keyCodeMap[event.key] ?? 0;
        const kbd = new KeyboardEvent(event.type === 'down' ? 'keydown' : 'keyup', {
          key: event.key,
          code: event.code,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(kbd, 'keyCode', { get: () => kc });
        Object.defineProperty(kbd, 'which', { get: () => kc });
        document.dispatchEvent(kbd);
        setTouchInput(event);
        window._replayFired++;
      };
      const fire = (event, frame) => {
        if (event.type !== 'up') {
          dispatch(event);
          return;
        }
        const prevDown = window._replayEvents
          .slice(0, window._replayNext)
          .reverse()
          .find((candidate) => candidate.key === event.key && candidate.type === 'down');
        const minFrame = prevDown ? prevDown.frame + minHoldFrames : event.frame;
        const targetFrame = Math.max(event.frame, minFrame);
        if (frame >= targetFrame) dispatch(event);
        else window._replayPendingUps.push({ event, targetFrame });
      };
      const poll = () => {
        const mod = window.EJS_emulator?.gameManager?.Module;
        const frame = window.KNState?.frameNum || mod?._kn_get_frame?.() || 0;
        if (frame === window._replayLastFrame) return;
        window._replayLastFrame = frame;
        if (window._replayPendingUps.length) {
          const stillPending = [];
          for (const pending of window._replayPendingUps) {
            if (frame >= pending.targetFrame) dispatch(pending.event);
            else stillPending.push(pending);
          }
          window._replayPendingUps = stillPending;
        }
        while (
          window._replayNext < window._replayEvents.length &&
          window._replayEvents[window._replayNext].frame <= frame
        ) {
          fire(window._replayEvents[window._replayNext++], frame);
        }
      };
      window._replayTimerId = setInterval(poll, 8);
    },
    { events, label, minHoldFrames: REPLAY_MIN_HOLD_FRAMES, keyCodeMap: KEYCODE_MAP, syntheticInput: SYNTHETIC_INPUT },
  );
}

async function stopReplayEvents(page) {
  await page
    .evaluate(() => {
      if (window._replayTimerId) clearInterval(window._replayTimerId);
      window._replayTimerId = null;
    })
    .catch(() => {});
}

async function waitForReplayDone(page, expectedCount, label, timeoutMs = 60000) {
  const start = Date.now();
  let last = { fired: 0, frame: 0 };
  while (Date.now() - start < timeoutMs) {
    last = await page
      .evaluate(() => ({
        fired: window._replayFired || 0,
        frame: window.KNState?.frameNum || 0,
      }))
      .catch(() => last);
    process.stdout.write(`\r    ${label}: ${last.fired}/${expectedCount} f=${last.frame}   `);
    if (last.fired >= expectedCount) {
      console.log('');
      return last;
    }
    await page.waitForTimeout(250);
  }
  console.log('');
  throw new Error(`${label} replay did not finish: ${last.fired}/${expectedCount} f=${last.frame}`);
}

async function replayFixtureSegment(peer, windowName, startFrame, endFrame, label) {
  const rec = JSON.parse(readFileSync(DEFAULT_REPLAY, 'utf8'));
  const segmentEvents = rec.events.filter(
    (event) => event.window === windowName && event.frame >= startFrame && event.frame <= endFrame,
  );
  if (!segmentEvents.length) throw new Error(`${label} has no fixture events`);
  const firstFrame = segmentEvents[0].frame;
  const currentFrame = await peer.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
  const baseFrame = currentFrame + 10;
  const replayEvents = segmentEvents.map((event) => ({
    ...event,
    frame: baseFrame + (event.frame - firstFrame),
    window: peer.name,
  }));
  console.log(
    `    ${label} using fixture ${windowName}:${startFrame}-${endFrame} (current=${currentFrame}, events=${replayEvents.length})`,
  );
  await installReplayEvents(peer.page, replayEvents, label);
  await waitForReplayDone(peer.page, replayEvents.length, label);
  await stopReplayEvents(peer.page);
}

async function waitForFrame(page, minFrame, timeoutMs = 60000, pollMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = await page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
    if (frame >= minFrame) return frame;
    await page.waitForTimeout(pollMs);
  }
  const cur = await page.evaluate(() => window.KNState?.frameNum || 0).catch(() => -1);
  throw new Error(`Timeout waiting for frame ${minFrame}, current=${cur}`);
}

async function bootState(page) {
  return page
    .evaluate(() => {
      const peers = Object.values(window.KNState?.peers || {}).map((p) => ({
        pc: p.pc?.connectionState || 'none',
        dc: p.dc?.readyState || 'none',
        ready: !!p.ready,
      }));
      const text = (id) => document.getElementById(id)?.textContent?.trim() || '';
      return {
        frame: window.KNState?.frameNum || 0,
        peers,
        status: text('toolbar-status') || text('engine-status') || text('game-loading-text'),
        gesture: !!document.querySelector('#gesture-prompt:not(.hidden)'),
        ejsStart: !!document.querySelector('.ejs_start_button'),
      };
    })
    .catch(() => ({ frame: 0, peers: [], status: 'page unavailable', gesture: false, ejsStart: false }));
}

async function clickBootPrompt(page, label) {
  await page.bringToFront();
  await page.waitForTimeout(100);
  const clicked = await page
    .evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const candidates = [
        document.querySelector('#gesture-prompt:not(.hidden)'),
        [...document.querySelectorAll('button, [role="button"], .ejs_start_button')].find(
          (el) => visible(el) && /tap to start|start game/i.test(el.textContent || el.getAttribute('aria-label') || ''),
        ),
        document.querySelector('.ejs_start_button'),
      ];
      for (const el of candidates) {
        if (visible(el)) {
          el.click();
          return el.id || el.className || el.textContent || 'button';
        }
      }
      return '';
    })
    .catch(() => '');
  if (clicked) {
    console.log(`  ${label}: clicked boot prompt (${String(clicked).slice(0, 40)})`);
    return true;
  }
  await page.click('body', { position: { x: 640, y: 360 } }).catch(() => {});
  return false;
}

async function waitForBothTicking(host, guest, timeoutMs = 120000) {
  const start = Date.now();
  let lastClickAt = 0;
  let lastLogAt = 0;
  while (Date.now() - start < timeoutMs) {
    const [hs, gs] = await Promise.all([bootState(host.page), bootState(guest.page)]);
    if (hs.frame > 10 && gs.frame > 10) {
      console.log(`  tick gate OK: host=${hs.frame} guest=${gs.frame}`);
      return { host: hs, guest: gs };
    }

    const now = Date.now();
    if (now - lastClickAt >= 2000) {
      lastClickAt = now;
      await clickBootPrompt(host.page, 'host');
      await clickBootPrompt(guest.page, 'guest');
    }
    if (now - lastLogAt >= 5000) {
      lastLogAt = now;
      const fmtPeers = (s) => s.peers.map((p) => `${p.pc}/${p.dc}${p.ready ? '/ready' : ''}`).join(',') || 'none';
      console.log(
        `  waiting for tick: host f=${hs.frame} [${fmtPeers(hs)}] ${hs.status || ''} | ` +
          `guest f=${gs.frame} [${fmtPeers(gs)}] ${gs.status || ''}`,
      );
    }
    await host.page.waitForTimeout(500);
  }

  const [hs, gs] = await Promise.all([bootState(host.page), bootState(guest.page)]);
  throw new Error(
    `Timed out waiting for both emulators to tick: ` +
      `host f=${hs.frame} peers=${JSON.stringify(hs.peers)} status="${hs.status}", ` +
      `guest f=${gs.frame} peers=${JSON.stringify(gs.peers)} status="${gs.status}"`,
  );
}

async function readScene(page) {
  return page
    .evaluate(() => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (!mod?._kn_get_rdram_ptr || !mod.HEAPU8) return null;
      const ptr = mod._kn_get_rdram_ptr();
      return mod.HEAPU8[ptr + (0xa4ad0 ^ 3)] ?? null;
    })
    .catch(() => null);
}

async function readGameStatus(page) {
  return page
    .evaluate(() => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (!mod?._kn_get_rdram_ptr || !mod.HEAPU32) return null;
      const ptr = mod._kn_get_rdram_ptr();
      const word = mod.HEAPU32[(ptr + 0xa4d18) >> 2] >>> 0;
      return (word >>> 16) & 0xff;
    })
    .catch(() => null);
}

async function waitForScene(page, targetScene, timeoutMs = 60000, pollMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = await readScene(page);
    if (cur === targetScene) return cur;
    await page.waitForTimeout(pollMs);
  }
  const cur = await readScene(page);
  throw new Error(`Timeout waiting for scene ${targetScene}, current=${cur}`);
}

async function waitForActiveVsBattle(page, timeoutMs = 60000, pollMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [scene, gameStatus] = await Promise.all([readScene(page), readGameStatus(page)]);
    if (scene === SCENE_VS_BATTLE && gameStatus === 1) return { scene, gameStatus };
    await page.waitForTimeout(pollMs);
  }
  const [scene, gameStatus] = await Promise.all([readScene(page), readGameStatus(page)]);
  throw new Error(`Timeout waiting for active VS Battle, scene=${scene} gameStatus=${gameStatus}`);
}

async function readBattleState(page) {
  return page
    .evaluate(() => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (!mod) return { unavailable: true, frame: 0, scene: null, gameStatus: null, active: false };
      const frame = mod._kn_get_frame?.() ?? window.KNState?.frameNum ?? 0;
      let scene = null;
      if (typeof mod._kn_get_scene_curr === 'function') {
        scene = mod._kn_get_scene_curr();
      } else if (mod._kn_get_rdram_ptr && mod.HEAPU8) {
        scene = mod.HEAPU8[mod._kn_get_rdram_ptr() + (0xa4ad0 ^ 3)] ?? null;
      }
      let gameStatus = null;
      if (mod._kn_get_rdram_ptr && mod.HEAPU32) {
        const ptr = mod._kn_get_rdram_ptr();
        gameStatus = (mod.HEAPU32[(ptr + 0xa4d18) >> 2] >>> 16) & 0xff;
      }
      return {
        unavailable: false,
        frame,
        scene,
        gameStatus,
        active: scene === 22 && gameStatus === 1,
      };
    })
    .catch(() => ({ unavailable: true, frame: 0, scene: null, gameStatus: null, active: false }));
}

async function readBothBattleStates(host, guest) {
  const [hostState, guestState] = await Promise.all([readBattleState(host.page), readBattleState(guest.page)]);
  return { host: hostState, guest: guestState };
}

function formatBattleState(state) {
  return (
    `host(scene=${state.host.scene},status=${state.host.gameStatus},f=${state.host.frame},active=${state.host.active}) ` +
    `guest(scene=${state.guest.scene},status=${state.guest.gameStatus},f=${state.guest.frame},active=${state.guest.active})`
  );
}

async function resolveBattleEnd(host, guest, initialState, label, graceMs = 5000) {
  let state = initialState;
  const start = Date.now();
  while (Date.now() - start < graceMs) {
    if (state.host.unavailable || state.guest.unavailable) {
      throw new Error(`${label}: page unavailable while checking battle end — ${formatBattleState(state)}`);
    }
    if (!state.host.active && !state.guest.active) {
      return {
        label,
        reason: 'both-peers-left-active-vs-battle',
        elapsedGraceMs: Date.now() - start,
        host: state.host,
        guest: state.guest,
      };
    }
    if (state.host.active && state.guest.active) return null;
    await host.page.waitForTimeout(100);
    state = await readBothBattleStates(host, guest);
  }
  throw new Error(`${label}: asymmetric battle end after ${graceMs}ms — ${formatBattleState(state)}`);
}

async function waitForAnyScene(page, targetScenes, timeoutMs = 60000, pollMs = 50) {
  const targets = new Set(targetScenes);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const cur = await readScene(page);
    if (targets.has(cur)) return cur;
    await page.waitForTimeout(pollMs);
  }
  const cur = await readScene(page);
  throw new Error(`Timeout waiting for scenes ${[...targets].join(',')}, current=${cur}`);
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
  console.log(`    [scene ${targetScene} ${label}: host f=${hf} guest f=${gf}]`);
}

/* Sample the live gameplay_addrs values from a page via the WASM
 * export `kn_live_gameplay_addr_dump`. Returns a Uint8Array of
 * KN_GAMEPLAY_ADDR_COUNT × 4 bytes (each addr's first 4 bytes) — or
 * null if the export isn't ready. This is the same data that goes
 * into the rb-check hash; here we fetch it raw so we can diff per-
 * field cross-peer instead of relying on a single scalar hash. */
async function sampleGameplayFields(page) {
  return page
    .evaluate(() => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (!mod?._kn_live_gameplay_addr_dump || !mod?._malloc) return null;
      if (!window._gpFieldsBufPtr) window._gpFieldsBufPtr = mod._malloc(256);
      const n = mod._kn_live_gameplay_addr_dump(window._gpFieldsBufPtr, 256);
      if (n <= 0) return null;
      const arr = new Uint8Array(mod.HEAPU8.buffer, window._gpFieldsBufPtr, n * 4);
      return Array.from(arr);
    })
    .catch(() => null);
}

/* Direct cross-peer state-diff check. Compares the gameplay_addrs
 * byte dump on host vs guest at roughly the same wall-clock moment.
 * 2026-04-24 learning: SSIM alone is unreliable (stayed at 0.94 while
 * motion_count differed by 14 events cross-peer), and the hash is just
 * an FNV folding of these bytes. Looking at the raw per-field bytes
 * tells us EXACTLY which address diverged — no hash collision risk,
 * no pollution from mislabeled entries. */
async function checkStateDrift(host, guest) {
  const [h, g] = await Promise.all([sampleGameplayFields(host), sampleGameplayFields(guest)]);
  if (!h || !g || h.length !== g.length) return null;
  const diffs = [];
  for (let i = 0; i < h.length; i += 4) {
    if (h[i] !== g[i] || h[i + 1] !== g[i + 1] || h[i + 2] !== g[i + 2] || h[i + 3] !== g[i + 3]) {
      diffs.push({
        idx: i / 4,
        host: (h[i] | (h[i + 1] << 8) | (h[i + 2] << 16) | (h[i + 3] << 24)) >>> 0,
        guest: (g[i] | (g[i + 1] << 8) | (g[i + 2] << 16) | (g[i + 3] << 24)) >>> 0,
      });
    }
  }
  return diffs;
}

async function sampleMatchSetup(page) {
  return page
    .evaluate(() => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (!mod) return null;

      const call = (name, ...args) => {
        try {
          return typeof mod[name] === 'function' ? mod[name](...args) >>> 0 : null;
        } catch {
          return null;
        }
      };
      const frame = window.KNState?.frameNum || call('_kn_get_frame') || 0;
      const readU32Array = (fnName, count, ...args) => {
        if (!mod._malloc || !mod._free || !mod.HEAPU32 || typeof mod[fnName] !== 'function') return null;
        const ptrOut = mod._malloc(count * 4);
        try {
          const n = mod[fnName](ptrOut, count, ...args) >>> 0;
          const base = ptrOut >> 2;
          const limit = Math.min(n, count);
          const out = [];
          for (let i = 0; i < limit; i++) out.push(mod.HEAPU32[base + i] >>> 0);
          return out;
        } catch {
          return null;
        } finally {
          mod._free(ptrOut);
        }
      };
      const readRegionHashes = () => {
        if (!mod._malloc || !mod._free || !mod.HEAPU32 || typeof mod._kn_sync_hash_regions !== 'function') return null;
        const count = 12;
        const ptrOut = mod._malloc(count * 4);
        try {
          const n = mod._kn_sync_hash_regions(ptrOut, count) >>> 0;
          const base = ptrOut >> 2;
          const regions = [
            '0x0a4000',
            '0x0ba000',
            '0x0bf000',
            '0x0c4000',
            '0x262000',
            '0x266000',
            '0x26a000',
            '0x290000',
            '0x2f6000',
            '0x32b000',
            '0x330000',
            '0x335000',
          ];
          const out = {};
          for (let i = 0; i < Math.min(n, count); i++) out[regions[i] || String(i)] = mod.HEAPU32[base + i] >>> 0;
          return out;
        } catch {
          return null;
        } finally {
          mod._free(ptrOut);
        }
      };
      const out = {
        frame,
        scene: null,
        hashes: {
          match_phase: call('_kn_hash_match_phase', -1),
          vs_battle_hdr: call('_kn_hash_vs_battle_hdr', -1),
          rng: call('_kn_hash_rng', -1),
          sync: call('_kn_sync_hash'),
          event_queue: call('_kn_eventqueue_hash'),
          gameplay: call('_kn_gameplay_hash', -1),
          game_state: call('_kn_game_state_hash', -1),
          full_state: call('_kn_full_state_hash', -1),
          softfloat: call('_kn_get_softfloat_state'),
          hidden: call('_kn_get_hidden_state_fingerprint'),
          sync_regions: readRegionHashes(),
          event_queue_dump: readU32Array('_kn_eventqueue_dump', 64),
          rdram_blocks: readU32Array('_kn_rdram_block_hashes', 128),
        },
        rdramReady: false,
        battle: null,
        players: [],
      };

      const ptr = call('_kn_get_rdram_ptr');
      if (ptr === null || !mod.HEAPU8) return out;
      out.rdramReady = true;

      const KN_ADDR_VS_BATTLE_HEADER = 0xa4ef8;
      const KN_ADDR_VS_MENU_STATE = 0xa4d08;
      const KN_ADDR_SCENE_CURR = 0xa4ad0;
      const KN_ADDR_P1_CSS_BASE = 0x13ba88;
      const KN_CSS_STRIDE = 0xbc;
      const KN_CSS_OFF_CHAR_ID = 0x48;
      const KN_CSS_OFF_CURSOR_STATE = 0x54;
      const KN_CSS_OFF_SELECTED_FLAG = 0x58;
      const KN_CSS_OFF_PANEL_STATE = 0x84;
      const KN_PLAYER_STRIDE = 0x74;
      const heap = mod.HEAPU8;
      const u8 = (off) => heap[ptr + off] ?? null;
      const s8 = (off) => {
        const v = u8(off);
        return v === null ? null : v & 0x80 ? v - 0x100 : v;
      };
      const u32be = (off) => {
        const b0 = u8(off),
          b1 = u8(off + 1),
          b2 = u8(off + 2),
          b3 = u8(off + 3);
        if (b0 === null || b1 === null || b2 === null || b3 === null) return null;
        return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
      };
      out.scene = u8(KN_ADDR_SCENE_CURR ^ 3);
      out.netplayGameStatus = (mod.HEAPU32[(ptr + 0xa4d18) >> 2] >>> 16) & 0xff;

      out.battle = {
        game_type: u8(KN_ADDR_VS_BATTLE_HEADER + 0),
        gkind: u8(KN_ADDR_VS_BATTLE_HEADER + 1),
        is_team_battle: u8(KN_ADDR_VS_BATTLE_HEADER + 2),
        game_rules: u8(KN_ADDR_VS_BATTLE_HEADER + 3),
        pl_count: u8(KN_ADDR_VS_BATTLE_HEADER + 4),
        cp_count: u8(KN_ADDR_VS_BATTLE_HEADER + 5),
        time_limit: u8(KN_ADDR_VS_BATTLE_HEADER + 6),
        stocks: u8(KN_ADDR_VS_BATTLE_HEADER + 7),
        handicap: u8(KN_ADDR_VS_BATTLE_HEADER + 8),
        is_team_attack: u8(KN_ADDR_VS_BATTLE_HEADER + 9),
        is_stage_select: u8(KN_ADDR_VS_BATTLE_HEADER + 10),
        damage_ratio: u8(KN_ADDR_VS_BATTLE_HEADER + 11),
        item_toggles: u32be(KN_ADDR_VS_BATTLE_HEADER + 12),
        is_reset_players: u8(KN_ADDR_VS_BATTLE_HEADER + 16),
        game_status: u8(KN_ADDR_VS_BATTLE_HEADER + 17),
        time_remain: u32be(KN_ADDR_VS_BATTLE_HEADER + 20),
        time_passed: u32be(KN_ADDR_VS_BATTLE_HEADER + 24),
        item_appearance_rate: u8(KN_ADDR_VS_BATTLE_HEADER + 28),
      };
      out.menu = {
        game_type: u8(KN_ADDR_VS_MENU_STATE + 0),
        gkind: u8(KN_ADDR_VS_MENU_STATE + 1),
        is_team_battle: u8(KN_ADDR_VS_MENU_STATE + 2),
        game_rules: u8(KN_ADDR_VS_MENU_STATE + 3),
        pl_count: u8(KN_ADDR_VS_MENU_STATE + 4),
        cp_count: u8(KN_ADDR_VS_MENU_STATE + 5),
        time_limit: u8(KN_ADDR_VS_MENU_STATE + 6),
        stocks: u8(KN_ADDR_VS_MENU_STATE + 7),
        handicap: u8(KN_ADDR_VS_MENU_STATE + 8),
        is_team_attack: u8(KN_ADDR_VS_MENU_STATE + 9),
        is_stage_select: u8(KN_ADDR_VS_MENU_STATE + 10),
        damage_ratio: u8(KN_ADDR_VS_MENU_STATE + 11),
        item_toggles: u32be(KN_ADDR_VS_MENU_STATE + 12),
        is_reset_players: u8(KN_ADDR_VS_MENU_STATE + 16),
        game_status: u8(KN_ADDR_VS_MENU_STATE + 17),
        time_remain: u32be(KN_ADDR_VS_MENU_STATE + 20),
        time_passed: u32be(KN_ADDR_VS_MENU_STATE + 24),
        item_appearance_rate: u8(KN_ADDR_VS_MENU_STATE + 28),
      };
      out.menuPlayers = [];

      for (let p = 0; p < 4; p++) {
        const cssBase = KN_ADDR_P1_CSS_BASE + p * KN_CSS_STRIDE;
        const battleBase = KN_ADDR_VS_BATTLE_HEADER + 0x20 + p * KN_PLAYER_STRIDE;
        const menuBase = KN_ADDR_VS_MENU_STATE + 0x20 + p * KN_PLAYER_STRIDE;
        out.players.push({
          slot: p,
          battle_level: u8(battleBase + 0),
          battle_handicap: u8(battleBase + 1),
          battle_pkind: u8(battleBase + 2),
          battle_fkind: u8(battleBase + 3),
          battle_team: u8(battleBase + 4),
          battle_player: u8(battleBase + 5),
          battle_costume: u8(battleBase + 6),
          battle_stock_count: s8(battleBase + 0x0b),
          css_char_id: u32be(cssBase + KN_CSS_OFF_CHAR_ID),
          css_cursor_state: u32be(cssBase + KN_CSS_OFF_CURSOR_STATE),
          css_selected_flag: u32be(cssBase + KN_CSS_OFF_SELECTED_FLAG),
          css_panel_state: u32be(cssBase + KN_CSS_OFF_PANEL_STATE),
          hashes: {
            character_id: call('_kn_hash_character_id', p, -1),
            css_selected: call('_kn_hash_css_selected', p, -1),
            stocks: call('_kn_hash_stocks', p, -1),
          },
        });
        out.menuPlayers.push({
          slot: p,
          level: u8(menuBase + 0),
          handicap: u8(menuBase + 1),
          pkind: u8(menuBase + 2),
          fkind: u8(menuBase + 3),
          team: u8(menuBase + 4),
          player: u8(menuBase + 5),
          costume: u8(menuBase + 6),
          stock_count: s8(menuBase + 0x0b),
        });
      }

      return out;
    })
    .catch(() => null);
}

function cssSlotSelected(player) {
  if (!player) return false;
  const flagSelected = Number.isFinite(player.css_selected_flag) && player.css_selected_flag !== 0;
  return flagSelected;
}

function cssSlotRandomSelected(player) {
  return cssSlotSelected(player) && player.css_char_id >>> 0 === CSS_RANDOM_CHAR_ID;
}

async function waitForCssSlotSelected(page, slot, label, timeoutMs = 30000, predicate = cssSlotSelected) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await sampleMatchSetup(page);
    if (predicate(last?.players?.[slot])) {
      console.log(`    ${label}: P${slot + 1} selected ${JSON.stringify(last.players[slot])}`);
      return last;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`${label}: P${slot + 1} did not become selected; last=${JSON.stringify(last)}`);
}

async function ensureCssRandomSelected(inputPage, viewPage, slot, label, timeoutMs = 30000) {
  const start = Date.now();
  const attempts = [
    { key: KEY.ANA_LEFT, value: 5000, holdMs: 80 },
    { key: KEY.ANA_LEFT, value: 7000, holdMs: 80 },
    { key: KEY.ANA_LEFT, value: 9000, holdMs: 70 },
    { key: KEY.ANA_RIGHT, value: 5000, holdMs: 80 },
    { key: KEY.ANA_RIGHT, value: 7000, holdMs: 80 },
    { key: KEY.ANA_UP, value: 7000, holdMs: 80 },
    { key: KEY.ANA_DOWN, value: 7000, holdMs: 80 },
  ];
  let last = await sampleMatchSetup(viewPage);
  if (cssSlotRandomSelected(last?.players?.[slot])) {
    console.log(`    ${label}: P${slot + 1} selected ${JSON.stringify(last.players[slot])}`);
    return last;
  }
  if (last?.players?.[slot]?.css_char_id >>> 0 === CSS_RANDOM_CHAR_ID) {
    await press(inputPage, KEY.A, 260);
    return waitForCssSlotSelected(
      viewPage,
      slot,
      label,
      Math.max(1000, timeoutMs - (Date.now() - start)),
      cssSlotRandomSelected,
    );
  }
  for (const attempt of attempts) {
    if (Date.now() - start >= timeoutMs) break;
    await pulseSyntheticInput(inputPage, attempt.key, attempt.value, attempt.holdMs);
    last = await sampleMatchSetup(viewPage);
    const player = last?.players?.[slot];
    console.log(
      `    ${label}: P${slot + 1} hover after ${attempt.key}/${attempt.value} ` +
        `char=0x${((player?.css_char_id ?? 0) >>> 0).toString(16)} selected=0x${((player?.css_selected_flag ?? 0) >>> 0).toString(16)}`,
    );
    if (cssSlotSelected(player) && !cssSlotRandomSelected(player)) {
      throw new Error(`${label}: P${slot + 1} selected non-random char; player=${JSON.stringify(player)}`);
    }
    if (player?.css_char_id >>> 0 === CSS_RANDOM_CHAR_ID) {
      await press(inputPage, KEY.A, 260);
      const remaining = Math.max(1000, Math.min(3000, timeoutMs - (Date.now() - start)));
      return waitForCssSlotSelected(viewPage, slot, label, remaining, cssSlotRandomSelected);
    }
  }
  throw new Error(`${label}: P${slot + 1} did not select RANDOM; last=${JSON.stringify(last)}`);
}

async function sampleHashHistory(page, depth = 600) {
  return page
    .evaluate((requestedDepth) => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (!mod?._malloc || !mod?._free || !mod?.HEAPU32) return null;
      const frame = mod._kn_get_frame?.() ?? (window.KNState?.frameNum || 0);
      const count = Math.max(1, Math.min(600, requestedDepth | 0));
      const ptr = mod._malloc(count * 2 * 4);
      const read = (name, ...prefixArgs) => {
        if (typeof mod[name] !== 'function') return null;
        try {
          const n = mod[name](...prefixArgs, count, ptr) >>> 0;
          const out = [];
          const base = ptr >> 2;
          for (let i = 0; i < n; i++) {
            const f = mod.HEAPU32[base + i * 2] >>> 0;
            const hash = mod.HEAPU32[base + i * 2 + 1] >>> 0;
            if (f !== 0 || hash !== 0) out.push([f, hash]);
          }
          return out;
        } catch {
          return null;
        }
      };
      const fields = {
        rng: read('_kn_hash_history_rng'),
        match_phase: read('_kn_hash_history_match_phase'),
        vs_battle_hdr: read('_kn_hash_history_vs_battle_hdr'),
        physics_motion: read('_kn_hash_history_physics_motion'),
        ft_buffer: read('_kn_hash_history_ft_buffer'),
      };
      for (let p = 0; p < 4; p++) {
        fields[`p${p}.stocks`] = read('_kn_hash_history_stocks', p);
        fields[`p${p}.character_id`] = read('_kn_hash_history_character_id', p);
        fields[`p${p}.css_cursor`] = read('_kn_hash_history_css_cursor', p);
        fields[`p${p}.css_selected`] = read('_kn_hash_history_css_selected', p);
      }
      mod._free(ptr);
      return { frame, fields };
    }, depth)
    .catch(() => null);
}

function findHashHistoryDiffs(hostHistory, guestHistory, limit = 16) {
  if (!hostHistory?.fields || !guestHistory?.fields) return [];
  const diffs = [];
  for (const field of Object.keys(hostHistory.fields)) {
    const hPairs = hostHistory.fields[field];
    const gPairs = guestHistory.fields[field];
    if (!Array.isArray(hPairs) || !Array.isArray(gPairs)) continue;
    const h = new Map(hPairs.map(([frame, hash]) => [frame, hash >>> 0]));
    const g = new Map(gPairs.map(([frame, hash]) => [frame, hash >>> 0]));
    const common = [...h.keys()].filter((frame) => g.has(frame)).sort((a, b) => a - b);
    for (const frame of common) {
      const hostHash = h.get(frame) >>> 0;
      const guestHash = g.get(frame) >>> 0;
      if (hostHash !== guestHash) {
        diffs.push({ field, frame, host: hostHash, guest: guestHash });
        break;
      }
    }
  }
  return diffs.sort((a, b) => a.frame - b.frame || a.field.localeCompare(b.field)).slice(0, limit);
}

function compareMatchSetup(hostSetup, guestSetup) {
  if (!hostSetup || !guestSetup) {
    return [{ field: 'setup_sample', host: !!hostSetup, guest: !!guestSetup }];
  }
  if (!hostSetup.rdramReady || !guestSetup.rdramReady) {
    return [{ field: 'rdram_ready', host: hostSetup.rdramReady, guest: guestSetup.rdramReady }];
  }
  const diffs = [];
  const cmp = (field, hostValue, guestValue) => {
    if (hostValue !== guestValue) diffs.push({ field, host: hostValue, guest: guestValue });
  };
  const activeBattle =
    hostSetup.scene === SCENE_VS_BATTLE &&
    guestSetup.scene === SCENE_VS_BATTLE &&
    hostSetup.netplayGameStatus === 1 &&
    guestSetup.netplayGameStatus === 1;

  cmp('scene', hostSetup.scene, guestSetup.scene);
  cmp('netplayGameStatus', hostSetup.netplayGameStatus, guestSetup.netplayGameStatus);
  for (const field of ['match_phase', 'vs_battle_hdr', 'rng']) {
    cmp(`hashes.${field}`, hostSetup.hashes?.[field], guestSetup.hashes?.[field]);
  }
  cmp('scene_expected_vs_battle.host', hostSetup.scene, SCENE_VS_BATTLE);
  cmp('scene_expected_vs_battle.guest', guestSetup.scene, SCENE_VS_BATTLE);
  cmp('game_status_expected_active.host', hostSetup.netplayGameStatus, 1);
  cmp('game_status_expected_active.guest', guestSetup.netplayGameStatus, 1);
  for (const field of [
    'game_type',
    'gkind',
    'game_rules',
    'pl_count',
    'cp_count',
    'time_limit',
    'stocks',
    'handicap',
    'is_team_attack',
    'damage_ratio',
    'item_toggles',
    'item_appearance_rate',
  ]) {
    cmp(`menu.${field}`, hostSetup.menu?.[field], guestSetup.menu?.[field]);
  }
  for (const field of [
    'game_type',
    'gkind',
    'game_rules',
    'pl_count',
    'cp_count',
    'time_limit',
    'stocks',
    'handicap',
    'is_team_attack',
    'damage_ratio',
    'item_toggles',
    'item_appearance_rate',
  ]) {
    cmp(`battle.${field}`, hostSetup.battle?.[field], guestSetup.battle?.[field]);
  }

  for (let p = 0; p < 4; p++) {
    const h = hostSetup.players?.[p] || {};
    const g = guestSetup.players?.[p] || {};
    for (const field of [
      'battle_pkind',
      'battle_fkind',
      'battle_team',
      'battle_player',
      'battle_costume',
      'battle_stock_count',
      'css_char_id',
      'css_selected_flag',
      'css_panel_state',
    ]) {
      cmp(`p${p}.${field}`, h[field], g[field]);
    }
    for (const field of ['character_id', 'css_selected', 'stocks']) {
      cmp(`p${p}.hashes.${field}`, h.hashes?.[field], g.hashes?.[field]);
    }
    if (!activeBattle) {
      const hm = hostSetup.menuPlayers?.[p] || {};
      const gm = guestSetup.menuPlayers?.[p] || {};
      for (const field of ['pkind', 'fkind', 'team', 'player', 'costume', 'stock_count']) {
        cmp(`menuP${p}.${field}`, hm[field], gm[field]);
      }
    }
  }
  return diffs;
}

function compareSetupDiagnostics(hostSetup, guestSetup, limit = 24) {
  if (!hostSetup?.hashes || !guestSetup?.hashes) return [];
  const diffs = [];
  const cmp = (field, hostValue, guestValue) => {
    if (diffs.length >= limit) return;
    if (hostValue !== guestValue) diffs.push({ field, host: hostValue, guest: guestValue });
  };
  for (const field of ['sync', 'event_queue', 'gameplay', 'game_state', 'full_state', 'softfloat', 'hidden']) {
    cmp(`hashes.${field}`, hostSetup.hashes[field], guestSetup.hashes[field]);
  }
  const hostRegions = hostSetup.hashes.sync_regions || {};
  const guestRegions = guestSetup.hashes.sync_regions || {};
  for (const key of new Set([...Object.keys(hostRegions), ...Object.keys(guestRegions)])) {
    cmp(`sync_regions.${key}`, hostRegions[key], guestRegions[key]);
  }
  const hostQueue = hostSetup.hashes.event_queue_dump;
  const guestQueue = guestSetup.hashes.event_queue_dump;
  if (Array.isArray(hostQueue) && Array.isArray(guestQueue)) {
    const n = Math.min(hostQueue.length, guestQueue.length);
    for (let i = 0; i < n && diffs.length < limit; i++) {
      if (hostQueue[i] !== guestQueue[i]) {
        diffs.push({ field: `event_queue_dump.${i}`, host: hostQueue[i], guest: guestQueue[i] });
      }
    }
    if (hostQueue.length !== guestQueue.length && diffs.length < limit) {
      diffs.push({ field: 'event_queue_dump.length', host: hostQueue.length, guest: guestQueue.length });
    }
  }
  const hostBlocks = hostSetup.hashes.rdram_blocks;
  const guestBlocks = guestSetup.hashes.rdram_blocks;
  if (Array.isArray(hostBlocks) && Array.isArray(guestBlocks)) {
    const n = Math.min(hostBlocks.length, guestBlocks.length);
    let mismatchCount = Math.abs(hostBlocks.length - guestBlocks.length);
    let first = null;
    for (let i = 0; i < n; i++) {
      if (hostBlocks[i] === guestBlocks[i]) continue;
      mismatchCount++;
      if (!first) first = { index: i, host: hostBlocks[i], guest: guestBlocks[i] };
      if (diffs.length < limit && diffs.filter((d) => d.field.startsWith('rdram_blocks.')).length < 8) {
        diffs.push({ field: `rdram_blocks.${i}`, host: hostBlocks[i], guest: guestBlocks[i] });
      }
    }
    if (mismatchCount && first && diffs.length < limit) {
      diffs.push({ field: 'rdram_blocks.summary', mismatchCount, first });
    }
  }
  return diffs.slice(0, limit);
}

async function requireMatchSetupAligned(host, guest, label, hostBrowser, guestBrowser) {
  const [hostSetup, guestSetup] = await Promise.all([sampleMatchSetup(host.page), sampleMatchSetup(guest.page)]);
  const diffs = compareMatchSetup(hostSetup, guestSetup);
  const diagnosticDiffs = compareSetupDiagnostics(hostSetup, guestSetup, 32);
  if (diffs.length === 0) {
    console.log(
      `  setup gate OK (${label}): scene=${hostSetup.scene} gameStatus=${hostSetup.netplayGameStatus} menuStage=${hostSetup.menu?.gkind} battleStage=${hostSetup.battle?.gkind} battleChars=${hostSetup.players.map((p) => p.battle_fkind).join(',')}`,
    );
    return { hostSetup, guestSetup, diffs, diagnosticDiffs };
  }

  const report = {
    room: ROOM,
    verdict: 'INVALID_MATCH_SETUP',
    label,
    reason: 'host and guest are not in the same completed VS battle setup before random-input stress',
    first_diffs: diffs.slice(0, 24),
    diagnostic_diffs: diagnosticDiffs,
    page_errors: {
      host: host.pageErrors || [],
      guest: guest.pageErrors || [],
    },
    host: hostSetup,
    guest: guestSetup,
  };
  const [hostHistory, guestHistory] = await Promise.all([sampleHashHistory(host.page), sampleHashHistory(guest.page)]);
  const historyDiffs = findHashHistoryDiffs(hostHistory, guestHistory, 24);
  report.hash_history = {
    hostFrame: hostHistory?.frame ?? null,
    guestFrame: guestHistory?.frame ?? null,
    first_diffs: historyDiffs,
  };
  console.error(`\n❌ MATCH SETUP MISMATCH before random inputs (${label})`);
  console.error(JSON.stringify(report.first_diffs, null, 2));
  if (diagnosticDiffs.length > 0) {
    console.error('First setup diagnostic diffs:');
    console.error(JSON.stringify(diagnosticDiffs.slice(0, 12), null, 2));
  }
  if (historyDiffs.length > 0) {
    console.error('First field-history diffs:');
    console.error(JSON.stringify(historyDiffs, null, 2));
  }
  await Promise.all([
    shot(host.page, `${label}-setup-mismatch-host`),
    shot(guest.page, `${label}-setup-mismatch-guest`),
  ]);
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.error(`Saved invalid setup report to ${REPORT_FILE}`);
  await Promise.allSettled([hostBrowser.close(), guestBrowser.close()]);
  process.exit(1);
}

async function finishSetupOnly(host, guest, hostBrowser, guestBrowser, label, alignment) {
  const visual = await captureAndCompareSetupVisual(host, guest, label).catch((err) => ({
    pass: false,
    error: err.message || String(err),
  }));
  const diagnosticDiffs = compareSetupDiagnostics(alignment.hostSetup, alignment.guestSetup, 32);
  const [hostHistory, guestHistory] = await Promise.all([sampleHashHistory(host.page), sampleHashHistory(guest.page)]);
  const historyDiffs = findHashHistoryDiffs(hostHistory, guestHistory, 32);
  const players = (alignment.hostSetup?.players || []).map((p) => ({
    slot: p.slot,
    battle_pkind: p.battle_pkind,
    battle_fkind: p.battle_fkind,
    css_char_id: p.css_char_id,
    css_selected_flag: p.css_selected_flag,
  }));
  const report = {
    room: ROOM,
    verdict: 'PASS_SETUP_ONLY',
    label,
    reason: 'host and guest reached the same completed VS Battle setup before random-input stress',
    stage: {
      menu: alignment.hostSetup?.menu?.gkind ?? null,
      battle: alignment.hostSetup?.battle?.gkind ?? null,
    },
    visual,
    diagnostic_diffs: diagnosticDiffs,
    hash_history: {
      hostFrame: hostHistory?.frame ?? null,
      guestFrame: guestHistory?.frame ?? null,
      first_diffs: historyDiffs,
    },
    players,
    host: alignment.hostSetup,
    guest: alignment.guestSetup,
    page_errors: {
      host: host.pageErrors || [],
      guest: guest.pageErrors || [],
    },
  };
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  if (!visual.pass) {
    report.verdict = 'SETUP_VISUAL_MISMATCH';
    report.reason =
      'host and guest setup fields matched, but the rendered canvas differed enough to suggest different visible chars/stage';
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.error(
      `\nSETUP-ONLY VISUAL MISMATCH: meanAbs=${visual.comparison?.meanAbs ?? 'n/a'} ` +
        `mismatch=${visual.comparison?.mismatchRatio ?? 'n/a'} ` +
        `strongMismatch=${visual.comparison?.strongMismatchRatio ?? 'n/a'}`,
    );
    if (diagnosticDiffs.length > 0) {
      console.error('First setup diagnostic diffs:');
      console.error(JSON.stringify(diagnosticDiffs.slice(0, 12), null, 2));
    }
    if (historyDiffs.length > 0) {
      console.error('First field-history diffs:');
      console.error(JSON.stringify(historyDiffs.slice(0, 12), null, 2));
    }
    console.error(`Saved setup-only report to ${REPORT_FILE}`);
    if (!KEEP_OPEN) await Promise.allSettled([hostBrowser.close(), guestBrowser.close()]);
    process.exit(1);
  }
  console.log(`\nSETUP-ONLY PASS: stage=${report.stage.battle} chars=${players.map((p) => p.battle_fkind).join(',')}`);
  console.log(
    `Visual setup compare: meanAbs=${visual.comparison.meanAbs} mismatch=${visual.comparison.mismatchRatio} strongMismatch=${visual.comparison.strongMismatchRatio}`,
  );
  if (diagnosticDiffs.length > 0) console.log(`Setup diagnostic diffs: ${JSON.stringify(diagnosticDiffs.slice(0, 8))}`);
  console.log(`Saved setup-only report to ${REPORT_FILE}`);
  if (!KEEP_OPEN) await Promise.allSettled([hostBrowser.close(), guestBrowser.close()]);
}

async function requireBothInVsBattle(host, guest, label, hostBrowser, guestBrowser) {
  try {
    await Promise.all([waitForActiveVsBattle(host.page, 90000, 50), waitForActiveVsBattle(guest.page, 90000, 50)]);
  } catch (err) {
    console.error(`\n❌ ${label}: did not reach active VS Battle before random-input stress — ${err.message}`);
    await requireMatchSetupAligned(host, guest, `${label}-not-in-battle`, hostBrowser, guestBrowser);
    throw err;
  }
}

async function sampleGraphicsInfo(page) {
  return page
    .evaluate(() => {
      const canvas = document.querySelector('canvas#canvas, canvas.ejs_canvas, canvas');
      const rect = canvas?.getBoundingClientRect?.();
      const parentRect = canvas?.parentElement?.getBoundingClientRect?.();
      const styles = canvas ? getComputedStyle(canvas) : null;
      const out = {
        userAgent: navigator.userAgent,
        location: window.location.href,
        devicePixelRatio: window.devicePixelRatio,
        visualViewport: window.visualViewport
          ? {
              width: window.visualViewport.width,
              height: window.visualViewport.height,
              scale: window.visualViewport.scale,
            }
          : null,
        frame: window.KNState?.frameNum || 0,
        scene: window.EJS_emulator?.gameManager?.Module?._kn_get_scene_curr?.() ?? null,
        canvas: canvas
          ? {
              width: canvas.width,
              height: canvas.height,
              clientWidth: canvas.clientWidth,
              clientHeight: canvas.clientHeight,
              rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
              parentRect: parentRect
                ? { x: parentRect.x, y: parentRect.y, width: parentRect.width, height: parentRect.height }
                : null,
              style: styles
                ? {
                    width: styles.width,
                    height: styles.height,
                    imageRendering: styles.imageRendering,
                    transform: styles.transform,
                    objectFit: styles.objectFit,
                  }
                : null,
            }
          : null,
        webgl: null,
        ejs: null,
      };
      try {
        const emulator = window.EJS_emulator;
        out.ejs = {
          core: emulator?.getCore?.() || null,
          forceLegacyCores: window.EJS_forceLegacyCores || false,
          knCoreHash: window._knCoreHash || null,
          coreDataOverride: window.__knCoreDataOverride || null,
          coreDataFetches: window.__knCoreDataFetches || 0,
          defaultOptions: { ...(window.EJS_defaultOptions || {}) },
          coreSettings: emulator?.getCoreSettings?.() || null,
        };
      } catch (err) {
        out.ejs = { error: err.message || String(err) };
      }
      try {
        const gl =
          canvas?.getContext?.('webgl2') || canvas?.getContext?.('webgl') || canvas?.getContext?.('experimental-webgl');
        if (gl) {
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          out.webgl = {
            context: gl instanceof WebGL2RenderingContext ? 'webgl2' : 'webgl',
            drawingBufferWidth: gl.drawingBufferWidth,
            drawingBufferHeight: gl.drawingBufferHeight,
            version: gl.getParameter(gl.VERSION),
            shadingLanguageVersion: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
            vendor: gl.getParameter(gl.VENDOR),
            renderer: gl.getParameter(gl.RENDERER),
            unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
            unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
            attrs: gl.getContextAttributes?.() || null,
            maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
            extensions: gl.getSupportedExtensions?.() || [],
          };
        }
      } catch (err) {
        out.webgl = { error: err.message || String(err) };
      }
      return out;
    })
    .catch((err) => ({ error: err.message || String(err) }));
}

async function sampleCanvasHealth(page) {
  return page
    .evaluate(() => {
      const canvas = document.querySelector('canvas#canvas, canvas.ejs_canvas, canvas');
      const frame = window.KNState?.frameNum || 0;
      const scene = window.EJS_emulator?.gameManager?.Module?._kn_get_scene_curr?.() ?? null;
      if (!canvas) return { ok: false, reason: 'no-canvas', frame, scene };

      const sampleW = 32;
      const sampleH = 24;
      const scratch = document.createElement('canvas');
      scratch.width = sampleW;
      scratch.height = sampleH;
      const ctx = scratch.getContext('2d', { willReadFrequently: true });
      if (!ctx) return { ok: false, reason: 'no-2d-context', frame, scene };

      try {
        ctx.drawImage(canvas, 0, 0, sampleW, sampleH);
        const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let minY = 255;
        let maxY = 0;
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
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        const n = ys.length || 1;
        const meanR = r / n;
        const meanG = g / n;
        const meanB = b / n;
        const brightness = (meanR + meanG + meanB) / 3;
        let variance = 0;
        for (const y of ys) variance += (y - brightness) * (y - brightness);
        const stdev = Math.sqrt(variance / n);
        const solidPale =
          brightness >= 185 &&
          stdev <= 12 &&
          maxY - minY <= 40 &&
          meanR >= 175 &&
          meanG >= 185 &&
          meanB >= 145 &&
          meanG >= meanB + 4;
        return {
          ok: true,
          frame,
          scene,
          canvas: {
            width: canvas.width,
            height: canvas.height,
            clientWidth: canvas.clientWidth,
            clientHeight: canvas.clientHeight,
          },
          mean: { r: Number(meanR.toFixed(1)), g: Number(meanG.toFixed(1)), b: Number(meanB.toFixed(1)) },
          brightness: Number(brightness.toFixed(1)),
          stdev: Number(stdev.toFixed(1)),
          range: Number((maxY - minY).toFixed(1)),
          solidPale,
        };
      } catch (err) {
        return { ok: false, reason: err?.message || String(err), frame, scene };
      }
    })
    .catch((err) => ({ ok: false, reason: err.message || String(err) }));
}

async function sampleVsStartOptionsVisible(page) {
  return page
    .evaluate(() => {
      const canvas = document.querySelector('canvas#canvas, canvas.ejs_canvas, canvas');
      const frame = window.KNState?.frameNum || 0;
      const scene = window.EJS_emulator?.gameManager?.Module?._kn_get_scene_curr?.() ?? null;
      if (!canvas) return { ok: false, reason: 'no-canvas', frame, scene, looksLikeVsStart: false };

      const sx = Math.floor(canvas.width * 0.4);
      const sy = Math.floor(canvas.height * 0.1);
      const sw = Math.floor(canvas.width * 0.4);
      const sh = Math.floor(canvas.height * 0.18);
      const sampleW = 96;
      const sampleH = 40;
      const scratch = document.createElement('canvas');
      scratch.width = sampleW;
      scratch.height = sampleH;
      const ctx = scratch.getContext('2d', { willReadFrequently: true });
      if (!ctx) return { ok: false, reason: 'no-2d-context', frame, scene, looksLikeVsStart: false };

      try {
        ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sampleW, sampleH);
        const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
        let white = 0;
        let neutralBright = 0;
        let bright = 0;
        const n = sampleW * sampleH;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          if (r >= 220 && g >= 220 && b >= 220) white++;
          if (r >= 185 && g >= 185 && b >= 185 && max - min <= 45) neutralBright++;
          if ((r + g + b) / 3 >= 170) bright++;
        }
        const whiteRatio = white / n;
        const neutralBrightRatio = neutralBright / n;
        const brightRatio = bright / n;
        return {
          ok: true,
          frame,
          scene,
          whiteRatio: Number(whiteRatio.toFixed(3)),
          neutralBrightRatio: Number(neutralBrightRatio.toFixed(3)),
          brightRatio: Number(brightRatio.toFixed(3)),
          looksLikeVsStart: whiteRatio >= 0.2 && neutralBrightRatio >= 0.28,
        };
      } catch (err) {
        return { ok: false, reason: err?.message || String(err), frame, scene, looksLikeVsStart: false };
      }
    })
    .catch((err) => ({ ok: false, reason: err.message || String(err), looksLikeVsStart: false }));
}

async function sampleTitleReadyVisible(page) {
  return page
    .evaluate(() => {
      const canvas = document.querySelector('canvas#canvas, canvas.ejs_canvas, canvas');
      const frame = window.KNState?.frameNum || 0;
      const scene = window.EJS_emulator?.gameManager?.Module?._kn_get_scene_curr?.() ?? null;
      if (!canvas) return { ok: false, reason: 'no-canvas', frame, scene, ready: false };

      const sampleW = 96;
      const sampleH = 72;
      const scratch = document.createElement('canvas');
      scratch.width = sampleW;
      scratch.height = sampleH;
      const ctx = scratch.getContext('2d', { willReadFrequently: true });
      if (!ctx) return { ok: false, reason: 'no-2d-context', frame, scene, ready: false };

      try {
        ctx.drawImage(canvas, 0, 0, sampleW, sampleH);
        const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
        let pink = 0;
        let white = 0;
        let bright = 0;
        const n = sampleW * sampleH;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          if (r >= 210 && g <= 175 && b >= 190) pink++;
          if (r >= 220 && g >= 220 && b >= 220) white++;
          if ((r + g + b) / 3 >= 170) bright++;
        }
        const pinkRatio = pink / n;
        const whiteRatio = white / n;
        const brightRatio = bright / n;
        const looksLikeDisclaimer = pinkRatio >= 0.05;
        return {
          ok: true,
          frame,
          scene,
          pinkRatio: Number(pinkRatio.toFixed(3)),
          whiteRatio: Number(whiteRatio.toFixed(3)),
          brightRatio: Number(brightRatio.toFixed(3)),
          looksLikeDisclaimer,
          ready: scene === 1 && !looksLikeDisclaimer,
        };
      } catch (err) {
        return { ok: false, reason: err?.message || String(err), frame, scene, ready: false };
      }
    })
    .catch((err) => ({ ok: false, reason: err.message || String(err), ready: false }));
}

async function sampleRenderedCanvasScreenshot(page) {
  try {
    const canvas = page.locator('canvas#canvas, canvas.ejs_canvas, canvas').first();
    const visible = await canvas.isVisible({ timeout: 2000 }).catch(() => false);
    const buffer = visible
      ? await canvas.screenshot({ timeout: 5000 })
      : await page.screenshot({ fullPage: false, timeout: 5000 });
    const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
    return await page.evaluate(
      async ({ dataUrl, sampleW, sampleH }) => {
        const loadImage = (src) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('screenshot image decode failed'));
            img.src = src;
          });

        const img = await loadImage(dataUrl);
        const scratch = document.createElement('canvas');
        scratch.width = sampleW;
        scratch.height = sampleH;
        const ctx = scratch.getContext('2d', { willReadFrequently: true });
        if (!ctx) return { ok: false, reason: 'no-2d-context' };
        ctx.drawImage(img, 0, 0, sampleW, sampleH);
        const data = ctx.getImageData(0, 0, sampleW, sampleH).data;

        let r = 0;
        let g = 0;
        let b = 0;
        let minY = 255;
        let maxY = 0;
        let palePixels = 0;
        let yellowGreenPixels = 0;
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
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          if (
            rr >= 200 &&
            gg >= 205 &&
            bb >= 175 &&
            gg >= bb + 2 &&
            Math.max(rr, gg, bb) - Math.min(rr, gg, bb) <= 80
          ) {
            palePixels++;
          }
          if (rr >= 145 && gg >= 145 && bb <= 165 && gg >= bb + 18 && Math.abs(rr - gg) <= 55) {
            yellowGreenPixels++;
          }
        }

        const n = ys.length || 1;
        const meanR = r / n;
        const meanG = g / n;
        const meanB = b / n;
        const brightness = (meanR + meanG + meanB) / 3;
        let variance = 0;
        for (const y of ys) variance += (y - brightness) * (y - brightness);
        const stdev = Math.sqrt(variance / n);
        const range = maxY - minY;
        const paleRatio = palePixels / n;
        const yellowGreenRatio = yellowGreenPixels / n;
        const solidPale =
          brightness >= 130 &&
          stdev <= 24 &&
          range <= 75 &&
          (paleRatio >= 0.78 || yellowGreenRatio >= 0.82) &&
          meanG >= meanB + 8;

        return {
          ok: true,
          source: visible ? 'canvas-screenshot' : 'page-screenshot',
          image: { width: img.naturalWidth, height: img.naturalHeight },
          mean: { r: Number(meanR.toFixed(1)), g: Number(meanG.toFixed(1)), b: Number(meanB.toFixed(1)) },
          brightness: Number(brightness.toFixed(1)),
          stdev: Number(stdev.toFixed(1)),
          range: Number(range.toFixed(1)),
          paleRatio: Number(paleRatio.toFixed(3)),
          yellowGreenRatio: Number(yellowGreenRatio.toFixed(3)),
          solidPale,
        };
      },
      { dataUrl, sampleW: RENDERED_CANVAS_SAMPLE_W, sampleH: RENDERED_CANVAS_SAMPLE_H },
    );
  } catch (err) {
    return { ok: false, reason: err.message || String(err) };
  }
}

async function captureCanvasScreenshotBuffer(page) {
  const canvas = page.locator('canvas#canvas, canvas.ejs_canvas, canvas').first();
  const visible = await canvas.isVisible({ timeout: 2000 }).catch(() => false);
  return visible ? canvas.screenshot({ timeout: 5000 }) : page.screenshot({ fullPage: false, timeout: 5000 });
}

async function compareImageBuffers(page, hostBuffer, guestBuffer) {
  return page.evaluate(
    async ({ hostPng, guestPng }) => {
      const loadImage = (src) =>
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error('screenshot image decode failed'));
          img.src = src;
        });

      const [hostImg, guestImg] = await Promise.all([
        loadImage(`data:image/png;base64,${hostPng}`),
        loadImage(`data:image/png;base64,${guestPng}`),
      ]);
      const sampleW = 320;
      const sampleH = 240;
      const draw = (img) => {
        const source = document.createElement('canvas');
        source.width = Math.max(1, img.naturalWidth || img.width || sampleW);
        source.height = Math.max(1, img.naturalHeight || img.height || sampleH);
        const sourceCtx = source.getContext('2d', { willReadFrequently: true });
        if (!sourceCtx) throw new Error('no-2d-context');
        sourceCtx.drawImage(img, 0, 0, source.width, source.height);
        const sourceData = sourceCtx.getImageData(0, 0, source.width, source.height).data;
        let minX = source.width;
        let minY = source.height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < source.height; y++) {
          for (let x = 0; x < source.width; x++) {
            const i = (y * source.width + x) * 4;
            const r = sourceData[i];
            const g = sourceData[i + 1];
            const b = sourceData[i + 2];
            const a = sourceData[i + 3];
            if (a > 8 && r + g + b > 18) {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
            }
          }
        }
        let sx = 0;
        let sy = 0;
        let sw = source.width;
        let sh = source.height;
        if (maxX >= minX && maxY >= minY) {
          const margin = Math.max(4, Math.round(Math.max(maxX - minX + 1, maxY - minY + 1) * 0.03));
          sx = Math.max(0, minX - margin);
          sy = Math.max(0, minY - margin);
          sw = Math.min(source.width - sx, maxX - minX + 1 + margin * 2);
          sh = Math.min(source.height - sy, maxY - minY + 1 + margin * 2);
        }
        const scratch = document.createElement('canvas');
        scratch.width = sampleW;
        scratch.height = sampleH;
        const ctx = scratch.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('no-2d-context');
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, sampleW, sampleH);
        ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sampleW, sampleH);
        return {
          data: ctx.getImageData(0, 0, sampleW, sampleH).data,
          crop: { x: sx, y: sy, width: sw, height: sh },
        };
      };
      const hostDraw = draw(hostImg);
      const guestDraw = draw(guestImg);
      const a = hostDraw.data;
      const b = guestDraw.data;
      let sumAbs = 0;
      let sumSq = 0;
      let mismatch = 0;
      let strongMismatch = 0;
      const pixels = sampleW * sampleH;
      for (let i = 0; i < a.length; i += 4) {
        const dr = Math.abs(a[i] - b[i]);
        const dg = Math.abs(a[i + 1] - b[i + 1]);
        const db = Math.abs(a[i + 2] - b[i + 2]);
        const d = (dr + dg + db) / 3;
        sumAbs += d;
        sumSq += d * d;
        if (d > 30) mismatch++;
        if (d > 90) strongMismatch++;
      }
      return {
        ok: true,
        hostImage: { width: hostImg.naturalWidth, height: hostImg.naturalHeight },
        guestImage: { width: guestImg.naturalWidth, height: guestImg.naturalHeight },
        crop: { host: hostDraw.crop, guest: guestDraw.crop },
        sample: { width: sampleW, height: sampleH },
        meanAbs: Number((sumAbs / pixels).toFixed(2)),
        rmse: Number(Math.sqrt(sumSq / pixels).toFixed(2)),
        mismatchRatio: Number((mismatch / pixels).toFixed(4)),
        strongMismatchRatio: Number((strongMismatch / pixels).toFixed(4)),
      };
    },
    {
      hostPng: hostBuffer.toString('base64'),
      guestPng: guestBuffer.toString('base64'),
    },
  );
}

async function captureAndCompareSetupVisual(host, guest, label) {
  const hostPath = `${SHOT_DIR}/det-${label}-setup-canvas-host.png`;
  const guestPath = `${SHOT_DIR}/det-${label}-setup-canvas-guest.png`;
  const [hostBuffer, guestBuffer] = await Promise.all([
    captureCanvasScreenshotBuffer(host.page),
    captureCanvasScreenshotBuffer(guest.page),
  ]);
  writeFileSync(hostPath, hostBuffer);
  writeFileSync(guestPath, guestBuffer);
  const comparison = await compareImageBuffers(host.page, hostBuffer, guestBuffer);
  const pass =
    comparison.ok &&
    comparison.meanAbs <= SETUP_VISUAL_MEAN_ABS_LIMIT &&
    comparison.mismatchRatio <= SETUP_VISUAL_MISMATCH_RATIO_LIMIT &&
    comparison.strongMismatchRatio <= SETUP_VISUAL_STRONG_MISMATCH_LIMIT;
  return {
    pass,
    screenshots: { host: hostPath, guest: guestPath },
    limits: {
      meanAbs: SETUP_VISUAL_MEAN_ABS_LIMIT,
      mismatchRatio: SETUP_VISUAL_MISMATCH_RATIO_LIMIT,
      strongMismatchRatio: SETUP_VISUAL_STRONG_MISMATCH_LIMIT,
    },
    comparison,
  };
}

async function samplePageForensics(peer) {
  const [canvasHealth, renderedCanvasHealth, graphics, runtime, setup, pageState] = await Promise.all([
    sampleCanvasHealth(peer.page),
    sampleRenderedCanvasScreenshot(peer.page),
    sampleGraphicsInfo(peer.page),
    sampleRuntimeStats(peer.page),
    sampleMatchSetup(peer.page).catch((err) => ({ error: err.message || String(err) })),
    peer.page
      .evaluate(() => {
        const mod = window.EJS_emulator?.gameManager?.Module;
        const safeCall = (fn, fallback = null) => {
          try {
            return typeof fn === 'function' ? fn() : fallback;
          } catch (err) {
            return { error: err?.message || String(err) };
          }
        };
        const syncLog = safeCall(() => window.NetplayLockstep?.exportSyncLog?.(), []);
        const debugLog = safeCall(() => window.NetplayLockstep?.getDebugLog?.(), []);
        const diagLog = Array.isArray(window.KNDiag?.eventLog) ? window.KNDiag.eventLog.slice(-200) : [];
        return {
          url: location.href,
          title: document.title,
          visibility: {
            hidden: document.hidden,
            visibilityState: document.visibilityState,
            hasFocus: document.hasFocus?.() ?? null,
          },
          viewport: {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
            visualViewport: window.visualViewport
              ? {
                  width: window.visualViewport.width,
                  height: window.visualViewport.height,
                  scale: window.visualViewport.scale,
                }
              : null,
          },
          ejs: {
            exists: !!window.EJS_emulator,
            paused: !!window.EJS_emulator?.paused,
            started: !!window.EJS_emulator?.started,
            core: safeCall(() => window.EJS_emulator?.getCore?.(), null),
            gameManager: {
              exists: !!window.EJS_emulator?.gameManager,
              hasModule: !!mod,
            },
            menuVisible: !!(
              window.EJS_emulator?.elements?.menu &&
              !window.EJS_emulator.elements.menu.classList.contains('ejs_menu_bar_hidden')
            ),
          },
          knState: {
            frameNum: window.KNState?.frameNum ?? null,
            slot: window.KNState?.slot ?? null,
            room: window.KNState?.room ?? null,
            matchId: window.KNState?.matchId ?? null,
            peers: Object.values(window.KNState?.peers || {}).map((p) => ({
              slot: p.slot,
              dc: p.dc?.readyState || null,
              rbDc: p.rbDc?.readyState || null,
              pc: p.pc?.connectionState || null,
            })),
          },
          module: mod
            ? {
                frame: safeCall(() => mod._kn_get_frame?.(), null),
                scene: safeCall(() => mod._kn_get_scene_curr?.(), null),
                audioSamples: safeCall(() => mod._kn_get_audio_samples?.(), null),
                audioPtr: safeCall(() => mod._kn_get_audio_ptr?.(), null),
                audioRate: safeCall(() => mod._kn_get_audio_rate?.(), null),
                skipAudioOutput: safeCall(() => mod._kn_get_skip_audio_output?.(), null),
                deterministic: safeCall(() => mod._kn_get_deterministic?.(), null),
                rollbackFrame: safeCall(() => mod._kn_get_frame?.(), null),
                rollbackCount: safeCall(() => mod._kn_get_rollback_count?.(), null),
                replayDepth: safeCall(() => mod._kn_get_replay_depth?.(), null),
                failedRollbacks: safeCall(() => mod._kn_get_failed_rollbacks?.(), null),
                alContexts: mod.AL?.contexts ? Object.keys(mod.AL.contexts) : null,
              }
            : null,
          lockstep: {
            info: safeCall(() => window.NetplayLockstep?.getInfo?.(), null),
            debugState: safeCall(() => window.NetplayLockstep?.getDebugState?.(), null),
            rollbackStats: safeCall(() => window.NetplayLockstep?.getRollbackStats?.(), null),
          },
          logs: {
            syncTail: Array.isArray(syncLog) ? syncLog.slice(-350) : syncLog,
            debugTail: Array.isArray(debugLog) ? debugLog.slice(-250) : debugLog,
            diagTail: diagLog,
          },
          desyncSuspects: Array.isArray(window._knDesyncSuspects) ? window._knDesyncSuspects.slice(-50) : [],
        };
      })
      .catch((err) => ({ error: err.message || String(err) })),
  ]);

  return {
    name: peer.name,
    canvasHealth,
    renderedCanvasHealth,
    graphics,
    runtime,
    setup,
    pageState,
    clientEvents: peer.clientEvents?.slice(-250) || [],
    pageErrors: peer.pageErrors?.slice(-50) || [],
  };
}

async function requireNoSolidPaleCanvas(host, guest, label, hostBrowser, guestBrowser) {
  let lastHost = null;
  let lastGuest = null;
  let lastHostRendered = null;
  let lastGuestRendered = null;
  const attempts = [];
  for (let attempt = 1; attempt <= YELLOW_SCREEN_SAMPLE_ATTEMPTS; attempt++) {
    [lastHost, lastGuest, lastHostRendered, lastGuestRendered] = await Promise.all([
      sampleCanvasHealth(host.page),
      sampleCanvasHealth(guest.page),
      sampleRenderedCanvasScreenshot(host.page),
      sampleRenderedCanvasScreenshot(guest.page),
    ]);
    attempts.push({
      attempt,
      host: lastHost,
      guest: lastGuest,
      hostRendered: lastHostRendered,
      guestRendered: lastGuestRendered,
      sampledAt: new Date().toISOString(),
    });
    if (
      !lastHost?.solidPale &&
      !lastGuest?.solidPale &&
      !lastHostRendered?.solidPale &&
      !lastGuestRendered?.solidPale
    ) {
      return {
        host: lastHost,
        guest: lastGuest,
        hostRendered: lastHostRendered,
        guestRendered: lastGuestRendered,
      };
    }
    if (attempt < YELLOW_SCREEN_SAMPLE_ATTEMPTS) {
      await Promise.all([
        host.page.waitForTimeout(YELLOW_SCREEN_SAMPLE_DELAY_MS).catch(() => {}),
        guest.page.waitForTimeout(YELLOW_SCREEN_SAMPLE_DELAY_MS).catch(() => {}),
      ]);
    }
  }

  const [hostForensics, guestForensics] = await Promise.all([samplePageForensics(host), samplePageForensics(guest)]);
  const canvasShotPaths = {
    host: `${SHOT_DIR}/det-${label}-solid-pale-host.png`,
    guest: `${SHOT_DIR}/det-${label}-solid-pale-guest.png`,
    hostFull: `${SHOT_DIR}/det-${label}-solid-pale-full-host.png`,
    guestFull: `${SHOT_DIR}/det-${label}-solid-pale-full-guest.png`,
  };
  const report = {
    room: ROOM,
    verdict: 'SOLID_PALE_CANVAS',
    label,
    reason: 'emulator canvas or rendered canvas screenshot stayed nearly uniform pale/yellow after startup',
    attempts,
    screenshots: canvasShotPaths,
    host: hostForensics,
    guest: guestForensics,
    page_errors: {
      host: host.pageErrors || [],
      guest: guest.pageErrors || [],
    },
  };
  console.error(`\n❌ ${label}: solid pale/yellow canvas guard tripped`);
  console.error(
    JSON.stringify(
      { host: lastHost, guest: lastGuest, hostRendered: lastHostRendered, guestRendered: lastGuestRendered },
      null,
      2,
    ),
  );
  await Promise.all([
    shot(host.page, `${label}-solid-pale-host`, { canvas: true }),
    shot(guest.page, `${label}-solid-pale-guest`, { canvas: true }),
    shot(host.page, `${label}-solid-pale-full-host`),
    shot(guest.page, `${label}-solid-pale-full-guest`),
  ]);
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.error(`Saved solid pale canvas report to ${REPORT_FILE}`);
  await Promise.allSettled([hostBrowser.close(), guestBrowser.close()]);
  process.exit(1);
}

async function writeBootTimeoutReport(host, guest, label, err) {
  const safeForensics = async (peer) => {
    try {
      return await samplePageForensics(peer);
    } catch (forensicsErr) {
      return {
        name: peer.name,
        error: forensicsErr.message || String(forensicsErr),
        pageErrors: peer.pageErrors?.slice(-50) || [],
        clientEvents: peer.clientEvents?.slice(-250) || [],
      };
    }
  };
  const safeBootState = async (peer) => {
    try {
      return await bootState(peer.page);
    } catch (bootErr) {
      return { error: bootErr.message || String(bootErr) };
    }
  };
  const [hostState, guestState, hostForensics, guestForensics] = await Promise.all([
    safeBootState(host),
    safeBootState(guest),
    safeForensics(host),
    safeForensics(guest),
  ]);
  const screenshots = {
    host: `${SHOT_DIR}/det-${label}-host.png`,
    guest: `${SHOT_DIR}/det-${label}-guest.png`,
    hostFull: `${SHOT_DIR}/det-${label}-full-host.png`,
    guestFull: `${SHOT_DIR}/det-${label}-full-guest.png`,
  };
  await Promise.allSettled([
    shot(host.page, `${label}-host`, { canvas: true }),
    shot(guest.page, `${label}-guest`, { canvas: true }),
    shot(host.page, `${label}-full-host`),
    shot(guest.page, `${label}-full-guest`),
  ]);
  const report = {
    room: ROOM,
    verdict: 'BOOT_TICK_TIMEOUT',
    label,
    reason: 'one or both emulators did not begin ticking after boot prompts',
    error: err?.stack || err?.message || String(err),
    screenshots,
    bootState: { host: hostState, guest: guestState },
    host: hostForensics,
    guest: guestForensics,
    page_errors: {
      host: host.pageErrors || [],
      guest: guest.pageErrors || [],
    },
  };
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.error(`Saved boot-timeout report to ${REPORT_FILE}`);
}

async function captureCssGraphicsProbe(host, guest, hostBrowser, guestBrowser, label) {
  await Promise.all([
    shot(host.page, `${label}-host`, { canvas: true }),
    shot(guest.page, `${label}-guest`, { canvas: true }),
    shot(host.page, `${label}-full-host`),
    shot(guest.page, `${label}-full-guest`),
  ]);
  const [hostGraphics, guestGraphics, hostSetup, guestSetup] = await Promise.all([
    sampleGraphicsInfo(host.page),
    sampleGraphicsInfo(guest.page),
    sampleMatchSetup(host.page),
    sampleMatchSetup(guest.page),
  ]);
  const report = {
    room: ROOM,
    label,
    host: { graphics: hostGraphics, setup: hostSetup, page_errors: host.pageErrors || [] },
    guest: { graphics: guestGraphics, setup: guestSetup, page_errors: guest.pageErrors || [] },
  };
  writeFileSync(CSS_PROBE_FILE, JSON.stringify(report, null, 2));
  console.log(`\nCSS graphics probe saved to ${CSS_PROBE_FILE}`);
  console.log(
    `  host canvas: ${hostGraphics.canvas?.width}x${hostGraphics.canvas?.height} css=${hostGraphics.canvas?.rect?.width}x${hostGraphics.canvas?.rect?.height} ${hostGraphics.webgl?.unmaskedRenderer || hostGraphics.webgl?.renderer || ''}`,
  );
  console.log(
    `  guest canvas: ${guestGraphics.canvas?.width}x${guestGraphics.canvas?.height} css=${guestGraphics.canvas?.rect?.width}x${guestGraphics.canvas?.rect?.height} ${guestGraphics.webgl?.unmaskedRenderer || guestGraphics.webgl?.renderer || ''}`,
  );
  await Promise.allSettled([hostBrowser.close(), guestBrowser.close()]);
}

/* Sample emulator-level timing state: CP0 Count + packed hidden state
 * (kn_pack_hidden_state_impl: 9 u32s including CP0 count, next interrupt,
 * instr count, event queue hash, SoftFloat state, etc.). This is the
 * state that MUST match cross-peer for deterministic emulation —
 * if it diverges while gameplay_addrs stays clean, the divergence is
 * at the emulator layer (VI/audio/CP0 timing), not game code. */
async function sampleTimingState(page) {
  return page
    .evaluate(() => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (!mod?._kn_get_cp0_count || !mod?._kn_pack_hidden_state_impl || !mod?._malloc) return null;
      if (!window._tsHiddenBufPtr) window._tsHiddenBufPtr = mod._malloc(72); /* v6: 18 u32s */
      const cp0 = mod._kn_get_cp0_count() >>> 0;
      mod._kn_pack_hidden_state_impl(window._tsHiddenBufPtr);
      const arr = new Uint32Array(mod.HEAPU8.buffer, window._tsHiddenBufPtr, 18);
      return { cp0, hidden: Array.from(arr, (v) => v >>> 0) };
    })
    .catch(() => null);
}

/* Cross-peer subsystem-hash comparison.
 * 18 subsystems: 0=GPR, 1=CP0, 2=CP1+fcr, 3=HI/LO/PC/LL, 4=TLB, 5=AI,
 * 6=MI, 7=SI, 8=PI, 9=SP/RSP, 10=DP, 11=VI, 12=RI, 13=PIF+SF,
 * 14=CP1 only, 15=fcr only, 16=PIF only, 17=SF only.
 * Used to identify which emulator subsystem first diverges cross-peer
 * when RB-CHECK MISMATCH fires. */
async function sampleSubsystemHashes(page) {
  return page
    .evaluate(() => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (!mod?._kn_subsystem_hashes || !mod?._malloc) return null;
      if (!window._subsysBufPtr) window._subsysBufPtr = mod._malloc(18 * 4);
      const n = mod._kn_subsystem_hashes(window._subsysBufPtr, 18);
      if (n !== 18) return null;
      const arr = new Uint32Array(mod.HEAPU8.buffer, window._subsysBufPtr, 18);
      return Array.from(arr, (v) => v >>> 0);
    })
    .catch(() => null);
}

const SUBSYS_NAMES = [
  'GPR',
  'CP0',
  'CP1+fcr',
  'HI/LO/PC/LL',
  'TLB',
  'AI',
  'MI',
  'SI',
  'PI',
  'SP/RSP',
  'DP',
  'VI',
  'RI',
  'PIF+SF',
  'CP1',
  'fcr',
  'PIF',
  'SF',
];

async function checkSubsysDrift(host, guest) {
  const [h, g] = await Promise.all([sampleSubsystemHashes(host), sampleSubsystemHashes(guest)]);
  if (!h || !g) return null;
  const diffs = [];
  for (let i = 0; i < 18; i++) {
    if (h[i] !== g[i]) diffs.push({ idx: i, name: SUBSYS_NAMES[i], h: h[i], g: g[i] });
  }
  return diffs;
}

async function checkTimingDrift(host, guest) {
  const [h, g] = await Promise.all([sampleTimingState(host), sampleTimingState(guest)]);
  if (!h || !g) return null;
  const cp0Delta = (h.cp0 - g.cp0) >> 0;
  const hiddenDiffs = [];
  for (let i = 0; i < h.hidden.length; i++) {
    if (h.hidden[i] !== g.hidden[i]) {
      hiddenDiffs.push({ idx: i, h: h.hidden[i], g: g.hidden[i], delta: (h.hidden[i] - g.hidden[i]) | 0 });
    }
  }
  return { cp0h: h.cp0, cp0g: g.cp0, cp0Delta, hiddenDiffs };
}

/* Sample the fighter pool allocation buffer via kn_fighter_buffer_dump.
 * This is the FTStruct array pointed at by gFTManagerStructsAllocBuf —
 * includes damage %, position, velocity, animation state, all the
 * user-visible fighter state that gameplay_addrs doesn't cover. */
async function sampleFighterBuffer(page, size = 0x600) {
  return page
    .evaluate((sz) => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (!mod?._kn_fighter_buffer_dump || !mod?._malloc) return null;
      if (!window._fighterBufPtr) window._fighterBufPtr = mod._malloc(sz);
      const n = mod._kn_fighter_buffer_dump(window._fighterBufPtr, sz);
      if (n <= 0) return null;
      const arr = new Uint8Array(mod.HEAPU8.buffer, window._fighterBufPtr, n);
      return Array.from(arr);
    }, size)
    .catch(() => null);
}

/* Diff fighter pool bytes cross-peer. Returns { totalBytes, diffCount,
 * firstDiffOffset, regions } — where regions is a list of contiguous
 * divergence ranges. This catches the user-visible desyncs (fighter
 * position, damage %, velocity) that gameplay_addrs doesn't cover. */
async function checkFighterDrift(host, guest) {
  const [h, g] = await Promise.all([sampleFighterBuffer(host), sampleFighterBuffer(guest)]);
  if (!h || !g || h.length !== g.length) return null;
  let diffCount = 0;
  let firstDiff = -1;
  const regions = [];
  let regionStart = -1;
  for (let i = 0; i < h.length; i++) {
    if (h[i] !== g[i]) {
      diffCount++;
      if (firstDiff < 0) firstDiff = i;
      if (regionStart < 0) regionStart = i;
    } else if (regionStart >= 0) {
      regions.push({ start: regionStart, end: i, size: i - regionStart });
      regionStart = -1;
    }
  }
  if (regionStart >= 0) regions.push({ start: regionStart, end: h.length, size: h.length - regionStart });
  return { totalBytes: h.length, diffCount, firstDiff, regions };
}

/* Run kn_forward_replay_check on a peer.
 * Performs SAME-INPUT forward-then-replay over n frames and returns a
 * subsystem-level diff bitmap. Bits 0-17 are subsystem hashes, bit 18 is
 * gameplay-hash diff. Any nonzero return = proven replay non-determinism.
 *
 * 2026-04-25: this is the cleanest "is replay deterministic" test —
 * unlike RB-LIVE-MISMATCH which compares forward+predicted vs replay+real
 * (different inputs, divergence expected), this uses identical inputs
 * for both passes, so any divergence is a real bug. */
async function runForwardReplayCheck(page, nFrames = 2) {
  return page
    .evaluate(
      ({ n }) => {
        const mod = window.EJS_emulator?.gameManager?.Module;
        if (!mod?._kn_forward_replay_check || !mod?._malloc) return null;
        if (!window._fwdReplayDiffPtr) window._fwdReplayDiffPtr = mod._malloc(4);
        const ret = mod._kn_forward_replay_check(n, window._fwdReplayDiffPtr);
        if (ret < 0) return { error: ret };
        const view = new Uint32Array(mod.HEAPU8.buffer, window._fwdReplayDiffPtr, 1);
        return { diffBits: view[0] >>> 0, ret };
      },
      { n: nFrames },
    )
    .catch((e) => ({ exception: String(e) }));
}

/* Faithful variant: mirrors the actual rollback save/restore (savestate +
 * hidden state + SoftFloat + hle ring). The base kn_forward_replay_check
 * misses these extras and reports false-positive divergence in AI/CP1.
 * This export is added in 2026-04-25 build; if not present, returns null. */
async function runReplayFaithfulCheck(page, nFrames = 2) {
  return page
    .evaluate(
      ({ n }) => {
        const mod = window.EJS_emulator?.gameManager?.Module;
        if (!mod?._kn_replay_faithful_check || !mod?._malloc) return null;
        if (!window._faithfulDiffPtr) window._faithfulDiffPtr = mod._malloc(4);
        const ret = mod._kn_replay_faithful_check(n, window._faithfulDiffPtr);
        if (ret < 0) return { error: ret };
        const view = new Uint32Array(mod.HEAPU8.buffer, window._faithfulDiffPtr, 1);
        return { diffBits: view[0] >>> 0, ret };
      },
      { n: nFrames },
    )
    .catch((e) => ({ exception: String(e) }));
}

/* Sample rollback statistics via existing exports.
 * 2026-04-25: cross-peer asymmetric rollback counts are a smoking gun
 * — if host rolled back 30× while guest rolled back 80×, replays
 * compounded differently and explain the cross-peer state divergence.
 * If counts roughly match, divergence comes from somewhere else. */
async function sampleRollbackStats(page) {
  return page
    .evaluate(() => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (!mod?._kn_get_rollback_count) return null;
      return {
        active: !!window.NetplayLockstep?.isCRollback?.(),
        rollbacks: (mod._kn_get_rollback_count?.() || 0) >>> 0,
        maxDepth: (mod._kn_get_max_depth?.() || 0) >>> 0,
        failed: (mod._kn_get_failed_rollbacks?.() || 0) >>> 0,
        predictions: (mod._kn_get_prediction_count?.() || 0) >>> 0,
        correct: (mod._kn_get_correct_predictions?.() || 0) >>> 0,
        frame: (mod._kn_get_frame?.() || 0) >>> 0,
      };
    })
    .catch(() => null);
}

async function sampleRuntimeStats(page) {
  return page
    .evaluate(() => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      const rb = mod?._kn_get_rollback_count
        ? {
            active: !!window.NetplayLockstep?.isCRollback?.(),
            rollbacks: (mod._kn_get_rollback_count?.() || 0) >>> 0,
            maxDepth: (mod._kn_get_max_depth?.() || 0) >>> 0,
            failed: (mod._kn_get_failed_rollbacks?.() || 0) >>> 0,
            predictions: (mod._kn_get_prediction_count?.() || 0) >>> 0,
            correct: (mod._kn_get_correct_predictions?.() || 0) >>> 0,
            frame: (mod._kn_get_frame?.() || 0) >>> 0,
          }
        : null;
      const ctx = window.KNAudio?.ctx || null;
      let audioRms = null;
      let audioPeak = null;
      const audioSamples = (mod?._kn_get_audio_samples?.() || 0) >>> 0;
      const audioPtr = (mod?._kn_get_audio_ptr?.() || 0) >>> 0;
      if (mod?.HEAPU8?.buffer && audioSamples > 0 && audioPtr) {
        try {
          const pcm = new Int16Array(mod.HEAPU8.buffer, audioPtr, Math.min(audioSamples * 2, 400));
          let sum = 0;
          let peak = 0;
          for (let i = 0; i < pcm.length; i++) {
            const v = pcm[i];
            const av = Math.abs(v);
            sum += v * v;
            if (av > peak) peak = av;
          }
          audioRms = pcm.length ? Math.sqrt(sum / pcm.length) : 0;
          audioPeak = peak;
        } catch (_) {}
      }
      const audio = mod?._kn_get_audio_samples
        ? {
            ready: !!window.KNAudio?.ready,
            ctxState: ctx?.state || null,
            ctxTime: ctx?.currentTime || 0,
            samples: audioSamples,
            rms: audioRms,
            peak: audioPeak,
            rate: (mod._kn_get_audio_rate?.() || 0) >>> 0,
            skipOutput: mod._kn_get_skip_audio_output ? mod._kn_get_skip_audio_output() : null,
            ringCount: window._kn_audioRingCount || 0,
            alCtx: mod.AL?.contexts ? Object.keys(mod.AL.contexts).length : null,
          }
        : null;
      return { rb, audio };
    })
    .catch((e) => ({ error: String(e) }));
}

function logRuntimeStats(label, hostStats, guestStats) {
  console.log(`  ${label} host runtime: ${JSON.stringify(hostStats)}`);
  console.log(`  ${label} guest runtime: ${JSON.stringify(guestStats)}`);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function summarizeBinaryDiff(hostBuf, guestBuf, limit = 32) {
  if (!hostBuf || !guestBuf) return null;
  const minLen = Math.min(hostBuf.length, guestBuf.length);
  const firstDiffs = [];
  const regions = [];
  let diffCount = 0;
  let firstDiffOffset = -1;
  let regionStart = -1;

  for (let i = 0; i < minLen; i++) {
    if (hostBuf[i] !== guestBuf[i]) {
      diffCount++;
      if (firstDiffOffset < 0) firstDiffOffset = i;
      if (firstDiffs.length < limit) firstDiffs.push({ offset: i, host: hostBuf[i], guest: guestBuf[i] });
      if (regionStart < 0) regionStart = i;
    } else if (regionStart >= 0) {
      if (regions.length < limit) regions.push({ start: regionStart, end: i, size: i - regionStart });
      regionStart = -1;
    }
  }
  if (regionStart >= 0 && regions.length < limit) {
    regions.push({ start: regionStart, end: minLen, size: minLen - regionStart });
  }

  const lengthDelta = hostBuf.length - guestBuf.length;
  if (lengthDelta !== 0 && firstDiffOffset < 0) firstDiffOffset = minLen;
  return {
    hostSize: hostBuf.length,
    guestSize: guestBuf.length,
    lengthDelta,
    sha256: {
      host: sha256(hostBuf),
      guest: sha256(guestBuf),
    },
    diffCount,
    firstDiffOffset,
    firstDiffs,
    regions,
  };
}

function summarizeArrayDiff(hostArr, guestArr, limit = 32) {
  if (!Array.isArray(hostArr) || !Array.isArray(guestArr)) return null;
  const diffs = [];
  const len = Math.min(hostArr.length, guestArr.length);
  for (let i = 0; i < len; i++) {
    const h = hostArr[i] >>> 0;
    const g = guestArr[i] >>> 0;
    if (h !== g) diffs.push({ idx: i, host: h, guest: g, delta: (h - g) | 0 });
    if (diffs.length >= limit) break;
  }
  return {
    hostLength: hostArr.length,
    guestLength: guestArr.length,
    diffCount: diffs.length,
    firstDiffs: diffs,
  };
}

function compareStartupSetup(hostSetup, guestSetup) {
  if (!hostSetup || !guestSetup) return [{ field: 'setup_sample', host: !!hostSetup, guest: !!guestSetup }];
  const diffs = [];
  const cmp = (field, hostValue, guestValue) => {
    if (hostValue !== guestValue) diffs.push({ field, host: hostValue, guest: guestValue });
  };
  cmp('scene', hostSetup.scene, guestSetup.scene);
  cmp('netplayGameStatus', hostSetup.netplayGameStatus, guestSetup.netplayGameStatus);
  for (const field of ['match_phase', 'vs_battle_hdr', 'rng']) {
    cmp(`hashes.${field}`, hostSetup.hashes?.[field], guestSetup.hashes?.[field]);
  }
  for (let p = 0; p < 4; p++) {
    const h = hostSetup.players?.[p] || {};
    const g = guestSetup.players?.[p] || {};
    for (const field of ['css_char_id', 'css_cursor_state', 'css_selected_flag', 'css_panel_state']) {
      cmp(`p${p}.${field}`, h[field], g[field]);
    }
  }
  return diffs;
}

async function captureStartupState(peer, label) {
  const captured = await peer.page
    .evaluate(() => {
      const toB64 = (u8) => {
        let bin = '';
        for (let i = 0; i < u8.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        }
        return btoa(bin);
      };
      const runtimeFamily = (() => {
        const ua = navigator.userAgent || '';
        if (/AppleWebKit/i.test(ua) && !/Chrome|Chromium|CriOS|Edg/i.test(ua)) return 'webkit-jsc';
        if (/Chrome|Chromium|CriOS|Edg/i.test(ua)) return 'chromium-v8';
        if (/Firefox/i.test(ua)) return 'firefox-spidermonkey';
        return 'unknown';
      })();
      const gm = window.EJS_emulator?.gameManager;
      const mod = gm?.Module;
      const out = {
        ok: false,
        kind: null,
        size: 0,
        bytesB64: null,
        runtime: {
          family: runtimeFamily,
          userAgent: navigator.userAgent,
          brands: navigator.userAgentData?.brands || null,
          platform: navigator.platform || null,
          hardwareConcurrency: navigator.hardwareConcurrency || null,
          devicePixelRatio: window.devicePixelRatio,
          webkit: /AppleWebKit/i.test(navigator.userAgent || ''),
        },
        ejs: {
          exists: !!window.EJS_emulator,
          started: !!window.EJS_emulator?.started,
          core: window.EJS_emulator?.getCore?.() || null,
          coreHash: window._knCoreHash || null,
          coreDataOverride: window.__knCoreDataOverride || null,
        },
        kn: {
          room: window.KNState?.room || null,
          slot: window.KNState?.slot ?? null,
          frame: window.KNState?.frameNum ?? null,
          romHash: window.KNState?.romHash || null,
          matchId: window.KNState?.matchId || null,
        },
        module: mod
          ? {
              frame: mod._kn_get_frame?.() ?? null,
              coreFrame: mod._get_current_frame_count?.() ?? null,
              scene: mod._kn_get_scene_curr?.() ?? null,
              cp0: mod._kn_get_cp0_count?.() ?? null,
              hasKnSync: !!mod._kn_sync_read,
              hasSavestate: !!gm?.getState,
            }
          : null,
        hiddenWords: null,
        audioFifo: null,
      };

      const captureHiddenWords = () => {
        if (!mod?._kn_pack_hidden_state_impl || !mod?._malloc || !mod?._free || !mod.HEAPU32) return null;
        const ptr = mod._malloc(18 * 4);
        if (!ptr) return null;
        try {
          mod._kn_pack_hidden_state_impl(ptr);
          return Array.from(new Uint32Array(mod.HEAPU32.buffer, ptr, 18), (v) => v >>> 0);
        } finally {
          mod._free(ptr);
        }
      };
      const captureAudioFifo = () => {
        if (!mod?._kn_get_audio_fifo_state || !mod?._malloc || !mod?._free || !mod.HEAPU32) return null;
        const ptr = mod._malloc(4 * 4);
        if (!ptr) return null;
        try {
          mod._kn_get_audio_fifo_state(ptr);
          return Array.from(new Uint32Array(mod.HEAPU32.buffer, ptr, 4), (v) => v >>> 0);
        } finally {
          mod._free(ptr);
        }
      };

      let bytes = null;
      if (mod?._kn_sync_read && mod?._malloc && mod?._free && mod.HEAPU8) {
        const size = 8 * 1024 * 1024 + 64 * 1024;
        const ptr = mod._malloc(size);
        if (ptr) {
          try {
            const n = mod._kn_sync_read(ptr, size) >>> 0;
            if (n > 0 && n <= size) {
              bytes = new Uint8Array(mod.HEAPU8.buffer, ptr, n).slice();
              out.kind = 'kn-sync';
            }
          } finally {
            mod._free(ptr);
          }
        }
      }
      if (!bytes && typeof gm?.getState === 'function') {
        const raw = gm.getState();
        bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        out.kind = 'savestate';
      }

      out.hiddenWords = captureHiddenWords();
      out.audioFifo = captureAudioFifo();
      if (bytes) {
        out.ok = true;
        out.size = bytes.length;
        out.bytesB64 = toB64(bytes);
      }
      return out;
    })
    .catch((err) => ({ ok: false, error: err.message || String(err) }));

  let bytes = null;
  if (captured.bytesB64) {
    bytes = Buffer.from(captured.bytesB64, 'base64');
    delete captured.bytesB64;
    captured.sha256 = sha256(bytes);
    captured.path = `/tmp/startup-state-${ROOM}-${label}.bin`;
    writeFileSync(captured.path, bytes);
  }
  return { meta: captured, bytes };
}

async function writeStartupStateProbeReport(host, guest, hostBrowser, guestBrowser) {
  console.log('\n=== Startup State Probe ===');
  const [hostState, guestState, hostTiming, guestTiming, hostSubsys, guestSubsys, hostSetup, guestSetup] =
    await Promise.all([
      captureStartupState(host, 'host'),
      captureStartupState(guest, 'guest'),
      sampleTimingState(host.page),
      sampleTimingState(guest.page),
      sampleSubsystemHashes(host.page),
      sampleSubsystemHashes(guest.page),
      sampleMatchSetup(host.page),
      sampleMatchSetup(guest.page),
    ]);

  const byteDiff = summarizeBinaryDiff(hostState.bytes, guestState.bytes);
  const hiddenDiff = summarizeArrayDiff(hostState.meta.hiddenWords, guestState.meta.hiddenWords);
  const audioFifoDiff = summarizeArrayDiff(hostState.meta.audioFifo, guestState.meta.audioFifo);
  const timingHiddenDiff = summarizeArrayDiff(hostTiming?.hidden, guestTiming?.hidden);
  const subsysDiffs =
    Array.isArray(hostSubsys) && Array.isArray(guestSubsys)
      ? hostSubsys
          .map((h, idx) => ({ idx, name: SUBSYS_NAMES[idx], host: h >>> 0, guest: guestSubsys[idx] >>> 0 }))
          .filter((d) => d.host !== d.guest)
      : null;
  const startupSetupDiffs = compareStartupSetup(hostSetup, guestSetup);
  const report = {
    room: ROOM,
    verdict:
      byteDiff && byteDiff.diffCount === 0 && byteDiff.lengthDelta === 0 ? 'STATE_BYTES_MATCH' : 'STATE_BYTES_DIFFER',
    host: hostState.meta,
    guest: guestState.meta,
    byteDiff,
    sidecars: {
      hiddenDiff,
      audioFifoDiff,
      timing: {
        host: hostTiming,
        guest: guestTiming,
        hiddenDiff: timingHiddenDiff,
      },
      subsystemDiffs: subsysDiffs,
      setup: {
        host: hostSetup,
        guest: guestSetup,
        diffs: startupSetupDiffs,
      },
    },
  };

  writeFileSync(STARTUP_STATE_REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(
    `  host: ${hostState.meta.kind || 'none'} ${hostState.meta.size || 0} bytes ${hostState.meta.sha256 || ''}`,
  );
  console.log(
    `  guest: ${guestState.meta.kind || 'none'} ${guestState.meta.size || 0} bytes ${guestState.meta.sha256 || ''}`,
  );
  if (byteDiff) {
    const first = byteDiff.firstDiffOffset >= 0 ? ` first=0x${byteDiff.firstDiffOffset.toString(16)}` : '';
    console.log(`  byte diff: count=${byteDiff.diffCount} sizeDelta=${byteDiff.lengthDelta}${first}`);
  }
  if (subsysDiffs?.length) {
    console.log(
      `  subsystem diff: ${subsysDiffs
        .slice(0, 8)
        .map((d) => `${d.idx}:${d.name}`)
        .join(', ')}`,
    );
  }
  console.log(`  report: ${STARTUP_STATE_REPORT_FILE}`);
  console.log(`  bins: ${hostState.meta.path || 'n/a'} | ${guestState.meta.path || 'n/a'}`);

  await Promise.allSettled([
    host.page.evaluate(() => window._flushSyncLog?.()),
    guest.page.evaluate(() => window._flushSyncLog?.()),
  ]);
  if (!KEEP_OPEN) {
    await Promise.allSettled([hostBrowser.close(), guestBrowser.close()]);
  }
}

/* Sample per-slot inputs across a window of recent frames.
 * Returns { frames: [F-N+1...F], slots: [4][N] of {btn,lx,ly,cx,cy,present} }.
 * Uses kn_get_input which reads rb.inputs[slot][frame % ring]. The ring
 * is kept by rollback; entries get overwritten only after KN_INPUT_RING_SIZE
 * frames pass, so a small recent window is reliable. */
async function sampleInputWindow(page, currentFrame, n = 16) {
  return page
    .evaluate(
      ({ cur, n }) => {
        const mod = window.EJS_emulator?.gameManager?.Module;
        if (!mod?._kn_get_input || !mod?._malloc) return null;
        if (!window._inputBufPtr) window._inputBufPtr = mod._malloc(20); /* 5 ints */
        const ptr = window._inputBufPtr;
        const buf = new Int32Array(mod.HEAPU8.buffer, ptr, 5);
        const slots = [[], [], [], []];
        const startF = Math.max(0, cur - n + 1);
        for (let f = startF; f <= cur; f++) {
          for (let s = 0; s < 4; s++) {
            const ok = mod._kn_get_input(s, f, ptr, ptr + 4, ptr + 8, ptr + 12, ptr + 16);
            slots[s].push(
              ok
                ? {
                    f,
                    btn: buf[0] >>> 0,
                    lx: buf[1],
                    ly: buf[2],
                    cx: buf[3],
                    cy: buf[4],
                  }
                : { f, present: false },
            );
          }
        }
        return { startF, endF: cur, slots };
      },
      { cur: currentFrame, n },
    )
    .catch(() => null);
}

/* Diff input windows cross-peer per (slot, frame). Logs first divergence. */
function diffInputWindows(h, g) {
  if (!h || !g) return null;
  const diffs = [];
  for (let s = 0; s < 4; s++) {
    const hs = h.slots[s],
      gs = g.slots[s];
    const len = Math.min(hs.length, gs.length);
    for (let i = 0; i < len; i++) {
      const ha = hs[i],
        ga = gs[i];
      const hAbsent = !ha || ha.present === false;
      const gAbsent = !ga || ga.present === false;
      if (hAbsent && gAbsent) continue;
      if (!ha || !ga || ha.btn !== ga.btn || ha.lx !== ga.lx || ha.ly !== ga.ly || ha.cx !== ga.cx || ha.cy !== ga.cy) {
        diffs.push({ slot: s, frame: ha?.f ?? ga?.f, h: ha, g: ga });
      }
    }
  }
  return diffs;
}

/* Poll the server's SSIM table for desync detection.
 *
 * **SSIM is the primary desync signal** (per user feedback 2026-04-24):
 *   - Server compares peer-vs-peer screenshots every 5s and flags
 *     `is_desync = ssim < 0.95` in screenshot_comparisons.
 *   - Visual diff is ground truth — the gameplay hash has historically
 *     had mislabeled-address pollution (dSYAudioCurrentTic etc.) that
 *     fires phantom mismatches, so we don't trust it as the primary
 *     test-exit signal.
 *
 * The hash flag (window._kn_desyncDetectedGameFrame) is kept as a
 * secondary tie-break so if a genuine hash mismatch fires before the
 * next 5-second SSIM poll we still early-exit, but the returned value
 * records whether SSIM or hash was the trigger. */
async function waitForDesync(pages, { timeoutMs = 120_000, pollMs = 500, abortSignal, roomHint, minFrame = 0 } = {}) {
  const start = Date.now();
  let matchId = null;
  while (Date.now() - start < timeoutMs) {
    if (abortSignal?.aborted) return null;

    /* Resolve match_id once both peers have it. KNState.matchId is
     * populated by the `game-started` event after host clicks start. */
    if (!matchId) {
      for (const p of pages) {
        const mid = await p.evaluate(() => window.KNState?.matchId || null).catch(() => null);
        if (mid) {
          matchId = mid;
          break;
        }
      }
    }

    /* ── Primary: SSIM via admin API ─────────────────────────────── */
    if (matchId) {
      try {
        const resp = await adminGet(`/admin/api/screenshots/${matchId}/comparisons`);
        const comparisons = resp.comparisons || [];
        /* Only treat as desync when ssim drops below our threshold —
         * the server's is_desync flag at <0.95 catches pixel-level
         * rendering noise that's visually identical between peers. */
        const badRow = comparisons.find(
          (c) => typeof c.ssim === 'number' && c.ssim < SSIM_EARLY_EXIT_THRESHOLD && (c.frame ?? 0) >= minFrame,
        );
        if (badRow) {
          return {
            trigger: 'ssim',
            matchId,
            /* Unified field name so log + tag code don't have to branch
             * on trigger type. localFrame=the emulator local frame the
             * screenshot was captured at, per the server comparison. */
            localFrame: badRow.frame,
            ssim: badRow.ssim,
            slots: [badRow.slot_a, badRow.slot_b],
            elapsedMs: Date.now() - start,
          };
        }
      } catch (_) {
        /* admin API may briefly 404 if match not rotated yet */
      }
    }

    /* ── Secondary: hash MISMATCH flag ───────────────────────────── */
    for (let i = 0; i < pages.length; i++) {
      const info = await pages[i]
        .evaluate(() => {
          if (window._kn_desyncDetectedGameFrame === undefined) return null;
          return {
            gf: window._kn_desyncDetectedGameFrame,
            lastGood: window._kn_desyncDetectedLastGood,
            lf: window._kn_desyncDetectedLocalFrame,
          };
        })
        .catch(() => null);
      if (info) {
        return {
          trigger: 'hash',
          slot: i,
          gameFrame: info.gf,
          lastGood: info.lastGood,
          localFrame: info.lf,
          elapsedMs: Date.now() - start,
        };
      }
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
  return null;
}

async function adminGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `${BASE_URL}${path}`,
      { headers: { 'X-Admin-Key': ADMIN_KEY }, rejectUnauthorized: false },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function configureDiagnostics(peer, label, { hostAuthority = false, enableNetsim = false } = {}) {
  if (!(enableNetsim && NETSIM_ENABLED) && !(hostAuthority && TRANSPORT_OVERRIDE)) return;
  await peer.page.waitForFunction(() => window.knDiag, null, { timeout: 10000 }).catch(() => {});
  const result = await peer.page
    .evaluate(
      ({ hostAuthority, transport, netsimEnabled, jitterMs, dropPct }) => {
        const out = {};
        if (hostAuthority && transport) {
          out.transport = window.knDiag?.setTransport?.(transport) ?? null;
        }
        if (netsimEnabled) {
          out.netsim = window.knDiag?.netsim?.({ jitterMs, dropPct }) ?? null;
          window._knNetsimRewrap?.();
        }
        return out;
      },
      {
        hostAuthority,
        transport: TRANSPORT_OVERRIDE,
        netsimEnabled: enableNetsim && NETSIM_ENABLED,
        jitterMs: NETSIM_JITTER_MS,
        dropPct: NETSIM_DROP_PCT,
      },
    )
    .catch((e) => ({ error: String(e) }));
  console.log(`  ${label} diagnostics: ${JSON.stringify(result)}`);
}

async function enablePostSetupNetsim(host, guest) {
  if (!NETSIM_ENABLED) return;
  await Promise.all([
    configureDiagnostics(host, 'host post-setup', { enableNetsim: true }),
    configureDiagnostics(guest, 'guest post-setup', { enableNetsim: true }),
  ]);
}

async function setupPeer(browser, urlSuffix, name) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...(GUEST_DSF2 && name === 'G' ? { deviceScaleFactor: 2 } : {}),
  });
  const page = await ctx.newPage();
  if (VERBOSE_DEEP_LOGS) {
    await page.addInitScript(() => {
      window._KN_DIAG = true;
      try {
        localStorage.setItem('kn-debug', '1');
      } catch {}
    });
  }
  if (CORE_DATA_URL) {
    await page.addInitScript(
      ({ url, hash }) => {
        const coreNames = [
          'mupen64plus_next-wasm.data',
          'mupen64plus_next-legacy-wasm.data',
          'parallel_n64-wasm.data',
          'parallel_n64-legacy-wasm.data',
        ];
        const isCoreData = (requestUrl) => coreNames.some((name) => String(requestUrl || '').includes(name));
        const nativeFetch = window.fetch.bind(window);
        window.fetch = function (input, init) {
          const requestUrl = typeof input === 'string' ? input : input?.url || '';
          if (requestUrl === '/api/core-info' || requestUrl.endsWith('/api/core-info')) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  url,
                  hash,
                  size: 0,
                }),
                {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                },
              ),
            );
          }
          if (isCoreData(requestUrl)) {
            window.__knCoreDataFetches = (window.__knCoreDataFetches || 0) + 1;
            return nativeFetch(url, init);
          }
          return nativeFetch(input, init);
        };
        const nativeOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, requestUrl) {
          if (isCoreData(requestUrl)) {
            window.__knCoreDataFetches = (window.__knCoreDataFetches || 0) + 1;
            arguments[1] = url;
          }
          return nativeOpen.apply(this, arguments);
        };
        window.__knCoreDataOverride = url;
      },
      { url: CORE_DATA_URL, hash: `override:${CORE_DATA_URL}` },
    );
  }
  if (GFX_PROFILE) {
    await page.addInitScript((profile) => {
      const applyProfile = (options) => {
        if (!options || typeof options !== 'object') return;
        if (profile === 'texrect') {
          Object.assign(options, {
            'mupen64plus-EnableNativeResTexrects': 'Optimized',
            'mupen64plus-EnableTexCoordBounds': 'True',
            'mupen64plus-CorrectTexrectCoords': 'Force',
          });
        } else if (profile === 'texrect-unopt') {
          Object.assign(options, {
            'mupen64plus-EnableNativeResTexrects': 'Unoptimized',
            'mupen64plus-EnableTexCoordBounds': 'True',
            'mupen64plus-CorrectTexrectCoords': 'Force',
            'mupen64plus-BackgroundMode': 'Stripped',
          });
        } else if (profile === 'unopt-no-bg') {
          Object.assign(options, {
            'mupen64plus-EnableNativeResTexrects': 'Unoptimized',
            'mupen64plus-EnableTexCoordBounds': 'True',
            'mupen64plus-CorrectTexrectCoords': 'Force',
          });
        } else if (profile === 'unopt-only') {
          options['mupen64plus-EnableNativeResTexrects'] = 'Unoptimized';
        } else if (profile === 'webgl1') {
          window.EJS_forceLegacyCores = true;
          options.webgl2Enabled = 'disabled';
        } else if (profile === 'angrylion') {
          options['mupen64plus-rdp-plugin'] = 'angrylion';
        } else if (profile === 'parallel') {
          options['mupen64plus-rdp-plugin'] = 'parallel';
        } else if (profile === 'unpack1') {
          // Applied below as a WebGL API shim; keep options untouched.
        }
      };
      const installUnpackAlignmentShim = () => {
        if (profile !== 'unpack1' || window.__knUnpackAlignmentShim) return;
        window.__knUnpackAlignmentShim = true;
        const patchProto = (proto) => {
          if (!proto || proto.__knUnpackAlignmentPatched) return;
          proto.__knUnpackAlignmentPatched = true;
          for (const name of ['texImage2D', 'texSubImage2D', 'compressedTexImage2D', 'compressedTexSubImage2D']) {
            const orig = proto[name];
            if (typeof orig !== 'function') continue;
            proto[name] = function (...args) {
              try {
                this.pixelStorei(this.UNPACK_ALIGNMENT, 1);
              } catch {}
              return orig.apply(this, args);
            };
          }
        };
        patchProto(window.WebGLRenderingContext?.prototype);
        patchProto(window.WebGL2RenderingContext?.prototype);
      };
      let currentOptions = window.EJS_defaultOptions || null;
      Object.defineProperty(window, 'EJS_defaultOptions', {
        configurable: true,
        get() {
          return currentOptions;
        },
        set(value) {
          currentOptions = value;
          applyProfile(currentOptions);
        },
      });
      applyProfile(currentOptions);
      installUnpackAlignmentShim();
      window.__knGfxProfile = profile;
    }, GFX_PROFILE);
  }
  const clientEvents = [];
  const pageErrors = [];
  page.on('pageerror', (err) => {
    const text = err.stack || err.message || String(err);
    const benignUpdateFetch = text.includes('EmulatorJS.checkForUpdates') && text.includes('Failed to fetch');
    if (!benignUpdateFetch) {
      pageErrors.push({ ts: Date.now(), text: text.substring(0, 2000) });
      clientEvents.push({ ts: Date.now(), type: 'pageerror', text: `PAGE ERROR: ${text}` });
      console.log(`[${name}] PAGE ERROR: ${err.message}`);
    }
  });
  page.on('console', (msg) => {
    const t = msg.text();
    /* Loosened 2026-04-25: include C-REPLAY-FRAME, REPLAY-INPUT, RB-CHECK so
     * we can see input streams + per-step replay flow in the test log
     * alongside MISMATCH/DIVERGE. Was too narrow before — replay timing
     * data was filtered out and only end-state divergence remained. */
    if (
      (VERBOSE_DEEP_LOGS &&
        t.match(
          /initial-sync|POST-SYNC-DIAG|C-PERF|C-REGIONS|C-BLOCKS|RB-|RDRAM-DESYNC|EQ-|NORMAL-INPUT|LOCAL-INPUT|INPUT-LOG|MENU-BARRIER|PHASE|KNDesync|DIVERGE|MISMATCH|FATAL|ABORT/i,
        )) ||
      t.match(
        /MISMATCH|FATAL|ABORT|DIVERGE|KNDesync|late-join|requesting game state|received late-join|C-REPLAY-FRAME|C-REPLAY-START|C-REPLAY-DONE|REPLAY-INPUT|RB-CHECK|RB-LIVE-FIELD/i,
      )
    ) {
      clientEvents.push({ ts: Date.now(), type: msg.type(), text: t });
      console.log(`[${name}] ${t.substring(0, 200)}`);
    }
  });
  // Keep production-style rollback behavior during determinism runs.
  // KN_DEV_BUILD turns some diagnostics into thrown exceptions; that is
  // useful interactively, but it interrupts replay ticks and contaminates
  // the determinism verdict.
  const gfxSuffix = GFX_PROFILE ? `&kngfx=${encodeURIComponent(GFX_PROFILE)}` : '';
  const desyncSuffix = DESYNC_MODE ? `&desync=${encodeURIComponent(DESYNC_MODE)}` : '';
  if (CORE_DATA_URL) console.log(`  ${name}: core data ${CORE_DATA_URL}`);
  const perfSuffix = DESYNC_MODE === 'deep' ? '&kndiag=deep' : '&knperf=light';
  const playUrl = `${BASE_URL}/play.html?${urlSuffix}&name=${name}&mode=rollback${perfSuffix}${gfxSuffix}${desyncSuffix}`;
  if (GFX_PROFILE) console.log(`  ${name}: gfx profile ${GFX_PROFILE}`);
  await page.goto(playUrl, {
    waitUntil: 'domcontentloaded',
  });
  await page.evaluate(() => {
    try {
      localStorage.removeItem('KN_DEV_BUILD');
      localStorage.setItem('kn-debug', '1');
    } catch {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window._knDesyncSuspects = [];
    const wire = () => {
      if (!window.KNDesync?.events || window._knDesyncHarnessWired) return;
      window._knDesyncHarnessWired = true;
      window.KNDesync.events.addEventListener('desync-suspect', (e) => {
        try {
          window._knDesyncSuspects.push(JSON.parse(JSON.stringify(e.detail)));
        } catch {
          window._knDesyncSuspects.push({ trigger: e.detail?.trigger, field: e.detail?.field, frame: e.detail?.frame });
        }
      });
    };
    wire();
    window._knDesyncHarnessWireTimer = setInterval(wire, 500);
  });
  await page.waitForTimeout(2000);
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#rom-drop')]);
  await fc.setFiles(ROM_PATH);
  await page.waitForTimeout(2000);
  return { ctx, page, name, clientEvents, pageErrors };
}

async function debugState(page) {
  return page
    .evaluate(() => {
      const debug = window.NetplayLockstep?.getDebugState?.() || null;
      return {
        slot: debug?.playerSlot ?? window._playerSlot ?? window.KNState?.slot ?? null,
        isSpectator: window._isSpectator ?? null,
        running: debug?.running ?? null,
        activeRoster: debug?.activeRoster ?? null,
        inputPeerSlots: debug?.inputPeerSlots ?? null,
        frameNum: debug?.frameNum ?? window.KNState?.frameNum ?? null,
        localInputNow: debug?.localInputNow ?? null,
        remoteLatest: debug?.remoteLatest ?? null,
      };
    })
    .catch((err) => ({ error: String(err) }));
}

async function waitForPlayableSlot(peer, expectedSlot, timeoutMs = 120000) {
  const start = Date.now();
  let last = null;
  let lastClickAt = 0;
  while (Date.now() - start < timeoutMs) {
    const now = Date.now();
    if (now - lastClickAt >= 2000) {
      lastClickAt = now;
      await clickBootPrompt(peer.page, peer.name);
    }
    last = await debugState(peer.page);
    const roster = Array.isArray(last.activeRoster) ? last.activeRoster : [];
    if (
      last.slot === expectedSlot &&
      last.isSpectator !== true &&
      last.running === true &&
      roster.includes(expectedSlot)
    ) {
      console.log(`  ${peer.name}: active player slot ${expectedSlot}`);
      return last;
    }
    await peer.page.waitForTimeout(500);
  }
  throw new Error(`${peer.name} never became active slot ${expectedSlot}; last=${JSON.stringify(last)}`);
}

async function waitForInputTopology(peers, timeoutMs = 120000) {
  const expected = new Map([
    [0, [1, 2]],
    [1, [0, 2]],
    [2, [0, 1]],
  ]);
  const start = Date.now();
  let last = [];
  while (Date.now() - start < timeoutMs) {
    last = await Promise.all(peers.map((peer) => debugState(peer.page)));
    const ok = last.every((state) => {
      const roster = Array.isArray(state.activeRoster) ? state.activeRoster : [];
      const inputs = Array.isArray(state.inputPeerSlots) ? state.inputPeerSlots : [];
      const needed = expected.get(state.slot) || [];
      return [0, 1, 2].every((slot) => roster.includes(slot)) && needed.every((slot) => inputs.includes(slot));
    });
    if (ok) {
      console.log(
        `  input topology: ${last.map((state) => `P${state.slot + 1} peers=[${state.inputPeerSlots}]`).join(' ')}`,
      );
      return last;
    }
    await peers[0].page.waitForTimeout(500);
  }
  throw new Error(`Input topology never included all three players; last=${JSON.stringify(last)}`);
}

async function waitForFrameAdvance(peers, minAdvance, label, timeoutMs = 20000) {
  const startFrames = await Promise.all(peers.map((peer) => peer.page.evaluate(() => window.KNState?.frameNum || 0)));
  const start = Date.now();
  let lastFrames = startFrames;
  while (Date.now() - start < timeoutMs) {
    lastFrames = await Promise.all(peers.map((peer) => peer.page.evaluate(() => window.KNState?.frameNum || 0)));
    if (lastFrames.every((frame, i) => frame - startFrames[i] >= minAdvance)) {
      console.log(
        `  frame advance OK (${label}): ${peers
          .map((peer, i) => `${peer.name} ${startFrames[i]}->${lastFrames[i]}`)
          .join(' ')}`,
      );
      return lastFrames;
    }
    await peers[0].page.waitForTimeout(250);
  }
  throw new Error(
    `Frames did not advance ${minAdvance}f for ${label}: ` +
      peers.map((peer, i) => `${peer.name} ${startFrames[i]}->${lastFrames[i]}`).join(' '),
  );
}

async function runMidmatchLateJoin(host, guest, chromiumArgs) {
  console.log(`\n=== Mid-match late join after ${LATE_JOIN_DELAY_MS}ms of P1/P2 random input ===`);
  await host.page.waitForTimeout(LATE_JOIN_DELAY_MS);

  const lateBrowser = await chromium.launch({ headless: false, args: chromiumArgs });
  const late = await setupPeer(lateBrowser, `room=${ROOM}`, 'L');
  await clickBootPrompt(late.page, 'late');

  await waitForPlayableSlot(late, 2);
  await Promise.all([
    waitForActiveVsBattle(host.page, 120000, 50),
    waitForActiveVsBattle(guest.page, 120000, 50),
    waitForActiveVsBattle(late.page, 120000, 50),
  ]);
  await waitForInputTopology([host, guest, late]);
  await waitForFrameAdvance([host, guest, late], 90, 'mid-match late join');
  await Promise.all([
    shot(host.page, 'late-midmatch-host'),
    shot(guest.page, 'late-midmatch-guest'),
    shot(late.page, 'late-midmatch-late'),
  ]);

  const states = await Promise.all([host, guest, late].map((peer) => debugState(peer.page)));
  console.log(`  late-join midmatch states: ${JSON.stringify(states)}`);
  return { browser: lateBrowser, peer: late, states };
}

async function shot(page, name, opts = {}) {
  const p = `${SHOT_DIR}/det-${name}.png`;
  /* 2026-04-25: resilient — return false on page-closed instead of throwing,
   * so DESYNC capture sequences continue to record state-diff data even if
   * the browser tab dies mid-capture. Caller can decide whether to bail.
   *
   * Also: prefer canvas-locator screenshot when opts.canvas is true. The
   * full-page shot is 1280x720 with lots of browser chrome; for cross-peer
   * cmp we want JUST the game canvas (sharper for DeepSeek vision). */
  try {
    if (opts.canvas) {
      const canvas = page.locator('canvas#canvas, canvas.ejs_canvas, canvas').first();
      const visible = await canvas.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        await canvas.screenshot({ path: p, timeout: 5000 });
        return true;
      }
    }
    await page.screenshot({ path: p, fullPage: false, timeout: 5000 });
    if (!opts.silent) console.log(`  📸 ${p}`);
    return true;
  } catch (err) {
    if (!opts.silent) {
      console.log(`  ⚠️  shot failed: ${name} — ${err.message?.split('\n')[0]?.slice(0, 80) || err}`);
    }
    return false;
  }
}

/* 2026-04-25: continuous screenshot loop — runs in background during the
 * random-input phase, snaps both peers every captureIntervalMs, names files
 * with localFrame for cross-peer pairing. Survives individual capture failures.
 * Returns a stop function. */
function startContinuousCapture(host, guest, captureIntervalMs = 1000) {
  let stop = false;
  let captured = 0;
  let failed = 0;
  const loop = async () => {
    while (!stop) {
      try {
        const [hf, gf] = await Promise.all([
          host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0),
          guest.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0),
        ]);
        const stamp = String(captured).padStart(3, '0');
        const tag = `live-${stamp}-hf${hf}-gf${gf}`;
        /* canvas-only + silent: cleaner DeepSeek input + no log spam. */
        const [okH, okG] = await Promise.all([
          shot(host.page, `${tag}-host`, { canvas: true, silent: true }),
          shot(guest.page, `${tag}-guest`, { canvas: true, silent: true }),
        ]);
        if (okH && okG) captured++;
        else failed++;
      } catch (e) {
        failed++;
      }
      if (stop) break;
      await new Promise((r) => setTimeout(r, captureIntervalMs));
    }
  };
  loop();
  return () => {
    stop = true;
    return { captured, failed };
  };
}

function randomInt(n) {
  return Math.floor(Math.random() * n);
}

async function main() {
  console.log(`Room: ${ROOM}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Late-join midmatch: ${LATE_JOIN_MIDMATCH ? 'yes' : 'no'}`);
  console.log(`Startup state probe: ${STARTUP_STATE_PROBE ? 'yes' : 'no'}`);
  // Chromium flags to prevent background tabs from having rAF/timers throttled
  // (critical for 2-peer emulator testing where both windows run simultaneously).
  const chromiumArgs = [
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ];

  console.log(`Launching host (chromium/V8)...`);
  const hostBrowser = await chromium.launch({ headless: false, args: chromiumArgs });
  const host = await setupPeer(hostBrowser, `room=${ROOM}&host=1`, 'H');

  const guestDriver = USE_WEBKIT_GUEST ? webkit : chromium;
  console.log(`Launching guest (${USE_WEBKIT_GUEST ? 'webkit/JSC' : 'chromium/V8'})...`);
  const guestBrowser = await guestDriver.launch({
    headless: false,
    args: USE_WEBKIT_GUEST ? undefined : chromiumArgs,
  });
  const guest = await setupPeer(guestBrowser, `room=${ROOM}`, 'G');

  console.log('Waiting for ROM upload + both peers ready...');
  await host.page.waitForTimeout(5000);
  await guest.page.waitForTimeout(5000);

  await shot(host.page, '00-lobby-host');
  await shot(guest.page, '00-lobby-guest');

  await configureDiagnostics(host, 'host', { hostAuthority: true });

  console.log('Host selects rollback mode from dropdown...');
  await host.page.bringToFront();
  await host.page.waitForTimeout(500);
  // Mode dropdown: find it and select rollback
  const modeSelect = await host.page.locator('select').first();
  const optionCount = await modeSelect.evaluate((el) =>
    Array.from(el.options)
      .map((o) => `${o.value}:${o.textContent?.trim()}`)
      .join(', '),
  );
  console.log(`  Mode options: ${optionCount}`);
  await modeSelect.selectOption('lockstep');
  await host.page.waitForTimeout(1000);
  await shot(host.page, '00b-mode-set-host');

  console.log('Host clicks Start Game...');
  await host.page.locator('button:has-text("Start Game")').first().click();
  await host.page.waitForTimeout(3000);
  await shot(host.page, '00c-after-start-host');

  console.log('Waiting for both emulators to tick before replay...');
  await waitForBothTicking(host, guest).catch(async (err) => {
    await writeBootTimeoutReport(host, guest, 'boot-timeout', err);
    throw err;
  });
  await requireNoSolidPaleCanvas(host, guest, 'post-tick-canvas-health', hostBrowser, guestBrowser);
  if (STARTUP_STATE_PROBE) {
    await writeStartupStateProbeReport(host, guest, hostBrowser, guestBrowser);
    return;
  }

  /* Hoisted so both replay and scripted-nav branches can drive the same
   * counter that the final report reads. */
  let inputCount = 0;
  let runDesyncInfo = null;
  let lateJoinResult = null;
  let matchEndInfo = null;

  if (REPLAY_FILE) {
    // ==================== REPLAY MODE (frame-exact via KNState.frameNum setter hook) ====================
    // Hooks KNState.frameNum with a setter that fires any pending keyboard events
    // synchronously inside the emulator's own frame-advance call — zero polling,
    // zero RPC round-trip, zero jitter. Each event fires in the exact game frame
    // the user recorded it.
    console.log(`\n=== REPLAY MODE: ${REPLAY_FILE} ===`);
    const rec = JSON.parse(readFileSync(REPLAY_FILE, 'utf8'));
    console.log(`  ${rec.event_count} events, final frame host=${rec.final_frame_host} guest=${rec.final_frame_guest}`);

    await shot(host.page, '01-replay-start-host');
    await shot(guest.page, '01-replay-start-guest');

    async function installReplay(page, events, label) {
      // Poll-based event injection via setInterval — more reliable than
      // Object.defineProperty (JSC issue) or rAF (background tab throttle).
      // Runs at 8ms intervals to catch frame advances promptly.
      await page.evaluate(
        ({ events, label, minHoldFrames, syntheticInput }) => {
          const KEYCODE_MAP = {
            c: 67,
            x: 88,
            v: 86,
            z: 90,
            Enter: 13,
            ArrowUp: 38,
            ArrowDown: 40,
            ArrowLeft: 37,
            ArrowRight: 39,
            t: 84,
            y: 89,
            a: 65,
            s: 83,
            d: 68,
            w: 87,
            j: 74,
            l: 76,
            k: 75,
            i: 73,
          };
          const sorted = [...events].sort((a, b) => a.frame - b.frame);
          window._replayEvents = sorted;
          window._replayNext = 0;
          window._replayFired = 0;
          window._replayLabel = label;
          window._replayLastFrame = 0;
          window._replayPendingUps = [];
          const setTouchInput = (event) => {
            const spec = syntheticInput[event.key];
            if (!spec || !window.KNState?.touchInput) return;
            window.KNState.touchInput[spec.bit] = event.type === 'down' ? spec.value : 0;
          };
          const dispatch = (e) => {
            const kc = KEYCODE_MAP[e.key] ?? 0;
            const kbd = new KeyboardEvent(e.type === 'down' ? 'keydown' : 'keyup', {
              key: e.key,
              code: e.code,
              bubbles: true,
              cancelable: true,
            });
            Object.defineProperty(kbd, 'keyCode', { get: () => kc });
            Object.defineProperty(kbd, 'which', { get: () => kc });
            document.dispatchEvent(kbd);
            setTouchInput(e);
            window._replayFired++;
          };
          const fire = (e, f) => {
            if (e.type !== 'up') {
              dispatch(e);
              return;
            }
            const prevDown = window._replayEvents
              .slice(0, window._replayNext)
              .reverse()
              .find((p) => p.key === e.key && p.type === 'down');
            const minFrame = prevDown ? prevDown.frame + minHoldFrames : e.frame;
            const targetFrame = Math.max(e.frame, minFrame);
            if (f >= targetFrame) dispatch(e);
            else window._replayPendingUps.push({ event: e, targetFrame });
          };
          // Use the C frame counter directly (bypasses KNState property hook issues)
          const poll = () => {
            const mod = window.EJS_emulator?.gameManager?.Module;
            const f = mod?._kn_get_frame?.() ?? (window.KNState?.frameNum || 0);
            if (f !== window._replayLastFrame) {
              window._replayLastFrame = f;
              if (window._replayPendingUps.length) {
                const stillPending = [];
                for (const pending of window._replayPendingUps) {
                  if (f >= pending.targetFrame) dispatch(pending.event);
                  else stillPending.push(pending);
                }
                window._replayPendingUps = stillPending;
              }
              while (
                window._replayNext < window._replayEvents.length &&
                window._replayEvents[window._replayNext].frame <= f
              ) {
                fire(window._replayEvents[window._replayNext++], f);
              }
            }
          };
          window._replayTimerId = setInterval(poll, 8);
        },
        { events, label, minHoldFrames: REPLAY_MIN_HOLD_FRAMES, syntheticInput: SYNTHETIC_INPUT },
      );
    }

    const hostEvents = rec.events.filter((e) => e.window === 'host');
    const guestEvents = rec.events.filter((e) => e.window === 'guest');
    await installReplay(host.page, hostEvents, 'host');
    await installReplay(guest.page, guestEvents, 'guest');
    console.log(`  installed frame-exact replay: host=${hostEvents.length}ev guest=${guestEvents.length}ev`);

    // Poll fired count + frame counts only (no event injection — browser does that)
    const deadline = Date.now() + 180_000;
    let replayComplete = false;
    let lastReplayState = { hFired: 0, gFired: 0, hf: 0, gf: 0 };
    let cssProbeDone = false;
    while (Date.now() < deadline) {
      const hFired = await host.page.evaluate(() => window._replayFired || 0).catch(() => 0);
      const gFired = await guest.page.evaluate(() => window._replayFired || 0).catch(() => 0);
      const hf = await host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
      const gf = await guest.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
      lastReplayState = { hFired, gFired, hf, gf };
      process.stdout.write(
        `\r  host: ${hFired}/${hostEvents.length} f=${hf} | guest: ${gFired}/${guestEvents.length} f=${gf} gap=${Math.abs(hf - gf)}   `,
      );
      if (CSS_PROBE && !cssProbeDone && hf >= CSS_PROBE_MIN_FRAME && gf >= CSS_PROBE_MIN_FRAME) {
        const [hs, gs] = await Promise.all([readScene(host.page).catch(() => 0), readScene(guest.page).catch(() => 0)]);
        if (hs === SCENE_PLAYERS_VS && gs === SCENE_PLAYERS_VS) {
          cssProbeDone = true;
          console.log(`\n  CSS probe trigger: host f=${hf} guest f=${gf} scene=${hs}`);
          await captureCssGraphicsProbe(host, guest, hostBrowser, guestBrowser, 'css-probe');
          return;
        }
      }
      if (hFired >= hostEvents.length && gFired >= guestEvents.length) {
        replayComplete = true;
        break;
      }
      await host.page.waitForTimeout(500);
    }
    if (!replayComplete) {
      console.log('');
      await shot(host.page, 'replay-timeout-host');
      await shot(guest.page, 'replay-timeout-guest');
      throw new Error(
        `Replay did not complete: ` +
          `host ${lastReplayState.hFired}/${hostEvents.length} f=${lastReplayState.hf}, ` +
          `guest ${lastReplayState.gFired}/${guestEvents.length} f=${lastReplayState.gf}`,
      );
    }
    console.log(`\n  all events fired. Waiting for match auto-start (final_frame=${rec.final_frame_host})...`);
    await waitForFrame(host.page, rec.final_frame_host, 60000, 50).catch((e) =>
      console.log(`  [warn] host final frame: ${e.message}`),
    );
    await waitForFrame(guest.page, rec.final_frame_guest, 60000, 50).catch((e) =>
      console.log(`  [warn] guest final frame: ${e.message}`),
    );
    console.log('  waiting for both peers to enter VS Battle...');
    await requireBothInVsBattle(host, guest, 'replay-post-nav', hostBrowser, guestBrowser);
    await host.page.waitForTimeout(1000);
    await shot(host.page, '09-match-host');
    await shot(guest.page, '09-match-guest');
    const setupAlignment = await requireMatchSetupAligned(host, guest, 'replay-post-nav', hostBrowser, guestBrowser);
    if (SETUP_ONLY) {
      await finishSetupOnly(host, guest, hostBrowser, guestBrowser, 'replay-post-nav', setupAlignment);
      return;
    }
    await enablePostSetupNetsim(host, guest);

    if (process.env.KN_DET_WATCH === '1') {
      await Promise.all(
        [host.page, guest.page].map((page) =>
          page
            .evaluate(() => {
              const mod = window.EJS_emulator?.gameManager?.Module;
              mod?._kn_det_watch_enable?.(1, 4400, 4900);
            })
            .catch(() => {}),
        ),
      );
      console.log('  enabled DET-WATCH for RNG/FT writes across f=4400..4900');
    }

    // === MULTI-CHECKPOINT RDRAM CAPTURE (replay path) ===
    // Capture RDRAM at regular intervals from end-of-replay through gameplay
    // entry to find the exact frame where cross-peer divergence begins.
    console.log(LIGHT_CAPTURE ? '\n=== Light checkpoint monitoring ===' : '\n=== Multi-checkpoint RDRAM capture ===');
    async function dumpRdramToFile(page, label) {
      const b64 = await page
        .evaluate(async () => {
          const mod = window.EJS_emulator?.gameManager?.Module;
          if (!mod?._kn_get_rdram_ptr) return null;
          const ptr = mod._kn_get_rdram_ptr();
          const u8 = new Uint8Array(mod.HEAPU8.buffer, ptr, 0x800000);
          const snap = new Uint8Array(u8);
          let bin = '';
          for (let i = 0; i < snap.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, snap.subarray(i, i + 0x8000));
          }
          return btoa(bin);
        })
        .catch(() => null);
      if (!b64) {
        console.log(`  ${label}: capture failed`);
        return;
      }
      const { writeFileSync } = await import('fs');
      const buf = Buffer.from(b64, 'base64');
      const path = `/tmp/rdram-${label}.bin`;
      writeFileSync(path, buf);
      console.log(`  ${label}: ${buf.length} bytes → ${path}`);
    }
    // Checkpoint grid targeting the cross-JIT divergence window.
    // 2026-04-24 clean-hash run (match 52dd75cb): lastGood=rb.frame=2400,
    // first RB-CHECK MISMATCH=rb.frame=2774. Since `_getGameFrame()` was
    // changed to `_kn_get_frame()` which tracks rb.frame directly, the
    // "gf" in RB-CHECK messages now matches local KNState.frameNum space
    // 1:1. CP_FRAMES straddle the divergence: couple pre-divergence
    // reference points, dense grid through the divergence window, one
    // post for post-divergence state.
    /* 2026-04-25: extended grid to cover ~3 minutes of gameplay so the
     * continuous cross-peer screenshot capture has time to record the
     * full divergence arc. Match starts ~f=2107, gameplay continues
     * past f=12000. CP grid every 500 frames in the late window keeps
     * RDRAM dumps tractable while spacing screenshot pairs.
     *
     * Original sparse grid (kept comment for context): [2300, 2700, 3000,
     * 3100, 3200, 3300, 3400, 3500, 3600, 3700] — covered the early
     * divergence window only. */
    const CP_FRAMES = LIGHT_CAPTURE
      ? [2300, 2460, 2500, 2700, 3000, 3300, 3600]
      : [
          2300, 2700, 3000, 3100, 3200, 3300, 3400, 3500, 3600, 3700, 4000, 4500, 5000, 5500, 6000, 7000, 8000, 9000,
          10000, 11000, 12000,
        ];

    /* Kick off random input IMMEDIATELY in parallel with checkpoint captures
     * so we don't burn ~30s of wall clock waiting sequentially for frames to
     * arrive before inputs start. The random input loop races against the
     * desync monitor — both exit fast once we've got the divergence signal. */
    const inputAbort = new AbortController();
    const desyncAbort = new AbortController();
    const inputKeys = [KEY.A, KEY.B, KEY.Z, KEY.L, KEY.R, KEY.ANA_LEFT, KEY.ANA_RIGHT, KEY.ANA_UP, KEY.ANA_DOWN];
    let replayMatchEnd = null;
    let inputTaskError = null;
    /* Asymmetric random-input stress — different key per peer each
     * tick, exercising real netplay input broadcasting. The symmetric
     * diagnostic variant (same key to both peers) was used 2026-04-24
     * to confirm the ±1 motion_count delta is input-delay jitter, not
     * a sim bug. See project_cross_jit_hunt_apr24.md for the verdict. */
    const inputTask = NO_RANDOM_INPUTS
      ? Promise.resolve()
      : (async () => {
          while (!inputAbort.signal.aborted) {
            const battleState = await readBothBattleStates(host, guest);
            if (!battleState.host.active || !battleState.guest.active) {
              replayMatchEnd = await resolveBattleEnd(host, guest, battleState, 'replay-random-input');
              if (replayMatchEnd) {
                console.log(`\n  Match ended during replay random-input phase: ${formatBattleState(replayMatchEnd)}`);
                inputAbort.abort();
                desyncAbort.abort();
                break;
              }
            }
            const hk = inputKeys[randomInt(inputKeys.length)];
            const gk = inputKeys[randomInt(inputKeys.length)];
            Promise.all([keyDown(host.page, hk), keyDown(guest.page, gk)]).catch(() => {});
            await new Promise((r) => setTimeout(r, 80));
            Promise.all([keyUp(host.page, hk), keyUp(guest.page, gk)]).catch(() => {});
            await new Promise((r) => setTimeout(r, RANDOM_INPUT_INTERVAL_MS - 80));
            inputCount++;
          }
        })().catch((err) => {
          inputTaskError = err;
          inputAbort.abort();
          desyncAbort.abort();
        });
    if (NO_RANDOM_INPUTS) console.log('  --no-inputs: skipping random input generator (idle-fighter diagnostic)');
    const lateJoinTask = LATE_JOIN_MIDMATCH
      ? runMidmatchLateJoin(host, guest, chromiumArgs).then((result) => {
          lateJoinResult = result;
          return result;
        })
      : null;

    /* 2026-04-25: continuous canvas-clipped cross-peer screenshot capture
     * during the replay+input parallel phase. Saves /tmp/det-live-NNN-hfX-gfY-{host,guest}.png
     * every 1s so DeepSeek/Claude can compare the divergence arc visually
     * after the run. Runs in the background and is stopped when CP loop ends. */
    const stopLiveCapture = LIGHT_CAPTURE
      ? () => ({ captured: 0, failed: 0 })
      : startContinuousCapture(host, guest, 1000);

    const desyncTask = waitForDesync([host.page, guest.page], {
      timeoutMs: GAMEPLAY_DURATION_MS,
      pollMs: DESYNC_POLL_MS,
      abortSignal: desyncAbort.signal,
      minFrame: Math.min(rec.final_frame_host, rec.final_frame_guest),
    });

    let desyncInfo = null;
    /* Accumulator for state-diff events. First observation is captured
     * in stateDiffFirst; subsequent ones logged to the console but
     * don't break the CP loop — we want the full grid. */
    let stateDiffFirst = null;
    /* 2026-04-24 resume: keep capturing the full CP grid regardless of
     * SSIM/hash early-exit signals. Those signals were hiding the
     * state-diff data right where we need it most (gf=2500..3000, the
     * divergence window). If desyncTask settled, log it once but
     * continue the loop — the CP captures + state-diff per CP are what
     * we actually use to find fixable bugs. */
    let desyncLogged = false;
    for (const cp of CP_FRAMES) {
      if (replayMatchEnd) break;
      const battleBeforeCp = await readBothBattleStates(host, guest);
      if (!battleBeforeCp.host.active || !battleBeforeCp.guest.active) {
        replayMatchEnd = await resolveBattleEnd(host, guest, battleBeforeCp, 'replay-checkpoint');
        if (replayMatchEnd) {
          console.log(`  Match ended before checkpoint f=${cp}: ${formatBattleState(replayMatchEnd)}`);
          inputAbort.abort();
          desyncAbort.abort();
          break;
        }
      }
      await Promise.all([
        waitForFrame(host.page, cp, 15000, 25).catch(() => {}),
        waitForFrame(guest.page, cp, 15000, 25).catch(() => {}),
      ]);
      const battleAfterCp = await readBothBattleStates(host, guest);
      if (!battleAfterCp.host.active || !battleAfterCp.guest.active) {
        replayMatchEnd = await resolveBattleEnd(host, guest, battleAfterCp, 'replay-checkpoint');
        if (replayMatchEnd) {
          console.log(`  Match ended at checkpoint f=${cp}: ${formatBattleState(replayMatchEnd)}`);
          inputAbort.abort();
          desyncAbort.abort();
          break;
        }
      }
      if (!desyncLogged) {
        /* Non-blocking peek at desyncTask — see if it's settled. */
        const peeked = await Promise.race([
          desyncTask.then((info) => ({ settled: true, info })),
          new Promise((r) => setTimeout(() => r({ settled: false }), 10)),
        ]);
        if (peeked.settled && peeked.info) {
          desyncInfo = peeked.info;
          desyncLogged = true;
          console.log(
            `  [DESYNC trigger=${desyncInfo.trigger}] ${
              desyncInfo.trigger === 'ssim'
                ? `localFrame=${desyncInfo.localFrame} ssim=${desyncInfo.ssim?.toFixed(3)} slots=${desyncInfo.slots?.join(',')}`
                : `slot=${desyncInfo.slot} gf=${desyncInfo.gameFrame} lastGood=${desyncInfo.lastGood} localFrame=${desyncInfo.localFrame}`
            } after ${(desyncInfo.elapsedMs / 1000).toFixed(1)}s — continuing CP grid for state-diff capture`,
          );
        }
      }
      if (!LIGHT_CAPTURE) {
        await Promise.all([dumpRdramToFile(host.page, `host-f${cp}`), dumpRdramToFile(guest.page, `guest-f${cp}`)]);
      }
      /* Per-field cross-peer state-diff check. Reads gameplay_addrs
       * live values from both peers and compares field-by-field. Any
       * divergence means real state drift at this local frame — the
       * kind SSIM can miss when the visual happens to look similar
       * (2026-04-24: motion_count differed by 14 while SSIM stayed 0.94).
       * Logs divergence but does NOT early-exit — we want the full CP
       * grid to see how the drift evolves. */
      /* Subsystem-level cross-peer diff (every CP, before gameplay-addr).
       * If state diverges, this points at the first subsystem to diverge
       * (FPU, AI, RSP, etc.) — much more useful than just "gameplay
       * addresses differ". Logged at every CP regardless of STATE-DIFF
       * because subsystem drift can precede gameplay-addr divergence. */
      const subsysDiffs = await checkSubsysDrift(host.page, guest.page);
      if (subsysDiffs && subsysDiffs.length > 0) {
        const sStr = subsysDiffs
          .slice(0, 8)
          .map((d) => `${d.idx}:${d.name}(h=0x${d.h.toString(16)},g=0x${d.g.toString(16)})`)
          .join(' ');
        console.log(`  f=${cp}: SUBSYS-DIFF ${subsysDiffs.length}/18 — ${sStr}`);
      }
      const stateDiffs = await checkStateDrift(host.page, guest.page);
      if (stateDiffs && stateDiffs.length > 0) {
        const summary = stateDiffs
          .slice(0, 6)
          .map((d) => `idx=${d.idx}:h=0x${d.host.toString(16)}/g=0x${d.guest.toString(16)}`)
          .join(' ');
        const more = stateDiffs.length > 6 ? `…+${stateDiffs.length - 6}` : '';
        console.log(`  f=${cp}: STATE-DIFF ${stateDiffs.length} fields diverge — ${summary}${more}`);
        /* 2026-04-25: at every STATE-DIFF, ALSO sample rollback stats and
         * input window cross-peer. This tells us whether the divergence
         * correlates with asymmetric rollbacks or with input mismatch.
         * The hypothesis: replay non-determinism is the desync source,
         * and asymmetric rollback frequency proves both peers are
         * triggering rollbacks differently because of input timing. */
        const [hStats, gStats] = await Promise.all([sampleRollbackStats(host.page), sampleRollbackStats(guest.page)]);
        if (hStats && gStats) {
          const dRb = hStats.rollbacks - gStats.rollbacks;
          const dPred = hStats.predictions - gStats.predictions;
          const dCorrect = hStats.correct - gStats.correct;
          console.log(
            `  f=${cp}: RB-STATS h={rb=${hStats.rollbacks},maxD=${hStats.maxDepth},pred=${hStats.predictions},correct=${hStats.correct},failed=${hStats.failed}} ` +
              `g={rb=${gStats.rollbacks},maxD=${gStats.maxDepth},pred=${gStats.predictions},correct=${gStats.correct},failed=${gStats.failed}} ` +
              `Δrb=${dRb} Δpred=${dPred} Δcorrect=${dCorrect}`,
          );
        }
        const [hInputs, gInputs] = await Promise.all([
          sampleInputWindow(host.page, cp, 16),
          sampleInputWindow(guest.page, cp, 16),
        ]);
        const inputDiffs = diffInputWindows(hInputs, gInputs);
        if (inputDiffs && inputDiffs.length > 0) {
          const inSum = inputDiffs
            .slice(0, 4)
            .map(
              (d) =>
                `s${d.slot}f${d.frame}:h=${d.h?.btn ?? '_'}/${d.h?.lx ?? 0},${d.h?.ly ?? 0} g=${d.g?.btn ?? '_'}/${d.g?.lx ?? 0},${d.g?.ly ?? 0}`,
            )
            .join(' | ');
          console.log(`  f=${cp}: INPUT-DIFF ${inputDiffs.length} divergent slot/frames — ${inSum}`);
        } else if (hInputs && gInputs) {
          console.log(`  f=${cp}: INPUT-OK frames ${hInputs.startF}-${hInputs.endF} (cross-peer inputs match)`);
        }
        /* Per-peer replay determinism self-test. With same input both
         * passes, any diff is proven replay non-determinism — the bug
         * we're hunting. Cap to once per ~3 STATE-DIFF events to limit
         * cost (each call does 2 extra retro_run() calls). */
        /* 2026-04-25: FAITHFUL/FWD-REPLAY checks disabled.
         *
         * They invoke retro_serialize/retro_run/retro_unserialize directly
         * from inside the main rAF loop. retro_run is normally driven by
         * Asyncify-aware stepOneFrame; recursive invocation outside that
         * path can corrupt the Emscripten runner table, manifesting as
         * "table index is out of bounds" + "memory access out of bounds"
         * traps a few hundred frames later. Confirmed: every guest crash
         * in test #17 followed an f%300==0 boundary where these fire.
         *
         * We've already proven via these checks that replay is bit-faithful
         * within-peer (test #5 & later: FAITHFUL CLEAN). Re-running the
         * check periodically buys nothing and risks crashes. */
        // if (cp % 300 === 0) { ... } DISABLED
        /* Record the FIRST state-diff observation into a separate
         * accumulator, NOT into desyncInfo. We want to keep capturing
         * all CPs so we can see how the drift evolves — state-diff
         * alone is informational, not an early-exit trigger. */
        if (!stateDiffFirst) {
          stateDiffFirst = {
            localFrame: cp,
            fields: stateDiffs.length,
            firstIdx: stateDiffs[0].idx,
            host: stateDiffs[0].host,
            guest: stateDiffs[0].guest,
          };
        }
      } else if (stateDiffs) {
        console.log(`  f=${cp}: state-diff clean (0 fields diverge)`);
      }
      /* Fighter-buffer byte-diff. Catches user-visible desyncs
       * (positions, damage %, velocities, anim state) that live in the
       * FTStruct array — not in gameplay_addrs. Sampled in parallel
       * with the state-diff check. */
      const fighterDiff = await checkFighterDrift(host.page, guest.page);
      if (fighterDiff && fighterDiff.diffCount > 0) {
        const topRegions = fighterDiff.regions
          .slice()
          .sort((a, b) => b.size - a.size)
          .slice(0, 3)
          .map((r) => `0x${r.start.toString(16)}-0x${r.end.toString(16)}(${r.size}b)`)
          .join(',');
        /* Dump byte values at the first 3 diverging offsets so we can
         * tell if these are 1-frame-offset timer jitter (Δ=1) or a
         * real branch divergence (Δ=many or flag-bit flip). */
        const [h, g] = await Promise.all([sampleFighterBuffer(host.page), sampleFighterBuffer(guest.page)]);
        const valsSummary = fighterDiff.regions
          .slice(0, 4)
          .map((r) => {
            const hv = h
              .slice(r.start, r.end)
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('');
            const gv = g
              .slice(r.start, r.end)
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('');
            return `0x${r.start.toString(16)}:h=${hv}/g=${gv}`;
          })
          .join(' ');
        console.log(
          `  f=${cp}: FIGHTER-DIFF ${fighterDiff.diffCount}/${fighterDiff.totalBytes} bytes diverge first=0x${fighterDiff.firstDiff.toString(16)} top_regions=${topRegions} vals=[${valsSummary}]`,
        );
      } else if (fighterDiff) {
        console.log(`  f=${cp}: fighter-diff clean (0 bytes diverge)`);
      }
      /* Emulator-level timing check. Prints CP0 Count and any diverging
       * hidden-state fields (CP0 Count, next interrupt cycle, instr
       * count, event queue hash, SoftFloat state, ...). If any of these
       * differ cross-peer, emulator timing itself is diverging — which
       * would be the upstream source of the status_total_tics drift. */
      const timing = await checkTimingDrift(host.page, guest.page);
      if (timing) {
        const hiddenSummary = timing.hiddenDiffs.length
          ? ` hidden_diff=[${timing.hiddenDiffs.map((d) => `idx${d.idx}:h=0x${d.h.toString(16)}/g=0x${d.g.toString(16)}/Δ=${d.delta}`).join(' ')}]`
          : ' hidden=match';
        console.log(
          `  f=${cp}: TIMING cp0_h=${timing.cp0h} cp0_g=${timing.cp0g} cp0_Δ=${timing.cp0Delta}${hiddenSummary}`,
        );
      }
    }

    /* If we haven't seen desync yet, let random input run until the
     * deadline OR desync fires, whichever comes first. Either way,
     * capture a final desync-moment RDRAM dump for offline diff. */
    if (!desyncInfo && !replayMatchEnd) {
      console.log(
        `  checkpoints done, continuing random input until desync or ${(GAMEPLAY_DURATION_MS / 1000).toFixed(0)}s cap...`,
      );
      desyncInfo = await desyncTask;
      if (desyncInfo) {
        console.log(
          `\n  [DESYNC trigger=${desyncInfo.trigger}] ${
            desyncInfo.trigger === 'ssim'
              ? `localFrame=${desyncInfo.localFrame} ssim=${desyncInfo.ssim?.toFixed(3)} slots=${desyncInfo.slots?.join(',')}`
              : `slot=${desyncInfo.slot} gf=${desyncInfo.gameFrame} lastGood=${desyncInfo.lastGood} localFrame=${desyncInfo.localFrame}`
          } after ${(desyncInfo.elapsedMs / 1000).toFixed(1)}s`,
        );
      } else {
        console.log(`  no desync within cap — full ${(GAMEPLAY_DURATION_MS / 1000).toFixed(0)}s elapsed`);
      }
    } else {
      desyncAbort.abort();
    }

    /* Stop feeding inputs (they'll get spurious key-up after abort). */
    inputAbort.abort();
    await inputTask;
    if (inputTaskError) throw inputTaskError;
    if (replayMatchEnd) matchEndInfo = replayMatchEnd;
    if (lateJoinTask) {
      lateJoinResult = await lateJoinTask;
    }
    const [hRuntime, gRuntime] = await Promise.all([sampleRuntimeStats(host.page), sampleRuntimeStats(guest.page)]);
    logRuntimeStats('final', hRuntime, gRuntime);

    /* Stop continuous cross-peer screenshot capture and report stats. */
    const liveStats = stopLiveCapture();
    console.log(
      `  Continuous capture: ${liveStats.captured} cross-peer pairs (${liveStats.failed} failed) → /tmp/det-live-*-{host,guest}.png`,
    );

    /* One more RDRAM snapshot at the moment of (or immediately after)
     * desync for the post-divergence diff. */
    if (desyncInfo) {
      const tag =
        desyncInfo.trigger === 'ssim'
          ? `desync-ssim${desyncInfo.ssim?.toFixed(3).replace('.', '')}-f${desyncInfo.localFrame}`
          : desyncInfo.trigger === 'state-diff'
            ? `desync-statediff-f${desyncInfo.localFrame}-idx${desyncInfo.firstIdx}`
            : `desync-gf${desyncInfo.gameFrame}`;
      if (!LIGHT_CAPTURE) {
        await Promise.all([dumpRdramToFile(host.page, `host-${tag}`), dumpRdramToFile(guest.page, `guest-${tag}`)]);
      }
      await Promise.all([shot(host.page, '10-desync-host'), shot(guest.page, '10-desync-guest')]);
      if (desyncInfo.trigger === 'hash') {
        const inputEnd = Math.max(0, desyncInfo.gameFrame - 4);
        const [hInputs, gInputs] = await Promise.all([
          sampleInputWindow(host.page, inputEnd, 80),
          sampleInputWindow(guest.page, inputEnd, 80),
        ]);
        const inputDiffs = diffInputWindows(hInputs, gInputs);
        if (inputDiffs && inputDiffs.length > 0) {
          const inSum = inputDiffs
            .slice(0, 8)
            .map(
              (d) =>
                `s${d.slot}f${d.frame}:h=${d.h?.btn ?? '_'}/${d.h?.lx ?? 0},${d.h?.ly ?? 0} g=${d.g?.btn ?? '_'}/${d.g?.lx ?? 0},${d.g?.ly ?? 0}`,
            )
            .join(' | ');
          console.log(
            `  desync input window ending f=${inputEnd}: INPUT-DIFF ${inputDiffs.length} divergent slot/frames — ${inSum}`,
          );
        } else if (hInputs && gInputs) {
          console.log(`  desync input window ending f=${inputEnd}: INPUT-OK frames ${hInputs.startF}-${hInputs.endF}`);
        }
      }
    }
    const stateDiffSummary = stateDiffFirst
      ? `, STATE-DIFF@f=${stateDiffFirst.localFrame} firstIdx=${stateDiffFirst.firstIdx} h=0x${stateDiffFirst.host.toString(16)} g=0x${stateDiffFirst.guest.toString(16)}`
      : ', page-latch clean; admin RB-CHECK not pulled yet';
    console.log(`=== Captures complete (inputs=${inputCount}${desyncInfo ? ', DESYNC' : ''}${stateDiffSummary}) ===\n`);
    runDesyncInfo = desyncInfo;
  } else {
    if (MANUAL_SETUP) {
      console.log('\n=== MANUAL SETUP MODE ===');
      console.log(
        'Navigate the visible peers into the same VS Battle. Random-input stress starts only after both are in active scene 22 and setup fields match.',
      );
      await requireBothInVsBattle(host, guest, 'manual-post-nav', hostBrowser, guestBrowser);
      await shot(host.page, '09-manual-gameplay-host');
      await shot(guest.page, '09-manual-gameplay-guest');
      const setupAlignment = await requireMatchSetupAligned(host, guest, 'manual-post-nav', hostBrowser, guestBrowser);
      if (SETUP_ONLY) {
        await finishSetupOnly(host, guest, hostBrowser, guestBrowser, 'manual-post-nav', setupAlignment);
        return;
      }
      await enablePostSetupNetsim(host, guest);
    } else {
      // ==================== SCRIPTED NAV ====================
      // kn-sync startup usually begins from the captured "PRESS START" title
      // state. Older savestate startup may still play through splashes first.
      // Wait only for the runner to be live here; Step 1 catches the next
      // actual title frame and presses START immediately so the harness does
      // not wait itself into the attract loop.
      console.log('Waiting for both emulators to start menu ticking...');
      await waitForFrame(host.page, 60, 90000);
      await waitForFrame(guest.page, 60, 90000);
      await host.page.waitForTimeout(1000);
      const hf = await host.page.evaluate(() => window.KNState?.frameNum || 0);
      const gf = await guest.page.evaluate(() => window.KNState?.frameNum || 0);
      console.log(`Both menu runners live (host=${hf} guest=${gf}).\n`);

      // === NAVIGATION ===
      // SSB64 / Smash Remix menu flow, host-driven (netplay syncs inputs on P1 slot;
      // only the guest's A press on CSS registers for P2). Each step has a screenshot.
      //
      //   Title       → START → Mode Select (1P MODE highlighted)
      //   Mode Select → analog down → VS MODE → A → VS options
      //   VS options  → A → CSS (default: Stock Match)
      //   CSS         → host A (picks P1), guest A (picks P2) → START → SSS
      //   SSS         → A → Match begins

      async function hostPress(key, holdMs = 200, waitAfter = 2500) {
        await host.page.bringToFront();
        await host.page.focus('body').catch(() => {});
        await press(host.page, key, holdMs);
        await host.page.waitForTimeout(waitAfter);
        const f = await host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
        console.log(`    [host f=${f} after ${key}]`);
      }
      async function guestPress(key, holdMs = 200, waitAfter = 2500) {
        await guest.page.bringToFront();
        await guest.page.focus('body').catch(() => {});
        await press(guest.page, key, holdMs);
        await guest.page.waitForTimeout(waitAfter);
        const f = await guest.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
        console.log(`    [guest f=${f} after ${key}]`);
      }
      async function waitForVisibleCharacterSelect(timeoutMs = 30000) {
        const start = Date.now();
        let last = null;
        while (Date.now() - start < timeoutMs) {
          const [hostScene, guestScene, hostVsStart, guestVsStart] = await Promise.all([
            readScene(host.page),
            readScene(guest.page),
            sampleVsStartOptionsVisible(host.page),
            sampleVsStartOptionsVisible(guest.page),
          ]);
          last = { hostScene, guestScene, hostVsStart, guestVsStart };
          const bothInPlayersVs = hostScene === SCENE_PLAYERS_VS && guestScene === SCENE_PLAYERS_VS;
          if (bothInPlayersVs && !hostVsStart.looksLikeVsStart && !guestVsStart.looksLikeVsStart) {
            console.log(
              `    [visible CSS ready: host f=${hostVsStart.frame} guest f=${guestVsStart.frame} white=${hostVsStart.whiteRatio}/${guestVsStart.whiteRatio}]`,
            );
            return last;
          }
          if (bothInPlayersVs && (hostVsStart.looksLikeVsStart || guestVsStart.looksLikeVsStart)) {
            console.log(
              `    [scene ${SCENE_PLAYERS_VS} still VS START/options; pressing A ` +
                `white=${hostVsStart.whiteRatio}/${guestVsStart.whiteRatio}]`,
            );
            await hostPress(KEY.A, 300, 700);
            continue;
          }
          await host.page.waitForTimeout(100);
        }
        throw new Error(`Timeout waiting for visible character select; last=${JSON.stringify(last)}`);
      }
      async function hostPressStartOnNextTitle(timeoutMs = 180000) {
        const start = Date.now();
        let attempts = 0;
        let lastTitleWaitLog = 0;
        while (Date.now() - start < timeoutMs) {
          const [hostScene, guestScene, hostTitle, guestTitle] = await Promise.all([
            readScene(host.page),
            readScene(guest.page),
            sampleTitleReadyVisible(host.page),
            sampleTitleReadyVisible(guest.page),
          ]);
          if (hostScene === SCENE_MODE_SELECT && guestScene === SCENE_MODE_SELECT) return;
          if (hostScene === SCENE_MODE_SELECT || guestScene === SCENE_MODE_SELECT) {
            throw new Error(
              `Title START split peers before both title screens were visually ready: ` +
                `hostScene=${hostScene} guestScene=${guestScene} hostTitle=${JSON.stringify(hostTitle)} guestTitle=${JSON.stringify(guestTitle)}`,
            );
          }
          if (hostScene === SCENE_TITLE && guestScene === SCENE_TITLE && hostTitle.ready && guestTitle.ready) {
            attempts += 1;
            const [hfNow, gfNow] = await Promise.all([
              host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0),
              guest.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0),
            ]);
            console.log(
              `    [scene ${SCENE_TITLE} title attempt ${attempts}: host f=${hfNow} guest f=${gfNow} ` +
                `pink=${hostTitle.pinkRatio}/${guestTitle.pinkRatio}]`,
            );
            await host.page.bringToFront();
            await host.page.focus('body').catch(() => {});
            await press(host.page, KEY.START, 300);

            const modeDeadline = Date.now() + 6000;
            while (Date.now() < modeDeadline) {
              const [hAfter, gAfter] = await Promise.all([readScene(host.page), readScene(guest.page)]);
              if (hAfter === SCENE_MODE_SELECT && gAfter === SCENE_MODE_SELECT) {
                const [hfMode, gfMode] = await Promise.all([
                  host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0),
                  guest.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0),
                ]);
                console.log(`    [scene ${SCENE_MODE_SELECT} mode-select: host f=${hfMode} guest f=${gfMode}]`);
                return;
              }
              await host.page.waitForTimeout(50);
            }
            const [hCur, gCur] = await Promise.all([readScene(host.page), readScene(guest.page)]);
            console.log(
              `    [warn] START at title did not reach Mode Select; hostScene=${hCur} guestScene=${gCur}; waiting for next title`,
            );
            await Promise.all([
              shot(host.page, `01-title-start-failed-${attempts}-host`, { canvas: true }),
              shot(guest.page, `01-title-start-failed-${attempts}-guest`, { canvas: true }),
            ]);
            await requireNoSolidPaleCanvas(host, guest, `title-start-failed-${attempts}`, hostBrowser, guestBrowser);
          } else if (Date.now() - lastTitleWaitLog > 3000) {
            lastTitleWaitLog = Date.now();
            console.log(
              `    [waiting title-ready host scene=${hostScene} ready=${!!hostTitle.ready} ` +
                `pink=${hostTitle.pinkRatio ?? '?'} guest scene=${guestScene} ready=${!!guestTitle.ready} ` +
                `pink=${guestTitle.pinkRatio ?? '?'}]`,
            );
          }
          await host.page.waitForTimeout(50);
        }
        const [hCur, gCur] = await Promise.all([readScene(host.page), readScene(guest.page)]);
        const [hostForensics, guestForensics] = await Promise.all([
          samplePageForensics(host),
          samplePageForensics(guest),
        ]);
        await Promise.allSettled([
          shot(host.page, 'title-start-timeout-host', { canvas: true }),
          shot(guest.page, 'title-start-timeout-guest', { canvas: true }),
          shot(host.page, 'title-start-timeout-full-host'),
          shot(guest.page, 'title-start-timeout-full-guest'),
        ]);
        writeFileSync(
          REPORT_FILE,
          JSON.stringify(
            {
              room: ROOM,
              verdict: 'TITLE_START_TIMEOUT',
              reason: 'START did not move both peers from title to mode select before timeout',
              hostScene: hCur,
              guestScene: gCur,
              host: hostForensics,
              guest: guestForensics,
              screenshots: {
                host: `${SHOT_DIR}/det-title-start-timeout-host.png`,
                guest: `${SHOT_DIR}/det-title-start-timeout-guest.png`,
                hostFull: `${SHOT_DIR}/det-title-start-timeout-full-host.png`,
                guestFull: `${SHOT_DIR}/det-title-start-timeout-full-guest.png`,
              },
            },
            null,
            2,
          ),
        );
        throw new Error(`Timeout pressing START from title; hostScene=${hCur} guestScene=${gCur}`);
      }

      console.log('Step 1: Wait for title screen, press START → Mode Select');
      await hostPressStartOnNextTitle();
      await shot(host.page, '02-mode-select-host');
      await shot(guest.page, '02-mode-select-guest');

      console.log('Step 2: Mode Select → analog down (1P MODE → VS MODE)');
      await hostPress(KEY.ANA_DOWN, 80, 1000);
      await shot(host.page, '03-vs-highlighted-host');

      console.log('Step 3: A → enter VS MODE');
      await hostPress(KEY.A, 300, 500);
      await waitForBothScene(host, guest, SCENE_VS_MODE, 'vs-mode', 30000);
      await shot(host.page, '04-vs-options-host');

      console.log('Step 4: A → confirm VS MODE entry');
      await hostPress(KEY.A, 300, 500);
      const postVsScene = await waitForAnyScene(host.page, [SCENE_VS_OPTIONS, SCENE_PLAYERS_VS], 30000, 50);
      if (postVsScene === SCENE_VS_OPTIONS) {
        await waitForBothScene(host, guest, SCENE_VS_OPTIONS, 'vs-options', 30000);
        console.log('Step 4b: A → enter CSS from VS options');
        await hostPress(KEY.A, 300, 500);
      }
      await waitForBothScene(host, guest, SCENE_PLAYERS_VS, 'css-scene', 30000);
      await waitForVisibleCharacterSelect(30000);
      await shot(host.page, '05-css-host');
      await shot(guest.page, '05-css-guest');

      console.log('Step 5: CSS — host picks P1 with recorded random-select path');
      await replayFixtureSegment(
        host,
        'host',
        HOST_RANDOM_SELECT_START_FRAME,
        HOST_RANDOM_SELECT_END_FRAME,
        'P1 random-select',
      );
      await ensureCssRandomSelected(host.page, host.page, 0, 'host view');
      await shot(host.page, '06-p1-picked-host');

      console.log('Step 6: CSS — guest picks P2 with recorded random-select path');
      await replayFixtureSegment(
        guest,
        'guest',
        GUEST_RANDOM_SELECT_START_FRAME,
        NAV_P2_SELECTED_FRAME,
        'P2 random-select',
      );
      await ensureCssRandomSelected(guest.page, host.page, 1, 'host view');
      await shot(host.page, '07-both-picked-host');
      await shot(guest.page, '07-both-picked-guest');

      console.log('Step 7: Stage Select + stage pick with recorded P2 path');
      await replayFixtureSegment(
        guest,
        'guest',
        GUEST_STAGE_SELECT_START_FRAME,
        GUEST_STAGE_PICK_END_FRAME,
        'P2 stage-select',
      );
      await shot(host.page, '08-sss-host');
      await shot(guest.page, '08-sss-guest');

      console.log('Step 8: Waiting for match begin');
      console.log('Waiting for both peers to enter VS Battle...');
      await requireBothInVsBattle(host, guest, 'scripted-post-nav', hostBrowser, guestBrowser);
      await shot(host.page, '09-gameplay-host');
      await shot(guest.page, '09-gameplay-guest');
      const setupAlignment = await requireMatchSetupAligned(
        host,
        guest,
        'scripted-post-nav',
        hostBrowser,
        guestBrowser,
      );
      if (SETUP_ONLY) {
        await finishSetupOnly(host, guest, hostBrowser, guestBrowser, 'scripted-post-nav', setupAlignment);
        return;
      }
      await enablePostSetupNetsim(host, guest);
    }
  } // end else (manual/scripted nav)

  /* Scripted-nav-only: the legacy single-dump + 60s random input loop.
   * REPLAY mode already ran the parallel desync-hunt loop inside the
   * REPLAY_FILE branch above, so skip this block entirely there. */
  if (!REPLAY_FILE) {
    console.log('Waiting for gameplay to stabilize...');
    const startFrame = await host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
    console.log(`  Gameplay started at frame ${startFrame}`);

    // === RDRAM CAPTURE (cross-peer same-frame byte-level diff) ===
    // Capture full 8MB RDRAM from each peer at the SAME target frame so we can
    // run a pointer-aware byte-level diff offline. The diff tool (tools/
    // rdram_diff.py) normalizes 0x80xxxxxx values and identifies real data
    // differences vs pointer-only shifts, cross-referencing with SSB64 decomp
    // addresses to identify what's diverging.
    const CAPTURE_FRAME = startFrame + 300; // 5 sec into gameplay
    console.log(`\n=== Capturing full RDRAM at frame ${CAPTURE_FRAME} ===`);
    // Both peers wait for target frame, then dump 8MB as Uint8Array base64'd back to node.
    async function dumpRdram(page, label) {
      await waitForFrame(page, CAPTURE_FRAME, 15000, 50).catch(() => {});
      const b64 = await page.evaluate(async () => {
        const mod = window.EJS_emulator?.gameManager?.Module;
        if (!mod?._kn_get_rdram_ptr) return null;
        const ptr = mod._kn_get_rdram_ptr();
        const size = 0x800000; // 8 MB
        const u8 = new Uint8Array(mod.HEAPU8.buffer, ptr, size);
        // Snapshot copy so it's stable. Convert to base64 via chunks to avoid stack limits.
        const snap = new Uint8Array(u8);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < snap.length; i += chunk) {
          bin += String.fromCharCode.apply(null, snap.subarray(i, i + chunk));
        }
        return btoa(bin);
      });
      if (!b64) {
        console.log(`  ${label}: _kn_get_rdram_ptr not available`);
        return;
      }
      const { writeFileSync } = await import('fs');
      const buf = Buffer.from(b64, 'base64');
      const path = `/tmp/rdram-${label}.bin`;
      writeFileSync(path, buf);
      console.log(`  ${label}: wrote ${buf.length} bytes to ${path}`);
    }
    await Promise.all([dumpRdram(host.page, 'host'), dumpRdram(guest.page, 'guest')]);

    // === RANDOM INPUT PHASE ===
    console.log(`\n=== Feeding random input for ${GAMEPLAY_DURATION_MS / 1000}s ===`);

    /* 2026-04-25: continuous cross-peer screenshot capture during random
     * gameplay. Saves host+guest pair every 1s to /tmp/det-live-NNN-hfX-gfY-*.png
     * for offline DeepSeek vision comparison. Survives individual page-screenshot
     * failures so partial capture is still useful even if one peer crashes. */
    const stopCapture = startContinuousCapture(host, guest, 1000);

    const endAt = Date.now() + GAMEPLAY_DURATION_MS;
    // Keys that do gameplay things (no START — would pause mid-match).
    const keys = [KEY.A, KEY.B, KEY.Z, KEY.L, KEY.R, KEY.ANA_LEFT, KEY.ANA_RIGHT, KEY.ANA_UP, KEY.ANA_DOWN];
    inputCount = 0;
    let scriptedMatchEnd = null;
    while (Date.now() < endAt) {
      const battleState = await readBothBattleStates(host, guest);
      if (!battleState.host.active || !battleState.guest.active) {
        scriptedMatchEnd = await resolveBattleEnd(host, guest, battleState, 'scripted-random-input');
        if (scriptedMatchEnd) {
          console.log(`\n  Match ended during random-input phase: ${formatBattleState(scriptedMatchEnd)}`);
          break;
        }
      }
      const hostKey = keys[randomInt(keys.length)];
      const guestKey = keys[randomInt(keys.length)];
      // Drive both real keyboard and the virtual-gamepad input state. The
      // latter keeps automation stable when the OS/browser focus model refuses
      // to report document.hasFocus() for a Playwright page.
      Promise.all([keyDown(host.page, hostKey), keyDown(guest.page, guestKey)]).catch(() => {});
      await new Promise((r) => setTimeout(r, 80));
      Promise.all([keyUp(host.page, hostKey), keyUp(guest.page, guestKey)]).catch(() => {});
      await new Promise((r) => setTimeout(r, RANDOM_INPUT_INTERVAL_MS - 80));
      inputCount++;
      if (inputCount % 20 === 0) {
        const hf = await host.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
        const gf = await guest.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
        process.stdout.write(`\r  inputs=${inputCount} host_f=${hf} guest_f=${gf} gap=${Math.abs(hf - gf)}   `);
      }
    }
    if (scriptedMatchEnd) matchEndInfo = scriptedMatchEnd;
    const captureStats = stopCapture();
    console.log(
      `\n  Fed ${inputCount} inputs. Captured ${captureStats.captured} cross-peer pairs (${captureStats.failed} failed).`,
    );

    await shot(host.page, '10-final-host');
    await shot(guest.page, '10-final-guest');

    // === END-OF-GAMEPLAY RDRAM CAPTURE (post-random-input) ===
    // Byte-diff this against the previous dump (pre-random-input, f=2986)
    // to see which RDRAM addresses drifted during the 180s random phase.
    console.log('\n=== Capturing post-random-input RDRAM for drift diff ===');
    async function dumpRdramTo(page, label, suffix) {
      const b64 = await page.evaluate(async () => {
        const mod = window.EJS_emulator?.gameManager?.Module;
        if (!mod?._kn_get_rdram_ptr) return null;
        const ptr = mod._kn_get_rdram_ptr();
        const size = 0x800000;
        const u8 = new Uint8Array(mod.HEAPU8.buffer, ptr, size);
        const snap = new Uint8Array(u8);
        let bin = '';
        const chunk = 0x8000;
        for (let i = 0; i < snap.length; i += chunk) {
          bin += String.fromCharCode.apply(null, snap.subarray(i, i + chunk));
        }
        return btoa(bin);
      });
      if (!b64) {
        console.log(`  ${label}: _kn_get_rdram_ptr unavailable`);
        return;
      }
      const { writeFileSync } = await import('fs');
      const buf = Buffer.from(b64, 'base64');
      const path = `/tmp/rdram-${label}-${suffix}.bin`;
      writeFileSync(path, buf);
      console.log(`  ${label}: wrote ${buf.length} bytes to ${path}`);
    }
    await Promise.all([dumpRdramTo(host.page, 'host', 'post'), dumpRdramTo(guest.page, 'guest', 'post')]);
  } // end if (!REPLAY_FILE)

  // === REPORT ===
  console.log('\nFlushing session logs...');
  await host.page
    .evaluate(() => window._flushSyncLog?.())
    .catch((e) => {
      console.log(`  host flush skipped: ${String(e).split('\n')[0]}`);
    });
  await guest.page
    .evaluate(() => window._flushSyncLog?.())
    .catch((e) => {
      console.log(`  guest flush skipped: ${String(e).split('\n')[0]}`);
    });
  if (lateJoinResult?.peer) {
    await lateJoinResult.peer.page
      .evaluate(() => window._flushSyncLog?.())
      .catch((e) => {
        console.log(`  late flush skipped: ${String(e).split('\n')[0]}`);
      });
  }
  await host.page.waitForTimeout(3000);

  const clientSummaryFor = (peer) => {
    const rbMismatch = peer.clientEvents.filter((e) => e.text.includes('RB-CHECK') && e.text.includes('MISMATCH'));
    const fatal = peer.clientEvents.filter((e) => e.text.match(/FATAL|ABORT|TICK-STUCK/i));
    return {
      rb_check_mismatch: rbMismatch.length,
      fatal: fatal.length,
      first_rb_check_mismatch: rbMismatch[0]?.text?.substring(0, 240) ?? null,
      first_fatal: fatal[0]?.text?.substring(0, 240) ?? null,
    };
  };
  const desyncSummaryFor = async (peer) => {
    const events = await peer.page.evaluate(() => window._knDesyncSuspects || []).catch(() => []);
    const actionable = events.filter((e) => e?.trigger !== 'heartbeat');
    return {
      events: events.length,
      actionable: actionable.length,
      first_actionable: actionable[0] ? JSON.stringify(actionable[0]).substring(0, 400) : null,
    };
  };
  const [hostDesyncEvents, guestDesyncEvents, lateDesyncEvents] = await Promise.all([
    desyncSummaryFor(host),
    desyncSummaryFor(guest),
    lateJoinResult?.peer ? desyncSummaryFor(lateJoinResult.peer) : Promise.resolve(null),
  ]);

  // Closing the pages triggers the pagehide keepalive path, which is the
  // most reliable way to force final session rows into the admin database.
  if (!KEEP_OPEN) {
    await Promise.all([
      hostBrowser.close().catch(() => {}),
      guestBrowser.close().catch(() => {}),
      lateJoinResult?.browser?.close().catch(() => {}),
    ]);
  } else {
    console.log('\nKeeping browser windows open. Stop this command when you are done watching/debugging.');
  }
  await new Promise((r) => setTimeout(r, 2000));

  console.log('Pulling admin logs...');
  let matchEntries = [];
  const logPullDeadline = Date.now() + 30000;
  while (Date.now() < logPullDeadline) {
    const list = await adminGet('/admin/api/session-logs?days=1&limit=20').catch(() => ({ entries: [] }));
    matchEntries = (list.entries || []).filter((e) => e.room === ROOM);
    if (matchEntries.length >= 2) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (matchEntries.length < 2) {
    console.error(`Could not find both peers in session logs (found ${matchEntries.length})`);
    process.exit(1);
  }

  const report = {
    room: ROOM,
    gameplay_ms: GAMEPLAY_DURATION_MS,
    input_count: inputCount,
    desync_latch: runDesyncInfo,
    match_end: matchEndInfo,
    client: {
      host: clientSummaryFor(host),
      guest: clientSummaryFor(guest),
    },
    page_errors: {
      host: host.pageErrors || [],
      guest: guest.pageErrors || [],
      late: lateJoinResult?.peer?.pageErrors || [],
    },
    kn_desync_events: {
      host: hostDesyncEvents,
      guest: guestDesyncEvents,
      late: lateDesyncEvents,
    },
    late_join_midmatch: lateJoinResult
      ? {
          states: lateJoinResult.states,
        }
      : null,
    peers: [],
  };
  for (const entry of matchEntries) {
    const detail = await adminGet(`/admin/api/session-logs/${entry.id}`);
    const log = detail.log_data || [];
    const counts = {
      mm: log.filter((e) => e.msg?.includes('RB-CHECK') && e.msg?.includes('MISMATCH')).length,
      diverge: log.filter((e) => e.msg?.includes('COMPONENT-DIVERGE')).length,
      state_drift: log.filter((e) => e.msg?.includes('STATE-DRIFT')).length,
      replay_nd: log.filter((e) => e.msg?.includes('REPLAY-NONDETERMINISTIC')).length,
      live_mm: log.filter((e) => e.msg?.includes('RB-LIVE-MISMATCH') && !e.msg?.includes('[C]')).length,
      stuck: log.filter((e) => e.msg?.includes('TICK-STUCK')).length,
      alloc_probe: log.filter((e) => e.msg?.includes('ALLOC-PROBE')).length,
      alloc_dump: log.filter((e) => e.msg?.includes('ALLOC-DUMP')).length,
    };
    const firstAllocProbe = log.find((e) => e.msg?.includes('ALLOC-PROBE'));
    const firstMm = log.find((e) => e.msg?.includes('RB-CHECK') && e.msg?.includes('MISMATCH'));
    const firstDiv = log.find((e) => e.msg?.includes('COMPONENT-DIVERGE'));
    report.peers.push({
      slot: entry.slot,
      frames: entry.summary?.frames || 0,
      counts,
      first_mm_frame: firstMm?.f ?? null,
      first_mm_msg: firstMm?.msg?.substring(0, 240) ?? null,
      first_diverge_msg: firstDiv?.msg?.substring(0, 200) ?? null,
      first_alloc_probe: firstAllocProbe?.msg?.substring(0, 200) ?? null,
    });
  }

  console.log('\n=== REPORT ===');
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`\nSaved to ${REPORT_FILE}`);

  const totalMm = report.peers.reduce((s, p) => s + p.counts.mm, 0);
  const totalStuck = report.peers.reduce((s, p) => s + p.counts.stuck, 0);
  const clientMm = report.client.host.rb_check_mismatch + report.client.guest.rb_check_mismatch;
  const clientFatal = report.client.host.fatal + report.client.guest.fatal;
  const knDesyncActionable = report.kn_desync_events.host.actionable + report.kn_desync_events.guest.actionable;
  const lateKnDesyncActionable = report.kn_desync_events.late?.actionable || 0;
  const desyncLatched = !!report.desync_latch;
  console.log(
    `\nVERDICT: ${
      totalMm === 0 &&
      totalStuck === 0 &&
      clientMm === 0 &&
      clientFatal === 0 &&
      knDesyncActionable + lateKnDesyncActionable === 0 &&
      !desyncLatched
        ? '✅ PASS — no desync, no stall'
        : totalStuck > 0 || clientFatal > 0
          ? `⚠️  STALL/FATAL (admin_stuck=${totalStuck}, client_fatal=${clientFatal})`
          : `❌ DESYNC (admin_mm=${totalMm}, client_mm=${clientMm}, kn_events=${knDesyncActionable + lateKnDesyncActionable}, latch=${desyncLatched ? report.desync_latch.trigger : 'none'})`
    }`,
  );

  if (KEEP_OPEN) {
    await new Promise(() => {});
  }
  await new Promise((r) => setTimeout(r, 3000));
}

main().catch((err) => {
  console.error('HARNESS ERROR:', err);
  process.exit(1);
});
