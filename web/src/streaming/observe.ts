/**
 * Running the streaming rules beside the engine that still makes them.
 *
 * web/static/netplay-streaming.js stays in charge (docs/roadmap.md, "Rules
 * for every stage"). At each decision it calls one method here. The method
 * notes the inputs as they are before the engine acts; once the engine's
 * handler has run, what the engine did is read back from its state, or from
 * a mark the handler left in the record the method returned, and compared
 * with what the typed function decides from those inputs. A difference is a
 * `streaming-disagree` client event (the comparer is play/observe.ts).
 *
 * Nothing here may reach the engine: every method catches what it throws,
 * and a rule that throws is reported as a disagreement. The input path runs
 * 60 times a second for each guest, so its decisions are sampled.
 */
import type { WireInput } from '../input-wire.ts';
import { createComparer } from '../play/observe.ts';
import { checkRelayed, type Relayed } from '../relay.ts';
import type { WirePayload } from '../wire.ts';
import { guestPacket, guestSends, readGuestPacket, type ChannelMessage } from './input.ts';
import { controllerPresentMask, hostRosterPlan, type RosterInput, type Slot } from './roster.ts';
import {
  channelOpenAction,
  connectionLost,
  lateJoinReadyAction,
  signalAction,
  signalKind,
  type LateJoinReadyInput,
} from './signal.ts';

/** One disagreement between the streaming engine and the function meant to replace part of it. */
export type StreamingDisagreeReport = {
  readonly type: 'streaming-disagree';
  /** Which decision: 'roster', 'signal:offer', 'input-packet', ... */
  readonly message: string;
  /** What the engine did, and what the function would have: JSON, cut to a window around the first difference. */
  readonly old: string;
  readonly next: string;
};

/** A sampled decision is compared its first few times, then now and then, up to a total. */
export const SAMPLE_FIRST = 16;
export const SAMPLE_EVERY = 512;
export const SAMPLE_MAX = 64;

/** A connection as the engine holds it: only what the rules read. */
export interface PeerView {
  slot?: Slot;
  pc?: {
    connectionState?: string;
    localDescription?: { type?: string } | null;
    getSenders?: () => readonly { track?: unknown }[];
  } | null;
  dc?: { readyState?: string } | null;
}

/** The engine's state, read through functions so the observer always sees the current value. */
export interface EngineView {
  sid: () => string | undefined;
  slot: () => Slot;
  spectator: () => boolean;
  peers: () => Readonly<Record<string, PeerView>>;
  /** The players on the last roster, by socket id. */
  known: () => Readonly<Record<string, { slot?: Slot }>>;
  running: () => boolean;
  live: () => boolean;
  /** The packet the engine's own encoder makes for a guest's input. */
  packet: (input: WireInput) => ArrayLike<number>;
}

type RosterMessage = {
  players?: Readonly<Record<string, { socketId: string; slot?: Slot }>> | null;
  spectators?: Readonly<Record<string, { socketId: string }>> | null;
};
type SignalMessage = { sender?: string; offer?: unknown; answer?: unknown; candidate?: unknown };

/** What the input handler leaves behind: the slot and the decoded input it applied. */
type InputSeen = { applied?: readonly [Slot, WireInput] };

const isList = (value: WirePayload): value is readonly WirePayload[] => Array.isArray(value);

