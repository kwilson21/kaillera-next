# C-Level Rollback Netplay Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move rollback logic (save state, prediction, replay) into C inside the mupen64plus core, eliminating JS/WASM boundary interference that causes cross-device desync.

**Architecture:** New C module `kn_rollback.c` manages a save state ring buffer and input buffer. JS calls `kn_tick()` once per 16ms, passing local input. C handles prediction, save, replay internally via `retro_serialize`/`retro_unserialize`/`retro_run()`. On misprediction, C replays in a tight loop — same `retro_run()` function as normal execution, no JS between frames.

**Tech Stack:** C (mupen64plus core), Emscripten WASM exports, vanilla JS

---

## Prerequisites

1. Create new branch from main: `git checkout main && git checkout -b feat/c-level-rollback`
2. Cherry-pick from `feat/hybrid-lockstep-rollback`: WASM determinism patches (srand, mpk_seed, biopak), sync buffer pre-allocation, `patch-sync-v3.py`, `mupen64plus-determinism-fixes.patch`, `mupen64plus-headless-tick.patch`
3. Cherry-pick from `feat/headless-tick-benchmark`: RNG seed sync, host-authoritative roster, proportional frame pacing, late-join fixes
4. Docker builder image exists: `emulatorjs-builder:latest`

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c` | Create | Rollback engine: input buffer, state ring, prediction, replay |
| `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h` | Create | Header with public API |
| `build/src/mupen64plus-libretro-nx/libretro/libretro.c` | Modify | WASM export wrappers (EMSCRIPTEN_KEEPALIVE) |
| `build/src/mupen64plus-libretro-nx/Makefile.common` | Modify | Add kn_rollback.c to SOURCES_C |
| `build/src/RetroArch/Makefile.emulatorjs` | Modify | Add exports to EXPORTED_FUNCTIONS |
| `build/build.sh` | Modify | Apply kn_rollback files during build |
| `web/static/netplay-lockstep.js` | Modify | Use C-level tick instead of JS tick during hybrid mode |

---

## Chunk 1: C-level rollback engine

### Task 1: Create kn_rollback.h

**Files:**
- Create: `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h`

- [ ] **Step 1: Write the header**

```c
#ifndef KN_ROLLBACK_H
#define KN_ROLLBACK_H

#include <stdint.h>

/* Initialize rollback system. Call once after emulator boots.
 * max_frames: rollback window depth (typically 7-12 based on RTT)
 * delay_frames: input delay (typically 2-3)
 * local_slot: this player's controller slot (0-3)
 * num_players: total player count
 */
void kn_rollback_init(int max_frames, int delay_frames, int local_slot, int num_players);

/* Feed remote input. Call from JS when WebRTC delivers an input. */
void kn_feed_input(int slot, int frame, int buttons, int lx, int ly, int cx, int cy);

/* Tick: advance one frame. Call once per 16ms from JS.
 * Passes local player's input directly.
 * Returns current frame number after tick (may be > previous + 1 if replay occurred).
 */
int kn_tick(int buttons, int lx, int ly, int cx, int cy);

/* Stats for UI overlay */
int kn_get_frame(void);
int kn_get_rollback_count(void);
int kn_get_prediction_count(void);
int kn_get_correct_predictions(void);
int kn_get_max_depth(void);

/* Determinism self-test. Returns 1 if restore+replay is deterministic, 0 if not. */
int kn_rollback_self_test(void);

/* Debug log ring buffer. Returns pointer to null-terminated string. */
const char* kn_get_debug_log(void);

/* Cleanup */
void kn_rollback_shutdown(void);

#endif /* KN_ROLLBACK_H */
```

- [ ] **Step 2: Commit**

```bash
git add build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h
git commit -m "feat: add kn_rollback.h — C-level rollback API header"
```

### Task 2: Create kn_rollback.c — data structures and init

**Files:**
- Create: `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c`

- [ ] **Step 1: Write the core data structures and init/shutdown**

```c
#include "kn_rollback.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

