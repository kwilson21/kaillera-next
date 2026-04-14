# Pre-Gameplay Boot Reliability Audit

**Date:** 2026-04-12
**Status:** Proposed design, pending approval
**Trigger:** Room `80130R4Q` — `NotAllowedError: Document is hidden`
killed audio and input at boot; 69 frames, zero player input, ended
by disconnect. A second attempt produced no session log at all.

## Companion specs

This spec covers the gap between two existing audits:

- [netplay-deadlock-audit.md](2026-04-11-netplay-deadlock-audit.md) —
  mid-game tick-loop deadlocks (MF1-MF6, all merged).
- [rollback-state-integrity-audit.md](2026-04-11-rollback-state-integrity-audit.md) —
  silent rollback state corruption during gameplay (RF1-RF7, all merged).

Those specs assume the game is running. This spec covers failures
**before gameplay begins** — the path from "player opens URL" to
"game is running with input flowing."

## Problem

Three real sessions demonstrate the failure classes:

**Session 1 (80130R4Q):** Two desktop peers, same machine.
`NotAllowedError: Document is hidden` fired 5 seconds after
`game-started`. AudioContext never resumed. Zero input detected on
either peer (gamepad reading gated on `document.hasFocus()`). 69
frames at ~1.2 fps (background-throttled `setInterval`). Both peers
stuck in BOOT-LOCKSTEP for 59 iterations. Match ended by disconnect
after 61 seconds with no gameplay.

**Session 2:** No session log at all. Failure occurred before
`server_game_started` — the boot funnel broke somewhere between page
load and clicking Start. A Playwright reproduction showed
`window.EJS_emulator = undefined` after 60 seconds with no error; the
Start button click appeared to succeed but nothing happened.

**Session 3 (VYR4YWBV):** Succeeded (10312 frames, game-end) but
showed boot noise: 8 PACING-SAFETY-FREEZE events at f=312, 4
TICK-STUCK warnings, RENDER-STALL for 180 frames during boot, and a
PEER-RESET at f=778.

## Goal

Every stage of the boot funnel either succeeds within a bounded time
or fails with a user-visible error and a diagnostic event that the
analyzer can classify. No silent hangs. No invisible audio death. No
focus-gated input starvation without recovery.

## Non-goals

- No mid-game tick-loop deadlock fixes (deadlock-audit spec).
- No rollback state integrity fixes (rollback-integrity spec).
- No new netplay features or protocol changes.
- No refactor of `netplay-lockstep.js` structure beyond targeted fixes.
- No unit-test infrastructure — use real two-tab Playwright harness.

---

## Boot funnel stages

Every session passes through these stages in order. For each stage,
the spec documents: what triggers it, what can fail, whether failures
are surfaced to the user, and the current timeout/recovery behavior.

```
Stage 1: Page load → Socket.IO connect
Stage 2: Room create (host) or join (guest)
Stage 3: ROM load (cache / drag-drop / ROM sharing)
Stage 4: Start Game button click
Stage 5: EmulatorJS initialization (EJS loader + core-redirector)
Stage 6: WebRTC handshake (offer/answer/ICE → DataChannel open)
Stage 7: game-started broadcast → initEngine()
Stage 8: Boot convergence (first 300 frames, pure lockstep)
Stage 9: Input flowing → playable state
```

### Stage 1 — Socket.IO connect

- **Trigger:** `play.js:230-231` — `socket = io(origin, { transports: ['websocket', 'polling'] })`
- **Listener:** `play.js:259-261` — `socket.on('connect', onConnect)`
- **Timeout:** None explicit. Socket.IO retries with backoff.
- **Failure surface:** No user-visible error if connection never establishes. The lobby UI stays in its initial state.
- **Finding:** **No timeout on initial connection.** If the server is down, the user sees a blank lobby with no feedback.

### Stage 2 — Room create/join

- **Host path:** `play.js:503-530` — emits `open-room` with callback.
  Server validates at `signaling.py:395-463` (6 error conditions:
  rate limit, missing sessionid, invalid room code, invalid reconnect
  token, room already exists, server full).
- **Guest path:** `play.js:534-593` — REST fetch `/room/{roomCode}`
  then emits `join-room`. Server validates at `signaling.py:466-544`
  (7 error conditions: rate limit, invalid code, room not found,
  wrong password, invalid reconnect token, spectator limit, room
  full).
- **Timeout:** None on the socket emit callbacks. REST fetch has
  browser default timeout.
