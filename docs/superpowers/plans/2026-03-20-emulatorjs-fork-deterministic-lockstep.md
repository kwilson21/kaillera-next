# EmulatorJS Fork: Deterministic Lockstep Netplay

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork and rebuild the EmulatorJS N64 core (mupen64plus_next) with C-level modifications that eliminate netplay desyncs by making frame execution fully deterministic.

**Architecture:** The WASM core is rebuilt from C source with three changes: (1) deterministic timing — all clock reads return frame-counted values instead of wall-clock time, (2) deterministic audio — the audio backend counts frames instead of reading AudioContext.currentTime, (3) input synchronization hooks — exported C functions that our JS lockstep engine calls to block/unblock input. The modified core is self-hosted and loaded via our existing core-redirector.

**Tech Stack:** Emscripten SDK 3.1.74, Docker (linux/amd64), mupen64plus-libretro-nx (C), RetroArch EmulatorJS fork (C/Makefile), 7z packaging, our existing lockstep-v4 JS engine.

---

## Root Cause Analysis (from prior debugging sessions)

### What we know

1. **Input delivery is correct** — zero mismatches across 50+ frames verified via Playwright
2. **Both emulators receive identical inputs on identical frames** — confirmed
3. **States diverge within ~12 frames** — even from identical starting state
4. **21 bytes differ in save state at frame 300** — CPU GP registers ($at, $s1, $gp, $ra) and related fields
5. **`_emscripten_get_now` was patched in JS glue code** — returns deterministic frame-counted time during stepping. Confirmed working (0 `performance.now()` calls during `_kn_inStep=true`)
6. **Desyncs persist despite JS-level timing patch** — because other timing sources exist inside the WASM binary that can't be intercepted from JavaScript

### Why JS-level patches are insufficient

| Timing source | Patchable from JS? | Notes |
|---|---|---|
| `_emscripten_get_now` (perf.now) | Yes — patched, working | Returns deterministic time via `window._kn_inStep` check |
| `clock_time_get` (WASI) | Yes — calls `_emscripten_get_now` internally | Fixed by the above patch |
| `_emscripten_date_now` | Yes — patched | Fixed |
| `AudioContext.currentTime` | **No** | OpenAL reads this internally; property override doesn't propagate to WASM imports bound at instantiation |
| Web Audio `ScriptProcessor.onaudioprocess` callback | **No** | Fires asynchronously between frame steps; reads real time; writes to WASM heap |
| `emscripten_get_now()` C function (compiled into WASM) | **No** | Some internal Emscripten runtime code calls this directly via the WASM-side implementation, bypassing the JS import |
| WASM-internal `call_indirect` to timing functions | **No** | Function table entries are bound at compile time |

**The only reliable fix is to modify the C source code and rebuild the WASM binary.**

### How Kaillera solved this (reference: Project64k-Core-2.2)

In Project64k, `modifyPlayValues()` is called from `CN64System::RefreshScreen()` — the VI interrupt handler that fires once per frame. It:

1. Reads local controller input (`GetKeys(0, &Keys)`)
2. Calls `kailleraModifyPlayValues(&Keys)` — **blocks the CPU thread** until the server returns all players' inputs
3. Stores all players' inputs in `m_Buttons[]`
4. The N64 game reads these via PIF RAM commands

The emulator physically cannot advance without all players' input. Audio timing is irrelevant because:
- N64 audio is driven by CPU cycle counts (deterministic), not wall-clock time
- The audio plugin just plays whatever samples the deterministic emulation produces
- `SyncToAudio()` is overridden by the network pacing (the blocking call naturally limits frame rate)

**Our approach adapts this for Emscripten/WASM:** instead of blocking a thread (impossible in single-threaded WASM), we make ALL timing reads return deterministic values compiled into the binary, and make audio frame-counted rather than real-time-counted.

---

## Chunk 1: Build Environment Setup

### Task 1: Set up Docker build environment

**Files:**
- Create: `build/Dockerfile`
- Create: `build/build.sh`