/** The same value with every object's keys in one order, so two that hold the same things compare equal. */
const canonical = (value: WirePayload): WirePayload => {
  if (isList(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
};

/**
 * @param sink   takes a report; false when it cannot be sent yet (it is offered again later)
 * @param view   the engine's state
 * @param defer  runs a function once the engine's current handler has finished
 */
export const createStreamingObserver = (
  sink: (report: StreamingDisagreeReport) => boolean,
  view: EngineView,
  defer: (run: () => void) => void = (run) => queueMicrotask(run),
) => {
  const comparer = createComparer(({ message, old, next }) => sink({ type: 'streaming-disagree', message, old, next }));
  const compared = new Map<string, number>();
  let disagreed = 0;
  let failed = 0;

  /** Compare what the engine did (`old`) with what the rule decides (`next`). */
  const check = (what: string, old: () => WirePayload, next: () => WirePayload): void => {
    try {
      const engine = canonical(old());
      let rule: WirePayload;
      try {
        rule = canonical(next());
      } catch (error) {
        rule = `threw: ${error instanceof Error ? error.message : 'not an Error'}`;
      }
      compared.set(what, (compared.get(what) ?? 0) + 1);
      if (!comparer.compare(what, engine, rule)) disagreed += 1;
    } catch {
      failed += 1;
    }
  };

  const samples = new Map<string, { seen: number; taken: number }>();
  const wants = (kind: string): boolean => {
    const sample = samples.get(kind) ?? { seen: 0, taken: 0 };
    samples.set(kind, sample);
    sample.seen += 1;
    const take = sample.taken < SAMPLE_FIRST || (sample.taken < SAMPLE_MAX && sample.seen % SAMPLE_EVERY === 0);
    if (take) sample.taken += 1;
    return take;
  };

  /** A method of the observer: whatever it throws stays here. */
  const safe =
    <Args extends readonly unknown[], Result>(fallback: () => Result, run: (...args: Args) => Result) =>
    (...args: Args): Result => {
      try {
        return run(...args);
      } catch {
        failed += 1;
        return fallback();
      }
    };
  const nothing = (): void => undefined;

  const slots = (table: Readonly<Record<string, { slot?: Slot }>>) =>
    Object.entries(table).map(([sid, entry]) => ({ sid, slot: entry.slot }));

  // The offers the engine sent while its current handler ran.
  let offers = new Set<string>();

  return {
    /** The engine is about to make an offer to `sid`. */
    offered: safe(nothing, (sid: string): void => {
      offers.add(sid);
    }),

    /** `users-updated` arrived. Call first in the handler. */
    roster: safe(nothing, (data: RosterMessage): void => {
      const before = slots(view.peers());
      const input: RosterInput = {
        mySid: view.sid(),
        mySlot: view.slot(),
        players: Object.values(data.players ?? {}),
        spectators: Object.values(data.spectators ?? {}),
        connections: before,
        live: view.running() && view.live(),
      };
      const sent = new Set<string>();
      offers = sent;
      defer(() =>
        check(
          'roster',
          () => ({
            mySlot: view.slot() ?? null,
            connections: slots(view.peers()).map(({ sid, slot }) => {
              const kept = before.some((held) => held.sid === sid);
              return { sid, slot: slot ?? null, step: kept ? 'kept' : sent.has(sid) ? 'offer' : 'awaitReady' };
            }),
          }),
          () => hostRosterPlan(input),
        ),
      );
    }),

    /** The engine computed the controller-present mask. */
    controllerMask: safe(nothing, (mask: number): void =>
      check(
        'controller-mask',
        () => mask,
        () =>
          controllerPresentMask(
            view.slot(),
            [...slots(view.known()), ...slots(view.peers())].map((p) => p.slot),
          ),
      ),
    ),

    /**
     * A `webrtc-signal` arrived. Call first in the handler; the handler sets
     * `act` on the record to the part it handed to the connection.
     */
    signal: safe(
      () => ({ act: 'none' }),
      (data: SignalMessage | null | undefined) => {
        const seen = { act: 'none' };
        const sender = data?.sender;
        if (!data || !sender) return seen;
        const kind = signalKind(data);
        const what = `signal:${kind}`;
        if (!wants(what)) return seen;
        const had = view.peers()[sender] !== undefined;
        const knownSlot = view.known()[sender]?.slot;
        defer(() =>
          check(
            what,
            () => {
              const peer = view.peers()[sender];
              const create = !had && peer !== undefined;
              return { create, slot: create ? (peer.slot ?? null) : null, act: seen.act };
            },
            () => ({ ...signalAction(true, kind, had, knownSlot) }),
          ),
        );
        return seen;
      },
    ),

    /**
     * A `data-message` arrived. Call first in the handler; the handler sets
     * `act` on the record to `offer` or `resend` where it sends one.
     */
    lateJoinReady: safe(
      () => ({ act: 'ignore' }),
      (data: Relayed | null | undefined) => {
        const seen = { act: 'ignore' };
        if (data?.type !== 'streaming-late-join-ready') return seen;
        const input: LateJoinReadyInput = {
          message: data,
          mySlot: view.slot(),
          mySid: view.sid(),
          roster: slots(view.known()),
          connections: Object.entries(view.peers()).map(([sid, peer]) => ({
            sid,
            slot: peer.slot,
            linked: peer.dc?.readyState === 'open' || peer.pc?.connectionState === 'connected',
            pendingOffer: peer.pc?.localDescription?.type === 'offer',
          })),
        };
        const sender = checkRelayed(data).sid;
        defer(() =>
          check(
            'late-join-ready',
            () => {
              const peers = view.peers();
              const acted = seen.act !== 'ignore' && sender !== null;
              return {
                act: seen.act,
                create: Object.keys(peers).length > input.connections.length,
                slot: acted ? (peers[sender]?.slot ?? null) : null,
              };
            },
            () => ({ ...lateJoinReadyAction(input) }),
          ),
        );
        return seen;
      },
    ),

    /** A data channel opened. Call first in the handler; each branch sets `act` on the record. */
    channelOpen: safe(
      () => ({ act: 'none' }),
      (sid: string) => {
        const seen = { act: 'none' };
        const peer = view.peers()[sid];
        const state = {
          mySlot: view.slot(),
          spectator: view.spectator(),
          running: view.running(),
          live: view.live(),
          hasEntry: peer !== undefined,
          hasTracks: peer?.pc?.getSenders?.().some((sender) => Boolean(sender.track)) ?? false,
        };
        defer(() =>
          check(
            'channel-open',
            () => seen.act,
            () => channelOpenAction(state),
          ),
        );
        return seen;
      },
    ),

    /** A connection's state changed. Call first in the handler. */
    connectionState: safe(nothing, (sid: string, peer: PeerView, state: string): void => {
      const current = view.peers()[sid] === peer;
      defer(() =>
        check(
          'connection-state',
          () => current && view.peers()[sid] !== peer,
          () => connectionLost(state, current),
        ),
      );
    }),

    /**
     * A message arrived on a guest's channel (sampled). The handler sets
     * `applied` on the record to the slot and the decoded input it applied.
     */
    inputPacket: safe(
      (): InputSeen => ({}),
      (sid: string, data: ChannelMessage) => {
        const seen: InputSeen = {};
        if (!wants('input-packet')) return seen;
        const mySlot = view.slot();
        const peerSlot = view.peers()[sid]?.slot;
        defer(() =>
          check(
            'input-packet',
            () => {
              if (!seen.applied) return null;
              const [slot, { buttons, lx, ly, cx, cy }] = seen.applied;
              return { slot: slot ?? null, input: { buttons, lx, ly, cx, cy } };
            },
            () => {
              const read = readGuestPacket(mySlot, peerSlot, data);
              return read && { slot: read.slot, input: { ...read.input } };
            },
          ),
        );
        return seen;
      },
    ),

    /**
     * The guest read its input and may send it (sampled). The handler sets
     * `send` on the record where it hands a packet to the host's channel.
     */
    guestSend: safe(
      () => ({ send: false }),
      (force: boolean, input: WireInput, lastSent: WireInput) => {
        const seen = { send: false };
        const what = force ? 'guest-send:repeat' : 'guest-send:change';
        if (!wants(what)) return seen;
        const connections = Object.values(view.peers()).map((peer) => ({
          slot: peer.slot,
          channel: peer.dc?.readyState,
        }));
        defer(() =>
          check(
            what,
            () => ({ send: seen.send, packet: seen.send ? Array.from(view.packet(input)) : null }),
            () => {
              const send = guestSends(force, input, lastSent, connections);
              return { send, packet: send ? Array.from(guestPacket(input)) : null };
            },
          ),
        );
        return seen;
      },
    ),

    /** How many comparisons ran, by decision; how many differed; how many the observer itself failed at. */
    counts: () => ({ compared: Object.fromEntries(compared), disagreed, failed }),
    flush: safe(nothing, (): void => comparer.flush()),
  };
};
