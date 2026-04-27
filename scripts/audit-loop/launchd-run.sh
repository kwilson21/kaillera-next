#!/usr/bin/env bash
#
# launchd-run.sh — wrapper that ~/Library/LaunchAgents/com.kazon.kn-audit.plist
# invokes daily at 3am local time.
#
# launchd does not source the user's shell rc files, so PATH and HOME must be
# set explicitly. We also enforce a single-instance lock so an overlapping
# run (e.g. one started manually while another is in flight) cannot collide.
#
# Logs go to ~/.config/kn-audit/logs/<date>.log (one file per day, appended
# if multiple runs in the same day).

set -euo pipefail

# ── Environment ──────────────────────────────────────────────────────────
export HOME="${HOME:-/Users/kazon}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"

REPO_DIR="/Users/kazon/kaillera-next"
LOG_DIR="$HOME/.config/kn-audit/logs"
LOCK_FILE="$HOME/.config/kn-audit/run.lock"
LOG_FILE="$LOG_DIR/$(date +%Y-%m-%d).log"

mkdir -p "$LOG_DIR"

# ── Single-instance lock ────────────────────────────────────────────────
# Use a file lock so two launchd-run.sh invocations cannot both be
# running /audit-loop at the same time. flock isn't on macOS by default;
# fall back to a PID file with a liveness check.
if [ -f "$LOCK_FILE" ]; then
  OLD_PID=$(cat "$LOCK_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "$(date -Iseconds) SKIP: lock held by pid $OLD_PID" >> "$LOG_FILE"
    exit 0
  fi
  # Stale lock — process is gone; clear it and continue.
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ── Sanity checks ───────────────────────────────────────────────────────
{
  echo
  echo "===== $(date -Iseconds) launchd-run.sh start (pid $$) ====="

  if ! command -v claude >/dev/null 2>&1; then
    echo "FATAL: claude CLI not on PATH" >&2
    exit 1
  fi
  if ! command -v codex >/dev/null 2>&1; then
    echo "FATAL: codex CLI not on PATH" >&2
    exit 1
  fi
  if [ ! -f "$HOME/.config/kn-audit/token" ]; then
    echo "FATAL: $HOME/.config/kn-audit/token missing" >&2
    exit 1
  fi
  if [ ! -d "$REPO_DIR/.git" ]; then
    echo "FATAL: $REPO_DIR is not a git repo" >&2
    exit 1
  fi

  cd "$REPO_DIR"
  echo "cwd: $(pwd)"
  echo "claude: $(claude --version 2>&1 | head -1)"
  echo "codex:  $(codex --version 2>&1 | head -1)"

  # ── Run the loop ─────────────────────────────────────────────────────
  # bypassPermissions: the loop spawns subagents and runs Bash/Edit/Write
  # without a human at the keyboard. The skill's hard rules + caps +
  # forbid-paths + Codex pass 2 + secret scan + draft-PR-only are the
  # safety surface in lieu of per-tool prompts.
  # max-budget-usd: hard cap to prevent runaway token spend.
  # no-session-persistence: scheduled runs do not need resume history.
  echo
  echo "----- claude -p /audit-loop --auto -----"
  claude \
    -p "/audit-loop --auto" \
    --permission-mode bypassPermissions \
    --max-budget-usd 10 \
    --no-session-persistence \
    2>&1
  rc=$?
  echo "----- claude exit: $rc -----"

  echo "===== $(date -Iseconds) launchd-run.sh done ====="
  exit $rc
} >> "$LOG_FILE" 2>&1
