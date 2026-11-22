/**
 * The host's resyncs on a phantom's recovery (web/src/recovery-resync.ts,
 * specs/phantom_settle.qnt).
 *
 * Run: node --test tests/ts/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resyncedOnRecovery, scheduleRecoveryResyncs } from '../../web/src/recovery-resync.ts';

const FOUR = [
  { sid: 'host', slot: 0 },
  { sid: 'p2', slot: 1 },
  { sid: 'p3', slot: 2 },
  { sid: 'p4', slot: 3 },
];
// The page's _peers holds everyone but the host itself.
const PEERS = FOUR.slice(1);
const perSid = (queue: { targetSid: string }[]) => {
  const n: Record<string, number> = {};
  for (const r of queue) n[r.targetSid] = (n[r.targetSid] ?? 0) + 1;
  return n;
};

test('only player guests are resynced', () => {
  assert.equal(resyncedOnRecovery(0), false, 'the host');
  for (const slot of [1, 2, 3]) assert.equal(resyncedOnRecovery(slot), true);
  for (const slot of [null, undefined, -1, 4, 1.5, Number.NaN]) assert.equal(resyncedOnRecovery(slot), false);
});

test('a recovery resyncs the recovered guest and every other player guest, once each', () => {
  const { queue, others } = scheduleRecoveryResyncs([], PEERS, 'p2', 1000, 5);
  assert.deepEqual(
    queue.map((r) => r.targetSid),
    ['p2', 'p3', 'p4'],
  );
  assert.ok(queue.every((r) => r.targetFrame === 1000 && r.deadlineAt === 5));
  assert.deepEqual(others, [2, 3]);
});

test('a spectator or a peer with no slot is not resynced', () => {
  const peers = [...PEERS.slice(0, 2), { sid: 'spec', slot: null }];
  const { queue, others } = scheduleRecoveryResyncs([], peers, 'p2', 1000, 5);
  assert.deepEqual(
    queue.map((r) => r.targetSid),
    ['p2', 'p3'],
  );
  assert.deepEqual(others, [2]);
});

test('four players, two phantoms recovering one after the other: one request per guest, at the later frame', () => {
  // P2 and P4 were both phantoms. P2 is heard from first, then P4.
  const first = scheduleRecoveryResyncs([], PEERS, 'p2', 1000, 5);
  const second = scheduleRecoveryResyncs(first.queue, PEERS, 'p4', 1010, 6);
  assert.deepEqual(perSid(second.queue), { p2: 1, p3: 1, p4: 1 });
  assert.ok(second.queue.every((r) => r.targetFrame === 1010));
  assert.deepEqual(second.others, [1, 2]);
});

test('requests already queued for a guest are replaced, others are kept', () => {
  const queued = [
    { targetFrame: 900, targetSid: 'p3', deadlineAt: 1, extra: 'direct' },
    { targetFrame: 950, targetSid: 'gone', deadlineAt: 2, extra: 'kept' },
  ];
  const { queue } = scheduleRecoveryResyncs(queued, PEERS, 'p2', 1000, 5);
  assert.deepEqual(perSid(queue), { gone: 1, p2: 1, p3: 1, p4: 1 });
  assert.equal(queue.find((r) => r.targetSid === 'p3')?.targetFrame, 1000);
  assert.deepEqual(queue[0], queued[1], 'a request for anyone else is kept as it was');
});

test('a two-player match resyncs the guest alone', () => {
  const { queue, others } = scheduleRecoveryResyncs([], [{ sid: 'p2', slot: 1 }], 'p2', 1000, 5);
  assert.deepEqual(
    queue.map((r) => r.targetSid),
    ['p2'],
  );
  assert.deepEqual(others, []);
});
