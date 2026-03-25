# Frame Advantage Pacing — Design Spec

**Date:** 2026-03-25
**Branch:** `feat/c-level-resync`
**Status:** Design approved, pending implementation
**Reference:** GGPO timesync — `pond3r/ggpo` `src/lib/ggpo/timesync.cpp`, `network/udp_proto.cpp`, `backends/p2p.cpp`

## Problem Statement

Desktop-to-mobile lockstep play suffers from a frame rate death spiral. The desktop
host runs at ~63fps while the mobile guest runs at ~61fps. With `DELAY_FRAMES=1`
(auto-negotiated from RTT), the host exhausts its 1-frame input buffer within ~500ms,
causing INPUT-STALL micro-pauses. These are initially brief (~16ms each), but after
~85 seconds the rate mismatch accumulates until stalls happen every 1-2 frames — the
game grinds to a near-complete halt and eventually the connection dies.

Evidence from test session logs (`logs/sync/sync-p0-VVNB77ZC-1774439838.log`):

| Phase | Frames between stalls | Effective FPS | Experience |
|---|---|---|---|
| f=0 - f=5000 | ~30 | ~60fps | Smooth |
| f=5000 - f=5070 | ~22 | ~50fps | Starting to degrade |
| f=5070 - f=5128 | ~2 | ~15fps | Severe lag |
| f=5128+ | 1-2 | ~5fps | Gridlock → DC death |

## Solution: Frame Advantage Cap

Adapted from GGPO's `TimeSync` mechanism for delay-based lockstep (not rollback).

### Core Concept

**Frame advantage** = how far ahead the local player is relative to the slowest remote
peer's latest sent frame.

```
frame_advantage = _frameNum - min(_lastRemoteFramePerSlot[each input peer])
```

If the smoothed frame advantage exceeds a threshold, skip the tick — don't send input,
don't step the emulator. The remote peer's inputs keep arriving on the DataChannel, so
`_lastRemoteFramePerSlot` updates naturally. Once the advantage drops below the
threshold, ticking resumes. The faster machine converges to the slower machine's rate.

### GGPO Reference

GGPO's timesync works as follows (from source analysis):

1. Each side computes `_local_frame_advantage = remoteFrame - localFrame` (how far
   *behind* it is — counterintuitively named "advantage" because being behind means
   fewer mispredictions in rollback).
2. Each side sends its local advantage to the peer via `QualityReport` messages.
3. `TimeSync::recommend_frame_wait_duration()` averages both local and remote
   advantages over a 40-frame window, then recommends sleeping `(radvantage - advantage) / 2`
   frames — but only if both sides agree on who's ahead.
4. Constants: `MIN_FRAME_ADVANTAGE=3` (ignore small jitter), `MAX_FRAME_ADVANTAGE=9`
   (never sleep more than 9 frames), `RECOMMENDATION_INTERVAL=240` frames (~4s).
5. An idle input check avoids sleeping during complex input sequences (fireball motions).

### Adaptation for Delay-Based Lockstep

GGPO's bilateral reporting and consensus exist because rollback runs both sides
speculatively. In our delay-based lockstep, both sides *must* wait for remote input
before advancing — `_lastRemoteFramePerSlot` already gives a direct, unilateral measure
of frame advantage. No bilateral reporting needed.

**What we adopt from GGPO:**
- Smoothed averaging window (avoid reacting to instantaneous jitter)
- Graduated thresholds (ignore small differences, cap large ones)
- Warmup period (don't apply pacing during initial connection stabilization)

**What we simplify:**
- Unilateral cap instead of bilateral consensus (sufficient for lockstep)
- Advantage = `_frameNum - min(remoteFrames)` instead of GGPO's inverted convention
- No `QualityReport` messages needed — remote frame info already in input packets

## Design

### 1. Frame Advantage Tracker

Add a smoothed frame advantage tracker using an asymmetric EMA — slow to trigger
(avoids reacting to jitter), fast to release (avoids over-throttling during recovery):

```javascript
const FRAME_ADV_ALPHA_UP = 0.1;    // EMA when advantage is rising (slow to trigger)
const FRAME_ADV_ALPHA_DOWN = 0.2;  // EMA when advantage is falling (fast to release)
const FRAME_PACING_WARMUP = 120;   // skip pacing during first 120 frames (~2s boot)
let _frameAdvantage = 0;            // smoothed frame advantage (EMA)
let _frameAdvRaw = 0;               // instantaneous frame advantage (for logging)
let _framePacingActive = false;      // true when cap is throttling
```

**Insert point in `tick()`:** The frame pacing check goes at the very top of `tick()`,
after the `if (!_running) return` guard and the `_pendingResyncState` apply block
(lines 2528-2536), but BEFORE the FPS counter and input send (line 2540+). This
ensures that when we skip a tick, we don't send input (which would pile up on the
remote side) or step the emulator.

