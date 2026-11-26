import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');

const between = (start: string, end: string) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, start);
  const through = source.indexOf(end, from);
  assert.ok(through > from, end);
  return source.slice(from, through);
};

function guest() {
  const run: unknown = vm.runInNewContext(`
    let now = 100, resets = 0;
    const _phase = 5, PHASE_RUNNING = 5, PHASE_IDLE = 0, PHASE_GAME_STARTED = 1,
      PHASE_EMU_READY = 2, PHASE_SYNCING = 3, PHASE_LOCKSTEP_READY = 4, PHASE_STOPPED = 6;
    const _frameNum = 77, _inGameplay = true, _playerSlot = 1;
    const RUN_NORMAL = 'normal', RUN_PACING = 'pacing', RUN_RB_STALL = 'stall',
      RUN_AWAITING_RESYNC = 'awaiting-resync', RUN_LATE_JOIN_PAUSE = 'late-join-pause';
    let _runSubstate = RUN_NORMAL;
    ${between('  let _lateJoin =', '  // Joiner: its channel')}
    const performance = {now: () => now};
    const clocks = [], logs = [], _config = null;
    const _syncLog = line => logs.push(line), setStatus = () => {};
    const clearLateJoinReadyRetry = () => {};
    let _pacingThrottleStartAt = 90, _rollbackStallStart = 80;
    const _peerLastAdvanceTime = {2: 70}, _peerPhantom = {};
    ${between('  const _resetPacingAfterLateJoin =', '  const clearLateJoinReadyRetry =').replace('const now = performance.now();', 'resets++; const now = performance.now();')}
    const window = {KNCore: {startAfter(wake, delay) {
      const clock = {wake, at: now + delay, cancelled: false};
      clocks.push(clock);
      return () => { clock.cancelled = true; };
    }}};
    ${between('  const _computeState =', '  const _checkStateTransition =')}
    const hear = (data, slot = 0) => {
      const e = {data}, peer = {slot};
      ${between("        if (e.data === 'late-join-pause'", "        if (e.data === 'join-the-start'")}
      ${between("        if (e.data === 'late-join-resume'", "        if (e.data === 'late-join-ready'")}
    };
    (command, n) => {
      switch (command) {
        case 'pause': return hear('late-join-pause', n);
        case 'resume': return hear('late-join-resume', n);
        case 'state': return _computeState();
        case 'clocks': return JSON.stringify(clocks.map(({at, cancelled}) => ({at, cancelled})));
        case 'wake': now = clocks[n].at; return clocks[n].wake();
        case 'time': now = n; break;
        case 'recovery': _runSubstate = RUN_AWAITING_RESYNC; break;
        case 'pace': _runSubstate = RUN_PACING; break;
        case 'paceClocks': return JSON.stringify([_pacingThrottleStartAt, _rollbackStallStart, _peerLastAdvanceTime[2]]);
        case 'frame': return _frameNum;
        case 'resets': return resets;
        case 'timeouts': return logs.filter(line => line.startsWith('LATE-JOIN-GUEST-PAUSE-TIMEOUT')).length;
      }
    }
  `);
  assert.ok(typeof run === 'function');
  return (command: string, argument?: number) => {
    const result: unknown = run(command, argument);
    assert.ok(result === undefined || typeof result === 'string' || typeof result === 'number');
    return result;
  };
}

test('the guest admission deadline releases a lost host pause without a tick', () => {
  const run = guest();
  run('pause');
  assert.equal(run('state'), 'late-join-pause');
  assert.deepEqual(JSON.parse(String(run('clocks'))), [{ at: 20100, cancelled: false }]);
  run('wake', 0);
  assert.equal(run('state'), 'running');
  assert.equal(run('frame'), 77);
  assert.equal(run('resets'), 1);
  assert.equal(run('timeouts'), 1);
});

test('only the current host pause can expire and releasing it preserves recovery state', () => {
  const run = guest();
  run('pause', 2);
  assert.equal(run('state'), 'running');
  run('pause');
  run('time', 200);
  run('pause');
  run('recovery');
  assert.equal(run('state'), 'late-join-pause');
  run('wake', 0);
  assert.equal(run('state'), 'late-join-pause');
  run('resume', 2);
  assert.equal(run('state'), 'late-join-pause');
  run('resume');
  assert.equal(run('state'), 'awaiting-resync');
  run('wake', 1);
  assert.equal(run('timeouts'), 0);
  assert.equal(run('resets'), 1);
});

test('resume reanchors pacing clocks without carrying the admission wait into the next step', () => {
  const run = guest();
  run('pace');
  run('pause');
  assert.equal(run('state'), 'late-join-pause');
  run('time', 1234);
  run('resume');
  assert.equal(run('state'), 'running');
  assert.deepEqual(JSON.parse(String(run('paceClocks'))), [0, 0, 1234]);
});
