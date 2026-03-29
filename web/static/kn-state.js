/**
 * kn-state.js — Centralized cross-module state for kaillera-next.
 *
 * Replaces scattered window.* globals with a single namespace.
 * Load before all other kaillera-next scripts.
 */
(function () {
  'use strict';

  const { get: safeGet, set: safeSet, remove: safeRemove } = KNStorage;

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

    // ── Safe storage helpers ──
    safeGet,
    safeSet,
    safeRemove,
  };
})();
