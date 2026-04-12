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

/* Global flag: when set, gen_interrupt() in the core skips non-essential
 * interrupts during rollback replay. Defined here so both kn_rollback.c
 * and the patched interrupt.c can reference it. */
int kn_replay_freeze_interrupts = 0;

/* Forward declarations from libretro API.
 * retro_run is excluded from asyncify via ASYNCIFY_REMOVE. */
extern size_t retro_serialize_size(void);
extern bool retro_serialize(void *data, size_t size);
extern bool retro_unserialize(const void *data, size_t size);
extern void retro_run(void);

/* RetroArch's emscripten_mainloop — the EXACT function the EJS runner calls.
 * Calling this from C ensures replay uses the IDENTICAL code path as normal
 * play: emscripten_mainloop → runloop_iterate → core_run → retro_run, plus
 * task_queue_check after. Same as lockstep frame step. */
extern void emscripten_mainloop(void);

/* Forward declarations: kn_sync_read/write (zero-malloc state capture).
 * These write directly to the provided buffer — no intermediate malloc.
 * retro_serialize calls savestates_save_m64p which mallocs 16MB internally,
 * causing WASM heap growth and non-deterministic behavior on mobile. */
extern uint32_t kn_sync_read(uint8_t *buf, uint32_t max_size);
extern int kn_sync_write(const uint8_t *buf, uint32_t size);

/* Forward declaration: write full controller input for a slot. */
extern void kn_write_controller(int slot, int buttons, int lx, int ly, int cx, int cy);

/* Forward declaration: headless mode flag (skip GL in retro_run). */
extern int kn_headless;
extern void kn_set_headless(int enable);

/* Forward declarations: per-frame setup (from RetroArch deterministic timing patch) */
extern void kn_set_frame_time(double time_ms);
extern void kn_reset_audio(void);

/* Forward declaration: RDRAM hash for determinism self-test */
extern uint32_t kn_sync_hash(void);

/* Forward declaration: RF5 live gameplay hash (defined later). */
uint32_t kn_live_gameplay_hash(void);

/* Forward declaration: SoftFloat globals (not in retro_serialize — saved
 * alongside ring buffer snapshots by sf_pack/sf_restore below).
 * Type must match softfloat.h: uint_fast8_t (1 byte on WASM). */
#include <stdint.h>
extern uint_fast8_t softfloat_roundingMode;
extern uint_fast8_t softfloat_exceptionFlags;

/* ── Taint tracking ─────────────────────────────────────────────────
 * Level-2 mark-and-sweep taint map for RDRAM. Any RDRAM byte written by a
 * subsystem known to be non-deterministic cross-device (RSP HLE audio DMAs,
 * GLideN64 framebuffer copybacks, anything else we discover) is flagged by
 * calling kn_taint_rdram(addr, size). kn_game_state_hash() then skips any
 * 64KB block with a set flag, giving us a hash over deterministic state
 * only. Never cleared — once tainted, a block stays tainted for the session.
 *
 * 8 MB RDRAM / 64 KB = 128 blocks. One byte per block for simplicity. */
#define KN_TAINT_BLOCKS 128
#define KN_TAINT_BLOCK_SHIFT 16   /* 64 KB per block */
uint8_t kn_rdram_taint[KN_TAINT_BLOCKS] = {0};

/* Set by savestates_save_m64p — byte offset of dev->rdram.dram inside the
 * serialized save buffer. Used by kn_game_state_hash to skip tainted blocks
 * when iterating the saved RDRAM region. */
size_t kn_rdram_offset_in_state = 0;

/* Option X-2: Skip the post-RDRAM section of the savestate when computing
 * kn_game_state_hash. The post-RDRAM section contains cycle-clock-derived
 * state (cp0 count, event queue, fb tracker dirty pages) that drifts
 * across peers even when game logic is identical. Set by kn_rollback_init
 * once the rollback engine is in use. Never cleared. */
int kn_skip_post_rdram_in_hash = 0;

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_taint_rdram(uint32_t addr, uint32_t size) {
    /* RDRAM is 8 MB. Mask off N64 virtual/physical base bits, ignore OOB. */
    addr &= 0x7FFFFFu;
    if (size == 0) return;
    uint32_t end = addr + size;
    if (end > 0x800000u) end = 0x800000u;
    uint32_t start_block = addr >> KN_TAINT_BLOCK_SHIFT;
    uint32_t end_block = (end - 1u) >> KN_TAINT_BLOCK_SHIFT;
    if (end_block >= KN_TAINT_BLOCKS) end_block = KN_TAINT_BLOCKS - 1u;
    for (uint32_t b = start_block; b <= end_block; b++) {
        kn_rdram_taint[b] = 1;
    }
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
uint32_t kn_get_taint_blocks(uint8_t *out) {
    if (!out) return 0;
    memcpy(out, kn_rdram_taint, KN_TAINT_BLOCKS);
    return KN_TAINT_BLOCKS;
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_reset_taint(void) {
    memset(kn_rdram_taint, 0, KN_TAINT_BLOCKS);
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_tainted_block_count(void) {
    int count = 0;
    for (int i = 0; i < KN_TAINT_BLOCKS; i++)
        if (kn_rdram_taint[i]) count++;
    return count;
}

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
    int *ring_sf_state;   /* SoftFloat state per slot (not in retro_serialize) */
    size_t state_size;    /* retro_serialize_size() */

    /* Input ring: per-player, per-frame */
    kn_input_t inputs[KN_MAX_PLAYERS][KN_INPUT_RING_SIZE];
    kn_input_t last_known[KN_MAX_PLAYERS]; /* for prediction (most recent real input) */
    kn_input_t prev_known[KN_MAX_PLAYERS]; /* for dead-reckoning (input before last_known) */
    int slot_active[KN_MAX_PLAYERS]; /* 1 once kn_feed_input called for this slot */
    int confirmed_frame[KN_MAX_PLAYERS]; /* highest frame confirmed by kn_feed_input */

    /* Previous-frame applied input for dirty-input serialize gate.
     * RetroArch runahead approach: only save state when the input
     * applied to the emulator CHANGES from the previous frame.
     * If input is identical, the state can be derived by replaying
     * from the last saved state with the same input. */
    kn_input_t prev_applied[KN_MAX_PLAYERS]; /* input applied on previous frame */
    int prev_applied_valid; /* 0 until first frame applies input */

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
    uint32_t *rng_netplay_ptr; /* pointer to Smash Remix netplay seed (0x3CB3C) */

    /* Full RDRAM preservation during replay.
     * Replay runs extra retro_run() calls that mutate RDRAM everywhere —
     * game globals, heap, audio, interrupt state. Instead of chasing
     * individual divergent blocks, we save/restore the ENTIRE 8MB RDRAM
     * before/after replay. This guarantees replay has zero lasting side
     * effects on ANY RDRAM, regardless of which blocks are tainted.
     * Cost: ~2-3ms per save/restore on mobile (one memcpy each way). */
    uint8_t *rdram_base;       /* -> start of RDRAM (set by JS) */
    uint8_t *saved_rdram;      /* malloc'd 8MB buffer for snapshot */

    /* Dirty-input gate: skip retro_serialize when no predictions are
     * active (all remote inputs arrived on time). Inspired by RetroArch's
     * runahead preemptive frames — most frames have identical input and
     * don't need a state snapshot because no rollback will target them.
     * Reduces per-frame serialize from 16MB × 60fps = 960MB/s to near
     * zero on stable connections. */
    int has_active_predictions; /* 1 if any slot has predicted input */
    int serialize_skip_count;  /* diagnostic: frames skipped */

    /* Ring staleness ceiling: last frame where a state was saved.
     * Forces a periodic save even during long zero-input runs so
     * every ring slot stays fresh within one ring_size window. */
    int last_save_frame;

    /* Stats */
    int rollback_count;
    int prediction_count;
    int correct_predictions;
    int max_depth;
    int failed_rollbacks; /* mispredictions that couldn't roll back = silent desync */
    /* Misprediction breakdown (T2) — populated by kn_feed_input on each mispredict */
    int button_mispredictions; /* btn differed, sticks matched */
    int stick_mispredictions;  /* sticks differed, btn matched */
    int both_mispredictions;   /* both differed */
    /* Tolerance hits: predicted/actual stick bytes differed but within
     * KN_STICK_TOLERANCE, so we skipped the rollback. Tracks how often
     * the tolerance window is absorbing what would have been rollbacks. */
    int tolerance_hits;

    /* RF1 (R1): did_restore flag — set by the rollback branch immediately
     * after retro_unserialize. JS polls via kn_rollback_did_restore() and
     * re-captures the Emscripten rAF runner via pauseMainLoop/resumeMainLoop.
     * Flag is read-and-clear, same pattern as replay_depth.
     * See docs/netplay-invariants.md §R1. */
    int did_restore;

    /* RF7 (R3): Fatal stale-ring signal. Set by kn_feed_input when a
     * misprediction targets a ring slot that no longer holds the
     * expected frame. JS polls via kn_get_fatal_stale() and logs
     * FATAL-RING-STALE loudly. No resync recovery per §Core principle.
     * See docs/netplay-invariants.md §R3. */
    int fatal_stale_f;
    int fatal_stale_ring_idx;
    int fatal_stale_actual;
    int fatal_stale_pending;

    /* RF5 (R4): Live-vs-ring hash mismatch signal. Set by kn_post_tick
     * when a replay completes and the live state hash differs from
     * what the ring claims for the just-completed frame. JS polls via
     * kn_get_live_mismatch() and logs RB-LIVE-MISMATCH. No resync
     * recovery per §Core principle.
     * See docs/netplay-invariants.md §R4. */
    int live_mismatch_pending;
    int live_mismatch_f;
    uint32_t live_mismatch_replay;
    uint32_t live_mismatch_live;

    /* Debug log */
    char debug_log[KN_DEBUG_LOG_SIZE];
    int debug_log_pos;
} rb;

/* ── SoftFloat state save/restore ──────────────────────────────────── */
/* SoftFloat globals are NOT part of retro_serialize. Pack them into one
 * int per ring slot so rollback replay starts with the correct rounding
 * mode and exception flags. Without this, a rollback that restores a
 * savestate leaves SoftFloat at the *current* frame's values, causing
 * replay to compute different floats than the original execution. */
static inline int sf_pack(void) {
    return (softfloat_roundingMode << 8) | (softfloat_exceptionFlags & 0xFF);
}
static inline void sf_restore(int packed) {
    softfloat_roundingMode = (packed >> 8) & 0xFF;
    softfloat_exceptionFlags = packed & 0xFF;
}

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

    /* Normalize event queue for cross-platform determinism */
    {
        extern int kn_normalize_events_flag;
        extern void kn_normalize_event_queue(void);
        if (kn_normalize_events_flag)
            kn_normalize_event_queue();
    }

    /* Quantization is now built into kn_normalize_event_queue —
     * relative offsets are rounded to 2048-cycle granularity. */

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
        if (rb.rng_netplay_ptr) *rb.rng_netplay_ptr = h;
    }
}

