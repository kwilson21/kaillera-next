import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Result } from 'effect';
import {
  joinRefusal,
  joinRoomRequest,
  openRoomAnswer,
  openRoomRequest,
  resumeSlot,
} from '../../web/src/play/connect.ts';
import { becomesSpectator, lateJoinPlan } from '../../web/src/play/join-plan.ts';
import { decodeJoinRoomPayload, decodeOpenRoomPayload } from '../../web/src/protocol.ts';

const JOINER = { roomCode: 'ROOM1', playerName: 'Ana', persistentId: 'pid-1', reconnectToken: 'tok' };

// ── requests ─────────────────────────────────────────────────────────────────
// The literals are what web/static/play.js built inline as of #155, less two
// fields the server's request models never had and the server never read:
// `playerId` on open-room and `userid` on join-room (the socket's own id).

test('a page loading as host opens a fresh room', () => {
  assert.deepEqual(openRoomRequest(JOINER, 'ssb64', null), {
    extra: {
      sessionid: 'ROOM1',
      player_name: 'Ana',
      room_name: "Ana's room",
      game_id: 'ssb64',
      persistentId: 'pid-1',
      reconnectToken: 'tok',
      supportsMatchReturn: true,
      fresh: true,
    },
    maxPlayers: 4,
  });
  assert.equal(openRoomRequest(JOINER, 'smash-remix', null).extra.game_id, 'smash-remix');
});

test('a host coming back mid-game resumes its slot and match, and does not ask for a fresh room', () => {
  assert.deepEqual(openRoomRequest(JOINER, 'ssb64', { slot: 0, matchId: 'm1' }), {
    extra: {
      sessionid: 'ROOM1',
      player_name: 'Ana',
      room_name: "Ana's room",
      game_id: 'ssb64',
      persistentId: 'pid-1',
      reconnectToken: 'tok',
      supportsMatchReturn: true,
      resume: true,
      slot: 0,
      matchId: 'm1',
    },
    maxPlayers: 4,
  });
});

test('a guest joins to play or to watch, and resumes the same way as a host', () => {
  assert.deepEqual(joinRoomRequest(JOINER, false, null), {
    extra: {
      sessionid: 'ROOM1',
      player_name: 'Ana',
      spectate: false,
      persistentId: 'pid-1',
      reconnectToken: 'tok',
      supportsMatchReturn: true,
    },
  });
  assert.equal(joinRoomRequest(JOINER, true, null).extra.spectate, true);
  assert.deepEqual(joinRoomRequest(JOINER, true, { slot: null, matchId: '' }).extra, {
    sessionid: 'ROOM1',
    player_name: 'Ana',
    spectate: true,
    persistentId: 'pid-1',
    reconnectToken: 'tok',
    supportsMatchReturn: true,
    resume: true,
    slot: null,
    matchId: '',
  });
});

test('a returning page asks for its own seat, and only a host offers a saved fight', () => {
  const player = joinRoomRequest(JOINER, false, null, 'player').extra;
  assert.ok('returnPlayer' in player);
  assert.equal(player.returnPlayer, true);
  assert.equal(player.returnHost, undefined);
  assert.equal(player.recoverMatchId, undefined);
  const host = joinRoomRequest(JOINER, false, null, 'host', 'previous').extra;
  assert.ok('returnHost' in host);
  assert.equal(host.returnHost, true);
  assert.equal(host.recoverMatchId, 'previous');
});

test("every request is one the server's models accept", () => {
  for (const resume of [null, { slot: 3, matchId: 'm1' }, { slot: null, matchId: '' }]) {
    assert.ok(Result.isSuccess(decodeOpenRoomPayload(openRoomRequest(JOINER, 'ssb64', resume))));
    for (const spectate of [true, false]) {
      assert.ok(Result.isSuccess(decodeJoinRoomPayload(joinRoomRequest(JOINER, spectate, resume))));
    }
  }
});

test('a resuming spectator names no slot', () => {
  assert.equal(resumeSlot(false, 2), 2);
  assert.equal(resumeSlot(false, 0), 0);
  assert.equal(resumeSlot(true, 2), null);
  assert.equal(resumeSlot(false, null), null);
  assert.equal(resumeSlot(false, undefined), null);
});

// ── answers ──────────────────────────────────────────────────────────────────

test('open-room: opened, taken over by someone else, or failed', () => {
  assert.deepEqual(openRoomAnswer(null, false), { kind: 'opened' });
  assert.deepEqual(openRoomAnswer(undefined, true), { kind: 'opened' });
  assert.deepEqual(openRoomAnswer('Not the owner', false), { kind: 'join-as-guest' });
  // The room still exists after this page was dropped as its host: it was handed on.
  assert.deepEqual(openRoomAnswer('Room already exists', true), { kind: 'join-as-guest' });
  assert.deepEqual(openRoomAnswer('Room already exists', false), {
    kind: 'failed',
    message: 'Failed to create room: Room already exists',
  });
});

