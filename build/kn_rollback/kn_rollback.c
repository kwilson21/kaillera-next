/*
 * kn_rollback.c — C-level rollback state + input manager for kaillera-next.
 *
 * Manages a save state ring buffer and input prediction buffer. JS handles
 * all frame stepping (including replay) through the EJS/RetroArch pipeline.
 * C only manages: state snapshots, input storage, prediction tracking, and
 * misprediction detection. Replay is driven by JS using the existing
 * writeInputToMemory + stepOneFrame code path.
 *
 * retro_run() cannot be called from C in ASYNC mode (Emscripten asyncify
 * requires the JS event loop), so all emulation stepping stays in JS.
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

    /* ── Handle pending rollback BEFORE saving new state ── */
    /* retro_unserialize is synchronous — no asyncify issue. */
    if (rb.pending_rollback >= 0) {
        int rb_frame = rb.pending_rollback;
        int depth = rb.frame - rb_frame;
        int ring_idx = rb_frame % rb.ring_size;
        rb.pending_rollback = -1;

        if (rb.ring_frames[ring_idx] == rb_frame && depth > 0 && depth <= rb.max_frames) {
            retro_unserialize(rb.ring_bufs[ring_idx], rb.state_size);
            rb.replay_depth = depth;
            rb.replay_start = rb_frame;
            rb.frame = rb_frame;
            rb.rollback_count++;
            if (depth > rb.max_depth) rb.max_depth = depth;
            rb_log("RESTORE f=%d depth=%d (JS will replay)", rb_frame, depth);
        } else {
            rb_log("RESTORE-FAILED f=%d ring[%d]=%d depth=%d", rb_frame, ring_idx, rb.ring_frames[ring_idx], depth);
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
    return rb.frame;
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
    return retro_unserialize(rb.ring_bufs[ring_idx], rb.state_size) ? 1 : 0;
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
