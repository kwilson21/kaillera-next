(function () {
  'use strict';

  const SSB64_ONLINE_CHEATS = [
    { desc: 'Have All Characters',   code: '810A4938 0FF0' },
    { desc: 'Have Mushroom Kingdom', code: '800A4937 00FF' },
    { desc: 'Stock Mode',            code: '800A4D0B 0002' },
    { desc: '5 Stocks',              code: '800A4D0F 0004' },
    { desc: 'Timer On',              code: '800A4D11 0001' },
    { desc: 'Items Off',             code: '800A4D24 0000' },
    { desc: 'No Wind',               code: '810BA9F1 0000+800BA9F3 0000' },
  ];

  const DEFAULT_N64_KEYMAP = {
    67: 0,    // C -> A (JOYPAD_B)
    88: 1,    // X -> B (JOYPAD_Y)
    13: 3,    // Enter -> Start
    86: 3,    // V -> Start
    38: 4,    // Up -> D-Up
    40: 5,    // Down -> D-Down
    37: 6,    // Left -> D-Left
    39: 7,    // Right -> D-Right
    84: 10,   // T -> L (JOYPAD_L)
    89: 11,   // Y -> R (JOYPAD_R)
    90: 12,   // Z -> Z trigger (JOYPAD_L2)
    68: 16,   // D -> Analog Right (L STICK RIGHT)
    65: 17,   // A -> Analog Left (L STICK LEFT)
    83: 18,   // S -> Analog Down (L STICK DOWN)
    87: 19,   // W -> Analog Up (L STICK UP)
    74: 20,   // J -> C-Left (R STICK RIGHT -> CSTICK_LEFT)
    76: 21,   // L -> C-Right (R STICK LEFT -> CSTICK_RIGHT)
    75: 22,   // K -> C-Down (R STICK DOWN -> CSTICK_DOWN)
    73: 23,   // I -> C-Up (R STICK UP -> CSTICK_UP)
  };

  function applyStandardCheats(cheats) {
    waitForEmulator().then(function (gm) {
      var retries = 0;
      var maxRetries = 5;

      function apply() {
        try {
          cheats.forEach(function (c, i) { gm.setCheat(i, 1, c.code); });
        } catch (e) {
          console.error('[netplay] cheat application threw:', e.message);
          return;
        }

        // Verify by reading back a canary address from RDRAM.
        // Stock Mode cheat: 800A4D0B 0002 → byte at offset 0x0A4D0B should be 0x02.
        setTimeout(function () {
          if (verifyCheats(gm)) {
            console.log('[netplay] applied and verified', cheats.length, 'standard cheats');
          } else if (++retries < maxRetries) {
            console.log('[netplay] cheat verification failed, retry', retries);
            apply();
          } else {
            console.warn('[netplay] cheats applied but verification failed after', maxRetries, 'retries');
          }
        }, 200);
      }
      apply();
    }).catch(function (err) {
      console.error('[netplay] cannot apply cheats:', err.message);
    });
  }

  function verifyCheats(gm) {
    try {
      var mod = gm.Module;
      if (!mod || !mod.cwrap) return true;  // can't verify, assume OK
      var getMemData = mod.cwrap('get_memory_data', 'string', ['string']);
      var result = getMemData('RETRO_MEMORY_SYSTEM_RAM');
      if (!result) return true;  // can't verify
      var parts = result.split('|');
      var rdramPtr = parseInt(parts[1], 10);
      if (!rdramPtr || rdramPtr <= 0) return true;  // can't verify

      var buf = mod.HEAPU8 ? mod.HEAPU8.buffer : null;
      if (!buf || buf.byteLength === 0) return true;  // can't verify
      var mem = new Uint8Array(buf);

      // Check "Stock Mode" cheat: address 0x0A4D0B should be 0x02
      var canaryOffset = rdramPtr + 0x0A4D0B;
      if (canaryOffset < mem.length) {
        return mem[canaryOffset] === 0x02;
      }
    } catch (_) {}
    return true;  // verification error → assume OK, don't retry forever
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
      document.addEventListener('keydown', (e) => { if (_activeHeldKeys) _activeHeldKeys.add(e['keyCode']); }, true);
      document.addEventListener('keyup',   (e) => { if (_activeHeldKeys) _activeHeldKeys.delete(e['keyCode']); }, true);
      _listenersAdded = true;
    }

    return resolved;
  }

  var _bootPromise = null;  // deduplication: only one poll loop at a time

  function waitForEmulator(timeoutMs) {
    if (_bootPromise) return _bootPromise;
    timeoutMs = timeoutMs || 30000;

    _bootPromise = new Promise(function (resolve, reject) {
      var attempts = 0;
      var maxAttempts = Math.ceil(timeoutMs / 200);

      function attempt() {
        var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
        if (gm && gm.Module) {
          var frames = gm.Module._get_current_frame_count ? gm.Module._get_current_frame_count() : 'n/a';
          console.log('[netplay] emulator running (frames=' + frames + ')');
          _bootPromise = null;
          enableMobileTouch();
          resolve(gm);
          return;
        }

        var btn = document.querySelector('.ejs_start_button');
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
          reject(new Error('Emulator boot timed out after ' + timeoutMs + 'ms'));
          return;
        }
        setTimeout(attempt, 200);
      }
      attempt();
    });

    return _bootPromise;
  }

  // Fire-and-forget wrapper for backward compat
  function triggerEmulatorStart() {
    waitForEmulator().catch(function (err) {
      console.error('[netplay]', err.message);
    });
  }

  function enableMobileTouch() {
    if (!('ontouchstart' in window)) return;
    const ejs = window.EJS_emulator;
    if (!ejs || ejs.touch) return;
    ejs.touch = true;
    if (ejs.virtualGamepad) ejs.virtualGamepad.style.display = '';
    console.log('[netplay] enabled mobile touch controls');
  }

  window.KNShared = {
    SSB64_ONLINE_CHEATS: SSB64_ONLINE_CHEATS,
    DEFAULT_N64_KEYMAP: DEFAULT_N64_KEYMAP,
    applyStandardCheats: applyStandardCheats,
    setupKeyTracking: setupKeyTracking,
    triggerEmulatorStart: triggerEmulatorStart,
    waitForEmulator: waitForEmulator,
    enableMobileTouch: enableMobileTouch,
  };

})();
