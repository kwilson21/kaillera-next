/**
 * Whether the next qualifying entry goes into the flush being built, given
 * how many entries it already holds and their estimated bytes. The first
 * entry always goes in, whatever its size: otherwise one line larger than
 * the byte budget would be skipped on every flush and the cursor would never
 * pass it. After that an entry goes in only while the budget holds.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */
//@ requires taken >= 0
//@ ensures taken === 0 ==> \result
//@ ensures taken > 0 ==> (\result === (bytes + size <= maxBytes))
export function fitsFlush(taken: number, bytes: number, size: number, maxBytes: number): boolean {
  return taken === 0 || bytes + size <= maxBytes;
}
