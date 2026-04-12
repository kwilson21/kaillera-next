# Rollback State Integrity Audit Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate silent rollback state corruption in `build/kn_rollback/kn_rollback.c` + `web/static/netplay-lockstep.js` so every rollback either produces bit-correct state or fails loudly enough that `tools/analyze_match.py` catches it. No mid-game auto-resync band-aids — dev builds throw, production logs and continues.

**Architecture:** Six codified invariants (R1-R6) enforced by seven commits in dependency order (RF3 safety net → RF2 safety net → RF1 root-cause fix → RF4 ring coverage → RF7 loud FAILED-ROLLBACK → RF5 post-replay verification → RF6 audio diagnostics). Each commit: failing test first, minimal implementation, passing test, verification via `tools/analyze_match.py` on a fresh two-tab session, commit. Test harness (V1 WASM integrity export + V2 Playwright scenarios) and docs ship last.

**Tech Stack:** C (kn_rollback engine, Emscripten-compiled), vanilla JavaScript (IIFE + window globals, no ES modules per `feedback_no_es_modules.md`), Playwright `.mjs` scripts against local HTTPS dev server (`https://localhost:27888`), `tools/analyze_match.py` (uv run) for session log analysis.

**Spec:** [docs/superpowers/specs/2026-04-11-rollback-state-integrity-audit.md](../specs/2026-04-11-rollback-state-integrity-audit.md)

**Constraints:**
- Modern ECMAScript (const/let, arrow functions, template literals, async/await, optional chaining) — `feedback_ecmascript_modern.md`
- IIFE + window globals required — `feedback_no_es_modules.md`
- Only fix root causes, don't mask symptoms — `feedback_no_js_cascade_fix.md`
- No mid-game auto-resync triggered from invariant violations — spec §Core principle
- Never deploy without explicit user approval — `feedback_no_deploy_without_testing.md`
- User manages the dev server — don't start/stop it — `feedback_no_server_management.md`
- Always test with Playwright two-tab before claiming anything works — `feedback_playwright_before_deploy.md`
- Always use `uv run <tool>` for Python — `feedback_uv_python_tooling.md`
- WASM core rebuild uses the docker command from `reference_build_wasm.md`
- Coordination with parallel deadlock-audit plan — spec §Coordination

