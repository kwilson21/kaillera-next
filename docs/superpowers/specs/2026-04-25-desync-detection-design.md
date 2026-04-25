# Desync Detection — Design

**Date:** 2026-04-25
**Status:** Design (pre-implementation)

## Goal

Trustworthy answers to "did the peers diverge, when, and on what?" — replacing today's flaky-hash signals with a system whose verdict you can act on.

Concretely:

- **Iteration loop (B-mode, test):** within seconds of a desync occurring in an automated test run, surface "player 3's damage diverged at frame 3127; vision confirms peer A reads 32 and peer B reads 41."
- **Production (C-mode):** after a match ends, admin timeline shows vision-validated desync events with field, frame, and player pinpointed — so user reports become diagnosable instead of guesswork.
- **Long-tail:** the data shape (field-pinpointed + visually confirmed + frame-precise) makes downstream rollback debugging tractable without bundling a replay tool into this scope.

## Problem

The current detection stack has two failure modes:

1. **Hash unreliability.** `kn_gameplay_hash` previously sampled the wrong `SCBattleState` (Transfer-scratch at `0xA4D08` instead of VS at `0xA4EF8`) and the wrong stock offset (`0x2B` vs `0xB`). Field-blind hashing makes this class of bug invisible until a wrong divergence is acted on. Memory `project_gameplay_hash_wrong_addrs` is the cautionary record.
2. **Visual-vs-state coupling gap.** SSIM agrees while game state has drifted (memory `feedback_visual_over_rdram`), and hashes can agree while pre-state UI like CSS cursors has already produced different selections (memory `project_css_cursor_desync_critical`). Neither signal alone is reliable.

User directive (memory `feedback_ssim_useless_use_vision`, 2026-04-25): use vision-model comparison on screenshots, not SSIM, and not hashes alone.

This design replaces the existing single hash signal with a **trustworthy hash trigger + vision verdict** pipeline.

## Architecture

```
[Browser per peer]
  WASM core
    ├─ kn_hash_<field>(player, frame)   ← field-granular C exports, decomp-cited
    └─ gameplay_addrs.h                  ← extracted from existing kn_gameplay_addrs[]
                                            (build/kn_rollback/kn_rollback.c:1136),
                                            now the single address source for both
                                            the rollback engine and the hash registry

  netplay tick (per frame)
    ├─ build digest = { field_id → hash } via the C exports
    ├─ append to history_ring[600 frames]
    └─ broadcast digest over existing WebRTC DC every K frames

  kn-desync-detector.js (NEW module)
    ├─ bucketize peer digests by frame_id
    ├─ compare (pairwise in B, host-auth in C)
    └─ emit `desync-suspect` events on flag (always) or heartbeat (B only)

  kn-vision-client.js (NEW module)
    └─ on suspect event: capture canvas, POST to /api/desync-vision

[Server]
  /api/desync-vision  (NEW FastAPI endpoint)
    ├─ Claude API call, prompt templated by suspect.field
    ├─ structured JSON response
    ├─ persist to SQLite `desync_events`
    └─ broadcast to admin timeline (existing pipeline)

  desync_postmortem  (NEW worker, C-mode prod only)
    └─ on game-ended: batch-process flagged frames against captured screenshots
```

Five new pieces: a C-level hash registry, two browser modules, one HTTP endpoint, one server-side worker, plus one SQLite table. Everything else is reuse — existing WebRTC DataChannel for digest transport, existing canvas screenshot capture (`kn-diagnostics.js`), existing admin timeline, existing `session-log` event schema.

Vision calls live server-side: API key stays out of the browser, identical-payload calls dedupe at the cache layer, and C-mode batch processing is straightforward.

## The hash registry — the "done correctly" foundation

If the hashes lie, the detector is decoration. Three rules make wrong-address bugs blow up loudly instead of silently:

**1. One C export per logical field, with mandatory decomp citation:**

```c
/* kn_hash_damage
 * Source: SCBattleState.player[i].damage  (decomp: src/battle/state.c:142)
 * Address: gameplay_addrs.battle_state + 0x18*i + 0xC  (4 bytes, float32)
 * Sampling: kn_post_tick hook (post-physics, pre-render)
 */
uint32_t kn_hash_damage(uint8_t player_idx, int32_t frame);
```

A build-time check (`scripts/check-hash-citations.sh`) greps every `kn_hash_*` declaration and fails CI without a citation block. PR review has a concrete artifact to verify against.

**2. Field set, scoped to v1:**

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

