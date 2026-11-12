import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Result } from 'effect';
import { decodeGameEnded, decodeUsersUpdated } from '../../web/src/protocol.ts';

const usersUpdated = {
  players: {
    'pid-host': {
      socketId: 'sid-host',
      playerName: 'Host',
      slot: 0,
      romReady: true,
      inputType: 'keyboard',
      deviceType: 'desktop',
    },
  },
  spectators: {},
  owner: 'sid-host',
  status: 'lobby',
  mode: 'rollback',
  listed: false,
};

test('users-updated as the server sends it decodes', () => {
  const decoded = decodeUsersUpdated(usersUpdated);
  assert.ok(Result.isSuccess(decoded));
  if (Result.isSuccess(decoded)) assert.equal(decoded.success.players['pid-host']?.slot, 0);
});

test('an unknown status is a decode failure, not a silent pass-through', () => {
  assert.ok(Result.isFailure(decodeUsersUpdated({ ...usersUpdated, status: 'paused' })));
});

test('game-ended with no match id decodes', () => {
  assert.ok(Result.isSuccess(decodeGameEnded({ matchId: null })));
});
