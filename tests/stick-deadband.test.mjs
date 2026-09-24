// KNShared.createStickDeadband: the local stick filter that keeps held-stick
// jitter from mispredicting now that the rollback engine matches stick
// predictions exactly. Deliberate inputs must come through exactly (SSB64
// thresholds such as tap-jump at 53 sit one unit apart from their
// neighbours), centering must be exact, and alternating jitter must not.
//
//   node --test tests/stick-deadband.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

globalThis.window = globalThis;
await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/static/shared.js'));
const { createStickDeadband } = globalThis.KNShared;

const run = (filter, lxs) => lxs.map((lx) => filter({ buttons: 0, lx, ly: 0, cx: 0, cy: 0 }).lx);

test('jitter around a held value is suppressed', () => {
  const f = createStickDeadband();
  const out = run(f, [70, 71, 70, 69, 70, 71, 70, 71, 69, 70]);
  assert.deepEqual(out, Array(10).fill(70));
});

test('moves of at least the band pass through exactly', () => {
  const f = createStickDeadband();
  assert.deepEqual(run(f, [0, 20, 53, 56, 80, -80]), [0, 20, 53, 56, 80, -80]);
});

test('a deliberate one-unit move onto a threshold settles through', () => {
  const f = createStickDeadband({ band: 2, settleFrames: 4 });
  // Held at 52, the stick eases to 53 (tap-jump) and stays there.
  const out = run(f, [52, 53, 53, 53, 53, 53]);
  assert.deepEqual(out, [52, 52, 52, 52, 53, 53]);
});

test('a one-unit move that keeps flickering never settles', () => {
  const f = createStickDeadband({ band: 2, settleFrames: 4 });
  const out = run(f, [52, 53, 52, 53, 52, 53, 52, 53]);
  assert.deepEqual(out, Array(8).fill(52));
});

test('centering always returns exactly 0', () => {
  const f = createStickDeadband();
  assert.deepEqual(run(f, [1, 0]), [0, 0]); // 1 is inside the band from 0
  assert.deepEqual(run(f, [40, 41, 0]), [40, 40, 0]); // jitter held, then exact 0
});

test('a slow one-unit-per-frame ramp lags by at most the band', () => {
  const f = createStickDeadband({ band: 2, settleFrames: 4 });
  const raw = Array.from({ length: 30 }, (_, i) => i + 30);
  const out = run(f, raw);
  out.forEach((v, i) => assert.ok(raw[i] - v >= 0 && raw[i] - v < 2, `f${i}: raw ${raw[i]} out ${v}`));
  assert.equal(out[out.length - 1] >= raw[raw.length - 1] - 1, true);
});

test('each axis is filtered independently and buttons pass through', () => {
  const f = createStickDeadband();
  f({ buttons: 0, lx: 70, ly: -70, cx: 0, cy: 0 });
  const out = f({ buttons: 5, lx: 71, ly: -60, cx: 83, cy: 0 });
  assert.deepEqual(out, { buttons: 5, lx: 70, ly: -60, cx: 83, cy: 0 });
});

test('reset forgets held values', () => {
  const f = createStickDeadband();
  run(f, [70]);
  f.reset();
  assert.deepEqual(run(f, [1]), [0]);
});