/* ── Write inputs for all players for a given frame ────────────────── */
/* During replay (is_replay=1), logs what's actually being written to catch
 * input divergence between normal play and replay. */
static void write_frame_inputs_logged(int frame, int is_replay) {
    int s, idx;
    idx = frame % KN_INPUT_RING_SIZE;
    /* Build a compact log of all slot inputs: "s0[btn,lx,ly,P] s1[btn,lx,ly,P]" */
    char inputs_str[256];
    int pos = 0;
    for (s = 0; s < KN_MAX_PLAYERS; s++) {
        int btn = 0, lx = 0, ly = 0, cx = 0, cy = 0;
        char origin = '?';
        if (s < rb.num_players) {
            kn_input_t *inp = &rb.inputs[s][idx];
            if (inp->present && inp->frame == frame) {
                btn = inp->buttons; lx = inp->lx; ly = inp->ly; cx = inp->cx; cy = inp->cy;
                origin = rb.predicted[s][idx] ? 'P' : 'R'; /* Predicted or Real */
                kn_write_controller(s, btn, lx, ly, cx, cy);
            } else {
                origin = 'Z'; /* Zero — missing input */
                kn_write_controller(s, 0, 0, 0, 0, 0);
            }
        } else {
            origin = 'X'; /* Not a player slot */
            kn_write_controller(s, 0, 0, 0, 0, 0);
        }
        if (pos < (int)sizeof(inputs_str) - 32) {
            pos += snprintf(inputs_str + pos, sizeof(inputs_str) - pos,
                "s%d[%d,%d,%d,%c] ", s, btn, lx, ly, origin);
        }
    }
    if (is_replay) {
        rb_log("REPLAY-INPUT f=%d %s", frame, inputs_str);
    }
}

static void write_frame_inputs(int frame) {
    write_frame_inputs_logged(frame, 0);
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
    rb.last_save_frame = -1;
    /* retro_serialize is now safe (static scratch buffer patch eliminates the
     * 16MB malloc per call). Same code path used by gm.getState() and resync. */
    rb.state_size = retro_serialize_size();
    rb.ring_size = max_frames + 1;

    /* Allocate state ring */
    rb.ring_bufs = (uint8_t **)calloc(rb.ring_size, sizeof(uint8_t *));
    rb.ring_frames = (int *)calloc(rb.ring_size, sizeof(int));
    rb.ring_sf_state = (int *)calloc(rb.ring_size, sizeof(int));
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

    /* Fix 4 (Option X): Taint SSB64 game object allocator pool.
     *
     * Forensic analysis of match 766/767 (room 9V1UXLV1) showed that the
     * persistent cross-peer divergence was concentrated in RDRAM region
     * 0x795c00-0x79c000 (~26 KB). Byte-level correlation revealed that
     * this is SSB64's internal game-object linked list: floats for
     * position/velocity matched between peers, but RDRAM pointers (values
     * in 0x80xxxxxx range) pointed to different physical addresses.
     *
     * Root cause: SSB64's object allocator hands out memory from a pool
     * in a deterministic sequence, but the SEQUENCE depends on cycle-clock
     * timing of alloc/free operations. Libultra OS interrupts (which we
     * already know diverge across peers due to JIT cycle quantization)
     * interleave with allocator calls at different points on each peer,
     * producing different addresses even though the game logic is
     * identical. The game plays correctly — positions, damage, actions
     * all match — but the raw byte hash sees different pointers and
     * reports a spurious desync.
     *
     * Tainting this region excludes it from the game-state hash so
     * pointer differences don't trigger false-positive rollbacks. The
     * game continues working correctly because each peer reads its own
     * (locally consistent) pointers.
     *
     * Range: 0x795c00 to 0x79c000 = 0x6400 bytes = ~25 KB. Covers the
     * three r121 sub-chunks where divergence was observed plus a safety
     * margin on both sides. Rounds to four 64-KB taint blocks
     * (0x70-0x73) to match the existing taint block granularity, which
     * is coarser than the actual diverging range but simpler and equally
     * effective — the neighboring 64 KB blocks are mostly zeros anyway.
     *
     * If this doesn't eliminate mismatches, there are more pointer-
     * divergent regions we haven't mapped yet; fall back to Option Y
     * (pointer-canonicalizing hash). */
    kn_taint_rdram(0x795c00, 0x6400);
    rb_log("kn_rollback_init: tainted SSB64 object pool 0x795c00 size=0x6400");

    /* Taint HUD sprite object heap region (RDRAM block 113: 0x710000-0x71FFFF).
     *
     * Match 8e03e6ed analysis: the ONLY RDRAM divergence was in savestate
     * region 112 (0x700000), sub-chunks 233-235 (~0x710490-0x710690).
     * Cross-referencing with the SSB64 decomp (ssb-decomp-re), these bytes
     * are GObj.anim_frame (f32 at offset 0x60) in SObj (Sprite Object)
     * linked-list nodes allocated on the heap. The sprite structs contain
     * HUD display data: damage % color (0xFF1515E0), scale factors (1.0),
     * dimensions (28x30), and a per-frame animation timer that drifts
     * between peers due to CP0 cycle-clock quantization differences.
     *
     * This is purely cosmetic — the animation timer drives HUD sprite
     * transitions (blinking, fading) not game logic (hitboxes, knockback,
     * positioning). Tainting block 113 eliminates the last RDRAM-level
     * divergence source, making the game-state hash fully deterministic
     * across peers for the first time. */
    kn_taint_rdram(0x710000, 0x10000);
    rb_log("kn_rollback_init: tainted HUD sprite heap 0x710000 size=0x10000");

    /* Taint N64 OS kernel/thread area (RDRAM block 4: 0x40000-0x4FFFF).
     *
     * Match 099c65b5 (desktop↔iPhone): hashes matched for 600 frames,
     * then region 4 sub-chunk 13 (address 0x40D00) diverged. By frame
     * 3599 the divergence spread across 22 sub-chunks in region 4-5.
     * Address 0x800465D0 in this range is screen_interrupt (Global.asm).
     * The area contains OS thread scheduling state, interrupt handlers,
     * and timer contexts — all driven by CP0 Count which drifts between
     * WASM JIT engines (V8 vs JSC). Not game-logic-relevant. */
    kn_taint_rdram(0x40000, 0x20000);
    rb_log("kn_rollback_init: tainted N64 OS kernel area 0x40000 size=0x20000");

    /* Taint libultra OS data + audio DMA regions (blocks 8-10: 0x80000-0xAFFFF).
     * Cross-engine (V8 vs JSC) analysis shows 1-LSB audio sample differences
     * from RSP HLE floating-point rounding. Not game-logic-relevant. */
    kn_taint_rdram(0x80000, 0x30000);
    rb_log("kn_rollback_init: tainted libultra/audio DMA 0x80000 size=0x30000");

    /* Taint heap fill-pattern region (blocks 57-62: 0x390000-0x3EFFFF).
     * V8 fills freed heap with 0xFEEDFEED, JSC with 0xFF67FF67.
     * These are N64 OS heap free-blocks or RSP audio double-buffers —
     * not game state. */
    kn_taint_rdram(0x390000, 0x60000);
    rb_log("kn_rollback_init: tainted heap/audio fill region 0x390000 size=0x60000");

    /* Taint block 19-20 (0x130000-0x14FFFF): cross-engine divergence detected
     * but sampled sub-chunks were identical — divergent bytes not yet located.
     * PROVISIONAL taint: if game-relevant state lives here, remove this and
     * fix at source. Needs byte-level diff to confirm. */
    kn_taint_rdram(0x130000, 0x20000);
    rb_log("kn_rollback_init: tainted match runtime 0x130000 size=0x20000 (provisional)");

    /* Taint blocks that diverge during rollback replay due to interrupt
     * timing differences. Identified via C-REGIONS diff across multiple
     * mobile-to-mobile sessions (6f865c3d, 9de54b0c, db6cd248, 1f5ee6cf,
     * 2823557c). Divergent heap blocks shift depending on game state —
     * individual block taints are whack-a-mole. Taint the full range. */

    /* Block 2 (0x20000-0x2FFFF): N64 OS exception vectors + thread stacks. */
    kn_taint_rdram(0x20000, 0x10000);
    rb_log("kn_rollback_init: tainted OS thread stacks 0x20000 size=0x10000");

    /* Blocks 6-7 (0x60000-0x7FFFF): RSP HLE work area + audio processing.
     * Sub-chunks 97,98,102,103,107,108 in block 6 diverge during replay
     * due to RSP audio task timing differences between V8/JSC WASM JITs.
     * No gameplay hash addresses in this range. */
    kn_taint_rdram(0x60000, 0x20000);
    rb_log("kn_rollback_init: tainted RSP/audio work area 0x60000 size=0x20000");

    /* Blocks 11-13 (0xB0000-0xDFFFF): Audio DMA spillover + render data
     * + transitions table + file manager. Block 13 intermittently diverges
     * during screen transitions. */
    kn_taint_rdram(0xB0000, 0x30000);
    rb_log("kn_rollback_init: tainted audio/render/file data 0xB0000 size=0x30000");

    /* Blocks 21-112 (0x150000-0x70FFFF): Full N64 dynamic heap.
     * Heap allocation ordering depends on interrupt timing — objects have
     * identical data but at different RDRAM addresses on each peer.
     * No gameplay hash addresses exist in this range (all are in blocks
     * 0-19 which are handled separately). Subsumes the previous individual
     * heap block taints and the 0x390000 fill-pattern taint. */
    kn_taint_rdram(0x150000, 0x5C0000);
    rb_log("kn_rollback_init: tainted full heap 0x150000-0x70FFFF");

    /* Option X-2: Mark the post-RDRAM section of the savestate hash as
     * "ignore divergence". The post-RDRAM section contains CPU general
     * registers, cp0 (system control: status, cause, count), cp1 (FPU),
     * TLB entries, event queue, and fb tracker — all of which are
     * dominated by cycle-clock-derived state that drifts across peers
     * even when game logic is identical.
     *
     * Match 768 (clean for 10781 frames, then sustained divergence)
     * showed RB-DIFF "no block diffs" — meaning RDRAM matched but
     * the savestate hash still differed, so the divergence is in the
     * post-RDRAM section. We don't have a per-byte taint for the
     * post-RDRAM section (the existing kn_rdram_taint only covers
     * the 8MB RDRAM region), so we toggle a global flag that
     * kn_game_state_hash checks before iterating post-RDRAM bytes.
     *
     * The flag is set here at rollback init and never cleared. */
    kn_skip_post_rdram_in_hash = 1;
    rb_log("kn_rollback_init: post-RDRAM section excluded from game state hash");
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
    free(rb.ring_sf_state);
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

    /* Check if this corrects a prediction.
     * Validate the predicted_values entry has the right frame — the ring
     * buffer at idx may contain stale predictions from 256 frames ago. */
    if (rb.predicted[slot][idx] && rb.predicted_values[slot][idx].frame == frame) {
        kn_input_t *pred = &rb.predicted_values[slot][idx];
        /* Tolerant prediction match: buttons must match exactly (they're
         * discrete and affect gameplay logic directly), but stick axes can
         * differ by up to KN_STICK_TOLERANCE units without triggering a
         * rollback. Reasoning: an 83-unit N64 stick range is quantized so
         * finely that a ±4 unit difference in a single frame produces no
         * visible game-state change (position delta under 0.5 pixels),
         * but the rollback system currently treats byte inequality as a
         * misprediction and replays. On unstable networks this causes
         * cascading-rollback spiral. Tolerance here converts the most
         * common "fast stick jitter" false-positives into no-ops while
         * still catching real action changes via the button check. */
        /* Fix 2: Deadzone-aware tolerance.
         *
         * N64 games treat stick values below ~16 as "centered" — inside
         * the deadzone, the game doesn't react to movement at all. So
         * peers can have DIFFERENT raw stick bytes within the deadzone
         * and the game will behave identically on both sides.
         *
         * KN_STICK_TOLERANCE = 4 catches small jitter
         * KN_STICK_DEADZONE_TOL = 16 catches deadzone divergence
         *
         * If BOTH predicted and actual values are below deadzone,
         * they're considered a match regardless of exact bytes.
         * Above deadzone, we fall back to the tight ±4 tolerance. */
        /* Zone-based analog prediction comparison (inspired by fighting
         * game input quantization). The full-precision analog value is
         * always applied to the emulator — zones only affect whether a
         * misprediction is detected. Both predicted and real values are
         * mapped to a zone; if same zone, no rollback fires.
         *
         * N64 stick range: -83 to +83. Zone size 12 gives ~14 zones
         * per axis. Deadzone (±16) maps entirely to zone 0. This means
         * smooth stick motion within a zone doesn't trigger rollbacks,
         * but real direction changes (crossing zone boundaries) do.
         *
         * Why this matters: GGPO works because fighting games use 8-way
         * digital input. We're emulating a full analog stick — every
         * frame of stick movement is a unique value that the "repeat
         * last input" predictor gets wrong. Zones reduce the effective
         * input space from 166×166 to ~14×14, matching the prediction
         * accuracy that GGPO was designed for. */
        #define KN_STICK_ZONE_SIZE 12
        #define KN_STICK_ZONE(v) ((v) / KN_STICK_ZONE_SIZE)
        #define KN_AXIS_ZONE_MATCH(a, b) (KN_STICK_ZONE(a) == KN_STICK_ZONE(b))
        int btn_match = (pred->buttons == buttons);
        int lxd = pred->lx - lx; if (lxd < 0) lxd = -lxd;
        int lyd = pred->ly - ly; if (lyd < 0) lyd = -lyd;
        int cxd = pred->cx - cx; if (cxd < 0) cxd = -cxd;
        int cyd = pred->cy - cy; if (cyd < 0) cyd = -cyd;
        int exact_stick = (lxd == 0 && lyd == 0 && cxd == 0 && cyd == 0);
        int stick_within_zone = (KN_AXIS_ZONE_MATCH(pred->lx, lx) && KN_AXIS_ZONE_MATCH(pred->ly, ly)
                                && KN_AXIS_ZONE_MATCH(pred->cx, cx) && KN_AXIS_ZONE_MATCH(pred->cy, cy));
        int exact_match = btn_match && exact_stick;
        int match = btn_match && stick_within_zone;
        rb.predicted[slot][idx] = 0;

        if (match) {
            rb.correct_predictions++;
            /* Tolerance hit: we're absorbing a small stick jitter that
             * would have been a rollback. Log the first few so we can
             * see it working without flooding the log. */
            if (!exact_match) {
                rb.tolerance_hits++;
                if (rb.tolerance_hits <= 20 || rb.tolerance_hits % 100 == 0) {
                    rb_log("TOLERANCE-HIT slot=%d f=%d lx_d=%d ly_d=%d cx_d=%d cy_d=%d (total=%d)",
                        slot, frame, pred->lx - lx, pred->ly - ly, pred->cx - cx, pred->cy - cy, rb.tolerance_hits);
                }
            }
        } else if (frame < rb.frame) {
            /* T1/T2: categorize the misprediction for logging + aggregate stats */
            int btn_xor = pred->buttons ^ buttons;
            int lx_d = lx - pred->lx;
            int ly_d = ly - pred->ly;
            int cx_d = cx - pred->cx;
            int cy_d = cy - pred->cy;
            int stick_diff = (lx_d | ly_d | cx_d | cy_d) != 0;
            if (btn_xor && stick_diff)      rb.both_mispredictions++;
            else if (btn_xor)               rb.button_mispredictions++;
            else if (stick_diff)            rb.stick_mispredictions++;

            /* Fix 1: Visible rollback depth cap.
             *
             * rb.max_frames (the ring size) is large (12-20) to tolerate
             * real network jitter. Rollbacks deeper than ~7 frames (~117ms)
             * become perceptible but the cap also has to be high enough to
             * actually correct real mispredictions on jittery networks.
             *
             * History of this constant:
             *   - First shipped at 3 (commit d317925) → too tight, broke
             *     determinism on high-RTT networks (depth-4+ mispredictions
             *     were silently dropped, peers diverged in match 34d3299e)
             *   - Bumped to 7 (this commit) → matches Fightcade's default
             *     rollback window. ~117ms of visible rewind is at the edge
             *     of perception but absorbs most network jitter spikes.
             *
             * Mispredictions deeper than this are still silently dropped
             * (failedRollbacks++), so on truly bad networks the game will
             * still tolerate drift instead of snapping — but at the
             * expense of visible state divergence. Tuning this value is
             * a trade between "snap feel" and "desync resistance". */
            /* Dynamic cap: delay_frames + 4 ensures rollback can always
             * correct mispredictions at the apply frame. With delay=11,
             * a misprediction has depth=11 at minimum — the old hardcoded
             * cap of 7 silently dropped every single rollback. */
            int visible_rb_max = rb.delay_frames + 4;
            int depth = rb.frame - frame;
            if (depth > visible_rb_max) {
                /* Too deep to rewind invisibly — accept drift */
                rb.failed_rollbacks++;
                rb_log("DEEP-MISPREDICT-SKIP slot=%d f=%d myF=%d depth=%d (cap=%d delay=%d) btn_xor=0x%x lx_d=%d ly_d=%d cx_d=%d cy_d=%d",
                    slot, frame, rb.frame, depth, visible_rb_max, rb.delay_frames, btn_xor, lx_d, ly_d, cx_d, cy_d);
            } else if (depth <= rb.max_frames) {
                int ring_idx = frame % rb.ring_size;
                if (rb.ring_frames[ring_idx] == frame) {
                    if (rb.pending_rollback < 0 || frame < rb.pending_rollback) {
                        rb.pending_rollback = frame;
                        rb_log("MISPREDICTION slot=%d f=%d myF=%d depth=%d btn_xor=0x%x lx_d=%d ly_d=%d cx_d=%d cy_d=%d",
                            slot, frame, rb.frame, depth, btn_xor, lx_d, ly_d, cx_d, cy_d);
                    }
                    misprediction = 1;
                } else {
                    /* R3 VIOLATION: state for this frame was overwritten.
                     * With every-frame saves this should never happen. */
                    rb.failed_rollbacks++;
                    rb.fatal_stale_f = frame;
                    rb.fatal_stale_ring_idx = ring_idx;
                    rb.fatal_stale_actual = rb.ring_frames[ring_idx];
                    rb.fatal_stale_pending = 1;
                    rb_log("FATAL-RING-STALE slot=%d f=%d myF=%d depth=%d ring[%d]=%d btn_xor=0x%x lx_d=%d ly_d=%d cx_d=%d cy_d=%d",
                        slot, frame, rb.frame, depth, ring_idx, rb.ring_frames[ring_idx], btn_xor, lx_d, ly_d, cx_d, cy_d);
                }
            } else {
                /* SILENT DESYNC: misprediction too old to roll back */
                rb.failed_rollbacks++;
                rb_log("FAILED-ROLLBACK slot=%d f=%d myF=%d depth=%d (exceeds max=%d) btn_xor=0x%x lx_d=%d ly_d=%d cx_d=%d cy_d=%d",
                    slot, frame, rb.frame, depth, rb.max_frames, btn_xor, lx_d, ly_d, cx_d, cy_d);
            }
        }
    }

    /* Store real input + update dead-reckoning history */
    rb.inputs[slot][idx] = real_input;
    rb.prev_known[slot] = rb.last_known[slot];
    rb.last_known[slot] = real_input;
    rb.slot_active[slot] = 1;
    if (frame > rb.confirmed_frame[slot])
        rb.confirmed_frame[slot] = frame;
    return misprediction;
}

