/**
 * What this page is doing, as a state machine: showing the lobby, waiting for
 * a late-join state, or running a match. It is the page half of
 * specs/room_lifecycle.qnt (`Page = Lobby | Waiting | Running`); the scenario
 * tests in tests/ts replay that model's runs against it.
 *
 * Stage 2: play.js reads "is a game on" from this machine. It still keeps
 * its old `gameRunning` flag beside it, written at the same places, and
 * reports any disagreement (`session-disagree`) on every signaling reconnect;
 * the flag goes once production shows none. `_lateJoin` and
 * `_pendingLateJoin` in play.js are not yet read from here.
 */
import { Context, Effect, Schema } from 'effect';
import { setupEffect } from '@xstate/effect';
import { RoomStatus } from './protocol.ts';

export type SessionState = 'lobby' | 'lateJoinWaiting' | 'running';

/** What the machine reports. It never acts on these; the page logs them. */
export type SessionReport =
  | { readonly type: 'late-join-stranded'; readonly matchId: string | null }
  | { readonly type: 'session-disagree'; readonly machine: SessionState; readonly gameRunning: boolean };

/** Where reports go. Provided by the host page. */
export class Telemetry extends Context.Service<
  Telemetry,
  { readonly report: (report: SessionReport) => Effect.Effect<void> }
>()('kn/Telemetry') {}

/** How long a late joiner may wait for state before it is reported. */
export const LATE_JOIN_REPORT_AFTER_MS = 20_000;

const Empty = Schema.Struct({});

export const sessionMachine = setupEffect({
  schemas: {
    context: Schema.Struct({
      matchId: Schema.NullOr(Schema.String),
      socketUp: Schema.Boolean,
      lateJoinReportAfterMs: Schema.Number,
    }),
    input: Schema.Struct({ lateJoinReportAfterMs: Schema.Number }),
    events: {
      /** The server acknowledged open-room or join-room. */
      joined: Schema.Struct({ status: RoomStatus, matchId: Schema.NullOr(Schema.String), spectator: Schema.Boolean }),
      gameStarted: Schema.Struct({ matchId: Schema.String }),
      gameEnded: Empty,
      /** The server closed the room under this page (host left, shutdown). */
      roomClosed: Empty,
      /** The late-join state arrived and the emulator is running it. */
      lateJoinSynced: Empty,
      socketDown: Empty,
      socketUp: Empty,
    },
    actions: {
      reportStrandedJoiner: { params: Schema.Struct({ matchId: Schema.NullOr(Schema.String) }) },
    },
  },
  actions: {
    reportStrandedJoiner: ({ matchId }) => Telemetry.use((t) => t.report({ type: 'late-join-stranded', matchId })),
  },
  delays: {
    lateJoinReportAfter: ({ context }) => context.lateJoinReportAfterMs,
  },
}).createMachine({
  id: 'session',
  context: ({ input }) => ({ matchId: null, socketUp: true, lateJoinReportAfterMs: input.lateJoinReportAfterMs }),
  initial: 'lobby',
  on: {
    socketDown: ({ context }) => ({ context: { ...context, socketUp: false } }),
    socketUp: ({ context }) => ({ context: { ...context, socketUp: true } }),
    gameEnded: ({ context }) => ({ target: '.lobby', context: { ...context, matchId: null } }),
    roomClosed: ({ context }) => ({ target: '.lobby', context: { ...context, matchId: null } }),
    gameStarted: ({ context, event }) => ({ target: '.running', context: { ...context, matchId: event.matchId } }),
  },
  states: {
    lobby: {
      on: {
        joined: ({ context, event }) => {
          if (event.status !== 'playing') return;
          // A spectator watches the host's stream: the game is on for this
          // page at once, with no state to wait for.
          const target = event.spectator ? 'running' : 'lateJoinWaiting';
          return { target, context: { ...context, matchId: event.matchId } };
        },
      },
    },
    lateJoinWaiting: {
      // Detection only, like the tick watchdog: report, take no action.
      after: {
        lateJoinReportAfter: ({ actions, context, self }, enq) => {
          enq(actions.reportStrandedJoiner, { matchId: context.matchId, self });
        },
      },
      on: { lateJoinSynced: { target: 'running' } },
    },
    running: {},
  },
});
