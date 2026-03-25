# Cross-Module Global State Cleanup Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scattered `window.*` globals with a centralized state object (`KNState`) and define constants for magic numbers (input state indices, audio ring buffer keys).

**Architecture:** Create `web/static/kn-state.js` that owns all cross-module state. Modules read/write through `KNState.get()`/`KNState.set()` with named keys. Input state indices become named constants. This is NOT an event bus or pub/sub — just a typed namespace that replaces `window._foo` with `KNState.foo`, making dependencies explicit and greppable.

**Tech Stack:** Vanilla JS

---

## Problem

There are ~15 `window.*` globals used for cross-module communication:

| Global | Writer | Reader(s) | Risk |
|--------|--------|-----------|------|
| `window._remapWizardActive` | play.js | lockstep.js, streaming.js | No timeout, can deadlock input |
| `window._touchInputState` | virtual-gamepad.js | lockstep.js, streaming.js | Magic indices 0-23, no init check |
| `window._peers` | lockstep.js, streaming.js | play.js | Mutable by any script |
| `window._isMobile` | play.js | play.js | Redundant with `'ontouchstart' in window` |
| `window._kn_frameTime` | lockstep.js | WASM core | No validation |
| `window._kn_inStep` | lockstep.js | lockstep.js audio | |
| `window._kn_useRelativeCycles` | lockstep.js | lockstep.js | |
| `window._kn_cycleStart/Base` | lockstep.js | lockstep.js | |
| `window._kn_audioRing*` | lockstep.js | ScriptProcessor | 5 separate globals for ring buffer |
| `window._kn_scriptProcessor` | lockstep.js | lockstep.js cleanup | |
| `window._kn_keepAliveOsc` | lockstep.js | lockstep.js, play.js | |
| `window._frameNum` | lockstep.js | play.js info overlay | |
| `window._netplayFrameLog` | lockstep.js | play.js dump | |
| `window._delayAutoValue` | play.js | lockstep.js | |
| `window._kn_usePatchedCore` | core-redirector.js | lockstep.js | |

## Design

### What to centralize (high-value, cross-module):
- `_remapWizardActive` → `KNState.remapActive`
- `_touchInputState` → `KNState.touchInput` (with named index constants)
- `_peers` → `KNState.peers`
- `_delayAutoValue` → `KNState.delayAutoValue`
- `_frameNum` → `KNState.frameNum`

### What to leave as-is (internal to one module, or WASM interface):
- `window._kn_frameTime`, `_kn_inStep`, `_kn_useRelativeCycles`, `_kn_cycleStart/Base` — these are read by the WASM core's patched `_emscripten_get_now`. Changing them requires recompiling the WASM core. **Leave as window globals.**
- `window._kn_audioRing*` — these are read by the ScriptProcessorNode callback, which runs on the audio thread. Performance-critical, must stay as direct window access. **Leave as window globals.**
- `window._kn_usePatchedCore` — only set once by core-redirector, read once by lockstep. Low risk. **Leave.**

### Input state constants:

```js
KNState.INPUT = {
  // Digital buttons (0-15)
  A: 0, B: 1, START: 3,
  D_UP: 4, D_DOWN: 5, D_LEFT: 6, D_RIGHT: 7,
  L: 10, R: 11, Z: 12,
  // Analog stick (16-19) — values 0 to 32767
  STICK_RIGHT: 16, STICK_LEFT: 17, STICK_DOWN: 18, STICK_UP: 19,
  // C-buttons (20-23)
  C_LEFT: 20, C_RIGHT: 21, C_DOWN: 22, C_UP: 23,
};
```

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `web/static/kn-state.js` | Create | Centralized state + constants |
| `web/play.html` | Modify | Load kn-state.js early |
| `web/static/play.js` | Modify | Use KNState for wizard flag, delay, frameNum |
| `web/static/netplay-lockstep.js` | Modify | Use KNState for peers, frameNum |
| `web/static/netplay-streaming.js` | Modify | Use KNState for wizard flag, peers |
| `web/static/virtual-gamepad.js` | Modify | Use KNState.INPUT constants |

---

### Task 1: Create kn-state.js

**Files:**
- Create: `web/static/kn-state.js`

- [ ] **Step 1: Write the module**

