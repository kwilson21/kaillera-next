/* kn_gameplay_addrs.h — single source of truth for SSB64 RDRAM addresses.
 *
 * Used by:
 *   - kn_rollback.c (legacy kn_gameplay_hash, taint system)
 *   - kn_hash_registry.c (new field-granular hash exports)
 *
 * Adding addresses: cite the decomp source file:line in a comment, never
 * speculative. See cautionary notes on what happens when this rule slips.
 */
#ifndef KN_GAMEPLAY_ADDRS_H
#define KN_GAMEPLAY_ADDRS_H

#include <stdint.h>
#include <stddef.h>

typedef struct {
    uint32_t rdram_offset;
    uint32_t size;
} kn_gameplay_addr_t;

/* Named addresses for the field-granular hash registry.
 * Each is decomp-cited; see kn_hash_registry.c for the citations. */

/* Per-player stride for SCPlayerData inside SCManagerVSBattleState.players[] */
#define KN_PLAYER_STRIDE 0x74

/* Match phase / scene state */
#define KN_ADDR_SCENE_CURR              0xA4AD0   /* gSCManagerSceneData.scene_curr (1 byte) */

/* VS battle state header (32 bytes covering game_type, stocks, status, etc.) */
#define KN_ADDR_VS_BATTLE_HEADER        0xA4EF8
#define KN_SIZE_VS_BATTLE_HEADER        32

/* Per-player stocks (offset 0xB inside SCPlayerData; players[] starts at +0x20) */
#define KN_ADDR_PLAYER_STOCKS_BASE      0xA4F23   /* P1; +0x74 per player */

/* RNG */
#define KN_ADDR_SY_UTILS_RANDOM_SEED    0x03B940  /* sSYUtilsRandomSeed (4 bytes) */

/* CSS state (per-player struct, 0xBC stride) */
#define KN_ADDR_P1_CSS_BASE             0x13BA88
#define KN_CSS_STRIDE                   0xBC
/* CSS field offsets within per-player CSS struct */
#define KN_CSS_OFF_CHAR_ID              0x48
#define KN_CSS_OFF_CURSOR_STATE         0x54
#define KN_CSS_OFF_SELECTED_FLAG        0x58
#define KN_CSS_OFF_PANEL_STATE          0x84

/* Fighter manager counters (cross-JIT divergence early-warning) */
#define KN_ADDR_FT_PLAYERS_NUM          0x130D90  /* gFTManagerPlayersNum */
#define KN_ADDR_FT_MOTION_COUNT         0x130D94  /* gFTManagerMotionCount + StatUpdateCount packed */

/* Legacy table — preserved for kn_gameplay_hash backward-compat callers.
 * Do NOT extend; new fields go through the kn_hash_registry per-field exports. */
extern const kn_gameplay_addr_t kn_gameplay_addrs[];
extern const size_t kn_gameplay_addr_count;

#endif /* KN_GAMEPLAY_ADDRS_H */
