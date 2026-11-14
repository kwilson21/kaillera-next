import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Result } from 'effect';
import {
  decodeClaimSlotPayload,
  decodeEndGamePayload,
  decodeGameEnded,
  decodeGameStarted,
  decodeJoinRoomAck,
  decodeJoinRoomPayload,
  decodeOpenRoomPayload,
  decodeRomReadyPayload,
  decodeRenegotiateRequest,
  decodeRomSharingUpdated,
  decodeSessionLogAck,
  decodeSetModePayload,
  decodeSetNamePayload,
  decodeStartGamePayload,
  decodeTokenMessage,
  decodeUsersUpdated,
  GameMode,
  RoomStatus,
  serverEvents,
  UsersUpdated,
} from '../../web/src/protocol.ts';
import { KNCore } from '../../web/src/index.ts';

// Payloads as server/src/api/signaling.py builds them (`_players_payload`,
// the `game-started` emit, the `join-room` ack), duplicate snake_case keys
// included. tests/test_protocol_payloads.py holds the real ones to the models
// these schemas are generated from.
const ROM_HASH = `S${'ab'.repeat(32)}`;
const MATCH_ID = '5b0c9a4e-7f1d-4c55-9a53-0e6f1f2f7a10';

const hostRom = { hash: ROM_HASH, name: 'Smash.z64', size: 16777216, gameId: 'ssb64', game_id: 'ssb64' };

const usersUpdated = {
  players: {
    'pid-host': {
      socketId: 'sid-host',
      playerName: 'Host',
      slot: 0,
      romReady: true,
      inputType: 'gamepad',
      deviceType: 'desktop',
    },
    'pid-guest': {
      socketId: 'sid-guest',
      playerName: 'Guest',
      slot: 1,
      romReady: false,
      inputType: 'keyboard',
      deviceType: 'mobile',
    },
  },
  spectators: { 'pid-spec': { socketId: 'sid-spec', playerName: 'Watcher' } },
  owner: 'sid-host',
  romSharing: false,
  romHash: ROM_HASH,
  romName: 'Smash.z64',
  rom_name: 'Smash.z64',
  romSize: 16777216,
  rom_size: 16777216,
  hostRom,
  gameId: 'ssb64',
  game_id: 'ssb64',
  mode: 'rollback',
  status: 'lobby',
  listed: false,
};

/** A room just opened: no ROM, no mode, nobody but the host. */
const freshRoom = {
  ...usersUpdated,
  players: { 'pid-host': { ...usersUpdated.players['pid-host'], romReady: false } },
  spectators: {},
  romHash: null,
  romName: null,
  rom_name: null,
  romSize: null,
  rom_size: null,
  hostRom: { hash: null, name: null, size: null, gameId: 'ssb64', game_id: 'ssb64' },
  mode: null,
};

const gameStarted = {
  mode: 'rollback',
  resyncEnabled: true,
  romHash: ROM_HASH,
  romName: 'Smash.z64',
  rom_name: 'Smash.z64',
  romSize: 16777216,
  rom_size: 16777216,
  hostRom,
  gameId: 'ssb64',
  matchId: MATCH_ID,
};

const joinAck = { ...usersUpdated, rom_hash: ROM_HASH, rom_sharing: false, matchId: null };

const without = <T extends object, K extends keyof T>(payload: T, key: K): Omit<T, K> => {
  const { [key]: _dropped, ...rest } = payload;
  return rest;
};

// ── server → client ─────────────────────────────────────────────────────────

test('users-updated as the server sends it decodes', () => {
  const decoded = decodeUsersUpdated(usersUpdated);
  assert.ok(Result.isSuccess(decoded));
  if (Result.isSuccess(decoded)) {
    assert.equal(decoded.success.players['pid-host']?.slot, 0);
    assert.equal(decoded.success.spectators['pid-spec']?.playerName, 'Watcher');
    assert.equal(decoded.success.hostRom.size, 16777216);
  }
});

test('users-updated for a room with no ROM and no mode decodes', () => {
  assert.ok(Result.isSuccess(decodeUsersUpdated(freshRoom)));
});

test('a player with no slot decodes', () => {
  const guest = { ...usersUpdated.players['pid-guest'], slot: null };
  assert.ok(Result.isSuccess(decodeUsersUpdated({ ...usersUpdated, players: { 'pid-guest': guest } })));
});

test('an unknown status is a decode failure, not a silent pass-through', () => {
  assert.ok(Result.isFailure(decodeUsersUpdated({ ...usersUpdated, status: 'paused' })));
});

