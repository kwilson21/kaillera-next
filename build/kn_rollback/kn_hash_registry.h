/* kn_hash_registry.h — field-granular hash exports for desync detection.
 *
 * EVERY public kn_hash_<field> declaration in this header MUST have a
 * matching block comment containing:
 *   1. "Source:"  — the decomp struct/field reference
 *   2. "decomp:"  — file:line citing the decomp source
 *   3. "Address:" — the RDRAM offset expression
 *   4. "Sampling:" — when the hash is taken (always kn_post_tick for v1)
 *
 * scripts/check-hash-citations.sh enforces this in CI. PRs without the
 * block fail the build. Spec: docs/superpowers/specs/2026-04-25-desync-detection-design.md
 */
#ifndef KN_HASH_REGISTRY_H
#define KN_HASH_REGISTRY_H

#include <stdint.h>
#include <stddef.h>

/* All hashes are FNV-1a 32-bit over the raw byte slice at the field's
 * RDRAM address. SoftFloat means byte-equal is the right cross-peer test.
 * Returns 0 if not initialized or RDRAM not available. */
uint32_t kn_hash_fnv1a(const uint8_t* data, size_t len);

/* sFTManagerStructsAllocBuf hash window. FTStruct is ~256-512 bytes;
 * 4 fighters * worst-case ~1KB each + slop = 4096 bytes. Conservative
 * envelope, well below RDRAM size. */
#define KN_FT_BUFFER_SIZE 4096

/* Per-field exports declared in Tasks 3+ on top of this skeleton.
 * Each entry MUST carry the citation block above its declaration. */

/* Internal: invoked from kn_post_tick to refresh all field hashes and
 * append to history rings. Returns 0 on success. No-op until Tasks 3-5
 * add field-specific append helpers.
 *
 * `in_replay` flags whether this tick is running inside a replay window
 * (rb.replay_remaining > 0). Forward-pass writes route into the per-field
 * history rings; replay-pass writes route into the trajectory ring (see
 * kn_get_replay_frame_hash below). */
int kn_hash_registry_post_tick(int32_t frame, int in_replay);

/* kn_hash_stocks
 * Source:  SCManagerVSBattleState.players[player_idx].stock_count
 * decomp:  lib/ssb-decomp-re/include/sc/sctypes.h:218 (SCPlayerData.stock_count @ +0xB)
 *          lib/ssb-decomp-re/include/sc/sctypes.h:301 (SCManagerVSBattleState.players @ +0x20)
 * Address: KN_ADDR_PLAYER_STOCKS_BASE + player_idx * KN_PLAYER_STRIDE  (1 byte)
 * Sampling: kn_post_tick (post-physics, pre-render)
 *
 * Returns FNV-1a of the single byte. Returns 0 if RDRAM unavailable
 * or player_idx >= 4. Frame param informational; pass -1 for live read.
 */
uint32_t kn_hash_stocks(uint8_t player_idx, int32_t frame);

size_t kn_hash_history_stocks(uint8_t player_idx, uint32_t count, uint32_t* out_pairs);

/* kn_hash_character_id
 * Source:  CSS_PLAYER_STRUCT.char_id (per player CSS character pick)
 * decomp:  build/kn_rollback/kn_rollback.c gameplay_addrs comments
 *          (CSS char_id at +0x48 within per-player CSS struct, 0xBC stride)
 * Address: KN_ADDR_P1_CSS_BASE + player_idx*KN_CSS_STRIDE + KN_CSS_OFF_CHAR_ID
 * Sampling: kn_post_tick (post-physics, pre-render)
 */
uint32_t kn_hash_character_id(uint8_t player_idx, int32_t frame);
size_t kn_hash_history_character_id(uint8_t player_idx, uint32_t count, uint32_t* out_pairs);

/* kn_hash_css_cursor
 * Source:  CSS_PLAYER_STRUCT.cursor_state (CSS cursor position/state)
 * decomp:  build/kn_rollback/kn_rollback.c gameplay_addrs CSS section
 *          (offset +0x54 within per-player CSS struct, 0xBC stride)
 * Address: KN_ADDR_P1_CSS_BASE + player_idx*KN_CSS_STRIDE + KN_CSS_OFF_CURSOR_STATE
 * Sampling: kn_post_tick (post-physics, pre-render)
 */
uint32_t kn_hash_css_cursor(uint8_t player_idx, int32_t frame);
size_t kn_hash_history_css_cursor(uint8_t player_idx, uint32_t count, uint32_t* out_pairs);

/* kn_hash_css_selected
 * Source:  CSS_PLAYER_STRUCT.selected_flag (CSS character lock-in state)
 * decomp:  build/kn_rollback/kn_rollback.c gameplay_addrs CSS section
 *          (offset +0x58 within per-player CSS struct, 0xBC stride)
 * Address: KN_ADDR_P1_CSS_BASE + player_idx*KN_CSS_STRIDE + KN_CSS_OFF_SELECTED_FLAG
 * Sampling: kn_post_tick (post-physics, pre-render)
 */
