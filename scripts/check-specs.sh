#!/usr/bin/env bash
# Model-check the Quint specs in specs/.
#
# The built-in (typescript) backend is used so nothing is downloaded at run
# time; the default backend fetches a binary on first use.
set -euo pipefail
cd "$(dirname "$0")/.."

SPEC=specs/room_lifecycle.qnt
# Every invocation below belongs to exactly one shard. Split the run/test/
# typecheck streams separately, so cheap typechecks do not displace expensive
# simulations. New checks are included automatically, without a second list.
# No arguments runs the entire suite, as before.
shard=1
shards=1
list=false
if [ "${1:-}" = --list ]; then
  list=true
  shift
fi
if [ "$#" -ne 0 ]; then
  if [ "$#" -ne 3 ] || [ "$1" != --shard ] ||
    ! [[ "$2" =~ ^[1-9][0-9]{0,2}$ && "$3" =~ ^[1-9][0-9]{0,2}$ ]] ||
    [ "$2" -gt "$3" ] || [ "$3" -gt 256 ]; then
    echo "usage: $0 [--list] [--shard N COUNT] (1 <= N <= COUNT <= 256)" >&2
    exit 2
  fi
  shard=$2
  shards=$3
fi
selected=0
declare -A counts=()
quint_check() {
  local kind="$1" index="${counts[$1]:-0}"
  counts[$kind]=$((index + 1))
  if [ "$((index % shards + 1))" -ne "$shard" ]; then
    return 0
  fi
  selected=$((selected + 1))
  if "$list"; then
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  printf '== quint '; printf '%q ' "$@"; printf '\n'
  local started=$SECONDS
  npx --no-install quint "$@"
  echo "== completed in $((SECONDS - started))s"
}
QUINT=quint_check

$QUINT typecheck "$SPEC"

# Scenario tests: today's code and the three earlier variants (the scenarios
# show what each fix changed).
$QUINT test "$SPEC" --main=room_current --backend=typescript
$QUINT test "$SPEC" --main=room_before_grace_wait --backend=typescript
$QUINT test "$SPEC" --main=room_before_abandoned_end --backend=typescript
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
# A playing room nobody is running is ended by the server (violated on
# room_before_abandoned_end).
check room_current anAbandonedMatchIsEnded
# A signaling outage that hits every player does not cost them the match:
# the grace window never empties a playing room whose last player is still
# in it (violated on room_before_grace_wait).
check room_current aMatchIsNotLostToTheGraceWindow

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
for variant in rom_transfer_before rom_transfer_short_kept rom_transfer_nothing_received_waits \
  rom_transfer_retry_outlives_sharing rom_transfer_current; do
  $QUINT test "$ROM" --main="$variant" --backend=typescript
done
# Today: every waiting state has a running timer or a Retry button. Violated
# before the request sent over the engine channel was given a deadline. And
# what the receiver counts is what the page holds; violated while a short
# file kept its count (rom_transfer_short_kept). And the guest is asked to
# press Retry only once its automatic retries are used up or the host stopped
# sharing; violated while a transfer with nothing received was not resumed
# after a close or the host sharing again (rom_transfer_nothing_received_waits;
# closedBeforeAnyByteTest, sharingAgainBeforeAnyByteTest). And nothing asks
# the host again by itself once it stopped sharing; violated while sharing off
# did not cancel a retry the guest's close had scheduled first
# (rom_transfer_retry_outlives_sharing; closeBeforeSharingOffTest).
for invariant in waitingHasAWayOut timersAloneStop countIsHeld retriesBeforeAsking noRetryWhileHostStopped; do
  $QUINT run "$ROM" --main=rom_transfer_current --invariant="$invariant" \
    --max-samples=20000 --max-steps=25 --backend=typescript
done
# ── A game start: a page never boots without a ROM ───────────────────────────
ROM_START=specs/rom_at_start.qnt
$QUINT typecheck "$ROM_START"
for variant in rom_at_start_before rom_at_start_clear_only rom_at_start_no_rejoin rom_at_start_current; do
  $QUINT test "$ROM_START" --main="$variant" --backend=typescript
done
# Today: the server knows whether a page has a ROM once its messages are in,
# a page never boots without one, and a page a started game left out is
# asked for one. The first was VIOLATED while clearing a ROM told the server
# nothing (rom_at_start_before; deletedRomTest), and while a page that
# rejoined without a ROM said nothing (rom_at_start_no_rejoin;
# clearedWhileDownTest); the second while the start plan answered `play`
# without a ROM, even once clearing told the server (rom_at_start_clear_only;
# startBeforeTheClearArrivesTest).
$QUINT run "$ROM_START" --main=rom_at_start_current --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript

