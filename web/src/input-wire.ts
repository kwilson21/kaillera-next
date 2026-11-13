/**
 * The input wire format: how one player's N64 input travels over a WebRTC
 * DataChannel, and how the other side reads it back.
 *
 * A packet is a sequence of 32-bit signed integers ("words") in the sender's
 * native byte order (an `Int32Array` buffer; little-endian on every platform
 * the site runs on):
 *
 *   header, 6 words (24 bytes)
 *     0  frame      the frame this input is for
 *     1  buttons    button bitmask (bits 0-23 are N64 buttons and C directions)
 *     2  lstick     left stick: x in the low 16 bits, y in the high 16 bits
 *     3  cstick     C stick, packed the same way
 *     4  ackFrame   the highest frame received from the peer, -1 for none
 *     5  redCount   how many redundancy records follow
 *   then redCount records of 4 words (16 bytes) each
 *     0  delta      header frame minus this record's frame
 *     1  buttons
 *     2  lstick
 *     3  cstick
 *
 * A stick axis is a 16-bit two's-complement integer (gameplay uses -83..83).
 * The redundancy records repeat the sender's last few frames so one lost
 * packet does not cost an input; receivers dedupe them by frame.
 *
 * Decoders also accept the two older packet shapes: 4 words (no ackFrame, read
 * as -1) and 5 words (no redundancy). A redCount larger than the packet holds
 * is cut off at the last whole record.
 *
 * The file has two layers. The word layer (`encodeWords`, `decodeWords` and
 * the functions they use) is integer arithmetic and is verified with
 * LemmaScript (Dafny backend; see LemmaScript-files.txt): `decodeOfEncode`
 * carries the proof that decoding an encoded packet gives back the frame,
 * buttons, sticks, ackFrame and every redundancy record, for every input
 * whose values fit the format. The byte layer (`encodeInput`, `decodeInput`)
 * is not verified: it wraps values into range with the same integer
 * conversions the previous plain-JavaScript code used, calls the word layer,
 * and copies words to and from an `Int32Array`. tests/ts/input-wire.test.ts
 * checks that layer against vectors captured from the previous code.
 */

/** One frame of one player's input. */
export interface WireInput {
  buttons: number;
  lx: number;
  ly: number;
  cx: number;
  cy: number;
}

/** An input together with the frame it is for: one redundancy record. */
export interface FrameInput {
  frame: number;
  buttons: number;
  lx: number;
  ly: number;
  cx: number;
  cy: number;
}

/** A decoded packet, at the word layer. */
export interface DecodedWords {
  frame: number;
  buttons: number;
  lx: number;
  ly: number;
  cx: number;
  cy: number;
  ackFrame: number;
  redundant: FrameInput[];
}

export function isInt32(v: number): boolean {
  return -2147483648 <= v && v <= 2147483647;
}

export function isInt16(v: number): boolean {
  return -32768 <= v && v <= 32767;
}

/** The y axis of a packed stick word: its high 16 bits, signed. */
//@ ensures isInt32(word) ==> isInt16(\result)
export function unpackY(word: number): number {
  return Math.floor(word / 65536);
}

/** The x axis of a packed stick word: its low 16 bits, signed. */
//@ ensures isInt16(\result)
export function unpackX(word: number): number {
  const low = word - Math.floor(word / 65536) * 65536;
  return low >= 32768 ? low - 65536 : low;
}

/** Two stick axes as one word: x in the low 16 bits, y in the high 16. */
//@ requires isInt16(x) && isInt16(y)
//@ ensures isInt32(\result)
//@ ensures unpackX(\result) === x
//@ ensures unpackY(\result) === y
export function packStick(x: number, y: number): number {
  return (x < 0 ? x + 65536 : x) + y * 65536;
}

/** Every field of the input fits its place in the packet. */
export function validInput(input: WireInput): boolean {
  return isInt32(input.buttons) && isInt16(input.lx) && isInt16(input.ly) && isInt16(input.cx) && isInt16(input.cy);
}

