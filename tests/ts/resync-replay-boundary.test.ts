import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const from = (start: string, end: string) => {
  const i = source.indexOf(start);
  const j = source.indexOf(end, i);
  assert.ok(i >= 0 && j > i);
  return source.slice(i, j);
};

type Tick = (
  ms: number,
  frame: number,
  catchingUp?: boolean,
) => {
  held: boolean;
  replaying: boolean;
  installed?: number;
  writeWhileReplaying?: boolean;
  target: number;
  fatalBranch?: string;
  canContinue: boolean;
};

const fixture = (
  target: number,
  stateFrame: number,
  { warnAt = Infinity, capacity = 8, nativeResult = 0, nativeThrows = false, recoveryWakeOnly = false } = {},
): Tick =>
  runInNewContext(
    `
    let now = 100, _frameNum = 100, replaying = true;
    const performance = {now: () => now};
    let installed, writeWhileReplaying, fatalBranch;
    let _coreFatalError = false;
    const _handleCoreFatal = (branch, error) => {
      if (error?.message !== 'settled-test-boundary') {
        fatalBranch = branch;
        _coreFatalError = true;
      }
    };
    const mod = {
      HEAPU8: new Uint8Array(16),
      _kn_sync_write: () => {
        writeWhileReplaying = replaying;
        if (nativeThrows) throw Error("native write trapped after mutation");
        return nativeResult;
      },
      _kn_set_frame: (frame) => {
        if (replaying) throw Error('replay still owns the native frame');
        installed = frame;
      },
      _kn_get_frame: () => installed,
      _kn_get_replay_depth: () => 0,
      _kn_peek_pending_rollback: () => replaying ? 99 : -1,
      _kn_clear_replay_state: () => { replaying = false; },
    };
    let wake;
    const PHASE_RUNNING = 'running', PHASE_STOPPED = 'stopped', _phase = PHASE_RUNNING;
    const RUN_LATE_JOIN_PAUSE = 'late-join-pause';
    const _config = {}, _workerCoprocPending = null, _playerSlot = 1, _isSpectator = false;
    const _lastUsersUpdated = null;
    const window = { EJS_emulator: {gameManager: {Module: mod}},
      KNCore: {startAfter: () => () => {}, startEvery: run => {
        wake = run;
        return () => { wake = undefined; };
      }} };
    const _syncQueueEpoch = 1;
    let _catchUpTo = -1;
    const _syncLog = () => {};
    const _isLateAnswerBehind = () => false, _canCatchUp = () => false;
    const RUN_AWAITING_RESYNC = 2, RUN_NORMAL = 0;
    let _runSubstate = RUN_NORMAL, _awaitingResyncAt = 0;
    let _syncTargetFrame = target, _syncTargetDeadlineAt = target > 0 ? 3100 : 0;
    const SYNC_HOLD_MAX_FRAMES = 2, SYNC_COORD_TIMEOUT_MS = 3000;
    let _pendingResyncState = {frame: stateFrame, bytes: new Uint8Array(2)};
    let _lastAppliedRecoveryId = 0, _resyncCount = 0, _consecutiveResyncs = 0;
    const KNState = {};
    const _applyResyncExtras = () => {}, recaptureManualRunner = () => {}, _setLastSyncState = () => {};
    const _resetStrictMenuResends = () => {};
    const _settleInputsAtResync = () => { throw Error('settled-test-boundary'); };
    const _hasKnSync = true, _syncBufSize = capacity;
    let _syncBufPtr = 0;
    const ensureSyncBuffer = () => { _syncBufPtr = capacity > 0 ? 1 : 0; };
    const _hostMatchUnverified = () => now >= warnAt;
    const _checkpoint = null, _checkpointFloor = 0;
    const _guestAllowsReconnectState = () => true;
    ${from('  const _syncStateCanInstall =', '  // -- Init / Stop API')}
    ${from('  let _cancelSyncTargetClock', '  // A resync state at most')}
    ${from('  const SYNC_APPLY_REPLAY_WAIT_MS', '  const COORDINATED_CAPTURE_POLL_MS')}
    const applyAtBoundary = () => {
      try {
        _serviceGuestRecoveryBoundary();
      } catch (error) {
        if (error.message !== 'settled-test-boundary') throw error;
      }
      if (_coreFatalError) return false;
      return true;
    };
    const tick = (ms, frame, catchingUp = false) => {
      now = ms;
      _frameNum = frame;
      _catchUpTo = catchingUp ? frame + 1 : -1;
      const held = !!_pendingResyncState && _guestRecoveryHoldsFrame();
      if (recoveryWakeOnly) wake?.();
      const canContinue = !_coreFatalError && (recoveryWakeOnly || applyAtBoundary());
      return { held, replaying, installed, writeWhileReplaying, target: _syncTargetFrame, fatalBranch, canContinue };
    };
    if (typeof _armGuestRecoveryClock !== 'undefined') _armGuestRecoveryClock();
    tick;
    `,
    { target, stateFrame, warnAt, capacity, nativeResult, nativeThrows, recoveryWakeOnly },
  );

