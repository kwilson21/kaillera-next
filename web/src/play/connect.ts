/**
 * Joining a room: the requests a page sends to open or join one, and what
 * each answer from the server means. Moved from `onConnect` in
 * web/static/play.js, which still sends the requests and acts on the answers.
 */
import type { JoinRoomPayload, OpenRoomPayload } from '../protocol.gen.ts';

/** Who is asking. */
export type Joiner = {
  readonly roomCode: string;
  readonly playerName: string;
  readonly persistentId: string;
  readonly reconnectToken: string;
};

/**
 * A page whose game is still running says so when it comes back: in which
 * slot and which match. The server takes it back into that match and slot or
 * refuses; it never lets it in as a new player or opens a new room.
 */
export type Resume = { readonly slot: number | null; readonly matchId: string };

/**
 * The host's `open-room`. With no `resume` it is a page loading as host,
 * which means to make the room and not take one over (`fresh`); with one it
 * is the host coming back to its own room mid-game. `gameId` names the
 * game the room is for; which game that is, is the page's business.
 */
export const openRoomRequest = (joiner: Joiner, gameId: string, resume: Resume | null) => {
  const who = {
    sessionid: joiner.roomCode,
    player_name: joiner.playerName,
    room_name: `${joiner.playerName}'s room`,
    game_id: gameId,
    persistentId: joiner.persistentId,
    reconnectToken: joiner.reconnectToken,
  };
  const extra =
    resume === null ? { ...who, fresh: true } : { ...who, resume: true, slot: resume.slot, matchId: resume.matchId };
  return { extra, maxPlayers: 4 } satisfies typeof OpenRoomPayload.Type;
};

/** A guest's `join-room`, to play or to watch; with `resume`, coming back mid-game. */
export const joinRoomRequest = (joiner: Joiner, spectate: boolean, resume: Resume | null, returnHost = false) => {
  const who = {
    sessionid: joiner.roomCode,
    player_name: joiner.playerName,
    spectate,
    persistentId: joiner.persistentId,
    reconnectToken: joiner.reconnectToken,
  };
  const extra =
    resume === null
      ? returnHost
        ? { ...who, returnHost: true }
        : who
      : { ...who, resume: true, slot: resume.slot, matchId: resume.matchId };
  return { extra } satisfies typeof JoinRoomPayload.Type;
};

/** The slot a resuming page names: none for a spectator. */
export const resumeSlot = (isSpectator: boolean, slot: number | null | undefined): number | null =>
  isSpectator || slot === null || slot === undefined ? null : slot;

// ── what a refusal means ─────────────────────────────────────────────────────

/** What a page does about the answer to its `open-room`. */
export type OpenRoomAnswer =
  | { readonly kind: 'opened' }
  /** The room is someone else's now: come in the way any other player does. */
  | { readonly kind: 'join-as-guest' }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * `droppedAsHost`: this page was host of a match the room dropped it from.
 * If the room is still there, it was handed on to another player.
 */
export const openRoomAnswer = (error: string | null | undefined, droppedAsHost: boolean): OpenRoomAnswer => {
  if (error === 'Not the owner' || (error === 'Room already exists' && droppedAsHost)) return { kind: 'join-as-guest' };
  if (error) return { kind: 'failed', message: `Failed to create room: ${error}` };
  return { kind: 'opened' };
};

/** What a page does about a refused `join-room`. */
export type JoinRefusal =
  /** The room filled between looking and joining: ask again, to watch. */
  { readonly kind: 'watch-instead' } | { readonly kind: 'failed'; readonly message: string };

/** `closedMessage` is what to say when the room has closed (it names the host). */
export const joinRefusal = (error: string, closedMessage: string): JoinRefusal => {
  if (error === 'Room is full') return { kind: 'watch-instead' };
  if (error === 'Room closed') return { kind: 'failed', message: closedMessage };
  if (error === 'Room spectator limit reached' || error === 'Spectator limit reached for your network') {
    return { kind: 'failed', message: 'This room is full for spectators.' };
  }
  return { kind: 'failed', message: `Failed to join: ${error}` };
};
