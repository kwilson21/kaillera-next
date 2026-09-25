# Threaded WASM core (`PROXY_TO_PTHREAD`) — experiment notes

**Branch:** `experiment/proxy-to-pthread` (March 26–27, 2026). It predates
the April 29 history restart of `main`, so it shares no commits with `main`
and cannot be merged. The commits cited below exist only on that history:
push the tag `archive/proxy-to-pthread` before deleting the branch, or they
become unreachable.
**Outcome:** abandoned. The core on `main` is single-threaded (`ASYNC=1`,
asyncify, no pthreads).

## Goal

Move the emulator off the browser's main thread so page work (netplay JS,
GC, DOM, WebRTC) cannot steal frame time from the emulator.

## What was tried

1. **`PROXY_TO_PTHREAD=1`** (`0844356`, deployed as core v12 in `b368aad`).
   Emscripten runs `main()`, meaning the whole RetroArch/mupen64plus loop,
   on a pthread (a Web Worker). Asyncify is dropped (`ASYNC=0`) because a
   worker can block natively.
2. **`HAVE_THREADS=1` + `ASYNC=1`** (`e14c311`, core in `e7f84ba`). This was
   the fallback: pthreads for the core's internal threading only, with the
   main loop still on the browser thread under asyncify. This keeps EmulatorJS
   working unchanged but does not meet the goal.
3. **GLideN64 `ThreadedRenderer`** core option (`9204d8f`). Rejected: it adds
   input lag.

## Findings

- **`PROXY_TO_PTHREAD` needs changes outside the build.** GL has to go through
  an OffscreenCanvas, and EmulatorJS's loader expects the core's main loop on
  the page thread, so the loader would need changes. The experiment stopped at
  that point. No FPS or frame-time numbers were recorded for either build.
- **No core threading option helps netplay.** Recorded in `9204d8f`:
  ThreadedRenderer adds input lag, and Parallel-RDP needs Vulkan, which
  browsers lack.
- **Build requirements for any threaded core:**
  - Compile the mupen64plus `.bc` with `EMULATORJS_THREADS=1`, which adds
    `-pthread`; `wasm-ld --shared-memory` refuses objects built without it
    (`1258505`).
  - Run `make -f Makefile.emulatorjs clean` before relinking RetroArch. Stale
    `obj-emscripten/*.o` from a non-threaded build lack the atomics and
    bulk-memory features, and the link fails (`d69aec8`).
  - `wasm-opt --denan` on a threaded binary needs `--enable-threads
    --enable-bulk-memory --enable-mutable-globals --enable-sign-ext` to
    validate it (`c52b074`).
- **`--denan` placement depends on asyncify.** With asyncify, `--denan` must
  run before `--asyncify`; `build.sh` Stage 1b patches emscripten's
  `link.py` for this, because denan helpers inserted afterwards break
  asyncify's stack unwinding. Without asyncify (`PROXY_TO_PTHREAD`) it can
  run as a plain post-link `wasm-opt` pass (`0844356`).
- **Build size.** The `.data` archive was 1,465,218 bytes before the
  experiment, 1,229,977 with `PROXY_TO_PTHREAD` (no asyncify), and 1,543,072
  with `HAVE_THREADS=1` + asyncify.
- **Cross-origin isolation.** Threads need `SharedArrayBuffer`, so the page
  needs `crossOriginIsolated` (COOP/COEP, added in `f5af923`). Under COEP the
  CDN copy of the Socket.IO client broke, so it was self-hosted (`9204d8f`);
  `web/static/socket.io.min.js` on `main` is that change.
- **Non-secure contexts.** Mobile testing over plain HTTP hit a missing
  `crypto.randomUUID` and `navigator.getGamepads`. Both guards are on `main`.

## Why not pick it back up as-is

- **Determinism.** The rollback engine needs bit-exact frames on every peer.
  Real threads bring scheduling-dependent ordering into the core, and the
  build already avoids nondeterministic SIMD paths (`-fno-tree-vectorize`,
  scalar `src/main`; see #24). A threaded core would need a determinism audit
  first; see also `cross-engine-determinism-investigation.md`.
- **Replay offload exists, live-loop offload does not.** The Mode 2 rollback
  worker (`rollback-shadow-worker.js`, from #9/#11) runs rollback replays in a
  second emulator instance on a worker, without threading the core. It does
  not move the live emulator loop: live frames still run on the page thread
  and still compete with page work, which was this experiment's goal. Mode 2
  is also opt-in (`?rollbackMode=2`), and its default parallel setting still
  replays on the page thread alongside the worker.
- **Scope.** A worker-hosted main loop means OffscreenCanvas rendering, audio
  and input plumbing across threads, and a forked EmulatorJS loader.

If this comes back, start with `PROXY_TO_PTHREAD` plus OffscreenCanvas in a
standalone page without EmulatorJS. Measure frame-time variance against the
current core, and check that `kn_game_state_hash` matches across two runs
before touching netplay.
