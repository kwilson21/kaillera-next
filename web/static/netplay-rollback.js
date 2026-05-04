/**
 * kaillera-next — Rollback Netplay Engine (with lockstep stall fallback)
 *
 * Deterministic netplay for up to 4 players running EmulatorJS
 * (mupen64plus-next WASM core) in sync. All players run their own
 * emulator instance and exchange inputs each frame.
 *
 * The product-facing engine is Rollback: GGPO-style input prediction
 * with C-level replay (build/.../kn_rollback.c), exposed as the
 * "rollback" wire-protocol mode and as window.NetplayRollback.
 *
 * The classic lockstep stall path lives inside this file as the silent
 * fallback when the WASM core does not export kn_pre_tick (stock CDN
 * core or older builds). Mode dispatch above this layer treats the
 * whole engine as one unit; users never see a "Classic" option.
 *
 * The names "lockstep" / "lockstep-ready" / "_lockstepActive" /
 * "[lockstep]" log prefix appear throughout this file as implementation
 * vocabulary for strict input stalls (boot convergence, menu phase-lock
 * gate, the in-engine fallback path) and as stable protocol/log labels.
 * They are deliberately NOT renamed.
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
 *   2. Standard online cheats applied automatically via KNShared for
 *      vanilla SSB64 only (gated by ROM hash — Smash Remix and other
 *      mods are excluded to avoid RDRAM corruption from mismatched
 *      memory layouts).
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
 *   Two modes: Classic (lockstep stall) or Rollback (predict + replay).
 *   Rollback activates automatically when the WASM core exports kn_pre_tick.
 *
 *   CLASSIC (lockstep) — each tick at frame N:
 *     1. Apply pending resync state if buffered
 *     2. Proportional frame pacing check — skip ticks if ahead of slowest peer
 *     3. Read local input → 24-bit mask, send to all peers
 *     4. Compute applyFrame = N - DELAY_FRAMES
 *     5. Stall until all peers' input for applyFrame arrives (two-stage:
 *        3s wait, then resend request, then 5s hard timeout → inject zero)
 *     6. Write inputs to WASM, step one frame, feed audio
 *
 *   ROLLBACK — each tick at frame N:
 *     1-3. Same as Classic (pacing, read input, send to peers)
 *     4. Drain _pendingCInputs queue: WebRTC callbacks push remote inputs
 *        to a JS array; they are fed to the C engine (kn_feed_input) here
 *        at the tick boundary, guaranteeing a consistent input snapshot.
 *     5. kn_pre_tick(): C engine saves state to ring buffer, stores local
 *        input, predicts missing remote input (last-known). If a pending
 *        misprediction was detected by the drain above, restores state and
 *        replays through the same JS stepOneFrame path, optionally using a
 *        bounded mini-burst so catch-up can finish faster when budget allows.
 *        Returns 2 if catching up (JS steps emulator), 0 for normal.
 *     6. Read inputs from C ring buffer via kn_get_input(), write to WASM
 *        via writeInputToMemory (same path as Classic)
 *     7. Step one frame via EJS runner, feed audio
 *     8. kn_post_tick(): advance C frame counter
 *     9. After replay catch-up completes, hash RDRAM and broadcast to
 *        peer for determinism verification (rb-check).
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
 * ── RNG State Handling (Smash Remix) ────────────────────────────────────
 *
 *   Live lockstep does not force-write Remix RNG fields every frame. Those
 *   addresses have proven version-sensitive, and the authoritative startup
 *   title capture keeps menu/CSS random selection in one shared state. On late
 *   join, the host still transfers current RNG state in the late-join-state
 *   message.
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
 *   Enabled by default (resyncEnabled flag). Star topology: host (slot 0) is the
 *   sync authority. Two hashing paths:
 *
 *   1. C-level (patched core): _kn_sync_hash() hashes game-specific
 *      RDRAM regions directly in C — fast and deterministic.
 *      Uses full _kn_sync_read/write for state transfer.
 *   2. JS fallback: FNV-1a hash of RDRAM via direct HEAPU8 access,
 *      falling back to getState() serialization.
 *
 *   Periodic hash broadcasts are disabled — AI DMA determinism +
 *   SoftFloat FPU makes steady-state gameplay deterministic. Resync is
 *   triggered by reconnect, mobile lifecycle, network-change, input-stall,
 *   boot-correction, peer-recovery, and explicit sync-request paths.
 *   When triggered, the host responds with compressed
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
 *   Pacing state (phantom flags, advance timestamps) is reset at all
 *   late-join resume paths — the host's late-join-ready handler, the
 *   non-host peers' late-join-resume DC handler, and the safety timeout.
 *   Without this reset, the 5-15s pause triggers phantom detection.
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
 *     3. Host captures + compresses state, pauses all players' tick loops
 *        (late-join-pause via DC), sends "late-join-state" with the current
 *        frame number, effective delay, and rollback transport mode
 *     4. Joiner loads state via kn_load_state_immediate, syncs C rollback
 *        engine frame counter (kn_set_frame), pre-fills delay gap with
 *        zero input, starts lockstep tick loop
 *     5. Joiner sends "late-join-ready" — host resumes all tick loops,
 *        resets pacing/phantom state (wall-clock time advances during
 *        the pause but tick loops are frozen — without reset, phantom
 *        detection would immediately exclude the joiner)
 *     6. Late joiners skip boot convergence (300-frame lockstep window)
 *        and enter rollback prediction mode immediately — they loaded
 *        the host's state directly, no boot race to protect against
 *   The late-joiner always initiates WebRTC connections to avoid the
 *   offer-before-listener race condition. Safety timeout (15s) resumes
 *   all players if the joiner fails to send late-join-ready.
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
 *   window.KNDiag.eventLog: frame-level diagnostic events (cleared each tick,
 *     only active when window._KN_DIAG is set)
 *   debug-sync / debug-logs: Socket.IO events for remote log upload to server
 *   Sync hash/resync operations run in a Web Worker to avoid blocking
 *   the main thread during compression/decompression.
 */

(function () {
  'use strict';

  const _urlParams = new URLSearchParams(window.location.search);
  const _knPerfLight = _urlParams.get('knperf') === 'light';
  const _knTraceDiagnostics = _urlParams.get('kntrace') === '1';
  const _knDeepDiagnostics = _urlParams.get('kndiag') === 'deep' || _urlParams.get('desync') === 'deep';
  const _knRuntimeDiagnostics = !_knPerfLight && _knDeepDiagnostics;
  // Screenshots are default-on (cheap: ~5KB JPEG every 5s/player) so the
  // admin panel always has visual ground truth for desync triage. Opt out
  // with ?screenshots=off; ?knperf=light also disables them. Independent
  // from the heavier _knRuntimeDiagnostics gate.
  const _knScreenshots = !_knPerfLight && _urlParams.get('screenshots') !== 'off';
  const _knLiveFlush = _urlParams.get('knflush') === 'live';
  window._knPerfLight = _knPerfLight;

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
  const DEFAULT_DELAY_FRAMES = 2;
  let DELAY_FRAMES = DEFAULT_DELAY_FRAMES;
  // True-rollback model: DELAY_FRAMES is just the remote-input prediction
  // window (jitter buffer). It does NOT govern local input lag any more,
  // so we can safely sit at 1 frame. Legacy "lockstep with rollback recovery"
  // model (?trueRollback=0 / pre-update peers) still observes this clamp,
  // but ROLLBACK_MIN_DELAY_FRAMES=1 is fine there too because the delay
  // negotiation falls through to the auto-formula's natural floor (~RTT/2 + jitter
  // for legacy, just jitter for true-rollback).
  const ROLLBACK_MIN_DELAY_FRAMES = 1;
  const ROLLBACK_MAX_DELAY_FRAMES = 7;
  const clampRollbackDelay = (value, fallback = ROLLBACK_MIN_DELAY_FRAMES) => {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed <= 0) return fallback;
    return Math.min(ROLLBACK_MAX_DELAY_FRAMES, Math.max(ROLLBACK_MIN_DELAY_FRAMES, parsed));
  };

  let _onExtraDataChannel = null;
  let _onUnhandledMessage = null;

  let _rttSamples = [];
  let _rttMedian = 0; // stored for rollback-aware delay recalculation at game start
  // _rttJitter removed — IQR-based jitter computed inline where needed
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
    if (peer._rttPingCount >= 22) {
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
        _rttMedian = median;
        // Lockstep default — rollback-aware recalculation happens at game start
        const delay = Math.min(9, Math.max(2, Math.ceil(median / 16.67)));
        _rttComplete = true;
        if (window.setAutoDelay) window.setAutoDelay(delay);
        _syncLog(`RTT median: ${median.toFixed(1)}ms samples: ${_rttSamples.length} -> auto delay: ${delay}`);
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
    peer._rttPingCount++;
    // Discard first 2 samples (WebRTC connection warmup / ICE overhead)
    if (peer._rttPingCount > 2) {
      peer._rttSamples.push(rtt);
    }
    sendNextPing(peer);
    if (_rttComplete && _phase >= PHASE_LOCKSTEP_READY) {
      broadcastLockstepReady();
      checkAllLockstepReady();
    }
  };

  const _localRollbackCaps = () => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    const trueRollbackCore = !!mod?._kn_get_true_rollback_capability && mod._kn_get_true_rollback_capability() === 1;
    const stateBackend =
      RB_ROLLBACK_STATE_BACKEND === 'split-rdram' && !!mod?._kn_set_state_backend ? 'split-rdram' : 'retro';
    return {
      rdpReplaySkip: !!mod?._kn_set_skip_rdp_replay && RB_SKIP_RDP_DURING_REPLAY,
      trueRollback: trueRollbackCore && RB_TRUE_ROLLBACK,
      stateBackend,
    };
  };

  const broadcastLockstepReady = () => {
    const dl = window.getDelayPreference ? window.getDelayPreference() : DEFAULT_DELAY_FRAMES;
    const caps = _localRollbackCaps();
    for (const p of Object.values(_peers)) {
      if (p.dc && p.dc.readyState === 'open' && p.slot !== null && p.slot !== undefined) {
        try {
          p.dc.send(JSON.stringify({ type: 'lockstep-ready', delay: dl, caps }));
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
  // I1: _rbPendingInit fallback deadline (MF2). If the host's
  // rb-delay DC broadcast never arrives, the guest falls back to a
  // locally-computed delay instead of freezing forever.
  const RB_INIT_TIMEOUT_MS = 3000;
  // I1 (MF5): late-join state transfer + decompression deadline.
  // Host pauses tick loop for up to LATE_JOIN_TIMEOUT_MS waiting for
  // joiner's ready signal; joiner wraps decompression in a
  // Promise.race to prevent unbounded worker hangs.
  const LATE_JOIN_TIMEOUT_MS = 15000;
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

  // -- External modules (grabbed once, used by local refs) ---------------------
  const _audio = window.KNAudio;
  const _diag = window.KNDiag;

  // -- State -----------------------------------------------------------------

  let socket = null;
  let _playerSlot = -1; // 0-3 for players, null for spectators
  let _isSpectator = false;
  let _useCRollback = false; // true when C-level rollback engine is active
  let _predictionsPaused = false; // demo-only: pause C prediction generation without tearing down rollback state
  let _demoMode = false; // demo-only: disable C pacing-throttle so the engine runs full speed, predicts, and rolls back visibly under simulated lag (instead of pacing to match the slow peer, which feels identical to lockstep)
  let _rbReplayLogged = false; // prevents log spam during amortized replay
  let _rbVisualFreezeOverlay = null; // canvas copy shown while replay frames render underneath
  let _rbVisualFreezeCtx = null;
  let _rbVisualSnapshotCanvas = null; // last live pre-rollback frame, captured before state restore
  let _rbVisualSnapshotCtx = null;
  let _rbVisualCandidateCanvas = null;
  let _rbVisualCandidateCtx = null;
  let _rbVisualProbeCanvas = null;
  let _rbVisualProbeCtx = null;
  let _rbVisualSnapshotFrame = -1;
  let _rbVisualFreezeActive = false;
  let _rbVisualFreezeHideTimer = 0;
  let _rbVisualFreezeFailures = 0;
  let _rbVisualFreezeSerial = 0;
  let _rbMotionSmoothingRaf = 0;
  let _rbMotionSmoothingSerial = 0;
  let _rbMotionSmoothingDx = 0;
  let _rbMotionSmoothingDy = 0;
  let _rbCanvasNudgeRaf = 0;
  let _rbCanvasNudgeTimer = 0;
  let _rbCanvasNudgeSerial = 0;
  let _rbCanvasNudgeDx = 0;
  let _rbCanvasNudgeDy = 0;
  let _rbCanvasNudgeTarget = null;
  let _rbCanvasNudgePrevTransform = '';
  let _rbCanvasNudgePrevTransformOrigin = '';
  let _rbCanvasNudgePrevWillChange = '';
  const _rbReplayMotionDiag = {
    cogSamples: [],
    oracle: [],
    transforms: [],
    lifecycle: [],
  };
  let _rbShadowWorker = null;
  let _rbShadowOverlay = null;
  // Sibling 2D canvas used for the framebuffer-blit path (#7). Worker
  // posts raw RGBA bytes; main paints them here. Distinct from the
  // OffscreenCanvas-transferred shadow canvas because once an
  // OffscreenCanvas is transferred we can't call getContext on it
  // from the main thread.
  let _rbShadowFrameCanvas = null;
  // Worker-frame center-of-brightness tracker. Each 'frame' message
  // we compute COG (cogX, cogY in pixel units) and append to
  // _knWorkerCog.history. _knWorkerCog.baseline is set on rollback
  // start and is the COG at frame 0 of the current rollback;
  // motion delta during the rollback = current COG − baseline,
  // expressed in screen-pixel units after scaling. This drives a
  // CSS translate on the snapshot-freeze overlay so the
  // (live-canvas-style) snapshot moves in sync with what the worker
  // predicts.
  const _knWorkerCog = {
    history: [], // { frame, cogX, cogY, t }
    baseline: null, // { cogX, cogY, frame }
    lastFrame: -1,
  };
  let _rbShadowTransferred = false;
  let _rbShadowBooting = false;
  let _rbShadowReady = false;
  let _rbShadowFailed = false;
  let _rbShadowVisible = false;
  let _rbShadowStatusSab = null;
  let _rbShadowStatus = null;
  let _rbShadowBootPromise = null;
  let _rbShadowStepSeq = 0;
  let _rbShadowInFlight = 0;
  let _rbShadowLastInputs = null;
  let _rbShadowLastResizeKey = '';
  let _rbShadowLastResyncAt = 0;
  let _rbShadowResyncTimer = 0;
  let _rbShadowHideTimer = 0;
  let _rbShadowHoldUntil = 0;
  let _rbShadowPendingResyncReason = '';
  let _rbShadowNeedsFreshPaint = true;
  let _rbShadowLastGoodPaintAt = 0;
  let _rbShadowLastPaintFrame = -1;
  let _rbShadowLastLooksBlack = false;
  let _rbShadowPersistentActive = false;
  let _rbShadowRafId = 0;
  let _rbShadowRafInFlight = false;
  let _rbShadowPrewarm = null;
  let _rbShadowVisibleStepBase = 0;
  let _rbShadowVisibleCommits = 0;
  let _rbRdpSkipActive = false;
  let _rbFullHeadlessActive = false;
  const RB_VISUAL_SNAPSHOT_MAX_AGE_FRAMES = 30;
  const RB_VISUAL_SNAPSHOT_INTERVAL_FRAMES = 4;
  // Motion smoothing tuning: prior values (3 px / deadzone 2200) were
  // above the perceptual wobble threshold even when the user wasn't
  // actively pressing the stick (controller noise / digital N64 sticks
  // hovering above the deadzone). 1.5 px / deadzone 8000 keeps the
  // motion subtle enough to mask the static-frame feel without
  // reading as "the screen is wobbling." Used by both the legacy
  // stick-driven path (#4) and the RDRAM-velocity path (#1) below
  // as the cap on translate magnitude.
  const RB_MOTION_SMOOTHING_MAX_PX = 1.5;
  const RB_MOTION_SMOOTHING_BASE_SCALE = 1.012;
  const RB_MOTION_SMOOTHING_DEADZONE = 8000;
  const RB_SHADOW_STATUS = {
    BOOTING: 1,
    READY: 2,
    FAILED: 3,
  };
  const RB_SHADOW_STATUS_IDX = {
    status: 0,
    frame: 1,
    steps: 2,
    errors: 3,
    resyncs: 4,
  };
  const RB_SHADOW_MAX_IN_FLIGHT = 2;
  const RB_SHADOW_MAX_BATCH_FRAMES = 8;
  const RB_SHADOW_PREWARM_BUDGET_MS = (() => {
    try {
      const raw = _urlParams.get('shadowPrewarmBudgetMs') ?? localStorage.getItem('kn-shadow-prewarm-budget-ms');
      const parsed = raw === null ? 6 : parseFloat(raw);
      if (!Number.isFinite(parsed)) return 6;
      return Math.max(1, Math.min(20, parsed));
    } catch (_) {
      return 6;
    }
  })();
  const RB_SHADOW_LEAD_FRAMES = (() => {
    try {
      const raw = _urlParams.get('shadowLead') ?? localStorage.getItem('kn-shadow-lead');
      const parsed = raw === null ? 0 : parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Math.min(8, parsed));
    } catch (_) {
      return 0;
    }
  })();
  const RB_SHADOW_REPLAY_LEAD_FRAMES = (() => {
    try {
      const raw = _urlParams.get('shadowReplayLead') ?? localStorage.getItem('kn-shadow-replay-lead');
      const parsed = raw === null ? 0 : parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Math.min(12, parsed));
    } catch (_) {
      return 0;
    }
  })();
  const RB_SHADOW_RESYNC_DELAY_MS = (() => {
    try {
      const raw = _urlParams.get('shadowResyncDelayMs') ?? localStorage.getItem('kn-shadow-resync-delay-ms');
      const parsed = raw === null ? 0 : parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Math.min(1000, parsed));
    } catch (_) {
      return 0;
    }
  })();
  const RB_SHADOW_RESYNC_MIN_MS = (() => {
    try {
      const raw = _urlParams.get('shadowResyncMinMs') ?? localStorage.getItem('kn-shadow-resync-min-ms');
      const parsed = raw === null ? 0 : parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Math.min(5000, parsed));
    } catch (_) {
      return 0;
    }
  })();
  const RB_SHADOW_OVERLAY_HOLD_MS = (() => {
    try {
      const raw = _urlParams.get('shadowHoldMs') ?? localStorage.getItem('kn-shadow-hold-ms');
      const parsed = raw === null ? 35 : parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 35;
      return Math.max(0, Math.min(220, parsed));
    } catch (_) {
      return 35;
    }
  })();
  const RB_SHADOW_OVERLAY_FADE_MS = (() => {
    try {
      const raw = _urlParams.get('shadowFadeMs') ?? localStorage.getItem('kn-shadow-fade-ms');
      const parsed = raw === null ? 0 : parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 0;
      return Math.max(0, Math.min(160, parsed));
    } catch (_) {
      return 0;
    }
  })();
  const RB_SHADOW_OVERLAY_OPACITY = (() => {
    try {
      const raw = _urlParams.get('shadowOpacity') ?? localStorage.getItem('kn-shadow-opacity');
      // 0.86 is the empirical safe ceiling. Higher values surface the
      // worker's occasional black/transitional frames (especially the
      // first stepOnce after a resync, when RDRAM is fresh but the
      // framebuffer hasn't been regenerated yet). Lower bleed-through
      // covers those bad frames at the cost of letting the rewinding
      // live canvas tinge through during replay. Tried 0.97; black
      // flicker visible. If you want zero bleed-through, the live
      // canvas needs to be hidden under the overlay (RB_SHADOW_HIDE_LIVE
      // below), not the opacity bumped further.
      const parsed = raw === null ? 0.86 : parseFloat(raw);
      if (!Number.isFinite(parsed)) return 0.86;
      return Math.max(0.45, Math.min(1, parsed));
    } catch (_) {
      return 0.86;
    }
  })();
  // Stop-Showing-Rewound: hide the live ejs_canvas while the shadow
  // overlay is up so there's literally no rewind frame underneath to
  // bleed through. The shadow overlay (z-index:55) becomes the only
  // visible canvas during the replay window. Restored on hide.
  //
  // Tradeoff: when overlay shows a bad worker frame, the user sees a
  // pure worker frame with no live-canvas bleed-through fallback.
  // Worse than the opacity bleed for transitional frames; better than
  // the opacity bleed for steady-state. Default ON; opt-out via
  // ?shadowHideLive=0.
  const RB_SHADOW_HIDE_LIVE = (() => {
    try {
      const raw = _urlParams.get('shadowHideLive') ?? localStorage.getItem('kn-shadow-hide-live');
      if (raw === '0') return false;
      if (raw === '1') return true;
    } catch (_) {}
    return true;
  })();
  // Legacy worker self-pump experiment. The default smooth path is the
  // main-rAF-driven pump below; this flag only keeps the old setTimeout
  // pump available for explicit A/B via ?shadowPump=legacy.
  const RB_SHADOW_PUMP = (() => {
    try {
      const raw = _urlParams.get('shadowPump') ?? localStorage.getItem('kn-shadow-pump');
      if (raw === 'legacy') return true;
    } catch (_) {}
    return false;
  })();
  const RB_SHADOW_PAINT_GATE = (() => {
    try {
      const raw = _urlParams.get('shadowPaintGate') ?? localStorage.getItem('kn-shadow-paint-gate');
      if (raw === '0') return false;
      if (raw === '1') return true;
    } catch (_) {
      return true;
    }
    return true;
  })();
  const RB_SHADOW_PERSISTENT = (() => {
    try {
      const raw = _urlParams.get('shadowPersistent') ?? localStorage.getItem('kn-shadow-persistent');
      if (raw === '0') return false;
      if (raw === '1') return true;
    } catch (_) {}
    return false;
  })();
  const RB_REPLAY_BURST_MAX_FRAMES = (() => {
    try {
      const raw = _urlParams.get('replayBurst') ?? localStorage.getItem('kn-replay-burst');
      const parsed = raw === null ? 4 : parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 4;
      return Math.max(1, Math.min(8, parsed));
    } catch (_) {
      return 4;
    }
  })();
  const RB_REPLAY_BURST_BUDGET_MS = (() => {
    try {
      const raw = _urlParams.get('replayBurstBudgetMs') ?? localStorage.getItem('kn-replay-burst-budget-ms');
      const parsed = raw === null ? 10 : parseFloat(raw);
      if (!Number.isFinite(parsed)) return 10;
      return Math.max(1, Math.min(16, parsed));
    } catch (_) {
      return 10;
    }
  })();
  const RB_SKIP_RDP_DURING_REPLAY = (() => {
    try {
      const raw = _urlParams.get('replaySkipRdp') ?? localStorage.getItem('kn-replay-skip-rdp');
      if (raw === '0') return false;
      if (raw === '1') return true;
    } catch (_) {}
    return true;
  })();
  const RB_FULL_HEADLESS_DURING_REPLAY = (() => {
    try {
      const raw = _urlParams.get('fullHeadless') ?? localStorage.getItem('kn-full-headless');
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch (_) {}
    return true;
  })();
  // True rollback netcode: apply LOCAL input at the current frame for instant
  // input feel; predict + apply REMOTE inputs at applyFrame as before.
  // Without this flag, all slots (including local) are applied at applyFrame —
  // "lockstep with rollback recovery" — and local input feels like RTT-scaled
  // lockstep delay instead of real rollback netcode.
  // Both peers must agree (kn_get_true_rollback_capability + RB_TRUE_ROLLBACK)
  // before rollback can start; mismatch falls back to legacy behavior.
  const RB_TRUE_ROLLBACK = (() => {
    try {
      const raw = _urlParams.get('trueRollback') ?? localStorage.getItem('kn-true-rollback');
      if (raw === '0') return false;
      if (raw === '1') return true;
    } catch (_) {}
    return true;
  })();
  const RB_ROLLBACK_STATE_BACKEND = (() => {
    try {
      const raw = _urlParams.get('rollbackStateBackend') ?? localStorage.getItem('kn-rollback-state-backend');
      if (raw === 'split-rdram' || raw === 'splitRdram' || raw === '1') return 'split-rdram';
      if (raw === 'retro' || raw === 'retro_serialize' || raw === '0') return 'retro';
    } catch (_) {}
    return 'split-rdram';
  })();
  const RB_VISUAL_FADE_DURING_REPLAY = (() => {
    try {
      const raw = _urlParams.get('replayVisualFadeDuring') ?? localStorage.getItem('kn-replay-visual-fade-during');
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch (_) {}
    return false;
  })();
  // Cross-fade on hide for the opt-in visual-freeze overlay. The
  // freeze itself now defaults off because play testing showed the
  // raw replay path feels better than a static snapshot pause.
  const RB_VISUAL_FADE_MS = (() => {
    try {
      const raw = _urlParams.get('replayVisualFadeMs') ?? localStorage.getItem('kn-replay-visual-fade-ms');
      const parsed = raw === null ? 24 : parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 24;
      return Math.max(0, Math.min(160, parsed));
    } catch (_) {
      return 24;
    }
  })();
  const _rbVisualFreezeEnabled = (() => {
    try {
      const raw = _urlParams.get('replayVisualFreeze') ?? localStorage.getItem('kn-replay-visual-freeze');
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch (_) {}
    return false;
  })();
  // Tail fade — start fading the freeze overlay out a few ms BEFORE
  // replay completes so by the time the live canvas catches up there
  // is already a partial blend instead of an abrupt cut. Triggered
  // late enough in the replay window that the live canvas is already
  // close to its post-replay state, so the fade overlap reads as
  // motion blur rather than the "scrub" artifact that fading from
  // the start produces. 0 = disabled.
  const RB_REPLAY_TAIL_FADE_MS = (() => {
    try {
      const raw = _urlParams.get('replayTailFadeMs') ?? localStorage.getItem('kn-replay-tail-fade-ms');
      const parsed = raw === null ? 8 : parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 8;
      return Math.max(0, Math.min(40, parsed));
    } catch (_) {
      return 8;
    }
  })();
  // Subtle "micro-zoom" on the freeze overlay during display: animate
  // scale(1.0) → scale(1.008) over the freeze duration so the eye
  // registers continuous animation instead of a paused frame. 0.8 %
  // is below most viewers' perception threshold for "the screen is
  // zooming," but enough to break the static-frame feel that the
  // pure snapshot-freeze (with motion smoothing off) produces. Pure
  // CSS transition, no input dependency, no per-rollback variance —
  // can't desync from on-screen motion the way the stick-driven
  // motion nudge could.
  const RB_REPLAY_MICRO_ZOOM = (() => {
    try {
      const raw = _urlParams.get('replayMicroZoom') ?? localStorage.getItem('kn-replay-micro-zoom');
      if (raw === '0') return false;
      if (raw === '1') return true;
    } catch (_) {}
    // Default OFF when motion smoothing is off — the cross-fade at hide
    // does the perceptual work, and a scale animation on a static
    // snapshot is itself "fake motion" the user explicitly rejected.
    return false;
  })();
  const RB_REPLAY_MICRO_ZOOM_PCT = (() => {
    try {
      const raw = _urlParams.get('replayMicroZoomPct') ?? localStorage.getItem('kn-replay-micro-zoom-pct');
      const parsed = raw === null ? 0.8 : parseFloat(raw);
      if (!Number.isFinite(parsed)) return 0.8;
      return Math.max(0, Math.min(3, parsed));
    } catch (_) {
      return 0.8;
    }
  })();
  // Minimum rollback depth before the snapshot-freeze fallback fires.
  // Default 3 — depth 1-2 rollbacks (≤32 ms scrub at 60 Hz) read as a
  // tiny stutter and the freeze overlay actively makes them feel
  // longer. Set to 0 to freeze every rollback (legacy behavior).
  const RB_VISUAL_FREEZE_MIN_DEPTH = (() => {
    try {
      const raw =
        _urlParams.get('replayVisualFreezeMinDepth') ?? localStorage.getItem('kn-replay-visual-freeze-min-depth');
      const parsed = raw === null ? 3 : parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 3;
      return Math.max(0, Math.min(8, parsed));
    } catch (_) {
      return 3;
    }
  })();
  // Motion smoothing stays opt-in. The stick, canvas-velocity, RDRAM
  // velocity, and worker-COG variants all translate a static snapshot
  // during the ~30 ms replay window, and each proxy has diverged from
  // the scene motion players perceive during actual matches.
  // Default OFF — measured headless oracle output stayed <= 0.07 px in
  // 50 windows over 25 s of in-match testing with random P1 input, vs.
  // ~1-3 px of actual scene-motion-during-replay we'd need to bridge.
  // Three iterations (stick / RDRAM-velocity / worker-COG-oracle) all
  // produced their own perceptual artifacts (wobble / flicker / twitch)
  // because no motion source on a static snapshot can match real scene
  // motion within the ~30 ms freeze. The cross-fade at hide
  // (RB_VISUAL_FADE_MS) is the better mitigation — it lets the
  // discontinuity read as motion blur rather than a snap. Re-enable for
  // A/B via ?replayMotionSmoothing=1. In this pass, worker-oracle
  // diagnostics also showed it usually degenerated to generic canvas
  // COG when ANGRYLION framebuffer samples were black/unavailable, so
  // it was not a trustworthy motion source.
  const RB_REPLAY_MOTION_SMOOTHING = (() => {
    try {
      const raw = _urlParams.get('replayMotionSmoothing') ?? localStorage.getItem('kn-replay-motion-smoothing');
      if (raw === '0') return false;
      if (raw === '1') return true;
    } catch (_) {}
    return false;
  })();
  // Canvas-velocity-driven motion. When on, the motion path samples
  // the live canvas each frame, computes a center-of-brightness
  // motion vector, and uses that for the freeze translate instead of
  // stick magnitude. Generic — works for any ROM.
  const RB_REPLAY_RDRAM_MOTION = (() => {
    try {
      const raw = _urlParams.get('replayRdramMotion') ?? localStorage.getItem('kn-replay-rdram-motion');
      if (raw === '0') return false;
      if (raw === '1') return true;
    } catch (_) {}
    return false;
  })();
  // Show the worker's ANGRYLION-rendered framebuffer directly during
  // rollback. Default OFF because raw ANGRYLION output (320×240, no
  // shaders, no HD textures) looks visually different from the live
  // canvas's GLideN64-rendered output, and cutting between the two
  // creates a plugin-style flicker. Kept behind this flag for A/B and
  // future visual-style-matching work. When OFF, the worker still
  // runs and we use its frames as a motion oracle (see
  // _knWorkerCog and _shadowComputeWorkerMotion).
  const RB_SHADOW_FRAME_BLIT = (() => {
    try {
      const raw = _urlParams.get('shadowFrameBlit') ?? localStorage.getItem('kn-shadow-frame-blit');
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch (_) {}
    return false;
  })();
  // Use the worker's framebuffer as a "motion oracle" — sample its
  // center of brightness each tick, snapshot the baseline at
  // rollback start, and translate the snapshot-freeze overlay by the
  // worker's predicted motion delta during the freeze window.
  // The displayed pixels are the LIVE canvas (matching GLideN64
  // style), so there's no plugin mismatch; the worker only contributes
  // a 2D motion vector via its actual forward simulation.
  const RB_SHADOW_MOTION_ORACLE = (() => {
    try {
      const raw = _urlParams.get('shadowMotionOracle') ?? localStorage.getItem('kn-shadow-motion-oracle');
      if (raw === '0') return false;
      if (raw === '1') return true;
    } catch (_) {}
    return false;
  })();
  const RB_REPLAY_MOTION_DIAG = (() => {
    try {
      const raw =
        _urlParams.get('replayMotionDiag') ??
        _urlParams.get('rollbackMotionDiag') ??
        localStorage.getItem('kn-replay-motion-diag');
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch (_) {}
    return false;
  })();
  const RB_REPLAY_MOTION_SCALE = (() => {
    try {
      const raw = _urlParams.get('replayMotionScale') ?? localStorage.getItem('kn-replay-motion-scale');
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch (_) {}
    return false;
  })();
  const RB_REPLAY_MOTION_NUDGE = (() => {
    try {
      const raw =
        _urlParams.get('replayMotionNudge') ??
        _urlParams.get('replayCanvasNudge') ??
        localStorage.getItem('kn-replay-motion-nudge') ??
        localStorage.getItem('kn-replay-canvas-nudge');
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch (_) {}
    return false;
  })();
  const RB_REPLAY_MOTION_NUDGE_PX = (() => {
    try {
      const raw =
        _urlParams.get('replayMotionNudgePx') ??
        _urlParams.get('replayCanvasNudgePx') ??
        localStorage.getItem('kn-replay-motion-nudge-px') ??
        localStorage.getItem('kn-replay-canvas-nudge-px');
      const parsed = raw === null ? 2.25 : parseFloat(raw);
      if (!Number.isFinite(parsed)) return 2.25;
      return Math.max(0.25, Math.min(6, parsed));
    } catch (_) {
      return 2.25;
    }
  })();
  const RB_REPLAY_MOTION_NUDGE_MS = (() => {
    try {
      const raw =
        _urlParams.get('replayMotionNudgeMs') ??
        _urlParams.get('replayCanvasNudgeMs') ??
        localStorage.getItem('kn-replay-motion-nudge-ms') ??
        localStorage.getItem('kn-replay-canvas-nudge-ms');
      const parsed = raw === null ? 48 : parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return 48;
      return Math.max(16, Math.min(140, parsed));
    } catch (_) {
      return 48;
    }
  })();
  const RB_SHADOW_EMU = (() => {
    try {
      const raw = _urlParams.get('shadowEmu') ?? localStorage.getItem('kn-shadow-emu');
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch (_) {}
    return RB_SHADOW_FRAME_BLIT || RB_SHADOW_MOTION_ORACLE;
  })();
  let _hudRollbackEvents = 0; // monotonic counter
  let _hudRollbackDepthSamples = []; // rolling window of replay depths
  let _hudEventTimestamps = []; // timestamps for events-per-second window
  const HUD_DEPTH_WINDOW = 60;
  const HUD_EVENT_WINDOW_MS = 5000;
  let rb_numPlayers = 2; // set during C-rollback init
  let _rbRollbackMax = 12; // set during C-rollback init (ring buffer depth)
  let _rbInitFrame = -1; // frame at which C-rollback was initialized (convergence guard)
  let _rbConvergedLogged = false; // one-shot log when convergence window ends
  let _rbStallLogged = 0; // frame at which last RB-INPUT-STALL was logged (rate limit)
  let _rbInputPtr = 0; // WASM heap pointer for kn_get_input output (5 × int32)
  let _rbRegionsBufPtr = 0; // WASM heap pointer for state region hashes (32 × uint32)
  let _rbTaintBufPtr = 0; // WASM heap pointer for taint bitmap (128 × uint8)
  let _rbFatalBuf = 0; // RF7 (R3): WASM heap pointer for kn_get_fatal_stale out params (3 × int32)
  let _rbLiveMismatchBuf = 0; // 3 × uint32: frame, ring hash, live hash
  // Reference to startLockstep's tryInitRollback closure, captured at startup
  // so the GAMEPLAY→MENU shutdown can re-arm window._rbDeferredForGameplay
  // for the next match without needing a full engine restart.
  let _rbReinitClosure = null;
  // P2/T4: host-negotiated transport mode for rollback input packets.
  //  'reliable'   — use ordered lockstep DC (default, lockstep mode)
  //  'unreliable' — use unordered rollback-input DC (rollback mode, host's call)
  let _rbTransport = 'reliable';
  // P2: GGPO-style ack-driven redundancy — every packet carries ALL inputs
  // since the peer's last acknowledged frame. This guarantees no input is
  // permanently lost unless the connection drops entirely: even if 50
  // packets are lost in a row, the 51st carries the full unconfirmed
  // history. Capped at the rollback window depth (inputs older than that
  // can't be rolled back anyway). Fixed 8-frame window was too small —
  // match 002ad0f6 lost inputs at f=3441-3444 during a ~133ms WiFi drop
  // and never recovered them, causing permanent state divergence.
  const RB_REDUNDANCY_MAX = 30; // hard cap (rollback window + margin)
  const _rbLocalHistory = []; // {frame, buttons, lx, ly, cx, cy} — newest last
  // T4: transport stats — periodic flush counts packets and dedup rate.
  let _rbTransportPacketsSent = 0;
  let _rbTransportDupsRecv = 0;
  // DC health monitor: detect stuck unreliable SCTP streams and fall
  // back to the reliable primary DC. iOS Safari's usrsctp silently
  // stops delivering on unordered streams — and the bug is at the
  // association level, so DC rotation doesn't help. Immediate fallback
  // to the reliable DC keeps inputs flowing; GGPO redundancy covers
  // the brief gap.
  const _dcBufferStaleStreak = {}; // sid -> consecutive frames above threshold
  const DC_BUFFER_THRESHOLD = 2048; // bytes — ~100 input packets
  const DC_BUFFER_STALE_FRAMES = 10; // consecutive frames before fallback
  const DC_ACK_STALE_MS = 500; // ms without ack advance before fallback
  // JS-side input queue: WebRTC callbacks push here instead of calling
  // kn_feed_input directly. The queue is drained at the start of each
  // tick (before kn_pre_tick) so the C engine sees a consistent input
  // snapshot per frame — no race between async DC delivery and sync tick.
  const _pendingCInputs = []; // {slot, frame, buttons, lx, ly, cx, cy}
  // Module-scope sort comparator so the per-tick in-place sort doesn't
  // allocate a fresh closure each call. (frame, slot) ascending so
  // duplicates land adjacent and frames feed monotonically.
  const _pendingCInputsSortFn = (a, b) => a.frame - b.frame || a.slot - b.slot;
  const RDRAM_TAINT_BLOCKS = 128;
  const _clearPendingCInputs = (reason) => {
    if (_pendingCInputs.length === 0) return;
    const count = _pendingCInputs.length;
    _pendingCInputs.length = 0;
    if (typeof _syncLog === 'function') _syncLog(`C-INPUT-DRAIN reason=${reason} count=${count}`);
  };
  const _formatSlotMap = (obj) => {
    const keys = Object.keys(obj || {}).sort((a, b) => Number(a) - Number(b));
    return keys.length ? keys.map((k) => `${k}:${obj[k]}`).join(',') : 'none';
  };
  const _formatInputBrief = (input) =>
    input ? `${input.buttons || 0}/${input.lx || 0}/${input.ly || 0}/${input.cx || 0}/${input.cy || 0}` : '0/0/0/0/0';
  const _findRollbackVisualCanvas = () => {
    const visibleCanvas = (canvas) => {
      if (!canvas || canvas.id === 'kn-rollback-visual-freeze' || canvas.id === 'kn-rollback-shadow-emulator') {
        return false;
      }
      const rect = canvas.getBoundingClientRect?.();
      return !!rect && rect.width > 1 && rect.height > 1;
    };
    const inGame = document.getElementById('game')?.querySelectorAll?.('canvas') || [];
    for (const canvas of inGame) {
      if (visibleCanvas(canvas)) return canvas;
    }
    const canvases = document.querySelectorAll?.('canvas') || [];
    for (const canvas of canvases) {
      if (visibleCanvas(canvas)) return canvas;
    }
    return null;
  };

  const _snapshotLooksBlack = (ctx, width, height) => {
    if (!ctx || width <= 0 || height <= 0) return true;
    try {
      const sample = ctx.getImageData(0, 0, width, height).data;
      let bright = 0;
      let total = 0;
      const stride = Math.max(4, Math.floor(sample.length / 256) & ~3);
      for (let i = 0; i < sample.length; i += stride) {
        const r = sample[i] || 0;
        const g = sample[i + 1] || 0;
        const b = sample[i + 2] || 0;
        if (r + g + b > 24) bright++;
        total++;
      }
      return total > 0 && bright / total < 0.02;
    } catch (_) {
      return false;
    }
  };

  const _sourceLooksBlack = (source) => {
    if (!source) return true;
    try {
      if (!_rbVisualProbeCanvas) {
        _rbVisualProbeCanvas = document.createElement('canvas');
        _rbVisualProbeCanvas.width = 32;
        _rbVisualProbeCanvas.height = 18;
        _rbVisualProbeCtx = _rbVisualProbeCanvas.getContext('2d', { willReadFrequently: true });
      }
      if (!_rbVisualProbeCtx) return false;
      _rbVisualProbeCtx.clearRect(0, 0, _rbVisualProbeCanvas.width, _rbVisualProbeCanvas.height);
      _rbVisualProbeCtx.drawImage(source, 0, 0, _rbVisualProbeCanvas.width, _rbVisualProbeCanvas.height);
      return _snapshotLooksBlack(_rbVisualProbeCtx, _rbVisualProbeCanvas.width, _rbVisualProbeCanvas.height);
    } catch (_) {
      return false;
    }
  };

  // During replay the freeze overlay is the visible surface. Nudge that
  // snapshot, not the emulator canvas underneath, so state and layout stay
  // untouched while the player still sees local-input-responsive motion.
  const _cancelRollbackMotionSmoothing = () => {
    if (_rbMotionSmoothingRaf) {
      try {
        if (window.APISandbox?.nativeCancelRAF) {
          window.APISandbox.nativeCancelRAF(_rbMotionSmoothingRaf);
        } else if (window.cancelAnimationFrame) {
          window.cancelAnimationFrame(_rbMotionSmoothingRaf);
        } else {
          clearTimeout(_rbMotionSmoothingRaf);
        }
      } catch (_) {}
      _rbMotionSmoothingRaf = 0;
    }
  };

  const _requestRollbackMotionFrame = (cb) => {
    if (window.APISandbox?.nativeRAF) return window.APISandbox.nativeRAF(cb);
    if (window.requestAnimationFrame) return window.requestAnimationFrame.call(window, cb);
    return setTimeout(cb, 16);
  };

  const _getRollbackMotionStats = () => {
    if (!window._knReplayMotionSmoothingStats) {
      window._knReplayMotionSmoothingStats = { starts: 0, frames: 0, lastDx: 0, lastDy: 0 };
    }
    return window._knReplayMotionSmoothingStats;
  };

  const _pushReplayMotionDiag = (bucket, entry) => {
    if (!RB_REPLAY_MOTION_DIAG) return;
    const list = _rbReplayMotionDiag[bucket];
    if (!Array.isArray(list)) return;
    list.push({
      t: Number((performance.now?.() || 0).toFixed(2)),
      f: _frameNum | 0,
      ...entry,
    });
    while (list.length > 900) list.shift();
  };

  const _getRollbackMotionNudgeStats = () => {
    if (!window._knReplayMotionNudgeStats) {
      window._knReplayMotionNudgeStats = {
        starts: 0,
        frames: 0,
        overlayStarts: 0,
        liveStarts: 0,
        lastDx: 0,
        lastDy: 0,
      };
    }
    return window._knReplayMotionNudgeStats;
  };

  const _resetRollbackMotionSmoothing = () => {
    _cancelRollbackMotionSmoothing();
    _rbMotionSmoothingSerial++;
    _pushReplayMotionDiag('lifecycle', {
      event: 'reset',
      prevDx: Number(_rbMotionSmoothingDx.toFixed(3)),
      prevDy: Number(_rbMotionSmoothingDy.toFixed(3)),
      serial: _rbMotionSmoothingSerial,
      freezeActive: !!_rbVisualFreezeActive,
      shadowVisible: !!_rbShadowVisible,
    });
    _rbMotionSmoothingDx = 0;
    _rbMotionSmoothingDy = 0;
    const overlays = [_rbVisualFreezeOverlay, _rbShadowOverlay];
    for (const overlay of overlays) {
      if (!overlay?.style) continue;
      overlay.style.transform = 'none';
      overlay.style.transformOrigin = '50% 50%';
    }
  };

  const _readRollbackMotionInput = () => {
    try {
      return readLocalInput();
    } catch (_) {
      return _localInputs[_frameNum] || KNShared.ZERO_INPUT;
    }
  };

  // Track on-screen motion by sampling the live canvas's center of
  // brightness over recent frames. The shift between samples is a
  // crude proxy for "where the action is moving" — works without any
  // game-specific RDRAM offsets, so it generalizes to any ROM. Cheap
  // because we sample a tiny 32×24 downsample.
  const _kn_canvasMotion = {
    canvas: null,
    ctx: null,
    history: [], // recent (cogX, cogY, t) samples
    lastSampledFrame: -1,
    veloX: 0,
    veloY: 0,
  };
  const _sampleLiveCanvasMotion = () => {
    // Only sample every few frames — the readback is a sync GPU
    // operation (~3-4 ms in V8) and we don't need per-frame
    // resolution for a 30 ms freeze window. Sampling every 3 frames
    // gives 5 samples / 80 ms which is plenty for velocity estimation
    // while keeping per-tick cost amortized.
    if (_kn_canvasMotion.lastSampledFrame >= 0 && _frameNum - _kn_canvasMotion.lastSampledFrame < 3) return;
    _kn_canvasMotion.lastSampledFrame = _frameNum;
    const live = _findRollbackVisualCanvas?.();
    if (!live) return;
    if (!_kn_canvasMotion.canvas) {
      _kn_canvasMotion.canvas = document.createElement('canvas');
      _kn_canvasMotion.canvas.width = 32;
      _kn_canvasMotion.canvas.height = 24;
      _kn_canvasMotion.ctx = _kn_canvasMotion.canvas.getContext('2d', { willReadFrequently: true });
    }
    const ctx = _kn_canvasMotion.ctx;
    if (!ctx) return;
    try {
      ctx.drawImage(live, 0, 0, 32, 24);
      const data = ctx.getImageData(0, 0, 32, 24).data;
      let sumX = 0,
        sumY = 0,
        sumW = 0;
      for (let y = 0; y < 24; y++) {
        for (let x = 0; x < 32; x++) {
          const i = (y * 32 + x) * 4;
          const lum = data[i] + data[i + 1] + data[i + 2];
          sumX += x * lum;
          sumY += y * lum;
          sumW += lum;
        }
      }
      if (sumW > 0) {
        const cogX = sumX / sumW;
        const cogY = sumY / sumW;
        const now = performance.now();
        const hist = _kn_canvasMotion.history;
        hist.push({ x: cogX, y: cogY, t: now });
        if (hist.length > 6) hist.shift();
        if (hist.length >= 2) {
          // velocity from first → last in history (px per ms in 32×24 space)
          const first = hist[0];
          const last = hist[hist.length - 1];
          const dt = last.t - first.t;
          if (dt > 0) {
            _kn_canvasMotion.veloX = (last.x - first.x) / dt;
            _kn_canvasMotion.veloY = (last.y - first.y) / dt;
          }
        }
      }
    } catch (_) {}
  };
  // Worker-oracle motion: shadow worker is forward-simulating, so its
  // most recent framebuffer's center-of-brightness vs the baseline
  // (captured when the freeze started) tells us EXACTLY where the
  // game's "action center" has moved during the rollback window. Map
  // that directly to a translation on the live-canvas snapshot. No
  // stick-input guesswork, no live-canvas optical flow — just the
  // worker's actual prediction.
  const _workerOracleMotion = () => {
    if (!RB_SHADOW_MOTION_ORACLE) return null;
    const cog = _knWorkerCog;
    const baseline = cog.baseline;
    const last = cog.history[cog.history.length - 1];
    if (!baseline || !last) return null;
    if (last.frame === baseline.frame) return null;
    // Worker frame is 320×240 by default. The live canvas is whatever
    // resolution GLideN64 outputs at — typically also rendered at
    // 320×240 internal then upscaled by CSS. We translate by the
    // delta in the worker's pixel space, scaled by the live canvas's
    // CSS box / worker box ratio so the motion lines up with what
    // users see. The cap is RB_MOTION_SMOOTHING_MAX_PX so this can't
    // overshoot the live canvas's true motion by more than a few px.
    const live = _findRollbackVisualCanvas?.();
    const liveBox = live?.getBoundingClientRect?.();
    const liveW = liveBox?.width || 320;
    const liveH = liveBox?.height || 240;
    const workerW = 320;
    const workerH = 240;
    const scaleX = liveW / workerW;
    const scaleY = liveH / workerH;
    // Damp by 0.5 — the worker COG delta tends to overstate motion
    // because it includes character + background + UI, all weighted
    // by brightness. Half it so the snapshot moves visibly but not
    // disorientingly.
    const rawDx = (last.cogX - baseline.cogX) * scaleX * 0.5;
    const rawDy = (last.cogY - baseline.cogY) * scaleY * 0.5;
    const cap = RB_MOTION_SMOOTHING_MAX_PX;
    const clamp = (v) => Math.max(-cap, Math.min(cap, v));
    const dx = clamp(rawDx);
    const dy = clamp(rawDy);
    _pushReplayMotionDiag('oracle', {
      source: 'worker-oracle',
      baselineFrame: baseline.frame | 0,
      sampleFrame: last.frame | 0,
      baselineCogX: Number(baseline.cogX.toFixed(3)),
      baselineCogY: Number(baseline.cogY.toFixed(3)),
      cogX: Number(last.cogX.toFixed(3)),
      cogY: Number(last.cogY.toFixed(3)),
      rawDx: Number(rawDx.toFixed(3)),
      rawDy: Number(rawDy.toFixed(3)),
      dx: Number(dx.toFixed(3)),
      dy: Number(dy.toFixed(3)),
    });
    return {
      source: 'worker-oracle',
      dx,
      dy,
      scale: RB_REPLAY_MOTION_SCALE ? RB_MOTION_SMOOTHING_BASE_SCALE : 1,
    };
  };

  const _gameVelocityToRollbackMotion = () => {
    // Priority 1: worker oracle if a fresh COG history is available.
    // Falls through to the canvas-motion path on any failure (no
    // worker, no baseline yet, no recent samples).
    const oracle = _workerOracleMotion();
    if (oracle) return oracle;
    if (!RB_REPLAY_RDRAM_MOTION) return null;
    const cm = _kn_canvasMotion;
    if (cm.history.length < 2) return null;
    // velocity is in (32×24) units per ms — scale to pixels for the
    // freeze duration (~30 ms). Cap at RB_MOTION_SMOOTHING_MAX_PX so
    // it can't wobble more than the legacy nudge.
    const dwellMs = 30;
    const downsampleScaleX = 32; // 1 cog pixel ≈ this many overlay px
    const downsampleScaleY = 24;
    const dx = cm.veloX * dwellMs * downsampleScaleX * 0.05;
    const dy = cm.veloY * dwellMs * downsampleScaleY * 0.05;
    const cap = RB_MOTION_SMOOTHING_MAX_PX;
    const clamp = (v) => Math.max(-cap, Math.min(cap, v));
    return {
      source: 'canvas-cog',
      dx: clamp(dx),
      dy: clamp(dy),
      scale: RB_REPLAY_MOTION_SCALE ? RB_MOTION_SMOOTHING_BASE_SCALE : 1,
    };
  };

  const _inputToRollbackMotion = (input) => {
    // Canvas-velocity-driven motion takes priority when enabled (see
    // _sampleLiveCanvasMotion). Falls back to stick-driven motion
    // (#4) when canvas sampling is disabled or hasn't built up
    // enough history yet.
    const rdramMotion = _gameVelocityToRollbackMotion();
    if (rdramMotion) return rdramMotion;
    const maxAxis = 32767;
    const leftMag = Math.hypot(input?.lx || 0, input?.ly || 0);
    const cMag = Math.hypot(input?.cx || 0, input?.cy || 0);
    const useC = leftMag < 2500 && cMag >= 2500;
    const ax = useC ? input?.cx || 0 : input?.lx || 0;
    const ay = useC ? input?.cy || 0 : input?.ly || 0;
    const mag = Math.hypot(ax, ay);
    const hasDirection = mag >= RB_MOTION_SMOOTHING_DEADZONE;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    return {
      source: 'stick',
      dx: hasDirection
        ? clamp((ax / maxAxis) * RB_MOTION_SMOOTHING_MAX_PX, -RB_MOTION_SMOOTHING_MAX_PX, RB_MOTION_SMOOTHING_MAX_PX)
        : 0,
      dy: hasDirection
        ? clamp((ay / maxAxis) * RB_MOTION_SMOOTHING_MAX_PX, -RB_MOTION_SMOOTHING_MAX_PX, RB_MOTION_SMOOTHING_MAX_PX)
        : 0,
      scale: RB_REPLAY_MOTION_SCALE ? RB_MOTION_SMOOTHING_BASE_SCALE : 1,
    };
  };

  const _applyRollbackMotionTransform = (overlay, motion) => {
    _rbMotionSmoothingDx = _rbMotionSmoothingDx * 0.45 + motion.dx * 0.55;
    _rbMotionSmoothingDy = _rbMotionSmoothingDy * 0.45 + motion.dy * 0.55;
    const dx = Math.abs(_rbMotionSmoothingDx) < 0.05 ? 0 : _rbMotionSmoothingDx;
    const dy = Math.abs(_rbMotionSmoothingDy) < 0.05 ? 0 : _rbMotionSmoothingDy;
    overlay.style.transformOrigin = '50% 50%';
    overlay.style.transform = `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) scale(${motion.scale.toFixed(3)})`;
    _pushReplayMotionDiag('transforms', {
      source: motion.source || 'unknown',
      targetDx: Number((motion.dx || 0).toFixed(3)),
      targetDy: Number((motion.dy || 0).toFixed(3)),
      dx: Number(dx.toFixed(3)),
      dy: Number(dy.toFixed(3)),
      overlay: overlay?.id || '',
      serial: overlay?.dataset?.serial || '',
    });
    const stats = _getRollbackMotionStats();
    stats.frames++;
    stats.lastDx = Number(dx.toFixed(2));
    stats.lastDy = Number(dy.toFixed(2));
  };

  const _startRollbackMotionSmoothing = (overlay, serial, options = {}) => {
    if ((!RB_REPLAY_MOTION_SMOOTHING && !options.force) || !overlay) return;
    _cancelRollbackMotionSmoothing();
    _rbMotionSmoothingSerial++;
    const motionSerial = _rbMotionSmoothingSerial;
    const stats = _getRollbackMotionStats();
    stats.starts++;
    if (options.force) _getRollbackMotionNudgeStats().overlayStarts++;
    const step = () => {
      const activeOverlay = overlay === _rbVisualFreezeOverlay || overlay === _rbShadowOverlay;
      if (
        !_rbVisualFreezeActive ||
        !activeOverlay ||
        overlay.dataset.serial !== String(serial) ||
        motionSerial !== _rbMotionSmoothingSerial
      ) {
        return;
      }
      _applyRollbackMotionTransform(overlay, _inputToRollbackMotion(_readRollbackMotionInput()));
      _rbMotionSmoothingRaf = _requestRollbackMotionFrame(step);
    };
    _applyRollbackMotionTransform(overlay, _inputToRollbackMotion(_readRollbackMotionInput()));
    _rbMotionSmoothingRaf = _requestRollbackMotionFrame(step);
  };

  const _cancelRollbackCanvasNudge = () => {
    if (_rbCanvasNudgeRaf) {
      try {
        if (window.APISandbox?.nativeCancelRAF) {
          window.APISandbox.nativeCancelRAF(_rbCanvasNudgeRaf);
        } else if (window.cancelAnimationFrame) {
          window.cancelAnimationFrame(_rbCanvasNudgeRaf);
        } else {
          clearTimeout(_rbCanvasNudgeRaf);
        }
      } catch (_) {}
      _rbCanvasNudgeRaf = 0;
    }
    if (_rbCanvasNudgeTimer) {
      clearTimeout(_rbCanvasNudgeTimer);
      _rbCanvasNudgeTimer = 0;
    }
  };

  const _resetRollbackCanvasNudge = () => {
    _cancelRollbackCanvasNudge();
    _rbCanvasNudgeSerial++;
    _rbCanvasNudgeDx = 0;
    _rbCanvasNudgeDy = 0;
    const target = _rbCanvasNudgeTarget;
    if (target?.style) {
      target.style.transform = _rbCanvasNudgePrevTransform || '';
      target.style.transformOrigin = _rbCanvasNudgePrevTransformOrigin || '';
      target.style.willChange = _rbCanvasNudgePrevWillChange || '';
    }
    _rbCanvasNudgeTarget = null;
    _rbCanvasNudgePrevTransform = '';
    _rbCanvasNudgePrevTransformOrigin = '';
    _rbCanvasNudgePrevWillChange = '';
  };

  const _inputToRollbackCanvasNudge = (input) => {
    const base = _inputToRollbackMotion(input);
    const ratio = RB_MOTION_SMOOTHING_MAX_PX > 0 ? RB_REPLAY_MOTION_NUDGE_PX / RB_MOTION_SMOOTHING_MAX_PX : 1;
    return {
      dx: base.dx * ratio,
      dy: base.dy * ratio,
      scale: RB_REPLAY_MOTION_SCALE && (base.dx || base.dy) ? 1.006 : 1,
    };
  };

  const _applyRollbackCanvasNudgeTransform = (target, motion) => {
    _rbCanvasNudgeDx = _rbCanvasNudgeDx * 0.35 + motion.dx * 0.65;
    _rbCanvasNudgeDy = _rbCanvasNudgeDy * 0.35 + motion.dy * 0.65;
    const dx = Math.abs(_rbCanvasNudgeDx) < 0.04 ? 0 : _rbCanvasNudgeDx;
    const dy = Math.abs(_rbCanvasNudgeDy) < 0.04 ? 0 : _rbCanvasNudgeDy;
    const base =
      _rbCanvasNudgePrevTransform && _rbCanvasNudgePrevTransform !== 'none' ? `${_rbCanvasNudgePrevTransform} ` : '';
    target.style.transformOrigin = '50% 50%';
    target.style.transform = `${base}translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0) scale(${motion.scale.toFixed(3)})`;
    const stats = _getRollbackMotionNudgeStats();
    stats.frames++;
    stats.lastDx = Number(dx.toFixed(2));
    stats.lastDy = Number(dy.toFixed(2));
  };

  const _startRollbackCanvasNudge = (input, depth = 0) => {
    if (!RB_REPLAY_MOTION_NUDGE) return false;
    const target = _findRollbackVisualCanvas();
    if (!target?.style) return false;
    if (target === _rbVisualFreezeOverlay || target === _rbShadowOverlay) return false;
    if (_rbCanvasNudgeTarget !== target) _resetRollbackCanvasNudge();
    if (!_rbCanvasNudgeTarget) {
      _rbCanvasNudgeTarget = target;
      _rbCanvasNudgePrevTransform = target.style.transform || '';
      _rbCanvasNudgePrevTransformOrigin = target.style.transformOrigin || '';
      _rbCanvasNudgePrevWillChange = target.style.willChange || '';
    }
    _cancelRollbackCanvasNudge();
    _rbCanvasNudgeSerial++;
    const nudgeSerial = _rbCanvasNudgeSerial;
    const holdMs = Math.max(RB_REPLAY_MOTION_NUDGE_MS, Math.min(120, 16 + (depth | 0) * 8));
    const stats = _getRollbackMotionNudgeStats();
    stats.starts++;
    stats.liveStarts++;
    target.style.willChange = 'transform';
    const step = () => {
      if (_rbCanvasNudgeTarget !== target || nudgeSerial !== _rbCanvasNudgeSerial) return;
      _applyRollbackCanvasNudgeTransform(target, _inputToRollbackCanvasNudge(_readRollbackMotionInput() || input));
      _rbCanvasNudgeRaf = _requestRollbackMotionFrame(step);
    };
    _applyRollbackCanvasNudgeTransform(target, _inputToRollbackCanvasNudge(input || _readRollbackMotionInput()));
    _rbCanvasNudgeRaf = _requestRollbackMotionFrame(step);
    _rbCanvasNudgeTimer = setTimeout(() => {
      if (_rbCanvasNudgeTarget === target && nudgeSerial === _rbCanvasNudgeSerial) _resetRollbackCanvasNudge();
    }, holdMs);
    return true;
  };

  const _getShadowStats = () => {
    if (!window._knShadowEmuStats) {
      window._knShadowEmuStats = {
        bootAttempts: 0,
        ready: 0,
        failures: 0,
        shows: 0,
        normalStepsSent: 0,
        runAheadSent: 0,
        leadStepsSent: 0,
        stepAcks: 0,
        droppedSteps: 0,
        lastLeadDelta: 0,
        resyncsSent: 0,
        resyncAcks: 0,
        hideRequests: 0,
        heldHides: 0,
        hideFades: 0,
        persistentShows: 0,
        persistentHideSkips: 0,
        coldShowsSkipped: 0,
        deferredResyncs: 0,
        freshShowsSkipped: 0,
        blackShowsSkipped: 0,
        blackStepAcks: 0,
        unknownPaintAcks: 0,
        pumpStarts: 0,
        pumpStops: 0,
        rafPumpStarts: 0,
        rafPumpStops: 0,
        rafStepsSent: 0,
        rafStepAcks: 0,
        workerLagged: 0,
        workerCommitsPerShow: 0,
        workerShowsWithCommits: 0,
        lastWorkerCommitsPerShow: 0,
        preWarmRequests: 0,
        preWarmAcksInBudget: 0,
        preWarmAcksLate: 0,
        preWarmBlack: 0,
        preWarmCanceled: 0,
        resyncViaSplit: 0,
        resyncViaRetro: 0,
        resyncSplitUnavailable: 0,
        resyncSplitRejected: 0,
        resyncPostMessageMs: 0,
        lastResyncPostMessageMs: 0,
        resyncLoadImmediateMs: 0,
        lastResyncLoadImmediateMs: 0,
        lastPumpUntil: -1,
        lastPaintMax: -1,
        lastFrame: -1,
        lastError: '',
        lastBootMs: 0,
      };
    }
    return window._knShadowEmuStats;
  };

  const _shadowStatsSnapshot = () => {
    const stats = { ..._getShadowStats() };
    stats.avgWorkerCommitsPerShow =
      stats.workerShowsWithCommits > 0 ? stats.workerCommitsPerShow / stats.workerShowsWithCommits : 0;
    stats.enabled = {
      shadowEmu: RB_SHADOW_EMU,
      shadowPaintGate: RB_SHADOW_PAINT_GATE,
      shadowPump: RB_SHADOW_PUMP ? 'legacy' : 'raf',
      rollbackStateBackend: RB_ROLLBACK_STATE_BACKEND,
      replayMotionNudge: RB_REPLAY_MOTION_NUDGE,
    };
    return stats;
  };

  const _shadowLog = (message) => {
    try {
      _syncLog(`SHADOW-EMU ${message}`);
    } catch (_) {
      console.log(`[lockstep] SHADOW-EMU ${message}`);
    }
  };

  const _shadowTransferBuffer = (bytes) => {
    if (!bytes) return null;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  };

  const _shadowRequestFrame = (cb) => {
    const raf = window.APISandbox?.nativeRAF || window.requestAnimationFrame;
    if (typeof raf === 'function') {
      try {
        return raf.call(window.APISandbox?.nativeRAF ? window.APISandbox : window, cb);
      } catch (_) {}
    }
    return setTimeout(() => cb(performance.now()), 16);
  };

  const _shadowCancelFrame = (id) => {
    if (!id) return;
    const cancel = window.APISandbox?.nativeCancelRAF || window.cancelAnimationFrame;
    try {
      if (typeof cancel === 'function')
        cancel.call(window.APISandbox?.nativeCancelRAF ? window.APISandbox : window, id);
      else clearTimeout(id);
    } catch (_) {
      clearTimeout(id);
    }
  };

  const _shadowCancelPrewarm = (countCancel = false) => {
    if (!_rbShadowPrewarm) return;
    if (_rbShadowPrewarm.timer) clearTimeout(_rbShadowPrewarm.timer);
    if (countCancel) _getShadowStats().preWarmCanceled++;
    _rbShadowPrewarm = null;
  };

  const _shadowFinishVisibleCommitWindow = () => {
    if (_rbShadowVisibleStepBase <= 0 && _rbShadowVisibleCommits <= 0) return;
    const stats = _getShadowStats();
    stats.lastWorkerCommitsPerShow = _rbShadowVisibleCommits;
    stats.workerCommitsPerShow += _rbShadowVisibleCommits;
    stats.workerShowsWithCommits++;
    _rbShadowVisibleStepBase = 0;
    _rbShadowVisibleCommits = 0;
  };

  const _shadowStopRafPump = (reason = '') => {
    if (_rbShadowRafId) {
      _shadowCancelFrame(_rbShadowRafId);
      _rbShadowRafId = 0;
    }
    if (_rbShadowRafInFlight) _rbShadowRafInFlight = false;
    const stats = _getShadowStats();
    if (reason) stats.rafPumpStops++;
  };

  const _shadowRafPumpTick = () => {
    _rbShadowRafId = 0;
    if (!_rbShadowVisible || !_rbShadowReady || !_rbShadowWorker || _rbShadowFailed) {
      _shadowStopRafPump();
      return;
    }
    if (_rbShadowRafInFlight) {
      _getShadowStats().workerLagged++;
      _rbShadowRafId = _shadowRequestFrame(_shadowRafPumpTick);
      return;
    }
    const workerFrame = _shadowReadWorkerFrame();
    const frame = Math.max(_frameNum | 0, workerFrame >= 0 ? workerFrame | 0 : _frameNum | 0);
    _rbShadowRafInFlight = true;
    if (!_shadowPostStep(frame, _rbShadowLastInputs || [], 'raf-pump', 1, true)) {
      _rbShadowRafInFlight = false;
    }
    _rbShadowRafId = _shadowRequestFrame(_shadowRafPumpTick);
  };

  const _shadowStartRafPump = (reason = 'show') => {
    if (!RB_SHADOW_EMU || !_rbShadowVisible || !_rbShadowReady || !_rbShadowWorker || _rbShadowFailed) return false;
    if (_rbShadowRafId) return true;
    _getShadowStats().rafPumpStarts++;
    _rbShadowRafId = _shadowRequestFrame(_shadowRafPumpTick);
    return true;
  };

  const _shadowDoHideOverlay = () => {
    if (_rbShadowHideTimer) {
      clearTimeout(_rbShadowHideTimer);
      _rbShadowHideTimer = 0;
    }
    _shadowCancelPrewarm(true);
    _shadowFinishVisibleCommitWindow();
    _shadowStopRafPump('hide');
    _shadowStopPump('hide');
    _rbShadowVisible = false;
    _rbShadowHoldUntil = 0;
    _resetRollbackMotionSmoothing();
    if (_rbShadowOverlay) {
      _rbShadowOverlay.style.transition = 'none';
      _rbShadowOverlay.style.opacity = '0';
      _rbShadowOverlay.style.visibility = 'hidden';
    }
    if (_rbShadowFrameCanvas) {
      _rbShadowFrameCanvas.style.transition = 'none';
      _rbShadowFrameCanvas.style.opacity = '0';
      _rbShadowFrameCanvas.style.display = 'none';
    }
    if (RB_SHADOW_HIDE_LIVE) _restoreLiveCanvasAfterOverlay();
    if (_rbShadowPendingResyncReason) {
      const reason = _rbShadowPendingResyncReason;
      _rbShadowPendingResyncReason = '';
      _shadowScheduleResync(reason);
    }
  };

  const _shadowBeginHideFade = () => {
    if (_rbShadowHideTimer) {
      clearTimeout(_rbShadowHideTimer);
      _rbShadowHideTimer = 0;
    }
    if (!_rbShadowOverlay || RB_SHADOW_OVERLAY_FADE_MS <= 0) {
      _shadowDoHideOverlay();
      return;
    }
    _getShadowStats().hideFades++;
    _rbShadowHoldUntil = performance.now() + RB_SHADOW_OVERLAY_FADE_MS;
    _rbShadowOverlay.style.transition = `opacity ${RB_SHADOW_OVERLAY_FADE_MS}ms linear`;
    _rbShadowOverlay.style.opacity = '0';
    _rbShadowHideTimer = setTimeout(_shadowDoHideOverlay, RB_SHADOW_OVERLAY_FADE_MS + 20);
  };

  const _shadowHideOverlay = (immediate = false) => {
    const stats = _getShadowStats();
    stats.hideRequests++;
    if (!immediate && RB_SHADOW_PERSISTENT && _rbShadowPersistentActive) {
      stats.persistentHideSkips++;
      return;
    }
    if (!_rbShadowVisible || !_rbShadowOverlay) {
      if (immediate) _shadowDoHideOverlay();
      return;
    }
    if (immediate || RB_SHADOW_OVERLAY_HOLD_MS <= 0) {
      _shadowDoHideOverlay();
      return;
    }
    const delay = Math.max(0, _rbShadowHoldUntil - performance.now());
    stats.heldHides++;
    if (_rbShadowHideTimer) clearTimeout(_rbShadowHideTimer);
    _rbShadowHideTimer = setTimeout(_shadowBeginHideFade, delay);
    _rbShadowOverlay.style.transition = 'none';
    _rbShadowOverlay.style.opacity = String(RB_SHADOW_OVERLAY_OPACITY);
    if (delay <= 0) _shadowBeginHideFade();
  };

  const _shadowIsOverlayCovering = () => {
    if (!_rbShadowOverlay || !_rbShadowVisible) return false;
    if (_rbShadowOverlay.style.visibility === 'hidden') return false;
    if (_rbShadowHideTimer && performance.now() >= _rbShadowHoldUntil) return false;
    return true;
  };

  const _shadowPaintGate = () => {
    if (!RB_SHADOW_PAINT_GATE) return '';
    if (_rbShadowNeedsFreshPaint) return 'fresh';
    if (_rbShadowLastLooksBlack) return 'black';
    if (_rbShadowLastPaintFrame < _frameNum - 1) return 'fresh';
    if (_rbShadowLastGoodPaintAt > 0 && performance.now() - _rbShadowLastGoodPaintAt > 750) return 'stale';
    return '';
  };

  const _shadowResetOverlayTimers = () => {
    if (_rbShadowHideTimer) {
      clearTimeout(_rbShadowHideTimer);
      _rbShadowHideTimer = 0;
    }
    _rbShadowHoldUntil = 0;
    _rbShadowPendingResyncReason = '';
  };

  const _shadowMarkNeedsFreshPaint = () => {
    _rbShadowNeedsFreshPaint = true;
    _rbShadowLastLooksBlack = false;
  };

  const _shadowStop = (reason = 'stop') => {
    if (_rbShadowResyncTimer) {
      clearTimeout(_rbShadowResyncTimer);
      _rbShadowResyncTimer = 0;
    }
    _shadowResetOverlayTimers();
    _shadowHideOverlay(true);
    if (_rbShadowWorker) {
      try {
        _rbShadowWorker.postMessage({ type: 'stop' });
      } catch (_) {}
      try {
        _rbShadowWorker.terminate();
      } catch (_) {}
    }
    if (_rbShadowOverlay?.parentNode) {
      try {
        _rbShadowOverlay.parentNode.removeChild(_rbShadowOverlay);
      } catch (_) {}
    }
    _rbShadowWorker = null;
    _rbShadowOverlay = null;
    _rbShadowTransferred = false;
    _rbShadowBooting = false;
    _rbShadowReady = false;
    _rbShadowFailed = false;
    _rbShadowStatusSab = null;
    _rbShadowStatus = null;
    _rbShadowBootPromise = null;
    _rbShadowInFlight = 0;
    _rbShadowLastInputs = null;
    _rbShadowLastResizeKey = '';
    _shadowCancelPrewarm(false);
    _shadowStopRafPump();
    _rbShadowRafInFlight = false;
    _rbShadowNeedsFreshPaint = true;
    _rbShadowLastGoodPaintAt = 0;
    _rbShadowLastPaintFrame = -1;
    _rbShadowLastLooksBlack = false;
    _rbShadowPersistentActive = false;
    _rbShadowVisibleStepBase = 0;
    _rbShadowVisibleCommits = 0;
    if (reason !== 'stop') _shadowLog(`stopped reason=${reason}`);
  };

  const _shadowDisable = (reason, error) => {
    const stats = _getShadowStats();
    stats.failures++;
    stats.lastError = `${reason}${error ? `: ${error?.message || error}` : ''}`;
    _shadowLog(`disabled reason=${stats.lastError}`);
    _shadowStop(`disabled:${reason}`);
    _rbShadowFailed = true;
  };

  // Stop-Showing-Rewound helpers. Hide the live ejs_canvas while the
  // shadow overlay is up so there is literally no rewinding live frame
  // to bleed through under the overlay. Restored on hide.
  //
  // Implementation: visibility:hidden (NOT display:none) so layout is
  // preserved — the canvas keeps its space, only its pixels are
  // suppressed. The shadow overlay is positioned over the canvas via
  // _shadowSyncOverlayGeometry which mirrors the canvas's bounding
  // rect, so the overlay continues to occupy the same on-screen area.
  //
  // Tradeoff under hide-live: when the overlay shows a transient/black
  // worker frame (e.g., the first stepOnce after a resync), there is
  // no bleed-through fallback so that bad frame is fully visible as a
  // brief flicker. The mode-switching alternative (bleed-through only
  // post-resync) tested *worse* — switching between "clean hide" and
  // "tingy bleed" mid-rollback-stream is more jarring than uniform
  // hide. If the flicker becomes noticeable, bump
  // RB_SHADOW_RESYNC_MIN_MS (?shadowResyncMinMs=2500 etc) to fire
  // resyncs less often, which directly reduces the bad-frame events.
  let _rbLiveCanvasHiddenSerial = 0;
  let _rbLiveCanvasPrevVisibility = '';
  const _hideLiveCanvasUnderOverlay = () => {
    const live = _findRollbackVisualCanvas?.();
    if (!live || !live.style) return;
    if (live.style.visibility === 'hidden') return;
    _rbLiveCanvasPrevVisibility = live.style.visibility || '';
    live.style.visibility = 'hidden';
    _rbLiveCanvasHiddenSerial++;
  };
  const _restoreLiveCanvasAfterOverlay = () => {
    const live = _findRollbackVisualCanvas?.();
    if (!live || !live.style) return;
    if (live.style.visibility !== 'hidden') return;
    live.style.visibility = _rbLiveCanvasPrevVisibility || '';
  };

  const _shadowEnsureOverlay = () => {
    if (_rbShadowOverlay) return _rbShadowOverlay;
    if (!document?.createElement) return null;
    const overlay = document.createElement('canvas');
    overlay.id = 'kn-rollback-shadow-emulator';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.style.cssText = [
      'position:fixed',
      'display:block',
      'visibility:hidden',
      'opacity:0',
      'pointer-events:none',
      'z-index:55',
      'margin:0',
      'padding:0',
      'border:0',
      'background:transparent',
      'image-rendering:pixelated',
      'image-rendering:crisp-edges',
      'will-change:opacity',
      'transform:translateZ(0)',
      'backface-visibility:hidden',
      'contain:strict',
    ].join(';');
    _rbShadowOverlay = overlay;
    return overlay;
  };

  const _shadowSyncOverlayGeometry = (source = null, rect = null) => {
    const overlay = _shadowEnsureOverlay();
    source = source || _findRollbackVisualCanvas();
    rect = rect || source?.getBoundingClientRect?.();
    if (!overlay || !source || !rect || rect.width <= 1 || rect.height <= 1) return null;
    const root = document.fullscreenElement || document.body || document.documentElement;
    if (root && overlay.parentNode !== root) root.appendChild(overlay);
    const scale = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const width = Math.max(1, source.width || Math.round(rect.width * scale));
    const height = Math.max(1, source.height || Math.round(rect.height * scale));
    if (!_rbShadowTransferred) {
      if (overlay.width !== width) overlay.width = width;
      if (overlay.height !== height) overlay.height = height;
    }
    overlay.style.left = `${Math.round(rect.left)}px`;
    overlay.style.top = `${Math.round(rect.top)}px`;
    overlay.style.width = `${Math.round(rect.width)}px`;
    overlay.style.height = `${Math.round(rect.height)}px`;
    // Mirror geometry onto the 2D framebuffer-blit overlay so it
    // overlays the live canvas at the same screen rect.
    if (_rbShadowFrameCanvas) {
      _rbShadowFrameCanvas.style.left = `${Math.round(rect.left)}px`;
      _rbShadowFrameCanvas.style.top = `${Math.round(rect.top)}px`;
      _rbShadowFrameCanvas.style.width = `${Math.round(rect.width)}px`;
      _rbShadowFrameCanvas.style.height = `${Math.round(rect.height)}px`;
    }
    const key = `${width}x${height}`;
    if (_rbShadowWorker && key !== _rbShadowLastResizeKey) {
      _rbShadowLastResizeKey = key;
      try {
        _rbShadowWorker.postMessage({ type: 'resize', width, height });
      } catch (_) {}
    }
    return { overlay, width, height };
  };

  const _shadowReadRomBytes = () => {
    const ejs = window.EJS_emulator;
    const gm = ejs?.gameManager;
    const fs = gm?.FS;
    if (!fs?.readFile) return null;
    const fileName = ejs?.fileName || gm?.EJS?.fileName;
    if (!fileName) return null;
    const path = String(fileName).startsWith('/') ? String(fileName) : `/${fileName}`;
    try {
      const bytes = fs.readFile(path);
      return bytes?.byteLength ? new Uint8Array(bytes) : null;
    } catch (e) {
      _shadowLog(`rom-read failed path=${path} ${e?.message || e}`);
      return null;
    }
  };

  const _shadowReadStateBytes = () => {
    const gm = window.EJS_emulator?.gameManager;
    if (!gm?.getState) return null;
    try {
      const bytes = gm.getState();
      return bytes?.byteLength ? new Uint8Array(bytes) : null;
    } catch (e) {
      _shadowLog(`state-read failed ${e?.message || e}`);
      return null;
    }
  };

  const _shadowReadSplitStateBytes = (frame = _frameNum) => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (RB_ROLLBACK_STATE_BACKEND !== 'split-rdram') return null;
    if (!mod?._kn_get_state_backend || mod._kn_get_state_backend() !== 1) return null;
    if (!mod?._kn_get_split_state_for_shadow || !mod?._malloc || !mod?._free || !mod.HEAPU8 || !mod.HEAPU32) {
      return null;
    }
    const ptr = mod._malloc(9 * 4);
    if (!ptr) return null;
    try {
      const n = mod._kn_get_split_state_for_shadow(frame | 0, ptr, 9);
      if (n < 9) return null;
      const out = new Uint32Array(mod.HEAPU32.buffer, ptr, 9);
      const rdramPtr = out[0] >>> 0;
      const rdramBytes = out[1] >>> 0;
      const cpuPtr = out[2] >>> 0;
      const cpuBytes = out[3] >>> 0;
      const hiddenPtr = out[4] >>> 0;
      const hiddenBytes = out[5] >>> 0;
      const hlePtr = out[6] >>> 0;
      const hleBytes = out[7] >>> 0;
      const snapshotFrame = out[8] | 0;
      if (!rdramPtr || !rdramBytes || !cpuPtr || !cpuBytes) return null;
      const readSlice = (base, len) =>
        base && len ? new Uint8Array(mod.HEAPU8.buffer, base, len).slice() : new Uint8Array(0);
      return {
        frame: snapshotFrame,
        rdram: readSlice(rdramPtr, rdramBytes),
        cpu: readSlice(cpuPtr, cpuBytes),
        hidden: readSlice(hiddenPtr, hiddenBytes),
        hle: readSlice(hlePtr, hleBytes),
      };
    } catch (e) {
      _shadowLog(`split-state-read failed ${e?.message || e}`);
      return null;
    } finally {
      mod._free(ptr);
    }
  };

  const _shadowControllerMask = () => {
    let mask = 0;
    const players = Math.max(1, Math.min(4, rb_numPlayers || 2));
    for (let i = 0; i < players; i++) mask |= 1 << i;
    return mask || 3;
  };

  const _shadowOnMessage = (event) => {
    const msg = event.data || {};
    const stats = _getShadowStats();
    if (msg.type === 'ready') {
      _rbShadowBooting = false;
      _rbShadowReady = true;
      _rbShadowFailed = false;
      _rbShadowInFlight = 0;
      stats.ready++;
      stats.lastFrame = msg.frame ?? -1;
      stats.lastBootMs = performance.now() - (stats._bootStartedAt || performance.now());
      _shadowMarkNeedsFreshPaint();
      _shadowLog(`ready frame=${stats.lastFrame} bootMs=${stats.lastBootMs.toFixed(1)} sab=${msg.sab ? 1 : 0}`);
    } else if (msg.type === 'stepped') {
      _rbShadowInFlight = Math.max(0, _rbShadowInFlight - 1);
      stats.stepAcks++;
      if (msg.reason === 'raf-pump') {
        _rbShadowRafInFlight = false;
        stats.rafStepAcks++;
      }
      stats.lastFrame = msg.frame ?? stats.lastFrame;
      stats.lastPaintMax = typeof msg.maxChannel === 'number' ? msg.maxChannel : stats.lastPaintMax;
      if (_rbShadowVisible && (msg.count | 0) > 0) _rbShadowVisibleCommits += msg.count | 0;
      if (msg.black === true) {
        stats.blackStepAcks++;
        _rbShadowLastLooksBlack = true;
      } else if (msg.black === false) {
        _rbShadowLastLooksBlack = false;
        _rbShadowNeedsFreshPaint = false;
        _rbShadowLastGoodPaintAt = performance.now();
        _rbShadowLastPaintFrame = msg.frame ?? stats.lastFrame;
      } else if ((msg.count | 0) > 0) {
        stats.unknownPaintAcks++;
        _rbShadowLastLooksBlack = false;
        _rbShadowNeedsFreshPaint = false;
        _rbShadowLastGoodPaintAt = performance.now();
        _rbShadowLastPaintFrame = msg.frame ?? stats.lastFrame;
      }
      const prewarm = _rbShadowPrewarm;
      if (prewarm && msg.seq === prewarm.seq) {
        if (prewarm.timer) clearTimeout(prewarm.timer);
        _rbShadowPrewarm = null;
        const inBudget = performance.now() <= prewarm.deadline;
        const freshEnough = (msg.frame ?? -1) >= prewarm.minFrame;
        if (inBudget && msg.black === false && freshEnough) {
          stats.preWarmAcksInBudget++;
          _shadowRevealOverlay(prewarm.depth, prewarm.source, prewarm.rect, 'prewarm');
        } else if (msg.black === true) {
          stats.preWarmBlack++;
        } else {
          stats.preWarmAcksLate++;
        }
      }
    } else if (msg.type === 'resynced') {
      stats.resyncAcks++;
      stats.lastFrame = msg.frame ?? stats.lastFrame;
      if (typeof msg.loadMs === 'number') {
        stats.lastResyncLoadImmediateMs = msg.loadMs;
        stats.resyncLoadImmediateMs += msg.loadMs;
      }
      _shadowMarkNeedsFreshPaint();
      _shadowLog(`resynced frame=${stats.lastFrame} result=${msg.result} reason=${msg.reason || ''}`);
    } else if (msg.type === 'resync-rejected') {
      stats.resyncSplitRejected++;
      const detail =
        msg.rdramPtr !== undefined
          ? ` ptr=${msg.rdramPtr} rdram=${msg.rdramBytes ?? '?'} cpu=${msg.cpuBytes ?? '?'}`
          : '';
      stats.lastError = `${msg.reason || 'resync'} rejected: ${msg.message || 'unknown'}${detail}`;
      _shadowLog(stats.lastError);
      if (msg.split && _rbShadowReady && !_rbShadowFailed && _rbShadowWorker) {
        _shadowPostRetroState(stats, `${msg.reason || 'resync'}-retro-fallback`, msg.frame);
      }
    } else if (msg.type === 'frame') {
      // Worker has read its emulator's RDRAM framebuffer and sent us
      // raw RGBA bytes. Two uses:
      //   1. (default-off) paint into _rbShadowFrameCanvas for direct
      //      blit. Visually mismatched vs the GLideN64 live canvas,
      //      so off by default — see RB_SHADOW_FRAME_BLIT.
      //   2. (default-on) compute center-of-brightness motion vector
      //      and feed it into the snapshot-freeze translate. The
      //      worker's emulator is forward-predicting where things
      //      will be on screen, so its COG delta tells us which
      //      direction the live canvas's pixels would have moved if
      //      it weren't paused for replay.
      try {
        if (!msg.rgba || !msg.width || !msg.height) return;
        const bytes = new Uint8ClampedArray(msg.rgba);
        if (bytes.length !== msg.width * msg.height * 4) return;
        // Compute COG over a coarse 32×24 grid for cheap motion
        // estimation. Only every-other frame already arrives, so
        // this samples ~30 Hz — plenty for a 30 ms freeze window.
        if (RB_SHADOW_MOTION_ORACLE && msg.frame !== _knWorkerCog.lastFrame) {
          _knWorkerCog.lastFrame = msg.frame;
          let sumX = 0,
            sumY = 0,
            sumW = 0;
          const stepX = Math.max(1, (msg.width / 32) | 0);
          const stepY = Math.max(1, (msg.height / 24) | 0);
          for (let y = 0; y < msg.height; y += stepY) {
            for (let x = 0; x < msg.width; x += stepX) {
              const i = (y * msg.width + x) * 4;
              const lum = bytes[i] + bytes[i + 1] + bytes[i + 2];
              sumX += x * lum;
              sumY += y * lum;
              sumW += lum;
            }
          }
          if (sumW > 0) {
            const cogX = sumX / sumW;
            const cogY = sumY / sumW;
            const hist = _knWorkerCog.history;
            hist.push({ frame: msg.frame, cogX, cogY, t: performance.now() });
            if (hist.length > 60) hist.shift();
            _pushReplayMotionDiag('cogSamples', {
              frame: msg.frame | 0,
              cogX: Number(cogX.toFixed(3)),
              cogY: Number(cogY.toFixed(3)),
              width: msg.width | 0,
              height: msg.height | 0,
            });
          }
        }
        const overlay = _shadowEnsureOverlay();
        if (!overlay) return;
        if (!overlay.__kn2dCtx) {
          // OffscreenCanvas was previously transferred. We can no
          // longer call getContext on it from this thread. Instead,
          // create a sibling 2D canvas that lives over the same
          // bounding box and paint into that. Lazy-init on first
          // frame so we don't allocate when shadow is disabled.
          if (!_rbShadowFrameCanvas) {
            const fc = document.createElement('canvas');
            fc.id = 'kn-rollback-shadow-frame';
            fc.setAttribute('aria-hidden', 'true');
            fc.style.cssText = [
              'position:fixed',
              'display:none',
              'pointer-events:none',
              'z-index:55',
              'margin:0',
              'padding:0',
              'border:0',
              'background:transparent',
              'image-rendering:pixelated',
              'image-rendering:crisp-edges',
              'will-change:opacity',
              'contain:strict',
            ].join(';');
            _rbShadowFrameCanvas = fc;
            const root = document.fullscreenElement || document.body || document.documentElement;
            if (root) root.appendChild(fc);
          }
          // Mark the OffscreenCanvas overlay as “has a 2D sibling” so
          // the show path knows to use the sibling instead of the OC.
          overlay.__kn2dCtx = true;
        }
        const fc = _rbShadowFrameCanvas;
        if (!fc) return;
        if (fc.width !== msg.width) fc.width = msg.width;
        if (fc.height !== msg.height) fc.height = msg.height;
        const ctx = fc.__ctx || (fc.__ctx = fc.getContext('2d'));
        if (!ctx) return;
        const imageData = new ImageData(bytes, msg.width, msg.height);
        ctx.putImageData(imageData, 0, 0);
        const stats2 = _getShadowStats();
        stats2.frameMessagesReceived = (stats2.frameMessagesReceived || 0) + 1;
        stats2.lastFramePaintAt = performance.now();
        stats2.lastFrameWidth = msg.width;
        stats2.lastFrameHeight = msg.height;
        // Treat a successful framebuffer paint as "fresh + non-black"
        // so the paint gate stops blocking. The bytes themselves are
        // by definition non-black (we just painted them).
        _rbShadowLastLooksBlack = false;
        _rbShadowNeedsFreshPaint = false;
        _rbShadowLastGoodPaintAt = performance.now();
        _rbShadowLastPaintFrame = msg.frame ?? _rbShadowLastPaintFrame;
      } catch (e) {
        _shadowLog(`frame-paint failed: ${e?.message || e}`);
      }
    } else if (msg.type === 'error') {
      _shadowDisable(`${msg.stage || 'worker'} ${msg.name || 'Error'}`, msg.message || '');
    } else if (msg.type === 'stderr') {
      const line = String(msg.line || '');
      if (line && line.length < 220) _shadowLog(`stderr ${line}`);
    }
  };

  const _shadowMaybeStart = (reason = 'unknown') => {
    if (!RB_SHADOW_EMU || _isSpectator || _rbShadowReady || _rbShadowBooting || _rbShadowFailed) return false;
    if (typeof Worker !== 'function') return false;
    if (typeof SharedArrayBuffer !== 'function' || !window.crossOriginIsolated) {
      _shadowDisable('sab-unavailable', 'SharedArrayBuffer requires cross-origin isolation');
      return false;
    }
    const overlay = _shadowEnsureOverlay();
    if (!overlay || typeof overlay.transferControlToOffscreen !== 'function') {
      _shadowDisable('offscreen-unavailable', 'transferControlToOffscreen unavailable');
      return false;
    }
    const geometry = _shadowSyncOverlayGeometry();
    if (!geometry) return false;

    const romBytes = _shadowReadRomBytes();
    const stateBytes = _shadowReadStateBytes();
    if (!romBytes || !stateBytes) {
      _shadowLog(`start deferred reason=${reason} rom=${!!romBytes} state=${!!stateBytes}`);
      return false;
    }

    _rbShadowBooting = true;
    const stats = _getShadowStats();
    stats.bootAttempts++;
    stats._bootStartedAt = performance.now();
    _rbShadowBootPromise = (async () => {
      try {
        const offscreen = overlay.transferControlToOffscreen();
        _rbShadowTransferred = true;
        _rbShadowStatusSab = new SharedArrayBuffer(16 * Int32Array.BYTES_PER_ELEMENT);
        _rbShadowStatus = new Int32Array(_rbShadowStatusSab);
        Atomics.store(_rbShadowStatus, RB_SHADOW_STATUS_IDX.status, RB_SHADOW_STATUS.BOOTING);
        const worker = new Worker('/static/rollback-shadow-worker.js', { name: 'kn-rollback-shadow' });
        _rbShadowWorker = worker;
        worker.onmessage = _shadowOnMessage;
        worker.onerror = (event) => {
          _shadowDisable('worker-error', event?.message || 'worker error');
        };
        const romBuffer = _shadowTransferBuffer(romBytes);
        const stateBuffer = _shadowTransferBuffer(stateBytes);
        const ejs = window.EJS_emulator;
        let coreSettings =
          typeof ejs?.getCoreSettings === 'function'
            ? ejs.getCoreSettings()
            : typeof ejs?.gameManager?.EJS?.getCoreSettings === 'function'
              ? ejs.gameManager.EJS.getCoreSettings()
              : '';
        // Force ANGRYLION (software RDP) in the shadow worker so the
        // rendered framebuffer lives in RDRAM (where we can read it
        // via _kn_get_vi_origin / _kn_get_rdram_ptr) rather than in
        // GLideN64's offscreen FBOs (where it can't be reached
        // through OffscreenCanvas under the current build). The
        // worker's emulator is presentation-only — it never feeds
        // back to authoritative state, and it doesn't need
        // GLideN64's HD textures or shader effects, so the visual
        // downgrade is acceptable for the few-ms-per-rollback window.
        // ?shadowRdp=gliden64 forces back to GLideN64 for A/B.
        const rdpOverride = _urlParams.get('shadowRdp');
        const desiredRdp = rdpOverride && rdpOverride !== '1' ? rdpOverride : 'angrylion';
        if (!coreSettings.includes('mupen64plus-Next-rdp-plugin')) {
          coreSettings = `mupen64plus-Next-rdp-plugin = "${desiredRdp}"\n` + coreSettings;
        }
        worker.postMessage(
          {
            type: 'init',
            canvas: offscreen,
            width: geometry.width,
            height: geometry.height,
            rom: romBuffer,
            state: stateBuffer,
            frame: _frameNum,
            statusSab: _rbShadowStatusSab,
            coreBase: '/static/ejs/cores/',
            coreScript: '/static/ejs/cores/mupen64plus_next_libretro.js',
            coreSettings,
            controllerMask: _shadowControllerMask(),
            verbose: _urlParams.get('shadowVerbose') === '1',
          },
          [offscreen, romBuffer, stateBuffer],
        );
        _shadowLog(
          `boot posted reason=${reason} romKB=${Math.round(romBytes.byteLength / 1024)} stateKB=${Math.round(
            stateBytes.byteLength / 1024,
          )} frame=${_frameNum}`,
        );
      } catch (e) {
        _rbShadowBooting = false;
        _shadowDisable('boot-post', e);
      }
    })();
    return true;
  };

  const _shadowBuildInputs = (tickMod, localInput, applyFrame) => {
    const inputs = [];
    const players = Math.max(1, Math.min(4, rb_numPlayers || 2));
    for (let s = 0; s < players; s++) {
      let inp = KNShared.ZERO_INPUT;
      if (s === _playerSlot) {
        inp = RB_TRUE_ROLLBACK ? localInput : _localInputs[applyFrame] || localInput || KNShared.ZERO_INPUT;
      } else {
        const remoteFrame = applyFrame >= 0 ? applyFrame : _frameNum;
        inp = _rbGetInput(tickMod, s, remoteFrame) || _remoteInputs[s]?.[remoteFrame] || KNShared.ZERO_INPUT;
      }
      inputs.push({
        slot: s,
        buttons: inp?.buttons | 0,
        lx: inp?.lx | 0,
        ly: inp?.ly | 0,
        cx: inp?.cx | 0,
        cy: inp?.cy | 0,
      });
    }
    _rbShadowLastInputs = inputs;
    return inputs;
  };

  const _shadowPostStep = (frame, inputs, reason = 'normal', count = 1, force = false) => {
    if (!RB_SHADOW_EMU || !_rbShadowReady || !_rbShadowWorker || _rbShadowFailed) return false;
    if (!force && _rbShadowInFlight >= RB_SHADOW_MAX_IN_FLIGHT) {
      _getShadowStats().droppedSteps++;
      return false;
    }
    const stats = _getShadowStats();
    const seq = ++_rbShadowStepSeq;
    const batch = Math.max(1, Math.min(RB_SHADOW_MAX_BATCH_FRAMES, count | 0 || 1));
    try {
      _rbShadowInFlight++;
      _rbShadowWorker.postMessage({
        type: 'step',
        seq,
        frame: frame | 0,
        inputs: inputs || _rbShadowLastInputs || [],
        reason,
        count: batch,
        wantSample: RB_SHADOW_PAINT_GATE,
        // Always request a framebuffer back. The worker reads RDRAM
        // (cheap when ANGRYLION wrote there during retro_run) and
        // sends pixel bytes via postMessage. Main paints them onto
        // the 2D shadow overlay so the user sees real frames.
        wantFrame: true,
      });
      if (reason === 'replay-runahead') stats.runAheadSent += batch;
      else if (reason === 'normal-lead') stats.leadStepsSent += batch;
      else if (reason === 'raf-pump') stats.rafStepsSent += batch;
      else stats.normalStepsSent += batch;
      return seq;
    } catch (e) {
      _rbShadowInFlight = Math.max(0, _rbShadowInFlight - 1);
      _shadowDisable('step-post', e);
      return false;
    }
  };

  const _shadowReadWorkerFrame = () => {
    if (_rbShadowStatus) {
      try {
        const f = Atomics.load(_rbShadowStatus, RB_SHADOW_STATUS_IDX.frame);
        if (Number.isFinite(f) && f > 0) return f | 0;
      } catch (_) {}
    }
    const f = _getShadowStats().lastFrame;
    return Number.isFinite(f) ? f | 0 : -1;
  };

  const _shadowPostLead = (targetFrame, inputs, reason = 'normal-lead', maxBatch = 6, force = false) => {
    if (!RB_SHADOW_EMU || !_rbShadowReady || !_rbShadowWorker || _rbShadowFailed) return false;
    const workerFrame = _shadowReadWorkerFrame();
    const startFrame = workerFrame >= 0 ? workerFrame : _frameNum;
    const delta = Math.max(0, (targetFrame | 0) - startFrame);
    _getShadowStats().lastLeadDelta = delta;
    if (delta <= 0) return false;
    const batch = Math.max(1, Math.min(RB_SHADOW_MAX_BATCH_FRAMES, maxBatch | 0 || 1, delta));
    return _shadowPostStep(startFrame, inputs || _rbShadowLastInputs || [], reason, batch, force);
  };

  const _shadowRevealOverlay = (depth = 0, source = null, rect = null, reason = 'fresh') => {
    const stats = _getShadowStats();
    const geometry = _shadowSyncOverlayGeometry(source, rect);
    const overlay = geometry?.overlay;
    if (!overlay) return false;
    if (_rbVisualFreezeHideTimer) {
      clearTimeout(_rbVisualFreezeHideTimer);
      _rbVisualFreezeHideTimer = 0;
    }
    if (_rbShadowHideTimer) {
      clearTimeout(_rbShadowHideTimer);
      _rbShadowHideTimer = 0;
    }
    overlay.style.transition = 'none';
    overlay.style.opacity = String(RB_SHADOW_OVERLAY_OPACITY);
    overlay.style.visibility = 'visible';
    overlay.style.display = 'block';
    overlay.dataset.depth = String(depth);
    const serial = ++_rbVisualFreezeSerial;
    overlay.dataset.serial = String(serial);
    // ANGRYLION worker pixels (in _rbShadowFrameCanvas) are NOT
    // displayed by default — see RB_SHADOW_FRAME_BLIT below. The
    // raw 320×240 ANGRYLION output looks visually different from
    // GLideN64's HD-upscaled live canvas, and cutting between the
    // two at show/hide creates a plugin-style flicker that's worse
    // than the freeze it replaces. Keep this code path behind a
    // ?shadowFrameBlit=1 flag for future iteration; meanwhile we use
    // the worker frames as a motion ORACLE (see _knWorkerCog)
    // rather than a pixel source.
    if (RB_SHADOW_FRAME_BLIT && _rbShadowFrameCanvas) {
      _rbShadowFrameCanvas.style.transition = 'none';
      _rbShadowFrameCanvas.style.opacity = String(RB_SHADOW_OVERLAY_OPACITY);
      _rbShadowFrameCanvas.style.display = 'block';
    }
    if (RB_SHADOW_HIDE_LIVE) _hideLiveCanvasUnderOverlay();
    _rbShadowVisible = true;
    _rbShadowHoldUntil = performance.now() + RB_SHADOW_OVERLAY_HOLD_MS;
    _rbVisualFreezeActive = true;
    _rbShadowVisibleStepBase = stats.stepAcks;
    _rbShadowVisibleCommits = 0;
    if (RB_REPLAY_MOTION_NUDGE) _startRollbackMotionSmoothing(overlay, serial, { force: true });
    stats.shows++;
    _pushReplayMotionDiag('lifecycle', {
      event: 'shadow-show',
      depth: depth | 0,
      serial,
      reason,
      paintFrame: _rbShadowLastPaintFrame | 0,
      cogBaselineFrame: _knWorkerCog.baseline?.frame ?? -1,
    });
    if (RB_SHADOW_PUMP) {
      const pumpFrames = Math.max(2, depth + 2);
      _shadowStartPump(_frameNum + pumpFrames, 'replay-show');
    } else {
      _shadowStartRafPump(reason);
    }
    return true;
  };

  const _shadowRequestPrewarm = (depth = 0, source = null, rect = null, reason = 'prewarm') => {
    if (!RB_SHADOW_EMU || !_rbShadowReady || !_rbShadowWorker || _rbShadowFailed) return false;
    _shadowCancelPrewarm(true);
    const stats = _getShadowStats();
    stats.preWarmRequests++;
    const seq = _shadowPostStep(_frameNum, _rbShadowLastInputs || [], `prewarm:${reason}`, 1, true);
    if (!seq) return false;
    const pending = {
      seq,
      depth,
      source,
      rect,
      minFrame: _frameNum - 1,
      deadline: performance.now() + RB_SHADOW_PREWARM_BUDGET_MS,
      timer: 0,
    };
    pending.timer = setTimeout(() => {
      if (_rbShadowPrewarm !== pending) return;
      _rbShadowPrewarm = null;
      stats.preWarmAcksLate++;
    }, RB_SHADOW_PREWARM_BUDGET_MS);
    _rbShadowPrewarm = pending;
    return true;
  };

  const _shadowShowOverlay = (depth = 0, source = null, rect = null) => {
    if (!RB_SHADOW_EMU) return false;
    if (!_rbShadowReady) {
      _shadowMaybeStart('replay-start');
      return false;
    }
    const stats = _getShadowStats();
    if (stats.stepAcks <= 0) {
      stats.coldShowsSkipped++;
      _shadowRequestPrewarm(depth, source, rect, 'cold');
      return false;
    }
    const paintBlocked = _shadowPaintGate();
    if (paintBlocked) {
      if (paintBlocked === 'black') stats.blackShowsSkipped++;
      else stats.freshShowsSkipped++;
      _shadowRequestPrewarm(depth, source, rect, paintBlocked);
      return false;
    }
    return _shadowRevealOverlay(depth, source, rect, 'fresh');
  };

  const _shadowShowPersistentOverlay = () => {
    if (!RB_SHADOW_EMU || !RB_SHADOW_PERSISTENT || !_rbShadowReady || _rbShadowFailed) return false;
    const stats = _getShadowStats();
    if (stats.stepAcks <= 0) return false;
    const geometry = _shadowSyncOverlayGeometry();
    const overlay = geometry?.overlay;
    if (!overlay) return false;
    if (_rbShadowHideTimer) {
      clearTimeout(_rbShadowHideTimer);
      _rbShadowHideTimer = 0;
    }
    overlay.style.transition = 'none';
    overlay.style.opacity = String(RB_SHADOW_OVERLAY_OPACITY);
    overlay.style.visibility = 'visible';
    overlay.style.display = 'block';
    _rbShadowVisible = true;
    if (!_rbShadowPersistentActive) stats.persistentShows++;
    _rbShadowPersistentActive = true;
    return true;
  };

  // Legacy worker self-pump during the rollback overlay window.
  //
  // Why: the old replay-runahead path posted ONE batched step message
  // with count=depth+2. The worker processed those N stepOnce calls in
  // a single synchronous task; the OffscreenCanvas only commits the
  // last GL output of that task to the placeholder. The user therefore
  // saw the same single pre-replay frame for the entire overlay window
  // (~50-65ms) — that "feels paused" hitch at rollback frequency.
  //
  // The main-rAF pump is the default now. This setTimeout pump is kept
  // only for explicit ?shadowPump=legacy A/B while diagnosing browser
  // compositor behavior.
  //
  // Bounded by untilFrame so the worker can't run away. Stopped on
  // _finishCReplay, hard hide, or worker resync. Worker pump steps do
  // NOT post 'stepped' acks, so _rbShadowInFlight accounting is
  // untouched — main's normal-tick stepping resumes cleanly afterward.
  const _shadowStartPump = (untilFrame, reason = 'replay-pump') => {
    if (!RB_SHADOW_EMU || !_rbShadowReady || !_rbShadowWorker || _rbShadowFailed) return false;
    const inputs = _rbShadowLastInputs || [];
    try {
      _rbShadowWorker.postMessage({
        type: 'start-pump',
        untilFrame: untilFrame | 0,
        inputs,
        reason,
      });
      const stats = _getShadowStats();
      stats.pumpStarts++;
      stats.lastPumpUntil = untilFrame | 0;
      return true;
    } catch (e) {
      _shadowDisable('pump-start-post', e);
      return false;
    }
  };

  const _shadowStopPump = (reason = '') => {
    if (!RB_SHADOW_EMU || !_rbShadowReady || !_rbShadowWorker || _rbShadowFailed) return false;
    try {
      _rbShadowWorker.postMessage({ type: 'stop-pump', reason });
      _getShadowStats().pumpStops++;
      return true;
    } catch (_) {
      return false;
    }
  };

  const _shadowPostRetroState = (stats, reason = 'resync', frame = _frameNum, t0 = performance.now()) => {
    const stateBytes = _shadowReadStateBytes();
    if (!stateBytes) return false;
    const buffer = _shadowTransferBuffer(stateBytes);
    try {
      _rbShadowWorker.postMessage({ type: 'resync', state: buffer, frame, reason }, [buffer]);
      stats.resyncViaRetro++;
      stats.resyncsSent++;
      _rbShadowLastResyncAt = performance.now();
      const dt = _rbShadowLastResyncAt - t0;
      stats.lastResyncPostMessageMs = dt;
      stats.resyncPostMessageMs += dt;
      return true;
    } catch (e) {
      _shadowDisable('resync-post', e);
      return false;
    }
  };

  const _shadowSendState = (reason = 'resync', options = {}) => {
    if (!RB_SHADOW_EMU || !_rbShadowReady || !_rbShadowWorker || _rbShadowFailed) return false;
    const stats = _getShadowStats();
    const t0 = performance.now();
    const split = options.allowSplit === false ? null : _shadowReadSplitStateBytes(_frameNum);
    try {
      if (split?.rdram?.byteLength && split?.cpu?.byteLength) {
        const rdram = _shadowTransferBuffer(split.rdram);
        const cpu = _shadowTransferBuffer(split.cpu);
        const hidden = _shadowTransferBuffer(split.hidden);
        const hle = _shadowTransferBuffer(split.hle);
        const transfer = [rdram, cpu];
        if (hidden?.byteLength) transfer.push(hidden);
        if (hle?.byteLength) transfer.push(hle);
        _rbShadowWorker.postMessage(
          {
            type: 'resync-split',
            rdram,
            cpu,
            hidden,
            hle,
            frame: split.frame,
            reason,
          },
          transfer,
        );
        stats.resyncViaSplit++;
      } else {
        stats.resyncSplitUnavailable++;
        return _shadowPostRetroState(stats, reason, _frameNum, t0);
      }
      _rbShadowLastResyncAt = performance.now();
      const dt = _rbShadowLastResyncAt - t0;
      stats.lastResyncPostMessageMs = dt;
      stats.resyncPostMessageMs += dt;
      stats.resyncsSent++;
      return true;
    } catch (e) {
      _shadowDisable('resync-post', e);
      return false;
    }
  };

  const _shadowScheduleResync = (reason = 'resync') => {
    if (!RB_SHADOW_EMU || !_rbShadowReady || _rbShadowFailed) return;
    if (!_rbShadowPersistentActive && _shadowIsOverlayCovering()) {
      _rbShadowPendingResyncReason = reason;
      _getShadowStats().deferredResyncs++;
      return;
    }
    const now = performance.now();
    if (now - _rbShadowLastResyncAt < RB_SHADOW_RESYNC_MIN_MS) return;
    if (_rbShadowResyncTimer) return;
    if (RB_SHADOW_RESYNC_DELAY_MS <= 0) {
      _shadowSendState(reason);
      return;
    }
    _rbShadowResyncTimer = setTimeout(() => {
      _rbShadowResyncTimer = 0;
      _shadowSendState(reason);
    }, RB_SHADOW_RESYNC_DELAY_MS);
  };

  const _captureRollbackVisualSnapshot = () => {
    if (!_rbVisualFreezeEnabled || _rbVisualFreezeActive) return false;
    const source = _findRollbackVisualCanvas();
    const rect = source?.getBoundingClientRect?.();
    if (!source || !rect || rect.width <= 1 || rect.height <= 1) return false;
    if (_sourceLooksBlack(source)) return false;
    try {
      const scale = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      const width = Math.max(1, source.width || Math.round(rect.width * scale));
      const height = Math.max(1, source.height || Math.round(rect.height * scale));
      if (!_rbVisualCandidateCanvas) {
        _rbVisualCandidateCanvas = document.createElement('canvas');
        _rbVisualCandidateCtx = _rbVisualCandidateCanvas.getContext('2d', { willReadFrequently: true });
      }
      const candidate = _rbVisualCandidateCanvas;
      if (candidate.width !== width) candidate.width = width;
      if (candidate.height !== height) candidate.height = height;
      if (!_rbVisualCandidateCtx) _rbVisualCandidateCtx = candidate.getContext('2d', { willReadFrequently: true });
      if (!_rbVisualCandidateCtx) return false;
      _rbVisualCandidateCtx.imageSmoothingEnabled = false;
      _rbVisualCandidateCtx.clearRect(0, 0, width, height);
      _rbVisualCandidateCtx.drawImage(source, 0, 0, width, height);
      const oldCanvas = _rbVisualSnapshotCanvas;
      const oldCtx = _rbVisualSnapshotCtx;
      _rbVisualSnapshotCanvas = _rbVisualCandidateCanvas;
      _rbVisualSnapshotCtx = _rbVisualCandidateCtx;
      _rbVisualCandidateCanvas = oldCanvas;
      _rbVisualCandidateCtx = oldCtx;
      _rbVisualSnapshotFrame = _frameNum;
      return true;
    } catch (_) {
      return false;
    }
  };

  const _showRollbackVisualFreeze = (depth = 0, localInput = null) => {
    if (_rbVisualFreezeActive) return true;
    if (!_rbVisualFreezeEnabled && !RB_SHADOW_FRAME_BLIT) return false;
    // Skip freeze for shallow rollbacks. depth ≤ 2 = at most ~32 ms
    // of replay scrub at 60 Hz, which reads as a tiny stutter rather
    // than a freeze; showing the snapshot for that long actually adds
    // a more noticeable pause than just letting the live canvas show
    // the replay frames. Only mask depth ≥ 3 where the discontinuity
    // becomes visible. Reports as a "skip" so the no-op caller can
    // still see something happened (currently it just returns false
    // and the C engine continues; no fallback nudge fires for these).
    if (RB_VISUAL_FREEZE_MIN_DEPTH > 0 && depth < RB_VISUAL_FREEZE_MIN_DEPTH) {
      return false;
    }
    const source = _findRollbackVisualCanvas();
    const rect = source?.getBoundingClientRect?.();
    if (!source || !rect || rect.width <= 1 || rect.height <= 1) return false;
    // Only reveal the shadow canvas when the explicit direct-blit A/B path
    // is enabled. In the motion-oracle mode the worker is data-only; showing
    // its OffscreenCanvas here can expose black/transitional ANGRYLION frames
    // and creates the same perceptual twitch/flicker the oracle was meant to
    // avoid.
    if (RB_SHADOW_FRAME_BLIT && _shadowShowOverlay(depth, source, rect)) return true;
    if (!_rbVisualFreezeEnabled) return false;
    const snapshotAge = _rbVisualSnapshotFrame >= 0 ? Math.abs(_frameNum - _rbVisualSnapshotFrame) : Infinity;
    if (!_rbVisualSnapshotCanvas || snapshotAge > RB_VISUAL_SNAPSHOT_MAX_AGE_FRAMES) {
      if (!_captureRollbackVisualSnapshot()) return false;
    }
    try {
      if (!_rbVisualFreezeOverlay) {
        const overlay = document.createElement('canvas');
        overlay.id = 'kn-rollback-visual-freeze';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.style.cssText = [
          'position:fixed',
          'display:none',
          'pointer-events:none',
          'z-index:54',
          'margin:0',
          'padding:0',
          'border:0',
          'background:transparent',
          'image-rendering:pixelated',
          'image-rendering:crisp-edges',
          'will-change:opacity,transform',
          'contain:strict',
        ].join(';');
        _rbVisualFreezeOverlay = overlay;
        _rbVisualFreezeCtx = overlay.getContext('2d');
        if (_rbVisualFreezeCtx) _rbVisualFreezeCtx.imageSmoothingEnabled = false;
      }
      const overlay = _rbVisualFreezeOverlay;
      const root = document.fullscreenElement || document.body || document.documentElement;
      if (overlay.parentNode !== root) root.appendChild(overlay);
      const width = Math.max(1, _rbVisualSnapshotCanvas.width);
      const height = Math.max(1, _rbVisualSnapshotCanvas.height);
      if (overlay.width !== width) overlay.width = width;
      if (overlay.height !== height) overlay.height = height;
      if (!_rbVisualFreezeCtx) _rbVisualFreezeCtx = overlay.getContext('2d');
      if (!_rbVisualFreezeCtx) return false;
      _rbVisualFreezeCtx.imageSmoothingEnabled = false;
      _rbVisualFreezeCtx.clearRect(0, 0, width, height);
      _rbVisualFreezeCtx.drawImage(_rbVisualSnapshotCanvas, 0, 0, width, height);
      overlay.style.left = `${Math.round(rect.left)}px`;
      overlay.style.top = `${Math.round(rect.top)}px`;
      overlay.style.width = `${Math.round(rect.width)}px`;
      overlay.style.height = `${Math.round(rect.height)}px`;
      if (_rbVisualFreezeHideTimer) {
        clearTimeout(_rbVisualFreezeHideTimer);
        _rbVisualFreezeHideTimer = 0;
      }
      overlay.style.transition = 'none';
      overlay.style.opacity = '1';
      overlay.style.transform = RB_REPLAY_MOTION_SMOOTHING
        ? `translate3d(0, 0, 0) scale(${RB_REPLAY_MOTION_SCALE ? RB_MOTION_SMOOTHING_BASE_SCALE : 1})`
        : 'none';
      overlay.style.transformOrigin = '50% 50%';
      overlay.style.display = 'block';
      overlay.dataset.depth = String(depth);
      const serial = ++_rbVisualFreezeSerial;
      overlay.dataset.serial = String(serial);
      _rbVisualFreezeActive = true;
      // Pin the worker COG baseline so motion-oracle deltas during
      // this rollback are measured against the moment the freeze
      // started. Use the most recent worker COG sample as baseline;
      // the worker is running ~30 fps so it's at most ~33 ms stale.
      if (RB_SHADOW_MOTION_ORACLE) {
        const hist = _knWorkerCog.history;
        const last = hist[hist.length - 1];
        _knWorkerCog.baseline = last ? { cogX: last.cogX, cogY: last.cogY, frame: last.frame } : null;
      }
      _pushReplayMotionDiag('lifecycle', {
        event: 'freeze-show',
        depth: depth | 0,
        serial,
        snapshotFrame: _rbVisualSnapshotFrame | 0,
        cogBaselineFrame: _knWorkerCog.baseline?.frame ?? -1,
        snapshotAge: _rbVisualSnapshotFrame >= 0 ? Math.abs(_frameNum - _rbVisualSnapshotFrame) : -1,
      });
      _startRollbackMotionSmoothing(overlay, serial);
      // Micro-zoom: animate scale during the freeze window so the
      // overlay looks like it's gently moving instead of frozen.
      // Skipped if motion smoothing is on (it owns transform), and
      // skipped under shadow-overlay-active (shadow path uses real
      // motion). Triggered on next rAF so the initial transform is
      // committed first; otherwise the transition no-ops.
      if (RB_REPLAY_MICRO_ZOOM && !RB_REPLAY_MOTION_SMOOTHING && !_rbShadowVisible) {
        const targetScale = 1 + RB_REPLAY_MICRO_ZOOM_PCT / 100;
        const zoomDurationMs = Math.max(48, Math.min(140, Math.max(48, depth * 8)));
        const raf = window.APISandbox?.nativeRAF || window.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
        raf(() => {
          if (
            !_rbVisualFreezeActive ||
            _rbVisualFreezeOverlay !== overlay ||
            overlay.dataset.serial !== String(serial)
          ) {
            return;
          }
          overlay.style.transition = `transform ${zoomDurationMs}ms ease-out`;
          overlay.style.transform = `scale(${targetScale.toFixed(4)})`;
        });
      }
      if (RB_VISUAL_FADE_DURING_REPLAY && RB_VISUAL_FADE_MS > 0) {
        const replayFadeMs = Math.max(45, Math.min(140, Math.max(RB_VISUAL_FADE_MS, depth * 14)));
        const raf = window.APISandbox?.nativeRAF || window.requestAnimationFrame || ((cb) => setTimeout(cb, 0));
        raf(() => {
          if (
            !_rbVisualFreezeActive ||
            _rbVisualFreezeOverlay !== overlay ||
            overlay.dataset.serial !== String(serial)
          ) {
            return;
          }
          overlay.style.transition = `opacity ${replayFadeMs}ms linear`;
          overlay.style.opacity = '0';
        });
      }
      // Tail fade: start fading the overlay out near the end of the
      // estimated replay window. ~5 ms per replay frame is the
      // typical wall-clock cost; the tail fade kicks in
      // RB_REPLAY_TAIL_FADE_MS before the projected end so the cross-
      // over with the live canvas (now near its post-replay state)
      // reads as motion blur rather than a hard cut. If replay takes
      // longer than expected, the fade still completes in time; if
      // shorter, _hideRollbackVisualFreeze catches it and finalizes.
      if (RB_REPLAY_TAIL_FADE_MS > 0 && !RB_VISUAL_FADE_DURING_REPLAY) {
        const expectedReplayMs = Math.max(8, depth * 5);
        const startFadeAtMs = Math.max(0, expectedReplayMs - RB_REPLAY_TAIL_FADE_MS);
        setTimeout(() => {
          if (
            !_rbVisualFreezeActive ||
            _rbVisualFreezeOverlay !== overlay ||
            overlay.dataset.serial !== String(serial)
          ) {
            return;
          }
          // Preserve any in-flight transform transition (motion or
          // micro-zoom) by appending the opacity transition rather
          // than overwriting.
          const existing = overlay.style.transition || '';
          overlay.style.transition =
            (existing && !existing.includes('opacity') ? `${existing}, ` : '') +
            `opacity ${RB_REPLAY_TAIL_FADE_MS}ms linear`;
          overlay.style.opacity = '0';
        }, startFadeAtMs);
      }
      return true;
    } catch (e) {
      _rbVisualFreezeFailures++;
      _resetRollbackMotionSmoothing();
      if (_rbVisualFreezeOverlay) _rbVisualFreezeOverlay.style.display = 'none';
      _rbVisualFreezeActive = false;
      if (_rbVisualFreezeFailures <= 3) {
        _syncLog(`VISUAL-FREEZE failed count=${_rbVisualFreezeFailures} ${e?.name || 'Error'}: ${e?.message || e}`);
      }
      return false;
    }
  };

  const _hideRollbackVisualFreeze = () => {
    _rbVisualFreezeActive = false;
    _pushReplayMotionDiag('lifecycle', {
      event: 'freeze-hide',
      prevDx: Number(_rbMotionSmoothingDx.toFixed(3)),
      prevDy: Number(_rbMotionSmoothingDy.toFixed(3)),
      shadowVisible: !!_rbShadowVisible,
      baselineFrame: _knWorkerCog.baseline?.frame ?? -1,
    });
    // Clear the worker-COG baseline so the next rollback measures
    // delta from a fresh baseline, not from the previous freeze's
    // start. Otherwise consecutive rollbacks compose translates
    // unboundedly.
    if (RB_SHADOW_MOTION_ORACLE) _knWorkerCog.baseline = null;
    const keepShadowNudge = RB_REPLAY_MOTION_NUDGE && _rbShadowVisible && _rbShadowOverlay && !RB_SHADOW_PERSISTENT;
    if (keepShadowNudge) _cancelRollbackMotionSmoothing();
    else _resetRollbackMotionSmoothing();
    _shadowHideOverlay();
    const overlay = _rbVisualFreezeOverlay;
    if (!overlay) return;
    if (_rbVisualFreezeHideTimer) clearTimeout(_rbVisualFreezeHideTimer);
    if (overlay.style.display === 'none' || RB_VISUAL_FADE_MS <= 0) {
      overlay.style.display = 'none';
      overlay.style.transition = 'none';
      overlay.style.opacity = '1';
      _rbVisualFreezeHideTimer = 0;
      return;
    }
    overlay.style.transition = `opacity ${RB_VISUAL_FADE_MS}ms ease-out`;
    overlay.style.opacity = '0';
    _rbVisualFreezeHideTimer = setTimeout(() => {
      if (overlay !== _rbVisualFreezeOverlay) return;
      overlay.style.display = 'none';
      overlay.style.transition = 'none';
      overlay.style.opacity = '1';
      _rbVisualFreezeHideTimer = 0;
    }, RB_VISUAL_FADE_MS + 20);
  };

  const _destroyRollbackVisualFreeze = () => {
    _hideRollbackVisualFreeze();
    _shadowStop('visual-destroy');
    _resetRollbackCanvasNudge();
    if (_rbVisualFreezeHideTimer) {
      clearTimeout(_rbVisualFreezeHideTimer);
      _rbVisualFreezeHideTimer = 0;
    }
    if (_rbVisualFreezeOverlay?.parentNode) _rbVisualFreezeOverlay.parentNode.removeChild(_rbVisualFreezeOverlay);
    _rbVisualFreezeOverlay = null;
    _rbVisualFreezeCtx = null;
    _rbVisualSnapshotCanvas = null;
    _rbVisualSnapshotCtx = null;
    _rbVisualCandidateCanvas = null;
    _rbVisualCandidateCtx = null;
    _rbVisualProbeCanvas = null;
    _rbVisualProbeCtx = null;
    _rbVisualSnapshotFrame = -1;
  };

  // ── Freeze detection state ─────────────────────────────────────────
  // Lightweight per-frame sampling to detect when display, input, or
  // audio stop working — the "emulator froze" scenario where the tick
  // loop keeps running but the player sees/hears nothing.
  // MF6: Detection-only tick watchdog state. Logs TICK-STUCK with a
  // rich diagnostic snapshot when the frame counter has not advanced
  // for longer than the warn / error thresholds. Takes NO recovery
  // action — its sole purpose is to surface residual deadlocks we
  // have not yet found. If this fires in production, we have a new
  // bug to diagnose; the fix belongs in one of the MF categories,
  // not in the watchdog itself. See docs/netplay-invariants.md.
  let _tickStuckLastFrame = -1;
  let _tickStuckLastAdvanceAt = 0;
  let _tickStuckWarnFired = false;
  let _tickStuckErrorFired = false;
  // Module-scope flag toggled around stepOneFrame() so the watchdog
  // can distinguish "JS-level stall with no known flag set" from
  // "WASM call itself is frozen". If TICK-STUCK fires while this is
  // true, the emulator thread is blocked inside the WASM step and
  // we have a WASM-internal problem rather than a JS deadlock.
  let _wasmStepActive = false;
  const TICK_STUCK_WARN_MS = 2000;
  const TICK_STUCK_ERROR_MS = 5000;
  // BOOT-LOCKSTEP timeout tracking: if we're stalled at the same apply frame
  // for too long during boot convergence, something has gone wrong (DC died
  // with inputs in flight) and we must recover instead of deadlocking.
  let _bootStallFrame = -1;
  let _bootStallStartTime = 0;
  let _bootStallRecoveryFired = false;
  let _bootStallRecoveryResetTime = 0;
  let _phaseLockStallKey = '';
  let _phaseLockStallStartTime = 0;
  let _rbInputStallKey = '';
  let _rbInputStallStartTime = 0;
  // P4: last observed failed_rollbacks counter (logged only — see policy below).
  let _rbLastFailedRollbacks = 0;
  // Determinism diagnostics: last frame where peers' hashes matched, plus
  // bisect-on-mismatch state so we can narrow divergence to a single frame.
  let _rbLastGoodFrame = -1;
  let _rbBisectActive = false;
  let _rbBisectFramesRemaining = 0;
  // Cap bisect mode firings per match. Without this, a SUSTAINED divergence
  // (e.g., cycle-clock drift in cp0/event queue) re-arms bisect on every
  // mismatch detection, producing thousands of per-frame hash broadcasts.
  // The first 5 bisect cycles capture the data we need; further firings are
  // wasted CPU. Field test in match 768 fired bisect 1203× from one root
  // cause and ate the frame budget, contributing to user-perceived lag.
  const RB_BISECT_MAX_PER_MATCH = 5;
  let _rbBisectCount = 0;
  // Per-frame hash broadcast pending — populated after rollback to verify
  // the rollback restoration produced bit-identical state across peers.
  let _rbPendingPostRollbackHash = false;
  // RF6 Part A: AUDIO-DEATH diagnostics enrichment. Track the most recent
  // `C-REPLAY done` frame and how many kn_reset_audio() calls have fired
  // since then, so audio-empty / audio-silent log lines can report
  // rollback-correlation (Δ frames since rollback completed) and whether
  // the rollback path missed resetting audio. Pure diagnostics — no
  // behavior change.
  let _lastRollbackDoneFrame = null;
  let _resetAudioCallsSinceRb = 0;

  // ── window.knDiag — interactive diagnostics for devtools console ──
  //
  // Gated behind a debug flag so production users don't have an easily
  // discoverable surface for poking at emulator internals. Enable via:
  //   - ?knDiag=1 URL parameter (ephemeral, one page load)
  //   - localStorage.setItem('kn-debug', '1') (persistent)
  //
  // Once enabled, e.g.:
  //   knDiag.replaySelfTest(30)        // is rollback replay deterministic?
  //   knDiag.replaySelfTest(30, 5)     // run 5 trials
  //   knDiag.tainted()                 // current taint bitmap summary
  //   knDiag.blockHashes()             // 128 RDRAM block hashes
  //   knDiag.dumpBlock(7)              // hex-dump a 64KB block
  // Dev-build flag: set via ?debug=1 URL param or KN_DEV_BUILD=1 in
  // localStorage. Dev builds throw on invariant violations so the test
  // suite catches regressions. Production builds log and continue.
  // (Rollback integrity spec §Core principle.)
  const KN_DEV_BUILD = (() => {
    try {
      if (new URLSearchParams(window.location.search).get('debug') === '1') return true;
      if (window.localStorage?.getItem('KN_DEV_BUILD') === '1') return true;
    } catch (_) {}
    return false;
  })();
  window.KN_DEV_BUILD = KN_DEV_BUILD;

  const _knDiagEnabled = (() => {
    try {
      if (window.KN_DEV_BUILD) return true;
      if (new URLSearchParams(window.location.search).has('knDiag')) return true;
      if (localStorage.getItem('kn-debug') === '1') return true;
    } catch (_) {}
    return false;
  })();

  window.knDiag =
    _knDiagEnabled &&
    (window.knDiag ||
      (() => {
        const getMod = () => window.EJS_emulator?.gameManager?.Module;
        let _hashBuf = 0;
        let _taintBuf = 0;
        let _resultBuf = 0;
        const ensureBufs = (mod) => {
          if (!mod?._malloc) return false;
          if (!_hashBuf) _hashBuf = mod._malloc(RDRAM_TAINT_BLOCKS * 4);
          if (!_taintBuf) _taintBuf = mod._malloc(RDRAM_TAINT_BLOCKS);
          if (!_resultBuf) _resultBuf = mod._malloc(8); // 2 × uint32
          return _hashBuf && _taintBuf && _resultBuf;
        };
        const api = {
          // Save → run N → hash → restore → run N → hash → compare.
          // n = frames to advance per trial. trials = how many trial pairs to run.
          // Returns array of {trial, deterministic, hashB, hashBprime}.
          replaySelfTest(n = 30, trials = 1) {
            const mod = getMod();
            if (!mod?._kn_replay_self_test) {
              const msg = 'knDiag: _kn_replay_self_test export missing — rebuild WASM core.';
              console.error(msg);
              api._showOverlay(`ERR\n${msg}`);
              if (typeof _syncLog === 'function') _syncLog(`SELFTEST ERROR ${msg}`);
              return null;
            }
            if (!ensureBufs(mod)) return null;
            const results = [];
            const fnow = mod._kn_get_frame?.() ?? -1;
            for (let t = 0; t < trials; t++) {
              const t0 = performance.now();
              const ret = mod._kn_replay_self_test(n, _resultBuf);
              const dt = performance.now() - t0;
              const view = new Uint32Array(mod.HEAPU8.buffer, _resultBuf, 2);
              const hashB = view[0] >>> 0;
              const hashBp = view[1] >>> 0;
              const ok = ret === 1;
              const errs = { '-1': 'OOM', '-2': 'serialize failed', '-3': 'unserialize failed' };
              let line;
              if (ret < 0) {
                line = `SELFTEST trial=${t + 1}/${trials} n=${n} frame=${fnow} ERROR ${errs[String(ret)] ?? ret}`;
                console.error(line);
              } else {
                line = `SELFTEST trial=${t + 1}/${trials} n=${n} frame=${fnow} ${ok ? 'DETERMINISTIC' : 'NON-DETERMINISTIC'} ms=${dt.toFixed(0)} hashB=0x${hashB.toString(16)} hashBprime=0x${hashBp.toString(16)}`;
                console.log(line);
              }
              // Stream to server-side session log so we can pull via admin API.
              if (typeof _syncLog === 'function') _syncLog(line);
              results.push({ trial: t + 1, deterministic: ok, hashB, hashBprime: hashBp, ms: dt, ret });
            }
            const wins = results.filter((r) => r.deterministic).length;
            const summary = `SELFTEST SUMMARY ${wins}/${trials} deterministic n=${n} frame=${fnow}`;
            console.log(summary);
            if (typeof _syncLog === 'function') _syncLog(summary);
            // If self-test failed, automatically run the local replay bisect
            // to identify which savestate bytes diverged. This is a SINGLE-
            // MACHINE test — no peer needed, no network — so the result is
            // guaranteed to reflect a true determinism gap (not a sync issue).
            const allOk = wins === trials;
            if (!allOk) {
              try {
                api.replayBisect(n);
              } catch (err) {
                console.error('replayBisect failed:', err);
              }
            }
            // On-screen result so the user doesn't need devtools.
            const detail = results
              .map((r) =>
                r.ret < 0
                  ? `T${r.trial}: ERR ${r.ret}`
                  : `T${r.trial}: ${r.deterministic ? '✓' : '✗'} B=${r.hashB.toString(16).slice(-6)} B'=${r.hashBprime.toString(16).slice(-6)}`,
              )
              .join('\n');
            api._showOverlay(
              `${allOk ? '✓ DETERMINISTIC' : '✗ NON-DETERMINISTIC'}\n` +
                `${wins}/${trials} ok | n=${n}f | frame=${fnow}\n${detail}\n${allOk ? '' : '(see console for byte-level bisect)'}`,
              allOk ? '#0f0' : '#f44',
            );
            return results;
          },

          // Single-machine determinism bisect: save state, run N frames, dump
          // savestate B; restore, run N frames again, dump savestate B'; diff
          // them byte-by-byte to find every diverging byte. No peer, no
          // network — pure local repeatability test. Output identifies the
          // exact savestate offsets where the C engine fails to be
          // deterministic across save/restore/replay cycles.
          //
          // Use after replaySelfTest reports NON-DETERMINISTIC, OR call
          // directly: knDiag.replayBisect(60).
          replayBisect(n = 30) {
            const mod = getMod();
            if (!mod?._kn_replay_self_test || !mod?._kn_get_state_size || !mod?._kn_get_state_for_frame) {
              console.error('knDiag.replayBisect: required exports missing — rebuild WASM core.');
              return null;
            }
            // We need direct access to the savestate buffers from BOTH runs.
            // The C self-test already does save→run→hash→restore→run→hash but
            // doesn't expose the full buffers. Workaround: do the same dance
            // in JS using kn_sync_read/write or retro_serialize via gm.getState.
            //
            // Simpler approach: reuse the rollback engine's ring buffer.
            // 1) Save current state via _kn_get_state_for_frame(currentFrame)
            // 2) retro_run × n via stepOneFrame loop
            // 3) Save state B via getState
            // 4) restore (first save) via loadState
            // 5) retro_run × n again
            // 6) Save state B' via getState
            // 7) Byte-diff B vs B'
            // This isn't perfect (uses gm.loadState which goes through the
            // libretro path) but it's good enough for finding a diverging
            // byte offset.
            const gm = window.EJS_emulator?.gameManager;
            if (!gm?.getState || !gm?.loadState) {
              console.error('knDiag.replayBisect: gm.getState/loadState missing.');
              return null;
            }
            const f0 = mod._kn_get_frame?.() ?? -1;
            console.log(`replayBisect: starting at frame ${f0}, n=${n}`);
            // Save A
            let stateA;
            try {
              stateA = new Uint8Array(gm.getState());
            } catch (e) {
              console.error('replayBisect: getState A failed:', e);
              return null;
            }
            const sizeA = stateA.length;
            console.log(`replayBisect: state size ${sizeA} bytes`);
            // Run N frames
            const stepOne = window.stepOneFrame || (() => {});
            for (let i = 0; i < n; i++) stepOne();
            // Save B
            let stateB;
            try {
              stateB = new Uint8Array(gm.getState());
            } catch (e) {
              console.error('replayBisect: getState B failed:', e);
              return null;
            }
            // Restore A
            try {
              gm.loadState(stateA);
            } catch (e) {
              console.error('replayBisect: loadState A failed:', e);
              return null;
            }
            // Run N frames again
            for (let i = 0; i < n; i++) stepOne();
            // Save B'
            let stateBp;
            try {
              stateBp = new Uint8Array(gm.getState());
            } catch (e) {
              console.error('replayBisect: getState B-prime failed:', e);
              return null;
            }
            // Diff B vs B'
            if (stateB.length !== stateBp.length) {
              const msg = `replayBisect: state size mismatch B=${stateB.length} Bprime=${stateBp.length}`;
              console.error(msg);
              if (typeof _syncLog === 'function') _syncLog(msg);
              return { error: 'size_mismatch', sizeB: stateB.length, sizeBprime: stateBp.length };
            }
            const diffOffsets = [];
            for (let i = 0; i < stateB.length; i++) {
              if (stateB[i] !== stateBp[i]) diffOffsets.push(i);
            }
            const summary = `replayBisect: ${diffOffsets.length}/${stateB.length} bytes differ between B and B' (frame ${f0}, n=${n})`;
            console.log(summary);
            if (typeof _syncLog === 'function') _syncLog(`SELFTEST-BISECT ${summary}`);
            if (diffOffsets.length === 0) {
              console.log('replayBisect: state save/restore appears deterministic at the savestate-buffer level.');
              api._showOverlay(`SELFTEST-BISECT\nDETERMINISTIC\n${diffOffsets.length} bytes differ`, '#0f0');
              return { deterministic: true, diffCount: 0 };
            }
            // Group consecutive offsets into ranges
            const ranges = [];
            let rangeStart = diffOffsets[0];
            let rangeEnd = diffOffsets[0];
            for (let i = 1; i < diffOffsets.length; i++) {
              if (diffOffsets[i] === rangeEnd + 1) {
                rangeEnd = diffOffsets[i];
              } else {
                ranges.push([rangeStart, rangeEnd]);
                rangeStart = diffOffsets[i];
                rangeEnd = diffOffsets[i];
              }
            }
            ranges.push([rangeStart, rangeEnd]);
            console.log(`replayBisect: ${ranges.length} contiguous diff ranges`);
            // Dump first 16 ranges with bytes
            const rdramOff = mod._kn_get_rdram_offset_in_state?.() ?? 0;
            const labelOffset = (off) => {
              if (rdramOff === 0) return `off=0x${off.toString(16)}`;
              if (off < rdramOff) return `HEADER off=0x${off.toString(16)}`;
              if (off < rdramOff + 0x800000)
                return `RDRAM rdram=0x${(off - rdramOff).toString(16)} kseg0=0x${(0x80000000 + off - rdramOff).toString(16).padStart(8, '0')}`;
              return `POST-RDRAM postOff=0x${(off - rdramOff - 0x800000).toString(16)}`;
            };
            for (let i = 0; i < Math.min(ranges.length, 16); i++) {
              const [s, e] = ranges[i];
              const len = e - s + 1;
              const bytesB = Array.from(stateB.slice(s, Math.min(s + 64, e + 1)))
                .map((x) => x.toString(16).padStart(2, '0'))
                .join('');
              const bytesBp = Array.from(stateBp.slice(s, Math.min(s + 64, e + 1)))
                .map((x) => x.toString(16).padStart(2, '0'))
                .join('');
              const line = `SELFTEST-BISECT range ${i + 1}/${ranges.length} ${labelOffset(s)} len=${len} B=${bytesB} Bp=${bytesBp}`;
              console.log(line);
              if (typeof _syncLog === 'function') _syncLog(line);
            }
            const overlay = ranges
              .slice(0, 5)
              .map(([s, e]) => `${labelOffset(s)} ×${e - s + 1}`)
              .join('\n');
            api._showOverlay(
              `SELFTEST-BISECT\n✗ ${diffOffsets.length} bytes differ\n${ranges.length} ranges\n\n${overlay}\n\n(see console)`,
              '#f44',
            );
            return { deterministic: false, diffCount: diffOffsets.length, ranges };
          },

          // ── Transport override ───────────────────────────────────────
          // Force the next match's rollback transport to a specific mode.
          // Useful for A/B testing reliable vs unreliable on the same
          // network without rebuilding. Takes effect at the next game
          // start (host broadcasts at lockstep-ready time).
          //
          //   knDiag.setTransport('unreliable')  // unordered + redundancy
          //   knDiag.setTransport('reliable')    // ordered TCP-like
          //   knDiag.setTransport(null)          // reset to default
          setTransport(mode) {
            if (mode == null) {
              window._knTransportOverride = undefined;
              console.log('transport override cleared');
              return null;
            }
            if (mode !== 'reliable' && mode !== 'unreliable') {
              console.error('setTransport: mode must be reliable or unreliable');
              return null;
            }
            window._knTransportOverride = mode;
            console.log(`transport override set to: ${mode} (takes effect at next match start)`);
            return mode;
          },

          // ── Network simulator ────────────────────────────────────────
          //
          // Wraps every active peer's DataChannel.send() to inject
          // configurable jitter and packet drop. Lets you reproduce
          // jittery-network conditions deterministically without waiting
          // for real WiFi to misbehave.
          //
          // Usage:
          //   knDiag.netsim({jitterMs: 100, dropPct: 5})  // start
          //   knDiag.netsim({jitterMs: 200})               // change params
          //   knDiag.netsim(null)                          // restore normal
          //   knDiag.netsim()                              // show current
          //
          // Effect: outgoing packets from THIS tab to peers get a uniform
          // random delay in [0, jitterMs] ms before actually being sent,
          // and dropPct% are dropped entirely. The peer experiences this
          // as if the network had that latency/loss profile.
          //
          // Persistent across new peer connections — netsim wraps any DC
          // that opens after enable, until you call netsim(null).
          netsim(spec) {
            // Show current state
            if (spec === undefined) {
              const cur = window._knNetsim;
              // Normalize the return shape so the wrappedDcs Map gets
              // reported as a number instead of a serialized {} object.
              const view = cur
                ? { jitterMs: cur.jitterMs, dropPct: cur.dropPct, wrappedDcs: cur.wrappedDcs.size }
                : null;
              console.log('knDiag.netsim:', view);
              return view;
            }
            // Disable
            if (spec === null) {
              const cur = window._knNetsim;
              if (!cur) {
                console.log('knDiag.netsim: not active');
                return null;
              }
              // Restore all wrapped DCs
              for (const [dc, original] of cur.wrappedDcs) {
                try {
                  dc.send = original;
                } catch (_) {}
              }
              window._knNetsim = null;
              console.log('knDiag.netsim: disabled, restored', cur.wrappedDcs.size, 'DCs');
              api._showOverlay('NETSIM disabled', '#0f0');
              return null;
            }
            // Enable / update
            const jitterMs = Math.max(0, Number(spec?.jitterMs) || 0);
            const dropPct = Math.max(0, Math.min(100, Number(spec?.dropPct) || 0));
            const config = { jitterMs, dropPct, wrappedDcs: new Map() };
            window._knNetsim = config;

            // Wrapper factory — captures the original send function and
            // returns a function that delays/drops accordingly. Each DC
            // gets its own wrapper so we can restore them all later.
            const wrap = (dc) => {
              if (config.wrappedDcs.has(dc)) return;
              const original = dc.send.bind(dc);
              config.wrappedDcs.set(dc, dc.send);
              dc.send = function (data) {
                const cfg = window._knNetsim;
                if (!cfg) return original(data);
                if (cfg.dropPct > 0 && Math.random() * 100 < cfg.dropPct) {
                  return; // dropped
                }
                if (cfg.jitterMs > 0) {
                  const delay = Math.random() * cfg.jitterMs;
                  setTimeout(() => {
                    try {
                      original(data);
                    } catch (_) {}
                  }, delay);
                  return;
                }
                return original(data);
              };
            };

            // Wrap all currently-active peer DCs
            const peers = window._peers || (window.KNState && KNState.peers) || {};
            for (const p of Object.values(peers)) {
              if (p?.dc?.readyState === 'open') wrap(p.dc);
              if (p?.rbDc?.readyState === 'open') wrap(p.rbDc);
            }

            // Also install a hook so any DC that OPENS after enable also
            // gets wrapped. We can't easily intercept future DCs without
            // a global hook, so we expose a manual rewrap helper.
            window._knNetsimRewrap = () => {
              const peers2 = window._peers || (window.KNState && KNState.peers) || {};
              for (const p of Object.values(peers2)) {
                if (p?.dc?.readyState === 'open') wrap(p.dc);
                if (p?.rbDc?.readyState === 'open') wrap(p.rbDc);
              }
            };

            const msg = `NETSIM: jitter=${jitterMs}ms drop=${dropPct}% dcs=${config.wrappedDcs.size}`;
            console.log('knDiag.netsim enabled:', { jitterMs, dropPct, wrappedDcs: config.wrappedDcs.size });
            _syncLog?.(msg);
            api._showOverlay(msg, '#fa0');
            return { jitterMs, dropPct, wrappedDcs: config.wrappedDcs.size };
          },

          // Show a result overlay div in the corner of the game page. Mobile-
          // friendly read-out so devtools/USB cable aren't needed.
          _showOverlay(text, color = '#fff') {
            let div = document.getElementById('kn-selftest-overlay');
            if (!div) {
              div = document.createElement('div');
              div.id = 'kn-selftest-overlay';
              div.style.cssText = [
                'position:fixed',
                'top:8px',
                'right:8px',
                'background:rgba(0,0,0,0.85)',
                'color:#fff',
                'font:12px/1.3 monospace',
                'padding:8px 10px',
                'border-radius:6px',
                'border:1px solid #444',
                'z-index:99999',
                'white-space:pre',
                'max-width:90vw',
                'max-height:80vh',
                'overflow:auto',
                'pointer-events:auto',
              ].join(';');
              // Tap to dismiss.
              div.onclick = () => div.remove();
              document.body.appendChild(div);
            }
            div.style.color = color;
            div.textContent = String(text);
          },
          // Read taint bitmap. Returns array of tainted block indices and the
          // raw bitmap as a string of '0'/'1'.
          tainted() {
            const mod = getMod();
            if (!mod?._kn_get_taint_blocks) {
              console.error('knDiag: _kn_get_taint_blocks missing.');
              return null;
            }
            if (!ensureBufs(mod)) return null;
            mod._kn_get_taint_blocks(_taintBuf, RDRAM_TAINT_BLOCKS);
            const view = new Uint8Array(mod.HEAPU8.buffer, _taintBuf, RDRAM_TAINT_BLOCKS);
            const tainted = [];
            const bitmap = [];
            for (let i = 0; i < RDRAM_TAINT_BLOCKS; i++) {
              bitmap.push(view[i] ? '1' : '0');
              if (view[i]) tainted.push(i);
            }
            const out = { count: tainted.length, blocks: tainted, bitmap: bitmap.join('') };
            console.log(`knDiag.tainted: ${out.count}/${RDRAM_TAINT_BLOCKS} blocks tainted: [${tainted.join(',')}]`);
            return out;
          },
          // Get all 128 block hashes (one uint32 per 64KB block).
          blockHashes() {
            const mod = getMod();
            if (!mod?._kn_rdram_block_hashes) {
              console.error('knDiag: _kn_rdram_block_hashes missing.');
              return null;
            }
            if (!ensureBufs(mod)) return null;
            mod._kn_rdram_block_hashes(_hashBuf, RDRAM_TAINT_BLOCKS);
            const view = new Uint32Array(mod.HEAPU8.buffer, _hashBuf, RDRAM_TAINT_BLOCKS);
            const hashes = Array.from(view).map((h) => (h >>> 0).toString(16).padStart(8, '0'));
            console.log(`knDiag.blockHashes (128 blocks):`);
            for (let i = 0; i < 128; i += 8) {
              console.log(
                `  blk${i.toString().padStart(3, ' ')}-${(i + 7).toString().padStart(3, ' ')}: ${hashes.slice(i, i + 8).join(' ')}`,
              );
            }
            return hashes;
          },
          // Hex-dump the first `bytes` bytes of a 64KB RDRAM block. Returns
          // an object containing hex, ascii, float interpretations, and the
          // raw Uint8Array. Logs a formatted view to console for visual scan.
          dumpBlock(blockIdx, bytes = 256) {
            const mod = getMod();
            if (!mod?._kn_get_rdram_ptr) {
              console.error('knDiag.dumpBlock: _kn_get_rdram_ptr export missing — rebuild WASM core.');
              return null;
            }
            const rdramPtr = mod._kn_get_rdram_ptr();
            const offset = rdramPtr + blockIdx * 0x10000;
            const u8 = new Uint8Array(mod.HEAPU8.buffer, offset, bytes);
            // Snapshot copy so subsequent emulator writes don't mutate it.
            const snap = new Uint8Array(u8);
            const hex = Array.from(snap)
              .map((b) => b.toString(16).padStart(2, '0'))
              .join('');
            const ascii = Array.from(snap)
              .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
              .join('');
            // Interpret first 32 bytes as 8 little-endian floats — useful for
            // spotting player coords / physics state.
            const floats = [];
            const dv = new DataView(snap.buffer, snap.byteOffset, snap.byteLength);
            for (let i = 0; i + 4 <= Math.min(snap.byteLength, 32); i += 4) {
              floats.push(dv.getFloat32(i, true).toExponential(3));
            }
            console.log(`knDiag.dumpBlock(${blockIdx}, 0x${(blockIdx * 0x10000).toString(16)}, ${bytes}B):`);
            for (let i = 0; i < snap.length; i += 16) {
              const row = Array.from(snap.slice(i, i + 16))
                .map((b) => b.toString(16).padStart(2, '0'))
                .join(' ');
              const aRow = ascii.slice(i, i + 16);
              console.log(`  ${i.toString(16).padStart(4, '0')}: ${row}  ${aRow}`);
            }
            console.log(`  floats[0..7]: ${floats.join(' ')}`);
            return { hex, ascii, floats, bytes: snap };
          },
          // Comprehensive snapshot — captures everything we have access to in
          // a single call. Returns an object you can stash, share, or compare.
          // Optionally dumps raw bytes from `dumpBlocks` (array of block indices).
          snapshot(opts = {}) {
            const mod = getMod();
            if (!mod) return null;
            if (!ensureBufs(mod)) return null;
            const { dumpBlocks = [], byteCount = 256 } = opts;
            const out = {
              frame: mod._kn_get_frame?.() ?? null,
              rollbackCount: mod._kn_get_rollback_count?.() ?? null,
              predictionCount: mod._kn_get_prediction_count?.() ?? null,
              correctPredictions: mod._kn_get_correct_predictions?.() ?? null,
              maxDepth: mod._kn_get_max_depth?.() ?? null,
              failedRollbacks: mod._kn_get_failed_rollbacks?.() ?? null,
              clobberedPredictions: mod._kn_get_clobbered_predictions?.() ?? null,
              softfloatState: mod._kn_get_softfloat_state?.() ?? null,
              hiddenFingerprint: mod._kn_get_hidden_state_fingerprint?.() ?? null,
              gameplayHash: mod._kn_gameplay_hash?.(-1) ?? null,
              gameStateHash: mod._kn_game_state_hash?.(-1) ?? null,
              fullStateHash: mod._kn_full_state_hash?.(-1) ?? null,
              taintBlocks: null,
              taintCount: null,
              blockHashes: null,
              rawBlocks: {},
            };
            if (mod._kn_get_taint_blocks) {
              mod._kn_get_taint_blocks(_taintBuf, RDRAM_TAINT_BLOCKS);
              const t = new Uint8Array(mod.HEAPU8.buffer, _taintBuf, RDRAM_TAINT_BLOCKS);
              out.taintBlocks = Array.from(t);
              out.taintCount = out.taintBlocks.filter((x) => x).length;
            }
            if (mod._kn_rdram_block_hashes) {
              mod._kn_rdram_block_hashes(_hashBuf, RDRAM_TAINT_BLOCKS);
              const h = new Uint32Array(mod.HEAPU8.buffer, _hashBuf, RDRAM_TAINT_BLOCKS);
              out.blockHashes = Array.from(h).map((v) => (v >>> 0).toString(16).padStart(8, '0'));
            }
            if (mod._kn_get_rdram_ptr) {
              const rdramPtr = mod._kn_get_rdram_ptr();
              for (const idx of dumpBlocks) {
                const off = rdramPtr + idx * 0x10000;
                const slice = new Uint8Array(mod.HEAPU8.buffer, off, byteCount);
                out.rawBlocks[idx] = Array.from(slice)
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join('');
              }
            }
            console.log('knDiag.snapshot:', out);
            return out;
          },
          // Returns the current frame counter.
          frame() {
            const mod = getMod();
            return mod?._kn_get_frame?.() ?? null;
          },
          splitStateStats() {
            const mod = getMod();
            if (!mod?._kn_get_split_state_stats || !mod?._malloc || !mod.HEAPU32) {
              console.error('knDiag.splitStateStats: split state exports missing — rebuild WASM core.');
              return null;
            }
            const ptr = mod._malloc(8 * 4);
            if (!ptr) return null;
            try {
              const n = mod._kn_get_split_state_stats(ptr, 8);
              if (n <= 0) return null;
              const v = new Uint32Array(mod.HEAPU32.buffer, ptr, 8);
              const out = {
                backend: v[0] === 1 ? 'split-rdram' : 'retro',
                saves: v[1],
                restores: v[2],
                saveFailures: v[3],
                restoreFailures: v[4],
                lastCpuBytes: v[5],
                rdramBytes: v[6],
                cpuCapacity: v[7],
              };
              console.log('knDiag.splitStateStats:', out);
              return out;
            } finally {
              mod._free?.(ptr);
            }
          },
          shadowStats() {
            const stats = _shadowStatsSnapshot();
            console.log('knDiag.shadowStats:', stats);
            return stats;
          },
          // Helper: are we even running with the rollback core? Useful sanity check.
          ready() {
            const mod = getMod();
            const ok = !!mod?._kn_replay_self_test && !!mod?._kn_rdram_block_hashes && !!mod?._kn_get_taint_blocks;
            console.log(
              `knDiag.ready: ${ok ? 'YES' : 'NO'} ` +
                `(replay_self_test=${!!mod?._kn_replay_self_test}, ` +
                `block_hashes=${!!mod?._kn_rdram_block_hashes}, ` +
                `taint_blocks=${!!mod?._kn_get_taint_blocks})`,
            );
            return ok;
          },
        };
        return api;
      })());

  // Pending peer block-hash snapshots for desync localization. Key: frame.
  window._rbPendingBlocks = window._rbPendingBlocks || {};
  // Our own block-hash snapshots, sampled at the SAME time we sent them to
  // the peer. Used for frame-exact diff on mismatch — comparing live RDRAM
  // at diff-processing time would introduce temporal skew and produce false
  // "diffs" that are just the game advancing between sample and compare.
  window._rbLocalBlocks = window._rbLocalBlocks || {};
  window._rbLocalTaint = window._rbLocalTaint || {};

  // Full RDRAM hash — hashes all 128 × 64KB blocks (8MB total) via kn_rdram_block_hashes.
  // Returns a single uint32 combining all block hashes. ~1-2ms on mobile.
  let _rbHashBufPtr = 0;

  // Read input from C ring buffer for a given slot/frame.
  // Returns input object compatible with writeInputToMemory.
  const _rbGetInput = (mod, slot, frame) => {
    if (!_rbInputPtr || !mod._kn_get_input) return KNShared.ZERO_INPUT;
    const present = mod._kn_get_input(
      slot,
      frame,
      _rbInputPtr,
      _rbInputPtr + 4,
      _rbInputPtr + 8,
      _rbInputPtr + 12,
      _rbInputPtr + 16,
    );
    if (!present) return KNShared.ZERO_INPUT;
    const heap = new Int32Array(mod.HEAPU8.buffer, _rbInputPtr, 5);
    return { buttons: heap[0], lx: heap[1], ly: heap[2], cx: heap[3], cy: heap[4] };
  };

  const _feedCInput = (mod, slot, frame, input) => {
    if (!mod?._kn_feed_input || !input || slot === null || slot === undefined || frame < 0) return false;
    mod._kn_feed_input(
      Number(slot),
      Number(frame),
      input.buttons | 0,
      input.lx | 0,
      input.ly | 0,
      input.cx | 0,
      input.cy | 0,
    );
    return true;
  };

  const _backfillCInputsFromJs = (mod, reason) => {
    if (!mod?._kn_feed_input) return;
    const maxWindow = Math.min(240, Math.max(60, _rbRollbackMax + DELAY_FRAMES + 8));
    const startFrame = Math.max(0, _frameNum - maxWindow);
    let localFed = 0;
    let remoteFed = 0;

    for (let f = startFrame; f <= _frameNum; f++) {
      if (_feedCInput(mod, _playerSlot, f, _localInputs[f])) localFed++;
      for (const [slotKey, frames] of Object.entries(_remoteInputs)) {
        const slot = Number(slotKey);
        if (!Number.isFinite(slot) || slot === _playerSlot) continue;
        if (_feedCInput(mod, slot, f, frames?.[f])) remoteFed++;
      }
    }

    if (localFed || remoteFed) {
      _syncLog(
        `C-INPUT-BACKFILL reason=${reason} f=${_frameNum} range=${startFrame}-${_frameNum} ` +
          `local=${localFed} remote=${remoteFed}`,
      );
    }
  };

  // -- Audio (delegated to kn-audio.js / window.KNAudio) --
  // Canvas hash checks only run after reconnect events — during steady-state
  // gameplay, trust AI DMA determinism. GPU rendering differences between platforms
  // cause false-positive canvas mismatches that trigger unnecessary resyncs.
  let _peers = {}; // remoteSid -> PeerState
  let _knownPlayers = {}; // socketId -> {slot, playerName}

  // ── Boot phase enum ──────────────────────────────────────────────────
  // Linear progression replacing individual boolean flags. Integer ordering
  // lets guards use >= comparisons: "at least this far along".
  const PHASE_IDLE = 0;
  const PHASE_GAME_STARTED = 1; // startGameSequence() called
  const PHASE_EMU_READY = 2; // WASM core + Module available
  const PHASE_SYNCING = 3; // initial state sync in progress
  const PHASE_LOCKSTEP_READY = 4; // state loaded, ready for tick loop
  const PHASE_RUNNING = 5; // tick loop active
  const PHASE_STOPPED = 6; // tick loop stopped (game ended)
  let _phase = PHASE_IDLE;

  // ── Runtime sub-state enum ───────────────────────────────────────────
  // Mutually exclusive conditions during PHASE_RUNNING. Only one can be
  // active — if two booleans are ever set simultaneously, that's a bug.
  const RUN_NORMAL = 'normal';
  const RUN_PACING = 'pacing'; // frame advantage cap throttling
  const RUN_RB_STALL = 'rollback-stall'; // rollback engine waiting for peer
  const RUN_LATE_JOIN_PAUSE = 'late-join-pause'; // host paused for joiner
  const RUN_AWAITING_RESYNC = 'awaiting-resync'; // guest waiting for state
  let _runSubstate = RUN_NORMAL;

  // Legacy booleans — still the source of truth until fully migrated.
  // Each is set alongside _phase during the transition period.
  let _sessionId = 0; // incremented on each init() to invalidate stale timers
  let _romWaitInterval = null; // setInterval ID for guest ROM-wait polling
  let _p1KeyMap = null;
  const _heldKeys = new Set();

  const _syncRequestCooldowns = new Map();
  const _SYNC_REQUEST_COOLDOWN_MS = 5000;

  // Lockstep state
  let _lockstepReadyPeers = {}; // remoteSid -> true when peer signals lockstep-ready
  let _guestStateBytes = null; // decompressed state bytes to load
  let _guestStateKind = 'savestate'; // 'savestate' or 'kn-sync'
  let _lockstepStartStateKind = 'savestate'; // state kind that launched the current lockstep run
  let _guestStateHiddenWords = null; // host-side hidden state sidecar for startup
  let _guestStateAudioFifo = null; // host-side AI FIFO sidecar; kn-sync does not carry it
  let _guestStateCapturedLocally = false; // host already sits at this paused state
  let _frameNum = 0; // current logical frame number
  let _funnelMilestoneSent = false; // P0-1 funnel: fire milestone_reached once per session
  let _localInputs = {}; // frame -> input object
  let _remoteInputs = {}; // slot -> {frame -> input object} (nested for multi-peer)
  // ── Input audit buffers (Option G) ─────────────────────────────────
  // Delta-encoded grow-only log of inputs. A new entry is recorded ONLY
  // when the input differs from the previously recorded value for that
  // stream. Both peers run identical encoding logic, so if their input
  // histories are truly equivalent, their delta sequences will be
  // byte-identical and trivially comparable. Uploaded at match end as
  // part of the session-log flush.
  //
  // Format: array of { f, b, lx, ly, cx, cy } — "f" is the frame at
  // which the input CHANGED to these values (it remains this value until
  // the next entry's frame). Typical match produces ~2-5k entries (10
  // minutes × ~300 transitions/min), well under the 2 MB log cap.
  const _auditLocalInputs = [];
  const _auditRemoteInputs = {}; // slot -> entry array
  const _auditLastLocal = { b: null, lx: null, ly: null, cx: null, cy: null };
  const _auditLastRemote = {}; // slot -> last-value object
  const _inputButtons = (x) => (x?.buttons !== undefined ? x.buttons : x?.b);
  const _inputEq = (a, b) =>
    !!a &&
    !!b &&
    _inputButtons(a) === _inputButtons(b) &&
    a.lx === b.lx &&
    a.ly === b.ly &&
    a.cx === b.cx &&
    a.cy === b.cy;
  const _cloneInput = (input) => ({
    buttons: input?.buttons | 0,
    lx: input?.lx | 0,
    ly: input?.ly | 0,
    cx: input?.cx | 0,
    cy: input?.cy | 0,
  });
  const _resetInputAudit = () => {
    _auditLocalInputs.length = 0;
    for (const slot of Object.keys(_auditRemoteInputs)) delete _auditRemoteInputs[slot];
    _auditLastLocal.b = null;
    _auditLastLocal.lx = null;
    _auditLastLocal.ly = null;
    _auditLastLocal.cx = null;
    _auditLastLocal.cy = null;
    for (const slot of Object.keys(_auditLastRemote)) delete _auditLastRemote[slot];
  };
  const _cloneAuditEntries = (entries) =>
    entries.map((entry) => ({
      f: entry.f | 0,
      b: entry.b | 0,
      lx: entry.lx | 0,
      ly: entry.ly | 0,
      cx: entry.cx | 0,
      cy: entry.cy | 0,
    }));
  const _buildInputAuditPayload = () => {
    const remote = {};
    for (const [slot, entries] of Object.entries(_auditRemoteInputs)) {
      remote[slot] = _cloneAuditEntries(entries);
    }
    return {
      localCount: _auditLocalInputs.length,
      remoteCount: Object.fromEntries(Object.entries(_auditRemoteInputs).map(([s, a]) => [s, a.length])),
      local: _cloneAuditEntries(_auditLocalInputs),
      remote,
    };
  };
  const _auditRecordLocal = (frame, input) => {
    if (_auditLocalInputs.length > 0 && _inputEq(input, _auditLastLocal)) return;
    _auditLocalInputs.push({
      f: frame,
      b: input.buttons,
      lx: input.lx,
      ly: input.ly,
      cx: input.cx,
      cy: input.cy,
    });
    _auditLastLocal.b = input.buttons;
    _auditLastLocal.lx = input.lx;
    _auditLastLocal.ly = input.ly;
    _auditLastLocal.cx = input.cx;
    _auditLastLocal.cy = input.cy;
    if (input.buttons || input.lx || input.ly || input.cx || input.cy) {
      _syncLog(
        `LOCAL-INPUT slot=${_playerSlot} f=${frame} b=${input.buttons} lx=${input.lx} ly=${input.ly} cx=${input.cx} cy=${input.cy}`,
      );
    }
  };
  const _auditRecordRemote = (slot, frame, input) => {
    if (!_auditRemoteInputs[slot]) {
      _auditRemoteInputs[slot] = [];
      _auditLastRemote[slot] = { b: null, lx: null, ly: null, cx: null, cy: null };
    }
    if (_auditRemoteInputs[slot].length > 0 && _inputEq(input, _auditLastRemote[slot])) return;
    _auditRemoteInputs[slot].push({
      f: frame,
      b: input.buttons,
      lx: input.lx,
      ly: input.ly,
      cx: input.cx,
      cy: input.cy,
    });
    const last = _auditLastRemote[slot];
    last.b = input.buttons;
    last.lx = input.lx;
    last.ly = input.ly;
    last.cx = input.cx;
    last.cy = input.cy;
  };
  let _peerInputStarted = {}; // slot -> true once first input received (survives buffer drain)
  let _activeRoster = null; // Set<number> of active slots — host-authoritative, null until first roster
  let _rosterChangeFrame = -1; // frame when roster last changed — enables dense DIAG-INPUT logging
  let _lastControllerPresentMask = -1;
  let _lastControllerPresentMaskModule = null;
  const MENU_START_BARRIER_SETTLE_MS = 500;
  let _menuStartBarrierReleased = false;
  let _menuStartLocalReady = false;
  let _menuStartLocalScene = 0;
  let _menuStartReleaseAt = 0;
  let _menuStartReadyPeers = {}; // slot -> { frame, scene }
  let _menuStartReadyLastBroadcast = 0;
  const PHASE_BROADCAST_INTERVAL_MS = 100;
  const PHASE_STALE_MS = 1500;
  const PHASE_TRANSITION_GRACE_FRAMES = 12;
  let _peerPhases = {}; // slot -> { frame, sceneCurr, gameStatus, gameplay, seenAt }
  let _phaseMismatchGrace = {}; // slot -> { key, frame }
  let _lastPhaseBroadcastAt = 0;
  let _lastPhaseBroadcastKey = '';
  let _lastPeerPhaseWaitLogFrame = -1;
  const INITIAL_SMASH_TITLE_TIMEOUT_MS = 60000;
  const INITIAL_SMASH_TITLE_SETTLE_FRAMES = 30;
  const INITIAL_SMASH_MENU_FALLBACK_MS = 8000;
  const INITIAL_SMASH_MENU_SETTLE_MS = 500;
  const INITIAL_SMASH_FALLBACK_SCENES = new Set([55]);
  const INITIAL_SMASH_CONFIRM_SCENES = new Set([55]);
  const INITIAL_SMASH_CONFIRM_AFTER_MS = 2500;
  const INITIAL_SMASH_CONFIRM_INTERVAL_MS = 1200;
  const INITIAL_SMASH_CONFIRM_HOLD_MS = 90;
  const INITIAL_SMASH_CONFIRM_INPUT = Object.freeze({ buttons: (1 << 0) | (1 << 3), lx: 0, ly: 0, cx: 0, cy: 0 });
  // Remix title/menu startup must avoid the RetroArch RASTATE load path:
  // reloading that savestate can strand Remix on its yellow/thread-interrupt
  // screen. Use the C-level snapshot plus hidden-state sidecar instead.
  const REMIX_INITIAL_SYNC_USE_KN_SYNC = true;
  let _lateJoin = false; // true when joining a game already in progress
  let _lateJoinPausedAt = 0; // I1 (MF5): wall-clock when late-join pause began
  const _lateJoinReadyHandled = new Set(); // senderSid values already resumed
  const _pendingLateJoinReadySids = new Set(); // ready arrived before host DC opened
  const _pendingLateJoinPeerSids = new Set(); // running-phase players not active until late-join-ready
  const _pendingLateJoinPeerSlots = new Set(); // same gate, indexed by slot for non-host roster updates
  const LATE_JOIN_ACTIVATION_GRACE_FRAMES = 45; // let an activated joiner send first phase/input packets
  const LATE_JOIN_INPUT_BOOTSTRAP_FRAMES = 24; // deterministic zero-input ramp after roster activation
  let _lateJoinActivatedAtFrame = {}; // slot -> local frame where pending gate was lifted
  let _lateJoinInputBootstrapUntilFrame = -1;
  let _lateJoinSeededInputFrames = {}; // slot -> Set<frame> seeded as deterministic late-join zeros
  let _lateJoinReadyRetryTimer = null;

  // Smash Remix ROM hashes (for game-specific RNG/settings sync).
  // Must match hashes in server/config/known_roms.json.
  const _SMASH_REMIX_HASHES = new Set([
    'S73855bdf5e8753c546a31e278dfe558c3eaa575b97752c1d95950d66b1161130', // v2.0.0
    'S7efec9e0983656bb0219a23c511cd1505a5f84d524e50ad4284dc1c7eb4d1403', // v2.0.1
  ]);
  const _isSmashRemix = () =>
    _config?.gameId === 'smash-remix' || KNState?.gameId === 'smash-remix' || _SMASH_REMIX_HASHES.has(_config?.romHash);

  const _getRuntimeFamily = () => {
    const ua = navigator.userAgent || '';
    const platform = navigator.platform || '';
    const isiOS = /iPhone|iPad|iPod/i.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isiOS) return 'webkit-jsc';
    if (/Firefox/i.test(ua)) return 'firefox-spidermonkey';
    if (/Chrome|Chromium|CriOS|Edg|OPR/i.test(ua)) return 'chromium-v8';
    if (/Safari/i.test(ua)) return 'webkit-jsc';
    return 'unknown';
  };

  const _isSameRomEmulatorResume = () => {
    const ctx = window.KNEmulatorResumeContext;
    if (!ctx?.reused || !ctx?.sameRom) return false;
    return !ctx.romHash || !_config?.romHash || ctx.romHash === _config.romHash;
  };

  const _isValidPlayerSlot = (slot) => Number.isInteger(slot) && slot >= 0 && slot < 4;

  const _consumeLateJoinSeededInput = (slot, frame) => {
    const seeded = _lateJoinSeededInputFrames[slot];
    if (!seeded?.has(frame)) return false;
    seeded.delete(frame);
    if (seeded.size === 0) delete _lateJoinSeededInputFrames[slot];
    return true;
  };

  const _seedLateJoinZeroInput = (slot, frame) => {
    if (!_isValidPlayerSlot(slot) || slot === _playerSlot || frame < 0) return false;
    if (!_remoteInputs[slot]) _remoteInputs[slot] = {};
    if (_remoteInputs[slot][frame] !== undefined) return false;
    _remoteInputs[slot][frame] = KNShared.ZERO_INPUT;
    if (!_lateJoinSeededInputFrames[slot]) _lateJoinSeededInputFrames[slot] = new Set();
    _lateJoinSeededInputFrames[slot].add(frame);
    if (_useCRollback) {
      _pendingCInputs.push({
        slot,
        frame,
        buttons: 0,
        lx: 0,
        ly: 0,
        cx: 0,
        cy: 0,
      });
    }
    return true;
  };

  const _lateJoinBootstrapSlots = (extraSlots = []) => {
    const slots = new Set();
    const add = (slot) => {
      if (_isValidPlayerSlot(slot)) slots.add(slot);
    };
    if (_activeRoster) {
      for (const slot of _activeRoster) add(slot);
    }
    for (const slot of extraSlots) add(slot);
    for (const info of Object.values(_knownPlayers)) add(info?.slot);
    for (const peer of Object.values(_peers)) add(peer?.slot);
    add(_playerSlot);
    return [...slots].filter((slot) => slot !== _playerSlot);
  };

  const _startLateJoinInputBootstrap = (reason = '', extraSlots = []) => {
    if (!_isSmashRemix()) return;
    if (!_isValidPlayerSlot(_playerSlot)) return;
    const startFrame = Math.max(0, _frameNum - DELAY_FRAMES - 2);
    const endFrame = _frameNum + Math.max(LATE_JOIN_INPUT_BOOTSTRAP_FRAMES, DELAY_FRAMES * 4);
    _lateJoinInputBootstrapUntilFrame = Math.max(_lateJoinInputBootstrapUntilFrame, endFrame + 1);

    const slots = _lateJoinBootstrapSlots(extraSlots);
    let seeded = 0;
    for (const slot of slots) {
      for (let f = startFrame; f <= endFrame; f++) {
        if (_seedLateJoinZeroInput(slot, f)) seeded++;
      }
    }

    _bootStallFrame = -1;
    _bootStallStartTime = 0;
    _bootStallRecoveryFired = false;
    _syncLog(
      `late-join input bootstrap: frames=${startFrame}-${endFrame} slots=[${slots.join(',')}] ` +
        `seeded=${seeded} suppressLocalUntil=${_lateJoinInputBootstrapUntilFrame}` +
        `${reason ? ` reason=${reason}` : ''}`,
    );
  };

  const _isPeerPendingLateJoin = (sid, peer = null) => {
    const resolvedPeer = peer || (sid ? _peers[sid] : null);
    if (resolvedPeer?.synthetic === true) return false;
    const slot = resolvedPeer?.slot ?? (sid ? _knownPlayers[sid]?.slot : null);
    return (
      (sid && _pendingLateJoinPeerSids.has(sid)) || (_isValidPlayerSlot(slot) && _pendingLateJoinPeerSlots.has(slot))
    );
  };

  const _markLateJoinActivated = (slot, reason = '') => {
    if (!_isValidPlayerSlot(slot)) return;
    _lateJoinActivatedAtFrame[slot] = _frameNum;
    _peerLastAdvanceTime[slot] = performance.now();
    _syncLog(`late-join activation grace: slot=${slot} f=${_frameNum}${reason ? ` reason=${reason}` : ''}`);
  };

  const _isLateJoinActivationGrace = (slot) => {
    const activatedAt = _lateJoinActivatedAtFrame[slot];
    return (
      _isValidPlayerSlot(slot) &&
      Number.isFinite(activatedAt) &&
      _frameNum >= activatedAt &&
      _frameNum - activatedAt < LATE_JOIN_ACTIVATION_GRACE_FRAMES
    );
  };

  const _slotAlreadyActive = (slot) =>
    _isValidPlayerSlot(slot) &&
    (slot === _playerSlot ||
      _activeRoster?.has(slot) ||
      !!_peerInputStarted[slot] ||
      _lastRemoteFramePerSlot[slot] !== undefined);

  const _markPendingLateJoinPeer = (sid, slot, reason = '') => {
    if (!sid || !_isValidPlayerSlot(slot)) return;
    const wasPending = _pendingLateJoinPeerSids.has(sid) || _pendingLateJoinPeerSlots.has(slot);
    _pendingLateJoinPeerSids.add(sid);
    _pendingLateJoinPeerSlots.add(slot);
    delete _lateJoinActivatedAtFrame[slot];
    delete _remoteInputs[slot];
    delete _peerInputStarted[slot];
    delete _lastRemoteFramePerSlot[slot];
    delete _peerPhases[slot];
    delete _phaseMismatchGrace[slot];
    delete _menuStartReadyPeers[slot];
    delete _lateJoinSeededInputFrames[slot];
    for (let i = _pendingCInputs.length - 1; i >= 0; i--) {
      if (_pendingCInputs[i].slot === slot) _pendingCInputs.splice(i, 1);
    }
    if (!wasPending) _syncLog(`late-join pending: sid=${sid} slot=${slot}${reason ? ` reason=${reason}` : ''}`);
  };

  const _clearPendingLateJoinPeer = (sid, slot, reason = '', opts = {}) => {
    let cleared = false;
    if (sid && _pendingLateJoinPeerSids.delete(sid)) cleared = true;
    if (_isValidPlayerSlot(slot) && _pendingLateJoinPeerSlots.delete(slot)) cleared = true;
    if (cleared) {
      _syncLog(
        `late-join activated/cleared: sid=${sid || 'unknown'} slot=${slot ?? 'unknown'}${reason ? ` reason=${reason}` : ''}`,
      );
      if (opts.activate) {
        _markLateJoinActivated(slot, reason);
        _startLateJoinInputBootstrap(reason, [slot]);
      }
    }
  };

  const _clearPendingLateJoinRosterSlots = (slots, reason = '') => {
    const slotSet = new Set(slots.filter(_isValidPlayerSlot));
    for (const [sid, peer] of Object.entries(_peers)) {
      if (slotSet.has(peer?.slot)) _clearPendingLateJoinPeer(sid, peer.slot, reason, { activate: true });
    }
    for (const slot of slotSet) {
      if (_pendingLateJoinPeerSlots.has(slot)) _clearPendingLateJoinPeer(null, slot, reason, { activate: true });
    }
  };

  const _dropPendingLateJoinPeersMissingFromRoster = (players) => {
    const liveSids = new Set(
      Object.values(players)
        .map((p) => p.socketId)
        .filter(Boolean),
    );
    const liveSlots = new Set(
      Object.values(players)
        .map((p) => p.slot)
        .filter(_isValidPlayerSlot),
    );
    for (const sid of [..._pendingLateJoinPeerSids]) {
      if (!liveSids.has(sid)) _clearPendingLateJoinPeer(sid, _knownPlayers[sid]?.slot, 'users-updated missing sid');
    }
    for (const slot of [..._pendingLateJoinPeerSlots]) {
      if (!liveSlots.has(slot)) _clearPendingLateJoinPeer(null, slot, 'users-updated missing slot');
    }
  };

  const _controllerPresentMask = () => {
    const slots = new Set();
    const addSlot = (slot) => {
      if (Number.isInteger(slot) && slot >= 0 && slot < 4) slots.add(slot);
    };

    // Demo mode: count synthetic peers as real controllers so SSB64 sees
    // them as "plugged in" and processes their inputs (CSS cursor, in-game
    // movement). In normal multiplayer, synthetic peers are excluded
    // because they don't represent a physical opponent.
    const includeSynthetic = _demoMode === true;

    if (_activeRoster) {
      const syntheticSlots = new Set(
        Object.values(_peers)
          .filter((peer) => peer?.synthetic === true)
          .map((peer) => peer.slot),
      );
      for (const slot of _activeRoster) {
        if (includeSynthetic || !syntheticSlots.has(slot)) addSlot(slot);
      }
    } else {
      addSlot(_playerSlot);
      for (const [sid, info] of Object.entries(_knownPlayers)) {
        if (!includeSynthetic && _peers[sid]?.synthetic === true) continue;
        if (!_isPeerPendingLateJoin(sid)) addSlot(info?.slot);
      }
      for (const [sid, peer] of Object.entries(_peers)) {
        if (!includeSynthetic && peer?.synthetic === true) continue;
        if (_isPeerPendingLateJoin(sid, peer)) continue;
        if (!peer?._intentionalLeave) addSlot(peer?.slot);
      }
    }
    addSlot(_playerSlot);

    let mask = 0;
    for (const slot of slots) mask |= 1 << slot;
    return mask & 0x0f;
  };

  const _applyControllerPresentMask = (reason = 'tick') => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?._kn_set_controller_present_mask) return;
    const mask = _controllerPresentMask();
    if (!mask) return;
    if (mod === _lastControllerPresentMaskModule && mask === _lastControllerPresentMask) return;
    _lastControllerPresentMaskModule = mod;
    _lastControllerPresentMask = mask;
    mod._kn_set_controller_present_mask(mask);
    _syncLog(`controller present mask (${reason}): 0x${mask.toString(16)}`);
  };

  // Apply the real player-count mask the *instant* the WASM export is
  // callable, before EmulatorJS schedules its first retro_run frame. Without
  // this, the C-side default of 0x0f makes SSB64 see all four pads as
  // present during the ~150-frame boot sequence — and when we narrow the
  // mask later (at PHASE_EMU_READY) ports 3+4 visibly toggle off on CSS.
  // Polled because the WASM module instantiates asynchronously and there is
  // no synchronous "module ready" hook from EmulatorJS.
  let _earlyMaskApplied = false;
  let _earlyMaskPoller = null;
  const _scheduleEarlyControllerMask = () => {
    _earlyMaskApplied = false;
    if (_earlyMaskPoller) {
      clearInterval(_earlyMaskPoller);
      _earlyMaskPoller = null;
    }
    const start = performance.now();
    _earlyMaskPoller = setInterval(() => {
      if (_earlyMaskApplied) {
        clearInterval(_earlyMaskPoller);
        _earlyMaskPoller = null;
        return;
      }
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (mod?._kn_set_controller_present_mask) {
        _applyControllerPresentMask('wasm-ready');
        _earlyMaskApplied = true;
        clearInterval(_earlyMaskPoller);
        _earlyMaskPoller = null;
        _syncLog(`early controller mask applied after ${Math.round(performance.now() - start)}ms`);
      } else if (performance.now() - start > 30000) {
        clearInterval(_earlyMaskPoller);
        _earlyMaskPoller = null;
        _syncLog('early controller mask: WASM export never appeared within 30s');
      }
    }, 16);
  };

  // _resetControllerPresentMask was previously called on stopSync to write
  // 0x0f back to the C engine. That left the next emulator boot starting
  // with all 4 ports "present" until JS narrowed it again — the same toggle
  // bug we fix above. Don't write a stale default; just clear our local
  // bookkeeping so the next boot's _applyControllerPresentMask issues a
  // fresh C call against whatever the new player count is.
  const _resetControllerPresentMask = () => {
    _lastControllerPresentMask = -1;
    _lastControllerPresentMaskModule = null;
    _earlyMaskApplied = false;
    if (_earlyMaskPoller) {
      clearInterval(_earlyMaskPoller);
      _earlyMaskPoller = null;
    }
  };

  // -- Smash Remix RNG state addresses --
  // Keep these for late-join state transfer and diagnostics. The live per-frame
  // path below deliberately does not force-write them; older attempts touched
  // version-dependent RNG/frame-counter addresses and created new risk.
  const KN_RNG_SEED_RDRAM = 0x0003b940; // sSYUtilsRandomSeed
  const KN_RNG_ALT_SEED_RDRAM = 0x000a0578; // alternate seed
  const KN_FRAME_COUNTER_RDRAM = 0x0003cb30; // Global.frame_counter (get_random_int_safe_ uses fc%64)
  // ── Per-game RDRAM addresses ──────────────────────────────────────────
  // Keep SSB64 base and Smash Remix addresses physically separate. These
  // games store game state at different RDRAM offsets; conflating them
  // (e.g. applying decomp-derived addresses to Remix or vice versa) silently
  // breaks rollback gating and was the cause of the 2026-04-29 regression.
  // Always cite the source file when adding/changing a constant here.
  //
  // scene_curr — happens to be the same in both games (verified):
  //   SSB64 base: gSCManagerSceneData @ 0x800A4AD0
  //     (ssb-decomp/src/sc/scmanager.c:29-30, struct SCCommonData.scene_curr at offset 0)
  //   Smash Remix: current_screen @ 0x800A4AD0
  //     (smashremix/src/Global.asm: `constant current_screen(0x800A4AD0)`)
  const KN_SCENE_CURR_RDRAM = 0x000a4ad0;

  // game_status — DIFFERS by game. Used to gate rollback prediction:
  // during menus (status != 1), rollback's stash-and-restore only preserves
  // in-match gameplay state, so we run pure lockstep there. Byte semantics:
  // 0=wait, 1=ongoing, 2=paused, 5=end.
  //
  //   Smash Remix: game_status @ 0x800A4D19
  //     (smashremix/src/Global.asm:165: `constant game_status(0x800A4D19)`)
  //     Word-aligned 0x000a4d18, byte 1 of the BE word = game_status.
  const KN_REMIX_GAME_STATUS_WORD_RDRAM = 0x000a4d18;
  //   SSB64 base: gSCManagerBattleState->game_status — VS state struct
  //     at RDRAM 0xA4EF8 (kn_gameplay_addrs.h KN_ADDR_VS_BATTLE_HEADER),
  //     struct offset 0x11 (ssb-decomp/src/sc/sctypes.h SCBattleState).
  //     Word-aligned 0x000a4f08, byte 1 of the BE word = game_status.
  //   Currently unused (no SSB64-base reader today; menu phase logic is
  //   gated on _isSmashRemix elsewhere). Defined so future SSB64-base
  //   callers use the right address and don't accidentally pull the
  //   Remix one.
  const KN_SSB64_GAME_STATUS_WORD_RDRAM = 0x000a4f08;
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

  // Read game_status from RDRAM. Returns 1 when the match is actively
  // running (gameplay), 0 during menus/CSS/stage-select, or -1 if RDRAM
  // isn't available yet or this is a non-Remix game (no reader wired).
  //
  // BYTE ORDER: mupen64plus stores RDRAM in host (little-endian) byte
  // order. N64 byte 1 of a BE word is at LE offset (byte_offset ^ 3).
  // Using HEAPU32 + shift avoids XOR-3 confusion: read the 32-bit word
  // at the word-aligned address, then extract the correct byte position.
  let _inGameplay = false;
  let _inGameplayLoggedAt = -1; // frame where we last logged a transition
  const _readGameStatus = () => {
    if (!_rdramBase || !_isSmashRemix()) return -1;
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?.HEAPU32) return -1;
    const word = mod.HEAPU32[(_rdramBase + KN_REMIX_GAME_STATUS_WORD_RDRAM) >> 2];
    return (word >> 16) & 0xff;
  };

  const _readSceneCurr = () => {
    if (!_isSmashRemix()) return 0;
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!_rdramBase || !mod?.HEAPU8) return 0;
    return mod.HEAPU8[_rdramBase + (KN_SCENE_CURR_RDRAM ^ 3)] & 0xff;
  };

  const _isControllableMenuScene = (scene) => {
    // Smash Remix / SSB64 scenes: 1=Title, 7=Mode Select, 8-21=menus,
    // CSS, stage select, and 55=Remix startup/menu shell. These screens
    // are edge-sensitive: predicting or fabricating one A/Start/down frame
    // can put peers on different paths.
    return scene === 1 || (scene >= 7 && scene <= 21) || INITIAL_SMASH_FALLBACK_SCENES.has(scene);
  };

  const _readMenuLockstepPhase = (enabled) => {
    const gameStatus = _readGameStatus();
    const sceneCurr = _readSceneCurr();
    const inControllableMenu = _isControllableMenuScene(sceneCurr);
    const inBattleTransition = sceneCurr === 22 && gameStatus === 0;
    const gameplay = sceneCurr === 22 && gameStatus === 1;
    const strictInputLockstep = !inBattleTransition && (inControllableMenu || (sceneCurr === 22 && gameStatus === 2));
    return {
      gameStatus,
      sceneCurr,
      inControllableMenu,
      inBattleTransition,
      gameplay,
      strictInputLockstep,
      active: _isSmashRemix() && (inControllableMenu || (!!enabled && gameStatus >= 0 && gameStatus !== 1)),
    };
  };

  const _readStrictPhaseLock = (enabled) => {
    const phase = _readMenuLockstepPhase(enabled);
    const waitingPeerSlots = [];
    const phaseMismatchSlots = [];
    const notePhaseMismatch = (slot) => {
      if (!phaseMismatchSlots.includes(slot)) phaseMismatchSlots.push(slot);
    };

    if (_isSmashRemix() && !!enabled) {
      const shouldAlignPhase = phase.gameplay || phase.strictInputLockstep;
      const nowMs = performance.now();
      for (const p of getActivePeers()) {
        if (p.synthetic === true) continue;
        if (p.reconnecting || p.slot === null || p.slot === undefined || _peerPhantom[p.slot]) continue;
        if (_isLateJoinActivationGrace(p.slot)) continue;
        const peerPhase = _peerPhases[p.slot];
        if (!peerPhase || nowMs - (peerPhase.seenAt || 0) > PHASE_STALE_MS) {
          delete _phaseMismatchGrace[p.slot];
          if (shouldAlignPhase) notePhaseMismatch(p.slot);
          if (shouldAlignPhase) waitingPeerSlots.push(p.slot);
          continue;
        }
        if (phase.gameplay) {
          delete _phaseMismatchGrace[p.slot];
          if (!peerPhase.gameplay) {
            notePhaseMismatch(p.slot);
            if (peerPhase.frame < _frameNum) waitingPeerSlots.push(p.slot);
          }
          continue;
        }
        if (!shouldAlignPhase) {
          delete _phaseMismatchGrace[p.slot];
          continue;
        }

        const peerAligned = peerPhase.sceneCurr === phase.sceneCurr && peerPhase.gameStatus === phase.gameStatus;
        if (peerAligned) {
          delete _phaseMismatchGrace[p.slot];
          continue;
        }

        notePhaseMismatch(p.slot);

        // Scene changes are observed after a frame has already advanced on the
        // peer that got there first. Give this peer a few real-input-backed
        // frames to land in the same menu before treating the phase as stuck.
        const mismatchKey = `${phase.sceneCurr}:${phase.gameStatus}->${peerPhase.sceneCurr}:${peerPhase.gameStatus}`;
        const grace = _phaseMismatchGrace[p.slot];
        if (!grace || grace.key !== mismatchKey) {
          _phaseMismatchGrace[p.slot] = { key: mismatchKey, frame: _frameNum };
          continue;
        }
        if (_frameNum - grace.frame < PHASE_TRANSITION_GRACE_FRAMES) continue;

        if (peerPhase.frame < _frameNum) waitingPeerSlots.push(p.slot);
      }
    }

    return {
      ...phase,
      localActive: phase.active,
      waitingPeerSlots,
      phaseMismatchSlots,
      active: phase.active || waitingPeerSlots.length > 0,
    };
  };

  const _isRbCheckGameplayPhase = () => {
    // RB-CHECK validates rollback determinism. Smash Remix menus and post-match
    // results are guarded by strict lockstep/setup checks instead; hashing them
    // here turns harmless post-match menu drift into a false rollback desync.
    return !_isSmashRemix() || _readMenuLockstepPhase(false).gameplay;
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
    // Do not force-write Smash Remix RNG fields every frame. The rollback C
    // audit proved 0x03CB30 is dSYAudioCurrentTic, not a gameplay frame
    // counter, and the alternate seed address is Remix-version dependent.
    // Let the game advance RNG naturally; the host-authoritative initial title
    // state keeps CSS/menu random selection aligned without live RDRAM writes.
    void mod;
    void frameNum;
  };

  // Manual mode / rAF interception state (native refs managed by APISandbox)
  let _pendingRunner = null; // captured Emscripten MainLoop_runner
  let _manualMode = false; // true once enterManualMode() called
  let _stallStart = 0; // timestamp when current stall began
  let _resendSent = false; // true once resend request sent for current stall
  // I1 (MF4): INPUT-STALL hard-timeout fabricates ZERO_INPUT to keep
  // the game moving, but any real inputs that arrive later are dropped
  // — creating permanent hash divergence. When hard-timeout fires, we
  // also request a full resync so the divergence converges. Rate-limited
  // so we don't resync-storm under sustained marginal WiFi.
  let _lastInputStallResyncAt = 0;
  const INPUT_STALL_RESYNC_COOLDOWN_MS = 10000;
  let _awaitingLateJoinState = false; // true when late-join path taken, prevents normal sync
  let _isApplyingLateJoinState = false; // re-entrancy guard for handleLateJoinState (rejects dup state packets mid-load)
  let _tickInterval = null; // setInterval handle for tick scheduler pump
  let _externalTickPaused = false; // demo/UI pause: gates the tick callback without tearing down state
  let _tickNextAt = 0;
  const TICK_TARGET_MS = 1000 / 60;
  const TICK_PUMP_INTERVAL_MS = 6;
  // Saved originals of WASM speed-control functions — neutralized during lockstep
  let _origToggleFF = null; // Module._toggle_fastforward
  let _origToggleSM = null; // Module._toggle_slow_motion

  // State sync — host-authoritative guest reloads for recovery paths.
  let _syncEnabled = false; // enabled by default at init; host can disable from the toolbar
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
  let _lastResyncToastTime = 0; // wall-clock ms of last 'Desync corrected' toast (throttle)
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
  // Sized so a 60-minute match at ~17 events/sec/peer fits without dropping
  // boot/menu entries off the front. The earlier 10K cap rotated out the
  // first ~5 min of a 10-min match, hiding desync triggers like the
  // MENU→GAMEPLAY init sequence behind already-discarded entries.
  // ~150 B/entry ⇒ ~9 MB peak; survivable on iOS Safari.
  const SYNC_LOG_MAX = 60000;
  const _syncLogRing = KNShared.createSyncLogRing(SYNC_LOG_MAX);
  let _startTime = 0;

  const _isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const SYNC_LOG_FLUSH_MS = _isLocalDev && _knLiveFlush ? 1000 : 5000;
  const _knVerboseSyncConsole = (() => {
    try {
      return _urlParams.get('verbose') === '1' || _urlParams.has('debug') || localStorage.getItem('kn-debug') === '1';
    } catch (_) {
      return _urlParams.get('verbose') === '1' || _urlParams.has('debug');
    }
  })();
  const _isConsoleCriticalSyncLog = (msg) => {
    const text = String(msg);
    return (
      text.includes('MISMATCH') ||
      text.includes('STATE-DRIFT') ||
      text.includes('FATAL') ||
      text.includes('RB-INVARIANT') ||
      text.includes('REPLAY-NORUN') ||
      text.includes('RB-LIVE-MISMATCH') ||
      text.includes('AUDIO-DEATH') ||
      text.includes('DESYNC') ||
      text.includes('GP-D') ||
      text.includes('REGION-DIFF') ||
      text.includes('BOOT-SYNC') ||
      text.includes('reconnect') ||
      text.includes('RECOVERY') ||
      text.includes('STUCK')
    );
  };
  const _syncLog = (msg) => {
    _syncLogRing.push({ t: performance.now(), f: _frameNum, msg });
    if (_knVerboseSyncConsole || _isConsoleCriticalSyncLog(msg)) {
      console.log(`[lockstep] ${msg}`);
    }
    // Flush on critical events only; periodic flushing is installed at
    // startLockstep(). Flushing every local-dev log entry serializes the full
    // growing input audit and can stall the game loop for seconds during
    // pacing-heavy sessions. Use ?knflush=live only for short diagnostics.
    const critical =
      msg.includes('MISMATCH') ||
      msg.includes('STATE-DRIFT') ||
      msg.includes('GP-D') ||
      msg.includes('REGION-DIFF') ||
      msg.includes('BOOT-SYNC') ||
      msg.includes('reconnect') ||
      msg.includes('RECOVERY') ||
      msg.includes('STUCK');
    if (critical || (_isLocalDev && _knLiveFlush)) {
      try {
        _flushSyncLog();
      } catch (_) {}
    }
  };
  window._knSyncLog = _syncLog;

  // Format a STEP-THREW log line including a truncated stack trace.
  // The Asyncify export wrapper in the WASM JS shim hides the C-side
  // line info, but the JS frames around it (Asyncify.maybeStopUnwind,
  // wasm-function names if symbol-stripped) are enough to narrow the
  // failing export. Stack is the only differentiator beyond
  // "Aborted(unreachable)" without rebuilding the core with -sASSERTIONS.
  // Cap length so a deep stack doesn't blow the 10KB log entry budget.
  const _formatStepThrew = (branch, e) => {
    const name = e?.name || 'Error';
    const message = e?.message || String(e);
    let stack = e?.stack || '';
    // Drop the first line if it just repeats name+message (V8 does this).
    if (stack.startsWith(name) || stack.startsWith(`${name}:`)) {
      const nl = stack.indexOf('\n');
      if (nl > -1) stack = stack.slice(nl + 1);
    }
    // Compress whitespace, trim leading "    at " noise, cap to 1500 chars.
    stack = stack
      .split('\n')
      .map((l) => l.trim().replace(/^at\s+/, ''))
      .filter(Boolean)
      .slice(0, 16)
      .join(' | ');
    if (stack.length > 1500) stack = stack.slice(0, 1500) + '…';

    // Rollback-engine breadcrumb. The cached-interpreter trap doesn't unwind
    // through C, so we read the volatile globals C wrote on its way through.
    // Phase IDs come from build/inject-rb-probes.py:
    //   10=preTick entry, 20/21=endpointSave pre/post, 30/31=pacingSave pre/post,
    //   40/41=rollback unserialize pre/post, 50/51=replaySave pre/post,
    //   60/61=normalSave pre/post, 70/71/72=preTick exit (normal/replay/pacing-skip),
    //   80=postTick entry, 100/101=inside rb_save_slot pre/post retro_serialize.
    let rb = '';
    const m = window.EJS_emulator?.gameManager?.Module;
    if (m?._kn_get_diag_rb_phase) {
      try {
        rb =
          ` rb=phase:${m._kn_get_diag_rb_phase()}` +
          `,f:${m._kn_get_diag_rb_frame()}` +
          `,slot:${m._kn_get_diag_rb_save_slot()}` +
          `,serN:${m._kn_get_diag_rb_serialize_count()}` +
          `,serRet:${m._kn_get_diag_rb_serialize_ret()}` +
          `,unsN:${m._kn_get_diag_rb_unserialize_count()}` +
          `,unsF:${m._kn_get_diag_rb_unserialize_frame()}` +
          `,unsRet:${m._kn_get_diag_rb_unserialize_ret()}`;
      } catch (_) {
        rb = ' rb=read-failed';
      }
    }
    return `STEP-THREW f=${_frameNum} branch=${branch}: ${name}: ${message}${rb} | stack=${stack}`;
  };

  // MF6: Detection-only tick watchdog snapshot emitter. Gathers a
  // rich view of every candidate stall state so the analyzer can
  // attribute a stuck frame to a specific root cause. Does NOT take
  // recovery action — see docs/netplay-invariants.md for the
  // philosophy behind this being passive.
  const _emitTickStuckSnapshot = (severity, stuckMs) => {
    const peerSnap = {};
    for (const [sid, p] of Object.entries(_peers)) {
      peerSnap[sid] = {
        slot: p.slot,
        dc: p.dc?.readyState ?? 'null',
        buffered: p.dc?.bufferedAmount ?? 0,
        lastFrameFromPeer: p.lastFrameFromPeer ?? -1,
        lastAckAdvanceMs: p.lastAckAdvanceTime > 0 ? Math.round(performance.now() - p.lastAckAdvanceTime) : -1,
        phantom: !!_peerPhantom?.[p.slot],
        lastRemoteFrame: _lastRemoteFramePerSlot?.[p.slot] ?? -1,
        bufSize: Object.keys(_remoteInputs?.[p.slot] || {}).length,
      };
    }

    // Inferred cause: pick the most likely culprit flag so the log
    // line is immediately actionable without needing to parse the
    // full peer snapshot. Order matters — we check the most specific
    // causes first.
    let cause = 'unknown';
    if (_wasmStepActive) cause = 'wasm-step-frozen';
    else if (window._rbPendingInit) cause = 'rb-pending-init';
    else if (_runSubstate === RUN_AWAITING_RESYNC) cause = 'awaiting-resync';
    else if (_syncTargetFrame > 0) cause = `coord-sync-waiting-for-f${_syncTargetFrame}`;
    else if (_bootStallFrame >= 0) cause = `boot-lockstep-f${_bootStallFrame}`;
    else if (_stallStart > 0) cause = 'input-stall';
    else if (_runSubstate === RUN_RB_STALL) cause = 'rollback-stall';
    else if (_runSubstate === RUN_PACING) cause = 'pacing-throttle';

    _syncLog(
      `TICK-STUCK severity=${severity} f=${_frameNum} stuckMs=${Math.round(stuckMs)} ` +
        `cause=${cause} rbPending=${!!window._rbPendingInit} ` +
        `awaitingResync=${_runSubstate === RUN_AWAITING_RESYNC} syncTargetFrame=${_syncTargetFrame} ` +
        `bootStallFrame=${_bootStallFrame} scheduledSyncs=${_scheduledSyncRequests.length} ` +
        `pacing=${_runSubstate === RUN_PACING} rbStall=${_runSubstate === RUN_RB_STALL} ` +
        `wasmStep=${_wasmStepActive} stallStart=${_stallStart} ` +
        `peers=${JSON.stringify(peerSnap)}`,
    );
  };

  const exportSyncLog = () => _syncLogRing.export();

  const _getStructuredEntries = () => _syncLogRing.getStructuredEntries();

  let _flushInterval = null;
  let _cachedMatchId = null;
  let _cachedRoom = null;
  let _cachedUploadToken = null;
  let _socketFlushFails = 0;

  // Pull rollback counters (T2 breakdown) from the C engine for flush payload.
  const _buildRollbackStats = () => {
    const m = window.EJS_emulator?.gameManager?.Module;
    if (!_useCRollback || !m?._kn_get_rollback_count) return null;
    const base = {
      rollbacks: m._kn_get_rollback_count(),
      predictions: m._kn_get_prediction_count(),
      correctPredictions: m._kn_get_correct_predictions(),
      maxDepth: m._kn_get_max_depth?.() ?? 0,
      failedRollbacks: m._kn_get_failed_rollbacks?.() ?? 0,
      // Predictions whose ring slot was reused before the real input arrived.
      // Books balance: predictions = correct + rollbacks + failed + clobbered.
      // Spikes here flag a peer-freeze cascade rather than a counter bug.
      clobberedPredictions: m._kn_get_clobbered_predictions?.() ?? 0,
      // Experiment A: rollbacks absorbed by stick-tolerance window.
      // Rollback count reduction == toleranceHits (approximately).
      toleranceHits: m._kn_get_tolerance_hits?.() ?? 0,
    };
    // T2: misprediction breakdown — button-only, stick-only, both-differ.
    // Allocate a 3-int scratch buffer once and reuse it.
    if (m._kn_get_mispred_breakdown && m._malloc) {
      if (!window._rbMispredBuf) window._rbMispredBuf = m._malloc(12);
      try {
        m._kn_get_mispred_breakdown(window._rbMispredBuf, 3);
        const view = new Int32Array(m.HEAP32.buffer, window._rbMispredBuf, 3);
        base.mispredBreakdown = {
          button: view[0],
          stick: view[1],
          both: view[2],
        };
      } catch (_) {}
    }
    return base;
  };

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
    mode: 'rollback',
    entries: _getStructuredEntries(),
    summary: {
      desyncs: KNState.sessionStats?.desyncs ?? 0,
      stalls: KNState.sessionStats?.stalls ?? 0,
      reconnects: KNState.sessionStats?.reconnects ?? 0,
      frames: _frameNum,
      duration_sec: Math.round((performance.now() - _startTime) / 1000),
      peers: Object.keys(KNState.peers || {}).length,
      // T2: rollback-mode aggregate stats (null outside rollback mode)
      rollback: _buildRollbackStats(),
      // T4: transport-level counters for packet-loss / redundancy telemetry
      rbTransport: _useCRollback
        ? {
            mode: _rbTransport,
            packetsSent: _rbTransportPacketsSent,
            dupsRecv: _rbTransportDupsRecv,
            dupRate: _rbTransportPacketsSent > 0 ? +(_rbTransportDupsRecv / _rbTransportPacketsSent).toFixed(4) : 0,
          }
        : null,
    },
    context: {
      ua: navigator.userAgent,
      mobile: /Mobi|Android/i.test(navigator.userAgent),
      // The actual emulator Module lives at window.EJS_emulator.gameManager.Module
      // (a stale window.Module reference would always report false, mis-tagging
      // every match as running the stock CDN core).
      forkedCore: !!window.EJS_emulator?.gameManager?.Module?._kn_set_deterministic,
      // T4: expose the transport mode in the per-match context so the
      // session log analyzer can group matches by mode without parsing logs.
      rbTransport: _useCRollback ? _rbTransport : 'n/a',
    },
    // Input audit (Option G). Included in every flush so we always have
    // something to compare even if the match ends abruptly. Delta-encoded
    // to keep size reasonable — we only record the count here and the full
    // data in a separate field that the server stores as log context.
    inputAudit: _buildInputAuditPayload(),
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

  // Drain new lines from the C-side rb_log() ring buffer into the JS sync
  // log so they ride along in `entries` to the server. The server's
  // SessionLogPayload Pydantic model only accepts matchId/entries/summary/
  // context, so adding a new top-level field would be silently dropped —
  // emitting via _syncLog is the path of least resistance.
  //
  // The C buffer is fill-and-stop (not a ring), so we track the highest
  // length we've already drained and only emit the new tail. Lines are
  // prefixed [C] so they're easy to filter post-mortem.
  let _cDebugLogLastLen = 0;
  const _drainCDebugLog = () => {
    const m = window.EJS_emulator?.gameManager?.Module;
    if (!m?._kn_get_debug_log) return;
    try {
      const ptr = m._kn_get_debug_log();
      if (!ptr) return;
      const full = m.UTF8ToString ? m.UTF8ToString(ptr) : window.UTF8ToString?.(ptr);
      if (!full || typeof full !== 'string') return;
      if (full.length === _cDebugLogLastLen) return;
      const tail = full.slice(_cDebugLogLastLen);
      _cDebugLogLastLen = full.length;
      // Emit each non-empty line as its own entry
      const lines = tail.split('\n');
      for (const line of lines) {
        if (line.trim()) _syncLog(`[C] ${line}`);
      }
    } catch (_) {}
  };

  const _flushSyncLog = () => {
    const matchId = _cachedMatchId || KNState.matchId;
    if (!matchId) return;
    // Drain the C debug log into JS sync log BEFORE building the flush
    // payload so the new entries are included.
    _drainCDebugLog();
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
          mode: 'rollback',
          entries: [],
          summary: {
            desyncs: 0,
            stalls: 0,
            reconnects: 0,
            frames: _frameNum,
            duration_sec: Math.round((performance.now() - _startTime) / 1000),
            peers: 0,
          },
          context: {
            ua: navigator.userAgent,
            mobile: /Mobi|Android/i.test(navigator.userAgent),
            forkedCore: !!window.EJS_emulator?.gameManager?.Module?._kn_set_deterministic,
          },
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

  // -- Diagnostic functions (delegated to kn-diagnostics.js) --
  const _diagInput = (frameNum, applyFrame, force) => _diag.diagInput(frameNum, applyFrame, force);
  const _diagInstallHooks = () => _diag.installHooks();

  // -- State machine observer (read-only) ------------------------------------
  // Computes a human-readable state name from the boolean flags. Does NOT
  // control anything — the booleans remain the source of truth. This exists
  // to make the implicit state machine visible: log transitions, detect
  // illegal combinations, and prepare for eventual flag→enum migration.
  //
  // States (in priority order — first match wins):
  //   'idle'                — not started
  //   'gesture-wait'        — waiting for user gesture to unlock audio
  //   'booting'             — emulator loading
  //   'syncing'             — initial state sync in progress
  //   'late-join-wait'      — waiting for late-join state from host
  //   'late-join-paused'    — host paused for late-joiner
  //   'awaiting-resync'     — guest paused waiting for resync data
  //   'pacing-throttle'     — frame pacing cap active
  //   'rollback-stall'      — rollback engine stalled
  //   'running'             — tick loop active, normal gameplay
  //   'running:menu'        — running but in menu (pre-gameplay)
  //   'stopped'             — tick loop stopped (game ended or cleanup)
  let _lastComputedState = 'idle';
  let _lastPacingStateLogAt = 0;

  const _computeState = () => {
    // Boot lifecycle — derived from _phase enum
    if (_phase === PHASE_IDLE) return 'idle';
    if (_phase === PHASE_GAME_STARTED) return 'booting';
    if (_phase === PHASE_EMU_READY || _phase === PHASE_SYNCING) {
      if (_awaitingLateJoinState) return 'late-join-wait';
      return 'syncing';
    }
    if (_phase === PHASE_LOCKSTEP_READY) return 'stopped'; // ready but tick loop not started yet
    if (_phase === PHASE_STOPPED) return 'stopped';
    // Runtime sub-states (only when PHASE_RUNNING)
    if (_runSubstate !== RUN_NORMAL) return _runSubstate;
    if (!_inGameplay) return 'running:menu';
    return 'running';
  };

  const _checkStateTransition = () => {
    const cur = _computeState();
    if (cur !== _lastComputedState) {
      const isPacingTransition = cur === RUN_PACING || _lastComputedState === RUN_PACING;
      const now = performance.now();
      if (!isPacingTransition || now - _lastPacingStateLogAt >= 1000) {
        _syncLog(`STATE ${_lastComputedState} → ${cur} f=${_frameNum}`);
        if (isPacingTransition) _lastPacingStateLogAt = now;
      }
      _lastComputedState = cur;
    }
  };

  let _syncChunks = []; // incoming chunks from host DC
  let _syncExpected = 0; // expected chunk count
  let _syncFrame = 0; // frame number of incoming sync
  let _syncIsFull = true; // true=full state, false=XOR delta
  let _syncChunkTimeoutTimer = null;
  let _syncChunkSessionId = 0;
  let _syncLastChunkProgressLogAt = 0;
  const SYNC_CHUNK_TIMEOUT_MS = 3000;
  const SOCKET_SYNC_B64_SOFT_LIMIT = 3900000;
  let _lastResyncTime = 0; // timestamp of last resync request (10s cooldown)
  let _resyncRequestInFlight = false; // true while an explicit sync-request is in transit — prevents stacking
  let _lastAppliedSyncHostFrame = -1; // host frame of the most recently applied sync state (discard stale explicit)
  let _pendingResyncState = null; // {bytes, frame} buffered for async apply at frame boundary
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
    _syncBufSize = 8 * 1024 * 1024 + 64 * 1024;
    _syncBufPtr = mod._malloc(_syncBufSize);
    _syncLog(`sync buffer allocated: ptr=${_syncBufPtr} size=${_syncBufSize}`);
  };

  const _captureHiddenStateWords = (mod) => {
    if (!_isSmashRemix() || !mod?._kn_pack_hidden_state_impl || !mod?._malloc || !mod?._free || !mod.HEAPU32) {
      return null;
    }
    const wordCount = 18;
    const ptr = mod._malloc(wordCount * 4);
    if (!ptr) return null;
    try {
      mod._kn_pack_hidden_state_impl(ptr);
      return Array.from(new Uint32Array(mod.HEAPU32.buffer, ptr, wordCount));
    } finally {
      mod._free(ptr);
    }
  };

  const _restoreHiddenStateWords = (mod, words, reason) => {
    const restoreFn = mod?._kn_restore_hidden_state_impl || mod?._kn_restore_hidden_state_boot;
    if (!words?.length || !restoreFn || !mod?._malloc || !mod?._free || !mod.HEAPU32) {
      return false;
    }
    const wordCount = Math.min(18, words.length);
    const ptr = mod._malloc(wordCount * 4);
    if (!ptr) return false;
    try {
      new Uint32Array(mod.HEAPU32.buffer, ptr, wordCount).set(words.slice(0, wordCount).map((w) => w >>> 0));
      restoreFn(ptr);
      const method = mod._kn_restore_hidden_state_impl ? 'full' : 'boot';
      _syncLog(`${reason}: restored Remix hidden state (${method}) words=${wordCount}`);
      return true;
    } finally {
      mod._free(ptr);
    }
  };

  const _captureAudioFifoState = (mod) => {
    if (!_isSmashRemix() || !mod?._kn_get_audio_fifo_state || !mod?._malloc || !mod?._free || !mod.HEAPU32) {
      return null;
    }
    const ptr = mod._malloc(4 * 4);
    if (!ptr) return null;
    try {
      mod._kn_get_audio_fifo_state(ptr);
      return Array.from(new Uint32Array(mod.HEAPU32.buffer, ptr, 4));
    } finally {
      mod._free(ptr);
    }
  };

  const _restoreAudioFifoState = (mod, words, reason) => {
    if (!words?.length || !mod?._kn_set_audio_fifo_state) return false;
    const vals = words.slice(0, 4).map((w) => w >>> 0);
    if (vals.length < 4) return false;
    mod._kn_set_audio_fifo_state(vals[0], vals[1], vals[2], vals[3]);
    _syncLog(`${reason}: restored audio FIFO [${vals.join(',')}]`);
    return true;
  };

  // 2026-04-29 audio-diag helpers. Capture cp0+AI state plus the
  // AI-controller invariant probe (BUSY ⇒ AI_INT scheduled) at restore
  // stages and around kn_normalize_event_queue. Includes the signed-rel
  // snapshot of AI_INT pre/post normalize. Removed once the silent-audio
  // root cause is fixed.
  const _AUDIO_DUMP_WORDS = 96;
  const _dumpAudioStateRaw = (mod) => {
    if (!mod?._kn_dump_audio_state || !mod?._malloc || !mod?._free || !mod.HEAPU32) {
      return null;
    }
    const ptr = mod._malloc(_AUDIO_DUMP_WORDS * 4);
    if (!ptr) return null;
    try {
      mod._kn_dump_audio_state(ptr, _AUDIO_DUMP_WORDS);
      return Array.from(new Uint32Array(mod.HEAPU32.buffer, ptr, _AUDIO_DUMP_WORDS));
    } finally {
      mod._free(ptr);
    }
  };
  const _formatAudioDump = (raw, label) => {
    if (!raw) return `${label}: <no kn_dump_audio_state export>`;
    const u = (n) => raw[n] >>> 0;
    const s = (n) => raw[n] | 0;
    const hex = (n) => '0x' + (raw[n] >>> 0).toString(16);
    const evtCount = u(56);
    const events = [];
    for (let k = 0; k < evtCount; k++) {
      const base = 57 + k * 2;
      if (base + 1 >= raw.length) break;
      const type = u(base);
      const relU = u(base + 1);
      const relS = relU | 0;
      events.push(`t${type}:${relU}u/${relS}s`);
    }
    const aiBusy = (u(0) & 0x40000000) !== 0;
    const aiHasInt = events.some((e) => e.startsWith('t64:'));
    const invariantOk = !aiBusy || aiHasInt;
    return (
      `AUDIO-DUMP ${label} ` +
      `aiStatus=${hex(0)} aiLen=${u(1)} aiDram=${hex(2)} dacrate=${u(3)} ` +
      `f0=[a:${hex(4)} l:${u(5)} d:${u(6)}] f1=[a:${hex(7)} l:${u(8)} d:${u(9)}] ` +
      `lastRead=${u(10)} delayedCarry=${u(11)} fmtChanged=${u(12)} ` +
      `count=${hex(13)} nextInt=${hex(14)} cycCount=${s(15)}s/${u(15)}u compare=${hex(16)} ` +
      `det=${u(17)} skip=${u(18)} smpCount=${u(19)} smpRate=${u(20)} ` +
      `lastFreq=${u(21)} lastSkipReason=${hex(22)} ` +
      `cnt[dma=${u(23)} eod=${u(24)} ailen=${u(25)} cap=${u(26)} skp=${u(27)}] ` +
      `probe[norm=${u(28)} allocFail=${u(29)} preN=${u(30)} postN=${u(31)} postStep=${u(32)} postKnSync=${u(33)} postClean=${u(34)}] ` +
      `aiRel[preS=${s(35)} postS=${s(36)} preCnt=${hex(37)} postCnt=${hex(38)}] ` +
      `firstViol[loc=${u(39)} status=${hex(40)} count=${hex(41)} dma=${u(42)} eod=${u(43)}] ` +
      `vi[vsync=${u(44)} vintr=${u(45)} status=${hex(46)} delay=${u(47)} cps=${u(48)} field=${u(49)} noEvt=${u(50)} preCnt=${u(51)} postCnt=${u(52)} rel1=${s(53)} rel2=${s(54)}] ` +
      `INVARIANT=${invariantOk ? 'ok' : 'VIOLATED'} ` +
      `q[${events.join(',')}]`
    );
  };
  const _logAudioDump = (mod, label) => {
    const raw = _dumpAudioStateRaw(mod);
    if (raw) _syncLog(_formatAudioDump(raw, label));
  };
  // Expose so kn-audio.js can request a dump from outside this module.
  window._knDumpAudioState = (label) => {
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (mod) _logAudioDump(mod, label);
  };
  // Cheap per-call invariant check; returns 1 if the AI invariant is
  // violated AT THIS MOMENT (BUSY without AI_INT). Counters in C track
  // total + per-location.
  const _checkAiInvariant = (mod, locationId) => {
    if (!mod?._kn_diag_check_invariant) return 0;
    return mod._kn_diag_check_invariant(locationId) | 0;
  };

  // Generic post-state-load cleanup — runs the C-side kn_post_state_load_cleanup
  // (event-queue normalize + AI_INT-when-BUSY synthesizer + JIT invalidate) for
  // any game that loads state at the lockstep start boundary. Originally gated
  // to Remix because it was added for Remix's kn-sync path, but the underlying
  // AI controller stuck-state (BUSY=1 with no AI_INT in cp0 queue, captured
  // when the host snapshots between AI_INT firing and the next DMA scheduling
  // its successor) reproduces just as well via libretro savestate on SSB64 —
  // room SS9QA5C3 (2026-04-29) had silent audio on host because the synthesizer
  // never ran. C function is named without Remix in build/build.sh; matched here.
  const _postStateLoadCleanup = (mod, reason) => {
    if (mod?._kn_post_state_load_cleanup) {
      mod._kn_post_state_load_cleanup();
      _syncLog(`${reason}: post-state cleanup applied`);
      return true;
    }
    if (mod?._kn_normalize_event_queue) {
      mod._kn_normalize_event_queue();
      _syncLog(`${reason}: normalized event queue after state load`);
      return true;
    }
    return false;
  };

  const _captureInitialStateBytes = (gm) => {
    const mod = gm?.Module;
    if (REMIX_INITIAL_SYNC_USE_KN_SYNC && _isSmashRemix() && mod?._kn_sync_read && mod?._kn_sync_write && mod?.HEAPU8) {
      ensureSyncBuffer();
      if (_syncBufPtr && _syncBufSize > 0) {
        // 2026-04-29 audio-diag: capture host AI state before payload read.
        _logAudioDump(mod, 'host:before-kn-sync-read');
        const t0 = performance.now();
        const bytesWritten = mod._kn_sync_read(_syncBufPtr, _syncBufSize);
        const t1 = performance.now();
        if (bytesWritten > 0) {
          const bytes = new Uint8Array(mod.HEAPU8.buffer, _syncBufPtr, bytesWritten).slice();
          _syncLog(
            `Smash Remix initial sync: kn_sync_read ${Math.round(bytes.length / 1024)}KB in ${(t1 - t0).toFixed(1)}ms`,
          );
          return {
            bytes,
            kind: 'kn-sync',
            hiddenWords: _captureHiddenStateWords(mod),
            audioFifo: _captureAudioFifoState(mod),
          };
        }
        _syncLog('Smash Remix initial sync: kn_sync_read returned 0, falling back to savestate');
      }
    }

    const raw = gm.getState();
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    return {
      bytes,
      kind: 'savestate',
      hiddenWords: _captureHiddenStateWords(mod),
      audioFifo: _captureAudioFifoState(mod),
    };
  };

  let _awaitingResyncAt = 0; // timestamp when pause started (safety timeout)
  let _syncTargetFrame = -1; // guest: hold incoming state until this frame, then apply (or stall)
  let _syncTargetDeadlineAt = 0; // I1 (MF3): wall-clock deadline for _syncTargetFrame
  const SYNC_COORD_TIMEOUT_MS = 3000;
  let _scheduledSyncRequests = []; // host: [{targetFrame, targetSid, forceFull}] pending coord captures

  // Proactive state push: host sends delta state every N frames so guests have a
  // fresh snapshot ready for instant resyncs — no request-response RTT needed.
  let _syncIsProactive = false; // true when current incoming sync-start is a proactive push
  let _syncIsRegions = false; // true when current incoming sync-regions-start is a regions patch

  // Apply buffered proactive state immediately on desync, skipping the round-trip.
  // Returns true if a preloaded state was promoted (caller should NOT send sync-request).

  // Frame pacing (GGPO-style frame advantage cap)
  const FRAME_ADV_ALPHA_UP = 0.1; // EMA when advantage is rising (slow to trigger)
  const FRAME_ADV_ALPHA_DOWN = 0.2; // EMA when advantage is falling (fast to release)
  const FRAME_PACING_WARMUP = 120; // skip pacing during first 120 frames (~2s boot)
  let _frameAdvantage = 0; // smoothed frame advantage (EMA)
  let _frameAdvRaw = 0; // instantaneous frame advantage (for logging)
  let _pacingThrottleStartAt = 0; // wall-clock when continuous throttle began (I1 deadline)
  const PACING_THROTTLE_TIMEOUT_MS = 5000; // I1: max continuous pacing stall before forced release
  // Pacing summary stats (reset every 300 frames)
  let _pacingCapsCount = 0;
  let _pacingCapsFrames = 0;
  let _pacingMaxAdv = 0;
  let _pacingAdvSum = 0;
  let _pacingAdvCount = 0;
  // Pacing skip counter — used by the tighter proportional throttle
  // (Fix 3): excess=1 → 50% skip, excess≥2 → 100% stall. The old
  // 3-stage SKIP_TABLE was removed in favor of this tighter policy.
  let _pacingSkipCounter = 0;
  const PACING_LOG_INTERVAL_MS = 1000;
  let _pacingLastLogAt = 0;
  let _pacingSuppressedLogs = 0;
  const _logPacing = (msg, force = false) => {
    const now = performance.now();
    if (!force && now - _pacingLastLogAt < PACING_LOG_INTERVAL_MS) {
      _pacingSuppressedLogs++;
      return;
    }
    const suffix = _pacingSuppressedLogs > 0 ? ` suppressed=${_pacingSuppressedLogs}` : '';
    _pacingSuppressedLogs = 0;
    _pacingLastLogAt = now;
    _syncLog(`${msg}${suffix}`);
  };

  let _inDeterministicStep = false; // gate for performance.now() override during frame step
  let _deterministicPerfNow = null; // saved override function
  let _visChangeHandler = null; // stored for removal in stopSync()
  let _networkChangeHandler = null; // stored for removal in stopSync()
  let _unloadVisChangeHandler = null; // pagehide-equivalent for mobile Safari; removed in stop()
  let _focusHandler = null; // stored for removal in stopSync()
  let _blurHandler = null; // stored for removal in stopSync()
  let _focusRestoreHandler = null; // pointer/touch recovery when browser chrome stole focus
  let _controlsFocusLost = false;
  let _bootGestureAbort = null; // AbortController for the gesture-prompt listeners; aborted in stop()
  // Restore handle for the AudioContext hijack installed in the gesture handler.
  // If EJS never calls `new AudioContext()` during a match (hibernate/wake reuse),
  // the hijack is never consumed and would leak across matches — a subsequent
  // `new AC({sampleRate: 44100})` call from play.js would hit the stale hijack,
  // ignore its arguments, and return the previous match's _ejsCtx at the device's
  // native rate (48000 on iPhone), causing an audible pitch shift.
  let _acHijackRestore = null;
  let _pageShowHandler = null; // stored for removal in stopSync()
  let _pageHideHandler = null; // stored for removal in stopSync()
  let _syncWorkerUrl = null; // Blob URL for sync worker (revoke on stop)

  // Spectator streaming state
  let _hostStream = null; // MediaStream for spectator canvas streaming
  let _guestVideo = null; // <video> element (spectator only)

  // Expose for Playwright
  window._playerSlot = _playerSlot;
  window._isSpectator = _isSpectator;
  KNState.peers = _peers;
  KNState.frameNum = 0;

  // -- Audio pipeline (delegated to kn-audio.js) --
  async function initAudioPlayback() {
    await _audio.init({
      log: _syncLog,
      getFrame: () => _frameNum,
      getSlot: () => _playerSlot,
      getLastRbFrame: () => _lastRollbackDoneFrame,
      getResetAudioCalls: () => _resetAudioCallsSinceRb,
      knEvent: KNEvent,
    });
  }
  const feedAudio = () => _audio.feed();

  const setStatus = (msg) => {
    if (_config?.onStatus) _config.onStatus(msg);
    _syncLog(msg);
  };

  // Reset pacing state after late-join pause. Wall clock time advances
  // during the pause but the tick loop is frozen — without this reset,
  // the phantom detector sees the pause duration as "peer went silent"
  // and permanently excludes the late joiner from pacing, allowing the
  // host to run unchecked ahead.
  const _resetPacingAfterLateJoin = () => {
    const now = performance.now();
    for (const slot of Object.keys(_peerLastAdvanceTime)) {
      _peerLastAdvanceTime[slot] = now;
    }
    for (const slot of Object.keys(_peerPhantom)) {
      if (_peerPhantom[slot]) {
        _syncLog(`late-join resume: clearing phantom for slot ${slot}`);
        _peerPhantom[slot] = false;
      }
    }
  };

  const clearLateJoinReadyRetry = () => {
    if (_lateJoinReadyRetryTimer) {
      clearInterval(_lateJoinReadyRetryTimer);
      _lateJoinReadyRetryTimer = null;
    }
  };

  function _peerEntryForSlot(slot) {
    for (const entry of Object.entries(_peers)) {
      if (entry[1]?.slot === slot) return entry;
    }
    return null;
  }

  function _beginLifecycleResyncGuard(reason) {
    const wasPending = _lifecycleResyncPending;
    _lifecycleResyncPending = true;
    _lifecycleResyncStartedAt = performance.now();
    _resumeInputGuardUntil = Math.max(
      _resumeInputGuardUntil,
      _lifecycleResyncStartedAt + LIFECYCLE_RESYNC_INPUT_GUARD_MS,
    );
    if (!wasPending) _syncLog(`${reason}: lifecycle resync guard armed`);
  }

  function _clearLifecycleResyncGuard(reason) {
    if (!_lifecycleResyncPending) return;
    _lifecycleResyncPending = false;
    _lifecycleResyncStartedAt = 0;
    _syncLog(`${reason}: lifecycle resync guard cleared`);
  }

  function _requestSocketFullResync(reason) {
    if (_playerSlot === 0 || _phase !== PHASE_RUNNING || !socket) return false;
    const hostEntry = _peerEntryForSlot(0);
    const hostSid = hostEntry?.[0];
    if (!hostSid) {
      _syncLog(`${reason}: socket sync-request-full skipped — no host peer`);
      return false;
    }
    try {
      _beginLifecycleResyncGuard(reason);
      _resyncRequestInFlight = true;
      _syncTargetFrame = -1;
      _syncTargetDeadlineAt = 0;
      socket.emit('data-message', {
        type: 'sync-request-full-socket',
        targetSid: hostSid,
        requesterSid: socket.id,
        reason,
        frame: _frameNum,
      });
      _syncLog(`${reason}: sent socket sync-request-full to host`);
      return true;
    } catch (err) {
      _resyncRequestInFlight = false;
      _syncLog(`${reason}: socket sync-request-full failed: ${err?.message || err}`);
      return false;
    }
  }

  const onDataMessage = (msg) => {
    if (!msg?.type) return;
    if (msg.type === 'save-state') handleSaveStateMsg(msg);
    if (msg.type === 'late-join-state') handleLateJoinState(msg);
    if (msg.type === 'request-late-join') handleLateJoinRequest(msg);
    if (msg.type === 'sync-request-full-socket') handleSocketSyncRequest(msg);
    if (msg.type === 'sync-state-socket') handleSocketSyncState(msg);
    if (msg.type === 'late-join-ready') {
      finishLateJoinReady('Socket.IO', msg.senderSid || null);
    }
  };

  const handleSocketSyncRequest = (msg) => {
    if (_playerSlot !== 0 || _phase !== PHASE_RUNNING) return;
    const requesterSid = typeof msg.requesterSid === 'string' ? msg.requesterSid : '';
    if (!requesterSid || !_peers[requesterSid]) {
      _syncLog(`socket sync-request-full ignored — unknown requester ${requesterSid || 'null'}`);
      return;
    }
    _syncLog(`received socket sync-request-full from ${requesterSid} reason=${msg.reason || 'unknown'}`);
    _setLastSyncState(null, 'socket-requested-full');
    pushSyncState(requesterSid, false, { transport: 'socket', reason: msg.reason || 'socket-request' });
  };

  const handleSocketSyncState = async (msg) => {
    if (_playerSlot === 0 || _isSpectator || _phase !== PHASE_RUNNING) return;
    if (msg.targetSid && socket?.id && msg.targetSid !== socket.id) return;
    const frame = Number.parseInt(msg.frame, 10);
    if (!Number.isFinite(frame)) {
      _syncLog('socket sync-state ignored — invalid frame');
      return;
    }
    try {
      _syncLog(
        `socket sync-state received: frame=${frame} full=${msg.full ? 'true' : 'false'} ` +
          `wire=${Math.round((msg.compressedSize || msg.data?.length || 0) / 1024)}KB reason=${msg.reason || 'unknown'}`,
      );
      const decompressed = await decodeAndDecompress(msg.data);
      await _handleDecodedSyncPayload({
        decompressed,
        frame,
        isFull: !!msg.full,
        isProactive: !!msg.proactive,
        isRegions: false,
        wireSize: msg.compressedSize || 0,
        source: 'socket',
      });
    } catch (err) {
      _syncLog(`socket sync-state failed: ${err?.message || err}`);
    }
  };

  // Per-requester cooldown for late-join state captures. Each capture pauses
  // the host, runs gm.getState() + gzip + base64 encoding (1.5MB+ blob), and
  // momentarily tanks throughput. A malicious peer join/leave-looping could
  // pin the main thread without this guard. 8s is well over the legitimate
  // resync interval; a real reconnect after disconnect already starts fresh.
  const _LATE_JOIN_COOLDOWN_MS = 8000;
  const _lateJoinLastSentAt = new Map(); // requesterSid -> ms timestamp

  const handleLateJoinRequest = (msg) => {
    // Only host responds to late-join requests
    if (_playerSlot !== 0 || _phase !== PHASE_RUNNING) return;
    const requesterSid = msg.requesterSid;
    if (!requesterSid) return;
    const now = performance.now();
    const last = _lateJoinLastSentAt.get(requesterSid) || 0;
    if (now - last < _LATE_JOIN_COOLDOWN_MS) {
      _syncLog(
        `late-join request from ${requesterSid} ignored (cooldown ${Math.round(_LATE_JOIN_COOLDOWN_MS - (now - last))}ms)`,
      );
      return;
    }
    _lateJoinLastSentAt.set(requesterSid, now);
    _syncLog(`received late-join request from ${requesterSid}`);
    const name = _knownPlayers[requesterSid]?.playerName || 'A player';
    _config?.onToast?.(`${name} is joining...`);
    setStatus(`${name} is joining...`);
    _lateJoinReadyHandled.delete(requesterSid);
    _pendingLateJoinReadySids.delete(requesterSid);
    sendLateJoinState(requesterSid);
  };

  const resumeLateJoinPause = (source, includeRoster) => {
    if (_runSubstate !== RUN_LATE_JOIN_PAUSE) return false;
    _runSubstate = RUN_NORMAL;
    _lateJoinPausedAt = 0;
    _resetPacingAfterLateJoin();
    if (includeRoster) _broadcastRoster();
    _syncLog(`late-join resume: ${source}${includeRoster ? '' : ' (roster waits for DC)'}`);
    for (const p of Object.values(_peers)) {
      if (p.dc?.readyState === 'open') {
        try {
          p.dc.send('late-join-resume');
        } catch (_) {}
      }
    }
    return true;
  };

  const finishLateJoinReady = (source, senderSid = null) => {
    let newlyHandled = false;
    if (_playerSlot === 0 && senderSid) {
      if (_lateJoinReadyHandled.has(senderSid)) return;
      const peer = _peers[senderSid];
      if (peer?.dc?.readyState !== 'open') {
        if (_pendingLateJoinReadySids.has(senderSid)) return;
        _pendingLateJoinReadySids.add(senderSid);
        _syncLog(`late-join-ready via ${source}: DC not open for ${senderSid}; resuming existing players`);
        resumeLateJoinPause(`${source} ready from ${senderSid}`, false);
        return;
      }
      _pendingLateJoinReadySids.delete(senderSid);
      _clearPendingLateJoinPeer(senderSid, peer?.slot ?? _knownPlayers[senderSid]?.slot, `ready via ${source}`, {
        activate: true,
      });
      _lateJoinReadyHandled.add(senderSid);
      newlyHandled = true;
    }

    const name = senderSid ? _knownPlayers[senderSid]?.playerName || 'Player' : 'Player';
    if (_runSubstate === RUN_LATE_JOIN_PAUSE) {
      resumeLateJoinPause(`joiner ready (via ${source})`, true);
      if (newlyHandled || senderSid) _config?.onToast?.(`${name} joined`);
    } else {
      // The Socket.IO ready path may already have resumed the old players.
      // Now that the joiner's DC is open, activate the roster/input slot.
      _resetPacingAfterLateJoin();
      _broadcastRoster();
      _syncLog(`late-join-ready (${source}) — pacing reset + roster broadcast`);
      if (newlyHandled) _config?.onToast?.(`${name} joined`);
    }
  };

  const _syntheticSidForSlot = (slot) => `synth-${slot}`;

  const _registerSyntheticKnownPlayer = (sid, slot) => {
    _knownPlayers[sid] = { playerName: `Demo P${slot + 1}`, slot };
  };

  const _makeSyntheticDataChannel = () => ({
    readyState: 'open',
    send: () => {},
    close: () => {},
  });

  const _makeSyntheticPeerConnection = () => ({
    connectionState: 'connected',
    close: () => {},
  });

  const createSyntheticPeer = (slot) => {
    const numericSlot = Number(slot);
    if (!_isValidPlayerSlot(numericSlot)) return null;
    const sid = _syntheticSidForSlot(numericSlot);
    const existing = _peers[sid];
    if (existing && existing.synthetic !== true) {
      _syncLog(`synthetic peer collision sid=${sid} slot=${numericSlot}`);
      return null;
    }
    if (existing?.synthetic === true) {
      existing.slot = numericSlot;
      existing.ready = true;
      existing.emuReady = true;
      existing.reconnecting = false;
      existing.startupReconnecting = false;
      existing.dc = existing.dc || _makeSyntheticDataChannel();
      existing.pc = existing.pc || _makeSyntheticPeerConnection();
      _registerSyntheticKnownPlayer(sid, numericSlot);
      _lockstepReadyPeers[sid] = true;
      return existing;
    }

    const peer = {
      slot: numericSlot,
      synthetic: true,
      ready: true,
      emuReady: true,
      reconnecting: false,
      startupReconnecting: false,
      isInitiator: false,
      lastAckFromPeer: -1,
      lastFrameFromPeer: -1,
      lastAckAdvanceTime: 0,
      rttSamples: [],
      _rttSamples: [],
      delayValue: 0,
      rbDc: null,
      syncDc: null,
      dc: _makeSyntheticDataChannel(),
      pc: _makeSyntheticPeerConnection(),
    };
    _peers[sid] = peer;
    KNState.peers = _peers;
    _registerSyntheticKnownPlayer(sid, numericSlot);
    _lockstepReadyPeers[sid] = true;
    _syncLog(`synthetic peer created sid=${sid} slot=${numericSlot}`);
    return peer;
  };

  const ensureSyntheticPeer = (slot) => {
    const numericSlot = Number(slot);
    if (!_isValidPlayerSlot(numericSlot)) return null;
    const sid = _syntheticSidForSlot(numericSlot);
    const existing = _peers[sid];
    if (existing?.synthetic === true) {
      _registerSyntheticKnownPlayer(sid, numericSlot);
      _lockstepReadyPeers[sid] = true;
      return existing;
    }
    return createSyntheticPeer(numericSlot);
  };

  const _isSyntheticOnlyInitialSyncSkip = () =>
    _config?.skipInitialStateSync === true &&
    _playerSlot === 0 &&
    Object.keys(_peers).length > 0 &&
    Object.values(_peers).every((peer) => peer?.synthetic === true);

  const _restoreSyntheticKnownPlayers = () => {
    for (const [sid, peer] of Object.entries(_peers)) {
      if (peer?.synthetic === true && _isValidPlayerSlot(peer.slot)) {
        _registerSyntheticKnownPlayer(sid, peer.slot);
      }
    }
  };

  const _recordSyntheticRtt = (peer, observedRttMs) => {
    if (!peer?.synthetic || !(observedRttMs > 0)) return;
    if (!peer._rttSamples) peer._rttSamples = [];
    peer._rttSamples.push(observedRttMs);
    while (peer._rttSamples.length > 20) peer._rttSamples.shift();
    peer.rttSamples = peer._rttSamples.slice().sort((a, b) => a - b);
  };

  // -- users-updated ---------------------------------------------------------

  const onUsersUpdated = (data) => {
    const { players = {}, spectators = {} } = data;

    // Rebuild known players map
    _knownPlayers = {};
    for (const p of Object.values(players)) {
      _knownPlayers[p.socketId] = { slot: p.slot, playerName: p.playerName };
    }
    _restoreSyntheticKnownPlayers();
    _dropPendingLateJoinPeersMissingFromRoster(players);

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
        `mySlot=${_playerSlot}, lateJoin=${_lateJoin}, running=${_phase === PHASE_RUNNING}, spectator=${_isSpectator}, ` +
        `existingPeers=[${existingPeerSids.join(',')}]`,
    );

    // Establish mesh connections to other players
    // Normal: lower slot initiates (creates data channel + sends offer)
    // Late-join: joiner always initiates (host's offer would arrive before listener is ready)
    // Running host: DON'T initiate to new players — let them initiate after their init()
    for (const p of otherPlayers) {
      const shouldHoldForLateJoin =
        _phase === PHASE_RUNNING &&
        !_lateJoin &&
        !_isSpectator &&
        _isValidPlayerSlot(p.slot) &&
        !_slotAlreadyActive(p.slot);

      if (_peers[p.socketId]) {
        _syncLog(`onUsersUpdated: peer ${p.socketId} (slot ${p.slot}) already exists, skipping`);
        _peers[p.socketId].slot = p.slot;
        if (shouldHoldForLateJoin) {
          _markPendingLateJoinPeer(p.socketId, p.slot, 'users-updated existing running peer');
        } else if (_activeRoster?.has(p.slot)) {
          _clearPendingLateJoinPeer(p.socketId, p.slot, 'users-updated active roster');
        }
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
            // I2: route per-peer cleanup through resetPeerState before
            // dropping the _peers entry.
            resetPeerState(oldPeer.slot, 'zombie-eviction', { peer: oldPeer, sid: oldSid });
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
      } else if (_phase === PHASE_RUNNING) {
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
      if (shouldHoldForLateJoin) _markPendingLateJoinPeer(p.socketId, p.slot, 'users-updated running peer');

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

    _applyControllerPresentMask('users-updated');

    // Notify controller
    _config?.onPlayersChanged?.(data);
  };

  // -- WebRTC multi-peer mesh ------------------------------------------------

  const STARTUP_CONNECT_TIMEOUT_MS = 8000;
  const STARTUP_CONNECT_MAX_ATTEMPTS = 3;

  const clearStartupConnectWatchdog = (peer) => {
    if (peer?._startupConnectTimer) {
      clearTimeout(peer._startupConnectTimer);
      peer._startupConnectTimer = null;
    }
  };

  const installPeerDataChannelHandlers = (remoteSid, peer) => {
    peer.pc.ondatachannel = (e) => {
      if (e.channel.label === 'lockstep') {
        peer.dc = e.channel;
        setupDataChannel(remoteSid, peer.dc);
      } else if (e.channel.label === 'sync-state') {
        peer.syncDc = e.channel;
        setupSyncDataChannel(remoteSid, peer.syncDc);
      } else if (e.channel.label === 'rollback-input') {
        if (peer.rbDc)
          try {
            peer.rbDc.onclose = null;
            peer.rbDc.close();
          } catch (_) {}
        peer.rbDc = e.channel;
        peer.rbDcUnreliable = false;
        setupRollbackInputDataChannel(remoteSid, peer.rbDc);
      } else if (_onExtraDataChannel) {
        _onExtraDataChannel(remoteSid, e.channel);
      }
    };
  };

  const createOutgoingPeerChannels = (remoteSid, peer) => {
    peer.dc = peer.pc.createDataChannel('lockstep', { ordered: true });
    setupDataChannel(remoteSid, peer.dc);
    peer.syncDc = peer.pc.createDataChannel('sync-state', { ordered: true, priority: 'very-low' });
    setupSyncDataChannel(remoteSid, peer.syncDc);
    // P2: unordered input channel — always created, only used when the
    // host broadcasts rb-transport:unreliable. Cheap to leave idle.
    peer.rbDc = peer.pc.createDataChannel('rollback-input', { ordered: false, maxRetransmits: 0 });
    peer.rbDcUnreliable = false;
    setupRollbackInputDataChannel(remoteSid, peer.rbDc);
    installPeerDataChannelHandlers(remoteSid, peer);
  };

  const armStartupConnectWatchdog = (remoteSid) => {
    const peer = _peers[remoteSid];
    if (!peer || !peer.isInitiator || _phase >= PHASE_GAME_STARTED) return;
    if (peer.dc?.readyState === 'open') return;
    clearStartupConnectWatchdog(peer);
    peer._startupConnectTimer = setTimeout(() => {
      retryStartupConnection(remoteSid);
    }, STARTUP_CONNECT_TIMEOUT_MS);
  };

  const retryStartupConnection = async (remoteSid) => {
    const peer = _peers[remoteSid];
    if (!peer || _peers[remoteSid] !== peer) return;
    if (!peer.isInitiator || _phase >= PHASE_GAME_STARTED) return;
    if (peer.dc?.readyState === 'open') return;

    const nextAttempt = (peer._startupConnectAttempt || 1) + 1;
    if (nextAttempt > STARTUP_CONNECT_MAX_ATTEMPTS) {
      clearStartupConnectWatchdog(peer);
      _syncLog(
        `startup connect failed sid=${remoteSid} slot=${peer.slot} ` +
          `attempts=${STARTUP_CONNECT_MAX_ATTEMPTS} pc=${peer.pc?.connectionState ?? 'none'} ` +
          `dc=${peer.dc?.readyState ?? 'none'}`,
      );
      setStatus('Peer connection stalled — reload or rejoin to retry');
      KNEvent('webrtc-fail', 'Startup WebRTC connection stalled', {
        slot: peer.slot,
        remoteSid,
        state: peer.pc?.connectionState ?? 'none',
        dc: peer.dc?.readyState ?? 'none',
      });
      return;
    }

    clearStartupConnectWatchdog(peer);
    peer._startupConnectAttempt = nextAttempt;
    peer.ready = false;
    peer.emuReady = false;
    peer.startupReconnecting = true;
    _syncLog(
      `startup connect retry sid=${remoteSid} slot=${peer.slot} ` +
        `attempt=${nextAttempt}/${STARTUP_CONNECT_MAX_ATTEMPTS} ` +
        `pc=${peer.pc?.connectionState ?? 'none'} dc=${peer.dc?.readyState ?? 'none'}`,
    );
    setStatus(`Peer connection stalled — retrying (${nextAttempt}/${STARTUP_CONNECT_MAX_ATTEMPTS})...`);

    const peerGuard = (p) => _peers[remoteSid] === p;
    KNShared.resetPeerConnection(peer, _getIceServers(), remoteSid, socket, peerGuard);
    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      _syncLog(`startup retry peer ${remoteSid} connection-state: ${s}`);
      if (s === 'connecting') setStatus('Connecting to players...');
      if (s === 'failed') retryStartupConnection(remoteSid);
    };
    createOutgoingPeerChannels(remoteSid, peer);

    try {
      await sendOffer(remoteSid, { reconnect: true, startup: true });
    } catch (err) {
      _syncLog(`startup reconnect offer failed sid=${remoteSid}: ${err?.message || err}`);
      armStartupConnectWatchdog(remoteSid);
    }
  };

  const createPeer = (remoteSid, remoteSlot, isInitiator) => {
    const peerGuard = (p) => _peers[remoteSid] === p;
    const peer = KNShared.createBasePeer(_getIceServers(), remoteSid, socket, peerGuard);
    peer.slot = remoteSlot;
    peer.ready = false;
    peer.emuReady = false;
    peer.rttSamples = [];
    peer.isInitiator = !!isInitiator;
    peer.startupReconnecting = false;
    peer._startupConnectAttempt = isInitiator ? 1 : 0;

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
        }
      }
      if (s === 'failed') {
        if (_phase < PHASE_GAME_STARTED && peer.isInitiator) {
          _syncLog(`startup peer ${remoteSid} failed before game start — retrying`);
          retryStartupConnection(remoteSid);
          return;
        }
        // Failed is terminal — disconnect immediately
        _syncLog(`WEBRTC-FAILED slot=${peer.slot} sid=${remoteSid} — PeerConnection terminal failure`);
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
          }, 3000); // 3s grace — allow ICE recovery on WiFi blips
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
      createOutgoingPeerChannels(remoteSid, peer);
    } else {
      installPeerDataChannelHandlers(remoteSid, peer);
    }
    return peer;
  };

  async function sendOffer(remoteSid, { reconnect = false, startup = false } = {}) {
    const peer = _peers[remoteSid];
    if (!peer) {
      _syncLog(`sendOffer: no peer for ${remoteSid}, skipping`);
      return;
    }
    _syncLog(
      `sendOffer: sending to ${remoteSid} (slot ${peer.slot})` +
        `${reconnect ? ' [reconnect]' : ''}${startup ? ' [startup]' : ''}`,
    );
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    socket.emit('webrtc-signal', { target: remoteSid, offer, reconnect, startupReconnect: startup });
    armStartupConnectWatchdog(remoteSid);
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
          const startupReconnect = !!data.startupReconnect || _phase < PHASE_GAME_STARTED;
          _syncLog(`received ${startupReconnect ? 'startup ' : ''}reconnect offer from ${senderSid}`);
          // Mark gameplay reconnects so the DC open handler triggers resync.
          // Startup retries have no game state yet, so they should only
          // restart the WebRTC handshake and then continue normal boot.
          existingPeer.reconnecting = !startupReconnect;
          existingPeer.startupReconnecting = startupReconnect;

          const peerGuard = (p) => _peers[senderSid] === p;
          KNShared.resetPeerConnection(existingPeer, _getIceServers(), senderSid, socket, peerGuard);
          existingPeer.ready = false;
          existingPeer.emuReady = false;

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
          installPeerDataChannelHandlers(senderSid, existingPeer);

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

  // Process a binary input packet from any DC (lockstep or rollback-input).
  // Shared by setupDataChannel (reliable DC) and setupRollbackInputDataChannel
  // (unordered DC, used when host broadcasts rb-transport:unreliable).
  const _processInputPacket = (remoteSid, peer, data) => {
    if (peer.slot === null || peer.slot === undefined) return false; // spectators don't send input
    if (_isPeerPendingLateJoin(remoteSid, peer)) {
      if (!peer._pendingLateJoinInputDroppedLogged) {
        peer._pendingLateJoinInputDroppedLogged = true;
        _syncLog(`dropping input from pending late-join peer slot=${peer.slot} sid=${remoteSid}`);
      }
      return false;
    }
    const decoded = KNShared.decodeInput(data);
    const recvFrame = decoded.frame;
    // Bounds-check the remote frame number. A malicious peer could send
    // frame=-999 or frame=_frameNum+1e6 to poison the rollback ring buffer
    // or trigger massive memory churn in the input maps. Legitimate frames
    // sit in roughly [_frameNum - 240, _frameNum + DELAY_FRAMES + 60].
    // Reject anything wildly outside that range; INPUT-LATE handles the
    // soft-stale case below.
    const _INPUT_PAST_WINDOW = 240; // ~4s at 60fps — generous for a stalled peer
    const _INPUT_FUTURE_MARGIN = 60; // 1s past delay buffer
    if (
      !Number.isFinite(recvFrame) ||
      recvFrame < 0 ||
      recvFrame < _frameNum - _INPUT_PAST_WINDOW ||
      recvFrame > _frameNum + DELAY_FRAMES + _INPUT_FUTURE_MARGIN
    ) {
      _syncLog(`INPUT-OOR slot=${peer.slot} recvF=${recvFrame} myF=${_frameNum} delay=${DELAY_FRAMES}`);
      return false;
    }
    const recvInput = { buttons: decoded.buttons, lx: decoded.lx, ly: decoded.ly, cx: decoded.cx, cy: decoded.cy };
    // Track peer's ack — highest frame they've received from us
    if (decoded.ackFrame >= 0) {
      peer.lastAckFromPeer = Math.max(peer.lastAckFromPeer ?? -1, decoded.ackFrame);
    }
    const prevHighest = peer.lastFrameFromPeer ?? -1;
    peer.lastFrameFromPeer = Math.max(prevHighest, recvFrame);
    // DC health: track when peer's delivered frame last advanced
    if (peer.lastFrameFromPeer > prevHighest) {
      peer.lastAckAdvanceTime = performance.now();
    }
    if (!_remoteInputs[peer.slot]) _remoteInputs[peer.slot] = {};
    const currentApply = _frameNum - DELAY_FRAMES;
    if (_phase === PHASE_RUNNING && recvFrame < currentApply) {
      const now = performance.now();
      if (!_inputLateLogTime[peer.slot] || now - _inputLateLogTime[peer.slot] >= 1000) {
        _inputLateLogTime[peer.slot] = now;
        _syncLog(
          `INPUT-LATE slot=${peer.slot} recvF=${recvFrame} applyF=${currentApply} behind=${currentApply - recvFrame}`,
        );
      }
    }
    const existingHeaderInput = _remoteInputs[peer.slot][recvFrame];
    const headerDuplicate = existingHeaderInput !== undefined && _inputEq(existingHeaderInput, recvInput);
    const headerWasSeeded = _consumeLateJoinSeededInput(peer.slot, recvFrame);
    _remoteInputs[peer.slot][recvFrame] = recvInput;
    if (!_lastKnownInput[peer.slot] || recvFrame >= (_lastKnownInput[peer.slot].frame ?? -1)) {
      _lastKnownInput[peer.slot] = { ...recvInput, frame: recvFrame };
    }
    _auditRecordRemote(peer.slot, recvFrame, recvInput);

    // P2 redundancy: queue piggy-backed prior frames ONLY if we don't
    // already have a real input for that frame. Without this guard, every
    // packet carrying 8 frames of history queues 8 kn_feed_input calls —
    // and for frames we already have, each call re-triggers the
    // misprediction comparison against a stale ring entry, causing the
    // cascading rollbacks we observed in the 2026-04-07 field test.
    //
    // A redundant entry is only useful when the original packet for that
    // frame was lost (unreliable DC) or hasn't arrived yet (out of order).
    // Otherwise it's redundant in the wasted-work sense, not the
    // error-correction sense.
    if (decoded.redundant && decoded.redundant.length > 0) {
      for (const r of decoded.redundant) {
        if (r.frame < 0) continue;
        const redundantInput = {
          buttons: r.buttons,
          lx: r.lx,
          ly: r.ly,
          cx: r.cx,
          cy: r.cy,
        };
        const existingRedundantInput = _remoteInputs[peer.slot][r.frame];
        const redundantWasSeeded = _consumeLateJoinSeededInput(peer.slot, r.frame);
        // Already have real input for this frame? Skip — just a dup.
        if (existingRedundantInput !== undefined && !redundantWasSeeded) {
          _rbTransportDupsRecv++;
          continue;
        }
        _remoteInputs[peer.slot][r.frame] = redundantInput;
        if (_useCRollback && (!existingRedundantInput || !_inputEq(existingRedundantInput, redundantInput))) {
          _pendingCInputs.push({
            slot: peer.slot,
            frame: r.frame,
            buttons: r.buttons,
            lx: r.lx,
            ly: r.ly,
            cx: r.cx,
            cy: r.cy,
          });
        }
      }
    }

    // Queue for C-level rollback engine — drained at tick boundary
    if (_useCRollback && (!headerDuplicate || (headerWasSeeded && !_inputEq(existingHeaderInput, recvInput)))) {
      _pendingCInputs.push({
        slot: peer.slot,
        frame: recvFrame,
        buttons: recvInput.buttons,
        lx: recvInput.lx,
        ly: recvInput.ly,
        cx: recvInput.cx,
        cy: recvInput.cy,
      });
    } else if (headerDuplicate) {
      _rbTransportDupsRecv++;
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
      if (_peerPhantom[peer.slot]) {
        _syncLog(`PEER-RECOVERED slot=${peer.slot} f=${recvFrame} — resuming normal pacing`);
        _peerPhantom[peer.slot] = false;
        _consecutiveFabrications[peer.slot] = 0;
        window.dispatchEvent(new CustomEvent('kn-peer-recovered', { detail: { slot: peer.slot } }));
        if (_playerSlot !== 0 && peer.slot === 0 && _syncEnabled) {
          _lastResyncTime = 0;
          _resyncRequestInFlight = false;
          _consecutiveResyncs = 0;
          const _recoveryTarget = _frameNum + SYNC_COORD_DELTA;
          _syncTargetFrame = _recoveryTarget;
          _syncTargetDeadlineAt = performance.now() + SYNC_COORD_TIMEOUT_MS; // I1 (MF3)
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
            _syncTargetDeadlineAt = 0;
          }
        }
      }
    }
    return true;
  };

  // Unordered input DC for rollback mode — set up alongside the lockstep DC.
  // Receiving is identical to lockstep binary input; sending is gated by
  // _rbTransport === 'unreliable' (host-negotiated).
  const setupRollbackInputDataChannel = (remoteSid, ch) => {
    ch.binaryType = 'arraybuffer';
    const onOpen = () => {
      // T4: log the ACTUAL negotiated DC properties, not what we asked for.
      // Some browsers ignore init options and silently give us ordered/reliable.
      // If the mismatch matters (we're in unreliable mode but got reliable),
      // log TRANSPORT-MISMATCH so the session log captures the fallback.
      const peer = _peers[remoteSid];
      const ordered = ch.ordered;
      const maxRetransmits = ch.maxRetransmits;
      if (peer && peer.rbDc === ch) {
        peer.rbDcUnreliable = ordered === false && maxRetransmits === 0;
      }
      _syncLog(`rb-input DC open sid=${remoteSid} ordered=${ordered} maxRetransmits=${maxRetransmits}`);
      if (_rbTransport === 'unreliable' && (ordered !== false || maxRetransmits !== 0)) {
        _syncLog(
          `TRANSPORT-MISMATCH sid=${remoteSid} requested=unreliable actual=ordered:${ordered},maxRetrans:${maxRetransmits} — inputs will fall back to reliable DC`,
        );
      }
    };
    ch.onopen = onOpen;
    if (ch.readyState === 'open') onOpen();
    ch.onclose = () => {
      const peer = _peers[remoteSid];
      if (peer && peer.rbDc === ch) {
        resetPeerRollbackTransport(peer, remoteSid, 'rb-dc-close');
        if (_rbTransport === 'unreliable') {
          _rbTransport = 'reliable';
          _syncLog(`DC-FALLBACK reason=rb-dc-close sid=${remoteSid} — inputs now via primary channel`);
        }
      }
      _syncLog(`rb-input DC closed sid=${remoteSid}`);
    };
    ch.onerror = () => {};
    ch.onmessage = (e) => {
      const peer = _peers[remoteSid];
      if (!peer) return;
      if (
        e.data instanceof ArrayBuffer &&
        e.data.byteLength >= 16 &&
        e.data.byteLength <= 256 &&
        e.data.byteLength % 4 === 0
      ) {
        _processInputPacket(remoteSid, peer, e.data);
      }
    };
  };

  const setupDataChannel = (remoteSid, ch) => {
    ch.binaryType = 'arraybuffer';

    const onOpen = () => {
      const peer = _peers[remoteSid];
      if (!peer) return;
      const known = _knownPlayers[remoteSid];
      const peerName = known ? known.playerName : `P${(peer.slot ?? 0) + 1}`;
      _syncLog(`DC open with ${remoteSid} slot: ${peer.slot} ${peerName}`);
      setStatus(`Connected to ${peerName}`);
      peer.ready = true;
      clearStartupConnectWatchdog(peer);
      peer._startupConnectAttempt = 0;
      if (peer.startupReconnecting) {
        peer.startupReconnecting = false;
        _syncLog(`startup reconnect complete sid=${remoteSid} slot=${peer.slot}`);
      }
      // P0-1 funnel: fire webrtc_connected the first time this peer's DC opens.
      // Subsequent reopens (reconnects) don't re-emit.
      if (!peer._funnelConnectedSent) {
        peer._funnelConnectedSent = true;
        KNEvent('webrtc_connected', '', { remote_slot: peer.slot ?? -1 });
      }
      ch.send('ready');

      if (_phase >= PHASE_EMU_READY) ch.send('emu-ready');

      // Both sides measure RTT for auto delay
      startRttMeasurement(peer);

      // Late join: if game is running, host starts spectator stream for new spectator
      if (_phase === PHASE_RUNNING && _playerSlot === 0 && peer.slot === null) {
        startSpectatorStreamForPeer(remoteSid);
      }

      // If this is a reconnect, clear reconnecting state and resync
      if (peer.reconnecting) {
        if (peer._reconnectTimeout) {
          clearTimeout(peer._reconnectTimeout);
          peer._reconnectTimeout = null;
        }
        peer.reconnecting = false;
        // P0-1 funnel: emit peer_reconnected from the host only (same rationale
        // as peer_left — single authoritative source, slot attributed via meta).
        if (_playerSlot === 0 && peer.slot != null && peer.slot !== undefined) {
          KNEvent('peer_reconnected', '', { peer_slot: peer.slot });
        }
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
          // I2: Full per-peer reset on DC reconnect. Any inputs in
          // flight when the DC died are gone; keeping them lets the
          // rollback engine read stale values after state resync. The
          // original commit 788add0 cleared only _remoteInputs here —
          // this expands to every per-peer field (phantom, ack state,
          // audit log, fabrication counter, etc.) so the new DC starts
          // from a guaranteed-clean slate.
          if (peer.slot !== null && peer.slot !== undefined) {
            resetPeerState(peer.slot, 'reconnect', { peer, sid: remoteSid });
          }
          // Send sync-request-full to the HOST's lockstep DC (only host handles
          // sync requests). `ch` is the DC to the reconnected peer — which may
          // not be the host (e.g. P1 reconnecting to P2).
          //
          // IMMEDIATE sync (no -at: suffix): avoids the coord-sync deadlock
          // where `_frameNum + 15` is unreachable if the local frame counter
          // is stuck (e.g. BOOT-LOCKSTEP stall). Host pushes state at its
          // current frame, guest loads at host's frame. Both resume from a
          // known common point. This is the reconnect path — there is no
          // "in-progress gameplay" to preserve via coordination.
          const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
          const hostDc = hostPeer?.dc;
          if (hostDc?.readyState === 'open') {
            _syncTargetFrame = -1;
            _syncTargetDeadlineAt = 0;
            _resyncRequestInFlight = true;
            try {
              hostDc.send('sync-request-full');
              _syncLog('reconnect resync: sent immediate sync-request-full to host DC');
            } catch (e) {
              _syncLog(`reconnect resync send failed: ${e}`);
              _resyncRequestInFlight = false;
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

      // Host: send current roster to newly connected/reconnected peer.
      // A running late joiner must not receive the old roster before it has
      // loaded state and sent late-join-ready.
      if (_playerSlot === 0 && _activeRoster && !_isPeerPendingLateJoin(remoteSid, peer)) {
        const slots = [..._activeRoster].sort((a, b) => a - b);
        try {
          ch.send(`roster:${_frameNum}:${slots.join(',')}`);
        } catch (_) {}
      }
      if (_playerSlot === 0 && _pendingLateJoinReadySids.has(remoteSid)) {
        finishLateJoinReady('deferred DC open', remoteSid);
      }

      if (_phase < PHASE_GAME_STARTED) startGameSequence();
    };
    ch.onopen = onOpen;
    // If the DataChannel is already open (race: ondatachannel delivered it
    // in the 'open' state), fire the handler immediately. Without this,
    // startGameSequence() never runs and the gesture prompt never appears.
    if (ch.readyState === 'open') onOpen();

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
          _runSubstate = RUN_LATE_JOIN_PAUSE;
          setStatus('Player joining...');
          _config?.onToast?.('Player joining...');
          _syncLog(`paused by host for late-join sync at frame ${_frameNum}`);
        }
        if (e.data === 'late-join-resume') {
          const wasPausedForLateJoin = _runSubstate === RUN_LATE_JOIN_PAUSE;
          if (wasPausedForLateJoin) _runSubstate = RUN_NORMAL;
          _lateJoin = false;
          clearLateJoinReadyRetry();
          _resetPacingAfterLateJoin();
          if (wasPausedForLateJoin) _config?.onToast?.('Player joined');
          _syncLog(`resumed by host after late-join sync at frame ${_frameNum}`);
        }
        if (e.data === 'late-join-ready') {
          finishLateJoinReady('DC', remoteSid);
        }
        if (e.data.startsWith('roster:')) {
          const parts = e.data.split(':');
          const rosterFrame = parseInt(parts[1], 10);
          const slots = parts[2] ? parts[2].split(',').map(Number) : [];
          const previousRoster = _activeRoster ? new Set(_activeRoster) : null;
          _clearPendingLateJoinRosterSlots(slots, 'host roster');
          _activeRoster = new Set(slots);
          _rosterChangeFrame = _frameNum;
          _applyControllerPresentMask('roster');
          const addedSlots = slots.filter((slot) => _isValidPlayerSlot(slot) && !previousRoster?.has(slot));
          if (_phase === PHASE_RUNNING && addedSlots.length > 0) {
            _startLateJoinInputBootstrap('roster added slot', addedSlots);
          }
          // Always use 4 (KN_MAX_PLAYERS) so the C engine covers all
          // slots regardless of gaps (e.g. roster [0,1,3]). Empty slots
          // get zero predictions — harmless since no input arrives.
          rb_numPlayers = 4;
          const rosterMod = window.EJS_emulator?.gameManager?.Module;
          if (_useCRollback && rosterMod?._kn_set_num_players) {
            rosterMod._kn_set_num_players(rb_numPlayers);
          }
          _syncLog(`ROSTER received: frame=${rosterFrame} slots=[${slots.join(',')}]`);
        }
        if (e.data.startsWith('phase:')) {
          if (_isPeerPendingLateJoin(remoteSid, peer)) {
            if (!peer._pendingLateJoinPhaseDroppedLogged) {
              peer._pendingLateJoinPhaseDroppedLogged = true;
              _syncLog(`dropping phase from pending late-join peer slot=${peer.slot} sid=${remoteSid}`);
            }
            return;
          }
          const parts = e.data.split(':');
          const phaseFrame = parseInt(parts[1], 10);
          const sceneCurr = parseInt(parts[2], 10);
          const gameStatus = parseInt(parts[3], 10);
          if (peer.slot !== null && peer.slot !== undefined) {
            const prev = _peerPhases[peer.slot];
            const safeScene = Number.isFinite(sceneCurr) ? sceneCurr : 0;
            const safeStatus = Number.isFinite(gameStatus) ? gameStatus : -1;
            _peerPhases[peer.slot] = {
              frame: Number.isFinite(phaseFrame) ? phaseFrame : -1,
              sceneCurr: safeScene,
              gameStatus: safeStatus,
              gameplay: safeScene === 22 && safeStatus === 1,
              seenAt: performance.now(),
            };
            const prevKey = prev ? `${prev.sceneCurr}:${prev.gameStatus}` : '';
            const nextKey = `${safeScene}:${safeStatus}`;
            if (prevKey !== nextKey) {
              _syncLog(`PHASE peer slot=${peer.slot} frame=${phaseFrame} scene=${safeScene} gameStatus=${safeStatus}`);
            }
          }
          return;
        }
        if (e.data.startsWith('menu-ready:')) {
          if (_isPeerPendingLateJoin(remoteSid, peer)) {
            if (!peer._pendingLateJoinMenuReadyDroppedLogged) {
              peer._pendingLateJoinMenuReadyDroppedLogged = true;
              _syncLog(`dropping menu-ready from pending late-join peer slot=${peer.slot} sid=${remoteSid}`);
            }
            return;
          }
          const parts = e.data.split(':');
          const readyFrame = parseInt(parts[1], 10);
          const readyScene = parseInt(parts[2], 10);
          if (peer.slot !== null && peer.slot !== undefined) {
            const prev = _menuStartReadyPeers[peer.slot];
            _menuStartReadyPeers[peer.slot] = {
              frame: Number.isFinite(readyFrame) ? readyFrame : -1,
              scene: Number.isFinite(readyScene) ? readyScene : 0,
            };
            if (!prev) {
              _syncLog(`MENU-BARRIER peer-ready slot=${peer.slot} frame=${readyFrame} scene=${readyScene}`);
            }
          }
          return;
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
        if (
          _isPeerPendingLateJoin(remoteSid, peer) &&
          (e.data.startsWith('rb-check:') ||
            e.data.startsWith('rb-blocks:') ||
            e.data.startsWith('rb-subhash:') ||
            e.data.startsWith('rb-regions:') ||
            e.data.startsWith('fpu-trace:'))
        ) {
          return;
        }
        // FPU trace: cross-platform determinism verification from host
        // Rollback state checksum verification
        if (e.data.startsWith('rb-check:')) {
          // Store peer's hash — compare when we reach the same frame
          // Format: rb-check:frame:gpHash:gameHash (gameHash added for full state detection)
          const parts = e.data.split(':');
          const checkFrame = parseInt(parts[1], 10);
          const peerHash = parseInt(parts[2], 10);
          const peerGameHash = parts.length > 3 ? parseInt(parts[3], 10) : null;
          if (!window._rbPendingChecks) window._rbPendingChecks = {};
          window._rbPendingChecks[checkFrame] = peerHash;
          if (peerGameHash !== null) {
            if (!window._rbPendingGameChecks) window._rbPendingGameChecks = {};
            window._rbPendingGameChecks[checkFrame] = peerGameHash;
          }
          return;
        }
        if (e.data.startsWith('rb-blocks:')) {
          // Peer's per-64KB-block RDRAM hashes. Diff against our own on
          // mismatch to localize divergence to a specific block index.
          const firstColon = e.data.indexOf(':');
          const secondColon = e.data.indexOf(':', firstColon + 1);
          const checkFrame = parseInt(e.data.slice(firstColon + 1, secondColon), 10);
          const peerBlocksHex = e.data.slice(secondColon + 1);
          if (!window._rbPendingBlocks) window._rbPendingBlocks = {};
          window._rbPendingBlocks[checkFrame] = peerBlocksHex;
          return;
        }
        if (e.data.startsWith('rb-subhash:')) {
          // Sub-region hashes from peer — used to narrow divergence within
          // a 64KB region down to a 256-byte sub-chunk. Format:
          //   rb-subhash:<frame>:<regionIdx>:<csv of FNV hashes>
          const parts = e.data.split(':');
          if (parts.length >= 4) {
            const subFrame = parseInt(parts[1], 10);
            const subRi = parseInt(parts[2], 10);
            const subCsv = parts.slice(3).join(':');
            if (!window._rbPendingSubHashes) window._rbPendingSubHashes = {};
            window._rbPendingSubHashes[`${subFrame}:${subRi}`] = subCsv;
          }
          return;
        }
        if (e.data.startsWith('rb-regions:')) {
          // Peer's per-region savestate-buffer hashes (32 regions covering
          // headers / DMA regs / RDRAM / SP mem / PIF / TLB / cp0 / cp1 /
          // event queue / fb tracker). On RB-CHECK mismatch, we diff these
          // against our own to localize divergence to a specific region —
          // crucial for finding non-RDRAM determinism gaps that the existing
          // rb-blocks (RDRAM-only) diagnostic can't see.
          const firstColon = e.data.indexOf(':');
          const secondColon = e.data.indexOf(':', firstColon + 1);
          const checkFrame = parseInt(e.data.slice(firstColon + 1, secondColon), 10);
          const peerRegionsCsv = e.data.slice(secondColon + 1);
          if (!window._rbPendingRegions) window._rbPendingRegions = {};
          window._rbPendingRegions[checkFrame] = peerRegionsCsv;
          return;
        }
        // Host-authoritative delay for rollback mode.
        //
        // CRITICAL: this message is the source of truth for delay across all
        // peers. Two cases:
        //   1. Init has not happened yet (deferred) → run init now with
        //      this delay. Both peers end up symmetric.
        //   2. Init already happened → can only update DELAY_FRAMES variable;
        //      C engine is locked in. This is the legacy buggy path —
        //      kept here only for the case where init somehow happened
        //      first (shouldn't happen for guests now).
        if (e.data.startsWith('rb-delay:')) {
          const hostDelay = clampRollbackDelay(e.data.split(':')[1], 0);
          if (hostDelay > 0) {
            // Cache for guests that haven't reached the init code yet.
            window._rbHostDelay = hostDelay;
            // Deferred init now waits for BOTH rb-delay AND rb-init-frame so
            // guest's rb.frame is set to the host's frame at init. The
            // rb-init-frame handler below covers the symmetric "fire when
            // delay was already known" case.
            if (window._rbPendingInit && window._rbDoInit && window._rbHostInitFrame !== undefined) {
              window._rbPendingInit = false;
              window._rbPendingInitAt = 0;
              DELAY_FRAMES = hostDelay;
              _syncLog(
                `rb-delay: deferred init triggered with host delay=${hostDelay} initFrame=${window._rbHostInitFrame}`,
              );
              window._rbDoInit(hostDelay, window._rbHostInitFrame);
            } else if (hostDelay !== DELAY_FRAMES) {
              // Init already ran (e.g. host, or race). C engine can't be
              // updated mid-flight; only the JS variable is changed, which
              // is the legacy buggy path. Log loudly so we notice.
              _syncLog(
                `rb-delay: WARN host set delay=${hostDelay} but JS was ${DELAY_FRAMES}; C engine NOT updated (already inited)`,
              );
              DELAY_FRAMES = hostDelay;
            }
          }
          return;
        }
        // Host-authoritative init frame: parallels rb-delay. Sent by host
        // from inside doRollbackInit so the value reflects the moment of
        // init (which can land at a different _frameNum than rb-delay's
        // game-start broadcast for the SR deferred-init path). Guest uses
        // this value in _kn_set_frame so both engines initialize rb.frame
        // to the same number; without this, asymmetric pacing during the
        // menu phase can leave the two engines off by N frames forever,
        // and exchanged input-frame numbers no longer correspond to the
        // same simulation point on both sides.
        if (e.data.startsWith('rb-init-frame:')) {
          const hostInitFrame = parseInt(e.data.split(':')[1], 10);
          if (Number.isFinite(hostInitFrame) && hostInitFrame >= 0) {
            window._rbHostInitFrame = hostInitFrame;
            if (
              window._rbPendingInit &&
              window._rbDoInit &&
              window._rbHostDelay !== undefined &&
              window._rbHostDelay > 0
            ) {
              window._rbPendingInit = false;
              window._rbPendingInitAt = 0;
              DELAY_FRAMES = window._rbHostDelay;
              _syncLog(
                `rb-init-frame: deferred init triggered with host delay=${window._rbHostDelay} initFrame=${hostInitFrame}`,
              );
              window._rbDoInit(window._rbHostDelay, hostInitFrame);
            }
          }
          return;
        }
        // P2/T4: host-authoritative transport mode for rollback input packets.
        // Parallel to rb-delay — host broadcasts, guests adopt. Any value
        // other than 'unreliable' is treated as reliable (the safe default).
        if (e.data.startsWith('rb-transport:')) {
          const mode = e.data.slice('rb-transport:'.length);
          _rbTransport = mode === 'unreliable' ? 'unreliable' : 'reliable';
          _syncLog(`rb-transport: host=${mode} adopted=${_rbTransport}`);
          return;
        }
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
              const eqHash = gMod._kn_eventqueue_hash?.() ?? 0;
              _syncLog(`sync OK frame=${syncFrame} hash=${hostHash} eq=${(eqHash >>> 0).toString(16)}`);
            }
            return;
          }
          const eqHashMM = gMod._kn_eventqueue_hash?.() ?? 0;
          _syncLog(
            `RDRAM-DESYNC frame=${syncFrame} local=${guestHash} host=${hostHash} eq=${(eqHashMM >>> 0).toString(16)} myFrame=${_frameNum}`,
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
            _syncTargetDeadlineAt = performance.now() + SYNC_COORD_TIMEOUT_MS; // I1 (MF3)
            _syncLog(
              `sending sync-request-full-at:${_coordTarget} (RDRAM desync, cooldown=${Math.round(cooldownElapsed)}ms)`,
            );
            try {
              peer.dc.send(`sync-request-full-at:${_coordTarget}`);
            } catch (e2) {
              _syncLog(`sync-request send failed: ${e2}`);
              _resyncRequestInFlight = false;
              _syncTargetFrame = -1;
              _syncTargetDeadlineAt = 0;
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
            // I1 (MF3): record wall-clock deadline so the drain
            // loop below can process the request immediately at
            // current frame if frame pacing can't reach targetFrame
            // in time.
            _scheduledSyncRequests.push({
              targetFrame,
              targetSid: remoteSid,
              forceFull: isFull,
              deadlineAt: performance.now() + SYNC_COORD_TIMEOUT_MS,
            });
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
              peer.rollbackCaps = msg.caps && typeof msg.caps === 'object' ? msg.caps : {};
              _lockstepReadyPeers[remoteSid] = true;
              checkAllLockstepReady();
            } else if (msg.type === 'digest') {
              if (window.KNDesync) {
                KNDesync.onPeerDigest(remoteSid, msg);
              }
            } else if (_onUnhandledMessage) {
              _onUnhandledMessage(remoteSid, msg);
            }
          } catch (_) {}
        }
        return;
      }

      // Binary: encoded input.
      //   Legacy formats: 16 bytes (no ack) or 20 bytes (with ack).
      //   New format (rollback P2 redundancy): 24 + 16*N bytes, 0 ≤ N ≤ 8.
      //   All formats are int32-aligned, so byteLength % 4 === 0.
      if (
        e.data instanceof ArrayBuffer &&
        e.data.byteLength >= 16 &&
        e.data.byteLength <= 256 &&
        e.data.byteLength % 4 === 0
      ) {
        _processInputPacket(remoteSid, peer, e.data);
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
          _syncLastChunkProgressLogAt = 0;
          _syncChunkSessionId++;
          if (_syncChunkTimeoutTimer) clearTimeout(_syncChunkTimeoutTimer);
          const sessionId = _syncChunkSessionId;
          _syncChunkTimeoutTimer = setTimeout(() => {
            if (sessionId !== _syncChunkSessionId || _syncExpected <= 0) return;
            const received = _syncChunks.length;
            _syncLog(
              `sync chunks timeout: ${received}/${_syncExpected} chunks after ${SYNC_CHUNK_TIMEOUT_MS}ms — requesting socket full sync`,
            );
            _syncChunks = [];
            _syncExpected = 0;
            _resyncRequestInFlight = false;
            _requestSocketFullResync('sync-chunk-timeout');
          }, SYNC_CHUNK_TIMEOUT_MS);
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
          _syncLastChunkProgressLogAt = 0;
          _syncChunkSessionId++;
          _syncLog(`sync-regions-start received: frame=${_syncFrame} expected=${_syncExpected}`);
          return;
        }
      }
      // Binary: sync state chunks
      if (e.data instanceof ArrayBuffer) {
        if (_syncExpected > 0) {
          _syncChunks.push(new Uint8Array(e.data));
          const now = performance.now();
          if (
            _syncChunks.length === 1 ||
            _syncChunks.length === _syncExpected ||
            now - _syncLastChunkProgressLogAt >= 1000
          ) {
            _syncLastChunkProgressLogAt = now;
            _syncLog(`sync chunks progress: ${_syncChunks.length}/${_syncExpected}`);
          }
          if (_syncChunks.length >= _syncExpected) {
            if (_syncChunkTimeoutTimer) {
              clearTimeout(_syncChunkTimeoutTimer);
              _syncChunkTimeoutTimer = null;
            }
            _syncLog(`sync chunks complete: ${_syncChunks.length}/${_syncExpected} chunks received`);
            handleSyncChunksComplete();
          }
          return;
        }
        _syncLog(`WARN: binary data (${e.data.byteLength}B) on sync-state DC but _syncExpected=0 — dropped`);
      }
    };
  };

  // -- Per-peer state cleanup (Invariant I2) --------------------------------

  const clearPeerStallTimers = () => {
    if (_bootStallFrame >= 0) {
      _bootStallFrame = -1;
      _bootStallStartTime = 0;
      _bootStallRecoveryFired = false;
    }
    if (_phaseLockStallKey) {
      _phaseLockStallKey = '';
      _phaseLockStallStartTime = 0;
    }
    if (_rbInputStallKey) {
      _rbInputStallKey = '';
      _rbInputStallStartTime = 0;
    }
  };

  const resetPeerRollbackTransport = (peer, sid, reason) => {
    if (!peer) return;
    peer.rbDc = null;
    peer.rbDcUnreliable = false;
    if (sid) _dcBufferStaleStreak[sid] = 0;
    clearPeerStallTimers();
    _syncLog(`RB-TRANSPORT-RESET slot=${peer.slot ?? 'null'} reason=${reason}`);
  };

  /**
   * Resets ALL per-peer state for a given slot. This is the single
   * authoritative cleanup path for peer disconnects, reconnects,
   * phantom clears, tab-visibility resets, and game stop.
   *
   * Invariant I2 ("Reconnect starts clean"): every disconnect,
   * reconnect, or cleanup path must route through this function.
   * Adding new per-peer state without updating this function is a
   * code-review-level violation.
   *
   * See docs/netplay-invariants.md §I2.
   *
   * Fields reset for slot-indexed globals:
   *   - _remoteInputs[slot]            (input buffer)
   *   - _peerInputStarted[slot]        (first-input-received flag)
   *   - _lastRemoteFramePerSlot[slot]  (highest received frame)
   *   - _peerLastAdvanceTime[slot]     (wall-clock of last new frame)
   *   - _peerPhantom[slot]             (dead-peer flag)
   *   - _peerPhases[slot]              (last menu/gameplay phase broadcast)
   *   - _phaseMismatchGrace[slot]      (phase transition grace window)
   *   - _consecutiveFabrications[slot] (fabrication counter)
   *   - _inputLateLogTime[slot]        (rate-limit timestamp)
   *   - _auditRemoteInputs[slot]       (audit log buffer)
   *   - _lateJoinActivatedAtFrame[slot] (post-activation grace window)
   *
   * Fields reset for per-peer-object state (if peer provided):
   *   - peer.lastAckFromPeer
   *   - peer.lastFrameFromPeer
   *   - peer.lastAckAdvanceTime
   *
   * Shared queues filtered to remove entries for this slot:
   *   - _pendingCInputs (by slot)
   *   - _scheduledSyncRequests (by targetSid if sid provided)
   *
   * Boot-stall tracking cleared if currently stalled:
   *   - _bootStallFrame / _bootStallStartTime / _bootStallRecoveryFired
   *
   * @param {number} slot - player slot to clear (0-3)
   * @param {string} reason - short human-readable reason for the reset;
   *   used in PEER-RESET log and analyze_match.py attribution
   * @param {Object} [opts] - optional extras
   * @param {Object} [opts.peer] - peer object to clear ack state on
   * @param {string} [opts.sid] - socket.io sid to filter scheduled syncs
   */
  const resetPeerState = (slot, reason, opts = {}) => {
    if (slot === null || slot === undefined) return;
    _clearPendingLateJoinPeer(opts.sid || null, slot, reason);

    // Slot-indexed globals
    delete _remoteInputs[slot];
    delete _peerInputStarted[slot];
    delete _lastRemoteFramePerSlot[slot];
    delete _peerLastAdvanceTime[slot];
    delete _peerPhantom[slot];
    delete _peerPhases[slot];
    delete _phaseMismatchGrace[slot];
    delete _consecutiveFabrications[slot];
    delete _inputLateLogTime[slot];
    delete _auditRemoteInputs[slot];
    delete _auditLastRemote[slot];
    delete _lateJoinActivatedAtFrame[slot];
    delete _lateJoinSeededInputFrames[slot];

    // Per-peer-object ack state
    if (opts.peer) {
      opts.peer.lastAckFromPeer = -1;
      opts.peer.lastFrameFromPeer = -1;
      opts.peer.lastAckAdvanceTime = 0;
    }

    // Shared queues — filter out entries for this slot/sid
    for (let i = _pendingCInputs.length - 1; i >= 0; i--) {
      if (_pendingCInputs[i].slot === slot) _pendingCInputs.splice(i, 1);
    }
    if (opts.sid) {
      _scheduledSyncRequests = _scheduledSyncRequests.filter((r) => r.targetSid !== opts.sid);
    }

    // Stall tracking — if we were stalled waiting on this slot's apply
    // frame, clear tracking so the stall clock restarts cleanly once a
    // new peer fills the slot.
    clearPeerStallTimers();

    // C-side: clear the rollback engine's per-slot state. Without this,
    // slot_active stays sticky once kn_feed_input has ever seen the
    // slot, polluting prediction and stats across roster changes.
    if (_useCRollback) {
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (mod?._kn_rollback_slot_reset) mod._kn_rollback_slot_reset(slot);
    }

    _syncLog(`PEER-RESET slot=${slot} reason=${reason}`);
  };

  // -- Peer disconnect (drop handling) ---------------------------------------

  const handlePeerDisconnect = (remoteSid) => {
    const peer = _peers[remoteSid];
    if (!peer) return;
    if (peer._disconnectTimer) {
      clearTimeout(peer._disconnectTimer);
      peer._disconnectTimer = null;
    }

    if (_phase < PHASE_GAME_STARTED && peer.isInitiator && !peer._intentionalLeave) {
      _syncLog(`startup peer ${remoteSid} disconnected before game start — retrying`);
      retryStartupConnection(remoteSid);
      return;
    }

    if (_isPeerPendingLateJoin(remoteSid, peer)) {
      _syncLog(`pending late-join peer ${remoteSid} disconnected before activation`);
      hardDisconnectPeer(remoteSid);
      return;
    }

    // If game is running and not an intentional leave, attempt reconnect
    if (_phase === PHASE_RUNNING && !peer._intentionalLeave) {
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

      // 45-second timeout — give up and hard disconnect (allows up to 3 retry attempts)
      peer._reconnectTimeout = setTimeout(() => {
        if (!_peers[remoteSid] || !_peers[remoteSid].reconnecting) return;
        _syncLog(`reconnect timeout for ${remoteSid} after ${peer._reconnectAttempts || 1} attempts`);
        hardDisconnectPeer(remoteSid);
      }, 45000);

      return;
    }

    hardDisconnectPeer(remoteSid);
  };

  const hardDisconnectPeer = (remoteSid) => {
    const peer = _peers[remoteSid];
    if (!peer) return;
    clearStartupConnectWatchdog(peer);
    if (peer._reconnectTimeout) {
      clearTimeout(peer._reconnectTimeout);
      peer._reconnectTimeout = null;
    }

    if (peer.slot !== null && peer.slot !== undefined) {
      try {
        writeInputToMemory(peer.slot, 0);
      } catch (_) {}
      // I2: route all per-peer cleanup through resetPeerState so
      // every field gets cleared consistently. Non-hosts must
      // preserve _peerInputStarted until the host's roster broadcast
      // removes the slot, so we save/restore that one field.
      if (_playerSlot === 0 || !_activeRoster) {
        resetPeerState(peer.slot, 'hard-disconnect', { peer, sid: remoteSid });
      } else {
        const startedBefore = _peerInputStarted[peer.slot];
        resetPeerState(peer.slot, 'hard-disconnect-non-host', { peer, sid: remoteSid });
        if (startedBefore) _peerInputStarted[peer.slot] = startedBefore;
      }
    }

    const _leftSlot = peer.slot;
    delete _peers[remoteSid];
    delete _lockstepReadyPeers[remoteSid];
    KNState.peers = _peers;
    _syncLog(`peer hard-disconnected: ${remoteSid} slot: ${peer.slot}`);
    if (_playerSlot === 0 && _phase === PHASE_RUNNING) {
      _broadcastRoster();
    }
    // P0-1 funnel: emit peer_left only from the host so the per-session timeline
    // doesn't get N duplicate events (one per remaining observer). Includes the
    // left peer's slot in meta so the admin view can attribute it correctly.
    if (_playerSlot === 0 && _leftSlot != null && _leftSlot !== undefined) {
      KNEvent('peer_left', '', { peer_slot: _leftSlot });
    }

    const known = _knownPlayers[remoteSid];
    const name = known ? known.playerName : `P${(peer.slot ?? 0) + 1}`;

    const remaining = getActivePeers();
    if (remaining.length === 0 && _phase === PHASE_RUNNING) {
      setStatus('All peers disconnected -- running solo');
    } else if (_phase === PHASE_RUNNING) {
      const count = remaining.length + 1;
      setStatus(`${name} dropped -- ${count} player${count > 1 ? 's' : ''} remaining`);
    }
    _config?.onToast?.(`${name} dropped`);
    _config?.onReconnecting?.(remoteSid, false);
  };

  const _MAX_RECONNECT_ATTEMPTS = 3;
  const _RECONNECT_ATTEMPT_TIMEOUT = 10000; // 10s per attempt
  const _RECONNECT_RETRY_DELAY = 3000; // 3s between retries

  const attemptReconnect = async (remoteSid, attempt = 1) => {
    const peer = _peers[remoteSid];
    if (!peer || !peer.reconnecting) return;
    peer._reconnectAttempts = attempt;

    _syncLog(`initiating reconnect to ${remoteSid} (attempt ${attempt}/${_MAX_RECONNECT_ATTEMPTS})`);
    const known = _knownPlayers[remoteSid];
    const name = known ? known.playerName : `P${(peer.slot ?? 0) + 1}`;
    setStatus(`${name} disconnected — reconnecting (attempt ${attempt})...`);

    const peerGuard = (p) => _peers[remoteSid] === p;
    KNShared.resetPeerConnection(peer, _getIceServers(), remoteSid, socket, peerGuard);
    peer.ready = false;

    const retryOrGiveUp = () => {
      if (!_peers[remoteSid] || !_peers[remoteSid].reconnecting) return;
      if (attempt < _MAX_RECONNECT_ATTEMPTS) {
        _syncLog(`reconnect attempt ${attempt} failed — retrying in ${_RECONNECT_RETRY_DELAY}ms`);
        setStatus(`${name} disconnected — retry in ${Math.round(_RECONNECT_RETRY_DELAY / 1000)}s...`);
        setTimeout(() => attemptReconnect(remoteSid, attempt + 1), _RECONNECT_RETRY_DELAY);
      } else {
        _syncLog(`reconnect failed after ${_MAX_RECONNECT_ATTEMPTS} attempts — hard disconnect ${remoteSid}`);
        hardDisconnectPeer(remoteSid);
      }
    };

    // Timeout: if this attempt doesn't reach 'connected' in time, retry
    let _reconnectTimer2 = setTimeout(() => {
      const state = peer.pc.connectionState;
      if (state !== 'connected') {
        _syncLog(`reconnect attempt ${attempt} timeout (state=${state}) for ${remoteSid}`);
        retryOrGiveUp();
      }
    }, _RECONNECT_ATTEMPT_TIMEOUT);
    peer.pc.onconnectionstatechange = () => {
      const s = peer.pc.connectionState;
      _syncLog(`reconnect peer ${remoteSid} connection-state: ${s} (attempt ${attempt})`);
      if (s === 'connected' || s === 'closed') {
        clearTimeout(_reconnectTimer2);
      }
      if (s === 'failed') {
        clearTimeout(_reconnectTimer2);
        _syncLog(`reconnect PC failed for ${remoteSid} (attempt ${attempt})`);
        retryOrGiveUp();
      }
    };

    peer.pc.ondatachannel = (e) => {
      if (e.channel.label === 'lockstep') {
        peer.dc = e.channel;
        setupDataChannel(remoteSid, peer.dc);
      } else if (e.channel.label === 'sync-state') {
        peer.syncDc = e.channel;
        setupSyncDataChannel(remoteSid, peer.syncDc);
      } else if (e.channel.label === 'rollback-input') {
        if (peer.rbDc)
          try {
            peer.rbDc.onclose = null;
            peer.rbDc.close();
          } catch (_) {}
        peer.rbDc = e.channel;
        peer.rbDcUnreliable = false;
        setupRollbackInputDataChannel(remoteSid, peer.rbDc);
      } else if (_onExtraDataChannel) {
        _onExtraDataChannel(remoteSid, e.channel);
      }
    };

    // Create new DCs and send offer with reconnect flag
    peer.dc = peer.pc.createDataChannel('lockstep', { ordered: true });
    setupDataChannel(remoteSid, peer.dc);
    peer.syncDc = peer.pc.createDataChannel('sync-state', { ordered: true, priority: 'very-low' });
    setupSyncDataChannel(remoteSid, peer.syncDc);
    peer.rbDc = peer.pc.createDataChannel('rollback-input', { ordered: false, maxRetransmits: 0 });
    peer.rbDcUnreliable = false;
    setupRollbackInputDataChannel(remoteSid, peer.rbDc);

    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      socket.emit('webrtc-signal', {
        target: remoteSid,
        offer: peer.pc.localDescription,
        reconnect: true,
      });
    } catch (err) {
      _syncLog(`reconnect offer failed (attempt ${attempt}): ${err}`);
      retryOrGiveUp();
    }
  };

  // -- Helper: get active player peers ---------------------------------------

  // All connected player peers (for sending input to)
  const getActivePeers = () =>
    Object.entries(_peers)
      .filter(
        ([sid, p]) =>
          p.slot !== null &&
          p.slot !== undefined &&
          p.dc &&
          p.dc.readyState === 'open' &&
          !_isPeerPendingLateJoin(sid, p),
      )
      .map(([, p]) => p);

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
  const getInputPeers = (includeUnstarted = false) => {
    if (_activeRoster) {
      // Roster mode: return one peer per roster slot (excluding self).
      // Deduplicate by slot — if zombie peers survive, prefer the one with
      // an open DataChannel. Peers may have dead DCs — the stall/fabrication
      // path handles that.
      const bySlot = new Map();
      for (const [sid, p] of Object.entries(_peers)) {
        if (p.slot === null || p.slot === undefined) continue;
        if (_isPeerPendingLateJoin(sid, p)) continue;
        if (!_activeRoster.has(p.slot)) continue;
        if (_isLateJoinActivationGrace(p.slot) && !_peerInputStarted[p.slot]) continue;
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
      if (includeUnstarted) return true;
      if (_peerInputStarted[p.slot]) return true;
      // Boot grace: include connected peers before their first input arrives
      return _frameNum < BOOT_GRACE_FRAMES;
    });
  };

  const markPeerPhantomForStallTimeout = (slot, reason, detail = '') => {
    if (slot === null || slot === undefined || _peerPhantom[slot]) return;
    _peerPhantom[slot] = true;
    const suffix = detail ? ` ${detail}` : '';
    _syncLog(`PEER-PHANTOM slot=${slot} reason=${reason}${suffix}`);
    window.dispatchEvent(new CustomEvent('kn-peer-phantom', { detail: { slot } }));
  };

  // -- Game start sequence ---------------------------------------------------

  // Minimum frames the emulator must run before we consider it ready.
  const MIN_BOOT_FRAMES = 120; // ~2 seconds at 60fps

  const startGameSequence = () => {
    if (_phase >= PHASE_GAME_STARTED) return;
    _phase = PHASE_GAME_STARTED;
    _checkStateTransition();

    // P0-1 funnel: lockstep handshake complete, input exchange beginning.
    // This is the meaningful "the player can play now" signal.
    KNEvent('first_frame_rendered', '', { player_slot: _playerSlot ?? -1 });

    // Spectators: don't start emulator, don't enter manual mode
    if (_isSpectator) {
      setStatus('Spectating...');
      return;
    }

    let _bootPollCount = 0;
    let _bootGestureReceived = false;

    // All players (host + guest) get a gesture prompt before boot.
    // This ensures the AudioContext is created fresh inside the click
    // handler — Safari suspends AudioContexts created outside a gesture
    // after ~10s, which caused the host's pre-created context to go stale.
    {
      const showGesturePrompt = () => {
        _syncLog(`showing gesture prompt (slot=${_playerSlot})`);
        const promptEl = document.getElementById('gesture-prompt');
        if (!promptEl) return;
        promptEl.classList.remove('hidden');
        // AbortController so stop() can drop the click+touchend listeners
        // even when the user never gestures. Replaces the manual
        // removeEventListener pair below — abort() cleans both atomically.
        if (_bootGestureAbort) _bootGestureAbort.abort();
        _bootGestureAbort = new AbortController();
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
          //
          // BF3: if document is hidden when gesture fires, AudioContext.resume()
          // will throw NotAllowedError. We still create the contexts (they'll
          // be resumed by the BF6 visibilitychange handler when tab returns).
          const AC = window.AudioContext || window.webkitAudioContext;
          if (AC) {
            const _ejsCtx = new AC();
            _ejsCtx.resume().catch((e) => {
              _syncLog(`EJS AudioContext resume: ${e.name}: ${e.message}`);
              if (e.name === 'NotAllowedError') {
                _syncLog('BF3: gesture fired while hidden — audio will resume on tab return');
              }
            });
            // Pre-create the lockstep AudioContext at 44100Hz (N64 core rate).
            // iOS WKWebView may silently fail when AudioBufferSourceNode
            // buffers don't match the context's sample rate.
            // Stored as _kn_preloadedAudioCtx — KNAudio.init() picks it up.
            if (!window._kn_preloadedAudioCtx) {
              let _preCtx;
              try {
                _preCtx = new AC({ sampleRate: 44100 });
              } catch (_) {
                _preCtx = new AC(); // fallback to native rate
              }
              _preCtx.resume().catch((e) => {
                _syncLog(`lockstep AudioContext resume: ${e.name}: ${e.message}`);
              });
              // iOS FxiOS (WKWebView): ScriptProcessorNode → destination produces
              // no audible output even though samples flow and ctx reports running.
              // Route through <audio> element instead — iOS grants privileged audio
              // output to <audio>.play() called within a gesture. We set it up HERE
              // (in the gesture handler) so the .play() authorization persists.
              const gestDest = _preCtx.createMediaStreamDestination();
              const gestAudio = document.createElement('audio');
              gestAudio.srcObject = gestDest.stream;
              gestAudio.play().catch(() => {});
              window._kn_gestureAudioEl = gestAudio;
              window._kn_gestureAudioDest = gestDest;
              // Keep-alive: silent oscillator through the <audio> element so the
              // iOS audio session stays active until real audio takes over.
              const _keepAliveGain = _preCtx.createGain();
              _keepAliveGain.gain.value = 0;
              const _keepAliveOsc = _preCtx.createOscillator();
              _keepAliveOsc.connect(_keepAliveGain);
              _keepAliveGain.connect(gestDest);
              _keepAliveOsc.start();
              window._kn_keepAliveOsc = _keepAliveOsc;
              window._kn_preloadedAudioCtx = _preCtx;
              _syncLog(`lockstep AudioContext pre-created in gesture (rate: ${_preCtx.sampleRate})`);
            }
            const _RealAC = AC;
            const _RealWebkitAC = window.webkitAudioContext || _RealAC;
            let _hijacked = false;
            // CONSTRUCTOR — called with `new` by EmulatorJS. Must remain a
            // `function` declaration (arrow functions cannot be constructors).
            const _HijackAC = function () {
              if (!_hijacked) {
                _hijacked = true;
                // Restore original constructors
                if (window.AudioContext === _HijackAC) window.AudioContext = _RealAC;
                if (window.webkitAudioContext === _HijackAC) window.webkitAudioContext = _RealWebkitAC;
                _acHijackRestore = null;
                _syncLog('AudioContext hijack: returning gesture-unlocked context');
                return _ejsCtx;
              }
              return new _RealAC();
            };
            _HijackAC.prototype = _RealAC.prototype;
            _acHijackRestore = { real: _RealAC, realWebkit: _RealWebkitAC, hijack: _HijackAC };
            if (window.AudioContext) window.AudioContext = _HijackAC;
            if (window.webkitAudioContext) window.webkitAudioContext = _HijackAC;
          }
          // Start or wake EmulatorJS from the same gesture path every time.
          // Guests defer fresh EJS construction until here so a second ROM in
          // the same tab follows the same boot path as the first ROM.
          window.KNStartEmulatorBoot?.({ forceStartOnLoad: true });
          // Start emulator within gesture context so audio works. The local
          // 1P demo keeps ROMs hashless/in-memory, so don't infer vanilla SSB64
          // and apply standard GameShark codes to an unknown ROM.
          if (_config?.disableStandardCheats === true) {
            KNShared.waitForEmulator?.()?.catch?.((err) => {
              _syncLog(`demo boot wait failed: ${err?.message || err}`);
            });
            KNShared.clearCheats?.(false);
            KNShared.disableEJSInput?.('lockstep');
          } else {
            KNShared.bootWithCheats('lockstep');
          }
          setStatus('Loading emulator...');
          _syncLog('gesture received — emulator starting');
          if (_bootGestureAbort) {
            _bootGestureAbort.abort();
            _bootGestureAbort = null;
          }
        };
        promptEl.addEventListener('click', onPromptClick, { signal: _bootGestureAbort.signal });
        promptEl.addEventListener('touchend', onPromptClick, { signal: _bootGestureAbort.signal });
      };

      if (window.EJS_gameUrl) {
        showGesturePrompt();
      } else {
        _syncLog('ROM not loaded yet, deferring gesture prompt');
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
      // Bail if the engine stopped before the user ever gestured —
      // without this, the "wait for gesture" branch keeps rescheduling
      // setTimeout(waitForEmu, 200) every 200ms after stop(). The 30s
      // poll-timeout below only fires once _bootGestureReceived flips.
      if (_phase === PHASE_IDLE || _phase === PHASE_STOPPED) return;
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
      const rawSimulateInputForDiscovery = mod?._kn_netplay_simulate_input || mod?._simulate_input;
      const simulateInputForDiscovery = rawSimulateInputForDiscovery?.bind(mod);
      if (!simulateInputForDiscovery) {
        if (_bootPollCount++ % 5 === 0) setStatus('Booting emulator...');
        setTimeout(waitForEmu, 100);
        return;
      }

      const bootCanvasHealth = _diag.sampleCanvasHealth?.();
      if (bootCanvasHealth?.solidPale) {
        _syncLog(
          `CANVAS-BOOT-BLOCK solid pale/yellow before sync ` +
            `rgb=${bootCanvasHealth.meanR ?? '?'},${bootCanvasHealth.meanG ?? '?'},${bootCanvasHealth.meanB ?? '?'} ` +
            `bright=${bootCanvasHealth.brightness ?? '?'} stdev=${bootCanvasHealth.stdev ?? '?'} ` +
            `paleRatio=${bootCanvasHealth.paleRatio ?? '?'} yellowGreenRatio=${bootCanvasHealth.yellowGreenRatio ?? '?'}`,
        );
        const recovery = window.KNRecoverSolidCanvas?.({
          reason: 'lockstep-boot',
          health: bootCanvasHealth,
        });
        if (recovery) {
          _bootPollCount = 0;
          _bootGestureReceived = false;
          setStatus(`Renderer retry (${recovery.profile}) — tap to continue`);
          showGesturePrompt();
          setTimeout(waitForEmu, 200);
          return;
        }
        setStatus('Renderer failed to start — try reloading the page');
        _config?.onStatus?.('Renderer failed to start — try reloading');
        return;
      }

      // Auto-discover INPUT_BASE by calling _simulate_input and detecting the change
      if (simulateInputForDiscovery) {
        try {
          // Reset button 0 for player 0
          simulateInputForDiscovery(0, 0, 0);
          const scanEnd = Math.min(mod.HEAPU8.length, 4 * 1024 * 1024);
          const snap = new Uint8Array(mod.HEAPU8.buffer.slice(0, scanEnd));
          simulateInputForDiscovery(0, 0, 1);
          for (let si = 0; si < scanEnd; si++) {
            if (mod.HEAPU8[si] !== snap[si]) {
              INPUT_BASE = si;
              break;
            }
          }
          simulateInputForDiscovery(0, 0, 0);
          _syncLog(`INPUT_BASE auto-discovered: ${INPUT_BASE}`);

          // Discover per-player input base addresses (button 0 address for each player)
          // This replaces the old per-button scan which only covered player 0.
          const scanRange = 8 * 1024 * 1024; // 8MB scan window
          const scanLen = Math.min(mod.HEAPU8.length, scanRange);
          for (let pi = 0; pi < 4; pi++) {
            simulateInputForDiscovery(pi, 0, 0);
            const pSnap = new Uint8Array(mod.HEAPU8.buffer.slice(0, scanLen));
            simulateInputForDiscovery(pi, 0, 1);
            for (let psi = 0; psi < scanLen; psi++) {
              if (mod.HEAPU8[psi] !== pSnap[psi]) {
                _diag.playerAddrs[pi] = psi;
                break;
              }
            }
            simulateInputForDiscovery(pi, 0, 0);
          }
          _syncLog(`per-player input addrs: ${JSON.stringify(_diag.playerAddrs)}`);
        } catch (e) {
          _syncLog(`INPUT_BASE auto-discovery failed, using default: ${INPUT_BASE}`);
        }
      }

      // Pause immediately to prevent any more free frames
      mod.pauseMainLoop();
      _syncLog(`emulator ready (${frames} frames) — paused${_playerSlot === 0 ? ' (host)' : ' (guest)'}`);
      _applyControllerPresentMask('emulator-ready');

      // Set up key tracking now that ejs.controls is available
      _p1KeyMap = null; // force re-read from EJS controls
      setupKeyTracking();

      _phase = PHASE_EMU_READY;
      _checkStateTransition();
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
    if (_phase < PHASE_EMU_READY) return;
    if (_isSpectator) return;
    if (_phase === PHASE_RUNNING) return;
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

    if (_phase >= PHASE_SYNCING) return; // guard against re-entrant calls
    _phase = PHASE_SYNCING;

    _syncLog(`${readyPeers.length + 1} emulators ready -- syncing initial state`);
    setStatus('Syncing...');

    if (_isSyntheticOnlyInitialSyncSkip()) {
      _syncLog('synthetic demo: skipping initial state sync');
      _phase = PHASE_LOCKSTEP_READY;
      if (_rttComplete) broadcastLockstepReady();
      checkAllLockstepReady();
      return;
    }

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

    // Timeout: if sync hasn't completed, reset sync state so a
    // reconnecting peer can re-trigger the sync flow instead of getting stuck.
    // Capture _sessionId so the timer is invalidated if stop()/init() runs.
    const sid = _sessionId;
    const syncTimeoutMs = _isSmashRemix() ? INITIAL_SMASH_TITLE_TIMEOUT_MS + 30000 : 30000;
    setTimeout(() => {
      if (sid !== _sessionId) return; // stale timer from previous session
      if (_phase !== PHASE_RUNNING && _phase >= PHASE_EMU_READY) {
        setStatus('Sync timed out — waiting for reconnect...');
        _config?.onToast?.('Sync stalled — waiting for peer to reconnect');
        _phase = PHASE_EMU_READY; // allow sync retry
        _lockstepReadyPeers = {};
      }
    }, syncTimeoutMs);
  };

  const checkAllLockstepReady = () => {
    if (_phase < PHASE_LOCKSTEP_READY) return;
    if (_phase === PHASE_RUNNING) return;

    // Check that at least 1 player peer is lockstep-ready
    const playerPeerSids = Object.keys(_peers).filter((sid) => {
      const p = _peers[sid];
      return p.slot !== null && p.slot !== undefined;
    });
    const soloMode = playerPeerSids.length === 0;
    const readyCount = playerPeerSids.filter((sid) => _lockstepReadyPeers[sid]).length;

    if (readyCount < playerPeerSids.length) return;

    const localCaps = _localRollbackCaps();
    for (const sid of playerPeerSids) {
      const p = _peers[sid];
      if (p?.synthetic === true) continue;
      const peerCaps = p?.rollbackCaps || {};
      const peerRdpReplaySkip = !!peerCaps.rdpReplaySkip;
      if (peerRdpReplaySkip !== localCaps.rdpReplaySkip) {
        _syncLog(
          `CORE-CAP-MISMATCH sid=${sid} localRdpReplaySkip=${localCaps.rdpReplaySkip ? 1 : 0} ` +
            `peerRdpReplaySkip=${peerRdpReplaySkip ? 1 : 0} — refusing rollback start`,
        );
        setStatus('Core version mismatch -- reload both players');
        _config?.onToast?.('Core version mismatch -- reload both players');
        return;
      }
      const peerTrueRollback = !!peerCaps.trueRollback;
      if (peerTrueRollback !== localCaps.trueRollback) {
        _syncLog(
          `CORE-CAP-MISMATCH sid=${sid} localTrueRollback=${localCaps.trueRollback ? 1 : 0} ` +
            `peerTrueRollback=${peerTrueRollback ? 1 : 0} — refusing rollback start`,
        );
        setStatus('Core version mismatch -- reload both players');
        _config?.onToast?.('Core version mismatch -- reload both players');
        return;
      }
      const peerStateBackend = peerCaps.stateBackend || 'retro';
      if (peerStateBackend !== localCaps.stateBackend) {
        _syncLog(
          `CORE-CAP-MISMATCH sid=${sid} localStateBackend=${localCaps.stateBackend} ` +
            `peerStateBackend=${peerStateBackend} — refusing rollback start`,
        );
        setStatus('Core version mismatch -- reload both players');
        _config?.onToast?.('Core version mismatch -- reload both players');
        return;
      }
    }

    // Negotiate delay: ceiling of all players.
    // Rollback mode: both players independently compute from RTT/2, then take max.
    // Peer delay values from lockstep-ready handshake use the old lockstep formula,
    // so we recalculate them using peer RTT samples with the rollback formula.
    const hasRollback = !!window.EJS_emulator?.gameManager?.Module?._kn_pre_tick;
    let ownDelay;
    if (soloMode) {
      ownDelay = 0;
      _syncLog('solo delay: no player peers, effective delay=0');
    } else if (hasRollback && _rttMedian > 0) {
      // Fix #1: Adaptive jitter buffer.
      //
      // Rollback delay sets the input prediction window — peers wait this
      // many frames before applying any input, giving the network time to
      // deliver. Setting it correctly is the difference between "feels
      // smooth on bad network" and "constant rollbacks/desync".
      //
      // Old formula: delay = ceil((median/2 + jitter) / 16.67), CAPPED AT 9.
      // The cap was the problem — networks with 100ms+ jitter need delay
      // 12+ frames but were silently clamped to 9, leaving every spike
      // uncovered. Match 34d3299e ran with delay=9 on a 110ms-jitter
      // network and desynced after 10 seconds because every jitter spike
      // arrived past the delay budget and triggered a deep misprediction
      // that the new depth-3 cap couldn't recover from.
      //
      // New formula: take a 95th-percentile-style jitter measure (max of
      // recent samples MINUS median, not max-min — more robust to one
      // outlier sample), add a 1-frame safety margin, and let delay go
      // up to 15 frames. The cap matches the rollback ring size so we
      // never have a delay larger than the rollback can absorb.
      //
      // The cost: higher delay = more input lag. Worth it because the
      // alternative is rollbacks that feel like rewinds OR full desyncs.
      // User feedback explicitly accepted "slight extra latency" over
      // "snap rollback feel" — this is enacting that preference at the
      // delay-budget level.
      const sorted = _rttSamples.slice().sort((a, b) => a - b);
      const q1 = sorted[Math.floor(sorted.length * 0.25)];
      const q3 = sorted[Math.floor(sorted.length * 0.75)];
      const iqr = q3 - q1;
      const median = sorted[Math.floor(sorted.length / 2)];
      // Filter outliers: keep only samples within [Q1 - 1.5*IQR, Q3 + 1.5*IQR]
      const lower = q1 - 1.5 * iqr;
      const upper = q3 + 1.5 * iqr;
      const filtered = sorted.filter((s) => s >= lower && s <= upper);
      const filteredMedian = filtered[Math.floor(filtered.length / 2)] || median;
      const filteredMax = filtered[filtered.length - 1] || sorted[sorted.length - 1];
      const jitterMargin = Math.max(filteredMax - filteredMedian, 0);
      // True-rollback model: delay is the REMOTE prediction jitter buffer.
      // Local input is applied at the current frame, so RTT/2 does NOT
      // contribute to local input lag — RTT only sets rollback depth.
      // Legacy model: delay also inflates local input application, so RTT/2
      // must be folded in or the negotiated delay can't keep up at high RTT.
      const effectiveMs = RB_TRUE_ROLLBACK
        ? jitterMargin + 16.67 // 1-frame safety on top of measured jitter
        : filteredMedian / 2 + jitterMargin + 16.67;
      ownDelay = Math.min(
        ROLLBACK_MAX_DELAY_FRAMES,
        Math.max(ROLLBACK_MIN_DELAY_FRAMES, Math.ceil(effectiveMs / 16.67)),
      );
      _syncLog(
        `rollback delay: RTT=${filteredMedian.toFixed(1)}ms jitter=${jitterMargin.toFixed(1)}ms ` +
          `IQR=[${q1.toFixed(1)},${q3.toFixed(1)}] samples=${sorted.length} ` +
          `mode=${RB_TRUE_ROLLBACK ? 'true' : 'legacy'} ` +
          `effective=${effectiveMs.toFixed(1)}ms -> ${ownDelay}f`,
      );
    } else {
      ownDelay = window.getDelayPreference ? window.getDelayPreference() : DEFAULT_DELAY_FRAMES;
    }
    if (hasRollback && !soloMode) ownDelay = clampRollbackDelay(ownDelay);
    let maxDelay = ownDelay;
    if (hasRollback && !soloMode) {
      // Recalculate peer delay from their RTT+jitter using IQR-filtered formula
      for (const p of Object.values(_peers)) {
        if (p.rttSamples?.length > 0) {
          const pSorted = p.rttSamples.slice().sort((a, b) => a - b);
          const pQ1 = pSorted[Math.floor(pSorted.length * 0.25)];
          const pQ3 = pSorted[Math.floor(pSorted.length * 0.75)];
          const pIqr = pQ3 - pQ1;
          const pMedian = pSorted[Math.floor(pSorted.length / 2)];
          const pLower = pQ1 - 1.5 * pIqr;
          const pUpper = pQ3 + 1.5 * pIqr;
          const pFiltered = pSorted.filter((s) => s >= pLower && s <= pUpper);
          const fMedian = pFiltered[Math.floor(pFiltered.length / 2)] || pMedian;
          const fMax = pFiltered[pFiltered.length - 1] || pSorted[pSorted.length - 1];
          const pJitter = Math.max(fMax - fMedian, 0);
          const peerMs = fMedian / 2 + pJitter + 16.67;
          const peerDelay = Math.min(
            ROLLBACK_MAX_DELAY_FRAMES,
            Math.max(ROLLBACK_MIN_DELAY_FRAMES, Math.ceil(peerMs / 16.67)),
          );
          if (peerDelay > maxDelay) maxDelay = peerDelay;
        }
      }
    } else if (!soloMode) {
      for (const p of Object.values(_peers)) {
        if (p.delayValue && p.delayValue > maxDelay) maxDelay = p.delayValue;
      }
    }
    DELAY_FRAMES = maxDelay;
    if (window.showEffectiveDelay) window.showEffectiveDelay(ownDelay, maxDelay);
    _syncLog(`delay negotiated: own=${ownDelay} effective=${maxDelay}${hasRollback ? ' (rollback)' : ''}`);

    // Host broadcasts effective delay so all players use the same value.
    // Independent calculation can disagree due to asymmetric RTT/jitter.
    //
    // P2/Fix 2: host also broadcasts the transport mode for rollback input
    // packets. Reliable suffers WebRTC head-of-line blocking under network
    // jitter (one delayed packet stalls the whole stream); unreliable +
    // per-packet redundancy defeats this entirely.
    //
    // History: shipped unreliable, hit cascading rollback bug because
    // redundant inputs were re-fed without dedup → re-triggered prediction
    // checks → spiral. Reverted to reliable. Then shipped the dedup fix
    // that skips redundant entries we already have. Now safe to re-enable
    // unreliable on rollback-mode connections.
    //
    // Override: knDiag.setTransport('reliable'|'unreliable') for testing.
    if (_playerSlot === 0) {
      const transportOverride = window._knTransportOverride;
      const transportMode =
        transportOverride === 'reliable' || transportOverride === 'unreliable' ? transportOverride : 'reliable';
      _rbTransport = transportMode;
      for (const p of Object.values(_peers)) {
        if (p.dc?.readyState === 'open') {
          try {
            p.dc.send(`rb-delay:${maxDelay}`);
            p.dc.send(`rb-transport:${transportMode}`);
          } catch (_) {}
        }
      }
      _syncLog(`rb-transport: host broadcast=${transportMode}`);
    }

    _syncLog(`${readyCount + 1} players lockstep-ready -- GO`);

    const gm = window.EJS_emulator?.gameManager;
    if (!gm) return;

    if (_isSyntheticOnlyInitialSyncSkip()) {
      enterManualMode();
      _lockstepStartStateKind = 'live';
      _guestStateBytes = null;
      _guestStateKind = 'savestate';
      _guestStateHiddenWords = null;
      _guestStateAudioFifo = null;
      _guestStateCapturedLocally = false;
      _syncLog('synthetic demo: starting from live boot state (no state capture/load)');
      if (_config?.disableStandardCheats === true) {
        KNShared.clearCheats(false);
        _syncLog('standard cheats disabled by config');
      }
      _frameNum = 0;
      startLockstep();
      return;
    }

    // If no state bytes (host fallback), host uses its own state.
    // Guests MUST have received the host's state — using their own would cause
    // RNG divergence (different boot timing → different CP0_COUNT → different random).
    if (!_guestStateBytes) {
      if (_playerSlot === 0) {
        _guestStateBytes = gm.getState();
        _guestStateKind = 'savestate';
        _guestStateHiddenWords = null;
        _guestStateAudioFifo = null;
        _guestStateCapturedLocally = false;
        _syncLog('host using own state (authoritative)');
      } else {
        _syncLog('FATAL: guest has no state from host — cannot start lockstep deterministically');
        setStatus('Sync failed — no state from host');
        _config?.onToast?.('Sync failed — try restarting the game');
        return;
      }
    }

    // Enter manual mode FIRST — stop free frames before any state load.
    // Previously, free frames could run between getState/loadState/enterManualMode,
    // advancing emulator state and causing intermittent boot desync.
    enterManualMode();

    // Soft-reset the core for vanilla savestate startup only. Smash Remix
    // startup uses either a host live kn-sync snapshot or a title savestate
    // plus hidden-state sidecar; resetting first can leave unsaved scheduler
    // internals in reset shape while RDRAM/CPU are from the title screen.
    const readyMod = gm.Module;
    const isKnSyncInitialState = _guestStateKind === 'kn-sync';
    _lockstepStartStateKind = isKnSyncInitialState ? 'kn-sync' : 'savestate';
    const hasLocalKnSyncCapture = isKnSyncInitialState && _guestStateCapturedLocally;
    if (!_isSmashRemix() && !isKnSyncInitialState && readyMod?._retro_reset) {
      readyMod._retro_reset();
      _syncLog('core soft-reset before state load');
    } else if (_isSmashRemix()) {
      _syncLog(`core soft-reset skipped for Remix initial state kind=${_guestStateKind}`);
    }

    // Load state synchronously at the manual start boundary. Remix prefers
    // kn_sync_write because it carries CPU/peripheral/event-queue state that
    // the libretro savestate path has historically under-specified for startup.
    //
    // Host runs the IDENTICAL restore stack as guest (kn_sync_write of its own
    // captured bytes + restoreHiddenState + restoreAudioFifo + cleanup). Even
    // though the emulator was paused since capture, the restore path has
    // side effects the host's runtime hasn't been through (TLB rebuild, JIT
    // invalidate, full event-queue normalize). Skipping them on host meant
    // host and guest started lockstep from subtly different states —
    // visible later as different "Random!" character/stage selections
    // because the SSB Remix RNG advances differently from non-identical
    // event-queue/cycle-count starting points.
    if (isKnSyncInitialState) {
      const stagePrefix = hasLocalKnSyncCapture ? 'host' : 'guest';
      // PUCFCIB8 (2026-04-29): host hung silently between pre-knsync-write
      // and post-knsync-write with no diagnostic. Wrap each stage so a throw
      // surfaces a labeled log instead of an uncaught exception that strands
      // the lockstep flow until the 80s sync watchdog fires.
      let kStage = 'pre-knsync';
      try {
        _logAudioDump(readyMod, `${stagePrefix}:pre-knsync-write`);
        kStage = 'kn_sync_write';
        if (!loadKnSyncStateAtStartBoundary(gm, _guestStateBytes, 'initial-sync-load')) {
          _syncLog('FATAL: kn-sync initial state but kn_sync_write failed');
          setStatus('Sync failed — incompatible core state');
          _config?.onToast?.('Sync failed — restart with the same core build');
          return;
        }
        kStage = 'post-write-dump';
        _checkAiInvariant(readyMod, 4);
        _logAudioDump(readyMod, `${stagePrefix}:post-knsync-write`);
        kStage = 'restore-hidden';
        _restoreHiddenStateWords(readyMod, _guestStateHiddenWords, 'initial-sync-load');
        kStage = 'restore-audio-fifo';
        _restoreAudioFifoState(readyMod, _guestStateAudioFifo, 'initial-sync-load');
        kStage = 'post-fifo-dump';
        _logAudioDump(readyMod, `${stagePrefix}:post-fifo-restore`);
        if (_isSmashRemix()) {
          kStage = 'post-state-cleanup';
          _postStateLoadCleanup(readyMod, 'initial-sync-load');
          _checkAiInvariant(readyMod, 5);
          kStage = 'post-cleanup-dump';
          _logAudioDump(readyMod, `${stagePrefix}:post-cleanup`);
          _syncLog(
            `initial-sync-load: Remix kn-sync state loaded with hidden state + C cleanup ` +
              `(${hasLocalKnSyncCapture ? 'host self-restore' : 'guest from-host'})`,
          );
        }
      } catch (e) {
        _syncLog(
          `KN-SYNC-RESTORE-THREW prefix=${stagePrefix} stage=${kStage} ` + `${e?.name || 'Error'}: ${e?.message || e}`,
        );
        console.error('[lockstep] kn-sync restore stack threw:', e);
        setStatus('Sync failed — restore stack threw');
        _config?.onToast?.('Sync failed — restart the match');
        return;
      }
    } else {
      loadStateAtStartBoundary(gm, _guestStateBytes, 'initial-sync-load', _isSmashRemix() ? 1 : 2);
      _restoreHiddenStateWords(readyMod, _guestStateHiddenWords, 'initial-sync-load');
      _restoreAudioFifoState(readyMod, _guestStateAudioFifo, 'initial-sync-load');
      _postStateLoadCleanup(readyMod, 'initial-sync-load');
    }
    _guestStateBytes = null;
    _guestStateKind = 'savestate';
    _guestStateHiddenWords = null;
    _guestStateAudioFifo = null;
    _guestStateCapturedLocally = false;
    _syncLog(`state loaded (manual mode, kind=${isKnSyncInitialState ? 'kn-sync' : 'savestate'})`);

    // Re-apply cheats after state load. _retro_reset() and loadState() can
    // clear the cheat table, so cheats applied during boot may be lost.
    // Only for vanilla SSB64 — Smash Remix and hashless demos opt out.
    if (_config?.disableStandardCheats === true) {
      KNShared.clearCheats(false);
      _syncLog('standard cheats disabled by config');
    } else if (!_isSmashRemix()) {
      KNShared.applyStandardCheats(KNShared.SSB64_ONLINE_CHEATS);
    } else {
      // Clear any stale cheats from a previous game in the same tab.
      // The EJS cheat table persists across game restarts — SSB64 cheats
      // set by the old ungated path corrupt Smash Remix (e.g. "Timer On").
      KNShared.clearCheats(false);
      _syncLog('cleared stale cheats (Smash Remix)');
    }

    // Both sides reset and start true lockstep sync
    // (Warmup removed — deterministic timing patch makes it unnecessary)
    _frameNum = 0;
    startLockstep();

    // Spectator stream starts lazily — only when a spectator actually connects.
    // Eager start wastes CPU (drawImage + video encode every frame) which causes
    // thermal throttling on mobile hosts even with zero spectators.
  };

  let _cacheAttempted = false;

  // ── Client-side boot state cache (IndexedDB) ──────────────────────
  // Caches the ~16MB boot savestate locally per ROM hash so repeat games
  // skip the 20s server transfer entirely. Both host and guest check IDB
  // first; on hit, no network transfer is needed.
  const _STATE_DB = 'kaillera-state-cache';
  const _STATE_STORE = 'states';

  const _openStateDB = () =>
    new Promise((resolve) => {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(_STATE_DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(_STATE_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });

  const _getStateFromIDB = async (romHash) => {
    const db = await _openStateDB();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(_STATE_STORE, 'readonly');
      const req = tx.objectStore(_STATE_STORE).get(romHash);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  };

  const _putStateToIDB = async (romHash, bytes) => {
    const db = await _openStateDB();
    if (!db) return;
    const tx = db.transaction(_STATE_STORE, 'readwrite');
    tx.objectStore(_STATE_STORE).put(bytes, romHash);
  };

  const waitForSmashTitleState = async (gm) => {
    if (!_isSmashRemix()) return;
    const mod = gm?.Module;
    if (!mod) return;

    if (_config?.skipSmashTitleWait === true) {
      mod.pauseMainLoop?.();
      const frame = mod._get_current_frame_count?.() ?? '?';
      _syncLog(`Smash Remix initial sync: title wait skipped by config at coreFrame=${frame}`);
      return;
    }

    if (_isSameRomEmulatorResume()) {
      mod.pauseMainLoop?.();
      const frame = mod._get_current_frame_count?.() ?? '?';
      _syncLog(`Smash Remix initial sync: same-ROM resume, capturing current state at coreFrame=${frame}`);
      return;
    }

    const start = performance.now();
    let titleFrame = -1;
    let fallbackFrame = -1;
    let fallbackElapsedAt = -1;
    let fallbackScene = 0;
    let lastConfirmPulseAt = -Infinity;
    let lastProgressLogAt = 0;
    setStatus('Waiting for title screen...');
    _syncLog('Smash Remix initial sync: waiting for title-screen state');

    try {
      mod.resumeMainLoop?.();
      while (performance.now() - start < INITIAL_SMASH_TITLE_TIMEOUT_MS) {
        _getRdramBase(mod);
        const scene = _readSceneCurr();
        const gameStatus = _readGameStatus();
        const frame = mod._get_current_frame_count?.() ?? 0;
        const elapsed = performance.now() - start;

        if (scene === 1) {
          if (titleFrame < 0) {
            titleFrame = frame;
            _syncLog(`Smash Remix initial sync: title reached at coreFrame=${frame}`);
          }
          if (frame - titleFrame >= INITIAL_SMASH_TITLE_SETTLE_FRAMES) {
            mod.pauseMainLoop?.();
            _syncLog(
              `Smash Remix initial sync: capturing title state at coreFrame=${frame} ` +
                `(settled ${frame - titleFrame}f)`,
            );
            return;
          }
        } else {
          titleFrame = -1;
        }

        if (
          elapsed >= INITIAL_SMASH_CONFIRM_AFTER_MS &&
          INITIAL_SMASH_CONFIRM_SCENES.has(scene) &&
          elapsed - lastConfirmPulseAt >= INITIAL_SMASH_CONFIRM_INTERVAL_MS
        ) {
          lastConfirmPulseAt = elapsed;
          try {
            KNShared.applyInputToWasm(0, INITIAL_SMASH_CONFIRM_INPUT);
            _syncLog(`Smash Remix initial sync: confirm pulse scene=${scene} coreFrame=${frame}`);
            await new Promise((resolve) => setTimeout(resolve, INITIAL_SMASH_CONFIRM_HOLD_MS));
          } finally {
            KNShared.applyInputToWasm(0, KNShared.ZERO_INPUT);
          }
          continue;
        }

        const fallbackReady =
          elapsed >= INITIAL_SMASH_MENU_FALLBACK_MS &&
          INITIAL_SMASH_FALLBACK_SCENES.has(scene) &&
          gameStatus >= 0 &&
          gameStatus !== 1;
        if (fallbackReady) {
          if (fallbackElapsedAt < 0 || fallbackScene !== scene) {
            fallbackFrame = frame;
            fallbackElapsedAt = elapsed;
            fallbackScene = scene;
            _syncLog(
              `Smash Remix initial sync: fallback scene=${scene} gameStatus=${gameStatus} ` +
                `reached at coreFrame=${frame}`,
            );
          }
          const fallbackSettledMs = elapsed - fallbackElapsedAt;
          if (fallbackSettledMs >= INITIAL_SMASH_MENU_SETTLE_MS) {
            mod.pauseMainLoop?.();
            _syncLog(
              `Smash Remix initial sync: capturing fallback scene=${scene} ` +
                `gameStatus=${gameStatus} at coreFrame=${frame} ` +
                `(settled ${Math.round(fallbackSettledMs)}ms, ${frame - fallbackFrame}f)`,
            );
            return;
          }
        } else {
          fallbackFrame = -1;
          fallbackElapsedAt = -1;
          fallbackScene = 0;
        }

        if (elapsed - lastProgressLogAt >= 5000) {
          lastProgressLogAt = elapsed;
          _syncLog(
            `Smash Remix initial sync: still waiting ` +
              `scene=${scene} gameStatus=${gameStatus} coreFrame=${frame} elapsedMs=${Math.round(elapsed)}`,
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      _syncLog(`Smash Remix initial sync: title wait timed out, capturing current scene=${_readSceneCurr()}`);
    } finally {
      mod.pauseMainLoop?.();
    }
  };

  const fetchCachedState = async (romHash) => {
    _syncLog(`checking for cached state: ${romHash.substring(0, 16)}...`);

    if (_isSmashRemix()) {
      _syncLog('Smash Remix: bypassing cached pre-title state; using host title-screen capture');
      if (_playerSlot === 0 && !_cacheAttempted) {
        _cacheAttempted = true;
        sendInitialState();
      }
      return;
    }

    // 1. Check local IndexedDB first — instant, no network
    try {
      const idbBytes = await _getStateFromIDB(romHash);
      if (idbBytes && idbBytes.length > 1000) {
        _syncLog(`cached state loaded from IndexedDB (${idbBytes.length} bytes)`);
        _guestStateBytes = idbBytes instanceof Uint8Array ? idbBytes : new Uint8Array(idbBytes);
        _guestStateKind = 'savestate';
        _guestStateHiddenWords = null;
        _guestStateAudioFifo = null;
        _guestStateCapturedLocally = false;

        if (_playerSlot === 0) {
          compressAndEncode(new Uint8Array(_guestStateBytes))
            .then((encoded) => {
              _syncLog(
                `sending cached state to guests via Socket.IO (${Math.round(encoded.compressedSize / 1024)}KB gzip)`,
              );
              socket.emit('data-message', {
                type: 'save-state',
                frame: 0,
                stateFormat: 'savestate',
                sourceRuntimeFamily: _getRuntimeFamily(),
                data: encoded.data,
              });
            })
            .catch((e) => _syncLog(`cached state relay failed: ${e.message || e}`));
        }

        _phase = PHASE_LOCKSTEP_READY;
        if (_rttComplete) broadcastLockstepReady();
        checkAllLockstepReady();
        return;
      }
    } catch (e) {
      _syncLog(`IndexedDB state cache check failed: ${e.message || e}`);
    }

    // 2. Fall back to server cache
    const url = `/api/cached-state/${encodeURIComponent(romHash)}`;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30000);
      const resp = await fetch(url, { signal: ac.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error('no cached state');
      const raw = await resp.arrayBuffer();
      const bytes = new Uint8Array(raw);
      if (bytes.length < 1000) throw new Error(`cached state too small: ${bytes.length}`);
      _syncLog(`cached state loaded from server (${bytes.length} bytes)`);
      _guestStateBytes = bytes;
      _guestStateKind = 'savestate';
      _guestStateHiddenWords = null;
      _guestStateAudioFifo = null;
      _guestStateCapturedLocally = false;

      // Persist to local IDB for next time
      _putStateToIDB(romHash, new Uint8Array(bytes)).catch(() => {});

      if (_playerSlot === 0) {
        compressAndEncode(new Uint8Array(bytes))
          .then((encoded) => {
            _syncLog(
              `sending cached state to guests via Socket.IO (${Math.round(encoded.compressedSize / 1024)}KB gzip)`,
            );
            socket.emit('data-message', {
              type: 'save-state',
              frame: 0,
              stateFormat: 'savestate',
              sourceRuntimeFamily: _getRuntimeFamily(),
              data: encoded.data,
            });
          })
          .catch((e) => _syncLog(`cached state relay failed: ${e.message || e}`));
      }

      _phase = PHASE_LOCKSTEP_READY;
      if (_rttComplete) broadcastLockstepReady();
      checkAllLockstepReady();
    } catch (e) {
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
      await waitForSmashTitleState(gm);
      const captured = _captureInitialStateBytes(gm);
      const bytes = captured.bytes;
      // Copy before compressAndEncode — worker transfer detaches the buffer
      const cacheBytes = new Uint8Array(bytes);
      const encoded = await compressAndEncode(bytes);
      _syncLog(
        `sending initial state via Socket.IO (${captured.kind}, ${Math.round(encoded.rawSize / 1024)}KB raw -> ${Math.round(encoded.compressedSize / 1024)}KB gzip)`,
      );

      // Send via Socket.IO -- save state is ~1.5MB which crashes WebRTC
      // data channels (SCTP limit with maxRetransmits).
      socket.emit('data-message', {
        type: 'save-state',
        frame: 0,
        stateFormat: captured.kind,
        sourceRuntimeFamily: _getRuntimeFamily(),
        hiddenWords: captured.hiddenWords,
        audioFifo: captured.audioFifo,
        data: encoded.data,
      });

      // Use local state immediately so the host isn't blocked by the
      // cache round-trip. The blocking await fetch(POST 16MB) was causing
      // the host to stall for 10-30s while the guest started normally.
      _guestStateBytes = cacheBytes;
      _guestStateKind = captured.kind;
      _guestStateHiddenWords = captured.hiddenWords;
      _guestStateAudioFifo = captured.audioFifo;
      _guestStateCapturedLocally = captured.kind === 'kn-sync';
      _phase = PHASE_LOCKSTEP_READY;
      if (_rttComplete) {
        broadcastLockstepReady();
      }
      checkAllLockstepReady();

      // Background: cache for future games (fire-and-forget)
      const romHash = _config?.romHash;
      if (romHash && !_isSmashRemix()) {
        // Local IDB cache — persists across deploys, no server needed
        _putStateToIDB(romHash, new Uint8Array(cacheBytes)).catch(() => {});
        // Server cache — helps other players who haven't played this ROM
        const cacheParams = new URLSearchParams({ room: _config.sessionId, token: _config.uploadToken || '' });
        fetch(`/api/cache-state/${encodeURIComponent(romHash)}?${cacheParams}`, {
          method: 'POST',
          body: cacheBytes,
        })
          .then(() => _syncLog('state cached in background'))
          .catch((e) => _syncLog(`background cache failed: ${e.message || e}`));
      }
    } catch (err) {
      _syncLog(`failed to send initial state: ${err}`);
    }
  }

  const handleSaveStateMsg = async (msg) => {
    if (_isSpectator) return;
    if (_phase >= PHASE_LOCKSTEP_READY) return; // already loaded (e.g. from cache)
    _syncLog('received initial state');
    setStatus('Loading initial state...');

    try {
      const bytes = await decodeAndDecompress(msg.data);
      _guestStateBytes = bytes;
      _guestStateKind = msg.stateFormat === 'kn-sync' ? 'kn-sync' : 'savestate';
      _guestStateHiddenWords = Array.isArray(msg.hiddenWords) ? msg.hiddenWords.map((w) => w >>> 0) : null;
      _guestStateAudioFifo = Array.isArray(msg.audioFifo) ? msg.audioFifo.map((w) => w >>> 0) : null;
      _guestStateCapturedLocally = false;
      _syncLog(`initial state decompressed (${_guestStateKind}, ${bytes.length} bytes)`);

      // Cache locally for next time
      const romHash = _config?.romHash;
      if (romHash && !_isSmashRemix()) _putStateToIDB(romHash, new Uint8Array(bytes)).catch(() => {});

      _phase = PHASE_LOCKSTEP_READY;
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
    for (const [sid, p] of Object.entries(_peers)) {
      if (_isPeerPendingLateJoin(sid, p)) continue;
      if (p.slot !== null && p.slot !== undefined && !p._intentionalLeave) {
        slotSet.add(p.slot);
      }
    }
    const slots = [...slotSet].sort((a, b) => a - b);
    _activeRoster = slotSet;
    _rosterChangeFrame = _frameNum;
    _applyControllerPresentMask('broadcast-roster');
    // Always 4 — see roster DC handler comment for rationale.
    rb_numPlayers = 4;
    const rbMod = window.EJS_emulator?.gameManager?.Module;
    if (_useCRollback && rbMod?._kn_set_num_players) {
      rbMod._kn_set_num_players(rb_numPlayers);
      _syncLog(`C-ROLLBACK num_players updated to ${rb_numPlayers}`);
    }
    const msg = `roster:${_frameNum}:${slots.join(',')}`;
    _syncLog(`ROSTER broadcast: frame=${_frameNum} slots=[${slots.join(',')}]`);
    for (const [sid, p] of Object.entries(_peers)) {
      if (_isPeerPendingLateJoin(sid, p)) continue;
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
    _markPendingLateJoinPeer(remoteSid, peerSlot, 'state transfer');

    const gm = window.EJS_emulator?.gameManager;
    if (!gm) {
      _syncLog(`sendLateJoinState: gameManager not ready`);
      _clearPendingLateJoinPeer(remoteSid, peerSlot, 'state transfer unavailable');
      return;
    }

    try {
      // Pause lockstep FIRST — freeze all players before capturing state
      // so no frames advance during the async compression below. Without
      // this, the tick loop can run N frames between getState() and the
      // moment we read _frameNum, causing the late joiner to load state
      // from frame X but think they're at frame X+N (cursor desync).
      _runSubstate = RUN_LATE_JOIN_PAUSE;
      _lateJoinPausedAt = performance.now();
      _syncLog(`pausing for late-join at frame ${_frameNum}`);
      for (const [sid, p] of Object.entries(_peers)) {
        // The pause is for existing players while the host captures a stable
        // state. The joiner is not part of the running timeline yet; pausing
        // it can leave its freshly-loaded loop stuck in RUN_LATE_JOIN_PAUSE.
        if (sid === remoteSid) continue;
        if (p.dc?.readyState === 'open') {
          try {
            p.dc.send('late-join-pause');
          } catch (_) {}
        }
      }

      // Capture state + frame number + RNG atomically while paused
      const capturedFrame = _frameNum;
      const raw = gm.getState();
      const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);

      // Read game-specific RNG/settings values from RDRAM (while paused)
      let rngValues = null;
      let saveData = null;
      let hiddenWords = null;
      let audioFifo = null;
      const hMod = gm.Module;
      hiddenWords = _captureHiddenStateWords(hMod);
      audioFifo = _captureAudioFifoState(hMod);
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
                seed: hMod.HEAPU32[u32 + (KN_RNG_SEED_RDRAM >> 2)] >>> 0,
                altSeed: hMod.HEAPU32[u32 + (KN_RNG_ALT_SEED_RDRAM >> 2)] >>> 0,
                frameCounter: hMod.HEAPU32[u32 + (KN_FRAME_COUNTER_RDRAM >> 2)] >>> 0,
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

      // Async compression is safe now — tick loop is frozen
      const encoded = await compressAndEncode(bytes);
      // I1 (MF5): late-join pause must have a wall-clock deadline.
      // If the joiner's ready signal never arrives (their DC dies
      // mid-transfer, worker hangs on decompression, etc.) we need
      // to resume the game AND hard-disconnect the joiner so they
      // retry from a clean slate rather than living in a half-loaded
      // limbo. See spec §MF5, audit §D3.
      setTimeout(() => {
        if (_runSubstate === RUN_LATE_JOIN_PAUSE) {
          const elapsed = Math.round(performance.now() - _lateJoinPausedAt);
          _syncLog(
            `LATE-JOIN-TIMEOUT elapsed=${elapsed}ms joiner=${remoteSid} — ` +
              `resuming without joiner, hard-disconnecting so they can retry`,
          );
          if (_runSubstate === RUN_LATE_JOIN_PAUSE) _runSubstate = RUN_NORMAL;
          _lateJoinPausedAt = 0;
          _resetPacingAfterLateJoin();
          _broadcastRoster();
          // Send resume to peers that are still paused
          for (const p of Object.values(_peers)) {
            if (p.dc?.readyState === 'open') {
              try {
                p.dc.send('late-join-resume');
              } catch (_) {}
            }
          }
          // Force the joiner out so they retry fresh. If the peer
          // object still exists we hard-disconnect; if not (already
          // gone), we just log.
          if (_peers[remoteSid]) {
            hardDisconnectPeer(remoteSid);
          } else {
            _clearPendingLateJoinPeer(remoteSid, peerSlot, 'late-join timeout');
          }
        }
      }, LATE_JOIN_TIMEOUT_MS);

      _syncLog(
        `sending late-join state to ${remoteSid} (${Math.round(encoded.rawSize / 1024)}KB raw -> ${Math.round(encoded.compressedSize / 1024)}KB gzip) frame: ${capturedFrame}`,
      );

      socket.emit('data-message', {
        type: 'late-join-state',
        targetSid: remoteSid,
        frame: capturedFrame,
        data: encoded.data,
        effectiveDelay: DELAY_FRAMES,
        rbTransport: _rbTransport,
        rngValues,
        saveData,
        hiddenWords,
        audioFifo,
      });
    } catch (err) {
      _syncLog(`failed to send late-join state: ${err}`);
      _clearPendingLateJoinPeer(remoteSid, peerSlot, 'state transfer failed');
      if (_runSubstate === RUN_LATE_JOIN_PAUSE) {
        _runSubstate = RUN_NORMAL;
        _lateJoinPausedAt = 0;
        _resetPacingAfterLateJoin();
      }
    }
  }

  const handleLateJoinState = async (msg) => {
    if (msg.targetSid && msg.targetSid !== socket.id) return;
    if (_isSpectator) return;
    if (_phase === PHASE_RUNNING) return; // already running, ignore duplicate
    // Reject duplicate state packets while a load is in-flight: the body
    // awaits decompress + multiple HEAPU8 writes, and a concurrent second
    // pass would race those writes and corrupt joiner memory.
    if (_isApplyingLateJoinState) {
      _syncLog('ignoring duplicate late-join state — already applying');
      return;
    }
    _isApplyingLateJoinState = true;

    _syncLog(`received late-join state for frame ${msg.frame}`);
    _awaitingLateJoinState = false;
    // Ensure the loading overlay is up — the EJS canvas may already be
    // painting boot frames (N64 logo) and we don't want the joiner to see
    // them between now and the state restore that follows below.
    if (typeof window.knShowGameLoading === 'function') {
      try {
        window.knShowGameLoading();
      } catch (_) {}
    }
    setStatus('Loading late-join state...');

    try {
      // I1 (MF5): wrap the worker round-trip in a Promise.race with
      // LATE_JOIN_TIMEOUT_MS deadline. If the compression worker
      // hangs (stuck pthread, corrupted buffer, etc) we abort the
      // late-join and let the host's LATE-JOIN-TIMEOUT handler
      // hard-disconnect us for a fresh retry instead of freezing
      // indefinitely. See spec §MF5, audit §C5.
      let bytes;
      try {
        bytes = await Promise.race([
          decodeAndDecompress(msg.data),
          new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error('WORKER-STALL: late-join decompress')), LATE_JOIN_TIMEOUT_MS),
          ),
        ]);
      } catch (_workerErr) {
        _syncLog(`WORKER-STALL late-join decompress failed: ${_workerErr.message}`);
        return;
      }
      const gm = window.EJS_emulator?.gameManager;
      if (!gm) {
        _syncLog('gameManager not ready');
        return;
      }

      if (msg.effectiveDelay !== undefined && msg.effectiveDelay !== null) {
        const parsedDelay = parseInt(msg.effectiveDelay, 10);
        const roomDelay = gm.Module?._kn_pre_tick && parsedDelay > 0 ? clampRollbackDelay(parsedDelay) : parsedDelay;
        DELAY_FRAMES = Number.isFinite(roomDelay) && roomDelay >= 0 ? roomDelay : DELAY_FRAMES;
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

      // Bounds-check the late-join blob before writing into WASM memory.
      // A malicious host could ship a truncated/oversized state that crashes
      // the load path or scribbles past expected limits. The legitimate
      // mupen64plus save state is well under 8MB; reject anything outside
      // a sane range as malformed.
      const _LATE_JOIN_STATE_MIN = 1024; // 1KB — anything smaller can't be valid
      const _LATE_JOIN_STATE_MAX = 8 * 1024 * 1024; // 8MB — server caches up to 20MB but real states are ≤4MB
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.length < _LATE_JOIN_STATE_MIN ||
        bytes.length > _LATE_JOIN_STATE_MAX
      ) {
        _syncLog(
          `late-join state rejected: invalid blob size ${bytes?.length ?? 'n/a'} (expected ${_LATE_JOIN_STATE_MIN}..${_LATE_JOIN_STATE_MAX})`,
        );
        return;
      }
      // Load state synchronously if available, else async
      if (mod?._kn_load_state_immediate) {
        const statePtr = mod._malloc(bytes.length);
        if (!statePtr) {
          _syncLog(`late-join state rejected: _malloc(${bytes.length}) failed`);
          return;
        }
        mod.HEAPU8.set(bytes, statePtr);
        mod._kn_load_state_immediate(statePtr, bytes.length);
        mod._free(statePtr);
      } else {
        gm.loadState(bytes);
        if (mod?._task_queue_check) mod._task_queue_check();
      }
      _restoreHiddenStateWords(
        mod,
        Array.isArray(msg.hiddenWords) ? msg.hiddenWords.map((w) => w >>> 0) : null,
        'late-join-state',
      );
      _restoreAudioFifoState(
        mod,
        Array.isArray(msg.audioFifo) ? msg.audioFifo.map((w) => w >>> 0) : null,
        'late-join-state',
      );

      _setLastSyncState(bytes.slice(), 'late-join');

      // Re-apply cheats after state load — loadState can clear the cheat
      // table, losing cheats applied during boot. Only for vanilla SSB64.
      if (_config?.disableStandardCheats === true) {
        KNShared.clearCheats(false);
      } else if (!_isSmashRemix()) {
        KNShared.applyStandardCheats(KNShared.SSB64_ONLINE_CHEATS);
      }

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
            mod.HEAPU32[u32 + (KN_RNG_SEED_RDRAM >> 2)] = msg.rngValues.seed >>> 0;
            mod.HEAPU32[u32 + (KN_RNG_ALT_SEED_RDRAM >> 2)] = msg.rngValues.altSeed >>> 0;
            mod.HEAPU32[u32 + (KN_FRAME_COUNTER_RDRAM >> 2)] = msg.rngValues.frameCounter >>> 0;
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
      _activeRoster = new Set(
        Object.values(_knownPlayers)
          .map((info) => info?.slot)
          .filter((slot) => Number.isInteger(slot) && slot >= 0 && slot < 4),
      );
      if (Number.isInteger(_playerSlot) && _playerSlot >= 0 && _playerSlot < 4) _activeRoster.add(_playerSlot);
      _rosterChangeFrame = _frameNum;
      _applyControllerPresentMask('late-join-state');
      _releaseMenuStartBarrierAfterLateJoin();
      _startLateJoinInputBootstrap('late-join-state', [..._activeRoster]);

      // Ensure rollback init can proceed — the late joiner missed the
      // host's rb-delay broadcast over DataChannel (sent at game start).
      // Without this, startLockstep sets _rbPendingInit=true and the
      // tick loop is completely gated, causing a black screen.
      if (msg.effectiveDelay !== undefined && msg.effectiveDelay !== null && DELAY_FRAMES > 0) {
        window._rbHostDelay = clampRollbackDelay(msg.effectiveDelay);
      }
      // The joiner's _frameNum was set to msg.frame above. Set the
      // matching host init frame so tryInitRollback fires immediately
      // instead of waiting RB_INIT_TIMEOUT_MS (3s) for the timeout
      // fallback. doRollbackInit's _kn_set_frame(initFrame) keeps the
      // joiner's C engine aligned with the host on the same simulation
      // frame for input exchange.
      window._rbHostInitFrame = msg.frame;
      if (msg.rbTransport) {
        _rbTransport = msg.rbTransport === 'unreliable' ? 'unreliable' : 'reliable';
      }

      startLockstep();
      if (_runSubstate === RUN_LATE_JOIN_PAUSE) {
        _syncLog('late-join: clearing self pause after state load');
        _runSubstate = RUN_NORMAL;
      }

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
          // I2: route per-peer cleanup through resetPeerState before
          // dropping the _peers entry.
          resetPeerState(existing.slot, 'late-join-reconnect-replace', { peer: existing, sid });
          delete _peers[sid];
        } else {
          _syncLog(`late-join reconnect: creating peer ${sid} slot=${info.slot}`);
        }
        createPeer(sid, info.slot, true);
        sendOffer(sid, { reconnect: true });
      }

      // Tell host to resume — send via BOTH DC and Socket.IO for reliable
      // delivery. Retry briefly because CSS late-join can race with peer DC
      // replacement/opening; the host side is idempotent per senderSid.
      const sendLateJoinReady = () => {
        for (const p of Object.values(_peers)) {
          if (p.dc?.readyState === 'open') {
            try {
              p.dc.send('late-join-ready');
            } catch (_) {}
          }
        }
        socket.emit('data-message', { type: 'late-join-ready', senderSid: socket.id });
      };
      clearLateJoinReadyRetry();
      sendLateJoinReady();
      let readyAttempts = 1;
      _lateJoinReadyRetryTimer = setInterval(() => {
        if (_phase !== PHASE_RUNNING || readyAttempts >= 20) {
          clearLateJoinReadyRetry();
          return;
        }
        readyAttempts += 1;
        _syncLog(`late-join-ready retry ${readyAttempts}`);
        sendLateJoinReady();
      }, 500);
    } catch (err) {
      _syncLog(`failed to handle state: ${err}`);
    } finally {
      _isApplyingLateJoinState = false;
    }
  };

  // -- Guest audio muting + host audio streaming ----------------------------

  // -- Spectator canvas streaming --------------------------------------------

  const startSpectatorStream = () => {
    if (_playerSlot !== 0) return;
    if (_hostStream) return; // already started
    // Bail if the engine has been stopped — without this the recursive
    // setTimeout below keeps polling for #game canvas after stop() and
    // can re-create _hostStream + audio plumbing in a torn-down engine.
    if (_phase === PHASE_IDLE || _phase === PHASE_STOPPED) return;

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
    if (_audio?.destNode?.stream) {
      const audioTracks = _audio.destNode.stream.getAudioTracks();
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
      if (_phase !== PHASE_RUNNING) return; // stopped
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

  const installNativeInputGuard = () => {
    const gm = window.EJS_emulator?.gameManager;
    const mod = gm?.Module;
    if (!gm || !mod?._simulate_input || mod._kn_netplay_input_guarded) return;

    const rawSimulateInput = mod._simulate_input.bind(mod);
    mod._kn_netplay_simulate_input = rawSimulateInput;
    mod._simulate_input = (player, index, value) => {
      // Any native EmulatorJS path that reaches the WASM input export would
      // bypass the frame-indexed netplay ring. Capture it as local intent and
      // let writeInputToMemory apply it at the agreed frame on every peer.
      if (player === 0) KNState.touchInput[index] = value;
    };

    if (gm.functions?.simulateInput) {
      gm.functions.simulateInput = mod._simulate_input;
    }
    if (gm.simulateInput) {
      gm.simulateInput = mod._simulate_input;
    }

    mod._kn_netplay_input_guarded = true;
    _syncLog('native EJS input guarded behind netplay writer');
  };

  const _broadcastMenuStartReady = () => {
    const msg = `menu-ready:${_frameNum}:${_menuStartLocalScene}`;
    for (const p of getActivePeers()) {
      if (p.dc?.readyState === 'open') {
        try {
          p.dc.send(msg);
        } catch (_) {}
      }
    }
    _menuStartReadyLastBroadcast = performance.now();
  };

  const _broadcastPhaseIfNeeded = (nowMs) => {
    if (!_isSmashRemix()) return;
    const phase = _readMenuLockstepPhase(true);
    const key = `${phase.sceneCurr}:${phase.gameStatus}`;
    if (key === _lastPhaseBroadcastKey && nowMs - _lastPhaseBroadcastAt < PHASE_BROADCAST_INTERVAL_MS) return;

    const msg = `phase:${_frameNum}:${phase.sceneCurr}:${phase.gameStatus}`;
    for (const p of getActivePeers()) {
      if (p.dc?.readyState === 'open') {
        try {
          p.dc.send(msg);
        } catch (_) {}
      }
    }
    _lastPhaseBroadcastAt = nowMs;
    _lastPhaseBroadcastKey = key;
  };

  const updateMenuStartBarrier = (activePeers, nowMs) => {
    if (!_isSmashRemix() || _menuStartBarrierReleased) {
      return { suppressInput: false, freezeFrame: false };
    }

    const sceneCurr = _readSceneCurr();
    const localReady = _isControllableMenuScene(sceneCurr);

    if (localReady && (!_menuStartLocalReady || _menuStartLocalScene !== sceneCurr)) {
      const wasReady = _menuStartLocalReady;
      _menuStartLocalReady = true;
      _menuStartLocalScene = sceneCurr;
      _menuStartReleaseAt = 0;
      _broadcastMenuStartReady();
      _syncLog(`MENU-BARRIER ${wasReady ? 'local-scene' : 'local-ready'} f=${_frameNum} scene=${sceneCurr}`);
    } else if (_menuStartLocalReady && nowMs - _menuStartReadyLastBroadcast >= 500) {
      _broadcastMenuStartReady();
    }

    const expectedPeers = activePeers.filter(
      (p) =>
        p.slot !== null &&
        p.slot !== undefined &&
        p.synthetic !== true &&
        !p.reconnecting &&
        !_isLateJoinActivationGrace(p.slot),
    );
    const allPeersReady = expectedPeers.every((p) => _menuStartReadyPeers[p.slot]?.scene === sceneCurr);
    const allReady = _menuStartLocalReady && allPeersReady;

    if (allReady) {
      if (!_menuStartReleaseAt) {
        _menuStartReleaseAt = nowMs + MENU_START_BARRIER_SETTLE_MS;
        _syncLog(
          `MENU-BARRIER all-ready f=${_frameNum} scene=${sceneCurr} ` +
            `peers=[${expectedPeers.map((p) => `${p.slot}:${_menuStartReadyPeers[p.slot]?.scene}`).join(',')}] ` +
            `settling=${MENU_START_BARRIER_SETTLE_MS}ms`,
        );
      } else if (nowMs >= _menuStartReleaseAt) {
        _menuStartBarrierReleased = true;
        _syncLog(`MENU-BARRIER released f=${_frameNum} scene=${sceneCurr}`);
        return { suppressInput: false, freezeFrame: false };
      }
    }

    return {
      suppressInput: true,
      freezeFrame: false,
    };
  };

  const _releaseMenuStartBarrierAfterLateJoin = () => {
    if (!_isSmashRemix()) return;
    _menuStartBarrierReleased = true;
    _menuStartLocalReady = false;
    _menuStartLocalScene = 0;
    _menuStartReleaseAt = 0;
    _menuStartReadyPeers = {};
    _menuStartReadyLastBroadcast = 0;
    _syncLog(`late-join: menu barrier bypassed after state load at f=${_frameNum}`);
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

    // Block any pause attempt for the duration of lockstep. Pauses cause
    // peer divergence: the lockstep tick advances _frameNum every ~16ms
    // regardless, but a paused emulator skips retro_run, so peer A's game
    // state falls behind peer B's by however many frames pass before the
    // pointerdown unpause path recovers the rAF chain. Random char/stage
    // selection happens later from a now-diverged RNG state.
    //
    // Pauses can come from: EJS togglePlaying (accidental pause-button
    // click in the auto-shown menu bar), gameManager.toggleMainLoop(0),
    // RetroArch focus-loss pause_nonactive, or cmd_pause. Block all
    // paths; allow toggleMainLoop(1) / cmd_unpause for our recovery.
    const ejs = window.EJS_emulator;
    const gm = ejs?.gameManager;
    if (gm && !gm._knOriginalToggleMainLoop) {
      gm._knOriginalToggleMainLoop = gm.toggleMainLoop.bind(gm);
      gm.toggleMainLoop = (arg) => {
        if (arg === 0) {
          _syncLog('blocked gameManager.toggleMainLoop(0)');
          return;
        }
        return gm._knOriginalToggleMainLoop(arg);
      };
    }
    if (ejs && !ejs._knOriginalPause) {
      ejs._knOriginalPause = ejs.pause;
      ejs._knOriginalTogglePlaying = ejs.togglePlaying;
      ejs.pause = () => {
        _syncLog('blocked EJS.pause()');
      };
      ejs.togglePlaying = () => {
        _syncLog('blocked EJS.togglePlaying()');
      };
    }
    if (mod._cmd_pause && !mod._knOriginalCmdPause) {
      mod._knOriginalCmdPause = mod._cmd_pause;
      mod._cmd_pause = () => {
        _syncLog('blocked mod._cmd_pause()');
      };
    }
    if (mod._cmd_toggle_pause && !mod._knOriginalCmdTogglePause) {
      mod._knOriginalCmdTogglePause = mod._cmd_toggle_pause;
      mod._cmd_toggle_pause = () => {
        _syncLog('blocked mod._cmd_toggle_pause()');
      };
    }

    _manualMode = true;
    _syncLog('entered manual mode');
    _shadowMaybeStart('manual-mode');
  };

  const recaptureManualRunner = (mod, reason) => {
    if (!mod) return;
    try {
      mod.pauseMainLoop?.();
      mod.resumeMainLoop?.();
      if (mod.updateMemoryViews) {
        mod.updateMemoryViews();
      } else if (mod._emscripten_notify_memory_growth) {
        mod._emscripten_notify_memory_growth(0);
      }
      _syncLog(`manual runner recaptured after ${reason}`);
    } catch (e) {
      _syncLog(`manual runner recapture failed after ${reason}: ${e}`);
    }
  };

  const loadStateAtStartBoundary = (gm, bytes, reason, passes = 1) => {
    const mod = gm?.Module;
    if (!gm || !mod || !bytes) return false;
    _clearPendingCInputs(`${reason}:pre-load`);
    const stateBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const lt0 = performance.now();
    let method = 'gm.loadState';
    let result = 0;

    if (mod._kn_load_state_immediate && mod._malloc && mod._free && mod.HEAPU8) {
      method = 'kn_load_state_immediate';
      const statePtr = mod._malloc(stateBytes.length);
      if (!statePtr) {
        _syncLog(`FATAL: ${reason} state malloc failed (${stateBytes.length} bytes)`);
        return false;
      }
      try {
        mod.HEAPU8.set(stateBytes, statePtr);
        for (let i = 0; i < passes; i++) {
          result = mod._kn_load_state_immediate(statePtr, stateBytes.length);
        }
      } finally {
        mod._free(statePtr);
      }
    } else {
      for (let i = 0; i < passes; i++) {
        gm.loadState(stateBytes);
        if (mod._task_queue_check) mod._task_queue_check();
      }
    }

    recaptureManualRunner(mod, reason);
    _clearPendingCInputs(`${reason}:post-load`);
    const lt1 = performance.now();
    _syncLog(
      `${reason}: ${method} passes=${passes} result=${result} ` +
        `bytes=${Math.round(stateBytes.length / 1024)}KB ms=${(lt1 - lt0).toFixed(1)}`,
    );
    return true;
  };

  const loadKnSyncStateAtStartBoundary = (gm, bytes, reason) => {
    const mod = gm?.Module;
    if (!gm || !mod || !bytes || !mod._kn_sync_write || !mod._malloc || !mod._free || !mod.HEAPU8) return false;
    _clearPendingCInputs(`${reason}:pre-kn-sync`);
    const stateBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const lt0 = performance.now();
    const statePtr = mod._malloc(stateBytes.length);
    if (!statePtr) {
      _syncLog(`FATAL: ${reason} kn-sync malloc failed (${stateBytes.length} bytes)`);
      return false;
    }
    let result = -1;
    let stage = 'pre-set';
    try {
      stage = 'heapu8.set';
      mod.HEAPU8.set(stateBytes, statePtr);
      stage = 'kn_sync_write';
      result = mod._kn_sync_write(statePtr, stateBytes.length);
      stage = 'post-write';
    } catch (e) {
      const dSec = mod._kn_get_diag_ksw_section ? mod._kn_get_diag_ksw_section() : -1;
      const dOff = mod._kn_get_diag_ksw_offset ? mod._kn_get_diag_ksw_offset() : -1;
      _syncLog(
        `KN-SYNC-WRITE-THREW ${reason} stage=${stage} bytes=${stateBytes.length} ` +
          `heapBuf=${mod.HEAPU8?.buffer?.byteLength ?? '?'} ` +
          `lastSection=${dSec} lastOffset=${dOff} ` +
          `${e?.name || 'Error'}: ${e?.message || e}`,
      );
      console.error('[lockstep] kn_sync_write threw:', e);
      return false;
    } finally {
      try {
        mod._free(statePtr);
      } catch (_) {}
    }
    try {
      recaptureManualRunner(mod, reason);
      _clearPendingCInputs(`${reason}:post-kn-sync`);
    } catch (e) {
      _syncLog(`KN-SYNC-RECAPTURE-THREW ${reason} ${e?.name || 'Error'}: ${e?.message || e}`);
      console.error('[lockstep] post kn_sync_write recapture threw:', e);
      return false;
    }
    const lt1 = performance.now();
    _syncLog(
      `${reason}: kn_sync_write result=${result} bytes=${Math.round(stateBytes.length / 1024)}KB ms=${(lt1 - lt0).toFixed(1)}`,
    );
    return result === 0;
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
    if (!_pendingRunner) {
      // Try to recapture immediately. If we wait for the pointerdown retry
      // chain to find this (75/250/750/1500ms), the lockstep tick has
      // already advanced _frameNum many times while the emulator was
      // frozen — that's the peer-divergence path observed in production
      // (host log showed `manual runner recaptured after focus+750ms`,
      // i.e. ~45 frames of skew). Self-heal here keeps both peers
      // bit-identical: at most one tick of skew before recovery, which
      // is recovered by the runner's own emscripten_mainloop call below.
      if (_manualMode && !_isSpectator) {
        const recapMod = window.EJS_emulator?.gameManager?.Module;
        if (recapMod) recaptureManualRunner(recapMod, 'stepOneFrame:no-runner');
      }
    }
    if (!_pendingRunner) {
      // ── R2: no silent no-ops during rollback replay ──────────────
      // If a replay tick lands here with a null runner, retro_unserialize
      // (or another path) invalidated it and we have no way to actually
      // step the emulator. kn_post_tick would still advance rb.frame,
      // producing a Frankenstein state with frozen emulation. Per §Core
      // principle: log-loud-and-continue. No resync recovery.
      // See docs/netplay-invariants.md §R2.
      if (_useCRollback && _rbReplayLogged) {
        const mod = window.EJS_emulator?.gameManager?.Module;
        const rbFrame = mod?._kn_get_frame?.() ?? -1;
        const replayRemaining = mod?._kn_get_replay_depth?.() ?? -1;
        _syncLog(
          `REPLAY-NORUN f=${_frameNum} rbFrame=${rbFrame} ` +
            `replayRemaining=${replayRemaining} tick=${performance.now().toFixed(1)}`,
        );
        if (window.KN_DEV_BUILD) {
          throw new Error('REPLAY-NORUN: stepOneFrame called with null runner during replay');
        }
      }
      return false;
    }
    // MF6: mark WASM step active so TICK-STUCK watchdog can
    // attribute a stall to the WASM side if the frame counter is
    // stuck while this flag is true. Cleared in the return path
    // below (no try/finally — the runner is synchronous; if it
    // throws, the exception propagates and the tick interval keeps
    // firing new ticks which will clear the flag on re-entry).
    _wasmStepActive = true;
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
      if (frameModule?._kn_normalize_event_queue && frameModule?._kn_get_normalize_events?.()) {
        frameModule._kn_normalize_event_queue();
      }
      if (frameModule?._kn_drain_pending_interrupts && frameModule?._kn_get_drain_interrupts?.()) {
        frameModule._kn_drain_pending_interrupts();
      }
    }

    // Tag interrupt trace entries with current frame when trace logging is enabled.
    if (_hasForkedCore && _knTraceDiagnostics) {
      const trMod = window.EJS_emulator?.gameManager?.Module;
      if (trMod?._kn_int_trace_set_frame) trMod._kn_int_trace_set_frame(_frameNum);
    }

    runner(frameTimeMs);

    // Cheap visual ground-truth capture — default-on in prod so the admin
    // panel always has frames for desync triage. Opt out with ?screenshots=off.
    if (_knScreenshots && _frameNum > 0 && _frameNum % _diag.SCREENSHOT_INTERVAL === 0) {
      _diag.captureAndSendScreenshot();
    }
    // Heavier per-frame readbacks (event-queue hash, interrupt trace) are
    // opt-in via ?kndiag=deep — they cause visible stalls in cross-engine
    // stress tests.
    if (_knRuntimeDiagnostics && _frameNum > 0 && _frameNum % _diag.SCREENSHOT_INTERVAL === 0) {
      // Log event queue hash + interrupt trace for cross-peer comparison
      const eqMod = window.EJS_emulator?.gameManager?.Module;
      if (eqMod?._kn_eventqueue_hash) {
        const eqH = (eqMod._kn_eventqueue_hash() >>> 0).toString(16);
        _syncLog(`EQ-HASH f=${_frameNum} eq=${eqH}`);
      }
      // Log event queue normalization quantization data
      if (eqMod?._kn_eq_norm_get_count) {
        const normCount = eqMod._kn_eq_norm_get_count();
        if (normCount > 0) {
          const normPtr = eqMod._kn_eq_norm_get_log();
          const intNames = { 1: 'VI', 4: 'CHK', 8: 'SI', 16: 'PI', 64: 'AI', 128: 'SP', 256: 'DP' };
          const entries = [];
          for (let qi = 0; qi < normCount && qi < 16; qi++) {
            // struct: int type (4), uint32 raw_rel (4), uint32 quant_rel (4) = 12 bytes
            const base = (normPtr >> 2) + qi * 3;
            const type = eqMod.HEAP32[base];
            const rawRel = eqMod.HEAPU32[base + 1];
            const quantRel = eqMod.HEAPU32[base + 2];
            const delta = rawRel - quantRel;
            const name = intNames[type] || type.toString();
            entries.push(`${name}:${rawRel}→${quantRel}(Δ${delta})`);
          }
          _syncLog(`EQ-QUANT f=${_frameNum} n=${normCount} ${entries.join(' ')}`);
        }
      }
      // Dump interrupt trace: which interrupts fired since last dump
      if (eqMod?._kn_int_trace_get_count) {
        const n = eqMod._kn_int_trace_get_count();
        if (n > 0) {
          const ptr = eqMod._kn_int_trace_get_buf();
          const intNames = {
            1: 'VI',
            2: 'CMP',
            4: 'CHK',
            8: 'SI',
            16: 'PI',
            32: 'SPC',
            64: 'AI',
            128: 'SP',
            256: 'DP',
            2048: 'RSP',
          };
          const entries = [];
          const limit = Math.min(n, 256);
          for (let i = 0; i < limit; i++) {
            const base = (ptr >> 2) + i * 2; // 8 bytes per entry = 2 uint32s
            const w0 = eqMod.HEAPU32[base];
            const w1 = eqMod.HEAPU32[base + 1];
            const type = w0 & 0xff;
            const deferred = (w0 >> 8) & 0xff;
            const frameLo = (w0 >> 16) & 0xffff;
            const count = w1;
            const name = intNames[type] || type.toString(16);
            entries.push(`${name}${deferred ? 'd' : ''}@${count}`);
          }
          _syncLog(`INT-TRACE f=${_frameNum} n=${n} ${entries.join(' ')}`);
          eqMod._kn_int_trace_enable(1); // reset for next period
        }
      }
      // Input hash: FNV-1a over all inputs (local + remote) for last 300 frames.
      // Compare across peers to definitively prove whether inputs match.
      {
        const startF = _frameNum - _diag.SCREENSHOT_INTERVAL;
        let ih = 2166136261 >>> 0;
        const slots = [
          _playerSlot,
          ...Object.values(_peers)
            .filter((p) => p.slot != null)
            .map((p) => p.slot),
        ].sort();
        for (let f = startF; f < _frameNum; f++) {
          for (const s of slots) {
            let inp = null;
            if (s === _playerSlot) {
              inp = _localInputs[f];
            } else {
              inp = _remoteInputs[s]?.[f];
            }
            const b = inp?.buttons ?? 0;
            const lx = inp?.lx ?? 0;
            const ly = inp?.ly ?? 0;
            ih = (ih ^ (b & 0xff)) >>> 0;
            ih = Math.imul(ih, 16777619) >>> 0;
            ih = (ih ^ ((b >> 8) & 0xff)) >>> 0;
            ih = Math.imul(ih, 16777619) >>> 0;
            ih = (ih ^ (lx & 0xff)) >>> 0;
            ih = Math.imul(ih, 16777619) >>> 0;
            ih = (ih ^ (ly & 0xff)) >>> 0;
            ih = Math.imul(ih, 16777619) >>> 0;
          }
        }
        _syncLog(
          `INPUT-HASH f=${_frameNum} range=${startF}-${_frameNum} slots=${slots.join(',')} hash=${(ih >>> 0).toString(16)}`,
        );
      }
    }

    // Force GL composite via real rAF no-op. Full-headless replay deliberately
    // defers this to replay end so rollback frames avoid repeated composites.
    if (!_rbFullHeadlessActive) APISandbox.nativeRAF(() => {});
    _wasmStepActive = false;
    return true;
  };

  const _refreshRunnerAfterRollbackRestore = (tickMod) => {
    // ── R1: runner continuity across rollback restore ─────────────────
    // kn_pre_tick's rollback branch calls retro_unserialize directly,
    // which invalidates the Emscripten rAF runner captured by JS's
    // overrideRAF interceptor. Without re-capture, stepOneFrame in replay
    // is a silent no-op and the replay never runs.
    // The loadState path at line ~8221 already does this; we mirror
    // here for the C-level rollback path.
    // See docs/netplay-invariants.md §R1.
    if (!tickMod?._kn_rollback_did_restore?.()) return;
    const gm = window.EJS_emulator?.gameManager;
    if (gm?.Module) {
      const t0 = performance.now();
      gm.Module.pauseMainLoop();
      gm.Module.resumeMainLoop();
      if (gm.Module.updateMemoryViews) {
        gm.Module.updateMemoryViews();
      } else if (gm.Module._emscripten_notify_memory_growth) {
        gm.Module._emscripten_notify_memory_growth(0);
      }
      const dt = performance.now() - t0;
      if (RB_FULL_HEADLESS_DURING_REPLAY || dt >= 2) {
        _syncLog(`RB-RUNNER-REFRESH ms=${dt.toFixed(3)} headless=${_rbFullHeadlessActive ? 1 : 0}`);
      }
    }
  };

  const _runCReplayFrame = (tickMod) => {
    // C wrote inputs + saved state for the replay frame. JS now steps
    // the emulator via stepOneFrame() — the SAME code path as normal play.
    // Pre-frame setup (reset audio, RNG sync) must match the normal path
    // exactly — setup_frame() was removed from C to avoid double-calling
    // normalize/reset which caused progressive state divergence.
    //
    // CRITICAL: sync _frameNum with C's rb.frame BEFORE stepOneFrame().
    // On the first replay frame of a rollback, _frameNum is still the
    // pre-rollback value while C has already rewound rb.frame to the
    // rollback target. stepOneFrame() uses _frameNum for frame time
    // and event queue normalization. If _frameNum is wrong, each peer
    // applies a DIFFERENT wrong frame time to the same logical frame
    // (because each detects the misprediction at a different absolute
    // frame), causing event queue divergence that never recovers.
    _frameNum = tickMod._kn_get_frame();
    KNState.frameNum = _frameNum;
    if (tickMod._kn_reset_audio) {
      tickMod._kn_reset_audio();
      _resetAudioCallsSinceRb++;
    }
    _syncRNGSeed(tickMod, _frameNum);
    // try/finally: if stepOneFrame throws (WASM OOB, abort, etc.), the
    // performance.now() override stays armed and returns frozen WASM
    // cycle time, which freezes the setInterval tick scheduler and the
    // entire game loop. See netplay-lockstep.js:6873.
    _inDeterministicStep = true;
    try {
      stepOneFrame();
    } catch (e) {
      _syncLog(_formatStepThrew('replay', e));
      console.error('[lockstep] stepOneFrame threw (replay):', e);
    } finally {
      _inDeterministicStep = false;
    }
    _syncRNGSeed(tickMod, _frameNum);
    // Replay audio was generated to keep emulator state faithful, but it
    // is intentionally not fed to WebAudio from the replay branch. The
    // next normal frame reset drops any leftover replay PCM without
    // making final-frame diagnostics look like the core never produced
    // samples.
    const newFrame = tickMod._kn_post_tick();
    _frameNum = newFrame;
    KNState.frameNum = _frameNum;
    // KNDesync.tick is intentionally skipped on replay frames. Each
    // invocation does ~63 WASM hash calls (21 field hashes for the
    // current digest + 42 pre/post replay-meta hashes) plus up to a
    // 64×21×2 trajectory-divergence scan. Measured at ~5ms/step on the
    // demo path — enough to push burst≥2 replay ticks past the 16.6ms
    // vsync budget and produce the visible stutter at rollback frequency.
    // The trajectory analysis only needs to fire once after replay
    // completes; the next normal tick's KNDesync.tick picks up the new
    // last-replay frame via _kn_get_last_replay_*.
  };

  const _setReplayRdpSkip = (tickMod, enable, reason = '') => {
    if (!tickMod?._kn_set_skip_rdp_replay) return;
    const next = !!enable && RB_SKIP_RDP_DURING_REPLAY;
    if (_rbRdpSkipActive === next) return;
    try {
      tickMod._kn_set_skip_rdp_replay(next ? 1 : 0);
      _rbRdpSkipActive = next;
      _syncLog(`REPLAY-RDP-SKIP ${next ? 'on' : 'off'}${reason ? ` ${reason}` : ''}`);
    } catch (e) {
      _syncLog(`REPLAY-RDP-SKIP failed: ${e?.message || e}`);
    }
  };

  const _forceReplayEndComposite = (reason = '') => {
    const t0 = performance.now();
    try {
      APISandbox.nativeRAF(() => {});
      const dt = performance.now() - t0;
      if (RB_FULL_HEADLESS_DURING_REPLAY) {
        _syncLog(`REPLAY-END-COMPOSITE scheduleMs=${dt.toFixed(3)}${reason ? ` ${reason}` : ''}`);
      }
    } catch (e) {
      _syncLog(`REPLAY-END-COMPOSITE failed: ${e?.message || e}`);
    }
  };

  const _setReplayFullHeadless = (tickMod, enable, reason = '') => {
    if (!tickMod?._kn_set_headless) return;
    const next = !!enable && RB_FULL_HEADLESS_DURING_REPLAY;
    if (_rbFullHeadlessActive === next) return;
    try {
      tickMod._kn_set_headless(next ? 1 : 0);
      _rbFullHeadlessActive = next;
      _syncLog(`REPLAY-FULL-HEADLESS ${next ? 'on' : 'off'}${reason ? ` ${reason}` : ''}`);
      if (!next) _forceReplayEndComposite(reason || 'headless-off');
    } catch (e) {
      _syncLog(`REPLAY-FULL-HEADLESS failed: ${e?.message || e}`);
    }
  };

  const _finishCReplay = (tickMod) => {
    if (!_rbReplayLogged) {
      _setReplayFullHeadless(tickMod, false, 'finish-noop');
      _setReplayRdpSkip(tickMod, false, 'finish-noop');
      return;
    }
    _setReplayFullHeadless(tickMod, false, 'finish');
    _setReplayRdpSkip(tickMod, false, 'finish');
    // Let the shadow overlay remain alive through its hold window. The
    // main-rAF pump keeps producing visible worker frames while replay
    // finishes, and the post-replay resync below is deferred until hide
    // when the overlay is still covering the live canvas.
    _hideRollbackVisualFreeze();
    _shadowScheduleResync('post-replay');
    // Replay finished — broadcast the gameplay hash so the peer can
    // verify the rollback restoration produced identical game state.
    // gameplay_hash hashes ONLY game-relevant RDRAM addresses (damage,
    // stocks, timer, RNG) — immune to audio/video/heap noise.
    const hashFrame = _frameNum;
    const checkFrame = hashFrame;
    const gpHash = tickMod._kn_gameplay_hash?.(hashFrame) ?? 0;
    const gameHash = _knDeepDiagnostics ? (tickMod._kn_game_state_hash?.(hashFrame) ?? 0) : 0;
    const fullHash = _knDeepDiagnostics ? (tickMod._kn_full_state_hash?.(hashFrame) ?? 0) : 0;
    const hiddenFpDone = _knDeepDiagnostics ? (tickMod._kn_get_hidden_state_fingerprint?.() ?? 0) : 0;
    const sfStateDone = _knDeepDiagnostics ? (tickMod._kn_get_softfloat_state?.() ?? 0) : 0;
    const taintedCountDone = _knDeepDiagnostics ? (tickMod._kn_get_tainted_block_count?.() ?? 0) : 0;
    const rbCheckGameplay = _isRbCheckGameplayPhase();
    _syncLog(
      `C-REPLAY done: caught up at f=${_frameNum} gp=0x${gpHash.toString(16)} game=0x${gameHash.toString(16)} full=0x${fullHash.toString(16)} hidden=0x${hiddenFpDone.toString(16)} sf=0x${sfStateDone.toString(16)} taint=${taintedCountDone}`,
    );
    if (rbCheckGameplay) {
      for (const p of getActivePeers()) {
        if (p.dc?.readyState === 'open') {
          try {
            p.dc.send(`rb-check:${checkFrame}:${gpHash}:${gameHash}`);
          } catch (_) {}
        }
      }
    }
    // Schedule one more hash broadcast on the NEXT tick so we capture
    // the state of the FIRST frame after replay completes — that's the
    // frame most likely to expose "rollback restoration was lossy"
    // bugs because it's the first divergence point.
    _rbPendingPostRollbackHash = rbCheckGameplay;
    _rbReplayLogged = false;
    _lastRollbackDoneFrame = _frameNum;
    _resetAudioCallsSinceRb = 0;
    if (tickMod._kn_set_skip_rsp_audio) tickMod._kn_set_skip_rsp_audio(0);
  };

  const _prepareCReplayFrame = (tickMod, localInput, frameAdvForC) => {
    let next = tickMod._kn_pre_tick(
      localInput.buttons,
      localInput.lx,
      localInput.ly,
      localInput.cx,
      localInput.cy,
      frameAdvForC,
    );
    _refreshRunnerAfterRollbackRestore(tickMod);
    _frameNum = tickMod._kn_get_frame();
    KNState.frameNum = _frameNum;
    const depth = tickMod._kn_get_replay_depth?.() ?? 0;
    if (depth > 0 && next !== 2) {
      const rbFrame = tickMod._kn_get_frame?.() ?? -1;
      _syncLog(
        `RB-INVARIANT-FIXUP f=${_frameNum} replayDepth=${depth} ` +
          `catchingUp=${next} rbFrame=${rbFrame} tick=${performance.now().toFixed(1)} — forcing replay step`,
      );
      next = 2;
    }
    return next;
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
  let _resumeInputGuardUntil = 0;
  let _lifecycleResyncPending = false;
  let _lifecycleResyncStartedAt = 0;
  const EJS_PAUSE_CLEAR_RETRY_DELAYS_MS = [75, 250, 750, 1500];
  const EJS_RESUME_INPUT_GUARD_MS = 300;
  const LIFECYCLE_RESYNC_INPUT_GUARD_MS = 5000;
  const LIFECYCLE_RESYNC_PENDING_TIMEOUT_MS = 15000;
  const _releaseLocalFocusInput = () => {
    const hadKeys = _heldKeys.size > 0;
    _heldKeys.clear();

    let hadTouch = false;
    const touchInput = KNState?.touchInput;
    if (touchInput) {
      for (const key in touchInput) {
        if (!Object.prototype.hasOwnProperty.call(touchInput, key)) continue;
        if (touchInput[key]) hadTouch = true;
        touchInput[key] = 0;
      }
    }
    return hadKeys || hadTouch;
  };

  const _markControlsFocusLost = () => {
    if (_controlsFocusLost) return;
    _controlsFocusLost = true;
    setStatus('Click game to refocus controls');
    _config?.onToast?.('Game controls lost focus — click the game');
  };

  const _restoreControlsFocus = (reason = 'pointer') => {
    if (_phase !== PHASE_RUNNING) return;
    try {
      window.focus?.();
    } catch (_) {}
    const target = document.getElementById('game') || document.body;
    if (target) {
      try {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus?.({ preventScroll: true });
      } catch (_) {}
    }
    _releaseLocalFocusInput();
    if (_controlsFocusLost) {
      _controlsFocusLost = false;
      setStatus('Connected -- game on!');
      _syncLog(`TAB-FOCUS recovered via ${reason} f=${_frameNum}`);
    }
  };
  const PEER_DEAD_MS = 5000; // 5s without frame advance → peer is dead
  // Rollback-mode hard stall threshold. Faster than PEER_DEAD_MS because
  // rollback's frame-advantage ring fills up within ~10 frames (~167ms at
  // 60fps) once inputs stop arriving. Anything past 500ms of silence means
  // cascading prediction-replay work is eating the frame budget, so we
  // freeze the local sim until inputs return. See ROLLBACK-STALL logic.
  const ROLLBACK_STALL_MS = 3000; // was 500 — keep predicting through drops
  let _rollbackStallStart = 0;
  let _consecutiveFabrications = {}; // slot -> count of consecutive hard-timeout fabrications
  const RAPID_FABRICATION_THRESHOLD = 2; // after N consecutive fabrications, skip stall wait
  let _inputLateLogTime = {}; // slot -> last time INPUT-LATE was logged (rate-limiting)

  const startLockstep = () => {
    if (_phase === PHASE_RUNNING) return;
    _phase = PHASE_RUNNING;
    window._knPreventRetroArchVisibilityPause = true;
    _checkStateTransition();

    // Ensure session log flushing is active. startGameSequence() sets this
    // up for normal joins, but late-joiners return early from that function
    // and resume here via handleLateJoinState() → startLockstep(). Without
    // this, late-joiners produce zero session logs and zero screenshots.
    if (!_flushInterval) {
      _cachedMatchId = _cachedMatchId || KNState.matchId;
      _cachedRoom = _cachedRoom || KNState.room;
      _cachedUploadToken = _cachedUploadToken || KNState.uploadToken;
      _socketFlushFails = 0;
      _flushInterval = setInterval(_flushSyncLog, SYNC_LOG_FLUSH_MS);
      // Early flush at 5s so short matches (that freeze, crash, or are
      // aborted before the 30s interval fires) still leave a DB row. This
      // caught a real bug where room 4A2NMSLS was completely invisible
      // after a match froze and the tab was closed before 30s elapsed.
      setTimeout(() => _flushSyncLog(), 5000);
      _startTime = _startTime || performance.now();
    }

    // Detect forked core with C-level deterministic timing exports
    const lsMod = window.EJS_emulator?.gameManager?.Module;
    _hasForkedCore = !!(lsMod?._kn_set_deterministic && lsMod._kn_set_frame_time);
    if (_hasForkedCore) {
      _syncLog('forked core detected — C-level deterministic timing');
      if (lsMod?._kn_set_skip_rdp_replay) {
        lsMod._kn_set_skip_rdp_replay(0);
        _rbRdpSkipActive = false;
        _syncLog(`replay RDP skip ${RB_SKIP_RDP_DURING_REPLAY ? 'available' : 'disabled by flag'}`);
      }
      if (lsMod?._kn_set_headless) {
        lsMod._kn_set_headless(0);
        _rbFullHeadlessActive = false;
        _syncLog(`replay full headless ${RB_FULL_HEADLESS_DURING_REPLAY ? 'available by flag' : 'disabled'}`);
      }
    } else {
      _syncLog('stock core — JS-level timing patch (fallback)');
    }

    // Wire field-granular desync detector. Default mode is C — host-
    // authoritative comparison, digest every 6 frames, no heartbeat — which
    // is cheap in steady state (~3KB/s/peer) and only triggers Claude vision
    // calls when peers actually diverge. Stock CDN cores silently no-op via
    // _hasRequiredExports. Opt out with ?desync=off; ?desync=b promotes to
    // pairwise mode B with the 5s heartbeat (every-frame digests + always-on
    // vision sampling — for active triage only).
    const desyncParam = _urlParams.get('desync');
    if (lsMod && window.KNDesync && desyncParam !== 'off') {
      const desyncMode = desyncParam === 'b' ? 'B' : 'C';
      KNDesync.init(lsMod, desyncMode);
    }

    // Only reset frame counter if not a late join (late join sets _frameNum before calling)
    if (_frameNum === 0) {
      // Preserve synthetic peers' input state across this wipe. The wipe is
      // designed for real WebRTC peers that re-populate state continuously by
      // sending packets each frame; synthetic peers (1P demo mode) are created
      // once at init and have no equivalent recovery path. Without preservation,
      // the lockstep input-application path stalls at _frameNum=DELAY_FRAMES
      // because _remoteInputs[syntheticSlot][0] is undefined and never refilled.
      const preservedRemoteInputs = {};
      const preservedPeerStarted = {};
      for (const [, peer] of Object.entries(_peers)) {
        if (peer?.synthetic === true && _isValidPlayerSlot(peer.slot)) {
          if (_remoteInputs[peer.slot]) preservedRemoteInputs[peer.slot] = _remoteInputs[peer.slot];
          if (_peerInputStarted[peer.slot]) preservedPeerStarted[peer.slot] = true;
        }
      }
      _localInputs = {};
      _remoteInputs = preservedRemoteInputs;
      _peerInputStarted = preservedPeerStarted;
      _activeRoster = null;
      _pendingLateJoinPeerSids.clear();
      _pendingLateJoinPeerSlots.clear();
      _lateJoinActivatedAtFrame = {};
      _lateJoinInputBootstrapUntilFrame = -1;
      _lateJoinSeededInputFrames = {};
      _rosterChangeFrame = -1;
      // On a kn-sync rematch, both peers boot from a bit-identical state
      // captured by the host — the menu-start barrier (which exists to
      // bridge the cold-boot scene-mismatch window) serves no purpose
      // and would suppress input forever if the resumed state is in a
      // gameplay scene (where _isControllableMenuScene returns false).
      _menuStartBarrierReleased = _lockstepStartStateKind === 'kn-sync';
      _menuStartLocalReady = false;
      _menuStartLocalScene = 0;
      _menuStartReleaseAt = 0;
      _menuStartReadyPeers = {};
      _menuStartReadyLastBroadcast = 0;
      _peerPhases = {};
      _phaseMismatchGrace = {};
      _lastPhaseBroadcastAt = 0;
      _lastPhaseBroadcastKey = '';
      _lastPeerPhaseWaitLogFrame = -1;
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
    _resumeInputGuardUntil = 0;
    _stallStart = 0;
    _phaseLockStallKey = '';
    _phaseLockStallStartTime = 0;
    _rbInputStallKey = '';
    _rbInputStallStartTime = 0;
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

      // Enable event queue normalization for cross-platform determinism
      if (detMod?._kn_set_normalize_events) {
        detMod._kn_set_normalize_events(1);
        _syncLog('C-level event queue normalization enabled');
      }
      // Interrupt drain disabled — causes silent WASM crashes when
      // handler callbacks fire out of context. Using event queue
      // quantization (KN_EQ_QUANT in normalize) instead.
      // if (detMod?._kn_set_drain_interrupts) {
      //   detMod._kn_set_drain_interrupts(1);
      // }
      // Enable expensive trace streams only when explicitly requested.
      if (_knTraceDiagnostics && detMod?._kn_int_trace_enable) {
        detMod._kn_int_trace_enable(1);
        _syncLog('C-level interrupt trace enabled');
      } else if (detMod?._kn_int_trace_enable) {
        detMod._kn_int_trace_enable(0);
      }

      if (_knTraceDiagnostics && detMod?._kn_fpu_trace_enable) {
        detMod._kn_fpu_trace_enable(1);
        _fpuTraceEnabled = true;
        _fpuTraceLastCheckFrame = 0;
        _fpuTraceVerified = false;
        _syncLog('FPU trace enabled for determinism verification');
      } else if (detMod?._kn_fpu_trace_enable) {
        detMod._kn_fpu_trace_enable(0);
        _fpuTraceEnabled = false;
      }

      // Initialize C-level rollback engine if available.
      //
      // CRITICAL: both peers MUST init kn_rollback_init with the SAME delay
      // value, or one peer ends up running rollback (predicting + replaying
      // missing inputs) while the other runs lockstep (waiting for inputs
      // before stepping). That asymmetric protocol cascades into divergence.
      //
      // The host computes a delay (maxDelay), broadcasts `rb-delay:N`, and
      // is the authoritative source. Guests must wait for that broadcast
      // before initializing — initializing first with locally-computed delay
      // and then "updating DELAY_FRAMES" later only fixes the JS-side
      // variable, not the C engine's internal delay.
      const doRollbackInit = (effectiveDelay, initFrameOverride = null) => {
        if (!detMod?._kn_rollback_init) {
          _useCRollback = false;
          return;
        }
        // Choose init frame: host-broadcast value (when guest is matching the
        // host's init point) or local _frameNum. The SR deferred-init path
        // fires init at the LOCAL MENU→GAMEPLAY transition, which can land on
        // different _frameNum on each peer if pacing-throttle skipped a tick
        // on one side during the menu phase. Initializing rb.frame to the
        // host's frame on guests guarantees both engines label exchanged
        // input-frame numbers against the same simulation point. Late-join
        // already sets _frameNum to the host's frame from the loaded state,
        // so the local fallback is correct there too.
        const initFrame = initFrameOverride != null ? initFrameOverride : _frameNum;
        // Always 4 (KN_MAX_PLAYERS) — avoids contiguous slot assumption.
        const numPlayers = 4;
        // Ring buffer size = rollbackMax + 1 slots × ~16MB each.
        // Balance between memory pressure and pacing headroom.
        // Too small (delay+2=4) causes safety-freeze to strangle FPS.
        // Too large (20) wastes 320MB on mobile.
        // 8 gives enough pacing headroom (safety freeze at fAdv>=6)
        // while keeping ring buffer at 9 slots × 16MB = 144MB.
        // True-rollback expands visible rollback depth from delay+4 to delay+10
        // (capped at 12 by the C engine), so size the ring buffer to match.
        const rollbackMax = Math.max(12, effectiveDelay + 10);
        if (detMod._kn_set_state_backend) {
          const backendId = RB_ROLLBACK_STATE_BACKEND === 'split-rdram' ? 1 : 0;
          detMod._kn_set_state_backend(backendId);
          _syncLog(`C-ROLLBACK state backend requested=${RB_ROLLBACK_STATE_BACKEND}`);
        } else if (RB_ROLLBACK_STATE_BACKEND === 'split-rdram') {
          _syncLog(
            'C-ROLLBACK split-rdram requested but _kn_set_state_backend export is missing; using retro_serialize',
          );
        }
        detMod._kn_rollback_init(rollbackMax, effectiveDelay, _playerSlot, numPlayers);
        if (detMod._kn_get_state_backend) {
          const activeBackend = detMod._kn_get_state_backend() === 1 ? 'split-rdram' : 'retro';
          _syncLog(`C-ROLLBACK state backend active=${activeBackend}`);
        }
        // Push the input-application mode down to the C engine so the replay
        // path mirrors the JS forward-tick split (local at current frame,
        // remote at applyFrame). Mismatched modes between JS and C produce
        // silent state divergence on every replay.
        const localCaps = _localRollbackCaps();
        if (detMod._kn_set_true_rollback) {
          detMod._kn_set_true_rollback(localCaps.trueRollback ? 1 : 0);
          _syncLog(`C-ROLLBACK trueRollback=${localCaps.trueRollback ? 1 : 0}`);
        }
        // Set the C engine's frame counter so kn_get_frame()/exchanged input
        // frame numbers line up across peers. Late-join: _frameNum was set
        // to the host's frame from the loaded state. Deferred-init guest:
        // initFrame is the host's broadcast frame (initFrameOverride).
        if (initFrame > 0 && detMod._kn_set_frame) {
          detMod._kn_set_frame(initFrame);
          _syncLog(
            `C-ROLLBACK init: set C frame to ${initFrame}` +
              (initFrameOverride != null ? ` (host-authoritative)` : ` (local)`),
          );
        } else if (initFrame > 0) {
          // WASM doesn't have kn_set_frame yet — disable C rollback so the
          // tick loop doesn't sync _frameNum from the C engine's stale 0.
          _syncLog(`C-ROLLBACK late-join: no _kn_set_frame, disabling C rollback`);
          _useCRollback = false;
          return;
        }
        rb_numPlayers = numPlayers;
        _rbRollbackMax = rollbackMax;
        if (!_rbInputPtr && detMod._malloc) _rbInputPtr = detMod._malloc(20);
        _useCRollback = true;
        _rbInitFrame = initFrame;
        _rbConvergedLogged = false;
        // T3: explicit mode marker so the server-side log analyzer knows
        // which netplay mode captured the input audit payload.
        const heapMB = detMod.HEAP8 ? (detMod.HEAP8.byteLength / 1024 / 1024).toFixed(0) : '?';
        _syncLog(
          `C-ROLLBACK init: max=${rollbackMax} delay=${effectiveDelay} slot=${_playerSlot} players=${numPlayers} heapMB=${heapMB}`,
        );

        // Host broadcasts its init frame so guests can match it. Mirrors the
        // rb-delay broadcast at line ~5017; deferred-init for SR fires after
        // that broadcast, so a separate message here is required. Sent over
        // the same DC as rb-delay (reliable+ordered), so guests receive
        // rb-delay before rb-init-frame and gate accordingly. Non-host peers
        // are no-op here because their _peers map is keyed by remote slot
        // and doesn't include the host (the only guest→guest broadcast in
        // this codebase is the rb-blocks per-block hash exchange).
        if (_playerSlot === 0) {
          for (const p of Object.values(_peers)) {
            if (p.dc?.readyState === 'open') {
              try {
                p.dc.send(`rb-init-frame:${initFrame}`);
              } catch (_) {}
            }
          }
        }
        _syncLog(`audit: recording enabled mode=rollback transport=${_rbTransport}`);
        // P4: reset the failed_rollbacks baseline at init so any increase
        // during the match is detected fresh.
        _rbLastFailedRollbacks = 0;
        // Reset C debug log drain pointer so the new match starts fresh.
        _cDebugLogLastLen = 0;
        // Reset divergence diagnostics state
        _rbLastGoodFrame = -1;
        _rbBisectActive = false;
        _rbBisectFramesRemaining = 0;
        _rbBisectCount = 0;
        _rbPendingPostRollbackHash = false;
        if (_runSubstate === RUN_RB_STALL) _runSubstate = RUN_NORMAL;
        _rollbackStallStart = 0;

        // C-level RNG sync + frame counter preservation.
        // Must be inside doRollbackInit (not after) so deferred guest init
        // also runs this — the outer code checks _useCRollback which is
        // false until doRollbackInit sets it.
        const rngMod = window.EJS_emulator?.gameManager?.Module;
        if (rngMod) _initRNGSync(rngMod);
        if (_rngPatched && _rdramBase && rngMod?._kn_set_rng_sync) {
          const rngPtr = _rdramBase + KN_RNG_SEED_RDRAM;
          const rngAltPtr = _rdramBase + KN_RNG_ALT_SEED_RDRAM;
          rngMod._kn_set_rng_sync(_rngSeed, rngPtr, rngAltPtr);
          _syncLog(`C-ROLLBACK RNG sync configured: seed=0x${_rngSeed.toString(16)}`);
        }
        // Configure non-tainted RDRAM preservation — must be AFTER
        // kn_rollback_init which sets up the taint bitmap.
        if (_rdramBase && rngMod?._kn_set_rdram_preserve) {
          rngMod._kn_set_rdram_preserve(_rdramBase);
          _syncLog(`C-ROLLBACK non-tainted RDRAM preservation configured`);
        }
        _backfillCInputsFromJs(detMod, 'rollback-init');

        // kn_rollback_init mallocs ringSize × stateSize (~208MB) + an 8MB
        // rdram-preserve buffer. On Smash Remix, this consistently grows
        // the WASM heap, detaching HEAPU8 and stranding _pendingRunner with
        // stale memory views — the next stepOneFrame throws WASM
        // RuntimeError ('null function' on V8, 'call_indirect signature
        // mismatch' on JSC), and the no-runner recapture path then loops
        // forever logging 'manual runner recaptured after stepOneFrame:no-runner'.
        // Re-capture here forces updateMemoryViews + a fresh rAF runner.
        recaptureManualRunner(detMod, 'kn-rollback-init');
      };
      window._rbDoInit = doRollbackInit;

      // Common init dispatcher: host inits with the broadcast delay (and
      // broadcasts its init frame from inside doRollbackInit); guest inits
      // only when both rb-delay AND rb-init-frame have been received, so
      // guest's rb.frame matches the host's at init time. If either is
      // missing, arm pending state and let the rb-delay/rb-init-frame
      // handlers fire init when the broadcast arrives.
      const tryInitRollback = () => {
        if (_playerSlot === 0) {
          // Host: init immediately at local frame; doRollbackInit broadcasts
          // rb-init-frame inside so guests can match.
          doRollbackInit(DELAY_FRAMES);
        } else if (
          window._rbHostDelay !== undefined &&
          window._rbHostDelay > 0 &&
          window._rbHostInitFrame !== undefined
        ) {
          DELAY_FRAMES = window._rbHostDelay;
          doRollbackInit(window._rbHostDelay, window._rbHostInitFrame);
        } else {
          // I1 (MF2): record the wall-clock start of the pending
          // state so tick() can fire RB-INIT-TIMEOUT if the host's
          // rb-delay/rb-init-frame broadcast never arrives (DC died
          // mid-send, host crashed, etc).
          window._rbPendingInit = true;
          window._rbPendingInitAt = performance.now();
          const haveDelay = window._rbHostDelay !== undefined && window._rbHostDelay > 0;
          const haveInitFrame = window._rbHostInitFrame !== undefined;
          _syncLog(
            `C-ROLLBACK deferred: waiting for host ` +
              `${haveDelay ? '' : 'rb-delay '}${haveInitFrame ? '' : 'rb-init-frame '}` +
              `broadcast (own delay=${DELAY_FRAMES})`,
          );
        }
      };

      if (detMod?._kn_rollback_init && DELAY_FRAMES > 0) {
        if (_isSmashRemix()) {
          // Smash Remix's title/menu code path triggers a WASM `unreachable`
          // abort when the rollback engine's per-frame retro_serialize runs
          // concurrently — observed at host f=908 in match 85d7a6c8 after
          // 15s of menu navigation. Stock SSB64 doesn't hit this. Defer
          // rollback init until the local emulator transitions into
          // gameplay (gameStatus=1 scene=22). Until then, both peers run
          // pure lockstep with frame delay (no ring serialize, no
          // predictions). Once gameplay starts, init kicks in and rollback
          // is active for the entire match — where it actually matters
          // competitively. Fired from the MENU→GAMEPLAY transition handler
          // in tick().
          window._rbDeferredForGameplay = tryInitRollback;
          // Stash the closure so GAMEPLAY→MENU teardown can re-arm it for
          // subsequent matches in the same session without restarting the
          // engine.
          _rbReinitClosure = tryInitRollback;
          _syncLog(
            `C-ROLLBACK deferred for Smash Remix: will init at MENU→GAMEPLAY transition ` +
              `(own delay=${DELAY_FRAMES} slot=${_playerSlot})`,
          );
        } else {
          tryInitRollback();
        }
      } else {
        if (DELAY_FRAMES <= 0 && detMod?._kn_rollback_init) {
          _syncLog('C-ROLLBACK disabled for zero-delay solo play');
        }
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

    // JS-level RNG seed writes happen in every manual-step path. Initialize
    // this as soon as RDRAM is available so menu random selection cannot race
    // a deferred guest rollback init. doRollbackInit still configures the C
    // replay hook when rollback is active.
    {
      const rngMod = window.EJS_emulator?.gameManager?.Module;
      if (rngMod) _initRNGSync(rngMod);
    }

    // Only install diagnostic hooks when explicitly enabled — they add
    // MutationObserver on document.body, touch listeners, and write to
    // window.KNDiag.eventLog which grows unboundedly (17MB+ on mobile in 30 min).
    _diag.init({
      log: _syncLog,
      getFrame: () => _frameNum,
      getSlot: () => _playerSlot,
      sendScreenshot: (data) => {
        if (!socket?.connected) return;
        socket.emit('game-screenshot', {
          matchId: _cachedMatchId || KNState.matchId,
          ...data,
        });
      },
    });
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
      `DIAG-START slot=${_playerSlot} engine=${engine} mobile=${isMobile} forkedCore=${_hasForkedCore} romHash=${_config?.romHash?.substring(0, 16) || 'none'} coreHash=${window._knCoreHash || 'unknown'} ua=${ua.substring(0, 120)}`,
    );

    const activePeers = getActivePeers();
    const peerSlots = activePeers.map((p) => p.slot);
    _syncLog(`lockstep started -- slot: ${_playerSlot} peerSlots: ${peerSlots.join(',')} delay: ${DELAY_FRAMES}`);
    _broadcastRoster();
    _applyControllerPresentMask('start-lockstep');
    _syncLog(`SYNC-MODE: RDRAM hash desync detection, knSync=${_hasKnSync}`);

    // Production netplay needs audible audio on original forward frames.
    // Replay frames suppress RSP audio separately so rollback does not double
    // feed audio or advance HLE-side audio scratch state during catch-up.
    {
      const skipMod = window.EJS_emulator?.gameManager?.Module;
      if (skipMod?._kn_set_skip_rsp_audio) {
        skipMod._kn_set_skip_rsp_audio(0);
        _syncLog('RSP audio mode 0: normal forward audio enabled');
      }
      if (skipMod?._kn_set_skip_audio_output) {
        skipMod._kn_set_skip_audio_output(0);
        _syncLog('Audio output enabled: aiLenChanged feeds deterministic capture buffer');
      }
      const fifo = _captureAudioFifoState(skipMod);
      const samples = skipMod?._kn_get_audio_samples?.();
      const skipOutput = skipMod?._kn_get_skip_audio_output?.();
      const deterministic = skipMod?._kn_get_deterministic?.();
      _syncLog(
        `audio boundary start-lockstep: samples=${samples ?? 'n/a'} ` +
          `fifo=${fifo ? `[${fifo.join(',')}]` : 'n/a'} ` +
          `skipOutput=${skipOutput ?? 'n/a'} deterministic=${deterministic ?? 'n/a'}`,
      );
    }

    installNativeInputGuard();

    setStatus('Connected -- game on!');
    _startTime = performance.now();
    _cachedMatchId = KNState.matchId;
    _cachedRoom = KNState.room;
    _cachedUploadToken = KNState.uploadToken;
    _socketFlushFails = 0;
    _flushInterval = setInterval(_flushSyncLog, SYNC_LOG_FLUSH_MS);
    // Early flush at 5s so short matches (freeze/crash/abort before 30s)
    // still leave a DB row. See also the lockstep-ready path above.
    setTimeout(() => _flushSyncLog(), 5000);

    // Page-unload safety net: force-flush via HTTP keepalive on pagehide.
    // Without this, a tab crash / user closing the tab / mobile Safari
    // backgrounding mid-match causes 100% of in-memory log entries to be
    // lost since the 30s interval never fires. Socket.IO disconnect also
    // races with page unload — the HTTP path with keepalive:true is the
    // only reliable delivery during unload. Using pagehide (not beforeunload)
    // because it works on mobile Safari where beforeunload is ignored.
    if (!window._knFlushUnloadHandler) {
      const handler = () => {
        try {
          // Drain C debug log one last time so we capture final rb_log entries
          _drainCDebugLog();
          const payload = _buildFlushPayload();
          // Only use HTTP here — Socket.IO is already torn down
          _flushViaHttp(payload);
        } catch (_) {}
      };
      window._knFlushUnloadHandler = handler;
      window.addEventListener('pagehide', handler);
      // visibilitychange to 'hidden' is the mobile-Safari-friendly equivalent
      // for app backgrounding (pagehide doesn't always fire there).
      _unloadVisChangeHandler = () => {
        if (document.visibilityState === 'hidden') handler();
      };
      document.addEventListener('visibilitychange', _unloadVisChangeHandler);
    }

    window._lockstepActive = true;

    // C-level sync: detect patched core with kn_sync exports.
    // Detect patched core with kn_sync exports. Buffer is allocated lazily
    // on first use (see ensureSyncBuffer) to avoid triggering WASM memory
    // growth at startup when sync may never be needed.
    const knMod = window.EJS_emulator?.gameManager?.Module;
    _hasKnSync = !!(knMod && knMod._kn_sync_hash && knMod._kn_sync_read && knMod._kn_sync_write);
    if (_hasKnSync) {
      // Sync buffer allocation deferred to first use (ensureSyncBuffer is called
      // inside pushSyncState/applySyncState). Allocating 8MB at init on mobile
      // can trigger WASM memory growth that disrupts DataChannel stability.
      _syncLog(`C-level sync available${_syncBufPtr ? `, buf at ${_syncBufPtr}` : ' (buffer deferred)'}`);
    } else {
      _syncLog('C-level sync NOT available, using getState/loadState fallback');
    }

    let _retroArchUnpauseDisabled = false;

    const _forceRetroArchUnpause = (mod, reason) => {
      if (!mod?._cmd_unpause || _retroArchUnpauseDisabled) return false;
      try {
        mod._cmd_unpause();
        _syncLog(`RetroArch explicit unpause sent on ${reason}`);
        return true;
      } catch (e) {
        const name = e?.name || 'Error';
        const message = e?.message || String(e);
        _syncLog(`RetroArch explicit unpause failed on ${reason}: ${name}: ${message}`);
        if (/memory access out of bounds/i.test(message)) {
          _retroArchUnpauseDisabled = true;
          _syncLog('RetroArch explicit unpause disabled after WASM OOB; relying on foreground/main-loop refresh');
        }
        return false;
      }
    };

    const _clearEjsPauseFlag = (reason) => {
      const emu = window.EJS_emulator;
      const mod = emu?.gameManager?.Module;
      if (emu) emu.paused = false;
      if (!mod?._cmd_unpause && !mod?._toggleMainLoop && !mod?._platform_emscripten_update_window_hidden_cb)
        return !!emu;
      try {
        // RetroArch derives focus from platform_emscripten_is_window_hidden().
        // iOS can miss or delay the internal visibility callback when returning
        // from the app switcher, leaving RetroArch in RUNLOOP_FLAG_PAUSED even
        // though document.hidden is false.
        mod._platform_emscripten_update_window_hidden_cb?.(0);
        mod._toggleMainLoop?.(1);
        _forceRetroArchUnpause(mod, reason);
        // Manual-mode rAF chain can break silently: when EJS_PAUSED is set
        // mid-frame, emscripten_mainloop calls emscripten_pause_main_loop()
        // and returns without scheduling next rAF, so our overrideRAF never
        // re-captures and _pendingRunner stays null. toggleMainLoop(1) only
        // resumes if EJS_MAINLOOP_PAUSED is true at that moment, which can
        // miss this case (e.g., toolbar/popover clicks that briefly toggled
        // EJS pause). Force-recapture so the next stepOneFrame() runs.
        if (_manualMode && !_pendingRunner) {
          recaptureManualRunner(mod, `unpause-no-runner:${reason}`);
        }
        _syncLog(`emulator foreground/pause state refreshed on ${reason}`);
        return true;
      } catch (e) {
        _syncLog(`emulator foreground/pause refresh failed on ${reason}: ${e?.name || 'Error'}: ${e?.message || e}`);
        return false;
      }
    };

    const _clearEjsPauseFlagWithRetries = (reason, { guardInput = true } = {}) => {
      if (guardInput) {
        _resumeInputGuardUntil = Math.max(_resumeInputGuardUntil, performance.now() + EJS_RESUME_INPUT_GUARD_MS);
      }
      _clearEjsPauseFlag(reason);
      for (const delay of EJS_PAUSE_CLEAR_RETRY_DELAYS_MS) {
        setTimeout(() => {
          if (_phase !== PHASE_RUNNING) return;
          if (typeof document !== 'undefined' && document.hidden) return;
          _clearEjsPauseFlag(`${reason}+${delay}ms`);
        }, delay);
      }
    };

    // Background tab handling: do NOT pause the tick loop. Browser naturally
    // throttles setInterval to ~1fps in background tabs, which keeps the
    // player sending input (slowly). Pausing completely breaks multi-tab
    // setups where one tab is always document.hidden.
    //
    // On return to foreground: fast-forward frame counter to catch up with
    // peers, then resync emulator state from host.
    let _backgroundAt = 0;
    const _requestLifecycleFullResync = (reason) => {
      // Fast-forward _frameNum to catch up with peers. Background throttling
      // means we fell behind — peers have moved far ahead.
      // BF2: during boot convergence, this skips the 300-frame pure-lockstep
      // window that would take 5+ minutes at background-throttled 1fps.
      if (_lastRemoteFrame > _frameNum) {
        const wasBoot = _rbInitFrame >= 0 && _frameNum - _rbInitFrame <= 300;
        _syncLog(`fast-forward: ${_frameNum} -> ${_lastRemoteFrame}${wasBoot ? ' (boot-skip)' : ''}`);
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
        _beginLifecycleResyncGuard(reason);
        _resyncRequestInFlight = false; // override — lifecycle resync always wins
        _syncTargetFrame = -1; // cancel any pending coord target — lifecycle return needs immediate sync
        _syncTargetDeadlineAt = 0;
        const sentSocket = _requestSocketFullResync(reason);
        const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
        if (!sentSocket && hostPeer?.dc?.readyState === 'open') {
          try {
            _resyncRequestInFlight = true;
            hostPeer.dc.send('sync-request-full');
            _syncLog(`${reason}: sent sync-request-full to host over DC fallback`);
          } catch (_) {
            _resyncRequestInFlight = false;
          }
        }
      }
    };

    _visChangeHandler = () => {
      if (_phase !== PHASE_RUNNING) return;
      if (document.hidden) {
        _backgroundAt = Date.now();
        _releaseLocalFocusInput();
        _clearEjsPauseFlag('tab hidden');
        _syncLog(`tab hidden at frame ${_frameNum}`);
        // BF2: warn user if tab goes hidden during boot convergence
        const inBoot = (_rbInitFrame >= 0 && _frameNum - _rbInitFrame <= BOOT_GRACE_FRAMES) || !_inGameplay;
        if (inBoot) {
          window.knShowToast?.('Game is backgrounded \u2014 switch to this tab to continue', 'warn');
        }
      } else {
        const bgDuration = _backgroundAt ? Date.now() - _backgroundAt : 0;
        _backgroundAt = 0;
        _releaseLocalFocusInput();
        _clearEjsPauseFlagWithRetries('tab visible');
        _syncLog(`tab visible (was background ${bgDuration} ms)`);

        // BF6: resume AudioContext on visibility return — browsers suspend
        // AudioContext when tab is hidden, and it won't auto-resume.
        if (_audio?.ctx?.state && _audio.ctx.state !== 'running') {
          _audio.ensureRunning?.('visibility-return');
          _syncLog(`audio context resume requested on tab return (state=${_audio.ctx.state})`);
        }
        // Also resume EJS AudioContext if accessible
        const ejsAudioCtx = window.EJS_emulator?.audioContext;
        if (ejsAudioCtx?.state === 'suspended') {
          ejsAudioCtx.resume().catch(() => {});
        }

        // Short background (<500ms): no action needed (audio resume above still fires)
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

        _requestLifecycleFullResync('bg-return');
      }
    };
    document.addEventListener('visibilitychange', _visChangeHandler);

    // Focus/blur tracking: document.hasFocus() gates gamepad reads, so
    // losing focus silently zeroes input. Log transitions so session logs
    // show exactly when input capture stopped/resumed.
    _focusHandler = () => {
      if (_phase === PHASE_RUNNING) {
        _restoreControlsFocus('focus');
        _clearEjsPauseFlagWithRetries('focus');
        _syncLog(`TAB-FOCUS gained f=${_frameNum}`);
      }
    };
    _blurHandler = () => {
      if (_phase === PHASE_RUNNING) {
        _releaseLocalFocusInput();
        _markControlsFocusLost();
        _syncLog(`TAB-FOCUS lost f=${_frameNum}`);
      }
    };
    window.addEventListener('focus', _focusHandler);
    window.addEventListener('blur', _blurHandler);

    _focusRestoreHandler = (event) => {
      if (_phase !== PHASE_RUNNING) return;
      if (event?.target?.closest?.('#virtual-gamepad')) {
        const hadControlsFocusLost = _controlsFocusLost;
        if (hadControlsFocusLost) {
          _controlsFocusLost = false;
          setStatus('Connected -- game on!');
          _syncLog(`TAB-FOCUS recovered via virtual-gamepad f=${_frameNum}`);
        }
        if (hadControlsFocusLost || window.EJS_emulator?.paused) {
          _clearEjsPauseFlagWithRetries(event?.type || 'virtual-gamepad', { guardInput: false });
        }
        return;
      }
      _restoreControlsFocus(event?.type || 'pointer');
      _clearEjsPauseFlagWithRetries(event?.type || 'pointer');
    };
    document.addEventListener('pointerdown', _focusRestoreHandler, true);
    document.addEventListener('touchstart', _focusRestoreHandler, true);

    _pageHideHandler = (event) => {
      if (_phase !== PHASE_RUNNING) return;
      _backgroundAt = Date.now();
      _releaseLocalFocusInput();
      _clearEjsPauseFlag('pagehide');
      _syncLog(`pagehide at frame ${_frameNum} persisted=${!!event?.persisted}`);
    };
    _pageShowHandler = (event) => {
      if (_phase !== PHASE_RUNNING) return;
      const bgDuration = _backgroundAt ? Date.now() - _backgroundAt : 0;
      _backgroundAt = 0;
      _releaseLocalFocusInput();
      _clearEjsPauseFlagWithRetries('pageshow');
      _syncLog(`pageshow at frame ${_frameNum} persisted=${!!event?.persisted} backgroundMs=${bgDuration}`);
      if (bgDuration >= 500) {
        if (_playerSlot !== 0) {
          _setLastSyncState(null, 'pageshow');
        }
        _requestLifecycleFullResync('pageshow');
      }
    };
    window.addEventListener('pagehide', _pageHideHandler);
    window.addEventListener('pageshow', _pageShowHandler);

    // Network change detection: mobile WiFi↔cellular switches cause desync.
    // Request a FULL (non-delta) resync when the network path changes.
    _networkChangeHandler = () => {
      if (_phase !== PHASE_RUNNING) return;
      _syncLog('network change detected — requesting full resync');
      if (_playerSlot !== 0) {
        _setLastSyncState(null, 'network-change');
        _lastResyncTime = 0; // clear cooldown
        _resyncRequestInFlight = false; // override — network change resync always wins
        _syncTargetFrame = -1; // cancel any pending coord target — network path changed, immediate sync needed
        _syncTargetDeadlineAt = 0;
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

    // WebKit rounds setInterval(16) up to ~20ms in foreground tabs, which
    // forces the JSC peer to run at ~50fps and makes faster peers throttle
    // down. Pump more frequently, but advance at most one simulation frame
    // per 60Hz deadline so the game cadence stays correct.
    _tickNextAt = performance.now() + TICK_TARGET_MS;
    _tickInterval = setInterval(() => {
      if (_phase !== PHASE_RUNNING) return;
      if (_externalTickPaused) return;
      const now = performance.now();
      if (now + 0.25 < _tickNextAt) return;
      tick();
      const after = performance.now();
      _tickNextAt += TICK_TARGET_MS;
      if (after - _tickNextAt > TICK_TARGET_MS * 4) {
        _tickNextAt = after + TICK_TARGET_MS;
      }
    }, TICK_PUMP_INTERVAL_MS);
    _syncLog(`tick scheduler target=${TICK_TARGET_MS.toFixed(2)}ms pump=${TICK_PUMP_INTERVAL_MS}ms`);

    // Live RTT probe — runs every 5s to catch latency spikes (e.g. 5G jitter).
    // Delay is fixed for the session — no live RTT probes.
  };

  const stopSync = () => {
    _phase = PHASE_STOPPED;
    _runSubstate = RUN_NORMAL;
    _checkStateTransition();
    window._lockstepActive = false;
    _resyncRequestInFlight = false;
    _lastAppliedSyncHostFrame = -1;

    // Re-enable RSP audio DRAM writes
    const stopMod = window.EJS_emulator?.gameManager?.Module;
    // Pause before restoring native rAF. In manual mode, Emscripten still
    // thinks its main loop is resumed, but its runner is captured by the rAF
    // interceptor. Restoring native rAF while resumed can leave a stale runner
    // plus the next streaming resume loop alive at once.
    if (_manualMode && stopMod?.pauseMainLoop) {
      try {
        stopMod.pauseMainLoop();
        _syncLog('paused EJS main loop before restoring native rAF');
      } catch (e) {
        _syncLog(`pause before rAF restore failed: ${e?.message || e}`);
      }
    }
    if (stopMod?._kn_set_headless) {
      stopMod._kn_set_headless(0);
      _rbFullHeadlessActive = false;
    }
    if (stopMod?._kn_set_skip_rdp_replay) {
      stopMod._kn_set_skip_rdp_replay(0);
      _rbRdpSkipActive = false;
    }
    if (stopMod?._kn_set_skip_rsp_audio) stopMod._kn_set_skip_rsp_audio(0);
    _resetControllerPresentMask();
    _destroyRollbackVisualFreeze();

    // Shutdown C-level rollback
    if (_useCRollback) {
      if (stopMod?._kn_rollback_shutdown) stopMod._kn_rollback_shutdown();
      if (_rbInputPtr && stopMod?._free) {
        stopMod._free(_rbInputPtr);
        _rbInputPtr = 0;
      }
      if (_rbRegionsBufPtr && stopMod?._free) {
        stopMod._free(_rbRegionsBufPtr);
        _rbRegionsBufPtr = 0;
      }
      _useCRollback = false;
      _inGameplay = false;
    }
    // Free auxiliary WASM scratch buffers regardless of _useCRollback —
    // they may have been allocated lazily during prior rollback ticks.
    // Without this, EmulatorJS destroy/recreate leaves stale offsets
    // pointing into a freshly initialized WASM heap.
    if (stopMod?._free) {
      if (_rbFatalBuf) {
        stopMod._free(_rbFatalBuf);
        _rbFatalBuf = 0;
      }
      if (_rbLiveMismatchBuf) {
        stopMod._free(_rbLiveMismatchBuf);
        _rbLiveMismatchBuf = 0;
      }
      if (_rbHashBufPtr) {
        stopMod._free(_rbHashBufPtr);
        _rbHashBufPtr = 0;
      }
      if (_rbTaintBufPtr) {
        stopMod._free(_rbTaintBufPtr);
        _rbTaintBufPtr = 0;
      }
      if (window._rbMispredBuf) {
        stopMod._free(window._rbMispredBuf);
        window._rbMispredBuf = 0;
      }
    } else {
      // No WASM module available (already destroyed) — drop the JS-side
      // offsets so we don't reuse them against a future fresh heap.
      _rbFatalBuf = 0;
      _rbLiveMismatchBuf = 0;
      _rbHashBufPtr = 0;
      _rbTaintBufPtr = 0;
      window._rbMispredBuf = 0;
    }
    // Always clear the SR-deferred init closure, even when _useCRollback was
    // never set (SR match ended before MENU→GAMEPLAY fired). Without this, a
    // subsequent non-SR match's f=0 MENU→GAMEPLAY block fires the stale
    // closure and double-calls _kn_rollback_init, breaking GL/main-loop state.
    window._rbDeferredForGameplay = null;
    _rbReinitClosure = null;
    // Clear host-broadcast init params so a back-to-back match doesn't fire
    // its tryInitRollback with stale values from the previous match's host
    // before the new rb-delay/rb-init-frame broadcasts arrive.
    window._rbHostDelay = undefined;
    window._rbHostInitFrame = undefined;
    window._rbPendingInit = false;
    window._rbPendingInitAt = 0;

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
      if (mod?._kn_set_normalize_events) mod._kn_set_normalize_events(0);
      if (mod?._kn_set_drain_interrupts) mod._kn_set_drain_interrupts(0);
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
    if (_focusHandler) {
      window.removeEventListener('focus', _focusHandler);
      _focusHandler = null;
    }
    if (_blurHandler) {
      window.removeEventListener('blur', _blurHandler);
      _blurHandler = null;
    }
    if (_focusRestoreHandler) {
      document.removeEventListener('pointerdown', _focusRestoreHandler, true);
      document.removeEventListener('touchstart', _focusRestoreHandler, true);
      _focusRestoreHandler = null;
    }
    _controlsFocusLost = false;
    if (_pageHideHandler) {
      window.removeEventListener('pagehide', _pageHideHandler);
      _pageHideHandler = null;
    }
    if (_pageShowHandler) {
      window.removeEventListener('pageshow', _pageShowHandler);
      _pageShowHandler = null;
    }
    if (_tickInterval !== null) {
      clearInterval(_tickInterval);
      _tickInterval = null;
    }
    _tickNextAt = 0;
    if (window._knTickDeltas) window._knTickDeltas.length = 0;
    window._knLastTickWall = 0;
    // Restore rAF if we intercepted it (other overrides restored in stop())
    if (_manualMode) {
      APISandbox.restoreAll();
      // Restore EJS / gameManager / WASM pause overrides installed in
      // enterManualMode. Match the install order so any chained restore
      // unwinds cleanly even if some refs were never patched.
      const ejs = window.EJS_emulator;
      const gm = ejs?.gameManager;
      const mod = gm?.Module;
      if (gm?._knOriginalToggleMainLoop) {
        gm.toggleMainLoop = gm._knOriginalToggleMainLoop;
        delete gm._knOriginalToggleMainLoop;
      }
      if (ejs?._knOriginalPause) {
        ejs.pause = ejs._knOriginalPause;
        ejs.togglePlaying = ejs._knOriginalTogglePlaying;
        delete ejs._knOriginalPause;
        delete ejs._knOriginalTogglePlaying;
      }
      if (mod?._knOriginalCmdPause) {
        mod._cmd_pause = mod._knOriginalCmdPause;
        delete mod._knOriginalCmdPause;
      }
      if (mod?._knOriginalCmdTogglePause) {
        mod._cmd_toggle_pause = mod._knOriginalCmdTogglePause;
        delete mod._knOriginalCmdTogglePause;
      }
    }
    _manualMode = false;
    _pendingRunner = null;
    _setLastSyncState(null, 'stopSync');
    _pendingLateJoinPeerSids.clear();
    _pendingLateJoinPeerSlots.clear();
    _lateJoinActivatedAtFrame = {};
    _lateJoinInputBootstrapUntilFrame = -1;
    _lateJoinSeededInputFrames = {};
    // Free C-level sync buffers
    if (_syncBufPtr && _hasKnSync) {
      const modStop = window.EJS_emulator?.gameManager?.Module;
      if (modStop?._free) {
        modStop._free(_syncBufPtr);
      }
      _syncBufPtr = 0;
    }
    _hasKnSync = false;
    _frameAdvantage = 0;
    _frameAdvRaw = 0;
    if (_runSubstate === RUN_PACING) _runSubstate = RUN_NORMAL;
    _pacingThrottleStartAt = 0;
    _pacingCapsCount = 0;
    _pacingCapsFrames = 0;
    _pacingMaxAdv = 0;
    _pacingAdvSum = 0;
    _pacingAdvCount = 0;
    _pacingSkipCounter = 0;
    _pacingLastLogAt = 0;
    _pacingSuppressedLogs = 0;
    _lastPacingStateLogAt = 0;
    // Remove diagnostic hooks (delegated to kn-diagnostics.js)
    _diag?.cleanup();
  };

  const tick = () => {
    if (_phase !== PHASE_RUNNING) return;
    _checkStateTransition();

    // MF6: Detection-only watchdog. Logs TICK-STUCK with a rich
    // diagnostic snapshot when the frame counter has not advanced
    // for longer than the warn / error thresholds. Takes NO recovery
    // action — the user still sees the freeze, and the fix belongs
    // in whichever MF category covers the root cause. Skipped while
    // _lateJoinPaused or document.hidden (both are legitimate
    // pauses). See docs/netplay-invariants.md.
    const _tickNow = performance.now();
    if (_runSubstate !== RUN_LATE_JOIN_PAUSE && !(typeof document !== 'undefined' && document.hidden)) {
      if (_frameNum !== _tickStuckLastFrame) {
        _tickStuckLastFrame = _frameNum;
        _tickStuckLastAdvanceAt = _tickNow;
        _tickStuckWarnFired = false;
        _tickStuckErrorFired = false;
      } else if (_tickStuckLastAdvanceAt > 0) {
        const _stuckMs = _tickNow - _tickStuckLastAdvanceAt;
        if (_stuckMs > TICK_STUCK_ERROR_MS && !_tickStuckErrorFired) {
          _tickStuckErrorFired = true;
          _emitTickStuckSnapshot('error', _stuckMs);
        } else if (_stuckMs > TICK_STUCK_WARN_MS && !_tickStuckWarnFired) {
          _tickStuckWarnFired = true;
          _emitTickStuckSnapshot('warn', _stuckMs);
        }
      }
    }

    if (_runSubstate === RUN_LATE_JOIN_PAUSE) return; // frozen while late-joiner loads state
    // Guests defer the entire tick loop until the host's authoritative
    // rb-delay broadcast arrives and the C rollback engine is initialized
    // with the agreed delay. Without this, the guest would advance frames
    // 0..N in pure-lockstep mode, then the C engine would init at frame 0
    // (its internal counter), and JS would jump backwards from frame N to
    // frame 0 — corrupting input ring frame tags and the rollback ring.
    //
    // I1 (MF2): the stall is bounded by RB_INIT_TIMEOUT_MS. If the
    // host's rb-delay DC broadcast never arrives (DC died before
    // send, host crashed, message lost), fall back to a locally
    // computed delay so the guest does not freeze forever. The next
    // hash mismatch → resync converges both peers if the fallback
    // delay differs from what the host would have broadcast.
    // See docs/netplay-invariants.md §I1 and spec §MF2.
    if (window._rbPendingInit) {
      const _rbPendingStart = window._rbPendingInitAt || 0;
      if (_rbPendingStart > 0 && performance.now() - _rbPendingStart > RB_INIT_TIMEOUT_MS) {
        const _rbFallbackDelay = clampRollbackDelay(DELAY_FRAMES, ROLLBACK_MIN_DELAY_FRAMES);
        const _haveDelay = window._rbHostDelay !== undefined && window._rbHostDelay > 0;
        const _haveInitFrame = window._rbHostInitFrame !== undefined;
        const _missing = (!_haveDelay ? 'rb-delay ' : '') + (!_haveInitFrame ? 'rb-init-frame' : '');
        _syncLog(
          `RB-INIT-TIMEOUT elapsed=${Math.round(performance.now() - _rbPendingStart)}ms — ` +
            `host ${_missing.trim() || 'broadcast'} never arrived, falling back to local delay=${_rbFallbackDelay} initFrame=${_frameNum}`,
        );
        window._rbPendingInit = false;
        window._rbPendingInitAt = 0;
        if (window._rbDoInit) {
          try {
            // No initFrameOverride: fall back to local _frameNum. Hash
            // mismatch + resync below converges both peers if local frames
            // diverged from host's intended init frame.
            window._rbDoInit(_rbFallbackDelay);
          } catch (e) {
            _syncLog(`RB-INIT-TIMEOUT fallback init failed: ${e}`);
          }
        }
      } else {
        return;
      }
    }

    // Async resync: apply buffered state at clean frame boundary.
    // Coordinated injection: hold state until _syncTargetFrame so host and guest
    // both reach that frame before the state is applied — snap = 0.
    //
    // I1 (MF3): every coord-sync target has a wall-clock deadline
    // (_syncTargetDeadlineAt). If frame pacing prevents reaching
    // _syncTargetFrame before the deadline, drop the target — the
    // block below will then apply any _pendingResyncState
    // immediately at current frame (non-coordinated branch). This
    // closes the frame-target-unreachable deadlock class from room
    // 1Q6ZF7N6. See docs/netplay-invariants.md §I1 and spec §MF3.
    if (_syncTargetFrame > 0 && _syncTargetDeadlineAt > 0 && performance.now() > _syncTargetDeadlineAt) {
      const _coordElapsed = Math.round(performance.now() - (_syncTargetDeadlineAt - SYNC_COORD_TIMEOUT_MS));
      _syncLog(
        `COORD-SYNC-TIMEOUT target=${_syncTargetFrame} f=${_frameNum} ` +
          `elapsed=${_coordElapsed}ms pendingState=${!!_pendingResyncState} — ` +
          `dropping target, applying at current frame`,
      );
      _syncTargetFrame = -1;
      _syncTargetDeadlineAt = 0;
      if (_runSubstate === RUN_AWAITING_RESYNC) _runSubstate = RUN_NORMAL;
    }

    if (_syncTargetFrame > 0) {
      if (_frameNum >= _syncTargetFrame) {
        if (_pendingResyncState) {
          // State arrived on time — apply at the agreed frame
          const pending = _pendingResyncState;
          _pendingResyncState = null;
          if (_runSubstate === RUN_AWAITING_RESYNC) _runSubstate = RUN_NORMAL;
          _syncTargetFrame = -1;
          _syncTargetDeadlineAt = 0;
          applySyncState(pending.bytes, pending.frame, pending.fromProactive);
        } else if (_runSubstate !== RUN_AWAITING_RESYNC) {
          // Reached target frame but state not here yet — stall until it arrives
          _runSubstate = RUN_AWAITING_RESYNC;
          _awaitingResyncAt = performance.now();
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
      if (_runSubstate === RUN_AWAITING_RESYNC) _runSubstate = RUN_NORMAL;
      applySyncState(pending.bytes, pending.frame, pending.fromProactive);
    }

    // ── Rollback-mode peer stall freeze ─────────────────────────────────
    // Pacing decisions (stall, safety freeze, soft throttle) skip frame
    // advance but must NOT skip input send — otherwise both peers starve
    // each other and deadlock. Set this flag, send inputs, then check it.
    let _skipFrameAdvance = false;
    const activePeers = getActivePeers();
    _broadcastPhaseIfNeeded(_tickNow);
    const menuStartBarrier = updateMenuStartBarrier(activePeers, _tickNow);
    const menuStartBarrierPending = _isSmashRemix() && !_menuStartBarrierReleased;
    if (menuStartBarrier.freezeFrame) {
      _skipFrameAdvance = true;
    }

    // If any input peer hasn't advanced for ROLLBACK_STALL_MS, freeze the
    // local simulation instead of predicting forward. This is essentially
    // "lockstep stall, but only when rollback prediction would be hopeless"
    // — rollback still handles normal jitter invisibly, but a prolonged
    // network hiccup (WiFi roaming between APs, NAT rebind, radio loss)
    // converts what would be cascading-rollback catastrophe into a brief
    // freeze that feels like a stall and recovers cleanly when inputs
    // return. Threshold is well below PEER_DEAD_MS (5s) so we catch the
    // problem before pacing throttle + ring overflow spiral starts.
    //
    // Skipped outside rollback mode (lockstep handles missing input via
    // its own mechanism) and during warmup.
    if (_useCRollback && !menuStartBarrierPending && _frameNum >= FRAME_PACING_WARMUP) {
      const nowStall = performance.now();
      const stallPeers = getInputPeers();
      for (const p of stallPeers) {
        if (_peerPhantom[p.slot]) continue;
        const last = _peerLastAdvanceTime[p.slot];
        if (last === undefined) continue;
        const stale = nowStall - last;
        if (stale >= ROLLBACK_STALL_MS) {
          if (_runSubstate !== RUN_RB_STALL) {
            _runSubstate = RUN_RB_STALL;
            _rollbackStallStart = nowStall;
            _syncLog(
              `ROLLBACK-STALL start slot=${p.slot} staleMs=${stale.toFixed(0)} — freezing sim until input returns`,
            );
          }
          _skipFrameAdvance = true;
          break;
        }
      }
      // Release stall only if no peer triggered it this frame.
      // (If the for-loop broke out after setting _skipFrameAdvance, a peer
      // IS stalled and we must NOT release.)
      if (_runSubstate === RUN_RB_STALL && !_skipFrameAdvance) {
        const stallDuration = nowStall - _rollbackStallStart;
        if (_runSubstate === RUN_RB_STALL) _runSubstate = RUN_NORMAL;
        _rollbackStallStart = 0;
        _syncLog(`ROLLBACK-STALL end durationMs=${stallDuration.toFixed(0)}`);
      }
    }

    // ── Frame pacing (GGPO-style frame advantage cap) ────────────────────
    // Prevents the faster machine from outrunning the slower one's input stream.
    // Skip during warmup — connection is still stabilizing.
    if (!menuStartBarrierPending && _frameNum >= FRAME_PACING_WARMUP) {
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
        if (activePacingPeers === 0 && _runSubstate === RUN_PACING) {
          if (_runSubstate === RUN_PACING) _runSubstate = RUN_NORMAL;
          _pacingThrottleStartAt = 0;
          if (window._knLastPhantomReleaseFrame !== _frameNum) {
            window._knLastPhantomReleaseFrame = _frameNum;
            _syncLog('PACING-THROTTLE released — all peers phantom');
          }
        }
        if (activePacingPeers > 0 && minRemoteFrame >= 0) {
          _frameAdvRaw = _frameNum - minRemoteFrame;

          // ── GGPO safety freeze ────────────────────────────────────────
          // Hard cap: never advance past rollbackMax - 2 frames ahead of
          // the oldest confirmed remote input. This makes DEEP-MISPREDICT-
          // SKIP and FAILED-ROLLBACK unreachable — any misprediction will
          // always have a valid ring slot to restore from. The -2 margin
          // accounts for the 1-frame pipeline delay between detecting a
          // misprediction and acting on it in kn_pre_tick.
          //
          // This fires BEFORE the soft proportional throttle below.
          // On good networks it never triggers (soft throttle keeps
          // advantage at delay+1..2). On bad WiFi it causes a brief
          // freeze instead of a permanent desync.
          // Skip safety freeze during initial boot convergence (first 300
          // frames after rollback init). During boot, both emulators run ~120
          // frames independently before input exchange begins — the host can
          // race 100+ frames ahead, which would permanently trigger the freeze
          // even though the input pipeline hasn't converged yet.
          // BF4: reduced from 300 to 120 — N64 boot sequence stabilizes by ~120 frames.
          // Matches BOOT_GRACE_FRAMES and MIN_BOOT_FRAMES constants.
          const _rbConverged = _rbInitFrame >= 0 && _frameNum - _rbInitFrame > BOOT_GRACE_FRAMES && _inGameplay;
          if (_rbConverged && !_rbConvergedLogged) {
            _rbConvergedLogged = true;
            _syncLog(
              `PACING-CONVERGED f=${_frameNum} initF=${_rbInitFrame} fAdv=${_frameAdvRaw} rbMax=${_rbRollbackMax}`,
            );
          }
          if (!_useCRollback) {
            if (_rbConverged && _frameAdvRaw >= _rbRollbackMax - 2) {
              if (_runSubstate !== RUN_PACING) {
                _runSubstate = RUN_PACING;
                _pacingThrottleStartAt = nowPacing;
                _pacingCapsCount++;
                _syncLog(
                  `PACING-SAFETY-FREEZE fAdv=${_frameAdvRaw} rbMax=${_rbRollbackMax} minRemote=${minRemoteFrame} — skipping frame advance (inputs still sent)`,
                );
              }
              _pacingCapsFrames++;
              _skipFrameAdvance = true;
            }
          }

          const alpha = _frameAdvRaw > _frameAdvantage ? FRAME_ADV_ALPHA_UP : FRAME_ADV_ALPHA_DOWN;
          _frameAdvantage = _frameAdvantage * (1 - alpha) + _frameAdvRaw * alpha;

          _pacingAdvSum += _frameAdvantage;
          _pacingAdvCount++;
          if (_frameAdvantage > _pacingMaxAdv) _pacingMaxAdv = _frameAdvantage;

          if (!_useCRollback) {
            const excess = _rbConverged ? _frameAdvRaw - DELAY_FRAMES : -1;
            let shouldSkip = false;
            if (excess >= 3) {
              shouldSkip = true;
            } else if (excess >= 2) {
              _pacingSkipCounter++;
              shouldSkip = (_pacingSkipCounter & 1) === 0;
            }
            if (shouldSkip) {
              _pacingCapsFrames++;
              if (_runSubstate !== RUN_PACING) {
                _runSubstate = RUN_PACING;
                _pacingThrottleStartAt = nowPacing;
                _pacingCapsCount++;
                const ratio = excess >= 2 ? '100%' : '50%';
                _logPacing(
                  `PACING-THROTTLE start fAdv=${_frameAdvRaw} ratio=${ratio} smooth=${_frameAdvantage.toFixed(1)} delay=${DELAY_FRAMES} minRemote=${minRemoteFrame}`,
                );
              }
              _skipFrameAdvance = true;
            }
            if (_runSubstate === RUN_PACING && !_skipFrameAdvance) {
              if (_runSubstate === RUN_PACING) _runSubstate = RUN_NORMAL;
              _pacingThrottleStartAt = 0;
              _logPacing(`PACING-THROTTLE end fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)}`);
            }
          }

          // ── I1: Pacing throttle wall-clock deadline ────────────────────
          // If the throttle has been continuously active for longer than
          // PACING_THROTTLE_TIMEOUT_MS, the slowest peer's inputs have
          // stopped arriving (DC died, peer crashed, Safari suspended JS).
          // Force-mark the slowest peer as phantom to release pacing.
          // Without this, a dead DC + broken phantom detection = permanent
          // freeze (match f0566d95: host stuck at f=187 for 41s until
          // Socket.IO heartbeat timeout disconnected it).
          if (_runSubstate === RUN_PACING && _pacingThrottleStartAt > 0) {
            const _pacingStallMs = nowPacing - _pacingThrottleStartAt;
            if (_pacingStallMs >= PACING_THROTTLE_TIMEOUT_MS) {
              // Find the peer holding minRemoteFrame and force-phantom it
              let slowestSlot = -1;
              for (const p of inputPeersForPacing) {
                if (_peerPhantom[p.slot]) continue;
                const rf = _lastRemoteFramePerSlot[p.slot] ?? -1;
                if (rf === minRemoteFrame) {
                  slowestSlot = p.slot;
                  break;
                }
              }
              _syncLog(
                `PACING-THROTTLE-TIMEOUT f=${_frameNum} stalledMs=${Math.round(_pacingStallMs)} ` +
                  `slowestSlot=${slowestSlot} minRemote=${minRemoteFrame} fAdv=${_frameAdvRaw} — ` +
                  `force-releasing pacing (I1 deadline)`,
              );
              if (slowestSlot >= 0) {
                _peerPhantom[slowestSlot] = true;
                _syncLog(
                  `PEER-PHANTOM slot=${slowestSlot} reason=pacing-timeout stalledMs=${Math.round(_pacingStallMs)} — excluded from pacing`,
                );
                window.dispatchEvent(new CustomEvent('kn-peer-phantom', { detail: { slot: slowestSlot } }));
              }
              if (_runSubstate === RUN_PACING) _runSubstate = RUN_NORMAL;
              _pacingThrottleStartAt = 0;
              _skipFrameAdvance = false;
            }
          }
        }
      }
    }

    // FPS counter
    _fpsFrameCount++;
    const now = performance.now();
    if (now - _fpsLastTime >= 1000) {
      _fpsCurrent = _fpsFrameCount;
      _fpsFrameCount = 0;
      _fpsLastTime = now;
    }

    // Send local input for current frame to ALL open peer DCs.
    // Each packet includes an ack of the highest frame we've received from that peer.
    //
    // P2: GGPO-style ack-driven redundancy. Every packet carries all
    // unconfirmed inputs (from the peer's last ACK to _frameNum - 1).
    // This guarantees recovery from arbitrary packet loss bursts — even
    // if N packets drop in a row, the (N+1)-th carries the full backlog.
    if (_lateJoinInputBootstrapUntilFrame >= 0 && _frameNum >= _lateJoinInputBootstrapUntilFrame) {
      _syncLog(`late-join input bootstrap ended at f=${_frameNum}`);
      _lateJoinInputBootstrapUntilFrame = -1;
    }
    const suppressLateJoinBootstrapInput =
      _lateJoinInputBootstrapUntilFrame >= 0 && _frameNum < _lateJoinInputBootstrapUntilFrame;
    const suppressEjsPausedInput = !!window.EJS_emulator?.paused;
    const nowInput = performance.now();
    const lifecycleGuardTimedOut =
      _lifecycleResyncPending && nowInput - _lifecycleResyncStartedAt >= LIFECYCLE_RESYNC_PENDING_TIMEOUT_MS;
    if (lifecycleGuardTimedOut) {
      _clearLifecycleResyncGuard('lifecycle resync guard timeout');
      _resyncRequestInFlight = false;
    }
    const suppressResumeGuardInput = nowInput < _resumeInputGuardUntil || _lifecycleResyncPending;
    if ((suppressEjsPausedInput || suppressResumeGuardInput) && _frameNum % 60 === 0) {
      _syncLog(
        `local input suppressed during emulator resume f=${_frameNum} ` +
          `ejsPaused=${suppressEjsPausedInput} guard=${suppressResumeGuardInput} lifecycle=${_lifecycleResyncPending}`,
      );
    }
    const hadLocalInputForFrame = Object.prototype.hasOwnProperty.call(_localInputs, _frameNum);
    const localInput = hadLocalInputForFrame
      ? _localInputs[_frameNum]
      : _cloneInput(
          menuStartBarrier.suppressInput ||
            suppressLateJoinBootstrapInput ||
            suppressEjsPausedInput ||
            suppressResumeGuardInput
            ? KNShared.ZERO_INPUT
            : readLocalInput(),
        );
    if (!hadLocalInputForFrame) {
      _localInputs[_frameNum] = localInput;
      _auditRecordLocal(_frameNum, localInput);
      // Append to history ring once per logical frame. If the sim stalls on
      // this frame, resend the cached input below without mutating history.
      _rbLocalHistory.push({
        frame: _frameNum,
        buttons: localInput.buttons,
        lx: localInput.lx,
        ly: localInput.ly,
        cx: localInput.cx,
        cy: localInput.cy,
      });
    }
    const shouldSendRedundancy = _useCRollback && _rbTransport === 'unreliable';
    let minPeerAck = _frameNum; // conservative: assume all acked up to now
    if (shouldSendRedundancy) {
      for (const p of activePeers) {
        const ack = p.lastAckFromPeer ?? -1;
        if (ack < minPeerAck) minPeerAck = ack;
      }
    }
    // Trim: keep everything after minPeerAck (peer hasn't confirmed these),
    // but never more than RB_REDUNDANCY_MAX to bound packet size.
    while (
      _rbLocalHistory.length > 0 &&
      (_rbLocalHistory[0].frame <= minPeerAck || _rbLocalHistory.length > RB_REDUNDANCY_MAX)
    ) {
      _rbLocalHistory.shift();
    }
    // Tail excludes the current frame (it's already in the packet header).
    // Build lazily so reliable-only sends don't pay for Array.slice().
    let redundantTail = null;
    let _sendFails = 0;
    for (let i = 0; i < activePeers.length; i++) {
      const peer = activePeers[i];
      if (peer.synthetic === true) continue;
      try {
        const ackFrame = peer.lastFrameFromPeer ?? -1;
        const needsRedundancy = shouldSendRedundancy && (peer.lastAckFromPeer ?? -1) < _frameNum - 1;
        if (needsRedundancy && redundantTail === null) {
          redundantTail = _rbLocalHistory.slice(0, _rbLocalHistory.length - 1);
        }
        const peerBuf = KNShared.encodeInput(
          _frameNum,
          localInput,
          ackFrame,
          needsRedundancy ? redundantTail : null,
        ).buffer;
        // Use unreliable rb-input DC when available, fall back to primary DC
        const inputDc =
          _rbTransport === 'unreliable' && peer.rbDc?.readyState === 'open' && peer.rbDcUnreliable
            ? peer.rbDc
            : peer.dc;
        if (inputDc?.readyState === 'open') {
          inputDc.send(peerBuf);
          _rbTransportPacketsSent++;
          // Initialize ack tracking on first send to avoid false positive
          if (!peer.lastAckAdvanceTime) peer.lastAckAdvanceTime = performance.now();
        } else {
          _sendFails++;
        }
      } catch (_) {
        _sendFails++;
      }
    }

    // ── DC health monitor: detect stuck unreliable DC, fall back immediately ──
    // iOS Safari's SCTP bug affects ALL unordered streams on the association,
    // so DC rotation doesn't help — new streams die too. Instead, detect the
    // failure and switch to the reliable primary DC immediately. The GGPO
    // redundancy layer covers the brief gap (first reliable packet carries
    // all unACKed frames).
    if (_useCRollback && _rbTransport === 'unreliable') {
      const nowDc = performance.now();
      for (const [sid, peer] of Object.entries(_peers)) {
        if (_isPeerPendingLateJoin(sid, peer)) continue;
        if (!peer.rbDc || peer.rbDc.readyState !== 'open') continue;

        let shouldFallback = false;

        // Signal 1: bufferedAmount growth (local SCTP congestion)
        if (peer.rbDc.bufferedAmount > DC_BUFFER_THRESHOLD) {
          _dcBufferStaleStreak[sid] = (_dcBufferStaleStreak[sid] || 0) + 1;
          if (_dcBufferStaleStreak[sid] >= DC_BUFFER_STALE_FRAMES) {
            shouldFallback = true;
            _syncLog(`DC-FALLBACK reason=buffer sid=${sid} buffered=${peer.rbDc.bufferedAmount}`);
          }
        } else {
          _dcBufferStaleStreak[sid] = 0;
        }

        // Signal 2: ack staleness (remote silent drop)
        if (
          !shouldFallback &&
          peer.lastAckAdvanceTime &&
          nowDc - peer.lastAckAdvanceTime > DC_ACK_STALE_MS &&
          _frameNum > 60
        ) {
          shouldFallback = true;
          _syncLog(`DC-FALLBACK reason=ack-stale sid=${sid} staleMs=${(nowDc - peer.lastAckAdvanceTime).toFixed(0)}`);
        }

        if (shouldFallback) {
          _rbTransport = 'reliable';
          _syncLog('DC-FALLBACK: switched to reliable DC — inputs now via primary channel');
          // Reset ack tracking so peer isn't immediately marked phantom
          peer.lastAckAdvanceTime = nowDc;
        }
      }
    }

    // ── Pacing gate: skip frame advance but inputs were sent above ──────
    if (_skipFrameAdvance) return;

    // ── SR deferred-init hook ───────────────────────────────────────────
    // The MENU→GAMEPLAY transition logic that fires the deferred init
    // lives inside the `if (_useCRollback)` branch below — but for
    // Smash Remix we hold init back precisely so `_useCRollback` stays
    // false until gameplay starts (chicken-and-egg). Detect the gameplay
    // phase here so the closure can run, after which `_useCRollback` is
    // true and the rollback branch handles the rest of this tick normally.
    if (window._rbDeferredForGameplay) {
      const earlyPhase = _readMenuLockstepPhase(_frameNum > BOOT_GRACE_FRAMES);
      if (earlyPhase.gameplay) {
        const fn = window._rbDeferredForGameplay;
        window._rbDeferredForGameplay = null;
        _syncLog(
          `C-ROLLBACK firing deferred init at f=${_frameNum} ` +
            `gameStatus=${earlyPhase.gameStatus} scene=${earlyPhase.sceneCurr}`,
        );
        fn();
      }
    }

    // ── C-level rollback path ──────────────────────────────────────────
    // C manages: state ring buffer, input storage, prediction, misprediction detection
    // JS handles: all frame stepping (normal + replay) via writeInputToMemory + stepOneFrame
    //
    // Boot convergence: during the first 300 frames after rollback init,
    // fall through to the lockstep path (which stalls for remote input).
    // This prevents the boot race where both emulators predict through
    // ~120 boot frames independently and end up permanently desynced.
    // After convergence, the rollback path takes over with prediction.
    if (_useCRollback) {
      const tickMod = window.EJS_emulator?.gameManager?.Module;
      if (!tickMod?._kn_pre_tick) {
        _useCRollback = false;
        return;
      }

      // ── Hybrid input stall ───────────────────────────────────────────
      // Three modes, one goal: never let the local peer run so far ahead
      // that rollback can't correct a misprediction.
      //
      // BOOT (first BOOT_GRACE_FRAMES): pure lockstep stall — wait for
      // remote input before every frame. Prevents the boot race where
      // both emulators predict through boot frames and desync.
      //
      // STRICT MENU (Title/Mode Select/CSS/stage select/pause): pure
      // lockstep stall. Rollback's stash-and-restore only preserves
      // in-match gameplay state; menu navigation state lives outside
      // those bytes. A misprediction during menus can corrupt the setup
      // path, so we never fabricate inputs there.
      //
      // MATCH LOADING (scene=22, game_status=0): not a controllable menu.
      // It must not use the no-timeout menu stall path; a single missing
      // mobile frame at this transition would otherwise freeze both peers
      // before gameplay. Let rollback/pacing handle this phase.
      //
      // GAMEPLAY (game_status == 1, after BOOT_GRACE_FRAMES): let
      // rollback predict through the first few frames of missing input
      // (hides jitter). But if frame advantage exceeds DELAY_FRAMES + 4,
      // stall to wait — prevents runaway prediction → phantom →
      // disconnect. Rollback handles small gaps, lockstep stall handles
      // big ones.
      //
      // Late joiners skip boot convergence — they loaded the host's state
      // directly, no 120-frame boot race to protect against. Without this,
      // late joiners stall in pure-lockstep waiting for ALL peers' input
      // every frame, which is fatal on mobile with 3+ peers.
      // Boot grace: stall in pure lockstep for the first BOOT_GRACE_FRAMES.
      // _rbInitFrame === -1 means C-rollback hasn't initialized yet. This can
      // be because (a) the WASM core doesn't support it, or (b) the guest is
      // waiting for the host's rb-delay broadcast. In case (b), we must NOT
      // skip boot grace — the boot sync depends on it. Use _frameNum as the
      // fallback reference when _rbInitFrame hasn't been set yet.
      // _bootDoneForSync: gates boot sync trigger (needs 120 frames for emulator to stabilize)
      // _bootDone: gates lockstep stall (always true — no stall during boot/intro,
      //   boot sync at f=120 and CSS sync at menu entry handle alignment instead)
      const _bootRef = _rbInitFrame >= 0 ? _rbInitFrame : 0;
      const _bootDoneForSync = _frameNum - _bootRef > BOOT_GRACE_FRAMES;
      const _bootDone = true;
      // Gate rollback on SSB64 menu/gameplay phase. Active gameplay may use
      // rollback prediction; strict input menus use pure lockstep so
      // irreversible menu edges are never predicted.
      const menuPhase = _readStrictPhaseLock(_bootDoneForSync);
      const { gameStatus, sceneCurr, strictInputLockstep } = menuPhase;
      const localGameplay = !_isSmashRemix() || menuPhase.gameplay;
      const localInMenu = !!menuPhase.localActive;
      // game_status: 0=wait (CSS/menus or battle loading), 1=ongoing, 2=paused, 5=end.
      // Status 0 is dangerous only in controllable menus; scene=22/status=0
      // is battle loading and uses rollback/pacing instead of no-timeout lockstep.
      // Status -1 means RDRAM not available (non-SSB64) — safe fallback.
      // scene_curr lets us enter strict lockstep at Title/Mode Select/1P/VS
      // menus before CSS; waiting until CSS lets Mode Select fabricate a zero
      // input and split one peer into 1P while the other remains in Mode Select.
      const inMenu = menuPhase.active;
      if (!_inGameplay && localGameplay && _bootDone) {
        _inGameplay = true;
        _syncLog(`MENU→GAMEPLAY transition at f=${_frameNum} gameStatus=${gameStatus} scene=${sceneCurr}`);
        // Smash Remix defers rollback init until here — see line ~6900.
        // Both peers fire on their own local transition; doRollbackInit
        // calls _kn_set_frame(_frameNum) so per-peer frame-skew at init
        // time is handled the same way as late-join.
        if (window._rbDeferredForGameplay) {
          const fn = window._rbDeferredForGameplay;
          window._rbDeferredForGameplay = null;
          _syncLog(`C-ROLLBACK firing deferred init at f=${_frameNum}`);
          fn();
        }
      } else if (_inGameplay && localInMenu) {
        _inGameplay = false;
        if (_frameNum - _inGameplayLoggedAt > 60) {
          _syncLog(`GAMEPLAY→MENU transition at f=${_frameNum} gameStatus=${gameStatus} scene=${sceneCurr}`);
          _inGameplayLoggedAt = _frameNum;
        }
        // Tear down C rollback when leaving gameplay so menu state isn't
        // serialized — Smash Remix specifically defers init to avoid this
        // (see line ~7099). Without teardown, the engine keeps running
        // through every subsequent menu in the session, making the second
        // match's first MENU→GAMEPLAY transition behave differently from
        // the first (no fresh init, polluted prediction/stat state).
        // Re-arm the deferred-init closure so the next gameplay transition
        // re-fires init cleanly.
        if (_useCRollback && _rbReinitClosure) {
          const tickMod = window.EJS_emulator?.gameManager?.Module;
          if (tickMod?._kn_rollback_shutdown) tickMod._kn_rollback_shutdown();
          if (_rbInputPtr && tickMod?._free) {
            tickMod._free(_rbInputPtr);
            _rbInputPtr = 0;
          }
          if (_rbRegionsBufPtr && tickMod?._free) {
            tickMod._free(_rbRegionsBufPtr);
            _rbRegionsBufPtr = 0;
          }
          _useCRollback = false;
          _rbInitFrame = -1;
          // Guests must wait for the host's fresh rb-init-frame broadcast
          // for the next match. Host's delay is unchanged across matches,
          // but the init frame is per-match.
          if (_playerSlot !== 0) window._rbHostInitFrame = undefined;
          window._rbDeferredForGameplay = _rbReinitClosure;
          _syncLog(`C-ROLLBACK shutdown on GAMEPLAY→MENU at f=${_frameNum} — re-armed for next match`);
        }
      }
      // Menu lockstep arming: once a real controllable menu is visible, never
      // fabricate missing remote inputs. This intentionally does not request
      // or apply a state push; menu determinism comes from preventing the bad
      // predicted frame, not resyncing after it.
      if (strictInputLockstep && !window._knCssSyncDone) {
        window._knCssSyncDone = true;
        _syncLog(`MENU-LOCKSTEP armed at f=${_frameNum}, scene=${sceneCurr}, gameStatus=${gameStatus}`);
      }
      if (menuPhase.waitingPeerSlots?.length && _frameNum - _lastPeerPhaseWaitLogFrame >= 60) {
        _lastPeerPhaseWaitLogFrame = _frameNum;
        _syncLog(
          `PHASE-LOCK f=${_frameNum} scene=${sceneCurr} gameStatus=${gameStatus} ` +
            `waitingPeers=[${menuPhase.waitingPeerSlots.join(',')}]`,
        );
      }
      // Lockstep stall during controllable menus. During boot, intro, and
      // battle loading, run freely; once scene_curr reaches Title/Mode
      // Select/menus, never fabricate missing remote input.
      const _menuLockstepActive = strictInputLockstep;
      const _rbBootConverged = _bootDone && !_menuLockstepActive;
      const phaseWaitSlots = [...new Set(menuPhase.waitingPeerSlots || [])].sort((a, b) => a - b);
      const phaseMismatchSlots = menuPhase.phaseMismatchSlots?.length ? menuPhase.phaseMismatchSlots : phaseWaitSlots;
      const phaseLockSlots = [...new Set(phaseMismatchSlots)].sort((a, b) => a - b);
      if (phaseLockSlots.length) {
        const waitKey = `${sceneCurr}:${gameStatus}:${phaseLockSlots.join(',')}`;
        if (_phaseLockStallKey !== waitKey) {
          _phaseLockStallKey = waitKey;
          _phaseLockStallStartTime = _tickNow;
        }
        const stallMs = _tickNow - _phaseLockStallStartTime;
        if (stallMs >= MAX_STALL_MS + RESEND_TIMEOUT_MS) {
          for (const slot of phaseLockSlots) {
            markPeerPhantomForStallTimeout(
              slot,
              'phase-lock-timeout',
              `stalledMs=${Math.round(stallMs)} scene=${sceneCurr} gameStatus=${gameStatus}`,
            );
          }
          _syncLog(
            `PHASE-LOCK-TIMEOUT f=${_frameNum} scene=${sceneCurr} gameStatus=${gameStatus} ` +
              `waitingPeers=[${phaseWaitSlots.join(',')}] mismatchPeers=[${phaseLockSlots.join(',')}] ` +
              `stalledMs=${Math.round(stallMs)} — force-releasing phase lock`,
          );
          _phaseLockStallKey = '';
          _phaseLockStallStartTime = 0;
        } else if (phaseWaitSlots.length) {
          return;
        }
      } else {
        _phaseLockStallKey = '';
        _phaseLockStallStartTime = 0;
      }
      // Boot sync: legacy savestate startup can still need one host state push
      // after boot grace. kn-sync startup already loaded the host's authoritative
      // CPU/peripheral/RDRAM state at the manual start boundary; repeating that
      // push can rewind the guest after menus have begun and create an input stall.
      if (_bootDoneForSync && !window._knBootSyncDone) {
        window._knBootSyncDone = true;
        if (_syncEnabled && _playerSlot !== 0 && _lockstepStartStateKind !== 'kn-sync') {
          const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
          if (hostPeer?.dc?.readyState === 'open') {
            try {
              hostPeer.dc.send('sync-request-full');
              _syncLog(`BOOT-SYNC: guest requesting host state at f=${_frameNum} (JIT boot divergence correction)`);
            } catch (e) {
              _syncLog(`BOOT-SYNC send failed: ${e}`);
            }
          }
        } else if (_syncEnabled && _playerSlot !== 0) {
          _syncLog(`BOOT-SYNC skipped: initial state already ${_lockstepStartStateKind}`);
        }
      }
      const rbApplyFrame = _frameNum - DELAY_FRAMES;
      // Tick timing: measure wall-clock between ticks for FPS diagnosis
      const _tickWallNow = performance.now();
      if (!window._knLastTickWall) window._knLastTickWall = _tickWallNow;
      if (!window._knTickDeltas) window._knTickDeltas = [];
      const _tickDelta = _tickWallNow - window._knLastTickWall;
      window._knLastTickWall = _tickWallNow;
      if (_tickDelta > 0 && _tickDelta < 200) window._knTickDeltas.push(_tickDelta);
      if (window._knTickDeltas.length > 120) window._knTickDeltas.splice(0, window._knTickDeltas.length - 120);
      if (
        _frameNum > 0 &&
        _frameNum % 300 === 0 &&
        window._knTickDeltas.length > 10 &&
        window._knLastTickPerfFrame !== _frameNum
      ) {
        window._knLastTickPerfFrame = _frameNum;
        const sorted = [...window._knTickDeltas].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        const avgFps = 1000 / (sorted.reduce((a, b) => a + b) / sorted.length);
        // Check input availability for peers
        const inputPeers = getInputPeers();
        let inputAvail = 'none';
        if (rbApplyFrame >= 0 && inputPeers.length > 0) {
          const avail = inputPeers.filter((p) => _remoteInputs[p.slot]?.[rbApplyFrame]).length;
          inputAvail = `${avail}/${inputPeers.length}`;
        }
        _syncLog(
          `TICK-PERF f=${_frameNum} fps=${avgFps.toFixed(1)} tickMs median=${median.toFixed(1)} p95=${p95.toFixed(1)} ` +
            `inputAvail=${inputAvail} converged=${_rbBootConverged} inMenu=${inMenu} inGameplay=${_inGameplay}`,
        );
      }
      // Reset deadlock recovery flag periodically — without this, a single
      // 3s stall permanently disables lockstep enforcement. Re-stall every
      // 5 seconds to give the connection time to recover. Also reset
      // immediately when peer input catches up.
      if (_bootStallRecoveryFired && rbApplyFrame >= 0) {
        const recoveryPeers = getInputPeers();
        const allHaveInput =
          recoveryPeers.length > 0 && recoveryPeers.every((p) => _remoteInputs[p.slot]?.[rbApplyFrame]);
        if (allHaveInput) {
          _bootStallRecoveryFired = false;
          _syncLog(`BOOT-STALL-RECOVERY reset: peer input available at applyF=${rbApplyFrame}`);
        } else if (!_bootStallRecoveryResetTime) {
          _bootStallRecoveryResetTime = performance.now();
        } else if (performance.now() - _bootStallRecoveryResetTime >= 5000) {
          _bootStallRecoveryFired = false;
          _bootStallRecoveryResetTime = 0;
          _syncLog(`BOOT-STALL-RECOVERY periodic reset: re-stalling to wait for peer input`);
        }
      }
      if (!_rbBootConverged && !_resyncRequestInFlight && !_bootStallRecoveryFired) {
        // Menu/CSS/SSS: strict lockstep. Never fabricate zero input here:
        // a single missed A/Start frame can select a different character or
        // stage on one peer and turn setup into a permanent desync.
        // Skipped when resync is in flight or deadlock recovery fired —
        // the tick must continue so the resync handler can process the
        // host's state push. Without this, the tick returns early and
        // the resync response is never handled.
        if (rbApplyFrame >= 0) {
          const bootInputPeers = getInputPeers(_menuLockstepActive);
          let stalled = false;
          let missingSlot = -1;
          for (const p of bootInputPeers) {
            if (_peerPhantom[p.slot]) continue;
            if (!_remoteInputs[p.slot]?.[rbApplyFrame]) {
              stalled = true;
              missingSlot = p.slot;
              break;
            }
          }
          if (stalled) {
            const nowWall = performance.now();
            if (_bootStallFrame !== rbApplyFrame) {
              _bootStallFrame = rbApplyFrame;
              _bootStallStartTime = nowWall;
              _bootStallRecoveryFired = false;
              _resendSent = false;
            }
            const stallDuration = nowWall - _bootStallStartTime;
            if (_menuLockstepActive) {
              if (stallDuration >= MAX_STALL_MS + RESEND_TIMEOUT_MS) {
                markPeerPhantomForStallTimeout(
                  missingSlot,
                  'menu-lockstep-timeout',
                  `stalledMs=${Math.round(stallDuration)} apply=${rbApplyFrame}`,
                );
                if (!_remoteInputs[missingSlot]) _remoteInputs[missingSlot] = {};
                if (!_remoteInputs[missingSlot][rbApplyFrame]) {
                  _remoteInputs[missingSlot][rbApplyFrame] = KNShared.ZERO_INPUT;
                  _pendingCInputs.push({
                    slot: missingSlot,
                    frame: rbApplyFrame,
                    buttons: 0,
                    lx: 0,
                    ly: 0,
                    cx: 0,
                    cy: 0,
                  });
                }
                _syncLog(
                  `MENU-LOCKSTEP-TIMEOUT f=${_frameNum} apply=${rbApplyFrame} missingSlot=${missingSlot} ` +
                    `stalledMs=${Math.round(stallDuration)} — force-releasing strict lockstep`,
                );
                _bootStallFrame = -1;
                _bootStallStartTime = 0;
                _bootStallRecoveryFired = false;
              } else {
                if (stallDuration >= MAX_STALL_MS && !_resendSent) {
                  _resendSent = true;
                  const missingPeer = bootInputPeers.find((peer) => peer.slot === missingSlot);
                  try {
                    missingPeer?.dc?.send(`resend:${rbApplyFrame}`);
                  } catch (_) {}
                  _syncLog(
                    `MENU-LOCKSTEP resend-request f=${_frameNum} apply=${rbApplyFrame} missingSlot=${missingSlot}`,
                  );
                }
                if (_frameNum % 60 === 0 && window._knLastBootStallLogFrame !== _frameNum) {
                  window._knLastBootStallLogFrame = _frameNum;
                  _syncLog(
                    `MENU-LOCKSTEP f=${_frameNum} initF=${_rbInitFrame} applyF=${rbApplyFrame} ` +
                      `stalledMs=${Math.round(stallDuration)} — stalling for slot=${missingSlot}`,
                  );
                }
                return;
              }
            }

            // Boot/pre-menu fallback: stall briefly, then fabricate zero to
            // avoid deadlock before user-controlled setup state exists.
            if (!_menuLockstepActive) {
              const _bootStallTimeout = Math.max(33, Math.min(250, (_rttMedian || 50) * 2));
              if (stallDuration < _bootStallTimeout) {
                if (_frameNum % 60 === 0 && window._knLastBootStallLogFrame !== _frameNum) {
                  window._knLastBootStallLogFrame = _frameNum;
                  _syncLog(
                    `BOOT-LOCKSTEP f=${_frameNum} initF=${_rbInitFrame} applyF=${rbApplyFrame} ` +
                      `stalledMs=${Math.round(stallDuration)} — stalling for slot=${missingSlot}`,
                  );
                }
                return;
              }
              // Fabricate zero input and continue
              if (!_remoteInputs[missingSlot]) _remoteInputs[missingSlot] = {};
              if (!_remoteInputs[missingSlot][rbApplyFrame]) {
                _remoteInputs[missingSlot][rbApplyFrame] = KNShared.ZERO_INPUT;
                _pendingCInputs.push({
                  slot: missingSlot,
                  frame: rbApplyFrame,
                  buttons: 0,
                  lx: 0,
                  ly: 0,
                  cx: 0,
                  cy: 0,
                });
              }
              // Fall through to normal tick with fabricated zero input
            }
          }
          _bootStallFrame = -1;
          _bootStallStartTime = 0;
          _bootStallRecoveryFired = false;
        }
      } else if (_rbBootConverged && rbApplyFrame >= 0) {
        // Gameplay: stall only when too far ahead for rollback to help
        const rbInputPeers = getInputPeers();
        // Stall threshold: must match the C engine's visible_rb_max so we
        // don't bail before rollback can absorb the gap. Legacy model uses
        // delay+4 (kn_rollback.c). True rollback expands this to delay+10
        // (capped at 12 by KN_MAX_VISIBLE_ROLLBACK_DEPTH); keeping the JS
        // stall at the old delay+4 produces continuous lockstep-like stalls
        // at typical RTT/2 frame depths because peer naturally sits 5-7
        // frames behind on 80ms RTT.
        const stallThreshold = RB_TRUE_ROLLBACK ? Math.min(DELAY_FRAMES + 10, 12) : DELAY_FRAMES + 4;
        for (const p of rbInputPeers) {
          if (_peerPhantom[p.slot]) continue;
          if (!_remoteInputs[p.slot]?.[rbApplyFrame]) {
            // Input missing — check how far ahead we are
            const peerFrame = _lastRemoteFramePerSlot[p.slot] ?? -1;
            const adv = peerFrame >= 0 ? _frameNum - peerFrame : 0;
            if (adv >= stallThreshold) {
              const nowRbInputStall = performance.now();
              const rbStallKey = `${p.slot}:${rbApplyFrame}`;
              if (_rbInputStallKey !== rbStallKey) {
                _rbInputStallKey = rbStallKey;
                _rbInputStallStartTime = nowRbInputStall;
              }
              const stalledMs = nowRbInputStall - _rbInputStallStartTime;
              if (stalledMs >= MAX_STALL_MS + RESEND_TIMEOUT_MS) {
                markPeerPhantomForStallTimeout(
                  p.slot,
                  'rb-input-stall-timeout',
                  `stalledMs=${Math.round(stalledMs)} apply=${rbApplyFrame} adv=${adv}`,
                );
                _syncLog(
                  `RB-INPUT-STALL-TIMEOUT f=${_frameNum} apply=${rbApplyFrame} slot=${p.slot} ` +
                    `adv=${adv} stalledMs=${Math.round(stalledMs)} — force-releasing rollback input stall`,
                );
                _rbInputStallKey = '';
                _rbInputStallStartTime = 0;
                continue;
              }
              // Too far ahead — stall to let peer catch up
              if (!_rbStallLogged || _frameNum - _rbStallLogged >= 60) {
                _syncLog(
                  `RB-INPUT-STALL f=${_frameNum} apply=${rbApplyFrame} slot=${p.slot} ` +
                    `adv=${adv} stalledMs=${Math.round(stalledMs)} — stalling (rollback budget exhausted)`,
                );
                _rbStallLogged = _frameNum;
              }
              return;
            }
            // Within rollback budget — let C engine predict through it
          }
        }
        _rbInputStallKey = '';
        _rbInputStallStartTime = 0;
      }

      // ── Drain queued remote inputs into C engine ──────────────────────
      // WebRTC callbacks push to _pendingCInputs instead of calling
      // kn_feed_input directly. Draining here — at the tick boundary,
      // before kn_pre_tick — guarantees the C engine sees a consistent
      // input snapshot per frame. No race between async DC delivery and
      // the sync prediction/serialize logic inside kn_pre_tick.
      if (_pendingCInputs.length > 0 && tickMod._kn_feed_input) {
        // Sort in place by (frame, slot) so frames feed monotonically and
        // duplicates land adjacent (last write wins inside C's slot:frame
        // store). Avoids the prior Map + [...spread] + template-literal
        // keys that allocated per tick at 60 Hz; the in-place sort uses
        // a stable closure (allocated once at module scope) and feeds
        // directly without an intermediate Array.
        if (_pendingCInputs.length > 1) _pendingCInputs.sort(_pendingCInputsSortFn);
        for (let i = 0; i < _pendingCInputs.length; i++) {
          const qi = _pendingCInputs[i];
          tickMod._kn_feed_input(qi.slot, qi.frame, qi.buttons, qi.lx, qi.ly, qi.cx, qi.cy);
        }
        _pendingCInputs.length = 0;
      }

      // ── DEMO-PAUSED: third mode in the hybrid input-stall ladder ────────
      // When the demo orchestrator pauses predictions to simulate lockstep
      // behavior under jitter, stall like BOOT/STRICT-MENU do — but only if
      // no replay is queued and not all input peers have the apply frame.
      // Use the non-clearing peek; the clearing variant would swallow the
      // replay before kn_pre_tick consumes it (kn_rollback.c:933-948).
      if (_predictionsPaused) {
        const pendingReplay = (tickMod._kn_peek_pending_rollback?.() ?? -1) >= 0;
        if (!pendingReplay) {
          const applyFrame = _frameNum - DELAY_FRAMES;
          let allInputsPresent = true;
          for (const p of activePeers) {
            if (p.slot === _playerSlot) continue;
            if (_peerPhantom[p.slot]) continue;
            if (_remoteInputs[p.slot]?.[applyFrame] === undefined) {
              allInputsPresent = false;
              break;
            }
          }
          if (!allInputsPresent) {
            if (_stallStart === 0) _stallStart = performance.now();
            return; // stall — same shape as BOOT/STRICT-MENU early returns
          }
        }
        _stallStart = 0;
      }

      // ── Pre-tick: save state, handle replay if catching up, store input, predict ──
      // Returns 1 if catching up (C did a replay frame via retro_run — skip normal step).
      // Returns 0 for normal tick (JS does writeInputToMemory + stepOneFrame).
      const _t0 = performance.now();
      if (!_rbVisualFreezeActive && (tickMod._kn_peek_pending_rollback?.() ?? -1) >= 0) {
        _captureRollbackVisualSnapshot();
      }
      // C currently throttles at frame_adv >= delay + 2. Bias the value so
      // the actual cap is frame_adv >= delay: once the fast peer has consumed
      // the whole input buffer, wait instead of creating a guaranteed rollback.
      // Demo mode forces -1 (no throttle) so the engine runs full speed and
      // predicts whenever inputs are missing — only the demo's synthetic peer
      // setup tolerates the unbounded prediction, real matches still throttle.
      const _frameAdvForC = _demoMode ? -1 : _rbBootConverged ? _frameAdvRaw + 2 : -1;
      let catchingUp = tickMod._kn_pre_tick(
        localInput.buttons,
        localInput.lx,
        localInput.ly,
        localInput.cx,
        localInput.cy,
        _frameAdvForC,
      );
      _refreshRunnerAfterRollbackRestore(tickMod);
      // ── R3: Fatal stale-ring poll ────────────────────────────────────
      // If kn_feed_input just detected a misprediction for a frame
      // whose ring slot was overwritten, log FATAL-RING-STALE with full
      // diagnostic fields. Per §Core principle: dev throws, prod logs
      // and continues. No resync recovery.
      // See docs/netplay-invariants.md §R3.
      if (!_rbFatalBuf && tickMod._malloc) _rbFatalBuf = tickMod._malloc(12);
      if (!_rbLiveMismatchBuf && tickMod._malloc) _rbLiveMismatchBuf = tickMod._malloc(12);
      if (tickMod._kn_get_fatal_stale && _rbFatalBuf) {
        const hit = tickMod._kn_get_fatal_stale(_rbFatalBuf, _rbFatalBuf + 4, _rbFatalBuf + 8);
        if (hit) {
          const heap = tickMod.HEAP32;
          const base = _rbFatalBuf >> 2;
          const staleF = heap[base];
          const staleIdx = heap[base + 1];
          const staleActual = heap[base + 2];
          _syncLog(
            `FATAL-RING-STALE f=${staleF} ring[${staleIdx}]=${staleActual} ` +
              `curF=${_frameNum} tick=${performance.now().toFixed(1)}`,
          );
          if (window.KN_DEV_BUILD) {
            throw new Error(`FATAL-RING-STALE: ring[${staleIdx}]=${staleActual} but needed frame ${staleF}`);
          }
        }
      }
      // ── R4: Post-replay live-state mismatch poll ─────────────────────
      // kn_post_tick compares the live emulator state hash to what the
      // ring claims for the just-completed replay frame. If they differ,
      // the replay introduced drift and the run is corrupted. Per §Core
      // principle: dev throws, prod logs and continues. No resync.
      // See docs/netplay-invariants.md §R4.
      if (tickMod._kn_get_live_mismatch && _rbLiveMismatchBuf) {
        const hit = tickMod._kn_get_live_mismatch(_rbLiveMismatchBuf, _rbLiveMismatchBuf + 4, _rbLiveMismatchBuf + 8);
        if (hit) {
          const heap32 = tickMod.HEAP32;
          const heapU32 = tickMod.HEAPU32;
          const base = _rbLiveMismatchBuf >> 2;
          const mf = heap32[base];
          const ringHash = heapU32[base + 1];
          const liveHash = heapU32[base + 2];
          _syncLog(
            `RB-LIVE-MISMATCH f=${mf} ring=0x${ringHash.toString(16)} ` +
              `live=0x${liveHash.toString(16)} curF=${_frameNum}`,
          );
          if (window.KN_DEV_BUILD) {
            throw new Error(
              `RB-LIVE-MISMATCH: ring=0x${ringHash.toString(16)} live=0x${liveHash.toString(16)} at f=${mf}`,
            );
          }
        }
      }
      const _tPreTick = performance.now();

      // Sync JS frame counter with C
      _frameNum = tickMod._kn_get_frame();
      KNState.frameNum = _frameNum;

      // Log replay start/done
      const replayDepth = tickMod._kn_get_replay_depth?.() ?? 0;
      // ── R5: pre-tick return-value invariant ─────────────────────────────
      // If C just set replay_depth > 0, kn_pre_tick MUST return 2 (replay
      // frame). Any other return value means the rollback branch ran but
      // the replay branch didn't — the emulator state is about to freeze
      // at the rollback target while the frame counter keeps advancing.
      // Per §Core principle: log-loud-and-continue. No resync recovery.
      // See docs/netplay-invariants.md §R5.
      if (replayDepth > 0 && catchingUp !== 2) {
        const rbFrame = tickMod._kn_get_frame?.() ?? -1;
        _syncLog(
          `RB-INVARIANT-FIXUP f=${_frameNum} replayDepth=${replayDepth} ` +
            `catchingUp=${catchingUp} rbFrame=${rbFrame} tick=${performance.now().toFixed(1)} — forcing replay step`,
        );
        catchingUp = 2;
      }
      if (replayDepth > 0 && catchingUp === 2 && !_rbReplayLogged) {
        const hudNow = performance.now();
        _hudRollbackEvents++;
        _hudEventTimestamps.push(hudNow);
        while (_hudEventTimestamps.length > 0 && hudNow - _hudEventTimestamps[0] > HUD_EVENT_WINDOW_MS) {
          _hudEventTimestamps.shift();
        }
        _hudRollbackDepthSamples.push(replayDepth);
        if (_hudRollbackDepthSamples.length > HUD_DEPTH_WINDOW) _hudRollbackDepthSamples.shift();
        _syncLog(`C-REPLAY start: depth=${replayDepth} took=${(_tPreTick - _t0).toFixed(1)}ms`);
        if (!_showRollbackVisualFreeze(replayDepth, localInput)) _startRollbackCanvasNudge(localInput, replayDepth);
        _setReplayRdpSkip(tickMod, true, `depth=${replayDepth}`);
        _setReplayFullHeadless(tickMod, true, `depth=${replayDepth}`);
        _rbReplayLogged = true;
        // Replay must execute the same RSP/audio task as the original forward
        // frame so rollback advances emulator-side audio state faithfully.
        // We mute at the JS playback boundary in the catchingUp===2 path
        // instead of skipping the task in WASM.
        if (tickMod._kn_set_skip_rsp_audio) tickMod._kn_set_skip_rsp_audio(0);
        _syncLog(`REPLAY-AUDIO-MUTE: RSP audio stays mode=0; WebAudio feed muted for replay depth=${replayDepth}`);
      }
      if (_rbReplayLogged && catchingUp !== 2) _finishCReplay(tickMod);

      if (catchingUp === 3) {
        // Check if all peers are phantom — if so, ignore C-level throttle
        // to prevent permanent freeze when the only peer has disconnected.
        const allPhantom = getInputPeers().every((p) => _peerPhantom[p.slot]);
        if (allPhantom) {
          if (_runSubstate === RUN_PACING) {
            if (_runSubstate === RUN_PACING) _runSubstate = RUN_NORMAL;
            _pacingThrottleStartAt = 0;
            if (window._knLastCPhantomReleaseFrame !== _frameNum) {
              window._knLastCPhantomReleaseFrame = _frameNum;
              _syncLog(`PACING-THROTTLE released — all peers phantom (C-level override)`);
            }
          }
          // Fall through to normal tick instead of returning
        } else {
          _pacingCapsFrames++;
          if (_runSubstate !== RUN_PACING) {
            _runSubstate = RUN_PACING;
            _pacingThrottleStartAt = performance.now();
            _pacingCapsCount++;
            _logPacing(
              `PACING-THROTTLE start fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)} delay=${DELAY_FRAMES} source=C`,
            );
          }
          return;
        }
      }
      if (_runSubstate === RUN_PACING) {
        if (_runSubstate === RUN_PACING) _runSubstate = RUN_NORMAL;
        _pacingThrottleStartAt = 0;
        _logPacing(`PACING-THROTTLE end fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)} source=C`);
      }

      if (catchingUp === 2) {
        const burstStart = performance.now();
        let burstSteps = 0;
        let replayDone = false;
        while (catchingUp === 2) {
          _runCReplayFrame(tickMod);
          burstSteps++;
          const replayRemaining = tickMod._kn_get_replay_depth?.() ?? 0;
          if (replayRemaining <= 0) {
            replayDone = true;
            break;
          }
          const burstMs = performance.now() - burstStart;
          if (burstSteps >= RB_REPLAY_BURST_MAX_FRAMES || burstMs >= RB_REPLAY_BURST_BUDGET_MS) break;
          catchingUp = _prepareCReplayFrame(tickMod, localInput, _frameAdvForC);
        }
        if (replayDone || (tickMod._kn_get_replay_depth?.() ?? 0) <= 0) _finishCReplay(tickMod);
        // Overlay
        if (_frameNum % 15 === 0) {
          const dbg = document.getElementById('np-debug');
          if (dbg) {
            dbg.style.display = '';
            const rb = tickMod._kn_get_rollback_count?.() ?? 0;
            const remaining = tickMod._kn_get_replay_depth?.() ?? 0;
            dbg.textContent = `F:${_frameNum} fps:${_fpsCurrent} slot:${_playerSlot} REPLAYING (${remaining} left) rb:${rb}`;
          }
        }
        return;
      }

      const applyFrame = _frameNum - DELAY_FRAMES;
      // Diagnostic: compare C ring input with JS _remoteInputs every 60 frames
      if (_frameNum % 60 === 0 && applyFrame >= 0) {
        for (let s = 0; s < rb_numPlayers; s++) {
          if (s === _playerSlot) continue;
          const cInp = _rbGetInput(tickMod, s, applyFrame);
          const jsInp = _remoteInputs[s]?.[applyFrame];
          if (jsInp && (cInp.buttons !== jsInp.buttons || cInp.lx !== jsInp.lx || cInp.ly !== jsInp.ly)) {
            _syncLog(
              `INPUT-DIFF f=${_frameNum} apply=${applyFrame} slot=${s} c=[${cInp.buttons},${cInp.lx},${cInp.ly}] js=[${jsInp.buttons},${jsInp.lx},${jsInp.ly}]`,
            );
          }
          if (!jsInp && cInp !== KNShared.ZERO_INPUT && cInp.buttons !== 0) {
            _syncLog(
              `INPUT-MISSING f=${_frameNum} apply=${applyFrame} slot=${s} cHas=true jsHas=false c=[${cInp.buttons},${cInp.lx},${cInp.ly}]`,
            );
          }
        }
      }
      for (let zs = 0; zs < 4; zs++) writeInputToMemory(zs, 0);
      // True-rollback netcode: local input applied at the CURRENT frame for
      // instant input feel; remote inputs applied at applyFrame (predicted by
      // C engine if not yet confirmed). The C replay path mirrors this split
      // so replay reproduces the same input application as the original
      // forward frame — see kn_pre_tick replay branch in build/kn_rollback/
      // kn_rollback.c (gated by kn_set_true_rollback flag pushed down at game
      // start). Mismatched peers are blocked by the capability handshake.
      // Legacy "lockstep with rollback recovery": all slots applied at
      // applyFrame, including local — local input lag scales with negotiated
      // delay (which itself scales with RTT), so input feels like lockstep.
      if (RB_TRUE_ROLLBACK) {
        writeInputToMemory(_playerSlot, localInput);
        // Defer log-string allocation until we actually log. Per-tick at
        // 60 Hz we'd otherwise build N+1 template-literal strings + a
        // regex-tested array even though only ~1% of ticks log
        // (anyNonZero short-circuits and 60-frame heartbeat).
        let anyNonZero = !!(localInput.buttons || localInput.lx || localInput.ly);
        if (applyFrame >= 0) {
          for (let s = 0; s < rb_numPlayers; s++) {
            if (s === _playerSlot) continue;
            const inp = _rbGetInput(tickMod, s, applyFrame);
            writeInputToMemory(s, inp);
            if (!anyNonZero && (inp.buttons || inp.lx || inp.ly)) anyNonZero = true;
          }
        }
        if (anyNonZero || _frameNum % 60 === 0) {
          let line = `NORMAL-INPUT-TR f=${_frameNum} apply=${applyFrame} L${_playerSlot}@${_frameNum}[${localInput.buttons},${localInput.lx},${localInput.ly}]`;
          if (applyFrame >= 0) {
            for (let s = 0; s < rb_numPlayers; s++) {
              if (s === _playerSlot) continue;
              const inp = _rbGetInput(tickMod, s, applyFrame);
              line += ` R${s}@${applyFrame}[${inp.buttons},${inp.lx},${inp.ly}]`;
            }
          }
          _syncLog(line);
        }
      } else if (applyFrame >= 0) {
        // Same deferral pattern: read + write inputs, only build the log
        // string once we know we'll actually log it.
        let anyNonZero = false;
        for (let s = 0; s < rb_numPlayers; s++) {
          const inp = _rbGetInput(tickMod, s, applyFrame);
          writeInputToMemory(s, inp);
          if (!anyNonZero && (inp.buttons || inp.lx || inp.ly)) anyNonZero = true;
        }
        if (anyNonZero || _frameNum % 60 === 0) {
          let line = `NORMAL-INPUT f=${applyFrame}`;
          for (let s = 0; s < rb_numPlayers; s++) {
            const inp = _rbGetInput(tickMod, s, applyFrame);
            line += ` s${s}[${inp.buttons},${inp.lx},${inp.ly}]`;
          }
          _syncLog(line);
        }
      }

      if (RB_SHADOW_EMU) {
        if (!_rbShadowReady && !_rbShadowBooting && !_rbShadowFailed) _shadowMaybeStart('normal-tick');
        if (_rbShadowReady) {
          const shadowInputs = _shadowBuildInputs(tickMod, localInput, applyFrame);
          if (_rbShadowVisible) {
            _shadowShowPersistentOverlay();
          } else if (RB_SHADOW_LEAD_FRAMES > 0) {
            const targetFrame = _frameNum + RB_SHADOW_LEAD_FRAMES;
            _shadowPostLead(targetFrame, shadowInputs, 'normal-lead', 2, false);
          } else {
            _shadowPostStep(_frameNum, shadowInputs, 'normal', 1);
            _shadowShowPersistentOverlay();
          }
        }
      }

      if (tickMod._kn_reset_audio) {
        tickMod._kn_reset_audio();
        _resetAudioCallsSinceRb++;
      }
      _syncRNGSeed(tickMod, _frameNum);
      const _tStep0 = performance.now();
      // try/finally: if stepOneFrame throws (WASM OOB, abort, etc.), the
      // performance.now() override stays armed and returns frozen WASM
      // cycle time, which freezes the setInterval tick scheduler and the
      // entire game loop. See netplay-lockstep.js:6873.
      _inDeterministicStep = true;
      try {
        stepOneFrame();
      } catch (e) {
        _syncLog(_formatStepThrew('normal', e));
        console.error('[lockstep] stepOneFrame threw (normal):', e);
      } finally {
        _inDeterministicStep = false;
      }
      // 2026-04-29 audio-diag: invariant check post-step. Counters tick
      // every time BUSY is set without AI_INT in queue. Cheap (one WASM call).
      _checkAiInvariant(tickMod, 3);
      const _tStep = performance.now();
      if (!_rbVisualFreezeActive && _rbVisualFreezeEnabled && _frameNum % RB_VISUAL_SNAPSHOT_INTERVAL_FRAMES === 0) {
        _captureRollbackVisualSnapshot();
      }
      // Sample on-screen motion for the canvas-velocity-driven motion
      // smoothing path (see _gameVelocityToRollbackMotion). Runs once
      // per tick after stepOneFrame so the live canvas has the new
      // frame; cheap (32×24 downsample readback). Skipped while a
      // freeze overlay is up — sampling the overlay would zero the
      // velocity since the snapshot is static.
      if (RB_REPLAY_RDRAM_MOTION && !_rbVisualFreezeActive) {
        _sampleLiveCanvasMotion();
      }
      // Post-step RNG reseed: the game advances RNG during the frame a
      // different number of times on each peer (from interrupt timing
      // differences). Re-seeding AFTER the step ensures the stored RNG
      // value is identical for the next frame, regardless of within-frame
      // divergence. Without this, random character/stage selection picks
      // different results on iPhone↔iPhone.
      _syncRNGSeed(tickMod, _frameNum);
      feedAudio();

      // ── Post-tick: advance C frame counter ──
      const newFrame = tickMod._kn_post_tick();
      _frameNum = newFrame;
      KNState.frameNum = _frameNum;
      if (window.KNDesync) KNDesync.tick(_frameNum);
      const _tTotal = performance.now();

      // Post-sync diagnostic burst: hash full state for 10 frames after boot sync
      if (_knDeepDiagnostics && window._knPostSyncDiagFrames > 0) {
        window._knPostSyncDiagFrames--;
        const gpH = (tickMod._kn_gameplay_hash?.(_frameNum - 1) ?? 0) >>> 0;
        const gameH = (tickMod._kn_game_state_hash?.(_frameNum - 1) ?? 0) >>> 0;
        const fullH = (tickMod._kn_full_state_hash?.(_frameNum - 1) ?? 0) >>> 0;
        const eqH = (tickMod._kn_eventqueue_hash?.() ?? 0) >>> 0;
        const hidH = (tickMod._kn_get_hidden_state_fingerprint?.() ?? 0) >>> 0;
        _syncLog(
          `POST-SYNC-DIAG f=${_frameNum} gp=0x${gpH.toString(16)} game=0x${gameH.toString(16)} ` +
            `full=0x${fullH.toString(16)} eq=0x${eqH.toString(16)} hid=0x${hidH.toString(16)}`,
        );
      }

      // ── P4: silent-desync detection (LOG-ONLY) ──
      // kn_feed_input (drained at tick boundary above) increments
      // failed_rollbacks when a misprediction targets a frame outside the
      // rollback ring (too old OR state overwritten). This
      // is a silent desync: the correction can't be applied. We log so the
      // session record captures it, but we deliberately do NOT trigger a
      // mid-game resync — snaps feel worse than gradual divergence and break
      // the player's muscle memory. Fix the determinism gap, not the symptom.
      if (tickMod._kn_get_failed_rollbacks) {
        const nowFailed = tickMod._kn_get_failed_rollbacks();
        if (nowFailed > _rbLastFailedRollbacks) {
          const delta = nowFailed - _rbLastFailedRollbacks;
          _rbLastFailedRollbacks = nowFailed;
          _syncLog(`FAILED-ROLLBACK detected: +${delta} total=${nowFailed} (log-only, no resync)`);
        }
      }

      // ── Periodic input ack logging — track confirmed frame ──
      if (_frameNum % 60 === 0) {
        let minAckFromPeer = Infinity;
        let minRecvFromPeer = Infinity;
        const peerInfo = [];
        for (const p of getActivePeers()) {
          if (p.slot === null || p.slot === undefined) continue;
          const ack = p.lastAckFromPeer ?? -1;
          const recv = p.lastFrameFromPeer ?? -1;
          if (ack < minAckFromPeer) minAckFromPeer = ack;
          if (recv < minRecvFromPeer) minRecvFromPeer = recv;
          peerInfo.push(`s${p.slot}[ack=${ack},recv=${recv}]`);
        }
        const confirmed = Math.min(minAckFromPeer, minRecvFromPeer);
        const lag = _frameNum - confirmed;
        if (peerInfo.length > 0) {
          _syncLog(`INPUT-ACK f=${_frameNum} confirmed=${confirmed} lag=${lag} ${peerInfo.join(' ')}`);
        }
      }

      // ── Freeze detection (delegated to kn-diagnostics.js) ──────────
      _diag.checkFreeze(localInput);

      // ── Bisect-on-mismatch: when a divergence is detected, switch to
      // per-frame hash broadcasts for the next N frames so we can pinpoint
      // exactly when the next divergence happens. Without this, mismatch
      // detection only fires at 300-frame boundaries — we can detect THAT
      // divergence exists but not WHEN it was introduced. Per-frame hashing
      // shrinks the window from 300 frames to 1 frame, but is expensive
      // (~0.5 ms/frame), so we only run it briefly after a mismatch.
      const bisectThisFrame =
        _knDeepDiagnostics &&
        _rbBisectActive &&
        _rbBisectFramesRemaining > 0 &&
        _frameNum % 300 !== 0 &&
        _isRbCheckGameplayPhase();
      if (bisectThisFrame) {
        _rbBisectFramesRemaining--;
        if (_rbBisectFramesRemaining === 0) {
          _rbBisectActive = false;
          _syncLog(`RB-BISECT done at f=${_frameNum}`);
        }
        // Broadcast both the cheap hash AND the per-region snapshot.
        // Field test 754/755 had 1553 RB-REGION-DIFF entries stuck on
        // "peer regions not yet received" because the receiver had no
        // peer region data for the frame the bisect was checking. The
        // periodic rb-regions broadcast only fires every 300 frames;
        // bisect mode needs to send region snapshots per frame too.
        // Cost: ~2 KB extra per bisect frame for at most 30 frames.
        const hashFrame = _frameNum - 1;
        const checkFrame = hashFrame;
        const gpHash = tickMod._kn_gameplay_hash?.(hashFrame) ?? 0;
        if (gpHash !== 0 && _isRbCheckGameplayPhase()) {
          for (const p of getActivePeers()) {
            if (p.dc?.readyState === 'open') {
              try {
                p.dc.send(`rb-check:${checkFrame}:${gpHash}:${tickMod._kn_game_state_hash?.(hashFrame) ?? 0}`);
              } catch (_) {}
            }
          }
          // Region snapshot via the frame-specific export so the snapshot
          // matches the frame we just sent the hash for, not the most
          // recent ring slot.
          const NUM_REGIONS_BISECT = 256;
          if (!_rbRegionsBufPtr && tickMod._malloc) _rbRegionsBufPtr = tickMod._malloc(NUM_REGIONS_BISECT * 4);
          if (_rbRegionsBufPtr) {
            let ok = 0;
            if (tickMod._kn_state_region_hashes_frame) {
              ok = tickMod._kn_state_region_hashes_frame(hashFrame, _rbRegionsBufPtr, NUM_REGIONS_BISECT);
            } else if (tickMod._kn_state_region_hashes) {
              tickMod._kn_state_region_hashes(_rbRegionsBufPtr, NUM_REGIONS_BISECT);
              ok = NUM_REGIONS_BISECT;
            }
            if (ok > 0) {
              const regions = new Uint32Array(tickMod.HEAPU8.buffer, _rbRegionsBufPtr, NUM_REGIONS_BISECT);
              const regionsHex = Array.from(regions)
                .map((h) => h.toString(16))
                .join(',');
              if (!window._rbLocalRegions) window._rbLocalRegions = {};
              window._rbLocalRegions[checkFrame] = regionsHex;
              for (const p of getActivePeers()) {
                if (p.dc?.readyState === 'open') {
                  try {
                    p.dc.send(`rb-regions:${checkFrame}:${regionsHex}`);
                  } catch (_) {}
                }
              }
            }
          }
        }
      }

      // ── Post-rollback verification: immediately after a replay completes,
      // broadcast the rolled-forward state hash so peers can confirm the
      // rollback restoration produced bit-identical state. Without this,
      // a "toxic" rollback (one that introduces divergence) is invisible
      // until the next 300-frame checkpoint, making it impossible to
      // attribute the divergence to a specific rollback event.
      //
      // We ALSO broadcast per-64KB RDRAM block hashes + the per-region
      // savestate digest here, so the 2026-04-08 audit path (match
      // 002ad0f6) can pinpoint which block diverges AT the rollback
      // boundary instead of inferring it from the next 300-frame
      // checkpoint 180 frames later. Without per-rollback block data, we
      // can see divergence has happened by f=3599 but not whether it was
      // introduced at f=3420, f=3440, or f=3460.
      if (_rbPendingPostRollbackHash && !_isRbCheckGameplayPhase()) {
        _rbPendingPostRollbackHash = false;
      }
      if (_rbPendingPostRollbackHash) {
        _rbPendingPostRollbackHash = false;
        const hashFrame = _frameNum - 1;
        const checkFrame = hashFrame;
        const gpHash = tickMod._kn_gameplay_hash?.(hashFrame) ?? 0;
        const gameHash = _knDeepDiagnostics ? (tickMod._kn_game_state_hash?.(hashFrame) ?? 0) : 0;
        const fullHash = _knDeepDiagnostics ? (tickMod._kn_full_state_hash?.(hashFrame) ?? 0) : 0;
        const hiddenFp = _knDeepDiagnostics ? (tickMod._kn_get_hidden_state_fingerprint?.() ?? 0) : 0;
        const sfState = _knDeepDiagnostics ? (tickMod._kn_get_softfloat_state?.() ?? 0) : 0;
        const taintedCount = _knDeepDiagnostics ? (tickMod._kn_get_tainted_block_count?.() ?? 0) : 0;
        if (gpHash !== 0 && _isRbCheckGameplayPhase()) {
          _syncLog(
            `RB-POST-RB f=${hashFrame} gp=0x${gpHash.toString(16)} game=0x${gameHash.toString(16)} full=0x${fullHash.toString(16)} hidden=0x${hiddenFp.toString(16)} sf=0x${sfState.toString(16)} taint=${taintedCount} (verifying restoration)`,
          );
          // Cache for RB-CHECK comparison (see periodic broadcast below for
          // why — same race window applies on the post-rollback path).
          if (!window._rbLocalGameHashes) window._rbLocalGameHashes = {};
          window._rbLocalGameHashes[checkFrame] = gpHash;
          for (const p of getActivePeers()) {
            if (p.dc?.readyState === 'open') {
              try {
                p.dc.send(`rb-check:${checkFrame}:${gpHash}:${gameHash}`);
              } catch (_) {}
            }
          }

          // Block-level snapshot + broadcast (duplicates the 300-frame
          // periodic logic at a per-rollback cadence). Cache locally and
          // broadcast so the peer can diff at this exact frame. Skips if
          // the WASM exports or malloc aren't available (old core).
          if (_knDeepDiagnostics && tickMod._kn_rdram_block_hashes && tickMod._kn_get_taint_blocks && tickMod._malloc) {
            if (!_rbHashBufPtr) _rbHashBufPtr = tickMod._malloc(RDRAM_TAINT_BLOCKS * 4);
            if (!_rbTaintBufPtr) _rbTaintBufPtr = tickMod._malloc(RDRAM_TAINT_BLOCKS);
            if (_rbHashBufPtr && _rbTaintBufPtr) {
              tickMod._kn_rdram_block_hashes(_rbHashBufPtr, RDRAM_TAINT_BLOCKS);
              tickMod._kn_get_taint_blocks(_rbTaintBufPtr, RDRAM_TAINT_BLOCKS);
              const blocks = new Uint32Array(tickMod.HEAPU8.buffer, _rbHashBufPtr, RDRAM_TAINT_BLOCKS);
              const taint = new Uint8Array(tickMod.HEAPU8.buffer, _rbTaintBufPtr, RDRAM_TAINT_BLOCKS);
              const blocksSnap = Array.from(blocks);
              const taintSnap = Array.from(taint);
              const blocksHex = blocksSnap.map((h) => h.toString(16).padStart(8, '0')).join('');
              const taintHex = taintSnap.map((t) => (t ? '1' : '0')).join('');
              _syncLog(`C-BLOCKS f=${hashFrame} taint=${taintHex} (post-rollback)`);
              window._rbLocalBlocks[checkFrame] = blocksSnap;
              window._rbLocalTaint[checkFrame] = taintSnap;
              for (const p of getActivePeers()) {
                if (p.dc?.readyState === 'open') {
                  try {
                    p.dc.send(`rb-blocks:${checkFrame}:${blocksHex}`);
                  } catch (_) {}
                }
              }
            }
          }

          // Per-region savestate digest (frame-specific variant so the
          // regions match the post-rollback state of hashFrame, not the
          // most recent ring slot). This is what lets the peer see which
          // slice of the savestate — RDRAM r0..r31 vs post-RDRAM r32 —
          // drifted at the rollback boundary.
          const NUM_REGIONS_POSTRB = 256;
          if (_knDeepDiagnostics && !_rbRegionsBufPtr && tickMod._malloc) {
            _rbRegionsBufPtr = tickMod._malloc(NUM_REGIONS_POSTRB * 4);
          }
          if (_knDeepDiagnostics && _rbRegionsBufPtr && tickMod._kn_state_region_hashes_frame) {
            const ok = tickMod._kn_state_region_hashes_frame(hashFrame, _rbRegionsBufPtr, NUM_REGIONS_POSTRB);
            if (ok > 0) {
              const regions = new Uint32Array(tickMod.HEAPU8.buffer, _rbRegionsBufPtr, NUM_REGIONS_POSTRB);
              const regionsHex = Array.from(regions)
                .map((h) => h.toString(16))
                .join(',');
              if (!window._rbLocalRegions) window._rbLocalRegions = {};
              window._rbLocalRegions[checkFrame] = regionsHex;
              for (const p of getActivePeers()) {
                if (p.dc?.readyState === 'open') {
                  try {
                    p.dc.send(`rb-regions:${checkFrame}:${regionsHex}`);
                  } catch (_) {}
                }
              }
            }
          }
        }
      }

      // ── Periodic logging with timing + per-region hash exchange ──
      // Tighter interval during menus (30 frames) to catch CSS/stage-select
      // divergence before it compounds. 300 frames during gameplay.
      const _hashInterval = _inGameplay ? 300 : _isLocalDev ? 30 : 60;
      if (_frameNum % _hashInterval === 0) {
        const rbCount = tickMod._kn_get_rollback_count?.() ?? 0;
        const predCount = tickMod._kn_get_prediction_count?.() ?? 0;
        const correctCount = tickMod._kn_get_correct_predictions?.() ?? 0;
        const maxD = tickMod._kn_get_max_depth?.() ?? 0;
        const hashFrame = _frameNum - 1;
        const checkFrame = hashFrame;
        // Gameplay hash for RB-CHECK: hashes ONLY game-relevant RDRAM
        // addresses (damage, stocks, timer, RNG seeds). Immune to audio/
        // video/heap noise. game_state_hash + full_state_hash kept for
        // diagnostic monitoring.
        const gpHash = tickMod._kn_gameplay_hash?.(hashFrame) ?? 0;
        const gameHash = _knDeepDiagnostics ? (tickMod._kn_game_state_hash?.(hashFrame) ?? 0) : 0;
        const fullHash = _knDeepDiagnostics ? (tickMod._kn_full_state_hash?.(hashFrame) ?? 0) : 0;
        const taintedCount = _knDeepDiagnostics ? (tickMod._kn_get_tainted_block_count?.() ?? 0) : 0;
        const hiddenFp = _knDeepDiagnostics ? (tickMod._kn_get_hidden_state_fingerprint?.() ?? 0) : 0;
        const sfState = _knDeepDiagnostics ? (tickMod._kn_get_softfloat_state?.() ?? 0) : 0;
        // Per-region hashes — splits state buffer into 256 chunks
        // (~34 KB regions for an ~8.6 MB savestate). At 32 regions the
        // entire post-RDRAM section (CPU/cp0/cp1/event queue/fb) fit in
        // one region, hiding which subsystem was diverging. 256 regions
        // gives us ~7 regions covering the 256 KB post-RDRAM section, so
        // a single mismatch pinpoints subsystem-level granularity.
        const NUM_REGIONS = 256;
        if (_knDeepDiagnostics && !_rbRegionsBufPtr && tickMod._malloc) {
          _rbRegionsBufPtr = tickMod._malloc(NUM_REGIONS * 4);
        }
        let regionsHex = '';
        if (_knDeepDiagnostics && _rbRegionsBufPtr && tickMod._kn_state_region_hashes) {
          tickMod._kn_state_region_hashes(_rbRegionsBufPtr, NUM_REGIONS);
          const regions = new Uint32Array(tickMod.HEAPU8.buffer, _rbRegionsBufPtr, NUM_REGIONS);
          regionsHex = Array.from(regions)
            .map((h) => h.toString(16))
            .join(',');
        }
        _syncLog(
          `C-PERF f=${_frameNum} preTick=${(_tPreTick - _t0).toFixed(1)}ms step=${(_tStep - _tStep0).toFixed(1)}ms total=${(_tTotal - _t0).toFixed(1)}ms | rb=${rbCount} pred=${predCount} correct=${correctCount} maxD=${maxD} hashF=${hashFrame} gp=0x${gpHash.toString(16)} game=0x${gameHash.toString(16)} full=0x${fullHash.toString(16)} taint=${taintedCount} hidden=0x${hiddenFp.toString(16)} sf=0x${sfState.toString(16)} eq=0x${(tickMod._kn_eventqueue_hash?.() >>> 0).toString(16)} serSkip=${tickMod._kn_get_serialize_skip_count?.() ?? '?'}`,
        );
        if (regionsHex) {
          _syncLog(`C-REGIONS f=${checkFrame} ${regionsHex}`);
          // Stash our own snapshot keyed by frame so the RB-CHECK mismatch
          // handler can diff against the peer's regions for the SAME frame.
          // Without this, comparing regions across slightly different frames
          // would always show divergence (regions evolve every frame).
          if (!window._rbLocalRegions) window._rbLocalRegions = {};
          window._rbLocalRegions[checkFrame] = regionsHex;
          // Trim old snapshots — keep only the last ~16 frames to bound memory
          const keys = Object.keys(window._rbLocalRegions)
            .map(Number)
            .sort((a, b) => a - b);
          if (keys.length > 16) {
            for (const k of keys.slice(0, keys.length - 16)) {
              delete window._rbLocalRegions[k];
            }
          }
          // Broadcast regions for cross-player comparison
          for (const p of getActivePeers()) {
            if (p.dc?.readyState === 'open') {
              try {
                p.dc.send(`rb-regions:${checkFrame}:${regionsHex}`);
              } catch (_) {}
            }
          }
        }
        // Broadcast gameplay hash for peer comparison.
        // This is the authoritative desync detection hash — only game-relevant
        // RDRAM addresses. game_state_hash kept for diagnostic monitoring.
        //
        // Cache the hash we sent so RB-CHECK can compare against it instead
        // of re-hashing the ring buffer when the peer's reply arrives. Without
        // this cache, a rollback that occurs between broadcast and receipt
        // would invalidate the local state for that frame, producing a
        // phantom MISMATCH (host hash post-rollback vs peer hash from before
        // the rollback). The peer's hash IS the canonical "what did this frame
        // look like at the moment of broadcast" — so the right comparison is
        // "what we broadcast" vs "what they broadcast" at the same instant.
        if (_isRbCheckGameplayPhase()) {
          if (!window._rbLocalGameHashes) window._rbLocalGameHashes = {};
          window._rbLocalGameHashes[checkFrame] = gpHash;
          // Trim — keep only the most recent ~16 frames to bound memory.
          const _rbHashKeys = Object.keys(window._rbLocalGameHashes)
            .map(Number)
            .sort((a, b) => a - b);
          if (_rbHashKeys.length > 16) {
            for (const k of _rbHashKeys.slice(0, _rbHashKeys.length - 16)) {
              delete window._rbLocalGameHashes[k];
            }
          }
          for (const p of getActivePeers()) {
            if (p.dc?.readyState === 'open') {
              try {
                p.dc.send(`rb-check:${checkFrame}:${gpHash}:${gameHash}`);
              } catch (_) {}
            }
          }
        }

        // Block-level diagnostic: hash every 64 KB of RDRAM (128 blocks) and
        // dump the taint bitmap. Share with peer so that when RB-CHECK misses
        // we can pinpoint which untainted block is diverging and map it back
        // to the subsystem that owns that address.
        if (_knDeepDiagnostics && tickMod._kn_rdram_block_hashes && tickMod._kn_get_taint_blocks && tickMod._malloc) {
          if (!_rbHashBufPtr) _rbHashBufPtr = tickMod._malloc(RDRAM_TAINT_BLOCKS * 4);
          if (!_rbTaintBufPtr) _rbTaintBufPtr = tickMod._malloc(RDRAM_TAINT_BLOCKS);
          if (_rbHashBufPtr && _rbTaintBufPtr) {
            tickMod._kn_rdram_block_hashes(_rbHashBufPtr, RDRAM_TAINT_BLOCKS);
            tickMod._kn_get_taint_blocks(_rbTaintBufPtr, RDRAM_TAINT_BLOCKS);
            const blocks = new Uint32Array(tickMod.HEAPU8.buffer, _rbHashBufPtr, RDRAM_TAINT_BLOCKS);
            const taint = new Uint8Array(tickMod.HEAPU8.buffer, _rbTaintBufPtr, RDRAM_TAINT_BLOCKS);
            // Snapshot — use Array.from so later mutation of HEAPU8 can't
            // corrupt what we stored for comparison against the peer.
            const blocksSnap = Array.from(blocks);
            const taintSnap = Array.from(taint);
            // Compact hex representation (8 chars per block → 1024 chars total)
            const blocksHex = blocksSnap.map((h) => h.toString(16).padStart(8, '0')).join('');
            const taintHex = taintSnap.map((t) => (t ? '1' : '0')).join('');
            // Taint bitmap is 128 chars — tiny. Full block hashes are
            // 1024 chars per line; we keep them out of the steady-state log
            // and only dump via RB-BYTES on actual mismatch.
            _syncLog(`C-BLOCKS f=${hashFrame} taint=${taintHex}`);
            // Cache our own snapshot keyed by hashFrame so RB-DIFF can
            // compare frame-exactly against the peer's snapshot instead of
            // re-sampling live RDRAM (which would be frames ahead by then).
            window._rbLocalBlocks[checkFrame] = blocksSnap;
            window._rbLocalTaint[checkFrame] = taintSnap;
            // Broadcast block hashes to peer for per-block divergence diff
            for (const p of getActivePeers()) {
              if (p.dc?.readyState === 'open') {
                try {
                  p.dc.send(`rb-blocks:${checkFrame}:${blocksHex}`);
                } catch (_) {}
              }
            }
          }
        }
      }

      // Check pending peer hashes only after the frame has aged out of the
      // local correction window. A peer may send rb-check immediately after
      // its own rollback while we have not received/applied the matching late
      // input yet; comparing at age 1-3 frames flags the old prediction, not
      // the final corrected state. Once old enough, compare against the newest
      // ring entry for that frame, since rollback endpoint saves can replace
      // the earlier predicted hash.
      if (window._rbPendingChecks) {
        for (const fStr of Object.keys(window._rbPendingChecks)) {
          const f = parseInt(fStr);
          const checkAge = _frameNum - f;
          // Match the stall threshold's depth budget so we wait long enough
          // for rollback-driven hash corrections to finalize before treating
          // a peer's rb-check as authoritative. True-rollback widens this
          // window to delay+10 (cap 12); legacy stays at delay+4.
          const _checkAgeBudget = RB_TRUE_ROLLBACK ? Math.min(DELAY_FRAMES + 10, 12) : DELAY_FRAMES + 4;
          const minCheckAge = Math.min(Math.max(_checkAgeBudget, 4), Math.max(_rbRollbackMax - 1, 4));
          if (checkAge > _rbRollbackMax) {
            delete window._rbPendingChecks[fStr];
            delete window._rbPendingGameChecks?.[fStr];
            _syncLog(`RB-CHECK f=${f} STALE (missed finalized window age=${checkAge})`);
            continue;
          }
          if (checkAge >= minCheckAge) {
            const peerHash = window._rbPendingChecks[fStr];
            delete window._rbPendingChecks[fStr];
            const localHash = tickMod._kn_gameplay_hash?.(f) ?? window._rbLocalGameHashes?.[f] ?? 0;
            if (localHash === 0) {
              _syncLog(`RB-CHECK f=${f} STALE (frame not in ring) peer=0x${peerHash.toString(16)}`);
            } else if (localHash === peerHash) {
              // Gameplay hash matches — also check game_state_hash for
              // broader divergence (player positions, animation, objects).
              const peerGameHash = window._rbPendingGameChecks?.[fStr];
              if (peerGameHash != null) {
                delete window._rbPendingGameChecks[fStr];
                const localGameHash = tickMod._kn_game_state_hash?.(f) ?? 0;
                if (localGameHash !== 0 && peerGameHash !== 0 && localGameHash !== peerGameHash) {
                  // Throttle STATE-DRIFT logging: first + every 300 frames on prod
                  if (!window._stateDriftCount) window._stateDriftCount = 0;
                  window._stateDriftCount++;
                  const shouldLog = _isLocalDev || window._stateDriftCount <= 3 || window._stateDriftCount % 10 === 0;
                  if (shouldLog) {
                    _syncLog(
                      `RB-STATE-DRIFT f=${f} gp=MATCH game=DIFFER peer=0x${peerGameHash.toString(16)} local=0x${localGameHash.toString(16)} — non-gameplay RDRAM diverged (#${window._stateDriftCount})`,
                    );
                  }
                  // Fire GP-DUMP for context (first 3 + every 10th)
                  if (shouldLog && _rdramBase) {
                    const m = window.EJS_emulator?.gameManager?.Module;
                    if (m?.HEAPU32) {
                      const r32 = (off) => m.HEAPU32[(_rdramBase + (off & ~3)) >> 2];
                      const r8 = (off) => m.HEAPU8[_rdramBase + off];
                      const vals = [
                        `scr=${r32(0xa4ad0).toString(16)}`,
                        `gs=${r32(0xa4d18).toString(16)}`,
                        `stk=${r8(0xa4d53)},${r8(0xa4dc7)},${r8(0xa4e3b)},${r8(0xa4eaf)}`,
                        `dmg=${r32(0x130db0).toString(16)},${r32(0x131900).toString(16)}`,
                        `rng=${r32(KN_RNG_SEED_RDRAM).toString(16)},${r32(KN_RNG_ALT_SEED_RDRAM).toString(16)}`,
                      ];
                      _syncLog(`GP-DRIFT f=${f} ${vals.join(' ')}`);
                      // CSS player struct state for menu desync diagnosis
                      const cssVals = [
                        `p1_css:cid=${r32(0x13bad0).toString(16)},cur=${r32(0x13badc).toString(16)},sel=${r32(0x13bae0).toString(16)},rec=${r32(0x13bae4).toString(16)},s7c=${r32(0x13bb04).toString(16)},tok=${r32(0x13bb08).toString(16)},pan=${r32(0x13bb0c).toString(16)},sf2=${r32(0x13bb10).toString(16)}`,
                        `p2_css:cid=${r32(0x13bb8c).toString(16)},cur=${r32(0x13bb98).toString(16)},sel=${r32(0x13bb9c).toString(16)},rec=${r32(0x13bba0).toString(16)},s7c=${r32(0x13bbc0).toString(16)},tok=${r32(0x13bbc4).toString(16)},pan=${r32(0x13bbc8).toString(16)},sf2=${r32(0x13bbcc).toString(16)}`,
                        `p3_css:cid=${r32(0x13bc48).toString(16)},cur=${r32(0x13bc54).toString(16)},sel=${r32(0x13bc58).toString(16)},rec=${r32(0x13bc5c).toString(16)},s7c=${r32(0x13bc7c).toString(16)},tok=${r32(0x13bc80).toString(16)},pan=${r32(0x13bc84).toString(16)},sf2=${r32(0x13bc88).toString(16)}`,
                        `p4_css:cid=${r32(0x13bd04).toString(16)},cur=${r32(0x13bd10).toString(16)},sel=${r32(0x13bd14).toString(16)},rec=${r32(0x13bd18).toString(16)},s7c=${r32(0x13bd38).toString(16)},tok=${r32(0x13bd3c).toString(16)},pan=${r32(0x13bd40).toString(16)},sf2=${r32(0x13bd44).toString(16)}`,
                        `fc=${r32(0x3cb30).toString(16)}`,
                        `sfc=${r32(0x3b6e4).toString(16)}`,
                      ];
                      if (!window._knLastGpCssFrame || f - window._knLastGpCssFrame >= 60) {
                        window._knLastGpCssFrame = f;
                        _syncLog(`GP-CSS f=${f} ${cssVals.join(' ')}`);
                      }
                    }
                  }
                  // Arm bisect mode on STATE-DRIFT so the byte-level
                  // pipeline (REGION-DIFF, SUBHASH-DIFF, REGION-BYTES)
                  // fires for the next 30 frames. Same pipeline as
                  // gameplay_hash MISMATCH but triggered by game_state_hash.
                  if (_knDeepDiagnostics && !_rbBisectActive && _rbBisectCount < RB_BISECT_MAX_PER_MATCH) {
                    _rbBisectActive = true;
                    _rbBisectFramesRemaining = 30;
                    _rbBisectCount++;
                    _syncLog(`RB-BISECT armed for ${_rbBisectFramesRemaining} frames after STATE-DRIFT at f=${f}`);
                  }
                } else {
                  _syncLog(`RB-CHECK f=${f} MATCH hash=0x${peerHash.toString(16)} game=MATCH`);
                }
              } else {
                _syncLog(`RB-CHECK f=${f} MATCH hash=0x${peerHash.toString(16)}`);
              }
              // Track last-known-good frame so post-mortem analysis can
              // bound the divergence window without scanning the whole log.
              if (f > _rbLastGoodFrame) _rbLastGoodFrame = f;
              _rbBisectActive = false;
              _rbBisectFramesRemaining = 0;
            } else {
              _syncLog(
                `RB-CHECK f=${f} MISMATCH peer=0x${peerHash.toString(16)} local=0x${localHash.toString(16)} lastGood=${_rbLastGoodFrame}`,
              );
              // Dump actual gameplay address values on first mismatch so we
              // can see exactly which byte diverges. Read live RDRAM directly.
              if (_rdramBase) {
                const m = window.EJS_emulator?.gameManager?.Module;
                if (m?.HEAPU32) {
                  const r32 = (off) => m.HEAPU32[(_rdramBase + (off & ~3)) >> 2];
                  const r8 = (off) => m.HEAPU8[_rdramBase + off];
                  const vals = [
                    `scr=${r32(0xa4ad0).toString(16)}`,
                    `gs=${r32(0xa4d18).toString(16)}`,
                    `vs=${r32(0xa4d08).toString(16)},${r32(0xa4d0c).toString(16)},${r32(0xa4d10).toString(16)},${r32(0xa4d14).toString(16)},${r32(0xa4d18).toString(16)},${r32(0xa4d1c).toString(16)},${r32(0xa4d20).toString(16)}`,
                    `stk=${r8(0xa4d53)},${r8(0xa4dc7)},${r8(0xa4e3b)},${r8(0xa4eaf)}`,
                    `chr=${r32(0x130d8c).toString(16)},${r32(0x1318dc).toString(16)},${r32(0x13242c).toString(16)},${r32(0x132f7c).toString(16)}`,
                    `dmg=${r32(0x130db0).toString(16)},${r32(0x131900).toString(16)},${r32(0x132450).toString(16)},${r32(0x132fa0).toString(16)}`,
                    `rng=${r32(KN_RNG_SEED_RDRAM).toString(16)},${r32(KN_RNG_ALT_SEED_RDRAM).toString(16)}`,
                  ];
                  _syncLog(`GP-DUMP f=${f} ${vals.join(' ')}`);
                  // CSS player struct state (VS mode, 0x8013BA88 base, 0xBC stride)
                  // char_id(+0x48) cursor_state(+0x54) selected(+0x58) held_token(+0x80)
                  const cssVals = [
                    `p1_css:cid=${r32(0x13bad0).toString(16)},cur=${r32(0x13badc).toString(16)},sel=${r32(0x13bae0).toString(16)},rec=${r32(0x13bae4).toString(16)},s7c=${r32(0x13bb04).toString(16)},tok=${r32(0x13bb08).toString(16)},pan=${r32(0x13bb0c).toString(16)},sf2=${r32(0x13bb10).toString(16)}`,
                    `p2_css:cid=${r32(0x13bb8c).toString(16)},cur=${r32(0x13bb98).toString(16)},sel=${r32(0x13bb9c).toString(16)},rec=${r32(0x13bba0).toString(16)},s7c=${r32(0x13bbc0).toString(16)},tok=${r32(0x13bbc4).toString(16)},pan=${r32(0x13bbc8).toString(16)},sf2=${r32(0x13bbcc).toString(16)}`,
                    `p3_css:cid=${r32(0x13bc48).toString(16)},cur=${r32(0x13bc54).toString(16)},sel=${r32(0x13bc58).toString(16)},rec=${r32(0x13bc5c).toString(16)},s7c=${r32(0x13bc7c).toString(16)},tok=${r32(0x13bc80).toString(16)},pan=${r32(0x13bc84).toString(16)},sf2=${r32(0x13bc88).toString(16)}`,
                    `p4_css:cid=${r32(0x13bd04).toString(16)},cur=${r32(0x13bd10).toString(16)},sel=${r32(0x13bd14).toString(16)},rec=${r32(0x13bd18).toString(16)},s7c=${r32(0x13bd38).toString(16)},tok=${r32(0x13bd3c).toString(16)},pan=${r32(0x13bd40).toString(16)},sf2=${r32(0x13bd44).toString(16)}`,
                    `fc=${r32(0x3cb30).toString(16)}`,
                    `sfc=${r32(0x3b6e4).toString(16)}`,
                  ];
                  _syncLog(`GP-CSS f=${f} ${cssVals.join(' ')}`);
                }
              }
              // Arm bisect mode: per-frame hash broadcasts for the next 30
              // frames. The next divergence will be flagged at frame-exact
              // precision instead of 300-frame coarse granularity.
              //
              // Match-level cap: a SUSTAINED divergence (e.g., cycle-clock
              // drift in cp0/event queue) re-arms bisect on every detection,
              // turning a single root cause into thousands of per-frame
              // broadcasts that eat the frame budget. Cap at
              // RB_BISECT_MAX_PER_MATCH cycles — the first few captures give
              // us the data we need, later firings are wasted CPU. Field
              // test in match 768 fired bisect 1203× from one root cause.
              if (_knDeepDiagnostics && !_rbBisectActive && _rbBisectCount < RB_BISECT_MAX_PER_MATCH) {
                _rbBisectActive = true;
                _rbBisectFramesRemaining = 30;
                _rbBisectCount++;
                _syncLog(`RB-BISECT armed for ${_rbBisectFramesRemaining} frames after mismatch at f=${f}`);
              }
              // Intentionally LOG-ONLY in rollback mode. In-game resyncs feel
              // worse than gradual divergence — they snap the player out of
              // their muscle-memory loop. The point of rollback is invisible
              // recovery via prediction + replay; if the underlying state
              // determinism gap can't sustain that, the answer is to fix the
              // determinism gap, not to paper over it with snaps. The
              // RB-DIFF + RB-BYTES diagnostics below pinpoint WHERE state
              // diverges so we can chase it at the C level.
              // On mismatch, diff our cached block-hash snapshot (sampled at
              // the same frame we sent it to the peer) against the peer's
              // snapshot (sampled at their same frame). This is frame-exact
              // — no temporal skew. If peer hasn't arrived yet, the diff
              // will run when the message comes in (see rb-blocks handler).
              if (_knDeepDiagnostics) {
                const peerBlocksHex = window._rbPendingBlocks?.[fStr];
                const localSnap = window._rbLocalBlocks?.[f];
                const localTaint = window._rbLocalTaint?.[f];
                if (peerBlocksHex && localSnap && localTaint) {
                  const diffs = [];
                  for (let b = 0; b < 128; b++) {
                    const hexStart = b * 8;
                    const peerHex = peerBlocksHex.slice(hexStart, hexStart + 8);
                    const peerVal = parseInt(peerHex, 16) >>> 0;
                    const localVal = localSnap[b] >>> 0;
                    if (peerVal !== localVal) {
                      diffs.push(
                        `blk${b}(0x${(b * 0x10000).toString(16)}${localTaint[b] ? ' TAINTED' : ''})=peer:${peerHex}/local:${localVal.toString(16).padStart(8, '0')}`,
                      );
                    }
                  }
                  if (diffs.length) {
                    _syncLog(
                      `RB-DIFF f=${f} ${diffs.length}/128 blocks differ: ${diffs.slice(0, 24).join(' ')}${diffs.length > 24 ? ` …+${diffs.length - 24}` : ''}`,
                    );
                    // Auto-dump first 256 bytes of each diverging UNTAINTED
                    // block. Tainted blocks are expected to differ — we don't
                    // need their bytes. Untainted divergence is the smoking
                    // gun and we want byte-level evidence.
                    if (tickMod._kn_get_rdram_ptr) {
                      const rdramPtr = tickMod._kn_get_rdram_ptr();
                      for (let b = 0; b < 128; b++) {
                        if (localTaint[b]) continue;
                        const hexStart = b * 8;
                        const peerHex = peerBlocksHex.slice(hexStart, hexStart + 8);
                        const peerVal = parseInt(peerHex, 16) >>> 0;
                        const localVal = localSnap[b] >>> 0;
                        if (peerVal === localVal) continue;
                        const off = rdramPtr + b * 0x10000;
                        const slice = new Uint8Array(tickMod.HEAPU8.buffer, off, 256);
                        const hex = Array.from(slice)
                          .map((x) => x.toString(16).padStart(2, '0'))
                          .join('');
                        _syncLog(`RB-BYTES f=${f} blk${b}(0x${(b * 0x10000).toString(16)}): ${hex}`);
                      }
                    }
                  } else {
                    _syncLog(`RB-DIFF f=${f} NO block diffs (hash mismatch must be outside RDRAM)`);
                  }
                } else if (!peerBlocksHex) {
                  _syncLog(`RB-DIFF f=${f} (peer blocks not yet received)`);
                } else if (!localSnap) {
                  _syncLog(`RB-DIFF f=${f} (local snapshot missing — non-checkpoint mismatch)`);
                }

                // ── Region diff (covers WHOLE savestate, not just RDRAM) ──
                // The block diff above only sees RDRAM divergence. The 87
                // mismatches in the 2026-04-07 field test all reported "NO
                // block diffs", meaning divergence was in the non-RDRAM
                // portion of the savestate (CPU regs / cp0 / cp1 / TLB /
                // event queue / fb tracker). This region diff localizes
                // exactly which 1/32-of-state slice diverged so we can map
                // the divergence to a subsystem and decide whether to taint
                // or fix it at the C level.
                const peerRegionsCsv = window._rbPendingRegions?.[fStr];
                const localRegionsCsv = window._rbLocalRegions?.[f];
                if (peerRegionsCsv && localRegionsCsv) {
                  const peerRegions = peerRegionsCsv.split(',');
                  const localRegions = localRegionsCsv.split(',');
                  if (peerRegions.length === localRegions.length) {
                    const NUM_REGIONS = peerRegions.length;
                    // Map region index → subsystem name based on savestate layout.
                    // mupen64plus savestate buffer is roughly:
                    //   header + ROM info + DMA regs (~64 KB)  → region 0
                    //   RDRAM (8 MB) → bulk of regions
                    //   SP mem + PIF + TLB LUT + cp0 + cp1 + cp2 + event queue
                    //   + fb tracker (~256 KB) → last 1-2 regions
                    // We use the C-side rdram_offset_in_state to compute exact
                    // boundaries. Falls back to "region N" if offsets unknown.
                    const stateSize = tickMod._kn_get_state_buffer_size?.() ?? 0;
                    const rdramOff = tickMod._kn_get_rdram_offset_in_state?.() ?? 0;
                    const regionSize = stateSize > 0 ? Math.floor(stateSize / NUM_REGIONS) : 0;
                    const regionLabel = (idx) => {
                      if (regionSize === 0) return `r${idx}`;
                      const start = idx * regionSize;
                      const end = idx === NUM_REGIONS - 1 ? stateSize : (idx + 1) * regionSize;
                      if (rdramOff > 0 && start < rdramOff) return `r${idx}:HEADER`;
                      if (rdramOff > 0 && start >= rdramOff && end <= rdramOff + 0x800000) return `r${idx}:RDRAM`;
                      if (rdramOff > 0 && start >= rdramOff + 0x800000) return `r${idx}:POST-RDRAM`;
                      return `r${idx}`;
                    };
                    const diffs = [];
                    const diffIdxs = [];
                    for (let i = 0; i < NUM_REGIONS; i++) {
                      if (peerRegions[i] !== localRegions[i]) {
                        diffs.push(`${regionLabel(i)}:peer=${peerRegions[i]}/local=${localRegions[i]}`);
                        diffIdxs.push(i);
                      }
                    }
                    if (diffs.length) {
                      _syncLog(
                        `RB-REGION-DIFF f=${f} ${diffs.length}/${NUM_REGIONS} regions differ rdramOff=0x${rdramOff.toString(16)} stateSize=${stateSize} regionSize=${regionSize}: ${diffs.slice(0, 16).join(' ')}${diffs.length > 16 ? ` …+${diffs.length - 16}` : ''}`,
                      );

                      // ── Byte dump for diverging regions ──
                      // Read raw bytes from the local savestate buffer for the
                      // first 8 diverging regions and log them as hex. The peer
                      // does the same on its side; we correlate via match_id
                      // when post-mortem-analyzing the session logs. This is
                      // the smoking gun: it tells us EXACTLY which bytes differ
                      // and lets us trace them back to a struct field in the
                      // mupen64plus savestate format.
                      if (tickMod._kn_get_state_for_frame) {
                        const statePtr = tickMod._kn_get_state_for_frame(f);
                        if (statePtr) {
                          // Sub-region bisect: each region is ~64 KB. Dumping
                          // only the first 256 bytes left the actual diverging
                          // bytes invisible — the 757/756 field test had the
                          // first-256 bytes byte-identical between peers but
                          // the region hashes still differed, meaning the
                          // diverging bytes were elsewhere in the chunk.
                          //
                          // Strategy: subdivide the diverging region into
                          // 256-byte sub-chunks, hash each with FNV-1a, send
                          // the sub-chunk hashes to the peer, and dump bytes
                          // for the sub-chunks that differ. We piggyback on
                          // rb-subhash:<frame>:<ri>:<csv> for the sub-hashes,
                          // matching peers via the existing _rbPending* maps.
                          //
                          // For now (single-pass without peer correlation),
                          // dump bytes at MULTIPLE offsets within the region:
                          // the start, plus 7 spread offsets, so we get a
                          // 256B × 8 = 2 KB sample of the 64 KB region. Most
                          // divergences should land in one of those samples.
                          const dumpCount = Math.min(8, diffIdxs.length);
                          const SUB_DUMPS_PER_REGION = 8;
                          for (let di = 0; di < dumpCount; di++) {
                            const ri = diffIdxs[di];
                            const regionStart = ri * regionSize;
                            // Sub-chunk hash array — lets the analyzer narrow
                            // divergence to a 256-byte window inside the region
                            // post-mortem (peer dumps are correlated by
                            // matchId + frame + region index).
                            try {
                              const subSize = 256;
                              const subCount = Math.floor(regionSize / subSize);
                              const subHashes = new Array(subCount);
                              const fullSlice = new Uint8Array(
                                tickMod.HEAPU8.buffer,
                                statePtr + regionStart,
                                regionSize,
                              );
                              for (let si = 0; si < subCount; si++) {
                                let hash = 2166136261;
                                const base = si * subSize;
                                for (let bi = 0; bi < subSize; bi++) {
                                  hash = Math.imul(hash ^ fullSlice[base + bi], 16777619) >>> 0;
                                }
                                subHashes[si] = hash;
                              }
                              // Stash + broadcast sub-hashes
                              if (!window._rbLocalSubHashes) window._rbLocalSubHashes = {};
                              const key = `${f}:${ri}`;
                              window._rbLocalSubHashes[key] = subHashes;
                              const subCsv = subHashes.map((h) => h.toString(16)).join(',');
                              for (const p of getActivePeers()) {
                                if (p.dc?.readyState === 'open') {
                                  try {
                                    p.dc.send(`rb-subhash:${f}:${ri}:${subCsv}`);
                                  } catch (_) {}
                                }
                              }
                              // Compare against peer sub-hashes if we have them
                              // — usually we don't yet on first detection, but
                              // the peer's response will correlate post-mortem.
                              const peerSubCsv = window._rbPendingSubHashes?.[key];
                              const divergingSubs = [];
                              if (peerSubCsv) {
                                const peerSubHashes = peerSubCsv.split(',');
                                for (let si = 0; si < Math.min(subCount, peerSubHashes.length); si++) {
                                  const peerVal = parseInt(peerSubHashes[si], 16) >>> 0;
                                  if (peerVal !== subHashes[si] >>> 0) divergingSubs.push(si);
                                }
                              }
                              // Decide which sub-chunks to dump:
                              //  - If we have peer sub-hashes and find divergences,
                              //    dump JUST those (precise targeting)
                              //  - Otherwise dump SUB_DUMPS_PER_REGION samples
                              //    spread across the region (broad coverage)
                              const dumpIdxs = divergingSubs.length
                                ? divergingSubs.slice(0, 3)
                                : Array.from({ length: Math.min(SUB_DUMPS_PER_REGION, 3) }, (_, k) =>
                                    Math.floor((k * subCount) / SUB_DUMPS_PER_REGION),
                                  );
                              for (const si of dumpIdxs) {
                                const subOff = si * subSize;
                                const slice = new Uint8Array(
                                  tickMod.HEAPU8.buffer,
                                  statePtr + regionStart + subOff,
                                  subSize,
                                );
                                const hex = Array.from(slice)
                                  .map((x) => x.toString(16).padStart(2, '0'))
                                  .join('');
                                _syncLog(
                                  `RB-REGION-BYTES f=${f} ${regionLabel(ri)} sub=${si}/${subCount} off=0x${(regionStart + subOff).toString(16)} len=${subSize}: ${hex}`,
                                );
                              }
                              if (divergingSubs.length) {
                                _syncLog(
                                  `RB-SUBHASH-DIFF f=${f} r${ri} ${divergingSubs.length}/${subCount} sub-chunks differ: ${divergingSubs.slice(0, 16).join(',')}${divergingSubs.length > 16 ? `…+${divergingSubs.length - 16}` : ''}`,
                                );
                              }
                            } catch (err) {
                              _syncLog(`RB-REGION-BYTES f=${f} r${ri} read failed: ${err}`);
                            }
                          }
                        }
                      }
                    } else {
                      _syncLog(`RB-REGION-DIFF f=${f} NO region diffs (hash sampling artefact?)`);
                    }
                  } else {
                    _syncLog(
                      `RB-REGION-DIFF f=${f} region count mismatch peer=${peerRegions.length} local=${localRegions.length}`,
                    );
                  }
                } else if (!peerRegionsCsv) {
                  _syncLog(`RB-REGION-DIFF f=${f} (peer regions not yet received)`);
                } else if (!localRegionsCsv) {
                  _syncLog(`RB-REGION-DIFF f=${f} (local regions snapshot missing)`);
                }
              }
            }
            if (window._rbPendingBlocks) delete window._rbPendingBlocks[fStr];
            if (window._rbPendingRegions) delete window._rbPendingRegions[fStr];
          }
        }
      }
      // Clean up old pending checks (older than 60 frames)
      if (window._rbPendingChecks && _frameNum % 300 === 0) {
        for (const f of Object.keys(window._rbPendingChecks)) {
          if (parseInt(f) < _frameNum - 60) delete window._rbPendingChecks[f];
        }
        if (window._rbPendingBlocks) {
          for (const f of Object.keys(window._rbPendingBlocks)) {
            if (parseInt(f) < _frameNum - 60) delete window._rbPendingBlocks[f];
          }
        }
        if (window._rbPendingRegions) {
          for (const f of Object.keys(window._rbPendingRegions)) {
            if (parseInt(f) < _frameNum - 60) delete window._rbPendingRegions[f];
          }
        }
        if (window._rbLocalBlocks) {
          for (const f of Object.keys(window._rbLocalBlocks)) {
            if (parseInt(f) < _frameNum - 60) {
              delete window._rbLocalBlocks[f];
              delete window._rbLocalTaint[f];
            }
          }
        }
        if (window._rbLocalRegions) {
          for (const f of Object.keys(window._rbLocalRegions)) {
            if (parseInt(f) < _frameNum - 60) delete window._rbLocalRegions[f];
          }
        }
      }

      if (_frameNum % 60 === 0 && !(_frameNum % 300 === 0)) {
        const rbCount = tickMod._kn_get_rollback_count?.() ?? 0;
        const predCount = tickMod._kn_get_prediction_count?.() ?? 0;
        const correctCount = tickMod._kn_get_correct_predictions?.() ?? 0;
        const maxD = tickMod._kn_get_max_depth?.() ?? 0;
        _syncLog(`C-STATE f=${_frameNum} rb=${rbCount} pred=${predCount} correct=${correctCount} maxD=${maxD}`);
      }

      // Debug overlay
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
      if (_knScreenshots && _frameNum > 0 && _frameNum % _diag.SCREENSHOT_INTERVAL === 0) {
        _diag.captureAndSendScreenshot();
      }
      return;
    }

    // Check if all INPUT peers (peers who have sent at least 1 input)
    // have input for the apply frame. Late joiners who haven't started
    // sending yet won't stall existing players.
    const menuLockstepPhase = _readStrictPhaseLock(_frameNum > BOOT_GRACE_FRAMES);
    const inputPeers = getInputPeers(menuLockstepPhase.strictInputLockstep);
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
        if (menuLockstepPhase.strictInputLockstep) {
          if (_stallStart === 0) {
            _stallStart = now;
            _resendSent = false;
            _syncLog(
              `MENU-LOCKSTEP start f=${_frameNum} apply=${applyFrame} missing=[${_missingSlots.join(',')}] ` +
                `scene=${menuLockstepPhase.sceneCurr} gameStatus=${menuLockstepPhase.gameStatus} ` +
                `inputPeers=${inputPeers.map((p) => p.slot).join(',')}`,
            );
          }
          const stallDuration = now - _stallStart;
          if (stallDuration >= MAX_STALL_MS + RESEND_TIMEOUT_MS) {
            const repeatInfo = [];
            for (const s of _missingSlots) {
              markPeerPhantomForStallTimeout(
                s,
                'menu-lockstep-timeout',
                `stalledMs=${Math.round(stallDuration)} apply=${applyFrame}`,
              );
              if (!_remoteInputs[s]) _remoteInputs[s] = {};
              if (_remoteInputs[s][applyFrame] === undefined) {
                _remoteInputs[s][applyFrame] = KNShared.ZERO_INPUT;
                _consecutiveFabrications[s] = (_consecutiveFabrications[s] || 0) + 1;
                repeatInfo.push(`s${s}=0`);
              }
            }
            _syncLog(
              `MENU-LOCKSTEP-TIMEOUT f=${_frameNum} apply=${applyFrame} missing=[${_missingSlots.join(',')}] ` +
                `stallMs=${stallDuration.toFixed(0)} fabricated=[${repeatInfo.join(',')}]`,
            );
            _stallStart = 0;
            return;
          }
          if (stallDuration >= MAX_STALL_MS && !_resendSent) {
            _resendSent = true;
            for (const p of inputPeers) {
              if (_remoteInputs[p.slot]?.[applyFrame] !== undefined) continue;
              try {
                p.dc?.send(`resend:${applyFrame}`);
              } catch (_) {}
            }
            _syncLog(
              `MENU-LOCKSTEP resend-request f=${_frameNum} apply=${applyFrame} missing=[${_missingSlots.join(',')}]`,
            );
          }
          return;
        }

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
              `INPUT-STALL start f=${_frameNum} apply=${applyFrame} missing=[${_missingSlots.join(',')}] ` +
                `inputPeers=${inputPeers.map((p) => p.slot).join(',')} rBuf=${_formatSlotMap(rBufSizes)} ` +
                `peerStarted=${_formatSlotMap(_peerInputStarted)}`,
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
            // MF4: fabrication keeps the game moving but creates
            // permanent hash divergence from peers that had the real
            // input. Request a full resync so the divergence
            // converges. Rate-limited via
            // INPUT_STALL_RESYNC_COOLDOWN_MS to avoid storms under
            // sustained marginal WiFi. See spec §MF4, audit §A7.
            const _nowStallResync = performance.now();
            if (_syncEnabled && _nowStallResync - _lastInputStallResyncAt > INPUT_STALL_RESYNC_COOLDOWN_MS) {
              _lastInputStallResyncAt = _nowStallResync;
              _syncLog(
                `INPUT-STALL-RESYNC f=${_frameNum} apply=${applyFrame} ` +
                  `missing=[${_missingSlots.join(',')}] — requesting full resync`,
              );
              if (_playerSlot !== 0) {
                const _hostForResync = Object.values(_peers).find((p) => p.slot === 0);
                const _hostDcForResync = _hostForResync?.dc;
                if (_hostDcForResync?.readyState === 'open') {
                  try {
                    _hostDcForResync.send('sync-request-full');
                  } catch (_e) {
                    _syncLog(`INPUT-STALL-RESYNC send failed: ${_e}`);
                  }
                }
              }
            }
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
        _consumeLateJoinSeededInput(peerSlot, applyFrame);
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
        const _ti = KNState?.touchInput || {};
        let _touchActive = 0;
        for (const _tk in _ti) if (_ti[_tk]) _touchActive++;
        const _keymapSize = _p1KeyMap ? Object.keys(_p1KeyMap).length : -1;
        const _hasFocus =
          typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : 'n/a';
        _syncLog(
          `INPUT-LOG f=${_frameNum} apply=${applyFrame} local=${_formatInputBrief(localInput)} ` +
            `delay=${DELAY_FRAMES} inputPeers=[${inputPeers.map((p) => p.slot).join(',')}] ` +
            `rBuf=${_formatSlotMap(rBufDetail)} dc=${_formatSlotMap(dcStates)} missed=${_remoteMissed} ` +
            `applied=${_remoteApplied} sendFails=${_sendFails} fps=${_fpsCurrent} ` +
            `fAdv=${_frameAdvantage.toFixed(1)} fAdvRaw=${_frameAdvRaw} ` +
            `roster=[${_activeRoster ? [..._activeRoster].join(',') : 'none'}] ` +
            `remap=${!!KNState?.remapActive} hasFocus=${_hasFocus} ` +
            `heldKeys=${_heldKeys.size} touchKeys=${_touchActive} keymapSize=${_keymapSize}`,
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
          if (_isPeerPendingLateJoin(sid)) continue;
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
            // I2: route per-peer cleanup through resetPeerState before
            // dropping the _peers entry.
            resetPeerState(p.slot, 'mesh-heal', { peer: p, sid });
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
    if (_runSubstate === RUN_AWAITING_RESYNC) {
      if (performance.now() - _awaitingResyncAt > 3000) {
        _syncLog('resync wait timeout — resuming');
        console.warn('[lockstep] resync timeout — log dump:\n' + exportSyncLog());
        if (_runSubstate === RUN_AWAITING_RESYNC) _runSubstate = RUN_NORMAL;
        _syncTargetFrame = -1;
        _syncTargetDeadlineAt = 0;
        _resyncRequestInFlight = false; // unblock future resync requests
        _lastResyncTime = 0; // clear cooldown so next desync triggers immediately
      } else {
        return;
      }
    }

    // Step one frame with audio capture
    const tickMod = window.EJS_emulator?.gameManager?.Module;
    if (tickMod?._kn_reset_audio) {
      tickMod._kn_reset_audio();
      _resetAudioCallsSinceRb++;
    }
    _syncRNGSeed(tickMod, _frameNum);
    // try/finally: if stepOneFrame throws (WASM OOB, abort, etc.), the
    // performance.now() override stays armed and returns frozen WASM
    // cycle time, which freezes the setInterval tick scheduler and the
    // entire game loop. See netplay-lockstep.js:6873.
    _inDeterministicStep = true;
    try {
      stepOneFrame();
    } catch (e) {
      _syncLog(_formatStepThrew('fallback', e));
      console.error('[lockstep] stepOneFrame threw (fallback):', e);
    } finally {
      _inDeterministicStep = false;
    }
    feedAudio();

    _frameNum++;
    KNState.frameNum = _frameNum;
    if (window.KNDesync) KNDesync.tick(_frameNum);

    // P0-1 funnel: fire milestone_reached once when the player reaches
    // ~30 seconds of sustained gameplay (frame 1800 at 60fps). This is the
    // "actually played, not just loaded" signal for the reliability funnel.
    if (!_funnelMilestoneSent && _frameNum >= 1800) {
      _funnelMilestoneSent = true;
      KNEvent('milestone_reached', '', { frame: 1800 });
    }

    // Coordinated sync dispatch: when host reaches a scheduled target frame, capture
    // and send state. Coalesces multiple guests (4P) into a single broadcast push.
    //
    // I1 (MF3): each request has a wall-clock deadline. If frame
    // pacing prevents reaching targetFrame before the deadline, the
    // request is dispatched NOW at current frame instead. This closes
    // the coord-sync-unreachable deadlock class (spec §MF3, audit §A3/§B1).
    if (_playerSlot === 0 && _scheduledSyncRequests.length > 0 && !_pushingSyncState) {
      const _coordNow = performance.now();
      const due = _scheduledSyncRequests.filter(
        (r) => r.targetFrame <= _frameNum || (r.deadlineAt && _coordNow > r.deadlineAt),
      );
      if (due.length > 0) {
        const timedOut = due.filter((r) => r.targetFrame > _frameNum);
        if (timedOut.length > 0) {
          for (const r of timedOut) {
            _syncLog(
              `COORD-SYNC-TIMEOUT target=${r.targetFrame} f=${_frameNum} ` +
                `elapsed=${Math.round(_coordNow - (r.deadlineAt - SYNC_COORD_TIMEOUT_MS))}ms — ` +
                `dispatching at current frame instead`,
            );
          }
        }
        _scheduledSyncRequests = _scheduledSyncRequests.filter(
          (r) => r.targetFrame > _frameNum && (!r.deadlineAt || _coordNow <= r.deadlineAt),
        );
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
    // Resync is triggered by explicit recovery paths, not by periodic hash checks.
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
        for (const p of getActivePeers()) {
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

  const _setLastSyncState = (state, reason) => {
    _lastSyncState = state;
    _syncLog(`deltaBase ${state ? 'SET' : 'NULL'} reason=${reason} frame=${_frameNum} size=${state?.length ?? 0}`);
  };

  const pushSyncState = async (targetSid, isProactive = false, options = {}) => {
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
      // Arm post-sync diagnostic burst on host too
      window._knPostSyncDiagFrames = 10;

      // Dump event queue on host for cross-peer comparison
      if (mod._kn_eventqueue_dump) {
        const eqBuf = mod._malloc(256);
        if (eqBuf) {
          const n = mod._kn_eventqueue_dump(eqBuf, 64);
          const u32 = mod.HEAPU32;
          const base = eqBuf >> 2;
          const count = u32[base];
          const compare = u32[base + 1];
          const cycle = u32[base + 2];
          const nextInt = u32[base + 3];
          const numEvents = u32[base + 4];
          const intNames = {
            1: 'VI',
            2: 'CMP',
            4: 'CHK',
            8: 'SI',
            16: 'PI',
            32: 'SPC',
            64: 'AI',
            128: 'SP',
            256: 'DP',
          };
          const events = [];
          for (let i = 0; i < numEvents && 5 + i * 3 + 2 < n; i++) {
            const idx = base + 5 + i * 3;
            const type = u32[idx];
            const abs = u32[idx + 1];
            const rel = u32[idx + 2];
            events.push(`${intNames[type] || type}@${rel}`);
          }
          _syncLog(
            `EQ-HOST-SYNC f=${_frameNum} COUNT=${count} COMPARE=${compare} cycle=${cycle} next=${nextInt} events=[${events.join(',')}]`,
          );
          mod._free(eqBuf);
        }
      }
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
      if (options.transport === 'socket') {
        if (!targetSid || !_peers[targetSid]) {
          _syncLog(`socket sync send skipped: unknown target ${targetSid || 'null'}`);
          return;
        }
        const encoded = await compressAndEncode(toCompress);
        const b64KB = Math.round(encoded.data.length / 1024);
        const wireKB = Math.round(encoded.compressedSize / 1024);
        if (encoded.data.length <= SOCKET_SYNC_B64_SOFT_LIMIT) {
          socket.emit('data-message', {
            type: 'sync-state-socket',
            targetSid,
            senderSid: socket.id,
            frame,
            full: isFull,
            proactive: isProactive,
            reason: options.reason || 'socket-sync',
            rawSize: encoded.rawSize,
            compressedSize: encoded.compressedSize,
            data: encoded.data,
          });
          _syncLog(
            `socket sync sent to slot=${_peers[targetSid].slot}: ${isFull ? 'full' : 'delta'} ` +
              `${wireKB}KB gzip (${b64KB}KB b64) frame=${frame}`,
          );
        } else {
          _syncLog(
            `socket sync too large (${b64KB}KB b64 > ${Math.round(SOCKET_SYNC_B64_SOFT_LIMIT / 1024)}KB), falling back to DC chunks`,
          );
          await sendSyncChunks(base64ToUint8(encoded.data), frame, isFull, targetSid, isProactive);
        }
      } else {
        const compressed = await compressState(toCompress);
        const sizeKB = Math.round(compressed.length / 1024);
        _syncLog(`${isFull ? 'full' : 'delta'} state: ${sizeKB}KB compressed`);
        await sendSyncChunks(compressed, frame, isFull, targetSid, isProactive);
      }
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
    if (targetSid) {
      const targetPeer = _peers[targetSid];
      targets = targetPeer && !_isPeerPendingLateJoin(targetSid, targetPeer) ? [targetPeer] : [];
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

  async function _handleDecodedSyncPayload({ decompressed, frame, isFull, isProactive, isRegions, wireSize, source }) {
    // Regions patch: decompress directly, buffer for apply — no delta chain.
    if (isRegions) {
      _resyncRequestInFlight = false;
      if (frame <= _lastAppliedSyncHostFrame) {
        _syncLog(`regions sync discarded: stale frame=${frame} <= lastApplied=${_lastAppliedSyncHostFrame}`);
        _clearLifecycleResyncGuard('regions sync stale');
        return;
      }
      _pendingResyncState = { bytes: decompressed, frame, isRegions: true };
      _syncLog(`regions resync ready: ${Math.round(wireSize / 1024)}KB wire frame=${frame}`);
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
        if (_runSubstate === RUN_AWAITING_RESYNC) _runSubstate = RUN_NORMAL;
        _syncTargetFrame = -1;
        _syncTargetDeadlineAt = 0;
        if (!_requestSocketFullResync('delta-base-missing')) {
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
      _syncLog(`proactive state buffered: ${Math.round(wireSize / 1024)}KB wire, frame=${frame} source=${source}`);
    } else {
      // Request satisfied — clear in-flight flag so next desync can send a new request.
      _resyncRequestInFlight = false;
      // Discard if we already applied a state at or after this frame (e.g. proactive
      // fast-path already jumped us forward — applying an older explicit would roll back).
      if (frame <= _lastAppliedSyncHostFrame) {
        _syncLog(`explicit sync discarded: stale frame=${frame} <= lastApplied=${_lastAppliedSyncHostFrame}`);
        _clearLifecycleResyncGuard('explicit sync stale');
        return;
      }
      _pendingResyncState = { bytes: fullBytes, frame };
      _syncLog(`resync ready (${isFull ? 'full' : 'delta'}, ${Math.round(wireSize / 1024)}KB wire, source=${source})`);
    }
  }

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
      await _handleDecodedSyncPayload({
        decompressed,
        frame,
        isFull,
        isProactive,
        isRegions,
        wireSize: assembled.length,
        source: 'dc',
      });
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

      // kn_sync_write calls invalidate_cached_code_hacktarux which clears
      // mupen64plus's cached interpreter blocks. Without re-capturing the
      // rAF runner, the next stepOneFrame dispatches into a stale block
      // and throws WASM RuntimeError. The fallback gm.loadState branch
      // below does this explicitly; the kn-sync branch was missing it.
      recaptureManualRunner(mod, 'kn-sync-write');

      // Cache applied state as delta base for next resync.
      // Proactive states must NOT update the delta base — the host's delta base only
      // advances on explicit syncs, so applying a proactive state here would cause
      // host/guest delta bases to diverge, producing XOR-garbage on the next delta.
      if (!fromProactive) _setLastSyncState(bytes.slice(), 'applySyncC');

      _resyncCount++;
      _consecutiveResyncs++;
      _syncLog(`kn_sync_write: ${Math.round(bytes.length / 1024)}KB, ${(lt1 - lt0).toFixed(1)}ms`);
      // Arm post-sync diagnostic burst on every sync application
      window._knPostSyncDiagFrames = 10;

      // Dump event queue state after sync for cross-peer comparison
      if (mod._kn_eventqueue_dump) {
        const eqBuf = mod._malloc(256);
        if (eqBuf) {
          const n = mod._kn_eventqueue_dump(eqBuf, 64);
          const u32 = mod.HEAPU32;
          const base = eqBuf >> 2;
          const count = u32[base];
          const compare = u32[base + 1];
          const cycle = u32[base + 2];
          const nextInt = u32[base + 3];
          const numEvents = u32[base + 4];
          const intNames = {
            1: 'VI',
            2: 'CMP',
            4: 'CHK',
            8: 'SI',
            16: 'PI',
            32: 'SPC',
            64: 'AI',
            128: 'SP',
            256: 'DP',
          };
          const events = [];
          for (let i = 0; i < numEvents && 5 + i * 3 + 2 < n; i++) {
            const idx = base + 5 + i * 3;
            const type = u32[idx];
            const abs = u32[idx + 1];
            const rel = u32[idx + 2];
            events.push(`${intNames[type] || type}@${rel}`);
          }
          _syncLog(
            `EQ-POST-SYNC f=${_frameNum} COUNT=${count} COMPARE=${compare} cycle=${cycle} next=${nextInt} events=[${events.join(',')}]`,
          );
          mod._free(eqBuf);
        }
      }

      // For boot sync (first alignment from divergent boot state), reset
      // frame counter to the host's frame. Without this, the guest keeps
      // its old _frameNum while the emulator state is from the host's frame,
      // causing input mapping mismatch. Only done when the frame gap is
      // large (boot sync) — not for normal resyncs where frames are close.
      if (frame != null && mod._kn_set_frame && Math.abs(_frameNum - frame) > 2) {
        const oldFrame = _frameNum;
        _frameNum = frame;
        KNState.frameNum = frame;
        mod._kn_set_frame(frame);
        _bootStallFrame = -1;
        _bootStallStartTime = 0;
        _bootStallRecoveryFired = false;
        _syncLog(`sync frame reset: ${oldFrame} → ${frame} (large gap)`);
        // Arm post-sync diagnostic burst: log full state hash for 10 frames
        window._knPostSyncDiagFrames = 10;
      }
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
    _lastAppliedSyncHostFrame = frame; // discard any explicit state older than this
    _lastResyncTime = performance.now(); // restart cooldown from application time, not request time
    // Reset frame pacing after resync — the guest may be behind the host and needs
    // to catch up without PACING-THROTTLE fighting the recovery. Clear the EMA smoothing
    // so pacing starts fresh from the new synchronized state.
    _frameAdvantage = 0;
    _frameAdvRaw = 0;
    if (_runSubstate === RUN_PACING) _runSubstate = RUN_NORMAL;
    _pacingThrottleStartAt = 0;
    _pacingCapsCount = 0;
    _pacingCapsFrames = 0;
    _pacingMaxAdv = 0;
    _pacingAdvSum = 0;
    _pacingAdvCount = 0;
    _pacingSkipCounter = 0;
    const now = performance.now();
    if (_resumeInputGuardUntil > now + EJS_RESUME_INPUT_GUARD_MS) {
      _resumeInputGuardUntil = now + EJS_RESUME_INPUT_GUARD_MS;
      _releaseLocalFocusInput();
      _syncLog(`resume input guard shortened after sync apply (${EJS_RESUME_INPUT_GUARD_MS}ms)`);
    }
    _clearLifecycleResyncGuard('sync apply');
    const syncMsg = `sync #${_resyncCount} applied (frame ${frame} -> ${_frameNum}, next in ${_syncCheckInterval}f)`;
    _syncLog(syncMsg);
    _shadowScheduleResync('sync-apply');
    if (now - _lastResyncToastTime > 5000) {
      _lastResyncToastTime = now;
      _config?.onSyncStatus?.('Desync corrected');
    }
  };

  // -- Init / Stop API -------------------------------------------------------

  let _config = null;

  const init = (config) => {
    _sessionId++; // invalidate stale timers from previous session
    _resetInputAudit();
    _config = config;
    socket = config.socket;
    _playerSlot = config.playerSlot;
    _isSpectator = config.isSpectator;

    // Apply pre-game options
    _syncEnabled = config.resyncEnabled !== false; // default: true
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

    const syntheticSlots = Array.isArray(config.syntheticSlots) ? config.syntheticSlots : [];
    for (const slot of syntheticSlots) ensureSyntheticPeer(slot);

    // Now that initial roster is populated, start polling for the WASM
    // controller-mask export so we can write the real mask before retro_run
    // executes its first frame. Spectators don't run an emulator.
    if (!_isSpectator) _scheduleEarlyControllerMask();

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
      if (_phase < PHASE_GAME_STARTED && _config) {
        const peerCount = Object.keys(_peers).length;
        if (peerCount === 0 && _playerSlot !== 0) {
          setStatus('No peer connection — check network');
        } else if (peerCount > 0) {
          const anyOpen = Object.values(_peers).some((p) => p.ready);
          const retrying = Object.values(_peers).some((p) => p._startupConnectTimer || p.startupReconnecting);
          if (!anyOpen && !retrying) setStatus('Peer found but data channel not open');
        }
      }
    }, 15000);
    // startGameSequence() is triggered from ch.onopen (or solo mode above)
  };

  const stop = () => {
    _flushSyncLog();
    _resetInputAudit();
    _cachedMatchId = null;
    _cachedRoom = null;
    _cachedUploadToken = null;
    _socketFlushFails = 0;
    if (_flushInterval) {
      clearInterval(_flushInterval);
      _flushInterval = null;
    }
    // Drop the unload/hidden flush listeners so their closure (which retains
    // _drainCDebugLog, _buildFlushPayload, _flushViaHttp) can be GC'd between
    // game cycles. The window flag is what guards re-registration in
    // startGameSequence, so it must be cleared too.
    if (window._knFlushUnloadHandler) {
      window.removeEventListener('pagehide', window._knFlushUnloadHandler);
      window._knFlushUnloadHandler = null;
    }
    if (_unloadVisChangeHandler) {
      document.removeEventListener('visibilitychange', _unloadVisChangeHandler);
      _unloadVisChangeHandler = null;
    }
    // KNDesync owns its own setInterval heartbeat — without an explicit stop
    // it keeps firing across game cycles and retains module + digest caches.
    if (window.KNDesync && typeof window.KNDesync.stop === 'function') {
      window.KNDesync.stop();
    }
    _startTime = 0;
    DELAY_FRAMES = DEFAULT_DELAY_FRAMES;
    _predictionsPaused = false;
    _hudRollbackEvents = 0;
    _hudRollbackDepthSamples = [];
    _hudEventTimestamps = [];
    _rttSamples = [];
    _rttComplete = false;
    _rttPeersComplete = 0;
    _rttPeersTotal = 0;

    // Stop lockstep tick loop
    stopSync();

    // Close all peer connections and clear reconnect timers
    for (const [sid, p] of Object.entries(_peers)) {
      clearStartupConnectWatchdog(p);
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

    // Restore all overridden browser APIs (rAF, performance.now, getGamepads)
    APISandbox.restoreAll();
    _manualMode = false;
    _pendingRunner = null;

    // Reset lockstep state
    _remoteInputs = {};
    _peerInputStarted = {};
    _activeRoster = null;
    _lastControllerPresentMask = -1;
    _lastControllerPresentMaskModule = null;
    _menuStartBarrierReleased = false;
    _menuStartLocalReady = false;
    _menuStartLocalScene = 0;
    _menuStartReleaseAt = 0;
    _menuStartReadyPeers = {};
    _menuStartReadyLastBroadcast = 0;
    _peerPhases = {};
    _phaseMismatchGrace = {};
    _lastPhaseBroadcastAt = 0;
    _lastPhaseBroadcastKey = '';
    _lastPeerPhaseWaitLogFrame = -1;
    _localInputs = {};
    _frameNum = 0;
    _funnelMilestoneSent = false;
    KNState.frameNum = 0;
    _lateJoin = false;
    _phase = PHASE_IDLE;
    _runSubstate = RUN_NORMAL;
    window._knPreventRetroArchVisibilityPause = false;
    if (window._knSyncLog === _syncLog) window._knSyncLog = null;
    _awaitingLateJoinState = false;
    _isApplyingLateJoinState = false;
    _lateJoinReadyHandled.clear();
    _pendingLateJoinReadySids.clear();
    _pendingLateJoinPeerSids.clear();
    _pendingLateJoinPeerSlots.clear();
    _lateJoinActivatedAtFrame = {};
    _lateJoinInputBootstrapUntilFrame = -1;
    _lateJoinSeededInputFrames = {};
    clearLateJoinReadyRetry();
    _cacheAttempted = false;
    _lockstepReadyPeers = {};
    _guestStateBytes = null;
    _guestStateKind = 'savestate';
    _lockstepStartStateKind = 'savestate';
    _guestStateHiddenWords = null;
    _guestStateAudioFifo = null;
    _guestStateCapturedLocally = false;
    _knownPlayers = {};
    _lastRemoteFrame = -1;
    _lastRemoteFramePerSlot = {};
    _peerLastAdvanceTime = {};
    _peerPhantom = {};
    _consecutiveFabrications = {};
    _inputLateLogTime = {};
    _frameAdvantage = 0;
    _frameAdvRaw = 0;
    if (_runSubstate === RUN_PACING) _runSubstate = RUN_NORMAL;
    _pacingThrottleStartAt = 0;
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
    if (_syncChunkTimeoutTimer) {
      clearTimeout(_syncChunkTimeoutTimer);
      _syncChunkTimeoutTimer = null;
    }
    _syncChunkSessionId++;
    _syncLastChunkProgressLogAt = 0;
    _pushingSyncState = false;
    _proactivePushInFlight = false;
    _pendingResyncState = null;
    _lifecycleResyncPending = false;
    _lifecycleResyncStartedAt = 0;
    _resumeInputGuardUntil = 0;
    if (_runSubstate === RUN_AWAITING_RESYNC) _runSubstate = RUN_NORMAL;
    _awaitingResyncAt = 0;
    _syncTargetFrame = -1;
    _syncTargetDeadlineAt = 0;
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

    // Clean up audio (delegated to kn-audio.js)
    _audio?.cleanup();

    // Restore window.AudioContext if our gesture-handler hijack is still
    // installed. Otherwise a `new AC(...)` call between matches (e.g.,
    // play.js _preloadAudioCtx via acceptRomSharing) returns the stale
    // _ejsCtx at the device's native rate (48000 on iPhone), which then
    // leaks into the next match as _kn_preloadedAudioCtx and shifts pitch.
    if (_acHijackRestore) {
      if (window.AudioContext === _acHijackRestore.hijack) {
        window.AudioContext = _acHijackRestore.real;
      }
      if (window.webkitAudioContext === _acHijackRestore.hijack) {
        window.webkitAudioContext = _acHijackRestore.realWebkit;
      }
      _acHijackRestore = null;
    }

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
    // Drop the gesture-prompt listeners if the user never tapped (the
    // onPromptClick path's manual removes never run otherwise).
    if (_bootGestureAbort) {
      _bootGestureAbort.abort();
      _bootGestureAbort = null;
    }

    // Restore original console.log
    if (_originalConsoleLog) {
      console.log = _originalConsoleLog;
      _originalConsoleLog = null;
    }

    // Clear debug log between sessions
    _debugLog.length = 0;

    // Clear boot/CSS sync flags so they re-trigger on next match.
    // Without this, subsequent matches skip the state-push that
    // aligns frame_counter (used by get_random_int_safe_ for RNG).
    window._knBootSyncDone = undefined;
    window._knCssSyncDone = undefined;

    _config = null;
  };

  const _medianSample = (samples) => {
    const sorted = (samples || []).filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
    return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null;
  };

  const _hudPingMs = () => {
    const peers = getActivePeers();
    const syntheticPeer = peers.find((p) => p.synthetic === true && p.rttSamples?.length > 0);
    if (syntheticPeer) return _medianSample(syntheticPeer.rttSamples);
    return _medianSample(peers.flatMap((p) => p.rttSamples ?? []));
  };

  const _currentStallMs = (now) => {
    const starts = [
      _stallStart,
      _bootStallStartTime,
      _phaseLockStallStartTime,
      _rbInputStallStartTime,
      _rollbackStallStart,
      _pacingThrottleStartAt,
      _awaitingResyncAt,
    ].filter((t) => Number.isFinite(t) && t > 0);
    return starts.length > 0 ? Math.max(0, now - Math.min(...starts)) : 0;
  };

  const _pruneHudEvents = (now) => {
    while (_hudEventTimestamps.length > 0 && now - _hudEventTimestamps[0] > HUD_EVENT_WINDOW_MS) {
      _hudEventTimestamps.shift();
    }
  };

  const NetplayRollbackApi = {
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
    injectRemoteInput: ({ slot, frame, input, ackFrame = -1, redundantFrames = null, observedRttMs = 0 } = {}) => {
      const peer = ensureSyntheticPeer(slot);
      if (!peer) return false;
      const inputFrame = Number(frame);
      if (!Number.isFinite(inputFrame)) return false;
      const syntheticInput = {
        buttons: input?.buttons ?? 0,
        lx: input?.lx ?? 0,
        ly: input?.ly ?? 0,
        cx: input?.cx ?? 0,
        cy: input?.cy ?? 0,
      };
      const sid = _syntheticSidForSlot(peer.slot);
      const packet = KNShared.encodeInput(inputFrame, syntheticInput, ackFrame, redundantFrames).buffer;
      // The fake-peer scheduler must keep inputFrame near _frameNum so the
      // real seam's OOR guard accepts it and the C engine sees normal packets.
      const injected = _processInputPacket(sid, peer, packet);
      _recordSyntheticRtt(peer, observedRttMs);
      return !!injected;
    },
    setPredictionsPaused: (on) => {
      const next = !!on;
      if (_predictionsPaused !== next) _syncLog(`predictions ${next ? 'paused' : 'resumed'}`);
      _predictionsPaused = next;
      return _predictionsPaused;
    },
    isPredictionsPaused: () => _predictionsPaused,
    // Demo/UI pause: gates the per-frame tick callback without unwinding any
    // engine state. While paused the setInterval keeps firing but tick() is
    // skipped, so the emulator does not advance. Resume picks up cleanly.
    pauseTick: () => {
      if (!_externalTickPaused) {
        _externalTickPaused = true;
        // Reset the deadline so we don't try to "catch up" on the lost time.
        _tickNextAt = performance.now() + TICK_TARGET_MS;
        _syncLog('external tick paused');
      }
      return _externalTickPaused;
    },
    resumeTick: () => {
      if (_externalTickPaused) {
        _externalTickPaused = false;
        _tickNextAt = performance.now() + TICK_TARGET_MS;
        _syncLog('external tick resumed');
      }
      return _externalTickPaused;
    },
    isTickPaused: () => _externalTickPaused,
    setDemoMode: (on) => {
      const next = !!on;
      const changed = _demoMode !== next;
      if (changed) _syncLog(`demo mode ${next ? 'enabled' : 'disabled'} (pacing throttle ${next ? 'OFF' : 'ON'})`);
      _demoMode = next;
      // Recompute the controller-present mask immediately. Demo mode flips
      // whether synthetic peers count as "plugged in" controllers, so the
      // mask must be re-applied or P2's port stays disconnected.
      if (changed) {
        // Bust the cache so _applyControllerPresentMask doesn't early-return.
        _lastControllerPresentMask = -1;
        _applyControllerPresentMask('demo-mode-toggle');
      }
      return _demoMode;
    },
    isDemoMode: () => _demoMode,
    getHudCounters: () => {
      const now = performance.now();
      _pruneHudEvents(now);
      const eventsPerSec = _hudEventTimestamps.length / (HUD_EVENT_WINDOW_MS / 1000);
      const avgDepth =
        _hudRollbackDepthSamples.length === 0
          ? 0
          : _hudRollbackDepthSamples.reduce((a, b) => a + b, 0) / _hudRollbackDepthSamples.length;
      const tickMod = window.EJS_emulator?.gameManager?.Module;
      return {
        pingMs: _hudPingMs(),
        predictionsPaused: _predictionsPaused,
        predictionState: _predictionsPaused ? 'LOCKSTEP' : 'PREDICT',
        stallMs: _currentStallMs(now),
        rollbackEventsPerSec: eventsPerSec,
        rollbackEventsTotal: _hudRollbackEvents,
        avgRollbackDepth: avgDepth,
        totalMispredicts: tickMod?._kn_get_prediction_count?.() ?? 0,
        correctPredictions: tickMod?._kn_get_correct_predictions?.() ?? 0,
        maxDepth: tickMod?._kn_get_max_depth?.() ?? 0,
        failedRollbacks: tickMod?._kn_get_failed_rollbacks?.() ?? 0,
        currentFrame: _frameNum,
        delay: DELAY_FRAMES,
        isCRollback: _useCRollback,
      };
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
      let rollbackInfo = null;
      if (_useCRollback) {
        const m = window.EJS_emulator?.gameManager?.Module;
        if (m?._kn_get_rollback_count) {
          rollbackInfo = {
            rollbacks: m._kn_get_rollback_count(),
            predictions: m._kn_get_prediction_count(),
            correct: m._kn_get_correct_predictions(),
            maxDepth: m._kn_get_max_depth(),
          };
        }
      }
      return {
        fps: _fpsCurrent,
        frameDelay: DELAY_FRAMES,
        ping: rtt,
        playerCount: peers.length + 1,
        frame: _frameNum,
        running: _phase === PHASE_RUNNING,
        state: _computeState(),
        mode: 'rollback',
        syncEnabled: _syncEnabled,
        resyncCount: _resyncCount,
        rollback: rollbackInfo,
        peers: peerInfo,
      };
    },
    getDebugState: () => ({
      state: _computeState(),
      activeRoster: _activeRoster ? [..._activeRoster] : null,
      pendingLateJoinSlots: [..._pendingLateJoinPeerSlots],
      pendingLateJoinSids: [..._pendingLateJoinPeerSids],
      lateJoinActivationFrames: { ..._lateJoinActivatedAtFrame },
      lateJoinInputBootstrapUntilFrame: _lateJoinInputBootstrapUntilFrame,
      inputPeerSlots: getInputPeers().map((p) => p.slot),
      running: _phase === PHASE_RUNNING,
      frameNum: _frameNum,
      playerSlot: _playerSlot,
      peerCount: Object.keys(_peers).length,
      runSubstate: _runSubstate,
      lateJoin: _lateJoin,
      awaitingLateJoinState: _awaitingLateJoinState,
      heldKeyCodes: [..._heldKeys],
      localInputNow: readLocalInput(),
      menuStartBarrierReleased: _menuStartBarrierReleased,
      peersDetail: Object.fromEntries(
        Object.entries(_peers).map(([sid, p]) => [
          sid,
          {
            slot: p.slot,
            dc: p.dc?.readyState || 'none',
            rbDc: p.rbDc?.readyState || 'none',
            pc: p.pc?.connectionState || 'none',
            lastFrameFromPeer: p.lastFrameFromPeer ?? -1,
            lastAckFromPeer: p.lastAckFromPeer ?? -1,
            inputStarted: !!_peerInputStarted[p.slot],
          },
        ]),
      ),
      remoteLatest: Object.fromEntries(
        Object.entries(_remoteInputs).map(([slot, frames]) => {
          const keys = Object.keys(frames || {})
            .map((f) => Number(f))
            .filter((f) => Number.isFinite(f));
          const latestFrame = keys.length ? Math.max(...keys) : -1;
          const latest = latestFrame >= 0 ? frames[latestFrame] : null;
          return [slot, { latestFrame, latest }];
        }),
      ),
    }),
    getDebugLog: () => _debugLog.slice(),
    _getPeers: () => _peers,
    dumpLogs: () => {
      if (socket?.connected) {
        const info = {
          slot: _playerSlot,
          frame: _frameNum,
          running: _phase === PHASE_RUNNING,
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
      // Self-test requires retro_run from C which doesn't work in ASYNC mode.
      // Use pure lockstep determinism verification instead.
      return 'not available (ASYNC mode — use lockstep hash check)';
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
    getReplayMotionStats: () => ({
      overlaySmoothing: _getRollbackMotionStats(),
      motionNudge: _getRollbackMotionNudgeStats(),
      enabled: {
        replayVisualFreeze: _rbVisualFreezeEnabled,
        replayVisualFadeMs: RB_VISUAL_FADE_MS,
        replayTailFadeMs: RB_REPLAY_TAIL_FADE_MS,
        replayVisualFreezeMinDepth: RB_VISUAL_FREEZE_MIN_DEPTH,
        replayMotionSmoothing: RB_REPLAY_MOTION_SMOOTHING,
        replayMotionScale: RB_REPLAY_MOTION_SCALE,
        replayMotionNudge: RB_REPLAY_MOTION_NUDGE,
        replayMotionNudgePx: RB_REPLAY_MOTION_NUDGE_PX,
        replayMotionNudgeMs: RB_REPLAY_MOTION_NUDGE_MS,
        replayMotionDiag: RB_REPLAY_MOTION_DIAG,
      },
      diag: RB_REPLAY_MOTION_DIAG
        ? {
            cogSamples: _rbReplayMotionDiag.cogSamples.slice(),
            oracle: _rbReplayMotionDiag.oracle.slice(),
            transforms: _rbReplayMotionDiag.transforms.slice(),
            lifecycle: _rbReplayMotionDiag.lifecycle.slice(),
          }
        : null,
    }),
    getShadowStats: () => _shadowStatsSnapshot(),
    isCRollback: () => _useCRollback,
    isInGameplay: () => _inGameplay,
    // Raw scene + game_status from RDRAM, for both SSB64 and Smash Remix.
    // The existing _readSceneCurr / _readGameStatus helpers early-return for
    // non-Remix; this bypasses those gates so the demo can show the true
    // values for any game and we can verify SSB64's scene enum empirically.
    getSceneStatus: () => {
      const out = { scene: -1, status: -1, ready: false, remix: false };
      try {
        out.remix = !!_isSmashRemix?.();
        if (!_rdramBase) return out;
        const mod = window.EJS_emulator?.gameManager?.Module;
        if (!mod?.HEAPU8 || !mod?.HEAPU32) return out;
        out.ready = true;
        out.scene = mod.HEAPU8[_rdramBase + (KN_SCENE_CURR_RDRAM ^ 3)] & 0xff;
        const statusAddr = out.remix ? KN_REMIX_GAME_STATUS_WORD_RDRAM : KN_SSB64_GAME_STATUS_WORD_RDRAM;
        const word = mod.HEAPU32[(_rdramBase + statusAddr) >> 2];
        out.status = (word >> 16) & 0xff;
      } catch (_) {}
      return out;
    },
    // Precise in-match check. Currently uses the well-known Smash Remix
    // semantics (scene 22 + status 1). For SSB64 this is unverified — the
    // demo's HUD now shows raw scene/status so we can confirm the actual
    // in-match values empirically.
    isInMatch: () => {
      const s = NetplayRollbackApi.getSceneStatus();
      return s.ready && s.scene === 22 && s.status === 1;
    },
  };

  // The product-facing engine name is NetplayRollback. NetplayLockstep is a
  // temporary compat alias for cached client tabs and tests that haven't been
  // updated yet — remove after cached tabs churn out (1-2 weeks post-deploy).
  window.NetplayRollback = NetplayRollbackApi;
  window.NetplayLockstep = NetplayRollbackApi;

  // Global console helpers
  window.knSelfTest = () => window.NetplayRollback?.selfTest?.() ?? 'not available';
  window.knRollbackStats = () => window.NetplayRollback?.getRollbackStats?.() ?? 'not available';
})();
