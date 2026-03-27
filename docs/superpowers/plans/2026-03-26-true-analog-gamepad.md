# True Analog Gamepad Input Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace binary on/off analog stick input with continuous analog values using RMG-K's three-stage pipeline, enabling walk/dash/DI precision in SSB64.

**Architecture:** Gamepad-manager gets a true analog pipeline (deadzone → linear scale → N64 quantize at 66%). The wire format changes from 8-byte bitmask to 16-byte input object. shared.js gets encode/decode utilities used by both netplay engines (DRY). readLocalInput returns an input object instead of an integer mask.

**Tech Stack:** JavaScript (IIFE + window globals, no ES modules), WebRTC DataChannels, Gamepad API

**Spec:** `docs/superpowers/specs/2026-03-26-true-analog-gamepad-design.md`

---

## Chunk 1: Shared Utilities + Gamepad Pipeline

### Task 1: Add wire format utilities to shared.js

**Files:**
- Modify: `web/static/shared.js`

- [ ] **Step 1: Add input constants and helpers after the `KNState` section**

Find the `window.KNShared = {` assignment (around line 381). Before it, add:

```javascript
  // ── Input encoding (shared by lockstep + streaming engines) ──────────
  const N64_MAX = 83; // floor(127 * 0.66) — community standard analog range
  const WASM_SCALE = 32767 / N64_MAX; // ~394.8 — maps N64 range to WASM ±32767

  const ZERO_INPUT = Object.freeze({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });

  const inputEqual = (a, b) =>
    a.buttons === b.buttons && a.lx === b.lx && a.ly === b.ly && a.cx === b.cx && a.cy === b.cy;

  const packStick = (x, y) => (x & 0xFFFF) | ((y & 0xFFFF) << 16);
  const unpackX = (packed) => (packed << 16) >> 16;
  const unpackY = (packed) => packed >> 16;

  const encodeInput = (frame, input) =>
    new Int32Array([frame, input.buttons, packStick(input.lx, input.ly), packStick(input.cx, input.cy)]);

  const decodeInput = (buf) => {
    const arr = new Int32Array(buf);
    return {
      frame: arr[0],
      buttons: arr[1],
      lx: unpackX(arr[2]), ly: unpackY(arr[2]),
      cx: unpackX(arr[3]), cy: unpackY(arr[3]),
    };
  };

  // Streaming uses 12-byte format (no frame number)
  const encodeStreamingInput = (input) =>
    new Int32Array([input.buttons, packStick(input.lx, input.ly), packStick(input.cx, input.cy)]);

  const decodeStreamingInput = (buf) => {
    const arr = new Int32Array(buf);
    return {
      buttons: arr[0],
      lx: unpackX(arr[1]), ly: unpackY(arr[1]),
      cx: unpackX(arr[2]), cy: unpackY(arr[2]),
    };
  };
```

- [ ] **Step 2: Export the new utilities via KNShared**

Add to the `window.KNShared = {` object:

```javascript
    N64_MAX,
    WASM_SCALE,
    ZERO_INPUT,
    inputEqual,
    encodeInput,
    decodeInput,
    encodeStreamingInput,
    decodeStreamingInput,
    packStick,
    unpackX,
    unpackY,
```

- [ ] **Step 3: Commit**

```bash
git add web/static/shared.js
git commit -m "feat: add input encode/decode utilities to shared.js (DRY)"
```

---

### Task 2: True analog pipeline in gamepad-manager.js

**Files:**
- Modify: `web/static/gamepad-manager.js:145-189`

- [ ] **Step 1: Add analog pipeline constants**

After the `PROFILES` array (after line 60), add:

```javascript
  // ── Analog Pipeline Constants ──────────────────────────────────────
  const _DEADZONE = 0.15;
  const _RANGE = 66; // percentage — community standard matching N-Rage/RMG-K
  const _N64_MAX = Math.floor(127 * (_RANGE / 100)); // 83

  function _analogScale(value) {
    const sign = Math.sign(value);
    const abs = Math.abs(value);
    if (abs < _DEADZONE) return 0;
    const scaled = (abs - _DEADZONE) / (1 - _DEADZONE);
    return sign * Math.min(Math.round(scaled * _N64_MAX), _N64_MAX);
  }

  function _digitalSnap(value) {
    // For C-stick (digital C-buttons): deadzone check then snap to 0 or ±max
    const abs = Math.abs(value);
    if (abs < _DEADZONE) return 0;
    return Math.sign(value) * _N64_MAX;
  }
```

