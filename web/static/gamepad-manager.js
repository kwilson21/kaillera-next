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
 *   deadzone:    threshold for axis activation
 */
(function () {
  'use strict';

  // Use APISandbox for native getGamepads (lockstep overrides the global).
  const _nativeGetGamepads = () => APISandbox.nativeGetGamepads();

  // ── Profile Registry ─────────────────────────────────────────────────
  // Ordered array. First match wins. Raphnet before Standard (fallback).

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

  // ── Profile Resolution ───────────────────────────────────────────────

  function resolveProfile(id) {
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
    return PROFILES.find((p) => p.match(id)) ?? PROFILES[PROFILES.length - 1];
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
          changed = true;
        }
        continue;
      }

      currentIds[i] = gp.id;

      // New or changed gamepad
      if (!_detected[i] || _prevIds[i] !== gp.id) {
        const profile = resolveProfile(gp.id);
        _detected[i] = { id: gp.id, profileName: profile.name, profile: profile };
        changed = true;

        // Auto-assign to player slot if unassigned
        if (_assignments[_playerSlot] === undefined) {
          _assignments[_playerSlot] = i;
        }
      }
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

    // Left stick — true analog via three-stage pipeline (per-axis deadzone)
    let lx = 0,
      ly = 0;
    if (profile.axes) {
      const axX = profile.axes.stickX;
      const axY = profile.axes.stickY;
      if (axX && axX.index < gp.axes.length) lx = _analogScale(gp.axes[axX.index], _getDeadzone('kn-deadzone-lx'));
      if (axY && axY.index < gp.axes.length) ly = _analogScale(gp.axes[axY.index], _getDeadzone('kn-deadzone-ly'));
    }

    // C-stick — digital snap (N64 C-buttons are on/off, per-axis deadzone)
    let cx = 0,
      cy = 0;
    const axBtn = profile.axisButtons;
    if (axBtn) {
      if (axBtn[2] && 2 < gp.axes.length) cx = _digitalSnap(gp.axes[2], _getDeadzone('kn-deadzone-cx'));
      if (axBtn[3] && 3 < gp.axes.length) cy = _digitalSnap(gp.axes[3], _getDeadzone('kn-deadzone-cy'));
    }

    return { buttons, lx, ly, cx, cy };
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
          const resolved = resolveProfile(gamepadId);
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
          const resolved = resolveProfile(gamepadId);
          entry.profile = resolved;
          entry.profileName = resolved.name;
        }
      }
      if (_onUpdate) _onUpdate();
    },

    getDefaultProfile: (gamepadId) => {
      return PROFILES.find((p) => p.match(gamepadId)) ?? PROFILES[PROFILES.length - 1];
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
