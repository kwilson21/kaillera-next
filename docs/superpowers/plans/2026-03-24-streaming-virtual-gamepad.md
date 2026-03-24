# Streaming Virtual Gamepad Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone virtual gamepad overlay for mobile streaming guests who don't boot EmulatorJS and therefore lack touch controls.

**Architecture:** A new `virtual-gamepad.js` module renders N64 touch controls as CSS-only DOM elements. It writes touch state into a `_touchInputState` object owned by the streaming engine, which converts it to a bitmask in `readLocalInput()` and sends it over the existing DataChannel pipeline. No new network protocol or server changes.

**Tech Stack:** Vanilla JS, CSS, DOM touch events

**Spec:** `docs/superpowers/specs/2026-03-23-streaming-virtual-gamepad-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `web/static/virtual-gamepad.js` | Create | Self-contained gamepad overlay: DOM creation, touch handling, state writing |
| `web/static/netplay-streaming.js` | Modify | Add `_touchInputState`, touch→bitmask in `readLocalInput()`, init/destroy gamepad |
| `web/static/play.js` | Modify | Pass `isMobile` in config, toggle gamepad visibility on physical gamepad connect/disconnect |
| `web/play.html` | Modify | Add script tag |

---

## Chunk 1: Virtual Gamepad Module

### Task 1: Create virtual-gamepad.js with N64 layout and touch handling

**Files:**
- Create: `web/static/virtual-gamepad.js`

- [ ] **Step 1: Create the module with full N64 layout and touch handling**

```javascript
// web/static/virtual-gamepad.js
// Standalone N64 virtual gamepad for mobile streaming guests.
// Writes touch state into a provided stateObj using EJS simulateInput indices.
(function () {
  'use strict';

  var _container = null;
  var _overlay = null;
  var _stateObj = null;
  var _stickTouch = null;   // Touch.identifier tracking the analog stick
  var _stickCenter = null;  // {x, y} center of the stick zone
  var _buttonTouches = {};  // Touch.identifier → button index
  var _stickEl = null;      // stick knob element for visual feedback
  var _stickZone = null;    // stick zone element

  var STICK_RADIUS = 55;    // max drag radius in px
  var MAX_AXIS = 32767;

  // Button definitions: [index, label, cssClass]
  var BUTTONS = [
    [8,  'A',     'vgp-a'],
    [0,  'B',     'vgp-b'],
    [3,  'Start', 'vgp-start'],
    [9,  'L',     'vgp-l'],
    [10, 'R',     'vgp-r'],
    [11, 'Z',     'vgp-z'],
    [4,  '\u25B2', 'vgp-du'],   // D-pad up
    [5,  '\u25BC', 'vgp-dd'],   // D-pad down
    [6,  '\u25C0', 'vgp-dl'],   // D-pad left
    [7,  '\u25B6', 'vgp-dr'],   // D-pad right
    [23, 'CU',    'vgp-cu'],
    [22, 'CD',    'vgp-cd'],
    [21, 'CL',    'vgp-cl'],
    [20, 'CR',    'vgp-cr'],
  ];

  function createOverlay() {
    _overlay = document.createElement('div');
    _overlay.id = 'virtual-gamepad';
    _overlay.innerHTML = [
      '<style>',
      '#virtual-gamepad{position:fixed;top:0;left:0;right:0;bottom:0;z-index:55;pointer-events:none;user-select:none;-webkit-user-select:none;touch-action:none;}',
      '#virtual-gamepad *{pointer-events:auto;}',
      '.vgp-btn{position:absolute;display:flex;align-items:center;justify-content:center;',
      '  border-radius:50%;background:rgba(255,255,255,0.15);color:rgba(255,255,255,0.7);',
      '  font-size:14px;font-weight:bold;font-family:sans-serif;border:2px solid rgba(255,255,255,0.25);',
      '  touch-action:none;-webkit-tap-highlight-color:transparent;}',
      '.vgp-btn.active{background:rgba(255,255,255,0.35);}',

      /* Analog stick zone */
      '.vgp-stick-zone{position:absolute;left:20px;top:50%;transform:translateY(-65%);',
      '  width:130px;height:130px;border-radius:50%;background:rgba(255,255,255,0.08);',
      '  border:2px solid rgba(255,255,255,0.15);}',
      '.vgp-stick-knob{position:absolute;width:50px;height:50px;border-radius:50%;',
      '  background:rgba(255,255,255,0.25);border:2px solid rgba(255,255,255,0.4);',
      '  left:50%;top:50%;transform:translate(-50%,-50%);transition:none;will-change:transform;}',

      /* A and B — large, right side */
      '.vgp-a{width:56px;height:56px;right:30px;bottom:28%;font-size:18px;}',
      '.vgp-b{width:48px;height:48px;right:95px;bottom:22%;font-size:16px;}',

      /* C-buttons — diamond, right-center */
      '.vgp-cu{width:38px;height:38px;right:180px;bottom:42%;font-size:11px;}',
      '.vgp-cd{width:38px;height:38px;right:180px;bottom:18%;font-size:11px;}',
      '.vgp-cl{width:38px;height:38px;right:218px;bottom:30%;font-size:11px;}',
      '.vgp-cr{width:38px;height:38px;right:142px;bottom:30%;font-size:11px;}',

      /* D-pad — below stick, left side */
      '.vgp-du{width:34px;height:34px;left:60px;bottom:12%;font-size:11px;border-radius:6px;}',
      '.vgp-dd{width:34px;height:34px;left:60px;bottom:0%;font-size:11px;border-radius:6px;}',
      '.vgp-dl{width:34px;height:34px;left:30px;bottom:6%;font-size:11px;border-radius:6px;}',
      '.vgp-dr{width:34px;height:34px;left:90px;bottom:6%;font-size:11px;border-radius:6px;}',

      /* Start — center bottom */
      '.vgp-start{width:50px;height:28px;left:50%;bottom:5%;transform:translateX(-50%);',
      '  border-radius:14px;font-size:11px;}',

      /* Shoulders — top edges */
      '.vgp-l{width:50px;height:30px;left:10px;top:8px;border-radius:8px;font-size:13px;}',
      '.vgp-r{width:50px;height:30px;right:10px;top:8px;border-radius:8px;font-size:13px;}',
      '.vgp-z{width:50px;height:30px;left:10px;top:46px;border-radius:8px;font-size:13px;}',

      '</style>',
      '<div class="vgp-stick-zone"></div>',
    ].join('\n');

    // Create buttons
    for (var i = 0; i < BUTTONS.length; i++) {
      var btn = document.createElement('div');
      btn.className = 'vgp-btn ' + BUTTONS[i][2];
      btn.textContent = BUTTONS[i][1];
      btn.dataset.idx = BUTTONS[i][0];
      _overlay.appendChild(btn);
    }

    // Create stick knob inside stick zone
    _stickZone = _overlay.querySelector('.vgp-stick-zone');
    _stickEl = document.createElement('div');
    _stickEl.className = 'vgp-stick-knob';
    _stickZone.appendChild(_stickEl);

    // Attach touch listeners
    _overlay.addEventListener('touchstart', onTouchStart, { passive: false });
    _overlay.addEventListener('touchmove', onTouchMove, { passive: false });
    _overlay.addEventListener('touchend', onTouchEnd, { passive: false });
    _overlay.addEventListener('touchcancel', onTouchEnd, { passive: false });

    _container.appendChild(_overlay);
  }

  function onTouchStart(e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var el = document.elementFromPoint(t.clientX, t.clientY);

      // Check if touching the stick zone
      if (el === _stickZone || el === _stickEl || (el && el.parentNode === _stickZone)) {
        _stickTouch = t.identifier;
        var rect = _stickZone.getBoundingClientRect();
        _stickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        updateStick(t.clientX, t.clientY);
        continue;
      }

      // Check if touching a button
      var btnEl = el && el.closest ? el.closest('.vgp-btn') : null;
      if (!btnEl && el && el.classList && el.classList.contains('vgp-btn')) btnEl = el;
      if (btnEl && btnEl.dataset.idx !== undefined) {
        var idx = parseInt(btnEl.dataset.idx, 10);
        _buttonTouches[t.identifier] = idx;
        btnEl.classList.add('active');
        if (_stateObj) _stateObj[idx] = 1;
      }
    }
  }

  function onTouchMove(e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (t.identifier === _stickTouch && _stickCenter) {
        updateStick(t.clientX, t.clientY);
      }
    }
  }

  function onTouchEnd(e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];

      // Stick released
      if (t.identifier === _stickTouch) {
        _stickTouch = null;
        _stickCenter = null;
        if (_stateObj) {
          _stateObj[16] = 0;
          _stateObj[17] = 0;
          _stateObj[18] = 0;
          _stateObj[19] = 0;
        }
        if (_stickEl) _stickEl.style.transform = 'translate(-50%, -50%)';
        continue;
      }

      // Button released
      var idx = _buttonTouches[t.identifier];
      if (idx !== undefined) {
        delete _buttonTouches[t.identifier];
        if (_stateObj) _stateObj[idx] = 0;
        // Remove active class from matching button
        var btns = _overlay.querySelectorAll('.vgp-btn[data-idx="' + idx + '"]');
        for (var b = 0; b < btns.length; b++) btns[b].classList.remove('active');
      }
    }
  }

  function updateStick(clientX, clientY) {
    if (!_stickCenter || !_stateObj) return;
    var dx = clientX - _stickCenter.x;
    var dy = clientY - _stickCenter.y;
    var dist = Math.sqrt(dx * dx + dy * dy);

    // Clamp to radius
    if (dist > STICK_RADIUS) {
      dx = dx / dist * STICK_RADIUS;
      dy = dy / dist * STICK_RADIUS;
      dist = STICK_RADIUS;
    }

    // Visual feedback — move knob
    if (_stickEl) {
      _stickEl.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
    }

    // Map to axis values (0–32767 per direction)
    var magnitude = dist / STICK_RADIUS;  // 0–1
    var axisVal = Math.round(magnitude * MAX_AXIS);

    // Right (+X) / Left (-X)
    _stateObj[16] = dx > 0 ? Math.round((dx / STICK_RADIUS) * MAX_AXIS) : 0;  // right
    _stateObj[17] = dx < 0 ? Math.round((-dx / STICK_RADIUS) * MAX_AXIS) : 0; // left
    // Down (+Y) / Up (-Y)  — screen Y is inverted vs N64 Y
    _stateObj[18] = dy > 0 ? Math.round((dy / STICK_RADIUS) * MAX_AXIS) : 0;  // down
    _stateObj[19] = dy < 0 ? Math.round((-dy / STICK_RADIUS) * MAX_AXIS) : 0; // up
  }

  function clearState() {
    if (!_stateObj) return;
    for (var k in _stateObj) {
      if (_stateObj.hasOwnProperty(k)) _stateObj[k] = 0;
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  window.VirtualGamepad = {
    init: function (container, stateObj) {
      _container = container;
      _stateObj = stateObj;
      createOverlay();
      console.log('[virtual-gamepad] initialized');
    },

    destroy: function () {
      if (_overlay) {
        _overlay.removeEventListener('touchstart', onTouchStart);
        _overlay.removeEventListener('touchmove', onTouchMove);
        _overlay.removeEventListener('touchend', onTouchEnd);
        _overlay.removeEventListener('touchcancel', onTouchEnd);
        if (_overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
        _overlay = null;
      }
      clearState();
      _stateObj = null;
      _container = null;
      _stickTouch = null;
      _stickCenter = null;
      _buttonTouches = {};
      console.log('[virtual-gamepad] destroyed');
    },

    setVisible: function (visible) {
      if (_overlay) {
        _overlay.style.display = visible ? '' : 'none';
        if (!visible) clearState();
      }
      // Reposition game screen: top-aligned with gamepad, centered without
      var gameEl = document.getElementById('game');
      if (gameEl) {
        gameEl.style.margin = visible ? '0' : 'auto 0';
      }
    },
  };
})();
```

- [ ] **Step 2: Commit**

```bash
git add web/static/virtual-gamepad.js
git commit -m "feat: add standalone virtual gamepad module for mobile streaming guests"
```

---

## Chunk 2: Streaming Engine Integration

### Task 2: Add touch input reading to streaming engine

**Files:**
- Modify: `web/static/netplay-streaming.js:86-90` (add `_touchInputState`)
- Modify: `web/static/netplay-streaming.js:742-753` (extend `readLocalInput`)
- Modify: `web/static/netplay-streaming.js:782-805` (init/destroy gamepad)
- Modify: `web/static/netplay-streaming.js:807-842` (cleanup in stop)

- [ ] **Step 1: Add `_touchInputState` variable declaration**

After line 88 (`let _gameRunning = false;`), add:

```javascript
  let _touchInputState    = {};     // virtual gamepad touch state (index → value)
```

- [ ] **Step 2: Add touch input reading to `readLocalInput()`**

Replace the existing `readLocalInput` function (lines 742–753) with:

```javascript
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

    // Virtual gamepad touch input (same logic as lockstep readLocalInput)
    // Left stick (indices 16-19): apply absolute + relative deadzone
    var TOUCH_ABS_DEADZONE = 3500;
    var stR = _touchInputState[16] || 0;
    var stL = _touchInputState[17] || 0;
    var stD = _touchInputState[18] || 0;
    var stU = _touchInputState[19] || 0;
    var stMajor = Math.max(stR, stL, stD, stU);
    if (stMajor > TOUCH_ABS_DEADZONE) {
      var stThresh = stMajor * 0.4;
      if (stR > stThresh) mask |= (1 << 16);
      if (stL > stThresh) mask |= (1 << 17);
      if (stD > stThresh) mask |= (1 << 18);
      if (stU > stThresh) mask |= (1 << 19);
    }
    // Digital buttons + C-buttons
    for (var ti in _touchInputState) {
      var idx = parseInt(ti, 10);
      if (idx >= 16 && idx <= 19) continue;
      var val = _touchInputState[idx];
      if (!val) continue;
      if (idx < 16) {
        mask |= (1 << idx);
      } else if (idx >= 20 && idx <= 23) {
        if (val > 0) mask |= (1 << idx);
      }
    }

    return mask;
  }
