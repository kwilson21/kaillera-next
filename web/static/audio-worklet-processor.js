/**
 * audio-worklet-processor.js — Ring buffer AudioWorklet for lockstep audio.
 *
 * Receives int16 stereo PCM via port.postMessage(), converts to float32,
 * and feeds to Web Audio output. Outputs silence on underrun.
 */
class LockstepAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Ring buffer: ~80ms at the given sample rate (tight for low latency)
    var rate = options.processorOptions && options.processorOptions.sampleRate || 33600;
    this._bufSize = Math.ceil(rate * 0.08) * 2; // stereo samples
    this._buf = new Float32Array(this._bufSize);
    this._readPos = 0;
    this._writePos = 0;
    this._count = 0; // samples available

    this.port.onmessage = this._onMessage.bind(this);
  }

  _onMessage(e) {
    var int16 = e.data; // Int16Array, stereo interleaved
    var len = int16.length;
    for (var i = 0; i < len; i++) {
      this._buf[this._writePos] = int16[i] / 32768.0;
      this._writePos = (this._writePos + 1) % this._bufSize;
    }
    this._count += len;
    if (this._count > this._bufSize) this._count = this._bufSize;
  }

  process(inputs, outputs) {
    var outL = outputs[0][0];
    var outR = outputs[0][1];
    if (!outL) return true;

    var frames = outL.length; // typically 128
    for (var i = 0; i < frames; i++) {
      if (this._count >= 2) {
        outL[i] = this._buf[this._readPos];
        outR[i] = this._buf[this._readPos + 1];
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
