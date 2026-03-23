# C-Level Resync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken `getState()`/`loadState()` resync path with C-level WASM exports that read/write emulator state directly, eliminating memory growth cascades and enabling seamless, invisible resyncs on all platforms including mobile.

**Architecture:** Three new `EMSCRIPTEN_KEEPALIVE` C functions (`kn_sync_read`, `kn_sync_write`, `kn_sync_hash`) in the RetroArch platform driver that directly access `g_dev` struct fields. JS orchestrates: C reads/writes state, JS handles delta compression and WebRTC transport. No `retro_serialize`/`retro_unserialize` in the resync path.

**Tech Stack:** C (mupen64plus-next core internals), Emscripten WASM exports, JavaScript (netplay-lockstep.js), Docker (WASM core build)

**Spec:** `docs/superpowers/specs/2026-03-23-c-level-resync-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `build/src/RetroArch/frontend/drivers/platform_emulatorjs.c` | Modify | Add `kn_sync_read`, `kn_sync_write`, `kn_sync_hash` exports |
| `build/src/RetroArch/Makefile.emulatorjs` | Modify | Add new exports to `EXPORTED_FUNCTIONS` |
| `build/build.sh` | Modify | Remove `git checkout -- .` lines |
| `web/static/netplay-lockstep.js` | Modify | Replace hash/resync paths with C-level calls |

---

## Chunk 1: Branch Setup & Build System

### Task 1: Create feature branch

**Files:**
- None (git operations only)

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout -b feat/c-level-resync mvp-p0-implementation
```

- [ ] **Step 2: Commit**

```bash
git commit --allow-empty -m "feat: start c-level resync branch"
```

---

### Task 2: Update build.sh to preserve source edits

**Files:**
- Modify: `build/build.sh:46-59`

- [ ] **Step 1: Remove the `git checkout -- .` lines**

In `build/build.sh`, the patch application block does `git checkout -- . 2>/dev/null || true` before applying each patch. Remove those lines so direct source edits persist across builds.

Remove line 47 (`git checkout -- . 2>/dev/null || true` in the RetroArch block) and line 55 (`git checkout -- . 2>/dev/null || true` in the mupen64plus block).

The `git apply` calls can stay — they'll no-op if patches are already applied.

- [ ] **Step 2: Commit**

```bash
git add build/build.sh
git commit -m "build: stop resetting source trees before patch apply"
```

---

### Task 3: Add new exports to EXPORTED_FUNCTIONS

**Files:**
- Modify: `build/src/RetroArch/Makefile.emulatorjs:130-131`

- [ ] **Step 1: Add the three new exports**

In `Makefile.emulatorjs`, after the existing `_kn_get_audio_rate` export on line 131, add a continuation line:

```makefile
                     _kn_get_audio_ptr,_kn_get_audio_samples,_kn_reset_audio,_kn_get_audio_rate, \
                     _kn_sync_read,_kn_sync_write,_kn_sync_hash
```

(Replace the existing line 131 which ends without a backslash.)

- [ ] **Step 2: Commit**

```bash
git add build/src/RetroArch/Makefile.emulatorjs
git commit -m "build: add kn_sync_read/write/hash to EXPORTED_FUNCTIONS"
```

---

## Chunk 2: C-Level Exports

### Task 4: Implement `kn_sync_hash()` in C

This is the simplest export — start here to validate the build pipeline.

**Files:**
- Modify: `build/src/RetroArch/frontend/drivers/platform_emulatorjs.c:152` (after `kn_set_deterministic`)

- [ ] **Step 1: Add includes and kn_sync_hash**

After the existing `kn_set_deterministic` function (line 152), add:

```c
/* kaillera-next: Direct state sync for lockstep netplay resync.
 * Bypasses retro_serialize/retro_unserialize to avoid WASM memory growth
 * and HEAPU8 buffer detachment that causes resync cascades on mobile. */

/* Access to mupen64plus core internals */
#include "../../cores/libretro-mupen64plus-nx/mupen64plus-core/src/main/main.h"
#include "../../cores/libretro-mupen64plus-nx/mupen64plus-core/src/device/device.h"
#include "../../cores/libretro-mupen64plus-nx/mupen64plus-core/src/device/memory/memory.h"

EMSCRIPTEN_KEEPALIVE uint32_t kn_sync_hash(void)
{
   /* FNV-1a hash of SSB64 VS mode RDRAM regions.
    * Same regions verified by Playwright MCP visual scan.
    * Computed entirely in C — no HEAPU8, no JS boundary. */
   const uint8_t *rdram = (const uint8_t *)g_dev.rdram.dram;
   uint32_t hash = 2166136261u; /* FNV offset basis */
   int i;

   /* Sample points matching the JS getHashBytes() regions */
   static const uint32_t regions[] = {
      0xA4000,  0xBA000,  0xBF000,  0xC4000,
      0x262000, 0x266000, 0x26A000, 0x290000,
      0x2F6000, 0x32B000, 0x330000, 0x335000
   };
   static const int SAMPLE = 256;
   int r;

   for (r = 0; r < 12; r++)
   {
      const uint8_t *p = rdram + regions[r];
      for (i = 0; i < SAMPLE; i++)
      {
         hash ^= p[i];
         hash *= 16777619u; /* FNV prime */
      }
   }
   return hash;
}
```

