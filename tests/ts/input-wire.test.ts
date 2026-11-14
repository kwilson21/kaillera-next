import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeInput,
  decodeOfEncode,
  decodeWords,
  encodeInput,
  encodeWords,
  isInt16,
  isInt32,
  packStick,
  unpackX,
  unpackY,
  validInput,
  validRecord,
  type DecodedInput,
  type FrameInput,
  type WireInput,
} from '../../web/src/input-wire.ts';
import { createHash } from 'node:crypto';
import { createShared } from '../../web/src/page/shared.ts';
import { lcg, type EncodeArgs } from './load-shared.ts';

interface EncodeVector {
  name: string;
  args: EncodeArgs;
  hex: string;
  decoded: object;
}
interface DecodeVector {
  name: string;
  hex: string;
  decoded: object;
}

const toHex = (a: Int32Array): string => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('hex');
const fromHex = (hex: string): ArrayBuffer => {
  const bytes = Buffer.from(hex, 'hex');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};
// Captured from web/static/shared.js at 241d4a4, before it delegated to this
// module: the bytes encodeInput produced for `args`, and what decodeInput
// made of them. Native byte order, which is little-endian wherever this runs.
const ENCODE_VECTORS: EncodeVector[] = [
  {
    name: 'zero',
    args: [0, { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 }],
    hex: '00000000000000000000000000000000ffffffff00000000',
    decoded: { frame: 0, buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0, ackFrame: -1 },
  },
  {
    name: 'typical',
    args: [1234, { buttons: 32769, lx: 83, ly: -83, cx: -40, cy: 17 }, 1230],
    hex: 'd2040000018000005300adffd8ff1100ce04000000000000',
    decoded: { frame: 1234, buttons: 32769, lx: 83, ly: -83, cx: -40, cy: 17, ackFrame: 1230 },
  },
  {
    name: 'default ack',
    args: [7, { buttons: 16777215, lx: -83, ly: 83, cx: 83, cy: -83 }],
    hex: '07000000ffffff00adff53005300adffffffffff00000000',
    decoded: { frame: 7, buttons: 16777215, lx: -83, ly: 83, cx: 83, cy: -83, ackFrame: -1 },
  },
  {
    name: 'null redundancy',
    args: [600, { buttons: 9, lx: 1, ly: -1, cx: 0, cy: 0 }, 598, null],
    hex: '58020000090000000100ffff000000005602000000000000',
    decoded: { frame: 600, buttons: 9, lx: 1, ly: -1, cx: 0, cy: 0, ackFrame: 598 },
  },
  {
    name: 'empty redundancy',
    args: [600, { buttons: 9, lx: 1, ly: -1, cx: 0, cy: 0 }, 598, []],
    hex: '58020000090000000100ffff000000005602000000000000',
    decoded: { frame: 600, buttons: 9, lx: 1, ly: -1, cx: 0, cy: 0, ackFrame: 598 },
  },
  {
    name: 'int16 extremes',
    args: [2147483647, { buttons: -2147483648, lx: -32768, ly: 32767, cx: 32767, cy: -32768 }, -1],
    hex: 'ffffff7f000000800080ff7fff7f0080ffffffff00000000',
    decoded: { frame: 2147483647, buttons: -2147483648, lx: -32768, ly: 32767, cx: 32767, cy: -32768, ackFrame: -1 },
  },
  {
    name: 'minus one sticks',
    args: [5, { buttons: 1, lx: -1, ly: -1, cx: -1, cy: 0 }, 4],
    hex: '0500000001000000ffffffffffff00000400000000000000',
    decoded: { frame: 5, buttons: 1, lx: -1, ly: -1, cx: -1, cy: 0, ackFrame: 4 },
  },
  {
    name: 'redundant x3',
    args: [
      1000,
      { buttons: 16, lx: 10, ly: -20, cx: 30, cy: -40 },
      995,
      [
        { frame: 999, buttons: 48, lx: 11, ly: -21, cx: 0, cy: 0 },
        { frame: 998, buttons: 0, lx: -83, ly: 83, cx: -1, cy: 1 },
        { frame: 990, buttons: 8388608, lx: 0, ly: 0, cx: 83, cy: -83 },
      ],
    ],
    hex: 'e8030000100000000a00ecff1e00d8ffe30300000300000001000000300000000b00ebff000000000200000000000000adff5300ffff01000a00000000008000000000005300adff',
    decoded: {
      frame: 1000,
      buttons: 16,
      lx: 10,
      ly: -20,
      cx: 30,
      cy: -40,
      ackFrame: 995,
      redundant: [
        { frame: 999, buttons: 48, lx: 11, ly: -21, cx: 0, cy: 0 },
        { frame: 998, buttons: 0, lx: -83, ly: 83, cx: -1, cy: 1 },
        { frame: 990, buttons: 8388608, lx: 0, ly: 0, cx: 83, cy: -83 },
      ],
    },
  },
  {
    name: 'out of range sticks wrap',
    args: [3, { buttons: 2, lx: 40000, ly: -40000, cx: 65536, cy: 98765 }, 2],
    hex: '0300000002000000409cc0630000cd810200000000000000',
    decoded: { frame: 3, buttons: 2, lx: -25536, ly: 25536, cx: 0, cy: -32307, ackFrame: 2 },
  },
  {
    name: 'fractional sticks truncate',
    args: [3, { buttons: 2, lx: 12.9, ly: -12.9, cx: 0.5, cy: -0.5 }, 2],
    hex: '03000000020000000c00f4ff000000000200000000000000',
    decoded: { frame: 3, buttons: 2, lx: 12, ly: -12, cx: 0, cy: 0, ackFrame: 2 },
  },
  {
    name: 'buttons above 32 bits wrap',
    args: [3, { buttons: 4294967297, lx: 0, ly: 0, cx: 0, cy: 0 }, 2],
    hex: '030000000100000000000000000000000200000000000000',
    decoded: { frame: 3, buttons: 1, lx: 0, ly: 0, cx: 0, cy: 0, ackFrame: 2 },
  },
];