/** Every field of the record fits its place in a packet for `frame`. */
export function validRecord(frame: number, r: FrameInput): boolean {
  return (
    isInt32(frame - r.frame) && isInt32(r.buttons) && isInt16(r.lx) && isInt16(r.ly) && isInt16(r.cx) && isInt16(r.cy)
  );
}

/** The two inputs press the same buttons and hold the sticks in the same place. */
export function inputEqual(a: WireInput, b: WireInput): boolean {
  return a.buttons === b.buttons && a.lx === b.lx && a.ly === b.ly && a.cx === b.cx && a.cy === b.cy;
}

export function sameRecord(a: FrameInput, b: FrameInput): boolean {
  return (
    a.frame === b.frame && a.buttons === b.buttons && a.lx === b.lx && a.ly === b.ly && a.cx === b.cx && a.cy === b.cy
  );
}

/** The redundancy record whose four words start at `base`. */
//@ requires 0 <= base && base + 4 <= words.length
export function recordAt(words: number[], base: number): FrameInput {
  return {
    frame: words[0]! - words[base]!,
    buttons: words[base + 1]!,
    lx: unpackX(words[base + 2]!),
    ly: unpackY(words[base + 2]!),
    cx: unpackX(words[base + 3]!),
    cy: unpackY(words[base + 3]!),
  };
}

/**
 * The words of a packet. Every word is a 32-bit signed integer, so an
 * `Int32Array` holds the result unchanged.
 */
//@ requires isInt32(frame) && isInt32(ackFrame) && validInput(input)
//@ requires redundant.length <= 2147483647
//@ requires forall(k: nat, k < redundant.length ==> validRecord(frame, redundant[k]))
//@ ensures \result.length === 6 + 4 * redundant.length
//@ ensures \result[0] === frame && \result[1] === input.buttons
//@ ensures \result[2] === packStick(input.lx, input.ly) && \result[3] === packStick(input.cx, input.cy)
//@ ensures \result[4] === ackFrame && \result[5] === redundant.length
//@ ensures unpackX(\result[2]) === input.lx && unpackY(\result[2]) === input.ly
//@ ensures unpackX(\result[3]) === input.cx && unpackY(\result[3]) === input.cy
//@ ensures forall(j: nat, j < \result.length ==> isInt32(\result[j]))
//@ ensures forall(k: nat, k < redundant.length ==> sameRecord(recordAt(\result, 6 + 4 * k), redundant[k]))
export function encodeWords(frame: number, input: WireInput, ackFrame: number, redundant: FrameInput[]): number[] {
  const lstick = packStick(input.lx, input.ly);
  const cstick = packStick(input.cx, input.cy);
  //@ assert isInt32(lstick) && unpackX(lstick) === input.lx && unpackY(lstick) === input.ly
  //@ assert isInt32(cstick) && unpackX(cstick) === input.cx && unpackY(cstick) === input.cy
  const words: number[] = [frame, input.buttons, lstick, cstick, ackFrame, redundant.length];
  let i = 0;
  while (i < redundant.length) {
    //@ invariant 0 <= i && i <= redundant.length
    //@ invariant words.length === 6 + 4 * i
    //@ invariant words[0] === frame && words[1] === input.buttons
    //@ invariant words[2] === lstick && words[3] === cstick
    //@ invariant words[4] === ackFrame && words[5] === redundant.length
    //@ invariant forall(j: nat, j < words.length ==> isInt32(words[j]))
    //@ invariant forall(k: nat, k < i ==> sameRecord(recordAt(words, 6 + 4 * k), redundant[k]))
    //@ decreases redundant.length - i
    const r = redundant[i]!;
    const rl = packStick(r.lx, r.ly);
    const rc = packStick(r.cx, r.cy);
    //@ assert isInt32(rl) && unpackX(rl) === r.lx && unpackY(rl) === r.ly
    //@ assert isInt32(rc) && unpackX(rc) === r.cx && unpackY(rc) === r.cy
    //@ ghost let before = words
    words.push(frame - r.frame, r.buttons, rl, rc);
    //@ assert words.length === before.length + 4
    //@ assert forall(j: nat, j < before.length ==> words[j] === before[j])
    //@ assert words[6 + 4 * i] === frame - r.frame && words[6 + 4 * i + 1] === r.buttons
    //@ assert words[6 + 4 * i + 2] === rl && words[6 + 4 * i + 3] === rc
    //@ assert sameRecord(recordAt(words, 6 + 4 * i), r)
    //@ assert forall(k: nat, k < i ==> sameRecord(recordAt(before, 6 + 4 * k), redundant[k]))
    //@ assert forall(k: nat, k < i ==> sameRecord(recordAt(words, 6 + 4 * k), redundant[k]))
    i = i + 1;
  }
  return words;
}

