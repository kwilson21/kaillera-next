import assert from 'node:assert/strict';
import { test } from 'node:test';
import { delayAtJoin, delayAtStart, guestStartStep, type StartStep } from '../../web/src/engine-start.ts';

test('only a restored input window overrides the negotiated startup delay', () => {
  for (const saved of [-1, 0, 1, 4, 12]) {
    for (const negotiated of [0, 1, 4, 12]) {
      const start = delayAtStart(saved, negotiated);
      assert.equal(start, saved < 0 ? negotiated : saved);
      assert.equal(start !== negotiated, saved >= 0 && saved !== negotiated);
    }
  }
});

const DEADLINE = 10_000;
const OWN_DELAY = 3; // what the guest worked out for itself
const HOST_DELAY = 2;

test("both heard, the frame is this page's: arm, whatever the time", () => {
  for (const waited of [0, 1, DEADLINE - 1, DEADLINE, 60_000]) {
    assert.equal(guestStartStep(HOST_DELAY, 0, 0, waited, DEADLINE), 'arm');
    assert.equal(guestStartStep(HOST_DELAY, 120, 120, waited, DEADLINE), 'arm');
    assert.equal(guestStartStep(0, 7, 7, waited, DEADLINE), 'arm'); // a delay of 0 is a delay
  }
});

test('nothing yet: wait until the deadline, then stop', () => {
  assert.equal(guestStartStep(-1, -1, 0, 0, DEADLINE), 'wait');
  assert.equal(guestStartStep(-1, -1, 0, DEADLINE - 1, DEADLINE), 'wait');
  assert.equal(guestStartStep(-1, -1, 0, DEADLINE, DEADLINE), 'stopNoHost');
  assert.equal(guestStartStep(-1, 0, 0, DEADLINE, DEADLINE), 'stopNoHost'); // the frame without the delay
});

test('the delay without the start frame: wait, then arm at its own frame', () => {
  assert.equal(guestStartStep(HOST_DELAY, -1, 0, DEADLINE - 1, DEADLINE), 'wait');
  assert.equal(guestStartStep(HOST_DELAY, -1, 0, DEADLINE, DEADLINE), 'arm');
});

test('a start frame other than its own stops it, at once', () => {
  for (const heardDelay of [-1, 0, HOST_DELAY]) {
    assert.equal(guestStartStep(heardDelay, 1, 0, 0, DEADLINE), 'stopFrame');
    assert.equal(guestStartStep(heardDelay, 4, 5, 0, DEADLINE), 'stopFrame');
  }
});

// ── Old against new ────────────────────────────────────────────────────────
//
// The decision netplay-rollback.js made before (the `rb-delay:` and
// `rb-init-frame:` handlers, _requestRollbackInit, and the RB-INIT-CATCHUP
// and RB-INIT-TIMEOUT branches of tick()), on the same inputs.

type OldOutcome =
  | { kind: 'arm'; delay: number; frame: number }
  | { kind: 'wait' }
  | { kind: 'catchUp' } // stepped to the host's frame on the old JS lockstep path
  | { kind: 'oldPath' }; // never armed: a delay of 0 ran on the old JS lockstep path

const oldGuestStart = (heardDelay: number, heardStart: number, ownFrame: number, waitedMs: number): OldOutcome => {
  // A delay of 0 never armed the C engine (`DELAY_FRAMES > 0`, `_rbHostDelay > 0`).
  if (heardDelay === 0) return { kind: 'oldPath' };
  if (heardDelay > 0 && heardStart >= 0) {
    if (heardStart > ownFrame) return { kind: 'catchUp' };
    // The overshoot: armed at its own frame when the host's was behind.
    return { kind: 'arm', delay: heardDelay, frame: Math.max(heardStart, ownFrame) };
  }
  // RB-INIT-TIMEOUT: strictly past the deadline, with the host's delay if
  // `rb-delay:` came (its handler set DELAY_FRAMES) and its own if not.
  if (waitedMs > DEADLINE) return { kind: 'arm', delay: heardDelay > 0 ? heardDelay : OWN_DELAY, frame: ownFrame };
  return { kind: 'wait' };
};

const sameAs = (step: StartStep, old: OldOutcome, heardDelay: number, ownFrame: number): boolean =>
  (step === 'wait' && old.kind === 'wait') ||
  (step === 'arm' && old.kind === 'arm' && old.delay === heardDelay && old.frame === ownFrame);

