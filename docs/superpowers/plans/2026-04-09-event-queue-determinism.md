# Event Queue Determinism Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add diagnostic exports and a normalization function that resets the N64 event queue to a canonical state at every frame boundary, eliminating cross-platform CP0 Count drift.

**Architecture:** New C functions added to the existing `mupen64plus-kn-all.patch` alongside the other `kn_*` exports. The normalization clears and rebuilds the event queue with COUNT=0 each frame. JS calls the hash export for sync logging and the normalize export in classic lockstep mode; rollback mode calls it from C in `setup_frame()`.

**Tech Stack:** C (mupen64plus core patches), JavaScript (netplay-lockstep.js), WASM exports

**Spec:** `docs/superpowers/specs/2026-04-09-event-queue-determinism-design.md`

---

## Chunk 1: C-Level Exports

### Task 1: Add diagnostic and normalization functions to mupen64plus-kn-all.patch

**Files:**
- Modify: `build/patches/mupen64plus-kn-all.patch` (append new exports after the existing `kn_get_state_ptrs` block, around line 176 of the patched `main.c`)

The patch adds code to `mupen64plus-core/src/main/main.c`. All existing `kn_*` exports live there. Add the following functions after the `kn_sync_write_cpu` block.

- [ ] **Step 1: Add `kn_normalize_events` global and toggle functions**

Append to the `main.c` section of `mupen64plus-kn-all.patch`, after the `kn_sync_write_cpu` function (patch line 180):

```c
/* kaillera-next: Event queue normalization for cross-platform determinism.
 * When enabled, resets CP0 COUNT to 0 and rebuilds the event queue at
 * frame boundaries so all peers have identical interrupt scheduling. */
int kn_normalize_events_flag = 0;
EMSCRIPTEN_KEEPALIVE void kn_set_normalize_events(int enable) { kn_normalize_events_flag = enable; }
EMSCRIPTEN_KEEPALIVE int kn_get_normalize_events(void) { return kn_normalize_events_flag; }
```

- [ ] **Step 2: Add `kn_eventqueue_hash`**

```c
EMSCRIPTEN_KEEPALIVE uint32_t kn_eventqueue_hash(void) {
    struct cp0 *cp0 = &g_dev.r4300.cp0;
    uint32_t *cp0_regs = r4300_cp0_regs(cp0);
    uint32_t count = cp0_regs[CP0_COUNT_REG];
    struct node *e;
    uint32_t hash = 2166136261u;
    for (e = cp0->q.first; e != NULL; e = e->next) {
        uint32_t rel = e->data.count - count;
        hash ^= (uint32_t)e->data.type; hash *= 16777619u;
        hash ^= rel;                     hash *= 16777619u;
    }
    return hash;
}
```

- [ ] **Step 3: Add `kn_eventqueue_dump`**

```c
EMSCRIPTEN_KEEPALIVE uint32_t kn_eventqueue_dump(uint32_t *out, uint32_t max_u32s) {
    struct cp0 *cp0 = &g_dev.r4300.cp0;
    uint32_t *cp0_regs = r4300_cp0_regs(cp0);
    int *cycle_count = r4300_cp0_cycle_count(cp0);
    uint32_t count_reg = cp0_regs[CP0_COUNT_REG];
    struct node *e;
    uint32_t n = 0, idx = 5; /* header is 5 uint32s */
    if (max_u32s < 5) return 0;
    /* Header */
    out[0] = count_reg;
    out[1] = cp0_regs[CP0_COMPARE_REG];
    out[2] = (uint32_t)*cycle_count;
    out[3] = *r4300_cp0_next_interrupt(cp0);
    /* Count entries first */
    for (e = cp0->q.first; e != NULL; e = e->next) n++;
    out[4] = n;
    /* Entries: type, absolute count, relative offset */
    for (e = cp0->q.first; e != NULL && idx + 3 <= max_u32s; e = e->next) {
        out[idx++] = (uint32_t)e->data.type;
        out[idx++] = e->data.count;
        out[idx++] = e->data.count - count_reg;
    }
    return idx;
}
```

- [ ] **Step 4: Add `kn_normalize_event_queue`**

