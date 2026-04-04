# Headless Tick Benchmark — Design Spec

**Date:** 2026-04-04
**Goal:** Determine if GGPO-style rollback is viable in WASM by measuring raw emulation speed without rendering.

## Context

Rollback netplay requires replaying N frames (typically 2-6) within a single 16ms frame budget. The emulator currently runs at ~1 frame per 16ms including rendering. If we can skip rendering during replay, the CPU-only tick time determines whether rollback fits in budget.

**Decision thresholds:**
- **< 4ms/frame**: Rollback viable on desktop. 4 replay frames fit in 16ms.
- **4-8ms/frame**: Marginal. Only 1-2 frame predictions (LAN only).
- **> 8ms/frame**: Rollback not viable in WASM. Desktop-native-only in v2.

## Design

### 1. C-Level Patch: `kn_set_headless`

Add a global flag and export to `libretro.c`:

```c
int kn_headless = 0;

EMSCRIPTEN_KEEPALIVE void kn_set_headless(int enable) {
    kn_headless = enable;
}
```

In `retro_run()`, wrap the GL bind/unbind and `video_cb()` blocks so they are skipped when headless:

```c
void retro_run(void) {
    libretro_swap_buffer = false;

    // ... variable update check (stays) ...

    #ifdef __EMSCRIPTEN__
    if (!kn_headless) {
    #endif
        if (current_rdp_type == RDP_PLUGIN_GLIDEN64) {
            // GL bind + thread launch
        }
    #ifdef __EMSCRIPTEN__
    }
    #endif

    co_switch(game_thread);  // CPU emulation — always runs

    #ifdef __EMSCRIPTEN__
    if (!kn_headless) {
    #endif
        // GL unbind + video_cb() — entire block skipped in headless
    #ifdef __EMSCRIPTEN__
    }
    #endif
}
```

**Skipped in headless mode:**
- GL state bind/unbind (`glsm_ctl`)
- GLideN64 threaded renderer launch
- `video_cb()` call (no frame sent to frontend)

**Not skipped:**
- `co_switch(game_thread)` — CPU emulation runs normally
- Audio capture — cheap (buffer copy, no syscalls), not worth skipping

Add `_kn_set_headless` to the existing `EXPORTED_FUNCTIONS` list in `Makefile.emulatorjs` (line 137, alongside other `kn_` exports). This is a direct edit to the already-patched file, not a separate patch.

The C patch is delivered as `build/patches/mupen64plus-headless-tick.patch`, targeting `libretro.c`. Applied in stage 2 of `build.sh` alongside other mupen64plus patches.

**Note on `retro_run()` guard placement:** The actual function (libretro.c:2042-2097) has three distinct blocks: GL bind (lines 2050-2062), GL unbind (lines 2066-2069), and video_cb + frame duping (lines 2071-2097). The headless guard wraps all three blocks — see actual source for exact placement.

### 2. JS Benchmark Function

Expose `window.knBenchmarkHeadless(n)` inside the lockstep engine (`netplay-lockstep.js`). Default `n = 100`.

**Frame stepping mechanism:** The lockstep engine captures RetroArch's MainLoop_runner callback via a `requestAnimationFrame` override (see `_pendingRunner` at line 516). Each call to `_pendingRunner(frameTimeMs)` executes one full RetroArch runloop iteration (which calls `retro_run()` internally), then RetroArch re-registers via rAF, which the override captures as a new `_pendingRunner`. This is the same mechanism `stepOneFrame()` uses. `retro_run` is not directly exported and cannot be called from JS.

**Assumption:** The `_pendingRunner` → `retro_run()` → rAF re-capture cycle is synchronous within a single JS turn. This is confirmed by the existing lockstep engine calling `stepOneFrame()` in tight loops (e.g., catch-up frames) without yielding.

**Steps:**
1. Verify game is running (emulator exists, `_manualMode` active, `_pendingRunner` captured)
2. Pause the lockstep tick interval (`clearInterval` on the tick timer, save the ID for restore)
3. Call `Module._kn_set_headless(1)`
4. Run N frames in a synchronous `for` loop: each iteration calls `_pendingRunner(frameTimeMs)`, which re-captures the next runner via the rAF override. Timed with `performance.now()`.
5. Call `Module._kn_set_headless(0)`
6. Restore the lockstep tick interval
7. Log results to console: total ms, avg ms/frame, N frames, pass/fail vs 4ms target

The function lives inside the lockstep IIFE (has access to `_pendingRunner` and tick interval internals) and is exposed via `window.knBenchmarkHeadless`.

### 3. What This Does NOT Include

This is a benchmark only. Future work if the benchmark passes:
- State snapshot ring buffer (per-frame RDRAM snapshots)
- Input prediction logic
- Rollback netcode mode (new mode alongside lockstep)
- Platform matching in lobby (same-platform enforcement)
- Delta compression for snapshots

## Files Changed

| File | Change |
|------|--------|
| `build/patches/mupen64plus-headless-tick.patch` | New patch: `kn_headless` flag + `retro_run()` guards |
| `build/src/RetroArch/Makefile.emulatorjs` | Add `_kn_set_headless` to existing EXPORTED_FUNCTIONS line |
| `build/build.sh` | Apply new patch in stage 2 (mupen64plus section) |
| `web/static/netplay-lockstep.js` | Add `window.knBenchmarkHeadless(n)` inside lockstep IIFE |