- **Failure surface:** Error strings returned in callback → `showError()`.
  These are well-surfaced.
- **Finding:** Adequate. Server-side validation is thorough and errors
  reach the user.

### Stage 3 — ROM load

- **Auto-load from IDB cache:** `play.js:2252-2275` —
  `loadRomFromLibrary()` fetches most recent ROM by hash.
- **Drag-and-drop:** `play.js:2244-2249` → `handleRomFile()` at
  `play.js:2278-2305`.
- **ROM sharing:** WebRTC DataChannel transfer from host.
- **Hash computation:** `play.js:2329-2370` — SHA-256 via
  `crypto.subtle.digest()`. 15-second timeout at line 2331-2338.
- **Failure surface:** ZIP extraction failure → toast. Hash timeout →
  toast ("ROM hash failed — try a smaller ROM").
- **Finding:** Adequate. The 15-second hash timeout was added in the
  P1-3 fix (2026-04-07).

### Stage 4 — Start Game button

- **Handler:** `play.js:2919-2939` — `startGame()` click handler.
- **Guards:** No ROM → toast and return (line 2920-2923).
- **Audio preload:** `_preloadAudioCtx()` called at line 2924.
- **Emit:** `start-game` event with `{ mode, resyncEnabled, romHash }`.
- **Server validation:** `signaling.py:622-675` — host-only, ROM
  readiness check.
- **Failure surface:** Missing ROM → toast. Server rejection → error
  string in callback.
- **Finding:** Adequate for the button itself. The `_preloadAudioCtx()`
  call is the first audio gesture point — see BF3 below.

### Stage 5 — EmulatorJS initialization

- **Core preload:** `play.html:18-36` — `<link rel="preload">` for
  WASM core based on `/api/core-info` response.
- **Core redirector:** `core-redirector.js:53-67` — fetches
  `/api/core-info`, stores hash, clears IDB on hash mismatch.
  Exposes `window._knCoreReady` promise (line 119).
- **Boot emulator:** `play.js:2139-2202` — `bootEmulator()` awaits
  `_knCoreReady`, then injects `ejs-loader.js` script tag.
- **EJS loader:** Instantiates `EmulatorJS` class, which downloads
  WASM core, initializes Emscripten, creates canvas.
- **Timeout:** 30-second game-loading spinner timeout at
  `play.js:2875-2904` (added in P1-3).
- **Failure surface:** Core fetch failure → fallback URL (silent).
  IDB clear failure → continues (silent). EJS loader 404 → logged
  but no visible error. 30-second timeout → error modal.
- **Finding:** **Session 2's likely failure point.** If `_knCoreReady`
  never resolves (e.g., `/api/core-info` fetch hangs without
  rejecting), `bootEmulator()` awaits forever. The 30-second
  game-loading timeout exists but may not cover the await-before-
  injection path. See BF5 below.

### Stage 6 — WebRTC handshake

- **Trigger:** `netplay-lockstep.js:2357-2450` — `onUsersUpdated()`
  creates peers and sends offers. Lower-slot initiates (line
  2428-2429); late-joiner always initiates (line 2418-2420).
- **Peer creation:** `netplay-lockstep.js:2454-2576` — creates
  `RTCPeerConnection`, creates 3 DataChannels (lockstep, sync-state,
  rollback-input).
- **Signaling relay:** Offers/answers/ICE candidates relayed via
  Socket.IO `webrtc-signal` events through the server.
- **DC open:** `netplay-lockstep.js:2840-2856` — `setupDataChannel`
  `onopen` fires `KNEvent('webrtc_connected')`.
- **Timeout:** 15-second warning at engine init (line 8522-8533).
  30-second game-loading spinner timeout covers DC-never-opens.
- **Failure surface:** Connection timeout → error modal with per-peer
  connection states (P1-3 fix). WebRTC failure → toast.
- **Finding:** Adequate. Timeout and failure reporting were fixed in
  the P1 pass.

### Stage 7 — game-started → initEngine()

- **Trigger:** `play.js:892-972` — `onGameStarted(data)` callback.
- **Flow:** Sets `gameRunning = true` (line 914), validates ROM hash
  (line 927-937), hides overlay, calls `initEngine()` (line 971).
- **initEngine():** `play.js:2743-2867` — boots emulator if needed,
  picks engine (lockstep/streaming), calls `Engine.init(config)`.
