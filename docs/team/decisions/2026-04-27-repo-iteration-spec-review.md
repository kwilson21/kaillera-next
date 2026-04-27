# 2026-04-27-repo-iteration-spec-review — Decision

**Output reviewed:** `docs/team/outputs/2026-04-27-repo-iteration-spec-review.codex.md`
**Verdict:** applied (analysis task — no code patch; spec edits applied per findings)
**Diff hash:** see commit message of the spec-fix commit
**Codex sandbox mode:** `--sandbox danger-full-access` (web access enabled per the new policy from the smash64r decision)

## Verification evidence

Each Codex finding was independently sanity-checked. With web access enabled, Codex provided URL citations for external API claims, which is a marked improvement over the sandboxed pass.

Verified by Codex (with URL):
- OpenAI `/v1/chat/completions` — verified
- OpenAI vision via `image_url` content type — verified for Chat Completions
- Current OpenAI flagship: `gpt-5.5` (gpt-5 is previous-gen) — flagged
- Gemini 2.5 Pro: 1,048,576 token max input — verified
- xAI: current model `grok-4.20` — flagged for naming evolution

Verified by Codex against the local repo:
- Admin session-log endpoints at `server/src/api/app.py:956,1015`
- Public feedback endpoint at `web/static/feedback.js:301` and `server/src/api/app.py:887`
- `/product-management:gaps` requires `.pm/product/inventory.md` + `.pm/competitors/*.md` (per its command spec)
- `/interface-design:audit` requires a design system to already exist (not a fallback heuristic)
- `.env` only contains `DEEPSEEK_API_KEY` (and admin/redis/etc.); no OpenAI / Google / xAI keys

## Findings acted on (13)

1. **Spec assumed `OPENAI_API_KEY` is in `.env`** — Codex confirmed it is not. Added Bootstrap Requirements section listing all missing env vars with their target use.
2. **`GOOGLE_API_KEY` not in `.env`** — same. Added to bootstrap.
3. **`XAI_API_KEY` not in `.env`** — same. Added to bootstrap as optional (only needed if Grok in bake-off).
4. **GPT-5 stale model name** — pinned to `gpt-5.5` per OpenAI's current docs URL. Added note that pinning exact IDs at bake-off time is required because naming evolves.
5. **Grok 4 stale** — pinned to `grok-4.20`.
6. **Feedback endpoint wrong** — corrected to `/api/feedback` (public POST), with admin-only listing at the right line.
7. **`/product-management:gaps` requires `.pm/` directory** — added bootstrap requirement; PM weekly should `/product-management:analyze` first.
8. **`/product-management:file` requires `.pm/gaps/*.md`** — added.
9. **`/interface-design:audit` requires a design system** — flagged that this is **not** a fallback heuristic. Added bootstrap requirement for `.interface-design/system.md` via `/interface-design:extract` or `/interface-design:init`.
10. **Gemini "without truncation" overclaim** — softened to acknowledge token-budget chunking; helper performs token-count first and chunks if corpus exceeds the 1M cap.
11. **Behavioral claim "OpenAI's training tilts toward decisive recommendations" too strong** — reframed as a hypothesis to test, with bake-off as the validation mechanism.
12. **Failure modes incomplete** — added: idempotency for duplicate scheduled runs, rate-limit handling with `Retry-After`, timeout-per-model, token-budget overrun on Gemini monthly sweep, secret leakage in artifacts.
13. **Secret-redaction failure mode** — added explicit redaction pass before any `failed.md` artifact is written, since dispatch scripts may otherwise echo env vars.

## Findings flagged separately to user (out of spec scope)

- **`reference_admin_api.md` contains a literal prod admin key value.** This is a memory-file hygiene issue, not a spec issue. Action recommended: rotate the prod admin key, then replace the memory entry with a pointer to `.env`. Independent of this spec; user decides whether to act now or later.

## Cross-review pattern validation (round 2)

The repo-iteration spec was a fresh write (not a revision of a previously-reviewed spec). Codex's first-pass review (with `--sandbox danger-full-access`) caught **13 substantive issues** including environmental assumptions (missing API keys), stale external model names, plugin bootstrap requirements, and an actual security flag in the user's memory. None of these would have been caught by a Claude-based reviewer that doesn't run shell commands or fetch external URLs.

The pattern continues to validate: **Codex with web access is a stronger spec reviewer than Claude-based subagents** for any spec that touches external services or local plugin contracts. For specs that are purely architectural (no external API claims, no plugin contracts), Claude-based review remains useful for scope/safety/clarity passes.

## Follow-ups

- Bootstrap tasks (env keys, `.pm/`, `.interface-design/`, secret rotation) become writing-plans inputs.
- The first PM bake-off and first UX bake-off cannot dispatch until at least `OPENAI_API_KEY` is in `.env`.
- The Gemini monthly sweep is gated on `GOOGLE_API_KEY` and on the user opting into it (it's optional).
