/** Effect-owned escalation capture/transfer reservations. A slot has at most
 * one live operation, even after its actor is replaced or cancelled. The
 * underlying compression promise is not physically cancellable: use/release
 * is uninterruptible so cancelling a caller cannot free its buffers early.
 * Individual recipients release as their own transfer settles; token checks
 * prevent an old broadcast's finalizer releasing a newer retry. */
import { Effect } from 'effect';
import type { RecoveryAttempt } from './recovery-delivery.ts';

export const createRecoveryTransferPool = () => {
  const reservations = new Map<number, RecoveryAttempt>();
  const release = (attempts: readonly RecoveryAttempt[], sid: string | null = null): void => {
    for (const attempt of attempts) {
      if ((sid === null || attempt.sid === sid) && reservations.get(attempt.slot) === attempt)
        reservations.delete(attempt.slot);
    }
  };
  const run = <T>(
    attempts: readonly RecoveryAttempt[],
    work: (accepted: readonly RecoveryAttempt[]) => Promise<T>,
    busy: (rejected: readonly RecoveryAttempt[]) => T,
  ): Promise<T> =>
    Effect.runPromise(
      Effect.uninterruptible(
        Effect.acquireUseRelease(
          Effect.sync(() => {
            const accepted: RecoveryAttempt[] = [];
            const rejected: RecoveryAttempt[] = [];
            for (const attempt of attempts) {
              if (reservations.has(attempt.slot)) rejected.push(attempt);
              else {
                reservations.set(attempt.slot, attempt);
                accepted.push(attempt);
              }
            }
            return { accepted, rejected };
          }),
          ({ accepted, rejected }) =>
            Effect.suspend(() => {
              if (attempts.length && !accepted.length) return Effect.succeed(busy(rejected));
              if (rejected.length) busy(rejected);
              return Effect.promise(() => work(accepted));
            }),
          ({ accepted }) => Effect.sync(() => release(accepted)),
        ),
      ),
    );
  return { run, release, size: (): number => reservations.size };
};
