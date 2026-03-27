# Emulator Hibernate Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the WASM module alive between games to fix the 3rd-instance Emscripten main loop corruption bug.

**Architecture:** Replace `destroyEmulator()` calls in the game-end flow with a new `hibernateEmulator()` that pauses/hides the emulator. On game restart, `wakeEmulator()` resumes it instead of creating a new instance. Cache-state 400 bug fixed as an opportunistic side fix.

**Tech Stack:** Vanilla JS (IIFE + window globals), EmulatorJS, Emscripten WASM

**Spec:** `docs/superpowers/specs/2026-03-27-emulator-hibernate-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `web/static/play.js` | Modify | Add `hibernateEmulator()`, `wakeEmulator()`, `_hibernated` flag; modify `onGameEnded()` and `initEngine()` |
| `web/static/netplay-lockstep.js` | Modify | Strip ROM hash prefix in `fetchCachedState()` and `sendInitialState()` |

No new files. No server changes. No engine changes beyond the hash strip.

---

## Task 1: Add `_hibernated` flag and `_hibernatedRomHash`

**Files:**
- Modify: `web/static/play.js:17-30` (state declarations)

- [ ] **Step 1: Add state variables**

After the existing state declarations (around line 30, near `_romHash`), add:

```javascript
let _hibernated = false;    // true when emulator is hibernated between games
let _hibernatedRomHash = null; // ROM hash at time of hibernate (detect ROM changes)
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "feat(hibernate): add _hibernated state flag"
```

---

## Task 2: Implement `hibernateEmulator()`

**Files:**
- Modify: `web/static/play.js` — add new function after `destroyEmulator()` (after line 1624)

- [ ] **Step 1: Write `hibernateEmulator()`**

Add after the closing `};` of `destroyEmulator()` (line 1624):

```javascript
const hibernateEmulator = () => {
  const emu = window.EJS_emulator;
  if (!emu) return;
  console.log('[play] hibernateEmulator: pausing + hiding');

  const mod = emu.gameManager?.Module;
  if (mod) {
    // Establish a known paused state. stopSync() restores native rAF but
    // never resumes the Emscripten main loop — it's left in limbo (not
    // paused, not running). Calling pauseMainLoop() here guarantees that
    // resumeMainLoop() in wakeEmulator() will schedule a fresh rAF callback.
    try { mod.pauseMainLoop(); } catch (_) {}

    // Suspend (not close) OpenAL AudioContexts — lockstep monkey-patches
    // resume() to a no-op, so just suspend without touching resume here.
    // wakeEmulator() will restore native resume() and call it.
    if (mod.AL?.contexts) {
      for (const ctx of Object.values(mod.AL.contexts)) {
        if (ctx?.audioCtx && ctx.audioCtx.state !== 'closed') {
          try { ctx.audioCtx.suspend(); } catch (_) {}
        }
      }
    }

    // Suspend SDL2 AudioContext if present
    if (mod.SDL2?.audioContext && mod.SDL2.audioContext.state !== 'closed') {
      try { mod.SDL2.audioContext.suspend(); } catch (_) {}
    }
  }

  // Hide the game div contents
  const gameEl = document.getElementById('game');
  if (gameEl) gameEl.style.display = 'none';

  _hibernated = true;
  _hibernatedRomHash = _romHash;
};
```

- [ ] **Step 2: Verify no syntax errors**

Open the browser, load the page, confirm no console errors on load.

- [ ] **Step 3: Commit**

```bash
git add web/static/play.js
git commit -m "feat(hibernate): implement hibernateEmulator()"
```

---

## Task 3: Implement `wakeEmulator()`

**Files:**
- Modify: `web/static/play.js` — add new function after `hibernateEmulator()`

- [ ] **Step 1: Write `wakeEmulator()`**

Add after `hibernateEmulator()`:

```javascript
const wakeEmulator = () => {
  const emu = window.EJS_emulator;
  if (!emu) return;
  console.log('[play] wakeEmulator: resuming + showing');

  const mod = emu.gameManager?.Module;
  if (mod) {
    // Clear EJS_PAUSED C flag — without this, emscripten_mainloop() bails
    // at the top (retroarch.c:6126) and retro_run never executes.
    if (mod._toggleMainLoop) mod._toggleMainLoop(1);

    // Resume main loop from the known paused state set by hibernateEmulator().
    // This schedules a fresh rAF callback in Browser.mainLoop.
    try { mod.resumeMainLoop(); } catch (_) {}

    // Restore OpenAL AudioContexts — undo lockstep's resume() monkey-patch
    // and unsuspend them so streaming's captureEmulatorAudio() finds live contexts.
    const proto = AudioContext.prototype || webkitAudioContext.prototype;
    if (mod.AL?.contexts) {
      for (const ctx of Object.values(mod.AL.contexts)) {
        if (ctx?.audioCtx && ctx.audioCtx.state !== 'closed') {
          try {
            if (proto.resume) ctx.audioCtx.resume = proto.resume;
            ctx.audioCtx.resume();
          } catch (_) {}
        }
      }
    }

    // Resume SDL2 AudioContext if present
    if (mod.SDL2?.audioContext && mod.SDL2.audioContext.state !== 'closed') {
      try { mod.SDL2.audioContext.resume(); } catch (_) {}
    }
  }

  // Show the game div
  const gameEl = document.getElementById('game');
  if (gameEl) gameEl.style.display = '';

  _hibernated = false;
  _hibernatedRomHash = null;
};
```

- [ ] **Step 2: Verify no syntax errors**

Open the browser, load the page, confirm no console errors on load.

- [ ] **Step 3: Commit**

```bash
git add web/static/play.js
git commit -m "feat(hibernate): implement wakeEmulator()"
```

---

## Task 4: Wire up `onGameEnded()` to hibernate

**Files:**
- Modify: `web/static/play.js:653-691` (`onGameEnded` function)

- [ ] **Step 1: Replace `destroyEmulator()` with `hibernateEmulator()`**

In `onGameEnded()`, change line 671 from:

```javascript
    destroyEmulator();
