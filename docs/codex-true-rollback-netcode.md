# Codex prompt: convert "lockstep with rollback recovery" → true rollback netcode

## Context

Read these first for background and constraints:
- [docs/codex-perf-iteration-prompt.md](codex-perf-iteration-prompt.md) — iteration loop, measurement protocol, determinism guardrail.
- [docs/codex-rollback-smoothness-prompt.md](codex-rollback-smoothness-prompt.md) — earlier visual-masking iteration.
- [docs/codex-rollback-smoothness-iter2.md](codex-rollback-smoothness-iter2.md) — perceptual + mechanical levers, what's already shipped.
- [docs/netplay-invariants.md](netplay-invariants.md) — **must read.** R1-R6 invariants are mandatory; do not violate them.

This doc is a **single architectural change** with three tightly-coupled parts. They land in one branch. They cannot ship piecemeal.

## The problem

The user's perception of rollback netplay in this codebase is "feels like lockstep, just a tiny bit snappier." After investigation, the root cause is structural, not a performance bug:

**This codebase implements lockstep with rollback as a fallback for missing inputs.** It is not GGPO-style true rollback netcode.

The defining characteristic of true rollback netcode (GGPO, Skullgirls, SF6) is that **local input is applied at the current frame** with a small fixed delay (1-2 frames), and remote input is **predicted at the current frame** with rollback recovery when the prediction was wrong. This decouples local input feel from network RTT.

In this codebase today:

[web/static/netplay-rollback.js:9848](../web/static/netplay-rollback.js#L9848):
```js
const applyFrame = _frameNum - DELAY_FRAMES;
```

[web/static/netplay-rollback.js:9867-9873](../web/static/netplay-rollback.js#L9867-L9873):
```js
for (let zs = 0; zs < 4; zs++) writeInputToMemory(zs, 0);
if (applyFrame >= 0) {
  // ...
  for (let s = 0; s < rb_numPlayers; s++) {
    const inp = _rbGetInput(tickMod, s, applyFrame);
    writeInputToMemory(s, inp);
  }
}
```

Every player's input — **including the local player's own** — is applied to the emulator at `frame - DELAY_FRAMES`. With `ROLLBACK_MIN_DELAY_FRAMES = 4` ([netplay-rollback.js:344](../web/static/netplay-rollback.js#L344)), local input has a fixed ≥ 67ms latency *regardless of network conditions*.

The C engine mirrors this assumption. [build/kn_rollback/kn_rollback.c:1004-1021](../build/kn_rollback/kn_rollback.c#L1004-L1021) (replay path):

```c
if (rb.replay_remaining > 0) {
    int replay_apply = rb.frame - rb.delay_frames;
    // ...
    if (replay_apply >= 0) {
        write_frame_inputs_logged(replay_apply, 1);  // ← all slots, including local
    }
}
```

Replay writes all slots' inputs from `replay_apply = frame - delay`. JS and C must stay aligned on this; otherwise replay produces different state than original-forward and rollback is corrupt.

## The architectural shift

We're moving the input-application strategy from:

```
Today (lockstep + rollback recovery):
  At local frame N, write all slots' inputs from frame N-DELAY to WASM.
  Remote inputs predicted only when missing at frame N-DELAY.
  Local input lag = DELAY frames (≥ 4 in rollback mode).

Proposed (true rollback netcode):
  At local frame N, write LOCAL input from frame N (current).
  Write REMOTE inputs from frame N-DELAY (delayed, with prediction).
  Local input lag = ~1 frame. Remote characters' apparent lag = DELAY frames.
  Rollback fires when remote input arrives differing from prediction.
```

The user-facing effect:

| | Today | Proposed |
|---|---|---|
| Local input lag at 80ms RTT | 4 frames (67ms) | 1 frame (17ms) |
| Local input lag at 30ms RTT | 4 frames (67ms) | 1 frame (17ms) |
| Rollback frequency | unchanged | unchanged |
| Rollback depth | RTT/2 + jitter ≈ 5-7 frames at 80ms | RTT/2 + jitter ≈ 5-7 frames |
| Required `visible_rb_max` engine cap | `delay + 4 = 8` (works) | `delay + 10 = 11` (needs bump) |

**Important non-goal**: this doc is *not* about reducing rollback frequency or hiding rollbacks visually. The visible mask + H-RDP-only + KNDesync skip work continues to do its job. We're shifting where local input gets applied, nothing else.

## The three changes

These three changes ship together in one branch, one PR.

### Change 1 — JS: split local from remote input application

**File**: [web/static/netplay-rollback.js](../web/static/netplay-rollback.js)

**Today** (around line 9867-9883):
```js
for (let zs = 0; zs < 4; zs++) writeInputToMemory(zs, 0);
if (applyFrame >= 0) {
  const inputParts = [];
  for (let s = 0; s < rb_numPlayers; s++) {
    const inp = _rbGetInput(tickMod, s, applyFrame);
    writeInputToMemory(s, inp);
    inputParts.push(...);
  }
  // ...
}
```

**Proposed**:
```js
for (let zs = 0; zs < 4; zs++) writeInputToMemory(zs, 0);
// LOCAL input: apply at CURRENT frame for instant input feel.
writeInputToMemory(_playerSlot, localInput);
const inputParts = [`L${_playerSlot}@${_frameNum}=...`];
// REMOTE inputs: apply at applyFrame (delayed, predicted by C engine if missing).
if (applyFrame >= 0) {
  for (let s = 0; s < rb_numPlayers; s++) {
    if (s === _playerSlot) continue;
    const inp = _rbGetInput(tickMod, s, applyFrame);
    writeInputToMemory(s, inp);
    inputParts.push(`R${s}@${applyFrame}=...`);
  }
}
```

The `localInput` variable is already in scope from earlier in the tick (line ~9558 reads it for `kn_pre_tick`). Reuse it.

**Update the diagnostic INPUT-DIFF log** at [netplay-rollback.js:9850-9866](../web/static/netplay-rollback.js#L9850-L9866) to skip comparing `s === _playerSlot` (local doesn't go through the C ring at apply_frame in the new model).

### Change 2 — C engine: split replay input application to match

**File**: [build/kn_rollback/kn_rollback.c](../build/kn_rollback/kn_rollback.c)

**Today** (around line 1014-1021):
```c
if (replay_apply >= 0) {
    write_frame_inputs_logged(replay_apply, 1);
} else {
    int s;
    for (s = 0; s < KN_MAX_PLAYERS; s++)
        kn_write_controller(s, 0, 0, 0, 0, 0);
}
```

**Proposed**:
```c
/* True rollback: replay must reproduce the SAME input application
 * that the original forward frame used. Original forward applies local
 * at rb.frame and remote at replay_apply, so replay does the same.
 *
 * If we wrote all slots from replay_apply, replay would simulate with
 * a stale local input that the original frame never used → state
 * divergence indistinguishable from a real misprediction → R4 fires
 * for every replay frame. Don't do that.
 */
{
    int s;
    /* Local input: from rb.frame (current). Stored by kn_pre_tick. */
    int local_idx = rb.frame % KN_INPUT_RING_SIZE;
    if (rb.inputs[rb.local_slot][local_idx].present
        && rb.inputs[rb.local_slot][local_idx].frame == rb.frame) {
        kn_input_t *li = &rb.inputs[rb.local_slot][local_idx];
        kn_write_controller(rb.local_slot, li->buttons, li->lx, li->ly, li->cx, li->cy);
    } else {
        kn_write_controller(rb.local_slot, 0, 0, 0, 0, 0);
    }
    /* Remote inputs: from replay_apply (confirmed or predicted). */
    if (replay_apply >= 0) {
        for (s = 0; s < KN_MAX_PLAYERS; s++) {
            if (s == rb.local_slot) continue;
            int idx = replay_apply % KN_INPUT_RING_SIZE;
            if (rb.slot_active[s]
                && rb.inputs[s][idx].present
                && rb.inputs[s][idx].frame == replay_apply) {
                kn_input_t *ri = &rb.inputs[s][idx];
                kn_write_controller(s, ri->buttons, ri->lx, ri->ly, ri->cx, ri->cy);
            } else {
                kn_write_controller(s, 0, 0, 0, 0, 0);
            }
        }
    } else {
        for (s = 0; s < KN_MAX_PLAYERS; s++) {
            if (s == rb.local_slot) continue;
            kn_write_controller(s, 0, 0, 0, 0, 0);
        }
    }
    /* Logging mirrors write_frame_inputs_logged. Keep the same format
     * so existing log analysis tools still parse. */
    rb_log("REPLAY-INPUT f=%d local=%d remote_apply=%d ...", rb.frame, rb.local_slot, replay_apply);
}
```

Re-audit `write_frame_inputs_logged` to confirm no other call site outside the replay path. If it's used elsewhere, decide per-call whether to migrate to the split form.

### Change 3 — C engine: bump rollback depth cap

**File**: [build/kn_rollback/kn_rollback.c:823](../build/kn_rollback/kn_rollback.c#L823)

**Today**:
```c
int visible_rb_max = rb.delay_frames + 4;
```

**Proposed**:
```c
/* True rollback: rollback depth is determined by network RTT/2 + jitter,
 * not by delay_frames. With delay_frames=1 and 80ms RTT, depth still
 * runs ~5-7 frames per the demo's measured distribution. The +4 margin
 * was sized for delay≥4; bumping to +10 keeps the same headroom across
 * the new delay range. Ring buffer size (KN_INPUT_RING_SIZE) already
 * supports this — see KN_MAX_VISIBLE_ROLLBACK_DEPTH below. */
#ifndef KN_MAX_VISIBLE_ROLLBACK_DEPTH
#define KN_MAX_VISIBLE_ROLLBACK_DEPTH 12
#endif
int visible_rb_max = (rb.delay_frames + 10 < KN_MAX_VISIBLE_ROLLBACK_DEPTH)
                   ? rb.delay_frames + 10
                   : KN_MAX_VISIBLE_ROLLBACK_DEPTH;
```

Verify `KN_INPUT_RING_SIZE` is large enough for the new max (it should be; current 256 is plenty).

The `rb.max_frames` ceiling above `visible_rb_max` is a separate concept — that's the ring-coverage cap, not the visible cap. Don't touch.

### Change 4 — JS: lower `ROLLBACK_MIN_DELAY_FRAMES` (one-line)

**File**: [web/static/netplay-rollback.js:344](../web/static/netplay-rollback.js#L344)

**Today**:
```js
const ROLLBACK_MIN_DELAY_FRAMES = 4;
const ROLLBACK_MAX_DELAY_FRAMES = 7;
```

**Proposed**:
```js
const ROLLBACK_MIN_DELAY_FRAMES = 1;
const ROLLBACK_MAX_DELAY_FRAMES = 7;
```

The auto-calculated delay formula at [netplay-rollback.js:5560-5564](../web/static/netplay-rollback.js#L5560-L5564) (`effectiveMs = filteredMedian / 2 + jitterMargin + 16.67`) needs to be re-evaluated:

For the demo at 80ms RTT, jitter 8ms: `effectiveMs = 40 + 8 + 16.67 = 64.67ms → ceil/16.67 = 4` frames. With MIN=1, the formula still picks 4 because the math computes a 4-frame "effective" delay margin. But that margin was sized for the *old* model where DELAY_FRAMES governed local input lag.

In the new model, DELAY_FRAMES governs **remote prediction window only**. The "right" delay is now: enough margin to *avoid* mispredictions on the typical-jitter remote, balanced against rollback frequency. A simpler heuristic for true rollback:

```js
// New model: delay = jitter buffer for remote inputs only.
// Local lag is independent (always 1 frame).
const effectiveMs = jitterMargin + 16.67; // No RTT/2 component — RTT determines rollback depth, not delay.
```

For the demo, `effectiveMs = 8 + 16.67 = 24.67ms → 2 frames`. Tunable post-shipping.

## Cross-peer determinism guard

This is non-negotiable. A peer running new code matched against old code = silent state divergence.

Add a capability bit alongside the existing `rdpReplaySkip` in [netplay-rollback.js:421](../web/static/netplay-rollback.js#L421):

```js
const _localRollbackCaps = () => {
  const mod = window.EJS_emulator?.gameManager?.Module;
  return {
    rdpReplaySkip: !!mod?._kn_set_skip_rdp_replay && RB_SKIP_RDP_DURING_REPLAY,
    trueRollback: !!mod?._kn_get_true_rollback_capability && mod._kn_get_true_rollback_capability() === 1,
  };
};
```

Add a tiny C export:
```c
EMSCRIPTEN_KEEPALIVE int kn_get_true_rollback_capability(void) { return 1; }
```

In the lockstep-ready handshake, peers exchange `caps`. Any peer reporting `trueRollback: false` → refuse to start rollback (fall back to lockstep, log a warning). This matches the existing `rdpReplaySkip` mismatch path. Synthetic demo peers continue to be excluded from the mismatch check.

## Validation

You must complete all of these before considering the change shippable:

1. **Within-peer determinism**: use `window.knDiag?.replayBisect(30)` (NOT `replaySelfTest`) as the gate. It must continue to report `0/N bytes differ` like it does today. The `replaySelfTest` C-side path is known to flake in full-headless mode, which is *not* the production rollback path — investigation found that flake is in test-only code (`kn_replay_self_test` forces `kn_set_headless(1)` for both runs, which the production replay path does not use). Don't use the self-test as the regression gate; use the byte-diff bisect.

2. **Cross-peer determinism, two-tab Playwright test**: open the demo in two tabs (acting as P1 and P2 with synthetic peer disabled), let them play 5 minutes random inputs each, broadcast `kn_gameplay_hash` every 60 frames, assert zero divergence. Add this as a new harness if one doesn't exist.

3. **Replay correctness**: `failed_rollbacks` count over a 5-minute demo run with the new `visible_rb_max` cap. Should stay at zero. R3 (`FATAL-RING-STALE`) and R4 (`RB-LIVE-MISMATCH`) must remain zero.

4. **Local input lag, instrumented**: add a one-shot probe that timestamps a synthetic local button press and reads the resulting RDRAM character-state delta to measure end-to-end input → simulated-effect latency. Pre-fix should report ~67ms; post-fix should report ~17ms. This is the user-facing metric that proves the fix worked.

5. **Visual stutter measurement**: run the standard 30s in-match steady-state demo. TICK-PERF and replay duration should not regress. Subjective eyeballing of the demo for stutter at rollback frequency.

## Measurement plan

Pre-fix baseline (one rollback session, 30s in-match, demo random P2):
- TICK-PERF median, p95, max
- replay duration p50, p95, max
- rollback events, mispredicts, failed_rollbacks
- input → effect latency probe (new metric, pre-fix value)

Post-fix:
- Same metrics. None of the perf metrics should regress materially.
- Input → effect latency should drop ~50ms.
- failed_rollbacks must stay zero with the new cap.

The headline number is **input → effect latency**. If it doesn't drop dramatically, the architectural change didn't actually work.

## Risk register

1. **Replay state divergence** if Change 1 ships without Change 2. Mitigation: ship together, gated on the C-engine capability bit. Fail closed.
2. **Cross-peer divergence** with old client matched. Mitigation: capability-handshake refusal, matching the `rdpReplaySkip` precedent.
3. **failed_rollbacks at deep depths** if Change 3's cap isn't high enough. Mitigation: `KN_MAX_VISIBLE_ROLLBACK_DEPTH = 12` is generous; verify with measurement.
4. **`replaySelfTest(30)` flake masking real regressions** introduced by this change. Resolved: the flake was traced to `kn_replay_self_test` forcing full headless (a code path not used in production replay). Use `replayBisect(30)` as the regression gate instead — it tests the actual replay-equivalent path and reliably reports zero byte divergence today.
5. **Audio glitches at the apply-frame boundary** — local input takes effect 1 frame ahead of remote, and audio synthesis depends on the simulation step. Mitigation: measure audio buffer underruns; if any, scope further.

## Rollback strategy if something is broken

The capability handshake means new clients refuse to rollback against old clients. Worst case: ship breaks, users see "lockstep mode" instead of "rollback mode" until a revert lands. No silent desync.

Add a `?trueRollback=0` URL escape hatch to force-disable the new path on a deployed build. Mirrors the `?replaySkipRdp=0` pattern.

## Constraints (carry over)

- Don't deploy. User reviews + tests.
- Commit per logical change (JS first to compile-check; C with WASM rebuild; cap bump; capability handshake; URL escape hatch). Each commit independently builds and runs `replaySelfTest(30)` even if it doesn't ship the full feature.
- WASM rebuilds via `docker` + `just deploy` happen automatically (`feedback_wasm_rebuild_auto.md`).
- Read [docs/netplay-invariants.md](netplay-invariants.md) before touching the C engine. R1-R6 are non-negotiable.
- Don't reintroduce flicker, frame drops, or determinism failures.

## Reporting

Final PR report should include:
- Pre/post tick perf, replay duration.
- Pre/post input-to-effect latency (the headline number).
- failed_rollbacks count over 5-min demo, plus any R3/R4 invariant log lines (must be zero).
- Cross-peer determinism test outcome.
- Any pre-existing `replaySelfTest(30)` flake patterns observed (so the user has a record).
- One-line summary: "Local input lag dropped from X ms to Y ms; visual smoothness unchanged."
