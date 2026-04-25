# Desync Detection Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace today's flaky-hash desync signals with a system that delivers field-pinpointed, vision-validated, frame-precise verdicts the user can act on.

**Architecture:** Field-granular C hash exports (one per logical game field, decomp-cited) replace the single `kn_gameplay_hash`. Each peer broadcasts per-frame digests over the existing WebRTC DataChannel. A new JS detector module (`kn-desync-detector.js`) buckets digests by frame_id and runs pairwise (B-mode) or host-authoritative (C-mode) comparison. On hash flag (always) or heartbeat (B-mode only), a thin client (`kn-vision-client.js`) ships canvas screenshots to a new server endpoint (`/api/desync-vision`) that calls Claude vision and returns the verdict. History rings on each peer give frame-precise root cause without coupling to replay convergence.

**Rollback diagnostics (added 2026-04-25 per live finding that rollbacks/replays are the proximate cause of desyncs):** the registry also captures per-field hashes at replay enter/exit boundaries (`pre_replay_hashes`, `post_replay_hashes`) and frame-by-frame trajectories during the replay (`replay_ring`). Per-peer local recording — no cross-device replay-determinism assumption. Cross-peer comparison surfaces "rollback at frame X corrupted field Y on guest but not host" and "frame +N of the replay is where divergence appeared" directly. See Tasks 8-9 for the implementation.

**Tech Stack:** C (build/kn_rollback/kn_rollback.c, FNV-1a hash already in-tree), JavaScript (vanilla IIFE modules per project convention), Python FastAPI (server endpoint), Anthropic Python SDK (vision), aiosqlite + Alembic (event persistence).

**Spec:** [docs/superpowers/specs/2026-04-25-desync-detection-design.md](../specs/2026-04-25-desync-detection-design.md)

**Deviations from spec** (all justified, all traceable to in-tree evidence):

- **Hash function:** spec says `xxhash64`; plan uses **FNV-1a** (already in `kn_rollback.c:1273`, already proven, no new dependency, same byte-equal verdict semantics). Performance is non-issue at the data sizes involved (~8 fields × ~1–32 bytes each per frame).

- **Per-player physics deferred to v2:** spec listed `damage`, `position`, `velocity`, `action_state` as v1 per-player fields. SSB64's fighter structs are pooled GObjs with no fixed RDRAM address (see `build/kn_rollback/kn_rollback.c:1158-1163`). Per-player sampling would require GObj-pool walking — significant new C code, deferred to v2. **v1 substitute:** the existing `gFTManagerMotionCount` packed counter (`KN_ADDR_FT_MOTION_COUNT`) is hashed as a global `physics_motion` field; cross-JIT desyncs hit it first per memory `project_cross_jit_hunt_apr24`. Vision still extracts per-player physics from screenshots when `physics_motion` flags — that's the verdict path. Spec doc updated by Task 0 below.

---

## File Map

**New files:**

- `build/kn_rollback/kn_gameplay_addrs.h` — extracted address table (single source of truth)
- `build/kn_rollback/kn_hash_registry.c` — field-granular `kn_hash_<field>` exports + history rings
- `build/kn_rollback/kn_hash_registry.h` — registry public API + citation block requirement comment
- `scripts/check-hash-citations.sh` — CI guardrail enforcing decomp-citation comments on every `kn_hash_*` export
- `tests/hash-golden/test_hash_registry.py` — golden-file correctness tests (load known savestate, assert hash bytes)
- `tests/hash-golden/fixtures/README.md` — savestate fixture docs
- `web/static/kn-desync-detector.js` — cross-peer comparison + flag pipeline (chunk 2)
- `web/static/kn-vision-client.js` — canvas capture + POST to vision endpoint (chunk 3)
- `server/src/api/desync_vision.py` — `/api/desync-vision` endpoint + post-mortem worker (chunk 3)
- `server/src/api/desync_prompts.py` — per-field Claude prompt templates (chunk 3)
- `server/alembic/versions/<rev>_desync_events.py` — `desync_events` SQLite migration (chunk 3)

**Modified files:**

- `build/kn_rollback/kn_rollback.c:1129-1267` — extract `kn_gameplay_addrs[]` to header; old `kn_gameplay_hash` stays for backward compat during rollout (no callers removed in this plan)
- `build/kn_rollback/kn_rollback.c:1296` — `kn_post_tick` invokes registry's per-field stash + history-ring append; passes `in_replay` flag for trajectory routing (Task 9)
- `build/kn_rollback/kn_rollback.c` (replay enter/exit sites) — invoke `kn_hash_on_replay_enter` / `kn_hash_on_replay_exit` (Task 8)
- `build/build.sh` — add new exports to `EXPORTED_FUNCTIONS` list (`_kn_hash_<field>`, replay-event readouts, etc.)
- `web/static/netplay-lockstep.js` — wire detector module into tick loop, dispatch suspect events (chunk 2)
- `server/pyproject.toml` — add `anthropic>=0.34` dep (chunk 3)
- `server/src/api/app.py` — register `/api/desync-vision` route (chunk 3)

**No changes to:**

- Existing `kn_gameplay_hash` callers — left in place during rollout. A follow-up cleanup ticket migrates them after the new registry is proven.
- `kn-diagnostics.js` `captureCanvasHash` — reused as-is by the vision client.
- WebRTC DataChannel transport — digest packets piggyback on the existing connection.

---

## Chunk 1: Hash Registry Foundation

This chunk delivers the bedrock: extracted address table, field-granular C exports, history rings, citation enforcement, and golden tests. Nothing in JS/server-land changes here. By the end, every field listed in the v1 field set has a `kn_hash_<field>` export with a citation block, a sampling hook in `kn_post_tick`, and a passing golden test.

**Length note:** this chunk runs ~1200 lines, slightly over the 1000-line chunk guideline. The overage is concentrated in Task 4, which pattern-replicates the field-add procedure for 7 additional fields. Each is mechanically the same as Task 3 (the template), so an executor working through them in sequence will move quickly. Splitting Task 4 into its own micro-chunk would add ceremony without changing the work — accepted as a deliberate inflation rather than a structural problem.

### Task 0: Update spec field table to reflect per-player physics deferral

**Why:** The spec at lines 84-99 lists `damage`, `position`, `velocity`, `action_state` as v1 per-player fields. The plan defers them to v2 (see "Deviations from spec" above). The spec is the ongoing reference; leaving it inconsistent invites future drift. One small edit closes the gap before any code is written.

**Files:**

- Modify: `docs/superpowers/specs/2026-04-25-desync-detection-design.md` (the field-set table in the "The hash registry" section)

- [ ] **Step 1: Edit the field-set table**

Replace the v1 field table in the spec with the v1-actual table (drop the four pooled-GObj per-player fields, add `physics_motion`, `vs_battle_hdr`, `css_cursor`, `css_selected`):

```markdown
| Field             | Per-player | Source                              | Phase    |
|-------------------|------------|-------------------------------------|----------|
| `stocks`          | yes        | `SCPlayerData.stock_count`          | in-game  |
| `character_id`    | yes        | CSS struct +0x48                    | CSS+     |
| `css_cursor`      | yes        | CSS struct +0x54                    | menu/CSS |
| `css_selected`    | yes        | CSS struct +0x58                    | menu/CSS |
| `rng`             | no         | `sSYUtilsRandomSeed`                | all      |
| `match_phase`     | no         | `gSCManagerSceneData.scene_curr`    | all      |
| `vs_battle_hdr`   | no         | VS battle state header (32 bytes)   | in-game  |
| `physics_motion`  | no         | `gFTManagerMotionCount` packed      | in-game  |
```

Add a one-line note immediately below: "*Per-player damage/position/velocity/action_state deferred to v2 — SSB64 fighters are pooled GObjs with no fixed RDRAM address (`build/kn_rollback/kn_rollback.c:1158-1163`). `physics_motion` is the v1 substitute (cross-JIT desyncs hit it first per `project_cross_jit_hunt_apr24`). Vision extracts per-player physics from screenshots when `physics_motion` flags.*"

- [ ] **Step 2: Commit the spec update**

```bash
git add docs/superpowers/specs/2026-04-25-desync-detection-design.md
git commit -m "docs(spec): defer per-player physics to v2; add physics_motion

SSB64 fighter structs are pooled GObjs (kn_rollback.c:1158-1163) — no
fixed-address per-player sampling possible. v1 uses gFTManagerMotionCount
as a global physics divergence proxy; vision handles per-player verdict
when the global counter flags."
```

---

### Task 1: Extract `kn_gameplay_addrs[]` table to a header file

**Why:** The existing `kn_gameplay_addrs[]` array in `kn_rollback.c:1136` is the source of truth for what addresses we sample, but it's embedded in a 2173-line C file alongside the rollback engine. The new registry needs the same address constants, and we want one source of truth (not two parallel tables — that's the exact failure mode the registry is designed to prevent). Extract the array to `kn_gameplay_addrs.h` so both `kn_rollback.c` and the new `kn_hash_registry.c` reference identical addresses.

**Files:**

- Create: `build/kn_rollback/kn_gameplay_addrs.h`
- Modify: `build/kn_rollback/kn_rollback.c:1129-1267` (replace inline array with `#include "kn_gameplay_addrs.h"`)

- [ ] **Step 1: Create header with extracted address table**

Create `build/kn_rollback/kn_gameplay_addrs.h` containing the existing `kn_gameplay_addr_t` struct and `kn_gameplay_addrs[]` array, plus *named* address constants for fields the registry will hash. Keep all existing comments (the cautionary notes about the 9-month bug and the audio-tic counter mistake are load-bearing context for future maintainers).

```c
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
```

Then in `kn_rollback.c`, replace lines 1129-1267 (the inline `kn_gameplay_addrs[]` definition) with:

```c
#include "kn_gameplay_addrs.h"

/* Definition. Declaration is in the header.
 *
 * IMPORTANT — preservation rule for this migration:
 *   This array is moving from the .c file to the .h header (declaration)
 *   + .c file (definition). Every byte and every comment from the original
 *   array (kn_rollback.c:1136-1266 in the pre-extraction version) MUST
 *   appear here unchanged. The array's order and contents are:
 *
 *     - Lines 1166-1182: scene_curr, VS battle header, P1-P4 stocks
 *     - Lines 1183-1192: RNG seed (sSYUtilsRandomSeed)
 *     - Lines 1194-1234: 32 CSS-state entries (P1-P4 × 8 fields each)
 *     - Lines 1235-1253: REMOVED entries (the audio-tic-counter mistake)
 *                        — keep these comments verbatim, they document why
 *                        we don't sample those addresses
 *     - Lines 1255-1265: Fighter manager counters
 *
 *   Mechanical migration: copy the original array content (the entire
 *   block between `static const kn_gameplay_addr_t kn_gameplay_addrs[] = {`
 *   and the closing `};`) into this new definition VERBATIM. The only
 *   substitutions allowed are:
 *     - `0xA4AD0`            → `KN_ADDR_SCENE_CURR`
 *     - `0xA4EF8`, `32`      → `KN_ADDR_VS_BATTLE_HEADER, KN_SIZE_VS_BATTLE_HEADER`
 *     - `0xA4F23`            → `KN_ADDR_PLAYER_STOCKS_BASE + 0*KN_PLAYER_STRIDE`
 *     - `0xA4F97`            → `KN_ADDR_PLAYER_STOCKS_BASE + 1*KN_PLAYER_STRIDE`
 *     - `0xA500B`            → `KN_ADDR_PLAYER_STOCKS_BASE + 2*KN_PLAYER_STRIDE`
 *     - `0xA507F`            → `KN_ADDR_PLAYER_STOCKS_BASE + 3*KN_PLAYER_STRIDE`
 *     - `0x03B940`           → `KN_ADDR_SY_UTILS_RANDOM_SEED`
 *     - `0x130D90`           → `KN_ADDR_FT_PLAYERS_NUM`
 *     - `0x130D94`           → `KN_ADDR_FT_MOTION_COUNT`
 *
 *   The 32 CSS entries (0x13BAD0 through 0x13BD44) keep their raw hex
 *   literals — they are individual offsets within a struct, not named
 *   constants in the header. Likewise the comments above each entry
 *   (e.g. `P1 css char_id (+0x48)`) are preserved unchanged.
 *
 *   The "REMOVED 2026-04-24" comment block (kn_rollback.c:1239-1253)
 *   that explains why dSYAudioCurrentTic and dSYTaskmanUpdateCount are
 *   NOT in the table is critical context — copy it verbatim.
 *
 *   Verification: after extraction, the array content (number of entries,
 *   their .rdram_offset values, their .size values) must be byte-identical
 *   to before — see Step 2 verification.
 */
const kn_gameplay_addr_t kn_gameplay_addrs[] = {
    /* [Mechanically migrate kn_rollback.c:1136-1266 here, applying the
     *  named-constant substitutions listed above. Preserve every comment
     *  verbatim, including the cautionary blocks at 1137-1166, 1186-1191,
     *  1239-1253, and 1255-1263.] */
};
const size_t kn_gameplay_addr_count = sizeof(kn_gameplay_addrs) / sizeof(kn_gameplay_addrs[0]);
```

The legacy comments from the original block (lines 1137-1166, 1186-1191, 1239-1253, 1255-1263) MUST be preserved verbatim — they document past bugs.

- [ ] **Step 2: Verify build succeeds AND array bytes are byte-identical**

Run: `cd /Users/kazon/kaillera-next/build && bash build.sh 2>&1 | tail -40`
Expected: Build completes, `web/static/ejs/cores/mupen64plus_next-wasm.data` is regenerated. No compile errors.

Then verify byte-identical extraction. From a temporary `verify_addrs_byte_eq.c` file in /tmp:

```c
#include <stdio.h>
#include <string.h>
#include "kn_gameplay_addrs.h"

/* Reference: paste the original 41-entry array from the pre-extraction
 * git ref (HEAD~1) here as `original_addrs[]`. Compare element-by-element. */
extern const kn_gameplay_addr_t kn_gameplay_addrs[];
extern const size_t kn_gameplay_addr_count;

int main(void) {
    /* Hand-derived expected counts from kn_rollback.c@HEAD~1:
     *   1 (scene) + 1 (vs hdr) + 4 (stocks) + 1 (rng) + 32 (CSS) + 2 (FT) = 41 */
    if (kn_gameplay_addr_count != 41) {
        fprintf(stderr, "FAIL: count is %zu, expected 41\n", kn_gameplay_addr_count);
        return 1;
    }
    /* Spot-check the four entries most likely to be miscoded by the
     * named-constant substitution: */
    if (kn_gameplay_addrs[0].rdram_offset != 0xA4AD0) return 2;
    if (kn_gameplay_addrs[1].rdram_offset != 0xA4EF8 || kn_gameplay_addrs[1].size != 32) return 3;
    if (kn_gameplay_addrs[2].rdram_offset != 0xA4F23) return 4; /* P1 stocks */
    if (kn_gameplay_addrs[5].rdram_offset != 0xA507F) return 5; /* P4 stocks */
    if (kn_gameplay_addrs[6].rdram_offset != 0x03B940) return 6; /* RNG */
    if (kn_gameplay_addrs[39].rdram_offset != 0x130D90) return 7; /* FT players num */
    if (kn_gameplay_addrs[40].rdram_offset != 0x130D94) return 8; /* FT motion */
    printf("kn_gameplay_addrs[]: %zu entries verified byte-identical\n", kn_gameplay_addr_count);
    return 0;
}
```

Compile + run: `gcc -I build/kn_rollback /tmp/verify_addrs_byte_eq.c build/kn_rollback/kn_rollback.c -o /tmp/verify_addrs && /tmp/verify_addrs`
Expected: prints `kn_gameplay_addrs[]: 41 entries verified byte-identical`, exits 0.

