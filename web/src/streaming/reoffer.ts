/**
 * The streaming host's deadline to offer again (`reoffer` in
 * specs/streaming_connection.qnt, HOST_REOFFERS).
 *
 * The host keeps one deadline for every member its roster lists whose data
 * channel to it is not open: a connection that dropped, an offer or answer
 * that was lost, a late joiner's ready that never came. When the deadline
 * expires and the member still has no open channel (`reofferDue`,
 * attempt.ts), the host replaces the connection and offers on the new one,
 * then waits again. Without it a lost connection was forgotten on both pages
 * and nothing offered again (droppedGuestTest).
 *
 * Each wait is an Effect program, so that a deadline that is no longer
 * wanted is interrupted with its timer: when the channel opens, when the
 * roster stops listing the member, when the engine stops.
 *
 * The first wait is `REOFFER_FIRST_MS`; while no channel opens each next one
 * is longer, up to `REOFFER_MAX_MS`, so a connection that takes long to come
 * up (a spectator's goes through a TURN relay) is not replaced every time
 * before it can. An open channel starts the count again.
 */
import { Duration, Effect, Fiber } from 'effect';

export const REOFFER_FIRST_MS = 10_000;
export const REOFFER_MAX_MS = 30_000;

/** How long the host waits before offering again, after `tries` offers that brought no open channel. */
export const reofferDelayMs = (tries: number): number =>
  Math.min(REOFFER_FIRST_MS * (Math.max(0, Math.floor(tries)) + 1), REOFFER_MAX_MS);

export interface ReofferOptions {
  /** Does the member still need a new offer? Asked when its deadline expires. */
  readonly due: (sid: string) => boolean;
  /** Replace the member's connection and offer on the new one. `tries` counts from 1. */
  readonly reoffer: (sid: string, tries: number) => void;
  /** The wait before offering again after `tries` offers; `reofferDelayMs` when not given. */
  readonly delayMs?: (tries: number) => number;
}

/** The host's deadlines, one per member, for the plain-script engine. */
export interface ReofferDeadlines {
  /** The member has no open channel: start its deadline, unless one is already running. */
  readonly arm: (sid: string) => void;
  /** The member's channel opened: stop its deadline, and the next one starts from the first wait. */
  readonly opened: (sid: string) => void;
  /** The roster no longer lists the member: stop its deadline and forget it. */
  readonly forget: (sid: string) => void;
  /** The engine stopped: stop every deadline. */
  readonly stop: () => void;
  /** The members with a deadline running. */
  readonly armed: () => readonly string[];
}

export const startReofferDeadlines = (options: ReofferOptions): ReofferDeadlines => {
  const delayMs = options.delayMs ?? reofferDelayMs;
  const running = new Map<string, Fiber.Fiber<void>>();
  const tries = new Map<string, number>();

  // Wait, and offer again while the member is due; stop when it is not (an
  // open channel or a roster without it arms nothing more).
  const waitFor = (sid: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (;;) {
        const done = tries.get(sid) ?? 0;
        yield* Effect.sleep(Duration.millis(delayMs(done)));
        const again = yield* Effect.sync(() => {
          if (!options.due(sid)) return false;
          tries.set(sid, done + 1);
          options.reoffer(sid, done + 1);
          return true;
        });
        if (!again) return;
      }
    });

  const interrupt = (sid: string): void => {
    const fiber = running.get(sid);
    if (!fiber) return;
    running.delete(sid);
    Effect.runFork(Fiber.interrupt(fiber));
  };

  return {
    arm: (sid) => {
      if (running.has(sid)) return;
      // Whatever ends the wait (the member was not due, or `due` or
      // `reoffer` threw), the member has no deadline running any more, and
      // the next `arm` starts one.
      let finished = false;
      let fiber: Fiber.Fiber<void> | undefined;
      const program = waitFor(sid).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            finished = true;
            if (fiber !== undefined && running.get(sid) === fiber) running.delete(sid);
          }),
        ),
      );
      fiber = Effect.runFork(program);
      if (!finished) running.set(sid, fiber);
    },
    opened: (sid) => {
      interrupt(sid);
      tries.delete(sid);
    },
    forget: (sid) => {
      interrupt(sid);
      tries.delete(sid);
    },
    stop: () => {
      // Deleting the entry being visited is safe while iterating a Map.
      for (const sid of running.keys()) interrupt(sid);
      tries.clear();
    },
    armed: () => [...running.keys()],
  };
};