The EmulatorJS docs warn: "Some cores do not compile on ARM based systems (such as M series MacBooks)." mupen64plus_next requires `binutils-mips-linux-gnu` for RSP microcode. Docker with `--platform linux/amd64` is required on Apple Silicon.

- [ ] **Step 1: Create the Dockerfile**

```dockerfile
# build/Dockerfile
FROM --platform=linux/amd64 debian:bookworm

RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    python3 \
    wget \
    curl \
    p7zip-full \
    binutils-mips-linux-gnu \
    pkgconf \
    jq \
    zip \
    && rm -rf /var/lib/apt/lists/*

# Install Emscripten SDK 3.1.74 (pinned to match EmulatorJS)
RUN git clone https://github.com/emscripten-core/emsdk.git /opt/emsdk \
    && cd /opt/emsdk \
    && ./emsdk install 3.1.74 \
    && ./emsdk activate 3.1.74

# Activate emsdk in all shells
ENV PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:/opt/emsdk/node/18.20.3_64bit/bin:${PATH}"
ENV EMSDK=/opt/emsdk
ENV EM_CONFIG=/opt/emsdk/.emscripten

WORKDIR /build
```

- [ ] **Step 2: Build the Docker image**

Run: `docker build --platform linux/amd64 -t emulatorjs-builder build/`
Expected: Image builds successfully (takes ~10 minutes for Emscripten SDK download)

- [ ] **Step 3: Verify Emscripten works inside the container**

Run: `docker run --rm emulatorjs-builder emcc --version`
Expected: Output includes `emcc (Emscripten gcc/clang-like replacement + linker emulating GNU ld) 3.1.74`

- [ ] **Step 4: Commit**

```bash
git add build/Dockerfile
git commit -m "build: add Docker environment for EmulatorJS core compilation"
```

### Task 2: Clone source repositories

**Files:**
- Create: `build/build.sh`

We need three repos:
1. `EmulatorJS/mupen64plus-libretro-nx` — the N64 core (our fork target)
2. `EmulatorJS/RetroArch` (branch `next`) — the linker that produces .js + .wasm
3. We do NOT need EmulatorJS/build — we'll call the Makefiles directly

- [ ] **Step 1: Create the build script**

```bash
#!/bin/bash
# build/build.sh — Build the patched mupen64plus_next core for EmulatorJS
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="${SCRIPT_DIR}/src"
OUT_DIR="${SCRIPT_DIR}/output"

mkdir -p "${SRC_DIR}" "${OUT_DIR}"

# Clone repos if not present
if [ ! -d "${SRC_DIR}/mupen64plus-libretro-nx" ]; then
    echo "==> Cloning mupen64plus-libretro-nx..."
    git clone --depth 1 https://github.com/EmulatorJS/mupen64plus-libretro-nx.git \
        "${SRC_DIR}/mupen64plus-libretro-nx"
fi

if [ ! -d "${SRC_DIR}/RetroArch" ]; then
    echo "==> Cloning RetroArch (EmulatorJS fork, branch next)..."
    git clone --depth 1 -b next https://github.com/EmulatorJS/RetroArch.git \
        "${SRC_DIR}/RetroArch"
fi

echo "==> Source repos ready in ${SRC_DIR}"
```

- [ ] **Step 2: Run the clone step**

Run: `docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash /build/build.sh`
Expected: Both repos cloned into `build/src/`

- [ ] **Step 3: Commit**

```bash
echo "build/src/" >> .gitignore
echo "build/output/" >> .gitignore
git add build/build.sh .gitignore
git commit -m "build: add core build script with repo cloning"
```

### Task 3: Verify unmodified build works

**Files:**
- Modify: `build/build.sh`

Before making changes, verify the stock build produces a working core.

- [ ] **Step 1: Add compile steps to build.sh**

Append to `build/build.sh`:

```bash
echo "==> Stage 1: Compile core to LLVM bitcode (.bc)"
cd "${SRC_DIR}/mupen64plus-libretro-nx"
emmake make -j$(nproc) -f Makefile platform=emscripten clean
emmake make -j$(nproc) -f Makefile platform=emscripten

BC_FILE="${SRC_DIR}/mupen64plus-libretro-nx/mupen64plus_next_libretro_emscripten.bc"
if [ ! -f "${BC_FILE}" ]; then
    echo "ERROR: .bc file not produced"
    exit 1
fi
echo "==> .bc file: $(ls -lh ${BC_FILE})"

echo "==> Stage 2: Link through RetroArch -> .js + .wasm"
cp "${BC_FILE}" "${SRC_DIR}/RetroArch/emulatorjs/"
cd "${SRC_DIR}/RetroArch"

# Build with WebGL2 (defaultWebGL2: true for mupen64plus_next)
emmake make -f Makefile.emulatorjs \
    HAVE_OPENGLES3=1 \
    TARGET=mupen64plus_next_libretro.js \
    -j$(nproc)

JS_FILE="${SRC_DIR}/RetroArch/mupen64plus_next_libretro.js"
WASM_FILE="${SRC_DIR}/RetroArch/mupen64plus_next_libretro.wasm"

if [ ! -f "${JS_FILE}" ] || [ ! -f "${WASM_FILE}" ]; then
    echo "ERROR: .js or .wasm not produced"
    exit 1
fi
echo "==> JS glue: $(ls -lh ${JS_FILE})"
echo "==> WASM:    $(ls -lh ${WASM_FILE})"

echo "==> Stage 3: Package into 7z .data archive"
cd "${OUT_DIR}"

# Create core.json (metadata for EmulatorJS)
cat > core.json << 'COREJSON'
{
    "extensions": ["n64", "v64", "z64", "bin", "u1", "ndd", "gb"],
    "options": { "defaultWebGL2": true },
    "save": "srm"
}
COREJSON

cp "${JS_FILE}" .
cp "${WASM_FILE}" .
echo '{"version":"kaillera-next-custom"}' > build.json
echo "GPL-3.0" > license.txt

7z a -t7z mupen64plus_next-wasm.data \
    mupen64plus_next_libretro.js \
    mupen64plus_next_libretro.wasm \
    core.json build.json license.txt

echo "==> Output: $(ls -lh ${OUT_DIR}/mupen64plus_next-wasm.data)"
echo "==> BUILD COMPLETE"
```

- [ ] **Step 2: Run the full build**

Run: `docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash /build/build.sh`
Expected: `mupen64plus_next-wasm.data` produced in `build/output/` (should be ~1.4MB)

Note: This will take 10-30 minutes depending on CPU. The Emscripten compile is CPU-intensive.

- [ ] **Step 3: Test the stock build in our project**

```bash
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
```

Run the existing desync test to confirm baseline behavior matches the CDN core:
```bash
python -m pytest tests/test_desync.py::test_lockstep_no_desync -v -s
```
Expected: Same desync pattern as before (confirms our build matches the stock core)

- [ ] **Step 4: Commit**

```bash
git add build/build.sh
git commit -m "build: complete EmulatorJS core build pipeline (unmodified baseline)"
```

---

## Chunk 2: Deterministic Timing (C-Level Patch)

### Why this is needed

The WASM binary calls `emscripten_get_now()` internally for timing decisions. Our JS-level patch intercepts the imported function, but some internal Emscripten runtime code and the OpenAL audio system read `AudioContext.currentTime` through paths that bypass our patch. By modifying the C source, we ensure ALL timing reads inside the binary return deterministic values.

### Task 4: Patch Emscripten timing in RetroArch's platform layer

**Files:**
- Modify: `build/src/RetroArch/frontend/drivers/platform_emulatorjs.c`
- Modify: `build/src/RetroArch/Makefile.emulatorjs`

The EmulatorJS RetroArch fork has a custom platform driver (`platform_emulatorjs.c`) that handles the Emscripten-specific runtime. We add a global frame counter that replaces all `emscripten_get_now()` calls.

- [ ] **Step 1: Add deterministic timing globals to platform_emulatorjs.c**

Add near the top of the file:

```c
/* kaillera-next: Deterministic timing for lockstep netplay.
 * When kn_deterministic_mode is non-zero, all emscripten_get_now() calls
 * return kn_frame_time_ms instead of real wall-clock time.
 * The JS lockstep engine sets these before each frame step. */
int kn_deterministic_mode = 0;
double kn_frame_time_ms = 0.0;

/* Called by JS lockstep engine before each frame step */
EMSCRIPTEN_KEEPALIVE void kn_set_frame_time(double time_ms) {
    kn_frame_time_ms = time_ms;
}

EMSCRIPTEN_KEEPALIVE void kn_set_deterministic(int enable) {
    kn_deterministic_mode = enable;
}
```

- [ ] **Step 2: Create a timing wrapper header**

Create: `build/src/RetroArch/emulatorjs/kn_timing.h`

```c
#ifndef KN_TIMING_H
#define KN_TIMING_H

#include <emscripten.h>

extern int kn_deterministic_mode;
extern double kn_frame_time_ms;

/* Drop-in replacement for emscripten_get_now().
 * In deterministic mode, returns frame-counted time.
 * In normal mode, returns real wall-clock time. */
static inline double kn_get_now(void) {
    if (kn_deterministic_mode)
        return kn_frame_time_ms;
    return emscripten_get_now();
}

#endif /* KN_TIMING_H */
```

- [ ] **Step 3: Replace timing calls in RetroArch's Emscripten code**

Search for all `emscripten_get_now()` calls in the RetroArch platform and audio code:

```bash
grep -rn "emscripten_get_now" frontend/drivers/ audio/drivers/ --include="*.c" --include="*.h"
```

Replace each call with `kn_get_now()`, adding `#include "emulatorjs/kn_timing.h"` to each modified file.

Key files to check:
- `frontend/drivers/platform_emulatorjs.c` — main platform driver
- `audio/drivers/rwebaudio.c` — web audio driver (if used)
- Any Emscripten-specific sleep/timing code

- [ ] **Step 4: Export the new functions in Makefile.emulatorjs**

Add to the `EXPORTED_FUNCTIONS` list in `Makefile.emulatorjs`:

```makefile
'_kn_set_frame_time', \
'_kn_set_deterministic', \
```

- [ ] **Step 5: Rebuild and verify compilation**

Run: `docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash /build/build.sh`
Expected: Build succeeds, .data file produced

- [ ] **Step 6: Commit**

```bash
git add build/
git commit -m "feat: deterministic timing patch in RetroArch platform layer"
```

### Task 5: Patch the mupen64plus core's timing

**Files:**
- Modify: `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/util.c`
- Modify: `build/src/mupen64plus-libretro-nx/libretro/libretro.c`

The N64 core itself has timing calls for the count-per-op calculation and speed limiting. These need to use our deterministic time too.

- [ ] **Step 1: Find all timing calls in the core**

```bash
grep -rn "emscripten_get_now\|gettimeofday\|clock_gettime\|time(" \
    build/src/mupen64plus-libretro-nx/ --include="*.c" --include="*.h" | \
    grep -v ".git/"
```

- [ ] **Step 2: Wrap core timing calls**

For each timing call found in the core source, wrap it with our deterministic check. The approach depends on what's found — it may be `gettimeofday()`, `clock_gettime()`, or direct `emscripten_get_now()` calls.

Add to each file that calls timing functions:

```c
#ifdef __EMSCRIPTEN__
extern int kn_deterministic_mode;
extern double kn_frame_time_ms;
#endif
```

And wrap the timing reads:

```c
#ifdef __EMSCRIPTEN__
if (kn_deterministic_mode) {
    /* Use deterministic frame time */
    tv->tv_sec = (time_t)(kn_frame_time_ms / 1000.0);
    tv->tv_usec = (suseconds_t)((kn_frame_time_ms - tv->tv_sec * 1000.0) * 1000.0);
} else
#endif
{
    gettimeofday(tv, NULL);
}
```

- [ ] **Step 3: Rebuild and verify**