test('a refused join: watch a room that filled up, or say why', () => {
  const closed = 'Ana closed the room.';
  assert.deepEqual(joinRefusal('Room is full', closed), { kind: 'watch-instead' });
  assert.deepEqual(joinRefusal('Room closed', closed), { kind: 'failed', message: closed });
  for (const cap of ['Room spectator limit reached', 'Spectator limit reached for your network']) {
    assert.deepEqual(joinRefusal(cap, closed), { kind: 'failed', message: 'This room is full for spectators.' });
  }
  assert.deepEqual(joinRefusal('Wrong password', closed), {
    kind: 'failed',
    message: 'Failed to join: Wrong password',
  });
});

// ── decisions, against the branches they restate ─────────────────────────────

// onConnect's open-room callback in web/static/play.js before it asked connect.ts.
const oldOpenRoomAnswer = (err: string | null | undefined, droppedAsHost: boolean) => {
  const roomHandedOn = err === 'Room already exists' && droppedAsHost;
  if (err === 'Not the owner' || roomHandedOn) return { kind: 'join-as-guest' };
  if (err) return { kind: 'failed', message: `Failed to create room: ${err}` };
  return { kind: 'opened' };
};

// Every answer the server sends to open-room (server/src/api/signaling.py), and some it does not.
const OPEN_ROOM_ERRORS = [
  null,
  undefined,
  '',
  'Not the owner',
  'Room already exists',
  'Server is full',
  'Rate limited',
  'Not in room',
  'Missing sessionid',
  'Invalid room code',
  'Invalid reconnect token',
  'not the owner',
  ' Not the owner',
];

test('open-room: every answer leads where the old branches led it', () => {
  for (const err of OPEN_ROOM_ERRORS) {
    for (const droppedAsHost of [true, false]) {
      assert.deepEqual(
        openRoomAnswer(err, droppedAsHost),
        oldOpenRoomAnswer(err, droppedAsHost),
        `${err} ${droppedAsHost}`,
      );
    }
  }
});

// onConnect's join-room callback before it asked connect.ts: only a full room was watched instead.
const oldJoinRefusalKind = (err: string): string => (err === 'Room is full' ? 'watch-instead' : 'failed');

test('a refused join: only a room that filled up is watched instead, as before', () => {
  for (const err of [
    'Room is full',
    'Room closed',
    'Room not found',
    'Wrong password',
    'Room spectator limit reached',
    'Spectator limit reached for your network',
    'Rate limited',
    'Not in room',
    'Invalid room code',
    'Invalid reconnect token',
    'room is full',
    '',
  ]) {
    assert.equal(joinRefusal(err, 'Ana closed the room.').kind, oldJoinRefusalKind(err), err);
  }
});

test('a page becomes a spectator exactly when the old condition said so', () => {
  for (const wantsToWatch of [true, false]) {
    for (const holdsSlot of [true, false]) {
      for (let players = 0; players <= 5; players++) {
        for (const max of [2, 4]) {
          assert.equal(
            becomesSpectator(wantsToWatch, holdsSlot, players, max),
            !wantsToWatch && !holdsSlot && players >= max,
          );
        }
      }
    }
  }
  // A player rejoining its own full room keeps its slot.
  assert.equal(becomesSpectator(false, true, 4, 4), false);
});

// onConnect's mid-game branches in web/static/play.js as of #155.
const oldLateJoin = (
  isSpectator: boolean,
  mode: string,
  hasRom: boolean,
  sharing: boolean,
  mismatch: boolean,
  decision: string | null,
) => {
  if (isSpectator || mode === 'streaming') return 'watch';
  if (!hasRom) return sharing ? 'askForSharedRom' : 'askForRom';
  if (mismatch && decision !== 'accepted') return sharing ? 'askForSharedRom' : 'wrongRom';
  return 'play';
};

test('a late joiner takes the same path the old branches took', () => {
  let compared = 0;
  for (const isSpectator of [true, false]) {
    for (const mode of ['rollback', 'streaming']) {
      for (const hasRom of [true, false]) {
        for (const sharing of [true, false]) {
          for (const mismatch of [true, false]) {
            for (const decision of ['accepted', null]) {
              assert.equal(
                lateJoinPlan(isSpectator || mode === 'streaming', hasRom, sharing, mismatch, decision === 'accepted'),
                oldLateJoin(isSpectator, mode, hasRom, sharing, mismatch, decision),
              );
              compared++;
            }
          }
        }
      }
    }
  }
  assert.equal(compared, 64);
});
