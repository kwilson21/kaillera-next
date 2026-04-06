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
 *   The host (slot 0) is the roster authority — it broadcasts which player
 *   slots are active over DataChannels. All peers apply the same roster to
 *   ensure identical input application on every frame.
 *
 * ── Startup Sequence ──────────────────────────────────────────────────────
 *
 *   1. All players boot EmulatorJS independently and wait for the WASM
 *      core to be ready (MIN_BOOT_FRAMES = 120 frames for all players).
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
 *      median RTT determines initial auto frame delay: ceil(median_ms / 16.67),
 *      clamped to [2, 9]. Both sides exchange their delay preference and
 *      the maximum becomes the effective DELAY_FRAMES. Delay is fixed for
 *      the entire session — no dynamic adjustment during play.
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
 *     2. Proportional frame pacing check (see Frame Pacing below) —
 *        probabilistically skip ticks based on how far ahead of slowest peer
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
 *        AudioWorklet (or ScriptProcessorNode fallback)
 *     9. Increment frame counter. Periodically update debug overlay.
 *
 * ── Frame Pacing (Proportional Throttle) ────────────────────────────────
 *
 *   Prevents the faster machine from outrunning the slower one's input
 *   stream. Tracks frame advantage (local frame - min remote frame) as
 *   an exponential moving average with asymmetric alpha:
 *     - Rising (falling behind): α = 0.1 (slow to trigger, avoids jitter)
 *     - Falling (catching up):   α = 0.2 (fast to release throttle)
 *   Proportional skip based on excess = rawAdvantage - DELAY_FRAMES:
 *     excess 1 → 25% skip, excess 2 → 50%, excess 3 → 75%, excess ≥4 → 100%
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
 *   _kn_get_audio_rate) and fed to an AudioWorklet ring buffer (~500ms,
 *   large enough to bridge resync stalls) in audio-worklet-processor.js.
 *   Falls back to ScriptProcessorNode when AudioWorklet is unavailable
 *   (AudioBufferSourceNode doesn't produce sound on iOS WKWebView).
 *   The patched WASM core bypasses AUDIO_FLAG_SUSPENDED in deterministic
 *   mode so audio capture always runs regardless of RetroArch's internal
 *   suspend/resume state. This ensures audio is frame-locked to the
 *   lockstep tick and identical across all players.
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
 * ── RNG Seed Synchronization (Smash Remix) ──────────────────────────────
 *
 *   For Smash Remix netplay, per-frame RNG seeds are derived from a base
 *   seed (hashed from matchId) and the current frame number, then written
 *   to WASM RDRAM before each frame step. This bounds RNG divergence to
 *   single frames even if code paths temporarily differ. On late join,
 *   the host transfers current RNG state in the late-join-state message.
 *
 * ── FPU Trace Verification ──────────────────────────────────────────────
 *
 *   The host periodically (every 300 frames) broadcasts FNV-1a hashes of
 *   the FPU instruction trace ring buffer. Guests compare their local
 *   trace hash to detect cross-platform FPU divergence (e.g., ARM vs x86
 *   WASM JIT differences). Mismatches log the last 20 FPU ops and emit
 *   debug-sync events for investigation.
 *
 * ── Dual DataChannels (Input + Sync-State) ──────────────────────────────
 *
 *   Each peer connection has two DataChannels: 'lockstep' (default
 *   priority) for 16-byte input messages and 'sync-state' (very-low
 *   priority) for state transfer. This prevents 1MB+ state bursts from
 *   blocking the SCTP stream and causing 200-450ms input stalls.
 *
 * ── Desync Detection & Resync (Star Topology) ────────────────────────────
 *
 *   Opt-in (resyncEnabled flag). Star topology: host (slot 0) is the
 *   sync authority. Two hashing paths:
 *
 *   1. C-level (patched core): _kn_sync_hash() hashes game-specific
 *      RDRAM regions directly in C — fast and deterministic.
 *      _kn_sync_hash_regions and _kn_sync_read/write_regions exports
 *      exist but are disabled pending frame-level state management (v2).
 *      Currently uses full _kn_sync_read/write for state transfer.
 *   2. JS fallback: FNV-1a hash of RDRAM via direct HEAPU8 access,
 *      falling back to getState() serialization.
 *
 *   Periodic hash broadcasts are disabled — AI DMA determinism +
 *   SoftFloat FPU makes steady-state gameplay deterministic. Resync is
 *   only triggered by reconnect/peer-recovery events and explicit
 *   sync-requests. When triggered, the host responds with compressed
 *   state in 64KB DataChannel chunks. State is buffered for async
 *   application at the next clean frame boundary — no mid-frame stall.
 *   Resync attempts use exponential backoff (400ms→8s) to avoid cascades.
 *   State is XOR-delta compressed against the last applied state; proactive
 *   pushes are always full (independent of the delta chain) so packet loss
 *   is harmless.
 *
 * ── Peer Phantom Detection ──────────────────────────────────────────────
 *
 *   Tracks wall-clock time of each peer's last frame advancement. If a
 *   peer hasn't sent a new frame for 5 seconds (PEER_DEAD_MS), it's
 *   marked as phantom and excluded from pacing calculations. On recovery
 *   (frame arrives), phantom state clears and a resync is triggered.
 *
 * ── Mesh Health Check (~5s) ──────────────────────────────────────────────
 *
 *   Every 300 frames, the host reconciles _knownPlayers (server truth
 *   from users-updated events) against actual DataChannel state. Re-
 *   initiates WebRTC connections to players the server says are active
 *   but who don't have healthy DCs.
 *
 * ── Coordinated Sync Scheduling ──────────────────────────────────────────
 *
 *   When multiple guests request sync at the same frame, the host
 *   schedules a single state capture at currentFrame + 15 (to absorb
 *   RTT) and broadcasts to all requesting guests simultaneously.
 *
 * ── Audio Fade on Resync ─────────────────────────────────────────────────
 *
 *   Before applying a resync state, audio fades out over 30ms via
 *   GainNode. After state load, fades back in over 50ms. Prevents
 *   audio pops/clicks during state snaps.
 *
 * ── Late Join ─────────────────────────────────────────────────────────────
 *
 *   Pull model — the joiner requests state when ready:
 *     1. Joiner boots emulator minimally, enters manual mode
 *     2. Sends "request-late-join" via Socket.IO data-message
 *     3. Host captures + compresses state, sends "late-join-state" with
 *        the current frame number and effective delay
 *     4. Joiner loads state, syncs frame counter to hostFrame, pre-fills
 *        delay gap with zero input, starts lockstep tick loop
 *   The late-joiner always initiates WebRTC connections to avoid the
 *   offer-before-listener race condition.
 *
 * ── Drop Handling ─────────────────────────────────────────────────────────
 *
 *   When a peer's DataChannel closes or ICE connection fails:
 *     - Reconnect is attempted for up to 15 seconds (re-offer cycle)
 *     - If reconnect fails, their input in WASM memory is zeroed
 *       (neutral stick, no buttons)
 *     - They're removed from the peer map and input tracking
 *     - Remaining players continue — the tick loop handles zero active
 *       peers gracefully (single-player mode)
 *     - The dropped player can re-join as late join
 *
 * ── Tab Visibility ──────────────────────────────────────────────────────
 *
 *   A visibilitychange listener detects when the tab loses or regains
 *   focus. Background tabs are naturally throttled by the browser
 *   (~1fps setInterval). On return to foreground, a full resync is
 *   requested and the frame counter fast-forwards to recover.
 *
 * ── Diagnostics ─────────────────────────────────────────────────────────
 *
 *   _debugLog: timestamped log of [lockstep] and [play] console output
 *   _syncLogRing: 10,000-entry circular buffer for sync events (hash
 *     mismatches, resync triggers, frame caps), exportable as CSV
 *   _diagEventLog: frame-level diagnostic events (cleared each tick,
 *     only active when window._KN_DIAG is set)
 *   debug-sync / debug-logs: Socket.IO events for remote log upload to server
 *   Sync hash/resync operations run in a Web Worker to avoid blocking
 *   the main thread during compression/decompression.
 */

(function () {
  'use strict';

  const _getIceServers = () => window._iceServers || KNState.DEFAULT_ICE_SERVERS;

  // ── Debug log capture ─────────────────────────────────────────────────
  // Intercepts all console.log('[lockstep] ...') calls for remote debugging.
  // Unbounded array — game sessions are finite. Pushed to server on demand.
  const _debugLog = [];
  const _debugLogStart = Date.now();
  let _originalConsoleLog = null;
  (function () {
    _originalConsoleLog = console.log;
    const _origLog = _originalConsoleLog;
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
      // Delay stays fixed for the session — changing it mid-match breaks
      // muscle memory for combo timing. Input stalls and resync handle
      // transient latency spikes instead.
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
  const _diagEventLog = []; // buffered async events [{t, type, detail}]
  let _diagHookInstalled = false; // true once async event hooks are set up
  let _diagVisHandler = null;
  let _diagFocusHandler = null;
  let _diagBlurHandler = null;
  let _diagTouchHandlers = []; // [{el, evName, handler}]
  let _diagObserver = null;
  const DIAG_INPUT_INTERVAL = 300; // frames between input read logs
  const DIAG_EARLY_FRAMES = 30; // log everything for first N frames

  // -- State -----------------------------------------------------------------

  let socket = null;
  let _playerSlot = -1; // 0-3 for players, null for spectators
  let _isSpectator = false;
  let _useCRollback = false; // true when C-level rollback engine is active
  // -- Audio bypass state --
  let _audioCtx = null;
  let _audioWorklet = null;
  let _audioDestNode = null;
  let _resyncGainNode = null; // GainNode for fade-out/fade-in around resyncs
  // Canvas hash checks only run after reconnect events — during steady-state
  // gameplay, trust AI DMA determinism. GPU rendering differences between platforms
  // cause false-positive canvas mismatches that trigger unnecessary resyncs.
  let _canvasCheckUntil = 0; // frame number until which canvas checks are active
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

  const _syncRequestCooldowns = new Map();
  const _SYNC_REQUEST_COOLDOWN_MS = 5000;

  // Lockstep state
  let _lockstepReadyPeers = {}; // remoteSid -> true when peer signals lockstep-ready
  let _selfLockstepReady = false;
  let _guestStateBytes = null; // decompressed state bytes to load
  let _frameNum = 0; // current logical frame number
  let _localInputs = {}; // frame -> input object
  let _remoteInputs = {}; // slot -> {frame -> input object} (nested for multi-peer)
  let _peerInputStarted = {}; // slot -> true once first input received (survives buffer drain)
  let _activeRoster = null; // Set<number> of active slots — host-authoritative, null until first roster
  let _rosterChangeFrame = -1; // frame when roster last changed — enables dense DIAG-INPUT logging
  let _running = false; // tick loop active
  let _lateJoin = false; // true when joining a game already in progress
  let _lateJoinPaused = false; // host pauses tick loop while late-joiner loads state

  // Smash Remix ROM hashes (for game-specific RNG/settings sync).
  // Must match hashes in server/config/known_roms.json.
  const _SMASH_REMIX_HASHES = new Set([
    'S73855bdf5e8753c546a31e278dfe558c3eaa575b97752c1d95950d66b1161130', // v2.0.0
    'S7efec9e0983656bb0219a23c511cd1505a5f84d524e50ad4284dc1c7eb4d1403', // v2.0.1
  ]);
  const _isSmashRemix = () => _SMASH_REMIX_HASHES.has(_config?.romHash);

  // -- Deterministic RNG sync for Smash Remix netplay --
  // Per-frame seed reset: before each frame, writes a deterministic seed
  // derived from (base_seed, frame_counter) to the game's RNG RDRAM address.
  // This bounds any RNG divergence to a single frame — even if code paths
  // differ briefly (e.g., roster change), the next frame resets the seed.
  const KN_RNG_SEED_RDRAM = 0x0005b940; // primary LCG seed
  const KN_RNG_ALT_SEED_RDRAM = 0x000a0578; // alternate seed
  let _rngPatched = false;
  let _rngSeed = 0;
  let _rdramBase = 0; // WASM heap byte offset of RDRAM

  const _hashString = (str) => {
    let h = 0x811c9dc5; // FNV-1a offset basis
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193); // FNV prime
    }
    return h >>> 0;
  };

  const _getRdramBase = (mod) => {
    if (_rdramBase) return _rdramBase;
    if (!mod._get_memory_data || !mod.stringToNewUTF8) return 0;
    const key = mod.stringToNewUTF8('RETRO_MEMORY_SYSTEM_RAM');
    const result = mod._get_memory_data(key);
    mod._free(key);
    if (!result) return 0;
    const [size, ptr] = mod.UTF8ToString(result).split('|').map(Number);
    if (!ptr || size < 0x800000) return 0;
    _rdramBase = ptr;
    return ptr;
  };

  const _rdram32 = (mod, rdramOffset) => {
    return (_rdramBase >> 2) + (rdramOffset >> 2);
  };

  const _initRNGSync = (mod) => {
    if (_rngPatched || !_isSmashRemix()) return false;
    const base = _getRdramBase(mod);
    if (!base) return false;
    _rngSeed = _hashString(KNState.matchId || 'kn-default');
    _rngPatched = true;
    _syncLog(`RNG sync enabled: baseSeed=0x${_rngSeed.toString(16)} rdramBase=0x${base.toString(16)}`);
    return true;
  };

  const _syncRNGSeed = (mod, frameNum) => {
    if (!_rngPatched || !_rdramBase) return;
    // Deterministic seed for this frame: hash(baseSeed, frameNum)
    let h = _rngSeed ^ Math.imul(frameNum, 0x45d9f3b7);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = (h ^ (h >>> 13)) >>> 0;
    mod.HEAPU32[_rdram32(mod, KN_RNG_SEED_RDRAM)] = h;
    mod.HEAPU32[_rdram32(mod, KN_RNG_ALT_SEED_RDRAM)] = h;
  };

  // Manual mode / rAF interception state (native refs managed by APISandbox)
  let _pendingRunner = null; // captured Emscripten MainLoop_runner
  let _manualMode = false; // true once enterManualMode() called
  let _stallStart = 0; // timestamp when current stall began
  let _resendSent = false; // true once resend request sent for current stall
  let _syncStarted = false; // true once initial state sync begins (prevents re-entry)
  let _awaitingLateJoinState = false; // true when late-join path taken, prevents normal sync
  let _tickInterval = null; // setInterval handle for tick loop
  // Saved originals of WASM speed-control functions — neutralized during lockstep
  let _origToggleFF = null; // Module._toggle_fastforward
  let _origToggleSM = null; // Module._toggle_slow_motion

  // State sync — host checks game state hash and pushes only when desynced
  let _syncEnabled = false; // off by default — opt-in via toolbar button
  // (sync compression uses CompressionStream/DecompressionStream directly)
  let _syncCheckInterval = 10; // check hash every N frames (~166ms at 60fps)
  let _syncBaseInterval = 10; // direct RDRAM reads are ~0.1ms (no getState)
  // Coordinated state injection: guest requests capture at a future frame so both
  // sides reach that frame together — host captures at exactly that frame, guest
  // applies it there. Snap = 0 (both are at the same frame). Stall = RTT/2 frames.
  const SYNC_COORD_DELTA = 15; // frames ahead to schedule capture; must exceed RTT in frames
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
  // Resync cooldown: minimum time between applying a state and sending the next explicit request.
  // Exponential backoff on _consecutiveResyncs: if corrections keep re-diverging immediately,
  // back off to avoid a snap every second. Resets to 400ms baseline on sync OK.
  // Schedule: 400ms → 400ms → 800ms → 1600ms → 3200ms → 6400ms → 8000ms (cap).
  // At cap, persistent non-determinism produces ~1 snap/9s — tolerable vs ~1 snap/s at 400ms flat.
  const _resyncCooldownMs = () => {
    if (!_hasKnSync) return 10000;
    return Math.min(8000, 400 * Math.pow(2, Math.max(0, _consecutiveResyncs - 1)));
  };

  // -- Sync log ring buffer (downloadable from toolbar) ----------------------
  const SYNC_LOG_MAX = 10000;
  const _syncLogRing = KNShared.createSyncLogRing(SYNC_LOG_MAX);
  let _startTime = 0;

  const _syncLog = (msg) => {
    _syncLogRing.push({ t: performance.now(), f: _frameNum, msg });
    console.log(`[lockstep] ${msg}`);
  };

  const exportSyncLog = () => _syncLogRing.export();

  const _getStructuredEntries = () => _syncLogRing.getStructuredEntries();

  let _flushInterval = null;
  let _cachedMatchId = null;
  let _cachedRoom = null;
  let _cachedUploadToken = null;
  let _socketFlushFails = 0;

  const _buildFlushPayload = () => ({
    matchId: _cachedMatchId || KNState.matchId,
    slot: window._playerSlot,
    playerName: (() => {
      try {
        return localStorage.getItem('kaillera-name') || 'Player';
      } catch (_) {
        return 'Player';
      }
    })(),
    mode: 'lockstep',
    entries: _getStructuredEntries(),
    summary: {
      desyncs: KNState.sessionStats?.desyncs ?? 0,
      stalls: KNState.sessionStats?.stalls ?? 0,
      reconnects: KNState.sessionStats?.reconnects ?? 0,
      frames: _frameNum,
      duration_sec: Math.round((performance.now() - _startTime) / 1000),
      peers: Object.keys(KNState.peers || {}).length,
    },
    context: {
      ua: navigator.userAgent,
      mobile: /Mobi|Android/i.test(navigator.userAgent),
      forkedCore: !!window.Module?._kn_set_deterministic,
    },
  });

  const _flushViaHttp = (payload) => {
    const token = _cachedUploadToken || KNState.uploadToken;
    const room = _cachedRoom || KNState.room || '';
    if (!token || !room) return;
    try {
      fetch(`/api/session-log?token=${encodeURIComponent(token)}&room=${encodeURIComponent(room)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    } catch (_) {}
  };

  const _flushSyncLog = () => {
    const matchId = _cachedMatchId || KNState.matchId;
    if (!matchId) return;
    try {
      const payload = _buildFlushPayload();
      if (socket?.connected) {
        let acked = false;
        socket.emit('session-log', payload, () => {
          acked = true;
          _socketFlushFails = 0;
        });
        // If no ack within 5s, count as failure and try HTTP next time
        setTimeout(() => {
          if (!acked) {
            _socketFlushFails++;
            if (_socketFlushFails >= 2) _flushViaHttp(payload);
          }
        }, 5000);
      } else {
        _flushViaHttp(payload);
      }
    } catch (_) {
      // Payload construction failed — try HTTP with minimal payload
      try {
        _flushViaHttp({
          matchId,
          slot: window._playerSlot,
          playerName: 'Player',
          mode: 'lockstep',
          entries: [],
          summary: {
            desyncs: 0,
            stalls: 0,
            reconnects: 0,
            frames: _frameNum,
            duration_sec: Math.round((performance.now() - _startTime) / 1000),
            peers: 0,
          },
          context: { ua: navigator.userAgent, mobile: /Mobi|Android/i.test(navigator.userAgent), forkedCore: false },
        });
      } catch (_2) {}
    }
  };

  // -- Canvas pixel hash + live RDRAM block hash helpers ---------------------

  // Capture the emulator canvas at 64×48 and return a FNV-1a hash of RGB pixels.
  // Returns 0 on any error (no canvas, CORS taint, WebGL buffer cleared, etc.).
  // Reuses a persistent offscreen canvas to avoid GC pressure every sync check.
  // Visual desync detection: hash the full-resolution rendered canvas.
  // Reads every pixel the player sees — zero false positives.
  // Uses WebGL readPixels for direct GPU framebuffer access, falls back
  // to 2D canvas drawImage if WebGL context isn't available.
  // Cost: ~2-5ms per call (GPU→CPU sync). Runs every 10 frames (~167ms).
  let _glCtxCache = null;
  let _glPixelBuf = null;
  const _captureCanvasHash = () => {
    const canvas = document.querySelector('#game canvas');
    if (!canvas || !canvas.width || !canvas.height) return 0;
    try {
      // Try WebGL direct readback (no intermediate canvas copy)
      if (!_glCtxCache || _glCtxCache.canvas !== canvas) {
        _glCtxCache =
          canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ||
          canvas.getContext('webgl', { preserveDrawingBuffer: true });
      }
      const gl = _glCtxCache;
      if (gl) {
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const totalBytes = w * h * 4;
        if (!_glPixelBuf || _glPixelBuf.length !== totalBytes) {
          _glPixelBuf = new Uint8Array(totalBytes);
        }
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, _glPixelBuf);
        // FNV-1a hash — stride every 16 pixels, quantize to top 4 bits.
        // Quantization ignores minor GPU rendering differences (anti-aliasing,
        // shader float precision) while catching game-state differences.
        let hash = 2166136261;
        const stride = 16 * 4;
        for (let i = 0; i < totalBytes; i += stride) {
          hash = Math.imul(hash ^ (_glPixelBuf[i] >> 4), 16777619) >>> 0;
          hash = Math.imul(hash ^ (_glPixelBuf[i + 1] >> 4), 16777619) >>> 0;
          hash = Math.imul(hash ^ (_glPixelBuf[i + 2] >> 4), 16777619) >>> 0;
        }
        return hash;
      }
      // Fallback: 2D canvas full resolution
      if (!_offscreenCanvas || _offscreenCanvas.width !== canvas.width || _offscreenCanvas.height !== canvas.height) {
        _offscreenCanvas = document.createElement('canvas');
        _offscreenCanvas.width = canvas.width;
        _offscreenCanvas.height = canvas.height;
        _offscreenCtx = _offscreenCanvas.getContext('2d', { willReadFrequently: true });
      }
      _offscreenCtx.drawImage(canvas, 0, 0);
      const data = _offscreenCtx.getImageData(0, 0, canvas.width, canvas.height).data;
      let h2 = 2166136261;
      const stride2 = 16 * 4;
      for (let i = 0; i < data.length; i += stride2) {
        h2 = Math.imul(h2 ^ (data[i] >> 4), 16777619) >>> 0;
        h2 = Math.imul(h2 ^ (data[i + 1] >> 4), 16777619) >>> 0;
        h2 = Math.imul(h2 ^ (data[i + 2] >> 4), 16777619) >>> 0;
      }
      return h2;
    } catch (_) {
      return 0;
    }
  };

  // -- Gameplay screenshot capture (for desync debugging) --------------------
  // Periodically capture the WebGL canvas via readPixels → scale → JPEG →
  // send to server. Cost: ~3-5ms GPU sync every SCREENSHOT_INTERVAL frames.
  const SCREENSHOT_INTERVAL = 300; // ~5 seconds at 60fps
  const SCREENSHOT_WIDTH = 160;
  const SCREENSHOT_HEIGHT = 120;
  let _screenshotCanvas = null;
  let _screenshotCtx = null;
  let _screenshotSrcCanvas = null;
  let _screenshotSrcCtx = null;

  const _captureAndSendScreenshot = () => {
    const canvas = document.querySelector('#game canvas');
    if (!canvas || !canvas.width || !canvas.height) return;
    const gl =
      canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ||
      canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return;

    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;

    // Read pixels from GPU
    if (!_glPixelBuf || _glPixelBuf.length !== w * h * 4) {
      _glPixelBuf = new Uint8Array(w * h * 4);
    }
    // Unbind PIXEL_PACK buffer (Emscripten WebGL2 binds one)
    const pbo = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    if (pbo) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, _glPixelBuf);
    if (pbo) gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);

    // Copy to full-size source canvas (flipped vertically)
    if (!_screenshotSrcCanvas || _screenshotSrcCanvas.width !== w || _screenshotSrcCanvas.height !== h) {
      _screenshotSrcCanvas = document.createElement('canvas');
      _screenshotSrcCanvas.width = w;
      _screenshotSrcCanvas.height = h;
      _screenshotSrcCtx = _screenshotSrcCanvas.getContext('2d', { willReadFrequently: true });
    }
    const imgData = _screenshotSrcCtx.createImageData(w, h);
    for (let row = 0; row < h; row++) {
      const srcOff = (h - 1 - row) * w * 4;
      const dstOff = row * w * 4;
      imgData.data.set(_glPixelBuf.subarray(srcOff, srcOff + w * 4), dstOff);
    }
    _screenshotSrcCtx.putImageData(imgData, 0, 0);

    // Center-crop to 4:3 (N64 native) then scale to thumbnail
    if (!_screenshotCanvas) {
      _screenshotCanvas = document.createElement('canvas');
      _screenshotCanvas.width = SCREENSHOT_WIDTH;
      _screenshotCanvas.height = SCREENSHOT_HEIGHT;
      _screenshotCtx = _screenshotCanvas.getContext('2d');
    }
    const targetRatio = 4 / 3;
    const srcRatio = w / h;
    let sx = 0,
      sy = 0,
      sw = w,
      sh = h;
    if (srcRatio > targetRatio) {
      // Source is wider than 4:3 — crop sides
      sw = Math.round(h * targetRatio);
      sx = Math.round((w - sw) / 2);
    } else if (srcRatio < targetRatio) {
      // Source is taller than 4:3 — crop top/bottom
      sh = Math.round(w / targetRatio);
      sy = Math.round((h - sh) / 2);
    }
    _screenshotCtx.drawImage(_screenshotSrcCanvas, sx, sy, sw, sh, 0, 0, SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT);

    // Encode as JPEG and send
    _screenshotCanvas.toBlob(
      (blob) => {
        if (!blob) return;
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64 = reader.result.split(',')[1]; // strip data:image/jpeg;base64,
          if (socket?.connected) {
            socket.emit('game-screenshot', {
              matchId: _cachedMatchId || KNState.matchId,
              slot: _playerSlot,
              frame: _frameNum,
              data: base64,
            });
          }
        };
        reader.readAsDataURL(blob);
      },
      'image/jpeg',
      0.6,
    );
  };

  // Read block 25 (0x190000) hash from kn_rdram_block_hashes.
  // -- Diagnostic logger functions -------------------------------------------

  const _diagShouldLog = (frameNum, interval) => frameNum < DIAG_EARLY_FRAMES || frameNum % interval === 0;

  // DIAG-INPUT: read back per-player inputs from WASM memory using discovered addresses
  const _diagInput = (frameNum, applyFrame, force = false) => {
    if (!force && !_diagShouldLog(frameNum, DIAG_INPUT_INTERVAL)) return;
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

  // Install async event hooks (called once at lockstep start)
  const _diagInstallHooks = () => {
    if (_diagHookInstalled) return;
    _diagHookInstalled = true;

    // Visibility change (tab hidden/shown)
    _diagVisHandler = () => {
      _diagEventLog.push({
        t: performance.now(),
        type: 'visibility',
        detail: document.visibilityState,
      });
    };
    document.addEventListener('visibilitychange', _diagVisHandler);

    // Window focus/blur
    _diagFocusHandler = () => {
      _diagEventLog.push({ t: performance.now(), type: 'focus', detail: 'gained' });
    };
    _diagBlurHandler = () => {
      _diagEventLog.push({ t: performance.now(), type: 'focus', detail: 'lost' });
    };
    window.addEventListener('focus', _diagFocusHandler);
    window.addEventListener('blur', _diagBlurHandler);

    // Touch events on emulator canvas
    const canvas = document.querySelector('#game canvas, canvas');
    if (canvas) {
      for (const evName of ['touchstart', 'touchend', 'touchmove']) {
        const handler = (e) => {
          _diagEventLog.push({
            t: performance.now(),
            type: 'touch',
            detail: `${evName}:${e.touches.length}`,
          });
        };
        canvas.addEventListener(evName, handler, { passive: true });
        _diagTouchHandlers.push({ el: canvas, evName, handler });
      }
    }

    // EJS settings menu open/close (MutationObserver on body for settings panel)
    _diagObserver = new MutationObserver((mutations) => {
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
    _diagObserver.observe(document.body, { childList: true, subtree: true });

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
  let _resyncRequestInFlight = false; // true while an explicit sync-request is in transit — prevents stacking
  let _lastAppliedSyncHostFrame = -1; // host frame of the most recently applied sync state (discard stale explicit)
  let _pendingSyncCheck = null; // deferred sync check {frame, hash, peerSid}
  let _pendingResyncState = null; // {bytes, frame} buffered for async apply at frame boundary
  // C-level sync: kn_sync_hash/read/write bypass retro_serialize for seamless resync
  let _hasKnSync = false;
  let _syncBufPtr = 0;
  let _syncBufSize = 0;
  // C-level regions sync: kn_sync_read_regions/kn_sync_write_regions
  // Patches only the 4 diverged 64KB RDRAM blocks (~256KB) instead of full 8MB.
  // Produces ~1-2 frame correction snap vs ~30 frames for full state write.
  let _hasKnSyncRegions = false;
  let _regionsBufPtr = 0; // WASM buffer for region data (4 × 64KB)
  let _regionsOffsetPtr = 0; // WASM buffer for the offset array (4 × uint32)
  // Fixed block offsets: ps0*/ps1* → 0xB0000, ps2* → 0xC0000, ph1b* → 0x260000, ph3c → 0x330000
  const _SYNC_REGION_OFFSETS = [0xb0000, 0xc0000, 0x260000, 0x330000];
  const _SYNC_REGIONS_TOTAL = _SYNC_REGION_OFFSETS.length * 0x10000; // 4 × 64KB = 262144

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

  const ensureRegionsBuffer = () => {
    if (_regionsBufPtr) return;
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._malloc) return;
    _regionsBufPtr = mod._malloc(_SYNC_REGIONS_TOTAL);
    _regionsOffsetPtr = mod._malloc(_SYNC_REGION_OFFSETS.length * 4);
    for (let i = 0; i < _SYNC_REGION_OFFSETS.length; i++) {
      mod.HEAPU32[(_regionsOffsetPtr >> 2) + i] = _SYNC_REGION_OFFSETS[i];
    }
    _syncLog(`regions buffer allocated: data=${_regionsBufPtr} offsets=${_regionsOffsetPtr}`);
  };
  let _awaitingResync = false; // guest: pause emulator while waiting for resync data
  let _awaitingResyncAt = 0; // timestamp when pause started (safety timeout)
  let _syncTargetFrame = -1; // guest: hold incoming state until this frame, then apply (or stall)
  let _scheduledSyncRequests = []; // host: [{targetFrame, targetSid, forceFull}] pending coord captures

  // Proactive state push: host sends delta state every N frames so guests have a
  // fresh snapshot ready for instant resyncs — no request-response RTT needed.
  const _PROACTIVE_SYNC_INTERVAL = 300; // frames (~5s at 60fps). Reduced from 30f to avoid FPS drops — each push reads 8MB + compresses + sends 2.5MB
  // (proactive flood caused input FRAME-CAPs). Now that sync uses a separate low-priority DC,
  // 30f is safe. Faster interval = fresher buffered state = smaller correction snap (~30f snap vs ~60f).
  let _preloadedResyncState = null; // {bytes, frame, receivedFrame} — most recent proactive push
  let _syncIsProactive = false; // true when current incoming sync-start is a proactive push
  let _syncIsRegions = false; // true when current incoming sync-regions-start is a regions patch

  // Apply buffered proactive state immediately on desync, skipping the round-trip.
  // Returns true if a preloaded state was promoted (caller should NOT send sync-request).
  const _tryApplyPreloaded = () => {
    if (!_preloadedResyncState) return false;
    // Note: _consecutiveResyncs check removed. The fast-path can't loop because it
    // consumes _preloadedResyncState, which isn't refilled until the next proactive
    // push (~30 frames later). After the fast-path fires once, subsequent desync
    // checks find _preloadedResyncState=null and fall through to the explicit path.
    const age = _frameNum - _preloadedResyncState.receivedFrame;
    if (age >= 120) {
      _preloadedResyncState = null;
      return false;
    }
    // Don't apply proactive state older than the most recently applied coord state —
    // that would move the emulator backwards in time and cause immediate re-divergence.
    if (_preloadedResyncState.frame <= _lastAppliedSyncHostFrame) {
      _syncLog(
        `proactive discarded: stale frame=${_preloadedResyncState.frame} <= lastApplied=${_lastAppliedSyncHostFrame}`,
      );
      _preloadedResyncState = null;
      return false;
    }
    _pendingResyncState = { ..._preloadedResyncState, fromProactive: true };
    _preloadedResyncState = null;
    _lastResyncTime = performance.now();
    _syncLog(`instant resync from preloaded state (age=${age}f frame=${_pendingResyncState.frame})`);
    return true;
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
  // Proportional skip table: indexed by excess (frameAdvRaw - DELAY_FRAMES).
  // Each entry is [divisor, skipCount] for modulo pattern, or null (no skip).
  // excess=1 → skip 1 of 4 (25%), excess=2 → 1 of 2 (50%), excess=3 → 3 of 4 (75%).
  const SKIP_TABLE = [null, [4, 1], [2, 1], [4, 3]];
  let _pacingSkipCounter = 0;

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
    const initSamples = mod._kn_get_audio_samples();
    const alCtxCount = mod.AL?.contexts ? Object.keys(mod.AL.contexts).length : 0;
    _syncLog(
      `audio init: ptr=${_audioPtr} rate=${_audioRate} initSamples=${initSamples} alCtx=${alCtxCount} f=${_frameNum}`,
    );
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
      // Log first 30 empty frames for diagnostics on fresh boot
      if (_audioEmptyCount <= 30) {
        const alCtxCount = mod.AL?.contexts ? Object.keys(mod.AL.contexts).length : 0;
        const sdlAudioState = mod.SDL2?.audioContext?.state ?? 'none';
        _syncLog(
          `audio-empty f=${_frameNum} #${_audioEmptyCount} ptr=${_audioPtr} alCtx=${alCtxCount} sdlAudio=${sdlAudioState}`,
        );
      }
      // Log once after 300 consecutive empty frames (~5s) to detect silent audio
      if (_audioEmptyCount === 300) {
        const alCtxCount = mod.AL?.contexts ? Object.keys(mod.AL.contexts).length : 0;
        const sdlState = mod.SDL2?.audioContext?.state ?? 'none';
        _syncLog(
          `audio-silent: ${_audioEmptyCount} consecutive frames with 0 samples (ptr=${_audioPtr} ctx=${_audioCtx.state} alCtx=${alCtxCount} sdlAudio=${sdlState})`,
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

  // -- Resync audio fade helpers --
  const FADE_OUT_MS = 30;
  const FADE_IN_MS = 50;

  const _audioFadeOut = () => {
    if (!_resyncGainNode || !_audioCtx || _audioCtx.state !== 'running') return;
    const now = _audioCtx.currentTime;
    _resyncGainNode.gain.cancelScheduledValues(now);
    _resyncGainNode.gain.setValueAtTime(_resyncGainNode.gain.value, now);
    _resyncGainNode.gain.linearRampToValueAtTime(0, now + FADE_OUT_MS / 1000);
  };

  const _audioFadeIn = () => {
    if (!_resyncGainNode || !_audioCtx || _audioCtx.state !== 'running') return;
    const now = _audioCtx.currentTime;
    _resyncGainNode.gain.cancelScheduledValues(now);
    _resyncGainNode.gain.setValueAtTime(0, now + FADE_OUT_MS / 1000);
    _resyncGainNode.gain.linearRampToValueAtTime(1, now + (FADE_OUT_MS + FADE_IN_MS) / 1000);
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
    if (msg.type === 'late-join-ready') {
      if (_lateJoinPaused) {
        _lateJoinPaused = false;
        _broadcastRoster();
        _syncLog('late-join resume: joiner ready (via Socket.IO)');
        for (const p of Object.values(_peers)) {
          if (p.dc?.readyState === 'open') {
            try {
              p.dc.send('late-join-resume');
            } catch (_) {}
          }
        }
      } else {
        _syncLog('late-join-ready received but not paused (already resumed or timed out)');
      }
    }
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
    const existingPeerSids = Object.keys(_peers);
    _syncLog(
      `onUsersUpdated: ${Object.keys(players).length} players, ${otherPlayers.length} others, ` +
        `mySlot=${_playerSlot}, lateJoin=${_lateJoin}, running=${_running}, spectator=${_isSpectator}, ` +
        `existingPeers=[${existingPeerSids.join(',')}]`,
    );

    // Establish mesh connections to other players
    // Normal: lower slot initiates (creates data channel + sends offer)
    // Late-join: joiner always initiates (host's offer would arrive before listener is ready)
    // Running host: DON'T initiate to new players — let them initiate after their init()
    for (const p of otherPlayers) {
      if (_peers[p.socketId]) {
        _syncLog(`onUsersUpdated: peer ${p.socketId} (slot ${p.slot}) already exists, skipping`);
        _peers[p.socketId].slot = p.slot;
        continue;
      }

      // Evict zombie peers: if another SID already holds this slot, the old
      // connection is stale (player reconnected with a new Socket.IO ID).
      // Clean up the old entry so _peers never has duplicate slots.
      if (p.slot !== null && p.slot !== undefined) {
        for (const [oldSid, oldPeer] of Object.entries(_peers)) {
          if (oldSid !== p.socketId && oldPeer.slot === p.slot) {
            _syncLog(`onUsersUpdated: evicting zombie peer ${oldSid} (slot ${p.slot}) — replaced by ${p.socketId}`);
            try {
              oldPeer.pc?.close();
            } catch (_) {}
            if (oldPeer._reconnectTimeout) clearTimeout(oldPeer._reconnectTimeout);
            if (oldPeer._disconnectTimer) clearTimeout(oldPeer._disconnectTimer);
            delete _peers[oldSid];
            delete _lockstepReadyPeers[oldSid];
          }
        }
      }

      let shouldInitiate;
      let reason;
      if (_lateJoin && !_isSpectator) {
        shouldInitiate = true;
        reason = 'late-joiner always initiates';
      } else if (_running) {
        shouldInitiate = false;
        reason = 'running — wait for late-joiner offer';
      } else if (_isSpectator) {
        shouldInitiate = false;
        reason = 'spectator never initiates';
      } else {
        shouldInitiate = _playerSlot < p.slot;
        reason = `slot comparison: ${_playerSlot} < ${p.slot} = ${shouldInitiate}`;
      }
      _syncLog(`onUsersUpdated: new peer ${p.socketId} slot=${p.slot}, initiate=${shouldInitiate} (${reason})`);

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
    const peer = KNShared.createBasePeer(_getIceServers(), remoteSid, socket, peerGuard);
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
          _startTime = performance.now();
          // Reset sync backoff so next desync check happens within ~1s
          // (connection hiccup likely caused a desync — don't wait 30s)
          _consecutiveResyncs = 0;
          _syncCheckInterval = _syncBaseInterval;
          // Discard any proactive state buffered before the reconnect — it was
          // captured on the old network path and may be inconsistent post-ICE-restart.
          _preloadedResyncState = null;
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
        // handlePeerDisconnect will attempt reconnect if game is running
        handlePeerDisconnect(remoteSid);
      }
      if (s === 'disconnected') {
        // Disconnected is recoverable — give ICE time to reconnect (mobile-friendly)
        if (_peers[remoteSid] !== peer) return;
        if (!peer._disconnectTimer) {
          setStatus('Connection unstable — standing by...');
          peer._disconnectTimer = setTimeout(() => {
            peer._disconnectTimer = null;
            // Still disconnected or failed after grace period — give up
            const currentState = peer.pc.connectionState;
            if (currentState === 'disconnected' || currentState === 'failed') {
              _syncLog(`peer ${remoteSid} disconnect grace expired (was ${currentState})`);
              if (_peers[remoteSid] !== peer) return;
              // Don't show "lost" — handlePeerDisconnect will attempt reconnect
              // and show the appropriate "reconnecting..." status
              handlePeerDisconnect(remoteSid);
            }
          }, 1500); // 1.5s grace — fast reconnect on mobile network switch
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
      peer.dc = peer.pc.createDataChannel('lockstep', { ordered: true });
      setupDataChannel(remoteSid, peer.dc);
      peer.syncDc = peer.pc.createDataChannel('sync-state', { ordered: true, priority: 'very-low' });
      setupSyncDataChannel(remoteSid, peer.syncDc);
      // Delegate non-lockstep channels created by remote
      peer.pc.ondatachannel = (e) => {
        if (e.channel.label === 'lockstep') {
          peer.dc = e.channel;
          setupDataChannel(remoteSid, peer.dc);
        } else if (e.channel.label === 'sync-state') {
          peer.syncDc = e.channel;
          setupSyncDataChannel(remoteSid, peer.syncDc);
        } else if (_onExtraDataChannel) {
          _onExtraDataChannel(remoteSid, e.channel);
        }
      };
    } else {
      peer.pc.ondatachannel = (e) => {
        if (e.channel.label === 'lockstep') {
          peer.dc = e.channel;
          setupDataChannel(remoteSid, peer.dc);
        } else if (e.channel.label === 'sync-state') {
          peer.syncDc = e.channel;
          setupSyncDataChannel(remoteSid, peer.syncDc);
        } else if (_onExtraDataChannel) {
          _onExtraDataChannel(remoteSid, e.channel);
        }
      };
    }
    return peer;
  };

  async function sendOffer(remoteSid, { reconnect = false } = {}) {
    const peer = _peers[remoteSid];
    if (!peer) {
      _syncLog(`sendOffer: no peer for ${remoteSid}, skipping`);
      return;
    }
    _syncLog(`sendOffer: sending to ${remoteSid} (slot ${peer.slot})${reconnect ? ' [reconnect]' : ''}`);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { target: remoteSid, offer, reconnect });
  }

  async function onWebRTCSignal(data) {
    if (!data) return;
    const senderSid = data.sender;
    if (!senderSid) return;
    const sigType = data.offer ? 'offer' : data.answer ? 'answer' : data.candidate ? 'candidate' : 'other';
    _syncLog(
      `onWebRTCSignal: ${sigType} from ${senderSid}, hasPeer=${!!_peers[senderSid]}, knownPlayer=${!!_knownPlayers[senderSid]}`,
    );

    // Create peer on demand if offer arrives before users-updated
    if (data.offer && !_peers[senderSid]) {
      const known = _knownPlayers[senderSid];
      _syncLog(`onWebRTCSignal: on-demand createPeer for ${senderSid}, slot=${known?.slot ?? 'null'}`);
      createPeer(senderSid, known ? known.slot : null, false);
    }

    let peer = _peers[senderSid];
    if (!peer) {
      _syncLog(`onWebRTCSignal: no peer for ${senderSid}, dropping ${sigType}`);
      return;
    }

    try {
      if (data.offer) {
        // Reconnect: if peer exists and reconnect flag set, replace old PC
        if (data.reconnect && _peers[senderSid]) {
          const existingPeer = _peers[senderSid];
          _syncLog(`received reconnect offer from ${senderSid}`);

          const peerGuard = (p) => _peers[senderSid] === p;
          KNShared.resetPeerConnection(existingPeer, _getIceServers(), senderSid, socket, peerGuard);
          existingPeer.ready = false;

          // Timeout: if reconnect doesn't reach 'connected' within 10s, close and retry
          let _reconnectTimer = setTimeout(() => {
            const state = existingPeer.pc.connectionState;
            if (state !== 'connected') {
              _syncLog(`reconnect timeout (state=${state}) — closing stale PC for ${senderSid}`);
              try {
                existingPeer.pc.close();
              } catch (_) {}
            }
          }, 10000);
          existingPeer.pc.onconnectionstatechange = () => {
            const s = existingPeer.pc.connectionState;
            _syncLog(`reconnect peer ${senderSid} connection-state: ${s}`);
            if (s === 'connected' || s === 'failed' || s === 'closed') {
              clearTimeout(_reconnectTimer);
            }
          };
          existingPeer.pc.ondatachannel = (e) => {
            if (e.channel.label === 'lockstep') {
              existingPeer.dc = e.channel;
              setupDataChannel(senderSid, existingPeer.dc);
            } else if (e.channel.label === 'sync-state') {
              existingPeer.syncDc = e.channel;
              setupSyncDataChannel(senderSid, existingPeer.syncDc);
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
        setStatus(`${rName} reconnected — resyncing...`);
        _config?.onToast?.(`${rName} reconnected`);
        _config?.onReconnecting?.(remoteSid, false);
        _config?.onPeerReconnected?.(remoteSid);
        // Force resync — after disconnect the guest was fabricating inputs,
        // so states are guaranteed to have diverged. Send on the sync-state DC
        // if available (avoids the _syncExpected=0 race on the new DC), fall back
        // to the lockstep DC. Reset resync tracking so cooldowns don't block it.
        if (_playerSlot !== 0) {
          _lastResyncTime = 0;
          _consecutiveResyncs = 0;
          _resyncRequestInFlight = false;
          _syncMismatchStreak = 0;
          // Send sync-request-full to the HOST's lockstep DC (only host handles
          // sync requests). `ch` is the DC to the reconnected peer — which may
          // not be the host (e.g. P1 reconnecting to P2).
          const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
          const hostDc = hostPeer?.dc;
          if (hostDc?.readyState === 'open') {
            const _reconnectTarget = _frameNum + SYNC_COORD_DELTA;
            _syncTargetFrame = _reconnectTarget;
            _resyncRequestInFlight = true;
            try {
              hostDc.send(`sync-request-full-at:${_reconnectTarget}`);
              _syncLog(`reconnect resync: sent sync-request-full-at:${_reconnectTarget} to host DC`);
            } catch (e) {
              _syncLog(`reconnect resync send failed: ${e}`);
              _resyncRequestInFlight = false;
              _syncTargetFrame = -1;
            }
          } else {
            _syncLog(`reconnect resync: host DC not open, skipping resync request`);
          }
          // Sync-state DC onopen handler preserved for future use
          const syncDc = peer.syncDc;
          if (syncDc) {
            const origOnOpen = syncDc.onopen;
            syncDc.onopen = (ev) => {
              origOnOpen?.call(syncDc, ev);
            };
          }
        } else {
          _consecutiveResyncs = 0;
          _syncCheckInterval = _syncBaseInterval;
        }
      }

      // Host: send current roster to newly connected/reconnected peer
      if (_playerSlot === 0 && _activeRoster) {
        const slots = [..._activeRoster].sort((a, b) => a - b);
        try {
          ch.send(`roster:${_frameNum}:${slots.join(',')}`);
        } catch (_) {}
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
        if (e.data === 'late-join-pause') {
          _lateJoinPaused = true;
          _syncLog(`paused by host for late-join sync at frame ${_frameNum}`);
        }
        if (e.data === 'late-join-resume') {
          _lateJoinPaused = false;
          _syncLog(`resumed by host after late-join sync at frame ${_frameNum}`);
        }
        if (e.data === 'late-join-ready' && _lateJoinPaused) {
          _lateJoinPaused = false;
          // Broadcast roster NOW — the joiner is ready to send input.
          // Broadcasting earlier causes 5s stalls per frame while the
          // joiner boots/loads state.
          _broadcastRoster();
          _syncLog('late-join resume: joiner ready (via DC)');
          for (const p of Object.values(_peers)) {
            if (p.dc?.readyState === 'open') {
              try {
                p.dc.send('late-join-resume');
              } catch (_) {}
            }
          }
        }
        if (e.data.startsWith('roster:')) {
          const parts = e.data.split(':');
          const rosterFrame = parseInt(parts[1], 10);
          const slots = parts[2] ? parts[2].split(',').map(Number) : [];
          _activeRoster = new Set(slots);
          _rosterChangeFrame = _frameNum;
          _syncLog(`ROSTER received: frame=${rosterFrame} slots=[${slots.join(',')}]`);
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
        // FPU trace: cross-platform determinism verification from host
        if (e.data.startsWith('fpu-trace:')) {
          if (!_fpuTraceEnabled) return;
          const parts = e.data.split(':');
          const hostFrame = parseInt(parts[1], 10);
          const hostHash = parseInt(parts[2], 10);
          const hostCount = parseInt(parts[3], 10);
          const local = _fpuTraceHash();
          if (!local) return;
          if (local.hash === hostHash) {
            if (!_fpuTraceVerified) {
              _syncLog(`FPU trace MATCH: ${local.count} ops verified (frame ${hostFrame})`);
              _fpuTraceVerified = true;
            }
          } else {
            _syncLog(
              `FPU trace MISMATCH at frame ${hostFrame}! host_hash=${hostHash} local_hash=${local.hash} host_count=${hostCount} local_count=${local.count}`,
            );
            const entries = _fpuTraceExtract(Math.max(0, hostFrame - 300), hostFrame);
            _syncLog(`FPU trace dump (last ${entries.length} entries):`);
            for (const ent of entries.slice(0, 20)) {
              _syncLog(
                `  frame=${ent.frame} op=${_FPU_OP_NAMES[ent.op] ?? ent.op} in1=0x${ent.in1} in2=0x${ent.in2} out=0x${ent.out}`,
              );
            }
            if (socket) {
              socket.emit('debug-sync', {
                type: 'fpu-trace-mismatch',
                frame: hostFrame,
                hostHash,
                localHash: local.hash,
                hostCount,
                localCount: local.count,
                entries: entries.slice(0, 100),
              });
            }
          }
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
          // Parse RDRAM hash from host
          const hostHash = parseInt(parts[2], 10);
          if (!hostHash) return;

          // ── RDRAM anchor hash comparison ──────────────────────────────
          // Reliable with AI DMA determinism fix. The float that caused
          // false positives is now integer-only arithmetic.
          const gMod = window.EJS_emulator?.gameManager?.Module;
          if (!_hasKnSync && gMod?._kn_sync_hash && gMod?._kn_sync_read && gMod?._kn_sync_write) {
            _hasKnSync = true;
            _syncLog('C-level sync available [lazy-guest]');
          }
          if (!_hasKnSync || !gMod?._kn_sync_hash) return;

          const guestHash = gMod._kn_sync_hash();
          if (guestHash === hostHash) {
            _consecutiveResyncs = 0;
            _syncMismatchStreak = 0;
            if (_frameNum % (_syncCheckInterval * 10) === 0) {
              _syncLog(`sync OK frame=${syncFrame} hash=${hostHash}`);
            }
            return;
          }
          // RDRAM mismatch — log per-region hashes to identify which anchors diverge
          const names = ['cfg', 'ps0*', 'ps1*', 'ps2*', 'ph1a', 'ph1b*', 'ph1c', 'misc', 'ph2', 'ph3a', 'ph3b', 'ph3c'];
          let regionLog = '';
          if (gMod._kn_sync_hash_regions) {
            const hb = gMod._malloc(48);
            const rc = gMod._kn_sync_hash_regions(hb, 12);
            const localRegions = [];
            for (let ri = 0; ri < rc; ri++) localRegions.push(gMod.HEAPU32[(hb >> 2) + ri] >>> 0);
            gMod._free(hb);
            // Parse host regions from message (after parts[2])
            const hostRegions =
              parts.length > 3
                ? parts
                    .slice(3)
                    .filter((p) => !p.includes('='))
                    .map((v) => parseInt(v, 10) >>> 0)
                : null;
            if (hostRegions && hostRegions.length >= 12) {
              const diffs = names.filter((_, i) => localRegions[i] !== hostRegions[i]);
              regionLog = ` DIFF=[${diffs.join(',')}]`;
              _syncLog(`REGION-HASH local ${localRegions.map((h, i) => `${names[i]}=${h}`).join(' ')}`);
              _syncLog(`REGION-HASH host  ${hostRegions.map((h, i) => `${names[i]}=${h}`).join(' ')}`);
            } else {
              regionLog = ` local-regions=[${localRegions.map((h, i) => `${names[i]}=${h}`).join(' ')}]`;
            }
          }
          _syncLog(
            `RDRAM-DESYNC frame=${syncFrame} local=${guestHash} host=${hostHash} myFrame=${_frameNum}${regionLog}`,
          );
          KNState.sessionStats.desyncs++;
          _syncMismatchStreak++;
          const now2 = performance.now();
          const cooldownElapsed = now2 - _lastResyncTime;
          if (!_resyncRequestInFlight && cooldownElapsed > _resyncCooldownMs()) {
            _lastResyncTime = now2;
            _resyncRequestInFlight = true;
            const _coordTarget = _frameNum + SYNC_COORD_DELTA;
            _syncTargetFrame = _coordTarget;
            _syncLog(
              `sending sync-request-full-at:${_coordTarget} (RDRAM desync, cooldown=${Math.round(cooldownElapsed)}ms)`,
            );
            try {
              peer.dc.send(`sync-request-full-at:${_coordTarget}`);
            } catch (e2) {
              _syncLog(`sync-request send failed: ${e2}`);
              _resyncRequestInFlight = false;
              _syncTargetFrame = -1;
            }
          } else {
            _syncLog(
              `RDRAM-DESYNC but blocked: inFlight=${_resyncRequestInFlight} cooldown=${Math.round(cooldownElapsed)}ms/${_resyncCooldownMs()}ms`,
            );
          }
        }
        // State sync: host received request from guest (sent on lockstep DC)
        if (
          _playerSlot === 0 &&
          (e.data === 'sync-request' ||
            e.data === 'sync-request-full' ||
            e.data === 'sync-request-regions' ||
            e.data.startsWith('sync-request-at:') ||
            e.data.startsWith('sync-request-full-at:'))
        ) {
          const now = Date.now();
          const lastRequest = _syncRequestCooldowns.get(remoteSid) || 0;
          if (now - lastRequest < _SYNC_REQUEST_COOLDOWN_MS) {
            _syncLog(`rate-limited sync-request from ${remoteSid}`);
            return;
          }
          _syncRequestCooldowns.set(remoteSid, now);
          const isFull = e.data === 'sync-request-full' || e.data.startsWith('sync-request-full-at:');
          _syncLog(`received ${e.data} from ${remoteSid}`);
          if (isFull) _setLastSyncState(null, 'guest-requested-full');
          // Coordinated: parse target frame and schedule capture there.
          // Immediate (no -at: suffix): push now — used for reconnect/visibility/network-change.
          const colonIdx = e.data.lastIndexOf(':');
          const targetFrame =
            e.data.includes('-at:') && colonIdx >= 0 ? parseInt(e.data.substring(colonIdx + 1), 10) : NaN;
          if (!isNaN(targetFrame) && targetFrame > _frameNum) {
            // Replace any existing request from this guest so requests don't stack
            _scheduledSyncRequests = _scheduledSyncRequests.filter((r) => r.targetSid !== remoteSid);
            _scheduledSyncRequests.push({ targetFrame, targetSid: remoteSid, forceFull: isFull });
            _syncLog(`coord sync scheduled for ${remoteSid} at frame ${targetFrame}`);
          } else {
            pushSyncState(remoteSid);
          }
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
            } else if (_onUnhandledMessage) {
              _onUnhandledMessage(remoteSid, msg);
            }
          } catch (_) {}
        }
        return;
      }

      // Binary: encoded input -- 16 bytes. State chunks arrive on the sync-state DC.
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
        // Feed to C-level rollback engine for prediction correction
        if (_useCRollback) {
          const cMod = window.EJS_emulator?.gameManager?.Module;
          if (cMod?._kn_feed_input) {
            cMod._kn_feed_input(
              peer.slot,
              recvFrame,
              recvInput.buttons,
              recvInput.lx,
              recvInput.ly,
              recvInput.cx,
              recvInput.cy,
            );
          }
        }
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
            // Guest: request resync after peer recovery — we fabricated inputs
            // during the phantom period, so states have diverged.
            if (_playerSlot !== 0 && peer.slot === 0 && _syncEnabled) {
              _lastResyncTime = 0;
              _resyncRequestInFlight = false;
              _consecutiveResyncs = 0;
              const _recoveryTarget = _frameNum + SYNC_COORD_DELTA;
              _syncTargetFrame = _recoveryTarget;
              _resyncRequestInFlight = true;
              try {
                const peerDc = _peers[remoteSid]?.dc;
                if (peerDc?.readyState === 'open') {
                  peerDc.send(`sync-request-full-at:${_recoveryTarget}`);
                  _syncLog(`peer-recovery resync: sent sync-request-full-at:${_recoveryTarget}`);
                }
              } catch (e) {
                _syncLog(`peer-recovery resync send failed: ${e}`);
                _resyncRequestInFlight = false;
                _syncTargetFrame = -1;
              }
            }
          }
        }
      }
    };
  };

  // -- Sync-state data channel -----------------------------------------------
  // Separate low-priority DC for all state transfer traffic (proactive pushes
  // and explicit resync). Keeping state off the lockstep DC prevents 1MB state
  // bursts from queuing ahead of 16-byte input messages on the same SCTP stream,
  // which caused 200-450ms FRAME-CAPs every proactive push cycle.

  const setupSyncDataChannel = (_remoteSid, ch) => {
    ch.binaryType = 'arraybuffer';
    // Reset sync assembly state — after reconnect the old DC's partial
    // state must not carry over or binary chunks will be dropped as unexpected.
    _syncExpected = 0;
    _syncChunks = [];
    ch.onmessage = (e) => {
      if (typeof e.data === 'string') {
        // Guest: incoming state transfer header
        if (e.data.startsWith('sync-start:')) {
          const parts = e.data.split(':');
          _syncFrame = parseInt(parts[1], 10);
          _syncExpected = parseInt(parts[2], 10);
          _syncIsFull = parts[3] === '1';
          _syncIsProactive = parts[4] === '1';
          _syncIsRegions = false;
          _syncChunks = [];
          _syncLog(
            `sync-start received: frame=${_syncFrame} expected=${_syncExpected} full=${_syncIsFull} proactive=${_syncIsProactive}`,
          );
          return;
        }
        // Guest: incoming regions patch header — only diverged RDRAM blocks
        if (e.data.startsWith('sync-regions-start:')) {
          const parts = e.data.split(':');
          _syncFrame = parseInt(parts[1], 10);
          _syncExpected = parseInt(parts[2], 10);
          _syncIsFull = true;
          _syncIsProactive = false;
          _syncIsRegions = true;
          _syncChunks = [];
          _syncLog(`sync-regions-start received: frame=${_syncFrame} expected=${_syncExpected}`);
          return;
        }
      }
      // Binary: sync state chunks
      if (e.data instanceof ArrayBuffer) {
        if (_syncExpected > 0) {
          _syncChunks.push(new Uint8Array(e.data));
          if (_syncChunks.length >= _syncExpected) {
            _syncLog(`sync chunks complete: ${_syncChunks.length}/${_syncExpected} chunks received`);
            handleSyncChunksComplete();
          }
          return;
        }
        _syncLog(`WARN: binary data (${e.data.byteLength}B) on sync-state DC but _syncExpected=0 — dropped`);
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
      setStatus(`${name} disconnected — reconnecting & resyncing...`);
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
      // Only host modifies the input roster — non-hosts wait for
      // the host's roster broadcast to remove the slot
      if (_playerSlot === 0 || !_activeRoster) {
        delete _peerInputStarted[peer.slot];
      }
    }

    delete _peers[remoteSid];
    delete _lockstepReadyPeers[remoteSid];
    KNState.peers = _peers;
    _syncLog(`peer hard-disconnected: ${remoteSid} slot: ${peer.slot}`);
    if (_playerSlot === 0 && _running) {
      _broadcastRoster();
    }

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
    KNShared.resetPeerConnection(peer, _getIceServers(), remoteSid, socket, peerGuard);
    peer.ready = false;

    // Timeout: if reconnect doesn't reach 'connected' within 10s, hard disconnect
    let _reconnectTimer2 = setTimeout(() => {
      const state = peer.pc.connectionState;
      if (state !== 'connected') {
        _syncLog(`reconnect timeout (state=${state}) — hard disconnect ${remoteSid}`);
        hardDisconnectPeer(remoteSid);
      }
    }, 10000);
    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      _syncLog(`reconnect peer ${remoteSid} connection-state: ${s}`);
      if (s === 'connected' || s === 'closed') {
        clearTimeout(_reconnectTimer2);
      }
      if (s === 'failed') {
        clearTimeout(_reconnectTimer2);
        _syncLog(`reconnect PC failed for ${remoteSid}`);
        hardDisconnectPeer(remoteSid);
      }
    };

    peer.pc.ondatachannel = (e) => {
      if (e.channel.label === 'lockstep') {
        peer.dc = e.channel;
        setupDataChannel(remoteSid, peer.dc);
      } else if (e.channel.label === 'sync-state') {
        peer.syncDc = e.channel;
        setupSyncDataChannel(remoteSid, peer.syncDc);
      } else if (_onExtraDataChannel) {
        _onExtraDataChannel(remoteSid, e.channel);
      }
    };

    // Create new DCs and send offer with reconnect flag
    peer.dc = peer.pc.createDataChannel('lockstep', { ordered: true });
    setupDataChannel(remoteSid, peer.dc);
    peer.syncDc = peer.pc.createDataChannel('sync-state', { ordered: true, priority: 'very-low' });
    setupSyncDataChannel(remoteSid, peer.syncDc);

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
  const getInputPeers = () => {
    if (_activeRoster) {
      // Roster mode: return one peer per roster slot (excluding self).
      // Deduplicate by slot — if zombie peers survive, prefer the one with
      // an open DataChannel. Peers may have dead DCs — the stall/fabrication
      // path handles that.
      const bySlot = new Map();
      for (const p of Object.values(_peers)) {
        if (p.slot === null || p.slot === undefined) continue;
        if (!_activeRoster.has(p.slot)) continue;
        const existing = bySlot.get(p.slot);
        if (!existing || (p.dc?.readyState === 'open' && existing.dc?.readyState !== 'open')) {
          bySlot.set(p.slot, p);
        }
      }
      return [...bySlot.values()];
    }
    // Legacy mode (pre-roster): original behavior
    return getActivePeers().filter((p) => {
      if (p.reconnecting) return false;
      if (_peerInputStarted[p.slot]) return true;
      // Boot grace: include connected peers before their first input arrives
      return _frameNum < BOOT_GRACE_FRAMES;
    });
  };

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
        // VirtualGamepad.init() is called from play.js before bootEmulator() for
        // the normal ROM path — prevents canvas resize when #game shrinks after EJS
        // attaches its ResizeObserver. For the ROM-sharing path (ROM arrives after
        // game-started, so bootEmulator() is called directly from afterRomTransferComplete
        // without going through initEngine() again), init() must run here as a fallback.
        // The idempotent guard in init() makes double-calling harmless.
        VirtualGamepad.init();
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
        _awaitingLateJoinState = true;
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
    if (_awaitingLateJoinState) return; // late-join path active — don't use normal sync

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

    // If no state bytes (host fallback), host uses its own state.
    // Guests MUST have received the host's state — using their own would cause
    // RNG divergence (different boot timing → different CP0_COUNT → different random).
    if (!_guestStateBytes) {
      if (_playerSlot === 0) {
        _guestStateBytes = gm.getState();
        _syncLog('host using own state (authoritative)');
      } else {
        _syncLog('FATAL: guest has no state from host — cannot start lockstep deterministically');
        setStatus('Sync failed — no state from host');
        _config?.onToast?.('Sync failed — try restarting the game');
        return;
      }
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

    // Spectator stream starts lazily — only when a spectator actually connects.
    // Eager start wastes CPU (drawImage + video encode every frame) which causes
    // thermal throttling on mobile hosts even with zero spectators.
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

  const _broadcastRoster = () => {
    if (_playerSlot !== 0) return;
    const slotSet = new Set([_playerSlot]);
    for (const p of Object.values(_peers)) {
      if (p.slot !== null && p.slot !== undefined && !p._intentionalLeave) {
        slotSet.add(p.slot);
      }
    }
    const slots = [...slotSet].sort((a, b) => a - b);
    _activeRoster = slotSet;
    _rosterChangeFrame = _frameNum;
    const msg = `roster:${_frameNum}:${slots.join(',')}`;
    _syncLog(`ROSTER broadcast: frame=${_frameNum} slots=[${slots.join(',')}]`);
    for (const p of Object.values(_peers)) {
      if (p.dc?.readyState === 'open') {
        try {
          p.dc.send(msg);
        } catch (_) {}
      }
    }
  };

  async function sendLateJoinState(remoteSid) {
    // Look up slot from _peers first, fall back to _knownPlayers.
    // The peer's WebRTC connection may have failed/disconnected (removed
    // from _peers by handlePeerDisconnect), but the player is still in the
    // Socket.IO room and can receive the state via Socket.IO relay.
    let peerSlot = _peers[remoteSid]?.slot;
    if (peerSlot === null || peerSlot === undefined) {
      peerSlot = _knownPlayers[remoteSid]?.slot;
    }
    if (peerSlot === null || peerSlot === undefined) {
      _syncLog(
        `sendLateJoinState: no slot for ${remoteSid}, peers=[${Object.keys(_peers).join(',')}] known=[${Object.keys(_knownPlayers).join(',')}]`,
      );
      return;
    }

    const gm = window.EJS_emulator?.gameManager;
    if (!gm) {
      _syncLog(`sendLateJoinState: gameManager not ready`);
      return;
    }

    try {
      const raw = gm.getState();
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const encoded = await compressAndEncode(bytes);

      // Read game-specific RNG/settings values from RDRAM
      let rngValues = null;
      let saveData = null;
      const hMod = gm.Module;
      if (hMod?.HEAPU32 && hMod?._get_memory_data) {
        try {
          const rk = hMod.stringToNewUTF8('RETRO_MEMORY_SYSTEM_RAM');
          const rr = hMod._get_memory_data(rk);
          hMod._free(rk);
          if (rr) {
            const [rs, rp] = hMod.UTF8ToString(rr).split('|').map(Number);
            const u32 = rp >> 2;
            if (_isSmashRemix()) {
              // Smash Remix RNG addresses (from source code analysis)
              const vsBytes = Array.from(hMod.HEAPU8.slice(rp + 0x000a4d08, rp + 0x000a4d28));
              rngValues = {
                seed: hMod.HEAPU32[u32 + (0x0005b940 >> 2)] >>> 0,
                altSeed: hMod.HEAPU32[u32 + (0x000a0578 >> 2)] >>> 0,
                frameCounter: hMod.HEAPU32[u32 + (0x0003cb30 >> 2)] >>> 0,
                screenFC: hMod.HEAPU32[u32 + (0x0003b6e4 >> 2)] >>> 0,
                vsBytes,
                matchCopy: hMod.HEAPU32[u32 + (0x0013bdac >> 2)] >>> 0,
                globalGameMode: hMod.HEAPU32[u32 + (0x004f756c >> 2)] >>> 0,
              };
            }
            // SAVE_RAM (EEPROM/SRAM) — generic, works for any game
            const sk = hMod.stringToNewUTF8('RETRO_MEMORY_SAVE_RAM');
            const sr = hMod._get_memory_data(sk);
            hMod._free(sk);
            if (sr) {
              const [ss, sp] = hMod.UTF8ToString(sr).split('|').map(Number);
              if (ss > 0 && sp > 0) {
                saveData = uint8ToBase64(hMod.HEAPU8.slice(sp, sp + ss));
              }
            }
          }
        } catch (_) {}
      }

      // Pause lockstep — freeze all players at this exact frame until
      // the late-joiner confirms ready. Zero frame gap = zero RNG drift.
      // NOTE: roster broadcast moved to late-join-ready handler — adding
      // the slot before the joiner can send input causes 5s stalls per frame.
      _lateJoinPaused = true;
      _syncLog(`pausing for late-join at frame ${_frameNum}`);
      for (const p of Object.values(_peers)) {
        if (p.dc?.readyState === 'open') {
          try {
            p.dc.send('late-join-pause');
          } catch (_) {}
        }
      }
      setTimeout(() => {
        if (_lateJoinPaused) {
          _lateJoinPaused = false;
          _broadcastRoster();
          _syncLog('late-join pause timeout — resuming');
          // Send resume to peers that are still paused
          for (const p of Object.values(_peers)) {
            if (p.dc?.readyState === 'open') {
              try {
                p.dc.send('late-join-resume');
              } catch (_) {}
            }
          }
        }
      }, 5000);

      _syncLog(
        `sending late-join state to ${remoteSid} (${Math.round(encoded.rawSize / 1024)}KB raw -> ${Math.round(encoded.compressedSize / 1024)}KB gzip) frame: ${_frameNum}`,
      );

      socket.emit('data-message', {
        type: 'late-join-state',
        frame: _frameNum,
        data: encoded.data,
        effectiveDelay: DELAY_FRAMES,
        rngValues,
        saveData,
      });
    } catch (err) {
      _syncLog(`failed to send late-join state: ${err}`);
    }
  }

  const handleLateJoinState = async (msg) => {
    if (_isSpectator) return;
    if (_running) return; // already running, ignore duplicate

    _syncLog(`received late-join state for frame ${msg.frame}`);
    _awaitingLateJoinState = false;
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

      // Write SAVE_RAM before enterManualMode so boot frame reads host's EEPROM
      const mod = gm.Module;
      if (msg.saveData && mod?._get_memory_data && mod.HEAPU8) {
        try {
          const saveBytes = base64ToUint8(msg.saveData);
          const sk = mod.stringToNewUTF8('RETRO_MEMORY_SAVE_RAM');
          const sr = mod._get_memory_data(sk);
          mod._free(sk);
          if (sr) {
            const [ss, sp] = mod.UTF8ToString(sr).split('|').map(Number);
            if (ss > 0 && sp > 0) mod.HEAPU8.set(saveBytes.subarray(0, Math.min(saveBytes.length, ss)), sp);
          }
        } catch (_) {}
      }

      // Load state synchronously if available, else async
      if (mod?._kn_load_state_immediate) {
        const statePtr = mod._malloc(bytes.length);
        mod.HEAPU8.set(bytes, statePtr);
        mod._kn_load_state_immediate(statePtr, bytes.length);
        mod._free(statePtr);
      } else {
        gm.loadState(bytes);
        if (mod?._task_queue_check) mod._task_queue_check();
      }

      _setLastSyncState(bytes.slice(), 'late-join');
      enterManualMode();

      // Write game-specific RNG/settings values (gated to Smash Remix)
      if (msg.rngValues && _isSmashRemix() && mod?.HEAPU32 && mod?._get_memory_data) {
        try {
          const rk = mod.stringToNewUTF8('RETRO_MEMORY_SYSTEM_RAM');
          const rr = mod._get_memory_data(rk);
          mod._free(rk);
          if (rr) {
            const [, rp] = mod.UTF8ToString(rr).split('|').map(Number);
            const u32 = rp >> 2;
            mod.HEAPU32[u32 + (0x0005b940 >> 2)] = msg.rngValues.seed >>> 0;
            mod.HEAPU32[u32 + (0x000a0578 >> 2)] = msg.rngValues.altSeed >>> 0;
            mod.HEAPU32[u32 + (0x0003cb30 >> 2)] = msg.rngValues.frameCounter >>> 0;
            mod.HEAPU32[u32 + (0x0003b6e4 >> 2)] = msg.rngValues.screenFC >>> 0;
            if (msg.rngValues.vsBytes) mod.HEAPU8.set(new Uint8Array(msg.rngValues.vsBytes), rp + 0x000a4d08);
            if (msg.rngValues.matchCopy !== undefined)
              mod.HEAPU32[u32 + (0x0013bdac >> 2)] = msg.rngValues.matchCopy >>> 0;
            if (msg.rngValues.globalGameMode !== undefined)
              mod.HEAPU32[u32 + (0x004f756c >> 2)] = msg.rngValues.globalGameMode >>> 0;
          }
        } catch (_) {}
      }

      // Write SAVE_RAM again after loadState (in case loadState overwrote it)
      if (msg.saveData && mod?._get_memory_data && mod.HEAPU8) {
        try {
          const saveBytes = base64ToUint8(msg.saveData);
          const sk = mod.stringToNewUTF8('RETRO_MEMORY_SAVE_RAM');
          const sr = mod._get_memory_data(sk);
          mod._free(sk);
          if (sr) {
            const [ss, sp] = mod.UTF8ToString(sr).split('|').map(Number);
            if (ss > 0 && sp > 0) mod.HEAPU8.set(saveBytes.subarray(0, Math.min(saveBytes.length, ss)), sp);
          }
        } catch (_) {}
      }

      // Start at host's current frame (host is paused at msg.frame)
      _frameNum = msg.frame;
      for (let f = Math.max(0, msg.frame - DELAY_FRAMES); f <= msg.frame + DELAY_FRAMES; f++) {
        if (!_localInputs[f]) _localInputs[f] = KNShared.ZERO_INPUT;
        for (const p of Object.values(_peers)) {
          if (p.slot !== null && p.slot !== undefined) {
            if (!_remoteInputs[p.slot]) _remoteInputs[p.slot] = {};
            if (!_remoteInputs[p.slot][f]) _remoteInputs[p.slot][f] = KNShared.ZERO_INPUT;
          }
        }
      }

      _syncLog(`late-join loaded at frame ${msg.frame}`);

      startLockstep();

      // Re-establish WebRTC connections to any players whose peer connections
      // failed or are zombied (closed PC but still in _peers). During the
      // pre-lockstep phase, connections may fail (NAT, timing) and either get
      // removed by hardDisconnectPeer (_running was false) or left as zombies
      // by the reconnect timeout (which closes PC but doesn't delete from _peers).
      for (const [sid, info] of Object.entries(_knownPlayers)) {
        if (sid === socket.id) continue;
        const existing = _peers[sid];
        const pcState = existing?.pc?.connectionState;
        if (existing && pcState === 'connected' && existing.dc?.readyState === 'open') continue;
        // Peer is missing, dead, or has no working DC — clean up and recreate
        if (existing) {
          _syncLog(
            `late-join reconnect: replacing dead peer ${sid} slot=${info.slot} (pc=${pcState} dc=${existing.dc?.readyState ?? 'none'})`,
          );
          try {
            existing.pc.close();
          } catch (_) {}
          delete _peers[sid];
        } else {
          _syncLog(`late-join reconnect: creating peer ${sid} slot=${info.slot}`);
        }
        createPeer(sid, info.slot, true);
        sendOffer(sid, { reconnect: true });
      }

      // Tell host to resume — send via BOTH DC and Socket.IO for reliable
      // delivery. Socket.IO relay can drop/delay the message (rate limiting,
      // large queued payloads from the late-join-state broadcast), while the
      // DC is a direct peer connection that's already open.
      for (const p of Object.values(_peers)) {
        if (p.dc?.readyState === 'open') {
          try {
            p.dc.send('late-join-ready');
          } catch (_) {}
        }
      }
      socket.emit('data-message', { type: 'late-join-ready' });
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
      // Lazy start: first spectator triggers stream creation
      startSpectatorStream();
      // startSpectatorStream may retry async if canvas not ready yet.
      // If stream is ready now, add tracks immediately; otherwise
      // startSpectatorStream will pick up all spectator peers when it finishes.
      if (!_hostStream) return;
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

  // FPU trace — cross-platform determinism verification
  const _FPU_TRACE_SIZE = 4096;
  const _FPU_TRACE_ENTRY_BYTES = 32;
  const _FPU_TRACE_CHECK_INTERVAL = 300; // frames between hash comparisons
  let _fpuTraceEnabled = false;
  let _fpuTraceLastCheckFrame = 0;
  let _fpuTraceVerified = false; // true once a match is confirmed

  /** Read the FPU trace ring buffer from WASM and compute FNV-1a hash */
  const _fpuTraceHash = () => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._kn_fpu_trace_get_buf || !mod?._kn_fpu_trace_get_count) return null;
    const count = mod._kn_fpu_trace_get_count();
    if (count === 0) return null;
    const bufPtr = mod._kn_fpu_trace_get_buf();
    const totalBytes = _FPU_TRACE_SIZE * _FPU_TRACE_ENTRY_BYTES;
    const buf = mod.HEAPU8.subarray(bufPtr, bufPtr + totalBytes);
    let hash = 2166136261;
    for (let i = 0; i < totalBytes; i++) {
      hash ^= buf[i];
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return { hash, count };
  };

  /** Extract trace entries for a frame range from the ring buffer */
  const _fpuTraceExtract = (startFrame, endFrame) => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._kn_fpu_trace_get_buf) return [];
    const bufPtr = mod._kn_fpu_trace_get_buf();
    const count = mod._kn_fpu_trace_get_count();
    const entries = [];
    const used = Math.min(count, _FPU_TRACE_SIZE);
    const startIdx = count > _FPU_TRACE_SIZE ? count - _FPU_TRACE_SIZE : 0;
    for (let i = 0; i < used; i++) {
      const idx = (startIdx + i) & (_FPU_TRACE_SIZE - 1);
      const off = bufPtr + idx * _FPU_TRACE_ENTRY_BYTES;
      const op = mod.HEAPU8[off];
      const frame =
        mod.HEAPU8[off + 4] | (mod.HEAPU8[off + 5] << 8) | (mod.HEAPU8[off + 6] << 16) | (mod.HEAPU8[off + 7] << 24);
      if (frame < startFrame || frame > endFrame) continue;
      const dv = new DataView(mod.HEAPU8.buffer, off, _FPU_TRACE_ENTRY_BYTES);
      const in1Lo = dv.getUint32(8, true),
        in1Hi = dv.getUint32(12, true);
      const in2Lo = dv.getUint32(16, true),
        in2Hi = dv.getUint32(20, true);
      const outLo = dv.getUint32(24, true),
        outHi = dv.getUint32(28, true);
      entries.push({
        op,
        frame,
        in1: in1Hi
          ? `${in1Hi.toString(16).padStart(8, '0')}${in1Lo.toString(16).padStart(8, '0')}`
          : in1Lo.toString(16).padStart(8, '0'),
        in2: in2Hi
          ? `${in2Hi.toString(16).padStart(8, '0')}${in2Lo.toString(16).padStart(8, '0')}`
          : in2Lo.toString(16).padStart(8, '0'),
        out: outHi
          ? `${outHi.toString(16).padStart(8, '0')}${outLo.toString(16).padStart(8, '0')}`
          : outLo.toString(16).padStart(8, '0'),
      });
    }
    return entries;
  };

  const _FPU_OP_NAMES = [
    'add_s',
    'sub_s',
    'mul_s',
    'div_s',
    'sqrt_s',
    'abs_s',
    'neg_s',
    'add_d',
    'sub_d',
    'mul_d',
    'div_d',
    'sqrt_d',
    'abs_d',
    'neg_d',
    'cvt_s_d',
    'cvt_d_s',
    'cvt_s_w',
    'cvt_d_w',
    'cvt_s_l',
    'cvt_d_l',
  ];

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

    // Periodic gameplay screenshot for desync debugging
    if (_frameNum > 0 && _frameNum % SCREENSHOT_INTERVAL === 0) {
      _captureAndSendScreenshot();
    }

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

    // Ensure session log flushing is active. startGameSequence() sets this
    // up for normal joins, but late-joiners return early from that function
    // and resume here via handleLateJoinState() → startLockstep(). Without
    // this, late-joiners produce zero session logs and zero screenshots.
    if (!_flushInterval) {
      _cachedMatchId = _cachedMatchId || KNState.matchId;
      _cachedRoom = _cachedRoom || KNState.room;
      _cachedUploadToken = _cachedUploadToken || KNState.uploadToken;
      _socketFlushFails = 0;
      _flushInterval = setInterval(_flushSyncLog, 30000);
      _startTime = _startTime || performance.now();
    }

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
      _activeRoster = null;
      _rosterChangeFrame = -1;
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

      // Enable FPU trace for cross-platform determinism verification
      if (detMod?._kn_fpu_trace_enable) {
        detMod._kn_fpu_trace_enable(1);
        _fpuTraceEnabled = true;
        _fpuTraceLastCheckFrame = 0;
        _fpuTraceVerified = false;
        _syncLog('FPU trace enabled for determinism verification');
      }

      // Initialize C-level rollback engine if available
      if (detMod?._kn_rollback_init) {
        const numPlayers = getInputPeers().length + 1;
        const rollbackMax = Math.min(12, Math.max(7, DELAY_FRAMES + 4));
        detMod._kn_rollback_init(rollbackMax, DELAY_FRAMES, _playerSlot, numPlayers);
        _useCRollback = true;
        _syncLog(`C-ROLLBACK init: max=${rollbackMax} delay=${DELAY_FRAMES} slot=${_playerSlot} players=${numPlayers}`);
      } else {
        _useCRollback = false;
      }

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

    // Enable per-frame RNG seed sync for Smash Remix netplay.
    {
      const rngMod = window.EJS_emulator?.gameManager?.Module;
      if (rngMod) _initRNGSync(rngMod);
    }

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
      `DIAG-START slot=${_playerSlot} engine=${engine} mobile=${isMobile} forkedCore=${_hasForkedCore} romHash=${_config?.romHash?.substring(0, 16) || 'none'} ua=${ua.substring(0, 120)}`,
    );

    const activePeers = getActivePeers();
    const peerSlots = activePeers.map((p) => p.slot);
    _syncLog(`lockstep started -- slot: ${_playerSlot} peerSlots: ${peerSlots.join(',')} delay: ${DELAY_FRAMES}`);
    _broadcastRoster();
    _syncLog(`SYNC-MODE: RDRAM hash desync detection, knSync=${_hasKnSync}`);

    // Guest: skip RSP audio DRAM writes to prevent cross-platform divergence.
    // The RSP HLE audio math produces different intermediate RDRAM values on
    // ARM (Safari/iPhone) vs x86 (Chrome/Mac) WASM JIT engines. Skipping the
    // writes keeps guest DRAM identical to the state-sync baseline. The guest
    // receives audio via the lockstep audio bypass, not from DRAM.
    // RSP audio skip DISABLED — testing SoftFloat FPU determinism.
    // if (_playerSlot !== 0) {
    //   const skipMod = window.EJS_emulator?.gameManager?.Module;
    //   if (skipMod?._kn_set_skip_rsp_audio) {
    //     skipMod._kn_set_skip_rsp_audio(1);
    //     _syncLog('RSP audio DRAM writes disabled (guest — lockstep audio bypass)');
    //   }
    // }

    setStatus('Connected -- game on!');
    _startTime = performance.now();
    _cachedMatchId = KNState.matchId;
    _cachedRoom = KNState.room;
    _cachedUploadToken = KNState.uploadToken;
    _socketFlushFails = 0;
    _flushInterval = setInterval(_flushSyncLog, 30000);

    window._lockstepActive = true;

    // C-level sync: detect patched core with kn_sync exports.
    // Detect patched core with kn_sync exports. Buffer is allocated lazily
    // on first use (see ensureSyncBuffer) to avoid triggering WASM memory
    // growth at startup when sync may never be needed.
    const knMod = window.EJS_emulator?.gameManager?.Module;
    _hasKnSync = !!(knMod && knMod._kn_sync_hash && knMod._kn_sync_read && knMod._kn_sync_write);
    // kn_frame_hash detection removed — using canvas hash instead
    // kn_sync_write_regions is disabled: patching only RDRAM mid-frame causes video
    // freeze + UI resize because the N64 CPU state (PC, registers) is inconsistent
    // with the patched data. Safe partial sync requires frame-level state management (v2). Exports remain
    // compiled in for future diagnostic use.
    _hasKnSyncRegions = false;
    if (_hasKnSync) {
      // Sync buffer allocation deferred to first use (ensureSyncBuffer is called
      // inside pushSyncState/applySyncState). Allocating 8MB at init on mobile
      // can trigger WASM memory growth that disrupts DataChannel stability.
      _syncLog(
        `C-level sync available${_syncBufPtr ? `, buf at ${_syncBufPtr}` : ' (buffer deferred)'}${_hasKnSyncRegions ? ' [regions]' : ''}`,
      );
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
        } else {
          _resyncRequestInFlight = false; // override — tab-focus resync always wins
          _syncTargetFrame = -1; // cancel any pending coord target — tab was paused, immediate sync needed
          const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
          if (hostPeer?.dc?.readyState === 'open') {
            try {
              _resyncRequestInFlight = true;
              hostPeer.dc.send('sync-request');
            } catch (_) {
              _resyncRequestInFlight = false;
            }
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
        _resyncRequestInFlight = false; // override — network change resync always wins
        _syncTargetFrame = -1; // cancel any pending coord target — network path changed, immediate sync needed
        const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
        if (hostPeer?.dc?.readyState === 'open') {
          try {
            _resyncRequestInFlight = true;
            hostPeer.dc.send('sync-request-full');
          } catch (_) {
            _resyncRequestInFlight = false;
          }
        }
      } else {
        // Host: reset sync interval so hash checks resume quickly
        _consecutiveResyncs = 0;
        _syncCheckInterval = _syncBaseInterval;
      }
    };
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn) conn.addEventListener('change', _networkChangeHandler);
    window.addEventListener('online', _networkChangeHandler);

    // Use setInterval so background tabs are not throttled
    _tickInterval = setInterval(tick, 16);

    // Live RTT probe — runs every 5s to catch latency spikes (e.g. 5G jitter).
    // Delay is fixed for the session — no live RTT probes.
  };

  const stopSync = () => {
    _running = false;
    window._lockstepActive = false;
    _resyncRequestInFlight = false;
    _lastAppliedSyncHostFrame = -1;

    // Re-enable RSP audio DRAM writes
    const stopMod = window.EJS_emulator?.gameManager?.Module;
    if (stopMod?._kn_set_skip_rsp_audio) stopMod._kn_set_skip_rsp_audio(0);

    // Shutdown C-level rollback
    if (_useCRollback) {
      if (stopMod?._kn_rollback_shutdown) stopMod._kn_rollback_shutdown();
      _useCRollback = false;
    }

    // Disable FPU trace
    if (_fpuTraceEnabled) {
      if (stopMod?._kn_fpu_trace_enable) stopMod._kn_fpu_trace_enable(0);
      _fpuTraceEnabled = false;
    }

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
    // Free C-level sync buffers
    if (_syncBufPtr && _hasKnSync) {
      const modStop = window.EJS_emulator?.gameManager?.Module;
      if (modStop?._free) {
        modStop._free(_syncBufPtr);
        if (_regionsBufPtr) modStop._free(_regionsBufPtr);
        if (_regionsOffsetPtr) modStop._free(_regionsOffsetPtr);
      }
      _syncBufPtr = 0;
      _regionsBufPtr = 0;
      _regionsOffsetPtr = 0;
    }
    _hasKnSync = false;
    _hasKnSyncRegions = false;
    _frameAdvantage = 0;
    _frameAdvRaw = 0;
    _framePacingActive = false;
    _pacingCapsCount = 0;
    _pacingCapsFrames = 0;
    _pacingMaxAdv = 0;
    _pacingAdvSum = 0;
    _pacingAdvCount = 0;
    _pacingSkipCounter = 0;
    // Remove diagnostic hooks
    if (_diagHookInstalled) {
      if (_diagVisHandler) {
        document.removeEventListener('visibilitychange', _diagVisHandler);
        _diagVisHandler = null;
      }
      if (_diagFocusHandler) {
        window.removeEventListener('focus', _diagFocusHandler);
        _diagFocusHandler = null;
      }
      if (_diagBlurHandler) {
        window.removeEventListener('blur', _diagBlurHandler);
        _diagBlurHandler = null;
      }
      for (const { el, evName, handler } of _diagTouchHandlers) {
        el.removeEventListener(evName, handler);
      }
      _diagTouchHandlers = [];
      if (_diagObserver) {
        _diagObserver.disconnect();
        _diagObserver = null;
      }
      _diagHookInstalled = false;
    }
  };

  const tick = () => {
    if (!_running) return;
    if (_lateJoinPaused) return; // frozen while late-joiner loads state

    // Async resync: apply buffered state at clean frame boundary.
    // Coordinated injection: hold state until _syncTargetFrame so host and guest
    // both reach that frame before the state is applied — snap = 0.
    if (_syncTargetFrame > 0) {
      if (_frameNum >= _syncTargetFrame) {
        if (_pendingResyncState) {
          // State arrived on time — apply at the agreed frame
          const pending = _pendingResyncState;
          _pendingResyncState = null;
          _awaitingResync = false;
          _syncTargetFrame = -1;
          _audioFadeOut();
          applySyncState(pending.bytes, pending.frame, pending.fromProactive);
          _audioFadeIn();
        } else if (!_awaitingResync) {
          // Reached target frame but state not here yet — stall until it arrives
          _awaitingResync = true;
          _awaitingResyncAt = performance.now();
          _audioFadeOut();
          _syncLog(`coord stall at frame ${_frameNum} (target=${_syncTargetFrame}) — waiting for state`);
        }
        // _awaitingResync already true: stall check below keeps loop paused;
        // next tick that has _pendingResyncState will apply it above and resume.
      }
      // _frameNum < _syncTargetFrame: keep running, hold buffered state until target
    } else if (_pendingResyncState) {
      // Non-coordinated (proactive push, reconnect, visibility/network-change): apply now
      const pending = _pendingResyncState;
      _pendingResyncState = null;
      _awaitingResync = false;
      _audioFadeOut();
      applySyncState(pending.bytes, pending.frame, pending.fromProactive);
      _audioFadeIn();
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
          _syncLog('PACING-THROTTLE released — all peers phantom');
        }
        if (activePacingPeers > 0 && minRemoteFrame >= 0) {
          _frameAdvRaw = _frameNum - minRemoteFrame;
          const alpha = _frameAdvRaw > _frameAdvantage ? FRAME_ADV_ALPHA_UP : FRAME_ADV_ALPHA_DOWN;
          _frameAdvantage = _frameAdvantage * (1 - alpha) + _frameAdvRaw * alpha;

          // Track stats for periodic summary
          _pacingAdvSum += _frameAdvantage;
          _pacingAdvCount++;
          if (_frameAdvantage > _pacingMaxAdv) _pacingMaxAdv = _frameAdvantage;

          // Proportional throttle: skip a fraction of ticks based on how far ahead we are.
          // excess=1 → 25% skip (~45fps), =2 → 50% (~30fps), =3 → 75% (~15fps), ≥4 → full stop.
          const excess = _frameAdvRaw - DELAY_FRAMES;
          let shouldSkip = false;
          if (excess >= 4) {
            shouldSkip = true;
          } else if (excess >= 1) {
            _pacingSkipCounter++;
            const skip = SKIP_TABLE[excess];
            shouldSkip = skip && _pacingSkipCounter % skip[0] < skip[1];
          }
          if (shouldSkip) {
            _pacingCapsFrames++;
            if (!_framePacingActive) {
              _framePacingActive = true;
              _pacingCapsCount++;
              const ratio =
                excess >= 4 ? '100%' : `${Math.round((SKIP_TABLE[excess][1] / SKIP_TABLE[excess][0]) * 100)}%`;
              _syncLog(
                `PACING-THROTTLE start fAdv=${_frameAdvRaw} ratio=${ratio} smooth=${_frameAdvantage.toFixed(1)} delay=${DELAY_FRAMES} minRemote=${minRemoteFrame}`,
              );
            }
            return;
          }
          if (_framePacingActive) {
            _framePacingActive = false;
            _syncLog(`PACING-THROTTLE end fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)}`);
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

    // ── C-level rollback path: kn_tick() handles prediction, replay, and stepping ──
    // Input was already sent to peers above. kn_tick() saves state, predicts missing
    // remote input, replays on misprediction, writes inputs, and calls retro_run().
    // JS only needs to feed audio and advance the frame counter.
    if (_useCRollback) {
      const tickMod = window.EJS_emulator?.gameManager?.Module;
      if (tickMod?._kn_tick) {
        if (tickMod._kn_reset_audio) tickMod._kn_reset_audio();
        _syncRNGSeed(tickMod, _frameNum);
        _inDeterministicStep = true;
        const newFrame = tickMod._kn_tick(
          localInput.buttons,
          localInput.lx,
          localInput.ly,
          localInput.cx,
          localInput.cy,
        );
        _inDeterministicStep = false;
        feedAudio();
        _frameNum = newFrame;
        KNState.frameNum = _frameNum;

        // Debug overlay — update every 15 frames
        if (_frameNum % 15 === 0) {
          const dbg = document.getElementById('np-debug');
          if (dbg) {
            dbg.style.display = '';
            const rb = tickMod._kn_get_rollback_count?.() ?? 0;
            const pred = tickMod._kn_get_prediction_count?.() ?? 0;
            const correct = tickMod._kn_get_correct_predictions?.() ?? 0;
            const maxD = tickMod._kn_get_max_depth?.() ?? 0;
            dbg.textContent = `F:${_frameNum} fps:${_fpsCurrent} slot:${_playerSlot} delay:${DELAY_FRAMES} rb:${rb} pred:${pred} correct:${correct} maxD:${maxD}`;
          }
        }

        // Periodic gameplay screenshot for desync debugging
        if (_frameNum > 0 && _frameNum % SCREENSHOT_INTERVAL === 0) {
          _captureAndSendScreenshot();
        }
      }
      return;
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
        // Gap-fill: if a peer has already sent inputs AHEAD of applyFrame, this specific
        // frame will never arrive (late-join or post-reconnect gap). Fabricate immediately
        // rather than waiting MAX_STALL_MS + RESEND_TIMEOUT_MS (5s) — otherwise a proactive
        // state flood can starve the setInterval tick and the hard-timeout never fires.
        const gapSlots = _missingSlots.filter(
          (s) => _lastRemoteFramePerSlot[s] !== undefined && _lastRemoteFramePerSlot[s] > applyFrame,
        );
        if (gapSlots.length > 0) {
          for (const s of gapSlots) {
            if (!_remoteInputs[s]) _remoteInputs[s] = {};
            if (_remoteInputs[s][applyFrame] === undefined) {
              _remoteInputs[s][applyFrame] = KNShared.ZERO_INPUT;
              _consecutiveFabrications[s] = (_consecutiveFabrications[s] || 0) + 1;
            }
          }
          _syncLog(
            `INPUT-GAP-FILL applyFrame=${applyFrame} slots=[${gapSlots.join(',')}] — peer ahead, immediate fabricate`,
          );
          _stallStart = 0;
          return; // re-enter next tick with input now present
        }

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

      // Zero ALL 4 slots first, then overwrite with real input.
      // This ensures consistency: every slot is either written from real
      // input or zeroed, with no conditional checks on peer state.
      for (let zs = 0; zs < 4; zs++) {
        writeInputToMemory(zs, 0);
      }

      // Write local player's input
      const localInput = _localInputs[applyFrame] || KNShared.ZERO_INPUT;
      writeInputToMemory(_playerSlot, localInput);

      // Write remote inputs for peers in the input roster
      for (let m = 0; m < inputPeers.length; m++) {
        const peerSlot = inputPeers[m].slot;
        const remoteInput = (_remoteInputs[peerSlot] && _remoteInputs[peerSlot][applyFrame]) || KNShared.ZERO_INPUT;
        writeInputToMemory(peerSlot, remoteInput);
        if (_remoteInputs[peerSlot]) delete _remoteInputs[peerSlot][applyFrame];
      }

      // Also write input for roster slots that have no peer object yet
      // (e.g., late joiner whose DC hasn't formed). They get zeros, which
      // is what every other player also writes for that slot.
      if (_activeRoster) {
        for (const rosterSlot of _activeRoster) {
          if (rosterSlot === _playerSlot) continue;
          const hasPeer = inputPeers.some((p) => p.slot === rosterSlot);
          if (!hasPeer) writeInputToMemory(rosterSlot, 0);
        }
      }

      // Dense DIAG-INPUT after roster changes: read back what's in WASM
      // memory for each slot so we can compare across players frame-by-frame.
      if (_rosterChangeFrame >= 0 && _frameNum - _rosterChangeFrame < 120) {
        _diagInput(_frameNum, applyFrame, true);
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
          `INPUT-LOG f=${_frameNum} apply=${applyFrame} local=${JSON.stringify(localInput)} delay=${DELAY_FRAMES} inputPeers=[${inputPeers.map((p) => p.slot).join(',')}] rBuf=${JSON.stringify(rBufDetail)} dc=${JSON.stringify(dcStates)} missed=${_remoteMissed} applied=${_remoteApplied} sendFails=${_sendFails} fps=${_fpsCurrent} fAdv=${_frameAdvantage.toFixed(1)} fAdvRaw=${_frameAdvRaw} roster=[${_activeRoster ? [..._activeRoster].join(',') : 'none'}]`,
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
      // Mesh health check (~5s): reconcile _knownPlayers (server truth) against
      // actual DC state. Re-initiate connections to players the server says are
      // in the room but we have no working DC to. This catches zombie peers,
      // failed initial connections, and silent DC deaths that no event fires for.
      if (_frameNum % 300 === 0) {
        for (const [sid, info] of Object.entries(_knownPlayers)) {
          if (sid === socket.id) continue;
          const p = _peers[sid];
          if (p && p.dc?.readyState === 'open') continue; // healthy
          if (p?.reconnecting) continue; // already in progress
          if (_peerPhantom[info.slot]) continue; // confirmed dead during gameplay
          const pcState = p?.pc?.connectionState;
          _syncLog(
            `MESH-HEAL f=${_frameNum} slot=${info.slot} sid=${sid} pc=${pcState ?? 'gone'} dc=${p?.dc?.readyState ?? 'none'}`,
          );
          if (p) {
            try {
              p.pc.close();
            } catch (_) {}
            delete _peers[sid];
          }
          createPeer(sid, info.slot, true);
          sendOffer(sid, { reconnect: true });
        }
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
        _syncTargetFrame = -1;
        _resyncRequestInFlight = false; // unblock future resync requests
        _lastResyncTime = 0; // clear cooldown so next desync triggers immediately
      } else {
        return;
      }
    }

    // Step one frame with audio capture
    const tickMod = window.EJS_emulator?.gameManager?.Module;
    if (tickMod?._kn_reset_audio) tickMod._kn_reset_audio();
    _syncRNGSeed(tickMod, _frameNum);
    _inDeterministicStep = true;
    stepOneFrame();
    _inDeterministicStep = false;
    feedAudio();

    _frameNum++;
    KNState.frameNum = _frameNum;

    // Coordinated sync dispatch: when host reaches a scheduled target frame, capture
    // and send state. Coalesces multiple guests (4P) into a single broadcast push.
    if (_playerSlot === 0 && _scheduledSyncRequests.length > 0 && !_pushingSyncState) {
      const due = _scheduledSyncRequests.filter((r) => r.targetFrame <= _frameNum);
      if (due.length > 0) {
        _scheduledSyncRequests = _scheduledSyncRequests.filter((r) => r.targetFrame > _frameNum);
        const forceFull = due.some((r) => r.forceFull);
        if (forceFull) _setLastSyncState(null, 'coord-full');
        // Broadcast if multiple guests need sync simultaneously (all at same lockstep frame)
        const targetSid = due.length === 1 ? due[0].targetSid : null;
        _syncLog(
          `coord sync dispatch: ${due.length} guest(s) at frame ${_frameNum}${targetSid === null ? ' (broadcast)' : ''}`,
        );
        pushSyncState(targetSid);
      }
    }

    // (Deferred sync check removed — frame hash computes live, no deferral needed.)

    // -- Periodic desync check DISABLED -----
    // AI DMA determinism + RSP audio skip makes steady-state gameplay deterministic.
    // Periodic hash checks (RDRAM, canvas, frame hash) all had reliability issues:
    //   - RDRAM anchors: audio regions diverge cross-platform (RSP HLE WASM JIT differences)
    //   - Canvas hash: WebGL preserveDrawingBuffer returns constant; GPU rendering differs
    //   - kn_frame_hash: VI RDRAM not updated by GLideN64
    // Resync is only triggered by reconnect/peer-recovery events.
    // Lazy detection for C-level sync (needed for state transfer on reconnect)
    if (_syncEnabled && _playerSlot === 0 && _frameNum === 510) {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (mod && !_hasKnSync && mod._kn_sync_hash && mod._kn_sync_read && mod._kn_sync_write) {
        _hasKnSync = true;
        ensureSyncBuffer();
        _syncLog('C-level sync available [lazy]');
      }
    }
    // FPU trace hash check — host broadcasts periodically
    if (_fpuTraceEnabled && _playerSlot === 0 && _frameNum - _fpuTraceLastCheckFrame >= _FPU_TRACE_CHECK_INTERVAL) {
      _fpuTraceLastCheckFrame = _frameNum;
      const traceInfo = _fpuTraceHash();
      if (traceInfo) {
        for (const p of Object.values(_peers)) {
          if (p.dc?.readyState === 'open') {
            try {
              p.dc.send(`fpu-trace:${_frameNum}:${traceInfo.hash}:${traceInfo.count}`);
            } catch (_) {}
          }
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
      '    } else if (msg.type === "xor") {',
      '      var data = msg.data, base = msg.base;',
      '      var out = new Uint8Array(base.length);',
      '      var len32 = Math.floor(base.length / 4);',
      '      var b32 = new Uint32Array(base.buffer, 0, len32);',
      '      var d32 = new Uint32Array(data.buffer, 0, len32);',
      '      var o32 = new Uint32Array(out.buffer, 0, len32);',
      '      for (var i = 0; i < len32; i++) o32[i] = b32[i] ^ d32[i];',
      '      for (var i = len32 * 4; i < base.length; i++) out[i] = base[i] ^ data[i];',
      '      postMessage({id:id, data:out}, [out.buffer]);',
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
      // Transfer ArrayBuffers zero-copy to worker (detaches on main thread)
      const transfer = [];
      if (msg.data?.buffer) transfer.push(msg.data.buffer);
      if (msg.base?.buffer) transfer.push(msg.base.buffer);
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

  // -- Async state sync (compress/decompress via Web Worker) -----------------

  let _pushingSyncState = false; // debounce concurrent sync-request handling
  let _proactivePushInFlight = false; // separate flag so proactive pushes never block explicit sync-requests

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
    // Proactive and explicit syncs use separate in-flight guards so that a
    // proactive push in progress never drops a sync-request from a reconnecting guest.
    if (isProactive ? _proactivePushInFlight : _pushingSyncState) return;

    const gm = window.EJS_emulator?.gameManager;
    if (!gm) return;
    if (isProactive) {
      _proactivePushInFlight = true;
    } else {
      _pushingSyncState = true;
    }
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
        if (isProactive) _proactivePushInFlight = false;
        else _pushingSyncState = false;
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

    // Proactive: always send full state — no shared delta chain with explicit syncs.
    // If a proactive packet is lost (e.g. network switch), the host and guest would
    // have divergent delta bases, making the next explicit delta unapplicable → freeze.
    // By keeping proactive pushes full and independent, packet loss is harmless.
    //
    // Explicit: delta XOR against previous state if available.
    let isFull, toCompress;
    if (isProactive) {
      isFull = true;
      toCompress = currentState;
      // Do NOT advance _lastSyncState — proactive pushes are independent of the
      // requested-sync delta chain.
    } else {
      // Delta chain safety: with _resyncRequestInFlight (single in-flight) on the guest,
      // the host only receives a second sync-request after the first response has been
      // received and applied. So when the host computes a delta here, _lastSyncState
      // matches what the guest has already applied — no forced-full needed.
      isFull = !_lastSyncState || _lastSyncState.length !== currentState.length;
      _syncLog(
        `pushSync: lastState=${_lastSyncState ? _lastSyncState.length : 'null'} current=${currentState.length} isFull=${isFull}`,
      );
      if (isFull) {
        toCompress = currentState;
      } else {
        toCompress = new Uint8Array(currentState.length);
        for (let i = 0; i < currentState.length; i++) {
          toCompress[i] = currentState[i] ^ _lastSyncState[i];
        }
      }
      // Update delta base for next explicit sync.
      // Must .slice() because compressState() transfers the buffer to a Web Worker,
      // which detaches the ArrayBuffer. Without the copy, _lastSyncState.length === 0
      // on the next push and delta never fires.
      _setLastSyncState(currentState.slice(), 'pushSync');
    }

    try {
      const compressed = await compressState(toCompress);
      const sizeKB = Math.round(compressed.length / 1024);
      _syncLog(`${isFull ? 'full' : 'delta'} state: ${sizeKB}KB compressed`);
      await sendSyncChunks(compressed, frame, isFull, targetSid, isProactive);
    } catch (err) {
      _syncLog(`sync compress failed: ${err}`);
    } finally {
      if (isProactive) _proactivePushInFlight = false;
      else _pushingSyncState = false;
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
      // Prefer the dedicated low-priority sync-state DC; fall back to lockstep DC
      // if syncDc isn't open yet (e.g. during initial handshake race).
      const dc = target.syncDc && target.syncDc.readyState === 'open' ? target.syncDc : target.dc;
      if (!dc || dc.readyState !== 'open') {
        _syncLog(`sync send skipped: target slot=${target.slot} dc=${dc ? dc.readyState : 'null'}`);
        continue;
      }
      // Proactive flood prevention: if the DataChannel is already backed up
      // (e.g. host is many frames ahead after a guest reconnect), skip this
      // proactive push. A backed-up DC means the event loop is already saturated
      // with chunk-send microtasks — sending more would starve setInterval ticks
      // and prevent the stall hard-timeout from firing.
      if (isProactive && dc.bufferedAmount > 1024 * 1024) {
        _syncLog(
          `proactive push skipped: slot=${target.slot} bufferedAmount=${Math.round(dc.bufferedAmount / 1024)}KB — DC backed up`,
        );
        continue;
      }
      try {
        dc.send(header);
        for (let i = 0; i < numChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, compressed.length);
          dc.send(compressed.slice(start, end));
          // With AI DMA determinism, sync transfers only happen on reconnect
          // (not during gameplay). No need to yield — get the state to the
          // guest as fast as possible to minimize the coord stall duration.
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

  const pushRegionsSyncState = async (targetSid) => {
    // Host: read only the 4 diverged 64KB RDRAM blocks, compress, send as sync-regions-start packet.
    // ~256KB vs 8MB — guest applies with kn_sync_write_regions, no full state snap.
    if (_playerSlot !== 0 || !_syncEnabled) return;
    if (_pushingSyncState) return;
    const gm = window.EJS_emulator?.gameManager;
    if (!gm) return;
    const mod = gm.Module;
    ensureRegionsBuffer();
    if (!_regionsBufPtr || !_hasKnSyncRegions) {
      return pushSyncState(targetSid);
    }
    _pushingSyncState = true;
    const frame = _frameNum;
    try {
      const bytesRead = mod._kn_sync_read_regions(
        _regionsOffsetPtr,
        _SYNC_REGION_OFFSETS.length,
        _regionsBufPtr,
        _SYNC_REGIONS_TOTAL,
      );
      if (!bytesRead) {
        _syncLog('kn_sync_read_regions returned 0 — falling back to full sync');
        _pushingSyncState = false;
        return pushSyncState(targetSid);
      }
      const regionData = new Uint8Array(mod.HEAPU8.buffer, _regionsBufPtr, bytesRead).slice();
      _syncLog(`host kn_sync_read_regions: ${Math.round(regionData.length / 1024)}KB frame=${frame}`);
      const compressed = await compressState(regionData);
      await sendRegionsSyncChunks(compressed, frame, targetSid);
    } catch (err) {
      _syncLog(`regions sync error: ${err}`);
    } finally {
      _pushingSyncState = false;
    }
  };

  const sendRegionsSyncChunks = async (compressed, frame, targetSid) => {
    const CHUNK_SIZE = 64000;
    const numChunks = Math.ceil(compressed.length / CHUNK_SIZE);
    const target = _peers[targetSid];
    if (!target) return;
    const dc = target.syncDc?.readyState === 'open' ? target.syncDc : target.dc;
    if (!dc || dc.readyState !== 'open') {
      _syncLog(`regions sync: target slot=${target.slot} dc not open`);
      return;
    }
    try {
      dc.send(`sync-regions-start:${frame}:${numChunks}`);
      for (let i = 0; i < numChunks; i++) {
        const start = i * CHUNK_SIZE;
        dc.send(compressed.slice(start, Math.min(start + CHUNK_SIZE, compressed.length)));
        if ((i + 1) % 3 === 0 && i < numChunks - 1) await new Promise((r) => setTimeout(r, 0));
      }
      _syncLog(
        `regions sync sent to slot=${target.slot}: frame=${frame} ${Math.round(compressed.length / 1024)}KB ${numChunks} chunks`,
      );
    } catch (err) {
      _syncLog(`regions sync send failed to slot=${target.slot}: ${err}`);
    }
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
    const isRegions = _syncIsRegions;
    _syncIsRegions = false;

    try {
      const decompressed = await decompressState(assembled);

      // Regions patch: decompress directly, buffer for apply — no delta chain
      if (isRegions) {
        _resyncRequestInFlight = false;
        if (frame <= _lastAppliedSyncHostFrame) {
          _syncLog(`regions sync discarded: stale frame=${frame} <= lastApplied=${_lastAppliedSyncHostFrame}`);
          return;
        }
        _pendingResyncState = { bytes: decompressed, frame, isRegions: true };
        _syncLog(`regions resync ready: ${Math.round(assembled.length / 1024)}KB wire frame=${frame}`);
        return;
      }

      let fullBytes;
      if (isFull) {
        fullBytes = decompressed;
      } else {
        // Delta: XOR against _lastSyncState. Both host and guest cached this.
        if (!_lastSyncState || _lastSyncState.length !== decompressed.length) {
          _syncLog(
            `delta base missing or size mismatch: last=${_lastSyncState?.length} delta=${decompressed.length} — requesting full`,
          );
          _resyncRequestInFlight = false; // allow fresh request
          _awaitingResync = false; // release any active coord stall
          _syncTargetFrame = -1;
          const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
          const hostSyncDc = hostPeer?.syncDc?.readyState === 'open' ? hostPeer.syncDc : hostPeer?.dc;
          if (hostSyncDc?.readyState === 'open') {
            try {
              _resyncRequestInFlight = true;
              hostSyncDc.send('sync-request-full');
            } catch (_) {
              _resyncRequestInFlight = false;
            }
          }
          return;
        }
        // XOR in worker (off main thread) — 8MB byte loop would spike 5-15ms on mobile.
        // Transfer both buffers zero-copy; _lastSyncState is overwritten by _setLastSyncState
        // below anyway so detaching it here is safe.
        const xorResult = await workerPost({ type: 'xor', data: decompressed, base: _lastSyncState });
        fullBytes = xorResult.data;
      }

      if (isProactive) {
        // Proactive push: buffer for instant resync, don't apply yet.
        // Do NOT advance _lastSyncState — proactive states are independent of the
        // requested-sync delta chain. Advancing it here would desync delta bases
        // if any proactive packet is lost (e.g. during a network switch).
        _preloadedResyncState = { bytes: fullBytes, frame, receivedFrame: _frameNum };
        _syncLog(`proactive state buffered: ${Math.round(assembled.length / 1024)}KB wire, frame=${frame}`);
      } else {
        // Request satisfied — clear in-flight flag so next desync can send a new request.
        _resyncRequestInFlight = false;
        // Discard if we already applied a state at or after this frame (e.g. proactive
        // fast-path already jumped us forward — applying an older explicit would roll back).
        if (frame <= _lastAppliedSyncHostFrame) {
          _syncLog(`explicit sync discarded: stale frame=${frame} <= lastApplied=${_lastAppliedSyncHostFrame}`);
          return;
        }
        _pendingResyncState = { bytes: fullBytes, frame };
        _syncLog(`resync ready (${isFull ? 'full' : 'delta'}, ${Math.round(assembled.length / 1024)}KB wire)`);
      }
    } catch (err) {
      _syncLog(`sync decompress failed: ${err}`);
    }
  };

  const applySyncState = (bytes, frame, fromProactive = false) => {
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

      // Cache applied state as delta base for next resync.
      // Proactive states must NOT update the delta base — the host's delta base only
      // advances on explicit syncs, so applying a proactive state here would cause
      // host/guest delta bases to diverge, producing XOR-garbage on the next delta.
      if (!fromProactive) _setLastSyncState(bytes.slice(), 'applySyncC');

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

      // Cache applied state as delta base (same proactive guard as C path above)
      if (!fromProactive) _setLastSyncState(new Uint8Array(bytes), 'applySyncFallback');

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
    _lastAppliedSyncHostFrame = frame; // discard any explicit state older than this
    _lastResyncTime = performance.now(); // restart cooldown from application time, not request time
    // Reset frame pacing after resync — the guest may be behind the host and needs
    // to catch up without PACING-THROTTLE fighting the recovery. Clear the EMA smoothing
    // so pacing starts fresh from the new synchronized state.
    _frameAdvantage = 0;
    _frameAdvRaw = 0;
    _framePacingActive = false;
    _pacingCapsCount = 0;
    _pacingCapsFrames = 0;
    _pacingMaxAdv = 0;
    _pacingAdvSum = 0;
    _pacingAdvCount = 0;
    _pacingSkipCounter = 0;
    const syncMsg = `sync #${_resyncCount} applied (frame ${frame} -> ${_frameNum}, next in ${_syncCheckInterval}f)`;
    _syncLog(syncMsg);
    const now = performance.now();
    if (now - _lastResyncToastTime > 5000) {
      _lastResyncToastTime = now;
      _config?.onSyncStatus?.('Desync corrected');
    }
  };

  const applyRegionsSyncState = (bytes, frame) => {
    // Guest: patch only the diverged RDRAM blocks via kn_sync_write_regions.
    // No full state snap — CPU state is untouched, game continues forward.
    const gm = window.EJS_emulator?.gameManager;
    if (!gm || !_hasKnSyncRegions) return;
    const mod = gm.Module;
    ensureRegionsBuffer();
    if (!_regionsBufPtr) {
      _syncLog('regions buffer not ready — skipping regions apply');
      return;
    }
    mod.HEAPU8.set(bytes, _regionsBufPtr);
    const lt0 = performance.now();
    const result = mod._kn_sync_write_regions(
      _regionsOffsetPtr,
      _SYNC_REGION_OFFSETS.length,
      _regionsBufPtr,
      bytes.length,
    );
    const lt1 = performance.now();
    if (result !== 0) {
      _syncLog(`kn_sync_write_regions failed: result=${result}`);
      return;
    }
    _syncLog(`kn_sync_write_regions: ${Math.round(bytes.length / 1024)}KB, ${(lt1 - lt0).toFixed(1)}ms`);
    // Do NOT update _lastSyncState — regions don't participate in the full-state delta chain.
    _resyncCount++;
    _consecutiveResyncs++;
    _syncMismatchStreak = 0;
    _lastResyncFrame = _frameNum;
    _lastAppliedSyncHostFrame = frame;
    _lastResyncTime = performance.now();
    _syncLog(`regions sync #${_resyncCount} applied (frame ${frame}, next in ${_syncCheckInterval}f)`);
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
    _syncEnabled = !!config.resyncEnabled; // default: false
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
    _flushSyncLog();
    _cachedMatchId = null;
    _cachedRoom = null;
    _cachedUploadToken = null;
    _socketFlushFails = 0;
    if (_flushInterval) {
      clearInterval(_flushInterval);
      _flushInterval = null;
    }
    _startTime = 0;
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
      if (p.syncDc)
        try {
          p.syncDc.close();
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

    // Pause the emulator before restoring rAF — without this, the Emscripten
    // main loop is still in "resumed" state with a captured runner. Restoring
    // native rAF while the loop is resumed causes two concurrent frame runners
    // (the captured one + a new rAF callback), resulting in 2x FPS.
    const stopMod = window.EJS_emulator?.gameManager?.Module;
    if (stopMod?.pauseMainLoop && _manualMode) {
      stopMod.pauseMainLoop();
    }

    // Restore all overridden browser APIs (rAF, performance.now, getGamepads)
    APISandbox.restoreAll();
    _manualMode = false;
    _pendingRunner = null;

    // Reset lockstep state
    _remoteInputs = {};
    _peerInputStarted = {};
    _activeRoster = null;
    _localInputs = {};
    _frameNum = 0;
    KNState.frameNum = 0;
    _running = false;
    _lateJoin = false;
    _gameStarted = false;
    _selfEmuReady = false;
    _selfLockstepReady = false;
    _syncStarted = false;
    _awaitingLateJoinState = false;
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
    _pacingSkipCounter = 0;
    _resyncCount = 0;
    _consecutiveResyncs = 0;
    _syncCheckInterval = _syncBaseInterval;
    _syncChunks = [];
    _syncExpected = 0;
    _pushingSyncState = false;
    _proactivePushInFlight = false;
    _pendingResyncState = null;
    _preloadedResyncState = null;
    _awaitingResync = false;
    _awaitingResyncAt = 0;
    _syncTargetFrame = -1;
    _scheduledSyncRequests = [];
    _lastResyncTime = 0;
    _heldKeys.clear();
    _p1KeyMap = null;
    KNShared.teardownKeyTracking();
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
    _syncLogRing.clear();

    // Clean up audio bypass
    if (_audioWorklet) {
      _audioWorklet.disconnect();
      _audioWorklet = null;
    }
    if (_resyncGainNode) {
      _resyncGainNode.disconnect();
      _resyncGainNode = null;
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

    // Restore original console.log
    if (_originalConsoleLog) {
      console.log = _originalConsoleLog;
      _originalConsoleLog = null;
    }

    // Clear debug log between sessions
    _debugLog.length = 0;

    _config = null;
  };

  window.NetplayLockstep = {
    init,
    stop,
    exportSyncLog,
    flushSyncLog: _flushSyncLog,
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
    getDebugState: () => ({
      activeRoster: _activeRoster ? [..._activeRoster] : null,
      inputPeerSlots: getInputPeers().map((p) => p.slot),
      running: _running,
      frameNum: _frameNum,
      playerSlot: _playerSlot,
      peerCount: Object.keys(_peers).length,
    }),
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
    // C-level rollback diagnostics
    selfTest: () => {
      const m = window.EJS_emulator?.gameManager?.Module;
      if (!m?._kn_rollback_self_test) return 'C-level rollback not available';
      const result = m._kn_rollback_self_test();
      return result === 1 ? 'DETERMINISTIC' : result === 0 ? 'NON-DETERMINISTIC' : 'ERROR';
    },
    getRollbackStats: () => {
      const m = window.EJS_emulator?.gameManager?.Module;
      if (!m?._kn_get_rollback_count) return null;
      return {
        rollbacks: m._kn_get_rollback_count(),
        predictions: m._kn_get_prediction_count(),
        correctPredictions: m._kn_get_correct_predictions(),
        maxDepth: m._kn_get_max_depth(),
        frame: m._kn_get_frame(),
        debugLog: m._kn_get_debug_log ? window.UTF8ToString(m._kn_get_debug_log()) : null,
      };
    },
    isCRollback: () => _useCRollback,
  };

  // Global console helpers
  window.knSelfTest = () => window.NetplayLockstep?.selfTest?.() ?? 'not available';
  window.knRollbackStats = () => window.NetplayLockstep?.getRollbackStats?.() ?? 'not available';
})();
