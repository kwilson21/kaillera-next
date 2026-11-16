import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startRejoin } from '../../web/src/rejoin-attempt.ts';
import { rejoinAnswer } from '../../web/src/rejoin.ts';

type Room = { status: string };
type Reply = { error: string | null; room?: Room } | 'silence';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A server that gives the listed replies in turn, then stays silent. */
const rejoinAgainst = (replies: Reply[], attempts = 3) => {
  let sent = 0;
  const handle = startRejoin<Room>({
    send: (answer) => {
      const reply = replies[sent] ?? 'silence';
      sent += 1;
      if (reply !== 'silence') answer(reply.error, reply.room);
    },
    answerWithinMs: 40,
    retryAfterMs: 10,
    attempts,
  });
  return { handle, sent: () => sent };
};

test('the server takes the page back: resumed, with what the room is doing', async () => {
  const { handle, sent } = rejoinAgainst([{ error: null, room: { status: 'playing' } }]);
  assert.deepEqual(await handle.outcome, { kind: 'resumed', room: { status: 'playing' } });
  assert.equal(sent(), 1);
});

test('the room dropped the page while its socket was down: dropped, and it stops asking', async () => {
  const { handle, sent } = rejoinAgainst([{ error: 'Not in room' }]);
  assert.deepEqual(await handle.outcome, { kind: 'dropped', reason: 'Not in room' });
  await pause(80);
  assert.equal(sent(), 1);
});

test('the first answer never comes: it asks again and is taken back', async () => {
  const { handle, sent } = rejoinAgainst(['silence', { error: null, room: { status: 'lobby' } }]);
  assert.deepEqual(await handle.outcome, { kind: 'resumed', room: { status: 'lobby' } });
  assert.equal(sent(), 2);
});

test('rate limited: it asks again after the pause', async () => {
  const { handle, sent } = rejoinAgainst([{ error: 'Rate limited' }, { error: null }]);
  assert.deepEqual(await handle.outcome, { kind: 'resumed', room: undefined });
  assert.equal(sent(), 2);
});

test('nobody ever answers: it ends with noAnswer after the last attempt instead of hanging', async () => {
  const { handle, sent } = rejoinAgainst([], 3);
  assert.deepEqual(await handle.outcome, { kind: 'noAnswer' });
  assert.equal(sent(), 3);
  await pause(80);
  assert.equal(sent(), 3);
});

test('an answer that arrives after its attempt timed out is not counted twice', async () => {
  let late: ((error: string | null) => void) | undefined;
  let sent = 0;
  const handle = startRejoin<Room>({
    send: (answer) => {
      sent += 1;
      if (sent === 1) late = answer;
      else answer(null, { status: 'playing' });
    },
    answerWithinMs: 20,
    retryAfterMs: 10,
    attempts: 3,
  });
  assert.deepEqual(await handle.outcome, { kind: 'resumed', room: { status: 'playing' } });
  late?.('Not in room');
  await pause(30);
  assert.equal(sent, 2);
});

test('cancelled (the socket dropped again): it stops asking and reports nothing', async () => {
  const { handle, sent } = rejoinAgainst([], 5);
  let settled = false;
  void handle.outcome.then(() => {
    settled = true;
  });
  await pause(15);
  handle.cancel();
  const asked = sent();
  await pause(150);
  assert.equal(sent(), asked);
  assert.equal(settled, false);
});

test('what one answer means', () => {
  assert.equal(rejoinAnswer(''), 'resumed');
  assert.equal(rejoinAnswer('Rate limited'), 'retry');
  for (const error of ['Not in room', 'Room not found', 'Room closed', 'Invalid reconnect token', 'Room is full'])
    assert.equal(rejoinAnswer(error), 'dropped');
});
