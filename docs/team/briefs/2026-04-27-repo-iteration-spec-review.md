# 2026-04-27-repo-iteration-spec-review

## Goal
Identify factual, technical, and consistency issues in the repo-iteration cadence design spec before it's used to generate the implementation plan. Especially flag claims about external services (OpenAI / Gemini / xAI APIs) that are unverified or wrong, and any claims about local plugins, scripts, or paths that don't actually exist in the repo.

## Files in scope
- `docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md` (spec under review — primary target)
- `docs/superpowers/specs/2026-04-27-smash64r-multi-model-team-design.md` (companion spec; verify cross-references match)
- `.env` and `.env.example` (verify which env vars exist; do NOT print actual key values)
- `CLAUDE.md` (project conventions)
- `web/static/feedback.js` (verify feedback submission path)
- `server/src/api/` (verify admin API surface for session logs)
- `.gitignore` (verify what's actually ignored)
- The user's `~/.claude/projects/-Users-kazon-kaillera-next/memory/MEMORY.md` if available — do NOT modify; verify the cross-referenced memory files exist

## Constraints
- Do NOT make any file modifications. This is a review pass; output analysis only.
- Cite specific file:line for every issue you flag.
- For external API claims (OpenAI endpoint URL, Gemini context window, xAI Grok availability), verify via web — `--sandbox danger-full-access` was set on this dispatch specifically so you can do that. If you can't verify, say so explicitly rather than fabricating a citation.
- Distinguish factual errors from style preferences.

## Task
Cross-check the spec against:

1. **External API claims:**
   - OpenAI endpoint `https://api.openai.com/v1/chat/completions` — correct?
   - Vision support via `image_url` content type — correct, or has the API moved on?
   - Gemini's 1M context-window claim for 2.5 Pro — verified?
   - GPT-5 availability — is GPT-5 actually a current OpenAI model name as of 2026-04-27, or has the naming evolved?
   - Grok 4 availability and API surface (xAI) — only flag if you can verify; otherwise note unverified.

2. **Local repo claims:**
   - `feedback.js` exists at `web/static/feedback.js` — is the submission path / endpoint accurate?
   - Admin API for session-log ingestion — does the surface described actually exist on the server? Cite the route file:line.
   - `/product-management:gaps`, `/product-management:file`, `interface-design:audit` — these are referenced as installed plugins; verify they're actually available (look at `~/.claude/plugins/` or equivalent).
   - Memory file references (`project_launch_readiness_plan.md`, `project_session_timeline_vision.md`, `project_ui_iteration_tooling.md`, etc.) — do they exist in `~/.claude/projects/-Users-kazon-kaillera-next/memory/`?
   - `reference_admin_api.md` reference — does it exist?

3. **Internal consistency:**
   - Cross-references to the smash64r spec — accurate?
   - File paths under `docs/pm/`, `docs/ux/`, `docs/team/` — internally consistent?
   - The bake-off bake-off implementation note — does it have a clear handoff to writing-plans?

4. **Failure modes coverage:**
   - Given the dispatch flow (scheduled `/schedule` agents calling out to GPT-5 / Gemini / Codex), what failure modes are missing?

5. **Behavioral fit claims:**
   - The spec asserts OpenAI's training "tilts toward decisive recommendations" — flag this as an unprovable behavioral claim if you think it's overconfident, or accept it as reasonable extrapolation. Your call.

## Acceptance criteria
N/A — review task.

## Output format

`analysis`

```markdown
## Issues
1. [file:line in spec] — what's wrong — evidence — why it matters
2. ...

## Verifications
- [each citation in the spec you actually verified, with how you verified it]

## External-API verifications (specifically called out)
- OpenAI endpoint: <verified / unverified / wrong> — evidence
- GPT-5 model name: <verified / unverified / wrong> — evidence
- Gemini 2.5 Pro 1M context: <verified / unverified / wrong> — evidence
- Grok 4 availability: <verified / unverified / unknown>

## Suggestions (advisory)
- ...
```

Be terse. Cite file:line for every claim.
