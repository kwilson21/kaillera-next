/**
 * core-redirector.js — Redirect EmulatorJS core download to self-hosted patched version.
 *
 * Must be loaded BEFORE EmulatorJS loader.js.
 * In lockstep mode, intercepts fetch/XHR to serve our patched core
 * (CDN WASM + JS glue with deterministic _emscripten_get_now).
 *
 * Intercepts stay active while EmulatorJS is alive. Call
 * window._knCoreRestore() in destroyEmulator() to restore native APIs.
 * Await window._knCoreReady before injecting the EJS loader to ensure
 * IDB cache clear has completed.
 */
(function() {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var mode = params.get('mode') || 'lockstep';

  if (mode !== 'lockstep') {
    window._knCoreReady = Promise.resolve();
    window._knCoreRestore = function () {};
    return;
  }

  window._kn_usePatchedCore = true;
  console.log('[core-redirector] Lockstep mode: loading patched core');

  var CORE_FILENAME = 'mupen64plus_next-wasm.data';
  var LOCAL_CORE_URL = '/static/ejs/cores/' + CORE_FILENAME;

  // ── IDB cache clear (awaitable) ────────────────────────────────────
  // Clear EmulatorJS IDB cache once so it re-downloads from our intercepted URL.
  // Tracked via localStorage to avoid deadlocking multi-tab scenarios.
  var CORE_VERSION = '2';
  var idbClearPromise;
  try {
    if (localStorage.getItem('kn-core-version') === CORE_VERSION) {
      idbClearPromise = Promise.resolve();
    } else if (indexedDB.databases) {
      idbClearPromise = indexedDB.databases().then(function (databases) {
        var deletes = databases
          .filter(function (db) {
            return db.name && (db.name.includes('emulator') ||
              db.name.includes('EJS') || db.name.includes('ejs') ||
              db.name.includes('/data/'));
          })
          .map(function (db) {
            return new Promise(function (resolve) {
              var req = indexedDB.deleteDatabase(db.name);
              req.onsuccess = resolve;
              req.onerror = resolve;
              req.onblocked = resolve;
            });
          });
        return Promise.all(deletes);
      }).then(function () {
        localStorage.setItem('kn-core-version', CORE_VERSION);
        console.log('[core-redirector] IDB cache cleared');
      });
    } else {
      idbClearPromise = Promise.resolve();
    }
  } catch (_) {
    idbClearPromise = Promise.resolve();
  }

  // Expose for play.js to await before booting EJS
  window._knCoreReady = idbClearPromise;

  // ── Fetch/XHR intercept ────────────────────────────────────────────
  var origFetch = window.fetch;
  var origXHROpen = XMLHttpRequest.prototype.open;

  window.fetch = function(url, opts) {
    var u = typeof url === 'string' ? url : (url && url.url ? url.url : '');
    if (u.includes(CORE_FILENAME)) {
      console.log('[core-redirector] Redirecting core fetch to:', LOCAL_CORE_URL);
      return origFetch.call(this, LOCAL_CORE_URL, opts);
    }
    return origFetch.apply(this, arguments);
  };

  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && url.includes(CORE_FILENAME)) {
      console.log('[core-redirector] Redirecting XHR core to:', LOCAL_CORE_URL);
      arguments[1] = LOCAL_CORE_URL;
    }
    return origXHROpen.apply(this, arguments);
  };

  // ── Restore (called by destroyEmulator) ────────────────────────────
  window._knCoreRestore = function () {
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origXHROpen;
    console.log('[core-redirector] Restored native fetch/XHR');
  };
})();
