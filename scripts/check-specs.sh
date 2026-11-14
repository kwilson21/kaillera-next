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
$QUINT test "$SPEC" --main=room_before_resume_flag --backend=typescript
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
# A page whose rejoin the server answered is never left showing a match the
# room dropped it from (violated on room_before_resume_flag).
check room_current nobodyIsStrandedInADroppedMatch

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

# ── Desync digests: which frame a peer may report a hash for ────────────────
DIGEST=specs/desync_digest.qnt
$QUINT typecheck "$DIGEST"
for variant in desync_digest_before desync_digest_lag_only desync_digest_unsimulated \
  desync_digest_worker_replay desync_digest_current; do
  $QUINT test "$DIGEST" --main="$variant" --backend=typescript
done
# Today: a healthy peer never reports a hash for a frame it may still replay.
# Violated when the digest is built for the newest frame; with the wait alone,
# while replays leave the history as first written; when a late joiner
# reports frames it never simulated; and with the detector on under Mode 2.
$QUINT run "$DIGEST" --main=desync_digest_current --invariant=neverReportsAnUnconfirmedHash \
  --max-samples=20000 --max-steps=25 --backend=typescript

# ── Desync screenshots: which frame each peer captures ──────────────────────
CAPTURE=specs/desync_capture.qnt
$QUINT typecheck "$CAPTURE"
for variant in desync_capture_before desync_capture_current; do
  $QUINT test "$CAPTURE" --main="$variant" --backend=typescript
done
# Today: two pictures that are compared show the same frame. Violated when
# each peer captured at the moment it flagged.
$QUINT run "$CAPTURE" --main=desync_capture_current --invariant=comparedPicturesShowOneFrame \
  --max-samples=20000 --max-steps=25 --backend=typescript

# ── A resync from request to apply ──────────────────────────────────────────
FLOW=specs/resync_flow.qnt
$QUINT typecheck "$FLOW"
for variant in resync_flow_current resync_flow_fixed; do
  $QUINT test "$FLOW" --main="$variant" --backend=typescript
done
# Today: a guest stopped at its target has a deadline, and a state no newer
# than the last one applied is never applied.
$QUINT run "$FLOW" --main=resync_flow_current --invariant=holdToday \
  --max-samples=20000 --max-steps=25 --backend=typescript
# With a deadline on the request itself, a request that is out can always
# end. VIOLATED by today's engine (resync_flow_current): the host drops a
# request inside its rate limit and the guest never asks again. Not fixed yet.
$QUINT run "$FLOW" --main=resync_flow_fixed --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript
