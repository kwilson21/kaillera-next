# Audio Bypass Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable game audio during lockstep netplay without causing desyncs, by bypassing OpenAL and capturing PCM samples at the C level for local playback via Web Audio API.

**Architecture:** Patch RetroArch's OpenAL driver to divert audio samples to a flat WASM buffer instead of OpenAL when deterministic mode is on. JS reads this buffer after each frame step and plays via AudioWorklet. Host additionally streams audio to spectators via WebRTC (added to existing spectator video stream). Remove the audio toggle UI — audio is always on, deterministic sync is always on.

**Tech Stack:** C (RetroArch/Emscripten patches), JavaScript (AudioWorklet, Web Audio API, WebRTC), Python (signaling server cleanup)

**Spec:** `docs/superpowers/specs/2026-03-20-audio-bypass-design.md`

---

## Chunk 1: C-Level Patch

### Task 1: Add audio buffer globals and exports to platform_emulatorjs.c

**Files:**
- Modify: `build/src/RetroArch/frontend/drivers/platform_emulatorjs.c:127-138`

- [ ] **Step 1: Add audio buffer globals after existing kn_deterministic_mode globals**

After line 128 (`double kn_frame_time_ms = 0.0;`), add:

```c
/* kaillera-next: Audio capture buffer for deterministic audio bypass.
 * When kn_deterministic_mode is on, al_write() copies PCM samples here
 * instead of sending to OpenAL. JS reads after each frame step. */
#define KN_AUDIO_BUF_SAMPLES 48000
int16_t kn_audio_buffer[KN_AUDIO_BUF_SAMPLES * 2]; /* stereo interleaved int16 */
int kn_audio_sample_count = 0;
int kn_audio_rate = 0;  /* set by al_init() */

EMSCRIPTEN_KEEPALIVE void* kn_get_audio_ptr(void)    { return kn_audio_buffer; }
EMSCRIPTEN_KEEPALIVE int   kn_get_audio_samples(void) { return kn_audio_sample_count; }
EMSCRIPTEN_KEEPALIVE void  kn_reset_audio(void)       { kn_audio_sample_count = 0; }
EMSCRIPTEN_KEEPALIVE int   kn_get_audio_rate(void)    { return kn_audio_rate; }
```

- [ ] **Step 2: Add `#include <stdint.h>` to platform_emulatorjs.c**

The file does not include `<stdint.h>` directly and `int16_t` is not guaranteed by its existing includes. Add near the top of the file (after the other `#include` directives):

```c
#include <stdint.h>
```

### Task 2: Patch openal.c — intercept al_write() and update al_write_avail()

**Files:**
- Modify: `build/src/RetroArch/audio/drivers/openal.c:111-199` (al_init), `251-278` (al_write), `309-327` (al_write_avail)

- [ ] **Step 1: Force AL_FORMAT_STEREO16 in al_init()**

Replace the format selection block at lines 181-191:

```c
   if (alIsExtensionPresent("AL_EXT_FLOAT32"))
   {
      al->format      = alGetEnumValue("AL_FORMAT_STEREO_FLOAT32");
      _latency        = latency * rate * 2 * sizeof(float);
      RARCH_LOG("[OpenAL] Device supports float sample format\n");
   }
   else
   {
      al->format      = AL_FORMAT_STEREO16;
      _latency        = latency * rate * 2 * sizeof(int16_t);
   }
```

With:

```c
#ifdef __EMSCRIPTEN__
   /* kaillera-next: always use int16 for deterministic audio capture */
   al->format      = AL_FORMAT_STEREO16;
   _latency        = latency * rate * 2 * sizeof(int16_t);
#else
   if (alIsExtensionPresent("AL_EXT_FLOAT32"))
   {
      al->format      = alGetEnumValue("AL_FORMAT_STEREO_FLOAT32");
      _latency        = latency * rate * 2 * sizeof(float);
      RARCH_LOG("[OpenAL] Device supports float sample format\n");
   }
   else
   {
      al->format      = AL_FORMAT_STEREO16;
      _latency        = latency * rate * 2 * sizeof(int16_t);
   }
#endif
```