# ── A game start: who a page waits for before its match runs ─────────────────
START_GROUP=specs/start_group.qnt
$QUINT typecheck "$START_GROUP"
for variant in start_group_before start_group_give_up_only start_group_untold_no_load start_group_untold \
  start_group_deadline_only start_group_no_rejoin start_group_open_after_give_up \
  start_group_deadline_with_the_connection start_group_lost_dropped start_group_apart_unarbitrated \
  start_group_deadline_once start_group_absolute_deadline start_group_resync \
  start_group_running_ignores_left_out start_group_current; do
  $QUINT test "$START_GROUP" --main="$variant" --backend=typescript
done
# Today: a host that has started a game always has a way on, a late joiner
# is held as one, and a running match waited for no silent player. The first
# was VIOLATED while the startup watchdog's give-up waited on
# (start_group_before; aFrozenGuestTest: in a room of two the host never
# started), and while the deadline stopped once the game sequence had started
# (start_group_give_up_only; aThirdPlayerFrozenTest), and while the host
# told the other players nobody it left out and had no load deadline
# (start_group_untold_no_load; anOldGuestTest: the other guest waited for the
# frozen one, and the host for that guest). With the load deadline the host's
# match runs even beside pages that ignore `left-out:`, ones from before it
# existed (start_group_untold holds neverStuck), though such a page can end in
# neither the start nor the late join until it reloads. Nobody alive is in
# neither the start nor the late join: VIOLATED while a left-out page that had
# started normally waited for the host's offer for ever (start_group_no_rejoin;
# aSlowGuestTest), while the give-up left the connection open to complete later
# (start_group_open_after_give_up; aLateOpenTest), and while the guest's
# deadline went with a connection that failed
# (start_group_deadline_with_the_connection; aGuestLosesTheHostTest). The host
# never stuck: VIOLATED while a connection lost after the game sequence had
# started was dropped without a word (start_group_lost_dropped;
# aLostAfterTheSequenceTest), and while two guests that could not reach each
# other waited for each other with nobody deciding (start_group_apart_unarbitrated;
# aPairApartTest), and while the load deadline ran once and a sync that timed
# out sent the host back to an emu-ready wait nothing looked at again
# (start_group_deadline_once; aSyncTimesOutTest). No player making progress
# is left out: VIOLATED while the load deadline was one time for every player
# (start_group_absolute_deadline; aSlowStateTest: a guest still taking the
# host's state in was cut) and while the host synced again after a timeout
# (start_group_resync; aReadyThenATimeoutTest: a guest that had said it was
# ready never said so again, and was cut). A guest the host left out runs no
# match of its own once it has heard so: VIOLATED while a page whose match
# ran ignored the word (start_group_running_ignores_left_out;
# aReadyCrossesTheCutTest: its ready crossed the host's cut at the barrier).
# It all holds without the ROM prompt's word too (start_group_deadline_only),
# only later.
for variant in start_group_deadline_only start_group_current; do
  $QUINT run "$START_GROUP" --main="$variant" --invariant=allHold \
    --max-samples=20000 --max-steps=25 --backend=typescript
done
$QUINT run "$START_GROUP" --main=start_group_untold --invariant=neverStuck \
  --max-samples=20000 --max-steps=25 --backend=typescript

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

# ── Peer connection: one pair of pages, offers and answers between them ─────
PAIR=specs/peer_connection.qnt
$QUINT typecheck "$PAIR"
# The scenarios say what each variant does with the same ordering.
for variant in peer_connection_before_119 peer_connection_before_startup_flag peer_connection_current \
  peer_connection_heal_one_side peer_connection_counter_only peer_connection_fixed; do
  $QUINT test "$PAIR" --main="$variant" --backend=typescript
