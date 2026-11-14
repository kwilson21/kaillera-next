import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WireInput } from '../../web/src/input-wire.ts';
import {
  guestPacket,
  guestSends,
  isInputPacket,
  readGuestPacket,
  type ChannelMessage,
} from '../../web/src/streaming/input.ts';
import type { Slot } from '../../web/src/streaming/roster.ts';
import { lcg, loadShared, plain } from './load-shared.ts';

// ── the engine's own code, kept as an oracle ─────────────────────────────────
// web/static/netplay-streaming.js at this commit, with the engine's variables
// turned into parameters. `shared` is the codec built into web/static/shared.js
// (no bundle loaded), which is what KNShared.encodeInput / decodeInput were
// before input-wire.ts.
const shared = loadShared();

type Peer = { slot: Slot; channel: string | undefined };

/** `sendGuestInput` (lines 1186-1204): the buffer handed to the host's channel, or null. */
const oldGuestSend = (force: boolean, localInput: WireInput, lastSent: WireInput, peers: readonly Peer[]) => {
  if (!force && shared.inputEqual(localInput, lastSent)) return null;
  const hostPeer = peers.find((p) => p.slot === 0);
  if (hostPeer?.channel === 'open') return shared.encodeInput(0, localInput).buffer;
  return null;
};

/** `ch.onmessage` (lines 719-744): the slot and input handed to applyInputForSlot, or null. */
const oldReceive = (playerSlot: Slot, peer: { slot: Slot } | undefined, data: ChannelMessage) => {
  if (playerSlot !== 0) return null;
  if (!peer || peer.slot === null || peer.slot === undefined) return null;
  if (data instanceof ArrayBuffer && data.byteLength >= 16 && data.byteLength % Int32Array.BYTES_PER_ELEMENT === 0) {
    const decoded = shared.decodeInput(data);
    return {
      slot: peer.slot,
      input: { buttons: decoded.buttons, lx: decoded.lx, ly: decoded.ly, cx: decoded.cx, cy: decoded.cy },
    };
  }
  return null;
};

const randomInput = (next: () => number): WireInput => ({
  buttons: next() % 3 === 0 ? 0 : next() | 0,
  lx: (next() % 200) - 100,
  ly: (next() % 200) - 100,
  cx: (next() % 70000) - 35000,
  cy: (next() % 200) - 100,
});

const SLOTS: readonly Slot[] = [0, 1, 2, 3, null, undefined];
const CHANNELS = ['open', 'connecting', 'closing', 'closed', undefined];

test("a guest's packet is the shared format's smallest shape: frame 0, no ack, no redundancy", () => {
  const packet = guestPacket({ buttons: 0x8001, lx: -83, ly: 83, cx: 5, cy: -5 });
  assert.equal(packet.byteLength, 24);
  assert.deepEqual([packet[0], packet[1], packet[4], packet[5]], [0, 0x8001, -1, 0]);
});

test('the guest sends when the engine does, and the same bytes', () => {
  const next = lcg(31);
  let sent = 0;
  for (let round = 0; round < 5000; round++) {
    const input = randomInput(next);
    const last = next() % 3 === 0 ? { ...input } : randomInput(next);
    const peers = Array.from({ length: next() % 4 }, () => ({
      slot: SLOTS[next() % SLOTS.length],
      channel: CHANNELS[next() % CHANNELS.length],
    }));
    const force = next() % 2 === 0;
    const old = oldGuestSend(force, input, last, peers);
    assert.equal(guestSends(force, input, last, peers), old !== null, JSON.stringify({ force, input, last, peers }));
    if (old === null) continue;
    sent += 1;
    assert.deepEqual(Array.from(guestPacket(input)), Array.from(new Int32Array(plain(old))));
  }
  assert.ok(sent > 200, `only ${sent} rounds sent`);
});

test('the host applies from a message what the engine applies, to the same port', () => {
  const next = lcg(37);
  const junk: readonly ChannelMessage[] = ['ready', '', new Uint8Array(24), new ArrayBuffer(0), new ArrayBuffer(12)];
  let applied = 0;
  for (let round = 0; round < 5000; round++) {
    const bytes = next() % 6 === 0 ? next() % 40 : 4 * (next() % 12);
    const buffer = new ArrayBuffer(bytes);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < view.length; i++) view[i] = next() & 0xff;
    const guest = Array.from(guestPacket(randomInput(next)));
    const real = new Int32Array(guest).buffer;
    const pick = next() % 10;
    const data = pick < 5 ? real : pick < 9 ? buffer : (junk[next() % junk.length] ?? '');
    const mySlot = next() % 8 === 0 ? SLOTS[next() % SLOTS.length] : 0;
    const peer = next() % 8 === 0 ? undefined : { slot: SLOTS[next() % SLOTS.length] };
    const old = oldReceive(mySlot, peer, data);
    assert.deepEqual(readGuestPacket(mySlot, peer?.slot, data), plain(old), `${bytes} bytes`);
    if (old !== null) applied += 1;
  }
  assert.ok(applied > 1500, `only ${applied} rounds applied`);
});

test('what a guest sends is what the host applies', () => {
  const next = lcg(41);
  for (let round = 0; round < 2000; round++) {
    const input = randomInput(next);
    // The stick is carried in 16 bits; the generator stays inside them except for cx.
    const carried = { ...input, cx: (input.cx << 16) >> 16 };
    assert.deepEqual(readGuestPacket(0, 2, guestPacket(input).buffer), { slot: 2, input: carried });
  }
});

test('only whole-word buffers of four words or more are packets', () => {
  for (let bytes = 0; bytes < 64; bytes++) {
    assert.equal(isInputPacket(new ArrayBuffer(bytes)), bytes >= 16 && bytes % 4 === 0, `${bytes} bytes`);
  }
  assert.equal(isInputPacket('0000000000000000'), false);
  assert.equal(isInputPacket(new Uint8Array(24)), false);
});

test('a spectator, or anyone when this page is not the host, has no port to write to', () => {
  const packet = guestPacket({ buttons: 1, lx: 0, ly: 0, cx: 0, cy: 0 }).buffer;
  assert.equal(readGuestPacket(0, null, packet), null);
  assert.equal(readGuestPacket(0, undefined, packet), null);
  assert.equal(readGuestPacket(1, 2, packet), null);
  assert.equal(readGuestPacket(null, 2, packet), null);
});
