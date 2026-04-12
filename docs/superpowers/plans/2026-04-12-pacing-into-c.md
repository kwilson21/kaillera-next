# Move Pacing Decision Into C Rollback Engine

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the JS/C split-brain pacing bug where the JS `_skipFrameAdvance` gate starves the C ring buffer, causing FATAL-RING-STALE → FAILED-ROLLBACK → permanent desync during character select screen navigation.

**Architecture:** Add a `frame_adv` parameter to `kn_pre_tick`. C decides whether to skip the emulator step based on both frame advantage AND ring health. JS stops making independent pacing decisions — it computes frame advantage (it has the network state) and passes it to C, which makes the final call. New return value `3` = "ring saved, skip frame advance." The two-gate interaction that caused the bug becomes impossible.

**Tech Stack:** C (kn_rollback.c), JavaScript (netplay-lockstep.js), WASM build (build.sh)

---

## File Map

- **Modify:** `build/kn_rollback/kn_rollback.c:761` — add `frame_adv` param to `kn_pre_tick`, add pacing logic before save gate
- **Modify:** `web/static/netplay-lockstep.js:6155-6203` — remove JS proportional throttle + safety freeze that sets `_skipFrameAdvance`; pass `_frameAdvRaw` to `_kn_pre_tick`
- **Modify:** `web/static/netplay-lockstep.js:6515` — update `_kn_pre_tick` call to include frame advantage arg
- **Modify:** `web/static/netplay-lockstep.js:6042-6088` — keep rollback stall freeze in JS (it's a network-level concern, not a ring concern) but ensure it still prevents frame advance when C returns 3
- **No changes to:** `build/build.sh` — `_kn_pre_tick` is already exported; signature change is transparent to WASM linker

---

### Task 1: Add `frame_adv` parameter to `kn_pre_tick` in C

**Files:**
- Modify: `build/kn_rollback/kn_rollback.c:761`

- [ ] **Step 1: Add frame_adv parameter and pacing constants**

In `kn_rollback.c`, change the `kn_pre_tick` signature and add pacing logic at the top of the function, before the rollback/save logic:

```c
int kn_pre_tick(int buttons, int lx, int ly, int cx, int cy, int frame_adv) {
    int s, idx, apply_frame;
    if (!rb.initialized) return -1;

    /* ── C-level pacing gate ──────────────────────────────────────────
     * JS passes the raw frame advantage (local frame - min remote frame).
     * C decides whether to skip the frame advance based on BOTH pacing
     * and ring health. This eliminates the split-brain bug where JS
     * pacing starved the ring buffer.
     *
     * frame_adv < 0: JS doesn't have pacing info yet (boot) — never skip
     * frame_adv < delay + 2: normal operation — never skip
     * frame_adv >= max_frames - 2: safety freeze — always save + skip
     * frame_adv >= delay + 2: soft throttle — save if ring needs it, skip
     *
     * Return 3 = "saved state if needed, skip frame advance."
     * JS must NOT step the emulator when it gets 3. */
    if (frame_adv >= 0 && frame_adv >= rb.delay_frames + 2) {
        int need_ring_save = 0;

        /* Ring staleness check: if the ring is getting thin, force a save
         * before skipping. This is the same ceiling as the normal save
         * gate but evaluated BEFORE we decide to skip. */
        if (rb.last_save_frame < 0 ||
            (rb.frame - rb.last_save_frame) >= rb.ring_size / 2) {
            need_ring_save = 1;
        }
        /* Also check ring coverage: if the oldest in-window frame lost
         * its ring slot, force a save. */
        if (!need_ring_save && rb.frame > rb.max_frames) {
            int oldest_window_frame = rb.frame - rb.max_frames;
            int oldest_idx = oldest_window_frame % rb.ring_size;
            if (rb.ring_frames[oldest_idx] != oldest_window_frame) {
                need_ring_save = 1;
            }
        }

        if (need_ring_save) {
            int save_idx = rb.frame % rb.ring_size;
            retro_serialize(rb.ring_bufs[save_idx], rb.state_size);
            rb.ring_sf_state[save_idx] = sf_pack();
            rb.ring_frames[save_idx] = rb.frame;
            rb.last_save_frame = rb.frame;
        }

        /* Still need to drain pending rollbacks even when pacing-skipped,
         * so mispredictions don't pile up. But don't start the replay —
         * just acknowledge the rollback target is set. The next non-skipped
         * frame will handle it. */

        return 3; /* skip frame advance, ring maintained */
    }

    /* ... rest of existing kn_pre_tick unchanged ... */
```

- [ ] **Step 2: Verify the change compiles**

The C file is compiled as part of the WASM build. For now, verify syntax by reading the modified file and confirming the function signature, braces, and return paths are correct.

- [ ] **Step 3: Commit**

```bash
git add build/kn_rollback/kn_rollback.c
git commit -m "feat(rollback): add frame_adv param to kn_pre_tick — C-level pacing gate"
```

---

### Task 2: Update JS to pass frame advantage and defer to C

**Files:**
- Modify: `web/static/netplay-lockstep.js:6155-6203` (remove JS proportional throttle + safety freeze)
- Modify: `web/static/netplay-lockstep.js:6515` (pass `_frameAdvRaw` to `_kn_pre_tick`)
- Modify: `web/static/netplay-lockstep.js:6373` (handle return value 3)

- [ ] **Step 1: Remove JS proportional throttle and safety freeze for rollback mode**

In `netplay-lockstep.js`, the GGPO safety freeze (lines 6155-6166) and proportional throttle (lines 6183-6203) currently set `_skipFrameAdvance = true`. These must be removed **only when `_useCRollback` is true** — C now owns this decision. Non-rollback lockstep mode still needs JS pacing.

Replace lines 6129-6203 (inside the `if (activePacingPeers > 0 && minRemoteFrame >= 0)` block) with:

```javascript
        if (activePacingPeers > 0 && minRemoteFrame >= 0) {
          _frameAdvRaw = _frameNum - minRemoteFrame;

          const alpha = _frameAdvRaw > _frameAdvantage ? FRAME_ADV_ALPHA_UP : FRAME_ADV_ALPHA_DOWN;
          _frameAdvantage = _frameAdvantage * (1 - alpha) + _frameAdvRaw * alpha;

          // Track stats for periodic summary
          _pacingAdvSum += _frameAdvantage;
          _pacingAdvCount++;
          if (_frameAdvantage > _pacingMaxAdv) _pacingMaxAdv = _frameAdvantage;

          // ── C-level rollback: pacing decided by C ────────────────────
          // JS computes _frameAdvRaw and passes it to kn_pre_tick.
          // C checks ring health and returns 3 (skip) or 0/2 (continue).
          // Non-rollback lockstep still uses JS pacing below.
          if (!_useCRollback) {
            // ── GGPO safety freeze (non-rollback only) ─────────────────
            const _rbConverged = _rbInitFrame >= 0 && _frameNum - _rbInitFrame > BOOT_GRACE_FRAMES;
            if (_rbConverged && _frameAdvRaw >= _rbRollbackMax - 2) {
              if (!_framePacingActive) {
                _framePacingActive = true;
                _pacingThrottleStartAt = nowPacing;
                _pacingCapsCount++;
                _syncLog(
                  `PACING-SAFETY-FREEZE fAdv=${_frameAdvRaw} rbMax=${_rbRollbackMax} minRemote=${minRemoteFrame} — skipping frame advance (inputs still sent)`,
                );
              }
              _pacingCapsFrames++;
              _skipFrameAdvance = true;
            }

            // ── Proportional throttle (non-rollback only) ──────────────
            const excess = _rbConverged ? _frameAdvRaw - DELAY_FRAMES : -1;
            let shouldSkip = false;
            if (excess >= 3) {
              shouldSkip = true;
            } else if (excess >= 2) {
              _pacingSkipCounter++;
              shouldSkip = (_pacingSkipCounter & 1) === 0;
            }
            if (shouldSkip) {
              _pacingCapsFrames++;
              if (!_framePacingActive) {
                _framePacingActive = true;
                _pacingThrottleStartAt = nowPacing;
                _pacingCapsCount++;
                const ratio = excess >= 2 ? '100%' : '50%';
                _syncLog(
                  `PACING-THROTTLE start fAdv=${_frameAdvRaw} ratio=${ratio} smooth=${_frameAdvantage.toFixed(1)} delay=${DELAY_FRAMES} minRemote=${minRemoteFrame}`,
                );
              }
              _skipFrameAdvance = true;
            }
            if (_framePacingActive && !_skipFrameAdvance) {
              _framePacingActive = false;
              _pacingThrottleStartAt = 0;
              _syncLog(`PACING-THROTTLE end fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)}`);
            }
          }
```

- [ ] **Step 2: Pass `_frameAdvRaw` to `_kn_pre_tick`**

At line 6515, change the call to include frame advantage. Pass `-1` during boot convergence (before pacing info is available):

```javascript
      const _frameAdvForC = (_rbInitFrame >= 0 && _frameNum - _rbInitFrame > BOOT_GRACE_FRAMES)
        ? _frameAdvRaw
        : -1;
      const catchingUp = tickMod._kn_pre_tick(
        localInput.buttons,
        localInput.lx,
        localInput.ly,
        localInput.cx,
        localInput.cy,
        _frameAdvForC,
      );
```

- [ ] **Step 3: Handle return value 3 (pacing skip with ring save)**

After the `_kn_pre_tick` call (around line 6522), add handling for the new return value. When C returns 3, JS should skip frame advance but still poll for invariant violations and log the throttle:

```javascript
      // C returned 3 = "ring saved, skip frame advance"
      if (catchingUp === 3) {
        _pacingCapsFrames++;
        if (!_framePacingActive) {
          _framePacingActive = true;
          _pacingThrottleStartAt = performance.now();
          _pacingCapsCount++;
          _syncLog(
            `PACING-THROTTLE start fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)} delay=${DELAY_FRAMES} source=C`,
          );
        }
        // Still poll R3/R4/R5 invariants (they may have been set by
        // the ring save or pending rollback processing inside kn_pre_tick)
        // ... existing R3/R4/R5 poll code runs below ...
        // But skip stepOneFrame and post_tick
        return;
      }
      // Release pacing throttle if C didn't skip
      if (_framePacingActive && catchingUp !== 3) {
        _framePacingActive = false;
        _pacingThrottleStartAt = 0;
        _syncLog(`PACING-THROTTLE end fAdv=${_frameAdvRaw} smooth=${_frameAdvantage.toFixed(1)}`);
      }
```

