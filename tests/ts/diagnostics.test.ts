import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import {
  audioTransition,
  hashPixels,
  measureCanvasHealth,
  screenshotCrop,
  type Crop,
} from '../../web/src/diagnostics.ts';
import type { CanvasSample, Diagnostics } from '../../web/src/page/diagnostics.ts';
import { lcg, plain } from './load-shared.ts';

const solid = (r: number, g: number, b: number, pixels = 32 * 24): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
  return data;
};

test('a flat pale green canvas is solid pale; a game frame is not', () => {
  assert.equal(measureCanvasHealth(solid(215, 225, 190)).solidPale, true);
  assert.equal(measureCanvasHealth(solid(170, 180, 120)).solidPale, true);
  assert.equal(measureCanvasHealth(solid(0, 0, 0)).solidPale, false);
  assert.equal(measureCanvasHealth(solid(255, 255, 255)).solidPale, false);
  const next = lcg(9);
  const noise = new Uint8ClampedArray(32 * 24 * 4).map(() => next() % 256);
  assert.equal(measureCanvasHealth(noise).solidPale, false);
});

test('canvas health reports rounded means and the spread', () => {
  const data = solid(10, 20, 30, 2);
  data.set([20, 40, 60, 255], 4);
  assert.deepStrictEqual(measureCanvasHealth(data), {
    meanR: 15,
    meanG: 30,
    meanB: 45,
    brightness: 30,
    stdev: 10.8,
    range: 50,
    paleRatio: 0,
    yellowGreenRatio: 0,
    solidPale: false,
  });
});

test('the pixel hash ignores low bits and unsampled pixels, and sees the rest', () => {
  const base = solid(64, 128, 192, 64);
  const lowBits = solid(64 + 15, 128 + 15, 192 + 15, 64);
  assert.equal(hashPixels(lowBits), hashPixels(base));
  const unsampled = solid(64, 128, 192, 64);
  unsampled.set([0, 0, 0, 255], 4);
  assert.equal(hashPixels(unsampled), hashPixels(base));
  const sampled = solid(64, 128, 192, 64);
  sampled.set([0, 0, 0, 255], 16 * 4);
  assert.notEqual(hashPixels(sampled), hashPixels(base));
  assert.equal(hashPixels(new Uint8Array(0)), 2166136261);
});

test('a screenshot takes the centred 4:3 part of the canvas', () => {
  assert.deepStrictEqual(screenshotCrop(640, 480), { sx: 0, sy: 0, sw: 640, sh: 480 });
  assert.deepStrictEqual(screenshotCrop(1920, 1080), { sx: 240, sy: 0, sw: 1440, sh: 1080 });
  assert.deepStrictEqual(screenshotCrop(480, 640), { sx: 0, sy: 140, sw: 480, sh: 360 });
  for (const [w, h] of [
    [1280, 720],
    [320, 240],
    [333, 777],
    [2560, 1080],
  ] as const) {
    const c = screenshotCrop(w, h);
    assert.ok(c.sx >= 0 && c.sy >= 0 && c.sx + c.sw <= w && c.sy + c.sh <= h, `${w}x${h} stays inside`);
    assert.ok(Math.abs(c.sw / c.sh - 4 / 3) < 0.01, `${w}x${h} is 4:3`);
  }
});

test('audio transitions: only leaving and re-entering running are reported', () => {
  assert.equal(audioTransition('', 'running'), null);
  assert.equal(audioTransition('', 'suspended'), null);
  assert.equal(audioTransition('running', 'suspended'), 'stall');
  assert.equal(audioTransition('running', 'none'), 'stall');
  assert.equal(audioTransition('suspended', 'running'), 'resume');
  assert.equal(audioTransition('suspended', 'closed'), null);
  assert.equal(audioTransition('running', 'running'), null);
});

// ── window.KNDiag (web/src/page/diagnostics.ts) ───────────────────────────

interface DiagWindow {
  KNDiag?: Diagnostics;
  KNCapture: { allowed: () => boolean };
  KNAudio: { ctx: { state: string } };
  addEventListener: () => void;
}
interface GameCanvas {
  width: number;
  height: number;
  clientWidth: number;
  clientHeight: number;
  getContext: () => null;
}
interface Observed {
  health: (CanvasSample | null)[];
  hashes: number[];
  crops: Crop[];
  log: string[];
}

/**
 * The page script as the bundle carries it: the module and what it imports,
 * as one classic script that installs `window.KNDiag` when run.
 */
const pageScript = (): string => {
  const built = buildSync({
    stdin: {
      contents: "import { installDiagnostics } from './web/src/page/diagnostics.ts'; installDiagnostics();",
      resolveDir: fileURLToPath(new URL('../..', import.meta.url)),
    },
    bundle: true,
    format: 'iife',
    write: false,
  });
  return built.outputFiles[0]?.text ?? '';
};

