/**
 * kn-audio.js — Lockstep audio pipeline for kaillera-next.
 *
 * Extracted from netplay-lockstep.js. Handles:
 *   - AudioContext lifecycle (creation, gesture resume, cleanup)
 *   - AudioWorklet with ScriptProcessorNode fallback
 *   - Per-frame PCM feed from WASM core exports
 *   - Resync audio fade-out/fade-in
 *   - Host MediaStream destination for spectator audio
 *
 * Interface:
 *   window.KNAudio.init(ctx)   — initialize with context callbacks
 *   window.KNAudio.feed()      — feed one frame of audio (call from tick loop)
 *   window.KNAudio.cleanup()   — tear down all audio resources
 *   window.KNAudio.destNode    — MediaStreamDestination for spectator stream (read-only)
 *   window.KNAudio.ready       — true when audio is playing
 *   window.KNAudio.ctx         — the AudioContext (for external checks)
 */
(function () {
  'use strict';

  // -- State --
  let _audioCtx = null;
  let _audioWorklet = null;
  let _audioDestNode = null;
  let _audioPtr = 0;
  let _audioRate = 0;
  let _audioReady = false;

  // Feed diagnostics
  let _audioFeedCount = 0;
  let _audioEmptyCount = 0;
  let _audioErrorLogged = false;
  let _audioSuspendedToastShown = false;

  // Context callbacks — set by init()
  let _log = () => {}; // (msg: string) => void
  let _getFrame = () => 0; // () => number (current frame)
  let _getSlot = () => -1; // () => number (player slot, 0 = host)
  let _getLastRbFrame = () => null; // () => number|null
  let _getResetAudioCalls = () => 0; // () => number
  let _knEvent = () => {}; // (name, msg, meta) => void

  // -- Public API --

  async function init(ctx) {
    _log = ctx.log || _log;
    _getFrame = ctx.getFrame || _getFrame;
    _getSlot = ctx.getSlot || _getSlot;
    _getLastRbFrame = ctx.getLastRbFrame || _getLastRbFrame;
    _getResetAudioCalls = ctx.getResetAudioCalls || _getResetAudioCalls;
    _knEvent = ctx.knEvent || _knEvent;

    const mod = window.EJS_emulator?.gameManager?.Module;
    if (!mod) return;

    if (!mod._kn_get_audio_ptr || !mod._kn_get_audio_samples || !mod._kn_reset_audio || !mod._kn_get_audio_rate) {
      _log('audio capture exports not found — audio disabled');
      return;
    }

    _audioPtr = mod._kn_get_audio_ptr();
    _audioRate = mod._kn_get_audio_rate();
    const initSamples = mod._kn_get_audio_samples();
    const alCtxCount = mod.AL?.contexts ? Object.keys(mod.AL.contexts).length : 0;
    _log(
      `audio init: ptr=${_audioPtr} rate=${_audioRate} initSamples=${initSamples} alCtx=${alCtxCount} f=${_getFrame()}`,
    );
    if (!_audioRate || _audioRate <= 0) {
      _log('audio rate not set yet, defaulting to 33600');
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
          if (_audioCtx.state !== 'running') {
            _audioCtx.resume().catch((e) => {
              _log(`preloaded AudioContext resume failed: ${e.name}: ${e.message}`);
            });
          }
          _log(
            `reusing host gesture-created AudioContext (state: ${_audioCtx.state}, rate: ${_audioCtx.sampleRate}, time: ${_audioCtx.currentTime.toFixed(2)})`,
          );
        } else {
          _audioCtx = new AudioContext({ sampleRate: _audioRate, latencyHint: 'interactive' });
        }
      } else {
        _log(`reusing gesture-created AudioContext (state: ${_audioCtx.state}, rate: ${_audioCtx.sampleRate})`);
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

          if (_getSlot() === 0) {
            _audioDestNode = _audioCtx.createMediaStreamDestination();
            _audioWorklet.connect(_audioDestNode);
          }

          _audioWorklet.connect(_audioCtx.destination);
          workletOk = true;
          _log('audio using AudioWorklet');
        } catch (wErr) {
          _log(`AudioWorklet failed, using fallback: ${wErr.message}`);
          _knEvent('audio-fail', `AudioWorklet failed: ${wErr.message}`, { error: wErr.message });
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
        if (_getSlot() === 0) {
          _audioDestNode = _audioCtx.createMediaStreamDestination();
          spNode.connect(_audioDestNode);
        }
        const gestureDest = window._kn_gestureAudioDest;
        if (gestureDest && gestureDest.context === _audioCtx) {
          spNode.connect(gestureDest);
          _log(`audio using ScriptProcessorNode fallback via <audio> element (ring=${ringSize})`);
        } else {
          if (gestureDest)
            _log('gesture audio destination belongs to a different AudioContext; using direct destination');
          spNode.connect(_audioCtx.destination);
          _log(`audio using ScriptProcessorNode fallback (ring=${ringSize})`);
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
            _log(`audio resumed via gesture (state: ${_audioCtx.state})`);
            document.removeEventListener('click', resumeAudio, true);
            document.removeEventListener('keydown', resumeAudio, true);
            document.removeEventListener('touchstart', resumeAudio, true);
          } catch (e) {
            _log(`audio resume failed: ${e.name}: ${e.message}`);
            _knEvent('audio-fail', `AudioContext resume failed: ${e.name}: ${e.message}`, { error: e.name });
          }
        };
        document.addEventListener('click', resumeAudio, true);
        document.addEventListener('keydown', resumeAudio, true);
        document.addEventListener('touchstart', resumeAudio, true);
        _log(`audio context state: ${_audioCtx.state} — waiting for gesture to resume`);
      }

      _log(`audio playback initialized (rate: ${_audioRate})`);
    } catch (err) {
      _log(`audio init failed: ${err}`);
      _audioReady = false;
    }
  }

  function feed() {
    try {
      if (!_audioReady || !_audioCtx) return;
      // BF1/BF8: don't feed audio into a suspended context — attempt resume instead
      if (_audioCtx.state === 'suspended') {
        _audioCtx.resume().catch(() => {});
        return;
      }
      const mod = window.EJS_emulator?.gameManager?.Module;
      if (!mod) return;

      const n = mod._kn_get_audio_samples();
      if (n <= 0) {
        _audioEmptyCount++;
        // Log first 30 empty frames for diagnostics on fresh boot
        if (_audioEmptyCount <= 30) {
          const alCtxCount = mod.AL?.contexts ? Object.keys(mod.AL.contexts).length : 0;
          const sdlAudioState = mod.SDL2?.audioContext?.state ?? 'n/a';
          // RF6 Part A: rollback-correlation + subsystem state enrichment
          const rbDelta = _getLastRbFrame() != null ? _getFrame() - _getLastRbFrame() : -1;
          const ctxState = window.EJS_emulator?.audioContext?.state ?? 'unknown';
          const workletPort = _audioWorklet?.port ? 'open' : 'closed';
          _log(
            `audio-empty f=${_getFrame()} #${_audioEmptyCount} ptr=${_audioPtr} alCtx=${alCtxCount} sdlAudio=${sdlAudioState} ` +
              `lastRb=${_getLastRbFrame() ?? -1} ` +
              `rbDelta=${rbDelta} ` +
              `resetAudioCalls=${_getResetAudioCalls()} ` +
              `ctxState=${ctxState} ` +
              `workletPort=${workletPort}`,
          );
        }
        // Log once after 300 consecutive empty frames (~5s) to detect silent audio
        if (_audioEmptyCount === 300) {
          const alCtxCount = mod.AL?.contexts ? Object.keys(mod.AL.contexts).length : 0;
          const sdlState = mod.SDL2?.audioContext?.state ?? 'n/a';
          // RF6 Part A: rollback-correlation + subsystem state enrichment
          const rbDelta = _getLastRbFrame() != null ? _getFrame() - _getLastRbFrame() : -1;
          const ctxState = window.EJS_emulator?.audioContext?.state ?? 'unknown';
          const workletPort = _audioWorklet?.port ? 'open' : 'closed';
          _log(
            `audio-silent: ${_audioEmptyCount} consecutive frames with 0 samples (ptr=${_audioPtr} ctx=${_audioCtx.state} alCtx=${alCtxCount} sdlAudio=${sdlState}) ` +
              `lastRb=${_getLastRbFrame() ?? -1} ` +
              `rbDelta=${rbDelta} ` +
              `resetAudioCalls=${_getResetAudioCalls()} ` +
              `ctxState=${ctxState} ` +
              `workletPort=${workletPort}`,
          );
          // BF1: surface persistent audio failure to the user
          if (_audioCtx.state === 'suspended' && !_audioSuspendedToastShown) {
            _audioSuspendedToastShown = true;
            window.knShowToast?.('Audio blocked \u2014 click anywhere to enable sound', 'warn');
          }
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
        _log(
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
    } catch (audioErr) {
      if (!_audioErrorLogged) {
        _log(`AUDIO-ERROR: ${audioErr.message}`);
        _audioErrorLogged = true;
      }
    }
  }

  function cleanup() {
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
    _audioFeedCount = 0;
    _audioEmptyCount = 0;
    _audioErrorLogged = false;
    _audioSuspendedToastShown = false;
  }

  window.KNAudio = {
    init,
    feed,
    cleanup,
    get destNode() {
      return _audioDestNode;
    },
    get ready() {
      return _audioReady;
    },
    get ctx() {
      return _audioCtx;
    },
  };
})();
