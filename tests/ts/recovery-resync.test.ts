/**
 * The host's resyncs on a phantom's recovery (web/src/recovery-resync.ts,
 * specs/phantom_settle.qnt).
 *
 * Run: node --test tests/ts/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scheduleRecoveryResyncs } from '../../web/src/recovery-resync.ts';
import { recoveryResyncSlots } from '../../web/src/recovery-resync-slots.ts';

const FOUR = [
  { sid: 'host', slot: 0, pendingLateJoin: false },
  { sid: 'p2', slot: 1, pendingLateJoin: false },
  { sid: 'p3', slot: 2, pendingLateJoin: false },
  { sid: 'p4', slot: 3, pendingLateJoin: false },
];
// The page's _peers holds everyone but the host itself.
const PEERS = FOUR.slice(1);
const perSid = (queue: { targetSid: string }[]) => {
  const n: Record<string, number> = {};
  for (const r of queue) n[r.targetSid] = (n[r.targetSid] ?? 0) + 1;
  return n;
};

test('the slots resynced: every player guest, the recovered one included, never the host', () => {
  assert.deepEqual(recoveryResyncSlots([0, 1, 2, 3], 1, []), [1, 2, 3]);
  assert.deepEqual(recoveryResyncSlots([0, 1], 1, []), [1], 'two players: the guest alone');
  assert.deepEqual(recoveryResyncSlots([-1, 4, 0, 2], 2, []), [2], 'no slot outside 1..3');
});

test('a guest being admitted late is left out, unless it is the one recovered', () => {
  assert.deepEqual(recoveryResyncSlots([1, 2, 3], 1, [3]), [1, 2]);
  assert.deepEqual(recoveryResyncSlots([1, 2, 3], 3, [3]), [1, 2, 3]);
});

test('each slot once, however often it is listed', () => {
  assert.deepEqual(recoveryResyncSlots([2, 1, 2, 1, 3], 1, []), [2, 1, 3]);
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
  const peers = [...PEERS.slice(0, 2), { sid: 'spec', slot: null, pendingLateJoin: false }];
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
  const { queue, others } = scheduleRecoveryResyncs(
    [],
    [{ sid: 'p2', slot: 1, pendingLateJoin: false }],
    'p2',
    1000,
    5,
  );
  assert.deepEqual(
    queue.map((r) => r.targetSid),
    ['p2'],
  );
  assert.deepEqual(others, []);
});

test('a late joiner still being admitted keeps its queued request and is not resynced', () => {
  const peers = [PEERS[0]!, PEERS[1]!, { sid: 'p4', slot: 3, pendingLateJoin: true }];
  const queued = [{ targetFrame: 990, targetSid: 'p4', deadlineAt: 1 }];
  const { queue, others } = scheduleRecoveryResyncs(queued, peers, 'p2', 1000, 5);
  assert.deepEqual(perSid(queue), { p2: 1, p3: 1, p4: 1 });
  assert.equal(queue.find((r) => r.targetSid === 'p4')?.targetFrame, 990);
  assert.deepEqual(others, [2]);
});

test('a socket follow-up it replaces keeps its transport; a channel request stays on the channel', () => {
  const queued = [
    { targetFrame: 990, targetSid: 'p3', deadlineAt: 1, transport: 'socket' as const },
    { targetFrame: 991, targetSid: 'p4', deadlineAt: 1 },
  ];
  const { queue } = scheduleRecoveryResyncs(queued, PEERS, 'p2', 1000, 5);
  assert.equal(queue.find((r) => r.targetSid === 'p3')?.transport, 'socket');
  assert.equal(queue.find((r) => r.targetSid === 'p4')?.transport, undefined);
  assert.equal(queue.find((r) => r.targetSid === 'p2')?.transport, undefined);
  assert.equal(queue.length, 3);
});

test("a guest's own queued request keeps its number, the newest when it has several", () => {
  const queued = [
    { targetFrame: 980, targetSid: 'p3', deadlineAt: 1, requestId: 5 },
    { targetFrame: 990, targetSid: 'p3', deadlineAt: 1, requestId: 7 },
    { targetFrame: 991, targetSid: 'p4', deadlineAt: 1 },
  ];
  const { queue } = scheduleRecoveryResyncs(queued, PEERS, 'p2', 1000, 5);
  const p3 = queue.filter((r) => r.targetSid === 'p3');
  assert.equal(p3.length, 1);
  assert.equal(p3[0]?.requestId, 7);
  assert.equal(p3[0]?.targetFrame, 1000);
  assert.equal(queue.find((r) => r.targetSid === 'p4')?.requestId, undefined);
  assert.equal(queue.find((r) => r.targetSid === 'p2')?.requestId, undefined);
});