/* Forward declarations from libretro API */
extern size_t retro_serialize_size(void);
extern bool retro_serialize(void *data, size_t size);
extern bool retro_unserialize(const void *data, size_t size);
extern void retro_run(void);

/* Forward declaration: write input to controller N */
extern void kn_write_controller(int slot, int buttons, int lx, int ly, int cx, int cy);

/* ── Constants ─────────────────────────────────────────────────────── */
#define KN_MAX_PLAYERS      4
#define KN_INPUT_RING_SIZE  256   /* ~4 seconds at 60fps */
#define KN_DEBUG_LOG_SIZE   (64 * 1024)

/* ── Input entry ───────────────────────────────────────────────────── */
typedef struct {
    int buttons;
    int lx, ly, cx, cy;
    int present;  /* 1 if real input received, 0 if predicted */
} kn_input_t;

/* ── Rollback state ────────────────────────────────────────────────── */
static struct {
    int initialized;
    int max_frames;       /* rollback window depth */
    int delay_frames;     /* input delay */
    int local_slot;       /* this player's slot */
    int num_players;      /* total players */
    int frame;            /* current frame number */

    /* State ring: pre-allocated save state buffers */
    int ring_size;        /* max_frames + 1 */
    uint8_t **ring_bufs;  /* ring_bufs[i] = malloc'd buffer */
    int *ring_frames;     /* frame number stored in each slot */
    size_t state_size;    /* retro_serialize_size() */

    /* Input ring: per-player, per-frame */
    kn_input_t inputs[KN_MAX_PLAYERS][KN_INPUT_RING_SIZE];
    kn_input_t last_known[KN_MAX_PLAYERS]; /* for prediction */

    /* Prediction tracking */
    int predicted[KN_MAX_PLAYERS][KN_INPUT_RING_SIZE]; /* 1 if predicted */
    int pending_rollback;  /* earliest frame needing correction, -1 if none */

    /* Stats */
    int rollback_count;
    int prediction_count;
    int correct_predictions;
    int max_depth;

    /* Debug log */
    char debug_log[KN_DEBUG_LOG_SIZE];
    int debug_log_pos;
} rb;

/* ── Debug logging ─────────────────────────────────────────────────── */
static void rb_log(const char *fmt, ...) {
    va_list args;
    va_start(args, fmt);
    int remaining = KN_DEBUG_LOG_SIZE - rb.debug_log_pos - 1;
    if (remaining > 0) {
        int written = vsnprintf(rb.debug_log + rb.debug_log_pos, remaining, fmt, args);
        if (written > 0) {
            rb.debug_log_pos += written;
            /* Add newline */
            if (rb.debug_log_pos < KN_DEBUG_LOG_SIZE - 1) {
                rb.debug_log[rb.debug_log_pos++] = '\n';
            }
        }
    }
    va_end(args);
}

