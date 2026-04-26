#!/usr/bin/env node
/**
 * Late-join CSS automation.
 *
 * Starts a two-player lockstep room, navigates to character select, selects the
 * Random character tile for P1 and P2 using controlled keyboard inputs, then
 * joins a third player while still on CSS. P3 must become a real player, select
 * Random with controlled inputs, and all three peers must enter VS Battle after
 * host confirms a random stage.
 *
 * Usage:
 *   node tests/late-join-css-automation.mjs
 *   node tests/late-join-css-automation.mjs --headless --room=LJCSS1234
 */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const DEFAULT_ROM_PATH = '/Users/kazon/Downloads/Smash Remix 2.0.1.z64';
const DEFAULT_BASE_URL = 'https://localhost:27888';

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const ROM_PATH = argValue('rom', process.env.KN_ROM_PATH || DEFAULT_ROM_PATH);
const BASE_URL = argValue('base-url', process.env.KN_BASE_URL || DEFAULT_BASE_URL);
const ROOM = argValue('room', process.env.KN_ROOM || `LJCSS${Date.now() % 10000}`);
const HEADLESS = process.argv.includes('--headless');
const NAV_RECORDING_URL = new URL('./fixtures/nav-recording.json', import.meta.url);
const HOST_RANDOM_SELECT_START_FRAME = 826;
const HOST_RANDOM_SELECT_END_FRAME = 1068;
const NAV_P2_SELECTED_FRAME = 1444;
const GUEST_RANDOM_SELECT_START_FRAME = 1265;
const REPLAY_MIN_HOLD_FRAMES = 2;

const SCENE_TITLE = 1; // nSCKindTitle
const SCENE_MODE_SELECT = 7; // nSCKindModeSelect
const SCENE_VS_MODE = 9; // nSCKindVSMode
const SCENE_VS_OPTIONS = 10; // nSCKindVSOptions
const SCENE_PLAYERS_VS = 16; // nSCKindPlayersVS
const SCENE_MAPS = 21; // nSCKindMaps
const SCENE_VS_BATTLE = 22; // nSCKindVSBattle

const KEY = {
  A: 'c',
  START: 'v',
  DDOWN: 'ArrowDown',
  DRIGHT: 'ArrowRight',
  ANA_DOWN: 's',
};

const CHROMIUM_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
];

async function setupPeer(urlSuffix, name) {
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: CHROMIUM_ARGS,
  });
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  const events = [];
  page.on('pageerror', (err) => {
    const text = err.stack || err.message || String(err);
    events.push({ type: 'pageerror', text });
    console.log(`[${name}] PAGE ERROR: ${err.message}`);
  });
  page.on('console', (msg) => {
    const text = msg.text();
    if (/late-join|requesting game state|received late-join|fatal|mismatch|diverge/i.test(text)) {
      events.push({ type: msg.type(), text });
      console.log(`[${name}] ${text.substring(0, 240)}`);
    }
  });

  const playUrl = `${BASE_URL}/play.html?${urlSuffix}&name=${encodeURIComponent(name)}&mode=rollback`;
  await page.goto(playUrl, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    try {
      localStorage.removeItem('KN_DEV_BUILD');
      localStorage.setItem('kn-debug', '1');
    } catch {}
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await loadRom(page, name);
  return { browser, ctx, page, name, events };
}

async function closePeer(peer) {
  await peer?.ctx?.close().catch(() => {});
  await peer?.browser?.close().catch(() => {});
}

async function loadRom(page, name) {
  const drop = page.locator('#rom-drop');
  await drop.waitFor({ state: 'visible', timeout: 45000 });
  console.log(`  ${name}: loading ROM`);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), drop.click()]);
  await chooser.setFiles(ROM_PATH);
  await page.waitForTimeout(2500);
}

async function clickGesturePrompt(peer) {
  const { page, name } = peer;
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
  if (!clicked) {
    await page.click('body', { position: { x: 640, y: 360 } }).catch(() => {});
  }
  await page.focus('body').catch(() => {});
  await page.waitForTimeout(1500);
  console.log(`  ${name}: gesture prompt handled`);
}

async function currentScene(page) {
  return page
    .evaluate(() => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (typeof mod?._kn_get_scene_curr === 'function') {
        const scene = mod._kn_get_scene_curr();
        if (Number.isFinite(scene)) return scene;
      }
      if (typeof mod?._kn_get_rdram_ptr === 'function' && mod.HEAPU8) {
        const ptr = mod._kn_get_rdram_ptr() >>> 0;
        if (ptr) return mod.HEAPU8[ptr + (0xa4ad0 ^ 3)] ?? null;
      }
      return null;
    })
    .catch(() => null);
}