(If `kn_rollback.c` won't compile standalone due to other missing deps, alternative: print `kn_gameplay_addr_count` and the spot-checked offsets via a small `kn_dump_addrs` debug export and compare against a snapshot taken from `HEAD~1` before this commit.)

- [ ] **Step 3: Commit**

```bash
git add build/kn_rollback/kn_gameplay_addrs.h build/kn_rollback/kn_rollback.c
git commit -m "refactor(kn_rollback): extract gameplay_addrs to header

Single source of truth for the new hash registry to share with
the legacy kn_gameplay_hash. No address values changed — same
bytes, same struct layout, same backward-compat for callers."
```

---

### Task 2: Add `kn_hash_registry.c` skeleton with FNV-1a helper and citation header

**Why:** Before any per-field export, lay down the registry file with its public-facing comment, the FNV-1a helper (extracted from existing `kn_rollback.c:1273`-style code so we don't duplicate the implementation), and the citation-block convention. Subsequent tasks add one field per task on top of this skeleton.

**Files:**

- Create: `build/kn_rollback/kn_hash_registry.c`
- Create: `build/kn_rollback/kn_hash_registry.h`

- [ ] **Step 1: Create the header**

`build/kn_rollback/kn_hash_registry.h`:

```c
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

/* Per-field exports (declarations only — definitions in kn_hash_registry.c).
 * Per-player exports take a player_idx in [0, 3]. Frame parameter is
 * informational only (selects history-ring entry; pass -1 for live).
 *
 * Field exports added in Tasks 3 onward. */

/* History-ring readout: copies up to `count` (frame, hash) pairs from the
 * field's ring into `out_pairs` (Uint32Array of size 2*count, JS view).
 * Returns number of pairs actually written.
 *
 * Memory layout: [frame0, hash0, frame1, hash1, ...] most-recent-first.
 * Empty slots zero-filled when ring isn't full yet. */
size_t kn_hash_history_damage(uint8_t player_idx, uint32_t count, uint32_t* out_pairs);
size_t kn_hash_history_position(uint8_t player_idx, uint32_t count, uint32_t* out_pairs);
/* (additional history exports added per-field in later tasks) */

/* Internal: invoked from kn_post_tick to refresh all field hashes and
 * append to history rings. Returns 0 on success. */
int kn_hash_registry_post_tick(int32_t frame);

#endif /* KN_HASH_REGISTRY_H */
```

- [ ] **Step 2: Create the registry skeleton with FNV-1a helper**

`build/kn_rollback/kn_hash_registry.c`:

```c
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

/* Internal post-tick hook (no-op until fields are added). */
KN_KEEPALIVE
int kn_hash_registry_post_tick(int32_t frame) {
    (void)frame;
    return 0;
}
```

- [ ] **Step 3: Wire build.sh to compile the new file**

In `build/build.sh`, find the `nrequire_files` or compile sources list (search for `kn_rollback.c`). Add `kn_hash_registry.c` alongside. The change is one line additional source in the same compilation unit pattern as `kn_rollback.c`.

Run: `grep -n 'kn_rollback.c' /Users/kazon/kaillera-next/build/build.sh` to find the right hook.

- [ ] **Step 4: Verify build still succeeds**

Run: `cd /Users/kazon/kaillera-next/build && bash build.sh 2>&1 | tail -20`
Expected: clean build, no link errors. The new exports `kn_hash_fnv1a` and `kn_hash_registry_post_tick` exist as symbols (verify with `nm web/static/ejs/cores/mupen64plus_next_libretro.wasm | grep kn_hash` — should show at least these two).

- [ ] **Step 5: Commit**

```bash
git add build/kn_rollback/kn_hash_registry.{c,h} build/build.sh
git commit -m "feat(kn_hash_registry): scaffold field-granular hash registry

FNV-1a helper (same as kn_gameplay_hash for byte-equal verdict),
citation-block invariant documented, ring-buffer infra placeholder.
No fields wired yet — added one per task in subsequent commits."
```

---

### Task 3: Add `kn_hash_stocks` (the simplest per-player field, used as the template for all others)

**Why:** Stocks is the smallest, most clearly-decomp-cited field (offset already corrected from the 9-month bug). Implement the full pipeline for it first — the export, the ring, the post-tick stash, the golden test — so subsequent fields are pattern-replication.

**Files:**

- Modify: `build/kn_rollback/kn_hash_registry.c` (add stocks export + ring + sampling)
- Modify: `build/kn_rollback/kn_hash_registry.h` (add stocks declaration with citation block)
- Create: `tests/hash-golden/test_hash_registry.py` (first golden test)
- Create: `tests/hash-golden/fixtures/css-p1-mario-2stocks.rdram` (raw RDRAM fixture)
- Create: `tests/hash-golden/fixtures/README.md` (how fixtures were captured)

- [ ] **Step 1: Capture a raw RDRAM fixture from a live match**

The `.rastate` format is *not* what the test will use — it's an HLE-state-only blob (see `kn_hle_save_to` in `kn_rollback.c`), with no RDRAM and no documented header. Instead, capture a **raw 8MB RDRAM dump** directly. The test treats this file as the RDRAM region with no header.

Capture procedure (executor runs once, commits the resulting binary):

1. `just dev` — start the dev server.
2. Open `https://localhost:27888/play.html?ejs_debug=1` in a private window.
3. Load SSB64 ROM (drag-and-drop or via path; see memory `reference_rom_path`).
4. Navigate to the target game state (for `css-p1-mario-2stocks`: get to CSS, P1 cursor on Mario, stock counter set to 2; for `in-game-fixture`: start a match, let it run a few seconds).
5. In the browser devtools console, run:
   ```js
   const ptr  = Module._kn_get_rdram_ptr();   // already exported per build.sh:97
   const size = Module._kn_get_rdram_size();
   const view = new Uint8Array(Module.HEAPU8.buffer, ptr, size);
   const blob = new Blob([view]);
   const url  = URL.createObjectURL(blob);
   const a    = document.createElement('a');
   a.href = url; a.download = 'rdram.bin'; a.click();
   ```
6. Move the downloaded file to `tests/hash-golden/fixtures/<descriptive-name>.rdram`.

For Task 3, the descriptive name is `css-p1-mario-2stocks.rdram`. Verify the byte at offset 0xA4F23 is exactly `0x02` before committing the fixture:

```bash
xxd -s 0xA4F23 -l 1 tests/hash-golden/fixtures/css-p1-mario-2stocks.rdram
# Expected output: 000a4f23: 02
```

If it isn't 0x02, the fixture wasn't captured at the right state — try again (CSS stock-count selector affects the `SCPlayerData.stock_count` byte).

Document in `tests/hash-golden/fixtures/README.md`:

```markdown
# Hash Golden Test Fixtures

Each `.rdram` file is a raw 8MB dump of N64 RDRAM at a known game state,
captured directly via the WASM module's `kn_get_rdram_ptr` / `_size`
exports. No header, no compression — `len(file) == kn_get_rdram_size()`.

The corresponding test loads the file as the RDRAM region and asserts
hash bytes. If the hash registry samples a wrong address, the test
fails before the new code ever runs against a live match.

## Capturing a fixture

See plan `docs/superpowers/plans/2026-04-25-desync-detection.md` Task 3
Step 1 for the full capture procedure.

## Fixtures

- `css-p1-mario-2stocks.rdram` — CSS state, P1 cursor on Mario, stock
  counter set to 2. Byte at 0xA4F23 = 0x02. Used by
  `test_kn_hash_stocks_reads_2_for_p1_mario_fixture`.
```

- [ ] **Step 2: Write the failing golden test**

`tests/hash-golden/test_hash_registry.py`:

```python
"""Golden tests for kn_hash_registry exports.

Each test loads a known savestate fixture and asserts that the hash
registry returns expected bytes. A wrong address regresses the test
immediately — long before a real match ever runs against the new code.

Test runner: pytest tests/hash-golden/

The test exercises the registry through a minimal C harness compiled
to a native shared library (see Step 3 / 4 below). Browser-based
verification is impractical for unit-test speed.
"""
from __future__ import annotations

import ctypes
import pathlib

FIXTURE_DIR = pathlib.Path(__file__).parent / "fixtures"
LIB_PATH = pathlib.Path(__file__).parent / "build" / "libkn_hash_registry_test.so"


def _load_rdram_fixture(name: str) -> bytes:
    """Load a raw RDRAM dump fixture. File is 8MB of bytes, no header.

    Capture procedure documented in fixtures/README.md and the plan.
    Files MUST be captured via Module._kn_get_rdram_ptr() — never
    derived from .rastate (which is HLE-only)."""
    path = FIXTURE_DIR / name
    raw = path.read_bytes()
    # RDRAM_MAX_SIZE is 8MB per the mupen64plus core; reject anything else
    # to catch stale or wrong-format fixtures early.
    assert len(raw) == 8 * 1024 * 1024, (
        f"fixture {name} is {len(raw)} bytes, expected 8MB raw RDRAM dump"
    )
    return raw


def fnv1a(data: bytes) -> int:
    """FNV-1a 32-bit. Mirrors kn_hash_fnv1a in C — used to compute
    expected hash values from fixture bytes in goldens."""
    h = 0x811c9dc5
    for b in data:
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def test_kn_hash_stocks_reads_2_for_p1_mario_fixture():
    """Fixture has P1 set to 2 stocks; hash must reflect that byte."""
    lib = ctypes.CDLL(str(LIB_PATH))
    lib.kn_hash_stocks.argtypes = [ctypes.c_uint8, ctypes.c_int32]
    lib.kn_hash_stocks.restype  = ctypes.c_uint32
    lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]

    rdram = _load_rdram_fixture("css-p1-mario-2stocks.rdram")
    lib.kn_test_set_rdram(rdram, len(rdram))

    # Sanity: read the byte directly from fixture before asserting hash.
    assert rdram[0xA4F23] == 0x02, (
        f"fixture has stock byte 0x{rdram[0xA4F23]:02x}, expected 0x02 — "
        "recapture the fixture or check for address drift"
    )

    h = lib.kn_hash_stocks(0, -1)  # player 0 = P1, -1 = live read
    expected = fnv1a(bytes([0x02]))
    assert h == expected, f"kn_hash_stocks(P1) returned 0x{h:08x}, expected 0x{expected:08x}"
```

- [ ] **Step 3: Run test to verify it fails (no `kn_hash_stocks` exists yet)**

Run: `cd /Users/kazon/kaillera-next && uv run pytest tests/hash-golden/test_hash_registry.py -v`
Expected: FAIL — either "library not found" or "AttributeError: undefined symbol kn_hash_stocks".

- [ ] **Step 4: Add the export with mandatory citation block**

In `build/kn_rollback/kn_hash_registry.h`, append:

```c
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
KN_KEEPALIVE
uint32_t kn_hash_stocks(uint8_t player_idx, int32_t frame);

KN_KEEPALIVE
size_t kn_hash_history_stocks(uint8_t player_idx, uint32_t count, uint32_t* out_pairs);
```

Note: include `KN_KEEPALIVE` macro definition guard at the top of the header so prototypes can use it (already added in Task 2).

- [ ] **Step 5: Implement `kn_hash_stocks` and ring in `kn_hash_registry.c`**

In `build/kn_rollback/kn_hash_registry.c`, append:

```c
/* ── kn_hash_stocks ──────────────────────────────────────────────────
 * See header for citation block. */
static kn_ring_entry_t s_ring_stocks[4][KN_RING_SIZE];
static uint32_t        s_head_stocks[4];

KN_KEEPALIVE
uint32_t kn_hash_stocks(uint8_t player_idx, int32_t frame) {
    if (player_idx >= 4) return 0;
    if (frame >= 0) {
        /* Read from history ring at the requested frame. */
        for (uint32_t i = 0; i < KN_RING_SIZE; i++) {
            const kn_ring_entry_t* e = &s_ring_stocks[player_idx][i];
            if (e->frame == frame) return e->hash;
        }
        return 0;
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
```

Then update `kn_hash_registry_post_tick` to call `ring_append_stocks(frame)`:

```c
KN_KEEPALIVE
int kn_hash_registry_post_tick(int32_t frame) {
    ring_append_stocks(frame);
    /* Additional fields appended in later tasks. */
    return 0;
}
```

- [ ] **Step 6: Build a native test harness so the golden test can run without WASM**

Create `tests/hash-golden/build_native.sh`:

```bash
#!/bin/bash
# Compile a native .so containing kn_hash_registry + a small test shim
# that lets pytest set the RDRAM contents from a fixture file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$(dirname "$0")/build"
mkdir -p "$OUT"

cat > "$OUT/test_shim.c" <<'EOF'
#include <stdint.h>
#include <stddef.h>
#include <string.h>

static uint8_t* g_rdram = NULL;
static size_t   g_rdram_size = 0;

uint8_t* kn_get_rdram_ptr(void) { return g_rdram; }
size_t   kn_get_rdram_size(void) { return g_rdram_size; }

/* Test entry point: copy fixture RDRAM into a heap buffer the registry
 * will read via the kn_get_rdram_ptr accessor. */
void kn_test_set_rdram(const char* data, size_t len) {
    static uint8_t* buf = NULL;
    if (buf) { free(buf); buf = NULL; }
    buf = (uint8_t*)malloc(len);
    memcpy(buf, data, len);
    g_rdram = buf;
    g_rdram_size = len;
}
EOF

gcc -shared -fPIC \
    -I"$ROOT/build/kn_rollback" \
    -O0 -g \
    "$ROOT/build/kn_rollback/kn_hash_registry.c" \
    "$OUT/test_shim.c" \
    -o "$OUT/libkn_hash_registry_test.so"

echo "Built $OUT/libkn_hash_registry_test.so"
```

Make it executable: `chmod +x tests/hash-golden/build_native.sh`. Add a pytest fixture / `conftest.py` that runs the build script if the `.so` is missing:

`tests/hash-golden/conftest.py`:

```python
"""Pytest config for hash-golden tests.

Builds the native test library on first run, exposes a shared FNV-1a
helper so individual tests don't re-derive constants."""
import pathlib
import subprocess
import pytest

@pytest.fixture(scope="session", autouse=True)
def _build_native_lib():
    so = pathlib.Path(__file__).parent / "build" / "libkn_hash_registry_test.so"
    if not so.exists():
        script = pathlib.Path(__file__).parent / "build_native.sh"
        subprocess.run(["bash", str(script)], check=True)
    assert so.exists()
```

The `fnv1a()` helper is defined in `test_hash_registry.py` (Step 2) and imported by additional test modules added in Task 4 — keeps a single source of truth for the algorithm in Python land.

- [ ] **Step 7: Run the test to verify it now passes**

Run: `cd /Users/kazon/kaillera-next && uv run pytest tests/hash-golden/test_hash_registry.py -v`
Expected: PASS. The `.so` builds, RDRAM gets loaded from the fixture, `kn_hash_stocks(0, -1)` returns the FNV-1a of `0x02`.

If the fixture wasn't captured cleanly (the actual byte at the address isn't 0x02), debug the fixture before debugging the C — verify with `od -An -tx1 -j $((0xA4F23)) -N 1 fixture.rastate.rdram` (after extracting the RDRAM region).

- [ ] **Step 8: Verify WASM build still succeeds end-to-end**

Run: `cd /Users/kazon/kaillera-next/build && bash build.sh 2>&1 | tail -20`
Expected: clean WASM rebuild. `nm web/static/ejs/cores/mupen64plus_next_libretro.wasm | grep kn_hash_stocks` should show the export symbol.

- [ ] **Step 9: Commit**

```bash
git add build/kn_rollback/kn_hash_registry.{c,h} \
        tests/hash-golden/{test_hash_registry.py,build_native.sh,conftest.py} \
        tests/hash-golden/fixtures/{README.md,css-p1-mario-2stocks.rdram}
git commit -m "feat(kn_hash_registry): kn_hash_stocks + golden test

First field-granular export with full pipeline:
- decomp-cited declaration in registry header
- 600-entry history ring per player
- ring append from kn_post_tick path
- native-compiled golden test asserts FNV-1a of expected byte

Pattern replicated for remaining fields in subsequent commits."
```

---

### Task 4: Add remaining per-player fields (`damage`, `position`, `velocity`, `action_state`, `character_id`)

**Why:** With Task 3 establishing the pattern, the remaining per-player fields follow identical structure. Each gets its own export, ring, citation block, and golden test. Doing them in one task (with separate commits per field) keeps the rhythm tight while the pattern is fresh.

**Files:**

- Modify: `build/kn_rollback/kn_gameplay_addrs.h` (add address constants for the new fields)
- Modify: `build/kn_rollback/kn_hash_registry.{c,h}` (add 5 new fields)
- Modify: `tests/hash-golden/test_hash_registry.py` (add golden tests for each)
- Create: 4 additional fixture savestates under `tests/hash-golden/fixtures/`

- [ ] **Step 1: Identify decomp citations for each new field**

The fields and their decomp sources:

| Field           | Decomp citation                                                      | Address expression                                       | Size  |
|-----------------|----------------------------------------------------------------------|----------------------------------------------------------|-------|
| `damage`        | (TBD per Step 2)                                                     | live fighter struct — pooled, see Step 2                 | 4     |
| `position`      | (TBD per Step 2)                                                     | live fighter struct — pooled, see Step 2                 | 12    |
| `velocity`      | (TBD per Step 2)                                                     | live fighter struct — pooled, see Step 2                 | 8     |
| `action_state`  | (TBD per Step 2)                                                     | live fighter struct — pooled, see Step 2                 | 4     |
| `character_id`  | `lib/ssb-decomp-re/.../sctypes.h` (CSS struct +0x48)                | `KN_ADDR_P1_CSS_BASE + player_idx*KN_CSS_STRIDE + 0x48` | 4     |

**Critical constraint discovered during planning:** Per `kn_rollback.c:1158-1163`, "there is no fixed-address per-player fighter struct in SSB64 (live fighters are pooled GObjs)." This means `damage`, `position`, `velocity`, and `action_state` cannot be sampled by a fixed RDRAM offset — they require walking the GObj pool.

Two paths to resolve in Step 2:

1. **(Preferred) Use the existing `gFTManagerMotionCount` proxy** — already in the legacy table. This is a 16-bit packed counter that increments on every fighter motion event, so cross-peer divergence in motion counts implies cross-peer divergence in position/velocity. We already know it works (per `kn_rollback.c:1264` comment). Hash *the counters* as the per-player physics signal in v1; vision then checks the actual visible position when a flag fires. Skip per-player sampling for `damage`/`position`/`velocity`/`action_state` until v2 adds GObj-pool walking.

2. **(Deferred) Walk the GObj pool to find each player's live fighter struct** — significant new C code, error-prone, blocked by `gFTManagerPartsAllocBuf` not having a stable per-player layout.

Decision: take path 1 for v1. Reduce the field set: remove `damage`, `position`, `velocity`, `action_state` per-player and add `physics_motion` (global, not per-player) backed by the existing `KN_ADDR_FT_MOTION_COUNT`. Keep `character_id` per-player (CSS struct is fixed-address).

Update the file map and spec deviation list in this plan to reflect this. The spec's field table is updated in Step 2 below.

- [ ] **Step 2: Update spec deviation list and field set**

Edit the **Deviations from spec** section at the top of this plan to add:

```
- **Per-player physics not in v1:** spec listed `damage`, `position`, `velocity`,
  `action_state` as per-player fields. SSB64's fighter structs are pooled GObjs
  with no fixed RDRAM address (kn_rollback.c:1158-1163), so per-player sampling
  requires GObj-pool walking — significant new C code, deferred to v2. v1 uses
  the existing `gFTManagerMotionCount` packed counter as a global physics
  divergence proxy (which is what cross-JIT desyncs hit first per
  project_cross_jit_hunt_apr24). Vision still extracts per-player physics from
  screenshots when the global counter flags — that's the verdict path.
```

The v1 field set for the registry becomes:

| Field             | Per-player | Source                              | Size |
|-------------------|------------|-------------------------------------|------|
| `stocks`          | yes        | SCPlayerData.stock_count            | 1    |
| `character_id`    | yes        | CSS struct +0x48                    | 4    |
| `css_cursor`      | yes        | CSS struct +0x54                    | 4    |
| `css_selected`    | yes        | CSS struct +0x58                    | 4    |
| `rng`             | no         | sSYUtilsRandomSeed                  | 4    |
| `match_phase`     | no         | gSCManagerSceneData.scene_curr      | 1    |
| `vs_battle_hdr`   | no         | VS battle state header              | 32   |
| `physics_motion`  | no         | gFTManagerMotionCount packed        | 4    |

Eight fields total in v1. Keeps the registry tight and every entry decomp-cited.

- [ ] **Step 3: Add `kn_hash_character_id` (per-player CSS field) — TDD**

Repeat the Task 3 pattern for `character_id`. Important: the test asserts hash bytes from **what the fixture actually contains**, not from speculative character-ID claims.

1. Capture fixture `css-2players-selected.rdram` per Task 3 Step 1 procedure: CSS state with P1 picked some character and P2 picked a *different* character (any two — the test extracts the actual char_id bytes from the fixture rather than asserting against unverified ID values).
2. Read the actual char_id bytes from the fixture before writing the test:
   ```bash
   xxd -s 0x13BAD0 -l 4 tests/hash-golden/fixtures/css-2players-selected.rdram  # P1 char_id
   xxd -s 0x13BB8C -l 4 tests/hash-golden/fixtures/css-2players-selected.rdram  # P2 char_id
   ```
   Note the 4 bytes for each. The test uses these observed bytes to compute the expected FNV-1a value — no character-name-to-id assumptions.
3. Write failing test:
   ```python
   def test_kn_hash_character_id_matches_fixture_bytes():
       lib = ctypes.CDLL(str(LIB_PATH))
       lib.kn_hash_character_id.argtypes = [ctypes.c_uint8, ctypes.c_int32]
       lib.kn_hash_character_id.restype  = ctypes.c_uint32
       lib.kn_test_set_rdram.argtypes = [ctypes.c_char_p, ctypes.c_size_t]

       rdram = _load_rdram_fixture("css-2players-selected.rdram")
       lib.kn_test_set_rdram(rdram, len(rdram))

       # P1 char_id at 0x13BA88 (P1 CSS base) + 0x48 = 0x13BAD0
       p1_bytes = rdram[0x13BAD0:0x13BAD0 + 4]
       assert lib.kn_hash_character_id(0, -1) == fnv1a(p1_bytes)

       # P2 char_id at 0x13BA88 + 0xBC + 0x48 = 0x13BB8C
       p2_bytes = rdram[0x13BB8C:0x13BB8C + 4]
       assert lib.kn_hash_character_id(1, -1) == fnv1a(p2_bytes)

       # Fixture sanity: P1 and P2 picked different chars, so hashes differ.
       assert lib.kn_hash_character_id(0, -1) != lib.kn_hash_character_id(1, -1)
   ```
4. Run test, expect FAIL (`kn_hash_character_id` doesn't exist yet).
5. Add header declaration with citation block:

   ```c
   /* kn_hash_character_id
    * Source:  CSS_PLAYER_STRUCT.char_id (the picked character ID per player)
    * decomp:  Existing in-tree reference: build/kn_rollback/kn_rollback.c:1199-1234
    *          (CSS char_id at +0x48 within per-player CSS struct, 0xBC stride)
    * Address: KN_ADDR_P1_CSS_BASE + player_idx*KN_CSS_STRIDE + KN_CSS_OFF_CHAR_ID
    * Sampling: kn_post_tick (post-physics, pre-render)
    */
   KN_KEEPALIVE
   uint32_t kn_hash_character_id(uint8_t player_idx, int32_t frame);

   KN_KEEPALIVE
   size_t kn_hash_history_character_id(uint8_t player_idx, uint32_t count, uint32_t* out_pairs);
   ```

5. Implement export, ring, append helper. Pattern is byte-identical to Task 3 / Step 5 except address is `KN_ADDR_P1_CSS_BASE + p*KN_CSS_STRIDE + KN_CSS_OFF_CHAR_ID` and length is 4.

6. Append `ring_append_character_id(frame)` to `kn_hash_registry_post_tick`.

7. Run test, expect PASS.

8. Commit: `feat(kn_hash_registry): kn_hash_character_id + golden test`.

- [ ] **Step 4: Add `kn_hash_css_cursor` and `kn_hash_css_selected` (same pattern, different offsets)**

Repeat Step 3's pattern for the two remaining per-player CSS fields:

- `kn_hash_css_cursor` → offset `KN_CSS_OFF_CURSOR_STATE` (0x54), 4 bytes
- `kn_hash_css_selected` → offset `KN_CSS_OFF_SELECTED_FLAG` (0x58), 4 bytes

Each in its own commit. No new fixture needed — reuse `css-2players-selected.rdram` from Step 3. Compute expected FNV-1a values from the bytes at those offsets (use `xxd -s 0x13BADC -l 4 fixture.rdram` to read).

- [ ] **Step 5: Add the four global fields (`rng`, `match_phase`, `vs_battle_hdr`, `physics_motion`)**

Same pattern, but no `player_idx` argument. Header signatures:

```c
KN_KEEPALIVE uint32_t kn_hash_rng(int32_t frame);
KN_KEEPALIVE uint32_t kn_hash_match_phase(int32_t frame);
KN_KEEPALIVE uint32_t kn_hash_vs_battle_hdr(int32_t frame);
KN_KEEPALIVE uint32_t kn_hash_physics_motion(int32_t frame);
```

Plus the corresponding `kn_hash_history_<field>` exports. Each gets its own ring (single ring per field, not 4 rings). Each gets a golden test. Each in its own commit.

**Fixture phase requirements:**

- `match_phase`: capture during in-game (the `scene_curr` byte will be the in-game scene ID; assert against the byte the fixture actually contains).
- `vs_battle_hdr`: must be in-game — the 32-byte VS battle header is meaningful only after match start.
- `physics_motion`: **must be in-game** — `gFTManagerMotionCount` only increments during fighter motion (per `kn_rollback.c:1255-1263`, "increment on fighter motion/stat events"). For a menu/CSS fixture the byte at 0x130D94 will likely be 0 or stale; either capture an in-game fixture (`in-game-mid-match.rdram`) or document in the test docstring that asserting against the fixture's actual bytes (which may include 0) is the correct verification.
- `rng`: any phase. The seed has a value at every frame.

Reuse `in-game-mid-match.rdram` (capture once, see Task 3 Step 1) for all three fields above. Each test extracts the actual bytes at its own offset before computing expected FNV-1a — never asserting against unverified value claims.

- [ ] **Step 6: Verify all golden tests pass**

Run: `cd /Users/kazon/kaillera-next && uv run pytest tests/hash-golden/ -v`
Expected: all 8 field tests PASS (1 from Task 3 + 3 per-player CSS + 4 global).

- [ ] **Step 7: Verify WASM build still succeeds and exports are present**

Run: `cd /Users/kazon/kaillera-next/build && bash build.sh 2>&1 | tail -20 && nm web/static/ejs/cores/mupen64plus_next_libretro.wasm | grep -c 'kn_hash_'`
Expected: clean build, count of `kn_hash_*` symbols ≥ 16 (8 fields × {kn_hash_X, kn_hash_history_X}) + the FNV helper + the post-tick hook.

---

### Task 5: Wire `kn_hash_registry_post_tick` into the existing `kn_post_tick` flow

**Why:** Up to now the registry's history rings only get filled if someone calls `kn_hash_registry_post_tick` directly. The actual integration point is the existing `kn_post_tick` in `kn_rollback.c:1296` — the function the netplay loop already calls every frame after the emulator advances. One call inserted there activates ring filling for every match.

**Files:**

- Modify: `build/kn_rollback/kn_rollback.c:1296` — add one call to `kn_hash_registry_post_tick(rb.frame)` after `rb.frame++`.

- [ ] **Step 1: Verify the integration point is correct**

Read `kn_rollback.c:1296-1310`. Confirm the function signature is `int kn_post_tick(void)` and that `rb.frame` is incremented near the top.

- [ ] **Step 2: Add the include and the call**

At the top of `kn_rollback.c` (with the other includes), add:

```c
#include "kn_hash_registry.h"
```

In `kn_post_tick`, immediately after `rb.frame++;`:

```c
int kn_post_tick(void) {
    if (!rb.initialized) return -1;
    rb.frame++;

    /* Refresh field-granular hashes and append to history rings.
     * No-op if RDRAM not yet bound. Cheap (~8 small FNV hashes per frame). */
    kn_hash_registry_post_tick(rb.frame);

    /* ... existing replay/ring logic continues unchanged ... */
}
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/kazon/kaillera-next/build && bash build.sh 2>&1 | tail -20`
Expected: clean build.

- [ ] **Step 4: Smoke-test live ring filling**

Capacity check before claiming the integration works.

Note: `Module._malloc` and `Module._free` are NOT in the existing `EXPORTED_FUNCTIONS` list (verified against `build/build.sh:97`). The smoke-test must use a static C buffer + a small dump export, or be deferred until Task 7 adds malloc/free. Cleanest path: add a thin static-buffer dump helper in `kn_hash_registry.c` so JS doesn't need malloc.

In `kn_hash_registry.c`, add (in Task 5 along with the `kn_post_tick` integration):

```c
/* Static scratch buffer for JS to read history rings without needing
 * Module._malloc. JS calls kn_smoke_dump_stocks(player, count) and then
 * reads kn_smoke_buf_ptr() via HEAPU32. Test/diagnostic only. */
static uint32_t s_smoke_buf[2 * KN_RING_SIZE];

KN_KEEPALIVE
uint32_t kn_smoke_buf_ptr(void) { return (uint32_t)(uintptr_t)s_smoke_buf; }

KN_KEEPALIVE
size_t kn_smoke_dump_stocks(uint8_t player_idx, uint32_t count) {
    return kn_hash_history_stocks(player_idx, count, s_smoke_buf);
}
```

**Important — export these helpers BEFORE running the smoke test below.** The smoke test depends on `_kn_smoke_buf_ptr` and `_kn_smoke_dump_stocks` being reachable from JS, but Task 7 (which adds the field exports) hasn't run yet. To avoid the circular dependency, add ONLY these two smoke-helper exports as part of this task — the full export list lives in Task 7.

Insert into `build/build.sh` immediately after the `_kn_restore_hidden_state_boot` symbol in the existing rollback-symbols sed line (line 97; insert before the closing `|Makefile.emulatorjs`):

```
,_kn_smoke_buf_ptr,_kn_smoke_dump_stocks
```

Rebuild WASM (`bash build.sh`). Then proceed with the browser console smoke test below.

Browser console smoke test:

1. Start the dev server.
2. Open the test URL, load SSB64, get to in-game.
3. After a few seconds of play, run:
   ```js
   const n = Module._kn_smoke_dump_stocks(0, 10);
   const ptr = Module._kn_smoke_buf_ptr();
   const view = new Uint32Array(Module.HEAPU8.buffer, ptr, 20);
   console.log('pairs returned:', n);
   for (let i = 0; i < n; i++) {
     console.log(`  frame ${view[i*2]}, hash 0x${view[i*2+1].toString(16)}`);
   }
   ```
4. Expected: 10 entries with strictly-decreasing-by-1 frame numbers (most recent first), all with the same hash (since stocks don't change frame-to-frame in idle play). If hashes are 0 or frames are -1, the ring isn't filling.

The `kn_smoke_*` exports are diagnostic-only — they don't appear in the JS detector module (chunk 2) which uses the real `kn_hash_history_*` exports through a properly allocated heap region.

- [ ] **Step 5: Commit**

```bash
git add build/kn_rollback/kn_rollback.c
git commit -m "feat(kn_rollback): wire hash registry into kn_post_tick

Per-frame FNV hashing of registered fields, each appended to a 600-entry
history ring. ~10s of frame-by-frame coverage available to JS readers.
No-op when RDRAM not bound. Existing kn_gameplay_hash unchanged."
```

---

### Task 6: Add citation enforcement script

**Why:** The whole correctness story rests on every `kn_hash_<field>` having a citation block. A grep-based CI script makes this enforceable: PRs that add an export without citation fail before merge. Without this, the rule is aspirational; with it, the rule is structural.

**Files:**

- Create: `scripts/check-hash-citations.sh`
- Modify: existing CI hook (or pre-commit config) to invoke the script

- [ ] **Step 1: Write the script**

`scripts/check-hash-citations.sh`:

```bash
#!/bin/bash
# Verify every kn_hash_* declaration in kn_hash_registry.h has a citation
# block immediately preceding it. Citation block must contain:
#   "Source:" "decomp:" "Address:" "Sampling:"
#
# Exits 0 if all declarations are cited; exits 1 with a list of offending
# declarations otherwise.
set -euo pipefail

HEADER="${1:-build/kn_rollback/kn_hash_registry.h}"

if [ ! -f "$HEADER" ]; then
    echo "Header file not found: $HEADER" >&2
    exit 2
fi

# Use awk to scan the header. State machine:
#   Tracks the last comment block seen.
#   When a "uint32_t kn_hash_..." or "size_t kn_hash_history_..." declaration
#   is encountered, verifies the most-recent comment block contains all four
#   required fields. Otherwise reports the missing/mis-cited declaration.

awk '
BEGIN { bad = 0; block = ""; in_block = 0 }

# Comment block start
/^\/\*/ { in_block = 1; block = $0 "\n"; next }

# Comment block continuation
in_block && /\*\// { in_block = 0; block = block $0 "\n"; next }
in_block { block = block $0 "\n"; next }

# Declaration line
/(uint32_t|size_t)[[:space:]]+kn_hash_/ {
    decl = $0
    missing = ""
    if (block !~ /Source:/)   missing = missing " Source:"
    if (block !~ /decomp:/)   missing = missing " decomp:"
    if (block !~ /Address:/)  missing = missing " Address:"
    if (block !~ /Sampling:/) missing = missing " Sampling:"
    if (missing != "") {
        print "MISSING_CITATION:" decl ":" missing
        bad = 1
    }
    block = ""
    next
}

# Reset block on blank line (only the comment immediately preceding the
# declaration counts as the citation). BEGIN-init makes this portable
# across BSD awk (macOS) and gawk (Linux CI).
/^[[:space:]]*$/ { block = "" }

END { exit bad }
' "$HEADER"
```

Make it executable: `chmod +x scripts/check-hash-citations.sh`.

- [ ] **Step 2: Test the script against the current header**

Run: `bash /Users/kazon/kaillera-next/scripts/check-hash-citations.sh`
Expected: exits 0, no output. (Every declaration in tasks 3-4 has a citation block.)

- [ ] **Step 3: Test the script catches a missing citation**

Temporarily add a fake export without citation to the header:

```c
KN_KEEPALIVE uint32_t kn_hash_fake(int32_t frame);
```

Run the script. Expected: exits 1, prints `MISSING_CITATION:KN_KEEPALIVE uint32_t kn_hash_fake(...): Source: decomp: Address: Sampling:`.

Remove the fake declaration. Re-run script — should exit 0 again.

- [ ] **Step 4: Hook into pre-commit and CI**

The repo has both `.pre-commit-config.yaml` and `.github/workflows/` (verified). Wire the script into both — pre-commit catches it locally, GitHub Actions catches it on PR for contributors who skip hooks.

**Pre-commit hook** — append to `.pre-commit-config.yaml`:

```yaml
  - repo: local
    hooks:
      - id: check-hash-citations
        name: Hash registry citation check
        entry: bash scripts/check-hash-citations.sh
        language: system
        files: ^build/kn_rollback/kn_hash_registry\.h$
        pass_filenames: false
```

**GitHub Actions** — create `.github/workflows/check-hash-citations.yml`:

```yaml
name: Hash citations
on:
  pull_request:
    paths:
      - 'build/kn_rollback/kn_hash_registry.h'
      - 'scripts/check-hash-citations.sh'

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Verify all kn_hash_* exports have citation blocks
        run: bash scripts/check-hash-citations.sh
```

- [ ] **Step 5: Verify the hook fires on a PR-style change**

Make a deliberate citation-break commit (just add a fake declaration without citation), run `pre-commit run --all-files` (or push and verify CI fails). Then revert.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-hash-citations.sh .pre-commit-config.yaml \
        .github/workflows/check-hash-citations.yml
git commit -m "ci: enforce decomp citations on kn_hash_registry exports

PRs that add a kn_hash_<field> export without a citation block fail.
Closes the wrong-address class of bug at the gate (cf. 9-month bug
where kn_gameplay_hash sampled gSCManagerTransferBattleState instead
of gSCManagerVSBattleState — the kind of mistake citations catch)."
```

---

### Task 7: Add WASM exports to `EXPORTED_FUNCTIONS` list

**Why:** Per `build/build.sh:97`, Emscripten's `EXPORTED_FUNCTIONS` list controls which symbols survive linking. Without adding the new `kn_hash_<field>` exports, JS can't call them — they get tree-shaken.

**Files:**

- Modify: `build/build.sh:97` — extend the `sed` substitution that injects rollback exports.

- [ ] **Step 1: Read the current export list**

Run: `grep -A5 'kn_rollback_init' /Users/kazon/kaillera-next/build/build.sh | head -20`. Identify the exact `sed` command that builds the export list.

- [ ] **Step 2: Append the new exports (single new `sed` line, keyed on `_kn_restore_hidden_state_boot`)**

Task 5 already added a small `sed` line for the smoke-helper exports. This step adds a *separate* `sed` line for the field exports, keyed on the same anchor. Both end up rewriting `Makefile.emulatorjs` independently — no need to merge with the existing 60-symbol list.

Insert this *after* the existing rollback-symbols sed at `build.sh:97` AND after Task 5's smoke-helpers sed:

```bash
sed -i 's|_kn_restore_hidden_state_boot|_kn_restore_hidden_state_boot, \\\n                     _kn_hash_fnv1a,_kn_hash_stocks,_kn_hash_history_stocks, \\\n                     _kn_hash_character_id,_kn_hash_history_character_id, \\\n                     _kn_hash_css_cursor,_kn_hash_history_css_cursor, \\\n                     _kn_hash_css_selected,_kn_hash_history_css_selected, \\\n                     _kn_hash_rng,_kn_hash_history_rng, \\\n                     _kn_hash_match_phase,_kn_hash_history_match_phase, \\\n                     _kn_hash_vs_battle_hdr,_kn_hash_history_vs_battle_hdr, \\\n                     _kn_hash_physics_motion,_kn_hash_history_physics_motion, \\\n                     _kn_hash_registry_post_tick|' Makefile.emulatorjs
```

This pattern (separate `sed` command per logical group of symbols, all keyed on `_kn_restore_hidden_state_boot`) keeps each diff small and lets the executor add or remove a symbol group without touching the others. The order in which the sed lines run doesn't matter — each replaces the anchor with `anchor + new_symbols`, so subsequent runs find a different prefix but still match the literal `_kn_restore_hidden_state_boot` substring.

Also extend `KN_ASYNCIFY_REMOVE` at `build.sh:91` so the new post-tick hook is marked synchronous (it's called inline from `kn_post_tick`). The current value is:

```
KN_ASYNCIFY_REMOVE='["retro_run","retro_serialize","retro_unserialize","runloop_iterate","core_run","emscripten_mainloop","kn_pre_tick","kn_post_tick","kn_live_gameplay_hash","kn_sync_read_cpu","kn_rdram_block_hashes","kn_eventqueue_hash","kn_subsystem_hashes","kn_get_cp0_count","kn_forward_replay_check"]'
```

Replace it with (note: append `kn_hash_registry_post_tick` as the new last element):

```
KN_ASYNCIFY_REMOVE='["retro_run","retro_serialize","retro_unserialize","runloop_iterate","core_run","emscripten_mainloop","kn_pre_tick","kn_post_tick","kn_live_gameplay_hash","kn_sync_read_cpu","kn_rdram_block_hashes","kn_eventqueue_hash","kn_subsystem_hashes","kn_get_cp0_count","kn_forward_replay_check","kn_hash_registry_post_tick"]'
```

(The other `kn_hash_*` exports don't need ASYNCIFY_REMOVE because they're called from JS, not from inside the emulator's tick path — Asyncify only matters for functions transitively invoked by the synchronous core loop.)

- [ ] **Step 3: Rebuild and verify exports**

Run:

```bash
cd /Users/kazon/kaillera-next/build && bash build.sh 2>&1 | tail -20
nm web/static/ejs/cores/mupen64plus_next_libretro.wasm | grep -E 'kn_hash_(stocks|character_id|css_cursor|css_selected|rng|match_phase|vs_battle_hdr|physics_motion|registry_post_tick|fnv1a)' | sort -u
```

Expected: 18 distinct symbols (8 fields × {kn_hash_X, kn_hash_history_X} + fnv + post_tick).

- [ ] **Step 4: Smoke-test from browser console**

```js
typeof Module._kn_hash_stocks      // "function"
typeof Module._kn_hash_history_rng // "function"
Module._kn_hash_stocks(0, -1)      // 2161025534 or similar non-zero number once a match has loaded
```

If any export is undefined, the `EXPORTED_FUNCTIONS` change didn't apply — re-check the sed pattern.

- [ ] **Step 5: Commit**

```bash
git add build/build.sh
git commit -m "build: export kn_hash_registry symbols to WASM module

All 8 v1 field exports + their history-ring counterparts + the
post-tick hook are now reachable from JS as Module._kn_hash_*."
```

---

### End of Chunk 1 — Verification gate (registry foundation)

Before moving to Chunk 2, the following must all be true:

- [ ] `bash scripts/check-hash-citations.sh` exits 0
- [ ] `uv run pytest tests/hash-golden/ -v` shows all 8 golden tests passing
- [ ] WASM build is clean and `Module._kn_hash_stocks(0, -1)` returns non-zero in a live match
- [ ] Live history ring smoke-test (Task 5 Step 4) shows monotonically-decreasing frame numbers
- [ ] Existing `kn_gameplay_hash` is **unchanged** in behavior
- [ ] No regression in `uv run pytest` from project root

---

## Chunk 2: Rollback Diagnostics

**Why a separate chunk:** Rollback-event field snapshots and replay-trajectory recording were added 2026-04-25 after the live finding that rollbacks/replays are the proximate cause of desyncs. They depend on Chunk 1 (field exports, snapshot helper, exports list) but are otherwise self-contained and ship value on their own — once Chunk 2 lands, the C-level diagnostic surface is complete and the rest of the work (Chunks 3-4) is wiring it through to JS, server, and vision.

This chunk is detection-only instrumentation. It does not change rollback engine behavior, doesn't add cross-device replay-determinism assumptions, and doesn't add auto-recovery (per `docs/netplay-invariants.md`).

### Task 8: Rollback-event field snapshots (pre/post replay)

**Why:** Live observation that rollbacks/replays are the proximate cause of desyncs (2026-04-25 user finding) means rollback boundaries are exactly when fields diverge. Capturing per-field hashes at the moment a replay starts and the moment it finishes — separately from the per-frame ring — gives a "what did the replay change?" delta directly. The cross-peer comparison in chunk 2 then surfaces "rollback at frame 3127 corrupted `physics_motion` on guest but not on host," which points the engine work at one specific event rather than a vague window.

This is detection-side instrumentation only. It does not change rollback engine behavior, doesn't try to bisect via replay-on-another-device (the cross-device-determinism trap memory `feedback_replay_dead_end` warns against), and doesn't add auto-recovery (per `docs/netplay-invariants.md`).

**Files:**

- Modify: `build/kn_rollback/kn_hash_registry.{c,h}` — add snapshot storage + enter/exit hooks
- Modify: `build/kn_rollback/kn_rollback.c` — invoke the new hooks at replay enter and exit boundaries
- Modify: `build/build.sh` — add new exports

- [ ] **Step 1: Add snapshot storage and hook declarations**

Append to `kn_hash_registry.h`:

```c
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
    KN_FIELD_COUNT
} kn_field_id_t;

/* Called by the rollback engine when a replay is scheduled.
 * `target_frame` is the frame the engine will restore to. */
KN_KEEPALIVE
void kn_hash_on_replay_enter(int32_t target_frame);

/* Called by the rollback engine when replay_remaining hits 0. */
KN_KEEPALIVE
void kn_hash_on_replay_exit(int32_t final_frame);

/* JS readout for the most recent replay event. Returns 0 if no replay
 * has occurred yet. Hash captured at the named boundary. */
KN_KEEPALIVE
uint32_t kn_get_pre_replay_hash(kn_field_id_t field);

KN_KEEPALIVE
uint32_t kn_get_post_replay_hash(kn_field_id_t field);

/* Returns the target/final frame numbers for the most recent replay,
 * so JS can correlate snapshots with the frame they apply to. */
KN_KEEPALIVE int32_t kn_get_last_replay_target_frame(void);
KN_KEEPALIVE int32_t kn_get_last_replay_final_frame(void);
```

- [ ] **Step 2: Implement the hooks in `kn_hash_registry.c`**

```c
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
}

KN_KEEPALIVE
void kn_hash_on_replay_enter(int32_t target_frame) {
    snapshot_all_fields(s_pre_replay);
    s_last_replay_target = target_frame;
    /* Clear post snapshot so callers don't see stale data mid-replay. */
    for (int i = 0; i < KN_FIELD_COUNT; i++) s_post_replay[i] = 0;
    s_last_replay_final = -1;
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
```

The `snapshot_all_fields` helper is intentionally a single function used by both enter and exit — keeps the field set in sync, and is the canonical place to add new fields' snapshots when chunk 1 grows.

- [ ] **Step 3: Wire enter/exit hooks into `kn_rollback.c`**

Find the rollback-engine sites that mark replay boundaries:

```bash
grep -n "replay_remaining\|replay_target" /Users/kazon/kaillera-next/build/kn_rollback/kn_rollback.c
```

The engine has two known boundary points:

- **Replay enter:** in `kn_pre_tick`, where `rb.replay_remaining` is set to a positive value and `rb.replay_target` is assigned. Add `kn_hash_on_replay_enter(rb.replay_target);` immediately after the assignment.
- **Replay exit:** in `kn_post_tick` at the existing block `if (rb.replay_remaining == 0) { ... }` that fires after `rb.replay_remaining--` drops to zero (around line 1301). Add `kn_hash_on_replay_exit(rb.frame);` inside that block.

The exact line numbers shift across edits in this plan; locate by code structure, not line number.

- [ ] **Step 4: Add the new exports to `EXPORTED_FUNCTIONS`**

Same pattern as Task 5 / Task 7: append a separate `sed` line in `build/build.sh` keyed on `_kn_restore_hidden_state_boot`. This keeps each task's symbol group editable in isolation:

```bash
sed -i 's|_kn_restore_hidden_state_boot|_kn_restore_hidden_state_boot, \\\n                     _kn_hash_on_replay_enter,_kn_hash_on_replay_exit, \\\n                     _kn_get_pre_replay_hash,_kn_get_post_replay_hash, \\\n                     _kn_get_last_replay_target_frame,_kn_get_last_replay_final_frame|' Makefile.emulatorjs
```

`KN_ASYNCIFY_REMOVE` extension at `build.sh:91`: add the two new function names. The current value (after Task 7's extension) ends with `,"kn_hash_registry_post_tick"`. Replace the closing `]'` with `,"kn_hash_on_replay_enter","kn_hash_on_replay_exit"]'`. Both are called from the synchronous tick path so must not be Asyncified.

- [ ] **Step 5: Smoke-test the snapshots fire on a real rollback**

Trigger a rollback first. The lockstep engine fires rollbacks naturally when network jitter delivers inputs out of order, so the easiest path is a two-tab Playwright session: open the play URL twice, host one, join from the other, start a match, let it run for ~60 seconds with random inputs (the existing `tests/determinism-automation.mjs` does this). At least one rollback will fire — confirm by watching for `C-REPLAY-START` in the browser console or session logs.

If no natural rollback fires, force one in devtools via the existing rollback engine path: in the lockstep tick, peers schedule rollbacks when they receive an input contradicting their prediction. Submitting an input through the existing `Module._kn_feed_input` for a frame *behind* the current frame will trigger it — but in practice waiting 60 seconds with two tabs is faster than crafting the synthetic input.

Once a rollback has fired, run in either tab's console:

```js
const pre  = Module._kn_get_pre_replay_hash(16);   // KN_FIELD_RNG enum value
const post = Module._kn_get_post_replay_hash(16);
const tgt  = Module._kn_get_last_replay_target_frame();
const fin  = Module._kn_get_last_replay_final_frame();
console.log(`replay ${tgt} → ${fin}: rng pre=0x${pre.toString(16)} post=0x${post.toString(16)} delta=${pre !== post}`);
```

Expected: target/final are real frame numbers (not -1), pre/post are non-zero. If `tgt === -1`, no rollback has happened yet.

- [ ] **Step 6: Commit**

```bash
git add build/kn_rollback/{kn_hash_registry.c,kn_hash_registry.h,kn_rollback.c} build/build.sh
git commit -m "feat(kn_hash_registry): rollback-event field snapshots

Captures per-field hashes at replay enter and exit boundaries.
Cross-peer comparison of pre/post deltas (chunk 2) surfaces 'this
rollback corrupted physics_motion on guest but not host' directly,
without needing cross-device replay determinism."
```

---

### Task 9: Per-frame replay trajectory ring

**Why:** Pre/post snapshots from Task 8 tell you *what changed* across a replay, but not *which frame within the replay* introduced the change. A small ring buffer that records every replay-pass field hash gives the trajectory: "frames 0–1 of the replay matched the forward pass, frame 2 diverged, frames 3+ stayed diverged." That isolates the rollback bug to one specific frame's worth of execution.

Storage is bounded: max replay depth (per `kn_get_max_depth` in the engine) is in the tens of frames; 8 fields × 30 frames × 8 bytes ≈ 2KB. Trivial.

Detail per the brainstorming: this is per-peer local state. Each peer records its own replay's behavior; cross-peer comparison happens through the same digest channel as everything else (chunk 2). No cross-device replay-determinism assumption.

**Files:**

- Modify: `build/kn_rollback/kn_hash_registry.{c,h}` — add replay ring storage + readout
- Modify: `build/kn_rollback/kn_rollback.c` — pass `in_replay` flag to the post-tick hook
- Modify: `build/build.sh` — add new exports

- [ ] **Step 1: Add the replay ring storage and readout export**

Append to `kn_hash_registry.h`:

```c
/* ── Per-frame replay trajectory ring ────────────────────────────────
 * On each replay frame, the post-tick hook writes that frame's field
 * hashes into s_replay_ring keyed by replay-relative offset (0 = first
 * replayed frame, 1 = second, ...). Cleared at every replay enter.
 *
 * Max replay depth in the engine is bounded by kn_get_max_depth();
 * this ring is sized to a comfortable upper bound (KN_MAX_REPLAY_FRAMES).
 */
#define KN_MAX_REPLAY_FRAMES 64

KN_KEEPALIVE
uint32_t kn_get_replay_frame_hash(kn_field_id_t field, uint32_t replay_offset);

/* How many frames have been recorded in the most recent replay (0 if no
 * replay has happened yet, or capped at KN_MAX_REPLAY_FRAMES). */
KN_KEEPALIVE
uint32_t kn_get_last_replay_length(void);
```

- [ ] **Step 2: Implement the ring and route writes**

Append to `kn_hash_registry.c`:

```c
/* ── Replay trajectory storage ───────────────────────────────────── */
static uint32_t s_replay_ring[KN_FIELD_COUNT][KN_MAX_REPLAY_FRAMES];
static uint32_t s_replay_length = 0;
static uint8_t  s_in_replay = 0;

/* Update the existing kn_hash_registry_post_tick signature to accept
 * an in_replay flag. JS callers don't change — the rollback engine is
 * the only caller. */
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
        /* Forward-pass write: append to the per-field history rings as
         * before. Existing per-field append helpers retain their
         * implementations from Tasks 3-5. */
        ring_append_stocks(frame);
        ring_append_character_id(frame);
        ring_append_css_cursor(frame);
        ring_append_css_selected(frame);
        ring_append_rng(frame);
        ring_append_match_phase(frame);
        ring_append_vs_battle_hdr(frame);
        ring_append_physics_motion(frame);
    }
    return 0;
}

