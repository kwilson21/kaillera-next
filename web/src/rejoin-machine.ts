/**
 * The rejoin, as a state machine: after its signaling socket returns, a page
 * with a game on takes its place in the room back.
 *
 * `rejoining` invokes the rejoin program (web/src/rejoin-attempt.ts: a
 * deadline per attempt, a bounded number of retries). Leaving the state
 * interrupts it, so a socket that drops again or a game that ends cancels
 * the rejoin with no code of its own, and an outcome is only ever delivered
 * for the rejoin that is current. A new connect while one is in flight
 * starts over with the new connection's request.
 *
 * The page-lifecycle machine (session.ts) is separate: this one says what
 * the signaling side is doing, that one what the page is showing. The
 * session (index.ts) sends both the events they share and turns a refused
 * rejoin into `rejoinRefused` there.
 */
import { Context, Effect, Schema } from 'effect';
import { createEffectLogic, setupEffect } from '@xstate/effect';
import { rejoin, type RejoinOptions, type RejoinOutcome } from './rejoin-attempt.ts';

export type RejoinState = 'idle' | 'rejoining';

/** The room as the server sends it with an accepted rejoin; the page reads the rest. */
export type RejoinedRoom = { readonly status?: string };

/** How to ask, for the connection that is current. Provided by the session. */
export class RejoinTransport extends Context.Service<
  RejoinTransport,
  { readonly options: () => RejoinOptions<RejoinedRoom> }
>()('kn/RejoinTransport') {}

/** Where a finished rejoin's outcome goes. Provided by the session. */
export class RejoinResults extends Context.Service<
  RejoinResults,
  { readonly deliver: (outcome: RejoinOutcome<RejoinedRoom>) => Effect.Effect<void> }
>()('kn/RejoinResults') {}

const attempt = createEffectLogic(RejoinTransport.use((transport) => rejoin(transport.options())));

const Empty = Schema.Struct({});

export const rejoinMachine = setupEffect({
  schemas: {
    events: {
      /** The socket connected; `gameOn` is whether the page has a game to resume. */
      socketUp: Schema.Struct({ gameOn: Schema.Boolean }),
      socketDown: Empty,
      /** The page's game is over (ended, room closed, or the rejoin was refused). */
      gameOver: Empty,
    },
    actions: {
      deliver: { params: Schema.Struct({ outcome: Schema.Unknown }) },
    },
  },
  actors: { attempt },
  actions: {
    deliver: ({ outcome }) =>
      // SAFETY: `outcome` is the output of `attempt`, whose type is RejoinOutcome<RejoinedRoom>;
      // the action's params schema cannot name a generic type.
      RejoinResults.use((results) => results.deliver(outcome as RejoinOutcome<RejoinedRoom>)),
  },
}).createMachine({
  id: 'rejoin',
  initial: 'idle',
  states: {
    idle: {
      on: {
        socketUp: ({ event }) => (event.gameOn ? { target: 'rejoining' } : undefined),
      },
    },
    rejoining: {
      invoke: {
        id: 'attempt',
        src: 'attempt',
        onDone: ({ actions, event, self }, enq) => {
          enq(actions.deliver, { outcome: event.output, self });
          return { target: 'idle' };
        },
        // The program has no failure of its own; a defect ends the rejoin.
        onError: { target: 'idle' },
      },
      on: {
        socketDown: { target: 'idle' },
        gameOver: { target: 'idle' },
        // A newer connection: ask again on it.
        socketUp: ({ event }) => (event.gameOn ? { target: 'rejoining', reenter: true } : { target: 'idle' }),
      },
    },
  },
});
