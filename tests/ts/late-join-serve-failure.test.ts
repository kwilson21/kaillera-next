import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const start = source.indexOf('  async function sendLateJoinState(remoteSid)');
const end = source.indexOf('  // Joiner: a full resync', start);
assert.ok(start >= 0 && end > start);
const clearFrom = source.indexOf('  const _clearPendingLateJoinPeer =');
const clearTo = source.indexOf('  const _clearPendingLateJoinRosterSlots =', clearFrom);
assert.ok(clearFrom >= 0 && clearTo > clearFrom);

interface ServeFixture {
  start: () => Promise<void>;
  replace: () => void;
  rejectCompression: () => void;
  isPending: () => boolean;
  resumed: () => boolean;
}

function fixture(): ServeFixture {
  return runInNewContext(`
    const _peers = {old: {slot: 2}}, _knownPlayers = {};
    let _hostReconnectFenceVersion = 0, _syncQueueEpoch = 1;
    const _syncQueueGen = {}, _lateJoinServing = new Map(), _lateJoinStateSent = new Map();
    const _pendingLateJoinReadySids = new Set(), _syncLog = () => {};
    const RUN_LATE_JOIN_PAUSE = 1, LATE_JOIN_TIMEOUT_MS = 15000;
    const _frameNum = 80, DELAY_FRAMES = 3, _useCRollback = false;
    let _lateJoinServeSeq = 0, _lateJoinPausedAt = 0, _runSubstate = 0;
    let didResume = false, rejectCompression;
    const _pendingLateJoinPeerSids = new Set(), _pendingLateJoinPeerSlots = new Set();
    const _isValidPlayerSlot = (slot) => Number.isInteger(slot) && slot >= 0 && slot < 4;
    const _markPendingLateJoinPeer = (sid, slot) => {
      _pendingLateJoinPeerSids.add(sid);
      _pendingLateJoinPeerSlots.add(slot);
    };
    ${source.slice(clearFrom, clearTo)}
    const _endLateJoinPauseIfNoneServed = () => { didResume = !_lateJoinServing.size; };
    const _hostReconnectBlocksNativeCapture = () => false;
    const performance = { now: () => 100 }, setTimeout = () => {};
    const window = { EJS_emulator: { gameManager: { getState: () => new Uint8Array(1) } } };
    const _captureHiddenStateWords = () => null, _captureAudioFifoState = () => null, _captureSaveRam = () => null;
    const compressAndEncode = () => new Promise((_, reject) => { rejectCompression = reject; });
    ${source.slice(start, end)}
    ({
      start: () => sendLateJoinState('old'),
      replace: () => {
        _lateJoinServing.delete('old');
        _clearPendingLateJoinPeer('old', 2);
        delete _peers.old;
        _peers.next = {slot: 2};
        _lateJoinServing.set('next', ++_lateJoinServeSeq);
        _markPendingLateJoinPeer('next', 2);
      },
      rejectCompression: () => rejectCompression(new Error('worker stopped')),
      isPending: () => _pendingLateJoinPeerSlots.has(2),
      resumed: () => didResume,
    })
  `);
}

test('failure from an obsolete compression preserves the replacement joiner', async () => {
  const game = fixture();
  const obsolete = game.start();
  game.replace();
  game.rejectCompression();
  await obsolete;
  assert.equal(game.isPending(), true);
  assert.equal(game.resumed(), false);
});

test('failure from the current compression releases its own joiner and pause', async () => {
  const game = fixture();
  const current = game.start();
  game.rejectCompression();
  await current;
  assert.equal(game.isPending(), false);
  assert.equal(game.resumed(), true);
});
