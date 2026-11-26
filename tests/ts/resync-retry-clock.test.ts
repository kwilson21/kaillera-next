import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import * as resyncRequest from '../../web/src/resync-request.ts';

const source = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const slice = (first: string, last: string) => {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
};

interface ClockFixture {
  begin: () => void;
  step: (ms: number, frames: boolean) => void;
  history: () => number[];
  pause: (value: boolean, at?: number) => void;
  stop: () => void;
}
function fixture(): ClockFixture {
  const wiring = slice('  const tick = () => {', '    // MF6: Detection-only watchdog.');
  return runInNewContext(
    `
    let now = 0, _resyncRequestInFlight = false, _resyncRequestSentAt = 0;
    let _resyncRequestId = 0, _resyncRequestAt = -1, _owedResync = false, _owedResyncAsksAgain = 0;
    const PHASE_RUNNING = 2, _phase = PHASE_RUNNING, _playerSlot = 1;
    const _isSpectator = false, _lastUsersUpdated = null, _config = null, _checkpoint = null;
    const _frameNum = 0, _pendingResyncState = null, _syncExpected = 0, _syncTargetFrame = -1;
    const _syncDecodes = 0, _syncDecodeStartedAt = 0, _lateJoinLostHost = false, _reconnectAnswerDebt = null;
    const SYNC_DECODE_GRACE_MS = 10000, RESYNC_REQUEST_TIMEOUT_MS = 8000, RESYNC_MAX_ASKS_AGAIN = 2;
    const LOCAL_FREEZE_CREDIT_MS = 1000, performance = {now: () => now};
    const document = {hidden: false}, window = {KNCore: {resyncRequest}}, _syncLog = () => {};
    ${source.includes('  let _recoveryVisibilityChangedAt') ? '' : 'let _recoveryVisibilityChangedAt = 0;'}
    const scheduled = new Map(), calls = [];
    let timerId = 0;
    const setTimeout = (run, delay) => { scheduled.set(++timerId, { run, at: now + delay }); return timerId; };
    const clearTimeout = (id) => scheduled.delete(id);
    const _askAgainForOwedResync = () => { calls.push(now); _owedResyncAsksAgain++; _beginResyncRequest(-1, true); };
    const _stopAskingForOwedResync = () => calls.push(now);
    ${slice("  // The deadline's step is resyncDeadlineStep", '  const _stopAskingForOwedResync =')}
    ${slice('  const _beginResyncRequest =', '  // The number travels')}
    ({
      begin: () => _beginResyncRequest(),
      step: (ms, frames) => {
        now = ms;
        if (frames && tickOwned) _checkResyncRequestDeadline();
        for (const [id, task] of [...scheduled]) {
          if (task.at <= now && scheduled.delete(id)) task.run();
        }
      },
      history: () => calls.slice(),
      pause: (hidden, at = now) => { document.hidden = hidden; _recoveryVisibilityChangedAt = at; },
      stop: () => { _resyncRequestInFlight = false; },
    })
    `,
    { resyncRequest, tickOwned: wiring.includes('_checkResyncRequestDeadline();') },
  );
}

test('retry and give-up times are the same with regular ticks and a stopped frame loop', () => {
  const timelines = [];
  for (const frames of [true, false]) {
    const clock = fixture();
    clock.begin();
    for (let ms = 250; ms <= 25000; ms += 250) clock.step(ms, frames);
    timelines.push([...clock.history()]);
  }
  assert.deepEqual(timelines, [
    [8000, 16000, 24000],
    [8000, 16000, 24000],
  ]);
});

test('a delayed browser timer credits a foreground freeze but hidden timers still expire', () => {
  const foreground = fixture();
  const hidden = fixture();
  hidden.pause(true);
  for (const clock of [foreground, hidden]) {
    clock.begin();
    for (let ms = 250; ms <= 7500; ms += 250) clock.step(ms, false);
    clock.step(10000, false);
  }
  assert.deepEqual([...foreground.history()], []);
  assert.deepEqual([...hidden.history()], [10000]);
  foreground.step(10250, false);
  assert.deepEqual([...foreground.history()], [10250]);
});

test('ending a request leaves its queued callback unable to retry', () => {
  const clock = fixture();
  clock.begin();
  clock.stop();
  for (let ms = 250; ms <= 25000; ms += 250) clock.step(ms, false);
  assert.deepEqual([...clock.history()], []);
});

test('showing a throttled tab does not credit its hidden interval', () => {
  const clock = fixture();
  clock.begin();
  for (let ms = 250; ms <= 7500; ms += 250) clock.step(ms, false);
  clock.pause(true, 7550);
  clock.pause(false, 10000);
  clock.step(10000, false);
  assert.deepEqual([...clock.history()], [10000]);
});
