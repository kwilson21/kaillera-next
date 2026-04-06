/*
 * kn_rollback.c — C-level rollback engine for kaillera-next.
 *
 * Manages a save state ring buffer, input prediction, and amortized replay.
 * Normal frame stepping is done by JS (writeInputToMemory + stepOneFrame).
 * Replay on misprediction is done in C via retro_run (synchronous thanks to
 * ASYNCIFY_REMOVE in the build). Amortized: 1 replay frame per tick to
 * avoid exceeding the 16.67ms frame budget.
 *
 * C manages: state ring, input ring (frame-tagged), prediction tracking,
 * misprediction detection, replay via retro_run, per-frame setup (frame
 * time, audio reset, RNG seed sync).
 *
 * JS manages: normal frame step (EJS runner), input send/receive (WebRTC),
 * audio playback, overlay, screenshot capture.
 */

#include "kn_rollback.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>
#include <stdbool.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

/* Forward declarations from libretro API.
 * retro_run is excluded from asyncify via ASYNCIFY_REMOVE. */
extern size_t retro_serialize_size(void);
extern bool retro_serialize(void *data, size_t size);
extern bool retro_unserialize(const void *data, size_t size);
extern void retro_run(void);

/* Forward declarations: kn_sync_read/write (zero-malloc state capture).
 * These write directly to the provided buffer — no intermediate malloc.
 * retro_serialize calls savestates_save_m64p which mallocs 16MB internally,
 * causing WASM heap growth and non-deterministic behavior on mobile. */
extern uint32_t kn_sync_read(uint8_t *buf, uint32_t max_size);
extern int kn_sync_write(const uint8_t *buf, uint32_t size);

/* Forward declaration: write full controller input for a slot. */
extern void kn_write_controller(int slot, int buttons, int lx, int ly, int cx, int cy);

/* Forward declarations: per-frame setup (from RetroArch deterministic timing patch) */
extern void kn_set_frame_time(double time_ms);
extern void kn_reset_audio(void);

/* Forward declaration: RDRAM hash for determinism self-test */
extern uint32_t kn_sync_hash(void);

/* ── Constants ─────────────────────────────────────────────────────── */
#define KN_MAX_PLAYERS      4
#define KN_INPUT_RING_SIZE  256   /* ~4 seconds at 60fps */
#define KN_DEBUG_LOG_SIZE   (64 * 1024)

/* ── Input entry ───────────────────────────────────────────────────── */
typedef struct {
    int buttons;
    int lx, ly, cx, cy;
    int present;  /* 1 if real input received, 0 if not yet available */
    int frame;    /* frame number this input belongs to (-1 if unused) */
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

    /* Prediction tracking: predicted values stored separately for comparison */
    int predicted[KN_MAX_PLAYERS][KN_INPUT_RING_SIZE];
    kn_input_t predicted_values[KN_MAX_PLAYERS][KN_INPUT_RING_SIZE];
    int pending_rollback;  /* earliest frame needing correction, -1 if none */

    /* Replay: set by kn_pre_tick when rollback occurs, read+cleared by JS */
    int replay_depth;     /* number of frames JS must replay (0 = none) */
    int replay_start;     /* frame to start replay from */

    /* Amortized replay: replay 1 extra frame per tick instead of all at once */
    int replay_remaining; /* frames still to replay (0 = not replaying) */
    int replay_target;    /* frame to catch up to */

    /* RNG sync: per-frame seed written to RDRAM (Smash Remix specific) */
    uint32_t rng_base_seed; /* hash of match ID */
    uint32_t *rng_ptr;      /* pointer to primary RNG RDRAM address */
    uint32_t *rng_alt_ptr;  /* pointer to alternate RNG RDRAM address */

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
            if (rb.debug_log_pos < KN_DEBUG_LOG_SIZE - 1) {
                rb.debug_log[rb.debug_log_pos++] = '\n';
            }
        }
    }
    va_end(args);
}

