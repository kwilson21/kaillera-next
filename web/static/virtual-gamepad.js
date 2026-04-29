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

      // ── Portrait position tokens (design-mode editable) ──
      ':root {',
      '  --p-dpad-nudge-x: 21px; --p-dpad-nudge-y: 11px;',
      '  --p-cbuttons-nudge-x: -13px; --p-cbuttons-nudge-y: 9px;',
      '  --p-ab-nudge-x: -15px; --p-ab-nudge-y: 42px;',
      '  --p-stick-nudge-x: 12px; --p-stick-nudge-y: 22px;',
      '  --p-z-nudge-x: 94px; --p-z-nudge-y: -33px;',
      '  --p-l-nudge-x: 72px; --p-l-nudge-y: 88px;',
      '  --p-r-nudge-x: -59px; --p-r-nudge-y: 105px;',
      '  --p-l-size: 10px; --p-r-size: 10px; --p-z-size: 10px;',
      '  --p-start-size: 13px;',
      '  --p-btn-dpad: 24px;',
      '  --p-dpad-size: calc(var(--p-btn-dpad) * 3);',
      '  --p-btn-c: 28px;',
      '  --p-cbuttons-w: calc(var(--p-btn-c) * 3); --p-cbuttons-h: calc(var(--p-btn-c) * 3);',
      '  --p-btn-a: 39px; --p-btn-b: 39px;',
      '  --p-ab-w: calc(var(--p-btn-a) * 2.4); --p-ab-h: calc(var(--p-btn-a) * 1.5);',
      '  --p-stick-size: 86px;',
      '  --p-knob-size: calc(var(--p-stick-size) * 0.42);',
      '}',

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

      // Shoulder buttons (base styles, orientation-agnostic)
      '.vgp-l { position: static; border-radius: 8px; padding: 0.4em 1em; }',
      '.vgp-r { position: static; border-radius: 8px; padding: 0.4em 1em; }',
      '.vgp-z { position: static; border-radius: 8px; padding: 0.4em 1em; }',

      // D-pad (base)
      '.vgp-dpad { position: relative; flex-shrink: 1; }',
      '.vgp-du, .vgp-dd, .vgp-dl, .vgp-dr { border-radius: 6px; font-size: 13px; }',
      '.vgp-du { left: 50%; transform: translateX(-50%); top: 0; }',
      '.vgp-dd { left: 50%; transform: translateX(-50%); bottom: 0; top: auto; }',
      '.vgp-dl { left: 0; top: 50%; transform: translateY(-50%); }',
      '.vgp-dr { right: 0; top: 50%; transform: translateY(-50%); }',

      // Stick zone (base)
      '.vgp-stick-zone {',
      '  position: relative; flex-shrink: 1; margin-top: 6px;',
      '  border-radius: 50%;',
      '  background: rgba(255,255,255,0.08); border: 2px solid rgba(255,255,255,0.15);',
      '}',
      '.vgp-stick-knob {',
      '  position: absolute; border-radius: 50%;',
      '  background: rgba(255,255,255,0.25); border: 2px solid rgba(255,255,255,0.4);',
      '  left: 50%; top: 50%; transform: translate(-50%,-50%);',
      '  transition: none; will-change: transform;',
      '}',

      // C-buttons (base)
      '.vgp-cu { left: 50%; transform: translateX(-50%); top: 0; font-size: 11px; }',
      '.vgp-cd { left: 50%; transform: translateX(-50%); bottom: 0; top: auto; font-size: 11px; }',
      '.vgp-cl { left: 0; top: 50%; transform: translateY(-50%); font-size: 11px; }',
      '.vgp-cr { right: 0; left: auto; top: 50%; transform: translateY(-50%); font-size: 11px; }',

      // A + B (base)
      '.vgp-a { right: 9%; bottom: 2%; top: auto; font-size: 21px; }',
      '.vgp-b { right: 54%; bottom: 38%; top: auto; font-size: 21px; }',

      // Start button (base)
      '.vgp-start { position: static; border-radius: 14px; }',

      // Sub-containers (base)
      '.vgp-cbuttons { position: relative; flex-shrink: 1; }',
      '.vgp-ab { position: relative; flex-shrink: 1; margin-top: 4px; }',
      '.vgp-spacer { display: none; pointer-events: none; }',
      '.vgp-z-portrait { display: flex; justify-content: flex-start; width: 100%; padding-left: 4px; pointer-events: none !important; }',

      // ── Portrait-only sizes, transforms, and nudges ──
      '@media (orientation: portrait) {',
      '  .vgp-l { font-size: var(--p-l-size); transform: translate(var(--p-l-nudge-x), var(--p-l-nudge-y)); }',
      '  .vgp-r { font-size: var(--p-r-size); transform: translate(var(--p-r-nudge-x), var(--p-r-nudge-y)); }',
      '  .vgp-z { font-size: var(--p-z-size); }',
      '  .vgp-dpad { width: var(--p-dpad-size); height: var(--p-dpad-size); transform: translate(var(--p-dpad-nudge-x), var(--p-dpad-nudge-y)); }',
      '  .vgp-du, .vgp-dd, .vgp-dl, .vgp-dr { width: var(--p-btn-dpad); height: var(--p-btn-dpad); }',
      '  .vgp-stick-zone { width: var(--p-stick-size); height: var(--p-stick-size); transform: translate(var(--p-stick-nudge-x), var(--p-stick-nudge-y)); }',
      '  .vgp-stick-knob { width: var(--p-knob-size); height: var(--p-knob-size); }',
      '  .vgp-cu, .vgp-cd, .vgp-cl, .vgp-cr { width: var(--p-btn-c); height: var(--p-btn-c); }',
      '  .vgp-a { width: var(--p-btn-a); height: var(--p-btn-a); }',
      '  .vgp-b { width: var(--p-btn-b); height: var(--p-btn-b); }',
      '  .vgp-start { padding: 0.4em 1.4em; font-size: var(--p-start-size); }',
      '  .vgp-cbuttons { width: var(--p-cbuttons-w); height: var(--p-cbuttons-h); transform: translate(var(--p-cbuttons-nudge-x), var(--p-cbuttons-nudge-y)); }',
      '  .vgp-ab { width: var(--p-ab-w); height: var(--p-ab-h); transform: translate(var(--p-ab-nudge-x), var(--p-ab-nudge-y)); }',
      '  .vgp-z-portrait { transform: translate(var(--p-z-nudge-x), var(--p-z-nudge-y)); }',
      '}',
      '.vgp-start-portrait {',
      '  grid-area: start; display: flex; align-items: center; justify-content: center;',
      '  padding: 2px 0;',
      '}',
      // Landscape wrappers: hidden in portrait
      '.vgp-start-landscape { display: none; }',
      '.vgp-z-landscape { display: none; }',

      // Portrait responsive: override --p- vars per breakpoint so sizes scale.
      '@media (orientation: portrait) and (max-width: 430px) {',
      '  :root {',
      '    --p-btn-dpad: clamp(24px, 5svh, 34px);',
      '    --p-stick-size: clamp(90px, 18svh, 128px);',
      '    --p-btn-c: clamp(24px, 5svh, 38px);',
      '    --p-btn-a: clamp(40px, 9svh, 66px); --p-btn-b: clamp(40px, 9svh, 66px);',
      '  }',
      '}',

      // iPhone X / standard phones portrait: design-mode values
      '@media (orientation: portrait) and (max-width: 430px) and (min-height: 651px) {',
      '  :root {',
      '    --p-dpad-nudge-x: 22px; --p-dpad-nudge-y: 3px;',
      '    --p-l-nudge-x: 105px; --p-l-nudge-y: 126px;',
      '    --p-l-size: 12px;',
      '    --p-z-nudge-x: 92px; --p-z-nudge-y: -72px;',
      '    --p-z-size: 14px;',
      '    --p-cbuttons-nudge-x: -16px; --p-cbuttons-nudge-y: 12px;',
      '    --p-r-nudge-x: -106px; --p-r-nudge-y: 146px;',
      '    --p-r-size: 14px;',
      '  }',
      '}',

      // Galaxy S8 / narrow tall phones portrait: design-mode values
      '@media (orientation: portrait) and (max-width: 375px) and (min-height: 651px) {',
      '  :root {',
      '    --p-z-nudge-x: 109px; --p-z-nudge-y: -63px;',
      '    --p-r-nudge-x: -80px; --p-r-nudge-y: 150px;',
      '    --p-ab-nudge-x: 5px; --p-ab-nudge-y: 55px;',
      '    --p-cbuttons-nudge-x: -9px; --p-cbuttons-nudge-y: 10px;',
      '  }',
      '}',

      // Pixel 5 / mid-size tall phones portrait: design-mode values
      '@media (orientation: portrait) and (min-width: 376px) and (max-width: 413px) and (min-height: 651px) {',
      '  :root {',
      '    --p-z-nudge-x: 108px; --p-z-nudge-y: -68px;',
      '    --p-r-nudge-x: -93px; --p-r-nudge-y: 137px;',
      '    --p-l-nudge-x: 106px; --p-l-nudge-y: 126px;',
      '  }',
      '}',

      // Pixel 7 / mid-size tall phones portrait: design-mode values
      '@media (orientation: portrait) and (min-width: 376px) and (max-width: 413px) and (min-height: 750px) {',
      '  :root {',
      '    --p-z-nudge-x: 111px; --p-z-nudge-y: -74px;',
      '    --p-r-nudge-x: -106px; --p-r-nudge-y: 146px;',
      '  }',
      '}',

      // iPhone 12 Pro Max / large phones portrait: design-mode values
      '@media (orientation: portrait) and (min-width: 414px) and (min-height: 651px) {',
      '  :root {',
      '    --p-z-nudge-x: 122px; --p-z-nudge-y: -67px;',
      '    --p-r-nudge-x: -95px; --p-r-nudge-y: 139px;',
      '  }',
      '}',

      // iPhone 16+ / largest phones portrait: design-mode values
      '@media (orientation: portrait) and (min-width: 428px) and (min-height: 800px) {',
      '  :root {',
      '    --p-z-nudge-x: 122px; --p-z-nudge-y: -72px;',
      '    --p-r-nudge-x: -105px; --p-r-nudge-y: 149px;',
      '  }',
      '}',

      // Small portrait phones: narrow AND short (Moto G4, iPhone SE, iPhone 12 Mini, etc.)
      '@media (orientation: portrait) and (max-width: 430px) and (max-height: 650px) {',
      '  .vgp-left, .vgp-right { padding-top: 2px; padding-bottom: 1px; gap: 1px; }',
      '  :root {',
      '    --p-btn-dpad: clamp(20px, 4svh, 28px);',
      '    --p-stick-size: clamp(76px, 14svh, 108px);',
      '    --p-btn-c: clamp(22px, 4.5svh, 32px);',
      '    --p-btn-a: clamp(35px, 7.5svh, 56px); --p-btn-b: clamp(35px, 7.5svh, 56px);',
      '  }',
      '}',

      // iPhone SE (3rd gen) portrait: design-mode values
      '@media (orientation: portrait) and (max-width: 375px) and (max-height: 600px) {',
      '  :root {',
      '    --p-stick-size: 94px;',
      '    --p-z-nudge-x: 114px; --p-z-nudge-y: -37px;',
      '    --p-l-nudge-x: 78px; --p-l-nudge-y: 96px;',
      '    --p-r-nudge-x: -72px; --p-r-nudge-y: 113px;',
      '  }',
      '}',

      // iPhone 13 Mini portrait: design-mode values
      '@media (orientation: portrait) and (max-width: 375px) and (min-height: 501px) and (max-height: 600px) {',
      '  :root {',
      '    --p-z-nudge-x: 116px; --p-z-nudge-y: -39px;',
      '    --p-r-nudge-x: -68px; --p-r-nudge-y: 110px;',
      '  }',
      '}',

      // Galaxy S9+ / narrow mid-height phones portrait: design-mode values
      '@media (orientation: portrait) and (max-width: 320px) and (min-height: 501px) and (max-height: 650px) {',
      '  :root {',
      '    --p-r-nudge-x: -74px; --p-r-nudge-y: 116px;',
      '    --p-z-nudge-x: 85px; --p-z-nudge-y: -44px;',
      '    --p-l-nudge-x: 77px; --p-l-nudge-y: 100px;',
      '  }',
      '}',

      // iPhone SE (1st/2nd gen) portrait: design-mode values
      '@media (orientation: portrait) and (max-width: 320px) and (max-height: 500px) {',
      '  :root {',
      '    --p-btn-dpad: 22px;',
      '    --p-l-nudge-x: 78px; --p-l-nudge-y: 91px;',
      '    --p-r-nudge-x: -58px; --p-r-nudge-y: 104px;',
      '    --p-z-nudge-x: 92px; --p-z-nudge-y: -32px;',
      '  }',
      '}',

      // iPhone 12 / mid-size short phones portrait: design-mode values
      '@media (orientation: portrait) and (min-width: 376px) and (max-width: 430px) and (max-height: 650px) {',
      '  :root {',
      '    --p-stick-size: 98px;',
      '    --p-btn-dpad: 25px;',
      '    --p-dpad-nudge-x: 22px; --p-dpad-nudge-y: 10px;',
      '    --p-l-nudge-x: 83px; --p-l-nudge-y: 100px;',
      '    --p-r-nudge-x: -68px; --p-r-nudge-y: 115px;',
      '    --p-z-nudge-x: 123px; --p-z-nudge-y: -41px;',
      '  }',
      '}',

      // Galaxy A55 / wide phones portrait: design-mode values
      '@media (orientation: portrait) and (min-width: 431px) and (max-width: 599px) {',
      '  :root {',
      '    --p-stick-size: 100px;',
      '    --p-stick-nudge-x: 18px; --p-stick-nudge-y: 24px;',
      '    --p-btn-dpad: 26px;',
      '    --p-dpad-nudge-x: 32px; --p-dpad-nudge-y: 9px;',
      '    --p-btn-a: 41px; --p-btn-b: 41px;',
      '    --p-ab-nudge-x: -14px; --p-ab-nudge-y: 51px;',
      '    --p-cbuttons-nudge-x: -13px; --p-cbuttons-nudge-y: 13px;',
      '    --p-l-nudge-x: 97px; --p-l-nudge-y: 103px;',
      '    --p-r-nudge-x: -64px; --p-r-nudge-y: 130px;',
      '    --p-z-nudge-x: 172px; --p-z-nudge-y: -30px;',
      '  }',
      '}',

      // Tablet portrait: more inward padding + larger sizes
      '@media (orientation: portrait) and (min-width: 600px) {',
      '  #virtual-gamepad { padding: 8px 32px; }',
      '  :root {',
      '    --p-btn-dpad: clamp(35px, 4.5svh, 56px);',
      '    --p-stick-size: clamp(150px, 18svh, 200px);',
      '    --p-btn-c: clamp(38px, 6svh, 56px);',
      '    --p-btn-a: clamp(64px, 11svh, 88px); --p-btn-b: clamp(64px, 11svh, 88px);',
      '  }',
      '}',

      // iPad Mini portrait: design-mode values
      '@media (orientation: portrait) and (min-width: 600px) and (max-width: 850px) {',
      '  :root {',
      '    --p-btn-c: 48px;',
      '    --p-cbuttons-nudge-x: -35px; --p-cbuttons-nudge-y: -21px;',
      '    --p-r-nudge-x: -141px; --p-r-nudge-y: 171px;',
      '    --p-r-size: 18px;',
      '    --p-z-nudge-x: 243px; --p-z-nudge-y: -104px;',
      '    --p-z-size: 18px;',
      '    --p-dpad-nudge-x: 33px; --p-dpad-nudge-y: 2px;',
      '    --p-l-nudge-x: 155px; --p-l-nudge-y: 164px;',
      '    --p-l-size: 18px;',
      '    --p-start-size: 17px;',
      '  }',
      '}',

      // Galaxy Tab S9 / narrow mid-height tablets portrait: design-mode values
      '@media (orientation: portrait) and (min-width: 600px) and (max-width: 710px) and (max-height: 999px) {',
      '  :root {',
      '    --p-z-nudge-x: 195px; --p-z-nudge-y: -103px;',
      '    --p-ab-nudge-x: -4px; --p-ab-nudge-y: 45px;',
      '    --p-r-nudge-x: -127px; --p-r-nudge-y: 175px;',
      '    --p-cbuttons-nudge-x: -22px; --p-cbuttons-nudge-y: -4px;',
      '  }',
      '}',

      // Galaxy Tab S4 / narrow tall tablets portrait: design-mode values
      '@media (orientation: portrait) and (min-width: 600px) and (max-width: 710px) and (min-height: 1000px) {',
      '  :root {',
      '    --p-ab-nudge-x: -15px; --p-ab-nudge-y: 55px;',
      '    --p-z-nudge-x: 219px; --p-z-nudge-y: -106px;',
      '    --p-r-nudge-x: -136px; --p-r-nudge-y: 179px;',
      '    --p-cbuttons-nudge-x: -34px; --p-cbuttons-nudge-y: -7px;',
      '  }',
      '}',

      // iPad (gen 7) portrait: design-mode values
      '@media (orientation: portrait) and (min-width: 800px) and (max-width: 850px) {',
      '  :root {',
      '    --p-z-nudge-x: 263px; --p-z-nudge-y: -110px;',
      '    --p-start-size: 19px;',
      '  }',
      '}',

      // Nexus 10 / 800px wide tall tablets portrait: design-mode values
      '@media (orientation: portrait) and (min-width: 800px) and (max-width: 820px) and (min-height: 1100px) {',
      '  :root {',
      '    --p-ab-nudge-x: -25px; --p-ab-nudge-y: 101px;',
      '    --p-z-nudge-x: 254px; --p-z-nudge-y: -51px;',
      '    --p-cbuttons-nudge-x: -37px; --p-cbuttons-nudge-y: 51px;',
      '    --p-r-nudge-x: -148px; --p-r-nudge-y: 228px;',
      '    --p-dpad-nudge-x: 29px; --p-dpad-nudge-y: 4px;',
      '    --p-l-nudge-x: 164px; --p-l-nudge-y: 187px;',
      '  }',
      '}',

      // iPad Pro 11 portrait: design-mode values
      '@media (orientation: portrait) and (min-width: 821px) and (min-height: 1100px) {',
      '  :root {',
      '    --p-z-nudge-x: 281px; --p-z-nudge-y: -59px;',
      '    --p-ab-nudge-x: -12px; --p-ab-nudge-y: 91px;',
      '    --p-r-nudge-x: -136px; --p-r-nudge-y: 220px;',
      '    --p-cbuttons-nudge-x: -31px; --p-cbuttons-nudge-y: 19px;',
      '    --p-l-nudge-x: 162px; --p-l-nudge-y: 177px;',
      '  }',
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

      // Game/stream surface: gets ALL space between panels. 4:3 preserved by object-fit.
      '  #game, #stream-overlay {',
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
      '    --r-position: fixed; --r-top: 154px; --r-right: 137px;',
      '    --dpad-nudge-x: 13px; --dpad-nudge-y: -6px;',
      '    --ab-nudge-x: 5px; --ab-nudge-y: -10px;',
      '    --start-nudge-x: -129px; --start-nudge-y: 9px;',
      '    --cbuttons-nudge-x: -6px; --cbuttons-nudge-y: -15px;',
      '    --z-nudge-x: -10px; --z-nudge-y: 4px;',
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

      // Galaxy Tab S9 / mid-height wide tablets landscape: design-mode values
      '@media (orientation: landscape) and (min-height: 451px) and (max-height: 650px) and (min-width: 900px) {',
      '  :root {',
      '    --l-position: fixed; --l-top: 398px; --l-left: 161px;',
      '    --r-position: fixed; --r-top: 398px; --r-right: 156px;',
      '    --z-nudge-x: -16px; --z-nudge-y: 9px;',
      '    --start-nudge-x: -82px; --start-nudge-y: -141px;',
      '    --cbuttons-nudge-x: -1px; --cbuttons-nudge-y: 30px;',
      '    --ab-nudge-x: -2px; --ab-nudge-y: -13px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // iPad Mini landscape: design-mode values
      '@media (orientation: landscape) and (min-height: 651px) {',
      '  :root {',
      '    --l-position: fixed; --l-top: 520px; --l-left: 161px;',
      '    --r-position: fixed; --r-top: 507px; --r-right: 152px;',
      '    --z-nudge-x: -12px; --z-nudge-y: 1px;',
      '    --start-nudge-x: -78px; --start-nudge-y: -154px;',
      '    --cbuttons-nudge-x: -3px; --cbuttons-nudge-y: 22px;',
      '    --ab-nudge-x: 2px; --ab-nudge-y: -16px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // Galaxy Tab S4 / wide mid-height tablets landscape: design-mode values
      '@media (orientation: landscape) and (min-height: 651px) and (max-height: 750px) and (min-width: 1100px) {',
      '  :root {',
      '    --l-position: fixed; --l-top: 475px; --l-left: 165px;',
      '    --r-position: fixed; --r-top: 463px; --r-right: 157px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // iPad (gen 7) landscape: design-mode values
      '@media (orientation: landscape) and (min-height: 751px) {',
      '  :root {',
      '    --l-position: fixed; --l-top: 561px; --l-left: 166px;',
      '    --r-position: fixed; --r-top: 551px; --r-right: 157px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // iPad Pro 11 landscape: design-mode values
      '@media (orientation: landscape) and (min-height: 751px) and (min-width: 1100px) and (max-width: 1250px) {',
      '  :root {',
      '    --l-position: fixed; --l-top: 582px; --l-left: 168px;',
      '    --r-position: fixed; --r-top: 571px; --r-right: 158px;',
      '  }',
      '  .vgp-shoulders > div:not(.vgp-btn) { display: none; }',
      '  .vgp-l { padding: 0.4em 1em; } .vgp-r { padding: 0.4em 1em; }',
      '}',

      // Nexus 10 / extra-wide tablets landscape: design-mode values
      '@media (orientation: landscape) and (min-height: 751px) and (min-width: 1251px) {',
      '  :root {',
      '    --l-position: fixed; --l-top: 565px; --l-left: 170px;',
      '    --r-position: fixed; --r-top: 556px; --r-right: 159px;',
      '    --z-nudge-x: -11px; --z-nudge-y: 4px;',
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
    const rawDist = Math.sqrt(dx * dx + dy * dy);
    const clampedDist = Math.min(rawDist, STICK_RADIUS);
    if (rawDist > STICK_RADIUS) {
      dx = (dx / rawDist) * STICK_RADIUS;
      dy = (dy / rawDist) * STICK_RADIUS;
    }
    if (_stickEl) {
      _stickEl.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    }
    // N64-style analog: deadzone + non-linear response curve.
    // Normalized magnitude 0–1, then apply deadzone and power curve.
    const mag = clampedDist / STICK_RADIUS; // 0 to 1
    let output = 0;
    if (mag > DEADZONE) {
      // Remap deadzone–1 range to 0–1, then apply power curve
      const remapped = (mag - DEADZONE) / (1 - DEADZONE);
      output = Math.pow(remapped, EDGE_EXPONENT);
    }
    // Convert back to directional axis values
    if (clampedDist > 0.001) {
      const ax = (dx / clampedDist) * output * MAX_AXIS;
      const ay = (dy / clampedDist) * output * MAX_AXIS;
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
