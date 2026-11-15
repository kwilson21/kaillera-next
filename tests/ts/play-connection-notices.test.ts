import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startConnectionNotices, type NoticeTimings } from '../../web/src/play/connection-notices.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// play.js's timings scaled down: banner 2 s, server down 15 s, give up 30 s,
// slow first connection 10 s.
const FAST: NoticeTimings = { bannerAfterMs: 20, serverDownAfterMs: 150, giveUpAfterMs: 300, slowFirstConnectMs: 100 };

const recording = () => {
  const seen: string[] = [];
  const notices = startConnectionNotices(
    {
      showReconnecting: () => seen.push('reconnecting'),
      showServerDown: () => seen.push('server-down'),
      hide: () => seen.push('hide'),
      giveUp: () => seen.push('give-up'),
      slowFirstConnect: () => seen.push('slow-first-connect'),
    },
    FAST,
  );
  return { seen, notices };
};

test('a first connection that comes up in time shows nothing', async () => {
  const { seen, notices } = recording();
  await pause(30);
  notices.up();
  await pause(150);
  assert.deepEqual(seen, ['hide']);
});

test('a first connection that is slow gets the toast, once', async () => {
  const { seen, notices } = recording();
  await pause(160);
  assert.deepEqual(seen, ['slow-first-connect']);
  notices.stop();
});

test('in a game: reconnecting after the banner delay, then server unreachable, until the socket is back', async () => {
  const { seen, notices } = recording();
  notices.up();
  seen.length = 0;
  notices.down('game');
  await pause(60);
  assert.deepEqual(seen, ['reconnecting']);
  await pause(160);
  assert.deepEqual(seen, ['reconnecting', 'server-down']);
  // A game never gives up: the match goes on peer to peer.
  await pause(200);
  assert.deepEqual(seen, ['reconnecting', 'server-down']);
  notices.up();
  assert.deepEqual(seen, ['reconnecting', 'server-down', 'hide']);
});

test('in the lobby: reconnecting, then the page gives up', async () => {
  const { seen, notices } = recording();
  notices.up();
  seen.length = 0;
  notices.down('lobby');
  await pause(350);
  assert.deepEqual(seen, ['reconnecting', 'give-up']);
  notices.stop();
});

test('a socket back before the banner delay shows nothing, and nothing fires later', async () => {
  const { seen, notices } = recording();
  notices.up();
  seen.length = 0;
  notices.down('lobby');
  await pause(5);
  notices.up();
  await pause(350);
  assert.deepEqual(seen, ['hide']);
});

test('repeated reports of one outage start each notice once', async () => {
  const { seen, notices } = recording();
  notices.up();
  seen.length = 0;
  // Socket.IO reports connect_error on every retry.
  for (let i = 0; i < 5; i++) {
    notices.down('lobby');
    await pause(10);
  }
  await pause(350);
  assert.deepEqual(seen, ['reconnecting', 'give-up']);
  notices.stop();
});

test('a new outage after a reconnect starts its notices again', async () => {
  const { seen, notices } = recording();
  notices.up();
  notices.down('game');
  await pause(60);
  notices.up();
  seen.length = 0;
  notices.down('game');
  await pause(60);
  assert.deepEqual(seen, ['reconnecting']);
  notices.stop();
});

test('a game that ends during an outage also gives up in the lobby', async () => {
  // play.js: a connect_error in the lobby sets the 30 s error even when the
  // outage began in a game.
  const { seen, notices } = recording();
  notices.up();
  seen.length = 0;
  notices.down('game');
  await pause(5);
  notices.down('lobby');
  await pause(350);
  assert.deepEqual(seen, ['reconnecting', 'server-down', 'give-up']);
  notices.stop();
});

test('stopping the page cancels everything', async () => {
  const { seen, notices } = recording();
  notices.down('lobby');
  notices.stop();
  await pause(350);
  assert.deepEqual(seen, []);
});
