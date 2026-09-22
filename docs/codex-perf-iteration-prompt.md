# Codex prompt: rollback perf optimization (Playwright loop)

## Context

`/demo.html` is a 1-player rollback demo. The flow is:

1. User drops a Smash Remix ROM (`Smash Remix 2.0.1.z64` is the test ROM).
2. P1 follows a baked autopilot (`MENU_AUTOPILOT_P1_TRANSITIONS` in
   [web/static/demo.js](../web/static/demo.js)) through Title → Mode Select →
   2P CSS → Stage Select.
3. P2 (synthetic peer in [web/static/fake-peer.js](../web/static/fake-peer.js))
   follows a baked autopilot (`MENU_AUTOPILOT_P2_TRANSITIONS`) on CSS so
   both players lock in characters.
4. Match starts. P2 switches to **realistic random inputs** — held 3-15
   frames per decision (~50-250ms, human reaction-cadence). Every input
   transition is a misprediction the rollback engine has to rewind through.
5. The Result card HUD shows "Rollbacks: N · Predictions: M".

**Current state**: rollbacks fire as expected, but the visible game is
jumpy — frame stutter and visual snap-back during replay. The user wants
the random-input load preserved (it simulates real-world play); your job is
to **optimize the rollback execution path so the visual experience stays
smooth under that load.**

## What is in scope

- Per-frame work inside the engine's tick + rollback path
- Render-suppression during replay frames
- Audio handling during rollback
- Console-log overhead (engine logs at 60Hz via `_syncLog` —
  `console.log` is more expensive than people realize, especially with
  DevTools open; gate with a debug flag if you keep it)
- Frame pacing / vsync alignment
- Memory churn (allocations during the hot path)

## What is **out of scope**

- Changing P2's input characteristics. The user has explicitly said:
  "keep the random inputs as close to real-life as possible." Don't slow
  P2's decision rate, don't bias toward idle, don't filter buttons (other
  than the existing START/L exclusions which are already merged).
- Modifying the autopilot recordings.
- Changing the demo's UI/UX layout.
- Removing the Rollbacks/Predictions HUD counters — they are the proof.

## Success criteria

After your changes, with the demo at `/demo.html` and the same realistic
random P2 input load:

1. `TICK-PERF` median tick time stays under 16.6 ms (60fps budget).
2. `TICK-PERF` p95 tick time stays under 18 ms.
3. The Rollbacks counter still climbs (don't accidentally suppress real
   rollback events to win on perf — that defeats the demo).
4. Visual: a human watching the canvas does not perceive snap-back or
   stutter during steady-state in-match play.

## Test setup

Use the Playwright MCP server. The demo is served by the dev server at
`https://localhost:27888/demo.html` (HTTPS, self-signed). Some setup notes:

- The dev server is **always running** — do NOT start or stop it. See
  `feedback_no_server_management.md` in memory.
- Drop the test ROM by injecting it into the file input. The ROM file is
  on the user's filesystem; ask them for the path or check
  `reference_rom_path.md` in memory.
- Demo mode includes a 2-3 minute autopilot phase (boot → menus → CSS →
  stage select → match start) — Playwright timeouts must accommodate this.
  See `feedback_playwright_timeouts.md`.
- The match auto-starts auto-compare (rollback ON ↔ OFF every 6s). Disable
  it for steady-state perf measurement by clicking the "Auto-compare"
  button to toggle off, OR call `window.KNDemo.stopAutoCompare?.()` from
  the console if exposed.

## Iteration loop

For each candidate optimization:

1. **Measure baseline** with the current code:
   - Drop ROM, wait for `isInMatch transition: true` log line.
   - Let it run 30 seconds in steady-state with random P2 inputs (no
     auto-compare flipping rollback).
   - Capture `TICK-PERF` lines from the log; compute median/p95 of
     `tickMs`.
   - Capture `getHudCounters().rollbackEventsTotal` and
     `totalMispredicts` deltas to confirm rollback load is comparable.
2. **Implement one optimization** (file paths below).
3. **Re-measure** the same way. Diff the metrics.
4. **Commit each successful optimization** as its own commit so we can
   bisect later if anything regresses determinism.
5. If a candidate makes things worse or doesn't help, revert and move on.
   Don't stack speculative changes.

## Likely-fruitful optimization areas (start here)

### 1. Console log gating

