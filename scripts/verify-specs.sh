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
#
# Usage:
#   verify-specs.sh               every group below, one after another
#   verify-specs.sh --shard N     the groups of CI shard N (SHARDS below)
#   verify-specs.sh --shards      how many shards there are
#   verify-specs.sh --plan        print every command as tab-separated fields
#   verify-specs.sh GROUP...      the named groups
set -euo pipefail
cd "$(dirname "$0")/.."

# The scheduler reads this same authoritative command list; there is no second
# list of properties or expected counterexamples to keep in sync.
PLAN=false
if [ "${1:-}" = --plan ]; then
  PLAN=true
  shift
fi
STEPS="${STEPS:-6}"
QUINT="npx quint"

verify() { # spec module invariant [init [steps]]
  local init="${4:-init}" steps="${5:-$STEPS}"
  if "$PLAN"; then
    printf '%s\t%s\t%s\t%s\t%s\thold\n' "$1" "$2" "$3" "$init" "$steps"
    return
  fi
  echo "== $2 / $3${4:+ from $4} (every run up to $steps steps)"
  $QUINT verify "$1" --main="$2" --invariant="$3" --init="$init" --max-steps="$steps"
}

# The checker must be able to find the bugs these properties exist for, or a
# pass means nothing. Both older variants of the peer identity rule have a
# counterexample within 6 steps.
# A counterexample deeper than STEPS gives its bound as a fourth argument.
expect_violation() { # spec module invariant [steps]
  local steps="${4:-$STEPS}"
  if "$PLAN"; then
    printf '%s\t%s\t%s\tinit\t%s\tviolation\n' "$1" "$2" "$3" "$steps"
    return
  fi
  echo "== $2 / $3 must be violated within $steps steps"
  local out status=0
  out="$($QUINT verify "$1" --main="$2" --invariant="$3" --max-steps="$steps" 2>&1)" || status=$?
  # Only a reported counterexample counts. A crash, a timeout or a
  # translation error also exits non-zero and must not pass for one.
  if [ "$status" -ne 0 ] && grep -q '\[violation\]' <<<"$out"; then
    return 0
  fi
  echo "$out" | tail -40 >&2
  echo "expected a counterexample for $3 in $2 within $steps steps (exit $status)" >&2
  exit 1
}

peer_identity() {
  local PEERS=specs/peer_identity.qnt
  verify "$PEERS" peer_identity_current neverEvictsLiveConnection
  verify "$PEERS" peer_identity_current oneConnectionPerGuest
  expect_violation "$PEERS" peer_identity_before neverEvictsLiveConnection
  expect_violation "$PEERS" peer_identity_untagged neverEvictsLiveConnection
}

rom_transfer() {
  local ROMT=specs/rom_transfer.qnt
  verify "$ROMT" rom_transfer_current waitingHasAWayOut
  verify "$ROMT" rom_transfer_current timersAloneStop
  verify "$ROMT" rom_transfer_current retriesBeforeAsking
  verify "$ROMT" rom_transfer_current noRetryWhileHostStopped
  expect_violation "$ROMT" rom_transfer_before waitingHasAWayOut
  expect_violation "$ROMT" rom_transfer_nothing_received_waits retriesBeforeAsking
  expect_violation "$ROMT" rom_transfer_retry_outlives_sharing noRetryWhileHostStopped
}

# room_lifecycle is the largest, so it is checked in two halves: the start of a
# match and what the pages see of it, then players dropping and coming back.
# Before the page reconciled on reconnect, lateJoinersChaseTheCurrentMatch and
# pagesAgreeWithServer had counterexamples 7 to 8 steps long (found at 8 in ~4
# minutes), beyond this bound; check-specs.sh samples deep enough to reach them.
room_lifecycle_start() {
  local ROOM=specs/room_lifecycle.qnt
  verify "$ROOM" room_current ownerSeesGame
  verify "$ROOM" room_current pagesAgreeWithServer
  verify "$ROOM" room_current joinersAreNotLeftWaitingAtTheStart
  verify "$ROOM" room_current startIsNotHeldUpByALateJoiner
  expect_violation "$ROOM" room_before_start_fix joinersAreNotLeftWaitingAtTheStart
  expect_violation "$ROOM" room_before_start_fix startIsNotHeldUpByALateJoiner
}

room_lifecycle_drops() {
  local ROOM=specs/room_lifecycle.qnt
  verify "$ROOM" room_current lateJoinersChaseTheCurrentMatch
  verify "$ROOM" room_current nobodyIsStrandedInADroppedMatch
  verify "$ROOM" room_current anAbandonedMatchIsEnded
  verify "$ROOM" room_current aMatchIsNotLostToTheGraceWindow
  expect_violation "$ROOM" room_before_resume_flag nobodyIsStrandedInADroppedMatch
  expect_violation "$ROOM" room_before_abandoned_end anAbandonedMatchIsEnded
  expect_violation "$ROOM" room_before_grace_wait aMatchIsNotLostToTheGraceWindow
}

