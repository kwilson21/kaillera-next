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
(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') || 'lockstep';

  if (mode !== 'lockstep') {
    window._knCoreReady = Promise.resolve();
    window._knCoreRestore = () => {};
    return;
  }

  window._kn_usePatchedCore = true;
  console.log('[core-redirector] Lockstep mode: loading patched core');

  const CORE_FILENAME = 'mupen64plus_next-wasm.data';
  const LOCAL_CORE_URL = `/static/ejs/cores/${CORE_FILENAME}`;

  // ── IDB cache clear (awaitable) ────────────────────────────────────
  // Clear EmulatorJS IDB cache once so it re-downloads from our intercepted URL.
  // Tracked via localStorage to avoid deadlocking multi-tab scenarios.
  const CORE_VERSION = '11';
  let idbClearPromise;
  try {
    if (localStorage.getItem('kn-core-version') === CORE_VERSION) {
      idbClearPromise = Promise.resolve();
    } else if (indexedDB.databases) {
      idbClearPromise = indexedDB.databases().then((databases) => {
        const deletes = databases
          .filter((db) => db.name && (db.name.includes('emulator') ||
              db.name.includes('EJS') || db.name.includes('ejs') ||
              db.name.includes('/data/')))
          .map((db) => new Promise((resolve) => {
            const req = indexedDB.deleteDatabase(db.name);
            req.onsuccess = resolve;
            req.onerror = resolve;
            req.onblocked = resolve;
          }));
        return Promise.all(deletes);
      }).then(() => {
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
  const origFetch = window.fetch;
  const origXHROpen = XMLHttpRequest.prototype.open;

  // NOTE: kept as function — uses `this` and `arguments`
  window.fetch = function(url, opts) {
    const u = typeof url === 'string' ? url : (url?.url ?? '');
    if (u.includes(CORE_FILENAME)) {
      console.log('[core-redirector] Redirecting core fetch to:', LOCAL_CORE_URL);
      return origFetch.call(this, LOCAL_CORE_URL, opts);
    }
    return origFetch.apply(this, arguments);
  };

  // NOTE: kept as function — uses `this` and `arguments`
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && url.includes(CORE_FILENAME)) {
      console.log('[core-redirector] Redirecting XHR core to:', LOCAL_CORE_URL);
      arguments[1] = LOCAL_CORE_URL;
    }
    return origXHROpen.apply(this, arguments);
  };

  // ── Restore (called by destroyEmulator) ────────────────────────────
  window._knCoreRestore = () => {
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origXHROpen;
    console.log('[core-redirector] Restored native fetch/XHR');
  };
})();
