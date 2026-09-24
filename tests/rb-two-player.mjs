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
 *   - no failed rollbacks and no integrity events (R2-R5 in
 *     docs/netplay-invariants.md) in either peer's engine or sync log
 *   - TICK-STUCK stalls, negotiated delay and rollback counts, for context
 * Exits 1 if the peers' gameplay state diverges, a rollback fails, an
 * integrity event fires, the match never reaches a battle, or fewer than 80%
 * of the finalized battle frames were compared.
 *
 *   just serve        # the real server on :27888, in another terminal
 *   KN_ROM=/path/ssb64-us.z64 [LAT=50] [JITTER=0] [BATTLE_SECONDS=60] \
 *     [HEADED=1] [OUT=/tmp/two-player] node tests/rb-two-player.mjs
 *
 * Needs the SSB64 US ROM (the menu autopilot reads its RAM layout). Two
 * emulators headless on one machine run slowly and measure noisy RTTs, so
 * compare runs with each other; HEADED=1 on a real machine is closer to play.
 */
import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.env.KN_URL || 'http://localhost:27888';
const ROM = process.env.KN_ROM;
const LAT = Number(process.env.LAT || 50); // one-way ms
const JITTER = Number(process.env.JITTER || 0);
const BATTLE_SECONDS = Number(process.env.BATTLE_SECONDS || 60);
const OUT = process.env.OUT || '/tmp/two-player';
const QUERY = process.env.KN_QUERY || '';
fs.mkdirSync(OUT, { recursive: true });
const room = 'TP' + Math.random().toString(36).slice(2, 8).toUpperCase();

const browser = await chromium.launch({
  headless: process.env.HEADED !== '1',
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});

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

