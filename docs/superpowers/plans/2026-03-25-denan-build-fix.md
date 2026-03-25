# Fix --denan WASM Build Pipeline

## Problem

`wasm-opt --denan` produces a WASM binary that won't boot in the browser. A known-good `--denan` core exists (extracted from git commit `553a8de` on the `wasm-determinism` branch) that works perfectly — near-perfect deterministic sync across desktop Chrome (V8) and mobile Safari (JSC), no drift resyncs.

We need to reproduce that build but with additional C exports (`kn_sync_hash`, `kn_sync_read`, `kn_sync_write`, `kn_sync_hash_regions`) from `build/patches/mupen64plus-kn-all.patch`.

## What the known-good core has

- Built 2026-03-23 in a Claude session using the Docker `emulatorjs-builder` image (emsdk 3.1.74, wasm-opt v120)
- Patches applied: `retroarch-deterministic-timing.patch`, `mupen64plus-deterministic-timing.patch`, `mupen64plus-wasm-determinism.patch`
- Post-link processing: `wasm-opt --denan` + `build/fix-denan.py` (NaN→canonical NaN instead of NaN→0)
- WASM size: 7,269,435 bytes (inside 7z archive at 1,508,200 bytes)
- JS glue: 290,474 bytes
- The build.sh at that time did `git checkout -- .` on BOTH source repos before applying patches (full clean reset)
- The `mupen64plus-wasm-determinism.patch` at that time included C-level FPU NaN canonicalization in LWC1/SWC1/MFC1/MOV instructions, `kn_reset_cycle_count`, `kn_canon_fpu_regs`, `srand(0)`, and deterministic RTC

## What the known-good core does NOT have

- `mupen64plus-kn-all.patch` — no `kn_sync_hash`, `kn_sync_read`, `kn_sync_write`, `kn_sync_hash_regions` exports
- This means `_hasKnSync = false` in the JS engine and all resync goes through the slower getState/loadState fallback path

## What we want

A core that has BOTH:
1. Everything from the known-good build (timing patches, wasm-determinism patch, --denan + fix-denan.py)
2. The kn_sync exports from `mupen64plus-kn-all.patch` (C-level resync for faster state transfer)

## What was tried and failed

1. Adding `wasm-opt --denan` to `build.sh` Stage 4b (after link, before packaging) — emulator won't boot
2. `wasm-opt --denan` only (without fix-denan.py) — still won't boot
3. Applying denan to the 768e45c pre-denan core (same base source as known-good) using the same Docker wasm-opt v120 — won't boot
4. Using brew wasm-opt v128 instead of Docker v120 — finds different denan site counts (12 f32 + 3 f64 vs 11 f32 + 2 f64 from v120) but untested
5. Extracting the binary blob from git history (`git show 553a8de:web/static/ejs/cores/mupen64plus_next-wasm.data`) — this WORKS but lacks kn_sync exports

Key observation: even re-applying denan to the same base WASM that the known-good core was built from (768e45c) produces a broken binary. This means the Docker wasm-opt v120 is NOT what built the known-good core, despite the Dockerfile specifying emsdk 3.1.74.

## Likely root causes to investigate

1. **Docker image staleness**: The `emulatorjs-builder` Docker image may have been rebuilt between the known-good build and now, getting a different wasm-opt binary even with the same emsdk version
2. **Local vs Docker build**: The known-good core may have been built outside Docker, using a locally-installed emsdk/wasm-opt on the host machine
3. **wasm-opt version mismatch**: v120 in Docker finds 11 f32 + 2 f64 denan sites; v128 from brew finds 12 f32 + 3 f64. The known-good binary may have been processed by a version that handles asyncify-instrumented WASM correctly
4. **Asyncify interaction**: `--denan` wraps every float op in a NaN-check function. If these wrapper functions aren't properly handled by Emscripten's asyncify instrumentation (which was applied during linking), the async stack unwinding breaks at runtime

## Recommended approach

1. **Rebuild the Docker image from scratch** (`docker build -t emulatorjs-builder build/`) to ensure the emsdk/wasm-opt is fresh and matches 3.1.74
2. **Try with a newer emsdk** (e.g., 3.1.75+) that may have asyncify-compatible --denan
3. **Try running denan BEFORE asyncify** — this requires modifying the Emscripten link step to not apply asyncify, then applying denan, then asyncify as a separate wasm-opt pass. This is complex but would ensure denan wrappers are properly asyncify-instrumented.
4. **Clean build**: Delete `build/src/` entirely, re-clone repos, apply ALL patches (timing + wasm-determinism + kn-all), compile, link, denan, fix-denan, package
5. **Match the known-good build.sh exactly**: Use the build.sh from commit 768e45c (which does `git checkout -- .` on both repos), add kn-all patch to the patch application section

## Files to reference

- `build/build.sh` — current build script (denan disabled in comments)
- `build/fix-denan.py` — post-processor that changes NaN→0 to NaN→canonical NaN
- `build/patches/mupen64plus-kn-all.patch` — C-level resync exports (one-liner format)
- `build/patches/mupen64plus-deterministic-timing.patch` — core timing patch
- `build/patches/mupen64plus-wasm-determinism.patch` — FPU NaN canon + srand(0) + RTC
- `build/patches/retroarch-deterministic-timing.patch` — RetroArch timing + audio bypass + EXPORTED_FUNCTIONS
- `build/Dockerfile` — Docker image (emsdk 3.1.74)
- `web/static/ejs/cores/mupen64plus_next-wasm.data` — currently deployed known-good core

## Git references

- `553a8de` on `wasm-determinism` branch — commit that deployed the known-good --denan core
- `768e45c` on `wasm-determinism` branch — pre-denan core (same source, no denan applied)
- `git show 553a8de:build/patches/mupen64plus-wasm-determinism.patch` — the version of the determinism patch used in the known-good build
- `git show 768e45c:build/build.sh` — the build.sh that compiled the known-good base

## Current state

Branch `feat/c-level-resync` is deployed with:
- Known-good --denan core (553a8de blob) — lacks kn_sync exports, uses fallback resync
- Frame pacing (GGPO-style frame advantage cap) — working, eliminates death spiral
- Delta sync — working via JS fallback path (getState XOR, not C-level kn_sync_read XOR)
- Log export system — working, server upload on game end
- No guest freeze during resync — working
- Game runs near-perfect on desktop + mobile
