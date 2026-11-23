import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { cLogTail } from '../../web/src/c-log-tail.ts';

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

test('doRollbackInit drains the C log before kn_rollback_init and resets the count after', () => {
  const init = src.slice(src.indexOf('const doRollbackInit = ('));
  const drainAt = init.indexOf('_drainCDebugLog();');
  const initAt = init.indexOf('detMod._kn_rollback_init(');
  const resetAt = init.indexOf('_cDebugLogLastLen = 0;');
  assert.ok(drainAt > 0 && drainAt < initAt, 'drained before kn_rollback_init starts the buffer over');
  assert.ok(resetAt > initAt, 'the count is reset after it');
});
