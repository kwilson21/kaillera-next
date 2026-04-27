# 2026-04-27-smash64r-spec-review

## Goal
Identify any technical-accuracy issues, file-path errors, CLI-flag errors, or fabricated symbols in the smash64r multi-model team design spec, before it is treated as final and used to generate the implementation plan. Do **not** modify any files — output analysis only.

## Files in scope
- `docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md` (spec under review — primary target)
- `build/src/mupen64plus-libretro-nx/libretro/libretro.c` (referenced by Sprint task #1; verify `EmuThreadFunction` exists at the cited lines)
- `build/kn_recomp/kn_recomp_shim.c` (verify `kn_get_retro_run_entries` is exported at line 356 on the current branch)
- `build/kn_recomp/kn_recomp_os.c` (referenced by Sprint task #2 — `osRecvMesg`/`osSendMesg`)
- `build/kn_recomp/ultramodern.c` and `build/kn_recomp/ultramodern.h` (verify `um_thread_park_on` and `um_queue_wake_one` are real symbols)
- `CLAUDE.md` (project conventions, especially the conventional-commit-driven auto-versioning policy)
- `scripts/bump-version.sh` if it exists (to confirm the trailer-vs-subject auto-versioning behavior)

## Constraints
- **Do NOT make any file modifications.** This is a review pass, output is analysis only.
- Cite specific `file:line` for every issue you flag.
- Distinguish **factual errors** (wrong path, missing symbol, broken CLI flag) from **style preferences** (wording, structure).
- Do not fabricate symbols, paths, or line numbers to support a claim — verify by reading the file.
- Current branch is `feat/smash64r-wasm` for symbol verification, but the spec lives on `main`. Some symbols (e.g., `kn_get_retro_run_entries`) only exist on the smash64r branch — that is intentional and the spec acknowledges it.

## Task
Cross-check the spec against the actual codebase. Specifically:

1. **Sprint table tasks #1–#10** — for every file path, line range, and symbol cited (`EmuThreadFunction`, `kn_recomp_get_enabled`, `kn_um_drive_frame`, `osRecvMesg`/`osSendMesg`, `um_thread_park_on`, `um_queue_wake_one`), verify it exists in the codebase. Flag any mismatch.

2. **Definition of Done #3** — verify `kn_get_retro_run_entries` is exported (Emscripten `EMSCRIPTEN_KEEPALIVE`) at the cited file:line. Confirm the JS-side accessor `Module._kn_get_retro_run_entries` matches Emscripten's underscore-prefix convention.

3. **Coordination protocol — Codex dispatch** — the spec uses `cat <brief> | codex exec -` (stdin). Verify this against `codex exec --help`. Flag any flag/option that does not exist.

4. **Coordination protocol — DeepSeek dispatch** — the spec asserts the API endpoint is `https://api.deepseek.com/v1/chat/completions`. Flag if you have evidence this is wrong; do not flag if you cannot confirm.

5. **Conventional-commit interaction with the `Team-Task:` footer** — the spec puts `Team-Task: <id>` as a Git footer below a conventional-commit subject, claiming the auto-versioning script only inspects subjects. Verify against `scripts/bump-version.sh` (or whatever the auto-version script is). Flag if the trailer would actually interfere.

6. **Failure modes coverage** — given the dispatch flow described, are there real failure modes missing? Be specific about which ones and why.

7. **Internal consistency** — sprint dependencies, file layout vs dispatch flow references, brief format vs actual examples — flag any contradiction.

## Acceptance criteria
N/A — this is a review task, not a code change.

## Output format

`analysis`

Structure your response as:

```markdown
## Issues
1. [file:line in the spec] — [what's wrong] — [evidence: what you found in the codebase that contradicts it] — [why it matters]
2. ...

## Verifications
- [each citation in the spec you actually verified as correct, one bullet each]

## Suggestions (advisory)
- [improvements that aren't errors, but would tighten the spec]
```

Be terse. No fluff. Cite file:line for every claim, both in the spec and in the codebase.
