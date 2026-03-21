# Deterministic Lockstep via EmulatorJS Core Fork

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate lockstep netplay desyncs by making the emulator block on input like Kaillera's modifyPlayValues — the emulator physically cannot advance without all players' input, making it network-paced instead of clock-paced.

**Architecture:** Two-phase approach. Phase 1 patches the existing core's JS glue code to make timing deterministic and disable async audio callbacks (no recompilation). Phase 2 (if needed) forks the C source and adds a true blocking input exchange inside `retro_input_poll`, requiring an Emscripten rebuild. Both phases self-host the core instead of using the CDN.

**Tech Stack:** EmulatorJS, Emscripten SDK 3.1.74, mupen64plus-libretro-nx (EmulatorJS fork), 7-Zip, Playwright

---

## Root Cause Summary

Prior investigation (50+ frames of Playwright debugging) established:

1. Input delivery is correct — zero mismatches, both emulators receive identical inputs on identical frames
2. States diverge within ~12 frames of identical starting state
3. Only 12 bytes differ in save state: CPU GP temp registers ($t1, $t2)
4. This means the CPUs execute different instruction counts per frame
5. The WASM module calls `_emscripten_get_now` (bound to `performance.now()`) ~74x/sec
6. JS-level `performance.now` overrides don't work — Emscripten binds the function reference at WASM instantiation time
7. The Web Audio ScriptProcessor callback fires asynchronously between frame steps

**Why Kaillera worked:** Original Kaillera (Project64k) had `modifyPlayValues()` which blocked the emulator thread inside the C code until all players' input arrived. Both emulators were physically paused at the same CPU instruction waiting for network input. The emulator was network-paced, not clock-paced. This is what we need.

**Reference implementation:** `kailleraclient.nim` in https://github.com/kwilson21/Kaillera-Plus-Plugin — `kailleraModifyPlayValues` enters a tight loop checking `frameCount`, blocks until peer data arrives in `outputChannel`, then overwrites the input buffer with synchronized peer inputs.

---

## File Structure

### Phase 1: JS Glue Code Patching (No Recompilation)

```
web/static/ejs/                          # Self-hosted EmulatorJS core
├── cores/
│   └── mupen64plus_next-wasm.data       # Repacked 7z with patched JS
├── patched/
│   ├── mupen64plus_next_libretro.js     # Patched JS glue (deterministic timing)
│   └── mupen64plus_next_libretro.wasm   # Original WASM binary (unchanged)
└── patch-core.sh                        # Script to download, extract, patch, repack

web/static/
├── netplay-lockstep-v4.js               # Modified: use self-hosted core, frame-paced stepping
└── core-redirector.js                   # XHR/fetch intercept to load patched core

web/play.html                            # Modified: load core-redirector.js, set EJS_pathtodata
```

### Phase 2: C-Level Fork (Full Recompilation)

```
emulatorjs-fork/                         # Git submodule or separate repo
├── mupen64plus-libretro-nx/             # Forked from EmulatorJS/mupen64plus-libretro-nx
│   └── (no changes needed in the core itself)
├── RetroArch/                           # Forked from EmulatorJS/RetroArch (branch: next)
│   └── input/drivers/emulatorjs_input.c # Modified: add netplay_wait_for_input()
├── build.sh                             # Our simplified build script
└── Dockerfile                           # Emscripten build environment

web/static/ejs/cores/
└── mupen64plus_next-wasm.data           # Custom-built core with input blocking
```

---

## Chunk 1: Phase 1 — Self-Host and Patch the Core

### Task 1: Download and Extract the EmulatorJS Core

**Files:**
- Create: `web/static/ejs/patch-core.sh`
- Create: `web/static/ejs/cores/` (directory)
- Create: `web/static/ejs/patched/` (directory)

- [ ] **Step 1: Create the patch script**

