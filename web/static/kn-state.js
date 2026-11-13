/**
 * kn-state.js — Centralized cross-module state for kaillera-next.
 *
 * Replaces scattered window.* globals with a single namespace.
 * Load before all other kaillera-next scripts.
 */
(function () {
  'use strict';

  const { get: safeGet, set: safeSet, remove: safeRemove } = KNStorage;

  // The shape and starting values are KNCore.initialKNState
  // (web/src/kn-state.ts), where each field is typed. The literal below is
  // the same state, for a page that does not load the bundle (the demo
  // page); tests/ts/kn-state.test.ts holds the two to the same fields.
  const initial = window.KNCore?.initialKNState;
  if (initial) {
    window.KNState = initial(KNStorage);
    return;
  }

  window.KNState = {
    // ── Cross-module state ──
    // Each property replaces a former window.* global.
    // Writers and readers are documented inline.

    remapActive: false, // play.js → lockstep.js, streaming.js
    touchInput: {}, // virtual-gamepad.js → lockstep.js, streaming.js
    peers: {}, // lockstep/streaming.js → play.js
    frameNum: 0, // lockstep.js → play.js info overlay
    delayAutoValue: 2, // play.js → lockstep.js
    romHash: null, // play.js → gamepad-manager.js (per-game profiles)
    gameId: null, // play.js → lockstep.js game-specific guards
    room: null, // play.js → shared.js (KNEvent beacon)
    slot: -1, // play.js → shared.js (KNEvent beacon)
    uploadToken: null, // play.js → shared.js (KNEvent beacon)
    sessionStats: { reconnects: 0, desyncs: 0, stalls: 0 }, // play.js, lockstep.js → pagehide summary
    matchId: null, // signaling game-started → lockstep flush interval
    isLocalHost: false, // play.js → kn-desync-detector.js
    boardFrame: false, // play.js → kn-diagnostics.js (host of a listed room: larger screenshots)

    // ── Constants ──
    DEFAULT_ICE_SERVERS: [{ urls: 'stun:stun.cloudflare.com:3478' }],

    // ── Safe storage helpers ──
    safeGet,
    safeSet,
    safeRemove,
  };
})();
