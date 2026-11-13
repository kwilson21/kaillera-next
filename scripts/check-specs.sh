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

# Scenario tests: today's code and the two earlier variants (the scenarios
# show what each fix changed).
$QUINT test "$SPEC" --main=room_current --backend=typescript
$QUINT test "$SPEC" --main=room_before_reconcile --backend=typescript
$QUINT test "$SPEC" --main=room_before_104 --backend=typescript

check() { # module invariant
  $QUINT run "$SPEC" --main="$1" --invariant="$2" \
    --max-samples=20000 --max-steps=25 --backend=typescript
}

# Today: the host is never in the lobby of a playing room; a late joiner
# always joins the match the server is running; every connected page agrees
# with the server about lobby vs playing. The last two were violated before
# the page reconciled on reconnect (room_before_reconcile).
check room_current ownerSeesGame
check room_current lateJoinersChaseTheCurrentMatch
check room_current pagesAgreeWithServer

# ── Peer identity: which connection a rejoining player keeps ────────────────
PEERS=specs/peer_identity.qnt
$QUINT typecheck "$PEERS"
for variant in peer_identity_before peer_identity_untagged peer_identity_current; do
  $QUINT test "$PEERS" --main="$variant" --backend=typescript
done
# Today: signaling coming and going, in any order, never costs a player a
# connection that is up. Violated before #119 and by #119 as first written.
for invariant in neverEvictsLiveConnection oneConnectionPerGuest; do
  $QUINT run "$PEERS" --main=peer_identity_current --invariant="$invariant" \
    --max-samples=20000 --max-steps=25 --backend=typescript
done

# ── ROM transfer: a guest waiting on the host always has a way out ──────────
ROM=specs/rom_transfer.qnt
$QUINT typecheck "$ROM"
for variant in rom_transfer_before rom_transfer_current; do
  $QUINT test "$ROM" --main="$variant" --backend=typescript
done
# Today: every waiting state has a running timer or a Retry button. Violated
# before the request sent over the engine channel was given a deadline.
for invariant in waitingHasAWayOut timersAloneStop; do
  $QUINT run "$ROM" --main=rom_transfer_current --invariant="$invariant" \
    --max-samples=20000 --max-steps=25 --backend=typescript
done
