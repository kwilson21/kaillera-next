import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostGameConnected } from '../../web/src/host-game-link.ts';

test('a lingering RTCDataChannel cannot make a lost host look live', () => {
  assert.equal(hostGameConnected('failed', 'connected', true, 100, 120), false);
  assert.equal(hostGameConnected('connected', 'disconnected', true, 100, 120), false);
  assert.equal(hostGameConnected('connected', 'connected', false, 100, 120), false);
  assert.equal(hostGameConnected('connected', 'connected', true, 100, 2100), false);
  assert.equal(hostGameConnected('connected', 'connected', true, undefined, 120), false);
});
test('a signaling hold keeps playing while current RTC input still arrives', () => {
  assert.equal(hostGameConnected('connected', 'completed', true, 100, 2099), true);
  assert.equal(hostGameConnected(undefined, 'connected', true, 8000, 8005), true);
});
