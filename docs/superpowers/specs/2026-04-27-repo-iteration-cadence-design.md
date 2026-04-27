# kaillera-next Repo-Wide Iteration Cadence — Design

**Date:** 2026-04-27
**Status:** Design
**Companion spec:** [`2026-04-27-smash64r-multi-model-team-design.md`](2026-04-27-smash64r-multi-model-team-design.md) — same `docs/team/` protocol, broader scope.

## What this spec IS and IS NOT

**IS:** the team composition, role assignments, cadence, and coordination protocol for **repo-wide iteration** on kaillera-next — the recurring PM and UX work that turns project signal (session logs, feedback, recent commits, memory) into prioritized engineering work and design fixes.

**IS NOT:** the engineering execution of any specific feature. PM/UX outputs surface backlog items; those items become engineering briefs that flow into the same `docs/team/` system the smash64r spec defines. PM/UX produce *queues for engineering*, not patches.

This spec also does NOT cover smash64r-specific work — that's the companion spec's lane. smash64r is *one* project on the kaillera-next roadmap; this spec covers the roadmap-level rhythm that decides what to do next, including whether smash64r remains the priority.

## Problem Statement

PM and UX work on kaillera-next has been ad-hoc — addressed when something breaks or a launch deadline forces it, not on a regular cadence. Signal exists (session logs at the admin API, `feedback.js` submissions, recent commits, project memories, competitor moves), but synthesis is irregular, so prioritization decisions are made under pressure with incomplete context.

The team built for smash64r (Codex, DeepSeek, Claude reviewing) is engineering-only. Adding strategic-PM and design-critic roles would dilute it, because those roles need *behavioral* properties (decisiveness, commitment to opinions) that Claude is explicitly trained against. The right shape is **separate scheduled tracks** — PM and UX run on their own cadence, with their own model assignments, producing artifacts that engineering then consumes.

## Goal

A predictable iteration rhythm where:
- PM signal gets synthesized weekly into a prioritized backlog with rationale.
- UX surface gets audited biweekly against a design system, producing concrete fixes.
- Outputs flow into the existing `docs/team/` brief-and-shell pipeline so engineering work has clear provenance.
- Strategic orchestration stays with the user; PM/UX are advisors that produce work queues, not autonomous decision-makers.

## Non-Goals

- **Replacing the user as decision-maker.** The PM model recommends; the user accepts, adjusts, or rejects.
- **Automating engineering execution.** PM/UX outputs become briefs; the engineering team (Codex / DeepSeek / Claude review) still does the actual work through the existing protocol.
- **Continuous monitoring / on-call alerting.** This is iteration cadence, not incident response.
- **Smash64r-specific scoping.** That's the companion spec.
- **Pinning the PM/UX model now.** Initial assignment is GPT-5 *pending bake-off* — see "Bake-Off Test" below.

## Definition of Done (for the cadence system, not the project)

The iteration system ships when **all four** hold:

1. A scheduled job runs the PM weekly review every week and lands its output at `docs/pm/weekly-YYYY-WW.md` without manual intervention.
2. A scheduled job runs the UX audit every two weeks and lands its output at `docs/ux/audits/YYYY-MM-DD.md` without manual intervention.
3. The first PM review and the first UX audit have each run through cross-review (Claude scope/safety pass + Codex technical-feasibility pass) before being treated as actionable.
4. At least one backlog item from the first PM review has been turned into a `docs/team/briefs/` engineering brief and dispatched, proving the PM-to-engineering handoff works end-to-end.

Determinism, R1-R6 rollback integrity, and existing kaillera-next invariants are **not** in scope for this spec but must not be regressed by anything PM/UX surfaces.

## Team

