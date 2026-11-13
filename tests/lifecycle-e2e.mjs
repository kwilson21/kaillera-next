/**
 * Does the page lifecycle machine (web/src/session.ts) agree with play.js
 * through a late join, spectating and a host reload, against the real server?
 *
 * The machine only observes: on every signaling reconnect play.js compares
 * the machine's state with its own `gameRunning` flag and reports
 * `session-disagree` if they differ. So each scenario walks the pages through
 * a lifecycle change and then blips their signaling socket to force that
 * comparison. The machine also reports `late-join-stranded` when a late
 * joiner has waited more than 20 s for state. For the late joiner that is a
 * notice, not a disagreement: the scenario times the wait itself and fails
 * only if the notice and the measured wait contradict each other. For anyone
 * else it is a failure.
 *
 * The machine also mirrors play.js's two late-join flags, and play.js asks it
 * at every place it reads one whether it would have answered the same; those
 * disagreements are reported as `session-disagree` too and fail a checkpoint.
 *
 * Scenarios (SCENARIO picks one; default runs them all, each in its own room):
 *   late-join         a guest with no ROM joins a game already running, is
 *                     asked for one, then the host ends the game
 *   late-join-cached  the same, with the guest's ROM already in its library
 *   streaming-join    a third player joins a streamed game already running
 *   spectate          a spectator joins a game already running, then the host ends it
 *   host-reload       the host reloads mid-game; the server ends the match for the guest
 *
 * At each checkpoint the test also checks what the page itself shows (lobby
 * overlay up or down), so a run cannot pass with machine and page agreeing on
 * the wrong answer. An uncaught exception on any page fails the scenario.
 *
 *   just serve        # the real server on :27888, in another terminal
 *   KN_ROM=/path/ssb64-us.z64 [KN_URL=http://localhost:27888] [SCENARIO=late-join] \
 *     [CHROMIUM_PATH=...] [OUT=/tmp/lifecycle-e2e] node tests/lifecycle-e2e.mjs
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const URL = process.env.KN_URL || 'http://localhost:27888';
const ROM = process.env.KN_ROM;
const OUT = process.env.OUT || '/tmp/lifecycle-e2e';
const SCENARIOS = ['late-join', 'late-join-cached', 'streaming-join', 'spectate', 'host-reload'];
const wanted = process.env.SCENARIO ? [process.env.SCENARIO] : SCENARIOS;
if (wanted.some((name) => !SCENARIOS.includes(name))) {
  console.log(`SCENARIO must be one of ${SCENARIOS.join(', ')}`);
  process.exit(1);
}
if (!ROM || !fs.existsSync(ROM)) {
  console.log('KN_ROM must point at the SSB64 US ROM');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });

const BLIP_MS = 3000;
const LATE_JOIN_REPORT_AFTER_MS = 20000; // web/src/session.ts

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});

// Keep every client event a page reports. sessionStorage carries them across
// a reload so the host-reload scenario sees both of the host's page loads.
const recordEvents = () => {
  const KEY = '__knEvents';
  const load = () => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) || '[]');
    } catch {
      return [];
    }
  };
  window.__knEvents = load();
  let real;
  Object.defineProperty(window, 'KNEvent', {
    configurable: true,
    set: (fn) => {
      real = fn;
    },
    get: () =>
      real &&
      ((type, msg, meta) => {
        window.__knEvents.push({ type, meta: meta ?? {} });
        try {
          sessionStorage.setItem(KEY, JSON.stringify(window.__knEvents));
        } catch {
          // Storage full or blocked: the in-memory list still holds this page load.
        }
        return real(type, msg, meta);
      }),
  });
};

// Uncaught exceptions on any page, for the scenario in progress.
const pageErrors = [];

/** A page in its own browser context, with a signaling socket the test can cut. */
const openPlayer = async (label, query) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.addInitScript(recordEvents);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    console.log(`[${label}] pageerror ${e.message}`);
    pageErrors.push(`${label}: ${e.message}`);
  });
  const signaling = { down: false, sockets: [] };
  await page.routeWebSocket(/socket\.io/, (ws) => {
    if (signaling.down) {
      ws.close({ code: 4000, reason: 'signaling down (test)' });
      return;
    }
    const server = ws.connectToServer();
    signaling.sockets.push({ page: ws, server });
    ws.onMessage((message) => server.send(message));
  });
  await page.goto(`${URL}/play.html?${query}&knperf=light`);
  return { label, page, ctx, signaling };
};

