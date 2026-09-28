/**
 * Two-player rollback match against the real server, in two local browsers.
 *
 * What the website's multiplayer does, minus a second person: a host and a
 * guest each open play.html in their own browser context, load the ROM from
 * disk (no ROM sharing), and the host starts a rollback game. The SSB64 menu
 * autopilot drives P1 (host) and P2 (guest) to a VS battle, then both press
 * random inputs. Every outgoing DataChannel message is held for LAT ms (+ up
 * to JITTER ms, never reordering a channel) to stand in for a real network.
 *
 * Checks, printed as JSON and written to OUT/summary.json:
 *   - gameplay hash of every finalized frame (12 frames behind the head,
 *     past the rollback window) is identical on both peers
 *   - no failed rollbacks or integrity events (R2-R5 and fatal WASM traps
 *     in docs/netplay-invariants.md) in either peer's engine or sync log
 *   - no rollback input-stall timeouts below frame 300 on either peer
 *   - TICK-STUCK stalls, negotiated delay and rollback counts, for context
 * Exits 1 for gameplay divergence; rollback failure; integrity events; a match
 * that never reaches a battle; fewer than 80% of finalized battle frames
 * compared; or a boot input stall timeout.
 *
 *   just serve        # the real server on :27888, in another terminal
 *   KN_ROM=/path/ssb64-us.z64 [LAT=50] [JITTER=0] [BATTLE_SECONDS=60] [FREEZE_HOST_MS=0 | FREEZE_GUEST_MS=0] \
 *     [HEADED=1] [OUT=/tmp/two-player] node tests/rb-two-player.mjs
 *
 * Extra knobs, all off by default:
 *   HOST_BROWSER=webkit / GUEST_BROWSER=webkit   Run that page in Playwright
 *     WebKit instead of Chromium (each defaults to Chromium independently,
 *     so either or both can be WebKit; the Chromium default args —
 *     swiftshader software GL — apply to whichever side stays Chromium).
 *     When the two resolved engines differ (e.g. HOST_BROWSER=webkit with
 *     GUEST_BROWSER unset), the WASM core boots on different JIT engines,
 *     the guest legitimately diverges during boot and requests the host's
 *     state (`BOOT-SYNC: guest requesting host state`, then `sync #1
 *     applied`); frames before that applied sync are excluded from the hash
 *     compare, the same way FREEZE mode excludes frames before its last
 *     resync. When the two engines match (including WebKit on both sides),
 *     no such exclusion applies — boot-window frames are compared like any
 *     other, on the same basis as the Chromium/Chromium default. Chromium
 *     software (swiftshader) GL caps two co-located emulators well under
 *     60fps on some machines; WebKit on both sides can use the real GPU and
 *     is the closer match to the reported prod case (iOS Safari, which is
 *     WebKit).
 *   HIDE_GUEST_MS=<n>   Halfway through the battle, hide the guest tab the
 *     way a real backgrounded browser tab does: `document.hidden`/
 *     `visibilityState` flip to hidden (via a property override installed
 *     at context creation — real tab backgrounding can't be simulated from
 *     outside the page) and its setInterval-driven ticks are throttled to
 *     ~1Hz (reusing THROTTLE_GUEST's mechanism), matching the browser's own
 *     background-tab throttling. A `visibilitychange` event fires so
 *     `_visChangeHandler` in netplay-rollback.js runs its real bg-return
 *     path. After HIDE_GUEST_MS, both flip back and a `visibilitychange`
 *     fires again; the second half of the battle plays normally. Mutually
 *     exclusive with FREEZE_HOST_MS/FREEZE_GUEST_MS and THROTTLE_GUEST. No
 *     exclusion window applies (unlike FREEZE mode) — the normal hash
 *     compare and integrity checks cover the whole match, and the run also
 *     fails (exit 1) if either peer's sync log has any `TICK-STUCK
 *     severity=error`, `PEER-PHANTOM`, or `RB-INPUT-STALL-TIMEOUT` line
 *     (issue #64: a backgrounded guest used to desync the match). Counts
 *     reported under `hideGuest` in summary.json, alongside `hideGuestMs`.
 *   THROTTLE_GUEST=1   ~15s into the battle, cap the guest page's
 *     setInterval-driven tick callbacks to an average of THROTTLE_GUEST_HZ
 *     (env, default 30) callbacks/s — a plain JS wrapper around
 *     window.setInterval, installed via an init script, modeling a device
 *     whose timers drop to that rate (scheduling detail in
 *     throttleInitScript below). Forces the host into rollback bursts so
 *     replay-catch-up frames actually occur.
 *   MIN_GAME_FPS=<n>   Fail (exit 1) if either peer's measured game fps
 *     (frames advanced / wall seconds, from the last non-replay
 *     _kn_post_tick frame) drops below n, or is missing. The measurement
 *     window is from ~15s into the battle (when THROTTLE_GUEST flips the
 *     guest's cap) to the end of battle when THROTTLE_GUEST=1, else the
 *     whole battle. Reported as `gameFps: {host, guest}` in summary.json,
 *     alongside each peer's `pacing: {capsCount, capsFrames, summaries}` —
 *     capsCount is pacing episodes started and capsFrames is paced (held)
 *     tick calls, both summed from the unsampled per-300-frame `PACING
 *     f=...` lines in the window (the rate-limited `PACING-THROTTLE
 *     start/end` lines undercount episodes) — and each peer's cumulative
 *     `TICK-PERF` scheduler counters (`droppedSlots`, `catchupFrames` — see
 *     #47) under `schedulerCounters`: the session total as of the last
 *     TICK-PERF line, not scoped to this window.
 *   VISUAL_CHECK=1   On both peers, piggyback on the existing _kn_post_tick
 *     hook: whenever idle (no replay in flight) and in battle, downscale
 *     `#game canvas` into an offscreen 48x36 canvas and keep its RGB bytes.
 *     After the match, frames present on both peers at the same frame
 *     number are diffed pairwise: mean absolute difference over all RGB
 *     bytes of the 48x36 signature. Two very different things score above
 *     baseline here, and only one of them is a bug:
 *       - Held-frame / capture-timing noise. Headless replay intentionally
 *         holds the last presented frame during a rollback burst (see
 *         RB_FULL_HEADLESS_DURING_REPLAY in netplay-rollback.js), so a
 *         frame captured right at catch-up can legitimately show the
 *         pre-rollback picture on one peer (e.g. a character still on the
 *         respawn platform) while the other has already moved on. Not a
 *         bug — expected given two independently-timed captures.
 *       - GL-state corruption (#43): vanished stage geometry/fighters, a
 *         stray polygon.
 *     An independent census across old-core (buggy) and fixed-core runs
 *     found a clean gap between the two: held/timing noise topped out at
 *     30.8, corruption started at 40 and ran up to 74.3, with zero frames
 *     scoring 31-40. So frames > 40 are "corrupted" (this is what fails the
 *     run); frames > 15 but <= 40 are reported informationally as
 *     `heldOrTimingDiffs` and do not fail anything.
 *     Reported as `visualCheck: {framesCompared, corrupted,
 *     corruptedNearReplayEnd, firstCorrupted, heldOrTimingDiffs, maxDiff}`
 *     in summary.json. `corruptedNearReplayEnd` counts corrupted frames at
 *     or one past a `C-REPLAY done: caught up at f=N` line in the host's
 *     sync log. Exits 1 if any frame is corrupted when VISUAL_CHECK=1.
 *   CLICK_DURING_BATTLE=1   Reproduces #62 (clicking the UI during a
 *     rollback match desyncs peers). At ~1/3 and ~2/3 of BATTLE_SECONDS,
 *     on the host first and then the guest ~2s later, clicks through the
 *     toolbar "more" menu into the feedback form (`#toolbar-more` →
 *     `.kn-feedback-toolbar-item` → a `.kn-feedback-cat` button) and closes
 *     it with Escape — the exact click path that triggers the focus change
 *     that goes on to stale the captured Emscripten MainLoop runner (see
 *     docs/netplay-invariants.md §R2). Fire-and-forget via setTimeout so it
 *     doesn't block the battle-length wait or change BATTLE_SECONDS. Each
 *     round is logged. Before the #62 fix this makes the gameplay-hash
 *     compare below fail (hundreds of finalized gameplay-hash mismatches
 *     observed before the fix, 0 after); after the fix it should pass like
 *     a CLICK_DURING_BATTLE=0 run.
 *
 * Needs the SSB64 US ROM (the menu autopilot reads its RAM layout). Two
 * emulators headless on one machine run slowly and measure noisy RTTs, so
 * compare runs with each other; HEADED=1 on a real machine is closer to play.
 */
