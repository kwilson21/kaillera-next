/**
 * A host playing alone loses its signaling socket mid-game, against the real
 * server. The game must not notice.
 *
 * Production, 2026-11-09: the mesh health check compared roster ids against
 * `socket.id`, which is undefined while the socket is down. The host's own
 * roster entry looked like a missing peer, so every 300 frames it opened a
 * connection to itself and stalled 5 s at a time on input from its own slot.
 *
 * A solo game runs the engine's lockstep path, which is where that health
 * check lives (the two-player rollback path returns before it, so
 * rb-two-player.mjs with DROP_SIGNALING_MS cannot catch this). The host
 * starts a game alone; once it is running, the test cuts the Socket.IO
 * WebSocket and refuses reconnects until the game has advanced DROP_FRAMES
 * frames, then lets it reconnect.
 *
 * Fails if the sync log shows any MESH-HEAL, INPUT-STALL or TICK-STUCK, if
 * the game stopped advancing during the outage, if the page never recorded
 * the reconnect, or if the lifecycle machine reported session-disagree.
 *
 *   just serve        # the real server on :27888, in another terminal
 *   KN_ROM=/path/ssb64-us.z64 [KN_URL=http://localhost:27888] [DROP_FRAMES=700] \
 *     [CHROMIUM_PATH=...] [OUT=/tmp/solo-drop] node tests/solo-signaling-drop.mjs
 */
import fs from 'node:fs';
import { chromium } from 'playwright';

const URL = process.env.KN_URL || 'http://localhost:27888';
const ROM = process.env.KN_ROM;
const DROP_FRAMES = Number(process.env.DROP_FRAMES || 700); // spans two 300-frame health checks
const OUT = process.env.OUT || '/tmp/solo-drop';
if (!ROM || !fs.existsSync(ROM)) {
  console.log('KN_ROM must point at the SSB64 US ROM');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
const room = `SD${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
// Keep every client event the page reports, so reconnects and lifecycle
// reports can be asserted on.
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
        return real(type, msg, meta);
      }),
  });
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log(`pageerror ${e.message}`));

// Proxy the signaling WebSocket so it can be cut, and kept down, on demand.
const signaling = { down: false, sockets: [] };
await page.routeWebSocket(/socket\.io/, (ws) => {
  if (signaling.down) {
    ws.close({ code: 1006, reason: 'signaling down (test)' });
    return;
  }
  const server = ws.connectToServer();
  signaling.sockets.push(ws);
  ws.onMessage((message) => server.send(message));
});

await page.goto(`${URL}/play.html?room=${room}&host=1&name=Host&mode=rollback&knperf=light`);
await page.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
await page.locator("#rom-drop input[type='file']").setInputFiles(ROM);
await page.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
await page.click('#start-btn');

const frame = () => page.evaluate(() => window.KNState?.frameNum ?? 0);
const waitForFrame = async (target, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await page.locator('#gesture-prompt:not(.hidden)').count()) {
      await page
        .locator('#gesture-prompt')
        .click({ force: true })
        .catch(() => {});
    }
    if ((await frame()) >= target) return true;
    await page.waitForTimeout(500);
  }
  return false;
};

const failures = [];
if (!(await waitForFrame(120, 120000))) failures.push('game never started');

const cutAt = await frame();
signaling.down = true;
for (const ws of signaling.sockets.splice(0)) await ws.close({ code: 1006, reason: 'signaling down (test)' });
console.log(`room ${room}: signaling cut at frame ${cutAt}; holding it down for ${DROP_FRAMES} frames`);
const advanced = await waitForFrame(cutAt + DROP_FRAMES, 240000);
const restoredAt = await frame();
signaling.down = false;
console.log(`signaling allowed to reconnect at frame ${restoredAt}`);
if (!advanced)
  failures.push(`game advanced only ${restoredAt - cutAt} of ${DROP_FRAMES} frames while signaling was down`);
await page
  .waitForFunction(() => window.__knEvents.some((e) => e.type === 'reconnect'), null, { timeout: 30000 })
  .catch(() => {});
await page.waitForTimeout(2000);

const { sync, events } = await page.evaluate(() => ({
  sync: window.NetplayRollback?.exportSyncLog?.() || '',
  events: window.__knEvents,
}));
fs.writeFileSync(`${OUT}/sync.txt`, sync);
const count = (re) => (sync.match(re) || []).length;
const summary = {
  room,
  cutAt,
  restoredAt,
  meshHeals: count(/MESH-HEAL/g),
  inputStalls: count(/INPUT-STALL (start|hard-timeout)/g),
  tickStuck: count(/TICK-STUCK/g),
  reconnects: events.filter((e) => e.type === 'reconnect').length,
  lifecycleReports: events.filter((e) => e.type === 'session-disagree' || e.type === 'late-join-stranded'),
};
if (summary.meshHeals) failures.push('the mesh health check tried to reconnect to a peer in a solo game');
if (summary.inputStalls || summary.tickStuck) failures.push('the game stalled');
if (summary.reconnects < 1) failures.push('the page never recorded the reconnect');
if (summary.lifecycleReports.length) failures.push('the lifecycle machine disagreed with the page');

await browser.close();
console.log(JSON.stringify({ ...summary, failures }, null, 1));
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify({ ...summary, failures }, null, 1));
process.exit(failures.length ? 1 : 0);
