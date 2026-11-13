/**
 * The decisions of the peer mesh: who offers, what an incoming signal does to
 * the connection table, what a lost connection leads to, and when to stop
 * retrying. Each is the rule the engine applies today
 * (web/static/netplay-rollback.js: onUsersUpdated, onWebRTCSignal,
 * handlePeerDisconnect, retryStartupConnection, attemptReconnect), written
 * as a function with a contract so the rule can be proved and then called
 * from one place.
 *
 * The orderings these rules are used in are model-checked in
 * specs/peer_connection.qnt. That model also lists what the rules do not yet
 * guarantee; nothing here changes behaviour.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * Does this page send the offer to a player it has no connection to yet?
 *
 * Of two players in the lobby exactly one does: the lower slot. A player
 * joining a match in play always does, because the pages already in it
 * cannot know when the joiner is ready to answer; they never offer to a
 * player they are holding as a late joiner, and a running page offers to
 * nobody. A spectator never offers (players offer to spectators), and that
 * comes first: a spectator who joins a streamed match in play is a late
 * joiner too.
 *
 * Known gap, kept as it is today: two players who join a match in play at
 * the same moment are both `lateJoiner`, so both offer to each other.
 *
 * @param spectator   this page is a spectator
 * @param lateJoiner  this page is joining a match already in play
 * @param running     this page is running the match
 * @param held        the other player is held as a late joiner (start-cohort.ts)
 * @param mySlot      this page's slot; ignored for a spectator
 * @param theirSlot   the other player's slot
 */
//@ ensures spectator ==> \result === false
//@ ensures !spectator && lateJoiner ==> \result === true
//@ ensures !spectator && !lateJoiner && (running || held) ==> \result === false
//@ ensures !spectator && !lateJoiner && !running && !held ==> \result === (mySlot < theirSlot)
export function shouldInitiate(
  spectator: boolean,
  lateJoiner: boolean,
  running: boolean,
  held: boolean,
  mySlot: number,
  theirSlot: number,
): boolean {
  if (spectator) return false;
  if (lateJoiner) return true;
  if (running || held) return false;
  return mySlot < theirSlot;
}

/**
 * `replaceKept`: the offer comes from a new page of a player whose earlier
 * connection was kept across a socket reconnect; that connection is a
 * leftover, drop it and decide again. `create`: make the entry on demand (the
 * offer arrived before the roster) and decide again. `reset`: a reconnect
 * offer for an entry that exists; replace its connection, then apply the
 * offer. `apply`: hand the signal to the connection. `drop`: there is nothing
 * to apply it to.
 */
export type SignalDisposition = 'replaceKept' | 'create' | 'reset' | 'apply' | 'drop';

/**
 * What an incoming WebRTC signal does to the connection table.
 *
 * Only an offer can create, replace or reset anything: an answer or a
 * candidate for a connection that does not exist is dropped.
 *
 * @param isOffer          the signal is an offer (otherwise an answer or a candidate)
 * @param reconnect        the offer says it replaces an earlier connection
 * @param underEarlierId   the sender's connection is filed under an earlier socket id of theirs
 * @param hasEntry         a connection entry for the sender exists
 */
//@ ensures !isOffer && hasEntry ==> \result === "apply"
//@ ensures !isOffer && !hasEntry ==> \result === "drop"
//@ ensures isOffer && !reconnect && underEarlierId ==> \result === "replaceKept"
//@ ensures isOffer && !(!reconnect && underEarlierId) && !hasEntry ==> \result === "create"
//@ ensures isOffer && reconnect && hasEntry ==> \result === "reset"
//@ ensures isOffer && !reconnect && !underEarlierId && hasEntry ==> \result === "apply"
export function signalDisposition(
  isOffer: boolean,
  reconnect: boolean,
  underEarlierId: boolean,
  hasEntry: boolean,
): string {
  if (!isOffer) return hasEntry ? 'apply' : 'drop';
  if (!reconnect && underEarlierId) return 'replaceKept';
  if (!hasEntry) return 'create';
  return reconnect ? 'reset' : 'apply';
}

/**
 * `retryStartup`: the match has not started and this page made the offer, so
 * it replaces the connection and offers again. `reconnect`: the match is
 * running; keep the entry and reconnect. `hardDisconnect`: drop the entry.
 */
export type DisconnectDisposition = 'retryStartup' | 'reconnect' | 'hardDisconnect';

/**
 * What a lost connection leads to.
 *
 * A player who left on purpose is never reconnected to, and neither is one
 * still held as a late joiner: they have no state in the match to recover.
 *
 * @param beforeStart      the match has not started on this page
 * @param initiator        this page made the offer for the connection
 * @param intentionalLeave the other player said they were leaving
 * @param pendingLateJoin  the other player is held as a late joiner
 * @param running          this page is running the match
 */
//@ ensures intentionalLeave ==> \result === "hardDisconnect"
//@ ensures beforeStart && initiator && !intentionalLeave ==> \result === "retryStartup"
//@ ensures \result === "reconnect" ==> running && !intentionalLeave && !pendingLateJoin
//@ ensures !(beforeStart && initiator) && !intentionalLeave && !pendingLateJoin && running ==> \result === "reconnect"
export function disconnectDisposition(
  beforeStart: boolean,
  initiator: boolean,
  intentionalLeave: boolean,
  pendingLateJoin: boolean,
  running: boolean,
): string {
  if (intentionalLeave) return 'hardDisconnect';
  if (beforeStart && initiator) return 'retryStartup';
  if (pendingLateJoin) return 'hardDisconnect';
  return running ? 'reconnect' : 'hardDisconnect';
}

/**
 * After a connection attempt ran out of time: is there another one?
 *
 * The same rule ends the startup retries and the reconnect attempts, so
 * neither can go on for ever: attempts count up from 1 and stop at
 * `maxAttempts`.
 */
//@ requires attempt >= 1 && maxAttempts >= 1
//@ ensures \result === (attempt < maxAttempts)
export function hasAttemptLeft(attempt: number, maxAttempts: number): boolean {
  return attempt < maxAttempts;
}

/** One entry of the engine's connection table. */
export interface SlotHolder {
  /** The id the connection is filed under. */
  key: string;
  /** The slot it plays in; -1 for a spectator. */
  slot: number;
}

/**
 * The connections a new player in `slot` replaces: every entry holding that
 * slot under another id. The player's own id is never among them, and no
 * entry for another slot is.
 */
//@ requires slot >= 0
//@ ensures forall(j: nat, j < \result.length ==> \result[j] !== sid)
//@ ensures \result.length <= holders.length
export function staleHoldersOf(holders: SlotHolder[], sid: string, slot: number): string[] {
  const stale: string[] = [];
  let i = 0;
  while (i < holders.length) {
    //@ invariant 0 <= i && i <= holders.length
    //@ invariant stale.length <= i
    //@ invariant forall(j: nat, j < stale.length ==> stale[j] !== sid)
    //@ decreases holders.length - i
    const holder = holders[i]!;
    if (holder.key !== sid && holder.slot === slot) {
      stale.push(holder.key);
    }
    i = i + 1;
  }
  return stale;
}
