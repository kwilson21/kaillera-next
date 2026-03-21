# Audio Bypass with Local Playback + Spectator Streaming

## Problem

Lockstep netplay achieves zero desyncs by freezing `_emscripten_get_now` (returning flat `_kn_frameTime` when `_kn_inStep=true`). This kills OpenAL's audio scheduler — it can't schedule buffers without advancing time — so gameplay is silent.

The root cause: OpenAL's async callbacks (`ScriptProcessorNode`, `scheduleContextAudio` setInterval) call `_emscripten_get_now` at unpredictable moments between lockstep frame steps. The call count/timing differs between machines, polluting emulator state and causing desyncs. Every attempted workaround (call-counting timers, CPU cycle counters, relative counters) failed because async callbacks break determinism fundamentally.

## Solution

Bypass OpenAL entirely. Capture raw PCM samples at the RetroArch audio driver level (before they reach OpenAL), and play them via Web Audio API in a path completely decoupled from the emulator.

- **Players:** Each client generates identical audio deterministically (same state + same inputs = same output). Each reads its own WASM audio buffer after every frame step and plays locally via AudioWorklet. No streaming needed between players.
- **Spectators:** Don't run the emulator, so the host streams audio to them via WebRTC (added to the existing spectator video stream).

## Architecture

```
  N64 Core (mupen64plus)
       │
       ▼
  retro_audio_sample_batch_t
       │
       ▼
  RetroArch al_write()
       │
       ├── kn_deterministic_mode OFF → OpenAL (normal path)
       │
       └── kn_deterministic_mode ON → kn_audio_buffer[] (flat buffer in WASM heap)
                                           │
                                      JS reads after stepOneFrame()
                                           │
                              ┌─────────────┴─────────────┐
                              ▼                           ▼
                     AudioWorkletNode              (Host only)
                     → local playback         MediaStreamAudioDestinationNode
                     (all players)                  → audio track
                                                    → added to _hostStream
                                                    → WebRTC to spectators
```

## Layer 1: C-level audio capture (RetroArch patch)

### Hook point: `al_write()` in `audio/drivers/openal.c`

When `kn_deterministic_mode` is on, copy incoming PCM samples to a flat buffer instead of passing to OpenAL. Return the byte count to the caller so the emulator thinks audio was consumed normally.

### New globals and exports in `frontend/drivers/platform_emulatorjs.c`

Variables must NOT be `static` — they are accessed via `extern` from `openal.c`.

```c
#define KN_AUDIO_BUF_SAMPLES 48000              /* max stereo frames per step */
int16_t kn_audio_buffer[KN_AUDIO_BUF_SAMPLES * 2]; /* stereo interleaved int16 */
int kn_audio_sample_count = 0;             /* stereo frames written this step */
int kn_audio_rate = 0;                     /* set during al_init, 0 = unknown */

EMSCRIPTEN_KEEPALIVE void* kn_get_audio_ptr(void)    { return kn_audio_buffer; }
EMSCRIPTEN_KEEPALIVE int   kn_get_audio_samples(void){ return kn_audio_sample_count; }
EMSCRIPTEN_KEEPALIVE void  kn_reset_audio(void)      { kn_audio_sample_count = 0; }
EMSCRIPTEN_KEEPALIVE int   kn_get_audio_rate(void)   { return kn_audio_rate; }
```

### Intercept in `al_write()`

This block must be placed at the **top** of `al_write()`, before the `while (len)` loop, so it returns early before `len` is mutated.

```c
#ifdef __EMSCRIPTEN__
{
   extern int kn_deterministic_mode;
   if (kn_deterministic_mode)
   {
      extern int16_t kn_audio_buffer[];
      extern int kn_audio_sample_count;
      int frames = len / (2 * sizeof(int16_t));  /* stereo int16 */
      int space = KN_AUDIO_BUF_SAMPLES - kn_audio_sample_count;
      if (frames > space) frames = space;
      memcpy(&kn_audio_buffer[kn_audio_sample_count * 2],
             buf, frames * 2 * sizeof(int16_t));
      kn_audio_sample_count += frames;
      return len;  /* pretend all consumed */
   }
}
#endif
```

### Update existing `al_write_avail()` patch

