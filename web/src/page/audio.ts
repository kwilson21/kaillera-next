/**
 * The netplay engine's sound: the samples the core captured each frame, played
 * through an AudioWorklet (or a ScriptProcessorNode where worklets are not
 * available). Moved from web/static/kn-audio.js; `window.KNAudio` is what
 * `startAudio(window)` returns.
 *
 *   init(callbacks)   set up the context and the output node
 *   feed()            play the frame the core just produced (the tick loop)
 *   ensureRunning()   ask the browser to resume a context it suspended
 *   cleanup()         drop every node and the context
 *   destNode          the host's MediaStreamDestination, for spectators
 *   ready             set-up finished and sound can be fed
 *   ctx               the AudioContext
 *
 * `feed` runs once per emulated frame. It allocates exactly what the script
 * allocated (a view of the core's buffer and one copy for the worklet) and
 * waits for nothing. The waits here are wall-clock comparisons made when a
 * frame is fed, not timers.
 */

/** The worklet that plays the samples; a plain script in its own context. */
export const AUDIO_WORKLET_URL = '/static/audio-worklet-processor.js';

/** The name audio-worklet-processor.js registers. */
export const AUDIO_WORKLET_NAME = 'lockstep-audio-processor';

/** The rate assumed when the core has not reported one yet (SSB64's). */
export const DEFAULT_AUDIO_RATE = 33600;

/** The core has not reported a sample rate yet; the default is played at. */
export const audioRateUnset = (reported: number): boolean => !reported || reported <= 0;

/** Length of the fallback ring: about 100 ms of interleaved stereo. */
export const ringSizeFor = (rate: number): number => Math.ceil(rate * 0.1) * 2;

/** An empty frame is logged for the first 30 in a row. */
export const logsEmptyFrame = (emptyInARow: number): boolean => emptyInARow <= 30;

/** 300 empty frames in a row (about 5 s) is reported once as silence. */
export const isSilence = (emptyInARow: number): boolean => emptyInARow === 300;

/** The first fed frame and every 600th (about 10 s) are logged. */
export const logsFedFrame = (fed: number): boolean => fed === 1 || fed % 600 === 0;

/** How many int16 values of a frame of `frames` stereo samples the level check reads. */
export const levelWindow = (frames: number): number => Math.min(frames * 2, 200);

/** Root mean square of int16 samples, for the periodic log line. */
export const pcmRms = (pcm: Int16Array): number => {
  let rms = 0;
  // The index is below the length, so the element is there.
  for (let ci = 0; ci < pcm.length; ci++) rms += pcm[ci]! * pcm[ci]!;
  return Math.sqrt(rms / pcm.length);
};

/** A context in this state takes samples. */
const isRunning = (state: string): boolean => state === 'running';

/** A context that is neither playing nor closed can be asked to resume. */
export const canResume = (state: string): boolean => state !== 'running' && state !== 'closed';

/** A resume is asked for at most once a second. */
export const resumeAttemptDue = (nowMs: number, lastAttemptMs: number): boolean => nowMs - lastAttemptMs > 1000;

/** The context's clock is compared with the wall clock once a second has passed. */
export const clockProbeDue = (wallDeltaSeconds: number): boolean => !(wallDeltaSeconds < 1.0);

/**
 * The context's clock kept up with the wall clock: it advanced at least half
 * as far. A context that reports `running` while its clock stands still plays
 * nothing (iOS after an audio-session interruption).
 */
export const clockKeptUp = (ctxDeltaSeconds: number, wallDeltaSeconds: number): boolean =>
  ctxDeltaSeconds >= wallDeltaSeconds * 0.5;

/** A stalled context is cycled (suspend, resume) at most once every two seconds. */
export const zombieRecoveryDue = (nowMs: number, lastRecoveryMs: number): boolean => !(nowMs - lastRecoveryMs < 2000);

/** After this many failed cycles the player is asked to tap. */
export const asksForTap = (attempt: number): boolean => attempt >= 3;

/**
 * The fallback ring, kept on the page as it always was: other scripts and the
 * test runner read `_kn_audioRingCount`. The three numbers are set when the
 * fallback is set up; before that only the feed log reads the count.
 */
export interface AudioRing {
  _kn_audioRing?: Float32Array | null | undefined;
  _kn_audioRingWrite: number;
  _kn_audioRingRead: number;
  _kn_audioRingCount: number;
}

/**
 * Put `frames` stereo samples of int16 PCM into the ring as floats in
 * [-1, 1). When the ring is full the oldest sample is dropped, so the reader
 * never falls behind data that was overwritten. Does nothing without a ring.
 */
export const pushPcm = (page: AudioRing, pcm: Int16Array, frames: number): void => {
  const ring = page._kn_audioRing;
  if (ring) {
    const rSize = ring.length;
    for (let i = 0; i < frames; i++) {
      if (page._kn_audioRingCount + 2 > rSize) {
        // Drop the oldest stereo sample on overflow instead of letting
        // the read pointer lag behind overwritten data.
        page._kn_audioRingRead = (page._kn_audioRingRead + 2) % rSize;
        page._kn_audioRingCount = Math.max(0, page._kn_audioRingCount - 2);
      }
      // `pcm` holds `frames` pairs, so both elements are there.
      ring[page._kn_audioRingWrite] = pcm[i * 2]! / 32768.0;
      ring[(page._kn_audioRingWrite + 1) % rSize] = pcm[i * 2 + 1]! / 32768.0;
      page._kn_audioRingWrite = (page._kn_audioRingWrite + 2) % rSize;
      page._kn_audioRingCount += 2;
    }
    if (page._kn_audioRingCount > rSize) page._kn_audioRingCount = rSize;
  }
};

/**
 * Fill one output block from the ring, silence where it has run dry. Called
 * by the ScriptProcessorNode. The ring is gone after `cleanup`; a node that
 * is still called then throws here, as the script did.
 */
export const pullRing = (page: AudioRing, outL: Float32Array, outR: Float32Array): void => {
  const ring = page._kn_audioRing!;
  const rSize = ring.length;
  for (let si = 0; si < outL.length; si++) {
    if (page._kn_audioRingCount >= 2) {
      // The read position is always below the ring's length.
      outL[si] = ring[page._kn_audioRingRead]!;
      outR[si] = ring[(page._kn_audioRingRead + 1) % rSize]!;
      page._kn_audioRingRead = (page._kn_audioRingRead + 2) % rSize;
      page._kn_audioRingCount -= 2;
    } else {
      outL[si] = 0;
      outR[si] = 0;
    }
  }
};

/**
 * A handler property typed the way the DOM types its own (`onaudioprocess`,
 * `onprocessorerror`): compared by method rules, so a real node fits.
 */
type Handler<E> = { handle(event: E): void }['handle'];

/** Something a node can be connected to. */
export interface AudioSink {
  readonly context: object;
}

/** The host's stream of the game's sound, for spectators. */
export interface AudioStreamDestination extends AudioSink {
  readonly stream: { getAudioTracks(): readonly object[] };
  disconnect(): void;
}

/** One block the ScriptProcessorNode asks for. */
interface AudioBlockRequest {
  readonly outputBuffer: { getChannelData(channel: number): Float32Array };
}

interface ScriptNode {
  onaudioprocess: Handler<AudioBlockRequest> | null;
  connect(destination: AudioSink): void;
  disconnect(): void;
}

interface WorkletNode {
  readonly port: { postMessage(message: Int16Array, transfer: ArrayBuffer[]): void };
  onprocessorerror: Handler<{ readonly message?: string } | undefined> | null;
  connect(destination: AudioSink): void;
  disconnect(): void;
}

interface WorkletNodeOptions {
  numberOfInputs: number;
  numberOfOutputs: number;
  outputChannelCount: number[];
  processorOptions: { sampleRate: number };
}

/** The part of an AudioContext the pipeline uses. */
export interface AudioCtx {
  readonly state: string;
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly destination: AudioSink;
  readonly audioWorklet?: { addModule(url: string): Promise<void> } | undefined;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamDestination(): AudioStreamDestination;
  createScriptProcessor(bufferSize: number, inputChannels: number, outputChannels: number): ScriptNode;
}

/** The emulator core's audio capture, as far as the pipeline reads it. */
export interface AudioCore {
  readonly _kn_get_audio_ptr?: (() => number) | undefined;
  readonly _kn_get_audio_samples?: (() => number) | undefined;
  readonly _kn_reset_audio?: (() => void) | undefined;
  readonly _kn_get_audio_rate?: (() => number) | undefined;
  readonly HEAPU8: { readonly buffer: ArrayBufferLike };
  readonly AL?: { readonly contexts?: object | undefined } | undefined;
  readonly SDL2?: { readonly audioContext?: { readonly state?: string } | undefined } | undefined;
}

