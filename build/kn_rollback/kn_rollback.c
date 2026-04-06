/*
 * kn_rollback.c — C-level rollback netplay engine for kaillera-next.
 *
 * Manages a save state ring buffer and input buffer. JS calls kn_tick()
 * once per 16ms. All prediction, save, and replay happens in C via
 * retro_serialize/retro_unserialize/retro_run() — no JS between replay
 * frames. This eliminates the JS/WASM boundary non-determinism that
 * caused cross-device desync in the JS-level rollback approach.
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

/* Forward declarations from libretro API */
extern size_t retro_serialize_size(void);
extern bool retro_serialize(void *data, size_t size);
extern bool retro_unserialize(const void *data, size_t size);
extern void retro_run(void);

/* Forward declaration: write full controller input for a slot.
 * Implemented in libretro.c — calls simulate_input() per button/axis. */
extern void kn_write_controller(int slot, int buttons, int lx, int ly, int cx, int cy);

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

/* ── Write inputs for all players for a given frame ────────────────── */
static void write_frame_inputs(int frame) {
    int s, idx;
    idx = frame % KN_INPUT_RING_SIZE;
    for (s = 0; s < KN_MAX_PLAYERS; s++) {
        if (s < rb.num_players) {
            kn_input_t *inp = &rb.inputs[s][idx];
            if (inp->present) {
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

/* ── Feed remote input ─────────────────────────────────────────────── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_feed_input(int slot, int frame, int buttons, int lx, int ly, int cx, int cy) {
    if (!rb.initialized || slot < 0 || slot >= KN_MAX_PLAYERS) return;

    int idx = frame % KN_INPUT_RING_SIZE;
    kn_input_t real_input = {buttons, lx, ly, cx, cy, 1};

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
                }
            }
        }
    }

    /* Store real input */
    rb.inputs[slot][idx] = real_input;
    rb.last_known[slot] = real_input;
}

/* ── Pre-tick: save state, predict, write inputs, replay if needed ── */
/* Call BEFORE the JS runner steps the emulator. Replay (retro_run from C)
 * only happens on misprediction — the normal frame step is done by JS
 * via stepOneFrame() which goes through the full EJS/RetroArch pipeline. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_pre_tick(int buttons, int lx, int ly, int cx, int cy) {
    int i, s, idx, apply_frame;
    if (!rb.initialized) return -1;

    /* ── Rollback replay if pending ── */
    if (rb.pending_rollback >= 0) {
        int rb_frame = rb.pending_rollback;
        int depth = rb.frame - rb_frame;
        int ring_idx = rb_frame % rb.ring_size;
        rb.pending_rollback = -1;

        if (rb.ring_frames[ring_idx] == rb_frame && depth > 0 && depth <= rb.max_frames) {
            rb.rollback_count++;
            if (depth > rb.max_depth) rb.max_depth = depth;

            /* Restore state to the mispredicted frame */
            retro_unserialize(rb.ring_bufs[ring_idx], rb.state_size);

            /* Replay from rb_frame to current frame — tight C loop, no JS */
            for (i = 0; i < depth; i++) {
                int rf = rb_frame + i;
                int replay_apply = rf - rb.delay_frames;

                /* Re-save state for this replayed frame */
                int save_idx = rf % rb.ring_size;
                retro_serialize(rb.ring_bufs[save_idx], rb.state_size);
                rb.ring_frames[save_idx] = rf;

                /* Write corrected inputs */
                if (replay_apply >= 0) {
                    write_frame_inputs(replay_apply);
                } else {
                    for (s = 0; s < KN_MAX_PLAYERS; s++)
                        kn_write_controller(s, 0, 0, 0, 0, 0);
                }

                /* Step one frame — SAME retro_run() as normal play */
                retro_run();
            }

            rb_log("REPLAY rb_frame=%d depth=%d now=%d", rb_frame, depth, rb.frame);
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

    /* ── Write inputs to controller registers ── */
    /* JS will then call stepOneFrame() which triggers retro_run()
     * through the full EJS/RetroArch pipeline. */
    if (apply_frame >= 0) {
        write_frame_inputs(apply_frame);
    } else {
        /* Before delay window fills: zero all inputs */
        for (s = 0; s < KN_MAX_PLAYERS; s++) {
            kn_write_controller(s, 0, 0, 0, 0, 0);
        }
    }

    return rb.frame;
}

/* ── Post-tick: advance frame counter ── */
/* Call AFTER JS runner has stepped the emulator. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_post_tick(void) {
    if (!rb.initialized) return -1;
    rb.frame++;
    return rb.frame;
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

    /* Run one frame with zero input, hash RDRAM */
    kn_write_controller(0, 0, 0, 0, 0, 0);
    kn_write_controller(1, 0, 0, 0, 0, 0);
    kn_write_controller(2, 0, 0, 0, 0, 0);
    kn_write_controller(3, 0, 0, 0, 0, 0);
    retro_run();
    hash1 = kn_sync_hash();

    /* Restore and run again with same zero input, hash RDRAM */
    retro_unserialize(buf, sz);
    kn_write_controller(0, 0, 0, 0, 0, 0);
    kn_write_controller(1, 0, 0, 0, 0, 0);
    kn_write_controller(2, 0, 0, 0, 0, 0);
    kn_write_controller(3, 0, 0, 0, 0, 0);
    retro_run();
    hash2 = kn_sync_hash();

    /* Restore original state */
    retro_unserialize(buf, sz);
    free(buf);

    rb_log("SELF-TEST hash1=0x%08x hash2=0x%08x match=%d", hash1, hash2, hash1 == hash2);
    return (hash1 == hash2) ? 1 : 0;
}
