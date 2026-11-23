/**
 * Which roster entries the mesh health check should reconnect to.
 *
 * Production, 2026-11-09: the engine compared roster ids against `socket.id`,
 * which is undefined while the signaling socket is down. The host's own entry
 * looked like a missing peer, so it opened a connection to itself and stalled
 * on input from its own slot. The contract below is that failure made
 * impossible: no id in `ownSids` is ever returned.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

export interface RosterEntry {
  sid: string;
  /** A data channel to this player is open. */
  healthy: boolean;
  /** A reconnect to this player is already in progress. */
  reconnecting: boolean;
}

//@ ensures forall(j: nat, j < \result.length ==> !ownSids.includes(\result[j]))
//@ ensures \result.length <= roster.length
export function meshHealTargets(roster: RosterEntry[], ownSids: string[]): string[] {
  const targets: string[] = [];
  let i = 0;
  while (i < roster.length) {
    //@ invariant 0 <= i && i <= roster.length
    //@ invariant targets.length <= i
    //@ invariant forall(j: nat, j < targets.length ==> !ownSids.includes(targets[j]))
    //@ decreases roster.length - i
    const entry = roster[i]!;
    if (!ownSids.includes(entry.sid) && !entry.healthy && !entry.reconnecting) {
      targets.push(entry.sid);
    }
    i = i + 1;
  }
  return targets;
}

/**
 * Which players in the room's roster are this page's peers: the ones it
 * keeps a connection to.
 *
 * Found by tests/lifecycle-e2e.mjs late-join-drop-during-serve, 2026-11-23:
 * the engine took every roster entry whose socket id was not `socket.id` for
 * a peer. A late joiner the host had dropped restarted its engine while its
 * signaling socket was down, when `socket.id` is undefined, so its own entry
 * (under the socket id it had before) became a peer in its own slot. It sent
 * offers to itself for the rest of the match. This page's own entry is found
 * by anything that names it: a socket id it has had, its slot, or its player
 * id, none of which depend on the socket being up.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */
export interface RosterPlayer {
  sid: string;
  /** -1 for none. */
  slot: number;
  /** The player's persistent id; empty if unknown. */
  player: string;
}

/**
 * @param roster     the players the room lists
 * @param ownSids    every socket id this page has had
 * @param ownSlot    this page's slot; -1 for none (a spectator, or not known yet)
 * @param ownPlayer  this page's player id; empty if unknown
 * @returns the positions in `roster` of this page's peers
 */
//@ ensures forall(j: nat, j < \result.length ==> 0 <= \result[j] && \result[j] < roster.length && !ownSids.includes(roster[\result[j]].sid))
//@ ensures forall(j: nat, j < \result.length ==> 0 <= \result[j] && \result[j] < roster.length && (ownSlot < 0 || roster[\result[j]].slot !== ownSlot))
//@ ensures forall(j: nat, j < \result.length ==> 0 <= \result[j] && \result[j] < roster.length && (ownPlayer.length === 0 || roster[\result[j]].player !== ownPlayer))
//@ ensures \result.length <= roster.length
export function rosterPeers(roster: RosterPlayer[], ownSids: string[], ownSlot: number, ownPlayer: string): number[] {
  const peers: number[] = [];
  let i = 0;
  while (i < roster.length) {
    //@ invariant 0 <= i && i <= roster.length
    //@ invariant peers.length <= i
    //@ invariant forall(j: nat, j < peers.length ==> 0 <= peers[j] && peers[j] < i && !ownSids.includes(roster[peers[j]].sid))
    //@ invariant forall(j: nat, j < peers.length ==> 0 <= peers[j] && peers[j] < i && (ownSlot < 0 || roster[peers[j]].slot !== ownSlot))
    //@ invariant forall(j: nat, j < peers.length ==> 0 <= peers[j] && peers[j] < i && (ownPlayer.length === 0 || roster[peers[j]].player !== ownPlayer))
    //@ decreases roster.length - i
    const entry = roster[i]!;
    const mine =
      ownSids.includes(entry.sid) ||
      (ownSlot >= 0 && entry.slot === ownSlot) ||
      (ownPlayer.length > 0 && entry.player === ownPlayer);
    if (!mine) {
      peers.push(i);
    }
    i = i + 1;
  }
  return peers;
}