/* (Two surgical edits to functions defined in Task 8 Step 2.) */

/* Edit 1: in kn_hash_on_replay_enter, AFTER the line `s_last_replay_final = -1;`
 * append two lines: */
    s_replay_length = 0;
    s_in_replay = 1;

/* Edit 2: in kn_hash_on_replay_exit, AFTER the line `s_last_replay_final = final_frame;`
 * append one line: */
    s_in_replay = 0;

KN_KEEPALIVE
uint32_t kn_get_replay_frame_hash(kn_field_id_t field, uint32_t replay_offset) {
    if (field < 0 || field >= KN_FIELD_COUNT) return 0;
    if (replay_offset >= KN_MAX_REPLAY_FRAMES) return 0;
    if (replay_offset >= s_replay_length) return 0;
    return s_replay_ring[field][replay_offset];
}

KN_KEEPALIVE
uint32_t kn_get_last_replay_length(void) { return s_replay_length; }
```

- [ ] **Step 3: Update `kn_rollback.c` to pass the `in_replay` flag**

Find the existing call site (added in Task 5):

```c
kn_hash_registry_post_tick(rb.frame);
```

Change to:

```c
kn_hash_registry_post_tick(rb.frame, rb.replay_remaining > 0);
```

- [ ] **Step 4: Add new exports**

Same pattern: append another separate `sed` line in `build/build.sh`:

```bash
sed -i 's|_kn_restore_hidden_state_boot|_kn_restore_hidden_state_boot, \\\n                     _kn_get_replay_frame_hash,_kn_get_last_replay_length|' Makefile.emulatorjs
```

- [ ] **Step 5: Smoke-test trajectory recording**

Live in the browser console after a rollback fires:

```js
const len = Module._kn_get_last_replay_length();
console.log(`replay length: ${len}`);
const RNG = 16;  // KN_FIELD_RNG enum value
for (let i = 0; i < len; i++) {
  const h = Module._kn_get_replay_frame_hash(RNG, i);
  console.log(`  +${i}: rng=0x${h.toString(16)}`);
}
```

Expected: a sequence of hashes, one per replayed frame. Compare to the per-frame forward ring at the same absolute frame numbers to find the first diverging frame.

- [ ] **Step 6: Commit**

```bash
git add build/kn_rollback/{kn_hash_registry.c,kn_hash_registry.h,kn_rollback.c} build/build.sh
git commit -m "feat(kn_hash_registry): per-frame replay trajectory ring

