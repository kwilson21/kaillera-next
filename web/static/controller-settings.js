(function () {
  'use strict';

  // ── Inject styles (self-contained — works on any page) ──────────
  const _style = document.createElement('style');
  _style.textContent = `
#controller-settings{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(.95);width:440px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);background:#0f1923;border:1px solid #1e293b;border-radius:12px;z-index:102;overflow-y:auto;padding:20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;opacity:0;pointer-events:none;transition:transform .2s ease,opacity .2s ease}
#controller-settings.open{transform:translate(-50%,-50%) scale(1);opacity:1;pointer-events:auto}
#controller-settings .cs-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}
#controller-settings .cs-title{font-size:15px;font-weight:600;color:#f1f5f9}
#controller-settings .cs-close{background:none;border:none;color:#475569;font-size:18px;cursor:pointer;padding:4px 8px}
#controller-settings .cs-close:hover{color:#94a3b8}
#controller-settings .cs-section-label{font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}
#controller-settings .cs-sep{border-top:1px solid #1e293b;margin:14px 0}
#controller-settings .cs-map-grid{background:#0a1019;border-radius:6px;padding:10px;display:grid;grid-template-columns:60px 1fr 1fr;gap:4px 8px;align-items:center}
#controller-settings .cs-map-label{font-size:11px;color:#94a3b8}
#controller-settings .cs-map-bind{background:#1e293b;border:1px solid #334155;border-radius:3px;padding:3px 8px;font-size:10px;color:#cbd5e1;text-align:center;cursor:pointer;min-height:24px;display:flex;align-items:center;justify-content:center}
#controller-settings .cs-map-bind:hover{border-color:#475569}
#controller-settings .cs-map-bind.listening{border-color:#3b82f6;color:#3b82f6;animation:cs-pulse 1s infinite}
#controller-settings .cs-map-bind.axis-bind{color:#eab308}
#controller-settings .cs-map-bind.disabled{color:#334155;cursor:default;border-color:#1e293b}
@keyframes cs-pulse{0%,100%{opacity:1}50%{opacity:.5}}
#controller-settings .cs-map-group{grid-column:1/-1;font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:.5px;margin-top:4px;padding-top:6px;border-top:1px solid #1e293b}
#controller-settings .cs-map-header-row{grid-column:1/-1;display:grid;grid-template-columns:60px 1fr 1fr;gap:8px;margin-bottom:4px}
#controller-settings .cs-map-col-label{font-size:9px;color:#475569;text-transform:uppercase;text-align:center}
#controller-settings .cs-quick-btn{background:#1d4ed8;color:#fff;font-size:10px;font-weight:600;padding:4px 10px;border-radius:4px;border:none;cursor:pointer}
#controller-settings .cs-quick-btn:hover{background:#2563eb}
#controller-settings .cs-viz-wrap{background:#0a1019;border-radius:8px;padding:16px;margin-bottom:16px}
#controller-settings .cs-viz-row{display:flex;gap:20px;justify-content:center;align-items:flex-start}
#controller-settings .cs-viz-label{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;margin-bottom:8px;text-align:center}
#controller-settings .cs-viz-coords{font-size:10px;color:#475569;margin-top:6px;font-family:monospace;text-align:center}
#controller-settings .cs-no-gamepad{font-size:10px;color:#475569;text-align:center;margin-top:8px}
#controller-settings .cs-slider-row{margin-bottom:12px}
#controller-settings .cs-slider-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px}
#controller-settings .cs-slider-name{font-size:12px;color:#cbd5e1}
#controller-settings .cs-slider-val{font-size:12px;font-weight:600;font-family:monospace}
#controller-settings input[type='range']{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:3px;background:#1e293b;outline:none}
#controller-settings input[type='range']::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:#f1f5f9;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.4)}
#controller-settings .cs-slider-hint{font-size:9px;color:#475569;margin-top:2px}
#controller-settings .cs-dz-card{background:#0a1019;border-radius:6px;padding:10px 12px;margin-bottom:8px}
#controller-settings .cs-dz-title{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#64748b;margin-bottom:8px}
#controller-settings .cs-dz-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
#controller-settings .cs-dz-row:last-child{margin-bottom:0}
#controller-settings .cs-dz-axis{font-size:11px;color:#64748b;width:14px}
#controller-settings .cs-dz-val{font-size:11px;color:#ef4444;font-family:monospace;width:32px;text-align:right}
#controller-settings .cs-footer{display:flex;justify-content:space-between;align-items:center;padding-top:12px;border-top:1px solid #1e293b;margin-top:14px}
#controller-settings .cs-footer label{display:flex;align-items:center;gap:6px;font-size:11px;color:#94a3b8;cursor:pointer}
#controller-settings .cs-footer-reset{font-size:11px;color:#475569;background:none;border:none;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
#cs-backdrop{position:fixed;top:0;left:0;width:100%;height:100%;z-index:101;background:rgba(0,0,0,.6);opacity:0;pointer-events:none;transition:opacity .2s ease}
#cs-backdrop.visible{opacity:1;pointer-events:auto}
@media(max-width:480px){#controller-settings{width:calc(100vw - 16px);max-height:calc(100vh - 16px)}}
  `;
  document.head.appendChild(_style);

  let _panel = null;
  let _backdrop = null;
  let _isOpen = false;
  let _vizRafId = null;

  // ── Key name lookup (keyCode → display string) ──────────────────
  const KEY_NAMES = {
    8: 'Bksp',
    9: 'Tab',
    13: 'Enter',
    16: 'Shift',
    17: 'Ctrl',
    18: 'Alt',
    20: 'Caps',
    27: 'Esc',
    32: 'Space',
    37: '←',
    38: '↑',
    39: '→',
    40: '↓',
    46: 'Del',
    91: 'Meta',
    186: ';',
    187: '=',
    188: ',',
    189: '-',
    190: '.',
    191: '/',
    192: '`',
    219: '[',
    220: '\\',
    221: ']',
    222: "'",
  };
  const keyName = (code) => {
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    if (code >= 65 && code <= 90) return String.fromCharCode(code);
    if (code >= 48 && code <= 57) return String(code - 48);
    if (code >= 96 && code <= 105) return 'Num' + (code - 96);
    if (code >= 112 && code <= 123) return 'F' + (code - 111);
    return '?';
  };

  // ── N64 button definitions (label, bitIndex, group) ──────────────
  const N64_BUTTONS = [
    { label: 'A', bit: 0, group: 'face' },
    { label: 'B', bit: 1, group: 'face' },
    { label: 'Start', bit: 3, group: 'face' },
    { label: 'Z', bit: 12, group: 'face' },
    { label: 'L', bit: 10, group: 'face' },
    { label: 'R', bit: 11, group: 'face' },
    { label: 'D-Up', bit: 4, group: 'dpad' },
    { label: 'D-Down', bit: 5, group: 'dpad' },
    { label: 'D-Left', bit: 6, group: 'dpad' },
    { label: 'D-Right', bit: 7, group: 'dpad' },
    { label: 'Analog Up', bit: 19, group: 'stick' },
    { label: 'Analog Down', bit: 18, group: 'stick' },
    { label: 'Analog Left', bit: 17, group: 'stick' },
    { label: 'Analog Right', bit: 16, group: 'stick' },
    { label: 'C-Up', bit: 23, group: 'cbutton' },
    { label: 'C-Down', bit: 22, group: 'cbutton' },
    { label: 'C-Left', bit: 20, group: 'cbutton' },
    { label: 'C-Right', bit: 21, group: 'cbutton' },
  ];

  // ── Toast helper ─────────────────────────────────────────────────
  const showSavedToast = () => {
    // Use play.js toast if available, otherwise create a simple one
    if (window.showToast) {
      window.showToast('Settings saved');
      return;
    }
    const t = el(
      'div',
      {
        style: {
          position: 'fixed',
          bottom: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#1d4ed8',
          color: '#fff',
          padding: '8px 16px',
          borderRadius: '6px',
          fontSize: '13px',
          zIndex: '200',
          opacity: '1',
          transition: 'opacity 0.3s',
        },
      },
      'Settings saved',
    );
    document.body.appendChild(t);
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 300);
    }, 1500);
  };

  const GROUP_LABELS = {
    dpad: 'D-Pad',
    stick: 'Analog Stick',
    cbutton: 'C-Buttons',
  };

  // ── DOM helpers ──────────────────────────────────────────────────
  const el = (tag, attrs, ...children) => {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'className') e.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
        else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
        else e.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else if (c) e.appendChild(c);
    }
    return e;
  };

  // ── Keyboard map helpers ──────────────────────────────────────────
  const getKeyboardMap = () => {
    try {
      const saved = localStorage.getItem('keyboard-mapping');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Object.keys(parsed).length > 0) {
          const map = {};
          for (const k in parsed) map[parseInt(k, 10)] = parsed[k];
          return map;
        }
      }
    } catch (_) {}
    return Object.assign({}, KNShared.DEFAULT_N64_KEYMAP);
  };

  const saveKeyboardMap = (map) => {
    localStorage.setItem('keyboard-mapping', JSON.stringify(map));
  };

  // Invert { keyCode: bitIndex } → { bitIndex: keyCode }
  const invertKeyMap = (map) => {
    const inv = {};
    for (const [kc, bit] of Object.entries(map)) inv[bit] = parseInt(kc, 10);
    return inv;
  };

  // ── Gamepad profile helpers ───────────────────────────────────────
  const getGamepadBindingName = (bit, profile) => {
    if (!profile) return '—';
    // Check digital buttons
    for (const [btnIdx, bitmask] of Object.entries(profile.buttons)) {
      if (bitmask === 1 << bit) return `Btn ${btnIdx}`;
    }
    // Check axis buttons (C-buttons from right stick)
    if (profile.axisButtons) {
      for (const [axIdx, cfg] of Object.entries(profile.axisButtons)) {
        if (cfg.pos & (1 << bit)) return `Axis${axIdx}+`;
        if (cfg.neg & (1 << bit)) return `Axis${axIdx}-`;
      }
    }
    // Analog stick axes
    if (profile.axes) {
      for (const [, cfg] of Object.entries(profile.axes)) {
        if (cfg.bits && (cfg.bits[0] === bit || cfg.bits[1] === bit)) return 'Analog';
      }
    }
    return '—';
  };

  // ── Rebind state ──────────────────────────────────────────────────
  let _rebindCell = null;
  let _rebindType = null; // 'gamepad' | 'keyboard'
  let _rebindBit = null;
  let _rebindKeyHandler = null;
  let _rebindPollId = null;
  let _rebindBaselineAxes = null;

  const cancelRebind = () => {
    if (_rebindCell) {
      _rebindCell.classList.remove('listening');
      _rebindCell.textContent = _rebindCell.dataset.prevText || '—';
    }
    if (_rebindKeyHandler) {
      document.removeEventListener('keydown', _rebindKeyHandler, true);
      _rebindKeyHandler = null;
    }
    if (_rebindPollId) {
      clearInterval(_rebindPollId);
      _rebindPollId = null;
    }
    _rebindCell = null;
    _rebindType = null;
    _rebindBit = null;
    _rebindBaselineAxes = null;
    if (window.KNState) window.KNState.remapActive = false;
  };

  const startRebind = (cell, type, bit) => {
    cancelRebind();
    _rebindCell = cell;
    _rebindType = type;
    _rebindBit = bit;
    cell.dataset.prevText = cell.textContent;
    const isAxisBit = bit >= 16 && bit <= 23;
    cell.textContent = type === 'keyboard' ? 'Press a key...' : isAxisBit ? 'Button or stick...' : 'Press a button...';
    cell.classList.add('listening');
    if (window.KNState) window.KNState.remapActive = true;

    if (type === 'keyboard') {
      _rebindKeyHandler = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          cancelRebind();
          return;
        }
        const kc = e.keyCode;
        const map = getKeyboardMap();
        // Clear old binding for this key (swap behavior)
        for (const [k, v] of Object.entries(map)) {
          if (parseInt(k, 10) === kc) delete map[k];
        }
        // Clear old key for this bit
        for (const [k, v] of Object.entries(map)) {
          if (v === bit) delete map[k];
        }
        map[kc] = bit;
        saveKeyboardMap(map);
        refreshMappingGrid();
        cancelRebind();
      };
      document.addEventListener('keydown', _rebindKeyHandler, true);
    } else {
      // Capture baseline axes so sticks already held don't trigger immediately
      _rebindBaselineAxes = {};
      const initAssignments = GamepadManager.getAssignments();
      const initGpIdx = initAssignments[0]?.gamepadIndex;
      if (initGpIdx !== undefined) {
        const initGps = APISandbox.nativeGetGamepads();
        const initGp = initGps[initGpIdx];
        if (initGp) {
          for (let ai = 0; ai < initGp.axes.length; ai++) {
            _rebindBaselineAxes[ai] = initGp.axes[ai];
          }
        }
      }

      const isStick = bit >= 16 && bit <= 19;
      const isCButton = bit >= 20 && bit <= 23;

      // Poll for gamepad button press or axis movement
      _rebindPollId = setInterval(() => {
        const assignments = GamepadManager.getAssignments();
        const gpIndex = assignments[0]?.gamepadIndex;
        if (gpIndex === undefined) return;
        const gamepads = APISandbox.nativeGetGamepads();
        const gp = gamepads[gpIndex];
        if (!gp) return;

        // Check buttons
        for (let b = 0; b < gp.buttons.length; b++) {
          if (gp.buttons[b].pressed) {
            const activeProfile = GamepadManager.getActiveProfile(0);
            if (activeProfile) {
              const profile = JSON.parse(JSON.stringify(activeProfile.profile));
              // Clear old button binding for this bit
              for (const k of Object.keys(profile.buttons)) {
                if (profile.buttons[k] === 1 << bit) delete profile.buttons[k];
              }
              profile.buttons[b] = 1 << bit;
              // Clear conflicting axis entry for stick bits
              if (isStick && profile.axes) {
                for (const name of Object.keys(profile.axes)) {
                  const cfg = profile.axes[name];
                  if (cfg.bits?.[0] === bit || cfg.bits?.[1] === bit) {
                    delete profile.axes[name];
                  }
                }
              }
              // Clear conflicting axisButton entry for C-button bits
              if (isCButton && profile.axisButtons) {
                for (const idx of Object.keys(profile.axisButtons)) {
                  const cfg = profile.axisButtons[idx];
                  cfg.pos &= ~(1 << bit);
                  cfg.neg &= ~(1 << bit);
                  if (!cfg.pos && !cfg.neg) delete profile.axisButtons[idx];
                }
              }
              GamepadManager.saveGamepadProfile(activeProfile.id, profile);
            }
            refreshMappingGrid();
            cancelRebind();
            return;
          }
        }

        // Check axes for stick and C-button bits
        if (isStick || isCButton) {
          for (let ai = 0; ai < gp.axes.length; ai++) {
            const val = gp.axes[ai];
            const base = _rebindBaselineAxes?.[ai] ?? 0;
            if (Math.abs(val) > 0.5 && Math.abs(val - base) > 0.3) {
              const activeProfile = GamepadManager.getActiveProfile(0);
              if (activeProfile) {
                const profile = JSON.parse(JSON.stringify(activeProfile.profile));
                const isPositive = val > 0;
                // Clear old button binding for this bit
                for (const k of Object.keys(profile.buttons)) {
                  if (profile.buttons[k] === 1 << bit) delete profile.buttons[k];
                }
                if (isStick) {
                  const axisGroup = bit === 16 || bit === 17 ? 'stickX' : 'stickY';
                  if (!profile.axes) profile.axes = {};
                  const existing = profile.axes[axisGroup] || {};
                  const defaultBits = axisGroup === 'stickX' ? [16, 17] : [18, 19];
                  profile.axes[axisGroup] = {
                    index: ai,
                    bits: [
                      isPositive ? bit : (existing.bits?.[0] ?? defaultBits[0]),
                      isPositive ? (existing.bits?.[1] ?? defaultBits[1]) : bit,
                    ],
                  };
                } else {
                  if (!profile.axisButtons) profile.axisButtons = {};
                  // Clear old axisButton for this bit
                  for (const idx of Object.keys(profile.axisButtons)) {
                    const cfg = profile.axisButtons[idx];
                    cfg.pos &= ~(1 << bit);
                    cfg.neg &= ~(1 << bit);
                    if (!cfg.pos && !cfg.neg) delete profile.axisButtons[idx];
                  }
                  if (!profile.axisButtons[ai]) profile.axisButtons[ai] = { pos: 0, neg: 0 };
                  if (isPositive) {
                    profile.axisButtons[ai].pos |= 1 << bit;
                  } else {
                    profile.axisButtons[ai].neg |= 1 << bit;
                  }
                }
                GamepadManager.saveGamepadProfile(activeProfile.id, profile);
              }
              refreshMappingGrid();
              cancelRebind();
              return;
            }
          }
        }
      }, 50);
    }
  };

  // ── Mapping grid ──────────────────────────────────────────────────
  let _mapGridEl = null;

  const refreshMappingGrid = () => {
    if (!_mapGridEl) return;
    _mapGridEl.innerHTML = '';
    populateMappingGrid(_mapGridEl);
  };

  const populateMappingGrid = (grid) => {
    // Column headers
    const headerRow = el(
      'div',
      { className: 'cs-map-header-row' },
      el('span'),
      el('span', { className: 'cs-map-col-label' }, 'Gamepad'),
      el('span', { className: 'cs-map-col-label' }, 'Keyboard'),
    );
    grid.appendChild(headerRow);

    const kbMap = getKeyboardMap();
    const invKb = invertKeyMap(kbMap);
    const activeProfile = GamepadManager.getActiveProfile(0);
    const profile = activeProfile?.profile || null;

    let lastGroup = null;
    for (const btn of N64_BUTTONS) {
      // Group divider
      if (btn.group !== lastGroup && btn.group !== 'face') {
        grid.appendChild(el('div', { className: 'cs-map-group' }, GROUP_LABELS[btn.group] || btn.group));
        lastGroup = btn.group;
      }
      if (btn.group === 'face' && lastGroup === null) lastGroup = 'face';

      // N64 label
      const labelEl = el('span', { className: 'cs-map-label' }, btn.label);

      // Gamepad binding cell
      const gpName = getGamepadBindingName(btn.bit, profile);
      const isCOrStick = btn.group === 'cbutton' || btn.group === 'stick';
      const gpCell = el(
        'div',
        {
          className: 'cs-map-bind' + (isCOrStick ? ' axis-bind' : ''),
          onClick: () => startRebind(gpCell, 'gamepad', btn.bit),
        },
        gpName,
      );

      // Keyboard binding cell
      const kbCode = invKb[btn.bit];
      const kbName = kbCode !== undefined ? keyName(kbCode) : '—';
      const kbCell = el(
        'div',
        {
          className: 'cs-map-bind',
          onClick: () => startRebind(kbCell, 'keyboard', btn.bit),
        },
        kbName,
      );

      grid.appendChild(labelEl);
      grid.appendChild(gpCell);
      grid.appendChild(kbCell);
    }
  };

  const buildMappingSection = (parent) => {
    const header = el(
      'div',
      { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
      el('div', { className: 'cs-section-label', style: { margin: '0' } }, 'Button Mapping'),
      el(
        'button',
        { className: 'cs-quick-btn', onClick: () => window.ControllerSettings.startQuickSetup?.() },
        'Quick Setup ▸',
      ),
    );
    parent.appendChild(header);

    _mapGridEl = el('div', { className: 'cs-map-grid' });
    populateMappingGrid(_mapGridEl);
    parent.appendChild(_mapGridEl);
  };

  // ── Stick Visualization ───────────────────────────────────────────
  let _vizLeftDot = null;
  let _vizLeftDzRing = null;
  let _vizLeftRangeRing = null;
  let _vizLeftCoords = null;
  let _vizRightDot = null;
  let _vizRightDzRing = null;
  let _vizRightCoords = null;
  let _vizNoGamepad = null;
  let _vizTrailDots = [];

  const buildVizSection = (parent) => {
    parent.appendChild(el('div', { className: 'cs-section-label' }, 'Live Stick Preview'));

    const wrap = el('div', { className: 'cs-viz-wrap' });
    const row = el('div', { className: 'cs-viz-row' });

    // Left stick (120×120)
    const leftDiv = el('div', { style: { textAlign: 'center' } });
    leftDiv.appendChild(el('div', { className: 'cs-viz-label' }, 'Left Stick'));
    const leftSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    leftSvg.setAttribute('width', '120');
    leftSvg.setAttribute('height', '120');
    leftSvg.innerHTML = `
      <circle cx="60" cy="60" r="56" fill="none" stroke="#1e293b" stroke-width="1.5"/>
      <circle cx="60" cy="60" r="37" fill="none" stroke="#334155" stroke-width="1" stroke-dasharray="3,3" class="cs-range-ring"/>
      <circle cx="60" cy="60" r="8" fill="rgba(239,68,68,0.08)" stroke="#ef4444" stroke-width="1" stroke-opacity="0.4" class="cs-dz-ring"/>
      <line x1="60" y1="8" x2="60" y2="112" stroke="#1e293b" stroke-width="0.5"/>
      <line x1="8" y1="60" x2="112" y2="60" stroke="#1e293b" stroke-width="0.5"/>
      <circle cx="60" cy="60" r="2.5" fill="#3b82f6" opacity="0.2" class="cs-trail-2"/>
      <circle cx="60" cy="60" r="3" fill="#3b82f6" opacity="0.4" class="cs-trail-1"/>
      <circle cx="60" cy="60" r="5" fill="#3b82f6" class="cs-dot"/>
    `;
    _vizLeftDot = leftSvg.querySelector('.cs-dot');
    _vizLeftDzRing = leftSvg.querySelector('.cs-dz-ring');
    _vizLeftRangeRing = leftSvg.querySelector('.cs-range-ring');
    _vizTrailDots = [leftSvg.querySelector('.cs-trail-1'), leftSvg.querySelector('.cs-trail-2')];
    leftDiv.appendChild(leftSvg);
    _vizLeftCoords = el('div', { className: 'cs-viz-coords' }, 'X: 0  Y: 0');
    leftDiv.appendChild(_vizLeftCoords);

    // C-stick (80×80)
    const rightDiv = el('div', { style: { textAlign: 'center' } });
    rightDiv.appendChild(el('div', { className: 'cs-viz-label' }, 'C-Stick'));
    const rightSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    rightSvg.setAttribute('width', '80');
    rightSvg.setAttribute('height', '80');
    rightSvg.innerHTML = `
      <circle cx="40" cy="40" r="36" fill="none" stroke="#1e293b" stroke-width="1.5"/>
      <circle cx="40" cy="40" r="24" fill="none" stroke="#334155" stroke-width="1" stroke-dasharray="3,3"/>
      <circle cx="40" cy="40" r="5" fill="rgba(239,68,68,0.08)" stroke="#ef4444" stroke-width="1" stroke-opacity="0.4" class="cs-dz-ring"/>
      <line x1="40" y1="6" x2="40" y2="74" stroke="#1e293b" stroke-width="0.5"/>
      <line x1="6" y1="40" x2="74" y2="40" stroke="#1e293b" stroke-width="0.5"/>
      <circle cx="40" cy="40" r="4" fill="#64748b" class="cs-dot"/>
    `;
    _vizRightDot = rightSvg.querySelector('.cs-dot');
    _vizRightDzRing = rightSvg.querySelector('.cs-dz-ring');
    rightDiv.appendChild(rightSvg);
    _vizRightCoords = el('div', { className: 'cs-viz-coords', style: { marginTop: '14px' } }, 'X: 0  Y: 0');
    rightDiv.appendChild(_vizRightCoords);

    row.appendChild(leftDiv);
    row.appendChild(rightDiv);
    wrap.appendChild(row);

    _vizNoGamepad = el('div', { className: 'cs-no-gamepad', style: { display: 'none' } }, 'No gamepad detected');
    wrap.appendChild(_vizNoGamepad);
    parent.appendChild(wrap);
  };

  // Trail history for left stick
  let _trailHistory = [
    { x: 60, y: 60 },
    { x: 60, y: 60 },
  ];

  // Read raw hardware stick axes (bypasses the analog pipeline)
  const readRawAxes = () => {
    const activeProfile = GamepadManager.getActiveProfile(0);
    if (!activeProfile) return null;
    const gpIndex = GamepadManager.getAssignments()[0]?.gamepadIndex;
    if (gpIndex === undefined) return null;
    const gamepads = APISandbox.nativeGetGamepads();
    const gp = gamepads[gpIndex];
    if (!gp) return null;
    const profile = activeProfile.profile;
    const axes = profile.axes || {};

    // Find C-stick axes from profile.axisButtons (fallback to 2,3)
    let cxIdx = -1,
      cyIdx = -1;
    const axBtn = profile.axisButtons;
    if (axBtn) {
      for (const [idx, cfg] of Object.entries(axBtn)) {
        const ai = parseInt(idx, 10);
        if (cfg.pos & ((1 << 20) | (1 << 21)) || cfg.neg & ((1 << 20) | (1 << 21))) cxIdx = ai;
        if (cfg.pos & ((1 << 22) | (1 << 23)) || cfg.neg & ((1 << 22) | (1 << 23))) cyIdx = ai;
      }
    }
    if (cxIdx < 0) cxIdx = 2;
    if (cyIdx < 0) cyIdx = 3;

    return {
      lx: axes.stickX && axes.stickX.index < gp.axes.length ? gp.axes[axes.stickX.index] : 0,
      ly: axes.stickY && axes.stickY.index < gp.axes.length ? gp.axes[axes.stickY.index] : 0,
      cx: cxIdx < gp.axes.length ? gp.axes[cxIdx] : 0,
      cy: cyIdx < gp.axes.length ? gp.axes[cyIdx] : 0,
    };
  };

  const updateViz = () => {
    if (!_isOpen) return;
    _vizRafId = APISandbox.nativeRAF(updateViz);

    const settings = GamepadManager.getCurrentSettings();

    // Update deadzone + range rings
    const dzRadiusL = Math.round(56 * settings.deadzones.lx);
    _vizLeftDzRing?.setAttribute('r', String(Math.max(dzRadiusL, 2)));
    const rangeRadius = Math.round(56 * (settings.range / 100));
    _vizLeftRangeRing?.setAttribute('r', String(rangeRadius));
    const dzRadiusR = Math.round(36 * settings.deadzones.cx);
    _vizRightDzRing?.setAttribute('r', String(Math.max(dzRadiusR, 2)));

    const raw = readRawAxes();
    if (!raw) {
      if (_vizNoGamepad) _vizNoGamepad.style.display = '';
      return;
    }
    if (_vizNoGamepad) _vizNoGamepad.style.display = 'none';

    // Map raw [-1, 1] to SVG coords
    const lx = 60 + raw.lx * 52;
    const ly = 60 + raw.ly * 52;

    // Update trail
    _trailHistory.push({ x: lx, y: ly });
    if (_trailHistory.length > 3) _trailHistory.shift();
    if (_vizTrailDots[0]) {
      _vizTrailDots[0].setAttribute('cx', String(_trailHistory[1]?.x ?? 60));
      _vizTrailDots[0].setAttribute('cy', String(_trailHistory[1]?.y ?? 60));
    }
    if (_vizTrailDots[1]) {
      _vizTrailDots[1].setAttribute('cx', String(_trailHistory[0]?.x ?? 60));
      _vizTrailDots[1].setAttribute('cy', String(_trailHistory[0]?.y ?? 60));
    }

    _vizLeftDot?.setAttribute('cx', String(lx));
    _vizLeftDot?.setAttribute('cy', String(ly));
    const fmtPct = (v) => `${v < 0 ? '' : ' '}${String(Math.round(v * 100)).padStart(3)}%`;
    if (_vizLeftCoords) _vizLeftCoords.textContent = `X:${fmtPct(raw.lx)}  Y:${fmtPct(raw.ly)}`;

    // C-stick
    const cx = 40 + raw.cx * 33;
    const cy = 40 + raw.cy * 33;
    _vizRightDot?.setAttribute('cx', String(cx));
    _vizRightDot?.setAttribute('cy', String(cy));
    if (_vizRightCoords) _vizRightCoords.textContent = `X:${fmtPct(raw.cx)}  Y:${fmtPct(raw.cy)}`;
  };

  const startVizLoop = () => {
    stopVizLoop();
    _vizRafId = APISandbox.nativeRAF(updateViz);
  };

  const stopVizLoop = () => {
    if (_vizRafId) {
      APISandbox.nativeCancelRAF(_vizRafId);
      _vizRafId = null;
    }
  };

  // ── Per-game scope ────────────────────────────────────────────────
  let _perGameCheckbox = null;
  const getScope = () => (_perGameCheckbox?.checked ? 'game' : 'global');

  // ── Analog tuning sliders ─────────────────────────────────────────
  const buildAnalogSection = (parent) => {
    parent.appendChild(el('div', { className: 'cs-section-label' }, 'Analog Tuning'));

    const settings = GamepadManager.getCurrentSettings();

    // Range slider
    const rangeVal = el('span', { className: 'cs-slider-val', style: { color: '#3b82f6' } }, `${settings.range}%`);
    const rangeInput = el('input', {
      type: 'range',
      min: '10',
      max: '100',
      value: String(settings.range),
      step: '1',
      onInput: (e) => {
        const v = parseInt(e.target.value, 10);
        rangeVal.textContent = `${v}%`;
        GamepadManager.setSetting('kn-analog-range', v, getScope());
      },
    });
    parent.appendChild(
      el(
        'div',
        { className: 'cs-slider-row' },
        el('div', { className: 'cs-slider-header' }, el('span', { className: 'cs-slider-name' }, 'Range'), rangeVal),
        rangeInput,
        el('div', { className: 'cs-slider-hint' }, 'Max output magnitude (66% = ±83 N64 units)'),
      ),
    );

    // Sensitivity slider
    const sensVal = el(
      'span',
      { className: 'cs-slider-val', style: { color: '#a78bfa' } },
      `${settings.sensitivity.toFixed(1)}×`,
    );
    const sensInput = el('input', {
      type: 'range',
      min: '50',
      max: '200',
      value: String(Math.round(settings.sensitivity * 100)),
      step: '5',
      onInput: (e) => {
        const v = parseInt(e.target.value, 10) / 100;
        sensVal.textContent = `${v.toFixed(1)}×`;
        GamepadManager.setSetting('kn-analog-sensitivity', v, getScope());
      },
    });
    parent.appendChild(
      el(
        'div',
        { className: 'cs-slider-row' },
        el(
          'div',
          { className: 'cs-slider-header' },
          el('span', { className: 'cs-slider-name' }, 'Sensitivity'),
          sensVal,
        ),
        sensInput,
        el(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between' } },
          el('span', { className: 'cs-slider-hint' }, 'Gentle'),
          el('span', { className: 'cs-slider-hint' }, 'Linear'),
          el('span', { className: 'cs-slider-hint' }, 'Aggressive'),
        ),
      ),
    );
  };

  // ── Deadzone sliders ──────────────────────────────────────────────
  const buildDzSlider = (label, key, value) => {
    const val = el('span', { className: 'cs-dz-val' }, value.toFixed(2));
    const input = el('input', {
      type: 'range',
      min: '0',
      max: '50',
      value: String(Math.round(value * 100)),
      step: '1',
      style: { flex: '1' },
      onInput: (e) => {
        const v = parseInt(e.target.value, 10) / 100;
        val.textContent = v.toFixed(2);
        GamepadManager.setSetting(key, v, getScope());
      },
    });
    return el('div', { className: 'cs-dz-row' }, el('span', { className: 'cs-dz-axis' }, label), input, val);
  };

  const buildDeadzoneSection = (parent) => {
    parent.appendChild(el('div', { className: 'cs-section-label' }, 'Deadzone'));

    const settings = GamepadManager.getCurrentSettings();

    const leftCard = el(
      'div',
      { className: 'cs-dz-card' },
      el('div', { className: 'cs-dz-title' }, 'Left Stick'),
      buildDzSlider('X', 'kn-deadzone-lx', settings.deadzones.lx),
      buildDzSlider('Y', 'kn-deadzone-ly', settings.deadzones.ly),
    );
    parent.appendChild(leftCard);

    const rightCard = el(
      'div',
      { className: 'cs-dz-card' },
      el('div', { className: 'cs-dz-title' }, 'C-Stick'),
      buildDzSlider('X', 'kn-deadzone-cx', settings.deadzones.cx),
      buildDzSlider('Y', 'kn-deadzone-cy', settings.deadzones.cy),
    );
    parent.appendChild(rightCard);
  };

  // ── Footer ────────────────────────────────────────────────────────
  const buildFooter = (parent) => {
    _perGameCheckbox = el('input', { type: 'checkbox' });
    if (window.KNState?.romHash) {
      const testKey = `kn-gamepad:${KNState.romHash}:kn-analog-range`;
      _perGameCheckbox.checked = localStorage.getItem(testKey) !== null;
    }

    const footer = el(
      'div',
      { className: 'cs-footer' },
      el('label', null, _perGameCheckbox, 'Save for this game only'),
      el(
        'div',
        { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        el('button', { className: 'cs-footer-reset', onClick: onReset }, 'Reset'),
        el(
          'button',
          {
            className: 'cs-quick-btn',
            onClick: () => {
              showSavedToast();
              close();
            },
          },
          'Done',
        ),
      ),
    );
    parent.appendChild(footer);
  };

  const onReset = () => {
    if (!confirm('Reset all controller settings to defaults?')) return;
    const keys = [
      'kn-analog-range',
      'kn-analog-sensitivity',
      'kn-deadzone-lx',
      'kn-deadzone-ly',
      'kn-deadzone-cx',
      'kn-deadzone-cy',
    ];
    const hash = window.KNState?.romHash;
    for (const k of keys) {
      localStorage.removeItem(k);
      if (hash) localStorage.removeItem(`kn-gamepad:${hash}:${k}`);
    }
    localStorage.removeItem('keyboard-mapping');
    const activeProfile = GamepadManager.getActiveProfile(0);
    if (activeProfile) GamepadManager.clearGamepadProfile(activeProfile.id);
    rebuildPanel();
  };

  // ── Build panel ──────────────────────────────────────────────────
  const buildPanel = () => {
    // Backdrop (click-outside-to-close)
    _backdrop = el('div', { id: 'cs-backdrop', onClick: () => close() });
    document.body.appendChild(_backdrop);

    _panel = el('div', { id: 'controller-settings' });

    // Header
    _panel.appendChild(
      el(
        'div',
        { className: 'cs-header' },
        el('span', { className: 'cs-title' }, 'Controller Settings'),
        el('button', { className: 'cs-close', onClick: () => close() }, '\u00d7'),
      ),
    );

    // Gamepad status indicator
    const activeProfile = GamepadManager.getActiveProfile(0);
    const statusText = activeProfile
      ? `${activeProfile.id.substring(0, 36)} (${activeProfile.profileName})`
      : 'No controller detected';
    const statusColor = activeProfile ? '#6f6' : '#475569';
    _panel.appendChild(
      el(
        'div',
        { style: { fontSize: '11px', color: statusColor, marginBottom: '12px', textAlign: 'center' } },
        statusText,
      ),
    );

    // Sections
    buildMappingSection(_panel);
    _panel.appendChild(el('div', { className: 'cs-sep' }));
    buildVizSection(_panel);
    _panel.appendChild(el('div', { className: 'cs-sep' }));
    buildAnalogSection(_panel);
    _panel.appendChild(el('div', { className: 'cs-sep' }));
    buildDeadzoneSection(_panel);
    buildFooter(_panel);

    document.body.appendChild(_panel);
  };

  const rebuildPanel = () => {
    const wasOpen = _isOpen;
    if (_panel) {
      _panel.remove();
      _panel = null;
    }
    if (_backdrop) {
      _backdrop.remove();
      _backdrop = null;
    }
    _mapGridEl = null;
    _vizLeftDot = null;
    _vizLeftDzRing = null;
    _vizLeftRangeRing = null;
    _vizLeftCoords = null;
    _vizRightDot = null;
    _vizRightDzRing = null;
    _vizRightCoords = null;
    _vizNoGamepad = null;
    _vizTrailDots = [];
    _trailHistory = [
      { x: 60, y: 60 },
      { x: 60, y: 60 },
    ];
    if (wasOpen) open();
  };

  // ── Open / Close ─────────────────────────────────────────────────
  const open = () => {
    if (!_panel) buildPanel();
    _panel.classList.add('open');
    _backdrop.classList.add('visible');
    _isOpen = true;
    if (window.KNState) window.KNState.remapActive = true;
    startVizLoop();
  };

  const close = () => {
    if (!_panel) return;
    _panel.classList.remove('open');
    _backdrop.classList.remove('visible');
    _isOpen = false;
    if (window.KNState) window.KNState.remapActive = false;
    stopVizLoop();
    cancelRebind();
  };

  const toggle = () => {
    _isOpen ? close() : open();
  };

  // ── Quick Setup integration ──────────────────────────────────────
  const startQuickSetup = () => {
    if (window._startIngameRemap) window._startIngameRemap();
  };

  // ── Gamepad hot-plug — rebuild panel when controllers change ────
  // Defer with setTimeout so GamepadManager.poll() (which also listens
  // for gamepadconnected) finishes processing before we rebuild the UI.
  const _onGamepadChange = () => {
    setTimeout(() => {
      if (_isOpen) rebuildPanel();
    }, 0);
  };
  window.addEventListener('gamepadconnected', _onGamepadChange);
  window.addEventListener('gamepaddisconnected', _onGamepadChange);

  // ── Escape key handler ───────────────────────────────────────────
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && _isOpen) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    },
    true,
  );

  // ── Public API ───────────────────────────────────────────────────
  window.ControllerSettings = { open, close, toggle, startQuickSetup, _refreshGrid: refreshMappingGrid };
})();