**Dependencies on deadlock-audit plan (already landed as of 2026-04-11):**
- `docs/netplay-invariants.md` — **exists** with §I1, §I2, §MF6. This plan APPENDS §Rollback Integrity with R1-R6.
- `window.knDiag` — **exists** at [netplay-lockstep.js:551-572](web/static/netplay-lockstep.js#L551-L572) with `replaySelfTest`, `tainted`, `blockHashes`, `dumpBlock`. This plan ADDS `forceMisprediction` method.
- `CLAUDE.md` "Netplay invariants" subsection — **exists** at [CLAUDE.md:160-163](CLAUDE.md#L160-L163). This plan APPENDS rollback bullets.
- `tests/deadlock-harness.html` — **does NOT exist**. The deadlock plan did not create a standalone harness file; tests hit the real two-tab flow with debug hooks exposed in-page. This plan follows the same convention.

**Pre-execution updates (landed after this plan was written):**

The deadlock-audit plan shipped four additional commits after the plan
above was drafted. None of them conflict with RF1-RF7, but the plan
executor should be aware of their existence to avoid duplicated work
and to take advantage of new diagnostic infrastructure.

- **`04a3901` — MF6 cause inference improvements.** The `_emitTickStuckSnapshot`
  cause inference now reports `pacing-throttle`, `rollback-stall`, and
  `wasm-step-frozen` in addition to the original stall flags. A new
  module-scope `_wasmStepActive` boolean is toggled at entry/exit of
  `stepOneFrame` so the watchdog can distinguish a JS-level stall from
  a frozen WASM call. This flag is **complementary** to RF2's
  `REPLAY-NORUN` detection (RF2's `if (!_pendingRunner)` branch runs
  BEFORE `_wasmStepActive = true;` is reached, so RF2 fires without
  the flag being set). RF2 should not need to touch `_wasmStepActive`.
- **`9c3822d` — Version-mismatch force-reload guard.** Adds
  `/api/version` endpoint, `window.__KN_ASSET_VERSION` HTML injection,
  and `web/static/version-guard.js` (loaded first in `play.html` and
  `index.html`). If any of this plan's changes ship while a browser
  tab is still running pre-fix code, the guard force-reloads the tab
  on next focus. Also fixed `.gitignore` so new files under
  `web/static/` can be tracked. **Impact on this plan**: if you create
  new files under `web/static/` they'll be trackable normally — the
  previous "web/static ignored" warning is gone.
- **`dac9ac5` — Analyzer VERSION-MISMATCH detection.** Adds
  `VERSION-MISMATCH` to the deadlock-audit events section of
  `analyze_match.py`. Non-overlapping with RF5's `ROLLBACK-RESTORE-CORRUPTION`
  replacement.
- **`0df9c84` — Analyzer visual-only desync, TAB-FOCUS correlation,
  PACING-SAFETY-FREEZE.** Three diagnostic improvements in sections
  this plan's RF5 does NOT touch:
  - `query_desync_timeline` §4: visual-only desync callout with phase
    labeling (intro/character-select/mid-match/late-match) when SSIM
    drops while gameplay hashes agree. **Useful for RF5 verification**
    — after RF5's `RB-LIVE-MISMATCH` detection lands, we can
    cross-reference visual-only-desync vs. live-mismatch to confirm
    the fix converges the visual divergence too.
  - `query_pacing` §7: `PACING-SAFETY-FREEZE` count + per-slot first/
    last frame. Useful for correlating rollback-budget exhaustion
    (frame advantage > rbMax) with RF3/RF4 invariant violations.
  - `query_deadlock_audit_events` §8d: TAB-FOCUS correlation with
    `TICK-STUCK`. Irrelevant to this plan directly, but good to know
    the TICK-STUCK output format now includes more fields (`pacing=`,
    `rbStall=`, `wasmStep=`, `stallStart=`).

**Fresh reference session for RF5 verification:** match
`07716199-9813-4953-a12d-f4c01ef5f7df` (room `3FK0747R`) from
2026-04-12 reproduces the B190OHFY `ROLLBACK-RESTORE-CORRUPTION`
pattern with a **`replay_gp=0x0`** smoking gun event at slot 0 f=625.
See the spec's §Corroborating evidence section for the full signature.
This is a second reference session alongside B190OHFY for any RF that
needs a pre-fix baseline. Run `uv run python tools/analyze_match.py 07716199`
to see the pattern.

**WASM rebuild required for:** RF1, RF4, RF5, RF6 Part B, RF7, V1 harness. RF3/RF2/V2 analyzer/docs are JS/Python-only.

---

## File Structure

Files this plan creates or modifies:

| File | Role | Change |
|------|------|--------|
| `build/kn_rollback/kn_rollback.c` | C rollback engine | Add `kn_rollback_did_restore`, `kn_get_fatal_stale`, `kn_live_gameplay_hash`, `kn_get_live_mismatch`, `kn_rollback_integrity_test` exports; R3 ring coverage check; live-state hash verification; strengthened audio reset call |
| `build/kn_rollback/kn_rollback.h` | C rollback API | Declare new exports |
| `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c` | Mirror copy that gets compiled | Same edits as above (the build uses this path) |
| `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h` | Mirror header | Same edits |
| `web/static/netplay-lockstep.js` | Netplay engine | RF3 pre_tick assertion, RF2 stepOneFrame assertion, RF1 runner re-capture poll, RF5/RF7 mismatch/stale poll, strengthened `audio-empty` log fields |
| `docs/netplay-invariants.md` | Invariants reference doc | Add §Rollback Integrity section (R1-R6) |
| `CLAUDE.md` | Project context | Add rollback invariant bullets to Netplay Invariants subsection |
| `tools/analyze_match.py` | Match diagnostic tool | Add detection for `REPLAY-NORUN`, `RB-INVARIANT-VIOLATION`, `FATAL-RING-STALE`, `RB-LIVE-MISMATCH`; enrich `AUDIO-DEATH` with rollback-correlation; replace `ROLLBACK-RESTORE-CORRUPTION` comparison logic |
| `tests/rollback/rf1-runner-recapture.spec.mjs` | Playwright RF1 regression test | New |
| `tests/rollback/rf2-steponeframe-invariant.spec.mjs` | Playwright RF2 regression test | New |
| `tests/rollback/rf3-pretick-invariant.spec.mjs` | Playwright RF3 regression test | New |
| `tests/rollback/rf4-ring-coverage.spec.mjs` | Playwright RF4 regression test | New |
| `tests/rollback/rf5-live-mismatch.spec.mjs` | Playwright RF5 regression test | New |
| `tests/rollback/rf7-fatal-stale.spec.mjs` | Playwright RF7 regression test | New |
| `tests/rollback/rollback-integrity-wasm.spec.mjs` | V1 WASM integrity test driver | New |
| `CHANGELOG.md` | Version history | Entries for RF1-RF7 + harness + docs |

**Test strategy (per `feedback_minimal_tests.md`):** One Playwright two-tab scenario per RF verifying the specific invariant fires (or doesn't fire post-fix). Plus one V1 WASM integrity test that exercises the full rollback path without a peer — this is the determinism check that would have caught RF1-class bugs on the first run. No exhaustive unit-test buildout.

---

## Chunk 1: RF3 — `kn_pre_tick` return-value invariant (safety net, ships first)

**Why first:** Smallest possible change (pure JS, no WASM rebuild). Highest safety net — it would have caught the B190OHFY bug on the first run regardless of root cause. Ships before RF1/RF2 so the insurance policy is in place before any of the structural fixes land.

### Task 1.1: Confirm the current `kn_pre_tick` call site

**Files:**
- Read: [web/static/netplay-lockstep.js](web/static/netplay-lockstep.js)

- [ ] **Step 1: Grep the pre_tick invocation**

Run:
```bash
grep -nB1 -A10 'const catchingUp = tickMod\._kn_pre_tick' web/static/netplay-lockstep.js
```

Expected: one hit at **line 6361** (verified 2026-04-11 post-deadlock-audit merge), showing the pre_tick call followed by `const _tPreTick = performance.now();` and `_frameNum = tickMod._kn_get_frame();`. If the grep reports a different line, record the actual number and use it in subsequent steps — the deadlock-audit plan's commits may still be shifting things.

- [ ] **Step 2: Verify the replayDepth read is nearby**

Run:
```bash
grep -nA3 'const replayDepth = tickMod\._kn_get_replay_depth' web/static/netplay-lockstep.js
```

Expected: one hit at **line 6375** (verified 2026-04-11), showing `_syncLog('C-REPLAY start: ...')` firing conditionally on `replayDepth > 0 && !_rbReplayLogged`.

**Line-number drift note:** If any grep in this plan reports a line that's off by more than 5 from the "verified" anchor, STOP and re-grep every subsequent `sed`/line reference before continuing — the file has shifted and every later step needs updating.

### Task 1.2: Write the failing unit test for RF3

**Files:**
- Create: `tests/rollback/rf3-pretick-invariant.spec.mjs`

- [ ] **Step 1: Create the test directory**

Run:
```bash
mkdir -p tests/rollback
```

- [ ] **Step 2: Write the Playwright-driven test**

Create `tests/rollback/rf3-pretick-invariant.spec.mjs`:

```javascript
#!/usr/bin/env node
/**
 * RF3 regression test: when kn_pre_tick sets replay_depth > 0 but
 * returns a value other than 2, JS must log RB-INVARIANT-VIOLATION
 * with full diagnostic fields. Dev builds throw.
 *
 * This test doesn't require a real rollback — it monkey-patches
 * _kn_pre_tick to return 0 while setting replay_depth=9 via the
 * normal feed-input path, so the JS assertion path is exercised
 * without needing to actually corrupt rollback state.
 *
 * Usage: node tests/rollback/rf3-pretick-invariant.spec.mjs
 */
import { chromium } from 'playwright';

const ROM_PATH = '/Users/kazon/Downloads/Smash Remix 2.0.1.z64';
const BASE_URL = 'https://localhost:27888';

async function run() {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const violations = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('RB-INVARIANT-VIOLATION')) {
      violations.push(text);
    }
  });

  await page.goto(`${BASE_URL}/?debug=1`);
  await page.waitForFunction(() => window.KNState?.frameNum >= 200, { timeout: 30000 });

  // Monkey-patch: make kn_pre_tick return 0 while the JS side still sees
  // replay_depth=9 via kn_get_replay_depth. This simulates the invariant
  // violation where C sets up a rollback but returns the wrong value.
  await page.evaluate(() => {
    const mod = window.EJS_emulator.gameManager.Module;
    const origPreTick = mod._kn_pre_tick;
    const origGetReplayDepth = mod._kn_get_replay_depth;
    let injectOnce = false;
    mod._kn_pre_tick = (...args) => {
      if (!injectOnce) {
        injectOnce = true;
        window._rf3InjectReplayDepth = 9;
        return 0; // should have been 2
      }
      return origPreTick.apply(mod, args);
    };
    mod._kn_get_replay_depth = (...args) => {
      if (window._rf3InjectReplayDepth) {
        const d = window._rf3InjectReplayDepth;
        window._rf3InjectReplayDepth = 0;
        return d;
      }
      return origGetReplayDepth.apply(mod, args);
    };
  });

  // Let the next tick fire the injected pre_tick
  await page.waitForTimeout(500);

  if (violations.length === 0) {
    console.error('FAIL: no RB-INVARIANT-VIOLATION logged');
    process.exit(1);
  }

  const v = violations[0];
  if (!v.includes('replayDepth=9') || !v.includes('catchingUp=0')) {
    console.error(`FAIL: violation missing expected fields: ${v}`);
    process.exit(1);
  }

  console.log(`PASS: ${violations.length} violation(s) logged with full fields`);
  await browser.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 3: Run the test — must FAIL**

Run:
```bash
node tests/rollback/rf3-pretick-invariant.spec.mjs
```

Expected: `FAIL: no RB-INVARIANT-VIOLATION logged` (because the invariant check doesn't exist yet).

### Task 1.3: Implement the RF3 assertion in JS

**Files:**
- Modify: `web/static/netplay-lockstep.js` around line 6355 (the `replayDepth > 0` check)

- [ ] **Step 1: Read the current assertion region**

Run:
```bash
sed -n '6360,6400p' web/static/netplay-lockstep.js
```

Verify you see the `const catchingUp = tickMod._kn_pre_tick(...)` line followed by `_frameNum = tickMod._kn_get_frame();` and `const replayDepth = tickMod._kn_get_replay_depth?.() ?? 0;`.

- [ ] **Step 2: Insert the invariant check immediately after the replayDepth read**

Find the line `const replayDepth = tickMod._kn_get_replay_depth?.() ?? 0;` and insert the following block directly after it, before the existing `if (replayDepth > 0 && !_rbReplayLogged) { ... }` block:

```javascript
      // ── R5: pre-tick return-value invariant ─────────────────────────────
      // If C just set replay_depth > 0, kn_pre_tick MUST return 2 (replay
      // frame). Any other return value means the rollback branch ran but
      // the replay branch didn't — the emulator state is about to freeze
      // at the rollback target while the frame counter keeps advancing.
      // Per §Core principle: log-loud-and-continue. No resync recovery.
      // See docs/netplay-invariants.md §R5.
      if (replayDepth > 0 && catchingUp !== 2) {
        const rbFrame = tickMod._kn_get_frame?.() ?? -1;
        _syncLog(
          `RB-INVARIANT-VIOLATION f=${_frameNum} replayDepth=${replayDepth} ` +
            `catchingUp=${catchingUp} rbFrame=${rbFrame} tick=${performance.now().toFixed(1)}`,
        );
        if (window.KN_DEV_BUILD) {
          throw new Error(
            `RB-INVARIANT-VIOLATION: replayDepth=${replayDepth} catchingUp=${catchingUp}`,
          );
        }
      }
```

- [ ] **Step 3: Add `KN_DEV_BUILD` global**

Run:
```bash
grep -n 'KN_DEV_BUILD\|const _knDiagEnabled' web/static/netplay-lockstep.js | head -5
```

`KN_DEV_BUILD` does not exist as of 2026-04-11. Add it immediately before the existing `const _knDiagEnabled` block (currently around [line 564](web/static/netplay-lockstep.js#L564)) so it co-locates with the same style of dev-gating:

```javascript
  // Dev-build flag: set via ?debug=1 URL param or KN_DEV_BUILD=1 in
  // localStorage. Dev builds throw on invariant violations so the test
  // suite catches regressions. Production builds log and continue.
  // (Rollback integrity spec §Core principle.)
  const KN_DEV_BUILD = (() => {
    try {
      if (new URLSearchParams(window.location.search).get('debug') === '1') return true;
      if (window.localStorage?.getItem('KN_DEV_BUILD') === '1') return true;
    } catch (_) {}
    return false;
  })();
  window.KN_DEV_BUILD = KN_DEV_BUILD;
```

Verify the constant is referenced by subsequent tasks by grepping after insertion:

```bash
grep -c 'KN_DEV_BUILD' web/static/netplay-lockstep.js
```

Expected: `2` (declaration + window export). Subsequent tasks (2.3, 3.5, later chunks) will bump this count.

- [ ] **Step 4: Run the test — must PASS**

Run:
```bash
node tests/rollback/rf3-pretick-invariant.spec.mjs
```

Expected: `PASS: 1 violation(s) logged with full fields`.

- [ ] **Step 5: Run Prettier on modified JS**

Run:
```bash
just fmt-js
```

Expected: clean exit, file rewritten in place with consistent style.

### Task 1.4: Commit RF3

**Files:**
- Commit: `web/static/netplay-lockstep.js`, `tests/rollback/rf3-pretick-invariant.spec.mjs`

- [ ] **Step 1: Stage + commit**

Run:
```bash
git add web/static/netplay-lockstep.js tests/rollback/rf3-pretick-invariant.spec.mjs
git commit -m "$(cat <<'EOF'
feat(rollback): R5 pre_tick return-value invariant assertion (RF3)

If kn_pre_tick sets replay_depth > 0 but returns a value other than
2, the rollback branch ran but replay didn't — the emulator freezes
at the target while rb.frame advances. Log RB-INVARIANT-VIOLATION
with full diagnostic fields; dev builds throw. Per spec §Core
principle: no resync recovery, log-loud-and-continue.

Ships first as the highest safety net — would have caught the
B190OHFY silent corruption on the first run regardless of the
eventual root cause.

Spec: docs/superpowers/specs/2026-04-11-rollback-state-integrity-audit.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Verify commit landed cleanly**

Run:
```bash
git log -1 --stat
```

Expected: one commit, two files touched.

---

## Chunk 2: RF2 — `stepOneFrame` invariant assertion (second safety net)

**Why second:** Pure JS, no WASM rebuild. Defense-in-depth: even if RF3 is somehow bypassed, this catches any replay tick that gets far enough to call `stepOneFrame` with a null runner.

### Task 2.1: Write the failing test for RF2

**Files:**
- Create: `tests/rollback/rf2-steponeframe-invariant.spec.mjs`

- [ ] **Step 1: Write the Playwright test**

Create `tests/rollback/rf2-steponeframe-invariant.spec.mjs`:

```javascript
#!/usr/bin/env node
/**
 * RF2 regression test: when stepOneFrame is called with a null
 * _pendingRunner during a rollback replay (catchingUp==2 path),
 * JS must log REPLAY-NORUN with full diagnostic fields. Dev
 * builds throw.
 *
 * This test injects a rollback-like state via a debug hook that
 * nulls _pendingRunner mid-replay.
 *
 * Usage: node tests/rollback/rf2-steponeframe-invariant.spec.mjs
 */
import { chromium } from 'playwright';

const BASE_URL = 'https://localhost:27888';

async function run() {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const violations = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('REPLAY-NORUN')) {
      violations.push(text);
    }
  });

  await page.goto(`${BASE_URL}/?debug=1`);
  await page.waitForFunction(() => window.KNState?.frameNum >= 200, { timeout: 30000 });

  // Force the rollback-in-progress flag and null out _pendingRunner,
  // then call stepOneFrame directly. In the fixed version, this
  // triggers REPLAY-NORUN.
  const result = await page.evaluate(() => {
    try {
      // Access internal via test hook exposed under window.__rbTest
      if (!window.__rbTest) return { err: 'no __rbTest hook' };
      window.__rbTest.setReplayLogged(true);
      window.__rbTest.nullifyRunner();
      const stepped = window.__rbTest.stepOneFrame();
      return { stepped };
    } catch (e) {
      return { threw: e.message };
    }
  });

  if (violations.length === 0 && !result.threw) {
    console.error('FAIL: no REPLAY-NORUN logged and no throw');
    console.error('result:', result);
    process.exit(1);
  }

  if (violations.length > 0) {
    const v = violations[0];
    if (!v.includes('replayRemaining=') || !v.includes('rbFrame=')) {
      console.error(`FAIL: REPLAY-NORUN missing expected fields: ${v}`);
      process.exit(1);
    }
  }

  console.log(`PASS: ${violations.length} violation(s); dev throw=${!!result.threw}`);
  await browser.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run the test — must FAIL**

Run:
```bash
node tests/rollback/rf2-steponeframe-invariant.spec.mjs
```

Expected: `FAIL: no __rbTest hook` (we haven't added the test hook yet).

### Task 2.2: Add the `__rbTest` debug hook

**Files:**
- Modify: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Find a clean hook location**

The hook must be installed after `stepOneFrame` is defined (**line 4989** as of 2026-04-11) but before the tick loop starts. Install it just before the `_tickInterval = setInterval(tick, 16);` line (**line 5673**).

Run:
```bash
grep -n '_tickInterval = setInterval\|const stepOneFrame = () =>' web/static/netplay-lockstep.js
```

Record the two actual line numbers. If they drift, use the greped values instead.

- [ ] **Step 2: Insert the hook**

Immediately before the `_tickInterval = setInterval(tick, 16);` line (from Step 1's grep), add:

```javascript
    // ── Test-only debug hooks (gated on KN_DEV_BUILD) ──────────────
    // Exposed under window.__rbTest for Playwright regression tests to
    // exercise invariant handlers without needing a real rollback.
    // Only installed in dev builds; production has no __rbTest surface.
    if (window.KN_DEV_BUILD) {
      window.__rbTest = {
        setReplayLogged: (v) => {
          _rbReplayLogged = !!v;
        },
        nullifyRunner: () => {
          _pendingRunner = null;
        },
        stepOneFrame: () => stepOneFrame(),
      };
    }
```

- [ ] **Step 3: Run the test — must still FAIL**

Run:
```bash
node tests/rollback/rf2-steponeframe-invariant.spec.mjs
```

Expected: `FAIL: no REPLAY-NORUN logged and no throw` (hook installed but the invariant check itself isn't there yet).

### Task 2.3: Implement the RF2 assertion

**Files:**
- Modify: `web/static/netplay-lockstep.js` around [line 4977](web/static/netplay-lockstep.js#L4977)

- [ ] **Step 1: Read the current stepOneFrame**

Run:
```bash
sed -n '4989,5010p' web/static/netplay-lockstep.js
```

Verify the first two lines are:
```javascript
  const stepOneFrame = () => {
    if (!_pendingRunner) return false;
```

If the line number drifted, use the actual location from Task 2.3 Step 1's grep.

- [ ] **Step 2: Replace the null-runner check**

Change the `if (!_pendingRunner) return false;` line to:

```javascript
  const stepOneFrame = () => {
    if (!_pendingRunner) {
      // ── R2: no silent no-ops during rollback replay ──────────────
      // If a replay tick lands here with a null runner, retro_unserialize
      // (or another path) invalidated it and we have no way to actually
      // step the emulator. kn_post_tick would still advance rb.frame,
      // producing a Frankenstein state with frozen emulation. Per §Core
      // principle: log-loud-and-continue. No resync recovery.
      // See docs/netplay-invariants.md §R2.
      if (_useCRollback && _rbReplayLogged) {
        const mod = window.EJS_emulator?.gameManager?.Module;
        const rbFrame = mod?._kn_get_frame?.() ?? -1;
        const replayRemaining = mod?._kn_get_replay_depth?.() ?? -1;
        _syncLog(
          `REPLAY-NORUN f=${_frameNum} rbFrame=${rbFrame} ` +
            `replayRemaining=${replayRemaining} tick=${performance.now().toFixed(1)}`,
        );
        if (window.KN_DEV_BUILD) {
          throw new Error('REPLAY-NORUN: stepOneFrame called with null runner during replay');
        }
      }
      return false;
    }
```

- [ ] **Step 3: Run the test — must PASS**

Run:
```bash
node tests/rollback/rf2-steponeframe-invariant.spec.mjs
```

Expected: `PASS: 1 violation(s); dev throw=true` (the test runs with `?debug=1` so KN_DEV_BUILD is true and the throw fires — the test catches it and confirms at least one path triggered).

- [ ] **Step 4: Run Prettier**

Run:
```bash
just fmt-js
```

### Task 2.4: Commit RF2

- [ ] **Step 1: Stage + commit**

Run:
```bash
git add web/static/netplay-lockstep.js tests/rollback/rf2-steponeframe-invariant.spec.mjs
git commit -m "$(cat <<'EOF'
feat(rollback): R2 stepOneFrame invariant assertion (RF2)

When stepOneFrame is called with a null _pendingRunner during a
rollback replay (catchingUp==2), retro_unserialize has invalidated
the runner and the replay cannot actually step the emulator. Log
REPLAY-NORUN with full diagnostic fields; dev builds throw. Per
spec §Core principle: no resync recovery.

Also adds window.__rbTest debug hook (dev builds only) so Playwright
regression tests can exercise invariant handlers without needing a
real rollback.

Spec: docs/superpowers/specs/2026-04-11-rollback-state-integrity-audit.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 3: RF1 — Re-capture `_pendingRunner` after rollback restore (root-cause fix)

**Why third:** This is the root-cause fix for the observed B190OHFY bug. Ships after the two safety nets so if the hypothesis is wrong, RF2/RF3 are already catching the class of violations while we investigate further.

**Prerequisite (Phase 2 investigation before writing the fix):** confirm the runner-invalidation hypothesis with a targeted log, so we know for sure the fix addresses the real cause. If the hypothesis is wrong, the fix changes but the Chunk 1/2 safety nets still protect.

### Task 3.1: Confirm the hypothesis with instrumentation

**Files:**
- Modify temporarily: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Add a diagnostic log around the rollback restore**

Insert, immediately after the `const catchingUp = tickMod._kn_pre_tick(...)` block, a one-shot diagnostic that captures runner identity before and after a rollback:

```javascript
      // DIAGNOSTIC (temporary — remove before shipping RF1 fix):
      // Verify the runner-invalidation hypothesis. Log runner identity
      // before and after pre_tick so we can see whether retro_unserialize
      // null'd it.
      if (_useCRollback && !window._rf1DiagFired && replayDepth > 0) {
        window._rf1DiagFired = true;
        _syncLog(
          `RF1-DIAG f=${_frameNum} runnerBefore=${window._rf1RunnerBeforeId ?? 'unknown'} ` +
            `runnerAfter=${_pendingRunner ? 'present' : 'NULL'} ` +
            `catchingUp=${catchingUp} replayDepth=${replayDepth}`,
        );
      }
```

And at the very top of the tick function, before pre_tick:

```javascript
      if (_useCRollback && _pendingRunner && !window._rf1RunnerBeforeId) {
        window._rf1RunnerBeforeId = 'captured';
      }
```

- [ ] **Step 2: Run a two-tab Playwright session that triggers a rollback**

Use the existing `tests/rollback-rng-test.mjs` or run two browser tabs manually. The goal is to see `RF1-DIAG` in the logs with `runnerAfter=NULL` — confirming the hypothesis.

Run:
```bash
node tests/rollback-rng-test.mjs 2>&1 | grep -E 'RF1-DIAG|REPLAY-NORUN|RB-INVARIANT-VIOLATION'
```

- [ ] **Step 3: Analyze result**

- **If `RF1-DIAG` shows `runnerAfter=NULL` and/or `REPLAY-NORUN` / `RB-INVARIANT-VIOLATION` fires**: hypothesis confirmed. Proceed to Task 3.2.
- **If `RF1-DIAG` shows `runnerAfter=present` and no violations fire**: hypothesis wrong. STOP. Report findings to user and pivot. The Chunk 1/2 safety nets are still valuable; the real root cause needs further investigation before the remaining RFs can be designed correctly.

- [ ] **Step 4: Remove the diagnostic logs**

Revert the two inserts from Step 1. They are diagnostic-only and do not ship.

Run:
```bash
git diff web/static/netplay-lockstep.js | grep -E '^\+.*RF1-DIAG|_rf1'
```

Should show zero lines. If anything remains, clean it up before proceeding.

### Task 3.2: Add the `kn_rollback_did_restore` C export

**Files:**
- Modify: `build/kn_rollback/kn_rollback.c`
- Modify: `build/kn_rollback/kn_rollback.h`
- Modify: `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c` (mirror)
- Modify: `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h` (mirror)

- [ ] **Step 1: Add the field to the rb struct**

In `build/kn_rollback/kn_rollback.c`, find the `rb` struct definition (starts around line 157 with `static struct {`). Near the end of the struct (just before the closing `} rb;` around line 243), add:

```c
    /* RF1: did_restore flag — set by rollback branch immediately after
     * retro_unserialize. JS polls via kn_rollback_did_restore() and
     * re-captures the Emscripten rAF runner via pauseMainLoop/resumeMainLoop.
     * Flag is read-and-clear, same pattern as replay_depth.
     * See docs/netplay-invariants.md §R1. */
    int did_restore;
```

- [ ] **Step 2: Set the flag in the rollback branch**

Find [kn_rollback.c:754](build/kn_rollback/kn_rollback.c#L754) — the `retro_unserialize` call inside the success branch. Immediately AFTER the `sf_restore(rb.ring_sf_state[ring_idx]);` line (around line 755), add:

```c
            /* R1: retro_unserialize invalidates the Emscripten rAF runner
             * captured by JS's overrideRAF interceptor. JS must re-capture
             * it via pauseMainLoop/resumeMainLoop before the next
             * stepOneFrame call, or the replay runs as silent no-ops.
             * See docs/netplay-invariants.md §R1. */
            rb.did_restore = 1;
```

- [ ] **Step 3: Add the export function**

Find a natural location (e.g., just below `kn_get_replay_depth` around [line 1021](build/kn_rollback/kn_rollback.c#L1021)) and add:

```c
/* ── Query: did the rollback branch just restore state? ───────────────
 * Returns 1 and clears the flag if a rollback restore happened since
 * the last call. JS uses this to trigger pauseMainLoop/resumeMainLoop
 * so the rAF runner is re-captured before the next stepOneFrame.
 * Per R1: retro_unserialize invalidates _pendingRunner in JS. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_rollback_did_restore(void) {
    int v = rb.did_restore;
    rb.did_restore = 0;
    return v;
}
```

- [ ] **Step 4: Declare the export in the header**

In `build/kn_rollback/kn_rollback.h`, near `kn_get_replay_depth` (around line 47), add:

```c
/* R1: Returns 1 (and clears flag) if the rollback branch just called
 * retro_unserialize. JS re-captures the rAF runner on hit. */
int kn_rollback_did_restore(void);
```

- [ ] **Step 5: Mirror the changes to the build-source copies**

Run:
```bash
cp build/kn_rollback/kn_rollback.c build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c
cp build/kn_rollback/kn_rollback.h build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h
```

Verify the copy succeeded:
```bash
diff build/kn_rollback/kn_rollback.c build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c && echo "IDENTICAL"
```

Expected: `IDENTICAL`.

### Task 3.3: Rebuild the WASM core

**Files:**
- Input: `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c`
- Output: `build/output/mupen64plus_next_libretro.wasm`, `build/output/mupen64plus_next-wasm.data`

- [ ] **Step 1: Confirm Docker is available**

Run:
```bash
docker images emulatorjs-builder:latest --format '{{.Repository}}:{{.Tag}}'
```

Expected: `emulatorjs-builder:latest`. If missing, the user must run the image build from `reference_build_wasm.md` first (out of scope for this plan).

- [ ] **Step 2: Run the build**

From the repo root:
```bash
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash -c "cd /build/src/RetroArch && emmake make -f Makefile.emulatorjs clean; bash /build/build.sh"
```

Expected: build completes in 3-8 minutes, final lines include `BUILD COMPLETE` and the `.wasm` / `.data` outputs are regenerated.

- [ ] **Step 3: Verify the new symbol is in the WASM**

Run:
```bash
grep -ao 'kn_rollback_did_restore' build/output/mupen64plus_next_libretro.wasm | head -1
```

Expected: at least one match. If none, the build didn't pick up the source change — re-verify Step 5 of Task 3.2 and rebuild.

- [ ] **Step 4: Deploy the built WASM to the web static directory**

Run:
```bash
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
```

### Task 3.4: Wire the JS-side runner re-capture

**Files:**
- Modify: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Insert the re-capture poll**

Immediately after the `const catchingUp = tickMod._kn_pre_tick(...)` call (around [line 6361](web/static/netplay-lockstep.js#L6361)) and BEFORE the `_frameNum = tickMod._kn_get_frame();` line, add:

```javascript
      // ── R1: runner continuity across rollback restore ─────────────────
      // kn_pre_tick's rollback branch calls retro_unserialize directly,
      // which invalidates the Emscripten rAF runner captured by JS's
      // overrideRAF interceptor. Without re-capture, stepOneFrame in the
      // catchingUp==2 branch is a silent no-op and the replay never runs.
      // The loadState path at line ~8221 already does this; we mirror it
      // here for the C-level rollback path.
      // See docs/netplay-invariants.md §R1.
      if (tickMod._kn_rollback_did_restore?.()) {
        const gm = window.EJS_emulator?.gameManager;
        if (gm?.Module) {
          gm.Module.pauseMainLoop();
          gm.Module.resumeMainLoop();
          // WASM memory may have grown during retro_unserialize; re-bind
          // the HEAPU8 view if the runtime supports it.
          if (gm.Module.updateMemoryViews) {
            gm.Module.updateMemoryViews();
          } else if (gm.Module._emscripten_notify_memory_growth) {
            gm.Module._emscripten_notify_memory_growth(0);
          }
        }
      }
```

- [ ] **Step 2: Write the RF1 regression test**

Create `tests/rollback/rf1-runner-recapture.spec.mjs`:

```javascript
#!/usr/bin/env node
/**
 * RF1 regression test: after a C-level rollback restore, the
 * Emscripten rAF runner must be re-captured so subsequent
 * stepOneFrame calls actually step the emulator. Asserts that
 * replay frames produce advancing gameplay hashes (i.e., the
 * emulator is genuinely stepping, not frozen).
 *
 * Usage: node tests/rollback/rf1-runner-recapture.spec.mjs
 */
import { chromium } from 'playwright';

const BASE_URL = 'https://localhost:27888';

async function run() {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const events = { replayNorun: 0, invariant: 0, replayStart: 0, replayDone: 0 };
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('REPLAY-NORUN')) events.replayNorun++;
    if (t.includes('RB-INVARIANT-VIOLATION')) events.invariant++;
    if (t.includes('C-REPLAY start')) events.replayStart++;
    if (t.includes('C-REPLAY done')) events.replayDone++;
  });

  await page.goto(`${BASE_URL}/?debug=1`);
  await page.waitForFunction(() => window.KNState?.frameNum >= 200, { timeout: 30000 });

  // Force a single misprediction via knDiag hook (added in Task 3.5 below;
  // falls back to the pre-existing rollback-rng-test path if absent).
  const forced = await page.evaluate(() => {
    if (window.knDiag?.forceMisprediction) {
      window.knDiag.forceMisprediction({ slotDelta: 40, frame: null });
      return true;
    }
    return false;
  });

  if (!forced) {
    console.error('FAIL: knDiag.forceMisprediction not installed (expected post-Task 3.5)');
    process.exit(1);
  }

  // Let the rollback fire and the replay catch up. Monitor the gameplay
  // hash — it must change across frames (genuinely stepping) rather than
  // stay frozen.
  const f0 = await page.evaluate(() => window.KNState.frameNum);
  const h0 = await page.evaluate(() =>
    window.EJS_emulator.gameManager.Module._kn_gameplay_hash?.(-1),
  );
  await page.waitForTimeout(1500);
  const f1 = await page.evaluate(() => window.KNState.frameNum);
  const h1 = await page.evaluate(() =>
    window.EJS_emulator.gameManager.Module._kn_gameplay_hash?.(-1),
  );

  const frameDelta = f1 - f0;
  if (frameDelta < 30) {
    console.error(`FAIL: frame counter advanced only ${frameDelta}f in 1500ms`);
    process.exit(1);
  }
  if (h0 === h1) {
    console.error(`FAIL: gameplay hash frozen at 0x${h0?.toString(16)} (emulator not stepping)`);
    process.exit(1);
  }
  if (events.replayNorun > 0 || events.invariant > 0) {
    console.error(`FAIL: ${events.replayNorun} REPLAY-NORUN, ${events.invariant} RB-INVARIANT-VIOLATION`);
    process.exit(1);
  }
  if (events.replayStart === 0 || events.replayDone === 0) {
    console.error(`FAIL: no replay fired (start=${events.replayStart}, done=${events.replayDone})`);
    process.exit(1);
  }

  console.log(
    `PASS: frameDelta=${frameDelta}f, hashChanged=${h0 !== h1}, replays=${events.replayStart}, zero violations`,
  );
  await browser.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

This test depends on `knDiag.forceMisprediction` which is added in Task 3.5.

### Task 3.5: Add `knDiag.forceMisprediction` method

**Files:**
- Modify: `web/static/netplay-lockstep.js`

`knDiag` already exists as of the deadlock-audit merge ([line 572](web/static/netplay-lockstep.js#L572)) as a gated factory returning an `api` object. This task (a) adds `KN_DEV_BUILD` / `?debug=1` to the gate so Playwright tests automatically get `knDiag` without needing `?knDiag=1`, and (b) adds `forceMisprediction` as a new method inside the existing `api` object (around [line 1093](web/static/netplay-lockstep.js#L1093), just before the `ready()` method).

- [ ] **Step 1: Widen the `_knDiagEnabled` gate**

Run:
```bash
sed -n '564,571p' web/static/netplay-lockstep.js
```

Expected current content:
```javascript
  const _knDiagEnabled = (() => {
    try {
      if (new URLSearchParams(window.location.search).has('knDiag')) return true;
      if (localStorage.getItem('kn-debug') === '1') return true;
    } catch (_) {}
    return false;
  })();
```

Replace with (adding the `KN_DEV_BUILD` OR branch):

```javascript
  const _knDiagEnabled = (() => {
    try {
      if (window.KN_DEV_BUILD) return true;
      if (new URLSearchParams(window.location.search).has('knDiag')) return true;
      if (localStorage.getItem('kn-debug') === '1') return true;
    } catch (_) {}
    return false;
  })();
```

Since `KN_DEV_BUILD` was just declared in Task 1.3 Step 3 immediately before this block, it is in scope. Verify:

```bash
grep -n 'KN_DEV_BUILD\|_knDiagEnabled' web/static/netplay-lockstep.js | head -5
```

Expected: `KN_DEV_BUILD` declared first, then `_knDiagEnabled` second.

- [ ] **Step 2: Add `forceMisprediction` inside the existing `api` object**

Find the `ready()` method at approximately line 1093 (`grep -n "ready()" web/static/netplay-lockstep.js | head -5`) and insert `forceMisprediction` immediately BEFORE the `ready()` entry:

```javascript
          // Force a misprediction to exercise the rollback replay path
          // in regression tests. Feeds a fake "real" input for a past
          // frame that differs from what the predictor stored, triggering
          // kn_feed_input's misprediction detection.
          //
          // opts.slotDelta: stick axis delta from the predicted value.
          //   Must exceed KN_STICK_ZONE_SIZE (12) to escape the
          //   zone-tolerance window.
          // opts.frame: target frame. Defaults to the deepest frame
          //   still in the rollback window.
          // Returns true if the input was fed (no guarantee the
          //   rollback actually fires — depends on prediction state).
          forceMisprediction(opts = {}) {
            const slotDelta = opts.slotDelta ?? 60;
            const mod = getMod();
            if (!mod?._kn_feed_input || !mod?._kn_get_frame) return false;
            const curFrame = mod._kn_get_frame();
            const targetFrame = opts.frame ?? Math.max(0, curFrame - DELAY_FRAMES - 2);
            const targetSlot = _playerSlot === 0 ? 1 : 0;
            mod._kn_feed_input(targetSlot, targetFrame, 0, slotDelta, -slotDelta, 0, 0);
            if (typeof _syncLog === 'function') {
              _syncLog(
                `knDiag.forceMisprediction slot=${targetSlot} f=${targetFrame} delta=${slotDelta}`,
              );
            }
            return true;
          },
```

- [ ] **Step 3: Run Prettier**

Run:
```bash
just fmt-js
```

- [ ] **Step 4: Run the RF1 test**

Run:
```bash
node tests/rollback/rf1-runner-recapture.spec.mjs
```

Expected (post-fix): `PASS: frameDelta=~90f, hashChanged=true, replays=1, zero violations`.

If the test fails with "no replay fired", the injected input may have landed inside the dead-zone or already-real window. Diagnose:

```bash
cd server && uv run python ../tools/analyze_match.py --room <test-room> 2>&1 | grep -E 'MISPREDICTION|REPLAY'
```

If zero `MISPREDICTION` events appear, try calling `forceMisprediction({ slotDelta: 80, frame: null })` with a larger delta. If zero `REPLAY` events appear but mispredictions do, `depth > visible_rb_max` — reduce the `frame` offset so depth stays within `delay_frames + 4`.

### Task 3.6: Commit RF1

- [ ] **Step 1: Stage + commit**

Run:
```bash
git add build/kn_rollback/kn_rollback.c build/kn_rollback/kn_rollback.h \
  build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c \
  build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h \
  build/output/mupen64plus_next_libretro.wasm build/output/mupen64plus_next-wasm.data \
  web/static/ejs/cores/mupen64plus_next-wasm.data \
  web/static/netplay-lockstep.js \
  tests/rollback/rf1-runner-recapture.spec.mjs
git commit -m "$(cat <<'EOF'
fix(rollback): R1 re-capture rAF runner after retro_unserialize (RF1)

Root-cause fix for room B190OHFY silent state corruption. The C
rollback branch called retro_unserialize directly, which invalidates
the Emscripten rAF runner captured by JS's overrideRAF interceptor.
Subsequent stepOneFrame calls became silent no-ops, so the 9-frame
amortized replay never actually ran — the emulator froze at the
restore target while rb.frame kept advancing. Audio pipeline starved
for 300 frames, SSIM dropped 0.97 → 0.81.

Fix: add kn_rollback_did_restore() C export that returns 1 once
after a successful rollback. JS polls it immediately after kn_pre_tick
and runs pauseMainLoop/resumeMainLoop to re-capture the runner, the
same pattern already used by the loadState path.

Also adds knDiag.forceMisprediction harness hook for regression
testing (reused by subsequent RFs).

Spec: docs/superpowers/specs/2026-04-11-rollback-state-integrity-audit.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: Run all three regression tests to confirm no regressions**

Run:
```bash
for t in tests/rollback/rf{1,2,3}-*.spec.mjs; do
  echo "=== $t ==="
  node "$t" || { echo "FAIL"; exit 1; }
done
```

Expected: three PASS lines.

- [ ] **Step 3: Run `tools/analyze_match.py` on a real two-tab session**

User runs a Playwright two-tab rollback scenario. Then:

```bash
cd server && uv run python ../tools/analyze_match.py --room <latest-room> 2>&1 | grep -E 'REPLAY-NORUN|RB-INVARIANT-VIOLATION|ROLLBACK-RESTORE-CORRUPTION|AUDIO-DEATH'
```

Expected: zero `REPLAY-NORUN`, zero `RB-INVARIANT-VIOLATION`. `ROLLBACK-RESTORE-CORRUPTION` may still appear (its comparison logic is replaced in RF5, not RF1) but `AUDIO-DEATH` should be gone or drastically reduced if the audio death was a secondary effect of RF1.

Record any residual events for reference when RF4-RF7 land.

---

*Chunks 1-3 end here. Chunks 4-8 follow.*

---

## Chunk 4: RF4 — Dirty-input gate ring coverage (R3)

**Why now:** The B190OHFY `FAILED-ROLLBACK ring[6]=617` and `ring[7]=696` events prove the 89% serialize-skip rate leaves ring slots stale beyond the rollback window. RF4 must land before RF7 (Chunk 5) so RF7's loud FATAL-RING-STALE logging doesn't spam violations for legitimate pre-fix stale cases.

WASM core rebuild required.

### Task 4.1: RF4 — Ring coverage invariant check (C)

**Files:**
- Modify: `build/kn_rollback/kn_rollback.c`
- Modify: `build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c` (mirror)

- [ ] **Step 1: Read the current dirty-input gate**

Run:
```bash
sed -n '880,940p' build/kn_rollback/kn_rollback.c
```

Verify you see the `int need_save = rb.pending_rollback >= 0 ...` block at line 899.

- [ ] **Step 2: Add the R3 ring-coverage check to the gate**

In `build/kn_rollback/kn_rollback.c`, find the `need_save` block starting at line 899:

```c
            int need_save = rb.pending_rollback >= 0
                         || kn_rdram_offset_in_state == 0
                         || !rb.prev_applied_valid;
```

Replace with:

```c
            int need_save = rb.pending_rollback >= 0
                         || kn_rdram_offset_in_state == 0
                         || !rb.prev_applied_valid;

            /* R3: Ring coverage invariant. The dirty-input gate may only
             * skip a save if doing so cannot leave any frame inside the
             * rollback window [rb.frame - max_frames, rb.frame] without
             * a valid ring entry. If the oldest frame still in-window no
             * longer matches its ring slot, force a save to guarantee
             * coverage. Fixed ring_size-bounded: ring_size ≈ 13 in prod,
             * ~780 comparisons/sec — no measurable perf regression.
             * See docs/netplay-invariants.md §R3. */
            if (!need_save && rb.frame > rb.max_frames) {
                int oldest_window_frame = rb.frame - rb.max_frames;
                int oldest_idx = oldest_window_frame % rb.ring_size;
                if (rb.ring_frames[oldest_idx] != oldest_window_frame) {
                    need_save = 1;
                }
            }
```

- [ ] **Step 3: Mirror to the build-source copy**

Run:
```bash
cp build/kn_rollback/kn_rollback.c build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c
diff build/kn_rollback/kn_rollback.c build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c && echo "IDENTICAL"
```

Expected: `IDENTICAL`.

### Task 4.2: Write the RF4 regression test

**Files:**
- Create: `tests/rollback/rf4-ring-coverage.spec.mjs`

- [ ] **Step 1: Write the test**

Create `tests/rollback/rf4-ring-coverage.spec.mjs`:

```javascript
#!/usr/bin/env node
/**
 * RF4 regression test: sustained stable-input periods (where the
 * dirty gate would normally skip most frames) followed by a deep
 * rollback must NOT produce FATAL-RING-STALE events. The R3 ring
 * coverage check should force enough saves to cover the window.
 *
 * Usage: node tests/rollback/rf4-ring-coverage.spec.mjs
 */
import { chromium } from 'playwright';

const BASE_URL = 'https://localhost:27888';

async function run() {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const events = { fatalStale: 0, failedRb: 0 };
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('FATAL-RING-STALE')) events.fatalStale++;
    if (t.match(/FAILED-ROLLBACK.*\(stale\)/)) events.failedRb++;
  });

  await page.goto(`${BASE_URL}/?debug=1`);
  await page.waitForFunction(() => window.KNState?.frameNum >= 300, { timeout: 30000 });

  // Hold still for ~200 frames (stable input → dirty gate skips).
  // Then force a deep misprediction targeting a frame ~10 back.
  // Without RF4, the ring would have skipped 89% of those frames
  // and the target slot would be stale. With RF4, coverage is
  // guaranteed.
  await page.waitForTimeout(3500); // ~210 frames
  const forced = await page.evaluate(() => {
    if (!window.knDiag?.forceMisprediction) return false;
    // Force a misprediction at depth ~10
    const mod = window.EJS_emulator.gameManager.Module;
    const cur = mod._kn_get_frame();
    window.knDiag.forceMisprediction({ slotDelta: 60, frame: cur - 10 });
    return true;
  });
  if (!forced) {
    console.error('FAIL: knDiag.forceMisprediction not installed');
    process.exit(1);
  }
  await page.waitForTimeout(1500);

  if (events.fatalStale > 0 || events.failedRb > 0) {
    console.error(`FAIL: ${events.fatalStale} FATAL-RING-STALE, ${events.failedRb} legacy stale`);
    process.exit(1);
  }

  console.log(`PASS: zero stale events after stable-input + deep rollback`);
  await browser.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run the test — may FAIL pre-rebuild**

Run:
```bash
node tests/rollback/rf4-ring-coverage.spec.mjs
```

If the deployed WASM is from before RF4's C changes, this test may pass spuriously (because pre-RF4, the legacy `FAILED-ROLLBACK` was log-only and the event name differed). Proceed to Task 4.3 to rebuild.

### Task 4.3: Rebuild the WASM core and re-run RF4 test

- [ ] **Step 1: Rebuild**

Run:
```bash
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash -c "cd /build/src/RetroArch && emmake make -f Makefile.emulatorjs clean; bash /build/build.sh"
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
```

- [ ] **Step 2: Verify the new code is in the binary**

The R3 check is internal and does not add a new exported symbol, so the usual `grep -ao 'kn_new_export'` trick won't work. Use three layered checks:

```bash
# Check 1: source copy has the change
grep -c 'oldest_window_frame' build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c
```
Expected: `>= 1`.

```bash
# Check 2: the build product is newer than the source change
stat -f "%m %N" build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c build/output/mupen64plus_next_libretro.wasm
```
The `.wasm` mtime must be newer than the `.c` mtime.

```bash
# Check 3: Rerun the RF4 test with tracing — if ring coverage
# is now enforced, forcing a deep misprediction after a stable-input
# period must NOT produce any (stale) event in the log.
node tests/rollback/rf4-ring-coverage.spec.mjs
```

Binary-level confirmation comes from Check 3's PASS output. The regression test is the source of truth.

- [ ] **Step 3: Re-run RF4 test**

```bash
node tests/rollback/rf4-ring-coverage.spec.mjs
```

Expected: `PASS: zero stale events after stable-input + deep rollback`.

- [ ] **Step 4: Sanity-check perf on a clean two-tab session**

Run a normal rollback scenario and compare serialize_skip rate. Before RF4, `analyze_match.py` reported `slot=0: 805/900 frames skipped (89.4%)`. After RF4, expect ~80-85% on stable-input periods (drop of ~4-9 percentage points). If the skip rate drops dramatically (e.g., below 50%), the R3 check is firing every tick — investigate whether `rb.frame - rb.max_frames` is always stale (possible if ring wasn't initialized or `max_frames` value is wrong).

### Task 4.4: Commit RF4

- [ ] **Step 1: Stage + commit**

Run:
```bash
git add build/kn_rollback/kn_rollback.c \
  build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c \
  build/output/mupen64plus_next_libretro.wasm build/output/mupen64plus_next-wasm.data \
  web/static/ejs/cores/mupen64plus_next-wasm.data \
  tests/rollback/rf4-ring-coverage.spec.mjs
git commit -m "$(cat <<'EOF'
feat(rollback): R3 ring coverage invariant in dirty-input gate (RF4)

The dirty-input serialize gate skipped ~89% of per-frame serializes
on stable networks, letting ring slots drift 100+ frames stale.
B190OHFY's analyzer showed ring[6]=617 and ring[7]=696 when a
depth-9 rollback targeted frames 786 and 787 — the ring no longer
covered the rollback window.

Fix: before allowing a skip, verify the oldest in-window frame
(`rb.frame - max_frames`) still matches its ring slot. If not,
force a save. Fixed ring_size-bounded check — ring_size ≈ 13 in
production, ~780 comparisons/sec, no perf regression.

Ships before RF7 (loud FATAL-RING-STALE) so the changeover
doesn't spam violation logs for legitimate pre-fix stale cases.

Spec: docs/superpowers/specs/2026-04-11-rollback-state-integrity-audit.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 5: RF7 — Loud FATAL-RING-STALE (R3)

**Why now:** Ships after RF4 (Chunk 4). With ring coverage guaranteed, any subsequent `FATAL-RING-STALE` event is a genuinely new bug — not a legacy symptom. Both C-level flag-set and JS-side poll + the debug helper for the regression test are packaged in one commit to avoid mid-task WASM rebuilds.

WASM core rebuild required (once, at end of task 5.1).

### Task 5.1: RF7 — Loud FATAL-RING-STALE (C + JS)

**Files:**
- Modify: `build/kn_rollback/kn_rollback.c`
- Modify: `build/kn_rollback/kn_rollback.h`
- Modify: mirror copies
- Modify: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Add fatal-stale state fields to the rb struct**

In `build/kn_rollback/kn_rollback.c`, find the `rb` struct (around line 157) and add these fields near the stats section (around line 225):

```c
    /* RF7: Fatal stale-ring signal. Set by kn_feed_input when a
     * misprediction targets a ring slot that no longer holds the
     * expected frame (ring coverage R3 violation). JS polls via
     * kn_get_fatal_stale() and logs FATAL-RING-STALE loudly.
     * No resync recovery per §Core principle.
     * See docs/netplay-invariants.md §R3. */
    int fatal_stale_f;
    int fatal_stale_ring_idx;
    int fatal_stale_actual;
    int fatal_stale_pending;
```

- [ ] **Step 2: Set the fatal flag in the stale-ring branch**

Find [kn_rollback.c:689](build/kn_rollback/kn_rollback.c#L689) — the `rb_log("FAILED-ROLLBACK ... (stale) ...")` line. Locate the enclosing `else` block (around lines 686-691):

```c
                } else {
                    /* SILENT DESYNC: state for this frame was overwritten in the ring */
                    rb.failed_rollbacks++;
                    rb_log("FAILED-ROLLBACK slot=%d f=%d myF=%d depth=%d ring[%d]=%d (stale) btn_xor=0x%x lx_d=%d ly_d=%d cx_d=%d cy_d=%d",
                        slot, frame, rb.frame, depth, ring_idx, rb.ring_frames[ring_idx], btn_xor, lx_d, ly_d, cx_d, cy_d);
                }
```

Replace with:

```c
                } else {
                    /* R3 VIOLATION: state for this frame was overwritten in the ring.
                     * Set the fatal flag for JS to surface; no recovery action in C.
                     * Per §Core principle: log-loud-and-continue. */
                    rb.failed_rollbacks++;
                    rb.fatal_stale_f = frame;
                    rb.fatal_stale_ring_idx = ring_idx;
                    rb.fatal_stale_actual = rb.ring_frames[ring_idx];
                    rb.fatal_stale_pending = 1;
                    rb_log("FATAL-RING-STALE slot=%d f=%d myF=%d depth=%d ring[%d]=%d btn_xor=0x%x lx_d=%d ly_d=%d cx_d=%d cy_d=%d",
                        slot, frame, rb.frame, depth, ring_idx, rb.ring_frames[ring_idx], btn_xor, lx_d, ly_d, cx_d, cy_d);
                }
```

Note: the log event name changes from `FAILED-ROLLBACK ... (stale)` to `FATAL-RING-STALE`. Legacy event name is preserved for the non-stale `(exceeds max)` branch below.

- [ ] **Step 3: Add the `kn_get_fatal_stale` export**

Add after `kn_get_failed_rollbacks` (around line 1361):

```c
/* RF7: Returns 1 (and clears flag) if a FATAL-RING-STALE was signaled
 * since the last call. Writes frame, ring_idx, actual-frame-in-slot
 * to out params for the JS log. Per §Core principle: JS logs and
 * continues; no resync recovery. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_fatal_stale(int *out_f, int *out_idx, int *out_actual) {
    if (!rb.fatal_stale_pending) return 0;
    if (out_f) *out_f = rb.fatal_stale_f;
    if (out_idx) *out_idx = rb.fatal_stale_ring_idx;
    if (out_actual) *out_actual = rb.fatal_stale_actual;
    rb.fatal_stale_pending = 0;
    return 1;
}
```

- [ ] **Step 4: Declare the export in the header**

In `build/kn_rollback/kn_rollback.h`, near `kn_get_failed_rollbacks` (around line 71), add:

```c
/* R3: Returns 1 (and clears flag) if the rollback branch just
 * detected a stale ring slot. Writes frame, ring_idx, actual
 * frame-in-slot to out params. JS surfaces via FATAL-RING-STALE
 * log. No resync recovery. */
int kn_get_fatal_stale(int *out_f, int *out_idx, int *out_actual);
```

- [ ] **Step 5: Also add `kn_debug_corrupt_ring_slot` (used by the RF7 regression test)**

In `build/kn_rollback/kn_rollback.c`, near the other debug exports (around [line 1400](build/kn_rollback/kn_rollback.c#L1400)), add:

```c
/* DEBUG-ONLY: Corrupt the ring slot for a given frame by setting its
 * ring_frames entry to a wrong value. Used by the RF7 regression
 * test to induce a stale-ring hit on demand. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_debug_corrupt_ring_slot(int frame) {
    if (!rb.initialized) return;
    int idx = frame % rb.ring_size;
    rb.ring_frames[idx] = -999;  /* guaranteed mismatch */
}
```

Declare in `build/kn_rollback/kn_rollback.h` (bottom of file, above `#endif`):

```c
/* DEBUG-ONLY: test helper for RF7 regression. Scrambles ring_frames
 * for the given frame so the next rollback targeting it hits stale. */
void kn_debug_corrupt_ring_slot(int frame);
```

- [ ] **Step 6: Mirror to build-source copies**

Run:
```bash
cp build/kn_rollback/kn_rollback.c build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c
cp build/kn_rollback/kn_rollback.h build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h
```

- [ ] **Step 7: Rebuild WASM (single rebuild covers both exports)**

Run:
```bash
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash -c "cd /build/src/RetroArch && emmake make -f Makefile.emulatorjs clean; bash /build/build.sh"
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
```

- [ ] **Step 8: Verify both exports are in the binary**

Run:
```bash
grep -ao 'kn_get_fatal_stale\|kn_debug_corrupt_ring_slot' build/output/mupen64plus_next_libretro.wasm | sort -u
```

Expected: both names appear.

### Task 5.2: JS-side FATAL-RING-STALE poll

**Files:**
- Modify: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Allocate scratch buffers for the out params**

The poll uses three `int*` out params. Allocate a scratch buffer once and reuse:

Near the other `_rb*BufPtr` lazy allocations (grep `_rbHashBufPtr` to find existing pattern, around line 6500-6600 area), add:

```javascript
      // Scratch buffer for kn_get_fatal_stale — 3 × int32.
      if (!_rbFatalBuf && tickMod._malloc) _rbFatalBuf = tickMod._malloc(12);
```

And declare at module scope (near `_rbHashBufPtr` declaration):

```javascript
  let _rbFatalBuf = 0;
```

Run:
```bash
grep -n '_rbHashBufPtr\|let _rbRegionsBufPtr' web/static/netplay-lockstep.js | head -5
```

to find the existing pattern location.

- [ ] **Step 2: Poll and log FATAL-RING-STALE every tick**

Immediately after the RF1 `kn_rollback_did_restore` poll block (added in Task 3.4 Step 1, around line 6363 post-insertion), add:

```javascript
      // ── R3: Fatal stale-ring poll ────────────────────────────────────
      // If kn_feed_input just detected a misprediction for a frame
      // whose ring slot was overwritten, log FATAL-RING-STALE with full
      // diagnostic fields. Per §Core principle: dev throws, prod logs
      // and continues. No resync recovery.
      // See docs/netplay-invariants.md §R3.
      if (tickMod._kn_get_fatal_stale && _rbFatalBuf) {
        const hit = tickMod._kn_get_fatal_stale(
          _rbFatalBuf,
          _rbFatalBuf + 4,
          _rbFatalBuf + 8,
        );
        if (hit) {
          const heap = tickMod.HEAP32;
          const base = _rbFatalBuf >> 2;
          const staleF = heap[base];
          const staleIdx = heap[base + 1];
          const staleActual = heap[base + 2];
          _syncLog(
            `FATAL-RING-STALE f=${staleF} ring[${staleIdx}]=${staleActual} curF=${_frameNum} tick=${performance.now().toFixed(1)}`,
          );
          if (window.KN_DEV_BUILD) {
            throw new Error(
              `FATAL-RING-STALE: ring[${staleIdx}]=${staleActual} but needed frame ${staleF}`,
            );
          }
        }
      }
```

- [ ] **Step 3: Write the RF7 regression test**

Create `tests/rollback/rf7-fatal-stale.spec.mjs`:

```javascript
#!/usr/bin/env node
/**
 * RF7 regression test: inject a stale ring entry and trigger a
 * misprediction targeting that frame. FATAL-RING-STALE must fire
 * with correct fields. Dev build throws.
 *
 * Usage: node tests/rollback/rf7-fatal-stale.spec.mjs
 */
import { chromium } from 'playwright';

const BASE_URL = 'https://localhost:27888';

async function run() {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const events = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('FATAL-RING-STALE')) events.push(t);
  });

  await page.goto(`${BASE_URL}/?debug=1`);
  await page.waitForFunction(() => window.KNState?.frameNum >= 200, { timeout: 30000 });

  // To trigger a stale hit even WITH RF4's coverage check, we pick a
  // frame OUTSIDE the rollback window (older than max_frames back).
  // That bypasses the R3 coverage guarantee (which only covers the
  // window) while still triggering the stale-ring check inside
  // kn_feed_input.
  const fired = await page.evaluate(() => {
    const mod = window.EJS_emulator.gameManager.Module;
    const curFrame = mod._kn_get_frame();
    // max_frames is not directly exported; use a hardcoded 12 as the
    // production value. Target a frame well outside the window so the
    // ring slot is guaranteed stale regardless of RF4.
    const staleFrame = Math.max(0, curFrame - 20);
    mod._kn_feed_input(1, staleFrame, 0, 60, -60, 0, 0);
    return { curFrame, staleFrame };
  });

  // Wait one tick for the poll to fire.
  await page.waitForTimeout(200);

  if (events.length === 0) {
    console.error(`FAIL: no FATAL-RING-STALE logged`);
    console.error('fired:', fired);
    process.exit(1);
  }

  const e = events[0];
  if (!e.includes('ring[') || !e.includes('curF=')) {
    console.error(`FAIL: missing fields: ${e}`);
    process.exit(1);
  }

  console.log(`PASS: ${events.length} FATAL-RING-STALE logged with full fields`);
  await browser.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Note: this test relies on `kn_feed_input` taking the stale-ring branch for an out-of-window frame. Looking at [kn_rollback.c:677-697](build/kn_rollback/kn_rollback.c#L677-L697), the branch structure is: `depth <= max_frames` → check ring → stale or proceed. For `depth > max_frames`, the "exceeds max" branch fires instead, which is NOT the fatal stale we want. So the test actually needs `depth <= max_frames` combined with the ring slot being stale — RF4 makes this hard naturally, so the test needs to artificially invalidate a ring slot. Revise the test to use a debug hook that writes directly to `ring_frames[idx]`:

Update the test evaluate block to:

```javascript
  const fired = await page.evaluate(() => {
    const mod = window.EJS_emulator.gameManager.Module;
    // Use __rbTest debug hook (added below) to corrupt a ring slot
    // so the next misprediction check fails coverage.
    if (!window.__rbTest?.corruptRingSlot) return { err: 'hook missing' };
    const curFrame = mod._kn_get_frame();
    // Corrupt the ring slot for a frame 5 back (inside rollback window).
    window.__rbTest.corruptRingSlot(curFrame - 5);
    // Now feed a misprediction for that same frame.
    mod._kn_feed_input(1, curFrame - 5, 0, 60, -60, 0, 0);
    return { curFrame };
  });
```

- [ ] **Step 4: Add `corruptRingSlot` to `__rbTest`**

In the `__rbTest` block from Task 2.2, extend:

```javascript
    if (window.KN_DEV_BUILD) {
      window.__rbTest = {
        setReplayLogged: (v) => {
          _rbReplayLogged = !!v;
        },
        nullifyRunner: () => {
          _pendingRunner = null;
        },
        stepOneFrame: () => stepOneFrame(),
        corruptRingSlot: (frame) => {
          // Debug-only: scramble the ring_frames entry for this frame
          // so the next rollback targeting it will hit the stale branch.
          // Requires a new C-level export kn_debug_corrupt_ring_slot.
          const mod = window.EJS_emulator?.gameManager?.Module;
          if (mod?._kn_debug_corrupt_ring_slot) {
            mod._kn_debug_corrupt_ring_slot(frame);
          }
        },
      };
    }
```

- [ ] **Step 5: Run the RF7 test**

(The `kn_debug_corrupt_ring_slot` export and WASM rebuild were already handled in Task 5.1 Steps 5-8.)

```bash
node tests/rollback/rf7-fatal-stale.spec.mjs
```

Expected: `PASS: 1 FATAL-RING-STALE logged with full fields`.

### Task 5.3: Commit RF7

- [ ] **Step 1: Stage + commit**

Run:
```bash
git add build/kn_rollback/kn_rollback.c build/kn_rollback/kn_rollback.h \
  build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c \
  build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h \
  build/output/mupen64plus_next_libretro.wasm build/output/mupen64plus_next-wasm.data \
  web/static/ejs/cores/mupen64plus_next-wasm.data \
  web/static/netplay-lockstep.js \
  tests/rollback/rf7-fatal-stale.spec.mjs
git commit -m "$(cat <<'EOF'
feat(rollback): R3 loud FATAL-RING-STALE on stale ring slot (RF7)

Before: stale ring slots during misprediction detection logged
FAILED-ROLLBACK (stale) and silently corrupted game state. After:
kn_feed_input sets a fatal flag JS polls every tick, surfacing as
FATAL-RING-STALE with full diagnostic fields. Dev builds throw;
production logs and continues. Per §Core principle: no resync
recovery.

Ships after RF4 (ring coverage guarantee) so the changeover does
not spam logs for legitimate pre-fix stale cases. With RF4 in
place, any subsequent FATAL-RING-STALE is a real new bug.

Also adds kn_debug_corrupt_ring_slot test helper (dev builds only)
used by the regression test to induce stale hits on demand.

Spec: docs/superpowers/specs/2026-04-11-rollback-state-integrity-audit.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 6: RF5 — Post-replay live-state verification (R4)

**Why now:** Ships after RF1 (runner re-capture) and RF4 (ring coverage). Any residual drift past those fixes — e.g., a subtle determinism issue in replay — shows up as a live-vs-ring hash mismatch. Dev builds throw; prod logs and continues. No resync.

WASM core rebuild required.

### Task 6.1: RF5 — Post-replay live-state hash verification (C)

**Files:**
- Modify: `build/kn_rollback/kn_rollback.c`
- Modify: `build/kn_rollback/kn_rollback.h`
- Modify: mirror copies

- [ ] **Step 1: Add the `kn_live_gameplay_hash` export**

In `build/kn_rollback/kn_rollback.c`, add after the existing `kn_gameplay_hash` function (around [line 1231](build/kn_rollback/kn_rollback.c#L1231)):

```c
/* ── Live gameplay hash ─────────────────────────────────────────────
 * Fresh retro_serialize + gameplay hash of the CURRENT live emulator
 * state, bypassing the ring buffer. Used by RF5 to verify that after
 * a replay completes, the live state matches what the ring claims.
 * If they differ, the replay introduced drift and we log loudly.
 *
 * Uses a static scratch buffer reused across calls to avoid malloc
 * pressure. Expected cost: one retro_serialize (~1-2ms) per call.
 * Called at most once per rollback completion (rollbacks are rare),
 * so total overhead is negligible. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
uint32_t kn_live_gameplay_hash(void) {
    static uint8_t *scratch = NULL;
    static size_t scratch_capacity = 0;

    if (!rb.initialized) return 0;
    if (kn_rdram_offset_in_state == 0) return 0;

    size_t state_size = rb.state_size;
    if (scratch_capacity < state_size) {
        free(scratch);
        scratch = (uint8_t *)malloc(state_size);
        if (!scratch) {
            scratch_capacity = 0;
            return 0;
        }
        scratch_capacity = state_size;
    }

    if (!retro_serialize(scratch, state_size)) return 0;

    /* Same hash logic as kn_gameplay_hash but over scratch buffer. */
    uint32_t hash = 2166136261u;
    for (int a = 0; a < KN_GAMEPLAY_ADDR_COUNT; a++) {
        size_t off = kn_rdram_offset_in_state + kn_gameplay_addrs[a].rdram_offset;
        uint32_t sz = kn_gameplay_addrs[a].size;
        if (off + sz > state_size) continue;
        for (uint32_t b = 0; b < sz; b++) {
            hash ^= scratch[off + b];
            hash *= 16777619u;
        }
    }
    return hash;
}
```

- [ ] **Step 2: Add `rb.live_mismatch_*` fields**

In the `rb` struct (around line 225, near the new fatal_stale fields), add:

```c
    /* RF5: Live-vs-ring hash mismatch signal. Set by kn_post_tick
     * when a replay completes and the live state hash differs from
     * what the ring claims. JS polls via kn_get_live_mismatch() and
     * logs RB-LIVE-MISMATCH. No resync recovery per §Core principle.
     * See docs/netplay-invariants.md §R4. */
    int live_mismatch_pending;
    int live_mismatch_f;
    uint32_t live_mismatch_replay;
    uint32_t live_mismatch_live;
```

- [ ] **Step 3: Add the mismatch check in `kn_post_tick`**

Find `kn_post_tick` around [line 944](build/kn_rollback/kn_rollback.c#L944). Inside the `if (rb.replay_remaining == 0)` branch at line 949, after the existing `memcpy(rb.rdram_base, rb.saved_rdram, ...)` at line 956 and the ring patch block at lines 962-968, but BEFORE the `rb_log("C-REPLAY-DONE ...")` at line 969, add:

```c
            /* R4: Post-replay live-state verification. Hash the live
             * emulator state and compare to what the ring claims for
             * this frame. If they differ, the replay introduced drift
             * and the run is corrupted. Log loudly; no recovery.
             * See docs/netplay-invariants.md §R4. */
            {
                int target = rb.frame - 1;
                uint32_t ring_gp = kn_gameplay_hash(target);
                uint32_t live_gp = kn_live_gameplay_hash();
                if (ring_gp != 0 && live_gp != 0 && ring_gp != live_gp) {
                    rb.live_mismatch_pending = 1;
                    rb.live_mismatch_f = target;
                    rb.live_mismatch_replay = ring_gp;
                    rb.live_mismatch_live = live_gp;
                    rb_log("RB-LIVE-MISMATCH f=%d ring=0x%x live=0x%x",
                        target, ring_gp, live_gp);
                }
            }
```

- [ ] **Step 4: Add the `kn_get_live_mismatch` export**

Near `kn_get_fatal_stale` (added in Task 5.1 Step 3), add:

```c
/* RF5: Returns 1 (and clears flag) if a post-replay live-state
 * hash mismatch was detected. Writes frame, ring hash, live hash
 * to out params. Per §Core principle: JS logs and continues; no
 * resync recovery. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_get_live_mismatch(int *out_f, uint32_t *out_ring, uint32_t *out_live) {
    if (!rb.live_mismatch_pending) return 0;
    if (out_f) *out_f = rb.live_mismatch_f;
    if (out_ring) *out_ring = rb.live_mismatch_replay;
    if (out_live) *out_live = rb.live_mismatch_live;
    rb.live_mismatch_pending = 0;
    return 1;
}
```

- [ ] **Step 5: Declare both exports in the header**

In `build/kn_rollback/kn_rollback.h` near `kn_gameplay_hash` declaration (around line 135), add:

```c
/* R4: Fresh retro_serialize + gameplay hash of live state. Used
 * by kn_post_tick to verify replay produced bit-correct state. */
uint32_t kn_live_gameplay_hash(void);

/* R4: Returns 1 (and clears flag) if post-replay live vs ring
 * hash mismatch was signaled. */
int kn_get_live_mismatch(int *out_f, uint32_t *out_ring, uint32_t *out_live);
```

- [ ] **Step 6: Mirror, rebuild, deploy**

Run:
```bash
cp build/kn_rollback/kn_rollback.c build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c
cp build/kn_rollback/kn_rollback.h build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash -c "cd /build/src/RetroArch && emmake make -f Makefile.emulatorjs clean; bash /build/build.sh"
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
```

Verify:
```bash
grep -ao 'kn_live_gameplay_hash\|kn_get_live_mismatch' build/output/mupen64plus_next_libretro.wasm | sort -u
```

Expected: both names appear.

### Task 6.2: JS-side RB-LIVE-MISMATCH poll

**Files:**
- Modify: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Add scratch buffer declaration**

Near the `_rbFatalBuf` declaration (from Task 5.2 Step 1), add:

```javascript
  let _rbLiveMismatchBuf = 0; // 3 × uint32: frame, ring hash, live hash
```

And near its allocation:

```javascript
      if (!_rbLiveMismatchBuf && tickMod._malloc) _rbLiveMismatchBuf = tickMod._malloc(12);
```

- [ ] **Step 2: Add the poll after the FATAL-RING-STALE poll**

Immediately after the FATAL-RING-STALE poll block from Task 5.2 Step 2, add:

```javascript
      // ── R4: Post-replay live-state mismatch poll ─────────────────────
      // kn_post_tick compares the live emulator state hash to what the
      // ring claims for the just-completed replay frame. If they differ,
      // the replay introduced drift and the run is corrupted. Per §Core
      // principle: dev throws, prod logs and continues. No resync.
      // See docs/netplay-invariants.md §R4.
      if (tickMod._kn_get_live_mismatch && _rbLiveMismatchBuf) {
        const hit = tickMod._kn_get_live_mismatch(
          _rbLiveMismatchBuf,
          _rbLiveMismatchBuf + 4,
          _rbLiveMismatchBuf + 8,
        );
        if (hit) {
          const heap32 = tickMod.HEAP32;
          const heapU32 = tickMod.HEAPU32;
          const base = _rbLiveMismatchBuf >> 2;
          const mf = heap32[base];
          const ringHash = heapU32[base + 1];
          const liveHash = heapU32[base + 2];
          _syncLog(
            `RB-LIVE-MISMATCH f=${mf} ring=0x${ringHash.toString(16)} live=0x${liveHash.toString(16)} curF=${_frameNum}`,
          );
          if (window.KN_DEV_BUILD) {
            throw new Error(
              `RB-LIVE-MISMATCH: ring=0x${ringHash.toString(16)} live=0x${liveHash.toString(16)} at f=${mf}`,
            );
          }
        }
      }
```

### Task 6.3: RF5 regression test

**Files:**
- Create: `tests/rollback/rf5-live-mismatch.spec.mjs`

- [ ] **Step 1: Write the test**

Create `tests/rollback/rf5-live-mismatch.spec.mjs`:

```javascript
#!/usr/bin/env node
/**
 * RF5 regression test: deliberately perturb one byte of the ring
 * entry after a rollback-replay completes, so the live state no
 * longer matches the ring. The next kn_post_tick with
 * replay_remaining==0 must fire RB-LIVE-MISMATCH.
 *
 * Usage: node tests/rollback/rf5-live-mismatch.spec.mjs
 */
import { chromium } from 'playwright';

const BASE_URL = 'https://localhost:27888';

async function run() {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const events = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('RB-LIVE-MISMATCH')) events.push(t);
  });

  await page.goto(`${BASE_URL}/?debug=1`);
  await page.waitForFunction(() => window.KNState?.frameNum >= 200, { timeout: 30000 });

  // Force a rollback then perturb the ring entry for the replay
  // target frame. When kn_post_tick runs the final replay step, the
  // live hash will differ from the (perturbed) ring hash and
  // RB-LIVE-MISMATCH will fire.
  const fired = await page.evaluate(() => {
    if (!window.knDiag?.forceMisprediction) return false;
    window.knDiag.forceMisprediction({ slotDelta: 60 });
    // Wait a microtask so the rollback has a chance to start
    return true;
  });
  if (!fired) {
    console.error('FAIL: knDiag.forceMisprediction not installed');
    process.exit(1);
  }

  // Perturb the ring entry while the rollback is in progress.
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    const mod = window.EJS_emulator.gameManager.Module;
    if (mod._kn_debug_perturb_ring_byte) {
      const cur = mod._kn_get_frame();
      mod._kn_debug_perturb_ring_byte(cur - 1);
    }
  });

  // Wait for the replay to complete.
  await page.waitForTimeout(1000);

  if (events.length === 0) {
    console.error('FAIL: no RB-LIVE-MISMATCH logged');
    process.exit(1);
  }

  const e = events[0];
  if (!e.match(/ring=0x[0-9a-f]+/) || !e.match(/live=0x[0-9a-f]+/)) {
    console.error(`FAIL: missing ring/live hashes: ${e}`);
    process.exit(1);
  }

  console.log(`PASS: ${events.length} RB-LIVE-MISMATCH logged with both hashes`);
  await browser.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Add `kn_debug_perturb_ring_byte` C export**

In `build/kn_rollback/kn_rollback.c` near `kn_debug_corrupt_ring_slot`, add:

```c
/* DEBUG-ONLY: Perturb one byte of the ring entry for a given frame.
 * Used by the RF5 regression test to force a live-vs-ring hash
 * mismatch on the next post_tick replay completion. */
#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_debug_perturb_ring_byte(int frame) {
    if (!rb.initialized) return;
    int idx = frame % rb.ring_size;
    if (rb.ring_frames[idx] != frame) return;  /* not that frame anymore */
    /* Flip one byte inside the RDRAM gameplay address range so
     * kn_gameplay_hash produces a different result. Use the P1
     * damage offset (0x130DB0) which is in the gameplay hash set. */
    if (kn_rdram_offset_in_state == 0) return;
    size_t off = kn_rdram_offset_in_state + 0x130DB0;
    if (off < rb.state_size) {
        rb.ring_bufs[idx][off] ^= 0xFF;
    }
}
```

Declare in header:

```c
/* DEBUG-ONLY: RF5 test helper. Flips one byte of the ring entry for
 * the given frame so the next post-replay live-vs-ring check fails. */
void kn_debug_perturb_ring_byte(int frame);
```

- [ ] **Step 3: Mirror, rebuild, deploy, run test**

Run:
```bash
cp build/kn_rollback/kn_rollback.c build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c
cp build/kn_rollback/kn_rollback.h build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash -c "cd /build/src/RetroArch && emmake make -f Makefile.emulatorjs clean; bash /build/build.sh"
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
node tests/rollback/rf5-live-mismatch.spec.mjs
```

Expected: `PASS: 1 RB-LIVE-MISMATCH logged with both hashes`.

### Task 6.4: Commit RF5

- [ ] **Step 1: Stage + commit**

Run:
```bash
git add build/kn_rollback/kn_rollback.c build/kn_rollback/kn_rollback.h \
  build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c \
  build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h \
  build/output/mupen64plus_next_libretro.wasm build/output/mupen64plus_next-wasm.data \
  web/static/ejs/cores/mupen64plus_next-wasm.data \
  web/static/netplay-lockstep.js \
  tests/rollback/rf5-live-mismatch.spec.mjs
git commit -m "$(cat <<'EOF'
feat(rollback): R4 post-replay live-state hash verification (RF5)

kn_post_tick now hashes the live emulator state after a replay
completes and compares to what the ring claims for the same frame.
Any mismatch means the replay introduced drift and the run is
corrupted — log RB-LIVE-MISMATCH loudly with both hashes; dev
builds throw. Per §Core principle: no resync recovery.

Cost: one retro_serialize (~1-2ms) per rollback completion.
Rollbacks are rare (single-digit per match), so total overhead is
negligible. Static scratch buffer reused across calls.

Also adds kn_debug_perturb_ring_byte test helper (dev builds only)
used by the regression test to force a deliberate mismatch.

Spec: docs/superpowers/specs/2026-04-11-rollback-state-integrity-audit.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 7: RF6 — Audio pipeline diagnostics + contingent fix (R6)

**Why now:** Part A (strengthen AUDIO-DEATH logging) ships after RF1-RF5 so the enriched diagnostics can observe whether the audio death was purely a secondary effect of the no-replay bug or has its own survivability problem. Part B is gated — executes only if residual AUDIO-DEATH is observed. If Phase 2 investigation reveals an architectural audio-subsystem problem outside kn_rollback.c, RF6 converts to its own `audio-pipeline-survivability` spec per spec §RF6 conversion rule.

Part A: JS + Python only, no WASM rebuild. Part B (contingent): C + WASM rebuild.

### Task 7.1: RF6 Part A — Strengthen AUDIO-DEATH diagnostic signal

**Files:**
- Modify: `web/static/netplay-lockstep.js` — enrich the `audio-empty` / `audio-silent` log lines
- Modify: `tools/analyze_match.py` — parse new fields and infer rollback correlation

- [ ] **Step 1: Locate the existing `audio-empty` log**

Run:
```bash
grep -n "audio-empty f=\|audio-silent:" web/static/netplay-lockstep.js | head
```

Expected: the existing `_syncLog("audio-empty f=...")` emission in `feedAudio` or similar (seen at f=811 in the B190OHFY logs).

- [ ] **Step 2: Enrich the log line with rollback-correlation + context fields**

Find the line that emits `audio-empty f=... ptr=... alCtx=... sdlAudio=...`. Extend the template to include:

- `framesSinceLastAudio`: delta since the last successful feedAudio call (already tracked as `_lastAudioFrame` or similar)
- `lastRollbackF`: the frame of the most recent `C-REPLAY done` event (cache this in a new module-level var `_lastRollbackDoneFrame` updated in the existing C-REPLAY done block from [line ~6380](web/static/netplay-lockstep.js#L6380))
- `resetAudioCalls`: counter of `kn_reset_audio` calls since the last rollback (reset to 0 in the C-REPLAY done block, incremented wherever `kn_reset_audio` is called in the tick loop)
- `ctxState`: `window.EJS_emulator?.audioContext?.state` (e.g., `"running"`, `"suspended"`)
- `workletPort`: whether the AudioWorklet MessagePort is still open (`_audioWorkletNode?.port ? 'open' : 'closed'`)

Concretely, change:

```javascript
_syncLog(`audio-empty f=${_frameNum} ptr=${audioPtr} alCtx=${alCtx} sdlAudio=${sdlAudio}`);
```

to:

```javascript
_syncLog(
  `audio-empty f=${_frameNum} ptr=${audioPtr} alCtx=${alCtx} sdlAudio=${sdlAudio} ` +
    `lastRb=${_lastRollbackDoneFrame ?? -1} rbDelta=${_lastRollbackDoneFrame != null ? _frameNum - _lastRollbackDoneFrame : -1} ` +
    `resetAudioCalls=${_resetAudioCallsSinceRb} ctxState=${window.EJS_emulator?.audioContext?.state ?? 'unknown'} ` +
    `workletPort=${window._audioWorkletNode?.port ? 'open' : 'closed'}`,
);
```

Module-level declarations near the other `_rb*` vars (around [line 550](web/static/netplay-lockstep.js#L550)):

```javascript
  let _lastRollbackDoneFrame = null;
  let _resetAudioCallsSinceRb = 0;
```

In the `C-REPLAY done` block (from Task 3.4, inside the `if (_rbReplayLogged && !catchingUp)` branch around [line 6378-6400](web/static/netplay-lockstep.js#L6378-L6400)), after `_rbPendingPostRollbackHash = true;`, add:

```javascript
        _lastRollbackDoneFrame = _frameNum;
        _resetAudioCallsSinceRb = 0;
```

Wherever `kn_reset_audio` is called in the tick loop (grep `tickMod._kn_reset_audio` to find the sites — there are ~2), wrap with an increment:

```javascript
if (tickMod._kn_reset_audio) {
  tickMod._kn_reset_audio();
  _resetAudioCallsSinceRb++;
}
```

- [ ] **Step 3: Also enrich the `audio-silent` log (the 300-frame clump)**

Similar treatment. Find the `audio-silent:` emission (one-time log when the run exceeds a threshold):

```bash
grep -n 'audio-silent:' web/static/netplay-lockstep.js
```

Append the same suffix fields as above.

- [ ] **Step 4: Update `analyze_match.py` AUDIO-DEATH section**

In `tools/analyze_match.py`, find the `AUDIO-DEATH` detection block from commit 91b79e9 (search for `query_freeze_detection` and within it `audio_empty = df.filter(...)`).

Extend the audio-empty row formatting to parse and report the new fields. After the existing `f=` extraction, add extractions for:

```python
    audio_empty_parsed = audio_empty.with_columns(
        rb_delta=pl.col("msg").str.extract(r"rbDelta=(-?\d+)", 1).cast(pl.Int64),
        last_rb=pl.col("msg").str.extract(r"lastRb=(-?\d+)", 1).cast(pl.Int64),
        reset_calls=pl.col("msg").str.extract(r"resetAudioCalls=(\d+)", 1).cast(pl.Int64),
        ctx_state=pl.col("msg").str.extract(r"ctxState=(\w+)", 1),
        worklet_port=pl.col("msg").str.extract(r"workletPort=(\w+)", 1),
    )
```

Then in the AUDIO-DEATH print block, replace the single-line summary with a richer report:

```python
if audio_empty.height >= 10 or audio_silent.height > 0:
    found_any = True
    print(f"  AUDIO-DEATH: {audio_empty.height} audio-empty + {audio_silent.height} audio-silent events")
    if audio_silent.height > 0:
        for row in audio_silent.head(3).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:200]}")
    if audio_empty.height >= 10:
        first_empty = audio_empty_parsed.head(1).row(0, named=True)
        rb_delta = first_empty.get("rb_delta", -1)
        last_rb = first_empty.get("last_rb", -1)
        reset_calls = first_empty.get("reset_calls", -1)
        ctx_state = first_empty.get("ctx_state", "unknown")
        worklet_port = first_empty.get("worklet_port", "unknown")
        print(f"    first empty at f={first_empty['f']} slot={first_empty['slot']}")
        if last_rb is not None and last_rb >= 0 and rb_delta is not None and rb_delta >= 0:
            correlation = "strong" if rb_delta < 10 else ("moderate" if rb_delta < 100 else "independent")
            print(f"    rollback correlation: C-REPLAY done at f={last_rb} (Δ={rb_delta}f, {correlation})")
            if correlation == "strong" and reset_calls is not None and reset_calls == 0:
                print(f"    likely cause: rollback path missed audio reset (resetAudioCalls=0)")
        print(f"    ctxState={ctx_state} workletPort={worklet_port}")
```

- [ ] **Step 5: Run Prettier + lint the analyzer**

Run:
```bash
just fmt-js
just lint-py
```

Expected: both clean.

### Task 7.2: Commit RF6 Part A

- [ ] **Step 1: Stage + commit**

Run:
```bash
git add web/static/netplay-lockstep.js tools/analyze_match.py
git commit -m "$(cat <<'EOF'
feat(rollback): R6 Part A — strengthen AUDIO-DEATH diagnostics

Enrich the audio-empty / audio-silent log lines with rollback-
correlation fields (lastRb, rbDelta, resetAudioCalls) and AudioContext
/ AudioWorklet state (ctxState, workletPort). Extend
tools/analyze_match.py AUDIO-DEATH section to parse these and
report inferred cause (rollback correlation, missing reset call,
suspended ctx, etc.).

Ships as a pure diagnostic strengthening — no behavior change. Lets
us tell post-RF1 whether residual audio death is a rollback side
effect (RF6 Part B) or an independent subsystem problem (RF6 handoff
to audio-pipeline-survivability spec).

Spec: docs/superpowers/specs/2026-04-11-rollback-state-integrity-audit.md §RF6

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 7.3: RF6 Part B — Contingent root-cause fix (gated)

**This task is gated on post-RF1-RF5 observation.** Do NOT execute these steps if a real two-tab rollback scenario reports zero AUDIO-DEATH events. Only proceed if residual audio death is observed AND the analyzer's inferred cause points at the rollback path.

- [ ] **Step 1: Run a real two-tab rollback scenario after RF1-RF5 have all landed**

Use `tests/rollback-rng-test.mjs` or the RF1 regression test to drive a rollback. Then:

```bash
cd server && uv run python ../tools/analyze_match.py --room <latest-room> 2>&1 | grep -A20 AUDIO-DEATH
```

- [ ] **Step 2: Decision gate**

- **If the analyzer reports zero AUDIO-DEATH events**: RF6 Part B is COMPLETE-BY-ABSORPTION. Mark this task done and proceed to Chunk 3. No further code changes.
- **If AUDIO-DEATH fires with `likely cause: rollback path missed audio reset`**: proceed to Step 3.
- **If AUDIO-DEATH fires with a different inferred cause** (`ctxState=suspended`, `workletPort=closed`, etc.): this is the conversion-rule trigger from spec §RF6. STOP. Report to user: "RF6 has expanded beyond kn_rollback.c — handing off to a new audio-pipeline-survivability spec per the spec's conversion rule." Do NOT continue.

- [ ] **Step 3: Add `kn_reset_audio` to the rollback restore path in C**

In `build/kn_rollback/kn_rollback.c`, find the success branch of the rollback (around line 754 where `retro_unserialize` and `sf_restore` live). After the `rb.did_restore = 1;` line from RF1, add:

```c
            /* R6: audio pipeline state is sourced from RDRAM and does
             * not survive retro_unserialize cleanly. Reset the capture
             * buffer the same way the normal frame path does. Without
             * this, the AudioWorklet starves for hundreds of frames
             * after a rollback even when the replay produced correct
             * gameplay state.
             * See docs/netplay-invariants.md §R6. */
            kn_reset_audio();
```

`kn_reset_audio` is already declared as an extern at [line 63](build/kn_rollback/kn_rollback.c#L63).

- [ ] **Step 4: Mirror, rebuild, deploy, verify**

```bash
cp build/kn_rollback/kn_rollback.c build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash -c "cd /build/src/RetroArch && emmake make -f Makefile.emulatorjs clean; bash /build/build.sh"
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/
```

Re-run the rollback scenario and confirm zero AUDIO-DEATH in the analyzer report.

- [ ] **Step 5: Commit RF6 Part B (if executed)**

```bash
git add build/kn_rollback/kn_rollback.c \
  build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c \
  build/output/mupen64plus_next_libretro.wasm build/output/mupen64plus_next-wasm.data \
  web/static/ejs/cores/mupen64plus_next-wasm.data
git commit -m "$(cat <<'EOF'
fix(rollback): R6 Part B — reset audio capture after retro_unserialize

Residual AUDIO-DEATH events observed post-RF1 confirmed the rollback
restore path was missing the kn_reset_audio call that the normal
frame path makes. Without the reset, the AudioWorklet sample buffer
starves for hundreds of frames after a successful replay even when
gameplay state is correct.

Fix: call kn_reset_audio immediately after retro_unserialize in the
rollback success branch. Mirrors the normal frame path's per-frame
reset.

Spec: docs/superpowers/specs/2026-04-11-rollback-state-integrity-audit.md §RF6

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

*Chunks 4-7 end here. Chunk 8 follows.*

---

## Chunk 8: V1 WASM integrity test, V3 analyzer additions, documentation

**Why last:** Ships after all RF fixes so the test harness runs against the correct behavior and the analyzer's new detections have real fixes to verify against. Docs go last so they reflect the actually-shipped invariants.

### Task 8.1: V1 — `kn_rollback_integrity_test` C export

**Files:**
- Modify: `build/kn_rollback/kn_rollback.c`
- Modify: `build/kn_rollback/kn_rollback.h`
- Modify: mirror copies

**Dependency:** `kn_integrity_hash_live` wraps `kn_live_gameplay_hash` which is added in **Task 6.1 (RF5 Step 1)**. Task 8.1 cannot ship until Chunk 6 lands — which is enforced by Chunk 8's position in the implementation order.

- [ ] **Step 1: Add the export**

The existing `kn_replay_self_test` ([kn_rollback.c:1453](build/kn_rollback/kn_rollback.c#L1453)) is a pure determinism check that directly calls `retro_run` from C. It does NOT exercise the full `kn_pre_tick`/`kn_post_tick` pipeline, so it would NOT have caught RF1's `_pendingRunner`-invalidation bug. `kn_rollback_integrity_test` is a new, more stringent check that drives the actual amortized rollback path.

Add to `build/kn_rollback/kn_rollback.c` near `kn_replay_self_test`:

```c
/* ── Rollback integrity test ───────────────────────────────────────
 * Exercises the FULL kn_pre_tick / kn_post_tick rollback pipeline,
 * not just retro_run. Would have caught RF1 on the first run.
 *
 * Procedure:
 *   1. Save live state A.
 *   2. Run n_frames forward via the normal path (JS calls this
 *      with stepOneFrame after each kn_pre_tick/kn_post_tick pair).
 *      Hash → B.
 *   3. Restore A.
 *   4. Seed a misprediction by calling kn_feed_input with a
 *      deliberately wrong value for frame 1.
 *   5. Drive kn_pre_tick/kn_post_tick through the replay.
 *   6. Hash live state → B'.
 *   7. Assert B == B'.
 *
 * Because steps 2 and 5 require stepOneFrame which is a JS function,
 * this export stages the state in C but the driver lives in JS
 * (tests/rollback/rollback-integrity-wasm.spec.mjs, Task 8.2).
 * Exposed C helpers:
 *   kn_integrity_save_baseline()  — step 1
 *   kn_integrity_hash_live()      — hash live state via scratch
 *   kn_integrity_seed_mispredict(int frame) — step 4
 *   kn_integrity_restore_baseline() — step 3
 */
static uint8_t *_integrity_baseline = NULL;
static size_t _integrity_baseline_capacity = 0;

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_integrity_save_baseline(void) {
    if (!rb.initialized) return 0;
    size_t state_size = rb.state_size;
    if (_integrity_baseline_capacity < state_size) {
        free(_integrity_baseline);
        _integrity_baseline = (uint8_t *)malloc(state_size);
        if (!_integrity_baseline) {
            _integrity_baseline_capacity = 0;
            return 0;
        }
        _integrity_baseline_capacity = state_size;
    }
    return retro_serialize(_integrity_baseline, state_size) ? 1 : 0;
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
int kn_integrity_restore_baseline(void) {
    if (!_integrity_baseline || !rb.initialized) return 0;
    return retro_unserialize(_integrity_baseline, rb.state_size) ? 1 : 0;
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
uint32_t kn_integrity_hash_live(void) {
    return kn_live_gameplay_hash();
}

#ifdef __EMSCRIPTEN__
EMSCRIPTEN_KEEPALIVE
#endif
void kn_integrity_seed_mispredict(int frame) {
    if (!rb.initialized) return;
    /* Feed an "actual" input that differs from whatever was predicted
     * for this frame. Slot 1 (non-local) with stick values well
     * outside the zone-tolerance window. */
    kn_feed_input(1, frame, 0, 60, -60, 0, 0);
}
```

- [ ] **Step 2: Declare in header**

In `build/kn_rollback/kn_rollback.h` near `kn_replay_self_test`:

```c
/* V1 harness: save live state to the integrity test baseline. */
int kn_integrity_save_baseline(void);

/* V1 harness: restore the saved baseline (step 3 of the test). */
int kn_integrity_restore_baseline(void);

/* V1 harness: hash live state via kn_live_gameplay_hash. */
uint32_t kn_integrity_hash_live(void);

/* V1 harness: seed a misprediction for the given frame (step 4). */
void kn_integrity_seed_mispredict(int frame);
```

- [ ] **Step 3: Mirror, rebuild, verify**

```bash
cp build/kn_rollback/kn_rollback.c build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c
cp build/kn_rollback/kn_rollback.h build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h
docker run --rm -v $(pwd)/build:/build emulatorjs-builder bash -c "cd /build/src/RetroArch && emmake make -f Makefile.emulatorjs clean; bash /build/build.sh"
cp build/output/mupen64plus_next-wasm.data web/static/ejs/cores/

grep -ao 'kn_integrity_save_baseline\|kn_integrity_restore_baseline\|kn_integrity_hash_live\|kn_integrity_seed_mispredict' build/output/mupen64plus_next_libretro.wasm | sort -u
```

Expected: four names appear.

### Task 8.2: V1 — Playwright driver for the integrity test

**Files:**
- Create: `tests/rollback/rollback-integrity-wasm.spec.mjs`

- [ ] **Step 1: Write the driver**

Create `tests/rollback/rollback-integrity-wasm.spec.mjs`:

```javascript
#!/usr/bin/env node
/**
 * V1 rollback integrity harness.
 *
 * Exercises the full kn_pre_tick/kn_post_tick rollback pipeline
 * without needing a peer. Saves a baseline, runs N frames forward
 * via stepOneFrame, hashes, restores, seeds a misprediction, lets
 * the replay complete, hashes again, and asserts the two hashes
 * are bit-identical.
 *
 * This is the determinism check that would have caught RF1 on the
 * first run. Runs on a single tab — no WebRTC, no peer, no network.
 *
 * Usage: node tests/rollback/rollback-integrity-wasm.spec.mjs
 */
import { chromium } from 'playwright';

const BASE_URL = 'https://localhost:27888';
const N_FRAMES = 30;

async function run() {
  const browser = await chromium.launch({ args: ['--ignore-certificate-errors'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const events = { replayNorun: 0, invariant: 0, liveMismatch: 0, fatalStale: 0 };
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('REPLAY-NORUN')) events.replayNorun++;
    if (t.includes('RB-INVARIANT-VIOLATION')) events.invariant++;
    if (t.includes('RB-LIVE-MISMATCH')) events.liveMismatch++;
    if (t.includes('FATAL-RING-STALE')) events.fatalStale++;
  });

  await page.goto(`${BASE_URL}/?debug=1`);
  await page.waitForFunction(() => window.KNState?.frameNum >= 200, { timeout: 30000 });

  const result = await page.evaluate(async (n) => {
    const mod = window.EJS_emulator.gameManager.Module;
    if (
      !mod._kn_integrity_save_baseline ||
      !mod._kn_integrity_restore_baseline ||
      !mod._kn_integrity_hash_live ||
      !mod._kn_integrity_seed_mispredict
    ) {
      return { err: 'integrity helpers missing — rebuild WASM core' };
    }

    // Step 1: save baseline
    if (!mod._kn_integrity_save_baseline()) return { err: 'save_baseline failed' };

    // Step 2: let the tick loop run N frames forward normally, then
    // hash. We wait by polling frame counter.
    const startFrame = mod._kn_get_frame();
    const targetFrame = startFrame + n;
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (mod._kn_get_frame() >= targetFrame) {
          clearInterval(iv);
          resolve();
        }
      }, 16);
    });
    const hashB = mod._kn_integrity_hash_live() >>> 0;

    // Step 3: restore baseline
    if (!mod._kn_integrity_restore_baseline()) return { err: 'restore_baseline failed' };

    // retro_unserialize invalidated the runner — trigger re-capture
    // the same way the rollback path does.
    mod.pauseMainLoop();
    mod.resumeMainLoop();

    // Step 4: seed a misprediction for frame +5 ahead of where we'll
    // be after a short run-up. We need the rollback to target a frame
    // inside the window.
    const afterRestore = mod._kn_get_frame();
    mod._kn_integrity_seed_mispredict(afterRestore + 5);

    // Step 5: let the tick loop run N more frames — this will also
    // process the rollback + replay cycle.
    const targetFrame2 = afterRestore + n;
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (mod._kn_get_frame() >= targetFrame2) {
          clearInterval(iv);
          resolve();
        }
      }, 16);
    });

    // Step 6: hash live state
    const hashBprime = mod._kn_integrity_hash_live() >>> 0;

    return { hashB: hashB.toString(16), hashBprime: hashBprime.toString(16) };
  }, N_FRAMES);

  if (result.err) {
    console.error(`FAIL: ${result.err}`);
    process.exit(1);
  }

  if (events.replayNorun + events.invariant + events.liveMismatch + events.fatalStale > 0) {
    console.error('FAIL: invariant violations fired:', events);
    process.exit(1);
  }

  if (result.hashB !== result.hashBprime) {
    console.error(`FAIL: hashB=0x${result.hashB} != hashBprime=0x${result.hashBprime}`);
    console.error('Replay produced different state than baseline → rollback is not deterministic.');
    process.exit(1);
  }

  console.log(`PASS: hashB == hashBprime == 0x${result.hashB}, zero violations`);
  await browser.close();
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run the test**

Run:
```bash
node tests/rollback/rollback-integrity-wasm.spec.mjs
```

Expected: `PASS: hashB == hashBprime == 0x..., zero violations`.

If the test fails with hashB != hashBprime, the rollback pipeline is producing different state than a direct forward run — which means either (a) the replay is not deterministic, or (b) the input fed to the replayed frame differs from what the normal path used. Diagnose by instrumenting `REPLAY-INPUT` log entries in `kn_rollback.c`'s `write_frame_inputs_logged`.

### Task 8.3: V3 — Analyzer additions for all new events

**Files:**
- Modify: `tools/analyze_match.py`

- [ ] **Step 1: Add detection for the new event types**

In `tools/analyze_match.py`, find `query_freeze_detection` (already extended for AUDIO-DEATH in Task 7.1). Add detection blocks for each of the new events after the existing AUDIO-DEATH / RENDER-STALL / INPUT-DEAD blocks:

```python
    # RF2/RF3: JS-side invariant violations
    replay_norun = df.filter(pl.col("msg").str.contains("REPLAY-NORUN"))
    if replay_norun.height > 0:
        found_any = True
        print(f"  REPLAY-NORUN: {replay_norun.height} events (R2 violation — stepOneFrame called with null runner during replay)")
        for row in replay_norun.head(5).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:240]}")

    rb_invariant = df.filter(pl.col("msg").str.contains("RB-INVARIANT-VIOLATION"))
    if rb_invariant.height > 0:
        found_any = True
        print(f"  RB-INVARIANT-VIOLATION: {rb_invariant.height} events (R5 violation — kn_pre_tick return value inconsistent with replay_depth)")
        for row in rb_invariant.head(5).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:240]}")

    # RF7: fatal stale-ring
    fatal_stale = df.filter(pl.col("msg").str.contains("FATAL-RING-STALE"))
    if fatal_stale.height > 0:
        found_any = True
        print(f"  FATAL-RING-STALE: {fatal_stale.height} events (R3 violation — rollback targeted a frame no longer in the ring)")
        for row in fatal_stale.head(5).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:240]}")

    # RF5: post-replay live-state drift
    live_mismatch = df.filter(pl.col("msg").str.contains("RB-LIVE-MISMATCH"))
    if live_mismatch.height > 0:
        found_any = True
        print(f"  RB-LIVE-MISMATCH: {live_mismatch.height} events (R4 violation — live state after replay differs from ring)")
        for row in live_mismatch.head(5).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:240]}")
```

- [ ] **Step 2: Replace the old ROLLBACK-RESTORE-CORRUPTION comparison logic**

The existing detection from commit 91b79e9 pairs `C-REPLAY done` with `RB-POST-RB` hashes, which was noisy because both can reference different ring reads. Replace it with a check that leverages the new `RB-LIVE-MISMATCH` event directly. The `RB-LIVE-MISMATCH` detection above already surfaces real corruption, so the old detection becomes redundant.

Find the existing `ROLLBACK-RESTORE-CORRUPTION` block in `query_freeze_detection` and replace with:

```python
    # Note: the old ROLLBACK-RESTORE-CORRUPTION detection (commit 91b79e9)
    # compared C-REPLAY done's gp= to RB-POST-RB's gp=, but those can be
    # computed from different ring reads and don't always represent the
    # same logical frame. Post-RF5, real corruption shows up as
    # RB-LIVE-MISMATCH (above), which is a direct live-vs-ring check
    # at the moment of replay completion. The old comparison is left
    # in place only for historical sessions that predate RF5 — if you
    # see ROLLBACK-RESTORE-CORRUPTION but no RB-LIVE-MISMATCH in the
    # same session, the session was recorded before RF5 shipped.
```

Leave the actual `ROLLBACK-RESTORE-CORRUPTION` detection code untouched (it still works for legacy sessions) but add the comment so future readers know to trust `RB-LIVE-MISMATCH` over it.

- [ ] **Step 3: Lint**

Run:
```bash
just lint-py
```

Expected: clean.

- [ ] **Step 4: Smoke-test against a real session log**

Run:
```bash
cd server && uv run python ../tools/analyze_match.py --room <any-recent-room> 2>&1 | grep -E 'REPLAY-NORUN|RB-INVARIANT|FATAL-RING|RB-LIVE-MISMATCH|AUDIO-DEATH'
```

Expected: the four new event types appear as bullet lines if any fired, zero otherwise. `AUDIO-DEATH` retains its enriched format from Task 7.1.

### Task 8.4: Documentation — `docs/netplay-invariants.md` §Rollback Integrity

**Files:**
- Modify: `docs/netplay-invariants.md`

- [ ] **Step 1: Append the Rollback Integrity section**

Open `docs/netplay-invariants.md` and append after the existing I1/I2/MF6 sections:

```markdown

## Rollback Integrity (R1-R6)

The C-level rollback engine ([build/kn_rollback/kn_rollback.c](../build/kn_rollback/kn_rollback.c))
enforces six additional invariants that together eliminate the class
of silent state-corruption bugs uncovered by the 2026-04-11 audit of
room B190OHFY. These complement I1/I2 above — while I1/I2 prevent
the tick loop from freezing forever, R1-R6 prevent the rollback
itself from silently producing wrong state when the tick loop IS
running normally.

**Core principle: no band-aid recovery.** Mid-match auto-resync
triggered from an invariant violation is forbidden. Dev builds throw
so regressions are caught in CI; production builds log loudly and
continue so the player sees the broken game, the analyzer catches
the event, and the root-cause fix goes back in the queue. Silent
auto-recovery is the exact failure mode the audit rejected.

### R1 — Runner continuity across rollback restore

Any code path that calls `retro_unserialize` must re-capture the
Emscripten rAF runner before the next `stepOneFrame()`. The rollback
branch uses `kn_rollback_did_restore()` polled from JS to trigger
`pauseMainLoop`/`resumeMainLoop`. The loadState path at
[netplay-lockstep.js:8221](../web/static/netplay-lockstep.js#L8221)
already does this; rollback mirrors it.

### R2 — No silent stepOneFrame no-ops during replay

`stepOneFrame()` returning false while `_rbReplayLogged === true` is
an invariant violation. Logs `REPLAY-NORUN` with full diagnostic
fields (current frame, replay depth, runner state). Dev builds
throw.

### R3 — Ring coverage within the rollback window

For any frame F where `rb.frame - F <= rb.max_frames`, the ring
buffer must hold valid state for F. The dirty-input serialize gate
at [kn_rollback.c:899](../build/kn_rollback/kn_rollback.c#L899) may
only skip a save if doing so cannot leave any in-window frame
stale. Violations log `FATAL-RING-STALE` and throw in dev.

### R4 — Post-replay live state equals ring state

After a replay completes at frame N, the emulator's live state
(fresh `retro_serialize` + `kn_gameplay_hash`) must match the ring's
stored hash for frame N. Mismatches log `RB-LIVE-MISMATCH` with
both hashes and throw in dev.

### R5 — Pre-tick return value consistency

If `rb.replay_depth > 0` after `kn_pre_tick` returns, the return
value must equal 2 (replay frame). A return value of 0 with
`replay_depth > 0` logs `RB-INVARIANT-VIOLATION`. This is the
smallest defense-in-depth check and ships first as an insurance
policy.

### R6 — Audio/video state survives restore

Any subsystem driven by RDRAM contents (AudioWorklet, OpenAL, GL
framebuffer) must either survive `retro_unserialize` intact or be
explicitly re-initialized in the restore sequence. The rollback
path calls `kn_reset_audio()` immediately after
`retro_unserialize` (RF6 Part B) so the AudioWorklet capture buffer
doesn't starve post-replay.

### Detection events

Every violation of R1-R6 produces a loud analyzer event. Zero of
any of these events across a real session log means the integrity
invariants held.

| Event | Invariant | Spec |
|-------|-----------|------|
| `REPLAY-NORUN` | R2 | RF2 |
| `RB-INVARIANT-VIOLATION` | R5 | RF3 |
| `FATAL-RING-STALE` | R3 | RF7 |
| `RB-LIVE-MISMATCH` | R4 | RF5 |
| `AUDIO-DEATH` (enriched) | R6 diagnostic | RF6 |
```

### Task 8.5: Documentation — CLAUDE.md bullets

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the existing Netplay invariants subsection**

Run:
```bash
grep -nA5 'Netplay invariants' CLAUDE.md
```

Expected: a subsection at [CLAUDE.md:160](CLAUDE.md#L160) with a pointer to `docs/netplay-invariants.md`.

- [ ] **Step 2: Append rollback bullets**

Inside the existing Netplay invariants subsection, after whatever exists there, add:

```markdown
- **Rollback integrity** (R1-R6): the C rollback engine must produce bit-correct state or fail loudly. Dev builds throw on violation; production logs `REPLAY-NORUN`, `RB-INVARIANT-VIOLATION`, `FATAL-RING-STALE`, or `RB-LIVE-MISMATCH`. No mid-match auto-resync from these events — fix the root cause instead. See [docs/netplay-invariants.md §Rollback Integrity](docs/netplay-invariants.md).
```

### Task 8.6: Changelog + final commit

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add changelog entries**

Append a new entry at the top of `CHANGELOG.md`:

```markdown
## [Unreleased]

### Fixed
- **Rollback state integrity (RF1-RF7)**: eliminated silent state
  corruption in the C rollback engine. Seven fixes enforcing six
  new invariants (R1-R6):
  - RF1 — re-capture Emscripten rAF runner after `retro_unserialize`
    so replay frames actually step the emulator (root cause of
    B190OHFY freeze)
  - RF2 — `stepOneFrame` emits `REPLAY-NORUN` if called with null
    runner during replay; dev throws
  - RF3 — `kn_pre_tick` return-value invariant: `replay_depth > 0`
    requires `catchingUp === 2`
  - RF4 — dirty-input serialize gate enforces ring coverage across
    the rollback window
  - RF5 — post-replay live-state hash verified against ring
    (`RB-LIVE-MISMATCH` on drift)
  - RF6 — strengthened `AUDIO-DEATH` diagnostics with
    rollback-correlation and AudioWorklet state; contingent audio
    reset in rollback path if residual audio death observed
  - RF7 — `FAILED-ROLLBACK (stale)` promoted to loud
    `FATAL-RING-STALE` event; dev throws
- **Rollback integrity test harness (V1)**: new `tests/rollback/`
  directory with one Playwright regression test per RF plus a WASM
  determinism harness that would have caught RF1 on the first run.
- **Analyzer (V3)**: `tools/analyze_match.py` detects all new event
  types; `AUDIO-DEATH` now reports inferred cause via
  rollback-correlation metadata.

### Documentation
- `docs/netplay-invariants.md` §Rollback Integrity (R1-R6)
- `CLAUDE.md` rollback invariant bullets
```

- [ ] **Step 2: Final commit**

Run:
```bash
git add tools/analyze_match.py \
  build/kn_rollback/kn_rollback.c build/kn_rollback/kn_rollback.h \
  build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.c \
  build/src/mupen64plus-libretro-nx/mupen64plus-core/src/main/kn_rollback.h \
  build/output/mupen64plus_next_libretro.wasm build/output/mupen64plus_next-wasm.data \
  web/static/ejs/cores/mupen64plus_next-wasm.data \
  tests/rollback/rollback-integrity-wasm.spec.mjs \
  docs/netplay-invariants.md CLAUDE.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
feat(rollback): V1 integrity harness + V3 analyzer + docs

V1 — new kn_rollback_integrity_test helper exports
(save_baseline, restore_baseline, hash_live, seed_mispredict)
drive a single-tab determinism check through the full
kn_pre_tick/kn_post_tick pipeline. Would have caught RF1 on
the first run. Playwright driver at
tests/rollback/rollback-integrity-wasm.spec.mjs.

V3 — analyze_match.py detects REPLAY-NORUN,
RB-INVARIANT-VIOLATION, FATAL-RING-STALE, RB-LIVE-MISMATCH.
Also leaves the legacy ROLLBACK-RESTORE-CORRUPTION detection
in place for historical sessions with a note pointing readers
at RB-LIVE-MISMATCH for post-RF5 sessions.

Docs — appends §Rollback Integrity (R1-R6) to
docs/netplay-invariants.md; CLAUDE.md gets rollback
invariant bullet under the existing Netplay invariants
section; CHANGELOG.md records RF1-RF7 + harness + docs.

Spec: docs/superpowers/specs/2026-04-11-rollback-state-integrity-audit.md

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 8.7: End-to-end verification pass

- [ ] **Step 1: Run every regression test in order**

Run:
```bash
for t in tests/rollback/rf{3,2,1,4,7,5}-*.spec.mjs tests/rollback/rollback-integrity-wasm.spec.mjs; do
  echo "=== $t ==="
  node "$t" || { echo "REGRESSION: $t failed"; exit 1; }
done
```

Expected: every test prints a PASS line.

- [ ] **Step 2: Run a real two-tab rollback scenario**

Use `tests/rollback-rng-test.mjs` or a manual two-tab setup. Afterwards:

```bash
cd server && uv run python ../tools/analyze_match.py --room <latest-room> 2>&1 | grep -E 'REPLAY-NORUN|RB-INVARIANT|FATAL-RING|RB-LIVE-MISMATCH|AUDIO-DEATH|ROLLBACK-RESTORE-CORRUPTION'
```

Expected: zero events. If any appear, the fix did not fully land and diagnosis starts with the reported event name (each maps back to its RF via the event table in `docs/netplay-invariants.md`).

- [ ] **Step 3: User review before deploy**

Per `feedback_no_deploy_without_testing.md`, STOP here and report to the user:

- Number of regression tests passed
- Analyzer output from the two-tab session
- Any residual events (should be zero)
- Size of final commit series (expected: 8 commits = RF3 + RF2 + RF1 + RF4 + RF7 + RF5 + RF6-Part-A + (optionally RF6-Part-B) + harness/analyzer/docs)

Wait for explicit user approval before `just deploy` or any production push.

---

*Plan complete. Total: 8 chunks, 8 tasks per RF average, all Playwright-verified.*

