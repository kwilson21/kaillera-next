/**
 * Three- or four-player rollback run on the real SSB64 ROM: the mesh the
 * engine is built for (every page connected to every other), which
 * tests/rb-two-player.mjs, with its host and one guest, cannot show.
 *
 * Each page joins the room in turn and takes the next slot; the host starts a
 * rollback game. The menu autopilot (web/src/page/menu-autopilot.ts) drives
 * each page's own slot to the VS battle (P1 the menus, every player its
 * fighter: Mario, DK, Link, Samus), then each page plays random inputs. Every
 * page records its gameplay, game-state and full-state hashes per frame; each
 * guest's are compared with the host's on every frame both recorded. The run
 * fails on any gameplay or game-state mismatch, on a page that never reaches
 * the battle, or on too few battle frames compared.
 *
 *   just serve        # the real server on :27888, in another terminal
 *   KN_ROM=/path/ssb64-us.z64 [PLAYERS=4] [LAT=50] [JITTER=20] [LINK_KBPS=0] \
 *     [BATTLE_SECONDS=45] [CATCH_UP_MS=0] [CATCH_UP_SLOT=2] [MENU_AUTOPILOT=ssb64|any-fighter] \
 *     [KN_QUERY='&knperf=light'] [HEADED=1] [OUT=/tmp/rb-mesh] node tests/rb-mesh.mjs
 *
 * PLAYERS: 3 or 4 (default 4). Four emulators share the machine: in a cloud
 *   container each runs at a few frames a second, so the menus take minutes.
 *   MENU_TIMEOUT_S bounds them (default 1800).
 * CATCH_UP_MS=<n>: a third of the way into the battle the guest in
 *   CATCH_UP_SLOT (default 2, a guest that is not the host's first one) asks
 *   the host for a full resync through its network-change handler (a window
 *   `online` event: an immediate, numbered `sync-request-full`), and the
 *   host's answer is held n ms on its way, less than the guest's request
 *   deadline (8000): it arrives as the request's own answer, the host's state
 *   from n ms before, with the guest that far on. The guest catches up from
 *   it (SYNC-CATCH-UP; specs/resync_flow.qnt, ownAnswerBehindTest): the frames
 *   up to its own run again on every other player's inputs, which it holds
 *   for the host and for the other guests. The run fails unless the guest
 *   caught up all the way to the frame it was on, and every page's hashes
 *   still match the host's.
 *
 * The simulated network (LAT, JITTER, LINK_KBPS, the answer hold) is
 * tests/rb-page-network.mjs, the two-player run's.
 */
import { chromium } from 'playwright';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { requireCurrentBundle } from './bundle-check.mjs';
import { addNetworkInitScript } from './rb-page-network.mjs';

const URL = process.env.KN_URL || 'http://localhost:27888';
const ROM = process.env.KN_ROM;
const PLAYERS = Number(process.env.PLAYERS || 4);
const LAT = Number(process.env.LAT || 50);
const JITTER = Number(process.env.JITTER || 0);
const LINK_KBPS = Number(process.env.LINK_KBPS || 0);
const BATTLE_SECONDS = Number(process.env.BATTLE_SECONDS || 45);
const MENU_TIMEOUT_S = Number(process.env.MENU_TIMEOUT_S || 1800);
const CATCH_UP_MS = Number(process.env.CATCH_UP_MS || 0);
const CATCH_UP_SLOT = Number(process.env.CATCH_UP_SLOT || 2);
const QUERY = process.env.KN_QUERY || '';
const OUT = process.env.OUT || '/tmp/rb-mesh';
const HEADLESS = process.env.HEADED !== '1';
// The guest's own deadline on a resync request (netplay-rollback.js).
const RESYNC_REQUEST_TIMEOUT_MS = 8000;
// The held answer, then its catch-up.
const CATCH_UP_RECOVER_MS = 60000;
// Battle frames compared per guest, at the least, for the run to say anything.
const MIN_BATTLE_FRAMES = 60;
// Hashes are recorded this many frames behind the frame just run: past the
// rollback window, so a later rollback no longer changes them.
const HASH_LAG = 12;

