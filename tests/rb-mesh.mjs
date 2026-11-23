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
 * MISSING_RECIPIENT=1 (PLAYERS=3|4): fail recovery to MISSING_RECIPIENT_SLOT
 *   (default last guest, slot 2 or 3). MISSING_RECIPIENT_FAILURES=1|2 defaults
 *   to one failed header; two exercises sustained loss through the final retry.
 *   P2 loses input frames to trigger recovery. Require independent healthy
 *   recipient settlement, bounded target
 *   retry/settlement, no drop, and 60 later matching frames. No hash exclusions
 *   are added: the ordinary all-frame gameplay/game-state oracle still applies.
 *   A follow-up push the host owes the target (INPUT-ASK-PUSH-FOLLOWUP: a
 *   later broadcast skipped it while it still owed this one) adds one
 *   transfer to the bound, and must settle (`kind=follow-up`).
 * FOLLOW_UP_RECIPIENT=1 (PLAYERS=3|4): the host's follow-up to a recipient a
 *   later broadcast skipped (specs/recovery_delivery.qnt, recovery_skipped).
 *   P2 loses two input ranges 12 frames apart, so two holes are broadcast in
 *   quick succession; the last guest holds its recovery acknowledgements
 *   (`recovery-settled:`) until the second broadcast has gone out without it,
 *   then sends them. Fails unless the host pushes it a follow-up
 *   (INPUT-ASK-PUSH-FOLLOWUP), that settles (`kind=follow-up`), nobody is
 *   dropped, and every guest's hashes match the host's, at least 60 frames
 *   of them after recovery.
 * PHANTOM_SETTLE=1 (PLAYERS=3|4): a guest made a phantom by the host only
 *   (specs/phantom_settle.qnt). A third of the way in, P2's input is held
 *   neutral for 3 s, then its stick is held right (it walks: a held button
 *   acts on one frame only, if the fighter can act then) and every input packet P2 sends
 *   the host is dropped for PHANTOM_SETTLE_MS (default 7000, past the host's
 *   5 s phantom deadline) while the other guests still get them. When P2's
 *   inputs reach the host again it settles P2's inputs from before then as
 *   its predictions; the other guests rolled back to P2's real ones. Fails
 *   unless the host made P2 a phantom and recovered it, resynced every other
 *   guest too (`full sync also scheduled for slot(s)`), each of them applied
 *   a host state after, nobody was dropped, and every guest's hashes match the
 *   host's outside its window (from the drop to the first host state it
 *   applies after the recovery, where the host runs on its prediction of P2
 *   and the guests on P2's real input), at least 60 frames of them after
 *   recovery. With
 *   PHANTOM_SETTLE_LATE=1, P2's input packets to the other guests are held
 *   too, from the drop until each of them has applied its host state after
 *   the recovery, then sent in order: P2's real inputs from before the
 *   recovery reach them only after their resync. Also fails unless each of
 *   them skipped some as settled (`C-INPUT-SETTLED-SKIP`) and its engine
 *   rolled back to none of P2's inputs from before its state's settled point
 *   (`[C] MISPREDICTION slot=1 f=<n>` with n below `settledBefore`).
 * MISSING_RECIPIENT_PERMANENT=1 (PLAYERS=4): fail every transfer on the
 *   original target channel; require three attempts, notified removal, normal
 *   late rejoin and clean post-rejoin hashes. Full historical oracle stays strict.
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
 * CATCH_UP_HOLE=1: hold one input frame from CATCH_UP_HOLE_SLOT only on
 *   the catch-up guest's receive path (reliable and rollback-input channels,
 *   including redundancy/resend carriers). Isolated mode passes every other
 *   record unchanged in value. CATCH_UP_HOLE_DELIVERY=burst explicitly retains
 *   the original whole-packet burst experiment and its strict hash oracle.
 *   TRACE_CATCH_UP_INPUTS=1 records bounded native writer inputs per snapshot.
 *   Arm before asking for the state,
 *   then pin to the first input consumed after the captured snapshot. Other
 *   frames continue. CATCH_UP_HOLE_MODE=deep (default) pauses the source
 *   until an observed phantom lets its missing input pass beyond the normal
 *   prediction window; capture, pin, then resume source while the state is
 *   held. A matched wait proves the source is no longer phantom at replay.
 *   MODE=near retains the active-source near-window diagnostic, not valid
 *   deep-wait evidence (the normal prediction limit prevents a deep hole).
 *   Release only after an actual SYNC-CATCH-UP-WAIT names this held input.
 *   Require real held packets, wait-before-release, completed catch-up, and
 *   strict hashes for every player including at least 60 post-recovery frames.
 *   The deliberate phantom period never grants a hash exclusion; all
 *   transient and persistent divergence remains a failure.
 *
 * SCREEN_SIZE: the core's render size (default 320x240, the core's own
 *   default is 640x480). Four emulators on software GL are what stops pages
 *   for seconds in a cloud container; a quarter of the pixels is a quarter
 *   of that work. It changes what is drawn, not what is emulated.
 *
 * A frame the engine no longer holds hashes to 0 (kn_gameplay_hash and the
 * others read the frame from the ring buffer), as right after a resync takes
 * a page back; such frames are counted as `unrecorded`, not compared.
 * summary.json lists the differing frames and, per page, the stops of its
 * main thread of 4 s or more (`LOCAL-FREEZE`), which get a page dropped as a
 * phantom; OUT/p<n>-hashes.json has every page's hashes.
 *
 * The simulated network (LAT, JITTER, LINK_KBPS, the answer hold) is
 * tests/rb-page-network.mjs, the two-player run's.
 */
import { chromium } from 'playwright';
import fs from 'fs';
import { fileURLToPath } from 'node:url';
import { requireCurrentBundle } from './bundle-check.mjs';
import { addNetworkInitScript } from './rb-page-network.mjs';
import { catchUpHoleInput } from './directional-input-gate.mjs';
import { installNativeInputObserver } from './native-input-observer.mjs';

const URL = process.env.KN_URL || 'http://localhost:27888';
const ROM = process.env.KN_ROM;
const PLAYERS = Number(process.env.PLAYERS || 4);
const LAT = Number(process.env.LAT || 50);
const JITTER = Number(process.env.JITTER || 0);
const LINK_KBPS = Number(process.env.LINK_KBPS || 0);
const BATTLE_SECONDS = Number(process.env.BATTLE_SECONDS || 45);
const MENU_TIMEOUT_S = Number(process.env.MENU_TIMEOUT_S || 1800);
const MISSING_RECIPIENT = process.env.MISSING_RECIPIENT === '1';
const MISSING_RECIPIENT_SLOT = Number(process.env.MISSING_RECIPIENT_SLOT || PLAYERS - 1);
const PERMANENT_RECIPIENT = process.env.MISSING_RECIPIENT_PERMANENT === '1';
const MISSING_RECIPIENT_FAILURES = PERMANENT_RECIPIENT ? 3 : Number(process.env.MISSING_RECIPIENT_FAILURES || 1);
const FOLLOW_UP_RECIPIENT = process.env.FOLLOW_UP_RECIPIENT === '1';
const PHANTOM_SETTLE = process.env.PHANTOM_SETTLE === '1';
const PHANTOM_SETTLE_MS = Number(process.env.PHANTOM_SETTLE_MS || 7000);
const PHANTOM_SETTLE_LATE = process.env.PHANTOM_SETTLE_LATE === '1';
const FOLLOW_UP_SLOT = PLAYERS - 1;
const CATCH_UP_MS = Number(process.env.CATCH_UP_MS || 0);
const CATCH_UP_SLOT = Number(process.env.CATCH_UP_SLOT || 2);
const CATCH_UP_HOLE = process.env.CATCH_UP_HOLE === '1';
const TRACE_CATCH_UP_INPUTS = process.env.TRACE_CATCH_UP_INPUTS === '1';
const CATCH_UP_HOLE_DELIVERY = process.env.CATCH_UP_HOLE_DELIVERY || 'isolated';
const CATCH_UP_HOLE_MODE = process.env.CATCH_UP_HOLE_MODE || 'deep';
const DEEP_CATCH_UP_HOLE = CATCH_UP_HOLE && CATCH_UP_HOLE_MODE === 'deep';
const CATCH_UP_HOLE_SLOT = Number(process.env.CATCH_UP_HOLE_SLOT || 1);
const QUERY = process.env.KN_QUERY || '';
const OUT = process.env.OUT || '/tmp/rb-mesh';
const HEADLESS = process.env.HEADED !== '1';
const SCREEN_SIZE = process.env.SCREEN_SIZE || '320x240';
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
if (PERMANENT_RECIPIENT && !MISSING_RECIPIENT) fail('MISSING_RECIPIENT_PERMANENT requires MISSING_RECIPIENT=1');
if (!ROM || !fs.existsSync(ROM)) fail('KN_ROM must name the ROM file');
if (![3, 4].includes(PLAYERS)) fail(`PLAYERS=${process.env.PLAYERS} invalid: 3 or 4`);
if (!/^\d+x\d+$/.test(SCREEN_SIZE)) fail(`SCREEN_SIZE=${SCREEN_SIZE} invalid: WIDTHxHEIGHT, e.g. 320x240`);
for (const [name, v] of Object.entries({ LAT, JITTER, LINK_KBPS, BATTLE_SECONDS, MENU_TIMEOUT_S, CATCH_UP_MS })) {
  if (!(Number.isFinite(v) && v >= 0)) fail(`${name}=${process.env[name]} invalid: a finite number >= 0`);
}
if (
  MISSING_RECIPIENT &&
  (CATCH_UP_MS > 0 ||
    !Number.isInteger(MISSING_RECIPIENT_SLOT) ||
    MISSING_RECIPIENT_SLOT < 2 ||
    MISSING_RECIPIENT_SLOT >= PLAYERS ||
    !(PERMANENT_RECIPIENT ? PLAYERS === 4 : [1, 2].includes(MISSING_RECIPIENT_FAILURES)))
)
  fail('MISSING_RECIPIENT requires no catch-up fault, target slot 2..PLAYERS-1, and 1 or 2 failures');
