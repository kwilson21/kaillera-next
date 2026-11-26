import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startAfter, startEvery, startPolling } from '../../web/src/poll.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the first look is made by the call itself, and what it finds ends the poll', async () => {
  const looks: number[] = [];
  const poll = startPolling(
    (attempt) => {
      looks.push(attempt);
      return 'there';
    },
    { everyMs: 60_000, attempts: 5 },
  );
  assert.deepEqual(looks, [0], 'no look was made before startPolling returned');
  assert.equal(await poll.result, 'there');
  assert.deepEqual(looks, [0]);
});

test('it looks again at intervals until something is found, numbering the looks', async () => {
  const looks: number[] = [];
  const poll = startPolling(
    (attempt) => {
      looks.push(attempt);
      return attempt === 3 ? attempt : undefined;
    },
    { everyMs: 10, attempts: 50 },
  );
  assert.equal(await poll.result, 3);
  assert.deepEqual(looks, [0, 1, 2, 3]);
  await pause(50);
  assert.deepEqual(looks, [0, 1, 2, 3], 'it kept looking after it had found something');
});

test('the looks run out: it ends with nothing after exactly that many looks', async () => {
  let looks = 0;
  const started = Date.now();
  const poll = startPolling(
    () => {
      looks += 1;
      return undefined;
    },
    { everyMs: 10, attempts: 4 },
  );
  assert.equal(await poll.result, undefined);
  assert.equal(looks, 4);
  // Three intervals between four looks; the end does not wait a fourth.
  assert.ok(Date.now() - started >= 25, `ended after ${Date.now() - started} ms`);
  await pause(50);
  assert.equal(looks, 4);
});

test('one look allowed: nothing found ends at once, with no timer', async () => {
  let looks = 0;
  const poll = startPolling(
    () => {
      looks += 1;
      return undefined;
    },
    { everyMs: 60_000, attempts: 1 },
  );
  assert.equal(await poll.result, undefined);
  assert.equal(looks, 1);
});

test('a cancelled poll makes no further look and reports nothing', async () => {
  let looks = 0;
  const poll = startPolling(
    () => {
      looks += 1;
      return undefined;
    },
    { everyMs: 15, attempts: 100 },
  );
  await pause(40);
  poll.cancel();
  const seen = looks;
  let settled = false;
  void poll.result.then(() => {
    settled = true;
  });
  await pause(80);
  assert.ok(seen >= 2, `looked ${seen} times before the cancel`);
  assert.equal(looks, seen, 'it looked again after the cancel');
  assert.equal(settled, false, 'a cancelled poll settled');
});

test('startEvery runs after each interval, not at once, until stopped', async () => {
  let runs = 0;
  const stop = startEvery(() => {
    runs += 1;
  }, 15);
  assert.equal(runs, 0, 'it ran before the first interval');
  await pause(70);
  stop();
  const seen = runs;
  assert.ok(seen >= 2 && seen <= 5, `ran ${seen} times in 70 ms at 15 ms`);
  await pause(60);
  assert.equal(runs, seen, 'it ran again after being stopped');
});

test('startAfter runs once and cancellation prevents an outstanding callback', async () => {
  let runs = 0;
  const cancelled = startAfter(() => {
    runs += 10;
  }, 15);
  cancelled();
  const done = new Promise<void>((resolve) => {
    startAfter(() => {
      runs++;
      resolve();
    }, 15);
  });
  assert.equal(runs, 0);
  await done;
  await pause(40);
  assert.equal(runs, 1);
});
