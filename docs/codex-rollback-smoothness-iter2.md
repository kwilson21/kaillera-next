# Codex prompt: rollback smoothness iteration 2

## Context

Iteration 2 of the rollback smoothness work. Read these first for the iteration loop, measurement protocol, and architectural background:
- [docs/codex-perf-iteration-prompt.md](codex-perf-iteration-prompt.md) — umbrella iteration doc (measure / commit per-optimization / determinism guardrail / file pointers).
- [docs/codex-rollback-smoothness-prompt.md](codex-rollback-smoothness-prompt.md) — iter 1: problem statement, what was tried and rejected, and the H / H-RDP-only / D / E / F option set.

This doc adds 8 new ideas that go beyond "increase replayBurst" and assumes the iter-1 wins have shipped.

## What's already shipped (do NOT revert, do NOT redo)

The current default behavior on `main`:

- `replayBurst=4`, `replayBurstBudgetMs=10`, escape `?replayBurst=1` (commit `3a2c21b`).
- `replayVisualFadeMs=0` — no post-replay fade-out (commit `a3cc1d4`).
- `replayVisualFadeDuring=0` — overlay stays opaque during replay.
- H-RDP-only native skip enabled by default; JS sets `_kn_set_skip_rdp_replay(1)` during replay only; GLideN64 skips raster + framebuffer/depth copybacks. Escape `?replaySkipRdp=0`. Cross-peer capability handshake refuses rollback if `rdpReplaySkip` mismatches; synthetic demo peers excluded. Commit `1e81361`.

Current best no-query default measurements (30s steady-state demo, random P2):

- TICK last median/p95: `16.5 / 22.4 ms`
- TICK max p95: `22.9 ms`
- rolling p95/max: `21.43 / 22.77 ms`
- replay median/p95/max: `29.9 / 40.2 / 62.2 ms`
- rollback `+228`, mispredict `+810`, failed rollbacks: `0`

User reports rollback events are still subjectively visible as brief hitches even with the above shipped — the perceived pause is shorter but not eliminated.

## What's still off-limits (don't propose retrying)

- **Full headless replay** (`kn_set_headless` skipping all GL): tick p95 spiked to `31-44ms`, replay duration didn't materially improve. Already concluded "do not use."
- **`replayBurst > 4` as default**: burst8 didn't help replay duration and worsened p95. Use the existing `?replayBurst=` for opt-in only.
- **Skipping RSP / audio task processing during replay**: explicit user sign-off required. The current H-RDP-only is the agreed safe variant.
- **Resync-style desync masking**: pre-existing `replaySelfTest(30)` non-determinism is real and concerning; do not mask it. Surface it back to the user with a separate diagnostic if you encounter it during this work.

## The 8 candidates

For each: **idea / why it might help / determinism risk / implementation sketch / measurement / kill criteria.**

### A. CSS speed-line flash on the mask

**Idea.** During the mask's lifetime (currently ~30-60ms), apply a subtle CSS filter animation that styles the moment as a "fast cut" rather than a freeze. Sub-100ms `blur(2px) saturate(1.15)` ramping in then out, similar to fighting-game super-flash framing.

**Why it might help.** Reframes perception: brain reads "stylish hitch" instead of "broken pause." Pure visual psychology — no actual motion content added. Fighting games and JRPGs use this technique constantly to absorb frame-pacing irregularities.

**Determinism risk.** Zero. Pure CSS animation on the existing overlay element.

**Implementation sketch.**
- In `_showRollbackVisualFreeze` ([web/static/netplay-rollback.js](../web/static/netplay-rollback.js)), after `overlay.style.display = 'block'`, set `overlay.style.animation = 'kn-rollback-flash 32ms ease-in-out'`.
- Inject keyframes once at module load: `0% { filter: blur(0) saturate(1) }, 35% { filter: blur(2px) saturate(1.15) }, 100% { filter: blur(0) saturate(1) }`.
- In `_hideRollbackVisualFreeze`, clear `overlay.style.animation`.
- Add `?replayMaskFlash=0` escape hatch.