const DECODE_VECTORS: DecodeVector[] = [
  {
    name: 'legacy 4 words',
    hex: '0a00000003000000fbff05000080ff7f',
    decoded: { frame: 10, buttons: 3, lx: -5, ly: 5, cx: -32768, cy: 32767, ackFrame: -1 },
  },
  {
    name: 'legacy 5 words',
    hex: '0a00000003000000fbff05000000000008000000',
    decoded: { frame: 10, buttons: 3, lx: -5, ly: 5, cx: 0, cy: 0, ackFrame: 8 },
  },
  {
    name: 'redCount 0',
    hex: '0a0000000300000001000000020000000800000000000000',
    decoded: { frame: 10, buttons: 3, lx: 1, ly: 0, cx: 2, cy: 0, ackFrame: 8 },
  },
  {
    name: 'redCount negative',
    hex: '0a00000003000000010000000200000008000000feffffff',
    decoded: { frame: 10, buttons: 3, lx: 1, ly: 0, cx: 2, cy: 0, ackFrame: 8 },
  },
  {
    name: 'redCount larger than the packet',
    hex: '0a0000000300000001000000020000000800000003000000010000000400000002000100fcff03000200000005000000',
    decoded: {
      frame: 10,
      buttons: 3,
      lx: 1,
      ly: 0,
      cx: 2,
      cy: 0,
      ackFrame: 8,
      redundant: [{ frame: 9, buttons: 4, lx: 2, ly: 1, cx: -4, cy: 3 }],
    },
  },
  {
    name: 'redCount positive, no full record',
    hex: '0a00000003000000010000000200000008000000010000000100000002000000',
    decoded: { frame: 10, buttons: 3, lx: 1, ly: 0, cx: 2, cy: 0, ackFrame: 8, redundant: [] },
  },
  {
    name: 'trailing words beyond redCount',
    hex: '0a0000000300000001000000020000000800000001000000010000000400000005000000060000006300000062000000',
    decoded: {
      frame: 10,
      buttons: 3,
      lx: 1,
      ly: 0,
      cx: 2,
      cy: 0,
      ackFrame: 8,
      redundant: [{ frame: 9, buttons: 4, lx: 5, ly: 0, cx: 6, cy: 0 }],
    },
  },
  {
    name: 'empty',
    hex: '',
    decoded: { frame: undefined, buttons: undefined, lx: 0, ly: 0, cx: 0, cy: 0, ackFrame: -1 },
  },
  {
    name: 'two words',
    hex: '0a00000003000000',
    decoded: { frame: 10, buttons: 3, lx: 0, ly: 0, cx: 0, cy: 0, ackFrame: -1 },
  },
];

