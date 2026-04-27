#!/usr/bin/env bash
# Scan a git diff for accidentally-introduced secrets.
# Exits 0 if clean, 1 if anything looks like a secret.
#
# Usage:  secret-scan.sh <worktree_path>
#
# Conservative regex pass — false positives preferred over false negatives.

set -euo pipefail

WORKTREE="$1"
cd "$WORKTREE"

DIFF=$(git diff --staged origin/main 2>/dev/null || git diff origin/main)

if [[ -z "$DIFF" ]]; then
  exit 0
fi

# Grep on ADDED lines only (lines starting with +, not +++).
ADDED=$(echo "$DIFF" | grep -E '^\+[^+]' || true)

if [[ -z "$ADDED" ]]; then
  exit 0
fi

PATTERNS=(
  'AKIA[0-9A-Z]{16}'                          # AWS access key
  'aws_secret_access_key[[:space:]]*=[[:space:]]*[A-Za-z0-9/+=]{40}'
  'gh[pousr]_[A-Za-z0-9]{36,}'                # GitHub PAT
  'sk-[A-Za-z0-9]{20,}'                       # OpenAI / Anthropic key
  'sk-ant-[A-Za-z0-9_-]{20,}'                 # Anthropic key (explicit)
  'xox[baprs]-[A-Za-z0-9-]{10,}'              # Slack token
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'        # Any PEM private key
  'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}'  # JWT
  '(password|passwd|secret|api[_-]?key|access[_-]?token)[[:space:]]*[:=][[:space:]]*['"'"'"][^'"'"'"$ ]{8,}['"'"'"]'
)

HITS=""
for pat in "${PATTERNS[@]}"; do
  MATCH=$(echo "$ADDED" | grep -iE "$pat" || true)
  if [[ -n "$MATCH" ]]; then
    HITS+="Pattern: $pat\n$MATCH\n---\n"
  fi
done

if [[ -n "$HITS" ]]; then
  echo "SECRET-SCAN FAILED: possible secret in diff" >&2
  echo -e "$HITS" >&2
  exit 1
fi

exit 0
