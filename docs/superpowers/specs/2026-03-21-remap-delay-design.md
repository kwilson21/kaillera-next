# Gamepad Remapping Wizard & Frame Delay Selection — Design Spec

**Date:** 2026-03-21
**Base branch:** `mvp-p0-implementation`

## Context

The GamepadManager (shipped in this branch) provides profile-based gamepad detection and mapping. However, the built-in profiles assume standard gamepad button indices which don't match all controllers — the analog Y-axis is inverted and some buttons (like B) map incorrectly on real hardware. The profile format was designed to support custom mappings; this spec adds the UI to create them.

Separately, the lockstep engine hardcodes `DELAY_FRAMES = 2`. Players need to choose their own delay (1-9 frames) or use auto-detection based on peer-to-peer latency, with the room running at the ceiling value across all players.

## Deliverables

- A fast, inline remapping wizard in the lobby that captures the user's actual button/axis mappings for each N64 input
- Each wizard step accepts gamepad OR keyboard input — one wizard handles both input sources
- Gamepad mappings saved to localStorage per gamepad ID, keyboard mapping saved as a single global entry
- The analog inversion problem is solved by capturing the real axis direction during the wizard — no guessing conventions
- A frame delay picker (1-9) with an Auto option that measures peer-to-peer RTT and picks the best value
- Room-wide delay negotiation: all players exchange delay values during the lockstep-ready handshake, room runs at the maximum

## What This Does NOT Deliver

- **Per-game profiles** — one mapping per gamepad ID (and one global keyboard mapping), not per ROM
- **Delay adjustment mid-game** — set at game start, fixed for the session
- **Streaming mode delay knob** — input lag in streaming is inherent to the architecture (guest input → data channel → host → encode → video back), not adjustable via a delay setting
- **Analog sensitivity/deadzone config** — uses the profile's deadzone (0.3), not user-configurable
- **Server-side latency measurement** — ping/pong is peer-to-peer over WebRTC data channel only

---

## Feature 1: Remapping Wizard

### User Flow

1. A "Remap Controls" button is always visible in the lobby (works with or without a gamepad connected).
2. User clicks it. An inline panel replaces the gamepad status area (no modal, no page navigation).
3. The wizard cycles through N64 inputs one at a time, showing a prompt like **"Press: A"** or **"Push stick UP"**.
4. User presses a gamepad button, moves an axis, OR presses a keyboard key. The wizard captures the input from whichever source was used and immediately advances to the next input.
5. At any point:
   - **Skip** (click "Skip" button only — no keyboard shortcut, since any key press is captured as a mapping) — keeps existing mapping for that input, advances
   - **Cancel** (Escape or click "Cancel" button) — exits wizard, discards all changes from this run. Escape is reserved and cannot be mapped.
6. Completing all 18 steps auto-saves and exits.
7. The mapping is immediately active — no page refresh needed.

**Mixed input:** The user can freely mix gamepad and keyboard inputs across steps. Press a gamepad button for "A", a keyboard key for "B", skip "Start" to keep its default — all in one wizard run. Gamepad captures are saved to the gamepad profile (per gamepad ID). Keyboard captures are saved to the keyboard mapping (global). Skipped inputs keep their current values from both maps.

**Gamepad disconnect during wizard:** If the gamepad disconnects mid-wizard, the wizard continues — the user can still map keyboard keys for the remaining steps. Only if the wizard was started with a gamepad detected and the gamepad disconnects does the wizard stop accepting gamepad input; keyboard capture continues normally.

### Wizard Steps (18 total)

Buttons (10):

| Step | Prompt | Capture | Target EJS bit |
|------|--------|---------|----------------|
| 1 | "Press: A" | button index | 8 |
| 2 | "Press: B" | button index | 0 |
| 3 | "Press: Start" | button index | 3 |
| 4 | "Press: Z" | button index | 9 |
| 5 | "Press: L" | button index | 10 |
| 6 | "Press: R" | button index | 11 |
| 7 | "Press: D-Up" | button index | 4 |
| 8 | "Press: D-Down" | button index | 5 |
| 9 | "Press: D-Left" | button index | 6 |
| 10 | "Press: D-Right" | button index | 7 |

Analog stick (4) — captures axis index + direction sign, assembled into `axes` object later:

| Step | Prompt | Capture | Maps to N64 direction |
|------|--------|---------|-----------------------|
| 11 | "Push stick UP" | axis index + direction sign | Analog Up (bit 16) |
| 12 | "Push stick DOWN" | axis index + direction sign | Analog Down (bit 17) |
| 13 | "Push stick LEFT" | axis index + direction sign | Analog Left (bit 18) |
| 14 | "Push stick RIGHT" | axis index + direction sign | Analog Right (bit 19) |

