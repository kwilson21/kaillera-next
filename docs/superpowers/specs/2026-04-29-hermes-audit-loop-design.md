# Replace `/audit-loop` with a Hermes-orchestrated nightly audit

**Status:** Draft
**Date:** 2026-04-29
**Author:** Kazon Wilson (with Claude)

## Summary

Replace the current `/audit-loop` launchd job (Claude Code skill running on a daily schedule) with a Hermes Agent profile that orchestrates the same flow: a nightly tech-debt audit of `kaillera-next`, with a two-model consensus gate, that opens a draft PR only when both models endorse the proposed fix.

This is an engine swap, not a feature change. The audit's behavior, output, and gating semantics stay the same. The win is putting the workflow on a persistent agent runtime (Hermes) so future automations (recurring sync-log triage, alert response) can compose with it cleanly, and so the agent's own skill memory can refine the Phase 1 skip heuristic over time.

## Goals

- Replace the current `/audit-loop` schedule with a Hermes-driven equivalent that produces the same draft-PR outcome on the same daily cadence.
- Preserve the two-model consensus gate (Codex primary, Claude Opus 4.7 reviewer).
- Keep rollback to the existing `/audit-loop` job to a one-line operation.
- Establish a Hermes profile pattern we can reuse for future agents (sync-log triage, alert response).

## Non-goals

- Notifications (Slack, Mac push, email digest). The PR email from GitHub is the signal; skip days are silent.
- Multi-repo support. Just `kaillera-next` for now.
- Always-on infra. Stays on the Mac via launchd; "runs while you sleep" is sacrificed for prove-it simplicity.
- Hermes web UI / dashboard.
- Auto-merge. PRs remain draft, reviewed by the user manually.

## Design

### Architecture

```
launchd (4am local, daily)
   │
   ▼
hermes run --profile kn-audit
   │
   ▼
audit.sh (orchestration script invoked by Hermes skill)
   │
   ├─ Phase 1: Skip checks
   │     ├─ git fetch
   │     ├─ git log --since=24h (anything new?)
   │     └─ gh pr list --search "is:open author:@me draft" (already open audit PR?)
   │
   ├─ Phase 2: Codex audit
   │     └─ codex exec "<audit prompt>" → captures unified diff + rationale
   │
   ├─ Phase 3: Claude review
   │     └─ claude -p "<review prompt with diff>" → endorse | reject | abstain
   │
   └─ Phase 4: PR (only on consensus endorse)
         └─ gh pr create --draft --title ... --body ...

Hermes skill memory (~/.hermes/profiles/kn-audit/memory/)
   ├─ run log (timestamp, skip reason or PR #)
   ├─ skill memory ("rollback area clean for N consecutive runs")
   └─ accumulated audit patterns
```

### Components

**Hermes profile: `kn-audit`**
- Lives at `~/.hermes/profiles/kn-audit/`
- Config: `config.toml` (model selection, working directory, skill paths)
- Persistent memory dir under the profile, not symlinked from elsewhere
- Working directory pinned to `/Users/kazon/kaillera-next`

**Orchestration script: `audit.sh`**
- A shell script invoked as a Hermes skill (Hermes calls it as a tool)
- Implements Phases 1–4 above
- Exits 0 on every terminal state (skip, reject, PR opened) — no false-failure noise in launchd logs
- Logs structured events to `~/.hermes/profiles/kn-audit/logs/$(date +%Y-%m-%d).jsonl`
- Stored in repo at `scripts/hermes-kn-audit/audit.sh` so it's versioned

**Audit prompt: `audit-prompt.md`**
- The Codex-facing prompt that defines what "tech debt" means in this repo
- Ported from the current `/audit-loop` skill; refined as we observe Hermes behavior
- Stored at `scripts/hermes-kn-audit/audit-prompt.md`

**Review prompt: `review-prompt.md`**
- The Claude-facing prompt: read the proposed diff, return `ENDORSE` / `REJECT` / `ABSTAIN` with one-line rationale
- Stored at `scripts/hermes-kn-audit/review-prompt.md`

