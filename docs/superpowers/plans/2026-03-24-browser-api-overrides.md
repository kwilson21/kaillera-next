# Browser API Override Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralize all browser API overrides (requestAnimationFrame, performance.now, navigator.getGamepads) into a single module with explicit save/restore lifecycle, so new features don't accidentally use fake versions.

**Architecture:** Create `web/static/api-sandbox.js` — a small module that saves native browser API references at load time (before anything can override them) and provides scoped override/restore functions. All other modules use this module's native refs instead of accessing browser globals directly. The lockstep engine calls sandbox.override() on game start and sandbox.restore() on game end.

**Tech Stack:** Vanilla JS, no dependencies

---

## Problem

Lockstep mode overrides three browser globals to control the WASM emulator:

| API | Where overridden | Purpose | Where restored |
|-----|-----------------|---------|----------------|
| `requestAnimationFrame` | lockstep.js:2141 | Capture emulator frame runner | lockstep.js:3400 |
| `performance.now` | lockstep.js:2277 | Deterministic timing during WASM steps | **NEVER** (leaks until page reload) |
| `navigator.getGamepads` | lockstep.js:3064 | Block WASM SDL gamepad polling | **NEVER** |

This has already caused bugs:
- Remap wizard's `requestAnimationFrame(wizardPoll)` replaced the emulator's frame runner, freezing the game
- Remap wizard's `navigator.getGamepads()` returned `[]`, so gamepad buttons weren't detected
- Any new feature using `performance.now()` during lockstep gets fake timestamps

## Design

### api-sandbox.js responsibilities:

1. **At load time:** Save native refs to `requestAnimationFrame`, `performance.now`, `navigator.getGamepads`
2. **Expose native refs:** `APISandbox.nativeRAF()`, `APISandbox.nativePerfNow()`, `APISandbox.nativeGetGamepads()`
3. **Override API:** `APISandbox.enterLockstep(overrides)` — replaces globals, returns restore handle
4. **Restore API:** `APISandbox.exitLockstep()` — restores all globals to native refs
5. **State query:** `APISandbox.isInLockstep()` — for defensive checks

### Migration path (safe, incremental):

1. Create `api-sandbox.js` and load it FIRST (before all other scripts)
2. Update `gamepad-manager.js` to use `APISandbox.nativeGetGamepads()` instead of its own `_nativeGetGamepads`
3. Update `play.js` wizard to use `APISandbox.nativeGetGamepads()` (already using `GamepadManager.nativeGetGamepads()` — just change the source)
4. Update `netplay-lockstep.js` to use `APISandbox` for all overrides and restores
5. Add `performance.now` restore to lockstep `stop()` (currently missing!)

Each step is independently deployable. If any step breaks, only that step needs reverting.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `web/static/api-sandbox.js` | Create | Save native refs, provide override/restore lifecycle |
| `web/play.html` | Modify | Load api-sandbox.js first |
| `web/static/gamepad-manager.js` | Modify | Use APISandbox.nativeGetGamepads instead of own cache |
| `web/static/play.js` | Modify | Use APISandbox for wizard gamepad access |
| `web/static/netplay-lockstep.js` | Modify | Use APISandbox for all overrides/restores |

---

### Task 1: Create api-sandbox.js

**Files:**
- Create: `web/static/api-sandbox.js`

- [ ] **Step 1: Write the module**

```js
/**
 * api-sandbox.js — Centralized native browser API reference management.
 *
 * Must be loaded BEFORE all other scripts. Saves native references to
 * browser APIs that lockstep mode overrides, and provides explicit
 * override/restore lifecycle.
 *
 * Usage:
 *   APISandbox.nativeRAF(cb)          — real requestAnimationFrame
 *   APISandbox.nativePerfNow()        — real performance.now()
 *   APISandbox.nativeGetGamepads()    — real navigator.getGamepads()
 *   APISandbox.enterLockstep(overrides) — replace globals
 *   APISandbox.exitLockstep()         — restore globals
 *   APISandbox.isInLockstep()         — query state
 */
(function () {
  'use strict';

  // Save native references at load time — before anything can override them.
  var _nativeRAF = window.requestAnimationFrame.bind(window);
  var _nativePerfNow = performance.now.bind(performance);
  var _nativeGetGamepads = navigator.getGamepads.bind(navigator);

  var _inLockstep = false;

  window.APISandbox = {
    // ── Native references (always return real browser behavior) ──
    nativeRAF: function (cb) { return _nativeRAF(cb); },
    nativeCancelRAF: window.cancelAnimationFrame.bind(window),
    nativePerfNow: function () { return _nativePerfNow(); },
    nativeGetGamepads: function () { return _nativeGetGamepads(); },

    // ── Lockstep lifecycle ──
    // overrides: { raf, perfNow, getGamepads } — replacement functions
    enterLockstep: function (overrides) {
      if (_inLockstep) return;
      _inLockstep = true;
      if (overrides.raf) window.requestAnimationFrame = overrides.raf;
      if (overrides.perfNow) performance.now = overrides.perfNow;
      if (overrides.getGamepads) navigator.getGamepads = overrides.getGamepads;
    },

    exitLockstep: function () {
      if (!_inLockstep) return;
      _inLockstep = false;
      window.requestAnimationFrame = _nativeRAF;
      performance.now = _nativePerfNow;
      navigator.getGamepads = _nativeGetGamepads;
    },

    isInLockstep: function () { return _inLockstep; },
  };
})();
```

- [ ] **Step 2: Load it first in play.html**

Add before the core-redirector script:

