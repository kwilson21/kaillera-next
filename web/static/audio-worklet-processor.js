/**
 * audio-worklet-processor.js — Ring buffer AudioWorklet for lockstep audio.
 *
 * Receives int16 stereo PCM via port.postMessage(), converts to float32,
 * and feeds to Web Audio output. Outputs silence on underrun.
 */
class LockstepAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Ring buffer: ~500ms at the given sample rate — large enough to survive
    // resync stalls (which can last 100-400ms waiting for coordinated state)
    // plus the 30ms fade-out / 50ms fade-in window around state overwrites.
    const rate = options.processorOptions?.sampleRate ?? 33600;
    this._bufSize = Math.ceil(rate * 0.5) * 2; // stereo samples
    this._buf = new Float32Array(this._bufSize);
    this._readPos = 0;
    this._writePos = 0;
    this._count = 0; // samples available

    // Steady-state fill target. The N64 core paces audio for the game's
    // internal frame rate (e.g. ~57.95 fps for Smash Remix at 44.1kHz, =
    // 761 samples/frame), but the JS lockstep tick fires at 60 wall-fps,
    // so the producer pushes ~3-4% more samples per wall-second than the
    // AudioContext consumes. Without bleed the ring fills to _bufSize in
    // ~14s and parks there, leaving the user with a steady ~500ms delay.
    // Bleeding back toward _target on every quantum holds perceived
    // latency near _target while preserving the full ring as headroom
    // for legitimate stall recovery.
    this._target = Math.ceil(rate * 0.03) * 2; // ~30ms

    this.port.onmessage = this._onMessage.bind(this);
  }

  _onMessage(e) {
    const int16 = e.data; // Int16Array, stereo interleaved
    const len = int16.length;
    for (let i = 0; i < len; i++) {
      this._buf[this._writePos] = int16[i] / 32768.0;
      this._writePos = (this._writePos + 1) % this._bufSize;
    }
    this._count += len;
    if (this._count > this._bufSize) {
      // Overflow: advance read position to discard oldest samples
      const overflow = this._count - this._bufSize;
      this._readPos = (this._readPos + overflow) % this._bufSize;
      this._count = this._bufSize;
    }
  }

  process(inputs, outputs) {
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    if (!outL) return true;

    // Adaptive bleed: when the ring has more than _target queued, drop a
    // capped chunk before output so latency converges back toward _target
    // instead of pinning at the 500ms ring ceiling. Cap is 32 elements
    // (16 stereo pairs / ~0.36ms at 44.1kHz) per quantum — smooth enough
    // to be inaudible while still outpacing the typical producer surplus
    // of ~9 elements/quantum. Pair-aligned (& ~1) so L/R stay matched.
    const overTarget = this._count - this._target;
    if (overTarget >= 2) {
      const bleed = Math.min(overTarget & ~1, 32);
      this._readPos = (this._readPos + bleed) % this._bufSize;
      this._count -= bleed;
    }

    const frames = outL.length; // typically 128
    for (let i = 0; i < frames; i++) {
      if (this._count >= 2) {
        outL[i] = this._buf[this._readPos];
        outR[i] = this._buf[(this._readPos + 1) % this._bufSize];
        this._readPos = (this._readPos + 2) % this._bufSize;
        this._count -= 2;
      } else {
        // Underrun: silence
        outL[i] = 0;
        outR[i] = 0;
      }
    }
    return true;
  }
}

registerProcessor('lockstep-audio-processor', LockstepAudioProcessor);