/** What a diagnostic event may carry. */
interface AudioEventDetail {
  readonly error?: unknown;
  readonly reason?: string;
  readonly attempts?: number;
  readonly wallDelta?: number;
  readonly ctxDelta?: number;
  readonly state?: string;
}

/** What the engine hands `init`; anything left out keeps its last value. */
export interface AudioCallbacks {
  readonly log?: ((message: string) => void) | undefined;
  /** The engine's current frame. */
  readonly getFrame?: (() => number) | undefined;
  /** This player's slot; 0 is the host. */
  readonly getSlot?: (() => number) | undefined;
  /** The frame the last rollback finished on. */
  readonly getLastRbFrame?: (() => number | null) | undefined;
  readonly getResetAudioCalls?: (() => number) | undefined;
  readonly knEvent?: ((name: string, message: string, detail: AudioEventDetail) => void) | undefined;
}

/** The page globals the pipeline shares with play.js and the engine. */
export interface AudioGlobals<C extends AudioCtx> extends AudioRing {
  readonly EJS_emulator?:
    | {
        readonly gameManager?: { readonly Module?: AudioCore | undefined } | undefined;
        readonly audioContext?: { readonly state?: string } | undefined;
      }
    | undefined;
  /** A context the page made inside a click, while the browser still trusted it. */
  _kn_preloadedAudioCtx?: C | null | undefined;
  /** Where that context plays through an <audio> element (iOS). */
  readonly _kn_gestureAudioDest?: AudioSink | null | undefined;
  /** A silent oscillator that keeps that context's audio session alive. */
  _kn_keepAliveOsc?: { stop(): void } | null | undefined;
  _kn_scriptProcessor?: { disconnect(): void } | null | undefined;
  _kn_audioEl?: { pause(): void; srcObject: object | null } | null | undefined;
  readonly knShowToast?: ((message: string, type: string) => void) | undefined;
  /** The engine's dump of the core's audio registers. */
  readonly _knDumpAudioState?: ((label: string) => void) | undefined;
}

/** The part of `window` the pipeline uses. */
export interface AudioHost<C extends AudioCtx> extends AudioGlobals<C> {
  readonly AudioContext: new (options: { sampleRate: number; latencyHint: 'interactive' }) => C;
  readonly AudioWorkletNode: new (context: C, name: string, options: WorkletNodeOptions) => WorkletNode;
  readonly performance: { now(): number };
  readonly document: {
    readonly hidden: boolean;
    addEventListener(type: string, listener: () => void, capture: boolean): void;
    removeEventListener(type: string, listener: () => void, capture: boolean): void;
  };
}

/** `window.KNAudio`. */
export interface AudioPipeline<C extends AudioCtx> {
  readonly init: (callbacks: AudioCallbacks) => Promise<void>;
  readonly feed: () => void;
  readonly ensureRunning: (reason?: string) => boolean;
  readonly cleanup: () => void;
  readonly destNode: AudioStreamDestination | null;
  readonly ready: boolean;
  readonly ctx: C | null;
}

/** A thrown value, as far as a log line reads it. */
interface Thrown {
  readonly name?: unknown;
  readonly message?: unknown;
}

/**
 * Build the page's audio pipeline. Nothing is created until the engine calls
 * `init`; the returned object is assigned to `window.KNAudio`.
 */
