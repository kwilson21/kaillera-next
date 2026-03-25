# Emulator Boot Timing Chain Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragile setTimeout polling chains in shared.js with promise-based init functions that have proper timeouts, deduplication, and error reporting.

**Architecture:** Convert `triggerEmulatorStart()` and `applyStandardCheats()` from setTimeout polling to Promise-based functions with explicit timeout and single-attempt semantics. Callers can `await` these or use `.catch()` for error handling. The cheat retry chain (500ms/2s/5s) is replaced with a single poll that waits for gameManager, applies once, and verifies.

**Tech Stack:** Vanilla JS (Promises, no async/await for browser compat)

---

## Problem

### triggerEmulatorStart() (shared.js:96-118)
- Polls every 200ms for `gameManager.Module` OR a `.ejs_start_button`
- Max 150 attempts (30s) then silently gives up
- No error reporting — caller has no idea if boot failed
- No deduplication — if called twice, two polling loops run concurrently

### applyStandardCheats() (shared.js:36-48)
- Attempts cheat application, retries every 500ms until gameManager exists
- After success, fires two MORE attempts at 2s and 5s regardless
- No cancellation — all three timers fire even if the first worked
- Redundant applications could interfere with emulator state

### lockstep disableEJSInput() (lockstep.js:3035-3067)
- Polls every 200ms for `ejs.gameManager`
- No max attempts — runs forever if gameManager never appears
- No timeout or error reporting

---

## Design

### Promise-based waitForEmulator()

Replace `triggerEmulatorStart()` with a function that returns a Promise:

```js
KNShared.waitForEmulator(timeoutMs)
  → resolves with gameManager when ready
  → rejects with Error after timeout
```

Internally polls at 200ms. If `.ejs_start_button` is found, clicks it. Deduplicates: if already polling, returns the same promise.

### Single-shot applyStandardCheats()

Replace the retry chain with:

```js
KNShared.applyStandardCheats(cheats)
  → calls waitForEmulator() first
  → applies cheats once
  → verifies by reading back (if possible)
  → no redundant retries
```

### Bounded disableEJSInput()

Add a max-attempt limit (same 30s as boot timeout) and log a warning if it times out.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `web/static/shared.js` | Modify | Promise-based waitForEmulator, single-shot cheats |
| `web/static/netplay-lockstep.js` | Modify | Use waitForEmulator, bounded disableEJSInput |
| `web/static/netplay-streaming.js` | Modify | Use waitForEmulator for disableEJSInput |

---

### Task 1: Rewrite shared.js init functions

**Files:**
- Modify: `web/static/shared.js:36-119`

- [ ] **Step 1: Replace triggerEmulatorStart with waitForEmulator**

```js
  var _bootPromise = null;  // deduplication: only one poll loop at a time

  function waitForEmulator(timeoutMs) {
    if (_bootPromise) return _bootPromise;

    timeoutMs = timeoutMs || 30000;

    _bootPromise = new Promise(function (resolve, reject) {
      var attempts = 0;
      var maxAttempts = Math.ceil(timeoutMs / 200);
      var timer = null;

      function attempt() {
        var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
        if (gm && gm.Module) {
          _bootPromise = null;
          enableMobileTouch();
          resolve(gm);
          return;
        }

        // Try clicking start button if it exists
        var btn = document.querySelector('.ejs_start_button');
        if (btn) {
          if ('ontouchstart' in window) btn.dispatchEvent(new Event('touchstart'));
          btn.click();
        }

        if (++attempts >= maxAttempts) {
          _bootPromise = null;
          reject(new Error('Emulator boot timed out after ' + timeoutMs + 'ms'));
          return;
        }
        timer = setTimeout(attempt, 200);
      }
      attempt();
    });

    return _bootPromise;
  }

  // Keep triggerEmulatorStart as a fire-and-forget wrapper for backward compat
  function triggerEmulatorStart() {
    waitForEmulator().catch(function (err) {
      console.error('[netplay]', err.message);
    });
  }
```

- [ ] **Step 2: Replace applyStandardCheats with single-shot version**

```js
  function applyStandardCheats(cheats) {
    waitForEmulator().then(function (gm) {
      try {
        cheats.forEach(function (c, i) { gm.setCheat(i, 1, c.code); });
        console.log('[netplay] applied', cheats.length, 'standard cheats');
      } catch (err) {
        console.error('[netplay] cheat application failed:', err.message);
      }
    }).catch(function (err) {
      console.error('[netplay] cannot apply cheats:', err.message);
    });
  }
```

This removes the 500ms/2s/5s retry chain entirely. If `waitForEmulator` resolves, the gameManager is ready and cheats can be applied immediately.

- [ ] **Step 3: Update exports**

```js
  window.KNShared = {
    SSB64_ONLINE_CHEATS: SSB64_ONLINE_CHEATS,
    DEFAULT_N64_KEYMAP: DEFAULT_N64_KEYMAP,
    applyStandardCheats: applyStandardCheats,
    setupKeyTracking: setupKeyTracking,
    triggerEmulatorStart: triggerEmulatorStart,
    waitForEmulator: waitForEmulator,
    enableMobileTouch: enableMobileTouch,
  };
```

- [ ] **Step 4: Commit**

```bash
git add web/static/shared.js
git commit -m "refactor: promise-based waitForEmulator, single-shot cheat application"
```

---

### Task 2: Add timeout to disableEJSInput in lockstep

**Files:**
- Modify: `web/static/netplay-lockstep.js:3033-3067`

- [ ] **Step 1: Add max attempts to disableEJSInput**

The current code polls indefinitely. Add a counter:

```js
  function disableEJSInput() {
    var attempts = 0;
    var attempt = function () {
      var ejs = window.EJS_emulator;
      var gm = ejs && ejs.gameManager;
      if (!gm) {
        if (++attempts < 150) { setTimeout(attempt, 200); }
        else { console.warn('[lockstep] disableEJSInput timed out'); }
        return;
      }

      // ... rest of the function unchanged ...
    };
    attempt();
  }
```

- [ ] **Step 2: Same fix in streaming's disableEJSInput**

`netplay-streaming.js` has the same unbounded pattern (~line 725). Add the same `attempts < 150` guard.

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js web/static/netplay-streaming.js
git commit -m "fix: add timeout to disableEJSInput polling loops"
```

---

### Task 3: Verify

- [ ] **Normal boot:** Emulator starts, cheats applied once (check console — should see exactly one "applied N standard cheats" message, NOT three)
- [ ] **Slow boot:** Simulate slow boot (add artificial delay) — waitForEmulator waits patiently, resolves when ready
- [ ] **Boot failure:** If EJS never loads (e.g., bad ROM), see "timed out" error after 30s instead of silent failure
- [ ] **Double call:** Call `triggerEmulatorStart()` twice rapidly — only one polling loop runs (deduplication)
- [ ] **disableEJSInput:** Times out after 30s with a warning if gameManager never appears
