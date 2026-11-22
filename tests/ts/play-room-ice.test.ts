import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canRetryRoomIce, createRoomIceCache } from '../../web/src/play/room-ice.ts';

const STUN = [{ urls: 'stun:stun.example.test' }];
const RELAY = [{ urls: 'turn:relay.example.test', username: 'fixture', credential: 'fixture' }];
const NEXT = [{ urls: 'turns:next.example.test', username: 'fixture', credential: 'fixture' }];
const ignore = () => {};
const reply = (servers: RTCIceServer[], relayTtlSeconds = 0) => ({ servers, relayTtlSeconds });
const deferredIce = () => {
  let resolve: (result: ReturnType<typeof reply>) => void = ignore;
  const promise = new Promise<ReturnType<typeof reply>>((done) => {
    resolve = done;
  });
  return { promise, resolve: (servers: RTCIceServer[]) => resolve(reply(servers)) };
};

test('only a same-room unexpired relay survives failed and STUN-only refreshes', async () => {
  let now = 1_700_000_000_000;
  const cache = createRoomIceCache(() => now);
  await cache.refresh('room', Promise.resolve(reply(STUN)), ignore);
  assert.deepEqual(await cache.ready('room'), []);
  await cache.refresh('room', Promise.resolve(reply(RELAY)), ignore);
  const refresh = cache.refresh('room', Promise.reject(new Error('offline')), ignore);
  assert.deepEqual(await cache.ready('room'), RELAY);
  await refresh;
  await cache.refresh('room', Promise.resolve(reply(STUN)), ignore);
  assert.deepEqual(await cache.ready('room'), RELAY);
  assert.deepEqual(await cache.ready('another'), []);
  now += 30 * 60 * 1000;
  assert.deepEqual(await cache.ready('room'), []);
});

test('timestamped credentials are not reused beyond their known expiry', async () => {
  let now = 1_700_000_000_000;
  const relay = [{ urls: 'turn:relay.example.test', username: '1700000020:room', credential: 'fixture' }];
  const cache = createRoomIceCache(() => now);
  await cache.refresh('room', Promise.resolve(reply(relay)), ignore);
  assert.deepEqual(await cache.ready('room'), relay);
  now += 20_001;
  await cache.refresh('room', Promise.resolve(reply(STUN)), ignore);
  assert.deepEqual(await cache.ready('room'), []);
});

test('a slower authorized response cannot replace a newer relay or escape a closed room', async () => {
  const cache = createRoomIceCache();
  const published: RTCIceServer[][] = [];
  const publish = (servers: RTCIceServer[]) => published.push(servers);
  const old = deferredIce();
  const older = cache.refresh('room', old.promise, publish);
  const waiting = cache.ready('room');
  await cache.refresh('room', Promise.resolve(reply(NEXT)), publish);
  old.resolve(RELAY);
  await older;
  assert.deepEqual(await waiting, NEXT);
  assert.deepEqual(published, [NEXT]);

  const stale = deferredIce();
  const oldRoom = cache.refresh('room', stale.promise, publish);
  cache.clear();
  await cache.refresh('another', Promise.resolve(reply(STUN)), publish);
  stale.resolve(RELAY);
  await oldRoom;
  assert.deepEqual(await cache.ready('room'), []);
  assert.deepEqual(await cache.ready('another'), []);
  assert.deepEqual(published, [NEXT, STUN]);
});

test('a first offer waits for the room-authorized refresh to begin', async () => {
  const cache = createRoomIceCache();
  const hostOffer = cache.ready('room');
  const guestOffer = cache.ready('room');
  await cache.refresh('room', Promise.resolve(reply(RELAY)), ignore);
  assert.deepEqual(await hostOffer, RELAY);
  assert.deepEqual(await guestOffer, RELAY);
  assert.equal(hostOffer, guestOffer);
});

test('an older in-flight authorized relay still works if a newer request fails', async () => {
  const cache = createRoomIceCache();
  const old = deferredIce();
  const older = cache.refresh('room', old.promise, ignore);
  const waiting = cache.ready('room');
  await cache.refresh('room', Promise.reject(new Error('offline')), ignore);
  old.resolve(RELAY);
  await older;
  assert.deepEqual(await waiting, RELAY);
  assert.deepEqual(await cache.ready('room'), RELAY);
});

test('a reconnect expects a new refresh even after a previous terminal STUN-only response', async () => {
  const cache = createRoomIceCache();
  await cache.refresh('room', Promise.resolve(reply(STUN)), ignore);
  assert.deepEqual(await cache.ready('room'), []);
  cache.begin('room');
  const waiting = cache.ready('room');
  await cache.refresh('room', Promise.resolve(reply(RELAY)), ignore);
  assert.deepEqual(await waiting, RELAY);
});