uint32_t kn_hash_css_selected(uint8_t player_idx, int32_t frame);
size_t kn_hash_history_css_selected(uint8_t player_idx, uint32_t count, uint32_t* out_pairs);

/* kn_hash_rng
 * Source:  sSYUtilsRandomSeed (primary game LCG seed)
 * decomp:  lib/ssb-decomp-re/src/sys/utils.c:13
 * Address: KN_ADDR_SY_UTILS_RANDOM_SEED  (4 bytes)
 * Sampling: kn_post_tick (post-physics, pre-render)
 */
uint32_t kn_hash_rng(int32_t frame);
size_t kn_hash_history_rng(uint32_t count, uint32_t* out_pairs);

/* kn_hash_match_phase
 * Source:  gSCManagerSceneData.scene_curr (current scene/phase byte)
 * decomp:  lib/ssb-decomp-re/src/sc/scmanager.c (SCManagerSceneData)
 * Address: KN_ADDR_SCENE_CURR  (1 byte)
 * Sampling: kn_post_tick (post-physics, pre-render)
 */
uint32_t kn_hash_match_phase(int32_t frame);
size_t kn_hash_history_match_phase(uint32_t count, uint32_t* out_pairs);

/* kn_hash_vs_battle_hdr
 * Source:  gSCManagerVSBattleState header (32 bytes — game_type, gkind,
 *          is_team_battle, game_rules, pl_count, cp_count, time_limit,
 *          stocks, handicap, is_team_attack, is_stage_select,
 *          damage_ratio, item_toggles, is_reset_players, game_status,
 *          time_remain, time_passed, item_appearance_rate)
 * decomp:  lib/ssb-decomp-re/include/sc/sctypes.h (SCManagerVSBattleState)
 * Address: KN_ADDR_VS_BATTLE_HEADER  (KN_SIZE_VS_BATTLE_HEADER bytes)
 * Sampling: kn_post_tick (post-physics, pre-render)
 */
uint32_t kn_hash_vs_battle_hdr(int32_t frame);
size_t kn_hash_history_vs_battle_hdr(uint32_t count, uint32_t* out_pairs);

/* kn_hash_physics_motion
 * Source:  gFTManagerMotionCount (u16) + gFTManagerStatUpdateCount (u16)
 *          packed at 0x130D94 — increment on every fighter motion/stat
 *          event. Cross-JIT desyncs hit this counter first per memory
 *          project_cross_jit_hunt_apr24.
 * decomp:  lib/ssb-decomp-re/src/ft/ftmanager.c (gFTManagerMotionCount)
 * Address: KN_ADDR_FT_MOTION_COUNT  (4 bytes)
 * Sampling: kn_post_tick (post-physics, pre-render)
 *
 * NOTE: This is the v1 substitute for per-player physics fields
 * (damage/position/velocity/action_state) deferred to v2 because
 * SSB64 fighters are pooled GObjs with no fixed RDRAM address.
 * Cross-peer divergence in motion_count implies cross-peer
 * divergence in fighter physics; vision then extracts per-player
 * details from screenshots when this flags.
 */
uint32_t kn_hash_physics_motion(int32_t frame);
size_t kn_hash_history_physics_motion(uint32_t count, uint32_t* out_pairs);

/* kn_hash_ft_buffer
 * Source:  sFTManagerStructsAllocBuf — array of all live FTStructs covering
 *          per-fighter state (damage at +0x2C, status_id at +0x24, physics
 *          substruct, stock_count at +0x14). Pointer to the buffer lives at
 *          RDRAM 0x130D84 (sFTManagerStructsAllocBuf is an N64 virt addr;
 *          mask & 0x00FFFFFF for RDRAM offset). Hash covers KN_FT_BUFFER_SIZE
 *          bytes (4 fighters worth) — divergence here flags any per-fighter
 *          physics/damage/action-state desync that physics_motion's 4-byte
 *          counter misses.
 * decomp:  lib/ssb-decomp-re/src/ft/fttypes.h:976 (FTStruct definition)
 *          lib/ssb-decomp-re/src/ft/ftmanager.c:144 (allocation site)
 * Address: deref(LE32(rdram + 0x130D84)) & 0x00FFFFFF, KN_FT_BUFFER_SIZE bytes
 * Sampling: kn_post_tick (post-physics, pre-render)
 *
 * NOTE: This is a v1 substitute for true per-player physics fields
 * (damage/position/velocity/action_state per slot), which require GObj-tree
 * walking to map fighter→slot. ft_buffer covers all 4 fighters' state in one
 * hash without per-slot precision; vision identifies the diverging player
 * from screenshots when this flags.
 */
