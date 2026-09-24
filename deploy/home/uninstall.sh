#!/bin/sh
# Stop hosting from this Mac: unload and remove the launchd agents.
#   sh ~/kaillera-next-live/deploy/home/uninstall.sh [--purge]
# --purge also deletes the secrets, logs and ~/kaillera-next-live.
set -eu

UID_NUM=$(id -u)
for name in update tunnel server; do
  label="us.thesuperhuman.kn.$name"
  launchctl bootout "gui/$UID_NUM/$label" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/$label.plist"
  echo "$label removed"
done

if [ "${1:-}" = --purge ]; then
  rm -rf "$HOME/Library/Application Support/kaillera-next" "$HOME/Library/Logs/kaillera-next" "$HOME/kaillera-next-live"
  echo "secrets, logs and live checkout deleted"
fi