*Per-player damage/position/velocity/action_state deferred to v2 — SSB64 fighters are pooled GObjs with no fixed RDRAM address (`build/kn_rollback/kn_rollback.c:1158-1163`). `physics_motion` is the v1 substitute (cross-JIT desyncs hit it first per `project_cross_jit_hunt_apr24`). Vision extracts per-player physics from screenshots when `physics_motion` flags.*

Out of scope for v1: shield, hitstun/blockstun, item state, camera. Add later via the same registry rules — citation, single sampling hook, golden test.

**3. One hash function, one sampling hook:**

- Hash function: `xxhash64` over the raw byte slice. No per-field cleverness, no float-as-float comparisons (SoftFloat means byte-equal is the right test).
- Sampling hook: all hashes sampled at `kn_post_tick`, after physics, before render. No per-export hook customization — that variation is what let the previous `gameplay_addrs` bug hide.

**4. Golden-file correctness tests:**

A small fixture set of known savestates with hand-labeled field values. Tests assert `kn_hash_damage(player, frame)` produces expected bytes. A wrong address regresses these tests immediately — long before a match ever runs.

## Rollback diagnostics

**Added 2026-04-25 after live finding that rollbacks/replays are the proximate cause of desyncs.** The registry captures three additional pieces of state per replay event, on each peer locally:

- **`pre_replay_hashes[field]`** — every field's hash at the moment the rollback engine schedules a replay. The "what state did we have *before* restoring?" snapshot.
- **`post_replay_hashes[field]`** — every field's hash when `replay_remaining` hits 0. The "what state did the replay produce?" snapshot.
- **`replay_ring[field][replay_offset]`** — every replayed frame's field hashes, indexed by replay-relative offset. Cleared at each replay enter, capped at `KN_MAX_REPLAY_FRAMES` (~64).

Cross-peer comparison through the same digest channel surfaces:

- "rollback at frame 3127 corrupted `physics_motion` on guest but not on host" (pre/post delta diff)
- "frame +12 of the replay is where the divergence appeared" (trajectory comparison)

**Determinism note:** all three are recorded per-peer locally. Each peer records what *its own* replay produced; cross-peer divergence in those recordings is the diagnostic signal. No assumption that a replay re-run on another device would produce the same trajectory — that's the trap memory `feedback_replay_dead_end` warns against, and we don't go there.

## History rings — frame-precise root cause without replay

Each peer keeps a 600-entry C-side ring buffer (~10s at 60fps) of all field hashes per frame.

```c
// Returns up to `count` (frame, hash) pairs ending at the most recent entry.
// Caller passes a Uint32Array of size 2*count; C fills it.
// Empty slots are zero-filled when ring isn't full yet.
size_t kn_hash_history_<field>(uint8_t player_idx, uint32_t count,
                               uint32_t* out_pairs);
```

JS reads up to `count` recent (frame, hash) pairs in a single call — no per-`n` round-tripping into the WASM module. The detector compares the local pair list against the peer's pair list (received in the digest packet alongside current-frame hashes once a flag fires) and walks backwards to find the first frame where they agreed. That's the divergence boundary.

This gives "position diverged starting at frame 3104, damage followed at 3127" without needing replay-based bisection. Memory `feedback_replay_dead_end` warns that replay convergence cross-device is itself unproven; building detection on it would couple the detector to the very property desyncs violate.

## Vision call shape

Vision is **the verdict, not a fused signal.** Hashes flag suspect; vision decides truth. No "combined score" — that's where false positives breed.

Suspect events trigger one server call per `(frame, field)` flag:

```js
KNState.emit('desync-suspect', {
  matchId, frame, field, slot,
  hashes: { peerA: 0xab12, peerB: 0xcd34 },
  trigger: 'flag' | 'heartbeat',
  matchPhase: 'in-game'
});
```

`kn-vision-client.js` captures the current canvas (existing `readPixels` path) and POSTs `{frame, field, peers: [{slot, png_b64, hash}]}` to `/api/desync-vision`.

The server picks a prompt template by `field`. Field-targeted prompts are cheap and unambiguous:

> *(damage prompt)* "These two screenshots are from peers A and B at the same game frame. Look only at player 3's damage percentage in the bottom HUD (large yellow number). Return JSON: `{a_damage: int, b_damage: int, equal: bool, confidence: 'high'|'med'|'low'}`."

