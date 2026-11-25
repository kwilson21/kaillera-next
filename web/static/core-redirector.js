/**
 * core-redirector.js — Redirect EmulatorJS core download to self-hosted patched version.
 *
 * Must be loaded BEFORE EmulatorJS loader.js.
 * Serve the bundled N64 core for every mode, including streaming, where
 * only the host runs the emulator. Rollback/lockstep additionally use
 * the core's deterministic timing and kn_pre_tick exports.
 *
 * Await window._knCoreReady before injecting EJS. The vendored loader pins
 * its archive when it starts, including when the metadata deadline expired.
 */
(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const mode = params.get('mode') || 'rollback';
  let streaming;
  let coreInfo = null;
  let selected = null;

  // EmulatorJS checks for updates on localhost. Keep that separate version
  // request local too; the game's CSP doesn't allow the CDN.
  const isVersionCheck = (u) => u.includes('cdn.emulatorjs.org') && u.includes('version.json');
  const LOCAL_VERSION_URL = '/static/ejs/version.json';

  const setCoreMode = (gameMode) => {
    streaming = gameMode === 'streaming';
    if (streaming) {
      window._knStreamingCoreHash = selected?.hash || '';
      delete window._kn_usePatchedCore;
      delete window._knCoreHash;
      delete window._knCoreWorkerHash;
    } else {
      delete window._knStreamingCoreHash;
      window._kn_usePatchedCore = true;
      window._knCoreHash = selected?.hash || '';
      window._knCoreWorkerHash = selected?.workerHash || '';
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

  const LOCAL_CORE = '/static/ejs/cores/mupen64plus_next-wasm.data';
  const archiveKey = () => (selected ? `/api/core-archive/${selected.hash}` : '');
  const localCoreResource = (url) => {
    if (!url) return null;
    const path = pathname(url);
    if (N64_ARCHIVE.test(path)) return archiveKey() || `${LOCAL_CORE}?revalidate=1`;
    const report = N64_REPORT.exec(path);
    return report
      ? `/static/ejs/cores/reports/${report[1]}.json?${selected ? `h=${selected.hash}` : 'revalidate=1'}`
      : null;
  };

  const coreInfoPromise = fetch('/api/core-info', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((info) => {
      if (info?.available !== false && typeof info?.hash === 'string' && /^[0-9a-f]{16}$/.test(info.hash)) {
        coreInfo = info;
      } else {
        console.warn('[core-redirector] /api/core-info returned no core metadata — staying local');
      }
    })
    .catch((err) => {
      console.warn('[core-redirector] /api/core-info fetch failed — staying local:', err);
    });

  // The same checked URL identifies the HTTP body and the EJS cache entry.
  // A metadata response arriving after this boot cannot relabel its bytes.
  window._knSelectN64Archive = () => {
    selected = coreInfo;
    setCoreMode(streaming ? 'streaming' : 'rollback');
    return archiveKey();
  };
  const prepareCore = (gameMode) => {
    setCoreMode(gameMode);
    return coreInfoPromise;
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
