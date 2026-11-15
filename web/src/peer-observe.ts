/**
 * Running the per-peer connection machine (peer-connection.ts) beside the
 * rollback engine, observing.
 *
 * web/static/netplay-rollback.js keeps deciding everything. For each other
 * player (by slot) this page runs one machine for as long as it is loaded,
 * and tells it what the engine itself acted on: the roster, a signal, a
 * channel that opened, a connection found lost, one of the engine's own
 * timers. The engine calls `open` before it handles such an event and
 * `close` once it has decided (before its first `await`); what it did in
 * between it reports with `did`, in the machine's words (`EngineAction`).
 * `close` hands the event to the machine and sets what the machine would
 * have done, and the facts each side holds afterwards (an entry, an open
 * channel, reconnecting), beside what the engine did and holds. A difference
 * is reported once, as a `peer-disagree` client event through play/observe.ts,
 * and that player is not watched again on this page: a machine whose
 * connection differs from the engine's from then on would only report the
 * same difference again in other words.
 *
 * The engine's timers and the machine's deadlines stand for the same waits
 * but run on different clocks (the health check runs every 300 frames, the
 * reconnect retry pauses 3 s). So when an engine timer fires, the machine's
 * deadline for that wait is taken at the same moment (`fire`), and the
 * machine's own deadlines run late by `LATE_MS` (the health check's by an
 * hour): one that passes on its own is a wait the engine had no timer for.
 * What is compared is what is done at a deadline, not when.
 *
 * Which attempt a signal belongs to comes from the `attemptId` the engine
 * now puts on every `webrtc-signal` (`{page, attempt}`). A signal without
 * one comes from a page made before signals carried it: the machine cannot
 * say which connection it is for, so the player is not watched from then on
 * (`stopWatching`). That alone is never reported: an old page on the other
 * side is not a disagreement (specs/peer_connection.qnt,
 * oldPageAnswersWithNoLabelTest).
 *
 * Not watched, as the machine does not cover them: spectators, a page that
 * joined a match in play, a player the engine holds as a late joiner, and a
 * player this page offered to before it watched them.
 *
 * Nothing here may reach the engine: every method catches what it throws.
 */
import { Option, Schema } from 'effect';
import { createComparer, type DisagreeReport } from './play/observe.ts';
import {
  createPeerConnection,
  PEER_TIMING,
  peerFacts,
  type Attempt,
  type OfferMode,
  type PeerCommand,
  type PeerConnection,
  type PeerDeadline,
  type PeerEvent,
  type PeerTiming,
} from './peer-connection.ts';
import type { WirePayload } from './wire.ts';

/** What the engine holds for a player: `_peers` has an entry, its lockstep channel is open, `peer.reconnecting`. */
export type PeerFacts = ReturnType<typeof peerFacts>;

/** What the engine did, in the machine's words (a `PeerCommand` without what only the machine knows). */
export type EngineAction =
  | { readonly type: 'offer'; readonly attempt: number; readonly mode: OfferMode }
  | {
      readonly type: 'answer';
      readonly page: string;
      readonly attempt: number;
      readonly connection: 'new' | 'kept';
    }
  | { readonly type: 'applyAnswer'; readonly page: string; readonly attempt: number }
  | { readonly type: 'applyCandidate'; readonly page: string; readonly attempt: number }
  | { readonly type: 'reset'; readonly reason: 'reconnect' | 'heal' }
  | { readonly type: 'drop' }
  | { readonly type: 'close' }
  | { readonly type: 'stalled' };

/**
 * What the machine is told when a frame closes: one of its events, one of
 * the engine's timers (`deadline`), or the health check acting on a player
 * whose channel it found not open (`heal`: the attempt of the connection it
 * found, which the machine takes as lost first if it still thought it open).
 */
export type ObservedEvent =
  | PeerEvent
  | { readonly type: 'deadline'; readonly deadline: PeerDeadline }
  | { readonly type: 'heal'; readonly page: string; readonly attempt: number };

/** One event the engine is handling for one player. */
export interface Frame {
  readonly slot: number | null;
  readonly key: string;
  readonly did: EngineAction[];
  open: boolean;
}

export interface PeerObserverOptions {
  /** This page's id, as the engine puts it on its offers. */
  readonly page: string;
  /** This page's slot now (`_playerSlot`). */
  readonly mySlot: () => number | null | undefined;
  /** How many offers the engine has made to a slot on this page. */
  readonly offersMade: (slot: number) => number;
  /** What the engine holds for a slot now. */
  readonly facts: (slot: number) => PeerFacts;
  /** Takes a report; false when it cannot be sent yet (it is offered again later). */
  readonly sink: (report: DisagreeReport) => boolean;
  /** A line for the sync log. */
  readonly log: (line: string) => void;
  readonly timing?: PeerTiming;
}

