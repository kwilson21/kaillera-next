# Gamepad & Raphnet Adapter Support — Design Spec

**Date:** 2026-03-21
**Base commit:** `36c1021` (pre-C-input, JS-level input path)

## Context

The netplay input pipeline uses JS-level input: `readLocalInput()` builds a bitmask from keyboard and gamepad state, which gets applied via memory writes (lockstep) or `simulateInput()` calls (streaming). Both engines currently hardcode `navigator.getGamepads()[0]` with a raw 1:1 button-index mapping (bit i = gamepad button i pressed).

This spec adds:
- A profile-based gamepad mapping registry (extensible for future adapters and remapping UI)
- Raphnet N64-to-USB adapter detection and mapping (from documented specs, verified later with hardware)
- Continuous hot-plug scanning (plug/unplug at any time)
- Lobby UI showing detected controller and matched profile, with click-to-reassign for multi-gamepad
- Shared `gamepad-manager.js` used by both netplay engines and the lobby

## Deliverables

- A user can connect an Xbox or PS controller (or any standard gamepad) and it will be automatically detected and mapped to N64 controls
- They can plug in, unplug, or swap controllers at any time — including mid-game — and input continues seamlessly on the next frame with no pause or reconnection
- The lobby shows what controller is detected and which profile matched
- If multiple gamepads are connected, the user can click to reassign which one is active
- Raphnet N64-to-USB adapters are detected by vendor ID; correct button mapping will be applied once verified with hardware (falls back to Standard mapping until then)
- Both lockstep and streaming netplay engines share the same gamepad system
- The existing 4-player netplay, desync/resync behavior, late join, and keyboard input are all unchanged

## What this does NOT deliver

- **Desync or audio changes** — deterministic timing, state sync, resync, and audio bypass all work today and must not regress. This spec does not touch any of those systems. If desyncs or audio issues appear after this work, it is a bug we introduced.
- **Local multiplayer** — one player per browser tab. Multiple gamepads in one tab mapping to multiple player slots is future work.
- **User-configurable button remapping** — no UI for remapping buttons. This is a fast follow-up; the profile format is designed to support it, but no remapping screen ships with this work.
- **Raphnet-verified button mapping** — the raphnet profile is detected but uses the Standard mapping until we have hardware to verify the correct button indices.
- **C-level input pipeline** — input stays at the JS level. The C-level work (`kn_set_input` / `egcvip_get_input`) is parked on `2p-desync-investigation`.
- **Changes to WebRTC, signaling, or room management** — networking is untouched.

## Input Format

Both engines use the same bitmask format. `readLocalInput()` returns an integer where:
- **Bits 0-15:** button states (bit i = EJS button index i)
- **Bits 16-19:** analog stick as digital directions (up/down/left/right)

This is the EJS `simulateInput()` button-index format, not the N64 BUTTONS.Value format. The streaming engine converts via `applyInputForSlot()` → `simulateInput()`. The lockstep engine writes directly to WASM memory.

`GamepadManager.readGamepad()` returns this same format — a bitmask that both engines consume identically.

### EJS button index reference (from DEFAULT_N64_KEYMAP)

| EJS Index | N64 Button | Keyboard Key |
|---|---|---|
| 0 | B | X |
| 3 | Start | V |
| 4 | D-Up | Up arrow |
| 5 | D-Down | Down arrow |
| 6 | D-Left | Left arrow |
| 7 | D-Right | Right arrow |
| 8 | A | C |
| 9 | Z-trigger | Z |
| 10 | L-shoulder | T |
| 11 | R-shoulder | Y |
| 12 | C-Up | I |
| 13 | C-Down | K |
| 14 | C-Left | J |
| 15 | C-Right | L |
| 16 | Analog Up | W |
| 17 | Analog Down | S |
| 18 | Analog Left | A |
| 19 | Analog Right | D |

Bits 20-23 are unused but processed by the streaming engine's `applyInputForSlot` axis loop (bits 16-22 in pairs). Do not assign these bits for other purposes.

## Architecture

### Gamepad Profile Registry

`GAMEPAD_PROFILES` is an ordered array. First match wins during detection.

```js
{
  name: 'Standard',
  match: function(id) { return true; },  // fallback — matches anything
  // Maps gamepad button index → EJS bitmask bit(s)
  buttons: {
    0: (1 << 0),   // face bottom (A/Cross) → B
    2: (1 << 8),   // face left (X/Square) → A
    9: (1 << 3),   // start → Start
    12: (1 << 4),  // dpad up → D-Up
    13: (1 << 5),  // dpad down → D-Down
    14: (1 << 6),  // dpad left → D-Left
    15: (1 << 7),  // dpad right → D-Right
    4: (1 << 10),  // LB → L-shoulder
    5: (1 << 11),  // RB → R-shoulder
    6: (1 << 9),   // LT → Z-trigger
  },
  axes: {
    stickX: { index: 0, bits: [19, 18] },  // [positive=right, negative=left]
    stickY: { index: 1, bits: [17, 16] },  // [positive=down, negative=up] (gamepad Y+ is down)
  },
  // Right stick → C-buttons as digital buttons (not axis pairs)
  axisButtons: {
    2: { pos: (1 << 15), neg: (1 << 14) },  // RX: right=C-Right, left=C-Left
    3: { pos: (1 << 13), neg: (1 << 12) },  // RY: down=C-Down, up=C-Up (Y+ is down)
  },
  deadzone: 0.3
}
```