async function waitForFrame(page, minFrame, timeoutMs = 90000, pollMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const frame = await page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
    if (frame >= minFrame) return frame;
    await page.waitForTimeout(pollMs);
  }
  const current = await page.evaluate(() => window.KNState?.frameNum || 0).catch(() => -1);
  throw new Error(`Timeout waiting for frame ${minFrame}, current=${current}`);
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

async function waitForBothTicking(host, guest, timeoutMs = 120000) {
  const start = Date.now();
  let lastClickAt = 0;
  let lastLogAt = 0;
  const minStableFrame = 150;
  while (Date.now() - start < timeoutMs) {
    const [hostState, guestState] = await Promise.all([bootState(host.page), bootState(guest.page)]);
    if (hostState.frame >= minStableFrame && guestState.frame >= minStableFrame) {
      console.log(`  tick gate OK: host=${hostState.frame} guest=${guestState.frame}`);
      return { host: hostState, guest: guestState };
    }

    const now = Date.now();
    if (now - lastClickAt >= 2000) {
      lastClickAt = now;
      await clickGesturePrompt(host);
      await clickGesturePrompt(guest);
    }
    if (now - lastLogAt >= 5000) {
      lastLogAt = now;
      const fmtPeers = (state) =>
        state.peers.map((p) => `${p.pc}/${p.dc}${p.ready ? '/ready' : ''}`).join(',') || 'none';
      console.log(
        `  waiting for tick: host f=${hostState.frame} [${fmtPeers(hostState)}] ${hostState.status || ''} | ` +
          `guest f=${guestState.frame} [${fmtPeers(guestState)}] ${guestState.status || ''}`,
      );
    }
    await host.page.waitForTimeout(500);
  }

  const [hostState, guestState] = await Promise.all([bootState(host.page), bootState(guest.page)]);
  throw new Error(
    `Timed out waiting for both emulators to tick: ` +
      `host f=${hostState.frame} peers=${JSON.stringify(hostState.peers)} status="${hostState.status}", ` +
      `guest f=${guestState.frame} peers=${JSON.stringify(guestState.peers)} status="${guestState.status}"`,
  );
}

async function waitForScene(page, targetScene, timeoutMs = 60000, pollMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scene = await currentScene(page);
    if (scene === targetScene) return scene;
    await page.waitForTimeout(pollMs);
  }
  throw new Error(`Timeout waiting for scene ${targetScene}, current=${await currentScene(page)}`);
}

async function waitForAnyScene(page, targetScenes, timeoutMs = 60000, pollMs = 50) {
  const targets = new Set(targetScenes);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scene = await currentScene(page);
    if (targets.has(scene)) return scene;
    await page.waitForTimeout(pollMs);
  }
  throw new Error(`Timeout waiting for scenes ${[...targets].join(',')}, current=${await currentScene(page)}`);
}

async function waitForAllScene(peers, targetScene, label, timeoutMs = 60000) {
  await Promise.all(peers.map((peer) => waitForScene(peer.page, targetScene, timeoutMs)));
  const frames = await Promise.all(peers.map((peer) => peer.page.evaluate(() => window.KNState?.frameNum || 0)));
  console.log(`  [scene ${targetScene} ${label}: ${peers.map((peer, i) => `${peer.name} f=${frames[i]}`).join(' ')}]`);
}

async function press(page, key, holdMs = 120, waitAfterMs = 180) {
  await page.keyboard.down(key);
  await page.waitForTimeout(holdMs);
  await page.keyboard.up(key);
  await page.waitForTimeout(waitAfterMs);
}

async function peerPress(peer, key, holdMs = 200, waitAfterMs = 500) {
  await peer.page.bringToFront();
  await peer.page.focus('body').catch(() => {});
  await press(peer.page, key, holdMs, waitAfterMs);
  const frame = await peer.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
  console.log(`  [${peer.name} f=${frame} after ${key}]`);
}

