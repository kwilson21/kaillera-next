# Gamepad & Raphnet Adapter Support — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add profile-based gamepad support with hot-plug detection and raphnet adapter recognition to the existing netplay system.

**Architecture:** A single shared `gamepad-manager.js` module exposes `window.GamepadManager` with a profile registry that maps physical gamepad buttons to EJS bitmask format. Both netplay engines (`netplay-lockstep.js`, `netplay-streaming.js`) and the lobby (`play.js`) consume this module. The polling-based scanner detects hot-plug events and auto-assigns gamepads to player slots.

**Tech Stack:** Vanilla JS (no build tools), Browser Gamepad API, existing EmulatorJS/Socket.IO stack.

**Spec:** `docs/superpowers/specs/2026-03-21-gamepad-raphnet-design.md`

---

## File Structure

| File | Role | Action |
|---|---|---|
| `web/static/gamepad-manager.js` | Profile registry, polling scanner, slot assignment, `readGamepad(slot)` | Create |
| `web/play.html` | Load `gamepad-manager.js` before engine scripts | Modify (line 98) |
| `web/static/play.js` | Replace `startGamepadPolling()` with `GamepadManager`, update lobby UI | Modify (lines 583-601, 640) |
| `web/static/netplay-lockstep.js` | Replace hardcoded gamepad block in `readLocalInput()` | Modify (lines 1406-1424) |
| `web/static/netplay-streaming.js` | Replace entire `readLocalInput()` function | Modify (lines 689-704) |

---

## Chunk 1: GamepadManager Core

### Task 1: Create `gamepad-manager.js` with profile registry and `readGamepad()`

**Files:**
- Create: `web/static/gamepad-manager.js`

- [ ] **Step 1: Write the complete GamepadManager module**

Create `web/static/gamepad-manager.js`:

```js
/**
 * gamepad-manager.js — Profile-based gamepad detection, mapping, and slot assignment.
 *
 * Exposes window.GamepadManager. No dependencies on engine-specific globals.
 * Both netplay engines and the lobby consume this module.
 *
 * Profile format:
 *   name:        display name
 *   match(id):   returns true if this profile handles gamepad.id
 *   buttons:     { gamepadButtonIndex: ejsBitmask }
 *   axes:        { name: { index, bits: [posBit, negBit] } }  -- analog directions
 *   axisButtons: { axisIndex: { pos: ejsBitmask, neg: ejsBitmask } }  -- axis-to-digital
 *   deadzone:    threshold for axis activation
 */
(function () {
  'use strict';

  // ── Profile Registry ─────────────────────────────────────────────────
  // Ordered array. First match wins. Raphnet before Standard (fallback).

  var PROFILES = [
    {
      name: 'Raphnet N64',
      match: function (id) {
        return id.indexOf('Raphnet') !== -1 || id.indexOf('0964') !== -1;
      },
      // Uses Standard mapping until verified with hardware
      buttons: {
        0: (1 << 0),   // B
        2: (1 << 8),   // A
        9: (1 << 3),   // Start
        12: (1 << 4),  // D-Up
        13: (1 << 5),  // D-Down
        14: (1 << 6),  // D-Left
        15: (1 << 7),  // D-Right
        4: (1 << 10),  // L
        5: (1 << 11),  // R
        6: (1 << 9),   // Z
      },
      axes: {
        stickX: { index: 0, bits: [19, 18] },
        stickY: { index: 1, bits: [17, 16] },
      },
      axisButtons: {
        2: { pos: (1 << 15), neg: (1 << 14) },
        3: { pos: (1 << 13), neg: (1 << 12) },
      },
      deadzone: 0.3,
    },
    {
      name: 'Standard',
      match: function () { return true; },
      buttons: {
        0: (1 << 0),   // face bottom (A/Cross) → B
        2: (1 << 8),   // face left (X/Square) → A
        9: (1 << 3),   // start → Start
        12: (1 << 4),  // dpad up → D-Up
        13: (1 << 5),  // dpad down → D-Down
        14: (1 << 6),  // dpad left → D-Left
        15: (1 << 7),  // dpad right → D-Right
        4: (1 << 10),  // LB → L
        5: (1 << 11),  // RB → R
        6: (1 << 9),   // LT → Z
      },
      axes: {
        stickX: { index: 0, bits: [19, 18] },
        stickY: { index: 1, bits: [17, 16] },
      },
      axisButtons: {
        2: { pos: (1 << 15), neg: (1 << 14) },
        3: { pos: (1 << 13), neg: (1 << 12) },
      },
      deadzone: 0.3,
    },
  ];

  // ── State ────────────────────────────────────────────────────────────

  var _pollInterval = null;
  var _playerSlot = 0;
  var _onUpdate = null;

  // { playerSlot: gamepadIndex }
  var _assignments = {};

  // { gamepadIndex: { id, profileName, profile } }
  var _detected = {};

  // Previous gamepad IDs for change detection
  var _prevIds = {};

  // ── Profile Resolution ───────────────────────────────────────────────

  function resolveProfile(id) {
    for (var i = 0; i < PROFILES.length; i++) {
      if (PROFILES[i].match(id)) return PROFILES[i];
    }
    return PROFILES[PROFILES.length - 1]; // Standard fallback
  }

  // ── Polling / Scanning ───────────────────────────────────────────────

  function poll() {
    var gamepads = navigator.getGamepads();
    var changed = false;
    var currentIds = {};

    // Scan all gamepad slots
    for (var i = 0; i < gamepads.length; i++) {
      var gp = gamepads[i];
      if (!gp) {
        // Gamepad gone — remove if was detected
        if (_detected[i]) {
          // Remove assignment if this gamepad was assigned
          for (var slot in _assignments) {
            if (_assignments[slot] === i) {
              delete _assignments[slot];
            }
          }
          delete _detected[i];
          changed = true;
        }
        continue;
      }

      currentIds[i] = gp.id;

      // New or changed gamepad
      if (!_detected[i] || _prevIds[i] !== gp.id) {
        var profile = resolveProfile(gp.id);
        _detected[i] = { id: gp.id, profileName: profile.name, profile: profile };
        changed = true;

        // Auto-assign to player slot if unassigned
        if (_assignments[_playerSlot] === undefined) {
          _assignments[_playerSlot] = i;
        }
      }
    }

    _prevIds = currentIds;

    if (changed && _onUpdate) {
      _onUpdate();
    }
  }

  // ── Read Gamepad ─────────────────────────────────────────────────────

  function readGamepad(slot) {
    var gpIndex = _assignments[slot];
    if (gpIndex === undefined) return 0;

    var gp = navigator.getGamepads()[gpIndex];
    if (!gp) return 0;

    var entry = _detected[gpIndex];
    if (!entry) return 0;

    var profile = entry.profile;
    var mask = 0;

    // Map buttons
    var btnMap = profile.buttons;
    for (var btnIdx in btnMap) {
      var idx = parseInt(btnIdx, 10);
      if (idx < gp.buttons.length && gp.buttons[idx].pressed) {
        mask |= btnMap[btnIdx];
      }
    }

    // Map axes → analog direction bits (bits 16-19)
    var axes = profile.axes;
    var dz = profile.deadzone;
    for (var axisName in axes) {
      var axisCfg = axes[axisName];
      if (axisCfg.index < gp.axes.length) {
        var val = gp.axes[axisCfg.index];
        if (val > dz)  mask |= (1 << axisCfg.bits[0]);  // positive
        if (val < -dz) mask |= (1 << axisCfg.bits[1]);  // negative
      }
    }

    // Map axes → digital button bits (C-buttons from right stick)
    var axBtn = profile.axisButtons;
    if (axBtn) {
      for (var axIdx in axBtn) {
        var ai = parseInt(axIdx, 10);
        if (ai < gp.axes.length) {
          var v = gp.axes[ai];
          if (v > dz)  mask |= axBtn[axIdx].pos;
          if (v < -dz) mask |= axBtn[axIdx].neg;
        }
      }
    }

    return mask;
  }

  // ── Public API ───────────────────────────────────────────────────────

  window.GamepadManager = {
    start: function (opts) {
      opts = opts || {};
      _playerSlot = opts.playerSlot || 0;
      _onUpdate = opts.onUpdate || null;

      // Immediate first poll
      poll();

      // Also listen for browser events for faster response
      window.addEventListener('gamepadconnected', poll);
      window.addEventListener('gamepaddisconnected', poll);

      // Polling loop as source of truth (1 second)
      if (_pollInterval) clearInterval(_pollInterval);
      _pollInterval = setInterval(poll, 1000);
    },

    stop: function () {
      if (_pollInterval) {
        clearInterval(_pollInterval);
        _pollInterval = null;
      }
      window.removeEventListener('gamepadconnected', poll);
      window.removeEventListener('gamepaddisconnected', poll);
    },

    readGamepad: readGamepad,

    getAssignments: function () {
      var result = {};
      for (var slot in _assignments) {
        var gpIndex = _assignments[slot];
        var entry = _detected[gpIndex];
        if (entry) {
          result[slot] = {
            gamepadIndex: gpIndex,
            profileName: entry.profileName,
            gamepadId: entry.id,
          };
        }
      }
      return result;
    },

    reassignSlot: function (slot, gamepadIndex) {
      if (_detected[gamepadIndex]) {
        _assignments[slot] = gamepadIndex;
        if (_onUpdate) _onUpdate();
      }
    },

    getDetected: function () {
      var result = [];
      for (var idx in _detected) {
        result.push({
          index: parseInt(idx, 10),
          id: _detected[idx].id,
          profileName: _detected[idx].profileName,
        });
      }
      return result;
    },
  };
})();
```