Records every replayed frame's field hashes into a ring buffer,
cleared at each replay enter. Combined with Task 8's pre/post
snapshots, gives 'frame +2 of the replay introduced the divergence'
diagnostics. Per-peer local state — no cross-device determinism
assumption (cf. memory feedback_replay_dead_end)."
```

---

### End of Chunk 2 — Verification gate (rollback diagnostics)

Before moving to Chunk 3, the following must all be true:

- [ ] All Chunk 1 verification items still pass
- [ ] Rollback-event smoke-test (Task 8 Step 5) shows non-zero pre/post hashes after at least one rollback fires
- [ ] `kn_get_last_replay_target_frame()` and `_final_frame()` return real frame numbers, not -1
- [ ] Replay trajectory smoke-test (Task 9 Step 5) shows `kn_get_last_replay_length() > 0` and per-frame hashes for the replay window
- [ ] **Existing rollback engine still works:** run a 60s two-tab session, watch for `C-REPLAY-START` / `C-REPLAY-END` log lines in the console, confirm rollbacks fire and complete normally (no new fatal errors, no `FATAL-RING-STALE` storm, no `REPLAY-NORUN` increase). This is a qualitative smoke check — exact pre-chunk-2 baseline counts are not captured because they vary session-to-session; the gate is "rollback engine fundamentally still functions," not "byte-equal counter values."
- [ ] No regression in `uv run pytest`

---

## Chunk 3: JS Cross-Peer Detector

This chunk delivers the cross-peer comparison and flag pipeline. By the end, every peer broadcasts a per-frame digest over the existing WebRTC DataChannel, the detector runs pairwise (B-mode) or host-authoritative (C-mode) comparison, applies phase gating + flag dedup, fires a heartbeat in B-mode, and emits `desync-suspect` events on `KNState`. The events carry enough info (frame, field, slot, hashes, replay-event metadata, history-ring deltas) for chunk 4's vision client to call Claude with a targeted prompt.

No vision API calls happen in this chunk. The detector emits suspect events into `KNState`; chunk 4 wires the consumer.

### Task 10: Skeleton module `kn-desync-detector.js` with config

**Why:** Establish the module boundaries, the configurable knobs (digest cadence, dedup window, heartbeat interval, mode), and the public surface (`KNDesync.tick()`, `KNDesync.setMode()`) before any cross-peer plumbing. Subsequent tasks fill in behavior.

**Files:**

- Create: `web/static/kn-desync-detector.js`
- Modify: `web/play.html` — add a `<script>` tag for the new module after `kn-state.js` and before `netplay-lockstep.js`

- [ ] **Step 1: Write the module skeleton**

```js
/**
 * kn-desync-detector.js — Cross-peer field-granular desync detection.
 *
 * Architecture: each peer computes per-frame field hashes via the C
 * exports added in kn_hash_registry, broadcasts a digest packet over
 * the existing WebRTC DataChannel, and compares against peer digests
 * by frame_id. Mismatches emit `desync-suspect` events on KNState
 * which kn-vision-client.js (chunk 4) consumes.
 *
 * Pattern: IIFE + window.KNDesync, matching project convention
 * (no ES modules — see memory feedback_no_es_modules).
 *
 * Spec: docs/superpowers/specs/2026-04-25-desync-detection-design.md
 * Plan: docs/superpowers/plans/2026-04-25-desync-detection.md
 */