import { chromium, webkit } from 'playwright';
import fs from 'fs';

const URL = process.env.KN_URL || 'http://localhost:27888';
const ROM = process.env.KN_ROM;
const LAT = Number(process.env.LAT || 50); // one-way ms
const JITTER = Number(process.env.JITTER || 0);
const BATTLE_SECONDS = Number(process.env.BATTLE_SECONDS || 60);
// Block the host's (or guest's) main thread this long mid-battle (a frozen
// tab). The other side drops it as a phantom; when it returns, the guest
// must be resynced to the host.
const FREEZE_HOST_MS = Number(process.env.FREEZE_HOST_MS || 0);
const FREEZE_GUEST_MS = Number(process.env.FREEZE_GUEST_MS || 0);
const FREEZE_MS = FREEZE_HOST_MS || FREEZE_GUEST_MS;
const OUT = process.env.OUT || '/tmp/two-player';
const QUERY = process.env.KN_QUERY || '';
const HOST_BROWSER = process.env.HOST_BROWSER || 'chromium';
const GUEST_BROWSER = process.env.GUEST_BROWSER || 'chromium';
const THROTTLE_GUEST = process.env.THROTTLE_GUEST === '1';
const THROTTLE_GUEST_HZ = Number(process.env.THROTTLE_GUEST_HZ || 30);
const HIDE_GUEST_MS = Number(process.env.HIDE_GUEST_MS || 0);
const VISUAL_CHECK = process.env.VISUAL_CHECK === '1';
const MIN_GAME_FPS = process.env.MIN_GAME_FPS ? Number(process.env.MIN_GAME_FPS) : null;
const CLICK_DURING_BATTLE = process.env.CLICK_DURING_BATTLE === '1';

