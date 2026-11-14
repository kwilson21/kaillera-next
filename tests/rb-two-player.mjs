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
 *     path (while the C rollback engine is active, returning does no
 *     fast-forward or resync). After HIDE_GUEST_MS, both flip back and a
 *     `visibilitychange` fires again; the second half of the battle plays
 *     normally. Mutually exclusive with FREEZE_HOST_MS/FREEZE_GUEST_MS and
 *     THROTTLE_GUEST. No exclusion window applies (unlike FREEZE mode) — the
 *     normal hash compare and integrity checks cover the whole match, and
 *     the run also fails (exit 1) if either peer's sync log has any
 *     `TICK-STUCK severity=error`, `PEER-PHANTOM`, or `RB-INPUT-STALL-TIMEOUT`
 *     line (issue #64: a backgrounded guest used to desync the match), or if
 *     the guest's log doesn't show the bg-return path ran. Counts reported
 *     under `hideGuest` in summary.json, alongside `hideGuestMs`.
 *   HIDE_GUEST_FROZEN=1   With HIDE_GUEST_MS, model a frozen tab instead
 *     (iOS backgrounding, bfcache: no JS at all while hidden): one
 *     synchronous evaluate hides the tab, blocks the guest's main thread for
 *     HIDE_GUEST_MS and shows it again, so `visibilitychange` fires on thaw
 *     before the packets queued during the freeze are processed. No ~1Hz
 *     throttle. Same pass/fail rules. A freeze of 5s or more lets the host
 *     phantom the guest (RB-INPUT-STALL-TIMEOUT), which fails the run;
 *     recovering from that is issue #69 item 3.
 *     Example: `HIDE_GUEST_MS=4000 HIDE_GUEST_FROZEN=1 JITTER=20`.
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
 *   SUSPEND_GUEST_AUDIO=1   Guest context only: models Safari leaving the
 *     core's own AudioContext not running and refusing a resume without a
 *     gesture (#63 root cause). See suspendAudioInitScript below. The fix
 *     (stand-in audio clock) should recover boot without a second tap —
 *     the run fails if the guest needs more than one prompt click to boot.
 *   CLICK_DURING_BATTLE=1   Reproduces #62 (clicking the UI during a
 *     rollback match desyncs peers). At ~1/3 and ~2/3 of BATTLE_SECONDS,
 *     on the host first and then the guest ~2s later, clicks through the
 *     toolbar "more" menu into the feedback form (`#toolbar-more` →
 *     `.kn-feedback-toolbar-item` → a `.kn-feedback-cat` button) and closes
 *     it via `.kn-feedback-close` — the exact click path whose own
 *     `requestAnimationFrame` call (feedback.js's `_openModal`) used to
 *     hijack rollback's rAF interceptor and strand the captured Emscripten
 *     runner, per the measured #62 signature (no runner rescheduled, CP0
 *     Count unchanged) (see docs/netplay-invariants.md §R2).
 *     Fire-and-forget via setTimeout so it doesn't block the
 *     battle-length wait or change BATTLE_SECONDS.
 *     Each round is logged. Before the #62 fix this makes the
 *     gameplay-hash compare below fail (hundreds of finalized
 *     gameplay-hash mismatches observed before the fix, 0 after); after
 *     the fix it should pass like a CLICK_DURING_BATTLE=0 run.
 *   DROP_SIGNALING_MS=<n>   A third of the way into the battle, cut both
 *     pages' Socket.IO WebSocket and refuse reconnects for n ms, the way a
 *     server restart or a network drop does; the match itself runs over
 *     WebRTC and must carry on. Pick n long enough to span a 300-frame mesh
 *     health check at the frame rate this machine manages (40000 in the cloud
 *     container). The outage starts a third of the way in, so two thirds of
 *     BATTLE_SECONDS must cover n plus 20 s to reconnect. On top of the normal
 *     checks the run fails if either page: never reconnected; logged any
 *     TICK-STUCK or INPUT-STALL; or had its lifecycle machine report
 *     session-disagree or late-join-stranded (web/src/session.ts). This does
 *     not cover the host stalling on its own slot (2026-11-09): that lives in
 *     the lockstep path a solo game takes, see solo-signaling-drop.mjs.
 *   DROP_SIGNALING_GUEST_LATE_MS=<n>   With DROP_SIGNALING_MS: keep the
 *     guest's signaling down up to n ms longer than the host's, until the
 *     host has rejoined and seen a room without the guest. The guest then
 *     rejoins under a new socket id, and the host must keep the live WebRTC
 *     connection rather than evict it as a stale peer. The run fails if the
 *     host has not seen that roster within n ms. BATTLE_SECONDS must cover
 *     this too.
 *
 *   DESYNC_GUEST=1   The one knob that makes the match unhealthy on purpose:
 *     halfway through the battle the guest's copy of P1's stock count
 *     (SCPlayerData.stock_count, one byte of RDRAM) is changed and held for
 *     3 s, long enough that no rollback restores it. The peers are then
 *     really desynced, and the desync detector (kn-desync-detector.js) must
 *     say so: the run passes only if both peers' sync logs have a
 *     `KNDesync suspect ... field=stocks slot=0 trigger=flag` line after the
 *     change, and none before it; both peers log `KNDesync capture` for the
 *     first flagged frame at the same frame number (their screenshots are
 *     compared with each other); and the gameplay hash (kn_gameplay_hash,
 *     which lists SSB64's stock counts) differs on at least one frame from
 *     the change on, where the map's stock address is the one it lists, and
 *     on none before it. The
 *     game-state and full-state hashes are reported but not judged: the
 *     stock counts sit in an RDRAM block kn_game_state_hash leaves out as
 *     tainted, and kn_full_state_hash samples one byte in 64.
 *     Reported as `desyncGuest` in summary.json. Mutually exclusive with the
 *     other knobs. This is the detector's positive test; every other run
 *     only shows that it stays quiet.
 *
 *   ADDRESS_MAP_CHECK=1   Checks the desync detector's address map for the
 *     ROM (web/src/address-maps.ts) against the running game: every 30
 *     frames each page reads the map's fields from RAM, and after the match
 *     the run fails unless, on both peers: the scene byte read the
 *     character select and then the battle; both players' character ids at
 *     the character select are fighter kinds (and, without
 *     MENU_AUTOPILOT=any-fighter, the two the autopilot picks); the battle
 *     header's status says the match gets under way and stays so; stock counts
 *     in battle are plausible; the battle header is not empty; the RNG seed
 *     moves; and the fighter-buffer pointer, once set, points into RAM. Reported as
 *     `addressMapCheck` in summary.json. This shows a map is plausible, not
 *     that it is right: see docs/address-maps.md for the rest.
 *   ADDRESS_MAP_OF=<rom hash>   Try the map of another ROM on this one (a
 *     candidate map for a ROM that has none yet): the pages run the
 *     detector with it (?desync=force&desyncMap=) and ADDRESS_MAP_CHECK
 *     reads through it.
 *   MENU_AUTOPILOT=any-fighter   The autopilot takes whatever fighter its
 *     puck lands on and the stage the cursor starts on, for a ROM whose
 *     menus are laid out differently from SSB64's (Smash Remix).
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
const HOST_BROWSER = process.env.HOST_BROWSER || 'chromium';
const GUEST_BROWSER = process.env.GUEST_BROWSER || 'chromium';
const THROTTLE_GUEST = process.env.THROTTLE_GUEST === '1';
const THROTTLE_GUEST_HZ = Number(process.env.THROTTLE_GUEST_HZ || 30);
const HIDE_GUEST_MS = Number(process.env.HIDE_GUEST_MS || 0);
const DROP_SIGNALING_MS = Number(process.env.DROP_SIGNALING_MS || 0);
const DROP_SIGNALING_GUEST_LATE_MS = Number(process.env.DROP_SIGNALING_GUEST_LATE_MS || 0);
const HIDE_GUEST_FROZEN = process.env.HIDE_GUEST_FROZEN === '1';
const VISUAL_CHECK = process.env.VISUAL_CHECK === '1';
const MIN_GAME_FPS = process.env.MIN_GAME_FPS ? Number(process.env.MIN_GAME_FPS) : null;
const SUSPEND_GUEST_AUDIO = process.env.SUSPEND_GUEST_AUDIO === '1';
const CLICK_DURING_BATTLE = process.env.CLICK_DURING_BATTLE === '1';
const DESYNC_GUEST = process.env.DESYNC_GUEST === '1';
const ADDRESS_MAP_CHECK = process.env.ADDRESS_MAP_CHECK === '1';
const ADDRESS_MAP_OF = process.env.ADDRESS_MAP_OF || '';
const MENU_AUTOPILOT = process.env.MENU_AUTOPILOT || '';
if (MENU_AUTOPILOT && MENU_AUTOPILOT !== 'any-fighter') {
  console.log(`MENU_AUTOPILOT=${MENU_AUTOPILOT} invalid: the only value is "any-fighter"`);
  process.exit(1);
}
if (ADDRESS_MAP_OF && !/^S[0-9a-f]{64}$/.test(ADDRESS_MAP_OF)) {
  console.log('ADDRESS_MAP_OF must be a ROM hash: S followed by 64 hex digits');
  process.exit(1);
}
// Appended to both pages' URLs as it stands, so it starts with `&`.
const QUERY = (process.env.KN_QUERY || '') + (ADDRESS_MAP_OF ? `&desync=force&desyncMap=${ADDRESS_MAP_OF}` : '');

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
if (HIDE_GUEST_FROZEN && !(HIDE_GUEST_MS > 0)) {
  console.log('HIDE_GUEST_FROZEN=1 needs HIDE_GUEST_MS > 0');
  process.exit(1);
}
if (!(Number.isFinite(DROP_SIGNALING_MS) && DROP_SIGNALING_MS >= 0)) {
  console.log(`DROP_SIGNALING_MS=${process.env.DROP_SIGNALING_MS} invalid — must be a finite number >= 0`);
  process.exit(1);
}
if (DROP_SIGNALING_MS > 0 && (FREEZE_MS > 0 || THROTTLE_GUEST || HIDE_GUEST_MS > 0 || CLICK_DURING_BATTLE)) {
  console.log('DROP_SIGNALING_MS is mutually exclusive with the FREEZE, THROTTLE, HIDE and CLICK knobs');
  process.exit(1);
}
if (
  DESYNC_GUEST &&
  (FREEZE_MS > 0 ||
    THROTTLE_GUEST ||
    HIDE_GUEST_MS > 0 ||
    CLICK_DURING_BATTLE ||
    DROP_SIGNALING_MS > 0 ||
    VISUAL_CHECK ||
    MIN_GAME_FPS !== null ||
    SUSPEND_GUEST_AUDIO ||
    ADDRESS_MAP_CHECK)
) {
  console.log('DESYNC_GUEST is mutually exclusive with the other knobs');
  process.exit(1);
}
// The outage starts a third of the way in, so it and the reconnect that
// follows must fit in the remaining two thirds.
const DROP_SIGNALING_RECONNECT_MS = 20000;
const DROP_SIGNALING_RECONNECT_WAIT_MS = 60000;
if (!(Number.isFinite(DROP_SIGNALING_GUEST_LATE_MS) && DROP_SIGNALING_GUEST_LATE_MS >= 0)) {
  console.log(`DROP_SIGNALING_GUEST_LATE_MS=${process.env.DROP_SIGNALING_GUEST_LATE_MS} invalid — must be >= 0`);
  process.exit(1);
}
if (DROP_SIGNALING_GUEST_LATE_MS > 0 && !(DROP_SIGNALING_MS > 0)) {
  console.log('DROP_SIGNALING_GUEST_LATE_MS only applies with DROP_SIGNALING_MS');
  process.exit(1);
}
const dropSignalingNeedsSeconds = Math.ceil(
  ((DROP_SIGNALING_MS + DROP_SIGNALING_GUEST_LATE_MS + DROP_SIGNALING_RECONNECT_MS) * 3) / 2 / 1000,
);
if (DROP_SIGNALING_MS > 0 && !(BATTLE_SECONDS >= dropSignalingNeedsSeconds)) {
  console.log(`this signaling outage needs BATTLE_SECONDS >= ${dropSignalingNeedsSeconds}`);
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

// Models Safari leaving the core's own OpenAL AudioContext not running and
// refusing a resume without a gesture (see SUSPEND_GUEST_AUDIO in the
// header). Two independent pieces:
//   1. resume() on any AudioContext rejects unless called within 1000ms of
//      a trusted gesture. This alone doesn't reproduce #63: the page's own
//      pre-boot gesture-unlocked context (_ejsCtx in netplay-rollback.js's
//      showGesturePrompt) calls resume() inside the trusted click, which
//      un-suspends it before the core ever gets it.
//   2. So separately, poll for the core's own OpenAL context(s)
//      (EJS_emulator.gameManager.Module.AL.contexts) and suspend each one
//      — via the real, unpatched suspend() — the first time it appears.
//      That's the context that actually goes quiet in prod.
const suspendAudioInitScript = () => {
  let lastGestureAt = -Infinity;
  for (const type of ['pointerdown', 'mousedown', 'click', 'touchend']) {
    window.addEventListener(
      type,
      (e) => {
        if (e.isTrusted) lastGestureAt = performance.now();
      },
      { capture: true },
    );
  }

  // Gesture-gated resume(), patched on both AudioContext and
  // webkitAudioContext (skipping a re-patch if they're the same function).
  const patchResume = (name) => {
    const Real = window[name];
    if (!Real || Real.prototype.__knResumePatched) return;
    const realResume = Real.prototype.resume;
    Real.prototype.resume = function (...args) {
      if (performance.now() - lastGestureAt <= 1000) return realResume.apply(this, args);
      return Promise.reject(new DOMException('Permission was denied', 'NotAllowedError'));
    };
    Real.prototype.__knResumePatched = true;
  };
  patchResume('AudioContext');
  if (window.webkitAudioContext) patchResume('webkitAudioContext');

  // Real suspend(), saved before any patching touches it (only resume() is
  // patched above, but grab this early regardless for clarity/safety).
  const AC = window.AudioContext || window.webkitAudioContext;
  const realSuspend = AC?.prototype?.suspend;
  const suspended = new WeakSet();
  const poll = setInterval(() => {
    const contexts = window.EJS_emulator?.gameManager?.Module?.AL?.contexts;
    if (!contexts) return;
    let foundAny = false;
    for (const ctx of Object.values(contexts)) {
      const audioCtx = ctx?.audioCtx;
      if (!audioCtx || suspended.has(audioCtx)) continue;
      suspended.add(audioCtx);
      realSuspend?.call(audioCtx);
      foundAny = true;
    }
    if (foundAny) clearInterval(poll);
  }, 50);
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

// DROP_SIGNALING_MS: keep every client event the page reports (type and meta),
// so the run can assert on reconnects and on the lifecycle machine's reports.
const recordEventsInitScript = () => {
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
        return real(type, msg, meta);
      }),
  });
};

