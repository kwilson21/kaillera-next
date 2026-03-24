# WASM Core Determinism Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Achieve cross-browser WASM determinism by removing `-ffast-math`, fixing RNG seeds, and canonicalizing NaN in the mupen64plus-next core.

**Architecture:** A single new patch file (`mupen64plus-wasm-determinism.patch`) applies three changes to the mupen64plus-libretro-nx source: strict IEEE 754 compiler flags, deterministic RNG seeds, and NaN canonicalization in the FPU stubs. `build.sh` is updated to apply it after the existing timing patch.

**Tech Stack:** C, Emscripten/WASM, git diff (unified patch format), Docker, Playwright (verification)

**Spec:** `docs/superpowers/specs/2026-03-23-wasm-determinism-design.md`

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `build/patches/mupen64plus-wasm-determinism.patch` | Create | Unified diff targeting 6 files in mupen64plus-libretro-nx |
| `build/build.sh` | Modify (lines 53-59) | Add new patch application after existing timing patch |

The patch itself modifies (inside the mupen64plus-libretro-nx source tree, applied at build time):
- `Makefile` — replace `-ffast-math` with strict IEEE 754 flags for emscripten
- `mupen64plus-core/src/device/r4300/r4300_core.c` — deterministic RNG seed
- `mupen64plus-core/src/device/r4300/fpu.h` — NaN canonicalization in empty stubs
- `GLideN64/src/uCodes/F5Indi_Naboo.cpp` — deterministic RNG seed
- `GLideN64/src/GraphicsDrawer.cpp` — deterministic RNG seed
- `mupen64plus-core/subprojects/minizip/crypt.h` — deterministic RNG seed

---

## Chunk 1: Branch Setup and Patch Creation

### Task 1: Create feature branch

- [ ] **Step 1: Create and switch to the wasm-determinism branch**

```bash
cd /Users/kazon/kaillera-next
git checkout -b wasm-determinism
```

- [ ] **Step 2: Verify branch**

```bash
git branch --show-current
```
Expected: `wasm-determinism`

---

### Task 2: Create the determinism patch

The patch is a unified diff applied by `git apply` during the Docker build. We generate it by making changes to the source tree and capturing the diff.

**Files:**
- Create: `build/patches/mupen64plus-wasm-determinism.patch`

- [ ] **Step 1: Make the Makefile change — replace `-ffast-math` for emscripten**

In `build/src/mupen64plus-libretro-nx/Makefile`, replace line 631:

```
   CPUOPTS += -DNDEBUG -fsigned-char -ffast-math -fno-strict-aliasing -fomit-frame-pointer -fvisibility=hidden
```

With:

```
ifeq ($(platform), emscripten)
   # kaillera-next: strict IEEE 754 for cross-engine WASM determinism.
   # Removes -ffast-math to ensure Clang emits spec-compliant WASM FP opcodes.
   # -ffp-contract=off prevents FMA fusion (different rounding than separate mul+add).
   # -ftrivial-auto-var-init=zero eliminates UB from uninitialized stack variables.
   CPUOPTS += -DNDEBUG -fsigned-char -fno-fast-math -ffp-contract=off \
              -fno-associative-math -fno-reciprocal-math \
              -fno-strict-aliasing -fomit-frame-pointer -fvisibility=hidden \
              -ftrivial-auto-var-init=zero
else
   CPUOPTS += -DNDEBUG -fsigned-char -ffast-math -fno-strict-aliasing -fomit-frame-pointer -fvisibility=hidden
endif
```

Note: This replaces the single line inside the `else` block of the `ifeq ($(DEBUG), 1)` check. The `ifeq ($(platform), emscripten)` / `else` / `endif` must be nested inside the existing `else` (non-debug) block. Line 632 (`ifneq ($(platform), libnx)`) and line 633 (`CPUOPTS := -O3 $(CPUOPTS)`) remain unchanged after our new `endif`.

- [ ] **Step 2: Make the r4300_core.c change — deterministic RNG seed**

In `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/device/r4300/r4300_core.c`, replace line 67:

```c
    srand((unsigned int) time(NULL));
```

With:

```c
#ifdef __EMSCRIPTEN__
    srand(0); /* kaillera-next: deterministic seed for cross-instance sync */
#else
    srand((unsigned int) time(NULL));
#endif
```

- [ ] **Step 3: Make the fpu.h change — NaN canonicalization**

In `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/device/r4300/fpu.h`:

First, add `#include <string.h>` after line 26 (`#include <stdint.h>`). This is required because `memcpy` is used in the NaN canonicalization, and `pure_interp.c` includes `fpu.h` without its own `<string.h>` include.

Then replace the empty stubs at lines 225-231:

```c
M64P_FPU_INLINE void fpu_check_output_float(uint32_t* fcr31, const float* value)
{
}

M64P_FPU_INLINE void fpu_check_output_double(uint32_t* fcr31, const double* value)
{
}
```

With:

```c
M64P_FPU_INLINE void fpu_check_output_float(uint32_t* fcr31, const float* value)
{
#ifdef __EMSCRIPTEN__
    /* kaillera-next: canonicalize NaN for cross-engine WASM determinism.
     * The WASM spec allows non-deterministic NaN payloads. Force all NaN
     * values to the MIPS R4300i canonical quiet NaN (0x7FC00000). */
    if (isnan(*value))
    {
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

Note: `fpu.h` already includes `<math.h>` (line 25) and `<stdint.h>` (line 26) providing `isnan()`, `uint32_t`, and `uint64_t`.

- [ ] **Step 4: Make the F5Indi_Naboo.cpp change — deterministic RNG seed**

In `build/src/mupen64plus-libretro-nx/GLideN64/src/uCodes/F5Indi_Naboo.cpp`, replace line 2332:

```c
	srand((unsigned int)time(NULL));
```

With:

```c
#ifdef __EMSCRIPTEN__
	srand(0);
#else
	srand((unsigned int)time(NULL));
#endif
```

Note: This file uses tabs for indentation.

- [ ] **Step 5: Make the GraphicsDrawer.cpp change — deterministic RNG seed**

In `build/src/mupen64plus-libretro-nx/GLideN64/src/GraphicsDrawer.cpp`, replace line 1828:

```c
	srand(static_cast<u32>(time(nullptr)));
```

With:

```c
#ifdef __EMSCRIPTEN__
	srand(0);
#else
	srand(static_cast<u32>(time(nullptr)));
#endif
```

Note: This file uses C++ `time(nullptr)` not `time(NULL)`. The patch must match the exact source text.

- [ ] **Step 6: Make the minizip/crypt.h change — deterministic RNG seed**

In `build/src/mupen64plus-libretro-nx/mupen64plus-core/subprojects/minizip/crypt.h`, replace line 109:

```c
        srand((unsigned)(time(NULL) ^ ZCR_SEED2));
```

With:

```c
#ifdef __EMSCRIPTEN__
        srand(0);
#else
        srand((unsigned)(time(NULL) ^ ZCR_SEED2));
