/* kn_hash_registry.c — see kn_hash_registry.h for invariants.
 *
 * IMPLEMENTATION RULES (enforced by reviewers, not the compiler):
 *   - One export per logical game field. No "combined" exports.
 *   - Citation block above every kn_hash_<field> declaration.
 *   - Sampling at kn_post_tick only. No alternate hooks.
 *   - FNV-1a over raw bytes. No float-as-float comparison logic.
 *   - History rings: 600 entries per field, ~10s @ 60fps.
 */

#include <stdint.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define KN_KEEPALIVE EMSCRIPTEN_KEEPALIVE
#else
#define KN_KEEPALIVE
#endif

#include "kn_gameplay_addrs.h"
#include "kn_hash_registry.h"

#ifndef KN_ENABLE_HASH_REGISTRY

#undef KN_KEEPALIVE
#define KN_KEEPALIVE

KN_KEEPALIVE
uint32_t kn_hash_fnv1a(const uint8_t* data, size_t len) {
    uint32_t h = 0x811c9dc5u;
    for (size_t i = 0; i < len; i++) {
        h ^= (uint32_t)data[i];
        h *= 0x01000193u;
    }
    return h;
}

KN_KEEPALIVE int kn_hash_registry_post_tick(int32_t frame, int in_replay) {
    (void)frame;
    (void)in_replay;
    return 0;
}

KN_KEEPALIVE uint32_t kn_hash_stocks(uint8_t player_idx, int32_t frame) {
    (void)player_idx;
    (void)frame;
    return 0;
}
KN_KEEPALIVE size_t kn_hash_history_stocks(uint8_t player_idx, uint32_t count, uint32_t* out_pairs) {
    (void)player_idx;
    (void)count;
    (void)out_pairs;
    return 0;
}
KN_KEEPALIVE uint32_t kn_hash_character_id(uint8_t player_idx, int32_t frame) {
    (void)player_idx;
    (void)frame;
    return 0;
}
KN_KEEPALIVE size_t kn_hash_history_character_id(uint8_t player_idx, uint32_t count, uint32_t* out_pairs) {
    (void)player_idx;
    (void)count;
    (void)out_pairs;
    return 0;
}
KN_KEEPALIVE uint32_t kn_hash_css_cursor(uint8_t player_idx, int32_t frame) {
    (void)player_idx;
    (void)frame;
    return 0;
}
KN_KEEPALIVE size_t kn_hash_history_css_cursor(uint8_t player_idx, uint32_t count, uint32_t* out_pairs) {
    (void)player_idx;
    (void)count;
    (void)out_pairs;
    return 0;
}
KN_KEEPALIVE uint32_t kn_hash_css_selected(uint8_t player_idx, int32_t frame) {
    (void)player_idx;
    (void)frame;
    return 0;
}
KN_KEEPALIVE size_t kn_hash_history_css_selected(uint8_t player_idx, uint32_t count, uint32_t* out_pairs) {
    (void)player_idx;
    (void)count;
    (void)out_pairs;
    return 0;
}
KN_KEEPALIVE uint32_t kn_hash_rng(int32_t frame) {
    (void)frame;
    return 0;
}
KN_KEEPALIVE size_t kn_hash_history_rng(uint32_t count, uint32_t* out_pairs) {
    (void)count;
    (void)out_pairs;
    return 0;
}
KN_KEEPALIVE uint32_t kn_hash_match_phase(int32_t frame) {
    (void)frame;
    return 0;
}
KN_KEEPALIVE size_t kn_hash_history_match_phase(uint32_t count, uint32_t* out_pairs) {
    (void)count;
    (void)out_pairs;
    return 0;
}
KN_KEEPALIVE uint32_t kn_hash_vs_battle_hdr(int32_t frame) {
    (void)frame;
    return 0;
}
KN_KEEPALIVE size_t kn_hash_history_vs_battle_hdr(uint32_t count, uint32_t* out_pairs) {
    (void)count;
    (void)out_pairs;
    return 0;
}
KN_KEEPALIVE uint32_t kn_hash_physics_motion(int32_t frame) {
    (void)frame;
    return 0;
}
KN_KEEPALIVE size_t kn_hash_history_physics_motion(uint32_t count, uint32_t* out_pairs) {
    (void)count;
    (void)out_pairs;
    return 0;
}
KN_KEEPALIVE uint32_t kn_hash_ft_buffer(int32_t frame) {
    (void)frame;
    return 0;
}
KN_KEEPALIVE size_t kn_hash_history_ft_buffer(uint32_t count, uint32_t* out_pairs) {
    (void)count;
    (void)out_pairs;
    return 0;
}
KN_KEEPALIVE uint32_t kn_smoke_buf_ptr(void) { return 0; }
KN_KEEPALIVE size_t kn_smoke_dump_stocks(uint8_t player_idx, uint32_t count) {
    (void)player_idx;
    (void)count;
    return 0;
}
KN_KEEPALIVE void kn_hash_on_replay_enter(int32_t target_frame) { (void)target_frame; }
KN_KEEPALIVE void kn_hash_on_replay_exit(int32_t final_frame) { (void)final_frame; }
KN_KEEPALIVE uint32_t kn_get_pre_replay_hash(kn_field_id_t field) {
    (void)field;
    return 0;
}
KN_KEEPALIVE uint32_t kn_get_post_replay_hash(kn_field_id_t field) {
    (void)field;
    return 0;
}
KN_KEEPALIVE int32_t kn_get_last_replay_target_frame(void) { return -1; }
KN_KEEPALIVE int32_t kn_get_last_replay_final_frame(void) { return -1; }
KN_KEEPALIVE uint32_t kn_get_replay_frame_hash(kn_field_id_t field, uint32_t replay_offset) {
    (void)field;
    (void)replay_offset;
    return 0;
}
KN_KEEPALIVE uint32_t kn_get_last_replay_length(void) { return 0; }
KN_KEEPALIVE uint8_t kn_get_scene_curr(void) { return 0; }