```bash
#!/bin/bash
# patch-core.sh — Download, extract, patch, and repack the mupen64plus N64 core
set -e

CORE_URL="https://cdn.emulatorjs.org/stable/data/cores/mupen64plus_next-wasm.data"
WORK_DIR="$(dirname "$0")/patched"
OUT_DIR="$(dirname "$0")/cores"

mkdir -p "$WORK_DIR" "$OUT_DIR"

# Download the core archive
echo "Downloading core..."
curl -sL "$CORE_URL" -o "$WORK_DIR/original.data"

# Extract 7z archive
echo "Extracting..."
cd "$WORK_DIR"
7z x -y original.data

echo "Core extracted. Files:"
ls -la *.js *.wasm 2>/dev/null || true

echo "Ready for patching. Edit mupen64plus_next_libretro.js then run:"
echo "  cd $WORK_DIR && 7z a -t7z ../cores/mupen64plus_next-wasm.data *.js *.wasm *.json *.txt"
```

- [ ] **Step 2: Run the script to download and extract**

Run: `cd web/static/ejs && bash patch-core.sh`
Expected: `patched/` directory contains `mupen64plus_next_libretro.js` (~283KB) and `mupen64plus_next_libretro.wasm` (~6.5MB)

- [ ] **Step 3: Commit**

```bash
git add web/static/ejs/patch-core.sh
git commit -m "chore: add script to download and extract EmulatorJS N64 core"
```

---

### Task 2: Patch the JS Glue Code for Deterministic Timing

**Files:**
- Modify: `web/static/ejs/patched/mupen64plus_next_libretro.js`

The JS glue code defines `_emscripten_get_now` which is imported by the WASM binary. By modifying this function BEFORE the module is instantiated, we ensure the WASM uses our deterministic version.

- [ ] **Step 1: Find and understand the timing function in the JS glue**

Run: `grep -n '_emscripten_get_now\|emscripten_get_now\|performance.now\|Date.now' web/static/ejs/patched/mupen64plus_next_libretro.js | head -20`

Expected: Find the function definition that returns `performance.now()` or `Date.now()`.

- [ ] **Step 2: Patch `_emscripten_get_now` to return deterministic time**

Find the function definition (likely something like):
```javascript
var _emscripten_get_now = () => performance.now();
```

Replace with:
```javascript
var _kn_frameTime = 0;
var _kn_inStep = false;
var _emscripten_get_now = () => {
  if (typeof window !== 'undefined' && window._kn_inStep) {
    return window._kn_frameTime;
  }
  return performance.now();
};
```

This returns frame-counted time when `window._kn_inStep` is true (set by our lockstep engine during `stepOneFrame()`), and real time otherwise (so boot/menu/non-netplay still works normally).

- [ ] **Step 3: Find and patch the audio timing callback**

Search for `ScriptProcessorNode` or `createScriptProcessor` or `onaudioprocess` in the glue code:

Run: `grep -n 'ScriptProcessor\|onaudioprocess\|createScriptProcessor\|audioWorklet\|AudioWorklet' web/static/ejs/patched/mupen64plus_next_libretro.js | head -10`

If found, wrap the callback to be a no-op when `window._kn_inStep` is true, or disable audio output during lockstep by zeroing the output buffers.

If the core uses OpenAL (likely), search for `AL.` or `openal` — the audio path may not use ScriptProcessorNode at all. In that case, the audio timing reads go through `_emscripten_get_now` which we already patched.

- [ ] **Step 4: Verify the patch is syntactically valid**

Run: `node --check web/static/ejs/patched/mupen64plus_next_libretro.js`
Expected: No errors.

- [ ] **Step 5: Repack the patched core as 7z**

Run: `cd web/static/ejs/patched && 7z a -t7z ../cores/mupen64plus_next-wasm.data *.js *.wasm *.json *.txt 2>/dev/null`
Expected: `web/static/ejs/cores/mupen64plus_next-wasm.data` is created.

- [ ] **Step 6: Commit**

```bash
git add web/static/ejs/patched/ web/static/ejs/cores/
git commit -m "feat: patch EmulatorJS core for deterministic timing in lockstep"
```

---

### Task 3: Create the Core Redirector

**Files:**
- Create: `web/static/core-redirector.js`
- Modify: `web/play.html`

EmulatorJS loads cores from `EJS_pathtodata + '/cores/'`. We redirect it to load our self-hosted patched core instead.

- [ ] **Step 1: Create core-redirector.js**

