# Proportional Frame Pacing — Design Spec

**Date:** 2026-04-04
**Status:** Design approved
**Supersedes:** Binary FRAME-CAP in `2026-03-25-frame-pacing-design.md` (skip logic only — EMA tracker, warmup, diagnostics remain)
**Phase:** 1 of 2 (Competitive mode — symmetric pacing)

## Problem Statement

4-player lockstep on heterogeneous devices (Mac host + mobile guests) runs at 31-35fps.
The binary FRAME-CAP (shipped in v0.23.0) skips the entire tick when `_frameAdvRaw >= DELAY_FRAMES + 1`.
With `DELAY_FRAMES=2`, the cap triggers at 3 frames ahead — and in 4-player sessions,
the host hits this threshold ~50% of ticks.

Evidence from PACING logs: `capsFrames=665` out of 300 frames (>50% of ticks capped).

The binary behavior creates a "stoplight" pattern:
- Host runs at 60fps → gets 3 frames ahead → full stop (0fps)
- Peers catch up → green light → 60fps again
- Repeat dozens of times per second

The rapid oscillation between 60fps and 0fps produces an effective 31-35fps with
constant visible stuttering. Players experience jarring frame timing that disrupts
muscle memory in fighting games.

## Solution: Proportional Tick Skipping

Replace the binary gate with a graduated "speed limit" that slows the host
proportionally to how far ahead it is, instead of slamming the brakes.

### Analogy

Think of the current system as a **stoplight** — green (60fps) or red (0fps), nothing
in between. The new system is a **speed limit** — the further ahead you are, the slower
you're asked to drive, but you're always moving.

- 3 frames ahead → slow to 45mph (skip 1 of 4 ticks)
- 4 frames ahead → slow to 30mph (skip 1 of 2 ticks)
- 5 frames ahead → slow to 15mph (skip 3 of 4 ticks)
- 6+ frames ahead → full stop (safety floor, same as today)

In the typical 4-player scenario (host 3 frames ahead), the host runs at ~45fps
instead of oscillating between 60 and 0. The frame timing is consistent, which is
what fighting game muscle memory depends on.

## Design

### 1. Skip Ratio Ramp

Replace the binary skip at line ~4014 of `netplay-lockstep.js`:

```javascript
// CURRENT (binary) — full block including stats and logging:
if (_frameAdvRaw >= DELAY_FRAMES + 1) {
  _pacingCapsFrames++;
  if (!_framePacingActive) {
    _framePacingActive = true;
    _pacingCapsCount++;
    _syncLog(`FRAME-CAP start fAdv=${_frameAdvRaw} ...`);
  }
  return;
}
if (_framePacingActive) {
  _framePacingActive = false;
  _syncLog(`FRAME-CAP end ...`);
}

// NEW (proportional) — replaces the entire block above:
const excess = _frameAdvRaw - DELAY_FRAMES;
let shouldSkip = false;
if (excess >= 4) {
  shouldSkip = true; // safety floor: full stop at DELAY+4
} else if (excess >= 1) {
  _pacingSkipCounter++;
  const skip = SKIP_TABLE[excess]; // [null, [4,1], [2,1], [4,3]]
  shouldSkip = skip && (_pacingSkipCounter % skip[0]) < skip[1];
}
if (shouldSkip) {
  _pacingCapsFrames++;
  if (!_framePacingActive) {
    _framePacingActive = true;
    _pacingCapsCount++;
    const ratio = excess >= 4 ? '100%' : `${Math.round(SKIP_TABLE[excess][1] / SKIP_TABLE[excess][0] * 100)}%`;
    _syncLog(`PACING-THROTTLE start fAdv=${_frameAdvRaw} ratio=${ratio} delay=${DELAY_FRAMES} minRemote=${minRemoteFrame}`);
  }
  return;
}
if (_framePacingActive) {
  _framePacingActive = false;
  _syncLog(`PACING-THROTTLE end fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)}`);
}
```

**Skip table (indexed by excess = frameAdvRaw - DELAY_FRAMES):**

| Excess | Skip Pattern | Effective FPS | Modulo Logic |
|--------|-------------|---------------|--------------|
| 0 | None | 60 | No skip |
| 1 | 1 of 4 | ~45 | `counter % 4 < 1` |
| 2 | 1 of 2 | ~30 | `counter % 2 < 1` |
| 3 | 3 of 4 | ~15 | `counter % 4 < 3` |
| 4+ | All | 0 | Full stop |

The table is a constant array defined once. The modulo approach produces a regular
skip pattern (e.g., at 25%: skip-run-run-run-skip-run-run-run) rather than random
distribution, which gives more consistent frame timing.

**Threshold scaling with DELAY_FRAMES:**
- `DELAY_FRAMES=2` (LAN): full stop at 6 frames ahead
- `DELAY_FRAMES=5` (average): full stop at 9 frames ahead
- The 4-step ramp gives progressively more braking room at higher delays

### 2. New State

One addition:

```javascript
let _pacingSkipCounter = 0; // monotonic tick counter for modulo skip pattern
```

