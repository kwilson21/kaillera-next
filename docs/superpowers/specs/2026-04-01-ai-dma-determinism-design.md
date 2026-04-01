# AI DMA Determinism — Eliminate Cross-Platform Desync

## Problem

Cross-platform lockstep netplay (Chrome/Mac host + Safari/iPhone guest) experiences
RDRAM divergence that triggers unnecessary resyncs, FPS drops, and audio disruption.
User confirmed: when audio is off, the game runs perfectly deterministically. When
audio is on, game state diverges across multiple RDRAM regions.

## Root Cause

`ai_controller.c` line 103:

```c
unsigned int duration = get_dma_duration(ai) * ai->dma_modifier;
```

`dma_modifier` is `float` (set from `ROM_SETTINGS.aidmamodifier / 100.0`). This is
the only floating-point operation in the AI DMA timing path. The result determines
when `AI_INT` fires via `add_interrupt_event()`, which controls when the game's audio
interrupt handler runs.

ARM (Safari/iPhone) and x86 (Chrome/Mac) WASM JIT engines can produce different
float multiplication results (FMA vs separate mul+add, intermediate precision
differences). Even a 1-cycle difference in AI interrupt timing causes the game CPU
to take different code paths after the interrupt — cascading into player positions,
physics, and all game state.

## Evidence

- 222 session logs analyzed: 47% have zero desyncs, 29% have RDRAM anchor desyncs,
  17% have BLK25 desyncs
- Diverging regions span ph1c, ph1a, ph2, ph3a, ph3c — game state, not audio buffers
- User confirmed: audio off = zero desyncs across multiple sessions
- `dma_modifier` is the sole float in the AI timing path; `aidmamodifier` is stored
  as integer percentage (100 for SSB64)

## Fix

Replace the float multiplication with integer-only arithmetic.

### ai_controller.h

```c
// Before:
float dma_modifier;

// After:
unsigned int dma_modifier_pct;
```

Update `init_ai` signature to take `unsigned int dma_modifier_pct` instead of
`float dma_modifier`.

### ai_controller.c

```c
// Line 103 — before:
unsigned int duration = get_dma_duration(ai) * ai->dma_modifier;

// After:
unsigned int duration = (unsigned int)((uint64_t)get_dma_duration(ai) * ai->dma_modifier_pct / 100);
```

`uint64_t` prevents overflow (`get_dma_duration` result * 100 can exceed 32 bits).

Update `init_ai` to store `dma_modifier_pct` instead of `dma_modifier`.

### main.c

```c
// Line 1758 — before:
((float)ROM_SETTINGS.aidmamodifier / 100.0)

// After:
ROM_SETTINGS.aidmamodifier
```

### device.c / device.h

Update `init_device` signature: `float dma_modifier` → `unsigned int dma_modifier_pct`.
Pass through to `init_ai`.

## Impact

If this is the sole source of non-determinism (strongly suggested by the audio-off
evidence), then after this fix:

- Lockstep sessions produce zero RDRAM divergence in steady state
- The resync/desync detection system becomes unnecessary for normal gameplay
- Resyncs only needed for recovery events (reconnect, late join, visibility change)
- The `feat/resync-audio-fix` branch workarounds (visual checks, volatile profiling,
  audio fade, BLK25 filtering) can be discarded

## Testing

1. Build new WASM core with the patch
2. Play 2-3 full games cross-platform (Mac host + iPhone guest)
3. Check logs: zero RDRAM anchor desyncs + zero BLK25 desyncs = deterministic
4. Test reconnect (wifi to 5g switch) still resyncs correctly