- [ ] **Step 2: Replace readGamepad to return input object**

Replace the `readGamepad` function (currently lines 143-189) with:

```javascript
  function readGamepad(slot) {
    const gpIndex = _assignments[slot];
    if (gpIndex === undefined) return null;

    const gp = _nativeGetGamepads()[gpIndex];
    if (!gp) return null;

    const entry = _detected[gpIndex];
    if (!entry) return null;

    const profile = entry.profile;
    let buttons = 0;

    // Map buttons (digital — unchanged)
    for (const [btnIdx, bitmask] of Object.entries(profile.buttons)) {
      const idx = parseInt(btnIdx, 10);
      if (idx < gp.buttons.length && gp.buttons[idx].pressed) {
        buttons |= bitmask;
      }
    }

    // Left stick — true analog via three-stage pipeline
    let lx = 0, ly = 0;
    if (profile.axes) {
      const axX = profile.axes.stickX;
      const axY = profile.axes.stickY;
      if (axX && axX.index < gp.axes.length) lx = _analogScale(gp.axes[axX.index]);
      if (axY && axY.index < gp.axes.length) ly = _analogScale(gp.axes[axY.index]);
    }

    // C-stick — digital snap (N64 C-buttons are on/off)
    let cx = 0, cy = 0;
    const axBtn = profile.axisButtons;
    if (axBtn) {
      // Right stick X (axis 2): C-Left/C-Right
      if (axBtn[2] && 2 < gp.axes.length) cx = _digitalSnap(gp.axes[2]);
      // Right stick Y (axis 3): C-Up/C-Down
      if (axBtn[3] && 3 < gp.axes.length) cy = _digitalSnap(gp.axes[3]);
    }

    return { buttons, lx, ly, cx, cy };
  }
```

- [ ] **Step 3: Update profile deadzone default**

Change line 45 from:
```javascript
    deadzone: 0.3,
```
To:
```javascript
    deadzone: 0.15,
```

Note: The per-profile deadzone is still stored but the analog pipeline uses `_DEADZONE` directly. This keeps the profile field for Phase 2 configurability.

- [ ] **Step 4: Verify no lint errors**

Run: `cd /Users/kazon/kaillera-next && npx prettier --check web/static/gamepad-manager.js`

- [ ] **Step 5: Commit**

```bash
git add web/static/gamepad-manager.js
git commit -m "feat: true analog pipeline in gamepad-manager (deadzone → scale → N64 quantize)"
```

---

## Chunk 2: readLocalInput + applyInputToWasm Restructure

### Task 3: Restructure readLocalInput to return input object

**Files:**
- Modify: `web/static/shared.js:196-287`

- [ ] **Step 1: Add readKeyboardAxes helper**

Before `readLocalInput` (around line 196), add:

```javascript
  const readKeyboardAxes = (keyMap, heldKeys) => {
    const N64_MAX = 83;
    const hasKey = (bit) => {
      for (const kc of heldKeys) {
        if (keyMap[kc] === bit) return true;
      }
      return false;
    };
    const axis = (posBit, negBit) => {
      const pos = hasKey(posBit);
      const neg = hasKey(negBit);
      if (pos && neg) return 0; // opposing cancellation
      if (pos) return N64_MAX;
      if (neg) return -N64_MAX;
      return 0;
    };
    return {
      lx: axis(16, 17), ly: axis(18, 19),
      cx: axis(20, 21), cy: axis(22, 23),
    };
  };

  const readKeyboardButtons = (keyMap, heldKeys) => {
    let buttons = 0;
    heldKeys.forEach((kc) => {
      const btnIdx = keyMap[kc];
      if (btnIdx !== undefined && btnIdx < 16) buttons |= 1 << btnIdx;
    });
    return buttons;
  };
```

