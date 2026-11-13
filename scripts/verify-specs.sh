#!/usr/bin/env bash
# Exhaustive model checking of the Quint specs (Apalache, via `quint verify`).
#
# check-specs.sh samples random runs 25 steps deep. This proves each property
# for EVERY run up to STEPS steps instead: shallower, but nothing inside the
# bound is missed. The two are complementary and CI runs both.
#
# Needs Java 17+. The first run downloads Apalache (~190 MB) to ~/.quint.
# Cost grows quickly with the bound: on a laptop-class machine the peer
# identity check takes ~20 s at 5 steps, ~50 s at 6 and ~170 s at 7.
set -euo pipefail
cd "$(dirname "$0")/.."

STEPS="${STEPS:-6}"
QUINT="npx quint"

verify() { # spec module invariant
  echo "== $2 / $3 (every run up to $STEPS steps)"
  $QUINT verify "$1" --main="$2" --invariant="$3" --max-steps="$STEPS"
}

# The checker must be able to find the bugs these properties exist for, or a
# pass means nothing. Both older variants of the peer identity rule have a
# counterexample within 6 steps.
expect_violation() { # spec module invariant
  echo "== $2 / $3 must be violated within $STEPS steps"
  if $QUINT verify "$1" --main="$2" --invariant="$3" --max-steps="$STEPS" >/dev/null 2>&1; then
    echo "expected a counterexample for $3 in $2, found none" >&2
    exit 1
  fi
}

PEERS=specs/peer_identity.qnt
verify "$PEERS" peer_identity_current neverEvictsLiveConnection
verify "$PEERS" peer_identity_current oneConnectionPerGuest
expect_violation "$PEERS" peer_identity_before neverEvictsLiveConnection
expect_violation "$PEERS" peer_identity_untagged neverEvictsLiveConnection

ROOM=specs/room_lifecycle.qnt
verify "$ROOM" room_current ownerSeesGame
verify "$ROOM" room_fixed ownerSeesGame
verify "$ROOM" room_fixed lateJoinersChaseTheCurrentMatch
verify "$ROOM" room_fixed pagesAgreeWithServer
# The known violations of the last two on room_current need 7 to 8 steps
# (found at 8 in ~4 minutes), beyond this bound; check-specs.sh documents them.