const eventsOf = (player) => player.page.evaluate(() => window.__knEvents);
const countOf = async (player, type) => (await eventsOf(player)).filter((e) => e.type === type).length;
const frameOf = (player) => player.page.evaluate(() => window.KNState?.frameNum ?? 0);
const lobbyShownOn = (player) =>
  player.page.evaluate(() => {
    const overlay = document.getElementById('overlay');
    return !!overlay && !overlay.classList.contains('hidden');
  });

const clickGesturePrompt = async (player) => {
  if (await player.page.locator('#gesture-prompt:not(.hidden)').count()) {
    await player.page
      .locator('#gesture-prompt')
      .click({ force: true })
      .catch(() => {});
  }
};

/** Wait until every listed player has advanced `frames` beyond where it is now. */
const waitForFrames = async (players, frames, timeoutMs) => {
  const targets = await Promise.all(players.map(async (p) => (await frameOf(p)) + frames));
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    for (const p of players) await clickGesturePrompt(p);
    const now = await Promise.all(players.map(frameOf));
    if (now.every((f, i) => f >= targets[i])) return true;
    await players[0].page.waitForTimeout(500);
  }
  return false;
};

const waitUntil = async (probe, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
};

/**
 * Drop a player's signaling for BLIP_MS and let it reconnect. Both ends are
 * closed, with an application close code, so the server sees the client go.
 * Returns how many reconnects the page recorded afterwards.
 */
const blip = async (player) => {
  const before = await countOf(player, 'reconnect');
  player.signaling.down = true;
  for (const { page: pageSide, server } of player.signaling.sockets.splice(0)) {
    await server.close({ code: 4000, reason: 'signaling down (test)' });
    await pageSide.close({ code: 4000, reason: 'signaling down (test)' });
  }
  await player.page.waitForTimeout(BLIP_MS);
  player.signaling.down = false;
  await waitUntil(async () => (await countOf(player, 'reconnect')) > before, 40000);
  // The comparison runs asynchronously on `connect`; give it time to report.
  await player.page.waitForTimeout(2000);
  return (await countOf(player, 'reconnect')) - before;
};

/**
 * One checkpoint: blip each player, then require that it reconnected, that
 * the page shows what the scenario expects, and that the machine reported
 * nothing.
 */
const checkpoint = async (name, expectations, failures, log) => {
  for (const { player, lobby, lateJoiner = false } of expectations) {
    const reconnects = await blip(player);
    const lobbyShown = await lobbyShownOn(player);
    const disagreements = (await eventsOf(player)).filter((e) => e.type === 'session-disagree');
    const stranded = await countOf(player, 'late-join-stranded');
    log.push({ checkpoint: name, player: player.label, reconnects, lobbyShown, disagreements, stranded });
    console.log(
      `  ${name}: ${player.label} reconnects=${reconnects} lobbyShown=${lobbyShown} ` +
        `disagreements=${disagreements.length} stranded=${stranded}`,
    );
    if (reconnects < 1) failures.push(`${name}: ${player.label} never reconnected, so nothing was compared`);
    if (lobbyShown !== lobby) failures.push(`${name}: ${player.label} ${lobby ? 'is not' : 'is'} showing the lobby`);
    if (disagreements.length)
      failures.push(`${name}: ${player.label} machine disagreed with the page ${JSON.stringify(disagreements)}`);
    if (stranded && !lateJoiner) failures.push(`${name}: ${player.label} was reported as a stranded late joiner`);
  }
};

