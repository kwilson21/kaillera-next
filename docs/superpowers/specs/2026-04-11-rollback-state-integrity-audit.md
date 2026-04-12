# Rollback State Integrity Audit

**Date:** 2026-04-11
**Status:** Proposed design, pending approval
**Trigger:** Room `B190OHFY` playtest — depth-9 rollback reported
`caught up at f=800` but the 9 replay frames never ran. Game state
froze at frame 800 while the frame counter kept advancing. Audio
pipeline starved for 300 frames, SSIM dropped 0.97 → 0.81.

## Companion spec

This spec is a companion to
[2026-04-11-netplay-deadlock-audit.md](2026-04-11-netplay-deadlock-audit.md).
The deadlock spec handles the "tick loop never reaches `kn_pre_tick`"
class — stalls, promise hangs, peer cleanup, scheduled deferred
operations. This spec handles the "`kn_pre_tick` ran but replay
silently produced wrong state" class.

The two specs share documentation (`docs/netplay-invariants.md`),
analyzer (`tools/analyze_match.py`), and Playwright harness
(`tests/deadlock-harness.html`) surfaces. Coordination rules are at
the end of this document.

## Problem

The raw session log for slot 0 in room B190OHFY shows:

```
seq=292 t=51524.82 f=800  C-REPLAY start: depth=9 took=7.4ms
seq=293 t=51525.68 f=800  C-REPLAY done: caught up at f=800 gp=0x-18fb2729
seq=294 t=51525.76 f=800  NORMAL-INPUT f=793 ...
seq=295 t=51531.28 f=801  RB-POST-RB f=800 gp=0x-2c7440f8
```

All four log events span ~6ms at `_frameNum=800`. A genuine depth-9
amortized replay would span ~144ms across 9 `setInterval(16)` ticks.
**The 9 replay frames never ran.** The emulator's state was frozen at
the rollback target, but `kn_post_tick` kept advancing `rb.frame`.

Downstream symptoms in the same session:

- **AUDIO-DEATH**: 300 consecutive `audio-silent` frames starting
  f=1110 on slot 0.
- **Visual desync**: SSIM dropped 0.97 → 0.81.
- **FAILED-ROLLBACK (stale ring)** at f=1086: slot 1's rollback for
  f=786 found `ring[6]=617` (169 frames stale); for f=787 found
  `ring[7]=696` (91 frames stale). Logged, not recovered.

### Root cause hypothesis