test('a coordinated future snapshot keeps pending replay until its install boundary', () => {
  const tick = fixture(102, 102);
  assert.equal(tick(100, 100).replaying, true);
  const waiting = tick(1100, 100);
  assert.equal(waiting.replaying, true);
  assert.equal(waiting.installed, undefined);
  assert.equal(tick(1200, 102).replaying, true);
  assert.equal(tick(2199, 102).installed, undefined);
  const applied = tick(2200, 102);
  assert.equal(applied.replaying, false);
  assert.equal(applied.installed, 102);
});

test('a newly buffered ahead-of-frame snapshot establishes its hold while replay is pending', () => {
  for (const target of [-1, 100]) {
    const tick = fixture(target, 102);
    assert.equal(tick(100, 100).target, 102);
    assert.equal(tick(1100, 101).replaying, true);
  }
});

test('a room warning that invalidates the buffered state preserves pending replay', () => {
  const tick = fixture(100, 100, { warnAt: 1100 });
  assert.equal(tick(100, 100).replaying, true);
  const rejected = tick(1100, 100);
  assert.equal(rejected.replaying, true);
  assert.equal(rejected.installed, undefined);
  assert.equal(rejected.target, -1);
});

for (const [label, capacity] of [
  ['allocation fails', 0],
  ['snapshot exceeds the buffer', 1],
] as const)
  test(`pending replay is preserved when ${label}`, () => {
    const tick = fixture(100, 100, { capacity });
    assert.equal(tick(100, 100).replaying, true);
    const dropped = tick(1100, 100);
    assert.equal(dropped.replaying, true);
    assert.equal(dropped.installed, undefined);
    assert.equal(dropped.target, -1);
  });

test('a refused native state cannot clear replay at the deadline', () => {
  const tick = fixture(100, 100, { nativeResult: -1 });
  assert.equal(tick(100, 100).replaying, true);
  const rejected = tick(1100, 100);
  assert.equal(rejected.replaying, true);
  assert.equal(rejected.writeWhileReplaying, true);
  assert.equal(rejected.installed, undefined);
  assert.equal(rejected.target, -1);
});

test('an accepted native state clears replay after writing and before aligning the frame', () => {
  const tick = fixture(100, 100);
  assert.equal(tick(100, 100).installed, undefined);
  const applied = tick(1100, 100);
  assert.equal(applied.writeWhileReplaying, true);
  assert.equal(applied.replaying, false);
  assert.equal(applied.installed, 100);
});

test('a host answer admitted after native replay starts cannot read the intermediate state', async () => {
  const run: () => Promise<string> = runInNewContext(
    `
    const _checkpoint = null, _coreFatalError = false, _playerSlot = 0, _syncEnabled = true;
    const _hasKnSync = true, _recovery = {}, _frameNum = 2240, DELAY_FRAMES = 2;
    const _hostReconnectFenceVersion = 0, _workerCoprocPending = null, _syncQueueEpoch = 1;
    const _syncQueueGen = {}, _peers = {}, _followUpWatches = new Map();
    const _ranBeforeDelayChange = null, _queuedSyncPushes = new Map();
    let _pushingSyncState = false, _proactivePushInFlight = false;
    const _runQueuedSyncPush = () => {}, _syncLog = () => {}, _syncTargetsFor = () => [];
    const performance = { now: () => 0 };
    const _admitReconnectNativeCapture = () => true;
    const ensureSyncBuffer = () => {};
    const _syncBufPtr = 0, _syncBufSize = 16;
    let replayDepth = 0, admission, reads = 0;
    const mod = {
      _kn_get_replay_depth: () => replayDepth,
      _kn_peek_pending_rollback: () => 2238,
      _kn_sync_read: () => { reads++; return 0; },
    };
    const window = {
      EJS_emulator: { gameManager: { Module: mod } },
      KNCore: { syncFollowUp: { delayOfStateAt: () => 2, correctionOwed: () => true } },
    };
    const _recoveryTransfers = {
      async run(attempts, body) {
        await new Promise((resolve) => { admission = resolve; });
        return body(attempts);
      },
    };
    ${from('  const pushSyncState = async (', '  // Host: the guests a state is for')}
    async () => {
      const options = { requestIds: { guest: 2 }, watchFor: ['guest'] };
      const queued = pushSyncState('guest', false, options);
      replayDepth = 5;
      admission();
      await queued;
      const rejected = { reads, watch: _followUpWatches.has('guest'), locked: _pushingSyncState };

      replayDepth = 0;
      const retry = pushSyncState('guest', false, options);
      admission();
      await retry;
      return JSON.stringify({
        rejected,
        stable: { reads, changed: _followUpWatches.get('guest')?.changed, locked: _pushingSyncState },
      });
    }
    `,
  );

  assert.deepEqual(JSON.parse(await run()), {
    rejected: { reads: 0, watch: false, locked: false },
    stable: { reads: 1, changed: true, locked: false },
  });
});

