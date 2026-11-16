import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNCore } from '../../web/src/index.ts';
import { digestFrame, NO_DIGEST } from '../../web/src/desync-confirm.ts';

test('the frame reported is one rollback window behind the tick', () => {
  assert.equal(digestFrame(28, 22, 6), 6);
  assert.equal(digestFrame(22, 22, 6), 0);
  assert.equal(digestFrame(122, 22, 1), 100);
});

test('nothing is reported until a full window has been simulated', () => {
  for (let tick = 0; tick < 22; tick++) assert.equal(digestFrame(tick, 22, 1), NO_DIGEST);
});

test('only frames on the cadence are reported', () => {
  const reported = [];
  for (let tick = 0; tick < 60; tick++) {
    const frame = digestFrame(tick, 22, 6);
    if (frame !== NO_DIGEST) reported.push(frame);
  }
  assert.deepEqual(reported, [0, 6, 12, 18, 24, 30, 36]);
});

test('with no rollback window (strict lockstep) the tick itself is reported', () => {
  assert.equal(digestFrame(12, 0, 6), 12);
  assert.equal(digestFrame(13, 0, 6), NO_DIGEST);
});

test('two peers with different windows report the same frames', () => {
  const frames = (window: number) => {
    const out = new Set<number>();
    for (let tick = 0; tick < 200; tick++) {
      const frame = digestFrame(tick, window, 6);
      if (frame !== NO_DIGEST && frame <= 150) out.add(frame);
    }
    return [...out];
  };
  assert.deepEqual(frames(12), frames(22));
});

test('the plain-script pages reach it through KNCore', () => {
  assert.equal(KNCore.digestFrame, digestFrame);
});