Run: `docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash /build/build.sh`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add build/
git commit -m "feat: deterministic timing in mupen64plus N64 core"
```

---

## Chunk 3: Deterministic Audio

### Why this is needed

Emscripten's OpenAL implementation uses `AudioContext.currentTime` to schedule audio buffer playback. This real-time value feeds back into buffer availability calculations, which can cause the emulator to make different decisions about audio DMA timing. In the N64, audio DMA is driven by CPU cycle counts (deterministic), but the audio OUTPUT driver's buffer management can indirectly affect when interrupts are serviced.

### Task 6: Make the audio backend frame-counted

**Files:**
- Modify: `build/src/RetroArch/audio/drivers/rwebaudio.c` (if this is the active driver)
- OR modify the OpenAL integration in the Emscripten glue

The goal: during deterministic mode, the audio driver should:
1. Accept all audio samples without blocking
2. Not read `AudioContext.currentTime` for buffer scheduling
3. Optionally still output audio (for the player to hear) but never let audio timing feed back into emulation

- [ ] **Step 1: Identify the active audio driver**

```bash
grep -rn "audio_driver\|HAVE_RWEBAUDIO\|HAVE_AUDIOWORKLET\|openal\|AL_" \
    build/src/RetroArch/Makefile.emulatorjs \
    build/src/RetroArch/audio/drivers/ --include="*.c" --include="*.h" | head -30
```

Check `Makefile.emulatorjs` for which audio backend is selected (`-lopenal`, `HAVE_RWEBAUDIO`, etc.)

- [ ] **Step 2: Patch the audio driver**

If using OpenAL (most likely — `-lopenal` in the linker flags):

The Emscripten OpenAL implementation lives in `emsdk/upstream/emscripten/src/library_openal.js`. This is linked as a JS library. We can't easily modify it, but we can:

**Option A:** Intercept at the RetroArch level. In `audio/audio_driver.c`, the `audio_driver_flush()` function calculates available buffer space. In deterministic mode, always report maximum buffer space available (never block waiting for audio drain):

```c
#ifdef __EMSCRIPTEN__
#include "emulatorjs/kn_timing.h"
#endif

static void audio_driver_flush(...)
{
#ifdef __EMSCRIPTEN__
    if (kn_deterministic_mode) {
        /* Always accept all samples — don't let audio buffer state
         * affect emulation timing. Samples still get queued for playback
         * but we never block waiting for buffer space. */
        /* Write samples to output, ignore write_avail */
        audio_driver_write_output(buf, size);
        return;
    }
#endif
    /* ... original logic ... */
}
```

**Option B:** Build with `EMSCRIPTEN_AUDIO_FAKE_BLOCK=1`. This makes the audio backend use main loop timing instead of real-time audio callbacks. Check if this option exists in Makefile.emulatorjs:

```bash
grep -n "AUDIO_FAKE_BLOCK\|AUDIO_EXTERNAL_BLOCK\|AUDIO_ASYNC_BLOCK" \
    build/src/RetroArch/Makefile.emulatorjs
