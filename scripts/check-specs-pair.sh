#!/usr/bin/env bash
# Two independent logical shards per runner; GitHub's job index is zero-based.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "$#" -ne 2 ] ||
  ! [[ "$1" =~ ^(0|[1-9][0-9]{0,2})$ && "$2" =~ ^[1-9][0-9]{0,2}$ ]] ||
  [ "$2" -gt 128 ] || [ "$1" -ge "$2" ]; then
  echo "usage: $0 JOB_INDEX JOB_TOTAL (0 <= index < total <= 128)" >&2
  exit 2
fi
first=$(($1 + 1))
second=$(($1 + $2 + 1))
total=$(($2 * 2))
# Reject empty/invalid selections before starting either expensive child.
bash scripts/check-specs.sh --list --shard "$first" "$total" >/dev/null
bash scripts/check-specs.sh --list --shard "$second" "$total" >/dev/null
logs=$(mktemp -d)
first_pid=
second_pid=
cleanup() { rm -rf "$logs"; }
cancel() {
  trap '' INT TERM
  # Stop/reap our direct shell children. CI owns process-tree cleanup on
  # cancellation; this is not a promise to terminate arbitrary descendants.
  for pid in "$first_pid" "$second_pid"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
  done
  for pid in "$first_pid" "$second_pid"; do
    if [ -n "$pid" ]; then wait "$pid" 2>/dev/null || true; fi
  done
  exit "$1"
}
trap cleanup EXIT
trap 'cancel 130' INT
trap 'cancel 143' TERM
bash scripts/check-specs.sh --shard "$first" "$total" >"$logs/first" 2>&1 &
first_pid=$!
bash scripts/check-specs.sh --shard "$second" "$total" >"$logs/second" 2>&1 &
second_pid=$!
status=0
# Always wait for both, including when the first fails.
wait "$first_pid" || status=1
wait "$second_pid" || status=1
cat "$logs/first" "$logs/second"
exit "$status"
