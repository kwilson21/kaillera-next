# iOS Native Wrapper Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a minimal iOS WKWebView shell that eliminates Safari's background kill, autoplay restrictions, and gamepad API limitations for kaillera-next.

**Architecture:** Single-view Swift app wrapping the existing web app in a full-screen WKWebView. Native GCController bridge passes input via `evaluateJavaScript`. AVAudioSession `.playback` entitlement keeps the process alive when backgrounded. Web app detects `window._knNative` and upgrades capabilities.

**Tech Stack:** Swift, UIKit (programmatic), WKWebView, GameController.framework, AVFoundation

**Spec:** `docs/superpowers/specs/2026-03-26-ios-native-wrapper-design.md`

**Dependency:** True-analog gamepad spec (already implemented — `readLocalInput()` returns `{buttons, lx, ly, cx, cy}` objects).

---

## Chunk 1: Xcode Project + WebView Shell

### Task 1: Create Xcode project structure

**Files:**
- Create: `ios/KailleraNext.xcodeproj/project.pbxproj`
- Create: `ios/KailleraNext/AppDelegate.swift`
- Create: `ios/KailleraNext/SceneDelegate.swift`
- Create: `ios/KailleraNext/ViewController.swift`
- Create: `ios/KailleraNext/Info.plist`
- Create: `ios/KailleraNext/Assets.xcassets/`

- [ ] **Step 1: Create Xcode project via Xcode GUI**

