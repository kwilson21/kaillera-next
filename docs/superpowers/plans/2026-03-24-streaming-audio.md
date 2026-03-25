# Streaming Audio Capture Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream the host's emulator audio to guests over WebRTC in streaming mode.

**Architecture:** The host's emulator outputs audio through Emscripten's OpenAL → Web Audio API. We tap into the AL context's master `gain` node (verified via diagnostic) and connect a `MediaStreamAudioDestinationNode` to it. The audio track is added to the existing `_hostStream` alongside video. Guests receive audio through the same `<video>` element, with a gesture-gated unmute for mobile.

**Tech Stack:** Web Audio API (`createMediaStreamDestination`), WebRTC (`addTrack`), EmulatorJS internals (`Module.AL.contexts`)

---

## Diagnostic Results (verified 2026-03-24)

```
Module.AL.contexts: 1 context (id: 2)
  audioCtx: state=running, sampleRate=44100
  createMediaStreamDestination(): OK
  context.gain: exists (master GainNode)
  sources: 1 persistent source (AL_PLAYING)
  source.gain: GainNode, connect(streamDest): OK
  After 40s gameplay: still 1 source (no dynamic creation)
```

**Key insight:** The AL context has a master `gain` node that ALL audio routes through. We connect to `ctx.gain` once — no source polling needed, no risk of missing dynamically created sources.

---

## Design Decisions

### Capture: Connect to context master gain (single connection)

Each AL context has a `.gain` (GainNode) property that acts as the master volume. All AL sources connect through it to `audioCtx.destination`. By connecting our `MediaStreamAudioDestinationNode` to `ctx.gain`, we capture all audio with one connection.

```
[AL Sources] → [ctx.gain (master)] → [audioCtx.destination (speakers)]
                                    ↘ [MediaStreamDestinationNode → WebRTC]
```

No monkey-patching. No source polling. One `gain.connect()` call.

### Timing: Poll for AL context after emulator boots

The AL context is populated after `gameManager.Module` exists. Flow:

1. `startHost()` → `waitForEmu()` creates `_hostStream` (video only)
2. `waitForAudio()` polls for `Module.AL.contexts` (200ms, 30s timeout)
3. Once found: create `MediaStreamAudioDestinationNode`, connect `ctx.gain`, add track
4. Renegotiate with peers to include audio

### Guest unmute: Tap-to-unmute banner

- Video starts `muted = true` for autoplay
- On `playing` event: try `video.muted = false`
- If still muted (mobile): show "Tap to unmute" banner
- On tap: unmute (user gesture satisfies policy)

### Audio/video sync: WebRTC handles it

Audio and video tracks from the same MediaStream share NTP clock reference. No manual compensation needed.

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `web/static/netplay-streaming.js` | Modify | Audio capture, guest unmute, cleanup |
| `web/static/play.css` | Modify | Unmute banner styles |
| `web/play.html` | Modify | Unmute banner element |

---

### Task 1: Add audio capture to host stream

**Files:**
- Modify: `web/static/netplay-streaming.js:83-91` (state vars)
- Modify: `web/static/netplay-streaming.js:383-431` (startHost flow)

- [ ] **Step 1: Add state variable**

After line 91 (`let _touchInputState = {};`):

```js
let _audioStreamDest = null;   // MediaStreamAudioDestinationNode (host only)
```

- [ ] **Step 2: Add captureEmulatorAudio() function**

Add before `readLocalInput()` (~line 750):

```js
// ── Audio capture for streaming ──────────────────────────────────────
// Connects the emulator's OpenAL master gain node to a MediaStreamDestination
// so audio is included in the WebRTC stream to guests.

function captureEmulatorAudio() {
  var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
  var mod = gm && gm.Module;
  if (!mod || !mod.AL || !mod.AL.contexts) return false;

  // Find the first active AL context
  var alCtx = null;
  for (var id in mod.AL.contexts) {
    var c = mod.AL.contexts[id];
    if (c && c.audioCtx && c.audioCtx.state !== 'closed' && c.gain) {
      alCtx = c;
      break;
    }
  }
  if (!alCtx) return false;

  try {
    // Create a stream destination on the emulator's AudioContext
    _audioStreamDest = alCtx.audioCtx.createMediaStreamDestination();

    // Connect the AL master gain to our stream destination.
    // Audio still flows to speakers (gain → destination) AND to our stream.
    alCtx.gain.connect(_audioStreamDest);

    // Add audio track to host stream
    var audioTrack = _audioStreamDest.stream.getAudioTracks()[0];
    if (audioTrack && _hostStream) {
      _hostStream.addTrack(audioTrack);
      console.log('[netplay] added audio track to host stream');

      // Add track to existing peer connections and renegotiate
      Object.entries(_peers).forEach(function ([sid, peer]) {
        peer.pc.addTrack(audioTrack, _hostStream);
        renegotiate(sid);
      });
      return true;
    }
  } catch (e) {
    console.log('[netplay] audio capture failed:', e.message);
  }
  return false;
}
```

