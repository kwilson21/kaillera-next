import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkRelayed } from '../web/src/relay.ts';
import { createOwnerProofRelay } from '../web/src/owner-proof-relay.ts';
import { openProof } from '../web/src/owner-proof.ts';
import { decodeOwnerProof, OWNER_PROOF_REQUEST, OWNER_PROOF_REPLY } from '../web/src/owner-proof-wire.ts';

const pulse = [2, 0, 0, 0, 0];
const neutral = [0, 0, 0, 0, 0];
const frame = 1194;
const one = 1182;
const two = 1189;
const token = 'proofA_0123456789abcdefgh';
const token2 = 'proofB_0123456789abcdefgh';
const member = (slot) => ({
  identity: { match: 'local-running-match', epoch: 19, sid: `actual-sid-${slot}`, slot, gen: slot + 3 },
  peerKey: `peer-stable-${slot}`,
  active: true,
  original: true,
});
const players = [member(0), member(1), member(2), member(3)];
const host = players[0];
const owner = players[1];
const stamp = (m) => ({ sid: m.identity.sid, slot: m.identity.slot, owner: m.identity.slot === 0 });
const req = { type: OWNER_PROOF_REQUEST, targetSid: owner.identity.sid, token, ids: [one, two], knFrom: stamp(host) };
const reply = {
  type: OWNER_PROOF_REPLY,
  targetSid: host.identity.sid,
  token,
  samples: [[two, pulse]],
  knFrom: stamp(owner),
};

