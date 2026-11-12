/**
 * The page lifecycle machine, replaying the scenarios of
 * specs/room_lifecycle.qnt from the page's side.
 *
 * Run: node --test tests/ts/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSession } from '../../web/src/index.ts';
import type { SessionReport } from '../../web/src/session.ts';

const open = (lateJoinReportAfterMs?: number) => {
  const reported: SessionReport[] = [];
  const session = createSession((report) => reported.push(report), lateJoinReportAfterMs);
  return { session, reported };
};

test('a new page is fresh and in the lobby', async () => {
  const { session } = open();
  assert.equal(await session.socketUp({ gameRunning: false }), true);
  assert.equal(session.state(), 'lobby');
  await session.stop();
});

test('game-started runs the match; game-ended returns to the lobby', async () => {
  const { session, reported } = open();
  session.send({ type: 'joined', status: 'lobby', matchId: null, spectator: false });
  session.send({ type: 'gameStarted', matchId: 'm1' });
  assert.equal(await session.socketUp({ gameRunning: true }), true);
  assert.equal(session.state(), 'running');
  session.send({ type: 'gameEnded' });
  assert.equal(await session.socketUp({ gameRunning: false }), true);
  assert.equal(session.state(), 'lobby');
  assert.deepEqual(reported, []);
  await session.stop();
});

test('joining a room in play waits for state, then runs (lateJoinTest)', async () => {
  const { session } = open();
  session.send({ type: 'joined', status: 'playing', matchId: 'm1', spectator: false });
  await session.socketUp({ gameRunning: false });
  assert.equal(session.state(), 'lateJoinWaiting');
  session.send({ type: 'lateJoinSynced' });
  await session.socketUp({ gameRunning: true });
  assert.equal(session.state(), 'running');
  await session.stop();
});

test('a spectator joining a room in play is in the game at once, and is never reported', async () => {
  const { session, reported } = open(30);
  session.send({ type: 'joined', status: 'playing', matchId: 'm1', spectator: true });
  // play.js sets gameRunning for any mid-game join, spectators included.
  assert.equal(await session.socketUp({ gameRunning: true }), true);
  assert.equal(session.state(), 'running');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(reported, []);
  await session.stop();
});

test('a dropped socket under a running game keeps the match (socketDropKeepsMatchTest)', async () => {
  const { session } = open();
  session.send({ type: 'gameStarted', matchId: 'm1' });
  session.send({ type: 'socketDown' });
  assert.equal(await session.socketUp({ gameRunning: true }), true);
  assert.equal(session.state(), 'running');
  await session.stop();
});

test('the page and the machine disagreeing is reported, not acted on', async () => {
  const { session, reported } = open();
  session.send({ type: 'gameStarted', matchId: 'm1' });
  assert.equal(await session.socketUp({ gameRunning: false }), false);
  assert.equal(session.state(), 'running');
  assert.deepEqual(reported, [{ type: 'session-disagree', machine: 'running', gameRunning: false }]);
  await session.stop();
});

test('a late joiner who never gets state is reported once, and left waiting', async () => {
  const { session, reported } = open(30);
  session.send({ type: 'joined', status: 'playing', matchId: 'm1', spectator: false });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(reported, [{ type: 'late-join-stranded', matchId: 'm1' }]);
  assert.equal(session.state(), 'lateJoinWaiting');
  await session.stop();
});

test('a late joiner who gets state in time is not reported', async () => {
  const { session, reported } = open(60);
  session.send({ type: 'joined', status: 'playing', matchId: 'm1', spectator: false });
  session.send({ type: 'lateJoinSynced' });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(reported, []);
  await session.stop();
});

test('the state is readable in the same tick as the event that changed it', async () => {
  // play.js sends an event and branches on the result straight away.
  const { session } = open();
  assert.equal(session.gameOn(), false);
  session.send({ type: 'joined', status: 'playing', matchId: 'm1', spectator: false });
  assert.equal(session.state(), 'lateJoinWaiting');
  assert.equal(session.gameOn(), true);
  session.send({ type: 'gameStarted', matchId: 'm1' });
  assert.equal(session.state(), 'running');
  session.send({ type: 'gameEnded' });
  assert.equal(session.gameOn(), false);
  await session.stop();
});

test('a room closed by the server puts the page back in the lobby', async () => {
  const { session, reported } = open(30);
  session.send({ type: 'joined', status: 'playing', matchId: 'm1', spectator: false });
  session.send({ type: 'roomClosed' });
  assert.equal(session.state(), 'lobby');
  assert.equal(await session.socketUp({ gameRunning: false }), true);
  // The stranded-joiner timer died with the wait.
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(reported, []);
  await session.stop();
});

test('the effects still run: a late joiner left waiting is reported once', async () => {
  const { session, reported } = open(30);
  session.send({ type: 'joined', status: 'playing', matchId: 'm1', spectator: false });
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(reported, [{ type: 'late-join-stranded', matchId: 'm1' }]);
  await session.stop();
});
