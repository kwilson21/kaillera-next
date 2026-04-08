---
name: Rollback determinism investigation - 2026-04-07
date: 2026-04-07
status: root cause class isolated; specific source pending next match data
---

# Rollback determinism investigation

Forensic analysis of session logs from match `6e57be03` (sessions 752/753),
played on the post-revert WASM (no in-game snaps, region diff handlers
deployed but not yet verified active because the browser had not loaded
the latest WASM build).

## Top-line finding

**The match was bit-perfectly deterministic for 75 seconds (4499 frames)
on both peers, then diverged at frame ~4500-4799 and never recovered.**

Comparing C-PERF entries between host (session 752) and guest (session 753)
at every checkpoint frame:

| Frame | host game_hash | guest game_hash | match? |
|-------|---|---|---|
| 299   | ec42298       | ec42298       | ✓ |
| 599   | 77c2cd2b      | 77c2cd2b      | ✓ |
| ...   | (all matching) | ... | ✓ |
| 4499  | -3b154da2     | -3b154da2     | ✓ |
| **4799** | **-71e56071** | **-20a7d7bb** | **✗ first divergence** |
| 5099  | 224bf847      | 121e5112      | ✗ |
| ...   | (all diverging) | ... | ✗ |

Both `game_hash` (taint-filtered) and `full_hash` (everything) diverged
simultaneously. The hidden state fingerprint matched on every checkpoint
including the first divergence — so SoftFloat, RSP task lock, CP0
interrupt state, AI fifo state, and CP0 last_addr are NOT the divergence
source.

## Correlation with rollback events

C-REPLAY events (rollback frames):
```
1281, 2809, 4492, 5889, 5913, 5956, 6123, 6291, 6473, 8109, 8134, 8146,
10018, 10046, 10108, 10132, 10156
```

The first divergence (frame 4799) happened **312 frames after the
rollback at frame 4492**. Earlier rollbacks at frames 1281 and 2809 did
NOT introduce divergence — the game stayed bit-perfect through them.

Subsequent mismatches form clusters that align with rollback bursts:
- Rollback cluster 5889/5913/5956 → mismatches 5402, 5702, 6300
- Rollback cluster 6123/6291/6473 → mismatches 6300, 6599, 6600, 6905
- Rollback cluster 8109/8134/8146 → mismatches 8121, 8401, 8702
- Rollback cluster 10018/...10156 → mismatches 9603, 9901, 10203

**The divergence appears AFTER specific rollbacks. Some rollbacks are
"benign" (1281, 2809), others are "toxic" and introduce permanent state
divergence.**

## What is diverging

### RDRAM block divergence (most frequent)

Block diff diagnostic identified the following blocks as the most
frequently diverging across both peers:

| RDRAM block | RDRAM offset | Hits (host/guest) | Tainted? |
|---|---|---|---|
| blk7  | 0x70000-0x80000 | 3 / 6  | no |
| blk8  | 0x80000-0x90000 | 3 / 6  | no |
| blk9  | 0x90000-0xA0000 | 7 / 12 | no |
| blk11 | 0xB0000-0xC0000 | 3 / 4  | no |
| blk12 | 0xC0000-0xD0000 | 1 / 3  | no |
| blk25 | 0x190000-0x1A0000 | 0 / 2 | no |
| blk52 | 0x340000-0x350000 | 3 / 5 | **yes (already)** |

The clustering at offsets 0x70000-0xD0000 (~448 KB - 832 KB) is in the
**libultra OS / early game data region** — consistent with cycle-derived
non-determinism leaking into OS thread state.

### Byte-level divergence at RDRAM 0xB0000

At frame 5399, only **1 byte** differed in block 11:
```
host:  ... fcfffcfffcfffcff44 70 fcfffcfffcff ...
guest: ... fcfffcfffcfffcff38 70 fcfffcfffcff ...
                            ^^
                  RDRAM 0xB001E
```

A single byte difference (host=0x44, guest=0x38) is causing a 64 KB block
hash to mismatch. The surrounding region is filled with `0xFCFF` sentinel
values (likely an array of uninitialized message queue slots, signed -4).

At frame 4799, block 11 had **52 bytes** differing in a structured pattern
where every other byte was `0x78` (consistent high byte) and the low bytes
incremented in a sequence. This looks like an array of pointers or 16-bit
values where the high byte is constant. The host and guest had the same
pattern but **shifted** by ~0x14-0x24 — strongly suggesting one peer was
slightly ahead in some kind of counter or queue.

### Post-RDRAM divergence (less frequent but always present)

Mismatches at frames 5699 and 6299 reported `RB-DIFF NO block diffs` —
meaning the RDRAM matched but the savestate hash still differed. The
divergence in those cases must be in the post-RDRAM section (CPU GPRs,
PC, hi/lo, cp0 regs, cp1 regs, TLB entries, event queue, fb tracker).

## Hypothesis

**Class of bug: rollback restoration is non-deterministic.** After
`retro_unserialize`, the resulting state has tiny differences across
peers that compound over time. The differences are NOT in:

- SoftFloat (verified — hidden state matches)
- RSP HLE audio buffers (already tainted, excluded from hash)
- GLideN64 framebuffer copyback (already tainted)
- AI fifo state (covered by hidden state, matches)

The differences ARE in:

- libultra OS region of RDRAM (0x70000-0xD0000)
- Some additional RDRAM areas (0x190000, 0x340000)
- Post-RDRAM coprocessor / event queue state

The most likely root causes:

1. **`retro_unserialize` doesn't restore some state.** The mupen64plus
   savestate format may not capture some mutable runtime state — for
   example, the cached interpreter's translation cache, an audio mixer
   internal buffer, or a libultra scheduler state pointer not in the
   PUTDATA stream.
