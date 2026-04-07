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

  // EJS on mobile Safari reverses the N64 core list, picking parallel_n64 instead
  // of mupen64plus_next. Match all N64 core filenames to ensure the patched binary.
  const N64_CORE_NAMES = [
    'mupen64plus_next-wasm.data',
    'mupen64plus_next-legacy-wasm.data',
    'parallel_n64-wasm.data',
    'parallel_n64-legacy-wasm.data',
  ];

  // ── Auto-discovery: ask the server for the current core URL ────────
  //
  // The patched WASM core is served with `Cache-Control: immutable, max-age=1y`
  // (since the URL is now content-addressed). The server's /api/core-info
  // endpoint hashes the file contents and returns a URL with `?h=<sha256-prefix>`,
  // so a new WASM at the origin gets a brand-new URL that bypasses every
  // cache layer automatically. NO human bookkeeping required.
  //
  // We fetch /api/core-info ONCE at boot, before injecting the EJS loader,
  // and use the returned URL for both the fetch and XHR intercepts. If the
  // endpoint is unavailable, we fall back to the canonical un-hashed URL.
  const FALLBACK_CORE_URL = '/static/ejs/cores/mupen64plus_next-wasm.data';
  let LOCAL_CORE_URL = FALLBACK_CORE_URL;
  let CORE_HASH = '';

  const coreInfoPromise = fetch('/api/core-info', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((info) => {
      if (info?.url) {
        LOCAL_CORE_URL = info.url;
        CORE_HASH = info.hash || '';
        console.log(`[core-redirector] Core URL resolved: ${LOCAL_CORE_URL} (size=${info.size}, hash=${CORE_HASH})`);
      } else {
        console.warn('[core-redirector] /api/core-info returned no URL — using fallback');
      }
    })
    .catch((err) => {
      console.warn('[core-redirector] /api/core-info fetch failed — using fallback:', err);
    });

  // ── IDB cache clear ────────────────────────────────────────────────
  // Clear EmulatorJS IDB cache once per content-hash so it re-downloads
  // through our intercept whenever the core file changes. The CORE_HASH
  // we read above is content-addressed, so this also handles the "WASM
  // rebuilt" case automatically — no manual constant to bump.
  let idbClearPromise = coreInfoPromise.then(() => {
    try {
      const cacheKey = CORE_HASH || 'unknown';
      if (KNState.safeGet('localStorage', 'kn-core-hash') === cacheKey) {
        return null;
      }
      if (typeof indexedDB === 'undefined' || !indexedDB.databases) {
        KNState.safeSet('localStorage', 'kn-core-hash', cacheKey);
        return null;
      }
      return indexedDB
        .databases()
        .then((databases) => {
          const deletes = databases
            .filter(
              (db) =>
                db.name &&
                (db.name.includes('emulator') ||
                  db.name.includes('EJS') ||
                  db.name.includes('ejs') ||
                  db.name.includes('/data/')),
            )
            .map(
              (db) =>
                new Promise((resolve) => {
                  const req = indexedDB.deleteDatabase(db.name);
                  req.onsuccess = resolve;
                  req.onerror = resolve;
                  req.onblocked = resolve;
                }),
            );
          return Promise.all(deletes);
        })
        .then(() => {
          KNState.safeSet('localStorage', 'kn-core-hash', cacheKey);
          console.log('[core-redirector] IDB cache cleared for new core hash');
        });
    } catch (_) {
      return null;
    }
  });

  // Expose for play.js to await before booting EJS. The promise resolves
  // once both /api/core-info has returned AND the IDB cache (if needed)
  // has been cleared. After this, LOCAL_CORE_URL is the final, hashed URL.
  window._knCoreReady = idbClearPromise;

  // ── Fetch/XHR intercept ────────────────────────────────────────────
  const origFetch = window.fetch;
  const origXHROpen = XMLHttpRequest.prototype.open;

  // NOTE: kept as function — uses `this` and `arguments`
  window.fetch = function (url, opts) {
    const u = typeof url === 'string' ? url : (url?.url ?? '');
    if (isN64Core(u)) {
      console.log('[core-redirector] Redirecting core fetch to:', LOCAL_CORE_URL);
      return origFetch.call(this, LOCAL_CORE_URL, opts);
    }
    // Redirect EmulatorJS CDN version check to local file
    if (u.includes('cdn.emulatorjs.org') && u.includes('version.json')) {
      return origFetch.call(this, '/static/ejs/version.json', opts);
    }
    return origFetch.apply(this, arguments);
  };

  // NOTE: kept as function — uses `this` and `arguments`
  XMLHttpRequest.prototype.open = function (method, url) {
    if (typeof url === 'string' && isN64Core(url)) {
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
