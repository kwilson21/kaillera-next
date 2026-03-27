# iOS Native Wrapper (WKWebView)

## Problem

iOS Safari has platform-specific limitations that degrade the kaillera-next experience:
- **Background kill** — switching apps suspends the tab, ending the game
- **Autoplay restrictions** — audio/video require user gesture to start
- **No rumble/haptics** — Web Gamepad API has no haptics support
- **Web Gamepad API cooked input** — normalized values, 16ms polling floor
- **Screen dims during gameplay** — `navigator.wakeLock` is partial on Safari

## Solution

A minimal Swift app (~400-500 lines) that loads the kaillera-next web app in a full-screen `WKWebView`. The web app runs identically — the native shell provides keep-alive, autoplay, MFi controller access, and screen wake lock. No storyboards, programmatic UI only.

**Project location:** `ios/` in the repo.

**Minimum deployment target:** iOS 16+ (required for AudioWorklet in WebKit, stable GCController.haptics, modern WKWebView features).

## Components

### 1. WKWebView Shell — `ViewController.swift`

Single view controller with a full-screen `WKWebView`.

**Configuration:**
- `allowsInlineMediaPlayback = true` — no autoplay restrictions
- `mediaTypesRequiringUserActionForPlayback = []` — audio/video start immediately
- `javaScriptCanOpenWindowsAutomatically = true`
- `WKUserContentController` for native input bridge and rumble handler

**URL loading:**
- Dev: `http://192.168.x.x:27888` — configurable constant, changed before building
- Prod: `https://yourdomain.com`
- If server unreachable: show a native retry screen (not a WebView error page)

**Display:**
- Edge-to-edge, no browser chrome, no URL bar
- Status bar hidden during gameplay
- Safe area insets respected for the notch
- Landscape-only orientation lock (game is always landscape)
- iPad: no Split View / Slide Over support (full-screen only)

**ROM loading:** The web app already has a file picker (`<input type="file">`) in addition to drag-and-drop. On iOS/WKWebView, drag-and-drop is not available — the file picker is the ROM loading path. This works without changes.

### 2. Background Keep-Alive — `AVAudioSession`

iOS kills background tabs aggressively. The wrapper uses the game's own audio to stay alive.

- `Info.plist`: `UIBackgroundModes` includes `audio`
- On launch: configure `AVAudioSession` with category `.playback` and `mixWithOthers` option
- WKWebView's game audio (from the AudioWorklet/emulator) routes through this session
- When user swipes away, iOS keeps the process alive because it has an active audio session

No silent audio track — the game audio is the keep-alive signal.

**Limitation:** Background keep-alive only works during active gameplay (when audio is playing). In the lobby or pause menus with no audio, iOS may still suspend the app if the user switches away. This is acceptable — the critical path is keeping the game alive mid-match, not the lobby.

### 3. ATS Exception for LAN Development

- `Info.plist`: `NSAppTransportSecurity` → `NSAllowsLocalNetworking = true`
- Allows `http://` connections to LAN IPs during development
- Production HTTPS works without any exception

### 4. Server Configuration for Dev Builds

The server's `ALLOWED_ORIGIN` env var controls CORS. For iOS dev builds loading from WKWebView:
- WKWebView's origin for local files is `null`; for HTTP URLs it's the normal origin
- Set `ALLOWED_ORIGIN=*` (the default) during development
- The server's COOP/COEP headers work without changes in WKWebView

### 5. Native MFi/GCController Bridge

The biggest gameplay win. iOS `GCController` framework provides:
- True analog stick values at native polling rate
- MFi, DualShock, DualSense, Xbox, Joy-Con support — no permission prompts
- Rumble/haptics via `GCController.haptics`
- Button pressure sensitivity where hardware supports it

**Swift → Web (input):**

A `CADisplayLink` capped to 60Hz via `preferredFrameRateRange` reads `GCController.current` and posts input via `evaluateJavaScript`:

```javascript
window._knNativeInput = { buttons: 0, lx: -42, ly: 83, cx: 0, cy: 0 }
```

Same `{buttons, lx, ly, cx, cy}` shape as the true-analog gamepad spec. The synchronization model is overwrite-latest: Swift overwrites `window._knNativeInput` every frame, JS reads whatever value is current when `readLocalInput()` runs. No consume-and-clear needed.