#else

/* RDRAM base pointer is owned by mupen64plus-core; expose accessor.
 * Signatures match the actual definitions in
 *   build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/main.c:329-330
 * (injected via build/patches/mupen64plus-kn-all.patch:151-152). DO NOT
 * change the return types — type-mismatched externs across translation
 * units are UB and may produce silent zero-hashes on some platforms. */
extern void*    kn_get_rdram_ptr(void);
extern uint32_t kn_get_rdram_size(void);

/* ── FNV-1a 32-bit ───────────────────────────────────────────────────
 * Standard FNV-1a, prime 0x01000193, offset 0x811c9dc5. Same algorithm
 * already used elsewhere in this repo (kn_rollback.c gameplay hash) —
 * kept identical for byte-equal cross-peer verdict. */
KN_KEEPALIVE
uint32_t kn_hash_fnv1a(const uint8_t* data, size_t len) {
    uint32_t h = 0x811c9dc5u;
    for (size_t i = 0; i < len; i++) {
        h ^= (uint32_t)data[i];
        h *= 0x01000193u;
    }
    return h;
}

/* ── Hash a slice of RDRAM safely ────────────────────────────────────
 * Returns 0 if RDRAM not available or the slice extends past RDRAM size.
 * 0 is reserved as "no data" — real hashes happen to also collide with
 * 0 once in 4B but the detector treats 0 as "skip" rather than a value. */
static uint32_t hash_rdram_slice(uint32_t offset, uint32_t len) {
    uint8_t* base = (uint8_t*)kn_get_rdram_ptr();
    uint32_t sz   = kn_get_rdram_size();
    if (!base || offset + len > sz) return 0;
    return kn_hash_fnv1a(base + offset, len);
}

/* ── History rings ───────────────────────────────────────────────────
 * Each field gets a 600-entry ring of (frame, hash) pairs. Newest entry
 * lives at ring_head[field]; ring is circular. Initial state: all zeros.
 *
 * RAM cost: 600 × 8 bytes × ~12 fields × ~4 players-where-applicable ≈
 * a few hundred KB total. Acceptable.
 */
