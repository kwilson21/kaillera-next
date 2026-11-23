import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  recoveryStep,
  syncRequestAnswer,
  type RecoveryStep,
  type SyncRequestAnswer,
} from '../../web/src/recovery-resync.ts';

const BOOLS = [false, true];

// The engine's own rule before web/src/recovery-resync.ts, as it was inline in
// _processInputPacket's PEER-RECOVERED: a guest that heard the host again
// asked for a coordinated resync; the host that heard a guest again resynced
// that guest alone; nothing else did anything.
type OldStep = 'nothing' | 'ask-at' | 'resync-returning-guest';
const oldStep = (isHost: boolean, recoveredIsHost: boolean, syncEnabled: boolean): OldStep => {
  if (!isHost && recoveredIsHost && syncEnabled) return 'ask-at';
  if (isHost && !recoveredIsHost && syncEnabled) return 'resync-returning-guest';
  return 'nothing';
};

// The guests the host resyncs, of a match with guests 1..3, guest 2 heard again.
const GUESTS = [1, 2, 3];
const RETURNING = 2;
const targetsOld = (step: OldStep): number[] => (step === 'resync-returning-guest' ? [RETURNING] : []);
const targetsNew = (step: RecoveryStep): number[] => (step === 'resync-guests' ? GUESTS : []);

const cases = () =>
  BOOLS.flatMap((isHost) =>
    BOOLS.flatMap((recoveredIsHost) =>
      // The host never hears itself again.
      isHost && recoveredIsHost
        ? []
        : BOOLS.flatMap((syncEnabled) =>
            BOOLS.map((requestOut) => ({ isHost, recoveredIsHost, syncEnabled, requestOut })),
          ),
    ),
  );

test('old against new: the same where the old rule acted, and where resyncs are off', () => {
  for (const c of cases()) {
    const before = oldStep(c.isHost, c.recoveredIsHost, c.syncEnabled);
    const after = recoveryStep(c.isHost, c.recoveredIsHost, c.syncEnabled, c.requestOut);
    const label = JSON.stringify(c);
    if (!c.syncEnabled) {
      assert.equal(after, 'nothing', label);
      assert.equal(before, 'nothing', label);
    }
    // A guest that heard the host again: a coordinated request, as before,
    // whatever request it had out (the old code reset it and asked).
    if (!c.isHost && c.recoveredIsHost && c.syncEnabled) {
      assert.equal(before, 'ask-at', label);
      assert.equal(after, 'ask-at', label);
    }
  }
});

test('old against new: the host resyncs every guest, not only the one it heard again', () => {
  // specs/recovery_bystander.qnt, onlyTheHostDroppedItTest and
  // bystanderAppliesWhatTheHostSettledTest: a resync of the returning guest
  // alone leaves a bystander on frames the host ran on other inputs.
  for (const requestOut of BOOLS) {
    const before = oldStep(true, false, true);
    const after = recoveryStep(true, false, true, requestOut);
    assert.deepEqual(targetsOld(before), [RETURNING]);
    assert.deepEqual(targetsNew(after), GUESTS);
    assert.ok(targetsNew(after).includes(RETURNING), 'the returning guest is still resynced');
  }
});

test('old against new: a guest that hears another guest again asks the host, unless a request is out', () => {
  // specs/recovery_bystander.qnt, bystanderStillPhantomTest: with an input of
  // it lost behind this page's window, nothing else brings the page back.
  assert.equal(oldStep(false, false, true), 'nothing');
  assert.equal(recoveryStep(false, false, true, false), 'ask');
  assert.equal(recoveryStep(false, false, true, true), 'nothing');
});

test('only the host resyncs guests, only a guest asks', () => {
  for (const c of cases()) {
    const step = recoveryStep(c.isHost, c.recoveredIsHost, c.syncEnabled, c.requestOut);
    if (step === 'resync-guests') assert.ok(c.isHost);
    if (step === 'ask' || step === 'ask-at') assert.ok(!c.isHost);
  }
});

// The host's answer to a resync request before syncRequestAnswer, as it was
// inline in its channel handler: a coordinated request whose frame is ahead
// was scheduled for that guest, any other answered at once to that guest.
type OldAnswer = 'scheduled' | 'direct';
const oldAnswer = (targetAhead: boolean): OldAnswer => (targetAhead ? 'scheduled' : 'direct');
const answerTargetsOld = (): number[] => [RETURNING];
const answerTargetsNew = (answer: SyncRequestAnswer): number[] => (answer === 'resync-guests' ? GUESTS : [RETURNING]);

test('old against new: a request from a guest not reset for a reconnect is answered as before', () => {
  for (const targetAhead of BOOLS) {
    assert.equal(syncRequestAnswer(false, targetAhead), oldAnswer(targetAhead), JSON.stringify({ targetAhead }));
  }
});

test('old against new: the first request after a reconnect is answered to every guest', () => {
  // specs/recovery_bystander.qnt, reconnectBystanderTest: an answer to the
  // reconnected guest alone leaves a bystander on frames the host ran on
  // predictions of that guest, where the bystander ran its real inputs.
  for (const targetAhead of BOOLS) {
    const after = syncRequestAnswer(true, targetAhead);
    assert.equal(after, 'resync-guests');
    assert.deepEqual(answerTargetsOld(), [RETURNING]);
    assert.deepEqual(answerTargetsNew(after), GUESTS);
    assert.ok(answerTargetsNew(after).includes(RETURNING), 'the guest that asked is still answered');
  }
});
