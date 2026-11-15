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

verify() { # spec module invariant [init [steps]]
  local init="${4:-init}" steps="${5:-$STEPS}"
  echo "== $2 / $3${4:+ from $4} (every run up to $steps steps)"
  $QUINT verify "$1" --main="$2" --invariant="$3" --init="$init" --max-steps="$steps"
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
verify "$ROOM" room_current joinersAreNotLeftWaitingAtTheStart
verify "$ROOM" room_current startIsNotHeldUpByALateJoiner
verify "$ROOM" room_current nobodyIsStrandedInADroppedMatch
verify "$ROOM" room_current anAbandonedMatchIsEnded
verify "$ROOM" room_current aMatchIsNotLostToTheGraceWindow
expect_violation "$ROOM" room_before_start_fix joinersAreNotLeftWaitingAtTheStart
expect_violation "$ROOM" room_before_start_fix startIsNotHeldUpByALateJoiner
expect_violation "$ROOM" room_before_resume_flag nobodyIsStrandedInADroppedMatch
expect_violation "$ROOM" room_before_abandoned_end anAbandonedMatchIsEnded
expect_violation "$ROOM" room_before_grace_wait aMatchIsNotLostToTheGraceWindow
# Before the page reconciled on reconnect, the last two have counterexamples
# 7 to 8 steps long (found at 8 in ~4 minutes), beyond this bound;
# check-specs.sh samples deep enough to reach them.

PAIR=specs/peer_connection.qnt
verify "$PAIR" peer_connection_fixed allHold
verify "$PAIR" peer_connection_current holdToday
# Today's engine: each of these has a counterexample within 5 steps.
# (neverLeftWithNothingPending is violated too, but its shortest
# counterexample is longer than this bound; crossedHealOffersTest replays it.)
expect_violation "$PAIR" peer_connection_current oneInitiatorPerPair
expect_violation "$PAIR" peer_connection_current everyWaitHasADeadline
expect_violation "$PAIR" peer_connection_current staleSignalsAreNotApplied
expect_violation "$PAIR" peer_connection_before_119 neverEvictsLiveConnection
# A counter alone for the attempt: a replaced page's candidate reaches its
# replacement's connection in 5 steps (oldCandidateReachesReplacementConnectionTest).
expect_violation "$PAIR" peer_connection_counter_only staleSignalsAreNotApplied
# startupRetryIsNotAReconnect is violated on
# peer_connection_before_startup_flag only before the match, and this script
# starts from `init`, a match under way; from the lobby there is a
# counterexample 6 steps long. startupRetryToAStartedPageTest holds it, and
# check-specs.sh samples today's holdToday from `initLobby`.

STREAM=specs/streaming_connection.qnt
verify "$STREAM" streaming_connection_current allHold
# Pages joining late, whose readies only this initial state has: a ready
# lost, early, or arriving while the connection is still connecting. One
# step fewer than the rest keeps it near the cost of the proof above (about
# 130 s at 5 steps here, against about 160 s from `init` at 6); the longest of
# those orderings, the resent offer of readyWhileConnectingTest, reaches the
# guest at step 5.
verify "$STREAM" streaming_connection_current allHold initLate $((STEPS - 1))
# The engine before the host's deadline: a lost offer left the guest with
# nothing to come, in 2 steps. Its case of staleSignalsAreNotApplied, the
# host's new offer applied to the guest's old connection
# (newConnectionTakenAsRenegotiationTest), is 7 steps long, beyond this
# bound; that scenario holds it.
expect_violation "$STREAM" streaming_connection_before_reoffer neverLeftWithNothingPending
# The engine before #220 answered any member's offer: a stray offer is
# answered in 2 steps, and a stray sender's second offer is applied to its
# first connection in 4.
expect_violation "$STREAM" streaming_connection_before_220 receiversConnectOnlyToTheHost
expect_violation "$STREAM" streaming_connection_before_220 staleSignalsAreNotApplied

PAUSE=specs/late_join_pause.qnt
verify "$PAUSE" late_join_pause_current allHold
verify "$PAUSE" late_join_pause_marker_at_send holdBeforeTheResyncFix
verify "$PAUSE" late_join_pause_before_resync holdBeforeTheResyncFix
expect_violation "$PAUSE" late_join_pause_before hostPauseHasADeadline
expect_violation "$PAUSE" late_join_pause_host_side guestPauseHasADeadline
expect_violation "$PAUSE" late_join_pause_host_side guestResumesOnTheHostsWord
expect_violation "$PAUSE" late_join_pause_host_side aRepeatedRequestKeepsTheDeadline
# The other two violations on late_join_pause_before need two joiners and
# are 8 to 9 steps long, beyond this bound; check-specs.sh's scenarios hold
# them.
# aJoinerIsNotMadeAPlayerBehindTheHost on late_join_pause_before_resync has
# a counterexample 7 steps long (ask, serve, send, lose the channel, load,
# reopen, ready), beyond this bound;
# joinerLosesTheHostAfterTheStateIsSentTest and
# timerFiresWhileTheStateIsOnItsWayTest hold it. On
# late_join_pause_marker_at_send its counterexample (the same and an
# unanswered request) is 8 steps long; resyncRequestUnansweredTest holds it.

FLOW=specs/resync_flow.qnt
verify "$FLOW" resync_flow_current allHold
verify "$FLOW" resync_flow_any_answer holdWithoutNumbers
expect_violation "$FLOW" resync_flow_before aRequestCanAlwaysEnd
expect_violation "$FLOW" resync_flow_any_answer onlyItsAnswerEndsARequest
# Six steps: two requests "now", the host answers the first, the guest
# moves on, the answer arrives, and it is applied behind the guest
# (immediateLateAnswerTest; lateAnswerFromAfterTheAskTest for rule b).
expect_violation "$FLOW" resync_flow_any_answer aLateAnswerDoesNotTakeTheGuestBack
expect_violation "$FLOW" resync_flow_frame_named aLateAnswerDoesNotTakeTheGuestBack
expect_violation "$FLOW" resync_flow_asked_from aLateAnswerDoesNotTakeTheGuestBack
# Rule a, not taken, holds them too (onlyStateComingTest shows its cost).
verify "$FLOW" resync_flow_drop_older allHold
# The counterexample to theAwaitedAnswerIsNotLost on resync_flow_any_answer
# is over ten steps long, beyond this bound; lateAnswerOverTheAwaitedOneTest
# holds it, as lateAnswerTest and lateAnswerAfterTheTargetDeadlineTest hold
# the orderings at a named frame.

TICK=specs/tick_deadlines.qnt
verify "$TICK" tick_deadlines_current ownFreezeIsNotHeldAgainstAPeer
expect_violation "$TICK" tick_deadlines_before ownFreezeIsNotHeldAgainstAPeer


RESYNC=specs/resync_inputs.qnt
verify "$RESYNC" resync_inputs_current allHold
# The only-new counterexample (run ahead, be taken back, be moved forward
# again) is over 15 steps long, beyond this bound;
# guestMovedOverInputsItMadeBeforeTest holds it and check-specs.sh's samples
# reach it.
# The no-refeed counterexample is over 13 steps long, beyond this bound;
# guestMovedOverAnInputItsEngineWroteOverTest holds it.
# The solo-holes counterexample (run alone past the limit, then resync) is 9
# steps long, beyond this bound; hostRanAloneThenResyncsTest holds it.
# The counterexample on resync_inputs_before is 10 steps long (the host has to
# run far enough ahead for the guest to drop its inputs), beyond this bound;
# check-specs.sh's scenarios and samples reach it.

MESH=specs/resync_mesh.qnt
verify "$MESH" resync_mesh_current allHold
expect_violation "$MESH" resync_mesh_untold noWaitForAnInputThatCannotArrive
expect_violation "$MESH" resync_mesh_kept settledPointIsNotAhead
