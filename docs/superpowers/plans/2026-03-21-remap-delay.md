# Gamepad Remapping Wizard & Frame Delay Selection — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a remapping wizard for gamepad and keyboard input, and a frame delay picker with auto-detection for lockstep netplay.

**Architecture:** The remapping wizard lives in `play.js` as inline lobby UI. It captures gamepad buttons/axes and keyboard keys, saving gamepad profiles to localStorage per gamepad ID and keyboard mappings as a single global entry. Frame delay selection adds a picker to the lockstep options, RTT measurement via data channel ping/pong, and delay negotiation in the lockstep-ready handshake (migrated from raw string to JSON).

**Tech Stack:** Vanilla JS, Browser Gamepad API, localStorage, WebRTC data channels.

**Spec:** `docs/superpowers/specs/2026-03-21-remap-delay-design.md`

---

## File Structure

| File | Role | Action |
|---|---|---|
| `web/static/gamepad-manager.js` | Add localStorage profile resolution + save/clear/getDefault helpers | Modify |
| `web/static/play.js` | Wizard UI, remap/reset buttons, delay picker, delay preference API | Modify |
| `web/play.html` | Add remap controls, wizard panel, delay picker HTML | Modify |
| `web/static/netplay-lockstep.js` | Custom keyboard loading, DELAY_FRAMES variable, ping/pong, lockstep-ready JSON migration, delay negotiation, late-join effectiveDelay | Modify |
| `web/static/netplay-streaming.js` | Custom keyboard loading in setupKeyTracking | Modify |

---

## Chunk 1: GamepadManager localStorage Integration

### Task 1: Add localStorage profile resolution and save/clear helpers to GamepadManager

**Files:**
- Modify: `web/static/gamepad-manager.js:94-99,200-265`

- [ ] **Step 1: Update `resolveProfile()` to check localStorage first**

Replace `resolveProfile` (lines 94-99) with:

```js
  function resolveProfile(id) {
    // Check localStorage for custom profile
    try {
      var saved = localStorage.getItem('gamepad-profile:' + id);
      if (saved) {
        var profile = JSON.parse(saved);
        profile.name = 'Custom';
        profile.match = function () { return true; };
        return profile;
      }
    } catch (_) {}

    // Fall through to built-in profiles
    for (var i = 0; i < PROFILES.length; i++) {
      if (PROFILES[i].match(id)) return PROFILES[i];
    }
    return PROFILES[PROFILES.length - 1];
  }
```

- [ ] **Step 2: Add save/clear/getDefault helpers to public API**

Add these methods to `window.GamepadManager` (after `getDetected`, before the closing `};`):

```js
    saveGamepadProfile: function (gamepadId, profile) {
      try {
        localStorage.setItem('gamepad-profile:' + gamepadId, JSON.stringify(profile));
      } catch (_) {}
      // Re-resolve profile for this gamepad
      for (var idx in _detected) {
        if (_detected[idx].id === gamepadId) {
          var resolved = resolveProfile(gamepadId);
          _detected[idx].profile = resolved;
          _detected[idx].profileName = resolved.name;
        }
      }
      if (_onUpdate) _onUpdate();
    },

    clearGamepadProfile: function (gamepadId) {
      try {
        localStorage.removeItem('gamepad-profile:' + gamepadId);
      } catch (_) {}
      for (var idx in _detected) {
        if (_detected[idx].id === gamepadId) {
          var resolved = resolveProfile(gamepadId);
          _detected[idx].profile = resolved;
          _detected[idx].profileName = resolved.name;
        }
      }
      if (_onUpdate) _onUpdate();
    },

    getDefaultProfile: function (gamepadId) {
      // Return the built-in profile (skip localStorage)
      for (var i = 0; i < PROFILES.length; i++) {
        if (PROFILES[i].match(gamepadId)) return PROFILES[i];
      }
      return PROFILES[PROFILES.length - 1];
    },

    hasCustomProfile: function (gamepadId) {
      try {
        return localStorage.getItem('gamepad-profile:' + gamepadId) !== null;
      } catch (_) { return false; }
    },
```

- [ ] **Step 3: Verify syntax and commit**

```bash
node -c web/static/gamepad-manager.js
git add web/static/gamepad-manager.js
git commit -m "feat: GamepadManager localStorage profile resolution and save/clear helpers"
```

---

## Chunk 2: Remapping Wizard