uint32_t kn_hash_ft_buffer(int32_t frame);
size_t kn_hash_history_ft_buffer(uint32_t count, uint32_t* out_pairs);

/* Smoke-test diagnostic helpers (not part of the regular registry API).
 * Lets browser-console smoke tests read history rings via HEAPU32 instead
 * of needing Module._malloc (which isn't currently exported). */
uint32_t kn_smoke_buf_ptr(void);
size_t kn_smoke_dump_stocks(uint8_t player_idx, uint32_t count);

/* ── Rollback-event snapshots ────────────────────────────────────────
 * Captured at the moment the rollback engine schedules a replay
 * (kn_hash_on_replay_enter) and the moment the replay completes
 * (kn_hash_on_replay_exit). Stored separately from the per-frame ring
 * so they're not overwritten by subsequent forward-pass writes.
 *
 * Read from JS via kn_get_pre_replay_hash / kn_get_post_replay_hash,
 * keyed by field_id. Field IDs are stable enums; see KN_FIELD_* below.
 */
typedef enum {
    KN_FIELD_STOCKS_P0 = 0, KN_FIELD_STOCKS_P1, KN_FIELD_STOCKS_P2, KN_FIELD_STOCKS_P3,
    KN_FIELD_CHARACTER_ID_P0, KN_FIELD_CHARACTER_ID_P1, KN_FIELD_CHARACTER_ID_P2, KN_FIELD_CHARACTER_ID_P3,
    KN_FIELD_CSS_CURSOR_P0, KN_FIELD_CSS_CURSOR_P1, KN_FIELD_CSS_CURSOR_P2, KN_FIELD_CSS_CURSOR_P3,
    KN_FIELD_CSS_SELECTED_P0, KN_FIELD_CSS_SELECTED_P1, KN_FIELD_CSS_SELECTED_P2, KN_FIELD_CSS_SELECTED_P3,
    KN_FIELD_RNG,
    KN_FIELD_MATCH_PHASE,
    KN_FIELD_VS_BATTLE_HDR,
    KN_FIELD_PHYSICS_MOTION,
    KN_FIELD_FT_BUFFER,
    KN_FIELD_COUNT
} kn_field_id_t;

/* kn_hash_on_replay_enter
 * Source:  Rollback engine event hook — called when kn_pre_tick schedules a replay
 * decomp:  N/A (engine-internal hook, not game state)
 * Address: N/A (writes to s_pre_replay snapshot, not RDRAM)
 * Sampling: kn_pre_tick (at replay-schedule time, before retro_unserialize)
 *
 * `target_frame` is the frame the engine will restore to. */
void kn_hash_on_replay_enter(int32_t target_frame);

/* kn_hash_on_replay_exit
 * Source:  Rollback engine event hook — called when replay_remaining hits 0
 * decomp:  N/A (engine-internal hook, not game state)
 * Address: N/A (writes to s_post_replay snapshot, not RDRAM)
 * Sampling: kn_post_tick (when replay_remaining transitions 1→0)
 */
void kn_hash_on_replay_exit(int32_t final_frame);

/* JS readout for the most recent replay event. Returns 0 if no replay
 * has occurred yet. Hash captured at the named boundary. */
uint32_t kn_get_pre_replay_hash(kn_field_id_t field);
uint32_t kn_get_post_replay_hash(kn_field_id_t field);

/* Returns the target/final frame numbers for the most recent replay,
 * so JS can correlate snapshots with the frame they apply to. */
int32_t kn_get_last_replay_target_frame(void);
int32_t kn_get_last_replay_final_frame(void);

/* ── Per-frame replay trajectory ring ────────────────────────────────
 * On each replay frame, the post-tick hook writes that frame's field
 * hashes into s_replay_ring keyed by replay-relative offset (0 = first
 * replayed frame, 1 = second, ...). Cleared at every replay enter.
 *
 * Max replay depth in the engine is bounded by kn_get_max_depth();
 * this ring is sized to a comfortable upper bound (KN_MAX_REPLAY_FRAMES).
 */
#define KN_MAX_REPLAY_FRAMES 64

uint32_t kn_get_replay_frame_hash(kn_field_id_t field, uint32_t replay_offset);

/* How many frames have been recorded in the most recent replay (0 if no
 * replay has happened yet, or capped at KN_MAX_REPLAY_FRAMES). */
uint32_t kn_get_last_replay_length(void);

/* Reads the live gSCManagerSceneData.scene_curr byte. Used by JS
 * detector for phase-eligibility gating. NOT a hashed field — direct
 * byte read. */
uint8_t kn_get_scene_curr(void);

#endif /* KN_HASH_REGISTRY_H */