**Important:** The include path assumes the mupen64plus source is at `../../cores/libretro-mupen64plus-nx/`. This may need adjusting based on the actual symlink/path structure in the RetroArch build. Check: the existing code in `savestates.c` accesses `g_dev` via `#include "main/main.h"`. Since `platform_emulatorjs.c` is in RetroArch (not the core), we need the relative path to the core's headers. If the include path doesn't work, use `extern struct device g_dev;` forward declaration instead — the linker will resolve it since both compile into the same WASM binary.

- [ ] **Step 2: Verify include path or use extern fallback**

Check if the include path resolves. If not, replace the includes with:

```c
/* Forward declarations — resolved at link time (same WASM binary) */
struct device;
extern struct device g_dev;
```

And for RDRAM access, use the offset known from the save state format: `g_dev.rdram.dram` is the 8MB RDRAM array. You need `device.h` to know the struct layout. The safest approach is `extern` for `g_dev` + the struct definition.

Alternatively, since `savestates.c` in the core already links with this file, add a helper function in the core that the platform driver can call:

```c
/* In mupen64plus-core/src/main/main.c (add near kn_get_cycle_time_ms): */
EMSCRIPTEN_KEEPALIVE const uint8_t* kn_get_rdram_ptr(void)
{
    return (const uint8_t*)g_dev.rdram.dram;
}

EMSCRIPTEN_KEEPALIVE uint32_t kn_get_rdram_size(void)
{
    return RDRAM_MAX_SIZE;
}
```

Then `platform_emulatorjs.c` can call `kn_get_rdram_ptr()` without needing the core headers. This is the cleanest approach if include paths are problematic.

- [ ] **Step 3: Commit**

```bash
git add build/src/RetroArch/frontend/drivers/platform_emulatorjs.c
git commit -m "feat: add kn_sync_hash — C-level FNV-1a of SSB64 RDRAM regions"
```

---

### Task 5: Implement `kn_sync_read()` in C

**Files:**
- Modify: `build/src/RetroArch/frontend/drivers/platform_emulatorjs.c` (after `kn_sync_hash`)
- May also modify: `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/main.c` (if adding helper functions)

- [ ] **Step 1: Add kn_sync_read**

This function copies gameplay-critical state into a caller-provided buffer. The layout uses a simple header followed by fixed-order sections. Add after `kn_sync_hash`:

```c
/* kn_sync_read: Serialize gameplay-critical state into buf.
 * Returns bytes written. Caller must provide buf of at least 8MB + 16KB.
 *
 * Layout: [header 16B] [RDRAM 8MB] [GPR 256B] [CP0 128B] [CP0_extras 8B]
 *         [CP1 256B] [CP1_ctl 8B] [llbit+hi+lo 20B] [PC 4B]
 *         [VI 8B] [TLB 32*48B] [EventQueue 1024B] [SP_MEM 8KB] [PIF 64B]
 */
EMSCRIPTEN_KEEPALIVE uint32_t kn_sync_read(uint8_t *buf, uint32_t max_size)
{
   struct device *dev = &g_dev;
   uint8_t *p = buf;
   uint32_t *header;
   int i;
   char queue[1024];

   if (!buf || max_size < RDRAM_MAX_SIZE + 16384)
      return 0;

   /* Header: magic + version + total size (filled at end) */
   header = (uint32_t *)p;
   header[0] = 0x4B4E5331; /* "KNS1" */
   header[1] = 1;           /* version */
   header[2] = 0;           /* total size (filled below) */
   header[3] = 0;           /* reserved */
   p += 16;

   /* RDRAM (8MB) */
   memcpy(p, dev->rdram.dram, RDRAM_MAX_SIZE);
   p += RDRAM_MAX_SIZE;

   /* R4300 GPR (32 x int64 = 256B) */
   memcpy(p, r4300_regs((struct r4300_core *)&dev->r4300), 32 * sizeof(int64_t));
   p += 32 * sizeof(int64_t);

   /* CP0 regs (CP0_REGS_COUNT x uint32) */
   {
      const uint32_t *cp0 = r4300_cp0_regs((struct cp0 *)&dev->r4300.cp0);
      memcpy(p, cp0, CP0_REGS_COUNT * sizeof(uint32_t));
      p += CP0_REGS_COUNT * sizeof(uint32_t);
   }

   /* CP0 extras: next_interrupt + cycle_count */
   {
      uint32_t next_int = *r4300_cp0_next_interrupt((struct cp0 *)&dev->r4300.cp0);
      uint32_t cycle_count = dev->r4300.cp0.regs[CP0_COUNT_REG];
      memcpy(p, &next_int, 4); p += 4;
      memcpy(p, &cycle_count, 4); p += 4;
   }

   /* CP1 regs (32 x int64 = 256B) */
   {
      const cp1_reg *cp1 = r4300_cp1_regs((struct cp1 *)&dev->r4300.cp1);
      memcpy(p, &cp1->dword, 32 * sizeof(int64_t));
      p += 32 * sizeof(int64_t);
   }

   /* CP1 control: fcr0 + fcr31 */
   {
      uint32_t fcr0 = *r4300_cp1_fcr0((struct cp1 *)&dev->r4300.cp1);
      uint32_t fcr31 = *r4300_cp1_fcr31((struct cp1 *)&dev->r4300.cp1);
      memcpy(p, &fcr0, 4); p += 4;
      memcpy(p, &fcr31, 4); p += 4;
   }

   /* llbit + hi + lo + PC */
   {
      uint32_t llbit = *r4300_llbit((struct r4300_core *)&dev->r4300);
      int64_t hi = *r4300_mult_hi((struct r4300_core *)&dev->r4300);
      int64_t lo = *r4300_mult_lo((struct r4300_core *)&dev->r4300);
      uint32_t pc = *r4300_pc((struct r4300_core *)&dev->r4300);
      memcpy(p, &llbit, 4); p += 4;
      memcpy(p, &hi, 8); p += 8;
      memcpy(p, &lo, 8); p += 8;
      memcpy(p, &pc, 4); p += 4;
   }

   /* VI timing: field + delay */
   {
      uint32_t vi_field = dev->vi.field;
      uint32_t vi_delay = dev->vi.delay;
      memcpy(p, &vi_field, 4); p += 4;
      memcpy(p, &vi_delay, 4); p += 4;
   }

   /* TLB entries (32 x ~48B) — raw struct copy */
   for (i = 0; i < 32; i++)
   {
      memcpy(p, &dev->r4300.cp0.tlb.entries[i], sizeof(dev->r4300.cp0.tlb.entries[i]));
      p += sizeof(dev->r4300.cp0.tlb.entries[i]);
   }

   /* Event queue (1024B) */
   save_eventqueue_infos(&dev->r4300.cp0, queue);
   memcpy(p, queue, sizeof(queue));
   p += sizeof(queue);

   /* SP memory (8KB) */
   memcpy(p, dev->sp.mem, SP_MEM_SIZE);
   p += SP_MEM_SIZE;

   /* PIF RAM (64B) */
   memcpy(p, dev->pif.ram, PIF_RAM_SIZE);
   p += PIF_RAM_SIZE;

   /* Fill header total size */
   header[2] = (uint32_t)(p - buf);

   return (uint32_t)(p - buf);
}
```