/* ── Init / Shutdown ───────────────────────────────────────────────── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_rollback_init(int max_frames, int delay_frames, int local_slot, int num_players) {
    int i;

    if (rb.initialized) kn_rollback_shutdown();

    memset(&rb, 0, sizeof(rb));
    rb.max_frames = max_frames;
    rb.delay_frames = delay_frames;
    rb.local_slot = local_slot;
    rb.num_players = num_players > KN_MAX_PLAYERS ? KN_MAX_PLAYERS : num_players;
    rb.pending_rollback = -1;
    rb.state_size = retro_serialize_size();
    rb.ring_size = max_frames + 1;

    /* Allocate state ring */
    rb.ring_bufs = (uint8_t **)calloc(rb.ring_size, sizeof(uint8_t *));
    rb.ring_frames = (int *)calloc(rb.ring_size, sizeof(int));
    for (i = 0; i < rb.ring_size; i++) {
        rb.ring_bufs[i] = (uint8_t *)malloc(rb.state_size);
        rb.ring_frames[i] = -1;
        if (!rb.ring_bufs[i]) {
            rb_log("FATAL: failed to allocate state ring slot %d (%zu bytes)", i, rb.state_size);
            return;
        }
    }

    /* Initialize last_known to zero input */
    for (i = 0; i < KN_MAX_PLAYERS; i++) {
        memset(&rb.last_known[i], 0, sizeof(kn_input_t));
    }

    rb.initialized = 1;
    rb_log("kn_rollback_init: max=%d delay=%d slot=%d players=%d stateSize=%zu ringSlots=%d",
        max_frames, delay_frames, local_slot, num_players, rb.state_size, rb.ring_size);
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_rollback_shutdown(void) {
    int i;
    if (!rb.initialized) return;
    if (rb.ring_bufs) {
        for (i = 0; i < rb.ring_size; i++) {
            free(rb.ring_bufs[i]);
        }
        free(rb.ring_bufs);
    }
    free(rb.ring_frames);
    rb.initialized = 0;
    rb_log("kn_rollback_shutdown");
}
```

- [ ] **Step 2: Commit**

```bash
git add build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c
git commit -m "feat: add kn_rollback.c — data structures, init, shutdown"
```

### Task 3: Implement kn_feed_input and kn_tick

**Files:**
- Modify: `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c`

- [ ] **Step 1: Add kn_feed_input**

```c
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_feed_input(int slot, int frame, int buttons, int lx, int ly, int cx, int cy) {
    if (!rb.initialized || slot < 0 || slot >= KN_MAX_PLAYERS) return;

    int idx = frame % KN_INPUT_RING_SIZE;
    rb.inputs[slot][idx].buttons = buttons;
    rb.inputs[slot][idx].lx = lx;
    rb.inputs[slot][idx].ly = ly;
    rb.inputs[slot][idx].cx = cx;
    rb.inputs[slot][idx].cy = cy;
    rb.inputs[slot][idx].present = 1;

    /* Update last known for prediction */
    rb.last_known[slot] = rb.inputs[slot][idx];

    /* Check if this corrects a prediction */
    if (rb.predicted[slot][idx]) {
        kn_input_t *pred = &rb.inputs[slot][idx]; /* already overwritten — need old value */
        /* We need to compare BEFORE overwriting. Restructure: store predicted value separately. */
        /* For now, any predicted frame that receives real input triggers rollback check */
        rb.predicted[slot][idx] = 0;
        /* If frame is in the past and we have a save state for it, mark for rollback */
        int apply_frame = frame;
        if (apply_frame < rb.frame) {
            int depth = rb.frame - apply_frame;
            if (depth <= rb.max_frames) {
                int ring_idx = apply_frame % rb.ring_size;
                if (rb.ring_frames[ring_idx] == apply_frame) {
                    if (rb.pending_rollback < 0 || apply_frame < rb.pending_rollback) {
                        rb.pending_rollback = apply_frame;
                    }
                }
            }
        }
    }
}
```

Note: the prediction comparison needs refinement — we need to store the predicted value separately to compare against the real input. This is addressed in Step 2.

- [ ] **Step 2: Add predicted value storage and proper misprediction detection**

Add a parallel array for predicted values:

```c
/* Add to the rb struct: */
    kn_input_t predicted_values[KN_MAX_PLAYERS][KN_INPUT_RING_SIZE];