peer_connection() {
  local PAIR=specs/peer_connection.qnt
  verify "$PAIR" peer_connection_fixed allHold
  verify "$PAIR" peer_connection_current holdToday
  # The machine deciding `heal` alone keeps what holds today and two more
  # (no pair worse than today during a deploy). The answerer's wait still
  # has no deadline there, as today: the next rule to wire.
  verify "$PAIR" peer_connection_heal_one_side holdWithHealOneSide
  expect_violation "$PAIR" peer_connection_heal_one_side everyWaitHasADeadline
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
}

streaming_connection() {
  local STREAM=specs/streaming_connection.qnt
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
}

late_join_pause() {
  local PAUSE=specs/late_join_pause.qnt
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
}

resync_flow() {
  local FLOW=specs/resync_flow.qnt
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
  # Six steps too: the boot sync asks with no number, the host answers, the
  # guest moves on and asks again, and the unnumbered answer is applied
  # behind it (bootAnswerAfterANewerRequestTest).
  expect_violation "$FLOW" resync_flow_unnumbered aLateAnswerDoesNotTakeTheGuestBack
  # Four steps: the guest asks now, the host answers with its frame, the
  # guest moves on, and the answer takes it back (ownAnswerBehindTest).
  expect_violation "$FLOW" resync_flow_rewinds theGuestIsNeverRewound
  # Rule a, not taken, holds them too (onlyStateComingTest shows its cost).
  verify "$FLOW" resync_flow_drop_older allHold
  # The counterexample to theAwaitedAnswerIsNotLost on resync_flow_any_answer
  # is over ten steps long, beyond this bound; lateAnswerOverTheAwaitedOneTest
  # holds it, as lateAnswerTest and lateAnswerAfterTheTargetDeadlineTest hold
  # the orderings at a named frame.
}

tick_deadlines() {
  local TICK=specs/tick_deadlines.qnt
  verify "$TICK" tick_deadlines_current ownFreezeIsNotHeldAgainstAPeer
  expect_violation "$TICK" tick_deadlines_before ownFreezeIsNotHeldAgainstAPeer
  verify "$TICK" tick_deadlines_current everyWaitHasADeadline
  expect_violation "$TICK" tick_deadlines_before_lockstep_mode everyWaitHasADeadline
  verify "$TICK" peer_staleness_current allHold init 14
  # A live peer catching up below its highest frame: five ticks, the clock
  # never restarted (catchingUpTest).
  expect_violation "$TICK" peer_staleness_before aCatchingUpPeerIsNotStale 10
  # A stuck peer's resend restarts the clock: 2 steps (repeatingTest).
  expect_violation "$TICK" peer_staleness_any_input aRepeatingPeerStillGoesStale 3
  verify "$TICK" input_link_paced allHold
  # Two chunks ahead of the inputs, two seconds, the deadline, a second: 5 steps.
  expect_violation "$TICK" input_link_burst allHold
  # #236 as first written. A transfer, a push queued behind it, a reconnect,
  # the push comes up, its chunk goes over the new connection: 5 steps
  # (transferQueuedBeforeAResetTest). A transfer settled at its start and
  # given up: 2 steps (abandonedTransferTest).
  expect_violation "$TICK" input_link_paced_unguarded aTransferQueuedBeforeAResetNeverReachesTheNewConnection
  expect_violation "$TICK" input_link_paced_unguarded inputsAreSettledOnlyForADeliveredState
  # The guest's chunk deadline over the whole state: a state longer than the
  # deadline, two seconds, the guest drops it while it arrives (4 steps); its
  # request reaches the host, which hands over the next chunk (6 steps).
  # progressingTransferAbandonedTest holds the ordering.
  expect_violation "$TICK" input_link_paced_whole_deadline aTransferMakingProgressIsNotAbandoned
  expect_violation "$TICK" input_link_paced_whole_deadline noChunkForATransferTheGuestDropped
}

resync_inputs() {
  local RESYNC=specs/resync_inputs.qnt
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
  # The no-ask counterexample (the guest freezes, the host runs on alone and is
  # heard from again, the guest catches up to the inputs it dropped) is over 20
  # steps long, beyond this bound; guestWaitsOnInputsItDroppedTest holds it.
}

resync_mesh() {
  local MESH=specs/resync_mesh.qnt
  verify "$MESH" resync_mesh_current allHold
  expect_violation "$MESH" resync_mesh_untold noWaitForAnInputThatCannotArrive
  expect_violation "$MESH" resync_mesh_kept settledPointIsNotAhead
}

input_transport() {
  local INPUTS=specs/input_transport.qnt
  verify "$INPUTS" input_transport_fixed allHold
  verify "$INPUTS" input_transport_current noInputIsLostForGood
  # Inputs lost on the unreliable channel, then the switch: 3 to 5 steps.
  expect_violation "$INPUTS" input_transport_current unackedInputsAreSentAgainAtTheSwitch
  expect_violation "$INPUTS" input_transport_until_acked unackedInputsAreSentAgainAtTheSwitch
  # A resend cut short by a failed send, its rest dropped: 4 steps.
  expect_violation "$INPUTS" input_transport_resend_once unackedInputsAreSentAgainAtTheSwitch
  expect_violation "$INPUTS" input_transport_before_ask noInputIsLostForGood
}

