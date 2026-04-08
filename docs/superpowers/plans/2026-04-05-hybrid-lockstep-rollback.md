# Hybrid Lockstep-Rollback Netplay Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a hybrid netplay mode that uses lockstep (frame-locked stall) during menu screens and rollback (speculative execution) during VS gameplay, solving RNG determinism for character/stage/costume selection.

**Architecture:** Modify the production lockstep engine (`netplay-lockstep.js`) to support a `_hybridMode` flag. When active, each frame reads the N64 screen ID from RDRAM offset `0xA4AD0`. During menus (CSS, stage select, results), existing lockstep stall behavior runs unchanged. During VS_BATTLE (screen `0x16`), the engine predicts missing input instead of stalling, captures per-frame delta snapshots, and triggers rollback replay on misprediction. Mode transitions are logged and prediction state is flushed on screen change.

**Tech Stack:** Vanilla JS (IIFE + window globals), WASM (mupen64plus-next), WebRTC DataChannels, Socket.IO, Python FastAPI

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `web/static/netplay-lockstep.js` | Modify | Add screen detection, delta snapshots, prediction tracking, rollback replay, mode transitions — all gated behind `_hybridMode` flag |
| `web/play.html` | Modify | Add "Hybrid" option to mode-select dropdown |
| `web/static/play.js` | Modify | Route "hybrid" mode to NetplayLockstep with `hybridMode: true` config option |
| `server/src/api/payloads.py` | Modify | Add `"hybrid"` to `Literal` type for `StartGamePayload` and `SetModePayload` |
| `server/src/api/signaling.py` | Modify | Add `"hybrid"` to `_VALID_MODES`, apply same-engine validation (like rollback) |

No new files are created. All changes are additions to existing files.

---

## Chunk 1: Server + UI Plumbing

### Task 1: Add "hybrid" mode to server payloads

**Files:**
- Modify: `server/src/api/payloads.py:94-96` (StartGamePayload) and `:110-111` (SetModePayload)

- [ ] **Step 1: Add "hybrid" to StartGamePayload Literal**

In `server/src/api/payloads.py`, change line 94:
```python
# Before:
mode: Literal["lockstep", "streaming", "rollback"] = "lockstep"

# After:
mode: Literal["lockstep", "streaming", "rollback", "hybrid"] = "lockstep"
```

- [ ] **Step 2: Add "hybrid" to SetModePayload Literal**

Same file, line 111:
```python
# Before:
mode: Literal["lockstep", "streaming", "rollback"] = "lockstep"

# After:
mode: Literal["lockstep", "streaming", "rollback", "hybrid"] = "lockstep"
```

- [ ] **Step 3: Commit**

```bash
git add server/src/api/payloads.py
git commit -m "feat: add hybrid mode to server payload models"
```

### Task 2: Add "hybrid" to server signaling validation

**Files:**
- Modify: `server/src/api/signaling.py:86` (_VALID_MODES) and `:624-636` (start-game handler)

- [ ] **Step 1: Add "hybrid" to _VALID_MODES**

In `server/src/api/signaling.py`, line 86:
```python
# Before:
_VALID_MODES = {"lockstep", "streaming", "rollback"}

# After:
_VALID_MODES = {"lockstep", "streaming", "rollback", "hybrid"}
```

- [ ] **Step 2: Add same-engine validation for hybrid mode**

In the `start-game` handler (around line 627), the rollback engine check block:
```python
if mode == "rollback":
    engines = set()
    ...
```

Change to also cover hybrid:
```python
if mode in ("rollback", "hybrid"):
    engines = set()
    ...
```

This requires all players to report the same browser engine for hybrid mode, same as rollback. Cross-engine FPU differences would cause rollback replays to diverge.

- [ ] **Step 3: Commit**

```bash
git add server/src/api/signaling.py
git commit -m "feat: add hybrid mode to server signaling validation"
```

### Task 3: Add "Hybrid" option to play.html

**Files:**
- Modify: `web/play.html:117-120` (mode-select dropdown)

- [ ] **Step 1: Add Hybrid option to dropdown**

In `web/play.html`, after line 119 (`<option value="rollback">Rollback</option>`):
```html
<option value="hybrid">Hybrid</option>
```

- [ ] **Step 2: Commit**

```bash
git add web/play.html
git commit -m "feat: add hybrid option to mode selector dropdown"
```

### Task 4: Route "hybrid" mode in play.js

**Files:**
- Modify: `web/static/play.js:2648-2653` (engine selection) and `:4121-4145` (UI visibility)

- [ ] **Step 1: Route hybrid to lockstep engine with flag**

In `web/static/play.js`, the engine selection block (around line 2648):
```javascript
// Before:
const Engine =
  mode === 'streaming'
    ? window.NetplayStreaming
    : mode === 'rollback'
      ? window.NetplayRollback
      : window.NetplayLockstep;

// After:
const Engine =
  mode === 'streaming'
    ? window.NetplayStreaming
    : mode === 'rollback'
      ? window.NetplayRollback
      : window.NetplayLockstep;
```

