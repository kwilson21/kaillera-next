import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fitsFlush } from '../../web/src/flush-fit.ts';
import { inputEqual, type WireInput } from '../../web/src/input-wire.ts';
import { classifyRunnerStep } from '../../web/src/runner-step.ts';
import { stepAxis, type AxisState } from '../../web/src/stick-axis.ts';
import { createStickDeadband } from '../../web/src/stick-deadband.ts';
import { createSyncLogRing } from '../../web/src/sync-log-ring.ts';
import { createShared } from '../../web/src/page/shared.ts';
import { lcg } from './load-shared.ts';

const stick = (lx: number, ly = 0, cx = 0, cy = 0): WireInput => ({ buttons: 0, lx, ly, cx, cy });

// ── Stick dead-band ───────────────────────────────────────────────────────

test('stepAxis keeps its contract for every small state and read', () => {
  // The same properties the verifier proves for all integers, run here so a
  // failure shows a concrete case and the test does not depend on CI.
  for (let band = 1; band <= 4; band++) {
    for (let settleFrames = 1; settleFrames <= 5; settleFrames++) {
      for (let held = -6; held <= 6; held++) {
        for (let cand = -6; cand <= 6; cand++) {
          for (let count = 0; count < settleFrames; count++) {
            for (let raw = -8; raw <= 8; raw++) {
              const state: AxisState = { held, cand, count };
              const next = stepAxis(state, raw, band, settleFrames);
              const where = JSON.stringify({ state, raw, band, settleFrames, next });
              if (next.held !== raw && next.held !== held) assert.fail(`invented a value: ${where}`);
              if (raw === 0 && next.held !== 0) assert.fail(`centering held back: ${where}`);
              if (Math.abs(raw - held) >= band && next.held !== raw) assert.fail(`big move held back: ${where}`);
              if (raw === cand && count + 1 >= settleFrames && next.held !== raw) assert.fail(`settled: ${where}`);
              if (next.held === raw && next.count !== 0) assert.fail(`count kept: ${where}`);
              if (next.count < 0 || next.count >= settleFrames) assert.fail(`count out of range: ${where}`);
            }
          }
        }
      }
    }
  }
});

test('no value is held back for more than settleFrames reads', () => {
  for (let settleFrames = 1; settleFrames <= 6; settleFrames++) {
    for (let from = -83; from <= 83; from++) {
      for (const step of [-1, 1]) {
        const f = createStickDeadband({ band: 2, settleFrames });
        f(stick(from));
        const target = from + step;
        let out = from;
        for (let n = 0; n < settleFrames; n++) out = f(stick(target)).lx;
        if (out !== target) assert.fail(`from=${from} to=${target} settleFrames=${settleFrames} gave ${out}`);
      }
    }
  }
});

// The digests below are of what the code built into web/static/shared.js
// returned for the same calls, taken from that script at d7dc88c, the last
// commit that had it. Each function was compared with it call by call until
// then.
const LEGACY_DEADBAND_DIGEST = '90a833e34fde1039f40449f4a5014cf128353ec815ebe153873e70a6b0c15c86';
const LEGACY_RING_DIGEST = 'fdc2f67635c4a07a981c041d778a093988f969cbe0d8859a0e32089ea323c58a';

test('the filter matches the plain-JavaScript one it replaced, read for read', () => {
  const hash = createHash('sha256');
  const next = lcg(53);
  const settings = [
    undefined,
    { band: 2, settleFrames: 4 },
    { band: 1, settleFrames: 1 },
    { band: 5, settleFrames: 2 },
  ];
  for (const options of settings) {
    const filter = createStickDeadband(options);
    let centre = 0;
    for (let n = 0; n < 20000; n++) {
      const r = next() % 100;
      // Mostly jitter around a centre that sometimes jumps, the shape a held
      // stick has; now and then a release, a fractional read or a reset.
      if (r < 3) centre = (next() % 167) - 83;
      const axis = (): number => (r === 3 ? 0 : centre + (next() % 5) - 2 + (r === 4 ? 0.5 : 0));
      const input = { buttons: next() | 0, lx: axis(), ly: axis(), cx: axis(), cy: axis(), extra: n };
      if (r === 5) filter.reset();
      hash.update(JSON.stringify(filter(input)));
    }
  }
  assert.equal(hash.digest('hex'), LEGACY_DEADBAND_DIGEST);
});

test('the filter returns a new object and keeps the fields it does not filter', () => {
  const f = createStickDeadband();
  const input = { buttons: 9, lx: 40, ly: -40, cx: 0, cy: 0, frame: 7 };
  const out = f(input);
  assert.notEqual(out, input);
  assert.deepStrictEqual(out, input);
});

// ── Sync log ring ─────────────────────────────────────────────────────────

