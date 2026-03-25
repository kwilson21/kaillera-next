# Core Redirector Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scope the fetch/XHR intercept to fire only during EmulatorJS core loading, then restore the native APIs. Fix the async IDB cache deletion race condition.

**Architecture:** Instead of permanently replacing `window.fetch` and `XMLHttpRequest.prototype.open`, the redirector installs the intercepts, then watches for the core file to be loaded. Once the core `.data` file has been fetched, it restores the native APIs. The IDB cache clear uses `await` with a timeout to ensure deletion completes before EJS starts downloading.

**Tech Stack:** Vanilla JS

---

## Problem

1. `window.fetch` and `XMLHttpRequest.prototype.open` are permanently replaced. Every network request on the page goes through the interceptor forever.
2. `indexedDB.deleteDatabase()` is called without awaiting completion. EJS may start downloading before the old cache is deleted, causing it to re-use stale cached data.
3. No restoration — the original APIs are never put back.

## Design

### Scoped intercept with auto-restore:

The interceptor tracks whether the core file has been fetched. After the core fetch completes, it restores both `window.fetch` and `XMLHttpRequest.prototype.open` to their originals. This means:
- The intercept is active for ~2-5 seconds during page load
- After that, all fetch/XHR calls use native APIs
- If the core file is already cached and EJS doesn't fetch it, a 10-second timeout restores anyway

### IDB clear with await:

Wrap the IDB operations in a Promise. `bootEmulator()` in play.js already waits for EJS to load — we can ensure IDB clear finishes before the EJS loader script is injected. The simplest approach: make `core-redirector.js` set a `window._knCoreReady` promise that play.js awaits before injecting the loader.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `web/static/core-redirector.js` | Rewrite | Scoped intercept with auto-restore, async IDB clear |
| `web/static/play.js` | Modify | Await IDB clear before booting emulator |

---

### Task 1: Rewrite core-redirector.js

**Files:**
- Modify: `web/static/core-redirector.js` (full rewrite)

- [ ] **Step 1: Rewrite with scoped intercept and async IDB clear**

```js
/**
 * core-redirector.js — Redirect EmulatorJS core download to self-hosted patched version.
 *
 * Must be loaded BEFORE EmulatorJS loader.js.
 * In lockstep mode, temporarily intercepts fetch/XHR to serve our patched core,
 * then restores native APIs after the core has been fetched.
 */
(function() {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var mode = params.get('mode') || 'lockstep';

  if (mode !== 'lockstep') {
    window._knCoreReady = Promise.resolve();
    return;
  }

  window._kn_usePatchedCore = true;
  console.log('[core-redirector] Lockstep mode: loading patched core');

  var CORE_FILENAME = 'mupen64plus_next-wasm.data';
  var LOCAL_CORE_URL = '/static/ejs/cores/' + CORE_FILENAME;
  var CORE_VERSION = '2';

  // ── Phase 1: Clear stale IDB cache (async, awaited before EJS boots) ──

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
              req.onerror = resolve;   // don't block on errors
              req.onblocked = resolve; // don't block if other tabs hold connections
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

  // ── Phase 2: Scoped fetch/XHR intercept (auto-restores after core loads) ──

  var origFetch = window.fetch;
  var origXHROpen = XMLHttpRequest.prototype.open;
  var interceptActive = true;

  function restore() {
    if (!interceptActive) return;
    interceptActive = false;
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origXHROpen;
    console.log('[core-redirector] Restored native fetch/XHR');
  }

  window.fetch = function(url, opts) {
    var u = typeof url === 'string' ? url : (url && url.url ? url.url : '');
    if (interceptActive && u.includes(CORE_FILENAME)) {
      console.log('[core-redirector] Redirecting core fetch to:', LOCAL_CORE_URL);
      var result = origFetch.call(this, LOCAL_CORE_URL, opts);
      // Restore after this fetch completes (core is loaded)
      result.then(restore, restore);
      return result;
    }
    return origFetch.apply(this, arguments);
  };

  XMLHttpRequest.prototype.open = function(method, url) {
    if (interceptActive && typeof url === 'string' && url.includes(CORE_FILENAME)) {
      console.log('[core-redirector] Redirecting XHR core to:', LOCAL_CORE_URL);
      arguments[1] = LOCAL_CORE_URL;
      // Restore after XHR completes
      this.addEventListener('loadend', restore, { once: true });
    }
    return origXHROpen.apply(this, arguments);
  };

  // Safety timeout: restore after 10s even if core wasn't fetched
  setTimeout(restore, 10000);

  // ── Expose promise for play.js to await before booting EJS ──
  window._knCoreReady = idbClearPromise;
})();
```

- [ ] **Step 2: Commit**

```bash
git add web/static/core-redirector.js
git commit -m "refactor: scope core-redirector intercepts with auto-restore, async IDB clear"
```

---

### Task 2: Await IDB clear in play.js bootEmulator

**Files:**
- Modify: `web/static/play.js` (bootEmulator function)

- [ ] **Step 1: Add await before EJS loader injection**

In `bootEmulator()`, before the line that injects the loader.js script tag, add:

```js
    // Wait for core-redirector's IDB cache clear to finish before loading EJS.
    // If the clear hasn't finished, EJS might download from its stale IDB cache
    // instead of our redirected URL.
    if (window._knCoreReady) {
      window._knCoreReady.then(function () {
        injectEJSLoader();
      });
    } else {
      injectEJSLoader();
    }
```

This requires extracting the loader injection into a small `injectEJSLoader()` function (the existing code that creates and appends the script element).

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "fix: await IDB cache clear before booting EmulatorJS"
```

---

### Task 3: Verify

- [ ] **First load:** Core fetched from `/static/ejs/cores/`, console shows redirect + IDB clear + restore
- [ ] **Second load:** IDB clear skipped (version matches), core still redirected, native APIs restored
- [ ] **After restore:** `window.fetch === origFetch` (no intercept on subsequent API calls)
- [ ] **Network tab:** Only the core `.data` file is redirected; all other fetches go to their original URLs
- [ ] **Multi-tab:** Opening two tabs simultaneously doesn't deadlock IDB deletion
