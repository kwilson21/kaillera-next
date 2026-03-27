# Emulator Hibernate — Design Spec

## Problem

EmulatorJS/Emscripten's `Browser.mainLoop` state corrupts when instances are destroyed and recreated. On the 3rd instance, `retro_run` never executes — `EJS_PAUSED` and `Browser.mainLoop.running` persist stale values. This prevents mode switching (lockstep → lobby → streaming) without a full page reload.

## Solution

Keep the WASM module alive between games instead of destroying and recreating EmulatorJS instances. On game end, hibernate the emulator (pause, mute, hide). On game start, wake it (resume, unmute, show).

## Changes

### 1. `hibernateEmulator()` — new function in play.js

Called by `onGameEnded()` instead of `destroyEmulator()`. Adds a `_hibernated` flag.

```
- Always call Module.pauseMainLoop() to establish a known paused state
  (stopSync leaves main loop in limbo — rAF restored but no callback scheduled)
- Suspend (not close) OpenAL AudioContexts
- Suspend (not close) SDL2 AudioContext (gm.Module.SDL2.audioContext)
- Hide the #game div contents via display:none
- Set _hibernated = true
- Do NOT destroy DOM, do NOT delete window.EJS_emulator
- Do NOT revoke the ROM blob URL
```

Key detail: `stopSync()` restores native rAF but never resumes the Emscripten main loop. The loop was paused by `enterManualMode()` (line 2326) and the runner was captured, not scheduled. So after `engine.stop()`, the main loop is in limbo — not paused, not running. `hibernateEmulator()` calls `pauseMainLoop()` to establish a deterministic paused state so `resumeMainLoop()` on wake reliably schedules a fresh rAF callback.

### 2. `wakeEmulator()` — new function in play.js

Called by `initEngine()` when `_hibernated` is true.

```
- Clear EJS_PAUSED: Module._toggleMainLoop(1)
- Resume Emscripten main loop: Module.resumeMainLoop()
  (from deterministic paused state → schedules fresh rAF callback)
- Restore native resume() on OpenAL AudioContexts (undo lockstep's monkey-patch)
- Call audioCtx.resume() to unsuspend them
- Resume SDL2 AudioContext if suspended
- Show the #game div contents
- Set _hibernated = false
```

Ordering matters: audio must be restored BEFORE `engine.init()` runs, so streaming's `captureEmulatorAudio()` finds live, unsuspended contexts.

The restore pattern already exists in `destroyEmulator()` (play.js:1594):
```javascript
const proto = AudioContext.prototype;
ctx.audioCtx.resume = proto.resume;
ctx.audioCtx.resume();  // unsuspend instead of .close()
```

### 3. Modify `onGameEnded()` in play.js

```
Before: engine.stop() → destroyEmulator()
After:  engine.stop() → hibernateEmulator()
```

`destroyEmulator()` is kept but only called on page unload. (Currently `onRoomClosed()` redirects to `/` without calling it — no change needed there.)

### 4. Modify `initEngine()` in play.js

```
Before: always calls bootEmulator()
After:  if _hibernated → wakeEmulator()
         else → bootEmulator() (first game only)
```

### 5. ROM change guard

If the ROM hash changes between games (e.g., player loads a different ROM), hibernate can't be used — the WASM core is running the old ROM. In that case, fall back to full `destroyEmulator()` + `bootEmulator()`.

```
if _hibernated && _romHash !== previousRomHash → destroyEmulator() + bootEmulator()
```

### 6. Fix cache-state 400 bug (opportunistic, not required for hibernate)

The ROM hash is prefixed with `S` (SHA-256) or `F` (FNV-1a) by `hashArrayBuffer()` (play.js:1850), making it 65 chars. The server's `_validate_rom_hash()` expects exactly 64 hex chars.

Fix: strip the algorithm prefix before sending to `/api/cache-state/` and `/api/cached-state/` endpoints. Keep the prefix for peer comparison (where the algorithm tag serves a purpose).

## Mode Transition Flows

### First game (any mode)
```
bootEmulator() → EJS instance created → engine.init() → game plays
```

### Game end
```
engine.stop() → hibernateEmulator()
  lockstep stop: stopSync() restores rAF, leaves main loop in limbo
  streaming stop: clears host stream, intervals, peers
  hibernate: pauseMainLoop() (→ known paused state), suspends audio, hides div
→ back to lobby overlay
```

### Subsequent game (same ROM)
```
wakeEmulator()
  → toggleMainLoop(1)  [clears EJS_PAUSED]
  → resumeMainLoop()   [schedules fresh rAF from paused state]
  → restore + resume OpenAL/SDL2 audio
  → show div
→ engine.init() → game plays
  lockstep: enterManualMode() pauses main loop again + captures runner → works
  streaming host: emulator is free-running, canvas alive → captureStream works
  streaming guest: doesn't use local emulator (receives video stream)
```

### Subsequent game (different ROM)
```
destroyEmulator() → bootEmulator() → engine.init() → game plays
```

## Why Each Step Works

| Step | Mechanism | Evidence |
|---|---|---|
| Establish paused state | `Module.pauseMainLoop()` in hibernate | Guarantees `resumeMainLoop()` schedules a fresh callback instead of no-op |
| Resume main loop | `Module.resumeMainLoop()` in wake | Standard Emscripten API, used by `enterManualMode()` line 2335 |
| Clear EJS_PAUSED | `Module._toggleMainLoop(1)` | Exported in Makefile.emulatorjs, sets `EJS_PAUSED = false` (retroarch.c:6264) |
| Restore audio | Restore native `resume()` from prototype, call it | Pattern exists in `destroyEmulator()` play.js:1594 |
| Lockstep after wake | `enterManualMode()` pauses + overrides rAF + resumes to capture runner | Requires emulator to be running — wake restores this |
| Streaming after wake | Canvas still in DOM, emulator free-running, audio contexts live | `startHost()` waits for frame count > 10, `captureEmulatorAudio()` finds live context |

## What's NOT Changing

- `bootEmulator()` — unchanged, still used for first game
- `destroyEmulator()` — unchanged, retained for ROM changes and page cleanup
- Lockstep engine (`netplay-lockstep.js`) — no changes needed (its own `_audioCtx` is separate from OpenAL, created fresh each lockstep session)
- Streaming engine (`netplay-streaming.js`) — no changes needed
- Server — no changes (cache-state fix is client-side prefix strip)
- WASM core / RetroArch — no changes needed

## Risks

- **Memory**: WASM heap (~50MB) stays allocated between games. Acceptable for a game-focused page; avoids 120-frame re-boot.
- **Stale EJS UI**: The EmulatorJS overlay/loading UI inside the game div. Mitigation: game was already running when we hibernate, so loading overlay is already hidden. Verify during testing.
- **Audio context limits**: By reusing (not closing) contexts, we stay under browser limits.
- **Double APISandbox.restoreAll()**: Lockstep's `stop()` calls it at line 3739 after `stopSync()` already called it at line 2658. Harmless (restore is idempotent) but worth knowing during debugging.