2. **Post-restore execution diverges due to JIT block differences.**
   The cached interpreter (or new dynarec) compiles MIPS instructions
   into x86/wasm at runtime. Block boundaries depend on cache state
   which is invalidated post-restore (we already call
   `invalidate_cached_code_hacktarux`). But the FIRST execution after
   restore may still produce slightly different cycle counts than the
   original execution.
3. **A static or global variable in mupen64plus is mutated during
   gameplay but not part of the savestate.** This is the most common
   class of "ghost state" bugs. Candidates: static buffers in fpu.c,
   audio plugin state, RSP HLE state, video plugin state.

## What we have already verified is NOT the cause

- ✗ SoftFloat FPU rounding mode / exception flags (matches across peers)
- ✗ RSP HLE audio output bytes (already tainted)
- ✗ GLideN64 framebuffer copyback (already tainted)
- ✗ AI fifo[0/1] duration/length (matches)
- ✗ CP0 interrupt unsafe state (matches)
- ✗ RSP task lock (matches)
- ✗ Cached interpreter blocks not invalidated (already invalidated post-restore)
- ✗ Network packet reordering / unreliable DC (using reliable DC after revert)
- ✗ The cascading-rollback failure mode from the v2 unreliable-DC bug
  (fixed by reverting to reliable transport)

## What we need to find the actual source

**A single match where the new WASM exports are loaded by the browser.**
The current diagnostic produces `RB-REGION-DIFF rdramOff=0x0 stateSize=0
regionSize=0` because `_kn_get_state_buffer_size` and
`_kn_get_rdram_offset_in_state` are not in the WASM the browser loaded.

The new WASM (sha256 `a37e698b...`, deployed at 14:28) DOES contain
these exports — verified by extracting the JS glue. Once the browser
loads it, the next match's `RB-REGION-DIFF` lines will include real
byte offsets and the `RB-REGION-BYTES` dumps will hex-print the actual
diverging bytes from the savestate buffer.

## Cache busting fix

Diagnosis of WHY the previous matches weren't picking up new JS or WASM:
the existing `CacheBustMiddleware` ([app.py:288](server/src/api/app.py#L288))
uses `?v=<git-hash>` from `git rev-parse HEAD`, computed once at server
startup. Hot-edited files in dev (after my JS changes) don't change the
git hash, so the URL stayed `?v=439efa7` and browsers served from cache.

**Fix shipped:** new `_asset_version()` combines `git HEAD` with a
per-request mtime signature of all `.js`/`.css`/`.html`/`.json` files
in `web/static/`. The cache key changes immediately on any edit. The
middleware now takes a `version_fn` callback so it recomputes per
HTML response, no server restart required for future edits.

**One-time server restart needed** for this change itself to load
(the change is in `server/src/api/app.py` which the running uvicorn
won't auto-reload until it restarts).

## Reverts shipped (no in-game snaps)

Per user request — "rollback with good determinism beats mid-game
resyncs every time":

- **RB-CHECK MISMATCH** is now log-only. Previously triggered an
  authoritative resync after streak=3 with cap=2 per match. Reverted
  to pure logging — the diagnostic still fires, the data still uploads,
  but no in-game snap.
- **`failed_rollbacks` counter** is also log-only. Same rationale.

## Next steps when user returns

1. **Restart the dev server** so the new `app.py` cache-bust loads.
2. **Hard-refresh both browser tabs** to ensure they pick up the new
   WASM (`?h=<new-hash>` will be different so the auto-discovery
   endpoint forces a refetch anyway, but good practice).
3. **Play another match** — even a short one (5 minutes) is enough.
   The new WASM will produce real `RB-REGION-DIFF` lines with proper
   byte offsets and `RB-REGION-BYTES` dumps.
4. **Pull the session logs** and use the byte-level dump to map the
   diverging bytes to a specific struct field in the savestate format.
   The savestate format is in
   `mupen64plus-libretro-nx/mupen64plus-core/src/main/savestates.c`,
   the `savestates_save_m64p` function around line 1673.
5. **Decide fix strategy:**
   - If divergence is in **OS/libultra RDRAM** that's never read by
     game logic → taint that range, ship.
   - If divergence is in **CPU GPRs / PC / hi/lo** → real desync,
     find the missing-state bug and fix it.
   - If divergence is in **cp0 COUNT / event queue** → cycle-derived,
     either taint or force a deterministic cycle counter reset.
   - If divergence is in **TLB or fb tracker** → check if those bytes
     affect game-visible state.

## Alternative fix (if root-cause hunt is too painful)

**Disable rollback for the contested areas of the game.** Rollback works
during pure-input phases (movement, attacks) but should be disabled (fall
back to lockstep) during state-transition events (KO animations, item
spawns, stage transitions). This sidesteps the determinism gap by only
predicting during phases where the simulation is most predictable.

This would require a "game phase detector" reading SSB64-specific RDRAM
addresses to know when we're in a high-risk phase. Considerable work.
Reasonable v2.

## Files changed in this session

- `web/static/netplay-lockstep.js`: revert RB-CHECK and P4 to log-only;
  add `rb-regions:` receiver and 256-region diff handler with byte dumps;
  defensive RB-RING-NEAR-FULL warning; routing through `_pickInputDc`
- `build/kn_rollback/kn_rollback.c`: add `kn_state_region_hashes_frame`,
  `kn_get_rdram_offset_in_state`, `kn_get_state_buffer_size`; T1/T2
  misprediction breakdown; P3 preemptive replay
- `build/kn_rollback/kn_rollback.h`: header for new exports
- `build/build.sh`: add new exports to EXPORTED_FUNCTIONS sed line
- `server/src/api/app.py`: mtime-aware `_asset_version()`,
  `CacheBustMiddleware` takes `version_fn` callback
