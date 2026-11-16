import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSession } from '../../web/src/index.ts';
import { reconcileRejoin } from '../../web/src/rejoin.ts';

test('a page in the lobby has nothing to reconcile', () => {
  assert.equal(reconcileRejoin(false, '', true, 'm2'), 'keep');
  assert.equal(reconcileRejoin(false, '', false, ''), 'keep');
});

test('a page in a game the room has left learns the game ended', () => {
  assert.equal(reconcileRejoin(true, 'm1', false, ''), 'gameEnded');
});

test('a page in the match the room is still playing carries on', () => {
  assert.equal(reconcileRejoin(true, 'm1', true, 'm1'), 'keep');
});

test('a page in a match the room has replaced learns that', () => {
  assert.equal(reconcileRejoin(true, 'm1', true, 'm2'), 'matchReplaced');
});

test('an unknown match id on either side is not taken for a replacement', () => {
  assert.equal(reconcileRejoin(true, '', true, 'm2'), 'keep');
  assert.equal(reconcileRejoin(true, 'm1', true, ''), 'keep');
});

const open = () => createSession(() => {});
const joinMidGame = { type: 'joined', status: 'playing', matchId: 'm1', spectator: false, streaming: false } as const;

test('the socket drops under a running game the host then ends: the page returns to the lobby', async () => {
  const session = open();
  session.send({ type: 'gameStarted', matchId: 'm1' });
  session.send({ type: 'socketDown' });
  // game-ended was broadcast while the socket was down; the page never heard it.
  assert.equal(session.rejoined({ playing: false, matchId: null }), 'gameEnded');
  assert.equal(session.state(), 'lobby');
  await session.stop();
});

test('the socket drops and comes back under the same match: nothing changes (socketDropKeepsMatchTest)', async () => {
  const session = open();
  session.send({ type: 'gameStarted', matchId: 'm1' });
  session.send({ type: 'socketDown' });
  assert.equal(session.rejoined({ playing: true, matchId: 'm1' }), 'keep');
  assert.equal(session.state(), 'running');
  await session.stop();
});

test('a joiner at the ROM prompt whose match was replaced starts over (the model counterexample)', async () => {
  const session = open();
  session.send(joinMidGame);
  session.send({ type: 'lateJoinRomNeeded' });
  session.send({ type: 'socketDown' });
  assert.equal(session.rejoined({ playing: true, matchId: 'm2' }), 'matchReplaced');
  assert.equal(session.state(), 'lobby');
  // play.js then joins as a fresh page would.
  session.send({ ...joinMidGame, matchId: 'm2' });
  assert.equal(session.state(), 'lateJoinStarting');
  await session.stop();
});

test('every late-join state reconciles, not only running', async () => {
  for (const events of [
    [],
    [{ type: 'lateJoinRomNeeded' }],
    [{ type: 'engineStarted', connectOnly: false, waitsForState: true }],
  ] as const) {
    const session = open();
    session.send(joinMidGame);
    for (const event of events) session.send(event);
    assert.equal(session.rejoined({ playing: false, matchId: null }), 'gameEnded');
    assert.equal(session.state(), 'lobby');
    await session.stop();
  }
});

test('a rejoin in the lobby leaves the page in the lobby whatever the room is doing', async () => {
  const session = open();
  assert.equal(session.rejoined({ playing: true, matchId: 'm9' }), 'keep');
  assert.equal(session.state(), 'lobby');
  await session.stop();
});
