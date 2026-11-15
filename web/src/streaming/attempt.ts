/**
 * Which connection a streaming signal belongs to, and when the host offers
 * again: the rules SIGNALS_NAME_CONNECTION and HOST_REOFFERS of
 * specs/streaming_connection.qnt, which the engine follows
 * (streaming_connection_current).
 *
 * Every connection the host offers is named by an attempt: the host page's id
 * (made once when the page loads) and its count of the connections it has
 * offered to that member, from 1. Every signal carries the name of the
 * connection it belongs to, as `attemptId` on the `webrtc-signal` (the server
 * relays it as it is): an offer its own, an answer and a candidate the one of
 * the connection they come from. A renegotiation, and the offer the host
 * sends again on a late joiner's ready, keep the connection's name.
 *
 * A signal that names no attempt comes from a page from before attempts, and
 * is handled as it was then: applied to whatever connection the page holds.
 * The engine passes an empty page and attempt 0 for "names none".
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * What a page that receives the stream does with an offer from the host.
 * `create`: make a connection and answer from it. `renegotiate`: apply it to
 * the connection held. `replace`: close the connection held, make a new one
 * and answer from that. `drop`: ignore it.
 */
export type OfferForConnection = 'create' | 'renegotiate' | 'replace' | 'drop';

/**
 * `receiveOffer` in the model, with SIGNALS_NAME_CONNECTION. The offer for
 * the connection held is a renegotiation of it; a newer one replaces it (the
 * host made a new connection, and the one held is gone on its side); an older
 * one is dropped, since replacing the connection a newer offer made would
 * break it (olderOfferIsDroppedTest). An offer from another page of the host's
 * is newer: that page replaced the one the connection came from.
 *
 * @param hasEntry     the page holds a connection for the sender
 * @param heldPage     the page the held connection's offer named; empty when it named none
 * @param heldAttempt  the attempt it named; 0 when it named none
 * @param page         the page the offer names; empty when it names none
 * @param attempt      the attempt the offer names; 0 when it names none
 */
//@ ensures !hasEntry ==> \result === "create"
//@ ensures hasEntry && attempt < 1 ==> \result === "renegotiate"
//@ ensures hasEntry && attempt >= 1 && (heldAttempt < 1 || page !== heldPage) ==> \result === "replace"
//@ ensures hasEntry && attempt >= 1 && heldAttempt >= 1 && page === heldPage && attempt === heldAttempt ==> \result === "renegotiate"
//@ ensures hasEntry && attempt >= 1 && heldAttempt >= 1 && page === heldPage && attempt > heldAttempt ==> \result === "replace"
//@ ensures hasEntry && attempt >= 1 && heldAttempt >= 1 && page === heldPage && attempt < heldAttempt ==> \result === "drop"
export function offerForConnection(
  hasEntry: boolean,
  heldPage: string,
  heldAttempt: number,
  page: string,
  attempt: number,
): string {
  if (!hasEntry) return 'create';
  if (attempt < 1) return 'renegotiate';
  if (heldAttempt < 1 || page !== heldPage) return 'replace';
  if (attempt === heldAttempt) return 'renegotiate';
  if (attempt > heldAttempt) return 'replace';
  return 'drop';
}

/**
 * Is a candidate (or an answer) for the connection held? One that names no
 * attempt is, as before attempts. One that names an attempt is only when it
 * names the held connection's: a candidate gathered for a connection that was
 * replaced must not reach the one that replaced it.
 *
 * @param heldPage     the page the held connection's offer named; empty when it named none
 * @param heldAttempt  the attempt it named; 0 when it named none
 * @param page         the page the signal names; empty when it names none
 * @param attempt      the attempt the signal names; 0 when it names none
 */
//@ ensures attempt < 1 ==> \result === true
//@ ensures attempt >= 1 ==> \result === (heldAttempt >= 1 && page === heldPage && attempt === heldAttempt)
export function signalForConnection(heldPage: string, heldAttempt: number, page: string, attempt: number): boolean {
  if (attempt < 1) return true;
  return heldAttempt >= 1 && page === heldPage && attempt === heldAttempt;
}

/**
 * `receiveAnswer` in the model, with SIGNALS_NAME_CONNECTION: the host takes
 * an answer only on a connection that waits for one (its offer is the local
 * description and no answer is set yet; the browser refuses one in `stable`)
 * and only when it answers that connection's offer. Any other is dropped: the
 * answer to an offer the host has since replaced, or a second answer to an
 * offer it sent again.
 *
 * @param awaitingAnswer  the connection held waits for an answer
 */
//@ ensures !awaitingAnswer ==> \result === false
//@ ensures awaitingAnswer && attempt < 1 ==> \result === true
//@ ensures awaitingAnswer && attempt >= 1 ==> \result === (heldAttempt >= 1 && page === heldPage && attempt === heldAttempt)
export function answerApplies(
  awaitingAnswer: boolean,
  heldPage: string,
  heldAttempt: number,
  page: string,
  attempt: number,
): boolean {
  if (!awaitingAnswer) return false;
  if (attempt < 1) return true;
  return heldAttempt >= 1 && page === heldPage && attempt === heldAttempt;
}

/**
 * `reoffer` in the model: when the host's deadline for a member expires, it
 * offers a new connection if the roster still lists that member and its
 * channel to the host is not open. Only the host offers. An open channel is
 * never replaced (neverReplacesALiveConnection).
 *
 * @param host         this page is the host (slot 0)
 * @param listed       the latest roster lists the member, as a player or a spectator
 * @param channelOpen  the member's data channel to the host is open
 */
//@ ensures \result === (host && listed && !channelOpen)
export function reofferDue(host: boolean, listed: boolean, channelOpen: boolean): boolean {
  return host && listed && !channelOpen;
}
