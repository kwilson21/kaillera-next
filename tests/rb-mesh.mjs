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
 *     [RECOVERY_BYSTANDER=1 [RECOVERY_MODE=hold|pause] [RECOVERY_SLOT=1] [RECOVERY_AT=600]] \
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
 *   From the fault on the target walks left and right (never neutral), so the
 *   inputs it leaves behind at its removal differ from the neutral the cut
 *   gives. The removed player's applied input (`removedInput` in
 *   summary.json): every page that stayed must have applied the same input
 *   for it on every input tag all of them ran, from 90 tags before the
 *   removal to 150 after the rejoin (specs/removed_input.qnt,
 *   removedInputAgrees), read from each page's NORMAL-INPUT-TR,
 *   CATCH-UP-INPUT-TR and the C engine's REPLAY-INPUT-TR lines, the last in
 *   its log winning. A difference fails the run.
 *   Around the rejoin (`joinInput`, any run in which a page joins the running
 *   match): from the frame of the state the joining page loaded to 150 frames
 *   on, every page, the joining one too, must have applied the same input
 *   for every slot on every tag all of them ran
 *   (specs/late_join_input_agreement.qnt, pagesAgreeAroundTheJoin;
 *   tests/join-input-check.mjs), a difference only on frames a later host
 *   state replaced being reported, not failed.
 *   ROSTER_HOLD_MS=<n> (with it): the host's roster messages (`roster-cut:`,
 *   `roster-mask:`, `roster:`) to the guest in ROSTER_HOLD_SLOT (default 1)
 *   are held n ms each, in order, so that guest hears of the removal frames
 *   after the cut (removed_input.qnt, guestAheadTest); it must run them again
 *   (ROSTER-CUT-RERUN, or the host's state: ROSTER-CUT-LATE) and still agree.
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
 *   host's state: from the host's last state for the recovery on (the first
 *   one, or the last of its follow-ups, sent while an input was still
 *   predicted, once the host has sent none for 10 s), the gameplay and
 *   game-state hashes must match the host's
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
 *   RECOVERY_MODE=pause: the guest's ticks are paused instead
 *   (NetplayRollback.pauseTick) until the host and every bystander have
 *   dropped it, then resumed, so every page predicted it
 *   (bystanderAppliesWhatTheHostSettledTest's setting). Each bystander must
 *   hear it again and ask the host for its state (web/src/recovery-resync.ts,
 *   `ask`), and the same agreement from the host's state on is required.
 *
 * DROP_LINK=1 (PLAYERS=3|4): a guest's connection to the host drops and comes
 *   back while the other guests ("bystanders") keep theirs
 *   (specs/reconnect_inputs.qnt, reconnect_history: a reconnect keeps the C
 *   slot, so a real input that comes after the reset for a frame the host
 *   ran on a prediction is still checked). DROP_LINK_AT frames into the
 *   battle (default 600) the guest in DROP_LINK_SLOT (default 1) stands
 *   still for 20 frames, so the host predicts it standing, then holds the
 *   stick right while no input packet of the walk goes to the host (its
 *   channels to the host drop them on send) until the host has run three
 *   tags of the walk, on a neutral prediction, and then closes its
 *   RTCPeerConnection to the host (pc.close() on its engine's peer entry
 *   for slot 0). Every bystander ran those tags on the real inputs. The engine reconnects (the host,
 *   the lower slot, offers), resets the peer on both sides and the guest
 *   resyncs from the host. Fails unless the connection was closed; the host
 *   kept its C slot of the guest at the reconnect reset
 *   (`PEER-RESET-KEEPS-CORE slot=<s> reason=reconnect`); the host's C engine
 *   then compared one of the guest's real inputs with what it predicted and
 *   rolled back (`[C] MISPREDICTION slot=<s>` after that reset): the path the
 *   fault is there to reach; the guest applied a resync after the reconnect;
 *   and the host and every bystander applied the same input for that guest
 *   on every tag all of them ran, from 60 tags before the drop to 400 after
 *   it (`dropLink.applied`, tests/join-input-check.mjs `appliedForTag`).
 *   Hashes: every bystander's are compared with the host's on every frame;
 *   the dropped guest's, from 30 frames before the drop to the frame its
 *   resync lands on, are left out (each side ran on predictions of the
 *   other there, and the resync replaces the guest's), and compared after.
 * SCREEN_SIZE: the core's render size (default 320x240, the core's own
 *   default is 640x480). Four emulators on software GL are what stops pages
 *   for seconds in a cloud container; a quarter of the pixels is a quarter
 *   of that work. It changes what is drawn, not what is emulated.
 *
 * Each page reads a frame's hashes its engine's rollback window + 1 frames
 * behind the newest frame, the first frame no rollback can rewrite
 * (tests/hash-lag.mjs; `hashLag` in summary.json).
 * A frame the engine no longer holds hashes to 0 (kn_gameplay_hash and the
 * others read the frame from the ring buffer), as right after a resync takes
 * a page back; such frames are counted as `unrecorded`, not compared. A
 * frame one page has a hash for and the other none is counted as `missing`.
 * Both lower each pair's `battleCoverage` (battle frames compared over the
 * battle frames both pages could have read), with the battle ones per page
 * in `battleUnrecorded`.
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
import { appliedForTag, joinInputAgreement, joinStateFrame } from './join-input-check.mjs';
import { trackHashLag, unrecordedIn } from './hash-lag.mjs';

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
const ROSTER_HOLD_MS = Number(process.env.ROSTER_HOLD_MS || 0);
const ROSTER_HOLD_SLOT = Number(process.env.ROSTER_HOLD_SLOT || 1);
const RECOVERY_SLOT = Number(process.env.RECOVERY_SLOT || 1);
const RECOVERY_HOLD_MS = Number(process.env.RECOVERY_HOLD_MS || 3000);
const RECOVERY_AT = Number(process.env.RECOVERY_AT || 600);
const RECOVERY_MODE = process.env.RECOVERY_MODE || 'hold';
const RECOVERY_QUIET_MS = 10000;
const DROP_LINK = process.env.DROP_LINK === '1';
const DROP_LINK_SLOT = Number(process.env.DROP_LINK_SLOT || 1);
const DROP_LINK_AT = Number(process.env.DROP_LINK_AT || 600);
const RECOVERY_SETTLE_MS = 120000;
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
// Hashes are recorded each page's own lag behind the frame just run: its
// engine's rollback window + 1, so no later rollback can change them
// (tests/hash-lag.mjs).

const fail = (msg) => {
  console.log(msg);
  process.exit(1);
};
if (PERMANENT_RECIPIENT && !MISSING_RECIPIENT) fail('MISSING_RECIPIENT_PERMANENT requires MISSING_RECIPIENT=1');
if (ROSTER_HOLD_MS && !(PERMANENT_RECIPIENT && Number.isFinite(ROSTER_HOLD_MS) && ROSTER_HOLD_MS > 0))
  fail('ROSTER_HOLD_MS needs MISSING_RECIPIENT_PERMANENT=1 and a number of ms above 0');
if (
  ROSTER_HOLD_MS &&
  !(
    Number.isInteger(ROSTER_HOLD_SLOT) &&
    ROSTER_HOLD_SLOT >= 1 &&
    ROSTER_HOLD_SLOT < PLAYERS &&
    ROSTER_HOLD_SLOT !== MISSING_RECIPIENT_SLOT
  )
)
  fail(`ROSTER_HOLD_SLOT=${process.env.ROSTER_HOLD_SLOT} invalid: a guest's slot other than the removed one`);
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
    !(Number.isInteger(RECOVERY_AT) && RECOVERY_AT >= 0) ||
    !['hold', 'pause'].includes(RECOVERY_MODE))
)
  fail(
    'RECOVERY_BYSTANDER is a run of its own, with RECOVERY_SLOT a guest (1..PLAYERS-1), RECOVERY_HOLD_MS >= 0 ' +
      'RECOVERY_AT a whole number of frames, and RECOVERY_MODE hold or pause',
  );
