import { test } from 'node:test';
import assert from 'node:assert/strict';

import { framesToSendAgain } from '../../web/src/input-resend.ts';
import { KNCore } from '../../web/src/index.ts';

test('every frame after the ack, up to the newest, oldest first', () => {
  // The peer acked 1203; the page made up to 1210 and switched.
  assert.deepEqual(framesToSendAgain(1203, 1210, 120), [1204, 1205, 1206, 1207, 1208, 1209, 1210]);
});

test('more than the history holds: all of them, from the inputs the page keeps', () => {
  // 40 unacked, past the redundancy history's 30.
  const frames = framesToSendAgain(1000, 1040, 120);
  assert.equal(frames.length, 40);
  assert.equal(frames[0], 1001);
  assert.equal(frames.at(-1), 1040);
});

test('at most max, and then the newest', () => {
  assert.deepEqual(framesToSendAgain(10, 20, 3), [18, 19, 20]);
  assert.deepEqual(framesToSendAgain(10, 20, 0), []);
});

test('no ack yet: from frame 0, within max', () => {
  assert.deepEqual(framesToSendAgain(-1, 2, 120), [0, 1, 2]);
  assert.deepEqual(framesToSendAgain(-1, 500, 4), [497, 498, 499, 500]);
});

test('nothing unacked, nothing sent', () => {
  assert.deepEqual(framesToSendAgain(30, 30, 120), []);
  assert.deepEqual(framesToSendAgain(31, 30, 120), []);
});

test('the plain-script engine reaches it through KNCore', () => {
  assert.equal(KNCore.framesToSendAgain, framesToSendAgain);
});