### Task 2: Add wizard HTML elements to play.html

**Files:**
- Modify: `web/play.html:61-62`

- [ ] **Step 1: Replace the gamepad-status div with a richer container**

Replace line 61-62:
```html
      <div id="gamepad-status">No controller detected</div>
      <div id="engine-status"></div>
```

With:
```html
      <div id="gamepad-area">
        <div id="gamepad-status">No controller detected</div>
        <div id="gamepad-controls">
          <button id="remap-btn" class="small-btn">Remap Controls</button>
          <button id="reset-mapping-btn" class="small-btn">Reset</button>
        </div>
        <div id="remap-wizard" style="display:none">
          <span id="remap-prompt"></span>
          <span id="remap-progress"></span>
          <button id="remap-skip" class="small-btn">Skip</button>
          <button id="remap-cancel" class="small-btn">Cancel</button>
        </div>
      </div>
      <div id="engine-status"></div>
```

- [ ] **Step 2: Commit**

```bash
git add web/play.html
git commit -m "feat: add remap wizard HTML elements to play.html"
```

---

### Task 3: Implement the remapping wizard in play.js

**Files:**
- Modify: `web/static/play.js:581-630,634-670`

- [ ] **Step 1: Add wizard state and step definitions**

Add after the `updateGamepadUI()` function (after line 630), before `// ── Init`:

```js
  // ── Remap Wizard ──────────────────────────────────────────────────────

  var WIZARD_STEPS = [
    { prompt: 'Press: A',         type: 'button', bit: 8 },
    { prompt: 'Press: B',         type: 'button', bit: 0 },
    { prompt: 'Press: Start',     type: 'button', bit: 3 },
    { prompt: 'Press: Z',         type: 'button', bit: 9 },
    { prompt: 'Press: L',         type: 'button', bit: 10 },
    { prompt: 'Press: R',         type: 'button', bit: 11 },
    { prompt: 'Press: D-Up',      type: 'button', bit: 4 },
    { prompt: 'Press: D-Down',    type: 'button', bit: 5 },
    { prompt: 'Press: D-Left',    type: 'button', bit: 6 },
    { prompt: 'Press: D-Right',   type: 'button', bit: 7 },
    { prompt: 'Push stick UP',    type: 'axis', bit: 16, axisGroup: 'stickY' },
    { prompt: 'Push stick DOWN',  type: 'axis', bit: 17, axisGroup: 'stickY' },
    { prompt: 'Push stick LEFT',  type: 'axis', bit: 18, axisGroup: 'stickX' },
    { prompt: 'Push stick RIGHT', type: 'axis', bit: 19, axisGroup: 'stickX' },
    { prompt: 'Press: C-Up',      type: 'cbutton', bit: 12 },
    { prompt: 'Press: C-Down',    type: 'cbutton', bit: 13 },
    { prompt: 'Press: C-Left',    type: 'cbutton', bit: 14 },
    { prompt: 'Press: C-Right',   type: 'cbutton', bit: 15 },
  ];

  var _wizardActive = false;
  var _wizardStep = 0;
  var _wizardDebounce = 0;
  var _wizardRafId = null;
  var _wizardKeyHandler = null;
  var _wizardGamepadProfile = null;  // copy of current profile being built
  var _wizardKeyMap = null;          // copy of current keymap being built
  var _wizardBaselineButtons = null; // buttons pressed when step started
  var _wizardAxisCaptures = {};      // { stickY: { posDir: 'pos'|'neg', posBit: N, negBit: N, index: N } }
```

- [ ] **Step 2: Add wizard start/cancel/save functions**

Add after the wizard state variables:

```js
  function startWizard() {
    var detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    var gamepadId = detected.length > 0 ? detected[0].id : null;

    // Initialize gamepad profile from current (default or saved)
    if (gamepadId && window.GamepadManager) {
      var current = GamepadManager.hasCustomProfile(gamepadId)
        ? JSON.parse(localStorage.getItem('gamepad-profile:' + gamepadId))
        : GamepadManager.getDefaultProfile(gamepadId);
      _wizardGamepadProfile = {
        name: 'Custom',
        buttons: Object.assign({}, current.buttons),
        axes: JSON.parse(JSON.stringify(current.axes)),
        axisButtons: JSON.parse(JSON.stringify(current.axisButtons || {})),
        deadzone: current.deadzone || 0.3,
      };
    } else {
      _wizardGamepadProfile = null;
    }

    // Initialize keyboard map from current (saved or DEFAULT_N64_KEYMAP)
    var savedKb = null;
    try { savedKb = JSON.parse(localStorage.getItem('keyboard-mapping')); } catch (_) {}
    if (savedKb && Object.keys(savedKb).length > 0) {
      _wizardKeyMap = Object.assign({}, savedKb);
    } else {
      // Copy DEFAULT_N64_KEYMAP — defined in netplay engines, replicate here
      _wizardKeyMap = {
        88: 0, 67: 8, 86: 3, 38: 4, 40: 5, 37: 6, 39: 7,
        90: 9, 84: 10, 89: 11, 73: 12, 75: 13, 74: 14, 76: 15,
        87: 16, 83: 17, 65: 18, 68: 19
      };
    }

    _wizardAxisCaptures = {};
    _wizardStep = 0;
    _wizardActive = true;
    _wizardDebounce = 0;

    // Show wizard UI, hide normal controls
    var wizardEl = document.getElementById('remap-wizard');
    var controlsEl = document.getElementById('gamepad-controls');
    var statusEl = document.getElementById('gamepad-status');
    if (wizardEl) wizardEl.style.display = '';
    if (controlsEl) controlsEl.style.display = 'none';
    if (statusEl) statusEl.style.display = 'none';

    // Capture baseline gamepad buttons (ignore already-pressed)
    _wizardBaselineButtons = {};
    if (gamepadId) {
      var gps = navigator.getGamepads();
      for (var gi = 0; gi < gps.length; gi++) {
        if (gps[gi]) {
          for (var bi = 0; bi < gps[gi].buttons.length; bi++) {
            if (gps[gi].buttons[bi].pressed) _wizardBaselineButtons[gi + ':' + bi] = true;
          }
        }
      }
    }

    // Keyboard listener
    _wizardKeyHandler = function (e) {
      if (!_wizardActive) return;
      if (e.keyCode === 27) { cancelWizard(); return; } // Escape
      e.preventDefault();
      if (Date.now() < _wizardDebounce) return;
      captureKeyboard(e.keyCode);
    };
    document.addEventListener('keydown', _wizardKeyHandler, true);

    // Start polling loop
    updateWizardPrompt();
    wizardPoll();
  }

  function cancelWizard() {
    _wizardActive = false;
    if (_wizardRafId) { cancelAnimationFrame(_wizardRafId); _wizardRafId = null; }
    if (_wizardKeyHandler) {
      document.removeEventListener('keydown', _wizardKeyHandler, true);
      _wizardKeyHandler = null;
    }

    var wizardEl = document.getElementById('remap-wizard');
    var controlsEl = document.getElementById('gamepad-controls');
    var statusEl = document.getElementById('gamepad-status');
    if (wizardEl) wizardEl.style.display = 'none';
    if (controlsEl) controlsEl.style.display = '';
    if (statusEl) statusEl.style.display = '';
  }

  function saveWizard() {
    // Save gamepad profile
    var detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    if (detected.length > 0 && _wizardGamepadProfile) {
      // Assemble axis captures into profile
      for (var groupName in _wizardAxisCaptures) {
        var cap = _wizardAxisCaptures[groupName];
        if (cap.index !== undefined && cap.posBit !== undefined && cap.negBit !== undefined) {
          _wizardGamepadProfile.axes[groupName] = {
            index: cap.index,
            bits: [cap.posBit, cap.negBit],
          };
        }
      }
      GamepadManager.saveGamepadProfile(detected[0].id, _wizardGamepadProfile);
    }

    // Save keyboard mapping
    try {
      localStorage.setItem('keyboard-mapping', JSON.stringify(_wizardKeyMap));
    } catch (_) {}

    cancelWizard();
  }

  function resetMappings() {
    var detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    if (detected.length > 0 && window.GamepadManager) {
      GamepadManager.clearGamepadProfile(detected[0].id);
    }
    try { localStorage.removeItem('keyboard-mapping'); } catch (_) {}
    updateGamepadUI();
  }
```

- [ ] **Step 3: Add wizard polling and capture functions**

Add after `resetMappings`:

```js
  function updateWizardPrompt() {
    var promptEl = document.getElementById('remap-prompt');
    var progressEl = document.getElementById('remap-progress');
    if (promptEl) promptEl.textContent = WIZARD_STEPS[_wizardStep].prompt + ' (gamepad or key)';
    if (progressEl) progressEl.textContent = '(' + (_wizardStep + 1) + '/' + WIZARD_STEPS.length + ')';
  }

  function wizardAdvance() {
    _wizardDebounce = Date.now() + 150;
    _wizardStep++;
    if (_wizardStep >= WIZARD_STEPS.length) {
      saveWizard();
      return;
    }
    // Reset baseline for new step
    _wizardBaselineButtons = {};
    var gps = navigator.getGamepads();
    for (var gi = 0; gi < gps.length; gi++) {
      if (gps[gi]) {
        for (var bi = 0; bi < gps[gi].buttons.length; bi++) {
          if (gps[gi].buttons[bi].pressed) _wizardBaselineButtons[gi + ':' + bi] = true;
        }
      }
    }
    updateWizardPrompt();
  }

  function wizardSkip() {
    if (!_wizardActive) return;
    wizardAdvance();
  }

  function wizardPoll() {
    if (!_wizardActive) return;
    _wizardRafId = requestAnimationFrame(wizardPoll);

    if (Date.now() < _wizardDebounce) return;

    var gps = navigator.getGamepads();
    var step = WIZARD_STEPS[_wizardStep];

    for (var gi = 0; gi < gps.length; gi++) {
      var gp = gps[gi];
      if (!gp) continue;

      // Check buttons (for button, cbutton, and axis steps — axis steps also accept buttons on keyboard side)
      if (step.type === 'button' || step.type === 'cbutton') {
        for (var bi = 0; bi < gp.buttons.length; bi++) {
          if (gp.buttons[bi].pressed && !_wizardBaselineButtons[gi + ':' + bi]) {
            captureGamepadButton(bi, step);
            return;
          }
        }
      }

      // Check axes (for axis and cbutton steps)
      if (step.type === 'axis' || step.type === 'cbutton') {
        var dz = 0.3;
        for (var ai = 0; ai < gp.axes.length; ai++) {
          var val = gp.axes[ai];
          if (Math.abs(val) > dz) {
            captureGamepadAxis(ai, val > 0, step);
            return;
          }
        }
      }
    }
  }

  function captureGamepadButton(buttonIndex, step) {
    if (!_wizardGamepadProfile) return;

    // Add to gamepad profile buttons map
    _wizardGamepadProfile.buttons[buttonIndex] = (1 << step.bit);
    wizardAdvance();
  }

  function captureGamepadAxis(axisIndex, isPositive, step) {
    if (!_wizardGamepadProfile) return;

    if (step.type === 'axis') {
      var group = step.axisGroup;

      // Axis validation: UP/DOWN same axis, LEFT/RIGHT same axis
      if (!_wizardAxisCaptures[group]) {
        _wizardAxisCaptures[group] = {};
      }
      var cap = _wizardAxisCaptures[group];

      // Check if partner direction was already captured on a different axis
      if (cap.index !== undefined && cap.index !== axisIndex) {
        // Reject — flash prompt
        var promptEl = document.getElementById('remap-prompt');
        if (promptEl) {
          var pairName = group === 'stickY' ? 'UP' : 'LEFT';
          promptEl.textContent = 'Must use same stick as ' + pairName + ' — try again';
          setTimeout(function () { updateWizardPrompt(); }, 1000);
        }
        return;
      }

      cap.index = axisIndex;
      if (isPositive) {
        cap.posBit = step.bit;
      } else {
        cap.negBit = step.bit;
      }

      wizardAdvance();
    } else if (step.type === 'cbutton') {
      // C-button mapped to axis
      var ejsBit = (1 << step.bit);
      // Find or create axisButtons entry
      if (!_wizardGamepadProfile.axisButtons) _wizardGamepadProfile.axisButtons = {};
      if (!_wizardGamepadProfile.axisButtons[axisIndex]) {
        _wizardGamepadProfile.axisButtons[axisIndex] = { pos: 0, neg: 0 };
      }
      if (isPositive) {
        _wizardGamepadProfile.axisButtons[axisIndex].pos |= ejsBit;
      } else {
        _wizardGamepadProfile.axisButtons[axisIndex].neg |= ejsBit;
      }
      wizardAdvance();
    }
  }

  function captureKeyboard(keyCode) {
    var step = WIZARD_STEPS[_wizardStep];

    // Remove old entry for this keyCode (key can only map to one function)
    for (var k in _wizardKeyMap) {
      if (parseInt(k, 10) === keyCode) {
        delete _wizardKeyMap[k];
      }
    }

    // Add new entry
    _wizardKeyMap[keyCode] = step.bit;
    wizardAdvance();
  }
```

