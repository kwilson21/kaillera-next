import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meshHealTargets, type RosterEntry } from '../../web/src/roster.ts';

const entry = (sid: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  sid,
  healthy: false,
  reconnecting: false,
  ...over,
});

test('own ids are never targets, whatever the socket currently calls itself', () => {
  // The production case: the roster still lists us under the id we had before
  // the signaling socket dropped.
  assert.deepEqual(meshHealTargets([entry('old-own-sid')], ['old-own-sid']), []);
  assert.deepEqual(meshHealTargets([entry('a'), entry('me'), entry('b')], ['me', 'me-2']), ['a', 'b']);
});

test('healthy and already-reconnecting peers are left alone', () => {
  const roster = [entry('a', { healthy: true }), entry('b', { reconnecting: true }), entry('c')];
  assert.deepEqual(meshHealTargets(roster, []), ['c']);
});
