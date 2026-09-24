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
  cd "$REPO"

  git fetch --quiet origin "$BRANCH"
  if [ "$(git rev-parse HEAD)" = "$(git rev-parse "origin/$BRANCH")" ] && [ "${1:-}" != "--force" ] \
    && docker compose --env-file "$ENV_FILE" -f deploy/vps/compose.yml ps --status running -q app | grep -q .; then
    exit 0
  fi

  git reset --quiet --hard "origin/$BRANCH"
  echo "kn-update: deploying $(git log -1 --format='%h %s')"
  docker compose --env-file "$ENV_FILE" -f deploy/vps/compose.yml up -d --build --remove-orphans
  docker image prune -f >/dev/null
}
main "$@"