/** The machine's own deadlines run this much later than the engine's timers for the same waits. */
export const LATE_MS = 5000;

/** The engine's numbers, run late (module comment). */
export const OBSERVE_TIMING: PeerTiming = {
  ...PEER_TIMING,
  startupAfterMs: PEER_TIMING.startupAfterMs + LATE_MS,
  attemptAfterMs: PEER_TIMING.attemptAfterMs + LATE_MS,
  giveUpAfterMs: PEER_TIMING.giveUpAfterMs + LATE_MS,
  answerAfterMs: PEER_TIMING.answerAfterMs + LATE_MS,
  healAfterMs: 60 * 60_000,
};

/** Signals a player may send before the roster names their slot; past this they are not watched. */
export const HELD_MAX = 64;

const AttemptId = Schema.Struct({
  page: Schema.String.check(Schema.isMinLength(1), Schema.isMaxCodePoints(64)),
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
});
const decodeAttemptId = Schema.decodeUnknownOption(AttemptId);

/** The `attemptId` of a `webrtc-signal`, or null when it has none or one that is not well formed. */
export const readAttemptId = (value: WirePayload | undefined): Attempt | null => {
  const decoded = Option.getOrNull(decodeAttemptId(value));
  return decoded === null ? null : { page: decoded.page, attempt: decoded.attempt };
};

