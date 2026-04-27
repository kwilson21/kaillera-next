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
| Reviewer + integrator + spec writer + determinism gatekeeper | Claude (interactive Claude Code session) | n/a — invoked by user when judgment quality matters more than throughput | Reviews Codex patches and DeepSeek audits before they're treated as final. Writes durable spec/doc artifacts where calibration and synthesis quality matter. Hard-stops anything that breaks determinism, R1-R6 rollback integrity, or scope discipline. **Strategic orchestration is the user's role**, not Claude's — the team is a force multiplier for the user, not a replacement. |
| Primary systems engineer + spec/doc reviewer | Codex (GPT-5 Codex) | `cat <brief> \| codex exec --sandbox <mode> -o <output-file> -` (prompt via stdin, last-message captured cleanly via `-o`). `<mode>` is `read-only` for review tasks, `workspace-write` for codegen, `danger-full-access` when web verification of external API/docs claims is needed (Codex sandboxed without web access will hallucinate citations). | Strongest single-shot patch producer for C/C++ systems work. Also reviews specs/docs Claude writes — different blind spots from Claude, catches code-correctness issues, file-path/symbol fabrication, and stale design that Claude reviewers miss (validated against this spec — see `docs/team/decisions/2026-04-27-smash64r-spec-review.md`). |
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
- Counter: kn_fiber_get_drive_frame_calls > 0 within 5 seconds of dispatch enable
  (real export at build/kn_recomp/kn_recomp_shim.c:520 on feat/smash64r-wasm)
- Log signature: no "RB-INVARIANT-VIOLATION" in console

## Output format
patch | analysis | answer
```

**Rules for `Files in scope` and `Acceptance criteria`:**
- File paths and line ranges must be real and verified by Claude before dispatch (`Read` the file, confirm the symbol is at the line range cited).
- Acceptance criteria must reference **real symbols, counters, build flags, and log signatures** that exist in the current codebase. Inventing plausible-sounding identifiers is the canonical multi-model failure mode and acceptance criteria are the bulwark against it.
- These two rules apply to the path and symbol citations in **this spec's own First Sprint table** as well — not just briefs the team produces.
- Briefs reference files by path + line range. They do **not** inline file contents by default. **Codex dispatches** read files directly from disk via Codex's own tooling — no inlining helper needed; the brief is piped as-is. **DeepSeek/OpenAI/other API-only dispatches** require a dispatch-time helper that inlines the cited ranges into the JSON payload (model has no filesystem access). Implementation of that helper belongs to the writing-plans phase.
- **Gitignored paths.** `build/src/` is a local build checkout (`.gitignore:8-9`) populated by `build/build.sh`. Briefs that cite paths under `build/src/` only work if the build setup phase has run; the brief writer is responsible for verifying the path exists before dispatch.

`patch` means a unified diff or full-file replacement that Claude can apply. `analysis` means prose with file:line citations. `answer` means a direct response to a closed question.

### Dispatch flow

1. Claude writes `briefs/<task>.md`. Verifies all cited paths/symbols exist.
2. Claude shells out:
   - **Codex:** `cat docs/team/briefs/<task>.md | codex exec --sandbox <mode> -o docs/team/outputs/<task>.codex.md -`. The `-o` flag captures the model's last message cleanly; stdout redirection would mix progress events with content. `<mode>` is `read-only` for review-only tasks, `workspace-write` for codegen, and `danger-full-access` when the task requires web verification of external claims (without it, Codex hallucinates "official docs" citations with fabricated line numbers — observed in this spec's own dispatch log).
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

**Deferred to writing-plans, pending fresh branch audit.** The original draft of this section was written against `project_recomp_m2_status.md` (dated 2026-04-15, "Phase 2f Wave 1 dormant infrastructure landed"). The 2026-04-27 Codex spec review (`docs/team/decisions/2026-04-27-smash64r-spec-review.md`) confirmed the branch has advanced significantly — Wave 5 has landed (depth-guard removed at `build/kn_recomp/kn_recomp_shim.c:741-745`), the active fiber-takeover injection target is `run_cached_interpreter` in `cached_interp.c` (not `EmuThreadFunction`), and several of the originally-planned tasks (drop depth-guard, wire osRecvMesg/osSendMesg in the cited form) are stale or already done.

Designing a concrete sprint against stale state would burn dispatch budget and produce wrong work. The first sprint is therefore designed in the writing-plans phase, where the first action is a **fresh audit of `feat/smash64r-wasm`**: read recent commits, walk current `kn_recomp_*` exports, read current `cached_interp.c` injection sites, identify the actual gap between current state and the prototype DoD. The sprint table is regenerated against that audit, not against memory.

The team / protocol / dispatch flow / failure modes / DoD in this spec stay valid — those are the durable architecture. The sprint sequencing is the volatile part and belongs downstream.

`deepseek-chat` (cheap second opinion) remains available — invoked on any future audit task whose output feels thin or recommends a scope expansion Claude wants sanity-checked before committing Codex time. Second-opinion runs land raw output at `outputs/<task>.deepseek-chat.md` and append a "Second-opinion" subsection to the parent task's `decisions/<task>.md`.

## Failure Modes

| Mode | Detection | Response |
|------|-----------|----------|
| Model hallucinates file contents or invents symbols | Cited line doesn't exist or contents mismatch on Claude's `Read` | Reject. Re-brief with explicit file ranges inlined. |
| Sandboxed Codex hallucinates external doc citations | Codex review claims to cite "official docs lines X-Y" while running with `--sandbox read-only` (no web access) | Treat as advisory, not fact. Verify externally via `WebFetch` / `WebSearch` in Claude before acting. To avoid: re-dispatch with `--sandbox danger-full-access` when web verification is required. |
| Codex patch fails to build | `KN_FAST=1` build fails | Keep patch in working tree. Write fix-up brief with stderr inlined. Do not `git revert`. |
| Codex patch builds but fails acceptance criteria silently | Counters flat / log signatures absent / frame watchdog stalls | Reject. Decision file records expected-vs-observed. Fix-up brief. |
| Codex output truncated mid-patch | Patch ends mid-hunk / unmatched braces / missing closing chunk | Reject without applying. Re-brief with task split into smaller units. |
| Codex non-zero exit / empty output | `codex exec` returns non-zero status, or `<output>.codex.md` is empty / contains only progress events | Treat as dispatch failure, not a model verdict. Inspect stderr; retry once with `--sandbox` adjusted; surface to user if persistent. |
| DeepSeek `finish_reason ≠ "stop"` | API response shows `finish_reason` of `length`, `content_filter`, or `insufficient_system_resource` | Output is incomplete or filtered. Do not act on it. For `length`: re-dispatch with task split or `max_tokens` raised. For `content_filter` / `insufficient_system_resource`: surface to user. |
| Invalid JSON in DeepSeek response | `curl` returns non-2xx, or response body is not parseable JSON, or `choices[0].message.content` missing | Treat as dispatch failure. Re-dispatch once; surface if persistent. |
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