No change to engine selection — hybrid uses NetplayLockstep. The difference is in the `init()` config passed below. Find the `engine.init({...})` call (around line 2660) and add `hybridMode`:

```javascript
engine.init({
  socket,
  sessionId: roomCode,
  playerSlot: isSpectator ? null : mySlot,
  isSpectator,
  // ... existing options ...
  hybridMode: mode === 'hybrid',
});
```

- [ ] **Step 2: Show lockstep options for hybrid mode**

In the mode-select change handler (around line 4121), where lockstep-options visibility is set:
```javascript
// Before:
lockstepOpts.style.display = sel.value === 'lockstep' ? '' : 'none';

// After:
lockstepOpts.style.display = (sel.value === 'lockstep' || sel.value === 'hybrid') ? '' : 'none';
```

Similarly for any other lockstep-specific UI toggles (delay picker, resync checkbox), make them show for both `lockstep` and `hybrid`.

- [ ] **Step 3: Report mode correctly in getInfo()**

When hybrid mode is active, the engine should report `mode: 'hybrid'` not `mode: 'lockstep'`. This is handled in Task 5 (lockstep.js changes), but play.js should pass the mode string through. In the `init()` config, ensure `mode` is passed:

```javascript
engine.init({
  // ... existing options ...
  hybridMode: mode === 'hybrid',
});
```

The engine reads `_config.hybridMode` to set its internal `_hybridMode` flag.

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js
git commit -m "feat: route hybrid mode to lockstep engine with hybridMode flag"
```

---

## Chunk 2: Screen Detection

### Task 5: Add screen detection to lockstep engine

**Files:**
- Modify: `web/static/netplay-lockstep.js` — add constants, state variables, and per-frame screen read

The screen detection reads a single byte from N64 RDRAM each frame. The address is `0x800A4AD0` (RDRAM offset `0xA4AD0`). The byte value identifies the current screen. This is Smash Remix-specific — the address and screen IDs come from `build/src/smashremix/src/Global.asm`.

- [ ] **Step 1: Add screen constants and state variables**

Near the top of the IIFE (after the existing constant declarations, around line 370-380 where `MAX_STALL_MS` etc. are defined), add:

```javascript
// ── Hybrid mode: screen detection ─────────────────────────────────────
// Smash Remix screen IDs from build/src/smashremix/src/Global.asm
const SCREEN_VS_CSS = 0x10;         // Character select
const SCREEN_STAGE_SELECT = 0x15;   // Stage select
const SCREEN_VS_BATTLE = 0x16;      // VS gameplay
const SCREEN_RESULTS = 0x18;        // Results screen
const SCREEN_RDRAM_OFFSET = 0xA4AD0; // Global.current_screen RDRAM address

