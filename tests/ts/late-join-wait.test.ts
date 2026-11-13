import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startLateJoinWait } from '../../web/src/late-join-wait.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitWith = (over: { retryEveryMs?: number; timeoutMs?: number } = {}) => {
  let requests = 0;
  const wait = startLateJoinWait({
    request: () => {
      requests += 1;
    },
    retryEveryMs: over.retryEveryMs ?? 20,
    timeoutMs: over.timeoutMs ?? 400,
  });
  return { wait, requests: () => requests };
};

test('the request is sent at once', async () => {
  const { wait, requests } = waitWith();
  await pause(5);
  assert.equal(requests(), 1);
  wait.cancel();
});

test('the host sends the state: the wait ends with it and stops asking', async () => {
  const { wait, requests } = waitWith();
  await pause(30);
  wait.stateArrived();
  assert.equal(await wait.outcome, 'state');
  const sent = requests();
  await pause(80);
  assert.equal(requests(), sent);
});

test('the host is not running yet: the joiner is admitted to the start (the deadlock case)', async () => {
  const { wait } = waitWith();
  wait.admitted();
  assert.equal(await wait.outcome, 'admitted');
});

test('the first request is lost: it is asked again until answered', async () => {
  const { wait, requests } = waitWith({ retryEveryMs: 15 });
  await pause(70);
  assert.ok(requests() >= 3, `asked ${requests()} times`);
  wait.stateArrived();
  assert.equal(await wait.outcome, 'state');
});

test('nobody ever answers: the wait ends at the deadline instead of hanging', async () => {
  const { wait, requests } = waitWith({ retryEveryMs: 20, timeoutMs: 90 });
  const started = Date.now();
  assert.equal(await wait.outcome, 'timeout');
  assert.ok(Date.now() - started < 400);
  const sent = requests();
  await pause(80);
  assert.equal(requests(), sent, 'still asking after the deadline');
});

test('only the first answer counts', async () => {
  const { wait } = waitWith();
  wait.admitted();
  wait.stateArrived();
  assert.equal(await wait.outcome, 'admitted');
});

test('cancelled (the game ended): it stops asking and reports nothing', async () => {
  const { wait, requests } = waitWith({ retryEveryMs: 15, timeoutMs: 60 });
  let settled = false;
  void wait.outcome.then(() => {
    settled = true;
  });
  await pause(20);
  wait.cancel();
  const sent = requests();
  await pause(120);
  assert.equal(requests(), sent);
  assert.equal(settled, false);
});