[web/static/netplay-rollback.js](../web/static/netplay-rollback.js#L2023)
`_syncLog` calls `console.log` unconditionally for every event. The engine
emits ~60-100 log lines per second during gameplay (DIAG-INPUT every
frame, NORMAL-INPUT on transitions, audio-feed periodic, C-PERF/TICK-PERF
every 100 frames, etc).

Gate the `console.log` call behind a `?verbose=1` URL param (or
`localStorage['kn-debug']`). Keep `_syncLogRing.push(...)` so the upload
machinery still works — only skip the console output. Critical events
(MISMATCH, STATE-DRIFT, etc.) should always log.

Re-measure after this change first — it might be the dominant cost.

### 2. Render suppression during replay

The engine drives `_pendingRunner()` (the captured Emscripten rAF
callback) during rollback replay. Each call advances the simulation AND
re-renders the canvas. For an N-frame rollback, that's N+1 GL renders in
rapid succession — visible flicker.

Investigate whether mupen64plus exposes a "skip render" flag (look for
`vi_register`, `gfx_plugin`, or `m64p_video_extension_functions`). If
yes, set it during replay frames and clear it for the final corrected
frame.

If no native flag exists, consider a CSS-level mask: hide the canvas for
the duration of the replay (~3-15ms) and reveal after. Hacky but bounded.

### 3. Audio during rollback

Audio buffer underruns cause perceived stutter even when video is fine.
Look for [web/static/kn-audio.js](../web/static/kn-audio.js) and check
how it handles rollback. Real GGPO implementations either:
- Buffer 2-3 frames ahead so brief stalls don't underrun.
- Mute output during replay frames.

### 4. Frame-budget watchdog

Add a per-tick measurement: if `tick()` exceeds 16.6ms, log a
`FRAME-OVER` warning with a breakdown (preTick / step / postTick / rollback
work). This makes the bottleneck visible without DevTools profiler.

### 5. GC churn

Random P2 input generation in fake-peer creates a fresh object every
frame. Consider object pooling for `_zeroInput()` returns and keeping a
single mutable input buffer.

## Files and references

- [web/static/demo.js](../web/static/demo.js) — demo orchestration, autopilot
  replay, lag slider, Stop/Pause buttons.
- [web/static/fake-peer.js](../web/static/fake-peer.js) — synthetic P2 peer.
  `_matchInputForFrame` is the random-input generator. Don't change its
  behavior; you can change its allocations.
- [web/static/netplay-rollback.js](../web/static/netplay-rollback.js) — the
  GGPO-style C-level rollback engine wrapper. ~12k lines. The hot path is
  in the `tick()` function (search for `const tick = () =>`). `_syncLog`
  at line 2023.
- [web/static/kn-diagnostics.js](../web/static/kn-diagnostics.js) — canvas
  hash, freeze detection, DIAG-INPUT.
- [web/static/kn-audio.js](../web/static/kn-audio.js) — audio worklet and
  capture buffer.
- [build/kn_rollback/kn_rollback.c](../build/kn_rollback/kn_rollback.c) —
  the C rollback engine. State save/load and the prediction core. If you
  modify this you need to rebuild the WASM (see
  `reference_build_wasm.md` in memory). Per project policy, WASM rebuilds
  via `docker` + `just deploy` happen automatically without asking
  (`feedback_wasm_rebuild_auto.md`).
- `CLAUDE.md` — project conventions.
- `docs/netplay-invariants.md` — **must read**. Defines invariants I1
  (no stall without timeout), I2 (reconnect starts clean), R1-R6
  (rollback integrity). Don't violate these. Do not introduce a watchdog
  that *acts* on stalls — see the rejected-alternatives section.

## Determinism guardrail

Anything you change in the simulation path (input read order, RNG, FP,
state save/load) must preserve bit-exact determinism across runs. The
demo uses a synthetic peer in-process so cross-platform divergence isn't
the concern, but in-tab determinism (replay produces same state as live)
absolutely is. Run a quick replay self-test:
`window.knDiag?.replaySelfTest(30)` — should report 0 diffs.

## Reporting

Each commit message should include:
- The optimization in one sentence.
- Baseline `TICK-PERF` median/p95.
- Post-fix `TICK-PERF` median/p95.
- Rollback event count delta (to confirm load was comparable).
- Any regressions you considered and ruled out.

Don't deploy. The user reviews + tests before any deploy.