let _hybridMode = false;            // Set in init() from config
let _currentScreen = -1;            // Current detected screen ID
let _prevScreen = -1;               // Previous screen (for transition detection)
let _inRollbackScreen = false;      // true when VS_BATTLE (rollback active)
```

- [ ] **Step 2: Add screen detection function**

After the constants block, add a function that reads the screen byte:

```javascript
const _detectScreen = (mod) => {
  if (!_hybridMode || !_rdramBase || !mod?.HEAPU8) return;
  const screenByte = mod.HEAPU8[_rdramBase + SCREEN_RDRAM_OFFSET];
  if (screenByte === _currentScreen) return; // no change

  _prevScreen = _currentScreen;
  _currentScreen = screenByte;
  const wasRollback = _inRollbackScreen;
  _inRollbackScreen = screenByte === SCREEN_VS_BATTLE;

  _syncLog(
    `SCREEN-CHANGE prev=0x${_prevScreen.toString(16).padStart(2, '0')} ` +
    `now=0x${_currentScreen.toString(16).padStart(2, '0')} ` +
    `rollback=${_inRollbackScreen}`
  );

  if (wasRollback && !_inRollbackScreen) {
    // Exiting VS_BATTLE → flush rollback state, return to lockstep
    _flushRollbackState();
  } else if (!wasRollback && _inRollbackScreen) {
    // Entering VS_BATTLE → initialize delta baseline
    _initDeltaBaseline(mod);
  }
};
```

- [ ] **Step 3: Initialize _hybridMode in init()**

In the `init()` function (around line 5077), after reading config options:

```javascript
_hybridMode = !!config.hybridMode;
if (_hybridMode) {
  _syncLog('HYBRID mode enabled — lockstep menus, rollback gameplay');
}
```

Also, after emulator boot completes (in the `startGameSequence` flow, after `enterManualMode` is called and `_rdramBase` is set), seed `_currentScreen` from the actual RDRAM byte to avoid a spurious transition event on the first `_detectScreen` call:

```javascript
// After _rdramBase is set and emulator is in manual mode:
if (_hybridMode && _rdramBase) {
  const mod = window.EJS_emulator?.gameManager?.Module;
  if (mod?.HEAPU8) {
    _currentScreen = mod.HEAPU8[_rdramBase + SCREEN_RDRAM_OFFSET];
    _inRollbackScreen = _currentScreen === SCREEN_VS_BATTLE;
    _syncLog(`HYBRID initial screen=0x${_currentScreen.toString(16).padStart(2, '0')} rollback=${_inRollbackScreen}`);
  }
}
```

- [ ] **Step 4: Call _detectScreen() in tick()**

In the `tick()` function (line 3900+), right after the resync application block and before frame pacing, add:

```javascript
// ── Hybrid: screen detection ──────────────────────────────────────
const tickMod = window.EJS_emulator?.gameManager?.Module;
_detectScreen(tickMod);
```

Note: `tickMod` is already declared later in tick() (line 4293). Move its declaration earlier or use a separate variable. Since `const` is block-scoped, declare it once at the top of tick():

```javascript
const tick = () => {
  if (!_running) return;
  if (_lateJoinPaused) return;
  const tickMod = window.EJS_emulator?.gameManager?.Module; // move here

  // ... resync block ...

  // Hybrid: screen detection (after resync, before pacing)
  _detectScreen(tickMod);

  // ... rest of tick ...
```

Remove the later `const tickMod = ...` declaration at line 4293 since it's now at the top.

Note: Moving `tickMod` to the top of `tick()` is a cross-cutting change that also affects pure lockstep mode. The cost is negligible (cheap property chain lookup), but it means ticks that return early (`_lateJoinPaused`) still evaluate the expression. This is acceptable.

- [ ] **Step 5: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: add screen detection for hybrid lockstep-rollback mode"
```

---

## Chunk 3: Delta Snapshot System

### Task 6: Port delta snapshot infrastructure from rollback engine

**Files:**
- Modify: `web/static/netplay-lockstep.js` — add delta snapshot variables, init, capture, restore functions

The delta snapshot system captures per-frame RDRAM page diffs (4KB pages) plus CPU state. This is ported from `netplay-rollback.js` lines 732-918. All rollback state is gated behind `_hybridMode` to avoid any overhead when running pure lockstep.

- [ ] **Step 1: Add rollback state variables**

After the screen detection constants added in Task 5, add:

```javascript
// ── Hybrid mode: rollback state ───────────────────────────────────────
const _ROLLBACK_MAX = KNShared.maxRollbackFrames?.() ?? 5;
const _RING_SIZE = _ROLLBACK_MAX + 1;
const _PAGE_SIZE = 4096;
const _PAGE_COUNT = 0x800000 / _PAGE_SIZE; // 2048 pages for 8MB RDRAM

let _deltaReady = false;
let _deltaBaseline = null;     // Uint8Array(8MB) — JS-side RDRAM copy
let _cpuPtrs = null;           // WASM heap offsets from kn_get_state_ptrs
let _cpuLayout = null;         // sizes from kn_get_state_ptrs
let _cpuTotalSize = 0;
const _deltaRing = new Array(_RING_SIZE).fill(null);

// Prediction tracking
const _inputHistory = {};      // slot -> { [frame]: inputMask }
const _inputConfirmed = {};    // slot -> { [frame]: boolean }
let _inRollback = false;       // true during rollback replay
let _rollbackStats = {
  totalPredictions: 0,
  correctPredictions: 0,
  rollbacksTriggered: 0,
  totalRollbackDepth: 0,
  maxRollbackDepth: 0,
  totalReplayMs: 0,
};
```

- [ ] **Step 2: Port _initDelta function**

This discovers CPU struct pointers via `kn_get_state_ptrs` and allocates the baseline buffer. Copied from `netplay-rollback.js:753-812` with no changes needed:

```javascript
const _initDelta = (mod) => {
  if (_deltaReady) return true;
  if (!_rdramBase || !mod?.HEAPU8 || !mod?._kn_get_state_ptrs) return false;
  const stackSave = mod.stackSave?.() ?? 0;
  const tmpPtr = mod.stackAlloc?.(80) ?? 0;
  if (!tmpPtr) return false;
  mod._kn_get_state_ptrs(tmpPtr);
  const u32 = mod.HEAPU32;
  const b = tmpPtr >> 2;
  _cpuPtrs = {
    gpr: u32[b], cp0: u32[b + 1], cp1: u32[b + 2],
    fcr0: u32[b + 3], fcr31: u32[b + 4], llbit: u32[b + 5],
    hi: u32[b + 6], lo: u32[b + 7], pc: u32[b + 8],
    viField: u32[b + 9], viDelay: u32[b + 10], spMem: u32[b + 11],
    pifRam: u32[b + 12], tlb: u32[b + 13], nextInt: u32[b + 14],
  };
  _cpuLayout = {
    tlbEntrySize: u32[b + 15], cp0Count: u32[b + 16],
    cp1Size: u32[b + 17], spMemSize: u32[b + 18], pifRamSize: u32[b + 19],
  };
  _cpuTotalSize =
    256 + _cpuLayout.cp0Count * 4 + 4 + 32 * _cpuLayout.cp1Size +
    4 + 4 + 4 + 8 + 8 + 4 + 4 + 4 +
    32 * _cpuLayout.tlbEntrySize + _cpuLayout.spMemSize + _cpuLayout.pifRamSize;
  if (mod.stackRestore) mod.stackRestore(stackSave);
  _deltaBaseline = new Uint8Array(0x800000);
  _deltaBaseline.set(mod.HEAPU8.subarray(_rdramBase, _rdramBase + 0x800000));
  _deltaReady = true;
  _syncLog(`HYBRID delta init: cpuSize=${_cpuTotalSize}B`);
  return true;
};
```

- [ ] **Step 3: Port CPU state capture/restore functions**

Copied verbatim from `netplay-rollback.js:814-884`:

```javascript
const _captureCpuState = (h) => {
  const p = _cpuPtrs, l = _cpuLayout;
  const buf = new Uint8Array(_cpuTotalSize);
  let o = 0;
  buf.set(h.subarray(p.gpr, p.gpr + 256), o); o += 256;
  buf.set(h.subarray(p.cp0, p.cp0 + l.cp0Count * 4), o); o += l.cp0Count * 4;
  buf.set(h.subarray(p.nextInt, p.nextInt + 4), o); o += 4;
  buf.set(h.subarray(p.cp1, p.cp1 + 32 * l.cp1Size), o); o += 32 * l.cp1Size;
  buf.set(h.subarray(p.fcr0, p.fcr0 + 4), o); o += 4;
  buf.set(h.subarray(p.fcr31, p.fcr31 + 4), o); o += 4;
  buf.set(h.subarray(p.llbit, p.llbit + 4), o); o += 4;
  buf.set(h.subarray(p.hi, p.hi + 8), o); o += 8;
  buf.set(h.subarray(p.lo, p.lo + 8), o); o += 8;
  buf.set(h.subarray(p.pc, p.pc + 4), o); o += 4;
  buf.set(h.subarray(p.viField, p.viField + 4), o); o += 4;
  buf.set(h.subarray(p.viDelay, p.viDelay + 4), o); o += 4;
  buf.set(h.subarray(p.tlb, p.tlb + 32 * l.tlbEntrySize), o); o += 32 * l.tlbEntrySize;
  buf.set(h.subarray(p.spMem, p.spMem + l.spMemSize), o); o += l.spMemSize;
  buf.set(h.subarray(p.pifRam, p.pifRam + l.pifRamSize), o);
  return buf;
};

const _restoreCpuState = (h, buf) => {
  const p = _cpuPtrs, l = _cpuLayout;
  let o = 0;
  h.set(buf.subarray(o, o + 256), p.gpr); o += 256;
  h.set(buf.subarray(o, o + l.cp0Count * 4), p.cp0); o += l.cp0Count * 4;
  h.set(buf.subarray(o, o + 4), p.nextInt); o += 4;
  h.set(buf.subarray(o, o + 32 * l.cp1Size), p.cp1); o += 32 * l.cp1Size;
  h.set(buf.subarray(o, o + 4), p.fcr0); o += 4;
  h.set(buf.subarray(o, o + 4), p.fcr31); o += 4;
  h.set(buf.subarray(o, o + 4), p.llbit); o += 4;
  h.set(buf.subarray(o, o + 8), p.hi); o += 8;
  h.set(buf.subarray(o, o + 8), p.lo); o += 8;
  h.set(buf.subarray(o, o + 4), p.pc); o += 4;
  h.set(buf.subarray(o, o + 4), p.viField); o += 4;
  h.set(buf.subarray(o, o + 4), p.viDelay); o += 4;
  h.set(buf.subarray(o, o + 32 * l.tlbEntrySize), p.tlb); o += 32 * l.tlbEntrySize;
  h.set(buf.subarray(o, o + l.spMemSize), p.spMem); o += l.spMemSize;
  h.set(buf.subarray(o, o + l.pifRamSize), p.pifRam);
};
```

- [ ] **Step 4: Port delta capture/restore functions**

Copied from `netplay-rollback.js:886-918`:

```javascript
const _captureDelta = (mod) => {
  if (!_deltaReady || !mod?.HEAPU8) return null;
  const rdram = mod.HEAPU8;
  const changedPages = [];
  for (let i = 0; i < _PAGE_COUNT; i++) {
    const off = _rdramBase + i * _PAGE_SIZE;
    const bOff = i * _PAGE_SIZE;
    if (
      rdram[off] !== _deltaBaseline[bOff] ||
      rdram[off + 1024] !== _deltaBaseline[bOff + 1024] ||
      rdram[off + 2048] !== _deltaBaseline[bOff + 2048] ||
      rdram[off + 3072] !== _deltaBaseline[bOff + 3072]
    ) {
      changedPages.push({ idx: i, data: rdram.slice(off, off + _PAGE_SIZE) });
      _deltaBaseline.set(rdram.subarray(off, off + _PAGE_SIZE), bOff);
    }
  }
  const cpuSnap = _captureCpuState(mod.HEAPU8);
  return { changedPages, cpuSnap, changed: changedPages.length };
};

const _restoreDelta = (mod, targetFrame) => {
  const entry = _deltaRing[targetFrame % _RING_SIZE];
  if (!entry || entry.frame !== targetFrame) return false;
  if (entry.cpuSnap) _restoreCpuState(mod.HEAPU8, entry.cpuSnap);
  if (entry.changedPages && mod?.HEAPU8) {
    for (const page of entry.changedPages) {
      mod.HEAPU8.set(page.data, _rdramBase + page.idx * _PAGE_SIZE);
    }
    _deltaBaseline.set(mod.HEAPU8.subarray(_rdramBase, _rdramBase + 0x800000));
  }
  return true;
};
```

- [ ] **Step 5: Add _initDeltaBaseline and _flushRollbackState helpers**

These are called on screen transitions (from Task 5, Step 2):

```javascript
const _initDeltaBaseline = (mod) => {
  if (!_hybridMode) return;
  if (!_deltaReady) {
    if (!_initDelta(mod)) {
      _syncLog('HYBRID delta init FAILED — rollback unavailable');
      return;
    }
  }
  // Refresh baseline from current RDRAM state
  if (mod?.HEAPU8 && _deltaBaseline) {
    _deltaBaseline.set(mod.HEAPU8.subarray(_rdramBase, _rdramBase + 0x800000));
  }
  // Clear ring buffer for fresh rollback window
  _deltaRing.fill(null);
  _syncLog(`HYBRID delta baseline refreshed at frame ${_frameNum}`);
};

const _flushRollbackState = () => {
  if (!_hybridMode) return;
  // Clear prediction tracking
  for (const s of Object.keys(_inputHistory)) delete _inputHistory[s];
  for (const s of Object.keys(_inputConfirmed)) delete _inputConfirmed[s];
  _deltaRing.fill(null);
  _inRollback = false;
  _syncLog(
    `HYBRID rollback state flushed — predictions=${_rollbackStats.totalPredictions} ` +
    `rollbacks=${_rollbackStats.rollbacksTriggered} ` +
    `avgDepth=${_rollbackStats.rollbacksTriggered > 0 ? (_rollbackStats.totalRollbackDepth / _rollbackStats.rollbacksTriggered).toFixed(1) : 0}`
  );
  // Reset stats for next VS_BATTLE segment
  _rollbackStats = {
    totalPredictions: 0, correctPredictions: 0,
    rollbacksTriggered: 0, totalRollbackDepth: 0,
    maxRollbackDepth: 0, totalReplayMs: 0,
  };
};
```

- [ ] **Step 6: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: port delta snapshot system for hybrid rollback"
```

---

## Chunk 4: Prediction and Rollback in Tick Loop

### Task 7: Modify tick() to predict instead of stall during VS_BATTLE

**Files:**
- Modify: `web/static/netplay-lockstep.js` — tick() function, around line 4055 (the `if (!allArrived)` block)

This is the core behavioral change. When `_hybridMode && _inRollbackScreen`, missing input triggers prediction instead of stall. When not in rollback screen (or not hybrid), existing lockstep stall behavior runs unchanged.

- [ ] **Step 1: Add prediction logic to the missing-input block**

In tick(), the `if (!allArrived)` block (around line 4055) currently runs stall/gap-fill/fabrication logic. Wrap it with a hybrid check:

```javascript
if (!allArrived) {
  // ── HYBRID: predict during VS_BATTLE instead of stalling ──
  if (_hybridMode && _inRollbackScreen && !_inRollback) {
    for (const s of _missingSlots) {
      if (!_remoteInputs[s]) _remoteInputs[s] = {};
      if (_remoteInputs[s][applyFrame] === undefined) {
        const lastFrame = _lastRemoteFramePerSlot[s] ?? -1;
        const predicted =
          lastFrame >= 0 && _remoteInputs[s][lastFrame] !== undefined
            ? _remoteInputs[s][lastFrame]
            : KNShared.ZERO_INPUT;
        _remoteInputs[s][applyFrame] = predicted;
        if (!_inputHistory[s]) _inputHistory[s] = {};
        if (!_inputConfirmed[s]) _inputConfirmed[s] = {};
        _inputHistory[s][applyFrame] = predicted;
        _inputConfirmed[s][applyFrame] = false;
        _rollbackStats.totalPredictions++;
      }
    }
    allArrived = true; // proceed with predicted input
    _stallStart = 0;
  } else {
    // ── Original lockstep stall logic (unchanged) ──
    // ... existing gap-fill, phantom, stall, fabrication code ...
  }
}
```

The existing stall code block (gap-fill, phantom detection, hard timeout, resend) goes into the `else` branch. No modifications to the lockstep stall logic itself.

- [ ] **Step 2: Modify frame pacing for hybrid rollback screen**

In tick(), the frame pacing block (around line 3942) uses proportional throttle for lockstep. During rollback screen, use simpler pacing (only throttle if `_ROLLBACK_MAX` frames ahead), matching rollback engine behavior:

```javascript
if (_frameNum >= FRAME_PACING_WARMUP) {
  if (_hybridMode && _inRollbackScreen) {
    // Rollback pacing: only cap if too far ahead
    let minRemoteFrame = Infinity;
    for (const p of getInputPeers()) {
      if (_peerPhantom[p.slot]) continue;
      const rf = _lastRemoteFramePerSlot[p.slot] ?? -1;
      if (rf < minRemoteFrame) minRemoteFrame = rf;
    }
    if (minRemoteFrame >= 0 && _frameNum - minRemoteFrame > _ROLLBACK_MAX) {
      return; // skip tick to let peer catch up
    }
  } else {
    // ... existing proportional pacing (unchanged) ...
  }
}
```

- [ ] **Step 3: Defer input cleanup during rollback screen**

In the lockstep engine, line 4189 deletes `_remoteInputs[peerSlot][applyFrame]` after applying each frame. This breaks rollback replay which needs to re-read those inputs. Gate the deletion:

```javascript
// After writing remote inputs (around line 4185-4189):
for (let m = 0; m < inputPeers.length; m++) {
  const peerSlot = inputPeers[m].slot;
  const remoteInput = (_remoteInputs[peerSlot] && _remoteInputs[peerSlot][applyFrame]) || KNShared.ZERO_INPUT;
  writeInputToMemory(peerSlot, remoteInput);
  // During hybrid rollback screen, keep inputs for replay; only delete old ones
  if (_hybridMode && _inRollbackScreen) {
    // Cleanup entries older than rollback window
    const cleanBefore = applyFrame - _ROLLBACK_MAX - 10;
    if (_remoteInputs[peerSlot]) {
      for (const f of Object.keys(_remoteInputs[peerSlot])) {
        if (parseInt(f) < cleanBefore) delete _remoteInputs[peerSlot][f];
      }
    }
  } else if (_remoteInputs[peerSlot]) {
    delete _remoteInputs[peerSlot][applyFrame]; // original lockstep behavior
  }
}
```

- [ ] **Step 4: Cleanup prediction tracking per frame**

After the input handling block, add per-frame cleanup of `_inputHistory` and `_inputConfirmed` to prevent unbounded growth during long VS matches:

```javascript
// After input application, during rollback screen
if (_hybridMode && _inRollbackScreen) {
  const historyCleanBefore = applyFrame - _ROLLBACK_MAX - 10;
  for (const s of Object.keys(_inputHistory)) {
    for (const f of Object.keys(_inputHistory[s])) {
      if (parseInt(f) < historyCleanBefore) {
        delete _inputHistory[s][f];
        if (_inputConfirmed[s]) delete _inputConfirmed[s][f];
      }
    }
  }
}
```

- [ ] **Step 5: Capture delta snapshot after each frame during VS_BATTLE**

After `_frameNum++` (line 4301 — MUST be after the increment, not before, so the delta captures pre-frame-N state matching the rollback engine's semantics), add:

```javascript
// ── Hybrid: capture delta for rollback ──
if (_hybridMode && _inRollbackScreen && _deltaReady) {
  const delta = _captureDelta(tickMod);
  if (delta) {
    _deltaRing[_frameNum % _RING_SIZE] = { frame: _frameNum, ...delta };
  }
}
```

Note: `_frameNum` was just incremented, so this stores the snapshot indexed by the new frame number (post-step state = pre-next-frame state). This matches the rollback engine's pattern.

- [ ] **Step 6: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: hybrid tick predicts input during VS_BATTLE, stalls during menus"
```

### Task 8: Add rollback replay on misprediction

**Files:**
- Modify: `web/static/netplay-lockstep.js` — DataChannel message handler (where binary 16-byte input messages are decoded)

When a corrected input arrives for a frame that was predicted, check if the prediction was wrong. If so, restore the delta snapshot and replay frames with corrected input.

- [ ] **Step 1: Locate the input receive handler**

In the lockstep engine, binary input messages are handled in the `createPeer()` function's `dc.onmessage` handler. Search for `e.data instanceof ArrayBuffer && e.data.byteLength === 16`. This is where `decodeInput` is called and `_remoteInputs[peer.slot][recvFrame]` is set.

- [ ] **Step 2: Add rollback check after input decode**

After decoding the input and before storing it in `_remoteInputs`, add the rollback check. This goes right after the `decodeInput` call:

```javascript
// Binary: encoded input — 16 bytes
if (e.data instanceof ArrayBuffer && e.data.byteLength === 16) {
  if (peer.slot === null || peer.slot === undefined) return;
  const decoded = KNShared.decodeInput(e.data);
  const recvFrame = decoded.frame;
  const recvInput = {
    buttons: decoded.buttons, lx: decoded.lx, ly: decoded.ly,
    cx: decoded.cx, cy: decoded.cy,
  };

  // ── HYBRID: check if this corrects a misprediction ──
  if (_hybridMode && _inRollbackScreen && !_inRollback && _deltaReady) {
    const wasPredicted = _inputConfirmed[peer.slot]?.[recvFrame] === false;
    if (wasPredicted) {
      const oldP = _inputHistory[peer.slot]?.[recvFrame];
      const match = oldP &&
        oldP.buttons === recvInput.buttons &&
        oldP.lx === recvInput.lx &&
        oldP.ly === recvInput.ly;

      if (match) {
        _rollbackStats.correctPredictions++;
      } else if (recvFrame < _frameNum) {
        const depth = _frameNum - recvFrame;
        if (depth <= _ROLLBACK_MAX &&
            _deltaRing[recvFrame % _RING_SIZE]?.frame === recvFrame) {
          // Misprediction — rollback needed
          _rollbackStats.rollbacksTriggered++;
          _rollbackStats.totalRollbackDepth += depth;
          if (depth > _rollbackStats.maxRollbackDepth) {
            _rollbackStats.maxRollbackDepth = depth;
          }
          _syncLog(
            `ROLLBACK f=${_frameNum} toFrame=${recvFrame} depth=${depth} ` +
            `slot=${peer.slot}`
          );

          // Store corrected input before rollback
          if (!_remoteInputs[peer.slot]) _remoteInputs[peer.slot] = {};
          _remoteInputs[peer.slot][recvFrame] = recvInput;

          // Perform rollback replay
          _inRollback = true;
          const rbStart = performance.now();
          const mod = window.EJS_emulator?.gameManager?.Module;

          if (_restoreDelta(mod, recvFrame)) {
            const savedFrame = _frameNum;
            _frameNum = recvFrame;
            const lastReplayFrame = savedFrame - 1;

            // Headless for intermediate frames (faster replay)
            if (depth > 1 && mod?._kn_set_headless) {
              mod._kn_set_headless(1);
            }

            for (let rf = recvFrame; rf < savedFrame; rf++) {
              // Render last frame normally for GL state + audio
              if (rf === lastReplayFrame) {
                if (mod?._kn_set_headless) mod._kn_set_headless(0);
                if (mod?._kn_reset_audio) mod._kn_reset_audio();
              }
              // Apply inputs for replayed frame
              for (let zs = 0; zs < 4; zs++) writeInputToMemory(zs, 0);
              const replayLocal = _localInputs[rf] || KNShared.ZERO_INPUT;
              writeInputToMemory(_playerSlot, replayLocal);
              for (const rp of Object.values(_peers)) {
                if (rp.slot === null || rp.slot === undefined) continue;
                const ri = _remoteInputs[rp.slot]?.[rf] || KNShared.ZERO_INPUT;
                writeInputToMemory(rp.slot, ri);
              }
              _syncRNGSeed(mod, rf);
              _inDeterministicStep = true;
              stepOneFrame();
              _inDeterministicStep = false;
              _frameNum++;
              // Re-capture delta for replayed frame
              if (_deltaReady) {
                const rDelta = _captureDelta(mod);
                if (rDelta) {
                  _deltaRing[rf % _RING_SIZE] = { frame: rf, ...rDelta };
                }
              }
            }
            feedAudio();
            const rbMs = performance.now() - rbStart;
            _rollbackStats.totalReplayMs += rbMs;
            _syncLog(
              `REPLAY-DONE f=${_frameNum} depth=${depth} ` +
              `replayMs=${rbMs.toFixed(1)}`
            );
          } else {
            _syncLog(
              `ROLLBACK-FAILED f=${recvFrame} — snapshot not available`
            );
            if (mod?._kn_set_headless) mod._kn_set_headless(0);
          }
          _inRollback = false;
        }
      }
      if (!_inputConfirmed[peer.slot]) _inputConfirmed[peer.slot] = {};
      _inputConfirmed[peer.slot][recvFrame] = true;
    }
  }

  // Store input (existing code — unchanged)
  if (!_remoteInputs[peer.slot]) _remoteInputs[peer.slot] = {};
  _remoteInputs[peer.slot][recvFrame] = recvInput;
  // ... rest of existing input handling ...
}
```

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: rollback replay on misprediction during hybrid VS_BATTLE"
```

---

## Chunk 5: Polish, Logging, and Mode Reporting

### Task 9: Update getInfo() and logging for hybrid mode

**Files:**
- Modify: `web/static/netplay-lockstep.js` — getInfo(), periodic logging in tick()

- [ ] **Step 1: Update getInfo() to report hybrid mode**

In the `getInfo()` export (around line 5377):

```javascript
// Before:
mode: 'lockstep',

// After:
mode: _hybridMode ? 'hybrid' : 'lockstep',
```

Also add rollback stats when in hybrid mode:

```javascript
getInfo: () => {
  // ... existing code ...
  const info = {
    fps: _fpsCurrent,
    frameDelay: DELAY_FRAMES,
    ping: rtt,
    playerCount: peers.length + 1,
    frame: _frameNum,
    running: _running,
    mode: _hybridMode ? 'hybrid' : 'lockstep',
    syncEnabled: _syncEnabled,
    resyncCount: _resyncCount,
    peers: peerInfo,
  };
  if (_hybridMode) {
    info.screen = _currentScreen;
    info.inRollback = _inRollbackScreen;
    info.rollbackStats = { ..._rollbackStats };
  }
  return info;
},
```

- [ ] **Step 2: Add hybrid stats to periodic logging**

In the periodic input log (every 60 frames, around line 4210), append hybrid stats:

```javascript
if (_frameNum % 60 === 0) {
  // ... existing INPUT-LOG ...

  // Hybrid rollback stats (every 5s)
  if (_hybridMode && _frameNum % 300 === 0 && _inRollbackScreen) {
    _syncLog(
      `HYBRID-STATS f=${_frameNum} screen=0x${_currentScreen.toString(16)} ` +
      `predictions=${_rollbackStats.totalPredictions} ` +
      `correct=${_rollbackStats.correctPredictions} ` +
      `rollbacks=${_rollbackStats.rollbacksTriggered} ` +
      `maxDepth=${_rollbackStats.maxRollbackDepth} ` +
      `avgReplayMs=${_rollbackStats.rollbacksTriggered > 0 ? (_rollbackStats.totalReplayMs / _rollbackStats.rollbacksTriggered).toFixed(1) : 0}`
    );
  }
}
```

- [ ] **Step 3: Reset hybrid state in stop()**

In the `stop()` function, add cleanup for hybrid state:

```javascript
const stop = () => {
  // ... existing stop code ...

  // Hybrid cleanup
  if (_hybridMode) {
    _flushRollbackState();
    _deltaReady = false;
    _deltaBaseline = null;
    _cpuPtrs = null;
    _cpuLayout = null;
    _currentScreen = -1;
    _prevScreen = -1;
    _inRollbackScreen = false;
  }
};
```

- [ ] **Step 4: Reset hybrid state in init()**

In the `init()` function, reset hybrid state so re-init (new game) starts clean:

```javascript
// Reset hybrid state
_currentScreen = -1;
_prevScreen = -1;
_inRollbackScreen = false;
_deltaReady = false;
_deltaBaseline = null;
_deltaRing.fill(null);
_inRollback = false;
for (const s of Object.keys(_inputHistory)) delete _inputHistory[s];
for (const s of Object.keys(_inputConfirmed)) delete _inputConfirmed[s];
_rollbackStats = {
  totalPredictions: 0, correctPredictions: 0,
  rollbacksTriggered: 0, totalRollbackDepth: 0,
  maxRollbackDepth: 0, totalReplayMs: 0,
};
```

- [ ] **Step 5: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: hybrid mode reporting, logging, and state cleanup"
```

### Task 10: Final integration commit

- [ ] **Step 1: Verify all files are consistent**

Run a quick grep to verify all mode references are complete:
```bash
grep -rn '"hybrid"' server/src/api/ web/play.html web/static/play.js web/static/netplay-lockstep.js
```

Expected matches:
- `payloads.py`: 2 lines (StartGamePayload, SetModePayload)
- `signaling.py`: 2 lines (_VALID_MODES, engine check)
- `play.html`: 1 line (option element)
- `play.js`: 2+ lines (engine init, UI visibility)
- `netplay-lockstep.js`: multiple lines (mode flag, getInfo, logging)

- [ ] **Step 2: Verify no syntax errors in JS**

```bash
node -c web/static/netplay-lockstep.js && echo "OK"
node -c web/static/play.js && echo "OK"
```

- [ ] **Step 3: Verify server starts**

```bash
cd server && python -c "from src.api.payloads import StartGamePayload, SetModePayload; print('payloads OK')"
cd server && python -c "from src.api.signaling import _VALID_MODES; assert 'hybrid' in _VALID_MODES; print('signaling OK')"
```

---

## Testing Priorities (Manual)

EJS emulator cannot boot in Playwright. All functional testing is manual (user tests on desktop Safari <-> mobile Safari).

1. **Screen detection**: Start a game in hybrid mode. Open browser console. Look for `SCREEN-CHANGE` log entries as you navigate CSS -> Stage Select -> VS Battle -> Results -> CSS. Verify screen IDs match expected values (`0x10`, `0x15`, `0x16`, `0x18`).

2. **Lockstep menus**: In hybrid mode, verify character/stage/costume selection matches across both players. Both should see the same random characters. This is the core value proposition.

3. **Rollback gameplay**: During VS Battle, verify:
   - No freezes or stutters beyond normal
   - `HYBRID-STATS` logs show predictions and rollbacks firing
   - `REPLAY-DONE` logs show reasonable replay times (<20ms for depth 1-3)

4. **Mode transitions**: Play a full session: CSS -> gameplay -> results -> CSS. Verify:
   - `SCREEN-CHANGE` logs at each transition
   - No crashes on transition
   - Lockstep resumes cleanly after results screen
   - `rollback state flushed` appears on gameplay exit

5. **Pure lockstep unaffected**: Start a game in lockstep mode (not hybrid). Verify behavior is identical to before — no rollback code runs, no screen detection, no performance impact.

---

## Dead Ends — Do NOT Retry

These approaches were tried and failed during the rollback development session:

- Per-frame RDRAM instruction scanning (8MB scan kills FPS)
- Per-frame RNG address re-enforcement via stored HEAPU32 indices (corrupts video state)
- Function body redirect via `j get_random_int_` (breaks callee-saved registers)
- ROM-level `advance_rng` store NOP (breaks ALL RNG)
- Frame-varying JS seed without frame sync (different frames -> different results)
- Constant seed with no advancement (same chars every game)
- `id_table` identity mapping (chars still differ)
