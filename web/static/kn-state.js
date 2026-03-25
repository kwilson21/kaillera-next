/**
 * kn-state.js — Centralized cross-module state for kaillera-next.
 *
 * Replaces scattered window.* globals with a single namespace.
 * Load before all other kaillera-next scripts.
 */
(function () {
  'use strict';

  // N64 input bitmask indices (shared between virtual-gamepad,
  // netplay-lockstep, netplay-streaming, and gamepad-manager).
  const INPUT = Object.freeze({
    A: 0, B: 1, START: 3,
    D_UP: 4, D_DOWN: 5, D_LEFT: 6, D_RIGHT: 7,
    L: 10, R: 11, Z: 12,
    STICK_RIGHT: 16, STICK_LEFT: 17, STICK_DOWN: 18, STICK_UP: 19,
    C_LEFT: 20, C_RIGHT: 21, C_DOWN: 22, C_UP: 23,
  });

  window.KNState = {
    INPUT: INPUT,

    // ── Cross-module state ──
    // Each property replaces a former window.* global.
    // Writers and readers are documented inline.

    remapActive: false,      // play.js → lockstep.js, streaming.js
    touchInput: {},          // virtual-gamepad.js → lockstep.js, streaming.js
    peers: {},               // lockstep/streaming.js → play.js
    frameNum: 0,             // lockstep.js → play.js info overlay
    delayAutoValue: 2,       // play.js → lockstep.js
  };
})();
