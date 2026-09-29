/**
 * Streaming host boot with the core's OpenAL AudioContext not running
 * (issue #63, streaming side).
 *
 * The core's OpenAL write blocks until Emscripten AL marks buffers
 * processed, which it derives only from audioCtx.currentTime. On Safari
 * without a gesture that context never runs, currentTime stays frozen, and
 * boot stops at about frame 6. Rollback recovers in its waitForEmu; this
 * checks the streaming host, whose boot poll (netplay-streaming.js
 * startHost → waitForEmu) waits for MIN_HOST_FRAMES before capturing.
 *
 * A host and a guest open play.html in streaming mode. The host's context
 * gets the same suspended-audio model as rb-two-player's
 * SUSPEND_GUEST_AUDIO: resume() is refused outside 1s of a trusted
 * gesture, and the core's own OpenAL contexts are suspended with the real
 * suspend() the first time they appear. The run then watches the host's
 * frame count for WAIT_SECONDS, tapping #gesture-prompt whenever the host
 * shows it (a trusted click, so the gated resume() is allowed).
 *
 * Pass (exit 0), SUSPEND=1: the host logs BOOT-AUDIO-STALL, needs exactly
 * one tap, reaches "capturing stream", its frame count keeps advancing,
 * and the core context ends up running (real audio, no stand-in clock).
 * Pass, SUSPEND=0 (control): same boot with no tap and no
 * BOOT-AUDIO-STALL (no false positive).
 * Pass, SUSPEND=1 GATE_RESUME=0: the context is suspended but resume() is
 * not gesture-gated, so the watchdog's own resume() recovers it. This run
 * never taps; the host must boot, capture, end with the core context
 * running and the prompt hidden (it must not stay over the game).
 * Fail (exit 1) otherwise — before the fix, the host sits at f=6 forever
 * with no log and no prompt.
 *
 *   just serve        # the real server on :27888, in another terminal
 *   KN_ROM=/path/ssb64-us.z64 [WAIT_SECONDS=30] [SUSPEND=1] [GATE_RESUME=1] [HEADED=1] \
 *     [OUT=/tmp/streaming-audio-stall] node tests/streaming-host-audio-stall.mjs
 */
import { chromium } from 'playwright';
import fs from 'fs';

const URL = process.env.KN_URL || 'http://localhost:27888';
const ROM = process.env.KN_ROM;
const WAIT_SECONDS = Number(process.env.WAIT_SECONDS || 30);
const SUSPEND = process.env.SUSPEND !== '0';
const GATE_RESUME = process.env.GATE_RESUME !== '0';
const OUT = process.env.OUT || '/tmp/streaming-audio-stall';
if (!ROM) {
  console.log('KN_ROM is required');
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
const room = 'SA' + Math.random().toString(36).slice(2, 8).toUpperCase();

const browser = await chromium.launch({
  headless: process.env.HEADED !== '1',
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});

// Same model as suspendAudioInitScript in rb-two-player.mjs: gesture-gated
// resume() plus a real suspend() of each core OpenAL context on first sight.
const suspendAudioInitScript = (gateResume) => {
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
  if (gateResume) {
    patchResume('AudioContext');
    if (window.webkitAudioContext) patchResume('webkitAudioContext');
  }
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

const mkPage = async (name, suspendAudio) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  if (suspendAudio) await ctx.addInitScript(suspendAudioInitScript, GATE_RESUME);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror ${e.message}`));
  return page;
};

const host = await mkPage('host', SUSPEND);
const guest = await mkPage('guest', false);
await host.goto(`${URL}/play.html?room=${room}&host=1&name=Host&mode=streaming`);
await host.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
await guest.goto(`${URL}/play.html?room=${room}&name=Guest`);
await guest.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
await host.locator("#rom-drop input[type='file']").setInputFiles(ROM);
await host.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
console.log('room', room, `starting streaming (host audio ${SUSPEND ? 'suspended' : 'normal'})`);
await host.click('#start-btn');

const sample = () =>
  host.evaluate(() => ({
    frames: window.EJS_emulator?.gameManager?.Module?._get_current_frame_count?.() ?? null,
    audio: Object.values(window.EJS_emulator?.gameManager?.Module?.AL?.contexts || {})
      .map((c) => c?.audioCtx?.state)
      .join(','),
    status: document.getElementById('status')?.textContent?.trim() ?? '',
    gesturePrompt: !!document.querySelector('#gesture-prompt:not(.hidden)'),
  }));

const samples = [];
let hostTaps = 0;
const t0 = Date.now();
while (Date.now() - t0 < WAIT_SECONDS * 1000) {
  const s = { t: Math.round((Date.now() - t0) / 1000), ...(await sample()) };
  samples.push(s);
  if (s.gesturePrompt && GATE_RESUME) {
    hostTaps++;
    await host
      .locator('#gesture-prompt')
      .click({ force: true })
      .catch(() => {});
  }
  await host.waitForTimeout(1000);
}
const hostSync = await host.evaluate(() => window.NetplayStreaming?.exportSyncLog?.() || '');
fs.writeFileSync(`${OUT}/host-sync.log`, hostSync);
const last = samples[samples.length - 1];
const tenAgo = samples[Math.max(0, samples.length - 11)];
const summary = {
  room,
  suspended: SUSPEND,
  lastFrames: last.frames,
  framesAdvancedLast10s: (last.frames ?? 0) - (tenAgo.frames ?? 0),
  audio: last.audio,
  status: last.status,
  hosting: hostSync.includes('capturing stream'),
  hostTaps,
  promptVisibleAtEnd: last.gesturePrompt,
  audioStallLogged: hostSync.includes('BOOT-AUDIO-STALL'),
  samples,
};
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, samples: samples.filter((_, i) => i % 5 === 0) }, null, 2));
await browser.close();
const problems = [];
if (!summary.hosting) problems.push('host never started capturing (boot stalled)');
if (summary.framesAdvancedLast10s <= 0) problems.push('host frame count not advancing');
if (SUSPEND && !GATE_RESUME) {
  if (!summary.audioStallLogged) problems.push('no BOOT-AUDIO-STALL logged (watchdog never fired)');
  if (summary.audio !== 'running') problems.push(`core audio context ${summary.audio || 'missing'}, not running`);
  if (summary.promptVisibleAtEnd) problems.push('tap prompt still covering the game after boot recovered on its own');
} else if (SUSPEND) {
  if (!summary.audioStallLogged) problems.push('no BOOT-AUDIO-STALL logged (watchdog never fired)');
  if (hostTaps !== 1) problems.push(`host needed ${hostTaps} taps (expected 1)`);
  if (summary.promptVisibleAtEnd) problems.push('tap prompt still visible at the end');
  if (summary.audio !== 'running') problems.push(`core audio context ${summary.audio || 'missing'}, not running`);
} else {
  if (summary.audioStallLogged) problems.push('BOOT-AUDIO-STALL logged without a suspended context');
  if (hostTaps !== 0) problems.push(`host was prompted ${hostTaps} times (expected 0)`);
}
for (const p of problems) console.log(`FAIL: ${p}`);
process.exit(problems.length ? 1 : 0);