**Note on includes:** This function uses types like `cp1_reg`, `CP0_REGS_COUNT`, `RDRAM_MAX_SIZE` etc. These require the mupen64plus core headers. If include paths from `platform_emulatorjs.c` can't reach them, the cleanest solution is to put `kn_sync_read`/`kn_sync_write`/`kn_sync_hash` in `mupen64plus-core/src/main/main.c` instead (next to the existing `kn_get_cycle_time_ms`), where all headers are already available. Then just add the exports to `EXPORTED_FUNCTIONS`. This is a pragmatic decision to make at build time.

- [ ] **Step 2: Commit**

```bash
git add build/src/RetroArch/frontend/drivers/platform_emulatorjs.c
git commit -m "feat: add kn_sync_read — serialize gameplay state to buffer"
```

---

### Task 6: Implement `kn_sync_write()` in C

**Files:**
- Modify: `build/src/RetroArch/frontend/drivers/platform_emulatorjs.c` (after `kn_sync_read`)

- [ ] **Step 1: Add kn_sync_write**

This is the most complex function. It reverses `kn_sync_read` and calls post-restore functions. Add after `kn_sync_read`:

```c
/* kn_sync_write: Restore gameplay-critical state from buf.
 * Returns 0 on success, -1 on error.
 * Modeled on savestates_load_m64p restore sequence. */
EMSCRIPTEN_KEEPALIVE int kn_sync_write(const uint8_t *buf, uint32_t size)
{
   struct device *dev = &g_dev;
   const uint8_t *p = buf;
   const uint32_t *header;
   int i;
   char queue[1024];
   uint32_t pc_val;
   uint32_t fcr31_val;

   if (!buf || size < 16)
      return -1;

   /* Validate header */
   header = (const uint32_t *)p;
   if (header[0] != 0x4B4E5331 || header[1] != 1)
      return -1;
   p += 16;

   /* RDRAM (8MB) */
   memcpy(dev->rdram.dram, p, RDRAM_MAX_SIZE);
   p += RDRAM_MAX_SIZE;

   /* R4300 GPR */
   memcpy(r4300_regs((struct r4300_core *)&dev->r4300), p, 32 * sizeof(int64_t));
   p += 32 * sizeof(int64_t);

   /* CP0 regs */
   {
      uint32_t *cp0 = (uint32_t *)r4300_cp0_regs((struct cp0 *)&dev->r4300.cp0);
      memcpy(cp0, p, CP0_REGS_COUNT * sizeof(uint32_t));
      p += CP0_REGS_COUNT * sizeof(uint32_t);
   }

   /* CP0 extras */
   {
      uint32_t next_int, cycle_count;
      memcpy(&next_int, p, 4); p += 4;
      memcpy(&cycle_count, p, 4); p += 4;
      *r4300_cp0_next_interrupt((struct cp0 *)&dev->r4300.cp0) = next_int;
      dev->r4300.cp0.regs[CP0_COUNT_REG] = cycle_count;
   }

   /* CP1 regs */
   {
      cp1_reg *cp1 = (cp1_reg *)r4300_cp1_regs((struct cp1 *)&dev->r4300.cp1);
      memcpy(&cp1->dword, p, 32 * sizeof(int64_t));
      p += 32 * sizeof(int64_t);
   }

   /* CP1 control */
   {
      uint32_t fcr0;
      memcpy(&fcr0, p, 4); p += 4;
      memcpy(&fcr31_val, p, 4); p += 4;
      *r4300_cp1_fcr0((struct cp1 *)&dev->r4300.cp1) = fcr0;
      *r4300_cp1_fcr31((struct cp1 *)&dev->r4300.cp1) = fcr31_val;
   }

   /* llbit + hi + lo + PC */
   {
      uint32_t llbit;
      int64_t hi, lo;
      memcpy(&llbit, p, 4); p += 4;
      memcpy(&hi, p, 8); p += 8;
      memcpy(&lo, p, 8); p += 8;
      memcpy(&pc_val, p, 4); p += 4;
      *r4300_llbit((struct r4300_core *)&dev->r4300) = llbit;
      *r4300_mult_hi((struct r4300_core *)&dev->r4300) = hi;
      *r4300_mult_lo((struct r4300_core *)&dev->r4300) = lo;
      /* PC set via savestates_load_set_pc below */
   }

   /* VI timing */
   {
      uint32_t vi_field, vi_delay;
      memcpy(&vi_field, p, 4); p += 4;
      memcpy(&vi_delay, p, 4); p += 4;
      dev->vi.field = vi_field;
      dev->vi.delay = vi_delay;
   }

   /* TLB entries — restore entries then rebuild LUT tables (PJ64-style) */
   /* First: clear LUT tables */
   memset(dev->r4300.cp0.tlb.LUT_r, 0, 0x400000);
   memset(dev->r4300.cp0.tlb.LUT_w, 0, 0x400000);

   for (i = 0; i < 32; i++)
   {
      memcpy(&dev->r4300.cp0.tlb.entries[i], p,
             sizeof(dev->r4300.cp0.tlb.entries[i]));
      p += sizeof(dev->r4300.cp0.tlb.entries[i]);

      /* Rebuild LUT mapping for this entry */
      tlb_map(&dev->r4300.cp0.tlb, i);
   }

   /* Event queue */
   memcpy(queue, p, sizeof(queue));
   p += sizeof(queue);
   load_eventqueue_infos(&dev->r4300.cp0, queue);

   /* SP memory */
   memcpy(dev->sp.mem, p, SP_MEM_SIZE);
   p += SP_MEM_SIZE;

   /* PIF RAM + channel format rebuild */
   memcpy(dev->pif.ram, p, PIF_RAM_SIZE);
   p += PIF_RAM_SIZE;
   setup_channels_format(&dev->pif);

   /* Post-restore calls (modeled on savestates_load_m64p) */
   {
      const uint32_t *cp0 = r4300_cp0_regs((struct cp0 *)&dev->r4300.cp0);

      /* 1. FPR pointer setup — must happen after CP0 STATUS and CP1 regs are set */
      set_fpr_pointers(&dev->r4300.cp1, cp0[CP0_STATUS_REG]);
      update_x86_rounding_mode(&dev->r4300.cp1);

      /* 2. PC restoration — updates instruction pipeline, invalidates cached code */
      savestates_load_set_pc(&dev->r4300, pc_val);
   }

   return 0;
}
```

