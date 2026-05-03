# Codex prompt: rollback smoothness iteration

## Context

This is a follow-up to [docs/codex-perf-iteration-prompt.md](codex-perf-iteration-prompt.md). Read that first — the iteration loop, measurement protocol, success criteria, file pointers, and determinism guardrail all carry over. Same demo (`/demo.html`), same realistic random P2 input load, same ROM (`Smash Remix 2.0.1.z64`).

This doc adds: a problem statement specific to *perceived smoothness* during rollback, a record of what's already been tried (so you don't retry it), and three new optimization candidates (D / E / F) ranked by how likely they are to actually help.

## The problem

The rollback engine works correctly. Tick perf is in budget (median ~17.5ms, p95 ~20ms). But during steady-state in-match play, the canvas visibly stalls/stutters at rollback frequency — currently ~3-4 rollbacks/sec at avg depth 5, so **~30% of wall time is spent in a "replay" state where the visible canvas is showing rewound game frames or a frozen mask**. The user perceives this as repeated micro-pauses synchronized with rollback events.

Mask + fade hides flicker but does not give the player forward motion during the replay window — the canvas underneath the mask is showing replayed *past* frames.

## What's already shipped (do NOT revert)

These commits are the current working baseline for visual masking. Build forward from them.

- `84869e5 perf(rollback): gate sync console logging`
- `ab86b65 perf(rollback): mask replay frames visually` — overlay canvas with last-good live frame during replay; black-frame detection; serial-tracked overlay lifecycle.
- `130e174 fix(rollback): smooth replay reveal from live frames`
- `e71dbae perf(rollback): fade replay mask during catch-up` — fade starts as replay begins, so the mask doesn't sit as a hard freeze for the full replay duration.

Relevant helpers in [web/static/netplay-rollback.js](../web/static/netplay-rollback.js): `_captureRollbackVisualSnapshot`, `_showRollbackVisualFreeze`, `_hideRollbackVisualFreeze`, `_runCReplayFrame`, `_finishCReplay`, `_prepareCReplayFrame`, `_refreshRunnerAfterRollbackRestore`. The replay branch is at `catchingUp === 2` in the main tick loop.

Relevant URL/localStorage tunables already wired:
- `?replayVisualFreeze=0` — disable visual masking entirely.
- `?replayVisualFadeMs=N` — fade duration.
- `?replayVisualFadeDuring=0` — disable fade-during-replay (mask stays opaque until replay completes, then fades).
- `?replayBurst=N` (1..8, default 1) — replay frames per tick.
- `?replayBurstBudgetMs=N` (1..16, default 10) — replay burst budget.

## What was tried and rejected (do NOT retry without a new mechanism)

1. **Non-headless `replayBurst > 1`** — reduced replay hold duration but spiked tick p95 to 26-38ms. Felt worse subjectively.
2. **Native headless replay via `_kn_set_headless`** — replay duration shortened, but `tickDeltaP95` rose to ~50ms even with `replayBurst=1`. Reverted.
3. **C-side replay coalescing in [build/kn_rollback/kn_rollback.c](../build/kn_rollback/kn_rollback.c)** — added but did not fire on the measured path. Reverted.
4. **Kinescope buffer scrub (capture last N live frames, scrub forward through them under the mask during replay)** — implemented, deployed, **made stutter visibly worse**. Root cause: the buffered frames are *past* frames; presenting the oldest at rollback start meant a 3-frame visible backwards jump from where the player just was, then a forward scrub that only restored the eye to "now." Reverted at [`web/static/netplay-rollback.js`]. The lesson: any masking strategy that draws past-frame content during replay risks reading as backwards motion.
5. **JS-side deadband filter for sticks** — removed. The C engine now does zone-based stick matching internally (`KN_STICK_ZONE_SIZE=12`, deadband-aware via zone 0). Don't reintroduce duplicate filtering in JS.
6. **Widening C-engine stick zones / additional misprediction filtering** — analyzed and not pursued. The demo's random P2 distribution is ~65% button-press decisions ([web/static/fake-peer.js:52-61](../web/static/fake-peer.js#L52-L61)). Buttons are discrete and can't be deadband-filtered. Stick filtering is already in place. There's no meaningful additional misprediction-rate reduction available without changing the prediction *model* itself, and the rate is roughly the same in real matches. **Don't go down this path.**

## The fundamental constraint