// Validate knobs before launching anything: a typo here should fail fast,
// not surface as a confusing result after minutes of gameplay.
for (const [name, value] of [
  ['HOST_BROWSER', HOST_BROWSER],
  ['GUEST_BROWSER', GUEST_BROWSER],
]) {
  if (value !== 'chromium' && value !== 'webkit') {
    console.log(`${name}=${value} invalid — must be exactly "chromium" or "webkit"`);
    process.exit(1);
  }
}
if (MIN_GAME_FPS !== null && !(Number.isFinite(MIN_GAME_FPS) && MIN_GAME_FPS > 0)) {
  console.log(`MIN_GAME_FPS=${process.env.MIN_GAME_FPS} invalid — must be a finite number > 0`);
  process.exit(1);
}
if (!Number.isFinite(THROTTLE_GUEST_HZ) || THROTTLE_GUEST_HZ <= 0) {
  console.log(`THROTTLE_GUEST_HZ=${process.env.THROTTLE_GUEST_HZ} invalid — must be a finite number > 0`);
  process.exit(1);
}
if (THROTTLE_GUEST && !(BATTLE_SECONDS > 15)) {
  console.log(`THROTTLE_GUEST=1 needs BATTLE_SECONDS > 15 (the throttle flips 15s in) — got ${BATTLE_SECONDS}`);
  process.exit(1);
}
if (!Number.isFinite(HIDE_GUEST_MS) || HIDE_GUEST_MS < 0) {
  console.log(`HIDE_GUEST_MS=${process.env.HIDE_GUEST_MS} invalid — must be a finite number >= 0`);
  process.exit(1);
}
if (HIDE_GUEST_MS > 0 && (FREEZE_MS > 0 || THROTTLE_GUEST)) {
  console.log('HIDE_GUEST_MS is mutually exclusive with FREEZE_HOST_MS/FREEZE_GUEST_MS and THROTTLE_GUEST');
  process.exit(1);
}
if (CLICK_DURING_BATTLE && !(BATTLE_SECONDS > 15)) {
  console.log(
    `CLICK_DURING_BATTLE=1 needs BATTLE_SECONDS > 15 (round 2 at 2/3 plus host click ~0.8s + 2s gap + guest click ~0.8s must finish before collect()) — got ${BATTLE_SECONDS}`,
  );
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
const room = 'TP' + Math.random().toString(36).slice(2, 8).toUpperCase();

const HEADLESS = process.env.HEADED !== '1';
// Chromium is forced onto swiftshader software GL (see the
// HOST_BROWSER/GUEST_BROWSER doc above). Both launchers are lazy and
// memoized to at most one instance each, so the default (both sides
// unset) shares a single Chromium instance and a WebKit/WebKit run never
// launches an unused Chromium.
let _chromiumBrowser = null;
const chromiumBrowser = async () =>
  (_chromiumBrowser ??= await chromium.launch({
    headless: HEADLESS,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  }));
let _webkitBrowser = null;
const webkitBrowser = async () => (_webkitBrowser ??= await webkit.launch({ headless: HEADLESS }));
const hostBrowser = HOST_BROWSER === 'webkit' ? await webkitBrowser() : await chromiumBrowser();
const guestBrowser = GUEST_BROWSER === 'webkit' ? await webkitBrowser() : await chromiumBrowser();

const initScript = ({ lat, jitter }) => {
  // Simulated network: delay every outgoing DataChannel message.
  // Jitter never reorders a channel: real SCTP data channels deliver in
  // order, and chunked transfers (compressed save states) rely on it. Each
  // channel drains one FIFO queue; a timer per message could reorder a burst,
  // because setTimeout truncates fractional delays.
  const orig = RTCDataChannel.prototype.send;
  const queues = new WeakMap();
  const pump = (ch, q) => {
    q.timer = null;
    while (q.items.length && q.items[0].at <= performance.now()) {
      const { data } = q.items.shift();
      try {
        if (ch.readyState === 'open') orig.call(ch, data);
      } catch (_) {}
    }
    if (q.items.length) q.timer = setTimeout(() => pump(ch, q), Math.max(0, q.items[0].at - performance.now()));
  };
  RTCDataChannel.prototype.send = function (data) {
    let q = queues.get(this);
    if (!q) queues.set(this, (q = { items: [], timer: null }));
    const last = q.items.length ? q.items[q.items.length - 1].at : 0;
    q.items.push({ data, at: Math.max(performance.now() + lat + (jitter ? Math.random() * jitter : 0), last) });
    if (!q.timer) q.timer = setTimeout(() => pump(this, q), Math.max(0, q.items[0].at - performance.now()));
  };
};

// Caps setInterval-driven callbacks to an average of `hz` calls/sec, once
// `window.__knThrottle` is flipped true. Before the flag flips every call
// passes through unchanged — this never speeds anything up.
//
// Fixed schedule, not a since-last-call gate: the engine's tick pump fires
// on a 6ms grid, so a since-last-call gate rounds gaps up to the next
// step — a 33ms gate delivers ~25Hz, not 30. Advancing a fixed `next` by
// `period` keeps the average exact regardless of which 6ms tick a call
// lands on, resetting after a long pause instead of bursting through it.
const throttleInitScript = (hz) => {
  window.__knThrottle = false;
  const period = 1000 / hz;
  const orig = window.setInterval;
  window.setInterval = function (fn, delay, ...args) {
    let next = 0;
    const wrapped = (...a) => {
      if (window.__knThrottle) {
        const now = performance.now();
        if (now < next) return;
        next = next + period > now ? next + period : now + period;
      }
      fn(...a);
    };
    return orig.call(window, wrapped, delay, ...args);
  };
};

// Overrides document.hidden/visibilityState to read from a page-global flag
// instead of the real (unbackgroundable, in a headless multi-context run)
// tab state. `_visChangeHandler` in netplay-rollback.js only consults these
// getters and listens for the `visibilitychange` event — both driven here —
// so this reproduces a real backgrounded tab from its point of view.
const hiddenInitScript = () => {
  window.__knHidden = false;
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => window.__knHidden });
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get: () => (window.__knHidden ? 'hidden' : 'visible'),
  });
};