const mkPage = async (name) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await ctx.addInitScript(initScript, { lat: LAT, jitter: JITTER });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror ${e.message}`));
  return page;
};

const host = await mkPage('host');
const guest = await mkPage('guest');
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
    if (v) await p.locator('#gesture-prompt').click({ force: true }).catch(() => {});
  }
  const ready = await Promise.all([host, guest].map((p) => p.evaluate(() => !!window.NetplayRollback?.getHudCounters?.()?.currentFrame)));
  if (ready[0] && ready[1]) break;
  await host.waitForTimeout(500);
}

// Autopilot + input hook + hash recorder, per page.
const install = async (p, role) => {
  await p.addScriptTag({ url: `${URL}/static/ssb64-menu-autopilot.js` });
  await p.evaluate((role) => {
    const W = (window.__tp = { role, hashes: {}, scene: -1, inBattleAt: -1, pilotFail: null, btnCool: 0, btnHeld: 0 });
    const rb = window.NetplayRollback;
    const frameNow = () => rb.getHudCounters?.()?.currentFrame ?? 0;
    const pilot = window.KNMenuAutopilot.create({ read32: (a) => rb.readRdram32(a), log: (m) => (W.pilotFail = m) });
    const actor = role === 'host' ? pilot.p1 : pilot.p2;
    let held = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 }, until = 0;
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
          W.btnHeld = inp.buttons; W.btnCool = f + d + 4;
        } else if (W.btnHeld) { W.btnHeld = 0; W.btnCool = f + d; }
        return inp;
      }
      if (W.inBattleAt < 0) W.inBattleAt = f;
      if (f >= until) {
        const r = Math.random();
        held = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
        if (r < 0.35) held.lx = Math.random() < 0.5 ? -70 : 70;
        else if (r < 0.55) held.buttons = 1 << BTN[(Math.random() * BTN.length) | 0];
        else if (r < 0.7) { held.lx = Math.random() < 0.5 ? -50 : 50; held.buttons = 1; }
        else if (r < 0.8) held.ly = -70;
        until = f + 8 + ((Math.random() * 40) | 0);
      }
      return held;
    };
    const m = window.EJS_emulator.gameManager.Module;
    const post = m._kn_post_tick;
    m._kn_post_tick = function (...a) {
      const r = post.apply(this, a);
      if ((m._kn_get_replay_depth?.() ?? 0) === 0 && r > 40) {
        const f = r - 12;
        if (!(f in W.hashes)) W.hashes[f] = [m._kn_gameplay_hash(f) >>> 0, m._kn_full_state_hash(f) >>> 0, (m._kn_game_state_hash?.(f) ?? 0) >>> 0];
      }
      return r;
    };
  }, role);
};
await install(host, 'host');
await install(guest, 'guest');

// Wait for the battle, then play.
const tb = Date.now();
const MENU_MS = Number(process.env.MENU_SECONDS || 600) * 1000;
let lastLog = 0;
let inBattle = false;
for (;;) {
  const s = await Promise.all([host, guest].map((p) => p.evaluate(() => ({ f: window.NetplayRollback.getHudCounters().currentFrame, sc: window.__tp.scene, b: window.__tp.inBattleAt, fail: window.__tp.pilotFail }))));
  if (Date.now() - lastLog > 15000) { console.log('menus', JSON.stringify(s)); lastLog = Date.now(); }
  if (s[0].b > 0 && s[1].b > 0) { inBattle = true; break; }
  if (s[0].fail || s[1].fail) { console.log('autopilot failed', s[0].fail, s[1].fail); break; }
  if (Date.now() - tb > MENU_MS) { console.log('MENUS TIMED OUT (peers desynced or autopilot stuck)'); await host.screenshot({ path: `${OUT}/host-stuck.png` }); break; }
  await host.waitForTimeout(1000);
}
if (inBattle) {
  console.log('in battle; playing', BATTLE_SECONDS, 's');
  await host.waitForTimeout(BATTLE_SECONDS * 1000);
}

const collect = (p) => p.evaluate(() => {
  const m = window.EJS_emulator.gameManager.Module;
  return {
    hashes: window.__tp.hashes,
    inBattleAt: window.__tp.inBattleAt,
    frame: window.NetplayRollback.getHudCounters().currentFrame,
    clog: m.UTF8ToString(m._kn_get_debug_log()),
    sync: window.NetplayRollback.exportSyncLog?.() || '',
    rollbacks: m._kn_get_rollback_count?.(),
    failed: m._kn_get_failed_rollbacks?.(),
  };
});
const [H, G] = await Promise.all([collect(host), collect(guest)]);
await host.screenshot({ path: `${OUT}/host.png` });
await guest.screenshot({ path: `${OUT}/guest.png` });
fs.writeFileSync(`${OUT}/host-clog.txt`, H.clog); fs.writeFileSync(`${OUT}/guest-clog.txt`, G.clog);
fs.writeFileSync(`${OUT}/host-sync.txt`, H.sync); fs.writeFileSync(`${OUT}/guest-sync.txt`, G.sync);

let both = 0, gpMis = 0, fullMis = 0, firstGp = null, firstFull = null, battleCompared = 0, gsMis = 0, firstGs = null;
const battleFrom = Math.max(H.inBattleAt, G.inBattleAt);
for (const f of Object.keys(H.hashes)) {
  const a = H.hashes[f], b = G.hashes[f];
  if (!b || !a[0] || !b[0]) continue;
  both++;
  if (battleFrom > 0 && +f >= battleFrom) battleCompared++;
  if (a[0] !== b[0]) { gpMis++; if (firstGp === null) firstGp = +f; }
  if (a[1] !== b[1]) { fullMis++; if (firstFull === null) firstFull = +f; }
  if (a[2] !== b[2]) { gsMis++; if (firstGs === null) firstGs = +f; }
}
const count = (log, re) => (log.match(re) || []).length;
const INTEGRITY = /REPLAY-NORUN|RB-INVARIANT-VIOLATION|FATAL-RING-STALE|RB-LIVE-MISMATCH|FAILED-ROLLBACK|DEEP-MISPREDICT-SKIP|RESTORE-FAILED/g;
const bad = (log) => count(log, INTEGRITY);
const delayOf = (log) => (log.match(/kn_rollback_init: max=\d+ delay=(\d+)/) || [])[1]; // what the engine uses
// Finalized battle frames both peers could have hashed (hashing trails the
// head by 12 frames); coverage below 80% means the comparison proves little.
const battleSpan = battleFrom > 0 ? Math.min(H.frame, G.frame) - 12 - battleFrom + 1 : 0;
const battleCoverage = battleSpan > 0 ? Math.min(1, battleCompared / battleSpan) : 0;
const summary = {
  room, latencyMs: LAT, jitterMs: JITTER,
  frames: { host: H.frame, guest: G.frame, battleStart: [H.inBattleAt, G.inBattleAt] },
  rollbacks: { host: H.rollbacks, guest: G.rollbacks }, failedRollbacks: { host: H.failed, guest: G.failed },
  engineDelay: { host: delayOf(H.sync), guest: delayOf(G.sync) },
  integrityEvents: { host: bad(H.clog) + bad(H.sync), guest: bad(G.clog) + bad(G.sync) },
  tickStuck: { host: count(H.sync, /TICK-STUCK/g), guest: count(G.sync, /TICK-STUCK/g) },
  hashCompare: { framesCompared: both, battleFramesCompared: battleCompared, battleCoverage: +battleCoverage.toFixed(3), gameplayMismatches: gpMis, firstGameplayMismatch: firstGp, gameStateMismatches: gsMis, firstGameStateMismatch: firstGs, fullStateMismatches: fullMis, firstFullMismatch: firstFull },
};
fs.writeFileSync(`${OUT}/hashes.json`, JSON.stringify({ H: H.hashes, G: G.hashes }));
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
await browser.close();
const failed = gpMis > 0 || gsMis > 0 || (H.failed || 0) + (G.failed || 0) > 0 || summary.integrityEvents.host + summary.integrityEvents.guest > 0
  || H.inBattleAt < 0 || G.inBattleAt < 0 || battleCoverage < 0.8;
process.exit(failed ? 1 : 0);
