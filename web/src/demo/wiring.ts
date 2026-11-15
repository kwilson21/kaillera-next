/**
 * The demo page's wiring: booting the emulator, starting the rollback engine
 * against a synthetic player 2, and connecting the menu autopilot and the
 * fake peer to it. Moved from web/static/demo.js unchanged in behaviour. These
 * are page effects with nothing to compare: tests/ts/demo-page.test.ts runs
 * the page beside the script it replaced and holds it to everything the old
 * one showed and handed the engine, the peer and the emulator.
 *
 * Every timer and global here is the page's own (`page`), as the old script's
 * were. demo.js keeps what the page shows (the status line, the buttons, the
 * HUD) and the progress of a recording and of the autopilot, and is asked for
 * them through `WiringDeps`.
 */
import type { FakeNetworkChange, FakePeerStart } from '../page/fake-peer.ts';
import type { MenuAutopilot, MenuAutopilotOptions } from '../page/menu-autopilot.ts';
import type { KeyMap } from '../page/shared.ts';
import { P1_TRANSITIONS, p1ScriptedInput, p2ScriptedInput, recordedFrame, wholeInput, zeroInput } from './autopilot.ts';
import type { PadInput, RecordedFrame } from './autopilot.ts';
import type { RecordMode } from './options.ts';
import type { RunEvent, RunFlags } from './run-state.ts';

/** The socket id of the demo's one real player. */
export const DEMO_SOCKET_ID = 'demo-local';

/** How long the loader may take before the page counts the boot as done anyway. */
const LOADER_SETTLE_MS = 30000;
/** How long the patched core may take to be ready before the loader goes in regardless. */
const CORE_READY_MS = 15000;
/** How often the page looks for the C rollback engine taking over. */
const ROLLBACK_READY_EVERY_MS = 250;

/** `KNShared.readLocalInput`: this page's controller, as the engine reads it. */
type ReadLocalInput = (playerSlot: number, keyMap: KeyMap | null | undefined, heldKeys: Set<number>) => PadInput;

/** The fake socket the engine signals on: the demo has no server. */
interface DemoSocket {
  readonly id: string;
  readonly connected: boolean;
  readonly on: () => void;
  readonly off: () => void;
  readonly emit: () => void;
}

/** What the demo starts the engine with (`NetplayRollback.init`). */
export interface DemoEngineConfig {
  readonly socket: DemoSocket;
  readonly playerSlot: number;
  readonly isSpectator: boolean;
  readonly syntheticSlots: readonly number[];
  readonly resyncEnabled: boolean;
  readonly skipInitialStateSync: boolean;
  readonly romHash: string | null;
  readonly disableStandardCheats: boolean;
  readonly skipSmashTitleWait: boolean;
  readonly lateJoin: boolean;
  readonly isMobile: boolean;
  readonly initialPlayers: {
    readonly players: {
      readonly [socketId: string]: { readonly socketId: string; readonly slot: number; readonly playerName: string };
    };
    readonly spectators: { readonly [socketId: string]: never };
  };
  readonly onStatus: (message: string) => void;
  readonly onToast: (message: string) => void;
  readonly onSyncStatus: (message: string) => void;
  readonly onReconnecting: () => void;
  readonly onPlayersChanged: () => void;
}

/** The rollback engine (`window.NetplayRollback`), as far as the demo starts and reads it. */
export interface DemoEngine {
  readonly init: (config: DemoEngineConfig) => void;
  readonly setDemoMode?: ((on: boolean) => void) | undefined;
  readonly readRdram32?: ((addr: number) => number | null | undefined) | undefined;
  readonly getHudCounters?: (() => { readonly currentFrame?: number | undefined } | null | undefined) | undefined;
  readonly isCRollback?: (() => boolean) | undefined;
  readonly isInMatch?: (() => boolean) | undefined;
  readonly setDelayRetuneEnabled?: ((on: boolean) => void) | undefined;
}

