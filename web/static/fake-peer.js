(function () {
  'use strict';

  const STATS_WINDOW_MS = 5000;
  const LAST_SEC_MS = 1000;
  const REDUNDANT_FRAMES = 5;
  const BUTTON_BITS = [0, 1, 3, 4, 5, 6, 7, 10, 11, 12];
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
  const _matchInputForFrame = (frame) => {
    if (frame > _heldUntilFrame || !_heldRandomInput) {
      _heldRandomInput = _randomInput();
      // Hold 3-15 frames (~50-250 ms) — roughly human reaction-cadence.
      _heldUntilFrame = frame + 3 + Math.floor(Math.random() * 12);
    }
    return _heldRandomInput;
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
      // (title/CSS/menus) P2 stays inert so the user's autopilot isn't
      // fighting an invisible opponent jamming buttons on menu screens.
      const inMatch = !!window.NetplayRollback?.isInMatch?.();
      if (inMatch) {
        input = _matchInputForFrame(frame);
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
    _queue.push({
      frame,
      input,
      scheduledDeliveryAt: now + Math.max(0, _network.latencyMs + jitter),
      enqueuedAt: now,
    });
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
      const accepted = _injectNow(entry.frame, entry.input, _network.latencyMs);
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

  const setNetwork = ({ latencyMs, jitterMs, lossProb, mispredictProb } = {}) => {
    _network = {
      latencyMs: _clamp(latencyMs ?? _network.latencyMs, 0, 300),
      jitterMs: _clamp(jitterMs ?? _network.jitterMs, 0, 100),
      lossProb: _clamp(lossProb ?? _network.lossProb, 0, 0.3),
      mispredictProb: _clamp(mispredictProb ?? _network.mispredictProb, 0, 0.5),
    };
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
    };
  };

  window.KNFakePeer = {
    start,
    stop,
    setNetwork,
    getStats,
  };
})();
