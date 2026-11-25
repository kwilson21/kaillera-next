/**
 * How a guest's C engine starts. The host arms its engine when its match
 * starts and tells each guest the delay and the frame it armed at
 * (`rb-delay:`, `rb-init-frame:`); a late joiner learns both from the host's
 * state. Until it has both, the guest runs no frame. This is what it does
 * with what it has heard, each time it hears something and on each tick.
 *
 * The guest arms only with the host's delay, at the frame it is on, and never
 * when the host gave it another frame. specs/engine_start.qnt models the
 * handshake (`armsWithTheHostsDelay`, `theHostsStartIsWhereTheGuestIs`):
 * since no page runs a frame before it arms, and a waiting page keeps its
 * frame when its tab comes back, the host's start frame is always the
 * guest's own, so `stopFrame` is a loud failure for a case that does not
 * happen, not a path a match takes. A guest that has no delay from the host
 * by the deadline stops and says so; it never arms with a delay of its own
 * (`aGuestStopsOnlyWhenTheHostIsUnreachable`: the armed host sends both again
 * on every channel that opens, so a guest it can reach hears them first).
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/**
 * `arm`: arm now, with the host's delay, at this page's frame. `wait`: the
 * host's word has not come yet. `stopNoHost`: no delay from the host by the
 * deadline. `stopFrame`: the host's start frame is not this page's.
 */
export type StartStep = 'arm' | 'wait' | 'stopNoHost' | 'stopFrame';

/**
 * The guest arms as soon as it has both. At the deadline, with the delay but
 * no start frame (the channel closed between the two), it arms with the
 * delay at its own frame, which is the host's start; with no delay, it stops.
 *
 * @param heardDelay  the host's delay, or -1 when not heard (0 is a delay:
 *                    alone in a room the match runs at 0)
 * @param heardStart  the host's start frame, or -1 when not heard
 * @param ownFrame    the frame this page is on
 * @param waitedMs    how long this page has waited for the host
 * @param deadlineMs  how long it waits before it decides without the host
 */
//@ requires ownFrame >= 0 && deadlineMs >= 0
//@ ensures heardStart >= 0 && heardStart !== ownFrame ==> \result === "stopFrame"
//@ ensures heardDelay >= 0 && heardStart === ownFrame ==> \result === "arm"
//@ ensures heardDelay >= 0 && heardStart < 0 && waitedMs >= deadlineMs ==> \result === "arm"
//@ ensures \result === "arm" ==> heardDelay >= 0 && (heardStart === ownFrame || (heardStart < 0 && waitedMs >= deadlineMs))
//@ ensures heardDelay < 0 && (heardStart < 0 || heardStart === ownFrame) && waitedMs >= deadlineMs ==> \result === "stopNoHost"
//@ ensures \result === "wait" ==> waitedMs < deadlineMs
export function guestStartStep(
  heardDelay: number,
  heardStart: number,
  ownFrame: number,
  waitedMs: number,
  deadlineMs: number,
): StartStep {
  if (heardStart >= 0 && heardStart !== ownFrame) return 'stopFrame';
  if (heardDelay >= 0 && heardStart >= 0) return 'arm';
  if (waitedMs >= deadlineMs) {
    if (heardDelay >= 0) return 'arm';
    return 'stopNoHost';
  }
  return 'wait';
}

/**
 * The delay a match runs at once a player joins it. Alone in a room the
 * match runs at 0; its first player moves it to a match delay at the join
 * frame (specs/engine_start.qnt, REARM_AT_JOIN): the larger of what the host
 * and the joiner measured on their new channel, as at a normal start, or the
 * default when neither has a measurement. A match already above 0 keeps its
 * delay, as for any later joiner.
 *
 * @param hostDelay  the delay the match runs at now
 * @param own        the host's delay from its RTT samples to the joiner, 0 if none
 * @param offered    the joiner's delay from its samples to the host, 0 if none
 * @param fallback   the default delay
 */
//@ requires fallback > 0
//@ ensures hostDelay > 0 ==> \result === hostDelay
//@ ensures hostDelay <= 0 ==> \result > 0
//@ ensures hostDelay <= 0 && (own > 0 || offered > 0) ==> \result >= own && \result >= offered
//@ ensures hostDelay <= 0 && own <= 0 && offered <= 0 ==> \result === fallback
export function delayAtJoin(hostDelay: number, own: number, offered: number, fallback: number): number {
  if (hostDelay > 0) return hostDelay;
  if (own > 0 || offered > 0) {
    if (own >= offered) return own;
    return offered;
  }
  return fallback;
}

/** A restored input ring uses its saved delay. A fresh match uses the new connection's measurement. */
//@ requires saved >= -1 && negotiated >= 0
//@ ensures saved >= 0 ==> \result === saved
//@ ensures saved < 0 ==> \result === negotiated
export function delayAtStart(saved: number, negotiated: number): number {
  return saved >= 0 ? saved : negotiated;
}
