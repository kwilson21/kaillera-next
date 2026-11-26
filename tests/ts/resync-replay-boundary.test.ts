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

const fixture = (target: number, stateFrame: number) =>
  runInNewContext(
    `
    let now = 100, _frameNum = 100, replaying = true;
    const performance = {now: () => now};
    const mod = {
      _kn_get_replay_depth: () => 0,
      _kn_peek_pending_rollback: () => replaying ? 99 : -1,
      _kn_clear_replay_state: () => { replaying = false; },
    };
    const window = { EJS_emulator: {gameManager: {Module: mod}} };
    const _catchUpTo = -1, _syncLog = () => {};
    const RUN_AWAITING_RESYNC = 2, RUN_NORMAL = 0;
    let _runSubstate = RUN_NORMAL, _awaitingResyncAt = 0;
    let _syncTargetFrame = target, _syncTargetDeadlineAt = target > 0 ? 3100 : 0;
    const SYNC_HOLD_MAX_FRAMES = 2, SYNC_COORD_TIMEOUT_MS = 3000;
    let _pendingResyncState = {frame: stateFrame}, installed;
    const applySyncState = (_, frame) => {
      if (replaying) throw Error('replay still owns the native frame');
      installed = frame;
    };
    ${from('  const SYNC_APPLY_REPLAY_WAIT_MS', '  // Coordinated sync dispatch')}
    const tick = (ms, frame) => {
      now = ms;
      _frameNum = frame;
      ${from('    const pending = _pendingResyncState;\n    const atSyncBoundary =', '    if (_coreFatalError) return; // sync application')}
      return { replaying, installed, target: _syncTargetFrame };
    };
    tick;
    `,
    { target, stateFrame },
  ) as (ms: number, frame: number) => { replaying: boolean; installed?: number; target: number };

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