**Measurement.** Subjective primarily. A/B test with `?replayMaskFlash=1` first, then ship as default if better. TICK-PERF and replay duration should not regress at all (CSS filters are GPU-composited, not main-thread blocking) — verify with the same TICK-PERF capture protocol.

**Kill criteria.** If filter rendering visibly differs across browsers/GPUs, ship as opt-in flag rather than default. If users find it distracting on real-match play (less rollback frequency than demo, so each flash is more visible), make it opt-in.

### B. Last-2-frame interpolation blend on the mask

**Idea.** Capture the last 2 live frames before rollback. During the mask's lifetime, animate a blend between them with `alpha` advancing over wall-clock time, producing a synthesized "next frame" via simple linear motion extrapolation.

**Why it might help.** The mask currently shows a single frozen frame. Interpolating between two recent frames produces a moving image at 60Hz during the mask window. Even mathematically-imperfect motion reads as continuous to the brain. This is the "kinescope idea" from iter 1, but constrained to only 2 frames and with extrapolative blending instead of literal scrubbing through past frames (which produced a visible backwards jump and was rejected).

**Determinism risk.** Zero — pure presentation. Authoritative emulator state is untouched.

**Implementation sketch.**
- Modify `_captureRollbackVisualSnapshot` to maintain `_prevSnapshot` and `_currSnapshot` (just 2 canvases — do NOT reintroduce the 4-frame buffer that failed in iter 1).
- During mask display, an `APISandbox.nativeRAF` loop computes `t = clamp(0, 1, elapsed / 32ms)`. Draw `_currSnapshot` over `_prevSnapshot` with `globalAlpha = 1`, then draw `_currSnapshot` again at offset `(currXY - prevXY) * t` with `globalAlpha = t * 0.5`. The double-draw approximates 1-frame motion extrapolation via affine offset.
- Stop the rAF loop and reset overlay on `_hideRollbackVisualFreeze`.