```javascript
/**
 * core-redirector.js — Redirect EmulatorJS core loading to self-hosted patched version.
 *
 * Must be loaded BEFORE EmulatorJS loader.js.
 * Only active when window._kn_usePatchedCore is true (set by lockstep engine).
 */
(function() {
  'use strict';

  // Override EJS_pathtodata to point to our self-hosted cores
  // Only if we're in lockstep mode (detected from URL params)
  var params = new URLSearchParams(window.location.search);
  var mode = params.get('mode') || 'lockstep-v4';

  if (mode === 'lockstep-v4') {
    // Point EmulatorJS to our self-hosted data directory
    window.EJS_pathtodata = '/static/ejs/';
    window._kn_usePatchedCore = true;
    console.log('[core-redirector] Using self-hosted patched core for lockstep mode');
  }
})();
```

- [ ] **Step 2: Update play.html to load the redirector and use conditional EJS_pathtodata**

In `web/play.html`, change the EmulatorJS config section:

```html
<!-- Core redirector (must load before EmulatorJS) -->
<script src="/static/core-redirector.js"></script>

<!-- EmulatorJS -->
<div id="game"></div>
<script>
  var EJS_player     = '#game';
  var EJS_core       = 'n64';
  var EJS_gameUrl    = '/static/rom/Super Smash Bros. (USA).z64';
  // EJS_pathtodata set by core-redirector.js for lockstep, or default CDN for streaming
  if (!window.EJS_pathtodata) {
    var EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
  }
</script>
<script src="https://cdn.emulatorjs.org/stable/data/loader.js"></script>
```

- [ ] **Step 3: Copy the EmulatorJS data directory structure**

The self-hosted path needs the same structure as the CDN. We need at minimum:
- `web/static/ejs/cores/mupen64plus_next-wasm.data` (our patched core)
- `web/static/ejs/compression/extract7z.js` (7z decompressor — download from CDN)
- `web/static/ejs/loader.js` (EmulatorJS loader — download from CDN)
- `web/static/ejs/emulator.min.js` (EmulatorJS main script — download from CDN, or keep using CDN loader which loads it)

Actually, the simplest approach: keep using the CDN loader.js but override `EJS_pathtodata` so it fetches cores from our server. The loader will still come from the CDN, but it will look for cores at our `EJS_pathtodata` path.

We need to serve the same directory structure under `/static/ejs/`:
```
web/static/ejs/
├── cores/
│   └── mupen64plus_next-wasm.data    # Our patched core
├── compression/
│   └── extract7z.js                   # Copy from CDN (needed for 7z extraction)
└── version.json                       # Copy from CDN (core version info)
```

Run:
```bash
mkdir -p web/static/ejs/compression
curl -sL "https://cdn.emulatorjs.org/stable/data/compression/extract7z.js" -o web/static/ejs/compression/extract7z.js
curl -sL "https://cdn.emulatorjs.org/stable/data/version.json" -o web/static/ejs/version.json
```

- [ ] **Step 4: Verify the redirect works**

Start the server and verify EmulatorJS loads the patched core:

Run: `python -c "from src.main import run; run()" &` (from server/)
Then check: `curl -s http://localhost:8000/static/ejs/cores/mupen64plus_next-wasm.data | file -`
Expected: `data` (7z archive)

- [ ] **Step 5: Commit**

```bash
git add web/static/core-redirector.js web/static/ejs/ web/play.html
git commit -m "feat: self-host patched EmulatorJS core with deterministic timing"
```

---

### Task 4: Modify the Lockstep Engine for Deterministic Frame Stepping

**Files:**
- Modify: `web/static/netplay-lockstep-v4.js`

The key change: set `window._kn_inStep = true` and advance `window._kn_frameTime` by 16.667ms during each `stepOneFrame()` call. This makes all timing reads inside the frame return the same deterministic value on both emulators.

- [ ] **Step 1: Add deterministic timing control to stepOneFrame()**

Find the `stepOneFrame()` function (~line 869):

```javascript
function stepOneFrame() {
    if (!_pendingRunner) return false;
    var runner = _pendingRunner;
    _pendingRunner = null;
    runner(performance.now());
    // Force GL composite via real rAF no-op
    _origRAF.call(window, function () {});
    return true;
}
```

Replace with:

```javascript
function stepOneFrame() {
    if (!_pendingRunner) return false;
    var runner = _pendingRunner;
    _pendingRunner = null;

    // Deterministic timing: all _emscripten_get_now calls during this
    // frame step return the same frame-counted time on both emulators.
    // This prevents CPU instruction count divergence from timing reads.
    window._kn_inStep = true;
    window._kn_frameTime = (_frameNum + 1) * 16.666666666666668; // 1/60th second per frame

    runner(window._kn_frameTime);

    window._kn_inStep = false;

    // Force GL composite via real rAF no-op
    _origRAF.call(window, function () {});
    return true;
}
```

- [ ] **Step 2: Initialize _kn_frameTime at lockstep start**

In `startLockstep()` (~line 901), add:

```javascript
window._kn_frameTime = 0;
window._kn_inStep = false;
```

- [ ] **Step 3: Reset in stopSync()**

In `stopSync()` (~line 932), add:

```javascript
window._kn_inStep = false;
```

- [ ] **Step 4: Verify syntax**

Run: `node --check web/static/netplay-lockstep-v4.js`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add web/static/netplay-lockstep-v4.js
git commit -m "feat: deterministic frame timing in lockstep — network-paced stepping"
```

---

### Task 5: Playwright Verification — Phase 1

**Files:**
- Create: `tests/test_desync.py`

- [ ] **Step 1: Write desync detection test**

```python
"""Test that lockstep mode produces identical game state on both emulators.

Run: pytest tests/test_desync.py -v
"""
import time
import hashlib

def test_lockstep_no_desync(browser, server_url):
    """Two players in lockstep should have identical game state after N frames."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        # Host creates room in lockstep mode
        host.goto(f"{server_url}/play.html?room=DSYNC1&host=1&name=Host&mode=lockstep-v4")
        host.wait_for_selector("#overlay", timeout=10000)

        # Guest joins
        guest.goto(f"{server_url}/play.html?room=DSYNC1&name=Guest")
        guest.wait_for_selector("#overlay", timeout=10000)

        # Wait for start button to enable, then start
        host.wait_for_selector("#start-btn:not([disabled])", timeout=15000)
        host.click("#start-btn")

        # Wait for both emulators to be running lockstep
        host.wait_for_function("window._lockstepActive === true", timeout=60000)
        guest.wait_for_function("window._lockstepActive === true", timeout=60000)

        # Let the game run for ~5 seconds (300 frames at 60fps)
        target_frame = 300
        host.wait_for_function(
            f"window._frameNum >= {target_frame}",
            timeout=120000
        )
        guest.wait_for_function(
            f"window._frameNum >= {target_frame}",
            timeout=120000
        )

        # Compare game state: hash first 64KB of save state on both sides
        hash_script = """() => {
            try {
                var gm = window.EJS_emulator.gameManager;
                var state = gm.getState();
                var bytes = state instanceof Uint8Array ? state : new Uint8Array(state);
                // Hash first 64KB (game state, excludes audio buffers)
                var hash = 0x811c9dc5;
                var len = Math.min(bytes.length, 65536);
                for (var i = 0; i < len; i++) {
                    hash ^= bytes[i];
                    hash = Math.imul(hash, 0x01000193);
                }
                return {
                    hash: hash | 0,
                    frameNum: window._frameNum,
                    stateSize: bytes.length
                };
            } catch (e) {
                return { error: e.message };
            }
        }"""

        host_state = host.evaluate(hash_script)
        guest_state = guest.evaluate(hash_script)

        print(f"Host:  frame={host_state.get('frameNum')} hash={host_state.get('hash')} size={host_state.get('stateSize')}")
        print(f"Guest: frame={guest_state.get('frameNum')} hash={guest_state.get('hash')} size={guest_state.get('stateSize')}")

        # Frame numbers should be within 5 frames of each other
        frame_diff = abs(host_state['frameNum'] - guest_state['frameNum'])
        assert frame_diff <= 5, f"Frame divergence too large: {frame_diff}"

        # Game state hashes should match (no desync!)
        assert host_state['hash'] == guest_state['hash'], (
            f"DESYNC DETECTED at frame ~{host_state['frameNum']}: "
            f"host hash={host_state['hash']}, guest hash={guest_state['hash']}"
        )

        print(f"SUCCESS: No desync after {target_frame} frames!")

    finally:
        host.close()
        guest.close()


def test_lockstep_frame_pacing(browser, server_url):
    """Verify both emulators advance at the same rate (network-paced)."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=PACE1&host=1&name=Host&mode=lockstep-v4")
        host.wait_for_selector("#overlay", timeout=10000)

        guest.goto(f"{server_url}/play.html?room=PACE1&name=Guest")
        guest.wait_for_selector("#overlay", timeout=10000)

        host.wait_for_selector("#start-btn:not([disabled])", timeout=15000)
        host.click("#start-btn")

        # Wait for lockstep to be active
        host.wait_for_function("window._lockstepActive === true", timeout=60000)
        guest.wait_for_function("window._lockstepActive === true", timeout=60000)

        # Sample frame numbers every second for 5 seconds
        samples = []
        for _ in range(5):
            time.sleep(1)
            h_frame = host.evaluate("window._frameNum")
            g_frame = guest.evaluate("window._frameNum")
            diff = abs(h_frame - g_frame)
            samples.append((h_frame, g_frame, diff))
            print(f"  Host: {h_frame}, Guest: {g_frame}, Diff: {diff}")

        # Frame difference should stay small (within DELAY_FRAMES + jitter)
        max_diff = max(s[2] for s in samples)
        assert max_diff <= 10, f"Frame pacing too divergent: max diff = {max_diff}"

        # Both should be advancing (not stalled)
        h_advance = samples[-1][0] - samples[0][0]
        g_advance = samples[-1][1] - samples[0][1]
        assert h_advance > 100, f"Host stalled: only advanced {h_advance} frames in 5s"
        assert g_advance > 100, f"Guest stalled: only advanced {g_advance} frames in 5s"

        print(f"Frame pacing OK: max diff = {max_diff}, host rate = {h_advance/5:.0f}fps, guest rate = {g_advance/5:.0f}fps")

    finally:
        host.close()
        guest.close()