- **Engine.init:** `netplay-lockstep.js:8485-8535` — registers socket
  listeners, processes initial player list, establishes WebRTC
  connections.
- **Finding:** This stage chains stages 5-6. The gesture prompt
  (stage 8) follows. No independent failure modes beyond what's
  already covered.

### Stage 8 — Boot convergence

- **Gesture prompt:** `netplay-lockstep.js:3730-3777` — all players
  see "Click to start" overlay. Click handler creates AudioContexts
  for both EJS and lockstep. This is the critical audio gesture
  point.
- **Boot convergence:** `netplay-lockstep.js:6316-6379` — first 300
  frames after `_rbInitFrame` use pure lockstep: stall if ANY peer's
  input is missing for the apply frame.
- **Deadlock recovery:** 3-second wall-clock timeout at line 6347.
  Guest sends `sync-request-full`; host falls through. Fires once
  per stall (line 6337: `_bootStallRecoveryFired`).
- **Tick rate:** `setInterval(16)` — but background tabs throttle to
  ~1 fps. Both peers at 1 fps = boot takes 300 seconds instead of 5.
- **Finding:** **Core failure in sessions 1 and 3.** See BF1, BF2,
  BF4 below.

### Stage 9 — Input flowing

- **First frame rendered:** `netplay-lockstep.js:3719` —
  `KNEvent('first_frame_rendered')` fires at `startGameSequence()`.
- **Input pipeline:** `shared.js:415-424` — gamepad input gated on
  `document.hasFocus()`. Keyboard input NOT gated (line 428-442).
  Touch/virtual gamepad NOT gated (line 444+).
- **INPUT-DEAD detection:** `netplay-lockstep.js:6714-6741` — logs
  after 300 frames of zero input. Diagnostic only, no recovery.
- **Finding:** **Input starvation is the mechanism behind Session 1's
  zero-input failure.** See BF2.

---

## Audit findings

Every finding includes file:line, one-line description, worst case,
and classification (MUST FIX / SHOULD FIX / NICE TO HAVE).

### BF1 — AudioContext activation failure (silent audio death)

**Files:**
- `play.js:131-153` — `_preloadAudioCtx()`: creates AudioContext,
  `.resume().catch(() => {})` silently swallows all errors.
- `netplay-lockstep.js:3751-3764` — gesture prompt handler: creates
  EJS and lockstep AudioContexts, `.resume().catch(() => {})` on
  both.
- `netplay-lockstep.js:2159-2167` — `resumeAudio()`: catches
  `.resume()` failure but only logs `e.message`, not `e.name`.
- `netplay-lockstep.js:2185-2187` — `feedAudio()`: checks
  `_audioReady && _audioCtx` but NOT `_audioCtx.state`. Feeds
  audio into a suspended context.

**What goes wrong:**

1. Player clicks Start → `_preloadAudioCtx()` creates AudioContext
   and calls `.resume()`. Error silently caught.
2. Player switches to another tab (or tests with two tabs on one
   machine). `document.hidden` becomes true.
3. `game-started` fires. Gesture prompt shown. Player clicks it.
   AudioContext created inside gesture — but `document.hidden` is
   true.
4. `.resume()` throws `NotAllowedError: Document is hidden`.
   Caught at `netplay-lockstep.js:3754` with `.catch(() => {})` —
   **silently swallowed**.
5. `resumeAudio()` listeners (click/keydown/touchstart) are
   registered at line 2169-2171. On next gesture, `.resume()` is
   retried — but if tab is STILL hidden, it fails again silently.
6. AudioWorklet loads at line 2069-2091 without checking
   `_audioCtx.state`. If context is suspended, worklet may start
   in a dead state.
7. `feedAudio()` runs every frame (line 2185). It posts audio
   samples to a dead worklet. After 300 frames (~5s), `audio-silent`
   diagnostic fires (line 2212-2227) showing `ctxState=suspended`
   — but no recovery action is taken.
8. When tab regains focus, `visibilitychange` handler
   (line 5631-5690) triggers resync but **does NOT attempt to resume
   AudioContext**. Audio stays dead until the next user gesture
   (click/keydown/touchstart).

**Evidence:** Session 80130R4Q — `NotAllowedError: Document is hidden`
at 00:48:04 on both peers. 53 `audio-empty` events. `ctxState=unknown
workletPort=unknown` in AUDIO-DEATH diagnostics. Audio never
recovered.

**Worst case:** Permanent audio death for the entire session. No
user-visible error — game appears to work but is silent.

