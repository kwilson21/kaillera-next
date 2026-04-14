# N64Recomp Integration — Rollback-Native CPU Performance

**Date:** 2026-04-12
**Status:** Design approved, ready for implementation planning
**Author:** Brainstormed with Claude

## Summary

Integrate **N64Recomp** (Mr-Wiseguy's static MIPS→C recompiler) into the existing mupen64plus-next WASM build to eliminate the CPU performance ceiling that constrains rollback netplay. This replaces runtime MIPS interpretation with ahead-of-time compiled C for known ROMs (SSB64, Smash Remix), while leaving all existing infrastructure — rollback engine, netplay, EmulatorJS, RSP HLE, audio, input — untouched.

**Estimated effort:** 7-10 weeks to rollback-verified Smash Remix via recompiled CPU.

**Estimated perf gain:** 5-20x CPU speedup, taking rollback replay budget from "marginal on V8, tight on mobile" to effectively unlimited everywhere.

## Background

### Original Question

The user asked: *"What would it take to build an N64 emulator built for rollback netplay support?"*

### Exploration Path

We worked through the design of a fresh custom N64 emulator optimized for rollback:

| Decision | Choice |
|---|---|
| Scope | SSB64/Smash Remix first → competitive shortlist → popular library |
| Language | Fresh Rust (WASM-first, deterministic, same code native for desktop v2) |
| Rendering | Software RDP → WebGL blit (deterministic, no GPU state in snapshots) |
| CPU core | Initially: cached interpreter. Revised: static recompilation via N64Recomp |

Estimated timeline: 6-12 months for playable SSB64 in the new emulator.

### The Pivot

During the CPU strategy discussion, we revisited the dismissed option "ahead-of-time transpiled ROMs" and discovered **N64Recomp** — a battle-tested static recompiler that already ships WASM builds (Zelda 64: Recompiled / Majora's Mask PC port). This isn't research; it's production-grade open-source software.

This raised a question that reframed the entire project:

> *"Can we not use N64Recomp in our current setup as well?"*

The answer is yes, and it gets 80% of the performance benefit in 10% of the time. The new emulator remains a valid v2+ ambition for owning the full stack, but the near-term project becomes **integrating N64Recomp into the existing mupen64plus-next WASM build**.

This design doc captures both the exploration and the near-term integration plan.

## Goals

1. **Eliminate the CPU perf ceiling** that limits rollback replay depth, especially on V8 (Chrome/Edge/Brave) and mobile.
2. **Ship fast** — weeks, not months. Preserves v1 focus from CLAUDE.md's "Finish it" principle.
3. **Preserve existing work** — rollback engine, netplay, EmulatorJS, RSP HLE, audio all untouched.
4. **Keep the door open** for the custom emulator as v2+.

## Non-Goals

- Building a new N64 emulator now. (Documented as v2+ direction.)
- Supporting arbitrary N64 games via recompilation. (A-scope is SSB64 + Smash Remix.)
- Replacing RSP HLE, RDP, or audio. (N64Recomp only handles CPU.)
- Breaking cross-platform determinism. (SoftFloat FPU stays.)
- Removing the interpreter. (Still needed for boot sequence and for games without pre-compiled recompiled code.)

## Architecture

### Before

```
ROM → mupen64plus CPU interpreter → RSP HLE → RDP → frame
CPU cost: 3-6ms/frame (bottleneck)
```

### After

```
Build time (one-time per ROM version):
  ROM → N64Recomp → C function bodies (committed or CI-generated)

Runtime:
  Boot (first ~1 sec):
    PIF/CIC → mupen64plus interpreter → boot completes
  Game code:
    recompiled C functions → shim → mupen64plus memory/RSP/RDP
  CPU cost: ~0.3-1.2ms/frame (5-20x speedup)
```

**What changes:** CPU execution path for game code only.

**What doesn't change:**
- RSP HLE (graphics + audio ucode handlers)
- RDP / GLideN64 rendering
- Audio pipeline
- Input polling and timing
- `kn_rollback.c` — the C rollback engine
- SoftFloat FPU determinism
- EmulatorJS integration
- WebRTC netplay
- Save states (retro_serialize/retro_unserialize)

## Components

### 1. N64Recomp Build Stage

Runs at build time. Takes a ROM binary and an overlay configuration TOML, emits C source files that mirror the game's MIPS code as native C.

**Phase 1 (initial, manual):**
- Developer runs `N64Recomp smashremix.z64 smashremix.toml` locally
- Generated C files committed to `build/recomp/smashremix/`
- Existing Docker WASM build picks them up via glob

**Phase 2 (after proven, Docker-automated):**
- N64Recomp added as a Docker build stage
- ROM is a build input; recompiled C is a build artifact
- One command produces the complete WASM core

### 2. Overlay Configuration

SSB64 and Smash Remix use overlays for different game modes (menus, CSS, stage select, VS match). N64Recomp requires a TOML config declaring each overlay's:
- ROM offset
- RAM load address
- Size
- Entry points (optional)

**Information sources** (no one has done this for SSB64 before; we assemble from these):
- `ssb-decomp-re` (already referenced in `build/kn_rollback/kn_rollback.c`)
- Smash Remix community RAM maps
- Smash Remix source tree at `build/src/smashremix/`
- Runtime logging of which addresses mupen64plus loads code to during play

### 3. Shim Layer

A thin C file (~500-1000 lines estimated) that maps N64Recomp's runtime API to mupen64plus-next internals. Compiled into the existing WASM build.

| N64Recomp runtime call | Maps to mupen64plus-next |
|---|---|
| `MEM_W(addr, val)` / `MEM_H` / `MEM_B` | `rdram[]` direct array write |
| `MEM_R(addr)` | `rdram[]` direct array read |
| GP register file | Small struct (~128 bytes), part of retro_serialize payload |
| FP register file | Small struct (~256 bytes), part of retro_serialize payload |
| COP0 read/write | `g_cp0_regs[]` |
| Interrupt check | `gen_interrupt()` / check `next_interrupt` |
| Overlay load | Switch active recompiled function table |
| Syscall / exception | Delegate to mupen64plus exception handler |
| Indirect jump | N64Recomp-generated function pointer table |

The shim is the main original engineering work in this project.

### 4. Boot → Game Handoff

**Hybrid execution model:**
- Interpreter runs PIF ROM, CIC emulation, and initial boot code (first ~1 second, runs once)
- When PC enters an address range covered by a recompiled overlay, dispatch to recompiled function
- Interpreter continues to handle anything not covered (e.g., if we haven't mapped an overlay, fall back gracefully)

This avoids needing to recompile the boot sequence, which differs across N64 ROM regions and is generic/tiny anyway.

### 5. Rollback Integration

`kn_rollback.c` is untouched. The rollback state ring continues to use `retro_serialize`/`retro_unserialize`. The only addition: ~300 bytes of recompiled runtime state (GP regs + FP regs + PC + small COP0 subset) appended to the serialize buffer.

```c
// In retro_serialize, after existing mupen64plus state:
memcpy(buf + offset, &recomp_runtime_state, sizeof(recomp_runtime_state));
offset += sizeof(recomp_runtime_state);
```

Rollback engine doesn't know or care that the CPU is recompiled. One snapshot, one restore.

### 6. Determinism Verification

For the first few weeks of integration, run interpreter and recompiled paths **side-by-side** in a development mode:
- Each frame, after execution, compute RDRAM hash
- Compare hashes between interpreter-only and recompiled builds
- Any divergence → bug in shim, fix before continuing

This is the gatekeeper against subtle determinism bugs the shim layer might introduce.

## Data Flow

```
Frame N:
  1. Input collected (JS) → writeInputToMemory → mupen64plus input plugin
  2. kn_pre_tick: check for misprediction, restore state if needed
  3. retro_run begins:
     a. Interpreter advances until PC enters recompiled address range
     b. Dispatch to recompiled C function
     c. Recompiled code executes, calls shim for memory/COP0/interrupt
     d. Shim routes to mupen64plus rdram[] / g_cp0_regs / gen_interrupt
     e. When recompiled function returns to non-recompiled PC, interpreter resumes
     f. RSP HLE runs (unchanged)
     g. RDP/GLideN64 renders (unchanged)
     h. Audio emits (unchanged)
  4. kn_post_tick: snapshot state to ring buffer
  5. Input sent to peers
```

## Error Handling

- **Unknown overlay loaded:** Fall back to interpreter for that address range. Log `RECOMP-UNKNOWN-OVERLAY`. Not fatal.
- **Recompiled code reads unmapped memory:** Propagates to mupen64plus exception handler (same as interpreter). Not fatal in dev; follow existing rollback invariants (§R1-R6) in production.
- **Determinism divergence in dev mode:** `FATAL-RECOMP-DIVERGE` loud error with frame number, PC, RDRAM diff summary. Must be fixed before shipping.
- **N64Recomp build failure (new Smash Remix version):** Build fails loudly. Overlay config may need adjustment. Manual step in Phase 1; CI surfaces in Phase 2.

## Testing

- **Determinism harness (development only):** Run both paths simultaneously, compare RDRAM hash per frame for the first 10,000 frames of boot-to-match flow.
- **Rollback correctness:** Existing rollback test suite runs against the recompiled path. Replay-verification (R4 live-state hash) must pass.
- **Perf benchmark:** Headless tick benchmark (already exists per `project_rollback_benchmark.md`) re-run with recompiled path. Target: <1.5ms/frame on V8, <0.7ms/frame on JSC/SpiderMonkey.
- **Compatibility:** Full SSB64 and Smash Remix boot-to-match happy-path testing on desktop (Chrome, Safari, Firefox) and mobile (iOS Safari, Android Chrome).

## Milestones

| # | Milestone | Estimate |
|---|---|---|
| M1 | N64Recomp runs on SSB64 ROM, produces compilable C | 1 week |
| M2 | Recompiled C integrated into WASM build (boots, black screen OK) | 1 week |
| M3 | Shim layer: recompiled code reads/writes mupen64plus memory correctly | 1-2 weeks |
| M4 | SSB64 boots to title screen via recompiled path (interpreter boot handoff) | 1 week |
| M5 | SSB64 gameplay runs via recompiled path | 1-2 weeks |
| M6 | Smash Remix overlay config, gameplay works | 1 week |
| M7 | Rollback verified with recompiled path (retro_serialize includes recomp state) | 1 week |
| M8 | Perf benchmarks, comparison with interpreter path | 1 day |

**Total: 7-10 weeks to rollback-verified Smash Remix via N64Recomp.**

Each milestone ends with a testable artifact; work can be paused between milestones without losing state.

## Perf Targets

| Browser | Current (interpreter) | With N64Recomp (target) | Rollback replay frames per 16.67ms |
|---|---|---|---|
| Safari (JSC) | 3.0ms | ~0.3-0.6ms | 25-50 |
| Firefox (SpiderMonkey) | 3.1ms | ~0.3-0.6ms | 25-50 |
| Chrome/Edge (V8) | 5.9ms | ~0.6-1.2ms | 13-25 |
| Mobile (any) | 5-10ms | ~1-2ms | 8-16 |

Current baseline lets V8 run only 2-frame rollback. Target: 10+ frame rollback budget on every browser, including mobile.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| SSB64 overlay mapping harder than expected | Medium | Assemble from ssb-decomp-re, Smash Remix source, runtime logging; budget extra week in M1 |
| Shim layer has subtle determinism bugs | Medium | Side-by-side interpreter vs recompiled RDRAM hash comparison in dev builds |
| Smash Remix updates break recompilation | Low | Each update is a rebuild; overlay config may need adjustment; automatable in Phase 2 |
| N64Recomp hits an unsupported edge case in SSB64 | Low | N64Recomp is mature (shipped Zelda OOT and MM); SSB64 is well-understood |
| ASYNCIFY interaction with recompiled code | Medium→Low | Recompiled code is synchronous; likely *eliminates* ASYNCIFY freeze risk from `project_c_rollback_working.md` |

## Future Direction: Custom Emulator (v2+)

The new-emulator exploration is preserved as a long-term direction. The full architecture we designed:

- **Fresh Rust runtime** (WASM-first, deterministic-by-construction, native for desktop v2)
- **N64Recomp for CPU** (same approach as near-term, but with a Rust runtime instead of mupen64plus)
- **Software RDP → WebGL blit** (fully deterministic rendering, no GPU state in snapshots)
- **Cached interpreter as fallback** for games without pre-compiled recompiled code
- **Rollback-native state layout** — hot/cold state separation, delta snapshots from day zero
- **Synchronous frame loop** — no libco, no asyncify, no fibers
- **SoftFloat FPU** from day one

**When to revisit:**
- After N64Recomp integration ships and the recompilation approach is proven
- When phase B/C game expansion (competitive shortlist → popular library) creates pressure that mupen64plus-next architecture can't meet
- When EmulatorJS/Emscripten friction consistently blocks work

**AI leverage strategy** (documented for future use):
- High-value: mechanical C→Rust translation of reference implementations (gopher64, mupen64plus), opcode handlers, HLE ucode handlers, test vector generation, documentation mining
- Medium-value: bulk renames, refactors, test harness generation
- Zero/negative value: architecture decisions, rollback hot path, determinism debugging, performance tuning
- Hard rule: any AI-generated code in deterministic-sensitive layers must pass a cross-check test against a reference implementation before landing

Rough estimate for the custom emulator: 4-8 months, down from 6-12 because we've now validated the N64Recomp approach.

## Open Questions

None blocking the start of work. Overlay mapping specifics will emerge during M1.

## References

- **N64Recomp:** https://github.com/Mr-Wiseguy/N64Recomp (MIT licensed, actively maintained)
- **Zelda 64: Recompiled:** Production use of N64Recomp with WASM target
- **ssb-decomp-re:** Referenced in `build/kn_rollback/kn_rollback.c` for RDRAM structure analysis
- **Smash Remix source:** `build/src/smashremix/` in this repo
- **Rollback engine:** `build/kn_rollback/kn_rollback.c`
- **Netplay invariants §R1-R6:** `docs/netplay-invariants.md`
- **Prior rollback state:** `docs/superpowers/specs/` and memory files `project_c_rollback_working.md`, `project_rollback_benchmark.md`