test('a readiness window is shared, bounded, and invalidated by a room reset', async () => {
  const cache = createRoomIceCache(Date.now, 5);
  const timedOut = cache.ready('room');
  assert.equal(cache.ready('room'), timedOut);
  assert.deepEqual(await timedOut, []);
  const pending = deferredIce();
  const refresh = cache.refresh('room', pending.promise, ignore);
  const waiting = cache.ready('room');
  cache.clear();
  assert.deepEqual(await waiting, []);
  await cache.refresh('another', Promise.resolve(reply(STUN)), ignore);
  pending.resolve(RELAY);
  await refresh;
  assert.deepEqual(await cache.ready('another'), []);
});

test('authorized relay survives 30 minutes and expires at the relative deadline without refetching', async () => {
  let now = 1_700_000_000_000;
  const startedAt = now;
  const requests: string[] = [];
  const cache = createRoomIceCache(() => now);
  const relay = deferredIce();
  const response = relay.promise.then(({ servers }) => {
    requests.push('authorized');
    return reply(servers, 12 * 60 * 60);
  });
  const refresh = cache.refresh('room', response, ignore);
  now += 5_000;
  relay.resolve(RELAY);
  await refresh;
  now = startedAt + 31 * 60 * 1000;
  assert.deepEqual(await cache.ready('room'), RELAY);
  await cache.refresh('room', Promise.reject(new Error('offline')), ignore);
  const deadline = startedAt + 12 * 60 * 60 * 1000 - 10_000;
  now = deadline - 1;
  assert.deepEqual(await cache.ready('room'), RELAY);
  now = deadline;
  assert.deepEqual(await cache.ready('room'), []);
  assert.deepEqual(await cache.ready('room'), []);
  assert.deepEqual(requests, ['authorized']);
});

test('only an appropriately scoped unexpired upload token schedules a retry', () => {
  const now = 1_700_000_000_000;
  const token = (k: string, room: string, exp: number) =>
    btoa(JSON.stringify({ k, room, exp })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_') +
    '.' +
    'a'.repeat(64);
  assert.equal(canRetryRoomIce('room', token('upload', 'room', now / 1000 + 300), now), true);
  assert.equal(canRetryRoomIce('room', token('reconnect', 'room', now / 1000 + 300), now), false);
  assert.equal(canRetryRoomIce('room', token('upload', 'other', now / 1000 + 300), now), false);
  assert.equal(canRetryRoomIce('room', token('upload', 'room', now / 1000 + 18), now), false);
  assert.equal(canRetryRoomIce('room', token('upload', 'room', now / 1000 - 1), now), false);
  assert.equal(canRetryRoomIce('room', 'malformed', now), false);
});

test('a later offer retries an abort, concurrent offers share it, and failures back off', async () => {
  let now = 1_700_000_000_000;
  const cache = createRoomIceCache(() => now);
  const first = deferredIce();
  const recovery = deferredIce();
  const calls: number[] = [];
  const retry = {
    load: () => {
      calls.push(now);
      return calls.length === 1 ? Promise.reject(new DOMException('aborted', 'AbortError')) : recovery.promise;
    },
    publish: ignore,
  };

  const started = cache.refresh(
    'room',
    first.promise.then(() => {
      throw new DOMException('aborted', 'AbortError');
    }),
    ignore,
  );
  const initialOffer = cache.ready('room', retry);
  first.resolve([]);
  await started;
  assert.deepEqual(await initialOffer, []);
  assert.deepEqual(calls, []);

  const a = cache.ready('room', retry);
  assert.equal(cache.ready('room', retry), a);
  assert.deepEqual(await a, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(await cache.ready('room', retry), []);
  assert.equal(calls.length, 1);

  now += 15_000;
  const offeredAgain = cache.ready('room', retry);
  assert.equal(cache.ready('room', retry), offeredAgain);
  recovery.resolve(RELAY);
  assert.deepEqual(await offeredAgain, RELAY);
  assert.equal(calls.length, 2);
});

test('STUN-only and expired managed leases do not trigger lookups', async () => {
  let now = 1_700_000_000_000;
  const cache = createRoomIceCache(() => now);
  const retry = {
    load: () => {
      throw new Error('no retry expected');
    },
    publish: ignore,
  };
  await cache.refresh('room', Promise.resolve(reply(STUN)), ignore);
  assert.deepEqual(await cache.ready('room', retry), []);
  await cache.refresh('room', Promise.resolve(reply(RELAY, 20)), ignore);
  now += 20_000;
  assert.deepEqual(await cache.ready('room', retry), []);
});

test('a retried offer waits only for the bounded readiness window', async () => {
  const cache = createRoomIceCache(Date.now, 5);
  await cache.refresh('room', Promise.reject(new Error('offline')), ignore);
  const pending = deferredIce();
  let requests = 0;
  const retry = {
    load: () => {
      requests++;
      return pending.promise;
    },
    publish: ignore,
  };
  const a = cache.ready('room', retry);
  assert.equal(cache.ready('room', retry), a);
  assert.deepEqual(await a, []);
  assert.deepEqual(await cache.ready('room', retry), []);
  assert.equal(requests, 1);
  pending.resolve(RELAY);
});