/**
 * Run the diagnostics against a scripted canvas and audio context and
 * return what they measured, cropped and logged.
 */
const runDiagnostics = (): Observed => {
  const next = lcg(77);
  let pixels = new Uint8ClampedArray(0);
  const seen: Observed = { health: [], hashes: [], crops: [], log: [] };
  const game: GameCanvas = { width: 640, height: 480, clientWidth: 640, clientHeight: 480, getContext: () => null };
  const scratch = () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage: (_canvas: GameCanvas, sx: number, sy: number, sw: number, sh: number, ...dest: number[]) => {
        // The nine-argument form is the screenshot's cropped copy.
        if (dest.length === 4) seen.crops.push({ sx, sy, sw, sh });
      },
      getImageData: () => ({ data: pixels }),
    }),
    toDataURL: () => `data:image/jpeg;base64,${'A'.repeat(200)}`,
  });
  const window: DiagWindow = {
    KNCapture: { allowed: () => true },
    KNAudio: { ctx: { state: 'running' } },
    addEventListener: () => undefined,
  };
  const document = { querySelector: () => game, createElement: scratch, hasFocus: () => true };
  vm.runInContext(pageScript(), vm.createContext({ window, document, navigator: {}, console, CustomEvent }));
  const diag = window.KNDiag;
  assert.ok(diag, 'the page script did not define window.KNDiag');

  let frame = 0;
  diag.init({ log: (line) => seen.log.push(line), getFrame: () => frame, sendScreenshot: () => undefined });

  // Canvas samples: noise, flat colours near the solid-pale thresholds, and
  // flat colours with a little noise on top.
  for (let n = 0; n < 400; n++) {
    const kind = n % 4;
    const base = [140 + (next() % 100), 140 + (next() % 100), 100 + (next() % 110)];
    pixels = new Uint8ClampedArray(32 * 24 * 4).map((_, i) => {
      if (i % 4 === 3) return 255;
      if (kind === 0) return next() % 256;
      return base[i % 4]! + (kind === 1 ? 0 : (next() % (kind * 20)) - kind * 10);
    });
    seen.health.push(diag.sampleCanvasHealth());
    seen.hashes.push(diag.captureCanvasHash());
  }

  // Screenshots from canvases of many shapes.
  for (let n = 0; n < 200; n++) {
    frame = 1000 + n;
    game.width = 1 + (next() % 2000);
    game.height = 1 + (next() % 1500);
    diag.captureAndSendScreenshot();
  }

  // The freeze check once a second while the audio state changes and the
  // canvas sometimes stops changing.
  game.width = 640;
  game.height = 480;
  const states = ['running', 'suspended', 'running', 'interrupted', 'closed', 'running'];
  for (let second = 6; second < 200; second++) {
    frame = second * 60;
    if (second % 7 === 0) window.KNAudio.ctx.state = states[(second / 7) % states.length]!;
    if (second % 13 < 5) pixels = pixels.map(() => next() % 256);
    diag.checkFreeze({ buttons: second % 50 === 0 ? 1 : 0, lx: 0, ly: 0, cx: 0, cy: 0 });
  }
  // Each run has its own vm context, so its objects have their own
  // prototypes; copy them into this realm to compare runs.
  return plain(seen);
};

const digestOf = (seen: Observed): string => createHash('sha256').update(JSON.stringify(seen)).digest('hex');

// What kn-diagnostics.js produced for this script at ff53345, while it was a
// plain script with its own arithmetic.
const GOLDEN = {
  health: 400,
  crops: 200,
  log: 27,
  sha256: '43d1faf77321ba3ea4a1e4e0131a63232c0ac29c724954f07b636ef5a171b167',
};

test('window.KNDiag measures, crops and logs what kn-diagnostics.js did', () => {
  const seen = runDiagnostics();
  assert.equal(seen.health.length, GOLDEN.health);
  assert.equal(seen.crops.length, GOLDEN.crops);
  assert.equal(seen.log.length, GOLDEN.log);
  assert.equal(digestOf(seen), GOLDEN.sha256);
  // The script must reach every kind of line it is meant to compare.
  for (const kind of ['RENDER-STALL', 'AUDIO-STALL', 'AUDIO-RESUME', 'CANVAS-HEALTH', 'INPUT-DEAD']) {
    assert.ok(
      seen.log.some((line) => line.startsWith(kind)),
      `no ${kind} line in the script`,
    );
  }
  const solid = seen.health.map((h) => h !== null && !('error' in h) && h.solidPale);
  assert.ok(solid.includes(true) && solid.includes(false));
});
