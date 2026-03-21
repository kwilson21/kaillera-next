# Gamepad Remapping Wizard & Frame Delay Selection — Design Spec

**Date:** 2026-03-21
**Base branch:** `mvp-p0-implementation`

## Context

The GamepadManager (shipped in this branch) provides profile-based gamepad detection and mapping. However, the built-in profiles assume standard gamepad button indices which don't match all controllers — the analog Y-axis is inverted and some buttons (like B) map incorrectly on real hardware. The profile format was designed to support custom mappings; this spec adds the UI to create them.

Separately, the lockstep engine hardcodes `DELAY_FRAMES = 2`. Players need to choose their own delay (1-9 frames) or use auto-detection based on peer-to-peer latency, with the room running at the ceiling value across all players.

## Deliverables

- A fast, inline remapping wizard in the lobby that captures the user's actual button/axis mappings for each N64 input
- Custom mappings saved to localStorage per gamepad ID, automatically loaded on reconnect
- The analog inversion problem is solved by capturing the real axis direction during the wizard — no guessing conventions
- A frame delay picker (1-9) with an Auto option that measures peer-to-peer RTT and picks the best value
- Room-wide delay negotiation: all players exchange delay values during the lockstep-ready handshake, room runs at the maximum

## What This Does NOT Deliver

- **Keyboard remapping** — keyboard uses DEFAULT_N64_KEYMAP, unchanged
- **Per-game profiles** — one mapping per gamepad ID, not per ROM
- **Delay adjustment mid-game** — set at game start, fixed for the session
- **Streaming mode delay knob** — input lag in streaming is inherent to the architecture (guest input → data channel → host → encode → video back), not adjustable via a delay setting
- **Analog sensitivity/deadzone config** — uses the profile's deadzone (0.3), not user-configurable
- **Server-side latency measurement** — ping/pong is peer-to-peer over WebRTC data channel only

---

## Feature 1: Remapping Wizard

### User Flow

1. User connects a gamepad. Lobby shows the detected controller name and profile in `#gamepad-status`.
2. A "Remap Controller" button appears next to the gamepad status.
3. User clicks it. An inline panel replaces the gamepad status area (no modal, no page navigation).
4. The wizard cycles through N64 inputs one at a time, showing a prompt like **"Press: A"** or **"Push stick UP"**.
5. User presses the corresponding gamepad button or moves an axis. The wizard captures the raw index/direction and immediately advances to the next input.
6. At any point:
   - **Skip** (spacebar or "Skip" button) — keeps existing mapping for that input, advances
   - **Cancel** (Escape or "Cancel" button) — exits wizard, discards all changes from this run
   - **Done** (click "Done") — saves whatever has been captured so far, exits
7. Completing all 18 steps auto-saves and exits.
8. The mapping is immediately active — no page refresh needed.

### Wizard Steps (18 total)

Buttons (10):

| Step | Prompt | Capture |
|------|--------|---------|
| 1 | "Press: A" | button index → EJS bit 8 |
| 2 | "Press: B" | button index → EJS bit 0 |
| 3 | "Press: Start" | button index → EJS bit 3 |
| 4 | "Press: Z" | button index → EJS bit 9 |
| 5 | "Press: L" | button index → EJS bit 10 |
| 6 | "Press: R" | button index → EJS bit 11 |
| 7 | "Press: D-Up" | button index → EJS bit 4 |
| 8 | "Press: D-Down" | button index → EJS bit 5 |
| 9 | "Press: D-Left" | button index → EJS bit 6 |
| 10 | "Press: D-Right" | button index → EJS bit 7 |

Analog stick (4):

| Step | Prompt | Capture |
|------|--------|---------|
| 11 | "Push stick UP" | axis index + direction → EJS bits 16 (up) |
| 12 | "Push stick DOWN" | axis index + direction → EJS bits 17 (down) |
| 13 | "Push stick LEFT" | axis index + direction → EJS bits 18 (left) |
| 14 | "Push stick RIGHT" | axis index + direction → EJS bits 19 (right) |

C-buttons (4):

| Step | Prompt | Capture |
|------|--------|---------|
| 15 | "Press: C-Up" | button or axis → EJS bit 12 |
| 16 | "Press: C-Down" | button or axis → EJS bit 13 |
| 17 | "Press: C-Left" | button or axis → EJS bit 14 |
| 18 | "Press: C-Right" | button or axis → EJS bit 15 |

### Input Capture Logic