[kn_rollback.c:754](../../build/kn_rollback/kn_rollback.c#L754) calls
`retro_unserialize` directly from C. The JS-side loadState path at
[netplay-lockstep.js:8201-8204](../../web/static/netplay-lockstep.js#L8201-L8204)
explicitly re-captures `_pendingRunner` via
`pauseMainLoop`/`resumeMainLoop` after loadState with the comment
"loadState may invalidate `_pendingRunner`." The rollback path does
not. [stepOneFrame at line 4977](../../web/static/netplay-lockstep.js#L4977)
silently returns false when `_pendingRunner` is null — so every
subsequent replay tick is a no-op. `kn_post_tick` advances `rb.frame`
and decrements `replay_remaining` regardless, so the rollback
"completes" with the emulator frozen at the restore target.

This hypothesis is **not yet proven**. The wall-clock evidence is
conclusive that replay never ran; the specific mechanism (runner
invalidation vs. something else in `retro_unserialize`) needs to be
confirmed as the first step of Phase 2. Regardless of mechanism, the
invariants and defense-in-depth checks in this spec catch the failure
class.

### Secondary problem: ring staleness

Separately from the no-run bug, C-level `FAILED-ROLLBACK` events show
the rollback ring does not reliably hold frames inside the rollback
window. The dirty-input serialize gate at
[kn_rollback.c:899](../../build/kn_rollback/kn_rollback.c#L899) skips
~89% of per-frame serializes on stable networks. When a delayed input
arrives for a frame whose ring slot was passed over 90+ times since,
the restore target is stale or overwritten.

Today this is logged and the game continues silently corrupted. The
moment we fix the no-run bug (RF1), stale-ring restores that
previously "worked" (because nothing actually ran anyway) will start
producing genuinely wrong state. Fix both classes together.

### Corroborating evidence — match 07716199 (room 3FK0747R)

A second playtest on 2026-04-12 reproduced the B190OHFY pattern in a
different match, confirming this is not a one-off. Match
`07716199-9813-4953-a12d-f4c01ef5f7df` (room `3FK0747R`) shows:

- **ROLLBACK-RESTORE-CORRUPTION**: 3 events
  - slot 0 f=544 `replay_gp=0x11f80d76 post_gp=0x3380f088`
  - slot 0 f=625 **`replay_gp=0x0`** `post_gp=0x3188f08a` ← *smoking gun*
  - slot 1 f=876 `replay_gp=0x-6870ad31 post_gp=0x-2d3c3a1c`
- **Hash MISMATCH events**: 0 (cross-peer gameplay hashes still
  agree — this is silent corruption, same signature as B190OHFY)
- **Visual SSIM**: 1.0 → 0.9481 at f=300 → 0.6217 at f=1200 →
  **0.0255 at f=1500** (completely divergent images while logical
  state matches)
- **FAILED-ROLLBACK (stale ring)**: 2 events
  - slot 0 f=626 (first failure coincides with first corruption at f=544)
  - slot 1 f=873 (matches first slot-1 corruption at f=876)
- **PACING-SAFETY-FREEZE**: 36 events (20 slot 0, 16 slot 1),
  spanning f=312 → f=1460 — ~19 seconds of sustained pacing cascade
  that begins right as the first SSIM drop appears
- **No BOOT-LOCKSTEP deadlock**, no `COORD-SYNC-TIMEOUT`, no
  `PEER-RESET`, no `RB-INIT-TIMEOUT`, no `TICK-STUCK` — the deadlock
  spec's MF1-MF6 fixes all landed in this match and none fired.
  **This failure class is orthogonal to MF1-MF6.**

The `replay_gp=0x0` at slot 0 f=625 is new evidence that strongly
supports the RF1 hypothesis: a zero gameplay hash right after "replay
done" means either the live state is literally zeros OR the hash was
computed before any replay actually ran. Both options are consistent
with "replay frames silently no-op'd, `rb.frame` advanced anyway".

The pacing cascade (PACING-SAFETY-FREEZE f=312 onward) is also
consistent with the RF1 hypothesis. If one peer's replay silently
no-ops, its frame advantage relative to the other peer can drift
because the two peers pay different real-time costs for the same
frame count — one is actually stepping the emulator, the other is
just advancing the counter. Frame-advantage drift → safety freeze →
further input-timing divergence.

The first SSIM drop (f=300) **precedes** the first
ROLLBACK-RESTORE-CORRUPTION event we captured (f=544). This suggests
either (a) an uncaptured earlier corruption whose `replay_gp` and
`post_gp` happened to coincidentally match, (b) divergence in state
outside the tracked hash path (cursor position, input timing,
audio-driven state), or (c) the corruption starts earlier than the
event pairing logic catches it. RF5's replacement of the detection
logic with `kn_live_gameplay_hash` against the ring at the same
frame should resolve this ambiguity.

Session logs for this match are available via the admin API:
`/admin/api/session-logs/1062` (slot 1) and `/admin/api/session-logs/1063`
(slot 0). Run `tools/analyze_match.py 07716199` for the full
reconstruction.

## Goal

Every rollback either produces bit-correct state or fails loudly
enough that the analyzer catches it and the root cause gets fixed.
No silent corruption. No advancing frame counter with frozen
emulator state. No stale-ring restores masquerading as success.

## Core principle: no band-aid recovery

Mid-match auto-resync triggered from an invariant violation is
**forbidden by this spec**. Mid-game resync that is not caused by a
network disconnect is a symptom-level band-aid that masks root
causes and makes invariant violations look like "normal behavior"
in aggregate telemetry. It is the exact failure mode the companion
deadlock spec rejects in its §Rejected alternative
(auto-recovery watchdog) section.

The goal is to eliminate the conditions that would have made
recovery necessary. When an invariant fires, the correct response
is:

- **Dev builds**: throw so the test suite catches the regression
  before ship.
- **Production builds**: log the full diagnostic state (event
  name, frame, ring snapshot, runner identity, peer state) and
  continue. The player sees the broken game. The analyzer sees
  the event. The fix goes back in the root-cause queue. No
  silent recovery, no covert resync, no aggregate-hiding retry
  loop.

Every RF-* item in this spec MUST respect this principle. Any
temptation to "just auto-resync the problem away" is a signal
that you are working around the bug, not fixing it. Re-read this
section before proposing recovery code in any violation handler.

## Non-goals

- No new netplay features.
- No new rollback prediction strategies (dead-reckoning, zone
  prediction, stick tolerance stay as-is).
- No cross-peer consensus protocol beyond the existing `rb-check:`
  hash exchange and host-authoritative resync.
- No per-peer JS state changes (owned by the deadlock spec's MF1
  `resetPeerState`).
- No tick-loop stall fixes (owned by the deadlock spec).
- No formal verification / TLA+ modeling.

## Invariants

Added to `docs/netplay-invariants.md` as §Rollback Integrity
alongside the deadlock spec's I1 (no unbounded stall) and I2 (clean
peer reset).

### R1 — Runner continuity across rollback restore

Any code path that calls `retro_unserialize` (C-level via
`kn_pre_tick` rollback branch, or JS-level via `loadState`) must
re-capture the Emscripten rAF runner before the next
`stepOneFrame()`. The existing `loadState` path at
[netplay-lockstep.js:8201-8204](../../web/static/netplay-lockstep.js#L8201-L8204)
does this via `pauseMainLoop`/`resumeMainLoop`. The rollback path
does not and MUST.

Failure mode if violated: `stepOneFrame()` returns false silently,
replay ticks are no-ops, emulator state freezes at the restore
target.

### R2 — No silent `stepOneFrame` no-ops during rollback replay

[stepOneFrame](../../web/static/netplay-lockstep.js#L4977) returning
false while `rb.replay_remaining > 0` is an invariant violation. Not
a skip. It emits `REPLAY-NORUN` with full diagnostic state (current
frame, replay depth, runner identity, tick timestamp). In dev builds
it throws so the test suite catches regressions. In production it
logs and continues — the player sees the broken game, the analyzer
catches the event, the fix goes back in the root-cause queue. **No
resync**: recovery inside the violation handler is exactly the
masking failure mode the companion deadlock spec's rejected-
alternatives section explicitly warns against.

### R3 — Ring coverage within the rollback window

For any frame `F` where `rb.frame - F <= rb.max_frames`, the ring
buffer MUST hold valid state for `F`, i.e.,
`ring_frames[F % ring_size] == F`. The dirty-input serialize gate
(RetroArch runahead-style skipping) may only omit a save if doing so
cannot violate R3 for any frame in the rollback window. Today's gate
does not enforce this; B190OHFY's 169-frame stale ring slot proves
it.

`FAILED-ROLLBACK ... (stale)` is currently log-only. Under R3 it
becomes a loud invariant violation (dev: throw; prod: log with full
ring-state dump). **No resync recovery** — per R2's rationale.

### R4 — Post-replay live state equals ring state

After a replay completes at frame `N`, the emulator's live state
(fresh `retro_serialize`) must hash-match the ring's stored state for
frame `N`. Any mismatch means the replay introduced drift between
what the ring believes and what the emulator actually is. R4
treats this as a loud invariant violation (dev: throw; prod: log
with both hashes and a region-level diff). **No resync recovery.**

### R5 — Pre-tick return value consistency

If `rb.replay_depth > 0` after `kn_pre_tick` returns (i.e., a
rollback just kicked off), the return value MUST be 2 (replay frame).
A return value of 0 (normal tick) with `replay_depth > 0` is an
invariant violation that emits `RB-INVARIANT-VIOLATION`. This is the
defense-in-depth check that would have caught B190OHFY on the first
run regardless of root cause. **No resync recovery.**

### R6 — Audio/video state survives restore

Any subsystem whose state is driven by RDRAM contents (AudioWorklet
sample buffer, OpenAL context, GL framebuffer tracker) must either
survive `retro_unserialize` intact or be explicitly re-initialized as
part of the restore sequence. If a subsystem cannot satisfy either,
its RDRAM-backed region gets tainted the way GLideN64 copyback
regions already are.

The 300-frame AUDIO-DEATH in B190OHFY is strong evidence this is
violated for audio. Investigation is part of RF6.

## Failure mode catalog

| # | Location | Mechanism | Invariant | Class |
|---|----------|-----------|-----------|-------|
| F1 | [kn_rollback.c:754](../../build/kn_rollback/kn_rollback.c#L754) | `retro_unserialize` invalidates `_pendingRunner`; no re-capture | R1 | **MUST** |
| F2 | [netplay-lockstep.js:4977](../../web/static/netplay-lockstep.js#L4977) | `stepOneFrame` silent no-op when runner null | R2 | **MUST** |
| F3 | [kn_rollback.c:899](../../build/kn_rollback/kn_rollback.c#L899) | Dirty-input serialize gate (89% skip) leaves ring slots stale beyond window | R3 | **MUST** |
| F4 | [kn_rollback.c:689](../../build/kn_rollback/kn_rollback.c#L689) | `FAILED-ROLLBACK (stale)` is log-only; game continues silently corrupted | R3 | **MUST** |
| F5 | [kn_rollback.c:948](../../build/kn_rollback/kn_rollback.c#L948) | `kn_post_tick` trusts stepping happened; no live-state verification | R4 | **MUST** |
| F6 | [netplay-lockstep.js:6341](../../web/static/netplay-lockstep.js#L6341) | JS doesn't assert `catchingUp === 2` when `replay_depth > 0` | R5 | **MUST** |
| F7 | Audio pipeline (AudioWorklet + OpenAL) | Audio state not reinitialized after `retro_unserialize` → audio death | R6 | **MUST** |
| F8 | [kn_rollback.c:730](../../build/kn_rollback/kn_rollback.c#L730) | Preempt path: new rollback target's ring slot may have been overwritten by preempted replay's partial saves | R3 | SHOULD |
| F9 | [kn_rollback.c:948-969](../../build/kn_rollback/kn_rollback.c#L948-L969) | `C-REPLAY-DONE` ring-patch at `rb.frame % ring_size` conditionally skips when ring doesn't hold current frame | R4 | SHOULD |
| F10 | `_rbPendingPostRollbackHash` comparison | Cross-peer only (broadcasts `rb-check:`); no local live-vs-ring check | R4 | NICE |

## Must-fix plan

Each RF is one commit. Each commit includes a failing test (WASM
unit test or Playwright scenario, whichever the fix requires), the
fix, and `tools/analyze_match.py` verification against a fresh
two-tab session. Per `feedback_playwright_before_deploy`, the full
suite passes before any deploy.

### RF1 — Re-capture `_pendingRunner` after C-level rollback restore

**Addresses:** F1. Root-cause fix for B190OHFY.

Add a new C export `kn_rollback_did_restore()` that returns 1 once
after a successful rollback restore and clears the flag on read
(same pattern as `kn_get_replay_depth`). JS checks it immediately
after `kn_pre_tick`:

```javascript
const catchingUp = tickMod._kn_pre_tick(...);
if (tickMod._kn_rollback_did_restore?.()) {
  // retro_unserialize invalidates _pendingRunner — re-capture it
  // the same way loadState does.
  gm.Module.pauseMainLoop();
  gm.Module.resumeMainLoop();
}
```

Set the flag at
[kn_rollback.c:755](../../build/kn_rollback/kn_rollback.c#L755)
immediately after `retro_unserialize`.

**Phase 2 prerequisite**: before writing the fix, add a one-line log
to confirm the runner-invalidation hypothesis. If the hypothesis is
wrong, the fix changes but the ordering (RF2/RF3/RF5 safety nets ship
regardless) is unaffected.

**Verification**: Playwright two-tab — `knDiag.forceMisprediction(f=500)`,
assert no `REPLAY-NORUN` event, gameplay hash at f=510 matches the
peer's.

### RF2 — `stepOneFrame` invariant assertion

**Addresses:** F2. Defense-in-depth for R1.

Change [netplay-lockstep.js:4977](../../web/static/netplay-lockstep.js#L4977)
from a silent skip to a loud invariant violation when called during
rollback replay:

```javascript
const stepOneFrame = () => {
  if (!_pendingRunner) {
    if (_useCRollback && _rbReplayLogged) {
      // R2 violation: replay tick has no runner to call.
      // Per §Core principle: log-loud-and-continue. No resync.
      _syncLog(
        `REPLAY-NORUN f=${_frameNum} replayRemaining=${tickMod._kn_get_replay_depth?.() ?? '?'} ` +
        `rbFrame=${tickMod._kn_get_frame?.() ?? '?'} tick=${performance.now().toFixed(1)}`
      );
      if (DEV_BUILD) throw new Error('REPLAY-NORUN');
    }
    return false;
  }
  ...
};
```

Dev throws; prod logs and returns false as today. The analyzer's
new `REPLAY-NORUN` detection surfaces any production occurrence as
a root-cause bug to fix.

**Verification**: WASM unit test — manually null `_pendingRunner`,
call `stepOneFrame` while a replay is in progress, assert
`REPLAY-NORUN` fires with full diagnostic fields and dev builds
throw.

### RF3 — `kn_pre_tick` return-value invariant

**Addresses:** F6. Second defense-in-depth check.

After [netplay-lockstep.js:6341](../../web/static/netplay-lockstep.js#L6341)'s
`const catchingUp = tickMod._kn_pre_tick(...)`, assert that if C just
set `replay_depth > 0`, `catchingUp` must equal 2:

```javascript
const replayDepth = tickMod._kn_get_replay_depth?.() ?? 0;
if (replayDepth > 0 && catchingUp !== 2) {
  // Per §Core principle: log-loud-and-continue. No resync.
  _syncLog(
    `RB-INVARIANT-VIOLATION f=${_frameNum} replayDepth=${replayDepth} ` +
    `catchingUp=${catchingUp} rbFrame=${tickMod._kn_get_frame?.() ?? '?'} ` +
    `replayRemaining=${tickMod._kn_get_replay_depth?.() ?? '?'}`
  );
  if (DEV_BUILD) throw new Error('RB-INVARIANT-VIOLATION');
}
```

This check ships FIRST (before RF1) because it is smallest, highest
safety net, and would have caught the B190OHFY bug on the first run.
Dev throws; prod logs and continues executing whatever `catchingUp`
said (which is the current, broken, behavior — the check is
observation-only, not recovery).

**Verification**: WASM unit test — inject a mock `kn_pre_tick` that
sets `replay_depth` but returns 0, assert violation fires with full
diagnostic fields and dev builds throw.

### RF4 — Dirty-input serialize gate correctness

**Addresses:** F3. Eliminates the ring staleness class.

The gate's current design: skip serialize when no remote input
changed from the previous frame. The assumption was "if inputs are
identical, replay from the last saved frame would produce the same
state." This is not safe when the ring entry for `F - max_frames` has
also been skipped, and then a rollback targets that slot.

**Chosen fix**: validate that every frame in the rollback window has
a valid ring entry *before* skipping. Concretely, at the top of
`kn_pre_tick`'s normal branch, if the dirty gate would skip, first
check that the ring holds an entry within `max_frames` distance of
the current frame that matches the *oldest* frame in the rollback
window. If not, force a save.

Equivalent formulation: every `rb.frame` must satisfy
`ring_frames[(rb.frame - rb.max_frames) % rb.ring_size] == rb.frame - rb.max_frames`
immediately after a save decision, OR the gate must save on this
frame. In plain English: the ring always covers the full rollback
window, even if that means serializing on more frames than the
current gate allows.

Alternative (rejected): disable the gate entirely during rollback
mode. Rejected because the 16MB × 60fps serialize cost (960MB/s) was
a real mobile perf win. The validation check above is a fixed
ring_size-bounded scan (ring_size = `max_frames + 1` ≈ 13 in
production), so the worst-case work is ~13 integer comparisons per
tick = ~780 comparisons/sec. Well under "O(1) in practice" — no
measurable perf regression even on the slowest mobile targets.

**Verification**: Playwright two-tab — induce sustained stick motion
for 10 seconds (ensures inputs change every frame, exercising the
non-skip path), then pause stick (exercising skip path), then force
misprediction that targets the deepest rollback frame. Assert no
`FATAL-RING-STALE` events.

### RF5 — Post-replay live-state hash verification

**Addresses:** F5. Enforces R4.

In `kn_post_tick` on the final replay frame (when `replay_remaining`
decrements to 0), after the RDRAM preserve-restore memcpy at
[kn_rollback.c:954-956](../../build/kn_rollback/kn_rollback.c#L954-L956),
compute two hashes:

1. `kn_gameplay_hash(rb.frame)` from the ring's entry for the
   just-completed frame.
2. A fresh hash of live state via a new `kn_live_gameplay_hash()`
   export that calls `retro_serialize` into a scratch buffer and
   hashes the same gameplay-relevant addresses used by
   `kn_gameplay_hash`.

If they differ, set the mismatch fields (`rb.live_mismatch_f`,
`rb.live_mismatch_replay`, `rb.live_mismatch_live`) and a small
region-level diff buffer. JS polls via
`kn_get_live_mismatch(int* out)` and on hit logs
`RB-LIVE-MISMATCH f=N replay=0x... live=0x... regions=0xAABB...`
with enough detail for the analyzer to pinpoint which subsystem
drifted. **No resync.** Per §Core principle: dev throws, prod logs
and continues. The player sees the broken game, the analyzer
catches it, and the root-cause fix goes back in the queue.

Scratch buffer is static inside `kn_live_gameplay_hash` and reused,
so the verification cost is one `retro_serialize` (~1-2ms) per
rollback completion — acceptable because rollbacks are rare.

**Verification**: force a deliberately-drifting replay via a test
hook that perturbs one RDRAM byte mid-replay, assert
`RB-LIVE-MISMATCH` fires with full diagnostic fields and dev throws.

### RF6 — Audio pipeline survivability (investigate + strengthen signal)

**Addresses:** F7.

The 300-frame AUDIO-DEATH in B190OHFY is strong symptomatic
evidence, but it may be a secondary effect of F1 (no emulation → no
audio samples generated) rather than a separate survivability
problem. RF6 has two parts — strengthen the diagnostic signal so
we can tell, then fix the actual problem.

**Part A — Strengthen AUDIO-DEATH logging (ships first).** The
existing AUDIO-DEATH detection in `analyze_match.py` (commit 91b79e9)
flags when audio-empty or audio-silent events cluster. Augment it
with the following diagnostic fields so we can tell whether a
rollback happened right before audio died:

- Frame distance from the nearest `C-REPLAY start` or
  `C-REPLAY-PREEMPT` event. Under 10 frames = strong correlation
  with a rollback; over 100 = independent.
- `audio-silent` payload fields captured at the time of the first
  silent frame: `ptr`, `alCtx`, `sdlAudio`, `al_state`,
  `audioContext.state`, `audioWorkletPortState`, and the frame
  delta since the last successful `feedAudio` call.
- Count of `kn_reset_audio` calls (JS side) between the last
  rollback event and the first silent frame. If zero and the
  correlation is strong, the rollback path is missing a reset
  call.

The JS side already logs `audio-empty f=N ptr=... alCtx=...
sdlAudio=...` on each frame that the audio worklet runs with no
samples. Extend this log line to also emit the new fields above.
The analyzer parses them and reports an `AUDIO-DEATH` section
enriched with rollback-correlation metadata:

```
AUDIO-DEATH: 32 audio-empty + 1 audio-silent events
  slot=0 f=1110 audio-silent after 300 frames (last=f=810)
    rollback correlation: C-REPLAY done at f=800 (Δ=10f, strong)
    alCtx=1 sdlAudio=none ctxState=running workletPort=open
    kn_reset_audio calls since rollback: 0
    → likely cause: rollback path missed audio reset
```

**Part B — Fix the root cause (ships after RF1-RF5 land).** Run
a real two-tab playtest that triggers rollback. Check the enriched
AUDIO-DEATH report:

- **If zero AUDIO-DEATH events**: RF6 is COMPLETE-BY-ABSORPTION,
  RF1 fixed it, no further work.
- **If AUDIO-DEATH still fires with "likely cause: rollback path
  missed audio reset"**: call `kn_reset_audio` in the C rollback
  restore path immediately after `retro_unserialize` (currently
  only called in the normal frame path at
  [netplay-lockstep.js:6344](../../web/static/netplay-lockstep.js#L6344)
  equivalent).
- **If AUDIO-DEATH fires with a different inferred cause** (e.g.,
  `alCtx` changed, `audioWorkletPort` closed, `ctxState=suspended`):
  diagnose which subsystem lost state across `retro_unserialize` and
  fix at the source. Options: taint audio RDRAM regions the way
  GLideN64 copyback is tainted, or add explicit re-initialization
  of the affected subsystem.

**Conversion rule**: if Part B discovers the audio pipeline has its
own architectural survivability problem (e.g., the AudioWorklet
cannot recover from RDRAM changes without a full tear-down), RF6 is
removed from this spec and handed off to a new
`audio-pipeline-survivability` spec. The handoff trigger: an
investigation finding that RF6 requires changes to files outside
`kn_rollback.c` and netplay JS (e.g., `audio-worklet-processor.js`,
OpenAL plugin internals, EmulatorJS audio bootstrap).

**Verification**: `analyze_match.py` reports zero AUDIO-DEATH events
across the Playwright rollback suite post-fix. The enriched
diagnostic fields are present on every `audio-empty`/`audio-silent`
log line so the analyzer can infer cause without guessing.

### RF7 — Fatal `FAILED-ROLLBACK`

**Addresses:** F4. Enforces R3.

Change [kn_rollback.c:689-692](../../build/kn_rollback/kn_rollback.c#L689-L692)
so when the rollback branch detects a stale ring slot, it sets a
fatal flag instead of just incrementing `failed_rollbacks`:

```c
} else {
    rb.failed_rollbacks++;
    rb.fatal_stale_f = rb_frame;
    rb.fatal_stale_ring_idx = ring_idx;
    rb.fatal_stale_actual = rb.ring_frames[ring_idx];
    rb_log("FATAL-RING-STALE f=%d ring[%d]=%d depth=%d", ...);
}
```

New export `kn_get_fatal_stale(int* out_f, int* out_idx, int* out_actual)`
returns 1 if fatal, writes the three fields, clears the flag. JS
polls every tick and, per §Core principle, **logs
`FATAL-RING-STALE f=N ring[idx]=actual depth=D` and continues**.
Dev builds throw. No resync.

This ships AFTER RF4. Order matters: RF4 fixes the bug class (stale
slots inside the window shouldn't exist); RF7 makes any residual
violation loud instead of silent. With RF4 landed, any subsequent
`FATAL-RING-STALE` event means a real new bug to diagnose, not a
recovery scenario. Shipping RF7 before RF4 would spam violation
logs for every legitimate stale-ring case already in production.

**Verification**: WASM unit test — set `max_frames` to a very small
value and induce rollback. Assert `FATAL-RING-STALE` fires with
full diagnostic fields and dev throws. After RF4 lands, same test
with normal `max_frames` — assert zero `FATAL-RING-STALE` events.

## Verification harness

### V1 — WASM-level rollback integrity test

New export `kn_rollback_integrity_test(int n_frames)`:

1. Set `kn_headless(1)` and save state A via `retro_serialize` into
   scratch buffer.
2. Run `n_frames` forward via `retro_run`, hash live state → B.
3. Restore A via `retro_unserialize`.
4. Force a 1-frame misprediction: feed a "real" input that differs
   from what the predictor stored for frame 1.
5. Drive `kn_pre_tick`/`kn_post_tick` manually through the rollback
   + replay path, letting the normal amortized loop run.
6. Hash live state after replay completes → B'.
7. Assert `B == B'`. Return 1 on success, 0 on mismatch.

This is a pure WASM determinism test — no network, no peer, no
Playwright. It is the kind of test that would have caught F1 on the
first run. Driver is `tests/rollback-integrity.spec.mjs` which loads
a ROM, runs the export, asserts success.

### V2 — Playwright two-tab rollback scenarios

Reuses the `tests/deadlock-harness.html` infrastructure from the
companion deadlock spec's MF6 verification layer. Adds one new
`knDiag` hook:

```javascript
knDiag.forceMisprediction(slot, frame, {lxDelta, buttonXor});
```

which pushes a fake late input via the normal `kn_feed_input` path
so the rollback fires exactly as it would in production.

Scenarios (one `.spec.mjs` each under `tests/rollback/`):

| Scenario | Fault injection | Assertion |
|---|---|---|
| RF1 | Force misprediction at f=500 | Zero `REPLAY-NORUN`; gameplay hash at f=510 matches peer |
| RF2 | Null `_pendingRunner` during replay | `REPLAY-NORUN` fires with full fields; dev build throws |
| RF3 | Mock `kn_pre_tick` returns 0 with `replay_depth=9` | `RB-INVARIANT-VIOLATION` fires |
| RF4 | Sustained ring-pressure: rapid rollbacks at max depth for 30s | Zero `FATAL-RING-STALE` events |
| RF5 | Perturb one RDRAM byte mid-replay via test hook | `RB-LIVE-MISMATCH` fires with correct addresses |
| RF6 | Real two-tab rollback session | Zero AUDIO-DEATH events |
| RF7 | Set `max_frames=2`, force depth-5 misprediction | `FATAL-RING-STALE` fires once with full diagnostic fields; dev build throws; prod logs and continues (no resync) |

### V3 — Analyzer regression lock

`tools/analyze_match.py` gains detection for:

- `REPLAY-NORUN`
- `RB-INVARIANT-VIOLATION`
- `FATAL-RING-STALE`
- `RB-LIVE-MISMATCH`

These live in the existing `query_freeze_detection` section
alongside the deadlock spec's `TICK-STUCK` and the existing
`AUDIO-DEATH`. A passing verification run shows zero events of any
of these types across all real session logs flushed to prod
post-deploy. Non-zero = shipped bug.

**Behavior change to an already-shipped analyzer rule**: the
existing `ROLLBACK-RESTORE-CORRUPTION` detection added in commit
91b79e9 stays, but its comparison logic is replaced as part of RF5.
Today it pairs `C-REPLAY done`'s `gp=` with the next
`RB-POST-RB`'s `gp=`, which is noisy because the two hashes can be
computed from different ring reads and don't always represent the
same logical frame. Post-RF5 it compares the new
`kn_live_gameplay_hash` result against the ring hash at the same
frame — a direct check that the live emulator matches what the
ring claims. The event name and JSON output shape stay the same so
downstream consumers (alerts, dashboards) keep working.

## Documentation

1. **`docs/netplay-invariants.md`** — new §Rollback Integrity section
   describing R1-R6 in prose with cross-references to code. If the
   file doesn't exist yet (depends on deadlock spec ordering), this
   spec creates it with only the R section and deadlock spec adds
   its I section later.
2. **`CLAUDE.md`** — rollback invariants bullet added to the
   "Netplay invariants" subsection (which deadlock spec creates).
3. **Inline comments** — every `retro_unserialize` call, every
   `stepOneFrame` call, every ring-slot write gets a block comment
   naming the invariant it satisfies. Format:

   ```c
   // R1: retro_unserialize invalidates the rAF runner. JS re-captures
   // via kn_rollback_did_restore + pauseMainLoop/resumeMainLoop.
   retro_unserialize(rb.ring_bufs[ring_idx], rb.state_size);
   ```

4. **Changelog entry** — `CHANGELOG.md` records RF1-RF7 as
   `fix(rollback): eliminate state integrity class ...` per
   conventional commits.

## Implementation order

Each RF is one commit. Each commit: failing test first, then fix,
then `analyze_match.py` verification on a fresh two-tab session
before moving on.

1. **RF3** — `kn_pre_tick` return-value assertion. Smallest change,
   highest safety net, would have caught B190OHFY regardless of
   root cause. Ships first as the insurance policy.
2. **RF2** — `stepOneFrame` invariant assertion. Second safety net.
3. **RF1** — re-capture `_pendingRunner`. Root-cause fix for
   B190OHFY. Prerequisite: confirm runner-invalidation hypothesis
   via targeted log before the fix lands.
4. **RF4** — dirty-input gate correctness. Eliminates the
   ring-staleness bug class at the source, so RF7's loud violation
   only fires for genuine residual violations.
5. **RF7** — loud `FAILED-ROLLBACK`. Ships after RF4 (never
   before) so the changeover doesn't spam violation logs for every
   legitimate stale-ring case already in production. With RF4
   landed, any subsequent `FATAL-RING-STALE` event means a real
   new bug to diagnose (not a recovery scenario — per §Core
   principle, there is no recovery).
6. **RF5** — post-replay live-state hash verification. Catches any
   residual drift past RF1-RF4.
7. **RF6** — audio pipeline investigation. May be absorbed by
   RF1-RF5; only code if residual AUDIO-DEATH events remain.
8. **Test harness + analyzer + docs** — one commit each.

## Risks and mitigations

- **RF1 hypothesis is wrong.** If runner invalidation isn't the
  root cause, the fix at RF1 doesn't help. Mitigation: RF2 and RF3
  are mechanism-agnostic — they catch wrong-state replay regardless
  of cause. If RF1 lands and B190OHFY-class corruption still occurs
  in Playwright, we reopen the investigation with the now-loud
  invariant violations as telemetry.
- **RF4 perf regression.** Forcing saves to cover the rollback
  window will increase serialize frequency on stable networks.
  Mitigation: instrument the serialize skip rate in
  `analyze_match.py` and compare pre/post-RF4 on real sessions.
  If mobile frame times regress, tighten the check to save only the
  one frame that would otherwise leave a stale slot (not all frames
  in the window).
- **RF7 log spam if ordering gets reversed.** If RF7 is merged
  before RF4, every legitimate stale-ring case fires
  `FATAL-RING-STALE` — no resync (per §Core principle) but the
  logs get noisy and dev builds throw on every session.
  Mitigation: the implementation order (step 4 = RF4, step 5 =
  RF7) is a hard requirement. Each PR description names the
  ordering rule so a reviewer catches a mis-ordered merge.
- **RF5 verification cost.** Fresh `retro_serialize` per rollback
  completion is ~1-2ms. Rollbacks are rare (single-digit per match),
  so total overhead is negligible. Mitigation: static scratch
  buffer reuse, already planned.
- **Companion-spec drift.** If the deadlock spec lands
  `docs/netplay-invariants.md` before this one and we diverge on
  formatting or section style, the docs get inconsistent.
  Mitigation: explicit coordination rule (below) — whoever lands
  first sets the template.

## Coordination with deadlock-audit spec

The deadlock spec is already in implementation. Rules:

- **Separate commits.** No RF commit touches files owned by a
  deadlock MF commit unless a rebase is required.
- **Shared files.**
  - `docs/netplay-invariants.md`: whichever spec lands a section
    first creates the file with its section; the other adds to it.
  - `tools/analyze_match.py`: each spec adds distinct event
    detections; no shared code paths.
  - `tests/deadlock-harness.html` / `knDiag`: rollback spec
    *reuses* the harness and adds `knDiag.forceMisprediction`.
    Deadlock spec owns the file's creation.
  - `CLAUDE.md`: deadlock spec adds the "Netplay invariants"
    subsection; rollback spec appends its bullets to it.
- **Rebase rule.** If a deadlock MF commit touches a file this spec
  also needs to change, this spec's commit rebases on the deadlock
  commit. Never the other way around (deadlock is already in
  implementation).
- **Detection naming.** All rollback events use `RB-*` or
  `REPLAY-*` prefixes. All deadlock events use `TICK-*`, `PEER-*`,
  `*-TIMEOUT` prefixes. No name collisions.
- **Invariant prefixes.** Deadlock: `I*`. Rollback: `R*`. No
  renumbering.

## Out of scope for this spec

- Cross-peer consensus protocols beyond the existing `rb-check:`
  hash exchange.
- Replacing the amortized replay with synchronous retro_run from C
  (the project tried this once and `project_rollback_working.md`
  documents why the amortized approach is correct).
- Formal verification of `kn_pre_tick`/`kn_post_tick` state
  transitions.
- Audio-pipeline survivability fixes beyond what RF6 investigates.
  If RF6 finds a broader architectural problem (e.g.,
  AudioWorklet fundamentally incompatible with retro_unserialize),
  that is a separate spec.
- Tick-loop stall fixes — owned by the deadlock spec.
- Per-peer JS state cleanup — owned by the deadlock spec's MF1.