| Role | Model | Why this behavioral fit |
|------|-------|------------------------|
| Strategic orchestrator | **You** | Decides cadence, accepts/rejects backlogs, kicks off cycles. The team is your force multiplier, not your replacement. |
| Weekly PM review | **OpenAI `gpt-5.5`** *(initial; pending bake-off)* | Hypothesis (not asserted as fact): OpenAI's RLHF/instruction-tuning emphasis appears to produce more decisive recommendations and less hedging than Claude's training does, which would fit a PM voice that needs to commit to a call instead of enumerating trade-offs. The bake-off below tests this hypothesis on real PM output before locking the assignment. Model ID per OpenAI's current docs (https://developers.openai.com/api/docs/models). |
| Biweekly UX critic | **OpenAI `gpt-5.5`** *(initial; pending bake-off)* | Same hypothesis. Multimodal vision (`image_url` content type on Chat Completions) required for screenshot critique. To be confirmed by bake-off. |
| Reviewer + scope/safety gate + spec writer + determinism gatekeeper | **Claude Opus** | Pushback and calibration are the deliverable. Reviews PM backlog for scope/safety/feasibility-against-determinism; reviews UX recommendations for design-system consistency and accessibility. |
| Engineering review of PM/UX action items | **Codex (GPT-5 Codex)** | Catches code-correctness issues PM/UX models miss when they propose technical fixes. Reviews PM-recommended backlog items and UX-proposed code patches for technical feasibility. (Validated as cross-reviewer of Claude's spec output — see smash64r decision file.) |
| Long-context monthly sweep *(optional, on demand)* | **Gemini 2.5 Pro** | 1M context can ingest a month of session logs + full memory dir + recent commit history in one shot for a deeper retrospective. Not on the regular cadence; activated for month-end or quarter-end reviews. |
| Engineering execution of dispatched briefs | Codex + DeepSeek-reasoner | Same engineering team as the smash64r spec. PM/UX briefs flow into `docs/team/briefs/` and dispatch through the same protocol. |

### Bake-Off Test (precedes locking PM/UX model assignment)

Before treating GPT-5 as the durable PM/UX choice, the **first weekly PM run** and the **first biweekly UX audit** are dispatched in parallel to multiple candidate models. The user reads the outputs and picks the one they would actually act on. The spec is then updated with the chosen model.

**PM bake-off candidates:** OpenAI `gpt-5.5`, Google `gemini-2.5-pro`, xAI `grok-4.20` (if user has xAI access). Pin exact model IDs in the bake-off dispatch — naming evolves, and "GPT-5" / "Grok 4" without a version suffix become wrong fast.
**UX bake-off candidates:** `gpt-5.5`, `gemini-2.5-pro`, Claude Sonnet (with explicit anti-hedging system prompt — to test whether prompt-level fixes give you what you want before paying for behavioral diversification).

Bake-off outputs land at `docs/pm/bake-off-YYYY-MM-DD/<model>.md` and `docs/ux/bake-off-YYYY-MM-DD/<model>.md`. Decision recorded at `docs/team/decisions/<bake-off-task-id>.md`.

## Cadence

### Weekly PM Review

**When:** Every Monday morning, scheduled via the `/schedule` skill (cron-driven remote agent).

**Inputs (auto-fetched at run time, in this order):**
1. Session logs from `kaillera-next.thesuperhuman.us/admin/...` — last 7 days. Admin API key from `.env` per `reference_admin_api.md`.
2. `feedback.js` submissions — POSTed to public `/api/feedback` ([web/static/feedback.js:301](web/static/feedback.js#L301), [server/src/api/app.py:887](server/src/api/app.py#L887)); admin-only listing/reading at [server/src/api/app.py:1362](server/src/api/app.py#L1362).
3. `git log --since='7 days ago' --oneline main` plus `gh pr list --state all --limit 30 --json number,title,state,labels` for open + recently-merged PRs.
4. `MEMORY.md` index + the active `project_*.md` memory files (read by the scheduled agent at run time).
5. One pass through `/product-management:gaps` if available (already-installed plugin) for fresh signal.

**Task:** Synthesize the inputs into a top-3-to-5 prioritized backlog with rationale, blockers, effort estimate. Items that survive 3 consecutive weeks unaddressed get escalated with a "stale" flag.

**Output:** `docs/pm/weekly-YYYY-WW.md`, structured as:

```markdown
# Week YYYY-WW PM Review

## Top priorities (3-5 items)
1. <item> — rationale — blockers — effort
2. ...

## Stale items (3+ weeks without action)
- ...

## Signal summary
- Session log themes: ...
- Feedback themes: ...
- Recent commit pattern: ...
- Competitor / external: ...

## Recommendations for engineering brief filing
- Item 1 → docs/team/briefs/<task-id>.md (Claude reviews scope first)
- Item 2 → GitHub Issue (Claude doesn't need to gate this one, it's small)
```

**Handoff:** items that need engineering work get filed to `docs/team/briefs/` (after a Claude scope/safety pass). Items that are GitHub-Issue-sized go via `/product-management:file`.

### Biweekly UX Audit

**When:** Every other Tuesday, scheduled via `/schedule`.

**Inputs:**
1. Spin up local dev server.
2. Walk the user-facing surface via Playwright: `index.html` (lobby) → create room → `play.html` (single-player + 2P + spectate paths) → `admin.html` → `error.html`.
3. Take screenshots at each step in **mobile (390×844)** and **desktop (1440×900)** viewports.
4. Cross-reference against the project's design system if codified, or against `interface-design:audit` heuristics.

**Task:** Identify design-system violations, inconsistencies, mobile issues, accessibility concerns. Each finding has file:line citation and a concrete proposed fix.

**Output:** `docs/ux/audits/YYYY-MM-DD.md`, structured as:

```markdown
# UX Audit YYYY-MM-DD

## Findings (severity-ranked)
1. [severity: high/med/low] [path/to/file.html or .js:line] — what's wrong — proposed fix — visual evidence (screenshot path)
2. ...

## Mobile-specific
- ...

## Accessibility
- ...

## Recommendations for engineering brief filing
- Finding N → docs/team/briefs/<task-id>.md
```

**Handoff:** findings that touch code get filed as engineering briefs (after Claude design-consistency review and Codex technical-feasibility review). Findings that are pure visual (color, spacing, copy) can become Issues directly.

### Optional Monthly Long-Context Sweep

**When:** Last Friday of each month, manually invoked by user (not auto-scheduled).

**Model:** Gemini 2.5 Pro (1M context).

**Task:** Ingest the entire month's session logs + full memory directory + commit history + open Issues + competitor research. Produce a retrospective: "what theme dominated this month, what got dropped, what's drifting, what's the recommended pivot for next month."

**Output:** `docs/pm/monthly-retro-YYYY-MM.md`. Not actioned automatically — user reads, decides what to act on.

## Coordination Protocol

The repo-iteration tracks share the smash64r `docs/team/` infrastructure. New paths added by this spec:

```
docs/pm/
├── weekly-YYYY-WW.md          # weekly PM review output
├── monthly-retro-YYYY-MM.md   # optional Gemini long-context sweep
└── bake-off-YYYY-MM-DD/<model>.md  # PM bake-off outputs

docs/ux/
├── audits/YYYY-MM-DD.md       # biweekly UX audit output
└── bake-off-YYYY-MM-DD/<model>.md  # UX bake-off outputs

docs/team/
├── briefs/, outputs/, decisions/  # shared with smash64r spec
```

### Cross-review rules (extending the smash64r protocol)

- **PM weekly outputs** get a Claude scope/safety pass before any backlog item is filed for engineering. Claude rejects items that conflict with determinism / R1-R6 / known scope discipline. Codex reviews any backlog item that proposes a technical change for feasibility before it becomes a brief.
- **UX audit outputs** get a Claude pass for design-system consistency and accessibility, plus a Codex pass for any code-touching fix recommendation. Both reviews are recorded in a `decisions/<audit-id>.md` file in the same `docs/team/decisions/` tree.
- **Spec/doc artifacts Claude writes** (including PM weekly output's structure, this spec, etc.) get a Codex review pass before final per the smash64r-spec failure mode about Claude-reviewer blind spots — different training origins catch different issues.
- The `Team-Task:` Git footer applies to commits coming out of PM/UX-surfaced work, same as the smash64r protocol.

### Dispatch flow (PM-specific additions)

PM and UX dispatch use the same brief-and-shell pattern as the smash64r spec. Differences:

- **OpenAI dispatch** (for `gpt-5.5`): `Bash` tool with inline `curl` POST to `https://api.openai.com/v1/chat/completions`. Requires `OPENAI_API_KEY` in `.env` — **bootstrap required**, the key is not currently present (see Bootstrap Requirements below; current `.env` only has `DEEPSEEK_API_KEY` per the 2026-04-27 Codex review). Response captured to `docs/team/outputs/<task>.gpt5.md`. Vision handled via the `image_url` content type on Chat Completions for UX screenshots; the alternative Responses API uses `input_image` (pin the choice in writing-plans).
- **Gemini dispatch** (for monthly sweep): `Bash` tool with `curl` to Google Generative Language API. Requires `GOOGLE_API_KEY` in `.env` — **bootstrap required**, not currently present. Model ID `gemini-2.5-pro` (max input ≈1,048,576 tokens). For monthly sweeps where the corpus may exceed the window: helper performs token counting (use Google's count-tokens endpoint or `tiktoken`-style estimator), chunks into multiple calls, and merges. The phrase "single-shot ingestion of a full month" is aspirational — falls back to chunking when budget is exceeded.
- **xAI dispatch** (only if Grok appears in bake-off): `curl` to xAI API with model `grok-4.20`. Requires `XAI_API_KEY` in `.env` — **bootstrap required**, not currently present. Skipped entirely if user opts out of Grok in the bake-off.
- **Scheduled-agent dispatch:** the `/schedule` agent IS itself a Claude session, but it shells out to whichever non-Claude model is assigned to the role per the brief, using the same protocol as an interactive Claude session. Same protocol, different invocation context.

## Bootstrap Requirements

The cadence cannot start running until these are in place. Writing-plans owns turning each into a concrete task.

| What | Where | Status (2026-04-27) | Why |
|------|-------|---------------------|-----|
| `OPENAI_API_KEY` | `.env` | **missing** — only `DEEPSEEK_API_KEY` present per Codex review | Required for PM/UX dispatch. |
| `GOOGLE_API_KEY` | `.env` | **missing** | Required for monthly Gemini sweep. Optional if user skips monthly sweep. |
| `XAI_API_KEY` | `.env` | **missing** | Required only if Grok appears in PM bake-off. Optional. |
| `.env.example` | repo root | **missing** | Onboarding hygiene; document required keys without committing values. |
| `.pm/product/inventory.md` + `.pm/competitors/*.md` | repo root | **missing** | Required by `/product-management:gaps` (per its command spec). PM weekly should `/product-management:analyze` first to bootstrap the inventory. |
| `.pm/gaps/*.md` | repo root | created by `/product-management:gaps` | Required by `/product-management:file` for issue creation. |
| `.interface-design/system.md` | repo root | **missing** | Required by `/interface-design:audit` — it is **not** a fallback heuristic; it audits *against an existing design system*. UX track should `/interface-design:extract` first (extracts a system from existing code) or `/interface-design:init` (defines one) before any audits run. |
| Scheduled-agent capability | `/schedule` skill | already installed | Used to drive weekly + biweekly cadence. |
| Secret hygiene | `~/.claude/projects/-Users-kazon-kaillera-next/memory/reference_admin_api.md` | **literal prod admin key value embedded in memory file** per Codex review | Rotate the key, replace the memory entry with a pointer to `.env`. Independent of this spec but flagged here because the cadence will be reading admin API and we don't want artifacts to echo it. |

## Failure Modes

Inheriting all smash64r-spec failure modes plus:

| Mode | Detection | Response |
|------|-----------|----------|
| Scheduled job didn't run | No `weekly-YYYY-WW.md` or `audits/YYYY-MM-DD.md` exists past expected date | Surface to user. Diagnose `/schedule` (cron mis-config, auth expired, env var missing). Don't auto-retry — risk of double-runs polluting the queue. |
| Scheduled job ran twice | Two artifacts for the same week / audit date OR the same artifact has two timestamped sections | Idempotency check: each artifact filename is keyed by week-of-year / ISO date and dispatch first checks for existence. If the file exists and was written within last hour, skip and surface to user. |
| PM backlog item conflicts with determinism / R1-R6 / scope discipline | Claude review pass flags it | Reject the item. Decision file records what was rejected and why. PM model gets the rejection feedback inlined in next week's brief. |
| UX fix touches code in a way that breaks invariants | Codex review pass flags it | Reject the patch path. Re-frame the fix as visual/copy-only or escalate to engineering for proper design. |
| API auth fails (OpenAI / Gemini / xAI) | `curl` returns 401 / 403 | Scheduled agent surfaces the failure as `<artifact>.failed.md` (with redaction — see below) so user notices on next interactive session. Do not silently swap models. |
| API rate limit | `curl` returns 429 | Honor `Retry-After` header up to a reasonable cap (writing-plans defines the cap). If still rate-limited after retry, fall back to `failed.md` artifact. |
| API timeout | `curl` exceeds dispatch timeout (writing-plans defines per-model timeouts; OpenAI typically 60-120s, Gemini up to 300s for long context) | Treat as dispatch failure. Single retry, then `failed.md`. |
| Non-2xx / invalid JSON / `finish_reason ≠ stop` | Same patterns as smash64r spec failure modes | Same response: incomplete output, do not act, surface or re-dispatch with task split. |
| Token-budget overrun (Gemini monthly sweep) | Token-count step shows corpus exceeds 1M | Helper chunks corpus into multiple Gemini calls and merges; only fail if even chunked dispatch exceeds budget. |
| Secret leakage in artifact | `<task>.failed.md` or any captured output contains a value matching a `*_API_KEY` env var or admin token | Pre-commit hook redacts (replace with `<REDACTED>`) before write. If hook isn't in place, the dispatch script does its own redaction pass. Escalate to user if redaction triggered. |
| PM model produces a backlog Claude can't review without surface knowledge | Backlog item references session logs / counters / memory entries Claude wasn't shown | Brief the next dispatch with the missing context inlined. Don't approve items based on incomplete review. |
| Bake-off candidate hallucinates project state | Output cites memory files / commits / counters that don't exist | Reject that candidate. Don't promote it from bake-off into the durable slot. |

## Open Questions (deferred to writing-plans)

These do not block this spec but should be answered when writing the implementation plan:

1. **Bake-off run mechanics.** Whether the first PM and first UX runs dispatch the candidates serially (one at a time, easier to script) or in parallel (faster, more API surface to manage). Defer to writing-plans.
2. **`/schedule` auth refresh strategy.** Scheduled remote agents need API keys long-term; rotation strategy for `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` / `GOOGLE_API_KEY` is a writing-plans / ops decision.
3. **Stale-item escalation threshold.** "3 consecutive weeks unaddressed → flagged" is a starting heuristic; tuning belongs to the writing-plans phase based on observed signal.
4. **UX design system codification.** Right now UX audits cross-reference `interface-design:audit` heuristics; whether to extract a project-specific design system doc (`docs/ux/design-system.md`) is a downstream question.

## Bake-Off Implementation Note (for writing-plans)

The bake-off is the **first task** dispatched after this spec is approved. Its outputs (in `docs/pm/bake-off-YYYY-MM-DD/` and `docs/ux/bake-off-YYYY-MM-DD/`) are what determines the durable model assignment. The user reads them, picks, and the spec is updated with the chosen model. Until then, the model entries in the Team table read "GPT-5 *(initial; pending bake-off)*" — a real placeholder, not a hidden TBD.

## Related Context

- [`2026-04-27-smash64r-multi-model-team-design.md`](2026-04-27-smash64r-multi-model-team-design.md) — companion spec; same `docs/team/` protocol; engineering execution lives there.
- Memory: `project_launch_readiness_plan.md` — the active P0/P1/P2/P3 work items audit from 2026-04-07; first PM weekly review should consume this as input.
- Memory: `project_session_timeline_vision.md`, `project_ui_iteration_tooling.md`, `project_public_readiness_concerns.md` — adjacent UX/PM signal already captured.
- Memory: `feedback_dont_overhedge.md`, `feedback_keep_simple.md` — explain why behavioral diversification matters for PM/UX roles.
- `reference_admin_api.md` — admin API endpoints + key location, used by the PM agent for session-log ingestion.
