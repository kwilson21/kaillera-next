# Codex prompt: rollback smoothness iteration 3 — fix shadow flicker, drop the nudge

## Context

Read these first for background, measurement protocol, and architectural constraints:

- [docs/codex-perf-iteration-prompt.md](codex-perf-iteration-prompt.md) — iteration loop, measurement protocol, determinism guardrail.
- [docs/codex-rollback-smoothness-prompt.md](codex-rollback-smoothness-prompt.md) — iter 1 problem statement and what was tried.
- [docs/codex-rollback-smoothness-iter2.md](codex-rollback-smoothness-iter2.md) — perceptual + mechanical levers, what's already shipped through the perf track.
- [docs/codex-true-rollback-netcode.md](codex-true-rollback-netcode.md) — the true-rollback netcode shift that gave us "local input at current frame" and the current 1-frame local lag.
- [docs/research/fullheadless-webgl-investigation.md](research/fullheadless-webgl-investigation.md) — why `?fullHeadless=1` is off-limits.
- [docs/netplay-invariants.md](netplay-invariants.md) — **must read.** R1-R6 are mandatory. No exceptions.

This iteration is one architectural cleanup with four tightly-coupled changes. They land in a single branch.

## What the user perceives today

Two presentation paths exist; both have a residual artifact:

1. **Shadow worker path** (`?shadowEmu=1`). When it works, gameplay feels "completely smooth" — no perceived pause during rollback. Blocker: the worker overlay flickers/black-flashes at the show or hide moment of each rollback. The flicker is worse than the pause it replaces.
2. **Split-RDRAM + motion nudge path** (`?rollbackStateBackend=split-rdram`, no shadow). No perceived pause. New artifact: the screen "twitches" — a subtle 2-3px wobble that the player notices even when standing still.

The user's directive: **the game should just run smoothly**. No twitch. No flicker. No pause. The motion nudge is fundamentally a hack — it papers over a 30 ms pause with motion that doesn't match game state. It will always read as twitch in some context. The shadow path is the only mechanism that produces *real* forward simulation under the overlay; if it can be made flicker-free, it is the answer.

## The architectural shift

**Drop the motion nudge entirely. Ship shadow + split-RDRAM as the default smooth path. Snapshot-freeze stays as the fallback when shadow can't produce a fresh frame in time.**

- Today: `replayMotionNudge=1` default-on; shadow opt-in via `?shadowEmu=1`.
- Proposed: shadow + split-RDRAM default-on once flicker-free; nudge becomes opt-in diagnostic via `?replayMotionNudge=1`, default-off.

The four changes below address the three root causes of shadow flicker. They must ship together — partial landings will leave the user worse off than today.

## What's already shipped (do NOT revert, do NOT redo)

Preserve all of:

- `87738d7 feat(rollback): add local-input replay mask smoothing` — kept until shadow is flicker-free; the nudge is the current default safety net.
- `b4fcc28 docs(research): full-headless WebGL flood investigation findings`
- `845604a fix(rollback): widen C-engine pacing threshold under true rollback`
- `212493b perf(rollback): skip KNDesync.tick when no real peer is connected`
- `7a10694 fix(rollback): widen stall + rb-check thresholds to match true-rollback cap`
- `453b24c feat(rollback): true rollback netcode — local input at current frame`
- `a4bc61e perf(rollback): skip KNDesync.tick during replay frames`

Current measured baseline (true-rollback + perf cuts, no shadow, nudge on, split-RDRAM):

- TICK p95: ~20-21 ms
- Replay wall: ~30 ms median, depth ~5
- Rollbacks: ~5/sec
- `failed_rollbacks=0`, `replayBisect(30)=0 bytes differ`
- Visual mask covers rollback for ~30 ms

## What's off-limits (do not propose retrying any of these)