**Button capture:** Poll `navigator.getGamepads()` at 60fps during the wizard. When any button transitions from not-pressed to pressed (that wasn't pressed when the step started), capture that button's index.

**Axis capture:** When any axis crosses the deadzone threshold (0.3) from neutral, capture that axis index and whether the value is positive or negative. This naturally records the correct Y-axis convention — if the user's controller reports Y+ when pushing up, we record that; if Y+ is down, we record that. The inversion problem disappears.

**C-button capture:** Accept either a button press OR an axis movement, since C-buttons can be mapped to the right stick or to face buttons depending on the controller.

**Debounce:** After each capture, ignore all input for 150ms to prevent double-registration from bouncy buttons or axis overshoot.

### Profile Format

The wizard produces a profile object with the same shape as built-in profiles:

```js
{
  name: 'Custom',
  buttons: { buttonIndex: ejsBitmask, ... },
  axes: {
    // Each direction captured individually, stored as axis pairs
    stickX: { index: axisIdx, bits: [rightBit, leftBit] },
    stickY: { index: axisIdx, bits: [downBit, upBit] },
  },
  axisButtons: {
    // Only populated if C-buttons were mapped to axes
    axisIdx: { pos: ejsBitmask, neg: ejsBitmask },
  },
  deadzone: 0.3,
}
```

The wizard captures each direction independently. When building the profile, it groups axis captures into pairs:
- Stick UP and DOWN must be on the same axis index (validated during capture)
- Stick LEFT and RIGHT must be on the same axis index
- If C-buttons are mapped to axes, they're grouped similarly

If stick UP is captured as axis 1 positive, and stick DOWN as axis 1 negative, then `stickY.bits` = `[upBit, downBit]` where the positive-direction bit comes first in the array (matching the readGamepad convention: `bits[0]` = positive direction, `bits[1]` = negative direction). The key insight: the user's physical "up" motion determines which axis direction maps to the "up" bit, regardless of whether the gamepad API reports that as positive or negative.

### Storage

```
Key:   "gamepad-profile:<gamepad.id>"
Value: JSON.stringify(profileObject)
```

One entry per unique gamepad ID string. The gamepad ID includes manufacturer and product info, so different controllers naturally get different keys.

### Profile Resolution (updated)

`GamepadManager.resolveProfile(id)` checks in order:
1. localStorage custom profile for this gamepad ID — if found, return it
2. Built-in profile registry (Raphnet, then Standard fallback)

### Lobby UI Changes

When a gamepad is detected, the `#gamepad-status` area shows:

```
Xbox Controller (Custom)  [Remap]  [Reset]
```

- **Remap** — starts the wizard
- **Reset** — clears the localStorage entry, reverts to built-in profile
- Profile name shows "Custom" when a saved mapping exists, otherwise the built-in profile name

During the wizard, the status area is replaced with the wizard panel:

```
[Remap: Press A]  (3/18)  [Skip] [Cancel]
```

Compact, single line. Step counter shows progress. The prompt text is the only thing that changes between steps.

---

## Feature 2: Frame Delay Selection

### UI

A number picker in the lobby's lockstep options section:

```
Frame Delay: [Auto ✓] [3 ▾]
```

- **Auto checkbox** — when checked, the picker shows the auto-detected value (grayed out / non-interactive). When unchecked, the picker becomes active for manual selection.
- **Number picker** — dropdown or stepper, range 1-9.
- **Default:** Auto checked. Before RTT measurement, shows "—". After measurement, shows the computed value.
- Only visible when mode is "lockstep" (hidden for streaming).

### Auto-Detection via RTT

**When:** After WebRTC data channels are established between peers, before the game starts.

**Mechanism:** Ping/pong over the existing data channel:
1. Send `{ type: 'delay-ping', ts: Date.now() }` over the data channel
2. Peer responds with `{ type: 'delay-pong', ts: originalTs }`
3. Sender computes `RTT = Date.now() - ts`
4. Run 3 pings, take the median RTT

**RTT → Delay mapping:**

| RTT (ms) | Delay (frames) |
|-----------|---------------|
| 0-16      | 1             |
| 17-33     | 2             |
| 34-50     | 3             |
| 51-66     | 4             |
| 67-83     | 5             |
| 84-100    | 6             |
| 101-133   | 7             |
| 134-166   | 8             |
| 167+      | 9             |

Formula: `Math.min(9, Math.max(1, Math.ceil(medianRTT / 16.67)))` — each frame at 60fps is ~16.67ms.

### Room-Wide Delay Negotiation

Each player has a delay value — either auto-detected or manually set. During the lockstep-ready handshake:

1. Each peer sends their delay value as part of the existing `lockstep-ready` signal (add a `delay` field)
2. Each peer computes `effectiveDelay = Math.max(ownDelay, ...peerDelays)` — the ceiling
3. `DELAY_FRAMES` is set to `effectiveDelay` before the first frame tick
4. The UI updates to show the effective delay (e.g., "Delay: 3 (room: 5)" if your delay is 3 but the room ceiling is 5)

**Edge case — late join:** A player joining mid-game inherits the room's current delay. They don't trigger a renegotiation (changing delay mid-game would cause frame misalignment).

### Data Channel Message Types (new)

| Message | Direction | Payload |
|---------|-----------|---------|
| `delay-ping` | peer→peer | `{ type: 'delay-ping', ts: number }` |
| `delay-pong` | peer→peer | `{ type: 'delay-pong', ts: number }` |

The `lockstep-ready` message gains an additional field:
```js
{ type: 'lockstep-ready', delay: number, ... }
```

### Changes to Existing Code

| File | Change |
|------|--------|
| `web/static/netplay-lockstep.js` | `DELAY_FRAMES` becomes `var` (not `const`). Set from negotiated value before first tick. Handle `delay-ping`/`delay-pong` on data channel. Add `delay` field to `lockstep-ready` message. |
| `web/static/play.js` | Add delay picker UI in lockstep options section. Wire Auto checkbox. Send delay preference to engine. |
| `web/play.html` | Add delay picker elements in the lockstep options div. |

---

## File Changes Summary

| File | Change | Feature |
|------|--------|---------|
| `web/static/gamepad-manager.js` | Add `resolveProfile` localStorage check, expose wizard helper methods (`startWizard`, `saveCustomProfile`, `clearCustomProfile`) | Remap |
| `web/static/play.js` | Add wizard UI logic, remap/reset buttons, delay picker UI, wire delay to engine | Both |
| `web/play.html` | Add remap button, wizard panel elements, delay picker elements | Both |
| `web/static/netplay-lockstep.js` | Make `DELAY_FRAMES` variable, handle ping/pong, negotiate delay in lockstep-ready | Delay |