resync_reask() {
  local REASK=specs/resync_reask.qnt
  # A lost request asked again at its deadline twice and then given up: 10 steps.
  verify "$REASK" resync_reask_fixed allHold init 10
  verify "$REASK" resync_reask_unguarded anOwedResyncIsNotForgotten
  # A "now" request lost, then its deadline: 3 steps. The deadline during
  # the decode of its answer: 5 steps.
  expect_violation "$REASK" resync_reask_current anOwedResyncIsNotForgotten
  expect_violation "$REASK" resync_reask_current theDecodedAnswerIsNotCut
  expect_violation "$REASK" resync_reask_unguarded theDecodedAnswerIsNotCut
  # The lifecycle guard's timeout letting the ask again go: 5 steps.
  expect_violation "$REASK" resync_reask_guard_lets_go anOwedResyncIsNotForgotten
  # A coordinated request ("at" a frame) whose answer is lost, then its
  # deadline lets it go: 3 steps.
  expect_violation "$REASK" resync_reask_coordinated_let_go aResyncAskedForIsNotForgotten
}

sync_follow_up() {
  local FOLLOW=specs/sync_follow_up.qnt
  # An unconfirmed answer followed up at three deadlines, then given up: 12 steps.
  verify "$FOLLOW" sync_follow_up_fixed allHold init 12
  verify "$FOLLOW" sync_follow_up_current atMostOneAnswerInFlight
  # A follow-up sent for a state no input changed: 5 steps. A misprediction
  # while the state is compressed, recorded from the send only: 5 steps.
  expect_violation "$FOLLOW" sync_follow_up_current aFollowUpCarriesANewState
  expect_violation "$FOLLOW" sync_follow_up_from_send theGuestEndsOnTheHostsState
  # A direct answer taken unconfirmed, final, then the input differs: 5 steps.
  expect_violation "$FOLLOW" sync_follow_up_direct_unwatched theGuestEndsOnTheHostsState 5
  # The same over the socket, and a socket send never recorded delivered: 5 steps each.
  expect_violation "$FOLLOW" sync_follow_up_socket_unwatched theGuestEndsOnTheHostsState 5
  expect_violation "$FOLLOW" sync_follow_up_socket_undelivered aFollowUpCarriesANewState 5
  # A socket answer whose follow-up waits on a closed channel: 4 steps.
  expect_violation "$FOLLOW" sync_follow_up_socket_over_channel aWatchedAnswerCanBeFollowedUp 4
}

rom_at_start() {
  local ROM_START=specs/rom_at_start.qnt
  verify "$ROM_START" rom_at_start_current allHold
  # Load, the server hears it, clear: 3 steps (deletedRomTest).
  expect_violation "$ROM_START" rom_at_start_before serverKnowsTheRom
  # The same, Start before the clear arrives, the page boots: 5 steps
  # (startBeforeTheClearArrivesTest).
  expect_violation "$ROM_START" rom_at_start_clear_only neverBootsWithoutRom
  # Load, heard, the socket drops, clear, rejoin: 5 steps (clearedWhileDownTest).
  expect_violation "$ROM_START" rom_at_start_no_rejoin serverKnowsTheRom
}

catch_up_wait() {
  local WAIT=specs/catch_up_wait.qnt
  verify "$WAIT" catch_up_wait_fixed allHold init 12
  # A waiting catch-up ticks twice in one slot and sends the frame again:
  # 2 steps; six spinning ticks then the ask, buried: 7 steps
  # (spinThenAskTest carries that one).
  expect_violation "$WAIT" catch_up_wait_current aWaitingCatchUpDoesNotSpin
  expect_violation "$WAIT" catch_up_wait_current reliableResendsAreSpaced
  expect_violation "$WAIT" catch_up_wait_yield_only reliableResendsAreSpaced
  expect_violation "$WAIT" catch_up_wait_resend_limited_only aWaitingCatchUpDoesNotSpin
}

ask_escalation() {
  local ESC=specs/ask_escalation.qnt
  verify "$ESC" ask_escalation_fixed_host allHold init 14
  verify "$ESC" ask_escalation_fixed_guest allHold init 14
  # Three asks (the threshold), the answer lost for good, the asks run out,
  # nothing more happens: the page predicts the input for the rest of the
  # match (lostForGoodTest): 8 steps.
  expect_violation "$ESC" ask_escalation_current everyAskEnds 8
  # The push escalated to, its acknowledgement lost, and no deadline on it
  # (pushAckLostTest): 8 steps.
  expect_violation "$ESC" ask_escalation_push_once everyAskEnds 8
  verify "$ESC" push_deadline_current allHold init 10
  verify "$ESC" push_deadline_current_resync_off allHold init 10
  # Resync off: armed, three deadlines, dropped with nothing sent: 4 steps.
  expect_violation "$ESC" push_deadline_before_resync_off noDropWithoutASentPush 6
  # A push, a reconnect, three deadlines: 5 steps.
  expect_violation "$ESC" push_deadline_before noDropDuringAReconnect 6
  # A push acknowledged, then pushed again past it to the give-up: 6 steps.
  expect_violation "$ESC" push_deadline_before noDropAfterAnAcknowledgement 7
  verify "$ESC" escalation_peers_all everyPeerOnTheHostState init 3
  expect_violation "$ESC" escalation_peers_one everyPeerOnTheHostState 2
}

