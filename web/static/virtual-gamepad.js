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

      '.vgp-stick-zone{position:absolute;left:20px;top:50%;transform:translateY(-65%);',
      '  width:130px;height:130px;border-radius:50%;background:rgba(255,255,255,0.08);',
      '  border:2px solid rgba(255,255,255,0.15);}',
      '.vgp-stick-knob{position:absolute;width:50px;height:50px;border-radius:50%;',
      '  background:rgba(255,255,255,0.25);border:2px solid rgba(255,255,255,0.4);',
      '  left:50%;top:50%;transform:translate(-50%,-50%);transition:none;will-change:transform;}',

      '.vgp-a{width:56px;height:56px;right:30px;bottom:28%;font-size:18px;}',
      '.vgp-b{width:48px;height:48px;right:95px;bottom:22%;font-size:16px;}',

      '.vgp-cu{width:38px;height:38px;right:180px;bottom:42%;font-size:11px;}',
      '.vgp-cd{width:38px;height:38px;right:180px;bottom:18%;font-size:11px;}',
      '.vgp-cl{width:38px;height:38px;right:218px;bottom:30%;font-size:11px;}',
      '.vgp-cr{width:38px;height:38px;right:142px;bottom:30%;font-size:11px;}',

      '.vgp-du{width:34px;height:34px;left:60px;bottom:12%;font-size:11px;border-radius:6px;}',
      '.vgp-dd{width:34px;height:34px;left:60px;bottom:0%;font-size:11px;border-radius:6px;}',
      '.vgp-dl{width:34px;height:34px;left:30px;bottom:6%;font-size:11px;border-radius:6px;}',
      '.vgp-dr{width:34px;height:34px;left:90px;bottom:6%;font-size:11px;border-radius:6px;}',

      '.vgp-start{width:50px;height:28px;left:50%;bottom:5%;transform:translateX(-50%);',
      '  border-radius:14px;font-size:11px;}',

      '.vgp-l{width:50px;height:30px;left:10px;top:8px;border-radius:8px;font-size:13px;}',
      '.vgp-r{width:50px;height:30px;right:10px;top:8px;border-radius:8px;font-size:13px;}',
      '.vgp-z{width:50px;height:30px;left:10px;top:46px;border-radius:8px;font-size:13px;}',

      '</style>',
      '<div class="vgp-stick-zone"></div>',
    ].join('\n');

    for (var i = 0; i < BUTTONS.length; i++) {
      var btn = document.createElement('div');
      btn.className = 'vgp-btn ' + BUTTONS[i][2];
      btn.textContent = BUTTONS[i][1];
      btn.dataset.idx = BUTTONS[i][0];
      _overlay.appendChild(btn);
    }

    _stickZone = _overlay.querySelector('.vgp-stick-zone');
    _stickEl = document.createElement('div');
    _stickEl.className = 'vgp-stick-knob';
    _stickZone.appendChild(_stickEl);

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
        if (_stateObj) {
          _stateObj[16] = 0;
          _stateObj[17] = 0;
          _stateObj[18] = 0;
          _stateObj[19] = 0;
        }
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
      var gameEl = document.getElementById('game');
      if (gameEl) {
        gameEl.style.margin = visible ? '0' : 'auto 0';
      }
    },
  };
})();