**Class:** MUST FIX.

**Proposed fix (BF1-fix):**

1. **Log the error name, not just message.** At
   `netplay-lockstep.js:2166`, change to:
   `_syncLog(\`audio resume failed: ${e.name}: ${e.message}\`);`
   Emit `KNEvent('audio-fail', ...)` with the error name.

2. **Resume AudioContext on visibility return.** In the
   `visibilitychange` handler at line 5631-5690, when
   `!document.hidden` and `_audioCtx?.state === 'suspended'`:
   ```javascript
   _audioCtx.resume().catch((e) =>
     _syncLog(`audio re-resume failed: ${e.name}: ${e.message}`)
   );
   ```
   Also resume the EJS AudioContext if accessible.

3. **Check `_audioCtx.state` before feeding.** At
   `netplay-lockstep.js:2187`, add:
   ```javascript
   if (_audioCtx.state === 'suspended') {
     _audioCtx.resume().catch(() => {});
     return; // don't feed into suspended context
   }
   ```

4. **Replace silent `.catch(() => {})` with diagnostic catches.**
   At `play.js:139`, `netplay-lockstep.js:3754`, and line 3764:
   ```javascript
   .resume().catch((e) => console.warn(`[kn] AudioContext resume: ${e.name}: ${e.message}`));
   ```

5. **Surface persistent audio failure to the user.** If
   `_audioCtx.state` is still `suspended` after 5 seconds of
   gameplay, show a non-blocking toast: "Audio blocked — click
   anywhere to enable sound."

### BF2 — Gamepad input starvation when tab loses focus

**Files:**
- `shared.js:415-424` — `readLocalInput()` gates gamepad on
  `document.hasFocus()`. Returns zero for all axes/buttons.
- `shared.js:428-442` — keyboard input NOT gated on focus (reads
  from `heldKeys` set, populated by `keydown`/`keyup` on
  `document`).
- `netplay-lockstep.js:5697-5704` — focus/blur handlers log
  `TAB-FOCUS gained/lost` but take NO action.
- `netplay-lockstep.js:6714-6741` — `INPUT-DEAD` diagnostic fires
  after 300 frames of zero input. Logs `hasFocus` and gamepad count
  but takes no recovery action.

**What goes wrong:**

1. Player loses tab focus during boot (e.g., two-tab test, or
   switches to Discord/browser tab while waiting for peer).
2. `document.hasFocus()` returns false → gamepad read returns zero.
3. Zero input is sent to peer every frame. Peer receives valid
   (but empty) input — no stall triggered.
4. Boot convergence runs at 1 fps (background-throttled setInterval).
   300 boot frames = 300 seconds (5 minutes) instead of 5 seconds.
5. When tab regains focus, gamepad input resumes immediately (no
   recovery needed for the input pipeline itself). But 5 minutes of
   boot convergence at 1 fps is unacceptable.
6. If BOTH tabs lose focus (same-machine two-tab test), both send
   zero input, both stall on each other's apply frame, 3-second
   `BOOT-DEADLOCK-RECOVERY` fires on both, uncontrolled resync loop.

**Evidence:** Session 80130R4Q — 0% active input on both peers, 0
button presses, 0 stick activity. TAB-FOCUS churn at f=8-10. 59
BOOT-LOCKSTEP events. 69 frames in 61 seconds (~1.1 fps).

**Worst case:** 5-minute boot, or infinite resync loop with two
background tabs. No user feedback about why boot is slow.

**Class:** MUST FIX.

**Proposed fix (BF2-fix):**

1. **Detect background-throttled boot and warn the user.** If boot
   convergence has been running for >10 seconds wall-clock and
   `document.hidden` is true, show a persistent overlay: "Game is
   paused — switch to this tab to continue." Clear on
   `visibilitychange` when `!document.hidden`.

2. **Fast-forward boot on visibility return.** When the tab becomes
   visible after being hidden during boot convergence (frame < 300
   post-init), skip ahead: set `_frameNum` to the host's latest
   remote frame and request immediate resync. This avoids waiting
   for 300 frames at 1 fps.

3. **Do not gate gamepad reads on `document.hasFocus()` during boot
   convergence.** The focus gate exists to avoid reading stale
   gamepad state from a background tab, but during boot there is no
   meaningful input anyway — the game is showing menus. Remove the
   focus gate for the first 300 frames, or inject `ZERO_INPUT`
   explicitly instead of silently returning zero from a focus check.

   Alternatively: keep the focus gate but when `!document.hasFocus()`
   during boot, inject a neutral "I'm alive but unfocused" sentinel
   input that peers can distinguish from "genuinely no input" — this
   lets the peer know the player is still connected.

