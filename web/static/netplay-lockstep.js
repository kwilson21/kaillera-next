/**
 * kaillera-next — Lockstep Netplay Engine
 *
 * Deterministic lockstep netplay for up to 4 players running EmulatorJS
 * (mupen64plus-next WASM core) in perfect sync. All players run their own
 * emulator instance and exchange inputs each frame — no single host.
 *
 * ── Network Topology ──────────────────────────────────────────────────────
 *
 *   Players form a full mesh: up to 6 bidirectional WebRTC DataChannel
 *   connections for 4 players (N*(N-1)/2). Each player sends their input
 *   to every other player each frame. Spectators receive a canvas video
 *   stream from the host (slot 0) but do not participate in lockstep.
 *
 *   Connection initiation rules:
 *     - Normal join: lower slot number creates the DataChannel and sends
 *       the WebRTC offer. Higher slot waits for incoming offer.
 *     - Late join: the joining player always initiates (avoids race where
 *       host's offer arrives before the joiner has registered listeners).
 *     - Spectators: never initiate — players create connections TO them.
 *
 * ── Startup Sequence ──────────────────────────────────────────────────────
 *
 *   1. All players boot EmulatorJS independently and wait for the WASM
 *      core to be ready (host waits 120+ frames, guests wait ~10 frames).
 *   2. INPUT_BASE auto-discovery: calls _simulate_input(0, 0, 1) and scans
 *      the first 4MB of HEAPU8 for the changed byte. This locates the core's
 *      internal input_state array, which varies per WASM compilation.
 *   3. Host captures a save state, gzip-compresses it, base64-encodes it,
 *      and sends it to all guests via Socket.IO (save states are ~1.5MB,
 *      too large for WebRTC DataChannels which have SCTP buffering limits).
 *   4. RTT measurement: 3 ping-pong rounds over each DataChannel. The
 *      median RTT determines auto frame delay: ceil(median_ms / 16.67),
 *      clamped to [1, 9]. Both sides exchange their delay preference and
 *      the maximum across all players becomes the effective DELAY_FRAMES.
 *   5. All players load the same save state (double-load: first restores
 *      CPU+RAM, then enterManualMode() captures rAF, second load fixes
 *      any free-frame drift between the loads). Frame counter resets to 0.
 *   6. Lockstep tick loop starts via setInterval(16).
 *
 * ── Frame Stepping (Manual Mode) ─────────────────────────────────────────
 *
 *   Emscripten's main loop is driven by requestAnimationFrame. To control
 *   frame timing, we intercept rAF:
 *     - Save the real requestAnimationFrame as _origRAF
 *     - Replace window.requestAnimationFrame with an interceptor that
 *       captures the callback (_pendingRunner) instead of scheduling it
 *     - Call Module.resumeMainLoop() so Emscripten registers its runner
 *       through our interceptor, giving us the callback
 *     - stepOneFrame() calls _pendingRunner(frameTimeMs), advancing the
 *       emulator by exactly one frame, then schedules a real rAF no-op
 *       to force GL compositing
 *
 *   The tick loop uses setInterval(16) instead of rAF because rAF is
 *   throttled to ~1fps in background tabs, which would stall the game.
 *
 * ── Tick Loop (Per-Frame) ─────────────────────────────────────────────────
 *
 *   Each tick at frame N:
 *     1. Read local input (keyboard via keyCode tracking + gamepad via
 *        GamepadManager) → 24-bit mask (16 digital buttons + 4 analog
 *        axis pairs encoded as bit pairs)
 *     2. Send Int32Array([frameN, inputMask]) (8 bytes) to all peer DCs
 *     3. Compute applyFrame = N - DELAY_FRAMES (the delayed frame whose
 *        inputs are ready to apply)
 *     4. Check if all "input peers" have sent input for applyFrame.
 *        Input peers = peers who have sent at least one input (excludes
 *        late-joiners still booting). If missing:
 *          - Stall: return early, retry via setTimeout(1) for sub-16ms
 *            retry. After MAX_STALL_MS (500ms), inject zero input to unstick.
 *     5. Write all players' inputs to WASM memory via _simulate_input()
 *        (iterates 16 digital buttons + 4 analog axis pairs per player)
 *     6. Reset audio buffer, step one frame, feed audio samples to
 *        AudioWorklet (or AudioBufferSourceNode fallback)
 *     7. Increment frame counter. Periodically update debug overlay.
 *
 * ── Input Encoding ────────────────────────────────────────────────────────
 *
 *   24-bit mask packed into an Int32:
 *     Bits  0-15: digital buttons (A, B, Start, D-pad, L, R, Z, etc.)
 *     Bits 16-17: left stick X (bit 16 = right, bit 17 = left)
 *     Bits 18-19: left stick Y (bit 18 = down, bit 19 = up)
 *     Bits 20-21: C-stick X (right/left)
 *     Bits 22-23: C-stick Y (down/up)
 *   Analog axes are reconstructed as ±32767 from the bit pairs.
 *
 * ── Audio ─────────────────────────────────────────────────────────────────
 *
 *   OpenAL (Emscripten's default audio) is killed at lockstep start:
 *   all AL sources stopped, AudioContext suspended, resume() overridden
 *   to prevent browser auto-resume on user gestures. Instead, audio is
 *   captured per-frame from WASM memory via custom core exports
 *   (_kn_get_audio_ptr, _kn_get_audio_samples, _kn_reset_audio) and
 *   fed to an AudioWorklet ring buffer. This ensures audio is frame-
 *   locked to the lockstep tick and identical across all players.
 *   Host also routes audio to a MediaStreamDestination for spectators.
 *
 * ── Deterministic Timing ──────────────────────────────────────────────────
 *
 *   With the patched (forked) WASM core, _kn_set_deterministic(1) is
 *   called at lockstep start. This makes _emscripten_get_now() return a
 *   monotonically increasing value based on frame count (set each frame
 *   via _kn_set_frame_time). The stock (CDN) core falls back to a JS-
 *   level performance.now() shim via window._kn_frameTime.
 *
 * ── Desync Detection & Resync (Star Topology) ────────────────────────────
 *
 *   Opt-in (rollbackEnabled flag). Star topology: only the host (slot 0)
 *   is the sync authority. The host hashes 64KB of RDRAM (direct HEAPU8
 *   access when available, falling back to getState()) every
 *   _syncCheckInterval frames using FNV-1a and broadcasts
 *   "sync-hash:frame:hash" to all peers. Guests hash the same HEAPU8
 *   region — no expensive getState() serialization needed.
 *
 *   If a guest's hash differs, it sends "sync-request" and the host
 *   captures + compresses the full state and sends it via DataChannel
 *   in 64KB chunks to the requesting peer only.
 *
 *   The guest decompresses the state and buffers it for async application
 *   at the next clean frame boundary (start of tick loop) — no mid-frame
 *   stall.
 *
 * ── Late Join ─────────────────────────────────────────────────────────────
 *
 *   When a player joins a game already in progress:
 *     1. Joiner boots emulator minimally, enters manual mode
 *     2. Sends "request-late-join" via Socket.IO data-message
 *     3. Host captures + compresses state, sends "late-join-state" with
 *        the current frame number and effective delay
 *     4. Joiner loads state, syncs frame counter to max(hostFrame,
 *        lastRemoteFrame), pre-fills delay gap with zero input, starts
 *        lockstep tick loop
 *
 * ── Drop Handling ─────────────────────────────────────────────────────────
 *
 *   When a peer's DataChannel closes or ICE connection fails:
 *     - Their input in WASM memory is zeroed (neutral stick, no buttons)
 *     - They're removed from the peer map and input tracking
 *     - Remaining players continue — the tick loop handles zero active
 *       peers gracefully (single-player mode)
 *     - No reconnect attempt; the dropped player can re-join as late join
 */