const fail = (msg) => {
  console.log(msg);
  process.exit(1);
};
if (!ROM || !fs.existsSync(ROM)) fail('KN_ROM must name the ROM file');
if (![3, 4].includes(PLAYERS)) fail(`PLAYERS=${process.env.PLAYERS} invalid: 3 or 4`);
for (const [name, v] of Object.entries({ LAT, JITTER, LINK_KBPS, BATTLE_SECONDS, MENU_TIMEOUT_S, CATCH_UP_MS })) {
  if (!(Number.isFinite(v) && v >= 0)) fail(`${name}=${process.env[name]} invalid: a finite number >= 0`);
}
if (CATCH_UP_MS > 0 && !(CATCH_UP_MS < RESYNC_REQUEST_TIMEOUT_MS)) {
  fail(`CATCH_UP_MS must be shorter than the guest's request deadline (${RESYNC_REQUEST_TIMEOUT_MS})`);
}
if (CATCH_UP_MS > 0 && !(Number.isInteger(CATCH_UP_SLOT) && CATCH_UP_SLOT >= 1 && CATCH_UP_SLOT < PLAYERS)) {
  fail(`CATCH_UP_SLOT=${process.env.CATCH_UP_SLOT} invalid: a guest's slot, 1 to ${PLAYERS - 1}`);
}
fs.mkdirSync(OUT, { recursive: true });

await requireCurrentBundle(fileURLToPath(new globalThis.URL('..', import.meta.url)), URL);

const room = 'MS' + Math.random().toString(36).slice(2, 8).toUpperCase();
const launch = {
  headless: HEADLESS,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
};
if (process.env.CHROMIUM_PATH) launch.executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(launch);

