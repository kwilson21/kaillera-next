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
 *   late-join-shared  the guest has no ROM and accepts the host's: its engine
 *                     first connects only to receive the ROM, then late-joins
 *   late-join-two-player  a third player joins a two-player match in play
 *   missed-game-end   a guest's signaling is down while the host ends the
 *                     game; on reconnect it must return to the lobby
 *   missed-game-end-at-rom-prompt  the same for a guest that joined mid-game
 *                     and is still being asked for a ROM (no engine yet)
 *   missed-new-match  the same, and the host starts another game before the
 *                     guest is back; on reconnect it must join the new match.
 *                     The host waits for the guest to load before it runs, so
 *                     the guest must be let into the start, not left asking
 *                     for a state nobody has yet
 *   dropped-rejoin    a guest's signaling is down for longer than the server's
 *                     grace window, so the room drops it while the match goes
 *                     on over the players' own connections; on reconnect it
 *                     must be taken back and neither page may leave the match
 *   dropped-host      the same for the host, whose room is handed to the guest
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
const SCENARIOS = [
  'late-join',
  'late-join-cached',
  'late-join-shared',
  'late-join-two-player',
  'missed-game-end',
  'missed-game-end-at-rom-prompt',
  'missed-new-match',
  'dropped-rejoin',
  'dropped-host',
  'streaming-join',
  'spectate',
  'host-reload',
];
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
const SERVER_GRACE_MS = 30000; // _DISCONNECT_GRACE_SECONDS in server/src/api/signaling.py
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
    console.log(`[${label}] pageerror ${e.stack || e.message}`);
    pageErrors.push({ label, message: e.message });
  });
  // Which request failed says whether an uncaught "Failed to fetch" is the
  // page's bug or this machine's network.
  page.on('requestfailed', (request) => {
    console.log(`[${label}] request failed: ${request.method()} ${request.url()} (${request.failure()?.errorText})`);
  });
  // KN_CONSOLE=1 prints each page's console, for working out why a scenario
  // failed. The play page silences console.log outside debug mode, so the
  // original is pinned first; debug mode itself would change what runs.
  if (process.env.KN_CONSOLE) {
    await ctx.addInitScript(() => {
      const log = console.log;
      Object.defineProperty(console, 'log', { configurable: true, get: () => log, set: () => {} });
    });
    page.on('console', (m) => console.log(`[${label}] ${m.text().slice(0, 300)}`));
  }
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
const cutSignaling = async (player) => {
  player.signaling.down = true;
  for (const { page: pageSide, server } of player.signaling.sockets.splice(0)) {
    await server.close({ code: 4000, reason: 'signaling down (test)' });
    await pageSide.close({ code: 4000, reason: 'signaling down (test)' });
  }
};