(function () {
  'use strict';

  const ICE_SERVERS = window._iceServers || [{ urls: 'stun:stun.cloudflare.com:3478' }];

  // ── Debug log capture ─────────────────────────────────────────────────
  // Intercepts all console.log('[lockstep] ...') calls for remote debugging.
  // Unbounded array — game sessions are finite. Pushed to server on demand.
  var _debugLog = [];
  var _debugLogStart = Date.now();
  (function () {
    var _origLog = console.log;
    console.log = function () {
      _origLog.apply(console, arguments);
      // Capture [lockstep] and [play] prefixed messages
      if (arguments.length > 0) {
        var first = String(arguments[0]);
        if (first.indexOf('[lockstep]') === 0 || first.indexOf('[play]') === 0 ||
            (arguments.length > 1 && String(arguments[1]).indexOf('[lockstep]') >= 0)) {
          var ts = ((Date.now() - _debugLogStart) / 1000).toFixed(3);
          var parts = [];
          for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
          _debugLog.push('[' + ts + '] ' + parts.join(' '));
          if (_debugLog.length > 2000) _debugLog.splice(0, 500);
        }
      }
    };
  })();

  // Input delay in frames -- both peers buffer this many frames of input
  // before applying. Hides network latency: peer has DELAY_FRAMES worth
  // of time to deliver their input before we need it.
  let DELAY_FRAMES = 2;

  let _onExtraDataChannel = null;
  let _onUnhandledMessage = null;


  let _rttSamples = [];
  let _rttComplete = false;
  let _rttPeersComplete = 0;
  let _rttPeersTotal = 0;

  function startRttMeasurement(peer) {
    peer._rttSamples = [];
    peer._rttPingCount = 0;
    peer._rttComplete = false;
    _rttPeersTotal++;
    sendNextPing(peer);
  }

  function sendNextPing(peer) {
    if (peer._rttPingCount >= 3) {
      peer._rttComplete = true;
      // Copy per-peer samples into peer.rttSamples for getInfo()
      peer.rttSamples = peer._rttSamples.slice().sort((a, b) => a - b);
      // Accumulate into global _rttSamples
      peer._rttSamples.forEach((s) => { _rttSamples.push(s); });
      _rttPeersComplete++;
      // When all peers are done, compute auto delay from max median across peers
      if (_rttPeersComplete >= _rttPeersTotal) {
        _rttSamples.sort((a, b) => a - b);
        var median = _rttSamples[Math.floor(_rttSamples.length / 2)];
        var delay = Math.min(9, Math.max(1, Math.ceil(median / 16.67)));
        _rttComplete = true;
        if (window.setAutoDelay) window.setAutoDelay(delay);
        console.log('[lockstep] RTT median: ' + median.toFixed(1) + 'ms -> auto delay: ' + delay);
      }
      return;
    }
    try {
      peer.dc.send(JSON.stringify({ type: 'delay-ping', ts: performance.now() }));
    } catch (_) {
      peer._rttComplete = true;
      _rttPeersComplete++;
    }
  }

  function handleDelayPong(ts, peer) {
    var rtt = performance.now() - ts;
    peer._rttSamples.push(rtt);
    peer._rttPingCount++;
    sendNextPing(peer);
    if (_rttComplete && _selfLockstepReady) {
      broadcastLockstepReady();
      checkAllLockstepReady();
    }
  }

  function broadcastLockstepReady() {
    var dl = window.getDelayPreference ? window.getDelayPreference() : 2;
    Object.values(_peers).forEach((p) => {
      if (p.dc && p.dc.readyState === 'open' && p.slot !== null && p.slot !== undefined) {
        try {
          p.dc.send(JSON.stringify({ type: 'lockstep-ready', delay: dl }));
        } catch (_) {}
      }
    });
  }

  // Maximum time (ms) to stall waiting for remote input before treating
  // the peer as disconnected. Like Kaillera, we WAIT -- no prediction.
  const MAX_STALL_MS = 500;

  // -- Direct memory input layout -----------------------------------------------
  //
  // Layout: int32[20][4] -- 20 buttons x 4 players
  // Button stride: 20 bytes (gap between button N and button N+1 for same player)
  // Player stride: 4 bytes (gap between player 0 and player 1 for same button)
  //
  // The base address changes with each WASM compilation, so we auto-discover it
  // at startup by calling _simulate_input and detecting which byte changed.
  // Fallback: 715364 (CDN core address).

  let INPUT_BASE       = 715364;  // auto-discovered at startup

  // -- Diagnostics state (DIAG logger) ----------------------------------------
  let _diagPlayerAddrs = [null, null, null, null]; // per-player input base addresses
  let _diagLastTickTime = 0;       // wall-clock time of previous tick() call
  let _diagEventLog     = [];      // buffered async events [{t, type, detail}]
  let _diagHookInstalled = false;  // true once async event hooks are set up
  var DIAG_HASH_INTERVAL  = 10;    // frames between RDRAM hash+dump logs (~6x/sec)
  var DIAG_INPUT_INTERVAL = 30;    // frames between input read logs
  var DIAG_TIME_INTERVAL  = 60;    // frames between timing logs
  var DIAG_EARLY_FRAMES   = 300;   // log everything for first N frames

  // -- State -----------------------------------------------------------------

  let socket             = null;
  let _playerSlot        = -1;      // 0-3 for players, null for spectators
  let _isSpectator       = false;
  // -- Audio bypass state --
  let _audioCtx = null;
  let _audioWorklet = null;
  let _audioDestNode = null;
  let _audioPtr = 0;
  let _audioRate = 0;
  let _audioReady = false;
  let _peers             = {};      // remoteSid -> PeerState
  let _knownPlayers      = {};      // socketId -> {slot, playerName}
  let _gameStarted       = false;
  let _selfEmuReady      = false;
  let _p1KeyMap          = null;
  let _heldKeys          = new Set();

  // Lockstep state
  let _lockstepReadyPeers = {};     // remoteSid -> true when peer signals lockstep-ready
  let _selfLockstepReady  = false;
  let _guestStateBytes    = null;   // decompressed state bytes to load
  let _frameNum           = 0;      // current logical frame number
  let _localInputs        = {};     // frame -> inputMask
  let _remoteInputs       = {};     // slot -> {frame -> mask} (nested for multi-peer)
  let _peerInputStarted   = {};     // slot -> true once first input received (survives buffer drain)
  let _running            = false;  // tick loop active
  let _lateJoin           = false;  // true when joining a game already in progress

  // Manual mode / rAF interception state
  let _origRAF           = null;    // saved window.requestAnimationFrame
  let _pendingRunner     = null;    // captured Emscripten MainLoop_runner
  let _manualMode        = false;   // true once enterManualMode() called
  let _stallStart        = 0;       // timestamp when current stall began
  let _tickInterval      = null;    // setInterval handle for tick loop

  // Saved originals of WASM speed-control functions — neutralized during lockstep
  let _origToggleFF      = null;    // Module._toggle_fastforward
  let _origToggleSM      = null;    // Module._toggle_slow_motion

  // State sync — host checks game state hash and pushes only when desynced
  let _syncEnabled       = false;   // off by default — opt-in via toolbar button
  // (sync compression uses CompressionStream/DecompressionStream directly)
  let _syncCheckInterval = 120;    // check hash every N frames (~2s at 60fps)
  let _syncBaseInterval  = 120;    // direct RDRAM reads are ~0.1ms (no getState)
  // Hash byte limit (65536) is set inside the sync worker's fnv1a function
  let _resyncCount       = 0;
  let _consecutiveResyncs = 0;     // track consecutive resyncs for adaptive backoff
  function _streamSync(msg) {
    // Stream sync events to server in real-time (appends to logs/live.log)
    if (socket && socket.connected) {
      socket.emit('debug-sync', { slot: _playerSlot, msg: msg });
    }
  }

  // -- Diagnostic logger functions -------------------------------------------

  function _diagShouldLog(frameNum, interval) {
    return frameNum < DIAG_EARLY_FRAMES || frameNum % interval === 0;
  }

  // DIAG-HASH: compute and stream per-region RDRAM hashes for this player
  var _diagRegionNames = [
    'cfg', 'ps0', 'ps1', 'ps2', 'ph1a', 'ph1b', 'ph1c', 'misc', 'ph2', 'ph3a', 'ph3b', 'ph3c'
  ];
  // Hex lookup table for byte-to-hex conversion
  var _hexLUT = [];
  for (var _hi = 0; _hi < 256; _hi++) _hexLUT[_hi] = (_hi < 16 ? '0' : '') + _hi.toString(16);
  function _bytesToHex(bytes, off, len) {
    var s = '';
    for (var i = off; i < off + len; i++) s += _hexLUT[bytes[i]];
    return s;
  }

  function _diagGetRdram() {
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    if (!mod) return null;
    if (!_hashRegion) { getHashBytes(); }
    if (!_hashRegion || !_hashRegion.ptr) return null;
    var buf = mod.HEAPU8 ? mod.HEAPU8.buffer : null;
    if (!buf || buf.byteLength === 0) return null;
    return { live: new Uint8Array(buf), base: _hashRegion.ptr };
  }

  function _diagHash(frameNum) {
    if (!_diagShouldLog(frameNum, DIAG_HASH_INTERVAL)) return;
    var rd = _diagGetRdram();
    if (!rd) return;
    var gameRegions = [
      0xA4000, 0xBA000, 0xBF000, 0xC4000,
      0x262000, 0x266000, 0x26A000, 0x290000,
      0x2F6000, 0x32B000, 0x330000, 0x335000
    ];
    var SAMPLE = 256;
    var f = frameNum;
    var pending = gameRegions.length;
    var regionHashes = new Array(gameRegions.length);
    for (var gi = 0; gi < gameRegions.length; gi++) {
      (function (idx) {
        var gOff = rd.base + gameRegions[idx];
        var regionBytes = rd.live.slice(gOff, gOff + SAMPLE);
        workerPost({ type: 'hash', data: regionBytes }).then(function (res) {
          regionHashes[idx] = res.hash;
          pending--;
          if (pending === 0) {
            var parts = [];
            for (var r = 0; r < regionHashes.length; r++) {
              parts.push(_diagRegionNames[r] + '=' + regionHashes[r]);
            }
            _streamSync('DIAG-HASH f=' + f + ' ' + parts.join(' '));
          }
        }).catch(function () { pending--; });
      })(gi);
    }
  }

  // DIAG-DUMP: hex dump of ps0 (0xBA000) and ps1 (0xBF000) — the diverging regions.
  // Dumps 64 bytes from each at 4 sub-offsets (0, 64, 128, 192) to find which
  // part of the 256-byte sample diverges. Runs every DIAG_HASH_INTERVAL frames.
  function _diagDump(frameNum) {
    if (!_diagShouldLog(frameNum, DIAG_HASH_INTERVAL)) return;
    var rd = _diagGetRdram();
    if (!rd) return;
    // Dump 4 x 32-byte chunks from ps0 and ps1 (128 hex chars per chunk, manageable)
    var dumpRegions = [
      { name: 'ps0', off: 0xBA000 },
      { name: 'ps1', off: 0xBF000 }
    ];
    for (var di = 0; di < dumpRegions.length; di++) {
      var addr = rd.base + dumpRegions[di].off;
      // 4 chunks of 64 bytes = full 256 byte sample
      var hex = _bytesToHex(rd.live, addr, 256);
      _streamSync('DIAG-DUMP f=' + frameNum + ' ' + dumpRegions[di].name +
        ' @0x' + dumpRegions[di].off.toString(16) + ' ' + hex);
    }
  }

  // DIAG-INPUT: read back per-player inputs from WASM memory using discovered addresses
  function _diagInput(frameNum, applyFrame) {
    if (!_diagShouldLog(frameNum, DIAG_INPUT_INTERVAL)) return;
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    if (!mod || !mod.HEAPU8) return;
    var mem = mod.HEAPU8;
    var vals = [];
    for (var p = 0; p < 4; p++) {
      var addr = _diagPlayerAddrs[p];
      if (addr === null) { vals.push('?'); continue; }
      // Read 4 bytes (32-bit LE) at the player's button 0 address
      if (addr + 3 < mem.length) {
        var v = mem[addr] | (mem[addr+1] << 8) | (mem[addr+2] << 16) | (mem[addr+3] << 24);
        vals.push(v);
      } else {
        vals.push('OOB');
      }
    }
    _streamSync('DIAG-INPUT f=' + frameNum + ' apply=' + applyFrame +
      ' p0=' + vals[0] + ' p1=' + vals[1] + ' p2=' + vals[2] + ' p3=' + vals[3]);
  }

  // DIAG-TIME: timing values after frame step
  function _diagTime(frameNum, wallBefore, wallAfter) {
    if (!_diagShouldLog(frameNum, DIAG_TIME_INTERVAL)) return;
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    var cycleTime = (mod && mod._kn_get_cycle_time_ms) ? mod._kn_get_cycle_time_ms() : -1;
    var frameArg = window._kn_frameTime || -1;
    var wallDelta = _diagLastTickTime > 0 ? (wallBefore - _diagLastTickTime) : 0;
    var stepDuration = wallAfter - wallBefore;
    _streamSync('DIAG-TIME f=' + frameNum +
      ' cycle=' + (typeof cycleTime === 'number' ? cycleTime.toFixed(1) : cycleTime) +
      ' frameArg=' + (typeof frameArg === 'number' ? frameArg.toFixed(1) : frameArg) +
      ' wallDelta=' + wallDelta.toFixed(1) +
      ' stepMs=' + stepDuration.toFixed(1));
  }

  // DIAG-EVENT: flush buffered async events
  function _diagFlushEvents(frameNum) {
    if (_diagEventLog.length === 0) return;
    for (var i = 0; i < _diagEventLog.length; i++) {
      var ev = _diagEventLog[i];
      _streamSync('DIAG-EVENT f=' + frameNum + ' type=' + ev.type +
        ' detail=' + ev.detail + ' t=' + ev.t.toFixed(1));
    }
    _diagEventLog.length = 0;
  }

  // Install async event hooks (called once at lockstep start)
  function _diagInstallHooks() {
    if (_diagHookInstalled) return;
    _diagHookInstalled = true;

    // Visibility change (tab hidden/shown)
    document.addEventListener('visibilitychange', function () {
      _diagEventLog.push({
        t: performance.now(),
        type: 'visibility',
        detail: document.visibilityState
      });
    });

    // Window focus/blur
    window.addEventListener('focus', function () {
      _diagEventLog.push({ t: performance.now(), type: 'focus', detail: 'gained' });
    });
    window.addEventListener('blur', function () {
      _diagEventLog.push({ t: performance.now(), type: 'focus', detail: 'lost' });
    });

    // Touch events on emulator canvas
    var canvas = document.querySelector('#game canvas, canvas');
    if (canvas) {
      ['touchstart', 'touchend', 'touchmove'].forEach(function (evName) {
        canvas.addEventListener(evName, function (e) {
          _diagEventLog.push({
            t: performance.now(),
            type: 'touch',
            detail: evName + ':' + e.touches.length
          });
        }, { passive: true });
      });
    }

    // EJS settings menu open/close (MutationObserver on body for settings panel)
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var mut = mutations[i];
        for (var j = 0; j < mut.addedNodes.length; j++) {
          var node = mut.addedNodes[j];
          if (node.nodeType === 1 && (node.classList.contains('ejs--settings') ||
              (node.querySelector && node.querySelector('.ejs--settings')))) {
            _diagEventLog.push({ t: performance.now(), type: 'ejs-menu', detail: 'opened' });
          }
        }
        for (var k = 0; k < mut.removedNodes.length; k++) {
          var rnode = mut.removedNodes[k];
          if (rnode.nodeType === 1 && (rnode.classList.contains('ejs--settings') ||
              (rnode.querySelector && rnode.querySelector('.ejs--settings')))) {
            _diagEventLog.push({ t: performance.now(), type: 'ejs-menu', detail: 'closed' });
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Monkey-patch pauseMainLoop/resumeMainLoop to detect unexpected pauses
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    if (mod) {
      var origPause = mod.pauseMainLoop;
      var origResume = mod.resumeMainLoop;
      if (origPause) {
        mod.pauseMainLoop = function () {
          _diagEventLog.push({ t: performance.now(), type: 'mainloop', detail: 'paused' });
          return origPause.apply(this, arguments);
        };
      }
      if (origResume) {
        mod.resumeMainLoop = function () {
          _diagEventLog.push({ t: performance.now(), type: 'mainloop', detail: 'resumed' });
          return origResume.apply(this, arguments);
        };
      }
    }

    console.log('[lockstep] DIAG hooks installed');
    _streamSync('DIAG-HOOKS installed');
  }

  let _syncChunks        = [];     // incoming chunks from host DC
  let _syncExpected      = 0;      // expected chunk count
  let _syncFrame         = 0;      // frame number of incoming sync
  let _syncIsFull        = true;   // true=full state, false=XOR delta
  let _lastResyncTime    = 0;      // timestamp of last resync request (10s cooldown)
  let _pendingSyncCheck  = null;   // deferred sync check {frame, hash, peerSid}
  let _pendingResyncState = null;  // {bytes, frame} buffered for async apply at frame boundary
  let _hashRegion         = null;  // {ptr, size} RDRAM pointer for direct HEAPU8 hashing
  let _inDeterministicStep = false; // gate for performance.now() override during frame step
  let _deterministicPerfNow = null; // saved override function

  // Spectator streaming state
  let _hostStream        = null;    // MediaStream for spectator canvas streaming
  let _guestVideo        = null;    // <video> element (spectator only)

  // Expose for Playwright
  window._playerSlot  = _playerSlot;
  window._isSpectator = _isSpectator;
  window._peers       = _peers;
  window._frameNum    = 0;

  async function initAudioPlayback() {
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    if (!mod) return;

    if (!mod._kn_get_audio_ptr || !mod._kn_get_audio_samples ||
        !mod._kn_reset_audio || !mod._kn_get_audio_rate) {
      console.log('[lockstep] audio capture exports not found — audio disabled');
      return;
    }

    _audioPtr = mod._kn_get_audio_ptr();
    _audioRate = mod._kn_get_audio_rate();
    if (!_audioRate || _audioRate <= 0) {
      console.log('[lockstep] audio rate not set yet, defaulting to 33600');
      _audioRate = 33600;
    }

    try {
      _audioCtx = new AudioContext({ sampleRate: _audioRate, latencyHint: 'interactive' });

      // Try AudioWorklet first (requires secure context), fall back to
      // AudioBufferSourceNode scheduling (works everywhere including mobile HTTP).
      var workletOk = false;
      if (_audioCtx.audioWorklet) {
        try {
          await _audioCtx.audioWorklet.addModule('/static/audio-worklet-processor.js');
          _audioWorklet = new AudioWorkletNode(_audioCtx, 'lockstep-audio-processor', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { sampleRate: _audioRate },
          });

          if (_playerSlot === 0) {
            _audioDestNode = _audioCtx.createMediaStreamDestination();
            _audioWorklet.connect(_audioDestNode);
          }

          _audioWorklet.connect(_audioCtx.destination);
          workletOk = true;
          console.log('[lockstep] audio using AudioWorklet');
        } catch (wErr) {
          console.log('[lockstep] AudioWorklet failed, using fallback:', wErr.message);
        }
      }

      if (!workletOk) {
        // Fallback: schedule AudioBufferSourceNodes per frame.
        // Works on mobile HTTP where AudioWorklet requires secure context.
        _audioWorklet = null;
        window._kn_audioNextTime = 0;
        console.log('[lockstep] audio using AudioBufferSourceNode fallback');
      }

      _audioReady = true;

      // Resume AudioContext on first user interaction (autoplay policy).
      if (_audioCtx.state === 'suspended') {
        var resumeAudio = function () {
          if (_audioCtx) _audioCtx.resume();
          document.removeEventListener('click', resumeAudio);
          document.removeEventListener('keydown', resumeAudio);
          document.removeEventListener('touchstart', resumeAudio);
        };
        document.addEventListener('click', resumeAudio);
        document.addEventListener('keydown', resumeAudio);
        document.addEventListener('touchstart', resumeAudio);
        console.log('[lockstep] audio suspended — tap or press a key to enable');
      }

      console.log('[lockstep] audio playback initialized (rate: ' + _audioRate + ')');
    } catch (err) {
      console.log('[lockstep] audio init failed:', err);
      _audioReady = false;
    }
  }

  function feedAudio() {
    if (!_audioReady || !_audioCtx) return;
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    if (!mod) return;

    var n = mod._kn_get_audio_samples();
    if (n <= 0) return;

    var pcm = new Int16Array(mod.HEAPU8.buffer, _audioPtr, n * 2);

    if (_audioWorklet) {
      // AudioWorklet path
      var copy = new Int16Array(pcm);
      _audioWorklet.port.postMessage(copy, [copy.buffer]);
    } else {
      // AudioBufferSourceNode fallback — schedule a buffer per frame.
      // Keep lookahead tight: max 50ms ahead of currentTime to minimize latency.
      var buf = _audioCtx.createBuffer(2, n, _audioRate);
      var chL = buf.getChannelData(0);
      var chR = buf.getChannelData(1);
      for (var i = 0; i < n; i++) {
        chL[i] = pcm[i * 2] / 32768.0;
        chR[i] = pcm[i * 2 + 1] / 32768.0;
      }
      var src = _audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(_audioCtx.destination);
      var now = _audioCtx.currentTime;
      if (!window._kn_audioNextTime || window._kn_audioNextTime < now) {
        window._kn_audioNextTime = now;
      }
      // Cap lookahead: if we're scheduling too far ahead, snap back
      if (window._kn_audioNextTime > now + 0.05) {
        window._kn_audioNextTime = now + 0.01;
      }
      src.start(window._kn_audioNextTime);
      window._kn_audioNextTime += buf.duration;
    }
  }

  function setStatus(msg) {
    if (_config && _config.onStatus) _config.onStatus(msg);
    console.log('[lockstep]', msg);
  }

  function onDataMessage(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === 'save-state')          handleSaveStateMsg(msg);
    if (msg.type === 'late-join-state')     handleLateJoinState(msg);
    if (msg.type === 'request-late-join')   handleLateJoinRequest(msg);
  }

  function handleLateJoinRequest(msg) {
    // Only host responds to late-join requests
    if (_playerSlot !== 0 || !_running) return;
    var requesterSid = msg.requesterSid;
    if (!requesterSid) return;
    console.log('[lockstep] received late-join request from', requesterSid);
    sendLateJoinState(requesterSid);
  }

  // -- users-updated ---------------------------------------------------------

  function onUsersUpdated(data) {
    var players    = data.players    || {};
    var spectators = data.spectators || {};

    // Rebuild known players map
    _knownPlayers = {};
    Object.values(players).forEach((p) => {
      _knownPlayers[p.socketId] = { slot: p.slot, playerName: p.playerName };
    });

    // Update my slot from server (handles spectator -> player transition)
    var myPlayerEntry = Object.values(players).find((p) => p.socketId === socket.id);
    if (myPlayerEntry) {
      if (_isSpectator) {
        console.log('[lockstep] transitioned from spectator to player, slot:', myPlayerEntry.slot);
        _isSpectator = false;
        window._isSpectator = false;
      }
      _playerSlot = myPlayerEntry.slot;
      window._playerSlot = _playerSlot;
    }

    var otherPlayers = Object.values(players).filter((p) => p.socketId !== socket.id);

    // Establish mesh connections to other players
    // Normal: lower slot initiates (creates data channel + sends offer)
    // Late-join: joiner always initiates (host's offer would arrive before listener is ready)
    // Running host: DON'T initiate to new players — let them initiate after their init()
    for (var i = 0; i < otherPlayers.length; i++) {
      var p = otherPlayers[i];
      if (_peers[p.socketId]) {
        _peers[p.socketId].slot = p.slot;
        continue;
      }

      var shouldInitiate;
      if (_lateJoin && !_isSpectator) {
        shouldInitiate = true;   // late-joiner always initiates
      } else if (_running) {
        shouldInitiate = false;  // running host waits for late-joiner's offer
      } else if (_isSpectator) {
        shouldInitiate = false;  // spectators never initiate
      } else {
        shouldInitiate = _playerSlot < p.slot;
      }

      createPeer(p.socketId, p.slot, shouldInitiate);
      if (shouldInitiate) sendOffer(p.socketId);
    }

    // Players initiate connections to spectators
    if (!_isSpectator) {
      var specList = Object.values(spectators);
      for (var j = 0; j < specList.length; j++) {
        var s = specList[j];
        if (s.socketId === socket.id) continue;
        if (_peers[s.socketId]) continue;
        createPeer(s.socketId, null, true);
        sendOffer(s.socketId);
      }
    }

    // Notify controller
    if (_config && _config.onPlayersChanged) {
      _config.onPlayersChanged(data);
    }
  }

  // -- WebRTC multi-peer mesh ------------------------------------------------

  function createPeer(remoteSid, remoteSlot, isInitiator) {
    var peer = {
      pc: new RTCPeerConnection({ iceServers: ICE_SERVERS }),
      dc: null,
      slot: remoteSlot,
      pendingCandidates: [],
      remoteDescSet: false,
      ready: false,
      emuReady: false,
      rttSamples: [],
    };

    peer.pc.onicecandidate = function (e) {
      if (e.candidate && _peers[remoteSid] === peer) {
        socket.emit('webrtc-signal', { target: remoteSid, candidate: e.candidate });
      }
    };

    peer.pc.onconnectionstatechange = function () {
      var s = peer.pc.connectionState;
      console.log('[lockstep] peer', remoteSid, 'connection-state:', s);
      if (s === 'connecting') setStatus('Connecting...');
      if (s === 'connected') {
        // Clear any pending disconnect grace timer — connection recovered
        if (peer._disconnectTimer) {
          clearTimeout(peer._disconnectTimer);
          peer._disconnectTimer = null;
          console.log('[lockstep] peer', remoteSid, 'reconnected (ICE recovery)');
          setStatus('Connected -- game on!');
          // Reset sync backoff so next desync check happens within ~1s
          // (connection hiccup likely caused a desync — don't wait 30s)
          _consecutiveResyncs = 0;
          _syncCheckInterval = _syncBaseInterval;
        }
      }
      if (s === 'failed') {
        // Failed is terminal — disconnect immediately
        if (peer._disconnectTimer) { clearTimeout(peer._disconnectTimer); peer._disconnectTimer = null; }
        if (_peers[remoteSid] !== peer) return;
        setStatus('Peer connection failed');
        handlePeerDisconnect(remoteSid);
      }
      if (s === 'disconnected') {
        // Disconnected is recoverable — give ICE time to reconnect (mobile-friendly)
        if (_peers[remoteSid] !== peer) return;
        if (!peer._disconnectTimer) {
          setStatus('Peer connection unstable...');
          peer._disconnectTimer = setTimeout(function () {
            peer._disconnectTimer = null;
            // Still disconnected or failed after grace period — give up
            var currentState = peer.pc.connectionState;
            if (currentState === 'disconnected' || currentState === 'failed') {
              console.log('[lockstep] peer', remoteSid, 'disconnect grace expired (was', currentState, ')');
              if (_peers[remoteSid] !== peer) return;
              setStatus('Peer connection lost');
              handlePeerDisconnect(remoteSid);
            }
          }, 7000);
        }
      }
    };

    // Spectators: listen for incoming video tracks from host
    if (_isSpectator || (remoteSlot === 0 && _playerSlot === null)) {
      peer.pc.ontrack = function (event) {
        console.log('[lockstep] received track:', event.track.kind);
        showSpectatorVideo(event, peer);
      };
    }

    _peers[remoteSid] = peer;
    window._peers = _peers;

    if (isInitiator) {
      peer.dc = peer.pc.createDataChannel('lockstep', {
        ordered: true,
      });
      setupDataChannel(remoteSid, peer.dc);
      // Delegate non-lockstep channels created by remote
      peer.pc.ondatachannel = function (e) {
        if (e.channel.label === 'lockstep') {
          peer.dc = e.channel;
          setupDataChannel(remoteSid, peer.dc);
        } else if (_onExtraDataChannel) {
          _onExtraDataChannel(remoteSid, e.channel);
        }
      };
    } else {
      peer.pc.ondatachannel = function (e) {
        if (e.channel.label === 'lockstep') {
          peer.dc = e.channel;
          setupDataChannel(remoteSid, peer.dc);
        } else if (_onExtraDataChannel) {
          _onExtraDataChannel(remoteSid, e.channel);
        }
      };
    }
    return peer;
  }

  async function sendOffer(remoteSid) {
    var peer = _peers[remoteSid];
    if (!peer) return;
    var offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { target: remoteSid, offer: offer });
  }

  async function onWebRTCSignal(data) {
    if (!data) return;
    var senderSid = data.sender;
    if (!senderSid) return;

    // Create peer on demand if offer arrives before users-updated
    if (data.offer && !_peers[senderSid]) {
      var known = _knownPlayers[senderSid];
      createPeer(senderSid, known ? known.slot : null, false);
    }

    var peer = _peers[senderSid];
    if (!peer) return;

    try {
      if (data.offer) {
        // Reconnect: if peer exists and reconnect flag set, replace old PC
        if (data.reconnect && _peers[senderSid]) {
          var existingPeer = _peers[senderSid];
          console.log('[lockstep] received reconnect offer from', senderSid);

          // Detach old PC
          if (existingPeer.pc) {
            existingPeer.pc.onconnectionstatechange = null;
            existingPeer.pc.ondatachannel = null;
            existingPeer.pc.onicecandidate = null;
            existingPeer.pc.ontrack = null;
            try { existingPeer.pc.close(); } catch (_) {}
          }

          // Create new PC on existing peer object (preserve slot, input state)
          existingPeer.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
          existingPeer.pendingCandidates = [];
          existingPeer.remoteDescSet = false;
          existingPeer.ready = false;

          existingPeer.pc.onicecandidate = function (e) {
            if (e.candidate && _peers[senderSid] === existingPeer) {
              socket.emit('webrtc-signal', { target: senderSid, candidate: e.candidate });
            }
          };
          existingPeer.pc.onconnectionstatechange = function () {
            var s = existingPeer.pc.connectionState;
            console.log('[lockstep] reconnect peer', senderSid, 'connection-state:', s);
          };
          existingPeer.pc.ondatachannel = function (e) {
            if (e.channel.label === 'lockstep') {
              existingPeer.dc = e.channel;
              setupDataChannel(senderSid, existingPeer.dc);
            } else if (_onExtraDataChannel) {
              _onExtraDataChannel(senderSid, e.channel);
            }
          };

          peer = existingPeer;
        }

        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await drainCandidates(peer);
        var answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        socket.emit('webrtc-signal', { target: senderSid, answer: answer });

      } else if (data.answer) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await drainCandidates(peer);

      } else if (data.candidate) {
        if (peer.remoteDescSet) {
          try { await peer.pc.addIceCandidate(data.candidate); } catch (_) {}
        } else {
          peer.pendingCandidates.push(data.candidate);
        }
      }
    } catch (err) {
      console.log('[lockstep] WebRTC signal error:', err.message || err);
      setStatus('WebRTC error: ' + (err.message || err));
    }
  }

  async function drainCandidates(peer) {
    peer.remoteDescSet = true;
    for (var i = 0; i < peer.pendingCandidates.length; i++) {
      try { await peer.pc.addIceCandidate(peer.pendingCandidates[i]); } catch (_) {}
    }
    peer.pendingCandidates = [];
  }

  // -- Data channel ----------------------------------------------------------

  function setupDataChannel(remoteSid, ch) {
    ch.binaryType = 'arraybuffer';

    ch.onopen = function () {
      var peer = _peers[remoteSid];
      if (!peer) return;
      var known = _knownPlayers[remoteSid];
      var peerName = known ? known.playerName : 'P' + ((peer.slot || 0) + 1);
      console.log('[lockstep] DC open with', remoteSid, 'slot:', peer.slot, peerName);
      setStatus('Connected to ' + peerName);
      peer.ready = true;
      ch.send('ready');

      if (_selfEmuReady) ch.send('emu-ready');

      // Both sides measure RTT for auto delay
      startRttMeasurement(peer);

      // Late join: if game is running, host starts spectator stream for new spectator
      if (_running && _playerSlot === 0 && peer.slot === null) {
        startSpectatorStreamForPeer(remoteSid);
      }

      // If this is a reconnect, clear reconnecting state and resync
      if (peer.reconnecting) {
        if (peer._reconnectTimeout) { clearTimeout(peer._reconnectTimeout); peer._reconnectTimeout = null; }
        peer.reconnecting = false;
        var rKnown = _knownPlayers[remoteSid];
        var rName = rKnown ? rKnown.playerName : 'P' + ((peer.slot || 0) + 1);
        setStatus(rName + ' reconnected');
        if (_config && _config.onToast) _config.onToast(rName + ' reconnected');
        if (_config && _config.onReconnecting) _config.onReconnecting(remoteSid, false);
        if (_config && _config.onPeerReconnected) _config.onPeerReconnected(remoteSid);
        // Request resync
        if (_playerSlot !== 0) {
          try { ch.send('sync-request'); } catch (_) {}
        } else {
          _consecutiveResyncs = 0;
          _syncCheckInterval = _syncBaseInterval;
        }
      }

      if (!_gameStarted) startGameSequence();
    };

    ch.onclose = function () {
      // Guard: ignore stale close events from replaced peers after restart
      var current = _peers[remoteSid];
      if (!current || current.dc !== ch) return;
      console.log('[lockstep] DC closed with', remoteSid);
      handlePeerDisconnect(remoteSid);
    };

    ch.onerror = function (e) {
      console.log('[lockstep] DC error:', remoteSid, e);
    };

    ch.onmessage = function (e) {
      var peer = _peers[remoteSid];
      if (!peer) return;

      // String messages
      if (typeof e.data === 'string') {
        if (e.data === 'ready')     { peer.ready = true; }
        if (e.data === 'emu-ready') { peer.emuReady = true; checkAllEmuReady(); }
        if (e.data === 'leaving') {
          peer._intentionalLeave = true;
          return;
        }
        if (e.data === 'peer-resumed') {
          var known = _knownPlayers[remoteSid];
          var name = known ? known.playerName : 'P' + ((peer.slot || 0) + 1);
          if (_config && _config.onToast) _config.onToast(name + ' returned');
          return;
        }
        // State sync: hash check from host
        // IMPORTANT: only compare when we're at the SAME frame as the host.
        // Comparing at different frames always shows a diff (not a real desync).
        if (e.data.startsWith('sync-hash:')) {
          // Star topology: only accept sync-hash from host (slot 0)
          if (peer.slot !== 0) return;
          // Don't compare while a resync is already pending (prevents delta base drift)
          if (_pendingResyncState) return;
          var parts = e.data.split(':');
          var syncFrame = parseInt(parts[1], 10);
          var hostHash = parseInt(parts[2], 10);
          var frameDiff = _frameNum - syncFrame;
          if (_frameNum === syncFrame || (_frameNum > syncFrame && frameDiff <= 2)) {
            console.log('[lockstep] sync check received: hostFrame=' + syncFrame +
              ' myFrame=' + _frameNum + ' (diff=' + frameDiff + ') — comparing');
            // Hash directly from HEAPU8 (RDRAM) — avoids expensive getState()
            try {
              var guestBytes = getHashBytes();
              if (!guestBytes) return;
              var peerRef = peer;
              workerPost({ type: 'hash', data: guestBytes }).then(function (res) {
                if (res.hash !== hostHash) {
                  var msg = 'DESYNC frame=' + syncFrame + ' local=' + res.hash + ' host=' + hostHash;
                  console.log('[lockstep] ' + msg);
                  _streamSync(msg);
                  // Request resync with 10s cooldown — constant resyncs freeze
                  // the game (loadState blocks main thread on mobile)
                  var now2 = performance.now();
                  if (!_pendingResyncState && now2 - _lastResyncTime > 10000) {
                    _lastResyncTime = now2;
                    try { peerRef.dc.send('sync-request'); } catch (_) {}
                    _streamSync('sync-request sent');
                  }
                } else {
                  var msg2 = 'sync OK frame=' + syncFrame + ' hash=' + res.hash;
                  console.log('[lockstep] ' + msg2);
                  _streamSync(msg2);
                  _consecutiveResyncs = 0;
                  _syncCheckInterval = _syncBaseInterval;
                }
              }).catch(function () {});
            } catch (_) {}
          } else if (_frameNum < syncFrame) {
            console.log('[lockstep] sync check deferred: hostFrame=' + syncFrame +
              ' myFrame=' + _frameNum + ' (behind by ' + (syncFrame - _frameNum) + ')');
            _pendingSyncCheck = { frame: syncFrame, hash: hostHash, peerSid: remoteSid };
          } else {
            console.log('[lockstep] sync check skipped: hostFrame=' + syncFrame +
              ' myFrame=' + _frameNum + ' (ahead by ' + frameDiff + ')');
          }
        }
        // State sync: host received request, or chunked binary transfer header
        if (e.data === 'sync-request' && _playerSlot === 0) {
          pushSyncState(remoteSid);
        }
        if (e.data.startsWith('sync-start:')) {
          var parts = e.data.split(':');
          _syncFrame = parseInt(parts[1], 10);
          _syncExpected = parseInt(parts[2], 10);
          _syncIsFull = parts[3] === '1';
          _syncChunks = [];
        }
        // JSON messages
        if (e.data.charAt(0) === '{') {
          try {
            var msg = JSON.parse(e.data);
            if (msg.type === 'save-state')      handleSaveStateMsg(msg);
            else if (msg.type === 'late-join-state')  handleLateJoinState(msg);
            else if (msg.type === 'delay-ping') {
              peer.dc.send(JSON.stringify({ type: 'delay-pong', ts: msg.ts }));
            }
            else if (msg.type === 'delay-pong') {
              handleDelayPong(msg.ts, peer);
            }
            else if (msg.type === 'lockstep-ready') {
              peer.delayValue = msg.delay || 2;
              _lockstepReadyPeers[remoteSid] = true;
              checkAllLockstepReady();
            }
            else if (_onUnhandledMessage) {
              _onUnhandledMessage(remoteSid, msg);
            }
          } catch (_) {}
        }
        return;
      }

      // Binary: sync state chunk or input (8 bytes).
      // Sync chunks only arrive between sync-start and completion (_syncExpected > 0).
      if (e.data instanceof ArrayBuffer && e.data.byteLength !== 8 && _syncExpected > 0) {
        _syncChunks.push(new Uint8Array(e.data));
        if (_syncChunks.length >= _syncExpected) {
          handleSyncChunksComplete();
        }
        return;
      }
      // Binary: Int32Array [frame, inputMask] -- 8 bytes per input
      if (e.data instanceof ArrayBuffer && e.data.byteLength === 8) {
        if (peer.slot === null || peer.slot === undefined) return;  // spectators don't send input
        var arr = new Int32Array(e.data);
        if (!_remoteInputs[peer.slot]) _remoteInputs[peer.slot] = {};
        _remoteInputs[peer.slot][arr[0]] = arr[1];
        if (!_peerInputStarted[peer.slot]) _peerInputStarted[peer.slot] = true;
        _remoteReceived++;
        if (arr[0] > _lastRemoteFrame) _lastRemoteFrame = arr[0];
        if (!_lastRemoteFramePerSlot[peer.slot] || arr[0] > _lastRemoteFramePerSlot[peer.slot]) {
          _lastRemoteFramePerSlot[peer.slot] = arr[0];
        }
      }
    };
  }

  // -- Peer disconnect (drop handling) ---------------------------------------

  function handlePeerDisconnect(remoteSid) {
    var peer = _peers[remoteSid];
    if (!peer) return;
    if (peer._disconnectTimer) { clearTimeout(peer._disconnectTimer); peer._disconnectTimer = null; }

    // If game is running and not an intentional leave, attempt reconnect
    if (_running && !peer._intentionalLeave) {
      console.log('[lockstep] peer', remoteSid, 'DC died — attempting reconnect');

      // Zero their input but keep peer in _peers
      if (peer.slot !== null && peer.slot !== undefined) {
        try { writeInputToMemory(peer.slot, 0); } catch (_) {}
      }
      peer.reconnecting = true;
      peer.reconnectStart = Date.now();

      var known = _knownPlayers[remoteSid];
      var name = known ? known.playerName : 'P' + ((peer.slot || 0) + 1);
      setStatus(name + ' disconnected — reconnecting...');
      if (_config && _config.onToast) _config.onToast(name + ' disconnected — reconnecting...');
      if (_config && _config.onReconnecting) _config.onReconnecting(remoteSid, true);

      // Lower slot initiates reconnect
      if (_playerSlot < peer.slot) {
        attemptReconnect(remoteSid);
      }

      // 15-second timeout — give up and hard disconnect
      peer._reconnectTimeout = setTimeout(function () {
        if (!_peers[remoteSid] || !_peers[remoteSid].reconnecting) return;
        console.log('[lockstep] reconnect timeout for', remoteSid);
        hardDisconnectPeer(remoteSid);
      }, 15000);

      return;
    }

    hardDisconnectPeer(remoteSid);
  }

  function hardDisconnectPeer(remoteSid) {
    var peer = _peers[remoteSid];
    if (!peer) return;
    if (peer._reconnectTimeout) { clearTimeout(peer._reconnectTimeout); peer._reconnectTimeout = null; }

    if (peer.slot !== null && peer.slot !== undefined) {
      try { writeInputToMemory(peer.slot, 0); } catch (_) {}
      delete _remoteInputs[peer.slot];
      delete _peerInputStarted[peer.slot];
    }

    delete _peers[remoteSid];
    delete _lockstepReadyPeers[remoteSid];
    window._peers = _peers;
    console.log('[lockstep] peer hard-disconnected:', remoteSid, 'slot:', peer.slot);

    var known = _knownPlayers[remoteSid];
    var name = known ? known.playerName : 'P' + ((peer.slot || 0) + 1);

    var remaining = getActivePeers();
    if (remaining.length === 0 && _running) {
      setStatus('All peers disconnected -- running solo');
    } else if (_running) {
      var count = remaining.length + 1;
      setStatus(name + ' dropped -- ' + count + ' player' + (count > 1 ? 's' : '') + ' remaining');
    }
    if (_config && _config.onToast) _config.onToast(name + ' dropped');
    if (_config && _config.onReconnecting) _config.onReconnecting(remoteSid, false);
  }

  function attemptReconnect(remoteSid) {
    var peer = _peers[remoteSid];
    if (!peer || !peer.reconnecting) return;

    console.log('[lockstep] initiating reconnect to', remoteSid);

    // Detach old PC handlers to prevent stale events
    if (peer.pc) {
      peer.pc.onconnectionstatechange = null;
      peer.pc.ondatachannel = null;
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      try { peer.pc.close(); } catch (_) {}
    }

    // Create new PeerConnection
    peer.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peer.pendingCandidates = [];
    peer.remoteDescSet = false;
    peer.ready = false;

    peer.pc.onicecandidate = function (e) {
      if (e.candidate && _peers[remoteSid] === peer) {
        socket.emit('webrtc-signal', { target: remoteSid, candidate: e.candidate });
      }
    };

    peer.pc.onconnectionstatechange = function () {
      var s = peer.pc.connectionState;
      console.log('[lockstep] reconnect peer', remoteSid, 'connection-state:', s);
      if (s === 'failed') {
        console.log('[lockstep] reconnect PC failed for', remoteSid);
        hardDisconnectPeer(remoteSid);
      }
    };

    peer.pc.ondatachannel = function (e) {
      if (e.channel.label === 'lockstep') {
        peer.dc = e.channel;
        setupDataChannel(remoteSid, peer.dc);
      } else if (_onExtraDataChannel) {
        _onExtraDataChannel(remoteSid, e.channel);
      }
    };

    // Create new DC and send offer
    peer.dc = peer.pc.createDataChannel('lockstep', { ordered: true });
    setupDataChannel(remoteSid, peer.dc);

    peer.pc.createOffer().then(function (offer) {
      return peer.pc.setLocalDescription(offer);
    }).then(function () {
      socket.emit('webrtc-signal', {
        target: remoteSid,
        offer: peer.pc.localDescription,
        reconnect: true,
      });
    }).catch(function (err) {
      console.log('[lockstep] reconnect offer failed:', err);
      hardDisconnectPeer(remoteSid);
    });
  }

  // -- Helper: get active player peers ---------------------------------------

  // All connected player peers (for sending input to)
  function getActivePeers() {
    return Object.values(_peers).filter((p) =>
      p.slot !== null && p.slot !== undefined
        && p.dc && p.dc.readyState === 'open'
    );
  }

  // Wait for all active peers that have started sending input.
  // Peers with open data channels who haven't sent any input yet (e.g.
  // late-joiners still booting) are excluded so they don't stall the game.
  // Once a peer sends their first input, they're included and the game
  // waits for them on every frame (Kaillera-style strict lockstep).
  // Uses _peerInputStarted (persistent flag) instead of checking buffer
  // length — prevents peers from dropping out when their buffer is
  // momentarily empty between frames (causes 3+ player desync).
  function getInputPeers() {
    return getActivePeers().filter((p) =>
      _peerInputStarted[p.slot] && !p.reconnecting
    );
  }

  // -- Game start sequence ---------------------------------------------------

  // Minimum frames the emulator must run before we consider it ready.
  const MIN_BOOT_FRAMES = 120;  // ~2 seconds at 60fps

  function startGameSequence() {
    if (_gameStarted) return;
    _gameStarted = true;

    // Spectators: don't start emulator, don't enter manual mode
    if (_isSpectator) {
      setStatus('Spectating...');
      return;
    }

    setStatus('Starting emulator...');
    KNShared.triggerEmulatorStart();
    KNShared.applyStandardCheats(KNShared.SSB64_ONLINE_CHEATS);
    disableEJSInput();

    // Wait for gameManager AND for the emulator to be ready.
    // Host: waits for MIN_BOOT_FRAMES (needs a fully booted emulator to capture state).
    // Guest: only waits for Module to exist (will load host's state, no independent boot).
    // This prevents boot frame count differences that cause desync.
    var _bootStatusCount = 0;
    var waitForEmu = function () {
      var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) {
        _bootStatusCount++;
        if (_bootStatusCount % 10 === 0) setStatus('Loading emulator...');
        setTimeout(waitForEmu, 100);
        return;
      }

      var mod = gm.Module;
      var frames = mod && mod._get_current_frame_count
        ? mod._get_current_frame_count() : 0;

      if (_playerSlot === 0 && frames < MIN_BOOT_FRAMES) {
        // Host: needs full boot to capture a valid state
        if (_bootStatusCount++ % 5 === 0) setStatus('Booting emulator... (' + frames + '/' + MIN_BOOT_FRAMES + ')');
        setTimeout(waitForEmu, 100);
        return;
      }
      if (_playerSlot !== 0 && !mod._simulate_input) {
        // Guest: just needs Module initialized (will load host's state).
        // Don't wait for frame count — _get_current_frame_count may not
        // exist if the CDN core loaded instead of our patched core.
        if (_bootStatusCount++ % 5 === 0) setStatus('Booting emulator...');
        setTimeout(waitForEmu, 100);
        return;
      }

      // Auto-discover INPUT_BASE by calling _simulate_input and detecting the change
      if (mod._simulate_input) {
        try {
          // Reset button 0 for player 0
          mod._simulate_input(0, 0, 0);
          var scanEnd = Math.min(mod.HEAPU8.length, 4 * 1024 * 1024);
          var snap = new Uint8Array(mod.HEAPU8.buffer.slice(0, scanEnd));
          mod._simulate_input(0, 0, 1);
          for (var si = 0; si < scanEnd; si++) {
            if (mod.HEAPU8[si] !== snap[si]) {
              INPUT_BASE = si;
              break;
            }
          }
          mod._simulate_input(0, 0, 0);
          console.log('[lockstep] INPUT_BASE auto-discovered: ' + INPUT_BASE);

          // Discover per-player input base addresses (button 0 address for each player)
          // This replaces the old per-button scan which only covered player 0.
          var scanRange = 8 * 1024 * 1024; // 8MB scan window
          var scanLen = Math.min(mod.HEAPU8.length, scanRange);
          for (var pi = 0; pi < 4; pi++) {
            mod._simulate_input(pi, 0, 0);
            var pSnap = new Uint8Array(mod.HEAPU8.buffer.slice(0, scanLen));
            mod._simulate_input(pi, 0, 1);
            for (var psi = 0; psi < scanLen; psi++) {
              if (mod.HEAPU8[psi] !== pSnap[psi]) {
                _diagPlayerAddrs[pi] = psi;
                break;
              }
            }
            mod._simulate_input(pi, 0, 0);
          }
          console.log('[lockstep] per-player input addrs: ' + JSON.stringify(_diagPlayerAddrs));
          _streamSync('DIAG-ADDRS ' + JSON.stringify(_diagPlayerAddrs));
        } catch (e) {
          console.log('[lockstep] INPUT_BASE auto-discovery failed, using default: ' + INPUT_BASE);
        }
      }

      // Pause immediately to prevent any more free frames
      mod.pauseMainLoop();
      console.log('[lockstep] emulator ready (' + frames + ' frames) — paused' +
        (_playerSlot === 0 ? ' (host, full boot)' : ' (guest, minimal boot)'));

      // Set up key tracking now that ejs.controls is available
      _p1KeyMap = null;  // force re-read from EJS controls
      setupKeyTracking();

      _selfEmuReady = true;
      hookVirtualGamepad();

      // Late join: request state from host instead of normal sync flow.
      // Also trigger if host is already in the lockstep loop (ROM sharing case:
      // player was in room at game start but emulator booted late due to ROM transfer).
      // _lastRemoteFrame > 0 means we've received actual game input = host is running.
      var hostAlreadyRunning = _lastRemoteFrame > 0;
      if ((_lateJoin || hostAlreadyRunning) && _playerSlot !== 0) {
        console.log('[lockstep] using late-join path (lateJoin=' + _lateJoin +
          ', hostRunning=' + hostAlreadyRunning + ')');
        setStatus('Requesting game state...');
        socket.emit('data-message', {
          type: 'request-late-join',
          requesterSid: socket.id,
        });
        return;  // handleLateJoinState() will resume from here
      }

      // Notify all connected peers
      Object.values(_peers).forEach((p) => {
        if (p.dc && p.dc.readyState === 'open') {
          try { p.dc.send('emu-ready'); } catch (_) {}
        }
      });

      checkAllEmuReady();
    };
    waitForEmu();
  }

  function checkAllEmuReady() {
    if (!_selfEmuReady) return;
    if (_isSpectator) return;
    if (_running) return;

    // Wait for ALL player peers to be emu-ready (not just 1)
    var playerPeers = Object.values(_peers).filter((p) =>
      p.slot !== null && p.slot !== undefined
    );
    if (playerPeers.length === 0) return;

    var readyPeers = playerPeers.filter((p) => p.emuReady);
    var notReady = playerPeers.filter((p) => !p.emuReady);

    if (notReady.length > 0) {
      // Show who we're waiting for
      var waiting = notReady.map((p) => {
        var known = _knownPlayers[Object.keys(_peers).find((sid) => _peers[sid] === p)];
        return known ? known.playerName : 'P' + (p.slot + 1);
      });
      setStatus('Waiting for ' + waiting.join(', ') + ' to load... (' + readyPeers.length + '/' + playerPeers.length + ')');
      return;
    }

    console.log('[lockstep] ' + (readyPeers.length + 1) + ' emulators ready -- syncing initial state');
    setStatus('Syncing...');

    if (_playerSlot === 0) {
      // Host: capture and send save state
      sendInitialState();
    }
    // Guests: wait for save state via handleSaveStateMsg

    // Timeout: if sync hasn't completed in 30s, show helpful status
    setTimeout(function () {
      if (!_running && _selfEmuReady && _gameStarted) {
        setStatus('Sync timed out — try reloading the page');
        if (_config && _config.onToast) _config.onToast('Sync stalled — reload to retry');
      }
    }, 30000);
  }

  function checkAllLockstepReady() {
    if (!_selfLockstepReady) return;
    if (_running) return;

    // Check that at least 1 player peer is lockstep-ready
    var playerPeerSids = Object.keys(_peers).filter((sid) => {
      const p = _peers[sid];
      return p.slot !== null && p.slot !== undefined;
    });
    var readyCount = playerPeerSids.filter((sid) => _lockstepReadyPeers[sid]).length;

    if (readyCount < playerPeerSids.length) return;

    // Negotiate delay: ceiling of all players
    var ownDelay = window.getDelayPreference ? window.getDelayPreference() : 2;
    var maxDelay = ownDelay;
    Object.values(_peers).forEach((p) => {
      if (p.delayValue && p.delayValue > maxDelay) maxDelay = p.delayValue;
    });
    DELAY_FRAMES = maxDelay;
    if (window.showEffectiveDelay) window.showEffectiveDelay(ownDelay, maxDelay);
    console.log('[lockstep] delay negotiated: own=' + ownDelay + ' effective=' + maxDelay);

    console.log('[lockstep] ' + (readyCount + 1) + ' players lockstep-ready -- GO');

    var gm = window.EJS_emulator.gameManager;

    // If no state bytes (host fallback), capture current state
    if (!_guestStateBytes) {
      _guestStateBytes = gm.getState();
    }

    // First loadState: fully restores CPU + RAM (needs main loop active)
    gm.loadState(_guestStateBytes);

    // Enter manual mode — captures rAF, stops free frames
    enterManualMode();

    // Second loadState: fixes any free-frame drift between first load
    // and enterManualMode. Both sides now have identical state.
    gm.loadState(_guestStateBytes);
    _guestStateBytes = null;
    console.log('[lockstep] double-loaded state (CPU + free-frame fix)');

    // Both sides reset and start true lockstep sync
    // (Warmup removed — deterministic timing patch makes it unnecessary)
    _frameNum = 0;
    startLockstep();

    // Host: start spectator streaming after lockstep begins
    if (_playerSlot === 0) {
      setTimeout(startSpectatorStream, 1000);
    }
  }

  async function sendInitialState() {
    var gm = window.EJS_emulator.gameManager;
    try {
      var raw = gm.getState();
      var bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      // Store for host to also load (resets GL context for proper rendering)
      _guestStateBytes = bytes;
      var encoded = await compressAndEncode(bytes);
      console.log('[lockstep] sending initial state via Socket.IO (' +
        Math.round(encoded.rawSize / 1024) + 'KB raw -> ' +
        Math.round(encoded.compressedSize / 1024) + 'KB gzip)');

      // Send via Socket.IO -- save state is ~1.5MB which crashes WebRTC
      // data channels (SCTP limit with maxRetransmits).
      socket.emit('data-message', { type: 'save-state', frame: 0, data: encoded.data });

      // Host is ready
      _selfLockstepReady = true;
      if (_rttComplete) {
        broadcastLockstepReady();
      }
      checkAllLockstepReady();
    } catch (err) {
      console.log('[lockstep] failed to send initial state:', err);
    }
  }

  function handleSaveStateMsg(msg) {
    if (_isSpectator) return;
    console.log('[lockstep] received initial state');
    setStatus('Loading initial state...');

    decodeAndDecompress(msg.data).then(function (bytes) {
      _guestStateBytes = bytes;
      console.log('[lockstep] initial state decompressed (' + bytes.length + ' bytes)');

      _selfLockstepReady = true;
      if (_rttComplete) {
        broadcastLockstepReady();
      }
      checkAllLockstepReady();
    }).catch(function (err) {
      console.log('[lockstep] failed to decompress initial state:', err);
    });
  }

  // -- Late join -------------------------------------------------------------

  async function sendLateJoinState(remoteSid) {
    var peer = _peers[remoteSid];
    if (!peer) return;
    if (peer.slot === null || peer.slot === undefined) return;

    var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;

    try {
      var raw = gm.getState();
      var bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      var encoded = await compressAndEncode(bytes);
      console.log('[lockstep] sending late-join state to', remoteSid,
        '(' + Math.round(encoded.rawSize / 1024) + 'KB raw -> ' +
        Math.round(encoded.compressedSize / 1024) + 'KB gzip)',
        'frame:', _frameNum);

      // Send via Socket.IO since save states are too large for DC
      socket.emit('data-message', {
        type: 'late-join-state',
        frame: _frameNum,
        data: encoded.data,
        effectiveDelay: DELAY_FRAMES,
      });
    } catch (err) {
      console.log('[lockstep] failed to send late-join state:', err);
    }
  }

  function handleLateJoinState(msg) {
    if (_isSpectator) return;
    if (_running) return;  // already running, ignore duplicate

    console.log('[lockstep] received late-join state for frame', msg.frame);
    setStatus('Loading late-join state...');

    decodeAndDecompress(msg.data).then(function (bytes) {
      var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
      if (!gm) {
        console.log('[lockstep] gameManager not ready');
        return;
      }

      if (msg.effectiveDelay) {
        DELAY_FRAMES = msg.effectiveDelay;
        console.log('[lockstep] late-join: using room delay ' + DELAY_FRAMES);
      }

      gm.loadState(bytes);
      enterManualMode();

      // Sync to the host's current frame. The host sent the state at msg.frame,
      // but has advanced since then. _lastRemoteFrame tracks the highest frame
      // received via data channel from any peer — use that to catch up.
      // Then pre-fill the delay gap so the tick loop doesn't stall waiting
      // for historical input that was sent before we started lockstep.
      var startFrame = _lastRemoteFrame > msg.frame ? _lastRemoteFrame : msg.frame;
      _frameNum = startFrame;

      for (var f = Math.max(0, startFrame - DELAY_FRAMES); f <= startFrame + DELAY_FRAMES; f++) {
        if (!_localInputs[f]) _localInputs[f] = 0;
        Object.values(_peers).forEach((p) => {
          if (p.slot !== null && p.slot !== undefined) {
            if (!_remoteInputs[p.slot]) _remoteInputs[p.slot] = {};
            if (!_remoteInputs[p.slot][f]) _remoteInputs[p.slot][f] = 0;
          }
        });
      }

      console.log('[lockstep] late-join state loaded at frame', msg.frame,
        'synced to frame', _frameNum, '(lastRemote:', _lastRemoteFrame + ')');
      startLockstep();
    }).catch(function (err) {
      console.log('[lockstep] failed to handle state:', err);
    });
  }

  // -- Guest audio muting + host audio streaming ----------------------------

  // -- Spectator canvas streaming --------------------------------------------

  function startSpectatorStream() {
    if (_playerSlot !== 0) return;

    var canvas = document.querySelector('#game canvas');
    if (!canvas) {
      console.log('[lockstep] canvas not found for spectator stream');
      return;
    }

    // Create a smaller capture canvas for efficiency (same as streaming prototype)
    var captureCanvas = document.createElement('canvas');
    captureCanvas.width = 640;
    captureCanvas.height = 480;
    var ctx = captureCanvas.getContext('2d');

    _hostStream = captureCanvas.captureStream(0);  // manual frame control

    // Add audio track from bypass playback (if available)
    if (_audioDestNode && _audioDestNode.stream) {
      var audioTracks = _audioDestNode.stream.getAudioTracks();
      for (var at = 0; at < audioTracks.length; at++) {
        _hostStream.addTrack(audioTracks[at]);
      }
      console.log('[lockstep] added audio track to spectator stream');
    }

    var captureTrack = _hostStream.getVideoTracks()[0];

    // Blit loop: copy emulator canvas to capture canvas every frame
    function blitFrame() {
      if (!_origRAF) return;  // stopped
      _origRAF.call(window, blitFrame);
      ctx.drawImage(canvas, 0, 0, 640, 480);
      if (captureTrack.requestFrame) captureTrack.requestFrame();
    }
    blitFrame();

    console.log('[lockstep] spectator capture stream started (640x480)');

    // Add tracks to all existing spectator peer connections
    Object.entries(_peers).forEach(([sid, peer]) => {
      if (peer.slot === null) {
        addStreamToPeer(sid);
      }
    });
  }

  function startSpectatorStreamForPeer(remoteSid) {
    if (!_hostStream) {
      // Stream not started yet -- it will be started after lockstep begins
      // and will pick up this peer then
      return;
    }
    addStreamToPeer(remoteSid);
  }

  function addStreamToPeer(remoteSid) {
    var peer = _peers[remoteSid];
    if (!peer || !_hostStream) return;

    _hostStream.getTracks().forEach((track) => {
      peer.pc.addTrack(track, _hostStream);
    });
    renegotiate(remoteSid);
  }

  async function renegotiate(remoteSid) {
    var peer = _peers[remoteSid];
    if (!peer) return;
    try {
      var offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      socket.emit('webrtc-signal', { target: remoteSid, offer: offer });
    } catch (err) {
      console.log('[lockstep] renegotiate failed:', err);
    }
  }

  function showSpectatorVideo(event, peer) {
    if (!_guestVideo) {
      _guestVideo = document.createElement('video');
      _guestVideo.id = 'guest-video';
      _guestVideo.autoplay = true;
      _guestVideo.playsInline = true;
      _guestVideo.muted = false;
      _guestVideo.disableRemotePlayback = true;
      _guestVideo.setAttribute('playsinline', '');

      var gameDiv = (_config && _config.gameElement) || document.getElementById('game');
      if (gameDiv) {
        gameDiv.innerHTML = '';
        gameDiv.appendChild(_guestVideo);
      } else {
        document.body.appendChild(_guestVideo);
      }
    }
    _guestVideo.srcObject = event.streams[0];

    // Minimize jitter buffer for low latency
    try {
      var receivers = peer.pc.getReceivers();
      for (var i = 0; i < receivers.length; i++) {
        var recv = receivers[i];
        if (recv.track && recv.track.kind === 'video') {
          if ('playoutDelayHint' in recv) recv.playoutDelayHint = 0;
          if ('jitterBufferTarget' in recv) recv.jitterBufferTarget = 0;
        }
      }
    } catch (_) {}

    setStatus('Spectating...');
  }

  // -- Direct memory input ---------------------------------------------------

  function writeInputToMemory(player, inputMask) {
    var mod = window.EJS_emulator.gameManager.Module;
    if (!mod || !mod._simulate_input) return;

    // Digital buttons (0-15): use _simulate_input for correct address calc
    // (BUTTON_STRIDE assumption only validated for button 0 — higher indices
    // may have different offsets in the WASM core's input_state array)
    for (var btn = 0; btn < 16; btn++) {
      mod._simulate_input(player, btn, (inputMask >> btn) & 1);
    }

    // Analog axes (16-23): bit pairs → ±32767 axis values
    // 16-19: left stick (N64 analog), 20-23: right stick (N64 C-buttons)
    for (var base = 16; base < 24; base += 2) {
      var posPressed = (inputMask >> base) & 1;
      var negPressed = (inputMask >> (base + 1)) & 1;
      var axisVal = (posPressed - negPressed) * 32767;
      mod._simulate_input(player, base, axisVal);
      mod._simulate_input(player, base + 1, 0);
    }
  }

  // -- Frame stepping (rAF interception) -------------------------------------

  function enterManualMode() {
    if (_manualMode) return;
    if (_isSpectator) return;  // spectators never enter manual mode

    var mod = window.EJS_emulator.gameManager.Module;

    // Save the real requestAnimationFrame
    _origRAF = window.requestAnimationFrame;

    // Pause first to invalidate stale runners
    mod.pauseMainLoop();

    // Replace rAF with interceptor that captures the runner
    window.requestAnimationFrame = function (cb) {
      _pendingRunner = cb;
      return -999;
    };

    // Resume to capture fresh runner
    mod.resumeMainLoop();

    _manualMode = true;
    console.log('[lockstep] entered manual mode');
  }

  let _hasForkedCore = false;  // true if Module exports kn_set_deterministic

  function stepOneFrame() {
    if (!_pendingRunner) return false;
    const runner = _pendingRunner;
    _pendingRunner = null;

    const frameTimeMs = (_frameNum + 1) * 16.666666666666668;
    window._kn_frameTime = frameTimeMs;

    // On first lockstep frame, switch from flat time to relative cycle counter.
    // Captures current cycle count as baseline — subtracts transition divergence.
    if (_hasForkedCore && !window._kn_useRelativeCycles && _frameNum === 0) {
      const cycleModule = window.EJS_emulator && window.EJS_emulator.gameManager &&
                          window.EJS_emulator.gameManager.Module;
      if (cycleModule && cycleModule._kn_get_cycle_time_ms) {
        window._kn_cycleStart = cycleModule._kn_get_cycle_time_ms();
        window._kn_cycleBase = frameTimeMs;
        window._kn_useRelativeCycles = true;
        console.log('[lockstep] switched to relative cycle counter at',
          window._kn_cycleStart.toFixed(1) + 'ms');
      }
    }

    // C-level: always update frame time (kn_deterministic_mode stays ON)
    if (_hasForkedCore) {
      const frameModule = window.EJS_emulator && window.EJS_emulator.gameManager &&
                          window.EJS_emulator.gameManager.Module;
      if (frameModule && frameModule._kn_set_frame_time) {
        frameModule._kn_set_frame_time(frameTimeMs);
      }
    }

    runner(frameTimeMs);

    // Force GL composite via real rAF no-op
    if (_origRAF) _origRAF.call(window, () => {});
    return true;
  }

  // -- True lockstep tick loop -----------------------------------------------
  //
  // Strategy: setInterval(tick, 16) for ~60fps. We never use rAF for the
  // game loop (background tabs would throttle it). Each tick:
  //   1. Send local input for current frame to ALL peers
  //   2. Check if ALL active player peers have input for the apply frame
  //   3. If not, stall (return early, retry via setTimeout(1))
  //   4. Write ALL players' inputs to Wasm memory
  //   5. Step exactly one frame
  //   6. Increment frame counter

  // FPS + debug tracking
  let _fpsLastTime     = 0;
  let _fpsFrameCount   = 0;
  let _fpsCurrent      = 0;
  let _remoteReceived  = 0;
  let _remoteMissed    = 0;
  let _remoteApplied   = 0;
  let _lastRemoteFrame = -1;
  let _lastRemoteFramePerSlot = {};  // slot -> highest frame received from that peer
  let _stallRetryPending = false;

  function startLockstep() {
    if (_running) return;
    _running = true;

    // Detect forked core with C-level deterministic timing exports
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    _hasForkedCore = !!(mod && mod._kn_set_deterministic && mod._kn_set_frame_time);
    if (_hasForkedCore) {
      console.log('[lockstep] forked core detected — C-level deterministic timing');
    } else {
      console.log('[lockstep] stock core — JS-level timing patch (fallback)');
    }

    // Only reset frame counter if not a late join (late join sets _frameNum before calling)
    if (_frameNum === 0) {
      _localInputs = {};
      _remoteInputs = {};
      _peerInputStarted = {};
    }
    _fpsLastTime = performance.now();
    _fpsFrameCount = 0;
    _fpsCurrent = 0;
    _remoteReceived = 0;
    _remoteMissed = 0;
    _remoteApplied = 0;
    _lastRemoteFrame = -1;
    _lastRemoteFramePerSlot = {};
    _stallStart = 0;
    window._netplayFrameLog = [];

    // Always frozen time — audio plays via bypass, not OpenAL
    window._kn_inStep = true;
    window._kn_frameTime = 0;
    if (_hasForkedCore) {
      var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
                window.EJS_emulator.gameManager.Module;
      if (mod && mod._kn_set_deterministic) {
        mod._kn_set_deterministic(1);
        console.log('[lockstep] C-level deterministic timing enabled (session-wide)');
      }

      // Override performance.now() during WASM frame steps for COMPLETE timing
      // determinism. Emscripten's _emscripten_get_now calls performance.now()
      // internally, and it's captured in a closure we can't override from outside.
      // By overriding performance.now() itself, we catch ALL timing — clock_gettime,
      // gettimeofday, emscripten_get_now, etc. The override only activates during
      // stepOneFrame() (gated by _inDeterministicStep) so lockstep JS code
      // (stall detection, FPS) still gets real time.
      if (mod && mod._kn_get_cycle_time_ms) {
        var _origPerfNow = performance.now.bind(performance);
        _deterministicPerfNow = function () {
          if (_inDeterministicStep) {
            var m = window.EJS_emulator && window.EJS_emulator.gameManager &&
                    window.EJS_emulator.gameManager.Module;
            if (m && m._kn_get_cycle_time_ms) return m._kn_get_cycle_time_ms();
          }
          return _origPerfNow();
        };
        performance.now = _deterministicPerfNow;
        console.log('[lockstep] performance.now() intercepted for deterministic frame steps');
      }
    }

    // Neutralize fast-forward / slow-motion WASM functions.
    // EmulatorJS mobile virtual gamepad has "slow" and "fast" buttons that call
    // _toggle_fastforward / _toggle_slow_motion directly. These set RetroArch
    // runloop flags (RUNLOOP_FLAG_FASTMOTION / RUNLOOP_FLAG_SLOWMOTION) which
    // alter internal frame timing and cause desyncs between players.
    if (mod && mod._toggle_fastforward && !_origToggleFF) {
      _origToggleFF = mod._toggle_fastforward;
      _origToggleSM = mod._toggle_slow_motion;
      // Force both off in case a player already toggled them before lockstep
      mod._toggle_fastforward(0);
      mod._toggle_slow_motion(0);
      mod._toggle_fastforward = function () {};
      mod._toggle_slow_motion = function () {};
      console.log('[lockstep] neutralized fast-forward/slow-motion controls');
    }

    // Kill OpenAL's audio system. An active AudioContext + AL_PLAYING source
    // causes desyncs even with frozen _emscripten_get_now. Stop all sources
    // and suspend the AudioContext to eliminate all async audio activity.
    var mod2 = window.EJS_emulator && window.EJS_emulator.gameManager &&
               window.EJS_emulator.gameManager.Module;
    if (mod2 && mod2.AL && mod2.AL.contexts) {
      Object.keys(mod2.AL.contexts).forEach((id) => {
        const ctx = mod2.AL.contexts[id];
        if (!ctx) return;
        // Stop all sources (AL_PLAYING 0x1012 -> AL_STOPPED 0x1014)
        if (ctx.sources) {
          Object.keys(ctx.sources).forEach((sid) => {
            const src = ctx.sources[sid];
            if (src && src.state === 0x1012) {
              mod2.AL.setSourceState(src, 0x1014);
            }
          });
        }
        // Suspend the AudioContext and prevent browser from auto-resuming
        // it on user gestures by overriding resume() to be a no-op.
        if (ctx.audioCtx) {
          ctx.audioCtx.suspend();
          ctx.audioCtx.resume = () => Promise.resolve();
        }
        console.log('[lockstep] killed OpenAL audio system (context ' + id + ')');
      });
    }

    initAudioPlayback();
    _diagInstallHooks();

    // DIAG: one-time startup banner for log self-description
    var ua = navigator.userAgent;
    var engine = /Firefox/.test(ua) ? 'SpiderMonkey' : /Chrome/.test(ua) ? 'V8' :
                 /Safari/.test(ua) ? 'JSC' : 'unknown';
    var isMobile = /Mobile|Android|iPhone|iPad/.test(ua);
    _streamSync('DIAG-START slot=' + _playerSlot + ' engine=' + engine +
      ' mobile=' + isMobile + ' forkedCore=' + _hasForkedCore +
      ' ua=' + ua.substring(0, 120));

    var activePeers = getActivePeers();
    var peerSlots = activePeers.map((p) => p.slot);
    console.log('[lockstep] lockstep started -- slot:', _playerSlot,
      'peerSlots:', peerSlots.join(','), 'delay:', DELAY_FRAMES);
    setStatus('Connected -- game on!');

    window._lockstepActive = true;

    // Background tab handling: do NOT pause the tick loop. Browser naturally
    // throttles setInterval to ~1fps in background tabs, which keeps the
    // player sending input (slowly). Pausing completely breaks multi-tab
    // setups where one tab is always document.hidden.
    //
    // On return to foreground: fast-forward frame counter to catch up with
    // peers, then resync emulator state from host.
    var _backgroundAt = 0;
    document.addEventListener('visibilitychange', function () {
      if (!_running) return;
      if (document.hidden) {
        _backgroundAt = Date.now();
        console.log('[lockstep] tab hidden at frame', _frameNum);
      } else {
        var bgDuration = _backgroundAt ? Date.now() - _backgroundAt : 0;
        _backgroundAt = 0;
        console.log('[lockstep] tab visible (was background', bgDuration, 'ms)');

        // Short background (<500ms): no action needed
        if (bgDuration < 500) return;

        // Notify peers we returned (toast only, no gameplay effect)
        var activePeers2 = getActivePeers();
        for (var r = 0; r < activePeers2.length; r++) {
          try { activePeers2[r].dc.send('peer-resumed'); } catch (_) {}
        }

        // Fast-forward _frameNum to catch up with peers. Background throttling
        // means we fell behind — peers have moved far ahead.
        if (_lastRemoteFrame > _frameNum) {
          console.log('[lockstep] fast-forward:', _frameNum, '->', _lastRemoteFrame);
          _frameNum = _lastRemoteFrame;
          window._frameNum = _frameNum;
          _localInputs = {};
          _remoteInputs = {};
          for (var d = 0; d < DELAY_FRAMES; d++) {
            _localInputs[_frameNum + d] = 0;
          }
        }

        // Request resync (emulator state drifted during background throttling)
        if (_playerSlot === 0) {
          _consecutiveResyncs = 0;
          _syncCheckInterval = _syncBaseInterval;
        } else {
          var hostPeer = Object.values(_peers).find(function (p) { return p.slot === 0; });
          if (hostPeer && hostPeer.dc && hostPeer.dc.readyState === 'open') {
            try { hostPeer.dc.send('sync-request'); } catch (_) {}
          }
        }
      }
    });

    // Use setInterval so background tabs are not throttled
    _tickInterval = setInterval(tick, 16);
  }

  function stopSync() {
    _running = false;
    window._lockstepActive = false;

    // Disable all deterministic timing
    window._kn_inStep = false;
    window._kn_frameTime = 0;
    window._kn_useRelativeCycles = false;
    if (_hasForkedCore) {
      var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
                window.EJS_emulator.gameManager.Module;
      if (mod && mod._kn_set_deterministic) mod._kn_set_deterministic(0);
    }
    // Restore speed-control functions
    if (_origToggleFF) {
      var mod2 = window.EJS_emulator && window.EJS_emulator.gameManager &&
                 window.EJS_emulator.gameManager.Module;
      if (mod2) {
        mod2._toggle_fastforward = _origToggleFF;
        mod2._toggle_slow_motion = _origToggleSM;
      }
      _origToggleFF = null;
      _origToggleSM = null;
    }
    if (_tickInterval !== null) {
      clearInterval(_tickInterval);
      _tickInterval = null;
    }
    // Restore original rAF if we intercepted it
    if (_origRAF) {
      window.requestAnimationFrame = _origRAF;
      _origRAF = null;
    }
    _manualMode = false;
    _pendingRunner = null;
    _pendingSyncCheck = null;
  }

  function tick() {
    if (!_running) return;

    // Async resync: apply buffered state at clean frame boundary
    if (_pendingResyncState) {
      var pending = _pendingResyncState;
      _pendingResyncState = null;
      applySyncState(pending.bytes, pending.frame);
    }

    var activePeers = getActivePeers();

    // FPS counter
    _fpsFrameCount++;
    var now = performance.now();
    if (now - _fpsLastTime >= 1000) {
      _fpsCurrent = _fpsFrameCount;
      _fpsFrameCount = 0;
      _fpsLastTime = now;
    }

    // Send local input for current frame to ALL open peer DCs
    var mask = readLocalInput();
    _localInputs[_frameNum] = mask;
    var buf = new Int32Array([_frameNum, mask]).buffer;
    for (var i = 0; i < activePeers.length; i++) {
      try { activePeers[i].dc.send(buf); } catch (_) {}
    }

    // Check if all INPUT peers (peers who have sent at least 1 input)
    // have input for the apply frame. Late joiners who haven't started
    // sending yet won't stall existing players.
    var inputPeers = getInputPeers();
    var applyFrame = _frameNum - DELAY_FRAMES;
    if (applyFrame >= 0) {
      var allArrived = true;
      for (var j = 0; j < inputPeers.length; j++) {
        var pSlot = inputPeers[j].slot;
        if (!_remoteInputs[pSlot] || _remoteInputs[pSlot][applyFrame] === undefined) {
          allArrived = false;
          break;
        }
      }

      if (!allArrived) {
        // STALL -- remote input not here yet
        if (_stallStart === 0) {
          _stallStart = now;
        }
        if (now - _stallStart >= MAX_STALL_MS) {
          // Timeout -- inject zero input for missing peers to unstick
          console.log('[lockstep] stall timeout at frame', applyFrame,
            '(' + MAX_STALL_MS + 'ms)');
          for (var k = 0; k < inputPeers.length; k++) {
            var s = inputPeers[k].slot;
            if (!_remoteInputs[s]) _remoteInputs[s] = {};
            if (_remoteInputs[s][applyFrame] === undefined) {
              _remoteInputs[s][applyFrame] = 0;
            }
          }
          _stallStart = 0;
        } else {
          _remoteMissed++;
          // Retry quickly via setTimeout(1) to avoid 16ms wait
          if (!_stallRetryPending) {
            _stallRetryPending = true;
            setTimeout(function () {
              _stallRetryPending = false;
              tick();
            }, 1);
          }
          return;
        }
      } else {
        _stallStart = 0;
      }

      // Write ALL inputs to Wasm memory — use inputPeers for peers
      // we're synced with, activePeers for all connected
      writeInputToMemory(_playerSlot, _localInputs[applyFrame] || 0);
      for (var m = 0; m < inputPeers.length; m++) {
        var peerSlot = inputPeers[m].slot;
        var remoteMask = (_remoteInputs[peerSlot] && _remoteInputs[peerSlot][applyFrame]) || 0;
        writeInputToMemory(peerSlot, remoteMask);
        if (_remoteInputs[peerSlot]) delete _remoteInputs[peerSlot][applyFrame];
      }
      // Zero disconnected player slots so loadState() can't restore stale input
      for (var zs = 0; zs < 4; zs++) {
        if (zs === _playerSlot) continue;
        var hasInputPeer = false;
        for (var zi = 0; zi < inputPeers.length; zi++) {
          if (inputPeers[zi].slot === zs) { hasInputPeer = true; break; }
        }
        if (!hasInputPeer) writeInputToMemory(zs, 0);
      }
      _remoteApplied++;

      // Cleanup old local entry
      delete _localInputs[applyFrame];
    }

    // -- DIAG: input read-back (correct per-player addresses) --
    if (applyFrame >= 0) {
      _diagInput(_frameNum, applyFrame);
    }

    // -- DIAG: flush any async events that fired since last tick --
    _diagFlushEvents(_frameNum);

    // Step one frame with audio capture
    var wallBefore = performance.now();
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    if (mod && mod._kn_reset_audio) mod._kn_reset_audio();
    if (mod && mod._kn_canon_fpu_regs) mod._kn_canon_fpu_regs();
    _inDeterministicStep = true;
    stepOneFrame();
    _inDeterministicStep = false;
    feedAudio();
    var wallAfter = performance.now();

    _frameNum++;
    window._frameNum = _frameNum;

    // -- DIAG: timing values (after step, using new _frameNum) --
    _diagTime(_frameNum - 1, wallBefore, wallAfter);
    _diagLastTickTime = wallBefore;

    // -- DIAG: RDRAM hash (after step, captures post-step state) --
    _diagHash(_frameNum - 1);
    _diagDump(_frameNum - 1);

    // Deferred sync check: guest was behind when sync-hash arrived, now caught up.
    // Compare when we reach or pass the target frame (within a small window).
    if (_pendingSyncCheck && _frameNum >= _pendingSyncCheck.frame) {
      // Only compare if we haven't overshot too far (state changes rapidly)
      if (_frameNum - _pendingSyncCheck.frame <= 2) {
        // Hash directly from HEAPU8 (RDRAM) — avoids expensive getState()
        try {
          var deferBytes = getHashBytes();
          if (deferBytes) {
            var deferCheck = _pendingSyncCheck;  // capture before nulling
            workerPost({ type: 'hash', data: deferBytes }).then(function (res) {
              if (res.hash !== deferCheck.hash) {
                console.log('[lockstep] DESYNC (deferred) at frame', deferCheck.frame);
                var now3 = performance.now();
                if (!_pendingResyncState && now3 - _lastResyncTime > 10000) {
                  _lastResyncTime = now3;
                  var sp = _peers[deferCheck.peerSid];
                  if (sp && sp.dc) { try { sp.dc.send('sync-request'); } catch (_) {} }
                }
              } else {
                _consecutiveResyncs = 0;
                _syncCheckInterval = _syncBaseInterval;
              }
            }).catch(function () {});
          }
        } catch (_) {}
      }
      _pendingSyncCheck = null;
    }

    // -- Periodic desync check (star topology: host-only) -----
    // Hash directly from HEAPU8 (RDRAM) when available — avoids the ~3ms
    // getState() serialization AND the pre-compression that used to run every
    // check interval.  State is only captured/compressed on actual resync.
    if (_syncEnabled && _playerSlot === 0 && _frameNum > 0 &&
        _frameNum % _syncCheckInterval === 0) {
      var hashBytes = getHashBytes();
      if (hashBytes) {
        var checkFrame = _frameNum;
        var peers = getActivePeers();
        workerPost({ type: 'hash', data: hashBytes }).then(function (res) {
          var syncMsg = 'sync-hash:' + checkFrame + ':' + res.hash;
          var sent = 0;
          for (var s = 0; s < peers.length; s++) {
            try { peers[s].dc.send(syncMsg); sent++; } catch (_) {}
          }
          var hostMsg = 'sync-check frame=' + checkFrame + ' hash=' + res.hash +
            ' sent=' + sent + '/' + peers.length;
          console.log('[lockstep] ' + hostMsg);
          _streamSync(hostMsg);
        }).catch(function () {});
        if (_frameNum % (_syncCheckInterval * 10) === 0) {
          console.log('[lockstep] sync check at frame', _frameNum);
        }
      }
    }

    // Debug overlay -- update every 15 frames (~4x per second)
    if (_frameNum % 15 === 0) {
      var dbg = document.getElementById('np-debug');
      if (dbg) {
        dbg.style.display = '';
        var playerCount = activePeers.length + 1;  // +1 for self
        var spectatorCount = Object.values(_peers).filter((p) => p.slot === null).length;
        var remoteBufTotal = 0;
        Object.keys(_remoteInputs).forEach((slot) => {
          remoteBufTotal += Object.keys(_remoteInputs[slot] || {}).length;
        });
        dbg.textContent =
          'F:' + _frameNum +
          ' fps:' + _fpsCurrent +
          ' slot:' + _playerSlot +
          ' players:' + playerCount +
          (spectatorCount > 0 ? ' spec:' + spectatorCount : '') +
          ' delay:' + DELAY_FRAMES +
          ' rBuf:' + remoteBufTotal +
          ' rcv:' + _remoteReceived +
          ' hit:' + _remoteApplied +
          ' miss:' + _remoteMissed +
          ' lastR:' + _lastRemoteFrame;
      }
    }
  }

  // -- Input read ------------------------------------------------------------

  // ── Virtual gamepad (EJS touch controls) capture ──────────────────────
  // EJS calls simulateInput(player, button, value) directly into WASM.
  // We intercept it to track which buttons are held, so readLocalInput()
  // can include touch inputs in the netplay bitmask.
  let _touchInputState = {};  // { buttonIndex: value }

  function hookVirtualGamepad() {
    var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm || gm._kn_hooked) return;
    gm.simulateInput = function (player, index, value) {
      // Only capture player 0 (local player's touch input)
      if (player === 0) {
        // Suppress input while EJS menus/popups are open.  The virtual
        // gamepad touch handlers in EmulatorJS don't check for menus
        // (unlike the keyboard/gamepad handlers), so tapping the screen
        // while the settings bar or a popup is visible sends spurious
        // inputs that desync mobile players.
        var ejs = window.EJS_emulator;
        if (ejs) {
          if (ejs.settingsMenuOpen) return;
          if (ejs.isPopupOpen && ejs.isPopupOpen()) return;
          if (ejs.elements && ejs.elements.menu &&
              !ejs.elements.menu.classList.contains('ejs_menu_bar_hidden')) return;
        }
        _touchInputState[index] = value;
      }
      // Don't call original — our writeInputToMemory handles input delivery.
      // Letting EJS also write would double-apply and bypass lockstep.
    };
    gm._kn_hooked = true;
    console.log('[lockstep] hooked EJS simulateInput for touch capture');
  }

  function readLocalInput() {
    var mask = 0;

    // Gamepad via GamepadManager (profile-based mapping)
    if (document.hasFocus() && window.GamepadManager) {
      mask |= GamepadManager.readGamepad(_playerSlot);
    }

    // Keyboard
    if (_p1KeyMap) {
      _heldKeys.forEach((kc) => {
        const btnIdx = _p1KeyMap[kc];
        if (btnIdx !== undefined) mask |= (1 << btnIdx);
      });
    }

    // Virtual gamepad (mobile touch controls)
    // EJS simulateInput uses indices 0-15 for digital buttons (value 0 or 1)
    // and 16+ for analog axes with SIGNED values (±32767):
    //   index 16 = left stick X (positive = right, negative = left)
    //   index 17 = left stick Y (positive = down, negative = up)
    //   index 18 = right stick X, index 19 = right stick Y
    // Our bitmask uses BIT PAIRS per axis:
    //   bits 16/17 = stick X (right/left), bits 18/19 = stick Y (down/up)
    //   bits 20/21 = C-stick X, bits 22/23 = C-stick Y
    // Skip entirely if an EJS menu/popup is visible — stale touch state from
    // before the menu opened would otherwise keep sending non-zero input.
    var ejs = window.EJS_emulator;
    var ejsMenuOpen = ejs && (
      ejs.settingsMenuOpen ||
      (ejs.isPopupOpen && ejs.isPopupOpen()) ||
      (ejs.elements && ejs.elements.menu &&
       !ejs.elements.menu.classList.contains('ejs_menu_bar_hidden'))
    );
    if (ejsMenuOpen) _touchInputState = {};
    for (var ti in _touchInputState) {
      var idx = parseInt(ti, 10);
      var val = _touchInputState[idx];
      if (!val) continue;
      if (idx < 16) {
        mask |= (1 << idx);
      } else if (idx >= 16 && idx <= 19) {
        // Convert EJS axis index (16=X, 17=Y, 18=CX, 19=CY) with signed value
        // to our bit-pair layout (each axis uses 2 consecutive bits: pos, neg).
        var baseBit = 16 + (idx - 16) * 2;  // 16→16, 17→18, 18→20, 19→22
        if (val > 0) mask |= (1 << baseBit);       // positive direction
        if (val < 0) mask |= (1 << (baseBit + 1)); // negative direction
      }
    }

    // Debug: call window.debugInput() to log input for 3 seconds
    if (window._debugInputUntil && performance.now() < window._debugInputUntil && mask !== 0) {
      var bits = [];
      for (var b = 0; b < 20; b++) { if ((mask >> b) & 1) bits.push(b); }
      console.log('[input-debug] mask=' + mask + ' bits=[' + bits.join(',') + ']');
    }

    return mask;
  }

  window.debugInput = function () {
    window._debugInputUntil = performance.now() + 3000;
    console.log('[input-debug] Logging input for 3 seconds — press buttons now');
  };

  // -- Inline Web Worker for hash + compress/decompress ----------------------
  //
  // Offloads CPU-intensive sync work (FNV-1a hash, gzip compress/decompress)
  // to a dedicated thread so the main thread tick loop isn't blocked.

  let _syncWorker = null;
  let _syncWorkerCallbacks = {};  // id -> callback
  let _syncWorkerNextId = 0;

  function getSyncWorker() {
    if (_syncWorker) return _syncWorker;
    var code = [
      'function fnv1a(bytes) {',
      '  var h = 0x811c9dc5, len = bytes.length;',
      '  for (var i = 0; i < len; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }',
      '  return h | 0;',
      '}',
      'async function compress(bytes) {',
      '  var cs = new CompressionStream("gzip");',
      '  var w = cs.writable.getWriter(); w.write(bytes); w.close();',
      '  var r = cs.readable.getReader(), chunks = [];',
      '  while (true) { var res = await r.read(); if (res.value) chunks.push(res.value); if (res.done) break; }',
      '  var out = new Uint8Array(chunks.reduce(function(a,c){return a+c.length},0)), off=0;',
      '  for (var i=0;i<chunks.length;i++){out.set(chunks[i],off);off+=chunks[i].length;}',
      '  return out;',
      '}',
      'async function decompress(bytes) {',
      '  var ds = new DecompressionStream("gzip");',
      '  var w = ds.writable.getWriter(); w.write(bytes); w.close();',
      '  var r = ds.readable.getReader(), chunks = [];',
      '  while (true) { var res = await r.read(); if (res.value) chunks.push(res.value); if (res.done) break; }',
      '  var out = new Uint8Array(chunks.reduce(function(a,c){return a+c.length},0)), off=0;',
      '  for (var i=0;i<chunks.length;i++){out.set(chunks[i],off);off+=chunks[i].length;}',
      '  return out;',
      '}',
      'onmessage = async function(e) {',
      '  var msg = e.data, id = msg.id;',
      '  try {',
      '    if (msg.type === "hash") {',
      '      postMessage({id:id, hash: fnv1a(msg.data)});',
      '    } else if (msg.type === "hash-and-compress") {',
      '      var hash = fnv1a(msg.data);',
      '      var compressed = await compress(msg.data);',
      '      postMessage({id:id, hash:hash, compressed:compressed}, [compressed.buffer]);',
      '    } else if (msg.type === "compress") {',
      '      var c = await compress(msg.data);',
      '      postMessage({id:id, data:c}, [c.buffer]);',
      '    } else if (msg.type === "decompress") {',
      '      var d = await decompress(msg.data);',
      '      postMessage({id:id, data:d}, [d.buffer]);',
      '    } else if (msg.type === "compress-and-encode") {',
      '      var c2 = await compress(msg.data);',
      '      var chunkSize = 32768, binary = "";',
      '      for (var j = 0; j < c2.length; j += chunkSize) {',
      '        binary += String.fromCharCode.apply(null, c2.subarray(j, Math.min(j + chunkSize, c2.length)));',
      '      }',
      '      postMessage({id:id, data:btoa(binary), rawSize:msg.data.length, compressedSize:c2.length});',
      '    } else if (msg.type === "decode-and-decompress") {',
      '      var bin = atob(msg.data), arr = new Uint8Array(bin.length);',
      '      for (var k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);',
      '      var d2 = await decompress(arr);',
      '      postMessage({id:id, data:d2}, [d2.buffer]);',
      '    }',
      '  } catch(err) { postMessage({id:id, error: err.message}); }',
      '};',
    ].join('\n');
    var blob = new Blob([code], { type: 'application/javascript' });
    _syncWorker = new Worker(URL.createObjectURL(blob));
    _syncWorker.onmessage = function (e) {
      var cb = _syncWorkerCallbacks[e.data.id];
      if (cb) { delete _syncWorkerCallbacks[e.data.id]; cb(e.data); }
    };
    return _syncWorker;
  }

  function workerPost(msg) {
    return new Promise(function (resolve, reject) {
      var id = _syncWorkerNextId++;
      msg.id = id;
      _syncWorkerCallbacks[id] = function (result) {
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      };
      // Transfer ArrayBuffer if present (zero-copy to worker)
      var transfer = msg.data && msg.data.buffer ? [msg.data.buffer] : [];
      getSyncWorker().postMessage(msg, transfer);
    });
  }

  // -- Compression helpers (delegate to worker when available) ---------------

  async function compressState(bytes) {
    try {
      var result = await workerPost({ type: 'compress', data: bytes });
      return result.data;
    } catch (e) {
      // Worker fallback: compress on main thread
      return compressStateFallback(bytes);
    }
  }

  async function compressStateFallback(bytes) {
    var cs = new CompressionStream('gzip');
    var writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    var reader = cs.readable.getReader();
    var chunks = [];
    while (true) {
      var result = await reader.read();
      if (result.value) chunks.push(result.value);
      if (result.done) break;
    }
    var out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    var offset = 0;
    for (var i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return out;
  }

  async function decompressState(bytes) {
    try {
      var result = await workerPost({ type: 'decompress', data: bytes });
      return result.data;
    } catch (e) {
      // Worker fallback: decompress on main thread
      var ds = new DecompressionStream('gzip');
      var writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      var reader = ds.readable.getReader();
      var chunks = [];
      while (true) {
        var result2 = await reader.read();
        if (result2.value) chunks.push(result2.value);
        if (result2.done) break;
      }
      var out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
      var offset = 0;
      for (var i = 0; i < chunks.length; i++) {
        out.set(chunks[i], offset);
        offset += chunks[i].length;
      }
      return out;
    }
  }

  function uint8ToBase64(bytes) {
    var chunkSize = 32768;
    var binary = '';
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function base64ToUint8(b64) {
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // -- Combined compress+encode / decode+decompress (worker-offloaded) -------

  async function compressAndEncode(bytes) {
    try {
      var result = await workerPost({ type: 'compress-and-encode', data: bytes });
      return result;
    } catch (e) {
      // Fallback: main thread
      var compressed = await compressStateFallback(bytes);
      return {
        data: uint8ToBase64(compressed),
        rawSize: bytes.length,
        compressedSize: compressed.length,
      };
    }
  }

  async function decodeAndDecompress(b64) {
    try {
      var result = await workerPost({ type: 'decode-and-decompress', data: b64 });
      return result.data;
    } catch (e) {
      // Fallback: main thread
      var compressed = base64ToUint8(b64);
      return decompressState(compressed);
    }
  }

  // -- Keyboard / input setup ------------------------------------------------

  function setupKeyTracking() {
    _p1KeyMap = KNShared.setupKeyTracking(_p1KeyMap, _heldKeys);
  }

  function disableEJSInput() {
    var attempt = function () {
      var ejs = window.EJS_emulator;
      var gm = ejs && ejs.gameManager;
      if (!gm) { setTimeout(attempt, 200); return; }

      // Disable EJS keyboard handling
      gm.setKeyboardEnabled(false);
      var parent = ejs.elements && ejs.elements.parent;
      if (parent) {
        var block = function (e) { e.stopImmediatePropagation(); };
        parent.addEventListener('keydown', block, true);
        parent.addEventListener('keyup',   block, true);
      }

      // Disable EJS gamepad handling — stop its JS-level 10ms polling loop
      if (ejs.gamepad) {
        if (ejs.gamepad.timeout) clearTimeout(ejs.gamepad.timeout);
        ejs.gamepad.loop = function () {};
      }

      // Block navigator.getGamepads globally so the WASM core's internal
      // Emscripten SDL gamepad layer also gets no gamepads. The core has
      // its own RetroArch button mapping that conflicts with our profiles.
      // GamepadManager uses a saved reference (_nativeGetGamepads) so it
      // still works.
      navigator.getGamepads = function () { return []; };
    };
    attempt();
  }

  // -- Direct memory hashing (avoids expensive getState() serialization) ------

  function getHashBytes() {
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    if (!mod) return null;

    // Discover RDRAM pointer FRESH each time. The core may remap RDRAM
    // after save state loads (which happen during lockstep initial sync
    // and resyncs), making cached pointers stale.
    if (mod.cwrap) {
      try {
        var getMemData = mod.cwrap('get_memory_data', 'string', ['string']);
        var result = getMemData('RETRO_MEMORY_SYSTEM_RAM');
        if (result) {
          var parts = result.split('|');
          var rdramSize = parseInt(parts[0], 10);
          var rdramPtr = parseInt(parts[1], 10);
          if (rdramPtr > 0 && rdramSize > 0) {
            if (_hashRegion === null) {
              var bufSrc = mod.wasmMemory ? 'wasmMemory' : mod.asm && mod.asm.memory ? 'asm.memory' : mod.buffer ? 'mod.buffer' : 'HEAPU8.buffer';
              console.log('[lockstep] hash: RDRAM at [' + rdramPtr + '], size=' + rdramSize + ', buf=' + bufSrc);
            } else if (_hashRegion && _hashRegion.ptr !== rdramPtr) {
              console.log('[lockstep] hash: RDRAM moved! old=' + _hashRegion.ptr + ' new=' + rdramPtr);
            }
            _hashRegion = { ptr: rdramPtr, size: rdramSize };
          }
        }
      } catch (_) {}
    }

    // Direct RDRAM read using scan-verified regions (Playwright automated scan).
    // Buffer staleness: detect detached buffer and try re-acquisition.
    var buf = mod.HEAPU8 ? mod.HEAPU8.buffer : null;
    if (!buf || buf.byteLength === 0) {
      buf = (mod.wasmMemory && mod.wasmMemory.buffer) ||
            (mod.asm && mod.asm.memory && mod.asm.memory.buffer) || null;
    }
    if (_hashRegion && _hashRegion.ptr && buf && buf.byteLength > 0) {
      try {
        var live = new Uint8Array(buf);
        var base = _hashRegion.ptr;

        // SSB64 VS mode RDRAM map (verified by visual Playwright MCP scan).
        // Match-only volatile regions (change during gameplay, NOT during menus):
        //   0xA4000          — player/match config (near GameShark addresses)
        //   0xBA000-0xC7000  — player/match state
        //   0x262000-0x26C000 — physics/animation
        //   0x32B000-0x335000 — physics/animation
        // NEVER hash (core internals, always volatile = false positives):
        //   0x3B000-0xA3000, 0xA5000-0xB9000, 0xD5000-0xD6000
        //
        // Sample 256B from each match-only volatile block (lightweight).
        var gameRegions = [
          0xA4000,   // player/match config
          0xBA000,   // player state block start
          0xBF000,   // player state block mid
          0xC4000,   // player state block end
          0x262000,  // physics block 1
          0x266000,  // physics block 1 mid
          0x26A000,  // physics block 1 end
          0x290000,  // misc gameplay
          0x2F6000,  // physics block 2
          0x32B000,  // physics block 3 start
          0x330000,  // physics block 3 mid
          0x335000,  // physics block 3 end
        ];
        var SAMPLE = 256;
        var combined = new Uint8Array(SAMPLE * gameRegions.length);
        for (var gi = 0; gi < gameRegions.length; gi++) {
          var gOff = base + gameRegions[gi];
          combined.set(live.subarray(gOff, gOff + SAMPLE), gi * SAMPLE);
        }
        return combined;
      } catch (e) {
        console.log('[lockstep] hash: RDRAM read failed:', e.message);
      }
    }

    // Fallback: getState() — expensive but always correct
    try {
      var gm = window.EJS_emulator.gameManager;
      var raw = gm.getState();
      var bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      return bytes.slice(0x100000, Math.min(0x300000, bytes.length));
    } catch (_) { return null; }
  }

  // -- Async state sync (compress/decompress via Web Worker) -----------------

  let _pushingSyncState = false;  // debounce concurrent sync-request handling

  var _lastSyncState = null;  // host: previous state for delta computation

  function pushSyncState(targetSid) {
    // Host: capture state, compute delta if possible, compress, and send.
    if (_playerSlot !== 0 || !_syncEnabled) return;
    if (_pushingSyncState) return;

    var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;
    _pushingSyncState = true;
    var ps0 = performance.now();
    var raw = gm.getState();
    var ps1 = performance.now();
    var currentState = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    var frame = _frameNum;
    _streamSync('host getState: ' + Math.round(currentState.length / 1024) + 'KB, ' +
      (ps1 - ps0).toFixed(1) + 'ms');

    // Delta sync: XOR against previous state. The delta is mostly zeros
    // (unchanged bytes) which compresses ~100x better than full state.
    var isFull = !_lastSyncState || _lastSyncState.length !== currentState.length;
    _streamSync('pushSync: lastState=' + (_lastSyncState ? _lastSyncState.length : 'null') +
      ' current=' + currentState.length + ' isFull=' + isFull);
    var toCompress;
    if (isFull) {
      toCompress = currentState;
    } else {
      // XOR delta
      toCompress = new Uint8Array(currentState.length);
      for (var i = 0; i < currentState.length; i++) {
        toCompress[i] = currentState[i] ^ _lastSyncState[i];
      }
    }
    _lastSyncState = new Uint8Array(currentState);

    compressState(toCompress).then(function (compressed) {
      var sizeKB = Math.round(compressed.length / 1024);
      _streamSync((isFull ? 'full' : 'delta') + ' state: ' + sizeKB + 'KB compressed');
      sendSyncChunks(compressed, frame, isFull, targetSid);
    }).catch(function (err) {
      console.log('[lockstep] sync compress failed:', err);
    }).finally(function () {
      _pushingSyncState = false;
    });
  }

  function sendSyncChunks(compressed, frame, isFull, targetSid) {
    // Host: send compressed state/delta via DC in 64KB chunks.
    // If targetSid is set, send only to that peer (star topology).
    var CHUNK_SIZE = 64000;
    var numChunks = Math.ceil(compressed.length / CHUNK_SIZE);
    var targets = [];
    if (targetSid && _peers[targetSid]) {
      targets = [_peers[targetSid]];
    } else {
      targets = getActivePeers();
    }

    var header = 'sync-start:' + frame + ':' + numChunks + ':' + (isFull ? '1' : '0');
    for (var p = 0; p < targets.length; p++) {
      var dc = targets[p].dc;
      if (!dc || dc.readyState !== 'open') continue;
      try {
        dc.send(header);
        for (var i = 0; i < numChunks; i++) {
          var start = i * CHUNK_SIZE;
          var end = Math.min(start + CHUNK_SIZE, compressed.length);
          dc.send(compressed.slice(start, end));
        }
      } catch (err) {
        console.log('[lockstep] sync send failed:', err);
      }
    }
    console.log('[lockstep] pushed', (isFull ? 'full' : 'delta'), 'state frame', frame,
      '(' + Math.round(compressed.length / 1024) + 'KB,', numChunks, 'chunks)');
  }

  function handleSyncChunksComplete() {
    // Guest: reassemble chunks, decompress, reconstruct state, buffer for apply.
    var total = _syncChunks.reduce((a, c) => a + c.length, 0);
    var assembled = new Uint8Array(total);
    var offset = 0;
    for (var i = 0; i < _syncChunks.length; i++) {
      assembled.set(_syncChunks[i], offset);
      offset += _syncChunks[i].length;
    }
    _syncChunks = [];
    _syncExpected = 0;
    var frame = _syncFrame;
    var isFull = _syncIsFull;

    decompressState(assembled).then(function (decompressed) {
      if (isFull) {
        // Full state — use directly
        _pendingResyncState = { bytes: decompressed, frame: frame };
      } else {
        // Delta — XOR against our current state to reconstruct host's state
        var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
        if (!gm) return;
        var raw = gm.getState();
        var current = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        if (current.length !== decompressed.length) {
          console.log('[lockstep] delta size mismatch: current=' + current.length +
            ' delta=' + decompressed.length + ' — falling back to full');
          // Can't apply delta — request full state
          return;
        }
        var reconstructed = new Uint8Array(current.length);
        for (var j = 0; j < current.length; j++) {
          reconstructed[j] = current[j] ^ decompressed[j];
        }
        _pendingResyncState = { bytes: reconstructed, frame: frame };
      }
      _streamSync('resync ready (' + (isFull ? 'full' : 'delta') + ', ' +
        Math.round(assembled.length / 1024) + 'KB wire)');
    }).catch(function (err) {
      console.log('[lockstep] sync decompress failed:', err);
    });
  }

  function applySyncState(bytes, frame) {
    // Guest: hot-swap emulator state at a clean frame boundary.
    // Called from tick() when _pendingResyncState is set — ensures loadState()
    // never fires mid-tick or mid-input-processing.
    //
    // KEY INSIGHT: The frame counter is only used for input synchronization.
    // By keeping _frameNum where it is, input buffers stay valid and no stall.
    var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
    if (!gm) return;

    var lt0 = performance.now();
    gm.loadState(bytes);
    var lt1 = performance.now();

    // Re-capture rAF runner (loadState may invalidate _pendingRunner)
    var mod = gm.Module;
    mod.pauseMainLoop();
    mod.resumeMainLoop();

    // loadState may trigger WASM memory growth, detaching HEAPU8.buffer.
    // Force Emscripten to refresh its typed array views.
    if (mod.updateMemoryViews) {
      mod.updateMemoryViews();
    } else if (mod._emscripten_notify_memory_growth) {
      mod._emscripten_notify_memory_growth(0);
    }
    // Invalidate cached RDRAM region so it's re-discovered with fresh buffer
    _hashRegion = null;

    _resyncCount++;
    _consecutiveResyncs++;

    _streamSync('loadState: ' + Math.round(bytes.length / 1024) + 'KB, ' +
      (lt1 - lt0).toFixed(1) + 'ms');

    // Purge stale remote inputs above the new frame
    Object.keys(_remoteInputs).forEach((slot) => {
      const inputs = _remoteInputs[slot];
      if (!inputs) return;
      Object.keys(inputs).forEach((f) => {
        if (parseInt(f, 10) > _frameNum + DELAY_FRAMES) delete inputs[f];
      });
    });

    var syncMsg = 'sync #' + _resyncCount + ' applied (frame ' + frame +
      ' -> ' + _frameNum + ', next in ' + _syncCheckInterval + 'f)';
    console.log('[lockstep] ' + syncMsg);
    _streamSync(syncMsg);
  }

  // -- Init / Stop API -------------------------------------------------------

  let _config = null;

  function init(config) {
    _config = config;
    socket = config.socket;
    _playerSlot = config.playerSlot;
    _isSpectator = config.isSpectator;

    // Apply pre-game options
    _syncEnabled = !!config.rollbackEnabled;        // default: false
    _lateJoin = !!config.lateJoin;

    window._playerSlot = _playerSlot;
    window._isSpectator = _isSpectator;

    // Register socket listeners
    socket.on('users-updated', onUsersUpdated);
    socket.on('webrtc-signal', onWebRTCSignal);
    socket.on('data-message', onDataMessage);

    // Process current peers immediately
    if (config.initialPlayers) {
      onUsersUpdated(config.initialPlayers);
    }

    // Connection timeout warning
    setTimeout(function () {
      if (!_gameStarted && _config) {
        var peerCount = Object.keys(_peers).length;
        if (peerCount === 0) {
          setStatus('No peer connection — check network');
        } else {
          var anyOpen = Object.values(_peers).some((p) => p.ready);
          if (!anyOpen) setStatus('Peer found but data channel not open');
        }
      }
    }, 15000);
    // startGameSequence() is triggered from ch.onopen (same as before)
  }

  function stop() {
    DELAY_FRAMES = 2;
    _rttSamples = [];
    _rttComplete = false;
    _rttPeersComplete = 0;
    _rttPeersTotal = 0;

    // Stop lockstep tick loop
    stopSync();

    // Close all peer connections and clear reconnect timers
    Object.keys(_peers).forEach((sid) => {
      const p = _peers[sid];
      if (p._reconnectTimeout) { clearTimeout(p._reconnectTimeout); p._reconnectTimeout = null; }
      if (p._disconnectTimer) { clearTimeout(p._disconnectTimer); p._disconnectTimer = null; }
      if (p.dc) try { p.dc.close(); } catch (_) {}
      if (p.pc) try { p.pc.close(); } catch (_) {}
    });
    // Signal all reconnecting states cleared before nulling config
    if (_config && _config.onReconnecting) {
      try { _config.onReconnecting(null, false); } catch (_) {}
    }
    _peers = {};
    window._peers = _peers;

    // Restore rAF — emulator DOM is destroyed by play.js, so just clean up
    if (_manualMode && _origRAF) {
      window.requestAnimationFrame = _origRAF;
    }
    _manualMode = false;
    _origRAF = null;
    _pendingRunner = null;

    // Reset lockstep state
    _remoteInputs = {};
    _peerInputStarted = {};
    _localInputs = {};
    _frameNum = 0;
    window._frameNum = 0;
    _running = false;
    _lateJoin = false;
    _gameStarted = false;
    _selfEmuReady = false;
    _selfLockstepReady = false;
    _lockstepReadyPeers = {};
    _guestStateBytes = null;
    _knownPlayers = {};
    _lastRemoteFrame = -1;
    _lastRemoteFramePerSlot = {};
    _resyncCount = 0;
    _consecutiveResyncs = 0;
    _syncCheckInterval = _syncBaseInterval;
    _syncChunks = [];
    _syncExpected = 0;
    _pushingSyncState = false;
    _pendingResyncState = null;
    _hashRegion = null;
    if (_syncWorker) { _syncWorker.terminate(); _syncWorker = null; }
    _syncWorkerCallbacks = {};

    // Clean up audio bypass
    if (_audioWorklet) {
      _audioWorklet.disconnect();
      _audioWorklet = null;
    }
    if (_audioDestNode) {
      _audioDestNode.disconnect();
      _audioDestNode = null;
    }
    if (_audioCtx) {
      _audioCtx.close();
      _audioCtx = null;
    }
    _audioReady = false;
    _audioPtr = 0;
    _audioRate = 0;

    // Clean up spectator stream
    if (_hostStream) {
      _hostStream.getTracks().forEach((t) => { t.stop(); });
      _hostStream = null;
    }
    if (_guestVideo) {
      _guestVideo.srcObject = null;
      if (_guestVideo.parentNode) _guestVideo.parentNode.removeChild(_guestVideo);
      _guestVideo = null;
    }

    // Remove socket listeners
    if (socket) {
      socket.off('users-updated', onUsersUpdated);
      socket.off('webrtc-signal', onWebRTCSignal);
      socket.off('data-message', onDataMessage);
    }

    _onExtraDataChannel = null;
    _onUnhandledMessage = null;

    _config = null;
  }

  window.NetplayLockstep = {
    init: init,
    stop: stop,
    onExtraDataChannel: function (cb) { _onExtraDataChannel = cb; },
    onUnhandledMessage: function (cb) { _onUnhandledMessage = cb; },
    getPeerConnection: function (sid) {
      var p = _peers[sid];
      return p ? p.pc : null;
    },
    setSyncEnabled: function (on) { _syncEnabled = !!on; },
    isSyncEnabled: function () { return _syncEnabled; },
    setSyncInterval: function (frames) { _syncBaseInterval = _syncCheckInterval = Math.max(30, frames); },
    getInfo: function () {
      var peers = getActivePeers();
      var rtt = _rttSamples.length > 0
        ? _rttSamples[Math.floor(_rttSamples.length / 2)]
        : null;
      var peerInfo = peers.map((peer) => ({
        slot: peer.slot,
        rtt: peer.rttSamples && peer.rttSamples.length > 0
          ? peer.rttSamples[Math.floor(peer.rttSamples.length / 2)]
          : null,
        delayValue: peer.delayValue || null,
      }));
      return {
        fps: _fpsCurrent,
        frameDelay: DELAY_FRAMES,
        ping: rtt,
        playerCount: peers.length + 1,
        frame: _frameNum,
        running: _running,
        mode: 'lockstep',
        syncEnabled: _syncEnabled,
        resyncCount: _resyncCount,
        peers: peerInfo,
      };
    },
    getDebugLog: function () { return _debugLog.slice(); },
    dumpLogs: function () {
      if (socket && socket.connected) {
        var info = {
          slot: _playerSlot,
          frame: _frameNum,
          running: _running,
          syncEnabled: _syncEnabled,
          resyncCount: _resyncCount,
          peerCount: Object.keys(_peers).length,
          ua: navigator.userAgent,
        };
        socket.emit('debug-logs', { info: info, logs: _debugLog });
        console.log('[lockstep] dumped', _debugLog.length, 'log entries to server');
      }
    },
  };

})();
