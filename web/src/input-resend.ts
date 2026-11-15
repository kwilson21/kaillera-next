/**
 * Which of its own inputs a page sends a peer again when it switches from
 * the unreliable input channel to the reliable one.
 *
 * On the unreliable channel (`rollback-input`: unordered, no retransmits)
 * every packet carries, besides its frame's input, every input the page
 * holds newer than the peer's ack, so a lost packet's inputs come with the
 * next one. The page switches to the reliable channel when its health
 * monitor sees the unreliable one stuck (DC-FALLBACK reason=buffer,
 * reason=ack-stale) or the channel closes (reason=rb-dc-close). From then on
 * packets carry their own frame's input alone, so an input lost just before
 * the switch and not acked was sent by nothing: the peer stalled on the hole
 * until it asked for it (RB-INPUT-ASK), or before #235 until its 5 s
 * deadline. specs/input_transport.qnt models it:
 * `unackedInputsAreSentAgainAtTheSwitch` is violated by the switch as it was
 * (input_transport_current) and holds when the page sends these again
 * (input_transport_fixed).
 *
 * The page sends them from the inputs it keeps, not from the redundancy
 * history: the history holds only the newest 30, and a stuck channel can
 * leave more than that unacked (stuckChannelBeyondTheCapTest). The ack is
 * the newest frame the peer has received; the packets that brought it
 * carried every frame before it, so nothing at or before it is missing.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * The frames to send again, oldest first: every frame after the ack up to
 * the newest, or the newest `max` of them when there are more.
 *
 * @param ack     the newest frame the peer has acked (-1: none)
 * @param newest  the newest frame the page has made an input for
 * @param max     send at most this many
 */
//@ requires max >= 0
//@ ensures \result.length <= max
//@ ensures forall(j: nat, j < \result.length ==> 0 <= \result[j] && ack < \result[j] && \result[j] <= newest)
//@ ensures forall(j: nat, j + 1 < \result.length ==> \result[j + 1] === \result[j] + 1)
//@ ensures \result.length > 0 ==> \result[\result.length - 1] === newest
//@ ensures (ack >= -1 && newest - ack <= max && newest > ack) ==> \result.length === newest - ack
export function framesToSendAgain(ack: number, newest: number, max: number): number[] {
  const frames: number[] = [];
  let first = ack + 1;
  if (first < newest - max + 1) first = newest - max + 1;
  if (first < 0) first = 0;
  let f = first;
  while (f <= newest) {
    //@ invariant first <= f
    //@ invariant f <= newest + 1 || f === first
    //@ invariant frames.length === f - first
    //@ invariant forall(j: nat, j < frames.length ==> frames[j] === first + j)
    //@ decreases newest + 1 - f
    frames.push(f);
    f = f + 1;
  }
  return frames;
}
