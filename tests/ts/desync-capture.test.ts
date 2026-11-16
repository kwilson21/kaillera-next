import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KNCore } from '../../web/src/index.ts';
import { captureFrame, NO_CAPTURE } from '../../web/src/desync-capture.ts';

test('two peers that flag the same frame at different ticks capture the same frame', () => {
  const host = captureFrame(942, 972, 90);
  const guest = captureFrame(942, 985, 90);
  assert.equal(host, 1032);
  assert.equal(guest, host);
});

test('a peer already on the capture frame captures now', () => {
  assert.equal(captureFrame(942, 1032, 90), 1032);
});

test('a peer that learns of the frame after the capture frame takes no picture', () => {
  assert.equal(captureFrame(942, 1033, 90), NO_CAPTURE);
});

test('with no lead the flagged frame itself is the capture frame', () => {
  assert.equal(captureFrame(600, 598, 0), 600);
  assert.equal(captureFrame(600, 601, 0), NO_CAPTURE);
});

test('the plain-script pages reach it through KNCore', () => {
  assert.equal(KNCore.captureFrame, captureFrame);
});
