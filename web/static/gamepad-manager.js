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

  // ── Profile Registry ─────────────────────────────────────────────────
  // Ordered array. First match wins. Raphnet before Standard (fallback).

  var PROFILES = [
    {
      name: 'Raphnet N64',
      match: function (id) {
        return id.indexOf('Raphnet') !== -1 || id.indexOf('0964') !== -1;
      },
      // Uses Standard mapping until verified with hardware
      buttons: {
        0: (1 << 0),   // B
        2: (1 << 8),   // A
        9: (1 << 3),   // Start
        12: (1 << 4),  // D-Up
        13: (1 << 5),  // D-Down
        14: (1 << 6),  // D-Left
        15: (1 << 7),  // D-Right
        4: (1 << 10),  // L
        5: (1 << 11),  // R
        6: (1 << 9),   // Z
      },
      axes: {
        stickX: { index: 0, bits: [19, 18] },
        stickY: { index: 1, bits: [17, 16] },
      },
      axisButtons: {
        2: { pos: (1 << 15), neg: (1 << 14) },
        3: { pos: (1 << 13), neg: (1 << 12) },
      },
      deadzone: 0.3,
    },
    {
      name: 'Standard',
      match: function () { return true; },
      buttons: {
        0: (1 << 0),   // face bottom (A/Cross) → B
        2: (1 << 8),   // face left (X/Square) → A
        9: (1 << 3),   // start → Start
        12: (1 << 4),  // dpad up → D-Up
        13: (1 << 5),  // dpad down → D-Down
        14: (1 << 6),  // dpad left → D-Left
        15: (1 << 7),  // dpad right → D-Right
        4: (1 << 10),  // LB → L
        5: (1 << 11),  // RB → R
        6: (1 << 9),   // LT → Z
      },
      axes: {
        stickX: { index: 0, bits: [19, 18] },
        stickY: { index: 1, bits: [17, 16] },
      },
      axisButtons: {
        2: { pos: (1 << 15), neg: (1 << 14) },
        3: { pos: (1 << 13), neg: (1 << 12) },
      },
      deadzone: 0.3,
    },
  ];

  // ── State ────────────────────────────────────────────────────────────

  var _pollInterval = null;
  var _playerSlot = 0;
  var _onUpdate = null;

  // { playerSlot: gamepadIndex }
  var _assignments = {};

  // { gamepadIndex: { id, profileName, profile } }
  var _detected = {};

  // Previous gamepad IDs for change detection
  var _prevIds = {};

  // ── Profile Resolution ───────────────────────────────────────────────

  function resolveProfile(id) {
    // Check localStorage for custom profile
    try {
      var saved = localStorage.getItem('gamepad-profile:' + id);
      if (saved) {
        var profile = JSON.parse(saved);
        profile.name = 'Custom';
        profile.match = function () { return true; };
        return profile;
      }
    } catch (_) {}

    // Fall through to built-in profiles
    for (var i = 0; i < PROFILES.length; i++) {
      if (PROFILES[i].match(id)) return PROFILES[i];
    }
    return PROFILES[PROFILES.length - 1];
  }

  // ── Polling / Scanning ───────────────────────────────────────────────

  function poll() {
    var gamepads = navigator.getGamepads();
    var changed = false;
    var currentIds = {};

    // Scan all gamepad slots
    for (var i = 0; i < gamepads.length; i++) {
      var gp = gamepads[i];
      if (!gp) {
        // Gamepad gone — remove if was detected
        if (_detected[i]) {
          // Remove assignment if this gamepad was assigned
          for (var slot in _assignments) {
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
        var profile = resolveProfile(gp.id);
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
    var gpIndex = _assignments[slot];
    if (gpIndex === undefined) return 0;

    var gp = navigator.getGamepads()[gpIndex];
    if (!gp) return 0;

    var entry = _detected[gpIndex];
    if (!entry) return 0;

    var profile = entry.profile;
    var mask = 0;

    // Map buttons
    var btnMap = profile.buttons;
    for (var btnIdx in btnMap) {
      var idx = parseInt(btnIdx, 10);
      if (idx < gp.buttons.length && gp.buttons[idx].pressed) {
        mask |= btnMap[btnIdx];
      }
    }

    // Map axes → analog direction bits (bits 16-19)
    var axes = profile.axes;
    var dz = profile.deadzone;
    for (var axisName in axes) {
      var axisCfg = axes[axisName];
      if (axisCfg.index < gp.axes.length) {
        var val = gp.axes[axisCfg.index];
        if (val > dz)  mask |= (1 << axisCfg.bits[0]);  // positive
        if (val < -dz) mask |= (1 << axisCfg.bits[1]);  // negative
      }
    }

    // Map axes → digital button bits (C-buttons from right stick)
    var axBtn = profile.axisButtons;
    if (axBtn) {
      for (var axIdx in axBtn) {
        var ai = parseInt(axIdx, 10);
        if (ai < gp.axes.length) {
          var v = gp.axes[ai];
          if (v > dz)  mask |= axBtn[axIdx].pos;
          if (v < -dz) mask |= axBtn[axIdx].neg;
        }
      }
    }

    return mask;
  }

  // ── Public API ───────────────────────────────────────────────────────

  window.GamepadManager = {
    start: function (opts) {
      opts = opts || {};
      _playerSlot = opts.playerSlot || 0;
      _onUpdate = opts.onUpdate || null;

      // Immediate first poll
      poll();

      // Also listen for browser events for faster response
      window.addEventListener('gamepadconnected', poll);
      window.addEventListener('gamepaddisconnected', poll);

      // Polling loop as source of truth (1 second)
      if (_pollInterval) clearInterval(_pollInterval);
      _pollInterval = setInterval(poll, 1000);
    },

    stop: function () {
      if (_pollInterval) {
        clearInterval(_pollInterval);
        _pollInterval = null;
      }
      window.removeEventListener('gamepadconnected', poll);
      window.removeEventListener('gamepaddisconnected', poll);
    },

    readGamepad: readGamepad,

    getAssignments: function () {
      var result = {};
      for (var slot in _assignments) {
        var gpIndex = _assignments[slot];
        var entry = _detected[gpIndex];
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

    reassignSlot: function (slot, gamepadIndex) {
      if (_detected[gamepadIndex]) {
        _assignments[slot] = gamepadIndex;
        if (_onUpdate) _onUpdate();
      }
    },

    getDetected: function () {
      var result = [];
      for (var idx in _detected) {
        result.push({
          index: parseInt(idx, 10),
          id: _detected[idx].id,
          profileName: _detected[idx].profileName,
        });
      }
      return result;
    },

    saveGamepadProfile: function (gamepadId, profile) {
      try {
        localStorage.setItem('gamepad-profile:' + gamepadId, JSON.stringify(profile));
      } catch (_) {}
      // Re-resolve profile for this gamepad
      for (var idx in _detected) {
        if (_detected[idx].id === gamepadId) {
          var resolved = resolveProfile(gamepadId);
          _detected[idx].profile = resolved;
          _detected[idx].profileName = resolved.name;
        }
      }
      if (_onUpdate) _onUpdate();
    },

    clearGamepadProfile: function (gamepadId) {
      try {
        localStorage.removeItem('gamepad-profile:' + gamepadId);
      } catch (_) {}
      for (var idx in _detected) {
        if (_detected[idx].id === gamepadId) {
          var resolved = resolveProfile(gamepadId);
          _detected[idx].profile = resolved;
          _detected[idx].profileName = resolved.name;
        }
      }
      if (_onUpdate) _onUpdate();
    },

    getDefaultProfile: function (gamepadId) {
      for (var i = 0; i < PROFILES.length; i++) {
        if (PROFILES[i].match(gamepadId)) return PROFILES[i];
      }
      return PROFILES[PROFILES.length - 1];
    },

    hasCustomProfile: function (gamepadId) {
      try {
        return localStorage.getItem('gamepad-profile:' + gamepadId) !== null;
      } catch (_) { return false; }
    },
  };
})();