const blip = async (player) => {
  const before = await countOf(player, 'reconnect');
  await cutSignaling(player);
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

const playersInRoom = async (room) => {
  const res = await fetch(`${URL}/room/${room}`);
  return res.ok ? (await res.json()).player_count : 0;
};

// One player's signaling stays down past the server's grace window, so the
// room drops it while the match goes on over the players' own connections.
// When the socket returns the player must be taken back into the room and
// neither page may leave the match.
const droppedPlayerReturns = async (room, failures, log, who) => {
  const [host, guest] = await startTwoPlayerGame(room, failures);
  const dropped = who === 'host' ? host : guest;
  await cutSignaling(dropped);
  await dropped.page.waitForTimeout(SERVER_GRACE_MS + 8000);
  if ((await playersInRoom(room)) !== 1) failures.push(`the room did not drop the ${who} after its grace window`);
  dropped.signaling.down = false;
  if (!(await waitUntil(async () => (await playersInRoom(room)) === 2, 60000)))
    failures.push(`the ${who} was not taken back into the room`);
  if (await countOf(dropped, 'rejoin-refused')) failures.push(`the ${who}'s rejoin was refused`);
  if ((await lobbyShownOn(host)) || (await lobbyShownOn(guest))) failures.push('a page left the match');
  if (!(await waitForFrames([host, guest], 120, 120000))) failures.push('the game stopped advancing after the return');
  await checkpoint(
    `after the dropped ${who} returned`,
    [
      { player: host, lobby: false },
      { player: guest, lobby: false },
    ],
    failures,
    log,
  );
  return [host, guest];
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

const matchOf = (player) => player.page.evaluate(() => window.KNState?.matchId ?? null);

const startTwoPlayerGame = async (room, failures) => {
  const host = await openPlayer('host', `room=${room}&host=1&name=Host&mode=rollback`);
  await host.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
  const guest = await openPlayer('guest', `room=${room}&name=Guest`);
  await guest.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
  for (const p of [host, guest]) await loadRom(p);
  await host.page.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
  await host.page.click('#start-btn');
  if (!(await waitForFrames([host, guest], 120, 180000))) failures.push('the two-player game never started');
  return [host, guest];
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
    if (!(await waitForFrames([host, guest], 60, 120000))) failures.push('the game stopped advancing after the join');
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
    if (!(await waitForFrames([host, guest], 60, 120000))) failures.push('the game stopped advancing after the join');
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

  'late-join-shared': async (room, failures, log) => {
    const host = await openPlayer('host', `room=${room}&host=1&name=Host&mode=rollback`);
    await host.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
    await loadRom(host);
    // The checkbox sits in a host-options row that may be collapsed, so it
    // is clicked through the DOM rather than waited on as a visible element.
    await host.page.waitForSelector('#opt-rom-sharing:not([disabled])', { state: 'attached', timeout: 60000 });
    await host.page.evaluate(() => document.getElementById('opt-rom-sharing').click());
    if (!(await host.page.evaluate(() => document.getElementById('opt-rom-sharing').checked)))
      failures.push('the host could not turn ROM sharing on');
    await host.page.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
    await host.page.click('#start-btn');
    if (!(await waitForFrames([host], 120, 120000))) failures.push('the host game never started');

    const guest = await openPlayer('guest', `room=${room}&name=Guest`);
    await guest.page.waitForSelector('#rom-accept-btn', { state: 'visible', timeout: 30000 });
    await guest.page.click('#rom-accept-btn');
    // The ROM comes over a DataChannel before the guest's emulator can boot.
    const synced = await waitUntil(async () => {
      await clickGesturePrompt(guest);
      await clickGesturePrompt(host);
      return (await frameOf(guest)) > 0;
    }, 420000);
    if (!synced) failures.push('the late joiner never received the ROM and state');
    if (!(await waitForFrames([host, guest], 60, 120000))) failures.push('the game stopped advancing after the join');
    await checkpoint(
      'after shared-ROM late join',
      [
        { player: host, lobby: false },
        { player: guest, lobby: false, lateJoiner: true },
      ],
      failures,
      log,
    );
    return [host, guest];
  },

  'late-join-two-player': async (room, failures, log) => {
    const host = await openPlayer('host', `room=${room}&host=1&name=Host&mode=rollback`);
    await host.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
    const first = await openPlayer('guest1', `room=${room}&name=First`);
    await first.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
    for (const p of [host, first]) await loadRom(p);
    await host.page.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
    await host.page.click('#start-btn');
    if (!(await waitForFrames([host, first], 120, 240000))) failures.push('the two-player game never started');

    const late = await openPlayer('guest2', `room=${room}&name=Late`);
    await late.page.waitForSelector('#rom-drop', { state: 'visible', timeout: 30000 });
    await loadRom(late);
    const synced = await waitUntil(async () => {
      for (const p of [host, first, late]) await clickGesturePrompt(p);
      return (await frameOf(late)) > 0;
    }, 420000);
    if (!synced) failures.push('the third player never received state');
    if (!(await waitForFrames([host, first, late], 60, 240000)))
      failures.push('the game stopped advancing after the join');
    await checkpoint(
      'after third player joins',
      [
        { player: host, lobby: false },
        { player: first, lobby: false },
        { player: late, lobby: false, lateJoiner: true },
      ],
      failures,
      log,
    );
    return [host, first, late];
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
    // The streaming engine has no frame counter to watch: the game is on
    // for the host once its lobby overlay is gone.
    if (!(await waitUntil(async () => !(await lobbyShownOn(host)), 60000)))
      failures.push('the host game never started');
    await host.page.waitForTimeout(10000);

    const guest = await openPlayer('guest2', `room=${room}&name=Late`);
    if (!(await waitUntil(async () => !(await lobbyShownOn(guest)), 30000)))
      failures.push('the streaming guest never left the lobby overlay');
    await host.page.waitForTimeout(10000);
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
    if (!(await waitForFrames([host], 120, 120000))) failures.push('the game stopped advancing after the join');
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

  'missed-game-end': async (room, failures, log) => {
    const [host, guest] = await startTwoPlayerGame(room, failures);
    // The guest hears nothing from the server from here on.
    await cutSignaling(guest);
    await endGame(host);
    if (!(await waitUntil(() => lobbyShownOn(host), 30000))) failures.push('the host never returned to the lobby');
    await guest.page.waitForTimeout(5000);
    if (await lobbyShownOn(guest)) failures.push('the guest left the game before its socket came back');

    guest.signaling.down = false;
    if (!(await waitUntil(() => lobbyShownOn(guest), 60000)))
      failures.push('the guest stayed in a game the host had ended');
    await checkpoint(
      'after the guest caught up',
      [
        { player: host, lobby: true },
        { player: guest, lobby: true },
      ],
      failures,
      log,
    );
    return [host, guest];
  },

  'dropped-rejoin': async (room, failures, log) => droppedPlayerReturns(room, failures, log, 'guest'),
  'dropped-host': async (room, failures, log) => droppedPlayerReturns(room, failures, log, 'host'),

  'missed-game-end-at-rom-prompt': async (room, failures, log) => {
    const host = await startSoloGame(room);
    if (!(await waitForFrames([host], 120, 120000))) failures.push('the host game never started');
    // The guest joins mid-game with no ROM: it is asked for one and has no engine yet.
    const guest = await openPlayer('guest', `room=${room}&name=Guest`);
    await guest.page.waitForSelector('#rom-drop', { state: 'visible', timeout: 30000 });
    const before = await countOf(guest, 'reconnect');
    await cutSignaling(guest);
    await endGame(host);
    if (!(await waitUntil(() => lobbyShownOn(host), 30000))) failures.push('the host never returned to the lobby');
    guest.signaling.down = false;
    if (!(await waitUntil(async () => (await countOf(guest, 'reconnect')) > before, 40000)))
      failures.push('the guest never reconnected');
    await guest.page.waitForTimeout(3000);
    // The page must have dropped its late join: a ROM loaded now is a ROM
    // for the lobby, not the start of a late join into a game that is over.
    await loadRom(guest);
    await guest.page.waitForTimeout(8000);
    if (!(await lobbyShownOn(guest))) failures.push('the guest started a late join into a game that had ended');
    if (await guest.page.locator('#late-join-msg').count())
      failures.push('the guest is still showing the late-join prompt');
    if ((await frameOf(guest)) > 0) failures.push('the guest booted an emulator for a game that had ended');
    await checkpoint(
      'after the guest caught up at the ROM prompt',
      [
        { player: host, lobby: true },
        { player: guest, lobby: true },
      ],
      failures,
      log,
    );
    return [host, guest];
  },

  'missed-new-match': async (room, failures, log) => {
    const [host, guest] = await startTwoPlayerGame(room, failures);
    const firstMatch = await matchOf(guest);
    await cutSignaling(guest);
    await endGame(host);
    if (!(await waitUntil(() => lobbyShownOn(host), 30000))) failures.push('the host never returned to the lobby');
    // The host starts again while the guest is still out. It will not run a
    // frame until the guest has loaded: the room still lists the guest.
    await host.page.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
    await host.page.click('#start-btn');
    if (!(await waitUntil(async () => ![null, firstMatch].includes(await matchOf(host)), 60000)))
      failures.push('the host never started the second match');
    const secondMatch = await matchOf(host);

    guest.signaling.down = false;
    const running = await waitUntil(async () => {
      for (const p of [host, guest]) await clickGesturePrompt(p);
      return (await matchOf(guest)) === secondMatch && (await frameOf(guest)) > 60 && (await frameOf(host)) > 60;
    }, 480000);
    if (!running)
      failures.push(
        `the new match never ran for both (guest in ${await matchOf(guest)} at frame ${await frameOf(guest)}, ` +
          `host at frame ${await frameOf(host)})`,
      );
    await checkpoint(
      'after the guest joined the new match',
      [
        { player: host, lobby: false },
        { player: guest, lobby: false, lateJoiner: true },
      ],
      failures,
      log,
    );
    return [host, guest];
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
  for (const error of pageErrors.splice(0)) failures.push(`uncaught page error (${error.label}: ${error.message})`);
  results.push({ scenario: name, room, checkpoints: log, failures });
}

await browser.close();
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
process.exit(results.some((r) => r.failures.length) ? 1 : 0);
