/**
 * What a message does to the streaming engine's connections: a relayed
 * WebRTC signal, a late joiner saying it is ready, a data channel opening,
 * a connection failing. Each is the rule web/static/netplay-streaming.js
 * applies today (onWebRTCSignal, onDataMessage, setupDataChannel's onOpen,
 * onconnectionstatechange). The engine still decides; observe.ts compares.
 */
import { signalDisposition } from '../peer-signaling.ts';
import { checkRelayed, type Relayed } from '../relay.ts';
import { HOST_SLOT, type Connection, type Slot } from './roster.ts';

export type SignalKind = 'offer' | 'answer' | 'candidate' | 'none';

/** Which part of a `webrtc-signal` the engine reads: the first of offer, answer, candidate that is set. */
export const signalKind = (signal: {
  readonly offer?: unknown;
  readonly answer?: unknown;
  readonly candidate?: unknown;
}): SignalKind => {
  if (signal.offer) return 'offer';
  if (signal.answer) return 'answer';
  return signal.candidate ? 'candidate' : 'none';
};

export interface SignalAction {
  /** Make a connection for the sender first (an offer from a page this one holds none for). */
  readonly create: boolean;
  /** The slot a connection made here gets: the roster's, null for a sender not on it. */
  readonly slot: number | null;
  /** What is then handed to the connection; `none` when there is nothing to hand it to. */
  readonly act: SignalKind;
}

/**
 * What an incoming WebRTC signal does.
 *
 * The table rule is the rollback engine's (`signalDisposition`) with its two
 * reconnect inputs off, and that is where streaming differs: an offer for a
 * connection that exists is always applied to it as a renegotiation, never
 * taken as a replacement, and the offer's `reconnect` flag is not read. Any
 * page's offer is answered, including one the roster does not list.
 *
 * @param hasSender  the server said who sent it
 * @param hasEntry   a connection for the sender exists
 * @param knownSlot  the sender's slot on the roster; undefined when not on it
 */
export const signalAction = (
  hasSender: boolean,
  kind: SignalKind,
  hasEntry: boolean,
  knownSlot: Slot,
): SignalAction => {
  const nothing: SignalAction = { create: false, slot: null, act: 'none' };
  if (!hasSender) return nothing;
  const disposition = signalDisposition(kind === 'offer', false, false, hasEntry);
  if (disposition === 'drop') return nothing;
  const create = disposition === 'create';
  return { create, slot: create ? (knownSlot ?? null) : null, act: kind };
};

/** A connection as the late-join rule sees it. */
export interface LateJoinConnection extends Connection {
  /** Its data channel is open, or the connection reports itself connected. */
  readonly linked: boolean;
  /** An offer was already made on it (its local description is one). */
  readonly pendingOffer: boolean;
}

export interface LateJoinReadyInput {
  /** The relayed `data-message`, with the server's sender stamp. */
  readonly message: Relayed;
  readonly mySlot: Slot;
  readonly mySid: string | undefined;
  /** The players on the roster. */
  readonly roster: readonly Connection[];
  readonly connections: readonly LateJoinConnection[];
}

export interface LateJoinReadyAction {
  /** `offer`: make a new offer. `resend`: send the offer already made again. `ignore`: do nothing. */
  readonly act: 'ignore' | 'offer' | 'resend';
  /** Make the connection first. */
  readonly create: boolean;
  /** The slot the sender's connection has afterwards; null when ignored, and for a spectator. */
  readonly slot: number | null;
}

/**
 * What the host does when a page says it is listening for a stream in play
 * (`streaming-late-join-ready`).
 *
 * The sender is the one the server stamped (relay.ts), never the `senderSid`
 * the message carries. A player the roster does not list yet is ignored: the
 * roster that lists them makes the connection, and their next message finds
 * it. A spectator is never on the roster of players and is let through. A
 * sender already linked needs nothing.
 */
export const lateJoinReadyAction = (input: LateJoinReadyInput): LateJoinReadyAction => {
  const ignore: LateJoinReadyAction = { act: 'ignore', create: false, slot: null };
  if (input.message.type !== 'streaming-late-join-ready') return ignore;
  if (input.mySlot !== HOST_SLOT) return ignore;
  const from = checkRelayed(input.message);
  if (!from.allowed || !from.sid || from.sid === input.mySid) return ignore;

  const known = input.roster.find((player) => player.sid === from.sid);
  if (!known && from.slot !== null) return ignore;
  const rosterSlot = known ? (known.slot ?? null) : null;
  const held = input.connections.find((connection) => connection.sid === from.sid);
  if (!held) return { act: 'offer', create: true, slot: rosterSlot };
  if (held.linked) return ignore;
  return { act: held.pendingOffer ? 'resend' : 'offer', create: false, slot: rosterSlot ?? held.slot ?? null };
};

/**
 * `startHost`: the host's first open channel starts its emulator.
 * `addTracks`: the stream is up and this connection has none of it yet; add
 * the tracks and renegotiate. `tracksPresent`: it already carries them.
 * `streamNotReady`: the host is booting; the tracks are added to every
 * connection when capture starts. `startGuestInput`: a guest starts sending
 * input. `spectator`: nothing to send. `none`: the connection is gone.
 */
export type ChannelOpenAction =
  | 'startHost'
  | 'addTracks'
  | 'tracksPresent'
  | 'streamNotReady'
  | 'startGuestInput'
  | 'spectator'
  | 'none';

/** What a data channel opening leads to on this page. */
export const channelOpenAction = (state: {
  readonly mySlot: Slot;
  readonly spectator: boolean;
  /** The host's emulator was started (it may still be booting). */
  readonly running: boolean;
  /** The video is being captured. */
  readonly live: boolean;
  readonly hasEntry: boolean;
  /** The connection already sends a track. */
  readonly hasTracks: boolean;
}): ChannelOpenAction => {
  if (state.mySlot !== HOST_SLOT) return state.spectator ? 'spectator' : 'startGuestInput';
  if (!state.running) return 'startHost';
  if (!state.live) return 'streamNotReady';
  if (!state.hasEntry) return 'none';
  return state.hasTracks ? 'tracksPresent' : 'addTracks';
};

/**
 * Does this connection state end the connection?
 *
 * Streaming has no reconnect of its own, unlike the rollback engine
 * (`disconnectDisposition` in peer-signaling.ts, which retries before a
 * match and reconnects during one): a connection that fails, or that only
 * reports `disconnected`, is closed and forgotten at once. A state change on
 * a connection the table no longer holds is ignored.
 */
export const connectionLost = (state: string, current: boolean): boolean =>
  current && (state === 'failed' || state === 'disconnected');
