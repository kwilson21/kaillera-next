# Event Queue Determinism

**Date:** 2026-04-09
**Goal:** Eliminate cross-platform CP0 Count drift by normalizing the N64 event queue at frame boundaries, and add diagnostics to verify it.

## Problem

The N64 CP0 Count register increments per CPU cycle. The mupen64plus event queue stores interrupt trigger times as absolute CP0 Count values. Different WASM JIT engines (V8, JSC) execute MIPS instruction batches at slightly different cycle rates, causing CP0 Count to drift between peers. This causes:

- Event queue ordering to diverge (interrupts fire in different order)
- OS thread scheduling state to diverge (RDRAM 0x40000-0x5FFFF)
- Post-RDRAM coprocessor state to diverge after rollback restore

Current mitigations (taint blocks, post-RDRAM hash exclusion, fixed frame time) hide the divergence rather than fix it. The previous attempt (`kn_reset_cycle_count` calling `translate_event_queue(cp0, 0)`) corrupted state because it removed and re-added COMPARE_INT/SPECIAL_INT mid-flight with racy intermediate queue state.

## Design

### Part 1: Diagnostics

Two new read-only C exports in `main.c`:

**`kn_eventqueue_dump(uint32_t *out, uint32_t max_entries)`**
- Writes a header: `[CP0_COUNT, CP0_COMPARE, cycle_count, next_interrupt, num_entries]` (5 uint32s)
- Then for each queue entry: `[type, count, relative_offset]` (3 uint32s each, where `relative_offset = count - CP0_COUNT`)
- Returns total uint32s written
- Max 16 entries (pool capacity) + 5 header = 53 uint32s max

**`kn_eventqueue_hash()`**
- FNV-1a hash over each entry's `{type, relative_offset}` pair
- Relative offsets make the hash CP0-Count-independent
- Returns uint32 for cross-peer comparison

**JS integration:**
- Call `kn_eventqueue_hash()` at the same point `kn_sync_hash()` is called in the sync log
- Log alongside existing hash in `session-log` events
- Full `kn_eventqueue_dump()` available for debug-sync diagnostic uploads

### Part 2: Normalization

**`kn_normalize_event_queue()`**
1. Walk the queue, serialize each entry as `{type, relative_offset}` into a local array (max 16 entries). `relative_offset = entry.count - CP0_COUNT_REG`. Skip COMPARE_INT and SPECIAL_INT (will be recalculated).
2. `clear_queue(&cp0->q)` — wipe completely
3. Set `CP0_COUNT_REG = 0`
4. Re-add each saved entry with `add_interrupt_event_count(cp0, type, relative_offset)` (relative offset is now absolute count since COUNT=0)
5. Recalculate COMPARE_INT from `CP0_COMPARE_REG` using the `count_per_op` bump/unbump trick (same pattern as `translate_event_queue` lines 282-288): temporarily bump COUNT and cycle_count by `count_per_op`, add COMPARE_INT at `CP0_COMPARE_REG`, then unbump. This prevents ordering ambiguity when COUNT == COMPARE.
6. Place SPECIAL_INT at `0x80000000` (2^31 boundary from COUNT=0)
7. Update `last_addr` to current PC (prevents stale delta in next `cp0_update_count`)

**Precondition:** Normalization must run immediately after `cp0_update_count` has been called (i.e., at frame boundary after VI_INT processing), so `last_addr` already equals PC and no cycles are silently dropped.

**Why this is safer than `translate_event_queue`:**
- No remove-then-re-add of COMPARE/SPECIAL with intermediate queue state
- Full clear-and-rebuild means no partial modification bugs
- COMPARE derived from register, not from queue entry that may have drifted

**Runtime toggle:**
- `kn_set_normalize_events(int enable)` / `kn_get_normalize_events()`
- Default: off (0). Enabled via JS when netplay starts.
- Exported as WASM functions

**Call sites:**
- **Rollback mode:** In `setup_frame()` in `kn_rollback.c`, after `kn_set_frame_time()`, before `retro_run()`
- **Classic lockstep:** Called by JS in `stepOneFrame()` at the same point `kn_set_frame_time()` is called

### WASM exports to add

```
_kn_eventqueue_dump
_kn_eventqueue_hash
_kn_normalize_event_queue
_kn_set_normalize_events
_kn_get_normalize_events
```

Added to the exported functions list in `retroarch-deterministic-timing.patch`.

## Files changed

| File | Change |
|------|--------|
| `build/patches/mupen64plus-kn-all.patch` | Add `kn_eventqueue_dump`, `kn_eventqueue_hash`, `kn_normalize_event_queue`, toggle functions to `main.c` |
| `build/patches/retroarch-deterministic-timing.patch` | Add new exports to EXPORTED_FUNCTIONS |
| `build/src/.../kn_rollback.c` | Call `kn_normalize_event_queue()` in `setup_frame()` when flag is set |
| `web/static/netplay-lockstep.js` | Call normalize export in `stepOneFrame()` for classic lockstep; log eventqueue hash in sync log |

## Risks

- **Event queue corruption:** The main risk. Mitigated by clear-and-rebuild (no partial state), guarded by runtime flag, and diagnostics available to verify before/after.
- **Performance:** Walking 16 entries and rebuilding is trivial (~microseconds). No concern.
- **COMPARE timing edge case:** Handled by the `count_per_op` bump/unbump trick (step 5), same as `translate_event_queue`.
- **State save/load interaction:** `save_eventqueue_infos` serializes absolute counts. Post-normalization saves will have COUNT=0-based entries. This is fine because `load_eventqueue_infos` does clear-and-rebuild anyway, and the loaded COUNT register value is consistent with the saved queue. In rollback mode, saves happen every frame post-normalization — the host and guest both see COUNT=0-based state.
- **Rollback replay COMPARE drift:** Repeated normalization applies the `count_per_op` bump/unbump each frame, which could shift COMPARE timing by a few cycles cumulatively. Monitor via diagnostics to confirm this doesn't cause visible divergence.

## Verification

1. Enable diagnostics, run two same-platform peers, verify `kn_eventqueue_hash()` matches every frame
2. Enable normalization, run two cross-platform peers (Chrome + Safari), compare eventqueue hashes
3. Check that existing taint blocks can be removed (or narrowed) once normalization is working
4. Replay self-test (`knDiag.replaySelfTest`) must still pass with normalization enabled