- [ ] **Step 2: Store sample rate in al_init()**

After line 179 (`*new_rate = rate;`), add:

```c
#ifdef __EMSCRIPTEN__
   {
      extern int kn_audio_rate;
      kn_audio_rate = rate;
   }
#endif
```

- [ ] **Step 3: Add audio capture intercept at top of al_write()**

At the top of `al_write()` (line 252, right after `al_t *al = (al_t*)data;`), before the `while (len)` loop, insert:

Note: `memcpy` is available via `<string.h>` (already included at line 18). `int16_t` is available via `<stdint.h>` — verify it's included, or add `#include <stdint.h>` near the top of the file.

```c
#ifdef __EMSCRIPTEN__
   {
      extern int kn_deterministic_mode;
      if (kn_deterministic_mode)
      {
         extern int16_t kn_audio_buffer[];
         extern int kn_audio_sample_count;
         int frames = len / (2 * sizeof(int16_t));
         int space = 48000 - kn_audio_sample_count;  /* must match KN_AUDIO_BUF_SAMPLES */
         if (frames > space) frames = space;
         if (frames > 0)
            memcpy(&kn_audio_buffer[kn_audio_sample_count * 2],
                   buf, frames * 2 * sizeof(int16_t));
         kn_audio_sample_count += frames;
         return len;
      }
   }
#endif
```

- [ ] **Step 4: Update al_write_avail() to skip al_unqueue_buffers()**

The existing patch at lines 312-325 is a complete `#ifdef __EMSCRIPTEN__` block. Replace the entire block (the `#ifdef`, the inner `if (kn_deterministic_mode)` body, and the `#endif`) with:

```c
#ifdef __EMSCRIPTEN__
   {
      extern int kn_deterministic_mode;
      if (kn_deterministic_mode)
      {
         /* No buffers were queued (al_write bypasses OpenAL) — skip unqueue */
         return OPENAL_BUFSIZE * 4;
      }
   }
#endif
```

### Task 3: Add new exports to Makefile.emulatorjs

**Files:**
- Modify: `build/src/RetroArch/Makefile.emulatorjs:128-131`

- [ ] **Step 1: Add audio exports to EXPORTED_FUNCTIONS**

The existing patch adds `_kn_set_frame_time,_kn_set_deterministic,_kn_get_cycle_time_ms` at line 131. Append the new audio exports:

```
_kn_set_frame_time,_kn_set_deterministic,_kn_get_cycle_time_ms, \
_kn_get_audio_ptr,_kn_get_audio_samples,_kn_reset_audio,_kn_get_audio_rate
```

### Task 4: Regenerate the patch file

**Files:**
- Modify: `build/patches/retroarch-deterministic-timing.patch`

- [ ] **Step 1: Generate new patch from modified RetroArch source**

```bash
cd build/src/RetroArch
git diff > ../../patches/retroarch-deterministic-timing.patch
```

- [ ] **Step 2: Verify patch applies cleanly**

```bash
cd build/src/RetroArch
git checkout -- .
git apply ../../patches/retroarch-deterministic-timing.patch
```

Expected: patch applies with no errors.

- [ ] **Step 3: Commit the C-level changes**

```bash
git add build/patches/retroarch-deterministic-timing.patch
git commit -m "feat: C-level audio capture bypass for deterministic lockstep

Patch openal.c to divert PCM samples to a flat WASM buffer when
kn_deterministic_mode is on, bypassing OpenAL entirely. Export
kn_get_audio_ptr/kn_get_audio_samples/kn_reset_audio/kn_get_audio_rate
for JS consumption. Force AL_FORMAT_STEREO16 in Emscripten builds."
```

---

## Chunk 2: AudioWorklet Processor

### Task 5: Create the AudioWorklet processor file

**Files:**
- Create: `web/static/audio-worklet-processor.js`

- [ ] **Step 1: Write the AudioWorklet processor**

