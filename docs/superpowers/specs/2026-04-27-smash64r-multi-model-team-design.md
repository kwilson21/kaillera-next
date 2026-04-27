# smash64r Multi-Model Team — Design

**Date:** 2026-04-27
**Status:** Design
**Branch context:** `feat/smash64r-wasm` (active development branch)

## Goal

Establish a multi-model AI team and coordination protocol that delivers a **working smash64r prototype**, defined as: SSB64 boots and runs at 60 fps in single-player on the smash64r N64Recomp/ultramodern WASM build with audio, graphics, and controller working end-to-end.

This design covers **how the team is assembled, how tasks are dispatched and integrated, and how the first sprint is shaped**. It does not enumerate every implementation step; that work belongs to the writing-plans phase that consumes this spec.

## Non-Goals

These are explicitly out of scope. Adding them is a scope expansion that requires a new spec.

- **Netplay integration of smash64r.** The prototype is single-player. Multiplayer is a later milestone.
- **Player-facing UI surface.** No toggle in `play.html`, no lobby treatment, no error UX. The build is verified through the existing dev harness (Playwright + console diag counters).
- **Public launch artifacts.** No landing page, telemetry, monetization hook, or screenshot/video assets.
- **Product-management or UX roles in the team.** Option A's scope (engineering-only) does not earn those seats. If scope upgrades to "shippable behind a flag" or "public demo," a follow-up spec will reintroduce them.
- **Model exhaustiveness.** This spec selects three models for clear roles. It does not benchmark every available model.

## Scope (Definition of Done)

The prototype ships when **all five** of the following hold simultaneously on the smash64r WASM build with `kn_recomp_set_enabled(1)`:

1. SSB64 boots through to a 1P match.
2. Frame rate holds ≥ 60 fps for at least 60 seconds of active gameplay.
3. Audio plays without dropouts or pitch errors during the same window.
4. Canvas updates continuously (no silent display freeze of the kind documented in `project_recomp_m2_status.md` issue #1).
5. A connected gamepad drives the in-match character end-to-end.

Determinism, multiplayer, and resync invariants are **not** in scope for the prototype but must not be regressed in the existing EmulatorJS path.

## Team

| Role | Model | Invocation | Why this model |
|------|-------|------------|----------------|
| Orchestrator + integrator + reviewer | Claude (interactive Claude Code session) | n/a — driver | Holds project state across memory + spec docs, decomposes tasks, judges output quality, applies patches, runs builds. |
| Primary systems engineer | Codex (GPT-5 Codex) | `codex exec` non-interactive, prompt loaded from a brief file | Strongest single-shot patch producer for C/C++ systems work. Built for code volume. |
| Reasoning audits | DeepSeek `deepseek-reasoner` (alias resolves to current reasoning flagship) | HTTP POST `https://api.deepseek.com/v1/chat/completions` | RL-tuned for structured chain-of-thought over code. Well-suited to "trace mupen interp X end-to-end and identify where our shim Y diverges." |
| Cheap second opinion (optional) | DeepSeek `deepseek-chat` (alias resolves to current chat flagship) | same endpoint, different `model` field | Same vendor, lower cost. Used when we want a sanity-check pass on a reasoning-model audit without spending another reasoner call. |

### Dropped from the original list (and why)

- **Kimi K2** — its key differentiator is agentic tool-use. Our brief-and-shell pattern is single-shot inference; Kimi's edge does not apply. If we later move to a sub-architecture where a model drives its own tool loop, Kimi earns its seat. Not now.
- **MiniMax** — the active code surface fits comfortably within 128K. No long-context win to capture.
- **Qwen** — would be another generic code model in a slot we have already filled.

### Future-model swap policy

DeepSeek's API uses stable aliases (`deepseek-chat`, `deepseek-reasoner`) that auto-track to the latest model release. Spec wording uses the aliases, so V4 / future versions are picked up without a spec edit. If a more granular endpoint emerges (e.g. a `flash` variant), the dispatch logic runs both endpoints on a real audit task, compares outputs, and only then promotes the new endpoint into the slot.

## Coordination Protocol

### File layout

All multi-model artifacts live under a single root for traceability:

```
docs/team/
├── README.md                              # protocol overview, brief template, dispatch examples
├── briefs/YYYY-MM-DD-<task>.md            # written by Claude before each dispatch
├── outputs/YYYY-MM-DD-<task>.<model>.md   # raw model output, captured verbatim
└── decisions/YYYY-MM-DD-<task>.md         # Claude's integration decision, diff applied (or rejection rationale)
```

`<task>` is a short kebab-case identifier (e.g. `phase-2f-w2-fiber-takeover`).
`<model>` is one of `codex`, `deepseek-reasoner`, `deepseek-chat`.

### Brief format

Every brief is a markdown file with these sections, in this order:

```markdown
# <task-id>

## Goal
One sentence. What success looks like.

## Files in scope
- path/to/file.c (lines A-B)
- path/to/other.h

## Constraints
- Must preserve determinism (SoftFloat FPU, fixed scheduling, deterministic RNG)
- Must not regress EmulatorJS path
- Phase Y depends on this; do not introduce APIs that block Y

## Task
Exact ask. Be specific.

## Acceptance criteria
- Build flag: KN_FAST=1 build succeeds
- Counter: kn_um_get_swap_count > 0 within 5 seconds of dispatch enable
- Log signature: no "RB-INVARIANT-VIOLATION" in console

## Output format
patch | analysis | answer
```

`patch` means a unified diff or full-file replacement that Claude can apply. `analysis` means prose with file:line citations. `answer` means a direct response to a closed question.

### Dispatch flow

1. Claude writes `briefs/<task>.md`.
2. Claude shells out:
   - **Codex:** `codex exec --prompt-file docs/team/briefs/<task>.md > docs/team/outputs/<task>.codex.md`
   - **DeepSeek:** Claude constructs the JSON payload (system + user + inlined file contents), POSTs to the API, captures the response body to `docs/team/outputs/<task>.<model>.md`. Implementation detail (script vs inline curl) is left to the writing-plans phase.
3. Claude reads the output, validates against acceptance criteria.
4. If `patch`: apply, build, run verification, write `decisions/<task>.md` with the diff hash + verification evidence, commit with `team-task: <task-id>` trailer.
5. If `analysis` or `answer`: integrate into the next brief or apply directly if small. Decision written either way.

### Acceptance and integration rules

- **Patches that don't build** are rejected. Claude writes a fix-up brief with the build error inlined; does not silently fix.
- **Determinism regressions** are hard stops. Revert is via fix-forward brief (`feedback_no_reverting.md`), not `git revert`.
- **Reasoner output that conflicts with reality** (hallucinated file contents, wrong line numbers) is rejected; brief is sharpened with explicit file contents inlined; retried.
- **Conflicting recommendations between Codex and DeepSeek** are resolved by Claude reading the actual code; if genuinely ambiguous, escalated to user.

### Commit traceability

Every commit that integrates model output carries a `team-task: <task-id>` trailer. This makes `git log --grep='team-task:'` the source of truth for what the team has produced.

## First Sprint Shape

This sprint takes the smash64r branch from its current state (Phase 2f Wave 1 dormant infrastructure landed) to the working prototype defined above.

| # | Owner | Task | Depends on |
|---|-------|------|-----------|
| 1 | Codex | Implement variant 4 from `project_recomp_m2_status.md` — fiber takeover inside `EmuThreadFunction` (`build/src/mupen64plus-libretro-nx/libretro.c` ~line 496+). Inject `kn_recomp_get_enabled()` check before mupen interp call; route to `kn_um_drive_frame()` when enabled. | — |
| 2 | Codex | Wire `osRecvMesg(BLOCK)` park via `um_thread_park_on()`; wire `osSendMesg` parked-receiver wake via `um_queue_wake_one()`. | #1 |
| 3 | Claude | Build with `KN_FAST=1`, run, capture `kn_um_get_*` and `kn_bounce_get_*` counters + frame-counter watchdog. Verify the residual silent-display freeze documented in recomp memo issue #1 is gone. | #2 |
| 4 | DeepSeek-reasoner | Parity audit: enumerate libultra primitives still routing through depth-guard. Identify what else needs ultramodern wiring before depth-guard can drop. Output: `analysis` with prioritized list. | parallel with #1-3 |
| 5 | Codex | Drop depth-guard. Benchmark dispatch ON vs OFF (frame time, dispatch rate, bounce rate). | #3 passes |
| 6 | DeepSeek-reasoner | Audio path audit: read `build/recomp/kn_port/AUDIO_NOTES.md`, audio shim sources, and SSB64 audio thread lifecycle. Output: `analysis` of what changes (if any) are needed for 60fps audio under the fiber model. | parallel with #5 |
| 7 | Codex (if #6 surfaces work) | Apply audio-path patches per #6 findings. | #6 |
| 8 | Claude | Controller verification under fiber model: Playwright harness + diag counters + manual gamepad input through 1P match. | #5 done, #7 done if invoked |
| 9 | Claude | Final prototype acceptance run: 60s active gameplay, all five DoD criteria checked, evidence captured to `decisions/prototype-acceptance.md`. | #8 |

DeepSeek-chat is reserved as a cheap second-opinion call on #4 and #6 if either output feels thin.

## Failure Modes

| Mode | Detection | Response |
|------|-----------|----------|
| Model hallucinates file contents | Cited line doesn't exist or contents mismatch | Reject. Re-brief with explicit file contents inlined. |
| Codex patch breaks build | Build fails | Keep patch in working tree. Write fix-up brief with stderr inlined. Do not `git revert`. |
| Wedge persists after #3 | Frame counter freezes within 30 s | Diagnose with new diag counters. Brief DeepSeek-reasoner for divergence audit before patching. |
| Determinism regression | Determinism probe fails | Hard stop. Fix-forward only. Surface to user. |
| Codex / DeepSeek conflict | Reading both decisions disagrees | Claude reads code, decides. If genuinely ambiguous, escalate to user. |
| API budget exhausted | Dispatch fails with rate/auth error | Pause, surface to user. Do not silently switch models without approval. |

## Open Questions

These do not block this spec but should be answered before or during writing-plans:

1. **DeepSeek dispatch implementation.** Inline curl in Claude tool calls vs a thin shell script (`scripts/team-dispatch.sh`) vs a Python helper. Defer to writing-plans.
2. **Brief size limits.** DeepSeek-reasoner has 128K context but inlining large files repeatedly is wasteful. May want a brief format that references files by path + line range and a dispatch-time helper that inlines them. Defer to writing-plans.
3. **Where does `decisions/<task>.md` live in CI/git history?** Do we keep them in the branch under `docs/team/decisions/` permanently or rotate them out after a milestone? Recommend keeping permanently for the prototype phase; revisit at v2.

## Related Context

- `docs/superpowers/specs/2026-04-15-librecomp-wasm-port-design.md` — the underlying technical spec the team is executing against.
- Memory: `project_recomp_m2_status.md` — current Phase 2f Wave 1 state, residual issues, recommended next session order.
- Memory: `feedback_smash64r_no_fallback.md` — discipline rule: route around blockers within smash64r, do not recommend reverting to EmulatorJS.
- Memory: `feedback_no_reverting.md` — fix-forward policy for breaking changes.
