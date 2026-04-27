#!/usr/bin/env bash
# One-time interactive setup for the audit-loop credentials.
# Provisions ~/.config/kn-audit/token (mode 0600) and verifies it works.
#
# Usage:  scripts/audit-loop/setup.sh
#
# Before running, create a fine-grained PAT at:
#   https://github.com/settings/personal-access-tokens/new
# Settings:
#   - Resource owner: kwilson21
#   - Repository access: Only select repositories → kwilson21/kaillera-next
#   - Permissions:
#       Contents:        Read and write
#       Pull requests:   Read and write
#       Metadata:        Read-only (auto-required)
#   - Expiration: 90 days (or your preference)
# All other permissions: NOT GRANTED.

set -euo pipefail

CONFIG_DIR="$HOME/.config/kn-audit"
TOKEN_FILE="$CONFIG_DIR/token"
REPO_SLUG="kwilson21/kaillera-next"

mkdir -p "$CONFIG_DIR"

echo "Paste the fine-grained PAT (input is hidden):"
read -rs TOKEN
echo

if [[ -z "$TOKEN" ]]; then
  echo "ERROR: empty token." >&2
  exit 1
fi

if [[ ! "$TOKEN" =~ ^github_pat_ ]]; then
  echo "WARNING: token does not start with 'github_pat_' — not a fine-grained PAT?" >&2
  read -rp "Continue anyway? [y/N] " ok
  [[ "$ok" == "y" || "$ok" == "Y" ]] || exit 1
fi

# Write atomically.
TMP=$(mktemp)
echo -n "$TOKEN" > "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$TOKEN_FILE"
echo "Wrote $TOKEN_FILE (mode 600)."

# Verify in an isolated gh config so we don't clobber the user's auth.
ISOLATED_GH_DIR=$(mktemp -d)
trap 'rm -rf "$ISOLATED_GH_DIR"' EXIT

echo "Verifying token against $REPO_SLUG..."

# 1. Token can read repo metadata.
if ! GH_TOKEN="$TOKEN" GITHUB_TOKEN="" GH_CONFIG_DIR="$ISOLATED_GH_DIR" \
     gh repo view "$REPO_SLUG" --json name >/dev/null 2>&1; then
  echo "FAIL: token cannot read $REPO_SLUG. Check repository access scope." >&2
  rm -f "$TOKEN_FILE"
  exit 1
fi

# 2. Token cannot list other repos (verify scope is single-repo).
OTHER_REPO_COUNT=$(GH_TOKEN="$TOKEN" GITHUB_TOKEN="" GH_CONFIG_DIR="$ISOLATED_GH_DIR" \
  gh api user/repos 2>/dev/null | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
if [[ "$OTHER_REPO_COUNT" -gt "1" ]]; then
  echo "WARNING: token can see $OTHER_REPO_COUNT repos — expected 1 (just kaillera-next)." >&2
  echo "         Token may be classic PAT or fine-grained-but-too-broad." >&2
  read -rp "Continue anyway? [y/N] " ok
  [[ "$ok" == "y" || "$ok" == "Y" ]] || { rm -f "$TOKEN_FILE"; exit 1; }
fi

echo "OK. Token is scoped to $REPO_SLUG and stored at $TOKEN_FILE."
echo
echo "Next: run the loop manually once with:"
echo "    cd /Users/kazon/kaillera-next && claude"
echo "    > /audit-loop"