```

If `EMSCRIPTEN_AUDIO_FAKE_BLOCK` is available, simply building with it enabled may be sufficient.

- [ ] **Step 3: Rebuild and verify**

Run: `docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash /build/build.sh`
Expected: Build succeeds, core loads in browser, game audio works (or is silent — acceptable for lockstep)

- [ ] **Step 4: Commit**

```bash
git add build/
git commit -m "feat: deterministic audio backend for lockstep netplay"
```

---

## Chunk 4: JS Lockstep Engine Integration

### Task 7: Update the lockstep engine to use C-level timing controls

**Files:**
- Modify: `web/static/netplay-lockstep-v4.js`
- Modify: `web/static/core-redirector.js`

Instead of setting `window._kn_inStep` and relying on the JS glue code patch, call the exported C functions directly.

- [ ] **Step 1: Update stepOneFrame() to use C exports**

Replace the current timing patch in `stepOneFrame()`:

```javascript
function stepOneFrame() {
    if (!_pendingRunner) return false;
    var runner = _pendingRunner;
    _pendingRunner = null;

    var mod = window.EJS_emulator.gameManager.Module;
    var frameTimeMs = (_frameNum + 1) * 16.666666666666668;

    // Use C-level deterministic timing (compiled into the WASM binary)
    if (mod._kn_set_deterministic && mod._kn_set_frame_time) {
        mod._kn_set_deterministic(1);
        mod._kn_set_frame_time(frameTimeMs);
    } else {
        // Fallback: JS-level patch (for non-forked cores)
        window._kn_inStep = true;
        window._kn_frameTime = frameTimeMs;
    }

    runner(frameTimeMs);

    if (mod._kn_set_deterministic) {
        mod._kn_set_deterministic(0);
    } else {
        window._kn_inStep = false;
    }

    _origRAF.call(window, function () {});
    return true;
}
```

- [ ] **Step 2: Update startLockstep() initialization**

Add detection of the forked core:

```javascript
function startLockstep() {
    if (_running) return;
    _running = true;

    // Detect forked core with C-level timing
    var mod = window.EJS_emulator.gameManager.Module;
    _hasForkedCore = !!(mod._kn_set_deterministic && mod._kn_set_frame_time);
    if (_hasForkedCore) {
        console.log('[lockstep-v4] forked core detected — using C-level deterministic timing');
    } else {
        console.log('[lockstep-v4] stock core — using JS-level timing patch (fallback)');
    }

    // ... rest of existing startLockstep() ...
}
```

- [ ] **Step 3: Simplify core-redirector.js**

With the forked core, the JS glue code doesn't need patching. The core-redirector only needs to redirect the download:

```javascript
(function() {
    'use strict';
    var params = new URLSearchParams(window.location.search);
    var mode = params.get('mode') || 'lockstep-v4';
    if (mode !== 'lockstep-v4') return;

    window._kn_usePatchedCore = true;
    console.log('[core-redirector] Lockstep mode: loading forked core');

    var CORE_FILENAME = 'mupen64plus_next-wasm.data';
    var LOCAL_CORE_URL = '/static/ejs/cores/' + CORE_FILENAME;

    // Clear EmulatorJS IDB cache
    if (indexedDB.databases) {
        indexedDB.databases().then(function(dbs) {
            dbs.forEach(function(db) {
                if (db.name && (db.name.indexOf('emulator') !== -1 ||
                    db.name.indexOf('EJS') !== -1 || db.name.indexOf('ejs') !== -1 ||
                    db.name.indexOf('/data/') !== -1)) {
                    indexedDB.deleteDatabase(db.name);
                }
            });
        });
    }

    // Intercept fetch/XHR
    var origFetch = window.fetch;
    window.fetch = function(url, opts) {
        var u = typeof url === 'string' ? url : (url && url.url ? url.url : '');
        if (u.indexOf(CORE_FILENAME) !== -1) {
            console.log('[core-redirector] Redirecting core to:', LOCAL_CORE_URL);
            return origFetch.call(this, LOCAL_CORE_URL, opts);
        }
        return origFetch.apply(this, arguments);
    };

    var origXHR = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string' && url.indexOf(CORE_FILENAME) !== -1) {
            arguments[1] = LOCAL_CORE_URL;
        }
        return origXHR.apply(this, arguments);
    };
})();
```

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-lockstep-v4.js web/static/core-redirector.js
git commit -m "feat: integrate forked core's C-level timing into lockstep engine"
```

### Task 8: Fix the desync detection (frame-aware comparison)

**Files:**
- Modify: `web/static/netplay-lockstep-v4.js`

The current sync-hash check has a bug: the guest hashes its state at its CURRENT frame, but the host sent the hash at `syncFrame`. If they're even 1 frame apart, the comparison is invalid. This causes false desync detections and unnecessary state transfers.

- [ ] **Step 1: Make sync-hash comparison frame-aware**

Replace the current sync-hash handler in the data channel `onmessage`:

```javascript
// State sync: hash check from host
if (e.data.substring(0, 10) === 'sync-hash:') {
    var parts = e.data.split(':');
    var syncFrame = parseInt(parts[1], 10);
    var hostHash = parseInt(parts[2], 10);

    // Only compare if we're at the same frame as the host.
    // If we're behind, store the check and compare when we reach that frame.
    // If we're ahead, skip (we'll catch it on the next round).
    if (_frameNum === syncFrame) {
        var localHash = hashGameState();
        if (localHash !== hostHash) {
            console.log('[lockstep-v4] DESYNC at frame', syncFrame,
                'local:', localHash, 'host:', hostHash, '-- requesting state');
            peer.dc.send('sync-request');
        }
    } else if (_frameNum < syncFrame) {
        // Store for deferred check
        window._pendingSyncCheck = { frame: syncFrame, hash: hostHash, peer: peer };
    }
    // If _frameNum > syncFrame, skip — frame already passed
}
```