test('old against new: equal everywhere but the differences specs/engine_start.qnt names', () => {
  const differences = new Map<string, number>();
  const note = (name: string) => differences.set(name, (differences.get(name) ?? 0) + 1);
  for (const ownFrame of [0, 5]) {
    for (const heardDelay of [-1, 0, HOST_DELAY]) {
      for (const heardStart of [-1, ownFrame - 1, ownFrame, ownFrame + 1]) {
        if (heardStart < -1) continue;
        for (const waited of [0, DEADLINE - 1, DEADLINE, DEADLINE + 1]) {
          const step = guestStartStep(heardDelay, heardStart, ownFrame, waited, DEADLINE);
          const old = oldGuestStart(heardDelay, heardStart, ownFrame, waited);
          if (sameAs(step, old, heardDelay, ownFrame)) continue;
          const at = JSON.stringify({ heardDelay, heardStart, ownFrame, waited, step, old });
          if (heardStart >= 0 && heardStart !== ownFrame) {
            // theHostsStartIsWhereTheGuestIs: no page runs a frame before it
            // arms, and a waiting page's frame no longer moves when its tab
            // comes back (tabReturnWhileWaitingTest), so this does not
            // happen. Before, the guest waited for the delay, then stepped to
            // a later frame on the old path or armed at its own; now it stops
            // at once, whatever else it has.
            assert.equal(step, 'stopFrame', at);
            note('another start frame');
          } else if (heardDelay === 0) {
            // soloTest, lateJoinIntoSoloTest: a delay of 0 arms the C engine.
            assert.equal(old.kind, 'oldPath', at);
            assert.ok(step === 'arm' || step === 'wait', at);
            note('a delay of 0');
          } else if (heardDelay < 0 && waited >= DEADLINE && waited > DEADLINE) {
            // lostDelayTest: no delay from the host by the deadline. Before,
            // it armed with its own; now it stops and says so.
            assert.equal(step, 'stopNoHost', at);
            assert.deepEqual(old, { kind: 'arm', delay: OWN_DELAY, frame: ownFrame }, at);
            note('no delay by the deadline');
          } else if (waited === DEADLINE) {
            // The deadline itself: reached (>=) where the old branch wanted it passed (>).
            assert.equal(old.kind, 'wait', at);
            assert.ok(step === 'arm' || step === 'stopNoHost', at);
            note('at the deadline');
          } else {
            assert.fail(`an unnamed difference: ${at}`);
          }
        }
      }
    }
  }
  // Each named difference is reached, so none of them is vacuous.
  assert.deepEqual([...differences.keys()].sort(), [
    'a delay of 0',
    'another start frame',
    'at the deadline',
    'no delay by the deadline',
  ]);
});

// ── The delay once a player joins (specs/engine_start.qnt, REARM_AT_JOIN) ──

const DEFAULT = 2;

test('a match at 0 moves to the larger measured delay when its first player joins', () => {
  assert.equal(delayAtJoin(0, 3, 0, DEFAULT), 3);
  assert.equal(delayAtJoin(0, 0, 4, DEFAULT), 4);
  assert.equal(delayAtJoin(0, 3, 5, DEFAULT), 5);
  assert.equal(delayAtJoin(0, 6, 5, DEFAULT), 6);
  // Nothing measured yet: the default, never 0.
  assert.equal(delayAtJoin(0, 0, 0, DEFAULT), DEFAULT);
});

test('a match already above 0 keeps its delay for a later joiner', () => {
  const measured: [number, number][] = [
    [0, 0],
    [9, 9],
    [1, 12],
  ];
  for (const [own, offered] of measured) assert.equal(delayAtJoin(4, own, offered, DEFAULT), 4);
});

// Before, nothing changed the delay: the friend played at 0 for the rest of
// the match (engine_start_no_rearm, lateJoinIntoSoloTest). The one
// difference, asserted: a match at 0 never stays at 0 once a player joins.
test('old against new: only a match at 0 changes, and it leaves 0', () => {
  const old = (hostDelay: number) => hostDelay;
  for (const hostDelay of [0, 1, 4, 9]) {
    for (const own of [0, 2, 5]) {
      for (const offered of [0, 3, 7]) {
        const now = delayAtJoin(hostDelay, own, offered, DEFAULT);
        if (hostDelay > 0) assert.equal(now, old(hostDelay));
        else assert.ok(now > 0 && now >= own && now >= offered);
      }
    }
  }
});
