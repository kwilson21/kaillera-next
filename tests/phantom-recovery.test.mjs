// Run: node --test tests/phantom-recovery.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phantomRecovery, phantomRecoveryVerdict } from './phantom-recovery.mjs';

const line = (frame, text) => `1\t100.0\tf=${frame}\t${text}\n`;
// A host that stops for 5.2 s at frame 183; the guest drops it at 189 and
// is resynced at 214 (the shape of a real container run).
const logs = {
  host: line(183, 'LOCAL-FREEZE f=183 gap=5204ms — peer staleness clocks credited'),
  guest:
    line(127, 'sync #1 applied (frame 127 -> 127, next in 10f)') +
    line(189, 'PEER-PHANTOM slot=0 lastAdvance=19620 staleSec=5.0 — excluded from pacing') +
    line(199, 'peer-recovery resync: sent sync-request-full-at:214') +
    line(214, 'sync #2 applied (frame 214 -> 214, next in 10f)'),
};

test('mismatches between the phantom and the resync are explained', () => {
  const recovery = phantomRecovery(logs, [186, 188, 199, 213]);
  assert.deepEqual(recovery.windows, [
    { declaredBy: 'guest', from: 177, to: 214, stoppedPage: 'host', stoppedMs: 5204 },
  ]);
  assert.deepEqual([recovery.mismatchesInside, recovery.mismatchesOutside], [4, 0]);
  assert.match(phantomRecoveryVerdict(recovery), /^All 4 hash mismatches .* the host stopped for 5204 ms/);
});

test('a mismatch after the resync, or long before the phantom, is not', () => {
  for (const frame of [214, 300, 150]) {
    const recovery = phantomRecovery(logs, [190, frame]);
    assert.deepEqual([recovery.mismatchesInside, recovery.mismatchesOutside], [1, 1], `frame ${frame}`);
    assert.equal(phantomRecoveryVerdict(recovery), null);
  }
});

test('a run with no phantom explains nothing', () => {
  const quiet = { host: '', guest: line(127, 'sync #1 applied (frame 127 -> 127, next in 10f)') };
  const recovery = phantomRecovery(quiet, [120, 121]);
  assert.deepEqual(recovery, { windows: [], mismatchesInside: 0, mismatchesOutside: 2 });
  assert.equal(phantomRecoveryVerdict(recovery), null);
});

test('a phantom that is never resynced explains nothing', () => {
  const stuck = { host: '', guest: line(189, 'PEER-PHANTOM slot=0 lastAdvance=1 staleSec=5.0 — excluded from pacing') };
  const recovery = phantomRecovery(stuck, [190, 200]);
  assert.equal(recovery.windows[0].to, null);
  assert.equal(recovery.mismatchesOutside, 2);
  assert.equal(phantomRecoveryVerdict(recovery), null);
});

test('a recovery that takes two resyncs ends at the second', () => {
  const twice = {
    host: line(229, 'PEER-PHANTOM slot=1 lastAdvance=1 staleSec=5.0 — excluded from pacing'),
    guest:
      line(224, 'LOCAL-FREEZE f=224 gap=5223ms — peer staleness clocks credited') +
      line(240, 'sync #2 applied (frame 240 -> 240, next in 10f)') +
      line(247, 'sync #3 applied (frame 247 -> 247, next in 10f)'),
  };
  const recovery = phantomRecovery(twice, [242, 243, 244]);
  assert.equal(recovery.windows[0].to, 247);
  assert.deepEqual([recovery.mismatchesInside, recovery.mismatchesOutside], [3, 0]);
  assert.match(phantomRecoveryVerdict(recovery), /the guest stopped for 5223 ms/);
});

test('a resync long after the phantom is some other resync', () => {
  const late = {
    host: '',
    guest:
      line(189, 'PEER-PHANTOM slot=0 lastAdvance=1 staleSec=5.0 — excluded from pacing') +
      line(400, 'sync #2 applied (frame 400 -> 400, next in 10f)'),
  };
  const recovery = phantomRecovery(late, [200, 300]);
  assert.equal(recovery.windows[0].to, null);
  assert.equal(recovery.mismatchesOutside, 2);
});

test('a run with no mismatches has no verdict', () => {
  assert.equal(phantomRecoveryVerdict(phantomRecovery(logs, [])), null);
});