```

Update `kn_feed_input` to compare predicted vs real:

```c
void kn_feed_input(int slot, int frame, int buttons, int lx, int ly, int cx, int cy) {
    if (!rb.initialized || slot < 0 || slot >= KN_MAX_PLAYERS) return;

    int idx = frame % KN_INPUT_RING_SIZE;
    kn_input_t real_input = {buttons, lx, ly, cx, cy, 1};

    /* Check if this corrects a prediction */
    if (rb.predicted[slot][idx]) {
        kn_input_t *pred = &rb.predicted_values[slot][idx];
        int match = (pred->buttons == buttons && pred->lx == lx && pred->ly == ly);
        rb.predicted[slot][idx] = 0;

        if (match) {
            rb.correct_predictions++;
        } else if (frame < rb.frame) {
            /* Misprediction — mark for rollback */
            int depth = rb.frame - frame;
            if (depth <= rb.max_frames) {
                int ring_idx = frame % rb.ring_size;
                if (rb.ring_frames[ring_idx] == frame) {
                    if (rb.pending_rollback < 0 || frame < rb.pending_rollback) {
                        rb.pending_rollback = frame;
                        rb_log("MISPREDICTION slot=%d f=%d myF=%d depth=%d", slot, frame, rb.frame, depth);
                    }
                }
            }
        }
    }

    /* Store real input */
    rb.inputs[slot][idx] = real_input;
    rb.last_known[slot] = real_input;
}
```

- [ ] **Step 3: Add helper to write inputs to controller registers**

```c
/* Write inputs for all players for a given frame */
static void write_frame_inputs(int frame) {
    int s, idx;
    idx = frame % KN_INPUT_RING_SIZE;
    for (s = 0; s < rb.num_players; s++) {
        kn_input_t *inp = &rb.inputs[s][idx];
        if (inp->present) {
            kn_write_controller(s, inp->buttons, inp->lx, inp->ly, inp->cx, inp->cy);
        } else {
            kn_write_controller(s, 0, 0, 0, 0, 0);
        }
    }
}
```

- [ ] **Step 4: Implement kn_tick**

```c
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_tick(int buttons, int lx, int ly, int cx, int cy) {
    int i, s, idx, apply_frame;
    if (!rb.initialized) return -1;

    /* ── Rollback replay if pending ── */
    if (rb.pending_rollback >= 0) {
        int rb_frame = rb.pending_rollback;
        int depth = rb.frame - rb_frame;
        int ring_idx = rb_frame % rb.ring_size;
        rb.pending_rollback = -1;

        if (rb.ring_frames[ring_idx] == rb_frame && depth <= rb.max_frames) {
            rb.rollback_count++;
            if (depth > rb.max_depth) rb.max_depth = depth;

            /* Restore state */
            retro_unserialize(rb.ring_bufs[ring_idx], rb.state_size);

            /* Replay from rb_frame to current frame */
            int saved_frame = rb.frame;
            rb.frame = rb_frame;

            for (i = 0; i < depth; i++) {
                int rf = rb_frame + i;

                /* Save state for this replayed frame */
                int save_idx = rf % rb.ring_size;
                retro_serialize(rb.ring_bufs[save_idx], rb.state_size);
                rb.ring_frames[save_idx] = rf;

                /* Write corrected inputs */
                write_frame_inputs(rf - rb.delay_frames);

                /* Step one frame — SAME retro_run() as normal */
                retro_run();
                rb.frame++;
            }

            rb_log("REPLAY f=%d toFrame=%d depth=%d", rb.frame, rb_frame, depth);
        }
    }

    /* ── Save state for current frame ── */
    {
        int save_idx = rb.frame % rb.ring_size;
        retro_serialize(rb.ring_bufs[save_idx], rb.state_size);
        rb.ring_frames[save_idx] = rb.frame;
    }

    /* ── Store local input ── */
    {
        int local_idx = rb.frame % KN_INPUT_RING_SIZE;
        rb.inputs[rb.local_slot][local_idx].buttons = buttons;
        rb.inputs[rb.local_slot][local_idx].lx = lx;
        rb.inputs[rb.local_slot][local_idx].ly = ly;
        rb.inputs[rb.local_slot][local_idx].cx = cx;
        rb.inputs[rb.local_slot][local_idx].cy = cy;
        rb.inputs[rb.local_slot][local_idx].present = 1;
    }

    /* ── Check remote inputs for apply frame ── */
    apply_frame = rb.frame - rb.delay_frames;
    if (apply_frame >= 0) {
        for (s = 0; s < rb.num_players; s++) {
            if (s == rb.local_slot) continue;
            idx = apply_frame % KN_INPUT_RING_SIZE;
            if (!rb.inputs[s][idx].present) {
                /* Predict: use last known input */
                rb.inputs[s][idx] = rb.last_known[s];
                rb.inputs[s][idx].present = 1;
                rb.predicted[s][idx] = 1;
                rb.predicted_values[s][idx] = rb.last_known[s];
                rb.prediction_count++;
            }
        }
    }

    /* ── Write inputs and step ── */
    if (apply_frame >= 0) {
        write_frame_inputs(apply_frame);
    } else {
        /* Before delay window fills: zero all inputs */
        for (s = 0; s < rb.num_players; s++) {
            kn_write_controller(s, 0, 0, 0, 0, 0);
        }
    }

    retro_run();
    rb.frame++;

    return rb.frame;
}
```

- [ ] **Step 5: Add stat getters and self-test**

```c
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_frame(void) { return rb.frame; }

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_rollback_count(void) { return rb.rollback_count; }

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_prediction_count(void) { return rb.prediction_count; }

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_correct_predictions(void) { return rb.correct_predictions; }

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_max_depth(void) { return rb.max_depth; }

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
const char* kn_get_debug_log(void) { return rb.debug_log; }

