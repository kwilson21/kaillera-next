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
  directFollowUpDue,
  directWatchIsStale,
  followUpIsUnneeded,
} from '../../web/src/sync-follow-up.ts';

test('an input at or before the watched frame changes it when the misprediction count moved', () => {
  assert.equal(changesWatchedFrame(100, 100, 5, 6), true);
  assert.equal(changesWatchedFrame(90, 100, 5, 6), true);
  assert.equal(changesWatchedFrame(100, 100, 5, 5), false, 'fed as predicted');
  assert.equal(changesWatchedFrame(101, 100, 5, 6), false, 'after the frame sent: not its business');
});

test('a count that cannot be read counts as a change, so a follow-up is never lost to it', () => {
  assert.equal(changesWatchedFrame(100, 100, -1, 6), true);
  assert.equal(changesWatchedFrame(100, 100, 5, -1), true);
  assert.equal(changesWatchedFrame(100, 100, -1, -1), true);
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
