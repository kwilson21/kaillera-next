// web/static/virtual-gamepad.js
// Standalone N64 virtual gamepad for mobile streaming (and lockstep) guests.
// Writes touch state into KNState.touchInput using EJS simulateInput indices.
//
// Layout strategy: the gamepad is an IN-FLOW flex child of <body> using CSS
// order to sit between the game area and toolbar. No position:fixed — all
// elements share the viewport via flexbox without overlapping.
(function () {
  'use strict';

  let _overlay = null;
  // Use KNState.touchInput as the canonical touch state object.
  // Both VirtualGamepad and netplay engines read/write this directly —
  // no fragile shared-reference passing.
  const _state = () => window.KNState?.touchInput;
  let _stickTouch = null;
  let _stickCenter = null;
  let _buttonTouches = {};
  let _stickEl = null;
  let _stickZone = null;

  const STICK_RADIUS = 50;
  const MAX_AXIS = 32767;

  // N64 button mapping (verified from mupen64plus core source):
  // N64 A = JOYPAD_B = index 0, N64 B = JOYPAD_Y = index 1
  // Z = JOYPAD_L2 = index 12, L = JOYPAD_L = index 10, R = JOYPAD_R = index 11
  const BUTTONS = [
    [0, 'A', 'vgp-a'],
    [1, 'B', 'vgp-b'],
    [3, 'Start', 'vgp-start'],
    [10, 'L', 'vgp-l'],
    [11, 'R', 'vgp-r'],
    [12, 'Z', 'vgp-z'],
    [4, '\u25B2', 'vgp-du'],
    [5, '\u25BC', 'vgp-dd'],
    [6, '\u25C0\uFE0E', 'vgp-dl'],
    [7, '\u25B6\uFE0E', 'vgp-dr'],
    [23, 'CU', 'vgp-cu'],
    [22, 'CD', 'vgp-cd'],
    [21, 'CL', 'vgp-cl'],
    [20, 'CR', 'vgp-cr'],
  ];

  const createOverlay = () => {
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
      // 3-row grid: shoulders on top, left+right content, start at bottom
      '#virtual-gamepad {',
      '  display: grid;',
      '  grid-template-columns: 1fr 1fr;',
      '  grid-template-rows: auto 1fr auto;',
      '  grid-template-areas: "shoulders shoulders" "left right" "center center";',
      '  padding: 4px 8px;',
      '  gap: 0;',
      '}',

      // Shoulders bar — FIRST row, above everything
      '.vgp-shoulders { grid-area: shoulders; display: flex; justify-content: space-between; padding: 2px 4px; }',
      // Left column: dpad on top, stick below
      '.vgp-left { grid-area: left; position: relative; min-height: 230px; }',
      // Right column: c-buttons on top, A/B below
      '.vgp-right { grid-area: right; position: relative; min-height: 210px; }',
      // Start bar — LAST row
      '.vgp-center { grid-area: center; display: flex; justify-content: center; padding: 4px 0; }',

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
      '.vgp-l, .vgp-r, .vgp-z { position: static; border-radius: 8px; padding: 6px 16px; font-size: 14px; }',

      // D-pad — inside .vgp-left, TOP area (above stick)
      '.vgp-dpad { position: absolute; top: 4px; left: 10px; width: 96px; height: 96px; }',
      '.vgp-du, .vgp-dd, .vgp-dl, .vgp-dr { border-radius: 6px; font-size: 13px; width: 34px; height: 34px; }',
      '.vgp-du { left: 28px; top: 0; }',
      '.vgp-dd { left: 28px; bottom: 0; top: auto; }',
      '.vgp-dl { left: 0; top: 28px; }',
      '.vgp-dr { right: 0; top: 28px; }',

      // Stick zone — inside .vgp-left, BELOW dpad
      '.vgp-stick-zone {',
      '  position: absolute; left: 8px; bottom: 4px;',
      '  width: 110px; height: 110px; border-radius: 50%;',
      '  background: rgba(255,255,255,0.08); border: 2px solid rgba(255,255,255,0.15);',
      '}',
      '.vgp-stick-knob {',
      '  position: absolute; width: 46px; height: 46px; border-radius: 50%;',
      '  background: rgba(255,255,255,0.25); border: 2px solid rgba(255,255,255,0.4);',
      '  left: 50%; top: 50%; transform: translate(-50%,-50%);',
      '  transition: none; will-change: transform;',
      '}',

      // C-buttons diamond — inside .vgp-right, TOP area
      '.vgp-cu { width: 38px; height: 38px; left: 30px; top: 4px; font-size: 11px; }',
      '.vgp-cd { width: 38px; height: 38px; left: 30px; top: 74px; font-size: 11px; }',
      '.vgp-cl { width: 38px; height: 38px; left: 0; top: 39px; font-size: 11px; }',
      '.vgp-cr { width: 38px; height: 38px; left: 64px; top: 39px; font-size: 11px; }',

      // A + B — same size, inside .vgp-right, BELOW C-buttons
      '.vgp-a { width: 52px; height: 52px; right: 8px; bottom: 8px; top: auto; font-size: 17px; }',
      '.vgp-b { width: 52px; height: 52px; right: 66px; bottom: 8px; top: auto; font-size: 17px; }',

      // Start — in flow inside .vgp-center
      '.vgp-start { position: static; border-radius: 14px; padding: 6px 20px; font-size: 13px; }',

      // ── Landscape overrides ──
      '@media (orientation: landscape) {',
      '  #virtual-gamepad {',
      '    position: fixed; top: 0; left: 0; right: 0; bottom: 0;',
      '    display: block; padding: 0; min-height: 0;',
      '    z-index: 55;',
      '  }',
      '  .vgp-left, .vgp-right { position: fixed; top: 0; bottom: 78px; }',
      '  .vgp-left { left: 0; width: 160px; }',
      '  .vgp-right { right: 0; width: 200px; }',
      // L/R/Z shifted down from top edge (user feedback: not at very top)
      '  .vgp-shoulders { position: fixed; top: 20px; left: 0; right: 0; padding: 0 8px; z-index: 56; }',
      // Start on right side, above A/B with gap
      '  .vgp-center { position: fixed; bottom: 80px; right: 80px; left: auto; transform: none; z-index: 56; }',
      // Dpad at top of left panel (below shoulders)
      '  .vgp-dpad { top: 30px; left: 8px; bottom: auto; }',
      // Stick below dpad in left panel
      '  .vgp-stick-zone { left: 8px; bottom: 4px; top: auto; transform: none; width: 100px; height: 100px; }',
      '  .vgp-stick-knob { width: 42px; height: 42px; }',
      // C-buttons — right side, below shoulders (top:50px clears R/Z at top:20px+30px)
      '  .vgp-cu { right: 60px; left: auto; top: 55px; }',
      '  .vgp-cd { right: 60px; left: auto; top: 120px; }',
      '  .vgp-cl { right: 94px; left: auto; top: 88px; }',
      '  .vgp-cr { right: 26px; left: auto; top: 88px; }',
      // A/B bottom-right, same size, with gap above Start
      '  .vgp-a { right: 12px; bottom: 40px; top: auto; }',
      '  .vgp-b { right: 70px; bottom: 40px; top: auto; }',
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
    const shouldersEl = _overlay.querySelector('.vgp-shoulders');
    const leftEl = _overlay.querySelector('.vgp-left');
    const rightEl = _overlay.querySelector('.vgp-right');
    const centerEl = _overlay.querySelector('.vgp-center');
    const dpadEl = _overlay.querySelector('.vgp-dpad');

    for (const [idx, label, cls] of BUTTONS) {
      const btn = document.createElement('div');
      btn.className = `vgp-btn ${cls}`;
      btn.textContent = label;
      btn.dataset.idx = idx;

      if (cls === 'vgp-l' || cls === 'vgp-r' || cls === 'vgp-z') {
        shouldersEl.appendChild(btn);
      } else if (cls === 'vgp-start') {
        centerEl.appendChild(btn);
      } else if (cls.startsWith('vgp-d')) {
        dpadEl.appendChild(btn);
      } else if (cls === 'vgp-a' || cls === 'vgp-b' || cls.startsWith('vgp-c')) {
        rightEl.appendChild(btn);
      }
    }

    // Reorder shoulders: L, Z on left, R on right
    const spacer = document.createElement('div');
    spacer.style.flex = '1';
    const rBtn = shouldersEl.querySelector('.vgp-r');
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
  };

  const onTouchStart = (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const el = document.elementFromPoint(t.clientX, t.clientY);

      if (el === _stickZone || el === _stickEl || el?.parentNode === _stickZone) {
        _stickTouch = t.identifier;
        const rect = _stickZone.getBoundingClientRect();
        _stickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        updateStick(t.clientX, t.clientY);
        continue;
      }

      const btnEl = el?.closest?.('.vgp-btn') ?? (el?.classList?.contains('vgp-btn') ? el : null);
      if (btnEl && btnEl.dataset.idx !== undefined) {
        const idx = parseInt(btnEl.dataset.idx, 10);
        _buttonTouches[t.identifier] = idx;
        btnEl.classList.add('active');
        const s = _state();
        if (s) s[idx] = 1;
      }
    }
  };

  const onTouchMove = (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === _stickTouch && _stickCenter) {
        updateStick(t.clientX, t.clientY);
      }
    }
  };

  const onTouchEnd = (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === _stickTouch) {
        _stickTouch = null;
        _stickCenter = null;
        const s = _state();
        if (s) {
          s[16] = 0;
          s[17] = 0;
          s[18] = 0;
          s[19] = 0;
        }
        if (_stickEl) _stickEl.style.transform = 'translate(-50%, -50%)';
        continue;
      }
      const idx = _buttonTouches[t.identifier];
      if (idx !== undefined) {
        delete _buttonTouches[t.identifier];
        const s = _state();
        if (s) s[idx] = 0;
        const btns = _overlay.querySelectorAll(`.vgp-btn[data-idx="${idx}"]`);
        for (const b of btns) b.classList.remove('active');
      }
    }
  };

  const updateStick = (clientX, clientY) => {
    const st = _state();
    if (!_stickCenter || !st) return;
    let dx = clientX - _stickCenter.x;
    let dy = clientY - _stickCenter.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > STICK_RADIUS) {
      dx = (dx / dist) * STICK_RADIUS;
      dy = (dy / dist) * STICK_RADIUS;
    }
    if (_stickEl) {
      _stickEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    }
    st[16] = dx > 0 ? Math.round((dx / STICK_RADIUS) * MAX_AXIS) : 0;
    st[17] = dx < 0 ? Math.round((-dx / STICK_RADIUS) * MAX_AXIS) : 0;
    st[18] = dy > 0 ? Math.round((dy / STICK_RADIUS) * MAX_AXIS) : 0;
    st[19] = dy < 0 ? Math.round((-dy / STICK_RADIUS) * MAX_AXIS) : 0;
  };

  const clearState = () => {
    const st = _state();
    if (!st) return;
    for (const k of Object.keys(st)) {
      st[k] = 0;
    }
  };

  window.VirtualGamepad = {
    init: () => {
      createOverlay();
      // Shrink game to share space — gamepad is an in-flow sibling
      const gameEl = document.getElementById('game');
      if (gameEl) gameEl.style.margin = '0';
      console.log('[virtual-gamepad] initialized');
    },

    destroy: () => {
      if (_overlay) {
        _overlay.removeEventListener('touchstart', onTouchStart);
        _overlay.removeEventListener('touchmove', onTouchMove);
        _overlay.removeEventListener('touchend', onTouchEnd);
        _overlay.removeEventListener('touchcancel', onTouchEnd);
        _overlay.parentNode?.removeChild(_overlay);
        _overlay = null;
      }
      clearState();
      _stickTouch = null;
      _stickCenter = null;
      _buttonTouches = {};
      const gameEl = document.getElementById('game');
      if (gameEl) {
        gameEl.style.margin = '';
      }
      console.log('[virtual-gamepad] destroyed');
    },

    setVisible: (visible) => {
      if (_overlay) {
        _overlay.style.display = visible ? '' : 'none';
        if (!visible) clearState();
      }
      const gameEl = document.getElementById('game');
      if (gameEl) {
        gameEl.style.margin = visible ? '0' : 'auto 0';
      }
    },
  };
})();