- [ ] **Step 2: Commit**

```bash
git add web/static/gamepad-manager.js
git commit -m "feat: add GamepadManager — profile-based gamepad detection and mapping"
```

---

### Task 2: Wire `gamepad-manager.js` into `play.html`

**Files:**
- Modify: `web/play.html:97-100`

- [ ] **Step 1: Add script tag**

In `web/play.html`, add after the Socket.IO script (line 97) and before the engine `<script>` block (line 100):

```html
  <!-- Gamepad manager (profiles, hot-plug, slot assignment) -->
  <script src="/static/gamepad-manager.js"></script>
```

- [ ] **Step 2: Commit**

```bash
git add web/play.html
git commit -m "feat: load gamepad-manager.js before netplay engines"
```

---

## Chunk 2: Engine Integration

### Task 3: Replace hardcoded gamepad in `netplay-lockstep.js`

**Files:**
- Modify: `web/static/netplay-lockstep.js:1403-1435`

- [ ] **Step 1: Replace the gamepad block in `readLocalInput()`**

Replace lines 1406-1424 (the `if (document.hasFocus()) { ... getGamepads ... }` block) with:

```js
    // Gamepad via GamepadManager (profile-based mapping)
    if (document.hasFocus() && window.GamepadManager) {
      mask |= GamepadManager.readGamepad(_playerSlot);
    }
```

The full function should now be:

```js
  function readLocalInput() {
    var mask = 0;

    // Gamepad via GamepadManager (profile-based mapping)
    if (document.hasFocus() && window.GamepadManager) {
      mask |= GamepadManager.readGamepad(_playerSlot);
    }

    // Keyboard
    if (_p1KeyMap) {
      _heldKeys.forEach(function (kc) {
        var btnIdx = _p1KeyMap[kc];
        if (btnIdx !== undefined) mask |= (1 << btnIdx);
      });
    }

    return mask;
  }
```

**Behavior change note:** The old code did a raw 1:1 mapping of gamepad buttons 0-15 to EJS bits 0-15. The new profile-based mapping is intentionally selective — only N64-relevant buttons are mapped, and the right stick now maps to C-buttons (new functionality). This is the correct N64 mapping, not a regression.

- [ ] **Step 2: Verify keyboard still works**

Start the server, open two tabs, create/join room, start game. Confirm keyboard input (WASD, arrows, C, X, V) still works exactly as before. No gamepad needed for this check — just verifying no regression.

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: use GamepadManager in lockstep readLocalInput()"
```

---

### Task 4: Replace hardcoded gamepad in `netplay-streaming.js`

**Files:**
- Modify: `web/static/netplay-streaming.js:689-704`

- [ ] **Step 1: Replace the entire `readLocalInput()` function (lines 689-704)**

Replace the full function with:

```js
  function readLocalInput() {
    let mask = 0;
    if (window.GamepadManager) {
      mask |= GamepadManager.readGamepad(_playerSlot);
    }
    if (_p1KeyMap) {
      _heldKeys.forEach(kc => {
        const btnIdx = _p1KeyMap[kc];
        if (btnIdx !== undefined) mask |= (1 << btnIdx);
      });
    }
    return mask;
  }
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-streaming.js
git commit -m "feat: use GamepadManager in streaming readLocalInput()"
```

---

## Chunk 3: Lobby UI Integration

### Task 5: Replace `startGamepadPolling()` in `play.js` with GamepadManager

**Files:**
- Modify: `web/static/play.js:23,581-601,640`

- [ ] **Step 1: Replace `startGamepadPolling()` function**

Replace the `startGamepadPolling()` function (lines 583-601) and the `gamepadInterval` variable (line 23) with:

Remove `var gamepadInterval = null;` (line 23).

Replace lines 583-601 with:

```js
  // ── Gamepad Detection ─────────────────────────────────────────────────

  function startGamepadManager() {
    if (!window.GamepadManager) return;
    GamepadManager.start({
      playerSlot: mySlot || 0,
      onUpdate: updateGamepadUI,
    });
  }

  function updateGamepadSlot() {
    // Re-start with correct slot when mySlot changes (after join/connect)
    if (window.GamepadManager && mySlot !== null) {
      GamepadManager.start({
        playerSlot: mySlot,
        onUpdate: updateGamepadUI,
      });
    }
  }

  function updateGamepadUI() {
    var detected = GamepadManager.getDetected();
    var assignments = GamepadManager.getAssignments();
    var statusEl = document.getElementById('gamepad-status');

    if (statusEl) {
      if (detected.length > 0) {
        var primary = detected[0];
        statusEl.textContent = primary.id.substring(0, 40) + ' (' + primary.profileName + ')';
        statusEl.className = 'gamepad-detected';
      } else {
        statusEl.textContent = 'No controller detected';
        statusEl.className = '';
      }
    }

    // Update .gamepad spans in player slots
    for (var i = 0; i < 4; i++) {
      var span = document.querySelector('.player-slot[data-slot="' + i + '"] .gamepad');
      if (!span) continue;
      var assignment = assignments[i];
      if (assignment) {
        span.textContent = '\uD83C\uDFAE'; // gamepad emoji
        span.title = assignment.gamepadId + ' (' + assignment.profileName + ')';
      } else {
        span.textContent = '';
        span.title = '';
      }
    }
  }
