# FPU Determinism Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add FPU operation tracing to verify cross-platform float determinism between ARM and x86 WASM engines.

**Architecture:** Ring buffer in C records every FPU arithmetic op's inputs/outputs as raw bits. JS reads the buffer, hashes it, and peers exchange hashes over DataChannel. On mismatch, full trace is dumped for analysis.

**Tech Stack:** C (mupen64plus fpu.h + main.c), Emscripten exports, JavaScript (netplay-lockstep.js), WebRTC DataChannel

**Spec:** `docs/superpowers/specs/2026-04-01-fpu-determinism-diagnostics-design.md`

---

## Chunk 1: C-Level Trace Infrastructure

### Task 1: Add trace buffer storage and exports to main.c patch

**Files:**
- Modify: `build/patches/mupen64plus-kn-all.patch` (the patch that adds kn_* globals to `mupen64plus-core/src/main/main.c`)

The kn-all patch adds code at line 9 of the patch (after `struct device g_dev;` in main.c, inside `#ifdef __EMSCRIPTEN__`). Add the trace buffer and accessor functions in the same block.

- [ ] **Step 1: Read the current patch to identify insertion point**

The kn-all patch's `#ifdef __EMSCRIPTEN__` block starts at patch line 9 and ends at line 73. Insert the trace code just before the closing `#endif` at line 73.

- [ ] **Step 2: Add trace buffer globals and exports to the patch**

Add this code to the kn-all patch, inside the existing `#ifdef __EMSCRIPTEN__` block, just before the `#endif`:

```c
/* kaillera-next: FPU operation trace ring buffer for cross-platform determinism verification.
 * Records input/output bit patterns for every FPU arithmetic op.
 * Storage lives here (single TU); fpu.h has extern decls + inline recorder. */
#define KN_FPU_TRACE_SIZE 4096
typedef struct {
    uint8_t  op;
    uint8_t  pad[3];
    uint32_t frame;
    uint64_t in1;
    uint64_t in2;
    uint64_t out;
} kn_fpu_trace_entry;
int kn_fpu_trace_enabled = 0;
kn_fpu_trace_entry kn_fpu_trace_buf[KN_FPU_TRACE_SIZE];
uint32_t kn_fpu_trace_count = 0;
EMSCRIPTEN_KEEPALIVE void kn_fpu_trace_enable(int enable) {
    kn_fpu_trace_enabled = enable;
    if (enable) kn_fpu_trace_count = 0;
}
EMSCRIPTEN_KEEPALIVE uint32_t kn_fpu_trace_get_count(void) { return kn_fpu_trace_count; }
EMSCRIPTEN_KEEPALIVE void *kn_fpu_trace_get_buf(void) { return kn_fpu_trace_buf; }
```

- [ ] **Step 3: Regenerate the patch**

Since we're modifying a git patch file directly, the approach is:
1. `cd build/src/mupen64plus-libretro-nx`
2. `git checkout -- .` (reset to clean)
3. Apply existing kn-all patch
4. Edit main.c to add the trace code
5. Regenerate: `git diff > ../../patches/mupen64plus-kn-all.patch`

```bash
cd /Users/kazon/kaillera-next/build/src/mupen64plus-libretro-nx
git checkout -- .
git apply ../../patches/mupen64plus-kn-all.patch
```

Then edit `mupen64plus-core/src/main/main.c` to add the trace buffer code (shown in step 2) just before the `#endif` that closes the `#ifdef __EMSCRIPTEN__` block (around line 196 after patch application).

Then regenerate:
```bash
git diff > ../../patches/mupen64plus-kn-all.patch
git checkout -- .
```

- [ ] **Step 4: Commit**

```bash
cd /Users/kazon/kaillera-next
git add build/patches/mupen64plus-kn-all.patch
git commit -m "feat: add FPU trace buffer storage to kn-all patch"
```

### Task 2: Add extern declarations and inline recorder to fpu.h

**Files:**
- Create: `build/patches/mupen64plus-fpu-trace.patch` (new patch for `mupen64plus-core/src/device/r4300/fpu.h`)

