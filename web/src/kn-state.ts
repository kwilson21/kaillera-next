/**
 * `window.KNState`: the state the plain-script pages share between modules,
 * in place of scattered `window.*` globals. The bundle builds it as it
 * loads (`installKNState`), before any script that reads it.
 *
 * Each field has one or two writers and a few readers, named beside it. The
 * engines are "the engine" below whichever mode is running.
 */

/** A peer connection as other modules may read it. */
export interface PeerView {
  /** The player slot, or null for a spectator. */
  slot: number | null;
  /** The peer's data channel; null until it exists. */
  dc?: { readyState: string } | null;
  /** A simulated peer (the demo page), with no real connection. */
  synthetic?: boolean;
}

/** Counters reported once when the page is left. */
export interface SessionStats {
  reconnects: number;
  desyncs: number;
  stalls: number;
}

/** The storage helpers the state carries (web/src/site/storage.ts). */
export interface SafeStorage {
  get: (store: 'localStorage' | 'sessionStorage', key: string) => string | null;
  set: (store: 'localStorage' | 'sessionStorage', key: string, value: string) => void;
  remove: (store: 'localStorage' | 'sessionStorage', key: string) => void;
}

export interface PageState {
  /** The controller remap wizard is open. play.js writes; the engine reads. */
  remapActive: boolean;
  /** Touch-control values by input index. virtual-gamepad.js writes; the engine reads. */
  touchInput: Record<string, number>;
  /** The engine's peers by socket id. The engine writes; play.js and the desync detector read. */
  peers: Record<string, PeerView>;
  /** The engine's current frame. The engine writes; play.js shows it. */
  frameNum: number;
  /** The input delay the page picked. play.js writes; the engine reads. */
  delayAutoValue: number;
  /** The loaded ROM's hash. play.js writes; gamepad-manager.js keys per-game profiles on it. */
  romHash: string | null;
  /** The identified game. play.js writes; the engine reads for game-specific guards. */
  gameId: string | null;
  /** The room code. play.js writes; the event beacon in shared.js reads. */
  room: string | null;
  /** This player's slot: -1 before the room is joined, null for a spectator. play.js writes; the event beacon reads. */
  slot: number | null;
  /** The token for the upload endpoints. play.js writes; the event beacon reads. */
  uploadToken: string | null;
  /** play.js and the engine write; the pagehide summary reads. */
  sessionStats: SessionStats;
  /** The current match. Set from game-started; the engine's log flush reads. */
  matchId: string | null;
  /** This page is the room's host. play.js writes; the desync detector reads. */
  isLocalHost: boolean;
  /** The host of a listed room: larger screenshots. play.js writes; the diagnostics (page/diagnostics.ts) read. */
  boardFrame: boolean;

  DEFAULT_ICE_SERVERS: { urls: string }[];

  safeGet: SafeStorage['get'];
  safeSet: SafeStorage['set'];
  safeRemove: SafeStorage['remove'];
}

/** The state a page starts with. Every call returns its own objects. */
export function initialKNState(storage: SafeStorage): PageState {
  return {
    remapActive: false,
    touchInput: {},
    peers: {},
    frameNum: 0,
    delayAutoValue: 2,
    romHash: null,
    gameId: null,
    room: null,
    slot: -1,
    uploadToken: null,
    sessionStats: { reconnects: 0, desyncs: 0, stalls: 0 },
    matchId: null,
    isLocalHost: false,
    boardFrame: false,

    DEFAULT_ICE_SERVERS: [{ urls: 'stun:stun.cloudflare.com:3478' }],

    safeGet: storage.get,
    safeSet: storage.set,
    safeRemove: storage.remove,
  };
}

declare global {
  interface Window {
    KNState?: PageState;
    /** web/static/storage.js, loaded before the bundle. */
    KNStorage?: SafeStorage;
  }
}

/** The part of `window` the state lives on. */
export interface StatePage {
  KNStorage?: SafeStorage;
  KNState?: PageState;
}

/**
 * Put the starting state on `window.KNState`. The pages load storage.js
 * first; a page that did not gets no state, and says so.
 */
export function installKNState(page: StatePage): void {
  const storage = page.KNStorage;
  if (!storage) {
    console.error('[kn-state] storage.js was not loaded before the bundle; KNState is not set');
    return;
  }
  page.KNState = initialKNState(storage);
}