if (PHANTOM_SETTLE && (MISSING_RECIPIENT || FOLLOW_UP_RECIPIENT || CATCH_UP_MS > 0))
  fail('PHANTOM_SETTLE is a run of its own (no other battle fault)');
if (FOLLOW_UP_RECIPIENT && (MISSING_RECIPIENT || CATCH_UP_MS > 0))
  fail('FOLLOW_UP_RECIPIENT is a run of its own (no MISSING_RECIPIENT or catch-up fault)');
if (CATCH_UP_MS > 0 && !(CATCH_UP_MS < RESYNC_REQUEST_TIMEOUT_MS)) {
  fail(`CATCH_UP_MS must be shorter than the guest's request deadline (${RESYNC_REQUEST_TIMEOUT_MS})`);
}
if (CATCH_UP_MS > 0 && !(Number.isInteger(CATCH_UP_SLOT) && CATCH_UP_SLOT >= 1 && CATCH_UP_SLOT < PLAYERS)) {
  fail(`CATCH_UP_SLOT=${process.env.CATCH_UP_SLOT} invalid: a guest's slot, 1 to ${PLAYERS - 1}`);
}
if (!['isolated', 'burst'].includes(CATCH_UP_HOLE_DELIVERY)) fail('CATCH_UP_HOLE_DELIVERY must be isolated or burst');
if (CATCH_UP_HOLE && !['deep', 'near'].includes(CATCH_UP_HOLE_MODE)) fail('CATCH_UP_HOLE_MODE must be deep or near');
if (CATCH_UP_HOLE && !(CATCH_UP_MS >= 3000)) fail('CATCH_UP_HOLE needs CATCH_UP_MS of 3000 or more');
if (
  CATCH_UP_HOLE &&
  !(
    Number.isInteger(CATCH_UP_HOLE_SLOT) &&
    CATCH_UP_HOLE_SLOT >= 1 &&
    CATCH_UP_HOLE_SLOT < PLAYERS &&
    CATCH_UP_HOLE_SLOT !== CATCH_UP_SLOT
  )
) {
  fail(`CATCH_UP_HOLE_SLOT=${process.env.CATCH_UP_HOLE_SLOT} invalid: a guest's slot other than CATCH_UP_SLOT`);
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
  await ctx.addInitScript(() => {
    window.__knEvents = [];
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
          if (meta?.kind === 'dropped-by-host' && !window.__meshDroppedSnapshot) {
            window.__meshDroppedSnapshot = window.__mesh ? JSON.parse(JSON.stringify(window.__mesh)) : null;
            window.__meshPreDropSync = window.NetplayRollback?.exportSyncLog?.() ?? '';
          }
          return real(type, msg, meta);
        }),
    });
  });
  await ctx.addInitScript((size) => {
    window.EJS_defaultOptions = Object.assign(window.EJS_defaultOptions || {}, { 'mupen64plus-43screensize': size });
  }, SCREEN_SIZE);
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
        // PHANTOM_SETTLE: the test sets this page's input itself for a while.
        if (window.__knInputOverride) return window.__knInputOverride(f);
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

