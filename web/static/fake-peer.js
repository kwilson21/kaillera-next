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
  // Override for the "is the demo currently in an active match" decision.
  // null  → fall back to NetplayRollback.isInMatch() (scene+status read).
  // bool  → demo.js has explicit knowledge that overrides the scene/status
  //         heuristic. SSB64's status value during the GAME!/results
  //         animation isn't verified to flip away from 1, so without this
  //         override fake-peer can keep firing random P2 inputs after the
  //         user perceives match end.
  let _matchActiveOverride = null;
  // Tracks the previous inMatch decision so we can reset held random-input
  // state on the true→false edge — otherwise stale held buttons / stick
  // values can leak into the next match's first 30-90 frames before the
  // hold timer expires and a fresh random input is generated.
  let _lastInMatch = false;
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
  // Spike window: a contiguous burst of frames where ALL packets get
  // delivery delay. Must be > REDUNDANT_FRAMES=5 to block the
  // redundancy bypass — single-packet spikes get pre-empted by
  // redundant copies in the next on-time packet. Real-world analog:
  // brief network congestion (~100 ms queue stall, packets release
  // together).
  //
  // Triggered on a fixed wall-clock cadence (every ~750 ms) rather
  // than on P2 input transitions. Transitions varied with the random
  // hold timing, so spike rate drifted with RTT. Fixed cadence keeps
  // the rollback counter incrementing predictably as the user moves
  // the slider.
  let _spikeWindowEnd = -1;
  let _nextSpikeAtFrame = -1;
  const SPIKE_BURST_FRAMES = 6;
  const SPIKE_INTERVAL_FRAMES_MIN = 30; // ~500 ms at 60fps
  const SPIKE_INTERVAL_FRAMES_MAX = 60; // ~1 s at 60fps
  const _matchInputForFrame = (frame) => {
    if (frame > _heldUntilFrame || !_heldRandomInput) {
      _heldRandomInput = _randomInput();
      // Hold 30-90 frames (~500ms-1.5s) — closer to real human button-hold
      // cadence (run, charge, neutral).
      _heldUntilFrame = frame + 30 + Math.floor(Math.random() * 60);
    }
    return _applyJitter(_heldRandomInput);
  };
  // Open a new spike window when due. The burst always includes a
  // transition window — but TIMING of spikes is detached from transitions,
  // so the rollback rate is stable as the user moves the RTT slider.
  const _maybeOpenSpikeWindow = (frame) => {
    if (_nextSpikeAtFrame < 0) {
      _nextSpikeAtFrame =
        frame +
        SPIKE_INTERVAL_FRAMES_MIN +
        Math.floor(Math.random() * (SPIKE_INTERVAL_FRAMES_MAX - SPIKE_INTERVAL_FRAMES_MIN));
      return;
    }
    if (frame >= _nextSpikeAtFrame && frame > _spikeWindowEnd) {
      _spikeWindowEnd = frame + SPIKE_BURST_FRAMES - 1;
      _nextSpikeAtFrame =
        frame +
        SPIKE_INTERVAL_FRAMES_MIN +
        Math.floor(Math.random() * (SPIKE_INTERVAL_FRAMES_MAX - SPIKE_INTERVAL_FRAMES_MIN));
    }
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
      // (title/CSS/menus, post-match results, between matches) the demo
      // provides a baked P2 menu-autopilot via _getMirroredInput so the
      // synthetic peer makes its CSS character selection. Falls through to
      // zero / mispredict-prob when the recording has no entry for this
      // frame.
      //
      // The "are we in a match" decision prefers _matchActiveOverride when
      // demo.js has set it explicitly; otherwise it falls back to the
      // engine's scene+status read. The override exists because SSB64's
      // status value during the GAME!/results animation isn't verified to
      // flip away from 1, so the scene+status check can return true
      // longer than the user perceives "match has ended" — fake-peer
      // would keep firing random inputs into the post-match animation.
      const inMatch = _matchActiveOverride !== null ? !!_matchActiveOverride : !!window.NetplayRollback?.isInMatch?.();
      if (inMatch !== _lastInMatch) {
        // Edge transition: drop any held random input so the next match
        // starts fresh and post-match frames don't carry forward a stale
        // button-hold past the inMatch=false boundary.
        _heldRandomInput = null;
        _heldUntilFrame = -1;
        _lastInMatch = inMatch;
      }
      if (inMatch) {
        input = _matchInputForFrame(frame);
        // Open a 6-frame spike burst window on a fixed cadence (~500ms-1s).
        // Without this, the natural-jitter network simulation never pushes
        // peer arrival past the apply-frame deadline (delay covers RTT/2 +
        // jitter cleanly) so rollbacks never fire. Spikes simulate the
        // real-world brief network congestion that GGPO-style rollback is
        // designed to recover from.
        _maybeOpenSpikeWindow(frame);
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
    // Spike all packets in the burst window after a transition.
    // Single-packet spikes don't trigger rollback (redundancy bypass);
    // spiking the whole burst blocks both primary AND redundant copies,
    // so the engine genuinely has to predict → mispredicts when the
    // delayed burst arrives → visible rollback in the counter.
    // 50 ms spike at 100 ms RTT (delay≈5) puts arrival at engine-frame
    // F+8 ≈ depth 3 past apply. With burst=1 spreading replay, that's
    // 3 ticks of catch-up — finishes inside one render-frame budget on
    // most occurrences, so the rollback counter visibly increments
    // without a perceptible hitch most of the time. 100 ms produced
    // depth 6-9 which read as a brief stutter ~12% of the time.
    let spikeMs = 0;
    if (_network.latencyMs > 0 && frame <= _spikeWindowEnd) {
      // 60 ms spike = "Wi-Fi interference" / "cable peak-hour micro-burst"
      // — solidly in the realistic-real-network range. Sized so rollback
      // depth lands in shipping-fighter territory (3-7 frames):
      //   slider 0 ms RTT:    depth ~3.6  (under cap=7)
      //   slider 50 ms RTT:   depth ~5.1  (under cap)
      //   slider 100 ms RTT:  depth ~6.6  (under cap, matches GGPO worst-case)
      //   slider 130+ ms RTT: depth ~8+  (exceeds cap, silently drops)
      // The 130+ silent-drop region is the truthful equivalent of "a
      // 150 ms RTT match where rollback can't keep up" — same thing
      // happens in real GGPO games on a bad day. Demo's HUD shows rollback
      // counter ticking strongly across slider 0-120 ms, taper at the very
      // top — no fake "we recovered" signal where real netplay couldn't.
      // Earlier values: 100 ms (baseline) overshot cap; latencyMs+60
      // (uncommitted) overshot it more. Both produced 167-200 ms freezes
      // out of the engine's burst-1 reply path.
      spikeMs = 60;
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

  // Stall detection: when the engine's frame counter hasn't advanced
  // for this many rAFs, fake-peer is allowed to schedule speculatively
  // past engineFrame (lookahead). Avoids the receiver↔sender deadlock
  // when auto-compare pauses predictions during a 60 ms latency spike:
  // engine stalls waiting for missing input, fake-peer reads the
  // frozen engineFrame and stops scheduling, ROLLBACK-STALL fires 3 s
  // later. Threshold = 3 rAFs (~50 ms): well past normal frame timing
  // jitter, well below the 3 s ROLLBACK-STALL trigger.
  const STALL_DETECT_FRAMES = 3;
  // How far past engineFrame fake-peer is allowed to schedule when a
  // stall is detected. Sized so a single 60 ms burst spike has its
  // queued packets drained AND fake-peer keeps producing through the
  // recovery window. In normal (non-stalled) operation the lookahead
  // is 0 so fake-peer's pacing matches the engine's frame counter and
  // rollbacks fire as designed.
  const STALL_LOOKAHEAD_FRAMES = 6;
  let _stallTickCount = 0;
  let _lastEngineFrameSeenForStall = -1;
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

    // Detect engine stall: rAFs in a row with no frame advance.
    if (engineFrame === _lastEngineFrameSeenForStall) {
      _stallTickCount++;
    } else {
      _stallTickCount = 0;
      _lastEngineFrameSeenForStall = engineFrame;
    }
    // Schedule one input per rAF in normal play (matching the engine's
    // pace). When the engine stalls past STALL_DETECT_FRAMES, allow
    // speculative scheduling past engineFrame up to STALL_LOOKAHEAD_FRAMES
    // ahead — keeps producing inputs that bridge the recovery window
    // when main unstalls. Without lookahead, a paused-predictions stall
    // would deadlock: main waits for missing remote input, fake-peer
    // reads the frozen engineFrame and stops scheduling. With infinite
    // lookahead, fake-peer outruns the engine to the point where every
    // remote input is already present and rollbacks never fire — that
    // breaks the demo's purpose. The conditional design preserves the
    // rollback-fires-on-jitter behavior in normal play AND breaks the
    // deadlock when it triggers.
    const lookahead = _stallTickCount >= STALL_DETECT_FRAMES ? STALL_LOOKAHEAD_FRAMES : 0;
    const lookaheadCap = engineFrame + lookahead;
    const targetFrame = Math.max(engineFrame, Math.min(_lastSeenFrame + 1, lookaheadCap));
    let scheduledThisTick = 0;
    for (let frame = _lastSeenFrame + 1; frame <= targetFrame; frame++) {
      _scheduleFrame(frame, now);
      scheduledThisTick++;
    }
    _lastSeenFrame = Math.max(_lastSeenFrame, targetFrame);
    _drainQueue(now);
    if (window.__knFakePeerProbe) {
      window.__knFakePeerProbe.push({
        t: now,
        engineFrame,
        lastSeenFrame: _lastSeenFrame,
        stallTicks: _stallTickCount,
        lookahead,
        scheduledThisTick,
        queueLen: _queue.length,
      });
      if (window.__knFakePeerProbe.length > 4_000) window.__knFakePeerProbe.shift();
    }
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
    _matchActiveOverride = null;
    _lastInMatch = false;
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
    _matchActiveOverride = null;
    _lastInMatch = false;
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

  // Demo.js calls this to authoritatively gate match-style random inputs.
  // Pass true at the inMatch=true edge in _updateHud, false at the
  // inMatch=false edge. Pass null to fall back to the engine's
  // isInMatch() scene+status read (default behavior). Demo.js's higher
  // level state machine is more reliable than the unverified SSB64
  // status-during-results-screen value, so the override is preferred
  // once the demo has explicit knowledge of match phase.
  const setMatchActive = (active) => {
    _matchActiveOverride = active === null || active === undefined ? null : !!active;
    // On the demo→inactive edge, fully tear down match-style state:
    //   - clear the held random-input timer so a stale button-hold
    //     can't replay if match starts again,
    //   - drop the in-flight _queue so any random inputs scheduled
    //     during the match (still latency-delayed at delivery) don't
    //     leak into the engine's input ring after the match has
    //     visibly ended. _injectNow on stale frames is mostly a no-op
    //     (out-of-window guard) but flushing keeps the contract clean.
    if (_matchActiveOverride === false) {
      _heldRandomInput = null;
      _heldUntilFrame = -1;
      _lastInMatch = false;
      _queue = [];
    }
  };

  window.KNFakePeer = {
    start,
    stop,
    setNetwork,
    setMatchActive,
    getStats,
  };
})();
