# 2026-04-27-smash64r-spec-review — Decision

**Output reviewed:** `docs/team/outputs/2026-04-27-smash64r-spec-review.codex.md`
**Verdict:** applied (analysis task — no code patch; spec edits applied per findings)
**Diff hash:** see commit message of the spec-fix commit

## Verification evidence

Each Codex finding was independently verified by Claude before action:

- `kn_fiber_get_drive_frame_calls` and `kn_fiber_get_switches` exist as Emscripten exports at `git show feat/smash64r-wasm:build/kn_recomp/kn_recomp_shim.c:520,533` — confirmed
- `kn_um_get_swap_count` (the symbol the spec fabricated) does not exist on the branch — confirmed
- Wave 5 depth-guard removal: `git show feat/smash64r-wasm:build/kn_recomp/kn_recomp_shim.c:741-745` contains the comment "Wave 5: depth-guard removed" — confirmed
- `build/src/` is gitignored at `.gitignore:8-9` — confirmed
- `codex exec --help` shows `--sandbox` and `-o` flags as Codex described — confirmed via direct invocation

Not verified by Claude (treated as advisory, not fact):
- Codex's claim that DeepSeek aliases (`deepseek-chat` / `deepseek-reasoner`) are deprecated 2026-07-24 in favor of `deepseek-v4-flash` modes, citing "official docs lines 48-53 and API reference lines 147-150." Codex was running with `--sandbox read-only` and had no web access, so this citation is structurally suspect (matches the new "sandboxed Codex hallucinates external doc citations" failure mode). Flagged for separate verification before any spec change to model-naming policy.

## Findings acted on (8)

1. **Fabricated counter symbol in brief-format example** — replaced `kn_um_get_swap_count` with `kn_fiber_get_drive_frame_calls` plus its real file:line citation. Spec violated its own "real symbols" rule; now compliant.
2. **First Sprint table is stale against current branch state** — replaced the entire table with a deferral note pointing the design of the concrete sprint into the writing-plans phase, where the first action is a fresh audit of `feat/smash64r-wasm`. Codex flagged that Sprint #1's `EmuThreadFunction` target was already tried and reverted (active target is `run_cached_interpreter` in `cached_interp.c`), Sprint #2's wiring sites sit after unconditional returns (live park/wake calls are at different lines), and Sprints #4-#6 assume a depth-guard that's already removed. Designing against stale state would burn dispatch budget and produce wrong work.
3. **Internal contradiction: dispatch helper vs. compact brief** — clarified that Codex reads files directly from disk via its own tooling (no helper needed); only API-only models (DeepSeek/OpenAI/etc.) require a dispatch-time inlining helper.
4. **Codex dispatch line missing sandbox/output flags** — added `--sandbox <mode>` and `-o <output-file>` to the dispatch command, with mode guidance per task type (`read-only`, `workspace-write`, `danger-full-access`).
5. **`build/src/` gitignored note** — added a rule that briefs citing paths under `build/src/` require the `build/build.sh` setup phase to have run; brief writer is responsible for verifying paths exist before dispatch.
6. **Failure modes incomplete** — added four new modes: sandboxed-Codex-hallucinated-citations, Codex-non-zero-exit/empty-output, DeepSeek-`finish_reason ≠ stop`, invalid-JSON-in-DeepSeek-response.
7. **Codex's role broadened beyond codegen** — team-table entry updated to "Primary systems engineer + spec/doc reviewer" and Claude's entry rewritten to drop the "orchestrator" label (strategic orchestration is the user's role) and reframe Claude's behavioral fit as reviewer + integrator + spec writer + determinism gatekeeper.
8. **Cross-review pattern documented** — Codex review of Claude's spec output (this very dispatch) added as the canonical example of cross-review value, both in the team-table rationale and in this decision file.

## Findings deferred (not acted on)

- **DeepSeek alias deprecation date (2026-07-24)** — flagged in the new "sandboxed Codex hallucinates external doc citations" failure mode. Will verify externally before any model-naming-policy change. The spec already uses stable aliases that auto-track to the latest model, so even if Codex's claim is correct, the spec wording is robust to it.

## Cross-review pattern validation

This dispatch is the canonical proof point for the cross-review pattern. The smash64r spec went through three Claude-based spec reviewer passes (general-purpose subagents, all reaching "Approved"). Codex's pass — independent training origin, code-aware, instruction-tuned to actually read the repo — caught **9 substantive issues** the Claude reviewers missed, including the fabricated symbol that violates the spec's own rule and the wholesale staleness of the first-sprint design.

The pattern is not "Claude reviews everything" or "one reviewer is enough." It is **independent voices from different training origins**, where each catches the other's blind spots. This finding is folded into the spec's team table and the protocol's review rules.

## Follow-ups

- Verify the DeepSeek alias-deprecation claim externally (separate task).
- Consume this decision in writing-plans: the "fresh `feat/smash64r-wasm` audit" task is the first thing that gets planned and dispatched.
- Re-dispatch Codex on the spec-fix commit (sanity check that the fixes hold up) — optional, only if scope/budget allows.
