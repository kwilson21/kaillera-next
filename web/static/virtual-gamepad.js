// web/static/virtual-gamepad.js
// Standalone N64 virtual gamepad for mobile players (lockstep and streaming).
// Not shown for spectators. Writes touch state into KNState.touchInput using
// EJS simulateInput indices.
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
  let _cachedBtns = null;

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
      '  padding: 2px 8px;',
      '  gap: 0;',
      '}',

      // Shoulders bar — FIRST row, above everything
      '.vgp-shoulders { grid-area: shoulders; display: flex; justify-content: space-between; padding: 2px 8px; }',
      // Left column: flexbox so dpad and stick can never overlap
      '.vgp-left {',
      '  grid-area: left; display: flex; flex-direction: column;',
      '  align-items: flex-start; gap: 2px; padding: 4px 0 2px;',
      '}',
      // Right column: flexbox so c-buttons and A/B can never overlap
      '.vgp-right {',
      '  grid-area: right; display: flex; flex-direction: column;',
      '  align-items: flex-end; gap: 2px; padding: 4px 0 2px;',
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
      '.vgp-dpad { position: relative; width: clamp(68px, 15svh, 96px); height: clamp(68px, 15svh, 96px); flex-shrink: 1; }',
      // D-pad arrows: centered transforms so they scale with any container size
      '.vgp-du, .vgp-dd, .vgp-dl, .vgp-dr { border-radius: 6px; font-size: 13px; width: 34px; height: 34px; }',
      '.vgp-du { left: 50%; transform: translateX(-50%); top: 0; }',
      '.vgp-dd { left: 50%; transform: translateX(-50%); bottom: 0; top: auto; }',
      '.vgp-dl { left: 0; top: 50%; transform: translateY(-50%); }',
      '.vgp-dr { right: 0; top: 50%; transform: translateY(-50%); }',

      // Stick zone — flex child, scales with viewport height
      '.vgp-stick-zone {',
      '  position: relative; flex-shrink: 1; margin-top: 6px;',
      '  width: clamp(128px, 20svh, 164px); height: clamp(128px, 20svh, 164px); border-radius: 50%;',
      '  background: rgba(255,255,255,0.08); border: 2px solid rgba(255,255,255,0.15);',
      '}',
      '.vgp-stick-knob {',
      '  position: absolute; width: clamp(54px, 8svh, 68px); height: clamp(54px, 8svh, 68px); border-radius: 50%;',
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
      // Percentage positioning so the gap scales with the container at any size.
      '.vgp-a { width: 66px; height: 66px; right: 9%; bottom: 2%; top: auto; font-size: 21px; }',
      '.vgp-b { width: 66px; height: 66px; right: 54%; bottom: 38%; top: auto; font-size: 21px; }',

      // Start button
      '.vgp-start { position: static; border-radius: 14px; padding: 6px 20px; font-size: 13px; }',

      // Sub-containers: flex children that scale with viewport height in portrait
      '.vgp-cbuttons { position: relative; width: clamp(86px, 18svh, 120px); height: clamp(86px, 18svh, 112px); flex-shrink: 1; }',
      '.vgp-ab { position: relative; width: clamp(110px, 24svh, 160px); height: clamp(84px, 18svh, 116px); flex-shrink: 1; margin-top: 4px; }',
      '.vgp-spacer { display: none; pointer-events: none; }',
      // Portrait: Z sits at bottom of right column (near B/A), floats above Start area
      '.vgp-z-portrait { display: flex; justify-content: flex-start; width: 100%; padding-left: 4px; transform: translateY(-34px); pointer-events: none !important; }',
      '.vgp-start-portrait {',
      '  grid-area: start; display: flex; align-items: center; justify-content: center;',
      '  padding: 2px 0;',
      '}',
      // Landscape wrappers: hidden in portrait
      '.vgp-start-landscape { display: none; }',
      '.vgp-z-landscape { display: none; }',

      // Portrait responsive: scale sizes with min(vw, svh) on small phones.
      // Centered transforms handle positioning — only sizes need scaling.
      '@media (orientation: portrait) and (max-width: 430px) {',
      '  .vgp-dpad { width: clamp(68px, 15svh, 96px); height: clamp(68px, 15svh, 96px); }',
      '  .vgp-du, .vgp-dd, .vgp-dl, .vgp-dr { width: clamp(24px, 5svh, 34px); height: clamp(24px, 5svh, 34px); }',
      '  .vgp-stick-zone { width: clamp(90px, 18svh, 128px); height: clamp(90px, 18svh, 128px); }',
      '  .vgp-stick-knob { width: clamp(38px, 7.5svh, 54px); height: clamp(38px, 7.5svh, 54px); }',
      '  .vgp-cbuttons { width: clamp(76px, 16svh, 120px); height: clamp(76px, 16svh, 112px); }',
      '  .vgp-cu, .vgp-cd, .vgp-cl, .vgp-cr { width: clamp(24px, 5svh, 38px); height: clamp(24px, 5svh, 38px); }',
      '  .vgp-ab { width: clamp(100px, 22svh, 160px); height: clamp(76px, 16svh, 116px); }',
      '  .vgp-a, .vgp-b { width: clamp(40px, 9svh, 66px); height: clamp(40px, 9svh, 66px); font-size: clamp(14px, 3svh, 21px); }',
      '}',

      // Small portrait phones: narrow AND short (Moto G4, iPhone SE, iPhone 12 Mini, etc.)
      // Reduce element sizes further on tiny screens.
      '@media (orientation: portrait) and (max-width: 430px) and (max-height: 650px) {',
      '  .vgp-left, .vgp-right { padding-top: 2px; padding-bottom: 1px; gap: 1px; }',
      '  .vgp-stick-zone { width: clamp(76px, 14svh, 108px); height: clamp(76px, 14svh, 108px); }',
      '  .vgp-stick-knob { width: clamp(32px, 6svh, 45px); height: clamp(32px, 6svh, 45px); }',
      '  .vgp-dpad { width: clamp(60px, 12svh, 84px); height: clamp(60px, 12svh, 84px); }',
      '  .vgp-du, .vgp-dd, .vgp-dl, .vgp-dr { width: clamp(20px, 4svh, 28px); height: clamp(20px, 4svh, 28px); }',
      '  .vgp-ab { width: clamp(90px, 20svh, 140px); height: clamp(68px, 14svh, 100px); }',
      '  .vgp-a, .vgp-b { width: clamp(35px, 7.5svh, 56px); height: clamp(35px, 7.5svh, 56px); font-size: clamp(12px, 2.5svh, 18px); }',
      '  .vgp-cbuttons { width: clamp(68px, 13svh, 96px); height: clamp(68px, 13svh, 96px); }',
      '  .vgp-cu, .vgp-cd, .vgp-cl, .vgp-cr { width: clamp(22px, 4.5svh, 32px); height: clamp(22px, 4.5svh, 32px); }',
      '}',

      // Tablet portrait: more inward padding + larger stick + larger d-pad and face buttons
      '@media (orientation: portrait) and (min-width: 600px) {',
      '  #virtual-gamepad { padding: 8px 32px; }',
      '  .vgp-stick-zone { width: clamp(150px, 18svh, 200px); height: clamp(150px, 18svh, 200px); }',
      '  .vgp-stick-knob { width: clamp(62px, 7.5svh, 84px); height: clamp(62px, 7.5svh, 84px); }',
      '  .vgp-dpad { width: clamp(100px, 13svh, 160px); height: clamp(100px, 13svh, 160px); }',
      '  .vgp-du, .vgp-dd, .vgp-dl, .vgp-dr { width: clamp(35px, 4.5svh, 56px); height: clamp(35px, 4.5svh, 56px); }',
      '  .vgp-ab { width: clamp(150px, 26svh, 220px); height: clamp(116px, 20svh, 170px); }',
      '  .vgp-a, .vgp-b { width: clamp(64px, 11svh, 88px); height: clamp(64px, 11svh, 88px); font-size: clamp(22px, 4svh, 30px); }',
      '  .vgp-cbuttons { width: clamp(116px, 18svh, 168px); height: clamp(116px, 18svh, 168px); }',
      '  .vgp-cu, .vgp-cd, .vgp-cl, .vgp-cr { width: clamp(38px, 6svh, 56px); height: clamp(38px, 6svh, 56px); }',
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
      // ── Size tokens ──
      '    --btn-ab: clamp(32px, 17svh, 66px);',
      '    --btn-c: clamp(20px, 10svh, 38px);',
      '    --btn-dpad: clamp(18px, 9svh, 34px);',
      '    --dpad-size: calc(var(--btn-dpad) * 3);',
      '    --stick-size: calc(var(--btn-ab) * 1.7);',
      '    --knob-size: calc(var(--btn-ab) * 0.7);',
      '    --c-group: calc(var(--btn-c) * 3);',
      '    --ab-group-w: calc(var(--btn-ab) * 2.4);',
      '    --ab-group-h: calc(var(--btn-ab) * 1.5);',
      '    --gap: clamp(2px, 2svh, 12px);',
      '    --shoulder-h: calc(clamp(11px, 3.5svh, 14px) + clamp(4px, 1.5svh, 6px) * 2 + 8px);',
      '    --spacer-pref: calc(var(--shoulder-h) + 4px);',
      '    --pad-l: clamp(16px, 5vw, 32px);',
      // ── Layout tokens ──
      '    --panel-l: calc(var(--stick-size) + var(--pad-l) + 20px);',
      '    --panel-r: calc(max(var(--ab-group-w), var(--c-group)) + 30px);',
      '    --offset-l: max(clamp(24px, 4vw, 48px), env(safe-area-inset-left, 0px));',
      '    --offset-r: max(clamp(24px, 4vw, 48px), env(safe-area-inset-right, 0px));',
      // ── Position tokens (design-mode editable) ──
      '    --shoulders-top: clamp(4px, 1svh, 10px);',
      '    --shoulders-display: flex;',
      '    --l-position: static;',
      '    --l-top: auto;',
      '    --l-left: auto;',
      '    --l-right: auto;',
      '    --r-position: static;',
      '    --r-top: auto;',
      '    --r-right: auto;',
      '    --dpad-nudge-x: 0px;',
      '    --dpad-nudge-y: 0px;',
      '    --ab-nudge-x: 0px;',
      '    --ab-nudge-y: 0px;',
      '    --start-landscape-order: 0;',
      '    --z-landscape-order: 0;',
      '    --start-nudge-x: 0px;',
      '    --start-nudge-y: 0px;',
      '    --cbuttons-nudge-x: 0px;',
      '    --cbuttons-nudge-y: 0px;',
      '    --z-nudge-x: 0px;',
      '    --z-nudge-y: 0px;',
      '    --btn-l-size: clamp(11px, 3.5svh, 14px);',
      '    --btn-r-size: clamp(11px, 3.5svh, 14px);',
      '    --btn-z-size: clamp(11px, 3.5svh, 14px);',
      '    --btn-start-size: clamp(10px, 3svh, 13px);',
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
      '  .vgp-left { left: var(--offset-l); width: var(--panel-l); align-items: flex-start; padding: 0 0 0 var(--pad-l); }',
      '  .vgp-right { right: var(--offset-r); width: var(--panel-r); align-items: flex-end; padding: 0 14px 0 0; }',

      // Shoulders — positioned via tokens (design-mode can dissolve or reposition)
      '  .vgp-shoulders { position: fixed; top: var(--shoulders-top); left: 0; right: 0;',
      '    display: var(--shoulders-display); justify-content: space-between;',
      '    padding: 0 calc(var(--offset-r) + 4px) 0 calc(var(--offset-l) + 4px);',
      '    z-index: 56; }',
      '  .vgp-l { font-size: var(--btn-l-size); padding: 0.4em 1em; }',
      '  .vgp-r { font-size: var(--btn-r-size); padding: 0.4em 1em; }',
      '  .vgp-z { font-size: var(--btn-z-size); padding: 0.4em 1em; }',
      '  .vgp-l { position: var(--l-position) !important; top: var(--l-top); left: var(--l-left); right: var(--l-right); z-index: 56; }',
      '  .vgp-r { position: var(--r-position) !important; top: var(--r-top); right: var(--r-right); z-index: 56; }',

      // Start — flex child between C-buttons and A/B
      '  .vgp-start-portrait { display: none; }',
      '  .vgp-z-portrait { display: none; }',
      '  .vgp-start-landscape { display: flex; justify-content: center; flex-shrink: 5; order: var(--start-landscape-order); transform: translate(var(--start-nudge-x), var(--start-nudge-y)); }',
      '  .vgp-z-landscape { display: flex; justify-content: flex-end; flex-shrink: 0; order: var(--z-landscape-order); transform: translate(var(--z-nudge-x), var(--z-nudge-y)); }',
      '  .vgp-start { font-size: var(--btn-start-size); padding: 0.4em 1.4em; }',

      // Spacer: preferred height clears shoulders, collapses on tight viewports.
      // flex-shrink:10 means spacer absorbs compression first before groups shrink.
      '  .vgp-spacer { display: block; flex: 1 10 var(--spacer-pref); min-height: 0; }',

      // D-pad — flex child, nudgeable via tokens
      '  .vgp-dpad {',
      '    position: relative; top: auto; left: auto; bottom: auto; flex-shrink: 0;',
      '    width: var(--dpad-size); height: var(--dpad-size);',
      '    margin-bottom: var(--gap);',
      '    transform: translate(var(--dpad-nudge-x), var(--dpad-nudge-y));',
      '  }',
      '  .vgp-du, .vgp-dd, .vgp-dl, .vgp-dr {',
      '    width: var(--btn-dpad); height: var(--btn-dpad);',
      '    font-size: clamp(10px, 3svh, 13px);',
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
      '    transform: translate(var(--cbuttons-nudge-x), var(--cbuttons-nudge-y));',
      '  }',
      '  .vgp-cu, .vgp-cd, .vgp-cl, .vgp-cr {',
      '    width: var(--btn-c); height: var(--btn-c);',
      '    font-size: clamp(9px, 2.5svh, 11px);',
      '  }',
      '  .vgp-cu { left: 50%; transform: translateX(-50%); top: 0; right: auto; }',
      '  .vgp-cd { left: 50%; transform: translateX(-50%); bottom: 0; top: auto; right: auto; }',
      '  .vgp-cl { top: 50%; transform: translateY(-50%); left: 0; right: auto; }',
      '  .vgp-cr { top: 50%; transform: translateY(-50%); right: 0; left: auto; }',

      // A/B — flex child, nudgeable via token
      '  .vgp-ab {',
      '    display: block; position: relative; flex-shrink: 0; margin-top: 0;',
      '    width: var(--ab-group-w); height: var(--ab-group-h);',
      '    transform: translate(var(--ab-nudge-x), var(--ab-nudge-y));',
      '  }',
      '  .vgp-a {',
      '    width: var(--btn-ab); height: var(--btn-ab);',
      '    right: 0; bottom: 0; top: auto; font-size: clamp(15px, 5svh, 21px);',
      '  }',
      '  .vgp-b {',
      '    width: var(--btn-ab); height: var(--btn-ab);',
      '    right: 55%; bottom: 30%; top: auto; font-size: clamp(15px, 5svh, 21px);',
      '  }',
      '}',

      // Short landscape (≤300px): shared rules for dissolving shoulder bar
      '@media (orientation: landscape) and (max-height: 300px) {',
      '  :root {',
      '    --shoulders-display: contents;',
      '    --start-landscape-order: -1;',
      '    --spacer-pref: 0px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // iPhone SE (≤260px): design-mode values
      '@media (orientation: landscape) and (max-height: 260px) {',
      '  :root {',
      '    --btn-l-size: 11px;',
      '    --l-position: fixed; --l-top: 57px; --l-left: 121px;',
      '    --r-position: fixed; --r-top: 91px; --r-right: 97px;',
      '    --dpad-nudge-x: 13px; --dpad-nudge-y: -2px;',
      '    --ab-nudge-y: -10px;',
      '    --start-nudge-x: -56px; --start-nudge-y: 2px;',
      '    --cbuttons-nudge-x: 1px; --cbuttons-nudge-y: -5px;',
      '    --z-nudge-x: -4px; --z-nudge-y: -1px;',
      '  }',
      '}',

      // Galaxy S9+ (261–280px, ≤750px): design-mode values
      '@media (orientation: landscape) and (min-height: 261px) and (max-height: 280px) and (max-width: 750px) {',
      '  :root {',
      '    --l-position: fixed; --l-top: 60px; --l-left: 142px;',
      '    --r-position: fixed; --r-top: 99px; --r-right: 106px;',
      '    --dpad-nudge-x: 17px; --dpad-nudge-y: -6px;',
      '    --ab-nudge-x: -1px; --ab-nudge-y: -6px;',
      '    --z-nudge-x: -7px; --z-nudge-y: 3px;',
      '    --cbuttons-nudge-x: -5px; --cbuttons-nudge-y: -4px;',
      '    --start-nudge-x: -87px; --start-nudge-y: 18px;',
      '  }',
      '}',

      // 12 Mini / SE 3rd gen / iPhone 8 (281–300px, ≤750px): design-mode values
      '@media (orientation: landscape) and (min-height: 281px) and (max-height: 300px) and (max-width: 750px) {',
      '  :root {',
      '    --l-position: fixed; --l-top: 96px; --l-left: 142px;',
      '    --r-position: fixed; --r-top: 122px; --r-right: 118px;',
      '    --dpad-nudge-x: 10px; --dpad-nudge-y: -2px;',
      '    --ab-nudge-y: -10px;',
      '    --cbuttons-nudge-x: -4px; --cbuttons-nudge-y: -2px;',
      '    --z-nudge-x: -11px; --z-nudge-y: 2px;',
      '    --start-nudge-x: -76px; --start-nudge-y: 2px;',
      '  }',
      '}',

      // iPhone X and similar (261–300px, wide >750px): design-mode values
      '@media (orientation: landscape) and (min-height: 261px) and (max-height: 300px) and (min-width: 751px) {',
      '  :root {',
      '    --l-position: fixed; --l-top: 72px; --l-left: 183px;',
      '    --r-position: fixed; --r-top: 125px; --r-right: 124px;',
      '    --dpad-nudge-x: 30px; --dpad-nudge-y: -1px;',
      '    --ab-nudge-y: -5px;',
      '    --start-nudge-x: -114px; --start-nudge-y: 3px;',
      '    --cbuttons-nudge-x: -10px; --cbuttons-nudge-y: -14px;',
      '    --z-nudge-x: -9px; --z-nudge-y: 5px;',
      '  }',
      '}',

      // iPhone 12 / 13 / 14 (301–320px, ≤700px): design-mode values
      '@media (orientation: landscape) and (min-height: 301px) and (max-height: 320px) and (max-width: 700px) {',
      '  :root {',
      '    --shoulders-display: contents;',
      '    --start-landscape-order: -1;',
      '    --spacer-pref: 0px;',
      '    --l-position: fixed; --l-top: 104px; --l-left: 145px;',
      '    --r-position: fixed; --r-top: 138px; --r-right: 122px;',
      '    --dpad-nudge-x: 14px; --dpad-nudge-y: -10px;',
      '    --ab-nudge-x: -2px; --ab-nudge-y: -5px;',
      '    --start-nudge-x: -84px; --start-nudge-y: 2px;',
      '    --cbuttons-nudge-x: -4px; --cbuttons-nudge-y: -2px;',
      '    --z-nudge-x: -12px; --z-nudge-y: 10px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // Galaxy S8 / similar (301–320px, 701–750px): design-mode values
      '@media (orientation: landscape) and (min-height: 301px) and (max-height: 320px) and (min-width: 701px) and (max-width: 750px) {',
      '  :root {',
      '    --shoulders-display: contents;',
      '    --start-landscape-order: -1;',
      '    --spacer-pref: 0px;',
      '    --l-position: fixed; --l-top: 91px; --l-left: 151px;',
      '    --r-position: fixed; --r-top: 132px; --r-right: 122px;',
      '    --start-nudge-x: -97px; --start-nudge-y: 27px;',
      '    --ab-nudge-x: 0px; --ab-nudge-y: -6px;',
      '    --cbuttons-nudge-x: -7px; --cbuttons-nudge-y: -7px;',
      '    --z-nudge-x: -11px; --z-nudge-y: 5px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // Galaxy S24 / similar (301–320px, >750px): design-mode values
      '@media (orientation: landscape) and (min-height: 301px) and (max-height: 320px) and (min-width: 751px) {',
      '  :root {',
      '    --shoulders-display: contents;',
      '    --start-landscape-order: -1;',
      '    --spacer-pref: 0px;',
      '    --l-position: fixed; --l-top: 77px; --l-left: 165px;',
      '    --r-position: fixed; --r-top: 132px; --r-right: 123px;',
      '    --dpad-nudge-x: 24px; --dpad-nudge-y: -3px;',
      '    --ab-nudge-x: 2px; --ab-nudge-y: -11px;',
      '    --start-nudge-x: -94px; --start-nudge-y: 2px;',
      '    --cbuttons-nudge-x: -3px; --cbuttons-nudge-y: 3px;',
      '    --z-nudge-x: -8px; --z-nudge-y: 5px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // Pixel 5 / similar (321–340px, ≤750px): design-mode values
      '@media (orientation: landscape) and (min-height: 321px) and (max-height: 340px) and (max-width: 750px) {',
      '  :root {',
      '    --shoulders-display: contents;',
      '    --start-landscape-order: -1;',
      '    --spacer-pref: 0px;',
      '    --btn-l-size: 11px;',
      '    --l-position: fixed; --l-top: 112px; --l-left: 154px;',
      '    --r-position: fixed; --r-top: 152px; --r-right: 134px;',
      '    --ab-nudge-x: -4px; --ab-nudge-y: -11px;',
      '    --cbuttons-nudge-x: -6px; --cbuttons-nudge-y: -8px;',
      '    --start-nudge-x: -94px; --start-nudge-y: 6px;',
      '    --z-nudge-x: -14px; --z-nudge-y: 3px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // iPhone 12 Pro Max / 14 Plus range (341–380px, ≤800px): design-mode values
      '@media (orientation: landscape) and (min-height: 341px) and (max-height: 380px) and (max-width: 800px) {',
      '  :root {',
      '    --shoulders-display: contents;',
      '    --start-landscape-order: -1;',
      '    --spacer-pref: 0px;',
      '    --l-position: fixed; --l-top: 123px; --l-left: 160px;',
      '    --r-position: fixed; --r-top: 163px; --r-right: 131px;',
      '    --dpad-nudge-x: 12px; --dpad-nudge-y: -8px;',
      '    --ab-nudge-x: 7px; --ab-nudge-y: -7px;',
      '    --start-nudge-x: -93px; --start-nudge-y: 2px;',
      '    --cbuttons-nudge-x: -5px; --cbuttons-nudge-y: -8px;',
      '    --z-nudge-x: -9px; --z-nudge-y: 12px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // Pixel 7 / similar (341–380px, 801–900px): design-mode values
      '@media (orientation: landscape) and (min-height: 341px) and (max-height: 380px) and (min-width: 801px) and (max-width: 900px) {',
      '  :root {',
      '    --shoulders-display: contents;',
      '    --start-landscape-order: -1;',
      '    --spacer-pref: 0px;',
      '    --btn-l-size: 11px;',
      '    --l-position: fixed; --l-top: 119px; --l-left: 176px;',
      '    --r-position: fixed; --r-top: 161px; --r-right: 140px;',
      '    --start-nudge-x: -101px; --start-nudge-y: 27px;',
      '    --ab-nudge-x: 0px; --ab-nudge-y: -11px;',
      '    --cbuttons-nudge-x: -7px; --cbuttons-nudge-y: -7px;',
      '    --z-nudge-x: -15px; --z-nudge-y: 6px;',
      '    --dpad-nudge-x: 27px; --dpad-nudge-y: -4px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // iPhone 16+ and similar (341–380px, wide >900px): design-mode values
      '@media (orientation: landscape) and (min-height: 341px) and (max-height: 380px) and (min-width: 901px) {',
      '  :root {',
      '    --shoulders-display: contents;',
      '    --start-landscape-order: -1;',
      '    --spacer-pref: 0px;',
      '    --btn-l-size: 11px;',
      '    --l-position: fixed; --l-top: 109px; --l-left: 196px;',
      '    --r-position: fixed; --r-top: 162px; --r-right: 137px;',
      '    --dpad-nudge-x: 13px; --dpad-nudge-y: -6px;',
      '    --ab-nudge-x: 5px; --ab-nudge-y: -10px;',
      '    --start-nudge-x: -129px; --start-nudge-y: 9px;',
      '    --cbuttons-nudge-x: -6px; --cbuttons-nudge-y: -8px;',
      '    --z-nudge-x: -9px; --z-nudge-y: 6px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // Short landscape phones (iPhone SE, Galaxy S9+, etc.): analog too small when
      // svh is tiny. Use max(svh, vw) so the wider dimension governs — these devices
      // have plenty of horizontal room. Stick grows proportionally with screen width.
      '@media (orientation: landscape) and (max-height: 380px) {',
      '  :root {',
      '    --stick-size: clamp(100px, max(32svh, 18vw), 155px);',
      '    --knob-size: clamp(41px, max(13svh, 7.5vw), 64px);',
      '    --btn-ab: clamp(40px, 17svh, 66px);',
      '    --btn-dpad: clamp(20px, 9svh, 34px);',
      '  }',
      '}',

      // Galaxy A55 / large phones (381–450px): design-mode values
      '@media (orientation: landscape) and (min-height: 381px) and (max-height: 450px) {',
      '  :root {',
      '    --shoulders-display: contents;',
      '    --start-landscape-order: -1;',
      '    --spacer-pref: 0px;',
      '    --l-position: fixed; --l-top: 224px; --l-left: 176px;',
      '    --r-position: fixed; --r-top: 211px; --r-right: 159px;',
      '    --ab-nudge-x: -4px; --ab-nudge-y: -14px;',
      '    --start-nudge-x: -127px; --start-nudge-y: 103px;',
      '    --z-nudge-x: -21px; --z-nudge-y: 1px;',
      '    --cbuttons-nudge-x: -4px; --cbuttons-nudge-y: -7px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
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
      '  <div class="vgp-z-landscape"></div>',
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
    const zLandscapeEl = _overlay.querySelector('.vgp-z-landscape');
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
        // Portrait: Z in right column below AB. Landscape: own container between cbuttons and AB.
        zPortraitEl.appendChild(btn);
        const zClone = btn.cloneNode(true);
        zLandscapeEl.appendChild(zClone);
      } else if (cls === 'vgp-start') {
        // Start in portrait row (Z appended after), and landscape container
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

    _cachedBtns = _overlay.querySelectorAll('.vgp-btn');

    document.body.appendChild(_overlay);
  };

  // Hit-test a point against a button's actual visual shape.
  // Round buttons (border-radius ≥ 50% of shorter side) use ellipse math;
  // everything else uses the rectangular bounding box.
  const hitTestBtn = (btn, x, y) => {
    const r = btn.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const br = parseFloat(getComputedStyle(btn).borderTopLeftRadius) || 0;
    if (br >= Math.min(r.width, r.height) / 2 - 2) {
      // Circular / elliptical
      const dx = x - (r.left + r.width / 2);
      const dy = y - (r.top + r.height / 2);
      return (dx * dx) / (r.width / 2) ** 2 + (dy * dy) / (r.height / 2) ** 2 <= 1;
    }
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  const findBtnAt = (x, y) => {
    const btns = _cachedBtns || _overlay?.querySelectorAll('.vgp-btn') || [];
    for (const btn of btns) {
      if (hitTestBtn(btn, x, y)) return btn;
    }
    return null;
  };

  const onTouchStart = (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const el = document.elementFromPoint(t.clientX, t.clientY);

      if (el === _stickZone || el === _stickEl || el?.parentNode === _stickZone) {
        _stickTouch = t.identifier;
        // Floating center: wherever the thumb lands becomes the origin.
        // Clamp so the full radius fits within the zone.
        const rect = _stickZone.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const margin = rect.width / 2 - STICK_RADIUS;
        _stickCenter = {
          x: Math.max(rect.left + margin, Math.min(rect.right - margin, t.clientX)),
          y: Math.max(rect.top + margin, Math.min(rect.bottom - margin, t.clientY)),
        };
        // Move the knob visual to the new center on contact
        const dx = _stickCenter.x - cx;
        const dy = _stickCenter.y - cy;
        if (_stickEl) _stickEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
        updateStick(t.clientX, t.clientY);
        continue;
      }

      const btnEl = findBtnAt(t.clientX, t.clientY);
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
      if (_overlay) return; // already initialized — idempotent
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
      _cachedBtns = null;
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
