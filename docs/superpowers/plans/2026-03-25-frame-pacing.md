# Frame Advantage Pacing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the desktop-to-mobile frame rate death spiral by capping how far ahead the faster player can run, adapted from GGPO's timesync.

**Architecture:** A frame advantage tracker with asymmetric EMA smoothing is added at the top of the `tick()` function. When the smoothed advantage exceeds `DELAY_FRAMES + 1`, the tick is skipped entirely (no input sent, no frame stepped). The minimum delay floor is raised from 1 to 2 to provide buffer headroom.

**Tech Stack:** Vanilla JS (ES2022+), single file modification

---

## Chunk 1: Frame Pacing Implementation

All changes are in `web/static/netplay-lockstep.js`.

### Task 1: Add frame pacing state variables

**Files:**
- Modify: `web/static/netplay-lockstep.js:570-575` (after `_awaitingResyncAt` and drift diagnostics state)

- [ ] **Step 1: Add constants and state variables**

After the drift diagnostics block (the `_resetDrift` function, around line 602), add:

```javascript
  // Frame pacing (GGPO-style frame advantage cap)
  const FRAME_ADV_ALPHA_UP = 0.1;    // EMA when advantage is rising (slow to trigger)
  const FRAME_ADV_ALPHA_DOWN = 0.2;  // EMA when advantage is falling (fast to release)
  const FRAME_PACING_WARMUP = 120;   // skip pacing during first 120 frames (~2s boot)
  let _frameAdvantage = 0;            // smoothed frame advantage (EMA)
  let _frameAdvRaw = 0;               // instantaneous frame advantage (for logging)
  let _framePacingActive = false;     // true when cap is throttling
  // Pacing summary stats (reset every 300 frames)
  let _pacingCapsCount = 0;           // number of cap events in window
  let _pacingCapsFrames = 0;          // total frames skipped in window
  let _pacingMaxAdv = 0;              // peak advantage in window
  let _pacingAdvSum = 0;              // sum of advantages for averaging
  let _pacingAdvCount = 0;            // number of samples for averaging
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: add frame pacing state variables (GGPO-style advantage cap)"
```

### Task 2: Add frame advantage cap to tick()

**Files:**
- Modify: `web/static/netplay-lockstep.js:2527-2540` (top of `tick()` function)

- [ ] **Step 1: Insert the frame pacing block**

In the `tick()` function, find this exact code at lines 2536-2538:

```javascript
    }

    const activePeers = getActivePeers();
```

(This is the end of the `_pendingResyncState` block and the start of the `activePeers` line.)

Insert the frame pacing block BETWEEN line 2536 (`}` closing the resync block) and line 2538 (`const activePeers`):

```javascript
    }

    // ── Frame pacing (GGPO-style frame advantage cap) ────────────────────
    // Prevents the faster machine from outrunning the slower one's input stream.
    // Skip during warmup — connection is still stabilizing.
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

          // Track stats for periodic summary
          _pacingAdvSum += _frameAdvantage;
          _pacingAdvCount++;
          if (_frameAdvantage > _pacingMaxAdv) _pacingMaxAdv = _frameAdvantage;

          if (_frameAdvantage > DELAY_FRAMES + 1) {
            // Too far ahead — skip this tick entirely.
            // Don't send input (adds to pile remote can't consume).
            // Don't step emulator (diverges further).
            _pacingCapsFrames++;
            if (!_framePacingActive) {
              _framePacingActive = true;
              _pacingCapsCount++;
              _syncLog(`FRAME-CAP start fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)} delay=${DELAY_FRAMES} minRemote=${minRemoteFrame}`);
            }
            return;
          }
          if (_framePacingActive) {
            _framePacingActive = false;
            _syncLog(`FRAME-CAP end fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)}`);
          }
        }
      }
    }

    const activePeers = getActivePeers();
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: frame advantage cap — skip tick when too far ahead of slowest peer"
```

### Task 3: Raise minimum delay floor to 2

**Files:**
- Modify: `web/static/netplay-lockstep.js:207` (auto-delay calculation)

- [ ] **Step 1: Change Math.max(1, ...) to Math.max(2, ...)**

Find this line:

```javascript
        const delay = Math.min(9, Math.max(1, Math.ceil(median / 16.67)));
```

Replace with:

```javascript
        const delay = Math.min(9, Math.max(2, Math.ceil(median / 16.67)));
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "fix: raise minimum delay floor to 2 for frame pacing headroom"
```

### Task 4: Add frame advantage to INPUT-LOG and periodic pacing summary

**Files:**
- Modify: `web/static/netplay-lockstep.js:2652` (INPUT-LOG line)

- [ ] **Step 1: Extend INPUT-LOG with frame advantage fields**

Find the INPUT-LOG `_syncLog` call (it's a long single line). At the end of the template literal, before the closing backtick, append:

```
 fAdv=${_frameAdvantage.toFixed(1)} fAdvRaw=${_frameAdvRaw}
```

So the line ends with:
```javascript
... fps=${_fpsCurrent} fAdv=${_frameAdvantage.toFixed(1)} fAdvRaw=${_frameAdvRaw}`);
```

- [ ] **Step 2: Add periodic pacing summary**

After the INPUT-LOG block (after the closing `}` of the `if (_frameNum % 60 === 0)` block), add a pacing summary log every 300 frames:

```javascript
      // Periodic pacing summary (~5s)
      if (_frameNum % 300 === 0 && _pacingAdvCount > 0) {
        const avgAdv = (_pacingAdvSum / _pacingAdvCount).toFixed(1);
        _syncLog(`PACING f=${_frameNum} avgAdv=${avgAdv} maxAdv=${_pacingMaxAdv.toFixed(1)} capsCount=${_pacingCapsCount} capsFrames=${_pacingCapsFrames}`);
        // Reset window
        _pacingCapsCount = 0;
        _pacingCapsFrames = 0;
        _pacingMaxAdv = 0;
        _pacingAdvSum = 0;
        _pacingAdvCount = 0;
      }
```

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: add frame advantage to INPUT-LOG and periodic pacing summary"
```

### Task 5: Reset frame pacing state in stopSync() and startLockstep()

**Files:**
- Modify: `web/static/netplay-lockstep.js` (both `stopSync` and `startLockstep`)

- [ ] **Step 1: Add reset to stopSync()**

In the `stopSync` function, find `_hasKnSync = false;` (line ~2524). After it, add:

```javascript
    _frameAdvantage = 0;
    _frameAdvRaw = 0;
    _framePacingActive = false;
    _pacingCapsCount = 0;
    _pacingCapsFrames = 0;
    _pacingMaxAdv = 0;
    _pacingAdvSum = 0;
    _pacingAdvCount = 0;
```

- [ ] **Step 2: Add reset to startLockstep()**

In `startLockstep()`, find `_lastRemoteFramePerSlot = {};` (line ~2293). After it, add the same block:

```javascript
    _frameAdvantage = 0;
    _frameAdvRaw = 0;
    _framePacingActive = false;
    _pacingCapsCount = 0;
    _pacingCapsFrames = 0;
    _pacingMaxAdv = 0;
    _pacingAdvSum = 0;
    _pacingAdvCount = 0;
```

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "chore: reset frame pacing state in stopSync and startLockstep"
```