This is the core function. Uses the clear-and-rebuild approach from the spec.

```c
EMSCRIPTEN_KEEPALIVE void kn_normalize_event_queue(void) {
    struct cp0 *cp0 = &g_dev.r4300.cp0;
    uint32_t *cp0_regs = r4300_cp0_regs(cp0);
    int *cycle_count = r4300_cp0_cycle_count(cp0);
    uint32_t old_count = cp0_regs[CP0_COUNT_REG];
    struct node *e;
    /* Local array to hold serialized entries (max 16) */
    struct { int type; uint32_t rel; } saved[INTERRUPT_NODES_POOL_CAPACITY];
    int n = 0, i;

    /* Step 1: serialize as relative offsets, skip COMPARE and SPECIAL */
    for (e = cp0->q.first; e != NULL; e = e->next) {
        if (e->data.type == COMPARE_INT || e->data.type == SPECIAL_INT)
            continue;
        if (n >= INTERRUPT_NODES_POOL_CAPACITY) break;
        saved[n].type = e->data.type;
        saved[n].rel  = e->data.count - old_count;
        n++;
    }

    /* Step 2: clear queue completely */
    clear_queue(&cp0->q);

    /* Step 3: reset COUNT to 0 */
    cp0_regs[CP0_COUNT_REG] = 0;

    /* Step 4: re-add saved entries (rel offset is now absolute count) */
    for (i = 0; i < n; i++) {
        add_interrupt_event_count(cp0, saved[i].type, saved[i].rel);
    }

    /* Step 5: SPECIAL_INT at 2^31 boundary */
    add_interrupt_event_count(cp0, SPECIAL_INT, UINT32_C(0x80000000));

    /* Step 6: COMPARE_INT with count_per_op trick to avoid ordering
     * ambiguity when COUNT == COMPARE (same pattern as translate_event_queue) */
    cp0_regs[CP0_COUNT_REG] += cp0->count_per_op;
    *cycle_count += cp0->count_per_op;
    add_interrupt_event_count(cp0, COMPARE_INT, cp0_regs[CP0_COMPARE_REG]);
    cp0_regs[CP0_COUNT_REG] -= cp0->count_per_op;

    /* Step 7: recalculate cycle_count for the new first event */
    *cycle_count = cp0_regs[CP0_COUNT_REG] - cp0->q.first->data.count;

    /* Step 8: update last_addr to current PC to prevent stale delta */
    cp0->last_addr = *r4300_pc(&g_dev.r4300);
}
```

**Important:** `clear_queue` and `add_interrupt_event_count` are `static` in `interrupt.c`. Since the patch adds code to `main.c`, we need `extern` declarations. However, `add_interrupt_event_count` is already declared in `interrupt.h` (non-static). `clear_queue` IS static. Two options:

Option A: Add `extern void clear_queue(struct interrupt_queue*)` and remove `static` from `clear_queue` in interrupt.c (requires a second patch hunk).

Option B: Inline the clear logic — it's just `q->first = NULL; clear_pool(&q->pool);`. But `clear_pool` is also static.

Best approach: add a small patch hunk to `interrupt.c` that makes `clear_queue` non-static, and declare it in `interrupt.h`.

- [ ] **Step 5: Add interrupt.c/interrupt.h patch hunk to expose `clear_queue`**

Add to `mupen64plus-kn-all.patch` a hunk for `interrupt.c` that removes `static` from `clear_queue`:

```diff
--- a/mupen64plus-core/src/device/r4300/interrupt.c
+++ b/mupen64plus-core/src/device/r4300/interrupt.c
@@ -94,7 +94,7 @@
 
-static void clear_queue(struct interrupt_queue* q)
+void clear_queue(struct interrupt_queue* q)
 {
     q->first = NULL;
     clear_pool(&q->pool);
```

And a hunk for `interrupt.h` to declare it:

```diff
--- a/mupen64plus-core/src/device/r4300/interrupt.h
+++ b/mupen64plus-core/src/device/r4300/interrupt.h
@@ -31,6 +31,7 @@
 
 void init_interrupt(struct cp0* cp0);
+void clear_queue(struct interrupt_queue* q);
 
 void raise_maskable_interrupt(struct r4300_core* r4300, uint32_t cause_ip);
```

