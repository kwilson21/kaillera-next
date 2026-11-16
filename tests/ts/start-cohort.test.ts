import assert from 'node:assert/strict';
import { test } from 'node:test';

import { heldAsLateJoiner } from '../../web/src/start-cohort.ts';

test('while players are still loading, a newcomer is part of the start', () => {
  assert.equal(heldAsLateJoiner(false, false, false, false), false);
});

test('once the initial sync has begun, only its cohort is waited for', () => {
  assert.equal(heldAsLateJoiner(false, true, true, false), false);
  assert.equal(heldAsLateJoiner(false, true, false, false), true);
});

test('in a running match, a slot that is not playing yet is a late joiner', () => {
  assert.equal(heldAsLateJoiner(true, false, false, false), true);
  assert.equal(heldAsLateJoiner(true, false, true, true), false);
});