- **`?fullHeadless=1`**: floods WebGL "no valid shader program" under real rollback. See `docs/research/fullheadless-webgl-investigation.md`. The investigation found the un-skipped `FrameBufferList::renderBuffer` path; no fix yet. Do not enable by default and do not gate any of this iteration's changes on full-headless.
- **`replayBurst > 4` as default**. Tested up to 8 — no help.
- **Increasing input delay**. Rejected by user; the true-rollback work explicitly took us to 1-frame local lag.
- **Resync-style desync masking**. Real rollback integrity required.
- **Anything that breaks `replayBisect(30)` within-peer determinism.**
- **Reverting any commit listed above.**
- **Naive WebGL texture-ring overlays as a "predictive frame" mechanism**. Tried, flickers. Only revisit with a specific anti-flicker mechanism.

## Root cause analysis (the three causes of shadow flicker)

### Cause A — Stale-worker-frame-at-show

The worker (`web/static/rollback-shadow-worker.js`) runs strictly forward and is *behind* authoritative whenever it isn't pumping. When `_shadowShowOverlay` ([web/static/netplay-rollback.js:1708](../web/static/netplay-rollback.js#L1708)) fires:

- It synchronously sets `overlay.visibility=visible`, `opacity=0.86`, hides live canvas.
- The `OffscreenCanvas` already has a **previously-composited worker frame** in its swap chain — almost always older than the live frame the user was just looking at.
- The browser composites *that stale worker frame* on the very next vsync, before the worker has wall-clock time to step forward.
- User sees: `live frame N (clean) → cut → worker frame N-K (older, different scene) → worker catches up`.

The cut **is the flicker**.

