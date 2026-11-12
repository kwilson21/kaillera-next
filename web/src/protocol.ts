/**
 * Shapes of the Socket.IO messages the server sends (server/src/api/signaling.py
 * and payloads.py are the other half). Decoding at the socket boundary turns a
 * server/client disagreement into one logged event instead of an undefined
 * property read somewhere downstream.
 */
import { Schema } from 'effect';

export const RoomStatus = Schema.Literals(['lobby', 'playing']);
export type RoomStatus = typeof RoomStatus.Type;

export const RoomPlayer = Schema.Struct({
  socketId: Schema.String,
  playerName: Schema.String,
  slot: Schema.NullOr(Schema.Number),
  romReady: Schema.Boolean,
  inputType: Schema.String,
  deviceType: Schema.String,
});
export type RoomPlayer = typeof RoomPlayer.Type;

export const RoomSpectator = Schema.Struct({
  socketId: Schema.String,
  playerName: Schema.String,
});

/** `users-updated`: only the fields the page lifecycle depends on are required. */
export const UsersUpdated = Schema.Struct({
  players: Schema.Record(Schema.String, RoomPlayer),
  spectators: Schema.Record(Schema.String, RoomSpectator),
  owner: Schema.String,
  status: RoomStatus,
  mode: Schema.NullOr(Schema.String),
});
export type UsersUpdated = typeof UsersUpdated.Type;

export const GameStarted = Schema.Struct({
  mode: Schema.String,
  matchId: Schema.String,
});
export type GameStarted = typeof GameStarted.Type;

export const GameEnded = Schema.Struct({
  matchId: Schema.NullOr(Schema.String),
});
export type GameEnded = typeof GameEnded.Type;

export const decodeUsersUpdated = Schema.decodeUnknownResult(UsersUpdated);
export const decodeGameStarted = Schema.decodeUnknownResult(GameStarted);
export const decodeGameEnded = Schema.decodeUnknownResult(GameEnded);
