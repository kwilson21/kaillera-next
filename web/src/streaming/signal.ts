/**
 * What a message does to the streaming engine's connections: a relayed
 * WebRTC signal, a late joiner saying it is ready, a data channel opening,
 * a connection failing. web/static/netplay-streaming.js asks them in
 * onWebRTCSignal, onDataMessage, setupDataChannel's onOpen and
 * onconnectionstatechange, and carries out the answer. Among them: which
 * offers a page that receives the stream takes (`signalGate`), and which
 * connection a signal belongs to (attempt.ts: `offerForConnection`,
 * `answerApplies`, `signalForConnection`).
 */
import { signalDisposition } from '../peer-signaling.ts';
import { checkRelayed, type Relayed } from '../relay.ts';
import { answerApplies, offerForConnection, signalForConnection } from './attempt.ts';
import { offerGate, type OfferGate } from './offer-gate.ts';
import { HOST_SLOT, offersConnections, type Connection, type Slot } from './roster.ts';

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
 * What an incoming WebRTC signal does to the connection table, once the
 * offer gate has let it through (`guardedSignalAction` puts the two
 * together).
 *
 * The table rule is the rollback engine's (`signalDisposition`) with its two
 * reconnect inputs off, and that is where streaming differs: an offer for a
 * connection that exists is always applied to it as a renegotiation, never
 * taken as a replacement, and the offer's `reconnect` flag is not read.
 * Before the gate, this was the whole rule, and any page's offer was
 * answered, including one the roster does not list.
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

/** The roster as the offer gate reads it: the latest `users-updated` the page handled. */
export interface OfferRoster {
  /** The players, by socket id. */
  readonly players: Readonly<Record<string, { readonly slot?: Slot }>>;
  /** The spectators' socket ids. */
  readonly spectators: readonly string[];
}

/** The socket id of the player at slot 0 on the roster; empty when no player holds it. */
export const rosterHostSid = (players: OfferRoster['players']): string =>
  Object.entries(players).find(([, player]) => player.slot === HOST_SLOT)?.[0] ?? '';

/**
 * Does this page take the signal: `offerGate` (offer-gate.ts) read from what
 * the engine holds.
 *
 * A page that is not at slot 0 applies an offer only from the socket its
 * roster places at slot 0, holds one from a sender the roster does not list
 * (no roster yet, or a socket newer than it), and refuses one from any other
 * player or spectator. The host's own page, and every answer and candidate,
 * get `apply`: they are handled as before.
 *
 * @param mySlot  this page's slot
 * @param kind    which part of the signal the engine reads (`signalKind`)
 * @param sender  the socket id the server stamped as the sender
 * @param roster  the page's latest roster
 */
export const signalGate = (mySlot: Slot, kind: SignalKind, sender: string, roster: OfferRoster): OfferGate => {
  const listed = Object.hasOwn(roster.players, sender) || roster.spectators.includes(sender);
  const gate = offerGate(!offersConnections(mySlot), kind === 'offer', sender, rosterHostSid(roster.players), listed);
  return gate === 'hold' || gate === 'refuse' ? gate : 'apply';
};

/**
 * What the engine does with a signal: hand it on as `signalAction` says, or
 * hold it, or refuse it, or drop it as `stale` (it names a connection other
 * than the one it would reach).
 */
export type GuardedAct = SignalKind | 'held' | 'refused' | 'stale';

export interface GuardedSignalAction {
  readonly create: boolean;
  /** Close the connection held for the sender and make a new one first (a newer offer from the host). */
  readonly replace: boolean;
  /** The slot a connection made or remade here gets: the roster's, null for a sender not on it. */
  readonly slot: number | null;
  readonly act: GuardedAct;
}

/** Which connection attempt a signal or a connection belongs to (attempt.ts). */
export interface AttemptName {
  readonly page: string;
  readonly attempt: number;
}

const NAMES_NONE: AttemptName = { page: '', attempt: 0 };

