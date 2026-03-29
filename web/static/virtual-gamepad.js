// web/static/virtual-gamepad.js
// Standalone N64 virtual gamepad for mobile streaming (and lockstep) guests.
// Writes touch state into KNState.touchInput using EJS simulateInput indices.
//
// Layout strategy:
//   Portrait: in-flow grid child of <body>, sits between game area and toolbar.
//   Landscape: fixed overlay with flex-column panels on left/right.
//     Panels use flexbox with space-between so button groups CANNOT overlap
//     regardless of viewport height (Safari chrome, notch, any device).
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
  const DEADZONE = 0.12; // 12% of travel ignored (mimics N64 mechanical deadzone)
  const EDGE_EXPONENT = 1.3; // >1 = softer near center, steeper near edge (N64-like curve)

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
      '  grid-template-areas: "shoulders shoulders" "left right" "start start";',
      '  padding: 4px 16px;',
      '  gap: 0;',
      '}',

      // Shoulders bar — FIRST row, above everything
      '.vgp-shoulders { grid-area: shoulders; display: flex; justify-content: space-between; padding: 2px 8px; }',
      // Left column: flexbox so dpad and stick can never overlap
      '.vgp-left {',
      '  grid-area: left; display: flex; flex-direction: column;',
      '  align-items: flex-start; gap: 8px; padding: 4px 0;',
      '}',
      // Right column: flexbox so c-buttons and A/B can never overlap
      '.vgp-right {',
      '  grid-area: right; display: flex; flex-direction: column;',
      '  align-items: flex-end; gap: 8px; padding: 4px 0;',
      '}',
      // Start wrapper in portrait grid — last row, centered
      '.vgp-start-wrap { grid-area: start; }',

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

      // D-pad — flex child, scales with viewport height
      '.vgp-dpad { position: relative; width: clamp(68px, 15dvh, 96px); height: clamp(68px, 15dvh, 96px); flex-shrink: 1; }',
      // D-pad arrows: centered transforms so they scale with any container size
      '.vgp-du, .vgp-dd, .vgp-dl, .vgp-dr { border-radius: 6px; font-size: 13px; width: 34px; height: 34px; }',
      '.vgp-du { left: 50%; transform: translateX(-50%); top: 0; }',
      '.vgp-dd { left: 50%; transform: translateX(-50%); bottom: 0; top: auto; }',
      '.vgp-dl { left: 0; top: 50%; transform: translateY(-50%); }',
      '.vgp-dr { right: 0; top: 50%; transform: translateY(-50%); }',

      // Stick zone — flex child, scales with viewport height, extra top margin for spacing
      '.vgp-stick-zone {',
      '  position: relative; flex-shrink: 1; margin-top: 16px;',
      '  width: 110px; height: 110px; border-radius: 50%;',
      '  background: rgba(255,255,255,0.08); border: 2px solid rgba(255,255,255,0.15);',
      '}',
      '.vgp-stick-knob {',
      '  position: absolute; width: 46px; height: 46px; border-radius: 50%;',
      '  background: rgba(255,255,255,0.25); border: 2px solid rgba(255,255,255,0.4);',
      '  left: 50%; top: 50%; transform: translate(-50%,-50%);',
      '  transition: none; will-change: transform;',
      '}',

      // C-buttons diamond — inside .vgp-right, TOP area, pushed right
      // C-buttons: centered transforms for proper diamond at any container size
      '.vgp-cu { width: 38px; height: 38px; left: 50%; transform: translateX(-50%); top: 0; font-size: 11px; }',
      '.vgp-cd { width: 38px; height: 38px; left: 50%; transform: translateX(-50%); bottom: 0; top: auto; font-size: 11px; }',
      '.vgp-cl { width: 38px; height: 38px; left: 0; top: 50%; transform: translateY(-50%); font-size: 11px; }',
      '.vgp-cr { width: 38px; height: 38px; right: 0; left: auto; top: 50%; transform: translateY(-50%); font-size: 11px; }',

      // A + B — diagonal layout (Gameboy style: A lower-right, B upper-left)
      '.vgp-a { width: 66px; height: 66px; right: 14px; bottom: 8px; top: auto; font-size: 21px; }',
      '.vgp-b { width: 66px; height: 66px; right: 86px; bottom: 50px; top: auto; font-size: 21px; }',

      // Start button
      '.vgp-start { position: static; border-radius: 14px; padding: 6px 20px; font-size: 13px; }',

      // Sub-containers: flex children that scale with viewport height in portrait
      '.vgp-cbuttons { position: relative; width: clamp(86px, 18dvh, 120px); height: clamp(86px, 18dvh, 112px); flex-shrink: 1; }',
      '.vgp-ab { position: relative; width: clamp(110px, 24dvh, 160px); height: clamp(84px, 18dvh, 116px); flex-shrink: 1; }',
      '.vgp-spacer { display: none; pointer-events: none; }',
      // Portrait: Z sits at bottom of right column (near B/A), Start centered at bottom
      '.vgp-z-portrait { display: flex; justify-content: flex-start; width: 100%; padding-left: 4px; transform: translateY(-40px); }',
      '.vgp-start-portrait {',
      '  grid-area: start; display: flex; align-items: center; justify-content: center;',
      '  padding: 4px 0;',
      '}',
      // Landscape: Start+Z wrapper hidden in portrait
      '.vgp-start-landscape { display: none; }',

      // Portrait responsive: scale sizes with min(vw, dvh) on small phones.
      // Centered transforms handle positioning — only sizes need scaling.
      '@media (orientation: portrait) and (max-width: 430px) {',
      '  .vgp-dpad { width: clamp(68px, 15dvh, 96px); height: clamp(68px, 15dvh, 96px); }',
      '  .vgp-du, .vgp-dd, .vgp-dl, .vgp-dr { width: clamp(24px, 5dvh, 34px); height: clamp(24px, 5dvh, 34px); }',
      '  .vgp-stick-zone { width: clamp(80px, 16dvh, 110px); height: clamp(80px, 16dvh, 110px); }',
      '  .vgp-stick-knob { width: clamp(34px, 7dvh, 46px); height: clamp(34px, 7dvh, 46px); }',
      '  .vgp-cbuttons { width: clamp(76px, 16dvh, 120px); height: clamp(76px, 16dvh, 112px); }',
      '  .vgp-cu, .vgp-cd, .vgp-cl, .vgp-cr { width: clamp(24px, 5dvh, 38px); height: clamp(24px, 5dvh, 38px); }',
      '  .vgp-ab { width: clamp(100px, 22dvh, 160px); height: clamp(76px, 16dvh, 116px); }',
      '  .vgp-a, .vgp-b { width: clamp(40px, 9dvh, 66px); height: clamp(40px, 9dvh, 66px); font-size: clamp(14px, 3dvh, 21px); }',
      '}',

      // Tablet portrait: more inward padding
      '@media (orientation: portrait) and (min-width: 600px) {',
      '  #virtual-gamepad { padding: 8px 32px; }',
      '}',

      // ── Landscape: coordinated responsive layout system ──
      // All dimensions derive from CSS custom properties that scale with
      // viewport height. Panel widths derive from their content sizes.
      // Game canvas gets ALL remaining space. Nothing can overlap because:
      //   1. Buttons scale via clamp(min, preferred, max)
      //   2. Panel widths = content width (auto-coordinated)
      //   3. Game max-width = viewport - panels (auto-coordinated)
      //   4. Flex + spacer prevents vertical overlap
      '@media (orientation: landscape) {',

      // ── Design tokens on :root so both #game and #virtual-gamepad can use them ──
      '  :root {',
      '    --btn-ab: clamp(32px, 17dvh, 66px);',
      '    --btn-c: clamp(20px, 10dvh, 38px);',
      '    --btn-dpad: clamp(18px, 9dvh, 34px);',
      '    --dpad-size: calc(var(--btn-dpad) * 3);',
      '    --stick-size: calc(var(--btn-ab) * 1.7);',
      '    --knob-size: calc(var(--btn-ab) * 0.7);',
      '    --c-group: calc(var(--btn-c) * 3);',
      '    --ab-group-w: calc(var(--btn-ab) * 2.4);',
      '    --ab-group-h: calc(var(--btn-ab) * 1.5);',
      '    --gap: clamp(2px, 2dvh, 12px);',
      '    --shoulder-h: calc(clamp(11px, 3.5dvh, 14px) + clamp(4px, 1.5dvh, 6px) * 2 + 8px);',
      '    --spacer-pref: calc(var(--shoulder-h) + 4px);',
      '    --pad-l: clamp(16px, 5vw, 32px);',
      // Panel widths derived from content
      '    --panel-l: calc(var(--stick-size) + var(--pad-l) + 20px);',
      '    --panel-r: calc(max(var(--ab-group-w), var(--c-group)) + 30px);',
      '    --offset-l: max(24px, env(safe-area-inset-left, 0px));',
      '    --offset-r: max(24px, env(safe-area-inset-right, 0px));',
      '  }',

      // Container
      '  #virtual-gamepad {',
      '    position: fixed; top: 0; left: 0; right: 0; bottom: 0;',
      '    display: block; padding: 0; min-height: 0;',
      '    z-index: 55;',
      '  }',

      // Game canvas: gets ALL space between panels. 4:3 preserved by object-fit.
      '  #game {',
      '    max-width: calc(100vw - var(--panel-l) - var(--panel-r) - var(--offset-l) - var(--offset-r)) !important;',
      '    width: auto !important;',
      '    margin: auto !important;',
      '  }',

      // Panels: flex columns, width from design tokens
      '  .vgp-left, .vgp-right {',
      '    position: fixed; top: 0; bottom: 52px;',
      '    display: flex; flex-direction: column;',
      '    align-items: center; padding: 0 0 4px 0;',
      '  }',
      '  .vgp-left { left: var(--offset-l); width: var(--panel-l); align-items: flex-start; padding-left: var(--pad-l); }',
      '  .vgp-right { right: var(--offset-r); width: var(--panel-r); align-items: flex-end; padding-right: 14px; }',

      // Shoulders — top of screen
      '  .vgp-shoulders { position: fixed; top: 4px; left: 0; right: 0;',
      '    padding: 0 calc(var(--offset-r) + 4px) 0 calc(var(--offset-l) + 4px);',
      '    z-index: 56; }',
      '  .vgp-l, .vgp-r, .vgp-z { padding: clamp(4px, 1.5dvh, 6px) clamp(10px, 3dvh, 16px); font-size: clamp(11px, 3.5dvh, 14px); }',

      // Start — flex child between C-buttons and A/B
      '  .vgp-start-portrait { display: none; }',
      '  .vgp-z-portrait { display: none; }',
      '  .vgp-start-landscape { display: flex; justify-content: center; gap: 8px; flex-shrink: 5; }',
      '  .vgp-start { padding: clamp(4px, 1.5dvh, 6px) clamp(14px, 4dvh, 20px); font-size: clamp(10px, 3dvh, 13px); }',

      // Spacer: preferred height clears shoulders, collapses on tight viewports.
      // flex-shrink:10 means spacer absorbs compression first before groups shrink.
      '  .vgp-spacer { display: block; flex: 1 10 var(--spacer-pref); min-height: 0; }',

      // D-pad — flex-shrink:1 so it can compress slightly on very short screens
      '  .vgp-dpad {',
      '    position: relative; top: auto; left: auto; bottom: auto; flex-shrink: 0;',
      '    width: var(--dpad-size); height: var(--dpad-size);',
      '    margin-bottom: var(--gap);',
      '  }',
      '  .vgp-du, .vgp-dd, .vgp-dl, .vgp-dr {',
      '    width: var(--btn-dpad); height: var(--btn-dpad);',
      '    font-size: clamp(10px, 3dvh, 13px);',
      '  }',
      // D-pad uses centered transforms — stays symmetric at any container size
      '  .vgp-du { left: 50%; transform: translateX(-50%); top: 0; }',
      '  .vgp-dd { left: 50%; transform: translateX(-50%); bottom: 0; top: auto; }',
      '  .vgp-dl { left: 0; top: 50%; transform: translateY(-50%); }',
      '  .vgp-dr { right: 0; top: 50%; transform: translateY(-50%); }',

      // Stick
      '  .vgp-stick-zone { position: relative; left: auto; bottom: auto; top: auto; transform: none;',
      '    flex-shrink: 0; width: var(--stick-size); height: var(--stick-size); }',
      '  .vgp-stick-knob { width: var(--knob-size); height: var(--knob-size); }',

      // C-buttons diamond — uses centered transforms for perfect symmetry at any size
      '  .vgp-cbuttons {',
      '    display: block; position: relative; flex-shrink: 0;',
      '    width: var(--c-group); height: var(--c-group);',
      '    margin-bottom: var(--gap);',
      '  }',
      '  .vgp-cu, .vgp-cd, .vgp-cl, .vgp-cr {',
      '    width: var(--btn-c); height: var(--btn-c);',
      '    font-size: clamp(9px, 2.5dvh, 11px);',
      '  }',
      '  .vgp-cu { left: 50%; transform: translateX(-50%); top: 0; right: auto; }',
      '  .vgp-cd { left: 50%; transform: translateX(-50%); bottom: 0; top: auto; right: auto; }',
      '  .vgp-cl { top: 50%; transform: translateY(-50%); left: 0; right: auto; }',
      '  .vgp-cr { top: 50%; transform: translateY(-50%); right: 0; left: auto; }',

      // A/B — flex-shrink:1 so group compresses on very short screens
      '  .vgp-ab {',
      '    display: block; position: relative; flex-shrink: 0;',
      '    width: var(--ab-group-w); height: var(--ab-group-h);',
      '  }',
      '  .vgp-a {',
      '    width: var(--btn-ab); height: var(--btn-ab);',
      '    right: 0; bottom: 0; top: auto; font-size: clamp(15px, 5dvh, 21px);',
      '  }',
      '  .vgp-b {',
      '    width: var(--btn-ab); height: var(--btn-ab);',
      '    right: 55%; bottom: 30%; top: auto; font-size: clamp(15px, 5dvh, 21px);',
      '  }',
      '}',

      // Very short landscape viewports: dissolve the shoulder bar and position
      // L/R/Z individually at the top of each panel area. Saves vertical space
      // because the spacer only needs to clear the small buttons, not a full bar.
      '@media (orientation: landscape) and (max-height: 300px) {',
      '  .vgp-shoulders { display: contents; }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      // L on the left, R on the right (Z is next to Start, not in shoulders)
      '  .vgp-l { position: fixed !important; top: 2px; left: var(--offset-l); z-index: 56; padding: 3px 8px !important; font-size: 10px !important; }',
      '  .vgp-r { position: fixed !important; top: 2px; right: var(--offset-r); z-index: 56; padding: 3px 8px !important; font-size: 10px !important; }',
      '}',

      '</style>',

      // Structural containers
      '<div class="vgp-shoulders"></div>',
      '<div class="vgp-left">',
      '  <div class="vgp-spacer"></div>',
      '  <div class="vgp-dpad"></div>',
      '  <div class="vgp-stick-zone"></div>',
      '</div>',
      '<div class="vgp-right">',
      '  <div class="vgp-spacer"></div>',
      '  <div class="vgp-cbuttons"></div>',
      '  <div class="vgp-start-landscape"></div>',
      '  <div class="vgp-ab"></div>',
      '  <div class="vgp-z-portrait"></div>',
      '</div>',
      '<div class="vgp-start-portrait"></div>',
    ].join('\n');

    // Place buttons in their containers
    const shouldersEl = _overlay.querySelector('.vgp-shoulders');
    const startPortraitEl = _overlay.querySelector('.vgp-start-portrait');
    const startLandscapeEl = _overlay.querySelector('.vgp-start-landscape');
    const zPortraitEl = _overlay.querySelector('.vgp-z-portrait');
    const dpadEl = _overlay.querySelector('.vgp-dpad');
    const cbuttonsEl = _overlay.querySelector('.vgp-cbuttons');
    const abEl = _overlay.querySelector('.vgp-ab');

    for (const [idx, label, cls] of BUTTONS) {
      const btn = document.createElement('div');
      btn.className = `vgp-btn ${cls}`;
      btn.textContent = label;
      btn.dataset.idx = idx;

      if (cls === 'vgp-l' || cls === 'vgp-r') {
        shouldersEl.appendChild(btn);
      } else if (cls === 'vgp-z') {
        // Portrait: Z in right column below AB (near B). Landscape: Z left of Start (prepend).
        zPortraitEl.appendChild(btn);
        const zClone = btn.cloneNode(true);
        startLandscapeEl.prepend(zClone);
      } else if (cls === 'vgp-start') {
        // Start in both portrait and landscape containers (after Z so Z is on the left)
        startPortraitEl.appendChild(btn);
        const clone = btn.cloneNode(true);
        startLandscapeEl.appendChild(clone);
      } else if (cls.startsWith('vgp-d')) {
        dpadEl.appendChild(btn);
      } else if (cls === 'vgp-a' || cls === 'vgp-b') {
        abEl.appendChild(btn);
      } else if (cls.startsWith('vgp-c')) {
        cbuttonsEl.appendChild(btn);
      }
    }

    // Reorder shoulders: L on left — spacer — R on right (Z is now next to Start)
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
    // N64-style analog: deadzone + non-linear response curve.
    // Normalized magnitude 0–1, then apply deadzone and power curve.
    const mag = dist / STICK_RADIUS; // 0 to 1
    let output = 0;
    if (mag > DEADZONE) {
      // Remap deadzone–1 range to 0–1, then apply power curve
      const remapped = (mag - DEADZONE) / (1 - DEADZONE);
      output = Math.pow(remapped, EDGE_EXPONENT);
    }
    // Convert back to directional axis values
    if (dist > 0.001) {
      const ax = (dx / dist) * output * MAX_AXIS;
      const ay = (dy / dist) * output * MAX_AXIS;
      st[16] = ax > 0 ? Math.round(ax) : 0;
      st[17] = ax < 0 ? Math.round(-ax) : 0;
      st[18] = ay > 0 ? Math.round(ay) : 0;
      st[19] = ay < 0 ? Math.round(-ay) : 0;
    } else {
      st[16] = 0;
      st[17] = 0;
      st[18] = 0;
      st[19] = 0;
    }
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