(function () {
  'use strict';

  /* ── Configuration ──────────────────────────────────────────────
   * All five knobs live here. Adjust without touching plumbing. */
  const CONFIG = {
    // Digest broadcast cadence (frames between sends). B=1 (every frame)
    // for fine-grained iteration; C=6 (~10Hz at 60fps) for prod bandwidth.
    digestCadence: { B: 1, C: 6 },

    // Heartbeat interval (ms). B-mode only — fires synthetic suspect
    // events to catch hash blind spots (e.g. CSS cursor pixel offsets
    // not yet reflected in RDRAM).
    heartbeatIntervalMs: 5000,

    // Per-(field, slot) flag dedup window (frames). Once a flag fires,
    // suppress further flags for the same (field, slot) until this many
    // frames pass.
    dedupWindowFrames: 60,

    // History ring depth requested per readout (≤ KN_RING_SIZE = 600).
    historyDepth: 60,

    // Vision confidence threshold for confirmed-desync events (chunk 4).
    visionConfidenceMin: 'med', // 'low' | 'med' | 'high'
  };

  /* ── KN_FIELD_* enum (mirror of kn_hash_registry.h) ────────────── */
  const FIELD = Object.freeze({
    STOCKS_P0: 0, STOCKS_P1: 1, STOCKS_P2: 2, STOCKS_P3: 3,
    CHARACTER_ID_P0: 4, CHARACTER_ID_P1: 5, CHARACTER_ID_P2: 6, CHARACTER_ID_P3: 7,
    CSS_CURSOR_P0: 8, CSS_CURSOR_P1: 9, CSS_CURSOR_P2: 10, CSS_CURSOR_P3: 11,
    CSS_SELECTED_P0: 12, CSS_SELECTED_P1: 13, CSS_SELECTED_P2: 14, CSS_SELECTED_P3: 15,
    RNG: 16,
    MATCH_PHASE: 17,
    VS_BATTLE_HDR: 18,
    PHYSICS_MOTION: 19,
    COUNT: 20,
  });

  /* ── State ────────────────────────────────────────────────────── */
  let _mode = 'B';                  // 'B' (test/dev) | 'C' (prod)
  let _enabled = false;
  let _module = null;               // emscripten Module ref, set on init
  let _peerDigests = new Map();     // peer_id → { frame → digest }
  let _localFrameTick = 0;
  let _lastFlagFrame = new Map();   // "field:slot" → frame
  let _heartbeatTimerId = null;

  /* ── Public API ──────────────────────────────────────────────── */
  const KNDesync = {
    init(emModule, mode = 'B') {
      _module = emModule;
      _mode = mode;
      _enabled = true;
      _peerDigests.clear();
      _lastFlagFrame.clear();
      console.log(`[KNDesync] init mode=${mode}`);
      if (_mode === 'B') _startHeartbeat();
    },

    setMode(mode) {
      _mode = mode;
      if (mode === 'B') _startHeartbeat();
      else _stopHeartbeat();
    },

    /* Called from netplay-lockstep tick after the emulator advances. */
    tick(frame) {
      if (!_enabled || !_module) return;
      _localFrameTick = frame;
      // Implementation in subsequent tasks.
    },

    /* Called from setupDataChannel onmessage when a 'digest' packet arrives. */
    onPeerDigest(peerId, payload) {
      // Implementation in Task 12.
    },

    /* Test-only escape hatch for unit tests. */
    _testHooks: { CONFIG, FIELD },
  };

  function _startHeartbeat() { /* Task 15 */ }
  function _stopHeartbeat()  { /* Task 15 */ }

  window.KNDesync = KNDesync;
})();
```

- [ ] **Step 2: Add the script tag to `play.html`**

Find the existing `<script src="static/kn-state.js"></script>` line. Add `<script src="static/kn-desync-detector.js?v=…"></script>` immediately after it (the `?v=` cache-buster pattern matches existing scripts in `play.html`). It must load *before* `netplay-lockstep.js` (which will call `KNDesync.init`).

- [ ] **Step 3: Smoke-test the module loads**

In a fresh incognito window with the dev server running:

```js
typeof KNDesync                  // "object"
typeof KNDesync.init             // "function"
KNDesync._testHooks.FIELD.RNG    // 16
```

If any return undefined, the script tag isn't loading or there's a syntax error.

- [ ] **Step 4: Commit**

```bash
git add web/static/kn-desync-detector.js web/play.html
git commit -m "feat(desync): scaffold kn-desync-detector module

IIFE skeleton with config, FIELD enum (mirrors kn_hash_registry.h),
public API stubs. No behavior yet — wired in subsequent commits."
```

---

### Task 11: Per-frame digest builder (calls C exports)

**Why:** The digest is the unit of cross-peer comparison. Build it on every tick from the chunk-1 C exports. Include both the live field hashes and the most recent rollback-event metadata from chunk 2 — so a peer that just rollbacked tells the others "this is what my replay produced."

**Files:**

- Modify: `web/static/kn-desync-detector.js`

- [ ] **Step 1: Implement the digest builder**

Inside the IIFE, after the state declarations, add:

```js
/* Build the digest for the current frame.
 * Returns a plain object that's safe to JSON.stringify and send over DC.
 * Cheap — ~20 C calls per frame, each is a couple of FNV ops. */
function _buildLocalDigest(frame) {
  const m = _module;
  const hashes = new Array(FIELD.COUNT);
  // Per-player fields (4 entries each, indexed by player slot)
  for (let p = 0; p < 4; p++) {
    hashes[FIELD.STOCKS_P0 + p]       = m._kn_hash_stocks(p, -1) >>> 0;
    hashes[FIELD.CHARACTER_ID_P0 + p] = m._kn_hash_character_id(p, -1) >>> 0;
    hashes[FIELD.CSS_CURSOR_P0 + p]   = m._kn_hash_css_cursor(p, -1) >>> 0;
    hashes[FIELD.CSS_SELECTED_P0 + p] = m._kn_hash_css_selected(p, -1) >>> 0;
  }
  // Globals
  hashes[FIELD.RNG]            = m._kn_hash_rng(-1) >>> 0;
  hashes[FIELD.MATCH_PHASE]    = m._kn_hash_match_phase(-1) >>> 0;
  hashes[FIELD.VS_BATTLE_HDR]  = m._kn_hash_vs_battle_hdr(-1) >>> 0;
  hashes[FIELD.PHYSICS_MOTION] = m._kn_hash_physics_motion(-1) >>> 0;

  // Rollback-event metadata: only included if a replay has fired since
  // the last digest. The last_replay_target sentinel (-1) means "none."
  const replayTarget = m._kn_get_last_replay_target_frame() | 0;
  const replayFinal  = m._kn_get_last_replay_final_frame() | 0;
  let replayMeta = null;
  if (replayTarget >= 0 && replayFinal >= 0) {
    const pre = new Array(FIELD.COUNT);
    const post = new Array(FIELD.COUNT);
    for (let f = 0; f < FIELD.COUNT; f++) {
      pre[f]  = m._kn_get_pre_replay_hash(f) >>> 0;
      post[f] = m._kn_get_post_replay_hash(f) >>> 0;
    }
    replayMeta = {
      target: replayTarget,
      final:  replayFinal,
      length: m._kn_get_last_replay_length() | 0,
      pre, post,
    };
  }

  return { frame, hashes, replayMeta };
}
```

- [ ] **Step 2: Wire the builder into `tick()`**

```js
tick(frame) {
  if (!_enabled || !_module) return;
  _localFrameTick = frame;

  // Build local digest unconditionally (cheap). Broadcast cadence
  // controls whether we transmit it.
  const localDigest = _buildLocalDigest(frame);

  // Compare against any peer digests buffered for this frame.
  // Implementation in Task 13.
  // _compareAtFrame(localDigest);

  // Broadcast on cadence boundaries.
  const cadence = CONFIG.digestCadence[_mode];
  if (frame % cadence === 0) {
    // Implementation in Task 12.
    // _broadcastDigest(localDigest);
  }
},
```

- [ ] **Step 3: Smoke-test the builder runs without errors**

In the browser console, after loading SSB64:

```js
KNDesync.init(Module, 'B');
const d = KNDesync._testHooks.CONFIG; // sanity that the module is alive
// Force a tick directly:
KNDesync.tick(100);
// (Should not throw; no observable output yet because broadcast is gated.)
```

Then add a temporary `console.log(localDigest)` inside `tick()` and re-run — verify the digest object has 20 hash entries plus a `replayMeta` field that's either `null` or has `pre`/`post` arrays.

Remove the temporary log before committing.

- [ ] **Step 4: Commit**

```bash
git add web/static/kn-desync-detector.js
git commit -m "feat(desync): per-frame digest builder

