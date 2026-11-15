/**
 * A wait at the start of a match with a deadline: it ends when what it waits
 * for comes (`done`), or at the deadline, when it calls back once. Stopping the
 * engine cancels it, timer included.
 *
 * The engine's start waits for things a page cannot make happen itself: a
 * guest for its channel to the host (specs/start_group.qnt, rejoinLate). A
 * bare timer hung on a connection went with it when the connection failed,
 * and the guest waited for ever; this is one program per wait, owned by the
 * page, that cannot wait without a deadline.
 */
import { Deferred, Duration, Effect, Fiber } from 'effect';
import { type Polling, startPolling } from './poll.ts';

/** How the wait ended. */
export type StartDeadlineOutcome = 'done' | 'deadline';

/** The wait as an Effect, given the word the engine completes when what it waits for has come. */
export const waitWithDeadline = (
  word: Deferred.Deferred<void>,
  deadlineMs: number,
): Effect.Effect<StartDeadlineOutcome> =>
  Deferred.await(word).pipe(
    Effect.as<StartDeadlineOutcome>('done'),
    Effect.timeoutOrElse({
      duration: Duration.millis(deadlineMs),
      orElse: () => Effect.succeed<StartDeadlineOutcome>('deadline'),
    }),
  );

/** A running wait, for the plain-script engine. */
export interface StartDeadlineHandle {
  /** What the wait was for has come. */
  readonly done: () => void;
  /** Give up the wait (the engine stopped, or the wait starts again): `onDeadline` is not called. */
  readonly cancel: () => void;
  readonly outcome: Promise<StartDeadlineOutcome>;
}

export interface StartDeadlineOptions {
  readonly deadlineMs: number;
  /** Called once, at the deadline, unless the wait was done or cancelled first. */
  readonly onDeadline: () => void;
}

export const startDeadline = ({ deadlineMs, onDeadline }: StartDeadlineOptions): StartDeadlineHandle => {
  const word = Effect.runSync(Deferred.make<void>());
  const fiber = Effect.runFork(waitWithDeadline(word, deadlineMs));
  let cancelled = false;
  const outcome = new Promise<StartDeadlineOutcome>((resolve) => {
    void Effect.runPromise(Fiber.join(fiber)).then(
      (result) => {
        if (cancelled) return;
        if (result === 'deadline') onDeadline();
        resolve(result);
      },
      () => {
        // Interrupted: a cancelled wait reports nothing.
      },
    );
  });
  return {
    done: () => {
      Effect.runSync(Deferred.succeed(word, undefined));
    },
    cancel: () => {
      cancelled = true;
      Effect.runFork(Fiber.interrupt(fiber));
    },
    outcome,
  };
};

export interface SayUntilHeardOptions {
  readonly everyMs: number;
  /** How many times in all, the first included. */
  readonly times: number;
  /** The word has been acted on (or no longer matters): stop saying it. */
  readonly heard: () => boolean;
  /** Say it; `n` counts from 0. */
  readonly say: (n: number) => void;
}

/**
 * A word said again until it is heard: now, then every `everyMs`, at most
 * `times` in all, until `heard()`. Its `result` is `true` once heard, or
 * `undefined` once the times ran out; `cancel` stops it (the engine stopped).
 * A guest's `unreachable:<slot>` to the host: the host does not take the word
 * before its own give-up could have come, so one said once, too soon, was
 * lost (specs/start_group.qnt, reportApart).
 */
export const sayUntilHeard = ({ everyMs, times, heard, say }: SayUntilHeardOptions): Polling<true> =>
  startPolling<true>(
    (n) => {
      if (heard()) return true;
      say(n);
      return undefined;
    },
    { everyMs, attempts: times },
  );