- [ ] **Step 2: Replace readLocalInput**

Replace the entire `readLocalInput` function (lines 203-287) with:

```javascript
  const readLocalInput = (playerSlot, keyMap, heldKeys) => {
    const input = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };

    // Suppress all input while remap wizard is active
    if (KNState.remapActive) return { ...ZERO_INPUT };

    // 1. Gamepad (analog pipeline, highest fidelity for axes)
    if (document.hasFocus() && window.GamepadManager) {
      const gp = GamepadManager.readGamepad(playerSlot);
      if (gp) {
        input.buttons |= gp.buttons;
        input.lx = gp.lx;
        input.ly = gp.ly;
        input.cx = gp.cx;
        input.cy = gp.cy;
      }
    }

    // 2. Keyboard (digital, with opposing cancellation)
    //    Buttons always merge; axes only if gamepad didn't provide them
    if (keyMap) {
      input.buttons |= readKeyboardButtons(keyMap, heldKeys);
      const kb = readKeyboardAxes(keyMap, heldKeys);
      if (input.lx === 0 && input.ly === 0) {
        input.lx = kb.lx;
        input.ly = kb.ly;
      }
      if (input.cx === 0 && input.cy === 0) {
        input.cx = kb.cx;
        input.cy = kb.cy;
      }
    }

    // 3. Touch/virtual gamepad (mobile)
    const ejs = window.EJS_emulator;
    const ejsMenuOpen =
      ejs &&
      (ejs.settingsMenuOpen ||
        ejs.isPopupOpen?.() ||
        (ejs.elements?.menu && !ejs.elements.menu.classList.contains('ejs_menu_bar_hidden')));
    if (ejsMenuOpen) {
      for (const ck in KNState.touchInput) {
        if (KNState.touchInput.hasOwnProperty(ck)) KNState.touchInput[ck] = 0;
      }
    }

    // Touch left stick: only if no gamepad/keyboard axis input
    const TOUCH_ABS_DEADZONE = 3500;
    const TOUCH_MAX = 32767;
    const N64_MAX = 83;
    const stR = KNState.touchInput[16] || 0;
    const stL = KNState.touchInput[17] || 0;
    const stD = KNState.touchInput[18] || 0;
    const stU = KNState.touchInput[19] || 0;
    const stMajor = Math.max(stR, stL, stD, stU);
    if (input.lx === 0 && input.ly === 0 && stMajor > TOUCH_ABS_DEADZONE) {
      const stThresh = stMajor * 0.4;
      // Convert per-direction magnitudes to signed N64 range
      const touchScale = (pos, neg, thresh) => {
        const p = pos > thresh ? pos : 0;
        const n = neg > thresh ? neg : 0;
        return Math.trunc((p - n) / TOUCH_MAX * N64_MAX);
      };
      input.lx = touchScale(stR, stL, stThresh);
      input.ly = touchScale(stD, stU, stThresh);
    }

    // Touch digital buttons + C-buttons
    for (const ti in KNState.touchInput) {
      const idx = parseInt(ti, 10);
      if (idx >= 16 && idx <= 19) continue; // left stick handled above
      const val = KNState.touchInput[idx];
      if (!val) continue;
      if (idx < 16) {
        input.buttons |= 1 << idx;
      } else if (idx >= 20 && idx <= 23) {
        // C-buttons from touch: snap to ±N64_MAX
        if (input.cx === 0 && input.cy === 0) {
          if (idx === 20 && val > 0) input.cx = N64_MAX;   // C-Right
          if (idx === 21 && val > 0) input.cx = -N64_MAX;  // C-Left
          if (idx === 22 && val > 0) input.cy = N64_MAX;   // C-Down
          if (idx === 23 && val > 0) input.cy = -N64_MAX;  // C-Up
        }
      }
    }

    // Debug input logging
    if (window._debugInputUntil && performance.now() < window._debugInputUntil) {
      if (input.buttons || input.lx || input.ly || input.cx || input.cy) {
        console.log(`[input-debug] buttons=${input.buttons} lx=${input.lx} ly=${input.ly} cx=${input.cx} cy=${input.cy}`);
      }
    }

    return input;
  };
```