This patch adds two things to fpu.h:
1. Extern declarations + inline recorder function (near top, after includes)
2. Trace recording calls in each of the 20 FPU arithmetic functions

- [ ] **Step 1: Apply existing patches to get a clean working tree**

```bash
cd /Users/kazon/kaillera-next/build/src/mupen64plus-libretro-nx
git checkout -- .
git apply ../../patches/mupen64plus-kn-all.patch
git apply --exclude='mupen64plus-core/src/main/main.c' ../../patches/mupen64plus-deterministic-timing.patch 2>/dev/null || true
git apply --exclude='mupen64plus-core/src/main/main.c' ../../patches/mupen64plus-wasm-determinism.patch 2>/dev/null || true
```

- [ ] **Step 2: Add extern declarations and recorder to fpu.h**

Insert this block after the existing `#include` lines at the top of `fpu.h` (after line 46, before the `#define FCR31_CMP_BIT` line):

```c
/* kaillera-next: FPU trace — extern declarations for ring buffer in main.c */
#ifdef __EMSCRIPTEN__
#include <string.h> /* memcpy for type-punning in trace macros */
#define KN_FPU_TRACE_SIZE 4096
typedef struct {
    uint8_t  op;
    uint8_t  pad[3];
    uint32_t frame;
    uint64_t in1;
    uint64_t in2;
    uint64_t out;
} kn_fpu_trace_entry;
extern int kn_fpu_trace_enabled;
extern kn_fpu_trace_entry kn_fpu_trace_buf[];
extern uint32_t kn_fpu_trace_count;
extern int g_gs_vi_counter;
static inline void kn_fpu_trace_record(uint8_t op, uint64_t in1, uint64_t in2, uint64_t out) {
    if (!kn_fpu_trace_enabled) return;
    kn_fpu_trace_entry *e = &kn_fpu_trace_buf[kn_fpu_trace_count & (KN_FPU_TRACE_SIZE - 1)];
    e->op = op;
    e->frame = (uint32_t)g_gs_vi_counter;
    e->in1 = in1;
    e->in2 = in2;
    e->out = out;
    kn_fpu_trace_count++;
}
#define KN_FPU_TRACE_F(op_id, s1, s2, tgt) do { \
    uint32_t _i1, _i2, _o; \
    memcpy(&_i1, (s1), 4); memcpy(&_i2, (s2), 4); memcpy(&_o, (tgt), 4); \
    kn_fpu_trace_record((op_id), _i1, _i2, _o); \
} while(0)
#define KN_FPU_TRACE_F1(op_id, s1, tgt) do { \
    uint32_t _i1, _o; \
    memcpy(&_i1, (s1), 4); memcpy(&_o, (tgt), 4); \
    kn_fpu_trace_record((op_id), _i1, 0, _o); \
} while(0)
#define KN_FPU_TRACE_D(op_id, s1, s2, tgt) do { \
    uint64_t _i1, _i2, _o; \
    memcpy(&_i1, (s1), 8); memcpy(&_i2, (s2), 8); memcpy(&_o, (tgt), 8); \
    kn_fpu_trace_record((op_id), _i1, _i2, _o); \
} while(0)
#define KN_FPU_TRACE_D1(op_id, s1, tgt) do { \
    uint64_t _i1, _o; \
    memcpy(&_i1, (s1), 8); memcpy(&_o, (tgt), 8); \
    kn_fpu_trace_record((op_id), _i1, 0, _o); \
} while(0)
/* Conversion: float->double or int->float etc. Input/output sizes differ. */
#define KN_FPU_TRACE_CVT_F2D(op_id, s1, tgt) do { \
    uint32_t _i1; uint64_t _o; \
    memcpy(&_i1, (s1), 4); memcpy(&_o, (tgt), 8); \
    kn_fpu_trace_record((op_id), _i1, 0, _o); \
} while(0)
#define KN_FPU_TRACE_CVT_D2F(op_id, s1, tgt) do { \
    uint64_t _i1; uint32_t _o; \
    memcpy(&_i1, (s1), 8); memcpy(&_o, (tgt), 4); \
    kn_fpu_trace_record((op_id), _i1, 0, _o); \
} while(0)
#define KN_FPU_TRACE_CVT_W2F(op_id, s1, tgt) do { \
    int32_t _i1; uint32_t _o; \
    memcpy(&_i1, (s1), 4); memcpy(&_o, (tgt), 4); \
    kn_fpu_trace_record((op_id), (uint64_t)(uint32_t)_i1, 0, _o); \
} while(0)
#define KN_FPU_TRACE_CVT_W2D(op_id, s1, tgt) do { \
    int32_t _i1; uint64_t _o; \
    memcpy(&_i1, (s1), 4); memcpy(&_o, (tgt), 8); \
    kn_fpu_trace_record((op_id), (uint64_t)(uint32_t)_i1, 0, _o); \
} while(0)
#define KN_FPU_TRACE_CVT_L2F(op_id, s1, tgt) do { \
    int64_t _i1; uint32_t _o; \
    memcpy(&_i1, (s1), 8); memcpy(&_o, (tgt), 4); \
    kn_fpu_trace_record((op_id), (uint64_t)_i1, 0, _o); \
} while(0)
#define KN_FPU_TRACE_CVT_L2D(op_id, s1, tgt) do { \
    int64_t _i1; uint64_t _o; \
    memcpy(&_i1, (s1), 8); memcpy(&_o, (tgt), 8); \
    kn_fpu_trace_record((op_id), (uint64_t)_i1, 0, _o); \
} while(0)
#else
#define KN_FPU_TRACE_F(op_id, s1, s2, tgt)
#define KN_FPU_TRACE_F1(op_id, s1, tgt)
#define KN_FPU_TRACE_D(op_id, s1, s2, tgt)
#define KN_FPU_TRACE_D1(op_id, s1, tgt)
#define KN_FPU_TRACE_CVT_F2D(op_id, s1, tgt)
#define KN_FPU_TRACE_CVT_D2F(op_id, s1, tgt)
#define KN_FPU_TRACE_CVT_W2F(op_id, s1, tgt)
#define KN_FPU_TRACE_CVT_W2D(op_id, s1, tgt)
#define KN_FPU_TRACE_CVT_L2F(op_id, s1, tgt)
#define KN_FPU_TRACE_CVT_L2D(op_id, s1, tgt)
#endif
```