#define KN_RING_SIZE 600

typedef struct {
    int32_t  frame;   /* -1 = empty slot */
    uint32_t hash;
} kn_ring_entry_t;

/* Ring storage and head pointers added per-field in subsequent tasks. */

static uint32_t ring_find_frame(const kn_ring_entry_t* ring, uint32_t head, int32_t frame) {
    for (uint32_t i = 0; i < KN_RING_SIZE; i++) {
        uint32_t idx = (head + KN_RING_SIZE - 1 - i) % KN_RING_SIZE;
        const kn_ring_entry_t* e = &ring[idx];
        if (e->frame == frame) return e->hash;
    }
    return 0;
}

/* ── kn_hash_stocks ──────────────────────────────────────────────────
 * See header for citation block. */
static kn_ring_entry_t s_ring_stocks[4][KN_RING_SIZE];
static uint32_t        s_head_stocks[4];

KN_KEEPALIVE
uint32_t kn_hash_stocks(uint8_t player_idx, int32_t frame) {
    if (player_idx >= 4) return 0;
    if (frame >= 0) {
        return ring_find_frame(s_ring_stocks[player_idx], s_head_stocks[player_idx], frame);
    }
    /* Live read. */
    uint32_t off = KN_ADDR_PLAYER_STOCKS_BASE + (uint32_t)player_idx * KN_PLAYER_STRIDE;
    return hash_rdram_slice(off, 1);
}

KN_KEEPALIVE
size_t kn_hash_history_stocks(uint8_t player_idx, uint32_t count, uint32_t* out_pairs) {
    if (player_idx >= 4 || !out_pairs) return 0;
    uint32_t n = count > KN_RING_SIZE ? KN_RING_SIZE : count;
    /* Walk backwards from head, most-recent-first. */
    for (uint32_t i = 0; i < n; i++) {
        uint32_t idx = (s_head_stocks[player_idx] + KN_RING_SIZE - 1 - i) % KN_RING_SIZE;
        const kn_ring_entry_t* e = &s_ring_stocks[player_idx][idx];
        out_pairs[i*2 + 0] = (uint32_t)e->frame;
        out_pairs[i*2 + 1] = e->hash;
    }
    return n;
}

/* Append-to-ring helper: called from kn_hash_registry_post_tick. */
static void ring_append_stocks(int32_t frame) {
    for (uint8_t p = 0; p < 4; p++) {
        uint32_t off = KN_ADDR_PLAYER_STOCKS_BASE + (uint32_t)p * KN_PLAYER_STRIDE;
        uint32_t h = hash_rdram_slice(off, 1);
        s_ring_stocks[p][s_head_stocks[p]] = (kn_ring_entry_t){ .frame = frame, .hash = h };
        s_head_stocks[p] = (s_head_stocks[p] + 1) % KN_RING_SIZE;
    }
}

/* ── kn_hash_character_id ────────────────────────────────────────────
 * See header for citation block. */
static kn_ring_entry_t s_ring_character_id[4][KN_RING_SIZE];
static uint32_t        s_head_character_id[4];

KN_KEEPALIVE
uint32_t kn_hash_character_id(uint8_t player_idx, int32_t frame) {
    if (player_idx >= 4) return 0;
    if (frame >= 0) {
        return ring_find_frame(s_ring_character_id[player_idx], s_head_character_id[player_idx], frame);
    }
    uint32_t off = KN_ADDR_P1_CSS_BASE + (uint32_t)player_idx * KN_CSS_STRIDE + KN_CSS_OFF_CHAR_ID;
    return hash_rdram_slice(off, 4);
}

KN_KEEPALIVE
size_t kn_hash_history_character_id(uint8_t player_idx, uint32_t count, uint32_t* out_pairs) {
    if (player_idx >= 4 || !out_pairs) return 0;
    uint32_t n = count > KN_RING_SIZE ? KN_RING_SIZE : count;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t idx = (s_head_character_id[player_idx] + KN_RING_SIZE - 1 - i) % KN_RING_SIZE;
        const kn_ring_entry_t* e = &s_ring_character_id[player_idx][idx];
        out_pairs[i*2 + 0] = (uint32_t)e->frame;
        out_pairs[i*2 + 1] = e->hash;
    }
    return n;
}