test('encodeInput produces the bytes the plain-JavaScript encoder did', () => {
  for (const v of ENCODE_VECTORS) {
    assert.equal(toHex(encodeInput(...v.args)), v.hex, v.name);
  }
});

test('decodeInput reads packets the way the plain-JavaScript decoder did', () => {
  for (const v of [...ENCODE_VECTORS, ...DECODE_VECTORS]) {
    assert.deepStrictEqual(decodeInput(fromHex(v.hex)), v.decoded, v.name);
  }
});

test('a packet without redundancy has no redundant field at all', () => {
  assert.equal('redundant' in decodeInput(encodeInput(1, { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 }).buffer), false);
});

test('decodeInput rejects a buffer that is not whole words, as before', () => {
  assert.throws(() => decodeInput(new ArrayBuffer(7)), RangeError);
});

// ── The plain-JavaScript codec this module replaced ───────────────────────

const AWKWARD = [0, 1, -1, 83, -83, 127, -128, 32767, -32768, 32768, 65535, 65536, -65537, 2147483647, -2147483648];

// The digest of what web/static/shared.js's own encoder and decoder produced
// for the cases below, taken from that script at d7dc88c, the last commit
// that had it. This module was compared with it case by case until then.
const LEGACY_CODEC_DIGEST = 'bd29e04fe96581ee8cd568d005ba28ae3aab2a44b13c7ff8f7a18a332c4148e8';

test('random packets encode and decode exactly as the plain-JavaScript codec did', () => {
  const hash = createHash('sha256');
  const next = lcg(20261113);
  const pick = (): number => {
    const r = next();
    // A third of the values are the awkward ones, the rest any 32-bit value
    // or a small one near the range gameplay uses.
    if (r % 3 === 0) return AWKWARD[(r >>> 8) % AWKWARD.length]!;
    return r % 3 === 1 ? next() | 0 : ((next() >>> 4) % 400) - 200;
  };
  const input = (): WireInput => ({ buttons: pick(), lx: pick(), ly: pick(), cx: pick(), cy: pick() });
  for (let n = 0; n < 5000; n++) {
    const frame = pick();
    const redundant: FrameInput[] = [];
    for (let k = next() % 5; k > 0; k--) redundant.push({ frame: frame - (next() % 40), ...input() });
    const args: EncodeArgs = [frame, input(), pick(), redundant.length > 0 || n % 2 === 0 ? redundant : null];
    const encoded = encodeInput(...args);
    hash.update(toHex(encoded));
    hash.update(JSON.stringify(decodeInput(encoded.buffer)));
  }

  // Any words at all, including lengths and counts no encoder produces.
  for (let n = 0; n < 5000; n++) {
    const words = Array.from({ length: next() % 24 }, () => (next() % 4 === 0 ? (next() % 9) - 2 : next() | 0));
    hash.update(JSON.stringify(decodeInput(Int32Array.from(words).buffer)));
  }
  assert.equal(hash.digest('hex'), LEGACY_CODEC_DIGEST);
});

test('KNShared carries this codec itself', () => {
  const shared = createShared();
  assert.equal(shared.encodeInput, encodeInput);
  assert.equal(shared.decodeInput, decodeInput);
  // Called with defaults left out, the way the engines call it.
  assert.equal(toHex(shared.encodeInput(7, ENCODE_VECTORS[2]!.args[1])), ENCODE_VECTORS[2]!.hex);
});

// ── Round trips over the whole range ──────────────────────────────────────

test('every stick value the format can carry survives a pack and unpack', () => {
  // The two axes do not interact, so each is swept in full against a set of
  // values for the other, rather than all 2^32 pairs.
  const others = [0, 1, -1, 83, -83, 255, -256, 32767, -32768];
  for (let v = -32768; v <= 32767; v++) {
    for (const o of others) {
      const xw = packStick(v, o);
      if (unpackX(xw) !== v || unpackY(xw) !== o || !isInt32(xw)) assert.fail(`x=${v} y=${o} word=${xw}`);
      const yw = packStick(o, v);
      if (unpackX(yw) !== o || unpackY(yw) !== v || !isInt32(yw)) assert.fail(`x=${o} y=${v} word=${yw}`);
    }
  }
});