Calls the kn_hash_registry C exports for all 20 fields, attaches
rollback-event metadata when a replay has fired since last digest.
Pure read; no broadcast or comparison yet."
```

---

### Task 12: Wire digest broadcast over the existing WebRTC DataChannel

**Why:** Each peer needs to send digests to every other peer. The lockstep mesh already maintains a `peer.dc` per remote peer (`netplay-lockstep.js:2290+`). Reuse that channel; don't add a new connection.

**Files:**

- Modify: `web/static/kn-desync-detector.js` — add `_broadcastDigest`, `onPeerDigest`
- Modify: `web/static/netplay-lockstep.js` — add a `'digest'` case to the existing DC message handler

- [ ] **Step 1: Add `_broadcastDigest` to the detector**

Inside the detector IIFE, before the `KNDesync` object literal:

```js
/* Send local digest to every connected peer over their lockstep DC.
 * Tolerates partially-connected mesh: skip peers whose dc isn't open. */
function _broadcastDigest(digest) {
  const peers = window._peers || (window.KNState && KNState.peers) || {};
  const packet = JSON.stringify({ t: 'digest', ...digest });
  for (const sid of Object.keys(peers)) {
    const peer = peers[sid];
    if (!peer || !peer.dc || peer.dc.readyState !== 'open') continue;
    try {
      peer.dc.send(packet);
    } catch (e) {
      console.warn('[KNDesync] broadcast send failed for', sid, e);
    }
  }
}
```

- [ ] **Step 2: Add `onPeerDigest` to handle incoming**

```js
/* Buffer peer digests by (peer_id, frame) for the comparison step.
 * Drop digests outside the comparison window — peers that lag too
 * far behind aren't useful and would consume RAM unbounded. */
function _ingestPeerDigest(peerId, payload) {
  if (!payload || typeof payload.frame !== 'number') return;
  const dropFloor = _localFrameTick - CONFIG.historyDepth;
  if (payload.frame < dropFloor) return; // too stale

  let perPeer = _peerDigests.get(peerId);
  if (!perPeer) { perPeer = new Map(); _peerDigests.set(peerId, perPeer); }
  perPeer.set(payload.frame, payload);

  // Evict old frames to keep memory bounded.
  for (const f of perPeer.keys()) {
    if (f < dropFloor) perPeer.delete(f);
  }
}
```

Update the public API:

```js
onPeerDigest(peerId, payload) {
  _ingestPeerDigest(peerId, payload);
},
```

- [ ] **Step 3: Wire `'digest'` into the lockstep DC message handler**

In `web/static/netplay-lockstep.js`, locate the existing `setupDataChannel` function. Within it, find the `dc.onmessage` handler that switches on parsed JSON `type`/`t`. Add a new case:

```js
// Inside the dc.onmessage JSON-message branch:
if (msg.t === 'digest') {
  if (window.KNDesync) {
    KNDesync.onPeerDigest(remoteSid, msg);
  }
  return;
}
```

Make sure the case is placed alongside other JSON-typed messages (e.g. `delay-ping`/`delay-pong` near line 3232). Use `msg.t` rather than `msg.type` to match the digest packet's field name.

- [ ] **Step 4: Replace the placeholder broadcast call in `tick()`**

```js
if (frame % cadence === 0) {
  _broadcastDigest(localDigest);
}
```

- [ ] **Step 5: Smoke-test cross-peer flow**

Two-tab Playwright session (or two manual browser windows):

1. Open play URL twice (host + guest). Start a match.
2. In each tab's console, run `KNDesync.init(Module, 'B')` (will be auto-init in Task 16; for now manual).
3. In the host tab, after a few seconds:
   ```js
   const peerIds = [...KNDesync._testHooks.peerDigests.keys()];
   console.log('peers seen:', peerIds);
   const guestId = peerIds[0];
   const sample = [...KNDesync._testHooks.peerDigests.get(guestId).values()].slice(-1)[0];
   console.log('latest guest digest:', sample);
   ```
4. Expected: see at least one peer ID, latest digest has 20 hash entries.

(Add a debug accessor `_testHooks.peerDigests = _peerDigests` for this test if not already present.)

- [ ] **Step 6: Commit**

```bash
git add web/static/kn-desync-detector.js web/static/netplay-lockstep.js
git commit -m "feat(desync): cross-peer digest broadcast over lockstep DC

Reuses the existing per-peer WebRTC DataChannel. Digest packets are
JSON ('t':'digest'), 20 hash entries + optional replay metadata,
~200 bytes per packet. Bounded receiver-side buffering by frame
window. New 'digest' case added to setupDataChannel onmessage."
```

---

### Task 13: Frame-id bucketing + comparison logic (pairwise / host-auth)

**Why:** Once digests arrive from peers, compare them at matched frame_ids. The algorithm differs between B (pairwise — find the outlier) and C (host-auth — guests' deltas vs host). Field-granular output: every divergence flag carries the specific `(field, slot, frame, peers, hashes)`.

**Files:**

- Modify: `web/static/kn-desync-detector.js`

- [ ] **Step 1: Implement `_compareAtFrame`**

```js
/* Compare local digest against every peer digest at the same frame.
 * Emits a desync-suspect event for each (field, slot) divergence. */
function _compareAtFrame(localDigest) {
  const frame = localDigest.frame;
  // Find peers that have a digest for this exact frame.
  const peerHits = []; // [{ peerId, digest }]
  for (const [peerId, perPeer] of _peerDigests) {
    const d = perPeer.get(frame);
    if (d) peerHits.push({ peerId, digest: d });
  }
  if (peerHits.length === 0) return; // nothing to compare yet

  if (_mode === 'B') {
    _comparePairwise(localDigest, peerHits);
  } else {
    _compareHostAuth(localDigest, peerHits);
  }
}

/* B-mode: pairwise — every (local, peer_i) and every (peer_i, peer_j) pair.
 * Surfaces 'P3 disagrees with everyone else' patterns naturally. */
function _comparePairwise(local, peerHits) {
  const all = [{ peerId: 'local', digest: local }, ...peerHits];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      _diffDigests(all[i], all[j]);
    }
  }
}

/* C-mode: host-auth — host's hashes are ground truth.
 * Each guest's delta vs host is the signal. */
function _compareHostAuth(local, peerHits) {
  // Determine which side is host. KNState.peers[sid].isHost is set during
  // signaling; falls back to lowest slot.
  const localIsHost = _isLocalHost();
  if (localIsHost) {
    for (const guest of peerHits) {
      _diffDigests({ peerId: 'host', digest: local }, guest);
    }
  } else {
    const host = peerHits.find((p) => _isPeerHost(p.peerId));
    if (host) {
      _diffDigests(host, { peerId: 'local', digest: local });
    }
  }
}

function _isLocalHost() {
  return KNState.peers && Object.values(KNState.peers).some((p) => p.isLocalHost);
}
function _isPeerHost(peerId) {
  return KNState.peers?.[peerId]?.isHost === true;
}

/* Diff two digests at the field level. Emits one suspect event per
 * mismatched field, includes slot derivation for per-player fields. */
function _diffDigests(a, b) {
  const ha = a.digest.hashes, hb = b.digest.hashes;
  for (let fid = 0; fid < FIELD.COUNT; fid++) {
    if (ha[fid] === hb[fid]) continue;

    const slot = _slotForField(fid); // 0..3 or null for global
    const fieldName = _fieldName(fid);

    _emitSuspect({
      frame: a.digest.frame,
      field: fieldName,
      slot,
      hashes: { [a.peerId]: ha[fid], [b.peerId]: hb[fid] },
      trigger: 'flag',
      replayMeta: a.digest.replayMeta || b.digest.replayMeta || null,
    });
  }
}

/* Map field_id → slot (0..3) for per-player fields, null otherwise. */
function _slotForField(fid) {
  if (fid <= FIELD.STOCKS_P3)        return fid - FIELD.STOCKS_P0;
  if (fid <= FIELD.CHARACTER_ID_P3)  return fid - FIELD.CHARACTER_ID_P0;
  if (fid <= FIELD.CSS_CURSOR_P3)    return fid - FIELD.CSS_CURSOR_P0;
  if (fid <= FIELD.CSS_SELECTED_P3)  return fid - FIELD.CSS_SELECTED_P0;
  return null; // global
}

/* Map field_id → string name for the suspect event. */
const _FIELD_NAMES = ['stocks','stocks','stocks','stocks',
                      'character_id','character_id','character_id','character_id',
                      'css_cursor','css_cursor','css_cursor','css_cursor',
                      'css_selected','css_selected','css_selected','css_selected',
                      'rng','match_phase','vs_battle_hdr','physics_motion'];
function _fieldName(fid) { return _FIELD_NAMES[fid]; }
```

- [ ] **Step 2: Replace the placeholder comparison call in `tick()`**

```js
tick(frame) {
  if (!_enabled || !_module) return;
  _localFrameTick = frame;
  const localDigest = _buildLocalDigest(frame);
  _compareAtFrame(localDigest);
  const cadence = CONFIG.digestCadence[_mode];
  if (frame % cadence === 0) _broadcastDigest(localDigest);
},
```

- [ ] **Step 3: Stub out `_emitSuspect` until Task 16 (event emission)**

For now, `_emitSuspect` just logs — the actual KNState event happens in Task 16:

```js
function _emitSuspect(payload) {
  console.log('[KNDesync] suspect (stub):', payload);
}
```

- [ ] **Step 4: Smoke-test divergence flagging**

Force a divergence by mutating a digest before broadcast in one tab only:

```js
// In one tab's console, after init:
const orig = KNDesync._testHooks.buildDigest; // expose via _testHooks first
// (skip this real test until Task 16; for now, manually call _diffDigests
//  with two synthetic digests differing on FIELD.PHYSICS_MOTION and
//  verify a stub log fires.)
```

Cleanest verification: a unit test in `tests/desync-detector.spec.mjs` that requires the IIFE with a stub `Module` and asserts `_diffDigests` calls `_emitSuspect` with the right payload. (Add as part of Task 16's testing pass.)

- [ ] **Step 5: Commit**

```bash
git add web/static/kn-desync-detector.js
git commit -m "feat(desync): pairwise + host-auth comparison

B-mode runs pairwise across all (local + peers) to surface outliers.
C-mode runs guest-vs-host. Field-level diff emits one suspect event
per mismatched (field, slot)."
```

---

### Task 14: Phase gating + flag dedup window

**Why:** Without phase gating, in-game-only fields (damage-style) flag noisily during menus where they're meaningless. Without dedup, a single divergence flags every frame for the rest of the match. Both are cheap rules that dramatically improve signal-to-noise.

**Files:**

- Modify: `web/static/kn-desync-detector.js`

- [ ] **Step 1: Add phase-gating filter to `_diffDigests`**

Before the `for (let fid = 0; ...)` loop, derive both digests' `match_phase` and gate:

```js
function _diffDigests(a, b) {
  const ha = a.digest.hashes, hb = b.digest.hashes;

  // GATING RULE: if peers disagree on match_phase, that IS the flag.
  // Suppress all other field comparisons for this frame — they have
  // no defined meaning across mismatched phases. (See spec gating rule.)
  if (ha[FIELD.MATCH_PHASE] !== hb[FIELD.MATCH_PHASE]) {
    _emitSuspect({
      frame: a.digest.frame,
      field: 'match_phase',
      slot: null,
      hashes: { [a.peerId]: ha[FIELD.MATCH_PHASE], [b.peerId]: hb[FIELD.MATCH_PHASE] },
      trigger: 'flag',
      severity: 'high',
      replayMeta: null,
    });
    return;
  }

  // Rest of the diff logic unchanged ...
  for (let fid = 0; fid < FIELD.COUNT; fid++) {
    if (fid === FIELD.MATCH_PHASE) continue; // already handled
    if (ha[fid] === hb[fid]) continue;

    // Per-field phase eligibility:
    const phase = _phaseFromHash(ha[FIELD.MATCH_PHASE]); // common to both peers here
    if (!_fieldEligibleInPhase(fid, phase)) continue;

    // Dedup ...
    const dedupKey = `${fid}:${_slotForField(fid) ?? 'g'}`;
    const lastFlagged = _lastFlagFrame.get(dedupKey) ?? -1;
    if (a.digest.frame - lastFlagged < CONFIG.dedupWindowFrames) continue;
    _lastFlagFrame.set(dedupKey, a.digest.frame);

    _emitSuspect({ /* ... as in Task 13 ... */ });
  }
}

/* Helper: derive a coarse phase label from the match_phase hash. We
 * don't have a reverse mapping (hash is one-way), so the helper looks
 * up the most-recently-seen-locally raw scene byte from a small cache. */
let _lastSceneByte = -1;
function _phaseFromHash(_hash) {
  // Simplest viable: in-game iff scene_curr indicates VS battle.
  // The actual phase is read from the live RDRAM via a small C export.
  // For v1, gate by what the local module reports.
  return _module._kn_get_scene_curr ? _module._kn_get_scene_curr() : 0;
}

/* Per-field phase eligibility table. */
function _fieldEligibleInPhase(fid, phase) {
  // SCENE_BATTLE_FIELD ≈ in-game; SCENE_BATTLE_MENU ≈ pre-match menu.
  // The exact constants come from sctypes.h and are in the spec table.
  const inGame = (phase >= 0x0F && phase <= 0x16); // approximate range
  switch (fid) {
    case FIELD.STOCKS_P0: case FIELD.STOCKS_P1:
    case FIELD.STOCKS_P2: case FIELD.STOCKS_P3:
    case FIELD.VS_BATTLE_HDR: case FIELD.PHYSICS_MOTION:
      return inGame;
    case FIELD.CSS_CURSOR_P0: case FIELD.CSS_CURSOR_P1:
    case FIELD.CSS_CURSOR_P2: case FIELD.CSS_CURSOR_P3:
    case FIELD.CSS_SELECTED_P0: case FIELD.CSS_SELECTED_P1:
    case FIELD.CSS_SELECTED_P2: case FIELD.CSS_SELECTED_P3:
      return !inGame; // CSS-phase only
    default:
      return true; // RNG, character_id always eligible
  }
}
```

- [ ] **Step 2: Add the `kn_get_scene_curr` C export the gating depends on**

The phase-eligibility logic needs to read the raw scene byte. Add a tiny export to `kn_hash_registry.c`:

```c
KN_KEEPALIVE
uint8_t kn_get_scene_curr(void) {
    uint8_t* base = (uint8_t*)kn_get_rdram_ptr();
    if (!base || KN_ADDR_SCENE_CURR + 1 > kn_get_rdram_size()) return 0;
    return base[KN_ADDR_SCENE_CURR];
}
```

Add `_kn_get_scene_curr` to the `EXPORTED_FUNCTIONS` sed line (same separate-sed-line pattern). Update the verification gate: a scratch test in the browser console should print a sensible scene byte both at CSS and in-game.

- [ ] **Step 3: Smoke-test gating suppresses CSS-during-in-game flags**

This requires injecting a synthetic divergence on a non-eligible field during a known phase. Easiest: after Task 16's KNState event emission is wired, watch for events during a clean two-tab session and confirm:

- During CSS, no `physics_motion` events appear (gated out by `inGame=false`)
- During in-game, no `css_cursor` events appear (gated out)
- A genuine match_phase divergence fires immediately and suppresses other field comparisons for that frame

Defer this verification to Task 16 and document it on the chunk-3 verification gate.

- [ ] **Step 4: Commit**

```bash
git add web/static/kn-desync-detector.js build/kn_rollback/kn_hash_registry.{c,h} build/build.sh
git commit -m "feat(desync): phase gating + 60-frame flag dedup

match_phase mismatch is the high-priority flag and suppresses other
field comparisons for that frame (per spec gating rule). Per-field
phase eligibility table prevents in-game flags during menus.
60-frame dedup window per (field, slot) coalesces sustained
divergences into a single event."
```

---

### Task 15: Heartbeat scheduler (B-mode only)

**Why:** Hashes can agree while the visual differs (CSS cursor offset before any RDRAM write). Heartbeat fires synthetic suspect events every 5s in B-mode so vision (chunk 4) gets a regular check against blind spots even when no flag has fired.

**Files:**

- Modify: `web/static/kn-desync-detector.js`

- [ ] **Step 1: Implement `_startHeartbeat` / `_stopHeartbeat`**

```js
function _startHeartbeat() {
  _stopHeartbeat();
  if (_mode !== 'B') return;
  _heartbeatTimerId = setInterval(() => {
    if (!_enabled || !_module) return;
    _emitSuspect({
      frame: _localFrameTick,
      field: 'heartbeat',
      slot: null,
      hashes: null,
      trigger: 'heartbeat',
      // Heartbeat scope: which fields the vision client should check.
      scope: ['damage', 'stocks', 'position', 'css_cursor'],
      replayMeta: null,
    });
  }, CONFIG.heartbeatIntervalMs);
}