const mkPage = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 720 } });
  await addNetworkInitScript(ctx, { lat: LAT, jitter: JITTER, kbps: LINK_KBPS });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror ${e.message}`));
  return page;
};

// One page per player, joined in turn so each takes the next slot.
const pages = [];
for (let i = 0; i < PLAYERS; i++) {
  const page = await mkPage(`P${i + 1}`);
  const host = i === 0 ? '&host=1&mode=rollback' : '';
  await page.goto(`${URL}/play.html?room=${room}${host}&name=P${i + 1}${QUERY}`);
  await page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
  pages.push(page);
}
const host = pages[0];
for (const p of pages) await p.locator("#rom-drop input[type='file']").setInputFiles(ROM);
await host.waitForSelector('#start-btn:not([disabled])', { timeout: 120000 });
await host.selectOption('#mode-select', 'rollback');
await host.waitForSelector('#start-btn:not([disabled])', { timeout: 20000 });
const romHash = (await host.evaluate(() => window.KNState?.romHash)) || '';
const SSB64_US_HASH = 'S15592e79d3c5295cef4371d4992f0bd25bec2102fc29644c93e682f7ea99ef3d';
const anyFighter = process.env.MENU_AUTOPILOT
  ? process.env.MENU_AUTOPILOT === 'any-fighter'
  : !!romHash && romHash !== SSB64_US_HASH;
console.log(`room ${room}: ${PLAYERS} players ROM-ready; starting (anyFighter=${anyFighter})`);
await host.click('#start-btn');

// Dismiss the tap-to-start prompt wherever it shows, until every emulator runs.
const t0 = Date.now();
for (;;) {
  if (Date.now() - t0 > 180000) fail('the emulators did not all start within 180 s');
  for (const p of pages) {
    if (await p.locator('#gesture-prompt:not(.hidden)').count()) {
      await p
        .locator('#gesture-prompt')
        .click({ force: true })
        .catch(() => {});
    }
  }
  const ready = await Promise.all(
    pages.map((p) =>
      p.evaluate(
        () => !!window.NetplayRollback?.getHudCounters?.()?.currentFrame && !!window.EJS_emulator?.gameManager?.Module,
      ),
    ),
  );
  if (ready.every(Boolean)) break;
  await host.waitForTimeout(1000);
}
const slots = await Promise.all(pages.map((p) => p.evaluate(() => window.KNState?.slot)));
console.log('slots', JSON.stringify(slots));
if (slots.some((s, i) => s !== i)) fail(`pages did not take slots 0..${PLAYERS - 1} in join order: ${slots}`);

// Autopilot for the page's own slot, random battle inputs, and the hash recorder.
const install = async (p, slot) => {
  await p.addScriptTag({ url: `${URL}/static/ssb64-menu-autopilot.js` });
  await p.evaluate(
    ({ slot, players, anyFighter, hashLag }) => {
      const W = (window.__mesh = { slot, hashes: {}, scene: -1, inBattleAt: -1, pilotFail: null, lastR: undefined });
      const rb = window.NetplayRollback;
      const frameNow = () => rb.getHudCounters?.()?.currentFrame ?? 0;
      const pilot = window.KNMenuAutopilot.create({
        read32: (a) => rb.readRdram32(a),
        log: (m) => (W.pilotFail = m),
        anyFighter,
        players,
      });
      const actor = [pilot.p1, pilot.p2, pilot.p3, pilot.p4][slot];
      let held = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
      let until = 0;
      let btnCool = 0;
      let btnHeld = 0;
      const BTN = [0, 1, 6, 7]; // A, B, D-left, D-right (no START)
      const orig = window.KNShared.readLocalInput.bind(window.KNShared);
      window.KNShared.readLocalInput = (s, keyMap, heldKeys) => {
        orig(s, keyMap, heldKeys);
        const f = frameNow();
        const sc = (rb.readRdram32(0x800a4ad0) >>> 24) & 0xff;
        W.scene = sc;
        if (sc !== 22) {
          // Space button presses by the input delay so a press lands (and the
          // closed loop sees it) before the next one; sticks pass through.
          const d = (rb.getHudCounters?.()?.delay ?? 2) + 6;
          let inp = actor(f);
          if (inp.buttons) {
            if (btnCool > f && btnHeld !== inp.buttons) inp = { ...inp, buttons: 0 };
            else {
              btnHeld = inp.buttons;
              btnCool = f + d + 4;
            }
          } else if (btnHeld) {
            btnHeld = 0;
            btnCool = f + d;
          }
          return inp;
        }
        if (W.inBattleAt < 0) W.inBattleAt = f;
        if (f >= until) {
          const r = Math.random();
          held = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
          if (r < 0.35) held.lx = Math.random() < 0.5 ? -70 : 70;
          else if (r < 0.55) held.buttons = 1 << BTN[(Math.random() * BTN.length) | 0];
          else if (r < 0.7) {
            held.lx = Math.random() < 0.5 ? -50 : 50;
            held.buttons = 1;
          } else if (r < 0.8) held.ly = -70;
          until = f + 8 + ((Math.random() * 40) | 0);
        }
        return held;
      };
      const m = window.EJS_emulator.gameManager.Module;
      const post = m._kn_post_tick;
      m._kn_post_tick = function (...a) {
        const r = post.apply(this, a);
        const idle = (m._kn_get_replay_depth?.() ?? 0) === 0;
        // A resync that takes the counter back (and the catch-up that runs the
        // frames again) makes hashes already recorded from there on stale.
        if (idle && W.lastR !== undefined && r < W.lastR) {
          for (const k of Object.keys(W.hashes)) if (+k >= r - hashLag) delete W.hashes[k];
        }
        if (idle) W.lastR = r;
        if (idle && r > 40) {
          const f = r - hashLag;
          if (!(f in W.hashes)) {
            W.hashes[f] = [
              m._kn_gameplay_hash(f) >>> 0,
              (m._kn_game_state_hash?.(f) ?? 0) >>> 0,
              m._kn_full_state_hash(f) >>> 0,
            ];
          }
        }
        return r;
      };
    },
    { slot, players: PLAYERS, anyFighter, hashLag: HASH_LAG },
  );
};
for (let i = 0; i < PLAYERS; i++) await install(pages[i], i);

// Menus: until every page is in the battle.
const tMenu = Date.now();
for (;;) {
  const s = await Promise.all(
    pages.map((p) =>
      p.evaluate(() => ({
        f: window.NetplayRollback.getHudCounters().currentFrame,
        sc: window.__mesh.scene,
        b: window.__mesh.inBattleAt,
        fail: window.__mesh.pilotFail,
      })),
    ),
  );
  console.log('menus', JSON.stringify(s));
  if (s.some((x) => x.fail)) {
    await host.screenshot({ path: `${OUT}/host-stuck.png` }).catch(() => {});
    fail(`autopilot stopped: ${s.map((x) => x.fail).join(' | ')}`);
  }
  if (s.every((x) => x.b >= 0)) break;
  if (Date.now() - tMenu > MENU_TIMEOUT_S * 1000) {
    await host.screenshot({ path: `${OUT}/host-stuck.png` }).catch(() => {});
    fail(`not every page reached the battle within ${MENU_TIMEOUT_S} s`);
  }
  await host.waitForTimeout(5000);
}
console.log(`in battle; playing ${BATTLE_SECONDS} s`);

const syncLogOf = (page) => page.evaluate(() => window.NetplayRollback?.exportSyncLog?.() || '');
const seqOf = (line) => Number(line.split('\t')[0]);
const lastSeq = async (page) => {
  const last = (await syncLogOf(page)).trimEnd().split('\n').at(-1) ?? '';
  return seqOf(last) || 0;
};
const waitForLine = async (page, afterSeq, re, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const lines = (await syncLogOf(page)).split('\n').filter((line) => seqOf(line) > afterSeq);
    if (lines.some((line) => re.test(line))) return true;
    await page.waitForTimeout(500);
  }
  return false;
};

// The battle, with the catch-up fault a third of the way in.
const catchUp = { guestAt: null, seen: false };
const tBattle = Date.now();
if (CATCH_UP_MS > 0) {
  await host.waitForTimeout((BATTLE_SECONDS * 1000) / 3);
  const guest = pages[CATCH_UP_SLOT];
  catchUp.guestAt = await lastSeq(guest);
  await host.evaluate((ms) => {
    window.__knHoldSyncAnswerMs = ms;
  }, CATCH_UP_MS);
  await guest.evaluate(() => window.dispatchEvent(new Event('online')));
  console.log(`CATCH_UP_MS: P${CATCH_UP_SLOT + 1} asked for a resync; the host's answer is held ${CATCH_UP_MS} ms`);
  catchUp.seen = await waitForLine(guest, catchUp.guestAt, /SYNC-CATCH-UP from=/, CATCH_UP_MS + CATCH_UP_RECOVER_MS);
  console.log(catchUp.seen ? 'CATCH_UP_MS: the guest caught up' : 'CATCH_UP_MS: the guest never logged SYNC-CATCH-UP');
}
await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - (Date.now() - tBattle)));

