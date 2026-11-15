/**
 * Driving the per-peer connection machine (peer-connection.ts) from the
 * rollback engine's events.
 *
 * For each other player (by slot) this page runs one machine for as long as
 * it is loaded, and hands it what the engine acted on: the roster, a signal,
 * a channel that opened, a connection found lost, one of the engine's own
 * timers. The engine calls `open` before it handles such an event and
 * `close` once it has decided (before its first `await`), with the event in
 * the machine's words; `close` hands it to the machine. The machine decides
 * nothing yet: what it would do is not acted on. It is being wired in to
 * decide one rule at a time (docs/roadmap.md), and its decisions replace the
 * engine's as they are.
 *
 * The engine's timers and the machine's deadlines stand for the same waits
 * but run on different clocks (the health check runs every 300 frames, the
 * reconnect retry pauses 3 s). So when an engine timer fires, the machine's
 * deadline for that wait is taken at the same moment (`fire`), and the
 * machine's own deadlines run late by `LATE_MS` (the health check's by an
 * hour).
 *
 * Which attempt a signal belongs to comes from the `attemptId` the engine
 * puts on every `webrtc-signal` (attempt-id.ts). A signal without one comes
 * from a page made before signals carried it: the machine cannot say which
 * connection it is for, so that player is left to the engine from then on
 * (`stopWatching`; specs/peer_connection.qnt, oldPageAnswersWithNoLabelTest).
 *
 * Not driven, as the machine does not cover them: spectators, a page that
 * joined a match in play, a player the engine holds as a late joiner, and a
 * player this page offered to before it had a machine for them.
 *
 * Nothing here may reach the engine: every method catches what it throws.
 */
import {
  createPeerConnection,
  PEER_TIMING,
  type PeerConnection,
  type PeerDeadline,
  type PeerEvent,
  type PeerTiming,
} from './peer-connection.ts';

/**
 * What the machine is told when a frame closes: one of its events, one of
 * the engine's timers (`deadline`), or the health check acting on a player
 * whose channel it found not open (`heal`: the attempt of the connection it
 * found, which the machine takes as lost first if it still thought it open).
 */
export type DrivenEvent =
  | PeerEvent
  | { readonly type: 'deadline'; readonly deadline: PeerDeadline }
  | { readonly type: 'heal'; readonly page: string; readonly attempt: number };

/** One event the engine is handling for one player. */
export interface Frame {
  readonly slot: number | null;
  readonly key: string;
  open: boolean;
}

export interface PeerDriverOptions {
  /** This page's id, as the engine puts it on its offers. */
  readonly page: string;
  /** This page's slot now (`_playerSlot`). */
  readonly mySlot: () => number | null | undefined;
  /** How many offers the engine has made to a slot on this page. */
  readonly offersMade: (slot: number) => number;
  /** A line for the sync log. */
  readonly log: (line: string) => void;
  readonly timing?: PeerTiming;
}

/** The machine's own deadlines run this much later than the engine's timers for the same waits. */
export const LATE_MS = 5000;

/** The engine's numbers, run late (module comment). */
export const DRIVER_TIMING: PeerTiming = {
  ...PEER_TIMING,
  startupAfterMs: PEER_TIMING.startupAfterMs + LATE_MS,
  attemptAfterMs: PEER_TIMING.attemptAfterMs + LATE_MS,
  giveUpAfterMs: PEER_TIMING.giveUpAfterMs + LATE_MS,
  answerAfterMs: PEER_TIMING.answerAfterMs + LATE_MS,
  healAfterMs: 60 * 60_000,
};

/** Signals a player may send before the roster names their slot; past this they are left to the engine. */
export const HELD_MAX = 64;

const isPlayerSlot = (slot: number | null | undefined): slot is number =>
  typeof slot === 'number' && Number.isInteger(slot) && slot >= 0 && slot <= 3;

interface Watch {
  readonly mySlot: number;
  readonly peer: PeerConnection;
}