static void ring_append_character_id(int32_t frame) {
    for (uint8_t p = 0; p < 4; p++) {
        uint32_t off = KN_ADDR_P1_CSS_BASE + (uint32_t)p * KN_CSS_STRIDE + KN_CSS_OFF_CHAR_ID;
        uint32_t h = hash_rdram_slice(off, 4);
        s_ring_character_id[p][s_head_character_id[p]] = (kn_ring_entry_t){ .frame = frame, .hash = h };
        s_head_character_id[p] = (s_head_character_id[p] + 1) % KN_RING_SIZE;
    }
}

/* ── kn_hash_css_cursor ──────────────────────────────────────────────
 * See header for citation block. */
static kn_ring_entry_t s_ring_css_cursor[4][KN_RING_SIZE];
static uint32_t        s_head_css_cursor[4];

KN_KEEPALIVE
uint32_t kn_hash_css_cursor(uint8_t player_idx, int32_t frame) {
    if (player_idx >= 4) return 0;
    if (frame >= 0) {
        return ring_find_frame(s_ring_css_cursor[player_idx], s_head_css_cursor[player_idx], frame);
    }
    uint32_t off = KN_ADDR_P1_CSS_BASE + (uint32_t)player_idx * KN_CSS_STRIDE + KN_CSS_OFF_CURSOR_STATE;
    return hash_rdram_slice(off, 4);
}

KN_KEEPALIVE
size_t kn_hash_history_css_cursor(uint8_t player_idx, uint32_t count, uint32_t* out_pairs) {
    if (player_idx >= 4 || !out_pairs) return 0;
    uint32_t n = count > KN_RING_SIZE ? KN_RING_SIZE : count;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t idx = (s_head_css_cursor[player_idx] + KN_RING_SIZE - 1 - i) % KN_RING_SIZE;
        const kn_ring_entry_t* e = &s_ring_css_cursor[player_idx][idx];
        out_pairs[i*2 + 0] = (uint32_t)e->frame;
        out_pairs[i*2 + 1] = e->hash;
    }
    return n;
}

static void ring_append_css_cursor(int32_t frame) {
    for (uint8_t p = 0; p < 4; p++) {
        uint32_t off = KN_ADDR_P1_CSS_BASE + (uint32_t)p * KN_CSS_STRIDE + KN_CSS_OFF_CURSOR_STATE;
        uint32_t h = hash_rdram_slice(off, 4);
        s_ring_css_cursor[p][s_head_css_cursor[p]] = (kn_ring_entry_t){ .frame = frame, .hash = h };
        s_head_css_cursor[p] = (s_head_css_cursor[p] + 1) % KN_RING_SIZE;
    }
}

/* ── kn_hash_css_selected ────────────────────────────────────────────
 * See header for citation block. */
static kn_ring_entry_t s_ring_css_selected[4][KN_RING_SIZE];
static uint32_t        s_head_css_selected[4];

KN_KEEPALIVE
uint32_t kn_hash_css_selected(uint8_t player_idx, int32_t frame) {
    if (player_idx >= 4) return 0;
    if (frame >= 0) {
        return ring_find_frame(s_ring_css_selected[player_idx], s_head_css_selected[player_idx], frame);
    }
    uint32_t off = KN_ADDR_P1_CSS_BASE + (uint32_t)player_idx * KN_CSS_STRIDE + KN_CSS_OFF_SELECTED_FLAG;
    return hash_rdram_slice(off, 4);
}

KN_KEEPALIVE
size_t kn_hash_history_css_selected(uint8_t player_idx, uint32_t count, uint32_t* out_pairs) {
    if (player_idx >= 4 || !out_pairs) return 0;
    uint32_t n = count > KN_RING_SIZE ? KN_RING_SIZE : count;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t idx = (s_head_css_selected[player_idx] + KN_RING_SIZE - 1 - i) % KN_RING_SIZE;
        const kn_ring_entry_t* e = &s_ring_css_selected[player_idx][idx];
        out_pairs[i*2 + 0] = (uint32_t)e->frame;
        out_pairs[i*2 + 1] = e->hash;
    }
    return n;
}

