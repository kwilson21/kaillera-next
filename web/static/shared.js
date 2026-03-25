(function () {
  'use strict';

  const SSB64_ONLINE_CHEATS = [
    { desc: 'Have All Characters', code: '810A4938 0FF0' },
    { desc: 'Have Mushroom Kingdom', code: '800A4937 00FF' },
    { desc: 'Stock Mode', code: '800A4D0B 0002' },
    { desc: '5 Stocks', code: '800A4D0F 0004' },
    { desc: 'Timer On', code: '800A4D11 0001' },
    { desc: 'Items Off', code: '800A4D24 0000' },
    { desc: 'No Wind', code: '810BA9F1 0000+800BA9F3 0000' },
  ];

  const DEFAULT_N64_KEYMAP = {
    67: 0, // C -> A (JOYPAD_B)
    88: 1, // X -> B (JOYPAD_Y)
    13: 3, // Enter -> Start
    86: 3, // V -> Start
    38: 4, // Up -> D-Up
    40: 5, // Down -> D-Down
    37: 6, // Left -> D-Left
    39: 7, // Right -> D-Right
    84: 10, // T -> L (JOYPAD_L)
    89: 11, // Y -> R (JOYPAD_R)
    90: 12, // Z -> Z trigger (JOYPAD_L2)
    68: 16, // D -> Analog Right (L STICK RIGHT)
    65: 17, // A -> Analog Left (L STICK LEFT)
    83: 18, // S -> Analog Down (L STICK DOWN)
    87: 19, // W -> Analog Up (L STICK UP)
    74: 20, // J -> C-Left (R STICK RIGHT -> CSTICK_LEFT)
    76: 21, // L -> C-Right (R STICK LEFT -> CSTICK_RIGHT)
    75: 22, // K -> C-Down (R STICK DOWN -> CSTICK_DOWN)
    73: 23, // I -> C-Up (R STICK UP -> CSTICK_UP)
  };

  async function applyStandardCheats(cheats) {
    try {
      const gm = await waitForEmulator();
      cheats.forEach((c, i) => {
        gm.setCheat(i, 1, c.code);
      });
      console.log('[netplay] applied', cheats.length, 'standard cheats');
    } catch (e) {
      console.error('[netplay] cheat application failed:', e?.message);
    }
  }

  let _listenersAdded = false;
  let _activeHeldKeys = null;

  function setupKeyTracking(keymap, heldKeys) {
    _activeHeldKeys = heldKeys;
    if (keymap) return keymap;

    let resolved = null;

    // Check localStorage for custom keyboard mapping first
    try {
      const saved = localStorage.getItem('keyboard-mapping');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && Object.keys(parsed).length > 0) {
          resolved = {};
          for (const k in parsed) resolved[parseInt(k, 10)] = parsed[k];
        }
      }
    } catch (_) {}

    // Try EJS controls if no custom mapping
    if (!resolved) {
      const ejs = window.EJS_emulator;
      if (ejs && ejs.controls && ejs.controls[0]) {
        resolved = {};
        Object.entries(ejs.controls[0]).forEach(([btnIdx, binding]) => {
          const kc = binding && binding.value;
          if (kc) resolved[kc] = parseInt(btnIdx, 10);
        });
      }
    }

    if (!resolved || Object.keys(resolved).length === 0) {
      resolved = Object.assign({}, DEFAULT_N64_KEYMAP);
    }

    if (!_listenersAdded) {
      document.addEventListener(
        'keydown',
        (e) => {
          if (_activeHeldKeys) _activeHeldKeys.add(e['keyCode']);
        },
        true,
      );
      document.addEventListener(
        'keyup',
        (e) => {
          if (_activeHeldKeys) _activeHeldKeys.delete(e['keyCode']);
        },
        true,
      );
      _listenersAdded = true;
    }

    return resolved;
  }

  let _bootPromise = null; // deduplication: only one poll loop at a time

  function waitForEmulator(timeoutMs) {
    if (_bootPromise) return _bootPromise;
    timeoutMs = timeoutMs || 30000;

    _bootPromise = new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = Math.ceil(timeoutMs / 200);

      const attempt = () => {
        const gm = window.EJS_emulator?.gameManager;
        if (gm?.Module) {
          const frames = gm.Module._get_current_frame_count ? gm.Module._get_current_frame_count() : 'n/a';
          console.log(`[netplay] emulator running (frames=${frames})`);
          _bootPromise = null;
          enableMobileTouch();
          resolve(gm);
          return;
        }

        const btn = document.querySelector('.ejs_start_button');
        if (btn) {
          console.log('[netplay] triggerEmulatorStart: clicking start button');
          if ('ontouchstart' in window) btn.dispatchEvent(new Event('touchstart'));
          btn.click();
        }

        if (attempts === 0) {
          console.log('[netplay] waiting for emulator...');
        }
        if (++attempts >= maxAttempts) {
          _bootPromise = null;
          reject(new Error(`Emulator boot timed out after ${timeoutMs}ms`));
          return;
        }
        setTimeout(attempt, 200);
      };
      attempt();
    });

    return _bootPromise;
  }

  // Fire-and-forget wrapper for backward compat
  async function triggerEmulatorStart() {
    try {
      await waitForEmulator();
    } catch (err) {
      console.error('[netplay]', err?.message);
    }
  }

  // Common boot sequence: wait for emulator, apply cheats, disable EJS input.
  // Used by both lockstep and streaming engines at host/guest boot time.
  function bootWithCheats(label) {
    triggerEmulatorStart();
    applyStandardCheats(SSB64_ONLINE_CHEATS);
    disableEJSInput(label);
  }

  // Drain buffered ICE candidates after setting remote description.
  // Shared by lockstep and streaming WebRTC signal handlers.
  async function drainCandidates(peer) {
    peer.remoteDescSet = true;
    if (peer.pendingCandidates) {
      for (const c of peer.pendingCandidates) {
        try {
          await peer.pc.addIceCandidate(c);
        } catch (_) {}
      }
      peer.pendingCandidates = [];
    }
  }

  function enableMobileTouch() {
    if (!('ontouchstart' in window)) return;
    // Netplay engines disable EJS touch and use a custom virtual gamepad.
    // Don't re-enable it on subsequent waitForEmulator() calls.
    if (window._kn_ejsTouchDisabled) return;
    const ejs = window.EJS_emulator;
    if (!ejs || ejs.touch) return;
    ejs.touch = true;
    if (ejs.virtualGamepad) ejs.virtualGamepad.style.display = '';
    console.log('[netplay] enabled mobile touch controls');
  }

  // ── readLocalInput(playerSlot, keyMap, heldKeys) ───────────────────────
  // Reads keyboard, gamepad, and virtual-gamepad (touch) state and returns
  // a 24-bit input mask.  Shared by lockstep and streaming engines.
  //   playerSlot: 0-3, the local player's slot index
  //   keyMap:     keyboard keyCode→button-index map (from setupKeyTracking)
  //   heldKeys:   Set of currently-held keyCodes

  const readLocalInput = (playerSlot, keyMap, heldKeys) => {
    let mask = 0;

    // Suppress all input while remap wizard is active (prevents desyncs)
    if (KNState.remapActive) return 0;

    // Gamepad via GamepadManager (profile-based mapping)
    if (document.hasFocus() && window.GamepadManager) {
      mask |= GamepadManager.readGamepad(playerSlot);
    }

    // Keyboard
    if (keyMap) {
      heldKeys.forEach((kc) => {
        const btnIdx = keyMap[kc];
        if (btnIdx !== undefined) mask |= 1 << btnIdx;
      });
    }

    // Virtual gamepad (mobile touch controls)
    // EJS simulateInput uses per-direction positive values:
    //   indices 0-15: digital buttons (value 0 or 1)
    //   indices 16-19: left stick (right/left/down/up, value 0 to 32767)
    //   indices 20-23: C-buttons (right/left/down/up, value 0 or 1)
    // Skip entirely if an EJS menu/popup is visible — stale touch state from
    // before the menu opened would otherwise keep sending non-zero input.
    const ejs = window.EJS_emulator;
    const ejsMenuOpen =
      ejs &&
      (ejs.settingsMenuOpen ||
        ejs.isPopupOpen?.() ||
        (ejs.elements?.menu && !ejs.elements.menu.classList.contains('ejs_menu_bar_hidden')));
    if (ejsMenuOpen) {
      // Clear in-place — VirtualGamepad reads KNState.touchInput via the
      // same global, so this correctly zeroes both sides.
      for (const ck in KNState.touchInput) {
        if (KNState.touchInput.hasOwnProperty(ck)) KNState.touchInput[ck] = 0;
      }
    }

    // Left stick (indices 16-19): apply absolute + relative deadzone.
    // Absolute deadzone (~15% of max 32767) filters out the small spurious
    // displacement that EJS's virtual joystick sends on initial finger
    // placement — the touch point is typically slightly above the joystick
    // center, causing a brief "up" input that triggers unwanted jumps.
    // Relative deadzone (40% of major axis) suppresses near-cardinal
    // diagonals, giving ~+/-22deg cardinal zones around each direction.
    const TOUCH_ABS_DEADZONE = 3500;
    const stR = KNState.touchInput[16] || 0;
    const stL = KNState.touchInput[17] || 0;
    const stD = KNState.touchInput[18] || 0;
    const stU = KNState.touchInput[19] || 0;
    const stMajor = Math.max(stR, stL, stD, stU);
    if (stMajor > TOUCH_ABS_DEADZONE) {
      const stThresh = stMajor * 0.4;
      if (stR > stThresh) mask |= 1 << 16;
      if (stL > stThresh) mask |= 1 << 17;
      if (stD > stThresh) mask |= 1 << 18;
      if (stU > stThresh) mask |= 1 << 19;
    }

    // Digital buttons + C-buttons (non-stick indices)
    for (const ti in KNState.touchInput) {
      const idx = parseInt(ti, 10);
      if (idx >= 16 && idx <= 19) continue; // left stick handled above
      const val = KNState.touchInput[idx];
      if (!val) continue;
      if (idx < 16) {
        mask |= 1 << idx;
      } else if (idx >= 20 && idx <= 23) {
        if (val > 0) mask |= 1 << idx;
      }
    }

    // Debug: call window.debugInput() to log input for 3 seconds
    if (window._debugInputUntil && performance.now() < window._debugInputUntil && mask !== 0) {
      const bits = [];
      for (let b = 0; b < 20; b++) {
        if ((mask >> b) & 1) bits.push(b);
      }
      console.log(`[input-debug] mask=${mask} bits=[${bits.join(',')}]`);
    }

    return mask;
  };

  // ── disableEJSInput(label) ────────────────────────────────────────────
  // Disables EmulatorJS's native keyboard, gamepad, and (if APISandbox is
  // available) WASM-level gamepad handling.
  //   label: string for the timeout warning, e.g. 'lockstep' or 'streaming'

  const disableEJSInput = (label) => {
    let attempts = 0;
    const tag = label || 'netplay';
    const attempt = () => {
      const ejs = window.EJS_emulator;
      const gm = ejs?.gameManager;
      if (!gm) {
        if (++attempts < 150) {
          setTimeout(attempt, 200);
        } else {
          console.warn(`[${tag}] disableEJSInput timed out`);
        }
        return;
      }

      // Disable EJS keyboard handling
      gm.setKeyboardEnabled(false);
      const parent = ejs.elements?.parent;
      if (parent) {
        const block = (e) => {
          e.stopImmediatePropagation();
        };
        parent.addEventListener('keydown', block, true);
        parent.addEventListener('keyup', block, true);
      }

      // Disable EJS gamepad handling — stop its JS-level 10ms polling loop
      if (ejs.gamepad) {
        if (ejs.gamepad.timeout) clearTimeout(ejs.gamepad.timeout);
        ejs.gamepad.loop = () => {};
      }

      // Block navigator.getGamepads globally so the WASM core's internal
      // Emscripten SDL gamepad layer also gets no gamepads. The core has
      // its own RetroArch button mapping that conflicts with our profiles.
      // GamepadManager uses APISandbox.nativeGetGamepads() so it still works.
      if (window.APISandbox?.overrideGetGamepads) {
        APISandbox.overrideGetGamepads(() => []);
      }
    };
    attempt();
  };

  // ── applyInputToWasm(slot, inputMask, prevMasks) ──────────────────────
  // Writes a 24-bit input mask to the WASM core via _simulate_input().
  //   slot:      player slot index (0-3)
  //   inputMask: 24-bit bitmask (0-15 digital, 16-19 L-stick, 20-23 C-buttons)
  //   prevMasks: optional object mapping slot→previous mask; when provided,
  //              skips the write if the mask is unchanged (streaming optimization)

  const applyInputToWasm = (slot, inputMask, prevMasks) => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._simulate_input) return;

    // Optional skip-if-unchanged optimization
    if (prevMasks) {
      const prevMask = prevMasks[slot] || 0;
      if (inputMask === prevMask) return;
    }

    // Digital buttons (0-15): use _simulate_input for correct address calc
    for (let btn = 0; btn < 16; btn++) {
      mod._simulate_input(slot, btn, (inputMask >> btn) & 1);
    }

    // Analog axes (16-23): bit pairs -> +/-axis values
    // 16-19: left stick (N64 analog), 20-23: right stick (N64 C-buttons)
    // When both X and Y are active (diagonal), scale each axis by 1/sqrt(2)
    // so the combined magnitude matches cardinal (prevents diagonal speed boost).
    const lxActive = ((inputMask >> 16) & 1) | ((inputMask >> 17) & 1);
    const lyActive = ((inputMask >> 18) & 1) | ((inputMask >> 19) & 1);
    const diagScale = lxActive && lyActive ? 23170 : 32767; // 32767/sqrt(2) ~ 23170
    for (let base = 16; base < 24; base += 2) {
      const posPressed = (inputMask >> base) & 1;
      const negPressed = (inputMask >> (base + 1)) & 1;
      const mag = base < 20 ? diagScale : 32767; // normalize left stick only
      const axisVal = (posPressed - negPressed) * mag;
      mod._simulate_input(slot, base, axisVal);
      mod._simulate_input(slot, base + 1, 0);
    }

    // Update previous mask tracker if provided
    if (prevMasks) {
      prevMasks[slot] = inputMask;
    }
  };

  window.KNShared = {
    SSB64_ONLINE_CHEATS: SSB64_ONLINE_CHEATS,
    DEFAULT_N64_KEYMAP: DEFAULT_N64_KEYMAP,
    applyStandardCheats: applyStandardCheats,
    bootWithCheats: bootWithCheats,
    drainCandidates: drainCandidates,
    setupKeyTracking: setupKeyTracking,
    triggerEmulatorStart: triggerEmulatorStart,
    waitForEmulator: waitForEmulator,
    readLocalInput: readLocalInput,
    disableEJSInput: disableEJSInput,
    applyInputToWasm: applyInputToWasm,
  };
})();