test('the arithmetic stick packing is the bit packing it replaced', () => {
  const bitPack = (x: number, y: number): number => (x & 0xffff) | ((y & 0xffff) << 16);
  const bitX = (word: number): number => (word << 16) >> 16;
  const bitY = (word: number): number => word >> 16;
  const others = [0, 1, -1, 83, -83, 32767, -32768];
  for (let v = -32768; v <= 32767; v++) {
    for (const o of others) {
      if (packStick(v, o) !== bitPack(v, o)) assert.fail(`pack x=${v} y=${o}`);
      if (packStick(o, v) !== bitPack(o, v)) assert.fail(`pack x=${o} y=${v}`);
    }
  }
  // Every low half against a set of high halves, and the reverse: each
  // unpack reads one half, whatever the other holds.
  const halves = [0, 1, 0x7fff, 0x8000, 0xffff, 0x1234, 0xfedc];
  for (let v = 0; v <= 0xffff; v++) {
    for (const o of halves) {
      const a = (o << 16) | v;
      const b = (v << 16) | o;
      if (unpackX(a) !== bitX(a) || unpackY(a) !== bitY(a)) assert.fail(`unpack word=${a}`);
      if (unpackX(b) !== bitX(b) || unpackY(b) !== bitY(b)) assert.fail(`unpack word=${b}`);
    }
  }
});

test('every gameplay stick position round-trips through the bytes', () => {
  // The N64 range is -83..83 on each axis; sweep a margin beyond it.
  for (let x = -128; x <= 127; x++) {
    for (let y = -128; y <= 127; y++) {
      const out = decodeInput(encodeInput(9, { buttons: 0, lx: x, ly: y, cx: y, cy: x }).buffer);
      if (out.lx !== x || out.ly !== y || out.cx !== y || out.cy !== x) assert.fail(`x=${x} y=${y}`);
    }
  }
});

test('every button bit and every 32-bit pattern sampled round-trips', () => {
  const stick = { lx: 0, ly: 0, cx: 0, cy: 0 };
  const check = (buttons: number): void => {
    assert.equal(decodeInput(encodeInput(1, { buttons, ...stick }).buffer).buttons, buttons);
  };
  for (let bit = 0; bit < 32; bit++) {
    check((1 << bit) | 0);
    check(~(1 << bit));
  }
  // All 2^16 patterns of the low and of the high half of the N64 mask
  // (bits 0-23), each with the other half clear and set.
  for (let v = 0; v <= 0xffff; v++) {
    check(v);
    check(v | 0xff0000);
  }
  for (let v = 0; v <= 0xff; v++) {
    check(v << 16);
    check((v << 16) | 0xffff);
  }
  const next = lcg(64);
  for (let n = 0; n < 20000; n++) check(next() | 0);
});

test('frames, acks and redundancy records round-trip', () => {
  const next = lcg(7);
  const axis = (): number => (next() % 65536) - 32768;
  const input = (): WireInput => ({ buttons: next() | 0, lx: axis(), ly: axis(), cx: axis(), cy: axis() });
  for (let n = 0; n < 3000; n++) {
    const frame = next() % 2000000;
    const ackFrame = (next() % 2000001) - 1;
    const redundant: FrameInput[] = [];
    for (let k = next() % 31; k > 0; k--) redundant.push({ frame: frame - 1 - (next() % 300), ...input() });
    const sent = input();
    assert.ok(validInput(sent) && redundant.every((r) => validRecord(frame, r)));

    const expected: DecodedInput = { frame, ...sent, ackFrame };
    if (redundant.length > 0) expected.redundant = redundant;
    assert.deepStrictEqual(decodeInput(encodeInput(frame, sent, ackFrame, redundant).buffer), expected);

    // The word layer on its own, and the function that carries the proof.
    const words = encodeWords(frame, sent, ackFrame, redundant);
    assert.equal(words.length, 6 + 4 * redundant.length);
    assert.ok(words.every((w) => Number.isInteger(w) && isInt32(w)));
    assert.deepStrictEqual(decodeWords(words), { frame, ...sent, ackFrame, redundant });
    assert.deepStrictEqual(decodeOfEncode(frame, sent, ackFrame, redundant), { frame, ...sent, ackFrame, redundant });
  }
});

test('range predicates sit on the exact boundaries', () => {
  assert.ok(isInt16(-32768) && isInt16(32767) && !isInt16(-32769) && !isInt16(32768));
  assert.ok(isInt32(-2147483648) && isInt32(2147483647) && !isInt32(-2147483649) && !isInt32(2147483648));
});
