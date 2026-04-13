/**
 * kaillera-next — Lockstep + Rollback Netplay Engine
 *
 * Deterministic netplay for up to 4 players running EmulatorJS
 * (mupen64plus-next WASM core) in sync. All players run their own
 * emulator instance and exchange inputs each frame.
 *
 * Two modes: Classic (pure lockstep — stalls for input) and Rollback
 * (predicts input, replays on misprediction via C engine kn_rollback.c).
 * Rollback activates automatically when the WASM core supports it.
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
 *        replays 1 frame via C retro_run (amortized — catches up over
 *        multiple ticks instead of burst-replaying all at once).
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

  // -- Diagnostics state (DIAG logger) ----------------------------------------
  // -- Diagnostics (delegated to kn-diagnostics.js / window.KNDiag) --

  // -- State -----------------------------------------------------------------

  let socket = null;
  let _playerSlot = -1; // 0-3 for players, null for spectators
  let _isSpectator = false;
  let _useCRollback = false; // true when C-level rollback engine is active
  let _rbReplayLogged = false; // prevents log spam during amortized replay
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
          if (!_hashBuf) _hashBuf = mod._malloc(128 * 4);
          if (!_taintBuf) _taintBuf = mod._malloc(128);
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
            mod._kn_get_taint_blocks(_taintBuf);
            const view = new Uint8Array(mod.HEAPU8.buffer, _taintBuf, 128);
            const tainted = [];
            const bitmap = [];
            for (let i = 0; i < 128; i++) {
              bitmap.push(view[i] ? '1' : '0');
              if (view[i]) tainted.push(i);
            }
            const out = { count: tainted.length, blocks: tainted, bitmap: bitmap.join('') };
            console.log(`knDiag.tainted: ${out.count}/128 blocks tainted: [${tainted.join(',')}]`);
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
            mod._kn_rdram_block_hashes(_hashBuf, 128);
            const view = new Uint32Array(mod.HEAPU8.buffer, _hashBuf, 128);
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
              mod._kn_get_taint_blocks(_taintBuf);
              const t = new Uint8Array(mod.HEAPU8.buffer, _taintBuf, 128);
              out.taintBlocks = Array.from(t);
              out.taintCount = out.taintBlocks.filter((x) => x).length;
            }
            if (mod._kn_rdram_block_hashes) {
              mod._kn_rdram_block_hashes(_hashBuf, 128);
              const h = new Uint32Array(mod.HEAPU8.buffer, _hashBuf, 128);
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

  // -- Audio (delegated to kn-audio.js / window.KNAudio) --
  // Canvas hash checks only run after reconnect events — during steady-state
  // gameplay, trust AI DMA determinism. GPU rendering differences between platforms
  // cause false-positive canvas mismatches that trigger unnecessary resyncs.
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
  const _inputEq = (a, b) => a.buttons === b.b && a.lx === b.lx && a.ly === b.ly && a.cx === b.cx && a.cy === b.cy;
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
  let _running = false; // tick loop active
  let _lateJoin = false; // true when joining a game already in progress
  let _lateJoinPaused = false; // host pauses tick loop while late-joiner loads state
  let _lateJoinPausedAt = 0; // I1 (MF5): wall-clock when late-join pause began

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
  const KN_FRAME_COUNTER_RDRAM = 0x0003cb30; // Global.frame_counter (get_random_int_safe_ uses fc%64)
  // SSB64/Smash Remix game_status — VS settings word at N64 0x800A4D18.
  // game_status is byte 1 (bits 23-16): 0=wait, 1=ongoing, 2=paused, 5=end.
  // Used to gate rollback prediction: during menus (status == 0), rollback's
  // stash-and-restore only preserves ~73 bytes of in-match state, corrupting
  // menu navigation state and causing screen-skip desyncs.
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

  // Read SSB64 game_status from RDRAM. Returns 1 when the match is
  // actively running (gameplay), 0 during menus/CSS/stage-select, or
  // -1 if RDRAM isn't available yet.
  //
  // BYTE ORDER: mupen64plus stores RDRAM in host (little-endian) byte
  // order. N64 byte 1 of a BE word is at LE offset (byte_offset ^ 3).
  // Using HEAPU32 + shift avoids XOR-3 confusion: read the 32-bit word
  // at the word-aligned address, then extract the correct byte position.
  // game_status is byte 1 (bits 23-16) of the N64 word at 0x800A4D18.
  const KN_GAME_STATUS_WORD_RDRAM = 0x000a4d18; // word-aligned address
  let _inGameplay = false;
  let _inGameplayLoggedAt = -1; // frame where we last logged a transition
  const _readGameStatus = () => {
    if (!_rdramBase || !_isSmashRemix()) return -1;
    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod?.HEAPU32) return -1;
    const word = mod.HEAPU32[(_rdramBase + KN_GAME_STATUS_WORD_RDRAM) >> 2];
    return (word >> 16) & 0xff;
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
    // Sync frame_counter low 6 bits: get_random_int_safe_ uses (fc & 0x3F)
    // for extra LCG advances. If fc drifts between peers (boot timing),
    // identical seeds produce different random outcomes. Force the low 6 bits
    // to match _frameNum so both peers do the same number of extra advances.
    // Upper bits preserved so the game's increment logic isn't disrupted.
    const fcIdx = _rdram32(mod, KN_FRAME_COUNTER_RDRAM);
    const fc = mod.HEAPU32[fcIdx];
    mod.HEAPU32[fcIdx] = (fc & 0xffffffc0) | (frameNum & 0x3f);
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
  const SYNC_LOG_MAX = 10000;
  const _syncLogRing = KNShared.createSyncLogRing(SYNC_LOG_MAX);
  let _startTime = 0;

  const _isLocalDev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const _syncLog = (msg) => {
    _syncLogRing.push({ t: performance.now(), f: _frameNum, msg });
    console.log(`[lockstep] ${msg}`);
    // Local dev: flush on every log entry (real-time diagnostics)
    // Prod: flush on critical events only (bandwidth-conscious)
    if (_isLocalDev) {
      try {
        _flushSyncLog();
      } catch (_) {}
    } else if (
      msg.includes('MISMATCH') ||
      msg.includes('STATE-DRIFT') ||
      msg.includes('GP-D') ||
      msg.includes('REGION-DIFF') ||
      msg.includes('BOOT-SYNC') ||
      msg.includes('reconnect') ||
      msg.includes('RECOVERY') ||
      msg.includes('STUCK')
    ) {
      try {
        _flushSyncLog();
      } catch (_) {}
    }
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
    else if (_awaitingResync) cause = 'awaiting-resync';
    else if (_syncTargetFrame > 0) cause = `coord-sync-waiting-for-f${_syncTargetFrame}`;
    else if (_bootStallFrame >= 0) cause = `boot-lockstep-f${_bootStallFrame}`;
    else if (_stallStart > 0) cause = 'input-stall';
    else if (_rollbackStallActive) cause = 'rollback-stall';
    else if (_framePacingActive) cause = 'pacing-throttle';

    _syncLog(
      `TICK-STUCK severity=${severity} f=${_frameNum} stuckMs=${Math.round(stuckMs)} ` +
        `cause=${cause} rbPending=${!!window._rbPendingInit} ` +
        `awaitingResync=${_awaitingResync} syncTargetFrame=${_syncTargetFrame} ` +
        `bootStallFrame=${_bootStallFrame} scheduledSyncs=${_scheduledSyncRequests.length} ` +
        `pacing=${_framePacingActive} rbStall=${_rollbackStallActive} ` +
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
      // Experiment A: rollbacks absorbed by stick-tolerance window.
      // Rollback count reduction == toleranceHits (approximately).
      toleranceHits: m._kn_get_tolerance_hits?.() ?? 0,
    };
    // T2: misprediction breakdown — button-only, stick-only, both-differ.
    // Allocate a 3-int scratch buffer once and reuse it.
    if (m._kn_get_mispred_breakdown && m._malloc) {
      if (!window._rbMispredBuf) window._rbMispredBuf = m._malloc(12);
      try {
        m._kn_get_mispred_breakdown(window._rbMispredBuf);
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
    mode: 'lockstep',
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
    inputAudit: {
      localCount: _auditLocalInputs.length,
      remoteCount: Object.fromEntries(Object.entries(_auditRemoteInputs).map(([s, a]) => [s, a.length])),
      local: _auditLocalInputs,
      remote: _auditRemoteInputs,
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

  // -- Gameplay screenshot capture (for desync debugging) --------------------
  // Periodically capture the WebGL canvas via readPixels → scale → JPEG →
  // send to server. Cost: ~3-5ms GPU sync every SCREENSHOT_INTERVAL frames.
  // The frame number is snapshotted at capture entry (NOT read in the async
  // FileReader callback) so peers stamp the actual captured frame instead of
  // whatever _frameNum has advanced to by the time the JPEG encode finishes.
  // `_lastScreenshotFrame` guards against the same frame being captured twice
  // when two tick code paths both hit the SCREENSHOT_INTERVAL modulo check.
  const SCREENSHOT_INTERVAL = 300; // ~5 seconds at 60fps
  const SCREENSHOT_WIDTH = 160;
  const SCREENSHOT_HEIGHT = 120;
  let _screenshotCanvas = null;
  let _screenshotCtx = null;
  let _lastScreenshotFrame = -1;

  let _screenshotDebugLogged = false;
  const _captureAndSendScreenshot = () => {
    // Snapshot the frame at capture entry so async encoding can't race.
    const capturedFrame = _frameNum;
    if (capturedFrame === _lastScreenshotFrame) return; // guard double-capture
    _lastScreenshotFrame = capturedFrame;
    const canvas = document.querySelector('#game canvas');
    if (!canvas || !canvas.width || !canvas.height) {
      if (!_screenshotDebugLogged) {
        _screenshotDebugLogged = true;
        _syncLog(`screenshot: no canvas (sel=${!!canvas} w=${canvas?.width} h=${canvas?.height})`);
      }
      return;
    }

    // Scale down to thumbnail, then toDataURL. The full-res canvas
    // produces ~175KB JPEG which exceeds the server's 50KB limit.
    // drawImage from a WebGL canvas works in the same JS task as the
    // render (before browser composites). No EJS hijacking needed.
    try {
      if (!_screenshotCanvas) {
        _screenshotCanvas = document.createElement('canvas');
        _screenshotCanvas.width = SCREENSHOT_WIDTH;
        _screenshotCanvas.height = SCREENSHOT_HEIGHT;
        _screenshotCtx = _screenshotCanvas.getContext('2d');
      }
      const w = canvas.width;
      const h = canvas.height;
      const targetRatio = 4 / 3;
      const srcRatio = w / h;
      let sx = 0,
        sy = 0,
        sw = w,
        sh = h;
      if (srcRatio > targetRatio) {
        sw = Math.round(h * targetRatio);
        sx = Math.round((w - sw) / 2);
      } else if (srcRatio < targetRatio) {
        sh = Math.round(w / targetRatio);
        sy = Math.round((h - sh) / 2);
      }
      _screenshotCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, SCREENSHOT_WIDTH, SCREENSHOT_HEIGHT);
      const dataUrl = _screenshotCanvas.toDataURL('image/jpeg', 0.6);
      if (!dataUrl || dataUrl.length < 100) {
        if (!_screenshotDebugLogged) {
          _screenshotDebugLogged = true;
          _syncLog(`screenshot: toDataURL too small (${dataUrl?.length || 0})`);
        }
        return;
      }
      if (!_screenshotDebugLogged) {
        _screenshotDebugLogged = true;
        _syncLog(`screenshot: ok ${SCREENSHOT_WIDTH}x${SCREENSHOT_HEIGHT} size=${dataUrl.length}`);
      }
      const base64 = dataUrl.split(',')[1];
      if (!socket?.connected) return;
      socket.emit('game-screenshot', {
        matchId: _cachedMatchId || KNState.matchId,
        slot: _playerSlot,
        frame: capturedFrame,
        data: base64,
      });
    } catch (e) {
      if (!_screenshotDebugLogged) {
        _screenshotDebugLogged = true;
        _syncLog(`screenshot: error: ${e.message}`);
      }
    }
  };

  // -- Diagnostic functions (delegated to kn-diagnostics.js) --
  const _diagInput = (frameNum, applyFrame, force) => window.KNDiag.diagInput(frameNum, applyFrame, force);
  const _diagInstallHooks = () => window.KNDiag.installHooks();

  let _syncChunks = []; // incoming chunks from host DC
  let _syncExpected = 0; // expected chunk count
  let _syncFrame = 0; // frame number of incoming sync
  let _syncIsFull = true; // true=full state, false=XOR delta
  let _lastResyncTime = 0; // timestamp of last resync request (10s cooldown)
  let _resyncRequestInFlight = false; // true while an explicit sync-request is in transit — prevents stacking
  let _lastAppliedSyncHostFrame = -1; // host frame of the most recently applied sync state (discard stale explicit)
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
    _syncBufSize = 8 * 1024 * 1024 + 64 * 1024;
    _syncBufPtr = mod._malloc(_syncBufSize);
    _syncLog(`sync buffer allocated: ptr=${_syncBufPtr} size=${_syncBufSize}`);
  };

  let _awaitingResync = false; // guest: pause emulator while waiting for resync data
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
  let _framePacingActive = false; // true when cap is throttling
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

  // -- Audio pipeline (delegated to kn-audio.js) --
  async function initAudioPlayback() {
    await window.KNAudio.init({
      log: _syncLog,
      getFrame: () => _frameNum,
      getSlot: () => _playerSlot,
      getLastRbFrame: () => _lastRollbackDoneFrame,
      getResetAudioCalls: () => _resetAudioCallsSinceRb,
      knEvent: KNEvent,
    });
  }
  const feedAudio = () => window.KNAudio.feed();

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

  const onDataMessage = (msg) => {
    if (!msg?.type) return;
    if (msg.type === 'save-state') handleSaveStateMsg(msg);
    if (msg.type === 'late-join-state') handleLateJoinState(msg);
    if (msg.type === 'request-late-join') handleLateJoinRequest(msg);
    if (msg.type === 'late-join-ready') {
      if (_lateJoinPaused) {
        _lateJoinPaused = false;
        _resetPacingAfterLateJoin();
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
        // Timeout already resumed us, but the joiner is now ready.
        // Reset pacing again — the timeout reset may have expired by now,
        // causing phantom detection on peers that were paused longer.
        _resetPacingAfterLateJoin();
        _broadcastRoster();
        _syncLog('late-join-ready after timeout — pacing reset + roster broadcast');
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
        }
      }
      if (s === 'failed') {
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
      peer.dc = peer.pc.createDataChannel('lockstep', { ordered: true });
      setupDataChannel(remoteSid, peer.dc);
      peer.syncDc = peer.pc.createDataChannel('sync-state', { ordered: true, priority: 'very-low' });
      setupSyncDataChannel(remoteSid, peer.syncDc);
      // P2: unordered input channel — always created, only used when the
      // host broadcasts rb-transport:unreliable. Cheap to leave idle.
      peer.rbDc = peer.pc.createDataChannel('rollback-input', { ordered: false, maxRetransmits: 0 });
      setupRollbackInputDataChannel(remoteSid, peer.rbDc);
      // Delegate non-lockstep channels created by remote
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
              peer.rbDc.close();
            } catch (_) {}
          peer.rbDc = e.channel;
          setupRollbackInputDataChannel(remoteSid, peer.rbDc);
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
        } else if (e.channel.label === 'rollback-input') {
          if (peer.rbDc)
            try {
              peer.rbDc.close();
            } catch (_) {}
          peer.rbDc = e.channel;
          setupRollbackInputDataChannel(remoteSid, peer.rbDc);
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
          // Mark as reconnecting so the DC open handler triggers resync.
          // Without this, only the initiator's side sends sync-request-full
          // and the receiver silently continues with stale state.
          existingPeer.reconnecting = true;

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
            } else if (e.channel.label === 'rollback-input') {
              if (existingPeer.rbDc)
                try {
                  existingPeer.rbDc.close();
                } catch (_) {}
              existingPeer.rbDc = e.channel;
              setupRollbackInputDataChannel(senderSid, existingPeer.rbDc);
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

  // Process a binary input packet from any DC (lockstep or rollback-input).
  // Shared by setupDataChannel (reliable DC) and setupRollbackInputDataChannel
  // (unordered DC, used when host broadcasts rb-transport:unreliable).
  const _processInputPacket = (remoteSid, peer, data) => {
    if (peer.slot === null || peer.slot === undefined) return; // spectators don't send input
    const decoded = KNShared.decodeInput(data);
    const recvFrame = decoded.frame;
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
        // Already have real input for this frame? Skip — just a dup.
        if (_remoteInputs[peer.slot][r.frame] !== undefined) {
          _rbTransportDupsRecv++;
          continue;
        }
        _remoteInputs[peer.slot][r.frame] = {
          buttons: r.buttons,
          lx: r.lx,
          ly: r.ly,
          cx: r.cx,
          cy: r.cy,
        };
        if (_useCRollback) {
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
    if (_useCRollback) {
      _pendingCInputs.push({
        slot: peer.slot,
        frame: recvFrame,
        buttons: recvInput.buttons,
        lx: recvInput.lx,
        ly: recvInput.ly,
        cx: recvInput.cx,
        cy: recvInput.cy,
      });
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
      const ordered = ch.ordered;
      const maxRetransmits = ch.maxRetransmits;
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
      // P0-1 funnel: fire webrtc_connected the first time this peer's DC opens.
      // Subsequent reopens (reconnects) don't re-emit.
      if (!peer._funnelConnectedSent) {
        peer._funnelConnectedSent = true;
        KNEvent('webrtc_connected', '', { remote_slot: peer.slot ?? -1 });
      }
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

      // Host: send current roster to newly connected/reconnected peer
      if (_playerSlot === 0 && _activeRoster) {
        const slots = [..._activeRoster].sort((a, b) => a - b);
        try {
          ch.send(`roster:${_frameNum}:${slots.join(',')}`);
        } catch (_) {}
      }

      if (!_gameStarted) startGameSequence();
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
          _lateJoinPaused = true;
          _syncLog(`paused by host for late-join sync at frame ${_frameNum}`);
        }
        if (e.data === 'late-join-resume') {
          _lateJoinPaused = false;
          _resetPacingAfterLateJoin();
          _syncLog(`resumed by host after late-join sync at frame ${_frameNum}`);
        }
        if (e.data === 'late-join-ready') {
          if (_lateJoinPaused) {
            _lateJoinPaused = false;
            _resetPacingAfterLateJoin();
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
          } else {
            _resetPacingAfterLateJoin();
            _broadcastRoster();
            _syncLog('late-join-ready (DC) after timeout — pacing reset + roster broadcast');
          }
        }
        if (e.data.startsWith('roster:')) {
          const parts = e.data.split(':');
          const rosterFrame = parseInt(parts[1], 10);
          const slots = parts[2] ? parts[2].split(',').map(Number) : [];
          _activeRoster = new Set(slots);
          _rosterChangeFrame = _frameNum;
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
          const hostDelay = parseInt(e.data.split(':')[1], 10);
          if (hostDelay > 0) {
            // Cache for guests that haven't reached the init code yet.
            window._rbHostDelay = hostDelay;
            if (window._rbPendingInit && window._rbDoInit) {
              // Deferred init was waiting for this. Run it now.
              window._rbPendingInit = false;
              window._rbPendingInitAt = 0;
              DELAY_FRAMES = hostDelay;
              _syncLog(`rb-delay: deferred init triggered with host delay=${hostDelay}`);
              window._rbDoInit(hostDelay);
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
          const eqHashMM = gMod._kn_eventqueue_hash?.() ?? 0;
          _syncLog(
            `RDRAM-DESYNC frame=${syncFrame} local=${guestHash} host=${hostHash} eq=${(eqHashMM >>> 0).toString(16)} myFrame=${_frameNum}${regionLog}`,
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
              _lockstepReadyPeers[remoteSid] = true;
              checkAllLockstepReady();
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

  // -- Per-peer state cleanup (Invariant I2) --------------------------------

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
   *   - _consecutiveFabrications[slot] (fabrication counter)
   *   - _inputLateLogTime[slot]        (rate-limit timestamp)
   *   - _auditRemoteInputs[slot]       (audit log buffer)
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

    // Slot-indexed globals
    delete _remoteInputs[slot];
    delete _peerInputStarted[slot];
    delete _lastRemoteFramePerSlot[slot];
    delete _peerLastAdvanceTime[slot];
    delete _peerPhantom[slot];
    delete _consecutiveFabrications[slot];
    delete _inputLateLogTime[slot];
    delete _auditRemoteInputs[slot];

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

    // Boot-stall tracking — if we were stalled waiting on this slot's
    // apply frame, clear the tracking so the stall clock restarts
    // cleanly once a new peer fills the slot.
    if (_bootStallFrame >= 0) {
      _bootStallFrame = -1;
      _bootStallStartTime = 0;
      _bootStallRecoveryFired = false;
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
    if (_playerSlot === 0 && _running) {
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
    if (remaining.length === 0 && _running) {
      setStatus('All peers disconnected -- running solo');
    } else if (_running) {
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
            peer.rbDc.close();
          } catch (_) {}
        peer.rbDc = e.channel;
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
                window.KNDiag.playerAddrs[pi] = psi;
                break;
              }
            }
            mod._simulate_input(pi, 0, 0);
          }
          _syncLog(`per-player input addrs: ${JSON.stringify(window.KNDiag.playerAddrs)}`);
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

    // Negotiate delay: ceiling of all players.
    // Rollback mode: both players independently compute from RTT/2, then take max.
    // Peer delay values from lockstep-ready handshake use the old lockstep formula,
    // so we recalculate them using peer RTT samples with the rollback formula.
    const hasRollback = !!window.EJS_emulator?.gameManager?.Module?._kn_pre_tick;
    let ownDelay;
    if (hasRollback && _rttMedian > 0) {
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
      const effectiveMs = filteredMedian / 2 + jitterMargin + 16.67; // +1 frame safety
      ownDelay = Math.min(7, Math.max(2, Math.ceil(effectiveMs / 16.67)));
      _syncLog(
        `rollback delay: RTT=${filteredMedian.toFixed(1)}ms jitter=${jitterMargin.toFixed(1)}ms ` +
          `IQR=[${q1.toFixed(1)},${q3.toFixed(1)}] samples=${sorted.length} ` +
          `effective=${effectiveMs.toFixed(1)}ms -> ${ownDelay}f`,
      );
    } else {
      ownDelay = window.getDelayPreference ? window.getDelayPreference() : 2;
    }
    let maxDelay = ownDelay;
    if (hasRollback) {
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
          const peerDelay = Math.min(7, Math.max(2, Math.ceil(peerMs / 16.67)));
          if (peerDelay > maxDelay) maxDelay = peerDelay;
        }
      }
    } else {
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

    // Enter manual mode FIRST — stop free frames before any state load.
    // Previously, free frames could run between getState/loadState/enterManualMode,
    // advancing emulator state and causing intermittent boot desync.
    enterManualMode();

    // Soft-reset the core — clears internal state (JIT caches, hardware
    // registers, plugin state) that loadState() alone doesn't overwrite.
    const readyMod = gm.Module;
    if (readyMod?._retro_reset) {
      readyMod._retro_reset();
      _syncLog('core soft-reset before state load');
    }

    // Load state twice — first load restores CPU + RAM, second load
    // catches any residual drift from the reset/load sequence.
    gm.loadState(_guestStateBytes);
    gm.loadState(_guestStateBytes);
    _guestStateBytes = null;
    _syncLog('state loaded (manual mode, post-reset, double-load)');

    // Re-apply cheats after state load. _retro_reset() and loadState() can
    // clear the cheat table, so cheats applied during boot may be lost.
    // Only for vanilla SSB64 — Smash Remix has different memory layout.
    if (!_isSmashRemix()) {
      KNShared.applyStandardCheats(KNShared.SSB64_ONLINE_CHEATS);
    } else {
      // Clear any stale cheats from a previous game in the same tab.
      // The EJS cheat table persists across game restarts — SSB64 cheats
      // set by the old ungated path corrupt Smash Remix (e.g. "Timer On").
      KNShared.clearCheats();
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

  const fetchCachedState = async (romHash) => {
    _syncLog(`checking for cached state: ${romHash.substring(0, 16)}...`);

    // 1. Check local IndexedDB first — instant, no network
    try {
      const idbBytes = await _getStateFromIDB(romHash);
      if (idbBytes && idbBytes.length > 1000) {
        _syncLog(`cached state loaded from IndexedDB (${idbBytes.length} bytes)`);
        _guestStateBytes = idbBytes instanceof Uint8Array ? idbBytes : new Uint8Array(idbBytes);

        if (_playerSlot === 0) {
          compressAndEncode(new Uint8Array(_guestStateBytes))
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

      // Persist to local IDB for next time
      _putStateToIDB(romHash, new Uint8Array(bytes)).catch(() => {});

      if (_playerSlot === 0) {
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

      // Use local state immediately so the host isn't blocked by the
      // cache round-trip. The blocking await fetch(POST 16MB) was causing
      // the host to stall for 10-30s while the guest started normally.
      _guestStateBytes = cacheBytes;
      _selfLockstepReady = true;
      if (_rttComplete) {
        broadcastLockstepReady();
      }
      checkAllLockstepReady();

      // Background: cache for future games (fire-and-forget)
      const romHash = _config?.romHash;
      if (romHash) {
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
    if (_selfLockstepReady) return; // already loaded (e.g. from cache)
    _syncLog('received initial state');
    setStatus('Loading initial state...');

    try {
      const bytes = await decodeAndDecompress(msg.data);
      _guestStateBytes = bytes;
      _syncLog(`initial state decompressed (${bytes.length} bytes)`);

      // Cache locally for next time
      const romHash = _config?.romHash;
      if (romHash) _putStateToIDB(romHash, new Uint8Array(bytes)).catch(() => {});

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
    // Always 4 — see roster DC handler comment for rationale.
    rb_numPlayers = 4;
    const rbMod = window.EJS_emulator?.gameManager?.Module;
    if (_useCRollback && rbMod?._kn_set_num_players) {
      rbMod._kn_set_num_players(rb_numPlayers);
      _syncLog(`C-ROLLBACK num_players updated to ${rb_numPlayers}`);
    }
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
      // Pause lockstep FIRST — freeze all players before capturing state
      // so no frames advance during the async compression below. Without
      // this, the tick loop can run N frames between getState() and the
      // moment we read _frameNum, causing the late joiner to load state
      // from frame X but think they're at frame X+N (cursor desync).
      _lateJoinPaused = true;
      _lateJoinPausedAt = performance.now();
      _syncLog(`pausing for late-join at frame ${_frameNum}`);
      for (const p of Object.values(_peers)) {
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

      // Async compression is safe now — tick loop is frozen
      const encoded = await compressAndEncode(bytes);
      // I1 (MF5): late-join pause must have a wall-clock deadline.
      // If the joiner's ready signal never arrives (their DC dies
      // mid-transfer, worker hangs on decompression, etc.) we need
      // to resume the game AND hard-disconnect the joiner so they
      // retry from a clean slate rather than living in a half-loaded
      // limbo. See spec §MF5, audit §D3.
      setTimeout(() => {
        if (_lateJoinPaused) {
          const elapsed = Math.round(performance.now() - _lateJoinPausedAt);
          _syncLog(
            `LATE-JOIN-TIMEOUT elapsed=${elapsed}ms joiner=${remoteSid} — ` +
              `resuming without joiner, hard-disconnecting so they can retry`,
          );
          _lateJoinPaused = false;
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
          }
        }
      }, LATE_JOIN_TIMEOUT_MS);

      _syncLog(
        `sending late-join state to ${remoteSid} (${Math.round(encoded.rawSize / 1024)}KB raw -> ${Math.round(encoded.compressedSize / 1024)}KB gzip) frame: ${capturedFrame}`,
      );

      socket.emit('data-message', {
        type: 'late-join-state',
        frame: capturedFrame,
        data: encoded.data,
        effectiveDelay: DELAY_FRAMES,
        rbTransport: _rbTransport,
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

      // Re-apply cheats after state load — loadState can clear the cheat
      // table, losing cheats applied during boot. Only for vanilla SSB64.
      if (!_isSmashRemix()) {
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

      // Ensure rollback init can proceed — the late joiner missed the
      // host's rb-delay broadcast over DataChannel (sent at game start).
      // Without this, startLockstep sets _rbPendingInit=true and the
      // tick loop is completely gated, causing a black screen.
      if (msg.effectiveDelay) {
        window._rbHostDelay = msg.effectiveDelay;
      }
      if (msg.rbTransport) {
        _rbTransport = msg.rbTransport === 'unreliable' ? 'unreliable' : 'reliable';
      }

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
    if (window.KNAudio?.destNode?.stream) {
      const audioTracks = window.KNAudio.destNode.stream.getAudioTracks();
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

    // Tag interrupt trace entries with current frame
    if (_hasForkedCore) {
      const trMod = window.EJS_emulator?.gameManager?.Module;
      if (trMod?._kn_int_trace_set_frame) trMod._kn_int_trace_set_frame(_frameNum);
    }

    runner(frameTimeMs);

    // Periodic gameplay screenshot for desync debugging
    if (_frameNum > 0 && _frameNum % SCREENSHOT_INTERVAL === 0) {
      _captureAndSendScreenshot();
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
        const startF = _frameNum - SCREENSHOT_INTERVAL;
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

    // Force GL composite via real rAF no-op
    APISandbox.nativeRAF(() => {});
    _wasmStepActive = false;
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
  // Rollback-mode hard stall threshold. Faster than PEER_DEAD_MS because
  // rollback's frame-advantage ring fills up within ~10 frames (~167ms at
  // 60fps) once inputs stop arriving. Anything past 500ms of silence means
  // cascading prediction-replay work is eating the frame budget, so we
  // freeze the local sim until inputs return. See ROLLBACK-STALL logic.
  const ROLLBACK_STALL_MS = 3000; // was 500 — keep predicting through drops
  let _rollbackStallActive = false;
  let _rollbackStallStart = 0;
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
      _flushInterval = setInterval(_flushSyncLog, _isLocalDev ? 1000 : 5000);
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
      // Enable interrupt trace for diagnostics
      if (detMod?._kn_int_trace_enable) {
        detMod._kn_int_trace_enable(1);
        _syncLog('C-level interrupt trace enabled');
      }

      // Enable FPU trace for cross-platform determinism verification
      if (detMod?._kn_fpu_trace_enable) {
        detMod._kn_fpu_trace_enable(1);
        _fpuTraceEnabled = true;
        _fpuTraceLastCheckFrame = 0;
        _fpuTraceVerified = false;
        _syncLog('FPU trace enabled for determinism verification');
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
      const doRollbackInit = (effectiveDelay) => {
        if (!detMod?._kn_rollback_init) {
          _useCRollback = false;
          return;
        }
        // Always 4 (KN_MAX_PLAYERS) — avoids contiguous slot assumption.
        const numPlayers = 4;
        // Ring buffer size = rollbackMax + 1 slots × ~16MB each.
        // Balance between memory pressure and pacing headroom.
        // Too small (delay+2=4) causes safety-freeze to strangle FPS.
        // Too large (20) wastes 320MB on mobile.
        // 8 gives enough pacing headroom (safety freeze at fAdv>=6)
        // while keeping ring buffer at 9 slots × 16MB = 144MB.
        const rollbackMax = Math.max(12, effectiveDelay + 4);
        detMod._kn_rollback_init(rollbackMax, effectiveDelay, _playerSlot, numPlayers);
        // Late join: C engine starts at frame 0 (memset), but we need it at
        // the host's frame. Without this, kn_get_frame() returns 0 and the
        // JS frame counter is reset from 4574→0, causing permanent stall.
        if (_frameNum > 0 && detMod._kn_set_frame) {
          detMod._kn_set_frame(_frameNum);
          _syncLog(`C-ROLLBACK late-join: set C frame to ${_frameNum}`);
        } else if (_frameNum > 0) {
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
        _rbInitFrame = _frameNum;
        _rbConvergedLogged = false;
        // T3: explicit mode marker so the server-side log analyzer knows
        // which netplay mode captured the input audit payload.
        const heapMB = detMod.HEAP8 ? (detMod.HEAP8.byteLength / 1024 / 1024).toFixed(0) : '?';
        _syncLog(
          `C-ROLLBACK init: max=${rollbackMax} delay=${effectiveDelay} slot=${_playerSlot} players=${numPlayers} heapMB=${heapMB}`,
        );
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
        _rollbackStallActive = false;
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
      };
      window._rbDoInit = doRollbackInit;

      if (detMod?._kn_rollback_init) {
        if (_playerSlot === 0) {
          // Host: init immediately with the value we just broadcast.
          doRollbackInit(DELAY_FRAMES);
        } else {
          // Guest: if host's rb-delay broadcast already arrived, init now.
          // Otherwise defer init to the rb-delay handler (see top of file).
          if (window._rbHostDelay !== undefined && window._rbHostDelay > 0) {
            DELAY_FRAMES = window._rbHostDelay;
            doRollbackInit(window._rbHostDelay);
          } else {
            // I1 (MF2): record the wall-clock start of the pending
            // state so tick() can fire RB-INIT-TIMEOUT if the host's
            // rb-delay broadcast never arrives (DC died mid-send,
            // host crashed, etc).
            window._rbPendingInit = true;
            window._rbPendingInitAt = performance.now();
            _syncLog(`C-ROLLBACK deferred: waiting for host rb-delay broadcast (own delay=${DELAY_FRAMES})`);
          }
        }
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

    // JS-level RNG sync for non-rollback mode (lockstep).
    // For rollback mode, RNG sync is configured inside doRollbackInit above.
    if (!_useCRollback) {
      const rngMod = window.EJS_emulator?.gameManager?.Module;
      if (rngMod) _initRNGSync(rngMod);
    }

    // Only install diagnostic hooks when explicitly enabled — they add
    // MutationObserver on document.body, touch listeners, and write to
    // window.KNDiag.eventLog which grows unboundedly (17MB+ on mobile in 30 min).
    window.KNDiag.init({
      log: _syncLog,
      getFrame: () => _frameNum,
      getSlot: () => _playerSlot,
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
    _syncLog(`SYNC-MODE: RDRAM hash desync detection, knSync=${_hasKnSync}`);

    // Guest: skip RSP audio DRAM writes to prevent cross-platform divergence.
    // The RSP HLE audio math produces different intermediate RDRAM values on
    // ARM (Safari/iPhone) vs x86 (Chrome/Mac) WASM JIT engines. Skipping the
    // writes keeps guest DRAM identical to the state-sync baseline. The guest
    // receives audio via the lockstep audio bypass, not from DRAM.
    // Skip RSP audio processing on guest — eliminates audio DMA RDRAM writes
    // that diverge cross-platform due to mid-frame interrupt timing differences.
    // Host produces audio; guest gets it via the lockstep audio bypass.
    // Skip RSP HLE audio processing on ALL peers during netplay.
    // RSP HLE uses hardware floats (not SoftFloat) for audio mixing,
    // producing different RDRAM writes on V8 vs JSC. These writes are
    // tainted but cascade to gameplay state through interrupt timing.
    // Audio playback uses the lockstep audio bypass buffer instead.
    {
      const skipMod = window.EJS_emulator?.gameManager?.Module;
      if (skipMod?._kn_set_skip_rsp_audio) {
        skipMod._kn_set_skip_rsp_audio(2);
        _syncLog('RSP audio mode 2: process for capture, restore DRAM after');
      }
    }

    setStatus('Connected -- game on!');
    _startTime = performance.now();
    _cachedMatchId = KNState.matchId;
    _cachedRoom = KNState.room;
    _cachedUploadToken = KNState.uploadToken;
    _socketFlushFails = 0;
    _flushInterval = setInterval(_flushSyncLog, _isLocalDev ? 1000 : 5000);
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
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') handler();
      });
    }

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
        // BF2: warn user if tab goes hidden during boot convergence
        const inBoot = (_rbInitFrame >= 0 && _frameNum - _rbInitFrame <= BOOT_GRACE_FRAMES) || !_inGameplay;
        if (inBoot) {
          window.knShowToast?.('Game is paused \u2014 switch to this tab to continue', 'warn');
        }
      } else {
        const bgDuration = _backgroundAt ? Date.now() - _backgroundAt : 0;
        _backgroundAt = 0;
        _syncLog(`tab visible (was background ${bgDuration} ms)`);

        // BF6: resume AudioContext on visibility return — browsers suspend
        // AudioContext when tab is hidden, and it won't auto-resume.
        if (window.KNAudio?.ctx?.state === 'suspended') {
          window.KNAudio.ctx.resume().catch((e) => {
            _syncLog(`audio re-resume on visibility failed: ${e.name}: ${e.message}`);
          });
          _syncLog(`audio context resumed on tab return (was suspended)`);
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
          _resyncRequestInFlight = false; // override — tab-focus resync always wins
          _syncTargetFrame = -1; // cancel any pending coord target — tab was paused, immediate sync needed
          _syncTargetDeadlineAt = 0;
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

    // Focus/blur tracking: document.hasFocus() gates gamepad reads, so
    // losing focus silently zeroes input. Log transitions so session logs
    // show exactly when input capture stopped/resumed.
    const _focusHandler = () => {
      if (_running) _syncLog(`TAB-FOCUS gained f=${_frameNum}`);
    };
    const _blurHandler = () => {
      if (_running) _syncLog(`TAB-FOCUS lost f=${_frameNum}`);
    };
    window.addEventListener('focus', _focusHandler);
    window.addEventListener('blur', _blurHandler);

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
    _pacingThrottleStartAt = 0;
    _pacingCapsCount = 0;
    _pacingCapsFrames = 0;
    _pacingMaxAdv = 0;
    _pacingAdvSum = 0;
    _pacingAdvCount = 0;
    _pacingSkipCounter = 0;
    // Remove diagnostic hooks (delegated to kn-diagnostics.js)
    window.KNDiag?.cleanup();
  };

  const tick = () => {
    if (!_running) return;

    // MF6: Detection-only watchdog. Logs TICK-STUCK with a rich
    // diagnostic snapshot when the frame counter has not advanced
    // for longer than the warn / error thresholds. Takes NO recovery
    // action — the user still sees the freeze, and the fix belongs
    // in whichever MF category covers the root cause. Skipped while
    // _lateJoinPaused or document.hidden (both are legitimate
    // pauses). See docs/netplay-invariants.md.
    const _tickNow = performance.now();
    if (!_lateJoinPaused && !(typeof document !== 'undefined' && document.hidden)) {
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

    if (_lateJoinPaused) return; // frozen while late-joiner loads state
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
        const _rbFallbackDelay = DELAY_FRAMES > 0 ? DELAY_FRAMES : 3;
        _syncLog(
          `RB-INIT-TIMEOUT elapsed=${Math.round(performance.now() - _rbPendingStart)}ms — ` +
            `host rb-delay never arrived, falling back to local delay=${_rbFallbackDelay}`,
        );
        window._rbPendingInit = false;
        window._rbPendingInitAt = 0;
        if (window._rbDoInit) {
          try {
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
      _awaitingResync = false;
    }

    if (_syncTargetFrame > 0) {
      if (_frameNum >= _syncTargetFrame) {
        if (_pendingResyncState) {
          // State arrived on time — apply at the agreed frame
          const pending = _pendingResyncState;
          _pendingResyncState = null;
          _awaitingResync = false;
          _syncTargetFrame = -1;
          _syncTargetDeadlineAt = 0;
          applySyncState(pending.bytes, pending.frame, pending.fromProactive);
        } else if (!_awaitingResync) {
          // Reached target frame but state not here yet — stall until it arrives
          _awaitingResync = true;
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
      _awaitingResync = false;
      applySyncState(pending.bytes, pending.frame, pending.fromProactive);
    }

    // ── Rollback-mode peer stall freeze ─────────────────────────────────
    // Pacing decisions (stall, safety freeze, soft throttle) skip frame
    // advance but must NOT skip input send — otherwise both peers starve
    // each other and deadlock. Set this flag, send inputs, then check it.
    let _skipFrameAdvance = false;

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
    if (_useCRollback && _frameNum >= FRAME_PACING_WARMUP) {
      const nowStall = performance.now();
      const stallPeers = getInputPeers();
      for (const p of stallPeers) {
        if (_peerPhantom[p.slot]) continue;
        const last = _peerLastAdvanceTime[p.slot];
        if (last === undefined) continue;
        const stale = nowStall - last;
        if (stale >= ROLLBACK_STALL_MS) {
          if (!_rollbackStallActive) {
            _rollbackStallActive = true;
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
      if (_rollbackStallActive && !_skipFrameAdvance) {
        const stallDuration = nowStall - _rollbackStallStart;
        _rollbackStallActive = false;
        _rollbackStallStart = 0;
        _syncLog(`ROLLBACK-STALL end durationMs=${stallDuration.toFixed(0)}`);
      }
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
              if (!_framePacingActive) {
                _framePacingActive = true;
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
              if (!_framePacingActive) {
                _framePacingActive = true;
                _pacingThrottleStartAt = nowPacing;
                _pacingCapsCount++;
                const ratio = excess >= 2 ? '100%' : '50%';
                _syncLog(
                  `PACING-THROTTLE start fAdv=${_frameAdvRaw} ratio=${ratio} smooth=${_frameAdvantage.toFixed(1)} delay=${DELAY_FRAMES} minRemote=${minRemoteFrame}`,
                );
              }
              _skipFrameAdvance = true;
            }
            if (_framePacingActive && !_skipFrameAdvance) {
              _framePacingActive = false;
              _pacingThrottleStartAt = 0;
              _syncLog(`PACING-THROTTLE end fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)}`);
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
          if (_framePacingActive && _pacingThrottleStartAt > 0) {
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
              _framePacingActive = false;
              _pacingThrottleStartAt = 0;
              _skipFrameAdvance = false;
            }
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

    // Send local input for current frame to ALL open peer DCs.
    // Each packet includes an ack of the highest frame we've received from that peer.
    //
    // P2: GGPO-style ack-driven redundancy. Every packet carries all
    // unconfirmed inputs (from the peer's last ACK to _frameNum - 1).
    // This guarantees recovery from arbitrary packet loss bursts — even
    // if N packets drop in a row, the (N+1)-th carries the full backlog.
    const localInput = readLocalInput();
    _localInputs[_frameNum] = localInput;
    _auditRecordLocal(_frameNum, localInput);
    // Append to history ring; trim entries already acked by ALL peers
    // (or older than the hard cap, whichever is tighter).
    _rbLocalHistory.push({
      frame: _frameNum,
      buttons: localInput.buttons,
      lx: localInput.lx,
      ly: localInput.ly,
      cx: localInput.cx,
      cy: localInput.cy,
    });
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
    const redundantTail = shouldSendRedundancy ? _rbLocalHistory.slice(0, _rbLocalHistory.length - 1) : null;
    let _sendFails = 0;
    for (let i = 0; i < activePeers.length; i++) {
      try {
        const peer = activePeers[i];
        const ackFrame = peer.lastFrameFromPeer ?? -1;
        const peerBuf = KNShared.encodeInput(_frameNum, localInput, ackFrame, redundantTail).buffer;
        // Use unreliable rb-input DC when available, fall back to primary DC
        const inputDc =
          _rbTransport === 'unreliable' &&
          peer.rbDc?.readyState === 'open' &&
          peer.rbDc.ordered === false &&
          peer.rbDc.maxRetransmits === 0
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
      // MENU (game_status != 1): pure lockstep stall — rollback's
      // stash-and-restore only preserves ~73 bytes of in-match gameplay
      // state (damage, stocks, RNG, screen). Menu navigation state
      // (CSS cursors, stage selection, transition timers) lives outside
      // those bytes. A misprediction during menus corrupts the game
      // state: current_screen says "in match" but internal menu
      // structures are from the prediction pass → host skips stage
      // select entirely. Pure lockstep during menus prevents this.
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
      // Gate rollback on SSB64 game_status: only allow prediction during
      // active gameplay. During menus/CSS, game_status is 0 (wait) — use
      // pure lockstep. For non-SSB64 ROMs, _readGameStatus returns -1 and
      // we fall back to the boot-grace-only gate.
      const gameStatus = _readGameStatus();
      // game_status: 0=wait (CSS/menus), 1=ongoing, 2=paused, 5=end.
      // Only status 0 is dangerous for rollback (menu state corruption).
      // Status -1 means RDRAM not available (non-SSB64) — safe fallback.
      // Only treat game_status==0 as "menu" after CSS sync has fired.
      // During N64 boot, VS settings are uninitialized (byte is 0),
      // which falsely triggers menu lockstep during the intro sequence.
      // After CSS sync fires, game_status==0 is a real menu state.
      const inMenu = gameStatus === 0 && !!window._knCssSyncDone;
      if (!_inGameplay && !inMenu && _bootDone) {
        _inGameplay = true;
        _syncLog(`MENU→GAMEPLAY transition at f=${_frameNum} gameStatus=${gameStatus}`);
      } else if (_inGameplay && inMenu) {
        _inGameplay = false;
        if (_frameNum - _inGameplayLoggedAt > 60) {
          _syncLog(`GAMEPLAY→MENU transition at f=${_frameNum} gameStatus=${gameStatus}`);
          _inGameplayLoggedAt = _frameNum;
        }
      }
      // Second boot sync: when game_status first becomes 0 (CSS/menus),
      // request a fresh state push from host. The first boot sync at f=120
      // happens during the intro sequence where tainted-region divergence
      // causes peers to reach screen transitions at different frames.
      // This second sync at CSS entry forces both peers to identical state
      // right before player input matters.
      // CSS sync: one-time state push when game_status first becomes 0.
      if (gameStatus === 0 && !window._knCssSyncDone && _bootDoneForSync) {
        window._knCssSyncDone = true;
        _syncLog(`CSS-SYNC: menu detected at f=${_frameNum}, lockstep active`);
        if (_playerSlot !== 0) {
          const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
          if (hostPeer?.dc?.readyState === 'open') {
            try {
              hostPeer.dc.send('sync-request-full');
              _syncLog(`CSS-SYNC: guest requesting host state at f=${_frameNum}`);
            } catch (_) {}
          }
        }
      }
      // Lockstep stall only during actual CSS menus (after CSS sync).
      // During boot grace and intro, run freely — boot sync at f=120
      // and CSS sync at menu entry handle alignment.
      const _menuLockstepActive = inMenu && !!window._knCssSyncDone;
      const _rbBootConverged = _bootDone && !_menuLockstepActive;
      // Boot sync: guest requests host state when boot grace period ends.
      // Different Safari/JIT versions produce different boot RDRAM (CP0_COUNT,
      // interrupt timing, RSP work area). A one-time state push from host
      // forces identical starting state regardless of JIT differences.
      // Triggers on _bootDone (not _rbBootConverged) so it fires during
      // menus — waiting for GAMEPLAY transition is too late (1500+ frames
      // of divergent menu execution).
      if (_bootDoneForSync && !window._knBootSyncDone) {
        window._knBootSyncDone = true;
        if (_playerSlot !== 0) {
          const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
          if (hostPeer?.dc?.readyState === 'open') {
            try {
              hostPeer.dc.send('sync-request-full');
              _syncLog(`BOOT-SYNC: guest requesting host state at f=${_frameNum} (JIT boot divergence correction)`);
            } catch (e) {
              _syncLog(`BOOT-SYNC send failed: ${e}`);
            }
          }
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
        // Boot: pure lockstep stall, with timeout-based deadlock recovery.
        // Skipped when resync is in flight or deadlock recovery fired —
        // the tick must continue so the resync handler can process the
        // host's state push. Without this, the tick returns early and
        // the resync response is never handled.
        if (rbApplyFrame >= 0) {
          const bootInputPeers = getInputPeers();
          let stalled = false;
          let missingSlot = -1;
          for (const p of bootInputPeers) {
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
            }
            const stallDuration = nowWall - _bootStallStartTime;
            // During menus/boot, stall briefly then fabricate zero input
            // and continue. Timeout = 2x RTT, clamped 33-250ms.
            // 33ms = two frame times (invisible). 250ms = perceptible but
            // not sluggish. Most inputs arrive within 2 RTTs.
            const _bootStallTimeout = Math.max(33, Math.min(250, (_rttMedian || 50) * 2));
            if (stallDuration < _bootStallTimeout) {
              // Brief stall — wait for input to arrive
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
            }
            // Request resync after fabrication to converge divergence (MF4 pattern)
            if (stallDuration >= 3000 && !_bootStallRecoveryFired) {
              _bootStallRecoveryFired = true;
              _syncLog(
                `BOOT-DEADLOCK-RECOVERY f=${_frameNum} applyF=${rbApplyFrame} ` +
                  `missingSlot=${missingSlot} stalledMs=${Math.round(stallDuration)} — ` +
                  `fabricated zero + requesting resync`,
              );
              if (_playerSlot !== 0) {
                const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
                const hostDc = hostPeer?.dc;
                if (hostDc?.readyState === 'open') {
                  try {
                    hostDc.send('sync-request-full');
                  } catch (_) {}
                }
              }
            }
            // Fall through to normal tick with fabricated zero input
          }
          _bootStallFrame = -1;
          _bootStallStartTime = 0;
          _bootStallRecoveryFired = false;
        }
      } else if (_rbBootConverged && rbApplyFrame >= 0) {
        // Gameplay: stall only when too far ahead for rollback to help
        const rbInputPeers = getInputPeers();
        for (const p of rbInputPeers) {
          if (_peerPhantom[p.slot]) continue;
          if (!_remoteInputs[p.slot]?.[rbApplyFrame]) {
            // Input missing — check how far ahead we are
            const peerFrame = _lastRemoteFramePerSlot[p.slot] ?? -1;
            const adv = peerFrame >= 0 ? _frameNum - peerFrame : 0;
            if (adv >= DELAY_FRAMES + 4) {
              // Too far ahead — stall to let peer catch up
              if (!_rbStallLogged || _frameNum - _rbStallLogged >= 60) {
                _syncLog(
                  `RB-INPUT-STALL f=${_frameNum} apply=${rbApplyFrame} slot=${p.slot} adv=${adv} — stalling (rollback budget exhausted)`,
                );
                _rbStallLogged = _frameNum;
              }
              return;
            }
            // Within rollback budget — let C engine predict through it
          }
        }
      }

      // ── Drain queued remote inputs into C engine ──────────────────────
      // WebRTC callbacks push to _pendingCInputs instead of calling
      // kn_feed_input directly. Draining here — at the tick boundary,
      // before kn_pre_tick — guarantees the C engine sees a consistent
      // input snapshot per frame. No race between async DC delivery and
      // the sync prediction/serialize logic inside kn_pre_tick.
      if (_pendingCInputs.length > 0 && tickMod._kn_feed_input) {
        for (const qi of _pendingCInputs) {
          tickMod._kn_feed_input(qi.slot, qi.frame, qi.buttons, qi.lx, qi.ly, qi.cx, qi.cy);
        }
        _pendingCInputs.length = 0;
      }

      // ── Pre-tick: save state, handle replay if catching up, store input, predict ──
      // Returns 1 if catching up (C did a replay frame via retro_run — skip normal step).
      // Returns 0 for normal tick (JS does writeInputToMemory + stepOneFrame).
      const _t0 = performance.now();
      const _frameAdvForC = _rbBootConverged ? _frameAdvRaw : -1;
      const catchingUp = tickMod._kn_pre_tick(
        localInput.buttons,
        localInput.lx,
        localInput.ly,
        localInput.cx,
        localInput.cy,
        _frameAdvForC,
      );
      // ── R1: runner continuity across rollback restore ─────────────────
      // kn_pre_tick's rollback branch calls retro_unserialize directly,
      // which invalidates the Emscripten rAF runner captured by JS's
      // overrideRAF interceptor. Without re-capture, stepOneFrame in the
      // catchingUp==2 branch is a silent no-op and the replay never runs.
      // The loadState path at line ~8221 already does this; we mirror
      // here for the C-level rollback path.
      // See docs/netplay-invariants.md §R1.
      if (tickMod._kn_rollback_did_restore?.()) {
        const gm = window.EJS_emulator?.gameManager;
        if (gm?.Module) {
          gm.Module.pauseMainLoop();
          gm.Module.resumeMainLoop();
          if (gm.Module.updateMemoryViews) {
            gm.Module.updateMemoryViews();
          } else if (gm.Module._emscripten_notify_memory_growth) {
            gm.Module._emscripten_notify_memory_growth(0);
          }
        }
      }
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
          `RB-INVARIANT-VIOLATION f=${_frameNum} replayDepth=${replayDepth} ` +
            `catchingUp=${catchingUp} rbFrame=${rbFrame} tick=${performance.now().toFixed(1)}`,
        );
        if (window.KN_DEV_BUILD) {
          throw new Error(`RB-INVARIANT-VIOLATION: replayDepth=${replayDepth} catchingUp=${catchingUp}`);
        }
      }
      if (replayDepth > 0 && catchingUp === 2 && !_rbReplayLogged) {
        _syncLog(`C-REPLAY start: depth=${replayDepth} took=${(_tPreTick - _t0).toFixed(1)}ms`);
        _rbReplayLogged = true;
        // Skip RSP audio during replay: save hle_t state, switch to mode 1.
        // Mode 2's DRAM restore means original execution has net-zero audio
        // DRAM writes. Skipping audio entirely during replay produces the
        // same net-zero result, but faster and without the hle_t state
        // divergence that causes LIVE-MISMATCH.
        if (tickMod._kn_hle_save && tickMod._kn_set_skip_rsp_audio) {
          tickMod._kn_hle_save();
          tickMod._kn_set_skip_rsp_audio(1); // skip entirely during replay
          _syncLog(`REPLAY-AUDIO-SKIP: hle saved, rsp mode=1 for replay depth=${replayDepth}`);
        } else {
          _syncLog(
            `REPLAY-AUDIO-SKIP: NOT AVAILABLE (hle_save=${!!tickMod._kn_hle_save} skip_rsp=${!!tickMod._kn_set_skip_rsp_audio})`,
          );
        }
      }
      if (_rbReplayLogged && !catchingUp) {
        // Replay finished — broadcast the gameplay hash so the peer can
        // verify the rollback restoration produced identical game state.
        // gameplay_hash hashes ONLY game-relevant RDRAM addresses (damage,
        // stocks, timer, RNG) — immune to audio/video/heap noise.
        const hashFrame = _frameNum - 1;
        const gpHash = tickMod._kn_gameplay_hash?.(hashFrame) ?? 0;
        const gameHash = tickMod._kn_game_state_hash?.(hashFrame) ?? 0;
        const fullHash = tickMod._kn_full_state_hash?.(hashFrame) ?? 0;
        const hiddenFpDone = tickMod._kn_get_hidden_state_fingerprint?.() ?? 0;
        const sfStateDone = tickMod._kn_get_softfloat_state?.() ?? 0;
        const taintedCountDone = tickMod._kn_get_tainted_block_count?.() ?? 0;
        _syncLog(
          `C-REPLAY done: caught up at f=${_frameNum} gp=0x${gpHash.toString(16)} game=0x${gameHash.toString(16)} full=0x${fullHash.toString(16)} hidden=0x${hiddenFpDone.toString(16)} sf=0x${sfStateDone.toString(16)} taint=${taintedCountDone}`,
        );
        for (const p of Object.values(_peers)) {
          if (p.dc?.readyState === 'open') {
            try {
              p.dc.send(`rb-check:${hashFrame}:${gpHash}:${tickMod._kn_game_state_hash?.(hashFrame) ?? 0}`);
            } catch (_) {}
          }
        }
        // Schedule one more hash broadcast on the NEXT tick so we capture
        // the state of the FIRST frame after replay completes — that's the
        // frame most likely to expose "rollback restoration was lossy"
        // bugs because it's the first divergence point.
        _rbPendingPostRollbackHash = true;
        _rbReplayLogged = false;
        _lastRollbackDoneFrame = _frameNum;
        _resetAudioCallsSinceRb = 0;
        // Restore hle_t state and re-enable mode 2 audio after replay
        if (tickMod._kn_hle_restore && tickMod._kn_set_skip_rsp_audio) {
          tickMod._kn_hle_restore();
          tickMod._kn_set_skip_rsp_audio(2); // back to mode 2
        }
      }

      if (catchingUp === 3) {
        // Check if all peers are phantom — if so, ignore C-level throttle
        // to prevent permanent freeze when the only peer has disconnected.
        const allPhantom = getInputPeers().every((p) => _peerPhantom[p.slot]);
        if (allPhantom) {
          if (_framePacingActive) {
            _framePacingActive = false;
            _pacingThrottleStartAt = 0;
            if (window._knLastCPhantomReleaseFrame !== _frameNum) {
              window._knLastCPhantomReleaseFrame = _frameNum;
              _syncLog(`PACING-THROTTLE released — all peers phantom (C-level override)`);
            }
          }
          // Fall through to normal tick instead of returning
        } else {
          _pacingCapsFrames++;
          if (!_framePacingActive) {
            _framePacingActive = true;
            _pacingThrottleStartAt = performance.now();
            _pacingCapsCount++;
            _syncLog(
              `PACING-THROTTLE start fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)} delay=${DELAY_FRAMES} source=C`,
            );
          }
          return;
        }
      }
      if (_framePacingActive) {
        _framePacingActive = false;
        _pacingThrottleStartAt = 0;
        _syncLog(`PACING-THROTTLE end fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)} source=C`);
      }

      if (catchingUp === 2) {
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
        _inDeterministicStep = true;
        stepOneFrame();
        _inDeterministicStep = false;
        _syncRNGSeed(tickMod, _frameNum);
        feedAudio();
        // Advance C frame counter
        const newFrame = tickMod._kn_post_tick();
        _frameNum = newFrame;
        KNState.frameNum = _frameNum;
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
      if (applyFrame >= 0) {
        // Log what we write for each slot — to compare with REPLAY-INPUT logs
        const inputParts = [];
        for (let s = 0; s < rb_numPlayers; s++) {
          const inp = _rbGetInput(tickMod, s, applyFrame);
          writeInputToMemory(s, inp);
          inputParts.push(`s${s}[${inp.buttons},${inp.lx},${inp.ly}]`);
        }
        // Only log sporadically to avoid flood — every 60 frames, or any frame with non-zero input
        const anyNonZero = inputParts.some((p) => !p.includes('[0,0,0]'));
        if (anyNonZero || _frameNum % 60 === 0) {
          _syncLog(`NORMAL-INPUT f=${applyFrame} ${inputParts.join(' ')}`);
        }
      }

      if (tickMod._kn_reset_audio) {
        tickMod._kn_reset_audio();
        _resetAudioCallsSinceRb++;
      }
      _syncRNGSeed(tickMod, _frameNum);
      const _tStep0 = performance.now();
      _inDeterministicStep = true;
      stepOneFrame();
      _inDeterministicStep = false;
      const _tStep = performance.now();
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
      const _tTotal = performance.now();

      // Post-sync diagnostic burst: hash full state for 10 frames after boot sync
      if (window._knPostSyncDiagFrames > 0) {
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
        for (const p of Object.values(_peers)) {
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
      window.KNDiag.checkFreeze(localInput);

      // ── Bisect-on-mismatch: when a divergence is detected, switch to
      // per-frame hash broadcasts for the next N frames so we can pinpoint
      // exactly when the next divergence happens. Without this, mismatch
      // detection only fires at 300-frame boundaries — we can detect THAT
      // divergence exists but not WHEN it was introduced. Per-frame hashing
      // shrinks the window from 300 frames to 1 frame, but is expensive
      // (~0.5 ms/frame), so we only run it briefly after a mismatch.
      const bisectThisFrame = _rbBisectActive && _rbBisectFramesRemaining > 0 && _frameNum % 300 !== 0;
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
        const gpHash = tickMod._kn_gameplay_hash?.(hashFrame) ?? 0;
        if (gpHash !== 0) {
          for (const p of Object.values(_peers)) {
            if (p.dc?.readyState === 'open') {
              try {
                p.dc.send(`rb-check:${hashFrame}:${gpHash}:${tickMod._kn_game_state_hash?.(hashFrame) ?? 0}`);
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
              window._rbLocalRegions[hashFrame] = regionsHex;
              for (const p of Object.values(_peers)) {
                if (p.dc?.readyState === 'open') {
                  try {
                    p.dc.send(`rb-regions:${hashFrame}:${regionsHex}`);
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
      if (_rbPendingPostRollbackHash) {
        _rbPendingPostRollbackHash = false;
        const hashFrame = _frameNum - 1;
        const gpHash = tickMod._kn_gameplay_hash?.(hashFrame) ?? 0;
        const gameHash = tickMod._kn_game_state_hash?.(hashFrame) ?? 0;
        const fullHash = tickMod._kn_full_state_hash?.(hashFrame) ?? 0;
        const hiddenFp = tickMod._kn_get_hidden_state_fingerprint?.() ?? 0;
        const sfState = tickMod._kn_get_softfloat_state?.() ?? 0;
        const taintedCount = tickMod._kn_get_tainted_block_count?.() ?? 0;
        if (gpHash !== 0) {
          _syncLog(
            `RB-POST-RB f=${hashFrame} gp=0x${gpHash.toString(16)} game=0x${gameHash.toString(16)} full=0x${fullHash.toString(16)} hidden=0x${hiddenFp.toString(16)} sf=0x${sfState.toString(16)} taint=${taintedCount} (verifying restoration)`,
          );
          // Cache for RB-CHECK comparison (see periodic broadcast below for
          // why — same race window applies on the post-rollback path).
          if (!window._rbLocalGameHashes) window._rbLocalGameHashes = {};
          window._rbLocalGameHashes[hashFrame] = gpHash;
          for (const p of Object.values(_peers)) {
            if (p.dc?.readyState === 'open') {
              try {
                p.dc.send(`rb-check:${hashFrame}:${gpHash}:${tickMod._kn_game_state_hash?.(hashFrame) ?? 0}`);
              } catch (_) {}
            }
          }

          // Block-level snapshot + broadcast (duplicates the 300-frame
          // periodic logic at a per-rollback cadence). Cache locally and
          // broadcast so the peer can diff at this exact frame. Skips if
          // the WASM exports or malloc aren't available (old core).
          if (tickMod._kn_rdram_block_hashes && tickMod._kn_get_taint_blocks && tickMod._malloc) {
            if (!_rbHashBufPtr) _rbHashBufPtr = tickMod._malloc(128 * 4);
            if (!_rbTaintBufPtr) _rbTaintBufPtr = tickMod._malloc(128);
            if (_rbHashBufPtr && _rbTaintBufPtr) {
              tickMod._kn_rdram_block_hashes(_rbHashBufPtr, 128);
              tickMod._kn_get_taint_blocks(_rbTaintBufPtr);
              const blocks = new Uint32Array(tickMod.HEAPU8.buffer, _rbHashBufPtr, 128);
              const taint = new Uint8Array(tickMod.HEAPU8.buffer, _rbTaintBufPtr, 128);
              const blocksSnap = Array.from(blocks);
              const taintSnap = Array.from(taint);
              const blocksHex = blocksSnap.map((h) => h.toString(16).padStart(8, '0')).join('');
              const taintHex = taintSnap.map((t) => (t ? '1' : '0')).join('');
              _syncLog(`C-BLOCKS f=${hashFrame} taint=${taintHex} (post-rollback)`);
              window._rbLocalBlocks[hashFrame] = blocksSnap;
              window._rbLocalTaint[hashFrame] = taintSnap;
              for (const p of Object.values(_peers)) {
                if (p.dc?.readyState === 'open') {
                  try {
                    p.dc.send(`rb-blocks:${hashFrame}:${blocksHex}`);
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
          if (!_rbRegionsBufPtr && tickMod._malloc) _rbRegionsBufPtr = tickMod._malloc(NUM_REGIONS_POSTRB * 4);
          if (_rbRegionsBufPtr && tickMod._kn_state_region_hashes_frame) {
            const ok = tickMod._kn_state_region_hashes_frame(hashFrame, _rbRegionsBufPtr, NUM_REGIONS_POSTRB);
            if (ok > 0) {
              const regions = new Uint32Array(tickMod.HEAPU8.buffer, _rbRegionsBufPtr, NUM_REGIONS_POSTRB);
              const regionsHex = Array.from(regions)
                .map((h) => h.toString(16))
                .join(',');
              if (!window._rbLocalRegions) window._rbLocalRegions = {};
              window._rbLocalRegions[hashFrame] = regionsHex;
              for (const p of Object.values(_peers)) {
                if (p.dc?.readyState === 'open') {
                  try {
                    p.dc.send(`rb-regions:${hashFrame}:${regionsHex}`);
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
        // Gameplay hash for RB-CHECK: hashes ONLY game-relevant RDRAM
        // addresses (damage, stocks, timer, RNG seeds). Immune to audio/
        // video/heap noise. game_state_hash + full_state_hash kept for
        // diagnostic monitoring.
        const gpHash = tickMod._kn_gameplay_hash?.(hashFrame) ?? 0;
        const gameHash = tickMod._kn_game_state_hash?.(hashFrame) ?? 0;
        const fullHash = tickMod._kn_full_state_hash?.(hashFrame) ?? 0;
        const taintedCount = tickMod._kn_get_tainted_block_count?.() ?? 0;
        const hiddenFp = tickMod._kn_get_hidden_state_fingerprint?.() ?? 0;
        const sfState = tickMod._kn_get_softfloat_state?.() ?? 0;
        // Per-region hashes — splits state buffer into 256 chunks
        // (~34 KB regions for an ~8.6 MB savestate). At 32 regions the
        // entire post-RDRAM section (CPU/cp0/cp1/event queue/fb) fit in
        // one region, hiding which subsystem was diverging. 256 regions
        // gives us ~7 regions covering the 256 KB post-RDRAM section, so
        // a single mismatch pinpoints subsystem-level granularity.
        const NUM_REGIONS = 256;
        if (!_rbRegionsBufPtr && tickMod._malloc) _rbRegionsBufPtr = tickMod._malloc(NUM_REGIONS * 4);
        let regionsHex = '';
        if (_rbRegionsBufPtr && tickMod._kn_state_region_hashes) {
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
          _syncLog(`C-REGIONS f=${hashFrame} ${regionsHex}`);
          // Stash our own snapshot keyed by frame so the RB-CHECK mismatch
          // handler can diff against the peer's regions for the SAME frame.
          // Without this, comparing regions across slightly different frames
          // would always show divergence (regions evolve every frame).
          if (!window._rbLocalRegions) window._rbLocalRegions = {};
          window._rbLocalRegions[hashFrame] = regionsHex;
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
          for (const p of Object.values(_peers)) {
            if (p.dc?.readyState === 'open') {
              try {
                p.dc.send(`rb-regions:${hashFrame}:${regionsHex}`);
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
        if (!window._rbLocalGameHashes) window._rbLocalGameHashes = {};
        window._rbLocalGameHashes[hashFrame] = gpHash;
        // Trim — keep only the most recent ~16 frames to bound memory.
        const _rbHashKeys = Object.keys(window._rbLocalGameHashes)
          .map(Number)
          .sort((a, b) => a - b);
        if (_rbHashKeys.length > 16) {
          for (const k of _rbHashKeys.slice(0, _rbHashKeys.length - 16)) {
            delete window._rbLocalGameHashes[k];
          }
        }
        for (const p of Object.values(_peers)) {
          if (p.dc?.readyState === 'open') {
            try {
              p.dc.send(`rb-check:${hashFrame}:${gpHash}:${tickMod._kn_game_state_hash?.(hashFrame) ?? 0}`);
            } catch (_) {}
          }
        }

        // Block-level diagnostic: hash every 64 KB of RDRAM (128 blocks) and
        // dump the taint bitmap. Share with peer so that when RB-CHECK misses
        // we can pinpoint which untainted block is diverging and map it back
        // to the subsystem that owns that address.
        if (tickMod._kn_rdram_block_hashes && tickMod._kn_get_taint_blocks && tickMod._malloc) {
          if (!_rbHashBufPtr) _rbHashBufPtr = tickMod._malloc(128 * 4);
          if (!_rbTaintBufPtr) _rbTaintBufPtr = tickMod._malloc(128);
          if (_rbHashBufPtr && _rbTaintBufPtr) {
            tickMod._kn_rdram_block_hashes(_rbHashBufPtr, 128);
            tickMod._kn_get_taint_blocks(_rbTaintBufPtr);
            const blocks = new Uint32Array(tickMod.HEAPU8.buffer, _rbHashBufPtr, 128);
            const taint = new Uint8Array(tickMod.HEAPU8.buffer, _rbTaintBufPtr, 128);
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
            window._rbLocalBlocks[hashFrame] = blocksSnap;
            window._rbLocalTaint[hashFrame] = taintSnap;
            // Broadcast block hashes to peer for per-block divergence diff
            for (const p of Object.values(_peers)) {
              if (p.dc?.readyState === 'open') {
                try {
                  p.dc.send(`rb-blocks:${hashFrame}:${blocksHex}`);
                } catch (_) {}
              }
            }
          }
        }
      }

      // Check pending peer hashes — compare against the hash we cached at
      // broadcast time, NOT a fresh re-hash. A rollback between broadcast
      // and receipt would change the ring buffer's state for the same frame,
      // producing a phantom MISMATCH even though both peers agreed at the
      // moment they broadcast. Falls back to re-hashing if we somehow don't
      // have a cached hash (shouldn't happen on the periodic 300-frame path).
      if (window._rbPendingChecks) {
        for (const fStr of Object.keys(window._rbPendingChecks)) {
          const f = parseInt(fStr);
          // Only check if we've saved that frame's state (must be in ring buffer)
          if (f < _frameNum && f >= _frameNum - 7) {
            const peerHash = window._rbPendingChecks[fStr];
            delete window._rbPendingChecks[fStr];
            const cachedLocalHash = window._rbLocalGameHashes?.[f];
            const localHash = cachedLocalHash != null ? cachedLocalHash : (tickMod._kn_gameplay_hash?.(f) ?? 0);
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
                        `rng=${r32(0x5b940).toString(16)}`,
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
                  if (!_rbBisectActive && _rbBisectCount < RB_BISECT_MAX_PER_MATCH) {
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
                    `rng=${r32(0x5b940).toString(16)},${r32(0xa0578).toString(16)}`,
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
              if (!_rbBisectActive && _rbBisectCount < RB_BISECT_MAX_PER_MATCH) {
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
                            const fullSlice = new Uint8Array(tickMod.HEAPU8.buffer, statePtr + regionStart, regionSize);
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
                            for (const p of Object.values(_peers)) {
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
      if (_frameNum > 0 && _frameNum % SCREENSHOT_INTERVAL === 0) _captureAndSendScreenshot();
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
            // MF4: fabrication keeps the game moving but creates
            // permanent hash divergence from peers that had the real
            // input. Request a full resync so the divergence
            // converges. Rate-limited via
            // INPUT_STALL_RESYNC_COOLDOWN_MS to avoid storms under
            // sustained marginal WiFi. See spec §MF4, audit §A7.
            const _nowStallResync = performance.now();
            if (_nowStallResync - _lastInputStallResyncAt > INPUT_STALL_RESYNC_COOLDOWN_MS) {
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
    _inDeterministicStep = true;
    stepOneFrame();
    _inDeterministicStep = false;
    feedAudio();

    _frameNum++;
    KNState.frameNum = _frameNum;

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

  const _setLastSyncState = (state, reason) => {
    _lastSyncState = state;
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
      // Arm post-sync diagnostic burst on host too
      window._knPostSyncDiagFrames = 10;

      // Dump event queue on host for cross-peer comparison
      if (mod._kn_eventqueue_dump) {
        const eqBuf = mod._malloc(256);
        if (eqBuf) {
          const n = mod._kn_eventqueue_dump(eqBuf >> 2, 64);
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
          _syncTargetDeadlineAt = 0;
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
      // Arm post-sync diagnostic burst on every sync application
      window._knPostSyncDiagFrames = 10;

      // Dump event queue state after sync for cross-peer comparison
      if (mod._kn_eventqueue_dump) {
        const eqBuf = mod._malloc(256);
        if (eqBuf) {
          const n = mod._kn_eventqueue_dump(eqBuf >> 2, 64);
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
    _framePacingActive = false;
    _pacingThrottleStartAt = 0;
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
    _funnelMilestoneSent = false;
    _lastScreenshotFrame = -1;
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
    _pushingSyncState = false;
    _proactivePushInFlight = false;
    _pendingResyncState = null;
    _awaitingResync = false;
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
    window.KNAudio?.cleanup();

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

    // Clear boot/CSS sync flags so they re-trigger on next match.
    // Without this, subsequent matches skip the state-push that
    // aligns frame_counter (used by get_random_int_safe_ for RNG).
    window._knBootSyncDone = undefined;
    window._knCssSyncDone = undefined;

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
        running: _running,
        mode: 'lockstep',
        syncEnabled: _syncEnabled,
        resyncCount: _resyncCount,
        rollback: rollbackInfo,
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
    isCRollback: () => _useCRollback,
  };

  // Global console helpers
  window.knSelfTest = () => window.NetplayLockstep?.selfTest?.() ?? 'not available';
  window.knRollbackStats = () => window.NetplayLockstep?.getRollbackStats?.() ?? 'not available';
})();