C-buttons (4) — accepts button press or axis movement:

| Step | Prompt | Capture | Target EJS bit |
|------|--------|---------|----|
| 15 | "Press: C-Up" | button index or axis+direction | 12 |
| 16 | "Press: C-Down" | button index or axis+direction | 13 |
| 17 | "Press: C-Left" | button index or axis+direction | 14 |
| 18 | "Press: C-Right" | button index or axis+direction | 15 |

### Input Capture Logic

**Button capture (gamepad):** Poll `navigator.getGamepads()` at 60fps during the wizard. When any button transitions from not-pressed to pressed (that wasn't pressed when the step started), capture that button's index. This goes into the gamepad profile's `buttons` map.

**Button capture (keyboard):** Listen for `keydown` events during the wizard. When a key is pressed (except Escape, which is reserved for Cancel), capture its `event.keyCode`. This goes into the keyboard mapping. The `keydown` listener calls `preventDefault()` to avoid triggering browser shortcuts.

**Axis capture (gamepad):** When any axis crosses the deadzone threshold (0.3) from neutral, capture that axis index and whether the value is positive or negative. This naturally records the correct Y-axis convention — if the user's controller reports Y+ when pushing up, we record that; if Y+ is down, we record that. The inversion problem disappears.

**Axis capture (keyboard):** Analog stick steps (11-14) also accept keyboard key presses. If the user presses a key during "Push stick UP", that key is captured as the keyboard binding for analog up (bit 16). This allows keyboard users to remap analog directions to different keys.

**C-button capture:** Accept a gamepad button press, a gamepad axis movement, OR a keyboard key press. C-buttons can be mapped to the right stick, face buttons, or keyboard keys depending on preference.

**First input wins:** Each step accepts the first valid input from any source. If both a gamepad button and a keyboard key are pressed simultaneously, the gamepad input takes priority (since it's polled at 60fps while keyboard is event-driven, the gamepad will typically register first).

**Debounce:** After each capture, ignore all input for 150ms to prevent double-registration from bouncy buttons or axis overshoot.

**Axis validation:** Stick UP and DOWN must be on the same axis index. Stick LEFT and RIGHT must be on the same axis index. If the user maps "Push stick DOWN" to a different axis than "Push stick UP", the wizard rejects the capture, flashes the prompt text, and re-shows the same step with a message: "Must use same stick as UP — try again." Same rule for LEFT/RIGHT. C-buttons have no axis-pairing constraint (each can be an independent button or axis).

### Profile Format and Axis Bits Convention

The wizard produces two outputs:

**Gamepad profile** (same shape as built-in profiles):

```js
{
  name: 'Custom',
  buttons: { buttonIndex: ejsBitmask, ... },
  axes: {
    stickX: { index: axisIdx, bits: [posDirBit, negDirBit] },
    stickY: { index: axisIdx, bits: [posDirBit, negDirBit] },
  },
  axisButtons: {
    // Only populated if C-buttons were mapped to axes
    axisIdx: { pos: ejsBitmask, neg: ejsBitmask },
  },
  deadzone: 0.3,
}
```

**Keyboard mapping** (same format as `DEFAULT_N64_KEYMAP` — numeric keyCode → EJS button index):

```js
{
  88: 0,    // X → B
  67: 8,    // C → A
  // ... all 18 entries
}
```

The wizard captures `event.keyCode` for keyboard bindings. Although `keyCode` is technically deprecated, both engines already use it throughout (`_heldKeys.add(e['keyCode'])`, `_p1KeyMap[kc]`), and all major browsers still support it with no removal timeline. Migrating to `event.code` would require changing key tracking in both engines — not worth the scope for this feature. If `keyCode` is ever removed, the migration is a separate task.

**Building the custom map:** The wizard starts with a copy of `DEFAULT_N64_KEYMAP`. Each keyboard capture overwrites the entry for that key's new function. If the user maps W (keyCode 87) to "A button" (bit 8) in step 1, the entry changes from `87: 16` (analog up) to `87: 8` (A button). When the user reaches step 11 ("Push stick UP"), they can press a different key to reassign analog up — or skip to leave it unmapped on keyboard (gamepad analog still works). This naturally resolves key conflicts: each key maps to exactly one function, last write wins within the wizard run.

**The `bits` array convention:** `bits[0]` is always the EJS bitmask for whichever N64 direction was physically produced when the axis reported a **positive** value. `bits[1]` is the bitmask for the **negative** direction. This matches the `readGamepad()` implementation: `if (val > dz) mask |= (1 << bits[0])` and `if (val < -dz) mask |= (1 << bits[1])`.

**Example — standard controller** (Y+ = down, which is the common convention):
- User pushes stick DOWN → axis reports positive value → captured as positive direction → maps to Analog Down (bit 17)
- User pushes stick UP → axis reports negative value → captured as negative direction → maps to Analog Up (bit 16)
- Result: `stickY: { index: 1, bits: [17, 16] }` — `bits[0]` = 17 (down, positive), `bits[1]` = 16 (up, negative)

**Example — inverted controller** (Y+ = up, non-standard):
- User pushes stick UP → axis reports positive value → captured as positive direction → maps to Analog Up (bit 16)
- User pushes stick DOWN → axis reports negative value → captured as negative direction → maps to Analog Down (bit 17)
- Result: `stickY: { index: 1, bits: [16, 17] }` — `bits[0]` = 16 (up, positive), `bits[1]` = 17 (down, negative)

Both produce correct behavior because the wizard records what the hardware actually does, not what we assume it does.

### Storage

**Gamepad profiles** — one entry per unique gamepad ID:
```
Key:   "gamepad-profile:<gamepad.id>"
Value: JSON.stringify(gamepadProfileObject)
```

**Keyboard mapping** — one global entry:
```
Key:   "keyboard-mapping"
Value: JSON.stringify(keyMapObject)   // complete 18-key map, same shape as DEFAULT_N64_KEYMAP
```

The keyboard mapping is a complete replacement for `DEFAULT_N64_KEYMAP` — not a sparse overlay. It contains all 18 entries (captured + defaults for skipped steps). Both engines load it at startup and use it as `_p1KeyMap`. If not set in localStorage, `DEFAULT_N64_KEYMAP` is used as the fallback.

### Profile Resolution (updated)

**Gamepad:** `GamepadManager.resolveProfile(id)` checks in order:
1. localStorage custom profile for this gamepad ID — if found, return it
2. Built-in profile registry (Raphnet, then Standard fallback)

**Keyboard:** Both engines check localStorage for `"keyboard-mapping"` in `setupKeyTracking()`. If found, use it as `_p1KeyMap` instead of `DEFAULT_N64_KEYMAP`. Otherwise, fall back to `DEFAULT_N64_KEYMAP` (or EJS controls if available, as currently implemented).

**Known limitation:** The Reset button clears both the gamepad profile and the keyboard mapping simultaneously. Users who want to reset only one must re-run the wizard. Separate reset controls are future work.

### Lobby UI Changes

The `#gamepad-status` area shows controller info (if connected) and remap controls:

```
Xbox Controller (Custom)  [Remap Controls]  [Reset]
```

If no gamepad is connected:
```
No controller detected  [Remap Controls]  [Reset]
```

- **Remap Controls** — starts the wizard (works with or without a gamepad)
- **Reset** — clears both the gamepad localStorage entry (for the connected gamepad) and the keyboard mapping, reverts to built-in defaults
- Profile name shows "Custom" when a saved gamepad mapping exists, otherwise the built-in profile name

During the wizard, the status area is replaced with the wizard panel:

```
[Press A (gamepad or key)]  (3/18)  [Skip] [Cancel]
```

Compact, single line. Step counter shows progress. The prompt text is the only thing that changes between steps. Skipping through all remaining steps saves the partial mapping — uncaptured inputs keep their values from the current active profile (built-in or previously saved custom for gamepad, DEFAULT_N64_KEYMAP or saved custom for keyboard).

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

**When:** After WebRTC data channels are established between peers. The host initiates 3 delay-pings immediately after the data channel opens. The measurement must complete before `lockstep-ready` is sent — if Auto is selected, the `lockstep-ready` message is deferred until all 3 pings have returned and the median is computed.

**Mechanism:** Ping/pong over the existing data channel:
1. Send `{ type: 'delay-ping', ts: performance.now() }` over the data channel
2. Peer responds with `{ type: 'delay-pong', ts: originalTs }`
3. Sender computes `RTT = performance.now() - ts` (same clock origin, sub-ms resolution)
4. Run 3 pings sequentially (wait for pong before sending next), take the median RTT

Uses `performance.now()` instead of `Date.now()` because `Date.now()` has only millisecond resolution and may be rounded further due to Spectre mitigations. Since the pong echoes back the sender's original timestamp, the subtraction uses the same time origin.

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

### Sequencing

The RTT measurement fits into the existing game-start flow:

```
1. Data channels open
2. Host initiates 3 delay-pings (sequential, ~50-200ms total)
3. Both peers send 'emu-ready' when emulator is loaded
4. When all peers are emu-ready AND RTT measurement is complete:
   - Host captures and sends save state
   - Both peers send 'lockstep-ready' (now JSON, includes delay)
5. Both peers compute effectiveDelay = max of all delay values
6. DELAY_FRAMES set to effectiveDelay, lockstep begins
```

Steps 2 and 3 run in parallel — the RTT pings happen while the emulator boots. In practice, the emulator boot (several seconds) is much slower than the ping measurement (~50-200ms), so the pings will complete long before `emu-ready` fires.

### Room-Wide Delay Negotiation

Each player has a delay value — either auto-detected or manually set.

**Protocol change:** The `lockstep-ready` message changes from a raw string (`dc.send('lockstep-ready')`) to a JSON message. This is a **protocol format change**. The existing data channel `onmessage` handler already has a JSON parse path (checks `e.data.charAt(0) === '{'`), so the `lockstep-ready` detection moves from the string equality checks into the JSON message handler. The old `if (e.data === 'lockstep-ready')` string check must be **removed** (not just supplemented) to avoid dead code. Backward compatibility is not required — this is a pre-release project and both peers will always be on the same version (served from the same server).

New format:
```js
{ type: 'lockstep-ready', delay: number }
```

Negotiation:
1. Each peer sends their delay value in the `lockstep-ready` message
2. Each peer computes `effectiveDelay = Math.max(ownDelay, ...peerDelays)` — the ceiling
3. `DELAY_FRAMES` is set to `effectiveDelay` before the first frame tick
4. The UI updates to show the effective delay (e.g., "Delay: 3 (room: 5)" if your delay is 3 but the room ceiling is 5)

**Edge case — late join:** A player joining mid-game inherits the room's current delay via the existing `late-join-state` message. An `effectiveDelay` field is added to the `late-join-state` payload. The joiner sets `DELAY_FRAMES` to this value, ignoring their own auto-detected or manual preference. They don't trigger a renegotiation (changing delay mid-game would cause frame misalignment).

### Data Channel Message Types (new)

| Message | Direction | Payload |
|---------|-----------|---------|
| `delay-ping` | peer→peer | `{ type: 'delay-ping', ts: number }` |
| `delay-pong` | peer→peer | `{ type: 'delay-pong', ts: number }` |

Existing messages modified:

| Message | Old format | New format |
|---------|-----------|------------|
| `lockstep-ready` | Raw string `'lockstep-ready'` | `{ type: 'lockstep-ready', delay: number }` |
| `late-join-state` | Existing JSON payload | Add `effectiveDelay: number` field |

### Changes to Existing Code

| File | Change |
|------|--------|
| `web/static/netplay-lockstep.js` | `DELAY_FRAMES` becomes `var` (not `const`). Set from negotiated value before first tick. Handle `delay-ping`/`delay-pong` on data channel. Migrate `lockstep-ready` from raw string to JSON format (both send and receive sides). Add `delay` field to `lockstep-ready` message. Add `effectiveDelay` to `late-join-state`. |
| `web/static/play.js` | Add delay picker UI in lockstep options section. Wire Auto checkbox. Send delay preference to engine. |
| `web/play.html` | Add delay picker elements in the lockstep options div. |

---

## File Changes Summary

| File | Change | Feature |
|------|--------|---------|
| `web/static/gamepad-manager.js` | Add `resolveProfile` localStorage check, expose wizard helper methods (`startWizard`, `saveCustomProfile`, `clearCustomProfile`) | Remap |
| `web/static/play.js` | Add wizard UI logic (gamepad + keyboard capture), remap/reset buttons, delay picker UI, wire delay to engine | Both |
| `web/play.html` | Add remap button, wizard panel elements, delay picker elements | Both |
| `web/static/netplay-lockstep.js` | Load custom keyboard mapping from localStorage in `setupKeyTracking()` (fallback to DEFAULT_N64_KEYMAP). Make `DELAY_FRAMES` variable, handle ping/pong, remove old `lockstep-ready` string check and migrate to JSON, negotiate delay, add effectiveDelay to late-join-state | Both |
| `web/static/netplay-streaming.js` | Load custom keyboard mapping from localStorage in `setupKeyTracking()` (fallback to DEFAULT_N64_KEYMAP) | Remap |
