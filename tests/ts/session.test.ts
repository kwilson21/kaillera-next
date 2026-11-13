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

const joinMidGame = { type: 'joined', status: 'playing', matchId: 'm1', spectator: false, streaming: false } as const;
const engineUp = { type: 'engineStarted', connectOnly: false, waitsForState: true } as const;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a new page is fresh and in the lobby', async () => {
  const { session } = open();
  assert.equal(await session.socketUp({ gameRunning: false }), true);
  assert.equal(session.state(), 'lobby');
  await session.stop();
});

test('game-started runs the match; game-ended returns to the lobby', async () => {
  const { session, reported } = open();
  session.send({ type: 'joined', status: 'lobby', matchId: null, spectator: false, streaming: false });
  session.send({ type: 'gameStarted', matchId: 'm1' });
  assert.equal(await session.socketUp({ gameRunning: true }), true);
  assert.equal(session.state(), 'running');
  session.send({ type: 'gameEnded' });
  assert.equal(await session.socketUp({ gameRunning: false }), true);
  assert.equal(session.state(), 'lobby');
  assert.deepEqual(reported, []);
  await session.stop();
});

test('joining a match in play with a ROM: start the engine, wait for state, run (lateJoinTest)', async () => {
  const { session, reported } = open();
  session.send(joinMidGame);
  assert.equal(session.state(), 'lateJoinStarting');
  // play.js: _lateJoin is set, nothing is pending.
  assert.equal(session.check('lateJoin', true), true);
  assert.equal(session.check('pendingLateJoin', false), true);
  session.send(engineUp);
  assert.equal(session.state(), 'lateJoinSyncing');
  // play.js clears _lateJoin once initEngine has consumed it.
  assert.equal(session.check('lateJoin', false), true);
  session.send({ type: 'lateJoinSynced' });
  assert.equal(session.state(), 'running');
  assert.deepEqual(reported, []);
  await session.stop();
});

test('joining a match in play without a ROM waits for one before the late join', async () => {
  const { session, reported } = open();
  session.send(joinMidGame);
  session.send({ type: 'lateJoinRomNeeded' });
  assert.equal(session.state(), 'lateJoinAwaitingRom');
  assert.equal(session.check('pendingLateJoin', true), true);
  assert.equal(session.check('lateJoin', true), true);
  assert.equal(session.gameOn(), true);
  session.send({ type: 'lateJoinRomReady' });
  assert.equal(session.state(), 'lateJoinStarting');
  assert.equal(session.check('pendingLateJoin', false), true);
  session.send(engineUp);
  session.send({ type: 'lateJoinSynced' });
  assert.equal(session.state(), 'running');
  assert.deepEqual(reported, []);
  await session.stop();
});

test('an engine started only to fetch the ROM is not the late join', async () => {
  // ROM sharing: the joiner accepts the host's ROM, the engine connects to
  // receive it, and the real late join starts when the transfer is done.
  const { session } = open();
  session.send(joinMidGame);
  session.send({ type: 'lateJoinRomNeeded' });
  session.send({ type: 'engineStarted', connectOnly: true, waitsForState: true });
  assert.equal(session.state(), 'lateJoinAwaitingRom');
  session.send({ type: 'lateJoinRomReady' });
  assert.equal(session.check('lateJoin', true), true);
  session.send(engineUp);
  assert.equal(session.state(), 'lateJoinSyncing');
  await session.stop();
});

test('a ROM that turns out to be the wrong one sends the joiner back to waiting', async () => {
  const { session } = open();
  session.send(joinMidGame);
  session.send({ type: 'lateJoinRomNeeded' });
  session.send({ type: 'lateJoinRomReady' });
  session.send({ type: 'lateJoinRomNeeded' });
  assert.equal(session.state(), 'lateJoinAwaitingRom');
  await session.stop();
});

test('a guest joining a streamed match needs no state: it is running once its engine starts', async () => {
  const { session, reported } = open(30);
  session.send({ ...joinMidGame, streaming: true });
  assert.equal(session.state(), 'lateJoinStarting');
  assert.equal(session.check('lateJoin', true), true);
  session.send({ type: 'engineStarted', connectOnly: false, waitsForState: false });
  assert.equal(session.state(), 'running');
  await pause(120);
  assert.deepEqual(reported, []);
  await session.stop();
});

test('a spectator of a rollback match is in the game at once, and is never reported', async () => {
  const { session, reported } = open(30);
  session.send({ ...joinMidGame, spectator: true });
  // play.js sets gameRunning for any mid-game join, but not _lateJoin for this one.
  assert.equal(await session.socketUp({ gameRunning: true }), true);
  assert.equal(session.state(), 'running');
  assert.equal(session.check('lateJoin', false), true);
  await pause(120);
  assert.deepEqual(reported, []);
  await session.stop();
});

