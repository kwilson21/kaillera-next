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

# Scenario tests: today's code, the proposed reconnect fix, and the code
# before #104 (hostReloadTest shows what that fix changed).
$QUINT test "$SPEC" --main=room_current --backend=typescript
$QUINT test "$SPEC" --main=room_fixed --backend=typescript
$QUINT test "$SPEC" --main=room_before_104 --backend=typescript

check() { # module invariant
  $QUINT run "$SPEC" --main="$1" --invariant="$2" \
    --max-samples=20000 --max-steps=25 --backend=typescript
}

# Today: no reachable state has the host in the lobby of a playing room.
check room_current ownerSeesGame

# With the reconnect fix (a page follows the status and match id its rejoin
# returns), these hold as well. Both are violated by today's code; see the
# properties section of the spec.
check room_fixed ownerSeesGame
check room_fixed lateJoinersChaseTheCurrentMatch
check room_fixed pagesAgreeWithServer
