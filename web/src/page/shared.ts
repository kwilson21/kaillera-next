/**
 * Shared utilities for the netplay engines, `window.KNShared`.
 *
 * Provides the input wire format (web/src/input-wire.ts), standard online
 * cheat codes (SSB64 GameShark), the default keyboard mapping, local input
 * reading (keyboard, gamepad, touch) and applyInputToWasm(), which writes a
 * decoded input into the WASM core.
 *
 * Consumed by: netplay-rollback.js, netplay-streaming.js, play.js
 * Exposes: window.KNShared, window.KNEvent (installShared)
 */
import { decodeInput, encodeInput, inputEqual, type WireInput } from '../input-wire.ts';
import { classifyRunnerStep } from '../runner-step.ts';
import { createStickDeadband } from '../stick-deadband.ts';
import { createSyncLogRing, genEpoch } from '../sync-log-ring.ts';
import { clientEvent, pageState, type ClientEvent } from './client-event.ts';
import {
  addBufferedCandidate,
  createAndSendAnswer,
  createAndSendOffer,
  createBasePeer,
  drainCandidates,
  resetPeerConnection,
} from './peer-connection.ts';
import { page, type GameManager, type RunningGameManager } from './shared-globals.ts';

/** One GameShark cheat. */
export interface Cheat {
  desc: string;
  code: string;
}

/** keyCode to input index: 0-15 buttons, 16-19 left stick, 20-23 C buttons. */
export type KeyMap = Record<string, number>;

export const SSB64_ONLINE_CHEATS: Cheat[] = [
  { desc: 'Have All Characters', code: '810A4938 0FF0' },
  { desc: 'Have Mushroom Kingdom', code: '800A4937 00FF' },
  { desc: 'Stock Mode', code: '800A4D0B 0002' },
  { desc: '5 Stocks', code: '800A4D0F 0004' },
  { desc: 'Timer On', code: '800A4D11 0001' },
  { desc: 'Items Off', code: '800A4D24 0000' },
  { desc: 'No Wind', code: '810BA9F1 0000+800BA9F3 0000' },
];

export const DEFAULT_N64_KEYMAP = {
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
} satisfies KeyMap;

export const SSB64_HASH = 'S15592e79d3c5295cef4371d4992f0bd25bec2102fc29644c93e682f7ea99ef3d';

export const N64_MAX = 83; // floor(127 * 0.66) — community standard analog range

export const ZERO_INPUT: Readonly<WireInput> = Object.freeze({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });

/** An input as a caller may hand it over: fields can be missing or out of range. */
type LooseInput = Partial<WireInput> | null | undefined;

/** The last input written per slot, for the skip-if-unchanged check. */
type PreviousInputs = Record<string, WireInput | undefined>;

const isRunning = (gm: GameManager): gm is RunningGameManager => !!gm.Module;

const clampN64Axis = (value: number | undefined): number =>
  Math.max(-N64_MAX, Math.min(N64_MAX, Math.trunc(Number(value) || 0)));

const normalizeInput = (input: LooseInput): WireInput => ({
  buttons: input?.buttons || 0,
  lx: clampN64Axis(input?.lx),
  ly: clampN64Axis(input?.ly),
  cx: clampN64Axis(input?.cx),
  cy: clampN64Axis(input?.cy),
});

// ── Keyboard input helpers ─────────────────────────────────────────────