static void ring_append_css_selected(int32_t frame) {
    for (uint8_t p = 0; p < 4; p++) {
        uint32_t off = KN_ADDR_P1_CSS_BASE + (uint32_t)p * KN_CSS_STRIDE + KN_CSS_OFF_SELECTED_FLAG;
        uint32_t h = hash_rdram_slice(off, 4);
        s_ring_css_selected[p][s_head_css_selected[p]] = (kn_ring_entry_t){ .frame = frame, .hash = h };
        s_head_css_selected[p] = (s_head_css_selected[p] + 1) % KN_RING_SIZE;
    }
}

/* ── kn_hash_rng ─────────────────────────────────────────────────────
 * See header for citation block. */
static kn_ring_entry_t s_ring_rng[KN_RING_SIZE];
static uint32_t        s_head_rng;

KN_KEEPALIVE
uint32_t kn_hash_rng(int32_t frame) {
    if (frame >= 0) {
        return ring_find_frame(s_ring_rng, s_head_rng, frame);
    }
    return hash_rdram_slice(KN_ADDR_SY_UTILS_RANDOM_SEED, 4);
}

KN_KEEPALIVE
size_t kn_hash_history_rng(uint32_t count, uint32_t* out_pairs) {
    if (!out_pairs) return 0;
    uint32_t n = count > KN_RING_SIZE ? KN_RING_SIZE : count;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t idx = (s_head_rng + KN_RING_SIZE - 1 - i) % KN_RING_SIZE;
        const kn_ring_entry_t* e = &s_ring_rng[idx];
        out_pairs[i*2 + 0] = (uint32_t)e->frame;
        out_pairs[i*2 + 1] = e->hash;
    }
    return n;
}

static void ring_append_rng(int32_t frame) {
    uint32_t h = hash_rdram_slice(KN_ADDR_SY_UTILS_RANDOM_SEED, 4);
    s_ring_rng[s_head_rng] = (kn_ring_entry_t){ .frame = frame, .hash = h };
    s_head_rng = (s_head_rng + 1) % KN_RING_SIZE;
}

/* ── kn_hash_match_phase ─────────────────────────────────────────────
 * See header for citation block. */
static kn_ring_entry_t s_ring_match_phase[KN_RING_SIZE];
static uint32_t        s_head_match_phase;

KN_KEEPALIVE
uint32_t kn_hash_match_phase(int32_t frame) {
    if (frame >= 0) {
        return ring_find_frame(s_ring_match_phase, s_head_match_phase, frame);
    }
    return hash_rdram_slice(KN_ADDR_SCENE_CURR, 1);
}

KN_KEEPALIVE
size_t kn_hash_history_match_phase(uint32_t count, uint32_t* out_pairs) {
    if (!out_pairs) return 0;
    uint32_t n = count > KN_RING_SIZE ? KN_RING_SIZE : count;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t idx = (s_head_match_phase + KN_RING_SIZE - 1 - i) % KN_RING_SIZE;
        const kn_ring_entry_t* e = &s_ring_match_phase[idx];
        out_pairs[i*2 + 0] = (uint32_t)e->frame;
        out_pairs[i*2 + 1] = e->hash;
    }
    return n;
}

static void ring_append_match_phase(int32_t frame) {
    uint32_t h = hash_rdram_slice(KN_ADDR_SCENE_CURR, 1);
    s_ring_match_phase[s_head_match_phase] = (kn_ring_entry_t){ .frame = frame, .hash = h };
    s_head_match_phase = (s_head_match_phase + 1) % KN_RING_SIZE;
}

/* ── kn_hash_vs_battle_hdr ───────────────────────────────────────────
 * See header for citation block. */
static kn_ring_entry_t s_ring_vs_battle_hdr[KN_RING_SIZE];
static uint32_t        s_head_vs_battle_hdr;

