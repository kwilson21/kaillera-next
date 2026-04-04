# Proportional Frame Pacing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the binary FRAME-CAP (0fps or 60fps) with proportional tick skipping for smoother 3+ player lockstep.

**Architecture:** Single-file change in `netplay-lockstep.js`. Replace the binary skip gate with a modulo-based skip table that throttles proportionally to frame advantage. All existing pacing infrastructure (EMA tracker, phantom peers, diagnostics) is preserved.

**Tech Stack:** Vanilla JS (IIFE + window globals pattern)

**Spec:** `docs/superpowers/specs/2026-04-04-proportional-frame-pacing-design.md`

---

## Chunk 1: Implementation

### Task 1: Add SKIP_TABLE constant and _pacingSkipCounter state

**Files:**
- Modify: `web/static/netplay-lockstep.js:1153-1156` (pacing state declarations)

- [ ] **Step 1: Add SKIP_TABLE and _pacingSkipCounter after existing pacing state**

After `let _pacingMaxAdv = 0;` (line 1155), add:

```javascript
  // Proportional skip table: indexed by excess (frameAdvRaw - DELAY_FRAMES).
  // Each entry is [divisor, skipCount] for modulo pattern, or null (no skip).
  // excess=1 → skip 1 of 4 (25%), excess=2 → 1 of 2 (50%), excess=3 → 3 of 4 (75%).
  const SKIP_TABLE = [null, [4, 1], [2, 1], [4, 3]];
  let _pacingSkipCounter = 0;
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: add proportional skip table and counter for frame pacing"
```

### Task 2: Replace binary FRAME-CAP with proportional skip

**Files:**
- Modify: `web/static/netplay-lockstep.js:4105-4122` (binary cap block inside tick())

- [ ] **Step 1: Replace the binary skip block**

Replace lines 4105-4122 (from `if (_frameAdvRaw >= DELAY_FRAMES + 1) {` through the closing `}`  of `if (_framePacingActive)`) with:

```javascript
          const excess = _frameAdvRaw - DELAY_FRAMES;
          let shouldSkip = false;
          if (excess >= 4) {
            shouldSkip = true; // safety floor: full stop at DELAY+4
          } else if (excess >= 1) {
            _pacingSkipCounter++;
            const skip = SKIP_TABLE[excess];
            shouldSkip = skip && (_pacingSkipCounter % skip[0]) < skip[1];
          }
          if (shouldSkip) {
            _pacingCapsFrames++;
            if (!_framePacingActive) {
              _framePacingActive = true;
              _pacingCapsCount++;
              const ratio = excess >= 4 ? '100%' : `${Math.round(SKIP_TABLE[excess][1] / SKIP_TABLE[excess][0] * 100)}%`;
              _syncLog(
                `PACING-THROTTLE start fAdv=${_frameAdvRaw} ratio=${ratio} smooth=${_frameAdvantage.toFixed(1)} delay=${DELAY_FRAMES} minRemote=${minRemoteFrame}`,
              );
            }
            return;
          }
          if (_framePacingActive) {
            _framePacingActive = false;
            _syncLog(`PACING-THROTTLE end fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)}`);
          }
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat: replace binary FRAME-CAP with proportional tick skipping"
```

### Task 3: Update phantom peer release log

**Files:**
- Modify: `web/static/netplay-lockstep.js:4093` (phantom release log string)

- [ ] **Step 1: Rename FRAME-CAP to PACING-THROTTLE in phantom release log**

Change:
```javascript
          _syncLog('FRAME-CAP released — all peers phantom');
```
To:
```javascript
          _syncLog('PACING-THROTTLE released — all peers phantom');
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "fix: rename phantom release log to PACING-THROTTLE"
```

### Task 4: Add _pacingSkipCounter to all reset locations

**Files:**
- Modify: `web/static/netplay-lockstep.js` at 4 reset locations

The counter must be reset wherever `_pacingCapsCount = 0` appears. Current locations:
1. ~line 3991 (startLockstep reset block)
2. ~line 4347 (periodic 300-frame summary reset — do NOT add here, counter is monotonic across windows)
3. ~line 5226 (applySyncState reset block)
4. ~line 5429 (stopSync reset block)

- [ ] **Step 1: Add `_pacingSkipCounter = 0;` at each game-lifecycle reset location**

After each `_pacingCapsCount = 0;` at locations 1, 3, and 4 (NOT location 2 — the periodic summary), add:
```javascript
    _pacingSkipCounter = 0;
```

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "fix: reset pacing skip counter on game lifecycle transitions"
```

### Task 5: Verify with Playwright

- [ ] **Step 1: Open the game page in Playwright and verify no JS errors**

Load `play.html` in a Playwright browser, create a room, and check the console for errors. The proportional pacing code should load cleanly. This verifies no syntax errors or runtime crashes from the changes.

- [ ] **Step 2: Commit all if any fixups needed**