test('the sync log ring matches the plain-JavaScript one it replaced', () => {
  const hash = createHash('sha256');
  const next = lcg(1024);
  for (const maxSize of [1, 2, 7, 64]) {
    const ring = createSyncLogRing(maxSize);
    for (let n = 0; n < 3000; n++) {
      const r = next() % 100;
      if (r < 70) {
        ring.push({ t: (next() % 100000) / 7, f: next() % 5000, msg: 'x'.repeat(next() % 40) + n });
      } else if (r < 72) {
        ring.clear();
      } else if (r < 86) {
        const after = (next() % (maxSize * 3)) - 2;
        const max = 1 + (next() % 10);
        const maxBytes = r % 2 === 0 ? undefined : 64 + (next() % 400);
        hash.update(JSON.stringify(ring.entriesAfter(after, max, maxBytes)));
      } else {
        hash.update(ring.export());
      }
      hash.update(String(ring.length));
    }
  }
  assert.equal(hash.digest('hex'), LEGACY_RING_DIGEST);
});

test('clearing the ring restarts the numbering under a new epoch', () => {
  const ring = createSyncLogRing(4);
  const first = ring.epoch;
  ring.push({ t: 1, f: 1, msg: 'a' });
  ring.push({ t: 2, f: 2, msg: 'b' });
  assert.equal(ring.epoch, first);
  ring.clear();
  assert.notEqual(ring.epoch, first);
  assert.equal(ring.length, 0);
  ring.push({ t: 3, f: 3, msg: 'c' });
  assert.deepStrictEqual(ring.entriesAfter(-1, 10), [{ seq: 0, t: 3, f: 3, msg: 'c' }]);
});

test('one oversized line is still flushed, alone', () => {
  const ring = createSyncLogRing(4);
  ring.push({ t: 0, f: 0, msg: 'y'.repeat(500) });
  ring.push({ t: 0, f: 0, msg: 'z' });
  assert.equal(ring.entriesAfter(-1, 10, 100).length, 1);
  assert.equal(ring.entriesAfter(0, 10, 100)[0]?.msg, 'z');
});

test('the first entry always fits a flush; later ones only within the byte budget', () => {
  assert.equal(fitsFlush(0, 0, 5000, 100), true);
  assert.equal(fitsFlush(1, 40, 60, 100), true);
  assert.equal(fitsFlush(1, 40, 61, 100), false);
  assert.equal(fitsFlush(3, 0, 0, 0), true);
});

// ── Runner step and input comparison ──────────────────────────────────────

test('classifyRunnerStep decides as the plain-JavaScript rule did on every kind of argument', () => {
  // The rule as web/static/shared.js had it.
  const rule = (rescheduled: boolean, before: number | null | undefined, after: number | null | undefined): string => {
    if (before == null || after == null) return 'unknown';
    if (!rescheduled && after === before) return 'stale';
    return 'emulated';
  };
  const cycles = [null, undefined, 0, 3.2, 8.65];
  for (const rescheduled of [true, false]) {
    for (const before of cycles) {
      for (const after of cycles) {
        assert.equal(
          classifyRunnerStep(rescheduled, before, after),
          rule(rescheduled, before, after),
          `${rescheduled} ${before} ${after}`,
        );
      }
    }
  }
  assert.equal(classifyRunnerStep(false, 0, 0), 'stale');
  assert.equal(classifyRunnerStep(true, 0, 0), 'emulated');
  assert.equal(classifyRunnerStep(false, 3.2, 11.85), 'emulated');
  assert.equal(classifyRunnerStep(false, null, 5), 'unknown');
});

test('inputEqual compares every field', () => {
  const base: WireInput = { buttons: 3, lx: 1, ly: 2, cx: 3, cy: 4 };
  const variants: WireInput[] = [
    base,
    { ...base },
    { ...base, buttons: 4 },
    { ...base, lx: 0 },
    { ...base, ly: 0 },
    { ...base, cx: 0 },
    { ...base, cy: 0 },
  ];
  variants.forEach((a, i) => {
    variants.forEach((b, j) => {
      // The first two are the same input; every other pair differs in a field.
      assert.equal(inputEqual(a, b), i === j || (i < 2 && j < 2), `${i} ${j}`);
    });
  });
  assert.equal(inputEqual(base, { ...base }), true);
  assert.equal(inputEqual(base, { ...base, cy: 5 }), false);
});

// ── KNShared ──────────────────────────────────────────────────────────────

test('KNShared carries these helpers themselves', () => {
  const shared = createShared();
  assert.equal(shared.inputEqual, inputEqual);
  assert.equal(shared.createSyncLogRing, createSyncLogRing);
  assert.equal(shared.createStickDeadband, createStickDeadband);
  assert.equal(shared.classifyRunnerStep, classifyRunnerStep);
  // The engine calls it with no options.
  assert.equal(shared.createStickDeadband()(stick(40)).lx, 40);
});

test('building KNShared touches nothing on the page', () => {
  // No window or document exists here; createShared would throw if it read one.
  assert.equal(typeof window, 'undefined');
  assert.equal(createShared().N64_MAX, 83);
});