/* ── Per-frame setup: RNG seed + frame time ────────────────────────── */
/* Must be called before each retro_run() — both normal and replay frames. */
static void setup_frame(int frame) {
    /* Deterministic frame time: (frame + 1) * 16.666... ms */
    kn_set_frame_time((double)(frame + 1) * 16.666666666666668);

    /* Reset audio capture buffer */
    kn_reset_audio();

    /* RNG seed sync (Smash Remix): write deterministic per-frame seed to RDRAM.
     * Same hash as JS _syncRNGSeed: h = baseSeed ^ (frameNum * 0x45d9f3b7),
     * then mix via multiply-shift. */
    if (rb.rng_ptr) {
        uint32_t h = rb.rng_base_seed ^ ((uint32_t)frame * 0x45d9f3b7u);
        h = (h ^ (h >> 16)) * 0x85ebca6bu;
        h = h ^ (h >> 13);
        *rb.rng_ptr = h;
        if (rb.rng_alt_ptr) *rb.rng_alt_ptr = h;
    }
}

/* ── Write inputs for all players for a given frame ────────────────── */
static void write_frame_inputs(int frame) {
    int s, idx;
    idx = frame % KN_INPUT_RING_SIZE;
    for (s = 0; s < KN_MAX_PLAYERS; s++) {
        if (s < rb.num_players) {
            kn_input_t *inp = &rb.inputs[s][idx];
            if (inp->present && inp->frame == frame) {
                kn_write_controller(s, inp->buttons, inp->lx, inp->ly, inp->cx, inp->cy);
            } else {
                kn_write_controller(s, 0, 0, 0, 0, 0);
            }
        } else {
            kn_write_controller(s, 0, 0, 0, 0, 0);
        }
    }
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
    /* Use kn_sync_read size (~8MB + 16KB) instead of retro_serialize_size (~16MB).
     * kn_sync_read writes directly to buffer (zero malloc). retro_serialize
     * internally mallocs 16MB which causes WASM heap growth + non-determinism. */
    rb.state_size = 8 * 1024 * 1024 + 65536; /* RDRAM_MAX_SIZE + generous overhead */
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

/* ── Update player count (e.g., late join) ─────────────────────────── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_set_num_players(int num_players) {
    rb.num_players = num_players > KN_MAX_PLAYERS ? KN_MAX_PLAYERS : num_players;
    rb_log("num_players updated to %d", rb.num_players);
}

/* ── Feed remote input ─────────────────────────────────────────────── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_feed_input(int slot, int frame, int buttons, int lx, int ly, int cx, int cy) {
    int misprediction = 0;
    if (!rb.initialized || slot < 0 || slot >= KN_MAX_PLAYERS) return 0;

    int idx = frame % KN_INPUT_RING_SIZE;
    kn_input_t real_input = {buttons, lx, ly, cx, cy, 1, frame};

    /* Check if this corrects a prediction */
    if (rb.predicted[slot][idx]) {
        kn_input_t *pred = &rb.predicted_values[slot][idx];
        int match = (pred->buttons == buttons && pred->lx == lx && pred->ly == ly
                     && pred->cx == cx && pred->cy == cy);
        rb.predicted[slot][idx] = 0;

        if (match) {
            rb.correct_predictions++;
        } else if (frame < rb.frame) {
            /* Misprediction for a past frame — mark for rollback */
            int depth = rb.frame - frame;
            if (depth <= rb.max_frames) {
                int ring_idx = frame % rb.ring_size;
                if (rb.ring_frames[ring_idx] == frame) {
                    if (rb.pending_rollback < 0 || frame < rb.pending_rollback) {
                        rb.pending_rollback = frame;
                        rb_log("MISPREDICTION slot=%d f=%d myF=%d depth=%d", slot, frame, rb.frame, depth);
                    }
                    misprediction = 1;
                }
            }
        }
    }

    /* Store real input */
    rb.inputs[slot][idx] = real_input;
    rb.last_known[slot] = real_input;
    return misprediction;
}