- [ ] **Step 3: Commit**

```bash
git add web/static/shared.js
git commit -m "feat: readLocalInput returns input object with analog values + keyboard cancellation"
```

---

### Task 4: Update applyInputToWasm for input objects

**Files:**
- Modify: `web/static/shared.js:344-379`

- [ ] **Step 1: Replace applyInputToWasm**

Replace the entire function (lines 344-379) with:

```javascript
  const applyInputToWasm = (slot, input, prevInputs) => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._simulate_input) return;

    // Optional skip-if-unchanged optimization
    if (prevInputs) {
      const prev = prevInputs[slot];
      if (prev && inputEqual(input, prev)) return;
    }

    // Digital buttons (0-15)
    for (let btn = 0; btn < 16; btn++) {
      mod._simulate_input(slot, btn, (input.buttons >> btn) & 1);
    }

    // Left stick — scale N64 range (±83) to WASM range (±32767)
    const scale = WASM_SCALE; // 32767 / 83
    const clamp = (v) => Math.max(-32767, Math.min(32767, Math.trunc(v * scale)));
    // Bit 16 = X positive (right), 17 = X negative (left)
    mod._simulate_input(slot, 16, input.lx > 0 ? clamp(input.lx) : 0);
    mod._simulate_input(slot, 17, input.lx < 0 ? clamp(-input.lx) : 0);
    // Bit 18 = Y positive (down), 19 = Y negative (up)
    mod._simulate_input(slot, 18, input.ly > 0 ? clamp(input.ly) : 0);
    mod._simulate_input(slot, 19, input.ly < 0 ? clamp(-input.ly) : 0);

    // C-stick (bits 20-23) — same approach, digital values (0 or ±83)
    mod._simulate_input(slot, 20, input.cx > 0 ? clamp(input.cx) : 0);
    mod._simulate_input(slot, 21, input.cx < 0 ? clamp(-input.cx) : 0);
    mod._simulate_input(slot, 22, input.cy > 0 ? clamp(input.cy) : 0);
    mod._simulate_input(slot, 23, input.cy < 0 ? clamp(-input.cy) : 0);

    // Update previous input tracker
    if (prevInputs) {
      prevInputs[slot] = input;
    }
  };
```

- [ ] **Step 2: Export readKeyboardAxes and readKeyboardButtons via KNShared**

Add to the `window.KNShared = {` object:

```javascript
    readKeyboardAxes,
    readKeyboardButtons,
```

- [ ] **Step 3: Commit**

```bash
git add web/static/shared.js
git commit -m "feat: applyInputToWasm accepts input objects with real analog values"
```

---

## Chunk 3: Netplay Engine Migration

### Task 5: Update lockstep engine for 16-byte wire format

**Files:**
- Modify: `web/static/netplay-lockstep.js`

This task updates every site in the lockstep engine that produces, consumes, or stores input data. Use the migration checklist from the spec to find all sites.

- [ ] **Step 1: Find all sites to update**

Run these searches to locate every callsite:

```bash
grep -n 'Int32Array\[frame\|Int32Array(\[.*mask\|byteLength === 8\|_localInputs\[.*\] =\|_remoteInputs\[.*\] = 0\|resendFrame.*localMask' web/static/netplay-lockstep.js
```

- [ ] **Step 2: Update the input send path**

Find every `peer.dc.send(new Int32Array([_frameNum, ...)` and replace with:

```javascript
peer.dc.send(KNShared.encodeInput(_frameNum, localInput).buffer);
```

- [ ] **Step 3: Update the input receive path**

Find `e.data.byteLength === 8` and change to `e.data.byteLength === 16`. Update the decode to:

```javascript
const decoded = KNShared.decodeInput(e.data);
const recvFrame = decoded.frame;
const recvInput = { buttons: decoded.buttons, lx: decoded.lx, ly: decoded.ly, cx: decoded.cx, cy: decoded.cy };
```

- [ ] **Step 4: Update input storage**

Change `_localInputs[frame] = mask` to `_localInputs[frame] = localInput` (the input object).

Change `_remoteInputs[slot][frame] = recvMask` to `_remoteInputs[slot][frame] = recvInput`.