/* ── Pre-tick: save state, store input, predict ──────────────────── */
/* Returns: >= 0 = current frame (normal), < -1 = rollback occurred,
 * replay needed from frame (-return - 2) to current frame.
 * e.g., return -5 means replay 3 frames starting from (current - 3). */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_pre_tick(int buttons, int lx, int ly, int cx, int cy, int frame_adv) {
    int s, idx, apply_frame;
    if (!rb.initialized) return -1;

    /* ── Pacing gate: if JS says we're too far ahead, maintain ring and skip ──
     * frame_adv >= 0 means JS computed a valid frame advantage.
     * If frame_adv >= delay_frames + 2, we're ahead enough to skip — but
     * first check if the ring needs a save to prevent FATAL-RING-STALE. */
    if (frame_adv >= 0 && frame_adv >= rb.delay_frames + 2 &&
        rb.pending_rollback < 0 && rb.replay_remaining == 0) {
        int ring_needs_save = 0;
        if (rb.last_save_frame < 0 ||
            (rb.frame - rb.last_save_frame) >= rb.ring_size / 2) {
            ring_needs_save = 1;
        }
        if (!ring_needs_save && rb.frame > rb.max_frames) {
            int oldest_window_frame = rb.frame - rb.max_frames;
            int oldest_idx = oldest_window_frame % rb.ring_size;
            if (rb.ring_frames[oldest_idx] != oldest_window_frame) {
                ring_needs_save = 1;
            }
        }
        if (ring_needs_save) {
            int save_idx = rb.frame % rb.ring_size;
            retro_serialize(rb.ring_bufs[save_idx], rb.state_size);
            rb.ring_sf_state[save_idx] = sf_pack();
            rb.ring_frames[save_idx] = rb.frame;
            rb.last_save_frame = rb.frame;
        }
        return 3; /* ring maintained, skip frame advance */
    }

    /* ── Handle pending rollback: restore state, start amortized catch-up ──
     *
     * P3: Preempt an active replay if a newer (earlier-frame) misprediction
     * arrives — e.g., a slow packet finally delivered for a frame before the
     * current replay window's start. Continuing the stale replay would waste
     * frames on known-wrong state. We discard replay_remaining and restart
     * from the earlier frame; retro_unserialize fully overwrites emulator
     * state, so no bookkeeping is needed to "undo" the partial replay. */
    if (rb.pending_rollback >= 0 &&
        (rb.replay_remaining == 0 || rb.pending_rollback < rb.replay_start)) {
        int rb_frame = rb.pending_rollback;
        int depth = rb.frame - rb_frame;
        int ring_idx = rb_frame % rb.ring_size;
        if (rb.replay_remaining > 0) {
            /* Preempting an active replay — restore full RDRAM to pre-replay
             * values FIRST, so the partial replay's mutations don't
             * contaminate the next save. */
            if (rb.rdram_base && rb.saved_rdram)
                memcpy(rb.rdram_base, rb.saved_rdram, 0x800000);
            rb_log("C-REPLAY-PREEMPT old_start=%d old_remaining=%d new_start=%d",
                rb.replay_start, rb.replay_remaining, rb_frame);
            rb.replay_remaining = 0;
        }
        rb.pending_rollback = -1;

        if (rb.ring_frames[ring_idx] == rb_frame && depth > 0 && depth <= rb.max_frames) {
            /* Save full RDRAM BEFORE state restore. These are the "real"
             * values that both peers agree on. Replay will mutate them,
             * but we restore the entire 8MB after replay ends. */
            if (rb.rdram_base && rb.saved_rdram)
                memcpy(rb.saved_rdram, rb.rdram_base, 0x800000);

            retro_unserialize(rb.ring_bufs[ring_idx], rb.state_size);
            sf_restore(rb.ring_sf_state[ring_idx]);
            /* R1: retro_unserialize invalidates the Emscripten rAF runner
             * captured by JS's overrideRAF interceptor. JS must re-capture
             * it via pauseMainLoop/resumeMainLoop before the next
             * stepOneFrame call, or the replay runs as silent no-ops.
             * See docs/netplay-invariants.md §R1. */
            rb.did_restore = 1;
            rb.rollback_count++;
            if (depth > rb.max_depth) rb.max_depth = depth;
            rb.replay_remaining = depth;
            rb.replay_target = rb.frame;
            rb.frame = rb_frame;
            rb.replay_depth = depth;
            rb.replay_start = rb_frame;
            rb_log("C-REPLAY-START f=%d depth=%d target=%d replay_remaining=%d replay_depth=%d",
                rb_frame, depth, rb.replay_target, rb.replay_remaining, rb.replay_depth);
        } else {
            /* Restore impossible — treat as silent desync so P4 resync path triggers */
            rb.failed_rollbacks++;
            rb_log("RESTORE-FAILED f=%d ring[%d]=%d depth=%d (failed_rollbacks=%d)",
                rb_frame, ring_idx, rb.ring_frames[ring_idx], depth, rb.failed_rollbacks);
        }
    }

    /* Defensive: if rollback just restored state (did_restore=1) but
     * replay_remaining is unexpectedly 0, something corrupted it between
     * the assignment at line ~801 and the check below. Re-derive from
     * frame position so the replay executes instead of being silently
     * skipped (which causes the first replay frame to run as a normal
     * tick with wrong inputs → permanent desync).
     * If this fires, log loudly for root cause investigation. */
    if (rb.did_restore && rb.replay_remaining <= 0 &&
        rb.replay_target > rb.frame) {
        int expected = rb.replay_target - rb.frame;
        rb_log("REPLAY-REMAINING-FIXUP was=%d expected=%d frame=%d target=%d",
            rb.replay_remaining, expected, rb.frame, rb.replay_target);
        rb.replay_remaining = expected;
        rb.replay_depth = expected; /* re-expose to JS */
    }

    /* ── Amortized catch-up: prepare 1 replay frame, JS will step it ──
     * During catch-up, C writes inputs + saves state, then returns 2.
     * JS handles the actual emulator step via stepOneFrame() — same code
     * path as normal play. This is the only way to guarantee bit-identical
     * execution between normal play and replay. */
    if (rb.replay_remaining > 0) {
        int replay_apply = rb.frame - rb.delay_frames;
        int save_idx = rb.frame % rb.ring_size;

        /* Save state for this frame BEFORE stepping.
         * R5 diagnostic: log the replay frame details. */
        rb_log("C-REPLAY-FRAME f=%d remaining=%d apply=%d save_idx=%d",
            rb.frame, rb.replay_remaining, replay_apply, save_idx);
        retro_serialize(rb.ring_bufs[save_idx], rb.state_size);
        rb.ring_sf_state[save_idx] = sf_pack();
        rb.ring_frames[save_idx] = rb.frame;

        /* Write inputs for this replay frame (logged for divergence detection) */
        if (replay_apply >= 0) {
            write_frame_inputs_logged(replay_apply, 1);
        } else {
            int s;
            for (s = 0; s < KN_MAX_PLAYERS; s++)
                kn_write_controller(s, 0, 0, 0, 0, 0);
        }

        /* Pre-frame setup (frame time, event queue normalization, audio
         * reset, RNG sync) is handled by JS stepOneFrame() — the same code
         * path as normal play. Calling setup_frame() HERE would double-call
         * normalize/reset and introduce ordering differences between replay
         * and normal play, causing progressive state divergence.
         *
         * JS will call stepOneFrame() which goes through the rAF/runner
         * pipeline — bit-identical to normal play. Then JS calls
         * kn_post_tick which advances rb.frame and decrements replay_remaining. */
        return 2; /* 2 = JS should step the emulator for a replay frame */
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
    rb.has_active_predictions = 0;
    if (apply_frame >= 0) {
        for (s = 0; s < rb.num_players; s++) {
            if (s == rb.local_slot) continue;
            /* Skip empty slots — num_players is always 4 (KN_MAX_PLAYERS)
             * for slot mapping, but only occupied slots send input. Without
             * this check, empty slots are "predicted" every frame, setting
             * has_active_predictions=1 and defeating the serialize skip.
             * A slot is considered empty if kn_feed_input has NEVER been
             * called for it (last_known stays zeroed from calloc). We
             * detect this by checking if last_known has ever been written
             * via a flag set by kn_feed_input. */
            if (!rb.slot_active[s]) continue;
            idx = apply_frame % KN_INPUT_RING_SIZE;
            /* Guard against stale ring entries: the present flag from a
             * previous cycle (256 frames ago) can still be set. Verify
             * the stored frame number matches apply_frame. */
            /* Check if this slot's input needs prediction. A slot needs
             * prediction if the input is missing OR if a prior tick already
             * predicted it (present=1 but predicted[]=1). In both cases,
             * kn_feed_input may later arrive with a different value,
             * triggering a misprediction — so we need state in the ring. */
            int needs_prediction = !rb.inputs[s][idx].present
                                || rb.inputs[s][idx].frame != apply_frame
                                || rb.predicted[s][idx];
            if (needs_prediction && (!rb.inputs[s][idx].present || rb.inputs[s][idx].frame != apply_frame)) {
                /* Predict: dead-reckoning for stick, repeat-last for buttons.
                 * Extrapolate stick position based on velocity between the
                 * two most recent real inputs. Buttons are binary so
                 * repeat-last is optimal (you're either pressing or not).
                 *
                 * Clamped to N64 stick range [-83, 83] to prevent
                 * extrapolation from producing out-of-range values. */
                #define KN_CLAMP_STICK(v) ((v) < -83 ? -83 : (v) > 83 ? 83 : (v))
                kn_input_t pred_input = rb.last_known[s];
                pred_input.lx = KN_CLAMP_STICK(2 * rb.last_known[s].lx - rb.prev_known[s].lx);
                pred_input.ly = KN_CLAMP_STICK(2 * rb.last_known[s].ly - rb.prev_known[s].ly);
                pred_input.cx = KN_CLAMP_STICK(2 * rb.last_known[s].cx - rb.prev_known[s].cx);
                pred_input.cy = KN_CLAMP_STICK(2 * rb.last_known[s].cy - rb.prev_known[s].cy);
                /* Buttons: repeat last (no extrapolation for digital) */
                pred_input.buttons = rb.last_known[s].buttons;
                rb.inputs[s][idx] = pred_input;
                rb.inputs[s][idx].present = 1;
                rb.inputs[s][idx].frame = apply_frame;
                rb.predicted[s][idx] = 1;
                rb.predicted_values[s][idx] = pred_input;
                rb.predicted_values[s][idx].frame = apply_frame;
                rb.prediction_count++;
                rb.has_active_predictions = 1;
            } else if (needs_prediction) {
                /* Input is present but was predicted on a prior tick.
                 * Still counts as active prediction for serialize gate. */
                rb.has_active_predictions = 1;
            }
        }
    }

    /* ── Save state for current frame (dirty-input gated) ──
     * Only serialize when predictions are active — if all remote inputs
     * arrived on time, no rollback can target this frame. Inspired by
     * RetroArch's runahead preemptive frames: skip serialization on
     * steady-state frames to avoid 16MB memcpy at 60fps (960MB/s).
     *
     * When a prediction IS active, we must save because a future
     * misprediction could roll back to this frame. We also save
     * unconditionally if a rollback is pending (need the most recent
     * state for the replay target). */
        /* Save state every frame — no serialize skip gate.
         *
         * The previous dirty-input gate skipped saves when inputs didn't
         * change, creating ring coverage gaps. FATAL-RING-STALE at f=23410
         * proved this causes permanent desync: 4 mispredictions couldn't
         * be rolled back, wrong inputs ran uncorrected, characters diverged.
         *
         * Cost: ~3-5ms per serialize (16MB). At 60fps with the gate, we
         * already saved ~59% of frames. Going to 100% adds ~1.5-2ms/frame
         * average — well within the 16.6ms budget. Eliminates ring gaps. */
        {
            int save_idx = rb.frame % rb.ring_size;
            retro_serialize(rb.ring_bufs[save_idx], rb.state_size);
            rb.ring_sf_state[save_idx] = sf_pack();
            rb.ring_frames[save_idx] = rb.frame;
            rb.last_save_frame = rb.frame;
        }

    /* Input writing is done by JS using kn_get_input + writeInputToMemory */
    /* R5 diagnostic: log if replay_depth is nonzero at normal-tick return.
     * This should never happen — if replay_depth was set, replay_remaining
     * should also be > 0 and we'd return 2 above. If this fires, something
     * corrupted replay_remaining without clearing replay_depth. */
    if (rb.replay_depth > 0) {
        rb_log("R5-DIAG return=0 but replay_depth=%d replay_remaining=%d "
               "pending_rb=%d did_restore=%d frame=%d target=%d",
               rb.replay_depth, rb.replay_remaining,
               rb.pending_rollback, rb.did_restore,
               rb.frame, rb.replay_target);
    }
    return 0; /* 0 = normal tick, JS should do stepOneFrame */
}

/* ── Gameplay address table (used by kn_post_tick stash + kn_gameplay_hash) ── */

typedef struct {
    uint32_t rdram_offset;
    uint32_t size;
} kn_gameplay_addr_t;

static const kn_gameplay_addr_t kn_gameplay_addrs[] = {
    /* Screen + game status */
    { 0xA4AD0, 1 },   /* current_screen */
    { 0xA4D19, 1 },   /* game_status (0=wait,1=ongoing,2=paused,5=end) */
    /* VS settings block */
    { 0xA4D08, 28 },  /* stage, mode, teams, time, stocks, handicap, ... timer, elapsed */
    /* VS player stocks (offset 0x2B within each 0x74-byte player entry) */
    { 0xA4D53, 1 },   /* P1 stock count */
    { 0xA4DC7, 1 },   /* P2 stock count */
    { 0xA4E3B, 1 },   /* P3 stock count */
    { 0xA4EAF, 1 },   /* P4 stock count */
    /* In-game player struct: character ID (offset 0x08, 4 bytes) */
    { 0x130D8C, 4 },  /* P1 char_id */
    { 0x1318DC, 4 },  /* P2 char_id */
    { 0x13242C, 4 },  /* P3 char_id */
    { 0x132F7C, 4 },  /* P4 char_id */
    /* In-game player struct: damage % (offset 0x2C, 4 bytes) */
    { 0x130DB0, 4 },  /* P1 damage */
    { 0x131900, 4 },  /* P2 damage */
    { 0x132450, 4 },  /* P3 damage */
    { 0x132FA0, 4 },  /* P4 damage */
    /* RNG seeds */
    { 0x05B940, 4 },  /* primary LCG seed */
    { 0x0A0578, 4 },  /* alternate seed */
};
#define KN_GAMEPLAY_ADDR_COUNT (sizeof(kn_gameplay_addrs) / sizeof(kn_gameplay_addrs[0]))
/* Total bytes across all gameplay addresses (73 bytes as of writing).
 * Used for the stack-allocated stash buffer in kn_post_tick. Padded
 * to 128 for alignment and headroom if addresses are added. */
#define KN_GAMEPLAY_STASH_SIZE 128

/* ── Post-tick: advance frame counter, decrement replay if catching up ── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_post_tick(void) {
    if (!rb.initialized) return -1;
    rb.frame++;
    if (rb.replay_remaining > 0) {
        rb.replay_remaining--;
        if (rb.replay_remaining == 0) {
            /* GGPO-style full serialize: keep the replay's RDRAM as-is.
             *
             * The previous stash-and-restore approach saved 73 gameplay bytes
             * from replay, restored full 8MB RDRAM to forward-pass values,
             * then patched the 73 bytes back. GP-DUMP analysis (Apr 2026)
             * proved this CORRUPTED game state: VS_settings were zeroed after
             * rollback, causing camera changes and damage immunity on host.
             *
             * Full serialize is safe because:
             * - Gameplay-critical values (stocks, damage, char_id) are
             *   identical between replay and normal execution (GP-DUMP confirmed)
             * - Non-deterministic RSP audio DRAM writes are handled by mode 2
             *   save/restore in send_alist_to_audio_plugin (384KB, not 8MB)
             * - Timer/RNG within-frame noise is excluded from the hash
             * - The taint system excludes audio/heap from desync detection */
            /* R4: Post-replay live-state verification. Hash the live
             * emulator state and compare to what the ring claims for
             * the just-completed frame. If they differ, the replay
             * introduced gameplay-level drift. Log loudly; no recovery.
             * See docs/netplay-invariants.md §R4. */
            {
                int target = rb.frame - 1;
                uint32_t ring_gp = kn_gameplay_hash(target);
                uint32_t live_gp = kn_live_gameplay_hash();
                if (ring_gp != 0 && live_gp != 0 && ring_gp != live_gp) {
                    rb.live_mismatch_pending = 1;
                    rb.live_mismatch_f = target;
                    rb.live_mismatch_replay = ring_gp;
                    rb.live_mismatch_live = live_gp;
                    rb_log("RB-LIVE-MISMATCH f=%d ring=0x%x live=0x%x",
                        target, ring_gp, live_gp);
                }
            }
            rb_log("C-REPLAY-DONE f=%d", rb.frame);
        }
    }
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

