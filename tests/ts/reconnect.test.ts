import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConnectTracker, shouldResumeRomTransfer, type RomResumeInput } from '../../web/src/reconnect.ts';

test('the first connect is not a reconnect, even after retries', () => {
  const tracker = createConnectTracker();
  tracker.attempt(1);
  tracker.attempt(2);
  assert.deepEqual(tracker.connected(), { isReconnect: false, attempts: 2 });
});

test('every later connect is a reconnect and reports its own attempts', () => {
  const tracker = createConnectTracker();
  tracker.connected();
  tracker.attempt(1);
  tracker.attempt(2);
  tracker.attempt(3);
  assert.deepEqual(tracker.connected(), { isReconnect: true, attempts: 3 });
  tracker.attempt(1);
  assert.deepEqual(tracker.connected(), { isReconnect: true, attempts: 1 });
});

const stalled: RomResumeInput = {
  isHost: false,
  sharingDecision: 'accepted',
  hasRom: false,
  transferState: 'resuming',
  askingOverEngine: false,
};

test('a guest waiting on an accepted transfer asks again', () => {
  assert.equal(shouldResumeRomTransfer(stalled), true);
  assert.equal(shouldResumeRomTransfer({ ...stalled, transferState: 'paused' }), true);
});

test('nothing to resume for the host, an undecided or declined guest, or a loaded ROM', () => {
  assert.equal(shouldResumeRomTransfer({ ...stalled, isHost: true }), false);
  assert.equal(shouldResumeRomTransfer({ ...stalled, sharingDecision: null }), false);
  assert.equal(shouldResumeRomTransfer({ ...stalled, sharingDecision: 'declined' }), false);
  assert.equal(shouldResumeRomTransfer({ ...stalled, hasRom: true }), false);
});

test('a transfer that is idle, running or done is left alone', () => {
  for (const transferState of ['idle', 'receiving', 'complete'] as const) {
    assert.equal(shouldResumeRomTransfer({ ...stalled, transferState }), false);
  }
});

test('no second request while the page is still asking over the engine channel', () => {
  assert.equal(shouldResumeRomTransfer({ ...stalled, askingOverEngine: true }), false);
});