KN_KEEPALIVE
uint32_t kn_hash_vs_battle_hdr(int32_t frame) {
    if (frame >= 0) {
        return ring_find_frame(s_ring_vs_battle_hdr, s_head_vs_battle_hdr, frame);
    }
    return hash_rdram_slice(KN_ADDR_VS_BATTLE_HEADER, KN_SIZE_VS_BATTLE_HEADER);
}

KN_KEEPALIVE
size_t kn_hash_history_vs_battle_hdr(uint32_t count, uint32_t* out_pairs) {
    if (!out_pairs) return 0;
    uint32_t n = count > KN_RING_SIZE ? KN_RING_SIZE : count;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t idx = (s_head_vs_battle_hdr + KN_RING_SIZE - 1 - i) % KN_RING_SIZE;
        const kn_ring_entry_t* e = &s_ring_vs_battle_hdr[idx];
        out_pairs[i*2 + 0] = (uint32_t)e->frame;
        out_pairs[i*2 + 1] = e->hash;
    }
    return n;
}

static void ring_append_vs_battle_hdr(int32_t frame) {
    uint32_t h = hash_rdram_slice(KN_ADDR_VS_BATTLE_HEADER, KN_SIZE_VS_BATTLE_HEADER);
    s_ring_vs_battle_hdr[s_head_vs_battle_hdr] = (kn_ring_entry_t){ .frame = frame, .hash = h };
    s_head_vs_battle_hdr = (s_head_vs_battle_hdr + 1) % KN_RING_SIZE;
}

/* ── kn_hash_physics_motion ──────────────────────────────────────────
 * See header for citation block. */
static kn_ring_entry_t s_ring_physics_motion[KN_RING_SIZE];
static uint32_t        s_head_physics_motion;

KN_KEEPALIVE
uint32_t kn_hash_physics_motion(int32_t frame) {
    if (frame >= 0) {
        return ring_find_frame(s_ring_physics_motion, s_head_physics_motion, frame);
    }
    return hash_rdram_slice(KN_ADDR_FT_MOTION_COUNT, 4);
}

KN_KEEPALIVE
size_t kn_hash_history_physics_motion(uint32_t count, uint32_t* out_pairs) {
    if (!out_pairs) return 0;
    uint32_t n = count > KN_RING_SIZE ? KN_RING_SIZE : count;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t idx = (s_head_physics_motion + KN_RING_SIZE - 1 - i) % KN_RING_SIZE;
        const kn_ring_entry_t* e = &s_ring_physics_motion[idx];
        out_pairs[i*2 + 0] = (uint32_t)e->frame;
        out_pairs[i*2 + 1] = e->hash;
    }
    return n;
}

static void ring_append_physics_motion(int32_t frame) {
    uint32_t h = hash_rdram_slice(KN_ADDR_FT_MOTION_COUNT, 4);
    s_ring_physics_motion[s_head_physics_motion] = (kn_ring_entry_t){ .frame = frame, .hash = h };
    s_head_physics_motion = (s_head_physics_motion + 1) % KN_RING_SIZE;
}

/* ── kn_hash_ft_buffer ──────────────────────────────────────────────
 * See header for citation block. */
static kn_ring_entry_t s_ring_ft_buffer[KN_RING_SIZE];
static uint32_t        s_head_ft_buffer;

/* Read sFTManagerStructsAllocBuf via pointer indirection at 0x130D84
 * and hash KN_FT_BUFFER_SIZE bytes from there. Returns 0 if the
 * pointer is null or the dereferenced range exceeds RDRAM. */
static uint32_t hash_ft_buffer_live(void) {
    uint8_t* base = (uint8_t*)kn_get_rdram_ptr();
    if (!base) return 0;
    uint32_t buf_ptr_n64 = 0;
    for (int b = 0; b < 4; b++) {
        buf_ptr_n64 |= ((uint32_t)base[0x130D84 + b]) << (b * 8);
    }
    if (buf_ptr_n64 == 0) return 0;
    uint32_t rdram_off = buf_ptr_n64 & 0x00FFFFFF;
    uint32_t sz = kn_get_rdram_size();
    if (rdram_off + KN_FT_BUFFER_SIZE > sz) return 0;
    return kn_hash_fnv1a(base + rdram_off, KN_FT_BUFFER_SIZE);
}

