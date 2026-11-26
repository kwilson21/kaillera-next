import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lockstepStep } from '../../web/src/lockstep-wait.ts';

// The engine's limits: ask again at MAX_STALL_MS, give up at
// MAX_STALL_MS + RESEND_TIMEOUT_MS, as the rollback input stall does.
const ASK = 3000;
const GIVE_UP = 5000;

test('every input here: the frame runs, however long it took', () => {
  for (const waited of [0, 1, ASK, GIVE_UP, 60_000]) assert.equal(lockstepStep(0, waited, ASK, GIVE_UP), 'run');
});

test('an input missing: wait, then ask again, then drop the player', () => {
  assert.equal(lockstepStep(1, 0, ASK, GIVE_UP), 'wait');
  assert.equal(lockstepStep(1, ASK - 1, ASK, GIVE_UP), 'wait');
  assert.equal(lockstepStep(1, ASK, ASK, GIVE_UP), 'askAgain');
  assert.equal(lockstepStep(1, GIVE_UP - 1, ASK, GIVE_UP), 'askAgain');
  assert.equal(lockstepStep(1, GIVE_UP, ASK, GIVE_UP), 'drop');
  assert.equal(lockstepStep(3, 60_000, ASK, GIVE_UP), 'drop');
});

test('a missing input never runs the frame without dropping someone', () => {
  for (let missing = 1; missing <= 3; missing++) {
    for (let waited = 0; waited <= 6000; waited += 250) {
      const step = lockstepStep(missing, waited, ASK, GIVE_UP);
      assert.notEqual(step, 'run');
      assert.equal(step === 'drop', waited >= GIVE_UP);
    }
  }
});

test('the play page reads every mode through one rule; rollback and lockstep both run the game', async () => {
  const { normalizeMode, everyoneRunsTheGame } = await import('../../web/src/play/mode.ts');
  assert.equal(normalizeMode('lockstep'), 'classic');
  assert.equal(normalizeMode('classic'), 'classic');
  assert.equal(normalizeMode('streaming'), 'streaming');
  assert.equal(normalizeMode('rollback'), 'rollback');
  for (const other of [null, undefined, '', 'turbo', 'Lockstep']) assert.equal(normalizeMode(other), 'rollback');
  assert.equal(everyoneRunsTheGame('rollback'), true);
  assert.equal(everyoneRunsTheGame('lockstep'), true);
  assert.equal(everyoneRunsTheGame('streaming'), false);
});