The existing patch in `al_write_avail()` calls `al_unqueue_buffers(al)` in deterministic mode. Since `al_write()` now skips OpenAL entirely (never queues buffers), `al_unqueue_buffers()` would touch invalid OpenAL state. Update the existing `al_write_avail()` patch to also skip the unqueue call:

```c
if (kn_deterministic_mode)
{
   return OPENAL_BUFSIZE * 4;  /* fixed: always report 4 buffers free */
   /* DO NOT call al_unqueue_buffers — no buffers were ever queued */
}
```

### Format handling

Emscripten's OpenAL may select `AL_FORMAT_STEREO_FLOAT32` if the extension is available. Since `al_init()` runs during emulator startup (before JS calls `_kn_set_deterministic(1)`), we cannot conditionally force int16 at init time. Two options:

**Option A (recommended):** Always force `AL_FORMAT_STEREO16` in this netplay-specific build. This is a dedicated patched core, not a general-purpose build. In `al_init()`, replace the format selection block:

```c
/* kaillera-next: always use int16 format for deterministic audio capture */
al->format = AL_FORMAT_STEREO16;
_latency   = latency * rate * 2 * sizeof(int16_t);
```

**Option B:** Handle both formats in the `al_write()` capture path — if `al->format` is float32, convert to int16 during capture. Adds complexity but preserves format flexibility.

The `al_write()` intercept block does NOT check format at runtime. If Option A is not applied, float32 data will be misinterpreted as int16, producing garbled audio. Whichever option is chosen, it must be implemented — this is not optional.

### Store sample rate

In `al_init()`, always save the rate (this runs before deterministic mode is set, but the rate is the same regardless):
```c
extern int kn_audio_rate;
kn_audio_rate = rate;
```

### Exported functions

Add to `EXPORTED_FUNCTIONS` in `Makefile.emulatorjs`:
```
_kn_get_audio_ptr,_kn_get_audio_samples,_kn_reset_audio,_kn_get_audio_rate
```

## Layer 2: JS local audio playback (all players)

### Per-frame flow in `netplay-lockstep-v4.js`

In the `tick()` function, wrapping `stepOneFrame()`:

```
_kn_reset_audio()           ← clear buffer before step
stepOneFrame()              ← core generates audio into kn_audio_buffer
n = _kn_get_audio_samples() ← how many stereo frames were produced
if (n > 0):
    pcm = new Int16Array(Module.HEAPU8.buffer, audioPtr, n * 2)
    feed pcm copy to AudioWorklet
```

Note: `HEAP16` is not in the Emscripten `EXPORTS` list. Use `new Int16Array(Module.HEAPU8.buffer, audioPtr, n * 2)` to create an int16 view of the WASM heap at the audio buffer pointer. Copy the data before posting to the worklet (the underlying buffer may be detached by WASM memory growth).

### AudioWorklet design

An `AudioWorkletNode` with an internal ring buffer is the playback mechanism:

1. **Initialization:** Create `AudioContext` with `sampleRate` matching `_kn_get_audio_rate()`. Register an AudioWorklet processor that maintains a ring buffer.
2. **Per-frame:** Post the int16 PCM samples to the worklet via `port.postMessage()`. The worklet converts int16→float32 and appends to its ring buffer.
3. **Render callback:** The worklet's `process()` method reads from the ring buffer and writes to the output. If the buffer underruns, output silence (no glitch artifacts).
4. **Buffer size:** Target ~3 frames of audio to absorb timing jitter without adding perceptible latency. N64 audio rate varies (mupen64plus typically outputs ~33kHz). At 33600 Hz, ~3 frames ≈ 1680 samples. The worklet ring buffer size should be derived from `kn_get_audio_rate()`, not hardcoded.

**Fallback:** If `AudioWorklet` is unavailable, use chained `AudioBufferSourceNode` scheduling (create small AudioBuffers per frame, schedule with `start(nextTime)`). This runs on the main thread but is adequate for the use case.

### AudioContext resume