The `shadowReplayLead` and `shadowPump` paths exist to eliminate this. Comments in [netplay-rollback.js:1759-1767](../web/static/netplay-rollback.js#L1759) admit the pump's `setTimeout(0)` tasks get starved by main-thread `step` traffic, so the pump effectively never runs in practice.

### Cause B — Resync black frame

`_shadowDoHideOverlay` calls `_shadowStopPump`. After the next worker `loadStateImmediate` ([rollback-shadow-worker.js:306](../web/static/rollback-shadow-worker.js#L306)), the very next `stepOnce` produces a frame where GLideN64 hasn't re-bound its framebuffers — output reads as black or transitional. The worker's `_shadowPaintGate` exists to suppress shows on these frames, but `shadowPaintGate=0` in the user's known-best config because the gate's "fresh" check trips too easily and falls back to JS snapshot too often. Net: the gate is off and bad frames slip through.

The code's own comment at [netplay-rollback.js:1388-1396](../web/static/netplay-rollback.js#L1388) documents this: *"when overlay shows a bad worker frame, the user sees a clean black flash with no fallback content."*

### Cause C — Worker output drift from vsync

The worker pumps via `setTimeout(16ms)` in [rollback-shadow-worker.js:410-430](../web/static/rollback-shadow-worker.js#L410). Browsers composite at vsync (~16.6 ms). When `setTimeout` jitter pushes worker output a few ms past vsync, the same worker frame gets composited twice → judder. This is on top of Cause A.

### Why nudge causes twitch (separate root cause for the split-RDRAM path)

`_inputToRollbackCanvasNudge` ([netplay-rollback.js:1125](../web/static/netplay-rollback.js#L1125)) maps **stick magnitude** → translate distance:

- N64 sticks are ~digital under combat. Same input produces same nudge whether the character is dashing, in stun, or whiffing.
- EWMA `0.35*prev + 0.65*now` snaps direction reversals back hard.
- Nudge fires per rollback (~5/sec) regardless of whether anything is moving on screen.
- Standing still: rollback → tiny jerk in stick direction → snap-back at end of `holdMs` → user-visible twitch.

The fix is not "make the nudge smarter" — any stick-driven nudge will desync from on-screen motion in some contexts. The fix is to remove the need for a nudge by making the shadow path actually smooth.

## The four changes

Ship in the order below. Each is independently committable; the user-visible default flip happens only after all four have landed and been verified subjectively.

### Change 1 — Tighten the shadow paint gate; default it on

**File:** [web/static/netplay-rollback.js](../web/static/netplay-rollback.js)

**Today** ([netplay-rollback.js:674-680](../web/static/netplay-rollback.js#L674), [1307-1313](../web/static/netplay-rollback.js#L1307), [1721-1728](../web/static/netplay-rollback.js#L1721)):

- `RB_SHADOW_PAINT_GATE` defaults to `false`.
- `_shadowPaintGate` checks `_rbShadowNeedsFreshPaint`, `_rbShadowLastLooksBlack`, and a 750 ms staleness timer.
- `_shadowShowOverlay` calls `_shadowPaintGate()` and falls through to `_shadowPostStep('replay-warmup', …)` when blocked, but does NOT show the overlay — the user sees the JS snapshot freeze instead.

**Proposed:**

- Default `RB_SHADOW_PAINT_GATE` to `true`.
- Tighten `_shadowPaintGate` to ALSO require `_rbShadowLastPaintFrame >= _frameNum - 1`. The current "non-black" check is necessary but not sufficient — a non-black worker frame from N-30 is still a stale-frame-at-show artifact.
- When the gate blocks, fall through to the JS snapshot freeze for *this* rollback rather than skipping presentation entirely.

**Why it might help.** Eliminates Cause B (resync black frame) immediately. Reduces Cause A (stale-frame-at-show) by also rejecting non-fresh non-black frames.

**Determinism risk:** zero — presentation-only.

**Failure mode:** if gate fires too aggressively, the user sees the JS snapshot freeze (today's nudge fallback) instead of the shadow more often than expected — i.e., the perceived pause partially returns. Counter for `freshShowsSkipped + blackShowsSkipped` should not exceed ~30% of `shows`. If it does, Change 2 must land before this is left default-on.

**Validation:**

- `replayBisect(30) = 0 bytes differ` — unaffected.
- `failed_rollbacks = 0` over 5-min demo — unaffected.
- New diagnostic counter: `_getShadowStats().freshShowsSkipped`, `blackShowsSkipped`, `shows`. Track the ratio.
- Subjective: side-by-side compare `?shadowEmu=1&shadowPaintGate=0` vs `?shadowEmu=1&shadowPaintGate=1` over 60 seconds in-match. Count visible flicker events.

### Change 2 — Drive worker steps from main rAF; replace setTimeout pump

**Files:** [web/static/netplay-rollback.js](../web/static/netplay-rollback.js), [web/static/rollback-shadow-worker.js](../web/static/rollback-shadow-worker.js)

**Today.** Worker's `pumpTick` ([rollback-shadow-worker.js:410](../web/static/rollback-shadow-worker.js#L410)) self-paces via `setTimeout(16)`. Comments at [netplay-rollback.js:1761-1767](../web/static/netplay-rollback.js#L1761) admit the pump's tasks are starved by main's 60 Hz `step` traffic and rarely fire.

**Proposed.**

- Main thread runs an `APISandbox.nativeRAF` loop while `_rbShadowVisible === true`. Per rAF tick:
  1. Post `{type: 'step', count: 1, frame: _frameNum, inputs: …, wantSample: true}` to worker.
  2. Worker advances one frame, samples for black, sends a `stepped` ack with the frame number.
  3. Worker `OffscreenCanvas` commit happens at the end of the worker task; the next browser composite picks it up at the next vsync — exactly one fresh worker frame per vsync.
- Delete the worker `pumpTick` / `start-pump` / `stop-pump` paths (or keep them behind a flag for diagnostic A/B). The shadow `RB_SHADOW_PUMP` URL flag becomes meaningless under the new pump.
- Pre-warm: before `_shadowShowOverlay` actually sets `visibility:visible`, post one synchronous `step` and wait for the `stepped` ack with a `~6 ms` budget. If ack arrives in time and `black === false`, show the overlay; if not, fall through to JS snapshot freeze for this rollback (same fallback Change 1 added).

**Why it might help.** Eliminates Cause A (stale-frame-at-show — pre-warm guarantees a fresh frame is in the swap chain before show), eliminates Cause C (drift from vsync — main rAF posts synchronously to vsync cadence).

**Determinism risk:** zero — worker stays presentation-only.

**Perf risk.** Worker must sustain one `stepOnce` per vsync (~16 ms wall budget per vsync; SoftFloat WASM step is ~3-5 ms in Safari, ~5-7 ms in V8 per `project_rollback_benchmark.md`). Headroom is comfortable but not infinite. If the worker falls behind for a frame, the rAF loop should skip-and-retry rather than queue up backlog — log `worker_lagged` counter and surface in HUD.

**Failure mode.** If `OffscreenCanvas.transferToImageBitmap` (or equivalent commit primitive) doesn't compose at vsync as expected on Safari/iOS, the rAF-driven pump degrades to the same drift problem as setTimeout. Mitigate by detecting double-composite (track `commits_per_show` ≥ frames-elapsed) and disabling the new pump in favour of the old setTimeout pump.

**Validation:**

- `replayBisect(30) = 0 bytes differ` — unaffected.
- `failed_rollbacks = 0` over 5-min demo — unaffected.
- TICK p95 must NOT regress beyond current ~21 ms. Worker step happens off-main-thread but the rAF dispatch is on-main; budget should be sub-1 ms.
- New counters: `worker_commits_per_show` (target ≥ depth+1 over each show window), `worker_lagged` (target near zero), `pre_warm_acks_in_budget` / `pre_warm_acks_late`.
- Subjective: `?shadowEmu=1&shadowPaintGate=1&shadowPump=raf` vs same with pump=off. Should be measurably less flicker than Change 1 alone.

### Change 3 — Resync worker per replay end (not 1/sec)

**File:** [web/static/netplay-rollback.js](../web/static/netplay-rollback.js), worker resync path

**Today.** `RB_SHADOW_RESYNC_MIN_MS = 1000` ([netplay-rollback.js:592-601](../web/static/netplay-rollback.js#L592)) caps shadow resyncs to once per second. `_finishCReplay` calls `_shadowScheduleResync('post-replay')` ([netplay-rollback.js:8757](../web/static/netplay-rollback.js#L8757)) but the schedule is debounced. Effect: worker can be up to 1 second behind authoritative state in terms of input accuracy. With ~5 rollbacks/sec, the worker is showing "what would have happened if remote inputs froze ~500 ms ago" on average. That stale-state difference is what reads as a *jump* at show time, on top of the stale-frame race in Cause A.

**Proposed.**

- Lower `RB_SHADOW_RESYNC_MIN_MS` default to 0 — resync per replay end.
- Wire shadow to consume the same `kn_sync_read_cpu` snapshot the rollback engine already produces every frame under `?rollbackStateBackend=split-rdram` ([build/kn_rollback/kn_rollback.c](../build/kn_rollback/kn_rollback.c)). Avoid the heavy `gameManager.getState()` (libretro retro_serialize) path entirely on the per-replay-end resync path. Reserve the heavy retro_serialize path for boot and explicit state-out events.
- Confirm that the per-frame `kn_sync_read_cpu` snapshot is byte-equivalent to what `_kn_load_state_immediate` expects on the worker side. If not, expose a paired `kn_get_split_state_for_shadow` / worker `kn_load_split_state` that operates on the same RDRAM ring.
- Per-replay-end resync becomes: get split snapshot pointer + length from C engine on main → `postMessage({type:'resync', state, frame, reason})` to worker (transferable) → worker `_kn_load_state_immediate`.

**Why it might help.** Worker stays within ~30 ms of authoritative state. Even if Change 2 has a one-frame stale moment at show, "stale by one frame from same scene" is invisible; "stale by 500 ms in a different scene" is the jump the user perceives today.

**Determinism risk:** real-but-bounded. Worker remains presentation-only; if a split snapshot under-restores some libretro state (timer counters, audio scratch), the worker frame will look slightly wrong but the authoritative simulation is untouched. Verify that the split-RDRAM path restores enough state for the worker to render plausible frames; if not, fall back to retro_serialize for the resync transfer (more expensive but always correct).

**Perf risk.** `getState()` full retro_serialize is ~3-5 ms on main thread. Per-replay-end at 5/sec = up to 25 ms/sec of main-thread time. Unacceptable. The split snapshot is the cheap path; if it can't be used, resync per replay end is NOT viable and we keep the 1-sec debounce.

**Failure mode.** If split snapshot can't represent enough state for the worker, fall back to the existing 1-sec debounced retro_serialize path. Counter: `resync_via_split` / `resync_via_retro` ratio. Target: split path used for ≥ 90% of resyncs in steady-state rollback.

**Validation:**

- `replayBisect(30) = 0 bytes differ` — unaffected (worker resync doesn't touch authoritative).
- `failed_rollbacks = 0` over 5-min demo — unaffected.
- TICK p95 must NOT regress. Each per-replay-end resync should add < 0.5 ms to the tick.
- New counter: `resync_via_split` vs `resync_via_retro`, `resync_post_message_ms`, `resync_load_immediate_ms` (worker-side).
- Subjective: Change 1 + 2 + 3 should produce zero "jump from different scene" flicker. Remaining flicker (if any) is now diagnosable as a Change 2 race or a Change 3 split-snapshot incompleteness.

### Change 4 — Drop the motion nudge as default; gate behind opt-in

**File:** [web/static/netplay-rollback.js](../web/static/netplay-rollback.js)

**Today.** `RB_REPLAY_MOTION_NUDGE` defaults to `true` ([netplay-rollback.js:790-801](../web/static/netplay-rollback.js#L790)). `_startRollbackCanvasNudge` ([netplay-rollback.js:1150](../web/static/netplay-rollback.js#L1150)) fires per rollback, translating the live canvas by ~2.25 px / 48 ms based on stick input.

**Proposed.**

- Flip `RB_REPLAY_MOTION_NUDGE` default to `false`. Keep the URL flag and localStorage key for diagnostic A/B.
- Flip `RB_SHADOW_EMU` default to `true`. Keep the URL flag for opt-out.
- Default `RB_ROLLBACK_STATE_BACKEND` to `'split-rdram'` once Change 3 has shipped and split-snapshot worker resync is verified.
- Leave the JS snapshot freeze (`_rbVisualFreezeOverlay`) intact as the gate-blocked fallback. It still provides "no pause beyond what Change 1 gates."

**Why.** With Changes 1-3 landed, the shadow path produces fresh authoritative-state frames at vsync cadence with no flicker. The nudge becomes redundant. Removing it eliminates the twitch artifact entirely.

**Determinism risk:** zero.

**Failure mode.** If real-match conditions expose flicker that demo testing didn't (high-RTT moments, browser tab demotion, mobile thermal throttling), the nudge can be re-enabled per-user via URL flag or localStorage as a temporary workaround. Telemetry: count how many sessions opt back in.

**Validation:**

- `replayBisect(30) = 0 bytes differ` — unaffected.
- `failed_rollbacks = 0` over 5-min real-browser run — unaffected.
- TICK p95 — should *improve* slightly (no per-rollback rAF loop for nudge step).
- Subjective: 5-minute SSB64 in-match session feels smooth, no twitch, no flicker, no pause.

## Cross-peer determinism guard

None of these changes touch the simulation layer or input pipeline, so the cross-peer determinism story is unchanged from `docs/codex-true-rollback-netcode.md`. Verify with the standard:

- `replayBisect(30)` after each change.
- 5-min two-tab Playwright with synthetic peer disabled, `kn_gameplay_hash` and `kn_full_state_hash` broadcast every 60 frames, asserted equal.

If Change 3's split-snapshot path turns out to be the wrong shape for the worker, fall back to retro_serialize on the resync path — do not invent a partial-state bridge.

## Validation requirements (apply to all four changes)

For each commit and at the end of the branch:

1. **Within-peer determinism:** `window.knDiag?.replayBisect(30)` returns `0/N bytes differ`. The C-side `replaySelfTest` flake is known and out of scope.
2. **Replay correctness:** `failed_rollbacks` count over a 5-min demo run stays at zero. R3 (`FATAL-RING-STALE`) and R4 (`RB-LIVE-MISMATCH`) zero.
3. **TICK p95** does not regress from current ~20-21 ms baseline.
4. **Cross-peer determinism**, two-tab Playwright, 5 min: zero divergence on `kn_gameplay_hash` / `kn_full_state_hash`.
5. **Subjective is the headline.** Each commit should be exercised in a real two-browser session for at least 60 seconds in-match. Note: smoother / same / worse, and what artifact (if any) replaced the artifact you were targeting.
6. **New diagnostic counters** (per change above) surfaced in `knDiag` output so subjective sessions are backed by data.

## Order of work

1. **Change 1 first** (1-2 hours). Pure JS, no architecture change, immediate A/B. Worst case: more snapshot-freeze fallbacks (regression to today's nudge-style pause). Best case: meaningful flicker reduction with no further work.
2. **Change 2 second** (1 day). The hard one. Worker pump rewrite. Verify Safari + V8 + iOS all sustain the rAF-driven cadence before treating it as default.
3. **Change 3 third** (half day, plus C engine audit). Wires shadow to split-RDRAM's per-frame snapshot. Needs verifying the snapshot is sufficient for worker rendering; if not, retro_serialize fallback keeps things working at the 1-sec cadence.
4. **Change 4 last** (5 minutes of code, plus a verification run). Flag flips. Only after Changes 1-3 are subjectively verified flicker-free.

The default-flip in Change 4 must NOT land until a multi-browser real-match session confirms zero flicker. Stage with `localStorage.setItem('kn-shadow-emu', '1')` for the user's own machine first; flip the URL/code default only after multi-session subjective validation.

## Risk register

1. **Change 1 fallback rate too high.** If the tightened gate causes >30% snapshot-freeze fallback, the perceived pause is back. Mitigate: don't ship Change 1 default-on until Change 2 has reduced the stale-frame race.
2. **Change 2 worker can't sustain vsync cadence on V8/Android.** Mitigate: detect via `worker_lagged` counter, fall back to skip-and-catch-up; degrade to old setTimeout pump as last resort.
3. **Change 3 split snapshot is incomplete for worker rendering.** Mitigate: retro_serialize fallback. Counter the split-vs-retro split.
4. **Change 4 default-flip exposes a real-match issue not seen in demo.** Mitigate: keep nudge accessible via URL flag; telemetry on opt-back-in rate.
5. **`?fullHeadless=1` interaction.** None of these changes should re-enable or depend on full headless. If you find yourself reaching for it to make Change 2 viable, stop and surface the constraint to the user — full headless is off-limits until the WebGL flood is rooted out separately.

## Constraints (carry over from prior iterations)

- Read [docs/netplay-invariants.md](netplay-invariants.md). R1-R6 are non-negotiable.
- `window.knDiag?.replaySelfTest(30)` C-side path is known flaky; use `replayBisect(30)` as the within-peer regression gate.
- Don't deploy. User reviews + tests.
- WASM rebuilds via `docker` + `just deploy` happen automatically (`feedback_wasm_rebuild_auto.md`).
- Don't reintroduce flicker, frame drops, or determinism failures.
- Commit per change with the standard format: change name (one sentence), baseline TICK-PERF, post-fix TICK-PERF, rollback/mispredict delta, replayBisect result, subjective notes.

## Reporting

Final PR report should include:

- Pre/post tick perf, replay duration.
- Pre/post flicker rate (subjective + `freshShowsSkipped`/`blackShowsSkipped`/`worker_lagged` counters).
- `failed_rollbacks` count over 5-min demo run + any R3/R4 invariant log lines (must be zero).
- Cross-peer determinism test outcome.
- Subjective: did the rollback become invisible? In what context (if any) does an artifact remain?
- One-line summary: "Shadow path now flicker-free; nudge default-off; rollback subjectively invisible at X% of events."

If a change makes things subjectively worse despite metrics looking fine, revert it and write up *why*. The "why" matters more than the metric.