- [ ] **Step 5: Update fabricated zero inputs**

Find every `_remoteInputs[s][applyFrame] = 0` (stall timeout, late-join fill) and replace with:

```javascript
_remoteInputs[s][applyFrame] = KNShared.ZERO_INPUT;
```

- [ ] **Step 6: Update resend path**

Find the resend handler (`e.data.startsWith('resend:')`) and replace:

```javascript
const localInput = _localInputs[resendFrame];
if (localInput !== undefined) {
  try { peer.dc.send(KNShared.encodeInput(resendFrame, localInput).buffer); } catch (_) {}
}
```

- [ ] **Step 7: Update applyInputToWasm calls**

Find every call to `KNShared.applyInputToWasm(slot, mask, ...)` and change to pass the input object instead of the integer mask.

- [ ] **Step 8: Update readLocalInput calls**

`readLocalInput` now returns an object. Find where it's called and ensure the return value is stored as an object, not used as an integer.

- [ ] **Step 9: Verify lint**

Run: `cd /Users/kazon/kaillera-next && npx prettier --check web/static/netplay-lockstep.js`

- [ ] **Step 10: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: lockstep engine uses 16-byte input objects with true analog"
```

---

### Task 6: Update streaming engine for 12-byte wire format

**Files:**
- Modify: `web/static/netplay-streaming.js`

- [ ] **Step 1: Find all sites to update**

```bash
grep -n 'Int32Array(\[mask\|byteLength === 4\|_lastSentMask\|applyInputToWasm' web/static/netplay-streaming.js
```

- [ ] **Step 2: Update guest send path**

Find the guest input send (currently `peer.dc.send(new Int32Array([mask]).buffer)`) and replace with:

```javascript
peer.dc.send(KNShared.encodeStreamingInput(localInput).buffer);
```

- [ ] **Step 3: Update guest delta encoding**

Replace `mask !== _lastSentMask` with:

```javascript
!KNShared.inputEqual(localInput, _lastSentInput)
```

Change `_lastSentMask` variable to `_lastSentInput`, initialized to `KNShared.ZERO_INPUT`.

- [ ] **Step 4: Update host receive path**

Find `e.data.byteLength === 4` and change to `e.data.byteLength === 12`. Decode with:

```javascript
const input = KNShared.decodeStreamingInput(e.data);
```

- [ ] **Step 5: Update applyInputToWasm calls**

Pass input objects instead of integer masks.

- [ ] **Step 6: Update readLocalInput calls**

Same as lockstep — ensure return value is used as an object.

- [ ] **Step 7: Verify lint**

Run: `cd /Users/kazon/kaillera-next && npx prettier --check web/static/netplay-streaming.js`

- [ ] **Step 8: Commit**

```bash
git add web/static/netplay-streaming.js
git commit -m "feat: streaming engine uses 12-byte input objects with true analog"
```

---

## Chunk 4: Integration Verification

### Task 7: Manual integration testing

- [ ] **Step 1: Test gamepad analog in lockstep**

Start `just serve`, create a 2-player lockstep room. With a gamepad:
- Partial tilt the left stick — character should walk (not dash)
- Full tilt — character should dash
- C-buttons via right stick should be digital (on/off)

- [ ] **Step 2: Test keyboard input**

With keyboard:
- Press left+right simultaneously — character should not move (opposing cancellation)
- Single direction — character should move at full speed

- [ ] **Step 3: Test 2-player lockstep wire format**

Open two browser tabs, join the same room, start a lockstep game. Verify:
- Both players can control their characters
- No console errors about byteLength or input format
- Input resend works (slow network simulation via Chrome DevTools throttling)

- [ ] **Step 4: Test streaming mode**

Switch to streaming mode, start a game. Verify:
- Guest inputs reach the host
- No console errors

- [ ] **Step 5: Test mobile touch input**

Open play page on mobile (or Chrome DevTools device emulation). Verify:
- Virtual joystick produces analog movement
- Digital buttons work

- [ ] **Step 6: Fix any issues found, commit**

```bash
git add -A
git commit -m "fix: integration test fixups for true analog input"
```