escalation_push() {
  verify specs/late_join_drop_ready.qnt late_join_drop_ready_fixed noUnreadyMeshAdmission init 5
  expect_violation specs/late_join_drop_ready.qnt late_join_drop_ready_before noUnreadyMeshAdmission 3
  verify specs/recovery_apply_boundary.qnt recovery_apply_boundary_fixed allHold init 4
  expect_violation specs/recovery_apply_boundary.qnt recovery_apply_boundary_before allHold 2
  verify specs/sync_channel_owner.qnt sync_channel_owner_fixed allHold init 6
  expect_violation specs/sync_channel_owner.qnt sync_channel_owner_before allHold 2
  local ACK=specs/recovery_ack.qnt
  verify "$ACK" recovery_ack_fixed exactAttemptOnly init 5
  expect_violation "$ACK" recovery_ack_before exactAttemptOnly 2
  local LIFECYCLE=specs/recovery_lifecycle.qnt
  verify "$LIFECYCLE" recovery_lifecycle_fixed allHold init 5
  expect_violation "$LIFECYCLE" recovery_lifecycle_before stoppedWorkSettles 2
  expect_violation "$LIFECYCLE" recovery_lifecycle_before failedJoinStaysGated 2
  expect_violation "$LIFECYCLE" recovery_lifecycle_before unusableChannelDoesNotCapture 2
  verify specs/input_placeholder.qnt input_placeholder_fixed allHold init 4
  expect_violation specs/input_placeholder.qnt input_placeholder_before allHold 2
  verify specs/stale_prediction_flag.qnt stale_prediction_flag_fixed allHold
  expect_violation specs/stale_prediction_flag.qnt stale_prediction_flag_before allHold 5
  verify specs/recovery_review.qnt recovery_review_fixed allHold init 14
  expect_violation specs/recovery_review.qnt recovery_review_before rosterGapCannotRenew 5
  expect_violation specs/recovery_review.qnt recovery_review_before readinessHasDeadline 1
  expect_violation specs/recovery_review.qnt recovery_review_before repeatedReadyWorks 6
  expect_violation specs/recovery_review.qnt recovery_review_before roomCapturesBounded 13
  local DELIVERY=specs/recovery_delivery.qnt
  verify "$DELIVERY" recovery_budget_identity_fixed rotationCannotRenew init 8
  expect_violation "$DELIVERY" recovery_budget_identity_before rotationCannotRenew 5
  verify "$DELIVERY" recovery_source_budget_fixed allHold init 8
  expect_violation "$DELIVERY" recovery_source_budget_before capturesBoundedWithinWindow 4
  expect_violation "$DELIVERY" recovery_source_budget_before pendingWaitersBounded 2
  verify "$DELIVERY" recovery_partial_fixed allHold init 3
  expect_violation "$DELIVERY" recovery_partial_before freeRecipientProceeds 2
  verify "$DELIVERY" recovery_followup_fixed allHold init 10
  expect_violation "$DELIVERY" recovery_followup_before healthySourceIsNeverBlocked 3
  verify "$DELIVERY" recovery_skipped_fixed allHold init 10
  expect_violation "$DELIVERY" recovery_skipped_current settledCoversNewestHole 2
  verify "$DELIVERY" recovery_actor_enabled allHold init 10
  verify "$DELIVERY" recovery_actor_disabled allHold init 10
  verify "$DELIVERY" recovery_delivery_fixed allHold init 10
  verify "$DELIVERY" recovery_capacity_fixed atMostOneTransferPerSlot init 10
  verify "$DELIVERY" recovery_reservation_fixed otherGuestsDoNotBlockRetry init 5
  verify "$DELIVERY" recovery_reservation_fixed oldCleanupNeverReleasesRetry init 5
  expect_violation "$DELIVERY" recovery_reservation_together otherGuestsDoNotBlockRetry 3
  expect_violation "$DELIVERY" recovery_reservation_unowned oldCleanupNeverReleasesRetry 4
  expect_violation "$DELIVERY" recovery_capacity_before atMostOneTransferPerSlot 4
  expect_violation "$DELIVERY" recovery_delivery_before onlyDeliveredStatesAreAcknowledged 2
  expect_violation "$DELIVERY" recovery_delivery_before everyUnsettledGuestRemainsPending 3
  expect_violation "$DELIVERY" recovery_delivery_before aRateLimitedJoinNeverHealsOutsideRoster 3
  local ESCP=specs/escalation_push.qnt
  verify "$ESCP" escalation_push_fixed allHold init 12
  verify "$ESCP" sync_base_fixed noDeltaOnAForeignBase init 8
  verify "$ESCP" hole_counts_fixed pushesAreBoundedForEveryHole init 10
  # Queued behind a transfer in flight, let go on the first round's timer.
  expect_violation "$ESCP" escalation_push_current noLetGoOfAPushOnItsWay 3
  expect_violation "$ESCP" escalation_push_timer_let_go noLetGoOfAPushOnItsWay 6
  # A transfer still making progress at the second round's backstop.
  expect_violation "$ESCP" escalation_push_round_two noLetGoOfAPushOnItsWay 9
  expect_violation "$ESCP" escalation_push_backstop noLetGoOfAPushOnItsWay 9
  # The third round's global, chunks-only clock: a silent transfer kept alive
  # by another guest's syncs; a transfer ahead failing at its own limit not
  # counted as the chain moving.
  expect_violation "$ESCP" escalation_push_round_three aLostPushIsLetGo 7
  expect_violation "$ESCP" escalation_push_round_three noLetGoOfAPushOnItsWay 7
  # Handed over, its report held by another guest's transfer, let go.
  expect_violation "$ESCP" escalation_push_reported_together noLetGoOfAPushOnItsWay 7
  # The transfer ahead of the push handed over, the deadline due before the
  # push is.
  expect_violation "$ESCP" escalation_push_any_hand_over noRetryBeforeTheGuestCouldAnswer 5
  # Handed over, the host frozen past the deadline.
  expect_violation "$ESCP" escalation_push_no_credit noRetryBeforeTheGuestCouldAnswer 7
  # Two transfers fail for one hole and it is escalated a third time.
  expect_violation "$ESCP" escalation_push_count_resets pushesAreBoundedPerHole 10
  # A state to one guest, then a delta to the other.
  expect_violation "$ESCP" sync_base_current noDeltaOnAForeignBase 3
  expect_violation "$ESCP" sync_base_esc_clears noDeltaOnAForeignBase 3
  # Two holes in turn, one record between them.
  expect_violation "$ESCP" hole_counts_one_record pushesAreBoundedForEveryHole 5
}