KN_KEEPALIVE
uint32_t kn_hash_ft_buffer(int32_t frame) {
    if (frame >= 0) {
        return ring_find_frame(s_ring_ft_buffer, s_head_ft_buffer, frame);
    }
    return hash_ft_buffer_live();
}

KN_KEEPALIVE
size_t kn_hash_history_ft_buffer(uint32_t count, uint32_t* out_pairs) {
    if (!out_pairs) return 0;
    uint32_t n = count > KN_RING_SIZE ? KN_RING_SIZE : count;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t idx = (s_head_ft_buffer + KN_RING_SIZE - 1 - i) % KN_RING_SIZE;
        const kn_ring_entry_t* e = &s_ring_ft_buffer[idx];
        out_pairs[i*2 + 0] = (uint32_t)e->frame;
        out_pairs[i*2 + 1] = e->hash;
    }
    return n;
}

static void ring_append_ft_buffer(int32_t frame) {
    uint32_t h = hash_ft_buffer_live();
    s_ring_ft_buffer[s_head_ft_buffer] = (kn_ring_entry_t){ .frame = frame, .hash = h };
    s_head_ft_buffer = (s_head_ft_buffer + 1) % KN_RING_SIZE;
}

/* ── Replay trajectory storage ───────────────────────────────────── */
static uint32_t s_replay_ring[KN_FIELD_COUNT][KN_MAX_REPLAY_FRAMES];
static uint32_t s_replay_length = 0;
/* (s_in_replay flag was conceptual in plan but not actually used —
 * in_replay flag is passed through the post-tick signature instead.) */

/* Forward declaration: snapshot_all_fields is defined below alongside
 * the rollback-event snapshot helpers (Task 8). post_tick uses it for
 * the replay trajectory ring writes. */
static void snapshot_all_fields(uint32_t* out);

/* Internal post-tick hook. */
KN_KEEPALIVE
int kn_hash_registry_post_tick(int32_t frame, int in_replay) {
    if (in_replay && s_replay_length < KN_MAX_REPLAY_FRAMES) {
        uint32_t snap[KN_FIELD_COUNT];
        snapshot_all_fields(snap);
        for (int f = 0; f < KN_FIELD_COUNT; f++) {
            s_replay_ring[f][s_replay_length] = snap[f];
        }
        s_replay_length++;
    } else if (!in_replay) {
        /* Forward-pass write: append to the per-field history rings as before. */
        ring_append_stocks(frame);
        ring_append_character_id(frame);
        ring_append_css_cursor(frame);
        ring_append_css_selected(frame);
        ring_append_rng(frame);
        ring_append_match_phase(frame);
        ring_append_vs_battle_hdr(frame);
        ring_append_physics_motion(frame);
        ring_append_ft_buffer(frame);
    }
    return 0;
}

KN_KEEPALIVE
uint32_t kn_get_replay_frame_hash(kn_field_id_t field, uint32_t replay_offset) {
    if (field < 0 || field >= KN_FIELD_COUNT) return 0;
    if (replay_offset >= KN_MAX_REPLAY_FRAMES) return 0;
    if (replay_offset >= s_replay_length) return 0;
    return s_replay_ring[field][replay_offset];
}

KN_KEEPALIVE
uint32_t kn_get_last_replay_length(void) { return s_replay_length; }

/* ── Smoke-test scratch buffer ────────────────────────────────────
 * Static buffer JS reads via HEAPU32 to avoid the Module._malloc
 * dependency. Diagnostic only — chunk 2's JS detector uses the
 * real kn_hash_history_<field> exports through a heap region. */
static uint32_t s_smoke_buf[2 * KN_RING_SIZE];

KN_KEEPALIVE
uint32_t kn_smoke_buf_ptr(void) { return (uint32_t)(uintptr_t)s_smoke_buf; }

