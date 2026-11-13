/**
 * Entry point of the TypeScript core, bundled to web/static/dist/kn-core.js
 * and exposed to the plain-script pages as `window.KNCore`.
 */
import { Effect, Exit, Scope } from 'effect';
import { createEffectActor } from '@xstate/effect';
import { initialTransition, transition } from 'xstate';
import { bootTimedOut } from './boot.ts';
import { decodeInput, encodeInput } from './input-wire.ts';
import {
  decodeGameEnded,
  decodeGameStarted,
  decodeJoinRoomAck,
  decodeRomSharingUpdated,
  decodeTokenMessage,
  decodeUsersUpdated,
} from './protocol.ts';
import { createConnectTracker, shouldResumeRomTransfer } from './reconnect.ts';
import { checkServerMessage, createProtocolObserver } from './socket-boundary.ts';
import { rosterKey } from './peer-identity.ts';
import { reconcileRejoin, type RejoinVerdict } from './rejoin.ts';
import { meshHealTargets } from './roster.ts';
import {
  LATE_JOIN_REPORT_AFTER_MS,
  sessionFlag,
  sessionMachine,
  Telemetry,
  type SessionCheck,
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

  // The last disagreement reported for each flag, so one that stays wrong is
  // reported once and not at every read, whatever the other flags are doing.
  const lastDisagreement = new Map<SessionCheck, string>();
  /**
   * Compare one of play.js's own flags with what the machine says it should
   * be, and report a disagreement. Returns whether they agree.
   */
  const check = (name: SessionCheck, page: boolean): boolean => {
    const machineState = state();
    const agrees = sessionFlag(machineState, name) === page;
    if (agrees) {
      lastDisagreement.delete(name);
      return true;
    }
    const key = `${machineState}:${page}`;
    if (lastDisagreement.get(name) !== key) {
      lastDisagreement.set(name, key);
      sink({ type: 'session-disagree', machine: machineState, check: name, page });
    }
    return false;
  };

  return {
    send,
    state,
    /** A game is on for this page: it is anywhere but the lobby. */
    gameOn: (): boolean => sessionFlag(state(), 'gameRunning'),
    check,
    /**
     * Called when the signaling socket comes back: does the machine agree
     * with the `gameRunning` flag play.js still keeps beside it? The machine
     * decides either way; a disagreement is reported so production can show
     * when the flag can be deleted.
     */
    socketUp: (page: { gameRunning: boolean }): Promise<boolean> => {
      send({ type: 'socketUp' });
      return Promise.resolve(check('gameRunning', page.gameRunning));
    },
    /**
     * The server acknowledged a rejoin after a socket drop. Moves the machine
     * if the page is out of step and says what the page must do about it.
     */
    rejoined: (room: { playing: boolean; matchId: string | null }): RejoinVerdict => {
      const verdict = reconcileRejoin(
        state() !== 'lobby',
        snapshot.context.matchId ?? '',
        room.playing,
        room.matchId ?? '',
      );
      send({ type: 'rejoined', playing: room.playing, matchId: room.matchId });
      return verdict === 'gameEnded' || verdict === 'matchReplaced' ? verdict : 'keep';
    },
    stop: (): Promise<void> => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
};

export const KNCore = {
  bootTimedOut,
  createConnectTracker,
  createSession,
  decodeInput,
  encodeInput,
  meshHealTargets,
  rosterKey,
  shouldResumeRomTransfer,
  protocol: {
    decodeUsersUpdated,
    decodeGameStarted,
    decodeGameEnded,
    decodeJoinRoomAck,
    decodeRomSharingUpdated,
    decodeTokenMessage,
    checkServerMessage,
    createObserver: createProtocolObserver,
  },
};

declare global {
  interface Window {
    KNCore?: typeof KNCore;
  }
}

if (typeof window !== 'undefined') window.KNCore = KNCore;