async function installReplay(page, events, label) {
  await page.evaluate(
    ({ events, label, minHoldFrames }) => {
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
      if (window._replayTimerId) clearInterval(window._replayTimerId);
      window._replayEvents = sorted;
      window._replayNext = 0;
      window._replayFired = 0;
      window._replayLabel = label;
      window._replayLastFrame = 0;
      window._replayPendingUps = [];
      const dispatch = (event) => {
        const keyCode = KEYCODE_MAP[event.key] ?? 0;
        const kbd = new KeyboardEvent(event.type === 'down' ? 'keydown' : 'keyup', {
          key: event.key,
          code: event.code,
          bubbles: true,
          cancelable: true,
        });
        Object.defineProperty(kbd, 'keyCode', { get: () => keyCode });
        Object.defineProperty(kbd, 'which', { get: () => keyCode });
        document.dispatchEvent(kbd);
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
        const frame = mod?._kn_get_frame?.() ?? (window.KNState?.frameNum || 0);
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
    { events, label, minHoldFrames: REPLAY_MIN_HOLD_FRAMES },
  );
}

async function stopReplay(peer) {
  await peer.page
    .evaluate(() => {
      if (window._replayTimerId) clearInterval(window._replayTimerId);
      window._replayTimerId = null;
    })
    .catch(() => {});
}

async function waitForReplayDone(peer, expectedCount, label, timeoutMs = 60000) {
  const start = Date.now();
  let last = { fired: 0, frame: 0 };
  while (Date.now() - start < timeoutMs) {
    last = await peer.page
      .evaluate(() => ({
        fired: window._replayFired || 0,
        frame: window.KNState?.frameNum || 0,
      }))
      .catch(() => last);
    process.stdout.write(`\r  ${label}: ${last.fired}/${expectedCount} f=${last.frame}   `);
    if (last.fired >= expectedCount) {
      console.log('');
      return last;
    }
    await peer.page.waitForTimeout(250);
  }
  console.log('');
  throw new Error(`${label} replay did not finish: ${last.fired}/${expectedCount} f=${last.frame}`);
}

async function replayFixtureSegment(peer, windowName, startFrame, endFrame, label) {
  const rec = JSON.parse(readFileSync(NAV_RECORDING_URL, 'utf8'));
  const segmentEvents = rec.events.filter(
    (event) => event.window === windowName && event.frame >= startFrame && event.frame <= endFrame,
  );
  const firstFrame = segmentEvents[0]?.frame ?? startFrame;
  const currentFrame = await peer.page.evaluate(() => window.KNState?.frameNum || 0).catch(() => 0);
  const baseFrame = currentFrame + 10;
  const replayEvents = segmentEvents.map((event) => ({
    ...event,
    frame: baseFrame + (event.frame - firstFrame),
    window: peer.name,
  }));
  console.log(
    `${label} using determinism segment ${windowName}:${startFrame}-${endFrame} (current=${currentFrame}, events=${replayEvents.length})`,
  );
  await installReplay(peer.page, replayEvents, label);
  await waitForReplayDone(peer, replayEvents.length, label);
  await stopReplay(peer);
}

async function replayP3RandomSelect(peer) {
  await replayFixtureSegment(
    peer,
    'guest',
    GUEST_RANDOM_SELECT_START_FRAME,
    NAV_P2_SELECTED_FRAME,
    'P3 random-select replay',
  );
}

async function selectRandomCharacter(peer, expectedSlot) {
  console.log(`Selecting Random character for ${peer.name} / P${expectedSlot + 1}`);
  await waitForScene(peer.page, SCENE_PLAYERS_VS, 30000);
  await peer.page.bringToFront();
  await peer.page.focus('body').catch(() => {});
  for (let i = 0; i < 15; i++) {
    await press(peer.page, KEY.DRIGHT, 60, 70);
  }
  await peer.page.waitForTimeout(300);
  await press(peer.page, KEY.A, 240, 1200);
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
      };
    })
    .catch((err) => ({ error: String(err) }));
}

async function inputProbe(late, host, key = 'd') {
  console.log(`\n=== P3 input probe (${key}) ===`);
  await late.page.bringToFront();
  await late.page.focus('body').catch(() => {});
  await late.page.keyboard.down(key);
  for (let i = 0; i < 6; i++) {
    await late.page.waitForTimeout(120);
    const [lateDebug, hostDebug] = await Promise.all([debugState(late.page), debugState(host.page)]);
    console.log(
      `  probe ${i}: late f=${lateDebug.frameNum} held=${JSON.stringify(lateDebug.heldKeyCodes)} ` +
        `local=${JSON.stringify(lateDebug.localInputNow)} peers=${JSON.stringify(lateDebug.peersDetail)} | ` +
        `host f=${hostDebug.frameNum} slot2=${JSON.stringify(hostDebug.remoteLatest?.['2'])} ` +
        `peers=${JSON.stringify(hostDebug.peersDetail)}`,
    );
  }
  await late.page.keyboard.up(key).catch(() => {});
  await late.page.waitForTimeout(300);
}