Heartbeat prompts ask one broader question covering damage/stocks/position/css for the same frame — used only in B-mode when no flag has fired and we want to catch hash blind spots (e.g. CSS cursor offsets that haven't yet produced an RDRAM-visible difference).

A confirmed desync = vision returns `equal: false` with `confidence ≥ med`. Below that threshold, the event is logged as "hash-flagged, vision-inconclusive" — still useful, but not auto-acted-upon.

## B-mode vs C-mode

|                     | B-mode (test/dev)              | C-mode (prod)                            |
|---------------------|--------------------------------|------------------------------------------|
| Comparison rule     | Pairwise (find the outlier)    | Host-authoritative (saves bandwidth)     |
| Digest cadence      | Every frame (K=1)              | Every 6 frames (~10Hz)                   |
| Vision trigger      | Hash flag + heartbeat (5s)     | Hash flag only                           |
| Vision timing       | Real-time during match         | Real-time-eligible, post-match for batch |
| Output target       | CLI test runner + admin panel  | Admin timeline                           |

Mode is selected by URL flag / settings (`?desync=b` for tests). Same code path, different policy.

## What this explicitly does not do

- **No auto-recovery.** Per project invariants (CLAUDE.md, `docs/netplay-invariants.md`): no mid-match auto-resync triggered by detection. Detection is detection. Fix the root cause.
- **No fused hash+vision score.** Hashes flag, vision decides. A scalar "desync confidence" mixing both signals would obscure exactly what we're trying to make crisp.
- **No "close enough" hash tolerance.** Bit-equal or it's a flag. Tolerance windows hide real bugs.
- **No replay-based root-cause tool in v1.** History rings give frame-precision without it. Replay tool tracked as future work; do not build until the core detector has been used on real bugs.
- **No new transport.** Reuses the WebRTC DataChannel lockstep already opens. No second connection.
- **No retry on missed digests.** Next frame's digest covers it.
- **No JS-side hashing.** All hashing is C-side via the registry. JS only transports digests and runs comparisons. Mirroring hash logic in JS would re-create the very correctness problem the C-side citation rule is solving.

## Open knobs

These are the calibration points most likely to need adjustment from real-run data:

- **Digest cadence K** (B=1, C=6 proposed) — bandwidth vs detection latency.
- **Heartbeat interval** (5s proposed in B-mode) — vision API cost vs blind-spot coverage.
- **Flag dedup window** (60 frames / 1s proposed) — once a field diverges, suppress repeat flags for the same `(field, slot)` for this many frames; emit one "still diverged" annotation when window closes.
- **History ring depth** (600 frames / 10s proposed) — RAM per peer vs root-cause reach.
- **Vision confidence threshold** (`med`+ for confirmed, `low` logged inconclusive) — false positive vs false negative balance.

All five live in one config block in `kn-desync-detector.js`; tunable without architectural change.

## Risks

- **Vision API rate limits, transient failures, and cost.** Mitigation: server-side cache by content hash; fall back to "hash-flagged, vision-unavailable" event so the test still produces useful output. Cost is *upper-bounded* not point-estimated: a 60s B-mode match with the proposed 5s heartbeat fires 12 heartbeat calls per peer-pair. At ~1.6k input tokens per ~1MP image × 2 images × 12 calls + prompt + output, that's ~40k input tokens at Sonnet ($3/M input) ≈ $0.12/match before any flag-triggered calls and before cache hits. C-mode prod is ceilinged separately by flag-dedup (60-frame window per `(field, slot)`) and post-match batch coalescing; pin actual cost during implementation by sending downscaled (e.g. 512px) screenshots when full resolution isn't needed for the field's question.
- **Frame-id alignment across peers.** Lockstep delay buffering means digests for "the same frame" may arrive at slightly different wall-clocks. Mitigation: detector buckets by `frame_id`, drops digests outside `±history_window`. Phantom flags from cross-frame comparison are eliminated by construction.
- **Address regressions in future field additions.** Mitigation: every new `kn_hash_*` requires citation block + golden test. CI enforces.
- **Match-phase transitions.** Damage divergence during the menu phase is meaningless; CSS divergence in-game is meaningless. Mitigation: `match_phase` is itself a hashed field and gates which other fields are eligible. **Gating rule:** when peers disagree on `match_phase` itself, that becomes a single high-priority `match_phase` flag and *all other field comparisons for that frame are suppressed* — they have no defined meaning across mismatched phases. Per-field comparisons resume once peers' `match_phase` re-converges. Mismatches *of* `match_phase` are themselves high-priority flags ("we're not even in the same screen").

## Future work

- **Rollback-replay debug tool** — replay from `last_known_good_frame` using captured input log, walking forward step-by-step. Decoupled from this scope; build once the core detector has surfaced real rollback bugs and we know what shape the tool should take.
- **Field set expansion** — shield/hitstun/blockstun, camera, item state. Same registry rules apply.
- **Cross-platform engine validation** — golden hashes generated on macOS verified bit-equal on iOS/Android via a CI job. Catches platform-specific regressions before they reach players.
