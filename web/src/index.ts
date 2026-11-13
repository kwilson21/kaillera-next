/**
 * Entry point of the TypeScript core, bundled to web/static/dist/kn-core.js
 * and exposed to the plain-script pages as `window.KNCore`.
 */
import { Effect, Exit, Scope } from 'effect';
import { createEffectActor } from '@xstate/effect';
import { initialTransition, transition } from 'xstate';
import { bootTimedOut } from './boot.ts';
import { decodeDesyncDigest } from './desync-digest.ts';
import { fieldsToFlag } from './desync-fields.ts';
import { audioTransition, hashPixels, measureCanvasHealth, screenshotCrop } from './diagnostics.ts';
import { decodeGamepadProfile } from './gamepad-profile.ts';
import { analogScale, axisSign, digitalSnap, gamepadDisplayName, normalizeAxis } from './gamepad-axes.ts';
import { digestFrame } from './desync-confirm.ts';
import { decodeInput, encodeInput, inputEqual } from './input-wire.ts';
import {
  decodeGameEnded,
  decodeGameStarted,
  decodeJoinRoomAck,
  decodeRomSharingUpdated,
  decodeTokenMessage,
  decodeUsersUpdated,
} from './protocol.ts';
import { checkPeerText, checkRelay } from './peer-protocol.ts';
import * as delay from './play/delay.ts';
import * as menus from './play/menus.ts';
import * as notices from './play/notices.ts';
import * as observe from './play/observe.ts';
import * as remapWizard from './play/remap-wizard.ts';
import * as romTransfer from './play/rom-transfer.ts';
import * as roomView from './play/room-view.ts';
import { newStoredRom, openRomLibrary, romLibraryHtml } from './play/rom-library.ts';
import { escapeHtml, inviteUrl, roomClosedMessage, rosterToasts } from './play/room-text.ts';
import {
  formatRomSize,
  hashRom,
  hostRomFromData,
  hostRomIdentityKey,
  romFromArchive,
  romHashMismatch,
} from './play/rom.ts';
import { createConnectTracker, shouldResumeRomTransfer } from './reconnect.ts';
import { checkServerMessage, createProtocolObserver } from './socket-boundary.ts';
import { startLateJoinWait } from './late-join-wait.ts';
import { rosterKey } from './peer-identity.ts';
import { reconcileRejoin, type RejoinVerdict } from './rejoin.ts';
import { startRejoin, type RejoinHandle, type RejoinOptions, type RejoinOutcome } from './rejoin-attempt.ts';
import { checkRelayed } from './relay.ts';
import { meshHealTargets } from './roster.ts';
import { classifyRunnerStep } from './runner-step.ts';
import { createStickDeadband } from './stick-deadband.ts';
import { createSyncLogRing } from './sync-log-ring.ts';
import { createRomResumeAnswerer } from './rom-resume.ts';
import { heldAsLateJoiner } from './start-cohort.ts';
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
export const createSession = (
  sink: ReportSink,
  lateJoinReportAfterMs: number = LATE_JOIN_REPORT_AFTER_MS,
  /**
   * Called when a page that joined a match in play gets into it (running,
   * or let into its start). The page tells the server, which until then
   * counts this player as waiting and ends a match only waiting players
   * are left in (`match-joined`; specs/room_lifecycle.qnt,
   * anAbandonedMatchIsEnded).
   */
  onMatchJoined: (matchId: string) => void = () => undefined,
) => {
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
  // The rejoin in flight, if any. The session owns it: it starts only while
  // a game is on, ends with the socket or the game, and tells the machine
  // when the server refuses it.
  let currentRejoin: { cancel: () => void } | null = null;
  const cancelRejoin = (): void => {
    currentRejoin?.cancel();
    currentRejoin = null;
  };

  // This page came into its match by joining one already in play.
  let joinedMidMatch = false;
  /** The match this page joined in play and is now in; null otherwise. */
  const joinedMatch = (): string | null =>
    joinedMidMatch && snapshot.value === 'running' ? snapshot.context.matchId : null;
  const send = (event: SessionEvent): void => {
    const before = joinedMatch();
    [snapshot] = transition(sessionMachine, snapshot, event);
    if (snapshot.value === 'lobby') joinedMidMatch = false;
    else if (event.type === 'joined') joinedMidMatch = true;
    // A rejoin in flight belongs to the socket and the game it started
    // under: when either goes, so does it.
    if (event.type === 'socketDown' || snapshot.value === 'lobby') cancelRejoin();
    if (actor) actor.send(event);
    else held.push(event);
    const now = joinedMatch();
    if (now !== null && now !== before) onMatchJoined(now);
  };

  return {
    send,
    state,
    joinedMatch,
    /** A game is on for this page: it is anywhere but the lobby. */
    gameOn: (): boolean => sessionFlag(state(), 'gameRunning'),
    /**
     * One of the page's late-join questions, answered by the machine: is the
     * next engine start a late join (`lateJoin`), is the page waiting for a
     * ROM before it can late-join (`pendingLateJoin`).
     */
    flag: (name: SessionCheck): boolean => sessionFlag(state(), name),
    /** The signaling socket came back. */
    socketUp: (): void => send({ type: 'socketUp' }),
    /**
     * Take this page's place in the room back after its socket returned
     * (web/src/rejoin-attempt.ts). Does nothing in the lobby, where there is
     * no game to resume. A newer call, a socket that drops again, or a game
     * that ends cancels the one in flight, and its outcome is then never
     * delivered. A refusal moves the machine to the lobby (`rejoinRefused`)
     * before `onOutcome` hears of it, so the page only has to clean up and
     * join again; on `resumed` the page reports what the room is doing with
     * `rejoined`.
     */
    startRejoin: <Room>(options: RejoinOptions<Room>, onOutcome: (outcome: RejoinOutcome<Room>) => void): boolean => {
      cancelRejoin();
      if (state() === 'lobby') return false;
      const handle: RejoinHandle<Room> = startRejoin(options);
      currentRejoin = handle;
      void handle.outcome.then((outcome) => {
        if (currentRejoin !== handle) return;
        currentRejoin = null;
        if (outcome.kind === 'dropped') send({ type: 'rejoinRefused' });
        onOutcome(outcome);
      });
      return true;
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
    stop: (): Promise<void> => {
      cancelRejoin();
      return Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
};

export const KNCore = {
  analogScale,
  audioTransition,
  axisSign,
  bootTimedOut,
  classifyRunnerStep,
  checkRelayed,
  createConnectTracker,
  createSession,
  createStickDeadband,
  createSyncLogRing,
  decodeDesyncDigest,
  decodeGamepadProfile,
  decodeInput,
  desyncFieldsToFlag: fieldsToFlag,
  digitalSnap,
  encodeInput,
  gamepadDisplayName,
  hashPixels,
  inputEqual,
  measureCanvasHealth,
  digestFrame,
  createRomResumeAnswerer,
  heldAsLateJoiner,
  meshHealTargets,
  normalizeAxis,
  rosterKey,
  screenshotCrop,
  startLateJoinWait,
  startRejoin,
  shouldResumeRomTransfer,
  /** The play page's own logic, moving here from web/static/play.js piece by piece. */
  play: {
    escapeHtml,
    inviteUrl,
    roomClosedMessage,
    rosterToasts,
    formatRomSize,
    hashRom,
    hostRomFromData,
    hostRomIdentityKey,
    romFromArchive,
    romHashMismatch,
    newStoredRom,
    openRomLibrary,
    romLibraryHtml,
    delay,
    observe,
    remapWizard,
    romTransfer,
    roomView,
    notices,
    menus,
  },
  protocol: {
    decodeUsersUpdated,
    decodeGameStarted,
    decodeGameEnded,
    decodeJoinRoomAck,
    decodeRomSharingUpdated,
    decodeTokenMessage,
    checkServerMessage,
    checkPeerText,
    checkRelay,
    createObserver: createProtocolObserver,
  },
};

declare global {
  interface Window {
    KNCore?: typeof KNCore;
  }
}

if (typeof window !== 'undefined') window.KNCore = KNCore;