And add a deferred check in `tick()` after `_frameNum++`:

```javascript
// Deferred sync check (guest was behind when sync-hash arrived)
if (window._pendingSyncCheck && _frameNum === window._pendingSyncCheck.frame) {
    var localHash = hashGameState();
    if (localHash !== window._pendingSyncCheck.hash) {
        console.log('[lockstep-v4] DESYNC (deferred) at frame',
            window._pendingSyncCheck.frame);
        try {
            window._pendingSyncCheck.peer.dc.send('sync-request');
        } catch (_) {}
    }
    window._pendingSyncCheck = null;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep-v4.js
git commit -m "fix: frame-aware desync detection — only compare states at same frame"
```

---

## Chunk 5: Testing & Verification

### Task 9: Deploy and test the forked core

**Files:**
- Modify: `tests/test_desync.py`

- [ ] **Step 1: Copy the built core to the web directory**

```bash
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
```

- [ ] **Step 2: Update the desync test to compare at the same frame**

The test must ensure both emulators are at the same frame before comparing. Use the frame-capture approach validated during our diagnostic sessions:

```python
def test_lockstep_no_desync(host_page, guest_page):
    """Verify save states match at the same frame number."""
    # ... setup (start game, wait for lockstep) ...

    # Inject hook: capture state at exactly frame 300
    capture_js = """() => {
        window._captureAtFrame = 300;
        window._capturedState = null;
        var check = setInterval(() => {
            if (window._frameNum === window._captureAtFrame && !window._capturedState) {
                var gm = window.EJS_emulator.gameManager;
                var state = gm.getState();
                var bytes = new Uint8Array(state);
                var hash = 0x811c9dc5;
                var len = Math.min(bytes.length, 65536);
                for (var i = 0; i < len; i++) {
                    hash ^= bytes[i];
                    hash = Math.imul(hash, 0x01000193);
                }
                window._capturedState = {
                    hash: hash | 0,
                    frameNum: window._frameNum
                };
                clearInterval(check);
            }
        }, 1);
    }"""

    host_page.evaluate(capture_js)
    guest_page.evaluate(capture_js)

    host_page.wait_for_function("window._capturedState !== null", timeout=60000)
    guest_page.wait_for_function("window._capturedState !== null", timeout=60000)

    h = host_page.evaluate("window._capturedState")
    g = guest_page.evaluate("window._capturedState")

    assert h["frameNum"] == g["frameNum"] == 300
    assert h["hash"] == g["hash"], f"DESYNC at frame 300: host={h['hash']}, guest={g['hash']}"
```

- [ ] **Step 3: Run the desync test**

Run: `python -m pytest tests/test_desync.py::test_lockstep_no_desync -v -s`
Expected: PASS — states match at the same frame

- [ ] **Step 4: Run the test 5 times to confirm stability**

Run: `for i in {1..5}; do echo "=== Run $i ==="; python -m pytest tests/test_desync.py::test_lockstep_no_desync -v -s; done`
Expected: All 5 runs PASS

- [ ] **Step 5: Run the full test suite**

Run: `python -m pytest tests/ -v -s`
Expected: All tests pass (frame pacing, lockstep, no desync)

- [ ] **Step 6: Commit**

```bash
git add tests/test_desync.py web/static/ejs/cores/mupen64plus_next-wasm.data
git commit -m "test: frame-accurate desync test + forked core deployment"
```

### Task 10: Extended stability test

- [ ] **Step 1: Run a long-duration test (1000 frames)**

Modify the test to capture at frame 1000 and run:
```bash
python -m pytest tests/test_desync.py::test_lockstep_no_desync -v -s
```
Expected: PASS — states still match after 1000 frames (~17 seconds of gameplay)