/* ── Pre-tick: save state, store input, predict ──────────────────── */
/* Returns: >= 0 = current frame (normal), < -1 = rollback occurred,
 * replay needed from frame (-return - 2) to current frame.
 * e.g., return -5 means replay 3 frames starting from (current - 3). */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_pre_tick(int buttons, int lx, int ly, int cx, int cy) {
    int s, idx, apply_frame;
    if (!rb.initialized) return -1;

    /* ── Handle pending rollback: restore state, start amortized catch-up ── */
    if (rb.pending_rollback >= 0 && rb.replay_remaining == 0) {
        int rb_frame = rb.pending_rollback;
        int depth = rb.frame - rb_frame;
        int ring_idx = rb_frame % rb.ring_size;
        rb.pending_rollback = -1;

        if (rb.ring_frames[ring_idx] == rb_frame && depth > 0 && depth <= rb.max_frames) {
            kn_sync_write(rb.ring_bufs[ring_idx], rb.state_size);
            rb.rollback_count++;
            if (depth > rb.max_depth) rb.max_depth = depth;
            rb.replay_remaining = depth;
            rb.replay_target = rb.frame;
            rb.frame = rb_frame;
            rb.replay_depth = depth;
            rb.replay_start = rb_frame;
            rb_log("C-REPLAY-START f=%d depth=%d target=%d", rb_frame, depth, rb.replay_target);
        } else {
            rb_log("RESTORE-FAILED f=%d ring[%d]=%d depth=%d", rb_frame, ring_idx, rb.ring_frames[ring_idx], depth);
        }
    }

    /* ── Amortized catch-up: replay 1 frame per tick ── */
    /* During catch-up, this tick IS the replay frame. No normal frame step.
     * JS should NOT call stepOneFrame — kn_pre_tick handles the frame via
     * retro_run (synchronous). Returns 1 to signal JS to skip normal step. */
    if (rb.replay_remaining > 0) {
        int replay_apply = rb.frame - rb.delay_frames;
        int save_idx = rb.frame % rb.ring_size;

        /* Save state for this frame */
        kn_sync_read(rb.ring_bufs[save_idx], rb.state_size);
        rb.ring_frames[save_idx] = rb.frame;

        /* Write inputs and step */
        if (replay_apply >= 0) {
            write_frame_inputs(replay_apply);
        } else {
            int s;
            for (s = 0; s < KN_MAX_PLAYERS; s++)
                kn_write_controller(s, 0, 0, 0, 0, 0);
        }

        setup_frame(rb.frame);
        retro_run();
        rb.frame++;
        rb.replay_remaining--;

        if (rb.replay_remaining == 0) {
            rb_log("C-REPLAY-DONE f=%d", rb.frame);
        }

        /* Return 1 = catching up, JS should skip normal frame step */
        return 1;
    }

    /* ── Save state for current frame ── */
    {
        int save_idx = rb.frame % rb.ring_size;
        kn_sync_read(rb.ring_bufs[save_idx], rb.state_size);
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
        rb.inputs[rb.local_slot][local_idx].frame = rb.frame;
    }

    /* ── Check remote inputs for apply frame ── */
    apply_frame = rb.frame - rb.delay_frames;
    if (apply_frame >= 0) {
        for (s = 0; s < rb.num_players; s++) {
            if (s == rb.local_slot) continue;
            idx = apply_frame % KN_INPUT_RING_SIZE;
            /* Guard against stale ring entries: the present flag from a
             * previous cycle (256 frames ago) can still be set. Verify
             * the stored frame number matches apply_frame. */
            if (!rb.inputs[s][idx].present || rb.inputs[s][idx].frame != apply_frame) {
                /* Predict: use last known input */
                rb.inputs[s][idx] = rb.last_known[s];
                rb.inputs[s][idx].present = 1;
                rb.inputs[s][idx].frame = apply_frame;
                rb.predicted[s][idx] = 1;
                rb.predicted_values[s][idx] = rb.last_known[s];
                rb.prediction_count++;
            }
        }
    }

    /* Input writing is done by JS using kn_get_input + writeInputToMemory */
    return 0; /* 0 = normal tick, JS should do stepOneFrame */
}