The visible canvas during replay shows *past* game-time frames being re-simulated with corrected inputs. There is **no forward-frame data lying around** to display under the mask without paying for it (a parallel sim, an extra burst of forward sim, or a synthesized frame). Every option below is a different way of paying that cost.

## The three candidates

### D — sim-ahead burst at rollback boundary

When `tickMod._kn_peek_pending_rollback?.() ?? -1) >= 0` returns true (in [web/static/netplay-rollback.js](../web/static/netplay-rollback.js#L9548)), run the emulator forward N additional frames with predicted inputs *before* the rollback fires, capturing each canvas frame. Then let the rollback proceed normally. During the replay window, the mask scrubs through the captured forward frames at ~16ms cadence — that's actual forward motion the player has not yet seen.

**Mechanically real, with a known flaw to handle:**

The captured forward frames are simulated with the *same* predicted inputs that just got invalidated by the rollback trigger. So they extrapolate the divergent (wrong) trajectory, not the corrected one. When the mask hides at the end of replay, the live canvas is at corrected-N+1, but the mask was just showing predicted-(N+k). For high-divergence cases (random buttons in demo), the snap from mask to live shows a visible discontinuity — the same problem we're trying to fix, just relocated.

**Possible mitigations to evaluate before committing to D:**
- **D-corrected variant**: do rollback + replay first (produces corrected state at frame N), then sim ahead from corrected state, capture frames, restore state, then yield to JS. Total burst is ~150ms in a single tick (5 frames replay + 4 frames sim-ahead at ~16ms each). One big tick spike — but the captured frames are now valid and align with what the live game will show.
- **Variance gate**: only enable D when prediction divergence is small (e.g., button match between predicted and confirmed). For high-divergence rollbacks (random demo, real matches with bursts of input), fall back to current behavior.

**What to measure before recommending shipment:**
- Tick wall time on rollback burst tick. The user has rejected ~30ms tick spikes scattered across ticks but a focused ~80-150ms spike at a known event boundary is a different perceptual question — measure and judge.
- Visual continuity at end-of-replay with random P2 (worst case) and with mostly-neutral synthetic inputs (best case).
- Whether the divergence at the snap is actually noticeable subjectively, or whether the forward motion during replay overrides it.

**Files**: [web/static/netplay-rollback.js](../web/static/netplay-rollback.js) — extend the snapshot/freeze infrastructure to support a multi-frame buffer keyed by frame number. The C engine ([build/kn_rollback/kn_rollback.c](../build/kn_rollback/kn_rollback.c)) probably needs a "do a manual save/restore checkpoint" API if you want the D-corrected variant — you'll need to round-trip state across the sim-ahead burst.

### E — parallel "shadow" emulator in a Web Worker

Run a second emulator instance one tick ahead of main, used purely for visual prediction. Main emulator rolls back as normal; shadow keeps marching forward. During replay, blit shadow's frames onto the mask.

**Honest assessment**: this is a real project, not an iteration. 2× memory, 2× CPU, full Worker plumbing, COOP/COEP threading already a known pain point in this codebase ([memory: project_proxy_to_pthread.md, project_coop_coep_headers.md]), state sync between main and shadow needs careful design. **Don't start E unless D and F have both been tried and shipped or both rejected.**

### H — aggressive headless: skip RSP/RDP in replay

The existing `kn_set_headless` flag ([build/patches/mupen64plus-headless-tick.patch](../build/patches/mupen64plus-headless-tick.patch)) only skips the GL state bind/unbind and `video_cb` framebuffer present. CPU emulation via `co_switch`, RSP graphics command list interpretation, and RDP rasterization all still run inside `retro_run`. That's why each replay step still costs ~16ms with headless on.

The mask covers the canvas for the entire replay duration. **Graphics output during replay is invisible to the player.** If RSP/RDP can be skipped during replay frames, each step's WASM cost should drop from ~16ms to ~6-8ms (the bulk is RSP/RDP for SSB64-class graphics). That's a real ~2x replay speed-up — the closest thing this codebase has to a true "fast-forward" without changing the emulator core.

**Determinism risk — real, not theoretical.**

RSP and RDP both write to RDRAM. Skipping them during replay means peers' RDRAM diverges from peers running full replay, AND from this same peer's own non-skipped frames after replay completes. Specifically:

- **RDP**: writes the framebuffer (RGBA pixels) and Z-buffer to RDRAM. The Z-buffer is read by subsequent RDP commands for depth test. Some games DMA-read the framebuffer back for screen transitions, motion blur, accumulation effects.
- **RSP**: emits display-list output to RDRAM, manages vertex/matrix scratch, and on most N64 games **synthesizes audio samples directly into RDRAM**. The CPU may read those audio buffers via AI register pointers.
- Game-specific quirks: some titles (rarely) use RSP for non-graphics computation that writes to general RDRAM.

`kn_gameplay_hash` only hashes a small set of gameplay addresses. It will *not* catch divergence outside that set. `kn_full_state_hash` will, but only if it's enabled and includes the relevant regions. **Skipping RSP/RDP without verification is the kind of change that produces a silent desync that surfaces 30 minutes into a match as "characters teleported," not as a clean RB-LIVE-MISMATCH.**

**Required validation before this can ship — do these in order, drop H if any step fails:**

1. **Identify what RSP/RDP write to during replay frames.** Instrument the WASM build with RDRAM write logging during replay (or compare RDRAM byte-for-byte: full replay vs skipped replay over a long run). Produce a list of every RDRAM address range written by RSP/RDP that is also read by CPU emulation in subsequent frames.
2. **Audit SSB64 / Smash Remix for any CPU read of those regions** that affects gameplay state. Most likely candidates: framebuffer reads for transitions, audio sample buffer reads via AI, RSP scratch reads.
3. **Determinism test with H on**: `window.knDiag?.replaySelfTest(30)` must pass with the flag on. Do a longer cross-peer test using two browser tabs hashing both `kn_gameplay_hash` and `kn_full_state_hash` every 60 frames for 5 minutes — both peers with H on, then one on / one off. Both peers with H on must agree; mixed must fail (proves the flag actually has an effect).
4. **Cross-peer guard**: bump the engine version constant. Peers must refuse to start a match if their `kn_skip_graphics` capability differs. This is non-negotiable — without the guard, a single old client in the lobby produces silent divergence for everyone.

**A safer, smaller variant to consider before going for full RSP/RDP skip:**

**H-RDP-only**: skip *only* the RDP (rasterizer) during replay, leaving RSP running. RDP's writes are mostly Z-buffer + framebuffer, which the CPU rarely reads back for gameplay decisions. RSP's writes (audio buffers, RSP scratch, display-list output) are kept fresh. Smaller speed-up (~30-40% of replay step cost is RDP rasterization for SSB64-class graphics) but materially lower divergence surface area. If H-RDP-only ships and feels smoother, the case for the full RSP-skip is weaker and the determinism risk isn't worth chasing.

**Diagnose first**: The previous `kn_set_headless` experiment caused `tickDeltaP95 ~50ms` even with `replayBurst=1`. That's a regression to root-cause before going further. Hypothesis: the captured Emscripten RAF runner relies on real GL composite cycles to drive timing, and `kn_headless=1` removes them. Compare timing of `APISandbox.nativeRAF(() => {})` ([web/static/netplay-rollback.js:7301](../web/static/netplay-rollback.js#L7301)) and the runner refresh in `_refreshRunnerAfterRollbackRestore` with headless on vs off. If the gap correlates with headless-on, fix the runner sync, then retry.

**Implementation sketch:**
1. Reproduce + diagnose the existing headless tick-gap. **Don't add more flags until the existing one works cleanly under `replayBurst=1`.**
2. Once the existing GL-present-skip is gap-free, add a deeper skip. Likely points:
   - mupen64plus dispatches RSP commands via SP DMA. Add a `kn_skip_graphics` early-return at the SP plugin's entry, similar to how `kn_headless` gates the GL ops in `retro_run`.
   - Or replace the active video plugin pointer with a no-op plugin while the flag is set.
   - Verify with the existing self-test: `window.knDiag?.replaySelfTest(30)` must report 0 diffs with the flag on.
3. JS wrapper: set the flag at C-replay start (already a clean point — see `_showRollbackVisualFreeze` invocation at [netplay-rollback.js:9651](../web/static/netplay-rollback.js#L9651)) and clear it in `_finishCReplay`. The flag must NEVER be set during normal forward ticks — only during replay frames.
4. Verify visual continuity at end-of-replay: the framebuffer is stale when the mask hides; the *next* live frame's RSP/RDP must regenerate the visible scene. Validate that there is no 1-frame artifact at mask-off (some games mid-frame DMA-read framebuffer for transitions; SSB64 likely doesn't, but check).
5. Cross-peer determinism guard: bump the engine version constant or refuse to start a match if peers report different `kn_skip_graphics` capability. Otherwise a peer with the patch and a peer without will visibly diverge during replays.

**Files**:
- [build/patches/mupen64plus-headless-tick.patch](../build/patches/mupen64plus-headless-tick.patch) — the existing patch. Extend it.
- [build/kn_rollback/kn_rollback.c](../build/kn_rollback/kn_rollback.c) — if you want to gate the skip at the rollback layer instead of relying on JS.
- [web/static/netplay-rollback.js](../web/static/netplay-rollback.js) — JS-side flag set/clear at replay boundary.

**Risk if it works**: per-replay wall time drops from ~80ms to ~30-40ms. Mask duration shrinks proportionally. Perceived stall window roughly halves. **This is the highest-impact lever currently identified.**

### F — optical-flow extrapolation

Compute pixel motion vectors from the last 2 captured live frames, apply them forward to synthesize "next" frames. Display synthesized frames during the replay window.

**Cheap on paper**: a WebGL shader pass is 1-2ms per synthesized frame. **Expensive in practice**: SSB64 has hard 2D HUD elements (stock count, damage %, timer) where motion-vector extrapolation will smear or duplicate digits — exactly the most readable elements of the screen. Slow camera movements work, but any kind of stage panning, zoom, or fast camera follow generates artifacts that look like a video codec glitch.

If you try F, mask the HUD region with a static crop of the most recent live frame, and only run flow extrapolation on the gameplay region. That's not free either — the HUD region still freezes for 80ms while the rest moves, which can read as "wrong" in its own way.

## Recommended order

1. **Free hypothesis-eliminator first**: try `?replayVisualFadeDuring=0` (the existing tunable). This makes the mask fully opaque for the entire replay duration, then fades quickly after replay. The hypothesis is that the user's perceived stutter comes from the mask-fade revealing rewound canvas frames *during* replay. If a hard freeze + clean snap feels smoother than the current fade-during-replay, ship the flag flip as the new default. This costs nothing and rules out a whole branch of the problem.

2. **H-RDP-only — skip just the rasterizer in replay** is the highest-impact step that's plausibly safe. Halving (or near-halving) replay wall time directly halves the perceived-stall window; nothing else on the table comes close to that lever, and skipping only RDP keeps RSP's RDRAM writes (audio, scratch, display lists) intact, drastically shrinking the determinism surface area. Required: first diagnose and fix the existing `kn_set_headless` tick-gap regression, then audit RDP's RDRAM write set, then implement the skip with a cross-peer engine-version guard. **Do NOT extend to skipping RSP without explicit user sign-off — the audio buffer and scratch DMA risk is too high.**

3. **D-corrected variant** if step 2 didn't ship (or for orthogonal further smoothing on top of H). Build the multi-frame snapshot buffer + sim-ahead-after-rollback flow. Verify the burst tick is recoverable (no I1 timeout violations, no ring-stale, no live-mismatch). Measure replay wall time, perceived smoothness with both random and neutral-biased P2.

4. **F (optical flow on gameplay region only, HUD masked)** if D doesn't ship. Be skeptical; abandon early if the synthesized frames produce visible HUD smearing.

5. **E** is out of scope for this iteration loop. Surface it back to the user with a real proposal if H, D, and F all fail.

## Constraints (carry over from `codex-perf-iteration-prompt.md`)

- Don't break determinism. Run `window.knDiag?.replaySelfTest(30)` after each change.
- Don't violate netplay invariants — read [docs/netplay-invariants.md](netplay-invariants.md) before touching the tick loop. R1-R6 in particular.
- Don't reintroduce flicker (black frames, rewound canvas visible).
- Don't introduce tick spikes scattered across normal ticks. A focused spike at the rollback event boundary is acceptable if measured and bounded.
- WASM rebuilds via `docker` + `just deploy` happen automatically (`feedback_wasm_rebuild_auto.md`). Don't deploy — the user reviews + tests.
- Commit per optimization. Each commit message includes baseline TICK-PERF, post-fix TICK-PERF, rollback delta, and one sentence on the change.

## Reporting

For each candidate (1, 2, 3 above), report:
- 30-second baseline measurement (tickMs median/p95, rollback events delta, mispredict delta, subjective summary).
- The change you made and why.
- 30-second post-fix measurement.
- Subjective: did the perceived stutter change? In what way?
- Whether you recommend shipping, dropping, or iterating further.

If a candidate makes things worse subjectively even when metrics look fine — like the kinescope did — revert it and write up *why* it didn't work. The "why" matters more than the metric on this problem.