for (const transport of ['channel', 'socket']) {
  test(`a predicted input that changes before ${transport} handoff invalidates the captured answer`, async () => {
    const run: (transport: string, invalidate: boolean) => Promise<string> = runInNewContext(
      `
      const _checkpoint = null, _coreFatalError = false, _playerSlot = 0, _syncEnabled = true;
      const _hasKnSync = true, _recovery = {}, _frameNum = 2189, DELAY_FRAMES = 2;
      const _hostReconnectFenceVersion = 0, _workerCoprocPending = null, _syncQueueEpoch = 1;
      const _syncQueueGen = {}, _followUpWatches = new Map(), _syncSendChains = {}, _syncChainMovedAt = {};
      const _ranBeforeDelayChange = null, _queuedSyncPushes = new Map();
      const socket = { id: 'host', connected: true }, SOCKET_SYNC_B64_SOFT_LIMIT = 100;
      const SYNC_SEND_LOW_WATER = 1, SYNC_SEND_POLL_MS = 1, SYNC_SEND_STALL_MS = 1000;
      let _pushingSyncState = false, _proactivePushInFlight = false, mispredictions = 0;
      const sent = [];
      const guest = {slot: 1, syncDc: {readyState: 'open', send: (message) => sent.push(message)}};
      const _peers = {guest};
      const _signalSocket = { emit: (event) => sent.push(event) };
      const _runQueuedSyncPush = () => {}, _syncLog = () => {}, _settleInputsBefore = () => {};
      const _isPeerPendingLateJoin = () => false, _onEscalationTransfer = () => {};
      const performance = { now: () => 0 }, _mispredTotal = () => mispredictions;
      const _admitReconnectNativeCapture = () => true, ensureSyncBuffer = () => {};
      const _captureResyncExtras = () => ({}), _resyncExtrasText = () => '', _resyncExtrasFields = () => ({});
      const _syncBufPtr = 0, _syncBufSize = 16;
      let finishCompression, releaseChain;
      const encode = () => new Promise((resolve) => { finishCompression = resolve; });
      const compressState = encode, compressAndEncode = encode;
      const mod = { _kn_get_replay_depth: () => 0, _kn_peek_pending_rollback: () => -1,
        _kn_sync_read: () => 1, HEAPU8: new Uint8Array(16) };
      const window = {
        EJS_emulator: {gameManager: {Module: mod}},
        KNCore: {
          syncFollowUp: { delayOfStateAt: () => 2, correctionOwed: () => false,
            changesWatchedFrame: (f, frame, delay, before, after) => f < frame - delay && before < after },
          syncSend: { transferStillFor: () => true, sendPaced: async () => 'sent' },
        },
      };
      const _recoveryTransfers = { run: (attempts, body) => body(attempts), release: () => {} };
      ${from('  const _feedWatchedFrame =', '  const _feedCInput =')}
      ${from('  const pushSyncState = async (', '  const _syncTargetsFor =')}
      ${from('  const _syncTargetsFor =', '  const _sendSyncChunksTo =')}
      ${from('  const _sendSyncChunksTo =', '  // The answer to the newest request')}
      async (transport, invalidate) => {
        sent.length = 0;
        _syncSendChains.guest = new Promise((resolve) => { releaseChain = resolve; });
        const push = pushSyncState('guest', false, {transport, watchFor: ['guest'], requestIds: {guest: 3}});
        if (transport === 'channel') {
          finishCompression(new Uint8Array(1));
          await Promise.resolve();
        }
        if (invalidate) _feedWatchedFrame(mod, 1, 2186, () => mispredictions++);
        if (transport === 'socket') finishCompression({data:'x', compressedSize:1});
        releaseChain();
        const skipped = await push;
        return JSON.stringify({ skipped, sent, delivered: _followUpWatches.get('guest')?.delivered });
      }
      `,
    );
    const valid = JSON.parse(await run(transport, false));
    assert.equal(valid.delivered, true);
    assert.ok(valid.sent.length > 0);
    assert.deepEqual(JSON.parse(await run(transport, true)), { skipped: ['guest'], sent: [], delivered: false });
  });
}