```html
<!-- Native API reference management (must load before everything) -->
<script src="/static/api-sandbox.js"></script>
```

- [ ] **Step 3: Commit**

```bash
git add web/static/api-sandbox.js web/play.html
git commit -m "feat: add api-sandbox.js for centralized browser API override management"
```

---

### Task 2: Migrate gamepad-manager.js

**Files:**
- Modify: `web/static/gamepad-manager.js:18-20` (remove own cache)
- Modify: `web/static/gamepad-manager.js:118, 168` (use APISandbox)

- [ ] **Step 1: Replace _nativeGetGamepads with APISandbox**

Remove lines 18-20:
```js
  // Save real getGamepads — the global may be overridden to block
  // the WASM core's internal Emscripten SDL gamepad polling.
  const _nativeGetGamepads = navigator.getGamepads.bind(navigator);
```

Replace all `_nativeGetGamepads()` calls with `APISandbox.nativeGetGamepads()` (lines 118, 168).

- [ ] **Step 2: Keep the nativeGetGamepads export as a passthrough**

The public API `GamepadManager.nativeGetGamepads()` (used by play.js wizard) now delegates:

```js
    nativeGetGamepads: function () { return APISandbox.nativeGetGamepads(); },
```

- [ ] **Step 3: Verify wizard still works**

The play.js wizard already calls `GamepadManager.nativeGetGamepads()` — this still works because it now chains through APISandbox.

- [ ] **Step 4: Commit**

```bash
git add web/static/gamepad-manager.js
git commit -m "refactor: gamepad-manager uses APISandbox for native getGamepads"
```

---

### Task 3: Migrate netplay-lockstep.js overrides

**Files:**
- Modify: `web/static/netplay-lockstep.js:2135-2144` (rAF override)
- Modify: `web/static/netplay-lockstep.js:2267-2279` (perf.now override)
- Modify: `web/static/netplay-lockstep.js:3059-3064` (getGamepads override)
- Modify: `web/static/netplay-lockstep.js:3398-3403` (rAF restore)
- Modify: `web/static/netplay-lockstep.js:308` (remove _origRAF state var)

This is the largest change. Do it in sub-steps:

- [ ] **Step 1: Replace enterManualMode() rAF override**

In `enterManualMode()` (~line 2128), replace:
```js
    _origRAF = window.requestAnimationFrame;
    // ... (pause/resume stays the same)
    window.requestAnimationFrame = function (cb) {
      _pendingRunner = cb;
      return -999;
    };
```

With:
```js
    // rAF override is now handled by APISandbox — but we still need to
    // intercept callbacks to capture the emulator's frame runner.
    // enterLockstep is called once in startLockstep(); here we just
    // need to do the pause/resume dance to capture the runner.
```

The actual rAF override moves to `startLockstep()`.

- [ ] **Step 2: Consolidate all overrides into startLockstep()**

In `startLockstep()` (~line 2214), after the deterministic timing setup, add a single `APISandbox.enterLockstep()` call:

```js
    // Apply all browser API overrides via centralized sandbox
    APISandbox.enterLockstep({
      raf: function (cb) { _pendingRunner = cb; return -999; },
      perfNow: _deterministicPerfNow || null,
      getGamepads: function () { return []; },
    });
```

Remove the individual overrides from:
- `enterManualMode()` (line 2135, 2141-2144) — keep pause/resume only
- `startLockstep()` (line 2277) — perf.now
- `disableEJSInput()` (line 3064) — getGamepads

- [ ] **Step 3: Replace stop() restore with APISandbox.exitLockstep()**

In `stop()` (~line 3398-3403), replace:
```js
    if (_manualMode && _origRAF) {
      window.requestAnimationFrame = _origRAF;
    }
    _manualMode = false;
    _origRAF = null;
```

With:
```js
    APISandbox.exitLockstep();
    _manualMode = false;
```

This also fixes the **performance.now restore bug** — `exitLockstep()` restores ALL three APIs.

- [ ] **Step 4: Remove _origRAF state variable**

Remove from state vars (~line 308):
```js
  let _origRAF = null;
```

Update `stepOneFrame()` line 2189 (`_origRAF.call(window, () => {})`) to:
```js
    APISandbox.nativeRAF(function () {});
```

- [ ] **Step 5: Update blitFrame in streaming**

In `netplay-streaming.js`, the blit loop at line 428 uses `requestAnimationFrame(blitFrame)`. This is the HOST's blit loop — it should use the native rAF since the host isn't in lockstep mode during streaming. Currently this works because streaming mode doesn't override rAF, but for safety:

```js
      // Use native rAF — lockstep may override the global during mode switches
      var raf = window.APISandbox ? APISandbox.nativeRAF : requestAnimationFrame;
```

- [ ] **Step 6: Commit**

```bash
git add web/static/netplay-lockstep.js web/static/netplay-streaming.js
git commit -m "refactor: lockstep uses APISandbox for all browser API overrides

Fixes performance.now() never being restored after lockstep ends.
Fixes navigator.getGamepads never being restored after lockstep ends."
```

---

### Task 4: Verify no regressions

- [ ] **Lockstep test:** 2-player lockstep game starts, runs, ends cleanly. After end, rAF/perf.now/getGamepads work normally.
- [ ] **Remap wizard test:** Open remap during lockstep game → gamepad buttons detected, game doesn't freeze
- [ ] **Streaming test:** Host streams to guest → video + audio work (not affected by API overrides)
- [ ] **Console check:** No errors. `APISandbox.isInLockstep()` returns true during game, false after
