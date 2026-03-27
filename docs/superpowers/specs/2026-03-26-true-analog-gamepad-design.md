# True Analog Gamepad Input (Phase 1)

## Problem

Gamepad analog sticks are converted to binary on/off bits in `gamepad-manager.js`. A stick pushed 30% and a stick pushed 100% produce identical input. SSB64 players can't walk (partial tilt), distinguish dash thresholds, or do precise DI. This is the single biggest input quality gap vs native emulators like RMG-K.

## Solution

Replace the binary analog encoding with RMG-K's three-stage analog pipeline, a new 16-byte lockstep wire format, and opposing keyboard input cancellation. Sensible defaults, no UI changes (Phase 2).

## Components

### 1. Three-Stage Analog Pipeline — `gamepad-manager.js`

Replace the current binary threshold conversion with continuous analog output.

**Current behavior (broken):**
```
Browser [-1.0, +1.0] → if |value| > 0.3: set bit → binary on/off
```

**New behavior:**
```
Browser [-1.0, +1.0]
    ↓
Stage 1 — Deadzone: |value| < deadzone → 0
    ↓
Stage 2 — Linear scale: sign(value) × (|value| - deadzone) / (1 - deadzone)
    ↓
Stage 3 — N64 quantize: scaled × max → clamped integer
    where max = floor(127 × (range / 100)) = floor(127 × 0.66) = 83
```

**Formula (matches RMG-K):**
```
result = sign(input) × min((|input| - dz) / (1 - dz) × max, max)
```

**Defaults:**
- Deadzone: `0.15` per axis (lower than current 0.3 — the pipeline handles partial input now)
- Range: `66%` (community standard matching N-Rage/RMG-K, outputs ±83)

**Return value change:**

`GamepadManager.readGamepad(slot)` currently returns a 24-bit integer bitmask. It will return an object:

```javascript
{ buttons: 0xFFFF, lx: -42, ly: 83, cx: 0, cy: -12 }
```

- `buttons`: 16-bit digital button mask (bits 0-15, same mapping as before)
- `lx`, `ly`: left stick X/Y as signed integers in [-83, +83]
- `cx`, `cy`: C-stick X/Y as signed integers — 0 or ±83 (digital threshold)

**C-stick note:** N64 C-buttons are digital (on/off), not analog. The right stick goes through a simplified pipeline: deadzone check, then snaps to 0 or ±max (83). This preserves the digital nature while using the same data format. The left stick gets the full continuous analog pipeline.

### 2. Wire Format — `shared.js`

New 16-byte lockstep DataChannel payload. Encode/decode functions live in `shared.js` so both netplay engines share them (DRY).

**Current:** `Int32Array([frame, inputMask])` — 8 bytes, analog is binary bits.

**New:** `Int32Array([frame, buttons, leftStick, cStick])` — 16 bytes.

```
Int32[0]: frame number
Int32[1]: 16-bit digital button mask (upper 16 bits zero)
Int32[2]: left stick — Int16(X) in lower half, Int16(Y) in upper half
Int32[3]: C-stick  — Int16(X) in lower half, Int16(Y) in upper half
```

**Shared encode/decode utilities in `shared.js`:**

```javascript
const packStick = (x, y) => (x & 0xFFFF) | ((y & 0xFFFF) << 16);
const unpackX = (packed) => (packed << 16) >> 16;  // sign-extend lower 16
const unpackY = (packed) => packed >> 16;           // arithmetic shift

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
```

Int16 is a natural fit — range is [-83, +83] but supports full [-32768, +32767] for future precision.

**Streaming wire format (guest → host):** `Int32Array([buttons, leftStick, cStick])` — 12 bytes (no frame number needed, streaming is not frame-locked). Host receive path checks `byteLength === 12` instead of current `byteLength === 4`. Uses the same `packStick`/`unpackX`/`unpackY` helpers.

**Shared constants and helpers in `shared.js`:**

```javascript
const ZERO_INPUT = Object.freeze({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });

const inputEqual = (a, b) =>
    a.buttons === b.buttons && a.lx === b.lx && a.ly === b.ly && a.cx === b.cx && a.cy === b.cy;
```

`ZERO_INPUT` is used for fabricated inputs (stall timeout, late-join buffer fill). `inputEqual` is used for streaming delta encoding (only send when input changes).

### 3. Input Application — `shared.js`

Update the `_simulate_input` call site to pass real axis values instead of reconstructing from binary bits.

