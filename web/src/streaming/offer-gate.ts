/**
 * Which WebRTC offers a streaming page that receives the stream takes.
 *
 * In streaming the page at slot 0 runs the only emulator and makes every
 * offer; guests and spectators only answer. The server relays a
 * `webrtc-signal` between any two members of a room, and before this rule a
 * receiving page answered an offer from any of them, wired that connection
 * and showed that member's video as the game. Now a receiver applies an
 * offer only from the socket its latest roster (`users-updated`) places at
 * slot 0. The sender is the one the server stamps on the relay from the
 * sending socket, after dropping any `sender` the client wrote, so a member
 * cannot pass for the host (server/src/api/signaling.py, `_relay_signal`).
 *
 * Slot 0, not the room's `owner`: the server hands ownership to another
 * player when the owner leaves mid-match but never moves slots then, and a
 * dropped host taken back into its match holds slot 0 again while the room
 * stays with whoever owns it now. In both cases `owner` names a page with no
 * emulator.
 *
 * An offer from a sender the roster does not place yet (no roster has come,
 * or the sender is not on it) is held, not answered: the roster that places
 * it decides. Answers and candidates, and everything the host receives, are
 * not this rule's business and pass.
 *
 * The protection is against the other members of the room, not against the
 * page at slot 0: whoever holds slot 0 is the host, and is trusted.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/** `apply`: handle the signal as before. `hold`: keep it until a roster places the sender. `refuse`: drop it. */
export type OfferGate = 'apply' | 'hold' | 'refuse';

/**
 * @param receiver      this page receives the stream: it is not at slot 0
 * @param isOffer       the signal carries an offer
 * @param sender        the socket id the server stamped as the sender
 * @param hostSid       the socket id at slot 0 on this page's latest roster; empty before any roster, and when no player holds slot 0
 * @param senderListed  the latest roster lists the sender, as a player or as a spectator
 */
//@ ensures !receiver || !isOffer ==> \result === "apply"
//@ ensures receiver && isOffer && \result === "apply" ==> hostSid.length > 0 && sender === hostSid
//@ ensures receiver && isOffer && hostSid.length > 0 && sender === hostSid ==> \result === "apply"
//@ ensures receiver && isOffer && !(hostSid.length > 0 && sender === hostSid) && !senderListed ==> \result === "hold"
//@ ensures receiver && isOffer && !(hostSid.length > 0 && sender === hostSid) && senderListed ==> \result === "refuse"
export function offerGate(
  receiver: boolean,
  isOffer: boolean,
  sender: string,
  hostSid: string,
  senderListed: boolean,
): string {
  if (!receiver || !isOffer) return 'apply';
  if (hostSid.length > 0 && sender === hostSid) return 'apply';
  if (!senderListed) return 'hold';
  return 'refuse';
}