**Measurement.** Subjective primarily. Add a counter for "blend frames drawn" to confirm rAF is firing during the mask window. TICK-PERF should not regress (rAF callback is on its own scheduler, doesn't enter tick budget). Compare rolling p95 before/after.

**Kill criteria.** Hard cuts (KO zoom-ins, scene transitions, score-screen wipes) will produce visible ghosting. If the autopilot path or real match flow includes such moments, expect artifacts. If artifacts are subjectively worse than current freeze, drop it.

### C. Local-character cosmetic extrapolation during replay

**Idea.** During the mask window, render a small CSS-positioned overlay showing the local player's input as a stylized indicator that responds to local stick/button input. The emulator state stays frozen behind the mask; the cosmetic overlay gives the player visual confirmation that their input is registered. Removes when mask hides.

**Why it might help.** The biggest contributor to "feels paused" is that nothing on screen responds to player input during the 30-60ms replay window. Even a simple indicator that visually responds to local input (think: a glowing cursor, a stick-direction arrow, a "ready" pulse) registers as "the game is alive" and dramatically reduces perceived hitch. SF6 and most modern fighting games use camera jitters and motion blur for the same purpose.

**Determinism risk.** Zero — purely visual overlay, never touches emulator state or input pipeline.

**Implementation sketch.**
- New element `<div id="kn-rollback-input-cue">` positioned over the canvas.
- During `_rbVisualFreezeActive === true`, an rAF loop reads the local input from `KNState` and updates a CSS `transform: translate(stickX, stickY) scale(1+buttonsBoost)`.
- Hide cleanly on `_finishCReplay` — same serial-tracking pattern as `_rbVisualFreezeSerial`.
- Add `?cosmeticCue=0` escape hatch.

**Measurement.** Subjective only. A/B test. Have testers play with and without and rate rollback visibility 1-5.

**Kill criteria.** If overlay is too prominent / distracting / "ugly," ship as opt-in. If it appears outside the mask window (timing race), fix immediately or drop.

### D. Adaptive replay burst gated on per-tick headroom (EWMA)

**Idea.** Replace static `replayBurst=4` with a runtime value computed from recent normal-tick wall-time EWMA. If the EWMA shows ≥6ms headroom under 16.6ms, allow burst5-6 on this rollback; if grazing budget, pull back to burst2-3. Self-tune to device performance.

**Why it might help.** Current static burst4 is a compromise between fast catch-up and tick-spike risk. The compromise punishes healthy devices/moments that could absorb burst5-6, and risks spikes on weaker moments. Adaptive avoids both — fast catch-up where headroom exists, safer where it doesn't.

**Determinism risk.** None. Burst size affects scheduling only, not simulation order.

**Implementation sketch.**
- New EWMA `_recentTickEwma` updated in `tick()` after a normal-path tick (skip during replay so replay-tick wall time doesn't pollute the average).
- New EWMA `_typicalReplayStepEwma` updated from `_runCReplayFrame` durations.
- In the `catchingUp === 2` branch, compute `effectiveBurst = clamp(2, 6, floor((16.6 - _recentTickEwma) / _typicalReplayStepEwma))`.
- Cap at 6; never override the existing 16ms hard budget check inside the burst loop.
- Expose current `effectiveBurst` in HUD diagnostics so its distribution can be observed.

**Measurement.** Same TICK-PERF + replay median/p95. Watch `tickMaxP95` does NOT exceed current `~22.9 ms`. Track the distribution of `effectiveBurst` via HUD — should see a healthy mix across 2-6, not pinned at one value.

**Kill criteria.** If `tickMaxP95` rises ≥2ms vs current default, drop. If replay duration improvement is <5ms, drop (added complexity not justified).

### E. Idle-time replay catch-up via `requestIdleCallback`

**Idea.** Between regular setInterval ticks, schedule `requestIdleCallback` that runs ONE extra replay step if `_kn_get_replay_depth() > 0`. The browser fires idle callbacks during the gap between an early-finishing tick and the next tick. Replay catches up on wall-clock without blocking any rendered tick.

**Why it might help.** Replay duration shrinks by stealing time the main thread already had idle. The mask hides for less wall-clock time without ever pushing a tick over budget. Genuinely "free" speedup on the user-felt metric.

**Determinism risk.** None if structured correctly. The idle replay step is identical to a tick-loop replay step. Concern: re-entrancy with the next setInterval tick. Solution: a single mutex flag (`_idleReplayInProgress`) that both schedulers check.

**Implementation sketch.**
- After a tick completes, if `_kn_get_replay_depth() > 0`, schedule `requestIdleCallback(idleReplayTick, { timeout: 8 })`.
- `idleReplayTick` checks `_idleReplayInProgress`, sets it, runs `_prepareCReplayFrame` + `_runCReplayFrame` once, releases flag, re-schedules another idle if more depth remains.
- The next `setInterval` tick checks `_idleReplayInProgress` at entry; if set, skip this tick's replay step (idle path is faster).

**Measurement.** Replay median/p95 should drop. TICK-PERF unaffected (idle path doesn't enter tick budget). Add a counter for "replay frames consumed in idle" vs "in tick" — successful adoption should shift most replay consumption to idle.

**Kill criteria.** If browsers don't fire idle callbacks in the tick gap (some Chromium versions are stingy), drop. If the mutex causes regression in tick replay, drop. Verify with a 30s `performance.measure` trace before shipping.

### F. RAF-aligned tick scheduler (hybrid setInterval/rAF)

**Idea.** When `document.visibilityState === 'visible'`, drive ticks via `requestAnimationFrame` (vsync-aligned, no judder). When hidden, fall back to setInterval (resists tab-throttling, preserves reconnect-survivability).

**Why it might help.** The setInterval-driven tick produces ticks misaligned with display vsync; each tick that finishes 7-10ms before vsync still doesn't repaint until next vsync. Aligning ticks to vsync reduces visible micro-stutter. Replay-end snaps happen on a vsync boundary instead of mid-frame.

**Determinism risk.** Low — must keep tick rate locked to 60Hz game time even on 120Hz displays. Use the existing `_tickNextAt` deadline ([netplay-rollback.js:12262](../web/static/netplay-rollback.js#L12262)) and skip rAF callbacks until deadline reached.

**Implementation sketch.**
- Visibility listener routes to rAF or setInterval driver.
- rAF driver: callback fires, checks `now() >= _tickNextAt`, if yes runs `tick()` and sets next deadline; either way schedules next rAF.
- Reuse existing pause/resume hooks.

**Measurement.** Compare rolling p95/max with rAF driver on/off. Look for fewer `>20ms` rAF gaps. Subjective: do replay-end snaps feel cleaner?

**Kill criteria.** If 120Hz monitors produce timing drift, drop. If background-tab pause/resume breaks reconnect-survivability (tested via simulated tab-hide), drop.

### G. SharedArrayBuffer worker-based "presentation emulator"

**Idea.** Run a second emulator instance in a Web Worker, sharing RDRAM via SharedArrayBuffer. Worker emulator runs strictly forward — never rolls back. During replay on main thread, display the worker's canvas. Worker is always "ahead" so always has fresh forward frames. After replay completes, worker re-syncs from main's corrected state.

**Why it might help.** Truly eliminates the freeze: when main thread is replaying, worker is rendering forward. Player never sees a paused canvas. This is the "kill the pause" answer rather than a masking trick.

**Determinism risk.** Worker is presentation-only; main thread stays authoritative. Risk: state-sync between threads must be byte-exact at handoff points. Use Atomics for state-handoff; never let worker run while main is mid-step. SharedArrayBuffer / threads / COOP/COEP plumbing is non-trivial in this codebase but COOP/COEP is already enabled per `project_coop_coep_headers.md`.

**Implementation sketch.**
- This is a 1-2 week project, not a 1-day commit. Stage in an experimental branch.
- Build stripped emulator JS+WASM that takes a state snapshot + inputs and runs forward N frames, exposing canvas via `OffscreenCanvas.transferToImageBitmap`.
- Main thread on entering replay: post `{state, predictedInputs}` to worker. Worker renders 2-4 forward frames, posts `ImageBitmap`s back. Main displays.
- On replay-end: worker re-initialized from main's corrected state.
- Instrument worker-frame-display-count vs mask-frame-display-count.

**Measurement.** Subjective: does this finally remove the perceived pause? Stage carefully — worker boot time, memory cost, and sync overhead all need to be measured before a real ship decision.

**Kill criteria.** Worker can't sustain 60Hz emulation (very plausible — N64 WASM emulation is borderline 1× real-time). COOP/COEP setup breaks production. Worker boot exceeds 1 second. Sync overhead exceeds replay savings.

### H. OffscreenCanvas + GPU compositor for the mask

**Idea.** Move the visual mask from a 2D DOM canvas to an `OffscreenCanvas` rendered via WebGL on a separate compositor layer. Browser composites the mask layer over the emulator canvas at GPU level, decoupled from main thread.

**Why it might help.** Compositor can keep showing/animating the mask at display refresh rate even when main thread is mid-replay. Combined with B (interpolation) or A (CSS flash), makes the mask "alive" without main-thread blocking.

**Determinism risk.** Zero — pure presentation.

**Implementation sketch.**
- Replace `_rbVisualFreezeOverlay` (current 2D DOM canvas) with `OffscreenCanvas` + `transferControlToOffscreen()` + WebGL textured-quad shader.
- Capture frames via `gl.copyTexSubImage2D` between WebGL contexts (GPU→GPU, no CPU readback — avoids the perf hit that bit the iter-1 kinescope).
- Animate via shader uniforms (alpha, transform, blend) updated from main thread but interpolated GPU-side.

**Measurement.** TICK-PERF should improve slightly (mask is no longer eating CPU). Subjective: smoother during replay? DevTools "rendering" tab confirms compositor layer activity.

**Kill criteria.** If `texSubImage2D` from EmulatorJS-managed WebGL context is finicky, drop. If GPU composite adds visible lag (shouldn't, but verify), drop.

## Recommended order

**Cheap wins first (stack them; they're complementary):**

1. **A — CSS speed-line flash** (1-2 hours; zero risk; might be the highest ROI of any item).
2. **B — Last-2-frame interpolation blend** (half-day; zero determinism risk; addresses the "no motion" perception directly).
3. **D — Adaptive burst EWMA** (half-day; addresses the burst4 outlier risk you flagged in iter-1 measurements).

After those three ship and are evaluated subjectively, decide:
- If perceived pause is now acceptable: stop. Don't over-engineer.
- If still visible:

**Medium effort:**

4. **E — Idle replay** (1 day; opportunistic free speedup).
5. **C — Cosmetic input cue** (1-2 days; subjective; ship as opt-in if testing is mixed).
6. **F — RAF-aligned tick scheduler** (1-2 days; smoothness polish).

**Big project; only if cheap wins didn't get there:**

7. **G — Worker-based presentation emulator** (1-2 weeks; the actual "kill the freeze" answer; surface back to user before committing to the work).

**Skip unless others fail:**

8. **H — OffscreenCanvas compositor**: architectural cleanup, doesn't add new motion content. Worth doing during a refactor, not as a perf hunt.

## Mechanical wall-time reduction track

Parallel to the perceptual A-M ideas above. Where those mask the rollback, these *shorten* it. Today's replay duration decomposes as:

```
total = N × per_frame_step_cost + scheduling_overhead

per_frame_step_cost (today, with H-RDP-only, ~7-10ms):
  retro_run (CPU + RSP + RDP-skipped + audio + state save)  ~5-8ms
  JS↔C boundary + audio handling + serial diagnostics       ~0.5-2ms
  retro_unserialize on first frame only (one-time)          ~3-5ms

N = ~5 frames avg per rollback
scheduling_overhead = up to 16ms gap between ticks if rollback finishes mid-tick
```

Five levers below could plausibly drop replay median from ~30ms to ~10-15ms if all ship. None require sign-off for RSP/audio skipping.

### N. Full headless via `_refreshRunnerAfterRollbackRestore` fix

**Idea.** The current H-RDP-only patch is the *safe subset* of the existing `kn_set_headless` flag. The full flag would also skip GL state bind/unbind and `swap_buffers`, saving ~2-3ms per replay step on top of RDP-skip. Full headless was tried earlier and produced tick p95 spikes of `31-44ms` — almost certainly a fixable bug, not a fundamental constraint.

**Why it reduces wall time.** Replay step drops from ~7-10ms to ~5-7ms. On a 5-frame rollback that's ~10-15ms off the total.

**Determinism risk.** None more than H-RDP-only already accepts. The added skips are presentation-only.

**Implementation sketch.**
- Hypothesis: the captured Emscripten rAF runner relies on real GL composite cycles. Without composites the runner stalls and the next normal tick has to do extra work to resync — the visible tick spike.
- Verify by instrumenting `_refreshRunnerAfterRollbackRestore` ([web/static/netplay-rollback.js:7306](../web/static/netplay-rollback.js#L7306)) timing with full-headless on vs off. Confirm gap correlates with `kn_headless=1`.
- Fix: force a single real `APISandbox.nativeRAF(() => {})` composite at end of replay (pattern already used at line 7301), refreshing the runner once per rollback instead of letting it stall through every replay frame.
- Behind `?fullHeadless=1` for staged rollout.

**Measurement.** Replay duration p50/p95 (target: drop ~10-15ms from current ~30ms median). TICK-PERF p95 must NOT regress vs current default (~22.9ms). Add a "replay-end composite duration" diagnostic — should be sub-1ms.

**Kill criteria.** If the runner-refresh hypothesis is wrong and the gap has a different root cause (audio underrun, RSP sync, etc.), drop and document. If full-headless still spikes ticks even with runner-refresh in place, drop.

### O. Native batched C replay (eliminate JS↔C boundary in inner loop)

**Idea.** Each replay step today crosses the JS↔C boundary 3-4 times: `_kn_pre_tick` → `stepOneFrame` (which calls `retro_run` via JS-overridden runner) → `_kn_post_tick`. ~0.5-1ms per crossing. Replace the inner loop with a single C function `kn_run_replay_burst(int max_frames, int budget_us)` that runs N steps fully in C and returns when done or budget exhausted.

**Why it reduces wall time.** Saves ~2-4ms per rollback (5 frames × ~0.5-1ms boundary cost) plus reduces per-step variance from JIT/GC.

**Determinism risk.** Real — `stepOneFrame` does work in JS that affects state: `_syncRNGSeed`, `_resetAudio`, RAF runner refresh. Moving inside C means duplicating that logic, which must produce bit-identical results. Validation: `replaySelfTest(30)` must byte-match with batched on/off.

**Implementation sketch.**
- Audit `stepOneFrame` for inter-step work. RNG re-seeding and audio reset need C equivalents. Diagnostic logging and hash sampling get gated to "every Nth step" or moved out of the hot path.
- New C entry `kn_run_replay_burst` in [build/kn_rollback/kn_rollback.c](../build/kn_rollback/kn_rollback.c).
- JS wrapper in `_runCReplayFrame` defers to the batched C call when `replay_depth > 1`, falls back to per-frame JS step when depth ≤ 1 (preserves close-to-done diagnostics).

**Measurement.** Replay duration p50/p95. Per-step variance (p95 - p50). `replaySelfTest(30)` must pass. New counter for "frames consumed via batched C path" vs JS path.

**Kill criteria.** Any determinism mismatch on `replaySelfTest` between JS and batched C — drop, the JS path is the source of truth. If batched C buys <2ms per rollback, complexity not justified.

### P. Custom fast `retro_unserialize` for the rollback hot path

**Idea.** `retro_unserialize` is the libretro general-purpose state restore — header validation, optional fields, serialization framework. For rollback we just need the bytes back. Add `kn_restore_state_fast(slot)` that does bulk memcpy of the saved RDRAM region into live emulator memory, bypassing the libretro state-dict layer.

**Why it reduces wall time.** First-frame restore costs ~3-5ms today; bulk SIMD memcpy of an 8MB region is ~1-2ms. Saves 2-3ms per rollback, every rollback.

**Determinism risk.** Real — the libretro layer also restores non-RDRAM state (CPU registers, RSP scratch, timing counters). The fast path must restore *everything* `retro_serialize` would, just without wrapping.

**Implementation sketch.**
- Read mupen64plus's `retro_serialize` / `retro_unserialize` in the patched core. Identify exactly which memory regions and register banks are saved.
- New `kn_save_state_fast` and `kn_restore_state_fast` doing raw memcpy on those regions in same order, no wrapping.
- Behind `?fastRestore=1` for staged rollout. Validate with `replaySelfTest(30)` and a 5-min cross-peer hash test before promoting to default.

**Measurement.** Replay first-frame cost. `replaySelfTest(30)`. Cross-peer hash divergence must be zero over 5 minutes.

**Kill criteria.** Any state region missed by the fast path that validation catches — fix or drop. Speedup <1.5ms — determinism risk not worth it.

### Q. Verify (and if missing, enable) WASM SIMD memcpy in the build

**Idea.** Cheap audit. Check whether the WASM build is compiled with `-msimd128`. Without it, RDRAM saves use scalar copy loops at ~3-4 GB/s; with it, ~10-15 GB/s — the difference between a 2.5ms save and a 0.7ms save for 8MB.

**Why it reduces wall time.** Save state runs every frame in normal play (~3-5ms today, per the comment in [build/kn_rollback/kn_rollback.c:1132](../build/kn_rollback/kn_rollback.c#L1132)). Saves ~2ms per *every* frame, not just replay frames. Gives tick-budget headroom for adaptive burst (D), and the first-frame restore in replay benefits too.

**Determinism risk.** Zero — SIMD memcpy is bit-identical to scalar memcpy.

**Implementation sketch.**
- Inspect [build/Dockerfile](../build/Dockerfile), [Justfile](../Justfile), and the compiled `build/output/mupen64plus_next_libretro.js` for `-msimd128`.
- If absent, add the flag to the Emscripten build args, rebuild, re-benchmark.
- Browser support is universal (Chromium / Firefox / Safari all support SIMD WASM for 2-3 years).

**Measurement.** Per-frame save cost. Replay duration. TICK-PERF — improvement should appear on every frame, not just replay.

**Kill criteria.** If SIMD is already enabled, no-op confirmation. If enabling breaks the build (Emscripten + mupen interactions can be touchy), drop.

### R. Tighter tick scheduling during replay

**Idea.** During replay, the tick scheduler still fires on the 16ms cadence even though replay frames are wall-time-bounded by WASM step cost (~7-10ms). Shorten `setInterval` interval to 8ms during active replay (`_kn_get_replay_depth() > 0`), restore 16ms when replay completes. Each tick still does at most `replayBurst` frames, but next tick fires sooner.

**Why it reduces wall time.** A 5-frame rollback at burst4 takes ~1.25 ticks (~32ms wall) today. With 8ms scheduling during replay, the residual tick fires 8ms sooner — replay completes in ~24ms instead of ~32ms. ~25% reduction on the tail.

**Determinism risk.** None — scheduling timing doesn't affect simulation. Game-time *is* paused during replay (we're catching up, not advancing live), so the 60Hz cadence isn't load-bearing during the catch-up window.

**Implementation sketch.**
- In the existing tick scheduler ([web/static/netplay-rollback.js](../web/static/netplay-rollback.js) `_tickNextAt` logic at line 12262), check `_kn_get_replay_depth()` at the end of each tick. If > 0 and last tick consumed full burst (was budget-bound), schedule next tick at `now + 8ms` instead of `now + 16ms`.
- Restore 16ms cadence on the next tick after replay completes.
- Care: deadline reset must land after current tick handler returns, not interleaved with mid-tick state.

**Measurement.** Replay wall-time tail (last 0.25-tick). TICK-PERF unchanged for normal ticks. Counter for "ticks fired at 8ms during replay."

**Kill criteria.** If the next-tick-at-8ms doesn't actually consume more replay frames (per-step cost is the bottleneck, not scheduling), drop. If the cadence change interferes with the audio worklet's expected frame timing, drop.

### Combined potential

| Lever | Wall-time saved per rollback |
|---|---|
| N — Full headless via runner-refresh fix | ~10-15ms |
| O — Native batched C replay | ~2-4ms |
| P — Fast retro_unserialize | ~2-3ms |
| Q — SIMD memcpy (if not already) | ~2ms |
| R — 8ms tick during replay | ~6-8ms (tail only) |

**Stacked, replay median could drop from ~30ms to ~10-15ms** — approaching one tick of wall time per rollback event. That alone would significantly reduce the perceived hitch frequency-and-duration without any perceptual layer changes.

### Recommended mechanical-track order

1. **Q first** — cheap audit, possibly free win on every frame, unblocks D's adaptive burst headroom.
2. **N second** — biggest single replay-duration win, contained scope, just needs a hypothesis-driven bug fix.
3. **R third** — cheap tail-shave; trivially toggleable so it can be evaluated quickly.
4. **P fourth** — validation-heavy but real win on every rollback.
5. **O last** — most code surface and biggest determinism risk; only worth the effort if N, R, P haven't gotten replay duration low enough.

The mechanical track and the perceptual track (A-M) are independent — both can ship in parallel. The perceptual track addresses "the rollback is visible at all"; the mechanical track addresses "the rollback lasts long enough to be visible." Either alone helps; both stacked gets closer to genuine smoothness.

## Constraints (carry over)

- Read [docs/netplay-invariants.md](netplay-invariants.md) — R1-R6 invariants must be preserved.
- `window.knDiag?.replaySelfTest(30)` self-test is currently flaky (non-deterministic both with `replaySkipRdp=0` and `=1`). This is pre-existing and not within scope of these candidates. **Don't try to fix it as part of this work; surface back to user as a separate diagnostic if it gets in the way.**
- Don't deploy. User reviews + tests.
- Commit per optimization with the standard format: optimization name (one sentence), baseline TICK-PERF, post-fix TICK-PERF, rollback/mispredict delta, and any subjective notes.

## Reporting

Each candidate should produce, in order:

1. 30-second baseline run on `main` before the change (random P2, in-match steady state, auto-compare off).
2. The change you made and why.
3. 30-second post-fix run, same conditions.
4. Subjective: did the perceived hitch change? In what way?
5. Recommendation: ship / drop / iterate further.

If a candidate makes things subjectively worse despite metrics looking fine — like the iter-1 kinescope — revert it and write up *why*. The "why" matters more than the metric.
