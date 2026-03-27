# Android TWA Wrapper

## Problem

Android mobile browsers share similar limitations to iOS for kaillera-next:
- **Background kill** — Android aggressively kills background activities
- **Web Gamepad API cooked input** — normalized values, polling floor
- **No rumble/haptics** — Web Gamepad API has no haptics support
- **Screen dims during gameplay**

Android Chrome is less restrictive than Safari (autoplay mostly works, WebRTC is solid), so the fix list is shorter. The main wins are background keep-alive, native gamepad input, and store distribution.

## Solution

A Trusted Web Activity (TWA) — Chrome running full-screen with the kaillera-next URL, wrapped in a thin Android/Kotlin project. The TWA itself is config-only (~50 lines of manifest/Gradle). Gameplay fixes are added via:
- A **foreground service** to prevent background kill
- A **local WebSocket gamepad bridge** for native controller input
- A **wake lock** to prevent screen dimming

**Project location:** `android/` in the repo.

**Minimum API level:** Android 8.0 (API 26) — required for TWA support. Foreground service type constraints require awareness of API 34+ changes (see section 2).

## Why TWA Over WebView

Android WebView has known issues with WebRTC, audio, and WASM performance compared to Chrome. TWA runs inside Chrome itself — full engine, no quirks. The only trade-off: you can't inject `@JavascriptInterface` into a TWA, so the native gamepad bridge uses a local WebSocket instead.

## Components

### 1. TWA Shell — `LauncherActivity.kt`

Uses `androidx.browser:browser` library for TWA support.

**Configuration:**
- `AndroidManifest.xml` declares Digital Asset Links intent filter for the production domain
- For LAN dev: skip asset links verification using debug signing key
- `LauncherActivity` extends `Activity`, launches a Custom Tab in TWA mode
- Full-screen, no address bar (verified via Digital Asset Links or debug bypass)
- Landscape-only orientation lock

**URL loading:**
- Dev: `http://192.168.x.x:27888?_knPlatform=android`
- Prod: `https://yourdomain.com?_knPlatform=android`
- The `_knPlatform=android` query parameter signals the web app it's inside the native wrapper (since TWA can't inject JavaScript)

**Digital Asset Links (production):**
The server must serve `/.well-known/assetlinks.json` containing the app's signing key SHA-256 fingerprint. This is a deployment prerequisite for the URL bar-less TWA experience. Add a static route in FastAPI to serve this file.

### 2. Foreground Service — `GameKeepAliveService.kt`

Android kills background activities but protects foreground services with an ongoing notification.

- Small Kotlin class that shows a persistent notification: "Kaillera Next — game in progress"
- Started when the game starts, stopped when the game ends
- Web app signals start/stop via the local WebSocket bridge: `{type: 'keepalive', active: true/false}`

**Foreground service type:** On Android 14+ (API 34), `FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK` requires an active `MediaSession`. Since the TWA's audio is in Chrome (not the Kotlin process), the app does not own a media session. Use `FOREGROUND_SERVICE_TYPE_SPECIAL_USE` with a justification for Play Store review, or create a minimal `MediaSession` in the service. The implementation plan should evaluate which approach is simpler at build time.

### 3. Native Gamepad Bridge — Local WebSocket

**Why not `@JavascriptInterface`?**
TWA runs inside Chrome, not a WebView. You can't inject native bridges directly. A local WebSocket is the clean solution — it works with any browser and the same pattern extends to the desktop Chrome extension.

**Architecture:**
- Kotlin starts a lightweight WebSocket server on `ws://localhost:8765` (e.g., using `org.java-websocket:Java-WebSocket`)
- Web app connects on page load when `_knPlatform=android` is detected
- Latency: <1ms (localhost), negligible for input
- Port 8765 is an unregistered port above 1024 — safe to hardcode. If a conflict arises, the port can be passed via query parameter (`&_knBridgePort=8766`) in a future update.

**Mixed content note:** In production, the page is served over `https://`. Connecting to `ws://localhost:8765` (not `wss://`) is a mixed content scenario, but `ws://localhost` is exempt from mixed content blocking per the W3C Secure Contexts spec. Since TWA always runs in Chrome, this is safe.

**CSP note:** The server's CSP `connect-src` directive already includes `ws:`, so `ws://localhost:8765` is permitted. If CSP is tightened in the future, the WebSocket bridge will need to be included.

**Android → Web (input):**

A polling loop reads `InputDevice` state and pushes to all connected WebSocket clients:

```json
{"type": "input", "buttons": 0, "lx": -42, "ly": 83, "cx": 0, "cy": 0}
```

