import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveConnectionOf, rosterKey, type Connection, type KnownPlayer } from '../../web/src/peer-identity.ts';

const conn = (key: string, over: Partial<Connection> = {}): Connection => ({
  key,
  slot: 1,
  persistentId: 'guest',
  live: true,
  ...over,
});
const guestAs = (socketId: string) => ({ persistentId: 'guest', socketId, slot: 1 });

test('a player listed under the id their connection was made with keeps it', () => {
  assert.equal(rosterKey(guestAs('s1'), false, [conn('s1')], []), 's1');
});

test('this page is never mapped to a connection', () => {
  assert.equal(rosterKey(guestAs('me'), true, [conn('old')], []), 'me');
});

test('a player who reconnected to the server under a new id keeps the live connection', () => {
  const known: KnownPlayer[] = [{ key: 's1', persistentId: 'guest', socketId: 's1' }];
  assert.equal(rosterKey(guestAs('s2'), false, [conn('s1')], known), 's1');
});

test('the #119 ordering: missing from the last roster, then back under a new id', () => {
  // The host rejoined first: the previous roster had only the host, so
  // nothing is known about the guest. The connection still says whose it is.
  assert.equal(rosterKey(guestAs('s2'), false, [conn('s1')], []), 's1');
});

test('a connection recreated without a roster update is kept too, once it carries the player', () => {
  // Mesh heal or a late-join reconnect made this connection; no roster named it.
  assert.equal(rosterKey(guestAs('s3'), false, [conn('healed')], []), 'healed');
});

test('a dead connection is not kept: the player gets a new one', () => {
  assert.equal(rosterKey(guestAs('s2'), false, [conn('s1', { live: false })], []), 's2');
});

test('a mapping the previous roster already made survives while the connection recovers', () => {
  const known: KnownPlayer[] = [{ key: 's1', persistentId: 'guest', socketId: 's2' }];
  assert.equal(rosterKey(guestAs('s2'), false, [conn('s1', { live: false })], known), 's1');
});

test("another player's connection, or the same player in another slot, is never taken", () => {
  assert.equal(rosterKey(guestAs('s2'), false, [conn('s1', { persistentId: 'someone-else' })], []), 's2');
  assert.equal(rosterKey(guestAs('s2'), false, [conn('s1', { slot: 2 })], []), 's2');
});

test('a connection that does not yet say whose it is is not guessed at', () => {
  assert.equal(rosterKey(guestAs('s2'), false, [conn('s1', { persistentId: '' })], []), 's2');
  assert.equal(
    rosterKey({ persistentId: '', socketId: 's2', slot: 1 }, false, [conn('s1', { persistentId: '' })], []),
    's2',
  );
});

test('liveConnectionOf returns -1 only when no live connection of that player and slot exists', () => {
  const table = [conn('a', { live: false }), conn('b', { slot: 2 }), conn('c')];
  assert.equal(liveConnectionOf(table, 'guest', 1, 'new'), 2);
  assert.equal(liveConnectionOf(table, 'guest', 1, 'c'), -1);
  assert.equal(liveConnectionOf([], 'guest', 1, 'new'), -1);
});