- [ ] **Step 3: Add trace calls to all 20 FPU functions**

Add a trace macro call at the end of each function, just before the closing `}`. The operation IDs match the spec:

**Float arithmetic (binary):**
- `add_s` (line ~992): add `KN_FPU_TRACE_F(0, source1, source2, target);`
- `sub_s` (line ~1008): add `KN_FPU_TRACE_F(1, source1, source2, target);`
- `mul_s` (line ~1024): add `KN_FPU_TRACE_F(2, source1, source2, target);`
- `div_s` (line ~1040): add `KN_FPU_TRACE_F(3, source1, source2, target);`

**Float arithmetic (unary):**
- `sqrt_s` (line ~1055): add `KN_FPU_TRACE_F1(4, source, target);`
- `abs_s` (line ~1066): add `KN_FPU_TRACE_F1(5, source, target);`
- `neg_s` (line ~1079): add `KN_FPU_TRACE_F1(6, source, target);`

**Double arithmetic (binary):**
- `add_d` (line ~1093): add `KN_FPU_TRACE_D(7, source1, source2, target);`
- `sub_d` (line ~1109): add `KN_FPU_TRACE_D(8, source1, source2, target);`
- `mul_d` (line ~1125): add `KN_FPU_TRACE_D(9, source1, source2, target);`
- `div_d` (line ~1141): add `KN_FPU_TRACE_D(10, source1, source2, target);`

**Double arithmetic (unary):**
- `sqrt_d` (line ~1157): add `KN_FPU_TRACE_D1(11, source, target);`
- `abs_d` (line ~1170): add `KN_FPU_TRACE_D1(12, source, target);`
- `neg_d` (line ~1185): add `KN_FPU_TRACE_D1(13, source, target);`

