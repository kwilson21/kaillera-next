import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initialTransition, transition } from 'xstate';
import { contextualResetMachine } from '../../web/src/contextual-reset-machine.ts';
import {
  contextualResetIntent,
  readNativePause,
  readRemixResetPhase,
  SSB64_US_HASH,
} from '../../web/src/contextual-reset.ts';

test('contextual reset requires delay and rearms for a same-owner 12CB request', () => {
  let [s] = initialTransition(contextualResetMachine);
  const send = (event: Parameters<typeof transition<typeof contextualResetMachine>>[2]) => {
    [s] = transition(contextualResetMachine, s, event);
  };
  send({ type: 'observe', scope: 'match/0/request' });
  send({ type: 'press' });
  assert.equal(s.value, 'pending');
  send({ type: 'elapsed', scope: 'match/0/request' });
  send({ type: 'press' });
  assert.equal(s.value, 'holding');
  send({ type: 'observe', scope: 'match/0/approve' });
  assert.equal(s.value, 'pending');
  send({ type: 'elapsed', scope: 'match/0/request' });
  assert.equal(s.value, 'pending');
  send({ type: 'elapsed', scope: 'match/0/approve' });
  assert.equal(s.value, 'ready');
  send({ type: 'press' });
  assert.equal(s.value, 'holding');
  send({ type: 'observe', scope: '' });
  assert.equal(s.value, 'hidden');
});

test('eligibility is owner-only, slot based, and fail closed', () => {
  for (let slot = -1; slot < 5; slot++)
    for (let owner = 0; owner < 4; owner++) {
      const eligible = slot === owner && slot >= 0 && slot < 4;
      assert.equal(contextualResetIntent(true, true, true, owner, slot, false, false), eligible ? 1 : 0);
      assert.equal(contextualResetIntent(true, true, true, owner, slot, true, true), eligible && owner < 2 ? 3 : 0);
    }
  assert.equal(contextualResetIntent(false, true, true, 0, 0, false, false), 0);
});

test('native pause requires exact ROM, scene, battle pointer, status and owner', () => {
  const ram = new Map([
    [0x800a4ad0, 22 << 24],
    [0x800a50e8, 0x800a4d08],
    [0x800a4d18, 2 << 16],
    [0x801317e4, 1 << 24],
  ]);
  const read = (a: number) => ram.get(a) ?? null;
  assert.deepEqual(readNativePause(SSB64_US_HASH, read), { owner: 1, mode: 'normal', requested: false });
  assert.equal(readNativePause('unknown', read), null);
  ram.set(0x800a4d18, 1 << 16);
  assert.equal(readNativePause(SSB64_US_HASH, read), null);
});

test('Remix decoder validates instructions and boolean fields; no address guessing', () => {
  const ram = new Map<number, number>([
    [0x801144d0, 0x0c080000],
    [0x80200000, 0x3c0f8030],
    [0x80200004, 0x35ef0000],
    [0x80200008, 0x8def0000],
    [0x8020000c, 0x15e00004],
    [0x80200010, 0],
    [0x80200020, 0x3c088030],
    [0x80200024, 0x35080004],
    [0x80200028, 0x8d0f0000],
    [0x80300000, 1],
    [0x80300004, 1],
  ]);
  const read = (a: number) => ram.get(a) ?? null;
  assert.deepEqual(readRemixResetPhase(read), { mode: '12cb', requested: true });
  ram.set(0x80300004, 2);
  assert.equal(readRemixResetPhase(read), null);
  ram.set(0x80300004, 1);
  ram.set(0x80200024, 0);
  assert.equal(readRemixResetPhase(read), null);
});

test('sudden-death pause uses the active battle pointer and rejects malformed ownership', () => {
  const ram = new Map<number, number>([
    [0x800a4ad0, 22 << 24],
    [0x800a50e8, 0x800a4ef8],
    [0x800a4f08, 2 << 16],
    [0x801317e4, 3 << 24],
  ]);
  const read = (a: number) => ram.get(a) ?? null;
  assert.deepEqual(readNativePause(SSB64_US_HASH, read), { owner: 3, mode: 'normal', requested: false });
  ram.set(0x801317e4, 4 << 24);
  assert.equal(readNativePause(SSB64_US_HASH, read), null);
  ram.set(0x801317e4, 0);
  ram.set(0x800a50e8, 0x800a4d0c);
  assert.equal(readNativePause(SSB64_US_HASH, read), null);
  ram.set(0x800a50e8, 0x800a4ef8);
  ram.delete(0x800a4f08);
  assert.equal(readNativePause(SSB64_US_HASH, read), null);
});

test('cancel, unpause and a new match invalidate stale delay callbacks and held input', () => {
  let [s] = initialTransition(contextualResetMachine);
  const send = (event: Parameters<typeof transition<typeof contextualResetMachine>>[2]) => {
    [s] = transition(contextualResetMachine, s, event);
  };
  send({ type: 'observe', scope: 'match-A/owner-0' });
  send({ type: 'cancel' });
  send({ type: 'elapsed', scope: 'match-A/owner-0' });
  assert.equal(s.value, 'hidden');
  send({ type: 'observe', scope: 'match-B/owner-0' });
  send({ type: 'elapsed', scope: 'match-A/owner-0' });
  assert.equal(s.value, 'pending');
  send({ type: 'elapsed', scope: 'match-B/owner-0' });
  send({ type: 'press' });
  send({ type: 'observe', scope: 'match-B/owner-0' });
  assert.equal(s.value, 'holding', 'unchanged observation must not release a real hold');
  send({ type: 'observe', scope: '' });
  send({ type: 'press' });
  assert.equal(s.value, 'hidden');
});