### BF3 — Gesture-gated AudioContext stalls emulator at frame 6

**Files:**
- `netplay-lockstep.js:3730-3777` — gesture prompt handler.
  AudioContexts created inside click.
- `play.js:131-153` — `_preloadAudioCtx()` creates AudioContext
  on Start click. If core downloads slowly (>3s), the gesture
  expires before EJS creates its AudioContext.
- Memory: `project_mobile_boot_touch_bug.md` — "Boot stalls at
  6/120 frames on mobile unless user taps the screen."

**What goes wrong:**

1. Player clicks Start Game. `_preloadAudioCtx()` creates
   AudioContext at `play.js:135`.
2. If WASM core download takes >3s (slow connection, cache miss),
   EJS creates its own AudioContext outside the gesture window.
3. Browser suspends the late-created AudioContext. EJS boot loop
   (Asyncify) stalls at frame 6 waiting for audio.
4. No visible prompt tells the player to click again.
5. Player eventually clicks by accident → AudioContext resumes →
   boot continues. But the stall is confusing UX.

**Mitigated by gesture prompt (line 3730-3777):** The gesture prompt
was added specifically to address this. It creates AudioContexts
inside a fresh click handler and monkey-patches `window.AudioContext`
so EJS gets a running context. **However**, if the player clicks the
gesture prompt while `document.hidden` is true (BF1 scenario), the
AudioContext is created but immediately suspended.

**Evidence:** Memory file `project_mobile_boot_touch_bug.md`: "Boot
stalls at 6/120 frames on mobile unless user taps the screen."
Confirmed on both desktop and mobile.

**Worst case:** Emulator stalls at frame 6 with no user feedback.
Player waits indefinitely until they click by accident.

**Class:** SHOULD FIX (mitigated by gesture prompt but not fully
resolved for hidden-tab scenarios).

**Proposed fix (BF3-fix):**

1. **Detect gesture-prompt-while-hidden.** If the gesture prompt
   click fires while `document.hidden`, defer the real audio
   initialization until the tab becomes visible. Show "Waiting for
   tab focus..." instead of proceeding with a doomed AudioContext.

2. **Add boot progress indicator.** Show the current boot frame
   count (e.g., "Booting: 6/120") so the user can see the stall.
   The stall at exactly frame 6 with no progress is a strong signal
   of audio suspension.

### BF4 — Boot convergence excessive duration

**Files:**
- `netplay-lockstep.js:6316-6379` — boot convergence (300 frames,
  pure lockstep).
- `netplay-lockstep.js:421` — `BOOT_GRACE_FRAMES = 120`.
- `netplay-lockstep.js:3711` — `MIN_BOOT_FRAMES = 120`.

**What goes wrong:**

1. Boot convergence requires 300 frames of pure lockstep after
   `_rbInitFrame`. At 60 fps, this takes 5 seconds.
2. If either peer is in a background tab, `setInterval(16)` is
   throttled to ~1 fps. 300 frames at 1 fps = 300 seconds.
3. If BOTH peers are background-throttled, mutual input stall
   triggers BOOT-DEADLOCK-RECOVERY every 3 seconds. Each recovery
   triggers a resync, which takes several seconds to complete,
   extending boot further.
4. Even in the foreground, 300 frames of pure lockstep means any
   network jitter causes visible stalls. PACING-SAFETY-FREEZE
   events during boot (Session 3: 8 events at f=312) are caused
   by frame advantage exceeding `rbMax-2` during this window.

**Evidence:** Session 80130R4Q — 59 BOOT-LOCKSTEP events over 61
seconds. Session VYR4YWBV — 8 PACING-SAFETY-FREEZE at f=312,
RENDER-STALL for 180 frames during boot.

**Worst case:** 5-minute boot (one background tab) or infinite
resync loop (both background tabs).

**Class:** SHOULD FIX.

**Proposed fix (BF4-fix):**

1. **Reduce boot convergence window.** 300 frames is conservative.
   The N64 boot sequence reaches a stable state by ~120 frames. The
   existing `BOOT_GRACE_FRAMES = 120` and `MIN_BOOT_FRAMES = 120`
   constants suggest 120 is sufficient. Reduce boot convergence
   check from 300 to 120 frames, with the existing 3-second deadlock
   recovery as a safety net.