test('repeated refused captures exhaust the host follow-up budget on a reachable channel', async () => {
  const run: () => Promise<string> = runInNewContext(
    `
    const _playerSlot = 0, _pushingSyncState = false, _frameNum = 2189, _syncQueueEpoch = 1;
    const SYNC_COORD_TIMEOUT_MS = 3000;
    const _syncQueueGen = {}, _peerPhantom = {}, _followUpWatches = new Map(), _directAnswerNewest = new Map();
    const socket = null, _syncLog = () => {}, _armScheduledSyncClock = () => {};
    const _peers = {guest: {slot: 1, syncDc: {readyState: 'open'}}};
    const window = {KNCore: {syncFollowUp: {followUpIsUnneeded: () => false}}};
    let now = 1, _scheduledSyncRequests = [{targetSid: 'guest', targetFrame: 2189, requestId: 3, deadlineAt: 1}];
    const performance = { now: () => now };
    const attempts = [];
    const pushSyncState = (sid, _proactive, options) => {
      attempts.push(options.requestIds[sid]);
      return Promise.resolve([sid]);
    };
    ${from('  const _dispatchScheduledSyncs =', '  // A direct request')}
    async () => {
      for (let i = 0; i < 6; ++i) {
        now += 3001;
        _dispatchScheduledSyncs();
        await Promise.resolve();
      }
      return JSON.stringify({attempts, remaining: _scheduledSyncRequests.length});
    }
    `,
  );
  assert.deepEqual(JSON.parse(await run()), { attempts: [3, 3, 3, 3], remaining: 0 });
});

test('the host deadline dispatches without frame ticks and fences a stopped match', async () => {
  const run: () => Promise<string> = runInNewContext(
    `
    const PHASE_RUNNING = 1, PHASE_STOPPED = 2, SYNC_COORD_TIMEOUT_MS = 3000;
    const _playerSlot = 0, _pushingSyncState = false, _useCRollback = true;
    let _frameNum = 2189, nativeFrame = 2189, confirmed = false;
    const _liveStateConfirmed = () => confirmed;
    const _config = {matchReturn: {playing: true}}, _checkpoint = {busy: false};
    const _syncQueueGen = {}, _peerPhantom = {}, _followUpWatches = new Map(), _directAnswerNewest = new Map();
    const socket = null, _syncLog = () => {};
    const _peers = {guest: {slot: 1, syncDc: {readyState: 'open'}}};
    let now = 0, _phase = PHASE_RUNNING, _scheduledSyncRequests = [], _syncQueueEpoch = 1;
    let pulse, cancelled = 0, replay = 0;
    const window = {EJS_emulator: {gameManager: {Module: {_kn_get_replay_depth: () => replay, _kn_get_frame: () => nativeFrame}}},
      KNCore: {syncFollowUp: {followUpIsUnneeded: () => false}, startEvery: (run) => {
        pulse = run;
        return () => { cancelled++; };
      }}};
    const performance = { now: () => now };
    const attempts = [];
    const pushSyncState = (sid, _proactive, options) => {
      attempts.push(options.requestIds[sid ?? 'guest']);
      return Promise.resolve([sid]);
    };
    ${from('  const COORDINATED_CAPTURE_POLL_MS', '  // Coordinated sync dispatch')}
    ${from('  const _dispatchScheduledSyncs =', '  // A direct request')}
    async () => {
      const put = (requestId) => {
        _scheduledSyncRequests.push({targetSid: 'guest', targetFrame: 2190, requestId, deadlineAt: now + 3000});
        if (typeof _armScheduledSyncClock !== 'undefined') _armScheduledSyncClock();
      };
      put(3);
      now = 2900;
      pulse?.();
      now = 3000;
      replay = 2;
      pulse?.();
      if (attempts.length) throw Error('capture before deadline or during replay');
      replay = 0;
      _checkpoint.busy = true;
      pulse?.();
      _checkpoint.busy = false;
      _config.matchReturn.playing = false;
      pulse?.();
      if (attempts.length) throw Error('capture during checkpoint or saved-match restore');
      _config.matchReturn.playing = true;
      pulse?.();
      await Promise.resolve();

      put(4);
      _frameNum = 2190;
      confirmed = true;
      pulse?.();
      if (attempts.includes(4)) throw Error('capture between a JS frame change and its native commit');
      nativeFrame = 2190;
      pulse?.();
      await Promise.resolve();

      put(5);
      _phase = PHASE_STOPPED;
      now = 7000;
      pulse?.();
      await Promise.resolve();
      return JSON.stringify({attempts, cancelled});
    }
    `,
  );
  assert.deepEqual(JSON.parse(await run()), { attempts: [3, 4], cancelled: 3 });
});