done
pair() { # module invariant init
  $QUINT run "$PAIR" --main="$1" --invariant="$2" --init="$3" \
    --max-samples=10000 --max-steps=25 --backend=typescript
}
# Today: a reconnect leaves the guest's input state clean, a roster update
# never replaces a connection that is up, and a startup retry is never
# handled as a gameplay reconnect. The other four properties are violated
# today (the scenarios above show how) and hold on peer_connection_fixed, the
# rules the per-peer machine is built to.
pair peer_connection_current holdToday init
pair peer_connection_current holdToday initLobby
# startupRetryIsNotAReconnect was VIOLATED, from the lobby, while the server
# dropped the startupReconnect flag (peer_connection_before_startup_flag): a
# startup retry that reaches a page whose game has started (its channel with
# a third player opened) is taken for a reconnect
# (startupRetryToAStartedPageTest).
pair peer_connection_fixed allHold init
pair peer_connection_fixed allHold initLobby
# The per-peer machine deciding `heal` alone (the lower slot's health check
# offers, the higher slot's notices a drop): what holds today, and the pair
# no longer offers to each other at once or is left with nothing pending. A
# new higher slot meeting an old lower slot during a deploy is this module;
# an old higher slot with either is peer_connection_current.
pair peer_connection_heal_one_side holdWithHealOneSide init
pair peer_connection_heal_one_side holdWithHealOneSide initLobby
# With attempts told apart by the offering page's counter alone (the per-peer
# machine as first written), staleSignalsAreNotApplied is VIOLATED: a page
# that replaces another numbers its offers from 1 again, and what was sent for
# the old page's attempt passes for the new one's
# (oldAnswerTakenByReplacementPageTest, oldCandidateReachesReplacementConnectionTest).
# The other five still hold there. peer_connection_fixed names the page
# beside the counter. A page from before signals carried an attempt
# (`reloadOld`) sends none; only pages that check labels are held to
# staleSignalsAreNotApplied, and oldPageAnswersWithNoLabelTest shows that a
# page that checks them never connects to an old one.
pair peer_connection_counter_only holdWithACounterAlone init
pair peer_connection_counter_only holdWithACounterAlone initLobby

# ── Streaming connection: the host and the pages it streams to ──────────────
STREAM=specs/streaming_connection.qnt
$QUINT typecheck "$STREAM"
# The scenarios say what each variant does with the same ordering.
for variant in streaming_connection_before_220 streaming_connection_before_reoffer streaming_connection_current; do
  $QUINT test "$STREAM" --main="$variant" --backend=typescript
done
stream() { # module invariant init
  $QUINT run "$STREAM" --main="$1" --invariant="$2" --init="$3" \
    --max-samples=10000 --max-steps=25 --backend=typescript
}
# Today every property holds. Before the host had a deadline to offer again
# and signals named their connection (streaming_connection_before_reoffer),
# two were VIOLATED (the scenarios above show how):
# neverLeftWithNothingPending (a dropped connection was forgotten on both
# pages and nothing offered again, droppedGuestTest) and
# staleSignalsAreNotApplied (an offer for a new connection was applied to the
# old one, newConnectionTakenAsRenegotiationTest). receiversConnectOnlyToTheHost
# was VIOLATED before #220, when a page answered any member's offer
# (streaming_connection_before_220, strayOfferTest).
stream streaming_connection_current allHold init
stream streaming_connection_current allHold initLate

# ── The pause around a late join ────────────────────────────────────────────
PAUSE=specs/late_join_pause.qnt
$QUINT typecheck "$PAUSE"
for variant in late_join_pause_before late_join_pause_host_side late_join_pause_before_resync \
  late_join_pause_marker_at_send late_join_pause_current; do
  $QUINT test "$PAUSE" --main="$variant" --backend=typescript
done
# Today: the game stays paused while a joiner has yet to load, a joiner who
# is playing is never disconnected, the host's pause has a deadline that a
# repeated request does not push back, a paused guest resumes on the host's
# word or at its own deadline, and so does a joiner, including one made a
# player while the host is paused for another (it waits with the rest). The
# first three were violated before the pause belonged to the joiners being
# served (late_join_pause_before); the guest's with only the host's side
# changed (late_join_pause_host_side). And a joiner that lost its channel
# to the host during its serve is not made a player on a state the host has
# run past without a resync on its way: violated before the joiner resynced
# (late_join_pause_before_resync; joinerLosesTheHostAfterTheStateIsSentTest,
# timerFiresWhileTheStateIsOnItsWayTest), and again while the joiner's
# marker went with its first request: one that went unanswered left it
# behind for good (late_join_pause_marker_at_send;
# resyncRequestUnansweredTest). Today the marker stays until a state is
# applied, the joiner asks again, and gives up visibly after three.
$QUINT run "$PAUSE" --main=late_join_pause_current --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript
$QUINT run "$PAUSE" --main=late_join_pause_marker_at_send --invariant=holdBeforeTheResyncFix \
  --max-samples=20000 --max-steps=25 --backend=typescript
