/**
 * shared.js — Shared utilities for netplay engines.
 *
 * Provides input encoding/decoding (24-bit N64 input mask ↔ wire format),
 * standard online cheat codes (SSB64 GameShark), default keyboard mapping,
 * and the applyInputToWasm() function that writes decoded input into the
 * WASM core's memory via _simulate_input().
 *
 * Consumed by: netplay-lockstep.js, netplay-streaming.js, play.js
 * Exposes: window.KNShared
 */
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

  async function clearCheats() {
    try {
      const gm = await waitForEmulator();
      SSB64_ONLINE_CHEATS.forEach((c, i) => {
        gm.setCheat(i, 0, c.code);
      });
      console.log('[netplay] cleared all cheats');
    } catch (e) {
      console.error('[netplay] cheat clear failed:', e?.message);
    }
  }

  let _listenersAdded = false;
  let _activeHeldKeys = null;
  let _keydownHandler = null;
  let _keyupHandler = null;

  function setupKeyTracking(keymap, heldKeys) {
    _activeHeldKeys = heldKeys;
    if (keymap) return keymap;

    let resolved = null;

    // Check localStorage for custom keyboard mapping first
    try {
      const saved = KNState.safeGet('localStorage', 'keyboard-mapping');
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
      _keydownHandler = (e) => {
        if (_activeHeldKeys) _activeHeldKeys.add(e['keyCode']);
      };
      _keyupHandler = (e) => {
        if (_activeHeldKeys) _activeHeldKeys.delete(e['keyCode']);
      };
      document.addEventListener('keydown', _keydownHandler, true);
      document.addEventListener('keyup', _keyupHandler, true);
      _listenersAdded = true;
    }

    return resolved;
  }

  function teardownKeyTracking() {
    if (_listenersAdded) {
      if (_keydownHandler) document.removeEventListener('keydown', _keydownHandler, true);
      if (_keyupHandler) document.removeEventListener('keyup', _keyupHandler, true);
      _keydownHandler = null;
      _keyupHandler = null;
      _listenersAdded = false;
    }
    if (_activeHeldKeys) {
      _activeHeldKeys.clear();
      _activeHeldKeys = null;
    }
  }

  let _bootPromise = null; // deduplication: only one poll loop at a time
  let _funnelLastBootedMatchId = null; // P0-1 funnel: emulator_booted fires once per match

  function resetBootState() {
    _bootPromise = null;
    console.log('[netplay] boot state reset');
  }

  function waitForEmulator(timeoutMs) {
    const bt = window._knBootLog || (() => {});
    if (_bootPromise) {
      bt('waitForEmulator-reuse');
      return _bootPromise;
    }
    timeoutMs = timeoutMs || 30000;
    bt('waitForEmulator-start', { timeoutMs });

    _bootPromise = new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = Math.ceil(timeoutMs / 200);
      let _lastState = ''; // track state transitions to log only changes

      const attempt = () => {
        const ejs = window.EJS_emulator;
        // Always try clicking the EJS start button first — with startOnLoaded=false
        // (guests), Module may exist before the game loop starts. If we resolve
        // on Module alone, the start button never gets clicked and frames stay at 0.
        const btn = document.querySelector('.ejs_start_button');
        if (btn) {
          const btnVisible = btn.offsetParent !== null;
          if (attempts === 0 || attempts % 10 === 0) {
            console.log(
              `[netplay] triggerEmulatorStart: clicking start button (visible=${btnVisible} display=${getComputedStyle(btn).display})`,
            );
          }
          if ('ontouchstart' in window) btn.dispatchEvent(new Event('touchstart'));
          btn.click();
        }

        const gm = ejs?.gameManager;
        if (gm?.Module) {
          const frames = gm.Module._get_current_frame_count ? gm.Module._get_current_frame_count() : 'n/a';
          const audioState = gm.Module.SDL2?.audioContext?.state ?? 'n/a';
          bt('waitForEmulator-resolved', { attempts, frames, audioState });
          console.log(`[netplay] emulator running (frames=${frames} audio=${audioState})`);
          _bootPromise = null;
          enableMobileTouch();
          // P0-1 funnel: emit emulator_booted once per match, and only when
          // the core has actually run a frame (Module can exist before the
          // game loop starts — frames=0 resolves don't represent a real boot).
          // The match_id guard also protects against waitForEmulator being
          // called multiple times in the same session, while still allowing
          // a new match in the same tab to fire the event again.
          if (
            typeof frames === 'number' &&
            frames >= 1 &&
            KNState.matchId &&
            _funnelLastBootedMatchId !== KNState.matchId
          ) {
            _funnelLastBootedMatchId = KNState.matchId;
            KNEvent('emulator_booted', '', { frames });
          }
          resolve(gm);
          return;
        }

        // Log state transitions (not just every 10th poll) so we can see
        // exactly when each boot stage is reached vs when it stalls.
        const curState = `ejs=${!!ejs}|gm=${!!gm}|btn=${!!btn}`;
        if (curState !== _lastState) {
          bt('waitForEmulator-state', { poll: attempts, ejs: !!ejs, gm: !!gm, btn: !!btn });
          _lastState = curState;
        }

        if (attempts % 10 === 0) {
          const ejsKeys = ejs
            ? Object.keys(ejs)
                .filter((k) => typeof ejs[k] !== 'function')
                .slice(0, 15)
                .join(',')
            : 'null';
          console.log(
            `[netplay] waitForEmulator poll #${attempts}: EJS=${!!ejs} gameManager=${!!gm} btn=${!!btn} ejsState=[${ejsKeys}]`,
          );
        }
        if (++attempts >= maxAttempts) {
          _bootPromise = null;
          const snapshot = {
            ejs: !!window.EJS_emulator,
            gameManager: !!window.EJS_emulator?.gameManager,
            module: !!window.EJS_emulator?.gameManager?.Module,
            btn: !!document.querySelector('.ejs_start_button'),
            audioCtxState: window._kn_preloadedAudioCtx?.state ?? 'none',
          };
          bt('waitForEmulator-timeout', snapshot);
          KNEvent('wasm-fail', `Emulator boot timed out after ${timeoutMs}ms`, snapshot);
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
  const SSB64_HASH = 'S15592e79d3c5295cef4371d4992f0bd25bec2102fc29644c93e682f7ea99ef3d';
  function bootWithCheats(label) {
    triggerEmulatorStart();
    // Only apply SSB64 cheats for vanilla SSB64 — Smash Remix has different
    // memory layout and the cheat addresses cause memory access out of bounds.
    if (window.KNState?.romHash === SSB64_HASH) {
      applyStandardCheats(SSB64_ONLINE_CHEATS);
    }
    disableEJSInput(label);
  }

  // Drain buffered ICE candidates after setting remote description.
  // Shared by lockstep and streaming WebRTC signal handlers.
  async function drainCandidates(peer) {
    peer.remoteDescSet = true;
    if (peer.pendingCandidates && peer.pendingCandidates.length) {
      // Swap to a temp array before iterating — candidates arriving during
      // the async addIceCandidate calls go into the fresh empty array
      // instead of being lost when we clear pendingCandidates.
      const batch = peer.pendingCandidates;
      peer.pendingCandidates = [];
      for (const c of batch) {
        try {
          await peer.pc.addIceCandidate(c);
        } catch (_) {}
      }
    }
  }

  // ── WebRTC peer helpers ─────────────────────────────────────────────
  // Shared boilerplate for RTCPeerConnection creation, ICE candidate
  // buffering, and offer/answer exchange. Used by both lockstep and
  // streaming engines to avoid duplicating identical WebRTC plumbing.

  // Create a base peer object with RTCPeerConnection and ICE candidate relay.
  //   iceServers:  array of ICE server configs
  //   remoteSid:   socket ID of the remote peer
  //   socket:      Socket.IO client instance for emitting signals
  //   peerGuard:   () => boolean, called before emitting candidates;
  //                returns false if the peer has been replaced/removed
  const createBasePeer = (iceServers, remoteSid, socket, peerGuard) => {
    const peer = {
      pc: new RTCPeerConnection({ iceServers }),
      dc: null,
      slot: null,
      pendingCandidates: [],
      remoteDescSet: false,
    };
    peer.pc.onicecandidate = (e) => {
      if (e.candidate && (!peerGuard || peerGuard(peer))) {
        socket.emit('webrtc-signal', { target: remoteSid, candidate: e.candidate });
      }
    };
    return peer;
  };

  // Buffer or immediately add an ICE candidate depending on whether the
  // remote description has been set yet.
  const addBufferedCandidate = async (peer, candidate) => {
    if (peer.remoteDescSet) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (e) {
        KNEvent('webrtc-fail', 'ICE candidate add failed', { error: e?.message });
      }
    } else {
      if (!peer.pendingCandidates) peer.pendingCandidates = [];
      peer.pendingCandidates.push(candidate);
    }
  };

  // Create an offer, set local description, and emit via socket.
  // Returns the offer for callers that need to inspect/modify it.
  const createAndSendOffer = async (pc, socket, targetSid) => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { target: targetSid, offer });
    return offer;
  };

  // Create an answer, set local description, and emit via socket.
  const createAndSendAnswer = async (pc, socket, targetSid) => {
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-signal', { target: targetSid, answer });
  };

  // Detach handlers from an existing RTCPeerConnection, close it, and
  // create a fresh one with ICE candidate relay on the same peer object.
  // Used by lockstep reconnect flows that need to replace the PC while
  // preserving the peer's slot, input state, etc.
  const resetPeerConnection = (peer, iceServers, remoteSid, socket, peerGuard) => {
    if (peer.pc) {
      peer.pc.onconnectionstatechange = null;
      peer.pc.ondatachannel = null;
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      try {
        peer.pc.close();
      } catch (_) {}
    }
    peer.pc = new RTCPeerConnection({ iceServers });
    peer.pendingCandidates = [];
    peer.remoteDescSet = false;
    peer.pc.onicecandidate = (e) => {
      if (e.candidate && (!peerGuard || peerGuard(peer))) {
        socket.emit('webrtc-signal', { target: remoteSid, candidate: e.candidate });
      }
    };
  };

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

  // ── Keyboard input helpers ─────────────────────────────────────────────

  const readKeyboardAxes = (keyMap, heldKeys) => {
    const hasKey = (bit) => {
      for (const kc of heldKeys) {
        if (keyMap[kc] === bit) return true;
      }
      return false;
    };
    const axis = (posBit, negBit) => {
      const pos = hasKey(posBit);
      const neg = hasKey(negBit);
      if (pos && neg) return 0; // opposing cancellation
      if (pos) return N64_MAX;
      if (neg) return -N64_MAX;
      return 0;
    };
    return {
      lx: axis(16, 17),
      ly: axis(18, 19),
      cx: axis(20, 21),
      cy: axis(22, 23),
    };
  };

  // ── readLocalInput(playerSlot, keyMap, heldKeys) ───────────────────────
  // Reads keyboard, gamepad, and virtual-gamepad (touch) state and returns
  // an input object { buttons, lx, ly, cx, cy }.
  //   playerSlot: 0-3, the local player's slot index
  //   keyMap:     keyboard keyCode→button-index map (from setupKeyTracking)
  //   heldKeys:   Set of currently-held keyCodes

  const readLocalInput = (playerSlot, keyMap, heldKeys) => {
    const input = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };

    // Suppress all input while remap wizard is active
    if (KNState.remapActive) return { ...ZERO_INPUT };

    // 1. Gamepad (analog pipeline, highest fidelity for axes)
    if (document.hasFocus() && window.GamepadManager) {
      const gp = GamepadManager.readGamepad(playerSlot);
      if (gp) {
        input.buttons |= gp.buttons;
        input.lx = gp.lx;
        input.ly = gp.ly;
        input.cx = gp.cx;
        input.cy = gp.cy;
      }
    }

    // 2. Keyboard (digital, with opposing cancellation)
    //    Buttons always merge; axes only if gamepad didn't provide them
    if (keyMap) {
      heldKeys.forEach((kc) => {
        const btnIdx = keyMap[kc];
        if (btnIdx !== undefined && btnIdx < 16) input.buttons |= 1 << btnIdx;
      });
      const kb = readKeyboardAxes(keyMap, heldKeys);
      if (input.lx === 0 && input.ly === 0) {
        input.lx = kb.lx;
        input.ly = kb.ly;
      }
      if (input.cx === 0 && input.cy === 0) {
        input.cx = kb.cx;
        input.cy = kb.cy;
      }
    }

    // 3. Touch/virtual gamepad (mobile)
    const ejs = window.EJS_emulator;
    const ejsMenuOpen =
      ejs &&
      (ejs.settingsMenuOpen ||
        ejs.isPopupOpen?.() ||
        (ejs.elements?.menu && !ejs.elements.menu.classList.contains('ejs_menu_bar_hidden')));
    if (ejsMenuOpen) {
      for (const ck in KNState.touchInput) {
        if (KNState.touchInput.hasOwnProperty(ck)) KNState.touchInput[ck] = 0;
      }
    }

    // Touch left stick: only if no gamepad/keyboard axis input
    const TOUCH_ABS_DEADZONE = 3500;
    const TOUCH_MAX = 32767;
    const stR = KNState.touchInput[16] || 0;
    const stL = KNState.touchInput[17] || 0;
    const stD = KNState.touchInput[18] || 0;
    const stU = KNState.touchInput[19] || 0;
    const stMajor = Math.max(stR, stL, stD, stU);
    if (input.lx === 0 && input.ly === 0 && stMajor > TOUCH_ABS_DEADZONE) {
      const stThresh = stMajor * 0.4;
      // Convert per-direction magnitudes to signed N64 range
      const touchScale = (pos, neg, thresh) => {
        const p = pos > thresh ? pos : 0;
        const n = neg > thresh ? neg : 0;
        return Math.trunc(((p - n) / TOUCH_MAX) * N64_MAX);
      };
      input.lx = touchScale(stR, stL, stThresh);
      input.ly = touchScale(stD, stU, stThresh);
    }

    // Touch digital buttons + C-buttons
    for (const ti in KNState.touchInput) {
      const idx = parseInt(ti, 10);
      if (idx >= 16 && idx <= 19) continue; // left stick handled above
      const val = KNState.touchInput[idx];
      if (!val) continue;
      if (idx < 16) {
        input.buttons |= 1 << idx;
      } else if (idx >= 20 && idx <= 23) {
        // C-buttons from touch: snap to ±N64_MAX
        if (input.cx === 0 && input.cy === 0) {
          if (idx === 20 && val > 0) input.cx = N64_MAX; // C-Right
          if (idx === 21 && val > 0) input.cx = -N64_MAX; // C-Left
          if (idx === 22 && val > 0) input.cy = N64_MAX; // C-Down
          if (idx === 23 && val > 0) input.cy = -N64_MAX; // C-Up
        }
      }
    }

    // Debug input logging
    if (window._debugInputUntil && performance.now() < window._debugInputUntil) {
      if (input.buttons || input.lx || input.ly || input.cx || input.cy) {
        console.log(
          `[input-debug] buttons=${input.buttons} lx=${input.lx} ly=${input.ly} cx=${input.cx} cy=${input.cy}`,
        );
      }
    }

    return input;
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
      // and neutralize its gamepad state reader so it never fires simulateInput.
      if (ejs.gamepad) {
        if (ejs.gamepad.timeout) clearTimeout(ejs.gamepad.timeout);
        ejs.gamepad.loop = () => {};
        ejs.gamepad.getGamepads = () => [];
        ejs.gamepad.updateGamepadState = () => {};
      }

      // Block navigator.getGamepads globally so the WASM core's Emscripten
      // SDL gamepad layer can't read gamepads (it has its own RetroArch
      // button mapping that conflicts with our profiles). Our code uses
      // APISandbox.nativeGetGamepads() which calls Navigator.prototype
      // directly and bypasses this override.
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

  const applyInputToWasm = (slot, input, prevInputs) => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._simulate_input) return;

    // Optional skip-if-unchanged optimization
    if (prevInputs) {
      const prev = prevInputs[slot];
      if (prev && inputEqual(input, prev)) return;
    }

    // Digital buttons (0-15)
    for (let btn = 0; btn < 16; btn++) {
      mod._simulate_input(slot, btn, (input.buttons >> btn) & 1);
    }

    // Left stick — scale N64 range (±83) to WASM range (±32767)
    const scale = 32767 / N64_MAX;
    const clamp = (v) => Math.max(-32767, Math.min(32767, Math.trunc(v * scale)));
    // Bit 16 = X positive (right), 17 = X negative (left)
    mod._simulate_input(slot, 16, input.lx > 0 ? clamp(input.lx) : 0);
    mod._simulate_input(slot, 17, input.lx < 0 ? clamp(-input.lx) : 0);
    // Bit 18 = Y positive (down), 19 = Y negative (up)
    mod._simulate_input(slot, 18, input.ly > 0 ? clamp(input.ly) : 0);
    mod._simulate_input(slot, 19, input.ly < 0 ? clamp(-input.ly) : 0);

    // C-stick (bits 20-23) — axis values OR digital button bitmask.
    // C-buttons can come from either the cx/cy axis values (analog stick)
    // or from digital button mappings (bits 20-23 in input.buttons).
    const cMax = clamp(N64_MAX);
    mod._simulate_input(slot, 20, input.cx > 0 ? clamp(input.cx) : (input.buttons >> 20) & 1 ? cMax : 0);
    mod._simulate_input(slot, 21, input.cx < 0 ? clamp(-input.cx) : (input.buttons >> 21) & 1 ? cMax : 0);
    mod._simulate_input(slot, 22, input.cy > 0 ? clamp(input.cy) : (input.buttons >> 22) & 1 ? cMax : 0);
    mod._simulate_input(slot, 23, input.cy < 0 ? clamp(-input.cy) : (input.buttons >> 23) & 1 ? cMax : 0);

    // Update previous input tracker
    if (prevInputs) {
      prevInputs[slot] = input;
    }
  };

  // ── Input encoding (shared by lockstep + streaming engines) ──────────
  const N64_MAX = 83; // floor(127 * 0.66) — community standard analog range

  const ZERO_INPUT = Object.freeze({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });

  const inputEqual = (a, b) =>
    a.buttons === b.buttons && a.lx === b.lx && a.ly === b.ly && a.cx === b.cx && a.cy === b.cy;

  const packStick = (x, y) => (x & 0xffff) | ((y & 0xffff) << 16);
  const unpackX = (packed) => (packed << 16) >> 16;
  const unpackY = (packed) => packed >> 16;

  // Encode input as Int32:
  //   Header (6 ints, 24 bytes): [frame, buttons, lstick, cstick, ackFrame, redCount]
  //   Followed by redCount × 4 ints: [relFrameOffset, buttons, lstick, cstick]
  //   where absoluteFrame = header.frame - relFrameOffset (always positive).
  //
  // Backward-compatible with the old 5-int32 format: old decoders read the
  // first 5 fields correctly and ignore redCount. New decoders detect and
  // process the redundancy region.
  //
  // Rollback redundancy (P2): each input packet carries the last N frames
  // of local inputs. Receivers dedupe by frame tag via kn_feed_input's
  // existing present/frame check, so duplicates are idempotent corrections.
  const encodeInput = (frame, input, ackFrame = -1, redundantFrames = null) => {
    const redCount = redundantFrames ? redundantFrames.length : 0;
    const arr = new Int32Array(6 + redCount * 4);
    arr[0] = frame;
    arr[1] = input.buttons;
    arr[2] = packStick(input.lx, input.ly);
    arr[3] = packStick(input.cx, input.cy);
    arr[4] = ackFrame;
    arr[5] = redCount;
    for (let i = 0; i < redCount; i++) {
      const r = redundantFrames[i];
      const base = 6 + i * 4;
      arr[base] = frame - r.frame;
      arr[base + 1] = r.buttons;
      arr[base + 2] = packStick(r.lx, r.ly);
      arr[base + 3] = packStick(r.cx, r.cy);
    }
    return arr;
  };

  const decodeInput = (buf) => {
    const arr = new Int32Array(buf);
    const out = {
      frame: arr[0],
      buttons: arr[1],
      lx: unpackX(arr[2]),
      ly: unpackY(arr[2]),
      cx: unpackX(arr[3]),
      cy: unpackY(arr[3]),
      ackFrame: arr.length >= 5 ? arr[4] : -1,
    };
    if (arr.length >= 6 && arr[5] > 0) {
      const redCount = arr[5];
      const redundant = [];
      for (let i = 0; i < redCount; i++) {
        const base = 6 + i * 4;
        if (base + 4 > arr.length) break;
        redundant.push({
          frame: arr[0] - arr[base],
          buttons: arr[base + 1],
          lx: unpackX(arr[base + 2]),
          ly: unpackY(arr[base + 2]),
          cx: unpackX(arr[base + 3]),
          cy: unpackY(arr[base + 3]),
        });
      }
      out.redundant = redundant;
    }
    return out;
  };

  // ── Client event beacon ───────────────────────────────────────────────
  // Fire-and-forget error/event reporting via navigator.sendBeacon().
  // Events land in the server's /api/client-event endpoint.
  window.KNEvent = (type, msg, meta = {}) => {
    if (!KNState?.uploadToken) return;
    // Auto-include match_id so funnel telemetry and existing diagnostic events
    // can correlate by match. Pre-game events (KNState.matchId === null) just
    // omit the field; in-game events get it for free without each call site
    // having to pass it explicitly.
    const enrichedMeta = KNState.matchId ? { ...meta, match_id: KNState.matchId } : meta;
    const body = JSON.stringify({
      type,
      msg,
      meta: enrichedMeta,
      room: KNState.room || '',
      slot: KNState.slot ?? -1,
      ua: navigator.userAgent,
      ts: Date.now(),
    });
    try {
      navigator.sendBeacon(
        `/api/client-event?token=${KNState.uploadToken}&room=${encodeURIComponent(KNState.room || '')}`,
        new Blob([body], { type: 'application/json' }),
      );
    } catch (_) {}
  };

  const createSyncLogRing = (maxSize) => {
    const ring = new Array(maxSize);
    let head = 0;
    let count = 0;
    let seq = 0;
    return {
      push: (entry) => {
        ring[head] = { seq: seq++, ...entry };
        head = (head + 1) % maxSize;
        if (count < maxSize) count++;
      },
      export: () => {
        const lines = [];
        const start = count < maxSize ? 0 : head;
        for (let i = 0; i < count; i++) {
          const e = ring[(start + i) % maxSize];
          lines.push(`${e.seq}\t${e.t.toFixed(1)}\tf=${e.f}\t${e.msg}`);
        }
        return lines.join('\n');
      },
      getStructuredEntries: () => {
        const entries = [];
        const start = count < maxSize ? 0 : head;
        for (let i = 0; i < count; i++) {
          const e = ring[(start + i) % maxSize];
          entries.push({ seq: e.seq, t: e.t, f: e.f, msg: e.msg });
        }
        return entries;
      },
      clear: () => {
        head = 0;
        count = 0;
        seq = 0;
      },
      get length() {
        return count;
      },
    };
  };

  window.KNShared = {
    SSB64_ONLINE_CHEATS: SSB64_ONLINE_CHEATS,
    DEFAULT_N64_KEYMAP: DEFAULT_N64_KEYMAP,
    applyStandardCheats: applyStandardCheats,
    clearCheats: clearCheats,
    bootWithCheats: bootWithCheats,
    drainCandidates: drainCandidates,
    createBasePeer: createBasePeer,
    addBufferedCandidate: addBufferedCandidate,
    createAndSendOffer: createAndSendOffer,
    createAndSendAnswer: createAndSendAnswer,
    resetPeerConnection: resetPeerConnection,
    setupKeyTracking: setupKeyTracking,
    teardownKeyTracking: teardownKeyTracking,
    waitForEmulator: waitForEmulator,
    readLocalInput: readLocalInput,
    disableEJSInput: disableEJSInput,
    applyInputToWasm: applyInputToWasm,
    N64_MAX,
    ZERO_INPUT,
    inputEqual,
    encodeInput,
    decodeInput,
    createSyncLogRing,
  };
})();
