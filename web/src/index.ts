/**
 * Entry point of the TypeScript core, bundled to web/static/dist/kn-core.js
 * and exposed to the plain-script pages as `window.KNCore`.
 */
import { Effect, Exit, Scope } from 'effect';
import { createEffectActor } from '@xstate/effect';
import { initialTransition, transition } from 'xstate';
import { bootTimedOut } from './boot.ts';
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
 * The page's session: the lifecycle machine the page reads its state from.
 *
 * The page needs the state in the same tick as the event that changed it, and
 * the Effect actor processes events on a later one. So the state is kept
 * here with XState's pure `transition`, and the actor receives the same
 * events in the same order only to run the machine's effects (the stranded
 * late-joiner timer and its report). Events sent before the actor is up are
 * held for it and delivered in order.
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

  let [snapshot] = initialTransition(sessionMachine, { lateJoinReportAfterMs });
  const state = (): SessionState => snapshot.value;
  const send = (event: SessionEvent): void => {
    [snapshot] = transition(sessionMachine, snapshot, event);
    if (actor) actor.send(event);
    else held.push(event);
  };

  return {
    send,
    state,
    /** A game is on for this page: it is anywhere but the lobby. */
    gameOn: (): boolean => state() !== 'lobby',
    /**
     * Cross-check, called when the signaling socket comes back: does the
     * machine agree with the flag play.js still keeps beside it about whether
     * a game is on? The machine decides either way; a disagreement is
     * reported so production can show when the flag can be deleted.
     */
    socketUp: (page: { gameRunning: boolean }): Promise<boolean> => {
      send({ type: 'socketUp' });
      const machineState = state();
      const agrees = (machineState !== 'lobby') === page.gameRunning;
      if (!agrees) {
        sink({ type: 'session-disagree', machine: machineState, gameRunning: page.gameRunning });
      }
      return Promise.resolve(agrees);
    },
    stop: (): Promise<void> => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

export const KNCore = {
  bootTimedOut,
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