$QUINT run "$PAUSE" --main=late_join_pause_before_resync --invariant=holdBeforeTheResyncFix \
  --max-samples=20000 --max-steps=25 --backend=typescript

# ── A resync from request to apply ──────────────────────────────────────────
FLOW=specs/resync_flow.qnt
$QUINT typecheck "$FLOW"
for variant in resync_flow_before resync_flow_any_answer resync_flow_frame_named resync_flow_drop_older \
  resync_flow_asked_from resync_flow_unnumbered resync_flow_rewinds resync_flow_current; do
  $QUINT test "$FLOW" --main="$variant" --backend=typescript
done
# A guest stopped at its target has a deadline, a state no newer than the
# last one applied is never applied, and a request that is out can always
# end. The last was violated before the request had a deadline of its own
# (resync_flow_before): the host drops a request inside its rate limit and
# the guest never asked again. These held before requests were numbered too.
$QUINT run "$FLOW" --main=resync_flow_any_answer --invariant=holdWithoutNumbers \
  --max-samples=20000 --max-steps=25 --backend=typescript
# And only its own answer ends a request, a late answer does not take the
# guest back (below its frame, or below the frame its newest request named,
# at the target or after the target's deadline), and a late answer does not
# take the place of the awaited one. All three were violated before a
# request had a number its answer carries (resync_flow_any_answer;
# lateAnswerTest, lateAnswerAfterTheTargetDeadlineTest and
# lateAnswerOverTheAwaitedOneTest hold the orderings). The second was
# violated too while only the frame a request named was checked
# (resync_flow_frame_named; immediateLateAnswerTest), is by rule b
# (resync_flow_asked_from; lateAnswerFromAfterTheAskTest), and was while the
# boot sync and the input stall's request went out with no number
# (resync_flow_unnumbered; bootAnswerAfterANewerRequestTest). Nor is the guest
# rewound by any state, its own request's answer included, which it was before
# it caught up from a state behind it (resync_flow_rewinds; ownAnswerBehindTest).
$QUINT run "$FLOW" --main=resync_flow_current --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript
# Rule a, not taken, holds them too; it drops the only state coming in
# onlyStateComingTest.
$QUINT run "$FLOW" --main=resync_flow_drop_older --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript

# ── The tick loop's deadlines and a page that freezes ───────────────────────
TICK=specs/tick_deadlines.qnt
$QUINT typecheck "$TICK"
for variant in tick_deadlines_before tick_deadlines_before_lockstep_mode tick_deadlines_current; do
  $QUINT test "$TICK" --main="$variant" --backend=typescript
done
# Today: a page's own freeze is never held against its peer. Violated before
# the pacing-throttle deadline was credited (tick_deadlines_before).
$QUINT run "$TICK" --main=tick_deadlines_current --invariant=ownFreezeIsNotHeldAgainstAPeer \
  --max-samples=20000 --max-steps=25 --backend=typescript
# Today: no wait outlasts its deadline without one. Violated before the
# lockstep wait had one (tick_deadlines_before_lockstep_mode).
$QUINT run "$TICK" --main=tick_deadlines_current --invariant=everyWaitHasADeadline \
  --max-samples=20000 --max-steps=25 --backend=typescript
# A state transfer and the host's inputs behind it on one connection.
for variant in input_link_burst input_link_paced_unguarded input_link_paced_whole_deadline input_link_paced; do
  $QUINT test "$TICK" --main="$variant" --backend=typescript
done
# With the chunks handed over one at a time, a host that is sending is never
# given up on and none of its inputs arrives deeper than the cap. Both were
# VIOLATED while a state went into the connection all at once
# (input_link_burst; twoAnswersBackToBackTest holds the ordering of the
# two-player run that found it).
# Also: a transfer queued before a reconnect never reaches the new
# connection, and the guest's inputs are settled only for a state that was
# sent. Both VIOLATED by #236 as first written (input_link_paced_unguarded;
# transferQueuedBeforeAResetTest and abandonedTransferTest hold the orderings).
# And: a transfer still arriving is not given up by the guest, and the host
# hands over no chunk of a transfer the guest told it it dropped. Both
# VIOLATED while the guest's chunk deadline ran over the whole state
# (input_link_paced_whole_deadline; progressingTransferAbandonedTest).
$QUINT run "$TICK" --main=input_link_paced --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript


# ── Inputs around a resync: what a page may wait for afterwards ─────────────
RESYNC=specs/resync_inputs.qnt
$QUINT typecheck "$RESYNC"
for variant in resync_inputs_before resync_inputs_solo_holes resync_inputs_only_new \
  resync_inputs_no_refeed resync_inputs_no_ask resync_inputs_current; do
  $QUINT test "$RESYNC" --main="$variant" --backend=typescript
done
# Today: after a resync nobody waits for an input that cannot arrive, and the
# two pages are never both waiting on nothing. Both were violated before a
# resync settled the inputs from before its frame (resync_inputs_before): a
# resync that moved the guest forward left holes on both pages. A page also
# applies for itself what it sent: violated while a page that ran alone did
# not keep its own inputs (resync_inputs_solo_holes).
# The guest's inputs for the frames a resync moves it over all reach the host:
# violated while it sent only the ones it had never made
# (resync_inputs_only_new).
# And the guest applies them itself: violated while a resync did not hand its
# engine the ones it already had, which the engine's ring may have written
# over (resync_inputs_no_refeed).
# A due resync is never left to its deadline: violated while a page waiting
# on inputs it had dropped as out of range did not ask for them
# (resync_inputs_no_ask; guestWaitsOnInputsItDroppedTest holds the ordering).
$QUINT run "$RESYNC" --main=resync_inputs_current --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript

# The same from a third page's side, and across matches.
MESH=specs/resync_mesh.qnt
$QUINT typecheck "$MESH"
for variant in resync_mesh_untold resync_mesh_kept resync_mesh_current; do
  $QUINT test "$MESH" --main="$variant" --backend=typescript
done
# Today: no page waits on a hole the moved guest will never fill (violated
# while only the host was told the settled point, resync_mesh_untold), and
# the settled point never runs ahead of the inputs still to be made (violated
# while a new match kept the last one's, resync_mesh_kept).
$QUINT run "$MESH" --main=resync_mesh_current --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript

# ── Inputs on the unreliable channel, and the switch to the reliable one ────
INPUTS=specs/input_transport.qnt
$QUINT typecheck "$INPUTS"
for variant in input_transport_before_ask input_transport_current input_transport_until_acked \
  input_transport_resend_once input_transport_fixed; do
  $QUINT test "$INPUTS" --main="$variant" --backend=typescript
done
# Today with the fix: every input the peer had not acked when the page
# switched to the reliable channel reaches it without the peer asking, and
# no input is lost for good. The first was violated while the switch let the
# history go (input_transport_current; lostThenFallbackTest and
# lostThenChannelClosesTest hold the orderings), and is with redundancy kept
# until the ack instead (input_transport_until_acked;
# stuckChannelBeyondTheCapTest). The second was violated before #235, when
# the peer did not ask for a hole (input_transport_before_ask). The first is
# violated too when a send that throws partway through the resend drops the
# frames after it (input_transport_resend_once; resendFailsPartwayTest).
$QUINT run "$INPUTS" --main=input_transport_fixed --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript
$QUINT run "$INPUTS" --main=input_transport_current --invariant=noInputIsLostForGood \
  --max-samples=20000 --max-steps=25 --backend=typescript

# ── A "now" resync request asked again at its deadline ─────────────────────
REASK=specs/resync_reask.qnt
$QUINT typecheck "$REASK"
for variant in resync_reask_current resync_reask_unguarded resync_reask_guard_lets_go resync_reask_coordinated_let_go \
  resync_reask_fixed; do
  $QUINT test "$REASK" --main="$variant" --backend=typescript
done
# With the fix: an owed resync is asked for again or given up visibly, the
# deadline does not cut an answer being decoded, and the asks again are
# bounded. Today the deadline let the request go and asked nothing
# (resync_reask_current; lateAnswerBehindTest, lostRequestTest); asking again
# without holding the deadline while an answer decodes cuts it
# (resync_reask_unguarded; askAgainCutsTheDecodeTest), and the lifecycle
# guard's timeout letting the request go forgets it again
# (resync_reask_guard_lets_go; guardLetsGoOfTheAskAgainTest), and a request
# coordinated at a frame was never owed, so its lost answer was let go
# (resync_reask_coordinated_let_go; coordinatedAnswerLostTest).
$QUINT run "$REASK" --main=resync_reask_fixed --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript

# ── The follow-up to an answer sent unconfirmed ────────────────────────────
FOLLOW=specs/sync_follow_up.qnt
$QUINT typecheck "$FOLLOW"
for variant in sync_follow_up_current sync_follow_up_from_send sync_follow_up_fixed; do
  $QUINT test "$FOLLOW" --main="$variant" --backend=typescript