/* Determinism self-test */
extern uint32_t kn_sync_hash(void);

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_rollback_self_test(void) {
    uint8_t *buf;
    uint32_t hash1, hash2;
    size_t sz = retro_serialize_size();

    buf = (uint8_t *)malloc(sz);
    if (!buf) return -1;

    /* Save current state */
    retro_serialize(buf, sz);

    /* Run one frame, hash */
    retro_run();
    hash1 = kn_sync_hash();

    /* Restore and run again, hash */
    retro_unserialize(buf, sz);
    retro_run();
    hash2 = kn_sync_hash();

    /* Restore original state */
    retro_unserialize(buf, sz);
    free(buf);

    rb_log("SELF-TEST hash1=0x%08x hash2=0x%08x match=%d", hash1, hash2, hash1 == hash2);
    return (hash1 == hash2) ? 1 : 0;
}
```

- [ ] **Step 6: Commit**

```bash
git add build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c
git commit -m "feat: implement kn_feed_input, kn_tick, stats, self-test"
```

### Task 4: Add kn_write_controller to libretro.c

**Files:**
- Modify: `build/src/mupen64plus-libretro-nx/libretro/libretro.c`

The existing `_simulate_input` writes individual buttons. We need a function that writes a full input state for a controller slot at once.

- [ ] **Step 1: Add kn_write_controller in libretro.c**

Add after the existing `kn_set_headless` block (around line 115):

```c
/* kaillera-next: Write full controller input for a slot.
 * Called by kn_rollback.c during replay to set inputs before retro_run(). */
#include "mupen64plus-core/src/main/kn_rollback.h"