**launchd plist: `com.kazon.hermes-kn-audit.plist`**
- New plist at `~/Library/LaunchAgents/com.kazon.hermes-kn-audit.plist`
- Schedule: `StartCalendarInterval` daily at 04:00 local
- `StandardErrorPath` and `StandardOutPath` to `~/.hermes/profiles/kn-audit/logs/launchd.log`
- Existing `/audit-loop` plist is renamed to `.disabled` (kept on disk for fast rollback)

### Data flow

1. launchd fires at 04:00 local time.
2. launchd invokes `hermes run --profile kn-audit --task daily-audit`.
3. Hermes loads the profile (incl. accumulated skill memory), invokes `audit.sh` as a skill.
4. `audit.sh` runs Phase 1 skip checks. On skip, writes a log entry, exits 0. Hermes records the skip in skill memory.
5. On no-skip, `audit.sh` runs Phase 2 (Codex). Captures stdout (diff) and exit code.
6. If Codex returns no diff, that's also a skip (record + exit 0).
7. If Codex returns a diff, Phase 3 invokes Claude (`claude -p`) with the diff and a structured review prompt. Captures verdict.
8. If verdict is `ENDORSE`, Phase 4 runs `gh pr create --draft` with the diff applied to a feature branch. Otherwise exits 0 with reason logged.
9. Hermes records the run outcome (PR #, reject reason, or skip reason) in skill memory for future Phase 1 heuristics.

### Auth and secrets

Reuses existing local credentials:
- `gh auth status` — already authed for kaillera-next repo
- `OPENAI_API_KEY` — already in shell env (used by `codex` CLI)
- `ANTHROPIC_API_KEY` — already in shell env (used by `claude` CLI)

No new credential setup. launchd inherits the user's environment via `EnvironmentVariables` keys in the plist (or sources `~/.zshenv` in a wrapper if cleaner — TBD during implementation).

### Failure modes and rollback

**If Hermes itself fails to install or load the profile:** the launchd job exits non-zero, launchd logs it, no PR. No effect on the live game / prod.

**If `codex` or `claude` CLI is missing or unauthed:** `audit.sh` detects in a preflight check and exits 0 with a logged "preflight-failed" reason. No false-positive PRs.

**If the audit produces a diff that breaks the build:** the draft PR is opened (consensus said yes), but it's draft and not auto-merged. User reviews before merge — same as today's `/audit-loop` flow.

**Rollback to current `/audit-loop`:**
```bash
launchctl unload ~/Library/LaunchAgents/com.kazon.hermes-kn-audit.plist
mv ~/Library/LaunchAgents/com.kazon.audit-loop.plist.disabled ~/Library/LaunchAgents/com.kazon.audit-loop.plist
launchctl load ~/Library/LaunchAgents/com.kazon.audit-loop.plist
```

Two-step revert. The Hermes profile dir and scripts can stay on disk indefinitely without effect.

### Testing

- **Dry-run mode:** `audit.sh --dry-run` runs all phases except Phase 4 (`gh pr create`). Used to verify integration end-to-end without spamming PRs. Run manually before enabling launchd.
- **Skip-path test:** clean repo, no new commits in 24h → Phase 1 should skip, exit 0, log "no-changes-since-last-run".
- **Reject-path test:** force a synthetic diff Claude is configured to reject → Phase 3 returns `REJECT`, exit 0, log reason. No PR.
- **Endorse-path test:** force a known-clean refactor (e.g., a typo fix) → both models endorse, Phase 4 opens draft PR. Verify the PR's title/body/branch match expectations, then close it.

After all three pass manually, load the plist and observe the first scheduled run.

## Out of scope (deliberately)

- Notifications. PR email is the signal.
- Multi-repo support. One profile, one repo. Adding repos later is a config change.
- Web UI / dashboard. Logs are jsonl on disk; `jq` is enough.
- Auto-merge. PRs stay draft for human review.
- Slack/Discord webhooks.
- Cross-machine state sync. The Mac is the source of truth.

## Open questions

None blocking. Implementation will surface details (exact `codex` and `claude` invocation flags, Hermes profile config schema, launchd env var passthrough) that can be resolved during the plan and execution.