- [ ] **Step 3: Call captureEmulatorAudio() after canvas capture**

In the `waitForEmu()` callback, after the `setStatus('🟢 Hosting — game on!')` line (~427), add:

```js
      // Capture emulator audio for streaming (polls until AL contexts exist)
      var audioAttempts = 0;
      var waitForAudio = function () {
        if (!_gameRunning) return;
        if (captureEmulatorAudio()) return;
        if (++audioAttempts < 150) setTimeout(waitForAudio, 200);
        else console.log('[netplay] audio capture timed out — streaming video only');
      };
      waitForAudio();
```

- [ ] **Step 4: Clean up audio in stop()**

In `stop()`, before `// Clean up streams` (~line 916):

```js
    // Clean up audio capture
    if (_audioStreamDest) {
      try { _audioStreamDest.disconnect(); } catch (_) {}
      _audioStreamDest = null;
    }
```

- [ ] **Step 5: Remove diagnostic function**

Remove the `window._diagAudio` function added for diagnostics.

- [ ] **Step 6: Commit**

```bash
git add web/static/netplay-streaming.js
git commit -m "feat: stream emulator audio to guests in streaming mode"
```

---

### Task 2: Guest-side unmute for mobile

**Files:**
- Modify: `web/static/netplay-streaming.js:189-192` (guest video unmute)
- Modify: `web/play.html` (unmute banner)
- Modify: `web/static/play.css` (banner styles)

- [ ] **Step 1: Add unmute banner HTML**

In `play.html`, after the toast container:

```html
<!-- Tap-to-unmute banner for streaming guests on mobile -->
<div id="unmute-banner" class="hidden">Tap to unmute</div>
```

- [ ] **Step 2: Add unmute banner CSS**

In `play.css`, after the gamepad-indicator styles:

```css
/* Tap-to-unmute banner (streaming guests, mobile) */
#unmute-banner {
  position: fixed;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.75);
  color: #fff;
  font-size: 14px;
  padding: 8px 20px;
  border-radius: 20px;
  z-index: 60;
  cursor: pointer;
}
#unmute-banner.hidden { display: none; }
```

- [ ] **Step 3: Update guest video unmute logic**

Replace the `playing` event listener (netplay-streaming.js ~lines 189-192):

```js
          // Unmute after playback starts. On mobile, programmatic unmute
          // requires a user gesture — show a banner if it fails.
          _guestVideo.addEventListener('playing', function () {
            _guestVideo.muted = false;
            if (_guestVideo.muted) {
              var banner = document.getElementById('unmute-banner');
              if (banner) {
                banner.classList.remove('hidden');
                var doUnmute = function () {
                  _guestVideo.muted = false;
                  banner.classList.add('hidden');
                  banner.removeEventListener('click', doUnmute);
                  document.removeEventListener('touchstart', doUnmute, true);
                };
                banner.addEventListener('click', doUnmute);
                document.addEventListener('touchstart', doUnmute, true);
              }
            }
          }, { once: true });
```

- [ ] **Step 4: Hide banner on stop**

In `stop()`, after guest video cleanup:

```js
    var unmuteBanner = document.getElementById('unmute-banner');
    if (unmuteBanner) unmuteBanner.classList.add('hidden');
```

- [ ] **Step 5: Commit**

```bash
git add web/static/netplay-streaming.js web/play.html web/static/play.css
git commit -m "feat: guest audio unmute with mobile tap-to-unmute banner"
```

---

### Task 3: Test checklist

- [ ] **Host console:** Shows `[netplay] added audio track to host stream` after game starts
- [ ] **Guest console:** Shows `received track: audio` in addition to `received track: video`
- [ ] **Desktop guest:** Audio plays immediately (unmute succeeds programmatically)
- [ ] **Mobile guest:** "Tap to unmute" banner appears, tapping unmutes audio
- [ ] **Game restart:** End game, start new game — audio streams again
- [ ] **Host local audio:** Host still hears audio locally (gain connected to BOTH destinations)