```

- [ ] **Step 2: Run the desync test**

Run: `python -m pytest tests/test_desync.py -v -s`
Expected: Both tests pass — no desync after 300 frames, frame pacing stays within bounds.

- [ ] **Step 3: If tests FAIL — analyze the desync**

If `test_lockstep_no_desync` fails, add a more detailed state comparison:

```python
# Dump first 1024 bytes of state and compare byte-by-byte
compare_script = """() => {
    var gm = window.EJS_emulator.gameManager;
    var state = gm.getState();
    var bytes = state instanceof Uint8Array ? state : new Uint8Array(state);
    return Array.from(bytes.slice(0, 1024));
}"""
host_bytes = host.evaluate(compare_script)
guest_bytes = guest.evaluate(compare_script)
diffs = [(i, host_bytes[i], guest_bytes[i]) for i in range(len(host_bytes)) if host_bytes[i] != guest_bytes[i]]
print(f"Differences in first 1KB: {len(diffs)} bytes differ")
for offset, h, g in diffs[:20]:
    print(f"  offset {offset}: host={h:#04x} guest={g:#04x}")
```

This tells us which bytes differ and where (CPU registers? audio buffers? other?).

- [ ] **Step 4: Commit test file**

```bash
git add tests/test_desync.py
git commit -m "test: add lockstep desync detection tests"
```

---

## Chunk 2: Phase 2 — C-Level Input Blocking Fork (If Phase 1 Insufficient)

This phase is needed only if Phase 1's JS-level patching doesn't eliminate desyncs. The approach: modify the RetroArch input driver to block the emulator at the input polling point, exactly like Kaillera's `modifyPlayValues()`.

### Task 6: Set Up the Emscripten Build Environment

**Files:**
- Create: `emulatorjs-fork/Dockerfile`
- Create: `emulatorjs-fork/build.sh`

- [ ] **Step 1: Create Dockerfile for the build environment**

```dockerfile
FROM --platform=linux/amd64 debian:bookworm

RUN apt-get update && apt-get install -y \
    jq wget curl gpg p7zip-full \
    binutils-mips-linux-gnu build-essential pkgconf \
    python3 git zip libsdl2-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Emscripten SDK 3.1.74 (same version as EmulatorJS)
