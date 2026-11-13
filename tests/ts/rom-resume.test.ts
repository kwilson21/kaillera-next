import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRomResumeAnswerer, romResumeOffset } from '../../web/src/rom-resume.ts';

const answerer = () => {
  const sent: number[] = [];
  return { sent, answer: createRomResumeAnswerer((offset) => sent.push(offset)) };
};
const resume = (offset: number) => JSON.stringify({ type: 'rom-resume', offset });

test('a request on an open channel is answered at once', () => {
  const { sent, answer } = answerer();
  answer.channelOpened();
  answer.received(resume(0), true);
  assert.deepEqual(sent, [0]);
});

test('a request that arrives before the channel opens is answered when it opens, once', () => {
  const { sent, answer } = answerer();
  answer.received(resume(4096), false);
  assert.deepEqual(sent, []);
  answer.channelOpened();
  answer.channelOpened();
  assert.deepEqual(sent, [4096]);
});

test('of two early requests the later offset is the one answered', () => {
  const { sent, answer } = answerer();
  answer.received(resume(0), false);
  answer.received(resume(8192), false);
  answer.channelOpened();
  assert.deepEqual(sent, [8192]);
});

test('anything that is not a rom-resume with a whole, non-negative offset is ignored', () => {
  for (const data of [
    new ArrayBuffer(4),
    'not json',
    'null',
    JSON.stringify({ type: 'rom-header', offset: 0 }),
    JSON.stringify({ type: 'rom-resume' }),
    JSON.stringify({ type: 'rom-resume', offset: -1 }),
    JSON.stringify({ type: 'rom-resume', offset: 1.5 }),
    JSON.stringify({ type: 'rom-resume', offset: '0' }),
  ]) {
    assert.equal(romResumeOffset(data), null);
  }
  assert.equal(romResumeOffset(resume(0)), 0);
});