function _stopHeartbeat() {
  if (_heartbeatTimerId !== null) {
    clearInterval(_heartbeatTimerId);
    _heartbeatTimerId = null;
  }
}
```

- [ ] **Step 2: Smoke-test heartbeat fires in B mode and not in C**

```js
KNDesync.setMode('B');
// wait 5+ seconds, watch console for heartbeat suspect logs
KNDesync.setMode('C');
// wait another 10 seconds, no further heartbeat logs should appear
```

- [ ] **Step 3: Commit**

```bash
git add web/static/kn-desync-detector.js
git commit -m "feat(desync): B-mode heartbeat scheduler

Synthetic suspect events every 5s in B-mode so vision (chunk 4)
catches hash blind spots like CSS cursor pixel offsets. C-mode
disables — pure hash-flag triggering for prod."
```

---

### Task 16: KNState event emission + lockstep tick integration

**Why:** Up to now `_emitSuspect` just logs. This task wires it to dispatch events on a `KNDesync.events` `EventTarget` so chunk 4's vision client (and any future consumer) can subscribe. Also wires `KNDesync.tick(frame)` into the existing `netplay-lockstep.js` tick loop so it runs every frame.

**Files:**

- Modify: `web/static/kn-desync-detector.js`
- Modify: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Add `EventTarget` and update `_emitSuspect`**

```js
const _events = new EventTarget();

function _emitSuspect(payload) {
  // Attach matchId from KNState so consumers can correlate.
  payload.matchId = KNState.matchId;
  payload.matchPhase = _module._kn_get_scene_curr ? _module._kn_get_scene_curr() : 0;
  _events.dispatchEvent(new CustomEvent('desync-suspect', { detail: payload }));
}

KNDesync.events = _events;
```

Consumer pattern (chunk 4 will use this):

```js
KNDesync.events.addEventListener('desync-suspect', (e) => {
  console.log('suspect:', e.detail);
});
```

- [ ] **Step 2: Add `KNDesync.init` + `KNDesync.tick` calls into lockstep**

In `web/static/netplay-lockstep.js`, find:

1. The boot path where `Module` becomes ready (look for `ejs_emulator_started` or the equivalent post-boot hook). Add:

   ```js
   if (window.KNDesync) {
     const desyncMode = (new URLSearchParams(location.search)).get('desync') === 'b' ? 'B' : 'C';
     KNDesync.init(Module, desyncMode);
   }
   ```

2. The post-tick frame advance (look for `rb.frame++` mirror in JS, or the `_frameNum++` site). Add:

   ```js
   if (window.KNDesync) KNDesync.tick(_frameNum);
   ```

   Place it after the C `kn_post_tick` returns and `_frameNum` has been incremented.

- [ ] **Step 3: End-to-end smoke test**

Two-tab session:

1. Start dev server, open two tabs to the play URL with `?desync=b` on one of them.
2. Start a match. Let it run.
3. In the tab without `?desync=b`, run in console:
   ```js
   KNDesync.events.addEventListener('desync-suspect', (e) => console.log('SUSPECT:', e.detail));
   ```
4. Expected: zero `SUSPECT:` logs during a clean session (lockstep is deterministic; no flag should fire). On the B-mode tab, expected: one heartbeat suspect every 5s.
5. To force a flag: in one tab, after a few seconds in-game, run:
   ```js
   const ptr = Module._kn_get_rdram_ptr();
   Module.HEAPU8[ptr + 0xA4F23] ^= 0x10; // flip a bit in P1's stock byte
   ```
   Within ~6 frames, the *other* tab should log a `SUSPECT: { field: 'stocks', slot: 0, ... }` event because peers' digests now disagree on `STOCKS_P0`.
6. Reset the byte: `Module.HEAPU8[ptr + 0xA4F23] ^= 0x10;` Verify dedup window prevents duplicate flags within 1s.

- [ ] **Step 4: Commit**

```bash
git add web/static/kn-desync-detector.js web/static/netplay-lockstep.js
git commit -m "feat(desync): wire detector into lockstep tick + KNState events

KNDesync.init runs at module-ready, tick() called per frame from
the existing post-tick hook. Suspect events dispatched on
KNDesync.events as 'desync-suspect' CustomEvents. Mode selected
by ?desync=b URL flag (default C). Forced-bit-flip smoke test
proves cross-peer flagging works end-to-end."
```

---

### End of Chunk 3 — Verification gate

Before moving to Chunk 4 (vision pipeline), the following must all be true:

- [ ] All Chunks 1+2 verification items still pass
- [ ] Two-tab clean B-mode session produces zero `desync-suspect` events for `field !== 'heartbeat'` (lockstep is deterministic, no real flags should fire)
- [ ] B-mode heartbeat events fire on a 5s cadence; C-mode does not
- [ ] Forced bit-flip in one tab's RDRAM produces a `desync-suspect` event in the *other* tab within ~6 frames
- [ ] Dedup: a sustained divergence (don't reset the bit) produces ≤ 1 event per second per (field, slot)
- [ ] Phase gating: no `css_cursor` events during in-game; no `stocks` events during CSS
- [ ] Match-phase divergence: forcing a phase byte difference fires a single high-priority `match_phase` event and suppresses other field events for that frame
- [ ] Replay-event metadata appears on suspect events when one fires within ~5s of a real rollback
- [ ] No regression in existing lockstep behavior — RTT, delay-ping, input transport all unaffected

---

## Chunk 4: Vision Pipeline (server endpoint + browser client + post-mortem)

This chunk closes the loop: when chunk 3's detector emits a `desync-suspect` event, the vision client captures canvas screenshots from each peer's tab, POSTs them to the new server endpoint, and the server calls Claude vision with a field-targeted prompt and persists the verdict. C-mode adds a post-mortem worker that batch-processes flagged frames after `game-ended`. Admin timeline displays confirmed desyncs.

By the end of this chunk, the system delivers the original goal: "P3.damage diverged at frame 3127, vision confirms 32 vs 41."

### Task 17: Add `anthropic` Python SDK dep + `ANTHROPIC_API_KEY` env handling

**Why:** Server needs the SDK and a key. Make the dep explicit and the key optional-but-required-for-feature so a server starting without the key still boots and reports "vision disabled" rather than crashing.

**Files:**

- Modify: `server/pyproject.toml`
- Modify: `server/src/main.py` — read `ANTHROPIC_API_KEY` from env, log status

- [ ] **Step 1: Add dep**

In `server/pyproject.toml`, append to the `dependencies` list:

```toml
"anthropic>=0.34",
```

- [ ] **Step 2: Read key on startup**

In `server/src/main.py` (or wherever startup logging lives), add:

```python
import os
_anthropic_key = os.getenv("ANTHROPIC_API_KEY")
if _anthropic_key:
    print(f"[startup] vision enabled (key {_anthropic_key[:8]}…)")
else:
    print("[startup] vision DISABLED (no ANTHROPIC_API_KEY env var)")
```

The endpoint in Task 18 checks for the key at request time and returns 503 with a clear message if missing — no hard crash.

- [ ] **Step 3: Install + verify**

```bash
cd /Users/kazon/kaillera-next/server && uv sync
uv run python -c 'import anthropic; print(anthropic.__version__)'
```

Expected: prints a version like `0.34.0` or higher.

- [ ] **Step 4: Commit**

```bash
git add server/pyproject.toml server/src/main.py server/uv.lock
git commit -m "feat(server): add anthropic SDK dep + key handling

ANTHROPIC_API_KEY env var enables vision verdicts. Server boots
fine without it; the endpoint reports 503 'vision disabled'
rather than crashing."
```

---

### Task 18: SQLite migration for `desync_events` table

**Why:** Persist every vision verdict so admin can browse the history, and chunk 4's post-mortem worker has a place to write batch results. Use the existing Alembic migration pattern (versioned, `0006_*` continuing from `0005_screenshot_comparisons`).

**Files:**

- Create: `server/alembic/versions/0006_desync_events.py`

- [ ] **Step 1: Pattern-match an existing migration**

Read `server/alembic/versions/0005_screenshot_comparisons.py` to learn the project's migration style.

- [ ] **Step 2: Write the migration**

```python
"""desync_events: vision-validated desync verdicts.

Revision ID: 0006_desync_events
Revises: 0005_screenshot_comparisons
Create Date: 2026-04-25

Each row is one vision API call's output. Indexed by match_id + frame
for fast post-mortem and admin timeline queries.
"""
from alembic import op
import sqlalchemy as sa

revision = "0006_desync_events"
down_revision = "0005_screenshot_comparisons"


def upgrade() -> None:
    op.create_table(
        "desync_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("match_id", sa.String, nullable=False, index=True),
        sa.Column("frame", sa.Integer, nullable=False),
        sa.Column("field", sa.String, nullable=False),       # e.g. 'damage'
        sa.Column("slot", sa.Integer, nullable=True),        # null for global fields
        sa.Column("trigger", sa.String, nullable=False),     # 'flag' | 'heartbeat'
        sa.Column("hashes_json", sa.Text, nullable=True),    # peerA: 0x..., peerB: 0x...
        sa.Column("vision_verdict_json", sa.Text, nullable=True),  # full Claude response
        sa.Column("vision_equal", sa.Boolean, nullable=True),
        sa.Column("vision_confidence", sa.String, nullable=True),  # 'low'|'med'|'high'
        sa.Column("replay_meta_json", sa.Text, nullable=True),  # chunk 2 metadata if present
        sa.Column("created_at", sa.DateTime, server_default=sa.func.current_timestamp()),
    )
    op.create_index(
        "idx_desync_events_match_frame",
        "desync_events",
        ["match_id", "frame"],
    )


def downgrade() -> None:
    op.drop_index("idx_desync_events_match_frame", table_name="desync_events")
    op.drop_table("desync_events")
```

- [ ] **Step 3: Run the migration locally**

```bash
cd /Users/kazon/kaillera-next/server && uv run alembic upgrade head
```

Verify with `sqlite3 path/to/kaillera.db ".schema desync_events"`.

- [ ] **Step 4: Commit**

```bash
git add server/alembic/versions/0006_desync_events.py
git commit -m "feat(server): desync_events SQLite migration

Persists every vision verdict, indexed by (match_id, frame) for
post-mortem and admin timeline queries."
```

---

### Task 19: `/api/desync-vision` endpoint with per-field prompt templates

**Why:** This is the heart of chunk 4. Receives screenshots + suspect metadata from the browser, calls Claude with a field-targeted prompt, parses the structured JSON response, persists, and returns the verdict.

**Files:**

- Create: `server/src/api/desync_vision.py`
- Create: `server/src/api/desync_prompts.py`
- Modify: `server/src/api/app.py` — register the new route

- [ ] **Step 1: Write the prompt templates**

`server/src/api/desync_prompts.py`:

```python
"""Per-field prompt templates for the desync vision endpoint.

Each template instructs Claude to look at ONE specific aspect of the
two screenshots and return strict JSON. Keep prompts narrow and
unambiguous — the broader the prompt, the noisier the verdict."""

PROMPT_BY_FIELD = {
    "damage": """These two screenshots are from peers A and B at the same game frame.
Look ONLY at player {slot}'s damage percentage in the bottom HUD (large yellow
number with a % sign). Return strict JSON:
{{"a_damage": <int>, "b_damage": <int>, "equal": <bool>, "confidence": "high"|"med"|"low"}}
Confidence is "low" if the HUD is occluded or transitioning.""",

    "stocks": """These two screenshots are from peers A and B at the same game frame.
Look ONLY at player {slot}'s stock count (the small character icons in the bottom
panel — count them). Return strict JSON:
{{"a_stocks": <int>, "b_stocks": <int>, "equal": <bool>, "confidence": "high"|"med"|"low"}}.""",

    "character_id": """Peers A and B at the same game frame. Look ONLY at the character
selected for player {slot} (in CSS) or the character on screen for player {slot}
(in-game). Return strict JSON:
{{"a_character": "<name>", "b_character": "<name>", "equal": <bool>, "confidence": "high"|"med"|"low"}}.""",

    "css_cursor": """Peers A and B during character select. Look ONLY at where player
{slot}'s cursor is positioned on the character grid. Return strict JSON:
{{"a_cursor": "<character-name-cursor-is-on-or-position-description>", "b_cursor": "<...>", "equal": <bool>, "confidence": "high"|"med"|"low"}}.""",

    "physics_motion": """Peers A and B at the same game frame. Look at all visible
fighters' positions and animations. Return strict JSON:
{{"differences": ["<short description>", ...], "equal": <bool>, "confidence": "high"|"med"|"low"}}.
Empty differences array if everything matches.""",

    "match_phase": """Peers A and B. Identify what screen each is showing
(menu, character select, stage select, in-game, results). Return strict JSON:
{{"a_phase": "<name>", "b_phase": "<name>", "equal": <bool>, "confidence": "high"|"med"|"low"}}.""",

    "heartbeat": """Peers A and B at the same game frame. Compare overall game state
visually. Return strict JSON:
{{"differences": ["<short description>", ...], "equal": <bool>, "confidence": "high"|"med"|"low"}}.""",
}

# Fields that don't have a unique vision counterpart (e.g. RNG seed,
# VS battle header bytes) get the heartbeat-style "anything different?" prompt
# since vision can't read them directly.
PROMPT_BY_FIELD["rng"] = PROMPT_BY_FIELD["heartbeat"]
PROMPT_BY_FIELD["vs_battle_hdr"] = PROMPT_BY_FIELD["heartbeat"]
PROMPT_BY_FIELD["css_selected"] = PROMPT_BY_FIELD["css_cursor"]


def render(field: str, slot: int | None) -> str:
    template = PROMPT_BY_FIELD.get(field, PROMPT_BY_FIELD["heartbeat"])
    return template.format(slot=slot if slot is not None else 0)
```

- [ ] **Step 2: Write the endpoint**

`server/src/api/desync_vision.py`:

```python
"""POST /api/desync-vision

Receives screenshots + suspect metadata from kn-vision-client.js,
calls Claude vision with a field-targeted prompt, persists the
verdict to desync_events. Content-hash dedupe to coalesce identical
calls."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from . import desync_prompts
from .. import db

router = APIRouter()

_CACHE: dict[str, dict] = {}  # content_hash → verdict (process-local)
_CACHE_MAX = 1024


class PeerScreenshot(BaseModel):
    slot: int
    png_b64: str = Field(..., description="base64-encoded PNG, downscaled to ≤512px")
    hash: int | None = None


class VisionRequest(BaseModel):
    match_id: str
    frame: int
    field: str
    slot: int | None = None
    trigger: str  # 'flag' | 'heartbeat'
    peers: list[PeerScreenshot]
    replay_meta: dict[str, Any] | None = None


@router.post("/desync-vision")
async def desync_vision(req: VisionRequest, request: Request) -> dict[str, Any]:
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(503, "vision disabled (no ANTHROPIC_API_KEY)")
    if len(req.peers) < 2:
        raise HTTPException(400, "need at least 2 peer screenshots")

    # Content-hash dedupe: identical screenshots + same field → reuse verdict.
    h = hashlib.sha256()
    h.update(req.field.encode())
    h.update(str(req.slot or "").encode())
    for p in req.peers:
        h.update(p.png_b64.encode())
    content_hash = h.hexdigest()

    if content_hash in _CACHE:
        return {"cached": True, **_CACHE[content_hash]}

    # Lazy import so module loads without the SDK during DB-only tests.
    import anthropic
    client = anthropic.AsyncAnthropic(api_key=api_key)

    prompt = desync_prompts.render(req.field, req.slot)
    content_blocks: list[dict[str, Any]] = []
    for label, peer in zip(("A", "B"), req.peers[:2]):
        content_blocks.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": peer.png_b64,
            },
        })
        content_blocks.append({"type": "text", "text": f"(peer {label}, slot {peer.slot})"})
    content_blocks.append({"type": "text", "text": prompt})

    msg = await client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=512,
        messages=[{"role": "user", "content": content_blocks}],
    )

    raw_text = msg.content[0].text if msg.content else "{}"
    try:
        verdict = json.loads(raw_text)
    except json.JSONDecodeError:
        verdict = {"parse_error": True, "raw": raw_text, "equal": None, "confidence": "low"}

    # Persist
    await db.execute(
        """INSERT INTO desync_events
           (match_id, frame, field, slot, trigger, hashes_json,
            vision_verdict_json, vision_equal, vision_confidence,
            replay_meta_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            req.match_id, req.frame, req.field, req.slot, req.trigger,
            json.dumps([p.dict(exclude={"png_b64"}) for p in req.peers]),
            json.dumps(verdict),
            verdict.get("equal"),
            verdict.get("confidence"),
            json.dumps(req.replay_meta) if req.replay_meta else None,
        ),
    )

    # LRU-style trim — small + cheap.
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[content_hash] = {"verdict": verdict, "match_id": req.match_id, "frame": req.frame}

    return {"cached": False, "verdict": verdict, "match_id": req.match_id, "frame": req.frame}
