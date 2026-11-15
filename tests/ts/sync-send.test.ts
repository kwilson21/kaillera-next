import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mayHandChunk, sendPaced, transferStillFor } from '../../web/src/sync-send.ts';

const CHUNK = 100;

// A channel whose link takes `perTick` bytes every `tickMs`.
const fakeChannel = (perTick: number, tickMs = 5) => {
  let buffered = 0;
  let open = true;
  const order: string[] = [];
  const timer = setInterval(() => {
    buffered = Math.max(0, buffered - perTick);
  }, tickMs);
  return {
    order,
    peak: 0,
    send(label: string, bytes: number) {
      buffered += bytes;
      this.peak = Math.max(this.peak, buffered);
      order.push(label);
    },
    buffered: () => buffered,
    open: () => open,
    close: () => {
      open = false;
    },
    stop: () => clearInterval(timer),
  };
};

test('the next chunk may go only while less than a chunk is waiting', () => {
  assert.equal(mayHandChunk(0, CHUNK), true);
  assert.equal(mayHandChunk(CHUNK - 1, CHUNK), true);
  assert.equal(mayHandChunk(CHUNK, CHUNK), false);
  assert.equal(mayHandChunk(5 * CHUNK, CHUNK), false);
});

test('a transfer hands over a chunk only while less than one is waiting', async () => {
  const ch = fakeChannel(CHUNK);
  const outcome = await sendPaced({
    count: 10,
    send: (i) => ch.send(`chunk${i}`, CHUNK),
    buffered: ch.buffered,
    open: ch.open,
    lowWaterBytes: CHUNK,
    pollMs: 1,
    stallMs: 2000,
  });
  ch.stop();
  assert.equal(outcome, 'sent');
  assert.equal(ch.order.length, 10);
  assert.deepEqual(
    ch.order,
    Array.from({ length: 10 }, (_, i) => `chunk${i}`),
  );
  // At most one chunk was waiting when the next was handed over.
  assert.ok(ch.peak < 2 * CHUNK, `peak ${ch.peak}`);
});

test('an input sent during a transfer is not queued behind the whole state', async () => {
  const ch = fakeChannel(CHUNK, 10);
  const transfer = sendPaced({
    count: 20,
    send: (i) => ch.send(`chunk${i}`, CHUNK),
    buffered: ch.buffered,
    open: ch.open,
    lowWaterBytes: CHUNK,
    pollMs: 1,
    stallMs: 2000,
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  ch.send('input', 1);
  await transfer;
  ch.stop();
  // Chunks handed over before the input: only those the link has taken, not 20.
  assert.ok(ch.order.indexOf('input') < 10, ch.order.join(','));
});

test('a link that takes nothing ends the transfer at the deadline', async () => {
  const ch = fakeChannel(0);
  const started = Date.now();
  const outcome = await sendPaced({
    count: 5,
    send: (i) => ch.send(`chunk${i}`, CHUNK),
    buffered: ch.buffered,
    open: ch.open,
    lowWaterBytes: CHUNK,
    pollMs: 2,
    stallMs: 60,
  });
  ch.stop();
  assert.equal(outcome, 'stalled');
  assert.equal(ch.order.length, 1);
  assert.ok(Date.now() - started < 1000);
});

test('a channel that closes ends the transfer', async () => {
  const ch = fakeChannel(0);
  setTimeout(() => ch.close(), 20);
  const outcome = await sendPaced({
    count: 5,
    send: (i) => ch.send(`chunk${i}`, CHUNK),
    buffered: ch.buffered,
    open: ch.open,
    lowWaterBytes: CHUNK,
    pollMs: 2,
    stallMs: 5000,
  });
  ch.stop();
  assert.equal(outcome, 'closed');
});

test('a queued transfer goes only to the connection it was taken for', () => {
  assert.equal(transferStillFor(3, 1, 3, 1), true);
  // The guest reconnected (resetPeerState bumped its generation).
  assert.equal(transferStillFor(3, 1, 3, 2), false);
  // The match ended (stop bumped the epoch).
  assert.equal(transferStillFor(3, 1, 4, 1), false);
});

test('two guests paced side by side: a congested one does not hold the other', async () => {
  // The engine gives each guest a chain of its own (sendSyncChunks); here,
  // two transfers run at once, one on a link that takes nothing.
  const stuck = fakeChannel(0);
  const healthy = fakeChannel(CHUNK);
  const started = Date.now();
  const [a, b] = await Promise.all([
    sendPaced({
      count: 3,
      send: (i) => stuck.send(`chunk${i}`, CHUNK),
      buffered: stuck.buffered,
      open: stuck.open,
      lowWaterBytes: CHUNK,
      pollMs: 1,
      stallMs: 300,
    }),
    sendPaced({
      count: 5,
      send: (i) => healthy.send(`chunk${i}`, CHUNK),
      buffered: healthy.buffered,
      open: healthy.open,
      lowWaterBytes: CHUNK,
      pollMs: 1,
      stallMs: 300,
    }).then((outcome) => ({ outcome, ms: Date.now() - started })),
  ]);
  stuck.stop();
  healthy.stop();
  assert.equal(a, 'stalled');
  assert.equal(b.outcome, 'sent');
  assert.ok(b.ms < 300, `the healthy transfer finished in ${b.ms} ms, before the other's deadline`);
});