Open Xcode → File → New → Project → iOS → App. Settings:
- Product name: `KailleraNext`
- Team: your Apple Developer account
- Organization identifier: `com.kaillera`
- Interface: **Storyboard** (we'll delete the storyboard immediately)
- Language: **Swift**
- Uncheck "Include Tests"
- Save into the repo's `ios/` directory (create `ios/` first: `mkdir -p ios`)

After creation:
1. Delete `Main.storyboard` from the project
2. In project settings → General → Deployment Info, clear "Main Interface" (remove "Main")
3. Set deployment target: **iOS 16.0**
4. Delete the auto-generated `ViewController.swift` and `SceneDelegate.swift` (we'll write our own)

- [ ] **Step 2: Write AppDelegate.swift**

```swift
import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        return true
    }

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }
}
```

- [ ] **Step 3: Write SceneDelegate.swift**

```swift
import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = ViewController()
        self.window = window
        window.makeKeyAndVisible()
    }
}
```

- [ ] **Step 4: Write ViewController.swift (WebView shell, no bridges yet)**

```swift
import UIKit
import WebKit

class ViewController: UIViewController, WKNavigationDelegate {

    // ── Configuration ──────────────────────────────────────────────
    // Change this to your LAN IP for development, or production URL for release.
    #if DEBUG
    private let serverURL = URL(string: "http://192.168.1.100:27888")!
    #else
    private let serverURL = URL(string: "https://yourdomain.com")!
    #endif

    private var webView: WKWebView!

    // ── Lifecycle ──────────────────────────────────────────────────

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupWebView()
        loadApp()
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    // ── WebView Setup ──────────────────────────────────────────────

    private func setupWebView() {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // Inject native shell detection at document start
        let nativeScript = WKUserScript(
            source: "window._knNative = { platform: 'ios', version: '1.0' };",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(nativeScript)

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.scrollView.isScrollEnabled = false
        webView.isOpaque = false
        webView.backgroundColor = .black

        view.addSubview(webView)
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
    }

    private func loadApp() {
        UIApplication.shared.isIdleTimerDisabled = true
        webView.load(URLRequest(url: serverURL))
    }

    // ── Navigation Delegate (error handling) ───────────────────────

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        showRetryScreen(error: error)
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        showRetryScreen(error: error)
    }

    private func showRetryScreen(error: Error) {
        let alert = UIAlertController(
            title: "Connection Failed",
            message: "Could not reach \(serverURL.host ?? "server").\n\(error.localizedDescription)",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Retry", style: .default) { [weak self] _ in
            self?.loadApp()
        })
        present(alert, animated: true)
    }
}
```

- [ ] **Step 5: Configure Info.plist**

The Info.plist must include:
```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
<key>UIApplicationSceneManifest</key>
<dict>
    <key>UIApplicationSupportsMultipleScenes</key>
    <false/>
    <key>UISceneConfigurations</key>
    <dict>
        <key>UIWindowSceneSessionRoleApplication</key>
        <array>
            <dict>
                <key>UISceneConfigurationName</key>
                <string>Default Configuration</string>
                <key>UISceneDelegateClassName</key>
                <string>$(PRODUCT_MODULE_NAME).SceneDelegate</string>
            </dict>
        </array>
    </dict>
</dict>
```

- [ ] **Step 6: Build and run on device**

Open `ios/KailleraNext.xcodeproj` in Xcode. Set team (Apple Developer account), select your iPhone as target. Build and run. Verify:
- App opens full-screen, no status bar
- Web app loads from LAN server
- Lobby page renders correctly
- Screen does not dim

- [ ] **Step 7: Commit**

```bash
git add ios/
git commit -m "feat(ios): minimal WKWebView shell — loads web app, ATS exception, retry screen"
```

---

### Task 2: Background audio keep-alive

**Files:**
- Modify: `ios/KailleraNext/Info.plist`
- Modify: `ios/KailleraNext/ViewController.swift`

- [ ] **Step 1: Add background audio entitlement to Info.plist**

Add to Info.plist:
```xml
<key>UIBackgroundModes</key>
<array>
    <string>audio</string>
</array>
```

- [ ] **Step 2: Configure AVAudioSession in ViewController**

Add to the top of `ViewController.swift`:
```swift
import AVFoundation
```

Add a new method and call it from `viewDidLoad()` before `setupWebView()`:
```swift
private func configureAudioSession() {
    do {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, options: .mixWithOthers)
        try session.setActive(true)
    } catch {
        print("[KailleraNext] AVAudioSession setup failed: \(error)")
    }
}
```

- [ ] **Step 3: Test background survival**

Build and run. Start a game (so audio is playing). Press the home button or switch to another app. Wait 10 seconds. Switch back. Verify:
- Game audio resumes immediately (or never stopped)
- WebRTC/Socket.IO connection is still alive (not disconnected)
- Game state is intact

- [ ] **Step 4: Commit**

```bash
git add ios/
git commit -m "feat(ios): AVAudioSession .playback keeps game alive when backgrounded"
```

---

## Chunk 2: Native GCController Bridge

### Task 3: Controller input polling + rumble bridge

**Files:**
- Create: `ios/KailleraNext/ControllerBridge.swift`
- Modify: `ios/KailleraNext/ViewController.swift`

- [ ] **Step 1: Create ControllerBridge.swift**

This class polls GCController each frame via CADisplayLink, posts input to the WebView, and handles rumble messages from the web app. Must inherit from `NSObject` for `@objc` selectors and `WKScriptMessageHandler` conformance. Uses deferred `webView` pattern (set after WKWebView init, since the bridge must be registered on the config before the WebView is created).

```swift
import GameController
import WebKit
import CoreHaptics

class ControllerBridge: NSObject, WKScriptMessageHandler {

    weak var webView: WKWebView?
    private var displayLink: CADisplayLink?
    private var currentController: GCController?

    // N64 analog range: ±83 (community standard, matches web gamepad pipeline)
    private let n64Max: Float = 83.0

    override init() {
        super.init()
        observeControllers()
        startPolling()
    }

    deinit {
        displayLink?.invalidate()
        NotificationCenter.default.removeObserver(self)
    }

    // ── Controller observation ─────────────────────────────────────

    private func observeControllers() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(controllerDidConnect),
            name: .GCControllerDidConnect,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(controllerDidDisconnect),
            name: .GCControllerDidDisconnect,
            object: nil
        )
        // Pick up any already-connected controller
        currentController = GCController.current
    }

    @objc private func controllerDidConnect(_ note: Notification) {
        currentController = GCController.current
    }

    @objc private func controllerDidDisconnect(_ note: Notification) {
        if currentController == note.object as? GCController {
            currentController = nil
            // Clear native input so web app falls back to Web Gamepad API / touch
            webView?.evaluateJavaScript("window._knNativeInput = null;", completionHandler: nil)
        }
    }

    // ── Polling loop ───────────────────────────────────────────────

    private func startPolling() {
        displayLink = CADisplayLink(target: self, selector: #selector(pollInput))
        displayLink?.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 120, preferred: 60)
        displayLink?.add(to: .main, forMode: .common)
    }

    @objc private func pollInput() {
        guard let controller = currentController,
              let gp = controller.extendedGamepad,
              let webView = webView else { return }

        // ── Digital buttons → 16-bit mask ──────────────────────────
        var buttons: UInt16 = 0
        if gp.buttonA.isPressed          { buttons |= 1 << 0 }   // N64 A
        if gp.buttonB.isPressed          { buttons |= 1 << 1 }   // N64 B
        if gp.buttonMenu.isPressed       { buttons |= 1 << 3 }   // N64 Start
        if gp.dpad.up.isPressed          { buttons |= 1 << 4 }   // D-Up
        if gp.dpad.down.isPressed        { buttons |= 1 << 5 }   // D-Down
        if gp.dpad.left.isPressed        { buttons |= 1 << 6 }   // D-Left
        if gp.dpad.right.isPressed       { buttons |= 1 << 7 }   // D-Right
        if gp.leftShoulder.isPressed     { buttons |= 1 << 10 }  // N64 L
        if gp.rightShoulder.isPressed    { buttons |= 1 << 11 }  // N64 R
        if gp.leftTrigger.isPressed      { buttons |= 1 << 12 }  // N64 Z

        // ── Left stick → N64 quantized ±83 ─────────────────────────
        let lx = Int(round(gp.leftThumbstick.xAxis.value * n64Max))
        let ly = Int(round(gp.leftThumbstick.yAxis.value * n64Max))

        // ── Right stick → C-stick (digital snap: 0 or ±83) ────────
        let deadzone: Float = 0.3
        let cx = abs(gp.rightThumbstick.xAxis.value) > deadzone
            ? Int(gp.rightThumbstick.xAxis.value > 0 ? n64Max : -n64Max) : 0
        let cy = abs(gp.rightThumbstick.yAxis.value) > deadzone
            ? Int(gp.rightThumbstick.yAxis.value > 0 ? n64Max : -n64Max) : 0

        // ── Post to WebView ────────────────────────────────────────
        let js = "window._knNativeInput={buttons:\(buttons),lx:\(lx),ly:\(ly),cx:\(cx),cy:\(cy)};"
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // ── Rumble (web → native) ──────────────────────────────────────
    // Triggered by: window.webkit.messageHandlers.rumble.postMessage({intensity, duration})
    // JS caller is not wired up yet — this is a forward-looking stub.
    // The web app will call this once we add WASM core Rumble Pak interception (Phase 2).

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "rumble",
              let body = message.body as? [String: Any],
              let intensity = body["intensity"] as? Double,
              let duration = body["duration"] as? Int,
              let controller = currentController,
              let haptics = controller.haptics else { return }

        do {
            let engine = haptics.createEngine(withLocality: .default)
            try engine.start()
            let player = try engine.makePlayer(
                with: CHHapticPattern(events: [
                    CHHapticEvent(
                        eventType: .hapticContinuous,
                        parameters: [
                            CHHapticEventParameter(parameterID: .hapticIntensity, value: Float(intensity)),
                            CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.5),
                        ],
                        relativeTime: 0,
                        duration: TimeInterval(duration) / 1000.0
                    )
                ], parameters: [])
            )
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            // Haptics not supported on this controller — silently ignore
        }
    }
}
```

**Note on analog scaling:** The native bridge does a simple `round(value * 83)` without the web pipeline's per-axis deadzone/ramp (`_analogScale` in `gamepad-manager.js`). GCController applies hardware-level deadzone. The user's localStorage deadzone/range settings are ignored in native mode. This is acceptable for v1 — native controllers have better hardware deadzones than the Web Gamepad API values.

- [ ] **Step 2: Wire ControllerBridge into ViewController**

In `ViewController.swift`, add a property:

```swift
private var controllerBridge: ControllerBridge?
```

Restructure `setupWebView()` to create the bridge before the WKWebView (the message handler must be registered on the config before WKWebView init):

```swift
private func setupWebView() {
    let config = WKWebViewConfiguration()
    config.allowsInlineMediaPlayback = true
    config.mediaTypesRequiringUserActionForPlayback = []

    // Inject native shell detection at document start
    let nativeScript = WKUserScript(
        source: "window._knNative = { platform: 'ios', version: '1.0' };",
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )
    config.userContentController.addUserScript(nativeScript)

    // Controller bridge — must register before WKWebView init
    controllerBridge = ControllerBridge()
    config.userContentController.add(controllerBridge!, name: "rumble")

    webView = WKWebView(frame: .zero, configuration: config)
    controllerBridge?.webView = webView  // deferred — now the WebView exists

    webView.navigationDelegate = self
    webView.scrollView.isScrollEnabled = false
    webView.isOpaque = false
    webView.backgroundColor = .black

    view.addSubview(webView)
    webView.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        webView.topAnchor.constraint(equalTo: view.topAnchor),
        webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
        webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    ])
}
```

Add `deinit` to ViewController to break the WKUserContentController → ControllerBridge retain cycle:

```swift
deinit {
    webView?.configuration.userContentController.removeScriptMessageHandler(forName: "rumble")
}
```

`viewDidLoad()` stays the same:

```swift
override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    configureAudioSession()
    setupWebView()
    loadApp()
}
```

- [ ] **Step 3: Test with a physical controller**

Build and run. Connect a DualSense, Xbox, or MFi controller to the iPhone via Bluetooth. Start a game. Verify:
- Controller input is detected (check Safari Web Inspector console for `_knNativeInput` being set)
- At this point the web side doesn't read it yet — that's Task 4

- [ ] **Step 4: Commit**

```bash
git add ios/
git commit -m "feat(ios): GCController bridge + rumble handler — polls input, posts to WebView"
```

---

## Chunk 3: Web App Integration

### Task 4: readLocalInput() native bridge support

**Files:**
- Modify: `web/static/shared.js:228-244`

- [ ] **Step 1: Add native input check to readLocalInput()**

In `shared.js`, at the top of `readLocalInput()` (line 228), after the `remapActive` check (line 232), add the native bridge path before the existing gamepad check:

```javascript
    // 0. Native bridge (iOS/Android wrapper — highest fidelity, no hasFocus gate)
    if (window._knNativeInput) {
      const n = window._knNativeInput;
      input.buttons = n.buttons;
      input.lx = n.lx;
      input.ly = n.ly;
      input.cx = n.cx;
      input.cy = n.cy;
      return input;  // Native bridge provides complete input — skip all other sources
    }
```

This goes after line 232 (`if (KNState.remapActive) return { ...ZERO_INPUT };`) and before line 234 (`// 1. Gamepad`).

Important: No `document.hasFocus()` gate — the native layer provides input regardless of WebView focus state.

- [ ] **Step 2: Test in browser (no native wrapper)**

Open the web app in a desktop browser. Verify:
- `window._knNativeInput` is undefined
- Gamepad, keyboard, and touch input all still work as before
- No errors in console

- [ ] **Step 3: Test in iOS wrapper with controller**

Build and run the iOS app. Connect a controller. Start a game. Verify:
- Native controller input is used (analog stick produces walk speed at partial tilt)
- Disconnecting the controller falls back to touch input

- [ ] **Step 4: Commit**

```bash
git add web/static/shared.js
git commit -m "feat: readLocalInput() checks native bridge first (iOS wrapper support)"
```

---

### Task 5: Skip autoplay workarounds in native wrapper

**Files:**
- Modify: `web/static/netplay-streaming.js:227-251`
- Modify: `web/static/netplay-lockstep.js:825-834`

- [ ] **Step 1: Skip muted autoplay in streaming mode**

In `netplay-streaming.js`, around line 229 where `_guestVideo.muted = true` is set, wrap the muted start + unmute banner logic in a native check:

```javascript
          if (window._knNative) {
            _guestVideo.muted = false;
          } else {
            _guestVideo.muted = true;
          }
```

And wrap the `playing` event listener's unmute-banner fallback (lines 237-251) so it only runs when not in native wrapper:

```javascript
          _guestVideo.addEventListener(
            'playing',
            () => {
              _guestVideo.muted = false;
              if (!window._knNative && _guestVideo.muted) {
                // ... existing unmute banner code unchanged ...
              }
            },
            { once: true },
          );
```

- [ ] **Step 2: Skip AudioContext resume gesture listener in lockstep mode**

In `netplay-lockstep.js`, around line 828, wrap the `if (_audioCtx.state !== 'running')` block:

```javascript
      if (!window._knNative && _audioCtx.state !== 'running') {
        // ... existing resume-on-gesture code unchanged ...
      }
```

In the native wrapper, the AVAudioSession is already active, so the AudioContext should start in `running` state immediately. The `!window._knNative` guard is belt-and-suspenders.

- [ ] **Step 3: Test streaming mode in iOS wrapper**

Build and run. Join a room as a streaming guest. Verify:
- Video plays immediately with sound (no "tap to unmute" banner)
- No autoplay errors in console

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-streaming.js web/static/netplay-lockstep.js
git commit -m "feat: skip autoplay workarounds in native iOS wrapper"
```

---

### Task 6: End-to-end verification

**Files:** None (testing only)

- [ ] **Step 1: Test lockstep mode 2-player**

Run the iOS app on your iPhone. Open the web app on desktop in a browser. Create a room on one, join on the other. Start a lockstep game. Verify:
- Both players see synchronized gameplay
- iOS app controller input works with analog precision
- Audio works on both sides

- [ ] **Step 2: Test background survival**

During an active lockstep game on the iOS app:
- Press home button, wait 5 seconds, come back
- Verify: game resumes, connection intact, no desync

- [ ] **Step 3: Test streaming mode as guest**

Join as streaming guest on iOS app:
- Verify: video plays immediately unmuted
- Verify: controller input reaches host

- [ ] **Step 4: Test controller disconnect/reconnect**

During a game, turn off the Bluetooth controller:
- Verify: input falls back to touch/virtual gamepad
- Turn controller back on:
- Verify: native input resumes

- [ ] **Step 5: Test without controller (touch only)**

Start a game with no controller connected:
- Verify: virtual gamepad works exactly as in Safari
- Verify: no errors from the native bridge (it should be inactive)

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "test: verify iOS native wrapper end-to-end"
```

(Only commit if there are any fixes discovered during testing.)
