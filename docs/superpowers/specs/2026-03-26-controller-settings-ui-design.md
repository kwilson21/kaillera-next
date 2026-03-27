# Controller Settings UI (Phase 2)

## Problem

Phase 1 shipped true analog input with localStorage-backed configuration (deadzone, range, sensitivity, per-game profiles). Power users can tweak values via devtools, but there's no UI. Button remapping exists as a separate sequential wizard but lacks a grid view for quick individual rebinds. Controller configuration is split across two concerns with no unified interface.

## Solution

A single Controller Settings panel accessible from a new toolbar gear button. Consolidates button mapping (gamepad + keyboard), analog stick tuning, and per-game profiles into one overlay. The existing Remap toolbar button stays as a shortcut into the Quick Setup wizard.

## Panel Layout (Option B — Mapping First)

Top-to-bottom flow optimized for the most common task first:

```
┌─────────────────────────────────────┐
│ Controller Settings     [Global ▾] ×│
├─────────────────────────────────────┤
│ BUTTON MAPPING        [Quick Setup▸]│
│                                     │
│  A     [Button 1] [Space]           │
│  B     [Button 0] [X]              │
│  Z     [Button 6] [Z]              │
│  Start [Button 9] [Enter]          │
│  L     [Button 4] [Q]              │
│  R     [Button 5] [E]              │
│  ── D-Pad ──                        │
│  Up    [D-Pad ↑]  [↑]              │
│  Down  [D-Pad ↓]  [↓]              │
│  Left  [D-Pad ←]  [←]              │
│  Right [D-Pad →]  [→]              │
│  ── Analog Stick (keyboard only) ── │
│  Up    [  Analog  ]  [W]           │
│  Down  [  Analog  ]  [S]           │
│  Left  [  Analog  ]  [A]           │
│  Right [  Analog  ]  [D]           │
│  ── C-Buttons ──                    │
│  C-Up    [R-Stick ↑] [I]           │
│  C-Down  [R-Stick ↓] [K]           │
│  C-Left  [R-Stick ←] [J]           │
│  C-Right [R-Stick →] [L]           │
│─────────────────────────────────────│
│ LIVE STICK PREVIEW                  │
│                                     │
│    ╭────────╮       ╭─────╮         │
│    │  ·  ●  │       │  ·  │         │
│    │ (dz)   │       │(dz) │         │
│    ╰────────╯       ╰─────╯         │
│  Left Stick        C-Stick          │
│  X: 42  Y: -31    X: 0  Y: 0       │
│─────────────────────────────────────│
│ ANALOG TUNING                       │
│  Range          ████████░░░░  66%   │
│  Sensitivity    █████░░░░░░░  1.0×  │
│─────────────────────────────────────│
│ DEADZONE                            │
│  ┌ Left Stick ─────────────────┐    │
│  │ X  ██░░░░░░░░░░░░░░  0.15  │    │
│  │ Y  ██░░░░░░░░░░░░░░  0.15  │    │
│  └─────────────────────────────┘    │
│  ┌ C-Stick ────────────────────┐    │
│  │ X  ██░░░░░░░░░░░░░░  0.15  │    │
│  │ Y  ██░░░░░░░░░░░░░░  0.15  │    │
│  └─────────────────────────────┘    │
│─────────────────────────────────────│
│ ☐ Save for this game only    Reset  │
└─────────────────────────────────────┘
```

## Components

### 1. Toolbar Integration

New gear button added to the play.html toolbar, after the existing Remap button.

- **Gear button** opens/closes the settings panel (toggle behavior)
- **Remap button stays** — clicking it opens the settings panel with the Quick Setup wizard auto-started
- Panel renders as an absolutely-positioned overlay anchored to the toolbar area
- Panel does NOT pause the game — it overlays on top so users can test changes in real time
- Close via: X button, Escape key, or clicking outside the panel

### 2. Button Mapping Section

Two-column grid showing all N64 buttons. Each row has:
- N64 button label (A, B, Z, Start, L, R, D-pad directions, C-button directions)
- Gamepad binding (click to rebind)
- Keyboard binding (click to rebind)

**Click-to-rebind flow:**
1. User clicks a binding cell
2. Cell highlights with "Press a button..." / "Press a key..." prompt
3. Next gamepad button press or keypress captures the new binding
4. Binding saves to the gamepad profile (localStorage) or keyboard map
5. Escape cancels without changing

