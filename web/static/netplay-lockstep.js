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
 *   2. Standard online cheats applied automatically via KNShared
 *      (SSB64 GameShark codes: all characters, items off, etc.).
 *   3. INPUT_BASE auto-discovery: calls _simulate_input(0, 0, 1) and scans
 *      the first 4MB of HEAPU8 for the changed byte. This locates the core's
 *      internal input_state array, which varies per WASM compilation.
 *   4. Host captures a save state, gzip-compresses it, base64-encodes it,
 *      and sends it to all guests via Socket.IO (save states are ~1.5MB,
 *      too large for WebRTC DataChannels which have SCTP buffering limits).
 *      State may be fetched from server cache (by ROM hash) to skip host
 *      boot entirely.
 *   5. RTT measurement: 3 ping-pong rounds over each DataChannel. The
 *      median RTT determines auto frame delay: ceil(median_ms / 16.67),
 *      clamped to [1, 9]. Both sides exchange their delay preference and
 *      the maximum across all players becomes the effective DELAY_FRAMES.
 *   6. All players load the same save state (double-load: first restores
 *      CPU+RAM, then enterManualMode() captures rAF, second load fixes
 *      any free-frame drift between the loads). Frame counter resets to 0.
 *   7. Lockstep tick loop starts via setInterval(16).
 *
 * ── Frame Stepping (Manual Mode) ─────────────────────────────────────────
 *
 *   Emscripten's main loop is driven by requestAnimationFrame. To control
 *   frame timing, we intercept rAF via APISandbox (api-sandbox.js):
 *     - APISandbox saves native browser APIs (rAF, getGamepads,
 *       performance.now) at page load before any scripts can override them
 *     - overrideRAF() replaces window.requestAnimationFrame with an
 *       interceptor that captures the callback (_pendingRunner) instead
 *       of scheduling it
 *     - Module.resumeMainLoop() registers Emscripten's runner through
 *       our interceptor, giving us the callback
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
 *     1. Apply pending resync state if buffered (async from previous sync)
 *     2. GGPO-style frame pacing check (see Frame Pacing below) — skip
 *        tick entirely if too far ahead of slowest peer
 *     3. Read local input (keyboard via keyCode tracking + gamepad via
 *        GamepadManager + VirtualGamepad on mobile) → 24-bit mask
 *     4. Send encoded input (16 bytes) to all peer DCs
 *     5. Compute applyFrame = N - DELAY_FRAMES (the delayed frame whose
 *        inputs are ready to apply)
 *     6. Check if all "input peers" have sent input for applyFrame.
 *        Input peers = peers who have sent at least one input. During the
 *        first BOOT_GRACE_FRAMES (120), connected peers are also included
 *        before their first packet — prevents the host from racing ahead
 *        with fabricated zeros and seeding permanent hash divergence.
 *        After the grace window, unstarted peers are excluded (late-join).
 *        If input is missing, two-stage stall:
 *          Stage 1 (0 – 3000ms): stall, retry via setTimeout(1).
 *          Stage 2 (3000 – 5000ms): send "resend:<frame>" to the
 *            missing peer requesting retransmission, keep stalling.
 *          Timeout (5000ms+): inject zero input to unstick.
 *     7. Write all players' inputs to WASM memory via _simulate_input()
 *        (iterates 16 digital buttons + 4 analog axis pairs per player)
 *     8. Reset audio buffer, step one frame, feed audio samples to
 *        AudioWorklet (or AudioBufferSourceNode fallback)
 *     9. Increment frame counter. Periodically update debug overlay.
 *
 * ── Frame Pacing (GGPO-Inspired) ────────────────────────────────────────
 *
 *   Prevents the faster machine from outrunning the slower one's input
 *   stream. Tracks frame advantage (local frame - min remote frame) as
 *   an exponential moving average with asymmetric alpha:
 *     - Rising (falling behind): α = 0.1 (slow to trigger, avoids jitter)
 *     - Falling (catching up):   α = 0.2 (fast to release throttle)
 *   When raw frame advantage exceeds DELAY_FRAMES + 1, the tick is
 *   skipped entirely — no input sent, no emulator stepped. This keeps
 *   players within one delay window of each other.
 *   Disabled during 120-frame warmup while connections stabilize.
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
 *   (_kn_get_audio_ptr, _kn_get_audio_samples, _kn_reset_audio,
 *   _kn_get_audio_rate) and fed to an AudioWorklet ring buffer
 *   (audio-worklet-processor.js). Falls back to AudioBufferSourceNode
 *   when AudioWorklet is unavailable. This ensures audio is frame-
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
 *   Opt-in (rollbackEnabled flag). Star topology: host (slot 0) is the
 *   sync authority. Two hashing paths:
 *
 *   1. C-level (patched core): _kn_sync_hash() hashes game-specific
 *      RDRAM regions directly in C — fast and deterministic. Uses
 *      _kn_sync_hash_regions for per-region checksums. Resync via
 *      _kn_sync_read() (host exports state) and _kn_sync_write()
 *      (guest imports state).
 *   2. JS fallback: FNV-1a hash of RDRAM via direct HEAPU8 access,
 *      falling back to getState() serialization.
 *
 *   The host broadcasts "sync-hash:frame:hash:cycleMs" every
 *   _syncCheckInterval frames (~120 frames / ~2s). Guests compare
 *   their own hash — on mismatch, they send "sync-request" and the
 *   host sends the full compressed state via DataChannel in 64KB
 *   chunks. The guest buffers it for async application at the next
 *   clean frame boundary — no mid-frame stall.
 *
 * ── Late Join ─────────────────────────────────────────────────────────────
 *
 *   Pull model — the joiner requests state when ready:
 *     1. Joiner boots emulator minimally, enters manual mode
 *     2. Sends "request-late-join" via Socket.IO data-message
 *     3. Host captures + compresses state, sends "late-join-state" with
 *        the current frame number and effective delay
 *     4. Joiner loads state, syncs frame counter to max(hostFrame,
 *        lastRemoteFrame), pre-fills delay gap with zero input, starts
 *        lockstep tick loop
 *   The late-joiner always initiates WebRTC connections to avoid the
 *   offer-before-listener race condition.
 *
 * ── Drop Handling ─────────────────────────────────────────────────────────
 *
 *   When a peer's DataChannel closes or ICE connection fails:
 *     - Their input in WASM memory is zeroed (neutral stick, no buttons)
 *     - They're removed from the peer map and input tracking
 *     - Remaining players continue — the tick loop handles zero active
 *       peers gracefully (single-player mode)
 *     - No reconnect attempt; the dropped player can re-join as late join
 *
 * ── Tab Visibility ──────────────────────────────────────────────────────
 *
 *   A visibilitychange listener pauses/resumes emulation when the tab
 *   loses or regains focus, preventing runaway frame advancement in
 *   background tabs and saving CPU/bandwidth.
 *
 * ── Diagnostics ─────────────────────────────────────────────────────────
 *
 *   _debugLog: timestamped log of [lockstep] and [play] console output
 *   _syncLogRing: 32-entry circular buffer for sync events (hash mismatches,
 *     resync triggers, frame caps), exportable as CSV via debug-sync
 *   _diagEventLog: frame-level diagnostic events flushed to IndexedDB
 *   debug-sync / debug-logs: Socket.IO events for remote log upload to server
 *   Sync hash/resync operations run in a Web Worker to avoid blocking
 *   the main thread during compression/decompression.
 */

