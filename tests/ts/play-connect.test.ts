import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Result } from 'effect';
import {
  joinRefusal,
  joinRoomRequest,
  menuWait,
  openRoomAnswer,
  openRoomRequest,
  resumeSlot,
  waitedNames,
  type WaitedPeer,
} from '../../web/src/play/connect.ts';
import { becomesSpectator, lateJoinPlan } from '../../web/src/play/join-plan.ts';
import { decodeJoinRoomPayload, decodeOpenRoomPayload } from '../../web/src/protocol.ts';

const JOINER = { roomCode: 'ROOM1', playerName: 'Ana', persistentId: 'pid-1', reconnectToken: 'tok' };

// ── requests ─────────────────────────────────────────────────────────────────
// The literals are what web/static/play.js built inline as of #155, less two
// fields the server's request models never had and the server never read:
// `playerId` on open-room and `userid` on join-room (the socket's own id).

test('a page loading as host opens a fresh room', () => {
  assert.deepEqual(openRoomRequest(JOINER, null, null), {
    extra: {
      sessionid: 'ROOM1',
      player_name: 'Ana',
      room_name: "Ana's room",
      game_id: 'ssb64',
      persistentId: 'pid-1',
      reconnectToken: 'tok',
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
      resume: true,
      slot: 0,
      matchId: 'm1',
    },
    maxPlayers: 4,
  });
});

test('a guest joins to play or to watch, and resumes the same way as a host', () => {
  assert.deepEqual(joinRoomRequest(JOINER, false, null), {
    extra: { sessionid: 'ROOM1', player_name: 'Ana', spectate: false, persistentId: 'pid-1', reconnectToken: 'tok' },
  });
  assert.equal(joinRoomRequest(JOINER, true, null).extra.spectate, true);
  assert.deepEqual(joinRoomRequest(JOINER, true, { slot: null, matchId: '' }).extra, {
    sessionid: 'ROOM1',
    player_name: 'Ana',
    spectate: true,
    persistentId: 'pid-1',
    reconnectToken: 'tok',
    resume: true,
    slot: null,
    matchId: '',
  });
});

test("every request is one the server's models accept", () => {
  for (const resume of [null, { slot: 3, matchId: 'm1' }, { slot: null, matchId: '' }]) {
    assert.ok(Result.isSuccess(decodeOpenRoomPayload(openRoomRequest(JOINER, null, resume))));
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
            for (const decision of ['accepted', 'declined', null]) {
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
  assert.equal(compared, 96);
});

// ── waiting on a peer ────────────────────────────────────────────────────────

// formatMenuWaitNames in web/static/play.js as of #155.
const oldNames = (peers: readonly WaitedPeer[]) => {
  const names = peers
    .map((peer) => {
      const raw = String(peer?.name || '').trim();
      if (raw) return raw;
      const slot = Number(peer?.slot);
      return Number.isFinite(slot) ? `Player ${slot + 1}` : 'Player';
    })
    .filter(Boolean);
  if (names.length <= 1) return names[0] || 'peer';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

test('waited-on peers are named as the old code named them', () => {
  const some: WaitedPeer[] = [
    { name: 'Ana', slot: 0 },
    { name: '  ', slot: 1 },
    { slot: 2 },
    { name: null, slot: 'x' },
    { name: 'Bo' },
  ];
  for (let from = 0; from <= some.length; from++) {
    for (let to = from; to <= some.length; to++) {
      const peers = some.slice(from, to);
      assert.equal(waitedNames(peers), oldNames(peers));
    }
  }
  assert.equal(waitedNames([]), 'peer');
  assert.equal(waitedNames([{ name: 'Ana' }, { slot: 1 }, { name: 'Cy' }]), 'Ana, Player 2 and Cy');
});

test('the wait says whether a menu or the match is paused', () => {
  assert.deepEqual(menuWait([{ name: 'Ana' }], 22), {
    title: 'Waiting on Ana',
    detail: 'The match is paused to stay in sync.',
  });
  assert.equal(menuWait([], Number.NaN).detail, 'The menu is paused to stay in sync.');
});