2. **Skip boot convergence when tab is hidden.** If `document.hidden`
   at the start of boot convergence, immediately request full resync
   from host instead of stalling through 300 frames at 1 fps. This
   is safe because resync gives the guest the host's authoritative
   state — no divergence risk.

3. **Cap PACING-SAFETY-FREEZE during boot.** The pacing freezes at
   f=312 are caused by one peer advancing faster than the other
   during boot. During boot convergence, use a more generous
   `rbMax` threshold or disable the freeze entirely (boot is already
   pure-lockstep, so frame advantage is inherently bounded).

### BF5 — EmulatorJS boot hangs with no error

**Files:**
- `play.js:2139-2202` — `bootEmulator()`.
- `play.js:2185-2201` — first boot: awaits `window._knCoreReady`,
  then injects `ejs-loader.js`.
- `core-redirector.js:53-67` — `_knCoreReady` promise depends on
  `/api/core-info` fetch.
- `core-redirector.js:74-114` — IDB cache clear (part of
  `_knCoreReady`).

**What goes wrong:**

1. `bootEmulator()` calls `await window._knCoreReady` at line 2196.
2. `_knCoreReady` is a promise that resolves when both the
   `/api/core-info` fetch AND the IDB cache clear complete.
3. If `/api/core-info` fetch hangs (server overloaded, DNS failure,
   CORS error), `_knCoreReady` never resolves.
4. `bootEmulator()` awaits forever. No timeout on this specific
   await.
5. The 30-second game-loading spinner timeout
   (`play.js:2875-2904`) may or may not cover this path — it
   depends on whether the loading spinner is already showing when
   `bootEmulator()` starts its await.
6. If the EJS loader script tag fails (404, network error), the
   `onerror` handler at line 2191-2192 logs but does not show a
   user-visible error.

**Evidence:** Session 2 Playwright reproduction —
`window.EJS_emulator = undefined` after 60 seconds. No console
errors, no socket connection log, no core-redirector log.

**Worst case:** Infinite hang after clicking Start. No error shown.
Page appears functional but game never starts.

**Class:** MUST FIX.

**Proposed fix (BF5-fix):**

1. **Add timeout to `_knCoreReady` await.** In `bootEmulator()` at
   line 2196, wrap the await with `Promise.race`:
   ```javascript
   const coreReady = await Promise.race([
     window._knCoreReady,
     new Promise((_, reject) =>
       setTimeout(() => reject(new Error('Core load timeout')), 15000)
     ),
   ]);
   ```
   On timeout, show error modal: "Failed to load game engine —
   please refresh."

2. **Surface EJS loader failure.** At line 2191-2192, change the
   `onerror` handler to show an error modal instead of just logging:
   ```javascript
   script.onerror = () => {
     window.knShowError?.('Failed to load emulator — please refresh.');
     KNEvent('wasm-fail', 'ejs-loader script error');
   };
   ```

3. **Add fallback for `_knCoreReady` promise.** In
   `core-redirector.js`, ensure the promise rejects (not hangs) on
   fetch failure:
   ```javascript
   fetch('/api/core-info')
     .then(...)
     .catch((err) => {
       console.warn('[kn] core-info fetch failed:', err);
       // Resolve with fallback URL so boot can continue
       resolve(FALLBACK_CORE_URL);
     });
   ```

### BF6 — No visibility-aware AudioContext recovery

**Files:**
- `netplay-lockstep.js:5631-5690` — `visibilitychange` handler.
  Handles frame fast-forward and resync on tab return. Does NOT
  resume AudioContext.
- `netplay-lockstep.js:5697-5704` — focus/blur handlers. Log only.

**What goes wrong:**

1. AudioContext becomes suspended while tab is hidden (BF1).
2. Tab returns to foreground. `visibilitychange` handler fires.
3. Handler triggers resync and frame fast-forward but does NOT
   call `_audioCtx.resume()`.
4. Audio stays dead until the next user gesture (click/keydown/
   touchstart) triggers `resumeAudio()` at line 2159.
5. If the user is using a gamepad (no keyboard/mouse events),
   audio never recovers.

**Evidence:** Same root cause as BF1. The fix is part of BF1-fix
item 2.

**Worst case:** Permanent audio death after tab switch for gamepad
users.

**Class:** MUST FIX (covered by BF1-fix item 2).

