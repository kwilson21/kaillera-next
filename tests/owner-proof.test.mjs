import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openProof, acceptReply, captureAllowed } from '../web/src/owner-proof.ts';

const owner = { match: 'm', epoch: 1, sid: 'original', slot: 1, gen: 3 };
const open = { owner, token: 'proof', frame: 1076, delay: 3, cap: 7, missing: [1066, 1073], now: 100, ttl: 500 };
const ready = {
  frame: 1076,
  pendingRollback: false,
  replayDepth: 0,
  failedRollbacks: 0,
  initialFailures: 0,
  confirmedConsumedInputs: true,
};
const pulse = [2, 0, 0, 0, 0];
const neutral = [0, 0, 0, 0, 0];
const reply = {
  sender: owner,
  token: 'proof',
  samples: [
    [1073, pulse],
    [1066, neutral],
  ],
  now: 150,
};
test('the edge and next required frame are legal; expired rollback history is not', () => {
  assert.ok(openProof(open));
  assert.equal(openProof({ ...open, missing: [1065] }), null);
  assert.equal(openProof({ ...open, missing: [1074] }), null);
});
test('current original owner, token, generation, and exact requested IDs are mandatory', () => {
  const p = openProof(open);
  for (const change of [
    { sender: { ...owner, sid: 'listener' } },
    { token: 'stale' },
    { sender: { ...owner, gen: 4 } },
    { samples: [[1072, pulse]] },
    { now: 600 },
  ]) {
    assert.equal(acceptReply(p, owner, { ...reply, ...change }, new Map()), null);
  }
  assert.equal(acceptReply(p, { ...owner, gen: 4 }, reply, new Map()), null);
});
test('capture must wait for all exact owner values and native replay at unchanged frame', () => {
  const p = openProof(open);
  const partial = acceptReply(p, owner, { ...reply, samples: [[1073, pulse]] }, new Map());
  assert.equal(captureAllowed(partial, owner, 180, ready), false);
  const filled = acceptReply(partial, owner, { ...reply, samples: [[1066, neutral]] }, new Map());
  assert.equal(captureAllowed(filled, owner, 190, ready), true);
  for (const change of [
    { frame: 1077 },
    { pendingRollback: true },
    { replayDepth: 1 },
    { failedRollbacks: 1 },
    { confirmedConsumedInputs: false },
  ]) {
    assert.equal(captureAllowed(filled, owner, 190, { ...ready, ...change }), false);
  }
  assert.equal(captureAllowed(filled, owner, 600, ready), false);
});
test('no replacement of a confirmed conflicting live input, and provenance-neutral is allowed', () => {
  const p = openProof(open);
  assert.equal(acceptReply(p, owner, reply, new Map([[1073, neutral]])), null);
  const filled = acceptReply(p, owner, reply, new Map([[1066, neutral]]));
  assert.deepEqual(filled.accepted.get(1066), neutral);
  const v = [...pulse];
  const copy = acceptReply(p, owner, { ...reply, samples: [[1073, v]] }, new Map());
  v[0] = 0;
  assert.deepEqual(copy.accepted.get(1073), pulse);
});