**Current:** Reads binary bits from the 24-bit mask, reconstructs ±32767 (or ±23170 for diagonals), calls `_simulate_input(slot, bitIndex, magnitude)` per axis.

**New:** Receives decoded input object with real axis values. Scales N64-quantized values (±83) back to the WASM core's expected ±32767 range:

```
wasmValue = Math.trunc(axisValue × (32767 / 83))
```

Clamped to [-32767, +32767] to prevent overflow.

Digital buttons remain unchanged (bits 0-15 written as before).

**Skip-if-unchanged optimization:** The current `applyInputToWasm` has an optional `prevMasks` check that skips writes when input hasn't changed (used by streaming mode). With input objects, use `inputEqual()` for this comparison instead of `===`.

Diagonal scaling for gamepad input is removed — analog stick hardware naturally limits diagonal magnitude. Keyboard diagonal scaling is preserved (keyboard axes are always ±1, so diagonal normalization still applies there).

### 3a. `readLocalInput()` Restructure — `shared.js`

`readLocalInput()` is the merge point for all input sources. Currently returns a 24-bit integer mask. Restructured to return an input object:

```javascript
function readLocalInput(slot) {
    const input = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };

    // 1. Gamepad (analog pipeline, highest fidelity)
    if (document.hasFocus() && window.GamepadManager) {
        const gp = GamepadManager.readGamepad(slot);
        if (gp) {
            input.buttons |= gp.buttons;
            input.lx = gp.lx;
            input.ly = gp.ly;
            input.cx = gp.cx;
            input.cy = gp.cy;
        }
    }

    // 2. Keyboard (digital, with opposing cancellation)
    //    Only overrides axes if no gamepad analog input
    if (keyMap) {
        input.buttons |= readKeyboardButtons();
        const kb = readKeyboardAxes();
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
    //    Current touch uses per-direction magnitudes (indices 16-19 for left stick,
    //    20-23 for C-buttons, 0-15 for digital buttons, values 0-32767 per direction).
    //    Convert to signed N64 range:
    //      lx = (touchRight - touchLeft) scaled to [-83, +83]
    //      ly = (touchDown - touchUp) scaled to [-83, +83]
    //    Apply existing absolute deadzone (3500) and relative deadzone (40% cardinal).
    if (KNState.touchInput && input.lx === 0 && input.ly === 0) {
        const t = KNState.touchInput;
        const N64_MAX = 83;
        const TOUCH_MAX = 32767;
        const scale = (pos, neg) => Math.trunc((pos - neg) / TOUCH_MAX * N64_MAX);
        input.lx = scale(t[16] || 0, t[17] || 0);  // right - left
        input.ly = scale(t[18] || 0, t[19] || 0);  // down - up
        input.cx = scale(t[20] || 0, t[21] || 0);  // C-right - C-left
        input.cy = scale(t[22] || 0, t[23] || 0);  // C-down - C-up
        // Digital buttons from touch (indices 0-15)
        for (let i = 0; i < 16; i++) {
            if (t[i]) input.buttons |= (1 << i);
        }
    }

    return input;
}
```

**`readKeyboardAxes()` helper** — new function, extracts axis values from held keys with opposing cancellation:

```javascript
function readKeyboardAxes() {
    const N64_MAX = 83;
    // keyMap maps keycodes to bit indices 16-23
    // bits 16/17 = stick right/left, 18/19 = stick down/up
    // bits 20/21 = C-right/left, 22/23 = C-down/up
    const hasKey = (bit) => { /* check if any held key maps to this bit */ };
    const axis = (posBit, negBit) => {
        const pos = hasKey(posBit);
        const neg = hasKey(negBit);
        if (pos && neg) return 0;  // opposing cancellation
        if (pos) return N64_MAX;
        if (neg) return -N64_MAX;
        return 0;
    };
    return {
        lx: axis(16, 17), ly: axis(18, 19),
        cx: axis(20, 21), cy: axis(22, 23),
    };
}
```

**Priority:** Gamepad analog takes precedence over keyboard/touch for axes. Buttons are OR-merged from all sources.

### 4. Opposing Keyboard Input Cancellation — `shared.js`

Built into `readKeyboardAxes()` above. When a player presses both left and right (or up and down) simultaneously, the `axis()` helper returns 0 (neutral). This is standard behavior in competitive N64 emulators (RMG-K, N-Rage, Project64).

### 5. Rumble — deferred

Rumble requires knowing when the WASM core activates the Rumble Pak. The hook point (PIF command interception or core callback) needs investigation. Deferred from Phase 1 to avoid blocking on WASM investigation. Tracked for Phase 2 or the Competitive Mode extension.