### BF7 — Socket.IO initial connection has no timeout

**Files:**
- `play.js:230-231` — `io()` call with no explicit timeout config.
- `play.js:259-261` — `connect` listener.

**What goes wrong:**

1. Player opens play.html. Socket.IO begins connection attempt.
2. Server is down, unreachable, or DNS fails.
3. Socket.IO retries with exponential backoff (default behavior).
4. No user-visible feedback. Page looks loaded but lobby never
   populates.

**Worst case:** Player waits indefinitely with no error.

**Class:** SHOULD FIX.

**Proposed fix (BF7-fix):**

1. **Add 10-second initial connection timeout.** After creating the
   socket, set a timeout that shows a toast if `connect` hasn't
   fired within 10 seconds:
   ```javascript
   const connectTimeout = setTimeout(() => {
     if (!socket.connected) {
       showToast('Unable to reach server — retrying...', 'error');
     }
   }, 10000);
   socket.on('connect', () => { clearTimeout(connectTimeout); ... });
   ```

### BF8 — `feedAudio()` ignores AudioContext state

**Files:**
- `netplay-lockstep.js:2185-2187` — `feedAudio()` entry guard
  checks `_audioReady && _audioCtx` but not `_audioCtx.state`.
- `netplay-lockstep.js:2268-2270` — audio error caught once, then
  `_audioErrorLogged = true` silences all further errors.

**What goes wrong:**

1. AudioContext is suspended (BF1/BF6 scenario).
2. `feedAudio()` runs every frame. Posts audio samples to
   AudioWorklet via `port.postMessage()`.
3. Samples are silently dropped — worklet's `process()` runs but
   output goes nowhere because context is suspended.
4. First error (if `postMessage` throws) is logged; subsequent
   errors suppressed by `_audioErrorLogged` flag.
5. No diagnostic event distinguishes "audio pipeline working but
   context suspended" from "audio pipeline broken."

**Worst case:** Silent audio for entire session. Diagnostic shows
`audio-silent` but doesn't surface root cause (suspended context vs.
no samples vs. worklet failure).

**Class:** SHOULD FIX (covered by BF1-fix item 3).

---

## Proposed analyzer improvements

### New section: Boot Funnel Analysis

Add a new section `query_boot_funnel(df, client_events, meta)` to
`tools/analyze_match.py` after the existing `query_boot_deadlock()`
section (8a). Section number: **8f. BOOT FUNNEL ANALYSIS**.

The section should:

1. **Extract boot timeline from `client_events`:**
   - `room_created` → `peer_joined` → `rom_loaded` →
     `webrtc_connected` → `server_game_started` → `first_frame_rendered` →
     `emulator_booted`
   - For each event: timestamp, slot, elapsed time from previous
     stage.
   - Flag any stage that took >5 seconds with `SLOW-BOOT-STAGE`.
   - Flag any missing stage with `MISSING-BOOT-STAGE`.

2. **Compute boot duration:**
   - `boot_duration = emulator_booted.timestamp - server_game_started.timestamp`
   - If > 10s: `BOOT-SLOW` classification.
   - If > 30s: `BOOT-TIMEOUT` classification.
   - If `emulator_booted` missing: `BOOT-FAILED` classification.

3. **Detect AudioContext failures:**
   - Search sync log for `NotAllowedError`, `audio resume failed`,
     `audio-silent`, `AUDIO-DEATH` within the first 300 frames.
   - If found: `AUDIO-CONTEXT-BLOCKED` classification with the
     specific error and frame number.

4. **Detect input starvation at boot:**
   - From input analysis (section 8c): if total non-zero input
     percentage is 0% AND frames < 200 AND any `TAB-FOCUS lost`
     event exists in the first 60 frames:
   - Classify as `INPUT-STARVED-AT-BOOT` with the frame range and
     focus state.

5. **Classify pre-match disconnects:**
   - If `meta.ended_by == 'disconnect'` AND `meta.frames < 200`:
   - Classify as `PRE-MATCH-DISCONNECT` instead of generic
     disconnect.
   - Include boot funnel stage reached and inferred failure point.

6. **Output a structured summary:**