- [ ] **Step 2: Test with input (both players pressing buttons)**

Add a variant that injects button presses:
```javascript
// Inject random input on host
setInterval(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {keyCode: 67})); // A button
    setTimeout(() => {
        document.dispatchEvent(new KeyboardEvent('keyup', {keyCode: 67}));
    }, 50);
}, 200);
```

Run: `python -m pytest tests/test_desync.py -v -s`
Expected: States match even with active input

- [ ] **Step 3: Commit final passing state**

```bash
git add tests/
git commit -m "test: extended stability tests for deterministic lockstep"
```

---

## Chunk 6: Fallback & Resilience

### Task 11: Keep resync as safety net

Even with the forked core, keep the periodic resync mechanism as a safety net. With frame-aware comparison (Task 8), false positives are eliminated. Real desyncs (if any remain) will be caught and corrected.

**Files:**
- Modify: `web/static/netplay-lockstep-v4.js`

- [ ] **Step 1: Update the sync check comment**

Update the SYNC_CHECK_INTERVAL comment to reflect the new reality:

```javascript
// Desync detection: check every N frames (~2 seconds at 60fps).
// With the forked core's deterministic timing, desyncs should not occur.
// This serves as a safety net in case of edge cases or fallback to stock core.
const SYNC_CHECK_INTERVAL = 120;
```

- [ ] **Step 2: Add logging for sync check results**

In the tick loop's sync check section, add success logging (throttled):

```javascript
if (_syncEnabled && _playerSlot === 0 && _frameNum > 0 &&
    _frameNum % _syncCheckInterval === 0) {
    var hostHash = hashGameState();
    var syncMsg = 'sync-hash:' + _frameNum + ':' + hostHash;
    var ap = getActivePeers();
    for (var s = 0; s < ap.length; s++) {
        try { ap[s].dc.send(syncMsg); } catch (_) {}
    }
    // Log every 10th check (~20 seconds)
    if (_frameNum % (_syncCheckInterval * 10) === 0) {
        console.log('[lockstep-v4] sync check at frame', _frameNum, 'hash:', hostHash);
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep-v4.js
git commit -m "chore: update sync check comments and logging for forked core"
```

---

## Build Maintenance

### Updating the core

When upstream EmulatorJS or mupen64plus-libretro-nx updates:

1. Pull latest into `build/src/` repos
2. Re-apply our patches (they're in specific files — easy to cherry-pick)
3. Rebuild: `docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash /build/build.sh`
4. Test: `python -m pytest tests/test_desync.py -v -s`
5. Deploy: `cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/`

### Patch files

For maintainability, create `.patch` files for our modifications:

```bash
cd build/src/RetroArch
git diff > ../../patches/retroarch-deterministic-timing.patch

cd ../mupen64plus-libretro-nx
git diff > ../../patches/mupen64plus-deterministic-timing.patch
```

Store patches in `build/patches/` and apply them in `build.sh`:

```bash
cd "${SRC_DIR}/RetroArch"
git apply "${SCRIPT_DIR}/patches/retroarch-deterministic-timing.patch"

cd "${SRC_DIR}/mupen64plus-libretro-nx"
git apply "${SCRIPT_DIR}/patches/mupen64plus-deterministic-timing.patch"
```

---

## Summary

| Change | Location | Purpose |
|---|---|---|
| Deterministic `kn_get_now()` | RetroArch `platform_emulatorjs.c` | All timing reads return frame-counted values |
| Exported `kn_set_frame_time()` | RetroArch `platform_emulatorjs.c` | JS engine controls the frame clock |
| Core timing wrapper | mupen64plus `util.c` / `libretro.c` | N64 core uses deterministic time |
| Audio backend patch | RetroArch audio driver | Audio never blocks on real-time buffer availability |
| Frame-aware sync check | `netplay-lockstep-v4.js` | No false desync detections from frame drift |
| C-level timing in `stepOneFrame()` | `netplay-lockstep-v4.js` | Calls `Module._kn_set_frame_time()` instead of JS globals |
| Resync safety net | `netplay-lockstep-v4.js` | Catches edge-case desyncs even with forked core |