Same `{buttons, lx, ly, cx, cy}` shape as the true-analog gamepad spec and the iOS bridge. `shared.js` receives messages, sets `window._knNativeInput`, and `readLocalInput()` picks it up — identical consumer path as iOS (see iOS spec section 5 for the shared `readLocalInput()` code change).

**Single controller in v1:** Only the first connected controller is read. Multi-controller support (mapping multiple InputDevices to player slots) is out of scope. The web app's existing GamepadManager handles multi-pad for browser controllers.

**Web → Android (rumble):**

```json
{"type": "rumble", "intensity": 0.5, "duration": 100}
```

`intensity`: 0.0-1.0 float. `duration`: milliseconds integer. Android side triggers `InputDevice.getVibratorManager()` (API 31+) or `Vibrator` service. Silently no-ops if vibration hardware is unavailable.

**Web → Android (keep-alive):**

```json
{"type": "keepalive", "active": true}
```

Android side starts/stops the foreground service.

**Supported controllers:**
- Xbox, DualSense, DualShock, 8BitDo, generic HID — all via Android's `InputDevice` API
- `InputDevice.getMotionRange()` gives raw axis values, no browser normalization
- Both USB and Bluetooth controllers

### 4. Web App Detection & WebSocket Lifecycle

Since TWA can't inject JavaScript, detection uses a query parameter.

The TWA launches Chrome with `?_knPlatform=android` appended. `shared.js` on page load:

```javascript
const params = new URLSearchParams(location.search);
if (params.get('_knPlatform') === 'android') {
  window._knNative = { platform: 'android', version: '1.0' };
  sessionStorage.setItem('_knPlatform', 'android');
}

// Also check sessionStorage (survives page navigation within the same tab)
if (sessionStorage.getItem('_knPlatform') === 'android') {
  window._knNative = window._knNative || { platform: 'android', version: '1.0' };
  connectNativeBridge();
}

function connectNativeBridge() {
  const ws = new WebSocket('ws://localhost:8765');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'input') {
      window._knNativeInput = msg;
    }
  };
  ws.onclose = () => setTimeout(connectNativeBridge, 500);
  ws.onerror = () => ws.close();  // triggers onclose → reconnect
}
```

**Key details:**
- `sessionStorage` persists the platform flag across page navigations (lobby → play page). The query parameter is only needed on the initial TWA launch.
- WebSocket reconnects with 500ms backoff on disconnect. This handles page reloads, navigation between lobby and game, and the case where the page loads before the Kotlin WebSocket server is ready.

Same `readLocalInput()` priority as iOS: `window._knNativeInput` first (bypassing `document.hasFocus()` guard), Web Gamepad API fallback, keyboard, touch. See iOS spec section 5 for the shared code change.

### 5. Wake Lock

```kotlin
window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
```

One line on the Activity window. Prevents screen dimming. Active for the lifetime of the app (including lobby) — acceptable trade-off for a game app.

## What This Fixes

| Problem | How |
|---|---|
| Background kill when switching apps | Foreground service with ongoing notification |
| Screen dims during gameplay | `FLAG_KEEP_SCREEN_ON` |
| Web Gamepad API cooked input | Native InputDevice via local WebSocket |
| Rumble/haptics | InputDevice vibrator via local WebSocket |

## What This Doesn't Fix

| Problem | Why |
|---|---|
| Mobile hardware slower than desktop | Hardware limitation |
| loadState() blocking main thread | WASM single-threaded execution |
| WebRTC ICE flaps | Network layer |

## Play Store Compliance

Google Play has allowed emulators for years. RetroArch, Lemuroid, and many others are live.

**Requirements met:**
- App does not include or distribute ROMs
- Emulator code is GPL open source
- No piracy facilitation

## Shared Code with iOS

The web-side integration is nearly identical:
- Both set `window._knNative` with platform info
- Both populate `window._knNativeInput` with the same `{buttons, lx, ly, cx, cy}` shape
- `readLocalInput()` in `shared.js` has one code path for both — priority-zero native input check before gamepad/keyboard/touch (defined in iOS spec, shared prerequisite)
- The only difference is transport: iOS uses `evaluateJavaScript` (WKWebView can inject), Android uses local WebSocket (TWA can't inject)

## Files Changed

| Location | Change |
|---|---|
| `android/` (new) | Gradle project, TWA activity, foreground service, WebSocket gamepad server |
| `web/static/shared.js` | Query param + sessionStorage detection for `_knPlatform=android`, WebSocket connect with reconnect to `ws://localhost:8765` |
| `server/` | Add `/.well-known/assetlinks.json` static route (production deployment) |