```
=== 8f. BOOT FUNNEL ANALYSIS ===

Boot timeline:
  room_created       → +0.0s
  peer_joined        → +1.2s
  rom_loaded         → +2.8s  (both slots)
  webrtc_connected   → +4.1s  (both slots)
  server_game_started → +5.3s
  first_frame_rendered → +7.8s  [SLOW: 2.5s since game_started]
  emulator_booted    → +27.3s  [BOOT-SLOW: 22.0s since game_started]

Boot classification: BOOT-SLOW (22.0s)
Audio status: AUDIO-CONTEXT-BLOCKED (NotAllowedError at f=10)
Input status: INPUT-STARVED-AT-BOOT (0% active, TAB-FOCUS lost at f=10)
Session class: PRE-MATCH-DISCONNECT (69 frames, never reached gameplay)

Root cause inference:
  Tab lost focus during boot → AudioContext blocked →
  gamepad input zeroed → boot convergence stalled at 1fps →
  disconnected after 61s with no gameplay.
```

### Classification taxonomy

The analyzer should assign exactly one top-level classification to
sessions with boot issues:

| Classification | Criteria |
|---|---|
| `PRE-GAMEPLAY-FAILURE` | `emulator_booted` event missing |
| `AUDIO-CONTEXT-BLOCKED` | `NotAllowedError` or `audio resume failed` in first 300 frames |
| `INPUT-STARVED-AT-BOOT` | 0% non-zero input AND `TAB-FOCUS lost` in first 60 frames AND frames < 200 |
| `BOOT-TIMEOUT` | `emulator_booted` timestamp - `server_game_started` timestamp > 30s |
| `BOOT-SLOW` | same delta > 10s but <= 30s |
| `PRE-MATCH-DISCONNECT` | `ended_by=disconnect` AND frames < 200 |
| `BOOT-OK` | none of the above |

Multiple classifications can co-occur (e.g., `AUDIO-CONTEXT-BLOCKED`
+ `INPUT-STARVED-AT-BOOT` + `PRE-MATCH-DISCONNECT` for Session 1).
The root-cause inference section should chain them into a causal
narrative.

---

## Summary table

| # | Finding | File:Line | Class |
|---|---------|-----------|-------|
| BF1 | AudioContext activation failure (silent audio death) | `netplay-lockstep.js:2159-2167`, `play.js:139`, `netplay-lockstep.js:3754` | MUST FIX |
| BF2 | Gamepad input starvation on tab focus loss | `shared.js:415-424`, `netplay-lockstep.js:5697-5704` | MUST FIX |
| BF3 | Gesture-gated AudioContext stalls emulator at frame 6 | `netplay-lockstep.js:3730-3777`, `play.js:131-153` | SHOULD FIX |
| BF4 | Boot convergence excessive duration | `netplay-lockstep.js:6316-6379` | SHOULD FIX |
| BF5 | EmulatorJS boot hangs with no error | `play.js:2185-2201`, `core-redirector.js:53-67` | MUST FIX |
| BF6 | No visibility-aware AudioContext recovery | `netplay-lockstep.js:5631-5690` | MUST FIX |
| BF7 | Socket.IO initial connection has no timeout | `play.js:230-231` | SHOULD FIX |
| BF8 | `feedAudio()` ignores AudioContext state | `netplay-lockstep.js:2185-2187` | SHOULD FIX |

## Implementation order

1. **BF1 + BF6** (audio death) — highest impact, root cause of
   Session 1. Fix AudioContext resume-on-visibility, diagnostic
   logging, and user-facing toast.
2. **BF5** (EJS boot hang) — root cause of Session 2. Add timeout
   to `_knCoreReady` and surface loader errors.
3. **BF2** (input starvation) — second factor in Session 1.
   Background-tab detection and fast-forward on visibility return.
4. **BF4** (boot convergence duration) — reduce 300→120 frames,
   skip convergence when hidden.
5. **BF3** (gesture-while-hidden) — defer audio init when hidden.
6. **BF7** (socket timeout) — simple 10-second timeout toast.
7. **BF8** (feedAudio state check) — covered by BF1 fix.
8. **Analyzer** — add `query_boot_funnel()` section.

## Coordination with existing specs

- BF4's boot convergence is referenced in the deadlock-audit spec
  as A4 (`BOOT-LOCKSTEP` stall). The deadlock spec's 3-second
  recovery timeout remains; this spec adds visibility-aware
  fast-forward on TOP of that recovery.
- BF1/BF6 audio fixes do not interact with rollback integrity
  (RF1-RF7) — audio is a presentation concern, not a state-sync
  concern.
- The analyzer's new `query_boot_funnel()` section uses the same
  `client_events` table as the existing `query_session_lifecycle()`
  section (8b). No schema changes needed.
