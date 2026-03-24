# WASM Core Determinism for Cross-Browser Lockstep Netplay

**Date:** 2026-03-23
**Status:** Approved
**Branch:** `wasm-determinism` (new, off `mvp-p0-implementation`)

## Goal

Achieve bit-perfect RDRAM determinism in the mupen64plus-next WASM core across all browser engines (V8/Chrome, SpiderMonkey/Firefox, JSC/Safari). Two emulator instances receiving identical inputs must produce identical RDRAM state every frame, regardless of engine.

If achieved, the resync mechanism becomes unnecessary — the lockstep protocol already guarantees identical inputs.

## Background

- P0↔P1 (same Chrome, same machine): **perfect sync** — 15+ consecutive hash matches
- P2 (iPhone Firefox, ARM): **drifts every ~25 seconds** despite identical inputs
- Existing patches: deterministic timing (`_kn_set_deterministic`), audio bypass, input interception
- The WASM spec guarantees IEEE 754 determinism for basic FP operations — but only if the C compiler emits strict IEEE 754 code

## Root Cause Analysis

### 1. `-ffast-math` in core build (PRIMARY)

The mupen64plus Makefile line 631 sets:
```
CPUOPTS += -DNDEBUG -fsigned-char -ffast-math -fno-strict-aliasing -fomit-frame-pointer -fvisibility=hidden
```

`-ffast-math` implies `-ffinite-math-only`, `-fno-signed-zeros`, `-fassociative-math`, `-freciprocal-math`, `-fno-trapping-math`, `-fno-math-errno`. These permit Emscripten's Clang to emit WASM instructions that differ from what strict IEEE 754 compilation would produce — e.g., fusing `a*b+c` into a single `fma` (one rounding instead of two), reordering additions (non-associative in IEEE 754), or replacing divisions with reciprocal multiplies. The resulting WASM binary is the same for all engines, but the instruction sequences may trigger the WASM spec's NaN non-determinism clause more readily, or produce numerically different intermediate values that accumulate drift over time.

The fix is to remove `-ffast-math`, ensuring Clang emits only the strict-IEEE 754 subset of WASM FP instructions, where cross-engine determinism is guaranteed by spec.

### 2. RNG seeded with wall-clock time

Four `srand(time(NULL))` calls produce different random sequences per instance:
- `mupen64plus-core/src/device/r4300/r4300_core.c:67` — CPU init (affects global `rand()` state)
- `GLideN64/src/uCodes/F5Indi_Naboo.cpp:2332` — Star Wars uCode (not SSB64, but should still be fixed)
- `GLideN64/src/GraphicsDrawer.cpp:1828` — graphics buffer clearing
- `mupen64plus-core/subprojects/minizip/crypt.h:109` — ZIP decompression (may re-seed after r4300 init)

Note: `srand(0)` is sufficient for cross-instance determinism because all WASM instances run the same musl libc `rand()` implementation compiled into the same binary. The determinism comes from identical binary + identical seed.

### 3. NaN bit pattern non-determinism

The WASM spec explicitly allows non-deterministic NaN payloads for both scalar and SIMD FP operations. When a FP operation produces NaN, different engines may produce different bit patterns (sign, quiet/signaling, payload). The existing `fpu_check_output_float`/`fpu_check_output_double` functions are **empty stubs** in the libretro build (the `ACCURATE_FPU_BEHAVIOR` define is not set), so no NaN detection or canonicalization occurs.

### 4. Uninitialized stack variables

At `-O3`, Clang may exploit undefined behavior from uninitialized variable reads, producing unpredictable codegen. WASM locals are zero-initialized by spec, but the C compiler's UB exploitation happens before WASM codegen.

### Additional `time(NULL)` call sites (documented, not patched)

These use `time(NULL)` but are not relevant to SSB64 game state:
- `mupen64plus-core/src/backends/clock_ctime_plus_delta.c:33` — N64 RTC backend. SSB64 does not read the RTC. Would need patching for RTC-dependent games.
- `mupen64plus-core/src/device/controllers/paks/biopak.c:57` — Bio Sensor pak (Tetris 64 only).

Pre-existing safeguard: `main.c:1428` sets `mpk_seed = !netplay_is_init() ? time(NULL) : 0`, so rumble pak ID is already deterministic in netplay.