// Collect, then compare every guest with the host.
const P = await Promise.all(
  pages.map(async (p) => ({
    sync: await syncLogOf(p),
    ...(await p.evaluate(() => ({
      hashes: window.__mesh.hashes,
      inBattleAt: window.__mesh.inBattleAt,
      lastR: window.__mesh.lastR,
      // Who the battle state says is playing: each player's kind (0 = human)
      // and fighter, the bytes at +2 and +3 of its 0x74-byte entry from
      // 0x800A4D28 (gSCManagerTransferBattleState's players, web/src/address-maps.ts).
      fighters: [0, 1, 2, 3].map((i) => {
        const w = window.NetplayRollback.readRdram32(0x800a4d28 + 0x74 * i);
        return { kind: (w >>> 8) & 0xff, fkind: w & 0xff };
      }),
    }))),
  })),
);
P.forEach((x, i) => fs.writeFileSync(`${OUT}/p${i + 1}-sync.txt`, x.sync));
await browser.close();

const catchUpsOf = (log, afterSeq = -1) =>
  log
    .split('\n')
    .filter((line) => seqOf(line) > afterSeq)
    .flatMap((line) => {
      const m = line.match(/SYNC-CATCH-UP from=(\d+) to=(\d+) of=(\d+) frames=(\d+) ms=([\d.]+)/);
      return m ? [{ from: +m[1], to: +m[2], of: +m[3], frames: +m[4], ms: +m[5], stopped: /stopped:/.test(line) }] : [];
    });