const loadRom = (player) => player.page.locator("#rom-drop input[type='file']").setInputFiles(ROM);

const startSoloGame = async (room, mode = 'rollback') => {
  const host = await openPlayer('host', `room=${room}&host=1&name=Host&mode=${mode}`);
  await host.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
  await loadRom(host);
  await host.page.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
  await host.page.click('#start-btn');
  return host;
};

const endGame = async (host) => {
  await host.page.click('#toolbar-more');
  await host.page.click('#toolbar-end');
};

const scenarios = {
  'late-join': async (room, failures, log) => {
    const host = await startSoloGame(room);
    if (!(await waitForFrames([host], 120, 120000))) failures.push('the host game never started');

    const joinedAt = Date.now();
    const guest = await openPlayer('guest', `room=${room}&name=Guest`);
    await guest.page.waitForSelector('#rom-drop', { state: 'visible', timeout: 30000 });
    await loadRom(guest);
    const synced = await waitUntil(async () => {
      await clickGesturePrompt(guest);
      return (await frameOf(guest)) > 0;
    }, 180000);
    const waitedMs = Date.now() - joinedAt;
    if (!synced) failures.push('the late joiner never received state');
    // The machine's clock starts at the join ack, after ours, so a notice
    // means our measured wait must be over its threshold too.
    await guest.page.waitForTimeout(1500); // the page polls for sync once a second
    const stranded = await countOf(guest, 'late-join-stranded');
    log.push({ lateJoinWaitMs: waitedMs, stranded });
    console.log(`  late joiner waited ${waitedMs} ms for state; stranded notices: ${stranded}`);
    if (stranded && waitedMs < LATE_JOIN_REPORT_AFTER_MS)
      failures.push(`the machine reported a stranded joiner after only ${waitedMs} ms`);
    if (stranded > 1) failures.push(`the machine reported the same stranded joiner ${stranded} times`);
    await waitForFrames([host, guest], 60, 120000);
    await checkpoint(
      'after late join',
      [
        { player: host, lobby: false },
        { player: guest, lobby: false, lateJoiner: true },
      ],
      failures,
      log,
    );

    await endGame(host);
    if (!(await waitUntil(() => lobbyShownOn(guest), 30000))) failures.push('the guest never returned to the lobby');
    await checkpoint(
      'after end game',
      [
        { player: host, lobby: true },
        { player: guest, lobby: true, lateJoiner: true },
      ],
      failures,
      log,
    );
    return [host, guest];
  },

  'late-join-cached': async (room, failures, log) => {
    const host = await startSoloGame(room);
    if (!(await waitForFrames([host], 120, 120000))) failures.push('the host game never started');

    // Put the ROM in the guest's library first, from a room of its own.
    const guest = await openPlayer('guest', `room=${room}W&host=1&name=Guest&mode=rollback`);
    await guest.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
    await loadRom(guest);
    await guest.page.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });

    await guest.page.goto(`${URL}/play.html?room=${room}&name=Guest&knperf=light`);
    const synced = await waitUntil(async () => {
      await clickGesturePrompt(guest);
      return (await frameOf(guest)) > 0;
    }, 240000);
    if (!synced) failures.push('the late joiner never received state');
    await waitForFrames([host, guest], 60, 120000);
    await checkpoint(
      'after late join',
      [
        { player: host, lobby: false },
        { player: guest, lobby: false, lateJoiner: true },
      ],
      failures,
      log,
    );
    return [host, guest];
  },

  'streaming-join': async (room, failures, log) => {
    // A streamed game needs two players to start, so the late joiner is the third.
    const host = await openPlayer('host', `room=${room}&host=1&name=Host&mode=streaming`);
    await host.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
    await loadRom(host);
    const first = await openPlayer('guest1', `room=${room}&name=First`);
    await first.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
    await host.page.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
    await host.page.click('#start-btn');
    if (!(await waitForFrames([host], 120, 120000))) failures.push('the host game never started');

    const guest = await openPlayer('guest2', `room=${room}&name=Late`);
    if (!(await waitUntil(async () => !(await lobbyShownOn(guest)), 30000)))
      failures.push('the streaming guest never left the lobby overlay');
    await waitForFrames([host], 120, 120000);
    await checkpoint(
      'while streaming',
      [
        { player: host, lobby: false },
        { player: first, lobby: false },
        { player: guest, lobby: false },
      ],
      failures,
      log,
    );

    await endGame(host);
    if (!(await waitUntil(() => lobbyShownOn(guest), 30000))) failures.push('the guest never returned to the lobby');
    await checkpoint(
      'after end game',
      [
        { player: host, lobby: true },
        { player: first, lobby: true },
        { player: guest, lobby: true },
      ],
      failures,
      log,
    );
    return [host, first, guest];
  },

  spectate: async (room, failures, log) => {
    const host = await startSoloGame(room);
    if (!(await waitForFrames([host], 120, 120000))) failures.push('the host game never started');

    const watcher = await openPlayer('spectator', `room=${room}&name=Watcher&spectate=1`);
    if (!(await waitUntil(async () => !(await lobbyShownOn(watcher)), 30000)))
      failures.push('the spectator never left the lobby overlay');
    await waitForFrames([host], 120, 120000);
    await checkpoint(
      'while spectating',
      [
        { player: host, lobby: false },
        { player: watcher, lobby: false },
      ],
      failures,
      log,
    );

    await endGame(host);
    if (!(await waitUntil(() => lobbyShownOn(watcher), 30000)))
      failures.push('the spectator never returned to the lobby');
    await checkpoint(
      'after end game',
      [
        { player: host, lobby: true },
        { player: watcher, lobby: true },
      ],
      failures,
      log,
    );
    return [host, watcher];
  },

  'host-reload': async (room, failures, log) => {
    const host = await openPlayer('host', `room=${room}&host=1&name=Host&mode=rollback`);
    await host.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
    const guest = await openPlayer('guest', `room=${room}&name=Guest`);
    await guest.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
    for (const p of [host, guest]) await loadRom(p);
    await host.page.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
    await host.page.click('#start-btn');
    if (!(await waitForFrames([host, guest], 120, 180000))) failures.push('the two-player game never started');

    // The reloaded host has no game running, so it asks for a fresh room and
    // the server ends the match for everyone (the fix from #104).
    await host.page.reload();
    await host.page.waitForSelector('#overlay', { state: 'visible', timeout: 30000 });
    if (!(await waitUntil(() => lobbyShownOn(guest), 30000)))
      failures.push('the guest was left in a game the host had abandoned');
    await checkpoint(
      'after host reload',
      [
        { player: host, lobby: true },
        { player: guest, lobby: true },
      ],
      failures,
      log,
    );
    return [host, guest];
  },
};

const results = [];
for (const name of wanted) {
  const room = `LC${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const failures = [];
  const log = [];
  let players = [];
  console.log(`${name}: room ${room}`);
  try {
    players = await scenarios[name](room, failures, log);
  } catch (error) {
    failures.push(`scenario threw: ${error.message.split('\n')[0]}`);
  }
  for (const player of players) {
    const sync = await player.page.evaluate(() => window.NetplayRollback?.exportSyncLog?.() || '').catch(() => '');
    fs.writeFileSync(`${OUT}/${name}-${player.label}-sync.txt`, sync);
  }
  for (const ctx of browser.contexts()) await ctx.close();
  for (const message of pageErrors.splice(0)) failures.push(`uncaught page error (${message})`);
  results.push({ scenario: name, room, checkpoints: log, failures });
}

await browser.close();
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
process.exit(results.some((r) => r.failures.length) ? 1 : 0);
