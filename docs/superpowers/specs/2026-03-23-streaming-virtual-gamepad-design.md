# Streaming Virtual Gamepad — Design Spec

**Date:** 2026-03-23
**Status:** Approved
**Branch:** wasm-determinism

## Problem

In lockstep mode, every player boots EmulatorJS, which automatically provides a virtual gamepad overlay on mobile touch devices. In streaming mode, only the host runs EmulatorJS — guests receive a video stream and never boot the emulator. This means mobile streaming guests have no way to input controls.

## Solution

A standalone virtual gamepad overlay (`web/static/virtual-gamepad.js`) that renders N64 touch controls over the video stream for mobile streaming guests. It produces the same `_touchInputState` index/value format used by the lockstep engine, feeding directly into the streaming engine's existing `readLocalInput()` → DataChannel pipeline.

## Scope

- **Shown when:** Mobile/touch device + streaming mode + active player (not spectator, not host)
- **Hidden when:** A physical gamepad connects (mirrors EJS behavior)
- **Host excluded:** The host already gets EJS's built-in virtual gamepad

## Architecture

```
Touch events → virtual-gamepad.js → _touchInputState{} → readLocalInput() → bitmask
                                                              ↓
                                                     DataChannel.send()
                                                              ↓
                                                    Host applyInputForSlot()
```

No new network protocol, server changes, or EJS modifications required.

### New File

**`web/static/virtual-gamepad.js`** — Self-contained module, no dependencies.

Exports:
- `VirtualGamepad.init(container, stateObj)` — Creates the overlay DOM inside `container`, attaches touch listeners. Writes touch state directly into the provided `stateObj` (owned by the streaming engine).
- `VirtualGamepad.destroy()` — Removes overlay, detaches listeners, clears `stateObj`
- `VirtualGamepad.setVisible(bool)` — Show/hide (for physical gamepad connect/disconnect)

**State ownership:** The streaming engine owns the `_touchInputState` object and passes it to `VirtualGamepad.init()`. The virtual gamepad writes into it; `readLocalInput()` reads from it. This avoids coupling — the module doesn't export state, it writes to a provided target.

### Modified Files

**`web/static/netplay-streaming.js`**:
1. Add `_touchInputState` object (same format as lockstep)
2. Add touch input reading to `readLocalInput()` — analog stick deadzone logic (absolute: 3500, relative: 40%) and digital button/C-button bitmask. This is ~35 lines of new logic ported from lockstep's `readLocalInput()`. Note: the EJS menu-open guard from lockstep is **not needed** here since streaming guests don't run EJS.
3. Call `VirtualGamepad.init(container, _touchInputState)` in streaming `init()` when `config.isMobile` is true and the player is a guest (not host, not spectator)
4. Call `VirtualGamepad.destroy()` in `stop()` — this clears `_touchInputState` to prevent stale input on restart

**`web/static/play.js`**:
1. Pass `isMobile: _isMobile` in the config object passed to `NetplayStreaming.init()` (the existing `_isMobile` detection at line 40–42)
2. In the `GamepadManager.start()` `onUpdate` callback (where EJS's `virtualGamepad` visibility is already toggled), add a parallel call to `VirtualGamepad.setVisible()` when in streaming mode

**`web/play.html`**:
1. Add `<script src="static/virtual-gamepad.js"></script>` tag

## N64 Controller Layout

Full N64 layout, landscape orientation, overlaid on the video stream.

### Left Side
- **Analog stick** — Virtual joystick (finger drag from center). Primary control.
- **D-pad** — Below analog stick. Four directional buttons.

### Right Side
- **A button** — Large, primary action
- **B button** — Large, secondary action
- **C-button diamond** — Four small directional buttons (C-up/down/left/right)

### Center
- **Start button**

### Shoulders
- **L trigger** — Left edge
- **Z trigger** — Left edge, below L
- **R trigger** — Right edge

All elements are semi-transparent so the video stream remains visible underneath.

## Input Interface

Uses the exact same index mapping as EJS's `simulateInput()`:

| Index | Control | Value Range |
|-------|---------|-------------|
| 0 | B | 0 or 1 |
| 1 | Y (unused on N64) | 0 or 1 |
| 2 | Select (unused) | 0 or 1 |
| 3 | Start | 0 or 1 |
| 4 | D-pad Up | 0 or 1 |
| 5 | D-pad Down | 0 or 1 |
| 6 | D-pad Left | 0 or 1 |
| 7 | D-pad Right | 0 or 1 |
| 8 | A | 0 or 1 |
| 9 | L | 0 or 1 |
| 10 | R | 0 or 1 |
| 11 | Z (mapped to RetroArch L2) | 0 or 1 |
| 16 | Analog stick right | 0–32767 |
| 17 | Analog stick left | 0–32767 |
| 18 | Analog stick down | 0–32767 |
| 19 | Analog stick up | 0–32767 |
| 20 | C-right | 0 or 1 |
| 21 | C-left | 0 or 1 |
| 22 | C-down | 0 or 1 |
| 23 | C-up | 0 or 1 |

## Touch Handling

### Analog Stick
- `touchstart`: Record center point of the joystick zone
- `touchmove`: Calculate finger offset from center → magnitude and angle
- Map to indices 16–19 with values proportional to displacement (0–32767)
- `touchend`: Reset all stick indices to 0
- Uses `Touch.identifier` to track the correct finger across multi-touch

### Buttons
- `touchstart` on a button → set its index to 1
- `touchend` / `touchcancel` on a button → set its index to 0
- Multi-touch: track each finger via `Touch.identifier` so holding one button while pressing another works correctly

### Deadzone (applied in readLocalInput)
- **Absolute deadzone:** 3500 (~15% of 32767) — filters spurious displacement on initial touch
- **Relative deadzone:** 40% of major axis — suppresses near-cardinal diagonals, giving clean cardinal zones

## Styling

- CSS-only rendering (no images or sprites)
- Semi-transparent dark circles/rounded-rects with white text labels
- `position: fixed` overlay with high `z-index` (above video element)
- `pointer-events: none` on the container; `pointer-events: auto` on individual controls
- Controls sized for comfortable thumb reach on typical mobile screens
- No interference with the existing toolbar or debug overlay

## Physical Gamepad Behavior

**Integration point:** `web/static/play.js`, inside the existing `GamepadManager.start()` `onUpdate` callback. This callback already toggles `ejs.virtualGamepad.style.display` when gamepads connect/disconnect. The same callback will also call `VirtualGamepad.setVisible()` when in streaming mode.

When `GamepadManager` detects a physical gamepad connecting:
- Hide the virtual gamepad (`VirtualGamepad.setVisible(false)`)
- Clear `_touchInputState` to prevent stale touch values

When all physical gamepads disconnect on a touch device:
- Show the virtual gamepad again (`VirtualGamepad.setVisible(true)`)

This mirrors EJS's existing behavior for its built-in virtual gamepad.

## What's NOT In Scope

- Host virtual gamepad replacement (host keeps EJS's built-in one)
- Portrait orientation optimization (landscape is the expected play orientation)
- Haptic feedback (can be added later)
- Customizable button layout/sizing (can be added later)
- Lockstep mode changes (already has EJS's virtual gamepad)
