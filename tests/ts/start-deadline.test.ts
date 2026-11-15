/**
 * A wait at the start with a deadline (web/src/start-deadline.ts): it ends
 * when what it waits for comes, calls back once at the deadline otherwise,
 * and never calls back once cancelled.
 *
 * Run: node --test tests/ts/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startDeadline } from '../../web/src/start-deadline.ts';

test('a wait that is done never calls back', async () => {
  let deadlines = 0;
  const wait = startDeadline({ deadlineMs: 50, onDeadline: () => deadlines++ });
  wait.done();
  assert.equal(await wait.outcome, 'done');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(deadlines, 0);
});

test('at the deadline the wait calls back once, and a late done changes nothing', async () => {
  let deadlines = 0;
  const wait = startDeadline({ deadlineMs: 20, onDeadline: () => deadlines++ });
  assert.equal(await wait.outcome, 'deadline');
  assert.equal(deadlines, 1);
  wait.done();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(deadlines, 1);
});

test('a cancelled wait never calls back', async () => {
  let deadlines = 0;
  const wait = startDeadline({ deadlineMs: 20, onDeadline: () => deadlines++ });
  wait.cancel();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(deadlines, 0);
});

test('a wait started again replaces the one before: only the new one can call back', async () => {
  const calls: string[] = [];
  const first = startDeadline({ deadlineMs: 20, onDeadline: () => calls.push('first') });
  first.cancel();
  const second = startDeadline({ deadlineMs: 30, onDeadline: () => calls.push('second') });
  assert.equal(await second.outcome, 'deadline');
  assert.deepEqual(calls, ['second']);
});
