(function () {
  'use strict';

  const DEMO_SOCKET_ID = 'demo-local';
  const _nativeRAF = window.APISandbox?.nativeRAF || window.requestAnimationFrame.bind(window);

  const _installEjsGlobals = () => {
    window.EJS_player = '#game';
    window.EJS_core = 'n64';
    window.EJS_gameID = 'kaillera-next-demo';
    window.EJS_startOnLoaded = true;
    window.EJS_pathtodata = '/static/ejs/';
    window.EJS_defaultOptions = {
      'mupen64plus-cpucore': 'cached_interpreter',
    };

    window.__knInstallUnpackAlignmentShim = () => {
      [window.WebGLRenderingContext, window.WebGL2RenderingContext].forEach((ctor) => {
        const proto = ctor && ctor.prototype;
        if (!proto || proto.__knUnpackAlignmentPatched) return;
        proto.__knUnpackAlignmentPatched = true;
        ['texImage2D', 'texSubImage2D', 'compressedTexImage2D', 'compressedTexSubImage2D'].forEach((name) => {
          const original = proto[name];
          if (typeof original !== 'function') return;
          proto[name] = function (...args) {
            try {
              this.pixelStorei(this.UNPACK_ALIGNMENT, 1);
            } catch (_) {}
            return original.apply(this, args);
          };
        });
      });
    };

    const params = new URLSearchParams(window.location.search || '');
    const gfxProfile = params.get('kngfx');
    if (gfxProfile === 'texrect') {
      Object.assign(window.EJS_defaultOptions, {
        'mupen64plus-EnableNativeResTexrects': 'Optimized',
        'mupen64plus-EnableTexCoordBounds': 'True',
        'mupen64plus-CorrectTexrectCoords': 'Force',
      });
    } else if (gfxProfile === 'texrect-unopt') {
      Object.assign(window.EJS_defaultOptions, {
        'mupen64plus-EnableNativeResTexrects': 'Unoptimized',
        'mupen64plus-EnableTexCoordBounds': 'True',
        'mupen64plus-CorrectTexrectCoords': 'Force',
        'mupen64plus-BackgroundMode': 'Stripped',
      });
    } else if (gfxProfile === 'webgl1') {
      window.EJS_forceLegacyCores = true;
      window.EJS_defaultOptions.webgl2Enabled = 'disabled';
    } else if (gfxProfile === 'angrylion') {
      window.EJS_defaultOptions['mupen64plus-rdp-plugin'] = 'angrylion';
    } else if (gfxProfile === 'parallel') {
      window.EJS_defaultOptions['mupen64plus-rdp-plugin'] = 'parallel';
    } else if (gfxProfile === 'unpack1') {
      window.__knInstallUnpackAlignmentShim();
    }

    window.EJS_defaultControls = {
      0: {
        0: { value: 'c', value2: 'BUTTON_2' },
        1: { value: 'x', value2: 'BUTTON_4' },
        3: { value: 'v', value2: 'START' },
        4: { value: 'up arrow', value2: 'DPAD_UP' },
        5: { value: 'down arrow', value2: 'DPAD_DOWN' },
        6: { value: 'left arrow', value2: 'DPAD_LEFT' },
        7: { value: 'right arrow', value2: 'DPAD_RIGHT' },
        10: { value: 't', value2: 'LEFT_TOP_SHOULDER' },
        11: { value: 'y', value2: 'RIGHT_TOP_SHOULDER' },
        12: { value: 'z', value2: 'LEFT_BOTTOM_SHOULDER' },
        16: { value: 'd', value2: 'LEFT_STICK_X:+1' },
        17: { value: 'a', value2: 'LEFT_STICK_X:-1' },
        18: { value: 's', value2: 'LEFT_STICK_Y:+1' },
        19: { value: 'w', value2: 'LEFT_STICK_Y:-1' },
        20: { value: 'j', value2: 'RIGHT_STICK_X:+1' },
        21: { value: 'l', value2: 'RIGHT_STICK_X:-1' },
        22: { value: 'k', value2: 'RIGHT_STICK_Y:+1' },
        23: { value: 'i', value2: 'RIGHT_STICK_Y:-1' },
        24: { value: '', value2: '' },
        25: { value: '', value2: '' },
        26: { value: '', value2: '' },
      },
      1: {},
      2: {},
      3: {},
    };
  };

  _installEjsGlobals();

  // ROM cache — IDB so Reset can re-init the engine without making the
  // user re-drop the ROM. Stop clears it so the next visit hits the
  // drop-ROM screen normally. Bytes-only persistence; no metadata
  // beyond filename so we can rebuild the File object on auto-restore.
  const _ROM_DB_NAME = 'kn-demo-rom';
  const _ROM_DB_STORE = 'rom';
  const _ROM_DB_KEY = 'current';
  const _idbRomSave = (bytes, name) =>
    new Promise((resolve) => {
      try {
        const req = indexedDB.open(_ROM_DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(_ROM_DB_STORE);
        req.onsuccess = () => {
          const db = req.result;
          try {
            const tx = db.transaction(_ROM_DB_STORE, 'readwrite');
            tx.objectStore(_ROM_DB_STORE).put({ bytes, name }, _ROM_DB_KEY);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              resolve();
            };
          } catch (_) {
            db.close();
            resolve();
          }
        };
        req.onerror = () => resolve();
      } catch (_) {
        resolve();
      }
    });
  const _idbRomLoad = () =>
    new Promise((resolve) => {
      try {
        const req = indexedDB.open(_ROM_DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(_ROM_DB_STORE);
        req.onsuccess = () => {
          const db = req.result;
          try {
            const tx = db.transaction(_ROM_DB_STORE, 'readonly');
            const get = tx.objectStore(_ROM_DB_STORE).get(_ROM_DB_KEY);
            get.onsuccess = () => {
              db.close();
              resolve(get.result || null);
            };
            get.onerror = () => {
              db.close();
              resolve(null);
            };
          } catch (_) {
            db.close();
            resolve(null);
          }
        };
        req.onerror = () => resolve(null);
      } catch (_) {
        resolve(null);
      }
    });
  const _idbRomClear = () =>
    new Promise((resolve) => {
      try {
        const req = indexedDB.open(_ROM_DB_NAME, 1);
        req.onsuccess = () => {
          const db = req.result;
          try {
            const tx = db.transaction(_ROM_DB_STORE, 'readwrite');
            tx.objectStore(_ROM_DB_STORE).delete(_ROM_DB_KEY);
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onerror = () => {
              db.close();
              resolve();
            };
          } catch (_) {
            db.close();
            resolve();
          }
        };
        req.onerror = () => resolve();
      } catch (_) {
        resolve();
      }
    });

  let _romBlobUrl = null;
  let _romHash = null;
  let _engineStarted = false;
  let _emulatorBootInFlight = false;
  let _loaderInjected = false;
  let _rollbackEnabled = true;

  // Menu autopilot — record user inputs once, replay them on every demo load
  // to skip menu navigation and drop the user straight into a match.
  //
  // Record modes (URL param):
  //   ?record=1  → user controls P1, P2 follows the baked P2 autopilot. The
  //                user's inputs are captured to bake as a new
  //                MENU_AUTOPILOT_P1_TRANSITIONS list.
  //   ?record=p2 → P1 follows the baked P1 autopilot, user's input is captured
  //                as P2's input AND routed to fake-peer so the user can steer
  //                P2's CSS cursor in real time. Captured stream gets baked as
  //                MENU_AUTOPILOT_P2_TRANSITIONS for fake-peer to mirror onto
  //                slot 1 during normal playback.
  // The replay path suppresses real keyboard/touch during autopilot so the
  // user's first sensation of input is on match start.
  const _urlParams = new URLSearchParams(window.location.search || '');
  const _recordParam = _urlParams.get('record');
  const _randomP1InMatch =
    _urlParams.get('randomP1') === '1' || _urlParams.get('demoRandomP1') === '1' || _urlParams.get('p1Random') === '1';
  let _recordMode = _recordParam === '1' ? 'p1' : _recordParam === 'p2' ? 'p2' : false;
  const _recordedInputs = [];
  let _recordingActive = false;
  let _recordingDone = false;
  let _autopilotActive = false;
  let _wrappedReadLocalInput = false;
  let _heldRandomP1Input = null;
  let _heldRandomP1UntilFrame = -1;
  const RANDOM_P1_BUTTON_BITS = [0, 1, 4, 5, 6, 7, 11, 12];
  const _randomP1Axis = () => {
    const max = window.KNShared?.N64_MAX ?? 83;
    const mag = Math.max(18, Math.round((0.35 + Math.random() * 0.65) * max));
    return Math.random() < 0.5 ? -mag : mag;
  };
  const _randomP1Input = () => {
    if (Math.random() < 0.65) {
      const bit = RANDOM_P1_BUTTON_BITS[Math.floor(Math.random() * RANDOM_P1_BUTTON_BITS.length)];
      return { buttons: 1 << bit, lx: 0, ly: 0, cx: 0, cy: 0 };
    }
    if (Math.random() < 0.5) {
      return { buttons: 0, lx: _randomP1Axis(), ly: _randomP1Axis(), cx: 0, cy: 0 };
    }
    return { buttons: 0, lx: 0, ly: 0, cx: _randomP1Axis(), cy: _randomP1Axis() };
  };
  const _randomP1InputForFrame = (frame) => {
    if (frame > _heldRandomP1UntilFrame || !_heldRandomP1Input) {
      _heldRandomP1Input = _randomP1Input();
      // Match the fake peer's 30-90 frame hold so prediction misses align
      // with real human-cadence input changes, not per-150ms churn.
      _heldRandomP1UntilFrame = frame + 30 + Math.floor(Math.random() * 60);
    }
    return _heldRandomP1Input;
  };
  // P2 menu autopilot — sparse list of input transitions for the synthetic
  // opponent so it picks a CSS character without us scripting per-frame
  // inputs. Format: [frame, buttons, lx, ly, cx, cy] sorted by frame. Replay
  // at frame N returns the entry with the largest frame <= N (or zero if no
  // entry yet). To regenerate: visit ?record=p2, play through CSS as P2,
  // download kn-demo-autopilot-p2.json, trim to transitions only.
  const MENU_AUTOPILOT_P2_TRANSITIONS = [
    [591, 0, 83, 0, 0, 0],
    [600, 0, 83, -83, 0, 0],
    [620, 0, 83, 0, 0, 0],
    [636, 0, 0, 0, 0, 0],
    [654, 0, 0, -83, 0, 0],
    [659, 0, 0, 0, 0, 0],
    [682, 1, 0, 0, 0, 0],
    [687, 0, 0, 0, 0, 0],
  ];
  const _p2InputAtFrame = (frame) => {
    let lo = 0;
    let hi = MENU_AUTOPILOT_P2_TRANSITIONS.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (MENU_AUTOPILOT_P2_TRANSITIONS[mid][0] <= frame) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best < 0) return null;
    const e = MENU_AUTOPILOT_P2_TRANSITIONS[best];
    return { buttons: e[1], lx: e[2], ly: e[3], cx: e[4], cy: e[5] };
  };

  // P1 menu autopilot — sparse list of input transitions captured via
  // ?record=1, then hand-extracted to deduplicate consecutive same-input
  // frames. Format: [frame, buttons, lx, ly, cx, cy]. Replay returns the
  // entry with the largest frame <= currentFrame (or zero if no entry
  // yet). To regenerate: visit ?record=1, play to a match, download
  // kn-demo-autopilot.json, then dedupe consecutive same-input frames.
  // Min hold ≥5 frames for any button-press transition: the recording
  // captures the exact press width the user produced, but at runtime
  // the engine's tick cadence (rAF jitter, delay drift between
  // recording and replay) can shrink the effective window by 1-2
  // frames. CSS character-confirm A-presses captured at 3 frames
  // (released at 680 originally) intermittently fell outside their
  // window and the autopilot stalled on the character grid.
  const MENU_AUTOPILOT_P1_TRANSITIONS = [
    [101, 0, 0, 0, 0, 0],
    [162, 8, 0, 0, 0, 0],
    [167, 0, 0, 0, 0, 0],
    [411, 8, 0, 0, 0, 0],
    [415, 0, 0, 0, 0, 0],
    [439, 0, 0, 83, 0, 0],
    [443, 0, 0, 0, 0, 0],
    [460, 1, 0, 0, 0, 0],
    [464, 0, 0, 0, 0, 0],
    [484, 1, 0, 0, 0, 0],
    [490, 0, 0, 0, 0, 0],
    [586, 0, 83, 0, 0, 0],
    [597, 0, 83, -83, 0, 0],
    [616, 0, 83, 0, 0, 0],
    [645, 0, 0, 0, 0, 0],
    [659, 0, 83, 0, 0, 0],
    [662, 0, 0, 0, 0, 0],
    [677, 1, 0, 0, 0, 0],
    [683, 0, 0, 0, 0, 0],
    [736, 8, 0, 0, 0, 0],
    [742, 0, 0, 0, 0, 0],
    [871, 0, -83, 0, 0, 0],
    [875, 0, 0, 0, 0, 0],
    [895, 0, 0, -83, 0, 0],
    [899, 0, 0, 0, 0, 0],
    [917, 1, 0, 0, 0, 0],
    [922, 0, 0, 0, 0, 0],
  ];
  const _p1InputAtFrame = (frame) => {
    let lo = 0;
    let hi = MENU_AUTOPILOT_P1_TRANSITIONS.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (MENU_AUTOPILOT_P1_TRANSITIONS[mid][0] <= frame) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (best < 0) return null;
    const e = MENU_AUTOPILOT_P1_TRANSITIONS[best];
    return { buttons: e[1], lx: e[2], ly: e[3], cx: e[4], cy: e[5] };
  };

  // Compute SHA-256 of ROM bytes in the format the engine's _SMASH_REMIX_HASHES
  // set uses ('S' + 64 hex chars). This lets _isSmashRemix() detect Smash
  // Remix ROMs without us hardcoding gameId. Wrong gameId means the engine
  // reads from the wrong RDRAM addresses (Smash Remix and SSB64 use different
  // game_status offsets), and isInMatch returns wrong values.
  const _hashRom = async (bytes) => {
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return 'S' + hex;
    } catch (_) {
      return null;
    }
  };

  const AUTO_COMPARE_PERIOD_MS = 6000;
  let _autoCompareTimer = 0;
  let _autoCompareStart = 0;
  let _autoCompareCycle = 0;
  // Wall-clock timestamp when auto-compare was paused (0 = not paused). Used
  // to offset _autoCompareStart on resume so the cycle picks up where it left
  // off rather than restarting at phase 0.
  let _autoComparePausedAt = 0;

  let _lastTotalPreds = 0;
  let _lastPredSampleAt = 0;
  // EMA-smoothed predictions/sec — raw single-frame deltas jitter wildly
  // (one frame's worth of predictions over 16ms reads as 60+ /s noise).
  // alpha=0.15 settles in ~10 frames (~170ms) while filtering high-freq jitter.
  let _smoothedPredsPerSec = 0;
  // Throttle HUD text rewrites to ~5Hz so values stay legible.
  let _lastHudRenderAt = 0;
  const HUD_RENDER_INTERVAL_MS = 200;
  // Emulator pause state (reflected on the Pause button label).
  let _emuPaused = false;

  // Funnel state — counts every rollback ON/OFF transition (manual + auto).
  // Once the user has seen the contrast a few times, the play CTA promotes
  // itself to a "convinced?" prompt and pulses to draw attention.
  const CONVINCE_THRESHOLD = 3;
  let _rollbackChangeCount = 0;
  let _convinceShown = false;

  // Auto-compare lifecycle is tied to the engine's precise in-match scene
  // (scene=22, gameStatus=1 in SSB64/Smash Remix — the actual vs battle).
  // NetplayRollback.isInMatch() reads RDRAM directly to gate on that exact
  // condition; we don't use isInGameplay() because in SSB64 it flips true
  // at the title screen.
  // - false → true (entering a match): auto-start auto-compare so the user
  //   gets the contrast hands-free, but only if they haven't manually
  //   touched the controls in the current match (respect their choice).
  // - true → false (leaving the match / back to menu): stop auto-compare and
  //   reset rollback to ON so the next match starts clean.
  // _wasInMatch tracks the inclusive predicate (in-match including in-game
  // pause/unpause): true throughout a battle session even when P1 has the
  // pause menu open. The strict isInMatch (status=1 only) is reserved for
  // fake-peer's random-input gate — see _lastFakePeerMatchActive below.
  let _wasInMatch = false;
  // Strict-mode edge tracker for fake-peer: status=1 only. During in-game
  // pause (status=2) the SSB64 pause menu accepts any controller's buttons,
  // so P2 random presses navigate the menu and immediately unpause. We flip
  // fake-peer's match-active to false the moment P1 pauses so its next
  // injected input is a clean zero, and back to true on unpause.
  let _lastFakePeerMatchActive = false;
  let _userInteractedThisMatch = false;
  const _markUserInteracted = () => {
    _userInteractedThisMatch = true;
  };

  const $ = (id) => document.getElementById(id);
  const _noop = () => {};
  const _socket = {
    id: DEMO_SOCKET_ID,
    connected: true,
    on: _noop,
    off: _noop,
    emit: _noop,
  };

  const _setStatus = (message) => {
    const status = $('demo-status');
    if (status) status.textContent = message;
    const loadingText = $('game-loading-text');
    if (loadingText && message) loadingText.textContent = message;
  };

  const _showLoading = (show) => {
    $('game-loading')?.classList.toggle('hidden', !show);
  };

  const _formatNumber = (value, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : '--');

  const _readFile = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('ROM read failed'));
      reader.readAsArrayBuffer(file);
    });

  // Slider represents RTT (round-trip time, what real ping shows). The
  // synthetic peer's per-packet delivery delay is rtt/2 (one-way).
  // DEFAULT_MATCH_RTT_MS = 100 ms is roughly cross-country LAN-ish.
  // RTT_SLIDER_MAX = 110 ms is the upper bound where the engine's
  // visible-rollback-depth cap (KN_MAX_VISIBLE_ROLLBACK_DEPTH=7 in
  // build/kn_rollback/kn_rollback.c) still fits spike-driven rollbacks
  // — depth ≈ (latency + spike) / 16.67. With spike=60 ms, depth lands
  // at ~5-7 frames across 0-110 ms RTT. Past 110 ms, depth crosses 7
  // and the engine starts silently dropping mispredictions via
  // DEEP-MISPREDICT-SKIP, which would visually present as "the
  // rollback counter stops ticking at high RTT" — confusing for a
  // demo. 110 ms is also realistically the upper bound at which
  // shipping fighters consider a connection viable for tournament
  // play (Skullgirls / MK11 max-prediction is also 7 frames),
  // making this a truthful framing rather than an artificial limit.
  const DEFAULT_MATCH_RTT_MS = 100;
  const RTT_SLIDER_MAX = 110;
  // Animation handle for the slider's 0 → target transition.
  let _lagAnimRaf = 0;

  const _readRtt = () => {
    const rtt = Number($('lag')?.value ?? 0);
    return Number.isFinite(rtt) ? Math.max(0, Math.min(RTT_SLIDER_MAX, rtt)) : 0;
  };

  const _networkFromControls = () => {
    // Slider value is RTT (ms) and acts as a single "how rough is your
    // network" dial — every knob below scales with it so cranking the
    // slider drives more rollbacks, not just more latency. Latency is
    // the one-way travel cost (rtt/2) added once per packet by
    // fake-peer. The remaining knobs each provide an independent path
    // for inputs to miss the C engine's prediction window:
    //   - jitter: ramps from 10 % of RTT at the low end to ~15 % near
    //     the slider max. Real WAN is in this range; under-modeling it
    //     (the old 5 %) made even 150 ms RTT look smoother than reality.
    //   - lossProb: superlinear (rtt/150)^1.5 ramp, capped at 2 %.
    //     Forces the redundant-frames recovery path; when redundancy
    //     fails to bridge a gap the engine has to predict longer and
    //     occasionally rolls back deeper.
    //   - reorderProb: same ramp shape as loss, exercises the C
    //     engine's out-of-order input handling.
    // mispredictProb stays 0 — fake-peer's pre-match path uses it to
    // inject random divergence outside a match, which would derail the
    // baked menu autopilot before the user reaches gameplay.
    const rtt = _readRtt();
    const ramp = rtt > 0 ? Math.pow(rtt / RTT_SLIDER_MAX, 1.5) : 0;
    return {
      latencyMs: rtt / 2,
      jitterMs: rtt * (0.1 + rtt * 0.0003),
      lossProb: Math.min(0.02, ramp * 0.02),
      reorderProb: Math.min(0.02, ramp * 0.02),
      mispredictProb: 0,
    };
  };

  // Smoothly animate the slider value from its current position to `target`
  // over `durationMs`, easing out, applying _applyNetwork() each frame so
  // the synthetic peer's latency tracks the visible slider position.
  const _animateLagTo = (target, durationMs = 800) => {
    const slider = $('lag');
    if (!slider) return;
    if (_lagAnimRaf) {
      cancelAnimationFrame(_lagAnimRaf);
      _lagAnimRaf = 0;
    }
    const start = Number(slider.value) || 0;
    const delta = target - start;
    if (Math.abs(delta) < 1) {
      slider.value = String(target);
      _applyNetwork();
      return;
    }
    const t0 = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - t0) / durationMs);
      // Cubic ease-out: 1 - (1 - t)^3 — fast start, soft landing.
      const eased = 1 - Math.pow(1 - t, 3);
      slider.value = String(Math.round(start + delta * eased));
      _applyNetwork();
      if (t < 1) {
        _lagAnimRaf = _nativeRAF(step);
      } else {
        _lagAnimRaf = 0;
      }
    };
    _lagAnimRaf = _nativeRAF(step);
  };

  const _updateSliderLabels = () => {
    const rtt = _readRtt();
    const label = $('lag-value');
    if (label) label.textContent = `${rtt.toFixed(0)} ms RTT`;
  };

  const _applyNetwork = () => {
    _updateSliderLabels();
    window.KNFakePeer?.setNetwork?.(_networkFromControls());
  };

  const _updateRollbackToggle = () => {
    const toggle = $('rollback-toggle');
    if (!toggle) return;
    toggle.textContent = `Rollback: ${_rollbackEnabled ? 'ON' : 'OFF'}`;
    toggle.setAttribute('aria-pressed', _rollbackEnabled ? 'true' : 'false');
    toggle.classList.toggle('is-off', !_rollbackEnabled);
  };

  const _setRollbackEnabled = (enabled) => {
    const next = !!enabled;
    if (_rollbackEnabled !== next) {
      _rollbackChangeCount += 1;
      if (_rollbackChangeCount >= CONVINCE_THRESHOLD && !_convinceShown) {
        _convinceShown = true;
        _showConvincePrompt();
      }
    }
    _rollbackEnabled = next;
    // While the autopilot is replaying baked menu inputs, FORCE lockstep
    // (predictions paused) regardless of the toggle's visible state.
    // Reason: at non-zero delay the engine's prediction model can roll
    // back through the autopilot's brief button-press windows (5 frames
    // for an A-press to advance a menu) and miss the press, leaving the
    // autopilot in a half-set-up state. With predictions paused, both
    // peers' inputs apply deterministically at delay-frame applied
    // frames — same outcome every run. The user's choice is restored
    // by _finishAutopilot the moment isInMatch flips true.
    const enginePredictionsOn = _autopilotActive ? false : _rollbackEnabled;
    window.NetplayRollback?.setPredictionsPaused?.(!enginePredictionsOn);
    _updateRollbackToggle();
  };

  const _zeroLocalInput = () => ({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });

  // Lockstep input buffering for the demo's mode toggle. When the user
  // selects "Lockstep" (rollback OFF), return the input from
  // DELAY_FRAMES ago so the on-screen result feels the way real lockstep
  // netcode (Kaillera, classic fightsticks) actually does — every keypress
  // shows up DELAY_FRAMES later because lockstep can't apply local input
  // until the peer has acknowledged the same frame. Without this, the
  // engine's `_predictionsPaused` only pauses prediction generation; it
  // doesn't add input lag, so rollback ON and rollback OFF both feel
  // identical when the network is RTT-tuned to never stall.
  //
  // The buffer holds the last LOCKSTEP_BUF_MAX inputs keyed by engine
  // frame. Always recording (regardless of toggle state) means switching
  // modes mid-match doesn't lose history. In rollback mode the buffer
  // is filled but never queried — pure record-only overhead, ~negligible.
  const _lockstepInputBuf = [];
  const LOCKSTEP_BUF_MAX = 32;
  const _maybeLockstepDelay = (input) => {
    const counters = window.NetplayRollback?.getHudCounters?.();
    const frame = counters?.currentFrame ?? -1;
    const delay = counters?.delay ?? 0;
    if (frame < 0 || delay <= 0) return input;
    _lockstepInputBuf.push({ frame, input: { ...input } });
    while (_lockstepInputBuf.length > LOCKSTEP_BUF_MAX) _lockstepInputBuf.shift();
    if (_rollbackEnabled) return input;
    const targetFrame = frame - delay;
    for (let i = _lockstepInputBuf.length - 1; i >= 0; i--) {
      if (_lockstepInputBuf[i].frame <= targetFrame) return _lockstepInputBuf[i].input;
    }
    return _zeroLocalInput();
  };

  // Wrap KNShared.readLocalInput once. In record mode, capture inputs to a
  // buffer indexed by current engine frame. Otherwise, replay scripted inputs
  // from MENU_AUTOPILOT_P1_TRANSITIONS via _p1InputAtFrame (or pass real
  // input through if the autopilot has no entry for this frame yet).
  const _installInputHook = () => {
    if (_wrappedReadLocalInput || !window.KNShared?.readLocalInput) return;
    const original = window.KNShared.readLocalInput.bind(window.KNShared);
    window.KNShared.readLocalInput = (playerSlot, keyMap, heldKeys) => {
      const realInput = original(playerSlot, keyMap, heldKeys);
      if (_recordMode === 'p1') {
        if (_recordingActive && !_recordingDone) {
          const frame = window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? -1;
          _recordedInputs.push({
            f: frame,
            b: realInput.buttons | 0,
            lx: realInput.lx | 0,
            ly: realInput.ly | 0,
            cx: realInput.cx | 0,
            cy: realInput.cy | 0,
          });
        }
        return realInput;
      }
      if (_recordMode === 'p2') {
        // P2 record: P1 follows the baked autopilot, user's keyboard becomes
        // P2's input. Capture for the recording AND publish on a global slot
        // for fake-peer to read this frame.
        const currentFrame = window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? -1;
        if (_recordingActive && !_recordingDone) {
          _recordedInputs.push({
            f: currentFrame,
            b: realInput.buttons | 0,
            lx: realInput.lx | 0,
            ly: realInput.ly | 0,
            cx: realInput.cx | 0,
            cy: realInput.cy | 0,
          });
        }
        // Publish live input so fake-peer's _scheduleFrame consumes it as
        // P2's input this frame instead of zero / random.
        window.__knDemoP2LiveInput = {
          buttons: realInput.buttons | 0,
          lx: realInput.lx | 0,
          ly: realInput.ly | 0,
          cx: realInput.cx | 0,
          cy: realInput.cy | 0,
        };
        // Return autopilot's scripted P1 input for slot 0.
        const scripted = _p1InputAtFrame(currentFrame);
        if (scripted) return scripted;
        return _zeroLocalInput();
      }
      // Replay path: while autopilot is active, ignore real input and feed
      // the scripted sequence. Lookup is keyed on the engine's currentFrame
      // so the scripted input applies at the same frame it was captured —
      // sequential indexing breaks if the engine stalls or rolls back.
      if (_autopilotActive) {
        const currentFrame = window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? 0;
        const scripted = _p1InputAtFrame(currentFrame);
        if (scripted) return scripted;
        return _zeroLocalInput();
      }
      if (_randomP1InMatch && window.NetplayRollback?.isInMatch?.()) {
        const currentFrame = window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? 0;
        return _maybeLockstepDelay(_randomP1InputForFrame(currentFrame));
      }
      return _maybeLockstepDelay(realInput);
    };
    _wrappedReadLocalInput = true;
    if (_recordMode) {
      _recordingActive = true;
      const label = _recordMode === 'p2' ? 'P2' : 'P1';
      _setStatus(`REC mode (${label}) — play through to a match. Recording stops automatically.`);
    } else if (MENU_AUTOPILOT_P1_TRANSITIONS.length > 0) {
      _autopilotActive = true;
      // Freeze DELAY_FRAMES while the autopilot is running. Scripted button
      // presses use ~5-frame windows; if delay shifts mid-press the engine
      // reads the input ring at a different applied frame and lands past
      // the release — press dropped. _finishAutopilot re-enables.
      window.NetplayRollback?.setDelayRetuneEnabled?.(false);
      // NOTE: we deliberately do NOT pause predictions here. The JS-side
      // lockstep stall at netplay-rollback.js:12018 doesn't guard for
      // negative applyFrame, so at frame 0 with delay=2 it tries to read
      // _remoteInputs[slot][-2] (undefined) and stalls forever — engine
      // never advances. With predictions LIVE the engine runs free; the
      // autopilot's deterministic outcome is now provided by the matching
      // delay (no pre-seed → handshake picks delay=2 = recording delay).
      _setStatus('Setting up your match…');
      // Indicator deferred to the gesture click — the user hasn't even seen
      // the emulator yet, so showing "your inputs disabled" before they tap
      // is confusing. _showInputIndicator('disabled') fires from the
      // gesture-button handler in _bindDom.
    }
  };

  const _finishRecording = () => {
    if (!_recordMode || _recordingDone) return;
    _recordingDone = true;
    _recordingActive = false;
    const json = JSON.stringify(_recordedInputs);
    // Stash on window for devtools grab (`copy(__demoRecording)`).
    window.__demoRecording = json;
    // Persist to localStorage as backup.
    try {
      localStorage.setItem('kn-demo-recording', json);
    } catch (_) {}
    /* eslint-disable no-console */
    console.log(
      '%c═══ AUTOPILOT RECORDING COMPLETE ═══\n' +
        `Captured ${_recordedInputs.length} input frames. Auto-downloading file…\n` +
        'Also available via window.__demoRecording or localStorage["kn-demo-recording"].',
      'color:#6af;font-weight:bold;font-size:14px',
    );
    /* eslint-enable no-console */
    // Auto-download as a file so the user doesn't have to dig through console.
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = _recordMode === 'p2' ? 'kn-demo-autopilot-p2.json' : 'kn-demo-autopilot.json';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 1000);
    } catch (_) {}
    _setStatus(`Recording done — ${_recordedInputs.length} frames captured. File downloaded.`);
    _showRecIndicator(false);
  };

  const _finishAutopilot = () => {
    if (!_autopilotActive) return;
    _autopilotActive = false;
    // Re-enable RTT-tuned delay updates first so the predictions-toggle
    // re-tune below picks up the current slider value (the slider can
    // move via _animateLagTo right around this transition).
    window.NetplayRollback?.setDelayRetuneEnabled?.(true);
    // Now that we're past the autopilot's menu navigation, restore the
    // engine's prediction state to the user's actual rollback choice.
    // _setRollbackEnabled gates predictions on `_autopilotActive` ?
    // false : _rollbackEnabled, so this re-applies cleanly.
    window.NetplayRollback?.setPredictionsPaused?.(!_rollbackEnabled);
    _showInputIndicator('enabled');
  };

  const _showConvincePrompt = () => {
    const cta = $('play-cta');
    if (!cta) return;
    cta.classList.add('is-convinced');
    const headline = $('play-cta-headline');
    if (headline) headline.textContent = 'Are you convinced?';
    const sub = $('play-cta-sub');
    if (sub) sub.textContent = 'Bring a friend. No installs.';
    const btn = $('play-cta-button');
    if (btn) btn.textContent = 'Play now →';
  };

  const ensureEmulatorBooted = ({ forceStartOnLoad = true } = {}) => {
    if (window.__test_skipBoot) return;
    if (window.EJS_emulator || _emulatorBootInFlight || !_romBlobUrl) return;

    _installEjsGlobals();
    window.EJS_startOnLoaded = !!forceStartOnLoad;
    window.EJS_gameUrl = _romBlobUrl;
    window.EJS_gameID = 'kaillera-next-demo';
    window.KNEmulatorResumeContext = null;
    window.KNShared?.resetBootState?.();

    const injectLoader = () => {
      if (_loaderInjected) return;
      _loaderInjected = true;
      _emulatorBootInFlight = true;
      let bootDoneTimer = null;
      const markBootDone = () => {
        _emulatorBootInFlight = false;
        if (bootDoneTimer) {
          clearTimeout(bootDoneTimer);
          bootDoneTimer = null;
        }
        window.removeEventListener('kn-ejs-loader-complete', markBootDone);
      };
      window.addEventListener('kn-ejs-loader-complete', markBootDone);
      bootDoneTimer = setTimeout(markBootDone, 30000);

      const script = document.createElement('script');
      script.src = '/static/ejs-loader.js';
      script.onload = () => {
        _setStatus('Emulator loader ready');
      };
      script.onerror = () => {
        markBootDone();
        _setStatus('Failed to load emulator');
      };
      document.body.appendChild(script);
    };

    if (window._knCoreReady) {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Core load timeout')), 15000));
      Promise.race([window._knCoreReady, timeout]).then(injectLoader, injectLoader);
    } else {
      injectLoader();
    }
  };

  window.KNStartEmulatorBoot = ensureEmulatorBooted;

  // Enabled-set for the emu-controls row. Reset tracks engine-running
  // (it's the recovery path — stays accessible even mid-autopilot so
  // the user can bail out if setup goes sideways). Pause and Stop are
  // gated additionally on inMatch — pressing Pause during the
  // autopilot's menu navigation lands the game in a half-set-up state
  // that doesn't recover cleanly. _refreshEmuButtonsAvailability is
  // called from the rAF in _updateHud as inMatch flips, plus once at
  // engine boot to set the initial state.
  let _engineRunning = false;
  const _refreshEmuButtonsAvailability = () => {
    const pause = $('emu-pause');
    const stop = $('emu-stop');
    const reset = $('emu-reset');
    // Use the pause-inclusive predicate so the demo's UI Pause/Stop stay
    // enabled when P1 has the SSB64 in-game pause menu open. Strict
    // isInMatch flips false on status=2 and would disable both buttons
    // mid-pause, leaving the user with no way to stop the demo without
    // first unpausing the game.
    const inMatch = !!window.NetplayRollback?.isInMatchOrPaused?.();
    const interactiveOk = _engineRunning && inMatch;
    if (pause) pause.disabled = !interactiveOk;
    if (stop) stop.disabled = !interactiveOk;
    if (reset) reset.disabled = !_engineRunning;
  };
  const _setEmuButtonsEnabled = (enabled) => {
    _engineRunning = !!enabled;
    _refreshEmuButtonsAvailability();
  };

  // Hard reset: reloads the page so the demo restarts from the autopilot
  // boot path. Cleaner than rewinding engine state mid-session (state
  // ring, Emscripten thread, audio worklet all need fresh init anyway).
  // The ROM stays cached in IDB so the boot path auto-restores it
  // without re-prompting the user for a file drop. Persists RTT
  // preference too so a reset doesn't lose slider tuning.
  const _resetDemo = () => {
    try {
      if (_savedRttPreference != null) {
        localStorage.setItem('kn-demo-rtt', String(_savedRttPreference));
      }
    } catch (_) {}
    _setStatus('Resetting demo…');
    location.reload();
  };

  const _toggleEmuPause = () => {
    // Pause the rollback engine's tick scheduler — that's what actually
    // advances the emulator. The engine drives Emscripten's main loop manually
    // via an intercepted rAF, so Module.pauseMainLoop() is a no-op here.
    if (!window.NetplayRollback?.pauseTick) return;
    if (_emuPaused) {
      window.NetplayRollback.resumeTick();
      _resumeAutoCompare();
      _emuPaused = false;
      const btn = $('emu-pause');
      if (btn) {
        btn.textContent = '⏸ Pause';
        btn.classList.remove('is-paused');
      }
      _setStatus('Resumed');
    } else {
      window.NetplayRollback.pauseTick();
      // Freeze auto-compare so the rollback toggle doesn't flip while the
      // emulator is frozen — the user wouldn't see the contrast anyway.
      _pauseAutoCompare();
      _emuPaused = true;
      const btn = $('emu-pause');
      if (btn) {
        btn.textContent = '▶ Resume';
        btn.classList.add('is-paused');
      }
      _setStatus('Paused');
    }
  };

  // Stop = full page reload. EmulatorJS, the rollback engine, the WASM core,
  // EJS-bound window/document handlers, captured AudioContexts, the
  // intercepted rAF, and the synthetic-peer scheduler each leave behind state
  // that's brittle to unwind cleanly between sessions. A reload is the only
  // truly reliable reset. We persist the lag slider value first so the user
  // doesn't lose their setting across the reload.
  const _stopEmu = () => {
    if (!window.EJS_emulator && !_loaderInjected) return;
    try {
      // Persist only the user's manually-chosen preference, not the
      // currently-animated slider position (which may be mid-animation).
      if (_savedRttPreference != null) {
        localStorage.setItem('kn-demo-rtt', String(_savedRttPreference));
      }
    } catch (_) {}
    _setStatus('Stopping…');
    // Stop the engine + audio synchronously so the user doesn't hear lingering
    // sound during the reload's tab-flicker window.
    try {
      window.NetplayRollback?.pauseTick?.();
    } catch (_) {}
    try {
      window.EJS_emulator?.gameManager?.Module?.pauseMainLoop?.();
    } catch (_) {}
    try {
      window.EJS_emulator?.gameManager?.Module?.SDL2?.audioContext?.close();
    } catch (_) {}
    // Stop is the user's "fully quit and forget the ROM" path — clear
    // the IDB cache so the next visit hits the drop-ROM screen rather
    // than auto-restoring. Reset preserves the cache (its whole point).
    _idbRomClear().finally(() => location.reload());
  };

  // User's preferred RTT value (round-trip ms), if they manually moved
  // the slider in a previous session. The slider itself starts at 0; this
  // number is only used as the animation target when a match begins.
  // null means "use DEFAULT_MATCH_RTT_MS" (user hasn't expressed a
  // preference). Migrates `kn-demo-lag` (the old one-way-ms key) to
  // `kn-demo-rtt` by doubling — preserves prior preference shape under
  // the new RTT semantics.
  let _savedRttPreference = null;
  const _restoreSavedLag = () => {
    try {
      const savedRtt = localStorage.getItem('kn-demo-rtt');
      if (savedRtt != null) {
        const n = Number(savedRtt);
        if (Number.isFinite(n) && n >= 0 && n <= RTT_SLIDER_MAX) _savedRttPreference = n;
      } else {
        // One-time migration from the old one-way key
        const legacy = localStorage.getItem('kn-demo-lag');
        if (legacy != null) {
          const n = Number(legacy);
          if (Number.isFinite(n) && n >= 0) {
            _savedRttPreference = Math.min(RTT_SLIDER_MAX, n * 2);
            try {
              localStorage.setItem('kn-demo-rtt', String(_savedRttPreference));
              localStorage.removeItem('kn-demo-lag');
            } catch (_) {}
          }
        }
      }
    } catch (_) {}
  };

  const _startEngine = () => {
    if (_engineStarted) return;
    if (!window.NetplayRollback) {
      _setStatus('Rollback engine missing');
      return;
    }

    if (window.KNState) {
      window.KNState.room = 'DEMO';
      window.KNState.matchId = null;
      window.KNState.uploadToken = null;
      window.KNState.slot = 0;
      window.KNState.romHash = null;
    }

    window.NetplayRollback.init({
      socket: _socket,
      playerSlot: 0,
      isSpectator: false,
      syntheticSlots: [1],
      resyncEnabled: false,
      skipInitialStateSync: true,
      // Pass real ROM hash so _isSmashRemix() can identify Smash Remix ROMs
      // and use the right RDRAM addresses for game_status. Without this, the
      // engine treats every ROM as SSB64 and reads game_status from 0xa4f08
      // instead of Remix's 0xa4d18 — wrong byte, isInMatch never returns true.
      romHash: _romHash,
      disableStandardCheats: true,
      skipSmashTitleWait: true,
      lateJoin: false,
      isMobile: false,
      initialPlayers: {
        players: {
          [DEMO_SOCKET_ID]: {
            socketId: DEMO_SOCKET_ID,
            slot: 0,
            playerName: 'You',
          },
        },
        spectators: {},
      },
      onStatus: (message) => {
        _setStatus(message);
      },
      onToast: _setStatus,
      onSyncStatus: _setStatus,
      onReconnecting: _noop,
      onPlayersChanged: _noop,
    });
    _engineStarted = true;

    // Demo mode disables the engine's pacing-throttle. Without this, the
    // engine throttles itself to match the (artificially slow) synthetic peer
    // and the result is identical to lockstep — same pace, no visible
    // predictions or rollbacks. With demo mode on, the engine runs full speed,
    // predicts when slot 1's input is missing, and rolls back when the actual
    // input differs from the prediction. This is the core of the demo.
    window.NetplayRollback?.setDemoMode?.(true);

    _installInputHook();

    // Start fake peer immediately. The engine needs slot 1 inputs continuously
    // from frame 0: during the lockstep menu phase, and after C rollback
    // engages. Waiting for isCRollback() deadlocks games that defer rollback
    // until gameplay because the menu cannot advance without slot 1 input.
    window.KNFakePeer?.start?.({
      slot: 1,
      getCurrentFrame: () => window.NetplayRollback?.getHudCounters?.().currentFrame ?? 0,
      // P2 menu autopilot: feed P2's recorded CSS-selection inputs during
      // pre-match. Suppress in ?record=p2 mode — there the user IS P2, so
      // fake-peer should consume the live keyboard input via
      // window.__knDemoP2LiveInput instead, not the recording.
      getMirroredInput: _recordMode === 'p2' ? null : (frame) => _p2InputAtFrame(frame),
    });
    window.KNFakePeer?.setNetwork?.(_networkFromControls());
    // The handshake's delay negotiation runs once at PHASE_LOCKSTEP_READY
    // and the C engine's kn_rollback_init bakes that delay value in. The
    // baked menu autopilot was recorded with DEFAULT_DELAY_FRAMES=2; if
    // the handshake settles on anything else (e.g. delay=3 at higher RTT
    // pre-seed), the P2 mirrored inputs end up applied 1 frame later in
    // game state than they were recorded — stage-select cursor lands on
    // the wrong stage, character-select misses by a frame, etc.
    //
    // We now rely on live delay re-tune (setDelayRetuneEnabled(true) in
    // _finishAutopilot) plus the post-match _animateLagTo slider sweep
    // to drive DELAY_FRAMES up to the user's RTT preference once the
    // autopilot is done. So we don't pre-seed match-target RTT here —
    // handshake fires at zero/menu RTT, picks delay=2 (matching the
    // recording), autopilot runs deterministically, then the slider
    // animation re-tunes delay for actual play.
    _setRollbackEnabled(_rollbackEnabled);

    // Engine + peer are running, so Pause/Stop are now meaningful.
    _setEmuButtonsEnabled(true);

    // Start GamepadManager so a connected controller flows through the
    // same readLocalInput pipeline the lobby uses (shared.js:486-495
    // pulls from GamepadManager.readGamepad). Without this call P1 input
    // is keyboard-only even when a gamepad is plugged in.
    _ensureGamepadManager();

    _setStatus('Tap to start emulator');
    _pollRollbackReady();
  };

  // Idempotent — first call starts polling, subsequent calls just refresh
  // the slot binding (mirrors play.js's startGamepadManager pattern).
  let _gamepadManagerStarted = false;
  const _ensureGamepadManager = () => {
    if (!window.GamepadManager) return;
    window.GamepadManager.start({
      playerSlot: 0,
      onUpdate: _updateGamepadStatus,
    });
    _gamepadManagerStarted = true;
    _updateGamepadStatus();
  };

  const _updateGamepadStatus = () => {
    const el = $('gamepad-status');
    if (!el) return;
    const detected = window.GamepadManager?.getDetected?.() || [];
    if (detected.length === 0) {
      el.textContent = 'No gamepad detected — keyboard works (open Controls for the keymap).';
      el.classList.remove('is-detected');
      return;
    }
    const name = detected[0].id?.replace(/\s*\(Vendor:.*$/, '').trim() || 'Gamepad';
    const more = detected.length > 1 ? ` (+${detected.length - 1} more)` : '';
    el.textContent = `Gamepad detected: ${name}${more}. Open Controls to remap.`;
    el.classList.add('is-detected');
  };

  const _pollRollbackReady = () => {
    if (!_engineStarted) return;
    if (window.NetplayRollback?.isCRollback?.()) {
      _setStatus('Rollback engine engaged');
      // Re-apply network now that the C engine is active. mispredictProb is
      // gated on isCRollback (see _networkFromControls), so until this point
      // the synthetic peer was sending pure ZERO_INPUT regardless of lag.
      _applyNetwork();
      return;
    }
    setTimeout(_pollRollbackReady, 250);
  };

  const _loadRomFile = async (file) => {
    if (!file) return;
    if (!/\.(z64|n64|v64)$/i.test(file.name)) {
      _setStatus('Use a raw .z64, .n64, or .v64 ROM');
      return;
    }
    try {
      _showLoading(true);
      _setStatus(`Reading ${file.name}`);
      const bytes = await _readFile(file);
      _romHash = await _hashRom(bytes);
      if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
      _romBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      window.EJS_gameUrl = _romBlobUrl;
      window.EJS_gameName = file.name;
      window.EJS_cheats = [];
      $('game')?.classList.add('kn-playing');
      $('rom-drop')?.classList.add('hidden');
      _showLoading(false);
      _setStatus('ROM loaded');
      // Cache the bytes so Reset (and any future page reload) can
      // restore the ROM without prompting the user to drop it again.
      // Best-effort; failure to cache doesn't block the load.
      _idbRomSave(new Uint8Array(bytes), file.name).catch(() => {});
      _startEngine();
    } catch (err) {
      _showLoading(false);
      _setStatus(err?.message || 'ROM load failed');
    }
  };

  // Kaillera-style frame-delay tier. Match the labels real netplay clients
  // (Kaillera, Fightcade, Slippi) put on their netcode quality readouts.
  // Boundaries chosen so 60 Hz fighters cluster like this:
  //   1-2 frames = LAN / same-city, you can't feel it
  //   3 frames   = good regional internet, feels fine
  //   4 frames   = playable but you can feel it
  //   5+ frames  = tournament-illegal territory in classic netcode
  const _connectionTier = (delayFrames) => {
    if (delayFrames <= 0) return { label: 'No connection', tone: 'idle' };
    if (delayFrames <= 2) return { label: 'Excellent', tone: 'great' };
    if (delayFrames === 3) return { label: 'Good', tone: 'great' };
    if (delayFrames === 4) return { label: 'Fair', tone: 'okay' };
    if (delayFrames === 5) return { label: 'Poor', tone: 'bad' };
    if (delayFrames === 6) return { label: 'Bad', tone: 'bad' };
    return { label: 'Terrible', tone: 'bad' };
  };

  const _inputFeel = (isCRollback, isInMatch, delayFrames) => {
    const delay = Number.isFinite(delayFrames) ? Math.max(0, delayFrames | 0) : 0;
    const delayMs = delay * 16.67;
    // Pre-match: rollback engine is loaded but no netplay activity is
    // happening (no peer inputs contesting the local engine, so no
    // predictions, no rollbacks, and no input lag from any delay budget
    // — even lockstep mode has nothing to wait for). Tell the user
    // that, instead of pretending the network conditions are felt.
    if (!isInMatch) {
      return {
        text: 'WAITING',
        sub: 'Start a match to see rollback in action. Nothing is being predicted in menus.',
        state: 'idle',
        showTier: false,
        effectiveDelay: 0,
        networkDelay: delay,
      };
    }
    if (delay <= 0) {
      return {
        text: 'NO LAG',
        sub: 'Crank the RTT slider — both modes feel the same at 0 ms.',
        state: 'idle',
        showTier: false,
        effectiveDelay: 0,
        networkDelay: 0,
      };
    }
    if (_rollbackEnabled) {
      // Rollback's promise is INPUT-feel, not full visual smoothness.
      // At high RTT predictions miss often and the engine rewinds
      // visibly — local input still applies at the current frame, but
      // the screen judders through the corrections. Saying just
      // "INSTANT" oversells; "INSTANT INPUT" is the honest version.
      return {
        text: 'INSTANT INPUT',
        sub: `The connection has a ${delay}-frame delay (${delayMs.toFixed(0)} ms). Rollback hides it from your inputs — every press lands at the current frame. Visual smoothness still depends on RTT: more rollbacks per second means more visible rewinds.`,
        state: 'instant',
        showTier: true,
        effectiveDelay: 0,
        networkDelay: delay,
      };
    }
    return {
      text: `${delayMs.toFixed(0)} ms LATE`,
      sub: `Lockstep makes you feel the full ${delay}-frame delay because it can't predict the peer's input. Visuals stay smooth (no rewinds), but every press is delayed.`,
      state: 'late',
      showTier: true,
      effectiveDelay: delay,
      networkDelay: delay,
    };
  };

  const _renderHudText = (counters, totalPreds) => {
    const rtt = _readRtt();
    const delay = counters?.delay ?? 0;
    // Pause-inclusive: keep the result panel showing the current mode's
    // feel (INSTANT INPUT / X ms LATE) while the player has the SSB64
    // pause menu open, instead of flipping to WAITING the moment status=2.
    const isInMatch = !!window.NetplayRollback?.isInMatchOrPaused?.();
    const feel = _inputFeel(counters?.isCRollback, isInMatch, delay);
    const feelEl = $('hud-feel');
    if (feelEl) {
      feelEl.textContent = feel.text;
      feelEl.classList.toggle('is-instant', feel.state === 'instant');
      feelEl.classList.toggle('is-late', feel.state === 'late');
    }

    const subEl = $('hud-feel-sub');
    if (subEl) subEl.textContent = feel.sub;

    // Connection-quality pill — Kaillera-style tier based on the EFFECTIVE
    // (felt) frame delay, which differs by mode:
    //   Rollback ON  → effective delay = 0 (rollback hides the network)
    //   Rollback OFF → effective delay = full network delay
    // Toggling the rollback button flips the tier, making the contrast
    // visible at a glance. When not in a match, the pill explicitly says
    // so instead of misleading "Excellent" or "Terrible" labels for a
    // network that isn't being exercised yet.
    const delayEl = $('hud-frame-delay');
    if (delayEl) {
      if (!feel.showTier) {
        delayEl.innerHTML = isInMatch
          ? '<strong>No active rollback</strong> &middot; Crank the RTT slider'
          : '<strong>Engine waiting</strong> &middot; Start a match to test rollback';
        delayEl.classList.remove('is-great', 'is-okay', 'is-bad');
      } else {
        const tier = _connectionTier(feel.effectiveDelay);
        const label = _rollbackEnabled
          ? `Rollback feels <strong>${tier.label}</strong> &middot; Effective delay: <strong>${feel.effectiveDelay} frame${feel.effectiveDelay === 1 ? '' : 's'}</strong>`
          : `Lockstep feels <strong>${tier.label}</strong> &middot; Effective delay: <strong>${feel.effectiveDelay} frame${feel.effectiveDelay === 1 ? '' : 's'}</strong>`;
        delayEl.innerHTML = label;
        delayEl.classList.toggle('is-great', tier.tone === 'great');
        delayEl.classList.toggle('is-okay', tier.tone === 'okay');
        delayEl.classList.toggle('is-bad', tier.tone === 'bad');
      }
    }

    const details = $('hud-details');
    if (!details) return;
    const mode = _rollbackEnabled ? 'Rollback' : 'Lockstep';
    const frame = counters?.currentFrame ?? 0;
    // C engine engagement state. For Smash Remix this is FALSE in the menu
    // and only flips TRUE after the user starts a match.
    const cEngine = counters?.isCRollback ? 'Active' : 'Waiting (start a match)';
    // Rollback activity — what the user actually wants to see. Total
    // count + recent rate (smoothed by the engine's 5 s window). Drops
    // the prediction-vs-correct ratio + scene/status diagnostic noise
    // from the prior version.
    const rollbacks = counters?.rollbackEventsTotal ?? 0;
    const rollbacksPerSec = counters?.rollbackEventsPerSec ?? 0;
    const rollbackText =
      rollbacksPerSec > 0
        ? `${rollbacks} (${rollbacksPerSec.toFixed(1)}/s)`
        : rollbacks > 0
          ? `${rollbacks} (idle)`
          : 'none yet';
    // FPS: rAF cadence over a 1 s window (engine maintains _fpsCurrent
    // internally — exposed via getHudCounters as of 60 Hz tick path).
    // At high RTT rollback bursts can drop the visible framerate even
    // though tick work itself is well under the vsync budget. The
    // framerate readout makes that cost visible — it's the "what
    // rollback can't hide" the headline copy now acknowledges.
    const fps = counters?.fps ?? 0;
    const fpsText = fps > 0 ? `${fps} fps` : '— fps';
    details.textContent =
      `Engine: ${cEngine} · Mode: ${mode} · RTT: ${rtt.toFixed(0)} ms · ` +
      `${fpsText} · Frame: ${frame} · Rollbacks: ${rollbackText}`;
  };

  const _updateHud = () => {
    const counters = window.NetplayRollback?.getHudCounters?.();

    // Sample predictions/sec every frame so the EMA always sees fresh data,
    // but only paint to the DOM at HUD_RENDER_INTERVAL_MS so the eye can
    // actually read the numbers.
    const totalPreds = counters?.totalMispredicts ?? 0;
    const now = performance.now();
    const dt = Math.max(0.001, (now - (_lastPredSampleAt || now)) / 1000);
    const rawPredsPerSec = (totalPreds - (_lastTotalPreds || totalPreds)) / dt;
    _lastTotalPreds = totalPreds;
    _lastPredSampleAt = now;
    const alpha = 0.15;
    _smoothedPredsPerSec = alpha * Math.max(0, rawPredsPerSec) + (1 - alpha) * _smoothedPredsPerSec;

    if (now - _lastHudRenderAt >= HUD_RENDER_INTERVAL_MS) {
      _lastHudRenderAt = now;
      _renderHudText(counters, totalPreds);
    }

    // Two predicates drive different parts of the demo's match transition:
    //
    //   isInMatch()        — strict (scene=22 + status=1). Flips false the
    //                        moment P1 presses START and the SSB64 pause
    //                        menu opens. Used to gate fake-peer's random
    //                        input injection: during pause, P2's random
    //                        button presses navigate the pause menu and
    //                        instantly select Continue (or Quit), undoing
    //                        P1's pause from the player's POV.
    //
    //   isInMatchOrPaused()— inclusive (scene=22 + status in {1,2,3} =
    //                        Go/Pause/Unpause). True throughout the battle
    //                        session, including the pause-menu interlude.
    //                        Used to gate the demo's match-start /
    //                        match-end UX (RTT slider sweep, "Match ended"
    //                        status, post-match overlay, auto-compare
    //                        start/stop). Without this split, P1 pressing
    //                        START fired the full match-end transition,
    //                        and the unpause fired match-start — UI churned
    //                        every pause cycle.
    const inMatchStrict = !!window.NetplayRollback?.isInMatch?.();
    const inMatch = !!window.NetplayRollback?.isInMatchOrPaused?.();
    // Edge-detect strict transitions for fake-peer independent of the UI
    // edge below — the strict edge fires on every pause/unpause so fake-peer
    // silences immediately, while the UI edge only fires on real match
    // boundaries (battle entry / battle exit).
    if (inMatchStrict !== _lastFakePeerMatchActive) {
      _lastFakePeerMatchActive = inMatchStrict;
      window.KNFakePeer?.setMatchActive?.(inMatchStrict);
    }
    if (inMatch !== _wasInMatch) {
      _wasInMatch = inMatch;
      // Pause/Stop track inMatch; recompute now that it changed.
      _refreshEmuButtonsAvailability();
      if (inMatch) {
        // Stop recording (in record mode) or end autopilot (in replay mode)
        // exactly when the player crosses into the match. Real input takes
        // over from here.
        _finishRecording();
        _finishAutopilot();
        // Clear any post-match indicator the previous round left behind —
        // _finishAutopilot's "enabled" toast only fires on first-time
        // autopilot finish, so subsequent rounds rely on this explicit
        // clear.
        _showInputIndicator(null);
        // Animate the RTT slider from 0 (its menu-time value) up to the
        // user's saved preference (or DEFAULT_MATCH_RTT_MS). The animation
        // calls _applyNetwork() each frame, so the synthetic peer's
        // RTT tracks the visible slider position smoothly.
        const target = _savedRttPreference != null ? _savedRttPreference : DEFAULT_MATCH_RTT_MS;
        _animateLagTo(target, 800);
        // Entering a vs match — re-arm interaction tracking and auto-start
        // auto-compare for this match. Each new match gets its own chance to
        // demo hands-free even if the user took control in a previous one.
        _userInteractedThisMatch = false;
        // ?autoCompare=0 disables auto-compare (for testing pure-rollback freeze
        // profile without the periodic lockstep flips).
        const _autoCompareDisabled = _urlParams.get('autoCompare') === '0';
        _setStatus(
          _autoCompareDisabled
            ? 'Match started — pure rollback (auto-compare disabled)'
            : 'Match started — auto-comparing rollback ON ↔ OFF',
        );
        setTimeout(() => {
          if (_wasInMatch && !_userInteractedThisMatch && !_isAutoCompareRunning() && !_autoCompareDisabled)
            _startAutoCompare();
        }, 600);
      } else {
        // Left the match — stop the demo and put rollback back ON so the
        // next match (or the menus the user is now navigating) start clean.
        _stopAutoCompare();
        if (!_rollbackEnabled) _setRollbackEnabled(true);
        // Animate the slider back down to 0 so menu navigation is responsive
        // and the visible position matches the actual lag.
        _animateLagTo(0, 500);
        _setStatus('Match ended. Hit Reset to restart the demo, or play through the menus.');
        // Show the same disabled-input alert that fires at boot, with a
        // post-match-specific message. The autopilot is one-shot (only
        // navigates from boot to first match), so post-match menus are
        // on the user — but the results screen / fade-back transitions
        // ignore input until they auto-advance, which feels like P1
        // input is broken. Tell the user explicitly what's happening
        // and point at Reset.
        _showInputIndicator('post-match');
      }
    }

    _nativeRAF(_updateHud);
  };

  const _isAutoCompareRunning = () => _autoCompareTimer !== 0;

  const _stopAutoCompare = () => {
    if (!_isAutoCompareRunning()) return;
    clearInterval(_autoCompareTimer);
    _autoCompareTimer = 0;
    _autoComparePausedAt = 0;
    const fill = $('auto-progress');
    if (fill) fill.style.width = '0%';
    const wrapper = $('auto-compare');
    if (wrapper) wrapper.classList.remove('is-running');
    const btn = $('auto-compare-btn');
    if (btn) btn.textContent = '▶ Auto-compare every 6s';
  };

  // Suspend the timer + visually freeze the progress fill, but preserve the
  // cycle phase so resume picks up exactly where it left off (not from the
  // top). _autoComparePausedAt = wall-clock at pause; resume offsets
  // _autoCompareStart by the gap so elapsed is unchanged.
  const _pauseAutoCompare = () => {
    if (!_isAutoCompareRunning() || _autoComparePausedAt) return;
    _autoComparePausedAt = performance.now();
    clearInterval(_autoCompareTimer);
    _autoCompareTimer = 0;
  };

  const _resumeAutoCompare = () => {
    if (!_autoComparePausedAt || _autoCompareTimer) return;
    _autoCompareStart += performance.now() - _autoComparePausedAt;
    _autoComparePausedAt = 0;
    _autoCompareTimer = setInterval(_tickAutoCompare, 100);
  };

  const _tickAutoCompare = () => {
    const elapsed = performance.now() - _autoCompareStart;
    const cycle = Math.floor(elapsed / AUTO_COMPARE_PERIOD_MS);
    const phase = elapsed % AUTO_COMPARE_PERIOD_MS;
    const fill = $('auto-progress');
    if (fill) fill.style.width = `${(phase / AUTO_COMPARE_PERIOD_MS) * 100}%`;
    if (cycle !== _autoCompareCycle) {
      _autoCompareCycle = cycle;
      _setRollbackEnabled(cycle % 2 === 0);
    }
  };

  const _startAutoCompare = () => {
    if (_isAutoCompareRunning()) return;
    _autoCompareStart = performance.now();
    _autoCompareCycle = 0;
    _setRollbackEnabled(true);
    _autoCompareTimer = setInterval(_tickAutoCompare, 100);
    const wrapper = $('auto-compare');
    if (wrapper) wrapper.classList.add('is-running');
    const btn = $('auto-compare-btn');
    if (btn) btn.textContent = '■ Stop auto-compare';
  };

  const _toggleAutoCompare = () => {
    if (_isAutoCompareRunning()) _stopAutoCompare();
    else _startAutoCompare();
  };

  const _bindDom = () => {
    const drop = $('rom-drop');
    const fileInput = $('rom-file');
    drop?.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('dragover');
    });
    drop?.addEventListener('dragleave', () => {
      drop.classList.remove('dragover');
    });
    drop?.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('dragover');
      _loadRomFile(event.dataTransfer?.files?.[0]);
    });
    fileInput?.addEventListener('change', () => {
      _loadRomFile(fileInput.files?.[0]);
    });

    $('lag')?.addEventListener('input', () => {
      _markUserInteracted();
      // Cancel any in-flight slider animation — user is taking control.
      if (_lagAnimRaf) {
        cancelAnimationFrame(_lagAnimRaf);
        _lagAnimRaf = 0;
      }
      // Remember this as the user's preference for future match starts.
      _savedRttPreference = _readRtt();
      _applyNetwork();
    });
    $('rollback-toggle')?.addEventListener('click', () => {
      _markUserInteracted();
      // Manual toggle stops auto-compare so the user is back in control.
      _stopAutoCompare();
      _setRollbackEnabled(!_rollbackEnabled);
    });
    $('emu-pause')?.addEventListener('click', () => {
      _markUserInteracted();
      _toggleEmuPause();
    });
    $('emu-stop')?.addEventListener('click', () => {
      _markUserInteracted();
      _stopEmu();
    });
    $('emu-controls')?.addEventListener('click', () => {
      _markUserInteracted();
      // Open the same controller-settings panel the lobby uses (loaded
      // via the demo.html script tag). Lazy-init GamepadManager on first
      // open so detection works whether or not we hit this from the
      // engine-start path.
      _ensureGamepadManager();
      window.ControllerSettings?.toggle?.();
    });
    $('emu-reset')?.addEventListener('click', () => {
      _markUserInteracted();
      _resetDemo();
    });
    $('auto-compare-btn')?.addEventListener('click', () => {
      _markUserInteracted();
      _toggleAutoCompare();
    });

    // Gesture button: the engine listens for clicks on the page once it's in
    // the boot-gesture phase, but giving the button its own click handler that
    // explicitly invokes the boot path makes "tap to start" reliable on every
    // browser.
    $('gesture-button')?.addEventListener('click', () => {
      window.KNStartEmulatorBoot?.({ forceStartOnLoad: true });
      // Now that the user has tapped to start, the autopilot is about to
      // actually drive the game. Show the "inputs disabled" badge here
      // (deferred from _installInputHook) so the warning matches reality.
      if (_autopilotActive) _showInputIndicator('disabled');
    });

    _restoreSavedLag();
    _applyNetwork();
    _updateRollbackToggle();
    _nativeRAF(_updateHud);
  };

  document.addEventListener('DOMContentLoaded', () => {
    _bindDom();
    // Auto-restore a cached ROM if one exists. Lets Reset (location.reload)
    // come back into a running engine instead of dumping the user back at
    // the drop-ROM screen. Stop explicitly clears the cache so it still
    // works as a hard quit.
    _idbRomLoad()
      .then((cached) => {
        if (!cached?.bytes || !cached?.name) return;
        const blob = new Blob([cached.bytes], { type: 'application/octet-stream' });
        const file = new File([blob], cached.name, { type: 'application/octet-stream' });
        _setStatus(`Restoring ${cached.name}…`);
        return _loadRomFile(file);
      })
      .catch(() => {});
  });

  // Show a clear visual indicator of whether the user's inputs are being
  // ignored (autopilot is driving the menus) or whether they're in control.
  // state: 'disabled' shows persistent amber badge; 'enabled' flashes a
  // green "YOU'RE IN CONTROL" badge for 3s; null/undefined removes both.
  let _inputIndicatorTimer = null;
  const _ensureIndicatorAnim = () => {
    if (document.getElementById('kn-demo-indicator-anim')) return;
    const style = document.createElement('style');
    style.id = 'kn-demo-indicator-anim';
    // Pulse the box-shadow only — no transform/size change keeps the badge
    // on a single GPU compositor layer (no repaint of underlying page).
    // fadeOut also opacity-only so the swap from amber to green doesn't
    // trigger any layout recalculation.
    style.textContent =
      '@keyframes inputPulse{0%,100%{box-shadow:0 0 0 0 rgba(245,200,75,0.5)}50%{box-shadow:0 0 0 10px rgba(245,200,75,0)}}' +
      '@keyframes inputFadeIn{0%{opacity:0}100%{opacity:1}}' +
      '@keyframes inputFadeOut{0%{opacity:1}66%{opacity:1}100%{opacity:0}}';
    document.head.appendChild(style);
  };
  // Always remove the existing indicator before creating a new one. Mutating
  // the same element to swap state caused two animations (pulse + fade) to
  // briefly fight each other, which the browser composited as a visible flash.
  const _showInputIndicator = (state) => {
    if (_inputIndicatorTimer) {
      clearTimeout(_inputIndicatorTimer);
      _inputIndicatorTimer = null;
    }
    const existing = document.getElementById('input-indicator');
    if (existing) existing.remove();
    if (!state) return;
    _ensureIndicatorAnim();
    const el = document.createElement('div');
    el.id = 'input-indicator';
    el.style.cssText =
      'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:9999;' +
      'padding:8px 16px;border-radius:6px;color:#111;' +
      'font-family:sans-serif;font-weight:800;font-size:13px;letter-spacing:0.08em;' +
      'pointer-events:none;text-transform:uppercase;will-change:opacity;';
    if (state === 'disabled') {
      el.textContent = 'Setting up demo, inputs disabled';
      el.style.background = '#f5c84b';
      el.style.animation = 'inputFadeIn 200ms ease-out, inputPulse 1.6s ease-in-out 200ms infinite';
    } else if (state === 'enabled') {
      el.textContent = 'Setup finished, inputs enabled';
      el.style.background = '#7ddc8a';
      el.style.animation = 'inputFadeIn 200ms ease-out, inputFadeOut 2.2s ease-out 200ms forwards';
      _inputIndicatorTimer = setTimeout(() => {
        const cur = document.getElementById('input-indicator');
        if (cur) cur.remove();
        _inputIndicatorTimer = null;
      }, 2400);
    } else if (state === 'post-match') {
      el.textContent = 'Match ended — hit Reset for another round';
      el.style.background = '#f5c84b';
      el.style.animation = 'inputFadeIn 200ms ease-out, inputPulse 1.6s ease-in-out 200ms infinite';
    }
    document.body.appendChild(el);
  };

  const _showRecIndicator = (on) => {
    let el = document.getElementById('rec-indicator');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'rec-indicator';
      el.textContent = '● REC';
      el.style.cssText =
        'position:fixed;top:12px;right:12px;z-index:9999;' +
        'padding:6px 12px;border-radius:6px;background:#a02020;color:#fff;' +
        'font-family:sans-serif;font-weight:800;font-size:13px;letter-spacing:0.08em;' +
        'box-shadow:0 0 0 0 rgba(255,80,80,0.6);animation:recPulse 1.4s ease-in-out infinite;' +
        'pointer-events:none;';
      const style = document.createElement('style');
      style.textContent =
        '@keyframes recPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,80,80,0.6)}50%{box-shadow:0 0 0 12px rgba(255,80,80,0)}}';
      document.head.appendChild(style);
      document.body.appendChild(el);
    } else if (!on && el) {
      el.remove();
    }
  };

  // Manual recording controls. Use these from devtools console if you didn't
  // visit with ?record=1 from the start:
  //   KNDemo.startRecording()  — begin capturing local inputs
  //   KNDemo.stopRecording()   — finish, dump JSON, auto-download file
  //   KNDemo.getRecording()    — return current buffer as JSON string
  // Recording stops automatically when isInMatch() flips true.
  const _startRecordingManual = () => {
    if (_recordingDone) {
      // eslint-disable-next-line no-console
      console.warn('Recording already finished. Refresh to start over.');
      return;
    }
    _recordMode = true;
    _recordingActive = true;
    _recordingDone = false;
    _recordedInputs.length = 0;
    _showRecIndicator(true);
    _setStatus('REC mode (manual) — play through to a match. Stops automatically.');
    // eslint-disable-next-line no-console
    console.log('%cRECORDING STARTED', 'color:#f55;font-weight:bold;font-size:14px');
  };

  const _stopRecordingManual = () => {
    _finishRecording();
  };

  const _getRecording = () => JSON.stringify(_recordedInputs);

  // Show the REC badge from page load if ?record=1 was set in the URL.
  if (_recordMode) {
    document.addEventListener('DOMContentLoaded', () => _showRecIndicator(true));
  }

  window.KNDemo = {
    ensureEmulatorBooted,
    loadRomFile: _loadRomFile,
    setRollbackEnabled: _setRollbackEnabled,
    startRecording: _startRecordingManual,
    stopRecording: _stopRecordingManual,
    getRecording: _getRecording,
  };
})();