- Incremented only when `excess` is 1-3 (proportional range). NOT incremented during
  full stop (`excess >= 4`) or full speed (`excess <= 0`). When recovering from full
  stop, the pattern resumes from where it left off — this is fine since the modulo
  pattern has no "wrong" starting point
- Reset to 0 wherever existing pacing state (`_pacingCapsCount`, `_pacingCapsFrames`)
  is reset — currently `startLockstep()`, `stopSync()`, and `applySyncState()`
- 64-bit float precision: exact integers up to 2^53 = 4.8 billion years at 60fps

### 3. Logging Changes

**FRAME-CAP → PACING-THROTTLE:** Fully shown in the replacement code block above.
Ratio is derived from the skip table: `Math.round(skip[1]/skip[0]*100) + '%'`.
State transitions tracked the same way (log on start, log on end, not every tick).

**PACING summary (every 300 frames):** No format change. `capsFrames` now reflects
proportionally-skipped frames. The count will be higher than before (more frames
are skipped at lighter ratios) but the effective FPS will be much better.

**INPUT-LOG:** No change — already includes `fAdv` and `fAdvRaw`.

**Debug overlay:** No change — already shows `fps` which naturally reflects the throttle.

### 4. What Doesn't Change

- **DELAY_FRAMES negotiation** — still RTT-based, ceiling of all players, fixed for match duration
- **EMA frame advantage tracker** — asymmetric alpha (0.1 up / 0.2 down), warmup period
- **Phantom peer detection** — 5s dead timer, excluded from pacing
- **Input pipeline** — skipped ticks still don't send input (same as binary cap)
- **DataChannel protocol** — no new messages
- **Server** — no changes
- **Spectators** — not in pacing calculations

### 5. Interaction with Existing Systems

Same as the original frame pacing spec — INPUT-STALL remains as safety net,
resync/desync detection is independent, background tab return resets advantage,
spectators unaffected.

The proportional throttle is strictly less aggressive (or equal at excess 4+) than
the binary cap at the same frame advantage, so it can only improve or match existing
behavior.

**Phantom peer handling:** The existing phantom peer detection (lines 3990-4003)
and its `_framePacingActive = false` release remain unchanged. The proportional
replacement only modifies the skip decision block that follows the phantom check.
Note: the phantom release log (`'FRAME-CAP released — all peers phantom'`) should
also be renamed to `'PACING-THROTTLE released — all peers phantom'` for consistency.

## Phase 2: Casual Mode (Future)

Designed but not implemented in this phase:

- **Adaptive delay with hysteresis** — DELAY_FRAMES can change mid-match. Increase
  requires M consecutive high-RTT readings. Decrease requires N consecutive good
  readings. No oscillation.
- **Asymmetric per-peer pacing** — fast peers run ahead with proportional throttle
  (approach B from brainstorm). Per-peer tracking classifies peers into fast/slow
  groups (approach C). Throttle against slowest peer in fast group, not absolute min.
- **Unbounded with proportional throttle** — no hard cap in casual mode, proportional
  slowdown naturally converges.
- **Mode toggle** — user selects "Competitive" (this spec) or "Casual" (Phase 2) before
  match start. Competitive = fixed delay + symmetric. Casual = adaptive delay + asymmetric.

## Expected Impact

**4-player (Mac + 3 mobile), DELAY_FRAMES=2:**
- Current: host oscillates 60/0fps → effective 31-35fps, visible stutter
- New: host runs ~45fps steady (25% throttle at excess=1) → smooth, consistent
- Improvement: +10-15fps effective, dramatically better frame timing consistency

**2-player desktop-to-desktop:**
- No observable change — frame advantage rarely exceeds DELAY_FRAMES

**2-player desktop-to-mobile:**
- Marginal improvement — binary cap was already adequate for 2-player (lower
  cap frequency), but proportional throttle eliminates any remaining micro-stutter

## Files Modified

| File | Changes |
|---|---|
| `web/static/netplay-lockstep.js` | Replace binary skip with proportional skip table, add `_pacingSkipCounter`, update FRAME-CAP logs to PACING-THROTTLE |

## Testing Strategy

1. **4-player heterogeneous:** Mac host + 2-3 mobile guests. Play 5+ minutes.
   Check PACING logs show `capsFrames` spread across ratio tiers (mostly 25%).
   Confirm effective FPS ≥ 45. Compare against binary cap baseline.

2. **2-player desktop:** Confirm no regression. PACING-THROTTLE should rarely fire.

3. **Log analysis:** Verify `fAdv` stays bounded. Check that proportional skip
   produces regular frame timing (no clusters of consecutive skips at 25%).

4. **Edge case: all peers same speed.** Confirm zero throttle events.

5. **Edge case: one peer drops to 30fps.** Confirm throttle ramps progressively
   through 25% → 50% rather than jumping to full stop.

## Non-Goals

- Adaptive delay (Phase 2)
- Asymmetric pacing (Phase 2)
- Per-peer group tracking (Phase 2)
- Mode selection UI (Phase 2)
- Rollback netcode (separate architecture entirely)
