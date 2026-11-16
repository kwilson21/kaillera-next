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