KN_KEEPALIVE
size_t kn_smoke_dump_stocks(uint8_t player_idx, uint32_t count) {
    return kn_hash_history_stocks(player_idx, count, s_smoke_buf);
}

/* ── Rollback-event snapshot state ───────────────────────────────── */
static uint32_t s_pre_replay[KN_FIELD_COUNT];
static uint32_t s_post_replay[KN_FIELD_COUNT];
static int32_t  s_last_replay_target = -1;
static int32_t  s_last_replay_final  = -1;

/* Sample every field into a uint32 array. Centralized so enter/exit
 * snapshot the same field set the per-frame post_tick uses. */
static void snapshot_all_fields(uint32_t* out) {
    for (uint8_t p = 0; p < 4; p++) {
        uint32_t off_stocks = KN_ADDR_PLAYER_STOCKS_BASE + (uint32_t)p * KN_PLAYER_STRIDE;
        out[KN_FIELD_STOCKS_P0 + p]        = hash_rdram_slice(off_stocks, 1);
        uint32_t css_base = KN_ADDR_P1_CSS_BASE + (uint32_t)p * KN_CSS_STRIDE;
        out[KN_FIELD_CHARACTER_ID_P0 + p]  = hash_rdram_slice(css_base + KN_CSS_OFF_CHAR_ID, 4);
        out[KN_FIELD_CSS_CURSOR_P0 + p]    = hash_rdram_slice(css_base + KN_CSS_OFF_CURSOR_STATE, 4);
        out[KN_FIELD_CSS_SELECTED_P0 + p]  = hash_rdram_slice(css_base + KN_CSS_OFF_SELECTED_FLAG, 4);
    }
    out[KN_FIELD_RNG]             = hash_rdram_slice(KN_ADDR_SY_UTILS_RANDOM_SEED, 4);
    out[KN_FIELD_MATCH_PHASE]     = hash_rdram_slice(KN_ADDR_SCENE_CURR, 1);
    out[KN_FIELD_VS_BATTLE_HDR]   = hash_rdram_slice(KN_ADDR_VS_BATTLE_HEADER, KN_SIZE_VS_BATTLE_HEADER);
    out[KN_FIELD_PHYSICS_MOTION]  = hash_rdram_slice(KN_ADDR_FT_MOTION_COUNT, 4);
    out[KN_FIELD_FT_BUFFER]       = hash_ft_buffer_live();
}

KN_KEEPALIVE
void kn_hash_on_replay_enter(int32_t target_frame) {
    snapshot_all_fields(s_pre_replay);
    s_last_replay_target = target_frame;
    /* Clear post snapshot so callers don't see stale data mid-replay. */
    for (int i = 0; i < KN_FIELD_COUNT; i++) s_post_replay[i] = 0;
    s_last_replay_final = -1;
    s_replay_length = 0;
}

KN_KEEPALIVE
void kn_hash_on_replay_exit(int32_t final_frame) {
    snapshot_all_fields(s_post_replay);
    s_last_replay_final = final_frame;
}

KN_KEEPALIVE
uint32_t kn_get_pre_replay_hash(kn_field_id_t field) {
    if (field < 0 || field >= KN_FIELD_COUNT) return 0;
    return s_pre_replay[field];
}

KN_KEEPALIVE
uint32_t kn_get_post_replay_hash(kn_field_id_t field) {
    if (field < 0 || field >= KN_FIELD_COUNT) return 0;
    return s_post_replay[field];
}

KN_KEEPALIVE int32_t kn_get_last_replay_target_frame(void) { return s_last_replay_target; }
KN_KEEPALIVE int32_t kn_get_last_replay_final_frame(void)  { return s_last_replay_final; }

KN_KEEPALIVE
uint8_t kn_get_scene_curr(void) {
    uint8_t* base = (uint8_t*)kn_get_rdram_ptr();
    if (!base || KN_ADDR_SCENE_CURR + 1 > kn_get_rdram_size()) return 0;
    return base[KN_ADDR_SCENE_CURR];
}

#endif