**Key references for correctness:**
- TLB rebuild: follows PJ64 path at `savestates.c:1281-1318`
- Post-restore: follows m64p path at `savestates.c:538-539` (set_fpr_pointers, update_x86_rounding_mode), `savestates.c:568` (savestates_load_set_pc), `savestates.c:577` (load_eventqueue_infos), `savestates.c:1010` (setup_channels_format)

**Required includes** (add to the include block with kn_sync_hash):

```c
#include "../../cores/libretro-mupen64plus-nx/mupen64plus-core/src/device/r4300/r4300_core.h"
#include "../../cores/libretro-mupen64plus-nx/mupen64plus-core/src/device/r4300/cp0.h"
#include "../../cores/libretro-mupen64plus-nx/mupen64plus-core/src/device/r4300/cp1.h"
#include "../../cores/libretro-mupen64plus-nx/mupen64plus-core/src/device/r4300/tlb.h"
#include "../../cores/libretro-mupen64plus-nx/mupen64plus-core/src/device/pif/pif.h"
#include "../../cores/libretro-mupen64plus-nx/mupen64plus-core/src/device/rcp/rsp/rsp_core.h"
#include "../../cores/libretro-mupen64plus-nx/mupen64plus-core/src/main/savestates.h"
```

Or if include paths fail, move all three functions to `mupen64plus-core/src/main/main.c` where headers are already available.

- [ ] **Step 2: Commit**

```bash
git add build/src/RetroArch/frontend/drivers/platform_emulatorjs.c
git commit -m "feat: add kn_sync_write — restore state with TLB rebuild"
```

---

### Task 7: Build and validate WASM core

**Files:**
- None (build + manual test)