Browsers require user interaction before `AudioContext` can play. Resume the context on the first user interaction after game start (the "Start Game" button click is sufficient — it's already a user gesture).

Note: Spectator `<video>` elements with `muted = false` may also be blocked by autoplay policy. The spectator joins via a click (joining the room), which should satisfy the gesture requirement, but if not, add `_guestVideo.play()` on next user interaction as a fallback.

## Layer 3: Spectator audio streaming (host only)

On the host (`_playerSlot === 0`), additionally route the same PCM samples to a `MediaStreamAudioDestinationNode`:

1. Create `MediaStreamAudioDestinationNode` from the same `AudioContext`.
2. Connect a second `AudioWorkletNode` (or the same one with a split output) to the destination node.
3. Get the `MediaStream` from `destinationNode.stream` — contains an audio `MediaStreamTrack`.
4. Add this audio track to `_hostStream` (already has the video track from `captureStream()`).

`addStreamToPeer()` already calls `peer.pc.addTrack(track, _hostStream)` for all tracks in the stream — audio gets added to spectator connections automatically. No changes needed on the spectator receive side; `showSpectatorVideo()` sets `_guestVideo.muted = false`, so the audio track plays.

### Spectator late-join

When a spectator joins mid-game, `startSpectatorStreamForPeer()` → `addStreamToPeer()` adds all current tracks (video + audio) to the new peer connection. The audio track is already in `_hostStream` by this point.

## Layer 4: UI changes

### Remove audio toggle

- **`web/play.html`:** Remove the `<label>` containing `#opt-audio` checkbox and its "may cause minor desyncs" hint.
- **`web/static/play.js`:** Remove `_gameAudioEnabled` variable. Remove `audioEnabled` from `start-game` emit and `game-started` handler.
- **`server/src/api/signaling.py`:** Remove `audioEnabled` from `game-started` event payload.
- **`web/static/netplay-lockstep-v4.js`:** Remove `_audioEnabled` config. Set `_kn_inStep = true` unconditionally (always deterministic). Remove the conditional `!_audioEnabled` check.

### Result

Audio is always on. Deterministic sync is always on. No user choice needed — the tradeoff no longer exists.

## What stays the same

- Frame stepping loop, input exchange, WebRTC data channels — untouched
- WebRTC mesh topology for players — untouched
- Save state sync (initial, late-join, hot-swap) — untouched
- `_kn_frameTime` / `_kn_inStep` / `_kn_set_deterministic` C exports — still used, just always-on
- Spectator video streaming — untouched (audio track added alongside)
- `core-redirector.js` — untouched

## Cleanup / teardown

When the game ends or a player leaves, clean up audio resources in the `stop()` function (which already handles `_hostStream` track cleanup, not `stopSync()`):

- Close the `AudioContext` (or at minimum disconnect the `AudioWorkletNode`)
- Disconnect the `MediaStreamAudioDestinationNode` (host only)
- Stop any audio `MediaStreamTrack` on `_hostStream` (host only)

This prevents resource leaks across game sessions.

## Build changes

The existing `build/build.sh` and patch pipeline handles this. The new patch extends `retroarch-deterministic-timing.patch` with additional hunks in `openal.c` and `platform_emulatorjs.c`, plus the `EXPORTED_FUNCTIONS` addition in `Makefile.emulatorjs`.

## Verification

1. **Local audio plays:** Host and guest both produce audible game audio with zero desyncs.
2. **Determinism preserved:** Extended play session (5+ minutes) shows no desync (byte-identical state hashes).
3. **Spectator audio:** Spectator hears host's audio via WebRTC with acceptable latency (<200ms).
4. **No OpenAL async callbacks:** Confirm no `ScriptProcessorNode` or `scheduleContextAudio` setInterval created when deterministic mode is on.
5. **Playwright test:** Extend `tests/test_desync.py` to verify audio buffer is non-empty after frame steps.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Core generates float32 samples despite format override | Force `AL_FORMAT_STEREO16` in `al_init` when deterministic; add assertion in `al_write` capture path |
| AudioWorklet not supported in older browsers | Fallback to `AudioBufferSourceNode` chain |
| Audio buffer overflow (core generates >1s of audio per step) | Cap at 48000 samples with bounds check; log warning if truncated |
| Sample rate mismatch between core and AudioContext | Read rate from `_kn_get_audio_rate()` and create AudioContext with matching rate |