**Quick Setup button:**
Launches the existing sequential remap wizard flow from inside the panel. Walks through each N64 button one by one, prompting the user to press the corresponding gamepad button. Same UX as the current Remap toolbar flow, just triggered from within the settings panel.

**Grouping:** Face buttons (A, B, Z, Start, L, R), D-Pad (Up/Down/Left/Right), Analog Stick (Up/Down/Left/Right — keyboard only, gamepad column shows "Analog"), C-Buttons (Up/Down/Left/Right). Groups separated by labeled dividers. C-button bindings shown in yellow/accent color to indicate they're axis-mapped from the right stick. Analog stick rows have a disabled gamepad column since stick input comes from hardware.

**Keyboard binding read/write path:**
- Read current map: `JSON.parse(localStorage.getItem('keyboard-mapping')) || KNShared.DEFAULT_N64_KEYMAP`
- The map format is `{ keyCode: bitIndex }`. For display, the panel inverts this to `{ bitIndex: keyCode }` and converts keyCodes to human-readable names using the `key` property captured during rebind, or a static lookup table for pre-existing bindings (e.g. `32 → "Space"`, `13 → "Enter"`).
- Write: update the map object, then `localStorage.setItem('keyboard-mapping', JSON.stringify(map))`

**Conflict resolution:** When a key/button is bound to a new N64 action, any previous binding using that same key/button is automatically cleared (swap behavior). `KNState.remapActive` is set to `true` when a rebind cell is listening and `false` when the capture completes, is cancelled (Escape), or the panel closes.

### 3. Live Stick Visualization

SVG-based real-time display of analog stick positions. Reads from the Gamepad API on each animation frame.

**Left Stick (larger, ~120px diameter):**
- Outer circle: full hardware range
- Dashed circle: current range setting (e.g. 66% = ±83)
- Red-filled circle: deadzone boundary (updates when deadzone slider moves)
- Crosshair lines (subtle)
- Blue dot: current stick position
- Dot trail: last 2-3 positions at decreasing opacity (shows movement direction)
- Numeric readout below: `X: 42  Y: -31` (N64-quantized values)

**C-Stick (smaller, ~80px diameter):**
- Same rings and crosshair
- Gray dot (neutral color since C-buttons are digital)
- Numeric readout below

Both visualizations update at requestAnimationFrame rate when the panel is open. Polling stops when panel is closed to avoid unnecessary CPU usage. Must use `APISandbox.nativeGetGamepads()` (not `navigator.getGamepads()`) to read raw hardware values, since lockstep overrides the global. When no gamepad is connected, stick visualizations show a static neutral position with a "No gamepad detected" label. Keyboard bindings remain fully functional.

### 4. Analog Tuning Section

**Range slider (blue accent):**
- Controls max analog output magnitude
- Range: 0–100%, default 66%
- Maps to `kn-analog-range` localStorage key
- Dashed ring in stick viz updates in real time
- Hint text: "Max output magnitude (66% = ±83 N64 units)"

**Sensitivity slider (purple accent):**
- Controls the response curve exponent
- Range: 0.5×–2.0×, default 1.0× (linear)
- < 1.0 = gentle (small movements produce less output)
- \> 1.0 = aggressive (small movements produce more output)
- Maps to `kn-analog-sensitivity` localStorage key
- Labels: "Gentle" / "Linear" / "Aggressive"
- Formula: `output = sign(scaled) × |scaled|^(1/sensitivity) × N64_MAX`

**Implementation note:** Sensitivity requires adding a `_getSensitivity()` getter (using the existing `_getSetting` pattern from Phase 1) and a one-line change to `_analogScale` in gamepad-manager.js — apply `Math.pow(Math.abs(scaled), 1/sensitivity)` before the final multiply, restoring sign afterward. The `_getSetting` infrastructure exists from Phase 1; the `kn-analog-sensitivity` key is new. Note: sensitivity applies to left stick only (C-buttons are digital via `_digitalSnap`).

### 5. Deadzone Section

Per-axis deadzone sliders grouped by stick (Left Stick / C-Stick). Red accent color to visually distinguish from the blue/purple analog tuning sliders.

**Left Stick:** X and Y axis sliders, range 0.0–0.5, default 0.15
**C-Stick:** X and Y axis sliders, range 0.0–0.5, default 0.15

Maps to existing `kn-deadzone-lx`, `kn-deadzone-ly`, `kn-deadzone-cx`, `kn-deadzone-cy` localStorage keys. Red deadzone ring in the stick viz updates in real time as sliders move.

