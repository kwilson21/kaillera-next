(function () {
  'use strict';

  const STATS_WINDOW_MS = 5000;
  const LAST_SEC_MS = 1000;
  const REDUNDANT_FRAMES = 5;
  // Diagnostic flag: ?fakePeerJitter=1 adds per-frame ±2 unit noise to the
  // held stick value, simulating the analog-stick ADC noise + hand tremor
  // a real human peer produces. Without it the synthetic peer holds an
  // exact stick value across a held-period (3-15 frames), which means the
  // C engine's linear-extrapolation predictor is exact at every match
  // frame — no mispredict-tolerance boundary case ever fires. With it
  // enabled, the held value drifts ±2 units around the base, so when the
  // base is near a zone boundary (every 12 stick units) some predictions
  // miss by 1-3 units across a boundary — exactly what the boundary
  // hysteresis (commit 5f402ef) is designed to absorb. Demo-only knob;
  // does not affect production peer behavior.
  let _jitterEnabled = false;
  try {
    const params = new URLSearchParams(window.location?.search || '');
    if (params.get('fakePeerJitter') === '1') _jitterEnabled = true;
  } catch (_) {}
  // RetroArch joypad bits we may pick when generating P2's in-match random
  // inputs. Excludes:
  //   bit 3 (START) — pauses the game / opens the pause menu, derails the demo
  //   bit 10 (L)    — Smash Remix has L-bound special actions (taunt panel /
  //                   menu) that disrupt match pacing
  // See reference_n64_button_map for full mapping.
  const BUTTON_BITS = [0, 1, 4, 5, 6, 7, 11, 12];
  const _nativeNow = window.APISandbox?.nativePerfNow || performance.now.bind(performance);
  const _nativeRAF = window.APISandbox?.nativeRAF || window.requestAnimationFrame.bind(window);
  const _nativeCancelRAF = window.APISandbox?.nativeCancelRAF || window.cancelAnimationFrame.bind(window);

  let _running = false;
  let _rafId = 0;
  let _slot = 1;
  let _getCurrentFrame = () => 0;
  // Optional callback supplied by demo.js: given an engine frame, return the
  // local-player input recorded at that frame (or null if out of range).
  // We replay it as P2 input during controllable menu scenes so P2's cursor
  // navigates CSS/stage-select alongside P1's — same delta-based D-pad
  // movements applied to P2's starting position effectively pick a random
  // character without us having to script CSS-specific inputs.
  let _getMirroredInput = null;
  let _lastSeenFrame = -1;
  let _lastEngineFrameSeen = -1;
  let _queue = [];
  let _inputHistory = [];
  let _events = [];
  let _network = {
    latencyMs: 80,
    jitterMs: 8,
    lossProb: 0.02,
    mispredictProb: 0.08,
    // reorderProb: probability per packet that its delivery time gets
    // swapped with the next-queued packet's, producing visible
    // out-of-order arrival even when sorted by deliveryAt. Real
    // jitter already produces some natural reordering near burst
    // boundaries; this is the explicit-stress-test knob for the C
    // engine's out-of-order input handling. Default 0.
    reorderProb: 0,
  };

  const _clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
  const _now = () => _nativeNow();

  const _zeroInput = () => ({ buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 });

  const _randomAxis = () => {
    const max = window.KNShared?.N64_MAX ?? 83;
    const mag = Math.max(18, Math.round((0.35 + Math.random() * 0.65) * max));
    return Math.random() < 0.5 ? -mag : mag;
  };

  const _randomInput = () => {
    if (Math.random() < 0.65) {
      const bit = BUTTON_BITS[Math.floor(Math.random() * BUTTON_BITS.length)];
      return { buttons: 1 << bit, lx: 0, ly: 0, cx: 0, cy: 0 };
    }
    if (Math.random() < 0.5) {
      return { buttons: 0, lx: _randomAxis(), ly: _randomAxis(), cx: 0, cy: 0 };
    }
    return { buttons: 0, lx: 0, ly: 0, cx: _randomAxis(), cy: _randomAxis() };
  };

  // In-match P2 behavior: hold each random input for several frames before
  // changing, so P2 acts more like a player making decisions than a key
  // masher. Every change is a fresh "decision" the engine predicted as the
  // previous-frame input — when the new input arrives, the prediction
  // misses and rollback fires. That's what produces the visible Rollbacks
  // counter (vs. Predictions, which counts every frame the engine ran
  // ahead regardless of whether the prediction was right).
  let _heldRandomInput = null;
  let _heldUntilFrame = -1;
  // ±2-unit ADC-style noise for jitter mode. Returns a fresh integer in
  // [-2, +2] each call. Bias toward 0 (no jitter ~50% of frames) so the
  // boundary-hysteresis case fires on a fraction of frames matching the
  // real-hardware tremor cadence rather than every single frame.
  const _adcJitter = () => {
    const r = Math.random();
    if (r < 0.5) return 0;
    if (r < 0.75) return 1;
    if (r < 0.9) return -1;
    if (r < 0.97) return 2;
    return -2;
  };
  const _applyJitter = (input) => {
    if (!_jitterEnabled) return input;
    // Don't jitter pure button-only frames (lx/ly/cx/cy all zero) — that's
    // a "stick centered, no input" frame and adding noise there would
    // actually CREATE divergence we don't want to model. Real ADC noise
    // is only present when the stick is being pushed off-center.
    if (input.lx === 0 && input.ly === 0 && input.cx === 0 && input.cy === 0) return input;
    return {
      buttons: input.buttons,
      lx: input.lx ? input.lx + _adcJitter() : 0,
      ly: input.ly ? input.ly + _adcJitter() : 0,
      cx: input.cx ? input.cx + _adcJitter() : 0,
      cy: input.cy ? input.cy + _adcJitter() : 0,
    };
  };
  // Marks a window of frames where ALL packets get a delivery spike.
  // Single-packet spikes don't trigger rollback because the redundancy
  // buffer (REDUNDANT_FRAMES=5 frames in each on-time packet) carries
  // older inputs forward and pre-empts the spike. Spiking a CONTIGUOUS
  // window > REDUNDANT_FRAMES blocks the redundancy bypass — both the
  // primary packet AND its 5-deep redundancy carriers are all delayed
  // together, so the engine genuinely has nothing to apply at the
  // apply-frame deadline → predicts → mispredicts when the burst
  // eventually arrives → rollback.
  // 6-frame window matches the real-network behavior of brief
  // congestion: a queue stalls for ~100 ms, all packets release together.
  let _spikeWindowEnd = -1;
  const SPIKE_BURST_FRAMES = 6;
  const _matchInputForFrame = (frame) => {
    if (frame > _heldUntilFrame || !_heldRandomInput) {
      _heldRandomInput = _randomInput();
      // Hold 30-90 frames (~500ms-1.5s) — closer to real human button-hold
      // cadence (run, charge, neutral).
      _heldUntilFrame = frame + 30 + Math.floor(Math.random() * 60);
      // Open a 6-frame spike window that includes this transition + the
      // next 5 packets, blocking redundancy bypass.
      _spikeWindowEnd = frame + SPIKE_BURST_FRAMES - 1;
    }
    return _applyJitter(_heldRandomInput);
  };

  const _pruneEvents = (now) => {
    while (_events.length > 0 && now - _events[0].t > STATS_WINDOW_MS) _events.shift();
  };

  const _recordEvent = (event) => {
    const now = _now();
    _events.push({ t: now, ...event });
    _pruneEvents(now);
  };

  const _recordGeneratedInput = (frame, input) => {
    _inputHistory.push({ frame, input });
    while (_inputHistory.length > 30) _inputHistory.shift();
  };

  const _redundantForFrame = (frame) =>
    _inputHistory
      .filter((entry) => entry.frame < frame)
      .slice(-REDUNDANT_FRAMES)
      .map((entry) => ({ frame: entry.frame, ...entry.input }));

  const _scheduleFrame = (frame, now) => {
    // ?record=p2 mode: demo.js publishes the user's live keyboard input on
    // window.__knDemoP2LiveInput each frame. Use that as P2's input so the
    // user steers P2's CSS cursor while P1 follows the baked autopilot.
    // Takes precedence over both in-match random and out-of-match zero.
    const liveP2 = window.__knDemoP2LiveInput;
    let input;
    if (liveP2) {
      input = {
        buttons: liveP2.buttons | 0,
        lx: liveP2.lx | 0,
        ly: liveP2.ly | 0,
        cx: liveP2.cx | 0,
        cy: liveP2.cy | 0,
      };
    } else {
      // In an actual match, P2 plays held random inputs — drives authentic
      // mispredictions because the engine predicts "same as last frame" and
      // gets surprised every time P2 picks a new input. Outside a match
      // (title/CSS/menus) the demo provides a baked P2 menu-autopilot via
      // _getMirroredInput so the synthetic peer makes its CSS character
      // selection. Falls through to zero / mispredict-prob when the
      // recording has no entry for this frame.
      const inMatch = !!window.NetplayRollback?.isInMatch?.();
      if (inMatch) {
        input = _matchInputForFrame(frame);
      } else if (_getMirroredInput) {
        const mirrored = _getMirroredInput(frame);
        input = mirrored || _zeroInput();
      } else {
        const mispredict = Math.random() < _network.mispredictProb;
        input = mispredict ? _randomInput() : _zeroInput();
        if (mispredict) _recordEvent({ mispredict: true });
      }
    }
    _recordGeneratedInput(frame, input);

    if (Math.random() < _network.lossProb) {
      _recordEvent({ loss: true });
      return;
    }

    const jitter = _network.jitterMs > 0 ? (Math.random() * 2 - 1) * _network.jitterMs : 0;
    // Spike all packets in the 6-frame burst window after a transition.
    // Single-packet spikes don't trigger rollback (redundancy bypass);
    // spiking the whole burst blocks both primary AND redundant copies,
    // so the engine genuinely has to predict → mispredicts when the
    // delayed burst arrives → visible rollback.
    // 100 ms spike at 100 ms RTT (delay≈5) puts arrival at engine-frame
    // F+9 ≈ depth 4 past apply, well within visible_rb_max=12.
    let spikeMs = 0;
    if (_network.latencyMs > 0 && frame <= _spikeWindowEnd) {
      spikeMs = 100;
      if (frame === _spikeWindowEnd) {
        _recordEvent({ spike: true, spikeMs: Math.round(spikeMs) });
      }
    }
    const newEntry = {
      frame,
      input,
      scheduledDeliveryAt: now + Math.max(0, _network.latencyMs + jitter + spikeMs),
      enqueuedAt: now,
    };
    // Explicit reorder simulation: with reorderProb, swap this packet's
    // delivery time with the most-recently-queued one so the C engine
    // sees an out-of-order arrival (later frame number, earlier delivery).
    // Distinct from the natural jitter-driven reorder near burst boundaries
    // — this fires regardless of jitter level, useful for stress-testing
    // when the test harness wants OOO every N packets.
    if (_network.reorderProb > 0 && _queue.length > 0 && Math.random() < _network.reorderProb) {
      const prev = _queue[_queue.length - 1];
      const tmp = prev.scheduledDeliveryAt;
      prev.scheduledDeliveryAt = newEntry.scheduledDeliveryAt;
      newEntry.scheduledDeliveryAt = tmp;
      _recordEvent({ reorder: true });
    }
    _queue.push(newEntry);
  };

  const _injectNow = (frame, input, observedRttMs = 0) =>
    !!window.NetplayRollback?.injectRemoteInput?.({
      slot: _slot,
      frame,
      input,
      ackFrame: Math.max(-1, _lastEngineFrameSeen - 1),
      redundantFrames: _redundantForFrame(frame),
      observedRttMs,
    });

  const _drainQueue = (now) => {
    const due = [];
    const pending = [];
    for (const entry of _queue) {
      if (entry.scheduledDeliveryAt <= now) due.push(entry);
      else pending.push(entry);
    }
    _queue = pending;
    due.sort((a, b) => a.scheduledDeliveryAt - b.scheduledDeliveryAt || a.frame - b.frame);

    for (const entry of due) {
      const hud = window.NetplayRollback?.getHudCounters?.();
      const engineFrameAtDelivery = Math.max(0, Math.trunc(Number(hud?.currentFrame) || _lastEngineFrameSeen));
      const delay = Math.max(0, Math.trunc(Number(hud?.delay) || 0));
      const frameLateness = Math.max(0, engineFrameAtDelivery - delay - entry.frame);
      // observedRttMs is RTT (round-trip) per netplay-rollback's contract.
      // _network.latencyMs is the one-way travel time we apply to the
      // delivery schedule; doubling it gives the round-trip equivalent
      // that a real peer would have measured via the delay-ping handshake.
      const accepted = _injectNow(entry.frame, entry.input, _network.latencyMs * 2);
      _recordEvent({
        delivered: !!accepted,
        lateness: frameLateness * (1000 / 60),
      });
    }
  };

  const _tick = () => {
    if (!_running) return;
    const now = _now();
    const hud = window.NetplayRollback?.getHudCounters?.();
    const engineFrame = Math.max(0, Math.trunc(Number(hud?.currentFrame ?? _getCurrentFrame()) || 0));
    _lastEngineFrameSeen = engineFrame;

    // Initialize OR detect a large engine frame reset (state load, late join,
    // post-sync transition). Normal C-rollback depth is <= 12 frames; anything
    // larger means the engine reset its frame counter, so we drop in-flight
    // packets and re-baseline.
    const RESET_BACKWARD_THRESHOLD = 30;
    const isReset = _lastSeenFrame >= 0 && _lastSeenFrame - engineFrame > RESET_BACKWARD_THRESHOLD;
    if (_lastSeenFrame < 0 || isReset) {
      _lastSeenFrame = Math.max(-1, engineFrame - 1);
      _queue = [];
      _inputHistory = [];
    }

    for (let frame = _lastSeenFrame + 1; frame <= engineFrame; frame++) {
      _scheduleFrame(frame, now);
    }
    _lastSeenFrame = Math.max(_lastSeenFrame, engineFrame);
    _drainQueue(now);
    _rafId = _nativeRAF(_tick);
  };

  const start = ({ slot = 1, getCurrentFrame, getMirroredInput } = {}) => {
    stop();
    _slot = Number.isInteger(slot) ? slot : 1;
    _getCurrentFrame = typeof getCurrentFrame === 'function' ? getCurrentFrame : () => 0;
    _getMirroredInput = typeof getMirroredInput === 'function' ? getMirroredInput : null;
    const currentFrame = Math.max(0, Math.trunc(Number(_getCurrentFrame()) || 0));
    _lastEngineFrameSeen = currentFrame;
    _lastSeenFrame = -1;
    _running = true;
    _rafId = _nativeRAF(_tick);
  };

  const stop = () => {
    _running = false;
    if (_rafId) _nativeCancelRAF(_rafId);
    _rafId = 0;
    _queue = [];
    _inputHistory = [];
    _events = [];
    _getMirroredInput = null;
    _heldRandomInput = null;
    _heldUntilFrame = -1;
  };

  const setNetwork = ({ latencyMs, jitterMs, lossProb, mispredictProb, reorderProb } = {}) => {
    _network = {
      latencyMs: _clamp(latencyMs ?? _network.latencyMs, 0, 300),
      jitterMs: _clamp(jitterMs ?? _network.jitterMs, 0, 100),
      lossProb: _clamp(lossProb ?? _network.lossProb, 0, 0.3),
      mispredictProb: _clamp(mispredictProb ?? _network.mispredictProb, 0, 0.5),
      reorderProb: _clamp(reorderProb ?? _network.reorderProb, 0, 0.5),
    };
    // Seed the synthetic peer's RTT samples so the match-start delay
    // negotiation in netplay-rollback computes an RTT-tuned delay instead
    // of falling back to DEFAULT_DELAY_FRAMES=2. Without this, the demo's
    // ?fakePeerJitter and KNFakePeer.setNetwork latency settings have no
    // effect on the delay budget — every demo session runs with delay=2
    // regardless of simulated RTT, and rollback rate is artificially high.
    // Real WebRTC peers fill their own samples from real pings; this is
    // demo-only seeding via the dedicated rollback API.
    try {
      window.NetplayRollback?.seedSyntheticRtt?.({
        slot: _slot,
        rttMs: _network.latencyMs * 2,
        // Jitter on a per-packet delivery is one-way; the corresponding
        // RTT-side jitter on a round-trip ping would also be one-way at
        // each leg → ~2x the one-way jitterMs at the round-trip
        // measurement. Match real ping behaviour so the IQR formula
        // sees representative spread.
        jitterMs: _network.jitterMs * 2,
      });
    } catch (_) {}
  };

  const getStats = () => {
    const now = _now();
    _pruneEvents(now);
    const lateness = _events
      .map((event) => event.lateness)
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    const p95Index = lateness.length > 0 ? Math.floor((lateness.length - 1) * 0.95) : -1;
    const recent = _events.filter((event) => now - event.t <= LAST_SEC_MS);
    return {
      p95LatenessMs: p95Index >= 0 ? lateness[p95Index] : 0,
      queuedPackets: _queue.length,
      mispredictsLastSec: recent.filter((event) => event.mispredict).length,
      lossLastSec: recent.filter((event) => event.loss).length,
      reordersLastSec: recent.filter((event) => event.reorder).length,
      spikesLastSec: recent.filter((event) => event.spike).length,
      maxSpikeMs: Math.max(0, ..._events.filter((e) => e.spikeMs).map((e) => e.spikeMs)),
    };
  };

  window.KNFakePeer = {
    start,
    stop,
    setNetwork,
    getStats,
  };
})();