- [ ] **Step 4: Update `updateGamepadUI` to show remap/reset buttons**

Replace the `updateGamepadUI` function (lines 601-630) with:

```js
  function updateGamepadUI() {
    var detected = window.GamepadManager ? GamepadManager.getDetected() : [];
    var assignments = window.GamepadManager ? GamepadManager.getAssignments() : {};
    var statusEl = document.getElementById('gamepad-status');

    if (statusEl && !_wizardActive) {
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
        span.textContent = '\uD83C\uDFAE';
        span.title = assignment.gamepadId + ' (' + assignment.profileName + ')';
      } else {
        span.textContent = '';
        span.title = '';
      }
    }
  }
```

- [ ] **Step 5: Wire up wizard buttons in DOMContentLoaded**

In the DOMContentLoaded handler (after `setupRomDrop();` on line 670), add before the gamepad spans click handler:

```js
    // Remap wizard buttons
    var remapBtn = document.getElementById('remap-btn');
    if (remapBtn) remapBtn.addEventListener('click', startWizard);

    var resetBtn = document.getElementById('reset-mapping-btn');
    if (resetBtn) resetBtn.addEventListener('click', resetMappings);

    var skipBtn = document.getElementById('remap-skip');
    if (skipBtn) skipBtn.addEventListener('click', wizardSkip);

    var cancelBtn = document.getElementById('remap-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', cancelWizard);
```

- [ ] **Step 6: Verify and commit**

```bash
node -c web/static/play.js
git add web/static/play.js
git commit -m "feat: remapping wizard — gamepad + keyboard capture with localStorage save"
```

---

### Task 4: Load custom keyboard mapping in both engines

**Files:**
- Modify: `web/static/netplay-lockstep.js:1505-1521`
- Modify: `web/static/netplay-streaming.js:647-663`

- [ ] **Step 1: Update lockstep `setupKeyTracking()`**

Replace lines 1505-1521 in `netplay-lockstep.js` with:

```js
  function setupKeyTracking() {
    if (_p1KeyMap) return;

    // Check localStorage for custom keyboard mapping first
    try {
      var saved = localStorage.getItem('keyboard-mapping');
      if (saved) {
        var parsed = JSON.parse(saved);
        if (parsed && Object.keys(parsed).length > 0) {
          _p1KeyMap = {};
          for (var k in parsed) _p1KeyMap[parseInt(k, 10)] = parsed[k];
        }
      }
    } catch (_) {}

    // Try EJS controls if no custom mapping
    if (!_p1KeyMap) {
      var ejs = window.EJS_emulator;
      if (ejs && ejs.controls && ejs.controls[0]) {
        _p1KeyMap = {};
        Object.entries(ejs.controls[0]).forEach(function (entry) {
          var btnIdx = entry[0];
          var binding = entry[1];
          var kc = binding && binding.value;
          if (kc) _p1KeyMap[kc] = parseInt(btnIdx, 10);
        });
      }
    }

    if (!_p1KeyMap || Object.keys(_p1KeyMap).length === 0) {
      _p1KeyMap = Object.assign({}, DEFAULT_N64_KEYMAP);
    }
```

(Keep lines 1523-1528 as-is — the listener setup.)

- [ ] **Step 2: Update streaming `setupKeyTracking()`**

Apply the same change to `web/static/netplay-streaming.js` lines 647-663. Same logic, just uses arrow functions:

```js
  function setupKeyTracking() {
    if (_p1KeyMap) return;

    // Check localStorage for custom keyboard mapping first
    try {
      const saved = localStorage.getItem('keyboard-mapping');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Object.keys(parsed).length > 0) {
          _p1KeyMap = {};
          for (const k in parsed) _p1KeyMap[parseInt(k, 10)] = parsed[k];
        }
      }
    } catch (_) {}

    // Try EJS controls if no custom mapping
    if (!_p1KeyMap) {
      const ejs = window.EJS_emulator;
      if (ejs && ejs.controls && ejs.controls[0]) {
        _p1KeyMap = {};
        Object.entries(ejs.controls[0]).forEach(([btnIdx, binding]) => {
          const kc = binding && binding.value;
          if (kc) _p1KeyMap[kc] = parseInt(btnIdx, 10);
        });
      }
    }

    if (!_p1KeyMap || Object.keys(_p1KeyMap).length === 0) {
      _p1KeyMap = Object.assign({}, DEFAULT_N64_KEYMAP);
    }
```