/**
 * Read a packet of at least six words. Records are read while redCount and
 * the packet length both allow another whole one.
 */
//@ requires words.length >= 6
//@ ensures \result.frame === words[0] && \result.buttons === words[1]
//@ ensures \result.lx === unpackX(words[2]) && \result.ly === unpackY(words[2])
//@ ensures \result.cx === unpackX(words[3]) && \result.cy === unpackY(words[3])
//@ ensures \result.ackFrame === words[4]
//@ ensures 6 + 4 * \result.redundant.length <= words.length
//@ ensures words[5] >= 0 ==> \result.redundant.length <= words[5]
//@ ensures words[5] < 0 ==> \result.redundant.length === 0
//@ ensures words[5] >= 0 && 6 + 4 * words[5] <= words.length ==> \result.redundant.length === words[5]
//@ ensures forall(k: nat, k < \result.redundant.length ==> sameRecord(\result.redundant[k], recordAt(words, 6 + 4 * k)))
export function decodeWords(words: number[]): DecodedWords {
  const count = words[5]!;
  const redundant: FrameInput[] = [];
  let i = 0;
  while (i < count && 6 + 4 * i + 4 <= words.length) {
    //@ invariant 0 <= i && redundant.length === i
    //@ invariant 6 + 4 * i <= words.length
    //@ invariant count >= 0 ==> i <= count
    //@ invariant count < 0 ==> i === 0
    //@ invariant forall(k: nat, k < i ==> sameRecord(redundant[k], recordAt(words, 6 + 4 * k)))
    //@ decreases words.length - 4 * i
    const record = recordAt(words, 6 + 4 * i);
    //@ ghost let before = redundant
    redundant.push(record);
    //@ assert redundant.length === i + 1 && redundant[i] === record
    //@ assert forall(k: nat, k < i ==> redundant[k] === before[k])
    i = i + 1;
  }
  return {
    frame: words[0]!,
    buttons: words[1]!,
    lx: unpackX(words[2]!),
    ly: unpackY(words[2]!),
    cx: unpackX(words[3]!),
    cy: unpackY(words[3]!),
    ackFrame: words[4]!,
    redundant,
  };
}

/**
 * Decoding an encoded packet gives back what was encoded. This function is
 * the statement of the round trip; its contract is what the verifier checks.
 */
//@ requires isInt32(frame) && isInt32(ackFrame) && validInput(input)
//@ requires redundant.length <= 2147483647
//@ requires forall(k: nat, k < redundant.length ==> validRecord(frame, redundant[k]))
//@ ensures \result.frame === frame && \result.buttons === input.buttons && \result.ackFrame === ackFrame
//@ ensures \result.lx === input.lx && \result.ly === input.ly && \result.cx === input.cx && \result.cy === input.cy
//@ ensures \result.redundant.length === redundant.length
//@ ensures forall(k: nat, k < redundant.length ==> sameRecord(\result.redundant[k], redundant[k]))
export function decodeOfEncode(
  frame: number,
  input: WireInput,
  ackFrame: number,
  redundant: FrameInput[],
): DecodedWords {
  const words = encodeWords(frame, input, ackFrame, redundant);
  const decoded = decodeWords(words);
  //@ assert decoded.redundant.length === redundant.length
  //@ assert forall(k: nat, k < redundant.length ==> sameRecord(decoded.redundant[k], recordAt(words, 6 + 4 * k)))
  //@ assert forall(k: nat, k < redundant.length ==> sameRecord(recordAt(words, 6 + 4 * k), redundant[k]))
  return decoded;
}

