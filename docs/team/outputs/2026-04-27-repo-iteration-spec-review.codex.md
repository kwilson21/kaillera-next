analysis

```markdown
## Issues
1. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:181 — `OPENAI_API_KEY` is claimed present in `.env`, but `.env:1-8` only defines admin/Redis/Tailscale/debug/TURN/prod-admin/DeepSeek vars; no `OPENAI_API_KEY`. `.env.example` is absent. This blocks GPT dispatch as written.

2. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:182 — same problem for `GOOGLE_API_KEY`: not in `.env:1-8`, and no `.env.example` exists. Gemini dispatch cannot be implemented from current repo config.

3. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:53 — “GPT-5” is a stale/underspecified OpenAI choice. OpenAI docs list `gpt-5` as a previous model and currently recommend `gpt-5.5`; exact API model IDs should be pinned before bake-off.

4. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:64 — Grok is a bake-off candidate, but dispatch only defines OpenAI/Gemini paths at docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:181-182. xAI docs currently recommend `grok-4.20`; no `XAI_API_KEY` appears in `.env:1-8`.

5. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:77 — “feedback.js submissions (HTTPS endpoint defined in admin API)” is inaccurate. The frontend posts to public `/api/feedback` at web/static/feedback.js:301; server accepts it at server/src/api/app.py:887. Admin only lists/reads feedback at server/src/api/app.py:1362 and server/src/api/app.py:1393.

6. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:80 — `/product-management:gaps` exists, but current repo lacks the `.pm/` setup it requires. The command requires `.pm/product/inventory.md` and `.pm/competitors/*.md` at /Users/kazon/.claude/plugins/marketplaces/ccc/plugins/product-management/commands/gaps.md:12-17.

7. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:107 — `/product-management:file` exists, but it requires latest `.pm/gaps/*.md` at /Users/kazon/.claude/plugins/marketplaces/ccc/plugins/product-management/commands/file.md:19-21. No `.pm/` directory exists, so this handoff will fail without bootstrap.

8. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:117 — `interface-design:audit` is not a fallback heuristic audit when no design system exists. Its command says “No design system to audit against” and suggests creating/extracting one at /Users/kazon/.claude/plugins/marketplaces/interface-design/.claude/commands/audit.md:53-61. No `.interface-design/` directory exists.

9. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:182 — “without truncation” overclaims Gemini monthly sweep ingestion. Gemini 2.5 Pro has 1,048,576 max input tokens and 500 MB input size limits; month logs + full memory + commits can exceed that, so token counting/chunking is required.

10. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:185-197 — failure modes cover auth but miss non-2xx responses, rate limits, timeouts, invalid JSON, truncated output, `finish_reason`/incomplete output, and output parse failures for OpenAI/Gemini/xAI.

11. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:41-44 — fixed output paths need duplicate-run/partial-write/idempotency handling. Current failure table only handles “job didn’t run” at docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:191.

12. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:181-194 — inline `curl` with secrets plus `.failed.md` artifacts lacks a secret-redaction failure mode. `reference_admin_api.md:10` contains a literal prod admin key value, so generated artifacts must avoid echoing env/key material.

13. docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:53-54 — “OpenAI's training tilts toward decisive recommendations” is an unprovable behavioral claim. The bake-off makes it acceptable as a hypothesis, but the spec should not state it as fact.

## Verifications
- docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:76 — admin session log list/detail exist: server/src/api/app.py:956, server/src/api/app.py:1015. Ingestion is public `/api/session-log` plus Socket.IO, not admin: server/src/api/app.py:750, server/src/api/signaling.py:1311.
- docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:77 — feedback path verified with caveat above: web/static/feedback.js:301, server/src/api/app.py:887, server/src/api/app.py:1362.
- docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:80,107 — `product-management` installed at /Users/kazon/.claude/plugins/installed_plugins.json:170 and commands exist.
- docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:117 — `interface-design` installed at /Users/kazon/.claude/plugins/installed_plugins.json:300 and `audit` command exists.
- docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:214-217 — referenced memory files exist; MEMORY index references them at MEMORY.md:75,90,101,153-156.
- docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:154-168 — `docs/team/{briefs,outputs,decisions}` exists; `docs/pm` and `docs/ux` do not yet exist, which is consistent with “new paths added.”
- docs/superpowers/specs/2026-04-27-repo-iteration-cadence-design.md:207-209 — bake-off handoff to writing-plans is clear enough.

## External-API verifications (specifically called out)
- OpenAI endpoint: verified — Chat API lists `POST /chat/completions`; GPT-5 model docs list `v1/chat/completions`. Source: https://developers.openai.com/api/reference/resources/chat
- Vision via `image_url`: verified for Chat Completions — source shows `type: "image_url"` content parts. Responses API uses `type: "input_image"`. Sources: https://developers.openai.com/api/reference/resources/chat and https://developers.openai.com/api/docs/guides/images-vision
- GPT-5 model name: verified but stale — `gpt-5` exists as previous model; current docs recommend `gpt-5.5`. Source: https://developers.openai.com/api/docs/models
- Gemini 2.5 Pro 1M context: verified — max input tokens `1,048,576`; model ID `gemini-2.5-pro`. Source: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/2-5-pro
- Grok 4 availability: verified — xAI docs recommend `grok-4.20`; availability can vary by account. Source: https://docs.x.ai/developers/models

## Suggestions (advisory)
- Add explicit bootstrap tasks for `.env.example`, OpenAI/Google/xAI keys, `.pm/`, and `.interface-design/system.md`.
- Use exact API model IDs in the bake-off matrix.
- Add redaction, idempotency, token-budget, retry/backoff, parse-validation, and partial-artifact failure modes before writing the implementation plan.
```