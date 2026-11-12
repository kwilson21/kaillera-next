#!/usr/bin/env bash
# Model-check the Quint specs in specs/.
#
# The built-in (typescript) backend is used so nothing is downloaded at run
# time; the default backend fetches a binary on first use.
set -euo pipefail
cd "$(dirname "$0")/.."

SPEC=specs/room_lifecycle.qnt
QUINT="npx quint"

$QUINT typecheck "$SPEC"

# Scenario tests, against today's server behaviour and the proposed fix.
$QUINT test "$SPEC" --main=room_current --backend=typescript
$QUINT test "$SPEC" --main=room_fixed --backend=typescript

# With the fix, no reachable state has the host in the lobby of a playing room.
$QUINT run "$SPEC" --main=room_fixed --invariant=ownerSeesGame \
  --max-samples=20000 --max-steps=25 --backend=typescript
