/**
 * Which frame a peer screenshots for a frame the desync detector flagged.
 *
 * The two peers' pictures are compared, so they must show the same frame.
 * Each peer flags frame F at a different tick: at least one rollback window
 * after F, plus however long the other peer's digest took to arrive. A
 * picture taken at that moment shows whatever frame the peer happens to be
 * on. Both peers know F, so both can wait for the same later frame instead.
 *
 * specs/desync_capture.qnt has the property (`comparedPicturesShowOneFrame`)
 * as violated when a peer captures as it flags and as holding with this
 * rule; `captureAt` there is `captureFrame`.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/** Returned when the capture frame has already gone by: take no picture. */
export const NO_CAPTURE = -1;

/**
 * The frame to screenshot at, or `NO_CAPTURE`.
 *
 * @param suspectFrame  the flagged frame, the same number on both peers
 * @param tick          the frame this peer has just simulated
 * @param lead          frames after `suspectFrame` at which both capture
 */
//@ requires suspectFrame >= 0 && tick >= 0 && lead >= 0
//@ ensures \result === -1 || (\result === suspectFrame + lead && \result >= tick)
//@ ensures tick <= suspectFrame + lead ==> \result === suspectFrame + lead
export function captureFrame(suspectFrame: number, tick: number, lead: number): number {
  const at = suspectFrame + lead;
  if (tick > at) return -1;
  return at;
}