This is a standalone JS file that runs in the AudioWorklet thread. It maintains a ring buffer and outputs audio samples on demand.

```javascript
/**
 * audio-worklet-processor.js — Ring buffer AudioWorklet for lockstep audio.
 *
 * Receives int16 stereo PCM via port.postMessage(), converts to float32,
 * and feeds to Web Audio output. Outputs silence on underrun.
 */
class LockstepAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    // Ring buffer: ~200ms at the given sample rate (generous for jitter)
    var rate = options.processorOptions && options.processorOptions.sampleRate || 33600;
    this._bufSize = Math.ceil(rate * 0.2) * 2; // stereo samples
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
```

- [ ] **Step 2: Commit**

```bash
git add web/static/audio-worklet-processor.js
git commit -m "feat: add AudioWorklet processor for lockstep audio playback"
```

---

## Chunk 3: JS Lockstep Engine — Audio Playback and Spectator Streaming

### Task 6: Add audio system initialization to netplay-lockstep-v4.js

**Files:**
- Modify: `web/static/netplay-lockstep-v4.js`

- [ ] **Step 1: Add audio state variables**

Near the top of the IIFE (after the existing variable declarations around line 93), replace:

```javascript
  let _audioEnabled      = true;     // true = real time (audio), false = frozen (no desync)
```

With:

```javascript
  // -- Audio bypass state --
  var _audioCtx = null;           // AudioContext for local playback
  var _audioWorklet = null;       // AudioWorkletNode
  var _audioDestNode = null;      // MediaStreamAudioDestinationNode (host only, for spectators)
  var _audioPtr = 0;              // WASM pointer to kn_audio_buffer
  var _audioRate = 0;             // sample rate from kn_get_audio_rate()
  var _audioReady = false;        // true once AudioWorklet is initialized
```

- [ ] **Step 2: Add audio initialization function**

Add this function after the new variables (around line 100):

```javascript
  async function initAudioPlayback() {
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    if (!mod) return;

    // Check for audio capture exports
    if (!mod._kn_get_audio_ptr || !mod._kn_get_audio_samples ||
        !mod._kn_reset_audio || !mod._kn_get_audio_rate) {
      console.log('[lockstep-v4] audio capture exports not found — audio disabled');
      return;
    }

    _audioPtr = mod._kn_get_audio_ptr();
    _audioRate = mod._kn_get_audio_rate();
    if (!_audioRate || _audioRate <= 0) {
      console.log('[lockstep-v4] audio rate not set yet, defaulting to 33600');
      _audioRate = 33600;
    }

    try {
      _audioCtx = new AudioContext({ sampleRate: _audioRate });
      // Resume immediately — Start Game button click is the user gesture
      if (_audioCtx.state === 'suspended') _audioCtx.resume();
      await _audioCtx.audioWorklet.addModule('/static/audio-worklet-processor.js');
      _audioWorklet = new AudioWorkletNode(_audioCtx, 'lockstep-audio-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { sampleRate: _audioRate },
      });

      // Host: also route audio to spectator stream
      if (_playerSlot === 0) {
        _audioDestNode = _audioCtx.createMediaStreamDestination();
        _audioWorklet.connect(_audioDestNode);
      }

      _audioWorklet.connect(_audioCtx.destination);
      _audioReady = true;
      console.log('[lockstep-v4] audio playback initialized (rate: ' + _audioRate + ')');
    } catch (err) {
      console.log('[lockstep-v4] AudioWorklet init failed:', err);
      _audioReady = false;
    }
  }
```

- [ ] **Step 3: Add per-frame audio feed function**

Add this function after `initAudioPlayback`:

```javascript
  function feedAudio() {
    if (!_audioReady) return;
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    if (!mod) return;

    var n = mod._kn_get_audio_samples();
    if (n <= 0) return;

    // Create int16 view of WASM heap at audio buffer pointer
    var pcm = new Int16Array(mod.HEAPU8.buffer, _audioPtr, n * 2);
    // Copy before posting (buffer may be detached by WASM memory growth)
    var copy = new Int16Array(pcm);
    _audioWorklet.port.postMessage(copy, [copy.buffer]);
  }
```