## Design

### Patch 1: Strict IEEE 754 compiler flags

**File:** New patch `build/patches/mupen64plus-wasm-determinism.patch`
**Target:** `mupen64plus-libretro-nx/Makefile`

For `platform=emscripten` only, replace the CPUOPTS line (631) with strict flags. Note: line 633 uses `:=` assignment (`CPUOPTS := -O3 $(CPUOPTS)`), which reconstructs the variable. The replacement must target line 631 (the `+=` line) so the flags are included when line 633 evaluates.

```makefile
ifeq ($(platform), emscripten)
   # kaillera-next: strict IEEE 754 for cross-engine WASM determinism
   CPUOPTS += -DNDEBUG -fsigned-char -fno-fast-math -ffp-contract=off \
              -fno-associative-math -fno-reciprocal-math \
              -fno-strict-aliasing -fomit-frame-pointer -fvisibility=hidden \
              -ftrivial-auto-var-init=zero
else
   CPUOPTS += -DNDEBUG -fsigned-char -ffast-math -fno-strict-aliasing \
              -fomit-frame-pointer -fvisibility=hidden
endif
```

Key flags:
- `-fno-fast-math` — disable all unsafe FP optimizations
- `-ffp-contract=off` — prevent FMA fusion (single rounding vs. double rounding changes results)
- `-fno-associative-math` — prevent FP reordering (explicit, belt-and-suspenders with `-fno-fast-math`)
- `-fno-reciprocal-math` — prevent `a/b` → `a * (1/b)` transformation
- `-ftrivial-auto-var-init=zero` — zero all stack variables, eliminating UB from uninitialized reads

