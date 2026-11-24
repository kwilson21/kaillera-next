import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MatchReturn } from '../../web/src/play/match-return.ts';

test('a restored seat reports once and waits for release in the same match', async () => {
  const room = new MatchReturn('next', 'previous');
  const reports: number[] = [];
  const report = () => reports.push(1);
  const gate = room.ready(report);
  assert.equal(room.ready(report), gate);
  room.finish('previous', true);
  assert.equal(await Promise.race([gate, Promise.resolve('waiting')]), 'waiting');
  room.finish('next', false);
  room.finish('next', true);
  assert.equal(await gate, false);
  assert.equal(reports.length, 1);
});

test('an early matching release is retained until the engine is ready', async () => {
  const room = new MatchReturn('next', 'previous');
  room.finish('next', true);
  assert.equal(await room.ready(() => assert.fail('the server already released this match')), true);
});
