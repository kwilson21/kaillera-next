#!/usr/bin/env bash
# Skip-checks + worktree setup for the audit loop.
#
# Exits 0 with WORKTREE_PATH=... BRANCH=... on stdout if the loop should proceed.
# Exits 10 if the loop should be skipped (with reason on stderr).
# Exits non-zero on real errors.
#
# Usage:
#   preflight.sh [--force]
#
# --force bypasses skip checks ONLY. Caller (the skill) still applies all
# other guardrails (caps, forbid-paths, tests, Codex review, secret scan).

set -euo pipefail

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

REPO_DIR="/Users/kazon/kaillera-next"
STATE_FILE="${KN_AUDIT_STATE_FILE:-$HOME/.config/kn-audit/state.json}"
TOKEN_FILE="${KN_AUDIT_TOKEN_FILE:-$HOME/.config/kn-audit/token}"
REPO_SLUG="kwilson21/kaillera-next"

cd "$REPO_DIR"

# In --auto mode, the token MUST be present. Caller passes --force for
# manual interactive runs where the user is in the loop.
if [[ "$FORCE" == "0" && ! -f "$TOKEN_FILE" ]]; then
  echo "SKIP: $TOKEN_FILE missing — refusing to run unattended." >&2
  exit 10
fi

# Always need a clean working tree to start.
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "SKIP: $REPO_DIR has uncommitted changes." >&2
  exit 10
fi

git fetch origin main --quiet
HEAD_SHA=$(git rev-parse origin/main)

if [[ "$FORCE" == "0" ]]; then
  # Skip if main hasn't moved since last successful audit.
  if [[ -f "$STATE_FILE" ]]; then
    LAST_SHA=$(python3 -c "import json,sys; print(json.load(open('$STATE_FILE')).get('head_sha',''))" 2>/dev/null || echo "")
    if [[ -n "$LAST_SHA" && "$LAST_SHA" == "$HEAD_SHA" ]]; then
      echo "SKIP: origin/main unchanged since last audit ($HEAD_SHA)." >&2
      exit 10
    fi
  fi

  # Skip if an automated PR is already open. Use the dedicated token here too.
  if [[ -f "$TOKEN_FILE" ]]; then
    TOKEN=$(cat "$TOKEN_FILE")
    OPEN_COUNT=$(GH_TOKEN="$TOKEN" GITHUB_TOKEN="" \
      gh pr list --repo "$REPO_SLUG" --label automated-tech-debt --state open --json number 2>/dev/null \
      | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    if [[ "$OPEN_COUNT" -gt "0" ]]; then
      echo "SKIP: $OPEN_COUNT automated-tech-debt PR(s) already open." >&2
      exit 10
    fi
  fi
fi

# Set up the fresh worktree from origin/main.
TODAY=$(date +%Y-%m-%d)
SUFFIX=$(date +%H%M%S)
BRANCH="automated/tech-debt/${TODAY}-${SUFFIX}"
WORKTREE_PATH="/tmp/kn-audit-${TODAY}-${SUFFIX}"

# Defensive cleanup if a stale worktree exists.
if [[ -d "$WORKTREE_PATH" ]]; then
  git worktree remove --force "$WORKTREE_PATH" 2>/dev/null || rm -rf "$WORKTREE_PATH"
fi

git worktree add -b "$BRANCH" "$WORKTREE_PATH" origin/main >&2

echo "WORKTREE_PATH=$WORKTREE_PATH"
echo "BRANCH=$BRANCH"
echo "BASE_SHA=$HEAD_SHA"