```

- [ ] **Step 3: Initialize virtual gamepad in `init()` for mobile guests**

At the end of the `init` function (before the closing `}`), after the `initialPlayers` block (~line 803), add:

```javascript
    // Virtual gamepad for mobile streaming guests
    if (config.isMobile && !_isSpectator && _playerSlot !== 0 && window.VirtualGamepad) {
      var gameEl = config.gameElement || document.getElementById('game');
      if (gameEl) {
        VirtualGamepad.init(gameEl, _touchInputState);
        // Top-align game to make room for controls
        gameEl.style.margin = '0';
      }
    }
```

- [ ] **Step 4: Add cleanup in `stop()`**

In the `stop()` function, before `_config = null;` (~line 841), add:

```javascript
    // Clean up virtual gamepad
    if (window.VirtualGamepad) {
      VirtualGamepad.destroy();
    }
    _touchInputState = {};
```

- [ ] **Step 5: Commit**

```bash
git add web/static/netplay-streaming.js
git commit -m "feat: integrate virtual gamepad touch input into streaming engine"
```

---

## Chunk 3: play.js + HTML Wiring

### Task 3: Pass isMobile config and wire gamepad visibility toggle

**Files:**
- Modify: `web/static/play.js:1588` (add isMobile to config)
- Modify: `web/static/play.js:2182-2190` (add VirtualGamepad toggle in updateGamepadUI)
- Modify: `web/play.html:212` (add script tag)

- [ ] **Step 1: Pass `isMobile` in engine config**

In `initEngine()`, add `isMobile: _isMobile,` to the config object passed to `engine.init()`. Add it after the `romHash` line (~line 1596):

```javascript
      romHash: _romHash || null,
      isMobile: _isMobile,