### Task 7: Integrate audio into the frame loop and lifecycle

**Files:**
- Modify: `web/static/netplay-lockstep-v4.js`

- [ ] **Step 1: Set _kn_inStep unconditionally in startLockstep()**

At line 996-998, replace:

```javascript
    // Audio OFF (default): _kn_inStep=true, frozen time, zero desyncs
    // Audio ON: _kn_inStep=false, real time, audio works, may desync
    window._kn_inStep = !_audioEnabled;
```

With:

```javascript
    // Always frozen time — audio plays via bypass, not OpenAL
    window._kn_inStep = true;
```

- [ ] **Step 2: Initialize audio playback at lockstep start**

After line 1006 (`console.log('[lockstep-v4] C-level deterministic timing enabled (session-wide)');`), add:

```javascript
    // Initialize audio bypass playback (async — sets _audioReady when done)
    initAudioPlayback();
```

Note: `initAudioPlayback()` is async but we don't await it. This is intentional — the lockstep loop can start immediately, and `feedAudio()` is a no-op while `_audioReady` is false. Audio will start playing once the AudioWorklet module finishes loading (typically <100ms). `AudioContext.resume()` is called inside `initAudioPlayback()` before the await, so the user gesture from the Start Game button is captured synchronously.

- [ ] **Step 3: Add _kn_reset_audio() and feedAudio() calls wrapping stepOneFrame() in tick()**

At line 1132-1133, replace:

```javascript
    // Step one frame
    stepOneFrame();
```

With:

```javascript
    // Step one frame with audio capture
    var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
              window.EJS_emulator.gameManager.Module;
    if (mod && mod._kn_reset_audio) mod._kn_reset_audio();
    stepOneFrame();
    feedAudio();
```

- [ ] **Step 4: Remove _audioEnabled from init() config**

At line 1511, remove:

```javascript
    _audioEnabled = config.audioEnabled !== false;  // default: true
```

- [ ] **Step 5: Remove isAudioEnabled from public API**

At line 1589, remove:

```javascript
    isAudioEnabled: function () { return _audioEnabled; },
```

### Task 8: Add spectator audio to host stream

**Files:**
- Modify: `web/static/netplay-lockstep-v4.js`

- [ ] **Step 1: Add audio track to _hostStream in startSpectatorStream()**

At line 762, after `_hostStream = captureCanvas.captureStream(0);`, add:

```javascript
    // Add audio track from bypass playback (if available)
    if (_audioDestNode && _audioDestNode.stream) {
      var audioTracks = _audioDestNode.stream.getAudioTracks();
      for (var at = 0; at < audioTracks.length; at++) {
        _hostStream.addTrack(audioTracks[at]);
      }
      console.log('[lockstep-v4] added audio track to spectator stream');
    }
```

### Task 9: Add audio cleanup to stop()

**Files:**
- Modify: `web/static/netplay-lockstep-v4.js`

- [ ] **Step 1: Add audio cleanup in stop() before spectator stream cleanup**

At line 1561, before `// Clean up spectator stream`, add:

```javascript
    // Clean up audio bypass
    if (_audioWorklet) {
      _audioWorklet.disconnect();
      _audioWorklet = null;
    }
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
```

- [ ] **Step 2: Commit all lockstep engine changes**

```bash
git add web/static/netplay-lockstep-v4.js
git commit -m "feat: audio bypass playback in lockstep engine

Read PCM samples from WASM audio buffer after each frame step,
play via AudioWorklet. Host streams audio to spectators via
MediaStreamAudioDestinationNode added to _hostStream. Audio is
always on, _kn_inStep always true (zero desyncs guaranteed)."
```

---

## Chunk 4: UI and Server Cleanup

### Task 10: Remove audio toggle from play.html

**Files:**
- Modify: `web/play.html:48`

- [ ] **Step 1: Remove the audio checkbox line**

Remove this line:

```html
          <label><input type="checkbox" id="opt-audio" checked> Audio <span class="opt-hint">(may cause minor desyncs)</span></label>
```

### Task 11: Remove audioEnabled from play.js

**Files:**
- Modify: `web/static/play.js`

- [ ] **Step 1: Remove _gameAudioEnabled variable (line 22)**

Remove:

```javascript
  var _gameAudioEnabled = true;
```

- [ ] **Step 2: Remove audioEnabled from onGameStarted() (line 196)**

In `onGameStarted()`, remove:

```javascript
    _gameAudioEnabled = data.audioEnabled !== false;
```

- [ ] **Step 3: Remove audioEnabled from initEngine() config (lines 228, 239)**

Remove the `var audioEnabled = _gameAudioEnabled;` line and remove `audioEnabled: audioEnabled,` from the `engine.init()` call.

- [ ] **Step 4: Remove audioEnabled from startGame() emit (lines 255, 259)**

Remove the `var optAudio = ...` line and `audioEnabled: optAudio ? optAudio.checked : true,` from the `socket.emit('start-game', ...)` call.

### Task 12: Remove audioEnabled from signaling server

**Files:**
- Modify: `server/src/api/signaling.py:277`

- [ ] **Step 1: Remove audioEnabled from game-started event**

Remove this line from the `game-started` emit:

```python
        "audioEnabled": data.get("audioEnabled", True),
```

### Task 13: Commit UI and server cleanup

- [ ] **Step 1: Commit all cleanup changes**

```bash
git add web/play.html web/static/play.js server/src/api/signaling.py
git commit -m "remove: audio toggle UI — audio always on via bypass

Audio is now always enabled through the deterministic bypass path.
The toggle between 'audio with desyncs' and 'no audio, no desyncs'
no longer exists. Remove audioEnabled from all Socket.IO events."
```

---

## Chunk 5: Build and Verify

### Task 14: Rebuild WASM core with audio patches

- [ ] **Step 1: Run the Docker build**

```bash
cd /Users/kazon/kaillera-next
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash /build/build.sh
```

Expected: Build completes successfully, output at `build/output/mupen64plus_next-wasm.data`.

- [ ] **Step 2: Deploy the new core**

Copy the built `.data` file to the appropriate location for the core-redirector to serve:

```bash
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
```

### Task 15: Manual smoke test

- [ ] **Step 1: Start the server**

```bash
cd /Users/kazon/kaillera-next
python -m server.src.main
```

- [ ] **Step 2: Open two browser tabs to the same room**

1. Tab 1: Create room, note room code
2. Tab 2: Join room with room code
3. Host clicks "Start Game"
4. Verify: both tabs produce audible game audio
5. Verify: no desyncs after 2+ minutes of play (check console for `DESYNC` messages)
6. Verify: `_kn_inStep` is `true` in both tabs (check `window._kn_inStep` in console)

- [ ] **Step 3: Test spectator audio**

1. Tab 3: Join same room as spectator
2. Verify: spectator sees video AND hears audio from host

- [ ] **Step 4: Verify no OpenAL async callbacks**

In browser console on any player tab:
```javascript
// Should show no ScriptProcessorNode instances
console.log(Module.AL.contexts);
```

Check that no `scheduleContextAudio` setInterval is running (no OpenAL scheduling should exist when deterministic mode is on).

### Task 16: Final commit

- [ ] **Step 1: Commit build output if applicable**

If the `.data` file is tracked in the repo:

```bash
git add web/static/ejs/cores/mupen64plus_next-wasm.data
git commit -m "build: rebuilt WASM core with audio capture bypass"
```

---

## Deferred

- **AudioWorklet fallback:** The spec mentions a fallback to `AudioBufferSourceNode` chain for browsers without AudioWorklet. AudioWorklet is supported in all modern browsers (Chrome 66+, Firefox 76+, Safari 14.1+). Deferred until needed.
- **Playwright test:** The spec mentions extending `tests/test_desync.py` to verify the audio buffer is non-empty. Deferred — manual smoke test covers this for now.