function fixture(slot = 0) {
  const self = players[slot];
  const socket = { connected: true, id: self.identity.sid };
  const v = { game: { mode: 'normal-native', running: true, self, members: players }, now: 100 };
  const sent = [];
  // Production _signalSocket exposes emit but has NO identity.
  const transport = { emit: (...args) => sent.push(args) };
  const proofs = new Map();
  const confirmed = new Map();
  const authored = new Map();
  const relay = createOwnerProofRelay({
    socket: () => socket,
    session: () => v.game,
    transport,
    checkRelayed,
    now: () => v.now,
    getProof: (t) => proofs.get(t),
    confirmed: (m) => confirmed.get(m.peerKey) ?? new Map(),
    getAuthoredInput: (id) => authored.get(id),
  });
  return { relay, v, socket, sent, transport, proofs, confirmed, authored };
}
function lease(f, m = owner, t = token, ids = [one, two]) {
  const p = openProof({ owner: m.identity, token: t, frame, delay: 5, cap: 7, missing: ids, now: 100, ttl: 600 });
  assert.ok(p);
  f.proofs.set(t, p);
  return p;
}
test('real socket ID, not emit-only wrapper, addresses the exact current owner and live token', () => {
  const f = fixture();
  const p = lease(f);
  assert.equal(f.transport.id, undefined);
  assert.equal(f.relay.sendRequest(p), true);
  assert.deepEqual(f.sent, [
    ['data-message', { type: OWNER_PROOF_REQUEST, targetSid: owner.identity.sid, token, ids: [one, two] }],
  ]);
  assert.equal(f.relay.sendRequest({ ...p }), false); // not the registered actor lease
  f.socket.id = 'replacement-host';
  assert.equal(f.relay.sendRequest(p), false);
  assert.equal(f.sent.length, 1);
  assert.equal(fixture(1).relay.sendRequest(p), false);
});
test('only a properly stamped current host may request and only authored IDs leave the owner', () => {
  const f = fixture(1);
  f.authored.set(two, { authored: true, value: pulse });
  f.authored.set(one, { authored: false, value: neutral });
  const wrongTarget = { ...req, targetSid: 'previous-owner-sid' };
  const wrongSender = { ...req, knFrom: stamp(players[2]), senderSid: host.identity.sid };
  const wrongHost = { ...req, knFrom: { ...stamp(host), sid: 'old-host-sid' } };
  const nonPlayer = { ...req, knFrom: { ...stamp(host), slot: null } };
  for (const bad of [{ ...req, knFrom: undefined }, wrongTarget, wrongSender, wrongHost, nonPlayer])
    assert.equal(f.relay.onMessage(bad), null);
  assert.deepEqual(f.relay.onMessage(req), { kind: 'replied', count: 1 });
  assert.deepEqual(f.sent, [
    ['data-message', { type: OWNER_PROOF_REPLY, targetSid: host.identity.sid, token, samples: [[two, pulse]] }],
  ]);
  f.authored.set(one, { authored: true, value: neutral });
  assert.deepEqual(f.relay.onMessage(req), { kind: 'replied', count: 2 }); // true neutral is allowed
});
test('decoding is total for plain JSON and bounds duplicates, dimensions, values and spread', () => {
  for (const bad of [
    null,
    'raw',
    [],
    { ...req, token: 'short' },
    { ...req, targetSid: '' },
    { ...req, ids: [] },
    { ...req, ids: [one, one] },
    { ...req, ids: [one, two + 1] },
    { ...req, ids: Array.from({ length: 9 }, (_, i) => one + i) },
    { ...req, ids: [-1] },
    { ...req, ids: [1.4] },
    { ...req, ids: [Number.MAX_SAFE_INTEGER] },
    { ...reply, samples: [[two, [2, 128, 0, 0, 0]]] },
    { ...reply, samples: [[two, [2, 0, 0, 0, 0, 0]]] },
    {
      ...reply,
      samples: [
        [two, pulse],
        [two, pulse],
      ],
    },
    {
      ...reply,
      samples: [
        [two, pulse],
        [two + 8, neutral],
      ],
    },
  ])
    assert.equal(decodeOwnerProof(bad), null);
  assert.deepEqual(decodeOwnerProof({ ...req, generation: 123, other: 'extra' }), {
    type: OWNER_PROOF_REQUEST,
    token,
    targetSid: owner.identity.sid,
    ids: [one, two],
  });
});
test('accepts partial and separate owner receipts only on their own live current stamped sessions', () => {
  const f = fixture();
  const first = lease(f);
  lease(f, players[2], token2, [two]);
  assert.equal(f.relay.onMessage({ ...reply, token: token2 }), null);
  assert.equal(f.relay.onMessage({ ...reply, knFrom: stamp(players[2]), senderSid: owner.identity.sid }), null);
  assert.equal(f.relay.onMessage({ ...reply, targetSid: 'retired-host' }), null);
  assert.equal(f.relay.onMessage({ ...reply, samples: [[one + 1, pulse]] }), null);
  const a = f.relay.onMessage(reply);
  assert.deepEqual(a.confirmedMissing, [[two, pulse]]);
  assert.equal(a.next.accepted.size, 1);
  assert.equal(a.epoch, 19);
  assert.equal(a.owner.peerKey, owner.peerKey);
  assert.equal(first.accepted.size, 0);
  f.proofs.set(token, a.next);
  const duplicate = f.relay.onMessage(reply);
  assert.deepEqual(duplicate.confirmedMissing, []);
  const b = f.relay.onMessage({ ...reply, samples: [[one, neutral]] });
  assert.equal(b.next.accepted.size, 2);
  const second = f.relay.onMessage({ ...reply, token: token2, knFrom: stamp(players[2]) });
  assert.equal(second.owner.peerKey, players[2].peerKey);
});
test('same raw socket with replacement RTC generation or stale epoch cannot satisfy old lease', () => {
  const f = fixture();
  const p = lease(f);
  for (const changed of [
    { ...owner, identity: { ...owner.identity, sid: 'new-owner' } },
    { ...owner, identity: { ...owner.identity, gen: owner.identity.gen + 1 } },
    { ...owner, identity: { ...owner.identity, epoch: owner.identity.epoch + 1 } },
    { ...owner, active: false },
    { ...owner, original: false },
  ]) {
    f.v.game.members = [host, changed, ...players.slice(2)];
    assert.equal(f.relay.sendRequest(p), false);
    assert.equal(f.relay.onMessage(reply), null);
    assert.equal(f.relay.onMessage({ ...reply, knFrom: stamp(changed) }), null);
  }
  f.v.game.members = players;
  f.v.now = 700;
  assert.equal(f.relay.onMessage(reply), null);
  assert.equal(f.relay.sendRequest(p), false);
});
test('cannot overwrite confirmed transport values or substitute an altered accepted duplicate', () => {
  const f = fixture();
  lease(f);
  f.confirmed.set(owner.peerKey, new Map([[two, neutral]]));
  assert.equal(f.relay.onMessage(reply), null);
  f.confirmed.set(owner.peerKey, new Map([[two, pulse]]));
  const a = f.relay.onMessage(reply);
  assert.deepEqual(a.confirmedMissing, []);
  assert.deepEqual(f.confirmed.get(owner.peerKey).get(two), pulse);
  f.proofs.set(token, a.next);
  f.confirmed.clear();
  assert.equal(f.relay.onMessage({ ...reply, samples: [[two, neutral]] }), null);
  f.confirmed.set(owner.peerKey, new Map([[two, neutral]]));
  assert.equal(f.relay.onMessage({ ...reply, samples: [[one, neutral]] }), null);
});
test('optional worker, other modes, two players, ambiguous cohort, and disconnected views are inert', () => {
  const cases = [
    (f) => (f.v.game.mode = 'worker'),
    (f) => (f.v.game.mode = 'other'),
    (f) => (f.v.game.members = players.slice(0, 2)),
    (f) => (f.v.game.members = [...players.slice(0, 3), owner]),
    (f) => (f.socket.connected = false),
    (f) => (f.v.game.running = false),
  ];
  for (const alter of cases) {
    const f = fixture();
    const p = lease(f);
    alter(f);
    assert.equal(f.relay.sendRequest(p), false);
    assert.equal(f.relay.onMessage(reply), null);
    assert.equal(f.sent.length, 0);
    const own = fixture(1);
    own.authored.set(two, { authored: true, value: pulse });
    alter(own);
    assert.equal(own.relay.onMessage(req), null);
    assert.equal(own.sent.length, 0);
  }
});