void kn_write_controller(int slot, int buttons, int lx, int ly, int cx, int cy) {
    /* Use _simulate_input which writes to the input memory layout */
    extern void _simulate_input(int player, int index, int value);
    int i;
    /* Zero all buttons first */
    for (i = 0; i < 20; i++) _simulate_input(slot, i, 0);
    /* Set digital buttons (bits 0-15) */
    for (i = 0; i < 16; i++) {
        _simulate_input(slot, i, (buttons >> i) & 1);
    }
    /* Set analog: scale ±83 (N64 max) to ±32767 for _simulate_input */
    int scale = 32767 / 83;
    _simulate_input(slot, 16, lx > 0 ? lx * scale : 0);  /* L-stick X+ */
    _simulate_input(slot, 17, lx < 0 ? -lx * scale : 0); /* L-stick X- */
    _simulate_input(slot, 18, ly > 0 ? ly * scale : 0);  /* L-stick Y+ */
    _simulate_input(slot, 19, ly < 0 ? -ly * scale : 0); /* L-stick Y- */
    /* C-stick not mapped via _simulate_input — handled separately if needed */
}
```

Note: The exact `_simulate_input` indices and analog scaling must match the existing JS `writeInputToMemory` function in `netplay-lockstep.js`. Cross-reference `web/static/netplay-lockstep.js` line ~3528 (the `writeInputToMemory` function) for the correct mapping.

- [ ] **Step 2: Commit**

```bash
git add build/src/mupen64plus-libretro-nx/libretro/libretro.c
git commit -m "feat: add kn_write_controller for C-level input injection"
```

---

## Chunk 2: Build integration

### Task 5: Add kn_rollback.c to Makefile.common

**Files:**
- Modify: `build/src/mupen64plus-libretro-nx/Makefile.common`

- [ ] **Step 1: Add source file to SOURCES_C**

Find the core source list (around line 38-99). Add after the last `main/` entry:

```makefile
$(CORE_DIR)/src/main/kn_rollback.c \
```

- [ ] **Step 2: Commit**

```bash
git add build/src/mupen64plus-libretro-nx/Makefile.common
git commit -m "build: add kn_rollback.c to Makefile.common"
```

### Task 6: Add WASM exports to Makefile.emulatorjs

**Files:**
- Modify: `build/src/RetroArch/Makefile.emulatorjs`

- [ ] **Step 1: Add exports after existing kn_ entries (around line 141)**

```makefile
                     _kn_rollback_init,_kn_feed_input,_kn_tick, \
                     _kn_get_frame,_kn_get_rollback_count,_kn_get_prediction_count, \
                     _kn_get_correct_predictions,_kn_get_max_depth, \
                     _kn_rollback_self_test,_kn_get_debug_log,_kn_rollback_shutdown
```

- [ ] **Step 2: Commit**

```bash
git add build/src/RetroArch/Makefile.emulatorjs
git commit -m "build: add C-level rollback exports to EXPORTED_FUNCTIONS"
```

### Task 7: Add build pipeline integration

**Files:**
- Modify: `build/build.sh`

Since `kn_rollback.c` and `kn_rollback.h` live in the source tree that gets reset on each build, we need to copy them in. Add a step in build.sh after patch application:

- [ ] **Step 1: Add copy step to build.sh**

After the determinism fixes and before softfloat patch:

```bash
    # C-level rollback engine
    echo "    Installing kn_rollback.c/h..."
    cp "${SCRIPT_DIR}/kn_rollback/kn_rollback.c" mupen64plus-core/src/main/kn_rollback.c
    cp "${SCRIPT_DIR}/kn_rollback/kn_rollback.h" mupen64plus-core/src/main/kn_rollback.h
    echo "    Done."