**Important:** The `return` for `catchingUp === 3` must be placed AFTER the R3/R4/R5 invariant polls (lines 6542-6617) but BEFORE the frame stepping code. Move the invariant polls above the return-3 gate, or duplicate them.

- [ ] **Step 4: Keep rollback stall freeze in JS**

The rollback stall freeze (`_rollbackStallActive`, lines 6042-6088) stays in JS — it's about detecting dead peers via network timers, not ring management. C doesn't have access to `performance.now()` or peer advance timestamps. This is correct: JS detects the problem (peer stopped sending), JS freezes. No change needed.

- [ ] **Step 5: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat(rollback): JS defers pacing to C for rollback mode, passes frameAdvRaw"
```

---

### Task 3: Handle pacing throttle timeout (I1) for C-driven pacing

**Files:**
- Modify: `web/static/netplay-lockstep.js:6218-6247` (I1 pacing throttle timeout)

- [ ] **Step 1: Update I1 timeout to work with C-driven pacing**

The I1 pacing throttle timeout (lines 6218-6247) currently checks `_framePacingActive` and force-phantoms the slowest peer if throttled too long. This must still work when C drives pacing. Since we set `_framePacingActive` when `catchingUp === 3`, and `_pacingThrottleStartAt` tracks the start time, the existing I1 code works as-is — it only reads those JS-level tracking variables.

Verify: the I1 timeout block at lines 6218-6247 does NOT reference `_skipFrameAdvance` or the proportional throttle. It only uses `_framePacingActive` and `_pacingThrottleStartAt`. No changes needed.

- [ ] **Step 2: Commit (if any changes were needed)**

If verification found no changes needed, skip this commit.

---

### Task 4: Build and test WASM core

**Files:**
- Run: `build/build.sh` (Docker WASM build)

- [ ] **Step 1: Build the patched WASM core**

```bash
cd /Users/kazon/kaillera-next
docker compose run --rm builder
```

This compiles `kn_rollback.c` into the WASM core. The `kn_pre_tick` signature change is transparent to the WASM export — Emscripten exports by name, and extra parameters in C just read from the stack.

- [ ] **Step 2: Deploy the new core locally**

Copy the built `.wasm` and `.data` files to `web/static/ejs/cores/`.

- [ ] **Step 3: Commit**

```bash
git add web/static/ejs/cores/
git commit -m "chore(wasm): rebuild core with C-level pacing gate"
```

---

### Task 5: Manual two-tab test

- [ ] **Step 1: Test the exact scenario that caused the desync**

Open two tabs (Mac + iPhone simulator or real device). Create a rollback-mode room. On one device, navigate the CSS (character select screen) with analog stick while the other is idle. Verify:

1. No FATAL-RING-STALE in sync logs
2. No FAILED-ROLLBACK events
3. Both players see the same character selected
4. PACING-THROTTLE logs show `source=C`
5. SSIM stays above 0.95 during CSS navigation

- [ ] **Step 2: Test normal gameplay**

After CSS, play a round of SSB64. Verify:
1. Rollback still works (mispredictions corrected)
2. Frame pacing feels smooth (no stuttering)
3. No R3/R4/R5 invariant violations

- [ ] **Step 3: Test non-rollback lockstep mode**

Create a classic lockstep room. Verify JS pacing still works (the `!_useCRollback` branch). Frame pacing logs should show the old `ratio=50%/100%` format, not `source=C`.