// MISSING_RECIPIENT=1: P2's missing input triggers an actual overdue broadcast.
// Fail selected recipient transfers at their header, before any chunk is sent.
// Nothing is changed in the runtime, and P2's channel is never obstructed.
const missingRecipient = {
  enabled: MISSING_RECIPIENT,
  slot: MISSING_RECIPIENT_SLOT,
  failures: MISSING_RECIPIENT_FAILURES,
  hostAt: null,
  range: null,
  settled: false,
  recoveredFrame: null,
  permanent: PERMANENT_RECIPIENT
    ? { gaveUp: false, notified: null, lateJoinedAt: null, framesAtDrop: null, framesAfterJoin: null }
    : null,
};
// FOLLOW_UP_RECIPIENT=1: two holes from P2; the last guest's acks held across the second.
const followUpRecipient = {
  hostAt: null,
  ranges: null,
  firstSettled: false,
  secondBroadcast: false,
  released: 0,
  followUp: false,
  followUpSettled: false,
  recoveredFrame: null,
};
// PHANTOM_SETTLE=1: P2's inputs to the host only are dropped long enough to make it a phantom there.
const phantomSettle = {
  hostAt: null,
  guestsAt: null,
  dropped: 0,
  recovered: false,
  recoveredFrame: null,
  // PHANTOM_SETTLE_LATE: per other guest, whether it applied a state before
  // its held packets were sent, and how many were held.
  appliedBeforeRelease: {},
  // PHANTOM_SETTLE_LATE: each other guest's frame when P2's held packets
  // were sent to it.
  releasedFrame: {},
  // Where each page's sync log stood when the host recovered P2.
  guestsRecoveredAt: null,
  // The host's frame when P2's packets to it began to be dropped.
  faultFrame: null,
  held: {},
};
// The battle, with the catch-up fault a third of the way in.
const catchUp = { guestAt: null, seen: false };
const hole = {
  mode: CATCH_UP_HOLE_MODE,
  delivery: CATCH_UP_HOLE_DELIVERY,
  header: null,
  gate: null,
  evidence: null,
  recoveredFrame: null,
  pausedAt: null,
  phantomObserved: false,
  resumedAt: null,
  resumedSeq: null,
};
const tBattle = Date.now();
if (MISSING_RECIPIENT) {
  await host.waitForTimeout((BATTLE_SECONDS * 1000) / 3);
  missingRecipient.hostAt = await lastSeq(host);
  await host.evaluate(
    ({ slot, failures, permanent }) => {
      const peer = Object.values(window.KNState?.peers ?? {}).find((p) => p.slot === slot);
      if (peer?.syncDc?.readyState !== 'open') throw new Error('target sync channel is not open');
      const dc = peer.syncDc;
      const send = dc.send;
      window.__meshMissingRecipient = { failures: 0, headers: [], failedHeaders: [] };
      dc.send = function (data) {
        if (typeof data === 'string' && data.startsWith('sync-start:')) {
          const report = window.__meshMissingRecipient;
          report.headers.push({ frame: Number(data.split(':')[1]), at: performance.now() });
          if (permanent || report.failures < failures) {
            report.failures++;
            report.failedHeader ??= { ...report.headers.at(-1) };
            report.failedHeaders.push({ ...report.headers.at(-1) });
            throw new Error('TEST: selected recovery transfer failed');
          }
        }
        return send.call(this, data);
      };
    },
    { slot: MISSING_RECIPIENT_SLOT, failures: MISSING_RECIPIENT_FAILURES, permanent: PERMANENT_RECIPIENT },
  );
  missingRecipient.range = await pages[1].evaluate(() => {
    const frame = window.NetplayRollback.getHudCounters().currentFrame;
    const from = frame + 20,
      to = frame + 28;
    const peer = Object.values(window.KNState?.peers ?? {}).find((p) => p.slot === 0);
    if (peer?.dc?.readyState !== 'open') throw new Error('P2 host channel is not open');
    window.__meshMissingInputs = 0;
    for (const dc of new Set([peer.dc, peer.rbDc].filter(Boolean))) {
      const send = dc.send;
      dc.send = function (data) {
        if (data instanceof ArrayBuffer && data.byteLength >= 4) {
          const f = new Int32Array(data, 0, 1)[0];
          if (f >= from && f < to) {
            window.__meshMissingInputs++;
            return;
          }
        }
        return send.call(this, data);
      };
    }
    return [from, to];
  });
  const p2 = await waitForLine(host, missingRecipient.hostAt, /INPUT-ASK-PUSH-SETTLED .*slot=1 /, 60000);
  if (PERMANENT_RECIPIENT) {
    const targetPage = pages[MISSING_RECIPIENT_SLOT];
    const evidence = missingRecipient.permanent;
    evidence.gaveUp = await waitForLine(
      host,
      missingRecipient.hostAt,
      new RegExp(`INPUT-ASK-PUSH-GAVEUP .*slot=${MISSING_RECIPIENT_SLOT} pushes=3`),
      45000,
    );
    evidence.framesAtDrop = await Promise.all(
      pages.map((p) => p.evaluate(() => window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? -1)),
    );
    const toldUntil = Date.now() + 15000;
    while (Date.now() < toldUntil && !evidence.notified) {
      evidence.notified = await targetPage.evaluate(
        () => (window.__knEvents ?? []).find((e) => e.meta?.kind === 'dropped-by-host') ?? null,
      );
      if (!evidence.notified) await targetPage.waitForTimeout(200);
    }
    // Match the existing two-player drop/rejoin lifecycle. No direct
    // production mutation or synthetic join: only the normal gesture prompt.
    const joinedUntil = Date.now() + 90000;
    while (Date.now() < joinedUntil && evidence.lateJoinedAt === null) {
      if (await targetPage.locator('#gesture-prompt:not(.hidden)').count())
        await targetPage
          .locator('#gesture-prompt')
          .click({ force: true })
          .catch(() => {});
      const log = await syncLogOf(targetPage);
      const m = log.match(/late-join loaded at frame (\d+)/);
      if (m) evidence.lateJoinedAt = Number(m[1]);
      else await targetPage.waitForTimeout(500);
    }
    const before = await targetPage.evaluate(() => ({
      sync: window.__meshPreDropSync ?? '',
      hashes: window.__meshDroppedSnapshot?.hashes ?? {},
    }));
    fs.writeFileSync(`${OUT}/target-pre-drop-sync.txt`, before.sync);
    fs.writeFileSync(`${OUT}/target-pre-drop-hashes.json`, JSON.stringify(before.hashes));
    if (evidence.lateJoinedAt !== null) await install(targetPage, MISSING_RECIPIENT_SLOT);
    evidence.framesAfterJoin = await Promise.all(
      pages.map((p) => p.evaluate(() => window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? -1)),
    );
    missingRecipient.settled = p2 && evidence.gaveUp && !!evidence.notified && evidence.lateJoinedAt !== null;
  } else {
    const target = await waitForLine(
      host,
      missingRecipient.hostAt,
      new RegExp(`INPUT-ASK-PUSH-SETTLED .*slot=${MISSING_RECIPIENT_SLOT} `),
      30000,
    );
    missingRecipient.settled = p2 && target;
  }
  missingRecipient.recoveredFrame = await host.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
  // Keep observing after settlement: transient success followed by another
  // retry/drop is not recovery. At least 60 later hash frames are required.
  await host.waitForTimeout(20000);
}
if (PHANTOM_SETTLE) {
  await host.waitForTimeout((BATTLE_SECONDS * 1000) / 3);
  const ps = phantomSettle;
  const NEUTRAL = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
  // Fixed, so every page predicts it: neutral.
  await pages[1].evaluate((n) => {
    window.__knInputOverride = () => n;
  }, NEUTRAL);
  await host.waitForTimeout(3000);
  ps.hostAt = await lastSeq(host);
  ps.guestsAt = await Promise.all(pages.map((p) => lastSeq(p)));
  // Stick held right; what P2 sends the host is dropped, what it sends the
  // other guests goes through.
  await pages[1].evaluate(
    ({ n, late }) => {
      const peers = Object.values(window.KNState?.peers ?? {});
      const peer = peers.find((p) => p.slot === 0);
      if (peer?.dc?.readyState !== 'open') throw new Error('P2 host channel is not open');
      window.__meshDropToHost = true;
      window.__meshDroppedToHost = 0;
      for (const dc of new Set([peer.dc, peer.rbDc].filter(Boolean))) {
        const send = dc.send;
        dc.send = function (data) {
          if (window.__meshDropToHost && data instanceof ArrayBuffer) {
            window.__meshDroppedToHost++;
            return;
          }
          return send.call(this, data);
        };
      }
      // PHANTOM_SETTLE_LATE: P2's input packets to each other guest wait,
      // in order, until the harness releases that guest.
      window.__meshHeld = {};
      window.__meshRelease = (slot) => {
        const q = window.__meshHeld[slot];
        if (!q) return 0;
        q.released = true;
        for (const [dc, send, data] of q.items) if (dc.readyState === 'open') send.call(dc, data);
        return q.items.length;
      };
      if (late) {
        for (const other of peers.filter((p) => p.slot >= 2)) {
          const q = (window.__meshHeld[other.slot] = { released: false, items: [] });
          for (const dc of new Set([other.dc, other.rbDc].filter(Boolean))) {
            const send = dc.send;
            dc.send = function (data) {
              if (!q.released && data instanceof ArrayBuffer) {
                q.items.push([this, send, data]);
                return;
              }
              return send.call(this, data);
            };
          }
        }
      }
      window.__knInputOverride = () => ({ ...n, lx: 70 });
    },
    { n: NEUTRAL, late: PHANTOM_SETTLE_LATE },
  );
  ps.faultFrame = await host.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
  await host.waitForTimeout(PHANTOM_SETTLE_MS);
  ps.dropped = await pages[1].evaluate((n) => {
    window.__meshDropToHost = false;
    window.__knInputOverride = () => n;
    return window.__meshDroppedToHost;
  }, NEUTRAL);
  ps.recovered = await waitForLine(host, ps.hostAt, /PEER-RECOVERED slot=1 /, 20000);
  ps.recoveredFrame = await host.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
  ps.guestsRecoveredAt = await Promise.all(pages.map((p) => lastSeq(p)));
  console.log(
    `PHANTOM_SETTLE: ${ps.dropped} input packet(s) to the host dropped; recovered ${ps.recovered} at f=${ps.recoveredFrame}`,
  );
  await pages[1].evaluate(() => {
    window.__knInputOverride = null;
  });
  if (PHANTOM_SETTLE_LATE) {
    // Each other guest gets P2's held inputs only once it holds the host's
    // state from after the recovery (or after 30 s, which the checks fail).
    await Promise.all(
      Array.from({ length: PLAYERS - 2 }, (_, i) => i + 2).map(async (slot) => {
        ps.appliedBeforeRelease[slot] = await waitForLine(
          pages[slot],
          ps.guestsRecoveredAt[slot],
          /sync #\d+ applied/,
          30000,
        );
        ps.held[slot] = await pages[1].evaluate((s) => window.__meshRelease(s), slot);
        ps.releasedFrame[slot] = await pages[slot].evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
        console.log(
          `PHANTOM_SETTLE_LATE: P${slot + 1} applied a state first: ${ps.appliedBeforeRelease[slot]}; ` +
            `${ps.held[slot]} held packet(s) from P2 sent`,
        );
      }),
    );
  }
  await host.waitForTimeout(20000);
}
if (FOLLOW_UP_RECIPIENT) {
  await host.waitForTimeout((BATTLE_SECONDS * 1000) / 3);
  const f = followUpRecipient;
  f.hostAt = await lastSeq(host);
  // The last guest holds every recovery acknowledgement it sends the host.
  await pages[FOLLOW_UP_SLOT].evaluate(() => {
    const peer = Object.values(window.KNState?.peers ?? {}).find((p) => p.slot === 0);
    if (peer?.dc?.readyState !== 'open') throw new Error('target host channel is not open');
    window.__meshHeldAcks = [];
    window.__meshHoldAcks = true;
    for (const dc of new Set([peer.dc, peer.syncDc].filter(Boolean))) {
      const send = dc.send;
      dc.send = function (data) {
        if (window.__meshHoldAcks && typeof data === 'string' && data.startsWith('recovery-settled:')) {
          window.__meshHeldAcks.push(() => send.call(this, data));
          return;
        }
        return send.call(this, data);
      };
    }
    window.__meshReleaseAcks = () => {
      window.__meshHoldAcks = false;
      const held = window.__meshHeldAcks.splice(0);
      for (const sendHeld of held) sendHeld();
      return held.length;
    };
  });
  // P2 loses two ranges, 12 frames apart: two holes in quick succession.
  f.ranges = await pages[1].evaluate(() => {
    const frame = window.NetplayRollback.getHudCounters().currentFrame;
    const ranges = [
      [frame + 20, frame + 26],
      [frame + 38, frame + 44],
    ];
    const peer = Object.values(window.KNState?.peers ?? {}).find((p) => p.slot === 0);
    if (peer?.dc?.readyState !== 'open') throw new Error('P2 host channel is not open');
    window.__meshMissingInputs = 0;
    for (const dc of new Set([peer.dc, peer.rbDc].filter(Boolean))) {
      const send = dc.send;
      dc.send = function (data) {
        if (data instanceof ArrayBuffer && data.byteLength >= 4) {
          const fr = new Int32Array(data, 0, 1)[0];
          if (ranges.some(([a, b]) => fr >= a && fr < b)) {
            window.__meshMissingInputs++;
            return;
          }
        }
        return send.call(this, data);
      };
    }
    return ranges;
  });
  const inRange = (r) => `(${Array.from({ length: r[1] - r[0] }, (_, i) => r[0] + i).join('|')})`;
  f.firstSettled = await waitForLine(host, f.hostAt, /INPUT-ASK-PUSH-SETTLED .*slot=1 /, 60000);
  f.secondBroadcast = await waitForLine(
    host,
    f.hostAt,
    new RegExp(`INPUT-ASK-PUSH f=\\d+ slot=1 hole=${inRange(f.ranges[1])}\\b`),
    30000,
  );
  f.released = await pages[FOLLOW_UP_SLOT].evaluate(() => window.__meshReleaseAcks());
  console.log(
    `FOLLOW_UP_RECIPIENT: first settled ${f.firstSettled}, second broadcast ${f.secondBroadcast}, ` +
      `${f.released} held acknowledgement(s) released`,
  );
  f.followUp = await waitForLine(
    host,
    f.hostAt,
    new RegExp(`INPUT-ASK-PUSH-FOLLOWUP .*slot=${FOLLOW_UP_SLOT} `),
    15000,
  );
  f.followUpSettled = await waitForLine(
    host,
    f.hostAt,
    new RegExp(`INPUT-ASK-PUSH-SETTLED .*slot=${FOLLOW_UP_SLOT} .*kind=follow-up`),
    30000,
  );
  f.recoveredFrame = await host.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
  await host.waitForTimeout(20000);
}
if (CATCH_UP_MS > 0) {
  await host.waitForTimeout((BATTLE_SECONDS * 1000) / 3);
  const guest = pages[CATCH_UP_SLOT];
  if (TRACE_CATCH_UP_INPUTS) {
    await Promise.all(
      pages.map((page) =>
        page.evaluate(
          `window.__knNativeInputObserver = (${installNativeInputObserver})(window.EJS_emulator.gameManager.Module, () => window.NetplayRollback.getHudCounters(), ${PLAYERS}, 2048, () => ({debug:window.NetplayRollback.getDebugState(), controlLog:(window.NetplayRollback.exportSyncLog()||'').split('\\n').filter(line=>/PHANTOM|RECOVERED|INPUTS-SETTLED|RESYNC-INPUTS|sync frame reset|SYNC-CATCH-UP/.test(line)).slice(-80)}))`,
        ),
      ),
    );
  }
  if (DEEP_CATCH_UP_HOLE) {
    const beforePause = await lastSeq(guest);
    hole.pausedAt = await pages[CATCH_UP_HOLE_SLOT].evaluate(() => {
      window.NetplayRollback.pauseTick();
      return window.NetplayRollback.getHudCounters().currentFrame;
    });
    hole.phantomObserved = await waitForLine(
      guest,
      beforePause,
      new RegExp(`PEER-PHANTOM slot=${CATCH_UP_HOLE_SLOT} `),
      30000,
    );
    // This deliberate phantom period is what permits an input to become
    // deeper than the normal seven-frame prediction limit. Nothing in the
    // runtime/input history is changed and its divergent hashes stay counted.
    if (hole.phantomObserved) await host.waitForTimeout(500);
  }
  if (CATCH_UP_HOLE) {
    await guest.evaluate(({ slot, mode }) => window.__knDirectionalInputGate.arm(slot, mode), {
      slot: CATCH_UP_HOLE_SLOT,
      mode: CATCH_UP_HOLE_DELIVERY,
    });
    await host.evaluate((slot) => {
      window.__knWatchSyncTargetSlot = slot;
      window.__knWatchedSyncHeaders = [];
    }, CATCH_UP_SLOT);
  }
  catchUp.guestAt = await lastSeq(guest);
  await host.evaluate((ms) => {
    window.__knHoldSyncAnswerMs = ms;
  }, CATCH_UP_MS);
  await guest.evaluate(() => window.dispatchEvent(new Event('online')));
  console.log(`CATCH_UP_MS: P${CATCH_UP_SLOT + 1} asked for a resync; the host's answer is held ${CATCH_UP_MS} ms`);
  if (CATCH_UP_HOLE) {
    try {
      await host.waitForFunction(() => window.__knWatchedSyncHeaders?.length > 0, null, { timeout: 10000 });
      hole.header = await host.evaluate(() => window.__knWatchedSyncHeaders[0]);
      hole.delay = await guest.evaluate(() => window.NetplayRollback.getHudCounters().delay);
      hole.heldInput = catchUpHoleInput(hole.header.frame, hole.delay, DEEP_CATCH_UP_HOLE);
      await guest.evaluate(
        ({ frame, slot, afterSeq }) => {
          window.__knDirectionalInputGate.pin(frame, frame + 1);
          window.__knHoleWaitEvidence = null;
          const timer = setInterval(() => {
            const lines = (window.NetplayRollback.exportSyncLog() || '').split('\n');
            for (const line of lines) {
              if (Number(line.split('\t')[0]) <= afterSeq) continue;
              const m = line.match(/SYNC-CATCH-UP-WAIT f=(\d+) slot=(\d+) input=(\d+)/);
              if (!m || Number(m[2]) !== slot || Number(m[3]) !== frame) continue;
              const before = window.__knDirectionalInputGate.stats();
              if (before.queued <= 0) continue;
              window.__knHoleWaitEvidence = { line, input: Number(m[3]), waitObservedAt: performance.now(), before };
              window.__knDirectionalInputGate.release(Number(m[3]));
              clearInterval(timer);
              return;
            }
          }, 10);
        },
        { frame: hole.heldInput, slot: CATCH_UP_HOLE_SLOT, afterSeq: catchUp.guestAt },
      );
    } catch (error) {
      hole.invalidInjection = String(error);
    }
    if (DEEP_CATCH_UP_HOLE) {
      hole.resumedSeq = await lastSeq(guest);
      hole.resumedAt = await pages[CATCH_UP_HOLE_SLOT].evaluate(() => {
        window.NetplayRollback.resumeTick();
        return window.NetplayRollback.getHudCounters().currentFrame;
      });
    }
  }
  catchUp.seen = await waitForLine(guest, catchUp.guestAt, /SYNC-CATCH-UP from=/, CATCH_UP_MS + CATCH_UP_RECOVER_MS);
  console.log(catchUp.seen ? 'CATCH_UP_MS: the guest caught up' : 'CATCH_UP_MS: the guest never logged SYNC-CATCH-UP');
  if (CATCH_UP_HOLE) {
    hole.gate = await guest.evaluate(() => window.__knDirectionalInputGate.stats());
    hole.evidence = await guest.evaluate(() => window.__knHoleWaitEvidence ?? null);
    hole.recoveredFrame = await guest.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
    await host.waitForTimeout(20000);
  }
}
await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - (Date.now() - tBattle)));