```javascript
// ── Frame pacing (GGPO-style frame advantage cap) ────────────
// Skip during warmup — connection is still stabilizing (GGPO uses
// RECOMMENDATION_INTERVAL=240; we use 120 which matches MIN_BOOT_FRAMES).
if (_frameNum >= FRAME_PACING_WARMUP) {
  const inputPeersForPacing = getInputPeers();
  if (inputPeersForPacing.length > 0) {
    let minRemoteFrame = Infinity;
    for (const p of inputPeersForPacing) {
      const rf = _lastRemoteFramePerSlot[p.slot] ?? -1;
      if (rf < minRemoteFrame) minRemoteFrame = rf;
    }
    if (minRemoteFrame >= 0) {
      _frameAdvRaw = _frameNum - minRemoteFrame;
      const alpha = _frameAdvRaw > _frameAdvantage ? FRAME_ADV_ALPHA_UP : FRAME_ADV_ALPHA_DOWN;
      _frameAdvantage = _frameAdvantage * (1 - alpha) + _frameAdvRaw * alpha;
    }
  }
}
```

The asymmetric EMA serves the same purpose as GGPO's 40-frame averaging window —
smooth out transient spikes so we only throttle on sustained drift — but releases
faster when the advantage drops to avoid unnecessary frame skipping after corrections.
Half-life: ~7 frames rising (slow to trigger), ~3 frames falling (fast to release).

### 2. Skip Logic

After computing the smoothed advantage (still inside the `_frameNum >= FRAME_PACING_WARMUP`
block):

```javascript
    if (_frameAdvantage > DELAY_FRAMES + 1) {
      // Too far ahead — skip this tick.
      // Don't send input (adds to pile remote can't consume).
      // Don't step emulator (diverges further).
      if (!_framePacingActive) {
        _framePacingActive = true;
        _syncLog(`FRAME-CAP start fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)} delay=${DELAY_FRAMES} minRemote=${minRemoteFrame}`);
      }
      return;
    }
    if (_framePacingActive) {
      _framePacingActive = false;
      _syncLog(`FRAME-CAP end fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)}`);
    }
```

**Threshold: `DELAY_FRAMES + 1`**

With `DELAY_FRAMES=2`:
- Advantage 0-2: normal (within buffer). No throttling.
- Advantage 3+: over budget. Skip ticks until it drops.

This maps to GGPO's `MIN_FRAME_ADVANTAGE=3` — coincidentally the same value. GGPO
uses 3 as a "not worth correcting" floor; we use it as the point where the delay
buffer is exhausted.

**Why not cap at exactly `DELAY_FRAMES`?** One frame of slack absorbs natural timer
jitter. Capping at exactly 2 would cause constant micro-throttling even when the
buffer isn't stressed. The +1 gives headroom for normal variance.

### 3. No Idle Input Check (GGPO Divergence)

GGPO's `require_idle_input` relaxes the cap during active input sequences (fireball
motions) to avoid interrupting combos. This makes sense for rollback where running
ahead just means more prediction — the remote side isn't affected.

**In delay-based lockstep, this relaxation is harmful.** If the fast player runs 9
frames ahead during a combo, the slow player must wait for those 9 inputs before
advancing — causing a visible freeze on the remote side during active gameplay. This
is exactly the opposite of what we want for fighting games.

The frame advantage cap is always `DELAY_FRAMES + 1`, regardless of input activity.
The 1-frame slack plus the asymmetric EMA smoothing provide enough headroom that
momentary jitter won't interrupt input sequences. A single skipped tick during active
input is a 16ms delay — indistinguishable from normal network jitter.

### 4. Minimum Delay Floor

Change the auto-delay calculation to enforce a minimum of 2:

```javascript
// Before:
const delay = Math.min(9, Math.max(1, Math.ceil(median / 16.67)));

// After:
const delay = Math.min(9, Math.max(2, Math.ceil(median / 16.67)));
```