test('users-updated of the wrong shape is rejected', () => {
  assert.ok(Result.isFailure(decodeUsersUpdated(null)));
  assert.ok(Result.isFailure(decodeUsersUpdated('lobby')));
  assert.ok(Result.isFailure(decodeUsersUpdated(without(usersUpdated, 'owner'))));
  assert.ok(Result.isFailure(decodeUsersUpdated(without(usersUpdated, 'hostRom'))));
  assert.ok(Result.isFailure(decodeUsersUpdated({ ...usersUpdated, players: [] })));
  assert.ok(Result.isFailure(decodeUsersUpdated({ ...usersUpdated, romSize: '16777216' })));
  assert.ok(Result.isFailure(decodeUsersUpdated({ ...usersUpdated, romSize: 1.5 })));
  const noSocket = without(usersUpdated.players['pid-host'], 'socketId');
  assert.ok(Result.isFailure(decodeUsersUpdated({ ...usersUpdated, players: { 'pid-host': noSocket } })));
  const slotAsString = { ...usersUpdated.players['pid-host'], slot: '0' };
  assert.ok(Result.isFailure(decodeUsersUpdated({ ...usersUpdated, players: { 'pid-host': slotAsString } })));
});

test('a key a newer server adds does not break an older page', () => {
  assert.ok(Result.isSuccess(decodeUsersUpdated({ ...usersUpdated, addedLater: { anything: 1 } })));
});

test('game-started decodes, and only with a known mode and a match id', () => {
  const decoded = decodeGameStarted(gameStarted);
  assert.ok(Result.isSuccess(decoded));
  if (Result.isSuccess(decoded)) assert.equal(decoded.success.matchId, MATCH_ID);
  assert.ok(Result.isSuccess(decodeGameStarted({ ...gameStarted, mode: 'streaming' })));
  assert.ok(Result.isFailure(decodeGameStarted({ ...gameStarted, mode: 'lockstep' })));
  assert.ok(Result.isFailure(decodeGameStarted({ ...gameStarted, matchId: null })));
  assert.ok(Result.isFailure(decodeGameStarted(without(gameStarted, 'matchId'))));
  assert.ok(Result.isFailure(decodeGameStarted({ ...gameStarted, resyncEnabled: 'yes' })));
});

test('game-ended decodes with and without a match id, and rejects a missing key', () => {
  assert.ok(Result.isSuccess(decodeGameEnded({ matchId: MATCH_ID })));
  assert.ok(Result.isSuccess(decodeGameEnded({ matchId: null })));
  assert.ok(Result.isFailure(decodeGameEnded({})));
  assert.ok(Result.isFailure(decodeGameEnded({ matchId: 7 })));
});

test('the join-room ack decodes in the lobby (null matchId) and mid-match', () => {
  const lobby = decodeJoinRoomAck(joinAck);
  assert.ok(Result.isSuccess(lobby));
  if (Result.isSuccess(lobby)) assert.equal(lobby.success.matchId, null);
  assert.ok(Result.isFailure(decodeJoinRoomAck(without(joinAck, 'matchId'))));
  const playing = decodeJoinRoomAck({ ...joinAck, status: 'playing', matchId: MATCH_ID });
  assert.ok(Result.isSuccess(playing));
  if (Result.isSuccess(playing)) assert.equal(playing.success.matchId, MATCH_ID);
});

test('a users-updated payload is not a join-room ack', () => {
  assert.ok(Result.isFailure(decodeJoinRoomAck(usersUpdated)));
  assert.ok(Result.isFailure(decodeJoinRoomAck({ ...joinAck, rom_sharing: null })));
  assert.ok(Result.isFailure(decodeJoinRoomAck({ ...joinAck, matchId: 12 })));
});

test('rom-sharing-updated and the token messages decode', () => {
  assert.ok(Result.isSuccess(decodeRomSharingUpdated({ romSharing: true })));
  assert.ok(Result.isFailure(decodeRomSharingUpdated({ romSharing: 'true' })));
  assert.ok(Result.isSuccess(decodeTokenMessage({ token: '1762992000.9f8e7d' })));
  assert.ok(Result.isFailure(decodeTokenMessage({})));
});

test("the server's own webrtc-signal and the session-log ack decode", () => {
  assert.ok(Result.isSuccess(decodeRenegotiateRequest({ requestRenegotiate: true })));
  assert.ok(Result.isFailure(decodeRenegotiateRequest({ requestRenegotiate: false })));
  // A relayed signal from a peer is another message.
  assert.ok(Result.isFailure(decodeRenegotiateRequest({ sender: 'sid-guest', target: 'sid-host', offer: {} })));
  assert.ok(Result.isSuccess(decodeSessionLogAck({ lastSeq: 41, auditLastSeq: -1 })));
  assert.ok(Result.isFailure(decodeSessionLogAck({ lastSeq: 41 })));
  assert.ok(Result.isFailure(decodeSessionLogAck(null)));
});