### 6. Netplay Engine Updates — `netplay-lockstep.js`, `netplay-streaming.js`

Both engines switch to the new format using shared utilities from `shared.js`.

**Lockstep engine changes:**
- Send path: `encodeInput(frame, inputObj)` → 16-byte `Int32Array`
- Receive path: `byteLength === 16` guard (update from `=== 8`), `decodeInput(buffer)`
- Input storage: `_localInputs[frame]` and `_remoteInputs[slot][frame]` store input objects
- Resend path: `encodeInput(resendFrame, _localInputs[resendFrame])` (not raw `Int32Array`)
- Stall timeout fabrication: `_remoteInputs[s][applyFrame] = ZERO_INPUT` (not integer `0`)
- Late-join buffer fill: use `ZERO_INPUT` instead of `0`
- Apply path: pass input object to updated `_simulate_input` in `shared.js`

**Streaming engine changes:**
- Guest send path: `Int32Array([input.buttons, packStick(lx,ly), packStick(cx,cy)])` → 12 bytes
- Guest delta check: `inputEqual(input, _lastSentInput)` instead of `mask !== _lastSentMask`
- Host receive path: `byteLength === 12` guard (update from `=== 4`), decode with `unpackX`/`unpackY`
- Host apply path: same updated `_simulate_input`

The shared `encodeInput`/`decodeInput`/`ZERO_INPUT`/`inputEqual` utilities ensure both engines stay DRY.

### Migration Checklist

Every site in the codebase that references the old format must be updated:

| Pattern to find | Files | Update to |
|---|---|---|
| `new Int32Array([frame, mask])` | lockstep | `encodeInput(frame, input)` |
| `new Int32Array([mask])` | streaming | `Int32Array([buttons, packStick(...), packStick(...)])` |
| `byteLength === 8` | lockstep | `byteLength === 16` |
| `byteLength === 4` | streaming | `byteLength === 12` |
| `_localInputs[f] = mask` (integer) | lockstep | `_localInputs[f] = inputObj` |
| `_remoteInputs[s][f] = 0` | lockstep | `_remoteInputs[s][f] = ZERO_INPUT` |
| `mask !== _lastSentMask` | streaming | `!inputEqual(input, _lastSentInput)` |
| `peer.dc.send(new Int32Array([resendFrame, localMask]))` | lockstep | `peer.dc.send(encodeInput(resendFrame, localInput).buffer)` |

## What Changes

| File | Change |
|---|---|
| `gamepad-manager.js` | Analog pipeline replaces binary threshold. Returns `{buttons, lx, ly, cx, cy}` instead of bitmask. |
| `shared.js` | Wire format encode/decode utilities (`encodeInput`, `decodeInput`, `ZERO_INPUT`, `inputEqual`). Restructured `readLocalInput()`. Updated `_simulate_input` for real axis values. Keyboard opposing cancellation. |
| `netplay-lockstep.js` | Uses shared encode/decode. Stores input objects. 16-byte DataChannel payload. Updated `byteLength` guards, resend path, stall fabrication. |
| `netplay-streaming.js` | Uses shared encode/decode. 12-byte guest→host payload. Updated `byteLength` guard, delta encoding with `inputEqual`. |

## What Doesn't Change

- Remapping wizard (maps buttons only, analog axes are automatic from stick hardware)
- Profile system structure (same localStorage format, just deadzone/range defaults added)
- Device detection (500ms poll interval)
- Streaming mode video/audio paths
- WebRTC signaling flow
- ROM sharing
- No UI additions (Phase 2)

## Defaults

| Setting | Value | Rationale |
|---|---|---|
| Deadzone | 0.15 (15%) | Lower than current 0.3 — continuous output handles partial input. Prevents stick drift on most controllers. |
| Range | 66% | Community standard (N-Rage, RMG-K). Maps to ±83 N64 units. Matches competitive SSB64 expectations. |

These are hardcoded for Phase 1. Phase 2 adds per-axis deadzone sliders and range configuration UI.

## Testing Strategy

- Manual: verify analog stick produces walk speed (partial tilt) vs dash (full tilt) in SSB64
- Manual: verify keyboard opposing inputs cancel to neutral
- Manual: verify mobile touch input still works correctly
- Verify: 2-player and 4-player lockstep mesh works with new 16-byte wire format
- Verify: streaming mode input relay works with new 12-byte format
- Verify: resend protocol works during input stalls
