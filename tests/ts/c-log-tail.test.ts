import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { cLogTail, cLogTailFrom } from '../../web/src/c-log-tail.ts';

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
  drain: () => void;
}

const drainer = (): Drainer => {
  const box: Drainer = { logs: [], buffer: '', drain: () => {} };
  vm.runInContext(
    `
    const _syncLog = (line) => box.logs.push(line);
    const window = { KNCore: { cLogTail }, EJS_emulator: { gameManager: { Module: {
      _kn_get_debug_log: () => 1, UTF8ToString: () => box.buffer } } } };
    ${drainSource}
    box.drain = _drainCDebugLog;
    `,
    vm.createContext({ box, cLogTail }),
  );
  return box;
};

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

// A core whose log keeps its newest lines (kn_get_debug_log_dropped).
test('with nothing dropped, cLogTailFrom is cLogTail', () => {
  for (const full of ['', 'a\n', 'a\nbb\n', 'a\nbb\nccc\n']) {
    for (let drained = 0; drained <= full.length + 2; drained++) {
      const { tail, drained: to, missed } = cLogTailFrom(full, drained, 0);
      assert.deepEqual({ tail, drained: to }, cLogTail(full, drained));
      assert.equal(missed, 0);
    }
  }
});

test('cLogTailFrom reads on from an absolute offset and counts what was dropped unread', () => {
  // 100 bytes dropped, the buffer holds offsets 100..110.
  assert.deepEqual(cLogTailFrom('0123456789', 104, 100), { tail: '456789', drained: 110, missed: 0 });
  assert.deepEqual(cLogTailFrom('0123456789', 110, 100), { tail: '', drained: 110, missed: 0 });
  // Drained to 60 only: 40 bytes went unread.
  assert.deepEqual(cLogTailFrom('0123456789', 60, 100), { tail: '0123456789', drained: 110, missed: 40 });
});

interface DroppingDrainer extends Drainer {
  dropped: number;
  skip: () => void;
}

const droppingDrainer = (): DroppingDrainer => {
  const box: DroppingDrainer = { logs: [], buffer: '', dropped: 0, drain: () => {}, skip: () => {} };
  const from = src.indexOf('  let _cDebugLogLastLen = 0;');
  const to = src.indexOf('  const _flushSyncLog = () => {', from);
  vm.runInContext(
    `
    const _syncLog = (line) => box.logs.push(line);
    const window = { KNCore: { cLogTail, cLogTailFrom }, EJS_emulator: { gameManager: { Module: {
      _kn_get_debug_log: () => 1, _kn_get_debug_log_dropped: () => box.dropped,
      UTF8ToString: () => box.buffer } } } };
    ${src.slice(from, to)}
    box.drain = _drainCDebugLog;
    box.skip = _skipCDebugLog;
    `,
    vm.createContext({ box, cLogTail, cLogTailFrom }),
  );
  return box;
};

test('the engine drains a core that drops its oldest lines: each line once, and what it missed', () => {
  const c = droppingDrainer();
  c.buffer = 'one\ntwo\n';
  c.drain();
  assert.deepEqual(c.logs, ['[C] one', '[C] two']);
  // The core dropped "one\n" (4 bytes) and logged a third line: nothing missed.
  c.logs.length = 0;
  c.dropped = 4;
  c.buffer = 'two\nthree\n';
  c.drain();
  assert.deepEqual(c.logs, ['[C] three']);
  // It dropped 20 more bytes, 10 of them never read.
  c.logs.length = 0;
  c.dropped = 24;
  c.buffer = 'nine\n';
  c.drain();
  assert.deepEqual(c.logs, ['[C] C-LOG-DROPPED bytes=10', '[C] nine']);
  c.drain();
  assert.equal(c.logs.length, 2, 'nothing new, nothing sent');
});

test("a new match skips the last match's tail on a core whose log runs on", () => {
  const c = droppingDrainer();
  c.buffer = 'last match\nkn_rollback_shutdown\n';
  c.skip();
  c.buffer += 'C-ROLLBACK init\n';
  c.drain();
  assert.deepEqual(c.logs, ['[C] C-ROLLBACK init']);
});

test('doRollbackInit resets the count only for a core whose log starts over, and skips for one whose log runs on', () => {
  const init = src.slice(src.indexOf('const doRollbackInit = ('));
  assert.ok(init.includes('if (_useCRollback) _drainCDebugLog();\n        else _skipCDebugLog();'));
  assert.ok(init.includes('if (!detMod._kn_get_debug_log_dropped) _cDebugLogLastLen = 0;'));
});
