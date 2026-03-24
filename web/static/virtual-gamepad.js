// web/static/virtual-gamepad.js
// Standalone N64 virtual gamepad for mobile streaming (and lockstep) guests.
// Writes touch state into a provided stateObj using EJS simulateInput indices.
//
// Layout strategy: the gamepad is an IN-FLOW flex child of <body> using CSS
// order to sit between the game area and toolbar. No position:fixed — all
// elements share the viewport via flexbox without overlapping.
(function () {
  'use strict';

  var _overlay = null;
  var _stateObj = null;
  var _stickTouch = null;
  var _stickCenter = null;
  var _buttonTouches = {};
  var _stickEl = null;
  var _stickZone = null;

  var STICK_RADIUS = 50;
  var MAX_AXIS = 32767;

  var BUTTONS = [
    [8,  'A',      'vgp-a'],
    [0,  'B',      'vgp-b'],
    [3,  'Start',  'vgp-start'],
    [9,  'L',      'vgp-l'],
    [10, 'R',      'vgp-r'],
    [11, 'Z',      'vgp-z'],
    [4,  '\u25B2', 'vgp-du'],
    [5,  '\u25BC', 'vgp-dd'],
    [6,  '\u25C0', 'vgp-dl'],
    [7,  '\u25B6', 'vgp-dr'],
    [23, 'CU',     'vgp-cu'],
    [22, 'CD',     'vgp-cd'],
    [21, 'CL',     'vgp-cl'],
    [20, 'CR',     'vgp-cr'],
  ];

  function createOverlay() {
    _overlay = document.createElement('div');
    _overlay.id = 'virtual-gamepad';
    _overlay.innerHTML = [
      '<style>',

      // ── Container: in-flow flex child ──
      '#virtual-gamepad {',
      '  width: 100%; order: 5;',
      '  position: relative;',
      '  flex: 0 0 auto;',
      '  pointer-events: none;',
      '  user-select: none; -webkit-user-select: none;',
      '  touch-action: none;',
      '}',
      '#virtual-gamepad * { pointer-events: auto; }',

      // ── Portrait: controls below video ──
      // Two-row grid: top row = stick + buttons, bottom row = dpad + start
      '#virtual-gamepad {',
      '  display: grid;',
      '  grid-template-columns: 1fr 1fr;',
      '  grid-template-rows: auto auto;',
      '  grid-template-areas: "left-top right-top" "left-bot right-bot";',
      '  padding: 4px 8px;',
      '  gap: 0;',
      '}',

      // Left column: stick zone + dpad
      '.vgp-left { grid-area: left-top / left-top / left-bot / left-bot; position: relative; min-height: 160px; }',
      // Right column: buttons
      '.vgp-right { grid-area: right-top / right-top / right-bot / right-bot; position: relative; min-height: 160px; }',
      // Shoulders bar across top
      '.vgp-shoulders { grid-column: 1 / -1; display: flex; justify-content: space-between; padding: 2px 4px; }',
      // Start bar across bottom
      '.vgp-center { grid-column: 1 / -1; display: flex; justify-content: center; padding: 4px 0; }',

      // ── Shared button styles ──
      '.vgp-btn {',
      '  display: inline-flex; align-items: center; justify-content: center;',
      '  border-radius: 50%; background: rgba(255,255,255,0.18);',
      '  color: rgba(255,255,255,0.75); font-weight: bold; font-family: sans-serif;',
      '  border: 2px solid rgba(255,255,255,0.3);',
      '  touch-action: none; -webkit-tap-highlight-color: transparent;',
      '  position: absolute;',
      '}',
      '.vgp-btn.active { background: rgba(255,255,255,0.4); }',

      // Shoulder buttons (in .vgp-shoulders flow, not absolute)
      '.vgp-l, .vgp-r, .vgp-z { position: static; border-radius: 8px; padding: 4px 12px; font-size: 13px; }',

      // Stick zone — inside .vgp-left, centered
      '.vgp-stick-zone {',
      '  position: absolute; left: 8px; top: 8px;',
      '  width: 120px; height: 120px; border-radius: 50%;',
      '  background: rgba(255,255,255,0.08); border: 2px solid rgba(255,255,255,0.15);',
      '}',
      '.vgp-stick-knob {',
      '  position: absolute; width: 48px; height: 48px; border-radius: 50%;',
      '  background: rgba(255,255,255,0.25); border: 2px solid rgba(255,255,255,0.4);',
      '  left: 50%; top: 50%; transform: translate(-50%,-50%);',
      '  transition: none; will-change: transform;',
      '}',

      // D-pad — inside .vgp-left, bottom area
      '.vgp-dpad { position: absolute; bottom: 0; left: 10px; width: 90px; height: 90px; }',
      '.vgp-du, .vgp-dd, .vgp-dl, .vgp-dr { border-radius: 6px; font-size: 11px; width: 28px; height: 28px; }',
      '.vgp-du { left: 31px; top: 0; }',
      '.vgp-dd { left: 31px; bottom: 0; top: auto; }',
      '.vgp-dl { left: 0; top: 31px; }',
      '.vgp-dr { right: 0; top: 31px; }',

      // A + B — inside .vgp-right
      '.vgp-a { width: 54px; height: 54px; right: 8px; top: 40px; font-size: 18px; }',
      '.vgp-b { width: 44px; height: 44px; right: 68px; top: 28px; font-size: 15px; }',

      // C-buttons diamond — inside .vgp-right
      '.vgp-cu { width: 34px; height: 34px; right: 130px; top: 10px; font-size: 10px; }',
      '.vgp-cd { width: 34px; height: 34px; right: 130px; top: 76px; font-size: 10px; }',
      '.vgp-cl { width: 34px; height: 34px; right: 164px; top: 43px; font-size: 10px; }',
      '.vgp-cr { width: 34px; height: 34px; right: 96px; top: 43px; font-size: 10px; }',

      // Start — in flow inside .vgp-center
      '.vgp-start { position: static; border-radius: 14px; padding: 4px 16px; font-size: 11px; }',

      // ── Landscape overrides ──
      '@media (orientation: landscape) {',
      '  #virtual-gamepad {',
      '    position: fixed; top: 0; left: 0; right: 0; bottom: 0;',
      '    display: block; padding: 0; min-height: 0;',
      '    z-index: 55;',
      '  }',
      '  .vgp-left, .vgp-right { position: fixed; top: 0; bottom: 78px; }',
      '  .vgp-left { left: 0; width: 180px; }',
      '  .vgp-right { right: 0; width: 220px; }',
      '  .vgp-shoulders { position: fixed; top: 4px; left: 0; right: 0; padding: 0 8px; z-index: 56; }',
      '  .vgp-center { position: fixed; bottom: 78px; left: 50%; transform: translateX(-50%); z-index: 56; }',
      '  .vgp-stick-zone { left: 8px; top: 50%; transform: translateY(-50%); width: 110px; height: 110px; }',
      '  .vgp-stick-knob { width: 44px; height: 44px; }',
      '  .vgp-dpad { bottom: 8px; left: 8px; }',
      '  .vgp-a { right: 12px; top: 35%; }',
      '  .vgp-b { right: 72px; top: 25%; }',
      '  .vgp-cu { right: 140px; top: 15%; }',
      '  .vgp-cd { right: 140px; top: 60%; }',
      '  .vgp-cl { right: 174px; top: 38%; }',
      '  .vgp-cr { right: 106px; top: 38%; }',
      '}',

      '</style>',

      // Structural containers
      '<div class="vgp-shoulders"></div>',
      '<div class="vgp-left">',
      '  <div class="vgp-stick-zone"></div>',
      '  <div class="vgp-dpad"></div>',
      '</div>',
      '<div class="vgp-right"></div>',
      '<div class="vgp-center"></div>',
    ].join('\n');

    // Place buttons in their containers
    var shouldersEl = _overlay.querySelector('.vgp-shoulders');
    var leftEl = _overlay.querySelector('.vgp-left');
    var rightEl = _overlay.querySelector('.vgp-right');
    var centerEl = _overlay.querySelector('.vgp-center');
    var dpadEl = _overlay.querySelector('.vgp-dpad');

    for (var i = 0; i < BUTTONS.length; i++) {
      var btn = document.createElement('div');
      btn.className = 'vgp-btn ' + BUTTONS[i][2];
      btn.textContent = BUTTONS[i][1];
      btn.dataset.idx = BUTTONS[i][0];

      var cls = BUTTONS[i][2];
      if (cls === 'vgp-l' || cls === 'vgp-r' || cls === 'vgp-z') {
        shouldersEl.appendChild(btn);
      } else if (cls === 'vgp-start') {
        centerEl.appendChild(btn);
      } else if (cls.indexOf('vgp-d') === 0) {
        dpadEl.appendChild(btn);
      } else if (cls === 'vgp-a' || cls === 'vgp-b' || cls.indexOf('vgp-c') === 0) {
        rightEl.appendChild(btn);
      }
    }

    // Reorder shoulders: L, Z on left, R on right
    var spacer = document.createElement('div');
    spacer.style.flex = '1';
    var rBtn = shouldersEl.querySelector('.vgp-r');
    if (rBtn) {
      shouldersEl.insertBefore(spacer, rBtn);
    }

    _stickZone = _overlay.querySelector('.vgp-stick-zone');
    _stickEl = document.createElement('div');
    _stickEl.className = 'vgp-stick-knob';
    _stickZone.appendChild(_stickEl);

    _overlay.addEventListener('touchstart', onTouchStart, { passive: false });
    _overlay.addEventListener('touchmove', onTouchMove, { passive: false });
    _overlay.addEventListener('touchend', onTouchEnd, { passive: false });
    _overlay.addEventListener('touchcancel', onTouchEnd, { passive: false });

    document.body.appendChild(_overlay);
  }

  function onTouchStart(e) {
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var el = document.elementFromPoint(t.clientX, t.clientY);

      if (el === _stickZone || el === _stickEl || (el && el.parentNode === _stickZone)) {
        _stickTouch = t.identifier;
        var rect = _stickZone.getBoundingClientRect();
        _stickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        updateStick(t.clientX, t.clientY);
        continue;
      }

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
      if (t.identifier === _stickTouch) {
        _stickTouch = null;
        _stickCenter = null;
        if (_stateObj) { _stateObj[16] = 0; _stateObj[17] = 0; _stateObj[18] = 0; _stateObj[19] = 0; }
        if (_stickEl) _stickEl.style.transform = 'translate(-50%, -50%)';
        continue;
      }
      var idx = _buttonTouches[t.identifier];
      if (idx !== undefined) {
        delete _buttonTouches[t.identifier];
        if (_stateObj) _stateObj[idx] = 0;
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
    if (dist > STICK_RADIUS) {
      dx = dx / dist * STICK_RADIUS;
      dy = dy / dist * STICK_RADIUS;
      dist = STICK_RADIUS;
    }
    if (_stickEl) {
      _stickEl.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
    }
    _stateObj[16] = dx > 0 ? Math.round((dx / STICK_RADIUS) * MAX_AXIS) : 0;
    _stateObj[17] = dx < 0 ? Math.round((-dx / STICK_RADIUS) * MAX_AXIS) : 0;
    _stateObj[18] = dy > 0 ? Math.round((dy / STICK_RADIUS) * MAX_AXIS) : 0;
    _stateObj[19] = dy < 0 ? Math.round((-dy / STICK_RADIUS) * MAX_AXIS) : 0;
  }

  function clearState() {
    if (!_stateObj) return;
    for (var k in _stateObj) {
      if (_stateObj.hasOwnProperty(k)) _stateObj[k] = 0;
    }
  }

  window.VirtualGamepad = {
    init: function (container, stateObj) {
      _stateObj = stateObj;
      createOverlay();
      // Shrink game to share space — gamepad is an in-flow sibling
      var gameEl = document.getElementById('game');
      if (gameEl) gameEl.style.margin = '0';
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
      _stickTouch = null;
      _stickCenter = null;
      _buttonTouches = {};
      var gameEl = document.getElementById('game');
      if (gameEl) { gameEl.style.margin = ''; }
      console.log('[virtual-gamepad] destroyed');
    },

    setVisible: function (visible) {
      if (_overlay) {
        _overlay.style.display = visible ? '' : 'none';
        if (!visible) clearState();
      }
      var gameEl = document.getElementById('game');
      if (gameEl) {
        gameEl.style.margin = visible ? '0' : 'auto 0';
      }
    },
  };
})();