#endif
```

- [ ] **Step 7: Generate the patch from the working tree diff**

```bash
cd /Users/kazon/kaillera-next/build/src/mupen64plus-libretro-nx
git diff > /Users/kazon/kaillera-next/build/patches/mupen64plus-wasm-determinism.patch
```

- [ ] **Step 8: Verify patch file is non-empty and contains all 6 files**

```bash
grep '^diff --git' /Users/kazon/kaillera-next/build/patches/mupen64plus-wasm-determinism.patch
```

Expected: 6 `diff --git` lines for:
- `Makefile`
- `mupen64plus-core/src/device/r4300/r4300_core.c`
- `mupen64plus-core/src/device/r4300/fpu.h`
- `GLideN64/src/uCodes/F5Indi_Naboo.cpp`
- `GLideN64/src/GraphicsDrawer.cpp`
- `mupen64plus-core/subprojects/minizip/crypt.h`

- [ ] **Step 9: Reset the source tree (build.sh applies patches from scratch)**

```bash
cd /Users/kazon/kaillera-next/build/src/mupen64plus-libretro-nx
git checkout -- .
```

- [ ] **Step 10: Verify patch applies cleanly**

```bash
cd /Users/kazon/kaillera-next/build/src/mupen64plus-libretro-nx
git apply --check /Users/kazon/kaillera-next/build/patches/mupen64plus-wasm-determinism.patch
```

Expected: No output (clean apply). Then reset again:

```bash
git checkout -- .
```

- [ ] **Step 11: Commit the patch file**

```bash
cd /Users/kazon/kaillera-next
git add build/patches/mupen64plus-wasm-determinism.patch
git commit -m "feat: add WASM determinism patch (strict IEEE 754, RNG seeds, NaN canon)"
```

---

### Task 3: Update build.sh to apply the new patch

**Files:**
- Modify: `build/build.sh` (lines 53-59)

- [ ] **Step 1: Add new patch application after the existing mupen64plus patch**

In `build/build.sh`, after the existing mupen64plus-deterministic-timing.patch block (line 59), add a new block that applies the determinism patch. The key constraint: do NOT add another `git checkout -- .` before it — both patches must apply cumulatively to the same source tree.

Replace lines 53-59:

```bash
    if [ -f "${PATCHES_DIR}/mupen64plus-deterministic-timing.patch" ]; then
        cd "${SRC_DIR}/mupen64plus-libretro-nx"
        git checkout -- . 2>/dev/null || true
        git apply "${PATCHES_DIR}/mupen64plus-deterministic-timing.patch" && \
            echo "    Applied mupen64plus patch" || \
            echo "    mupen64plus patch already applied or failed"
    fi
```

With:

```bash
    if [ -f "${PATCHES_DIR}/mupen64plus-deterministic-timing.patch" ] || \
       [ -f "${PATCHES_DIR}/mupen64plus-wasm-determinism.patch" ]; then
        cd "${SRC_DIR}/mupen64plus-libretro-nx"
        git checkout -- . 2>/dev/null || true
    fi

    if [ -f "${PATCHES_DIR}/mupen64plus-deterministic-timing.patch" ]; then
        cd "${SRC_DIR}/mupen64plus-libretro-nx"
        git apply "${PATCHES_DIR}/mupen64plus-deterministic-timing.patch" && \
            echo "    Applied mupen64plus timing patch" || \
            echo "    mupen64plus timing patch already applied or failed"
    fi

    if [ -f "${PATCHES_DIR}/mupen64plus-wasm-determinism.patch" ]; then
        cd "${SRC_DIR}/mupen64plus-libretro-nx"
        git apply "${PATCHES_DIR}/mupen64plus-wasm-determinism.patch" && \
            echo "    Applied mupen64plus determinism patch" || \
            echo "    mupen64plus determinism patch already applied or failed"
    fi
```

This separates the `git checkout -- .` reset from the patch applications, ensuring both patches apply in sequence to a clean source tree.

- [ ] **Step 2: Verify build.sh syntax**

```bash
bash -n /Users/kazon/kaillera-next/build/build.sh
```

Expected: No output (valid syntax).

- [ ] **Step 3: Commit build.sh change**

```bash
cd /Users/kazon/kaillera-next
git add build/build.sh
git commit -m "build: apply WASM determinism patch in build.sh"
```

---

## Chunk 2: Build, Deploy, and Verify

### Task 4: Build the deterministic WASM core

This requires the Docker image `emulatorjs-builder:latest`. The build takes ~10-20 minutes.

- [ ] **Step 1: Verify Docker image exists**

```bash
docker image ls emulatorjs-builder
```

Expected: Shows the `emulatorjs-builder:latest` image (~2 GB).

If missing, build it:
```bash
cd /Users/kazon/kaillera-next/build
docker build -t emulatorjs-builder .
```

- [ ] **Step 2: Run the Docker build**

```bash
cd /Users/kazon/kaillera-next
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash -c "cd /build/src/RetroArch && emmake make -f Makefile.emulatorjs clean; bash /build/build.sh"
```

Expected: Build completes with `BUILD COMPLETE` message. Watch for:
- "Applied mupen64plus timing patch" — existing patch
- "Applied mupen64plus determinism patch" — our new patch
- `.bc file` size (should be similar to before, ~30-50MB)
- `.wasm` file produced

If the build fails with `memcpy` undeclared in fpu.h, add `#include <string.h>` to the fpu.h patch (see Task 2 Step 3 note).