reconnect_inputs() {
  local REC=specs/reconnect_inputs.qnt
  verify "$REC" reconnect_inputs_fixed allHold init 12
  # Right after the reset, one frame run on the peer's missing input with
  # the C slot inactive (runBeforeFirstInputTest): 1 step.
  expect_violation "$REC" reconnect_inputs_current theHostNeverPredictsAFrameThePeerHasMade 2
}

drop_is_final() {
  local DROP=specs/drop_is_final.qnt
  verify "$DROP" drop_is_final_fixed allHold init 10
  # A give-up, then the health check adds the player back outside the
  # roster: 2 steps (desyncThenHealTest).
  expect_violation "$DROP" drop_is_final_before aDroppedPlayerComesBackOnlyAsALateJoiner 3
  # #286 as first written: both pages give up on a dead link, the guest
  # plays on alone (reconnectGiveUpTest): 2 steps; a guest that dropped
  # another guest blocks that link (guestGuestTest): 1 step.
  expect_violation "$DROP" drop_is_final_skip_everywhere aPageThatLostTheHostDoesNotPlayAlone 3
  expect_violation "$DROP" drop_is_final_skip_everywhere guestLinksCanHeal 2
}

rom_identity() {
  local ROM_IDENTITY=specs/rom_identity.qnt
  verify "$ROM_IDENTITY" rom_identity_current allHold
  # No start took the guest's word for the host's previous ROM even while the
  # host's drop said nothing: the host's Start waits for its own hash, and
  # the server drops every guest's word when that hash lands.
  verify "$ROM_IDENTITY" rom_identity_host_silent aStartCountsOnlyTheHostsRom
  # A wrong ROM hashed, the host's dropped over it, the host's ROM arrives:
  # 4 steps (rightOverWrongTest).
  expect_violation "$ROM_IDENTITY" rom_identity_before aRightRomStays
  # A drop, the host's ROM picked from the library, the drop's hash lands:
  # 3 steps (pickWhileHashingTest).
  expect_violation "$ROM_IDENTITY" rom_identity_judge_only aSettledRomKeepsItsHash
  # The host's ROM hashed and heard, the host's ROM known, a wrong one
  # dropped, Start: 5 steps (startWhileHashingTest).
  expect_violation "$ROM_IDENTITY" rom_identity_no_retract aStartCountsOnlyTheLoadedRom
  # The host sharing, its ROM known, a wrong one the same size dropped, Start,
  # the start reaching the page: 4 steps (bootWhileHashingTest).
  expect_violation "$ROM_IDENTITY" rom_identity_first_push neverBootsAWrongRom
  # The host's ROM known, the host drops another, Start: 3 steps
  # (hostStartsWhileHashingTest).
  expect_violation "$ROM_IDENTITY" rom_identity_first_push theHostStartsOnItsOwnHash
  # A drop whose hash fails: 2 steps (hashFailsTest).
  expect_violation "$ROM_IDENTITY" rom_identity_first_push aSettledRomKeepsItsHash
  # A rejoin while the drop is hashed is 7 steps, past the bound: its scenario
  # (rejoinWhileHashingTest) checks it.
  # The host's ROM known, the host's ROM picked from the library, the host
  # drops another, Start: 4 steps (hostChangesThenStartsTest).
  expect_violation "$ROM_IDENTITY" rom_identity_first_push aStartCountsOnlyTheHostsRom
  # The host's ROM known, the host drops another, the guest picks that one
  # from the library and refuses it against the host's previous ROM: 3 steps
  # (hostChangesToTheGuestsRomTest drops it instead).
  expect_violation "$ROM_IDENTITY" rom_identity_host_silent aRightRomStays
  # The host's ROM known and the guest's ROM the host's, the host drops
  # another: the server still counts the guest ready on the previous one,
  # 3 steps (hostChangesAwayFromTheGuestsRomTest).
  expect_violation "$ROM_IDENTITY" rom_identity_host_silent theServerCountsOnlyTheHostsRom
  # The host's ROM known, the guest picks another from the library and it is
  # refused, the host changes to that one and its hash lands: the page holds
  # none with the host's ROM in its library, 4 steps (guestDroppedFirstTest
  # drops it instead).
  expect_violation "$ROM_IDENTITY" rom_identity_no_library theHostsRomComesFromTheLibrary
  # The same, with the dropped file's copy landing after the room names the
  # host's ROM (cacheLandsLateTest).
  expect_violation "$ROM_IDENTITY" rom_identity_no_cache_lookup theHostsRomComesFromTheLibrary
}

