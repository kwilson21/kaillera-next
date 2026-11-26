import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CheckpointRecovery } from '../../web/src/checkpoint-recovery.ts';
import { CheckpointJournal, neutral } from '../../web/src/checkpoint-journal.ts';
import { decodeCheckpoint, type CheckpointWire } from '../../web/src/checkpoint-wire.ts';
import type { Input } from '../../web/src/owner-proof.ts';

type Filter = (from: number, m: CheckpointWire) => boolean;
type TestPeer = {
  frame: number;
  scope: boolean;
  route: boolean;
  restores: number;
  steps: number;
  resumed: number;
  logged: string[];
  wake: (() => void) | null;
};
async function match(allow: Filter = () => true, size = 3) {
  const members = Array.from({ length: size }, (_, slot) => ({ slot, sid: 'player-' + slot }));
  const scope = { match: 'session', mask: (1 << size) - 1, fingerprint: 'core-rom', members };
  const state = members.map((): TestPeer => ({
    frame: 0,
    scope: true,
    route: true,
    restores: 0,
    steps: 0,
    resumed: 0,
    logged: [],
    wake: null,
  }));
  const queue: { from: number; msg: CheckpointWire }[] = [];
  const traffic: { from: number; msg: CheckpointWire }[] = [];
  const value = (slot: number, tag: number): Input => [tag % 2, slot, tag % 83, 0, 0];
  const peers = members.map(({ slot }) => {
    const s = state[slot];
    assert.ok(s);
    return new CheckpointRecovery(
      {
        scope: () => (s.scope ? scope : null),
        rosterConfirmed: () => true,
        frame: () => s.frame,
        delay: () => 2,
        safe: () => true,
        failed: () => 0,
        capture: () => ({
          frame: s.frame,
          bytes: Uint8Array.of(s.frame),
          hle: Uint8Array.of(9),
          hidden: Uint32Array.of(1),
          fifo: Uint32Array.of(5),
        }),
        install: (snapshot) => {
          s.frame = snapshot.frame;
          s.restores++;
          return true;
        },
        replay: (step) => {
          assert.equal(step.frame, s.frame);
          assert.deepEqual(
            step.inputs,
            members.map((m) => (s.frame < 2 ? neutral : value(m.slot, s.frame - 2))),
          );
          s.frame++;
          s.steps++;
          return true;
        },
        prepare: (r) => r === s.frame,
        first: () => value(slot, 60),
        resume: (r, inputs, run) => {
          assert.equal(r, 60);
          assert.equal(run.request, 7);
          assert.equal(inputs.size, size);
          s.resumed++;
        },
        currentRoute: () => s.route,
        canReturn: (id) => id === 7,
        log: (l) => {
          s.logged.push(l);
        },
        unresolved: () => {},
        recovering: () => {},
        send: (raw) => {
          const msg = decodeCheckpoint(raw);
          assert.ok(msg);
          const packet = { from: slot, msg };
          traffic.push(packet);
          if (allow(slot, msg)) queue.push(packet);
        },
      },
      scope,
      slot,
      (wake: () => void) => {
        s.wake = wake;
        return () => {
          s.wake = null;
        };
      },
    );
  });
  function deliver(from: number, msg: CheckpointWire) {
    const sender = members[from],
      target = members.find((m) => m.sid === msg.targetSid);
    assert.ok(sender && target);
    peers[target.slot]?.receive({ ...msg, knFrom: { ...sender, owner: from === 0 } });
  }
  async function advance(until: () => boolean) {
    for (let i = 0; i < 150; i++) {
      while (queue.length) {
        const next = queue.shift();
        if (next) deliver(next.from, next.msg);
      }
      for (const s of state) s.wake?.();
      if (until()) return;
      await delay(2);
    }
    assert.fail('coordinator did not reach expected state: ' + peers.map((p) => p.phase).join(','));
  }
  peers.forEach((p) => p.sample(0));
  await advance(() => state.every((s) => s.logged.some((l) => l.includes('CHECKPOINT-AGREED'))));
  peers.forEach((peer, slot) => {
    for (let tag = 0; tag < 60; tag++) {
      peer.journal.witness(slot, tag, value(slot, tag));
      peer.journal.executed(
        tag,
        2,
        members.map(() => neutral),
      );
    }
  });
  assert.equal(peers[0]?.request(1, 7), true);
  state.forEach((s) => {
    s.frame = 60;
  });
  return { peers, state, traffic, advance, deliver };
}