WORKDIR /opt
RUN git clone https://github.com/emscripten-core/emsdk.git && \
    cd emsdk && \
    ./emsdk install 3.1.74 && \
    ./emsdk activate 3.1.74

ENV PATH="/opt/emsdk:/opt/emsdk/upstream/emscripten:${PATH}"

WORKDIR /build
```

- [ ] **Step 2: Create build script**

```bash
#!/bin/bash
# build.sh — Build the patched mupen64plus core for EmulatorJS
set -e

echo "=== Step 1: Activate Emscripten ==="
source /opt/emsdk/emsdk_env.sh

echo "=== Step 2: Clone repositories ==="
if [ ! -d "mupen64plus-libretro-nx" ]; then
    git clone --depth 1 https://github.com/EmulatorJS/mupen64plus-libretro-nx.git
fi
if [ ! -d "RetroArch" ]; then
    git clone --depth 1 -b next https://github.com/EmulatorJS/RetroArch.git
fi

echo "=== Step 3: Apply our input blocking patch ==="
cp /build/patches/emulatorjs_input_netplay.patch RetroArch/input/drivers/
cd RetroArch/input/drivers/
patch -p0 < emulatorjs_input_netplay.patch
cd /build

echo "=== Step 4: Compile core to bitcode ==="
cd mupen64plus-libretro-nx
emmake make -j$(nproc) -f Makefile platform=emscripten clean
emmake make -j$(nproc) -f Makefile platform=emscripten
ls -la *.bc
cd /build

echo "=== Step 5: Link through RetroArch ==="
mkdir -p RetroArch/emulatorjs/cores
cp mupen64plus-libretro-nx/mupen64plus_next_libretro_emscripten.bc \
   RetroArch/emulatorjs/cores/

cd RetroArch/emulatorjs
emmake ./build-emulatorjs.sh --clean
cd /build

echo "=== Step 6: Package ==="
mkdir -p output
cd RetroArch/emulatorjs
7z a -t7z /build/output/mupen64plus_next-wasm.data \
    mupen64plus_next_libretro.js \
    mupen64plus_next_libretro.wasm \
    core.json license.txt build.json 2>/dev/null || \
7z a -t7z /build/output/mupen64plus_next-wasm.data \
    mupen64plus_next_libretro.js \
    mupen64plus_next_libretro.wasm

echo "=== Done! ==="
ls -la /build/output/
```

- [ ] **Step 3: Commit build infrastructure**

```bash
git add emulatorjs-fork/
git commit -m "chore: add Docker build environment for custom EmulatorJS core"
```

---

### Task 7: Implement Input Blocking in C (Kaillera-Style)

**Files:**
- Create: `emulatorjs-fork/patches/emulatorjs_input_netplay.patch`

This patch modifies `RetroArch/input/drivers/emulatorjs_input.c` to add a function that blocks the emulator at the input polling point until peer input is available.

- [ ] **Step 1: Create the C patch**

The patch adds a `netplay_wait_for_input()` function called from `rwebinput_input_poll()`:

```c
/* --- Added for kaillera-next netplay input blocking --- */
#include <emscripten/emscripten.h>

/* These are set from JavaScript:
 * window._kn_netplayActive = true when lockstep is running
 * window._kn_inputReady = true when all peers' input for this frame has arrived
 */

static int kn_netplay_active(void) {
    return EM_ASM_INT({ return (typeof window._kn_netplayActive !== 'undefined' && window._kn_netplayActive) ? 1 : 0; });
}

static int kn_input_ready(void) {
    return EM_ASM_INT({ return (typeof window._kn_inputReady !== 'undefined' && window._kn_inputReady) ? 1 : 0; });
}

/* Block until JavaScript signals that all peers' input is ready.
 * Uses emscripten_sleep() (Asyncify) to yield to JS event loop,
 * allowing WebRTC data channel callbacks to fire and deliver peer input.
 * This is the Kaillera modifyPlayValues equivalent for WASM. */