// Collect, then compare every guest with the host.
const P = await Promise.all(
  pages.map(async (p) => ({
    sync: await syncLogOf(p),
    ...(await p.evaluate(() => ({
      nativeInputs: window.__knNativeInputObserver?.export() ?? null,
      missingRecipientWire: window.__meshMissingRecipient ?? null,
      missingInputs: window.__meshMissingInputs ?? 0,
      hashes: { ...(window.__meshDroppedSnapshot?.hashes ?? {}), ...window.__mesh.hashes },
      dropNotifications: (window.__knEvents ?? []).filter((e) => e.meta?.kind === 'dropped-by-host').length,
      preDropHashes: window.__meshDroppedSnapshot?.hashes ?? {},
      preDropHashCount: Object.keys(window.__meshDroppedSnapshot?.hashes ?? {}).length,
      inBattleAt: window.__meshDroppedSnapshot?.inBattleAt ?? window.__mesh.inBattleAt,
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
P.forEach((x, i) => {
  fs.writeFileSync(`${OUT}/p${i + 1}-sync.txt`, x.sync);
  fs.writeFileSync(`${OUT}/p${i + 1}-hashes.json`, JSON.stringify(x.hashes));
  if (x.nativeInputs) fs.writeFileSync(`${OUT}/p${i + 1}-applied-inputs.json`, JSON.stringify(x.nativeInputs));
});
let hostEnd;
if (process.env.HOST_END_CHECK === '1') {
  const { checkHostEnd } = await import('./rb-end-game.mjs');
  hostEnd = await checkHostEnd(pages, OUT);
}
await browser.close();

const catchUpsOf = (log, afterSeq = -1) =>
  log
    .split('\n')
    .filter((line) => seqOf(line) > afterSeq)
    .flatMap((line) => {
      const m = line.match(
        /SYNC-CATCH-UP from=(\d+) to=(\d+) of=(\d+) frames=(\d+) ms=([\d.]+) workMs=([\d.]+) slices=(\d+)(?: waits=(\d+))?(?: stopped: (.*))?/,
      );
      if (!m) return [];
      const [from, to, of, frames, ms, workMs, slices] = m.slice(1, 8).map(Number);
      return [{ from, to, of, frames, ms, workMs, slices, waits: Number(m[8] ?? 0), stopped: m[9] ?? null }];
    });

// Frames as runs: [[from, to], ...], to keep summary.json short.
const spans = (frames) =>
  frames
    .toSorted((a, b) => a - b)
    .reduce((out, f) => {
      const last = out.at(-1);
      if (last && f === last[1] + 1) last[1] = f;
      else out.push([f, f]);
      return out;
    }, []);

const H = P[0];
// PHANTOM_SETTLE: while a guest is a phantom on the host, the host runs on
// its prediction of that guest and the other pages on its real input; at its
// recovery the host settles its prediction and sends every guest its state
// (web/src/recovery-resync.ts), so the frames between differ by design.
// Every phantom episode on the host counts: P2's, made by the fault (from the
// drop), and any other the container makes (four emulators stall; from its
// PEER-PHANTOM frame less what the host can have run on prediction before
// it stalled: its rollback window and delay, from its `C-ROLLBACK init`, and
// PHANTOM_LEAD_MARGIN; the host is frozen in its stall from the stall's
// start to the phantom). A guest's window ends at the first
// host state it applies at or after the recovery frame. Mismatches inside are
// counted (recoveryMismatches.during) and not failed; any outside fail. A
// guest given no state after a recovery (main) has its window end at the
// recovery, so the split it keeps fails.
const PHANTOM_LEAD_MARGIN = 4;
const phantomLead = (() => {
  const init = /C-ROLLBACK init: max=(\d+) delay=(\d+)/.exec(H.sync);
  // No init line (no C engine): the most the engine allows, 22 + 9.
  return (init ? Number(init[1]) + Number(init[2]) : 31) + PHANTOM_LEAD_MARGIN;
})();
// P2 runs ahead of the host: its first walking input can be labelled before
// the frame the host had reached when the drop was set up.
const faultStart = (() => {
  if (!PHANTOM_SETTLE || phantomSettle.faultFrame === null) return null;
  const walk = P[1].sync
    .split('\n')
    .filter((l) => seqOf(l) > phantomSettle.guestsAt[1])
    .map((l) => /LOCAL-INPUT slot=1 f=(\d+) b=0 lx=70 ly=0 /.exec(l))
    .find(Boolean);
  return walk ? Math.min(phantomSettle.faultFrame, Number(walk[1])) : phantomSettle.faultFrame;
})();
const phantomEpisodes = (() => {
  if (!PHANTOM_SETTLE) return [];
  const open = new Map();
  const out = [];
  let faultEpisodeTaken = false;
  for (const line of H.sync.split('\n')) {
    const f = Number(/\tf=(\d+)\t/.exec(line)?.[1]);
    const phantom = /\tPEER-PHANTOM slot=(\d+) /.exec(line);
    const recovered = /\tPEER-RECOVERED slot=(\d+) /.exec(line);
    if (phantom && !open.has(phantom[1])) open.set(phantom[1], f);
    if (recovered && open.has(recovered[1])) {
      const slot = Number(recovered[1]);
      // P2's first episode after the drop is the fault's: it starts there.
      const isFault =
        slot === 1 &&
        !faultEpisodeTaken &&
        phantomSettle.faultFrame !== null &&
        open.get(recovered[1]) >= phantomSettle.faultFrame;
      if (isFault) faultEpisodeTaken = true;
      const from = isFault ? faultStart : open.get(recovered[1]) - phantomLead;
      out.push({ slot, from, recovered: f, byFault: isFault });
      open.delete(recovered[1]);
    }
  }
  return out;
})();
// PHANTOM_SETTLE_LATE: P2's packets to the other guests are held from the
// drop, so each makes P2 a phantom of its own and runs on its predictions;
// the held inputs above its settled point arrive too late to roll back to,
// and it asks for a state (INPUT-PAST-WINDOW-MISMATCH). Its window runs on to
// the first state it applies after the release, or the release plus the
// lead when none comes: a split it keeps still fails.
const phantomWindowsOf = (slot) => {
  const applied = [...P[slot].sync.matchAll(/sync #\d+ applied \(frame \d+ -> (\d+)/g)].map((m) => Number(m[1]));
  const released = PHANTOM_SETTLE_LATE ? phantomSettle.releasedFrame[slot] : undefined;
  return phantomEpisodes.map((e) => {
    let to = applied.find((F) => F >= e.recovered) ?? e.recovered;
    if (e.byFault && released !== undefined)
      to = Math.max(to, applied.find((F) => F >= released) ?? released + phantomLead);
    return [e.from, to];
  });
};
// Whether the fault was exercised: the host ran some frame of the fault's
// window on a value of P2's input other than the one P2 played
// (NORMAL-INPUT-TR, the inputs each page applied). Read from the inputs, not
// the hashes: the hashes cover no fighter's position, so a walk shows in them
// only once it reaches something they do.
const appliedInputs = (sync, tag) => {
  const out = new Map();
  const re = new RegExp(`NORMAL-INPUT-TR f=\\d+ apply=(-?\\d+) [^\\n]*?${tag}@-?\\d+\\[([^\\]]*)\\]`, 'g');
  for (const m of sync.matchAll(re)) out.set(Number(m[1]), m[2]);
  return out;
};
const faultInputsDiffered = (() => {
  const e = phantomEpisodes.find((x) => x.byFault);
  if (!e) return 0;
  const host = appliedInputs(H.sync, 'R1');
  const own = appliedInputs(P[1].sync, 'L1');
  let n = 0;
  for (const [f, v] of host) if (f >= e.from && f <= e.recovered && own.has(f) && own.get(f) !== v) n++;
  return n;
})();
const pairs = P.slice(1).map((G, gi) => {
  const slot = gi + 1;
  const battleFrom = Math.max(H.inBattleAt, G.inBattleAt);
  let compared = 0;
  let battle = 0;
  let postRecovery = 0;
  let preFaultBattle = 0;
  const recoveryMismatches = { before: 0, during: 0, after: 0 };
  let unrecorded = 0;
  let leftOut = 0;
  const mismatches = { gameplay: [], gameState: [], fullState: 0 };
  const phantomWindows = PHANTOM_SETTLE ? phantomWindowsOf(slot) : [];
  for (const k of Object.keys(G.hashes)) {
    const f = +k;
    const h = H.hashes[k];
    if (!h) continue;
    const g = G.hashes[k];
    // 0: that page's engine no longer held the frame when it was recorded.
    if (h[0] === 0 || g[0] === 0) {
      unrecorded++;
      continue;
    }
    compared++;
    if (
      (MISSING_RECIPIENT && f > missingRecipient.recoveredFrame) ||
      (FOLLOW_UP_RECIPIENT && followUpRecipient.recoveredFrame !== null && f > followUpRecipient.recoveredFrame) ||
      (PHANTOM_SETTLE && phantomSettle.recoveredFrame !== null && f > phantomSettle.recoveredFrame) ||
      (CATCH_UP_HOLE && hole.recoveredFrame !== null && f > hole.recoveredFrame)
    )
      postRecovery++;
    if (f >= battleFrom) battle++;
    if (MISSING_RECIPIENT) {
      if (f >= battleFrom && f < missingRecipient.range[0]) preFaultBattle++;
      const differs = h[0] !== g[0] || (h[1] !== 0 && g[1] !== 0 && h[1] !== g[1]);
      if (differs) {
        const phase =
          f < missingRecipient.range[0] ? 'before' : f > missingRecipient.recoveredFrame ? 'after' : 'during';
        recoveryMismatches[phase]++;
      }
    }
    if (phantomWindows.length) {
      const differs = h[0] !== g[0] || (h[1] !== 0 && g[1] !== 0 && h[1] !== g[1]);
      const inside = phantomWindows.some(([from, to]) => f >= from && f <= to);
      const phase = inside ? 'during' : f < Math.min(...phantomWindows.map(([from]) => from)) ? 'before' : 'after';
      if (differs) recoveryMismatches[phase]++;
      if (inside) continue;
    }
    if (h[0] !== g[0]) mismatches.gameplay.push(f);
    if (h[1] !== 0 && g[1] !== 0 && h[1] !== g[1]) mismatches.gameState.push(f);
    if (h[2] !== 0 && g[2] !== 0 && h[2] !== g[2]) mismatches.fullState++;
  }
  const preDropMismatches = { gameplay: [], gameState: [] };
  for (const [key, old] of Object.entries(G.preDropHashes)) {
    const h = H.hashes[key];
    if (!h || !h[0] || !old[0]) continue;
    if (h[0] !== old[0]) preDropMismatches.gameplay.push(Number(key));
    if (h[1] && old[1] && h[1] !== old[1]) preDropMismatches.gameState.push(Number(key));
  }
  return {
    slot,
    preDropMismatches,
    compared,
    unrecorded,
    leftOut,
    battleFramesCompared: battle,
    postRecoveryFramesCompared: postRecovery,
    preFaultBattleFramesCompared: preFaultBattle,
    recoveryMismatches,
    gameplayMismatches: mismatches.gameplay.length,
    gameplayMismatchFrames: spans(mismatches.gameplay),
    battleGameplayMismatches: mismatches.gameplay.filter((f) => f >= battleFrom).length,
    gameStateMismatches: mismatches.gameState.length,
    gameStateMismatchFrames: spans(mismatches.gameState),
    fullStateMismatches: mismatches.fullState,
    catchUps: catchUpsOf(G.sync),
    phantomWindows,
  };
});

// Each page's main-thread stops long enough to get it dropped as a phantom,
// and the phantoms it declared: what a cloud container does to four emulators.
const PHANTOM_STOP_MS = 4000;
const stops = P.map((x) =>
  [...x.sync.matchAll(/\tf=(\d+)\tLOCAL-FREEZE f=\d+ gap=(\d+)ms/g)].flatMap((m) =>
    +m[2] >= PHANTOM_STOP_MS ? [{ f: +m[1], ms: +m[2] }] : [],
  ),
);
const phantoms = P.map((x) =>
  [...x.sync.matchAll(/\tf=(\d+)\tPEER-PHANTOM slot=(\d+)/g)].map((m) => ({ f: +m[1], slot: +m[2] })),
);

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
const holeReport = CATCH_UP_HOLE
  ? {
      slot: CATCH_UP_HOLE_SLOT,
      phantomAfterResume: P[CATCH_UP_SLOT].sync
        .split('\n')
        .some(
          (line) =>
            seqOf(line) > (hole.resumedSeq ?? catchUp.guestAt) &&
            line.includes(`PEER-PHANTOM slot=${CATCH_UP_HOLE_SLOT} `),
        ),
      ...hole,
      waited:
        !!hole.evidence?.line &&
        hole.gate?.held > 0 &&
        hole.evidence.waitObservedAt <= hole.gate.releasedAt &&
        hole.gate.laterInputs > 0,
      completed: catchUpReport.catchUps.some((c) => c.frames > 0 && c.to === c.of && !c.stopped),
      spin: catchUpReport.catchUps.filter((c) => c.slices > c.frames + c.ms / 12 + 5),
    }
  : null;
const catchUpFailed =
  CATCH_UP_MS > 0 &&
  (CATCH_UP_HOLE
    ? !catchUp.seen ||
      !holeReport.waited ||
      (DEEP_CATCH_UP_HOLE && !holeReport.phantomObserved) ||
      holeReport.phantomAfterResume ||
      !holeReport.completed ||
      holeReport.spin.length > 0 ||
      pairs.some((p) => p.postRecoveryFramesCompared < MIN_BATTLE_FRAMES)
    : !catchUpReport.catchUps.some((c) => c.frames > 0 && c.to === c.of && !c.stopped));

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

const missingLines = MISSING_RECIPIENT
  ? H.sync.split('\n').filter((line) => seqOf(line) > missingRecipient.hostAt)
  : [];
const missingRetries = missingLines.filter((line) =>
  new RegExp(`INPUT-ASK-PUSH-AGAIN .*slot=${MISSING_RECIPIENT_SLOT} `).test(line),
);
const p2SettledIndex = missingLines.findIndex((line) => /INPUT-ASK-PUSH-SETTLED .*slot=1 /.test(line));
const targetSettledIndex = missingLines.findIndex(
  (line) =>
    new RegExp(`INPUT-ASK-PUSH-SETTLED .*slot=${MISSING_RECIPIENT_SLOT} `).test(line) && !/kind=follow-up/.test(line),
);
const targetRetryIndex = missingLines.findIndex((line) =>
  new RegExp(`INPUT-ASK-PUSH-AGAIN .*slot=${MISSING_RECIPIENT_SLOT} `).test(line),
);
const selectedPushes = missingLines.flatMap((line, index) => {
  const m = line.match(/INPUT-ASK-PUSH f=(\d+) slot=1 hole=(\d+)/);
  if (!m || !missingRecipient.range) return [];
  const frame = Number(m[1]),
    hole = Number(m[2]);
  return hole >= missingRecipient.range[0] && hole < missingRecipient.range[1] ? [{ frame, hole, index }] : [];
});
const correlatedPush = selectedPushes.find((push) => push.frame === H.missingRecipientWire?.failedHeader?.frame);
const healthyRecipients = Array.from({ length: PLAYERS - 1 }, (_, i) => i + 1).filter(
  (slot) => slot !== MISSING_RECIPIENT_SLOT,
);
const healthyProblems = healthyRecipients.flatMap((slot) => {
  const settled = missingLines.findIndex((line) => {
    const m = line.match(new RegExp(`INPUT-ASK-PUSH-SETTLED .*slot=${slot} frame=(\\d+) `));
    return m && Number(m[1]) === correlatedPush?.frame;
  });
  const retried = missingLines.some((line) => new RegExp(`INPUT-ASK-PUSH-AGAIN .*slot=${slot} `).test(line));
  return !correlatedPush || settled <= correlatedPush.index || settled >= targetRetryIndex || retried
    ? [`healthy P${slot + 1} failed correlated independent settlement before target retry`]
    : [];
});
const targetRetryEvents = missingLines.flatMap((line, index) => {
  const m = line.match(new RegExp(`INPUT-ASK-PUSH-AGAIN f=(\\d+) slot=${MISSING_RECIPIENT_SLOT} push=(\\d+)/`));
  return m ? [{ frame: Number(m[1]), attempt: Number(m[2]), index }] : [];
});
// A follow-up the host owes the target (a later broadcast skipped it) is one
// more transfer, settled under its own tag.
const targetFollowUps = missingLines.filter((line) =>
  new RegExp(`INPUT-ASK-PUSH-FOLLOWUP .*slot=${MISSING_RECIPIENT_SLOT} `).test(line),
);
const targetFollowUpSettled = missingLines.some((line) =>
  new RegExp(`INPUT-ASK-PUSH-SETTLED .*slot=${MISSING_RECIPIENT_SLOT} .*kind=follow-up`).test(line),
);
const correlatedTargetSettled = missingLines.findIndex((line) => {
  if (/kind=follow-up/.test(line)) return false;
  const m = line.match(
    new RegExp(`INPUT-ASK-PUSH-SETTLED .*slot=${MISSING_RECIPIENT_SLOT} frame=(\\d+) pushes=(\\d+)`),
  );
  return m && Number(m[1]) === correlatedPush?.frame && Number(m[2]) === MISSING_RECIPIENT_FAILURES + 1;
});
const failedHeaders = H.missingRecipientWire?.failedHeaders ?? [];
const retryFailuresCorrelated =
  failedHeaders.length === MISSING_RECIPIENT_FAILURES &&
  failedHeaders
    .slice(1)
    .every((header, i) => header.frame === targetRetryEvents[i]?.frame && targetRetryEvents[i]?.attempt === i + 2);
const transientMissingProblems = !MISSING_RECIPIENT
  ? []
  : [
      ...healthyProblems,
      ...(!retryFailuresCorrelated ? ['failed target retry headers do not match the same recovery attempts'] : []),
      ...(correlatedTargetSettled <= (targetRetryEvents.at(-1)?.index ?? Infinity)
        ? ['target did not settle the selected recovery after its last retry']
        : []),
      ...(!(P[1].missingInputs > 0) ? ['P2 input fault did not fire'] : []),
      ...(!missingLines.some((line) => /INPUT-ASK-PUSH .*slot=1 /.test(line))
        ? ['P2 overdue broadcast was not observed']
        : []),
      ...(!correlatedPush ? ['failed target header is not the broadcast for the selected P2 hole'] : []),
      ...(correlatedPush && correlatedPush.index >= p2SettledIndex
        ? ['P2 settlement preceded the selected broadcast']
        : []),
      ...(p2SettledIndex < 0 || targetRetryIndex <= p2SettledIndex
        ? ['healthy P2 did not settle before the first target retry']
        : []),
      ...(!missingRecipient.settled ? ['both recipients did not settle'] : []),
      ...(H.missingRecipientWire?.failures !== MISSING_RECIPIENT_FAILURES
        ? ['selective fault count differs from requested']
        : []),
      ...(!(
        H.missingRecipientWire?.headers.length >= MISSING_RECIPIENT_FAILURES + 1 &&
        H.missingRecipientWire.headers.length <= 3 + Math.min(targetFollowUps.length, 1)
      )
        ? ['target transfer attempts were absent or unbounded']
        : []),
      ...(targetFollowUps.length > 1 ? ['more than one follow-up pushed to the target'] : []),
      ...(targetFollowUps.length === 1 && !targetFollowUpSettled ? ["the target's follow-up did not settle"] : []),
      ...(!(missingRetries.length >= MISSING_RECIPIENT_FAILURES && missingRetries.length <= 2)
        ? ['target retry count outside 1..2']
        : []),
      ...(p2SettledIndex < 0 || targetSettledIndex <= p2SettledIndex
        ? ['healthy P2 did not settle before target']
        : []),
      ...(missingLines.some((line) =>
        /INPUT-ASK-PUSH-AGAIN .*slot=1 |INPUT-ASK-PUSH-GAVEUP|INPUT-ASK-PUSH-ENDED|PEER-PHANTOM|hardDisconnect/.test(
          line,
        ),
      )
        ? ['healthy recipient retried or a peer was dropped/ended']
        : []),
      ...(pairs.some((p) => p.postRecoveryFramesCompared < MIN_BATTLE_FRAMES)
        ? ['insufficient post-recovery hash comparisons']
        : []),
    ];
// Permanent failure has a distinct contract: bounded, notified removal,
// normal late-join acceptance and clean convergence. It does not pretend the
// removed peer stayed synchronized, and never changes the full-hash result.
const permanent = missingRecipient.permanent;
const targetGiveups = missingLines.filter((line) =>
  new RegExp(`INPUT-ASK-PUSH-GAVEUP .*slot=${MISSING_RECIPIENT_SLOT} pushes=3`).test(line),
);
const targetDrops = missingLines.filter((line) =>
  new RegExp(`peer hard-disconnected: .* slot: ${MISSING_RECIPIENT_SLOT}$`).test(line),
);
const pendingJoinIndex = missingLines.findIndex((line) =>
  new RegExp(`late-join pending: .* slot=${MISSING_RECIPIENT_SLOT}(?: |$)`).test(line),
);
const giveupIndex = missingLines.findIndex((line) => targetGiveups.includes(line));
const dropIndex = missingLines.findIndex((line) => targetDrops.includes(line));
const permanentProblems = !PERMANENT_RECIPIENT
  ? []
  : [
      ...healthyProblems,
      ...(!correlatedPush || !retryFailuresCorrelated
        ? ['permanent failure is not correlated with the selected recovery']
        : []),
      ...(!(P[1].missingInputs > 0) ? ['P2 input fault did not fire'] : []),
      ...(H.missingRecipientWire?.failures !== 3 ||
      H.missingRecipientWire?.headers.length !== 3 ||
      targetRetryEvents.length !== 2
        ? ['permanent target did not exhaust exactly three bounded transfers']
        : []),
      ...(targetGiveups.length !== 1 ||
      targetDrops.length !== 1 ||
      giveupIndex <= (targetRetryEvents.at(-1)?.index ?? Infinity) ||
      dropIndex <= giveupIndex ||
      pendingJoinIndex <= dropIndex
        ? ['drop and late-join ordering not proven']
        : []),
      ...(!permanent?.notified || permanent.lateJoinedAt === null || !missingRecipient.settled
        ? ['target notification or normal late rejoin missing']
        : []),
      ...(P[MISSING_RECIPIENT_SLOT].dropNotifications !== 1 ? ['target was not notified exactly once'] : []),
      ...(P[MISSING_RECIPIENT_SLOT].preDropHashCount === 0 ? ['target pre-drop history was not preserved'] : []),
      ...(healthyRecipients.some((slot) => {
        const bad = new RegExp(
          `(?:INPUT-ASK-PUSH-GAVEUP|INPUT-ASK-PUSH-ENDED|PEER-PHANTOM).*slot=${slot}(?: |$)|peer hard-disconnected: .* slot: ${slot}$`,
        );
        return missingLines.some((line) => bad.test(line));
      })
        ? ['a healthy recipient was dropped or ended']
        : []),
      ...(missingLines.some((line) => new RegExp(`MESH-HEAL .*slot=${MISSING_RECIPIENT_SLOT}(?: |$)`).test(line))
        ? ['target healed outside the late-join lifecycle']
        : []),
      ...(healthyRecipients.some(
        (slot) => (permanent.framesAfterJoin?.[slot] ?? -1) <= (permanent.framesAtDrop?.[slot] ?? Infinity),
      )
        ? ['healthy recipients did not advance during removal/rejoin']
        : []),
      ...(pairs.some((pair) => pair.postRecoveryFramesCompared < MIN_BATTLE_FRAMES)
        ? ['insufficient post-rejoin hash comparisons']
        : []),
    ];
const missingProblems = PERMANENT_RECIPIENT ? permanentProblems : transientMissingProblems;
const phantomLines = PHANTOM_SETTLE ? H.sync.split('\n').filter((line) => seqOf(line) > phantomSettle.hostAt) : [];
const otherGuests = Array.from({ length: PLAYERS - 2 }, (_, i) => i + 2);
// PHANTOM_SETTLE_LATE: P2's real inputs from before the recovery reached this
// guest after its resync. From the first state it applied after the fault,
// none of P2's inputs below that state's settled point may be fed to its
// engine: some were skipped as settled, and no rollback went to one.
const lateRealProblems = (slot) => {
  const lines = P[slot].sync.split('\n').filter((l) => seqOf(l) > phantomSettle.guestsRecoveredAt[slot]);
  const applied = lines.findIndex((l) => /sync #\d+ applied/.test(l));
  if (!phantomSettle.appliedBeforeRelease[slot] || applied < 0)
    return [`P${slot + 1} got P2's held inputs before applying a host state`];
  if (!(phantomSettle.held[slot] > 0)) return [`no packet from P2 to P${slot + 1} was held`];
  const after = lines.slice(applied);
  // The page logs RESYNC-INPUTS as it settles, just before `sync #N applied`.
  const settled = lines
    .slice(0, applied + 1)
    .map((l) => /RESYNC-INPUTS f=\d+ settledBefore=(\d+)/.exec(l))
    .findLast(Boolean);
  if (!settled) return [`P${slot + 1} logged no RESYNC-INPUTS with its state`];
  const floor = Number(settled[1]);
  const deep = after.filter((l) => {
    const m = /\[C\] MISPREDICTION slot=1 f=(\d+) /.exec(l);
    return m && Number(m[1]) < floor;
  });
  return [
    ...(!after.some((l) => /C-INPUT-SETTLED-SKIP /.test(l)) ? [`P${slot + 1} skipped none of P2's late inputs`] : []),
    ...(deep.length ? [`P${slot + 1} rolled back to P2's input below ${floor}: ${deep[0].split('\t').at(-1)}`] : []),
  ];
};
const phantomSettleProblems = !PHANTOM_SETTLE
  ? []
  : [
      ...(!(phantomSettle.dropped > 0) ? ["P2's inputs to the host were not dropped"] : []),
      // The split needs P2's real input to differ from the host's prediction
      // (its last input before the drop, neutral): the stick went right.
      ...(!P[1].sync
        .split('\n')
        .some((l) => seqOf(l) > phantomSettle.guestsAt[1] && /LOCAL-INPUT slot=1 f=\d+ b=0 lx=70 ly=0 /.test(l))
        ? ["P2's stick never went right (the input override did not take)"]
        : []),
      // The host must have run on a value of P2's input other than P2's: a
      // run where its prediction was right tested nothing.
      ...(faultInputsDiffered === 0 ? ["the host's prediction of P2 was never wrong (not exercised)"] : []),
      ...(!phantomLines.some((l) => /PEER-PHANTOM slot=1 /.test(l)) ? ['the host never made P2 a phantom'] : []),
      ...(!phantomSettle.recovered ? ['the host never recovered P2'] : []),
      ...(!phantomLines.some((l) => /full sync also scheduled for slot\(s\) /.test(l))
        ? ["the host did not resync the other guests on P2's recovery"]
        : []),
      ...otherGuests.flatMap((slot) =>
        P[slot].sync
          .split('\n')
          .filter((l) => seqOf(l) > phantomSettle.guestsAt[slot])
          .some((l) => /sync #\d+ applied/.test(l))
          ? []
          : [`P${slot + 1} applied no host state after P2's recovery`],
      ),
      ...(phantomLines.some((l) => /INPUT-ASK-PUSH-GAVEUP|hardDisconnect/.test(l)) ? ['a peer was dropped'] : []),
      ...(pairs.some((p) => p.postRecoveryFramesCompared < MIN_BATTLE_FRAMES)
        ? ['insufficient post-recovery hash comparisons']
        : []),
      ...(PHANTOM_SETTLE_LATE ? otherGuests.flatMap(lateRealProblems) : []),
    ];
const followUpLines = FOLLOW_UP_RECIPIENT
  ? H.sync.split('\n').filter((line) => seqOf(line) > followUpRecipient.hostAt)
  : [];
const followUpProblems = !FOLLOW_UP_RECIPIENT
  ? []
  : [
      ...(!(P[1].missingInputs > 0) ? ['P2 input fault did not fire'] : []),
      ...(!followUpRecipient.firstSettled ? ["P2's first hole did not settle"] : []),
      ...(!followUpRecipient.secondBroadcast ? ['the second hole was not broadcast'] : []),
      ...(!(followUpRecipient.released > 0) ? ['the target had no acknowledgement held across it'] : []),
      ...(!followUpRecipient.followUp ? ['no follow-up pushed to the target (INPUT-ASK-PUSH-FOLLOWUP)'] : []),
      ...(!followUpRecipient.followUpSettled ? ["the target's follow-up did not settle"] : []),
      ...(followUpLines.some((line) =>
        /INPUT-ASK-PUSH-GAVEUP|INPUT-ASK-PUSH-FOLLOWUP-BUDGET|PEER-PHANTOM|hardDisconnect/.test(line),
      )
        ? ['a peer was dropped, went phantom, or the follow-up was left for budget']
        : []),
      ...(pairs.some((p) => p.postRecoveryFramesCompared < MIN_BATTLE_FRAMES)
        ? ['insufficient post-recovery hash comparisons']
        : []),
    ];

// Secondary recovery result, not an exemption from the original hash oracle.
// The lower boundary is the first deliberately lost input frame, recorded
// BEFORE the fault, and the upper boundary is the observed host frame after
// both source and target settlements, not a boundary inferred from mismatches.
// No frame is removed from pairs, and full-hash failures still fail the run.
const recoveryOracle = !MISSING_RECIPIENT
  ? null
  : {
      window: { from: missingRecipient.range[0], through: missingRecipient.recoveredFrame },
      status:
        missingProblems.length === 0 &&
        pairs.every(
          (p) =>
            p.preFaultBattleFramesCompared >= MIN_BATTLE_FRAMES &&
            p.postRecoveryFramesCompared >= MIN_BATTLE_FRAMES &&
            p.recoveryMismatches.before === 0 &&
            p.recoveryMismatches.after === 0,
        )
          ? 'recovered-with-clean-pre-and-post-fault-frames'
          : 'failed',
      fullHashOracle: pairs.every(
        (p) =>
          p.gameplayMismatches === 0 &&
          p.gameStateMismatches === 0 &&
          p.preDropMismatches.gameplay.length === 0 &&
          p.preDropMismatches.gameState.length === 0,
      )
        ? 'passed'
        : 'failed',
      transientMismatchFrames: pairs.map((p) => ({ slot: p.slot, ...p.recoveryMismatches })),
    };
const summary = {
  recoveryOracle,
  missingRecipient: {
    ...missingRecipient,
    wire: H.missingRecipientWire,
    retries: missingRetries,
    targetRetryEvents,
    correlatedTargetSettled,
    selectedPushes,
    correlatedPush: correlatedPush ?? null,
    problems: missingProblems,
  },
  followUpRecipient: FOLLOW_UP_RECIPIENT ? { ...followUpRecipient, problems: followUpProblems } : undefined,
  phantomSettle: PHANTOM_SETTLE
    ? {
        ...phantomSettle,
        // Each phantom episode on the host, its window's start and recovery
        // frame: the fault's own, and any the container made by itself.
        episodes: phantomEpisodes,
        episodesByContainer: phantomEpisodes.filter((e) => !e.byFault).length,
        faultInputsDiffered,
        phantomLead,
        problems: phantomSettleProblems,
      }
    : undefined,
  room,
  players: PLAYERS,
  latencyMs: LAT,
  jitterMs: JITTER,
  linkKbps: LINK_KBPS,
  inBattleAt: P.map((x) => x.inBattleAt),
  lastFrame: P.map((x) => x.lastR),
  screenSize: SCREEN_SIZE,
  fighters: H.fighters,
  fighterProblems,
  stops,
  phantoms,
  pairs,
  catchUp: catchUpReport,
  hole: holeReport,
};
if (hostEnd) summary.hostEnd = hostEnd;
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

const failed =
  missingProblems.length > 0 ||
  followUpProblems.length > 0 ||
  phantomSettleProblems.length > 0 ||
  P.some((x) => x.inBattleAt < 0) ||
  fighterProblems.length > 0 ||
  pairs.some(
    (p) =>
      p.gameplayMismatches > 0 ||
      p.gameStateMismatches > 0 ||
      p.preDropMismatches.gameplay.length > 0 ||
      p.preDropMismatches.gameState.length > 0 ||
      p.battleFramesCompared < MIN_BATTLE_FRAMES,
  ) ||
  catchUpFailed;
console.log(
  failed
    ? `FAIL: ${pairs.map((p) => `P${p.slot + 1} gp=${p.gameplayMismatches} gs=${p.gameStateMismatches} battle=${p.battleFramesCompared}`).join(', ')}${catchUpFailed ? (CATCH_UP_HOLE ? `; the hole fault did not land as required: ${JSON.stringify(holeReport)}` : '; the catch-up did not run all the way') : ''}${fighterProblems.length ? `; ${fighterProblems.join('; ')}` : ''}`
    : `PASS: all ${PLAYERS} fighters in the battle; every guest's hashes match the host's (${pairs.map((p) => `P${p.slot + 1} ${p.battleFramesCompared} battle frames`).join(', ')})`,
);
process.exit(failed ? 1 : 0);
