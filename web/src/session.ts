/**
 * What this page is doing, as a state machine: showing the lobby, joining a
 * match already in play, or running a match. It is the page half of
 * specs/room_lifecycle.qnt (`Page = Lobby | Waiting | Running`; the three
 * late-join states here are all `Waiting` there, since the server cannot
 * tell them apart). The scenario tests in tests/ts replay that model's runs
 * against it.
 *
 * Stage 2, in two steps:
 *  - "Is a game on" is read from this machine. play.js still writes its old
 *    `gameRunning` flag beside it and reports any disagreement
 *    (`session-disagree`) on every signaling reconnect; the flag goes once
 *    production shows none.
 *  - On a signaling reconnect the page reconciles with the server
 *    (`rejoined`): this one decides, there was no rule before it.
 *  - The late-join states observe. play.js still decides from `_lateJoin`
 *    and `_pendingLateJoin` and reports, at each place it reads one, whether
 *    the machine would have answered the same.
 */
import { Context, Effect, Schema } from 'effect';
import { setupEffect } from '@xstate/effect';
import { RoomStatus } from './protocol.ts';
import { reconcileRejoin } from './rejoin.ts';

export type SessionState =
  | 'lobby'
  /** Joined a match in play; no usable ROM yet, the page is asking for one. */
  | 'lateJoinAwaitingRom'
  /** Joined a match in play; the next engine start is the late join. */
  | 'lateJoinStarting'
  /** The late-join engine is up and waiting for the match state. */
  | 'lateJoinSyncing'
  | 'running';

/** The page flags the machine can be compared with. */
export type SessionCheck = 'gameRunning' | 'lateJoin' | 'pendingLateJoin';

/** What the machine says each page flag should be in a given state. */
export const sessionFlag = (state: SessionState, check: SessionCheck): boolean => {
  switch (check) {
    case 'gameRunning':
      return state !== 'lobby';
    case 'pendingLateJoin':
      return state === 'lateJoinAwaitingRom';
    case 'lateJoin':
      // The next engine start is a late join until an engine has started as one.
      return state === 'lateJoinAwaitingRom' || state === 'lateJoinStarting';
  }
};

/** What the machine reports. It never acts on these; the page logs them. */
export type SessionReport =
  | { readonly type: 'late-join-stranded'; readonly matchId: string | null }
  | {
      readonly type: 'session-disagree';
      readonly machine: SessionState;
      readonly check: SessionCheck;
      /** What play.js's own flag said. */
      readonly page: boolean;
    };

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
      joined: Schema.Struct({
        status: RoomStatus,
        matchId: Schema.NullOr(Schema.String),
        spectator: Schema.Boolean,
        /** The match is streamed: nobody but the host runs an emulator. */
        streaming: Schema.Boolean,
      }),
      gameStarted: Schema.Struct({ matchId: Schema.String }),
      gameEnded: Empty,
      /** The server closed the room under this page (host left, shutdown). */
      roomClosed: Empty,
      /**
       * The socket came back and the server acknowledged the rejoin with what
       * the room is doing now. A page that is out of step (the game ended, or
       * the match was replaced, while its socket was down) returns to the
       * lobby; play.js then does what a fresh join would (web/src/rejoin.ts).
       */
      rejoined: Schema.Struct({ playing: Schema.Boolean, matchId: Schema.NullOr(Schema.String) }),
      /** A late joiner has no usable ROM and has been asked for one. */
      lateJoinRomNeeded: Empty,
      /** The ROM question is settled; the late join can go ahead. */
      lateJoinRomReady: Empty,
      /** play.js started the netplay engine. */
      engineStarted: Schema.Struct({
        /** No ROM yet: the engine only connects, to fetch the ROM from the host. */
        connectOnly: Schema.Boolean,
        /** This page runs an emulator, so it needs the match state before it is in the game. */
        waitsForState: Schema.Boolean,
      }),
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
  },
  states: {
    lobby: {
      on: {
        gameStarted: ({ context, event }) => ({ target: 'running', context: { ...context, matchId: event.matchId } }),
        joined: ({ context, event }) => {
          if (event.status !== 'playing') return;
          // A spectator of a rollback match watches the host's stream: the
          // game is on at once, and its engine start is not a late join.
          const target = event.spectator && !event.streaming ? 'running' : 'lateJoinStarting';
          return { target, context: { ...context, matchId: event.matchId } };
        },
      },
    },
    lateJoinAwaitingRom: {
      on: {
        rejoined: ({ context, event }) => {
          const verdict = reconcileRejoin(true, context.matchId ?? '', event.playing, event.matchId ?? '');
          if (verdict === 'keep') return;
          return { target: 'lobby', context: { ...context, matchId: null } };
        },
        // A game-started for a page already in the match changes nothing but the match id.
        gameStarted: ({ context, event }) => ({ context: { ...context, matchId: event.matchId } }),
        lateJoinRomReady: { target: 'lateJoinStarting' },
        // A connect-only engine start fetches the ROM; the late join is still to come.
      },
    },
    lateJoinStarting: {
      on: {
        rejoined: ({ context, event }) => {
          const verdict = reconcileRejoin(true, context.matchId ?? '', event.playing, event.matchId ?? '');
          if (verdict === 'keep') return;
          return { target: 'lobby', context: { ...context, matchId: null } };
        },
        // A game-started for a page already in the match changes nothing but the match id.
        gameStarted: ({ context, event }) => ({ context: { ...context, matchId: event.matchId } }),
        lateJoinRomNeeded: { target: 'lateJoinAwaitingRom' },
        engineStarted: ({ event }) => {
          if (event.connectOnly) return;
          return { target: event.waitsForState ? 'lateJoinSyncing' : 'running' };
        },
        lateJoinSynced: { target: 'running' },
      },
    },
    lateJoinSyncing: {
      // Detection only, like the tick watchdog: report, take no action. The
      // clock starts when the engine does, so time spent choosing a ROM is
      // not counted against the joiner.
      after: {
        lateJoinReportAfter: ({ actions, context, self }, enq) => {
          enq(actions.reportStrandedJoiner, { matchId: context.matchId, self });
        },
      },
      on: {
        rejoined: ({ context, event }) => {
          const verdict = reconcileRejoin(true, context.matchId ?? '', event.playing, event.matchId ?? '');
          if (verdict === 'keep') return;
          return { target: 'lobby', context: { ...context, matchId: null } };
        },
        // A game-started for a page already in the match changes nothing but the match id.
        gameStarted: ({ context, event }) => ({ context: { ...context, matchId: event.matchId } }),
        lateJoinSynced: { target: 'running' },
      },
    },
    running: {
      on: {
        rejoined: ({ context, event }) => {
          const verdict = reconcileRejoin(true, context.matchId ?? '', event.playing, event.matchId ?? '');
          if (verdict === 'keep') return;
          return { target: 'lobby', context: { ...context, matchId: null } };
        },
        // A game-started for a page already in the match changes nothing but the match id.
        gameStarted: ({ context, event }) => ({ context: { ...context, matchId: event.matchId } }),
      },
    },
  },
});