test('three and four cores replay authored inputs and release once, with duplicate install receipts', async () => {
  for (const size of [3, 4]) {
    const m = await match(undefined, size);
    await m.advance(() => m.state.every((s) => s.resumed === 1));
    for (const p of m.traffic.filter((p) => p.msg.op === 'installed')) m.deliver(p.from, p.msg);
    for (const s of m.state) s.wake?.();
    assert.ok(m.state.every((s) => s.resumed === 1 && s.restores === 1 && s.steps === 60));
  }
});
test('returning owner records need the stamped sender, same epoch and exact bystander value', async () => {
  for (const attempt of ['wrong-owner', 'stale', 'conflict']) {
    const m = await match((from, msg) => from !== 1 || msg.op !== 'journal');
    await m.advance(() => m.peers.every((p) => p.phase === 'frozen'));
    for (const { msg } of m.traffic.filter((p) => p.from === 1 && p.msg.op === 'journal')) {
      if (msg.op !== 'journal') continue;
      if (attempt === 'conflict') {
        const target = m.peers.find((p) => p.self === Number(msg.targetSid.slice(-1)));
        target?.witness(1, 'player-1', msg.start, [4, 0, 0, 0, 0]);
        m.deliver(1, msg);
      } else if (attempt === 'stale') m.deliver(1, { ...msg, epoch: 11 });
      else m.deliver(2, msg);
    }
    m.state.forEach((s) => s.wake?.());
    assert.ok(m.state.every((s) => !s.resumed && !s.restores));
  }
});
test('a missing install receipt holds all players after replay and a replaced channel cannot commit', async () => {
  const m = await match((from, msg) => from !== 2 || msg.op !== 'installed');
  await m.advance(() => m.state.every((s) => s.logged.some((l) => l.includes('CHECKPOINT-INSTALLED'))));
  assert.ok(m.state.every((s) => !s.resumed));
  const host = m.state[0];
  assert.ok(host);
  host.route = false;
  const ack = m.traffic.find((p) => p.from === 2 && p.msg.op === 'installed' && p.msg.targetSid === 'player-0');
  assert.ok(ack);
  m.deliver(ack.from, ack.msg);
  await m.advance(() => m.peers.every((p) => p.phase === 'unresolved'));
  assert.ok(!m.traffic.some((p) => p.msg.op === 'release'));
});
test('an installed peer recovers a lost release and first input from the recorded decision', async () => {
  let held = true;
  const m = await match(
    (_from, msg) => !(held && msg.targetSid === 'player-2' && ['ready', 'release'].includes(msg.op)),
  );
  await m.advance(() => m.peers[0]?.phase === 'committed' && m.peers[2]?.phase === 'installed');
  held = false;
  const frozen = m.traffic.find((p) => p.msg.op === 'freeze');
  assert.ok(frozen && frozen.msg.op === 'freeze');
  for (const sid of ['player-0', 'player-1']) m.deliver(2, { ...frozen.msg, op: 'decision', targetSid: sid });
  await m.advance(() => m.state.every((s) => s.resumed === 1));
  const count = m.traffic.length;
  m.deliver(2, { ...frozen.msg, op: 'decision', targetSid: 'player-0' });
  assert.deepEqual(
    m.traffic.slice(count).map((p) => p.msg.op),
    ['release', 'ready'],
  );
});
test('a replaced socket roster before the writes remains paused', async () => {
  const m = await match();
  const s = m.state[0];
  assert.ok(s);
  s.scope = false;
  s.wake?.();
  assert.equal(m.peers[0]?.phase, 'unresolved');
  assert.equal(s.restores, 0);
});
test('the bounded journal refuses conflicting observations and old tags cannot evict new ones', () => {
  const j = new CheckpointJournal(1, [0, 1, 2]);
  j.witness(1, 2048, neutral);
  j.witness(1, 0, [9, 0, 0, 0, 0]);
  assert.equal(j.owner(0), undefined);
  assert.deepEqual(j.owner(2048), neutral);
  j.executed(2048, 0, [neutral, neutral, neutral]);
  assert.ok(j.transcript(2048, 2049));
  j.witness(2, 2048, neutral);
  j.witness(2, 2048, [8, 0, 0, 0, 0]);
  assert.equal(j.transcript(2048, 2049), null);
});

test('a stopped frame pump still aborts on a changed route', async () => {
  const { peers, state } = await match();
  const host = state[0]!;
  host.frame = 20;
  host.route = false;
  host.wake?.();
  assert.equal(peers[0]?.phase, 'unresolved');
  assert.equal(host.restores, 0);
  assert.equal(host.wake, null);
});

test('a planned freeze holds the boundary until the recovery clock can process it', async () => {
  const { peers, state } = await match();
  const host = state[0]!;
  const recovery = peers[0]!;
  host.frame = 59;
  assert.equal(recovery.holdsFrame, false);
  host.wake?.();
  assert.equal(recovery.phase, 'approaching');
  host.frame = 60;
  assert.equal(recovery.holdsFrame, true);
  assert.equal(recovery.phase, 'approaching');
  host.wake?.();
  assert.equal(recovery.phase, 'frozen');
  assert.equal(recovery.holdsFrame, true);
});

test('a stopped frame pump expires before the planned checkpoint boundary', async (t) => {
  const startedAt = performance.now();
  const now = t.mock.method(performance, 'now', () => startedAt);
  const { peers, state } = await match();
  const host = state[0]!;
  host.frame = 20;
  now.mock.mockImplementation(() => startedAt + 19999);
  host.wake?.();
  assert.equal(peers[0]?.phase, 'approaching');
  now.mock.mockImplementation(() => startedAt + 20000);
  host.wake?.();
  assert.equal(peers[0]?.phase, 'unresolved');
  assert.equal(host.restores, 0);
  assert.equal(host.wake, null);
});
