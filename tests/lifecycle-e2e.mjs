/**
 * The page's lifecycle through a late join, spectating, reconnects and a
 * host reload, in real browsers against the real server.
 *
 * play.js reads its lifecycle from the machine in web/src/session.ts and
 * keeps no flags of its own, so what is checked here is what the page shows
 * (lobby up or down, frames advancing) at each step. Each checkpoint also
 * blips the page's signaling socket, to take it through a rejoin, and fails
 * on any disagreement an observing TypeScript module reported
 * (`session-disagree`, `play-disagree` and `protocol-mismatch` from a page
 * built before the old page flags, comparisons and protocol observer were
 * deleted), and on any message the page's socket boundary, or the rollback
 * engine's, dropped as off its schema. The machine reports
 * `late-join-stranded` when a late joiner has waited more than 20 s for
 * state. For the late joiner that is a notice: the scenario times the wait
 * itself and fails only if the notice and the measured wait contradict each
 * other. For anyone else it is a failure.
 *
 * Scenarios (SCENARIO picks one; default runs them all, each in its own room):
 *   late-join         a guest with no ROM joins a game already running, is
 *                     asked for one, then the host ends the game
 *   late-join-cached  the same, with the guest's ROM already in its library
 *   late-join-shared  the guest has no ROM and accepts the host's: its engine
 *                     first connects only to receive the ROM, then late-joins
 *   late-join-two-player  a third player joins a two-player match in play
 *   late-join-lost-host  the late-join scenario with a fault: once the host has
 *                     sent the state (over Socket.IO), the joiner's
 *                     RTCPeerConnection to the host is closed just before the
 *                     state reaches the page (the test holds that one message
 *                     in its socket proxy while it closes the connection), so
 *                     the joiner loses its channel to the host during the
 *                     serve, before it is activated. Its logs must show the
 *                     lost-host marker (`late-join: lost the channel to the
 *                     host`), then `LATE-JOIN-LOST-HOST-RESYNC`, then the
 *                     marker cleared by an applied host state (`the lost-host
 *                     resync is done`) or a visible
 *                     `LATE-JOIN-LOST-HOST-GIVEUP`; both pages must go on
 *                     advancing
 *   late-join-after-leave  the late-join scenario, then the guest leaves the
 *                     match for good (Leave: `leaving` to its peers,
 *                     `leave-room`) and the host plays on alone; the same
 *                     guest then joins it again late. Alone, the host's C
 *                     engine must skip its state save (no other slot is
 *                     active; specs/solo_save.qnt), counted by
 *                     kn_get_serialize_skip_count; once the guest is back its
 *                     input must start the saves again (the count stops), the
 *                     guest must arm with the host's delay, and the engine's
 *                     hash checks after the rejoin must match
 *   missed-game-end   a guest's signaling is down while the host ends the
 *                     game; on reconnect it must return to the lobby
 *   missed-game-end-at-rom-prompt  the same for a guest that joined mid-game
 *                     and is still being asked for a ROM (no engine yet)
 *   missed-new-match  the same, and the host starts another game before the
 *                     guest is back; on reconnect it must join the new match.
 *                     The host waits for the guest to load before it runs, so
 *                     the guest must be let into the start, not left asking
 *                     for a state nobody has yet
 *   abandoned-match   the only player running a match leaves while a guest
 *                     is still at the ROM prompt; the server must end the
 *                     match and give the guest the lobby back
 *   dropped-rejoin    a guest's signaling is down for longer than the server's
 *                     grace window, so the room drops it while the match goes
 *                     on over the players' own connections; on reconnect it
 *                     must be taken back and neither page may leave the match
 *   dropped-host      the same for the host, whose room is handed to the guest
 *   streaming-join    a third player joins a streamed game already running
 *   spectate          a spectator joins a game already running, then the host ends it
 *   spectator-forgery a bare Socket.IO client joins a two-player room as a
 *                     spectator and sends the relayed messages only the host
 *                     or a player may send, each with a forged sender stamp:
 *                     no page may act on any of them
 *   peer-channel-forgery  a player sends emulator state to the host on its
 *                     own data channel, where only the host's channel may
 *                     carry one: the host must refuse it
 *   host-reload       the host reloads mid-game; the server ends the match for the guest
 *
 * At each checkpoint the test also checks what the page itself shows (lobby
 * overlay up or down), so a run cannot pass with machine and page agreeing on
 * the wrong answer. An uncaught exception on any page fails the scenario.
 *
 * Every scenario also fails on a report from the observer beside the
 * rollback engine (tests/observer-reports.mjs; none reports now: the resync
 * request rules decide and the per-peer machine is driven): in the
 * client events at a checkpoint, and in each page's sync log at the end.
 * With KN_DB set to the
 * server's DB_PATH, the server's client_events rows for the scenario's room
 * are counted too; without it the query to run by hand is printed. Reading
 * KN_DB needs Node >= 22.13 (node:sqlite); on an older Node, or a database
 * that cannot be read, the scenario fails.
 *
 *   just serve        # the real server on :27888, in another terminal
 *   KN_ROM=/path/ssb64-us.z64 [KN_URL=http://localhost:27888] [SCENARIO=late-join] \
 *     [CHROMIUM_PATH=...] [OUT=/tmp/lifecycle-e2e] [KN_DB=server DB_PATH, Node >= 22.13] node tests/lifecycle-e2e.mjs
 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { requireCurrentBundle } from './bundle-check.mjs';
import {
  OBSERVER_EVENTS,
  observerDbNote,
  observerEventsInDb,
  observerLinesIn,
  observerTotal,
} from './observer-reports.mjs';

const URL = process.env.KN_URL || 'http://localhost:27888';
const ROM = process.env.KN_ROM;
const OUT = process.env.OUT || '/tmp/lifecycle-e2e';
const SCENARIOS = [
  'late-join',
  'late-join-cached',
  'late-join-shared',
  'late-join-two-player',
  'late-join-lost-host',
  'late-join-after-leave',
  'missed-game-end',
  'missed-game-end-at-rom-prompt',
  'missed-new-match',
  'abandoned-match',
  'dropped-rejoin',
  'dropped-host',
  'streaming-join',
  'spectate',
  'spectator-forgery',
  'peer-channel-forgery',
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
// Reports that mean a TypeScript module and the page (or the server) differ.
// The rollback engine's observer reports its own the same way.
const DISAGREEMENTS = ['session-disagree', 'play-disagree', 'protocol-mismatch', ...OBSERVER_EVENTS];
const SERVER_GRACE_MS = 30000; // _DISCONNECT_GRACE_SECONDS in server/src/api/signaling.py
const LATE_JOIN_REPORT_AFTER_MS = 20000; // web/src/session.ts

// The play page's TypeScript must be this tree's, built and served (bundle-check.mjs).
await requireCurrentBundle(fileURLToPath(new globalThis.URL('..', import.meta.url)), URL);

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
/**
 * A page in its own browser context, with a signaling socket the test can cut.
 * `fromServer(message, page)`, if given, sees each message from the server
 * before the page does; the page gets them in order once it has returned.
 */
