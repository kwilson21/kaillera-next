import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const read = (worker = false) => {
  const start = source.indexOf('  // Host roster input ownership.');
  const end = source.indexOf('  // The oldest input from', start);
  assert.ok(start >= 0 && end > start, 'host admission adapter is installed');
  // Priming feeds the native core through the production follow-up watch.
  // No snapshot is being watched in this fixture; it records the exact feeds.
  const watchStart = source.indexOf('  const _followUpWatches = new Map();');
  const watchEnd = source.indexOf('  const _feedCInput =', watchStart);
  assert.ok(watchStart >= 0 && watchEnd > watchStart, 'production input watch is installed');
  const writes = [];
  const api = vm.runInNewContext(
    source.slice(watchStart, watchEnd) +
      source.slice(start, end) +
      '\n({ update: _recordHostInputRoster, floor: _admissionInputFloor, prime: _primeLateJoinInactiveInput, reset: _clearLateJoinInputRoster, late: _waitingForHostAdmission, open: _observeLateJoinDcOpen })',
    {
      RB_WORKER_COPROC: worker,
      _playerSlot: 1,
      _frameNum: 1362,
      DELAY_FRAMES: 3,
      _rbRollbackMax: 12,
      _isValidPlayerSlot: (s) => Number.isInteger(s) && s >= 0 && s < 4,
      _syncLog: () => {},
    },
  );
  return { ...api, writes, mod: { _kn_feed_input: (...args) => writes.push(args) } };
};

test('a host roster removal and add give a new generation a shared floor; resent roster does not move it', () => {
  const m = read();
  m.update(0, [0, 1, 2, 3]);
  assert.equal(m.floor(3), 0);
  m.update(1344, [0, 1, 2]);
  assert.equal(m.late(3), true);
  m.update(1363, [0, 1, 2, 3]);
  assert.equal(m.late(3), false);
  assert.equal(m.floor(3), 1363);
  m.update(1381, [0, 1, 2, 3]);
  assert.equal(m.floor(3), 1363);
  assert.equal(m.update(1362, [0, 1, 2]), false);
  assert.equal(m.floor(3), 1363);
});

test('existing core gets explicit neutral for only the proven inactive window before it sees a new non-neutral input', () => {
  const m = read();
  m.update(0, [0, 1, 2, 3]);
  m.update(1344, [0, 1, 2]);
  m.update(1363, [0, 1, 2, 3]);
  m.prime(m.mod, 2);
  assert.deepEqual(m.writes, []);
  m.prime(m.mod, 3);
  const nativeRing = new Map(m.writes.map(([slot, id, ...input]) => [id, { slot, input }]));
  assert.deepEqual(nativeRing.get(1359), { slot: 3, input: [0, 0, 0, 0, 0] });
  assert.equal(nativeRing.has(1343), false);
  assert.equal(nativeRing.has(1363), false);
  assert.ok(m.writes.length <= 15);
  const count = m.writes.length;
  m.prime(m.mod, 3);
  assert.equal(m.writes.length, count);
  m.reset();
  assert.equal(m.floor(3), 0);
});

test('a brief removal cannot create neutral records from the preceding active generation', () => {
  const m = read();
  m.update(0, [0, 1, 2, 3]);
  m.update(1362, [0, 1, 2]);
  m.update(1363, [0, 1, 2, 3]);
  m.prime(m.mod, 3);
  assert.deepEqual(m.writes, [[3, 1362, 0, 0, 0, 0, 0]]);
});

test('a late DC can open on either side of roster admission, but an admitted active DC still reconnects normally', () => {
  for (const rosterFirst of [false, true]) {
    const m = read();
    m.update(0, [0, 1, 2, 3]);
    assert.equal(m.open(3), false);
    m.update(1344, [0, 1, 2]);
    if (rosterFirst) m.update(1363, [0, 1, 2, 3]);
    assert.equal(m.open(3), true);
    if (!rosterFirst) m.update(1363, [0, 1, 2, 3]);
    assert.equal(m.open(3), false);
    assert.equal(m.floor(3), 1363);
    m.update(1381, [0, 1, 2]);
    assert.equal(m.late(3), true);
    assert.equal(m.open(3), true);
  }
});

test('the experimental rollback worker retains its previous roster and input ownership behavior', () => {
  const m = read(true);
  m.update(0, [0, 1, 2, 3]);
  m.update(1344, [0, 1, 2]);
  assert.equal(m.late(3), false);
  assert.equal(m.open(3), false);
  m.update(1363, [0, 1, 2, 3]);
  assert.equal(m.floor(3), 0);
  m.prime(m.mod, 3);
  assert.deepEqual(m.writes, []);
});