async function waitForPlayableSlot(peer, expectedSlot, timeoutMs = 120000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
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

async function sampleSetup(page) {
  return page
    .evaluate(() => {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (!mod?.HEAPU8) return null;
      const call = (name, ...args) => {
        try {
          return typeof mod[name] === 'function' ? mod[name](...args) >>> 0 : null;
        } catch {
          return null;
        }
      };
      const ptr = call('_kn_get_rdram_ptr');
      if (ptr === null) return null;
      const heap = mod.HEAPU8;
      const u8 = (off) => heap[ptr + off] ?? null;
      const u32be = (off) => {
        const b0 = u8(off);
        const b1 = u8(off + 1);
        const b2 = u8(off + 2);
        const b3 = u8(off + 3);
        if (b0 === null || b1 === null || b2 === null || b3 === null) return null;
        return ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
      };
      const cssBase = 0x13ba88;
      const cssStride = 0xbc;
      const players = [];
      for (let slot = 0; slot < 4; slot++) {
        const base = cssBase + slot * cssStride;
        players.push({
          slot,
          cssCharId: u32be(base + 0x48),
          cssCursorState: u32be(base + 0x54),
          cssSelectedFlag: u32be(base + 0x58),
          cssPanelState: u32be(base + 0x84),
          cssSelectedHash: call('_kn_hash_css_selected', slot, -1),
          characterHash: call('_kn_hash_character_id', slot, -1),
        });
      }
      return {
        frame: call('_kn_get_frame') ?? window.KNState?.frameNum ?? 0,
        scene: call('_kn_get_scene_curr') ?? u8(0xa4ad0 ^ 3),
        netplayGameStatus: (mod.HEAPU32[(ptr + 0xa4d18) >> 2] >>> 16) & 0xff,
        battlePlayerCount: u8(0xa4ef8 + 4),
        players,
      };
    })
    .catch(() => null);
}

function cssSlotSelected(player) {
  if (!player) return false;
  const flagSelected = Number.isFinite(player.cssSelectedFlag) && player.cssSelectedFlag !== 0;
  const hashSelected = Number.isFinite(player.cssSelectedHash) && player.cssSelectedHash !== 0;
  return flagSelected || hashSelected;
}

async function waitForCssSlotSelected(page, slot, label, timeoutMs = 30000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await sampleSetup(page);
    if (cssSlotSelected(last?.players?.[slot])) {
      console.log(`  ${label}: P${slot + 1} selected ${JSON.stringify(last.players[slot])}`);
      return last;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`${label}: P${slot + 1} did not become selected; last=${JSON.stringify(last)}`);
}

async function waitForBattleReady(peers, timeoutMs = 90000) {
  await waitForAllScene(peers, SCENE_VS_BATTLE, 'battle', timeoutMs);
  const setups = await Promise.all(peers.map((peer) => sampleSetup(peer.page)));
  const bad = setups.find((setup) => setup?.netplayGameStatus !== 1);
  if (bad) {
    throw new Error(`Battle scene reached but game_status was not ongoing: ${JSON.stringify(setups)}`);
  }
  console.log(
    `  battle setup: ${setups.map((setup) => `players=${setup.battlePlayerCount} status=${setup.netplayGameStatus}`).join(' ')}`,
  );
  return setups;
}

async function replayTwoPlayersToCssRandom(host, guest) {
  console.log('\n=== Two-player setup to CSS ===');
  await waitForAllScene([host, guest], SCENE_TITLE, 'title before nav', 120000);
  console.log('Waiting for settled title frame (f=1900), matching determinism setup');
  await Promise.all([waitForFrame(host.page, 1900, 90000), waitForFrame(guest.page, 1900, 90000)]);
  await host.page.waitForTimeout(1000);

  console.log('Step 1: START -> Mode Select');
  await peerPress(host, KEY.START, 300, 500);
  await waitForAllScene([host, guest], SCENE_MODE_SELECT, 'mode-select', 30000);

  console.log('Step 2: Analog down -> VS MODE');
  await peerPress(host, KEY.ANA_DOWN, 300, 1000);

  console.log('Step 3: A -> enter VS MODE');
  await peerPress(host, KEY.A, 300, 500);
  await waitForAllScene([host, guest], SCENE_VS_MODE, 'vs-mode', 30000);

  console.log('Step 4: A -> CSS');
  await peerPress(host, KEY.A, 300, 500);
  const postVsScene = await waitForAnyScene(host.page, [SCENE_VS_OPTIONS, SCENE_PLAYERS_VS], 30000, 50);
  if (postVsScene === SCENE_VS_OPTIONS) {
    await waitForAllScene([host, guest], SCENE_VS_OPTIONS, 'vs-options', 30000);
    await peerPress(host, KEY.A, 300, 500);
  }
  await waitForAllScene([host, guest], SCENE_PLAYERS_VS, 'css before random select', 30000);

  await replayFixtureSegment(
    host,
    'host',
    HOST_RANDOM_SELECT_START_FRAME,
    HOST_RANDOM_SELECT_END_FRAME,
    'P1 random-select replay',
  );
  await waitForCssSlotSelected(host.page, 0, 'host view');
  await replayFixtureSegment(
    guest,
    'guest',
    GUEST_RANDOM_SELECT_START_FRAME,
    NAV_P2_SELECTED_FRAME,
    'P2 random-select replay',
  );
  await waitForCssSlotSelected(host.page, 1, 'host view');
}

async function startGame(host, guest) {
  console.log('\n=== Starting room ===');
  await host.page.bringToFront();
  await host.page
    .locator('select')
    .first()
    .selectOption('lockstep')
    .catch(() => {});
  await host.page.locator('button:has-text("Start Game")').first().click({ timeout: 30000 });
  await host.page.waitForTimeout(2500);
  await Promise.all([clickGesturePrompt(host), clickGesturePrompt(guest)]);
}

async function saveScreenshots(peers, suffix) {
  await Promise.all(
    peers.map((peer) => peer.page.screenshot({ path: `/tmp/latejoin-css-${suffix}-${peer.name}.png` }).catch(() => {})),
  );
}

async function main() {
  const startedAt = Date.now();
  console.log(`Room: ${ROOM}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`ROM: ${ROM_PATH}`);
  console.log(`Headless: ${HEADLESS ? 'yes' : 'no'}`);

  let host;
  let guest;
  let late;
  try {
    console.log('Launching host...');
    host = await setupPeer(`room=${encodeURIComponent(ROOM)}&host=1`, 'host');

    console.log('Launching guest...');
    guest = await setupPeer(`room=${encodeURIComponent(ROOM)}`, 'guest');

    await startGame(host, guest);
    await waitForBothTicking(host, guest);
    await replayTwoPlayersToCssRandom(host, guest);
    await saveScreenshots([host, guest], 'before-p3');

    console.log('\n=== Joining P3 at CSS ===');
    late = await setupPeer(`room=${encodeURIComponent(ROOM)}`, 'late');
    await clickGesturePrompt(late);

    await waitForPlayableSlot(late, 2);
    await waitForAllScene([host, guest, late], SCENE_PLAYERS_VS, 'css after p3', 90000);
    await waitForInputTopology([host, guest, late]);
    await saveScreenshots([host, guest, late], 'p3-joined');
    await inputProbe(late, host, 'd');

    await replayP3RandomSelect(late);
    await waitForCssSlotSelected(host.page, 2, 'host view');
    await saveScreenshots([host, guest, late], 'p3-selected');

    console.log('\n=== Random stage and battle ===');
    await peerPress(host, KEY.START, 300, 500);
    await waitForAllScene([host, guest, late], SCENE_MAPS, 'stage-select', 30000);
    await peerPress(host, KEY.START, 300, 1000);
    const battleSetup = await waitForBattleReady([host, guest, late], 120000);
    await saveScreenshots([host, guest, late], 'battle');

    const states = await Promise.all([host, guest, late].map((peer) => debugState(peer.page)));
    console.log('\n=== Late-join CSS result ===');
    console.log(`Room: ${ROOM}`);
    console.log(`States: ${JSON.stringify(states)}`);
    console.log(`Battle: ${JSON.stringify(battleSetup)}`);
    console.log(`Screenshots: /tmp/latejoin-css-*-{host,guest,late}.png`);
    console.log(`Elapsed: ${Math.round((Date.now() - startedAt) / 1000)}s`);
  } finally {
    await closePeer(late);
    await closePeer(guest);
    await closePeer(host);
  }
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});
