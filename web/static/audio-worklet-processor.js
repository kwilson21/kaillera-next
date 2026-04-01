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