const openPlayer = async (label, query, initScript = null, fromServer = null) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.addInitScript(recordEvents);
  if (initScript) await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  // A message the socket boundary (web/src/socket-boundary.ts) dropped: off
  // its schema, so no handler ran on it.
  const dropped = [];
  page.on('console', (m) => {
    if (m.text().startsWith('[protocol] dropped')) dropped.push(m.text());
  });
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
    if (fromServer) {
      let delivered = Promise.resolve();
      server.onMessage((message) => {
        delivered = delivered
          .then(() => fromServer(message, page))
          .catch((e) => console.log(`[${label}] fromServer failed: ${e.message}`))
          .then(() => ws.send(message))
          .catch(() => {});
      });
    }
  });
  await page.goto(`${URL}/play.html?${query}&knperf=light`);
  return { label, page, ctx, signaling, dropped };
};

// Keep every 'lockstep' data channel a page opens or is given, so a scenario
// can send on one as that page (the engine keeps them in a closure).
const keepLockstepChannels = () => {
  window.__knLockstepChannels = [];
  const keep = (channel) => {
    if (channel.label === 'lockstep') window.__knLockstepChannels.push(channel);
    return channel;
  };
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener('datachannel', (e) => keep(e.channel));
    }
    createDataChannel(...args) {
      return keep(super.createDataChannel(...args));
    }
  };
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
    const disagreements = (await eventsOf(player)).filter((e) => DISAGREEMENTS.includes(e.type));
    const stranded = await countOf(player, 'late-join-stranded');
    log.push({ checkpoint: name, player: player.label, reconnects, lobbyShown, disagreements, stranded });
    console.log(
      `  ${name}: ${player.label} reconnects=${reconnects} lobbyShown=${lobbyShown} ` +
        `disagreements=${disagreements.length} stranded=${stranded}`,
    );
    if (reconnects < 1) failures.push(`${name}: ${player.label} never reconnected, so nothing was compared`);
    if (lobbyShown !== lobby) failures.push(`${name}: ${player.label} ${lobby ? 'is not' : 'is'} showing the lobby`);
    if (disagreements.length)
      failures.push(`${name}: ${player.label} reported a disagreement ${JSON.stringify(disagreements)}`);
    if (player.dropped.length) failures.push(`${name}: ${player.label} dropped ${JSON.stringify(player.dropped)}`);
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
    // The host ran alone at a delay of 0; its first player moves the match to
    // a match delay at the join frame, on both pages (specs/engine_start.qnt,
    // REARM_AT_JOIN), and the two stay in step: the engine's own hash check
    // after the join matches.
    const logOf = (player) => player.page.evaluate(() => window.NetplayRollback?.exportSyncLog?.() || '');
    await waitUntil(async () => /RB-CHECK f=\d+ (?:MATCH|MISMATCH)/.test(await logOf(guest)), 120000);
    const [hostLog, guestLog] = [await logOf(host), await logOf(guest)];
    const atJoin = hostLog.match(/DELAY-AT-JOIN 0 -> (\d+) f=(\d+)/);
    const guestArm = guestLog.match(/C-ROLLBACK init: max=\d+ delay=(\d+)/);
    const checks = (log, kind) => (log.match(new RegExp(`RB-CHECK f=\\d+ ${kind}`, 'g')) || []).length;
    const delayAtJoin = {
      host: atJoin ? Number(atJoin[1]) : null,
      frame: atJoin ? Number(atJoin[2]) : null,
      guest: guestArm ? Number(guestArm[1]) : null,
      matches: checks(guestLog, 'MATCH') + checks(hostLog, 'MATCH'),
      mismatches: checks(guestLog, 'MISMATCH') + checks(hostLog, 'MISMATCH'),
    };
    log.push({ delayAtJoin });
    console.log(`  delay at the join: ${JSON.stringify(delayAtJoin)}`);
    if (!(delayAtJoin.host > 0)) failures.push('the host did not move the match above a delay of 0 at the join');
    if (delayAtJoin.guest !== delayAtJoin.host)
      failures.push('the joiner did not arm with the delay the host moved to');
    if (delayAtJoin.matches === 0) failures.push('no hash check after the join');
    if (delayAtJoin.mismatches > 0) failures.push('a hash check after the join mismatched');
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

  // A player leaves for good and the host plays on alone, then the same
  // player joins again late. While no other slot is active, the host's
  // kn_pre_tick skips its state save (specs/solo_save.qnt); the first input
  // from the player who came back starts it again, and the first save after
  // the stretch is whole. The engine's hash checks after the rejoin say the
  // two pages agree.
  'late-join-after-leave': async (room, failures, log) => {
    const logOf = (player) => player.page.evaluate(() => window.NetplayRollback?.exportSyncLog?.() || '');
    const skippedOn = (player) =>
      player.page.evaluate(() => window.EJS_emulator?.gameManager?.Module?._kn_get_serialize_skip_count?.() ?? null);
    const host = await startSoloGame(room);
    if (!(await waitForFrames([host], 120, 120000))) failures.push('the host game never started');

    const guest = await openPlayer('guest', `room=${room}&name=Guest`);
    await guest.page.waitForSelector('#rom-drop', { state: 'visible', timeout: 30000 });
    await loadRom(guest);
    const joined = await waitUntil(async () => {
      await clickGesturePrompt(guest);
      return (await frameOf(guest)) > 0;
    }, 180000);
    if (!joined) failures.push('the late joiner never received state');
    if (!(await waitForFrames([host, guest], 120, 120000))) failures.push('the game stopped advancing after the join');
    const delayMatch = (await logOf(host)).match(/DELAY-AT-JOIN 0 -> (\d+) f=\d+/);
    const hostDelay = delayMatch ? Number(delayMatch[1]) : null;

    // The guest leaves for good. The host plays on alone and skips its saves.
    const skippedWhileTwo = await skippedOn(host);
    await guest.page.evaluate(() => document.getElementById('toolbar-leave')?.click());
    if (!(await waitUntil(async () => (await playersInRoom(room)) === 1, 30000)))
      failures.push('the room did not let the guest go');
    const leftAtFrame = await frameOf(host);
    if (!(await waitForFrames([host], 120, 120000))) failures.push('the host stopped advancing after the guest left');
    const skippedAlone = await skippedOn(host);
    if (skippedAlone === null) failures.push("the host's core has no kn_get_serialize_skip_count");
    else if (!(skippedAlone > skippedWhileTwo))
      failures.push(`the host did not skip its saves once alone (count ${skippedWhileTwo} -> ${skippedAlone})`);

    // The same guest joins again late, from its library this time.
    await guest.page.goto(`${URL}/play.html?room=${room}&name=Guest&knperf=light`);
    const rejoined = await waitUntil(async () => {
      await clickGesturePrompt(guest);
      return (await frameOf(guest)) > 0;
    }, 240000);
    if (!rejoined) failures.push('the guest never received state when it joined again');
    if (!(await waitForFrames([host, guest], 60, 120000))) failures.push('the game stopped advancing after the rejoin');
    const skippedAfterRejoin = await skippedOn(host);
    if (!(await waitForFrames([host, guest], 120, 120000)))
      failures.push('the game stopped advancing after the rejoin');
    const skippedLater = await skippedOn(host);
    if (skippedLater !== skippedAfterRejoin)
      failures.push(
        `the host kept skipping its saves with the guest back (count ${skippedAfterRejoin} -> ${skippedLater})`,
      );

    await waitUntil(async () => /RB-CHECK f=\d+ (?:MATCH|MISMATCH)/.test(await logOf(guest)), 120000);
    const [hostLog, guestLog] = [await logOf(host), await logOf(guest)];
    const guestArm = guestLog.match(/C-ROLLBACK init: max=\d+ delay=(\d+)/);
    // The guest's page is new, so all its checks are after the rejoin; the
    // host's are counted from the frame it was on when the guest left.
    const checksAfter = (text, kind, from) =>
      [...text.matchAll(new RegExp(`RB-CHECK f=(\\d+) ${kind}`, 'g'))].filter((m) => Number(m[1]) >= from).length;
    const afterLeave = {
      hostDelay,
      guestArmDelay: guestArm ? Number(guestArm[1]) : null,
      skipped: { whileTwo: skippedWhileTwo, alone: skippedAlone, afterRejoin: skippedAfterRejoin, later: skippedLater },
      leftAtFrame,
      saveLines: (hostLog.match(/SAVE-(?:SKIP|RESUME)[^\n]*/g) || []).slice(-4),
      matches: checksAfter(guestLog, 'MATCH', 0) + checksAfter(hostLog, 'MATCH', leftAtFrame),
      mismatches: checksAfter(guestLog, 'MISMATCH', 0) + checksAfter(hostLog, 'MISMATCH', leftAtFrame),
    };
    log.push({ afterLeave });
    console.log(`  after the leave and rejoin: ${JSON.stringify(afterLeave)}`);
    if (afterLeave.guestArmDelay !== hostDelay)
      failures.push("the guest did not arm with the host's delay when it rejoined");
    if (afterLeave.matches === 0) failures.push('no hash check after the rejoin');
    if (afterLeave.mismatches > 0) failures.push('a hash check after the rejoin mismatched');
    await checkpoint(
      'after the rejoin',
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

  'late-join-lost-host': async (room, failures, log) => {
    const host = await startSoloGame(room);
    if (!(await waitForFrames([host], 120, 120000))) failures.push('the host game never started');

    // The state reaches the joiner over Socket.IO. Just before the page gets
    // it, the joiner's connection to the host is closed: the host has sent
    // the state and the joiner is not yet activated.
    let cut = null;
    const cutBeforeState = async (message, page) => {
      if (cut || !String(message).includes('"late-join-state"')) return;
      cut = await page.evaluate(() => {
        const entry = Object.values(window.KNState?.peers ?? {}).find((peer) => peer.slot === 0);
        if (!entry?.pc) return { closed: false, why: 'no peer entry for slot 0' };
        const was = { pc: entry.pc.connectionState, dc: entry.dc?.readyState ?? null };
        entry.pc.close();
        return { closed: true, was };
      });
      console.log(`  closed the joiner's connection to the host as the state arrived: ${JSON.stringify(cut)}`);
    };
    const guest = await openPlayer('guest', `room=${room}&name=Guest`, null, cutBeforeState);
    await guest.page.waitForSelector('#rom-drop', { state: 'visible', timeout: 30000 });
    await loadRom(guest);
    const synced = await waitUntil(async () => {
      await clickGesturePrompt(guest);
      return (await frameOf(guest)) > 0;
    }, 180000);
    if (!synced) failures.push('the late joiner never received state');
    if (!cut?.closed) failures.push(`the joiner's connection to the host was not closed (${JSON.stringify(cut)})`);

    // The lost-host path, in the joiner's own log: the marker, a resync
    // request, and then the marker cleared by an applied host state, or a
    // visible give-up. The asks are bounded (3, 8 s apart at most).
    const syncLog = () => guest.page.evaluate(() => window.NetplayRollback?.exportSyncLog?.() || '');
    const ended = /the lost-host resync is done|LATE-JOIN-LOST-HOST-GIVEUP/;
    await waitUntil(async () => ended.test(await syncLog()), 90000);
    const joinerLog = await syncLog();
    const lineOf = (re) => joinerLog.split('\n').find((line) => re.test(line)) ?? null;
    const path = {
      marker: lineOf(/late-join: lost the channel to the host/),
      resync: lineOf(/LATE-JOIN-LOST-HOST-RESYNC/),
      done: lineOf(/the lost-host resync is done/),
      giveUp: lineOf(/LATE-JOIN-LOST-HOST-GIVEUP/),
      asks: (joinerLog.match(/LATE-JOIN-LOST-HOST-RESYNC/g) || []).length,
    };
    log.push({ cut, lostHostPath: path });
    console.log(`  lost-host path: ${JSON.stringify(path)}`);
    if (!path.marker) failures.push('the joiner never logged that it lost the channel to the host');
    if (!path.resync) failures.push('the joiner never asked for the lost-host resync');
    if (!path.done && !path.giveUp) failures.push('the lost-host resync neither completed nor gave up');
    const seqOf = (line) => Number(line?.split('\t')[0]);
    if (path.marker && path.resync && seqOf(path.resync) < seqOf(path.marker))
      failures.push('the joiner asked for the lost-host resync before it lost the channel');
    if (path.done && path.resync && seqOf(path.done) < seqOf(path.resync))
      failures.push('the lost-host marker was cleared before the resync was asked for');

    if (!(await waitForFrames([host, guest], 60, 120000))) failures.push('the game stopped advancing after the join');
    await checkpoint(
      'after late join with a lost host channel',
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

  'abandoned-match': async (room, failures, log) => {
    const host = await startSoloGame(room);
    if (!(await waitForFrames([host], 120, 120000))) failures.push('the host game never started');
    // The guest joins mid-game with no ROM and is asked for one.
    const guest = await openPlayer('guest', `room=${room}&name=Guest`);
    await guest.page.waitForSelector('#rom-drop', { state: 'visible', timeout: 30000 });
    // The only player running the match leaves for good.
    await host.ctx.close();
    // The server drops the host after its grace window and, with only a
    // waiting joiner left, ends the match: the guest gets the lobby back.
    const ended = await waitUntil(
      async () => (await lobbyShownOn(guest)) && !(await guest.page.locator('#late-join-msg').count()),
      SERVER_GRACE_MS + 30000,
    );
    if (!ended) failures.push('the guest was left joining a match nobody was running');
    const res = await fetch(`${URL}/room/${room}`);
    const status = res.ok ? (await res.json()).status : `HTTP ${res.status}`;
    if (status !== 'lobby') failures.push(`the room is still ${status} with nobody running the match`);
    await checkpoint('after the abandoned match was ended', [{ player: guest, lobby: true }], failures, log);
    return [guest];
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

  'spectator-forgery': async (room, failures, log) => {
    const host = await openPlayer('host', `room=${room}&host=1&name=Host&mode=rollback`);
    await host.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
    const guest = await openPlayer('guest', `room=${room}&name=Guest`);
    await guest.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });

    // The forger is not a play page: it speaks Socket.IO directly, so
    // nothing the pages do limits what it can send.
    const forgerCtx = await browser.newContext();
    const forger = await forgerCtx.newPage();
    await forger.goto(`${URL}/error.html`);
    await forger.addScriptTag({ url: `${URL}/static/socket.io.min.js` });
    const forgerSid = await forger.evaluate(
      (roomCode) =>
        new Promise((resolve) => {
          const socket = io();
          window.forgerSocket = socket;
          window.roster = null;
          socket.on('users-updated', (roster) => {
            window.roster = roster;
          });
          socket.on('connect', () =>
            socket.emit(
              'join-room',
              { extra: { sessionid: roomCode, player_name: 'Forger', spectate: true } },
              (_error, roster) => {
                window.roster = roster ?? window.roster;
                resolve(socket.id);
              },
            ),
          );
        }),
      room,
    );
    const sidInSlot = (slot) =>
      forger.evaluate((s) => Object.values(window.roster?.players ?? {}).find((p) => p.slot === s)?.socketId, slot);
    if (!(await waitUntil(async () => !!(await sidInSlot(0)) && !!(await sidInSlot(1)), 20000)))
      failures.push('the forger never saw both players in the roster');
    const hostSid = await sidInSlot(0);
    const guestSid = await sidInSlot(1);
    // Every forged message claims the host's stamp; the server must replace it.
    const asHost = { sid: hostSid, slot: 0, owner: true };
    const forge = (message) =>
      forger.evaluate((m) => window.forgerSocket.emit('data-message', m), { ...message, knFrom: asHost });

    const guestMode = () => guest.page.evaluate(() => document.getElementById('mode-select')?.value ?? null);
    const modeBefore = await guestMode();
    await forge({ type: 'mode-select', mode: 'streaming' });
    await guest.page.waitForTimeout(2000);
    if ((await guestMode()) !== modeBefore)
      failures.push(`a spectator changed the guest's mode to ${await guestMode()}`);

    for (const p of [host, guest]) await loadRom(p);
    await host.page.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
    await host.page.click('#start-btn');
    if (!(await waitForFrames([host, guest], 120, 240000))) failures.push('the two-player game never started');

    // Each forgery has every field the real message has (web/src/
    // peer-protocol.ts), so the page's protocol observer has nothing to
    // report and the sender stamp is the only thing that can refuse it.
    await forge({
      type: 'sync-state-socket',
      targetSid: guestSid,
      senderSid: hostSid,
      frame: 1,
      full: true,
      proactive: false,
      reason: 'forged',
      rawSize: 3,
      compressedSize: 3,
      data: 'AAAA',
    });
    await forge({ type: 'late-join-state', targetSid: guestSid, frame: 1, data: 'AAAA' });
    await forge({ type: 'save-state', frame: 0, data: 'AAAA' });
    await forge({ type: 'request-late-join', requesterSid: guestSid });
    await forge({
      type: 'sync-request-full-socket',
      targetSid: hostSid,
      requesterSid: guestSid,
      reason: 'forged',
      frame: 1,
    });
    await forge({ type: 'late-join-ready', senderSid: guestSid });
    await host.page.waitForTimeout(6000);

    const syncLogOf = (player) => player.page.evaluate(() => window.NetplayRollback?.exportSyncLog?.() || '');
    const guestLog = await syncLogOf(guest);
    const hostLog = await syncLogOf(host);
    const refusedBy = (text, type) => text.includes(`relayed ${type} refused: sender ${forgerSid} slot=null`);
    for (const type of ['sync-state-socket', 'late-join-state', 'save-state'])
      if (!refusedBy(guestLog, type)) failures.push(`the guest did not refuse the spectator's ${type}`);
    for (const type of ['request-late-join', 'sync-request-full-socket', 'late-join-ready'])
      if (!refusedBy(hostLog, type)) failures.push(`the host did not refuse the spectator's ${type}`);
    if (/socket sync-state (received|failed)/.test(guestLog)) failures.push('the guest tried to load a forged state');
    if (/received late-join request|received socket sync-request-full|sending late-join state/.test(hostLog))
      failures.push('the host acted on a forged request for state');
    log.push({ forger: forgerSid, refusedByGuest: 3, refusedByHost: 3 });

    if (!(await waitForFrames([host, guest], 120, 240000)))
      failures.push('the game stopped advancing after the forgery');
    await checkpoint(
      'after the forgery',
      [
        { player: host, lobby: false },
        { player: guest, lobby: false },
      ],
      failures,
      log,
    );
    return [host, guest];
  },

  'peer-channel-forgery': async (room, failures, log) => {
    const host = await openPlayer('host', `room=${room}&host=1&name=Host&mode=rollback`);
    await host.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
    const guest = await openPlayer('guest', `room=${room}&name=Guest`, keepLockstepChannels);
    await guest.page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
    for (const p of [host, guest]) await loadRom(p);
    await host.page.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
    await host.page.click('#start-btn');
    if (!(await waitForFrames([host, guest], 120, 240000))) failures.push('the two-player game never started');

    // The guest is slot 1. It sends what only the host sends, complete as
    // the real messages are (web/src/peer-protocol.ts), on its own channel
    // to the host.
    const sent = await guest.page.evaluate(() => {
      const open = window.__knLockstepChannels.filter((channel) => channel.readyState === 'open');
      for (const channel of open) {
        channel.send(JSON.stringify({ type: 'save-state', frame: 0, data: 'AAAA' }));
        channel.send(JSON.stringify({ type: 'late-join-state', targetSid: 'anyone', frame: 1, data: 'AAAA' }));
      }
      return open.length;
    });
    if (sent < 1) failures.push('the guest had no open channel to forge on');
    await host.page.waitForTimeout(4000);

    const hostLog = await host.page.evaluate(() => window.NetplayRollback?.exportSyncLog?.() || '');
    for (const type of ['save-state', 'late-join-state'])
      if (!hostLog.includes(`${type} on the channel of slot 1 refused`))
        failures.push(`the host did not refuse a ${type} sent on a player's channel`);
    if (/received initial state|received late-join state/.test(hostLog))
      failures.push('the host passed a forged state to its loader');
    log.push({ channelsForgedOn: sent });

    if (!(await waitForFrames([host, guest], 120, 240000)))
      failures.push('the game stopped advancing after the forgery');
    await checkpoint(
      'after the forgery',
      [
        { player: host, lobby: false },
        { player: guest, lobby: false },
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
  const observers = {};
  for (const player of players) {
    const sync = await player.page.evaluate(() => window.NetplayRollback?.exportSyncLog?.() || '').catch(() => '');
    fs.writeFileSync(`${OUT}/${name}-${player.label}-sync.txt`, sync);
    observers[player.label] = observerLinesIn(sync);
  }
  // Give the pages' last client events time to reach the server.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const ctx of browser.contexts()) await ctx.close();
  observers.db = await observerEventsInDb(process.env.KN_DB, [room]).catch((e) => ({ error: e.message }));
  const dbNote = observerDbNote(process.env.KN_DB, [room]);
  if (dbNote) console.log(`  ${dbNote}`);
  console.log(`  observers: ${JSON.stringify(observers)}`);
  if (observers.db?.error) failures.push(`KN_DB could not be read: ${observers.db.error}`);
  else if (observerTotal(...Object.values(observers)) > 0)
    failures.push(`an observer beside the rollback engine disagreed: ${JSON.stringify(observers)}`);
  for (const error of pageErrors.splice(0)) failures.push(`uncaught page error (${error.label}: ${error.message})`);
  results.push({ scenario: name, room, checkpoints: log, observers, failures });
}

await browser.close();
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(results, null, 1));
console.log(JSON.stringify(results, null, 1));
process.exit(results.some((r) => r.failures.length) ? 1 : 0);