**Conversions (IDs match spec: 14=cvt_s_d, 15=cvt_d_s):**
- `cvt_s_d` (line ~301): add `KN_FPU_TRACE_CVT_D2F(14, source, dest);` (double→float)
- `cvt_d_s` (line ~287): add `KN_FPU_TRACE_CVT_F2D(15, source, dest);` (float→double)
- `cvt_s_w` (line ~241): add `KN_FPU_TRACE_CVT_W2F(16, source, dest);`
- `cvt_d_w` (line ~249): add `KN_FPU_TRACE_CVT_W2D(17, source, dest);`
- `cvt_s_l` (line ~263): add `KN_FPU_TRACE_CVT_L2F(18, source, dest);`
- `cvt_d_l` (line ~275): add `KN_FPU_TRACE_CVT_L2D(19, source, dest);`

Each trace call goes just before the closing `}` of the function.

- [ ] **Step 4: Generate the patch**

```bash
cd /Users/kazon/kaillera-next/build/src/mupen64plus-libretro-nx
git diff -- mupen64plus-core/src/device/r4300/fpu.h > ../../patches/mupen64plus-fpu-trace.patch
git checkout -- .
```

- [ ] **Step 5: Commit**

```bash
cd /Users/kazon/kaillera-next
git add build/patches/mupen64plus-fpu-trace.patch
git commit -m "feat: add FPU trace instrumentation patch for fpu.h"
```

### Task 3: Add exports to RetroArch patch and apply in build.sh

**Files:**
- Modify: `build/patches/retroarch-deterministic-timing.patch`
- Modify: `build/build.sh`

- [ ] **Step 1: Add FPU trace exports to the RetroArch patch**

In `build/patches/retroarch-deterministic-timing.patch`, find the `EXPORTED_FUNCTIONS` line (patch line 16):
```
+                     _kn_frame_hash,_kn_set_skip_rsp_audio
```

Change it to:
```
+                     _kn_frame_hash,_kn_set_skip_rsp_audio, \
+                     _kn_fpu_trace_enable,_kn_fpu_trace_get_count,_kn_fpu_trace_get_buf
```

- [ ] **Step 2: Add patch application to build.sh**

In `build/build.sh`, after the wasm-determinism patch block (around line 107), add:

```bash
    # FPU trace: ring buffer instrumentation in fpu.h for cross-platform
    # determinism verification. Records input/output bit patterns for every
    # FPU arithmetic operation when tracing is enabled from JS.
    if [ -f "${PATCHES_DIR}/mupen64plus-fpu-trace.patch" ]; then
        git apply "${PATCHES_DIR}/mupen64plus-fpu-trace.patch" 2>/dev/null && \
            echo "    Applied mupen64plus FPU trace patch (fpu.h)" || \
            echo "    WARN: FPU trace patch failed"
    fi
```

- [ ] **Step 3: Commit**

```bash
cd /Users/kazon/kaillera-next
git add build/patches/retroarch-deterministic-timing.patch build/build.sh
git commit -m "feat: wire FPU trace exports and build.sh patch application"
```

## Chunk 2: JS Trace Exchange

### Task 4: Add FPU trace enable/disable and hash exchange to lockstep engine

**Files:**
- Modify: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Add FPU trace constants and state variables**

Near the top of the lockstep IIFE (around the existing `_hasForkedCore` declaration area, after other module-level variables), add:

```js
const _FPU_TRACE_SIZE = 4096;
const _FPU_TRACE_ENTRY_BYTES = 32;
const _FPU_TRACE_CHECK_INTERVAL = 300; // frames between hash comparisons
let _fpuTraceEnabled = false;
let _fpuTraceLastCheckFrame = 0;
let _fpuTraceVerified = false; // true once a match is confirmed
```

- [ ] **Step 2: Add FPU trace helper functions**

Add these helper functions near the other utility functions in the module:

```js
/** Read the FPU trace ring buffer from WASM and compute FNV-1a hash */
const _fpuTraceHash = () => {
  const mod = window.EJS_emulator?.gameManager?.Module;
  if (!mod?._kn_fpu_trace_get_buf || !mod?._kn_fpu_trace_get_count) return null;
  const count = mod._kn_fpu_trace_get_count();
  if (count === 0) return null;
  const bufPtr = mod._kn_fpu_trace_get_buf();
  const totalBytes = _FPU_TRACE_SIZE * _FPU_TRACE_ENTRY_BYTES;
  const buf = mod.HEAPU8.subarray(bufPtr, bufPtr + totalBytes);
  // FNV-1a over the entire ring buffer
  let hash = 2166136261;
  for (let i = 0; i < totalBytes; i++) {
    hash ^= buf[i];
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return { hash, count };
};

/** Extract trace entries for a frame range from the ring buffer */
const _fpuTraceExtract = (startFrame, endFrame) => {
  const mod = window.EJS_emulator?.gameManager?.Module;
  if (!mod?._kn_fpu_trace_get_buf) return [];
  const bufPtr = mod._kn_fpu_trace_get_buf();
  const count = mod._kn_fpu_trace_get_count();
  const entries = [];
  const used = Math.min(count, _FPU_TRACE_SIZE);
  const startIdx = count > _FPU_TRACE_SIZE ? count - _FPU_TRACE_SIZE : 0;
  for (let i = 0; i < used; i++) {
    const idx = (startIdx + i) & (_FPU_TRACE_SIZE - 1);
    const off = bufPtr + idx * _FPU_TRACE_ENTRY_BYTES;
    const op = mod.HEAPU8[off];
    // frame is uint32 at offset 4
    const frame = mod.HEAPU8[off + 4] | (mod.HEAPU8[off + 5] << 8) |
                  (mod.HEAPU8[off + 6] << 16) | (mod.HEAPU8[off + 7] << 24);
    if (frame < startFrame || frame > endFrame) continue;
    // Read in1 (8 bytes at offset 8), in2 (8 bytes at offset 16), out (8 bytes at offset 24)
    const dv = new DataView(mod.HEAPU8.buffer, off, _FPU_TRACE_ENTRY_BYTES);
    const in1Lo = dv.getUint32(8, true), in1Hi = dv.getUint32(12, true);
    const in2Lo = dv.getUint32(16, true), in2Hi = dv.getUint32(20, true);
    const outLo = dv.getUint32(24, true), outHi = dv.getUint32(28, true);
    entries.push({
      op, frame,
      in1: in1Hi ? `${in1Hi.toString(16).padStart(8,'0')}${in1Lo.toString(16).padStart(8,'0')}` : in1Lo.toString(16).padStart(8,'0'),
      in2: in2Hi ? `${in2Hi.toString(16).padStart(8,'0')}${in2Lo.toString(16).padStart(8,'0')}` : in2Lo.toString(16).padStart(8,'0'),
      out: outHi ? `${outHi.toString(16).padStart(8,'0')}${outLo.toString(16).padStart(8,'0')}` : outLo.toString(16).padStart(8,'0'),
    });
  }
  return entries;
};

const _FPU_OP_NAMES = [
  'add_s','sub_s','mul_s','div_s','sqrt_s','abs_s','neg_s',
  'add_d','sub_d','mul_d','div_d','sqrt_d','abs_d','neg_d',
  'cvt_s_d','cvt_d_s','cvt_s_w','cvt_d_w','cvt_s_l','cvt_d_l'
];
```

- [ ] **Step 3: Enable tracing at lockstep start**

In the `startSync` function (around line 2890, where `_kn_set_deterministic(1)` is called), add after the deterministic timing block:

```js
      // Enable FPU trace for cross-platform determinism verification
      if (detMod?._kn_fpu_trace_enable) {
        detMod._kn_fpu_trace_enable(1);
        _fpuTraceEnabled = true;
        _fpuTraceLastCheckFrame = 0;
        _fpuTraceVerified = false;
        _syncLog('FPU trace enabled for determinism verification');
      }
```

- [ ] **Step 4: Disable tracing at lockstep stop**

In the `stopSync` function (around line 3144, near the `_kn_set_skip_rsp_audio(0)` call), add:

```js
    // Disable FPU trace
    if (_fpuTraceEnabled) {
      const traceMod = window.EJS_emulator?.gameManager?.Module;
      if (traceMod?._kn_fpu_trace_enable) traceMod._kn_fpu_trace_enable(0);
      _fpuTraceEnabled = false;
    }
```