```

- [ ] **Step 2: Add VirtualGamepad visibility toggle in `updateGamepadUI`**

After the existing EJS virtual gamepad toggle block (after line 2190), add:

```javascript
    // Toggle standalone virtual gamepad (streaming mode guests)
    if (window.VirtualGamepad) {
      if (detected.length > 0) {
        VirtualGamepad.setVisible(false);
      } else if ('ontouchstart' in window) {
        VirtualGamepad.setVisible(true);
      }
    }
```

- [ ] **Step 3: Add script tag to play.html**

In `web/play.html`, before the netplay engine scripts (~line 213), add:

```html
  <!-- Virtual gamepad for mobile streaming guests -->
  <script src="/static/virtual-gamepad.js"></script>
```

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js web/play.html
git commit -m "feat: wire virtual gamepad into play page with physical gamepad toggle"
```

---

## Chunk 4: Manual Testing

### Task 4: Test on mobile device

- [ ] **Step 1: Test streaming mode on mobile as guest**

1. Create room on desktop (host), select streaming mode
2. Join on mobile device as guest
3. Verify virtual gamepad overlay appears over the video stream
4. Verify analog stick responds to touch drag with visual knob feedback
5. Verify buttons highlight on press and send input to host
6. Verify all N64 buttons work: A, B, Start, L, R, Z, D-pad (4), C-buttons (4)

- [ ] **Step 2: Test physical gamepad toggle**

1. Connect a Bluetooth gamepad to the mobile device
2. Verify virtual gamepad hides and game screen centers
3. Disconnect the gamepad
4. Verify virtual gamepad reappears and game screen moves to top

- [ ] **Step 3: Test host is unaffected**

1. Verify host on mobile in streaming mode still gets EJS's built-in virtual gamepad (not the standalone one)

- [ ] **Step 4: Test lockstep mode unaffected**

1. Start a lockstep game on mobile
2. Verify EJS's built-in virtual gamepad still works normally
3. Verify no standalone virtual gamepad appears
