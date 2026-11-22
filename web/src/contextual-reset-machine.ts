/** Implements specs/contextual_reset.qnt. Scope includes match, owner and 12CB phase. */
import { Schema } from 'effect';
import { setupEffect } from '@xstate/effect';

const Empty = Schema.Struct({});
export const contextualResetMachine = setupEffect({
  schemas: {
    context: Schema.Struct({ scope: Schema.String }),
    events: {
      observe: Schema.Struct({ scope: Schema.String }),
      elapsed: Schema.Struct({ scope: Schema.String }),
      press: Empty,
      release: Empty,
      cancel: Empty,
    },
  },
}).createMachine({
  id: 'contextualReset',
  context: { scope: '' },
  initial: 'hidden',
  on: {
    observe: ({ context, event }) =>
      event.scope === context.scope
        ? undefined
        : {
            target: event.scope ? '.pending' : '.hidden',
            context: { scope: event.scope },
          },
    cancel: { target: '.hidden', context: { scope: '' } },
  },
  states: {
    hidden: {},
    pending: {
      on: { elapsed: ({ context, event }) => (event.scope === context.scope ? { target: 'ready' } : undefined) },
    },
    ready: { on: { press: { target: 'holding' } } },
    holding: { on: { release: { target: 'ready' } } },
  },
});
