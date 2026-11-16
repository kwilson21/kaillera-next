/**
 * Which existing connection a roster player keeps.
 *
 * A player's Socket.IO id changes every time their signaling socket
 * reconnects, but their WebRTC connection to us does not go away. The engine
 * keys its connections by the id the player had when the connection was made,
 * so each roster update has to work out which connection, if any, belongs to
 * the player now listed under a new id.
 *
 * Production-shaped bug, #119: both players lost signaling and the host's came
 * back first. The host saw a roster without the guest and forgot whose
 * connection was whose; when the guest rejoined under a new id, the host
 * closed its healthy connection as a stale one and the match froze. The
 * contract on `liveConnectionOf` is that case made impossible: if a live
 * connection of the same player in the same slot exists, it is found.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/** One entry of the engine's connection table. */
export interface Connection {
  /** The id the connection is filed under: the player's socket id when it was made. */
  key: string;
  slot: number;
  /** The player this connection belongs to; empty when not yet known. */
  persistentId: string;
  /** The connection is up and has an open data channel. */
  live: boolean;
}

/** What the previous roster said about a connection key. */
export interface KnownPlayer {
  key: string;
  persistentId: string;
  /** The socket id the player was last listed under. */
  socketId: string;
}

/**
 * The index of a live connection belonging to `persistentId` in `slot`, filed
 * under some id other than `sid`; -1 only if there is none.
 */
//@ requires persistentId.length > 0
//@ ensures -1 <= \result && \result < connections.length
//@ ensures \result >= 0 ==> connections[\result].persistentId === persistentId && connections[\result].slot === slot && connections[\result].live && connections[\result].key !== sid
//@ ensures \result === -1 ==> forall(k: nat, k < connections.length ==> !(connections[k].persistentId === persistentId && connections[k].slot === slot && connections[k].live && connections[k].key !== sid))
export function liveConnectionOf(connections: Connection[], persistentId: string, slot: number, sid: string): number {
  let i = 0;
  while (i < connections.length) {
    //@ invariant 0 <= i && i <= connections.length
    //@ invariant forall(k: nat, k < i ==> !(connections[k].persistentId === persistentId && connections[k].slot === slot && connections[k].live && connections[k].key !== sid))
    //@ decreases connections.length - i
    const c = connections[i]!;
    if (c.persistentId === persistentId && c.slot === slot && c.live && c.key !== sid) {
      return i;
    }
    i = i + 1;
  }
  return -1;
}

export interface RosterPlayer {
  persistentId: string;
  socketId: string;
  slot: number;
}

/**
 * The connection key for a roster player: their current socket id, unless a
 * connection to the same player in the same slot already exists under an
 * earlier id, in which case that connection is kept.
 *
 * `isOwn` is true for this page's own roster entry, which never has a
 * connection.
 */
//@ ensures isOwn ==> \result === player.socketId
export function rosterKey(
  player: RosterPlayer,
  isOwn: boolean,
  connections: Connection[],
  previouslyKnown: KnownPlayer[],
): string {
  const sid = player.socketId;
  if (isOwn || connections.some((c) => c.key === sid)) return sid;
  // The previous roster already mapped this player to a connection: keep it,
  // even while that connection recovers (an ICE restart is not live yet),
  // or a live one it listed under an earlier id.
  for (const known of previouslyKnown) {
    if (known.persistentId !== player.persistentId || known.key === sid) continue;
    const kept = connections.find((c) => c.key === known.key && c.slot === player.slot);
    if (kept !== undefined && (known.socketId === sid || kept.live)) return known.key;
  }
  // Otherwise keep any live connection that is this player's. The connection
  // itself records whose it is, so this holds even when the player was
  // missing from the previous roster.
  if (player.persistentId.length > 0) {
    const index = liveConnectionOf(connections, player.persistentId, player.slot, sid);
    if (index >= 0) return connections[index]!.key;
  }
  return sid;
}