- [ ] **Step 1: Build the Docker image (if not already built)**

```bash
cd /Users/kazon/kaillera-next
docker build -t emulatorjs-builder build/
```

- [ ] **Step 2: Build the WASM core**

```bash
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash -c "cd /build/src/RetroArch && emmake make -f Makefile.emulatorjs clean; bash /build/build.sh"
```

This will take several minutes. Watch for compilation errors in the new C code.

**If include path errors:** Move the three functions to `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/main.c` (after the existing `kn_get_cycle_time_ms`), add `EMSCRIPTEN_KEEPALIVE` and the necessary local includes, and rebuild.

- [ ] **Step 3: Deploy the new core**

```bash
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
```

- [ ] **Step 4: Verify exports exist**

Open browser console on `localhost:8000`, load a ROM, then check:

```javascript
var mod = EJS_emulator.gameManager.Module;
console.log('sync_hash:', typeof mod._kn_sync_hash);
console.log('sync_read:', typeof mod._kn_sync_read);
console.log('sync_write:', typeof mod._kn_sync_write);
```

Expected: all three should log `'function'`.

- [ ] **Step 5: Quick smoke test kn_sync_hash**

```javascript
var hash = mod._kn_sync_hash();
console.log('hash:', hash);
// Run the emulator for a few frames, hash again
setTimeout(() => console.log('hash after:', mod._kn_sync_hash()), 1000);
```

The two hashes should differ (game state changed between frames).

- [ ] **Step 6: Commit (if any build fixes were needed)**

```bash
git add build/
git commit -m "fix: resolve build issues for kn_sync exports"
```

---

## Chunk 3: JS Integration — Hash Path

### Task 8: Replace JS hash check with C-level kn_sync_hash

**Files:**
- Modify: `web/static/netplay-lockstep.js:2008-2033` (periodic desync check in tick)
- Modify: `web/static/netplay-lockstep.js:2389-2473` (getHashBytes function)
- Modify: `web/static/netplay-lockstep.js:822-860` (guest hash comparison on sync-hash message)
- Modify: `web/static/netplay-lockstep.js:1980-2005` (deferred sync check)

- [ ] **Step 1: Add feature detection at init**

In the `startSync()` function (around line 1700), after the `window._lockstepActive = true;` line, add:

```javascript
// C-level sync: detect patched core with kn_sync exports
var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
          window.EJS_emulator.gameManager.Module;
_hasKnSync = !!(mod && mod._kn_sync_hash && mod._kn_sync_read && mod._kn_sync_write);
if (_hasKnSync) {
  _syncBufSize = 8 * 1024 * 1024 + 16384;
  _syncBufPtr = mod._malloc(_syncBufSize);
  console.log('[lockstep] C-level sync available, buf at', _syncBufPtr);
} else {
  console.log('[lockstep] C-level sync NOT available, using getState/loadState fallback');
}
```

Add the variables to the module-level declarations (around line 300):

```javascript
let _hasKnSync = false;
let _syncBufPtr = 0;
let _syncBufSize = 0;
```

- [ ] **Step 2: Replace host hash check in tick loop**

In the periodic desync check block (lines ~2008-2033), replace the `getHashBytes()` + worker hash path:

```javascript
// -- Periodic desync check (star topology: host-only) -----
if (_syncEnabled && _playerSlot === 0 && _frameNum > 0 &&
    _frameNum % _syncCheckInterval === 0) {
  if (_hasKnSync) {
    // C-level hash — synchronous, no HEAPU8, no worker
    var mod = window.EJS_emulator.gameManager.Module;
    var hash = mod._kn_sync_hash();
    var syncMsg = 'sync-hash:' + _frameNum + ':' + hash;
    var peers = getActivePeers();
    var sent = 0;
    for (var s = 0; s < peers.length; s++) {
      try { peers[s].dc.send(syncMsg); sent++; } catch (_) {}
    }
    if (_frameNum % (_syncCheckInterval * 10) === 0) {
      _streamSync('sync-check frame=' + _frameNum + ' hash=' + hash + ' sent=' + sent);
    }
  } else {
    // Fallback: existing getHashBytes + worker path
    var hashBytes = getHashBytes();
    if (hashBytes) {
      var checkFrame = _frameNum;
      var peers = getActivePeers();
      workerPost({ type: 'hash', data: hashBytes }).then(function (res) {
        var syncMsg = 'sync-hash:' + checkFrame + ':' + res.hash;
        var sent = 0;
        for (var s = 0; s < peers.length; s++) {
          try { peers[s].dc.send(syncMsg); sent++; } catch (_) {}
        }
      }).catch(function () {});
    }
  }
}
```

- [ ] **Step 3: Replace guest hash comparison on sync-hash message**

In the `ch.onmessage` handler where `e.data.startsWith('sync-hash:')` (lines ~822-860), replace the guest hash check:

```javascript
if (e.data.startsWith('sync-hash:')) {
  if (peer.slot !== 0) return;
  if (_pendingResyncState) return;
  var parts = e.data.split(':');
  var syncFrame = parseInt(parts[1], 10);
  var hostHash = parseInt(parts[2], 10);
  var frameDiff = _frameNum - syncFrame;

  if (_frameNum === syncFrame || (_frameNum > syncFrame && frameDiff <= 2)) {
    if (_hasKnSync) {
      // C-level hash — synchronous comparison
      var mod = window.EJS_emulator.gameManager.Module;
      var guestHash = mod._kn_sync_hash();
      if (guestHash !== hostHash) {
        console.log('[lockstep] DESYNC at frame', syncFrame, 'host:', hostHash, 'guest:', guestHash);
        var now = performance.now();
        if (now - _lastResyncTime > 10000) {
          _lastResyncTime = now;
          try { peer.dc.send('sync-request'); } catch (_) {}
        }
      } else {
        _consecutiveResyncs = 0;
        _syncCheckInterval = _syncBaseInterval;
      }
    } else {
      // Fallback: existing async hash comparison
      try {
        var guestBytes = getHashBytes();
        if (!guestBytes) return;
        var peerRef = peer;
        workerPost({ type: 'hash', data: guestBytes }).then(function (res) {
          if (res.hash !== hostHash) {
            console.log('[lockstep] DESYNC at frame', syncFrame);
            var now = performance.now();
            if (!_pendingResyncState && now - _lastResyncTime > 10000) {
              _lastResyncTime = now;
              try { peerRef.dc.send('sync-request'); } catch (_) {}
            }
          } else {
            _consecutiveResyncs = 0;
            _syncCheckInterval = _syncBaseInterval;
          }
        }).catch(function () {});
      } catch (_) {}
    }
  } else if (_frameNum < syncFrame) {
    // Behind host — defer check
    _pendingSyncCheck = { frame: syncFrame, hash: hostHash, peerSid: remoteSid };
  }
}
```

- [ ] **Step 4: Update deferred sync check**

In the deferred sync check block (lines ~1980-2005), add the `_hasKnSync` branch:

```javascript
if (_pendingSyncCheck && _frameNum >= _pendingSyncCheck.frame) {
  if (_frameNum - _pendingSyncCheck.frame <= 2) {
    if (_hasKnSync) {
      var mod = window.EJS_emulator.gameManager.Module;
      var guestHash = mod._kn_sync_hash();
      if (guestHash !== _pendingSyncCheck.hash) {
        console.log('[lockstep] DESYNC (deferred) at frame', _pendingSyncCheck.frame);
        var now = performance.now();
        if (!_pendingResyncState && now - _lastResyncTime > 10000) {
          _lastResyncTime = now;
          var sp = _peers[_pendingSyncCheck.peerSid];
          if (sp && sp.dc) { try { sp.dc.send('sync-request'); } catch (_) {} }
        }
      } else {
        _consecutiveResyncs = 0;
        _syncCheckInterval = _syncBaseInterval;
      }
    } else {
      // Existing fallback path
      try {
        var deferBytes = getHashBytes();
        if (deferBytes) {
          var deferCheck = _pendingSyncCheck;
          workerPost({ type: 'hash', data: deferBytes }).then(function (res) {
            if (res.hash !== deferCheck.hash) {
              var now3 = performance.now();
              if (!_pendingResyncState && now3 - _lastResyncTime > 10000) {
                _lastResyncTime = now3;
                var sp = _peers[deferCheck.peerSid];
                if (sp && sp.dc) { try { sp.dc.send('sync-request'); } catch (_) {} }
              }
            } else {
              _consecutiveResyncs = 0;
              _syncCheckInterval = _syncBaseInterval;
            }
          }).catch(function () {});
        }
      } catch (_) {}
    }
  }
  _pendingSyncCheck = null;
}
```