const readKeyboardAxes = (keyMap: KeyMap, heldKeys: Set<number>): Omit<WireInput, 'buttons'> => {
  const hasKey = (bit: number): boolean => {
    for (const kc of heldKeys) {
      if (keyMap[kc] === bit) return true;
    }
    return false;
  };
  const axis = (posBit: number, negBit: number): number => {
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

// Is `cb` Emscripten's main-loop runner (the one stepOneFrame() must
// capture), as opposed to a UI requestAnimationFrame callback (#62 —
// rollback's rAF interceptor used to capture ANY callback passed to
// requestAnimationFrame, so a page UI callback — e.g. toggleMoreDropdown
// in play.js, _openModal in feedback.js — firing rAF during a match would
// overwrite the captured runner and strand the emulator). All four
// patched cores served in rollback mode (mupen64plus_next / parallel_n64,
// normal and legacy) define `function MainLoop_runner()`, and rollback
// always loads a patched core via core-redirector.js, so name-matching it
// is reliable. Pure so it's testable without a WASM/DOM harness — see
// tests/main-loop-runner-filter.test.mjs.
export const isMainLoopRunner = (cb: FrameRequestCallback | null | undefined): boolean =>
  typeof cb === 'function' && cb.name === 'MainLoop_runner';

/**
 * Build the shared utilities. Each call has its own key tracking and boot
 * state; a page makes one (installShared).
 */
export const createShared = () => {
  async function applyStandardCheats(cheats: Cheat[]): Promise<void> {
    try {
      const gm = await waitForEmulator();
      cheats.forEach((c, i) => {
        gm.setCheat(i, 1, c.code);
      });
      console.log('[netplay] applied', cheats.length, 'standard cheats');
    } catch (e) {
      console.error('[netplay] cheat application failed:', e instanceof Error ? e.message : undefined);
    }
  }

  async function clearCheats(disableKnownCheats = true): Promise<void> {
    try {
      const gm = await waitForEmulator();
      if (typeof gm.resetCheat === 'function') {
        gm.resetCheat();
      } else if (typeof gm.Module?._reset_cheat === 'function') {
        gm.Module._reset_cheat();
      }
      if (disableKnownCheats) {
        SSB64_ONLINE_CHEATS.forEach((c, i) => {
          gm.setCheat(i, 0, c.code);
        });
      }
      console.log('[netplay] cleared all cheats');
    } catch (e) {
      console.error('[netplay] cheat clear failed:', e instanceof Error ? e.message : undefined);
    }
  }

  let _listenersAdded = false;
  let _activeHeldKeys: Set<number> | null = null;
  let _keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  let _keyupHandler: ((e: KeyboardEvent) => void) | null = null;
  let _blurHandler: (() => void) | null = null;
  let _visibilityHandler: (() => void) | null = null;
  // Sticky press-since-last-read tracking: keydown adds, keyup does NOT
  // remove. readLocalInput merges this into the held set on each call
  // then clears it. Prevents quick press+release from being dropped
  // when the gap between two forward-tick reads is longer than the
  // press itself. The gap is normally one rAF (~16 ms) but during a
  // rollback replay window it stretches to depth*16 ms — JS skips
  // readLocalInput on replay ticks (uses historical _localInputs[F]),
  // so a press that happens entirely within a 100-180 ms replay window
  // would otherwise never reach the engine. This also helps any case
  // where a press is shorter than one frame (e.g. very-fast taps,
  // gamepad-to-keyboard bridging at >60 Hz).
  const _recentlyPressedKeys = new Set<number>();

  function clearHeldKeysOnFocusLoss(): void {
    if (_activeHeldKeys) _activeHeldKeys.clear();
    _recentlyPressedKeys.clear();
  }

  function ensureKeyTrackingListeners(): void {
    if (!_listenersAdded) {
      _keydownHandler = (e) => {
        if (_activeHeldKeys) _activeHeldKeys.add(e['keyCode']);
        _recentlyPressedKeys.add(e['keyCode']);
      };
      _keyupHandler = (e) => {
        if (_activeHeldKeys) _activeHeldKeys.delete(e['keyCode']);
      };
      _blurHandler = () => {
        clearHeldKeysOnFocusLoss();
      };
      _visibilityHandler = () => {
        if (document.hidden) clearHeldKeysOnFocusLoss();
      };
      window.addEventListener('keydown', _keydownHandler, true);
      window.addEventListener('keyup', _keyupHandler, true);
      document.addEventListener('keydown', _keydownHandler, true);
      document.addEventListener('keyup', _keyupHandler, true);
      window.addEventListener('blur', _blurHandler, true);
      document.addEventListener('visibilitychange', _visibilityHandler, true);
      _listenersAdded = true;
    }
  }

  function setupKeyTracking(keymap: KeyMap | null | undefined, heldKeys: Set<number>): KeyMap {
    _activeHeldKeys = heldKeys;
    if (keymap) {
      ensureKeyTrackingListeners();
      return keymap;
    }

    let resolved: KeyMap | null = null;

    // Check localStorage for custom keyboard mapping first
    try {
      const saved = pageState().safeGet('localStorage', 'keyboard-mapping');
      if (saved) {
        // The player's own saved mapping, keyCode to input index, used as stored.
        const parsed: KeyMap | null = JSON.parse(saved);
        if (parsed && Object.keys(parsed).length > 0) {
          const fromStorage: KeyMap = {};
          for (const [k, index] of Object.entries(parsed)) fromStorage[parseInt(k, 10)] = index;
          resolved = fromStorage;
        }
      }
    } catch {}

    // Try EJS controls if no custom mapping
    if (!resolved) {
      const ejs = page().EJS_emulator;
      const bindings = ejs?.controls?.[0];
      if (bindings) {
        const fromEjs: KeyMap = {};
        Object.entries(bindings).forEach(([btnIdx, binding]) => {
          const kc = binding && binding.value;
          if (kc) fromEjs[kc] = parseInt(btnIdx, 10);
        });
        resolved = fromEjs;
      }
    }

    if (!resolved || Object.keys(resolved).length === 0) {
      resolved = Object.assign({}, DEFAULT_N64_KEYMAP);
    }

    ensureKeyTrackingListeners();

    return resolved;
  }

  function teardownKeyTracking(): void {
    if (_listenersAdded) {
      if (_keydownHandler) {
        window.removeEventListener('keydown', _keydownHandler, true);
        document.removeEventListener('keydown', _keydownHandler, true);
      }
      if (_keyupHandler) {
        window.removeEventListener('keyup', _keyupHandler, true);
        document.removeEventListener('keyup', _keyupHandler, true);
      }
      if (_blurHandler) window.removeEventListener('blur', _blurHandler, true);
      if (_visibilityHandler) document.removeEventListener('visibilitychange', _visibilityHandler, true);
      _keydownHandler = null;
      _keyupHandler = null;
      _blurHandler = null;
      _visibilityHandler = null;
      _listenersAdded = false;
    }
    if (_activeHeldKeys) {
      _activeHeldKeys.clear();
      _activeHeldKeys = null;
    }
  }

  let _bootPromise: Promise<RunningGameManager> | null = null; // deduplication: only one poll loop at a time
  let _funnelLastBootedMatchId: string | null = null; // P0-1 funnel: emulator_booted fires once per match

  function resetBootState(): void {
    _bootPromise = null;
    console.log('[netplay] boot state reset');
  }

  function enableMobileTouch(): void {
    if (!('ontouchstart' in window)) return;
    // Netplay engines disable EJS touch and use a custom virtual gamepad.
    // Don't re-enable it on subsequent waitForEmulator() calls.
    if (page()._kn_ejsTouchDisabled) return;
    const ejs = page().EJS_emulator;
    if (!ejs || ejs.touch) return;
    ejs.touch = true;
    if (ejs.virtualGamepad) ejs.virtualGamepad.style.display = '';
    console.log('[netplay] enabled mobile touch controls');
  }

  function waitForEmulator(timeoutMs?: number): Promise<RunningGameManager> {
    const bt = page()._knBootLog || (() => {});
    if (_bootPromise) {
      bt('waitForEmulator-reuse');
      return _bootPromise;
    }
    const waitMs = timeoutMs || 30000;
    bt('waitForEmulator-start', { timeoutMs: waitMs });

    _bootPromise = new Promise<RunningGameManager>((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = Math.ceil(waitMs / 200);
      let _lastState = ''; // track state transitions to log only changes

      const attempt = (): void => {
        const ejs = page().EJS_emulator;
        // Always try clicking the EJS start button first — with startOnLoaded=false
        // (guests), Module may exist before the game loop starts. If we resolve
        // on Module alone, the start button never gets clicked and frames stay at 0.
        const btn = document.querySelector<HTMLElement>('.ejs_start_button');
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
        if (gm && isRunning(gm)) {
          const mod = gm.Module;
          const frames = mod._get_current_frame_count ? mod._get_current_frame_count() : 'n/a';
          const audioState = mod.SDL2?.audioContext?.state ?? 'n/a';
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
          const matchId = pageState().matchId;
          if (typeof frames === 'number' && frames >= 1 && matchId && _funnelLastBootedMatchId !== matchId) {
            _funnelLastBootedMatchId = matchId;
            clientEvent('emulator_booted', '', { frames });
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
            ? Object.entries(ejs)
                .filter(([, value]) => typeof value !== 'function')
                .map(([k]) => k)
                .slice(0, 15)
                .join(',')
            : 'null';
          console.log(
            `[netplay] waitForEmulator poll #${attempts}: EJS=${!!ejs} gameManager=${!!gm} btn=${!!btn} ejsState=[${ejsKeys}]`,
          );
        }
        if (++attempts >= maxAttempts) {
          _bootPromise = null;
          const now = page().EJS_emulator;
          const snapshot = {
            ejs: !!now,
            gameManager: !!now?.gameManager,
            module: !!now?.gameManager?.Module,
            btn: !!document.querySelector('.ejs_start_button'),
            audioCtxState: page()._kn_preloadedAudioCtx?.state ?? 'none',
          };
          bt('waitForEmulator-timeout', snapshot);
          clientEvent('wasm-fail', `Emulator boot timed out after ${waitMs}ms`, snapshot);
          reject(new Error(`Emulator boot timed out after ${waitMs}ms`));
          return;
        }
        setTimeout(attempt, 200);
      };
      attempt();
    });

    return _bootPromise;
  }

  // Fire-and-forget wrapper for backward compat
  async function triggerEmulatorStart(): Promise<void> {
    try {
      await waitForEmulator();
    } catch (err) {
      console.error('[netplay]', err instanceof Error ? err.message : undefined);
    }
  }

  // ── disableEJSInput(label) ────────────────────────────────────────────
  // Disables EmulatorJS's native keyboard, gamepad, and (if APISandbox is
  // available) WASM-level gamepad handling.
  //   label: string for the timeout warning, e.g. 'lockstep' or 'streaming'
  //
  // Idempotent across same-ROM rematches: hibernation reuses the EJS parent,
  // so we track the previously-installed parent listeners + retry timer and
  // remove them before re-installing on the next call.

  let _ejsBlockHandler: ((e: Event) => void) | null = null;
  let _ejsBlockedParent: HTMLElement | null = null;
  let _ejsBlockTimer: ReturnType<typeof setTimeout> | null = null;

  const _clearPriorBlockers = (): void => {
    if (_ejsBlockTimer) {
      clearTimeout(_ejsBlockTimer);
      _ejsBlockTimer = null;
    }
    if (_ejsBlockedParent && _ejsBlockHandler) {
      _ejsBlockedParent.removeEventListener('keydown', _ejsBlockHandler, true);
      _ejsBlockedParent.removeEventListener('keyup', _ejsBlockHandler, true);
    }
    _ejsBlockedParent = null;
    _ejsBlockHandler = null;
  };

  const disableEJSInput = (label?: string): void => {
    // Drop the previous boot's parent listeners + retry timer so a same-ROM
    // rematch (which reuses the hibernated EJS parent) does not stack blockers.
    _clearPriorBlockers();

    let attempts = 0;
    const tag = label || 'netplay';
    const attempt = (): void => {
      _ejsBlockTimer = null;
      const ejs = page().EJS_emulator;
      const gm = ejs?.gameManager;
      if (!ejs || !gm) {
        if (++attempts < 150) {
          _ejsBlockTimer = setTimeout(attempt, 200);
        } else {
          console.warn(`[${tag}] disableEJSInput timed out`);
        }
        return;
      }

      // Disable EJS keyboard handling
      gm.setKeyboardEnabled(false);
      const parent = ejs.elements?.parent;
      if (parent) {
        const block = (e: Event): void => {
          e.stopImmediatePropagation();
        };
        parent.addEventListener('keydown', block, true);
        parent.addEventListener('keyup', block, true);
        _ejsBlockHandler = block;
        _ejsBlockedParent = parent;
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
      const sandbox = page().APISandbox;
      if (sandbox?.overrideGetGamepads) {
        sandbox.overrideGetGamepads(() => []);
      }
    };
    attempt();
  };

  // Common boot sequence: wait for emulator, apply cheats, disable EJS input.
  // Used by both lockstep and streaming engines at host/guest boot time.
  function bootWithCheats(label?: string): void {
    void triggerEmulatorStart();
    // Only apply SSB64 cheats for vanilla SSB64 — Smash Remix has different
    // memory layout and the cheat addresses cause memory access out of bounds.
    if (window.KNState?.romHash === SSB64_HASH) {
      void applyStandardCheats(SSB64_ONLINE_CHEATS);
    } else {
      page().EJS_cheats = [];
      void clearCheats(false);
    }
    disableEJSInput(label);
  }

  // ── readLocalInput(playerSlot, keyMap, heldKeys) ───────────────────────
  // Reads keyboard, gamepad, and virtual-gamepad (touch) state and returns
  // an input object { buttons, lx, ly, cx, cy }.
  //   playerSlot: 0-3, the local player's slot index
  //   keyMap:     keyboard keyCode→button-index map (from setupKeyTracking)
  //   heldKeys:   Set of currently-held keyCodes

  const readLocalInput = (playerSlot: number, keyMap: KeyMap | null | undefined, heldKeys: Set<number>): WireInput => {
    const input = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
    const pageFocused =
      typeof document === 'undefined' || typeof document.hasFocus !== 'function' || document.hasFocus();

    const state = pageState();
    // Suppress all input while remap wizard is active
    if (state.remapActive) return { ...ZERO_INPUT };

    // 1. Gamepad (analog pipeline, highest fidelity for axes)
    const gamepads = page().GamepadManager;
    if (pageFocused && gamepads) {
      const gp = gamepads.readGamepad(playerSlot);
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
      if (!pageFocused) {
        heldKeys?.clear?.();
        _recentlyPressedKeys.clear();
      } else {
        // Merge any key that was pressed since the previous read into
        // the held set for the duration of THIS read. _recentlyPressedKeys
        // is sticky on keydown / non-sticky on keyup, so a press+release
        // that landed entirely within a rollback replay window (where
        // readLocalInput was skipped) still surfaces here as one held
        // frame. After consumption it's cleared so the very next read
        // sees the actual current state. See _recentlyPressedKeys def.
        const stickyAdded: number[] = [];
        if (_recentlyPressedKeys.size > 0) {
          _recentlyPressedKeys.forEach((kc) => {
            if (!heldKeys.has(kc)) {
              stickyAdded.push(kc);
              heldKeys.add(kc);
            }
          });
          _recentlyPressedKeys.clear();
        }
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
        // Remove sticky-only keys after sampling so the NEXT read sees
        // genuinely-held keys only. Without this, a sticky-pressed key
        // that the user already released would appear to stay held on
        // every subsequent read until another keyup arrives — which
        // never does because the actual physical keyup already fired.
        for (const kc of stickyAdded) heldKeys.delete(kc);
      }
    }

    // 3. Touch/virtual gamepad (mobile)
    const touch = state.touchInput;
    const ejs = page().EJS_emulator;
    const ejsMenuOpen =
      ejs &&
      (ejs.settingsMenuOpen ||
        ejs.isPopupOpen?.() ||
        (ejs.elements?.menu && !ejs.elements.menu.classList.contains('ejs_menu_bar_hidden')));
    if (ejsMenuOpen) {
      for (const ck in touch) {
        if (Object.hasOwn(touch, ck)) touch[ck] = 0;
      }
    }

    // Touch left stick: only if no gamepad/keyboard axis input
    const TOUCH_ABS_DEADZONE = 3500;
    const TOUCH_MAX = 32767;
    const stR = touch[16] || 0;
    const stL = touch[17] || 0;
    const stD = touch[18] || 0;
    const stU = touch[19] || 0;
    const stMajor = Math.max(stR, stL, stD, stU);
    if (input.lx === 0 && input.ly === 0 && stMajor > TOUCH_ABS_DEADZONE) {
      const stThresh = stMajor * 0.4;
      // Convert per-direction magnitudes to signed N64 range
      const touchScale = (pos: number, neg: number, thresh: number): number => {
        const p = pos > thresh ? Math.min(pos, TOUCH_MAX) : 0;
        const n = neg > thresh ? Math.min(neg, TOUCH_MAX) : 0;
        return clampN64Axis(((p - n) / TOUCH_MAX) * N64_MAX);
      };
      input.lx = touchScale(stR, stL, stThresh);
      input.ly = touchScale(stD, stU, stThresh);
    }

    // Touch digital buttons + C-buttons
    for (const ti in touch) {
      const idx = parseInt(ti, 10);
      if (idx >= 16 && idx <= 19) continue; // left stick handled above
      const val = touch[idx];
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

    input.lx = clampN64Axis(input.lx);
    input.ly = clampN64Axis(input.ly);
    input.cx = clampN64Axis(input.cx);
    input.cy = clampN64Axis(input.cy);

    // Debug input logging
    const debugUntil = page()._debugInputUntil;
    if (debugUntil && performance.now() < debugUntil) {
      if (input.buttons || input.lx || input.ly || input.cx || input.cy) {
        console.log(
          `[input-debug] buttons=${input.buttons} lx=${input.lx} ly=${input.ly} cx=${input.cx} cy=${input.cy}`,
        );
      }
    }

    return input;
  };

  // ── applyInputToWasm(slot, input, prevInputs) ─────────────────────────
  // Writes an input to the WASM core.
  //   slot:       player slot index (0-3)
  //   input:      { buttons, lx, ly, cx, cy }; buttons 0-15 digital,
  //               16-19 L-stick, 20-23 C-buttons
  //   prevInputs: optional object mapping slot→previous input; when provided,
  //               skips the write if the input is unchanged (streaming optimization)

  const applyInputToWasm = (slot: number, input: LooseInput, prevInputs?: PreviousInputs | null): void => {
    const mod = page().EJS_emulator?.gameManager?.Module;
    const writeController = mod?._kn_write_controller;
    const simulateInput = mod?._kn_netplay_simulate_input || mod?._simulate_input;
    if (!writeController && !simulateInput) return;
    const safeInput = normalizeInput(input);

    // Optional skip-if-unchanged optimization
    if (prevInputs) {
      const prev = prevInputs[slot];
      if (prev && inputEqual(safeInput, prev)) return;
    }

    if (writeController) {
      writeController(slot, safeInput.buttons, safeInput.lx, safeInput.ly, safeInput.cx, safeInput.cy);
      if (prevInputs) {
        prevInputs[slot] = safeInput;
      }
      return;
    }
    if (!simulateInput) return;

    // Digital buttons (0-15)
    for (let btn = 0; btn < 16; btn++) {
      simulateInput(slot, btn, (safeInput.buttons >> btn) & 1);
    }

    // Left stick — scale N64 range (±83) to WASM range (±32767)
    const scale = 32767 / N64_MAX;
    const clamp = (v: number): number => Math.max(-32767, Math.min(32767, Math.trunc(v * scale)));
    // Bit 16 = X positive (right), 17 = X negative (left)
    simulateInput(slot, 16, safeInput.lx > 0 ? clamp(safeInput.lx) : 0);
    simulateInput(slot, 17, safeInput.lx < 0 ? clamp(-safeInput.lx) : 0);
    // Bit 18 = Y positive (down), 19 = Y negative (up)
    simulateInput(slot, 18, safeInput.ly > 0 ? clamp(safeInput.ly) : 0);
    simulateInput(slot, 19, safeInput.ly < 0 ? clamp(-safeInput.ly) : 0);

    // C-stick (bits 20-23) — axis values OR digital button bitmask.
    // C-buttons can come from either the cx/cy axis values (analog stick)
    // or from digital button mappings (bits 20-23 in input.buttons).
    const cMax = clamp(N64_MAX);
    simulateInput(slot, 20, safeInput.cx > 0 ? clamp(safeInput.cx) : (safeInput.buttons >> 20) & 1 ? cMax : 0);
    simulateInput(slot, 21, safeInput.cx < 0 ? clamp(-safeInput.cx) : (safeInput.buttons >> 21) & 1 ? cMax : 0);
    simulateInput(slot, 22, safeInput.cy > 0 ? clamp(safeInput.cy) : (safeInput.buttons >> 22) & 1 ? cMax : 0);
    simulateInput(slot, 23, safeInput.cy < 0 ? clamp(-safeInput.cy) : (safeInput.buttons >> 23) & 1 ? cMax : 0);

    // Update previous input tracker
    if (prevInputs) {
      prevInputs[slot] = safeInput;
    }
  };

  return {
    SSB64_ONLINE_CHEATS: SSB64_ONLINE_CHEATS,
    SSB64_HASH: SSB64_HASH,
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
    resetBootState: resetBootState,
    readLocalInput: readLocalInput,
    createStickDeadband,
    genEpoch,
    disableEJSInput: disableEJSInput,
    applyInputToWasm: applyInputToWasm,
    N64_MAX,
    ZERO_INPUT,
    // The input wire format and the helpers below are web/src's own, the
    // functions the engines also reach as KNCore.encodeInput and so on.
    inputEqual,
    encodeInput,
    decodeInput,
    createSyncLogRing,
    classifyRunnerStep,
    isMainLoopRunner,
  };
};

export type Shared = ReturnType<typeof createShared>;

/** Define `window.KNShared` and `window.KNEvent` for the plain-script pages. */
export const installShared = (): void => {
  window.KNEvent = clientEvent;
  window.KNShared = createShared();
};

declare global {
  interface Window {
    KNShared?: Shared;
    KNEvent?: ClientEvent;
  }
}