### 6. Profile Management

**Profile dropdown** in the panel header:
- "Global" — settings apply to all games (default)
- "This Game" — appears when a ROM is loaded and `KNState.romHash` is set

**"Save for this game only" checkbox** in the footer:
- When checked, all current settings are saved with the ROM hash key prefix (`kn-gamepad:${romHash}:${key}`)
- When unchecked, settings save to global keys
- Reads from per-game keys first, falls back to global (existing Phase 1 behavior)

**Reset defaults** link in the footer:
- Clears all gamepad settings for the current scope (global or per-game)
- Confirmation prompt before clearing

### 7. Panel Behavior

- **Positioning:** Absolutely positioned overlay, anchored near the toolbar. Right-aligned to avoid covering the game center. ~400px wide, scrollable vertically if content exceeds viewport.
- **No game pause:** Panel overlays on top of the running game. This is intentional — users should be able to move the stick and see the viz update, or change bindings and immediately test them.
- **Close triggers:** X button in header, Escape key, clicking outside the panel.
- **Input suppression:** While a rebind prompt is active ("Press a button..."), normal game input is suppressed (same mechanism as `KNState.remapActive`).
- **Mobile:** Panel should be usable on mobile but is not a primary concern. Full-width on small screens, same scroll behavior. Touch sliders work via standard HTML range inputs.

## What Changes

| File | Change |
|---|---|
| `web/static/controller-settings.js` | **New file.** IIFE that builds the panel DOM, handles slider interactions, stick viz rendering, rebind flow, profile management. |
| `web/static/gamepad-manager.js` | Add sensitivity exponent to `_analogScale`. Export current profile/bindings for the settings panel to read. |
| `web/static/shared.js` | Minor: export keyboard map for settings panel to display current bindings. |
| `web/play.html` | Add gear button to toolbar. Add `<script>` tag for controller-settings.js. |
| `web/static/play.js` | Wire gear button click to panel open/close. Wire Remap button to open panel + auto-start Quick Setup. |
| `web/static/play.css` | Panel overlay styles, slider styles, viz container styles. |

## localStorage Key Reference

| Key | Type | Default | Section |
|---|---|---|---|
| `kn-analog-range` | int (0–100) | 66 | Analog Tuning |
| `kn-analog-sensitivity` | float (0.5–2.0) | 1.0 | Analog Tuning |
| `kn-deadzone-lx` | float (0.0–0.5) | 0.15 | Deadzone |
| `kn-deadzone-ly` | float (0.0–0.5) | 0.15 | Deadzone |
| `kn-deadzone-cx` | float (0.0–0.5) | 0.15 | Deadzone |
| `kn-deadzone-cy` | float (0.0–0.5) | 0.15 | Deadzone |
| `kn-gamepad:${hash}:${key}` | varies | — | Per-game overrides |
| `keyboard-mapping` | JSON `{ keyCode: bitIndex }` | `DEFAULT_N64_KEYMAP` | Button Mapping |
| `gamepad-profile:${gamepadId}` | JSON profile object | built-in profile | Button Mapping |

## New GamepadManager API Surface

The settings panel needs read/write access to gamepad state. New exports on `window.GamepadManager`:

- `getCurrentSettings()` — returns `{ range, sensitivity, deadzones: { lx, ly, cx, cy } }`
- `getActiveProfile(slot)` — returns the resolved profile for the assigned gamepad
- `setSetting(key, value)` — writes to localStorage (respects per-game scope)

## What Doesn't Change

- Lockstep/streaming netplay engines (no wire format changes)
- WebRTC signaling
- ROM sharing
- Server code
- Existing localStorage key format (Phase 1 compatibility preserved)

## Deferred to Phase 3

- Rumble/haptic feedback (requires WASM PIF command investigation)
- Profile import/export
- Tabbed panel layout (revisit when more settings are added)

## Testing Strategy

- Manual: open settings panel during a lockstep game, adjust deadzone slider, verify stick viz ring updates and gameplay reflects the change
- Manual: click a binding, press a new button, verify the mapping updates and works in-game immediately
- Manual: Quick Setup wizard flow from inside the panel
- Manual: set "Save for this game only", close panel, reopen — verify per-game values load
- Manual: test on mobile (Chrome DevTools device emulation) — panel should be usable
- Manual: verify Escape closes panel, clicking outside closes panel
- Manual: verify sensitivity slider at 0.5× (gentle) and 2.0× (aggressive) produce noticeably different response curves
