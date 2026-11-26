/**
 * Waiting for something on the page by looking again at intervals.
 *
 * These Effect programs share cancellation so that stopping a wait
 * also cancels its timer:
 *
 * - `startPolling`: look now, then every `everyMs`, for at most `attempts`
 *   looks. It ends with what was found, or with nothing once the looks run
 *   out. Used for the emulator coming up (web/src/page/shared.ts).
 * - `startEvery`: run something every `everyMs` until stopped. Used for the
 *   gamepad manager's hot-plug poll (web/src/page/gamepad-manager.ts).
 * - `startAfter`: run once after a delay.
 *
 * The first look of `startPolling` is made by the caller's own call, before
 * it returns: the code this replaced did that, and callers rely on it (a
 * running emulator resolves without a timer).
 */
import { Duration, Effect, Fiber } from 'effect';

export interface PollOptions {
  readonly everyMs: number;
  /** How many looks in all, the first one included. */
  readonly attempts: number;
}

/** A poll in progress. */
export interface Polling<A> {
  /** What was found, or `undefined` once the looks ran out. Never settles after `cancel`. */
  readonly result: Promise<A | undefined>;
  /** Stop looking. No further look is made and `result` is left pending. */
  readonly cancel: () => void;
}

/** The looks after the first: each one `everyMs` after the one before. */
export const pollFrom = <A>(
  look: (attempt: number) => A | undefined,
  first: number,
  { everyMs, attempts }: PollOptions,
): Effect.Effect<A | undefined> =>
  Effect.gen(function* () {
    for (let attempt = first; attempt < attempts; attempt++) {
      yield* Effect.sleep(Duration.millis(everyMs));
      const found = look(attempt);
      if (found !== undefined) return found;
    }
    return undefined;
  });

/**
 * Look now and then at intervals. `look` is given the number of the look,
 * from 0, and returns what it found or `undefined` to look again.
 */
export const startPolling = <A>(look: (attempt: number) => A | undefined, options: PollOptions): Polling<A> => {
  const found = options.attempts > 0 ? look(0) : undefined;
  if (found !== undefined || options.attempts <= 1) {
    return { result: Promise.resolve(found), cancel: () => {} };
  }
  const fiber = Effect.runFork(pollFrom(look, 1, options));
  let cancelled = false;
  const result = new Promise<A | undefined>((resolve) => {
    void Effect.runPromise(Fiber.join(fiber)).then(
      (value) => {
        if (!cancelled) resolve(value);
      },
      () => {
        // Interrupted: a cancelled poll reports nothing.
      },
    );
  });
  return {
    result,
    cancel: () => {
      cancelled = true;
      Effect.runFork(Fiber.interrupt(fiber));
    },
  };
};

/** Run `run` every `everyMs`, first after one interval. Returns how to stop it. */
export const startEvery = (run: () => void, everyMs: number): (() => void) => {
  const fiber = Effect.runFork(Effect.forever(Effect.delay(Effect.sync(run), Duration.millis(everyMs))));
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
};

/** Run `run` once after `delayMs`. Returns how to cancel it. */
export const startAfter = (run: () => void, delayMs: number): (() => void) => {
  const fiber = Effect.runFork(Effect.delay(Effect.sync(run), Duration.millis(delayMs)));
  return () => {
    Effect.runFork(Fiber.interrupt(fiber));
  };
};