- [ ] **Step 3: Verify output**

```bash
ls -lh /Users/kazon/kaillera-next/build/output/mupen64plus_next-wasm.data
```

Expected: File exists, similar size to previous build (~15-25MB compressed).

- [ ] **Step 4: Deploy to web static**

```bash
cp /Users/kazon/kaillera-next/build/output/mupen64plus_next-wasm.data \
   /Users/kazon/kaillera-next/web/static/ejs/cores/
```

- [ ] **Step 5: Commit the built core**

```bash
cd /Users/kazon/kaillera-next
git add web/static/ejs/cores/mupen64plus_next-wasm.data
git commit -m "build: deploy deterministic WASM core (strict IEEE 754)"
```

---

### Task 5: Verify — same-engine baseline (Chrome ↔ Chrome)

This confirms the deterministic core doesn't break existing same-engine sync. The user manages the dev server — do NOT start or stop it.

- [ ] **Step 1: Open two Chrome tabs to the game page**

Using Playwright MCP, navigate two browser instances (both Chromium) to the kaillera-next play page. Load SSB64 ROM, create a room, join with second instance.

- [ ] **Step 2: Start a VS mode match**

Navigate both instances to VS mode (character select → stage select → match). Use `_simulate_input()` to feed identical inputs to both.

- [ ] **Step 3: Compare RDRAM hashes**

In each browser console, read the VS mode volatile RDRAM regions and hash them:

```javascript
// Get RDRAM pointer
const mod = window.EJS_emulator.Module;
const memInfo = mod.cwrap('get_memory_data', 'string', ['string'])('RETRO_MEMORY_SYSTEM_RAM');
const [size, ptr] = memInfo.split('|').map(Number);
const rdram = new Uint8Array(mod.HEAPU8.buffer, ptr, size);

// Hash volatile regions
const regions = [[0xA4000, 0xA5000], [0xBA000, 0xC7000], [0x262000, 0x26C000], [0x32B000, 0x335000]];
let hash = 0;
for (const [start, end] of regions) {
    for (let i = start; i < end; i++) hash = (hash * 31 + rdram[i]) | 0;
}
console.log('RDRAM hash:', hash);
```

- [ ] **Step 4: Verify hashes match**

Expected: Both instances produce identical hash values on every check. 15+ consecutive matches = PASS.

---

### Task 6: Verify — cross-engine (Chrome ↔ Firefox)

This is the critical test. If this passes, the design goal is achieved.

- [ ] **Step 1: Open one Chromium and one Firefox instance**

Using Playwright MCP with `browserName: 'chromium'` and `browserName: 'firefox'`, navigate both to the play page with the same SSB64 ROM.

- [ ] **Step 2: Start a VS mode match with identical inputs**

Same procedure as Task 5 Step 2.

- [ ] **Step 3: Compare RDRAM hashes across engines**

Same hash code as Task 5 Step 3, run in both browser consoles.

- [ ] **Step 4: Verify hashes match**

Expected: Chromium and Firefox produce identical RDRAM hashes. 60+ consecutive matches = PASS.

If FAIL: Note which frame diverges first and which RDRAM region diverges. This diagnostic narrows the remaining non-determinism source. Possible next steps:
- Add `-fno-tree-vectorize` to disable SIMD auto-vectorization
- Check if the diverging region is framebuffer-related (GPU readback)
- Binary search: disable patches one at a time to isolate which fix matters most

- [ ] **Step 5: Final commit with verification notes**

If verification passes:
```bash
cd /Users/kazon/kaillera-next
git commit --allow-empty -m "verify: cross-browser RDRAM determinism confirmed (Chrome↔Firefox)"
```
