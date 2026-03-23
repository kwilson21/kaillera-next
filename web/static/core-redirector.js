/**
 * core-redirector.js — Redirect EmulatorJS core download to self-hosted patched version.
 *
 * Must be loaded BEFORE EmulatorJS loader.js.
 * In lockstep mode, intercepts fetch/XHR to serve our patched core
 * (CDN WASM + JS glue with deterministic _emscripten_get_now).
 */
(function() {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') || 'lockstep';

  if (mode !== 'lockstep') return;

  window._kn_usePatchedCore = true;
  console.log('[core-redirector] Lockstep mode: loading patched core');

  const CORE_FILENAME = 'mupen64plus_next-wasm.data';
  const LOCAL_CORE_URL = `/static/ejs/cores/${CORE_FILENAME}`;

  // Clear EmulatorJS IDB cache once so it re-downloads from our intercepted URL.
  // We only do this once (tracked via localStorage) because deleteDatabase()
  // blocks while other tabs have open connections — deadlocking EmulatorJS
  // in multi-tab netplay scenarios.
  const CORE_VERSION = '2';
  try {
    if (localStorage.getItem('kn-core-version') !== CORE_VERSION && indexedDB.databases) {
      indexedDB.databases().then((databases) => {
        databases.forEach((db) => {
          if (db.name && (db.name.includes('emulator') ||
              db.name.includes('EJS') || db.name.includes('ejs') ||
              db.name.includes('/data/'))) {
            indexedDB.deleteDatabase(db.name);
          }
        });
        localStorage.setItem('kn-core-version', CORE_VERSION);
      });
    }
  } catch(_) {}

  // Intercept fetch
  const origFetch = window.fetch;
  window.fetch = function(url, opts) {
    const u = typeof url === 'string' ? url : (url && url.url ? url.url : '');
    if (u.includes(CORE_FILENAME)) {
      console.log('[core-redirector] Redirecting core fetch to:', LOCAL_CORE_URL);
      return origFetch.call(this, LOCAL_CORE_URL, opts);
    }
    return origFetch.apply(this, arguments);
  };

  // Intercept XHR
  const origXHROpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && url.includes(CORE_FILENAME)) {
      console.log('[core-redirector] Redirecting XHR core to:', LOCAL_CORE_URL);
      arguments[1] = LOCAL_CORE_URL;
    }
    return origXHROpen.apply(this, arguments);
  };
})();
