/**
 * deterministic-timer.js — Patches EmulatorJS core for deterministic timing.
 *
 * Two things:
 * 1. Intercepts fetch() to redirect the N64 core download to our local
 *    patched version (which has deterministic emscripten_get_now).
 * 2. Sets window._lockstepTimeBase when lockstep starts (done by engine).
 *
 * The patched core replaces:
 *   var _emscripten_get_now=()=>performance.now()
 * with:
 *   var _emscripten_get_now=()=>window._lockstepActive
 *     ? (window._lockstepTimeBase||0)+(window._frameNum||0)*16.666666
 *     : performance.now()
 *
 * During boot: real time (emulator initializes normally).
 * During lockstep: deterministic frame-based time (both sides identical).
 *
 * MUST be in <head> before EmulatorJS loader.
 * To disable: set window._deterministicWasm = false before this script.
 */

(function () {
  'use strict';

  if (window._deterministicWasm === false) return;

  // Intercept both fetch and XHR to redirect core download
  var _origFetch = window.fetch;
  window.fetch = function (url, options) {
    var urlStr = (typeof url === 'string') ? url : (url && url.url) ? url.url : '';
    if (urlStr.indexOf('mupen64plus_next') !== -1 && urlStr.indexOf('wasm') !== -1) {
      console.log('[deterministic-timer] redirecting fetch to local patched core (was: ' + urlStr.substring(0, 80) + ')');
      return _origFetch.call(this, '/static/ejs/cores/mupen64plus_next-wasm.data', options);
    }
    return _origFetch.call(this, url, options);
  };

  var _origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === 'string' && url.indexOf('mupen64plus_next') !== -1 && url.indexOf('wasm') !== -1) {
      console.log('[deterministic-timer] redirecting XHR to local patched core');
      arguments[1] = '/static/ejs/cores/mupen64plus_next-wasm.data';
    }
    return _origXHROpen.apply(this, arguments);
  };

  console.log('[deterministic-timer] fetch + XHR intercept installed');
})();