- [ ] **Step 6: Add forward declarations in the main.c patch section**

At the top of the new code block (before the normalize function), add:

```c
#include "../device/r4300/interrupt.h"
/* clear_queue exposed via interrupt.h patch */
extern void clear_queue(struct interrupt_queue *q);
```

Note: `interrupt.h` is already indirectly included via `cp0.h`, but the explicit include makes the dependency clear. The `extern` declaration is belt-and-suspenders since it's now in the header.

- [ ] **Step 7: Commit C exports**

```bash
git add build/patches/mupen64plus-kn-all.patch
git commit -m "feat(determinism): add event queue diagnostics and normalization exports

Adds kn_eventqueue_hash, kn_eventqueue_dump, kn_normalize_event_queue,
and kn_set/get_normalize_events WASM exports for cross-platform CP0
Count determinism."
```

---

### Task 2: Add WASM exports to retroarch-deterministic-timing.patch

**Files:**
- Modify: `build/patches/retroarch-deterministic-timing.patch:22` (the EXPORTED_FUNCTIONS line)

- [ ] **Step 1: Add the 5 new exports to the EXPORTED_FUNCTIONS list**

On line 22 of the patch (the line ending with `_kn_sync_read_cpu,_kn_sync_write_cpu`), append the new exports:

Change:
```
+                     _kn_get_state_ptrs,_kn_sync_read_cpu,_kn_sync_write_cpu
```
To:
```
+                     _kn_get_state_ptrs,_kn_sync_read_cpu,_kn_sync_write_cpu, \
+                     _kn_eventqueue_dump,_kn_eventqueue_hash,_kn_normalize_event_queue, \
+                     _kn_set_normalize_events,_kn_get_normalize_events
```

- [ ] **Step 2: Commit**

```bash
git add build/patches/retroarch-deterministic-timing.patch
git commit -m "feat(determinism): export event queue functions in WASM build"
```

---

### Task 3: Call normalize from kn_rollback.c setup_frame

**Files:**
- Modify: `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c:242-259` (the `setup_frame` function)
- Also modify: `build/kn_rollback/kn_rollback.c` (the canonical copy — keep in sync)

- [ ] **Step 1: Add extern declaration and call in setup_frame**

After the `kn_set_frame_time` call (line 244), add the normalization call:

```c
static void setup_frame(int frame) {
    /* Deterministic frame time: (frame + 1) * 16.666... ms */
    kn_set_frame_time((double)(frame + 1) * 16.666666666666668);

    /* Normalize event queue for cross-platform determinism */
    {
        extern int kn_normalize_events_flag;
        extern void kn_normalize_event_queue(void);
        if (kn_normalize_events_flag)
            kn_normalize_event_queue();
    }

    /* Reset audio capture buffer */
    kn_reset_audio();
    /* ... rest of setup_frame unchanged ... */
```

- [ ] **Step 2: Apply same change to build/kn_rollback/kn_rollback.c**

Keep the canonical copy in sync with the in-tree copy.

- [ ] **Step 3: Commit**

```bash
git add build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c build/kn_rollback/kn_rollback.c
git commit -m "feat(determinism): call event queue normalization in rollback setup_frame"
```

---

## Chunk 2: JS Integration

### Task 4: Add eventqueue hash to sync logging

**Files:**
- Modify: `web/static/netplay-lockstep.js`

Key locations:
- Line 2968: where `_kn_sync_hash()` is called for guest desync check — add eventqueue hash to the log
- Line 2973: the `sync OK` log line — append eventqueue hash
- Line 4722-4725: where `_kn_set_deterministic(1)` is called at lockstep start — also enable normalize

- [ ] **Step 1: Log eventqueue hash alongside sync hash**

Find the sync OK log (line 2973):
```javascript
_syncLog(`sync OK frame=${syncFrame} hash=${hostHash}`);
```