const guestHoldClock = () => {
  const begin = source.includes('  const _armSyncTarget =')
    ? '_armSyncTarget(frame);'
    : '_syncTargetFrame = frame; _syncTargetDeadlineAt = now + SYNC_COORD_TIMEOUT_MS;';
  const clear = source.includes('  const _clearSyncTarget =')
    ? '_clearSyncTarget();'
    : '_syncTargetFrame = -1; _syncTargetDeadlineAt = 0;';
  const clock = source.includes('  let _cancelSyncTargetClock')
    ? from('  let _cancelSyncTargetClock', '  // A resync state at most')
    : '';
  const read: (action: string, at?: number, timer?: number) => string = runInNewContext(
    `
    const SYNC_COORD_TIMEOUT_MS = 3000, PHASE_RUNNING = 'running';
    const RUN_AWAITING_RESYNC = 'awaiting', RUN_NORMAL = 'normal';
    let _runSubstate = RUN_AWAITING_RESYNC, _phase = PHASE_RUNNING, _syncQueueEpoch = 1;
    let now = 100, _frameNum = 100, _syncTargetFrame = -1, _syncTargetDeadlineAt = 0;
    const _pendingResyncState = {frame: 102}, timers = [];
    const performance = { now: () => now }, _syncLog = () => {};
    const start = (run, ms) => {
      const timer = { run, due: now + ms, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    };
    const window = { KNCore: { startEvery: start, startAfter: start } };
    ${clock}
    const hold = (frame) => { ${begin} };
    const reset = () => { ${clear} _syncQueueEpoch++; };
    hold(102);
    (action, at, timer) => {
      if (action === 'advance') {
        now = at;
        for (const entry of timers) if (!entry.cancelled && entry.due <= now) entry.run();
      }
      if (action === 'replace') hold(102);
      if (action === 'reset') reset();
      if (action === 'stale') timers[timer]?.run();
      return JSON.stringify({
        frame: _frameNum,
        target: _syncTargetFrame,
        pending: _pendingResyncState.frame,
        substate: _runSubstate,
      });
    }
    `,
  );
  return (action: string, at?: number, timer?: number) => JSON.parse(read(action, at, timer));
};

test('guest coordinated hold expires without installing a buffered state or stepping a frame', () => {
  const clock = guestHoldClock();
  assert.equal(clock('advance', 3099).target, 102);
  assert.deepEqual(clock('advance', 3100), { frame: 100, target: -1, pending: 102, substate: 'normal' });
});

test('an expired guest clock cannot release a replacement or reset match hold', () => {
  const clock = guestHoldClock();
  clock('advance', 1000);
  clock('replace');
  clock('advance', 3100);
  assert.equal(clock('stale', 3100, 0).target, 102);
  clock('reset');
  clock('replace');
  clock('advance', 4000);
  assert.equal(clock('stale', 4000, 1).target, 102);
  assert.equal(clock('advance', 6100).target, -1);
});

test('a trap during native resync terminates the match before replay can step', () => {
  const tick = fixture(100, 100, { nativeThrows: true });
  assert.equal(tick(100, 100).replaying, true);
  const trapped = tick(1100, 100);
  assert.equal(trapped.writeWhileReplaying, true);
  assert.equal(trapped.installed, undefined);
  assert.equal(trapped.fatalBranch, 'kn-sync-write');
  assert.equal(trapped.canContinue, false);
  assert.equal(tick(1200, 100).canContinue, false);
});

test('a guest can install at its native boundary while the frame pump is stopped', () => {
  const wake = fixture(102, 102, { recoveryWakeOnly: true });
  assert.equal(wake(100, 101).installed, undefined);
  assert.equal(wake(200, 102).installed, undefined);
  assert.equal(wake(1199, 102).installed, undefined);
  assert.equal(wake(1200, 102).installed, 102);
});

test('the frame gate lets catch-up finish and holds once replay reaches its grace limit', () => {
  const wake = fixture(102, 102, { recoveryWakeOnly: true });
  assert.equal(wake(100, 102, true).held, false);
  assert.equal(wake(1200, 102, true).installed, undefined);
  assert.equal(wake(1201, 102).held, false);
  assert.equal(wake(2200, 102).held, false);
  const ready = wake(2201, 102);
  assert.equal(ready.held, true);
  assert.equal(ready.installed, 102);
});