/* ── Configure Smash Remix netplay seed pointer ────────────────────── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_set_rng_netplay_ptr(uint32_t *ptr) {
    rb.rng_netplay_ptr = ptr;
    rb_log("RNG netplay ptr configured: %p", ptr);
}

/* ── Configure RDRAM preservation for replay (SSB64 / Smash Remix) ── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_set_rdram_preserve(uint8_t *rdram_base) {
    rb.rdram_base = rdram_base;
    if (rb.saved_rdram) free(rb.saved_rdram);
    rb.saved_rdram = (uint8_t *)malloc(0x800000); /* 8MB */
    rb_log("rdram preserve: base=%p buf=%p (8MB)", rdram_base, rb.saved_rdram);
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

/* ── Query: did the rollback branch just restore state? ───────────────
 * Returns 1 (and clears flag) if a rollback restore happened since the
 * last call. JS uses this to trigger pauseMainLoop/resumeMainLoop so the
 * rAF runner is re-captured before the next stepOneFrame. Per R1:
 * retro_unserialize invalidates _pendingRunner in JS. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_rollback_did_restore(void) {
    int v = rb.did_restore;
    rb.did_restore = 0;
    return v;
}

/* ── RF7 (R3): Returns 1 (and clears flag) if kn_feed_input just
 * detected a stale ring slot. Writes frame, ring_idx, actual-frame-
 * in-slot to out params for the JS FATAL-RING-STALE log. Per §Core
 * principle: JS logs and continues; no resync recovery. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_fatal_stale(int *out_f, int *out_idx, int *out_actual) {
    if (!rb.fatal_stale_pending) return 0;
    if (out_f) *out_f = rb.fatal_stale_f;
    if (out_idx) *out_idx = rb.fatal_stale_ring_idx;
    if (out_actual) *out_actual = rb.fatal_stale_actual;
    rb.fatal_stale_pending = 0;
    return 1;
}

/* ── RF5 (R4): Returns 1 (and clears flag) if post-replay live-state
 * hash mismatch was detected. Writes frame, ring hash, live hash to
 * out params. Per §Core principle: JS logs and continues; no resync
 * recovery. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_live_mismatch(int *out_f, uint32_t *out_ring, uint32_t *out_live) {
    if (!rb.live_mismatch_pending) return 0;
    if (out_f) *out_f = rb.live_mismatch_f;
    if (out_ring) *out_ring = rb.live_mismatch_replay;
    if (out_live) *out_live = rb.live_mismatch_live;
    rb.live_mismatch_pending = 0;
    return 1;
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
    if (!retro_unserialize(rb.ring_bufs[ring_idx], rb.state_size)) return 0;
    sf_restore(rb.ring_sf_state[ring_idx]);
    return 1;
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

/* ── Full state hash: hash the saved state for a specific frame ──── */
/* If frame == -1, hashes the most recently saved state. Otherwise hashes
 * the state saved for that specific frame from the ring buffer. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
uint32_t kn_full_state_hash(int frame) {
    if (!rb.initialized || rb.frame == 0) return 0;
    int target = (frame < 0) ? (rb.frame - 1) : frame;
    int idx = target % rb.ring_size;
    if (rb.ring_frames[idx] != target) return 0;
    uint32_t hash = 2166136261u;
    const uint8_t *p = rb.ring_bufs[idx];
    size_t i;
    for (i = 0; i < rb.state_size; i += 64) {
        hash ^= p[i];
        hash *= 16777619u;
    }
    return hash;
}

/* ── Game-state hash (Level 2 taint-filtered) ───────────────────────
 * Hashes the saved state buffer for a frame, but SKIPS 64 KB RDRAM blocks
 * that have been flagged as tainted by non-deterministic subsystems (RSP
 * HLE audio, GLideN64 framebuffer copybacks, etc). This is what RB-CHECK
 * uses — it cares about game-logic determinism, not audio/video transient
 * bytes. CPU state, cp0, cp1, TLB, pif, sp_mem, event queue, fb tracker
 * are all still included (they're outside the RDRAM region in the save
 * buffer and are hashed normally). Falls back to full hash if the RDRAM
 * offset hasn't been recorded yet (safety — shouldn't happen in practice). */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
