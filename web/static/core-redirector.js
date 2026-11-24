/**
 * core-redirector.js — Redirect EmulatorJS core download to self-hosted patched version.
 *
 * Must be loaded BEFORE EmulatorJS loader.js.
 * Serve the bundled N64 core for every mode, including streaming, where
 * only the host runs the emulator. Rollback/lockstep additionally use
 * the core's deterministic timing and kn_pre_tick exports.
 *
 * Intercepts stay active while EmulatorJS is alive. Call
 * window._knCoreRestore() in destroyEmulator() to restore native APIs.
 * Await window._knCoreReady before injecting the EJS loader to ensure
 * IDB cache clear has completed.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') || 'rollback';
  let streaming;
  let coreInfo = null;
  let streamHash = '';
  let rollbackCacheReady;

  // EmulatorJS checks for updates on localhost. Keep that separate version
  // request local too; the game's CSP doesn't allow the CDN.
  const isVersionCheck = (u) => u.includes('cdn.emulatorjs.org') && u.includes('version.json');
  const LOCAL_VERSION_URL = '/static/ejs/version.json';

  const setCoreMode = (gameMode) => {
    streaming = gameMode === 'streaming';
    if (streaming) {
      // Streaming keys EJS's N64 cache on the archive hash. Empty bypasses
      // IndexedDB entirely, rather than guessing which bytes are cached.
      window._knStreamingCoreHash = streamHash;
      delete window._kn_usePatchedCore;
      delete window._knCoreHash;
      delete window._knCoreWorkerHash;
    } else {
      delete window._knStreamingCoreHash;
      window._kn_usePatchedCore = true;
      if (coreInfo?.url) {
        window._knCoreHash = coreInfo.hash || '';
        window._knCoreWorkerHash = coreInfo.workerHash || '';
      }
    }
  };
  setCoreMode(mode);

  // iOS Safari can choose parallel_n64, and EJS appends -thread for its
  // saved Threads setting, then -legacy when using the legacy renderer.
  const N64_ARCHIVE = /\/cores\/(?:mupen64plus_next|parallel_n64)(?:-thread)?(?:-legacy)?-wasm\.data$/;
  const N64_REPORT = /\/cores\/reports\/(mupen64plus_next|parallel_n64)\.json$/;
  const pathname = (url) => {
    try {
      return new URL(url, window.location.href).pathname;
    } catch (_) {
      return '';
    }
  };

  // /api/core-info hashes the actual archive bytes. A new core gets a
  // new URL, including for Safari's other filename and report variants.
  // During an outage stay local. The streaming fallback has a distinct,
  // revalidating key so it cannot reuse the previously immutable bare URL.
  const LOCAL_CORE = '/static/ejs/cores/mupen64plus_next-wasm.data';
  const streamCacheQuery = () => (streamHash ? `h=${streamHash}` : 'revalidate=1');
  const localCoreResource = (url) => {
    if (!url) return null;
    const path = pathname(url);
    if (N64_ARCHIVE.test(path)) {
      return streaming ? `${LOCAL_CORE}?${streamCacheQuery()}` : coreInfo?.url || LOCAL_CORE;
    }
    const report = streaming && N64_REPORT.exec(path);
    return report ? `/static/ejs/cores/reports/${report[1]}.json?${streamCacheQuery()}` : null;
  };

  const coreInfoPromise = fetch('/api/core-info', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((info) => {
      coreInfo = info;
      if (info?.available !== false && typeof info?.hash === 'string' && /^[0-9a-f]{16}$/.test(info.hash)) {
        streamHash = info.hash;
      }
      setCoreMode(streaming ? 'streaming' : 'rollback');
      if (streaming ? streamHash : info?.url) {
        console.log(`[core-redirector] Bundled core resolved (size=${info.size}, hash=${info.hash})`);
      } else {
        console.warn('[core-redirector] /api/core-info returned no core metadata — staying local');
      }
    })
    .catch((err) => {
      console.warn('[core-redirector] /api/core-info fetch failed — staying local:', err);
    });

  // ── IDB cache clear ────────────────────────────────────────────────
  // Clear EmulatorJS IDB cache once per content-hash so it re-downloads
  // through our intercept whenever the core file changes. The server's
  // hash covers all archive bytes, including a rebuild.
  // The hash is kept in localStorage directly. This runs from a fetch
  // callback that can fire before the later scripts (storage.js, the bundle
  // that sets KNState) have loaded, so it depends on neither. A browser that
  // blocks storage reads no hash and clears the cache on every load.
  const readCoreHash = () => {
    try {
      return window.localStorage.getItem('kn-core-hash');
    } catch (_) {
      return null;
    }
  };
  const writeCoreHash = (hash) => {
    try {
      window.localStorage.setItem('kn-core-hash', hash);
    } catch (_) {}
  };
  // Streaming's new EJS cache key uses the archive's SHA-256 prefix directly;
  // no existing database (ROMs, core cache or saves) is deleted there.
  const clearRollbackCache = () =>
    coreInfoPromise.then(() => {
      try {
        const cacheKey = coreInfo?.hash || 'unknown';
        if (readCoreHash() === cacheKey) {
          return null;
        }
        if (typeof indexedDB === 'undefined' || !indexedDB.databases) {
          writeCoreHash(cacheKey);
          return null;
        }
        return indexedDB
          .databases()
          .then((databases) => {
            const deletes = databases
              .filter(
                (db) =>
                  db.name &&
                  // Never the player's cartridge saves: Emscripten's IDBFS
                  // names its database after its mount point, and EmulatorJS
                  // mounts the save directory at /data/saves. A new core does
                  // not change the save format.
                  db.name !== '/data/saves' &&
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
            writeCoreHash(cacheKey);
            console.log('[core-redirector] IDB cache cleared for new core hash');
          });
      } catch (_) {
        return null;
      }
    });

  // The lobby can choose a different mode without navigating. Set it at
  // the actual host boot, before EJS reads its per-mode cache key. Demo and
  // older callers still use the URL-based readiness hook.
  const prepareCore = (gameMode) => {
    setCoreMode(gameMode);
    return streaming ? coreInfoPromise : (rollbackCacheReady ??= clearRollbackCache());
  };
  window._knPrepareN64Core = prepareCore;
  Object.defineProperty(window, '_knCoreReady', { configurable: true, get: () => prepareCore(mode) });

  // ── Fetch/XHR intercept ────────────────────────────────────────────
  const origFetch = window.fetch;
  const origXHROpen = XMLHttpRequest.prototype.open;

  // NOTE: kept as function — uses `this` and `arguments`
  window.fetch = function (url, opts) {
    const u = typeof url === 'string' ? url : (url?.url ?? url?.href ?? '');
    const local = localCoreResource(u);
    if (local) {
      console.log('[core-redirector] Redirecting core fetch to:', local);
      return origFetch.call(this, local, opts);
    }
    // Redirect EmulatorJS CDN version check to local file
    if (isVersionCheck(u)) {
      return origFetch.call(this, LOCAL_VERSION_URL, opts);
    }
    return origFetch.apply(this, arguments);
  };

  // NOTE: kept as function — uses `this` and `arguments`
  XMLHttpRequest.prototype.open = function (method, url) {
    const local = localCoreResource(typeof url === 'string' ? url : url?.href);
    if (local) {
      console.log('[core-redirector] Redirecting XHR core to:', local);
      arguments[1] = local;
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