(function () {
  'use strict';

  const ICE_SERVERS = window._iceServers || [{ urls: 'stun:stun.cloudflare.com:3478' }];

  // ── Debug log capture ─────────────────────────────────────────────────
  // Intercepts all console.log('[lockstep] ...') calls for remote debugging.
  // Unbounded array — game sessions are finite. Pushed to server on demand.
  const _debugLog = [];
  const _debugLogStart = Date.now();
  (function () {
    const _origLog = console.log;
    console.log = function () {
      _origLog.apply(console, arguments);
      // Capture [lockstep] and [play] prefixed messages
      if (arguments.length > 0) {
        const first = String(arguments[0]);
        if (
          first.startsWith('[lockstep]') ||
          first.startsWith('[play]') ||
          (arguments.length > 1 && String(arguments[1]).includes('[lockstep]'))
        ) {
          const ts = ((Date.now() - _debugLogStart) / 1000).toFixed(3);
          const parts = [];
          for (let i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
          _debugLog.push(`[${ts}] ${parts.join(' ')}`);
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

  const startRttMeasurement = (peer) => {
    peer._rttSamples = [];
    peer._rttPingCount = 0;
    peer._rttComplete = false;
    _rttPeersTotal++;
    sendNextPing(peer);
  };

  const sendNextPing = (peer) => {
    if (peer._rttPingCount >= 3) {
      peer._rttComplete = true;
      // Copy per-peer samples into peer.rttSamples for getInfo()
      peer.rttSamples = peer._rttSamples.slice().sort((a, b) => a - b);
      // Accumulate into global _rttSamples
      for (const s of peer._rttSamples) {
        _rttSamples.push(s);
      }
      _rttPeersComplete++;
      // When all peers are done, compute auto delay from max median across peers
      if (_rttPeersComplete >= _rttPeersTotal) {
        _rttSamples.sort((a, b) => a - b);
        const median = _rttSamples[Math.floor(_rttSamples.length / 2)];
        const delay = Math.min(9, Math.max(2, Math.ceil(median / 16.67)));
        _rttComplete = true;
        if (window.setAutoDelay) window.setAutoDelay(delay);
        _syncLog(`RTT median: ${median.toFixed(1)}ms -> auto delay: ${delay}`);
      }
      // Mid-game reconnect: if delay needs to increase, apply and broadcast
      if (_running) {
        const peerMedian = peer.rttSamples[Math.floor(peer.rttSamples.length / 2)];
        const reconnectDelay = Math.min(9, Math.max(2, Math.ceil(peerMedian / 16.67)));
        if (reconnectDelay > DELAY_FRAMES) {
          DELAY_FRAMES = reconnectDelay;
          _syncLog(`delay increased to ${reconnectDelay}f after reconnect (peer RTT=${peerMedian.toFixed(1)}ms)`);
          for (const p of Object.values(_peers)) {
            if (p.dc && p.dc.readyState === 'open') {
              try {
                p.dc.send(JSON.stringify({ type: 'delay-update', delay: reconnectDelay }));
              } catch (_) {}
            }
          }
        }
      }
      return;
    }
    try {
      peer.dc.send(JSON.stringify({ type: 'delay-ping', ts: performance.now() }));
    } catch (_) {
      peer._rttComplete = true;
      _rttPeersComplete++;
    }
  };

  const handleDelayPong = (ts, peer) => {
    const rtt = performance.now() - ts;
    peer._rttSamples.push(rtt);
    peer._rttPingCount++;
    sendNextPing(peer);
    if (_rttComplete && _selfLockstepReady) {
      broadcastLockstepReady();
      checkAllLockstepReady();
    }
  };

  const broadcastLockstepReady = () => {
    const dl = window.getDelayPreference ? window.getDelayPreference() : 2;
    for (const p of Object.values(_peers)) {
      if (p.dc && p.dc.readyState === 'open' && p.slot !== null && p.slot !== undefined) {
        try {
          p.dc.send(JSON.stringify({ type: 'lockstep-ready', delay: dl }));
        } catch (_) {}
      }
    }
  };

  // Two-stage stall timeout:
  //   Stage 1 (0 – MAX_STALL_MS): stall waiting for remote input.
  //   Stage 2 (MAX_STALL_MS – MAX_STALL_MS + RESEND_TIMEOUT_MS): send
  //     "resend:<frame>" to the missing peer and keep stalling.
  //   Hard timeout: fabricate 0 for all missing slots and advance.
  //     Always 0, never _lastKnownInput — different players may have
  //     received different "last" inputs due to network timing.
  const MAX_STALL_MS = 3000;
  const RESEND_TIMEOUT_MS = 2000;
  // Frames to wait for peers' first input before giving up on boot sync.
  // During this window, connected peers are treated as input peers even
  // before their first packet arrives — prevents host from advancing
  // frames 0..DELAY with fabricated zeros while guest sends real input,
  // which would seed permanent hash divergence and force continuous resyncs.
  const BOOT_GRACE_FRAMES = 120;
  const _lastKnownInput = {}; // slot -> last input mask received from that peer

  // -- Direct memory input layout -----------------------------------------------
  //
  // Layout: int32[20][4] -- 20 buttons x 4 players
  // Button stride: 20 bytes (gap between button N and button N+1 for same player)
  // Player stride: 4 bytes (gap between player 0 and player 1 for same button)
  //
  // The base address changes with each WASM compilation, so we auto-discover it
  // at startup by calling _simulate_input and detecting which byte changed.
  // Fallback: 715364 (CDN core address).

  let INPUT_BASE = 715364; // auto-discovered at startup

  // -- Diagnostics state (DIAG logger) ----------------------------------------
  let _diagPlayerAddrs = [null, null, null, null]; // per-player input base addresses
  let _diagLastTickTime = 0; // wall-clock time of previous tick() call
  const _diagEventLog = []; // buffered async events [{t, type, detail}]
  let _diagHookInstalled = false; // true once async event hooks are set up
  const DIAG_HASH_INTERVAL = 300; // frames between RDRAM hash+dump logs (~once per 5s)
  const DIAG_INPUT_INTERVAL = 300; // frames between input read logs
  const DIAG_TIME_INTERVAL = 60; // frames between timing logs
  const DIAG_EARLY_FRAMES = 30; // log everything for first N frames

  // -- State -----------------------------------------------------------------

  let socket = null;
  let _playerSlot = -1; // 0-3 for players, null for spectators
  let _isSpectator = false;
  // -- Audio bypass state --
  let _audioCtx = null;
  let _audioWorklet = null;
  let _audioDestNode = null;
  let _audioPtr = 0;
  let _audioRate = 0;
  let _audioReady = false;
  let _peers = {}; // remoteSid -> PeerState
  let _knownPlayers = {}; // socketId -> {slot, playerName}
  let _gameStarted = false;
  let _sessionId = 0; // incremented on each init() to invalidate stale timers
  let _romWaitInterval = null; // setInterval ID for guest ROM-wait polling
  let _selfEmuReady = false;
  let _p1KeyMap = null;
  const _heldKeys = new Set();

  // Lockstep state
  let _lockstepReadyPeers = {}; // remoteSid -> true when peer signals lockstep-ready
  let _selfLockstepReady = false;
  let _guestStateBytes = null; // decompressed state bytes to load
  let _frameNum = 0; // current logical frame number
  let _localInputs = {}; // frame -> input object
  let _remoteInputs = {}; // slot -> {frame -> input object} (nested for multi-peer)
  let _peerInputStarted = {}; // slot -> true once first input received (survives buffer drain)
  let _running = false; // tick loop active
  let _lateJoin = false; // true when joining a game already in progress

  // Manual mode / rAF interception state (native refs managed by APISandbox)
  let _pendingRunner = null; // captured Emscripten MainLoop_runner
  let _manualMode = false; // true once enterManualMode() called
  let _stallStart = 0; // timestamp when current stall began
  let _resendSent = false; // true once resend request sent for current stall
  let _syncStarted = false; // true once initial state sync begins (prevents re-entry)
  let _tickInterval = null; // setInterval handle for tick loop

  // Saved originals of WASM speed-control functions — neutralized during lockstep
  let _origToggleFF = null; // Module._toggle_fastforward
  let _origToggleSM = null; // Module._toggle_slow_motion

  // State sync — host checks game state hash and pushes only when desynced
  let _syncEnabled = false; // off by default — opt-in via toolbar button
  // (sync compression uses CompressionStream/DecompressionStream directly)
  let _syncCheckInterval = 10; // check hash every N frames (~166ms at 60fps)
  let _syncBaseInterval = 10; // direct RDRAM reads are ~0.1ms (no getState)
  // Hash byte limit (65536) is set inside the sync worker's fnv1a function
  let _resyncCount = 0;
  let _consecutiveResyncs = 0; // incremented on each resync, reset on sync OK
  let _syncMismatchStreak = 0; // consecutive anchor-hash mismatches without a successful sync-OK
  // Escalate to full resync after this many consecutive mismatches (delta syncs stopped converging).
  // At 10-frame interval: 5 mismatches ≈ 50 frames ≈ 0.8s — fast enough to catch stuck delta loops.
  const MISMATCH_FULL_RESYNC_THRESHOLD = 5;
  let _prevBlockHashes = null; // diagnostic: previous kn_rdram_block_hashes snapshot
  let _offscreenCanvas = null; // reused 64×48 canvas for pixel hash capture
  let _offscreenCtx = null;
  let _lastResyncFrame = 0; // frame when last applySyncState ran (pixel verify window)
  let _lastResyncToastTime = 0; // wall-clock ms of last 'Desync corrected' toast (throttle)
  let _lastDesyncEventTime = 0; // wall-clock ms of last KNEvent('desync') — throttle to avoid 429
  // Resync cooldown: C-level path is <2ms so we can resync very frequently.
  // Fallback (loadState) blocks 3-10ms, needs longer cooldown to avoid freezes.
  const _resyncCooldownMs = () => (_hasKnSync ? 200 : 10000);

  // -- Sync log ring buffer (downloadable from toolbar) ----------------------
  const SYNC_LOG_MAX = 5000;
  const _syncLogRing = new Array(SYNC_LOG_MAX);
  let _syncLogHead = 0;
  let _syncLogCount = 0;
  let _syncLogSeq = 0;

  const _syncLog = (msg) => {
    _syncLogRing[_syncLogHead] = { seq: _syncLogSeq++, t: performance.now(), f: _frameNum, msg };
    _syncLogHead = (_syncLogHead + 1) % SYNC_LOG_MAX;
    if (_syncLogCount < SYNC_LOG_MAX) _syncLogCount++;
    console.log(`[lockstep] ${msg}`);
  };

  const exportSyncLog = () => {
    const lines = [];
    const start = _syncLogCount < SYNC_LOG_MAX ? 0 : _syncLogHead;
    for (let i = 0; i < _syncLogCount; i++) {
      const e = _syncLogRing[(start + i) % SYNC_LOG_MAX];
      lines.push(`${e.seq}\t${e.t.toFixed(1)}\tf=${e.f}\t${e.msg}`);
    }
    return lines.join('\n');
  };

  // -- Canvas pixel hash + live RDRAM block hash helpers ---------------------

  // Capture the emulator canvas at 64×48 and return a FNV-1a hash of RGB pixels.
  // Returns 0 on any error (no canvas, CORS taint, WebGL buffer cleared, etc.).
  // Reuses a persistent offscreen canvas to avoid GC pressure every sync check.
  const _captureCanvasHash = () => {
    const canvas = document.querySelector('#game canvas');
    if (!canvas || !canvas.width || !canvas.height) return 0;
    try {
      if (!_offscreenCanvas) {
        _offscreenCanvas = document.createElement('canvas');
        _offscreenCanvas.width = 64;
        _offscreenCanvas.height = 48;
        _offscreenCtx = _offscreenCanvas.getContext('2d');
      }
      _offscreenCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 64, 48);
      const data = _offscreenCtx.getImageData(0, 0, 64, 48).data;
      let h = 2166136261;
      for (let i = 0; i < data.length; i += 4) {
        h = Math.imul(h ^ data[i], 16777619) >>> 0;
        h = Math.imul(h ^ data[i + 1], 16777619) >>> 0;
        h = Math.imul(h ^ data[i + 2], 16777619) >>> 0;
      }
      return h;
    } catch (_) {
      return 0;
    }
  };

  // Read block 25 (0x190000) hash from kn_rdram_block_hashes.
  // Block 25 is 92% live during SSB64 match play and outside all known volatile
  // ranges (N64 OS ends ~0x0A3000, RSP/audio ends ~0x0C4000).
  // Allocates only 26 slots (not the full 128) to minimise heap churn.
  const _getBlk25Hash = (mod) => {
    if (!mod._kn_rdram_block_hashes) return 0;
    const buf = mod._malloc(26 * 4);
    mod._kn_rdram_block_hashes(buf, 26);
    const h = mod.HEAPU32[(buf >> 2) + 25] >>> 0;
    mod._free(buf);
    return h;
  };

  // -- Diagnostic logger functions -------------------------------------------

  const _diagShouldLog = (frameNum, interval) => frameNum < DIAG_EARLY_FRAMES || frameNum % interval === 0;

  // DIAG-HASH: compute and stream per-region RDRAM hashes for this player
  // ps0*/ps1*/ps2*/ph1b* are excluded from kn_sync_hash (volatile between iOS WebKit versions) but still sampled here for diagnostics
  const _diagRegionNames = [
    'cfg',
    'ps0*',
    'ps1*',
    'ps2*',
    'ph1a',
    'ph1b*',
    'ph1c',
    'misc',
    'ph2',
    'ph3a',
    'ph3b',
    'ph3c',
  ];
  // Hex lookup table for byte-to-hex conversion
  const _hexLUT = [];
  for (let _hi = 0; _hi < 256; _hi++) _hexLUT[_hi] = (_hi < 16 ? '0' : '') + _hi.toString(16);
  const _bytesToHex = (bytes, off, len) => {
    let s = '';
    for (let i = off; i < off + len; i++) s += _hexLUT[bytes[i]];
    return s;
  };

  const _diagGetRdram = () => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod) return null;
    if (!_hashRegion) {
      getHashBytes();
    }
    if (!_hashRegion?.ptr) return null;
    const buf = mod.HEAPU8 ? mod.HEAPU8.buffer : null;
    if (!buf || buf.byteLength === 0) return null;
    return { live: new Uint8Array(buf), base: _hashRegion.ptr };
  };

  const _diagHash = (frameNum) => {
    if (!_diagShouldLog(frameNum, DIAG_HASH_INTERVAL)) return;
    const rd = _diagGetRdram();
    if (!rd) return;
    const gameRegions = [
      0xa4000, 0xba000, 0xbf000, 0xc4000, 0x262000, 0x266000, 0x26a000, 0x290000, 0x2f6000, 0x32b000, 0x330000,
      0x335000,
    ];
    const SAMPLE = 256;
    const f = frameNum;
    let pending = gameRegions.length;
    const regionHashes = new Array(gameRegions.length);
    for (let gi = 0; gi < gameRegions.length; gi++) {
      ((idx) => {
        const gOff = rd.base + gameRegions[idx];
        const regionBytes = rd.live.slice(gOff, gOff + SAMPLE);
        // NOTE: intentionally fire-and-forget .then() — runs in frame loop, must not block
        workerPost({ type: 'hash', data: regionBytes })
          .then((res) => {
            regionHashes[idx] = res.hash;
            pending--;
            if (pending === 0) {
              const parts = [];
              for (let r = 0; r < regionHashes.length; r++) {
                parts.push(`${_diagRegionNames[r]}=${regionHashes[r]}`);
              }
              _syncLog(`DIAG-HASH f=${f} ${parts.join(' ')}`);
            }
          })
          .catch(() => {
            pending--;
          });
      })(gi);
    }
  };

  // DIAG-DUMP: hex dump of ps0 (0xBA000) and ps1 (0xBF000) — the diverging regions.
  // Dumps 64 bytes from each at 4 sub-offsets (0, 64, 128, 192) to find which
  // part of the 256-byte sample diverges. Runs every DIAG_HASH_INTERVAL frames.
  const _diagDump = (frameNum) => {
    if (!_diagShouldLog(frameNum, DIAG_HASH_INTERVAL)) return;
    const rd = _diagGetRdram();
    if (!rd) return;
    // Dump 4 x 32-byte chunks from ps0 and ps1 (128 hex chars per chunk, manageable)
    const dumpRegions = [
      { name: 'ps0', off: 0xba000 },
      { name: 'ps1', off: 0xbf000 },
    ];
    for (let di = 0; di < dumpRegions.length; di++) {
      const addr = rd.base + dumpRegions[di].off;
      // 4 chunks of 64 bytes = full 256 byte sample
      const hex = _bytesToHex(rd.live, addr, 256);
      _syncLog(`DIAG-DUMP f=${frameNum} ${dumpRegions[di].name} @0x${dumpRegions[di].off.toString(16)} ${hex}`);
    }
  };

  // DIAG-INPUT: read back per-player inputs from WASM memory using discovered addresses
  const _diagInput = (frameNum, applyFrame) => {
    if (!_diagShouldLog(frameNum, DIAG_INPUT_INTERVAL)) return;
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?.HEAPU8) return;
    const mem = mod.HEAPU8;
    const vals = [];
    for (let p = 0; p < 4; p++) {
      const addr = _diagPlayerAddrs[p];
      if (addr === null) {
        vals.push('?');
        continue;
      }
      // Read 4 bytes (32-bit LE) at the player's button 0 address
      if (addr + 3 < mem.length) {
        const v = mem[addr] | (mem[addr + 1] << 8) | (mem[addr + 2] << 16) | (mem[addr + 3] << 24);
        vals.push(v);
      } else {
        vals.push('OOB');
      }
    }
    _syncLog(`DIAG-INPUT f=${frameNum} apply=${applyFrame} p0=${vals[0]} p1=${vals[1]} p2=${vals[2]} p3=${vals[3]}`);
  };

  // DIAG-TIME: timing values after frame step
  const _diagTime = (frameNum, wallBefore, wallAfter) => {
    if (!_diagShouldLog(frameNum, DIAG_TIME_INTERVAL)) return;
    const mod = window.EJS_emulator?.gameManager?.Module;
    const cycleTime = mod?._kn_get_cycle_time_ms ? mod._kn_get_cycle_time_ms() : -1;
    const frameArg = window._kn_frameTime || -1;
    const wallDelta = _diagLastTickTime > 0 ? wallBefore - _diagLastTickTime : 0;
    const stepDuration = wallAfter - wallBefore;
    _syncLog(
      `DIAG-TIME f=${frameNum} cycle=${typeof cycleTime === 'number' ? cycleTime.toFixed(1) : cycleTime} frameArg=${typeof frameArg === 'number' ? frameArg.toFixed(1) : frameArg} wallDelta=${wallDelta.toFixed(1)} stepMs=${stepDuration.toFixed(1)}`,
    );
  };

  // DIAG-EVENT: flush buffered async events
  const _diagFlushEvents = (frameNum) => {
    if (_diagEventLog.length === 0) return;
    for (const ev of _diagEventLog) {
      _syncLog(`DIAG-EVENT f=${frameNum} type=${ev.type} detail=${ev.detail} t=${ev.t.toFixed(1)}`);
    }
    _diagEventLog.length = 0;
  };

  // Install async event hooks (called once at lockstep start)
  const _diagInstallHooks = () => {
    if (_diagHookInstalled) return;
    _diagHookInstalled = true;

    // Visibility change (tab hidden/shown)
    document.addEventListener('visibilitychange', () => {
      _diagEventLog.push({
        t: performance.now(),
        type: 'visibility',
        detail: document.visibilityState,
      });
    });

    // Window focus/blur
    window.addEventListener('focus', () => {
      _diagEventLog.push({ t: performance.now(), type: 'focus', detail: 'gained' });
    });
    window.addEventListener('blur', () => {
      _diagEventLog.push({ t: performance.now(), type: 'focus', detail: 'lost' });
    });

    // Touch events on emulator canvas
    const canvas = document.querySelector('#game canvas, canvas');
    if (canvas) {
      for (const evName of ['touchstart', 'touchend', 'touchmove']) {
        canvas.addEventListener(
          evName,
          (e) => {
            _diagEventLog.push({
              t: performance.now(),
              type: 'touch',
              detail: `${evName}:${e.touches.length}`,
            });
          },
          { passive: true },
        );
      }
    }

    // EJS settings menu open/close (MutationObserver on body for settings panel)
    const observer = new MutationObserver((mutations) => {
      for (const mut of mutations) {
        for (const node of mut.addedNodes) {
          if (
            node.nodeType === 1 &&
            (node.classList.contains('ejs--settings') || (node.querySelector && node.querySelector('.ejs--settings')))
          ) {
            _diagEventLog.push({ t: performance.now(), type: 'ejs-menu', detail: 'opened' });
          }
        }
        for (const rnode of mut.removedNodes) {
          if (
            rnode.nodeType === 1 &&
            (rnode.classList.contains('ejs--settings') ||
              (rnode.querySelector && rnode.querySelector('.ejs--settings')))
          ) {
            _diagEventLog.push({ t: performance.now(), type: 'ejs-menu', detail: 'closed' });
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Monkey-patch pauseMainLoop/resumeMainLoop to detect unexpected pauses
    const diagMod = window.EJS_emulator?.gameManager?.Module;
    if (diagMod) {
      const origPause = diagMod.pauseMainLoop;
      const origResume = diagMod.resumeMainLoop;
      if (origPause) {
        diagMod.pauseMainLoop = function () {
          _diagEventLog.push({ t: performance.now(), type: 'mainloop', detail: 'paused' });
          return origPause.apply(this, arguments);
        };
      }
      if (origResume) {
        diagMod.resumeMainLoop = function () {
          _diagEventLog.push({ t: performance.now(), type: 'mainloop', detail: 'resumed' });
          return origResume.apply(this, arguments);
        };
      }
    }

    _syncLog('DIAG hooks installed');
  };

  let _syncChunks = []; // incoming chunks from host DC
  let _syncExpected = 0; // expected chunk count
  let _syncFrame = 0; // frame number of incoming sync
  let _syncIsFull = true; // true=full state, false=XOR delta
  let _lastResyncTime = 0; // timestamp of last resync request (10s cooldown)
  let _pendingSyncCheck = null; // deferred sync check {frame, hash, peerSid}
  let _pendingResyncState = null; // {bytes, frame} buffered for async apply at frame boundary
  let _hashRegion = null; // {ptr, size} RDRAM pointer for direct HEAPU8 hashing
  // C-level sync: kn_sync_hash/read/write bypass retro_serialize for seamless resync
  let _hasKnSync = false;
  let _syncBufPtr = 0;
  let _syncBufSize = 0;

  // Lazy-allocate the WASM sync buffer. Called before any kn_sync_read/write.
  // Deferred from startup because the 8MB malloc can trigger WASM memory growth
  // which detaches HEAPU8.buffer. Safe to call multiple times (no-op if already allocated).
  const ensureSyncBuffer = () => {
    if (_syncBufPtr) return;
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._malloc) return;
    _syncBufSize = 8 * 1024 * 1024 + 16384;
    _syncBufPtr = mod._malloc(_syncBufSize);
    _syncLog(`sync buffer allocated: ptr=${_syncBufPtr} size=${_syncBufSize}`);
  };
  let _awaitingResync = false; // guest: pause emulator while waiting for resync data
  let _awaitingResyncAt = 0; // timestamp when pause started (safety timeout)

  // Proactive state push: host sends delta state every N frames so guests have a
  // fresh snapshot ready for instant resyncs — no request-response RTT needed.
  const _PROACTIVE_SYNC_INTERVAL = 30; // frames (~1s at 30fps)
  let _preloadedResyncState = null; // {bytes, frame, receivedFrame} — most recent proactive push
  let _syncIsProactive = false; // true when current incoming sync-start is a proactive push

  // Apply buffered proactive state immediately on desync, skipping the round-trip.
  // Returns true if a preloaded state was promoted (caller should NOT send sync-request).
  const _tryApplyPreloaded = () => {
    if (!_preloadedResyncState) return false;
    const age = _frameNum - _preloadedResyncState.receivedFrame;
    if (age >= 120) {
      _preloadedResyncState = null;
      return false;
    }
    _pendingResyncState = _preloadedResyncState;
    _preloadedResyncState = null;
    _lastResyncTime = performance.now();
    _syncLog(`instant resync from preloaded state (age=${age}f frame=${_pendingResyncState.frame})`);
    return true;
  };

  // Drift diagnostics
  let _driftStats = { count: 0, firstAt: 0, lastAt: 0, regions: {} };
  const _driftSummaryAt = [1, 5, 10, 20, 50, 100, 200, 500]; // exponential log intervals

  const _recordDrift = (regionHashes) => {
    const now = performance.now();
    _driftStats.count++;
    if (_driftStats.count === 1) _driftStats.firstAt = now;
    _driftStats.lastAt = now;

    // Tally per-region drifts if available
    if (regionHashes) {
      for (const [name, drifted] of Object.entries(regionHashes)) {
        if (drifted) _driftStats.regions[name] = (_driftStats.regions[name] || 0) + 1;
      }
    }

    // Log summary at exponential intervals
    if (_driftSummaryAt.includes(_driftStats.count) || (_driftStats.count > 0 && _driftStats.count % 100 === 0)) {
      const elapsed = (now - _driftStats.firstAt) / 1000;
      const avgInterval = _driftStats.count > 1 ? Math.round((elapsed * 1000) / (_driftStats.count - 1)) : 0;
      const regionStr = Object.entries(_driftStats.regions)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${v}`)
        .join(' ');
      _syncLog(
        `DRIFT-SUMMARY count=${_driftStats.count} over=${elapsed.toFixed(1)}s avgInterval=${avgInterval}ms regions=[${regionStr}]`,
      );
    }
  };

  const _resetDrift = () => {
    _driftStats = { count: 0, firstAt: 0, lastAt: 0, regions: {} };
  };

  // Frame pacing (GGPO-style frame advantage cap)
  const FRAME_ADV_ALPHA_UP = 0.1; // EMA when advantage is rising (slow to trigger)
  const FRAME_ADV_ALPHA_DOWN = 0.2; // EMA when advantage is falling (fast to release)
  const FRAME_PACING_WARMUP = 120; // skip pacing during first 120 frames (~2s boot)
  let _frameAdvantage = 0; // smoothed frame advantage (EMA)
  let _frameAdvRaw = 0; // instantaneous frame advantage (for logging)
  let _framePacingActive = false; // true when cap is throttling
  // Pacing summary stats (reset every 300 frames)
  let _pacingCapsCount = 0;
  let _pacingCapsFrames = 0;
  let _pacingMaxAdv = 0;
  let _pacingAdvSum = 0;
  let _pacingAdvCount = 0;

  let _inDeterministicStep = false; // gate for performance.now() override during frame step
  let _deterministicPerfNow = null; // saved override function
  let _visChangeHandler = null; // stored for removal in stopSync()
  let _networkChangeHandler = null; // stored for removal in stopSync()
  let _syncWorkerUrl = null; // Blob URL for sync worker (revoke on stop)

  // Spectator streaming state
  let _hostStream = null; // MediaStream for spectator canvas streaming
  let _guestVideo = null; // <video> element (spectator only)

  // Expose for Playwright
  window._playerSlot = _playerSlot;
  window._isSpectator = _isSpectator;
  KNState.peers = _peers;
  KNState.frameNum = 0;

  async function initAudioPlayback() {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod) return;

    if (!mod._kn_get_audio_ptr || !mod._kn_get_audio_samples || !mod._kn_reset_audio || !mod._kn_get_audio_rate) {
      _syncLog('audio capture exports not found — audio disabled');
      return;
    }

    _audioPtr = mod._kn_get_audio_ptr();
    _audioRate = mod._kn_get_audio_rate();
    if (!_audioRate || _audioRate <= 0) {
      _syncLog('audio rate not set yet, defaulting to 33600');
      _audioRate = 33600;
    }

    try {
      // Reuse gesture-created context if available (already running on mobile).
      // For mobile hosts, play.js pre-creates one in the startGame() click handler
      // (window._kn_preloadedAudioCtx) since the engine starts audio 30+ seconds
      // after the gesture — past iOS's trust window.
      if (!_audioCtx || _audioCtx.state === 'closed') {
        const preloaded = window._kn_preloadedAudioCtx;
        if (preloaded && preloaded.state !== 'closed') {
          _audioCtx = preloaded;
          delete window._kn_preloadedAudioCtx;
          _syncLog(
            `reusing host gesture-created AudioContext (state: ${_audioCtx.state}, rate: ${_audioCtx.sampleRate})`,
          );
        } else {
          _audioCtx = new AudioContext({ sampleRate: _audioRate, latencyHint: 'interactive' });
        }
      } else {
        _syncLog(`reusing gesture-created AudioContext (state: ${_audioCtx.state}, rate: ${_audioCtx.sampleRate})`);
        // Keep the gesture oscillator alive until a real audio node is connected.
        // Stopping it now would leave _audioCtx with no active sources during the
        // async AudioWorklet probe, causing iOS to deactivate the audio session.
      }

      // Try AudioWorklet first (requires secure context), fall back to
      // AudioBufferSourceNode scheduling (works everywhere including mobile HTTP).
      let workletOk = false;
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
          _syncLog('audio using AudioWorklet');
        } catch (wErr) {
          _syncLog(`AudioWorklet failed, using fallback: ${wErr.message}`);
          KNEvent('audio-fail', `AudioWorklet failed: ${wErr.message}`, { error: wErr.message });
        }
      }

      if (!workletOk) {
        // Fallback: ScriptProcessorNode with ring buffer.
        // AudioBufferSourceNode per-frame scheduling doesn't produce sound
        // on iOS WKWebView (FxiOS). ScriptProcessorNode continuously pulls
        // audio, keeping the iOS audio session active.
        _audioWorklet = null;
        const ringSize = Math.ceil(_audioRate * 0.1) * 2; // ~100ms stereo
        window._kn_audioRing = new Float32Array(ringSize);
        window._kn_audioRingWrite = 0;
        window._kn_audioRingRead = 0;
        window._kn_audioRingCount = 0;
        const spNode = _audioCtx.createScriptProcessor(2048, 0, 2);
        spNode.onaudioprocess = (e) => {
          const outL = e.outputBuffer.getChannelData(0);
          const outR = e.outputBuffer.getChannelData(1);
          const ring = window._kn_audioRing;
          const rSize = ring.length;
          for (let si = 0; si < outL.length; si++) {
            if (window._kn_audioRingCount >= 2) {
              outL[si] = ring[window._kn_audioRingRead];
              outR[si] = ring[(window._kn_audioRingRead + 1) % rSize];
              window._kn_audioRingRead = (window._kn_audioRingRead + 2) % rSize;
              window._kn_audioRingCount -= 2;
            } else {
              outL[si] = 0;
              outR[si] = 0;
            }
          }
        };
        if (_playerSlot === 0) {
          _audioDestNode = _audioCtx.createMediaStreamDestination();
          spNode.connect(_audioDestNode);
        }
        // Route through the gesture-created <audio> element's MediaStream.
        // iOS FxiOS ignores ScriptProcessorNode → destination but honors
        // <audio>.play() started within a user gesture. Fall back to direct
        // destination connection on desktop (no gesture audio element).
        const gestureDest = window._kn_gestureAudioDest;
        if (gestureDest) {
          spNode.connect(gestureDest);
          _syncLog(`audio using ScriptProcessorNode fallback via <audio> element (ring=${ringSize})`);
        } else {
          spNode.connect(_audioCtx.destination);
          _syncLog(`audio using ScriptProcessorNode fallback (ring=${ringSize})`);
        }
        window._kn_scriptProcessor = spNode;
      }

      // NOW stop the keep-alive oscillator — a real audio node is connected,
      // so the iOS audio session stays alive across the handoff.
      if (window._kn_keepAliveOsc) {
        try {
          window._kn_keepAliveOsc.stop();
        } catch (_) {}
        window._kn_keepAliveOsc = null;
      }

      _audioReady = true;

      // Resume AudioContext on user interaction (autoplay policy).
      // Use capture phase so EmulatorJS virtual controls can't block via
      // stopPropagation. Retry on every interaction until actually running.
      if (_audioCtx.state !== 'running') {
        const resumeAudio = async () => {
          if (!_audioCtx || _audioCtx.state === 'running') {
            document.removeEventListener('click', resumeAudio, true);
            document.removeEventListener('keydown', resumeAudio, true);
            document.removeEventListener('touchstart', resumeAudio, true);
            return;
          }
          try {
            await _audioCtx.resume();
            _syncLog(`audio resumed via gesture (state: ${_audioCtx.state})`);
            document.removeEventListener('click', resumeAudio, true);
            document.removeEventListener('keydown', resumeAudio, true);
            document.removeEventListener('touchstart', resumeAudio, true);
          } catch (e) {
            _syncLog(`audio resume failed: ${e.message}`);
          }
        };
        document.addEventListener('click', resumeAudio, true);
        document.addEventListener('keydown', resumeAudio, true);
        document.addEventListener('touchstart', resumeAudio, true);
        _syncLog(`audio context state: ${_audioCtx.state} — waiting for gesture to resume`);
      }

      _syncLog(`audio playback initialized (rate: ${_audioRate})`);
    } catch (err) {
      _syncLog(`audio init failed: ${err}`);
      _audioReady = false;
    }
  }

  let _audioFeedCount = 0;
  let _audioEmptyCount = 0;
  const feedAudio = () => {
    if (!_audioReady || !_audioCtx) return;
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod) return;

    const n = mod._kn_get_audio_samples();
    if (n <= 0) {
      _audioEmptyCount++;
      // Log once after 300 consecutive empty frames (~5s) to detect silent audio
      if (_audioEmptyCount === 300) {
        _syncLog(
          `audio-silent: ${_audioEmptyCount} consecutive frames with 0 samples (ptr=${_audioPtr} ctx=${_audioCtx.state})`,
        );
      }
      return;
    }
    _audioEmptyCount = 0;

    // Log audio state periodically (every 600 frames ≈ 10s)
    _audioFeedCount++;
    if (_audioFeedCount === 1 || _audioFeedCount % 600 === 0) {
      // Check PCM level (RMS of first 100 samples)
      const pcmCheck = new Int16Array(mod.HEAPU8.buffer, _audioPtr, Math.min(n * 2, 200));
      let rms = 0;
      for (let ci = 0; ci < pcmCheck.length; ci++) rms += pcmCheck[ci] * pcmCheck[ci];
      rms = Math.sqrt(rms / pcmCheck.length);
      _syncLog(
        `audio-feed #${_audioFeedCount} ctx=${_audioCtx.state} samples=${n} time=${_audioCtx.currentTime.toFixed(2)} worklet=${!!_audioWorklet} rms=${rms.toFixed(1)} ringCount=${window._kn_audioRingCount || 0}`,
      );
    }

    const pcm = new Int16Array(mod.HEAPU8.buffer, _audioPtr, n * 2);

    if (_audioWorklet) {
      // AudioWorklet path
      const copy = new Int16Array(pcm);
      _audioWorklet.port.postMessage(copy, [copy.buffer]);
    } else {
      // ScriptProcessorNode fallback — push PCM to ring buffer.
      // The ScriptProcessorNode's onaudioprocess callback pulls from it.
      const ring = window._kn_audioRing;
      if (ring) {
        const rSize = ring.length;
        for (let i = 0; i < n; i++) {
          ring[window._kn_audioRingWrite] = pcm[i * 2] / 32768.0;
          ring[(window._kn_audioRingWrite + 1) % rSize] = pcm[i * 2 + 1] / 32768.0;
          window._kn_audioRingWrite = (window._kn_audioRingWrite + 2) % rSize;
        }
        window._kn_audioRingCount += n * 2;
        if (window._kn_audioRingCount > rSize) window._kn_audioRingCount = rSize;
      }
    }
  };

  const setStatus = (msg) => {
    if (_config?.onStatus) _config.onStatus(msg);
    _syncLog(msg);
  };

  const onDataMessage = (msg) => {
    if (!msg?.type) return;
    if (msg.type === 'save-state') handleSaveStateMsg(msg);
    if (msg.type === 'late-join-state') handleLateJoinState(msg);
    if (msg.type === 'request-late-join') handleLateJoinRequest(msg);
  };

  const handleLateJoinRequest = (msg) => {
    // Only host responds to late-join requests
    if (_playerSlot !== 0 || !_running) return;
    const requesterSid = msg.requesterSid;
    if (!requesterSid) return;
    _syncLog(`received late-join request from ${requesterSid}`);
    sendLateJoinState(requesterSid);
  };

  // -- users-updated ---------------------------------------------------------

  const onUsersUpdated = (data) => {
    const { players = {}, spectators = {} } = data;

    // Rebuild known players map
    _knownPlayers = {};
    for (const p of Object.values(players)) {
      _knownPlayers[p.socketId] = { slot: p.slot, playerName: p.playerName };
    }

    // Update my slot from server (handles spectator -> player transition)
    const myPlayerEntry = Object.values(players).find((p) => p.socketId === socket.id);
    if (myPlayerEntry) {
      if (_isSpectator) {
        _syncLog(`transitioned from spectator to player, slot: ${myPlayerEntry.slot}`);
        _isSpectator = false;
        window._isSpectator = false;
      }
      _playerSlot = myPlayerEntry.slot;
      window._playerSlot = _playerSlot;
    }

    const otherPlayers = Object.values(players).filter((p) => p.socketId !== socket.id);

    // Establish mesh connections to other players
    // Normal: lower slot initiates (creates data channel + sends offer)
    // Late-join: joiner always initiates (host's offer would arrive before listener is ready)
    // Running host: DON'T initiate to new players — let them initiate after their init()
    for (const p of otherPlayers) {
      if (_peers[p.socketId]) {
        _peers[p.socketId].slot = p.slot;
        continue;
      }

      let shouldInitiate;
      if (_lateJoin && !_isSpectator) {
        shouldInitiate = true; // late-joiner always initiates
      } else if (_running) {
        shouldInitiate = false; // running host waits for late-joiner's offer
      } else if (_isSpectator) {
        shouldInitiate = false; // spectators never initiate
      } else {
        shouldInitiate = _playerSlot < p.slot;
      }

      createPeer(p.socketId, p.slot, shouldInitiate);
      if (shouldInitiate) sendOffer(p.socketId);
    }

    // Players initiate connections to spectators
    if (!_isSpectator) {
      const specList = Object.values(spectators);
      for (const s of specList) {
        if (s.socketId === socket.id) continue;
        if (_peers[s.socketId]) continue;
        createPeer(s.socketId, null, true);
        sendOffer(s.socketId);
      }
    }

    // Notify controller
    _config?.onPlayersChanged?.(data);
  };

  // -- WebRTC multi-peer mesh ------------------------------------------------

  const createPeer = (remoteSid, remoteSlot, isInitiator) => {
    const peerGuard = (p) => _peers[remoteSid] === p;
    const peer = KNShared.createBasePeer(ICE_SERVERS, remoteSid, socket, peerGuard);
    peer.slot = remoteSlot;
    peer.ready = false;
    peer.emuReady = false;
    peer.rttSamples = [];

    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      _syncLog(`peer ${remoteSid} connection-state: ${s}`);
      if (s === 'connecting') setStatus('Connecting to players...');
      if (s === 'connected') {
        // Clear any pending disconnect grace timer — connection recovered
        if (peer._disconnectTimer) {
          clearTimeout(peer._disconnectTimer);
          peer._disconnectTimer = null;
          _syncLog(`peer ${remoteSid} reconnected (ICE recovery)`);
          setStatus('Connected -- game on!');
          // Reset sync backoff so next desync check happens within ~1s
          // (connection hiccup likely caused a desync — don't wait 30s)
          _consecutiveResyncs = 0;
          _syncCheckInterval = _syncBaseInterval;
          _resetDrift();
        }
      }
      if (s === 'failed') {
        // Failed is terminal — disconnect immediately
        KNEvent('webrtc-fail', 'Peer connection failed', { slot: peer.slot, remoteSid });
        if (peer._disconnectTimer) {
          clearTimeout(peer._disconnectTimer);
          peer._disconnectTimer = null;
        }
        if (_peers[remoteSid] !== peer) return;
        setStatus('Player dropped — connection failed');
        handlePeerDisconnect(remoteSid);
      }
      if (s === 'disconnected') {
        // Disconnected is recoverable — give ICE time to reconnect (mobile-friendly)
        if (_peers[remoteSid] !== peer) return;
        if (!peer._disconnectTimer) {
          setStatus('Player connection unstable...');
          peer._disconnectTimer = setTimeout(() => {
            peer._disconnectTimer = null;
            // Still disconnected or failed after grace period — give up
            const currentState = peer.pc.connectionState;
            if (currentState === 'disconnected' || currentState === 'failed') {
              _syncLog(`peer ${remoteSid} disconnect grace expired (was ${currentState})`);
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
      peer.pc.ontrack = (event) => {
        _syncLog(`received track: ${event.track.kind}`);
        showSpectatorVideo(event, peer);
      };
    }

    _peers[remoteSid] = peer;
    KNState.peers = _peers;

    if (isInitiator) {
      peer.dc = peer.pc.createDataChannel('lockstep', {
        ordered: true,
      });
      setupDataChannel(remoteSid, peer.dc);
      // Delegate non-lockstep channels created by remote
      peer.pc.ondatachannel = (e) => {
        if (e.channel.label === 'lockstep') {
          peer.dc = e.channel;
          setupDataChannel(remoteSid, peer.dc);
        } else if (_onExtraDataChannel) {
          _onExtraDataChannel(remoteSid, e.channel);
        }
      };
    } else {
      peer.pc.ondatachannel = (e) => {
        if (e.channel.label === 'lockstep') {
          peer.dc = e.channel;
          setupDataChannel(remoteSid, peer.dc);
        } else if (_onExtraDataChannel) {
          _onExtraDataChannel(remoteSid, e.channel);
        }
      };
    }
    return peer;
  };

  async function sendOffer(remoteSid) {
    const peer = _peers[remoteSid];
    if (!peer) return;
    await KNShared.createAndSendOffer(peer.pc, socket, remoteSid);
  }

  async function onWebRTCSignal(data) {
    if (!data) return;
    const senderSid = data.sender;
    if (!senderSid) return;

    // Create peer on demand if offer arrives before users-updated
    if (data.offer && !_peers[senderSid]) {
      const known = _knownPlayers[senderSid];
      createPeer(senderSid, known ? known.slot : null, false);
    }

    let peer = _peers[senderSid];
    if (!peer) return;

    try {
      if (data.offer) {
        // Reconnect: if peer exists and reconnect flag set, replace old PC
        if (data.reconnect && _peers[senderSid]) {
          const existingPeer = _peers[senderSid];
          _syncLog(`received reconnect offer from ${senderSid}`);

          const peerGuard = (p) => _peers[senderSid] === p;
          KNShared.resetPeerConnection(existingPeer, ICE_SERVERS, senderSid, socket, peerGuard);
          existingPeer.ready = false;

          existingPeer.pc.onconnectionstatechange = () => {
            const s = existingPeer.pc.connectionState;
            _syncLog(`reconnect peer ${senderSid} connection-state: ${s}`);
          };
          existingPeer.pc.ondatachannel = (e) => {
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
        await KNShared.drainCandidates(peer);
        await KNShared.createAndSendAnswer(peer.pc, socket, senderSid);
      } else if (data.answer) {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await KNShared.drainCandidates(peer);
      } else if (data.candidate) {
        await KNShared.addBufferedCandidate(peer, data.candidate);
      }
    } catch (err) {
      _syncLog(`WebRTC signal error: ${err.message || err}`);
      setStatus(`WebRTC error: ${err.message || err}`);
    }
  }

  // -- Data channel ----------------------------------------------------------

  const setupDataChannel = (remoteSid, ch) => {
    ch.binaryType = 'arraybuffer';

    ch.onopen = () => {
      const peer = _peers[remoteSid];
      if (!peer) return;
      const known = _knownPlayers[remoteSid];
      const peerName = known ? known.playerName : `P${(peer.slot ?? 0) + 1}`;
      _syncLog(`DC open with ${remoteSid} slot: ${peer.slot} ${peerName}`);
      setStatus(`Connected to ${peerName}`);
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
        if (peer._reconnectTimeout) {
          clearTimeout(peer._reconnectTimeout);
          peer._reconnectTimeout = null;
        }
        peer.reconnecting = false;
        // Only guests should null their delta base on reconnect.
        // Host needs its delta base to survive peer lifecycle events.
        if (_playerSlot !== 0) {
          _setLastSyncState(null, 'reconnect');
        }
        const rKnown = _knownPlayers[remoteSid];
        const rName = rKnown ? rKnown.playerName : `P${(peer.slot ?? 0) + 1}`;
        setStatus(`${rName} reconnected`);
        _config?.onToast?.(`${rName} reconnected`);
        _config?.onReconnecting?.(remoteSid, false);
        _config?.onPeerReconnected?.(remoteSid);
        // Request resync
        if (_playerSlot !== 0) {
          try {
            ch.send('sync-request');
          } catch (_) {}
        } else {
          _consecutiveResyncs = 0;
          _syncCheckInterval = _syncBaseInterval;
          _resetDrift();
        }
      }

      if (!_gameStarted) startGameSequence();
    };

    ch.onclose = () => {
      // Guard: ignore stale close events from replaced peers after restart
      const current = _peers[remoteSid];
      if (!current || current.dc !== ch) return;
      _syncLog(`DC closed with ${remoteSid}`);
      handlePeerDisconnect(remoteSid);
    };

    ch.onerror = (e) => {
      _syncLog(`DC error: ${remoteSid} ${e}`);
    };

    ch.onmessage = (e) => {
      const peer = _peers[remoteSid];
      if (!peer) return;

      // String messages
      if (typeof e.data === 'string') {
        if (e.data === 'ready') {
          peer.ready = true;
        }
        if (e.data === 'emu-ready') {
          peer.emuReady = true;
          checkAllEmuReady();
        }
        if (e.data === 'leaving') {
          peer._intentionalLeave = true;
          return;
        }
        if (e.data.startsWith('resend:')) {
          const resendFrame = parseInt(e.data.split(':')[1], 10);
          const localInput = _localInputs[resendFrame];
          if (localInput !== undefined) {
            try {
              peer.dc.send(KNShared.encodeInput(resendFrame, localInput).buffer);
            } catch (_) {}
          }
          return;
        }
        if (e.data === 'peer-resumed') {
          const known = _knownPlayers[remoteSid];
          const name = known ? known.playerName : `P${(peer.slot ?? 0) + 1}`;
          _config?.onToast?.(`${name} returned`);
          return;
        }
        // State sync: hash check from host
        // IMPORTANT: only compare when we're at the SAME frame as the host.
        // Comparing at different frames always shows a diff (not a real desync).
        if (e.data.startsWith('sync-hash:')) {
          if (peer.slot !== 0) return;
          if (_pendingResyncState) return;
          const parts = e.data.split(':');
          const syncFrame = parseInt(parts[1], 10);
          const hostHash = parseInt(parts[2], 10);
          const hostCycleMs = parts[3] !== undefined ? parseFloat(parts[3]) : null;
          // Named fields blk25= and ph= may appear anywhere after part[3].
          // Filter them out before building the numeric regions array.
          const blk25Part = parts.find((p) => p.startsWith('blk25='));
          const hostBlk25 = blk25Part ? parseInt(blk25Part.slice(6), 10) >>> 0 : 0;
          const phPart = parts.find((p) => p.startsWith('ph='));
          const hostPixelHash = phPart ? parseInt(phPart.slice(3), 10) >>> 0 : 0;
          const hostRegions =
            parts.length > 4
              ? parts
                  .slice(4)
                  .filter((p) => !p.includes('='))
                  .map((v) => parseInt(v, 10) >>> 0)
              : null;
          const frameDiff = _frameNum - syncFrame;
          if (_frameNum === syncFrame || (_frameNum > syncFrame && frameDiff <= 2)) {
            _syncLog(
              `sync check received: hostFrame=${syncFrame} myFrame=${_frameNum} (diff=${frameDiff}) — comparing`,
            );
            if (_hasKnSync) {
              // C-level hash — synchronous comparison
              const mod = window.EJS_emulator?.gameManager?.Module;
              if (!mod) return;
              const guestHash = mod._kn_sync_hash();
              if (guestHash !== hostHash) {
                // Collect per-region hashes before KNEvent so they're included in payload
                let localRegions = null;
                let diffRegions = null;
                if (mod._kn_sync_hash_regions) {
                  const hashBuf = mod._malloc(48);
                  const regionCount = mod._kn_sync_hash_regions(hashBuf, 12);
                  localRegions = [];
                  for (let ri = 0; ri < regionCount; ri++) localRegions.push(mod.HEAPU32[(hashBuf >> 2) + ri] >>> 0);
                  mod._free(hashBuf);
                  if (hostRegions) {
                    diffRegions = _diagRegionNames.filter(
                      (_, ri) => hostRegions[ri] !== undefined && localRegions[ri] !== hostRegions[ri],
                    );
                  }
                }
                _syncLog(`DESYNC frame=${syncFrame} local=${guestHash} host=${hostHash}`);
                const _nowDesync = performance.now();
                if (_nowDesync - _lastDesyncEventTime > 10000) {
                  _lastDesyncEventTime = _nowDesync;
                  KNEvent('desync', `Desync at frame ${syncFrame}`, {
                    frame: syncFrame,
                    local: guestHash,
                    host: hostHash,
                    ...(localRegions && {
                      localRegions: Object.fromEntries(localRegions.map((h, ri) => [_diagRegionNames[ri], h])),
                    }),
                    ...(hostRegions && {
                      hostRegions: Object.fromEntries(hostRegions.map((h, ri) => [_diagRegionNames[ri], h])),
                    }),
                    ...(diffRegions?.length && { diffRegions }),
                  });
                }
                KNState.sessionStats.desyncs++;
                _recordDrift(null);
                if (hostCycleMs !== null && mod._kn_get_cycle_time_ms) {
                  const guestCycleMs = mod._kn_get_cycle_time_ms();
                  _syncLog(
                    `CYCLE-DRIFT host=${hostCycleMs.toFixed(1)}ms guest=${guestCycleMs.toFixed(1)}ms diff=${(guestCycleMs - hostCycleMs).toFixed(1)}ms`,
                  );
                }
                if (localRegions) {
                  _syncLog(
                    `REGION-HASH local ${localRegions.map((h, ri) => `${_diagRegionNames[ri]}=${h}`).join(' ')}`,
                  );
                  if (hostRegions) {
                    _syncLog(
                      `REGION-HASH host  ${hostRegions.map((h, ri) => `${_diagRegionNames[ri]}=${h}`).join(' ')}`,
                    );
                    if (diffRegions?.length) _syncLog(`REGION-DIFF ${diffRegions.join(' ')}`);
                  }
                }
                _syncMismatchStreak++;
                const now2 = performance.now();
                const cooldownElapsed = now2 - _lastResyncTime;
                if (_tryApplyPreloaded()) {
                  // instant resync — no round-trip needed
                } else if (cooldownElapsed > _resyncCooldownMs()) {
                  _lastResyncTime = now2;
                  const forceFull = _syncMismatchStreak >= MISMATCH_FULL_RESYNC_THRESHOLD;
                  const reqType = forceFull ? 'sync-request-full' : 'sync-request';
                  _syncLog(
                    `sending ${reqType} (cooldown=${Math.round(cooldownElapsed)}ms streak=${_syncMismatchStreak})`,
                  );
                  try {
                    peer.dc.send(reqType);
                  } catch (e) {
                    _syncLog(`sync-request send failed: ${e}`);
                  }
                } else {
                  _syncLog(`DESYNC but cooldown active (${Math.round(cooldownElapsed)}ms / ${_resyncCooldownMs()}ms)`);
                }
              } else {
                // RDRAM anchor hash matches — verify with live block 25 and pixel hash.
                // blk25 triggers resyncs: session 0OV63I8X confirmed the burst-then-stable
                // pattern means each burst IS self-correcting (blk25=✓ immediately after
                // the last resync sticks). The pixel hash is log-only due to the persistent
                // 1-frame timing gap that causes false positives on every check.
                let extraDesync = false;

                if (hostBlk25) {
                  const guestBlk25 = _getBlk25Hash(mod);
                  if (guestBlk25 && guestBlk25 !== hostBlk25) {
                    extraDesync = true;
                    _syncLog(`BLK25-DESYNC frame=${syncFrame} local=${guestBlk25} host=${hostBlk25}`);
                    KNState.sessionStats.desyncs++;
                    _recordDrift(null);
                    const now2 = performance.now();
                    const cooldownElapsed = now2 - _lastResyncTime;
                    if (_tryApplyPreloaded()) {
                      // instant resync
                    } else if (cooldownElapsed > _resyncCooldownMs()) {
                      _lastResyncTime = now2;
                      _syncLog(`sending sync-request (blk25 mismatch, cooldown=${Math.round(cooldownElapsed)}ms)`);
                      try {
                        peer.dc.send('sync-request');
                      } catch (e) {
                        _syncLog(`sync-request send failed: ${e}`);
                      }
                    } else {
                      _syncLog(
                        `BLK25-DESYNC but cooldown active (${Math.round(cooldownElapsed)}ms / ${_resyncCooldownMs()}ms)`,
                      );
                    }
                  }
                }

                // Pixel comparison is log-only — never triggers sync-request.
                // Guest is consistently 1 frame ahead → pixel hashes capture different
                // rendered frames → false mismatch on virtually every check.
                let pixelMatchedStr = '';
                if (!extraDesync && hostPixelHash) {
                  const guestPixelHash = _captureCanvasHash();
                  const postResync = _lastResyncFrame > 0 && _frameNum - _lastResyncFrame <= _syncCheckInterval * 2;
                  if (guestPixelHash && guestPixelHash !== hostPixelHash) {
                    _syncLog(
                      `PIXEL-DESYNC frame=${syncFrame} local=${guestPixelHash} host=${hostPixelHash}${postResync ? ' [post-resync]' : ''}`,
                    );
                    pixelMatchedStr = ' pixel=✗';
                  } else if (guestPixelHash) {
                    pixelMatchedStr = ` pixel=✓${postResync ? ' RESYNC-VISUAL-OK' : ''}`;
                  }
                }

                if (!extraDesync) {
                  const verifiedStr = (hostBlk25 ? ' blk25=✓' : '') + pixelMatchedStr;
                  _syncLog(`sync OK frame=${syncFrame} hash=${guestHash}${verifiedStr}`);
                  _consecutiveResyncs = 0;
                  _syncMismatchStreak = 0;
                  _syncCheckInterval = _syncBaseInterval;
                  _resetDrift();
                }
              }
            } else {
              // Fallback: async hash via HEAPU8 (RDRAM) — avoids expensive getState()
              try {
                const guestBytes = getHashBytes();
                if (!guestBytes) return;
                const peerRef = peer;
                // NOTE: intentionally fire-and-forget .then() — runs in frame loop, must not block
                workerPost({ type: 'hash', data: guestBytes })
                  .then((res) => {
                    if (res.hash !== hostHash) {
                      _syncLog(`DESYNC frame=${syncFrame} local=${res.hash} host=${hostHash}`);
                      _recordDrift(null);
                      const now2 = performance.now();
                      if (_tryApplyPreloaded()) {
                        // instant resync
                      } else if (!_pendingResyncState && now2 - _lastResyncTime > _resyncCooldownMs()) {
                        _lastResyncTime = now2;
                        try {
                          peerRef.dc.send('sync-request');
                        } catch (_) {}
                        _syncLog('sync-request sent');
                      }
                    } else {
                      _syncLog(`sync OK frame=${syncFrame} hash=${res.hash}`);
                      _consecutiveResyncs = 0;
                      _syncCheckInterval = _syncBaseInterval;
                      _resetDrift();
                    }
                  })
                  .catch((e) => _syncLog(`sync hash worker failed: ${e.message || e}`));
              } catch (_) {}
            }
          } else if (_frameNum < syncFrame) {
            _syncLog(
              `sync check deferred: hostFrame=${syncFrame} myFrame=${_frameNum} (behind by ${syncFrame - _frameNum})`,
            );
            _pendingSyncCheck = {
              frame: syncFrame,
              hash: hostHash,
              peerSid: remoteSid,
              hostRegions,
              hostBlk25,
              hostPixelHash,
            };
          } else {
            _syncLog(`sync check skipped: hostFrame=${syncFrame} myFrame=${_frameNum} (ahead by ${frameDiff})`);
          }
        }
        // State sync: host received request, or chunked binary transfer header
        if ((e.data === 'sync-request' || e.data === 'sync-request-full') && _playerSlot === 0) {
          const forceFull = e.data === 'sync-request-full';
          _syncLog(`received ${e.data} from ${remoteSid}`);
          if (forceFull) _setLastSyncState(null, 'guest-requested-full');
          pushSyncState(remoteSid);
        }
        if (e.data.startsWith('sync-start:')) {
          const parts = e.data.split(':');
          _syncFrame = parseInt(parts[1], 10);
          _syncExpected = parseInt(parts[2], 10);
          _syncIsFull = parts[3] === '1';
          _syncIsProactive = parts[4] === '1';
          _syncChunks = [];
          _syncLog(
            `sync-start received: frame=${_syncFrame} expected=${_syncExpected} full=${_syncIsFull} proactive=${_syncIsProactive}`,
          );
        }
        // JSON messages
        if (e.data.charAt(0) === '{') {
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === 'save-state') handleSaveStateMsg(msg);
            else if (msg.type === 'late-join-state') handleLateJoinState(msg);
            else if (msg.type === 'delay-ping') {
              peer.dc.send(JSON.stringify({ type: 'delay-pong', ts: msg.ts }));
            } else if (msg.type === 'delay-pong') {
              handleDelayPong(msg.ts, peer);
            } else if (msg.type === 'lockstep-ready') {
              peer.delayValue = msg.delay || 2;
              _lockstepReadyPeers[remoteSid] = true;
              checkAllLockstepReady();
            } else if (msg.type === 'delay-update') {
              if (typeof msg.delay === 'number' && msg.delay > DELAY_FRAMES) {
                DELAY_FRAMES = msg.delay;
                _syncLog(`delay updated to ${msg.delay}f by peer (reconnect)`);
              }
            } else if (_onUnhandledMessage) {
              _onUnhandledMessage(remoteSid, msg);
            }
          } catch (_) {}
        }
        return;
      }

      // Binary: sync state chunk or input (16 bytes).
      // Sync chunks only arrive between sync-start and completion (_syncExpected > 0).
      if (e.data instanceof ArrayBuffer && e.data.byteLength !== 16) {
        if (_syncExpected > 0) {
          _syncChunks.push(new Uint8Array(e.data));
          if (_syncChunks.length >= _syncExpected) {
            _syncLog(`sync chunks complete: ${_syncChunks.length}/${_syncExpected} chunks received`);
            handleSyncChunksComplete();
          }
          return;
        }
        // Binary data arrived but no sync-start header received — log and drop
        _syncLog(`WARN: binary data (${e.data.byteLength}B) arrived but _syncExpected=0 — dropped`);
        return;
      }
      // Binary: encoded input -- 16 bytes per input
      if (e.data instanceof ArrayBuffer && e.data.byteLength === 16) {
        if (peer.slot === null || peer.slot === undefined) return; // spectators don't send input
        const decoded = KNShared.decodeInput(e.data);
        const recvFrame = decoded.frame;
        const recvInput = { buttons: decoded.buttons, lx: decoded.lx, ly: decoded.ly, cx: decoded.cx, cy: decoded.cy };
        if (!_remoteInputs[peer.slot]) _remoteInputs[peer.slot] = {};
        // Log if we receive input for a frame we already applied (too late)
        const currentApply = _frameNum - DELAY_FRAMES;
        if (_running && recvFrame < currentApply) {
          const now = performance.now();
          if (!_inputLateLogTime[peer.slot] || now - _inputLateLogTime[peer.slot] >= 1000) {
            _inputLateLogTime[peer.slot] = now;
            _syncLog(
              `INPUT-LATE slot=${peer.slot} recvF=${recvFrame} applyF=${currentApply} behind=${currentApply - recvFrame}`,
            );
          }
        }
        _remoteInputs[peer.slot][recvFrame] = recvInput;
        _lastKnownInput[peer.slot] = recvInput;
        if (!_peerInputStarted[peer.slot]) {
          _peerInputStarted[peer.slot] = true;
          _syncLog(`INPUT-FIRST slot=${peer.slot} f=${recvFrame} myF=${_frameNum}`);
        }
        _remoteReceived++;
        if (recvFrame > _lastRemoteFrame) _lastRemoteFrame = recvFrame;
        if (!_lastRemoteFramePerSlot[peer.slot] || recvFrame > _lastRemoteFramePerSlot[peer.slot]) {
          _lastRemoteFramePerSlot[peer.slot] = recvFrame;
          _peerLastAdvanceTime[peer.slot] = performance.now();
          // Peer recovered from phantom — clear phantom state
          if (_peerPhantom[peer.slot]) {
            _syncLog(`PEER-RECOVERED slot=${peer.slot} f=${recvFrame} — resuming normal pacing`);
            _peerPhantom[peer.slot] = false;
            _consecutiveFabrications[peer.slot] = 0;
            window.dispatchEvent(new CustomEvent('kn-peer-recovered', { detail: { slot: peer.slot } }));
          }
        }
      }
    };
  };

  // -- Peer disconnect (drop handling) ---------------------------------------

  const handlePeerDisconnect = (remoteSid) => {
    const peer = _peers[remoteSid];
    if (!peer) return;
    if (peer._disconnectTimer) {
      clearTimeout(peer._disconnectTimer);
      peer._disconnectTimer = null;
    }

    // If game is running and not an intentional leave, attempt reconnect
    if (_running && !peer._intentionalLeave) {
      _syncLog(`peer ${remoteSid} DC died — attempting reconnect`);

      // Zero their input but keep peer in _peers
      if (peer.slot !== null && peer.slot !== undefined) {
        try {
          writeInputToMemory(peer.slot, 0);
        } catch (_) {}
      }
      peer.reconnecting = true;
      peer.reconnectStart = Date.now();

      const known = _knownPlayers[remoteSid];
      const name = known ? known.playerName : `P${(peer.slot ?? 0) + 1}`;
      setStatus(`${name} disconnected — reconnecting...`);
      _config?.onToast?.(`${name} disconnected — reconnecting...`);
      _config?.onReconnecting?.(remoteSid, true);

      // Lower slot initiates reconnect
      if (_playerSlot < peer.slot) {
        attemptReconnect(remoteSid);
      }

      // 15-second timeout — give up and hard disconnect
      peer._reconnectTimeout = setTimeout(() => {
        if (!_peers[remoteSid] || !_peers[remoteSid].reconnecting) return;
        _syncLog(`reconnect timeout for ${remoteSid}`);
        hardDisconnectPeer(remoteSid);
      }, 15000);

      return;
    }

    hardDisconnectPeer(remoteSid);
  };

  const hardDisconnectPeer = (remoteSid) => {
    const peer = _peers[remoteSid];
    if (!peer) return;
    if (peer._reconnectTimeout) {
      clearTimeout(peer._reconnectTimeout);
      peer._reconnectTimeout = null;
    }

    if (peer.slot !== null && peer.slot !== undefined) {
      try {
        writeInputToMemory(peer.slot, 0);
      } catch (_) {}
      delete _remoteInputs[peer.slot];
      delete _peerInputStarted[peer.slot];
    }

    delete _peers[remoteSid];
    delete _lockstepReadyPeers[remoteSid];
    KNState.peers = _peers;
    _syncLog(`peer hard-disconnected: ${remoteSid} slot: ${peer.slot}`);

    const known = _knownPlayers[remoteSid];
    const name = known ? known.playerName : `P${(peer.slot ?? 0) + 1}`;

    const remaining = getActivePeers();
    if (remaining.length === 0 && _running) {
      setStatus('All peers disconnected -- running solo');
    } else if (_running) {
      const count = remaining.length + 1;
      setStatus(`${name} dropped -- ${count} player${count > 1 ? 's' : ''} remaining`);
    }
    _config?.onToast?.(`${name} dropped`);
    _config?.onReconnecting?.(remoteSid, false);
  };

  const attemptReconnect = async (remoteSid) => {
    const peer = _peers[remoteSid];
    if (!peer || !peer.reconnecting) return;

    _syncLog(`initiating reconnect to ${remoteSid}`);

    const peerGuard = (p) => _peers[remoteSid] === p;
    KNShared.resetPeerConnection(peer, ICE_SERVERS, remoteSid, socket, peerGuard);
    peer.ready = false;

    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      _syncLog(`reconnect peer ${remoteSid} connection-state: ${s}`);
      if (s === 'failed') {
        _syncLog(`reconnect PC failed for ${remoteSid}`);
        hardDisconnectPeer(remoteSid);
      }
    };

    peer.pc.ondatachannel = (e) => {
      if (e.channel.label === 'lockstep') {
        peer.dc = e.channel;
        setupDataChannel(remoteSid, peer.dc);
      } else if (_onExtraDataChannel) {
        _onExtraDataChannel(remoteSid, e.channel);
      }
    };

    // Create new DC and send offer with reconnect flag
    peer.dc = peer.pc.createDataChannel('lockstep', { ordered: true });
    setupDataChannel(remoteSid, peer.dc);

    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      socket.emit('webrtc-signal', {
        target: remoteSid,
        offer: peer.pc.localDescription,
        reconnect: true,
      });
    } catch (err) {
      _syncLog(`reconnect offer failed: ${err}`);
      hardDisconnectPeer(remoteSid);
    }
  };

  // -- Helper: get active player peers ---------------------------------------

  // All connected player peers (for sending input to)
  const getActivePeers = () =>
    Object.values(_peers).filter((p) => p.slot !== null && p.slot !== undefined && p.dc && p.dc.readyState === 'open');

  // Wait for all active peers that have started sending input.
  // During the boot grace window (first BOOT_GRACE_FRAMES), also include
  // peers with open DCs that haven't sent their first input yet — this
  // stalls the host at frame DELAY_FRAMES instead of letting it race ahead
  // with fabricated zeros, which would seed hash divergence from frame 0.
  // After the grace window, unstarted peers are excluded so a slow/missing
  // peer doesn't stall an established game (normal late-join behavior).
  // Uses _peerInputStarted (persistent flag) instead of checking buffer
  // length — prevents peers from dropping out when their buffer is
  // momentarily empty between frames (causes 3+ player desync).
  const getInputPeers = () =>
    getActivePeers().filter((p) => {
      if (p.reconnecting) return false;
      if (_peerInputStarted[p.slot]) return true;
      // Boot grace: include connected peers before their first input arrives
      return _frameNum < BOOT_GRACE_FRAMES;
    });

  // -- Game start sequence ---------------------------------------------------

  // Minimum frames the emulator must run before we consider it ready.
  const MIN_BOOT_FRAMES = 120; // ~2 seconds at 60fps

  const startGameSequence = () => {
    if (_gameStarted) return;
    _gameStarted = true;

    // Spectators: don't start emulator, don't enter manual mode
    if (_isSpectator) {
      setStatus('Spectating...');
      return;
    }

    // The emulator halts at ~frame 6 without a user gesture (AudioContext
    // blocked → Asyncify stalls permanently). The host already has a gesture
    // (ROM drag-drop auto-starts the emulator). For guests, we delay start
    // until a tap provides the gesture, so the emulator starts with audio.
    let _bootPollCount = 0;
    let _bootGestureReceived = false;

    // Guests need a gesture prompt before booting: iOS blocks AudioContext
    // without a direct user gesture, causing WASM to stall at frame 6.
    // Hosts skip the prompt — play.js pre-creates the AudioContext in the
    // startGame() click handler (window._kn_preloadedAudioCtx) before the
    // Socket.IO round-trip that calls start(), keeping it within the gesture window.
    const _needsGesture = _playerSlot !== 0;

    if (!_needsGesture) {
      // Host: proceed immediately — AudioContext pre-created by play.js
      _bootGestureReceived = true;
      _syncLog('host auto-boot (slot=0)');
      setStatus('Loading emulator...');
      KNShared.bootWithCheats('lockstep');
    } else {
      // Guest: show full-screen gesture prompt (above EmulatorJS overlay)
      // Defer until ROM is loaded — the prompt covers the entire screen
      // (z-index 10000) and would hide the ROM download progress bar.
      const showGesturePrompt = () => {
        _syncLog(`guest — showing gesture prompt (slot=${_playerSlot})`);
        const promptEl = document.getElementById('gesture-prompt');
        if (!promptEl) return;
        promptEl.classList.remove('hidden');
        const onPromptClick = () => {
          if (_bootGestureReceived) return;
          _bootGestureReceived = true;
          promptEl.classList.add('hidden');
          // Create gesture-unlocked AudioContexts for both EJS and lockstep.
          // On iOS, the gesture audio unlock expires after a few seconds.
          // If the WASM core takes >3s to download (slow connections), EJS
          // creates its AudioContext outside the gesture window → suspended
          // → Asyncify stalls at frame 6. We fix both problems here:
          //   1. Monkey-patch AudioContext so EJS gets a running context
          //   2. Pre-create _audioCtx for lockstep audio (stays running)
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) {
            const _ejsCtx = new AC();
            _ejsCtx.resume().catch(() => {});
            // Pre-create the lockstep AudioContext at 44100Hz (N64 core rate).
            // iOS WKWebView may silently fail when AudioBufferSourceNode
            // buffers don't match the context's sample rate.
            if (!_audioCtx) {
              try {
                _audioCtx = new AC({ sampleRate: 44100 });
              } catch (_) {
                _audioCtx = new AC(); // fallback to native rate
              }
              _audioCtx.resume().catch(() => {});
              // iOS FxiOS (WKWebView): ScriptProcessorNode → destination produces
              // no audible output even though samples flow and ctx reports running.
              // Route through <audio> element instead — iOS grants privileged audio
              // output to <audio>.play() called within a gesture. We set it up HERE
              // (in the gesture handler) so the .play() authorization persists.
              const gestDest = _audioCtx.createMediaStreamDestination();
              const gestAudio = document.createElement('audio');
              gestAudio.srcObject = gestDest.stream;
              gestAudio.play().catch(() => {});
              window._kn_gestureAudioEl = gestAudio;
              window._kn_gestureAudioDest = gestDest;
              // Keep-alive: silent oscillator through the <audio> element so the
              // iOS audio session stays active until real audio takes over.
              const _keepAliveGain = _audioCtx.createGain();
              _keepAliveGain.gain.value = 0;
              const _keepAliveOsc = _audioCtx.createOscillator();
              _keepAliveOsc.connect(_keepAliveGain);
              _keepAliveGain.connect(gestDest);
              _keepAliveOsc.start();
              window._kn_keepAliveOsc = _keepAliveOsc;
              _syncLog(`lockstep AudioContext pre-created in gesture (rate: ${_audioCtx.sampleRate})`);
            }
            const _RealAC = AC;
            let _hijacked = false;
            // CONSTRUCTOR — called with `new` by EmulatorJS. Must remain a
            // `function` declaration (arrow functions cannot be constructors).
            const _HijackAC = function () {
              if (!_hijacked) {
                _hijacked = true;
                // Restore original constructors
                if (window.AudioContext === _HijackAC) window.AudioContext = _RealAC;
                if (window.webkitAudioContext === _HijackAC) window.webkitAudioContext = _RealAC;
                _syncLog('AudioContext hijack: returning gesture-unlocked context');
                return _ejsCtx;
              }
              return new _RealAC();
            };
            _HijackAC.prototype = _RealAC.prototype;
            if (window.AudioContext) window.AudioContext = _HijackAC;
            if (window.webkitAudioContext) window.webkitAudioContext = _HijackAC;
          }
          // Start emulator within gesture context so audio works
          KNShared.bootWithCheats('lockstep');
          setStatus('Loading emulator...');
          _syncLog('gesture received — emulator starting');
          promptEl.removeEventListener('click', onPromptClick);
          promptEl.removeEventListener('touchend', onPromptClick);
        };
        promptEl.addEventListener('click', onPromptClick);
        promptEl.addEventListener('touchend', onPromptClick);
      };

      if (window.EJS_gameUrl) {
        showGesturePrompt();
      } else {
        _syncLog('guest — ROM not loaded yet, deferring gesture prompt');
        setStatus('Waiting for ROM...');
        _romWaitInterval = setInterval(() => {
          if (window.EJS_gameUrl) {
            clearInterval(_romWaitInterval);
            _romWaitInterval = null;
            showGesturePrompt();
          }
        }, 200);
      }
    }

    const waitForEmu = () => {
      // Wait for gesture before polling
      if (!_bootGestureReceived) {
        setTimeout(waitForEmu, 200);
        return;
      }

      // Timeout after 30 seconds of polling (300 polls at 100ms)
      if (_bootPollCount > 300) {
        _syncLog(`boot timed out after ${_bootPollCount} polls`);
        setStatus('Emulator failed to start — try reloading the page');
        _config?.onStatus?.('Emulator failed to start — try reloading');
        return;
      }

      const gm = window.EJS_emulator?.gameManager;
      if (!gm) {
        _bootPollCount++;
        if (_bootPollCount % 10 === 0) setStatus('Loading emulator...');
        setTimeout(waitForEmu, 100);
        return;
      }

      const mod = gm.Module;
      const hasFrameCount = typeof mod?._get_current_frame_count === 'function';
      const frames = hasFrameCount ? mod._get_current_frame_count() : 0;

      if (frames < MIN_BOOT_FRAMES) {
        if (_bootPollCount++ % 5 === 0) {
          _syncLog(`boot slot=${_playerSlot} f=${frames}/${MIN_BOOT_FRAMES}`);
          setStatus(`Booting emulator... (${frames}/${MIN_BOOT_FRAMES})`);
        }
        // Stuck at frame 0: try clicking the EJS start button (may not have been
        // clicked by waitForEmulator if Module loaded before the button appeared)
        if (frames === 0 && _bootPollCount % 20 === 0) {
          const btn = document.querySelector('.ejs_start_button');
          if (btn) {
            _syncLog('boot stuck at f=0 — clicking EJS start button');
            btn.click();
          } else if (!hasFrameCount) {
            _syncLog('boot stuck at f=0 — _get_current_frame_count missing (stock core?)');
          }
        }
        setTimeout(waitForEmu, 100);
        return;
      }
      if (!mod._simulate_input) {
        if (_bootPollCount++ % 5 === 0) setStatus('Booting emulator...');
        setTimeout(waitForEmu, 100);
        return;
      }

      // Auto-discover INPUT_BASE by calling _simulate_input and detecting the change
      if (mod._simulate_input) {
        try {
          // Reset button 0 for player 0
          mod._simulate_input(0, 0, 0);
          const scanEnd = Math.min(mod.HEAPU8.length, 4 * 1024 * 1024);
          const snap = new Uint8Array(mod.HEAPU8.buffer.slice(0, scanEnd));
          mod._simulate_input(0, 0, 1);
          for (let si = 0; si < scanEnd; si++) {
            if (mod.HEAPU8[si] !== snap[si]) {
              INPUT_BASE = si;
              break;
            }
          }
          mod._simulate_input(0, 0, 0);
          _syncLog(`INPUT_BASE auto-discovered: ${INPUT_BASE}`);

          // Discover per-player input base addresses (button 0 address for each player)
          // This replaces the old per-button scan which only covered player 0.
          const scanRange = 8 * 1024 * 1024; // 8MB scan window
          const scanLen = Math.min(mod.HEAPU8.length, scanRange);
          for (let pi = 0; pi < 4; pi++) {
            mod._simulate_input(pi, 0, 0);
            const pSnap = new Uint8Array(mod.HEAPU8.buffer.slice(0, scanLen));
            mod._simulate_input(pi, 0, 1);
            for (let psi = 0; psi < scanLen; psi++) {
              if (mod.HEAPU8[psi] !== pSnap[psi]) {
                _diagPlayerAddrs[pi] = psi;
                break;
              }
            }
            mod._simulate_input(pi, 0, 0);
          }
          _syncLog(`per-player input addrs: ${JSON.stringify(_diagPlayerAddrs)}`);
        } catch (e) {
          _syncLog(`INPUT_BASE auto-discovery failed, using default: ${INPUT_BASE}`);
        }
      }

      // Pause immediately to prevent any more free frames
      mod.pauseMainLoop();
      _syncLog(`emulator ready (${frames} frames) — paused${_playerSlot === 0 ? ' (host)' : ' (guest)'}`);

      // Set up key tracking now that ejs.controls is available
      _p1KeyMap = null; // force re-read from EJS controls
      setupKeyTracking();

      _selfEmuReady = true;
      hookVirtualGamepad();

      // On mobile: hide EJS's built-in virtual gamepad and use our custom one.
      // Our VirtualGamepad writes directly to KNState.touchInput which
      // readLocalInput() already reads — no hookVirtualGamepad needed for it.
      if (_config?.isMobile && !_isSpectator && window.VirtualGamepad) {
        const ejs2 = window.EJS_emulator;
        if (ejs2?.virtualGamepad) {
          ejs2.virtualGamepad.style.display = 'none';
          ejs2.touch = false;
          window._kn_ejsTouchDisabled = true; // prevent enableMobileTouch() from re-showing it
        }
        // Also hide EJS menu bar — if left visible, readLocalInput()'s
        // ejsMenuOpen check clears touch state every frame.
        if (ejs2?.elements?.menu) {
          ejs2.elements.menu.classList.add('ejs_menu_bar_hidden');
        }
        const gameEl2 = document.getElementById('game');
        if (gameEl2) VirtualGamepad.init(gameEl2);
        // If a physical gamepad is already connected, hide virtual controls immediately
        // (GamepadManager.onUpdate won't fire if nothing changed since last game)
        const detected = window.GamepadManager ? GamepadManager.getDetected() : [];
        if (detected.length > 0) VirtualGamepad.setVisible(false);
      }

      // Late join: request state from host instead of normal sync flow.
      // Also trigger if host is already in the lockstep loop (ROM sharing case:
      // player was in room at game start but emulator booted late due to ROM transfer).
      // _lastRemoteFrame > 0 means we've received actual game input = host is running.
      const hostAlreadyRunning = _lastRemoteFrame > 0;
      if ((_lateJoin || hostAlreadyRunning) && _playerSlot !== 0) {
        _syncLog(`using late-join path (lateJoin=${_lateJoin}, hostRunning=${hostAlreadyRunning})`);
        setStatus('Requesting game state...');
        socket.emit('data-message', {
          type: 'request-late-join',
          requesterSid: socket.id,
        });
        return; // handleLateJoinState() will resume from here
      }

      // Notify all connected peers
      for (const p of Object.values(_peers)) {
        if (p.dc && p.dc.readyState === 'open') {
          try {
            p.dc.send('emu-ready');
          } catch (_) {}
        }
      }

      checkAllEmuReady();
    };
    waitForEmu();
  };

  const checkAllEmuReady = () => {
    if (!_selfEmuReady) return;
    if (_isSpectator) return;
    if (_running) return;

    // Wait for ALL player peers to be emu-ready (not just 1)
    const playerPeers = Object.values(_peers).filter((p) => p.slot !== null && p.slot !== undefined);

    const readyPeers = playerPeers.filter((p) => p.emuReady);
    const notReady = playerPeers.filter((p) => !p.emuReady);

    if (notReady.length > 0) {
      // Show who we're waiting for
      const waiting = notReady.map((p) => {
        const known = _knownPlayers[Object.keys(_peers).find((sid) => _peers[sid] === p)];
        return known ? known.playerName : `P${p.slot + 1}`;
      });
      setStatus(`Waiting for ${waiting.join(', ')} to load... (${readyPeers.length}/${playerPeers.length})`);
      return;
    }

    if (_syncStarted) return; // guard against re-entrant calls
    _syncStarted = true;

    _syncLog(`${readyPeers.length + 1} emulators ready -- syncing initial state`);
    setStatus('Syncing...');

    // Try cached state first — eliminates host/guest asymmetry.
    // All players (including host) fetch the same cached state.
    const romHash = _config?.romHash;
    if (romHash) {
      fetchCachedState(romHash);
    } else if (_playerSlot === 0) {
      // No ROM hash — fall back to host capture
      sendInitialState();
    }
    // Guests without ROM hash: wait for save state via handleSaveStateMsg

    // Timeout: if sync hasn't completed in 30s, reset sync state so a
    // reconnecting peer can re-trigger the sync flow instead of getting stuck.
    // Capture _sessionId so the timer is invalidated if stop()/init() runs.
    const sid = _sessionId;
    setTimeout(() => {
      if (sid !== _sessionId) return; // stale timer from previous session
      if (!_running && _selfEmuReady && _gameStarted) {
        setStatus('Sync timed out — waiting for reconnect...');
        _config?.onToast?.('Sync stalled — waiting for peer to reconnect');
        _syncStarted = false;
        _lockstepReadyPeers = {};
      }
    }, 30000);
  };

  const checkAllLockstepReady = () => {
    if (!_selfLockstepReady) return;
    if (_running) return;

    // Check that at least 1 player peer is lockstep-ready
    const playerPeerSids = Object.keys(_peers).filter((sid) => {
      const p = _peers[sid];
      return p.slot !== null && p.slot !== undefined;
    });
    const readyCount = playerPeerSids.filter((sid) => _lockstepReadyPeers[sid]).length;

    if (readyCount < playerPeerSids.length) return;

    // Negotiate delay: ceiling of all players
    const ownDelay = window.getDelayPreference ? window.getDelayPreference() : 2;
    let maxDelay = ownDelay;
    for (const p of Object.values(_peers)) {
      if (p.delayValue && p.delayValue > maxDelay) maxDelay = p.delayValue;
    }
    DELAY_FRAMES = maxDelay;
    if (window.showEffectiveDelay) window.showEffectiveDelay(ownDelay, maxDelay);
    _syncLog(`delay negotiated: own=${ownDelay} effective=${maxDelay}`);

    _syncLog(`${readyCount + 1} players lockstep-ready -- GO`);

    const gm = window.EJS_emulator?.gameManager;
    if (!gm) return;

    // If no state bytes (host fallback), capture current state
    if (!_guestStateBytes) {
      _guestStateBytes = gm.getState();
    }

    // Soft-reset the core before loading state — clears internal state
    // (JIT caches, hardware registers, plugin state) that loadState()
    // alone doesn't overwrite. Without this, the host retains residual
    // state from its boot frames, causing host-only desync.
    const readyMod = gm.Module;
    if (readyMod?._retro_reset) {
      readyMod._retro_reset();
      _syncLog('core soft-reset before state load');
    }

    // First loadState: fully restores CPU + RAM (needs main loop active)
    gm.loadState(_guestStateBytes);

    // Enter manual mode — captures rAF, stops free frames
    enterManualMode();

    // Second loadState: fixes any free-frame drift between first load
    // and enterManualMode. Both sides now have identical state.
    gm.loadState(_guestStateBytes);
    _guestStateBytes = null;
    _syncLog('double-loaded state (CPU + free-frame fix)');

    // Re-apply cheats after state load. _retro_reset() and loadState() can
    // clear the cheat table, so cheats applied during boot may be lost.
    KNShared.applyStandardCheats(KNShared.SSB64_ONLINE_CHEATS);

    // Both sides reset and start true lockstep sync
    // (Warmup removed — deterministic timing patch makes it unnecessary)
    _frameNum = 0;
    startLockstep();

    // Host: start spectator streaming after lockstep begins
    if (_playerSlot === 0) {
      setTimeout(startSpectatorStream, 1000);
    }
  };

  let _cacheAttempted = false;

  const fetchCachedState = async (romHash) => {
    const url = `/api/cached-state/${encodeURIComponent(romHash)}`;
    _syncLog(`checking for cached state: ${romHash.substring(0, 16)}...`);
    try {
      // Timeout after 10s — mobile fetching 16MB can hang indefinitely
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10000);
      const resp = await fetch(url, { signal: ac.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('no cached state');
      const raw = await resp.arrayBuffer();
      const bytes = new Uint8Array(raw);
      if (bytes.length < 1000) throw new Error(`cached state too small: ${bytes.length}`);
      _syncLog(`cached state loaded (${bytes.length} bytes)`);
      _guestStateBytes = bytes;

      // Host: also send cached bytes to guests via Socket.IO as fallback.
      // Guest cache fetch may hang/timeout on slow mobile connections.
      if (_playerSlot === 0) {
        // NOTE: intentionally fire-and-forget .then() — non-blocking Socket.IO relay
        compressAndEncode(new Uint8Array(bytes))
          .then((encoded) => {
            _syncLog(
              `sending cached state to guests via Socket.IO (${Math.round(encoded.compressedSize / 1024)}KB gzip)`,
            );
            socket.emit('data-message', { type: 'save-state', frame: 0, data: encoded.data });
          })
          .catch((e) => _syncLog(`cached state relay failed: ${e.message || e}`));
      }

      _selfLockstepReady = true;
      if (_rttComplete) broadcastLockstepReady();
      checkAllLockstepReady();
    } catch (e) {
      // No cached state or fetch timed out — fall back to host capture / guest wait
      const reason = e?.name === 'AbortError' ? 'fetch timed out' : e?.message || 'unknown';
      _syncLog(`no cached state — ${reason}, using live capture`);
      if (_playerSlot === 0 && !_cacheAttempted) {
        _cacheAttempted = true;
        sendInitialState();
      }
      // Guests: wait for save state via handleSaveStateMsg
    }
  };

  async function sendInitialState() {
    const gm = window.EJS_emulator?.gameManager;
    if (!gm) return;
    try {
      const raw = gm.getState();
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      // Copy before compressAndEncode — worker transfer detaches the buffer
      const cacheBytes = new Uint8Array(bytes);
      const encoded = await compressAndEncode(bytes);
      _syncLog(
        `sending initial state via Socket.IO (${Math.round(encoded.rawSize / 1024)}KB raw -> ${Math.round(encoded.compressedSize / 1024)}KB gzip)`,
      );

      // Send via Socket.IO -- save state is ~1.5MB which crashes WebRTC
      // data channels (SCTP limit with maxRetransmits).
      socket.emit('data-message', { type: 'save-state', frame: 0, data: encoded.data });

      // Upload raw bytes to cache, then fetch from cache — host goes
      // through the same path as all other players. Using locally-captured
      // bytes directly causes host-only desync (residual internal state).
      const romHash = _config?.romHash;
      if (romHash) {
        const cacheParams = new URLSearchParams({ room: _config.sessionId, token: _config.uploadToken || '' });
        await fetch(`/api/cache-state/${encodeURIComponent(romHash)}?${cacheParams}`, {
          method: 'POST',
          body: cacheBytes,
        });
        _syncLog('state cached — host fetching from cache');
        fetchCachedState(romHash);
        return; // fetchCachedState handles _selfLockstepReady
      }

      // Fallback: no ROM hash, use direct bytes
      // NOTE: `bytes` is detached after compressAndEncode (worker transfer).
      // Use `cacheBytes` (the pre-transfer copy) to avoid loading an empty buffer.
      _guestStateBytes = cacheBytes;
      _selfLockstepReady = true;
      if (_rttComplete) {
        broadcastLockstepReady();
      }
      checkAllLockstepReady();
    } catch (err) {
      _syncLog(`failed to send initial state: ${err}`);
    }
  }

  const handleSaveStateMsg = async (msg) => {
    if (_isSpectator) return;
    if (_selfLockstepReady) return; // already loaded (e.g. from cache)
    _syncLog('received initial state');
    setStatus('Loading initial state...');

    try {
      const bytes = await decodeAndDecompress(msg.data);
      _guestStateBytes = bytes;
      _syncLog(`initial state decompressed (${bytes.length} bytes)`);

      _selfLockstepReady = true;
      if (_rttComplete) {
        broadcastLockstepReady();
      }
      checkAllLockstepReady();
    } catch (err) {
      _syncLog(`failed to decompress initial state: ${err}`);
    }
  };

  // -- Late join -------------------------------------------------------------

  async function sendLateJoinState(remoteSid) {
    const peer = _peers[remoteSid];
    if (!peer) return;
    if (peer.slot === null || peer.slot === undefined) return;

    const gm = window.EJS_emulator?.gameManager;
    if (!gm) return;

    try {
      const raw = gm.getState();
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const encoded = await compressAndEncode(bytes);
      _syncLog(
        `sending late-join state to ${remoteSid} (${Math.round(encoded.rawSize / 1024)}KB raw -> ${Math.round(encoded.compressedSize / 1024)}KB gzip) frame: ${_frameNum}`,
      );

      // Send via Socket.IO since save states are too large for DC
      socket.emit('data-message', {
        type: 'late-join-state',
        frame: _frameNum,
        data: encoded.data,
        effectiveDelay: DELAY_FRAMES,
      });
    } catch (err) {
      _syncLog(`failed to send late-join state: ${err}`);
    }
  }

  const handleLateJoinState = async (msg) => {
    if (_isSpectator) return;
    if (_running) return; // already running, ignore duplicate

    _syncLog(`received late-join state for frame ${msg.frame}`);
    setStatus('Loading late-join state...');

    try {
      const bytes = await decodeAndDecompress(msg.data);
      const gm = window.EJS_emulator?.gameManager;
      if (!gm) {
        _syncLog('gameManager not ready');
        return;
      }

      if (msg.effectiveDelay) {
        DELAY_FRAMES = msg.effectiveDelay;
        _syncLog(`late-join: using room delay ${DELAY_FRAMES}`);
      }

      gm.loadState(bytes);
      enterManualMode();

      // Sync to the host's current frame. The host sent the state at msg.frame,
      // but has advanced since then. _lastRemoteFrame tracks the highest frame
      // received via data channel from any peer — use that to catch up.
      // Then pre-fill the delay gap so the tick loop doesn't stall waiting
      // for historical input that was sent before we started lockstep.
      const startFrame = _lastRemoteFrame > msg.frame ? _lastRemoteFrame : msg.frame;
      _frameNum = startFrame;

      for (let f = Math.max(0, startFrame - DELAY_FRAMES); f <= startFrame + DELAY_FRAMES; f++) {
        if (!_localInputs[f]) _localInputs[f] = KNShared.ZERO_INPUT;
        for (const p of Object.values(_peers)) {
          if (p.slot !== null && p.slot !== undefined) {
            if (!_remoteInputs[p.slot]) _remoteInputs[p.slot] = {};
            if (!_remoteInputs[p.slot][f]) _remoteInputs[p.slot][f] = KNShared.ZERO_INPUT;
          }
        }
      }

      _syncLog(
        `late-join state loaded at frame ${msg.frame} synced to frame ${_frameNum} (lastRemote: ${_lastRemoteFrame})`,
      );
      startLockstep();
    } catch (err) {
      _syncLog(`failed to handle state: ${err}`);
    }
  };

  // -- Guest audio muting + host audio streaming ----------------------------

  // -- Spectator canvas streaming --------------------------------------------

  const startSpectatorStream = () => {
    if (_playerSlot !== 0) return;
    if (_hostStream) return; // already started

    const canvas = document.querySelector('#game canvas');
    if (!canvas) {
      _syncLog('canvas not found for spectator stream, retrying...');
      setTimeout(startSpectatorStream, 200);
      return;
    }

    // Create a smaller capture canvas for efficiency (same as streaming engine)
    const captureCanvas = document.createElement('canvas');
    captureCanvas.width = 640;
    captureCanvas.height = 480;
    const ctx = captureCanvas.getContext('2d');

    // Crop source to 4:3 game area (source may be wider on widescreen displays)
    const TARGET_ASPECT = 4 / 3;
    const computeCrop = () => {
      const sw = canvas.width;
      const sh = canvas.height;
      const srcAspect = sw / sh;
      if (srcAspect > TARGET_ASPECT + 0.01) {
        const cropW = Math.round(sh * TARGET_ASPECT);
        return { sx: Math.round((sw - cropW) / 2), sy: 0, sw: cropW, sh };
      } else if (srcAspect < TARGET_ASPECT - 0.01) {
        const cropH = Math.round(sw / TARGET_ASPECT);
        return { sx: 0, sy: Math.round((sh - cropH) / 2), sw, sh: cropH };
      }
      return { sx: 0, sy: 0, sw, sh };
    };
    let crop = computeCrop();

    _hostStream = captureCanvas.captureStream(0); // manual frame control

    // Add audio track from bypass playback (if available)
    if (_audioDestNode?.stream) {
      const audioTracks = _audioDestNode.stream.getAudioTracks();
      for (let at = 0; at < audioTracks.length; at++) {
        _hostStream.addTrack(audioTracks[at]);
      }
      _syncLog('added audio track to spectator stream');
    }

    const captureTrack = _hostStream.getVideoTracks()[0];

    // Blit loop: copy emulator canvas to capture canvas every frame
    // Use native rAF (lockstep overrides the global)
    let _lastSrcW = canvas.width;
    let _lastSrcH = canvas.height;
    const blitFrame = () => {
      if (!_running) return; // stopped
      APISandbox.nativeRAF(blitFrame);
      if (canvas.width !== _lastSrcW || canvas.height !== _lastSrcH) {
        _lastSrcW = canvas.width;
        _lastSrcH = canvas.height;
        crop = computeCrop();
      }
      ctx.drawImage(canvas, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, 640, 480);
      if (captureTrack.requestFrame) captureTrack.requestFrame();
    };
    blitFrame();

    _syncLog(`spectator capture stream started (640x480, crop: ${crop.sx},${crop.sy} ${crop.sw}x${crop.sh})`);

    // Add tracks to all existing spectator peer connections
    for (const [sid, peer] of Object.entries(_peers)) {
      if (peer.slot === null) {
        addStreamToPeer(sid);
      }
    }
  };

  const startSpectatorStreamForPeer = (remoteSid) => {
    if (!_hostStream) {
      // Stream not started yet -- it will be started after lockstep begins
      // and will pick up this peer then
      return;
    }
    addStreamToPeer(remoteSid);
  };

  const addStreamToPeer = (remoteSid) => {
    const peer = _peers[remoteSid];
    if (!peer || !_hostStream) return;

    for (const track of _hostStream.getTracks()) {
      peer.pc.addTrack(track, _hostStream);
    }
    renegotiate(remoteSid);
  };

  async function renegotiate(remoteSid) {
    const peer = _peers[remoteSid];
    if (!peer) return;
    try {
      await KNShared.createAndSendOffer(peer.pc, socket, remoteSid);
    } catch (err) {
      _syncLog(`renegotiate failed: ${err}`);
    }
  }

  const showSpectatorVideo = (event, peer) => {
    if (!_guestVideo) {
      _guestVideo = document.createElement('video');
      _guestVideo.id = 'guest-video';
      _guestVideo.autoplay = true;
      _guestVideo.playsInline = true;
      _guestVideo.muted = true; // start muted so autoplay works without gesture
      _guestVideo.disableRemotePlayback = true;
      _guestVideo.setAttribute('playsinline', '');

      const gameDiv = _config?.gameElement || document.getElementById('game');
      if (gameDiv) {
        gameDiv.innerHTML = '';
        gameDiv.appendChild(_guestVideo);
      } else {
        document.body.appendChild(_guestVideo);
      }

      // Unmute after playback starts (user can also click to unmute)
      _guestVideo.addEventListener(
        'playing',
        () => {
          _guestVideo.muted = false;
        },
        { once: true },
      );
    }
    _guestVideo.srcObject = event.streams[0];

    // Minimize jitter buffer for low latency
    try {
      const receivers = peer.pc.getReceivers();
      for (const recv of receivers) {
        if (recv.track?.kind === 'video') {
          if ('playoutDelayHint' in recv) recv.playoutDelayHint = 0;
          if ('jitterBufferTarget' in recv) recv.jitterBufferTarget = 0;
        }
      }
    } catch (_) {}

    setStatus('Spectating...');
  };

  // -- Direct memory input ---------------------------------------------------

  const writeInputToMemory = (player, input) => {
    KNShared.applyInputToWasm(player, input);
  };

  // -- Frame stepping (rAF interception) -------------------------------------

  const enterManualMode = () => {
    if (_manualMode) return;
    if (_isSpectator) return; // spectators never enter manual mode

    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod) return;

    // Pause first to invalidate stale runners
    mod.pauseMainLoop();

    // Replace rAF with interceptor that captures the runner
    APISandbox.overrideRAF((cb) => {
      _pendingRunner = cb;
      return -999;
    });

    // Resume to capture fresh runner
    mod.resumeMainLoop();

    _manualMode = true;
    _syncLog('entered manual mode');
  };

  let _hasForkedCore = false; // true if Module exports kn_set_deterministic

  const stepOneFrame = () => {
    if (!_pendingRunner) return false;
    const runner = _pendingRunner;
    _pendingRunner = null;

    const frameTimeMs = (_frameNum + 1) * 16.666666666666668;
    window._kn_frameTime = frameTimeMs;

    // On first lockstep frame, switch from flat time to relative cycle counter.
    // Captures current cycle count as baseline — subtracts transition divergence.
    if (_hasForkedCore && !window._kn_useRelativeCycles && _frameNum === 0) {
      const cycleModule = window.EJS_emulator?.gameManager?.Module;
      if (cycleModule?._kn_get_cycle_time_ms) {
        window._kn_cycleStart = cycleModule._kn_get_cycle_time_ms();
        window._kn_cycleBase = frameTimeMs;
        window._kn_useRelativeCycles = true;
        _syncLog(`switched to relative cycle counter at ${window._kn_cycleStart.toFixed(1)}ms`);
      }
    }

    // C-level: always update frame time (kn_deterministic_mode stays ON)
    if (_hasForkedCore) {
      const frameModule = window.EJS_emulator?.gameManager?.Module;
      if (frameModule?._kn_set_frame_time) {
        frameModule._kn_set_frame_time(frameTimeMs);
      }
    }

    runner(frameTimeMs);

    // Force GL composite via real rAF no-op
    APISandbox.nativeRAF(() => {});
    return true;
  };

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
  let _fpsLastTime = 0;
  let _fpsFrameCount = 0;
  let _fpsCurrent = 0;
  let _remoteReceived = 0;
  let _remoteMissed = 0;
  let _remoteApplied = 0;
  let _lastRemoteFrame = -1;
  let _lastRemoteFramePerSlot = {}; // slot -> highest frame received from that peer
  let _peerLastAdvanceTime = {}; // slot -> performance.now() when peer last sent a NEW frame
  let _peerPhantom = {}; // slot -> true when peer is detected as unresponsive
  const PEER_DEAD_MS = 5000; // 5s without frame advance → peer is dead
  let _consecutiveFabrications = {}; // slot -> count of consecutive hard-timeout fabrications
  const RAPID_FABRICATION_THRESHOLD = 2; // after N consecutive fabrications, skip stall wait
  let _inputLateLogTime = {}; // slot -> last time INPUT-LATE was logged (rate-limiting)

  const startLockstep = () => {
    if (_running) return;
    _running = true;

    // Detect forked core with C-level deterministic timing exports
    const lsMod = window.EJS_emulator?.gameManager?.Module;
    _hasForkedCore = !!(lsMod?._kn_set_deterministic && lsMod._kn_set_frame_time);
    if (_hasForkedCore) {
      _syncLog('forked core detected — C-level deterministic timing');
    } else {
      _syncLog('stock core — JS-level timing patch (fallback)');
    }

    // Only reset frame counter if not a late join (late join sets _frameNum before calling)
    if (_frameNum === 0) {
      _localInputs = {};
      _remoteInputs = {};
      _peerInputStarted = {};
      // _lastKnownInput is const (object), clear its entries
      for (const k of Object.keys(_lastKnownInput)) delete _lastKnownInput[k];
    }
    _fpsLastTime = performance.now();
    _fpsFrameCount = 0;
    _fpsCurrent = 0;
    _remoteReceived = 0;
    _remoteMissed = 0;
    _remoteApplied = 0;
    _lastRemoteFrame = -1;
    _lastRemoteFramePerSlot = {};
    _peerLastAdvanceTime = {};
    _peerPhantom = {};
    _consecutiveFabrications = {};
    _inputLateLogTime = {};
    _stallStart = 0;
    window._netplayFrameLog = [];

    // Always frozen time — audio plays via bypass, not OpenAL
    window._kn_inStep = true;
    window._kn_frameTime = 0;
    if (_hasForkedCore) {
      const detMod = window.EJS_emulator?.gameManager?.Module;
      if (detMod?._kn_set_deterministic) {
        detMod._kn_set_deterministic(1);
        _syncLog('C-level deterministic timing enabled (session-wide)');
      }

      // CP0_COUNT reset disabled — translate_event_queue corrupts host state.
      // The --denan WASM pass handles NaN determinism without needing cycle sync.

      // Override performance.now() during WASM frame steps for COMPLETE timing
      // determinism. Emscripten's _emscripten_get_now calls performance.now()
      // internally, and it's captured in a closure we can't override from outside.
      // By overriding performance.now() itself, we catch ALL timing — clock_gettime,
      // gettimeofday, emscripten_get_now, etc. The override only activates during
      // stepOneFrame() (gated by _inDeterministicStep) so lockstep JS code
      // (stall detection, FPS) still gets real time.
      if (detMod?._kn_get_cycle_time_ms) {
        _deterministicPerfNow = () => {
          if (_inDeterministicStep) {
            const m = window.EJS_emulator?.gameManager?.Module;
            if (m?._kn_get_cycle_time_ms) return m._kn_get_cycle_time_ms();
          }
          return APISandbox.nativePerfNow();
        };
        APISandbox.overridePerfNow(_deterministicPerfNow);
        _syncLog('performance.now() intercepted for deterministic frame steps');
      }
    }

    // Neutralize fast-forward / slow-motion WASM functions.
    // EmulatorJS mobile virtual gamepad has "slow" and "fast" buttons that call
    // _toggle_fastforward / _toggle_slow_motion directly. These set RetroArch
    // runloop flags (RUNLOOP_FLAG_FASTMOTION / RUNLOOP_FLAG_SLOWMOTION) which
    // alter internal frame timing and cause desyncs between players.
    if (lsMod?._toggle_fastforward && !_origToggleFF) {
      _origToggleFF = lsMod._toggle_fastforward;
      _origToggleSM = lsMod._toggle_slow_motion;
      // Force both off in case a player already toggled them before lockstep
      lsMod._toggle_fastforward(0);
      lsMod._toggle_slow_motion(0);
      lsMod._toggle_fastforward = () => {};
      lsMod._toggle_slow_motion = () => {};
      _syncLog('neutralized fast-forward/slow-motion controls');
    }

    // Kill OpenAL's audio system. An active AudioContext + AL_PLAYING source
    // causes desyncs even with frozen _emscripten_get_now. Stop all sources
    // and suspend the AudioContext to eliminate all async audio activity.
    // NOTE: use suspend(), not close() — close() can break the Emscripten
    // OpenAL shim on WKWebView (FxiOS), stalling the WASM core on restart.
    const alMod = window.EJS_emulator?.gameManager?.Module;
    if (alMod?.AL?.contexts) {
      for (const [id, ctx] of Object.entries(alMod.AL.contexts)) {
        if (!ctx) continue;
        // Stop all sources (AL_PLAYING 0x1012 -> AL_STOPPED 0x1014)
        if (ctx.sources) {
          for (const src of Object.values(ctx.sources)) {
            if (src?.state === 0x1012) {
              alMod.AL.setSourceState(src, 0x1014);
            }
          }
        }
        // Suspend the AudioContext and prevent browser from auto-resuming
        // it on user gestures by overriding resume() to be a no-op.
        if (ctx.audioCtx) {
          ctx.audioCtx.suspend();
          ctx.audioCtx.resume = () => Promise.resolve();
        }
        _syncLog(`killed OpenAL audio system (context ${id})`);
      }
    }

    initAudioPlayback();
    // Only install diagnostic hooks when explicitly enabled — they add
    // MutationObserver on document.body, touch listeners, and write to
    // _diagEventLog which grows unboundedly (17MB+ on mobile in 30 min).
    if (window._KN_DIAG) _diagInstallHooks();

    // DIAG: one-time startup banner for log self-description
    const ua = navigator.userAgent;
    const engine = /Firefox/.test(ua)
      ? 'SpiderMonkey'
      : /Chrome/.test(ua)
        ? 'V8'
        : /Safari/.test(ua)
          ? 'JSC'
          : 'unknown';
    const isMobile = /Mobile|Android|iPhone|iPad/.test(ua);
    _syncLog(
      `DIAG-START slot=${_playerSlot} engine=${engine} mobile=${isMobile} forkedCore=${_hasForkedCore} ua=${ua.substring(0, 120)}`,
    );

    const activePeers = getActivePeers();
    const peerSlots = activePeers.map((p) => p.slot);
    _syncLog(`lockstep started -- slot: ${_playerSlot} peerSlots: ${peerSlots.join(',')} delay: ${DELAY_FRAMES}`);
    setStatus('Connected -- game on!');

    window._lockstepActive = true;

    // C-level sync: detect patched core with kn_sync exports.
    // Detect patched core with kn_sync exports. Buffer is allocated lazily
    // on first use (see ensureSyncBuffer) to avoid triggering WASM memory
    // growth at startup when sync may never be needed.
    const knMod = window.EJS_emulator?.gameManager?.Module;
    _hasKnSync = !!(knMod && knMod._kn_sync_hash && knMod._kn_sync_read && knMod._kn_sync_write);
    if (_hasKnSync) {
      if (_syncEnabled) {
        ensureSyncBuffer();
      }
      _syncLog(`C-level sync available${_syncBufPtr ? `, buf at ${_syncBufPtr}` : ' (buffer deferred)'}`);
    } else {
      _syncLog('C-level sync NOT available, using getState/loadState fallback');
    }

    // Background tab handling: do NOT pause the tick loop. Browser naturally
    // throttles setInterval to ~1fps in background tabs, which keeps the
    // player sending input (slowly). Pausing completely breaks multi-tab
    // setups where one tab is always document.hidden.
    //
    // On return to foreground: fast-forward frame counter to catch up with
    // peers, then resync emulator state from host.
    let _backgroundAt = 0;
    _visChangeHandler = () => {
      if (!_running) return;
      if (document.hidden) {
        _backgroundAt = Date.now();
        _syncLog(`tab hidden at frame ${_frameNum}`);
      } else {
        const bgDuration = _backgroundAt ? Date.now() - _backgroundAt : 0;
        _backgroundAt = 0;
        _syncLog(`tab visible (was background ${bgDuration} ms)`);

        // Short background (<500ms): no action needed
        if (bgDuration < 500) return;

        // Force full resync after background return (delta base is stale).
        // Only reset on guest — host's delta base should persist so it can
        // send small deltas instead of 8MB full state every time.
        if (_playerSlot !== 0) {
          _setLastSyncState(null, 'bg-return');
        }

        // Notify peers we returned (toast only, no gameplay effect)
        const activePeers2 = getActivePeers();
        for (const p of activePeers2) {
          try {
            p.dc.send('peer-resumed');
          } catch (_) {}
        }

        // Fast-forward _frameNum to catch up with peers. Background throttling
        // means we fell behind — peers have moved far ahead.
        if (_lastRemoteFrame > _frameNum) {
          _syncLog(`fast-forward: ${_frameNum} -> ${_lastRemoteFrame}`);
          _frameNum = _lastRemoteFrame;
          KNState.frameNum = _frameNum;
          _localInputs = {};
          _remoteInputs = {};
          for (let d = 0; d < DELAY_FRAMES; d++) {
            _localInputs[_frameNum + d] = KNShared.ZERO_INPUT;
          }
        }

        // Request resync (emulator state drifted during background throttling)
        if (_playerSlot === 0) {
          _consecutiveResyncs = 0;
          _syncCheckInterval = _syncBaseInterval;
          _resetDrift();
        } else {
          const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
          if (hostPeer?.dc?.readyState === 'open') {
            try {
              hostPeer.dc.send('sync-request');
            } catch (_) {}
          }
        }
      }
    };
    document.addEventListener('visibilitychange', _visChangeHandler);

    // Network change detection: mobile WiFi↔cellular switches cause desync.
    // Request a FULL (non-delta) resync when the network path changes.
    _networkChangeHandler = () => {
      if (!_running) return;
      _syncLog('network change detected — requesting full resync');
      if (_playerSlot !== 0) {
        _setLastSyncState(null, 'network-change');
        _lastResyncTime = 0; // clear cooldown
        const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
        if (hostPeer?.dc?.readyState === 'open') {
          try {
            hostPeer.dc.send('sync-request-full');
          } catch (_) {}
        }
      } else {
        // Host: reset sync interval so hash checks resume quickly
        _consecutiveResyncs = 0;
        _syncCheckInterval = _syncBaseInterval;
        _resetDrift();
      }
    };
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) conn.addEventListener('change', _networkChangeHandler);
    window.addEventListener('online', _networkChangeHandler);

    // Use setInterval so background tabs are not throttled
    _tickInterval = setInterval(tick, 16);
  };

  const stopSync = () => {
    _running = false;
    window._lockstepActive = false;

    // Disable all deterministic timing
    window._kn_inStep = false;
    window._kn_frameTime = 0;
    window._kn_useRelativeCycles = false;
    if (_hasForkedCore) {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (mod?._kn_set_deterministic) mod._kn_set_deterministic(0);
    }
    // Restore speed-control functions
    if (_origToggleFF) {
      const mod2 = window.EJS_emulator?.gameManager?.Module;
      if (mod2) {
        mod2._toggle_fastforward = _origToggleFF;
        mod2._toggle_slow_motion = _origToggleSM;
      }
      _origToggleFF = null;
      _origToggleSM = null;
    }
    // Restore performance.now — the override closure retains references to the
    // WASM Module, preventing GC of tens of MB after destroyEmulator().
    if (_deterministicPerfNow) {
      performance.now = Performance.prototype.now.bind(performance);
      _deterministicPerfNow = null;
    }
    // Remove visibilitychange handler to prevent duplicates on game restart
    if (_visChangeHandler) {
      document.removeEventListener('visibilitychange', _visChangeHandler);
      _visChangeHandler = null;
    }
    // Remove network change handlers
    if (_networkChangeHandler) {
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (conn) conn.removeEventListener('change', _networkChangeHandler);
      window.removeEventListener('online', _networkChangeHandler);
      _networkChangeHandler = null;
    }
    if (_tickInterval !== null) {
      clearInterval(_tickInterval);
      _tickInterval = null;
    }
    // Restore rAF if we intercepted it (other overrides restored in stop())
    if (_manualMode) {
      APISandbox.restoreAll();
    }
    _manualMode = false;
    _pendingRunner = null;
    _pendingSyncCheck = null;
    _setLastSyncState(null, 'stopSync');
    // Free C-level sync buffer
    if (_syncBufPtr && _hasKnSync) {
      const modStop = window.EJS_emulator?.gameManager?.Module;
      if (modStop?._free) modStop._free(_syncBufPtr);
      _syncBufPtr = 0;
    }
    _hasKnSync = false;
    _frameAdvantage = 0;
    _frameAdvRaw = 0;
    _framePacingActive = false;
    _pacingCapsCount = 0;
    _pacingCapsFrames = 0;
    _pacingMaxAdv = 0;
    _pacingAdvSum = 0;
    _pacingAdvCount = 0;
  };

  const tick = () => {
    if (!_running) return;

    // Async resync: apply buffered state at clean frame boundary
    if (_pendingResyncState) {
      const pending = _pendingResyncState;
      _pendingResyncState = null;
      _awaitingResync = false;
      applySyncState(pending.bytes, pending.frame);
    }

    // ── Frame pacing (GGPO-style frame advantage cap) ────────────────────
    // Prevents the faster machine from outrunning the slower one's input stream.
    // Skip during warmup — connection is still stabilizing.
    if (_frameNum >= FRAME_PACING_WARMUP) {
      const inputPeersForPacing = getInputPeers();
      if (inputPeersForPacing.length > 0) {
        // Detect phantom peers — those that haven't advanced for PEER_DEAD_MS
        const nowPacing = performance.now();
        for (const p of inputPeersForPacing) {
          if (!_peerPhantom[p.slot] && _peerLastAdvanceTime[p.slot] !== undefined) {
            if (nowPacing - _peerLastAdvanceTime[p.slot] >= PEER_DEAD_MS) {
              _peerPhantom[p.slot] = true;
              _syncLog(
                `PEER-PHANTOM slot=${p.slot} lastAdvance=${_peerLastAdvanceTime[p.slot].toFixed(0)} staleSec=${((nowPacing - _peerLastAdvanceTime[p.slot]) / 1000).toFixed(1)} — excluded from pacing`,
              );
              // Notify UI that a peer has been dropped
              window.dispatchEvent(new CustomEvent('kn-peer-phantom', { detail: { slot: p.slot } }));
            }
          }
        }
        // Exclude phantom peers from frame pacing — they're dead and shouldn't throttle us
        let minRemoteFrame = Infinity;
        let activePacingPeers = 0;
        for (const p of inputPeersForPacing) {
          if (_peerPhantom[p.slot]) continue; // skip dead peers
          const rf = _lastRemoteFramePerSlot[p.slot] ?? -1;
          if (rf < minRemoteFrame) minRemoteFrame = rf;
          activePacingPeers++;
        }
        // If no active pacing peers remain, release any active cap
        if (activePacingPeers === 0 && _framePacingActive) {
          _framePacingActive = false;
          _syncLog('FRAME-CAP released — all peers phantom');
        }
        if (activePacingPeers > 0 && minRemoteFrame >= 0) {
          _frameAdvRaw = _frameNum - minRemoteFrame;
          const alpha = _frameAdvRaw > _frameAdvantage ? FRAME_ADV_ALPHA_UP : FRAME_ADV_ALPHA_DOWN;
          _frameAdvantage = _frameAdvantage * (1 - alpha) + _frameAdvRaw * alpha;

          // Track stats for periodic summary
          _pacingAdvSum += _frameAdvantage;
          _pacingAdvCount++;
          if (_frameAdvantage > _pacingMaxAdv) _pacingMaxAdv = _frameAdvantage;

          if (_frameAdvRaw >= DELAY_FRAMES + 1) {
            // Too far ahead — skip this tick entirely.
            // Don't send input (adds to pile remote can't consume).
            // Don't step emulator (diverges further).
            _pacingCapsFrames++;
            if (!_framePacingActive) {
              _framePacingActive = true;
              _pacingCapsCount++;
              _syncLog(
                `FRAME-CAP start fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)} delay=${DELAY_FRAMES} minRemote=${minRemoteFrame}`,
              );
            }
            return;
          }
          if (_framePacingActive) {
            _framePacingActive = false;
            _syncLog(`FRAME-CAP end fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)}`);
          }
        }
      }
    }

    const activePeers = getActivePeers();

    // FPS counter
    _fpsFrameCount++;
    const now = performance.now();
    if (now - _fpsLastTime >= 1000) {
      _fpsCurrent = _fpsFrameCount;
      _fpsFrameCount = 0;
      _fpsLastTime = now;
    }

    // Send local input for current frame to ALL open peer DCs
    const localInput = readLocalInput();
    _localInputs[_frameNum] = localInput;
    const buf = KNShared.encodeInput(_frameNum, localInput).buffer;
    let _sendFails = 0;
    for (let i = 0; i < activePeers.length; i++) {
      try {
        activePeers[i].dc.send(buf);
      } catch (_) {
        _sendFails++;
      }
    }

    // Check if all INPUT peers (peers who have sent at least 1 input)
    // have input for the apply frame. Late joiners who haven't started
    // sending yet won't stall existing players.
    const inputPeers = getInputPeers();
    const applyFrame = _frameNum - DELAY_FRAMES;
    if (applyFrame >= 0) {
      let allArrived = true;
      const _missingSlots = [];
      for (let j = 0; j < inputPeers.length; j++) {
        const pSlot = inputPeers[j].slot;
        if (!_remoteInputs[pSlot] || _remoteInputs[pSlot][applyFrame] === undefined) {
          allArrived = false;
          _missingSlots.push(pSlot);
        }
      }

      if (!allArrived) {
        // Check if ALL missing peers are phantom (dead) or in rapid-fabrication mode
        const allMissingArePhantom = _missingSlots.every(
          (s) => _peerPhantom[s] || (_consecutiveFabrications[s] || 0) >= RAPID_FABRICATION_THRESHOLD,
        );

        if (allMissingArePhantom) {
          // Rapid fabrication — peer(s) confirmed dead, no wait
          const repeatInfo = [];
          for (const s of _missingSlots) {
            if (!_remoteInputs[s]) _remoteInputs[s] = {};
            if (_remoteInputs[s][applyFrame] === undefined) {
              _remoteInputs[s][applyFrame] = KNShared.ZERO_INPUT;
              _consecutiveFabrications[s] = (_consecutiveFabrications[s] || 0) + 1;
              repeatInfo.push(`s${s}=0`);
            }
          }
          // Log once per second to avoid flooding
          if (_stallStart === 0 || now - _stallStart >= 1000) {
            _stallStart = now;
            _syncLog(
              `INPUT-FABRICATE f=${_frameNum} apply=${applyFrame} phantom=[${_missingSlots.join(',')}] fabricated=[${repeatInfo.join(',')}]`,
            );
          }
        } else {
          // STALL -- remote input not here yet (normal path for live peers)
          if (_stallStart === 0) {
            _stallStart = now;
            _resendSent = false;
            // Log first stall occurrence with full state
            const rBufSizes = {};
            for (const s of Object.keys(_remoteInputs)) {
              rBufSizes[s] = Object.keys(_remoteInputs[s] || {}).length;
            }
            _syncLog(
              `INPUT-STALL start f=${_frameNum} apply=${applyFrame} missing=[${_missingSlots.join(',')}] inputPeers=${inputPeers.map((p) => p.slot).join(',')} rBuf=${JSON.stringify(rBufSizes)} peerStarted=${JSON.stringify(_peerInputStarted)}`,
            );
          }
          const stallDuration = now - _stallStart;
          if (stallDuration >= MAX_STALL_MS + RESEND_TIMEOUT_MS) {
            // Hard timeout — fabricate ZERO_INPUT for all missing slots.
            // Always ZERO_INPUT (never _lastKnownInput) so all players agree.
            const repeatInfo = [];
            for (let k = 0; k < inputPeers.length; k++) {
              const s = inputPeers[k].slot;
              if (!_remoteInputs[s]) _remoteInputs[s] = {};
              if (_remoteInputs[s][applyFrame] === undefined) {
                _remoteInputs[s][applyFrame] = KNShared.ZERO_INPUT;
                _consecutiveFabrications[s] = (_consecutiveFabrications[s] || 0) + 1;
                repeatInfo.push(`s${s}=0`);
              }
            }
            _syncLog(
              `INPUT-STALL hard-timeout f=${_frameNum} apply=${applyFrame} missing=[${_missingSlots.join(',')}] stallMs=${stallDuration.toFixed(0)} fabricated=[${repeatInfo.join(',')}]`,
            );
            KNEvent('stall', `Input stall at frame ${_frameNum}`, {
              frame: _frameNum,
              stallMs: Math.round(stallDuration),
              missing: [..._missingSlots],
            });
            KNState.sessionStats.stalls++;
            _stallStart = 0;
          } else if (stallDuration >= MAX_STALL_MS && !_resendSent) {
            // Stage 2 — request resend from missing peers (once per stall)
            _resendSent = true;
            for (let k2 = 0; k2 < inputPeers.length; k2++) {
              const s2 = inputPeers[k2].slot;
              if (_remoteInputs[s2]?.[applyFrame] !== undefined) continue;
              const dc2 = inputPeers[k2].dc;
              if (dc2?.readyState === 'open') {
                try {
                  dc2.send(`resend:${applyFrame}`);
                } catch (_) {}
              }
            }
            _syncLog(
              `INPUT-STALL resend-request f=${_frameNum} apply=${applyFrame} missing=[${_missingSlots.join(',')}]`,
            );
            _remoteMissed++;
            // Don't re-enter full tick() — that causes burst frame processing
            // when buffered inputs resolve. Let setInterval(16) handle the
            // next frame step at the natural 60fps cadence.
            return;
          } else {
            _remoteMissed++;
            return;
          }
        } // end normal stall path (else of allMissingArePhantom)
      } else {
        _stallStart = 0;
        // Reset consecutive fabrication counts for peers whose input arrived
        for (const p of inputPeers) {
          if (_consecutiveFabrications[p.slot]) _consecutiveFabrications[p.slot] = 0;
        }
      }

      // Write ALL inputs to Wasm memory — use inputPeers for peers
      // we're synced with, activePeers for all connected
      const localInput = _localInputs[applyFrame] || KNShared.ZERO_INPUT;
      writeInputToMemory(_playerSlot, localInput);
      for (let m = 0; m < inputPeers.length; m++) {
        const peerSlot = inputPeers[m].slot;
        const remoteInput = (_remoteInputs[peerSlot] && _remoteInputs[peerSlot][applyFrame]) || KNShared.ZERO_INPUT;
        writeInputToMemory(peerSlot, remoteInput);
        if (_remoteInputs[peerSlot]) delete _remoteInputs[peerSlot][applyFrame];
      }

      // Periodic input pipeline log (every 60 frames = ~1s)
      if (_frameNum % 60 === 0) {
        let rBufTot = 0;
        const rBufDetail = {};
        for (const sl of Object.keys(_remoteInputs)) {
          const n = Object.keys(_remoteInputs[sl] || {}).length;
          rBufTot += n;
          rBufDetail[sl] = n;
        }
        const dcStates = {};
        for (const [sid, p] of Object.entries(_peers)) {
          if (p.slot !== null && p.slot !== undefined) {
            dcStates[p.slot] = p.dc ? p.dc.readyState : 'none';
          }
        }
        _syncLog(
          `INPUT-LOG f=${_frameNum} apply=${applyFrame} local=${JSON.stringify(localInput)} delay=${DELAY_FRAMES} inputPeers=[${inputPeers.map((p) => p.slot).join(',')}] rBuf=${JSON.stringify(rBufDetail)} dc=${JSON.stringify(dcStates)} missed=${_remoteMissed} applied=${_remoteApplied} sendFails=${_sendFails} fps=${_fpsCurrent} fAdv=${_frameAdvantage.toFixed(1)} fAdvRaw=${_frameAdvRaw}`,
        );
      }
      // Periodic pacing summary (~5s)
      if (_frameNum % 300 === 0 && _pacingAdvCount > 0) {
        const avgAdv = (_pacingAdvSum / _pacingAdvCount).toFixed(1);
        _syncLog(
          `PACING f=${_frameNum} avgAdv=${avgAdv} maxAdv=${_pacingMaxAdv.toFixed(1)} capsCount=${_pacingCapsCount} capsFrames=${_pacingCapsFrames}`,
        );
        // Reset window
        _pacingCapsCount = 0;
        _pacingCapsFrames = 0;
        _pacingMaxAdv = 0;
        _pacingAdvSum = 0;
        _pacingAdvCount = 0;
      }
      // Zero disconnected player slots so loadState() can't restore stale input
      for (let zs = 0; zs < 4; zs++) {
        if (zs === _playerSlot) continue;
        let hasInputPeer = false;
        for (let zi = 0; zi < inputPeers.length; zi++) {
          if (inputPeers[zi].slot === zs) {
            hasInputPeer = true;
            break;
          }
        }
        if (!hasInputPeer) writeInputToMemory(zs, 0);
      }
      _remoteApplied++;

      // Cleanup old local inputs — keep a history window for resend requests.
      // Peers may request frames up to (MAX_STALL_MS + RESEND_TIMEOUT_MS) / 16.67
      // frames behind, so keep ~600 frames (~10s at 60fps).
      const cleanupBefore = applyFrame - 600;
      if (cleanupBefore >= 0) delete _localInputs[cleanupBefore];
    }

    // Guest: pause emulator while waiting for resync data.
    // Input sending above continues so the host doesn't INPUT-STALL,
    // but the emulator doesn't advance (no divergent frames).
    // Safety: resume after 3s if resync data never arrives.
    if (_awaitingResync) {
      if (performance.now() - _awaitingResyncAt > 3000) {
        _syncLog('resync wait timeout — resuming');
        console.warn('[lockstep] resync timeout — log dump:\n' + exportSyncLog());
        _awaitingResync = false;
      } else {
        return;
      }
    }

    // Step one frame with audio capture
    const tickMod = window.EJS_emulator?.gameManager?.Module;
    if (tickMod?._kn_reset_audio) tickMod._kn_reset_audio();
    _inDeterministicStep = true;
    stepOneFrame();
    _inDeterministicStep = false;
    feedAudio();

    _frameNum++;
    KNState.frameNum = _frameNum;

    // Deferred sync check: guest was behind when sync-hash arrived, now caught up.
    if (_pendingSyncCheck && _frameNum >= _pendingSyncCheck.frame) {
      if (_frameNum - _pendingSyncCheck.frame <= 2) {
        if (_hasKnSync && window.EJS_emulator?.gameManager?.Module) {
          // C-level hash — synchronous comparison
          const mod = window.EJS_emulator.gameManager.Module;
          const guestHash = mod._kn_sync_hash();
          if (guestHash !== _pendingSyncCheck.hash) {
            const deferredHostRegions = _pendingSyncCheck.hostRegions ?? null;
            let deferredLocalRegions = null;
            let deferredDiffRegions = null;
            if (mod._kn_sync_hash_regions) {
              const hashBuf = mod._malloc(48);
              const regionCount = mod._kn_sync_hash_regions(hashBuf, 12);
              deferredLocalRegions = [];
              for (let ri = 0; ri < regionCount; ri++)
                deferredLocalRegions.push(mod.HEAPU32[(hashBuf >> 2) + ri] >>> 0);
              mod._free(hashBuf);
              if (deferredHostRegions) {
                deferredDiffRegions = _diagRegionNames.filter(
                  (_, ri) =>
                    deferredHostRegions[ri] !== undefined && deferredLocalRegions[ri] !== deferredHostRegions[ri],
                );
              }
            }
            _syncLog(`DESYNC (deferred) at frame ${_pendingSyncCheck.frame}`);
            const _nowDeferredDesync = performance.now();
            if (_nowDeferredDesync - _lastDesyncEventTime > 10000) {
              _lastDesyncEventTime = _nowDeferredDesync;
              KNEvent('desync', `Desync at frame ${_pendingSyncCheck.frame}`, {
                frame: _pendingSyncCheck.frame,
                local: guestHash,
                host: _pendingSyncCheck.hash,
                ...(deferredLocalRegions && {
                  localRegions: Object.fromEntries(deferredLocalRegions.map((h, ri) => [_diagRegionNames[ri], h])),
                }),
                ...(deferredHostRegions && {
                  hostRegions: Object.fromEntries(deferredHostRegions.map((h, ri) => [_diagRegionNames[ri], h])),
                }),
                ...(deferredDiffRegions?.length && { diffRegions: deferredDiffRegions }),
              });
            }
            KNState.sessionStats.desyncs++;
            _recordDrift(null);
            if (deferredLocalRegions) {
              _syncLog(
                `REGION-HASH local ${deferredLocalRegions.map((h, ri) => `${_diagRegionNames[ri]}=${h}`).join(' ')}`,
              );
              if (deferredHostRegions) {
                _syncLog(
                  `REGION-HASH host  ${deferredHostRegions.map((h, ri) => `${_diagRegionNames[ri]}=${h}`).join(' ')}`,
                );
                if (deferredDiffRegions?.length) _syncLog(`REGION-DIFF ${deferredDiffRegions.join(' ')}`);
              }
            }
            _syncMismatchStreak++;
            const now3 = performance.now();
            const cooldownElapsed3 = now3 - _lastResyncTime;
            if (_tryApplyPreloaded()) {
              // instant resync
            } else if (!_pendingResyncState && cooldownElapsed3 > _resyncCooldownMs()) {
              _lastResyncTime = now3;
              const forceFull3 = _syncMismatchStreak >= MISMATCH_FULL_RESYNC_THRESHOLD;
              const reqType3 = forceFull3 ? 'sync-request-full' : 'sync-request';
              _syncLog(
                `sending ${reqType3} (deferred, cooldown=${Math.round(cooldownElapsed3)}ms streak=${_syncMismatchStreak})`,
              );
              const sp = _peers[_pendingSyncCheck.peerSid];
              if (sp?.dc) {
                try {
                  sp.dc.send(reqType3);
                } catch (e) {
                  _syncLog(`deferred sync-request failed: ${e}`);
                }
              }
            } else {
              _syncLog(
                `DESYNC (deferred) but blocked: pending=${!!_pendingResyncState} cooldown=${Math.round(cooldownElapsed3)}ms`,
              );
            }
          } else {
            // RDRAM anchor hash matches — verify with live block 25 and pixel hash.
            // blk25 triggers resyncs (see immediate path comment). Pixel is log-only.
            const deferredBlk25 = _pendingSyncCheck.hostBlk25 ?? 0;
            const deferredPixelHash = _pendingSyncCheck.hostPixelHash ?? 0;
            let deferredExtraDesync = false;

            if (deferredBlk25) {
              const guestBlk25 = _getBlk25Hash(mod);
              if (guestBlk25 && guestBlk25 !== deferredBlk25) {
                deferredExtraDesync = true;
                _syncLog(
                  `BLK25-DESYNC (deferred) frame=${_pendingSyncCheck.frame} local=${guestBlk25} host=${deferredBlk25}`,
                );
                KNState.sessionStats.desyncs++;
                _recordDrift(null);
                const now3 = performance.now();
                const cooldownElapsed3 = now3 - _lastResyncTime;
                if (_tryApplyPreloaded()) {
                  // instant resync
                } else if (!_pendingResyncState && cooldownElapsed3 > _resyncCooldownMs()) {
                  _lastResyncTime = now3;
                  const sp = _peers[_pendingSyncCheck.peerSid];
                  if (sp?.dc) {
                    try {
                      sp.dc.send('sync-request');
                    } catch (e) {
                      _syncLog(`deferred blk25 sync-request failed: ${e}`);
                    }
                  }
                }
              }
            }

            // Pixel comparison: log-only, no sync-request trigger.
            let deferredPixelMatchedStr = '';
            if (!deferredExtraDesync && deferredPixelHash) {
              const guestPixelHash = _captureCanvasHash();
              const postResync = _lastResyncFrame > 0 && _frameNum - _lastResyncFrame <= _syncCheckInterval * 2;
              if (guestPixelHash && guestPixelHash !== deferredPixelHash) {
                _syncLog(
                  `PIXEL-DESYNC (deferred) frame=${_pendingSyncCheck.frame} local=${guestPixelHash} host=${deferredPixelHash}${postResync ? ' [post-resync]' : ''}`,
                );
                deferredPixelMatchedStr = ' pixel=✗';
              } else if (guestPixelHash) {
                deferredPixelMatchedStr = ` pixel=✓${postResync ? ' RESYNC-VISUAL-OK' : ''}`;
              }
            }

            if (!deferredExtraDesync) {
              const verifiedStr = (deferredBlk25 ? ' blk25=✓' : '') + deferredPixelMatchedStr;
              _syncLog(`sync OK (deferred) frame=${_pendingSyncCheck.frame} hash=${guestHash}${verifiedStr}`);
              _consecutiveResyncs = 0;
              _syncMismatchStreak = 0;
              _syncCheckInterval = _syncBaseInterval;
              _resetDrift();
            }
          }
        } else {
          // Fallback: async hash via HEAPU8 (RDRAM)
          try {
            const deferBytes = getHashBytes();
            if (deferBytes) {
              const deferCheck = _pendingSyncCheck; // capture before nulling
              // NOTE: intentionally fire-and-forget .then() — runs in frame loop, must not block
              workerPost({ type: 'hash', data: deferBytes })
                .then((res) => {
                  if (res.hash !== deferCheck.hash) {
                    _syncLog(`DESYNC (deferred) at frame ${deferCheck.frame}`);
                    _recordDrift(null);
                    const now3 = performance.now();
                    if (_tryApplyPreloaded()) {
                      // instant resync
                    } else if (!_pendingResyncState && now3 - _lastResyncTime > _resyncCooldownMs()) {
                      _lastResyncTime = now3;
                      const sp = _peers[deferCheck.peerSid];
                      if (sp?.dc) {
                        try {
                          sp.dc.send('sync-request');
                        } catch (_) {}
                      }
                    }
                  } else {
                    _consecutiveResyncs = 0;
                    _syncCheckInterval = _syncBaseInterval;
                    _resetDrift();
                  }
                })
                .catch((e) => _syncLog(`deferred sync hash worker failed: ${e.message || e}`));
            }
          } catch (_) {}
        }
      }
      _pendingSyncCheck = null;
    }

    // -- Periodic desync check (star topology: host-only) -----
    if (_syncEnabled && _playerSlot === 0 && _frameNum > 0 && _frameNum % _syncCheckInterval === 0) {
      if (_hasKnSync && window.EJS_emulator?.gameManager?.Module) {
        // C-level hash — synchronous, no HEAPU8, no worker
        const mod = window.EJS_emulator.gameManager.Module;
        const hash = mod._kn_sync_hash();
        const cycleMs = mod._kn_get_cycle_time_ms ? mod._kn_get_cycle_time_ms() : 0;
        let regionSuffix = '';
        if (mod._kn_sync_hash_regions) {
          const hb = mod._malloc(48);
          const rc = mod._kn_sync_hash_regions(hb, 12);
          const rh = [];
          for (let ri = 0; ri < rc; ri++) rh.push(mod.HEAPU32[(hb >> 2) + ri] >>> 0);
          mod._free(hb);
          regionSuffix = `:${rh.join(':')}`;
        }
        const blk25Hash = _getBlk25Hash(mod);
        const pixelHash = _captureCanvasHash();
        const extraFields = (blk25Hash ? `:blk25=${blk25Hash}` : '') + (pixelHash ? `:ph=${pixelHash}` : '');
        const syncMsg = `sync-hash:${_frameNum}:${hash}:${cycleMs.toFixed(1)}${regionSuffix}${extraFields}`;
        const peers = getActivePeers();
        let sent = 0;
        for (const p of peers) {
          try {
            p.dc.send(syncMsg);
            sent++;
          } catch (_) {}
        }
        if (_frameNum % (_syncCheckInterval * 10) === 0) {
          _syncLog(`sync-check frame=${_frameNum} hash=${hash} sent=${sent}`);
        }
        // RDRAM block scan — every 300 frames (~5s). Samples 256 bytes at the
        // start of each 64KB block to find which blocks are live during gameplay.
        // Proactive state push — every N frames, push state to guests so they have
        // a fresh snapshot for instant resync (no round-trip on next desync).
        if (_frameNum % _PROACTIVE_SYNC_INTERVAL === 0 && getActivePeers().length > 0) {
          pushSyncState(null, true); // null = broadcast, true = proactive
        }

        if (mod._kn_rdram_block_hashes && _frameNum % 300 === 0) {
          const BLOCKS = 128;
          const buf = mod._malloc(BLOCKS * 4);
          mod._kn_rdram_block_hashes(buf, BLOCKS);
          const cur = new Uint32Array(BLOCKS);
          for (let bi = 0; bi < BLOCKS; bi++) cur[bi] = mod.HEAPU32[(buf >> 2) + bi];
          mod._free(buf);
          if (_prevBlockHashes) {
            const changed = [];
            for (let bi = 0; bi < BLOCKS; bi++) {
              if (cur[bi] !== _prevBlockHashes[bi]) changed.push(`0x${(bi * 0x10000).toString(16).padStart(6, '0')}`);
            }
            if (changed.length) _syncLog(`RDRAM-LIVE-BLOCKS f=${_frameNum} changed=[${changed.join(',')}]`);
          }
          _prevBlockHashes = cur;
        }
      } else {
        // Fallback: async hash via HEAPU8 + worker
        const hashBytes = getHashBytes();
        if (hashBytes) {
          const checkFrame = _frameNum;
          const peers = getActivePeers();
          // NOTE: intentionally fire-and-forget .then() — runs in frame loop, must not block
          workerPost({ type: 'hash', data: hashBytes })
            .then((res) => {
              const syncMsg = `sync-hash:${checkFrame}:${res.hash}:0`;
              let sent = 0;
              for (const p of peers) {
                try {
                  p.dc.send(syncMsg);
                  sent++;
                } catch (_) {}
              }
              const hostMsg = `sync-check frame=${checkFrame} hash=${res.hash} sent=${sent}/${peers.length}`;
              _syncLog(hostMsg);
            })
            .catch((e) => _syncLog(`periodic sync hash worker failed: ${e.message || e}`));
        }
      }
    }

    // Debug overlay -- update every 15 frames (~4x per second)
    if (_frameNum % 15 === 0) {
      const dbg = document.getElementById('np-debug');
      if (dbg) {
        dbg.style.display = '';
        const playerCount = activePeers.length + 1; // +1 for self
        const spectatorCount = Object.values(_peers).filter((p) => p.slot === null).length;
        let remoteBufTotal = 0;
        for (const slot of Object.keys(_remoteInputs)) {
          remoteBufTotal += Object.keys(_remoteInputs[slot] || {}).length;
        }
        dbg.textContent = `F:${_frameNum} fps:${_fpsCurrent} slot:${_playerSlot} players:${playerCount}${spectatorCount > 0 ? ` spec:${spectatorCount}` : ''} delay:${DELAY_FRAMES} rBuf:${remoteBufTotal} rcv:${_remoteReceived} hit:${_remoteApplied} miss:${_remoteMissed} lastR:${_lastRemoteFrame}`;
      }
    }
  };

  // -- Input read ------------------------------------------------------------

  // ── Virtual gamepad (EJS touch controls) capture ──────────────────────
  // EJS calls simulateInput(player, button, value) directly into WASM.
  // We intercept it to track which buttons are held, so readLocalInput()
  // can include touch inputs in the netplay bitmask.
  // Touch state lives in KNState.touchInput — shared with VirtualGamepad
  // via the global namespace (no fragile object-reference passing).

  const hookVirtualGamepad = () => {
    const gm = window.EJS_emulator?.gameManager;
    if (!gm || gm._kn_hooked) return;
    gm.simulateInput = (player, index, value) => {
      // Only capture player 0 (local player's touch input)
      if (player === 0) {
        // Suppress input while EJS menus/popups are open.  The virtual
        // gamepad touch handlers in EmulatorJS don't check for menus
        // (unlike the keyboard/gamepad handlers), so tapping the screen
        // while the settings bar or a popup is visible sends spurious
        // inputs that desync mobile players.
        const ejs = window.EJS_emulator;
        if (ejs) {
          if (ejs.settingsMenuOpen) return;
          if (ejs.isPopupOpen?.()) return;
          if (ejs.elements?.menu && !ejs.elements.menu.classList.contains('ejs_menu_bar_hidden')) return;
        }
        KNState.touchInput[index] = value;
      }
      // Don't call original — our writeInputToMemory handles input delivery.
      // Letting EJS also write would double-apply and bypass lockstep.
    };
    gm._kn_hooked = true;
    _syncLog('hooked EJS simulateInput for touch capture');
  };

  const readLocalInput = () => KNShared.readLocalInput(_playerSlot, _p1KeyMap, _heldKeys);

  window.debugInput = () => {
    window._debugInputUntil = performance.now() + 3000;
    console.log('[input-debug] Logging input for 3 seconds — press buttons now');
  };

  // -- Inline Web Worker for hash + compress/decompress ----------------------
  //
  // Offloads CPU-intensive sync work (FNV-1a hash, gzip compress/decompress)
  // to a dedicated thread so the main thread tick loop isn't blocked.

  let _syncWorker = null;
  let _syncWorkerCallbacks = {}; // id -> callback
  let _syncWorkerNextId = 0;

  const getSyncWorker = () => {
    if (_syncWorker) return _syncWorker;
    const code = [
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
    const blob = new Blob([code], { type: 'application/javascript' });
    _syncWorkerUrl = URL.createObjectURL(blob);
    _syncWorker = new Worker(_syncWorkerUrl);
    _syncWorker.onmessage = (e) => {
      const cb = _syncWorkerCallbacks[e.data.id];
      if (cb) {
        delete _syncWorkerCallbacks[e.data.id];
        cb(e.data);
      }
    };
    return _syncWorker;
  };

  const workerPost = (msg) =>
    new Promise((resolve, reject) => {
      const id = _syncWorkerNextId++;
      msg.id = id;
      _syncWorkerCallbacks[id] = (result) => {
        if (result.error) reject(new Error(result.error));
        else resolve(result);
      };
      // Transfer ArrayBuffer if present (zero-copy to worker)
      const transfer = msg.data?.buffer ? [msg.data.buffer] : [];
      getSyncWorker().postMessage(msg, transfer);
    });

  // -- Compression helpers (delegate to worker when available) ---------------

  async function compressState(bytes) {
    try {
      const result = await workerPost({ type: 'compress', data: bytes });
      return result.data;
    } catch (e) {
      // Worker fallback: compress on main thread
      return compressStateFallback(bytes);
    }
  }

  async function compressStateFallback(bytes) {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const reader = cs.readable.getReader();
    const chunks = [];
    while (true) {
      const result = await reader.read();
      if (result.value) chunks.push(result.value);
      if (result.done) break;
    }
    const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
      out.set(chunks[i], offset);
      offset += chunks[i].length;
    }
    return out;
  }

  async function decompressState(bytes) {
    try {
      const result = await workerPost({ type: 'decompress', data: bytes });
      return result.data;
    } catch (e) {
      // Worker fallback: decompress on main thread
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(bytes);
      writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      while (true) {
        const result2 = await reader.read();
        if (result2.value) chunks.push(result2.value);
        if (result2.done) break;
      }
      const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
      let offset = 0;
      for (let i = 0; i < chunks.length; i++) {
        out.set(chunks[i], offset);
        offset += chunks[i].length;
      }
      return out;
    }
  }

  const uint8ToBase64 = (bytes) => {
    const chunkSize = 32768;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  };

  const base64ToUint8 = (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  };

  // -- Combined compress+encode / decode+decompress (worker-offloaded) -------

  async function compressAndEncode(bytes) {
    try {
      const result = await workerPost({ type: 'compress-and-encode', data: bytes });
      return result;
    } catch (e) {
      // Fallback: main thread
      const compressed = await compressStateFallback(bytes);
      return {
        data: uint8ToBase64(compressed),
        rawSize: bytes.length,
        compressedSize: compressed.length,
      };
    }
  }

  async function decodeAndDecompress(b64) {
    try {
      const result = await workerPost({ type: 'decode-and-decompress', data: b64 });
      return result.data;
    } catch (e) {
      // Fallback: main thread
      const compressed = base64ToUint8(b64);
      return decompressState(compressed);
    }
  }

  // -- Keyboard / input setup ------------------------------------------------

  const setupKeyTracking = () => {
    _p1KeyMap = KNShared.setupKeyTracking(_p1KeyMap, _heldKeys);
  };

  // -- Direct memory hashing (avoids expensive getState() serialization) ------

  const getHashBytes = () => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod) return null;

    // Discover RDRAM pointer FRESH each time. The core may remap RDRAM
    // after save state loads (which happen during lockstep initial sync
    // and resyncs), making cached pointers stale.
    if (mod.cwrap) {
      try {
        const getMemData = mod.cwrap('get_memory_data', 'string', ['string']);
        const result = getMemData('RETRO_MEMORY_SYSTEM_RAM');
        if (result) {
          const parts = result.split('|');
          const rdramSize = parseInt(parts[0], 10);
          const rdramPtr = parseInt(parts[1], 10);
          if (rdramPtr > 0 && rdramSize > 0) {
            if (_hashRegion === null) {
              const bufSrc = mod.wasmMemory
                ? 'wasmMemory'
                : mod.asm?.memory
                  ? 'asm.memory'
                  : mod.buffer
                    ? 'mod.buffer'
                    : 'HEAPU8.buffer';
              _syncLog(`hash: RDRAM at [${rdramPtr}], size=${rdramSize}, buf=${bufSrc}`);
            } else if (_hashRegion?.ptr !== rdramPtr) {
              _syncLog(`hash: RDRAM moved! old=${_hashRegion.ptr} new=${rdramPtr}`);
            }
            _hashRegion = { ptr: rdramPtr, size: rdramSize };
          }
        }
      } catch (_) {}
    }

    // Direct RDRAM read using scan-verified regions (Playwright automated scan).
    // Buffer staleness: detect detached buffer and try re-acquisition.
    let buf = mod.HEAPU8 ? mod.HEAPU8.buffer : null;
    if (!buf || buf.byteLength === 0) {
      buf = mod.wasmMemory?.buffer || mod.asm?.memory?.buffer || null;
    }
    if (_hashRegion?.ptr && buf && buf.byteLength > 0) {
      try {
        const live = new Uint8Array(buf);
        const base = _hashRegion.ptr;

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
        const gameRegions = [
          0xa4000, // player/match config
          0xba000, // player state block start
          0xbf000, // player state block mid
          0xc4000, // player state block end
          0x262000, // physics block 1
          0x266000, // physics block 1 mid
          0x26a000, // physics block 1 end
          0x290000, // misc gameplay
          0x2f6000, // physics block 2
          0x32b000, // physics block 3 start
          0x330000, // physics block 3 mid
          0x335000, // physics block 3 end
        ];
        const SAMPLE = 256;
        const combined = new Uint8Array(SAMPLE * gameRegions.length);
        for (let gi = 0; gi < gameRegions.length; gi++) {
          const gOff = base + gameRegions[gi];
          combined.set(live.subarray(gOff, gOff + SAMPLE), gi * SAMPLE);
        }
        return combined;
      } catch (e) {
        _syncLog(`hash: RDRAM read failed: ${e.message}`);
      }
    }

    // Fallback: getState() — expensive but always correct
    try {
      const gm = window.EJS_emulator?.gameManager;
      if (!gm) return null;
      const raw = gm.getState();
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      return bytes.slice(0x100000, Math.min(0x300000, bytes.length));
    } catch (_) {
      return null;
    }
  };

  // -- Async state sync (compress/decompress via Web Worker) -----------------

  let _pushingSyncState = false; // debounce concurrent sync-request handling

  let _lastSyncState = null; // host/guest: previous state for delta computation
  let _lastSyncStateInfo = null; // { frame, setBy, ts } for debugging

  const _setLastSyncState = (state, reason) => {
    _lastSyncState = state;
    _lastSyncStateInfo = state ? { frame: _frameNum, setBy: reason, ts: performance.now() } : null;
    _syncLog(`deltaBase ${state ? 'SET' : 'NULL'} reason=${reason} frame=${_frameNum} size=${state?.length ?? 0}`);
  };

  const pushSyncState = async (targetSid, isProactive = false) => {
    // Host: capture state, compute delta if possible, compress, and send.
    if (_playerSlot !== 0 || !_syncEnabled) return;
    if (_pushingSyncState) return;

    const gm = window.EJS_emulator?.gameManager;
    if (!gm) return;
    _pushingSyncState = true;
    let currentState;
    const frame = _frameNum;

    if (_hasKnSync) {
      // C-level: read state directly from g_dev — no getState(), no memory growth
      ensureSyncBuffer();
      const mod = gm.Module;
      const ps0 = performance.now();
      const bytesWritten = mod._kn_sync_read(_syncBufPtr, _syncBufSize);
      const ps1 = performance.now();
      if (bytesWritten === 0) {
        _syncLog('kn_sync_read returned 0');
        _pushingSyncState = false;
        return;
      }
      currentState = new Uint8Array(mod.HEAPU8.buffer, _syncBufPtr, bytesWritten).slice();
      _syncLog(`host kn_sync_read: ${Math.round(currentState.length / 1024)}KB, ${(ps1 - ps0).toFixed(1)}ms`);
    } else {
      // Fallback: existing getState path
      const ps0 = performance.now();
      const raw = gm.getState();
      const ps1 = performance.now();
      currentState = raw instanceof Uint8Array ? raw.slice() : new Uint8Array(raw);
      _syncLog(`host getState (FALLBACK): ${Math.round(currentState.length / 1024)}KB, ${(ps1 - ps0).toFixed(1)}ms`);
    }

    // Delta sync: XOR against previous state
    const isFull = !_lastSyncState || _lastSyncState.length !== currentState.length;
    _syncLog(
      `pushSync: lastState=${_lastSyncState ? _lastSyncState.length : 'null'} current=${currentState.length} isFull=${isFull}`,
    );
    let toCompress;
    if (isFull) {
      toCompress = currentState;
    } else {
      toCompress = new Uint8Array(currentState.length);
      for (let i = 0; i < currentState.length; i++) {
        toCompress[i] = currentState[i] ^ _lastSyncState[i];
      }
    }
    // Update delta base (guest caches after applying).
    // Must .slice() because compressState() transfers the buffer to a Web Worker,
    // which detaches the ArrayBuffer. Without the copy, _lastSyncState.length === 0
    // on the next push and delta never fires.
    _setLastSyncState(currentState.slice(), 'pushSync');

    try {
      const compressed = await compressState(toCompress);
      const sizeKB = Math.round(compressed.length / 1024);
      _syncLog(`${isFull ? 'full' : 'delta'} state: ${sizeKB}KB compressed`);
      await sendSyncChunks(compressed, frame, isFull, targetSid, isProactive);
    } catch (err) {
      _syncLog(`sync compress failed: ${err}`);
    } finally {
      _pushingSyncState = false;
    }
  };

  const sendSyncChunks = async (compressed, frame, isFull, targetSid, isProactive = false) => {
    // Host: send compressed state/delta via DC in 64KB chunks.
    // Chunks are sent with yields between them so input messages can
    // interleave — prevents DataChannel saturation that causes mutual
    // input deadlock (see project_stall_timeout_desync).
    const CHUNK_SIZE = 64000;
    const numChunks = Math.ceil(compressed.length / CHUNK_SIZE);
    let targets;
    if (targetSid && _peers[targetSid]) {
      targets = [_peers[targetSid]];
    } else {
      targets = getActivePeers();
    }

    const header = `sync-start:${frame}:${numChunks}:${isFull ? '1' : '0'}:${isProactive ? '1' : '0'}`;
    for (const target of targets) {
      const dc = target.dc;
      if (!dc || dc.readyState !== 'open') {
        _syncLog(`sync send skipped: target slot=${target.slot} dc=${dc ? dc.readyState : 'null'}`);
        continue;
      }
      try {
        dc.send(header);
        for (let i = 0; i < numChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, compressed.length);
          dc.send(compressed.slice(start, end));
          // Yield after every 3 chunks (~192KB) so the tick loop can
          // send input messages between bursts. Without this, 15 chunks
          // (894KB) saturates the DC buffer and blocks input delivery.
          if ((i + 1) % 3 === 0 && i < numChunks - 1) {
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        _syncLog(`sync sent to slot=${target.slot}: header + ${numChunks} chunks`);
      } catch (err) {
        _syncLog(`sync send failed to slot=${target.slot}: ${err}`);
      }
    }
    _syncLog(
      `pushed ${isFull ? 'full' : 'delta'} state frame ${frame} (${Math.round(compressed.length / 1024)}KB, ${numChunks} chunks)`,
    );
  };

  const handleSyncChunksComplete = async () => {
    // Guest: reassemble chunks, decompress, reconstruct state, buffer for apply.
    const total = _syncChunks.reduce((a, c) => a + c.length, 0);
    const assembled = new Uint8Array(total);
    let offset = 0;
    for (const chunk of _syncChunks) {
      assembled.set(chunk, offset);
      offset += chunk.length;
    }
    _syncChunks = [];
    _syncExpected = 0;
    const frame = _syncFrame;
    const isFull = _syncIsFull;
    const isProactive = _syncIsProactive;

    try {
      const decompressed = await decompressState(assembled);
      let fullBytes;
      if (isFull) {
        fullBytes = decompressed;
      } else {
        // Delta: XOR against _lastSyncState. Both host and guest cached this.
        if (!_lastSyncState || _lastSyncState.length !== decompressed.length) {
          _syncLog(
            `delta base missing or size mismatch: last=${_lastSyncState?.length} delta=${decompressed.length} — requesting full`,
          );
          const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
          if (hostPeer?.dc?.readyState === 'open') {
            try {
              hostPeer.dc.send('sync-request-full');
            } catch (_) {}
          }
          return;
        }
        fullBytes = new Uint8Array(_lastSyncState.length);
        for (let j = 0; j < _lastSyncState.length; j++) {
          fullBytes[j] = _lastSyncState[j] ^ decompressed[j];
        }
      }

      if (isProactive) {
        // Proactive push: buffer for instant resync on desync, don't apply now.
        // Advance the delta base so the next proactive delta chains correctly.
        _preloadedResyncState = { bytes: fullBytes, frame, receivedFrame: _frameNum };
        _setLastSyncState(fullBytes.slice(), 'proactive-received');
        _syncLog(`proactive state buffered: ${Math.round(assembled.length / 1024)}KB wire, frame=${frame}`);
      } else {
        _pendingResyncState = { bytes: fullBytes, frame };
        _syncLog(`resync ready (${isFull ? 'full' : 'delta'}, ${Math.round(assembled.length / 1024)}KB wire)`);
      }
    } catch (err) {
      _syncLog(`sync decompress failed: ${err}`);
    }
  };

  const applySyncState = (bytes, frame) => {
    // Guest: hot-swap emulator state at a clean frame boundary.
    // Called from tick() when _pendingResyncState is set — ensures loadState()
    // never fires mid-tick or mid-input-processing.
    //
    // KEY INSIGHT: The frame counter is only used for input synchronization.
    // By keeping _frameNum where it is, input buffers stay valid and no stall.
    const gm = window.EJS_emulator?.gameManager;
    if (!gm) return;

    if (_hasKnSync) {
      // C-level write: copy into WASM buffer, call kn_sync_write
      const mod = gm.Module;
      ensureSyncBuffer();
      if (!_syncBufPtr) {
        _syncLog(`FATAL: sync buffer allocation failed`);
        return;
      }
      if (bytes.length > _syncBufSize) {
        _syncLog(`FATAL: state (${bytes.length}) exceeds buffer (${_syncBufSize})`);
        return;
      }
      mod.HEAPU8.set(bytes, _syncBufPtr);
      const lt0 = performance.now();
      const result = mod._kn_sync_write(_syncBufPtr, bytes.length);
      const lt1 = performance.now();

      if (result !== 0) {
        _syncLog(`kn_sync_write failed: ${result} (bytes=${bytes.length} ptr=${_syncBufPtr})`);
        return;
      }

      // Cache applied state as delta base for next resync
      _setLastSyncState(bytes.slice(), 'applySyncC');

      _resyncCount++;
      _consecutiveResyncs++;
      _syncLog(`kn_sync_write: ${Math.round(bytes.length / 1024)}KB, ${(lt1 - lt0).toFixed(1)}ms`);
    } else {
      // Fallback: existing loadState path
      const lt0 = performance.now();
      gm.loadState(bytes);
      const lt1 = performance.now();

      // Re-capture rAF runner (loadState may invalidate _pendingRunner)
      const mod = gm.Module;
      mod.pauseMainLoop();
      mod.resumeMainLoop();

      // loadState may trigger WASM memory growth, detaching HEAPU8.buffer.
      if (mod.updateMemoryViews) {
        mod.updateMemoryViews();
      } else if (mod._emscripten_notify_memory_growth) {
        mod._emscripten_notify_memory_growth(0);
      }
      _hashRegion = null;

      // Cache applied state as delta base
      _setLastSyncState(new Uint8Array(bytes), 'applySyncFallback');

      _resyncCount++;
      _consecutiveResyncs++;
      _syncLog(`loadState: ${Math.round(bytes.length / 1024)}KB, ${(lt1 - lt0).toFixed(1)}ms`);
    }

    // Purge stale remote inputs above the new frame
    for (const [slot, inputs] of Object.entries(_remoteInputs)) {
      if (!inputs) continue;
      for (const f of Object.keys(inputs)) {
        if (parseInt(f, 10) > _frameNum + DELAY_FRAMES) delete inputs[f];
      }
    }

    _syncMismatchStreak = 0;
    _lastResyncFrame = _frameNum;
    const syncMsg = `sync #${_resyncCount} applied (frame ${frame} -> ${_frameNum}, next in ${_syncCheckInterval}f)`;
    _syncLog(syncMsg);
    const now = performance.now();
    if (now - _lastResyncToastTime > 5000) {
      _lastResyncToastTime = now;
      _config?.onSyncStatus?.('Desync corrected');
    }
  };

  // -- Init / Stop API -------------------------------------------------------

  let _config = null;

  const init = (config) => {
    _sessionId++; // invalidate stale timers from previous session
    _config = config;
    socket = config.socket;
    _playerSlot = config.playerSlot;
    _isSpectator = config.isSpectator;

    // Apply pre-game options
    _syncEnabled = !!config.rollbackEnabled; // default: false
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

    // Solo mode: no other players — start game sequence directly
    const otherPlayers = config.initialPlayers
      ? Object.values(config.initialPlayers.players || {}).filter((p) => p.socketId !== socket.id)
      : [];
    if (otherPlayers.length === 0 && _playerSlot === 0) {
      _syncLog('solo mode — no peers, starting game sequence');
      _rttComplete = true; // no peers to measure RTT with
      startGameSequence();
    }

    // Connection timeout warning (guarded by session ID to avoid firing
    // stale messages on quick restart)
    const initSid = _sessionId;
    setTimeout(() => {
      if (initSid !== _sessionId) return;
      if (!_gameStarted && _config) {
        const peerCount = Object.keys(_peers).length;
        if (peerCount === 0 && _playerSlot !== 0) {
          setStatus('No peer connection — check network');
        } else if (peerCount > 0) {
          const anyOpen = Object.values(_peers).some((p) => p.ready);
          if (!anyOpen) setStatus('Peer found but data channel not open');
        }
      }
    }, 15000);
    // startGameSequence() is triggered from ch.onopen (or solo mode above)
  };

  const stop = () => {
    DELAY_FRAMES = 2;
    _rttSamples = [];
    _rttComplete = false;
    _rttPeersComplete = 0;
    _rttPeersTotal = 0;

    // Stop lockstep tick loop
    stopSync();

    // Close all peer connections and clear reconnect timers
    for (const [sid, p] of Object.entries(_peers)) {
      if (p._reconnectTimeout) {
        clearTimeout(p._reconnectTimeout);
        p._reconnectTimeout = null;
      }
      if (p._disconnectTimer) {
        clearTimeout(p._disconnectTimer);
        p._disconnectTimer = null;
      }
      if (p.dc)
        try {
          p.dc.close();
        } catch (_) {}
      if (p.pc)
        try {
          p.pc.close();
        } catch (_) {}
    }
    // Signal all reconnecting states cleared before nulling config
    if (_config?.onReconnecting) {
      try {
        _config.onReconnecting(null, false);
      } catch (_) {}
    }
    _peers = {};
    KNState.peers = _peers;

    // Restore all overridden browser APIs (rAF, performance.now, getGamepads)
    APISandbox.restoreAll();
    _manualMode = false;
    _pendingRunner = null;

    // Reset lockstep state
    _remoteInputs = {};
    _peerInputStarted = {};
    _localInputs = {};
    _frameNum = 0;
    KNState.frameNum = 0;
    _running = false;
    _lateJoin = false;
    _gameStarted = false;
    _selfEmuReady = false;
    _selfLockstepReady = false;
    _syncStarted = false;
    _cacheAttempted = false;
    _lockstepReadyPeers = {};
    _guestStateBytes = null;
    _knownPlayers = {};
    _lastRemoteFrame = -1;
    _lastRemoteFramePerSlot = {};
    _peerLastAdvanceTime = {};
    _peerPhantom = {};
    _consecutiveFabrications = {};
    _inputLateLogTime = {};
    _frameAdvantage = 0;
    _frameAdvRaw = 0;
    _framePacingActive = false;
    _pacingCapsCount = 0;
    _pacingCapsFrames = 0;
    _pacingMaxAdv = 0;
    _pacingAdvSum = 0;
    _pacingAdvCount = 0;
    _resyncCount = 0;
    _consecutiveResyncs = 0;
    _syncCheckInterval = _syncBaseInterval;
    _resetDrift();
    _syncChunks = [];
    _syncExpected = 0;
    _pushingSyncState = false;
    _pendingResyncState = null;
    _preloadedResyncState = null;
    _hashRegion = null;
    _awaitingResync = false;
    _awaitingResyncAt = 0;
    _lastResyncTime = 0;
    _heldKeys.clear();
    _p1KeyMap = null;
    if (_romWaitInterval) {
      clearInterval(_romWaitInterval);
      _romWaitInterval = null;
    }
    if (_syncWorker) {
      _syncWorker.terminate();
      _syncWorker = null;
    }
    if (_syncWorkerUrl) {
      URL.revokeObjectURL(_syncWorkerUrl);
      _syncWorkerUrl = null;
    }
    _syncWorkerCallbacks = {};
    _syncLogHead = 0;
    _syncLogCount = 0;

    // Clean up audio bypass
    if (_audioWorklet) {
      _audioWorklet.disconnect();
      _audioWorklet = null;
    }
    if (window._kn_scriptProcessor) {
      window._kn_scriptProcessor.disconnect();
      window._kn_scriptProcessor = null;
    }
    if (window._kn_audioEl) {
      window._kn_audioEl.pause();
      window._kn_audioEl.srcObject = null;
      window._kn_audioEl = null;
    }
    if (window._kn_keepAliveOsc) {
      try {
        window._kn_keepAliveOsc.stop();
      } catch (_) {}
      window._kn_keepAliveOsc = null;
    }
    window._kn_audioRing = null;
    window._kn_audioRingCount = 0;
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
      _hostStream.getTracks().forEach((t) => {
        t.stop();
      });
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

    // Clean up gesture audio element
    if (window._kn_gestureAudioEl) {
      window._kn_gestureAudioEl.pause();
      window._kn_gestureAudioEl.srcObject = null;
      window._kn_gestureAudioEl = null;
    }
    window._kn_gestureAudioDest = null;

    // Clean up custom virtual gamepad
    window._kn_ejsTouchDisabled = false;
    if (window.VirtualGamepad) {
      VirtualGamepad.destroy();
    }
    for (const ck in KNState.touchInput) {
      if (KNState.touchInput.hasOwnProperty(ck)) delete KNState.touchInput[ck];
    }

    // Dismiss gesture prompt if still showing
    const gp = document.getElementById('gesture-prompt');
    if (gp) gp.classList.add('hidden');

    _config = null;
  };

  window.NetplayLockstep = {
    init,
    stop,
    exportSyncLog,
    _startSpectatorStream: startSpectatorStream, // test hook
    onExtraDataChannel: (cb) => {
      _onExtraDataChannel = cb;
    },
    onUnhandledMessage: (cb) => {
      _onUnhandledMessage = cb;
    },
    getPeerConnection: (sid) => {
      const p = _peers[sid];
      return p ? p.pc : null;
    },
    setSyncEnabled: (on) => {
      _syncEnabled = !!on;
    },
    isSyncEnabled: () => _syncEnabled,
    setSyncInterval: (frames) => {
      _syncBaseInterval = _syncCheckInterval = Math.max(10, frames);
    },
    getInfo: () => {
      const peers = getActivePeers();
      // Use latest per-peer RTT samples (updated after reconnects) rather than
      // frozen global _rttSamples which only accumulates at game start
      const allRtts = peers.flatMap((p) => p.rttSamples ?? []);
      allRtts.sort((a, b) => a - b);
      const rtt = allRtts.length > 0 ? allRtts[Math.floor(allRtts.length / 2)] : null;
      const peerInfo = peers.map((peer) => ({
        slot: peer.slot,
        rtt: peer.rttSamples?.length > 0 ? peer.rttSamples[Math.floor(peer.rttSamples.length / 2)] : null,
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
    getDebugLog: () => _debugLog.slice(),
    _getPeers: () => _peers,
    dumpLogs: () => {
      if (socket?.connected) {
        const info = {
          slot: _playerSlot,
          frame: _frameNum,
          running: _running,
          syncEnabled: _syncEnabled,
          resyncCount: _resyncCount,
          peerCount: Object.keys(_peers).length,
          ua: navigator.userAgent,
        };
        socket.emit('debug-logs', { info, logs: _debugLog });
        _syncLog(`dumped ${_debugLog.length} log entries to server`);
      }
    },
  };
})();
