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

Add `_kn_set_headless` to `EXPORTED_FUNCTIONS` in `Makefile.emulatorjs`.

Patch delivered as `build/patches/mupen64plus-headless-tick.patch`, following existing patch naming convention.

### 2. JS Benchmark Function

Expose `window.knBenchmarkHeadless(n)` in `play.js`. Default `n = 100`.

**Steps:**
1. Verify game is running (emulator exists, lockstep active)
2. Pause the lockstep loop (prevent contention for `retro_run()`)
3. Call `Module._kn_set_headless(1)`
4. Run `Module._retro_run()` N times in a synchronous `for` loop, timed with `performance.now()`
5. Call `Module._kn_set_headless(0)`
6. Resume the lockstep loop
7. Log results: total ms, avg ms/frame, N frames, pass/fail vs 4ms target

The benchmark runs synchronously on the main thread. With video skipped, there is no `requestAnimationFrame` involvement. 100 frames at worst case (~16ms each) = 1.6s, well under tab-kill thresholds.

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
| `build/src/RetroArch/Makefile.emulatorjs` | Add `_kn_set_headless` to EXPORTED_FUNCTIONS |
| `build/build.sh` | Apply new patch in stage 2 |
| `web/static/play.js` | Add `window.knBenchmarkHeadless(n)` function |
