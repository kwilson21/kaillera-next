// Pure state-machine tests for web/static/rollback-timeline.js — the demo
// page's live Rollback timeline (docs/landing-design.md §5.7f #3, §7.2 M3).
// No DOM: only createState/reduce/clampDepth, driven with explicit `now`
// timestamps so the tests are deterministic.
//
//   node --test tests/rollback-timeline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

await import(path.join(path.dirname(fileURLToPath(import.meta.url)), '../web/static/rollback-timeline.js'));
const { createState, reduce, clampDepth } = globalThis.KNRollbackTimeline;

const baseInput = (overrides) =>
  Object.assign(
    { mode: 'rollback', matchActive: true, rollbackEventsTotal: 0, avgRollbackDepth: 0, delay: 2 },
    overrides,
  );

test('idle before a match: head does not move, no rewind', () => {
  let s = createState();
  s = reduce(s, baseInput({ matchActive: false }), 0);
  s = reduce(s, baseInput({ matchActive: false }), 1000);
  assert.equal(s.headIndex, 0);
  assert.equal(s.phase, 'idle');
  assert.deepEqual(s.tickState, new Array(11).fill('idle'));
});

test('rollback mode: head advances at a steady pace with no rollbacks', () => {
  let s = createState();
  s = reduce(s, baseInput(), 0); // enters match, phase -> advance
  assert.equal(s.phase, 'advance');
  s = reduce(s, baseInput(), 600); // past the 550ms advance interval
  assert.equal(s.headIndex, 1);
  s = reduce(s, baseInput(), 1150);
  assert.equal(s.headIndex, 2);
});

test('a real rollback event (rollbackEventsTotal increasing) triggers a rewind', () => {
  let s = createState();
  s = reduce(s, baseInput(), 0);
  s = reduce(s, baseInput(), 600); // headIndex -> 1
  assert.equal(s.headIndex, 1);

  // Engine reports one misprediction with depth ~3.
  s = reduce(s, baseInput({ rollbackEventsTotal: 1, avgRollbackDepth: 3 }), 650);
  assert.equal(s.phase, 'rewind-bad');
  assert.equal(s.rewindDepth, 3);
  assert.equal(s.label.kind, 'bad');
  // The 3 ticks behind the head (indices 1, 0, 10) are marked bad.
  assert.deepEqual(s.rewindIdx.slice().sort(), [0, 1, 10]);
  s.rewindIdx.forEach((ix) => assert.equal(s.tickState[ix], 'bad'));

  // Still within the "bad" window: no further state change from mere time.
  s = reduce(s, baseInput({ rollbackEventsTotal: 1, avgRollbackDepth: 3 }), 700);
  assert.equal(s.phase, 'rewind-bad');

  // Past REWIND_BAD_MS (260ms) -> flips to replay (blue).
  s = reduce(s, baseInput({ rollbackEventsTotal: 1, avgRollbackDepth: 3 }), 950);
  assert.equal(s.phase, 'rewind-replay');
  assert.equal(s.label.kind, 'replay');
  s.rewindIdx.forEach((ix) => assert.equal(s.tickState[ix], 'replay'));

  // Step through the replay (REPLAY_STEP_MS = 220ms per tick, 3 ticks).
  s = reduce(s, baseInput({ rollbackEventsTotal: 1, avgRollbackDepth: 3 }), 1180);
  assert.equal(s.rewindReplayed, 1);
  s = reduce(s, baseInput({ rollbackEventsTotal: 1, avgRollbackDepth: 3 }), 1410);
  assert.equal(s.rewindReplayed, 2);
  s = reduce(s, baseInput({ rollbackEventsTotal: 1, avgRollbackDepth: 3 }), 1640);
  // Replay finished: back to normal advancing, ticks cleared, no label.
  assert.equal(s.phase, 'advance');
  assert.equal(s.label, null);
  assert.deepEqual(s.tickState, new Array(11).fill('idle'));
});

test('a second rollback does not interrupt an in-progress rewind', () => {
  let s = createState();
  s = reduce(s, baseInput(), 0);
  s = reduce(s, baseInput({ rollbackEventsTotal: 1, avgRollbackDepth: 2 }), 10);
  assert.equal(s.phase, 'rewind-bad');
  const depthDuringFirst = s.rewindDepth;
  // rollbackEventsTotal jumps again mid-rewind — should be absorbed once
  // the current rewind finishes, not stack a second animation on top.
  s = reduce(s, baseInput({ rollbackEventsTotal: 2, avgRollbackDepth: 4 }), 20);
  assert.equal(s.phase, 'rewind-bad');
  assert.equal(s.rewindDepth, depthDuringFirst);
});

test('lockstep mode: playhead waits per tick, longer wait at higher delay, and never marks a rewind', () => {
  let s = createState();
  s = reduce(s, baseInput({ mode: 'lockstep', delay: 6 }), 0);
  assert.equal(s.phase, 'lockstep-wait');
  assert.equal(s.label.kind, 'wait');
  // waitMs = 260 + 6*90 = 800
  s = reduce(s, baseInput({ mode: 'lockstep', delay: 6 }), 500);
  assert.equal(s.headIndex, 0); // still waiting
  s = reduce(s, baseInput({ mode: 'lockstep', delay: 6 }), 850);
  assert.equal(s.headIndex, 1); // wait elapsed, advanced once
  // Never any red/blue in lockstep, however long it runs.
  assert.deepEqual(s.tickState, new Array(11).fill('idle'));

  // Higher delay -> longer wait before the next advance.
  let low = createState();
  low = reduce(low, baseInput({ mode: 'lockstep', delay: 0 }), 0);
  low = reduce(low, baseInput({ mode: 'lockstep', delay: 0 }), 270); // waitMs=260
  assert.equal(low.headIndex, 1);
});

test('switching mode mid-match resets the animation cleanly', () => {
  let s = createState();
  s = reduce(s, baseInput({ mode: 'rollback', rollbackEventsTotal: 0 }), 0); // enter match
  s = reduce(s, baseInput({ mode: 'rollback', rollbackEventsTotal: 1, avgRollbackDepth: 2 }), 1);
  assert.equal(s.phase, 'rewind-bad');
  s = reduce(s, baseInput({ mode: 'lockstep', delay: 2 }), 5);
  assert.equal(s.mode, 'lockstep');
  assert.equal(s.phase, 'lockstep-wait');
  assert.deepEqual(s.tickState, new Array(11).fill('idle'));
  assert.equal(s.rewindDepth, 0);
});

test('leaving a match then starting a new one does not replay stale rollback counts', () => {
  let s = createState();
  s = reduce(s, baseInput({ rollbackEventsTotal: 5 }), 0); // match 1, 5 rollbacks already happened
  s = reduce(s, baseInput({ matchActive: false, rollbackEventsTotal: 5 }), 100); // match ends
  s = reduce(s, baseInput({ matchActive: true, rollbackEventsTotal: 5 }), 200); // match 2 starts, counter didn't reset
  assert.equal(s.phase, 'advance');
  assert.notEqual(s.phase, 'rewind-bad');
});

test('clampDepth keeps a rewind within the visible ring', () => {
  assert.equal(clampDepth(0, 11), 1);
  assert.equal(clampDepth(1, 11), 1);
  assert.equal(clampDepth(3.4, 11), 3);
  assert.equal(clampDepth(20, 11), 4); // clamped to the max visual depth
  assert.equal(clampDepth(20, 5), 3); // small track: trackTicks-2
});
