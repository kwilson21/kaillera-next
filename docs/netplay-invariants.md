# Netplay Invariants

The netplay stack ([web/static/netplay-rollback.js](../web/static/netplay-rollback.js))
enforces two invariants that together eliminate the class of
DataChannel-death freeze bugs uncovered by the 2026-04-11 audit. This
document is the canonical reference — inline comments at each stall
site point back here. A passive tick watchdog (MF6) surfaces any
residual deadlock that slips past these invariants, but it does
**not** take recovery action.

## I1 — No stall without a bounded action

Every `return` in `tick()` that waits on an external event (DC message
arrival, peer connection state, remote frame progress, state
decompression) must have:

1. A wall-clock deadline, typically based on `performance.now()`.
2. A bounded action when the deadline expires.
3. An inline comment stating what is being waited on, the deadline
   value, and the action.

"Stall" means an early return that depends on external events. Pure
local-state branches (`if (!_running) return;`) are not stalls.

### Sites with timeouts

A full peer reset clears only the affected slot’s input wait. The other slots keep their deadlines (`otherWaitsStayArmed` in `specs/tick_deadlines.qnt`).

| Stall | Constant | Action | Event | Spec |
|-------|----------|----------|-------|------|
| `_rbPendingInit` (guest holds until it has the host's `rb-delay:` and `rb-init-frame:`, taken from the host only; the armed host sends both again on every channel that opens; a tab that comes back while the page waits leaves its frame alone) | `RB_INIT_TIMEOUT_MS = 10000` | With the host's delay, arm with it at the page's own frame; with none, stop and say so. Never arm with the page's own delay (`KNCore.guestStartStep`, specs/engine_start.qnt). A trap while arming ends the match (`FATAL-CORE-ABORT branch=rollback-init`); a tick with the engine neither armed nor waiting is not reached, and would end it too (`branch=not-armed`) | `RB-INIT-NO-START-FRAME`, `START-FAIL reason=no-host`, `bg-return: waiting to arm` | §MF2 |
| `_syncTargetFrame` (guest holds state for coordinated frame-boundary apply; also a non-coordinated state 1-2 frames ahead of the guest, `sync held`) | `SYNC_COORD_TIMEOUT_MS = 3000` | Drop target, apply pending state at current frame (non-coord branch) | `COORD-SYNC-TIMEOUT` | §MF3 |
| `_scheduledSyncRequests` entries (host captures state at scheduled target frame; in rollback mode also waits until its state is confirmed — no replay pending, every live peer's consumed input real) | `SYNC_COORD_TIMEOUT_MS = 3000` | Dispatch request at current frame | `COORD-SYNC-TIMEOUT` | §MF3 |
| RB-INPUT-STALL (rollback gameplay input missing beyond budget). An input from before the last resync's frame minus the delay is never waited for (`_inputFloor`): the state both pages loaded holds its effect, and a guest moved forward by the resync never made it | `MAX_STALL_MS + RESEND_TIMEOUT_MS = 5000` | Force-phantom blocking peer, release rollback input stall | `RB-INPUT-STALL-TIMEOUT` | rollback health audit 2026-04-27; specs/resync_inputs.qnt `noWaitForAnInputThatCannotArrive` |
| LOCKSTEP-WAIT (lockstep mode, and the demo's paused predictions: the input of a player for the frame about to run is missing; nothing is predicted). The rule is `lockstepStep` (`web/src/lockstep-wait.ts`, proved); each missing slot has a deadline credited for the page's own freeze | `MAX_STALL_MS` to ask again, `MAX_STALL_MS + RESEND_TIMEOUT_MS = 5000` to give up | A hole (an input the player has made, as a later one arrived or was dropped) is asked for at once, as the rollback input stall does (`RB-INPUT-ASK`); any input still missing is asked for again at the first deadline; at the second the expired slot is dropped (phantom) and the frame runs once no blockers remain; the two resync when it is heard from again | `LOCKSTEP-WAIT` / `LOCKSTEP-WAIT-TIMEOUT` | specs/tick_deadlines.qnt `everyWaitHasADeadline`; specs/resync_inputs.qnt ASK_FOR_MISSING |
| RB-INPUT-STALL after a reconnect reset (`resetPeerState(slot, 'reconnect')`): the C slot is inactive and the page no longer knows the frame last heard from the peer, so a frame run on its missing input would record no prediction, and nothing would correct it (the CATCH_UP_HOLE split at 1344). A frame at or above the floor that lacks the peer's input waits until one input at or above the floor has been taken in (`_awaitFirstInputAfterReset`, cleared when C is fed) | the same `MAX_STALL_MS + RESEND_TIMEOUT_MS = 5000` | Force-phantom the peer, as the stall above; `PEER-RECOVERED` then resyncs | `RB-INPUT-STALL … (first input since the reconnect)`; every two-player run fails on `PREDICTED-KNOWN` | specs/reconnect_inputs.qnt `theHostNeverPredictsAFrameThePeerHasMade` |
| A sync state due to install and accepted by the eligibility and native buffer checks waits for pending or active rollback replay (C refuses `kn_set_frame` mid-replay) | `SYNC_APPLY_REPLAY_WAIT_MS = 1000` | Attempt the native write. An accepted write supersedes replay (`kn_clear_replay_state`) before committing the frame. A rejected write preserves replay. | `SYNC-APPLY-DEFERRED` | specs/resync_flow.qnt `futureStateHasNoReplayDeadline`, `rejectedStateKeepsReplay` |
| A removed player's cut heard after this page ran frames it changes (`_cutRerun`): the re-run waits for a replay, catch-up or state load under way. Not a tick-loop return: the page runs on meanwhile | `CUT_RERUN_WAIT_MS = 1000` | Run the frames again from this page's ring (`ROSTER-CUT-RERUN`, a catch-up) when it still holds the first of them and nothing is under way; else ask the host for its state (`KNCore.removedInput.rerunStep`, proved) | `ROSTER-CUT-RERUN`, `ROSTER-CUT-LATE` | specs/removed_input.qnt `removedInputAgrees` |
| Pending sync state held while a catch-up runs (`_catchUpTo >= 0`) | `MAX_CATCH_UP_FRAMES` ticks: each slice runs a frame or ends the catch-up | Apply it once the catch-up ends | `SYNC-CATCH-UP` | specs/resync_flow.qnt `theGuestIsNeverRewound` |
| Catch-up waiting on a peer's input deeper than the rollback window (asked for with `resend:`) | `CATCH_UP_HOLE_WAIT_MS = 3000`; a slice that waits spends the tick's 60 Hz slot, so the wait is one slice a slot, not a spin (before: 59k-397k slices, each resending the frame's input, which buried the ask on the reliable channel for ~50 s) | End the catch-up; normal ticks play the rest (and stall and ask there as usual) | `SYNC-CATCH-UP ... stopped: slot N input K not here after 3000ms` | Codex review of #261; specs/catch_up_wait.qnt `aWaitingCatchUpDoesNotSpin`, `theAskIsNotBuried` |
| An ask for a missing input (`resend:<frame>`, every 500 ms, `RB-INPUT-ASK`) that is never answered, or a real input past the rollback window that differs from its prediction (C's `DEEP-MISPREDICT-SKIP`: it cannot be rolled back). Not a tick-loop return: the page predicts that input and runs on, split from the peer | `INPUT_ASK_OVERDUE_ASKS = 3` asks and `INPUT_ASK_OVERDUE_MS = 1500` since the first (`overdueAskStep`, `web/src/resync-request.ts`, proved); a late mismatch is overdue at once | Resync onto the host's state: the host pushes it to that guest (`pushSyncState(sid, false)`), a guest sends an owed `sync-request-full` (its own deadline, `_resyncRequestInFlight` below) | `INPUT-ASK-OVERDUE`, `INPUT-PAST-WINDOW-MISMATCH` | specs/ask_escalation.qnt `everyAskEnds`, `noEarlyEscalation`; `ASK_UNANSWERED_STALL_MS`; the late mismatch only through `PAST_WINDOW_FORCED`, a test-only step past the edge stall that guards it in normal play (`ROLLBACK_AT_EDGE` checks the deepest rollback that stall allows) |
| `_lateJoinPaused` (host pauses tick loop while late-joiners load state). The pause belongs to the joiners being served (`_lateJoinServing`): it ends when none is left | `LATE_JOIN_TIMEOUT_MS = 15000` per joiner, armed when its pause begins (before the state is compressed); a repeated request for the same joiner keeps it | `hardDisconnectPeer()` that joiner; resume and broadcast the roster once no joiner is still being served. A timer acts only on its own serve, so it never disconnects a joiner who has since joined | `LATE-JOIN-TIMEOUT` | §MF5; specs/late_join_pause.qnt `holdToday` |
| Late-join pause on a page that is not the host (`late-join-pause` from the host). Only the host's word pauses or resumes it; a joiner's `late-join-ready` does not | `LATE_JOIN_GUEST_PAUSE_TIMEOUT_MS = 20000` from the host's latest pause message (admission-owned Effect timer; longer than the host's per-joiner deadline) | Resume and reset pacing | `LATE-JOIN-GUEST-PAUSE-TIMEOUT` | specs/late_join_pause.qnt `guestPauseHasADeadline`, `guestResumesOnTheHostsWord`, `servicedAdmissionDeadlineReleasesHold` |
| Joiner waiting for an answer to its state request (`_awaitingLateJoinState`). The request is repeated every `LATE_JOIN_WAIT_RETRY_MS = 5000`; the wait is an Effect program (`web/src/late-join-wait.ts`) | `LATE_JOIN_WAIT_TIMEOUT_MS = 60000` | Report `late-join-timeout` and tell the player to reload. No guess is made about the host: a running host sends no input to a pending joiner, so silence does not mean it is still waiting. A host that is not running yet answers each request with `join-the-start` on the joiner's own data channel, and the joiner then loads as a starter (`emu-ready`) | `LATE-JOIN-WAIT-TIMEOUT` | specs/room_lifecycle.qnt `joinersAreNotLeftWaitingAtTheStart` |
| Late-join worker round-trip (joiner decompresses initial state) | `LATE_JOIN_TIMEOUT_MS = 15000` | Abort late-join; host's timeout cleans up the joiner | `WORKER-STALL` | §MF5 |
| `_resyncRequestInFlight` (guest: a resync request is out, so no other is sent; only the state that carries the request's number ends it, or any state from a host that does not number its answers). Not a stall of the tick loop: the game runs on, but no new request can go out. Checked by a request-scoped 250 ms browser timer. A foreground timer wakeup delayed at least 1 s credits the delay to the request, independently of frame pacing, and only while no answer is arriving, held, or waited for at a target frame (those have their own rows), and none is being decoded: a decode holds it off for at most `SYNC_DECODE_GRACE_MS = 10000` from the newest decode's start | `RESYNC_REQUEST_TIMEOUT_MS = 8000` | Clear the flag so the next detected desync can ask again. The host drops a request inside its 5 s rate limit without answering. A "now" request (reconnect, network change, tab shown again, missing delta base, socket fallback, boot sync, input stall) owes a resync until a host state is applied: the deadline asks again, at most `RESYNC_MAX_ASKS_AGAIN = 2` times, then gives up visibly. The late joiner's lost-host resync goes first, with its own bound | `RESYNC-REQUEST-TIMEOUT`, `RESYNC-REASK`, `RESYNC-REASK-GIVEUP` (client event `resync-reask-giveup`) | specs/resync_flow.qnt `aRequestCanAlwaysEnd`, `onlyItsAnswerEndsARequest`; specs/resync_reask.qnt `anOwedResyncIsNotForgotten`, `theDecodedAnswerIsNotCut`, `asksAgainAreBounded` |
| `_runSubstate === RUN_PACING` (pacing throttle skipping frame advance) | `PACING_THROTTLE_TIMEOUT_MS = 5000`; shifted forward by a local freeze like the staleness clocks below (specs/tick_deadlines.qnt) | Force-phantom slowest peer, release pacing. With every peer a phantom the advantage is 0 and the frame goes through `kn_pre_tick`'s forward path (never run on its pacing return, which stores no input and saves no state; specs/resync_inputs.qnt `aPageAppliesWhatItSent`) | `PACING-THROTTLE-TIMEOUT` | match f0566d95 |
| Peer staleness (`ROLLBACK-STALL`, `PEER-PHANTOM`). The clock restarts on an input this page did not hold, a new highest frame or one below it (a peer catching up re-sends the frames it runs again), never on a resend of one it holds (specs/tick_deadlines.qnt `peer_staleness`: `aCatchingUpPeerIsNotStale`, `aRepeatingPeerStillGoesStale`) | `ROLLBACK_STALL_MS = 3000`, `PEER_DEAD_MS = 5000`; clocks shifted forward by any gap ≥ `LOCAL_FREEZE_CREDIT_MS = 1000` between our own ticks (not while the tab is hidden, where 1 Hz ticks are normal) | Freeze sim, then phantom the peer. A local freeze doesn't count against the peer; a peer still quiet after we resume times out on the normal schedule. When the phantom is heard again (`PEER-RECOVERED`) the host settles its inputs from before its frame and resyncs every guest, one capture for all (each may have run the phantom's frames on other inputs than the host); a guest that hears the host again asks for a coordinated resync, and one that hears another guest again asks the host for a resync unless one is out (`recoveryStep`, `web/src/recovery-resync.ts`, proved) | `ROLLBACK-STALL start` / `PEER-PHANTOM` / `LOCAL-FREEZE` / `peer-recovery resync:` | two-browser test 2026-09-24; specs/recovery_bystander.qnt `hostAndBystanderAgree` (violated by `recovery_bystander_before`); `tests/rb-mesh.mjs RECOVERY_BYSTANDER=1` |
| A channel that dies in a match with no event (no `onclose`, no connection-state change): it reads closed and nothing arrives on it. Not a tick-loop return: the sim stalls and the player becomes a phantom (`Peer staleness` above), then the match runs on | the mesh health check, every 300 frames, on every tick (`_meshHealthTick`, once per frame); the first after the phantom at `PEER_DEAD_MS = 5000` (frames are frozen from `ROLLBACK_STALL_MS` until then) | Heal: the lower slot resets the entry through `resetPeerState(slot, 'mesh-heal')` (I2), and offers. A lower slot that is not the host takes the entry for a drop instead (`_handlePeerDisconnect`: reconnecting, the 45 s give-up armed) and offers through `attemptReconnect`, with its attempt deadline and retries; on open it resyncs from the host. The higher slot waits (next row). A phantom is healed too when its channel does not read open. On both pages the reconnected channel's open handler runs `resetPeerState(slot, 'reconnect')` (the host's too, since the reconnect-runaway fix), on the guest before its one resync request, so `PEER-RECOVERED` cannot ask again | `MESH-HEAL`, then `MESH-HEAL-WAIT` on the higher slot | specs/mesh_heal.qnt (`aDeadChannelIsNeverForgotten`, `atMostOneResyncPerReconnect`; violated by `mesh_heal_current`, `mesh_heal_c_tick_only`, `mesh_heal_no_reset_on_open`) |
| The higher slot waiting for the lower slot's reconnect offer after its mesh health check found no open channel (the per-peer machine decides `heal`: only the lower slot offers; the higher slot takes the dead channel for a drop it has just noticed, `_handlePeerDisconnect`). Not a tick-loop return: the match runs on without that player | the reconnect give-up, `45000` ms, armed by `_handlePeerDisconnect` | `hardDisconnectPeer()` that player, as for any drop nobody reconnected | `MESH-HEAL-WAIT`, then `hard-disconnect` | specs/peer_connection.qnt `peer_connection_heal_one_side`, `higherHealsThenGivesUpTest` |
| Host handing a resync state to the `sync-state` channel (not a tick-loop stall: the host keeps running, but no other state goes out to that guest until this one has; each guest has a chain of its own, so one guest's congested link never holds another's transfer). Each 64 KB chunk waits until less than `SYNC_SEND_LOW_WATER` (four chunks, 256 KB) is still buffered in the channel, so the host's inputs, which share the connection, never queue behind more than that; handed a whole state at once (2.9 MB in a two-player run) they sat unsent for seconds and the guest phantomed a host that was sending, then got its inputs 83 frames deep | `SYNC_SEND_STALL_MS = 15000` per chunk (polled every `SYNC_SEND_POLL_MS = 5`; the wait is an Effect program, `web/src/sync-send.ts`) | Give the transfer up; the guest's chunk timeout (`SYNC_CHUNK_TIMEOUT_MS`, 3 s without a chunk: restarted by each chunk, so a slow transfer that is still arriving is not given up) and request deadline ask again. The guest's inputs are settled for the state only once every chunk is handed over, so a transfer given up leaves none settled; a transfer queued before the guest reconnected is dropped (`_syncQueueGen`, I2) | `SYNC-SEND-STALLED` | specs/tick_deadlines.qnt `input_link` (`noInputArrivesDeeperThanTheCap`, `aSendingHostIsNotDropped`, `aTransferQueuedBeforeAResetNeverReachesTheNewConnection`, `inputsAreSettledOnlyForADeliveredState`, `aTransferMakingProgressIsNotAbandoned`, `noChunkForATransferTheGuestDropped`) |
| Menu-start barrier (Smash Remix: suppress input until all peers confirm controllable scene) | `MENU_START_BARRIER_SETTLE_MS = 500` (via `_menuStartReleaseAt = nowMs + MENU_START_BARRIER_SETTLE_MS`) | Set `_menuStartBarrierReleased = true`, release barrier | `MENU-BARRIER released` | commit 2 (feat(rollback): menu-start barrier) |
| Initial state from a guest's own cache (IndexedDB or server) waits for the host's save-state, which carries the host's save RAM | `HOST_INITIAL_STATE_WAIT_MS = 10000` | Start from the cached copy without the host's save RAM | `HOST-STATE-WAIT-TIMEOUT` | — |
| Start waits for this peer's own RTT measurement (so it announces lockstep-ready and picks delay with RTT data) | `START_WAIT_RTT_MS = 5000` | Finish RTT with samples from peers that completed (often none: delay then falls back to the delay preference) and announce lockstep-ready; start still waits for peers' lockstep-ready | `START-WAIT-RTT-TIMEOUT` | #56 |
| Boot frame count not advancing (`waitForEmu`) while a core OpenAL AudioContext isn't running (OpenAL write blocks on the audio clock — `retro_sleep` spin in `al_get_buffer()`). A non-audio stall (no stuck context, or the only stuck context already has the stand-in clock) instead logs `BOOT-STALL f=… audio=…` once and falls through to the terminal deadline below. The watchdog doesn't run at all while the tab is hidden (`document.visibilityState === 'hidden'`) — a backgrounded tab pauses rAF, so frames legitimately stop; the progress timer just resets each poll until the tab returns. | `BOOT_AUDIO_STALL_MS = 2000` | `resume()` the stuck context(s) (harmless if it works), then install a wall-clock stand-in `currentTime` getter on each so boot continues without a tap — Emscripten's OpenAL layer reads only `audioCtx.currentTime` to decide a buffer is processed. OpenAL output isn't used again for the rest of that rollback game (the context is suspended outright once boot finishes, and `kn_deterministic_mode` bypasses OpenAL writes during gameplay), so the stand-in is left in place until `stop()`, which removes it from every core AL context — the same context can come back to life for a later streaming game in the same tab (`play.js` `wakeEmulator`), and a left-behind stand-in would be minutes stale by then, scheduling every buffer in the future and silencing audio. The boot timeout (`boot timed out`) remains the terminal deadline: 300 polls (30s) for a boot whose frame count has stopped, and up to 180s in total for one still producing a frame at least every 5s (`KNCore.bootTimedOut`, `web/src/boot.ts`) | `BOOT-AUDIO-STALL` | #63, #65 |
| Streaming member needs an input connection or the video offer still has no answer. One Effect deadline per listed member, cancelled on completion, departure or match end. | 10 s, then 20 s, capped at 30 s | Replace a closed connection with a new attempt. On an open input channel, resend the pending video offer under the same attempt until the answer arrives. | `STREAM-REOFFER` | specs/streaming_connection.qnt `neverLeftWithNothingPending`, `streaming_media_fixed.recoveryPending` |
| Core preparation and EmulatorJS construction for a match page | 15 s for core metadata, then 30 s for the loader | Fall back to local core selection if metadata times out. A loader timeout releases the boot for a retry. Match end and ROM replacement cancel either stage. | `wasm-fail` on loader failure | specs/emulator_boot.qnt `oneCurrentEmulator` |
| Start: a player this page connects to does not answer before the match runs (a tab frozen at the start, a network with no route, a page at the ROM prompt that runs no engine). Not a tick-loop return: before this deadline led anywhere the host's game never started, and in a room of three the match never ran | `STARTUP_CONNECT_TIMEOUT_MS = 8000` per attempt, `STARTUP_CONNECT_MAX_ATTEMPTS = 3`, armed until the match runs (it used to stop once the game sequence had started) | The host leaves that player out of the start group: its connection closes and it is held as a late joiner, so the emu-ready and lockstep waits no longer count it, and a host with nobody left starts alone. The host tells the other players (`left-out:<slot>`), who stop waiting for it too; a guest takes that word only from the host's channel and never leaves anyone out itself. The player joins once the match runs. The give-up closes the connection, so an attempt still in its ICE checks cannot open later. A connection lost before the match runs is retried the same way, and given up on. A player at the ROM prompt says so (`rom-ready {ready: false, prompt: true}`, `romPrompt` in `users-updated`) and is left out at once when the host's ROM is not shared. A guest's own deadline on its channel to the host, the page's and Effect code (web/src/start-deadline.ts): armed at the start and again on losing the channel, restarted at each offer the host sends (`STARTUP_HOST_ANSWER_DEADLINE_MS`, 32 s with no offer; `STARTUP_HOST_AFTER_OFFER_MS`, 16 s after the host's latest, past its give-up): with no channel to the host then, it joins late (`onLeftOutOfStart`, the session machine's `leftOutOfStart`). A guest never goes on with its start without its channel to the host (`startHasItsHost`). A guest whose deadline gives up on another guest tells the host (`unreachable:<slot>`, said again every 8 s, at most 6 times, until the host acts, the two connect or the match runs), which leaves the one named out and tells it (`leavesOutUnreachable`, proved): two guests that each reach the host but not each other no longer wait for each other for ever. The decisions are web/src/start-group.ts (proved) | `startup connect failed`, `START-LEFT-OUT`, `START-ALONE`, `START-REJOIN-LATE`, `START-UNREACHABLE` (client event `webrtc-fail`) | specs/start_group.qnt `neverStuck`, `aLateJoinerIsHeldAsOne`, `nobodyIsInNeither` |
| Start: a player that answered does not load, or does not get ready, before the match runs (a core that crashed, a tab frozen after it connected, a page from before `left-out:` that loaded but waits for a player the host left out, a host state that never reaches it). Not a tick-loop return: the host waited at emu-ready, or at the ready barrier, for ever; its own sync timeout sent it back to an emu-ready wait nothing looked at again | `START_LOAD_DEADLINE_MS = 60000` (test-only `&knStartLoadMs=`, which only shortens it and never below 5 s), the host's, from each player's last start step (its channel opening, its `emu-ready`, its `lockstep-ready`, the deadline's arming, or the host's own readiness, which it then waits on), armed again after each run until the match runs; Effect code (web/src/start-deadline.ts) | Each run leaves out every player behind (`behindTheStart`: not loaded, or not ready at a barrier the host is ready at; the barrier's own record) that made no start step for a whole window (`missedLoadDeadline`; both proved in web/src/start-group.ts): one still loading, or still taking the host's state in, stays. Then it goes on with the start whether or not it left anyone out. One sync per start: the host's sync timeout only logs (`SYNC-TIMEOUT`), since a page says `lockstep-ready` once and takes the first state; a host whose state reaches nobody runs alone and they join late. A host capture that throws is tried again (`HOST_STATE_ATTEMPTS = 3`, 2 s apart), then the host says it cannot start (`SYNC-HOST-STATE-FAILED`). The host tells every player, the one left out included, whose channel it keeps open so the word reaches it: that page joins late (`leftOutItself`, `onLeftOutOfStart`), even once its own match runs while it has had no input from the host (its `lockstep-ready` crossed the cut and it held the host's ready; the host sends a left-out player no input), and its restart closes the channel; past `LEFT_OUT_RESTART_MS = 30000` the host closes it itself and still holds the player as a late joiner. Before the match runs the host sends a left-out player no `lockstep-ready`. A page from before `left-out:` ignores the word and waits on its own page, the host's match running without it, until it is idle or hidden and version-guard reloads it, or its player reloads | `START-LOAD-DEADLINE`, `START-LEFT-OUT`, `START-REJOIN-LATE`, `SYNC-TIMEOUT`, `SYNC-HOST-STATE-RETRY`, `SYNC-HOST-STATE-FAILED`, `START-LEFT-OUT-CLOSED` | specs/start_group.qnt `neverStuck` (`aLoadDeadlineRuns`; `start_group_untold` holds it, `start_group_untold_no_load` and `start_group_deadline_once` do not) and `aPlayerMakingProgressStays` (`start_group_absolute_deadline` and `start_group_resync` do not hold it) and `aLeftOutGuestDoesNotRunAlone` (`start_group_running_ignores_left_out` does not) |

## I2 — Reconnect starts clean

A single function `resetPeerState(slot, reason, opts)` owns all
per-peer state cleanup. Every disconnect, reconnect, and phantom-clear
path routes through it. `stop()` (whole-match teardown) is a deliberately
separate path that discards all peer state at once instead.

The slot's input maps are one table, `_slotInputMaps()`: `_clearSlotInputState(slot)`
(which `resetPeerState` and `_markPendingLateJoinPeer` both call) deletes the
slot from each, and `_resetInputMaps()` (the one call a new match and
`stop()` make) empties each. A new map goes in the table
once. The few maps cleared per slot only (`_remoteInputs`,
`_peerInputStarted`, `_lastRemoteFramePerSlot`, the late-join windows) are
listed in `_clearSlotInputState` with why a new input timeline keeps or
rebuilds them itself.

### Fields cleared

**Slot-indexed globals** (keyed by player slot 0-3):

- `_remoteInputs[slot]` — input buffer (frame → input map)
- `_inputSettledBefore[slot]` — first input frame the last resync left unsettled
- `_peerInputStarted[slot]` — first-input-received flag
- `_lastRemoteFramePerSlot[slot]` — highest received frame
- `_peerLastAdvanceTime[slot]` — wall-clock of last new frame
- `_peerPhantom[slot]` — dead-peer flag
- `_inputLateLogTime[slot]` — rate-limit timestamp
- `_auditLastRemote[slot]` — last audited remote input
- `_lateJoinActivatedAtFrame[slot]` — post-activation grace window
- `_lateJoinSeededInputFrames[slot]` — seeded late-join input frames
- `_inputDroppedAheadUpTo[slot]` — furthest frame dropped as too far ahead
- `_inputAskedAt[slot]` — when each missing input was last asked for
- `_inputAskOverdue[slot]` — asks counted toward escalation (specs/ask_escalation.qnt)
- `_overduePushes[slot]` — the host's escalation push out for that guest and its deadline
- `_holePushCounts[slot]` — pushes per hole, kept across a let-go; also cleared when the peer recovers
- `_syncChainMovedAt[sid]` — when that guest's chain of state transfers last moved (dropped with `_syncSendChains[sid]`)
- `_inputSettledAckBefore[slot]` — the frame before which the guest said
  (`inputs-settled:`) it applied a state: the answer to that push
- `_inputOorLog[slot]`, `_resendLog[slot]` — the throttles on the
  `INPUT-OOR` and `RESEND` log lines

`_droppedThisMatch` (the host's record of players it dropped in the running
match, by `_peerKey`) is match state, not peer state: it outlives the dropped peer by
design, so the mesh check cannot add it back. It is cleared on a new match,
on `stop()`, and for a player when it asks to join late.
- `_awaitFirstInputAfterReset[slot]` — cleared, then set again by a
  `reconnect` reset: frames wait for that peer's first input
  (specs/reconnect_inputs.qnt)

**Per-peer-object ack state** (on `_peers[sid]`):

- `peer.lastAckFromPeer`
- `peer.lastFrameFromPeer`
- `peer.lastAckAdvanceTime`

**Shared queues**:

- `_pendingCInputs` (entries filtered by slot)
- `_scheduledSyncRequests` (entries filtered by targetSid when provided)
- `_lateJoinServing` (host: the entry for this sid when provided; the late-join pause ends with it if no other joiner is being served)

Rooms use reliable input by default. The host can enable dual delivery in
the lobby to send current input and its bounded history on the reliable channel,
then race a bare copy on the peer’s available unordered channel.
Both channels feed the same receiver, which applies each identical input once.
If the unordered channel closes, the reliable path continues. In explicit
unreliable mode, closing the channel also resends unacknowledged inputs on
the reliable path. In both modes `resetPeerRollbackTransport` preserves
`_remoteInputs[slot]`, phase history and existing input wait deadlines.

### Call sites

| Call site | Reason string |
|-----------|---------------|
| `hardDisconnectPeer` (host path) | `hard-disconnect` |
| `hardDisconnectPeer` (non-host, roster-gated) | `hard-disconnect-non-host` |
| Reconnect resync (after DC close + rebuild), on the host and on the guest | `reconnect` |
| Stale peer evicted when roster shows a new sid for its slot | `zombie-eviction` |
| Late-join peer replaced by a reconnect | `late-join-reconnect-replace` |
| Mesh-heal re-adds a peer missing from the roster | `mesh-heal` |

**Code-review rule:** adding new per-peer state without updating
`resetPeerState` is a review-level violation. The function's
docstring enumerates every cleared field — grep for new
`[slot]`-indexed assignments before merging netplay changes.

## Detection-only watchdog (MF6)

A passive tick watchdog emits `TICK-STUCK` when the frame counter has
not advanced for 2 seconds (warn) or 5 seconds (error). It takes
**no recovery action**. Its sole purpose is to surface residual
deadlocks we haven't found yet.

Each `TICK-STUCK` log line includes:

- Current frame, elapsed ms, severity
- Inferred cause (`wasm-step-frozen`, `rb-pending-init`, `awaiting-resync`,
  `coord-sync-waiting-for-f<N>`, `input-stall`, `rollback-stall`,
  `pacing-throttle`, `unknown`)
- Every candidate stall flag
- Per-peer snapshot (slot, DC state, buffered bytes, last received
  frame, ack advance lag, phantom flag, input buffer size)
- Pending scheduled syncs count

Gates:

- Skipped while `_lateJoinPaused` (legitimate pause covered by I1)
- Skipped while `document.hidden` (tab backgrounded — legitimate stall)

**Any `TICK-STUCK error` fire in production is a bug report, not a
safety net doing its job.** The fix belongs in whichever MF category
covers the root cause, never in the watchdog.

### Rejected alternative — auto-recovery watchdog

An earlier draft of the deadlock audit proposed a watchdog that would
force recovery (guest-side immediate resync, host-side force-advance)
if `_frameNum` had not advanced in 5s. This was rejected:

- **It masks root causes.** A deadlock that recovers "silently" via
  watchdog looks normal in aggregate; we lose the signal that tells
  us a specific stall site is misbehaving.
- **It creates a temptation to stop diagnosing.** If the safety net
  catches everything, there is no pressure to find the actual bug.
- **It violates the no-cascade-fix rule.** Symptom-level recovery is
  a dead end; fix forward from root cause.

If MF6 ever becomes "recovery" rather than "detection," re-read this
section before writing the PR.

## References

- **Spec:** [superpowers/specs/2026-04-11-netplay-deadlock-audit.md](superpowers/specs/2026-04-11-netplay-deadlock-audit.md)
- **Plan:** [superpowers/plans/2026-04-11-netplay-deadlock-audit.md](superpowers/plans/2026-04-11-netplay-deadlock-audit.md)
- **Trigger:** commit `788add0` "fix(rollback): eliminate BOOT-LOCKSTEP + coord-sync deadlock"
- **Diagnostic tool:** `tools/analyze_match.py` — section 8d surfaces all I1/I2/MF6 recovery events

## Rollback Integrity (R1-R6)

The C-level rollback engine ([build/kn_rollback/kn_rollback.c](../build/kn_rollback/kn_rollback.c))
enforces six additional invariants that together eliminate the class
of silent state-corruption bugs uncovered by the 2026-04-11 audit of
room B190OHFY. These complement the deadlock-audit invariants above —
while I1/I2 prevent the tick loop from freezing forever, R1-R6
prevent the rollback itself from silently producing wrong state when
the tick loop IS running normally.

**Core principle: no band-aid recovery.** Mid-match auto-resync
triggered from an invariant violation is forbidden. Dev builds throw
so regressions are caught in CI; production builds log loudly and
continue so the player sees the broken game, the analyzer catches
the event, and the root-cause fix goes back in the queue. Silent
auto-recovery is the exact failure mode the audit rejected.

### R1 — Runner continuity across rollback restore

Any code path that calls `retro_unserialize` must re-capture the
Emscripten rAF runner before the next `stepOneFrame()`. The C
rollback branch uses `kn_rollback_did_restore()` polled from JS to
trigger `pauseMainLoop`/`resumeMainLoop`. The pre-existing loadState
resync path already does this; RF1 mirrors it for the rollback path.

### R2 — No silent stepOneFrame no-ops during replay

`stepOneFrame()` returning false while `_rbReplayLogged === true` is
an invariant violation. Logs `REPLAY-NORUN` with full diagnostic
fields (current frame, replay depth, runner state). Dev builds throw.

A counted frame must have been emulated exactly once. #62 found that
after a DOM focus change (e.g. clicking the toolbar or feedback form),
the next captured `_pendingRunner` call can emulate nothing — CP0
Count (`kn_get_cycle_time_ms`) unchanged across the call and no
successor runner scheduled — while `EJS_emulator.paused` stays false;
the old code counted the frame anyway, a silent one-tick desync.

The bundled core gives the manual scheduler the current runner for rAF,
timers, immediates and blocker continuations. A stale generation returns
before taking a blocker. A counted step requires dispatch into the core
and CP0 movement when available. These signals establish progress, not
an exact VI count. Older cores use the name-filtered rAF interceptor and
retry a stale runner once.

### R3 — Ring coverage within the rollback window

For any frame F where `rb.frame - F <= rb.max_frames` that a rollback
can go back to, the ring buffer must hold valid state for F. A rollback
goes back to F only for an input that F's `kn_pre_tick` predicted, and
only an active slot (one `kn_feed_input` has had an input for) is
predicted. So `kn_pre_tick` saves every frame while a slot other than
the page's own is active, which is every frame of a match with anyone
else in it. A dirty-input serialize gate that skipped saves when inputs
didn't change was removed in v0.43.0, after FATAL-RING-STALE at f=23410
proved it left gaps a rollback needed.

A page alone skips the save: alone in a match (at a delay of 0), or
after every other player left. A roster cut stores final inputs for replay
without activating the removed slot (`kn_store_cut_input`). No rollback
can come back to those frames (`specs/solo_save.qnt`,
`noTargetLostToTheGate`). The first input for another slot starts the
saves again from the next frame. A switch from JS's roster would not be
safe: a player's first input can arrive before the roster lists them
(`solo_save_roster`). The engine logs `SAVE-SKIP` and `SAVE-RESUME` at
the ends of a stretch, and the C-PERF line's `serSkip` counts the
frames skipped.

A received roster cut or mask announcement is staged for the matching roster
on the same selected host data channel. Activating a different host channel
discards incomplete metadata, even when the host publishes again at the same
frame (`specs/controller_mask.qnt`, `rosterPreludeStaysOnItsLane`).

Violations during a misprediction-triggered restore log
`FATAL-RING-STALE` and throw in dev (RF7).

Valid means of the timeline the page is running. A resync loads the
host's state and the page calls `kn_set_frame` on every state it loads,
the frame changed or not, so `kn_set_frame` forgets the last save
(`last_save_frame = -1`) and that frame is saved again before it runs.
It used not to: a resync landing exactly one frame behind the page,
whose last save was that frame, left the page's own copy in the ring,
and a rollback to it restored the old timeline. A two-player run's hash
compare (which reads the ring) saw that one frame differ (frame 1021 in
#232). The page also skipped `kn_set_frame` for a state of the frame it
was on, which left the same stale copy when `kn_pre_tick` had saved
that frame and it had not run (a pacing hold, a step that emulated
nothing). `kn_set_frame` forgets the sparse save mode's baseline too,
so the next save is whole, as after the worker's state apply.
[specs/ring_after_resync.qnt](../specs/ring_after_resync.qnt)
(`everyRerunFrameIsTheHosts`, `everyCopyIsWhole`) holds the rules,
`tests/rollback-native/` runs the engine itself through the model's
orderings (natively, against a stand-in core, on both state backends),
and `RESYNC_ONE_BACK=1` and `RESYNC_SAME_FRAME=1` in
`tests/rb-two-player.mjs` land the two orderings in a real match.

### R4 — A replay reproduces the timeline it corrects

A replay must leave the emulator in the state the peers reach with the
same inputs. **Nothing checks this at run time.** The engine never logs
`RB-LIVE-MISMATCH`: `kn_get_live_mismatch` always returns 0 (pages still
poll it), so the absence of `RB-LIVE-MISMATCH` from a log is not
evidence that R4 held.

RF5's check (April 2026) hashed the live state in `kn_post_tick` at the
end of a replay and compared it with the ring copy of the last replayed
frame. It was dropped in f322745, when the replay endpoint save moved to
the next `kn_pre_tick`, and was not sound before that: the ring copy was
saved at the start of that frame and the live state is its end, one frame
apart, and both come from the replay itself, so it could not see the
replay drift from the original or from the other peers. Compared at the
endpoint the two are now equal by construction. A check worth having
compares against something the replay did not produce; today that is the
cross-peer comparisons: the desync detector, and the gameplay and
game-state hashes in `tests/rb-two-player.mjs` (see "Which hash to trust"
in CLAUDE.md for what each covers). The replay's inputs are checked
natively: `tests/rollback-native/test_stale_prediction_flag.py`
(specs/stale_prediction_flag.qnt) holds that a replay runs a confirmed
input's real value.

A correction that predates an active replay can rewind its cursor again.
Both rollback limits and the replay endpoint stay relative to the original
next live frame. Each replayed frame uses its original input tag across delay
changes. A rejected rewind leaves the active replay running.
[Replay preemption model](../specs/replay_preemption.qnt) and
[native regression tests](../tests/rollback-native/test_replay_preemption.py).

### R5 — Pre-tick return value consistency

If `rb.replay_depth > 0` after `kn_pre_tick` returns, the return
value must equal 2 (replay frame). Two independent checks guard this.
On the C side, if the return-0 path is reached with `rb.replay_depth`
still set, it logs `R5-DIAG` and clears the stale value before
returning — so JS's own `replay_depth` read comes back 0 for that
frame, and the frame proceeds as a normal tick rather than a replay.
On the JS side, if `kn_get_replay_depth()` reports `replay_depth > 0`
while `catchingUp !== 2`, JS logs `RB-INVARIANT-FIXUP` and forces
`catchingUp = 2` so the replay step still runs (RF3) — this catches a
different corruption pattern, where C's state genuinely still wants a
replay but didn't return the replay code. These are the smallest
defense-in-depth checks and shipped first as an insurance policy that
would have caught the B190OHFY bug on the first run regardless of
root cause.

### R6 — Audio/video state survives restore

Any subsystem driven by RDRAM contents (AudioWorklet, OpenAL, GL
framebuffer) must either survive `retro_unserialize` intact or be
explicitly re-initialized in the restore sequence. RF6 Part A adds
`lastRb`/`rbDelta`/`resetAudioCalls`/`ctxState`/`workletPort` fields
to the `audio-empty`/`audio-silent` log so the analyzer can infer
whether a cluster of audio-death events correlates with a recent
rollback. RF6 Part B has shipped: `kn_reset_audio()` is called
explicitly on each replay step in the restore path
(`netplay-rollback.js` ~line 11441). The replay-step calls themselves
aren't visible in the RF6 Part A log — `resetAudioCalls` is zeroed at
the end of replay before any `audio-empty`/`audio-silent` log can
observe it — so that field only evidences resets on frames after
replay completes.

### Catching up after a resync

A host state from before the guest's frame (the answer to a "now" request is
the host's state from when it heard the request, and the guest has played on)
is applied where it is from, and the frames up to the guest's run again,
headless and muted, through the same forward step as `tick()`
(`_startCatchUp`; specs/resync_flow.qnt `theGuestIsNeverRewound`). The canvas
keeps the frame it showed until the guest is back. Before, the guest's frame
went back to the state's and the frames were played again in sight while the
host waited; past the 256-frame input ring the inputs predicted for them were
never corrected and the peers split.

- Every peer's input for a frame is fed again from the page's own record
  before the frame runs, so the replay does not depend on the input ring.
- An input not here is predicted where `tick()` would predict it: within the
  rollback window (`KN_MAX_VISIBLE_ROLLBACK_DEPTH`) of the frame the guest
  goes on from, or a phantom peer's. A deeper hole is asked for
  (`_askForMissingInputs`) and waited on up to `CATCH_UP_HOLE_WAIT_MS`; run
  unseen on a prediction it could not be rolled back once the input came.
  Past that wait normal ticks play the rest.
- A slice that runs frames spends no 60 Hz slot (`_tickReplayOnly`, as a rollback replay); one that waits on a hole spends it (specs/catch_up_wait.qnt),
  the inputs it runs on are kept until it reaches its target, and the peers'
  inputs for the frame it goes back to are taken in while it runs (their
  range check is against that frame).
- It runs in slices of at most `CATCH_UP_SLICE_MS`, one per tick, so the page
  keeps taking in messages between them. Each slice runs at least one frame,
  waits on a hole within its deadline, or ends it, and at most
  `MAX_CATCH_UP_FRAMES` frames are run; a newer state waits for it. A state further back is
  not applied (`SYNC-TOO-OLD-DROPPED`) and an owed resync is asked for again,
  or given up visibly (`RESYNC-REASK-GIVEUP`).
- It does not start over a pending rollback or replay; `kn_pre_tick`
  returning anything but a normal step stops it, logged.

Each catch-up logs `SYNC-CATCH-UP from=… to=… of=… frames=… ms=… workMs=…
slices=… waits=…`, with `stopped: …` when it ended short of the guest's
frame. `waits` counts the holes it waited on; the first is logged when the
wait begins (`SYNC-CATCH-UP-WAIT f=… slot=… input=…`). A slice that runs no
frame, waiting, spends the tick's 60 Hz slot, so a wait looks again once a
slot rather than in a loop for the tick pump's whole replay budget.

### Detection events

A violation of R2, R3 or R5 produces a loud analyzer event. Zero of
these events across a real session log means those invariants held; it
says nothing about R4, which has no run-time check (see R4).

| Event | Invariant | Spec RF |
|-------|-----------|---------|
| `REPLAY-NORUN` | R2 | RF2 |
| `RB-INVARIANT-FIXUP` | R5 | RF3 |
| `FATAL-RING-STALE` | R3 | RF7 |
| `RB-LIVE-MISMATCH` | R4 (retired: never emitted, see R4) | RF5 |
| `AUDIO-DEATH` (enriched) | R6 diagnostic | RF6 Part A |

`FATAL-CORE-ABORT` means the WASM core trapped. It stops this peer's tick
loop and shows the crash error. Other peers stall, then phantom this peer at
the I1 input-stall deadline. `STEP-THREW` is logged for every thrown step.
A throw out of the C engine's tick (`kn_pre_tick` and the replay it drives)
is the same: `C-ROLLBACK-THROW`, then `FATAL-CORE-ABORT branch=c-rollback`.

Rejected: recovering from that throw. The engine used to clear the replay it
could not apply and play on, and after three throws at one frame turned the
C engine off for the rest of the match (`C-ROLLBACK-FALLBACK`, "legacy
lockstep takes over"). The cleared replay was a rollback dropped on this
page only, so its state split from the others'; and turning rollback off on
one page, with the others still predicting, is the mixed protocol the
engine's init warns diverges. Nothing reported either to the players.

## Recovery delivery obligations (#286 review follow-up)

An overdue-input recovery broadcasts one authoritative state to all active guests.
Each recipient retains its own delivered-state acknowledgement and retry obligation:
one guest answering cannot settle a guest whose transfer failed. A missing delivery
backs off for 5 seconds, then retries that guest, up to three attempts; exhaustion
uses the explicit drop/late-rejoin path, never a successful-health report. The existing
per-guest no-progress and page-freeze credit rules remain in effect.

Only a `recovery-settled:<frame>:<id>` received **after** this attempt was
delivered, naming this attempt's id and its exact state frame minus delay,
settles it. The legacy `inputs-settled:` updates input history only and settles
nothing. A stored high-water mark does not. A slot's transfer reservation
survives a reset, timeout, or early acknowledgement until the asynchronous
transfer actually settles, bounding escalation buffers to one transfer per
player slot.

A new hole coalesces only while its own source is still owed a recovery. A
later hole from a settled source is broadcast to the recipients that are free;
a recipient still owed the earlier broadcast is skipped, keeps its own attempt
and retry budget, and is owed the newer state: a retry captures afresh and
covers it, and if the earlier attempt settles instead, the host pushes that
recipient one fresh state (`INPUT-ASK-PUSH-FOLLOWUP`), unless the state it
settled on was itself taken at or after the newer broadcast's frame
(`INPUT-ASK-PUSH-FOLLOWUP-COVERED`). Without that push, with 3+ players, the
skipped guest would stay on a state from before the newer hole while the
others adopt it. The follow-up is a capture charged to the room's capture
budget (not the source's, whose exhaustion drops the source); once that is
spent it is left to the guest's own resync (`INPUT-ASK-PUSH-FOLLOWUP-BUDGET`).
Its settlement is logged `kind=follow-up`.

State chunks use the dedicated sync channel only: the primary input channel cannot
parse them. A rate-limited late-join request retains the dropped marker; the marker
is removed only after the accepted join is held outside the active roster.

Model: `specs/recovery_delivery.qnt`, before/fixed variants, capacity model and
`recovery_skipped` (the follow-up owed to a skipped recipient).
Engine-handler regressions: `tests/ts/recovery-delivery.test.ts`.
These add no session-machine states and do not alter its generated diagram.
