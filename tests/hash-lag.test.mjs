// Run: node --test tests/hash-lag.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashLagOf, trackHashLag, unrecordedIn } from './hash-lag.mjs';

test('the lag is one past the rollback window: the oldest frame the ring still holds', () => {
  assert.equal(hashLagOf(22), 23);
});

const fakePage = (syncLog) => {
  const calls = [];
  const Module = { _kn_rollback_init: (...args) => (calls.push(args), 0) };
  globalThis.window = {
    NetplayRollback: { exportSyncLog: () => syncLog },
    EJS_emulator: { gameManager: { Module } },
  };
  return { Module, calls };
};

test('an engine armed before the harness looked: the last init line in the sync log', () => {
  fakePage('0\t1.0\tf=0\tC-ROLLBACK init: max=22 delay=2\n1\t2.0\tf=90\tC-ROLLBACK init: max=24 delay=14\n');
  assert.equal(trackHashLag(), 25);
  assert.deepEqual(window.__knHashLag.inits, [{ max: 24, lag: 25, source: 'sync-log' }]);
});

test('a re-arm mid-match (late join) takes the new window; the engine still gets the call', () => {
  const { Module, calls } = fakePage('');
  assert.equal(trackHashLag(), null);
  Module._kn_rollback_init(22, 3, 1, 4);
  assert.equal(window.__knHashLag.lag, 23);
  // Looking again does not wrap twice.
  assert.equal(trackHashLag(), 23);
  Module._kn_rollback_init(30, 20, 1, 4);
  assert.equal(window.__knHashLag.lag, 31);
  assert.deepEqual(calls, [
    [22, 3, 1, 4],
    [30, 20, 1, 4],
  ]);
  assert.equal(window.__knHashLag.inits.length, 2);
});

test('frames a page has no hash for, or read as 0, are counted', () => {
  const hashes = { 10: [5, 1, 1], 11: [0, 0, 0], 13: [7, 2, 2] };
  assert.deepEqual(unrecordedIn(hashes, 10, 14), { missing: 2, zero: 1 });
});
