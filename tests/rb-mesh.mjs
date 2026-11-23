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
 * RECOVERY_BYSTANDER=1 (PLAYERS=3|4): only the host drops a guest as a
 *   phantom, and hears it again (PEER-RECOVERED) while every other guest (a
 *   "bystander") heard it all along (specs/recovery_bystander.qnt,
 *   onlyTheHostDroppedItTest). RECOVERY_AT frames into the battle (default
 *   600: past the countdown, when fighters move; wall time is no measure in
 *   a container that runs the emulators at a few frames a second) the guest
 *   in RECOVERY_SLOT (default 1) stands still for 20 frames (so the host
 *   predicts it standing) and then walks right, and its inputs are held on
 *   the host's
 *   receive path alone (the directional input gate of
 *   tests/rb-page-network.mjs, as CATCH_UP_HOLE uses it) until the host logs
 *   PEER-PHANTOM for it and RECOVERY_HOLD_MS (default 3000) more; then they
 *   are let through. The host ran that guest's frames on predictions, the
 *   bystanders on its real inputs (`inputSplit`: the keys they applied
 *   differently, from NORMAL-INPUT-TR). On PEER-RECOVERED the host settles
 *   the inputs it held and resyncs the guest. Every guest must end on the
 *   host's state: from the frame of the host's first state after the
 *   recovery on, the gameplay and game-state hashes must match the host's
 *   (at least 60 frames), and so must RDRAM, compared in 4 KB pages every
 *   16th battle frame from each frame's saved state. The core's hashes do
 *   not see a fighter that moved differently (the battle state lives in the
 *   64 KB blocks the game-state hash leaves out), so the page compare does
 *   it: pages that already differ between the host and a guest before the
 *   fault are the ones the audio and video hardware write, and are left
 *   out; any other page that differs is game state that split. The frames
 *   from the hold to the host's state are left out of the hash compare
 *   (`leftOut`): the host predicted that guest there by design. The run
 *   fails, too, unless the fault landed: the gate held inputs, the host
 *   dropped and heard the guest again and sent a state, a bystander applied
 *   inputs different from the host's, the page compare saw a guest split in
 *   the held stretch, and no bystander dropped anyone in the meantime.
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
const FOLLOW_UP_SLOT = PLAYERS - 1;
const CATCH_UP_MS = Number(process.env.CATCH_UP_MS || 0);
const CATCH_UP_SLOT = Number(process.env.CATCH_UP_SLOT || 2);
const CATCH_UP_HOLE = process.env.CATCH_UP_HOLE === '1';
const TRACE_CATCH_UP_INPUTS = process.env.TRACE_CATCH_UP_INPUTS === '1';
const CATCH_UP_HOLE_DELIVERY = process.env.CATCH_UP_HOLE_DELIVERY || 'isolated';
const CATCH_UP_HOLE_MODE = process.env.CATCH_UP_HOLE_MODE || 'deep';
const DEEP_CATCH_UP_HOLE = CATCH_UP_HOLE && CATCH_UP_HOLE_MODE === 'deep';
const CATCH_UP_HOLE_SLOT = Number(process.env.CATCH_UP_HOLE_SLOT || 1);
const RECOVERY_BYSTANDER = process.env.RECOVERY_BYSTANDER === '1';
const RECOVERY_SLOT = Number(process.env.RECOVERY_SLOT || 1);
const RECOVERY_HOLD_MS = Number(process.env.RECOVERY_HOLD_MS || 3000);
const RECOVERY_AT = Number(process.env.RECOVERY_AT || 600);
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
if (
  RECOVERY_BYSTANDER &&
  (MISSING_RECIPIENT ||
    FOLLOW_UP_RECIPIENT ||
    CATCH_UP_MS > 0 ||
    !Number.isInteger(RECOVERY_SLOT) ||
    RECOVERY_SLOT < 1 ||
    RECOVERY_SLOT >= PLAYERS ||
    !(Number.isFinite(RECOVERY_HOLD_MS) && RECOVERY_HOLD_MS >= 0) ||
    !(Number.isInteger(RECOVERY_AT) && RECOVERY_AT >= 0))
)
  fail(
    'RECOVERY_BYSTANDER is a run of its own, with RECOVERY_SLOT a guest (1..PLAYERS-1), RECOVERY_HOLD_MS >= 0 ' +
      'and RECOVERY_AT a whole number of frames',
  );
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
    ({ slot, players, anyFighter, hashLag, rdram }) => {
      const W = (window.__mesh = {
        slot,
        hashes: {},
        rdram: rdram ? {} : null,
        scene: -1,
        inBattleAt: -1,
        pilotFail: null,
        lastR: undefined,
      });
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
        // RECOVERY_BYSTANDER: neutral, so the host's prediction is neutral;
        // then the stick right, held, so its fighter walks where the host's
        // does not.
        if (W.against === 'neutral') return { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
        if (W.against === 'right') return { buttons: 0, lx: 70, ly: 0, cx: 0, cy: 0 };
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
      // RDRAM in 4 KB pages, from frame f's saved state: one FNV hash per
      // page (RECOVERY_BYSTANDER). None of the three hashes above sees a
      // fighter that moved differently (the battle state lives in the blocks
      // the game-state hash leaves out, and the full-state hash samples them
      // with their legitimate differences); a page compare does, once the
      // pages the audio and video hardware write are known. null when the
      // engine no longer holds the frame.
      const PAGE = 4096;
      const shadowOut = m._malloc(40);
      const rdramPages = (f) => {
        let rdram = 0;
        let size = 0;
        if (m._kn_get_state_backend?.() === 1) {
          if (!(m._kn_get_split_state_for_shadow?.(f, shadowOut, 10) >= 9)) return null;
          rdram = m.HEAPU32[shadowOut >> 2];
          size = m.HEAPU32[(shadowOut >> 2) + 1];
        } else {
          const state = m._kn_get_state_for_frame?.(f) ?? 0;
          if (!state) return null;
          rdram = state + m._kn_get_rdram_offset_in_state();
          size = 0x800000;
        }
        if (!rdram || !size) return null;
        const words = new Uint32Array(m.HEAPU8.buffer, rdram, size >> 2);
        const out = new Array(Math.floor(size / PAGE));
        for (let pg = 0; pg < out.length; pg++) {
          let h = 0x811c9dc5;
          for (let w = (pg * PAGE) >> 2, end = w + (PAGE >> 2); w < end; w++) h = Math.imul(h ^ words[w], 0x01000193);
          out[pg] = h >>> 0;
        }
        return out;
      };
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
            const gameplay = m._kn_gameplay_hash(f) >>> 0;
            W.hashes[f] = [gameplay, (m._kn_game_state_hash?.(f) ?? 0) >>> 0, m._kn_full_state_hash(f) >>> 0];
            if (W.rdram && gameplay && W.inBattleAt >= 0 && f >= W.inBattleAt && f % 16 === 0) {
              const pages = rdramPages(f);
              if (pages) W.rdram[f] = pages;
            }
          }
        }
        return r;
      };
    },
    { slot, players: PLAYERS, anyFighter, hashLag: HASH_LAG, rdram: RECOVERY_BYSTANDER },
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
// RECOVERY_BYSTANDER=1: what the fault did, from the host's log.
const recovery = {
  slot: RECOVERY_SLOT,
  holdMs: RECOVERY_HOLD_MS,
  hostAt: null,
  heldFrom: null,
  phantom: null,
  gate: null,
  recovered: null,
  dispatch: null,
  leftOut: null,
  pageAt: null,
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
if (RECOVERY_BYSTANDER) {
  // RECOVERY_AT frames into the battle: past its countdown, when fighters move.
  await host.waitForFunction(
    (after) => window.NetplayRollback.getHudCounters().currentFrame >= window.__mesh.inBattleAt + after,
    RECOVERY_AT,
    { timeout: BATTLE_SECONDS * 1000, polling: 250 },
  );
  // The first line after `afterSeq` that matches, with its frame and match.
  const lineAfter = async (page, afterSeq, re) => {
    for (const line of (await syncLogOf(page)).split('\n')) {
      if (seqOf(line) <= afterSeq) continue;
      const m = line.match(re);
      if (m)
        return {
          seq: seqOf(line),
          frame: Number(line.split('\t')[2]?.slice(2)),
          match: [...m],
          line,
        };
    }
    return null;
  };
  const waitForLineAfter = async (page, afterSeq, re, timeoutMs) => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const found = await lineAfter(page, afterSeq, re);
      if (found) return found;
      await page.waitForTimeout(250);
    }
    return null;
  };
  recovery.hostAt = await lastSeq(host);
  recovery.pageAt = await Promise.all(pages.map(lastSeq));
  // Each player's stock count (SCPlayerData.stock_count, 0x74 bytes apart).
  const stocks = (page) =>
    page.evaluate((n) => {
      const rb = window.NetplayRollback;
      return Array.from({ length: n }, (_, i) => {
        const a = 0x800a4d33 + 0x74 * i;
        return (rb.readRdram32(a & ~3) >>> ((3 - (a & 3)) * 8)) & 0xff;
      });
    }, PLAYERS);
  recovery.stocksAtHold = await stocks(host);
  // The guest stands still for 20 frames, so the host's last inputs of it
  // are neutral and so is its prediction; then every input of it is held on
  // the host's receive path only, and it walks right.
  const neutralFrom = await pages[RECOVERY_SLOT].evaluate(() => {
    window.__mesh.against = 'neutral';
    return window.NetplayRollback.getHudCounters().currentFrame;
  });
  await pages[RECOVERY_SLOT].waitForFunction(
    (from) => window.NetplayRollback.getHudCounters().currentFrame >= from + 20,
    neutralFrom,
    { timeout: 30000, polling: 20 },
  );
  recovery.heldFrom = await pages[RECOVERY_SLOT].evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
  await host.evaluate((slot) => window.__knDirectionalInputGate.arm(slot, 'isolated'), RECOVERY_SLOT);
  await pages[RECOVERY_SLOT].evaluate(() => {
    window.__mesh.against = 'right';
  });
  console.log(`RECOVERY_BYSTANDER: P${RECOVERY_SLOT + 1}'s inputs held on the host's side from f=${recovery.heldFrom}`);
  recovery.phantom = await waitForLineAfter(
    host,
    recovery.hostAt,
    new RegExp(`PEER-PHANTOM slot=${RECOVERY_SLOT}(?: |$)`),
    30000,
  );
  if (recovery.phantom) await host.waitForTimeout(RECOVERY_HOLD_MS);
  recovery.stocksAtRelease = await stocks(host);
  // What each page shows as the held inputs are let through.
  await Promise.all(pages.map((p, i) => p.screenshot({ path: `${OUT}/recovery-p${i + 1}.png` }).catch(() => {})));
  recovery.gate = await host.evaluate(() => {
    const gate = window.__knDirectionalInputGate;
    gate.release(0);
    return gate.stats();
  });
  console.log(
    `RECOVERY_BYSTANDER: host dropped it ${recovery.phantom ? `at f=${recovery.phantom.frame}` : 'never'}; ` +
      `${recovery.gate?.held ?? 0} held packet(s) let through`,
  );
  recovery.recovered = await waitForLineAfter(
    host,
    recovery.hostAt,
    new RegExp(`peer-recovery resync: host scheduled full sync for slot=${RECOVERY_SLOT} at f=(\\d+)`),
    30000,
  );
  if (recovery.recovered) {
    recovery.dispatch = await waitForLineAfter(
      host,
      recovery.recovered.seq,
      /coord sync dispatch: (\d+) guest\(s\) at frame (\d+)/,
      30000,
    );
  }
  if (recovery.dispatch) recovery.leftOut = [recovery.heldFrom, Number(recovery.dispatch.match[2])];
  await pages[RECOVERY_SLOT].evaluate(() => {
    window.__mesh.against = null;
  });
  console.log(
    `RECOVERY_BYSTANDER: ${recovery.recovered ? recovery.recovered.line.split('\t').at(-1) : 'the host never heard it again'}; ` +
      `${recovery.dispatch ? recovery.dispatch.line.split('\t').at(-1) : 'no state dispatched'}`,
  );
  // Keep playing: at least 60 frames after the host's state must match.
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
      rdram: window.__mesh.rdram,
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
    // RECOVERY_BYSTANDER: the host ran the held guest's frames on
    // predictions, from the hold to its first state after the recovery (to
    // the end, if it never sent one: the run fails on that).
    if (
      RECOVERY_BYSTANDER &&
      recovery.heldFrom !== null &&
      f >= recovery.heldFrom &&
      f < (recovery.leftOut?.[1] ?? Infinity)
    ) {
      leftOut++;
      continue;
    }
    compared++;
    if (
      (MISSING_RECIPIENT && f > missingRecipient.recoveredFrame) ||
      (FOLLOW_UP_RECIPIENT && followUpRecipient.recoveredFrame !== null && f > followUpRecipient.recoveredFrame) ||
      (CATCH_UP_HOLE && hole.recoveredFrame !== null && f > hole.recoveredFrame) ||
      (RECOVERY_BYSTANDER && recovery.leftOut && f >= recovery.leftOut[1])
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

// RECOVERY_BYSTANDER: the fault landed (the gate held inputs, the host
// dropped the guest and heard it again, and sent a state), no bystander
// dropped anyone while it did, and every guest ends on the host's state.
const bystanderSlots = Array.from({ length: PLAYERS - 1 }, (_, i) => i + 1).filter((s) => s !== RECOVERY_SLOT);
const linesSince = (x, slot) =>
  RECOVERY_BYSTANDER && recovery.pageAt ? x.sync.split('\n').filter((line) => seqOf(line) > recovery.pageAt[slot]) : [];
const recoveryEvents = !RECOVERY_BYSTANDER
  ? null
  : P.map((x, slot) => {
      const lines = linesSince(x, slot);
      return {
        slot,
        drops: lines.filter((line) => /\tPEER-PHANTOM slot=/.test(line)).map((line) => line.split('\t').at(-1)),
        recovered: lines.filter((line) => /\tPEER-RECOVERED slot=/.test(line)).map((line) => line.split('\t').at(-1)),
        statesLoaded: lines.flatMap((line) => {
          const m = line.match(/\tRESYNC-INPUTS f=(\d+)/);
          return m ? [Number(m[1])] : [];
        }),
        dispatches:
          slot === 0
            ? lines.filter((line) => /coord sync dispatch:/.test(line)).map((line) => line.split('\t').at(-1))
            : [],
      };
    });
// What each page applied for the held guest on a forward tick, by key
// (NORMAL-INPUT-TR), and on how many keys of the held stretch the host and a
// bystander applied different ones: the split the fault is there to make.
const appliedFor = (x, slot) => {
  const out = new Map();
  for (const m of x.sync.matchAll(
    new RegExp(`\\tNORMAL-INPUT-TR f=\\d+ apply=\\d+ .*?R${slot}@(\\d+)\\[([-\\d,]+)\\]`, 'g'),
  ))
    out.set(Number(m[1]), m[2]);
  return out;
};
const inputSplit = !RECOVERY_BYSTANDER
  ? null
  : Object.fromEntries(
      bystanderSlots.map((slot) => {
        const host = appliedFor(P[0], RECOVERY_SLOT);
        const other = appliedFor(P[slot], RECOVERY_SLOT);
        const to = recovery.leftOut?.[1] ?? Infinity;
        const keys = [...host.keys()].filter(
          (k) => k >= (recovery.heldFrom ?? Infinity) && k < to && other.has(k) && other.get(k) !== host.get(k),
        );
        return [`P${slot + 1}`, keys.length];
      }),
    );
// The page compare: pages that already differ between the host and a guest
// on a battle frame before the fault are the ones the audio and video
// hardware write (and rendering skipped in a replay leaves different); any
// other page that differs is game state that split.
const rdramCompare = (G) => {
  const host = P[0].rdram ?? {};
  const noisy = new Set();
  const before = [];
  const during = [];
  const after = [];
  for (const [k, g] of Object.entries(G.rdram ?? {})) {
    const f = Number(k);
    const h = host[k];
    if (!h || !g) continue;
    const diff = [];
    for (let i = 0; i < Math.min(h.length, g.length); i++) if (h[i] !== g[i]) diff.push(i);
    if (f < recovery.heldFrom) {
      before.push(f);
      for (const i of diff) noisy.add(i);
    } else if (recovery.leftOut && f >= recovery.leftOut[1]) after.push({ f, diff });
    else during.push({ f, diff });
  }
  const split = (list) =>
    list.map(({ f, diff }) => ({ f, pages: diff.filter((i) => !noisy.has(i)) })).filter((x) => x.pages.length);
  return {
    calibrationFrames: before.length,
    noisyPages: noisy.size,
    framesDuring: during.length,
    framesAfter: after.length,
    splitDuring: split(during),
    splitAfter: split(after),
  };
};
const rdram = !RECOVERY_BYSTANDER ? null : Object.fromEntries(P.slice(1).map((G, i) => [`P${i + 2}`, rdramCompare(G)]));
const recoveryProblems = !RECOVERY_BYSTANDER
  ? []
  : [
      ...(!(recovery.gate?.held > 0) ? ["the gate held none of the guest's inputs"] : []),
      ...(!recovery.phantom ? ['the host never dropped the guest as a phantom'] : []),
      ...(!recovery.recovered ? ['the host never heard the guest again (PEER-RECOVERED)'] : []),
      ...(!recovery.dispatch ? ['the host sent no state after the recovery'] : []),
      ...(Object.values(inputSplit).every((n) => n === 0)
        ? ['the host and the bystanders ran the held frames on the same inputs: the fault made no split']
        : []),
      ...bystanderSlots.flatMap((slot) =>
        recoveryEvents[slot].drops.length
          ? [`bystander P${slot + 1} dropped a player: ${recoveryEvents[slot].drops.join(' | ')}`]
          : [],
      ),
      ...pairs.flatMap((p) =>
        p.postRecoveryFramesCompared < MIN_BATTLE_FRAMES
          ? [
              `P${p.slot + 1}: ${p.postRecoveryFramesCompared} frames compared after the host's state, fewer than ${MIN_BATTLE_FRAMES}`,
            ]
          : [],
      ),
      ...Object.entries(rdram).flatMap(([page, r]) =>
        r.calibrationFrames < 8 || r.framesAfter < 4
          ? [
              `${page}: ${r.calibrationFrames} page-compared frames before the fault and ${r.framesAfter} after the ` +
                `host's state, fewer than 8 and 4`,
            ]
          : [],
      ),
      ...(Object.values(rdram).every((r) => r.splitDuring.length === 0)
        ? ['no guest split from the host in the held stretch: the fault changed no game state the compare can see']
        : []),
      ...Object.entries(rdram).flatMap(([page, r]) =>
        r.splitAfter.length
          ? [
              `${page}: RDRAM differs from the host's after its state on ${r.splitAfter.length} of ` +
                `${r.framesAfter} frames (first f=${r.splitAfter[0].f}, pages ${r.splitAfter[0].pages.slice(0, 8).join(',')})`,
            ]
          : [],
      ),
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
  recoveryBystander: RECOVERY_BYSTANDER
    ? { ...recovery, events: recoveryEvents, inputSplit, rdram, problems: recoveryProblems }
    : undefined,
};
if (hostEnd) summary.hostEnd = hostEnd;
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

const failed =
  missingProblems.length > 0 ||
  followUpProblems.length > 0 ||
  recoveryProblems.length > 0 ||
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
    ? `FAIL: ${pairs.map((p) => `P${p.slot + 1} gp=${p.gameplayMismatches} gs=${p.gameStateMismatches} battle=${p.battleFramesCompared}`).join(', ')}${catchUpFailed ? (CATCH_UP_HOLE ? `; the hole fault did not land as required: ${JSON.stringify(holeReport)}` : '; the catch-up did not run all the way') : ''}${fighterProblems.length ? `; ${fighterProblems.join('; ')}` : ''}${recoveryProblems.length ? `; ${recoveryProblems.join('; ')}` : ''}`
    : `PASS: all ${PLAYERS} fighters in the battle; every guest's hashes match the host's (${pairs.map((p) => `P${p.slot + 1} ${p.battleFramesCompared} battle frames`).join(', ')})`,
);
process.exit(failed ? 1 : 0);