uint32_t kn_game_state_hash(int frame) {
    if (!rb.initialized || rb.frame == 0) return 0;
    int target = (frame < 0) ? (rb.frame - 1) : frame;
    int idx = target % rb.ring_size;
    if (rb.ring_frames[idx] != target) return 0;
    if (kn_rdram_offset_in_state == 0) return kn_full_state_hash(frame);

    const uint8_t *p = rb.ring_bufs[idx];
    const size_t rdram_start = kn_rdram_offset_in_state;
    const size_t rdram_end = rdram_start + 0x800000u;  /* 8 MB */
    uint32_t hash = 2166136261u;
    size_t i;

    /* Pre-RDRAM: headers + registers + DMA regs.
     * When rollback is active (kn_skip_post_rdram_in_hash), skip this
     * section — it contains cycle-clock-derived register state (CP0 Count
     * residuals in header) that drifts harmlessly across WASM JIT engines.
     * The gameplay_hash addresses the detection gap. */
    if (!kn_skip_post_rdram_in_hash) {
        for (i = 0; i < rdram_start && i < rb.state_size; i += 16) {
            hash ^= p[i];
            hash *= 16777619u;
        }
    }

    /* RDRAM: skip tainted 64 KB blocks. */
    size_t actual_rdram_end = rdram_end < rb.state_size ? rdram_end : rb.state_size;
    for (i = rdram_start; i < actual_rdram_end; i += 16) {
        uint32_t rdram_off = (uint32_t)(i - rdram_start);
        uint32_t block = rdram_off >> KN_TAINT_BLOCK_SHIFT;
        if (block < KN_TAINT_BLOCKS && kn_rdram_taint[block]) continue;
        hash ^= p[i];
        hash *= 16777619u;
    }

    /* Post-RDRAM: SP mem, PIF, TLB LUT, cp0/cp1/cp2, event queue, fb state.
     * Option X-2: gated by kn_skip_post_rdram_in_hash. When the rollback
     * engine is active, this section is excluded entirely from the hash
     * because cycle-clock-derived state drifts harmlessly across peers. */
    if (!kn_skip_post_rdram_in_hash) {
        for (i = actual_rdram_end; i < rb.state_size; i += 16) {
            hash ^= p[i];
            hash *= 16777619u;
        }
    }

    return hash;
}