test('a room mode is one of the two modes, or null before one is picked', () => {
  assert.ok(Result.isSuccess(decodeUsersUpdated({ ...usersUpdated, mode: 'streaming' })));
  assert.ok(Result.isSuccess(decodeUsersUpdated({ ...usersUpdated, mode: null })));
  assert.ok(Result.isFailure(decodeUsersUpdated({ ...usersUpdated, mode: 'lockstep' })));
  assert.deepEqual(GameMode.literals, ['rollback', 'streaming']);
});

test('serverEvents maps each server-authored event to its schema, relays left out', () => {
  assert.deepEqual(Object.keys(serverEvents).sort(), [
    'game-ended',
    'game-started',
    'reconnect-token',
    'rom-sharing-updated',
    'upload-token',
    'users-updated',
  ]);
  assert.equal(serverEvents['users-updated'], UsersUpdated);
  assert.ok(!('webrtc-signal' in serverEvents));
});

test('RoomStatus keeps its two values for the lifecycle machine', () => {
  assert.deepEqual(RoomStatus.literals, ['lobby', 'playing']);
});

// ── client → server ─────────────────────────────────────────────────────────

test('open-room and join-room as play.js sends them decode', () => {
  const extra = { sessionid: 'ABC123', persistentId: 'pid-host', reconnectToken: '', player_name: 'Host' };
  const open = { extra: { ...extra, room_name: "Host's room", game_id: 'ssb64', fresh: true }, maxPlayers: 4 };
  assert.ok(Result.isSuccess(decodeOpenRoomPayload(open)));
  assert.ok(Result.isSuccess(decodeOpenRoomPayload({ ...open, password: null })));
  assert.ok(Result.isSuccess(decodeJoinRoomPayload({ extra: { ...extra, spectate: true }, password: 'hunter2' })));
  // Every field has a server default, so the empty payload is valid too.
  assert.ok(Result.isSuccess(decodeOpenRoomPayload({})));
  assert.ok(Result.isSuccess(decodeEndGamePayload({})));
});

test("the server's bounds are the client's bounds", () => {
  assert.ok(Result.isFailure(decodeOpenRoomPayload({ maxPlayers: 5 })));
  assert.ok(Result.isFailure(decodeOpenRoomPayload({ maxPlayers: 0 })));
  assert.ok(Result.isFailure(decodeOpenRoomPayload({ maxPlayers: 2.5 })));
  assert.ok(Result.isFailure(decodeOpenRoomPayload({ extra: { player_name: 'x'.repeat(33) } })));
  assert.ok(Result.isSuccess(decodeClaimSlotPayload({ slot: 3 })));
  assert.ok(Result.isSuccess(decodeClaimSlotPayload({ slot: null })));
  assert.ok(Result.isFailure(decodeClaimSlotPayload({ slot: 4 })));
  assert.ok(Result.isFailure(decodeClaimSlotPayload({ slot: -1 })));
  assert.ok(
    Result.isSuccess(decodeRomReadyPayload({ ready: true, hash: ROM_HASH, name: 'Smash.z64', size: 16777216 })),
  );
  assert.ok(Result.isFailure(decodeRomReadyPayload({ size: 512 * 1024 * 1024 + 1 })));
  assert.ok(Result.isFailure(decodeStartGamePayload({ mode: 'turbo' })));
  assert.ok(Result.isSuccess(decodeStartGamePayload({ mode: 'streaming', resyncEnabled: false, romHash: null })));
});

test('the pre-rename mode is not something a current page sends', () => {
  // The server still coerces "lockstep" from cached pages; the schema leaves it out on purpose.
  assert.ok(Result.isFailure(decodeStartGamePayload({ mode: 'lockstep' })));
  assert.ok(Result.isFailure(decodeSetModePayload({ mode: 'lockstep' })));
  assert.ok(Result.isSuccess(decodeSetModePayload({ mode: 'rollback' })));
});

test('a name is measured in code points, as the server measures it', () => {
  // 24 emoji are 48 UTF-16 units; Pydantic's max_length=24 accepts them.
  assert.ok(Result.isSuccess(decodeSetNamePayload({ name: '🎮'.repeat(24) })));
  assert.ok(Result.isFailure(decodeSetNamePayload({ name: '🎮'.repeat(25) })));
});

test('KNCore exposes the decoders to the plain-script pages', () => {
  assert.equal(KNCore.protocol.decodeUsersUpdated, decodeUsersUpdated);
  assert.equal(KNCore.protocol.decodeJoinRoomAck, decodeJoinRoomAck);
  assert.ok(Result.isSuccess(KNCore.protocol.decodeGameStarted(gameStarted)));
});