```

- [ ] **Step 2: Create the kn_rollback directory in build/**

```bash
mkdir -p build/kn_rollback
cp build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c build/kn_rollback/
cp build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h build/kn_rollback/
```

These tracked copies survive `git checkout -- .` on the source tree.

- [ ] **Step 3: Commit**

```bash
git add build/build.sh build/kn_rollback/
git commit -m "build: add kn_rollback to build pipeline"
```

### Task 8: Build and verify

- [ ] **Step 1: Clean source and build**

```bash
cd build/src/mupen64plus-libretro-nx && git checkout -- . && git clean -fd
cd ../../RetroArch && git checkout -- . && git clean -fd
cd ../../..
docker run --rm --platform linux/amd64 -v "$(pwd)/build:/build" emulatorjs-builder bash /build/build.sh
```

- [ ] **Step 2: Verify exports exist**

```bash
cd /tmp && rm -rf wasm_check && 7z x -y web/static/ejs/cores/mupen64plus_next-wasm.data -o/tmp/wasm_check
grep -o "_kn_rollback[a-z_]*\|_kn_tick\|_kn_feed_input\|_kn_get_frame" /tmp/wasm_check/*.js | sort -u
```

Expected: all kn_rollback exports listed.

- [ ] **Step 3: Deploy and commit**

```bash
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
git add web/static/ejs/cores/mupen64plus_next-wasm.data
git commit -m "build: deploy WASM core with C-level rollback"
```

---

## Chunk 3: JS integration

### Task 9: Wire up C-level tick in netplay-lockstep.js

**Files:**
- Modify: `web/static/netplay-lockstep.js`

This is the simplest initial integration: during hybrid/rollback mode, use `kn_tick()` instead of the JS tick loop for frame stepping. Keep all WebRTC, Socket.IO, audio, and UI code in JS.

- [ ] **Step 1: Add C-level rollback initialization after emulator boot**

In `startLockstep()` (or the equivalent sync start function), after delay negotiation:

```javascript
// Initialize C-level rollback if available
const cMod = window.EJS_emulator?.gameManager?.Module;
if (_hybridMode && cMod?._kn_rollback_init) {
  cMod._kn_rollback_init(_ROLLBACK_MAX, DELAY_FRAMES, _playerSlot, getInputPeers().length + 1);
  _syncLog(`C-ROLLBACK init: max=${_ROLLBACK_MAX} delay=${DELAY_FRAMES} slot=${_playerSlot}`);
  _useCRollback = true;
} else {
  _useCRollback = false;
}
```

- [ ] **Step 2: Feed remote inputs to C when received via DataChannel**

In the binary input handler (where `KNShared.decodeInput` is called):

```javascript
// After decoding remote input:
if (_useCRollback && tickMod?._kn_feed_input) {
  tickMod._kn_feed_input(peer.slot, recvFrame, recvInput.buttons, recvInput.lx, recvInput.ly, recvInput.cx, recvInput.cy);
}
```

- [ ] **Step 3: Replace frame step with kn_tick during hybrid mode**

In the tick() function, where `stepOneFrame()` is called during VS_BATTLE:

```javascript
// During VS_BATTLE with C-level rollback:
if (_useCRollback && tickMod?._kn_tick) {
  const localInput = readLocalInput();
  const newFrame = tickMod._kn_tick(
    localInput.buttons, localInput.lx, localInput.ly, localInput.cx, localInput.cy
  );
  _frameNum = newFrame;
  feedAudio();
} else {
  // Existing JS tick path (lockstep or non-hybrid)
  // ... existing code ...
}
```

- [ ] **Step 4: Add self-test button to debug overlay**

Expose `kn_rollback_self_test` via console:

```javascript
window.knSelfTest = () => {
  const m = EJS_emulator?.gameManager?.Module;
  if (!m?._kn_rollback_self_test) return 'not available';
  const result = m._kn_rollback_self_test();
  return result === 1 ? 'DETERMINISTIC' : 'NON-DETERMINISTIC';
};
```

- [ ] **Step 5: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: wire JS to C-level rollback — kn_tick replaces JS tick during hybrid"
```

---

## Testing

1. **Self-test first**: Open game in hybrid mode, press F12, run `knSelfTest()`. Must return "DETERMINISTIC".

2. **Same laptop**: Both tabs, hybrid mode. Check logs for `C-ROLLBACK init`. Guest should show prediction count > 0 but rollback count = 0 (same-device inputs arrive on time).

3. **Desktop to mobile**: User controls host. Guest should show predictions + rollbacks. Check screenshots at f=3000+ for matching game state.

4. **Verify no JS rollback**: No `REPLAY-DONE`, `CORRECTION-REQ`, or `CORRECTION-APPLIED` entries. Only `MISPREDICTION` and `REPLAY` from the C debug log (via `kn_get_debug_log`).

5. **30-minute stress test**: Play a full match. If no visible desync, C-level rollback works.
