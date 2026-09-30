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
 *   axisRange:   raw axis value that means full deflection (optional, default 1)
 *   axisCenter:  'auto' = sample the resting position of the stick axes once per connection and
 *                subtract it (optional)
 *   deadzone:    threshold for axis activation
 *
 * posBit / pos record the direction a positive axis value means (Standard: right, down);
 * a pad whose +Y is up lists the Up bit first. See axisTransform().
 */
(function () {
  'use strict';

  // Use APISandbox for native getGamepads (lockstep overrides the global).
  const _nativeGetGamepads = () => APISandbox.nativeGetGamepads();

  // ── Profile Registry ─────────────────────────────────────────────────
  // Ordered array. First match wins. Raphnet and Switch 2 Pro before Standard (fallback).

  const _STANDARD_MAPPING = {
    buttons: {
      0: 1 << 0, // face bottom (A/Cross) → N64 A (JOYPAD_B)
      1: 1 << 1, // face right (B/Circle) → N64 B (JOYPAD_Y)
      9: 1 << 3, // start → Start
      12: 1 << 4, // dpad up → D-Up
      13: 1 << 5, // dpad down → D-Down
      14: 1 << 6, // dpad left → D-Left
      15: 1 << 7, // dpad right → D-Right
      4: 1 << 10, // LB → L (JOYPAD_L)
      5: 1 << 11, // RB → R (JOYPAD_R)
      6: 1 << 12, // LT → Z (JOYPAD_L2)
    },
    axes: {
      stickX: { index: 0, bits: [16, 17] }, // X+→right(16), X-→left(17)
      stickY: { index: 1, bits: [18, 19] }, // Y+→down(18), Y-→up(19)
    },
    axisButtons: {
      2: { pos: 1 << 21, neg: 1 << 20 }, // R stick X: pos(right)→CRight(21), neg(left)→CLeft(20) — core inverts X
      3: { pos: 1 << 22, neg: 1 << 23 }, // R stick Y: pos→CDown(22), neg→CUp(23)
    },
    deadzone: 0.15,
  };

  const PROFILES = [
    {
      name: 'Raphnet N64',
      match: (id) => id.includes('Raphnet') || id.includes('0964'),
      // Uses Standard mapping until verified with hardware — update when tested
      ..._STANDARD_MAPPING,
    },
    {
      name: 'Switch 2 Pro',
      // Chrome: "... (Vendor: 057e Product: 2069)"; Firefox: "057e-2069-..." ("57e-2069-..." on macOS).
      // `mapping` is the Gamepad API's own flag: a browser that maps this pad natively as a standard
      // gamepad gets the Standard profile instead.
      match: (id, mapping) => /\b0?57e\b/i.test(id) && /\b2069\b/.test(id) && mapping !== 'standard',
      // Raw (non-standard) HID layout, buttons in HID usage order; positional like Standard:
      // bottom face (B) → N64 A, right face (A) → N64 B. X/Y, stick clicks, Home, Capture,
      // GR/GL, C are left unmapped (like Standard leaves X/Y). ZL/ZR are digital.
      // Measured on hardware (Chrome, macOS): raw HID (mapping ""), 21 buttons, 6 axes exposed as
      // [X, Y, unused, Rx, unused, Rz]. +Y is UP on both sticks (opposite of Standard), and full
      // deflection only travels about 0.75-0.85 from the resting position, hence axisRange. The
      // sticks rest off-centre (measured LY +0.105, RX +0.075), hence axisCenter.
      buttons: {
        0: 1 << 0, // B (bottom face) → N64 A
        1: 1 << 1, // A (right face) → N64 B
        6: 1 << 3, // + → Start
        11: 1 << 4, // dpad up → D-Up
        8: 1 << 5, // dpad down → D-Down
        10: 1 << 6, // dpad left → D-Left
        9: 1 << 7, // dpad right → D-Right
        12: 1 << 10, // L → L
        4: 1 << 11, // R → R
        13: 1 << 12, // ZL → Z
      },
      axes: {
        stickX: { index: 0, bits: [16, 17] }, // X+→right(16), X-→left(17)
        stickY: { index: 1, bits: [19, 18] }, // Y+→up(19), Y-→down(18)
      },
      axisButtons: {
        3: { pos: 1 << 21, neg: 1 << 20 }, // R stick X: pos(right)→CRight(21), neg(left)→CLeft(20)
        5: { pos: 1 << 23, neg: 1 << 22 }, // R stick Y: pos(up)→CUp(23), neg(down)→CDown(22)
      },
      axisRange: 0.8,
      axisCenter: 'auto',
      deadzone: _STANDARD_MAPPING.deadzone,
    },
    {
      name: 'Standard',
      match: () => true,
      ..._STANDARD_MAPPING,
    },
  ];

  // ── Analog Pipeline ────────────────────────────────────────────────
  const _DEFAULT_DEADZONE = 0.15;
  const _DEFAULT_RANGE = 66; // percentage — community standard matching N-Rage/RMG-K

  function _gameKey(key) {
    const hash = window.KNState?.romHash;
    return hash ? `kn-gamepad:${hash}:${key}` : null;
  }

  function _getSetting(key, parse, validate, fallback) {
    try {
      // Per-game override first
      const gk = _gameKey(key);
      if (gk) {
        const gv = parse(KNState.safeGet('localStorage', gk));
        if (validate(gv)) return gv;
      }
      // Global setting
      const v = parse(KNState.safeGet('localStorage', key));
      if (validate(v)) return v;
    } catch (_) {}
    return fallback;
  }

  let _cachedRange = null;
  let _cachedRangeTime = 0;
  const _RANGE_CACHE_MS = 1000;

  function _getRange() {
    const now = performance.now();
    if (_cachedRange !== null && now - _cachedRangeTime < _RANGE_CACHE_MS) return _cachedRange;
    _cachedRange = _getSetting(
      'kn-analog-range',
      (s) => parseInt(s, 10),
      (v) => v >= 0 && v <= 100,
      _DEFAULT_RANGE,
    );
    _cachedRangeTime = now;
    return _cachedRange;
  }

  function _getDeadzone(key) {
    return _getSetting(key, parseFloat, (v) => v >= 0 && v <= 1, _DEFAULT_DEADZONE);
  }

  function _getSensitivity() {
    return _getSetting('kn-analog-sensitivity', parseFloat, (v) => v >= 0.5 && v <= 2.0, 1.0);
  }

  function _analogScale(value, dz) {
    const sign = Math.sign(value);
    const abs = Math.abs(value);
    if (abs < dz) return 0;
    const n64Max = Math.floor(127 * (_getRange() / 100));
    const scaled = (abs - dz) / (1 - dz);
    const sens = _getSensitivity();
    const curved = sens === 1.0 ? scaled : Math.pow(scaled, 1 / sens);
    return sign * Math.min(Math.round(curved * n64Max), n64Max);
  }

  function _digitalSnap(value, dz) {
    const abs = Math.abs(value);
    if (abs < dz) return 0;
    return Math.sign(value) * Math.floor(127 * (_getRange() / 100));
  }

  // Returns (rawAxisValue, center = 0) => value in [-1, 1] for name 'lx' | 'ly' | 'cx' | 'cy', in the Standard
  // convention (+X = right, +Y = down) that _analogScale/_digitalSnap and the N64 output expect.
  // A profile records what a positive/negative axis value means in axes.stickX/stickY bits
  // [pos, neg] and axisButtons pos/neg (the remap wizard writes them), so an axis whose positive
  // end is the other direction is flipped. Missing data keeps Standard polarity. The rest position
  // (center, see axisCenter) is subtracted, then axisRange (the raw value of full deflection) is divided
  // out so pads that top out below 1 still reach the full N64 range.
  function axisTransform(profile, name) {
    let sign = 1;
    if (name === 'lx' || name === 'ly') {
      const bits = profile.axes?.[name === 'lx' ? 'stickX' : 'stickY']?.bits;
      const [stdPosBit, stdNegBit] = name === 'lx' ? [16, 17] : [18, 19]; // right/left, down/up
      if (bits?.[0] === stdNegBit || bits?.[1] === stdPosBit) sign = -1;
    } else {
      // Same entry readGamepad drives the C-stick from: the last one touching bits 20/21 (X) or 22/23 (Y).
      const mask = name === 'cx' ? (1 << 20) | (1 << 21) : (1 << 22) | (1 << 23);
      const stdPosBit = name === 'cx' ? 1 << 21 : 1 << 22; // C-Right / C-Down
      let cfg;
      for (const c of Object.values(profile.axisButtons ?? {})) if (c.pos & mask || c.neg & mask) cfg = c;
      if (cfg && !(cfg.pos & stdPosBit) && (cfg.pos !== 0 || cfg.neg & stdPosBit)) sign = -1;
    }
    const range = profile.axisRange ?? 1;
    return (raw, center = 0) => sign * Math.max(-1, Math.min(1, (raw - center) / range));
  }

  // ── State ────────────────────────────────────────────────────────────

  let _pollInterval = null;
  let _playerSlot = 0;
  let _onUpdate = null;

  // { playerSlot: gamepadIndex }
  let _assignments = {};

  // { gamepadIndex: { id, profileName, profile } }
  let _detected = {};

  // Previous gamepad IDs for change detection
  let _prevIds = {};

  // Resting position of the stick axes of profiles with axisCenter: 'auto'.
  // { gamepadIndex: { axisIndex: restValue } }, and the reading awaiting a second, matching poll.
  const _centers = {};
  const _centerCandidates = {};
  const _CENTER_MAX = 0.15; // a stick further from 0 than this is held, never at rest
  const _CENTER_STEADY = 0.02; // two readings this close mean the stick is not moving

  // ── Profile Resolution ───────────────────────────────────────────────

  function resolveProfile(id, mapping) {
    // Check localStorage for custom profile
    try {
      const saved = KNState.safeGet('localStorage', `gamepad-profile:${id}`);
      if (saved) {
        const profile = JSON.parse(saved);
        profile.name = 'Custom';
        profile.match = () => true;
        return profile;
      }
    } catch (_) {}

    // Fall through to built-in profiles
    return PROFILES.find((p) => p.match(id, mapping)) ?? PROFILES[PROFILES.length - 1];
  }

  // Rest position of an axis (0 until sampled, or for profiles without axisCenter: 'auto').
  function axisCenter(gpIndex, axisIndex) {
    return _centers[gpIndex]?.[axisIndex] ?? 0;
  }

  // For profiles with axisCenter: 'auto', sample the stick axes' resting position once per connection.
  // Called every poll until it succeeds. It only counts when every stick is near 0 and two polls in a
  // row agree, so a stick held away from rest never becomes the centre. All axes are sampled together.
  function _updateCenter(i, gp, profile) {
    if (profile.axisCenter !== 'auto' || _centers[i]) return;
    const axes = [profile.axes?.stickX?.index, profile.axes?.stickY?.index, ...Object.keys(profile.axisButtons ?? {})]
      .map(Number)
      .filter((a) => a < gp.axes.length);
    const values = axes.map((a) => gp.axes[a]);
    if (values.every((v) => v === 0)) return; // no report yet: a real stick never rests at exactly 0 on every axis
    if (values.some((v) => Math.abs(v) > _CENTER_MAX)) {
      delete _centerCandidates[i];
      return;
    }
    const prev = _centerCandidates[i];
    if (prev && values.every((v, n) => Math.abs(v - prev[n]) <= _CENTER_STEADY)) {
      _centers[i] = Object.fromEntries(axes.map((a, n) => [a, values[n]]));
      delete _centerCandidates[i];
    } else {
      _centerCandidates[i] = values;
    }
  }

  // ── Polling / Scanning ───────────────────────────────────────────────

  function poll() {
    const gamepads = _nativeGetGamepads();
    let changed = false;
    const currentIds = {};

    // Scan all gamepad slots
    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (!gp) {
        // Gamepad gone — remove if was detected
        if (_detected[i]) {
          // Remove assignment if this gamepad was assigned
          for (const slot of Object.keys(_assignments)) {
            if (_assignments[slot] === i) {
              delete _assignments[slot];
            }
          }
          delete _detected[i];
          delete _centers[i];
          delete _centerCandidates[i];
          changed = true;
        }
        continue;
      }

      currentIds[i] = gp.id;

      // New or changed gamepad
      if (!_detected[i] || _prevIds[i] !== gp.id) {
        const profile = resolveProfile(gp.id, gp.mapping);
        _detected[i] = { id: gp.id, mapping: gp.mapping, profileName: profile.name, profile: profile };
        delete _centers[i];
        delete _centerCandidates[i];
        changed = true;

        // Auto-assign to player slot if unassigned
        if (_assignments[_playerSlot] === undefined) {
          _assignments[_playerSlot] = i;
        }
      }

      _updateCenter(i, gp, _detected[i].profile);
    }

    _prevIds = currentIds;

    if (changed && _onUpdate) {
      _onUpdate();
    }
  }

  // ── Read Gamepad ─────────────────────────────────────────────────────

  function readGamepad(slot) {
    const gpIndex = _assignments[slot];
    if (gpIndex === undefined) return null;

    const gp = _nativeGetGamepads()[gpIndex];
    if (!gp) return null;

    const entry = _detected[gpIndex];
    if (!entry) return null;

    const profile = entry.profile;
    let buttons = 0;

    // Map buttons (digital — unchanged)
    for (const [btnIdx, bitmask] of Object.entries(profile.buttons)) {
      const idx = parseInt(btnIdx, 10);
      if (idx < gp.buttons.length && gp.buttons[idx].pressed) {
        buttons |= bitmask;
      }
    }

    // Axis value in [-1, 1]: polarity, rest position and range applied (see axisTransform)
    const readAxis = (name, axisIndex) =>
      axisTransform(profile, name)(gp.axes[axisIndex], axisCenter(gpIndex, axisIndex));

    // Left stick — true analog via three-stage pipeline (per-axis deadzone)
    let lx = 0,
      ly = 0;
    if (profile.axes) {
      const axX = profile.axes.stickX;
      const axY = profile.axes.stickY;
      if (axX && axX.index < gp.axes.length) {
        lx = _analogScale(readAxis('lx', axX.index), _getDeadzone('kn-deadzone-lx'));
      }
      if (axY && axY.index < gp.axes.length) {
        ly = _analogScale(readAxis('ly', axY.index), _getDeadzone('kn-deadzone-ly'));
      }
    }

    // C-stick — digital snap (N64 C-buttons are on/off, per-axis deadzone)
    let cx = 0,
      cy = 0;
    const axBtn = profile.axisButtons;
    if (axBtn) {
      for (const [idx, cfg] of Object.entries(axBtn)) {
        const ai = parseInt(idx, 10);
        if (ai >= gp.axes.length) continue;
        // C-Left(20)/C-Right(21) → X axis, C-Down(22)/C-Up(23) → Y axis
        if (cfg.pos & ((1 << 20) | (1 << 21)) || cfg.neg & ((1 << 20) | (1 << 21))) {
          cx = _digitalSnap(readAxis('cx', ai), _getDeadzone('kn-deadzone-cx'));
        }
        if (cfg.pos & ((1 << 22) | (1 << 23)) || cfg.neg & ((1 << 22) | (1 << 23))) {
          cy = _digitalSnap(readAxis('cy', ai), _getDeadzone('kn-deadzone-cy'));
        }
      }
    }

    // Digital C-button fallback: when C-buttons are remapped to digital
    // buttons, bits 20-23 end up in the buttons bitmask but applyInputToWasm
    // only reads cx/cy for C-stick. Convert bitmask bits to cx/cy values.
    if (cx === 0) {
      const cr = buttons & (1 << 20); // C-Right → positive cx
      const cl = buttons & (1 << 21); // C-Left  → negative cx
      if (cr && !cl) cx = Math.floor(127 * (_getRange() / 100));
      else if (cl && !cr) cx = -Math.floor(127 * (_getRange() / 100));
    }
    if (cy === 0) {
      const cd = buttons & (1 << 22); // C-Down → positive cy
      const cu = buttons & (1 << 23); // C-Up   → negative cy
      if (cd && !cu) cy = Math.floor(127 * (_getRange() / 100));
      else if (cu && !cd) cy = -Math.floor(127 * (_getRange() / 100));
    }

    return { buttons, lx, ly, cx, cy };
  }

  // Human-readable name for a gamepad id: drops Chrome's trailing "(STANDARD GAMEPAD Vendor: … Product: …)"
  // and Firefox's leading "045e-0b13-" vendor/product prefix.
  function displayName(id) {
    const name = id
      .replace(/^[0-9a-f]{1,4}-[0-9a-f]{1,4}-/i, '')
      .replace(/\s*\((?:XInput )?(?:STANDARD GAMEPAD|Vendor:)[^)]*\)\s*$/, '')
      .trim();
    return name || id;
  }

  // ── Public API ───────────────────────────────────────────────────────

  window.GamepadManager = {
    start: (opts) => {
      opts = opts ?? {};
      _playerSlot = opts.playerSlot ?? 0;
      _onUpdate = opts.onUpdate ?? null;

      // Immediate first poll
      poll();

      // Also listen for browser events for faster response
      window.addEventListener('gamepadconnected', poll);
      window.addEventListener('gamepaddisconnected', poll);

      // Polling loop as source of truth (500ms for faster detection)
      if (_pollInterval) clearInterval(_pollInterval);
      _pollInterval = setInterval(poll, 500);
    },

    stop: () => {
      if (_pollInterval) {
        clearInterval(_pollInterval);
        _pollInterval = null;
      }
      window.removeEventListener('gamepadconnected', poll);
      window.removeEventListener('gamepaddisconnected', poll);
    },

    readGamepad: readGamepad,
    axisTransform: axisTransform,
    axisCenter: axisCenter,
    displayName: displayName,

    hasGamepad: (slot) => {
      const gpIndex = _assignments[slot];
      return gpIndex !== undefined && !!_detected[gpIndex];
    },

    getAssignments: () => {
      const result = {};
      for (const [slot, gpIndex] of Object.entries(_assignments)) {
        const entry = _detected[gpIndex];
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

    reassignSlot: (slot, gamepadIndex) => {
      if (_detected[gamepadIndex]) {
        _assignments[slot] = gamepadIndex;
        if (_onUpdate) _onUpdate();
      }
    },

    getDetected: () => {
      return Object.entries(_detected).map(([idx, entry]) => ({
        index: parseInt(idx, 10),
        id: entry.id,
        profileName: entry.profileName,
      }));
    },

    saveGamepadProfile: (gamepadId, profile) => {
      try {
        KNState.safeSet('localStorage', `gamepad-profile:${gamepadId}`, JSON.stringify(profile));
      } catch (_) {}
      // Re-resolve profile for this gamepad
      for (const entry of Object.values(_detected)) {
        if (entry.id === gamepadId) {
          const resolved = resolveProfile(gamepadId, entry.mapping);
          entry.profile = resolved;
          entry.profileName = resolved.name;
        }
      }
      if (_onUpdate) _onUpdate();
    },

    clearGamepadProfile: (gamepadId) => {
      try {
        KNState.safeRemove('localStorage', `gamepad-profile:${gamepadId}`);
      } catch (_) {}
      for (const entry of Object.values(_detected)) {
        if (entry.id === gamepadId) {
          const resolved = resolveProfile(gamepadId, entry.mapping);
          entry.profile = resolved;
          entry.profileName = resolved.name;
        }
      }
      if (_onUpdate) _onUpdate();
    },

    // `mapping` defaults to that of the detected gamepad with this id, when there is one.
    getDefaultProfile: (gamepadId, mapping = Object.values(_detected).find((e) => e.id === gamepadId)?.mapping) => {
      return PROFILES.find((p) => p.match(gamepadId, mapping)) ?? PROFILES[PROFILES.length - 1];
    },

    hasCustomProfile: (gamepadId) => {
      try {
        return KNState.safeGet('localStorage', `gamepad-profile:${gamepadId}`) !== null;
      } catch (_) {
        return false;
      }
    },

    // Expose the real getGamepads (before lockstep overrides it)
    nativeGetGamepads: () => _nativeGetGamepads(),

    getCurrentSettings: () => ({
      range: _getRange(),
      sensitivity: _getSensitivity(),
      deadzones: {
        lx: _getDeadzone('kn-deadzone-lx'),
        ly: _getDeadzone('kn-deadzone-ly'),
        cx: _getDeadzone('kn-deadzone-cx'),
        cy: _getDeadzone('kn-deadzone-cy'),
      },
    }),

    getActiveProfile: (slot) => {
      const gpIndex = _assignments[slot];
      if (gpIndex === undefined) return null;
      const entry = _detected[gpIndex];
      return entry ? { id: entry.id, profileName: entry.profileName, profile: entry.profile } : null;
    },

    setSetting: (key, value, scope) => {
      if (scope === 'game' && window.KNState?.romHash) {
        const gk = `kn-gamepad:${KNState.romHash}:${key}`;
        localStorage.setItem(gk, String(value));
      } else {
        localStorage.setItem(key, String(value));
      }
      // Bust range cache so changes take effect immediately
      _cachedRange = null;
      _cachedRangeTime = 0;
    },
  };
})();
