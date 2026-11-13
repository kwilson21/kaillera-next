/**
 * A late joiner waiting to get into the match.
 *
 * The joiner asks the host for the match state. Two answers are possible:
 * the state itself (the host is running the match), or "join the start" (the
 * host has not started running yet and is waiting for this player to load;
 * specs/room_lifecycle.qnt, `admitToStart`). Before this, only the first
 * existed, the request was sent once, and the wait had no end: a joiner who
 * arrived while the host was still waiting for players hung for ever, and so
 * did the host (`joinersAreNotLeftWaitingAtTheStart`).
 *
 * Written as one Effect program so that it cannot wait without a deadline:
 * the request is repeated on a schedule, the two answers race, and the whole
 * thing times out. Interrupting it (the game ended, the engine stopped)
 * cancels the repeats and the timer with it.
 */
import { Deferred, Duration, Effect, Fiber, Schedule } from 'effect';

/** How the wait ended. */
export type LateJoinOutcome =
  /** The host sent the match state. */
  | 'state'
  /** The host is not running yet: load as a player who was there at the start. */
  | 'admitted'
  /** No answer before the deadline. */
  | 'timeout';

export interface LateJoinWaitOptions {
  /** Ask the host for the match state. Called at once and on every retry. */
  readonly request: () => void;
  readonly retryEveryMs: number;
  readonly timeoutMs: number;
}

/** The wait as an Effect, given the answer the engine will complete. */
export const lateJoinWait = (
  answer: Deferred.Deferred<'state' | 'admitted'>,
  { request, retryEveryMs, timeoutMs }: LateJoinWaitOptions,
): Effect.Effect<LateJoinOutcome> =>
  Effect.gen(function* () {
    // Keep asking until an answer arrives. The host ignores a request it
    // cannot act on yet (and rate-limits repeats), so asking again is safe.
    const asking = yield* Effect.forkChild(
      Effect.repeat(Effect.sync(request), Schedule.spaced(Duration.millis(retryEveryMs))),
    );
    const outcome = yield* Deferred.await(answer).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () => Effect.succeed<LateJoinOutcome>('timeout'),
      }),
    );
    yield* Fiber.interrupt(asking);
    return outcome;
  });

/** A running wait, for the plain-script engine. */
export interface LateJoinWaitHandle {
  /** The host's state arrived. */
  readonly stateArrived: () => void;
  /** The host said to join the start. */
  readonly admitted: () => void;
  /** Give up: the game ended or the engine stopped. `outcome` never settles. */
  readonly cancel: () => void;
  readonly outcome: Promise<LateJoinOutcome>;
}

export const startLateJoinWait = (options: LateJoinWaitOptions): LateJoinWaitHandle => {
  const answer = Effect.runSync(Deferred.make<'state' | 'admitted'>());
  const fiber = Effect.runFork(lateJoinWait(answer, options));
  let cancelled = false;
  const outcome = new Promise<LateJoinOutcome>((resolve) => {
    void Effect.runPromise(Fiber.join(fiber)).then(
      (result) => {
        if (!cancelled) resolve(result);
      },
      () => {
        // Interrupted: a cancelled wait reports nothing.
      },
    );
  });
  const complete = (value: 'state' | 'admitted') => {
    Effect.runSync(Deferred.succeed(answer, value));
  };
  return {
    stateArrived: () => complete('state'),
    admitted: () => complete('admitted'),
    cancel: () => {
      cancelled = true;
      Effect.runFork(Fiber.interrupt(fiber));
    },
    outcome,
  };
};
