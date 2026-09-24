#!/bin/sh
# Follow main: when it moved, reset the live checkout and restart the server.
# Run by launchd every 5 minutes (us.thesuperhuman.kn.update); see README.md.
#   update.sh [--force]   # redeploy now, even mid-match or when main didn't move
#
# Rooms live in memory on this setup (no Redis), so a restart ends every
# match. An update therefore waits while anyone is in a room.
set -eu

# The reset below can rewrite this file; a function is parsed in full first.
main() {
  LIVE="$HOME/kaillera-next-live"
  CONF="$HOME/Library/Application Support/kaillera-next"
  DEPLOYED="$CONF/deployed-rev"
  HEALTH=http://127.0.0.1:27890/health
  AGENT="gui/$(id -u)/us.thesuperhuman.kn.server"
  FORCE="${1:-}"
  cd "$LIVE"

  git fetch --quiet origin main
  want=$(git rev-parse origin/main)
  health=$(curl -fsS --max-time 5 "$HEALTH" 2>/dev/null || true)
  if [ "$FORCE" != "--force" ]; then
    if [ "$(cat "$DEPLOYED" 2>/dev/null)" = "$want" ] && [ -n "$health" ]; then
      exit 0
    fi
    players=$(printf '%s' "$health" | sed -n 's/.*"players":\([0-9]*\).*/\1/p')
    if [ "${players:-0}" -gt 0 ]; then
      echo "$(date '+%F %T') update to ${want%"${want#???????}"} waiting: $players player(s) online"
      exit 0
    fi
  fi

  git reset --quiet --hard "$want"
  echo "$(date '+%F %T') deploying $(git log -1 --format='%h %s')"
  (cd server && uv sync --frozen --quiet)
  launchctl kickstart -k "$AGENT"

  # Record the revision only once the new server answers /health, so a
  # broken deploy is retried on the next run.
  i=0
  until curl -fsS --max-time 5 "$HEALTH" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 60 ]; then
      echo "$(date '+%F %T') server not healthy after 120 s; will retry"
      exit 1
    fi
    sleep 2
  done
  echo "$want" >"$DEPLOYED"
  echo "$(date '+%F %T') healthy"
}
main "$@"