```js
/**
 * kn-state.js — Centralized cross-module state for kaillera-next.
 *
 * Replaces scattered window.* globals with a single namespace.
 * Load before all other kaillera-next scripts.
 */
(function () {
  'use strict';

  // N64 input bitmask indices (shared between virtual-gamepad,
  // netplay-lockstep, netplay-streaming, and gamepad-manager).
  var INPUT = Object.freeze({
    A: 0, B: 1, START: 3,
    D_UP: 4, D_DOWN: 5, D_LEFT: 6, D_RIGHT: 7,
    L: 10, R: 11, Z: 12,
    STICK_RIGHT: 16, STICK_LEFT: 17, STICK_DOWN: 18, STICK_UP: 19,
    C_LEFT: 20, C_RIGHT: 21, C_DOWN: 22, C_UP: 23,
  });

  window.KNState = {
    INPUT: INPUT,

    // ── Cross-module state ──
    // Each property replaces a former window.* global.
    // Writers and readers are documented inline.

    remapActive: false,      // play.js → lockstep.js, streaming.js
    touchInput: {},          // virtual-gamepad.js → lockstep.js, streaming.js
    peers: {},               // lockstep/streaming.js → play.js
    frameNum: 0,             // lockstep.js → play.js info overlay
    delayAutoValue: 2,       // play.js → lockstep.js
  };
})();
```

- [ ] **Step 2: Load in play.html before other scripts**

```html
<!-- Centralized cross-module state (load early) -->
<script src="/static/kn-state.js"></script>
```

- [ ] **Step 3: Commit**

```bash
git add web/static/kn-state.js web/play.html
git commit -m "feat: add kn-state.js for centralized cross-module state"
```

---

### Task 2: Migrate _remapWizardActive

**Files:**
- Modify: `web/static/play.js` (writer)
- Modify: `web/static/netplay-lockstep.js` (reader)
- Modify: `web/static/netplay-streaming.js` (reader)

- [ ] **Step 1: Update play.js writer**

Replace `window._remapWizardActive = true/false` with `KNState.remapActive = true/false` (2 locations in startWizard/cancelWizard).

- [ ] **Step 2: Update lockstep reader**

Replace `if (window._remapWizardActive) return 0;` with `if (KNState.remapActive) return 0;` in `readLocalInput()`.

- [ ] **Step 3: Update streaming reader**

Same replacement in streaming's `readLocalInput()`.

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js web/static/netplay-lockstep.js web/static/netplay-streaming.js
git commit -m "refactor: migrate _remapWizardActive to KNState.remapActive"
```

---

### Task 3: Migrate _peers and _frameNum

**Files:**
- Modify: `web/static/netplay-lockstep.js` (writer)
- Modify: `web/static/netplay-streaming.js` (writer)
- Modify: `web/static/play.js` (reader)

- [ ] **Step 1: In lockstep, replace `window._peers = _peers`**

Find all `window._peers = _peers;` (~3 locations) → replace with `KNState.peers = _peers;`.

Replace `window._frameNum = _frameNum;` → `KNState.frameNum = _frameNum;`.

- [ ] **Step 2: In streaming, replace `window._peers = _peers`**

Same pattern.

- [ ] **Step 3: In play.js, update readers**

Find `window._peers` reads → `KNState.peers`.
Find `window._frameNum` reads → `KNState.frameNum`.

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-lockstep.js web/static/netplay-streaming.js web/static/play.js
git commit -m "refactor: migrate _peers and _frameNum to KNState"
```

---

### Task 4: Migrate _delayAutoValue and touchInput

- [ ] **Step 1: Replace window._delayAutoValue**

In play.js: `window._delayAutoValue` → `KNState.delayAutoValue` (3 locations: declaration, setter, getter).

In lockstep.js: `window._delayAutoValue` reader → `KNState.delayAutoValue`.

- [ ] **Step 2: Replace _touchInputState usage**

In virtual-gamepad.js `init()`: receives `stateObj` parameter — this is already passed by the caller. No change needed here (the object reference is shared).

In play.js `updateGamepadUI()` and netplay engines: ensure the `_touchInputState` object reference is `KNState.touchInput`. The caller passes `KNState.touchInput` to `VirtualGamepad.init()`.

- [ ] **Step 3: Commit**

```bash
git add web/static/play.js web/static/netplay-lockstep.js web/static/virtual-gamepad.js
git commit -m "refactor: migrate delayAutoValue and touchInput to KNState"
```

---

### Task 5: Verify

- [ ] Lockstep game works (peers, frameNum, delay, input all correct)
- [ ] Streaming game works (peers, virtual gamepad touch input)
- [ ] Remap wizard works (remapActive flag suppresses input, clears on cancel)
- [ ] `grep -r 'window\._remapWizardActive\|window\._peers\|window\._frameNum\|window\._delayAutoValue' web/static/` returns no matches