start_group() {
  local START_GROUP=specs/start_group.qnt
  verify "$START_GROUP" start_group_current allHold
  verify "$START_GROUP" start_group_deadline_only allHold
  # A room of two, the guest frozen, three deadlines: 4 steps (aFrozenGuestTest).
  expect_violation "$START_GROUP" start_group_before neverStuck
  # A room of three, one guest answers and loads, the other frozen: 3 steps
  # (aThirdPlayerFrozenTest).
  expect_violation "$START_GROUP" start_group_give_up_only neverStuck
  # The same, the frozen guest left out but the other guest not told, and no
  # load deadline (anOldGuestTest); or a sync that times out with no deadline
  # to go on, 5 steps (aSyncTimesOutTest).
  expect_violation "$START_GROUP" start_group_untold_no_load neverStuck
  # With the load deadline the host's match runs beside a page that ignores
  # `left-out:`.
  verify "$START_GROUP" start_group_untold neverStuck
  # But an old page can end in neither: its deadline went with a connection
  # that failed, 5 steps (aGuestLosesTheHostTest), or it is left out at the
  # load deadline and does not hear it (anOldGuestTest).
  expect_violation "$START_GROUP" start_group_untold nobodyIsInNeither
  # A room of two, the guest slow, three deadlines: 4 steps (aSlowGuestTest).
  expect_violation "$START_GROUP" start_group_no_rejoin nobodyIsInNeither
  # The same, and the last attempt opens after the give-up: 5 steps (aLateOpenTest).
  expect_violation "$START_GROUP" start_group_open_after_give_up nobodyIsInNeither
  # The same, and the guest's side fails instead: 5 steps (aGuestLosesTheHostTest).
  expect_violation "$START_GROUP" start_group_deadline_with_the_connection nobodyIsInNeither
  # A room of three, both answer, one is lost (aLostAfterTheSequenceTest), or,
  # with no load deadline, a sync that times out: 5 steps (aSyncTimesOutTest).
  expect_violation "$START_GROUP" start_group_lost_dropped neverStuck
  # A room of three, the guests apart, both load and the host syncs: 6 steps
  # (aPairApartTest); or a sync that times out, 5.
  expect_violation "$START_GROUP" start_group_apart_unarbitrated neverStuck
  # #277's first push: the guest loads, the host syncs, the sync times out,
  # and the deadline, run once, finds nobody behind and does not go on with
  # the start: 6 steps (aSyncTimesOutTest).
  expect_violation "$START_GROUP" start_group_deadline_once neverStuck
  # One deadline time for every player: the guest still taking the host's
  # state in is cut, 5 steps (aSlowStateTest).
  expect_violation "$START_GROUP" start_group_absolute_deadline aPlayerMakingProgressStays
  # start_group_resync's counterexample (aReadyThenATimeoutTest: a guest says
  # it is ready, the other is slow, the sync times out, the host syncs again)
  # is 11 steps, past this bound: check-specs.sh runs that scenario. So is
  # start_group_running_ignores_left_out's (aReadyCrossesTheCutTest: the
  # guest's ready crosses the cut, its match runs, it hears it is out), 10.
}

