#!/bin/sh
# Pull main and redeploy when it moved. Runs from kn-update.timer every few
# minutes (and once at boot), so a merge to main reaches the VPS without SSH.
#   kn-update.sh [--force]   # --force rebuilds even when main didn't move
set -eu

# The reset below can rewrite this file; a function is parsed in full first.
main() {
  REPO=/opt/kaillera-next
  BRANCH="${KN_BRANCH:-main}"
  ENV_FILE=/etc/kaillera-next/env
  # The last commit that deployed successfully. Compared instead of HEAD so a
  # failed build is retried on the next run rather than looking up to date.
  DEPLOYED=/var/lib/kaillera-next/deployed-rev
  cd "$REPO"

  git fetch --quiet origin "$BRANCH"
  if [ "$(cat "$DEPLOYED" 2>/dev/null)" = "$(git rev-parse "origin/$BRANCH")" ] && [ "${1:-}" != "--force" ] \
    && docker compose --env-file "$ENV_FILE" -f deploy/vps/compose.yml ps --status running -q app | grep -q .; then
    exit 0
  fi

  git reset --quiet --hard "origin/$BRANCH"
  echo "kn-update: deploying $(git log -1 --format='%h %s')"
  # --wait: fails unless every service is running and healthy (the app's
  # /health check), so an unhealthy deploy isn't recorded and is retried.
  docker compose --env-file "$ENV_FILE" -f deploy/vps/compose.yml up -d --build --remove-orphans \
    --wait --wait-timeout 180
  mkdir -p "$(dirname "$DEPLOYED")"
  git rev-parse HEAD > "$DEPLOYED"
  docker image prune -f >/dev/null
}
main "$@"