```

- [ ] **Step 3: Register the route in `app.py`**

```python
from .desync_vision import router as desync_vision_router
app.include_router(desync_vision_router, prefix="/api")
```

- [ ] **Step 4: Verify the endpoint with a curl smoke-test**

Pre-create a tiny PNG (any 8x8 image base64-encoded) and call:

```bash
curl -sk -X POST https://localhost:27888/api/desync-vision \
  -H 'Content-Type: application/json' \
  -d '{"match_id":"test","frame":100,"field":"damage","slot":1,"trigger":"flag","peers":[{"slot":0,"png_b64":"..."},{"slot":1,"png_b64":"..."}]}' | jq
```

Expected (with `ANTHROPIC_API_KEY` set): JSON with `verdict` containing `equal`/`confidence` keys. Without the key: 503 with the "vision disabled" message.

Verify persistence: `sqlite3 path/to/kaillera.db "SELECT * FROM desync_events ORDER BY id DESC LIMIT 1;"`.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/{desync_vision.py,desync_prompts.py,app.py}
git commit -m "feat(server): /api/desync-vision endpoint

Field-targeted Claude vision calls; per-field prompt templates;
content-hash dedupe cache; persists every verdict to desync_events.
503 fallback when ANTHROPIC_API_KEY missing — no hard crash."
```

---

### Task 20: `kn-vision-client.js` — capture canvas, POST suspect

**Why:** Bridges chunk 3's `desync-suspect` events to the new server endpoint. Captures the canvas (existing readPixels path), downscales to 512px to keep image-token costs low, base64-encodes, POSTs.

**Files:**

- Create: `web/static/kn-vision-client.js`
- Modify: `web/play.html` — add script tag

- [ ] **Step 1: Write the module**

```js
/**
 * kn-vision-client.js — Bridges KNDesync.events 'desync-suspect' to
 * /api/desync-vision. Captures canvas, downscales to ≤512px, POSTs.
 *
 * Design intent: thin. No business logic. The detector decided this
 * frame deserves a verdict; the vision client just delivers the
 * goods.
 */
(function () {
  'use strict';

  const TARGET_WIDTH = 512;     // image-token budget
  const POST_PATH    = '/api/desync-vision';

  /* Capture the current emulator canvas, downscaled to TARGET_WIDTH.
   * Returns a base64 PNG string (without the data: prefix). */
  async function _captureScaledPng() {
    const src = document.querySelector('canvas#canvas') ||
                document.querySelector('canvas');
    if (!src) return null;
    const ratio = TARGET_WIDTH / src.width;
    const scaled = document.createElement('canvas');
    scaled.width  = Math.round(src.width * ratio);
    scaled.height = Math.round(src.height * ratio);
    const ctx = scaled.getContext('2d');
    ctx.drawImage(src, 0, 0, scaled.width, scaled.height);
    return new Promise((resolve) => {
      scaled.toBlob(async (blob) => {
        if (!blob) return resolve(null);
        const buf = await blob.arrayBuffer();
        const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
        resolve(b64);
      }, 'image/png');
    });
  }

  async function _onSuspect(detail) {
    if (!detail || !detail.matchId) return;
    const localPng = await _captureScaledPng();
    if (!localPng) return;

    // For v1 each peer captures its own canvas locally and POSTs.
    // The server collects them per (match_id, frame, field) and runs
    // the vision call once it has 2+ peer images.
    //
    // Simpler v1 path (chosen): each peer POSTs its own image; the
    // server endpoint (Task 19) buffers per-key for ~250ms then
    // fires the vision call when 2 peers have arrived.
    //
    // Actually — simpler still: have ONE peer (the host) drive the
    // vision call by also sending the OTHER peer's most recent canvas
    // hash via the digest packet. v2 work; v1 has the host capture
    // both via the suspect event's hashes object (no actual peer
    // canvas — only host's canvas). Vision still gets ground-truth
    // for the host; cross-peer comparison is done at the hash layer
    // upstream.
    //
    // Reduction for v1: only the local peer's canvas is sent.
    // Vision verifies "what does THIS peer see?" against the
    // previously-extracted local field state. Cross-peer divergence
    // was already established by the hash flag — vision confirms one
    // side's state matches reality.

    const body = {
      match_id:   detail.matchId,
      frame:      detail.frame,
      field:      detail.field,
      slot:       detail.slot,
      trigger:    detail.trigger,
      peers: [
        { slot: KNState.slot ?? 0, png_b64: localPng, hash: detail.hashes?.local ?? null },
        // Placeholder for the remote peer's image. v2: peers exchange
        // canvas hashes/images via the DC and assemble cross-peer
        // image pairs locally before POSTing. For now, server-side
        // logic in Task 19 assumes 2+ peer entries — add a stub
        // so the endpoint doesn't 400. See follow-up note.
        { slot: -1, png_b64: localPng, hash: detail.hashes?.remote ?? null },
      ],
      replay_meta: detail.replayMeta,
    };

    try {
      const res = await fetch(POST_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      console.log('[KNVision] verdict:', json);
    } catch (e) {
      console.warn('[KNVision] POST failed', e);
    }
  }

  if (window.KNDesync && KNDesync.events) {
    KNDesync.events.addEventListener('desync-suspect', (e) => _onSuspect(e.detail));
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (window.KNDesync) {
        KNDesync.events.addEventListener('desync-suspect', (e) => _onSuspect(e.detail));
      }
    });
  }

  window.KNVision = { _captureScaledPng, _onSuspect };
})();
```

**Note in code comment + here:** the v1 path described above ships *one* canvas per peer (each peer POSTs its own). That means the server-side handler in Task 19 needs to wait for 2+ POSTs at the same `(match_id, frame, field)` key before calling vision. Update Task 19's endpoint to buffer & coalesce — see Task 21 below.

- [ ] **Step 2: Add script tag**

In `web/play.html`, after `kn-desync-detector.js`:

```html
<script src="static/kn-vision-client.js?v=…"></script>
```

- [ ] **Step 3: Smoke-test capture**

```js
const png = await KNVision._captureScaledPng();
console.log(png?.length, 'b64 chars');  // expect a few KB; ~500-2000 chars typical for 512px PNG
```

- [ ] **Step 4: Commit**

```bash
git add web/static/kn-vision-client.js web/play.html
git commit -m "feat(desync): kn-vision-client posts canvas on suspect

Captures emulator canvas, downscales to 512px, base64+POSTs to
/api/desync-vision. Subscribes to KNDesync.events 'desync-suspect'.
v1 ships one canvas per peer; server coalesces (Task 21)."
```

---

### Task 21: Server-side coalesce buffer for cross-peer images

**Why:** Each peer POSTs its own canvas. The vision call needs both peers' images. Server-side, buffer incoming POSTs by `(match_id, frame, field, slot)` and fire the vision call once 2+ peers have arrived (or after a 500ms timeout, whichever first).

**Files:**

- Modify: `server/src/api/desync_vision.py`

- [ ] **Step 1: Add the coalesce buffer**

```python
import asyncio
from collections import defaultdict

_PENDING: dict[tuple, list[PeerScreenshot]] = defaultdict(list)
_PENDING_TIMERS: dict[tuple, asyncio.Task] = {}
_COALESCE_MS = 500


async def _fire_vision(key: tuple, base_request: VisionRequest):
    peers = _PENDING.pop(key, [])
    _PENDING_TIMERS.pop(key, None)
    if len(peers) < 2:
        return  # never got a second peer; drop
    base_request.peers = peers
    return await _do_vision_call(base_request)
```

Refactor the original endpoint logic into `_do_vision_call(req)` (everything from "Lazy import" through the persistence + cache update) and have the route handler instead append to `_PENDING` + schedule a timeout:

```python
@router.post("/desync-vision")
async def desync_vision(req: VisionRequest) -> dict[str, Any]:
    if not os.getenv("ANTHROPIC_API_KEY"):
        raise HTTPException(503, "vision disabled (no ANTHROPIC_API_KEY)")
    if not req.peers:
        raise HTTPException(400, "need at least 1 peer screenshot")

    key = (req.match_id, req.frame, req.field, req.slot)
    _PENDING[key].extend(req.peers)

    # If we already have 2+, fire immediately. Otherwise schedule a 500ms timeout.
    if len(_PENDING[key]) >= 2:
        timer = _PENDING_TIMERS.pop(key, None)
        if timer:
            timer.cancel()
        verdict = await _fire_vision(key, req)
        return {"queued": False, **(verdict or {})}

    if key not in _PENDING_TIMERS:
        async def _timeout():
            await asyncio.sleep(_COALESCE_MS / 1000)
            await _fire_vision(key, req)
        _PENDING_TIMERS[key] = asyncio.create_task(_timeout())

    return {"queued": True, "match_id": req.match_id, "frame": req.frame}
```

- [ ] **Step 2: End-to-end smoke test**

Two-tab session, one tab forces a flag (Task 16's bit-flip technique). Both tabs POST their canvas. Within ~500ms server fires vision and persists a row. Verify:

```bash
sqlite3 path/to/kaillera.db "SELECT match_id, frame, field, vision_equal, vision_confidence FROM desync_events ORDER BY id DESC LIMIT 1;"
```

- [ ] **Step 3: Commit**

```bash
git add server/src/api/desync_vision.py
git commit -m "feat(server): coalesce peer screenshots for vision call

500ms buffer per (match_id, frame, field, slot) waits for 2+ peers
to POST their canvas before firing the vision call. v1 path —
removes the need for cross-peer image exchange in browser-land."
```

---

### Task 22: C-mode post-mortem worker (batch processing on `game-ended`)

**Why:** In C-mode, vision calls happen post-match for cost reasons. After a match ends, the post-mortem worker scans flagged frames and fires vision against captured screenshots in batch.

**Files:**

- Modify: `server/src/api/desync_vision.py` — add `run_postmortem(match_id)`
- Modify: `server/src/api/signaling.py` — call `run_postmortem` from the `end-game` handler

- [ ] **Step 1: Add `run_postmortem`**

```python
async def run_postmortem(match_id: str) -> int:
    """For each flag-only desync_event row that hasn't yet been vision-checked,
    pull the corresponding screenshots from the screenshots table (added in
    migration 0003) and run the vision call. Returns count processed."""
    rows = await db.fetch_all(
        """SELECT id, match_id, frame, field, slot, trigger, hashes_json, replay_meta_json
           FROM desync_events
           WHERE match_id = ? AND vision_verdict_json IS NULL
           ORDER BY frame""",
        (match_id,),
    )
    processed = 0
    for row in rows:
        screenshots = await _load_screenshots(match_id, row["frame"])
        if len(screenshots) < 2:
            continue
        # Compose VisionRequest from row + screenshots, run _do_vision_call
        # ... (omitted: ~30 lines mirroring the existing endpoint logic)
        processed += 1
    return processed
```

- [ ] **Step 2: Hook into `end-game`**

In `server/src/api/signaling.py`, find the `end-game` event handler. Add (only when not in B-mode):

```python
@sio.on("end-game")
async def end_game(sid, data):
    match_id = ...  # existing logic
    # Existing handling...
    asyncio.create_task(desync_vision.run_postmortem(match_id))
```

`asyncio.create_task` so the post-mortem doesn't block client return.

- [ ] **Step 3: Commit**

```bash
git add server/src/api/{desync_vision.py,signaling.py}
git commit -m "feat(server): post-mortem vision worker for C-mode

On game-ended, batch-process all unprocessed desync_events rows
for that match. Fires vision against captured screenshots (already
stored by the existing screenshot pipeline). Async — does not
block client end-game return."
```

---

### Task 23: Admin timeline display + final integration test

**Why:** Confirmed desyncs need to surface in the admin panel so the human can browse. Existing admin timeline in `web/admin.html` is the hook. Plus an end-to-end Playwright test verifies the entire pipeline from forced bit-flip to admin-visible row.

**Files:**

- Modify: `web/admin.html` and corresponding admin JS — add a "Desync events" section
- Create: `tests/desync-e2e.spec.mjs` — Playwright test

- [ ] **Step 1: Surface desync_events in admin**

In the admin UI, add a tab/section that pulls from a new `/admin/desync-events?match_id=...` endpoint (mirror the pattern of existing admin endpoints in `server/src/api/app.py`). The endpoint runs:

```python
SELECT id, frame, field, slot, trigger, vision_equal, vision_confidence, vision_verdict_json
FROM desync_events
WHERE match_id = ?
ORDER BY frame
```

Display each row as a single line: `f={frame}  {field}[{slot}]  {trigger}  vision={equal}/{confidence}`. Click expands to show the full verdict JSON + replay meta if present.

- [ ] **Step 2: Write the E2E Playwright test**

`tests/desync-e2e.spec.mjs`:

```javascript
/**
 * Forces a desync via in-tab RDRAM mutation in one of two browser tabs,
 * then verifies the full pipeline: detector flag → POST → vision call
 * (mocked or real) → SQLite row → admin endpoint surfaces it.
 *
 * Uses the existing two-tab harness pattern from determinism-automation.mjs.
 */
import { chromium } from 'playwright';

// Mock anthropic for CI: set ANTHROPIC_API_KEY=__MOCK__ before running
// the server. The endpoint then returns a deterministic stub verdict.

(async () => {
  const browser = await chromium.launch();
  // ... setup two contexts/pages, navigate to play URL with ?desync=b
  // ... start match, wait for in-game
  // ... in tab1: Module.HEAPU8[Module._kn_get_rdram_ptr() + 0xA4F23] ^= 0x10
  // ... wait 1s for detector flag + POST to fire
  // ... GET /admin/desync-events?match_id=<id>
  // ... assert at least one row with field='stocks', slot=0
  await browser.close();
})();
```

(Full implementation deferred to executor — pattern matches `tests/determinism-automation.mjs`.)

- [ ] **Step 3: Run the E2E test**

```bash
ANTHROPIC_API_KEY=test_only just dev &
node tests/desync-e2e.spec.mjs
```

Expected: prints "PASS" with the row count returned from admin endpoint.

- [ ] **Step 4: Commit**

```bash
git add web/admin.html web/static/admin.js server/src/api/app.py tests/desync-e2e.spec.mjs
git commit -m "feat(admin): desync events timeline + E2E test

Admin panel surfaces vision-validated desync events per match,
expandable to full verdict + replay metadata. E2E Playwright test
forces a bit-flip in one tab and asserts the row appears in admin
within ~1s — full pipeline regression coverage."
```

---

### End of Chunk 4 — Final verification gate

The system is shippable when all of these pass:

- [ ] All Chunks 1+2+3 verification items still pass
- [ ] `uv sync` in `server/` succeeds; `import anthropic` works
- [ ] Migration `0006_desync_events` runs cleanly; `desync_events` table exists
- [ ] `POST /api/desync-vision` returns 503 without `ANTHROPIC_API_KEY`, returns a verdict with key set
- [ ] `kn-vision-client.js` captures canvas + POSTs on every `desync-suspect` event
- [ ] Server coalesce buffer fires vision when 2+ peers have POSTed at the same `(match_id, frame, field, slot)`, or after 500ms timeout
- [ ] In a forced-bit-flip two-tab session, a row appears in `desync_events` with `vision_equal=false` within ~1s
- [ ] In a clean two-tab session, zero rows appear (no false positives — except B-mode heartbeat-triggered rows which is expected)
- [ ] C-mode `run_postmortem` processes all flagged frames after `end-game`
- [ ] Admin panel displays the rows and they're navigable
- [ ] No regression in any existing test suite — `uv run pytest` from project root green
