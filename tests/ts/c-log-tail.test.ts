import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { cLogDrain, cLogDroppedSince, cLogTail } from '../../web/src/c-log-tail.ts';

// The engine's drain before cLogTail: nothing when the length is unchanged,
// else everything past the old length.
const before = (full: string, drained: number) =>
  full.length === drained ? null : { tail: full.slice(drained), drained: full.length };

test('a buffer that grew: the same tail as before', () => {
  const buffers = ['', 'a\n', 'a\nb\n', 'MISPREDICTION slot=1 f=3\nC-REPLAY-FRAME f=4\n'];
  for (const full of buffers) {
    for (let drained = 0; drained <= full.length; drained++) {
      const old = before(full, drained);
      const now = cLogTail(full, drained);
      assert.equal(now.drained, full.length);
      assert.equal(now.tail, old ? old.tail : '', `${JSON.stringify(full)} from ${drained}`);
    }
  }
});

test('a buffer shorter than what was drained is a new one: drained from its start', () => {
  // Before: the slice past its end was empty, so its lines were never sent.
  const full = 'SAVE-SKIP from f=3119: no other slot is active\n';
  assert.equal(before(full, 5000)?.tail, '');
  assert.deepEqual(cLogTail(full, 5000), { tail: full, drained: full.length });
});

// The engine's own drain, run in a sandbox with a C buffer the test controls.
const src = readFileSync(new URL('../../web/static/netplay-rollback.js', import.meta.url), 'utf8');
const start = src.indexOf('  let _cDebugLogLastLen = 0;');
const drainSource = src.slice(start, src.indexOf('\n  };\n', start) + 5);

interface Drainer {
  logs: string[];
  buffer: string;
  dropped: number;
  drain: () => void;
}

/**
 * The engine's drain against a fake core. `canClear`: the core has
 * kn_clear_debug_log and kn_get_debug_log_dropped (this PR's core); without
 * them it is an older core that keeps its whole log.
 */
const drainer = (canClear = false): Drainer => {
  const box: Drainer = { logs: [], buffer: '', dropped: 0, drain: () => {} };
  vm.runInContext(
    `
    const _syncLog = (line) => box.logs.push(line);
    const Module = { _kn_get_debug_log: () => 1, UTF8ToString: () => box.buffer };
    if (canClear) {
      Module._kn_clear_debug_log = () => { box.buffer = ''; };
      Module._kn_get_debug_log_dropped = () => box.dropped;
    }
    const window = { KNCore: { cLogTail, cLogDrain, cLogDroppedSince }, EJS_emulator: { gameManager: { Module } } };
    ${drainSource}
    box.drain = _drainCDebugLog;
    `,
    vm.createContext({ box, canClear, cLogTail, cLogDrain, cLogDroppedSince }),
  );
  return box;
};

test('a core that can empty its log gives the whole buffer up at each drain', () => {
  assert.deepEqual(cLogDrain('a\nb\n', 0, true), { tail: 'a\nb\n', drained: 0, clear: true });
  assert.deepEqual(cLogDrain('', 0, true), { tail: '', drained: 0, clear: false });
  // An older core: the tail past what was drained, as cLogTail.
  assert.deepEqual(cLogDrain('a\nb\n', 2, false), { tail: 'b\n', drained: 4, clear: false });
});

test('dropped lines since the last drain; a lower count is a new init', () => {
  assert.equal(cLogDroppedSince(0, 0), 0);
  assert.equal(cLogDroppedSince(3, 10), 7);
  assert.equal(cLogDroppedSince(10, 4), 4);
});

test('the engine sends each drain once and empties the C log', () => {
  const c = drainer(true);
  c.buffer = 'MISPREDICTION slot=1 f=40\nC-REPLAY-FRAME f=41\n';
  c.drain();
  assert.deepEqual(c.logs, ['[C] MISPREDICTION slot=1 f=40', '[C] C-REPLAY-FRAME f=41']);
  assert.equal(c.buffer, '', 'emptied, so it only holds what comes after');
  c.logs.length = 0;
  c.buffer = 'C-REPLAY-FRAME f=42\n';
  c.drain();
  assert.deepEqual(c.logs, ['[C] C-REPLAY-FRAME f=42']);
});

test('the engine says when the C log dropped lines, once for each growth', () => {
  const c = drainer(true);
  c.buffer = 'SAVE-SKIP from f=0\n';
  c.dropped = 12;
  c.drain();
  assert.deepEqual(c.logs, ['[C] SAVE-SKIP from f=0', 'C-LOG-DROPPED n=12: the C log was full between two drains']);
  c.logs.length = 0;
  c.drain();
  assert.deepEqual(c.logs, [], 'no new drops, nothing said');
  c.dropped = 15;
  c.drain();
  assert.deepEqual(c.logs, ['C-LOG-DROPPED n=3: the C log was full between two drains']);
});

test('the engine drains a C buffer that started over shorter than its count', () => {
  const c = drainer();
  c.buffer = 'C-ROLLBACK init a\nMISPREDICTION slot=1 f=40\nC-REPLAY-FRAME f=41\n';
  c.drain();
  assert.deepEqual(c.logs, ['[C] C-ROLLBACK init a', '[C] MISPREDICTION slot=1 f=40', '[C] C-REPLAY-FRAME f=41']);
  // kn_rollback_init started it over, and nothing reset the count.
  c.logs.length = 0;
  c.buffer = 'SAVE-SKIP from f=3119\n';
  c.drain();
  assert.deepEqual(c.logs, ['[C] SAVE-SKIP from f=3119']);
  // It goes on from there.
  c.logs.length = 0;
  c.buffer += 'SAVE-RESUME f=3120\n';
  c.drain();
  assert.deepEqual(c.logs, ['[C] SAVE-RESUME f=3120']);
  c.drain();
  assert.deepEqual(c.logs, ['[C] SAVE-RESUME f=3120'], 'nothing new, nothing sent');
});

test('doRollbackInit drains the C log before a re-init within a match, and resets the count after', () => {
  const init = src.slice(src.indexOf('const doRollbackInit = ('));
  // Only when armed already: at a match's first init the buffer holds the
  // last match's tail (kn_rollback_shutdown logs after its final flush).
  const drainAt = init.indexOf('if (_useCRollback) _drainCDebugLog();');
  const initAt = init.indexOf('detMod._kn_rollback_init(');
  const resetAt = init.indexOf('_cDebugLogLastLen = 0;');
  assert.ok(drainAt > 0 && drainAt < initAt, 'drained before kn_rollback_init starts the buffer over');
  assert.ok(resetAt > initAt, 'the count is reset after it');
});
