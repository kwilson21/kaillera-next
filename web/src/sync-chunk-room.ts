/**
 * Whether the next chunk may be handed to the channel, given the bytes still
 * waiting in it (`bufferedAmount`) and the low-water mark.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */
//@ requires lowWater > 0
//@ ensures \result === (buffered < lowWater)
export function mayHandChunk(buffered: number, lowWater: number): boolean {
  return buffered < lowWater;
}

/**
 * Whether a state transfer queued for a guest may still go to it: neither
 * the match (`epoch`, bumped by stop) nor the guest's connection (`gen`,
 * bumped by resetPeerState on a reconnect) has changed since the state was
 * taken. Otherwise its state and request id belong to a connection that is
 * gone, and the transfer is dropped (specs/tick_deadlines.qnt,
 * aTransferQueuedBeforeAResetNeverReachesTheNewConnection).
 */
//@ ensures \result === (queuedEpoch === epoch && queuedGen === gen)
export function transferStillFor(queuedEpoch: number, queuedGen: number, epoch: number, gen: number): boolean {
  return queuedEpoch === epoch && queuedGen === gen;
}
