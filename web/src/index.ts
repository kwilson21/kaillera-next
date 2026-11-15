/**
 * Entry point of the TypeScript core, bundled to web/static/dist/kn-core.js
 * and exposed to the plain-script pages as `window.KNCore`.
 */
import { Effect, Exit, Scope } from 'effect';
import { createEffectActor } from '@xstate/effect';
import { initialTransition, transition } from 'xstate';
import { addressMapFor } from './address-maps.ts';
import { bootTimedOut } from './boot.ts';
import { demo } from './demo/index.ts';
import { decodeDesyncDigest } from './desync-digest.ts';
import { fieldsToFlag } from './desync-fields.ts';
import { audioTransition, hashPixels, measureCanvasHealth, screenshotCrop } from './diagnostics.ts';
import { installDiagnostics } from './page/diagnostics.ts';
import { decodeGamepadProfile } from './gamepad-profile.ts';
import { installGamepadManager } from './page/gamepad-manager.ts';
import { analogScale, axisSign, digitalSnap, gamepadDisplayName, normalizeAxis } from './gamepad-axes.ts';
import { captureFrame } from './desync-capture.ts';
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
import { startAudio } from './page/audio.ts';
import { startCapture } from './page/capture.ts';
import { startFakePeer } from './page/fake-peer.ts';
import { menuAutopilot } from './page/menu-autopilot.ts';
import { rollbackTimeline } from './page/rollback-timeline.ts';
import { startSwitch2Usb } from './page/switch2-usb.ts';
import { startControllerSettings } from './page/controller-settings/panel.ts';
import { startVisionClient } from './page/vision-client.ts';
import { startVirtualGamepad } from './page/virtual-gamepad/gamepad.ts';
import { checkPeerText, checkRelay } from './peer-protocol.ts';
import * as connect from './play/connect.ts';
import { installShared } from './page/shared.ts';
import * as delay from './play/delay.ts';
import * as joinPlan from './play/join-plan.ts';
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
import { mayHandChunk, sendPaced } from './sync-send.ts';
import { rosterKey } from './peer-identity.ts';
import { createPeerConnection, PEER_TIMING, peerFacts } from './peer-connection.ts';
import { createPeerObserver, newPageId, readAttemptId } from './peer-observe.ts';
import {
  disconnectDisposition,
  hasAttemptLeft,
  shouldInitiate,
  signalDisposition,
  staleHoldersOf,
} from './peer-signaling.ts';
import { installKNState } from './kn-state.ts';
import { reconcileRejoin, type RejoinVerdict } from './rejoin.ts';
import { startRejoin, type RejoinOptions, type RejoinOutcome } from './rejoin-attempt.ts';
import { rejoinMachine, RejoinResults, RejoinTransport, type RejoinedRoom } from './rejoin-machine.ts';
import { checkRelayed } from './relay.ts';
import {
  answersAnOlderRequest,
  endsRequest,
  isLateAnswerBehind,
  keepsAwaitedAnswer,
  lateJoinLostHostStep,
} from './resync-request.ts';
import { meshHealTargets } from './roster.ts';
import { classifyRunnerStep } from './runner-step.ts';
import { installSite, KNSite } from './site/index.ts';
import { installSafeStorage } from './site/storage.ts';
import { createStickDeadband } from './stick-deadband.ts';
import * as streamingAttempt from './streaming/attempt.ts';
import * as streamingInput from './streaming/input.ts';
import { createStreamingObserver } from './streaming/observe.ts';
import * as streamingReoffer from './streaming/reoffer.ts';
import * as streamingRoster from './streaming/roster.ts';
import * as streamingSignal from './streaming/signal.ts';
import * as streamingVideo from './streaming/video.ts';
import { createSyncLogRing } from './sync-log-ring.ts';
import { createRomResumeAnswerer } from './rom-resume.ts';
import { heldAsLateJoiner } from './start-cohort.ts';
import { installDesyncDetector } from './page/desync-detector.ts';
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
  // The rejoin is its own machine (rejoin-machine.ts), run by an actor in
  // this session's scope. The session gives it the request of the current
  // connection, sends it the events it shares with the lifecycle machine,
  // and hears each finished rejoin's outcome.
  let rejoinOptions: RejoinOptions<RejoinedRoom> | null = null;
  let rejoinListener: ((outcome: RejoinOutcome<RejoinedRoom>) => void) | null = null;
  type RejoinEvent = Parameters<Awaited<typeof rejoinReady>['send']>[0];
  const rejoinReady = Effect.runPromise(
    createEffectActor(rejoinMachine).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(RejoinTransport, {
        options: () => {
          if (rejoinOptions === null) throw new Error('rejoin started with no request');
          return rejoinOptions;
        },
      }),
      Effect.provideService(RejoinResults, {
        deliver: (outcome) =>
          Effect.sync(() => {
            // A refusal ends the game in the lifecycle machine before the page hears of it.
            if (outcome.kind === 'dropped') send({ type: 'rejoinRefused' });
            rejoinListener?.(outcome);
          }),
      }),
    ),
  );
  let rejoinActor: Awaited<typeof rejoinReady> | undefined;
  const rejoinHeld: RejoinEvent[] = [];
  void rejoinReady.then((a) => {
    rejoinActor = a;
    for (const event of rejoinHeld.splice(0)) a.send(event);
  });
  const sendRejoin = (event: RejoinEvent): void => {
    if (rejoinActor) rejoinActor.send(event);
    else rejoinHeld.push(event);
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
    // under; its machine leaves `rejoining` when either goes.
    if (event.type === 'socketDown') sendRejoin({ type: 'socketDown' });
    else if (snapshot.value === 'lobby') sendRejoin({ type: 'gameOver' });
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
     * Take this page's place in the room back after its socket returned:
     * starts the rejoin machine (rejoin-machine.ts) with this connection's
     * request. Does nothing in the lobby, where there is no game to resume.
     * A newer call, a socket that drops again, or a game that ends takes the
     * machine out of `rejoining`, and that rejoin's outcome is then never
     * delivered. A refusal moves the lifecycle machine to the lobby
     * (`rejoinRefused`) before `onOutcome` hears of it, so the page only has
     * to clean up and join again; on `resumed` the page reports what the
     * room is doing with `rejoined`.
     */
    startRejoin: (
      options: RejoinOptions<RejoinedRoom>,
      onOutcome: (outcome: RejoinOutcome<RejoinedRoom>) => void,
    ): boolean => {
      const gameOn = state() !== 'lobby';
      if (gameOn) {
        rejoinOptions = options;
        rejoinListener = onOutcome;
      }
      sendRejoin({ type: 'socketUp', gameOn });
      return gameOn;
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
  analogScale,
  audioTransition,
  axisSign,
  bootTimedOut,
  classifyRunnerStep,
  addressMapFor,
  captureFrame,
  checkRelayed,
  createConnectTracker,
  /** The per-peer connection machine (peer-connection.ts). The engine runs it observing, through `peerObserve`. */
  createPeerConnection,
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
  disconnectDisposition,
  hasAttemptLeft,
  heldAsLateJoiner,
  meshHealTargets,
  normalizeAxis,
  peerFacts,
  peerTiming: PEER_TIMING,
  /** The per-peer machine run beside the rollback engine, observing (peer-observe.ts). */
  peerObserve: { createPeerObserver, newPageId, readAttemptId },
  /** The guest's resync request rules (resync-request.ts); the rollback engine runs them observing. */
  resyncRequest: {
    answersAnOlderRequest,
    endsRequest,
    isLateAnswerBehind,
    keepsAwaitedAnswer,
    lateJoinLostHostStep,
  },
  rosterKey,
  screenshotCrop,
  shouldInitiate,
  signalDisposition,
  staleHoldersOf,
  startLateJoinWait,
  /** The host's resync state, a chunk at a time (sync-send.ts). */
  syncSend: { mayHandChunk, sendPaced },
  startRejoin,
  shouldResumeRomTransfer,
  /** The demo page's own logic, moving here from web/static/demo.js piece by piece. */
  demo,
  /** The play and demo pages' own scripts (Stage 6); each is started by a small caller in web/static. */
  page: {
    menuAutopilot,
    rollbackTimeline,
    startAudio,
    startCapture,
    startSwitch2Usb,
    startControllerSettings,
    startVisionClient,
    startVirtualGamepad,
    startFakePeer,
  },
  /** What these pages share with the front page; the same object is `window.KNSite` on both. */
  site: KNSite,
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
    connect,
    joinPlan,
    observe,
    remapWizard,
    romTransfer,
    roomView,
    notices,
    menus,
  },
  /**
   * The streaming engine's decisions (web/static/netplay-streaming.js still
   * makes them; `createObserver` compares), except the ones the engine asks:
   * which offers a page that receives the stream takes (`signalGate`), which
   * connection a signal belongs to (attempt.ts), and the host's deadline to
   * offer again (`startReofferDeadlines`, reoffer.ts).
   */
  streaming: {
    ...streamingRoster,
    ...streamingSignal,
    ...streamingAttempt,
    ...streamingReoffer,
    ...streamingInput,
    ...streamingVideo,
    createObserver: createStreamingObserver,
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

if (typeof window !== 'undefined') {
  window.KNCore = KNCore;
  // First: KNState, built next, carries the storage helpers.
  installSafeStorage();
  installKNState(window);
  installShared();
  installGamepadManager();
  installDiagnostics();
  installDesyncDetector();
  installSite();
}
