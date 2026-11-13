/**
 * Taking this page's place in the room back after its signaling socket
 * returns, as an Effect program.
 *
 * It used to be one `emit` with a bare callback: an answer that never came
 * left the page out of the room's signaling with nothing said, and a refusal
 * was only logged, so the page carried on with a game the room had dropped
 * it from (specs/room_lifecycle.qnt, `nobodyIsStrandedInADroppedMatch`).
 * Here each attempt has a deadline, an unanswered or rate-limited attempt is
 * repeated a set number of times, and every way it can end is an outcome the
 * page must handle. What an answer means is `rejoinAnswer` (web/src/rejoin.ts).
 */
import { Duration, Effect, Fiber } from 'effect';
import { rejoinAnswer } from './rejoin.ts';

/** How the rejoin ended; `Room` is whatever the server sends with a success. */
export type RejoinOutcome<Room> =
  /** Back in the room. `room` says what it is doing now (absent for a host). */
  | { readonly kind: 'resumed'; readonly room: Room | undefined }
  /** Not in the room any more: end the game and join again as a fresh page. */
  | { readonly kind: 'dropped'; readonly reason: string }
  /** No attempt was answered. */
  | { readonly kind: 'noAnswer' };

export interface RejoinOptions<Room> {
  /**
   * Send the rejoin. `answer` is the server's acknowledgement: the error
   * text (null or empty for none) and, on success, the room.
   */
  readonly send: (answer: (error: string | null | undefined, room?: Room) => void) => void;
  /** How long one attempt waits for its answer. */
  readonly answerWithinMs: number;
  /** The pause before asking again. */
  readonly retryAfterMs: number;
  /** How many times to ask in all. */
  readonly attempts: number;
}

type Answer<Room> = { readonly error: string; readonly room: Room | undefined };

/** One attempt: the server's answer, or null when it did not come in time. */
const attempt = <Room>({ send, answerWithinMs }: RejoinOptions<Room>): Effect.Effect<Answer<Room> | null> =>
  Effect.callback<Answer<Room>>((resume) => {
    send((error, room) => resume(Effect.succeed({ error: error ?? '', room })));
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(answerWithinMs),
      orElse: () => Effect.succeed(null),
    }),
  );

export const rejoin = <Room>(options: RejoinOptions<Room>): Effect.Effect<RejoinOutcome<Room>> =>
  Effect.gen(function* () {
    for (let asked = 1; asked <= options.attempts; asked += 1) {
      const answer = yield* attempt(options);
      if (answer !== null) {
        const verdict = rejoinAnswer(answer.error);
        if (verdict === 'resumed') return { kind: 'resumed', room: answer.room };
        if (verdict === 'dropped') return { kind: 'dropped', reason: answer.error };
      }
      if (asked < options.attempts) yield* Effect.sleep(Duration.millis(options.retryAfterMs));
    }
    return { kind: 'noAnswer' };
  });

/** A running rejoin, for the plain-script page. */
export interface RejoinHandle<Room> {
  /** Give up: the socket dropped again or the game ended. `outcome` never settles. */
  readonly cancel: () => void;
  readonly outcome: Promise<RejoinOutcome<Room>>;
}

export const startRejoin = <Room>(options: RejoinOptions<Room>): RejoinHandle<Room> => {
  const fiber = Effect.runFork(rejoin(options));
  let cancelled = false;
  const outcome = new Promise<RejoinOutcome<Room>>((resolve) => {
    void Effect.runPromise(Fiber.join(fiber)).then(
      (result) => {
        if (!cancelled) resolve(result);
      },
      () => {
        // Interrupted: a cancelled rejoin reports nothing.
      },
    );
  });
  return {
    cancel: () => {
      cancelled = true;
      Effect.runFork(Fiber.interrupt(fiber));
    },
    outcome,
  };
};