/* ── Gameplay hash — precise game-relevant RDRAM addresses ─────────
 * Hashes ONLY specific gameplay-relevant RDRAM addresses from a saved
 * state in the ring buffer: damage %, stocks, timer, RNG seeds, screen
 * state, character IDs. Immune to non-deterministic audio/video/heap
 * noise. This is the authoritative desync detection hash for rollback.
 *
 * ROM-SPECIFIC: These addresses are for SSB64 US v1.0 / Smash Remix.
 * Other ROMs would need their own address tables.
 *
 * NOTE: kn_gameplay_addrs[] and KN_GAMEPLAY_ADDR_COUNT are defined
 * earlier (before kn_post_tick) so the gameplay stash logic can use them. */

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
uint32_t kn_gameplay_hash(int frame) {
    if (!rb.initialized || rb.frame == 0) return 0;
    if (kn_rdram_offset_in_state == 0) return 0;
    int target = (frame < 0) ? (rb.frame - 1) : frame;
    int idx = target % rb.ring_size;
    if (rb.ring_frames[idx] != target) return 0;

    const uint8_t *state = rb.ring_bufs[idx];
    uint32_t hash = 2166136261u;

    for (int a = 0; a < KN_GAMEPLAY_ADDR_COUNT; a++) {
        size_t off = kn_rdram_offset_in_state + kn_gameplay_addrs[a].rdram_offset;
        uint32_t sz = kn_gameplay_addrs[a].size;
        if (off + sz > rb.state_size) continue; /* bounds check */
        for (uint32_t b = 0; b < sz; b++) {
            hash ^= state[off + b];
            hash *= 16777619u;
        }
    }
    return hash;
}

/* ── Live gameplay hash (RF5, R4) ──────────────────────────────────
 * Fresh retro_serialize + gameplay hash of the CURRENT live emulator
 * state, bypassing the ring buffer. Used by kn_post_tick to verify
 * that after a replay completes, the live state matches what the ring
 * claims. If they differ, the replay introduced drift and we log
 * RB-LIVE-MISMATCH.
 *
 * Uses a static scratch buffer reused across calls to avoid malloc
 * pressure. Expected cost: one retro_serialize (~1-2ms) per call.
 * Called at most once per rollback completion (rollbacks are rare),
 * so total overhead is negligible. Also exported for V1 integrity
 * harness use. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
uint32_t kn_live_gameplay_hash(void) {
    static uint8_t *scratch = NULL;
    static size_t scratch_capacity = 0;

    if (!rb.initialized) return 0;
    if (kn_rdram_offset_in_state == 0) return 0;

    size_t state_size = rb.state_size;
    if (scratch_capacity < state_size) {
        free(scratch);
        scratch = (uint8_t *)malloc(state_size);
        if (!scratch) {
            scratch_capacity = 0;
            return 0;
        }
        scratch_capacity = state_size;
    }

    if (!retro_serialize(scratch, state_size)) return 0;

    /* Same address-list loop as kn_gameplay_hash but over scratch. */
    uint32_t hash = 2166136261u;
    for (int a = 0; a < (int)KN_GAMEPLAY_ADDR_COUNT; a++) {
        size_t off = kn_rdram_offset_in_state + kn_gameplay_addrs[a].rdram_offset;
        uint32_t sz = kn_gameplay_addrs[a].size;
        if (off + sz > state_size) continue;
        for (uint32_t b = 0; b < sz; b++) {
            hash ^= scratch[off + b];
            hash *= 16777619u;
        }
    }
    return hash;
}

