import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRoomIceCache } from '../../web/src/play/room-ice.ts';

const STUN = [{ urls: 'stun:stun.example.test' }];
const RELAY = [{ urls: 'turn:relay.example.test', username: 'fixture', credential: 'fixture' }];
const NEXT = [{ urls: 'turns:next.example.test', username: 'fixture', credential: 'fixture' }];
const ignore = () => {};
const deferredIce = () => {
  let resolve: (servers: RTCIceServer[]) => void = ignore;
  const promise = new Promise<RTCIceServer[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('only a same-room unexpired relay survives failed and STUN-only refreshes', async () => {
  let now = 1_700_000_000_000;
  const cache = createRoomIceCache(() => now);
  await cache.refresh('room', Promise.resolve(STUN), ignore);
  assert.deepEqual(await cache.ready('room'), []);
  await cache.refresh('room', Promise.resolve(RELAY), ignore);
  const refresh = cache.refresh('room', Promise.reject(new Error('offline')), ignore);
  assert.deepEqual(await cache.ready('room'), RELAY);
  await refresh;
  await cache.refresh('room', Promise.resolve(STUN), ignore);
  assert.deepEqual(await cache.ready('room'), RELAY);
  assert.deepEqual(await cache.ready('another'), []);
  now += 30 * 60 * 1000;
  assert.deepEqual(await cache.ready('room'), []);
});

test('timestamped credentials are not reused beyond their known expiry', async () => {
  let now = 1_700_000_000_000;
  const relay = [{ urls: 'turn:relay.example.test', username: '1700000020:room', credential: 'fixture' }];
  const cache = createRoomIceCache(() => now);
  await cache.refresh('room', Promise.resolve(relay), ignore);
  assert.deepEqual(await cache.ready('room'), relay);
  now += 20_001;
  await cache.refresh('room', Promise.resolve(STUN), ignore);
  assert.deepEqual(await cache.ready('room'), []);
});

test('a slower authorized response cannot replace a newer relay or escape a closed room', async () => {
  const cache = createRoomIceCache();
  const published: RTCIceServer[][] = [];
  const publish = (servers: RTCIceServer[]) => published.push(servers);
  const old = deferredIce();
  const older = cache.refresh('room', old.promise, publish);
  const waiting = cache.ready('room');
  await cache.refresh('room', Promise.resolve(NEXT), publish);
  old.resolve(RELAY);
  await older;
  assert.deepEqual(await waiting, NEXT);
  assert.deepEqual(published, [NEXT]);

  const stale = deferredIce();
  const oldRoom = cache.refresh('room', stale.promise, publish);
  cache.clear();
  await cache.refresh('another', Promise.resolve(STUN), publish);
  stale.resolve(RELAY);
  await oldRoom;
  assert.deepEqual(await cache.ready('room'), []);
  assert.deepEqual(await cache.ready('another'), []);
  assert.deepEqual(published, [NEXT, STUN]);
});
