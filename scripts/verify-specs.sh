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
#   verify-specs.sh GROUP...      the named groups
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

engine_start() {
  local START=specs/engine_start.qnt
  verify "$START" engine_start_current allHold
  verify "$START" engine_start_before theHostsStartIsWhereTheGuestIs
  # A solo match: start, arm, one frame (3 steps; soloTest).
  expect_violation "$START" engine_start_before everyFrameRunsOnTheCEngine
  # A guest that hears nothing: start, three ticks, the deadline (5 steps).
  expect_violation "$START" engine_start_before armsWithTheHostsDelay
  # engine_start_stop_only's counterexample needs a close, an open and the
  # whole wait (9 steps): check-specs.sh's random runs find it.
}

# Every group, in the order a local run takes them.
SPEC_GROUPS=(
  peer_identity rom_transfer room_lifecycle_start room_lifecycle_drops
  peer_connection streaming_connection late_join_pause resync_flow
  tick_deadlines resync_inputs resync_mesh input_transport resync_reask sync_follow_up
  rom_at_start ring_after_resync start_group mesh_heal engine_start
)

# CI runs one job per shard, in parallel (lint.yml, spec-verify). Shards are
# balanced by the minutes each group took on CI at 6 steps (Nov 2026): the
# whole set took 32 minutes in one job. A group added above goes in a shard
# here; the check below fails until it does.
SHARDS=(
  "room_lifecycle_start"                                          # ~7 min
  "room_lifecycle_drops"                                          # ~8 min
  "streaming_connection resync_flow tick_deadlines resync_mesh mesh_heal" # ~7 min
  "peer_identity rom_transfer peer_connection rom_at_start engine_start" # ~6.5 min + engine_start
  "late_join_pause resync_inputs input_transport resync_reask ring_after_resync sync_follow_up start_group" # ~7 min
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