export interface GuardedSignalInput {
  /** The socket id the server stamped as the sender; undefined or empty when it said none. */
  readonly sender: string | undefined;
  readonly kind: SignalKind;
  readonly mySlot: Slot;
  readonly roster: OfferRoster;
  /** A connection for the sender exists. */
  readonly hasEntry: boolean;
  /** An offer from the sender is held, waiting for a roster that places it. */
  readonly offerHeld: boolean;
  /** The attempt the sender's connection belongs to; null when the page holds none, or it names none. */
  readonly held: AttemptName | null;
  /** The attempt the signal names (its `attemptId`); null when it names none. */
  readonly named: AttemptName | null;
  /** The connection held for the sender waits for an answer: its offer is set, no answer yet. */
  readonly awaitingAnswer: boolean;
}

/**
 * What an incoming WebRTC signal does, offer gate included.
 *
 * `held`: an offer the roster cannot place yet, kept (the latest one per
 * sender) until a roster places its sender; at slot 0 it is then handled as
 * if it had just come, anywhere else it is dropped. A candidate that comes
 * while its sender's offer is held, with no connection to give it to, is
 * kept with that offer: the offer was made before it, and an offer applied
 * without its candidates may never connect. `refused`: dropped, and no
 * connection is made.
 *
 * Then which connection it belongs to (attempt.ts). On a page that receives
 * the stream, an offer for a newer connection than the one held replaces it,
 * and one for an older connection is dropped (`stale`); on the host, an
 * answer is taken only by the connection that waits for it, and only when
 * it answers that connection's offer. A candidate reaches only the
 * connection it was gathered for. Everything else is `signalAction`.
 */
export const guardedSignalAction = (input: GuardedSignalInput): GuardedSignalAction => {
  const plain = (action: SignalAction): GuardedSignalAction => ({ ...action, replace: false });
  const { sender } = input;
  if (!sender) return plain(signalAction(false, input.kind, input.hasEntry, undefined));
  const gate = signalGate(input.mySlot, input.kind, sender, input.roster);
  if (gate !== 'apply') return { create: false, replace: false, slot: null, act: gate === 'hold' ? 'held' : 'refused' };
  const receiver = !offersConnections(input.mySlot);
  if (receiver && input.kind === 'candidate' && !input.hasEntry && input.offerHeld) {
    return { create: false, replace: false, slot: null, act: 'held' };
  }
  const knownSlot = Object.hasOwn(input.roster.players, sender) ? input.roster.players[sender]?.slot : undefined;
  const action = plain(signalAction(true, input.kind, input.hasEntry, knownSlot));
  if (action.act === 'none') return action;

  const held = input.held ?? NAMES_NONE;
  const named = input.named ?? NAMES_NONE;
  const stale: GuardedSignalAction = { create: false, replace: false, slot: null, act: 'stale' };
  if (input.kind === 'offer') {
    if (!receiver) return action;
    const step = offerForConnection(input.hasEntry, held.page, held.attempt, named.page, named.attempt);
    if (step === 'drop') return stale;
    if (step === 'replace') return { create: false, replace: true, slot: knownSlot ?? null, act: 'offer' };
    return action;
  }
  if (input.kind === 'answer') {
    return answerApplies(input.awaitingAnswer, held.page, held.attempt, named.page, named.attempt) ? action : stale;
  }
  return signalForConnection(held.page, held.attempt, named.page, named.attempt) ? action : stale;
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
 * A connection that fails, or that only reports `disconnected`, is closed
 * and forgotten at once on either page; unlike the rollback engine
 * (`disconnectDisposition` in peer-signaling.ts) neither page tries again
 * on the spot. The host's deadline (reoffer.ts) then offers a new
 * connection to a member its roster still lists. A state change on a
 * connection the table no longer holds is ignored.
 */
export const connectionLost = (state: string, current: boolean): boolean =>
  current && (state === 'failed' || state === 'disconnected');
