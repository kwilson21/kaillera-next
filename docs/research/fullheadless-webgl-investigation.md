# `?fullHeadless=1` WebGL flood — root-cause analysis

**Branch:** `kn-peek-pending-rollback-core` @ `7a10694`  
**Repro:** `https://kn-test.thesuperhuman.us/demo.html?knDiag=1&fullHeadless=1`  
**Reported symptom:** `WebGL: INVALID_OPERATION: drawArrays: no valid shader program in use` flood, eventually `WebGL: too many errors, no more errors will be reported`.

## TL;DR

- The flood is **conditional on a real rollback firing**. In headless Chromium I could not reach a state where `_setReplayFullHeadless(true)` actually engaged (autopilot ROM mismatch leaves `getSceneStatus().ready === false`, so the fake peer never injects mispredictions and the replay branch never executes). Direct manual toggling of `_kn_set_headless(1) + _kn_set_skip_rdp_replay(1)` for hundreds of frames produced **zero** WebGL errors (`gl.getError()` returned `NO_ERROR` after every `drawArrays`/`drawElements`/`drawRangeElementsBaseVertex`).
- The runner-refresh / `_forceReplayEndComposite` hypothesis ([web/static/netplay-rollback.js:7489-7500](../../web/static/netplay-rollback.js#L7489)) is **not what's producing the WebGL errors**. That helper schedules an empty `requestAnimationFrame` callback; it issues no GL calls of its own. The error must originate from a draw call inside the WASM core itself, not the JS-side rAF poke.
- Static review of the C patches identifies **one un-skipped GL path** that fires on every replay frame: `FrameBufferList::renderBuffer()` → `GraphicsDrawer::copyTexturedRect()` → `BufferedDrawer::drawRects()` → `glDrawArrays`. This path is not gated by `kn_should_skip_rdp_raster()`, so even with `kn_skip_rdp_replay=1` it still runs once per VI interrupt during replay. Its shader is the cached `Texrect{Down,Up}scaleCopyProgram` from `CombinerInfo`. With `kn_headless=1`, the surrounding `glsm_state_bind`/`glsm_state_unbind` is skipped — and `glsm_state_unbind` is what calls `glUseProgram(0)`. There is therefore no JS-visible mechanism by which the program would be reset to 0 between replay frames in the H+full-headless path that isn't already exercised by H-RDP-only. Yet the user observes errors only with full headless.
- **Recommendation:** ship full-headless behind `?fullHeadlessExperimental=1` only (keep `?fullHeadless=1` as the staging flag the user can toggle), capture a real-match repro with the patched core's diagnostic to log `gl.getError()` per `retro_run`, and decide a fix from data. Do not extend the C patch blindly — every option below is risky without a confirmed root-cause frame.

## Reproduction attempts (what I did)

1. Navigated to the staging demo with `?knDiag=1&fullHeadless=1`, dropped the SSB64 ROM, started the emulator. Confirmed:
   - `RB_FULL_HEADLESS_DURING_REPLAY = true`
   - `kn_set_headless`, `kn_set_skip_rdp_replay`, `kn_pre_tick` all exported.
   - `isCRollback() === true`, but `isInMatch() === false`. The autopilot leaves the demo on the character-select screen — the demo's `getSceneStatus()` returns `ready=false` (the autopilot was recorded against Smash Remix and the address layout on plain SSB64 does not yield a recognised scene/status pair).

2. Patched `Module.canvas.GLctxObject.GLctx.{drawArrays,drawElements,drawRangeElementsBaseVertex,useProgram}` directly. After the patch, `__knErrSummary.drawCount` increased by ~6000/sec — confirming the patch is on the actual context Emscripten uses.

3. **Manual toggle test:** flipped `_kn_set_headless(1)` and `_kn_set_skip_rdp_replay(1)` together for 60-300ms windows, 10 cycles. Sampled `gl.getParameter(CURRENT_PROGRAM)` and `gl.getError()` after every draw.
   - During headless: `curProgram = true` continuously, `glErrCount = 0`, draw rate fell from ~6000/sec to ~160/sec (the RDP raster skip is doing its job).
   - On exit from headless: `curProgram` stayed true, no spike in errors, draw rate recovered.

4. **High mispredict probability test:** `KNFakePeer.setNetwork({ latencyMs:100, mispredictProb:0.5 })` with `lag=200ms`. Even after 10 seconds, `mispredictsLastSec=0` because the fake peer's `inMatch` check uses `NetplayRollback.isInMatch()` which is false here. Confirmed via session log: **zero `REPLAY-FULL-HEADLESS`, `REPLAY-RDP-SKIP`, `C-REPLAY` lines in 24K frames** — the replay code path was never entered organically.

5. Captured `exportSyncLog()`. TICK-PERF was healthy throughout (median 17.3ms, p95 20.4ms, `inGameplay=true`). No replay events, no errors.

**Conclusion of repro phase:** I could not reach the state the user observed in the headless test environment. The bug is real (the user observed it) but I cannot characterise it from this session's data. Headed Chromium with a Smash Remix ROM is the most likely path to a clean repro — the autopilot was recorded against that game and `isInMatch()` will then return true, allowing the fake peer to drive mispredictions and the rollback branch to fire.

## Static analysis: where could the no-program error come from?

### What the patches do

- **`mupen64plus-headless-tick.patch`** ([build/patches/mupen64plus-headless-tick.patch](../../build/patches/mupen64plus-headless-tick.patch)) gates three things in `retro_run`: `glsm_ctl(GLSM_CTL_STATE_BIND, NULL)`, `glsm_ctl(GLSM_CTL_STATE_UNBIND, NULL)`, and the `video_cb`/`libretro_swap_buffer` block. CPU emulation via `co_switch(game_thread)` is unchanged.
- **`mupen64plus-rdp-replay-skip.patch`** ([build/patches/mupen64plus-rdp-replay-skip.patch](../../build/patches/mupen64plus-rdp-replay-skip.patch)) gates `drawTriangles`, `drawScreenSpaceTriangle`, `drawDMATriangles`, `drawLine`, `drawRect`, `drawTexturedRect`, `gDPFillRectangle`, `gDPTextureRectangle`, `gDPFullSync`, `LLETriangle::draw`, `gSPTriangle`. It does **not** gate `GraphicsDrawer::copyTexturedRect`.

### `glUseProgram(0)` is hidden in `glsm_state_unbind`

[libretro-common/glsm/glsm.c:3248](../../build/src/mupen64plus-libretro-nx/libretro-common/glsm/glsm.c#L3248): `glsm_state_unbind` calls `glUseProgram(0)` and `glBindFramebuffer(..., 0)`. `glsm_state_bind` later restores `glUseProgram(gl_state.program)`. With `kn_headless=1`, both run paths are skipped, so the program-binding bookkeeping that surrounds `co_switch` is gone for the replay frame. **However**, GLideN64's own draw path always calls `glUseProgram` via its `CombinerInfo::ShaderProgram::activate()` before drawing, so steady-state replay frames should still have a valid program when they hit `glDrawArrays`.

### The un-skipped path: `VI_UpdateScreen → renderBuffer → copyTexturedRect`

[GLideN64/src/VI.cpp:322](../../build/src/mupen64plus-libretro-nx/GLideN64/src/VI.cpp#L322) calls `frameBufferList().renderBuffer()` on every VI interrupt. That function ([GLideN64/src/FrameBuffer.cpp:1465](../../build/src/mupen64plus-libretro-nx/GLideN64/src/FrameBuffer.cpp#L1465)) ends in `drawer.copyTexturedRect(blitParams)` (line 1634), where `blitParams.combiner = CombinerInfo::get().getTexrectDownscaleCopyProgram()` (or `Upscale` / `ColorAndDepth` variant). `copyTexturedRect` activates that combiner ([GraphicsDrawer.cpp:1803](../../build/src/mupen64plus-libretro-nx/GLideN64/src/GraphicsDrawer.cpp#L1803): `_params.combiner->activate()`) and then `gfxContext.drawRects(rectParams)` → `BufferedDrawer::drawRects` → `glDrawArrays(TRIANGLE_STRIP, ..., 4)` ([opengl_BufferedDrawer.cpp:143](../../build/src/mupen64plus-libretro-nx/GLideN64/src/Graphics/OpenGLContext/opengl_BufferedDrawer.cpp#L143)).

This path is the same in both H-RDP-only and full-headless modes — neither patch gates it. So if the program were missing, both paths would error. They don't (the user reports the flood is full-headless-only).

### Plausible root causes (none proven from this session)

1. **Combiner program lifetime tied to FrameBuffer lifetime.** `CombinerInfo`'s texrect copy programs are allocated once. They should survive across the rollback save/restore. If, however, an Emscripten `_emscripten_notify_memory_growth(0)` triggered by `_refreshRunnerAfterRollbackRestore` ([web/static/netplay-rollback.js:7411](../../web/static/netplay-rollback.js#L7411)) invalidates a cached `WebGLProgram` JS handle, subsequent `gl.useProgram(handle)` would set `CURRENT_PROGRAM` to that stale handle. The next `gl.getError()` call after the next `drawArrays` would yield `INVALID_OPERATION`. The runner-refresh runs after the rollback restore, **only** in the full-headless path with `RB_FULL_HEADLESS_DURING_REPLAY=true` (the `dt >= 2` early-out otherwise rate-limits the log line; the call itself happens regardless of flags — see code path at line 7407-7413). This is the most likely candidate.

2. **`_forceReplayEndComposite` rAF callback racing with `pauseMainLoop`/`resumeMainLoop`.** The rAF empty callback could land between Emscripten's pause-resume cycle and the next `retro_run`, on a frame where the canvas's GL context state machine is in an "unbound" intermediate state. This is speculative — no evidence in this session.

3. **Off-by-one on the `glsm_state_bind` skip.** The patch toggles `kn_headless` from JS *between* replay batches. If the JS toggles `kn_headless=0` after the C engine has already begun the replay's last `retro_run`, the *post*-co_switch unbind runs while bind didn't — leaving `gl_state.program` mismatched with actual GL state. Skipping bind without skipping the next unbind would call `glUseProgram(0)`. After that the next forward retro_run runs bind, which restores `gl_state.program`, but any draw between the unbind and the bind would error. This is harder to reach than (1) but possible.

## Does the runner-refresh fix the WebGL errors?

No. `APISandbox.nativeRAF(() => {})` is an empty callback. It does not call `gl.useProgram` or any other GL function. Its only effect is to make the browser's compositor schedule another frame, which can keep `requestAnimationFrame` cadence steady inside Emscripten's main loop. It cannot bind a shader. If the live program handle is stale (candidate (1) above), this rAF call won't repair it.

The `RB-RUNNER-REFRESH` log entry was added in `05eea32` precisely to expose whether the pause/resume + memory-growth notify cycle correlates with the tick spike. The current `7a10694` log shows zero `RB-RUNNER-REFRESH` entries in 24K frames — because no rollback fired in my repro, so the refresh never ran.

## Recommended fix path

### Phase 1 — capture a real repro (do this first)

Without a real-match repro, every fix is a guess. Two options:

- **Smash Remix ROM in headed Chromium.** Drop a Smash Remix ROM (or update the autopilot to navigate plain SSB64 to in-match). The fake peer's `mispredictProb` will then drive rollback events. Use the GL-context patch from this session (saved at the bottom of this doc) to log `getError()` per draw and the curProgram pointer. **Do not skip this step.**
- **Add a per-draw `gl.getError()` logger to the dev build behind a flag.** Patch `web/static/netplay-rollback.js` to wrap `Module.canvas.GLctxObject.GLctx.drawArrays` in a check that calls `gl.getError()` and logs the offending frame number / program handle. Gate behind `?glErrTrace=1` so it only runs when explicitly enabled.

The data this produces will tell us whether (a) `CURRENT_PROGRAM` is `null` at the error site (program-zero theory), (b) it's non-null but invalid (stale-handle theory from memory-growth notify), or (c) the error is something else entirely (e.g. attribute-array mismatch).

### Phase 2 — minimum viable fix candidates (rank-ordered)

Once the data identifies the failure mode, choose:

- **If stale combiner handle from memory-growth notify (most likely):** drop `Module._emscripten_notify_memory_growth(0)` from `_refreshRunnerAfterRollbackRestore`. The current code at [netplay-rollback.js:7411-7413](../../web/static/netplay-rollback.js#L7411) calls it as a fallback. Memory growth across a save/restore in the same WASM heap typically does not invalidate JS-side `WebGLProgram` handles, but if it does we don't need this notify anyway — the heap pointer wouldn't have changed.

- **If `CURRENT_PROGRAM === null` at the error site:** extend `mupen64plus-headless-tick.patch` to skip `glsm_state_unbind`'s `glUseProgram(0)` specifically (or skip the whole unbind, which is what we do today, and *also* skip `glUseProgram(0)` in the non-headless unbind that runs right before the headless toggle takes effect). The simpler form: add a JS-side `_kn_pre_tick` shim that calls `gl.useProgram(<a known-valid program>)` after `_setReplayFullHeadless(true)` so subsequent draws have something to bind. The known-valid program would be `CombinerInfo::getTexrectDownscaleCopyProgram()` exposed via a new `kn_get_texrect_program()` export.

- **If errors fire in the renderBuffer copyTexturedRect path:** add `if (kn_should_skip_rdp_raster()) return;` to the top of `FrameBufferList::renderBuffer()` ([FrameBuffer.cpp:1465](../../build/src/mupen64plus-libretro-nx/GLideN64/src/FrameBuffer.cpp#L1465)). This is a one-line patch. Determinism risk: zero — `renderBuffer` is presentation-only, and we already accept skipping `gDPFullSync`'s copybacks. Tick-perf risk: negligible on the saved side, since renderBuffer was already cheap when only `copyTexturedRect` runs (the heavy lifting is RDP raster, already skipped).

### Phase 3 — gating

Until phase 1 produces evidence, keep `?fullHeadless=1` as the experimental flag (no behavioural change required — the JS already returns `false` from `RB_FULL_HEADLESS_DURING_REPLAY` unless the flag is set). The user should not enable this on real-match play. The H-RDP-only default ([commit 1e81361](https://github.com/.../1e81361)) is the safe path and is what should ship.

## Risk assessment

- **Shipping the runner-refresh fix as-is (already on `main`):** safe — it cannot make the WebGL errors worse, but it likely does not fix them either. The "force a real GL composite" intuition was right that something about the rAF cadence matters; it's wrong that the issue is *cadence-driven*. The error is about GL state, not timing.
- **Extending the rdp-skip patch to `renderBuffer()` (the simplest C fix):** low risk if it's the right diagnosis; meaningless if it isn't. **Don't ship without phase-1 data.**
- **Skipping `glUseProgram(0)` in the headless path:** medium risk. The current behaviour is symmetric (skip both bind and unbind), and breaking that symmetry can leave `gl_state.program` (the glsm-tracked shadow) out of sync with actual GL state in non-replay frames. Needs careful unit-level testing.

## Verdict

The user's report is real but does not reproduce in headless Chromium with the current autopilot + plain SSB64 ROM. Before shipping a fix, **capture the failing frames in a Smash Remix or in-match SSB64 reproduction** with `gl.getError()` per-draw instrumentation. The strongest *a priori* candidate is the `Module._emscripten_notify_memory_growth(0)` call in `_refreshRunnerAfterRollbackRestore` invalidating the cached combiner program handles — drop that line first and see if the flood disappears. If not, gate `FrameBufferList::renderBuffer()` on `kn_should_skip_rdp_raster()`. Either change is a one-line edit; the question is which one is correct, and we don't have the evidence yet.

The runner-refresh helper that already shipped does not address the WebGL flood. It's still useful for measuring tick-gap behaviour but should not be advertised as a fix for the no-shader-program errors.

## Appendix: GL-context instrumentation snippet (paste into devtools)

```js
const M = window.EJS_emulator?.gameManager?.Module;
const gl = M?.canvas?.GLctxObject?.GLctx;
const origDA = gl.drawArrays.bind(gl);
window.__knDrawErr = { count: 0, samples: [] };
gl.drawArrays = function (mode, first, count) {
  const r = origDA(mode, first, count);
  const e = gl.getError();
  if (e !== gl.NO_ERROR && window.__knDrawErr.samples.length < 20) {
    window.__knDrawErr.count++;
    window.__knDrawErr.samples.push({
      err: e, mode, first, count,
      curProg: !!gl.getParameter(gl.CURRENT_PROGRAM),
      headless: window._rbFullHeadlessActive,
      rdpSkip: window._rbRdpSkipActive,
      frame: window.KNState?.frameNum,
      stack: new Error().stack?.split('\n').slice(2, 6).join(' | '),
    });
  }
  return r;
};
```

Repeat for `drawElements` and `drawRangeElementsBaseVertex`. Trigger a real match against another peer (or Smash Remix autopilot) and read `__knDrawErr.samples` after the first error fires.