static void netplay_wait_for_input(void) {
    if (!kn_netplay_active()) return;

    int waited = 0;
    while (!kn_input_ready()) {
        emscripten_sleep(1);  /* Yield to JS event loop */
        waited++;
        if (waited > 30000) {  /* 30 second timeout */
            break;
        }
    }

    /* Clear the ready flag for the next frame */
    EM_ASM({ window._kn_inputReady = false; });
}
/* --- End kaillera-next additions --- */
```

And modify `rwebinput_input_poll()` to call it:

```c
static void rwebinput_input_poll(void *data)
{
   size_t i;
   rwebinput_input_t *rwebinput = (rwebinput_input_t*)data;

   /* kaillera-next: block until peer input arrives */
   netplay_wait_for_input();

   for (i = 0; i < rwebinput->keyboard.count; i++)
      rwebinput_process_keyboard_events(rwebinput,
         &rwebinput->keyboard.events[i]);
   /* ... rest unchanged ... */
}
```

- [ ] **Step 2: Update the lockstep engine to set JS flags**

In `web/static/netplay-lockstep-v4.js`, modify `tick()`:

```javascript
// Before stepping, signal that input is ready
window._kn_inputReady = true;
// The WASM code will read this flag in netplay_wait_for_input()
// and proceed with the frame step

stepOneFrame();