Retained flags (don't affect FP determinism):
- `-O3` — optimization level (applied separately at line 633 via `:=`)
- `-fno-strict-aliasing` — memory aliasing rules
- `-fomit-frame-pointer` — stack frame optimization
- `-fvisibility=hidden` — symbol visibility
- `-msimd128` — WASM SIMD (set at line 562, retained for performance). Note: WASM SIMD FP operations share the same NaN non-determinism as scalar ops per spec; the NaN canonicalization in Patch 3 covers the N64 FPU path but not auto-vectorized C code. This is acceptable because auto-vectorized paths are primarily in GLideN64 rendering, which does not affect the hashed RDRAM regions.

### Patch 2: Deterministic RNG seeds

**File:** Same patch file, targeting four source files.

Replace `srand(time(NULL))` with `srand(0)` under `#ifdef __EMSCRIPTEN__`:

```c
#ifdef __EMSCRIPTEN__
    srand(0);
#else
    srand((unsigned int) time(NULL));
#endif
```

Applied to:
- `mupen64plus-core/src/device/r4300/r4300_core.c:67`
- `GLideN64/src/uCodes/F5Indi_Naboo.cpp:2332`
- `GLideN64/src/GraphicsDrawer.cpp:1828`
- `mupen64plus-core/subprojects/minizip/crypt.h:109` — must be patched because it may execute after the r4300 init, re-poisoning the global `rand()` state

### Patch 3: NaN canonicalization in FPU

**File:** Same patch file, targeting `mupen64plus-core/src/device/r4300/fpu.h`

**Critical:** `ACCURATE_FPU_BEHAVIOR` is NOT defined in the libretro/emscripten build. The `fpu_check_output_float` (line 225) and `fpu_check_output_double` (line 229) functions are **empty stubs** in the `#else` branch. The NaN canonicalization must be added to these stubs, not to the `#ifdef ACCURATE_FPU_BEHAVIOR` branch.

Modify the empty stubs (lines 225-231) to add NaN canonicalization:

```c
M64P_FPU_INLINE void fpu_check_output_float(uint32_t* fcr31, const float* value)
{
#ifdef __EMSCRIPTEN__
    if (isnan(*value))
    {
        /* Canonicalize NaN for cross-engine WASM determinism.
         * MIPS R4300i canonical quiet NaN. */
        static const uint32_t canon_nan_f = 0x7FC00000;
        memcpy((void*)value, &canon_nan_f, sizeof(float));
    }
#endif
}

M64P_FPU_INLINE void fpu_check_output_double(uint32_t* fcr31, const double* value)
{
#ifdef __EMSCRIPTEN__
    if (isnan(*value))
    {
        static const uint64_t canon_nan_d = 0x7FF8000000000000ULL;
        memcpy((void*)value, &canon_nan_d, sizeof(double));
    }
#endif
}
```

This covers all N64 FPU operations since every one calls `fpu_check_output_*`. Runtime cost is effectively zero — the `isnan()` check compiles to a single WASM FP comparison, and the canonicalization branch almost never fires in normal game math.

**Known limitation:** NaN canonicalization only covers the N64 R4300i FPU emulation path. C-level FP math outside fpu.h (RSP HLE audio, GLideN64 rendering) is NOT canonicalized. This is acceptable because those code paths primarily affect rendering output, not the RDRAM game-state regions that are hashed for desync detection.

## Known Emulation Caveats

- **`fesetround()` is a no-op in WASM.** The N64's FPU supports four rounding modes (nearest, zero, up, down) via FCR31. The `set_rounding()` function in fpu.h calls `fesetround()`, but WASM does not expose rounding mode control — all FP operations use round-to-nearest-even. This means N64 games that set non-default rounding modes get incorrect results. This is **deterministic across browsers** (all will behave the same wrong way), so it does not break cross-browser sync, but it is an emulation accuracy limitation.

## Architecture: Dual Core

The deterministic core is a separate build artifact from the stock CDN core. The existing `core-redirector.js` already handles core selection at load time. No changes needed to the loading path.

- **Stock CDN core:** single-player, maximum performance (`-ffast-math`)
- **Deterministic core:** netplay, strict IEEE 754 (this design)

The netplay code already calls `_kn_set_deterministic(1)` at game start. Core selection happens before that, at ROM load time.

## Build Changes

All patches go in a single new file: `build/patches/mupen64plus-wasm-determinism.patch`

The existing `build.sh` applies patches from `build/patches/` — it will pick up the new patch automatically. No changes to `build.sh` needed. The patch targets `mupen64plus-libretro-nx` (same repo as the existing `mupen64plus-deterministic-timing.patch`).

## Verification

### Test matrix

| Config | Current | Expected |
|---|---|---|
| Chrome ↔ Chrome | PASS (15+ syncs) | PASS |
| Chrome ↔ Firefox | FAIL (drifts ~25s) | PASS |
| Chrome ↔ Safari/WebKit | Unknown | PASS |

### Test procedure

1. Load SSB64 in two Playwright browser instances (different engines)
2. Navigate to VS mode match (same character, same stage)
3. Feed identical inputs via `_simulate_input()`
4. Compare RDRAM hashes at volatile regions every N frames
5. **Pass criterion:** 60+ consecutive hash matches with zero divergence

### Volatile RDRAM regions (VS mode, previously verified)

- `0xA4000` — player/match config
- `0xBA000-0xC7000` — player state
- `0x262000-0x26C000` — physics/animation
- `0x32B000-0x335000` — physics/animation

## What this design does NOT change

- The lockstep protocol
- The RDRAM region map
- The desync detection JS code
- The resync mechanism (stays as fallback)
- The stock CDN core or single-player behavior
- RetroArch frontend compilation flags (only mupen64plus core is patched)

## Risk

- **Performance:** 5-15% FP regression in the core. Imperceptible on desktop. TBD on mobile — if too slow, the fallback plan is to split compilation so GLideN64 rendering retains `-ffast-math` (it doesn't affect hashed RDRAM regions) while core CPU/memory simulation stays strict.
- **NaN edge cases:** If NaN canonicalization changes game behavior (e.g., a game relies on specific NaN payloads), it could cause incorrect emulation. Unlikely for SSB64.
- **Incomplete coverage:** If non-determinism comes from outside the core (e.g., JS timing, browser event ordering), these patches won't help. The existing deterministic timing patches should cover this, but we verify empirically.
- **SIMD auto-vectorization:** `-msimd128 -ftree-vectorize` may auto-vectorize C-level FP loops outside fpu.h. These SIMD FP operations share NaN non-determinism per WASM spec. Acceptable because auto-vectorized paths are primarily rendering, not game state. If verification fails, consider adding `-fno-tree-vectorize` as a further tightening step.
