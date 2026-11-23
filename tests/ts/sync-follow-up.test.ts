/**
 * The host's follow-up to an unconfirmed resync answer (web/src/sync-follow-up.ts,
 * specs/sync_follow_up.qnt).
 *
 * Run: node --test tests/ts/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changesWatchedFrame,
  delayOfStateAt,
  directFollowUpDue,
  directWatchIsStale,
  followUpIsUnneeded,
} from '../../web/src/sync-follow-up.ts';

test('an input that ran before the watched frame changes it when the misprediction count moved', () => {
  // Delay 2: the state at the start of 100 holds inputs labelled up to 97.
  assert.equal(changesWatchedFrame(97, 100, 2, 5, 6), true);
  assert.equal(changesWatchedFrame(90, 100, 2, 5, 6), true);
  assert.equal(changesWatchedFrame(97, 100, 2, 5, 5), false, 'fed as predicted');
  assert.equal(changesWatchedFrame(98, 100, 2, 5, 6), false, 'labelled F - delay: runs at F, after the state');
  assert.equal(changesWatchedFrame(100, 100, 2, 5, 6), false, 'labelled F: runs at F + delay');
  assert.equal(changesWatchedFrame(101, 100, 2, 5, 6), false, 'after the frame sent: not its business');
  // Delay 0 (a solo match before the re-arm): every input before F counts, F itself does not.
  assert.equal(changesWatchedFrame(99, 100, 0, 5, 6), true);
  assert.equal(changesWatchedFrame(100, 100, 0, 5, 6), false);
});

test('a count that cannot be read counts as a change, so a follow-up is never lost to it', () => {
  assert.equal(changesWatchedFrame(97, 100, 2, -1, 6), true);
  assert.equal(changesWatchedFrame(97, 100, 2, 5, -1), true);
  assert.equal(changesWatchedFrame(97, 100, 2, -1, -1), true);
});

// Old against new: the rule before the delay was threaded in flagged every
// input at or before the watched frame. The two must differ exactly in the
// band F - delay .. F (specs/sync_follow_up.qnt, differsAtFMinusDelayTest),
// where the new one flags nothing; everywhere else they agree.
const oldChangesWatchedFrame = (inputFrame: number, watchFrame: number, before: number, after: number): boolean =>
  inputFrame <= watchFrame && (before < 0 || after < 0 || after !== before);

test('old against new: the rules differ only for an input labelled F - delay .. F', () => {
  const watchFrame = 500;
  let band = 0;
  for (const delay of [0, 1, 2, 3, 5, 9, 12])
    for (let inputFrame = watchFrame - 30; inputFrame <= watchFrame + 5; inputFrame++)
      for (const [before, after] of [
        [5, 5],
        [5, 6],
        [-1, 6],
        [5, -1],
      ] as const) {
        const old = oldChangesWatchedFrame(inputFrame, watchFrame, before, after);
        const now = changesWatchedFrame(inputFrame, watchFrame, delay, before, after);
        const inBand = inputFrame >= watchFrame - delay && inputFrame <= watchFrame;
        if (inBand) {
          assert.equal(now, false, `delay=${delay} f=${inputFrame}: runs at F or later`);
          if (old) band++;
        } else {
          assert.equal(now, old, `delay=${delay} f=${inputFrame} before=${before} after=${after}`);
        }
        // The new rule never flags what the old did not: it only drops follow-ups.
        if (now) assert.ok(old);
      }
  assert.ok(band > 0, 'the old rule flagged the band');
});

test('the delay of a state: the delay since the last change, unless a frame before it ran a newer input', () => {
  // The delay never changed (-1): the delay in effect.
  assert.equal(delayOfStateAt(100, 3, -1), 3);
  // The re-arm at H = 50 from 0 to 3: frames before 50 ran inputs up to 49.
  // The state at 50 holds inputs up to 49, at 51 also up to 49 (51 - 1 - 3 = 47).
  assert.equal(delayOfStateAt(50, 3, 49), 0);
  assert.equal(delayOfStateAt(51, 3, 49), 1);
  assert.equal(delayOfStateAt(52, 3, 49), 2);
  assert.equal(delayOfStateAt(53, 3, 49), 3);
  assert.equal(delayOfStateAt(80, 3, 49), 3);
  // Lowered (3 to 1 at 50: frames before ran up to 46): the new delay.
  assert.equal(delayOfStateAt(51, 1, 46), 1);
  // A state from before the change: never below 0.
  assert.equal(delayOfStateAt(40, 3, 49), 0);
});

test('over a range, the delay of a state counts every input that state ran', () => {
  // Simulate frames running with a delay that changes; for each watched
  // frame, every label that ran before it must be counted by the rule.
  for (const [changeAt, prev, next] of [
    [50, 0, 3],
    [50, 1, 4],
    [50, 4, 1],
    [50, 2, 2],
  ] as const) {
    const ranBeforeChange = changeAt - 1 - prev;
    for (let watchFrame = changeAt; watchFrame < changeAt + 20; watchFrame++) {
      let newest = -1;
      for (let f = 0; f < watchFrame; f++) newest = Math.max(newest, f - (f < changeAt ? prev : next));
      const delay = delayOfStateAt(watchFrame, next, ranBeforeChange);
      const at = `change ${prev}->${next} at ${changeAt}, F=${watchFrame}`;
      // Never misses an input the state ran.
      assert.ok(watchFrame - 1 - delay >= newest, at);
      assert.equal(changesWatchedFrame(newest, watchFrame, delay, 5, 6), true, at);
      // Exact once a frame has run at the new delay (at the change itself,
      // with the delay lowered, it counts a few inputs more: a follow-up at most).
      if (watchFrame > changeAt) {
        assert.equal(watchFrame - 1 - delay, newest, at);
        assert.equal(changesWatchedFrame(newest + 1, watchFrame, delay, 5, 6), false, at);
      }
    }
  }
});

test('a follow-up is dropped only when watched, unchanged and confirmed', () => {
  assert.equal(followUpIsUnneeded(1, true, false, true), true);
  assert.equal(followUpIsUnneeded(1, true, true, true), false, 'changed: the guest needs the new state');
  assert.equal(followUpIsUnneeded(1, true, false, false), false, 'due at its deadline unconfirmed: cannot know yet');
  assert.equal(followUpIsUnneeded(1, false, false, true), false, 'no watch: sent as before');
  assert.equal(followUpIsUnneeded(0, true, false, true), false, 'the first answer is never dropped');
});

test('over every combination, dropping never keeps a changed or unconfirmed state', () => {
  for (const followUp of [0, 1, 2, 3])
    for (const watched of [true, false])
      for (const changed of [true, false])
        for (const confirmed of [true, false]) {
          const drop = followUpIsUnneeded(followUp, watched, changed, confirmed);
          if (drop) assert.ok(!changed && confirmed && watched && followUp > 0);
        }
});

test('a direct answer is followed up only when sent to its guest, not replaced, and not to a phantom', () => {
  assert.equal(directFollowUpDue(true, true, false, false), true);
  assert.equal(directFollowUpDue(false, true, false, false), false, 'reset or gone since: resetPeerState drops it');
  assert.equal(directFollowUpDue(true, false, false, false), false, 'not sent: the guest asks again');
  assert.equal(directFollowUpDue(true, true, true, false), false, 'a newer request replaces it');
  assert.equal(directFollowUpDue(true, true, false, true), false, "a phantom's recovery resyncs it");
});

test("an unsent direct answer's watch is dropped unless a newer request or a reset owns it now", () => {
  assert.equal(directWatchIsStale(true, false, false), true);
  assert.equal(directWatchIsStale(true, true, false), false, 'sent: the watch follows it');
  assert.equal(directWatchIsStale(true, false, true), false, "a newer request's watch");
  assert.equal(directWatchIsStale(false, false, false), false, "reset since: resetPeerState's");
});

test('a direct answer never both keeps a follow-up and drops its watch', () => {
  for (const current of [true, false])
    for (const sent of [true, false])
      for (const replaced of [true, false])
        for (const phantom of [true, false])
          assert.ok(
            !(directFollowUpDue(current, sent, replaced, phantom) && directWatchIsStale(current, sent, replaced)),
          );
});