/* ── Post-tick: advance frame counter ── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_post_tick(void) {
    if (!rb.initialized) return -1;
    rb.frame++;
    return rb.frame;
}

/* ── Configure RNG sync for C-level replay ─────────────────────────── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_set_rng_sync(uint32_t base_seed, uint32_t *rng_ptr, uint32_t *rng_alt_ptr) {
    rb.rng_base_seed = base_seed;
    rb.rng_ptr = rng_ptr;
    rb.rng_alt_ptr = rng_alt_ptr;
    rb_log("RNG sync configured: seed=0x%08x ptr=%p alt=%p", base_seed, rng_ptr, rng_alt_ptr);
}

/* ── Query: pending rollback frame (legacy — use kn_get_replay_depth) */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_pending_rollback(void) {
    int f = rb.pending_rollback;
    rb.pending_rollback = -1;
    return f;
}

/* ── Query: replay depth after kn_pre_tick ─────────────────────────── */
/* Returns number of frames to replay (0 = none). Clears the flag. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_replay_depth(void) {
    int d = rb.replay_depth;
    rb.replay_depth = 0;
    return d;
}

/* ── Query: replay start frame ─────────────────────────────────────── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_replay_start(void) {
    return rb.replay_start;
}

/* ── Query: get state buffer for a frame ───────────────────────────── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
uint8_t* kn_get_state_for_frame(int frame) {
    if (!rb.initialized) return NULL;
    int ring_idx = frame % rb.ring_size;
    if (rb.ring_frames[ring_idx] != frame) return NULL;
    return rb.ring_bufs[ring_idx];
}

/* ── Restore state for a frame ─────────────────────────────────────── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_restore_frame(int frame) {
    if (!rb.initialized) return 0;
    int ring_idx = frame % rb.ring_size;
    if (rb.ring_frames[ring_idx] != frame) return 0;
    return kn_sync_write(rb.ring_bufs[ring_idx], rb.state_size) == 0 ? 1 : 0;
}

/* ── Query: get state size ─────────────────────────────────────────── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_state_size(void) {
    return (int)rb.state_size;
}

/* ── Query: get input for a slot/frame ─────────────────────────────── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_input(int slot, int frame, int *out_buttons,
                 int *out_lx, int *out_ly, int *out_cx, int *out_cy) {
    if (!rb.initialized || slot < 0 || slot >= KN_MAX_PLAYERS) return 0;
    int idx = frame % KN_INPUT_RING_SIZE;
    kn_input_t *inp = &rb.inputs[slot][idx];
    if (!inp->present || inp->frame != frame) return 0;
    *out_buttons = inp->buttons;
    *out_lx = inp->lx;
    *out_ly = inp->ly;
    *out_cx = inp->cx;
    *out_cy = inp->cy;
    return 1;
}

/* ── Full state hash: hash the last saved kn_sync_read output ────── */
/* Hashes the complete serialized state (~8MB) — covers RDRAM, CPU regs,
 * CP0, CP1, TLB, event queue, SP mem, PIF RAM, SoftFloat state. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
uint32_t kn_full_state_hash(void) {
    if (!rb.initialized) return 0;
    int idx = (rb.frame > 0 ? rb.frame - 1 : 0) % rb.ring_size;
    if (rb.ring_frames[idx] < 0) return 0;
    uint32_t hash = 2166136261u;
    const uint8_t *p = rb.ring_bufs[idx];
    size_t i;
    /* Hash every 64th byte for speed (~256KB sampled from ~16MB, <1ms) */
    for (i = 0; i < rb.state_size; i += 64) {
        hash ^= p[i];
        hash *= 16777619u;
    }
    return hash;
}

/* ── Stat getters ──────────────────────────────────────────────────── */
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

/* ── Determinism self-test ─────────────────────────────────────────── */
/* NOTE: This test cannot call retro_run() from C in ASYNC mode.
 * Self-test is now driven by JS — this stub returns -2 (unsupported). */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_rollback_self_test(void) {
    return -2; /* JS-driven self-test needed */
}
