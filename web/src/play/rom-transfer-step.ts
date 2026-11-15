/**
 * The guest's ROM transfer, the parts that decide: what a closed channel or
 * an unanswered request leads to, and whether a header or a chunk is taken.
 * web/src/play/rom-transfer.ts builds the transfer's state from these.
 *
 * Verified with LemmaScript (Dafny backend); see LemmaScript-files.txt.
 */

/** Automatic retries before the guest is asked. */
export const MAX_RETRIES = 3;

/**
 * After a wait ended badly. `retry`: ask again by itself after a pause.
 * `stalled`: retries are used up; the guest decides.
 */
export type RetryVerdict = 'retry' | 'stalled';

/**
 * The channel closed mid-transfer. `retries` already counts this failure.
 * Retried automatically whether or not any of the file arrived: a channel
 * also closes with nothing received when the host never heard the guest's
 * first message, and it used to leave the guest on "ROM transfer failed"
 * (specs/rom_transfer.qnt, `retriesBeforeAsking`).
 */
//@ requires retries >= 1
//@ ensures retries <= 3 ==> \result === "retry"
//@ ensures retries > 3 ==> \result === "stalled"
export function afterChannelClosed(retries: number): RetryVerdict {
  if (retries <= 3) return 'retry';
  return 'stalled';
}

/** No channel came after asking. `retries` already counts this failure. */
//@ requires retries >= 1
//@ ensures retries <= 3 ==> \result === "retry"
//@ ensures retries > 3 ==> \result === "stalled"
export function afterResumeTimedOut(retries: number): RetryVerdict {
  if (retries <= 3) return 'retry';
  return 'stalled';
}

/**
 * A chunk of `bytes` arriving after `received`. `tooLarge`: past the largest
 * ROM a guest accepts. `overHeader`: more than a tenth past the size the
 * host announced (`headerSize`, or -1 before a header). Compared in whole
 * numbers: ten times the total against eleven times the announced size.
 */
export type ChunkVerdict = 'accept' | 'tooLarge' | 'overHeader';

//@ requires received >= 0 && bytes >= 0 && maxSize >= 0 && headerSize >= -1
//@ ensures received + bytes > maxSize ==> \result === "tooLarge"
//@ ensures \result === "overHeader" ==> headerSize >= 0 && (received + bytes) * 10 > headerSize * 11
//@ ensures \result === "accept" ==> received + bytes <= maxSize
//@ ensures \result === "accept" && headerSize >= 0 ==> (received + bytes) * 10 <= headerSize * 11
export function chunkVerdict(received: number, bytes: number, headerSize: number, maxSize: number): ChunkVerdict {
  const total = received + bytes;
  if (total > maxSize) return 'tooLarge';
  if (headerSize >= 0 && total * 10 > headerSize * 11) return 'overHeader';
  return 'accept';
}

/**
 * A header arriving. `tooLarge`: refuse the transfer. `restart`: the host is
 * now sending a different file from the one partly received, so what arrived
 * is dropped. `keep`: carry on.
 */
export type HeaderVerdict = 'keep' | 'restart' | 'tooLarge';

//@ requires size >= 0 && maxSize >= 0
//@ ensures size > maxSize ==> \result === "tooLarge"
//@ ensures \result === "restart" ==> size <= maxSize && hadHeader && !sameFile
//@ ensures size <= maxSize && hadHeader && !sameFile ==> \result === "restart"
//@ ensures size <= maxSize && (!hadHeader || sameFile) ==> \result === "keep"
export function headerVerdict(size: number, maxSize: number, hadHeader: boolean, sameFile: boolean): HeaderVerdict {
  if (size > maxSize) return 'tooLarge';
  if (hadHeader && !sameFile) return 'restart';
  return 'keep';
}