With delay=2 on LAN (16ms RTT):
- 33ms input buffer (vs 16ms with delay=1)
- Added input lag: 16.67ms — imperceptible (human reaction: 150-250ms)
- Frame advantage cap has room to work (threshold becomes 3)

Note: This adds 16.67ms input lag to ALL sessions, including desktop-to-desktop on
LAN. For competitive SSB64, this is within acceptable bounds — original N64 hardware
had ~50ms of inherent input lag. If this becomes a concern, we could make the floor
conditional on detecting cross-device play, but that adds complexity for minimal gain.

### 5. Diagnostic Logging

**Extend INPUT-LOG** (every 60 frames) to include frame advantage:

```
INPUT-LOG f=1200 ... fps=63 fAdv=1.2 fAdvRaw=2
```

**FRAME-CAP events** (logged on state transitions only, not every skip):

```
FRAME-CAP start fAdv=4 smooth=3.2 delay=2 minRemote=1197
FRAME-CAP end fAdv=1 smooth=2.1
```

**Periodic pacing summary** (every 300 frames, ~5s):

```
PACING f=1800 avgAdv=1.4 maxAdv=3 capsCount=12 capsFrames=48
```

This tracks: average advantage over the window, peak advantage, number of cap events,
and total frames skipped.

### 6. Reset on Stop/Restart

Frame pacing state resets in both `stopSync()` and `startLockstep()` (matching the
pattern used by `_lastRemoteFramePerSlot`, which resets in both places):

```javascript
_frameAdvantage = 0;
_frameAdvRaw = 0;
_framePacingActive = false;
```

### 7. Interaction with Existing Systems

**INPUT-STALL:** Still fires as a safety net for genuine network hiccups (packet loss,
jitter spikes > 1 frame). With the frame advantage cap preventing rate-mismatch
stalls, INPUT-STALL should become rare — only triggered by actual network problems,
not by the faster machine outrunning the slower one.

**Resync / desync detection:** No interaction. Frame pacing is purely about tick
rate; desync detection compares game state hashes independently.

**Background tab return:** The existing fast-forward logic (line 2443) sets
`_frameNum = _lastRemoteFrame`. This resets the frame advantage to ~0, so the cap
won't trigger after returning from background.

**Spectators:** Not affected. Spectators have `slot === null`, aren't in
`getInputPeers()`, and aren't considered for pacing.

**3+ players:** `minRemoteFrame` takes the minimum across all input peers. All
players converge to the slowest player's rate. Correct for lockstep — everyone
must agree on every frame. Known limitation: if one of three players is on mobile,
all players experience the mobile player's frame rate. This is inherent to lockstep
and not a bug — the alternative (running ahead) would cause stalls on the slow player.

## Expected Impact

For the desktop (63fps) + mobile (61fps) case:
- Desktop throttles ~2 ticks per second to match mobile rate
- Both sides run at ~61fps — imperceptible drop on desktop
- Zero stalls from rate mismatch (INPUT-STALL only on genuine network issues)
- The 85-second death spiral is eliminated — game runs indefinitely

For desktop + desktop (same fps):
- Frame advantage stays near 0
- Cap rarely fires (only on rare jitter spikes)
- No observable difference from current behavior

## Files Modified

| File | Changes |
|---|---|
| `web/static/netplay-lockstep.js` | Frame advantage tracker, skip logic, delay floor, diagnostic logging, reset in stopSync/startLockstep |

## Testing Strategy

1. **Desktop + mobile (same wifi):** Play for 5+ minutes. Check logs for zero
   INPUT-STALL entries and periodic FRAME-CAP events showing the host throttling
   1-2 frames. Gameplay should feel smooth throughout.

2. **Desktop + desktop:** Play for 5+ minutes. Confirm FRAME-CAP rarely fires.
   No regression from current behavior.

3. **Log analysis:** Download logs from both sides. Verify `fAdv` in INPUT-LOG
   stays within [0, DELAY_FRAMES+1] range. Verify no stall death spiral.

4. **Warmup test:** Verify no FRAME-CAP events in the first 120 frames of a session.
   Check logs for the warmup guard working correctly.

## Non-Goals

- Rollback netcode (future consideration, different architecture)
- Bilateral frame advantage reporting (unnecessary for lockstep)
- Adaptive tick interval (browser timer precision makes this fragile)
- Changing the tick mechanism (setInterval(16) remains)