done
# With the fix: a follow-up goes out only for a state an input changed after
# it was taken, the guest ends on the host's state, and at most one answer is
# on the channel. Today every unconfirmed answer is followed up
# (sync_follow_up_current; unchangedFollowUpTest); recording the change from
# the send only misses one made while the state is compressed
# (sync_follow_up_from_send; mispredictWhileCompressingTest).
$QUINT run "$FOLLOW" --main=sync_follow_up_fixed --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript

# ── A channel that dies in a match with no event ───────────────────────────
MESH=specs/mesh_heal.qnt
$QUINT typecheck "$MESH"
for variant in mesh_heal_current mesh_heal_c_tick_only mesh_heal_no_reset_on_open mesh_heal_fresh_entry \
  mesh_heal_fixed mesh_heal_fixed_guest_lower; do
  $QUINT test "$MESH" --main="$variant" --backend=typescript
done
# Today a C-rollback tick never reaches the mesh health check, so a channel
# that dies with no event leaves a phantom for the rest of the match
# (mesh_heal_current; phantomForeverTest). Run on C ticks but still skipping
# phantoms it rarely acts, since frames are frozen until the player is one
# (mesh_heal_c_tick_only). Without the guest's reset when the reconnected
# channel opens, PEER-RECOVERED asks for a second resync
# (mesh_heal_no_reset_on_open; secondRequestTest). A lower slot that is not
# the host made a fresh entry when it healed, so it played on from its
# predictions instead of asking the host for state (mesh_heal_fresh_entry;
# nonHostLowerTest).
for variant in mesh_heal_fixed mesh_heal_fixed_guest_lower; do
  $QUINT run "$MESH" --main="$variant" --invariant=allHold \
    --max-samples=20000 --max-steps=20 --backend=typescript
done

# ── The rollback ring across a resync that loads the host's state ─────────
RING=specs/ring_after_resync.qnt
$QUINT typecheck "$RING"
for variant in ring_after_resync_before ring_after_resync_save_only ring_after_resync_current; do
  $QUINT test "$RING" --main="$variant" --backend=typescript
done
# Today: every frame a page runs again after a resync has the host's state in
# its ring, each ring copy is of the frame it is filed under, and the sparse
# save mode can rebuild every copy. The first was VIOLATED while kn_set_frame
# kept the last save: a resync landing one frame behind the page left the
# page's own copy of that frame (ring_after_resync_before; oneFrameBackTest
# holds the ordering, which a two-player run found at frame 1021 in #232).
# It was VIOLATED too while the page skipped kn_set_frame for a state of the
# frame it was on, after kn_pre_tick had saved that frame and it did not run
# (ring_after_resync_save_only; savedFrameDidNotRunTest). The last was
# VIOLATED while kn_set_frame kept the sparse baseline
# (ring_after_resync_save_only; oneFrameBackTest, twoFramesBackTest).
$QUINT run "$RING" --main=ring_after_resync_current --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript

# ── How a page's C engine starts ───────────────────────────────────────────
START=specs/engine_start.qnt
$QUINT typecheck "$START"
for variant in engine_start_before engine_start_stop_only engine_start_current; do
  $QUINT test "$START" --main="$variant" --backend=typescript
done
# Today: every frame of a match runs on the C engine, a guest arms with the
# host's delay on the frame the host gave it, and stops only when it cannot
# reach the armed host. The first was VIOLATED while a delay of 0 ran on the
# old JS lockstep path: every solo match, and a friend who joined it
# (engine_start_before; soloTest, lateJoinIntoSoloTest). The second was
# VIOLATED while a guest that heard nothing by the deadline armed with its
# own delay (engine_start_before; lostDelayTest). Stopping at the deadline
# without the host sending the delay and start frame again on every open
# stops a guest the host could reach (engine_start_stop_only; lostDelayTest).
# The host's start frame is the guest's own in every variant, which is why
# RB-INIT-CATCHUP and the overshoot went (theHostsStartIsWhereTheGuestIs).
$QUINT run "$START" --main=engine_start_current --invariant=allHold \
  --max-samples=20000 --max-steps=25 --backend=typescript
$QUINT run "$START" --main=engine_start_before --invariant=theHostsStartIsWhereTheGuestIs \
  --max-samples=20000 --max-steps=25 --backend=typescript
# An out-of-date matrix must not produce a green job that checked nothing.
if [ "$selected" -eq 0 ]; then
  echo "shard $shard of $shards selected no checks" >&2
  exit 2
fi