(Keep the listener setup lines as-is.)

- [ ] **Step 3: Verify and commit**

```bash
node -c web/static/netplay-lockstep.js && node -c web/static/netplay-streaming.js
git add web/static/netplay-lockstep.js web/static/netplay-streaming.js
git commit -m "feat: load custom keyboard mapping from localStorage in both engines"
```

---

## Chunk 3: Frame Delay Selection

### Task 5: Add delay picker HTML and UI logic

**Files:**
- Modify: `web/play.html:53-55`
- Modify: `web/static/play.js` (DOMContentLoaded and new functions)

- [ ] **Step 1: Add delay picker elements to play.html**

Replace lines 53-55 in `web/play.html`:
```html
        <div id="lockstep-options">
          <label><input type="checkbox" id="opt-rollback"> Rollback <span class="opt-hint">(experimental resync)</span></label>
        </div>
```

With:
```html
        <div id="lockstep-options">
          <label><input type="checkbox" id="opt-rollback"> Rollback <span class="opt-hint">(experimental resync)</span></label>
          <div id="delay-picker">
            <label>Frame Delay:</label>
            <label><input type="checkbox" id="delay-auto" checked> Auto</label>
            <select id="delay-select" disabled>
              <option value="0">—</option>
              <option value="1">1</option><option value="2">2</option>
              <option value="3">3</option><option value="4">4</option>
              <option value="5">5</option><option value="6">6</option>
              <option value="7">7</option><option value="8">8</option>
              <option value="9">9</option>
            </select>
            <span id="delay-effective" class="opt-hint"></span>
          </div>
        </div>
```

- [ ] **Step 2: Add delay UI wiring in play.js**

Add in the DOMContentLoaded handler (after the mode selector wiring, around line 666):

```js
    // Delay picker
    var delayAuto = document.getElementById('delay-auto');
    var delaySelect = document.getElementById('delay-select');
    if (delayAuto && delaySelect) {
      delayAuto.addEventListener('change', function () {
        delaySelect.disabled = delayAuto.checked;
      });
    }
```

- [ ] **Step 3: Add `getDelayPreference()` function to play.js**

Add in play.js (before the Init section):

```js
  // ── Delay Preference ────────────────────────────────────────────────

  window._delayAutoValue = 2;  // set by engine after RTT measurement

  function getDelayPreference() {
    var autoEl = document.getElementById('delay-auto');
    var selectEl = document.getElementById('delay-select');
    if (autoEl && autoEl.checked) {
      return window._delayAutoValue;
    }
    if (selectEl) {
      var v = parseInt(selectEl.value, 10);
      return v > 0 ? v : 2;
    }
    return 2;
  }

  // Expose for engine consumption
  window.getDelayPreference = getDelayPreference;

  function setAutoDelay(value) {
    window._delayAutoValue = value;
    var selectEl = document.getElementById('delay-select');
    var autoEl = document.getElementById('delay-auto');
    if (selectEl && autoEl && autoEl.checked) {
      selectEl.value = String(value);
    }
  }

  window.setAutoDelay = setAutoDelay;

  function showEffectiveDelay(own, room) {
    var el = document.getElementById('delay-effective');
    if (!el) return;
    if (room > own) {
      el.textContent = '(room: ' + room + ')';
    } else {
      el.textContent = '';
    }
  }

  window.showEffectiveDelay = showEffectiveDelay;
```

- [ ] **Step 4: Verify and commit**

```bash
node -c web/static/play.js
git add web/play.html web/static/play.js
git commit -m "feat: frame delay picker UI with auto/manual toggle"
```

---

### Task 6: RTT measurement, lockstep-ready migration, and delay negotiation

**Files:**
- Modify: `web/static/netplay-lockstep.js:29,462,485-531,795,817,846-851,857-898`

This is the largest task. It modifies the lockstep engine's data channel message handling.

- [ ] **Step 1: Make DELAY_FRAMES a variable**

Change line 29 from:
```js
  const DELAY_FRAMES = 2;
```
To:
```js
  var DELAY_FRAMES = 2;
```