```

to:

```javascript
    hibernateEmulator();
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "feat(hibernate): onGameEnded uses hibernate instead of destroy"
```

---

## Task 5: Wire up `initEngine()` to wake

**Files:**
- Modify: `web/static/play.js:1951-1967` (`initEngine` function)

- [ ] **Step 1: Add hibernate-aware boot logic**

In `initEngine()`, replace the block at lines 1962-1967:

```javascript
    const needsEmulator = !isSpectator && !(mode === 'streaming' && !isHost);
    if (needsEmulator && (_romBlob || _romBlobUrl)) {
      bootEmulator();
    } else {
      console.log('[play] initEngine: connect-only mode (spectator or no ROM)');
    }
```

with:

```javascript
    const needsEmulator = !isSpectator && !(mode === 'streaming' && !isHost);
    if (needsEmulator && (_romBlob || _romBlobUrl)) {
      if (_hibernated && _hibernatedRomHash === _romHash) {
        wakeEmulator();
      } else {
        if (_hibernated) {
          // ROM changed — can't reuse hibernated emulator
          console.log('[play] initEngine: ROM changed, full restart');
          destroyEmulator();
          _hibernated = false;
          _hibernatedRomHash = null;
        }
        bootEmulator();
      }
    } else {
      console.log('[play] initEngine: connect-only mode (spectator or no ROM)');
    }
```

- [ ] **Step 2: Commit**

```bash
git add web/static/play.js
git commit -m "feat(hibernate): initEngine wakes hibernated emulator or boots fresh"
```

---

## Task 6: Fix cache-state 400 bug

**Files:**
- Modify: `web/static/netplay-lockstep.js:1996-1997` (`fetchCachedState`)
- Modify: `web/static/netplay-lockstep.js:2059-2061` (`sendInitialState`)

The ROM hash is prefixed with `S` (SHA-256) or `F` (FNV-1a) by `hashArrayBuffer()`. The server expects exactly 64 hex chars. Strip the prefix for API calls. FNV hashes (16 hex chars after strip) will still fail server validation — this is fine since FNV only occurs on LAN over plain HTTP where caching isn't needed.

- [ ] **Step 1: Add a hash-strip helper at the top of the lockstep IIFE**

After the `_debugLog` setup IIFE closing (line 220), add:

```javascript
  // Strip algorithm prefix (S=SHA-256, F=FNV-1a) from ROM hash for server API.
  // Peer comparison keeps the prefix to detect algorithm mismatches.
  // FNV hashes (16 chars) will still fail server validation — LAN-only, no cache needed.
  const apiRomHash = (hash) => hash?.replace(/^[SF]/, '') ?? null;
```

- [ ] **Step 2: Use `apiRomHash()` in `fetchCachedState`**

At line 1997, change:

```javascript
    const url = `/api/cached-state/${encodeURIComponent(romHash)}`;
```

to:

```javascript
    const url = `/api/cached-state/${encodeURIComponent(apiRomHash(romHash))}`;
```

- [ ] **Step 3: Use `apiRomHash()` in `sendInitialState`**

At line 2061, change:

```javascript
        await fetch(`/api/cache-state/${encodeURIComponent(romHash)}`, {
```

to:

```javascript
        await fetch(`/api/cache-state/${encodeURIComponent(apiRomHash(romHash))}`, {
```

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "fix: strip hash prefix for cache-state API (fixes 400 error)"
```

---

## Task 7: Manual integration test

No automated tests — this requires a real browser with EmulatorJS and a ROM. Per project feedback, tests are kept to the critical path only.

- [ ] **Step 1: Test lockstep → lobby → lockstep (same mode restart)**

1. Open two browser tabs, create a room, both join
2. Host starts lockstep game, play a few seconds
3. Host ends game → verify emulator hibernates (game div hides, no destroy log)
4. Host starts lockstep again → verify emulator wakes (`[play] wakeEmulator` in console)
5. Verify game plays normally (frames advance, inputs work)

- [ ] **Step 2: Test lockstep → lobby → streaming (mode switch)**

1. Same setup as above
2. Host starts lockstep, plays, ends game
3. Host selects streaming mode, starts game
4. Verify host sees running game, guest receives video stream
5. Verify audio works on both sides

- [ ] **Step 3: Test streaming → lobby → lockstep (reverse mode switch)**

1. Same but start with streaming, switch to lockstep
2. Verify lockstep sync completes and inputs work

- [ ] **Step 4: Test 3+ game cycles (the original bug)**

1. Start and end 3+ games in sequence without page reload
2. Verify no stall on 3rd or subsequent games
3. Check console for `retro_run` execution (frame count increments)

- [ ] **Step 5: Test cache-state fix**

1. Start a lockstep game with a ROM loaded
2. Check network tab: `/api/cache-state/` POST should return 200 (not 400)
3. On restart, `/api/cached-state/` GET should return the cached state