- [ ] **Step 5: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: use kn_sync_hash for desync detection — no HEAPU8 reads"
```

---

## Chunk 4: JS Integration — Resync Path

### Task 9: Replace pushSyncState with kn_sync_read

**Files:**
- Modify: `web/static/netplay-lockstep.js:2481-2523` (pushSyncState function)

- [ ] **Step 1: Add kn_sync_read-based pushSyncState**

Replace the `pushSyncState` function:

```javascript
function pushSyncState(targetSid) {
  if (_playerSlot !== 0 || !_syncEnabled) return;
  if (_pushingSyncState) return;

  var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
  if (!gm) return;
  _pushingSyncState = true;

  if (_hasKnSync) {
    // C-level: read state directly from g_dev — no getState(), no memory growth
    var mod = gm.Module;
    var ps0 = performance.now();
    var bytesWritten = mod._kn_sync_read(_syncBufPtr, _syncBufSize);
    var ps1 = performance.now();

    if (bytesWritten === 0) {
      console.log('[lockstep] kn_sync_read returned 0');
      _pushingSyncState = false;
      return;
    }

    // Read bytes from WASM buffer into JS
    var currentState = new Uint8Array(mod.HEAPU8.buffer, _syncBufPtr, bytesWritten).slice();
    var frame = _frameNum;

    _streamSync('host kn_sync_read: ' + Math.round(currentState.length / 1024) + 'KB, ' +
      (ps1 - ps0).toFixed(1) + 'ms');

    // Delta: XOR against last synced state.
    // _lastSyncState is the state bytes from the last completed resync
    // (or null if no resync yet). Both host and guest cache this after
    // each resync so the XOR base is identical on both sides.
    var isFull = !_lastSyncState || _lastSyncState.length !== currentState.length;
    var toCompress;
    if (isFull) {
      toCompress = currentState;
    } else {
      toCompress = new Uint8Array(currentState.length);
      for (var i = 0; i < currentState.length; i++) {
        toCompress[i] = currentState[i] ^ _lastSyncState[i];
      }
    }
    // Update delta base to current host state (guest will cache
    // the reconstructed state after applying, keeping them in sync)
    _lastSyncState = currentState;

    compressState(toCompress).then(function (compressed) {
      _streamSync((isFull ? 'full' : 'delta') + ' state: ' +
        Math.round(compressed.length / 1024) + 'KB compressed');
      sendSyncChunks(compressed, frame, isFull, targetSid);
    }).catch(function (err) {
      console.log('[lockstep] sync compress failed:', err);
    }).finally(function () {
      _pushingSyncState = false;
    });
  } else {
    // Fallback: existing getState path
    var ps0 = performance.now();
    var raw = gm.getState();
    var ps1 = performance.now();
    var currentState = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    var frame = _frameNum;
    _streamSync('host getState: ' + Math.round(currentState.length / 1024) + 'KB, ' +
      (ps1 - ps0).toFixed(1) + 'ms');

    var isFull = !_lastSyncState || _lastSyncState.length !== currentState.length;
    var toCompress;
    if (isFull) {
      toCompress = currentState;
    } else {
      toCompress = new Uint8Array(currentState.length);
      for (var i = 0; i < currentState.length; i++) {
        toCompress[i] = currentState[i] ^ _lastSyncState[i];
      }
    }
    _lastSyncState = new Uint8Array(currentState);

    compressState(toCompress).then(function (compressed) {
      _streamSync((isFull ? 'full' : 'delta') + ' state: ' +
        Math.round(compressed.length / 1024) + 'KB compressed');
      sendSyncChunks(compressed, frame, isFull, targetSid);
    }).catch(function (err) {
      console.log('[lockstep] sync compress failed:', err);
    }).finally(function () {
      _pushingSyncState = false;
    });
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: use kn_sync_read for host state capture — no getState()"
```

---

### Task 10: Replace applySyncState with kn_sync_write

**Files:**
- Modify: `web/static/netplay-lockstep.js:2556-2597` (handleSyncChunksComplete)
- Modify: `web/static/netplay-lockstep.js:2599-2647` (applySyncState)

- [ ] **Step 1: Update handleSyncChunksComplete for guest delta bookkeeping**

The guest needs its own `_lastSyncState` for delta reconstruction. When using `_hasKnSync`, the guest reads its current state via `_kn_sync_read` before applying the delta:

```javascript
function handleSyncChunksComplete() {
  var total = _syncChunks.reduce((a, c) => a + c.length, 0);
  var assembled = new Uint8Array(total);
  var offset = 0;
  for (var i = 0; i < _syncChunks.length; i++) {
    assembled.set(_syncChunks[i], offset);
    offset += _syncChunks[i].length;
  }
  _syncChunks = [];
  _syncExpected = 0;
  var frame = _syncFrame;
  var isFull = _syncIsFull;

  decompressState(assembled).then(function (decompressed) {
    if (isFull) {
      _pendingResyncState = { bytes: decompressed, frame: frame };
    } else {
      // Delta reconstruction: XOR delta against _lastSyncState (the
      // state from the last completed resync). Both host and guest
      // cached this after the previous resync, so they share the same
      // XOR base. This is NOT the guest's current (desynced) state.
      if (!_lastSyncState || _lastSyncState.length !== decompressed.length) {
        console.log('[lockstep] delta base missing or size mismatch, ignoring');
        return;
      }
      var reconstructed = new Uint8Array(_lastSyncState.length);
      for (var j = 0; j < _lastSyncState.length; j++) {
        reconstructed[j] = _lastSyncState[j] ^ decompressed[j];
      }
      _pendingResyncState = { bytes: reconstructed, frame: frame };
    }
    _streamSync('resync ready (' + (isFull ? 'full' : 'delta') + ', ' +
      Math.round(assembled.length / 1024) + 'KB wire)');
  }).catch(function (err) {
    console.log('[lockstep] sync decompress failed:', err);
  });
}
```

- [ ] **Step 2: Update applySyncState to use kn_sync_write**

Replace the `applySyncState` function:

```javascript
function applySyncState(bytes, frame) {
  var gm = window.EJS_emulator && window.EJS_emulator.gameManager;
  if (!gm) return;

  if (_hasKnSync) {
    // C-level write: copy into WASM buffer, call kn_sync_write
    var mod = gm.Module;
    mod.HEAPU8.set(bytes, _syncBufPtr);
    var lt0 = performance.now();
    var result = mod._kn_sync_write(_syncBufPtr, bytes.length);
    var lt1 = performance.now();

    if (result !== 0) {
      console.log('[lockstep] kn_sync_write failed:', result);
      return;
    }

    // Cache the applied state as delta base for next resync.
    // Host caches in pushSyncState; guest caches here after applying.
    _lastSyncState = bytes.slice();

    _resyncCount++;
    _consecutiveResyncs++;
    _streamSync('kn_sync_write: ' + Math.round(bytes.length / 1024) + 'KB, ' +
      (lt1 - lt0).toFixed(1) + 'ms');
  } else {
    // Fallback: existing loadState path
    var lt0 = performance.now();
    gm.loadState(bytes);
    var lt1 = performance.now();

    // Re-capture rAF runner
    var mod = gm.Module;
    mod.pauseMainLoop();
    mod.resumeMainLoop();

    // Fix HEAPU8 buffer detachment
    if (mod.updateMemoryViews) {
      mod.updateMemoryViews();
    } else if (mod._emscripten_notify_memory_growth) {
      mod._emscripten_notify_memory_growth(0);
    }
    _hashRegion = null;

    _resyncCount++;
    _consecutiveResyncs++;
    _streamSync('loadState: ' + Math.round(bytes.length / 1024) + 'KB, ' +
      (lt1 - lt0).toFixed(1) + 'ms');
  }

  // Purge stale remote inputs above the new frame
  Object.keys(_remoteInputs).forEach((slot) => {
    const inputs = _remoteInputs[slot];
    if (!inputs) return;
    Object.keys(inputs).forEach((f) => {
      if (parseInt(f, 10) > _frameNum + DELAY_FRAMES) delete inputs[f];
    });
  });

  var syncMsg = 'sync #' + _resyncCount + ' applied (frame ' + frame +
    ' -> ' + _frameNum + ', next in ' + _syncCheckInterval + 'f)';
  console.log('[lockstep] ' + syncMsg);
  _streamSync(syncMsg);
}
```

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: use kn_sync_write for guest state restore — no loadState()"
```

---

### Task 11: Clean up stopSync to free WASM buffer

**Files:**
- Modify: `web/static/netplay-lockstep.js:1829-1865` (stopSync function)

- [ ] **Step 1: Free the sync buffer on stop**

In `stopSync()`, add cleanup for the WASM buffer:

```javascript
// Free C-level sync buffer
if (_syncBufPtr && _hasKnSync) {
  var mod = window.EJS_emulator && window.EJS_emulator.gameManager &&
            window.EJS_emulator.gameManager.Module;
  if (mod && mod._free) mod._free(_syncBufPtr);
  _syncBufPtr = 0;
}
_hasKnSync = false;
_lastSyncState = null;
```

Add this before the existing `_resyncCount = 0;` line in `stopSync`.

Additionally, add `_lastSyncState = null;` to force full (non-delta) resync in these two places:

1. **Background return** — in the `visibilitychange` handler (around line 1812), add before the resync request:
```javascript
_lastSyncState = null;  // force full resync after background
```

2. **Reconnect completion** — in `setupDataChannel`'s `onopen` handler where `peer.reconnecting` is cleared (around line 770), add:
```javascript
_lastSyncState = null;  // force full resync after reconnect
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: free kn_sync buffer on stop, reset delta state"
```

---

## Chunk 5: Testing & Validation

### Task 12: Manual cross-platform testing

This is the primary validation. Automated tests for this feature aren't practical — it requires two browser instances, WebRTC connections, and game state to drift naturally.

**Files:**
- None (manual testing)

- [ ] **Step 1: Desktop 2-player test (same machine)**

1. Start dev server: `localhost:8000`
2. Open two incognito tabs, create room, join, start VS mode
3. Open console in both — look for:
   - `[lockstep] C-level sync available` on both tabs
   - `sync-check` messages from host
   - If a desync occurs: `kn_sync_write: XXXkB, X.Xms` (should be <3ms)
4. Verify: no visible hitch during resync

- [ ] **Step 2: Desktop + mobile test (cross-platform)**

1. Host on desktop, guest on phone (same network)
2. Play VS mode for 2+ minutes
3. Mobile will drift every ~25s — watch console for:
   - `DESYNC` detection
   - `kn_sync_write` completion (should be <3ms)
   - No cascade (no repeated resyncs within seconds)
4. Verify: gameplay feels smooth on mobile, no freezes

- [ ] **Step 3: Background tab test**

1. Desktop 2-player setup
2. Switch one tab to background for 5+ seconds
3. Switch back — should see:
   - `tab visible` log
   - `sync-request` sent
   - `kn_sync_write` applied
4. Verify: game resumes smoothly, no frozen screen

- [ ] **Step 4: DC reconnect test**

1. Desktop 2-player setup, game running
2. Disable network on one player briefly (2-3 seconds), re-enable
3. Should see:
   - `DC died — attempting reconnect`
   - `reconnected`
   - Resync via `kn_sync_write`
4. Verify: game continues after reconnect

- [ ] **Step 5: Stock core fallback test**

1. Temporarily move `web/static/ejs/cores/mupen64plus_next-wasm.data` aside
2. Let EmulatorJS fall back to CDN core
3. Start 2-player game
4. Verify console shows: `C-level sync NOT available, using getState/loadState fallback`
5. Verify: game still works (old resync path), no crashes
6. Restore the patched core file

- [ ] **Step 6: Commit any fixes discovered during testing**

```bash
git add -A
git commit -m "fix: address issues found during cross-platform testing"
```
