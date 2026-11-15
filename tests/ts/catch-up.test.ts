import { test } from 'node:test';
import assert from 'node:assert/strict';

import { catchUpStep } from '../../web/src/catch-up.ts';
import { KNCore } from '../../web/src/index.ts';

test('a state from this frame or later is applied as before', () => {
  assert.equal(catchUpStep(120, 120, 300), 'apply');
  assert.equal(catchUpStep(125, 120, 300), 'apply');
});

test('a state from before the guest is caught up from, up to the bound', () => {
  // The boot sync's answer in a healthy run: the host's 126, the guest at 163.
  assert.equal(catchUpStep(126, 163, 300), 'catchUp');
  // The run that split: the held answer, 272 frames back.
  assert.equal(catchUpStep(124, 396, 300), 'catchUp');
  assert.equal(catchUpStep(100, 400, 300), 'catchUp');
});

test('a state further back than the bound is refused', () => {
  assert.equal(catchUpStep(99, 400, 300), 'refuse');
  assert.equal(catchUpStep(0, 1, 0), 'refuse');
});

test('the page reaches it through KNCore', () => {
  assert.equal(KNCore.catchUpStep, catchUpStep);
});