mesh_heal() {
  local MESH=specs/mesh_heal.qnt
  verify "$MESH" mesh_heal_fixed allHold init 10
  verify "$MESH" mesh_heal_fixed_guest_lower allHold init 10
  # The link dies, both channels read closed, both sides go stale to
  # phantoms, and nothing will act: 5 steps (phantomForeverTest). The same
  # with the check on C ticks but skipping phantoms: 5 steps. (Without the
  # reset at open, the second request takes 7 steps: secondRequestTest.)
  expect_violation "$MESH" mesh_heal_current aDeadChannelIsNeverForgotten
  expect_violation "$MESH" mesh_heal_c_tick_only aDeadChannelIsNeverForgotten
  # A lower slot that is not the host goes phantom, heals with a fresh
  # entry, and the reconnect opens without its asking the host: 5 steps
  # (nonHostLowerTest).
  expect_violation "$MESH" mesh_heal_fresh_entry aNonHostLowerResyncsAfterAHeal
}

ring_after_resync() {
  local RING=specs/ring_after_resync.qnt
  verify "$RING" ring_after_resync_current allHold
  # Two frames run, the resync for the second, that frame run again: 4 steps
  # (oneFrameBackTest).
  expect_violation "$RING" ring_after_resync_before everyRerunFrameIsTheHosts
  # A frame saved and not run, the resync for it, the frame run: 4 steps
  # (savedFrameDidNotRunTest). The same one frame back, saved again against
  # the page's own copy as the sparse baseline: 4 steps (oneFrameBackTest).
  expect_violation "$RING" ring_after_resync_save_only everyRerunFrameIsTheHosts
  expect_violation "$RING" ring_after_resync_save_only everyCopyIsWhole
}

solo_save() {
  local SOLO=specs/solo_save.qnt
  # The keep-baseline counterexample is 7 steps; check the gate past it.
  verify "$SOLO" solo_save_current allHold init 8
  # The friend's first input, two frames, the next input wrong, before the
  # roster lists them: join, feed, tick, tick, feed (5 steps;
  # inputBeforeRosterTest).
  expect_violation "$SOLO" solo_save_roster noTargetLostToTheGate
  # A save, the other player leaves, a skipped frame, they come back, the
  # next save: 7 steps (firstSaveAfterAStretchTest).
  expect_violation "$SOLO" solo_save_keep_baseline everyCopyIsWhole 8
}

engine_start() {
  local START=specs/engine_start.qnt
  verify "$START" engine_start_current allHold
  # A tab that comes back while its page waits moves the page's frame:
  # start, GO, lose the delay, reopen, arm, a frame, the return, the start
  # frame (8 steps; tabReturnWhileWaitingTest).
  expect_violation "$START" engine_start_before theHostsStartIsWhereTheGuestIs 8
  expect_violation "$START" engine_start_jump_on_return aGuestStopsOnlyWhenTheHostIsUnreachable 8
  # A solo match: start, arm, one frame (3 steps; soloTest).
  expect_violation "$START" engine_start_before everyFrameRunsOnTheCEngine
  # A guest that hears nothing: start, three ticks, the deadline (5 steps).
  expect_violation "$START" engine_start_before armsWithTheHostsDelay
  # engine_start_stop_only's counterexample needs a close, an open and the
  # whole wait (9 steps): check-specs.sh's random runs find it.
  # A friend joins a solo match with no bridge window at 0: start alone, arm,
  # join late (3 steps; lateJoinIntoSoloTest).
  expect_violation "$START" engine_start_no_zero_bridge aGuestStopsOnlyWhenTheHostIsUnreachable
  # A friend joins a solo match and plays at 0: start alone, arm, join late
  # (3 steps; lateJoinIntoSoloTest).
  expect_violation "$START" engine_start_no_rearm aJoinedMatchRunsAboveZero
}

session_log_store() {
  local STORE=specs/session_log_store.qnt
  # The counterexamples below are 5 steps or fewer; the change is checked
  # past them.
  verify "$STORE" session_log_store_current allHold
  # The shortest in one store: four lines in one flush, one row over the
  # store's cap, taking the other kind's line with it (5 steps). Over two
  # flushes it is 6 (jsLinesPushACLineOutTest, cLinesPushAJsLineOutTest).
  expect_violation "$STORE" session_log_store_before cLinesKeepTheirOwnRoom
  expect_violation "$STORE" session_log_store_before jsLinesKeepTheirOwnRoom
  # A C line, a JS line, a flush: the JS row before the C row (3 steps;
  # cLinesInTheMiddleOfAFlushTest).
  expect_violation "$STORE" session_log_store_per_flush readInOrder
  # Four JS lines in one flush, one row over the cap, deleted with no record
  # of it (5 steps; over two flushes, evictionIsRecordedTest).
  expect_violation "$STORE" session_log_store_unrecorded truncationIsVisible
  # Four lines alternating in one flush, one row each, past the bound of
  # three (5 steps; alternatingLinesTest).
  expect_violation "$STORE" session_log_store_unbounded rowsPerFlushBounded
}

