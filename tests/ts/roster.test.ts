import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meshHealTargets, rosterPeers, type RosterEntry, type RosterPlayer } from '../../web/src/roster.ts';

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

// The engine's rule before rosterPeers: every entry whose socket id is not
// socket.id (undefined while the signaling socket is down).
const oldPeers = (roster: RosterPlayer[], socketId: string | undefined): number[] =>
  roster.flatMap((p, i) => (p.sid !== socketId ? [i] : []));

const players = (): RosterPlayer[] => [
  { sid: 'host-sid', slot: 0, player: 'host-pid' },
  { sid: 'me-old-sid', slot: 1, player: 'me-pid' },
  { sid: 'p3-sid', slot: 2, player: 'p3-pid' },
];

test('old against new: with the socket up and the roster current, the same peers', () => {
  const roster = [
    { sid: 'host-sid', slot: 0, player: 'host-pid' },
    { sid: 'me-sid', slot: 1, player: 'me-pid' },
    { sid: 'p3-sid', slot: 2, player: 'p3-pid' },
  ];
  assert.deepEqual(rosterPeers(roster, ['me-sid'], 1, 'me-pid'), oldPeers(roster, 'me-sid'));
  assert.deepEqual(rosterPeers(roster, ['me-sid'], 1, 'me-pid'), [0, 2]);
  // A spectator (no slot) or a page with no player id yet: still the same.
  assert.deepEqual(rosterPeers(roster, ['me-sid'], -1, ''), oldPeers(roster, 'me-sid'));
});

test('old against new: with the socket down, only the page itself is dropped (late-join-drop-during-serve)', () => {
  const roster = players();
  // The engine restarted while its socket was down: socket.id undefined.
  assert.deepEqual(oldPeers(roster, undefined), [0, 1, 2], 'the old rule took its own entry for a peer');
  // Found by any one of the three: a socket id it has had, its slot, its player id.
  assert.deepEqual(rosterPeers(roster, ['me-old-sid'], -1, ''), [0, 2]);
  assert.deepEqual(rosterPeers(roster, [], 1, ''), [0, 2]);
  assert.deepEqual(rosterPeers(roster, [], -1, 'me-pid'), [0, 2]);
  // Every other entry is a peer under both rules.
  const kept = rosterPeers(roster, [], 1, 'me-pid');
  assert.deepEqual(
    oldPeers(roster, undefined).filter((i) => !kept.includes(i)),
    [1],
  );
});

test('a roster that has moved on to the new socket id: the old one is not a peer either', () => {
  const roster = [
    { sid: 'host-sid', slot: 0, player: 'host-pid' },
    { sid: 'me-new-sid', slot: 1, player: 'me-pid' },
  ];
  assert.deepEqual(rosterPeers(roster, ['me-old-sid', 'me-new-sid'], 1, 'me-pid'), [0]);
});