/** A new id for this page: random, made once when it loads. */
export const newPageId = (): string => {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** A machine's command as the engine would report the same act; null for one that does nothing. */
export const asAction = (command: PeerCommand): EngineAction | null => {
  switch (command.type) {
    case 'offer':
      return { type: 'offer', attempt: command.attempt, mode: command.mode };
    case 'answer':
      return { type: 'answer', page: command.page, attempt: command.attempt, connection: command.connection };
    case 'applyAnswer':
    case 'applyCandidate':
      return { type: command.type, page: command.page, attempt: command.attempt };
    case 'reset':
      return { type: 'reset', reason: command.reason };
    case 'drop':
      return { type: 'drop' };
    case 'close':
      return { type: 'close' };
    case 'stalled':
      return { type: 'stalled' };
    case 'ignore':
      return null;
  }
};

/** The engine's reason for `resetPeerState` as a machine command; null for one that is part of a drop. */
export const resetAction = (reason: string): EngineAction | null => {
  if (reason === 'reconnect') return { type: 'reset', reason: 'reconnect' };
  if (reason === 'mesh-heal') return { type: 'reset', reason: 'heal' };
  return null;
};

const isPlayerSlot = (slot: number | null | undefined): slot is number =>
  typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot <= 3;

const asWire = (actions: readonly EngineAction[]): WirePayload => actions.map((action) => ({ ...action }));

/** One side of a comparison: what it did with the event, and what it holds afterwards. */
interface Compared {
  did: WirePayload;
  facts?: { entry: boolean; open: boolean; reconnecting: boolean };
}

interface Watch {
  readonly mySlot: number;
  readonly peer: PeerConnection;
}

export const createPeerObserver = (options: PeerObserverOptions) => {
  const timing = options.timing ?? OBSERVE_TIMING;
  const comparer = createComparer(options.sink);
  const watches = new Map<number, Watch>();
  /** Slots not watched on this page, and why. */
  const unwatched = new Map<number, string>();
  /** Frames for a player whose slot the roster has yet to name, by their `_peers` key. */
  const held = new Map<string, { event: ObservedEvent; did: EngineAction[] }[]>();
  const heldOverflow = new Set<string>();
  let frames: Frame[] = [];
  let running = false;
  let joinedLate = false;
  let failed = false;

  const unwatch = (slot: number, reason: string): void => {
    if (unwatched.has(slot)) return;
    unwatched.set(slot, reason);
    const watch = watches.get(slot);
    watches.delete(slot);
    void watch?.peer.stop();
    options.log(`PEER-OBSERVE slot=${slot} not watched: ${reason}`);
  };

  /** Report a difference, once, and stop watching that player. */
  const disagree = (slot: number, what: string, engine: WirePayload, machine: WirePayload): void => {
    comparer.compare(`${what} slot=${slot}`, engine, machine);
    options.log(
      `PEER-DISAGREE slot=${slot} ${what} engine=${JSON.stringify(engine)} machine=${JSON.stringify(machine)}`,
    );
    unwatch(slot, `disagreed on ${what}`);
  };

  const onDeadline = (slot: number) => (deadline: PeerDeadline, commands: readonly PeerCommand[]) =>
    guard(() => {
      const watch = watches.get(slot);
      if (!watch) return;
      compare(slot, watch, `deadline:${deadline}`, [], commands, true);
    });

  const watchFor = (slot: number | null): Watch | null => {
    if (!isPlayerSlot(slot) || unwatched.has(slot)) return null;
    const mySlot = options.mySlot();
    if (!isPlayerSlot(mySlot) || mySlot === slot) return null;
    const known = watches.get(slot);
    if (known) {
      if (known.mySlot === mySlot) return known;
      unwatch(slot, `this page's slot changed from ${known.mySlot} to ${mySlot}`);
      return null;
    }
    if (joinedLate) {
      unwatch(slot, 'this page joined a match in play');
      return null;
    }
    // The machine numbers its offers from 1: it must see every offer the engine makes to this player.
    if (options.offersMade(slot) > 0) {
      unwatch(slot, 'the engine offered to this player before it was watched');
      return null;
    }
    const peer = createPeerConnection({ mySlot, theirSlot: slot, timing, page: options.page }, onDeadline(slot));
    const watch = { mySlot, peer };
    watches.set(slot, watch);
    options.log(`PEER-OBSERVE slot=${slot} watching (this page: slot ${mySlot}, id ${options.page})`);
    if (running) peer.send({ type: 'matchStarted' });
    return watch;
  };

  const compare = (
    slot: number,
    watch: Watch,
    what: string,
    did: readonly EngineAction[],
    commands: readonly PeerCommand[],
    withFacts: boolean,
  ): void => {
    const machineDid = commands.flatMap((command) => {
      const action = asAction(command);
      return action === null ? [] : [action];
    });
    const engine: Compared = { did: asWire(did) };
    const machine: Compared = { did: asWire(machineDid) };
    if (withFacts) {
      const held = options.facts(slot);
      const its = peerFacts(watch.peer.state());
      engine.facts = { entry: held.entry, open: held.open, reconnecting: held.reconnecting };
      machine.facts = { entry: its.entry, open: its.open, reconnecting: its.reconnecting };
    }
    if (JSON.stringify(engine) !== JSON.stringify(machine)) {
      disagree(slot, what, { ...engine }, { ...machine, state: watch.peer.state() });
    }
    comparer.flush();
  };

  /** Hand one event to the slot's machine and compare. */
  const process = (slot: number, event: ObservedEvent, did: readonly EngineAction[], withFacts: boolean): void => {
    const watch = watchFor(slot);
    if (!watch) return;
    let commands: readonly PeerCommand[];
    let what: string = event.type;
    if (event.type === 'deadline') {
      what = `deadline:${event.deadline}`;
      commands = watch.peer.fire(event.deadline) ?? [];
    } else if (event.type === 'heal') {
      const lost =
        watch.peer.state() === 'open'
          ? watch.peer.send({ type: 'lost', page: event.page, attempt: event.attempt })
          : [];
      commands = [...lost, ...(watch.peer.fire('healAfter') ?? [])];
    } else {
      commands = watch.peer.send(event);
    }
    compare(slot, watch, what, did, commands, withFacts);
  };

  /** The observer must never reach the engine: a throw turns it off, once reported. */
  const guard = <A>(run: () => A, fallback?: A): A | undefined => {
    if (failed) return fallback;
    try {
      return run();
    } catch (error) {
      failed = true;
      for (const watch of watches.values()) void watch.peer.stop();
      watches.clear();
      frames = [];
      const message = error instanceof Error ? error.message : 'not an Error';
      comparer.compare('observer', 'running', `threw: ${message}`);
      options.log(`PEER-OBSERVE stopped: threw ${message}`);
      return fallback;
    }
  };

  /** The open frame a report of the engine's for this player belongs to: the innermost. */
  const frameFor = (slot: number | null, key: string): Frame | undefined => {
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      if (frame && frame.open && (frame.key === key || (slot !== null && frame.slot === slot))) return frame;
    }
    return undefined;
  };

  const closeFrame = (frame: Frame): void => {
    frame.open = false;
    frames = frames.filter((f) => f !== frame);
  };

  return {
    /** The engine starts handling an event for the player under `key` (slot null: not known yet). */
    open: (slot: number | null | undefined, key: string): Frame | null =>
      guard(() => {
        const frame: Frame = { slot: isPlayerSlot(slot) ? slot : null, key, did: [], open: true };
        // The machine is made before the engine acts: it must see the first offer the engine makes.
        watchFor(frame.slot);
        frames = [...frames, frame];
        // A frame lives only while the engine's handler runs. One the
        // handler did not close (it threw) is let go; its player is no
        // longer watched, since the machine did not see that event.
        queueMicrotask(() =>
          guard(() => {
            if (!frame.open) return;
            closeFrame(frame);
            if (frame.slot !== null) unwatch(frame.slot, 'an event was not closed');
          }),
        );
        return frame;
      }, null) ?? null,

    /** The engine did this to the player's connection. */
    did: (slot: number | null | undefined, key: string, action: EngineAction): void =>
      guard(() => {
        const known = isPlayerSlot(slot) ? slot : null;
        const frame = frameFor(known, key);
        if (frame) {
          frame.did.push(action);
          return;
        }
        if (known === null || !watches.has(known) || unwatched.has(known)) return;
        const watch = watchFor(known);
        if (watch) compare(known, watch, 'unframed', [action], [], false);
      }),

    /** The engine has decided what to do with the event: hand it to the machine. Null: not for the machine. */
    close: (frame: Frame | null | undefined, event: ObservedEvent | null): void =>
      guard(() => {
        if (!frame || !frame.open) return;
        closeFrame(frame);
        if (event === null) {
          // What the engine did with an event the machine is not given, the machine never sees.
          if (frame.slot !== null && frame.did.length > 0) {
            unwatch(frame.slot, 'the engine acted on an event the machine was not given');
          }
          return;
        }
        if (frame.slot !== null) {
          process(frame.slot, event, frame.did, true);
          return;
        }
        if (heldOverflow.has(frame.key)) return;
        const list = held.get(frame.key) ?? [];
        if (list.length >= HELD_MAX) {
          held.delete(frame.key);
          heldOverflow.add(frame.key);
          return;
        }
        held.set(frame.key, [...list, { event, did: frame.did }]);
      }),

    /** The roster names the slot of the player under `key`: what was held for them reaches their machine. */
    identify: (key: string, slot: number | null | undefined): void =>
      guard(() => {
        if (!isPlayerSlot(slot)) return;
        if (heldOverflow.delete(key)) {
          unwatch(slot, 'too many signals before the roster named the player');
          return;
        }
        const list = held.get(key);
        held.delete(key);
        // Their facts then were not kept: only what was done is compared.
        for (const { event, did } of list ?? []) process(slot, event, did, false);
      }),

    /** The engine runs resetPeerState: a reset the machine also issues, or the end of a player's entry. */
    peerReset: (slot: number | null | undefined, key: string | null | undefined, reason: string): void =>
      guard(() => {
        if (!isPlayerSlot(slot)) {
          if (key) {
            held.delete(key);
            heldOverflow.delete(key);
          }
          return;
        }
        const action = resetAction(reason);
        if (action && key) {
          const frame = frameFor(slot, key);
          if (frame) frame.did.push(action);
          else if (watches.has(slot)) {
            const watch = watchFor(slot);
            if (watch) compare(slot, watch, 'unframed', [action], [], false);
          }
        }
      }),

    /** Leave this player alone from now on (an old page, a late joiner). Not a disagreement. */
    stopWatching: (slot: number | null | undefined, key: string, reason: string): void =>
      guard(() => {
        if (isPlayerSlot(slot)) unwatch(slot, reason);
        held.delete(key);
      }),

    /** This page joined a match in play: the machine does not cover it. */
    joinedLate: (): void =>
      guard(() => {
        joinedLate = true;
        for (const slot of watches.keys()) unwatch(slot, 'this page joined a match in play');
      }),

    matchStarted: (): void =>
      guard(() => {
        running = true;
        for (const [slot, watch] of watches)
          compare(slot, watch, 'matchStarted', [], watch.peer.send({ type: 'matchStarted' }), true);
      }),

    /** stopSync: the engine closes every connection. The machines are told, nothing is compared. */
    sessionEnded: (): void =>
      guard(() => {
        running = false;
        frames = [];
        held.clear();
        heldOverflow.clear();
        for (const watch of watches.values()) {
          watch.peer.send({ type: 'matchEnded' });
          watch.peer.send({ type: 'left' });
        }
      }),

    /** The health check left this player alone: what each side holds should agree. */
    check: (slot: number | null | undefined): void =>
      guard(() => {
        if (!isPlayerSlot(slot) || !watches.has(slot)) return;
        const watch = watchFor(slot);
        if (watch) compare(slot, watch, 'check', [], [], true);
      }),

    /** For tests and logs: the slots watched now, and the ones not watched with why. */
    status: () => ({
      watched: [...watches.entries()].map(([slot, watch]) => ({ slot, state: watch.peer.state() })),
      unwatched: Object.fromEntries(unwatched),
    }),

    stop: (): void => {
      for (const watch of watches.values()) void watch.peer.stop();
      watches.clear();
    },
  };
};
export type PeerObserver = ReturnType<typeof createPeerObserver>;