test('a spectator of a streamed match starts its engine as a late join', async () => {
  const { session } = open();
  session.send({ ...joinMidGame, spectator: true, streaming: true });
  assert.equal(session.state(), 'lateJoinStarting');
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

test('game-started for a page already joining the match does not skip the late join', async () => {
  const { session } = open();
  session.send(joinMidGame);
  session.send({ type: 'lateJoinRomNeeded' });
  session.send({ type: 'gameStarted', matchId: 'm2' });
  assert.equal(session.state(), 'lateJoinAwaitingRom');
  await session.stop();
});

test('the page and the machine disagreeing is reported, not acted on', async () => {
  const { session, reported } = open();
  session.send({ type: 'gameStarted', matchId: 'm1' });
  assert.equal(await session.socketUp({ gameRunning: false }), false);
  assert.equal(session.state(), 'running');
  assert.deepEqual(reported, [{ type: 'session-disagree', machine: 'running', check: 'gameRunning', page: false }]);
  await session.stop();
});

test('a flag that stays wrong is reported once, and again only after it changes', async () => {
  const { session, reported } = open();
  session.send(joinMidGame);
  const wrong = { type: 'session-disagree', machine: 'lateJoinStarting', check: 'pendingLateJoin', page: true };
  assert.equal(session.check('pendingLateJoin', true), false);
  assert.equal(session.check('pendingLateJoin', true), false);
  assert.deepEqual(reported, [wrong]);
  assert.equal(session.check('pendingLateJoin', false), true);
  assert.equal(session.check('pendingLateJoin', true), false);
  assert.deepEqual(reported, [wrong, wrong]);
  await session.stop();
});

test('two flags that are both wrong are each reported once, however the reads interleave', async () => {
  const { session, reported } = open();
  session.send(joinMidGame);
  for (let read = 0; read < 3; read++) {
    session.check('pendingLateJoin', true);
    session.check('lateJoin', false);
  }
  assert.deepEqual(
    reported.map((r) => (r.type === 'session-disagree' ? r.check : r.type)),
    ['pendingLateJoin', 'lateJoin'],
  );
  await session.stop();
});

test('a late joiner who never gets state is reported once, and left waiting', async () => {
  const { session, reported } = open(30);
  session.send(joinMidGame);
  session.send(engineUp);
  await pause(120);
  assert.deepEqual(reported, [{ type: 'late-join-stranded', matchId: 'm1' }]);
  assert.equal(session.state(), 'lateJoinSyncing');
  await session.stop();
});

test('time spent choosing a ROM is not counted against the joiner', async () => {
  const { session, reported } = open(30);
  session.send(joinMidGame);
  session.send({ type: 'lateJoinRomNeeded' });
  await pause(120);
  assert.deepEqual(reported, []);
  await session.stop();
});

test('a late joiner who gets state in time is not reported', async () => {
  const { session, reported } = open(60);
  session.send(joinMidGame);
  session.send(engineUp);
  session.send({ type: 'lateJoinSynced' });
  await pause(150);
  assert.deepEqual(reported, []);
  await session.stop();
});

test('the state is readable in the same tick as the event that changed it', async () => {
  // play.js sends an event and branches on the result straight away.
  const { session } = open();
  assert.equal(session.gameOn(), false);
  session.send(joinMidGame);
  assert.equal(session.state(), 'lateJoinStarting');
  assert.equal(session.gameOn(), true);
  session.send({ type: 'gameEnded' });
  assert.equal(session.gameOn(), false);
  await session.stop();
});

test('a room closed by the server puts the page back in the lobby', async () => {
  const { session, reported } = open(30);
  session.send(joinMidGame);
  session.send(engineUp);
  session.send({ type: 'roomClosed' });
  assert.equal(session.state(), 'lobby');
  assert.equal(await session.socketUp({ gameRunning: false }), true);
  // The stranded-joiner timer died with the wait.
  await pause(120);
  assert.deepEqual(reported, []);
  await session.stop();
});

test('a rejoin the server refuses ends the game for this page, from any state (returnAfterGraceTest)', async () => {
  for (const before of [[], [engineUp], [engineUp, { type: 'lateJoinSynced' } as const]]) {
    const { session, reported } = open(30);
    session.send(joinMidGame);
    for (const event of before) session.send(event);
    assert.notEqual(session.state(), 'lobby');
    session.send({ type: 'rejoinRefused' });
    assert.equal(session.state(), 'lobby');
    assert.equal(session.gameOn(), false);
    // A fresh join afterwards is a late join of the match in play.
    session.send(joinMidGame);
    assert.equal(session.state(), 'lateJoinStarting');
    await pause(60);
    assert.deepEqual(reported, []);
    await session.stop();
  }
});
