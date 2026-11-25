import { setupEffect } from '@xstate/effect';
import { Duration, Effect, Schema } from 'effect';
import { createActor } from 'xstate';

const Empty = Schema.Struct({});
const Owner = Schema.Struct({ owner: Schema.instanceOf(AbortController) });
export const emulatorBootMachine = setupEffect({
  schemas: {
    context: Schema.Struct({ owner: Schema.NullOr(Schema.instanceOf(AbortController)) }),
    events: { request: Owner, prepared: Empty, stop: Empty },
  },
}).createMachine({
  id: 'emulatorBoot',
  initial: 'idle',
  context: { owner: null },
  on: { stop: { target: '.idle', context: { owner: null } } },
  states: {
    idle: { on: { request: ({ event }) => ({ target: 'preparing', context: { owner: event.owner } }) } },
    preparing: { on: { prepared: { target: 'loading' } } },
    loading: {},
  },
});

/** Owns one match page's core selection and loader until construction or teardown (specs/emulator_boot.qnt). */
export const startEmulatorBoot = (metadataMs = 15_000, loaderMs = 30_000) => {
  const actor = createActor(emulatorBootMachine).start();
  const cancel = () => {
    const owner = actor.getSnapshot().context.owner;
    actor.send({ type: 'stop' });
    owner?.abort();
  };
  return {
    cancel,
    start: (
      prepare: () => PromiseLike<void> | undefined,
      load: (signal: AbortSignal) => Promise<void>,
      metadataFailed: (message: string) => void,
      failed: (message: string) => void,
    ): boolean => {
      if (actor.getSnapshot().value !== 'idle') return false;
      const owner = new AbortController();
      actor.send({ type: 'request', owner });
      const work = Effect.tryPromise(async () => {
        await prepare();
      }).pipe(
        Effect.timeout(Duration.millis(metadataMs)),
        Effect.catch((err) => Effect.sync(() => metadataFailed(String(err)))),
        Effect.andThen(
          Effect.suspend(() => {
            actor.send({ type: 'prepared' });
            return Effect.tryPromise(() => load(owner.signal)).pipe(Effect.timeout(Duration.millis(loaderMs)));
          }),
        ),
      );
      void Effect.runPromise(work, { signal: owner.signal }).then(
        () => {
          if (actor.getSnapshot().context.owner === owner) cancel();
        },
        (err) => {
          if (actor.getSnapshot().context.owner !== owner) return;
          cancel();
          failed(String(err));
        },
      );
      return true;
    },
  };
};