Change to:
```javascript
const eqHash = gMod._kn_eventqueue_hash?.() ?? 0;
_syncLog(`sync OK frame=${syncFrame} hash=${hostHash} eq=${(eqHash >>> 0).toString(16)}`);
```

- [ ] **Step 2: Log eventqueue hash on mismatch too**

Near line 2977 (the mismatch path), after `const guestHash = gMod._kn_sync_hash();`, add:
```javascript
const eqHash = gMod._kn_eventqueue_hash?.() ?? 0;
```

And include `eq=${(eqHash >>> 0).toString(16)}` in the mismatch sync log line.

- [ ] **Step 3: Enable normalization at lockstep start**

Near line 4722-4725 where `_kn_set_deterministic(1)` is called, add:

```javascript
if (detMod?._kn_set_normalize_events) {
  detMod._kn_set_normalize_events(1);
  _syncLog('C-level event queue normalization enabled');
}
```

- [ ] **Step 4: Call normalize in stepOneFrame for classic lockstep**

In `stepOneFrame()` (line 4606-4611), after the `_kn_set_frame_time` call:

```javascript
// C-level: always update frame time (kn_deterministic_mode stays ON)
if (_hasForkedCore) {
  const frameModule = window.EJS_emulator?.gameManager?.Module;
  if (frameModule?._kn_set_frame_time) {
    frameModule._kn_set_frame_time(frameTimeMs);
  }
  if (frameModule?._kn_normalize_event_queue && frameModule?._kn_get_normalize_events?.()) {
    frameModule._kn_normalize_event_queue();
  }
}
```

Note: In rollback mode, normalization is called from C in `setup_frame()`, so the JS call only matters for classic lockstep. The `_kn_get_normalize_events` guard ensures it's only called when enabled.

- [ ] **Step 5: Disable normalization at cleanup**

Near line 5125 where `_kn_set_deterministic(0)` is called at game end:

```javascript
if (mod?._kn_set_normalize_events) mod._kn_set_normalize_events(0);
```

- [ ] **Step 6: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat(determinism): integrate event queue hash logging and normalization toggle"
```

---

## Chunk 3: Build and Verify

### Task 5: Build patched WASM core

**Files:**
- No new files — uses existing build system

- [ ] **Step 1: Apply patches to source tree**

The patches need to be applied to the source tree before building. Follow the existing build process documented in `build/README.md` or the reference in memory (`reference_build_wasm.md`).

```bash
cd /Users/kazon/kaillera-next/build
# Apply patches (the build system handles this — check Makefile/Dockerfile)
```

- [ ] **Step 2: Build WASM core**

```bash
# Docker build (standard process)
docker build -t kn-core .
docker cp $(docker create kn-core):/out/mupen64plus_next_libretro.js web/static/ejs/cores/
docker cp $(docker create kn-core):/out/mupen64plus_next_libretro.wasm web/static/ejs/cores/
```

Verify the new exports exist:
```bash
grep -c 'kn_eventqueue\|kn_normalize' web/static/ejs/cores/mupen64plus_next_libretro.js
```
Expected: should find references to all 5 new export names.

- [ ] **Step 3: Commit built core**

```bash
git add web/static/ejs/cores/
git commit -m "chore: rebuild WASM core with event queue determinism exports"
```

### Task 6: Manual verification

- [ ] **Step 1: Same-platform test (Chrome ↔ Chrome)**

1. Start dev server
2. Open two Chrome tabs, create room, start lockstep game
3. Check sync log for `eq=` entries — both peers should have identical eventqueue hashes every frame
4. Verify game plays normally with normalization enabled

- [ ] **Step 2: Cross-platform test (Chrome ↔ Safari)**

1. Open Chrome on one device, Safari on another
2. Create room, start lockstep game
3. Compare `eq=` hashes in sync logs
4. Before normalization: expect divergence
5. With normalization: expect matching hashes

- [ ] **Step 3: Rollback mode test**

1. Start a rollback game between two peers
2. Verify no crashes (normalization runs from C in setup_frame)
3. Check sync log for eventqueue hashes

- [ ] **Step 4: Replay self-test**

Run `knDiag.replaySelfTest` from browser console. Must still pass with normalization enabled.