const mkPage = async (browser, name, { throttleHz = 0, hidden = false, suspendAudio = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.addInitScript(initScript, { lat: LAT, jitter: JITTER });
  if (throttleHz) await ctx.addInitScript(throttleInitScript, throttleHz);
  if (hidden) await ctx.addInitScript(hiddenInitScript);
  if (suspendAudio) await ctx.addInitScript(suspendAudioInitScript);
  if (DROP_SIGNALING_MS) await ctx.addInitScript(recordEventsInitScript);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror ${e.message}`));
  if (DROP_SIGNALING_MS) {
    // Proxy the signaling WebSocket so it can be cut, and kept down, on demand.
    signaling.set(page, { down: false, sockets: [] });
    await page.routeWebSocket(/socket\.io/, (ws) => {
      const state = signaling.get(page);
      if (state.down) {
        ws.close({ code: 4000, reason: 'signaling down (test)' });
        return;
      }
      const server = ws.connectToServer();
      state.sockets.push({ page: ws, server });
      ws.onMessage((message) => server.send(message));
    });
  }
  return page;
};

// DROP_SIGNALING_GUEST_LATE_MS: did the host rejoin and see a room without the guest first?
let hostSawRoomWithoutGuest = false;
let hostSawGuestReturn = false;
// Per-page signaling proxy state for DROP_SIGNALING_MS.
const signaling = new Map();
const setSignalingDown = async (page, down) => {
  const state = signaling.get(page);
  state.down = down;
  if (!down) return;
  // Close both ends: the page must see the drop, and the server must see the
  // client go rather than keep the old session until its heartbeat times out.
  // 4000 is an application close code; 1006 is reserved and cannot be sent.
  for (const { page: pageSide, server } of state.sockets.splice(0)) {
    await server.close({ code: 4000, reason: 'signaling down (test)' });
    await pageSide.close({ code: 4000, reason: 'signaling down (test)' });
  }
};

const host = await mkPage(hostBrowser, 'host');
const guest = await mkPage(guestBrowser, 'guest', {
  throttleHz: THROTTLE_GUEST ? THROTTLE_GUEST_HZ : HIDE_GUEST_MS && !HIDE_GUEST_FROZEN ? 1 : 0,
  hidden: HIDE_GUEST_MS > 0,
  suspendAudio: SUSPEND_GUEST_AUDIO,
});
await host.goto(`${URL}/play.html?room=${room}&host=1&name=Host&mode=rollback${QUERY}`);
await host.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
await guest.goto(`${URL}/play.html?room=${room}&name=Guest${QUERY}`);
await guest.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
for (const p of [host, guest]) await p.locator("#rom-drop input[type='file']").setInputFiles(ROM);
await host.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
console.log('room', room, 'both ROM-ready; starting');
await host.click('#start-btn');

// Dismiss the tap-to-start prompt on whichever page shows it. Tracks how
// many times the guest's prompt was found visible and clicked — with
// SUSPEND_GUEST_AUDIO, a second tap here means the boot-audio-stall fix
// (stand-in clock) didn't recover boot on its own.
const t0 = Date.now();
let guestBootTaps = 0;
while (Date.now() - t0 < 60000) {
  for (const p of [host, guest]) {
    const v = await p.locator('#gesture-prompt:not(.hidden)').count();
    if (v) {
      if (p === guest) guestBootTaps++;
      await p
        .locator('#gesture-prompt')
        .click({ force: true })
        .catch(() => {});
    }
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
      const { role, VISUAL_CHECK, ADDRESS_MAP_CHECK, ADDRESS_MAP_OF, anyFighter } = args;
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
      const pilot = window.KNMenuAutopilot.create({
        read32: (a) => rb.readRdram32(a),
        log: (m) => (W.pilotFail = m),
        anyFighter,
      });
      // ADDRESS_MAP_CHECK: read the map's fields from RAM as the game runs.
      // readRdram32 returns the N64 word; a single byte is picked out of it.
      const rom = ADDRESS_MAP_CHECK ? window.KNCore.addressMapFor(ADDRESS_MAP_OF || window.KNState?.romHash) : null;
      W.mapRom = rom ? rom.name : null;
      W.mapScenes = rom ? rom.scenes : null;
      W.mapOngoing = rom ? rom.battleStatus.ongoing : null;
      W.mapSamples = [];
      const byteAt = (off) => {
        const word = rb.readRdram32(off & ~3);
        return word === null ? null : (word >>> (8 * (3 - (off & 3)))) & 0xff;
      };
      const sampleMap = (f) => {
        const [stocksBase, playerStride, sceneCurr, vsHeader, vsHeaderSize, rngSeed, cssBase, cssStride, cssCharId] =
          rom.values;
        const ftBufferPtr = rom.values[12];
        const ftBufferSize = rom.values[13];
        let headerNonZero = false;
        for (let off = 0; off < vsHeaderSize; off += 4) if (rb.readRdram32(vsHeader + off)) headerNonZero = true;
        W.mapSamples.push({
          f,
          status: byteAt(vsHeader + rom.battleStatus.offset),
          scene: byteAt(sceneCurr),
          stocks: [0, 1].map((p) => byteAt(stocksBase + p * playerStride)),
          charIds: [0, 1].map((p) => rb.readRdram32(cssBase + p * cssStride + cssCharId)),
          rng: rb.readRdram32(rngSeed),
          headerNonZero,
          ftPtr: rb.readRdram32(ftBufferPtr),
          ftBufferSize,
        });
      };
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
        if (rom && f % 30 === 0 && W.mapSamples.at(-1)?.f !== f) sampleMap(f);
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
    { role, VISUAL_CHECK, ADDRESS_MAP_CHECK, ADDRESS_MAP_OF, anyFighter: MENU_AUTOPILOT === 'any-fighter' },
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
  await page.click('.kn-feedback-close');
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
let desyncGuestStocksBase = -1; // DESYNC_GUEST: the map's address of P1's stock count
let desyncGuestAt = -1; // DESYNC_GUEST: the guest's frame when its stock count was changed
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
    if (HIDE_GUEST_FROZEN) {
      console.log('freezing hidden guest tab for', HIDE_GUEST_MS, 'ms');
      await guest.evaluate((ms) => {
        window.__knHidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        const t = performance.now();
        while (performance.now() - t < ms);
        window.__knHidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      }, HIDE_GUEST_MS);
      console.log('guest tab thawed');
    } else {
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
    }
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
  } else if (DESYNC_GUEST) {
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
    // P1's stock count, at the address the core's map has for it (SSB64 US:
    // SCPlayerData.stock_count, 0xA4F23). RDRAM is host-order words, so the byte
    // is at offset ^ 3. Held for 3 s so that every state the rollback ring
    // can still restore carries the change.
    ({ frame: desyncGuestAt, stocksBase: desyncGuestStocksBase } = await guest.evaluate(async () => {
      const mod = window.EJS_emulator.gameManager.Module;
      const stocksBase = mod._kn_field_map_value?.(0) ?? 0xa4f23;
      const at = mod._kn_get_rdram_ptr() + (stocksBase ^ 3);
      const wrong = mod.HEAPU8[at] ^ 1;
      const frame = window.NetplayRollback.getHudCounters?.()?.currentFrame ?? 0;
      const until = performance.now() + 3000;
      while (performance.now() < until) {
        mod.HEAPU8[at] = wrong;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { frame, stocksBase };
    }));
    console.log('guest desynced on purpose: P1 stock count changed at frame', desyncGuestAt);
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
  } else if (DROP_SIGNALING_MS > 0) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    // Only reconnects after this point count: one during setup must not satisfy the check.
    for (const p of [host, guest]) {
      signaling.get(p).reconnectsBefore = await p.evaluate(
        () => window.__knEvents.filter((e) => e.type === 'reconnect').length,
      );
    }
    await Promise.all([setSignalingDown(host, true), setSignalingDown(guest, true)]);
    console.log(`signaling sockets cut on both pages for ${DROP_SIGNALING_MS} ms`);
    await host.waitForTimeout(DROP_SIGNALING_MS);
    // With DROP_SIGNALING_GUEST_LATE_MS the host comes back first and must
    // see a room without the guest before the guest rejoins under a new
    // socket id. Opening the host's gate does not make that happen, so wait
    // for the host's engine to log the one-player roster; if it has not by
    // the end of the window, the run did not test what it claims and fails.
    const soloRosters = () =>
      host.evaluate(
        () => (window.NetplayRollback?.exportSyncLog?.() || '').match(/onUsersUpdated: 1 players/g)?.length ?? 0,
      );
    const soloRostersBefore = DROP_SIGNALING_GUEST_LATE_MS > 0 ? await soloRosters() : 0;
    const restoreStarted = Date.now();
    await setSignalingDown(host, false);
    if (DROP_SIGNALING_GUEST_LATE_MS > 0) {
      console.log(`host signaling allowed to reconnect; guest held up to ${DROP_SIGNALING_GUEST_LATE_MS} ms longer`);
      while (Date.now() - restoreStarted < DROP_SIGNALING_GUEST_LATE_MS) {
        if ((await soloRosters()) > soloRostersBefore) {
          hostSawRoomWithoutGuest = true;
          break;
        }
        await host.waitForTimeout(500);
      }
      console.log(`host saw the room without the guest: ${hostSawRoomWithoutGuest}`);
    }
    await setSignalingDown(guest, false);
    console.log('signaling allowed to reconnect');
    const guestLateFor = Date.now() - restoreStarted;
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - DROP_SIGNALING_MS - guestLateFor));
    // Socket.IO retries on a backoff, and an attempt can take many seconds on
    // a slow machine, so a page may still be mid-retry when the battle time is
    // up. Give each page until DROP_SIGNALING_RECONNECT_WAIT_MS to record its
    // reconnect; one that still has not is reported as never reconnected.
    for (const p of [host, guest]) {
      await p
        .waitForFunction(
          (reconnectsBefore) => window.__knEvents.filter((e) => e.type === 'reconnect').length > reconnectsBefore,
          signaling.get(p).reconnectsBefore,
          { timeout: DROP_SIGNALING_RECONNECT_WAIT_MS },
        )
        .catch(() => {});
    }
    // The guest's reconnect is recorded when its socket connects, before it
    // has rejoined the room. The host's handling of that rejoin is the thing
    // under test, so wait for the host to log the two-player roster again and
    // then long enough for a stall to be logged (TICK-STUCK errors at 5 s).
    if (hostSawRoomWithoutGuest) {
      const guestIsBack = () =>
        host.evaluate(() => {
          const log = window.NetplayRollback?.exportSyncLog?.() || '';
          return log.slice(log.lastIndexOf('onUsersUpdated: 1 players')).includes('onUsersUpdated: 2 players');
        });
      const until = Date.now() + DROP_SIGNALING_RECONNECT_WAIT_MS;
      while (Date.now() < until && !hostSawGuestReturn) {
        hostSawGuestReturn = await guestIsBack();
        if (!hostSawGuestReturn) await host.waitForTimeout(500);
      }
      console.log(`host saw the guest back in the room: ${hostSawGuestReturn}`);
      await host.waitForTimeout(8000);
    }
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
      // 64 KB RDRAM blocks kn_game_state_hash leaves out (of 128).
      taintedBlocks: m._kn_get_tainted_block_count?.() ?? null,
      mapRom: window.__tp.mapRom,
      mapScenes: window.__tp.mapScenes,
      mapOngoing: window.__tp.mapOngoing,
      mapSamples: window.__tp.mapSamples,
      visual,
    };
  }, VISUAL_CHECK);
const [H, G] = await Promise.all([collect(host, VISUAL_CHECK), collect(guest, VISUAL_CHECK)]);
const knEventsOf = (page) => (DROP_SIGNALING_MS ? page.evaluate(() => window.__knEvents) : []);
const [hostEvents, guestEvents] = await Promise.all([knEventsOf(host), knEventsOf(guest)]);
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
  firstGs = null,
  gpMisBeforeDesync = 0,
  gpMisAfterDesync = 0;
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
    // DESYNC_GUEST: the hash must differ because of the change, so only
    // frames from the change on count, and none may differ before it.
    if (DESYNC_GUEST && desyncGuestAt >= 0) {
      if (+f >= desyncGuestAt) gpMisAfterDesync++;
      else gpMisBeforeDesync++;
    }
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

// HIDE_GUEST_MS mode (issues #64/#69): unlike FREEZE mode, there is no exclusion
// window — a backgrounded-then-returned guest must never desync the match,
// so any of these events anywhere in either peer's sync log is a failure.
const tickStuckErrorsOf = (log) => count(log, /TICK-STUCK severity=error/g);
const peerPhantomsOf = (log) => count(log, /PEER-PHANTOM/g);
const rbInputStallTimeoutsOf = (log) => count(log, /RB-INPUT-STALL-TIMEOUT/g);
// The run must actually exercise the fix, not just avoid tripping on a
// no-op path: the guest's sync log must show it went through the real
// bg-return handler ("tab visible (was background") and that
// _requestLifecycleFullResync skipped fast-forward/resync while C rollback
// was active ("rollback mode — no fast-forward/resync").
// Their absence means the hide/throttle/visibilitychange plumbing didn't
// reach netplay-rollback.js, and a pass wouldn't mean anything.
const guestExercisedTabVisible = (log) => log.includes('tab visible (was background');
const guestExercisedRollbackSkip = (log) => log.includes('rollback mode — no fast-forward/resync');
// Same reasoning for SUSPEND_GUEST_AUDIO: a pass where the guest never hit
// the boot-audio-stall watchdog at all (fix path unexercised) wouldn't mean
// anything either.
const guestExercisedStandInClock = (log) => log.includes('stand-in audio clock installed');

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

// ADDRESS_MAP_CHECK: what one peer read through the map, judged against
// what the game must have been doing. Each check is {name, ok, detail}.
const addressMapChecksOf = (side) => {
  if (!side.mapRom)
    return [{ name: 'the ROM has an address map', ok: false, detail: 'KNCore.addressMapFor gave none' }];
  const samples = side.mapSamples;
  const scenes = side.mapScenes;
  const atSelect = samples.filter((x) => x.scene === scenes.characterSelect);
  const inBattle = samples.filter((x) => x.scene === scenes.battle);
  const lastSelect = atSelect.at(-1);
  const underWayFrom = inBattle.findIndex((x) => x.status === side.mapOngoing);
  const strict = MENU_AUTOPILOT !== 'any-fighter';
  const inRam = (x) => x.ftPtr >>> 24 === 0x80 && (x.ftPtr & 0xffffff) + x.ftBufferSize <= 0x800000;
  const checks = [
    {
      name: 'scene reads the character select, then the battle',
      ok: atSelect.length > 0 && inBattle.length > 0 && atSelect[0].f < inBattle[0].f,
      detail: `${atSelect.length} samples at scene ${scenes.characterSelect}, ${inBattle.length} at ${scenes.battle}; scenes seen ${[...new Set(samples.map((x) => x.scene))].join(',')}`,
    },
    {
      name: strict
        ? "character ids are the autopilot's picks (Mario 0, Donkey Kong 2)"
        : 'character ids are fighter kinds',
      ok:
        !!lastSelect &&
        (strict ? lastSelect.charIds.join() === '0,2' : lastSelect.charIds.every((id) => id !== null && id < 64)),
      detail: lastSelect
        ? `P1,P2 = ${lastSelect.charIds.join(',')} at frame ${lastSelect.f}`
        : 'no sample at the character select',
    },
    {
      // A dormant copy of the battle state has everything in range and
      // never says a match is on; this is the check that tells them apart.
      // The scene opens on the countdown, before the status changes.
      name: 'the battle header says the match gets under way and stays so',
      ok: underWayFrom >= 0 && inBattle.slice(underWayFrom).every((x) => x.status === side.mapOngoing),
      detail:
        underWayFrom < 0
          ? `status never read ${side.mapOngoing}; values seen ${[...new Set(inBattle.map((x) => x.status))].join(',')}`
          : `status ${side.mapOngoing} from battle sample ${underWayFrom + 1} of ${inBattle.length} on`,
    },
    {
      name: 'stock counts in battle are plausible',
      ok: inBattle.length > 0 && inBattle.every((x) => x.stocks.every((n) => n !== null && n <= 98)),
      detail: `P1,P2 values seen: ${[...new Set(inBattle.map((x) => x.stocks.join('/')))].slice(0, 6).join(' ')}`,
    },
    {
      name: 'the battle header is not empty',
      ok: inBattle.length > 0 && inBattle.every((x) => x.headerNonZero),
      detail: `${inBattle.filter((x) => x.headerNonZero).length} of ${inBattle.length} battle samples non-zero`,
    },
    {
      name: 'the RNG seed moves',
      ok: new Set(inBattle.map((x) => x.rng)).size >= Math.min(5, inBattle.length),
      detail: `${new Set(inBattle.map((x) => x.rng)).size} distinct values in ${inBattle.length} battle samples`,
    },
    {
      // Null while the battle scene is still loading; once set it must be
      // an address whose buffer lies inside RAM.
      name: 'the fighter-buffer pointer, once set, points into RAM',
      ok: inBattle.some((x) => x.ftPtr) && inBattle.filter((x) => x.ftPtr).every(inRam),
      detail: `values seen: ${[...new Set(inBattle.map((x) => (x.ftPtr ?? 0).toString(16)))].slice(0, 4).join(' ')}`,
    },
  ];
  return checks;
};

const taintCoverage = (side) => (Number.isInteger(side.taintedBlocks) ? 128 - side.taintedBlocks : null);

// DESYNC_GUEST: the detector's cross-peer flags in one peer's sync log, split
// at the frame the guest was desynced.
const desyncFlagsOf = (log) => {
  const flags = [...log.matchAll(/KNDesync suspect frame=(\d+) field=(\w+) slot=(\w+) trigger=flag/g)].map((m) => ({
    frame: Number(m[1]),
    field: m[2],
    slot: m[3],
  }));
  const after = flags.filter((f) => f.frame >= desyncGuestAt);
  return {
    before: flags.length - after.length,
    after: after.length,
    // The change is to P1's stock count: slot 0, and no other player's.
    stocksAfter: after.filter((f) => f.field === 'stocks' && f.slot === '0').length,
    firstAfter: after[0] ?? null,
    fields: [...new Set(after.map((f) => f.field))],
    // The frame this peer screenshot for each flagged frame: suspect -> capture.
    captures: Object.fromEntries(
      [...log.matchAll(/KNDesync capture frame=(\d+) suspect=(\d+) field=stocks slot=0/g)].map((m) => [
        m[2],
        Number(m[1]),
      ]),
    ),
  };
};

const signalingDropOf = (page, events, log) => ({
  reconnectsAfterOutage:
    events.filter((e) => e.type === 'reconnect').length - (signaling.get(page)?.reconnectsBefore ?? 0),
  lifecycleReports: events.filter((e) => e.type === 'session-disagree' || e.type === 'late-join-stranded'),
  tickStuck: count(log, /TICK-STUCK/g),
  // The lockstep-path stall (waiting on a peer's input), not the rollback engine's routine RB-INPUT-STALL.
  inputStalls: count(log, /(?<!RB-)INPUT-STALL (start|hard-timeout)/g),
  // The rollback engine gave up waiting on a peer's input (not its routine RB-INPUT-STALL pacing).
  rbStallTimeouts: count(log, /RB-INPUT-STALL-TIMEOUT/g),
  meshHeals: count(log, /MESH-HEAL/g),
});

const summary = {
  room,
  ...(ADDRESS_MAP_CHECK
    ? { addressMapCheck: { rom: H.mapRom, host: addressMapChecksOf(H), guest: addressMapChecksOf(G) } }
    : {}),
  ...(DESYNC_GUEST
    ? {
        desyncGuest: {
          atFrame: desyncGuestAt,
          gameplayMismatches: { before: gpMisBeforeDesync, after: gpMisAfterDesync },
          host: desyncFlagsOf(H.sync),
          guest: desyncFlagsOf(G.sync),
        },
      }
    : {}),
  ...(DROP_SIGNALING_MS
    ? {
        signalingDrop: {
          ms: DROP_SIGNALING_MS,
          host: signalingDropOf(host, hostEvents, H.sync),
          guest: signalingDropOf(guest, guestEvents, G.sync),
        },
      }
    : {}),
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
          frozen: HIDE_GUEST_FROZEN,
          tickStuckErrors: { host: tickStuckErrorsOf(H.sync), guest: tickStuckErrorsOf(G.sync) },
          peerPhantoms: { host: peerPhantomsOf(H.sync), guest: peerPhantomsOf(G.sync) },
          rbInputStallTimeouts: { host: rbInputStallTimeoutsOf(H.sync), guest: rbInputStallTimeoutsOf(G.sync) },
          guestExercisedTabVisible: guestExercisedTabVisible(G.sync),
          guestExercisedRollbackSkip: guestExercisedRollbackSkip(G.sync),
        },
      }
    : {}),
  ...(SUSPEND_GUEST_AUDIO ? { guestBootTaps, guestExercisedStandInClock: guestExercisedStandInClock(G.sync) } : {}),
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
    // What "zero game-state mismatches" covers: kn_game_state_hash skips
    // every RDRAM block an audio or framebuffer write has tainted, and
    // samples every 16th byte of the rest.
    gameStateRdramBlocksHashed: { host: taintCoverage(H), guest: taintCoverage(G), of: 128 },
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
    !summary.hideGuest.guestExercisedRollbackSkip);
if (hideGuestFailed) {
  console.log('HIDE_GUEST_MS: desync-indicating events or unexercised fix path:', JSON.stringify(summary.hideGuest));
}
const suspendGuestAudioFailed = SUSPEND_GUEST_AUDIO && (guestBootTaps > 1 || !summary.guestExercisedStandInClock);
if (suspendGuestAudioFailed) {
  if (guestBootTaps > 1) {
    console.log(`SUSPEND_GUEST_AUDIO: guest needed ${guestBootTaps} taps to boot (expected 1)`);
  }
  if (!summary.guestExercisedStandInClock) {
    console.log('SUSPEND_GUEST_AUDIO: guest never installed the stand-in audio clock (fix path unexercised)');
  }
}
const hostFirstUnverified = DROP_SIGNALING_GUEST_LATE_MS > 0 && !(hostSawRoomWithoutGuest && hostSawGuestReturn);
if (hostFirstUnverified) {
  console.log(
    'DROP_SIGNALING_GUEST_LATE_MS: the host must see the room without the guest and then the guest back in it; ' +
      `saw the first: ${hostSawRoomWithoutGuest}, the second: ${hostSawGuestReturn}`,
  );
}
const signalingDropFailed =
  hostFirstUnverified ||
  (DROP_SIGNALING_MS > 0 &&
    [summary.signalingDrop.host, summary.signalingDrop.guest].some(
      (side) =>
        side.reconnectsAfterOutage < 1 ||
        side.lifecycleReports.length > 0 ||
        side.tickStuck > 0 ||
        side.inputStalls > 0 ||
        side.rbStallTimeouts > 0,
    ));
if (signalingDropFailed) {
  console.log('DROP_SIGNALING_MS: a page never reconnected, stalled, or its lifecycle machine reported:');
  console.log(JSON.stringify(summary.signalingDrop));
}
// The peers' screenshots of a flagged frame are compared with each other, so
// both must have captured the first flagged frame, and at the same frame.
const desyncCapturesAgree = (hostSide, guestSide) => {
  const suspect = hostSide.firstAfter?.frame;
  if (suspect === undefined) return false;
  const hostAt = hostSide.captures[suspect];
  return hostAt !== undefined && hostAt === guestSide.captures[suspect];
};
// kn_gameplay_hash has its own table of addresses, compiled in and SSB64's.
// It sees the changed stock count only when the map's stock address is the
// one in that table, so only then is it required to.
const desyncGuestGameplayHashCovers = desyncGuestStocksBase === 0xa4f23;
// DESYNC_GUEST inverts the run: the peers were desynced on purpose. The
// detector must flag the changed field on both peers, and nothing before
// the change; and the gameplay hash, which lists the stock counts, must
// differ on at least one frame. The game-state and full-state hashes are
// not judged: the stock counts are in a block the first leaves out, and the
// second samples one byte in 64.
const desyncGuestFailed =
  DESYNC_GUEST &&
  (desyncGuestAt < 0 ||
    (desyncGuestGameplayHashCovers && gpMisAfterDesync < 1) ||
    gpMisBeforeDesync > 0 ||
    [summary.desyncGuest.host, summary.desyncGuest.guest].some((side) => side.before > 0 || side.stocksAfter < 1) ||
    !desyncCapturesAgree(summary.desyncGuest.host, summary.desyncGuest.guest));
if (DESYNC_GUEST) {
  console.log(
    desyncGuestFailed ? 'DESYNC_GUEST: the detector did not flag the desync as expected:' : 'DESYNC_GUEST: flagged:',
    JSON.stringify(summary.desyncGuest),
  );
  process.exit(desyncGuestFailed || H.inBattleAt < 0 || G.inBattleAt < 0 ? 1 : 0);
}
const addressMapFailed =
  ADDRESS_MAP_CHECK && [...summary.addressMapCheck.host, ...summary.addressMapCheck.guest].some((check) => !check.ok);
if (ADDRESS_MAP_CHECK) {
  for (const side of ['host', 'guest'])
    for (const check of summary.addressMapCheck[side])
      console.log(`ADDRESS_MAP_CHECK ${side} ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
}
const failed =
  addressMapFailed ||
  signalingDropFailed ||
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
  hideGuestFailed ||
  suspendGuestAudioFailed;
process.exit(failed ? 1 : 0);