if (
  DROP_LINK &&
  (MISSING_RECIPIENT ||
    FOLLOW_UP_RECIPIENT ||
    CATCH_UP_MS > 0 ||
    RECOVERY_BYSTANDER ||
    !Number.isInteger(DROP_LINK_SLOT) ||
    DROP_LINK_SLOT < 1 ||
    DROP_LINK_SLOT >= PLAYERS ||
    !(Number.isInteger(DROP_LINK_AT) && DROP_LINK_AT >= 0))
)
  fail(
    'DROP_LINK is a run of its own, with DROP_LINK_SLOT a guest (1..PLAYERS-1) and DROP_LINK_AT a whole number of frames',
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
  await p.evaluate(trackHashLag);
  await p.evaluate(
    ({ slot, players, anyFighter, rdram }) => {
      const W = (window.__mesh = {
        slot,
        hashes: {},
        ticksWithoutLag: 0,
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
        // MISSING_RECIPIENT_PERMANENT: the target walks left and right, never neutral.
        if (W.against === 'pace') return { buttons: 0, lx: Math.floor(f / 30) % 2 ? 70 : -70, ly: 0, cx: 0, cy: 0 };
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
        // This page's lag (tests/hash-lag.mjs); null until its engine is armed.
        const hashLag = window.__knHashLag?.lag ?? null;
        // A resync that takes the counter back (and the catch-up that runs the
        // frames again) makes hashes already recorded from there on stale.
        if (idle && W.lastR !== undefined && r < W.lastR && hashLag !== null) {
          for (const k of Object.keys(W.hashes)) if (+k >= r - hashLag) delete W.hashes[k];
        }
        if (idle) W.lastR = r;
        if (idle && r > 40 && hashLag === null) W.ticksWithoutLag++;
        if (idle && r > 40 && hashLag !== null) {
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
    { slot, players: PLAYERS, anyFighter, rdram: RECOVERY_BYSTANDER },
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
// RECOVERY_BYSTANDER=1: the guests other than the one dropped, and what the
// fault did, from the host's log.
const bystanderSlots = Array.from({ length: PLAYERS - 1 }, (_, i) => i + 1).filter((s) => s !== RECOVERY_SLOT);
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
  dispatches: [],
  settledQuiet: false,
  bystanderPhantoms: null,
  bystanderAsks: null,
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
  if (PERMANENT_RECIPIENT) {
    await pages[MISSING_RECIPIENT_SLOT].evaluate(() => {
      window.__mesh.against = 'pace';
    });
    if (ROSTER_HOLD_MS) {
      await host.evaluate(
        ({ slot, ms }) => {
          const peer = Object.values(window.KNState?.peers ?? {}).find((p) => p.slot === slot);
          if (peer?.dc?.readyState !== 'open') throw new Error('held guest channel is not open');
          const dc = peer.dc;
          const send = dc.send;
          const queue = [];
          const report = (window.__meshRosterHold = { held: 0, released: 0, first: null });
          const flush = () => {
            while (queue.length && queue[0].at <= performance.now()) {
              const { data } = queue.shift();
              try {
                send.call(dc, data);
                report.released++;
              } catch (_) {}
            }
            if (queue.length) setTimeout(flush, Math.max(0, queue[0].at - performance.now()));
          };
          dc.send = function (data) {
            if (typeof data === 'string' && data.startsWith('roster')) {
              report.held++;
              report.first ??= data.slice(0, 40);
              queue.push({ data, at: performance.now() + ms });
              if (queue.length === 1) setTimeout(flush, ms);
              return;
            }
            return send.call(this, data);
          };
        },
        { slot: ROSTER_HOLD_SLOT, ms: ROSTER_HOLD_MS },
      );
    }
  }
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
  if (RECOVERY_MODE === 'pause') await pages[RECOVERY_SLOT].evaluate(() => window.NetplayRollback.pauseTick());
  else await host.evaluate((slot) => window.__knDirectionalInputGate.arm(slot, 'isolated'), RECOVERY_SLOT);
  await pages[RECOVERY_SLOT].evaluate(() => {
    window.__mesh.against = 'right';
  });
  console.log(
    `RECOVERY_BYSTANDER: P${RECOVERY_SLOT + 1} ` +
      `${RECOVERY_MODE === 'pause' ? 'paused' : "held on the host's side"} from f=${recovery.heldFrom}`,
  );
  recovery.phantom = await waitForLineAfter(
    host,
    recovery.hostAt,
    new RegExp(`PEER-PHANTOM slot=${RECOVERY_SLOT}(?: |$)`),
    30000,
  );
  // RECOVERY_MODE=pause: every bystander drops it too.
  recovery.bystanderPhantoms =
    RECOVERY_MODE === 'pause'
      ? await Promise.all(
          bystanderSlots.map((slot) =>
            waitForLineAfter(
              pages[slot],
              recovery.pageAt[slot],
              new RegExp(`PEER-PHANTOM slot=${RECOVERY_SLOT}(?: |$)`),
              30000,
            ),
          ),
        )
      : null;
  if (recovery.phantom) await host.waitForTimeout(RECOVERY_HOLD_MS);
  recovery.stocksAtRelease = await stocks(host);
  // What each page shows as the guest is let through (held inputs, or ticks).
  await Promise.all(pages.map((p, i) => p.screenshot({ path: `${OUT}/recovery-p${i + 1}.png` }).catch(() => {})));
  if (RECOVERY_MODE === 'pause') await pages[RECOVERY_SLOT].evaluate(() => window.NetplayRollback.resumeTick());
  else
    recovery.gate = await host.evaluate(() => {
      const gate = window.__knDirectionalInputGate;
      gate.release(0);
      return gate.stats();
    });
  console.log(
    `RECOVERY_BYSTANDER: host dropped it ${recovery.phantom ? `at f=${recovery.phantom.frame}` : 'never'}; ` +
      (RECOVERY_MODE === 'pause' ? 'resumed' : `${recovery.gate?.held ?? 0} held packet(s) let through`),
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
  // The host's state can be followed up: one taken while an input was still
  // predicted is sent again once that input differed (SYNC-FOLLOW-UP-NEEDED;
  // specs/sync_follow_up.qnt), and a guest runs on the earlier one until
  // then, as the model's agreement waits for every state still owed
  // (mayStillChange). Each chain is bounded (SYNC_FOLLOW_UP_MAX, 3 s apart),
  // but a guest's own request starts one of its own, and in a container that
  // runs the emulators at a few frames a second they can run for many
  // seconds. So the compare starts at the last state the host sent once it
  // has sent none for RECOVERY_QUIET_MS (within RECOVERY_SETTLE_MS).
  if (recovery.dispatch) {
    const dispatchesSince = async () =>
      (await syncLogOf(host))
        .split('\n')
        .filter((line) => seqOf(line) >= recovery.dispatch.seq && /coord sync dispatch:/.test(line));
    const until = Date.now() + RECOVERY_SETTLE_MS;
    let lines = await dispatchesSince();
    let quietSince = Date.now();
    while (Date.now() < until && Date.now() - quietSince < RECOVERY_QUIET_MS) {
      await host.waitForTimeout(1000);
      const now = await dispatchesSince();
      if (now.length !== lines.length) quietSince = Date.now();
      lines = now;
    }
    recovery.settledQuiet = Date.now() - quietSince >= RECOVERY_QUIET_MS;
    recovery.dispatches = lines.map((line) => Number(line.match(/at frame (\d+)/)[1]));
    // And every state a guest loaded meanwhile: the answer to its own request
    // goes out directly, not through a dispatch.
    const loaded = await Promise.all(
      pages.slice(1).map(async (page, i) =>
        (await syncLogOf(page))
          .split('\n')
          .filter((line) => seqOf(line) > recovery.pageAt[i + 1])
          .flatMap((line) => {
            const m = line.match(/\tRESYNC-INPUTS f=(\d+)/);
            return m ? [Number(m[1])] : [];
          }),
      ),
    );
    recovery.leftOut = [recovery.heldFrom, Math.max(...recovery.dispatches, ...loaded.flat())];
  }
  // RECOVERY_MODE=pause: each bystander heard the guest again and asked the
  // host for its state (web/src/recovery-resync.ts, `ask`).
  recovery.bystanderAsks =
    RECOVERY_MODE === 'pause'
      ? await Promise.all(
          bystanderSlots.map((slot) =>
            waitForLineAfter(
              pages[slot],
              recovery.pageAt[slot],
              new RegExp(`peer-recovery resync: slot=${RECOVERY_SLOT} heard again; asked the host`),
              30000,
            ),
          ),
        )
      : null;
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
// DROP_LINK=1: the guest's connection to the host drops and comes back.
const dropLink = { pageAt: null, closed: null, heldFrom: null, resynced: false };
if (DROP_LINK) {
  const guest = pages[DROP_LINK_SLOT];
  await host.waitForFunction(
    (after) => window.NetplayRollback.getHudCounters().currentFrame >= window.__mesh.inBattleAt + after,
    DROP_LINK_AT,
    { timeout: BATTLE_SECONDS * 1000, polling: 250 },
  );
  dropLink.pageAt = await Promise.all(pages.map(lastSeq));
  const neutralFrom = await guest.evaluate(() => {
    window.__mesh.against = 'neutral';
    return window.NetplayRollback.getHudCounters().currentFrame;
  });
  await guest.waitForFunction(
    (from) => window.NetplayRollback.getHudCounters().currentFrame >= from + 20,
    neutralFrom,
    { timeout: 30000, polling: 20 },
  );
  // The walk starts, and no input packet of it goes to the host on the old
  // connection (the new one's channels are not wrapped): the host runs its
  // tags on a neutral prediction, the bystanders on the real inputs.
  dropLink.heldFrom = await guest.evaluate(() => {
    const from = window.NetplayRollback.getHudCounters().currentFrame;
    window.__mesh.against = 'right';
    window.__meshWalkDropped = 0;
    const entry = Object.values(window.KNState?.peers ?? {}).find((peer) => peer.slot === 0);
    for (const dc of new Set([entry?.dc, entry?.rbDc].filter(Boolean))) {
      const send = dc.send;
      dc.send = function (data) {
        if (data instanceof ArrayBuffer && data.byteLength >= 4 && new Int32Array(data, 0, 1)[0] >= from) {
          window.__meshWalkDropped++;
          return;
        }
        return send.call(this, data);
      };
    }
    return from;
  });
  // Until the host has run three tags of the walk (on its prediction).
  dropLink.hostRanWalk = await host
    .waitForFunction(
      (from) => {
        const c = window.NetplayRollback.getHudCounters();
        return c.currentFrame - (c.delay ?? 0) >= from + 3;
      },
      dropLink.heldFrom,
      { timeout: 20000, polling: 20 },
    )
    .then(() => true)
    .catch(() => false);
  dropLink.closed = await guest.evaluate(() => {
    const frame = window.NetplayRollback.getHudCounters().currentFrame;
    const entry = Object.values(window.KNState?.peers ?? {}).find((peer) => peer.slot === 0);
    if (!entry?.pc) return { closed: false, frame, why: 'no peer entry for slot 0' };
    const was = { pc: entry.pc.connectionState, dc: entry.dc?.readyState ?? null };
    entry.pc.close();
    return { closed: true, frame, was, walkPacketsDropped: window.__meshWalkDropped };
  });
  console.log(`DROP_LINK: P${DROP_LINK_SLOT + 1} closed its connection to the host`, JSON.stringify(dropLink.closed));
  dropLink.resynced = await waitForLine(guest, dropLink.pageAt[DROP_LINK_SLOT], /sync #\d+ applied/, 90000);
  console.log(`DROP_LINK: P${DROP_LINK_SLOT + 1} resynced after the reconnect: ${dropLink.resynced}`);
}
await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - (Date.now() - tBattle)));

// Collect, then compare every guest with the host.
const P = await Promise.all(
  pages.map(async (p) => ({
    sync: await syncLogOf(p),
    ...(await p.evaluate(() => ({
      nativeInputs: window.__knNativeInputObserver?.export() ?? null,
      missingRecipientWire: window.__meshMissingRecipient ?? null,
      rosterHold: window.__meshRosterHold ?? null,
      missingInputs: window.__meshMissingInputs ?? 0,
      hashes: { ...(window.__meshDroppedSnapshot?.hashes ?? {}), ...window.__mesh.hashes },
      rdram: window.__mesh.rdram,
      dropNotifications: (window.__knEvents ?? []).filter((e) => e.meta?.kind === 'dropped-by-host').length,
      preDropHashes: window.__meshDroppedSnapshot?.hashes ?? {},
      preDropHashCount: Object.keys(window.__meshDroppedSnapshot?.hashes ?? {}).length,
      inBattleAt: window.__meshDroppedSnapshot?.inBattleAt ?? window.__mesh.inBattleAt,
      lastR: window.__mesh.lastR,
      hashLag: window.__knHashLag ?? null,
      ticksWithoutLag: window.__mesh.ticksWithoutLag,
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
// DROP_LINK: from 30 frames before the drop to the frame the dropped guest's
// reconnect resync lands on, its frames and the host's split by design.
const linesAfterSeq = (x, seq) => x.sync.split('\n').filter((line) => seqOf(line) > seq);
const dropLinkWindow = (() => {
  if (!DROP_LINK || !dropLink.closed?.closed) return null;
  const guestLines = linesAfterSeq(P[DROP_LINK_SLOT], dropLink.pageAt[DROP_LINK_SLOT]);
  const sent = guestLines.findIndex((line) => /reconnect resync: sent/.test(line));
  const applied = (sent < 0 ? [] : guestLines.slice(sent))
    .map((line) => line.match(/sync #\d+ applied \(frame \d+ -> (\d+)/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  let to = applied.length ? applied[0] : null;
  for (const at of applied) if (to !== null && at > to && at <= to + 12) to = at;
  return { from: dropLink.heldFrom - 30, to, resyncSent: sent >= 0 };
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
  // A frame one page read and the other has no hash for (never read there:
  // its lag not yet known, or a resync took it past the frame).
  const missing = { host: 0, guest: 0 };
  let leftOut = 0;
  const mismatches = { gameplay: [], gameState: [], fullState: 0 };
  for (const k of new Set([...Object.keys(G.hashes), ...Object.keys(H.hashes)])) {
    const f = +k;
    const h = H.hashes[k];
    const g = G.hashes[k];
    if (!h || !g) {
      missing[h ? 'guest' : 'host']++;
      continue;
    }
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
    // DROP_LINK: the dropped guest's frames until its resync (none compared
    // if it never resynced: the run fails on that).
    if (
      dropLinkWindow &&
      slot === DROP_LINK_SLOT &&
      f >= dropLinkWindow.from &&
      (dropLinkWindow.to === null || f < dropLinkWindow.to)
    ) {
      leftOut++;
      continue;
    }
    compared++;
    if (
      (DROP_LINK && dropLinkWindow?.to != null && f >= dropLinkWindow.to) ||
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
  // Battle frames both pages could have read by the end, each its own lag
  // behind its last frame; every one counts, so one left without a hash (or
  // read as 0) lowers the coverage and is counted per page.
  const lagOf = (x) => x.hashLag?.lag ?? 0;
  const spanTo = Math.min((H.lastR ?? 0) - lagOf(H), (G.lastR ?? 0) - lagOf(G));
  const battleSpan = battleFrom > 0 && spanTo >= battleFrom ? spanTo - battleFrom + 1 : 0;
  return {
    slot,
    preDropMismatches,
    compared,
    unrecorded,
    missing,
    leftOut,
    battleSpan,
    battleCoverage: battleSpan > 0 ? +Math.min(1, battle / battleSpan).toFixed(3) : 0,
    battleUnrecorded:
      battleSpan > 0
        ? { host: unrecordedIn(H.hashes, battleFrom, spanTo), guest: unrecordedIn(G.hashes, battleFrom, spanTo) }
        : null,
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

// MISSING_RECIPIENT_PERMANENT: the removed player's input, as every page that
// stayed applied it, by input tag (specs/removed_input.qnt,
// removedInputAgrees): tests/join-input-check.mjs `appliedForTag`.
const rosterBroadcasts = [...H.sync.matchAll(/\tROSTER broadcast: frame=(\d+) slots=\[([\d,]*)\]/g)].map((m) => ({
  frame: Number(m[1]),
  slots: m[2] ? m[2].split(',').map(Number) : [],
}));
const removal =
  rosterBroadcasts.find((r) => r.frame >= H.inBattleAt && !r.slots.includes(MISSING_RECIPIENT_SLOT)) ?? null;
const rejoin = removal
  ? (rosterBroadcasts.find((r) => r.frame >= removal.frame && r.slots.includes(MISSING_RECIPIENT_SLOT)) ?? null)
  : null;
const removedInput = !PERMANENT_RECIPIENT
  ? null
  : (() => {
      const stayed = P.map((x, slot) => ({ x, slot })).filter(({ slot }) => slot !== MISSING_RECIPIENT_SLOT);
      const applied = stayed.map(({ x }) => appliedForTag(x.sync, MISSING_RECIPIENT_SLOT));
      // Tags every page has finalized: well behind the last one each logged.
      const lastTag = Math.min(...applied.map((m) => Math.max(-1, ...m.keys()))) - 40;
      const from = removal ? removal.frame - 90 : 0;
      const to = Math.min(lastTag, (rejoin ?? removal)?.frame + 150);
      const differing = [];
      // Differences only on frames a page ran before a host state replaced
      // its own: reported, not a failure (the host is slot 0, never loads one).
      const superseded = [];
      let compared = 0;
      for (let tag = from; removal && tag <= to; tag++) {
        if (!applied.every((m) => m.has(tag))) continue;
        compared++;
        const values = applied.map((m) => m.get(tag));
        const off = values.map((v, i) => i).filter((i) => values[i] !== values[0]);
        if (off.length === 0) continue;
        const row = { tag, ...Object.fromEntries(stayed.map(({ slot }, i) => [`P${slot + 1}`, values[i]])) };
        if (off.every((i) => applied[i].superseded(tag, applied[i].delay))) superseded.push(row);
        else differing.push(row);
      }
      const rerun = stayed.map(({ x, slot }) => ({
        page: `P${slot + 1}`,
        cuts: [...x.sync.matchAll(/\tROSTER-CUT \(([^)]*)\) (.*)/g)].map((m) => `${m[1]}: ${m[2]}`),
        reruns: [...x.sync.matchAll(/\t(ROSTER-CUT-RERUN .*|ROSTER-CUT-LATE .*|ROSTER-CUT-MISSING .*)/g)].map(
          (m) => m[1],
        ),
      }));
      return {
        slot: MISSING_RECIPIENT_SLOT,
        removedAt: removal?.frame ?? null,
        rejoinedAt: rejoin?.frame ?? null,
        tags: [from, to],
        compared,
        differing: differing.slice(0, 40),
        differingCount: differing.length,
        supersededByHostState: superseded.slice(0, 40),
        supersededCount: superseded.length,
        rosterHold: ROSTER_HOLD_MS ? { ms: ROSTER_HOLD_MS, slot: ROSTER_HOLD_SLOT, ...H.rosterHold } : null,
        pages: rerun,
      };
    })();
const removedInputProblems = !removedInput
  ? []
  : [
      ...(removedInput.removedAt === null ? ['the host never broadcast the removal'] : []),
      ...(removedInput.compared < 60 ? [`only ${removedInput.compared} tags of the removed player compared`] : []),
      ...(removedInput.differingCount
        ? [
            `the removed player's applied input differs between pages on ${removedInput.differingCount} tags ` +
              `(first ${JSON.stringify(removedInput.differing[0])})`,
          ]
        : []),
      ...(ROSTER_HOLD_MS && !(H.rosterHold?.held > 0) ? ['no roster message was held'] : []),
    ];
// Any page that joined the running match (MISSING_RECIPIENT_PERMANENT's
// rejoin, or a new player): from the frame of the state it loaded to 150
// frames on, every page, the joining one too, must have applied the same
// input for every slot on every tag all of them ran
// (specs/late_join_input_agreement.qnt, pagesAgreeAroundTheJoin;
// tests/join-input-check.mjs). A difference only on frames a page ran before
// a host state replaced its own is reported, not failed.
const joinInput = (() => {
  const joiner = P.findIndex((x, slot) => slot !== 0 && joinStateFrame(x.sync) !== null);
  if (joiner < 0) return null;
  const stateFrame = joinStateFrame(P[joiner].sync);
  const delay = appliedForTag(H.sync, 0).delay;
  return {
    joiner: `P${joiner + 1}`,
    stateFrame,
    ...joinInputAgreement({
      pages: P.map((x, slot) => ({ name: `P${slot + 1}`, sync: x.sync })),
      slots: P.map((_, slot) => slot),
      from: stateFrame - delay,
      to: stateFrame + 150,
    }),
  };
})();
const joinInputProblems = !joinInput
  ? []
  : [
      ...Object.entries(joinInput.compared)
        .filter(([, n]) => n < 60)
        .map(([slot, n]) => `only ${n} tags of slot ${slot} compared around the join`),
      ...(joinInput.differingCount
        ? [
            `the pages applied different inputs around the join on ${joinInput.differingCount} slot tags ` +
              `(first ${JSON.stringify(joinInput.differing[0])})`,
          ]
        : []),
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

// RECOVERY_BYSTANDER: the fault landed (the gate held inputs, the host
// dropped the guest and heard it again, and sent a state), no bystander
// dropped anyone while it did, and every guest ends on the host's state.
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
      ...(RECOVERY_MODE === 'hold' && !(recovery.gate?.held > 0) ? ["the gate held none of the guest's inputs"] : []),
      ...(RECOVERY_MODE === 'pause'
        ? bystanderSlots.flatMap((slot, i) => [
            ...(!recovery.bystanderPhantoms?.[i] ? [`bystander P${slot + 1} never dropped the paused guest`] : []),
            ...(!recovery.bystanderAsks?.[i]
              ? [`bystander P${slot + 1} heard the guest again but did not ask the host for its state`]
              : []),
          ])
        : []),
      ...(!recovery.phantom ? ['the host never dropped the guest as a phantom'] : []),
      ...(!recovery.recovered ? ['the host never heard the guest again (PEER-RECOVERED)'] : []),
      ...(!recovery.dispatch ? ['the host sent no state after the recovery'] : []),
      ...(recovery.dispatch && !recovery.settledQuiet
        ? [`the host was still sending states ${RECOVERY_SETTLE_MS / 1000} s after the recovery`]
        : []),
      ...(RECOVERY_MODE === 'hold' && Object.values(inputSplit).every((n) => n === 0)
        ? ['the host and the bystanders ran the held frames on the same inputs: the fault made no split']
        : []),
      ...bystanderSlots.flatMap((slot) =>
        recoveryEvents[slot].drops.filter(
          (line) => RECOVERY_MODE === 'hold' || !line.includes(`slot=${RECOVERY_SLOT} `),
        ).length
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
      ...(RECOVERY_MODE === 'hold' && Object.values(rdram).every((r) => r.splitDuring.length === 0)
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
// DROP_LINK: the reset kept the host's C slot of the guest, a real input of it
// that came after the reset was compared with the prediction and rolled back,
// and the host and every bystander applied the same input for it.
const dropLinkReport = !DROP_LINK
  ? null
  : (() => {
      const hostLines = dropLink.pageAt ? linesAfterSeq(H, dropLink.pageAt[0]) : [];
      const kept = hostLines.findIndex((line) =>
        new RegExp(`PEER-RESET-KEEPS-CORE slot=${DROP_LINK_SLOT} reason=reconnect`).test(line),
      );
      const after = kept < 0 ? [] : hostLines.slice(kept + 1);
      const c = (re) => after.filter((line) => re.test(line));
      const rolledBack = c(new RegExp(`\\[C\\] MISPREDICTION slot=${DROP_LINK_SLOT} `));
      const pastWindow = c(new RegExp(`\\[C\\] (DEEP-MISPREDICT-SKIP|FAILED-ROLLBACK) slot=${DROP_LINK_SLOT} `));
      const settledSkips = c(/C-INPUT-SETTLED-SKIP/);
      const stayed = P.map((x, slot) => ({ x, slot })).filter(({ slot }) => slot !== DROP_LINK_SLOT);
      const applied = stayed.map(({ x }) => appliedForTag(x.sync, DROP_LINK_SLOT));
      const delay = applied[0].delay;
      const lastTag = Math.min(...applied.map((m) => Math.max(-1, ...m.keys()))) - 40;
      const dropTag = (dropLink.heldFrom ?? 0) - delay;
      const from = dropTag - 60;
      const to = Math.min(lastTag, dropTag + 400);
      const differing = [];
      const superseded = [];
      let compared = 0;
      let walked = 0;
      for (let tag = from; tag <= to; tag++) {
        if (!applied.every((m) => m.has(tag))) continue;
        compared++;
        const values = applied.map((m) => m.get(tag));
        if (values[0] !== '0,0,0' && tag >= dropTag) walked++;
        const off = values.map((v, i) => i).filter((i) => values[i] !== values[0]);
        if (off.length === 0) continue;
        const row = { tag, ...Object.fromEntries(stayed.map(({ slot }, i) => [`P${slot + 1}`, values[i]])) };
        if (off.every((i) => applied[i].superseded(tag, applied[i].delay))) superseded.push(row);
        else differing.push(row);
      }
      return {
        slot: DROP_LINK_SLOT,
        at: DROP_LINK_AT,
        closed: dropLink.closed,
        walkFrom: dropLink.heldFrom,
        hostRanWalk: dropLink.hostRanWalk,
        resynced: dropLink.resynced,
        window: dropLinkWindow,
        keptCore: kept >= 0 ? hostLines[kept] : null,
        rolledBack: rolledBack.length,
        firstRollback: rolledBack[0] ?? null,
        pastWindow: pastWindow.length,
        settledSkips: settledSkips.slice(0, 5),
        applied: {
          tags: [from, to],
          compared,
          walkedTags: walked,
          differing: differing.slice(0, 40),
          differingCount: differing.length,
          supersededByHostState: superseded.slice(0, 40),
          supersededCount: superseded.length,
        },
      };
    })();
const dropLinkProblems = !dropLinkReport
  ? []
  : [
      ...(!dropLinkReport.closed?.closed
        ? [`the connection was not closed: ${JSON.stringify(dropLinkReport.closed)}`]
        : []),
      ...(!dropLinkReport.keptCore ? ["the host's reconnect reset did not keep the guest's C slot"] : []),
      ...(dropLinkReport.rolledBack === 0
        ? ['no real input of the guest after the reset was compared with a prediction and rolled back on the host']
        : []),
      ...(!dropLinkReport.resynced || !dropLinkWindow?.resyncSent || dropLinkWindow?.to == null
        ? ['the guest applied no resync after the reconnect']
        : []),
      ...(dropLinkReport.applied.compared < 200
        ? [`only ${dropLinkReport.applied.compared} tags of the guest's input compared`]
        : []),
      ...(dropLinkReport.applied.walkedTags === 0 ? ['no tag of the walk was compared'] : []),
      ...(dropLinkReport.applied.differingCount
        ? [
            `the host and a bystander applied different inputs for the guest on ${dropLinkReport.applied.differingCount} tags ` +
              `(first ${JSON.stringify(dropLinkReport.applied.differing[0])})`,
          ]
        : []),
      ...(pairs.find((p) => p.slot === DROP_LINK_SLOT)?.postRecoveryFramesCompared < MIN_BATTLE_FRAMES
        ? ["too few of the dropped guest's frames compared after its resync"]
        : []),
    ];
const summary = {
  dropLink: dropLinkReport ? { ...dropLinkReport, problems: dropLinkProblems } : undefined,
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
  removedInput: removedInput ? { ...removedInput, problems: removedInputProblems } : undefined,
  joinInput: joinInput ? { ...joinInput, problems: joinInputProblems } : undefined,
  room,
  players: PLAYERS,
  latencyMs: LAT,
  jitterMs: JITTER,
  linkKbps: LINK_KBPS,
  inBattleAt: P.map((x) => x.inBattleAt),
  lastFrame: P.map((x) => x.lastR),
  // Per page: the lag its hashes were read at (rollback window + 1), each
  // time its engine was armed, and the reads made before it was.
  hashLag: P.map((x) => ({
    lag: x.hashLag?.lag ?? null,
    inits: x.hashLag?.inits ?? [],
    ticksWithoutLag: x.ticksWithoutLag,
  })),
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
  dropLinkProblems.length > 0 ||
  missingProblems.length > 0 ||
  removedInputProblems.length > 0 ||
  joinInputProblems.length > 0 ||
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
    ? `FAIL: ${pairs.map((p) => `P${p.slot + 1} gp=${p.gameplayMismatches} gs=${p.gameStateMismatches} battle=${p.battleFramesCompared}`).join(', ')}${catchUpFailed ? (CATCH_UP_HOLE ? `; the hole fault did not land as required: ${JSON.stringify(holeReport)}` : '; the catch-up did not run all the way') : ''}${fighterProblems.length ? `; ${fighterProblems.join('; ')}` : ''}${recoveryProblems.length ? `; ${recoveryProblems.join('; ')}` : ''}${removedInputProblems.length ? `; ${removedInputProblems.join('; ')}` : ''}${joinInputProblems.length ? `; ${joinInputProblems.join('; ')}` : ''}${dropLinkProblems.length ? `; ${dropLinkProblems.join('; ')}` : ''}`
    : `PASS: all ${PLAYERS} fighters in the battle; every guest's hashes match the host's (${pairs.map((p) => `P${p.slot + 1} ${p.battleFramesCompared} battle frames`).join(', ')})`,
);
process.exit(failed ? 1 : 0);
