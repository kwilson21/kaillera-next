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

# Scenario tests: today's code and the three earlier variants (the scenarios
# show what each fix changed).
$QUINT test "$SPEC" --main=room_current --backend=typescript
$QUINT test "$SPEC" --main=room_before_start_fix --backend=typescript
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
# A joiner asking for state while the others are still loading always has a
# way forward (violated on room_before_start_fix).
check room_current joinersAreNotLeftWaitingAtTheStart
# Players who have synced the start are not held up by someone who joined
# after the sync began (violated on room_before_start_fix).
check room_current startIsNotHeldUpByALateJoiner

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

# ── Peer connection: one pair of pages, offers and answers between them ─────
PAIR=specs/peer_connection.qnt
$QUINT typecheck "$PAIR"
# The scenarios say what each variant does with the same ordering.
for variant in peer_connection_before_119 peer_connection_current peer_connection_fixed; do
  $QUINT test "$PAIR" --main="$variant" --backend=typescript
done
pair() { # module invariant init
  $QUINT run "$PAIR" --main="$1" --invariant="$2" --init="$3" \
    --max-samples=10000 --max-steps=25 --backend=typescript
}
# Today: a reconnect leaves the guest's input state clean and a roster update
# never replaces a connection that is up. The other four properties are
# violated today (the scenarios above show how) and hold on
# peer_connection_fixed, the rules the per-peer machine is built to.
pair peer_connection_current holdToday init
pair peer_connection_fixed allHold init
pair peer_connection_fixed allHold initLobby