**Integration with `readLocalInput()` in `shared.js`:**

A new priority-zero step is added before the existing gamepad check. This is a **shared prerequisite** — the same code path serves both iOS and Android native wrappers:

```javascript
const readLocalInput = (playerSlot, keyMap, heldKeys) => {
    const input = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
    if (KNState.remapActive) return { ...ZERO_INPUT };

    // 0. Native bridge (iOS/Android) — highest priority, bypasses document.hasFocus()
    if (window._knNativeInput) {
        const ni = window._knNativeInput;
        input.buttons = ni.buttons;
        input.lx = ni.lx;
        input.ly = ni.ly;
        input.cx = ni.cx;
        input.cy = ni.cy;
        return input;  // Native input is authoritative, skip gamepad/keyboard/touch
    }

    // 1. Gamepad (existing code, unchanged)
    if (document.hasFocus() && window.GamepadManager) { ... }
    // 2. Keyboard ...
    // 3. Touch ...
};
```

The native input check is before and independent of the `document.hasFocus()` guard, since GCController input comes from Swift, not the browser Gamepad API.

**Web → Swift (rumble):**

```javascript
window.webkit.messageHandlers.rumble.postMessage({intensity: 0.5, duration: 100})
// intensity: 0.0-1.0 float, duration: milliseconds integer
```

Swift side triggers `GCController.current.haptics` using `CHHapticEngine`. Silently no-ops when haptics hardware is unavailable (e.g., MFi controllers without rumble motors). Only the first connected controller receives rumble — multi-controller rumble routing is out of scope for v1.

### 6. Web App Detection

Swift injects a user script on page load:

```javascript
window._knNative = { platform: 'ios', version: '1.0' }
```

`shared.js` checks `window._knNative` to:
1. Use `window._knNativeInput` instead of Web Gamepad API
2. Skip "tap to unmute" prompts
3. Hide any future "install app" banners

Falls back gracefully in a regular browser — the property doesn't exist.

### 7. Screen Wake Lock

```swift
UIApplication.shared.isIdleTimerDisabled = true
```

One line. Prevents screen from dimming. Active for the lifetime of the app (including lobby). Acceptable trade-off for a game app — users won't leave the app open and idle.

## What This Fixes

| Problem | How |
|---|---|
| Background kill when switching apps | AVAudioSession `.playback` keeps process alive during gameplay |
| rAF/setInterval background throttling | WKWebView with audio entitlement prevents suspension |
| iOS autoplay muted video/audio | WKWebView config removes user-gesture requirement |
| No rumble/haptics | GCController.haptics on DualSense/Xbox controllers |
| Web Gamepad API cooked input | Native GCController gives raw analog values |
| Screen dims during gameplay | `isIdleTimerDisabled = true` |

## What This Doesn't Fix

| Problem | Why |
|---|---|
| 57-90fps on mobile vs desktop | Hardware limitation |
| loadState() blocking main thread | WASM single-threaded execution |
| WebRTC ICE flaps on mobile networks | Network layer, not app layer |
| Touch virtual gamepad precision | Same touch events in WKWebView as Safari |
| Safari captureStream quirks | WKWebView uses the same WebKit engine as Safari; existing `captureStream(60)` workaround still applies |

## App Store Compliance

Apple's App Store Review Guideline 4.7 (April 2024) explicitly allows retro game emulators. Delta and RetroArch are live on the App Store.

**Requirements met:**
- App does not include or distribute ROMs — users supply their own
- Emulator code (mupen64plus-next) is GPL open source
- No piracy facilitation — no ROM download links

**ROM sharing consideration:** The P2P ROM sharing feature could be flagged. Options: disable in iOS build, or keep the existing legal consent flow. The consent dialog already exists.

## Signing & Distribution

- Apple Developer account available ($99/year)
- Dev builds: deploy to test phone via Xcode
- Distribution: TestFlight for beta testers, App Store for public release

## Files Changed

| Location | Change |
|---|---|
| `ios/` (new) | Xcode project, Swift view controller, Info.plist, entitlements |
| `web/static/shared.js` | `readLocalInput()` — add priority-zero native input check before gamepad/keyboard/touch (shared with Android) |
