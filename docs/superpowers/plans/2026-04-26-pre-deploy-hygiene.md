# Pre-deploy Hygiene Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the working tree from its current state (14 modified + ~30 untracked + stale docs) to a clean `main` with semantically split commits, ready for the user to run `just deploy`.

**Architecture:** A single linear sequence of 6 commits (5 if commit 4 is a no-op skip). No code logic changes — this is a hygiene/triage/doc pass. Each commit has a concrete pre-flight assertion, a precise stage list, a diff verification, and a structured commit message. Per-commit gates catch source-edit leaks into doc commits and missing files at the final gate.

**Tech Stack:** `git`, standard Unix tools (`grep`, `sed`, `awk`, `wc`). No build/run/test execution required (per the spec's `feedback_test_what_fixes_desyncs` rationale; the runtime fix in commit 2 was already validated by an earlier V8/JSC 5-minute stress pass).

**Spec:** [docs/superpowers/specs/2026-04-26-pre-deploy-hygiene-design.md](../specs/2026-04-26-pre-deploy-hygiene-design.md)

---

## File structure

This plan touches files; it does not create new source modules. The full inventory by commit:

**Commit 1 (gitignore):**
- Modify: `.gitignore`

**Commit 2 (runtime fix + WASM trio + audio patch):**
- Modify: `build/build.sh`, `build/kn_rollback/{kn_hash_registry,kn_rollback}.c`, `server/src/api/{payloads,signaling}.py`, `web/play.html`, `web/static/{kn-audio,kn-desync-detector,kn-diagnostics,kn-state,netplay-lockstep,play,shared}.js`
- Modify: `web/static/ejs/cores/mupen64plus_next-wasm.data`
- Create: `web/static/ejs/cores/mupen64plus_next_libretro.{js,wasm}` (newly tracked rebuilt core)
- Create: `build/patches/audio-backend-skip-output.patch` (newly tracked build input)

**Commit 3 (markdown freshen):**
- Verify-and-maybe-edit: `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, `docs/roadmap.md`, `docs/mvp-plan.md`, `docs/netplay-invariants.md`
- Create: `docs/research/cross-engine-determinism-investigation.md`, `docs/research/floppyfloat-vs-softfloat-verdict.md` (move from untracked into commit; no content edit unless missing date/status header)

**Commit 4 (module headers, may skip):**
- Verify-and-maybe-edit: 12-file allowlist (8 JS in `web/static/`, 4 Python in `server/src/api/`)

**Commit 5 (test infra):**
- Create: `tests/{determinism-automation,record-nav,record-nav-auto}.mjs`, `tests/fixtures/nav-recording.json`, `tests/package.json`

**Commit 6 (diagnostics):**
- Create: `build/patches/{mupen64plus-defer-video,mupen64plus-interrupt-counters,rdram-det-watch}.patch`, `build/patch-asyncify-counter.mjs`
- Create: `tools/{composite_grid,composite_screenshots,diff_rand_calls,diff_thread_samples,pc_to_symbol,rdram_diff,trace_extract,trace_generate}.py`

---

## Chunk 1: Pre-flight, scratch deletion, and Commit 1 (gitignore)

### Task 1.1: Verify starting state

**Files:** none touched; read-only checks.

- [ ] **Step 1: Confirm clean baseline (no in-flight rebase, on main)**

Run:
```bash
git rev-parse --abbrev-ref HEAD
git status --short | head -1 | wc -l   # at least 1 line of output expected
test ! -d .git/rebase-merge && test ! -d .git/rebase-apply && echo "no rebase in progress"
```
Expected: `main`, then a non-zero count, then `no rebase in progress`. If the branch is not `main` or a rebase is in progress, **stop and surface to user.**

- [ ] **Step 2: Count modified and untracked files**

Run:
```bash
git status --short | awk '/^ M/' | wc -l
git status --short | awk '/^\?\?/' | wc -l
```
Expected: `14` for modified, a value in `28..32` for untracked. If counts don't match, the tree drifted since spec write — **stop, surface drift to user, do not proceed.**

- [ ] **Step 3: Verify the 14 modified files match the spec list**

Run:
```bash
git status --short | awk '/^ M/ {print $2}' | sort > /tmp/actual_modified.txt
cat <<'EOF' | sort > /tmp/expected_modified.txt
build/build.sh
build/kn_rollback/kn_hash_registry.c
build/kn_rollback/kn_rollback.c
server/src/api/payloads.py
server/src/api/signaling.py
web/play.html
web/static/ejs/cores/mupen64plus_next-wasm.data
web/static/kn-audio.js
web/static/kn-desync-detector.js
web/static/kn-diagnostics.js
web/static/kn-state.js
web/static/netplay-lockstep.js
web/static/play.js
web/static/shared.js
EOF
diff /tmp/expected_modified.txt /tmp/actual_modified.txt
```
Expected: no diff output (silent success). If diff appears, the tree drifted — **stop, surface to user.**

- [ ] **Step 4: Verify SF_SOURCES sanity for the reproducibility assertion later in commit 2**

Run:
```bash
grep -nE '^[[:space:]]*SF_SOURCES=\(' build/build.sh
sed -n '517,584p' build/build.sh | grep -c '\.c"$'
sed -n '517,584p' build/build.sh | grep -E '(f32_to_i(32|64)|f64_to_i(32|64))' | wc -l
```
Expected: `516:    SF_SOURCES=(`, then `67`, then `0`. If any value drifts, **stop and surface to user** — the reproducibility assertion no longer holds.

### Task 1.2: Delete scratch (single rm batch, no commit)

**Files:** deletes only; nothing staged.

- [ ] **Step 1: Verify all scratch targets exist before deleting**

Run:
```bash
for path in \
  round3-log.json \
  round3-postfix-log.json \
  web/static/ejs/cores/mupen64plus_next-wasm.data.bak-20260424-1245 \
  web/static/ejs/cores/mupen64plus_next-wasm.data.bak-8927a38a \
  tools/deepseek_screenshot_diff.py \
  tests/recomp-ci \
  build/patch-asyncify-counter.py \
  build/patch-fpu-rounding.py \
  build/calc_ft_mask.py \
  build/softfloat/f32_to_i32.c \
  build/softfloat/f32_to_i32_r_minMag.c \
  build/softfloat/f32_to_i64.c \
  build/softfloat/f32_to_i64_r_minMag.c \
  build/softfloat/f64_to_i32.c \
  build/softfloat/f64_to_i32_r_minMag.c \
  build/softfloat/f64_to_i64.c \
  build/softfloat/f64_to_i64_r_minMag.c
do
  test -e "$path" && echo "exists: $path" || echo "MISSING: $path"
done
```
Expected: every line starts with `exists:`. If any line says `MISSING:`, **stop, investigate, and surface to user** — do not delete a partial set.

- [ ] **Step 2: Delete the scratch set**

Run:
```bash
rm -v \
  round3-log.json \
  round3-postfix-log.json \
  web/static/ejs/cores/mupen64plus_next-wasm.data.bak-20260424-1245 \
  web/static/ejs/cores/mupen64plus_next-wasm.data.bak-8927a38a \
  tools/deepseek_screenshot_diff.py \
  build/patch-asyncify-counter.py \
  build/patch-fpu-rounding.py \
  build/calc_ft_mask.py \
  build/softfloat/f32_to_i32.c \
  build/softfloat/f32_to_i32_r_minMag.c \
  build/softfloat/f32_to_i64.c \
  build/softfloat/f32_to_i64_r_minMag.c \
  build/softfloat/f64_to_i32.c \
  build/softfloat/f64_to_i32_r_minMag.c \
  build/softfloat/f64_to_i64.c \
  build/softfloat/f64_to_i64_r_minMag.c
rm -rfv tests/recomp-ci
```
Expected: each path is removed. The `tests/recomp-ci` removal is recursive because the directory contains binaries, dSYM bundles, screenshots, and logs.

- [ ] **Step 3: Verify nothing got modified (only untracked deletions)**

Run:
```bash
git status --short | awk '/^ M/' | wc -l
git status --short | awk '/^ D/' | wc -l
```
Expected: `14` (the modified count is unchanged), and `0` (no tracked file got deleted). If `git status` shows any new ` D` (tracked deletion), a tracked file was removed by accident — **stop, restore from index (`git restore <path>`), and surface to user.**

### Task 1.3: Commit 1 — `chore: gitignore local sandboxes & generated artifacts`

**Files:** Modify `.gitignore`.

- [ ] **Step 1: Read the current .gitignore tail to find a clean append point**

Run:
```bash
tail -20 .gitignore
```
Expected: file ends without a trailing comment header for "Local sandboxes & generated artifacts" — confirms we're adding a fresh section.

- [ ] **Step 2: Append the new ignore entries**

Use Edit (or `cat >>`) to append the following block to `.gitignore`:
```
# Local sandboxes & generated artifacts (added 2026-04-26 for prod cut)
server/kaillera.db
build/build/
build/recomp/
build/recomp-tool/
build/test/
tools/dl-recorder/
web/smash64r-test/
web/webgpu-pivot-test/
```

- [ ] **Step 3: Verify each ignore line removes its target from `git status`**

Run:
```bash
git status --short | awk '/^\?\?/ {print $2}' | grep -E '^(server/kaillera\.db|build/(build|recomp|recomp-tool|test)/|tools/dl-recorder/|web/(smash64r-test|webgpu-pivot-test)/)$'
```
Expected: empty output. Each path is now ignored. If any of these still appear, the corresponding gitignore line is wrong — fix and re-check.

- [ ] **Step 4: Verify only `.gitignore` is staged so far**

Run:
```bash
git add .gitignore
git diff --cached --name-only
```
Expected: a single line `.gitignore`. If anything else appears, unstage with `git restore --staged <path>` before committing.

- [ ] **Step 5: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
chore: gitignore local sandboxes & generated artifacts

Adds .gitignore entries for the local-only state that accumulates during
development: SQLite db, intermediate build/research dirs (build/, recomp/,
recomp-tool/, test/), tools/dl-recorder/ captures, and the
smash64r-test / webgpu-pivot-test browser sandboxes. Pre-deploy hygiene;
no behavior change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
Expected: commit succeeds. If a pre-commit hook fails, fix the underlying issue and re-stage; do **NOT** use `--amend` or `--no-verify`.

- [ ] **Step 6: Post-commit verification**

Run:
```bash
git log -1 --pretty=format:'%h %s'
git status --short | wc -l
```
Expected: a `chore:` commit subject, and a status line count that decreased from the start (the ignored paths no longer appear).

---

## Chunk 2: Commit 2 — runtime fix + WASM trio + audio patch

### Task 2.1: Verify the rebuilt WASM trio matches the patch set being committed

**Files:** read-only checks against `build/build.sh` and the trio.

- [ ] **Step 1: Re-verify SF_SOURCES line offsets and entry count (already checked in Task 1.1 Step 4, but the patch source state may have shifted between deletes and commit 2 staging)**

Run:
```bash
grep -nE '^[[:space:]]*SF_SOURCES=\(' build/build.sh
sed -n '517,584p' build/build.sh | grep -c '\.c"$'
sed -n '517,584p' build/build.sh | grep -E '(f32_to_i(32|64)|f64_to_i(32|64))' | wc -l
```
Expected: `516:    SF_SOURCES=(`, `67`, `0`. If any check fails, the WASM trio cannot be claimed reproducible from current sources — **stop and surface to user.** They will rebuild before staging.

- [ ] **Step 2: Verify `audio-backend-skip-output.patch` is wired into the build**

Run:
```bash
grep -nE 'audio-backend-skip-output\.patch' build/build.sh
test -f build/patches/audio-backend-skip-output.patch && echo "patch present"
```
Expected: a hit at line `165:` (or thereabouts) showing `git apply` of the patch, then `patch present`. If either fails, the build wiring or the file is wrong — **stop and surface.**

- [ ] **Step 3: Verify the trio files exist and the legacy symlinks still resolve**

Run:
```bash
ls -lL web/static/ejs/cores/mupen64plus_next-wasm.data \
       web/static/ejs/cores/mupen64plus_next_libretro.js \
       web/static/ejs/cores/mupen64plus_next_libretro.wasm \
       web/static/ejs/cores/mupen64plus_next-legacy-wasm.data \
       web/static/ejs/cores/parallel_n64-legacy-wasm.data
```
Expected: all three core files exist as regular files; the two legacy symlinks resolve (`-L` follows them — they point at `mupen64plus_next-wasm.data` per the gitStatus ls).

### Task 2.2: Stage commit 2 — production source changes

**Files:** see "File structure → Commit 2" above. All staging is explicit (no `git add -A`).

- [ ] **Step 1: Stage the C / build inputs**

Run:
```bash
git add build/build.sh \
        build/kn_rollback/kn_hash_registry.c \
        build/kn_rollback/kn_rollback.c \
        build/patches/audio-backend-skip-output.patch
```

- [ ] **Step 2: Stage the server changes**

Run:
```bash
git add server/src/api/payloads.py \
        server/src/api/signaling.py
```

- [ ] **Step 3: Stage the runtime JS + HTML**

Run:
```bash
git add web/play.html \
        web/static/kn-audio.js \
        web/static/kn-desync-detector.js \
        web/static/kn-diagnostics.js \
        web/static/kn-state.js \
        web/static/netplay-lockstep.js \
        web/static/play.js \
        web/static/shared.js
```

- [ ] **Step 4: Stage the WASM trio together (the unit invariant)**

Run:
```bash
git add web/static/ejs/cores/mupen64plus_next-wasm.data \
        web/static/ejs/cores/mupen64plus_next_libretro.js \
        web/static/ejs/cores/mupen64plus_next_libretro.wasm
```

### Task 2.3: Verify the staged set matches commit 2's intended scope

- [ ] **Step 1: Print staged file list and compare to expectation**

Run:
```bash
git diff --cached --name-only | sort > /tmp/actual_commit2.txt
cat <<'EOF' | sort > /tmp/expected_commit2.txt
build/build.sh
build/kn_rollback/kn_hash_registry.c
build/kn_rollback/kn_rollback.c
build/patches/audio-backend-skip-output.patch
server/src/api/payloads.py
server/src/api/signaling.py
web/play.html
web/static/ejs/cores/mupen64plus_next-wasm.data
web/static/ejs/cores/mupen64plus_next_libretro.js
web/static/ejs/cores/mupen64plus_next_libretro.wasm
web/static/kn-audio.js
web/static/kn-desync-detector.js
web/static/kn-diagnostics.js
web/static/kn-state.js
web/static/netplay-lockstep.js
web/static/play.js
web/static/shared.js
EOF
diff /tmp/expected_commit2.txt /tmp/actual_commit2.txt
```
Expected: no diff output. If anything differs, unstage the offender (`git restore --staged <path>`) or stage what was missed before continuing.

- [ ] **Step 2: Confirm no unintended unstaged changes remain in the commit-2 file set**

Run:
```bash
git status --short | awk '/^ M/' | wc -l
```
Expected: `0`. All 14 originally-modified files are now staged. If non-zero, something was missed in Task 2.2 — re-stage.

### Task 2.4: Commit 2

- [ ] **Step 1: Commit with the structured message (lead with the actual sync fix)**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(rollback): add menu-start barrier and C-input pipeline

Sync correctness fix in netplay-lockstep.js:
- Menu-start barrier with settle delay (MENU_START_BARRIER_SETTLE_MS=500)
  and per-peer phase broadcast — eliminates the race where peers begin
  their first input frame at slightly different scenes
- C-input pipeline: _feedCInput direct feed plus _backfillCInputsFromJs
  rolling-window backfill on rollback restore
- Rollback delay clamps (ROLLBACK_MIN_DELAY_FRAMES=4,
  ROLLBACK_MAX_DELAY_FRAMES=7)
- Guest-state kind tracking ('savestate' vs 'kn-sync') and host-side
  hidden-state sidecar
- Input-buttons normalization across local + remote audit paths

Supporting work:
- Field-granular hash registry: build/kn_rollback/kn_hash_registry.c,
  kn_rollback.c, build/build.sh wiring
- Cross-peer detector wiring across kn-desync-detector, kn-diagnostics,
  kn-state, play, shared, kn-audio, play.html
- Audio determinism: build/patches/audio-backend-skip-output.patch
  (verified wired into build.sh:165)
- Server payload + event additions for the cross-peer hash protocol

Deployed core trio rebuilt from this commit's source state:
mupen64plus_next-wasm.data, mupen64plus_next_libretro.{js,wasm}.
SF_SOURCES (build.sh:517-584) is unchanged; reproducible without the
8 deleted SoftFloat conversion files.

URL-param diagnostic flags (knperf=light, kntrace=1, kndiag=deep,
desync=deep, knflush=live) are opt-in only — no production impact when
unset.

Already validated via 5-minute V8/JSC stress pass before this hygiene
commit-split. No new test run required.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
Expected: commit succeeds. If a pre-commit hook fails, fix the underlying issue and re-stage; do **NOT** `--amend` or `--no-verify`.

- [ ] **Step 2: Post-commit verification**

Run:
```bash
git log -1 --stat | head -25
git status --short | wc -l
```
Expected: a `feat(rollback):` commit subject with the 17 files in `--stat`, and a status line count that has decreased by the staged set. The remaining untracked items are now scoped to commits 3–6.

---

## Chunk 3: Commit 3 — markdown content pass

The content pass is **read-then-decide-per-file**. For each markdown file, the executor reads it, compares against current code, and either no-ops or applies a minimal targeted edit. The criterion is "does the doc make a claim that no longer holds?" — not "is this doc as polished as it could be."

**Universal rule for "only if edited" steps:** if no edit was applied to a file, **skip its `git add` entirely** and do not include the file in this commit. Do not run `git add` on a clean file as a no-op — the goal is for `git diff --cached --name-only` to list only the files that actually changed. This matches the commit message wording ("only files that drifted appear in the diff") and the leak gate at Task 3.6 Step 2.

### Task 3.1: Move the two `docs/research/` files into the staging set

**Files:** `docs/research/cross-engine-determinism-investigation.md`, `docs/research/floppyfloat-vs-softfloat-verdict.md`.

- [ ] **Step 1: Verify both files exist and check for an existing date/status header**

Run:
```bash
head -5 docs/research/cross-engine-determinism-investigation.md
echo '---'
head -5 docs/research/floppyfloat-vs-softfloat-verdict.md
```

For each file, apply this concrete check: if **neither** the first nor the second line of the file contains the substring `2026-04-` (a date stamp) or one of the words `artifact` / `Research` (a status marker), then the file lacks a header — prepend the following with Edit:

```
> **Research artifact — captured 2026-04-25.** Point-in-time investigation; not a living document.

```

(Note the trailing blank line so the original first line stays separated from the prepended header.)

Otherwise leave the file alone — it already has a header.

- [ ] **Step 2: Stage both research files**

Run:
```bash
git add docs/research/cross-engine-determinism-investigation.md \
        docs/research/floppyfloat-vs-softfloat-verdict.md
```

### Task 3.2: Freshen `CLAUDE.md`

- [ ] **Step 1: Read CLAUDE.md and identify drift candidates**

Drift candidates to verify against current code (use the Read tool):
- **Repo structure section:** file inventory under `web/static/` and `server/src/api/`. Concrete check: any file listed in CLAUDE.md that doesn't exist in the tree, or any file present in `web/static/kn-*.js` or `server/src/api/*.py` that's missing from CLAUDE.md.
- **V1 scope table:** any row whose status reads "later" or "in progress" but actually shipped (cross-reference against `docs/roadmap.md` which asserts V1 complete).
- **Socket.IO events table:** narrow scope — only verify events whose payload schema changed in commit 2's `server/src/api/payloads.py` diff. Use `git show HEAD -- server/src/api/payloads.py | grep -E '^[+-]class\|^[+-]    [a-z_]+ ?:'` to find the modified payload classes/fields, then confirm the table description still matches. Do not exhaustively cross-check the ~25 unchanged events.
- **Netplay invariants section:** the link target `[docs/netplay-invariants.md]` must resolve to a real file (it does at spec-write time; a quick `test -f docs/netplay-invariants.md` confirms).

- [ ] **Step 2: Apply minimal edits if drift found**

Use Edit for any specific drift. Examples of what counts as drift:
- A file listed in repo structure that no longer exists, or a new file (e.g., `desync_prompts.py`, `desync_vision.py`, `kn-vision-client.js`) not listed
- A V1 scope row marked "later" that has actually shipped
- An event listed in the table whose payload schema in `payloads.py` no longer matches the description

Examples of what does **not** count as drift (leave alone):
- File counts or sizes (these inflate quickly; not load-bearing in this doc)
- Stylistic prose

- [ ] **Step 3: Stage CLAUDE.md if any edit was applied**

If — and only if — CLAUDE.md was edited in Step 2, run:
```bash
git add CLAUDE.md
```
Otherwise skip (per the universal rule at the top of chunk 3).

### Task 3.3: Freshen `README.md`, `CONTRIBUTING.md`

- [ ] **Step 1: Read README.md, identify install/run/env claims**

Verify: port (`27888`), env vars (`ALLOWED_ORIGIN`, `MAX_ROOMS`, `MAX_SPECTATORS`, `PORT`), the install command, deploy command (`just deploy`), feature highlights against current V1 scope.

- [ ] **Step 2: Apply minimal README edits if drift found, then stage**

If — and only if — README.md was edited in this step, run:
```bash
git add README.md
```
Otherwise skip the `git add` entirely (per the universal rule at the top of chunk 3).

- [ ] **Step 3: Read CONTRIBUTING.md, verify tooling references**

Verify: `uv` is mentioned for Python tooling (per `feedback_uv_python_tooling`), `just` recipes for deploy (`just deploy-dry`, `just deploy`), and any test command works.

- [ ] **Step 4: Apply minimal CONTRIBUTING edits if drift found, then stage**

If — and only if — CONTRIBUTING.md was edited in this step, run:
```bash
git add CONTRIBUTING.md
```
Otherwise skip.

### Task 3.4: Freshen `docs/roadmap.md`, `docs/mvp-plan.md`, `docs/netplay-invariants.md`

- [ ] **Step 1: Read docs/roadmap.md**

Verify the V1-complete claim at the top still matches `CLAUDE.md`'s V1 scope table. Verify V2 status notes match memory (Mupen64Plus desktop client = v2; Kaillera compat = v2).

- [ ] **Step 2: Apply minimal roadmap edits if drift found, then stage**

If — and only if — `docs/roadmap.md` was edited in this step, run:
```bash
git add docs/roadmap.md
```
Otherwise skip.

- [ ] **Step 3: Decide on `docs/mvp-plan.md`**

Read the first 30 lines. If it predates V1 ship and reads as historical, prepend a note rather than rewriting:
```
> **Historical — see `docs/roadmap.md` for current state.** This document is preserved for reference; it captures the original MVP plan and is no longer kept in sync with the live roadmap.
```
If it has been kept current, leave it alone.

- [ ] **Step 4: Stage docs/mvp-plan.md if edited**

If — and only if — `docs/mvp-plan.md` was edited in Step 3, run:
```bash
git add docs/mvp-plan.md
```
Otherwise skip.

- [ ] **Step 5: Read docs/netplay-invariants.md**

Verify I1/I2 deadline-site list and R1–R6 rollback integrity claims still match the lockstep code. Specifically: does the menu-start barrier added in commit 2 qualify as an I1 deadline site?

Concrete acceptance criterion (both must be true to qualify):
1. The barrier code path has a **wall-clock timeout** — confirmed by `grep -nE 'MENU_START_BARRIER_SETTLE_MS|_menuStartReleaseAt' web/static/netplay-lockstep.js` returning hits and showing the constant is compared against `Date.now()` or equivalent.
2. The barrier has a **recovery action on timeout** — confirmed by `grep -nE '_menuStartBarrierReleased' web/static/netplay-lockstep.js` showing a flag flip on settle expiry that releases the gate.

If both conditions hold, add a bullet under the I1 deadline-site list referencing `MENU_START_BARRIER_SETTLE_MS` (timeout) and the release/flag-flip (recovery action). If either condition fails, no-op — the barrier is not an I1 site.

- [ ] **Step 6: Stage docs/netplay-invariants.md if edited**

If — and only if — `docs/netplay-invariants.md` was edited in Step 5, run:
```bash
git add docs/netplay-invariants.md
```
Otherwise skip.

### Task 3.5: Verify the staged set is markdown-only

- [ ] **Step 1: Allowlist check — every staged path must be `.md`**

Run:
```bash
git diff --cached --name-only | grep -vE '\.md$'
```
Expected: empty output. If any non-`.md` file appears, unstage it (`git restore --staged <path>`) — this commit is markdown-only by gate.

- [ ] **Step 2: Print staged set for human eyeball review**

Run:
```bash
git diff --cached --name-only
git diff --cached --stat
```
Expected: only `.md` files; the two `docs/research/*` files appear as `+N -0` (newly tracked); other entries depend on which docs had drift.

### Task 3.6: Commit 3

- [ ] **Step 1: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
docs: refresh project documentation for prod cut

Verify-and-update pass against current code:
- CLAUDE.md, README.md, CONTRIBUTING.md, docs/roadmap.md,
  docs/mvp-plan.md, docs/netplay-invariants.md (only files that drifted
  appear in the diff; unchanged docs are no-op'd)
- docs/research/{cross-engine-determinism-investigation,
  floppyfloat-vs-softfloat-verdict}.md added as research artifacts
  (point-in-time, not living documents)

Markdown-only commit by gate. Module headers / docstrings handled in
the next commit. CHANGELOG.md is auto-generated by just deploy and
is not edited here.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Run the spec's commit-3 leak gate**

Run:
```bash
git diff HEAD~1 --name-only | grep -vE '\.md$'
```
Expected: empty output. If anything non-`.md` appears, the commit is wrong — investigate and split out before continuing.

- [ ] **Step 3: Post-commit verification**

Run:
```bash
git log -1 --pretty=format:'%h %s'
git status --short | wc -l
```
Expected: a `docs:` commit subject; status line count further decreased.

---

## Chunk 4: Commit 4 (headers, may skip), Commit 5 (test infra), Commit 6 (diagnostics), final gates

### Task 4.1: Commit 4 — module headers and docstrings (may be a no-op skip)

**Files:** verify-and-maybe-edit the 12-file allowlist.

- [ ] **Step 1: Read top-of-file header for each allowlisted file**

For each path below, read the first 30 lines (Read tool). Look for module/file header comments (`/** ... */`, `# ...`, `"""..."""`) and check whether they accurately describe the file's current purpose and named collaborators.

Allowlist (12 files):
- `web/static/netplay-lockstep.js`
- `web/static/kn-desync-detector.js`
- `web/static/kn-diagnostics.js`
- `web/static/kn-state.js`
- `web/static/kn-audio.js`
- `web/static/kn-vision-client.js`
- `web/static/play.js`
- `web/static/shared.js`
- `server/src/api/payloads.py`
- `server/src/api/signaling.py`
- `server/src/api/desync_prompts.py`
- `server/src/api/desync_vision.py`

For each file, decide: "no-op" (header is accurate), or "edit" (header makes a wrong claim about purpose, named symbols, or collaborators). **No new comments are added** for files that don't currently have a header; no stylistic improvements; no expansion of accurate-but-terse headers.

- [ ] **Step 2: Apply minimal Edit changes for any drift found**

Use Edit for each header that needs updating. Keep changes inside the existing comment block; do not move or restructure the file.

- [ ] **Step 3: Decide whether to create commit 4**

Run:
```bash
git diff --name-only | wc -l
```

If `0`: **skip commit 4 entirely** (no files were edited; the no-op case is acceptable and expected). Move directly to Task 4.2.

If `>0`: continue to Step 4.

- [ ] **Step 4: Stage only the allowlisted files**

Run:
```bash
git add web/static/netplay-lockstep.js \
        web/static/kn-desync-detector.js \
        web/static/kn-diagnostics.js \
        web/static/kn-state.js \
        web/static/kn-audio.js \
        web/static/kn-vision-client.js \
        web/static/play.js \
        web/static/shared.js \
        server/src/api/payloads.py \
        server/src/api/signaling.py \
        server/src/api/desync_prompts.py \
        server/src/api/desync_vision.py
```
(Files that weren't edited in Step 2 will be no-ops for `git add`.)

- [ ] **Step 5: Run the spec's commit-4 allowlist gate before committing**

Run:
```bash
git diff --cached --name-only | grep -vE '^(web/static/(netplay-lockstep|kn-desync-detector|kn-diagnostics|kn-state|kn-audio|kn-vision-client|play|shared)\.js|server/src/api/(payloads|signaling|desync_prompts|desync_vision)\.py)$'
```
Expected: empty output. If anything else is staged, unstage it.

- [ ] **Step 6: Eyeball pass — every diff line must be inside a comment**

Run:
```bash
git diff --cached
```
Expected: every `+`/`-` line is inside `//`, `/* */`, `#`, or `"""…"""`. If a `+`/`-` line touches code (a statement, expression, or import), unstage that file and split it out — the file does not belong in this commit.

- [ ] **Step 7: Commit 4**

Run:
```bash
git commit -m "$(cat <<'EOF'
docs(headers): refresh module headers and docstrings

Mechanical pass over the 12-file allowlist (commit 2 surface plus
vision-pipeline collaborators from prior commit 35e486b). Comment-only
edits where headers had drifted from the file's current purpose,
named symbols, or collaborators. No stylistic rewrites; no new comments
added to files that previously had none.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Post-commit verification**

Run:
```bash
git log -1 --pretty=format:'%h %s'
```
Expected: `docs(headers):` subject.

### Task 4.2: Commit 5 — test infrastructure

**Files:** create-track 5 entries; no edits.

- [ ] **Step 1: Verify each test-infra path exists in working tree**

Run:
```bash
for path in \
  tests/determinism-automation.mjs \
  tests/record-nav.mjs \
  tests/record-nav-auto.mjs \
  tests/fixtures/nav-recording.json \
  tests/package.json
do
  test -e "$path" && echo "exists: $path" || echo "MISSING: $path"
done
```
Expected: every line `exists:`. If any `MISSING:`, the working tree drifted — **stop and surface to user.**

- [ ] **Step 2: Stage**

Run:
```bash
git add tests/determinism-automation.mjs \
        tests/record-nav.mjs \
        tests/record-nav-auto.mjs \
        tests/fixtures/nav-recording.json \
        tests/package.json
```

- [ ] **Step 3: Verify staged set matches expectation**

Run:
```bash
git diff --cached --name-only | sort
```
Expected: exactly those 5 paths sorted.

- [ ] **Step 4: Commit 5**

Run:
```bash
git commit -m "$(cat <<'EOF'
test: determinism automation harness

Adds the determinism automation Playwright harness and nav-recording
fixture. Not run as part of this commit; harness is opt-in
infrastructure for future stress passes.

- tests/determinism-automation.mjs — main harness
- tests/record-nav{,-auto}.mjs — nav-step recorders
- tests/fixtures/nav-recording.json — captured nav script
- tests/package.json — Playwright dep pin

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Post-commit verification**

Run:
```bash
git log -1 --pretty=format:'%h %s'
```
Expected: `test:` subject.

### Task 4.3: Commit 6 — diagnostics

**Files:** create-track 12 entries (3 patches + 1 .mjs + 8 Python tools); no edits.

- [ ] **Step 1: Verify each diagnostic path exists**

Run:
```bash
for path in \
  build/patches/mupen64plus-defer-video.patch \
  build/patches/mupen64plus-interrupt-counters.patch \
  build/patches/rdram-det-watch.patch \
  build/patch-asyncify-counter.mjs \
  tools/composite_grid.py \
  tools/composite_screenshots.py \
  tools/diff_rand_calls.py \
  tools/diff_thread_samples.py \
  tools/pc_to_symbol.py \
  tools/rdram_diff.py \
  tools/trace_extract.py \
  tools/trace_generate.py
do
  test -e "$path" && echo "exists: $path" || echo "MISSING: $path"
done
```
Expected: every line `exists:`. If any `MISSING:`, the tree drifted — **stop and surface.**

- [ ] **Step 2: Stage**

Run:
```bash
git add build/patches/mupen64plus-defer-video.patch \
        build/patches/mupen64plus-interrupt-counters.patch \
        build/patches/rdram-det-watch.patch \
        build/patch-asyncify-counter.mjs \
        tools/composite_grid.py \
        tools/composite_screenshots.py \
        tools/diff_rand_calls.py \
        tools/diff_thread_samples.py \
        tools/pc_to_symbol.py \
        tools/rdram_diff.py \
        tools/trace_extract.py \
        tools/trace_generate.py
```

- [ ] **Step 3: Verify staged set**

Run:
```bash
git diff --cached --name-only | sort
```
Expected: exactly the 12 paths above, sorted.

- [ ] **Step 4: Commit 6**

Run:
```bash
git commit -m "$(cat <<'EOF'
chore(diagnostics): research patches + tools (not in prod build)

Tracks research/diagnostic artifacts that aren't part of the production
build but are worth keeping in tree for future investigations.

Diagnostic patches (NOT applied by build.sh):
- mupen64plus-defer-video.patch (Option Y — future use)
- mupen64plus-interrupt-counters.patch
- rdram-det-watch.patch

Diagnostic scripts:
- build/patch-asyncify-counter.mjs (Option Z asyncify counter probe)

Diagnostic tools (tools/):
- composite_grid.py, composite_screenshots.py — visual cross-peer diff
- diff_rand_calls.py, diff_thread_samples.py — RNG / thread divergence
- pc_to_symbol.py — PC→symbol resolver
- rdram_diff.py — RDRAM region comparison
- trace_extract.py, trace_generate.py — training-data tooling for the
  vision pipeline (research, not runtime)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Post-commit verification**

Run:
```bash
git log -1 --pretty=format:'%h %s'
```
Expected: `chore(diagnostics):` subject.

### Task 4.4: Final gates

- [ ] **Step 1: `git status --porcelain` returns empty**

Run:
```bash
git status --porcelain
```
Expected: zero lines of output. If any line appears, work is incomplete — investigate the path and either stage+amend the appropriate commit, or surface to user.

- [ ] **Step 2: Print the unpushed commit sequence for user review**

Run:
```bash
git log origin/main..HEAD --oneline
```
Expected: 5 or 6 commits in this exact order (commit 4 may be absent if no header drifted):
```
<sha> chore(diagnostics): research patches + tools (not in prod build)
<sha> test: determinism automation harness
<sha> docs(headers): refresh module headers and docstrings   (may be missing)
<sha> docs: refresh project documentation for prod cut
<sha> feat(rollback): add menu-start barrier and C-input pipeline
<sha> chore: gitignore local sandboxes & generated artifacts
```
plus any pre-existing unpushed `docs(spec):` commits.

- [ ] **Step 3: Hand off to user**

Stop here. Do **NOT** run `just deploy-dry` or `just deploy` — the user runs those themselves after a Playwright two-tab smoke (per `feedback_playwright_before_deploy`).

Print to user:
```
Pre-deploy hygiene complete. Working tree is clean.
Unpushed commits:
<paste git log output>

Next step: run `just deploy-dry` to preview the version bump,
then your Playwright two-tab smoke, then `just deploy`.
```

---

## Notes for the executor

- **Do NOT run `just deploy`, `just deploy-dry`, or any push command.** This plan ends at a clean local tree with unpushed commits.
- **Do NOT use `--amend` or `--no-verify`.** If a pre-commit hook fails, fix the underlying issue and create a new commit per project safety protocol.
- **Do NOT bulk-stage with `git add -A` or `git add .`.** Every commit in this plan stages explicit paths only.
- **If any verification command produces unexpected output, stop and surface to user** rather than proceeding with a partially-correct state. The verification gates are the safety net; bypassing them defeats the plan.
- **TDD does not apply** to this plan. Commit 2's runtime fix was already validated; commits 1, 3, 4, 5, 6 are hygiene/triage/doc work with no behavior change.
- **Skill referenced:** @superpowers:executing-plans for the execution loop, @superpowers:verification-before-completion for the per-step verification discipline.