- [ ] **Step 2: Add RTT measurement state variables**

Add after the `DELAY_FRAMES` variable (around line 30):

```js
  var _rttSamples = [];
  var _rttPingPending = false;
  var _rttComplete = false;
  var _rttPingCount = 0;
```

- [ ] **Step 3: Add RTT measurement functions**

Add after the state variables:

```js
  function startRttMeasurement(dc) {
    _rttSamples = [];
    _rttPingCount = 0;
    _rttComplete = false;
    sendNextPing(dc);
  }

  function sendNextPing(dc) {
    if (_rttPingCount >= 3) {
      // Compute median
      _rttSamples.sort(function (a, b) { return a - b; });
      var median = _rttSamples[Math.floor(_rttSamples.length / 2)];
      var delay = Math.min(9, Math.max(1, Math.ceil(median / 16.67)));
      _rttComplete = true;
      if (window.setAutoDelay) window.setAutoDelay(delay);
      console.log('[lockstep] RTT median: ' + median.toFixed(1) + 'ms -> auto delay: ' + delay);
      return;
    }
    _rttPingPending = true;
    try {
      dc.send(JSON.stringify({ type: 'delay-ping', ts: performance.now() }));
    } catch (_) {
      _rttComplete = true; // can't measure, use default
    }
  }

  function handleDelayPong(ts, dc) {
    var rtt = performance.now() - ts;
    _rttSamples.push(rtt);
    _rttPingCount++;
    _rttPingPending = false;
    sendNextPing(dc);
    // If RTT just completed and we were waiting to send lockstep-ready, do it now
    if (_rttComplete && _selfLockstepReady) {
      broadcastLockstepReady();
      checkAllLockstepReady();
    }
  }

  function broadcastLockstepReady() {
    var dl = window.getDelayPreference ? window.getDelayPreference() : 2;
    Object.values(_peers).forEach(function (p) {
      if (p.dc && p.dc.readyState === 'open' && p.slot !== null && p.slot !== undefined) {
        try {
          p.dc.send(JSON.stringify({ type: 'lockstep-ready', delay: dl }));
        } catch (_) {}
      }
    });
  }
```

- [ ] **Step 4: Update data channel onmessage — add ping/pong, migrate lockstep-ready to JSON**

In the data channel `onmessage` handler (lines 485-531), make these changes:

**a)** Remove the old `lockstep-ready` string check (line 489-492):
```js
        if (e.data === 'lockstep-ready') {
          _lockstepReadyPeers[remoteSid] = true;
          checkAllLockstepReady();
        }
```

**b)** In the JSON message block (lines 524-529), add handling for the new message types:
```js
        if (e.data.charAt(0) === '{') {
          try {
            var msg = JSON.parse(e.data);
            if (msg.type === 'save-state')      handleSaveStateMsg(msg);
            if (msg.type === 'late-join-state')  handleLateJoinState(msg);
            if (msg.type === 'delay-ping') {
              peer.dc.send(JSON.stringify({ type: 'delay-pong', ts: msg.ts }));
            }
            if (msg.type === 'delay-pong') {
              handleDelayPong(msg.ts, peer.dc);
            }
            if (msg.type === 'lockstep-ready') {
              peer.delayValue = msg.delay || 2;
              _lockstepReadyPeers[remoteSid] = true;
              checkAllLockstepReady();
            }
          } catch (_) {}
        }
```

- [ ] **Step 5: Start RTT measurement when data channel opens**

In the data channel `onopen` handler (around line 462, where `ch.send('emu-ready')` is), add after the emu-ready send:

```js
      // Host initiates RTT measurement for auto delay
      if (_playerSlot === 0) {
        startRttMeasurement(ch);
      } else {
        _rttComplete = true; // guests don't measure, use their own preference
      }
```

- [ ] **Step 6: Migrate lockstep-ready sends to JSON with delay**

Replace both blocks that send `'lockstep-ready'` (lines 792-798 and 814-820). Each block currently looks like:

```js
      _selfLockstepReady = true;
      Object.values(_peers).forEach(function (p) {
        if (p.dc && p.dc.readyState === 'open' && p.slot !== null && p.slot !== undefined) {
          try { p.dc.send('lockstep-ready'); } catch (_) {}
        }
      });
      checkAllLockstepReady();
```

Replace each with:

```js
      _selfLockstepReady = true;
      // Gate on RTT completion: if Auto delay and RTT not done, defer broadcast
      if (_rttComplete) {
        broadcastLockstepReady();
      }
      checkAllLockstepReady();
```

The deferred case is handled in `handleDelayPong` — when RTT completes and `_selfLockstepReady` is true, it calls `broadcastLockstepReady()` + `checkAllLockstepReady()` automatically.

- [ ] **Step 7: Add delay negotiation in `checkAllLockstepReady()`**

Find `checkAllLockstepReady` and add delay negotiation before the GO log line. The function computes the max delay from all peers and the local preference:

Add before the `console.log('[lockstep]' ... 'lockstep-ready -- GO')` line (around line 742):

```js
      // Negotiate delay: ceiling of all players
      var ownDelay = window.getDelayPreference ? window.getDelayPreference() : 2;
      var maxDelay = ownDelay;
      Object.values(_peers).forEach(function (p) {
        if (p.delayValue && p.delayValue > maxDelay) maxDelay = p.delayValue;
      });
      DELAY_FRAMES = maxDelay;
      if (window.showEffectiveDelay) window.showEffectiveDelay(ownDelay, maxDelay);
      console.log('[lockstep] delay negotiated: own=' + ownDelay + ' effective=' + maxDelay);
```

- [ ] **Step 8: Add effectiveDelay to late-join-state**

In `sendLateJoinState` (around line 847), add `effectiveDelay` to the emitted object:

```js
      socket.emit('data-message', {
        type: 'late-join-state',
        frame: _frameNum,
        data: b64,
        effectiveDelay: DELAY_FRAMES,
      });
```

In `handleLateJoinState` (around line 857), add after the existing setup:

```js
    if (msg.effectiveDelay) {
      DELAY_FRAMES = msg.effectiveDelay;
      console.log('[lockstep] late-join: using room delay ' + DELAY_FRAMES);
    }
```

- [ ] **Step 9: Reset delay/RTT state in stop()**

Find the `stop()` function in the lockstep engine (the exported `stop` method of the engine object). Add at the top of the function:

```js
    DELAY_FRAMES = 2;
    _rttSamples = [];
    _rttPingPending = false;
    _rttComplete = false;
    _rttPingCount = 0;
```

This prevents stale delay values and skipped RTT measurement when starting a new game without page refresh.

- [ ] **Step 10: Verify and commit**

```bash
node -c web/static/netplay-lockstep.js
git add web/static/netplay-lockstep.js
git commit -m "feat: RTT measurement, lockstep-ready JSON migration, delay negotiation"
```

---

## Chunk 4: Verification

### Task 7: End-to-end verification

- [ ] **Step 1: Verify server starts**

```bash
timeout 5 uv run kaillera-server 2>&1 || true
```

Expect: clean startup, no import errors. "address already in use" is fine if the user's server is running.

- [ ] **Step 2: Verify all JS files parse**

```bash
node -c web/static/gamepad-manager.js && \
node -c web/static/play.js && \
node -c web/static/netplay-lockstep.js && \
node -c web/static/netplay-streaming.js && \
echo "All OK"
```

- [ ] **Step 3: Verify keyboard input path is intact**

Read both engines' `readLocalInput()` to confirm keyboard block (`_p1KeyMap` / `_heldKeys`) is unchanged.

- [ ] **Step 4: List manual tests for user**

Print the manual test checklist for the user to verify with a real gamepad:

**Remapping Wizard:**
1. Open lobby, verify "Remap Controls" button is visible
2. Click "Remap Controls" — wizard panel should appear
3. Press gamepad buttons for each step — verify each capture advances
4. Press keyboard keys for some steps — verify mixed capture works
5. Click Skip for some steps — verify they keep defaults
6. Press Escape — verify cancel discards changes
7. Complete full wizard run — verify profile saved (profile name shows "Custom")
8. Refresh page — verify custom profile loads from localStorage
9. Click Reset — verify reverts to built-in defaults

**Frame Delay:**
10. In lockstep options, verify delay picker shows "Auto" checked with "—"
11. Uncheck Auto — verify dropdown becomes interactive (1-9)
12. Create room, join with two tabs, start game
13. Check console for RTT measurement log: `[lockstep] RTT median: Xms -> auto delay: N`
14. Check console for delay negotiation: `[lockstep] delay negotiated: own=N effective=N`
15. Verify debug overlay shows the negotiated delay value