// ── Byte layer (not verified) ────────────────────────────────────────────

/** A decoded packet as the engines read it. */
export interface DecodedInput extends WireInput {
  frame: number;
  ackFrame: number;
  /** Present only when the packet says it carries redundancy records. */
  redundant?: FrameInput[];
}

/**
 * What a buffer of fewer than four words decodes to. No encoder sends one;
 * the fields its missing words would have filled are `undefined`, as they
 * were in the plain-JavaScript decoder, and the engine drops the packet
 * because its frame is not a number.
 */
export interface ShortPacket {
  frame: number | undefined;
  buttons: number | undefined;
  lx: number;
  ly: number;
  cx: number;
  cy: number;
  ackFrame: number;
}

// The integer conversions an `Int32Array` store and the old `x & 0xffff`
// stick packing applied to whatever they were given. Applying them here
// first puts every value in the range the word layer requires, and leaves
// the bytes exactly as the previous code produced them for any argument.
//@ skip
const toInt32 = (v: number): number => v | 0;
//@ skip
const toInt16 = (v: number): number => (v << 16) >> 16;

/**
 * Encode one input packet. `redundantFrames` are earlier frames of the same
 * player to repeat in the packet.
 */
//@ skip
export function encodeInput(
  frame: number,
  input: WireInput,
  ackFrame: number = -1,
  redundantFrames: readonly FrameInput[] | null = null,
): Int32Array<ArrayBuffer> {
  const headerFrame = toInt32(frame);
  const redundant: FrameInput[] = [];
  if (redundantFrames) {
    for (const r of redundantFrames) {
      redundant.push({
        // The word written is int32(frame - r.frame), from the values as
        // given; this is the record frame that makes the word layer write it.
        frame: headerFrame - toInt32(frame - r.frame),
        buttons: toInt32(r.buttons),
        lx: toInt16(r.lx),
        ly: toInt16(r.ly),
        cx: toInt16(r.cx),
        cy: toInt16(r.cy),
      });
    }
  }
  const words = encodeWords(
    headerFrame,
    {
      buttons: toInt32(input.buttons),
      lx: toInt16(input.lx),
      ly: toInt16(input.ly),
      cx: toInt16(input.cx),
      cy: toInt16(input.cy),
    },
    toInt32(ackFrame),
    redundant,
  );
  return new Int32Array(words);
}

/**
 * Decode one input packet from the `ArrayBuffer` a DataChannel delivered.
 * Throws a `RangeError` if its length is not a whole number of words.
 */
//@ skip
export function decodeInput(buf: ArrayBuffer): DecodedInput | ShortPacket {
  const arr = new Int32Array(buf);
  if (arr.length < 6) {
    // The older 4- and 5-word packets, and anything shorter.
    const lstick = arr[2] ?? 0;
    const cstick = arr[3] ?? 0;
    return {
      frame: arr[0],
      buttons: arr[1],
      lx: unpackX(lstick),
      ly: unpackY(lstick),
      cx: unpackX(cstick),
      cy: unpackY(cstick),
      ackFrame: arr[4] ?? -1,
    };
  }
  const words = decodeWords(Array.from(arr));
  const out: DecodedInput = {
    frame: words.frame,
    buttons: words.buttons,
    lx: words.lx,
    ly: words.ly,
    cx: words.cx,
    cy: words.cy,
    ackFrame: words.ackFrame,
  };
  const count = arr[5];
  if (count !== undefined && count > 0) out.redundant = words.redundant;
  return out;
}