```

- [ ] **Step 2: Update the init call and slot sync**

Replace `startGamepadPolling();` (line 640) with `startGamepadManager();`.

Also add `updateGamepadSlot();` at the end of `onUsersUpdated()` (after line 162, inside `if (!gameRunning)`) so the GamepadManager's slot assignment updates when the server assigns the player's slot:

```js
    if (!gameRunning) {
      updatePlayerList(players, spectators);
      updateStartButton(players);
      updateGamepadSlot();
    }
```

- [ ] **Step 3: Add click-to-reassign on `.gamepad` spans**

Add after the `setupRomDrop();` call in the DOMContentLoaded handler:

```js
    // Click .gamepad span to cycle through detected gamepads
    var gamepadSpans = document.querySelectorAll('.player-slot .gamepad');
    for (var gi = 0; gi < gamepadSpans.length; gi++) {
      (function (span) {
        span.style.cursor = 'pointer';
        span.addEventListener('click', function () {
          if (!window.GamepadManager) return;
          var slotEl = span.closest('.player-slot');
          if (!slotEl) return;
          var slot = parseInt(slotEl.getAttribute('data-slot'), 10);
          if (slot !== mySlot) return; // only reassign own slot

          var detected = GamepadManager.getDetected();
          if (detected.length <= 1) return; // nothing to cycle

          var assignments = GamepadManager.getAssignments();
          var currentIdx = assignments[slot] ? assignments[slot].gamepadIndex : -1;
          // Find next gamepad in detected list
          var nextIdx = detected[0].index;
          for (var d = 0; d < detected.length; d++) {
            if (detected[d].index === currentIdx && d + 1 < detected.length) {
              nextIdx = detected[d + 1].index;
              break;
            }
          }
          // Wrap around
          if (nextIdx === currentIdx) nextIdx = detected[0].index;
          GamepadManager.reassignSlot(slot, nextIdx);
        });
      })(gamepadSpans[gi]);
    }
```

- [ ] **Step 4: Verify lobby shows controller status**

Connect a gamepad (or use browser DevTools gamepad emulation). Verify:
- `#gamepad-status` shows controller name and profile
- The `.gamepad` span on the user's slot shows the gamepad emoji
- Unplugging the controller clears both within 1 second

- [ ] **Step 5: Commit**

```bash
git add web/static/play.js
git commit -m "feat: lobby gamepad UI — detection, profile display, click-to-reassign"
```

---

## Chunk 4: Smoke Test

### Task 6: End-to-end gamepad verification

- [ ] **Step 1: Test lockstep with gamepad**

1. Start the server (`uv run kaillera-server`)
2. Open two incognito tabs to `http://0.0.0.0:8000`
3. Create room in tab 1, join in tab 2
4. Connect a gamepad to the machine
5. Verify lobby shows controller name and "(Standard)" profile
6. Start game
7. Use gamepad: D-pad to navigate menus, A button (face-bottom) for B, X button (face-left) for A, Start for Start
8. Verify keyboard still works simultaneously (OR'd together)
9. Unplug gamepad mid-game — keyboard should still work, no crash
10. Plug gamepad back in — should resume working within 1 second

- [ ] **Step 2: Test streaming with gamepad**

Same as above but select "Streaming" mode before starting. Verify gamepad input is sent to host and applied.

- [ ] **Step 3: Verify no desync or audio regression**

During lockstep test, confirm:
- Console shows `[lockstep] audio using AudioWorklet` or `AudioBufferSourceNode fallback`
- Audio plays
- No desync-related console spam
- Game stays in sync between both tabs

- [ ] **Step 4: Final commit with any fixes**

If any issues were found and fixed during testing:

```bash
git add -u
git commit -m "fix: gamepad integration fixes from smoke test"
```
