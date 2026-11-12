/**
 * Entry point of the TypeScript core, bundled to web/static/dist/kn-core.js
 * and exposed to the plain-script pages as `window.KNCore`.
 */
import { Effect, Exit, Scope } from 'effect';
import { createEffectActor, sendAndAwait } from '@xstate/effect';
import { decodeGameEnded, decodeGameStarted, decodeUsersUpdated } from './protocol.ts';
import { createConnectTracker, shouldResumeRomTransfer } from './reconnect.ts';
import { meshHealTargets } from './roster.ts';
import {
  LATE_JOIN_REPORT_AFTER_MS,
  sessionMachine,
  Telemetry,
  type SessionReport,
  type SessionState,
} from './session.ts';

type ReportSink = (report: SessionReport) => void;
type SessionEvent = Parameters<Awaited<ReturnType<typeof startActor>>['send']>[0];

const startActor = (sink: ReportSink, scope: Scope.Scope, lateJoinReportAfterMs: number) =>
  Effect.runPromise(
    createEffectActor(sessionMachine, { input: { lateJoinReportAfterMs } }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(Telemetry, {
        report: (report) => Effect.sync(() => sink(report)),
      }),
    ),
  );

/**
 * The page's session actor. Events sent before the actor is up are held and
 * delivered in order.
 */
export const createSession = (sink: ReportSink, lateJoinReportAfterMs: number = LATE_JOIN_REPORT_AFTER_MS) => {
  const scope = Effect.runSync(Scope.make());
  const ready = startActor(sink, scope, lateJoinReportAfterMs);
  let actor: Awaited<typeof ready> | undefined;
  const held: SessionEvent[] = [];
  void ready.then((a) => {
    actor = a;
    for (const event of held.splice(0)) a.send(event);
  });

  const state = (): SessionState => (actor ? actor.getSnapshot().value : 'lobby');

  return {
    send: (event: SessionEvent): void => {
      if (actor) actor.send(event);
      else held.push(event);
    },
    state,
    /**
     * Stage 1 cross-check, called when the signaling socket comes back: does
     * the machine agree with play.js about whether a game is on? The
     * answer is read after every earlier event has been processed.
     */
    socketUp: async (page: { gameRunning: boolean }): Promise<boolean> => {
      const a = await ready;
      const snapshot = await Effect.runPromise(sendAndAwait(a, { type: 'socketUp' }));
      const machineState: SessionState = snapshot.value;
      // play.js sets gameRunning as soon as it joins a room in play, before the
      // late-join state arrives, so "a game is on" is every state but the lobby.
      const agrees = (machineState !== 'lobby') === page.gameRunning;
      if (!agrees) {
        sink({ type: 'session-disagree', machine: machineState, gameRunning: page.gameRunning });
      }
      return agrees;
    },
    stop: (): Promise<void> => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

export const KNCore = {
  createConnectTracker,
  createSession,
  meshHealTargets,
  shouldResumeRomTransfer,
  protocol: { decodeUsersUpdated, decodeGameStarted, decodeGameEnded },
};

declare global {
  interface Window {
    KNCore?: typeof KNCore;
  }
}

if (typeof window !== 'undefined') window.KNCore = KNCore;
