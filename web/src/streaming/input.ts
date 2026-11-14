/**
 * The streaming engine's input path: the packet a guest sends, when it sends
 * one, and what the host takes from a packet it receives. The rules are the
 * ones web/static/netplay-streaming.js applies today (sendGuestInput and the
 * data channel's onmessage). The engine still decides; observe.ts compares.
 *
 * The packet is the shared input wire format (input-wire.ts), used in its
 * smallest shape. The rollback engine sends a frame number, an ack and
 * redundancy records with every input; streaming has no frames to agree on,
 * so a guest's packet is always frame 0, ack -1 and no redundancy (6 words,
 * 24 bytes), and the host reads only the buttons and sticks. The channel is
 * unordered and unreliable, and the host applies packets in the order they
 * arrive: nothing in the packet lets it tell a late one from the newest.
 */
import { decodeInput, encodeInput, inputEqual, type WireInput } from '../input-wire.ts';
import { HOST_SLOT, type Slot } from './roster.ts';

/** The frame number every guest packet carries: streaming does not count frames. */
export const GUEST_PACKET_FRAME = 0;

/** The packet a guest sends for its current input. */
export const guestPacket = (input: WireInput): Int32Array<ArrayBuffer> => encodeInput(GUEST_PACKET_FRAME, input);

/**
 * Does the guest send a packet now?
 *
 * The 60 Hz repeat (`force`) sends whatever is held; an input event sends
 * only a change. Either needs an open channel to the host, which is the
 * first connection filed under slot 0.
 */
export const guestSends = (
  force: boolean,
  input: WireInput,
  lastSent: WireInput,
  connections: readonly { readonly slot: Slot; readonly channel: string | undefined }[],
): boolean => {
  if (!force && inputEqual(input, lastSent)) return false;
  return connections.find((connection) => connection.slot === HOST_SLOT)?.channel === 'open';
};

/** What a data channel can deliver. */
export type ChannelMessage = string | ArrayBuffer | Blob | ArrayBufferView;

/**
 * Is this an input packet? Whole 32-bit words, and at least the four of the
 * oldest packet shape: the format has grown twice and may grow again, so no
 * one length is required.
 */
export const isInputPacket = (data: ChannelMessage): data is ArrayBuffer =>
  data instanceof ArrayBuffer && data.byteLength >= 16 && data.byteLength % Int32Array.BYTES_PER_ELEMENT === 0;

/**
 * What the host applies from a message on a guest's channel, and to which
 * controller port; null when it applies nothing.
 *
 * Only the host reads input. The port is the slot the connection is filed
 * under, never anything the packet says, and a spectator's connection has
 * none: whatever a spectator sends is dropped.
 */
export const readGuestPacket = (
  mySlot: Slot,
  peerSlot: Slot,
  data: ChannelMessage,
): { readonly slot: number; readonly input: WireInput } | null => {
  if (mySlot !== HOST_SLOT) return null;
  if (peerSlot === null || peerSlot === undefined) return null;
  if (!isInputPacket(data)) return null;
  const { buttons, lx, ly, cx, cy } = decodeInput(data);
  // A packet of four words or more always has its buttons word.
  if (buttons === undefined) return null;
  return { slot: peerSlot, input: { buttons, lx, ly, cx, cy } };
};
