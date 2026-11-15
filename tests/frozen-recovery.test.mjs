// Run: node --test tests/frozen-recovery.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  frozenRecoveries,
  frozenRecoveryNote,
  inFrozenRecovery,
  inFrozenRecoveryAftermath,
} from './frozen-recovery.mjs';

const line = (frame, text) => `1\t100.0\tf=${frame}\t${text}\n`;
const PHANTOM = 'PEER-PHANTOM slot=0 lastAdvance=19620 staleSec=5.0 — excluded from pacing';
const freeze = (frame, ms) => line(frame, `LOCAL-FREEZE f=${frame} gap=${ms}ms — peer staleness clocks credited`);
const resync = (n, frame) => line(frame, `sync #${n} applied (frame ${frame} -> ${frame}, next in 10f)`);

// A host that stops for 5.2 s at frame 183; the guest drops it at 189 and
// is resynced at 214 (the shape of a real container run).
const guest =
  resync(1, 127) +
  line(189, PHANTOM) +
  line(199, 'peer-recovery resync: sent sync-request-full-at:214') +
  resync(2, 214);
const logs = { host: freeze(183, 5204), guest };

test('a frozen page that is dropped and resynced is a proven recovery', () => {
  const recoveries = frozenRecoveries(logs);
  assert.deepEqual(recoveries, [
    { declaredBy: 'guest', from: 177, to: 214, stoppedPage: 'host', stoppedMs: 5204, proven: true },
  ]);
  assert.deepEqual(
    [176, 177, 190, 213, 214, 300].map((frame) => inFrozenRecovery(recoveries, frame)),
    [false, true, true, true, false, false],
  );
});

test('a phantom with no stop on the dropped page is not left out', () => {
  // It may have been the network or a data channel: those frames are compared.
  for (const host of ['', freeze(183, 1200)]) {
    const recoveries = frozenRecoveries({ host, guest });
    assert.equal(recoveries[0].to, 214);
    assert.equal(recoveries[0].proven, false);
    assert.equal(inFrozenRecovery(recoveries, 200), false);
  }
});

test("the page that declared the phantom freezing does not prove the other's stop", () => {
  const recoveries = frozenRecoveries({ host: '', guest: freeze(183, 5204) + guest });
  assert.equal(recoveries[0].proven, false);
});

test('a phantom that is never resynced, or resynced much later, is not left out', () => {
  for (const tail of ['', resync(2, 400)]) {
    const recoveries = frozenRecoveries({ host: freeze(183, 5204), guest: line(189, PHANTOM) + tail });
    assert.equal(recoveries[0].to, null);
    assert.equal(recoveries[0].proven, false);
    assert.equal(inFrozenRecovery(recoveries, 200), false);
  }
});

test('a page that stays stopped long past the phantom is still a proven recovery', () => {
  // The shape of a real run on a slow container: the guest stops at frame
  // 150 and again right after, the host drops it at 166 and plays on to 250
  // before the guest is seen again and resynced at 251.
  const host =
    line(166, 'PEER-PHANTOM slot=1 lastAdvance=19431 staleSec=5.0 — excluded from pacing') +
    line(250, 'PEER-RECOVERED slot=1 f=155 — resuming normal pacing') +
    line(250, 'peer-recovery resync: host scheduled full sync for slot=1 at f=250');
  const recoveries = frozenRecoveries({ host, guest: resync(1, 126) + freeze(150, 4905) + resync(2, 251) });
  assert.deepEqual(recoveries, [
    { declaredBy: 'host', from: 154, to: 251, stoppedPage: 'guest', stoppedMs: 4905, proven: true },
  ]);
  assert.equal(inFrozenRecovery(recoveries, 240), true);
});

test('a resync that lands as the phantom is declared belongs to the recovery before it', () => {
  // Two stops in a row: the resync at 285 ends the first recovery, the
  // second is declared at that same frame and ends at 325.
  const host =
    line(285, 'PEER-PHANTOM slot=1 lastAdvance=33498 staleSec=5.0 — excluded from pacing') +
    line(296, 'PEER-RECOVERED slot=1 f=274 — resuming normal pacing');
  const recoveries = frozenRecoveries({ host, guest: resync(3, 285) + freeze(274, 5212) + resync(4, 325) });
  assert.equal(recoveries[0].to, 325);
  assert.equal(recoveries[0].proven, true);
});

test('a page seen again but resynced much later is not left out', () => {
  const host =
    line(166, 'PEER-PHANTOM slot=1 lastAdvance=19431 staleSec=5.0 — excluded from pacing') +
    line(250, 'PEER-RECOVERED slot=1 f=155 — resuming normal pacing');
  const recoveries = frozenRecoveries({ host, guest: freeze(150, 4905) + resync(2, 400) });
  assert.equal(recoveries[0].to, null);
  assert.equal(recoveries[0].proven, false);
});

test('a recovery that takes two resyncs ends at the second', () => {
  const recoveries = frozenRecoveries({
    host: line(229, 'PEER-PHANTOM slot=1 lastAdvance=1 staleSec=5.0 — excluded from pacing'),
    guest: freeze(224, 5223) + resync(2, 240) + resync(3, 247),
  });
  assert.equal(recoveries[0].to, 247);
  assert.equal(recoveries[0].proven, true);
  assert.equal(inFrozenRecovery(recoveries, 244), true);
});

test('a run with no phantom leaves nothing out', () => {
  const recoveries = frozenRecoveries({ host: freeze(349, 6072), guest: resync(1, 127) });
  assert.deepEqual(recoveries, []);
  assert.equal(inFrozenRecovery(recoveries, 349), false);
  assert.equal(frozenRecoveryNote(recoveries, 0, 0), null);
});

test("a recovery's failed-rollback reports belong to it until 30 frames after the resync", () => {
  const recoveries = frozenRecoveries(logs);
  assert.deepEqual(
    [176, 177, 208, 214, 243, 244, 500].map((frame) => inFrozenRecoveryAftermath(recoveries, frame)),
    [false, true, true, true, true, false, false],
  );
  // An unproven phantom excuses nothing.
  assert.equal(inFrozenRecoveryAftermath(frozenRecoveries({ host: '', guest }), 208), false);
  assert.match(frozenRecoveryNote(recoveries, 28, 17, 11), /11 failed-rollback reports from the same frames/);
  assert.match(frozenRecoveryNote(recoveries, 0, 0, 3), /3 failed-rollback reports/);
});

test('the note says who stopped, for how long, and what was left out', () => {
  const note = frozenRecoveryNote(frozenRecoveries(logs), 28, 17);
  assert.match(note, /^Left out of the hash compare: 28 frames, 17 of them differing/);
  assert.match(note, /the host stopped for 5204 ms and was dropped as a phantom \(frames 177 to 213\)/);
});