const H = P[0];
const pairs = P.slice(1).map((G, gi) => {
  const slot = gi + 1;
  const battleFrom = Math.max(H.inBattleAt, G.inBattleAt);
  let compared = 0;
  let battle = 0;
  const mismatches = { gameplay: [], gameState: [], fullState: 0 };
  for (const k of Object.keys(G.hashes)) {
    const f = +k;
    const h = H.hashes[k];
    if (!h) continue;
    const g = G.hashes[k];
    compared++;
    if (f >= battleFrom) battle++;
    if (h[0] !== g[0]) mismatches.gameplay.push(f);
    if (h[1] !== g[1]) mismatches.gameState.push(f);
    if (h[2] !== g[2]) mismatches.fullState++;
  }
  mismatches.gameplay.sort((a, b) => a - b);
  mismatches.gameState.sort((a, b) => a - b);
  return {
    slot,
    compared,
    battleFramesCompared: battle,
    gameplayMismatches: mismatches.gameplay.length,
    firstGameplayMismatch: mismatches.gameplay[0] ?? null,
    gameStateMismatches: mismatches.gameState.length,
    firstGameStateMismatch: mismatches.gameState[0] ?? null,
    fullStateMismatches: mismatches.fullState,
    catchUps: catchUpsOf(G.sync),
  };
});

const catchUpReport =
  CATCH_UP_MS > 0
    ? {
        ms: CATCH_UP_MS,
        slot: CATCH_UP_SLOT,
        seen: catchUp.seen,
        catchUps: catchUpsOf(P[CATCH_UP_SLOT].sync, catchUp.guestAt),
        tooOld: P[CATCH_UP_SLOT].sync.split('\n').filter((line) => /SYNC-TOO-OLD-DROPPED/.test(line)),
      }
    : null;
const catchUpFailed =
  CATCH_UP_MS > 0 && !catchUpReport.catchUps.some((c) => c.frames > 0 && c.to === c.of && !c.stopped);

// The battle has every page's player in it, each on the fighter its
// autopilot picks (PORTRAIT_TARGETS in web/src/page/menu-autopilot.ts:
// Mario, DK, Link, Samus), and every page agrees.
const FIGHTERS = [0, 2, 5, 3];
const HUMAN = 0;
const fighterProblems = P.flatMap((x, page) =>
  x.fighters.flatMap((f, i) => {
    if (i >= PLAYERS) return [];
    if (f.kind !== HUMAN) return [`P${page + 1} sees player ${i + 1} as kind ${f.kind}, not human`];
    if (!anyFighter && f.fkind !== FIGHTERS[i])
      return [`P${page + 1} sees player ${i + 1} on fighter ${f.fkind}, not ${FIGHTERS[i]}`];
    if (f.fkind !== H.fighters[i].fkind)
      return [`P${page + 1} sees player ${i + 1} on fighter ${f.fkind}, the host ${H.fighters[i].fkind}`];
    return [];
  }),
);

const summary = {
  room,
  players: PLAYERS,
  latencyMs: LAT,
  jitterMs: JITTER,
  linkKbps: LINK_KBPS,
  inBattleAt: P.map((x) => x.inBattleAt),
  lastFrame: P.map((x) => x.lastR),
  fighters: H.fighters,
  fighterProblems,
  pairs,
  catchUp: catchUpReport,
};
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

const failed =
  P.some((x) => x.inBattleAt < 0) ||
  fighterProblems.length > 0 ||
  pairs.some(
    (p) => p.gameplayMismatches > 0 || p.gameStateMismatches > 0 || p.battleFramesCompared < MIN_BATTLE_FRAMES,
  ) ||
  catchUpFailed;
console.log(
  failed
    ? `FAIL: ${pairs.map((p) => `P${p.slot + 1} gp=${p.gameplayMismatches} gs=${p.gameStateMismatches} battle=${p.battleFramesCompared}`).join(', ')}${catchUpFailed ? '; the catch-up did not run all the way' : ''}${fighterProblems.length ? `; ${fighterProblems.join('; ')}` : ''}`
    : `PASS: all ${PLAYERS} fighters in the battle; every guest's hashes match the host's (${pairs.map((p) => `P${p.slot + 1} ${p.battleFramesCompared} battle frames`).join(', ')})`,
);
process.exit(failed ? 1 : 0);