const mkPage = async (browser, name, { throttleHz = 0, hidden = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.addInitScript(initScript, { lat: LAT, jitter: JITTER });
  if (throttleHz) await ctx.addInitScript(throttleInitScript, throttleHz);
  if (hidden) await ctx.addInitScript(hiddenInitScript);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror ${e.message}`));
  return page;
};

const host = await mkPage(hostBrowser, 'host');
const guest = await mkPage(guestBrowser, 'guest', {
  throttleHz: THROTTLE_GUEST ? THROTTLE_GUEST_HZ : HIDE_GUEST_MS ? 1 : 0,
  hidden: HIDE_GUEST_MS > 0,
});
await host.goto(`${URL}/play.html?room=${room}&host=1&name=Host&mode=rollback${QUERY}`);
await host.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
await guest.goto(`${URL}/play.html?room=${room}&name=Guest${QUERY}`);
await guest.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
for (const p of [host, guest]) await p.locator("#rom-drop input[type='file']").setInputFiles(ROM);
await host.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
console.log('room', room, 'both ROM-ready; starting');
await host.click('#start-btn');

// Dismiss the tap-to-start prompt on whichever page shows it.
const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  for (const p of [host, guest]) {
    const v = await p.locator('#gesture-prompt:not(.hidden)').count();
    if (v)
      await p
        .locator('#gesture-prompt')
        .click({ force: true })
        .catch(() => {});
  }
  // Also require EJS_emulator.gameManager.Module: on WebKit, currentFrame can
  // go truthy a tick before gameManager is attached (seen with
  // GUEST_BROWSER=webkit — install() below reads gameManager.Module and
  // threw `undefined is not an object`). Harmless extra check on Chromium.
  const ready = await Promise.all(
    [host, guest].map((p) =>
      p.evaluate(
        () => !!window.NetplayRollback?.getHudCounters?.()?.currentFrame && !!window.EJS_emulator?.gameManager?.Module,
      ),
    ),
  );
  if (ready[0] && ready[1]) break;
  await host.waitForTimeout(500);
}

// Autopilot + input hook + hash recorder, per page.
const install = async (p, role) => {
  await p.addScriptTag({ url: `${URL}/static/ssb64-menu-autopilot.js` });
  await p.evaluate(
    (args) => {
      const { role, VISUAL_CHECK } = args;
      const W = (window.__tp = {
        role,
        hashes: {},
        scene: -1,
        inBattleAt: -1,
        pilotFail: null,
        btnCool: 0,
        btnHeld: 0,
        visualFrames: [],
        fpsWindowStart: null,
      });
      let visCtx = null;
      if (VISUAL_CHECK) {
        const visCanvas = document.createElement('canvas');
        visCanvas.width = 48;
        visCanvas.height = 36;
        visCtx = visCanvas.getContext('2d', { willReadFrequently: true });
      }
      const rb = window.NetplayRollback;
      const frameNow = () => rb.getHudCounters?.()?.currentFrame ?? 0;
      // Marks the start of the game-fps measurement window: the node script
      // calls this either right when the battle begins (no THROTTLE_GUEST —
      // measure the whole battle) or when it flips the guest's setInterval
      // cap (THROTTLE_GUEST — measure only the throttled window). Frame
      // count is the last non-replay _kn_post_tick frame (W.lastR, set
      // below) — getHudCounters().currentFrame is rewound mid-replay.
      window.__tp.markFpsWindowStart = () => {
        W.fpsWindowStart = { f: W.lastR ?? frameNow(), t: performance.now() };
      };
      const pilot = window.KNMenuAutopilot.create({ read32: (a) => rb.readRdram32(a), log: (m) => (W.pilotFail = m) });
      const actor = role === 'host' ? pilot.p1 : pilot.p2;
      let held = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 },
        until = 0;
      const BTN = [0, 1, 6, 7]; // A, B, D-left, D-right (no START)
      const orig = window.KNShared.readLocalInput.bind(window.KNShared);
      window.KNShared.readLocalInput = (slot, keyMap, heldKeys) => {
        orig(slot, keyMap, heldKeys);
        const f = frameNow();
        const sc = (rb.readRdram32(0x800a4ad0) >>> 24) & 0xff;
        W.scene = sc;
        if (sc !== 22) {
          // Space button presses by the input delay so a press lands (and the
          // closed loop sees it) before the next one; sticks pass through.
          const d = (rb.getHudCounters?.()?.delay ?? 2) + 6;
          const inp = actor(f);
          if (inp.buttons) {
            if (W.btnCool > f && W.btnHeld !== inp.buttons) return { ...inp, buttons: 0 };
            W.btnHeld = inp.buttons;
            W.btnCool = f + d + 4;
          } else if (W.btnHeld) {
            W.btnHeld = 0;
            W.btnCool = f + d;
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
        // A sync rewind (frame goes down with no replay running) makes hashes
        // already recorded at or after the new frame stale; re-record them.
        if (idle && W.lastR !== undefined && r < W.lastR) {
          for (const k of Object.keys(W.hashes)) if (+k >= r - 12) delete W.hashes[k];
        }
        if (idle) W.lastR = r;
        if (idle && r > 40) {
          const f = r - 12;
          if (!(f in W.hashes))
            W.hashes[f] = [
              m._kn_gameplay_hash(f) >>> 0,
              m._kn_full_state_hash(f) >>> 0,
              (m._kn_game_state_hash?.(f) ?? 0) >>> 0,
            ];
        }
        if (VISUAL_CHECK && idle && W.inBattleAt >= 0 && r >= W.inBattleAt) {
          try {
            const src = document.querySelector('#game canvas');
            if (src && src.width > 0 && src.height > 0) {
              visCtx.drawImage(src, 0, 0, 48, 36);
              const d = visCtx.getImageData(0, 0, 48, 36).data;
              const rgb = new Uint8Array(48 * 36 * 3);
              for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
                rgb[j] = d[i];
                rgb[j + 1] = d[i + 1];
                rgb[j + 2] = d[i + 2];
              }
              W.visualFrames.push({ f: r, bytes: rgb });
            }
          } catch (_) {}
        }
        return r;
      };
    },
    { role, VISUAL_CHECK },
  );
};
await install(host, 'host');
await install(guest, 'guest');

// #62 repro: click through the toolbar "more" menu into the feedback form
// and back out. Fire-and-forget from setTimeout callers below — a click
// round throwing (e.g. a selector not present) is logged, not fatal, so it
// can't hang the battle-length wait.
const clickThroughFeedback = async (page, label) => {
  console.log(`CLICK_DURING_BATTLE: ${label} click round starting`);
  await page.click('#toolbar-more');
  await page.waitForTimeout(300);
  await page.click('.kn-feedback-toolbar-item');
  await page.waitForTimeout(500);
  await page.click('.kn-feedback-cat');
  await page.keyboard.press('Escape');
  console.log(`CLICK_DURING_BATTLE: ${label} click round done`);
};
const scheduleClickRound = (delayMs, roundLabel) => {
  setTimeout(() => {
    clickThroughFeedback(host, `${roundLabel} host`)
      .catch((e) => console.log(`CLICK_DURING_BATTLE: ${roundLabel} host round failed`, e.message))
      .then(() =>
        new Promise((r) => setTimeout(r, 2000)).then(() =>
          clickThroughFeedback(guest, `${roundLabel} guest`).catch((e) =>
            console.log(`CLICK_DURING_BATTLE: ${roundLabel} guest round failed`, e.message),
          ),
        ),
      );
  }, delayMs);
};

// Wait for the battle, then play.
const tb = Date.now();
const MENU_MS = Number(process.env.MENU_SECONDS || 600) * 1000;
let lastLog = 0;
let inBattle = false;
let throttleFlipped = null; // null until the 15s mark; then whether the flip Promise.all resolved or rejected
for (;;) {
  const s = await Promise.all(
    [host, guest].map((p) =>
      p.evaluate(() => ({
        f: window.NetplayRollback.getHudCounters().currentFrame,
        sc: window.__tp.scene,
        b: window.__tp.inBattleAt,
        fail: window.__tp.pilotFail,
      })),
    ),
  );
  if (Date.now() - lastLog > 15000) {
    console.log('menus', JSON.stringify(s));
    lastLog = Date.now();
  }
  if (s[0].b > 0 && s[1].b > 0) {
    inBattle = true;
    break;
  }
  if (s[0].fail || s[1].fail) {
    console.log('autopilot failed', s[0].fail, s[1].fail);
    break;
  }
  if (Date.now() - tb > MENU_MS) {
    console.log('MENUS TIMED OUT (peers desynced or autopilot stuck)');
    await host.screenshot({ path: `${OUT}/host-stuck.png` });
    break;
  }
  await host.waitForTimeout(1000);
}
if (inBattle) {
  console.log('in battle; playing', BATTLE_SECONDS, 's');
  if (THROTTLE_GUEST) {
    // Fire-and-forget: flips the guest's throttle flag ~15s into the
    // battle without blocking the battle-length wait below. Marks the
    // game-fps measurement window start on both peers at the same moment,
    // so gameFps is measured only over the throttled window (see
    // MIN_GAME_FPS in the header doc). Records success in throttleFlipped
    // so a failed flip fails the run below instead of silently comparing
    // an unthrottled guest against MIN_GAME_FPS.
    setTimeout(() => {
      Promise.all([
        guest.evaluate(() => {
          window.__knThrottle = true;
          window.__tp.markFpsWindowStart();
        }),
        host.evaluate(() => window.__tp.markFpsWindowStart()),
      ]).then(
        () => {
          throttleFlipped = true;
          console.log(`THROTTLE_GUEST: guest capped to ~${THROTTLE_GUEST_HZ}Hz; fps window started`);
        },
        (e) => {
          throttleFlipped = false;
          console.log('THROTTLE_GUEST: failed to flip flag/mark window', e.message);
        },
      );
    }, 15000);
  } else {
    // No throttle knob: measure game fps over the whole battle.
    await Promise.all([
      host.evaluate(() => window.__tp.markFpsWindowStart()),
      guest.evaluate(() => window.__tp.markFpsWindowStart()),
    ]);
  }
  if (CLICK_DURING_BATTLE) {
    // #62 repro: two click rounds (host, then guest ~2s later), fired via
    // setTimeout so they don't block the battle-length wait below and don't
    // change BATTLE_SECONDS.
    scheduleClickRound((BATTLE_SECONDS * 1000) / 3, 'round 1');
    scheduleClickRound((BATTLE_SECONDS * 1000 * 2) / 3, 'round 2');
  }
  if (FREEZE_MS > 0) {
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
    const frozen = FREEZE_HOST_MS > 0 ? host : guest;
    console.log('freezing', FREEZE_HOST_MS > 0 ? 'host' : 'guest', 'for', FREEZE_MS, 'ms');
    await frozen.evaluate((ms) => {
      const t = performance.now();
      while (performance.now() - t < ms);
    }, FREEZE_MS);
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
  } else if (HIDE_GUEST_MS > 0) {
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
    console.log('hiding guest tab for', HIDE_GUEST_MS, 'ms');
    await guest.evaluate(() => {
      window.__knHidden = true;
      window.__knThrottle = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await host.waitForTimeout(HIDE_GUEST_MS);
    await guest.evaluate(() => {
      window.__knHidden = false;
      window.__knThrottle = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    console.log('guest tab shown again');
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
  } else {
    await host.waitForTimeout(BATTLE_SECONDS * 1000);
  }
}

const collect = (p, VISUAL_CHECK) =>
  p.evaluate((VISUAL_CHECK) => {
    const fpsWindowEnd = {
      f: window.__tp.lastR ?? window.NetplayRollback.getHudCounters().currentFrame,
      t: performance.now(),
    };
    const m = window.EJS_emulator.gameManager.Module;
    let visual = null;
    if (VISUAL_CHECK) {
      const frames = window.__tp.visualFrames;
      const frameBytes = 48 * 36 * 3;
      const buf = new Uint8Array(frames.length * frameBytes);
      let off = 0;
      for (const x of frames) {
        buf.set(x.bytes, off);
        off += frameBytes;
      }
      // base64-encode in chunks: String.fromCharCode.apply chokes on huge arrays.
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      visual = { frames: frames.map((x) => x.f), frameBytes, b64: btoa(bin) };
    }
    return {
      hashes: window.__tp.hashes,
      inBattleAt: window.__tp.inBattleAt,
      frame: window.NetplayRollback.getHudCounters().currentFrame,
      fpsWindowStart: window.__tp.fpsWindowStart,
      fpsWindowEnd,
      clog: m.UTF8ToString(m._kn_get_debug_log()),
      sync: window.NetplayRollback.exportSyncLog?.() || '',
      rollbacks: m._kn_get_rollback_count?.(),
      failed: m._kn_get_failed_rollbacks?.(),
      visual,
    };
  }, VISUAL_CHECK);
const [H, G] = await Promise.all([collect(host, VISUAL_CHECK), collect(guest, VISUAL_CHECK)]);
await host.screenshot({ path: `${OUT}/host.png` });
await guest.screenshot({ path: `${OUT}/guest.png` });
fs.writeFileSync(`${OUT}/host-clog.txt`, H.clog);
fs.writeFileSync(`${OUT}/guest-clog.txt`, G.clog);
fs.writeFileSync(`${OUT}/host-sync.txt`, H.sync);
fs.writeFileSync(`${OUT}/guest-sync.txt`, G.sync);

// Freeze mode: peers legitimately diverge while the host is a phantom, so
// only frames from the guest's last applied resync onward must match.
// Cross-engine boot (see HOST_BROWSER/GUEST_BROWSER doc above): frames
// before the guest's applied BOOT-SYNC are excluded the same way — never
// widen this to a same-engine run, where a boot-window mismatch is real.
const crossEngine = hostBrowser !== guestBrowser;
const resyncs = [...G.sync.matchAll(/sync #\d+ applied \(frame \d+ -> (\d+)/g)].map((m) => +m[1]);
const bootSyncFrame = crossEngine && resyncs.length ? resyncs[0] : 0;
const recoveredAt = FREEZE_MS > 0 ? (resyncs.length ? resyncs[resyncs.length - 1] : Infinity) : bootSyncFrame;
let both = 0,
  gpMis = 0,
  fullMis = 0,
  firstGp = null,
  firstFull = null,
  battleCompared = 0,
  gsMis = 0,
  firstGs = null;
const battleFrom = Math.max(H.inBattleAt, G.inBattleAt);
for (const f of Object.keys(H.hashes)) {
  const a = H.hashes[f],
    b = G.hashes[f];
  if (!b || !a[0] || !b[0] || +f < recoveredAt) continue;
  both++;
  if (battleFrom > 0 && +f >= Math.max(battleFrom, recoveredAt)) battleCompared++;
  if (a[0] !== b[0]) {
    gpMis++;
    if (firstGp === null) firstGp = +f;
  }
  if (a[1] !== b[1]) {
    fullMis++;
    if (firstFull === null) firstFull = +f;
  }
  if (a[2] !== b[2]) {
    gsMis++;
    if (firstGs === null) firstGs = +f;
  }
}
const count = (log, re) => (log.match(re) || []).length;
const bootInputStallTimeoutsOf = (log) =>
  [...log.matchAll(/RB-INPUT-STALL-TIMEOUT f=(\d+)/g)].filter(([, frame]) => +frame < 300).length;
const INTEGRITY =
  /REPLAY-NORUN|RB-INVARIANT-VIOLATION|FATAL-RING-STALE|RB-LIVE-MISMATCH|STEP-THREW|FATAL-CORE-ABORT|FAILED-ROLLBACK|DEEP-MISPREDICT-SKIP|RESTORE-FAILED/g;
const bad = (log) => count(log, INTEGRITY);
const delayOf = (log) => (log.match(/kn_rollback_init: max=\d+ delay=(\d+)/) || [])[1]; // what the engine uses

// HIDE_GUEST_MS mode (issue #64): unlike FREEZE mode, there is no exclusion
// window — a backgrounded-then-returned guest must never desync the match,
// so any of these events anywhere in either peer's sync log is a failure.
const tickStuckErrorsOf = (log) => count(log, /TICK-STUCK severity=error/g);
const peerPhantomsOf = (log) => count(log, /PEER-PHANTOM/g);
const rbInputStallTimeoutsOf = (log) => count(log, /RB-INPUT-STALL-TIMEOUT/g);
// The run must actually exercise the fix, not just avoid tripping on a
// no-op path: the guest's sync log must show it went through the real
// bg-return handler ("tab visible (was background") and that
// _requestLifecycleFullResync took the in-step skip ("rollback in step").
// Their absence means the hide/throttle/visibilitychange plumbing didn't
// reach netplay-rollback.js, and a pass wouldn't mean anything.
const guestExercisedTabVisible = (log) => log.includes('tab visible (was background');
const guestExercisedRollbackInStep = (log) => log.includes('rollback in step');

// Game fps over the measurement window (see MIN_GAME_FPS doc above): frames
// advanced (last non-replay _kn_post_tick frame) / wall seconds, per peer.
const gameFpsOf = (peer) => {
  const start = peer.fpsWindowStart;
  const end = peer.fpsWindowEnd;
  if (!start || !end || end.t <= start.t) return null;
  return +(((end.f - start.f) * 1000) / (end.t - start.t)).toFixed(1);
};
const gameFps = { host: gameFpsOf(H), guest: gameFpsOf(G) };

// Pacing episodes within the measurement window, from the unsampled
// per-300-frame `PACING f=...` summary lines (#47) in each peer's own sync
// log (t is that page's performance.now(), same clock as fpsWindowStart) —
// not the `PACING-THROTTLE start/end` lines, which are rate-limited to 1/s
// and so miss most episodes on a busy peer. Each summary line's
// capsCount/capsFrames cover the 300 frames preceding it.
const pacingInWindow = (peer) => {
  const start = peer.fpsWindowStart;
  if (!start) return null;
  const lines = peer.sync.split('\n').filter((l) => {
    if (!l.includes('PACING f=')) return false;
    const t = parseFloat(l.split('\t')[1]);
    return Number.isFinite(t) && t >= start.t;
  });
  let capsCount = 0,
    capsFrames = 0;
  for (const l of lines) {
    const m = l.match(/capsCount=(\d+) capsFrames=(\d+)/);
    if (m) {
      capsCount += +m[1];
      capsFrames += +m[2];
    }
  }
  return { capsCount, capsFrames, summaries: lines.length };
};
const pacing = { host: pacingInWindow(H), guest: pacingInWindow(G) };

// Cumulative scheduler counters from the last TICK-PERF line (#47):
// droppedSlots (backlog drops) and catchupFrames (extra forward frames run
// to catch up a throttled pump) — never reset, so this is the session
// total, not scoped to the fps window.
const lastTickPerf = (log) => {
  const matches = [...log.matchAll(/TICK-PERF f=(\d+).*?droppedSlots=(\d+) catchupFrames=(\d+)/g)];
  if (!matches.length) return null;
  const m = matches[matches.length - 1];
  return { f: +m[1], droppedSlots: +m[2], catchupFrames: +m[3] };
};
const schedulerCounters = { host: lastTickPerf(H.sync), guest: lastTickPerf(G.sync) };
// Finalized battle frames both peers could have hashed (hashing trails the
// head by 12 frames); coverage below 80% means the comparison proves little.
const spanFrom = Math.max(battleFrom, recoveredAt);
const battleSpan = battleFrom > 0 ? Math.min(H.frame, G.frame) - 12 - spanFrom + 1 : 0;
const battleCoverage = battleSpan > 0 ? Math.min(1, battleCompared / battleSpan) : 0;

// Visual check: decode both peers' downscaled canvas captures and diff
// frames present on both sides at the same frame number — mean absolute
// difference over all RGB bytes of the 48x36 signature (sum(|h[i]-g[i]|)
// over all 5184 bytes, divided by 5184). Baseline (matching render) is a
// few points; noise up to the low 30s is expected and not a bug: headless
// replay intentionally holds the last presented frame during a rollback
// (see RB_FULL_HEADLESS_DURING_REPLAY in netplay-rollback.js), so a frame
// captured right at catch-up can legitimately show the pre-rollback picture
// on one peer (e.g. a character still on the respawn platform) while the
// other has already moved on — a held-frame/capture-timing difference, not
// corruption. An independent census across old-core and fixed-core runs
// found a clean gap: held/timing noise topped out at 30.8, corruption (the
// #43 GLSM-state bug — vanished stage geometry/fighters, a stray polygon)
// started at 40 and ran up to 74.3, with zero frames in between (31-40).
// 40 is therefore the corruption cutoff; frames above 15 but at or below 40
// are reported informationally (heldOrTimingDiffs) and do not fail the run.
let visualCheck = null;
if (VISUAL_CHECK) {
  const decode = (v) => {
    const map = new Map();
    if (!v) return map;
    const buf = Buffer.from(v.b64, 'base64');
    let off = 0;
    for (const f of v.frames) {
      map.set(f, buf.subarray(off, off + v.frameBytes));
      off += v.frameBytes;
    }
    return map;
  };
  const hMap = decode(H.visual),
    gMap = decode(G.visual);
  const replayEndFrames = new Set();
  for (const m of H.sync.matchAll(/C-REPLAY done: caught up at f=(\d+)/g)) {
    const n = +m[1];
    replayEndFrames.add(n);
    replayEndFrames.add(n + 1);
  }
  const CORRUPT_THRESHOLD = 40;
  const HELD_OR_TIMING_THRESHOLD = 15;
  let framesCompared = 0,
    corrupted = 0,
    corruptedNearReplayEnd = 0,
    firstCorrupted = null,
    heldOrTimingDiffs = 0,
    maxDiff = 0;
  for (const [f, hb] of hMap) {
    const gb = gMap.get(f);
    if (!gb || f < recoveredAt) continue;
    framesCompared++;
    let sum = 0;
    for (let i = 0; i < hb.length; i++) sum += Math.abs(hb[i] - gb[i]);
    const mean = sum / hb.length;
    if (mean > maxDiff) maxDiff = mean;
    if (mean > CORRUPT_THRESHOLD) {
      corrupted++;
      if (firstCorrupted === null) firstCorrupted = f;
      if (replayEndFrames.has(f)) corruptedNearReplayEnd++;
    } else if (mean > HELD_OR_TIMING_THRESHOLD) {
      heldOrTimingDiffs++;
    }
  }
  visualCheck = {
    framesCompared,
    corrupted,
    corruptedNearReplayEnd,
    firstCorrupted,
    heldOrTimingDiffs,
    maxDiff: +maxDiff.toFixed(2),
  };
}

const summary = {
  room,
  latencyMs: LAT,
  jitterMs: JITTER,
  ...(FREEZE_MS > 0
    ? { freezeHostMs: FREEZE_HOST_MS, freezeGuestMs: FREEZE_GUEST_MS, guestResyncs: resyncs, comparedFrom: recoveredAt }
    : {}),
  ...(HOST_BROWSER !== 'chromium' || GUEST_BROWSER !== 'chromium'
    ? { hostBrowser: HOST_BROWSER, guestBrowser: GUEST_BROWSER, crossEngine, ...(crossEngine ? { bootSyncFrame } : {}) }
    : {}),
  ...(THROTTLE_GUEST ? { throttleGuest: true, throttleGuestHz: THROTTLE_GUEST_HZ, throttleFlipped } : {}),
  ...(HIDE_GUEST_MS > 0
    ? {
        hideGuest: {
          hideGuestMs: HIDE_GUEST_MS,
          tickStuckErrors: { host: tickStuckErrorsOf(H.sync), guest: tickStuckErrorsOf(G.sync) },
          peerPhantoms: { host: peerPhantomsOf(H.sync), guest: peerPhantomsOf(G.sync) },
          rbInputStallTimeouts: { host: rbInputStallTimeoutsOf(H.sync), guest: rbInputStallTimeoutsOf(G.sync) },
          guestExercisedTabVisible: guestExercisedTabVisible(G.sync),
          guestExercisedRollbackInStep: guestExercisedRollbackInStep(G.sync),
        },
      }
    : {}),
  ...(CLICK_DURING_BATTLE ? { clickDuringBattle: true } : {}),
  ...(MIN_GAME_FPS !== null ? { minGameFps: MIN_GAME_FPS } : {}),
  gameFps,
  pacing,
  schedulerCounters,
  frames: { host: H.frame, guest: G.frame, battleStart: [H.inBattleAt, G.inBattleAt] },
  rollbacks: { host: H.rollbacks, guest: G.rollbacks },
  failedRollbacks: { host: H.failed, guest: G.failed },
  engineDelay: { host: delayOf(H.sync), guest: delayOf(G.sync) },
  integrityEvents: { host: bad(H.clog) + bad(H.sync), guest: bad(G.clog) + bad(G.sync) },
  bootInputStallTimeouts: { host: bootInputStallTimeoutsOf(H.sync), guest: bootInputStallTimeoutsOf(G.sync) },
  tickStuck: { host: count(H.sync, /TICK-STUCK/g), guest: count(G.sync, /TICK-STUCK/g) },
  hashCompare: {
    framesCompared: both,
    battleFramesCompared: battleCompared,
    battleCoverage: +battleCoverage.toFixed(3),
    gameplayMismatches: gpMis,
    firstGameplayMismatch: firstGp,
    gameStateMismatches: gsMis,
    firstGameStateMismatch: firstGs,
    fullStateMismatches: fullMis,
    firstFullMismatch: firstFull,
  },
  ...(VISUAL_CHECK ? { visualCheck } : {}),
};
fs.writeFileSync(`${OUT}/hashes.json`, JSON.stringify({ H: H.hashes, G: G.hashes }));
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
// Close each distinct browser instance once (host and guest may share one,
// e.g. the Chromium/Chromium default, or both resolve to the one WebKit
// instance with HOST_BROWSER=webkit GUEST_BROWSER=webkit).
for (const b of new Set([hostBrowser, guestBrowser])) await b.close();
// A freeze makes deep mispredictions and skipped rollbacks expected before
// the resync; what must hold is that the resync happened, fixed it, and held:
// no integrity events once recovery settled (each peer's lines after its last
// recovery marker, 30+ frames past the resync; late pre-resync inputs can
// still land just after it), and a meaningful window of matching frames.
const POST_RECOVERY_MIN_FRAMES = 120;
const integrityAfterRecovery = (log, marker) => {
  const lines = log.split('\n');
  let from = -1;
  lines.forEach((l, i) => {
    if (marker.test(l)) from = i;
  });
  return from < 0
    ? 0
    : lines.slice(from + 1).filter((l) => {
        const f = +(l.split('\t')[2] || '').replace('f=', '');
        return f >= recoveredAt + 30 && count(l, INTEGRITY) > 0;
      }).length;
};
// The C debug log has no frame column; its entries name the frame they
// concern (f= / myF=). The guest's last `kn_set_frame:` is its resync; the
// host never rewinds, so its frames alone place an entry.
const cIntegrityAfterRecovery = (clog, marker) => {
  const lines = clog.split('\n');
  let from = -1;
  if (marker)
    lines.forEach((l, i) => {
      if (marker.test(l)) from = i;
    });
  return lines.slice(from + 1).filter((l) => {
    if (count(l, INTEGRITY) === 0) return false;
    const m = l.match(/myF=(\d+)/) || l.match(/\bf=(\d+)/);
    return !m || +m[1] >= recoveredAt + 30;
  }).length;
};
const postRecoveryIntegrity =
  FREEZE_MS > 0
    ? integrityAfterRecovery(H.sync, /coord sync dispatch/) +
      integrityAfterRecovery(G.sync, /sync #\d+ applied/) +
      cIntegrityAfterRecovery(H.clog, null) +
      cIntegrityAfterRecovery(G.clog, /kn_set_frame: \d+/)
    : 0;
if (FREEZE_MS > 0)
  console.log('post-recovery integrity events:', postRecoveryIntegrity, 'battle frames compared:', battleCompared);
const integrityFailed =
  FREEZE_MS > 0
    ? !Number.isFinite(recoveredAt) || postRecoveryIntegrity > 0 || battleCompared < POST_RECOVERY_MIN_FRAMES
    : (H.failed || 0) + (G.failed || 0) > 0 || summary.integrityEvents.host + summary.integrityEvents.guest > 0;
const minGameFpsFailed = MIN_GAME_FPS !== null && (!(gameFps.host >= MIN_GAME_FPS) || !(gameFps.guest >= MIN_GAME_FPS));
if (minGameFpsFailed) {
  console.log(`MIN_GAME_FPS=${MIN_GAME_FPS} not met:`, JSON.stringify(gameFps));
}
const hideGuestFailed =
  HIDE_GUEST_MS > 0 &&
  (summary.hideGuest.tickStuckErrors.host > 0 ||
    summary.hideGuest.tickStuckErrors.guest > 0 ||
    summary.hideGuest.peerPhantoms.host > 0 ||
    summary.hideGuest.peerPhantoms.guest > 0 ||
    summary.hideGuest.rbInputStallTimeouts.host > 0 ||
    summary.hideGuest.rbInputStallTimeouts.guest > 0 ||
    !summary.hideGuest.guestExercisedTabVisible ||
    !summary.hideGuest.guestExercisedRollbackInStep);
if (hideGuestFailed) {
  console.log('HIDE_GUEST_MS: desync-indicating events or unexercised fix path:', JSON.stringify(summary.hideGuest));
}
const failed =
  gpMis > 0 ||
  gsMis > 0 ||
  summary.bootInputStallTimeouts.host > 0 ||
  summary.bootInputStallTimeouts.guest > 0 ||
  integrityFailed ||
  H.inBattleAt < 0 ||
  G.inBattleAt < 0 ||
  battleCoverage < 0.8 ||
  (VISUAL_CHECK && visualCheck.corrupted > 0) ||
  minGameFpsFailed ||
  (THROTTLE_GUEST && !throttleFlipped) ||
  hideGuestFailed;
process.exit(failed ? 1 : 0);
