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

Controllable menus/CSS are a protocol exception: the bounded action is
repeated resend/logging, not frame advancement. Fabricating input or
phantoming a peer there can turn one missed A/Start edge into a
permanent setup fork, so strict menu stalls intentionally hold the
simulation until the real input/phase arrives or the room is externally
recovered.

### Sites with timeouts

| Stall | Constant | Action | Event | Spec |
|-------|----------|----------|-------|------|
| `_rbPendingInit` (guest holds until it has the host's `rb-delay:` and `rb-init-frame:`; the armed host sends both again on every channel that opens) | `RB_INIT_TIMEOUT_MS = 10000` | With the host's delay, arm with it at the page's own frame; with none, stop and say so. Never arm with the page's own delay (`KNCore.guestStartStep`, specs/engine_start.qnt) | `RB-INIT-NO-START-FRAME`, `START-FAIL reason=no-host` | §MF2 |
| `_syncTargetFrame` (guest holds state for coordinated frame-boundary apply; also a non-coordinated state 1-2 frames ahead of the guest, `sync held`) | `SYNC_COORD_TIMEOUT_MS = 3000` | Drop target, apply pending state at current frame (non-coord branch) | `COORD-SYNC-TIMEOUT` | §MF3 |
| `_scheduledSyncRequests` entries (host captures state at scheduled target frame; in rollback mode also waits until its state is confirmed — no replay pending, every live peer's consumed input real) | `SYNC_COORD_TIMEOUT_MS = 3000` | Dispatch request at current frame | `COORD-SYNC-TIMEOUT` | §MF3 |
| `INPUT-STALL` hard-timeout (fabricate ZERO_INPUT after input missing) | `MAX_STALL_MS + RESEND_TIMEOUT_MS = 5000` | Fabricate AND request full resync so divergence converges | `INPUT-STALL-RESYNC` | §MF4 |
| MENU-LOCKSTEP stall (lockstep path only, when the C rollback engine is not running: a controllable Smash Remix menu's input is missing) | `MAX_STALL_MS`, repeat per missing slot every `RESEND_TIMEOUT_MS` | Keep waiting, show the waiting overlay after 5s, and resend missing input request; never fabricate menu input | `MENU-LOCKSTEP-WAIT` / `MENU-LOCKSTEP resend-request` | rollback health audit 2026-04-27, corrected 2026-04-30 |
| RB-INPUT-STALL (rollback gameplay input missing beyond budget). An input from before the last resync's frame minus the delay is never waited for (`_inputFloor`): the state both pages loaded holds its effect, and a guest moved forward by the resync never made it | `MAX_STALL_MS + RESEND_TIMEOUT_MS = 5000` | Force-phantom blocking peer, release rollback input stall | `RB-INPUT-STALL-TIMEOUT` | rollback health audit 2026-04-27; specs/resync_inputs.qnt `noWaitForAnInputThatCannotArrive` |
| LOCKSTEP-WAIT (lockstep mode, and the demo's paused predictions: the input of a player for the frame about to run is missing; nothing is predicted). The rule is `lockstepStep` (`web/src/lockstep-wait.ts`, proved); the wait's start is credited for the page's own freeze like the others that drop a player | `MAX_STALL_MS` to ask again, `MAX_STALL_MS + RESEND_TIMEOUT_MS = 5000` to give up | A hole (an input the player has made, as a later one arrived or was dropped) is asked for at once, as the rollback input stall does (`RB-INPUT-ASK`); any input still missing is asked for again at the first deadline; at the second the player is dropped (phantom) and the frame runs without it; the two resync when it is heard from again | `LOCKSTEP-WAIT` / `LOCKSTEP-WAIT-TIMEOUT` | specs/tick_deadlines.qnt `everyWaitHasADeadline`; specs/resync_inputs.qnt ASK_FOR_MISSING |
| Pending sync state held while a rollback replay is in flight (C refuses `kn_set_frame` mid-replay) | `SYNC_APPLY_REPLAY_WAIT_MS = 1000` | Drop the replay (`kn_clear_replay_state`) and load the state | `SYNC-APPLY-DEFERRED` | two-browser test 2026-09-24 |
| Pending sync state held while a catch-up runs (`_catchUpTo >= 0`) | `MAX_CATCH_UP_FRAMES` ticks: each slice runs a frame or ends the catch-up | Apply it once the catch-up ends | `SYNC-CATCH-UP` | specs/resync_flow.qnt `theGuestIsNeverRewound` |
| Catch-up waiting on a peer's input deeper than the rollback window (asked for with `resend:`) | `CATCH_UP_HOLE_WAIT_MS = 3000` | End the catch-up; normal ticks play the rest (and stall and ask there as usual) | `SYNC-CATCH-UP ... stopped: slot N input K not here after 3000ms` | Codex review of #261 |
| `_lateJoinPaused` (host pauses tick loop while late-joiners load state). The pause belongs to the joiners being served (`_lateJoinServing`): it ends when none is left | `LATE_JOIN_TIMEOUT_MS = 15000` per joiner, armed when its pause begins (before the state is compressed); a repeated request for the same joiner keeps it | `hardDisconnectPeer()` that joiner; resume and broadcast the roster once no joiner is still being served. A timer acts only on its own serve, so it never disconnects a joiner who has since joined | `LATE-JOIN-TIMEOUT` | §MF5; specs/late_join_pause.qnt `holdToday` |
| Late-join pause on a page that is not the host (`late-join-pause` from the host). Only the host's word pauses or resumes it; a joiner's `late-join-ready` does not | `LATE_JOIN_GUEST_PAUSE_TIMEOUT_MS = 20000` from the host's latest pause message (checked in the tick loop; longer than the host's per-joiner deadline) | Resume and reset pacing | `LATE-JOIN-GUEST-PAUSE-TIMEOUT` | specs/late_join_pause.qnt `guestPauseHasADeadline`, `guestResumesOnTheHostsWord` |
| Joiner waiting for an answer to its state request (`_awaitingLateJoinState`). The request is repeated every `LATE_JOIN_WAIT_RETRY_MS = 5000`; the wait is an Effect program (`web/src/late-join-wait.ts`) | `LATE_JOIN_WAIT_TIMEOUT_MS = 60000` | Report `late-join-timeout` and tell the player to reload. No guess is made about the host: a running host sends no input to a pending joiner, so silence does not mean it is still waiting. A host that is not running yet answers each request with `join-the-start` on the joiner's own data channel, and the joiner then loads as a starter (`emu-ready`) | `LATE-JOIN-WAIT-TIMEOUT` | specs/room_lifecycle.qnt `joinersAreNotLeftWaitingAtTheStart` |
| Late-join worker round-trip (joiner decompresses initial state) | `LATE_JOIN_TIMEOUT_MS = 15000` | Abort late-join; host's timeout cleans up the joiner | `WORKER-STALL` | §MF5 |
| `_awaitingResync` (guest waiting for state after coord stall) | 3000ms | Resume without corrected state (known livelock, see SF5) | (timeout log only) | spec SF5 |
| `_resyncRequestInFlight` (guest: a resync request is out, so no other is sent; only the state that carries the request's number ends it, or any state from a host that does not number its answers). Not a stall of the tick loop: the game runs on, but no new request can go out. Checked at the top of each tick, after the local-freeze credit (the page's own freeze does not count against the request), and only while no answer is arriving, held, or waited for at a target frame (those have their own rows), and none is being decoded: a decode holds it off for at most `SYNC_DECODE_GRACE_MS = 10000` from the newest decode's start | `RESYNC_REQUEST_TIMEOUT_MS = 8000` | Clear the flag so the next detected desync can ask again. The host drops a request inside its 5 s rate limit without answering. A "now" request (reconnect, network change, tab shown again, missing delta base, socket fallback, boot sync, input stall) owes a resync until a host state is applied: the deadline asks again, at most `RESYNC_MAX_ASKS_AGAIN = 2` times, then gives up visibly. The late joiner's lost-host resync goes first, with its own bound | `RESYNC-REQUEST-TIMEOUT`, `RESYNC-REASK`, `RESYNC-REASK-GIVEUP` (client event `resync-reask-giveup`) | specs/resync_flow.qnt `aRequestCanAlwaysEnd`, `onlyItsAnswerEndsARequest`; specs/resync_reask.qnt `anOwedResyncIsNotForgotten`, `theDecodedAnswerIsNotCut`, `asksAgainAreBounded` |
| `_runSubstate === RUN_PACING` (pacing throttle skipping frame advance) | `PACING_THROTTLE_TIMEOUT_MS = 5000`; shifted forward by a local freeze like the staleness clocks below (specs/tick_deadlines.qnt) | Force-phantom slowest peer, release pacing. With every peer a phantom the advantage is 0 and the frame goes through `kn_pre_tick`'s forward path (never run on its pacing return, which stores no input and saves no state; specs/resync_inputs.qnt `aPageAppliesWhatItSent`) | `PACING-THROTTLE-TIMEOUT` | match f0566d95 |
| Peer staleness (`ROLLBACK-STALL`, `PEER-PHANTOM`) | `ROLLBACK_STALL_MS = 3000`, `PEER_DEAD_MS = 5000`; clocks shifted forward by any gap ≥ `LOCAL_FREEZE_CREDIT_MS = 1000` between our own ticks (not while the tab is hidden, where 1 Hz ticks are normal) | Freeze sim, then phantom the peer. A local freeze doesn't count against the peer; a peer still quiet after we resume times out on the normal schedule | `ROLLBACK-STALL start` / `PEER-PHANTOM` / `LOCAL-FREEZE` | two-browser test 2026-09-24 |
| A channel that dies in a match with no event (no `onclose`, no connection-state change): it reads closed and nothing arrives on it. Not a tick-loop return: the sim stalls and the player becomes a phantom (`Peer staleness` above), then the match runs on | the mesh health check, every 300 frames, on C-rollback ticks and on the JS lockstep path (`_meshHealthCheck`, once per frame); the first after the phantom at `PEER_DEAD_MS = 5000` (frames are frozen from `ROLLBACK_STALL_MS` until then) | Heal: the lower slot resets the entry through `resetPeerState(slot, 'mesh-heal')` (I2), and offers. A lower slot that is not the host takes the entry for a drop instead (`_handlePeerDisconnect`: reconnecting, the 45 s give-up armed) and offers through `attemptReconnect`, with its attempt deadline and retries; on open it resyncs from the host. The higher slot waits (next row). A phantom is healed too when its channel does not read open. On the guest the reconnected channel's open handler runs `resetPeerState(slot, 'reconnect')` before its one resync request, so `PEER-RECOVERED` cannot ask again | `MESH-HEAL`, then `MESH-HEAL-WAIT` on the higher slot | specs/mesh_heal.qnt (`aDeadChannelIsNeverForgotten`, `atMostOneResyncPerReconnect`; violated by `mesh_heal_current`, `mesh_heal_c_tick_only`, `mesh_heal_no_reset_on_open`) |
| The higher slot waiting for the lower slot's reconnect offer after its mesh health check found no open channel (the per-peer machine decides `heal`: only the lower slot offers; the higher slot takes the dead channel for a drop it has just noticed, `_handlePeerDisconnect`). Not a tick-loop return: the match runs on without that player | the reconnect give-up, `45000` ms, armed by `_handlePeerDisconnect` | `hardDisconnectPeer()` that player, as for any drop nobody reconnected | `MESH-HEAL-WAIT`, then `hard-disconnect` | specs/peer_connection.qnt `peer_connection_heal_one_side`, `higherHealsThenGivesUpTest` |
| Host handing a resync state to the `sync-state` channel (not a tick-loop stall: the host keeps running, but no other state goes out to that guest until this one has; each guest has a chain of its own, so one guest's congested link never holds another's transfer). Each 64 KB chunk waits until less than `SYNC_SEND_LOW_WATER` (four chunks, 256 KB) is still buffered in the channel, so the host's inputs, which share the connection, never queue behind more than that; handed a whole state at once (2.9 MB in a two-player run) they sat unsent for seconds and the guest phantomed a host that was sending, then got its inputs 83 frames deep | `SYNC_SEND_STALL_MS = 15000` per chunk (polled every `SYNC_SEND_POLL_MS = 5`; the wait is an Effect program, `web/src/sync-send.ts`) | Give the transfer up; the guest's chunk timeout (`SYNC_CHUNK_TIMEOUT_MS`, 3 s without a chunk: restarted by each chunk, so a slow transfer that is still arriving is not given up) and request deadline ask again. The guest's inputs are settled for the state only once every chunk is handed over, so a transfer given up leaves none settled; a transfer queued before the guest reconnected is dropped (`_syncQueueGen`, I2) | `SYNC-SEND-STALLED` | specs/tick_deadlines.qnt `input_link` (`noInputArrivesDeeperThanTheCap`, `aSendingHostIsNotDropped`, `aTransferQueuedBeforeAResetNeverReachesTheNewConnection`, `inputsAreSettledOnlyForADeliveredState`, `aTransferMakingProgressIsNotAbandoned`, `noChunkForATransferTheGuestDropped`) |
| Menu-start barrier (Smash Remix: suppress input until all peers confirm controllable scene) | `MENU_START_BARRIER_SETTLE_MS = 500` (via `_menuStartReleaseAt = nowMs + MENU_START_BARRIER_SETTLE_MS`) | Set `_menuStartBarrierReleased = true`, release barrier | `MENU-BARRIER released` | commit 2 (feat(rollback): menu-start barrier) |
| Initial state from a guest's own cache (IndexedDB or server) waits for the host's save-state, which carries the host's save RAM | `HOST_INITIAL_STATE_WAIT_MS = 10000` | Start from the cached copy without the host's save RAM | `HOST-STATE-WAIT-TIMEOUT` | — |
| Start waits for this peer's own RTT measurement (so it announces lockstep-ready and picks delay with RTT data) | `START_WAIT_RTT_MS = 5000` | Finish RTT with samples from peers that completed (often none: delay then falls back to the delay preference) and announce lockstep-ready; start still waits for peers' lockstep-ready | `START-WAIT-RTT-TIMEOUT` | #56 |
| Boot frame count not advancing (`waitForEmu`) while a core OpenAL AudioContext isn't running (OpenAL write blocks on the audio clock — `retro_sleep` spin in `al_get_buffer()`). A non-audio stall (no stuck context, or the only stuck context already has the stand-in clock) instead logs `BOOT-STALL f=… audio=…` once and falls through to the terminal deadline below. The watchdog doesn't run at all while the tab is hidden (`document.visibilityState === 'hidden'`) — a backgrounded tab pauses rAF, so frames legitimately stop; the progress timer just resets each poll until the tab returns. | `BOOT_AUDIO_STALL_MS = 2000` | `resume()` the stuck context(s) (harmless if it works), then install a wall-clock stand-in `currentTime` getter on each so boot continues without a tap — Emscripten's OpenAL layer reads only `audioCtx.currentTime` to decide a buffer is processed. OpenAL output isn't used again for the rest of that rollback game (the context is suspended outright once boot finishes, and `kn_deterministic_mode` bypasses OpenAL writes during gameplay), so the stand-in is left in place until `stop()`, which removes it from every core AL context — the same context can come back to life for a later streaming game in the same tab (`play.js` `wakeEmulator`), and a left-behind stand-in would be minutes stale by then, scheduling every buffer in the future and silencing audio. The boot timeout (`boot timed out`) remains the terminal deadline: 300 polls (30s) for a boot whose frame count has stopped, and up to 180s in total for one still producing a frame at least every 5s (`KNCore.bootTimedOut`, `web/src/boot.ts`) | `BOOT-AUDIO-STALL` | #63, #65 |
| Streaming: a member the host's roster lists has no open channel to the host (an offer, an answer or a late joiner's ready was lost, or the connection dropped). Not a tick-loop return: before this deadline the guest's video held its last frame for good, with both pages still in the room. One Effect program per member (`web/src/streaming/reoffer.ts`), interrupted when the channel opens, when the roster stops listing the member, and in `stop()` | `REOFFER_FIRST_MS = 10000`, then 20000, then `REOFFER_MAX_MS = 30000` while no channel opens; back to the first once one does | The host closes the connection and offers a new one under a new attempt (`attemptId`); the guest replaces its old connection for the newer offer (`web/src/streaming/attempt.ts`) | `STREAM-REOFFER` | specs/streaming_connection.qnt `neverLeftWithNothingPending` |
| Start: a player this page connects to does not answer before the match runs (a tab frozen at the start, a network with no route, a page at the ROM prompt that runs no engine). Not a tick-loop return: before this deadline led anywhere the host's game never started, and in a room of three the match never ran | `STARTUP_CONNECT_TIMEOUT_MS = 8000` per attempt, `STARTUP_CONNECT_MAX_ATTEMPTS = 3`, armed until the match runs (it used to stop once the game sequence had started) | The host leaves that player out of the start group: its connection closes and it is held as a late joiner, so the emu-ready and lockstep waits no longer count it, and a host with nobody left starts alone. The host tells the other players (`left-out:<slot>`), who stop waiting for it too; a guest takes that word only from the host's channel and never leaves anyone out itself. The player joins once the match runs. The give-up closes the connection, so an attempt still in its ICE checks cannot open later. A connection lost before the match runs is retried the same way, and given up on. A player at the ROM prompt says so (`rom-ready {ready: false, prompt: true}`, `romPrompt` in `users-updated`) and is left out at once when the host's ROM is not shared. A guest's own deadline on its channel to the host, the page's and Effect code (web/src/start-deadline.ts): armed at the start and again on losing the channel, restarted at each offer the host sends (`STARTUP_HOST_ANSWER_DEADLINE_MS`, 32 s with no offer; `STARTUP_HOST_AFTER_OFFER_MS`, 16 s after the host's latest, past its give-up): with no channel to the host then, it joins late (`onLeftOutOfStart`, the session machine's `leftOutOfStart`). A guest never goes on with its start without its channel to the host (`startHasItsHost`). A guest whose deadline gives up on another guest tells the host (`unreachable:<slot>`, said again every 8 s, at most 6 times, until the host acts, the two connect or the match runs), which leaves the one named out and tells it (`leavesOutUnreachable`, proved): two guests that each reach the host but not each other no longer wait for each other for ever. The decisions are web/src/start-group.ts (proved) | `startup connect failed`, `START-LEFT-OUT`, `START-ALONE`, `START-REJOIN-LATE`, `START-UNREACHABLE` (client event `webrtc-fail`) | specs/start_group.qnt `neverStuck`, `aLateJoinerIsHeldAsOne`, `nobodyIsInNeither` |
| Start: a player that answered does not load, or does not get ready, before the match runs (a core that crashed, a tab frozen after it connected, a page from before `left-out:` that loaded but waits for a player the host left out, a host state that never reaches it). Not a tick-loop return: the host waited at emu-ready, or at the ready barrier, for ever; its own sync timeout sent it back to an emu-ready wait nothing looked at again | `START_LOAD_DEADLINE_MS = 60000` (test-only `&knStartLoadMs=`, which only shortens it and never below 5 s), the host's, from each player's last start step (its channel opening, its `emu-ready`, its `lockstep-ready`, the deadline's arming, or the host's own readiness, which it then waits on), armed again after each run until the match runs; Effect code (web/src/start-deadline.ts) | Each run leaves out every player behind (`behindTheStart`: not loaded, or not ready at a barrier the host is ready at; the barrier's own record) that made no start step for a whole window (`missedLoadDeadline`; both proved in web/src/start-group.ts): one still loading, or still taking the host's state in, stays. Then it goes on with the start whether or not it left anyone out. One sync per start: the host's sync timeout only logs (`SYNC-TIMEOUT`), since a page says `lockstep-ready` once and takes the first state; a host whose state reaches nobody runs alone and they join late. A host capture that throws is tried again (`HOST_STATE_ATTEMPTS = 3`, 2 s apart), then the host says it cannot start (`SYNC-HOST-STATE-FAILED`). The host tells every player, the one left out included, whose channel it keeps open so the word reaches it: that page joins late (`leftOutItself`, `onLeftOutOfStart`), even once its own match runs while it has had no input from the host (its `lockstep-ready` crossed the cut and it held the host's ready; the host sends a left-out player no input), and its restart closes the channel; past `LEFT_OUT_RESTART_MS = 30000` the host closes it itself and still holds the player as a late joiner. Before the match runs the host sends a left-out player no `lockstep-ready`. A page from before `left-out:` ignores the word and waits on its own page, the host's match running without it, until it is idle or hidden and version-guard reloads it, or its player reloads | `START-LOAD-DEADLINE`, `START-LEFT-OUT`, `START-REJOIN-LATE`, `SYNC-TIMEOUT`, `SYNC-HOST-STATE-RETRY`, `SYNC-HOST-STATE-FAILED`, `START-LEFT-OUT-CLOSED` | specs/start_group.qnt `neverStuck` (`aLoadDeadlineRuns`; `start_group_untold` holds it, `start_group_untold_no_load` and `start_group_deadline_once` do not) and `aPlayerMakingProgressStays` (`start_group_absolute_deadline` and `start_group_resync` do not hold it) and `aLeftOutGuestDoesNotRunAlone` (`start_group_running_ignores_left_out` does not) |

## I2 — Reconnect starts clean

A single function `resetPeerState(slot, reason, opts)` owns all
per-peer state cleanup. Every disconnect, reconnect, and phantom-clear
path routes through it. `stop()` (whole-match teardown) is a deliberately
separate path that discards all peer state at once instead.

### Fields cleared

**Slot-indexed globals** (keyed by player slot 0-3):

- `_remoteInputs[slot]` — input buffer (frame → input map)
- `_inputSettledBefore[slot]` — first input frame the last resync left unsettled
- `_peerInputStarted[slot]` — first-input-received flag
- `_lastRemoteFramePerSlot[slot]` — highest received frame
- `_peerLastAdvanceTime[slot]` — wall-clock of last new frame
- `_peerPhantom[slot]` — dead-peer flag
- `_consecutiveFabrications[slot]` — fabrication counter
- `_inputLateLogTime[slot]` — rate-limit timestamp
- `_auditLastRemote[slot]` — last audited remote input
- `_lateJoinActivatedAtFrame[slot]` — post-activation grace window
- `_lateJoinSeededInputFrames[slot]` — seeded late-join input frames

**Per-peer-object ack state** (on `_peers[sid]`):

- `peer.lastAckFromPeer`
- `peer.lastFrameFromPeer`
- `peer.lastAckAdvanceTime`

**Shared queues**:

- `_pendingCInputs` (entries filtered by slot)
- `_scheduledSyncRequests` (entries filtered by targetSid when provided)
- `_lateJoinServing` (host: the entry for this sid when provided; the late-join pause ends with it if no other joiner is being served)

Rollback-input DC close is intentionally lighter than a full peer
reset: `resetPeerRollbackTransport(peer, sid, 'rb-dc-close')` clears
only `peer.rbDc`, `peer.rbDcUnreliable`, unreliable-DC buffer state,
and stall timers, then falls back to the primary reliable DC without
dropping `_remoteInputs[slot]` or phase history.

### Call sites

| Call site | Reason string |
|-----------|---------------|
| `hardDisconnectPeer` (host path) | `hard-disconnect` |
| `hardDisconnectPeer` (non-host, roster-gated) | `hard-disconnect-non-host` |
| Reconnect resync (after DC close + rebuild) | `reconnect` |
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
- Inferred cause (`rb-pending-init`, `awaiting-resync`,
  `coord-sync-waiting`, `boot-lockstep`, `input-stall`, `unknown`)
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

Root cause: `enterManualMode()`'s `overrideRAF` interceptor captured
ANY callback passed to `requestAnimationFrame` as `_pendingRunner`,
not just Emscripten's main-loop runner. Page UI code that calls
`requestAnimationFrame` during a match — `toggleMoreDropdown` in
play.js, `_openModal` in feedback.js — overwrote `_pendingRunner` with
its own callback; the next `stepOneFrame()` ran that UI callback
instead of emulating, and the real runner was lost. Fixed by having
the interceptor capture only Emscripten's runner
(`KNShared.isMainLoopRunner`, matched by `cb.name ===
'MainLoop_runner'`) and pass every other callback straight to the
native `requestAnimationFrame` (`APISandbox.nativeRAF`). `stepOneFrame()`
still detects the no-op signature (no runner rescheduled AND
`kn_get_cycle_time_ms` unchanged across the call, when the core exports
it), recaptures the runner, and re-steps the SAME frame once, as a
safety net for any other cause of a stale runner. If the retry still
does not emulate, `stepOneFrame()` returns `false` like the no-runner
case above, so the frame is never counted — R2's `REPLAY-NORUN` logging
applies identically whether the cause was "no runner at all" or "stale
runner exhausted its retry."

### R3 — Ring coverage within the rollback window

For any frame F where `rb.frame - F <= rb.max_frames`, the ring
buffer must hold valid state for F. As of v0.43.0, state is saved
every frame unconditionally (the previous dirty-input serialize gate
was removed after FATAL-RING-STALE at f=23410 proved that skipping
saves created ring coverage gaps). Violations during a
misprediction-triggered restore log `FATAL-RING-STALE` and throw
in dev (RF7).

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

### R4 — Post-replay live state equals ring state

After a replay completes at frame N, the emulator's live state
(fresh `retro_serialize` + `kn_gameplay_hash`) must match the ring's
stored hash for frame N. Mismatches log `RB-LIVE-MISMATCH` with both
hashes and throw in dev (RF5).

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
- The slice spends no 60 Hz slot (`_tickReplayOnly`, as a rollback replay),
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

Every violation of R1-R6 produces a loud analyzer event. Zero of
any of these events across a real session log means the integrity
invariants held.

| Event | Invariant | Spec RF |
|-------|-----------|---------|
| `REPLAY-NORUN` | R2 | RF2 |
| `RB-INVARIANT-FIXUP` | R5 | RF3 |
| `FATAL-RING-STALE` | R3 | RF7 |
| `RB-LIVE-MISMATCH` | R4 | RF5 |
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
