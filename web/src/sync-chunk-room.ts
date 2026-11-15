/**
 * Whether the next chunk may be handed to the channel, given the bytes still
 * waiting in it (`bufferedAmount`) and the low-water mark (one chunk).
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */
//@ requires lowWater > 0
//@ ensures \result === (buffered < lowWater)
export function mayHandChunk(buffered: number, lowWater: number): boolean {
  return buffered < lowWater;
}