export const createPeerDriver = (options: PeerDriverOptions) => {
  const timing = options.timing ?? DRIVER_TIMING;
  const watches = new Map<number, Watch>();
  /** Slots with no machine on this page, and why. */
  const unwatched = new Map<number, string>();
  /** Events for a player whose slot the roster has yet to name, by their `_peers` key. */
  const held = new Map<string, DrivenEvent[]>();
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
    options.log(`PEER-DRIVER slot=${slot} not driven: ${reason}`);
  };

  // A deadline the machine takes on its own: nothing acts on what it issues yet.
  const onDeadline = () => (): void => undefined;

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
      unwatch(slot, 'the engine offered to this player before it had a machine');
      return null;
    }
    const peer = createPeerConnection({ mySlot, theirSlot: slot, timing, page: options.page }, onDeadline());
    const watch = { mySlot, peer };
    watches.set(slot, watch);
    options.log(`PEER-DRIVER slot=${slot} driven (this page: slot ${mySlot}, id ${options.page})`);
    if (running) peer.send({ type: 'matchStarted' });
    return watch;
  };

  /** Hand one event to the slot's machine. */
  const process = (slot: number, event: DrivenEvent): void => {
    const watch = watchFor(slot);
    if (!watch) return;
    if (event.type === 'deadline') {
      watch.peer.fire(event.deadline);
    } else if (event.type === 'heal') {
      if (watch.peer.state() === 'open') watch.peer.send({ type: 'lost', page: event.page, attempt: event.attempt });
      watch.peer.fire('healAfter');
    } else {
      watch.peer.send(event);
    }
  };

  /** The driver must never reach the engine: a throw turns it off, once logged. */
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
      options.log(`PEER-DRIVER stopped: threw ${message}`);
      return fallback;
    }
  };

  const closeFrame = (frame: Frame): void => {
    frame.open = false;
    frames = frames.filter((f) => f !== frame);
  };

  return {
    /** The engine starts handling an event for the player under `key` (slot null: not known yet). */
    open: (slot: number | null | undefined, key: string): Frame | null =>
      guard(() => {
        const frame: Frame = { slot: isPlayerSlot(slot) ? slot : null, key, open: true };
        // The machine is made before the engine acts: it must see the first offer the engine makes.
        watchFor(frame.slot);
        frames = [...frames, frame];
        // A frame lives only while the engine's handler runs. One the
        // handler did not close (it threw) is let go; that player is left to
        // the engine, since the machine did not see that event.
        queueMicrotask(() =>
          guard(() => {
            if (!frame.open) return;
            closeFrame(frame);
            if (frame.slot !== null) unwatch(frame.slot, 'an event was not closed');
          }),
        );
        return frame;
      }, null) ?? null,

    /** The engine has decided what to do with the event: hand it to the machine. Null: not for the machine. */
    close: (frame: Frame | null | undefined, event: DrivenEvent | null): void =>
      guard(() => {
        if (!frame || !frame.open) return;
        closeFrame(frame);
        if (event === null) return;
        if (frame.slot !== null) {
          process(frame.slot, event);
          return;
        }
        if (heldOverflow.has(frame.key)) return;
        const list = held.get(frame.key) ?? [];
        if (list.length >= HELD_MAX) {
          held.delete(frame.key);
          heldOverflow.add(frame.key);
          return;
        }
        held.set(frame.key, [...list, event]);
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
        for (const event of list ?? []) process(slot, event);
      }),

    /** The engine runs resetPeerState for a player it has no slot for: what was held for them goes. */
    peerReset: (slot: number | null | undefined, key: string | null | undefined): void =>
      guard(() => {
        if (isPlayerSlot(slot) || !key) return;
        held.delete(key);
        heldOverflow.delete(key);
      }),

    /** Leave this player to the engine from now on (an old page, a late joiner). */
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
        for (const watch of watches.values()) watch.peer.send({ type: 'matchStarted' });
      }),

    /** stopSync: the engine closes every connection. The machines are told. */
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

    /** For tests and logs: the slots driven now with their state, and the ones not driven with why. */
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
export type PeerDriver = ReturnType<typeof createPeerDriver>;
