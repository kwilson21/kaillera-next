# smash64r Multi-Model Team — Design

**Date:** 2026-04-27
**Status:** Design
**Branch context:** `feat/smash64r-wasm` (active development branch)

## What this spec IS and IS NOT

**IS:** the team composition and coordination protocol for delivering the smash64r prototype. Roles, dispatch flow, brief format, file layout, traceability rules.

**IS NOT:** the technical-execution spec for Phase 2f Wave 2 or any other smash64r engineering phase. Technical decisions (which fiber model variant, which libultra primitives to wire, how to verify wedge-fix) are owned by `docs/superpowers/specs/2026-04-12-n64recomp-integration-design.md` and the per-phase plans the team will produce. This spec only defines *who does what work and how their output gets integrated.*

## Goal

Establish a multi-model AI team and coordination protocol that delivers a **working smash64r prototype**, defined as: SSB64 boots and runs at 60 fps in single-player on the smash64r N64Recomp/ultramodern WASM build with audio, graphics, and controller working end-to-end.

## Non-Goals

- **Netplay integration of smash64r.** The prototype is single-player.
- **Player-facing UI surface.** No toggle in `play.html`, no lobby treatment, no error UX. Verification runs through the existing dev harness (Playwright + console diag counters).
- **Public launch artifacts.** No landing page, telemetry, monetization hook, or marketing assets.
- **PM or UX roles.** Option A's scope (engineering-only) does not earn those seats. A scope upgrade requires a new spec.
- **Model exhaustiveness.** This spec selects three concrete models for clear roles. It does not benchmark every available model.

## Definition of Done

The prototype ships when **all five** of the following hold simultaneously on the smash64r WASM build with `kn_recomp_set_enabled(1)`:

1. SSB64 boots through to a 1P match without crashes or stalls.
2. Frame rate holds ≥ 60 fps for at least 60 seconds of continuous active gameplay.
3. The mupen frame counter (read via `EJS_emulator.gameManager.Module._kn_get_retro_run_entries`, exported by `build/kn_recomp/kn_recomp_shim.c:356` on the smash64r branch) advances continuously across that 60 s window — no silent display-freeze stall of the kind tracked in `project_recomp_m2_status.md` (issue #1).
4. Audio plays without dropouts or pitch errors during the same window (verified by ear + audio-thread diag counters showing no underruns).
5. A connected gamepad drives the in-match character end-to-end through the same window.

Determinism, multiplayer, and resync invariants are **not** in scope for the prototype but must not be regressed in the existing EmulatorJS path.

## Team

| Role | Model | Invocation | Why this model |
|------|-------|------------|----------------|
| Orchestrator + integrator + reviewer | Claude (interactive Claude Code session) | n/a — driver | Holds project state across memory + spec docs, decomposes tasks, judges output quality, applies patches, runs builds. |
| Primary systems engineer | Codex (GPT-5 Codex) | `cat <brief> \| codex exec -` (prompt via stdin per `codex exec --help`); output captured via shell redirection | Strongest single-shot patch producer for C/C++ systems work. Built for code volume. |
| Reasoning audits | DeepSeek `deepseek-reasoner` | `Bash` tool with inline `curl` POST to `https://api.deepseek.com/v1/chat/completions`. `DEEPSEEK_API_KEY` from env (see `.env`). | RL-tuned for chain-of-thought over code. Fits "trace mupen interp X end-to-end and identify where shim Y diverges." |
| Cheap second opinion | DeepSeek `deepseek-chat` | same endpoint, different `model` field | Triggered when (a) a reasoner audit produces a recommendation that materially expands sprint scope, or (b) two consecutive reasoner audits return thin / hand-wavy output. Same vendor, lower cost. |

DeepSeek's API uses stable aliases (`deepseek-chat`, `deepseek-reasoner`) that auto-track to the latest model version. Spec wording uses the aliases, so V4 / future versions are picked up without a spec edit.[^1]

[^1]: If a more granular endpoint emerges (e.g. a `flash` variant), Claude runs both endpoints on a real audit, compares outputs, and only then promotes the new endpoint into the slot. Promotion criteria: equal or better citation accuracy, no new fabrication, comparable latency.

### Dropped from the candidate list (and why)

- **Kimi K2** — its key differentiator is agentic tool-use. Our brief-and-shell pattern is single-shot inference; Kimi's edge does not apply. Earns a seat only if we later add a sub-architecture where a model drives its own tool loop.
- **MiniMax** — the active code surface fits comfortably within 128K. No long-context win to capture.
- **Qwen** — would be another generic code model in a slot already filled.

## Coordination Protocol

### File layout

All multi-model artifacts live under one root for traceability:

```
docs/team/
├── README.md                              # protocol overview, brief template, dispatch examples
├── briefs/YYYY-MM-DD-<task>.md            # written by Claude before each dispatch
├── outputs/YYYY-MM-DD-<task>.<model>.md   # raw model output, captured verbatim
└── decisions/YYYY-MM-DD-<task>.md         # Claude's integration decision + diff hash + verification evidence
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

**Rules for `Files in scope` and `Acceptance criteria`:**
- File paths and line ranges must be real and verified by Claude before dispatch (`Read` the file, confirm the symbol is at the line range cited).
- Acceptance criteria must reference **real symbols, counters, build flags, and log signatures** that exist in the current codebase. Inventing plausible-sounding identifiers is the canonical multi-model failure mode and acceptance criteria are the bulwark against it.
- These two rules apply to the path and symbol citations in **this spec's own First Sprint table** as well — not just briefs the team produces.
- Briefs reference files by path + line range. They do **not** inline file contents by default. A dispatch-time helper inlines the cited ranges into the actual model payload, so the brief stays compact and the model sees verbatim source. Implementation of that helper belongs to the writing-plans phase.

`patch` means a unified diff or full-file replacement that Claude can apply. `analysis` means prose with file:line citations. `answer` means a direct response to a closed question.

### Dispatch flow

1. Claude writes `briefs/<task>.md`. Verifies all cited paths/symbols exist.
2. Claude shells out:
   - **Codex:** `cat docs/team/briefs/<task>.md | codex exec - > docs/team/outputs/<task>.codex.md` (prompt via stdin).
   - **DeepSeek:** `Bash` tool with inline `curl` POST. Payload assembled by Claude in the same turn: system role + the brief body + inlined file ranges. Response body captured to `docs/team/outputs/<task>.<model>.md`.
3. Claude reads the output, validates against acceptance criteria.
4. If `patch`: apply, build, run verification, write `decisions/<task>.md`.
5. If `analysis` or `answer`: integrate into the next brief or apply directly if small. `decisions/<task>.md` written either way.
6. Commit with the conventional-commit subject required by `CLAUDE.md` auto-versioning, then a footer line `Team-Task: <task-id>` separated from the subject by a blank line. Example:

   ```
   feat(recomp): variant-4 fiber takeover in EmuThreadFunction

   Wires kn_recomp_get_enabled() check before mupen interp call.

   Team-Task: phase-2f-w2-fiber-takeover
   Co-Authored-By: ...
   ```

   `git log --grep='Team-Task:'` is the source of truth for what the team has produced.

### Decisions file format

`decisions/<task>.md` records the integration outcome:

```markdown
# <task-id> — Decision

**Output reviewed:** outputs/<task>.<model>.md
**Verdict:** applied | rejected | partially-applied
**Diff hash:** <git rev-parse HEAD after apply, or "n/a" for analysis tasks>

## Verification evidence
- Build: KN_FAST=1 build OK / FAIL with stderr excerpt
- Counters: <captured kn_um_get_* etc. from Module call>
- Log signatures observed: ...
- Frame counter delta over 60s: ...

## Rationale
Why applied / rejected. If rejected, what fix-up brief follows.

## Follow-ups
- New brief: <task-id-or-none>
- Open question: ...
```

This file is the durable record of what happened, independent of git history details. Decisions files are committed alongside the patch they describe.

### Acceptance and integration rules

- **Patches that don't build** → reject. Claude writes a fix-up brief with build error inlined; does not silently fix.
- **Patches that build but fail acceptance criteria silently** (counter never increments, frame watchdog stays flat, no log signature) → reject. Decision file records what was expected vs observed; fix-up brief follows.
- **Determinism regressions** → hard stop. Fix-forward only (`feedback_no_reverting.md`). Surface to user.
- **Hallucinated file contents or invented symbols** → reject. Re-brief with explicit file ranges inlined and a note that the prior output cited a non-existent symbol.
- **Truncated patches** (Codex output ends mid-hunk, mid-function, or with a missing closing brace) → reject without applying. Re-brief with the same task split into smaller units.
- **Codex / DeepSeek conflict** → Claude reads the actual code and decides. If genuinely ambiguous, escalate to user.

## First Sprint Shape

This sprint takes the smash64r branch from its current state (Phase 2f Wave 1 dormant infrastructure landed) to the prototype DoD.

| # | Owner | Task | Depends on |
|---|-------|------|-----------|
| 1 | Codex | Implement variant 4 — fiber takeover inside `EmuThreadFunction` (`build/src/mupen64plus-libretro-nx/libretro/libretro.c`, both `#ifdef` definitions at lines 523 and 525). Inject `kn_recomp_get_enabled()` check before mupen interp call; route to `kn_um_drive_frame()` when enabled. | — |
| 2 | Codex | Wire `osRecvMesg(BLOCK)` park via `um_thread_park_on()`; wire `osSendMesg` parked-receiver wake via `um_queue_wake_one()`. | #1 |
| 3 | Claude | Build with `KN_FAST=1`, run, capture `kn_um_get_*` and `kn_bounce_get_*` counters + frame-counter watchdog. Verify the residual silent-display freeze is gone (frame counter advances continuously for ≥ 60 s with dispatch enabled). | #2 |
| 4 | DeepSeek-reasoner | Parity audit: enumerate libultra primitives still routing through depth-guard. Output a prioritized list with file:line citations of each primitive's bounce site. Output: `analysis`. | parallel with #1-3 |
| 5 | Codex (if #4 surfaces work) | Wire any libultra primitives flagged by #4 as required for safe depth-guard removal. | #4 |
| 6 | Codex | Drop depth-guard. Benchmark dispatch ON vs OFF (frame time, dispatch rate, bounce rate). | #3 passes AND (#5 done or #4 declared no-op) |
| 7 | DeepSeek-reasoner | Audio path audit: read `build/recomp/kn_port/AUDIO_NOTES.md`, audio shim sources, and SSB64 audio thread lifecycle. Output: `analysis` of what changes (if any) are needed for 60 fps audio under the fiber model. | parallel with #5-6 |
| 8 | Codex (if #7 surfaces work) | Apply audio-path patches per #7 findings. | #7 |
| 9 | Claude | Controller verification under fiber model: Playwright harness + diag counters + manual gamepad input through 1P match. | #6 done; #8 done if invoked |
| 10 | Claude | Final prototype acceptance run: 60 s active gameplay, all five DoD criteria checked, evidence captured to `decisions/prototype-acceptance.md`. | #9 |

`deepseek-chat` (cheap second opinion) is invoked on #4 or #7 if either output is thin or recommends a scope expansion that Claude wants a sanity check on before committing Codex time. Second-opinion runs land their raw output at `outputs/<task>.deepseek-chat.md` and append a "Second-opinion" subsection to the parent task's `decisions/<task>.md` rather than producing a separate decision file.

## Failure Modes

| Mode | Detection | Response |
|------|-----------|----------|
| Model hallucinates file contents or invents symbols | Cited line doesn't exist or contents mismatch on Claude's `Read` | Reject. Re-brief with explicit file ranges inlined. |
| Codex patch fails to build | `KN_FAST=1` build fails | Keep patch in working tree. Write fix-up brief with stderr inlined. Do not `git revert`. |
| Codex patch builds but fails acceptance criteria silently | Counters flat / log signatures absent / frame watchdog stalls | Reject. Decision file records expected-vs-observed. Fix-up brief. |
| Codex output truncated mid-patch | Patch ends mid-hunk / unmatched braces / missing closing chunk | Reject without applying. Re-brief with task split into smaller units. |
| Wedge persists after task #3 verification | Frame counter freezes within 60 s | Diagnose with diag counters. Brief DeepSeek-reasoner for divergence audit before patching. |
| Determinism regression | Determinism probe fails | Hard stop. Fix-forward only. Surface to user. |
| Codex / DeepSeek conflict | Two outputs disagree on root cause or fix shape | Claude reads code, decides. If genuinely ambiguous, escalate to user. |
| API budget exhausted / auth error | Dispatch returns rate-limit or 401 | Pause. Surface to user. Do not silently switch models without approval. |

## Open Questions (deferred to writing-plans)

These do not block this spec but should be answered when writing the implementation plan:

1. **Brief-inlining helper.** The protocol declares briefs reference files by path + line range, with a dispatch-time helper inlining ranges into payloads. The helper's exact form (Python script, shell script, inline in Bash tool) is a writing-plans decision.
2. **Decisions-file retention.** Keep all decisions files in the branch permanently or rotate them after a milestone. Recommend permanent for the prototype phase; revisit at v2.

## Related Context

- `docs/superpowers/specs/2026-04-12-n64recomp-integration-design.md` — the technical-execution spec the team is operating against. Phase 2f Wave 2 entry point and verification harness are defined there.
- Memory: `project_recomp_m2_status.md` — current Phase 2f Wave 1 state and recommended next session order.
- Memory: `feedback_smash64r_no_fallback.md` — discipline rule: route around blockers within smash64r, do not recommend reverting to EmulatorJS.
- Memory: `feedback_no_reverting.md` — fix-forward policy for breaking changes.