export const startAudio = <C extends AudioCtx>(host: AudioHost<C>): AudioPipeline<C> => {
  let audioCtx: C | null = null;
  let audioWorklet: WorkletNode | null = null;
  let audioDestNode: AudioStreamDestination | null = null;
  let audioPtr = 0;
  let audioRate = 0;
  let audioReady = false;

  // Feed diagnostics
  let audioFeedCount = 0;
  let audioEmptyCount = 0;
  let audioErrorLogged = false;
  let audioSuspendedToastShown = false;
  // The gesture listener that resumes the context; dropped in cleanup().
  let resumeAudioHandler: (() => Promise<void>) | null = null;
  let lastResumeAttemptAt = 0;

  // Zombie-context detection: iOS Safari can leave audioCtx.state === 'running'
  // after an audio-session interruption (silent-switch, ringer, headphone
  // unplug) while currentTime stops advancing — feeding samples past that
  // point goes nowhere. Track ctx clock vs wall clock to catch it.
  let ctxClockProbeTime = 0;
  let ctxClockProbeWallMs = 0;
  let zombieDetected = false;
  let zombieRecoveryAttempts = 0;
  let lastZombieRecoveryAt = 0;

  // Set by init()
  let log: (message: string) => void = () => {};
  let getFrame: () => number = () => 0;
  let getSlot: () => number = () => -1;
  let getLastRbFrame: () => number | null = () => null;
  let getResetAudioCalls: () => number = () => 0;
  let knEvent: (name: string, message: string, detail: AudioEventDetail) => void = () => {};

  const removeResumeAudioListeners = (): void => {
    if (!resumeAudioHandler) return;
    host.document.removeEventListener('click', resumeAudioHandler, true);
    host.document.removeEventListener('keydown', resumeAudioHandler, true);
    host.document.removeEventListener('pointerdown', resumeAudioHandler, true);
    host.document.removeEventListener('touchstart', resumeAudioHandler, true);
    resumeAudioHandler = null;
  };

  const installResumeAudioListeners = (reason: string): void => {
    if (!audioCtx || !canResume(audioCtx.state)) {
      removeResumeAudioListeners();
      return;
    }
    if (resumeAudioHandler) return;

    // Resume AudioContext on user interaction (autoplay policy).
    // Use capture phase so EmulatorJS virtual controls can't block via
    // stopPropagation. Retry on every interaction until actually running.
    // The handler is kept so cleanup() can drop it even when the user
    // never gestures.
    resumeAudioHandler = async () => {
      if (!audioCtx || !canResume(audioCtx.state)) {
        removeResumeAudioListeners();
        return;
      }
      try {
        await audioCtx.resume();
        // cleanup() may have dropped the context during the wait; reading it
        // then throws into the catch below, as it did in the script.
        log(`audio resumed via gesture (${reason}, state: ${audioCtx!.state})`);
        if (isRunning(audioCtx!.state)) {
          audioSuspendedToastShown = false;
          removeResumeAudioListeners();
        }
      } catch (e) {
        // SAFETY: only read, exactly as the script read whatever was thrown.
        const thrown = e as Thrown;
        log(`audio resume failed: ${thrown.name}: ${thrown.message}`);
        knEvent('audio-fail', `AudioContext resume failed: ${thrown.name}: ${thrown.message}`, {
          error: thrown.name,
          reason,
        });
      }
    };
    host.document.addEventListener('click', resumeAudioHandler, true);
    host.document.addEventListener('keydown', resumeAudioHandler, true);
    host.document.addEventListener('pointerdown', resumeAudioHandler, true);
    host.document.addEventListener('touchstart', resumeAudioHandler, true);
    log(`audio context state: ${audioCtx.state} — waiting for gesture to resume (${reason})`);
  };

  function ensureRunning(reason = 'manual'): boolean {
    if (!audioCtx || audioCtx.state === 'closed') return false;
    if (isRunning(audioCtx.state)) {
      removeResumeAudioListeners();
      audioSuspendedToastShown = false;
      return true;
    }

    const now = host.performance.now();
    if (resumeAttemptDue(now, lastResumeAttemptAt)) {
      lastResumeAttemptAt = now;
      audioCtx
        .resume()
        .then(() => {
          log(`audio resume attempt (${reason}) -> ${audioCtx?.state || 'none'}`);
          if (audioCtx?.state === 'running') {
            audioSuspendedToastShown = false;
            removeResumeAudioListeners();
          }
        })
        .catch((e) => {
          log(`audio resume attempt failed (${reason}): ${e.name}: ${e.message}`);
          knEvent('audio-fail', `AudioContext resume failed: ${e.name}: ${e.message}`, {
            error: e.name,
            reason,
          });
        });
    }

    installResumeAudioListeners(reason);
    if (!audioSuspendedToastShown && reason !== 'init' && !host.document.hidden) {
      audioSuspendedToastShown = true;
      host.knShowToast?.('Audio blocked — click anywhere to enable sound', 'warn');
    }
    return false;
  }

  const attemptZombieRecovery = (): void => {
    if (!audioCtx || audioCtx.state === 'closed') return;
    const now = host.performance.now();
    if (!zombieRecoveryDue(now, lastZombieRecoveryAt)) return;
    lastZombieRecoveryAt = now;
    zombieRecoveryAttempts++;
    const attempt = zombieRecoveryAttempts;
    // suspend() then resume() forces iOS to re-acquire the audio session.
    // Plain resume() alone resolves successfully but doesn't reactivate
    // a session that was interrupted. cleanup() may drop the context while
    // these wait; reading it then throws into the catch, as in the script.
    audioCtx
      .suspend()
      .then(() => audioCtx!.resume())
      .then(() => {
        log(`audio-zombie recovery #${attempt}: state=${audioCtx!.state} time=${audioCtx!.currentTime.toFixed(2)}`);
      })
      .catch((e) => {
        log(`audio-zombie recovery #${attempt} failed: ${e.name}: ${e.message}`);
      });
    if (asksForTap(attempt) && !audioSuspendedToastShown) {
      audioSuspendedToastShown = true;
      host.knShowToast?.('Audio interrupted — tap anywhere to restart sound', 'warn');
      installResumeAudioListeners('zombie');
    }
  };

  // Detect "zombie" AudioContext: state === 'running' but currentTime stops
  // advancing. iOS Safari leaves the context in this state after an audio-
  // session interruption (silent-switch toggle, ringer, AirPods unplug, brief
  // background-app interruption). resume() resolves successfully but no
  // samples actually reach the speaker. Without detection we keep pushing
  // PCM into the void for the rest of the match.
  //
  // Strategy: every ~1s of wall time, compare AudioContext.currentTime delta
  // against wall delta. If wall advances but ctx clock is stuck, fire a
  // suspend()→resume() cycle which forces iOS to reactivate the audio
  // session. After repeated automatic recoveries fail, install a gesture
  // listener and toast the user — same pattern as the explicit-suspended
  // path in ensureRunning().
  const checkCtxClockHealth = (): void => {
    if (!audioCtx || !isRunning(audioCtx.state)) return;
    const ctxNow = audioCtx.currentTime;
    const wallNow = host.performance.now();
    if (ctxClockProbeWallMs === 0) {
      ctxClockProbeTime = ctxNow;
      ctxClockProbeWallMs = wallNow;
      return;
    }
    const wallDelta = (wallNow - ctxClockProbeWallMs) / 1000;
    if (!clockProbeDue(wallDelta)) return;
    const ctxDelta = ctxNow - ctxClockProbeTime;
    ctxClockProbeTime = ctxNow;
    ctxClockProbeWallMs = wallNow;

    // Healthy: ctx advances roughly with wall (allow some jitter).
    if (clockKeptUp(ctxDelta, wallDelta)) {
      if (zombieDetected) {
        log(
          `audio-zombie recovered f=${getFrame()} ctxDelta=${ctxDelta.toFixed(2)}s wallDelta=${wallDelta.toFixed(2)}s attempts=${zombieRecoveryAttempts}`,
        );
        knEvent('audio-recovered', `audio-zombie recovered after ${zombieRecoveryAttempts} attempts`, {
          attempts: zombieRecoveryAttempts,
        });
        zombieDetected = false;
        zombieRecoveryAttempts = 0;
        audioSuspendedToastShown = false;
      }
      return;
    }

    // Zombie: ctx clock stalled despite state === 'running'.
    if (!zombieDetected) {
      zombieDetected = true;
      log(
        `audio-zombie f=${getFrame()} ctx clock stalled (wallDelta=${wallDelta.toFixed(2)}s ctxDelta=${ctxDelta.toFixed(2)}s state=${audioCtx.state})`,
      );
      knEvent(
        'audio-fail',
        `audio-zombie ctx clock stalled wallDelta=${wallDelta.toFixed(2)}s ctxDelta=${ctxDelta.toFixed(2)}s`,
        {
          wallDelta,
          ctxDelta,
          state: audioCtx.state,
        },
      );
    }
    attemptZombieRecovery();
  };

  async function init(ctx: AudioCallbacks): Promise<void> {
    log = ctx.log || log;
    getFrame = ctx.getFrame || getFrame;
    getSlot = ctx.getSlot || getSlot;
    getLastRbFrame = ctx.getLastRbFrame || getLastRbFrame;
    getResetAudioCalls = ctx.getResetAudioCalls || getResetAudioCalls;
    knEvent = ctx.knEvent || knEvent;

    const mod = host.EJS_emulator?.gameManager?.Module;
    if (!mod) return;

    if (!mod._kn_get_audio_ptr || !mod._kn_get_audio_samples || !mod._kn_reset_audio || !mod._kn_get_audio_rate) {
      log('audio capture exports not found — audio disabled');
      return;
    }

    audioPtr = mod._kn_get_audio_ptr();
    audioRate = mod._kn_get_audio_rate();
    const initSamples = mod._kn_get_audio_samples();
    const alCtxCount = mod.AL?.contexts ? Object.keys(mod.AL.contexts).length : 0;
    log(`audio init: ptr=${audioPtr} rate=${audioRate} initSamples=${initSamples} alCtx=${alCtxCount} f=${getFrame()}`);
    if (audioRateUnset(audioRate)) {
      log('audio rate not set yet, defaulting to 33600');
      audioRate = DEFAULT_AUDIO_RATE;
    }

    try {
      // Reuse gesture-created context if available (already running on mobile).
      // For mobile hosts, play.js pre-creates one in the startGame() click handler
      // (window._kn_preloadedAudioCtx) since the engine starts audio 30+ seconds
      // after the gesture — past iOS's trust window.
      if (!audioCtx || audioCtx.state === 'closed') {
        const preloaded = host._kn_preloadedAudioCtx;
        if (preloaded && preloaded.state !== 'closed') {
          audioCtx = preloaded;
          delete host._kn_preloadedAudioCtx;
          if (!isRunning(audioCtx.state)) {
            audioCtx.resume().catch((e) => {
              log(`preloaded AudioContext resume failed: ${e.name}: ${e.message}`);
            });
          }
          log(
            `reusing host gesture-created AudioContext (state: ${audioCtx.state}, rate: ${audioCtx.sampleRate}, time: ${audioCtx.currentTime.toFixed(2)})`,
          );
        } else {
          audioCtx = new host.AudioContext({ sampleRate: audioRate, latencyHint: 'interactive' });
        }
      } else {
        log(`reusing gesture-created AudioContext (state: ${audioCtx.state}, rate: ${audioCtx.sampleRate})`);
        // Keep the gesture oscillator alive until a real audio node is connected.
        // Stopping it now would leave audioCtx with no active sources during the
        // async AudioWorklet probe, causing iOS to deactivate the audio session.
      }

      // Try AudioWorklet first (requires secure context), fall back to
      // AudioBufferSourceNode scheduling (works everywhere including mobile HTTP).
      // From the wait for the worklet module on, cleanup() or a second init()
      // may have replaced or dropped the context; each line below reads
      // whatever is there at that moment, as the script did, and a dropped
      // context ends in the catch at the bottom.
      let workletOk = false;
      if (audioCtx.audioWorklet) {
        try {
          await audioCtx.audioWorklet.addModule(AUDIO_WORKLET_URL);
          audioWorklet = new host.AudioWorkletNode(audioCtx, AUDIO_WORKLET_NAME, {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: { sampleRate: audioRate },
          });

          if (getSlot() === 0) {
            audioDestNode = audioCtx.createMediaStreamDestination();
            audioWorklet.connect(audioDestNode);
          }

          audioWorklet.connect(audioCtx.destination);
          audioWorklet.onprocessorerror = (e) => {
            const msg = e?.message || 'AudioWorklet processor error';
            log(`AudioWorklet processor error: ${msg}`);
            knEvent('audio-fail', `AudioWorklet processor error: ${msg}`, { error: msg });
          };
          workletOk = true;
          log('audio using AudioWorklet');
        } catch (wErr) {
          // SAFETY: only read, exactly as the script read whatever was thrown.
          const thrown = wErr as Thrown;
          log(`AudioWorklet failed, using fallback: ${thrown.message}`);
          knEvent('audio-fail', `AudioWorklet failed: ${thrown.message}`, { error: thrown.message });
        }
      }

      if (!workletOk) {
        // Fallback: ScriptProcessorNode with ring buffer.
        // AudioBufferSourceNode per-frame scheduling doesn't produce sound
        // on iOS WKWebView (FxiOS). ScriptProcessorNode continuously pulls
        // audio, keeping the iOS audio session active.
        audioWorklet = null;
        const ringSize = ringSizeFor(audioRate);
        host._kn_audioRing = new Float32Array(ringSize);
        host._kn_audioRingWrite = 0;
        host._kn_audioRingRead = 0;
        host._kn_audioRingCount = 0;
        const spNode = audioCtx.createScriptProcessor(2048, 0, 2);
        spNode.onaudioprocess = (e) => {
          const outL = e.outputBuffer.getChannelData(0);
          const outR = e.outputBuffer.getChannelData(1);
          pullRing(host, outL, outR);
        };
        if (getSlot() === 0) {
          audioDestNode = audioCtx.createMediaStreamDestination();
          spNode.connect(audioDestNode);
        }
        const gestureDest = host._kn_gestureAudioDest;
        if (gestureDest && gestureDest.context === audioCtx) {
          spNode.connect(gestureDest);
          log(`audio using ScriptProcessorNode fallback via <audio> element (ring=${ringSize})`);
        } else {
          if (gestureDest)
            log('gesture audio destination belongs to a different AudioContext; using direct destination');
          spNode.connect(audioCtx.destination);
          log(`audio using ScriptProcessorNode fallback (ring=${ringSize})`);
        }
        host._kn_scriptProcessor = spNode;
      }

      // NOW stop the keep-alive oscillator — a real audio node is connected,
      // so the iOS audio session stays alive across the handoff.
      if (host._kn_keepAliveOsc) {
        try {
          host._kn_keepAliveOsc.stop();
        } catch {
          /* an oscillator that already stopped throws; it is dropped either way */
        }
        host._kn_keepAliveOsc = null;
      }

      audioReady = true;

      if (!isRunning(audioCtx.state)) {
        ensureRunning('init');
      }

      log(`audio playback initialized (rate: ${audioRate})`);
    } catch (err) {
      log(`audio init failed: ${err}`);
      audioReady = false;
    }
  }

  function feed(): void {
    try {
      if (!audioReady || !audioCtx) return;
      // BF1/BF8: don't feed audio into a suspended/interrupted context.
      // Attempt a browser-allowed resume and keep gesture listeners armed
      // until the context actually reports running.
      if (!isRunning(audioCtx.state)) {
        ensureRunning('feed');
        return;
      }
      const mod = host.EJS_emulator?.gameManager?.Module;
      if (!mod) return;

      // init() saw this export; a core replaced by one without it throws
      // here and is logged once by the catch below, as in the script.
      const n = mod._kn_get_audio_samples!();
      if (n <= 0) {
        audioEmptyCount++;
        // Log first 30 empty frames for diagnostics on fresh boot
        if (logsEmptyFrame(audioEmptyCount)) {
          const alCtxCount = mod.AL?.contexts ? Object.keys(mod.AL.contexts).length : 0;
          const sdlAudioState = mod.SDL2?.audioContext?.state ?? 'n/a';
          // RF6 Part A: rollback-correlation + subsystem state enrichment
          const rbDelta = getLastRbFrame() != null ? getFrame() - getLastRbFrame()! : -1;
          const ctxState = host.EJS_emulator?.audioContext?.state ?? 'unknown';
          const workletPort = audioWorklet?.port ? 'open' : 'closed';
          log(
            `audio-empty f=${getFrame()} #${audioEmptyCount} ptr=${audioPtr} alCtx=${alCtxCount} sdlAudio=${sdlAudioState} ` +
              `lastRb=${getLastRbFrame() ?? -1} ` +
              `rbDelta=${rbDelta} ` +
              `resetAudioCalls=${getResetAudioCalls()} ` +
              `ctxState=${ctxState} ` +
              `workletPort=${workletPort}`,
          );
          // Dump the core's audio registers on the first empty frame, so the
          // state after a restore can be set against what the core produced.
          if (audioEmptyCount === 1) {
            try {
              host._knDumpAudioState?.(`first-audio-empty f=${getFrame()}`);
            } catch {
              /* the dump is diagnostics only */
            }
          }
        }
        // Log once after 300 consecutive empty frames (~5s) to detect silent audio
        if (isSilence(audioEmptyCount)) {
          const alCtxCount = mod.AL?.contexts ? Object.keys(mod.AL.contexts).length : 0;
          const sdlState = mod.SDL2?.audioContext?.state ?? 'n/a';
          // RF6 Part A: rollback-correlation + subsystem state enrichment
          const rbDelta = getLastRbFrame() != null ? getFrame() - getLastRbFrame()! : -1;
          const ctxState = host.EJS_emulator?.audioContext?.state ?? 'unknown';
          const workletPort = audioWorklet?.port ? 'open' : 'closed';
          log(
            `audio-silent: ${audioEmptyCount} consecutive frames with 0 samples (ptr=${audioPtr} ctx=${audioCtx.state} alCtx=${alCtxCount} sdlAudio=${sdlState}) ` +
              `lastRb=${getLastRbFrame() ?? -1} ` +
              `rbDelta=${rbDelta} ` +
              `resetAudioCalls=${getResetAudioCalls()} ` +
              `ctxState=${ctxState} ` +
              `workletPort=${workletPort}`,
          );
          // BF1: surface persistent audio failure to the user
          if (audioCtx.state === 'suspended' && !audioSuspendedToastShown) {
            audioSuspendedToastShown = true;
            host.knShowToast?.('Audio blocked — click anywhere to enable sound', 'warn');
          }
        }
        return;
      }
      audioEmptyCount = 0;

      // Log audio state periodically (every 600 frames ≈ 10s)
      audioFeedCount++;
      if (logsFedFrame(audioFeedCount)) {
        // Check PCM level (RMS of first 100 samples)
        const rms = pcmRms(new Int16Array(mod.HEAPU8.buffer, audioPtr, levelWindow(n)));
        log(
          `audio-feed #${audioFeedCount} ctx=${audioCtx.state} samples=${n} time=${audioCtx.currentTime.toFixed(2)} worklet=${!!audioWorklet} rms=${rms.toFixed(1)} ringCount=${host._kn_audioRingCount || 0}`,
        );
      }

      checkCtxClockHealth();

      const pcm = new Int16Array(mod.HEAPU8.buffer, audioPtr, n * 2);

      if (audioWorklet) {
        // AudioWorklet path
        const copy = new Int16Array(pcm);
        audioWorklet.port.postMessage(copy, [copy.buffer]);
      } else {
        // ScriptProcessorNode fallback — push PCM to ring buffer.
        // The ScriptProcessorNode's onaudioprocess callback pulls from it.
        pushPcm(host, pcm, n);
      }
    } catch (audioErr) {
      if (!audioErrorLogged) {
        // SAFETY: only read, exactly as the script read whatever was thrown.
        log(`AUDIO-ERROR: ${(audioErr as Thrown).message}`);
        audioErrorLogged = true;
      }
    }
  }

  function cleanup(): void {
    // The gesture-resume listeners normally self-detach on first user
    // interaction. If cleanup runs first (game ends before any gesture),
    // they would otherwise stay attached to document forever.
    removeResumeAudioListeners();
    if (audioWorklet) {
      audioWorklet.disconnect();
      audioWorklet = null;
    }
    if (host._kn_scriptProcessor) {
      host._kn_scriptProcessor.disconnect();
      host._kn_scriptProcessor = null;
    }
    if (host._kn_audioEl) {
      host._kn_audioEl.pause();
      host._kn_audioEl.srcObject = null;
      host._kn_audioEl = null;
    }
    if (host._kn_keepAliveOsc) {
      try {
        host._kn_keepAliveOsc.stop();
      } catch {
        /* an oscillator that already stopped throws; it is dropped either way */
      }
      host._kn_keepAliveOsc = null;
    }
    host._kn_audioRing = null;
    host._kn_audioRingCount = 0;
    if (audioDestNode) {
      audioDestNode.disconnect();
      audioDestNode = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }
    audioReady = false;
    audioPtr = 0;
    audioRate = 0;
    audioFeedCount = 0;
    audioEmptyCount = 0;
    audioErrorLogged = false;
    audioSuspendedToastShown = false;
    lastResumeAttemptAt = 0;
    ctxClockProbeTime = 0;
    ctxClockProbeWallMs = 0;
    zombieDetected = false;
    zombieRecoveryAttempts = 0;
    lastZombieRecoveryAt = 0;
  }

  return {
    init,
    feed,
    ensureRunning,
    cleanup,
    get destNode() {
      return audioDestNode;
    },
    get ready() {
      return audioReady;
    },
    get ctx() {
      return audioCtx;
    },
  };
};

declare global {
  interface Window {
    KNAudio?: AudioPipeline<AudioContext>;
  }
}