# Every group, in the order a local run takes them.
log_archive() {
  local ARCHIVE=specs/log_archive.qnt
  # A match's log is readable from exactly one place, the archive is recorded
  # only once it is complete, and retention leaves nothing behind — with two
  # archivers at once, crashes at each step, an eviction batch that runs in
  # parts or again, and SQLite reusing ids. Checked as deep as the deepest
  # counterexample below (9 steps); 10 outlasts a CI job's 20 minutes.
  verify "$ARCHIVE" log_archive_current allHold init 9
  # Recorded before the uploads are confirmed, a failed upload leaves an
  # archived id R2 has nothing for (failedUploadTest).
  expect_violation "$ARCHIVE" log_archive_record_first archivedOnlyWhenComplete
  # An eviction batch that stops after its mark leaves the archived chunks in
  # D1; reading every chunk left there reads them twice: flush, window,
  # archive x3, hot, evict (7 steps; partialEvictionTest).
  expect_violation "$ARCHIVE" log_archive_read_all_tail logAlwaysReadable 7
  # Two archivers keyed by the chunk id alone share keys; the refused one
  # takes back the recorded one's objects: flush, window, begin x2, upload x2,
  # finish x2 (8 steps; twoArchiversAtOnceTest).
  expect_violation "$ARCHIVE" log_archive_key_by_through archivedOnlyWhenComplete 8
  # An archive that keeps its objects after finding the match tombstoned
  # leaves them behind for good (8 steps; deleteDuringArchiveTest).
  expect_violation "$ARCHIVE" log_archive_ignore_tombstone retentionLeavesNothing 8
  # Reading the archive alone after eviction, or evicting every chunk, loses
  # a chunk written after the archive (8 steps; lateChunkTest).
  expect_violation "$ARCHIVE" log_archive_archive_only logAlwaysReadable 8
  expect_violation "$ARCHIVE" log_archive_evict_all logAlwaysReadable 8
  # A DELETE by id alone, run again after a chunk reused an archived id,
  # takes it (9 steps; deleteAgainAfterReuseTest).
  expect_violation "$ARCHIVE" log_archive_delete_by_id_only logAlwaysReadable 9
  # Archiving and evicting into a store a deploy wipes (a local folder, no
  # R2) loses the log at the next deploy (8 steps; localStoreTest).
  expect_violation "$ARCHIVE" log_archive_any_store logAlwaysReadable 8
}

SPEC_GROUPS=(
  peer_identity rom_transfer room_lifecycle_start room_lifecycle_drops
  peer_connection streaming_connection late_join_pause resync_flow
  tick_deadlines resync_inputs resync_mesh input_transport resync_reask sync_follow_up
  rom_at_start rom_identity ring_after_resync start_group mesh_heal catch_up_wait ask_escalation escalation_push reconnect_inputs drop_is_final
  engine_start solo_save session_log_store log_archive
)

# CI runs one job per shard, in parallel (lint.yml, spec-verify). Shards are
# balanced by the minutes each group took on CI at 6 steps (Nov 2026): the
# whole set took 32 minutes in one job. A group added above goes in a shard
# here; the check below fails until it does.
SHARDS=(
  "room_lifecycle_start engine_start solo_save"                   # ~7 min + engine_start (~30 s) + solo_save (~40 s)
  "room_lifecycle_drops"                                          # ~8 min
  "streaming_connection resync_flow tick_deadlines resync_mesh mesh_heal drop_is_final log_archive" # ~7.5 min + log_archive (~1 min)
  "peer_identity rom_transfer peer_connection rom_at_start rom_identity catch_up_wait ask_escalation escalation_push" # ~8 min
  "late_join_pause resync_inputs input_transport resync_reask ring_after_resync sync_follow_up start_group reconnect_inputs session_log_store" # ~7.5 min + session_log_store (~3.5 min)
)

# Each group is in exactly one shard, and each shard names only groups.
sharded=$(printf '%s\n' ${SHARDS[@]} | sort)
if [ "$sharded" != "$(printf '%s\n' "${SPEC_GROUPS[@]}" | sort)" ]; then
  echo "SHARDS must list every group in SPEC_GROUPS exactly once" >&2
  exit 1
fi

case "${1:-}" in
  "") run=("${SPEC_GROUPS[@]}") ;;
  --shards) echo "${#SHARDS[@]}"; exit 0 ;;
  --shard)
    n="${2:?--shard needs a number}"
    if ! [[ "$n" =~ ^[0-9]+$ ]] || [ "$n" -lt 1 ] || [ "$n" -gt "${#SHARDS[@]}" ]; then
      echo "no shard $n: there are ${#SHARDS[@]}" >&2
      exit 1
    fi
    read -r -a run <<<"${SHARDS[$((n - 1))]}"
    ;;
  *) run=("$@") ;;
esac
for group in "${run[@]}"; do
  if ! printf '%s\n' "${SPEC_GROUPS[@]}" | grep -qx "$group"; then
    echo "no group $group (groups: ${SPEC_GROUPS[*]})" >&2
    exit 1
  fi
  "$group"
done