/* ── Get pointer to last saved state (for byte-level comparison) ──── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
uint8_t* kn_get_last_state(void) {
    if (!rb.initialized || rb.frame == 0) return NULL;
    int target = rb.frame - 1;
    int idx = target % rb.ring_size;
    if (rb.ring_frames[idx] != target) return NULL;
    return rb.ring_bufs[idx];
}

/* ── Per-region hashes of last saved state ──────────────────────────
 * Splits the state buffer into N equal-sized regions and hashes each.
 * Lets JS compare regions to pinpoint exactly where divergence is.
 * Writes count uint32 hashes into out_hashes. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_state_region_hashes(uint32_t *out_hashes, int count) {
    if (!rb.initialized || rb.frame == 0 || !out_hashes || count <= 0) return 0;
    int target = rb.frame - 1;
    int idx = target % rb.ring_size;
    if (rb.ring_frames[idx] != target) return 0;
    const uint8_t *p = rb.ring_bufs[idx];
    size_t region_size = rb.state_size / count;
    for (int r = 0; r < count; r++) {
        uint32_t hash = 2166136261u;
        const uint8_t *rp = p + (r * region_size);
        size_t end = (r == count - 1) ? rb.state_size : (r + 1) * region_size;
        size_t len = end - (r * region_size);
        for (size_t i = 0; i < len; i += 16) {  /* sample every 16th byte */
            hash ^= rp[i];
            hash *= 16777619u;
        }
        out_hashes[r] = hash;
    }
    return count;
}

/* ── Per-region hashes for a SPECIFIC frame's saved state ───────────────
 * RB-CHECK fires for past frames (typically rb.frame - 3 to rb.frame - 1),
 * so we need a frame-specific variant — kn_state_region_hashes only hashes
 * the most recent frame, which is wrong for cross-peer mismatch diagnosis.
 *
 * Returns count on success, 0 on failure (no buffer for that frame).
 * Same hashing scheme as kn_state_region_hashes — equal-size regions,
 * 16-byte stride sampling, 32-bit FNV-1a per region. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_state_region_hashes_frame(int frame, uint32_t *out_hashes, int count) {
    if (!rb.initialized || !out_hashes || count <= 0) return 0;
    int idx = frame % rb.ring_size;
    if (rb.ring_frames[idx] != frame) return 0;
    const uint8_t *p = rb.ring_bufs[idx];
    size_t region_size = rb.state_size / count;
    for (int r = 0; r < count; r++) {
        uint32_t hash = 2166136261u;
        const uint8_t *rp = p + (r * region_size);
        size_t end = (r == count - 1) ? rb.state_size : (r + 1) * region_size;
        size_t len = end - (r * region_size);
        for (size_t i = 0; i < len; i += 16) {
            hash ^= rp[i];
            hash *= 16777619u;
        }
        out_hashes[r] = hash;
    }
    return count;
}

/* ── State buffer layout introspection ─────────────────────────────────
 * Lets JS map region indices back to RDRAM-vs-non-RDRAM and compute
 * approximate byte offsets for divergence diagnosis. Returns the byte
 * offset of the RDRAM region inside the savestate buffer (0 if unknown
 * yet — set lazily by savestates_save_m64p on first save). */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_rdram_offset_in_state(void) {
    return (int)kn_rdram_offset_in_state;
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_state_buffer_size(void) {
    return (int)rb.state_size;
}

/* ── Stat getters ──────────────────────────────────────────────────── */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_frame(void) { return rb.frame; }

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_set_frame(int frame) {
    rb.frame = frame;
    rb_log("kn_set_frame: %d", frame);
}


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
int kn_get_failed_rollbacks(void) { return rb.failed_rollbacks; }

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_serialize_skip_count(void) { return rb.serialize_skip_count; }

/* T2: Misprediction breakdown by input category.
 * Writes 3 ints to out: [button_only, stick_only, both]. Returns 3. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_mispred_breakdown(int *out) {
    if (!out) return 0;
    out[0] = rb.button_mispredictions;
    out[1] = rb.stick_mispredictions;
    out[2] = rb.both_mispredictions;
    return 3;
}

/* Experiment A: tolerance hit counter. How often the stick-tolerance
 * window absorbed what would have been a rollback. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_tolerance_hits(void) { return rb.tolerance_hits; }

/* Get SoftFloat globals packed: high byte = roundingMode, low byte = exceptionFlags */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_softfloat_state(void) {
    return ((softfloat_roundingMode & 0xFF) << 8) | (softfloat_exceptionFlags & 0xFF);
}

/* Diagnostic: hash of hidden state sources NOT in retro_serialize.
 * Defined in main.c via build patch (needs access to g_dev internals). */
extern uint32_t kn_get_hidden_state_fingerprint_impl(void);

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
uint32_t kn_get_hidden_state_fingerprint(void) {
    return kn_get_hidden_state_fingerprint_impl();
}

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

/* ── Replay determinism self-test ──────────────────────────────────
 * Tests whether (save → N×run → hash) is byte-identical when repeated
 * from the same starting state. This is the core invariant rollback
 * replay relies on — if it doesn't hold, every misprediction introduces
 * permanent drift.
 *
 * Procedure:
 *   1. retro_serialize → state buffer A
 *   2. retro_run × n_frames → hash B
 *   3. retro_unserialize ← state buffer A
 *   4. retro_run × n_frames → hash B'
 *   5. Compare B vs B'
 *
 * Returns:
 *    1  → DETERMINISTIC (B == B')
 *    0  → NON-DETERMINISTIC (B != B')
 *   -1  → out of memory
 *   -2  → retro_serialize failed
 *   -3  → retro_unserialize failed
 *
 * Hashes are written to out_hashes[0]=B, out_hashes[1]=B'.
 *
 * Sets kn_headless during the test so GL state isn't perturbed. The EJS
 * main loop should be paused around this call (set EJS_PAUSED true) so
 * the canvas isn't rendering frames mid-test. */
extern int kn_headless;
extern void kn_set_headless(int enable);

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_replay_self_test(int n_frames, uint32_t *out_hashes) {
    static uint8_t *scratch_a = NULL;
    static uint8_t *scratch_b = NULL;
    static size_t scratch_capacity = 0;

    size_t state_size = retro_serialize_size();
    if (state_size == 0) return -1;

    if (scratch_capacity < state_size) {
        free(scratch_a);
        free(scratch_b);
        scratch_a = (uint8_t *)malloc(state_size);
        scratch_b = (uint8_t *)malloc(state_size);
        scratch_capacity = state_size;
        if (!scratch_a || !scratch_b) {
            scratch_capacity = 0;
            return -1;
        }
    }

    int prev_headless = kn_headless;
    kn_set_headless(1);

    /* Save A */
    if (!retro_serialize(scratch_a, state_size)) {
        kn_set_headless(prev_headless);
        return -2;
    }

    /* Run N frames forward */
    for (int i = 0; i < n_frames; i++) retro_run();

    /* Hash B */
    if (!retro_serialize(scratch_b, state_size)) {
        kn_set_headless(prev_headless);
        return -2;
    }
    uint32_t hash_b = 2166136261u;
    for (size_t i = 0; i < state_size; i += 16) {
        hash_b ^= scratch_b[i];
        hash_b *= 16777619u;
    }

    /* Restore A */
    if (!retro_unserialize(scratch_a, state_size)) {
        kn_set_headless(prev_headless);
        return -3;
    }

    /* Run N frames forward AGAIN */
    for (int i = 0; i < n_frames; i++) retro_run();

    /* Hash B' */
    if (!retro_serialize(scratch_b, state_size)) {
        kn_set_headless(prev_headless);
        return -2;
    }
    uint32_t hash_bprime = 2166136261u;
    for (size_t i = 0; i < state_size; i += 16) {
        hash_bprime ^= scratch_b[i];
        hash_bprime *= 16777619u;
    }

    kn_set_headless(prev_headless);

    if (out_hashes) {
        out_hashes[0] = hash_b;
        out_hashes[1] = hash_bprime;
    }

    return (hash_b == hash_bprime) ? 1 : 0;
}