- [ ] **Step 5: Add periodic hash exchange in the frame tick**

In the host's frame tick path (the same area where `sync-hash:` is sent), add FPU trace hash broadcasting. Find the tick function and add a check every `_FPU_TRACE_CHECK_INTERVAL` frames:

```js
    // FPU trace hash check — host broadcasts periodically
    if (_fpuTraceEnabled && _playerSlot === 0 && _frameNum - _fpuTraceLastCheckFrame >= _FPU_TRACE_CHECK_INTERVAL) {
      _fpuTraceLastCheckFrame = _frameNum;
      const traceInfo = _fpuTraceHash();
      if (traceInfo) {
        for (const p of Object.values(_peers)) {
          if (p.dc?.readyState === 'open') {
            try {
              p.dc.send(`fpu-trace:${_frameNum}:${traceInfo.hash}:${traceInfo.count}`);
            } catch (_) {}
          }
        }
      }
    }
```

- [ ] **Step 6: Handle incoming FPU trace messages on guest**

In the DataChannel `onmessage` handler (the string message branch, near the `sync-hash:` handler around line 1565), add:

```js
        if (e.data.startsWith('fpu-trace:')) {
          if (!_fpuTraceEnabled) return;
          const parts = e.data.split(':');
          const hostFrame = parseInt(parts[1], 10);
          const hostHash = parseInt(parts[2], 10);
          const hostCount = parseInt(parts[3], 10);
          const local = _fpuTraceHash();
          if (!local) return;
          if (local.hash === hostHash) {
            if (!_fpuTraceVerified) {
              _syncLog(`FPU trace MATCH: ${local.count} ops verified (frame ${hostFrame})`);
              _fpuTraceVerified = true;
            }
          } else {
            _syncLog(`FPU trace MISMATCH at frame ${hostFrame}! host_hash=${hostHash} local_hash=${local.hash} host_count=${hostCount} local_count=${local.count}`);
            // Dump recent trace entries for analysis
            const entries = _fpuTraceExtract(Math.max(0, hostFrame - 300), hostFrame);
            _syncLog(`FPU trace dump (last ${entries.length} entries):`);
            for (const ent of entries.slice(0, 20)) {
              _syncLog(`  frame=${ent.frame} op=${_FPU_OP_NAMES[ent.op] ?? ent.op} in1=0x${ent.in1} in2=0x${ent.in2} out=0x${ent.out}`);
            }
            // Upload via debug-sync for offline analysis
            if (socket) {
              socket.emit('debug-sync', {
                type: 'fpu-trace-mismatch',
                frame: hostFrame,
                hostHash, localHash: local.hash,
                hostCount, localCount: local.count,
                entries: entries.slice(0, 100),
              });
            }
          }
          return;
        }
```

- [ ] **Step 7: Commit**

```bash
cd /Users/kazon/kaillera-next
git add web/static/netplay-lockstep.js
git commit -m "feat: FPU trace hash exchange for cross-platform determinism verification"
```

### Task 5: Verify everything applies cleanly

- [ ] **Step 1: Test patch application sequence**

```bash
cd /Users/kazon/kaillera-next/build/src/mupen64plus-libretro-nx
git checkout -- .

# Apply in build.sh order
git apply ../../patches/mupen64plus-kn-all.patch
git apply --exclude='mupen64plus-core/src/main/main.c' ../../patches/mupen64plus-deterministic-timing.patch 2>/dev/null || true
git apply --exclude='mupen64plus-core/src/main/main.c' ../../patches/mupen64plus-wasm-determinism.patch 2>/dev/null || true
git apply ../../patches/mupen64plus-fpu-trace.patch

echo "All patches applied successfully"
git checkout -- .
```

Expected: All patches apply without errors.

- [ ] **Step 2: Verify trace code compiles**

Spot-check that the extern declarations in fpu.h reference the same types as the definitions in main.c. The `kn_fpu_trace_entry` typedef must be identical in both files.

- [ ] **Step 3: Commit any fixups**

If any patches needed adjustment, commit the fixes:
```bash
cd /Users/kazon/kaillera-next
git add build/patches/
git commit -m "fix: patch application order and compatibility"
```
