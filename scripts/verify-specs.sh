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
  local out status=0
  out="$($QUINT verify "$1" --main="$2" --invariant="$3" --max-steps="$STEPS" 2>&1)" || status=$?
  # Only a reported counterexample counts. A crash, a timeout or a
  # translation error also exits non-zero and must not pass for one.
  if [ "$status" -ne 0 ] && grep -q '\[violation\]' <<<"$out"; then
    return 0
  fi
  echo "$out" | tail -40 >&2
  echo "expected a counterexample for $3 in $2 (exit $status)" >&2
  exit 1
}

PEERS=specs/peer_identity.qnt
verify "$PEERS" peer_identity_current neverEvictsLiveConnection
verify "$PEERS" peer_identity_current oneConnectionPerGuest
expect_violation "$PEERS" peer_identity_before neverEvictsLiveConnection
expect_violation "$PEERS" peer_identity_untagged neverEvictsLiveConnection

ROMT=specs/rom_transfer.qnt
verify "$ROMT" rom_transfer_current waitingHasAWayOut
verify "$ROMT" rom_transfer_current timersAloneStop
expect_violation "$ROMT" rom_transfer_before waitingHasAWayOut

ROOM=specs/room_lifecycle.qnt
verify "$ROOM" room_current ownerSeesGame
verify "$ROOM" room_current lateJoinersChaseTheCurrentMatch
verify "$ROOM" room_current pagesAgreeWithServer
# Before the page reconciled on reconnect, the last two have counterexamples
# 7 to 8 steps long (found at 8 in ~4 minutes), beyond this bound;
# check-specs.sh samples deep enough to reach them.