/** A script element, as far as the boot sets it up. */
interface LoaderScript {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

/** The page: its document, timers and the globals the emulator, engine, peer and autopilot meet on. */
export interface WiringPage {
  readonly document: {
    readonly createElement: (tag: 'script') => LoaderScript;
    readonly body: { readonly appendChild: (node: LoaderScript) => void };
  };
  readonly addEventListener: (type: string, listener: () => void) => void;
  readonly removeEventListener: (type: string, listener: () => void) => void;
  readonly setTimeout: (run: () => void, ms: number) => number;
  readonly clearTimeout: (id: number) => void;
  readonly console: { readonly warn: (...args: unknown[]) => void };
  readonly __test_skipBoot?: unknown;
  readonly EJS_emulator?: unknown;
  readonly _knCoreReady?: PromiseLike<unknown> | undefined;
  EJS_startOnLoaded?: boolean;
  EJS_gameUrl?: string;
  EJS_gameID?: string;
  KNEmulatorResumeContext?: unknown;
  readonly KNShared?: { resetBootState?: (() => void) | undefined; readLocalInput?: ReadLocalInput | undefined };
  readonly KNState?:
    | { room: unknown; matchId: unknown; uploadToken: unknown; slot: unknown; romHash: unknown }
    | null
    | undefined;
  readonly NetplayRollback?: DemoEngine | undefined;
  readonly KNMenuAutopilot?: { readonly create: (options: MenuAutopilotOptions) => MenuAutopilot } | undefined;
  readonly KNFakePeer?:
    | {
        readonly start?: ((options: FakePeerStart) => void) | undefined;
        readonly setNetwork?: ((change: FakeNetworkChange) => void) | undefined;
        readonly setMatchActive?: ((active: boolean | null) => void) | undefined;
      }
    | undefined;
  __knDemoP2LiveInput?: PadInput;
}

/** The ROM the page has loaded. */
export interface DemoRom {
  /** Its object URL, which the emulator loads; null before a ROM is dropped. */
  readonly url: string | null;
  readonly hash: string | null;
  /** The US SSB64, the one ROM the closed-loop menu autopilot knows. */
  readonly ssb64Us: boolean;
}

/** What demo.js tells the wiring, and is told by it. */
export interface WiringDeps {
  readonly run: () => { readonly flags: () => RunFlags; readonly send: (event: RunEvent) => void };
  readonly setStatus: (message: string) => void;
  /** EmulatorJS's settings, put on the page again at each boot (ejs-globals.ts). */
  readonly installEjsGlobals: () => void;
  readonly rom: () => DemoRom;
  /** `?record=` (p1 or p2), or true once a recording was started by hand. */
  readonly recordMode: () => RecordMode | true;
  /** A recording is running: each frame's real input is kept. */
  readonly recording: () => boolean;
  readonly record: (frame: RecordedFrame) => void;
  readonly autopilotActive: () => boolean;
  /** `?randomP1`: player 1 plays random input once in a match. */
  readonly randomP1InMatch: boolean;
  readonly randomP1InputForFrame: (frame: number) => PadInput;
  /** The input hook is in, and what it started: a recording or the autopilot. */
  readonly inputHooked: (started: 'recording' | 'autopilot') => void;
  /** The network the fake peer simulates, as the page's controls set it. */
  readonly network: () => FakeNetworkChange;
}

export const createDemoWiring = (page: WiringPage, deps: WiringDeps) => {
  // The fake socket the engine signals on: the demo has no server.
  const noop = (): void => {};
  const socket: DemoSocket = { id: DEMO_SOCKET_ID, connected: true, on: noop, off: noop, emit: noop };

  let menuPilot: MenuAutopilot | null = null;
  let inputHookInstalled = false;

  /** Load the emulator with the ROM the page has, unless it is loading or loaded. */
  const boot = ({ forceStartOnLoad = true }: { readonly forceStartOnLoad?: boolean } = {}): void => {
    if (page.__test_skipBoot) return;
    const romUrl = deps.rom().url;
    if (page.EJS_emulator || deps.run().flags().bootInFlight || !romUrl) return;

    deps.installEjsGlobals();
    page.EJS_startOnLoaded = !!forceStartOnLoad;
    page.EJS_gameUrl = romUrl;
    page.EJS_gameID = 'kaillera-next-demo';
    page.KNEmulatorResumeContext = null;
    page.KNShared?.resetBootState?.();

    const injectLoader = (): void => {
      if (deps.run().flags().loaderInjected) return;
      deps.run().send({ type: 'loaderInjected' });
      let bootDoneTimer: number | null = null;
      const markBootDone = (): void => {
        deps.run().send({ type: 'loaderSettled' });
        if (bootDoneTimer) {
          page.clearTimeout(bootDoneTimer);
          bootDoneTimer = null;
        }
        page.removeEventListener('kn-ejs-loader-complete', markBootDone);
      };
      page.addEventListener('kn-ejs-loader-complete', markBootDone);
      bootDoneTimer = page.setTimeout(markBootDone, LOADER_SETTLE_MS);

      const script = page.document.createElement('script');
      script.src = '/static/ejs-loader.js';
      script.onload = () => {
        deps.setStatus('Emulator loader ready');
      };
      script.onerror = () => {
        markBootDone();
        deps.setStatus('Failed to load emulator');
      };
      page.document.body.appendChild(script);
    };

    if (page._knCoreReady) {
      const timeout = new Promise((_, reject) =>
        page.setTimeout(() => reject(new Error('Core load timeout')), CORE_READY_MS),
      );
      Promise.race([page._knCoreReady, timeout]).then(injectLoader, injectLoader);
    } else {
      injectLoader();
    }
  };

  const currentFrameOr = (none: number): number => page.NetplayRollback?.getHudCounters?.()?.currentFrame ?? none;

  // No input-lag simulation here: the engine applies every player's input,
  // yours included, `delay` frames after it's read, so each mode's delay is
  // real — rollback's small delay (the trip minus the rollback budget),
  // lockstep's whole trip.
  //
  // Wrap KNShared.readLocalInput once. In record mode, capture inputs to a
  // buffer indexed by current engine frame. Otherwise, replay scripted inputs
  // from the recorded script (or pass real input through if the autopilot has
  // no entry for this frame yet).
  const installInputHook = (): void => {
    const shared = page.KNShared;
    if (inputHookInstalled || !shared?.readLocalInput) return;
    const original = shared.readLocalInput.bind(shared);
    shared.readLocalInput = (playerSlot, keyMap, heldKeys) => {
      const realInput = original(playerSlot, keyMap, heldKeys);
      const recordMode = deps.recordMode();
      if (recordMode === 'p1') {
        if (deps.recording()) deps.record(recordedFrame(currentFrameOr(-1), realInput));
        return realInput;
      }
      if (recordMode === 'p2') {
        // P2 record: P1 follows the baked autopilot, the keyboard is P2's
        // input. Kept for the recording, and published for the fake peer to
        // send as P2's input this frame instead of zero or random.
        const currentFrame = currentFrameOr(-1);
        if (deps.recording()) deps.record(recordedFrame(currentFrame, realInput));
        page.__knDemoP2LiveInput = wholeInput(realInput);
        return p1ScriptedInput(currentFrame) ?? zeroInput();
      }
      // Replay: while the autopilot runs, real input is ignored for the
      // script, looked up by the engine's frame so it applies at the frame it
      // was captured even when the engine stalls or rolls back.
      if (deps.autopilotActive()) {
        const currentFrame = currentFrameOr(0);
        if (menuPilot) return menuPilot.p1(currentFrame);
        return p1ScriptedInput(currentFrame) ?? zeroInput();
      }
      if (deps.randomP1InMatch && page.NetplayRollback?.isInMatch?.()) {
        return deps.randomP1InputForFrame(currentFrameOr(0));
      }
      return realInput;
    };
    inputHookInstalled = true;
    const recordMode = deps.recordMode();
    if (recordMode) {
      deps.inputHooked('recording');
      const label = recordMode === 'p2' ? 'P2' : 'P1';
      deps.setStatus(`REC mode (${label}) — play through to a match. Recording stops automatically.`);
    } else if (P1_TRANSITIONS.length > 0) {
      deps.inputHooked('autopilot');
      // Freeze DELAY_FRAMES while the autopilot runs: its presses are ~5
      // frames long, and a delay change mid-press reads the input ring at
      // another frame and drops the press. demo.js's _finishAutopilot turns
      // it back on. Predictions stay live: with the handshake's delay of 2,
      // the delay the script was recorded at, the outcome is deterministic.
      page.NetplayRollback?.setDelayRetuneEnabled?.(false);
      deps.setStatus('Setting up your match…');
    }
  };

  /**
   * Start the engine with player 2 synthetic, the autopilot and the fake
   * peer. False, with the reason on the status line, when the engine is not
   * on the page.
   */
  const startEngine = (): boolean => {
    const engine = page.NetplayRollback;
    if (!engine) {
      deps.setStatus('Rollback engine missing');
      return false;
    }

    const state = page.KNState;
    if (state) {
      state.room = 'DEMO';
      state.matchId = null;
      state.uploadToken = null;
      state.slot = 0;
      state.romHash = null;
    }

    engine.init({
      socket,
      playerSlot: 0,
      isSpectator: false,
      syntheticSlots: [1],
      resyncEnabled: false,
      skipInitialStateSync: true,
      // The ROM's hash lets the engine tell Smash Remix apart and read its
      // game status where Remix keeps it, not through SSB64's pointer.
      romHash: deps.rom().hash,
      disableStandardCheats: true,
      skipSmashTitleWait: true,
      lateJoin: false,
      isMobile: false,
      initialPlayers: {
        players: {
          [DEMO_SOCKET_ID]: {
            socketId: DEMO_SOCKET_ID,
            slot: 0,
            playerName: 'You',
          },
        },
        spectators: {},
      },
      onStatus: (message: string) => {
        deps.setStatus(message);
      },
      onToast: deps.setStatus,
      onSyncStatus: deps.setStatus,
      onReconnecting: noop,
      onPlayersChanged: noop,
    });
    deps.run().send({ type: 'engineStarted' });

    // Demo mode turns off the engine's pacing throttle. Without it the engine
    // keeps pace with the (artificially slow) synthetic peer, which looks just
    // like lockstep. With it the engine runs at full speed, predicts slot 1's
    // missing input and rolls back when the input that arrives differs.
    page.NetplayRollback?.setDemoMode?.(true);

    const recordMode = deps.recordMode();
    if (deps.rom().ssb64Us && !recordMode && page.KNMenuAutopilot && engine.readRdram32) {
      menuPilot = page.KNMenuAutopilot.create({
        read32: (addr) => page.NetplayRollback?.readRdram32?.(addr),
        log: (msg) => page.console.warn(`[demo] ${msg}`),
        // The fake peer asks P2's actor for frames ahead of the engine.
        currentFrame: () => currentFrameOr(0),
      });
    }
    installInputHook();

    // The fake peer starts at once: the engine needs slot 1's input from
    // frame 0, through the lockstep menus and after C rollback engages.
    // Waiting for isCRollback() deadlocks a game whose menus need slot 1.
    const pilot = menuPilot;
    page.KNFakePeer?.start?.({
      slot: 1,
      getCurrentFrame: () => currentFrameOr(0),
      // P2's menu inputs: the closed-loop autopilot's, or the recorded
      // script's. None in ?record=p2, where the player is P2 and the fake
      // peer sends the live input published above instead.
      getMirroredInput:
        deps.recordMode() === 'p2' ? null : pilot ? (frame) => pilot.p2(frame) : (frame) => p2ScriptedInput(frame),
    });
    // The handshake picks the delay once, before the autopilot runs, at the
    // slider's starting (menu) RTT: delay 2, the one the script was recorded
    // at. The live delay re-tune and the slider's sweep to the player's RTT
    // take it from there once the autopilot is done.
    page.KNFakePeer?.setNetwork?.(deps.network());
    return true;
  };

  /** Once the C rollback engine has taken over, `engaged` runs; until then the page looks again. */
  const pollRollbackReady = (engaged: () => void): void => {
    const look = (): void => {
      if (!deps.run().flags().engineStarted) return;
      if (page.NetplayRollback?.isCRollback?.()) {
        engaged();
        return;
      }
      page.setTimeout(look, ROLLBACK_READY_EVERY_MS);
    };
    look();
  };

  return {
    boot,
    startEngine,
    pollRollbackReady,
    /** demo.js's word on whether a match is on, for the fake peer's random input. */
    fakePeerMatchActive: (active: boolean | null): void => page.KNFakePeer?.setMatchActive?.(active),
    /** The closed-loop menu autopilot, once the engine has started with one. */
    menuPilot: (): MenuAutopilot | null => menuPilot,
  };
};
