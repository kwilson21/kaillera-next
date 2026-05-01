(function () {
  'use strict';

  const AUTOFLIP_PAUSE_MS = 32;
  const AUTOFLIP_RESUME_MS = 16;
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

  let _romBlobUrl = null;
  let _engineStarted = false;
  let _fakePeerStarted = false;
  let _emulatorBootInFlight = false;
  let _loaderInjected = false;
  let _autoflipEnabled = true;

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

  const _formatMs = (value) => (Number.isFinite(value) ? `${value.toFixed(0)} ms` : '-- ms');
  const _formatNumber = (value, digits = 0) => (Number.isFinite(value) ? value.toFixed(digits) : '--');

  const _readFile = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('ROM read failed'));
      reader.readAsArrayBuffer(file);
    });

  const _networkFromControls = () => ({
    latencyMs: Number($('latency')?.value ?? 80),
    jitterMs: Number($('jitter')?.value ?? 8),
    lossProb: Number($('loss')?.value ?? 2) / 100,
    mispredictProb: Number($('mispredict')?.value ?? 8) / 100,
  });

  const _updateSliderLabels = () => {
    const network = _networkFromControls();
    const lossPct = network.lossProb * 100;
    const mispredictPct = network.mispredictProb * 100;
    const labels = {
      'latency-value': `${network.latencyMs.toFixed(0)} ms`,
      'jitter-value': `${network.jitterMs.toFixed(0)} ms`,
      'loss-value': `${lossPct.toFixed(0)}%`,
      'mispredict-value': `${mispredictPct.toFixed(0)}%`,
    };
    for (const [id, text] of Object.entries(labels)) {
      const el = $(id);
      if (el) el.textContent = text;
    }
  };

  const _applyNetwork = () => {
    _updateSliderLabels();
    window.KNFakePeer?.setNetwork?.(_networkFromControls());
  };

  const _selectedGameId = () => {
    const selected = document.querySelector('input[name="rom-kind"]:checked');
    return selected?.value === 'remix' ? 'smash-remix' : 'ssb64';
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
      romHash: null,
      gameId: _selectedGameId(),
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

    // Start fake peer immediately. The engine needs slot 1 inputs continuously
    // from frame 0: during the lockstep menu phase, and after C rollback
    // engages. Waiting for isCRollback() deadlocks games that defer rollback
    // until gameplay because the menu cannot advance without slot 1 input.
    window.KNFakePeer?.start?.({
      slot: 1,
      getCurrentFrame: () => window.NetplayRollback?.getHudCounters?.().currentFrame ?? 0,
    });
    window.KNFakePeer?.setNetwork?.(_networkFromControls());
    _fakePeerStarted = true;

    _setStatus('Tap to start emulator');
    _pollRollbackReady();
  };

  const _pollRollbackReady = () => {
    if (!_engineStarted) return;
    if (window.NetplayRollback?.isCRollback?.()) {
      _setStatus('Rollback active');
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
      if (_romBlobUrl) URL.revokeObjectURL(_romBlobUrl);
      _romBlobUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      window.EJS_gameUrl = _romBlobUrl;
      window.EJS_gameName = file.name;
      window.EJS_cheats = [];
      $('game')?.classList.add('kn-playing');
      $('rom-drop')?.classList.add('hidden');
      _showLoading(false);
      _setStatus('ROM loaded');
      _startEngine();
    } catch (err) {
      _showLoading(false);
      _setStatus(err?.message || 'ROM load failed');
    }
  };

  const _tickAutoFlip = () => {
    if (!_autoflipEnabled || !_fakePeerStarted) return;
    const stats = window.KNFakePeer?.getStats?.() || { p95LatenessMs: 0 };
    const paused = !!window.NetplayRollback?.isPredictionsPaused?.();
    if (!paused && stats.p95LatenessMs > AUTOFLIP_PAUSE_MS) {
      window.NetplayRollback?.setPredictionsPaused?.(true);
    } else if (paused && stats.p95LatenessMs < AUTOFLIP_RESUME_MS) {
      window.NetplayRollback?.setPredictionsPaused?.(false);
    }
  };

  const _updateHud = () => {
    const note = $('hud-note');
    const counters = window.NetplayRollback?.getHudCounters?.();
    const stats = window.KNFakePeer?.getStats?.() || {
      p95LatenessMs: 0,
      queuedPackets: 0,
      mispredictsLastSec: 0,
      lossLastSec: 0,
    };

    if (!counters || !_engineStarted) {
      if (note) note.textContent = 'Waiting for ROM.';
    } else if (!counters.isCRollback) {
      if (note) note.textContent = 'Waiting for gameplay...';
      $('hud-frame').textContent = String(counters.currentFrame ?? 0);
      $('hud-delay').textContent = String(counters.delay ?? '--');
    } else {
      _tickAutoFlip();
      const pingText =
        counters.pingMs == null ? `${_networkFromControls().latencyMs.toFixed(0)} ms` : _formatMs(counters.pingMs);
      $('hud-ping').textContent = pingText;
      $('hud-roll').textContent =
        `${_formatNumber(counters.rollbackEventsPerSec, 1)}/s avg ${_formatNumber(counters.avgRollbackDepth, 1)}`;
      $('hud-stall').textContent = _formatMs(counters.stallMs);
      $('hud-pred').textContent = counters.predictionState;
      $('hud-frame').textContent = String(counters.currentFrame);
      $('hud-delay').textContent = String(counters.delay);
      $('hud-stall-row')?.classList.toggle('warn', counters.stallMs > 0);
      $('hud-pred-row')?.classList.toggle('pred-lock', counters.predictionState === 'LOCKSTEP');
      if (note) {
        note.textContent =
          `p95 late ${stats.p95LatenessMs.toFixed(0)} ms · queued ${stats.queuedPackets} · ` +
          `loss ${stats.lossLastSec}/s · mispredict ${stats.mispredictsLastSec}/s`;
      }
    }

    _nativeRAF(_updateHud);
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

    ['latency', 'jitter', 'loss', 'mispredict'].forEach((id) => {
      $(id)?.addEventListener('input', _applyNetwork);
    });
    $('force-lockstep')?.addEventListener('change', (event) => {
      const checked = !!event.currentTarget.checked;
      _autoflipEnabled = !checked;
      window.NetplayRollback?.setPredictionsPaused?.(checked);
    });

    _applyNetwork();
    _nativeRAF(_updateHud);
  };

  document.addEventListener('DOMContentLoaded', _bindDom);

  window.KNDemo = {
    ensureEmulatorBooted,
    loadRomFile: _loadRomFile,
    setAutoFlipEnabled: (enabled) => {
      _autoflipEnabled = !!enabled;
    },
  };
})();