// After stepping, the WASM code clears _kn_inputReady
```

And in `startLockstep()`:
```javascript
window._kn_netplayActive = true;
window._kn_inputReady = false;
```

And in `stopSync()`:
```javascript
window._kn_netplayActive = false;
window._kn_inputReady = false;
```

- [ ] **Step 3: Ensure the function is in the Asyncify whitelist**

If the build uses `MIN_ASYNC` instead of full `ASYNC`, we need to add `netplay_wait_for_input` and `rwebinput_input_poll` to `ASYNCIFY_ADD` in the Makefile.

Check the build-emulatorjs.sh to see which ASYNC mode is used for the N64 core. If it uses `ASYNC=1` (full asyncify), no whitelist changes needed.

- [ ] **Step 4: Commit the patch**

```bash
git add emulatorjs-fork/patches/
git commit -m "feat: Kaillera-style input blocking in EmulatorJS input driver"
```

---

### Task 8: Build and Test the Custom Core

- [ ] **Step 1: Build the Docker image**

Run: `cd emulatorjs-fork && docker build --platform linux/amd64 -t ejs-builder .`

- [ ] **Step 2: Run the build**

Run: `docker run --platform linux/amd64 -v $(pwd)/emulatorjs-fork:/build -v $(pwd)/web/static/ejs/cores:/output ejs-builder bash /build/build.sh`
Expected: `web/static/ejs/cores/mupen64plus_next-wasm.data` is created (~7-8MB)

- [ ] **Step 3: Run the desync test**

Run: `python -m pytest tests/test_desync.py -v -s`
Expected: Both tests pass with the custom-built core.

- [ ] **Step 4: Commit the built core**

```bash
git add web/static/ejs/cores/mupen64plus_next-wasm.data
git commit -m "feat: custom EmulatorJS core with Kaillera-style input blocking"
```

---

## Chunk 3: Integration and Verification

### Task 9: End-to-End Verification with Playwright

- [ ] **Step 1: Run the full E2E test suite**

Run: `python -m pytest tests/ -v`
Expected: All existing tests pass (lobby, play page, start/end game) plus the new desync tests.

- [ ] **Step 2: Extended desync test (10 seconds, with input)**

Add to `tests/test_desync.py`:

```python
def test_lockstep_with_input(browser, server_url):
    """Verify lockstep stays in sync when players press buttons."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=INPUT1&host=1&name=Host&mode=lockstep-v4")
        host.wait_for_selector("#overlay", timeout=10000)
        guest.goto(f"{server_url}/play.html?room=INPUT1&name=Guest")
        guest.wait_for_selector("#overlay", timeout=10000)
        host.wait_for_selector("#start-btn:not([disabled])", timeout=15000)
        host.click("#start-btn")

        host.wait_for_function("window._lockstepActive === true", timeout=60000)
        guest.wait_for_function("window._lockstepActive === true", timeout=60000)

        # Wait for game to get going
        host.wait_for_function("window._frameNum >= 60", timeout=60000)

        # Simulate some button presses via keyboard
        for _ in range(5):
            host.keyboard.down("ArrowDown")
            time.sleep(0.3)
            host.keyboard.up("ArrowDown")
            time.sleep(0.3)

        # Let frames advance
        host.wait_for_function("window._frameNum >= 600", timeout=120000)
        guest.wait_for_function("window._frameNum >= 600", timeout=120000)

        # Check state match
        hash_script = """() => {
            try {
                var gm = window.EJS_emulator.gameManager;
                var state = gm.getState();
                var bytes = state instanceof Uint8Array ? state : new Uint8Array(state);
                var hash = 0x811c9dc5;
                var len = Math.min(bytes.length, 65536);
                for (var i = 0; i < len; i++) {
                    hash ^= bytes[i];
                    hash = Math.imul(hash, 0x01000193);
                }
                return { hash: hash | 0, frameNum: window._frameNum };
            } catch (e) { return { error: e.message }; }
        }"""

        host_state = host.evaluate(hash_script)
        guest_state = guest.evaluate(hash_script)

        print(f"Host:  frame={host_state['frameNum']} hash={host_state['hash']}")
        print(f"Guest: frame={guest_state['frameNum']} hash={guest_state['hash']}")

        assert host_state['hash'] == guest_state['hash'], (
            f"DESYNC with input at frame ~{host_state['frameNum']}"
        )
        print("SUCCESS: No desync with active input after 600 frames!")

    finally:
        host.close()
        guest.close()
```

- [ ] **Step 3: Run the extended test**

Run: `python -m pytest tests/test_desync.py::test_lockstep_with_input -v -s`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/test_desync.py
git commit -m "test: extended desync tests with active input"
```

---

### Task 10: Cleanup and Documentation

- [ ] **Step 1: Remove the Rollback/Sync UI if desyncs are eliminated**

If all desync tests pass, the "Rollback: Off" button in the toolbar is no longer needed. Remove `_syncEnabled` and related sync hash/chunk code from the lockstep engine.

- [ ] **Step 2: Update CLAUDE.md with the fork decision**

Add a note about the self-hosted core and why it's needed.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: deterministic lockstep via self-hosted patched EmulatorJS core"
```

---

## Key Reference Information

### EmulatorJS Build Pipeline
1. Core source → `emmake make platform=emscripten` → `.bc` bitcode
2. Bitcode → RetroArch `Makefile.emulatorjs` → `.js` + `.wasm`
3. `.js` + `.wasm` + metadata → `7z` → `.data` archive
4. EmulatorJS loads `.data` from CDN/server, extracts, instantiates

### EmulatorJS Repos
- Frontend: `https://github.com/EmulatorJS/EmulatorJS`
- Build system: `https://github.com/EmulatorJS/build`
- RetroArch fork: `https://github.com/EmulatorJS/RetroArch` (branch `next`)
- N64 core fork: `https://github.com/EmulatorJS/mupen64plus-libretro-nx`
- Emscripten SDK version: **3.1.74**

### Kaillera Reference
- Plugin: `https://github.com/kwilson21/Kaillera-Plus-Plugin` (Nim, `kailleraclient.nim`)
- Client: `https://github.com/kwilson21/Kaillera-Plus-Client`
- Key function: `kailleraModifyPlayValues` — blocks in tight loop until `outputChannel` has peer data

### Key Files in EmulatorJS RetroArch
- `input/drivers/emulatorjs_input.c` — input driver with `simulate_input()`, `ejs_is_pressed()`
- `frontend/drivers/platform_emulatorjs.c` — platform driver with `retro_sleep()` using `emscripten_sleep()`
- `Makefile.emulatorjs` — Emscripten build flags, exported functions, memory settings
- `emulatorjs/build-emulatorjs.sh` — orchestrates .bc → .js + .wasm compilation

### Exported WASM Functions (callable from JS)
`_simulate_input(user, key, down)`, `_get_current_frame_count()`, `_load_state(path, slot)`,
`_cmd_save_state()`, `_set_cheat(idx, enabled, code)`, `_toggleMainLoop(pause)`, `_system_restart()`

### Our Direct Memory Input Layout
- Base address: `715364` in `Module.HEAPU8`
- Layout: `int32[20][4]` — 20 buttons x 4 players
- Button stride: 20 bytes, Player stride: 4 bytes