**Axis handling:** `axes` maps stick axes to bit pairs for analog directions (bits 16-19). `axisButtons` maps stick axes to digital button bits (bits 0-15) for C-buttons. Both use the deadzone threshold. This distinction matters because the streaming engine's `applyInputForSlot` processes bits 0-15 as digital buttons and bits 16+ as axis pairs.

**Shipped profiles:**

1. **Standard** — Xbox/PS/generic. Explicit button-to-EJS mapping. Default fallback.
2. **Raphnet N64** — VID `0964`. Uses the Standard mapping initially; exact indices TBD when hardware available. The `match()` function detects raphnet but the mapping is identical to Standard until verified, so behavior is correct either way.
3. Profiles ordered: Raphnet first, Standard last (catches everything).

### Continuous Scanning with Hot-Plug

The existing 1-second poll in `startGamepadPolling()` is replaced by `GamepadManager.start()`:

1. Each poll: call `navigator.getGamepads()`, compare against previous state
2. New gamepad detected: auto-assign to the user's player slot, resolve profile via registry
3. Gamepad disappeared: remove from assignments, update UI
4. Profile is cached per gamepad index, re-resolved on reconnect (user might plug in a different controller)

`gamepadconnected`/`gamepaddisconnected` events supplement as faster notifications, but the polling loop is the source of truth.

No persistent state — purely reactive to what `getGamepads()` returns.

### Gamepad-to-Slot Assignment

A `_assignments` map: `{ playerSlot: gamepadIndex }` (keyed by what `readGamepad(slot)` needs for O(1) lookup).

- Auto-assign: when a gamepad connects and no gamepad is assigned to the user's slot, assign it
- For single-gamepad-per-tab netplay: maps the first detected gamepad → user's player slot
- The user's slot is communicated via `start({ playerSlot: N })` or defaults to 0
- Future local multiplayer: extend to assign additional gamepads to other slots

### GamepadManager API

```js
window.GamepadManager = {
  start: function(opts),       // Begin polling. opts: { playerSlot, onUpdate: fn }
  stop: function(),            // Stop polling, clear interval
  readGamepad: function(slot), // Returns EJS bitmask for assigned gamepad, or 0
  getAssignments: function(),  // Returns { slot: { gamepadIndex, profileName, gamepadId } }
  reassignSlot: function(slot, gamepadIndex), // Manual reassignment
  getDetected: function(),     // Returns array of { index, id, profileName }
};
```

`readGamepad(slot)` does NOT check `document.hasFocus()` — callers remain responsible. Lockstep wraps the gamepad read in `if (document.hasFocus())`. Streaming has no focus guard on either gamepad or keyboard (current behavior preserved).

`gamepad-manager.js` must not depend on any engine-specific globals — it only sets `window.GamepadManager` and is available when either engine initializes.

### readLocalInput() Changes

Both engines replace their hardcoded gamepad blocks:

**Lockstep** (current lines 1406-1424):
```js
// Before: raw 1:1 gamepad read with inline mapping
// After:
if (document.hasFocus()) {
  var gpMask = GamepadManager.readGamepad(_playerSlot);
  mask |= gpMask;
}
```

**Streaming** (current lines 690-696):
```js
// Before: raw 1:1 gamepad read
// After:
var gpMask = GamepadManager.readGamepad(_playerSlot);
mask |= gpMask;
```

Keyboard input OR'd in as before — unchanged.

### Lobby UI

- **`#gamepad-status`:** Shows detected controller name and matched profile, e.g. "Xbox Controller (Standard)" or "Raphnet N64 v3". Updated each poll cycle via `onUpdate` callback.
- **`.gamepad` spans:** For the user's own slot, shows a controller indicator when a gamepad is assigned.
- **Click to reassign:** If multiple gamepads detected, clicking `.gamepad` on user's slot cycles through available gamepads via `GamepadManager.reassignSlot()`. No-op for single-gamepad case.

No modal, no settings panel.

### Script Load Order

In `play.html`, add after the Socket.IO script (line 97) and before the engine `document.write` block (line 100):

```html
<script src="/static/gamepad-manager.js"></script>
```

## Raphnet Profile Details

Raphnet N64-to-USB adapters:
- **Vendor ID:** `0x0964` (Raphnet Technologies)
- **Product IDs:** `0x0001` (1-player), `0x0002` (2-player)
- Browser `.id` typically contains "Raphnet" or VID/PID hex

Raphnet maps N64 buttons as direct HID buttons (not remapped to Xbox layout). The Raphnet profile initially uses the Standard mapping and will be updated with correct indices when hardware is available for testing.

## File Changes

| File | Change |
|---|---|
| `web/static/gamepad-manager.js` (new) | Profile registry, scanning/polling, assignment, `readGamepad(slot)`. Exposes `window.GamepadManager` |
| `web/play.html` | Add `<script src="/static/gamepad-manager.js">` before engine scripts |
| `web/static/play.js` | Replace `startGamepadPolling()` with `GamepadManager.start()` / `getDetected()`. Update lobby UI with profile info, click-to-reassign on `.gamepad` spans |
| `web/static/netplay-lockstep.js` | Replace hardcoded gamepad block in `readLocalInput()` with `GamepadManager.readGamepad(slot)` |
| `web/static/netplay-streaming.js` | Same change as lockstep |

## Future: User Remapping UI (fast follow-up)

The profile format supports this directly. A remapping UI would:
1. Show current profile's button mapping
2. "Press A" → user presses a gamepad button → capture its index
3. Save custom profile to localStorage
4. Custom profiles inserted at front of registry (highest priority)

No architectural changes needed — just a UI that produces profile objects.
