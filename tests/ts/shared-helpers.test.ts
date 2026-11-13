import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inputEqual, type WireInput } from '../../web/src/input-wire.ts';
import { classifyRunnerStep } from '../../web/src/runner-step.ts';
import { stepAxis, type AxisState } from '../../web/src/stick-axis.ts';
import { createStickDeadband } from '../../web/src/stick-deadband.ts';
import { createSyncLogRing } from '../../web/src/sync-log-ring.ts';
import { lcg, loadShared, plain } from './load-shared.ts';

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

test('the filter matches the one built into shared.js, read for read', () => {
  const legacy = loadShared();
  const next = lcg(53);
  const settings = [
    undefined,
    { band: 2, settleFrames: 4 },
    { band: 1, settleFrames: 1 },
    { band: 5, settleFrames: 2 },
  ];
  for (const options of settings) {
    const ours = createStickDeadband(options);
    const theirs = legacy.createStickDeadband(options);
    let centre = 0;
    for (let n = 0; n < 20000; n++) {
      const r = next() % 100;
      // Mostly jitter around a centre that sometimes jumps, the shape a held
      // stick has; now and then a release, a fractional read or a reset.
      if (r < 3) centre = (next() % 167) - 83;
      const axis = (): number => (r === 3 ? 0 : centre + (next() % 5) - 2 + (r === 4 ? 0.5 : 0));
      const input = { buttons: next() | 0, lx: axis(), ly: axis(), cx: axis(), cy: axis(), extra: n };
      if (r === 5) {
        ours.reset();
        theirs.reset();
      }
      assert.deepStrictEqual(ours(input), plain(theirs(input)), `read ${n} options=${JSON.stringify(options)}`);
    }
  }
});

test('the filter returns a new object and keeps the fields it does not filter', () => {
  const f = createStickDeadband();
  const input = { buttons: 9, lx: 40, ly: -40, cx: 0, cy: 0, frame: 7 };
  const out = f(input);
  assert.notEqual(out, input);
  assert.deepStrictEqual(out, input);
});

// ── Sync log ring ─────────────────────────────────────────────────────────

test('the sync log ring matches the one built into shared.js', () => {
  const legacy = loadShared();
  const next = lcg(1024);
  for (const maxSize of [1, 2, 7, 64]) {
    const ours = createSyncLogRing(maxSize);
    const theirs = legacy.createSyncLogRing(maxSize);
    for (let n = 0; n < 3000; n++) {
      const r = next() % 100;
      if (r < 70) {
        const entry = { t: (next() % 100000) / 7, f: next() % 5000, msg: 'x'.repeat(next() % 40) + n };
        ours.push(entry);
        theirs.push(entry);
      } else if (r < 72) {
        ours.clear();
        theirs.clear();
      } else if (r < 86) {
        const after = (next() % (maxSize * 3)) - 2;
        const max = 1 + (next() % 10);
        const maxBytes = r % 2 === 0 ? undefined : 64 + (next() % 400);
        assert.deepStrictEqual(
          ours.entriesAfter(after, max, maxBytes),
          plain(theirs.entriesAfter(after, max, maxBytes)),
          `entriesAfter(${after}, ${max}, ${maxBytes}) at op ${n}, maxSize=${maxSize}`,
        );
      } else {
        assert.equal(ours.export(), theirs.export(), `export at op ${n}, maxSize=${maxSize}`);
      }
      assert.equal(ours.length, theirs.length);
    }
  }
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

// ── Runner step and input comparison ──────────────────────────────────────

test('classifyRunnerStep agrees with shared.js on every kind of argument', () => {
  const legacy = loadShared();
  const cycles = [null, undefined, 0, 3.2, 8.65];
  for (const rescheduled of [true, false]) {
    for (const before of cycles) {
      for (const after of cycles) {
        assert.equal(
          classifyRunnerStep(rescheduled, before, after),
          legacy.classifyRunnerStep(rescheduled, before, after),
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

test('inputEqual compares every field, as shared.js does', () => {
  const legacy = loadShared();
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
  for (const a of variants) {
    for (const b of variants) {
      assert.equal(inputEqual(a, b), legacy.inputEqual(a, b));
    }
  }
  assert.equal(inputEqual(base, { ...base }), true);
  assert.equal(inputEqual(base, { ...base, cy: 5 }), false);
});

// ── Delegation ────────────────────────────────────────────────────────────

test('shared.js uses KNCore for each helper when the bundle is loaded', () => {
  const calls: string[] = [];
  const shared = loadShared({
    inputEqual: (a, b) => {
      calls.push('inputEqual');
      return inputEqual(a, b);
    },
    createSyncLogRing: (maxSize) => {
      calls.push('createSyncLogRing');
      return createSyncLogRing(maxSize);
    },
    createStickDeadband: (options) => {
      calls.push(`createStickDeadband ${JSON.stringify(options)}`);
      return createStickDeadband(options);
    },
    classifyRunnerStep: (rescheduled, before, after) => {
      calls.push('classifyRunnerStep');
      return classifyRunnerStep(rescheduled, before, after);
    },
  });
  assert.equal(shared.inputEqual(stick(1), stick(1)), true);
  assert.equal(shared.createSyncLogRing(8).length, 0);
  // The engine calls it with no options; the defaults must reach KNCore.
  assert.equal(shared.createStickDeadband()(stick(40)).lx, 40);
  assert.equal(shared.classifyRunnerStep(false, 1, 1), 'stale');
  assert.deepEqual(calls, [
    'inputEqual',
    'createSyncLogRing',
    'createStickDeadband {"band":2,"settleFrames":4}',
    'classifyRunnerStep',
  ]);
});
