/**
 * Two-player rollback match against the real server, in two local browsers.
 *
 * What the website's multiplayer does, minus a second person: a host and a
 * guest each open play.html in their own browser context, load the ROM from
 * disk (no ROM sharing), and the host starts a rollback game. The SSB64 menu
 * autopilot drives P1 (host) and P2 (guest) to a VS battle, then both press
 * random inputs. Every outgoing DataChannel message is held for LAT ms (+ up
 * to JITTER ms, never reordering a channel) to stand in for a real network.
 *
 * Checks, printed as JSON and written to OUT/summary.json:
 *   - gameplay hash of every finalized frame (read the engine's rollback
 *     window + 1 frames behind the head, so no rollback can change it any
 *     more: tests/hash-lag.mjs) is identical on both peers
 *   - no frame run on a prediction nothing corrects: one at the rollback
 *     window's edge whose input the peer is known to have made, or one run
 *     right after a reconnect reset, before C records predictions for that
 *     peer again (PREDICTED-KNOWN, specs/reconnect_inputs.qnt)
 *   - every state the guest applied left it with the host's hidden state:
 *     right after the apply step (the kn_set_frame after kn_sync_write), its
 *     18 packed hidden words, kn_get_hidden_state_fingerprint and RSP HLE
 *     state equal the host's as it read that state (kn_sync_read) for that
 *     frame. With RESYNC_ONE_BACK or RESYNC_SAME_FRAME at least one is
 *     compared. Reported as `resyncExtras` in summary.json
 *   - no failed rollbacks or integrity events (R2-R5 and fatal WASM traps
 *     in docs/netplay-invariants.md) in either peer's engine or sync log
 *   - no rollback input-stall timeouts below frame 300 on either peer
 *   - TICK-STUCK stalls, negotiated delay and rollback counts, for context
 *   - no report from an observer beside the engine (none reports now)
 *     (tests/observer-reports.mjs), in either page's sync log or
 *     client events, nor, with KN_DB set to the server's DB_PATH, in the
 *     server's client_events table for this room (without KN_DB the query to
 *     run by hand is printed). Reading KN_DB needs Node >= 22.13 (node:sqlite);
 *     on an older Node, or a database that cannot be read, the run fails.
 *   - no peer message dropped as off its schema: no `[protocol] dropped` line
 *     in either page's sync log (the engine drops a DataChannel string or a
 *     session-log ack that does not match web/src/peer-protocol.ts or
 *     protocol.gen.ts). Every string real pages send must match. Reported as
 *     `peerDropped` in summary.json; MALFORMED_PEER below expects its own.
 * Exits 1 for gameplay divergence; rollback failure; integrity events; a match
 * that never reaches a battle; fewer than 80% of finalized battle frames
 * compared; a boot input stall timeout; an observer disagreement; or a peer
 * message dropped that the run did not send off its schema.
 *
 *   just serve        # the real server on :27888, in another terminal
 *   KN_ROM=/path/ssb64-us.z64 [LAT=50] [JITTER=0] [LINK_KBPS=0] [BATTLE_SECONDS=60] [FREEZE_HOST_MS=0 | FREEZE_GUEST_MS=0] \
 *     [HEADED=1] [OUT=/tmp/two-player] [KN_DB=server DB_PATH, Node >= 22.13] node tests/rb-two-player.mjs
 *
 * Extra knobs, all off by default:
 *   FIGHT_RETURN_CHECK=1  In a rollback or lockstep battle (JITTER=20), close the host tab,
 *     return from the homepage, and verify the saved fight on both controllers
 *     through at least 300 more confirmed frames.
 *     FIGHT_RETURN_PING_DELAY_MS=110 holds the return host's startup RTT probes
 *     and requires a changed measured delay while both players restore the saved one.
 *   RESET_COMBO_CHECK=1  After battle evidence is collected, pause via Start
 *     and hold the real mobile reset control; require both peers at character
 *     select with the same running emulator and connected room.
 *   HOST_BROWSER=webkit / GUEST_BROWSER=webkit   Run that page in Playwright
 *     WebKit instead of Chromium (each defaults to Chromium independently,
 *     so either or both can be WebKit; the Chromium default args —
 *     swiftshader software GL — apply to whichever side stays Chromium).
 *     When the two resolved engines differ (e.g. HOST_BROWSER=webkit with
 *     GUEST_BROWSER unset), the WASM core boots on different JIT engines,
 *     the guest legitimately diverges during boot and requests the host's
 *     state (`BOOT-SYNC: guest requesting host state`, then `sync #1
 *     applied`); frames before that applied sync are excluded from the hash
 *     compare, the same way FREEZE mode excludes frames before its last
 *     resync. When the two engines match (including WebKit on both sides),
 *     no such exclusion applies — boot-window frames are compared like any
 *     other, on the same basis as the Chromium/Chromium default. Chromium
 *     software (swiftshader) GL caps two co-located emulators well under
 *     60fps on some machines; WebKit on both sides can use the real GPU and
 *     is the closer match to the reported prod case (iOS Safari, which is
 *     WebKit).
 *   HIDE_GUEST_MS=<n>   Halfway through the battle, hide the guest tab the
 *     way a real backgrounded browser tab does: `document.hidden`/
 *     `visibilityState` flip to hidden (via a property override installed
 *     at context creation — real tab backgrounding can't be simulated from
 *     outside the page) and its setInterval-driven ticks are throttled to
 *     ~1Hz (reusing THROTTLE_GUEST's mechanism), matching the browser's own
 *     background-tab throttling. A `visibilitychange` event fires so
 *     `_visChangeHandler` in netplay-rollback.js runs its real bg-return
 *     path (while the C rollback engine is active, returning does no
 *     fast-forward or resync). After HIDE_GUEST_MS, both flip back and a
 *     `visibilitychange` fires again; the second half of the battle plays
 *     normally. Mutually exclusive with FREEZE_HOST_MS/FREEZE_GUEST_MS and
 *     THROTTLE_GUEST. No exclusion window applies (unlike FREEZE mode) — the
 *     normal hash compare and integrity checks cover the whole match, and
 *     the run also fails (exit 1) if either peer's sync log has any
 *     `TICK-STUCK severity=error`, `PEER-PHANTOM`, or `RB-INPUT-STALL-TIMEOUT`
 *     line (issue #64: a backgrounded guest used to desync the match), or if
 *     the guest's log doesn't show the bg-return path ran. Counts reported
 *     under `hideGuest` in summary.json, alongside `hideGuestMs`.
 *   HIDE_GUEST_FROZEN=1   With HIDE_GUEST_MS, model a frozen tab instead
 *     (iOS backgrounding, bfcache: no JS at all while hidden): one
 *     synchronous evaluate hides the tab, blocks the guest's main thread for
 *     HIDE_GUEST_MS and shows it again, so `visibilitychange` fires on thaw
 *     before the packets queued during the freeze are processed. No ~1Hz
 *     throttle. Same pass/fail rules. A freeze of 5s or more lets the host
 *     phantom the guest (RB-INPUT-STALL-TIMEOUT), which fails the run;
 *     recovering from that is issue #69 item 3.
 *     Example: `HIDE_GUEST_MS=4000 HIDE_GUEST_FROZEN=1 JITTER=20`.
 *   THROTTLE_GUEST=1   ~15s into the battle, cap the guest page's
 *     setInterval-driven tick callbacks to an average of THROTTLE_GUEST_HZ
 *     (env, default 30) callbacks/s — a plain JS wrapper around
 *     window.setInterval, installed via an init script, modeling a device
 *     whose timers drop to that rate (scheduling detail in
 *     throttleInitScript below). Forces the host into rollback bursts so
 *     replay-catch-up frames actually occur.
 *   MIN_GAME_FPS=<n>   Fail (exit 1) if either peer's measured game fps
 *     (frames advanced / wall seconds, from the last non-replay
 *     _kn_post_tick frame) drops below n, or is missing. The measurement
 *     window is from ~15s into the battle (when THROTTLE_GUEST flips the
 *     guest's cap) to the end of battle when THROTTLE_GUEST=1, else the
 *     whole battle. Reported as `gameFps: {host, guest}` in summary.json,
 *     alongside each peer's `pacing: {capsCount, capsFrames, summaries}` —
 *     capsCount is pacing episodes started and capsFrames is paced (held)
 *     tick calls, both summed from the unsampled per-300-frame `PACING
 *     f=...` lines in the window (the rate-limited `PACING-THROTTLE
 *     start/end` lines undercount episodes) — and each peer's cumulative
 *     `TICK-PERF` scheduler counters (`droppedSlots`, `catchupFrames` — see
 *     #47) under `schedulerCounters`: the session total as of the last
 *     TICK-PERF line, not scoped to this window.
 *   VISUAL_CHECK=1   On both peers, piggyback on the existing _kn_post_tick
 *     hook: whenever idle (no replay in flight) and in battle, downscale
 *     `#game canvas` into an offscreen 48x36 canvas and keep its RGB bytes.
 *     After the match, frames present on both peers at the same frame
 *     number are diffed pairwise: mean absolute difference over all RGB
 *     bytes of the 48x36 signature. Two very different things score above
 *     baseline here, and only one of them is a bug:
 *       - Held-frame / capture-timing noise. Headless replay intentionally
 *         holds the last presented frame during a rollback burst (see
 *         RB_FULL_HEADLESS_DURING_REPLAY in netplay-rollback.js), so a
 *         frame captured right at catch-up can legitimately show the
 *         pre-rollback picture on one peer (e.g. a character still on the
 *         respawn platform) while the other has already moved on. Not a
 *         bug — expected given two independently-timed captures.
 *       - GL-state corruption (#43): vanished stage geometry/fighters, a
 *         stray polygon.
 *     An independent census across old-core (buggy) and fixed-core runs
 *     found a clean gap between the two: held/timing noise topped out at
 *     30.8, corruption started at 40 and ran up to 74.3, with zero frames
 *     scoring 31-40. So frames > 40 are "corrupted" (this is what fails the
 *     run); frames > 15 but <= 40 are reported informationally as
 *     `heldOrTimingDiffs` and do not fail anything.
 *     Frames inside a proven window the hash compare leaves out (a
 *     frozen-page recovery, a DROP_PEER_MS reconnect) are left out here too
 *     and counted as `framesExcluded`.
 *     Reported as `visualCheck: {framesCompared, framesExcluded, corrupted,
 *     corruptedNearReplayEnd, firstCorrupted, heldOrTimingDiffs, maxDiff}`
 *     in summary.json. `corruptedNearReplayEnd` counts corrupted frames at
 *     or one past a `C-REPLAY done: caught up at f=N` line in the host's
 *     sync log. Exits 1 if any frame is corrupted when VISUAL_CHECK=1.
 *   SUSPEND_GUEST_AUDIO=1   Guest context only: models Safari leaving the
 *     core's own AudioContext not running and refusing a resume without a
 *     gesture (#63 root cause). See suspendAudioInitScript below. The fix
 *     (stand-in audio clock) should recover boot without a second tap —
 *     the run fails if the guest needs more than one prompt click to boot.
 *   CLICK_DURING_BATTLE=1   Reproduces #62 (clicking the UI during a
 *     rollback match desyncs peers). At ~1/3 and ~2/3 of BATTLE_SECONDS,
 *     on the host first and then the guest ~2s later, clicks through the
 *     toolbar "more" menu into the feedback form (`#toolbar-more` →
 *     `.kn-feedback-toolbar-item` → a `.kn-feedback-cat` button) and closes
 *     it via `.kn-feedback-close` — the exact click path whose own
 *     `requestAnimationFrame` call (feedback.js's `_openModal`) used to
 *     hijack rollback's rAF interceptor and strand the captured Emscripten
 *     runner, per the measured #62 signature (no runner rescheduled, CP0
 *     Count unchanged) (see docs/netplay-invariants.md §R2).
 *     Fire-and-forget via setTimeout so it doesn't block the
 *     battle-length wait or change BATTLE_SECONDS.
 *     Each round is logged. Before the #62 fix this makes the
 *     gameplay-hash compare below fail (hundreds of finalized
 *     gameplay-hash mismatches observed before the fix, 0 after); after
 *     the fix it should pass like a CLICK_DURING_BATTLE=0 run.
 *   DROP_SIGNALING_MS=<n>   A third of the way into the battle, cut both
 *     pages' Socket.IO WebSocket and refuse reconnects for n ms, the way a
 *     server restart or a network drop does; the match itself runs over
 *     WebRTC and must carry on. Pick n long enough to span a 300-frame mesh
 *     health check at the frame rate this machine manages (40000 in the cloud
 *     container). The outage starts a third of the way in, so two thirds of
 *     BATTLE_SECONDS must cover n plus 20 s to reconnect. On top of the normal
 *     checks the run fails if either page: never reconnected; logged a
 *     TICK-STUCK or INPUT-STALL after the outage began (one
 *     before it is reported as tickStuckBeforeOutage and does not fail the
 *     run); or had its lifecycle machine report
 *     session-disagree or late-join-stranded (web/src/session.ts). This does
 *     not cover the host stalling on its own slot (2026-11-09): that lives in
 *     the lockstep path a solo game takes, see solo-signaling-drop.mjs.
 *   DROP_SIGNALING_GUEST_LATE_MS=<n>   With DROP_SIGNALING_MS: keep the
 *     guest's signaling down up to n ms longer than the host's, until the
 *     host has rejoined and seen a room without the guest. The guest then
 *     rejoins under a new socket id, and the host must keep the live WebRTC
 *     connection rather than evict it as a stale peer. The run fails if the
 *     host has not seen that roster within n ms. BATTLE_SECONDS must cover
 *     this too.
 *   HEAL_BOTH_SIDES=1   A channel that dies with no event, on both pages at
 *     once (specs/mesh_heal.qnt, specs/peer_connection.qnt
 *     peer_connection_heal_one_side). A third of the way in, once both pages
 *     are just past a health check (every 300 frames), each page's channel to
 *     the other reads closed, its close and state handlers are detached, and
 *     nothing arriving on it or on the unreliable input channel is taken in.
 *     Inputs stop: each page stalls, then marks the other a phantom, and only
 *     the next health check, on a C-rollback tick, can find it. The WebRTC
 *     signaling to the guest is held until its own check has run, so the
 *     host's offer cannot settle the guest before it decides. Fails unless
 *     the host (the lower slot) healed after it marked the guest a phantom and
 *     offered, every heal on the guest logs MESH-HEAL-WAIT (it waits for the
 *     host's offer), the guest applied exactly one state in the 15 s after the
 *     reconnect's resync, and it goes on making frames. While the check ran
 *     only on the JS lockstep path the guest stayed a phantom
 *     (phantomForeverTest); before the per-peer machine decided `heal` the
 *     guest offered too and the two offers crossed (crossedHealOffersTest).
 *     Frames are compared as with FREEZE_HOST_MS. Needs BATTLE_SECONDS >= 165.
 *   CATCH_UP_HOLE_MS=<n>   With DROP_PEER_MS: the host drops its input
 *     packets on the reconnected channel from that channel's first one until
 *     n ms after it sends the state, so the guest's catch-up after the
 *     reconnect waits on a hole (specs/catch_up_wait.qnt). The host's ticks
 *     pause for the first 8 s of the drop, so the guest is ahead of that
 *     state and does catch up from it. Fails if the
 *     catch-up stopped on the hole or the pages end more than 300 frames
 *     apart (the runaway). On main it fails: the waiting catch-up spun and
 *     sent a reliable input packet per slice, burying its asks.
 *   ASK_UNANSWERED_STALL_MS=<n>   A third of the way into the battle the guest
 *     drops its input packets for eight frames just ahead of it, for good
 *     (resends included), while later frames go through: the host learns
 *     they were made, asks for them, and is never answered
 *     (specs/ask_escalation.qnt). The hole stalls the host. On main the
 *     stall's own deadline recovers it (RB-INPUT-STALL-TIMEOUT at 5 s, the
 *     guest a phantom, then PEER-RECOVERED and a resync), so the match does
 *     not split there; the difference asserted is how: fails unless the
 *     host's ask goes overdue (`INPUT-ASK-OVERDUE … → push`), it pushes its
 *     state, the guest's inputs-settled answers it (`INPUT-ASK-PUSH-SETTLED`),
 *     no stall reaches its 5 s deadline (`RB-INPUT-STALL-TIMEOUT`) and the
 *     host's frame never stands still for 5 s, with no give-up. A hole that
 *     straddles the first push is predicted until the next push, then both
 *     pages are on the host's state: frames are compared from the last state
 *     the guest applied, which must be at or after the last push. With ASK_UNANSWERED_ACKS=1
 *     (ASK_UNANSWERED_STALL_MS >= 20000) the host's pushed states never reach the guest for
 *     n ms (until it gives up), so no push is applied or acknowledged and the guest plays
 *     on: fails unless the host pushes again to the
 *     limit, gives up (`INPUT-ASK-PUSH-GAVEUP`) and drops the player
 *     (`peer hard-disconnected`) rather than playing on split, the guest's
 *     page is told (`DROPPED-BY-HOST`) and joins again late onto the host's
 *     state (`late-join loaded`), no mesh heal adds it back, no late input
 *     follows on the host, and the frames from the late join's state match
 *     (specs/drop_is_final.qnt). The host's own 5 s stall deadline can make
 *     the guest a phantom before the push limit; that route passes too when
 *     the phantom ends the push (`INPUT-ASK-PUSH-ENDED … phantom`),
 *     `PEER-RECOVERED` resyncs and nobody is dropped. With ASK_UNANSWERED_ACK_LOST=1 the guest
 *     applies each push but drops its `recovery-settled:` and
 *     `inputs-settled:` for n ms: fails
 *     unless the push ends on the phantom the host's stall makes
 *     (`INPUT-ASK-PUSH-ENDED … phantom`), `PEER-RECOVERED` resyncs, nobody
 *     is given up on or dropped, and the frames from the last resync match.
 *   ASK_UNANSWERED_PHANTOM=1   With HEAL_BOTH_SIDES=1: once the heal's checks
 *     are done (its 15 s after the reconnect's resync), the guest drops its
 *     input for one frame just ahead of it, for good: #272's shape. #272's
 *     split (the host still holding the guest as a phantom after the heal,
 *     so the hole was never stalled on) is gone on main: the heal resets the
 *     peer (mesh-heal), and main recovers the hole by its 5 s stall
 *     deadline. Fails unless the input was dropped, the host's ask
 *     escalated and its push was acknowledged (INPUT-ASK-PUSH-SETTLED), no
 *     stall timed out, and the frames after the guest's last applied state
 *     match.
 *   ROLLBACK_AT_EDGE=1   A third of the way into the battle the host's
 *     input is held at nothing for a second and set to a button for frame F
 *     alone, so the guest predicts F wrong (C predicts from the newest input
 *     it has). The guest page holds the
 *     host's input for F (as a packet and inside any later packet's
 *     redundancy) until the guest stalls at its rollback window's edge for
 *     F (depth 7, the deepest C rolls back), then takes it in. Fails unless C
 *     rolled F back at depth 5 or more, with no DEEP-MISPREDICT-SKIP or
 *     FAILED-ROLLBACK, and the frames match: the deepest correctable
 *     misprediction, on main as on the fix.
 *   PAST_WINDOW_FORCED=1   As ROLLBACK_AT_EDGE, but a test-only switch
 *     (window.__test_runPastEdgeFor) lets the guest run past the edge stall
 *     for F, and the input is taken in three frames past the window: a
 *     misprediction too deep to roll back (C's DEEP-MISPREDICT-SKIP). The
 *     edge stall guards this in normal play; only this forced step reaches
 *     it. On main (with the switch alone) nothing corrects it. Fails unless
 *     the C log has the skip, the guest logged INPUT-PAST-WINDOW-MISMATCH, a
 *     state was applied after it, and the frames after that state match.
 *   DROP_PEER_MS=<n>   A third of the way into the battle, the guest's page
 *     closes its RTCPeerConnection to the host (pc.close() on the engine's
 *     peer entry for slot 0, KNState.peers), and the WebRTC signaling between
 *     the guest and the server (`webrtc-signal` frames, both ways) is dropped
 *     for n ms, so the engine's own disconnect and reconnect path runs: the
 *     host (lower slot) sends reconnect offers, one every 13 s at most, until
 *     one gets through. 1 reconnects at once; 12000 takes the host through a
 *     timed-out attempt and a retry. Both pages give up after 45 s, so keep
 *     n under about 25000. On top of the normal checks the run fails unless
 *     signaling frames were really dropped (`signalsDropped` above 0); with n
 *     longer than an attempt's deadline (the engine's
 *     _RECONNECT_ATTEMPT_TIMEOUT, 10 s, read from netplay-rollback.js), the
 *     host's log shows the retry (`reconnect attempt 1 timeout`, or an
 *     attempt 2 or later); and the logs show the reconnect offer (guest:
 *     `received reconnect offer`), the answer (host: `onWebRTCSignal: answer
 *     from` the guest), the channel open (guest: `DC open with ... slot: 0`),
 *     the reconnect resync (guest: `reconnect resync: sent`) and a resync
 *     applied after it. The frames from
 *     12 before the drop to the frame that resync lands on differ by design
 *     (each page ran on predicted input for the other) and are left out of
 *     the hash compare, the way a proven frozen-page recovery is
 *     (tests/frozen-recovery.mjs), and so are integrity reports up to 30
 *     frames after it; both are counted in `frozenRecovery`. Reported as
 *     `dropPeer` in summary.json. BATTLE_SECONDS must cover n plus 30 s in its
 *     last two thirds.
 *   DELAY_SYNC_ANSWER_MS=<n>   A third of the way into the battle the guest
 *     asks the host for a full resync through its network-change handler (a
 *     window `online` event: the immediate, numbered `sync-request-full` on
 *     the channel), and the host's answer is held for n ms, which must be
 *     longer than the guest's RESYNC_REQUEST_TIMEOUT_MS (8000): the host
 *     page's DataChannel send wrapper (tests/rb-page-network.mjs) holds the first
 *     `sync-answer-id:` it sends on the `sync-state` channel, and with it the
 *     `sync-start:` header and binary chunks queued behind it, then releases
 *     them in order. No engine hook. At its RESYNC-REQUEST-TIMEOUT the guest
 *     asks again on its own (RESYNC-REASK, specs/resync_reask.qnt); the late
 *     answer then arrives after that second request. The run fails unless the
 *     guest timed out, the host received both requests, the held answer
 *     reached the guest after the second request, the rules handled it
 *     (`SYNC-LATE-ANSWER-DROPPED`, `SYNC-LATE-ANSWER-IGNORED`, `sync state is
 *     not the answer awaited`, or a chunk timeout `for older request`; each is
 *     counted), and an answer to the newest request was applied (a `resync
 *     ready (... answerFor=N newest=N endsRequest=true)` after the second
 *     request, then `sync #k applied` before any other answer), so no
 *     request is left pending. Frames are compared as usual: no
 *     exclusion. Reported as `delaySyncAnswer` in summary.json. 10000 is
 *     enough on a quiet machine; the slower the machine, the larger n should
 *     be, since the second request must reach the host before the held
 *     answer is let go.
 *     DELAY_SYNC_ANSWER_AT=boot holds the boot sync's answer instead: the
 *     hold is armed on the host before the game starts, nothing is asked a
 *     third of the way in, and the logs are read from the match's start. The
 *     guest's boot sync (`BOOT-SYNC`, a numbered "now" request after the
 *     boot grace) goes unanswered past its deadline, the guest asks again,
 *     and the boot answer, the host's state from the boot grace, arrives
 *     after that second request, far behind the guest: the ordering of a
 *     run where a 14 s freeze held it up and it took the guest back 117
 *     frames (specs/resync_flow.qnt, bootAnswerAfterANewerRequestTest). The
 *     same checks apply.
 *   CATCH_UP_MS=<n>   A third of the way into the battle the guest asks the
 *     host for a full resync through its network-change handler (a window
 *     `online` event: an immediate, numbered `sync-request-full`), and the
 *     host's answer is held n ms on its way, as DELAY_SYNC_ANSWER_MS holds it,
 *     but for less than the guest's request deadline (8000): the answer
 *     arrives as the request's own, the host's state from n ms before, with
 *     the guest that far on. It is caught up from: applied, and the frames up
 *     to the guest's run again, unseen (SYNC-CATCH-UP; specs/resync_flow.qnt,
 *     ownAnswerBehindTest). Before, the guest's frame went back to the
 *     state's. The run fails unless the answer was held, the guest caught up
 *     all the way to the frame it was on, and a state was applied; frames
 *     are compared as usual, no exclusion. Reported as `catchUp` in
 *     summary.json. The other fault knobs are refused with it.
 *   DOUBLE_RESYNC_ASK=1   A third of the way into the battle the guest's
 *     network-change handler runs twice at once (two window `online`
 *     events): two immediate, numbered `sync-request-full` on the channel.
 *     The host answers the first and drops the second inside its 5 s rate
 *     limit; the first's answer reaches a guest that has moved on, so it is
 *     an older request's answer and behind, and is dropped
 *     (SYNC-LATE-ANSWER-DROPPED). Nothing else is coming for the resync the
 *     guest asked for. No engine hook. The run fails unless the host
 *     rate-limited a request, the late answer was dropped, and a host state
 *     was applied after the asks (at the request's deadline the guest asks
 *     again: RESYNC-REASK). Reported as `doubleResyncAsk` in summary.json.
 *     The other fault knobs are refused with it.
 *   C_ROLLBACK_TRAP=1   A third of the way into the battle every call of the
 *     guest's kn_pre_tick throws what a WASM trap throws (a
 *     WebAssembly.RuntimeError). A trap in the C engine's tick is fatal, as
 *     any core trap is: the guest logs C-ROLLBACK-THROW and FATAL-CORE-ABORT
 *     branch=c-rollback, shows the crash error and stops; the host drops it
 *     at the input deadline (PEER-PHANTOM) and plays on. The engine used to
 *     clear the replay and go on, and after three throws turn rollback off
 *     on that page alone (C-ROLLBACK-FALLBACK). The run fails unless the
 *     guest threw once, ended the match, showed the error, turned its worker
 *     coprocessor off (WORKER-COPROC AUTO-DISABLED) and stopped advancing,
 *     and the host dropped it and kept advancing. The guest is
 *     gone after that, so the run ends there: no hash compare. Reported as
 *     `cRollbackTrap` in summary.json. The other fault knobs are refused
 *     with it.
 *   START_SILENT=1   The host's delay and start frame (`rb-delay:`,
 *     `rb-init-frame:`) never reach the guest: the host's page drops them as
 *     it sends them, every time (specs/engine_start.qnt). A guest runs no
 *     frame until it arms its C engine with the host's delay, and one that
 *     has none by the deadline (RB_INIT_TIMEOUT_MS) stops and says so; it
 *     used to arm with its own delay (RB-INIT-TIMEOUT). The run fails unless
 *     the guest logged START-FAIL reason=no-host, showed the message, never
 *     armed and ran no frame, and the host dropped it (PEER-PHANTOM) and
 *     kept advancing. The guest never plays, so the run ends there: no
 *     battle and no hash compare. Reported as `startSilent`.
 *   START_LOST=1   The host's first delay and start frame are lost (dropped
 *     as the host sends them) and the guest's channel to the host closes
 *     while it waits for them. The armed host sends both again on every
 *     channel that opens (specs/engine_start.qnt, HOST_SENDS_BOTH): the
 *     guest arms with the host's delay when the channel is back, and the
 *     match is played and compared as any other. The run fails unless the
 *     host dropped them, the guest waited, its channel was closed and
 *     opened again, and it armed with the host's delay and never stopped.
 *     Reported as `startLost`. Both START knobs are refused with every
 *     other fault knob.
 *   START_HIDDEN=1   START_LOST, and while the guest waits its tab is hidden
 *     and shown again (`visibilitychange`, as HIDE_GUEST_MS) after the host
 *     has run frames. The lifecycle return used to move a waiting page's
 *     frame forward to the last remote frame it had seen, so the host's
 *     start frame was not its own and it stopped (START-FAIL start-frame;
 *     specs/engine_start.qnt, tabReturnWhileWaitingTest). Fails unless the
 *     START_LOST checks pass, the guest's tab came back, and its log shows
 *     the return left its frame alone (`waiting to arm — no
 *     fast-forward/resync`) and no fast-forward.
 *   RESYNC_ONE_BACK=1   A resync that lands exactly one frame behind the
 *     guest's counter (specs/ring_after_resync.qnt). A third of the way into
 *     the battle the guest's tick is paused (the engine's own pauseTick, as
 *     the demo's pause) for a second, so the host runs ahead, and it asks the
 *     host for a full resync (a window `online` event); the host answers at
 *     once with its state for its frame T. The guest page
 *     (resyncOneBackInitScript below) reads T from the answer's `sync-start:`
 *     header, resumes, and makes its copy of P1's stock count wrong just
 *     before its tick for T, so the ring's copy of T is the guest's own and
 *     differs from the host's. It holds its sync worker's reply with the
 *     decompressed state until that tick has run, and from T + 1 its
 *     kn_pre_tick is not run and the page is told 3, the engine's pacing
 *     hold, until the state is loaded (kn_sync_write): a pump that runs two
 *     ticks at once (its catch-up) cannot go past T + 1 before the released
 *     state reaches the page. So the state is applied with the counter at
 *     T + 1 and moved back exactly one frame (`sync frame reset: T+1 → T`). Frames
 *     are compared from T, T included: the ring's copy of T must be the
 *     host's state. Before kn_set_frame forgot the last save it kept the
 *     guest's own copy, and the compare failed at T. The run fails unless the
 *     guest logged that one-frame reset onto the answer's frame. Reported as
 *     `resyncOneBack` in summary.json. The other fault knobs are refused with
 *     it.
 *   RESYNC_SAME_FRAME=1   As RESYNC_ONE_BACK, but the state lands on the
 *     frame the guest is on, after kn_pre_tick has saved that frame and the
 *     frame has not run (specs/ring_after_resync.qnt,
 *     savedFrameDidNotRunTest). At its tick for T the guest page lets the
 *     real kn_pre_tick run (it saves T, with the wrong stock count) and tells
 *     the page 3, the engine's pacing hold, so T does not run, and holds T
 *     that way until the state is loaded. The held state is released then
 *     and applied with the counter still at T (`sync #n applied (frame
 *     T -> T`, no frame reset). While the page called kn_set_frame only when the frame
 *     changed, the ring kept the guest's own copy of T and the compare failed
 *     at T. Reported as `resyncSameFrame`.
 *   UNANSWERED_SOCKET_RESYNC=1   The lifecycle resync guard, armed and left to
 *     time out under an owed resync (#243's review: its timeout let the ask
 *     again go one second before the ask's own deadline). In rollback mode a
 *     tab shown again does not resync; the guard is armed by a full resync
 *     asked over the socket (_requestSocketFullResync), which a chunk timeout
 *     sends. A third of the way into the battle the guest's network-change
 *     handler asks the host for a resync (`online`), and the host page drops
 *     the binary chunks of its answer on `sync-state` (the header goes
 *     through), so the guest's 3 s chunk timeout asks over the socket and
 *     arms the guard. The host page drops its socket answer (a wrapper on
 *     io.Socket.prototype.emit, in the init script), and then the whole of
 *     its next answer on `sync-state` (the answer to the guest's first ask
 *     again, 8 s on). The guard times out at 15 s; the request's own
 *     deadline asks a second time at 16 s, and that one is answered. No
 *     engine hook. The run fails unless the chunk timeout armed the guard,
 *     the host dropped the socket answer and the ask again's answer, the
 *     guard timed out, the guest then sent its second ask again
 *     (`RESYNC-REASK ... ask=2/2`), and a host state was applied after it.
 *     Reported as `unansweredSocketResync` in summary.json. The other fault
 *     knobs are refused with it.
 *   UNANSWERED_SOCKET_RESYNC=giveup   Every answer is dropped instead (on
 *     `sync-state` and over the socket), so the owed resync's asks run out:
 *     the request, two asks again, then RESYNC-REASK-GIVEUP (the deadline's
 *     stopAsking). Fails unless the give-up is logged, nothing is applied
 *     from the guest's ask to the give-up nor asked after it, and the guest
 *     goes on making frames after it (I1: no stall).
 *   UNANSWERED_SOCKET_RESYNC=letgo   The host page is frozen for 7 s, so the
 *     guest makes it a phantom (5 s) and, when it is back, asks for a resync
 *     at a frame (`peer-recovery resync`: a coordinated request); the host
 *     page drops the whole of that answer, every time it sends it (the host
 *     can send it twice: once when its own wait for the target frame times
 *     out, and again at the target). Before the fix the request owed nothing,
 *     so its deadline let it go (step=letGo) and the guest stayed diverged
 *     (specs/resync_reask.qnt, coordinatedAnswerLostTest). Now it is owed:
 *     fails unless the request was sent, its answer dropped, its deadline
 *     asks again (step=askAgain, RESYNC-REASK), a state is applied after
 *     that, nothing is let go, and the guest goes on making frames. As with
 *     FREEZE_HOST_MS, frames are compared only from the guest's last applied
 *     resync.
 *   UNANSWERED_SOCKET_RESYNC=ignored   A late answer set aside because the
 *     newest request's answer is held (SYNC-LATE-ANSWER-IGNORED,
 *     keepsAwaitedAnswer). The guest asks; the host page drops the chunks of
 *     that answer, so the chunk timeout asks over the socket. The guest page
 *     holds the socket answer that comes back (a wrapper on
 *     io.Socket.prototype.onevent), the request's deadline asks again on
 *     the channel, and the moment the last chunk of that answer has been
 *     handled the guest page delivers the held socket answer. Both are
 *     decoded by the same worker, the newest first, and the guest page holds
 *     the worker's two results and delivers them back to back in one task
 *     (a held answer is applied at the next tick, a few ms after its decode,
 *     sooner than the late one's base64 decode ends): the late one is
 *     decoded while the newest one is held. Fails unless SYNC-LATE-ANSWER-IGNORED is
 *     logged and the newest answer is then applied, and the guest goes on
 *     making frames.
 *   SYNC_FOLLOW_UP=same|changed   The host's follow-up to an answer it sent
 *     unconfirmed (specs/sync_follow_up.qnt). A third of the way in the
 *     guest's input is held neutral and the host page is frozen for 7 s: the
 *     guest's peer recovery asks for a resync at a frame, as with
 *     UNANSWERED_SOCKET_RESYNC=letgo. Then each of the guest's input packets
 *     is held 2 s until the host answers. If it answers unconfirmed it
 *     watches the frame it sent (SYNC-FOLLOW-UP-WATCH); whether its deadline
 *     finds the frame confirmed is a race with its own stall, so an attempt
 *     answered confirmed is tried again, at most 3 times. `same` keeps the
 *     input neutral, so every held input matches its prediction: fails
 *     unless the follow-up is skipped (SYNC-FOLLOW-UP-SKIPPED), no other
 *     state goes out for it, and the first answer is applied. `changed`
 *     holds a button down while the inputs are held: fails unless
 *     SYNC-FOLLOW-UP-NEEDED is logged, the follow-up goes out after it, and
 *     the guest applies it. In two players `changed` is not reached: the
 *     guest's late inputs before the frame sent are settled once it is
 *     handed over and never fed, and pacing and the stale-input stall keep
 *     the host from answering on predicted inputs that reach that frame
 *     (docs/roadmap.md, Not verified). Either way the guest must go on
 *     making frames. Frames are compared as with FREEZE_HOST_MS.
 *     `direct` reaches the direct request instead (a `sync-request-full`
 *     with no frame, answered at once): the guest's input is held neutral,
 *     then a button is held down while its input packets are held for
 *     800 ms and go out together at its end; 250 ms in the guest sends its
 *     BOOT-SYNC request, which the ordered channel keeps right behind them. The host takes in the differing
 *     inputs (a rollback owed for its next tick) and answers the request
 *     before that tick: an unconfirmed state a3 (ASK_UNANSWERED_ACKS on
 *     3cdb9ff) left the guest on for good. Fails unless the host watches it,
 *     SYNC-FOLLOW-UP-NEEDED is logged, the follow-up goes out after it and
 *     the guest applies both, tried up to 3 times until the need is seen.
 *     `socket` reaches the same over the signaling socket
 *     (`sync-request-full-socket`, handleSocketSyncRequest): the host page
 *     drops the binary chunks of its next answer on `sync-state` and the
 *     guest's network-change handler asks (`online`), so the guest's 3 s
 *     chunk timeout asks again over the socket; just before that a button
 *     goes down while the guest's input packets are kept back. The host page
 *     holds the socket request (nothing orders the socket against the data
 *     channels); once it does, the inputs are released and the request is
 *     delivered right after the first of them is handled, so the host takes
 *     in the differing inputs, with a rollback owed for its next tick, and
 *     answers before that tick. Inputs that arrive after the answer would be
 *     settled by it and never fed in two players (docs/roadmap.md). Fails
 *     unless, after the host received the socket
 *     request, it watched its answer, logged SYNC-FOLLOW-UP-NEEDED,
 *     dispatched the follow-up over the socket and the guest applied both.
 *     Tried up to 3 times until a replay starting at or before the frame
 *     the answer was taken at shows it was rewritten (which any engine
 *     logs), so on an engine without the fix the answer the guest keeps is
 *     the last one applied, where the frames compared start, and they split.
 *     `owed` is `socket` with the held request delivered between two ticks
 *     while the replay the released inputs caused is still in flight (the
 *     engine replays a few frames per tick): the host takes its answer's
 *     state with a correction owed, the differing input fed before that
 *     state's watch existed (specs/sync_follow_up.qnt, owedAtTakeTest).
 *     Tried up to 3 times until the request is delivered with a replay in
 *     flight (any engine). Fails unless the watch starts changed
 *     (`SYNC-FOLLOW-UP-WATCH ... owed=1`), the follow-up goes out over the
 *     socket after it, and the guest applies both; on an engine that does
 *     not flag it the follow-up is skipped and the frames compared split.
 *   LINK_KBPS=<n>   Caps each RTCPeerConnection's simulated link at n
 *     kbit/s, in both directions, shared by all of that connection's data
 *     channels (tests/link-schedule.mjs): a message handed to send() on any
 *     channel waits until the link has carried every byte handed to it
 *     earlier on any channel of the connection, then for LAT and JITTER as
 *     usual, then goes to the real send(). A held message (DELAY_SYNC_ANSWER_MS)
 *     goes onto the link only when released, and holds back its own channel
 *     only. So the host's inputs on `lockstep` and `rollback-input` queue
 *     behind the state chunks on `sync-state`, as on a real connection.
 *     bufferedAmount: on `sync-state`, everything still in the simulated
 *     network for it; on the other channels, their own bytes the link has
 *     not carried yet. 2000 carries a resync answer (about 1.45 MB) in about
 *     6 s and two back to back in about 12 s, past the guest's 5 s peer-stale
 *     deadline for inputs queued behind them, while 320 KB (the engine's
 *     paced send: four chunks waiting and one more) takes 1.3 s. Combine with
 *     DELAY_SYNC_ANSWER_MS=10000 for the two answers back to back that
 *     starved the host's inputs (#236); alone, the guest asks for one plain
 *     resync a third of the way in, which must be applied. The other fault
 *     knobs are refused with it. The run fails on any DEEP-MISPREDICT-SKIP
 *     (a rollback deeper than the window, skipped) after the fault outside a
 *     proven frozen-page recovery, and a phantom of a page whose input
 *     messages waited 2 s or more on the link is never proven frozen
 *     (withoutLinkStarved in tests/frozen-recovery.mjs), so the link's
 *     outage cannot be left out as the container's. Reported as `link` in
 *     summary.json: per page bytes queued, the largest backlog, per channel
 *     the largest wait for the link and the starved messages, and after the
 *     fault the phantoms, skipped rollbacks, SYNC-SEND-STALLED and
 *     DC-FALLBACK lines.
 *   LOSE_INPUTS_BEFORE_FALLBACK=1   The match runs on the unreliable input
 *     channel (the host sets window._knTransportOverride = 'unreliable',
 *     what knDiag.setTransport('unreliable') sets, before it starts the game,
 *     and broadcasts `rb-transport:unreliable`). A third of the way into the
 *     battle the host's `rollback-input` channel stops delivering: its page's
 *     DataChannel send wrapper (tests/rb-page-network.mjs) drops every binary input it
 *     sends on that channel from then on, the way a stuck unordered SCTP
 *     stream does (the fault the engine's DC health monitor exists for). In
 *     this container the monitor has usually switched the host to the
 *     reliable channel long before (a slow page goes 500 ms without a new
 *     frame from its peer), so the host takes the unreliable transport up
 *     again mid-match (knDiag.setTransport('unreliable'), which broadcasts
 *     `rb-transport:unreliable` as at the start; a guest's own message is
 *     ignored, since only the host sets the transport). The
 *     guest stops hearing the host's new inputs, runs out of prediction room
 *     and stalls; the host stops hearing the guest's new frames and its
 *     health monitor switches it to the reliable channel by itself
 *     (DC-FALLBACK reason=ack-stale). The fault needs no engine hook. If
 *     fewer than two inputs were dropped before that switch, the host sets
 *     the unreliable transport again (five rounds at most). The inputs dropped before a switch must
 *     still reach the guest without the guest asking for them
 *     (specs/input_transport.qnt). The run fails unless the match started on
 *     the unreliable transport, the host took it up again, at least two of
 *     its inputs were dropped, and it logged DC-FALLBACK after that; and
 *     fails if, after the fault began, the guest asked the host for an input
 *     (`RB-INPUT-ASK ... slot=0`: one was lost and nothing sent it again), or
 *     either page logged PEER-PHANTOM or RB-INPUT-STALL-TIMEOUT. Frames are
 *     compared as usual: no exclusion.
 *     Reported as `loseBeforeFallback` in summary.json.
 *
 *   DESYNC_GUEST=1   The one knob that makes the match unhealthy on purpose:
 *     halfway through the battle the guest's copy of P1's stock count
 *     (SCPlayerData.stock_count, one byte of RDRAM) is changed and held for
 *     3 s, long enough that no rollback restores it. The peers are then
 *     really desynced, and the desync detector (web/src/page/desync-detector.ts) must
 *     say so: the run passes only if both peers' sync logs have a
 *     `KNDesync suspect ... field=stocks slot=0 trigger=flag` line after the
 *     change, and none before it; both peers log `KNDesync capture` for the
 *     first flagged frame at the same frame number (their screenshots are
 *     compared with each other); and the gameplay hash (kn_gameplay_hash,
 *     which lists SSB64's stock counts) differs on at least one frame from
 *     the change on, where the map's stock address is the one it lists, and
 *     on none before it. The
 *     game-state and full-state hashes are reported but not judged: the
 *     stock counts sit in an RDRAM block kn_game_state_hash leaves out as
 *     tainted, and kn_full_state_hash samples one byte in 64.
 *     Reported as `desyncGuest` in summary.json. Mutually exclusive with the
 *     other knobs. This is the detector's positive test; every other run
 *     only shows that it stays quiet.
 *
 *   MALFORMED_PEER=1   A third of the way into the battle each page sends
 *     the other strings off their schema on its real DataChannels: on
 *     `lockstep`, rb-check, rb-delay and roster with a field that is not a
 *     number, a kind no page knows, lockstep-ready JSON whose delay is not a
 *     number, and text that is not JSON; on `sync-state`, a sync-start
 *     header that is not one; and the guest also sends a sync-start that IS
 *     on its schema. The host must refuse both: its guest's sync-state
 *     channel is not the current host's, and that gate runs before the
 *     schema, so the host logs two `state header refused: from non-current
 *     host channel` lines and no `[protocol] dropped dc sync-state
 *     sync-start`; the guest refuses nothing. Read raw, rb-delay and
 *     sync-start would have set the delay and the state transfer's frame to
 *     NaN. Each engine must drop them before any handler reads them
 *     (KNCore.protocol.createBoundary): the run fails unless each page's sync
 *     log has exactly the expected `[protocol] dropped` lines (in any order:
 *     the two channels are not ordered against each other), all after the
 *     strings were sent and none with what was sent in it, and each page
 *     played at least 30 frames in the ten seconds after. Frames are compared as
 *     usual: no exclusion. Reported as `malformedPeer` in summary.json.
 *     Mutually exclusive with the knobs that act during the battle.
 *
 *   ADDRESS_MAP_CHECK=1   Checks the desync detector's address map for the
 *     ROM (web/src/address-maps.ts) against the running game: every 30
 *     frames each page reads the map's fields from RAM, and after the match
 *     the run fails unless, on both peers: the scene byte read the
 *     character select and then the battle; both players' character ids at
 *     the character select are fighter kinds (and, without
 *     MENU_AUTOPILOT=any-fighter, the two the autopilot picks); the battle
 *     header's status says the match gets under way and stays so; the
 *     game's battle-state pointer names the mapped battle state; stock counts
 *     in battle are plausible; the battle header is not empty; the RNG seed
 *     moves; and the fighter-buffer pointer, once set, points into RAM. Reported as
 *     `addressMapCheck` in summary.json. This shows a map is plausible, not
 *     that it is right: see docs/address-maps.md for the rest.
 *   ADDRESS_MAP_OF=<rom hash>   Try the map of another ROM on this one (a
 *     candidate map for a ROM that has none yet): the pages run the
 *     detector with it (?desync=force&desyncMap=) and ADDRESS_MAP_CHECK
 *     reads through it.
 *   MODE=rollback | lockstep   How the host plays the match (lockstep: nothing
 *     predicted, every frame waits for both players' inputs). Default rollback.
 *   MENU_AUTOPILOT=any-fighter | ssb64   any-fighter: the autopilot takes
 *     whatever fighter its puck lands on and the stage the cursor starts on,
 *     for a ROM whose menus are laid out differently from SSB64's (Smash
 *     Remix). ssb64: it picks its two fighters and its stage. Unset, the ROM
 *     decides: ssb64 for SSB64 US, any-fighter for anything else.
 *
 * Besides summary.json, OUT gets menu-inputs.json: what each page's driver
 * sent on the way to the battle, as the frames each input changed on, with
 * the ROM's hash and the input delay (negotiated, and each page's extra delay). It is a record of a run that reached a
 * match, to read or compare between runs. The driver decides from the game's
 * memory each frame, so a later run is driven again, not replayed from it.
 *
 * Needs an SSB64 ROM: US, or one built on it such as Smash Remix (the menu
 * autopilot reads SSB64's RAM layout). Two
 * emulators headless on one machine run slowly and measure noisy RTTs, so
 * compare runs with each other; HEADED=1 on a real machine is closer to play.
 */
import { PEER_TIMING } from '../web/src/peer-connection.ts';
import { resyncOffEvidence } from './resync-off-evidence.mjs';
import { chromium, webkit } from 'playwright';
import fs from 'fs';
import {
  frozenRecoveries,
  frozenRecoveryNote,
  inFrozenRecovery,
  inFrozenRecoveryAftermath,
  withoutLinkStarved,
} from './frozen-recovery.mjs';
import { fileURLToPath } from 'node:url';
import { requireCurrentBundle } from './bundle-check.mjs';
import { checkFightReturn, installFightProbe } from './rb-fight-return.mjs';
import { trackHashLag, unrecordedIn } from './hash-lag.mjs';
import { spansInFrames } from './link-schedule.mjs';
import { addNetworkInitScript } from './rb-page-network.mjs';
import {
  observerDbNote,
  observerEventsIn,
  observerEventsInDb,
  observerLinesIn,
  observerTotal,
} from './observer-reports.mjs';

const URL = process.env.KN_URL || 'http://localhost:27888';
const ROM = process.env.KN_ROM;
const LAT = Number(process.env.LAT || 50); // one-way ms
// How the match is played: rollback (default) or lockstep (nothing predicted).
const MODE = process.env.MODE || 'rollback';
if (!['rollback', 'lockstep'].includes(MODE)) {
  console.log(`MODE=${MODE} invalid: "rollback" or "lockstep"`);
  process.exit(1);
}
const JITTER = Number(process.env.JITTER || 0);
const BATTLE_SECONDS = Number(process.env.BATTLE_SECONDS || 60);
// Block the host's (or guest's) main thread this long mid-battle (a frozen
// tab). The other side drops it as a phantom; when it returns, the guest
// must be resynced to the host.
const FREEZE_HOST_MS = Number(process.env.FREEZE_HOST_MS || 0);
const FREEZE_GUEST_MS = Number(process.env.FREEZE_GUEST_MS || 0);
const FREEZE_MS = FREEZE_HOST_MS || FREEZE_GUEST_MS;
const OUT = process.env.OUT || '/tmp/two-player';
const HOST_BROWSER = process.env.HOST_BROWSER || 'chromium';
const GUEST_BROWSER = process.env.GUEST_BROWSER || 'chromium';
const THROTTLE_GUEST = process.env.THROTTLE_GUEST === '1';
const THROTTLE_GUEST_HZ = Number(process.env.THROTTLE_GUEST_HZ || 30);
const HIDE_GUEST_MS = Number(process.env.HIDE_GUEST_MS || 0);
const DROP_SIGNALING_MS = Number(process.env.DROP_SIGNALING_MS || 0);
const DROP_SIGNALING_GUEST_LATE_MS = Number(process.env.DROP_SIGNALING_GUEST_LATE_MS || 0);
const HIDE_GUEST_FROZEN = process.env.HIDE_GUEST_FROZEN === '1';
const VISUAL_CHECK = process.env.VISUAL_CHECK === '1';
// COMPARE_HASH_LAG=N: also read the gameplay and game-state hashes N frames
// behind the head, as the harness did before its lag came from the engine
// (12), and report how those frames compare (`earlyLagCompare`): how many
// differ, and how many of those agree at the run's own lag. Reported only.
const COMPARE_HASH_LAG = Number(process.env.COMPARE_HASH_LAG || 0);
if (!(Number.isInteger(COMPARE_HASH_LAG) && COMPARE_HASH_LAG >= 0)) {
  console.log(`COMPARE_HASH_LAG=${process.env.COMPARE_HASH_LAG} invalid: a whole number of frames`);
  process.exit(1);
}
const MIN_GAME_FPS = process.env.MIN_GAME_FPS ? Number(process.env.MIN_GAME_FPS) : null;
const SUSPEND_GUEST_AUDIO = process.env.SUSPEND_GUEST_AUDIO === '1';
const CLICK_DURING_BATTLE = process.env.CLICK_DURING_BATTLE === '1';
const DESYNC_GUEST = process.env.DESYNC_GUEST === '1';
const MALFORMED_PEER = process.env.MALFORMED_PEER === '1';
const START_SILENT = process.env.START_SILENT === '1';
const START_HIDDEN = process.env.START_HIDDEN === '1';
const START_LOST = process.env.START_LOST === '1' || START_HIDDEN;
const DROP_PEER_MS = Number(process.env.DROP_PEER_MS || 0);
// CATCH_UP_HOLE_MS: with DROP_PEER_MS, how long the host drops its input
// packets on the reconnected channel from its first one.
const CATCH_UP_HOLE_MS = Number(process.env.CATCH_UP_HOLE_MS || 0);
// ASK_UNANSWERED_STALL_MS: how long the guest drops its input packets, a third of
// the way into the battle, so the host's asks for them go unanswered.
const ASK_UNANSWERED_STALL_MS = Number(process.env.ASK_UNANSWERED_STALL_MS || 0);
const ASK_UNANSWERED_RECOVER_MS = 30000;
// ASK_UNANSWERED_ACKS=1: the host's pushed states never reach the guest, so
// every push goes unanswered while the guest plays on, and the host drops the
// player (needs a window longer than the escalation and three 5 s push
// deadlines, about 17 s).
const ASK_UNANSWERED_ACKS = process.env.ASK_UNANSWERED_ACKS === '1';
// ASK_UNANSWERED_ACK_LOST=1: the guest gets each push and applies it, but its
// acknowledgements (`recovery-settled:` and `inputs-settled:`) are dropped.
// The latter also tells the host not to wait
// for the frames the state skipped, so the host stalls on them, its 5 s stall
// deadline makes the guest a phantom, and the phantom ends the push
// (END_ON_RECONNECT): PEER-RECOVERED's resync recovers it, nobody is dropped.
const ASK_UNANSWERED_ACK_LOST = process.env.ASK_UNANSWERED_ACK_LOST === '1';
// RESYNC_OFF=1: the host starts the game with resync off (the room's
// toggle). Only with ASK_UNANSWERED_STALL_MS: no recovery actor is started,
// nobody is pushed again or dropped, and the hole stays with the stall path.
// Nothing corrects the hole with resync off, so the pages may differ from
// it on (as on main with the toggle off): frames are compared from the boot
// sync up to the hole's first frame, and must match there.
const RESYNC_OFF = process.env.RESYNC_OFF === '1';
if (RESYNC_OFF && !(ASK_UNANSWERED_STALL_MS > 0)) {
  console.log('RESYNC_OFF needs ASK_UNANSWERED_STALL_MS (the hash checks end at its hole)');
  process.exit(1);
}
if ((ASK_UNANSWERED_ACKS || ASK_UNANSWERED_ACK_LOST) && !(ASK_UNANSWERED_STALL_MS >= 20000)) {
  console.log('ASK_UNANSWERED_ACKS and ASK_UNANSWERED_ACK_LOST need ASK_UNANSWERED_STALL_MS >= 20000');
  process.exit(1);
}
if (ASK_UNANSWERED_ACKS && ASK_UNANSWERED_ACK_LOST) {
  console.log('ASK_UNANSWERED_ACKS and ASK_UNANSWERED_ACK_LOST are separate runs');
  process.exit(1);
}
const askUnanswered = {
  hostAt: null,
  guestAt: null,
  dropped: 0,
  range: null,
  freezeMs: 0,
  droppedByHost: null,
  lateJoinedAt: null,
  statesDropped: 0,
};
// ASK_UNANSWERED_ACKS: how long the dropped guest may take to join again late
// (a gesture tap, the state, the boot).
const ASK_LATE_JOIN_MS = 90000;
const askPhantom = { hostAt: null, guestAt: null, range: null, dropped: 0, armed: false };
const pastWindow = { hostAt: null, guestAt: null, frame: null, held: 0, releasedAt: null, released: false };
if (CATCH_UP_HOLE_MS > 0 && !(DROP_PEER_MS > 0)) {
  console.log('CATCH_UP_HOLE_MS needs DROP_PEER_MS');
  process.exit(1);
}
// A host this many frames ahead of the guest at the end has run away from it.
const RUNAWAY_FRAMES = 300;
const DELAY_SYNC_ANSWER_MS = Number(process.env.DELAY_SYNC_ANSWER_MS || 0);
const DELAY_SYNC_ANSWER_AT = process.env.DELAY_SYNC_ANSWER_AT || 'battle';
if (!['battle', 'boot'].includes(DELAY_SYNC_ANSWER_AT)) {
  console.log(`DELAY_SYNC_ANSWER_AT=${DELAY_SYNC_ANSWER_AT} invalid — must be battle or boot`);
  process.exit(1);
}
const LOSE_INPUTS_BEFORE_FALLBACK = process.env.LOSE_INPUTS_BEFORE_FALLBACK === '1';
const LINK_KBPS = Number(process.env.LINK_KBPS || 0);
const DOUBLE_RESYNC_ASK = process.env.DOUBLE_RESYNC_ASK === '1';
const C_ROLLBACK_TRAP = process.env.C_ROLLBACK_TRAP === '1';
const CATCH_UP_MS = Number(process.env.CATCH_UP_MS || 0);
const RESYNC_ONE_BACK = process.env.RESYNC_ONE_BACK === '1';
const RESYNC_SAME_FRAME = process.env.RESYNC_SAME_FRAME === '1';
// Which of the two resync orderings the run lands, if either.
const RESYNC_FAULT = RESYNC_ONE_BACK ? 'one-back' : RESYNC_SAME_FRAME ? 'same-frame' : null;
const RESYNC_FAULT_KNOB = RESYNC_ONE_BACK ? 'RESYNC_ONE_BACK' : 'RESYNC_SAME_FRAME';
const UNANSWERED_SOCKET_RESYNC_RAW = process.env.UNANSWERED_SOCKET_RESYNC || '';
if (!['', '0', '1', 'giveup', 'letgo', 'ignored'].includes(UNANSWERED_SOCKET_RESYNC_RAW)) {
  console.log(`UNANSWERED_SOCKET_RESYNC=${UNANSWERED_SOCKET_RESYNC_RAW} invalid: 1, giveup, letgo or ignored`);
  process.exit(1);
}
const UNANSWERED_SOCKET_RESYNC = !['', '0'].includes(UNANSWERED_SOCKET_RESYNC_RAW);
// 'guard' (=1), 'giveup', 'letgo' or 'ignored'.
const UNANSWERED_VARIANT = UNANSWERED_SOCKET_RESYNC_RAW === '1' ? 'guard' : UNANSWERED_SOCKET_RESYNC_RAW;
// The letgo variant freezes the host as FREEZE_HOST_MS does, and is compared as it is.
const UNANSWERED_LETGO_FREEZE_MS = 7000;
// FORCE_DELAY=<n>: both pages pick a frame delay of n (Auto off) before the
// game starts. The engine may still re-tune it from the measured RTT
// (`delay re-tuned` in the sync log says what it chose).
const FORCE_DELAY = process.env.FORCE_DELAY ? Number(process.env.FORCE_DELAY) : null;
const SYNC_FOLLOW_UP = process.env.SYNC_FOLLOW_UP || '';
if (!['', 'same', 'changed', 'direct', 'socket', 'owed'].includes(SYNC_FOLLOW_UP)) {
  console.log(`SYNC_FOLLOW_UP=${SYNC_FOLLOW_UP} invalid: same, changed, direct, socket or owed`);
  process.exit(1);
}
// SYNC_FOLLOW_UP freezes the host as letgo does, and how long the guest's
// inputs are held after it, so the host's answer goes out unconfirmed.
const SYNC_FOLLOW_UP_FREEZE_MS = 7000;
// How long each of the guest's input packets is held after the freeze, so the
// host answers on predicted inputs.
const SYNC_FOLLOW_UP_HOLD_MS = 2000;
// SYNC_FOLLOW_UP=direct: how long the guest's input packets (a button held)
// are held, and how far into that its direct request goes out behind them.
const SYNC_FOLLOW_UP_DIRECT_HOLD_MS = 800;
const SYNC_FOLLOW_UP_DIRECT_ASK_MS = 250;
// SYNC_FOLLOW_UP=socket: when, after the guest's `online` ask, its input
// packets start being held (a button down), and for how long: across its
// chunk timeout's socket request (3 s after the answer's header) and the
// host's answer to it.
const SYNC_FOLLOW_UP_SOCKET_HOLD_FROM_MS = 2200;
// Whether the host's deadline finds its frame confirmed is a race with its own
// stall; an attempt whose answer goes out confirmed is tried again.
const SYNC_FOLLOW_UP_ATTEMPTS = 3;
// The recovery request, its answer, the follow-up's decision once confirmed.
const SYNC_FOLLOW_UP_RECOVER_MS = 30000 * SYNC_FOLLOW_UP_ATTEMPTS;
// HEAL_BOTH_SIDES: both pages' channel to the other dies silently at once.
const HEAL_BOTH_SIDES = process.env.HEAL_BOTH_SIDES === '1';
// The mesh health check runs every 300 frames; the fault starts within this
// many frames after one on both pages, so the next comes after the 3 s stall
// and the 5 s phantom (specs/mesh_heal.qnt: the check must heal a phantom).
const HEAL_AFTER_BOUNDARY_WITHIN = 40;
// The phantom (5 s), up to two health checks (300 frames each, ~30 s
// headless), the reconnect and its resync.
const HEAL_RECOVER_MS = 90000;
// After the first state the guest applies, how long a second one is looked for.
const HEAL_SECOND_STATE_MS = 15000;
// ASK_UNANSWERED_PHANTOM: with HEAL_BOTH_SIDES, one frame dropped for good after the heal.
const ASK_UNANSWERED_PHANTOM = process.env.ASK_UNANSWERED_PHANTOM === '1';
if (ASK_UNANSWERED_PHANTOM && !HEAL_BOTH_SIDES) {
  console.log('ASK_UNANSWERED_PHANTOM needs HEAL_BOTH_SIDES=1');
  process.exit(1);
}
// After the drop, how long the host's asks, a stall and a resync may take.
const ASK_PHANTOM_RECOVER_MS = 30000;
// ROLLBACK_AT_EDGE / PAST_WINDOW_FORCED: one real host input held until the
// guest is at (or, forced, past) its rollback window's edge.
const ROLLBACK_AT_EDGE = process.env.ROLLBACK_AT_EDGE === '1';
const PAST_WINDOW_FORCED = process.env.PAST_WINDOW_FORCED === '1';
const PAST_WINDOW_INPUT = ROLLBACK_AT_EDGE || PAST_WINDOW_FORCED;
const PAST_KNOB = ROLLBACK_AT_EDGE ? 'ROLLBACK_AT_EDGE' : 'PAST_WINDOW_FORCED';
if (ROLLBACK_AT_EDGE && PAST_WINDOW_FORCED) {
  console.log('ROLLBACK_AT_EDGE and PAST_WINDOW_FORCED are mutually exclusive');
  process.exit(1);
}
// The engine's visible rollback cap (KN_MAX_VISIBLE_ROLLBACK_DEPTH). Input F
// is applied at frame F + delay: the edge stall holds the guest at depth 7;
// forced past it, the input is let go at depth 10.
const ROLLBACK_CAP = 7;
const PAST_WINDOW_FORCED_DEPTH = ROLLBACK_CAP + 3;
const PAST_WINDOW_RECOVER_MS = 30000;
// Main's rollback input-stall deadline (MAX_STALL_MS + RESEND_TIMEOUT_MS).
const STALL_DEADLINE_MS = 5000;
const FREEZE_LIKE =
  FREEZE_MS > 0 ||
  UNANSWERED_VARIANT === 'letgo' ||
  SYNC_FOLLOW_UP !== '' ||
  HEAL_BOTH_SIDES ||
  PAST_WINDOW_FORCED ||
  // The stall shape recovers by the host's state: a hole that straddles the
  // first push is predicted until the next one, then both are on the host's
  // state. Compared from the last state the guest applied.
  // ACKS: the guest is dropped and joins again late; compared from the
  // late join's state.
  ASK_UNANSWERED_STALL_MS > 0;
// The guest's own deadline on a resync request (netplay-rollback.js).
const RESYNC_REQUEST_TIMEOUT_MS = 8000;
// The server's database (its DB_PATH), to count the observers' client events in.
const KN_DB = process.env.KN_DB || '';
const ADDRESS_MAP_CHECK = process.env.ADDRESS_MAP_CHECK === '1';
const ADDRESS_MAP_OF = process.env.ADDRESS_MAP_OF || '';
const SSB64_US_HASH = 'S15592e79d3c5295cef4371d4992f0bd25bec2102fc29644c93e682f7ea99ef3d';
if (process.env.MENU_AUTOPILOT && !['any-fighter', 'ssb64'].includes(process.env.MENU_AUTOPILOT)) {
  console.log(`MENU_AUTOPILOT=${process.env.MENU_AUTOPILOT} invalid: "any-fighter" or "ssb64"`);
  process.exit(1);
}
// Unset: SSB64 US gets the strict driver, any other ROM the one that takes
// whatever fighter and stage it lands on. Decided once the host page has
// loaded the ROM, from the hash the page computed: for an archive that is
// the ROM inside it, not the file given here.
let MENU_AUTOPILOT = process.env.MENU_AUTOPILOT || '';
let ROM_HASH = '';
if (ADDRESS_MAP_OF && !/^S[0-9a-f]{64}$/.test(ADDRESS_MAP_OF)) {
  console.log('ADDRESS_MAP_OF must be a ROM hash: S followed by 64 hex digits');
  process.exit(1);
}
// Appended to both pages' URLs as it stands, so it starts with `&`.
const QUERY = (process.env.KN_QUERY || '') + (ADDRESS_MAP_OF ? `&desync=force&desyncMap=${ADDRESS_MAP_OF}` : '');

// Validate knobs before launching anything: a typo here should fail fast,
// not surface as a confusing result after minutes of gameplay.
for (const [name, value] of [
  ['HOST_BROWSER', HOST_BROWSER],
  ['GUEST_BROWSER', GUEST_BROWSER],
]) {
  if (value !== 'chromium' && value !== 'webkit') {
    console.log(`${name}=${value} invalid — must be exactly "chromium" or "webkit"`);
    process.exit(1);
  }
}
if (MIN_GAME_FPS !== null && !(Number.isFinite(MIN_GAME_FPS) && MIN_GAME_FPS > 0)) {
  console.log(`MIN_GAME_FPS=${process.env.MIN_GAME_FPS} invalid — must be a finite number > 0`);
  process.exit(1);
}
if (!Number.isFinite(THROTTLE_GUEST_HZ) || THROTTLE_GUEST_HZ <= 0) {
  console.log(`THROTTLE_GUEST_HZ=${process.env.THROTTLE_GUEST_HZ} invalid — must be a finite number > 0`);
  process.exit(1);
}
if (THROTTLE_GUEST && !(BATTLE_SECONDS > 15)) {
  console.log(`THROTTLE_GUEST=1 needs BATTLE_SECONDS > 15 (the throttle flips 15s in) — got ${BATTLE_SECONDS}`);
  process.exit(1);
}
if (!Number.isFinite(HIDE_GUEST_MS) || HIDE_GUEST_MS < 0) {
  console.log(`HIDE_GUEST_MS=${process.env.HIDE_GUEST_MS} invalid — must be a finite number >= 0`);
  process.exit(1);
}
if (HIDE_GUEST_FROZEN && !(HIDE_GUEST_MS > 0)) {
  console.log('HIDE_GUEST_FROZEN=1 needs HIDE_GUEST_MS > 0');
  process.exit(1);
}
if (!(Number.isFinite(DROP_SIGNALING_MS) && DROP_SIGNALING_MS >= 0)) {
  console.log(`DROP_SIGNALING_MS=${process.env.DROP_SIGNALING_MS} invalid — must be a finite number >= 0`);
  process.exit(1);
}
if (DROP_SIGNALING_MS > 0 && (FREEZE_MS > 0 || THROTTLE_GUEST || HIDE_GUEST_MS > 0 || CLICK_DURING_BATTLE)) {
  console.log('DROP_SIGNALING_MS is mutually exclusive with the FREEZE, THROTTLE, HIDE and CLICK knobs');
  process.exit(1);
}
if (
  DESYNC_GUEST &&
  (FREEZE_MS > 0 ||
    THROTTLE_GUEST ||
    HIDE_GUEST_MS > 0 ||
    CLICK_DURING_BATTLE ||
    DROP_SIGNALING_MS > 0 ||
    VISUAL_CHECK ||
    MIN_GAME_FPS !== null ||
    SUSPEND_GUEST_AUDIO ||
    ADDRESS_MAP_CHECK)
) {
  console.log('DESYNC_GUEST is mutually exclusive with the other knobs');
  process.exit(1);
}
for (const [name, value] of [
  ['DROP_PEER_MS', DROP_PEER_MS],
  ['DELAY_SYNC_ANSWER_MS', DELAY_SYNC_ANSWER_MS],
]) {
  if (!(Number.isFinite(value) && value >= 0)) {
    console.log(`${name}=${process.env[name]} invalid — must be a finite number >= 0`);
    process.exit(1);
  }
  if (
    value > 0 &&
    (FREEZE_MS > 0 ||
      THROTTLE_GUEST ||
      HIDE_GUEST_MS > 0 ||
      CLICK_DURING_BATTLE ||
      DROP_SIGNALING_MS > 0 ||
      DESYNC_GUEST ||
      (DROP_PEER_MS > 0 && DELAY_SYNC_ANSWER_MS > 0))
  ) {
    console.log(`${name} is mutually exclusive with the FREEZE, THROTTLE, HIDE, CLICK, DROP and DESYNC knobs`);
    process.exit(1);
  }
}
if (
  LOSE_INPUTS_BEFORE_FALLBACK &&
  (FREEZE_MS > 0 ||
    THROTTLE_GUEST ||
    HIDE_GUEST_MS > 0 ||
    CLICK_DURING_BATTLE ||
    DROP_SIGNALING_MS > 0 ||
    DROP_PEER_MS > 0 ||
    DELAY_SYNC_ANSWER_MS > 0 ||
    LINK_KBPS > 0 ||
    DESYNC_GUEST)
) {
  console.log(
    'LOSE_INPUTS_BEFORE_FALLBACK is mutually exclusive with the FREEZE, THROTTLE, HIDE, CLICK, DROP, DELAY, LINK and DESYNC knobs',
  );
  process.exit(1);
}
if (DELAY_SYNC_ANSWER_MS > 0 && !(DELAY_SYNC_ANSWER_MS > RESYNC_REQUEST_TIMEOUT_MS)) {
  console.log(`DELAY_SYNC_ANSWER_MS must be longer than the guest's request deadline (${RESYNC_REQUEST_TIMEOUT_MS})`);
  process.exit(1);
}
if (!(Number.isFinite(LINK_KBPS) && LINK_KBPS >= 0)) {
  console.log(`LINK_KBPS=${process.env.LINK_KBPS} invalid — must be a finite number >= 0`);
  process.exit(1);
}
if (
  LINK_KBPS > 0 &&
  (FREEZE_MS > 0 ||
    THROTTLE_GUEST ||
    HIDE_GUEST_MS > 0 ||
    CLICK_DURING_BATTLE ||
    DROP_SIGNALING_MS > 0 ||
    DROP_PEER_MS > 0 ||
    DESYNC_GUEST)
) {
  console.log('LINK_KBPS combines only with DELAY_SYNC_ANSWER_MS among the fault knobs');
  process.exit(1);
}
if (
  DOUBLE_RESYNC_ASK &&
  (FREEZE_MS > 0 ||
    THROTTLE_GUEST ||
    HIDE_GUEST_MS > 0 ||
    CLICK_DURING_BATTLE ||
    DROP_SIGNALING_MS > 0 ||
    DROP_PEER_MS > 0 ||
    DELAY_SYNC_ANSWER_MS > 0 ||
    LINK_KBPS > 0 ||
    LOSE_INPUTS_BEFORE_FALLBACK ||
    DESYNC_GUEST)
) {
  console.log('DOUBLE_RESYNC_ASK is mutually exclusive with the other fault knobs');
  process.exit(1);
}
if (
  SYNC_FOLLOW_UP &&
  (FREEZE_MS > 0 ||
    THROTTLE_GUEST ||
    HIDE_GUEST_MS > 0 ||
    CLICK_DURING_BATTLE ||
    DROP_SIGNALING_MS > 0 ||
    DROP_PEER_MS > 0 ||
    DELAY_SYNC_ANSWER_MS > 0 ||
    LINK_KBPS > 0 ||
    LOSE_INPUTS_BEFORE_FALLBACK ||
    DOUBLE_RESYNC_ASK ||
    UNANSWERED_SOCKET_RESYNC ||
    RESYNC_FAULT ||
    DESYNC_GUEST ||
    CATCH_UP_MS > 0 ||
    HEAL_BOTH_SIDES)
) {
  console.log('SYNC_FOLLOW_UP is mutually exclusive with the other fault knobs');
  process.exit(1);
}
if (
  RESYNC_FAULT &&
  ((RESYNC_ONE_BACK && RESYNC_SAME_FRAME) ||
    FREEZE_MS > 0 ||
    THROTTLE_GUEST ||
    HIDE_GUEST_MS > 0 ||
    CLICK_DURING_BATTLE ||
    DROP_SIGNALING_MS > 0 ||
    DROP_PEER_MS > 0 ||
    DELAY_SYNC_ANSWER_MS > 0 ||
    LINK_KBPS > 0 ||
    LOSE_INPUTS_BEFORE_FALLBACK ||
    DESYNC_GUEST ||
    DOUBLE_RESYNC_ASK ||
    UNANSWERED_SOCKET_RESYNC ||
    SYNC_FOLLOW_UP ||
    HEAL_BOTH_SIDES ||
    CATCH_UP_MS > 0)
) {
  console.log('RESYNC_ONE_BACK and RESYNC_SAME_FRAME are mutually exclusive with each other and the other fault knobs');
  process.exit(1);
}
// The request, its answer held for one frame, and enough frames after it to compare.
const RESYNC_ONE_BACK_RECOVER_MS = 30000;
if (
  HEAL_BOTH_SIDES &&
  (FREEZE_MS > 0 ||
    THROTTLE_GUEST ||
    HIDE_GUEST_MS > 0 ||
    CLICK_DURING_BATTLE ||
    DROP_SIGNALING_MS > 0 ||
    DROP_PEER_MS > 0 ||
    DELAY_SYNC_ANSWER_MS > 0 ||
    LINK_KBPS > 0 ||
    LOSE_INPUTS_BEFORE_FALLBACK ||
    DOUBLE_RESYNC_ASK ||
    UNANSWERED_SOCKET_RESYNC ||
    RESYNC_FAULT ||
    DESYNC_GUEST ||
    CATCH_UP_MS > 0 ||
    SYNC_FOLLOW_UP)
) {
  console.log('HEAL_BOTH_SIDES is mutually exclusive with the other fault knobs');
  process.exit(1);
}
if (
  PAST_WINDOW_INPUT &&
  (HEAL_BOTH_SIDES ||
    DROP_PEER_MS > 0 ||
    FREEZE_MS > 0 ||
    RESYNC_FAULT ||
    SYNC_FOLLOW_UP ||
    ASK_UNANSWERED_STALL_MS > 0 ||
    CATCH_UP_MS > 0)
) {
  console.log(`${PAST_KNOB} is mutually exclusive with the other fault knobs`);
  process.exit(1);
}
if (
  UNANSWERED_SOCKET_RESYNC &&
  (FREEZE_MS > 0 ||
    THROTTLE_GUEST ||
    HIDE_GUEST_MS > 0 ||
    CLICK_DURING_BATTLE ||
    DROP_SIGNALING_MS > 0 ||
    DROP_PEER_MS > 0 ||
    DELAY_SYNC_ANSWER_MS > 0 ||
    LINK_KBPS > 0 ||
    LOSE_INPUTS_BEFORE_FALLBACK ||
    DOUBLE_RESYNC_ASK ||
    CATCH_UP_MS > 0 ||
    DESYNC_GUEST)
) {
  console.log('UNANSWERED_SOCKET_RESYNC is mutually exclusive with the other fault knobs');
  process.exit(1);
}
// The chunk timeout (3 s), the guard's timeout (15 s), the second ask again
// (16 s), its answer.
const UNANSWERED_SOCKET_RESYNC_RECOVER_MS = 45000;
if (!(Number.isFinite(CATCH_UP_MS) && CATCH_UP_MS >= 0)) {
  console.log(`CATCH_UP_MS=${process.env.CATCH_UP_MS} invalid — must be a finite number >= 0`);
  process.exit(1);
}
if (CATCH_UP_MS > 0 && !(CATCH_UP_MS < RESYNC_REQUEST_TIMEOUT_MS)) {
  console.log(`CATCH_UP_MS must be shorter than the guest's request deadline (${RESYNC_REQUEST_TIMEOUT_MS})`);
  process.exit(1);
}
if (
  CATCH_UP_MS > 0 &&
  (FREEZE_MS > 0 ||
    THROTTLE_GUEST ||
    HIDE_GUEST_MS > 0 ||
    CLICK_DURING_BATTLE ||
    DROP_SIGNALING_MS > 0 ||
    DROP_PEER_MS > 0 ||
    DELAY_SYNC_ANSWER_MS > 0 ||
    LINK_KBPS > 0 ||
    LOSE_INPUTS_BEFORE_FALLBACK ||
    DOUBLE_RESYNC_ASK ||
    UNANSWERED_SOCKET_RESYNC ||
    RESYNC_FAULT ||
    DESYNC_GUEST ||
    SYNC_FOLLOW_UP ||
    HEAL_BOTH_SIDES)
) {
  console.log('CATCH_UP_MS is mutually exclusive with the other fault knobs');
  process.exit(1);
}
if (
  C_ROLLBACK_TRAP &&
  (FREEZE_MS > 0 ||
    THROTTLE_GUEST ||
    HIDE_GUEST_MS > 0 ||
    CLICK_DURING_BATTLE ||
    DROP_SIGNALING_MS > 0 ||
    DROP_PEER_MS > 0 ||
    DELAY_SYNC_ANSWER_MS > 0 ||
    LINK_KBPS > 0 ||
    LOSE_INPUTS_BEFORE_FALLBACK ||
    DOUBLE_RESYNC_ASK ||
    UNANSWERED_SOCKET_RESYNC ||
    RESYNC_FAULT ||
    DESYNC_GUEST ||
    SYNC_FOLLOW_UP ||
    MALFORMED_PEER ||
    HEAL_BOTH_SIDES ||
    START_SILENT ||
    START_LOST ||
    CATCH_UP_HOLE_MS > 0 ||
    ASK_UNANSWERED_STALL_MS > 0 ||
    ROLLBACK_AT_EDGE ||
    PAST_WINDOW_FORCED ||
    CATCH_UP_MS > 0)
) {
  console.log('C_ROLLBACK_TRAP is mutually exclusive with the other fault knobs');
  process.exit(1);
}
if (
  (START_SILENT || START_LOST) &&
  ((START_SILENT && START_LOST) ||
    FREEZE_MS > 0 ||
    THROTTLE_GUEST ||
    HIDE_GUEST_MS > 0 ||
    CLICK_DURING_BATTLE ||
    DROP_SIGNALING_MS > 0 ||
    DROP_PEER_MS > 0 ||
    DELAY_SYNC_ANSWER_MS > 0 ||
    LINK_KBPS > 0 ||
    LOSE_INPUTS_BEFORE_FALLBACK ||
    DOUBLE_RESYNC_ASK ||
    UNANSWERED_SOCKET_RESYNC ||
    RESYNC_FAULT ||
    DESYNC_GUEST ||
    SYNC_FOLLOW_UP ||
    MALFORMED_PEER ||
    HEAL_BOTH_SIDES ||
    C_ROLLBACK_TRAP ||
    CATCH_UP_HOLE_MS > 0 ||
    ASK_UNANSWERED_STALL_MS > 0 ||
    ROLLBACK_AT_EDGE ||
    PAST_WINDOW_FORCED ||
    CATCH_UP_MS > 0)
) {
  console.log('START_SILENT and START_LOST are mutually exclusive with each other and the other fault knobs');
  process.exit(1);
}
// The held answer, then its catch-up.
const CATCH_UP_RECOVER_MS = 20000;
// The request's deadline, the ask again and its answer.
const DOUBLE_RESYNC_ASK_RECOVER_MS = 30000;
// LINK_KBPS without DELAY_SYNC_ANSWER_MS: one plain resync a third of the way in.
const LINK_RESYNC = LINK_KBPS > 0 && !(DELAY_SYNC_ANSWER_MS > 0);
const LINK_RESYNC_RECOVER_MS = 30000;
// Both start a third of the way in; what follows must fit in the remaining two thirds.
const DROP_PEER_RECOVER_MS = 30000;
// A block longer than the initiating machine's deadline must exercise a retry.
const RECONNECT_ATTEMPT_TIMEOUT_MS = PEER_TIMING.attemptAfterMs;
const DELAY_SYNC_ANSWER_RECOVER_MS = 20000;
const faultNeedsSeconds = Math.ceil(
  (((DROP_PEER_MS > 0 ? DROP_PEER_MS + DROP_PEER_RECOVER_MS : 0) +
    // At boot the held answer is over long before the battle.
    (DELAY_SYNC_ANSWER_MS > 0 && DELAY_SYNC_ANSWER_AT === 'battle'
      ? DELAY_SYNC_ANSWER_MS + DELAY_SYNC_ANSWER_RECOVER_MS
      : 0) +
    (LINK_RESYNC ? LINK_RESYNC_RECOVER_MS : 0) +
    (DOUBLE_RESYNC_ASK ? DOUBLE_RESYNC_ASK_RECOVER_MS : 0) +
    (UNANSWERED_SOCKET_RESYNC ? UNANSWERED_SOCKET_RESYNC_RECOVER_MS : 0) +
    (RESYNC_FAULT ? RESYNC_ONE_BACK_RECOVER_MS : 0) +
    (SYNC_FOLLOW_UP ? SYNC_FOLLOW_UP_FREEZE_MS + SYNC_FOLLOW_UP_RECOVER_MS : 0) +
    (HEAL_BOTH_SIDES ? HEAL_RECOVER_MS + HEAL_SECOND_STATE_MS : 0) +
    (CATCH_UP_MS > 0 ? CATCH_UP_MS + CATCH_UP_RECOVER_MS : 0)) *
    1.5) /
    1000,
);
if (
  (DROP_PEER_MS > 0 ||
    DELAY_SYNC_ANSWER_MS > 0 ||
    LINK_RESYNC ||
    DOUBLE_RESYNC_ASK ||
    UNANSWERED_SOCKET_RESYNC ||
    RESYNC_FAULT ||
    SYNC_FOLLOW_UP ||
    HEAL_BOTH_SIDES ||
    CATCH_UP_MS > 0) &&
  !(BATTLE_SECONDS >= faultNeedsSeconds)
) {
  console.log(`this fault needs BATTLE_SECONDS >= ${faultNeedsSeconds}`);
  process.exit(1);
}
// The outage starts a third of the way in, so it and the reconnect that
// follows must fit in the remaining two thirds.
const DROP_SIGNALING_RECONNECT_MS = 20000;
const DROP_SIGNALING_RECONNECT_WAIT_MS = 60000;
if (!(Number.isFinite(DROP_SIGNALING_GUEST_LATE_MS) && DROP_SIGNALING_GUEST_LATE_MS >= 0)) {
  console.log(`DROP_SIGNALING_GUEST_LATE_MS=${process.env.DROP_SIGNALING_GUEST_LATE_MS} invalid — must be >= 0`);
  process.exit(1);
}
if (DROP_SIGNALING_GUEST_LATE_MS > 0 && !(DROP_SIGNALING_MS > 0)) {
  console.log('DROP_SIGNALING_GUEST_LATE_MS only applies with DROP_SIGNALING_MS');
  process.exit(1);
}
if (
  MALFORMED_PEER &&
  (FREEZE_MS > 0 ||
    CLICK_DURING_BATTLE ||
    HIDE_GUEST_MS > 0 ||
    DESYNC_GUEST ||
    DROP_PEER_MS > 0 ||
    DELAY_SYNC_ANSWER_MS > 0 ||
    SYNC_FOLLOW_UP ||
    CATCH_UP_MS > 0 ||
    RESYNC_FAULT ||
    UNANSWERED_SOCKET_RESYNC ||
    DOUBLE_RESYNC_ASK ||
    LINK_KBPS > 0 ||
    LOSE_INPUTS_BEFORE_FALLBACK ||
    DROP_SIGNALING_MS > 0)
) {
  console.log('MALFORMED_PEER is mutually exclusive with the knobs that act during the battle');
  process.exit(1);
}
// MALFORMED_PEER needs ten seconds of battle after its strings, sent a third of the way in.
if (MALFORMED_PEER && !(BATTLE_SECONDS >= 15)) {
  console.log('MALFORMED_PEER needs BATTLE_SECONDS >= 15');
  process.exit(1);
}
const dropSignalingNeedsSeconds = Math.ceil(
  ((DROP_SIGNALING_MS + DROP_SIGNALING_GUEST_LATE_MS + DROP_SIGNALING_RECONNECT_MS) * 3) / 2 / 1000,
);
if (DROP_SIGNALING_MS > 0 && !(BATTLE_SECONDS >= dropSignalingNeedsSeconds)) {
  console.log(`this signaling outage needs BATTLE_SECONDS >= ${dropSignalingNeedsSeconds}`);
  process.exit(1);
}
if (HIDE_GUEST_MS > 0 && (FREEZE_MS > 0 || THROTTLE_GUEST)) {
  console.log('HIDE_GUEST_MS is mutually exclusive with FREEZE_HOST_MS/FREEZE_GUEST_MS and THROTTLE_GUEST');
  process.exit(1);
}
if (CLICK_DURING_BATTLE && !(BATTLE_SECONDS > 15)) {
  console.log(
    `CLICK_DURING_BATTLE=1 needs BATTLE_SECONDS > 15 (round 2 at 2/3 plus host click ~0.8s + 2s gap + guest click ~0.8s must finish before collect()) — got ${BATTLE_SECONDS}`,
  );
  process.exit(1);
}

// The play page's TypeScript must be this tree's, built and served (bundle-check.mjs).
await requireCurrentBundle(fileURLToPath(new globalThis.URL('..', import.meta.url)), URL);

fs.mkdirSync(OUT, { recursive: true });
const room = 'TP' + Math.random().toString(36).slice(2, 8).toUpperCase();

const HEADLESS = process.env.HEADED !== '1';
// Chromium is forced onto swiftshader software GL (see the
// HOST_BROWSER/GUEST_BROWSER doc above). Both launchers are lazy and
// memoized to at most one instance each, so the default (both sides
// unset) shares a single Chromium instance and a WebKit/WebKit run never
// launches an unused Chromium.
let _chromiumBrowser = null;
const chromiumBrowser = async () =>
  (_chromiumBrowser ??= await chromium.launch({
    headless: HEADLESS,
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  }));
let _webkitBrowser = null;
const webkitBrowser = async () => (_webkitBrowser ??= await webkit.launch({ headless: HEADLESS }));
const hostBrowser = HOST_BROWSER === 'webkit' ? await webkitBrowser() : await chromiumBrowser();
const guestBrowser = GUEST_BROWSER === 'webkit' ? await webkitBrowser() : await chromiumBrowser();

// Caps setInterval-driven callbacks to an average of `hz` calls/sec, once
// `window.__knThrottle` is flipped true. Before the flag flips every call
// passes through unchanged — this never speeds anything up.
//
// Fixed schedule, not a since-last-call gate: the engine's tick pump fires
// on a 6ms grid, so a since-last-call gate rounds gaps up to the next
// step — a 33ms gate delivers ~25Hz, not 30. Advancing a fixed `next` by
// `period` keeps the average exact regardless of which 6ms tick a call
// lands on, resetting after a long pause instead of bursting through it.
const throttleInitScript = (hz) => {
  window.__knThrottle = false;
  const period = 1000 / hz;
  const orig = window.setInterval;
  window.setInterval = function (fn, delay, ...args) {
    let next = 0;
    const wrapped = (...a) => {
      if (window.__knThrottle) {
        const now = performance.now();
        if (now < next) return;
        next = next + period > now ? next + period : now + period;
      }
      fn(...a);
    };
    return orig.call(window, wrapped, delay, ...args);
  };
};

// Models Safari leaving the core's own OpenAL AudioContext not running and
// refusing a resume without a gesture (see SUSPEND_GUEST_AUDIO in the
// header). Two independent pieces:
//   1. resume() on any AudioContext rejects unless called within 1000ms of
//      a trusted gesture. This alone doesn't reproduce #63: the page's own
//      pre-boot gesture-unlocked context (_ejsCtx in netplay-rollback.js's
//      showGesturePrompt) calls resume() inside the trusted click, which
//      un-suspends it before the core ever gets it.
//   2. So separately, poll for the core's own OpenAL context(s)
//      (EJS_emulator.gameManager.Module.AL.contexts) and suspend each one
//      — via the real, unpatched suspend() — the first time it appears.
//      That's the context that actually goes quiet in prod.
const suspendAudioInitScript = () => {
  let lastGestureAt = -Infinity;
  for (const type of ['pointerdown', 'mousedown', 'click', 'touchend']) {
    window.addEventListener(
      type,
      (e) => {
        if (e.isTrusted) lastGestureAt = performance.now();
      },
      { capture: true },
    );
  }

  // Gesture-gated resume(), patched on both AudioContext and
  // webkitAudioContext (skipping a re-patch if they're the same function).
  const patchResume = (name) => {
    const Real = window[name];
    if (!Real || Real.prototype.__knResumePatched) return;
    const realResume = Real.prototype.resume;
    Real.prototype.resume = function (...args) {
      if (performance.now() - lastGestureAt <= 1000) return realResume.apply(this, args);
      return Promise.reject(new DOMException('Permission was denied', 'NotAllowedError'));
    };
    Real.prototype.__knResumePatched = true;
  };
  patchResume('AudioContext');
  if (window.webkitAudioContext) patchResume('webkitAudioContext');

  // Real suspend(), saved before any patching touches it (only resume() is
  // patched above, but grab this early regardless for clarity/safety).
  const AC = window.AudioContext || window.webkitAudioContext;
  const realSuspend = AC?.prototype?.suspend;
  const suspended = new WeakSet();
  const poll = setInterval(() => {
    const contexts = window.EJS_emulator?.gameManager?.Module?.AL?.contexts;
    if (!contexts) return;
    let foundAny = false;
    for (const ctx of Object.values(contexts)) {
      const audioCtx = ctx?.audioCtx;
      if (!audioCtx || suspended.has(audioCtx)) continue;
      suspended.add(audioCtx);
      realSuspend?.call(audioCtx);
      foundAny = true;
    }
    if (foundAny) clearInterval(poll);
  }, 50);
};

// Overrides document.hidden/visibilityState to read from a page-global flag
// instead of the real (unbackgroundable, in a headless multi-context run)
// tab state. `_visChangeHandler` in netplay-rollback.js only consults these
// getters and listens for the `visibilitychange` event — both driven here —
// so this reproduces a real backgrounded tab from its point of view.
const hiddenInitScript = () => {
  window.__knHidden = false;
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => window.__knHidden });
  Object.defineProperty(Document.prototype, 'visibilityState', {
    configurable: true,
    get: () => (window.__knHidden ? 'hidden' : 'visible'),
  });
};

// DROP_SIGNALING_MS: keep every client event the page reports (type and meta),
// so the run can assert on reconnects and on the lifecycle machine's reports.
const recordEventsInitScript = () => {
  window.__knEvents = [];
  let real;
  Object.defineProperty(window, 'KNEvent', {
    configurable: true,
    set: (fn) => {
      real = fn;
    },
    get: () =>
      real &&
      ((type, msg, meta) => {
        window.__knEvents.push({ type, meta: meta ?? {} });
        return real(type, msg, meta);
      }),
  });
};

// Every run, both pages: what a resync leaves out of kn_sync_read. Each
// kn_sync_read records the page's hidden state as it is read (the 18 packed
// words, kn_get_hidden_state_fingerprint, and a hash of the RSP HLE state),
// by the core's frame; each kn_set_frame that follows a kn_sync_write (the
// end of a resync's apply step, applySyncState) records the same, by the
// frame set, before any frame runs. The run compares the guest's with the
// host's read for that frame (resyncExtras in summary.json).
const resyncExtrasProbeInitScript = () => {
  const P = { reads: [], applies: [], wrapped: false, modules: 0 };
  const seen = new WeakSet();
  window.__knResyncExtras = P;
  const hiddenOf = (m) => {
    const out = { fp: m._kn_get_hidden_state_fingerprint?.() ?? null, words: null, hle: null, hleBytes: 0 };
    if (m._kn_pack_hidden_state_impl) {
      const ptr = m._malloc(18 * 4);
      m._kn_pack_hidden_state_impl(ptr);
      out.words = Array.from(new Uint32Array(m.HEAPU32.buffer, ptr, 18));
      m._free(ptr);
    }
    const size = m._kn_hle_state_size?.() ?? 0;
    if (size > 0 && m._kn_hle_save_to) {
      const ptr = m._malloc(size);
      m._kn_hle_save_to(ptr);
      const bytes = new Uint8Array(m.HEAPU8.buffer, ptr, size);
      let h = 2166136261;
      for (let i = 0; i < size; i++) h = Math.imul(h ^ bytes[i], 16777619) >>> 0;
      m._free(ptr);
      out.hle = h.toString(16);
      out.hleBytes = size;
    }
    if (window.__knReadFight) out.fight = window.__knReadFight();
    return out;
  };
  const wrap = () => {
    const m = window.EJS_emulator?.gameManager?.Module;
    if (!m?._kn_sync_read || !m._kn_sync_write || !m._kn_set_frame || !m._kn_get_frame || seen.has(m)) return;
    seen.add(m);
    P.modules++;
    // Emscripten's export on Module is a stub that, on its first call, puts
    // the export it stands for in its own place, over any wrapper around it.
    // A change made during the inner call is that: the wrapper calls the new
    // export from then on and puts back what was there before the call (this
    // wrapper, or one another script put over it).
    const around = (name, body) => {
      let inner = m[name];
      const self = Object.assign(
        function (...args) {
          const before = m[name];
          const result = body((...a) => inner.apply(this, a), args);
          if (m[name] !== before) {
            inner = m[name];
            m[name] = before;
          }
          return result;
        },
        { knResyncProbe: true },
      );
      m[name] = self;
    };
    around('_kn_sync_read', (call, args) => {
      const n = call(...args);
      if (n > 0) {
        const read = { frame: m._kn_get_frame(), ...hiddenOf(m) };
        P.reads.push(read);
        if (read.fight) window.__knSavedFight?.(read.frame, read.fight);
      }
      return n;
    });
    let wrote = false;
    around('_kn_sync_write', (call, args) => {
      const r = call(...args);
      wrote = r === 0;
      return r;
    });
    around('_kn_set_frame', (call, args) => {
      if (wrote) P.applies.push({ frame: args[0], ...hiddenOf(m) });
      wrote = false;
      return call(...args);
    });
    P.wrapped = true;
  };
  // Again for each new Module the page makes (a core restarted mid-match).
  setInterval(wrap, 50);
  // At the end: is the page's Module still the one wrapped last?
  P.stillWrapped = () => !!window.EJS_emulator?.gameManager?.Module?._kn_sync_read?.knResyncProbe;
};

// RESYNC_ONE_BACK / RESYNC_SAME_FRAME (guest page only): lands the resync
// answer one frame behind the guest's counter, or on the frame it is on after
// kn_pre_tick saved it. Inert until the run calls start(). Each pause has a
// deadline; a miss is recorded, not retried, and fails the run.
const resyncOneBackInitScript = () => {
  const OB = {
    armed: false,
    target: null, // the answer's frame, from its sync-start: header
    lastR: null, // the frame the guest runs next (its last forward post-tick)
    held: null, // delivers the held worker reply
    released: false,
    loaded: false, // the released state went into the core (kn_sync_write)
    missed: null,
    flips: 0,
    holds: 0, // ticks told 3 while the state was on its way
    headerAt: null,
    replyAt: null,
    releasedAt: null,
    timer: null,
    sameFrame: false,
    savedNotRunAt: null, // RESYNC_SAME_FRAME: the frame kn_pre_tick saved and that did not run
  };
  window.__knResyncOneBack = OB;
  const engine = () => window.NetplayRollback;
  const mod = () => window.EJS_emulator.gameManager.Module;
  const giveUp = (why) => {
    OB.missed = OB.missed || why;
    if (OB.held) release();
  };
  const deadline = (ms, why) => {
    clearTimeout(OB.timer);
    OB.timer = setTimeout(() => {
      engine().resumeTick();
      giveUp(why);
    }, ms);
  };
  // P1's stock count made wrong in the live state (as DESYNC_GUEST does).
  const writeWrong = () => {
    const m = mod();
    const stocksBase = m._kn_field_map_value?.(0) ?? 0xa4d33;
    const at = m._kn_get_rdram_ptr() + (stocksBase ^ 3);
    if (OB.wrong === undefined) OB.wrong = m.HEAPU8[at] ^ 1;
    m.HEAPU8[at] = OB.wrong;
    OB.flips++;
  };
  const release = () => {
    const deliver = OB.held;
    OB.held = null;
    OB.released = true;
    OB.releasedAt = OB.lastR;
    deliver?.();
  };
  // The frame the state is to land on, once the guest has reached it: T + 1
  // for one frame back, T for the same frame once kn_pre_tick has saved it.
  const landingFrame = () => (OB.sameFrame ? OB.savedNotRunAt : OB.target + 1);
  // kn_pre_tick, wrapped. At the landing frame it is not run and the page is
  // told 3, the engine's pacing hold, until the state is loaded: a pump that
  // runs two ticks at once (its catch-up) cannot go past the frame before the
  // state, released between them, reaches the page. For the same frame, the
  // real kn_pre_tick runs once at T (it saves T) and T is held from there.
  const wrapCore = () => {
    const m = mod();
    const preTick = m._kn_pre_tick;
    m._kn_pre_tick = function (...args) {
      const holding = OB.target !== null && !OB.loaded && !OB.missed;
      if (holding && landingFrame() !== null && m._kn_get_frame() === landingFrame()) {
        OB.holds++;
        return 3;
      }
      const result = preTick.apply(this, args);
      if (holding && OB.sameFrame && OB.savedNotRunAt === null && result === 0 && m._kn_get_frame() === OB.target) {
        OB.savedNotRunAt = OB.target;
        if (OB.held) queueMicrotask(release);
        return 3;
      }
      return result;
    };
    const syncWrite = m._kn_sync_write;
    m._kn_sync_write = function (...args) {
      const result = syncWrite.apply(this, args);
      if (OB.released && !OB.loaded) {
        OB.loaded = true;
        clearTimeout(OB.timer);
      }
      return result;
    };
  };
  OB.start = (sameFrame) => {
    OB.armed = true;
    OB.sameFrame = sameFrame;
    wrapCore();
    engine().pauseTick();
    deadline(15000, 'no answer header within 15 s');
  };
  OB.ask = () => window.dispatchEvent(new Event('online'));
  OB.onHeader = (frame) => {
    if (!OB.armed || OB.target !== null) return;
    OB.target = frame;
    OB.headerAt = OB.lastR;
    if (OB.lastR > frame) OB.missed = `the answer is for frame ${frame}, the guest is at ${OB.lastR}`;
    else if (OB.lastR === frame) writeWrong();
    engine().resumeTick();
    deadline(15000, 'the state was not loaded within 15 s of the header');
  };
  // A reply from the sync worker: true when it is held (or already delivered).
  OB.onWorkerReply = (type, deliver) => {
    if (!OB.armed || OB.target === null || OB.released || OB.missed || OB.held) return false;
    if (type !== 'decompress' && type !== 'decode-and-decompress') return false;
    OB.replyAt = OB.lastR;
    OB.held = deliver;
    const at = landingFrame();
    if (at === null) {
      // Same frame, before kn_pre_tick has saved T.
      if (OB.lastR > OB.target) giveUp(`the state arrived at ${OB.lastR}, past ${OB.target}`);
      return true;
    }
    if (OB.lastR > at) giveUp(`the state arrived at ${OB.lastR}, past ${at}`);
    else if (OB.lastR === at) release();
    return true;
  };
  // Called after each kn_post_tick with the frame the guest runs next.
  OB.afterTick = (r, idle) => {
    if (idle) OB.lastR = r;
    if (!OB.armed || OB.target === null || OB.released || OB.missed) return;
    // Before the tick for T (a replay through T included), so its saved copy carries it.
    if (r === OB.target) writeWrong();
    if (!idle) return;
    if (OB.sameFrame) {
      if (r > OB.target) giveUp(`frame ${OB.target} ran before it was held`);
      return;
    }
    // The tick for T has run: the state applies at T + 1, one frame back.
    if (r === OB.target + 1 && OB.held) queueMicrotask(release);
    else if (r > OB.target + 1) giveUp(`frame ${OB.target + 1} ran before the state`);
  };
  // The answer's header on the sync-state channel.
  const onmessage = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'onmessage');
  Object.defineProperty(RTCDataChannel.prototype, 'onmessage', {
    configurable: true,
    get() {
      return onmessage.get.call(this);
    },
    set(fn) {
      if (this.label !== 'sync-state' || typeof fn !== 'function') {
        onmessage.set.call(this, fn);
        return;
      }
      onmessage.set.call(this, function (e) {
        if (typeof e.data === 'string' && e.data.startsWith('sync-start:'))
          OB.onHeader(parseInt(e.data.split(':')[1], 10));
        return fn.call(this, e);
      });
    },
  });
  // The engine's sync worker (made from a blob: URL): its replies by request type.
  const RealWorker = window.Worker;
  window.Worker = new Proxy(RealWorker, {
    construct(target, args, newTarget) {
      const worker = Reflect.construct(target, args, newTarget);
      if (!String(args[0]).startsWith('blob:')) return worker;
      const types = new Map();
      const post = worker.postMessage;
      worker.postMessage = function (msg, ...rest) {
        if (msg && typeof msg === 'object' && 'id' in msg) types.set(msg.id, msg.type);
        return post.call(this, msg, ...rest);
      };
      let proto = Object.getPrototypeOf(worker);
      while (proto && !Object.getOwnPropertyDescriptor(proto, 'onmessage')) proto = Object.getPrototypeOf(proto);
      const real = Object.getOwnPropertyDescriptor(proto, 'onmessage');
      Object.defineProperty(worker, 'onmessage', {
        configurable: true,
        get: () => real.get.call(worker),
        set: (fn) => {
          const handler =
            typeof fn !== 'function'
              ? fn
              : (e) => {
                  const type = types.get(e.data?.id);
                  types.delete(e.data?.id);
                  if (!OB.onWorkerReply(type, () => fn.call(worker, e))) fn.call(worker, e);
                };
          real.set.call(worker, handler);
        },
      });
      return worker;
    },
  });
};

const mkPage = async (
  browser,
  name,
  { throttleHz = 0, hidden = false, suspendAudio = false, resyncOneBack = false } = {},
) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  await addNetworkInitScript(ctx, { lat: LAT, jitter: JITTER, kbps: LINK_KBPS });
  if (throttleHz) await ctx.addInitScript(throttleInitScript, throttleHz);
  if (hidden) await ctx.addInitScript(hiddenInitScript);
  if (suspendAudio) await ctx.addInitScript(suspendAudioInitScript);
  if (resyncOneBack) await ctx.addInitScript(resyncOneBackInitScript);
  // Every run: the observers' client events are counted from these.
  await ctx.addInitScript(recordEventsInitScript);
  if (process.env.FIGHT_RETURN_CHECK === '1') await ctx.addInitScript(installFightProbe);
  await ctx.addInitScript(resyncExtrasProbeInitScript);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`[${name}] pageerror ${e.message}`));
  if (DROP_PEER_MS && name === 'guest') {
    // Proxy the guest's signaling so the WebRTC signaling between it and the
    // host can be dropped, both ways, while its connection is down.
    await page.routeWebSocket(/socket\.io/, (ws) => {
      const server = ws.connectToServer();
      const blocked = (message) =>
        Date.now() < peerSignalBlock.until && String(message).includes('"webrtc-signal"') && ++peerSignalBlock.dropped;
      ws.onMessage((message) => blocked(message) || server.send(message));
      server.onMessage((message) => blocked(message) || ws.send(message));
    });
  }
  if (HEAL_BOTH_SIDES && name === 'guest') {
    // Hold the WebRTC signaling coming to the guest while healSignalHold is
    // on, then deliver it in order: the host's reconnect offer reaches the
    // guest only after the guest's own health check has decided, so that
    // decision (wait, not offer) is always exercised.
    await page.routeWebSocket(/socket\.io/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => server.send(message));
      server.onMessage((message) => {
        if (healSignalHold.on && String(message).includes('"webrtc-signal"')) {
          healSignalHold.held.push(message);
          return;
        }
        ws.send(message);
      });
      healSignalHold.release = () => {
        healSignalHold.on = false;
        for (const message of healSignalHold.held.splice(0)) ws.send(message);
      };
    });
  }
  if (DROP_SIGNALING_MS) {
    // Proxy the signaling WebSocket so it can be cut, and kept down, on demand.
    signaling.set(page, { down: false, sockets: [] });
    await page.routeWebSocket(/socket\.io/, (ws) => {
      const state = signaling.get(page);
      if (state.down) {
        ws.close({ code: 4000, reason: 'signaling down (test)' });
        return;
      }
      const server = ws.connectToServer();
      state.sockets.push({ page: ws, server });
      ws.onMessage((message) => server.send(message));
    });
  }
  return page;
};

// DROP_SIGNALING_GUEST_LATE_MS: did the host rejoin and see a room without the guest first?
let hostSawRoomWithoutGuest = false;
let hostSawGuestReturn = false;
// Per-page signaling proxy state for DROP_SIGNALING_MS.
const signaling = new Map();
// DROP_PEER_MS: the guest's WebRTC signaling is dropped until `until`.
const peerSignalBlock = { until: 0, dropped: 0 };
// HEAL_BOTH_SIDES: signaling to the guest held until its health check has run.
const healSignalHold = { on: false, held: [], release: () => {}, heldCount: 0 };
const setSignalingDown = async (page, down) => {
  const state = signaling.get(page);
  state.down = down;
  if (!down) return;
  // Close both ends: the page must see the drop, and the server must see the
  // client go rather than keep the old session until its heartbeat times out.
  // 4000 is an application close code; 1006 is reserved and cannot be sent.
  for (const { page: pageSide, server } of state.sockets.splice(0)) {
    await server.close({ code: 4000, reason: 'signaling down (test)' });
    await pageSide.close({ code: 4000, reason: 'signaling down (test)' });
  }
};

const host = await mkPage(hostBrowser, 'host');
const guest = await mkPage(guestBrowser, 'guest', {
  throttleHz: THROTTLE_GUEST ? THROTTLE_GUEST_HZ : HIDE_GUEST_MS && !HIDE_GUEST_FROZEN ? 1 : 0,
  hidden: HIDE_GUEST_MS > 0 || START_HIDDEN,
  suspendAudio: SUSPEND_GUEST_AUDIO,
  resyncOneBack: RESYNC_FAULT !== null,
});
// LOSE_INPUTS_BEFORE_FALLBACK re-arms the host's transport through knDiag,
// which exists only with ?knDiag (it turns on nothing else).
const HOST_QUERY = QUERY + (LOSE_INPUTS_BEFORE_FALLBACK ? '&knDiag' : '');
await host.goto(`${URL}/play.html?room=${room}&host=1&name=Host&mode=rollback${HOST_QUERY}`);
await host.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
await guest.goto(`${URL}/play.html?room=${room}&name=Guest${QUERY}`);
await guest.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
for (const p of [host, guest]) await p.locator("#rom-drop input[type='file']").setInputFiles(ROM);
await host.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
// The host picks the mode in the lobby, as a player would. The URL's `mode`
// only fills the picker until the room's first update, which carries the
// room's own mode (rollback for a new room).
await host.selectOption('#mode-select', MODE);
await host.waitForSelector('#start-btn:not([disabled])', { timeout: 20000 });
ROM_HASH = (await host.evaluate(() => window.KNState?.romHash)) || '';
if (!MENU_AUTOPILOT) {
  MENU_AUTOPILOT = ROM_HASH && ROM_HASH !== SSB64_US_HASH ? 'any-fighter' : 'ssb64';
  if (MENU_AUTOPILOT === 'any-fighter') console.log('ROM is not SSB64 US: MENU_AUTOPILOT=any-fighter');
}
console.log('room', room, 'both ROM-ready; starting');
// DELAY_SYNC_ANSWER_AT=boot: the first numbered answer the host sends, the
// boot sync's, is held. Both logs are read from the match's first line.
const delayBootSyncAnswer = DELAY_SYNC_ANSWER_MS > 0 && DELAY_SYNC_ANSWER_AT === 'boot';
if (delayBootSyncAnswer) {
  await host.evaluate((ms) => {
    window.__knHoldSyncAnswerMs = ms;
  }, DELAY_SYNC_ANSWER_MS);
  console.log(`DELAY_SYNC_ANSWER_MS: the host's answer to the boot sync will be held ${DELAY_SYNC_ANSWER_MS} ms`);
}
// LOSE_INPUTS_BEFORE_FALLBACK: the host broadcasts the transport when the game starts.
if (LOSE_INPUTS_BEFORE_FALLBACK) await host.evaluate(() => (window._knTransportOverride = 'unreliable'));
// This scenario orders a control request behind the held inputs on the same stream.
if (SYNC_FOLLOW_UP === 'direct') await host.evaluate(() => (window._knTransportOverride = 'reliable'));
if (FORCE_DELAY !== null) {
  for (const p of [host, guest]) {
    await p.evaluate((n) => {
      const auto = document.getElementById('delay-auto');
      if (auto?.checked) auto.click();
      const select = document.getElementById('delay-select');
      if (select) {
        select.value = String(n);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, FORCE_DELAY);
  }
  console.log(`FORCE_DELAY: both pages pick ${FORCE_DELAY}`);
}
// START_SILENT / START_LOST: the host's page drops its delay and start
// frame as it sends them, for good or until the guest's channel is closed.
if (START_SILENT || START_LOST) {
  await host.evaluate(() => {
    const send = RTCDataChannel.prototype.send;
    window.__knDropStart = true;
    window.__knDroppedStart = 0;
    RTCDataChannel.prototype.send = function (data) {
      if (
        window.__knDropStart &&
        typeof data === 'string' &&
        (data.startsWith('rb-delay:') || data.startsWith('rb-init-frame:'))
      ) {
        window.__knDroppedStart++;
        return;
      }
      return send.call(this, data);
    };
  });
}
if (RESYNC_OFF) {
  await host.evaluate(() => {
    const box = document.getElementById('opt-resync');
    if (!box) throw new Error('Missing resync toggle');
    box.checked = false;
  });
  console.log('RESYNC_OFF: the host starts with resync off');
}
await host.click('#start-btn');
const guestLog = () => guest.evaluate(() => window.NetplayRollback?.exportSyncLog?.() || '');
const hostLog = () => host.evaluate(() => window.NetplayRollback?.exportSyncLog?.() || '');
const tapGesturePrompts = async () => {
  for (const p of [host, guest]) {
    if (await p.locator('#gesture-prompt:not(.hidden)').count()) {
      await p
        .locator('#gesture-prompt')
        .click({ force: true })
        .catch(() => {});
    }
  }
};
const startFrameOf = (p) => p.evaluate(() => window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? 0);
if (START_SILENT) {
  const report = { failLine: null };
  const t = Date.now();
  while (Date.now() - t < 45000 && !report.failLine) {
    await tapGesturePrompts();
    report.failLine = (await guestLog()).split('\n').find((l) => /START-FAIL reason=no-host/.test(l)) || null;
    if (!report.failLine) await host.waitForTimeout(500);
  }
  report.dropped = await host.evaluate(() => window.__knDroppedStart);
  report.error = await guest.evaluate(() => {
    const el = document.getElementById('error-msg');
    return el && !el.classList.contains('hidden') ? el.textContent.trim() : null;
  });
  // The host drops the stopped guest at the input deadline and plays on.
  const tHost = Date.now();
  while (Date.now() - tHost < 30000 && !/PEER-PHANTOM slot=1/.test(await hostLog())) await host.waitForTimeout(500);
  const [g0, h0] = await Promise.all([startFrameOf(guest), startFrameOf(host)]);
  await host.waitForTimeout(5000);
  const [g1, h1] = await Promise.all([startFrameOf(guest), startFrameOf(host)]);
  const [hostSync, guestSync] = await Promise.all([hostLog(), guestLog()]);
  fs.writeFileSync(`${OUT}/host-sync.txt`, hostSync);
  fs.writeFileSync(`${OUT}/guest-sync.txt`, guestSync);
  Object.assign(report, {
    hostDropped: /PEER-PHANTOM slot=1/.test(hostSync),
    guestArmed: /C-ROLLBACK init: max=/.test(guestSync),
    guestFrame: g1,
    guestFramesAfter: g1 - g0,
    hostFramesAfter: h1 - h0,
  });
  const startSilentFailed = !(
    report.failLine &&
    report.dropped >= 2 &&
    /no word from the host/i.test(report.error || '') &&
    !report.guestArmed &&
    report.guestFrame === 0 &&
    report.guestFramesAfter === 0 &&
    report.hostDropped &&
    report.hostFramesAfter > 0
  );
  fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify({ mode: MODE, startSilent: report }, null, 1));
  console.log(
    startSilentFailed
      ? 'START_SILENT: the guest did not stop and say so, or the host did not play on:'
      : 'START_SILENT: the guest stopped and said so; the host dropped it and played on:',
    JSON.stringify(report),
  );
  for (const b of new Set([hostBrowser, guestBrowser])) await b.close();
  process.exit(startSilentFailed ? 1 : 0);
}
// START_LOST: once the guest waits, close its channel to the host and let the
// host's sends through; the host sends both again when the channel opens.
const startLostReport = START_LOST ? { waited: false, closed: false } : null;
if (START_LOST) {
  const t = Date.now();
  while (Date.now() - t < 45000 && !startLostReport.waited) {
    await tapGesturePrompts();
    startLostReport.waited = /C-ROLLBACK deferred: waiting for host/.test(await guestLog());
    if (!startLostReport.waited) await host.waitForTimeout(500);
  }
  await host.waitForTimeout(1500);
  startLostReport.dropped = await host.evaluate(() => {
    window.__knDropStart = false;
    return window.__knDroppedStart;
  });
  if (START_HIDDEN) {
    // The host has run and its inputs have reached the guest; then the
    // guest's tab is hidden and shown again while it still waits. Kept short:
    // the host drops a guest whose inputs stay away 5 s, and the guest arms
    // only once its channel is back. The page acts on a return after 500 ms
    // or more in the background.
    await host.waitForTimeout(500);
    await guest.evaluate(() => {
      window.__knHidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await host.waitForTimeout(700);
    await guest.evaluate(() => {
      window.__knHidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    startLostReport.hiddenAndShown = true;
    console.log("START_HIDDEN: the waiting guest's tab was hidden and shown again");
  }
  startLostReport.closed = await guest.evaluate(() => {
    const hostPeer = Object.values(window.KNState.peers).find((q) => q?.slot === 0);
    if (!hostPeer?.dc || hostPeer.dc.readyState !== 'open') return false;
    hostPeer.dc.close();
    return true;
  });
  startLostReport.closedAt = Date.now();
  console.log(
    `START_LOST: the host's start messages were dropped (${startLostReport.dropped}); guest channel closed: ${startLostReport.closed}`,
  );
}

// Dismiss the tap-to-start prompt on whichever page shows it. Tracks how
// many times the guest's prompt was found visible and clicked — with
// SUSPEND_GUEST_AUDIO, a second tap here means the boot-audio-stall fix
// (stand-in clock) didn't recover boot on its own.
const t0 = Date.now();
let guestBootTaps = 0;
while (Date.now() - t0 < 60000) {
  for (const p of [host, guest]) {
    const v = await p.locator('#gesture-prompt:not(.hidden)').count();
    if (v) {
      if (p === guest) guestBootTaps++;
      await p
        .locator('#gesture-prompt')
        .click({ force: true })
        .catch(() => {});
    }
  }
  // Also require EJS_emulator.gameManager.Module: on WebKit, currentFrame can
  // go truthy a tick before gameManager is attached (seen with
  // GUEST_BROWSER=webkit — install() below reads gameManager.Module and
  // threw `undefined is not an object`). Harmless extra check on Chromium.
  const ready = await Promise.all(
    [host, guest].map((p) =>
      p.evaluate(
        () => !!window.NetplayRollback?.getHudCounters?.()?.currentFrame && !!window.EJS_emulator?.gameManager?.Module,
      ),
    ),
  );
  if (ready[0] && ready[1]) break;
  await host.waitForTimeout(500);
}

// Autopilot + input hook + hash recorder, per page.
const install = async (p, role) => {
  await p.addScriptTag({ url: `${URL}/static/ssb64-menu-autopilot.js` });
  await p.evaluate(trackHashLag);
  await p.evaluate(
    (args) => {
      const { role, VISUAL_CHECK, ADDRESS_MAP_CHECK, ADDRESS_MAP_OF, anyFighter, twelveCb, earlyLag } = args;
      const W = (window.__tp = {
        role,
        hashes: {},
        early: {},
        ticksWithoutLag: 0,
        scene: -1,
        inBattleAt: -1,
        pilotFail: null,
        menuInputs: [],
        btnCool: 0,
        btnHeld: 0,
        visualFrames: [],
        fpsWindowStart: null,
      });
      let visCtx = null;
      if (VISUAL_CHECK) {
        const visCanvas = document.createElement('canvas');
        visCanvas.width = 48;
        visCanvas.height = 36;
        visCtx = visCanvas.getContext('2d', { willReadFrequently: true });
      }
      const rb = window.NetplayRollback;
      const frameNow = () => rb.getHudCounters?.()?.currentFrame ?? 0;
      // Marks the start of the game-fps measurement window: the node script
      // calls this either right when the battle begins (no THROTTLE_GUEST —
      // measure the whole battle) or when it flips the guest's setInterval
      // cap (THROTTLE_GUEST — measure only the throttled window). Frame
      // count is the last non-replay _kn_post_tick frame (W.lastR, set
      // below) — getHudCounters().currentFrame is rewound mid-replay.
      window.__tp.markFpsWindowStart = () => {
        W.fpsWindowStart = { f: W.lastR ?? frameNow(), t: performance.now() };
      };
      const pilot = window.KNMenuAutopilot.create({
        read32: (a) => rb.readRdram32(a),
        log: (m) => (W.pilotFail = m),
        anyFighter,
      });
      // ADDRESS_MAP_CHECK: read the map's fields from RAM as the game runs.
      // readRdram32 returns the N64 word; a single byte is picked out of it.
      const rom = ADDRESS_MAP_CHECK ? window.KNCore.addressMapFor(ADDRESS_MAP_OF || window.KNState?.romHash) : null;
      W.mapRom = rom ? rom.name : null;
      W.mapScenes = rom ? rom.scenes : null;
      W.mapOngoing = rom ? rom.battleStatus.ongoing : null;
      // The value the game's battle-state pointer holds when it names the
      // mapped battle state (an N64 address: 0x80000000 | offset).
      W.mapLiveHeaderPointer = rom ? (0x80000000 | rom.values[3]) >>> 0 : null;
      W.mapSamples = [];
      const byteAt = (off) => {
        const word = rb.readRdram32(off & ~3);
        return word === null ? null : (word >>> (8 * (3 - (off & 3)))) & 0xff;
      };
      const sampleMap = (f) => {
        const [stocksBase, playerStride, sceneCurr, vsHeader, vsHeaderSize, rngSeed, cssBase, cssStride, cssCharId] =
          rom.values;
        const ftBufferPtr = rom.values[12];
        const ftBufferSize = rom.values[13];
        let headerNonZero = false;
        for (let off = 0; off < vsHeaderSize; off += 4) if (rb.readRdram32(vsHeader + off)) headerNonZero = true;
        W.mapSamples.push({
          f,
          status: byteAt(vsHeader + rom.battleStatus.offset),
          pointer: rb.readRdram32(rom.battleStatus.pointer),
          scene: byteAt(sceneCurr),
          stocks: [0, 1].map((p) => byteAt(stocksBase + p * playerStride)),
          charIds: [0, 1].map((p) => rb.readRdram32(cssBase + p * cssStride + cssCharId)),
          rng: rb.readRdram32(rngSeed),
          headerNonZero,
          ftPtr: rb.readRdram32(ftBufferPtr),
          ftBufferSize,
        });
      };
      const actor = role === 'host' ? pilot.p1 : pilot.p2;
      let held = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 },
        until = 0;
      const BTN = [0, 1, 6, 7]; // A, B, D-left, D-right (no START)
      const orig = window.KNShared.readLocalInput.bind(window.KNShared);
      window.KNShared.readLocalInput = (slot, keyMap, heldKeys) => {
        const liveInput = orig(slot, keyMap, heldKeys);
        if (window.__knResetLiveInput) {
          const samples = (window.__knResetInputSamples ??= []);
          const last = samples.at(-1);
          const scene = (rb.readRdram32(0x800a4ad0) >>> 24) & 255;
          if (
            !last ||
            last.buttons !== liveInput.buttons ||
            last.scene !== scene ||
            last.held !== window.KNState.resetComboHeld
          ) {
            if (samples.length >= 100) samples.shift();
            samples.push({
              frame: frameNow(),
              scene,
              buttons: liveInput.buttons,
              held: window.KNState.resetComboHeld,
              at: performance.now(),
            });
          }
          return liveInput;
        }
        const f = frameNow();
        const sc = (rb.readRdram32(0x800a4ad0) >>> 24) & 0xff;
        W.scene = sc;
        if (rom && f % 30 === 0 && W.mapSamples.at(-1)?.f !== f) sampleMap(f);
        if (sc !== 22) {
          // Space button presses by the input delay so a press lands (and the
          // closed loop sees it) before the next one; sticks pass through.
          const d = (rb.getHudCounters?.()?.delay ?? 2) + 6;
          let inp;
          if (twelveCb && sc === 9) {
            const hook = rb.readRdram32(0x80133d9c);
            const pc = (0x80000000 | ((hook & 0x03ffffff) << 2)) >>> 0;
            const hi = rb.readRdram32(pc),
              lo = rb.readRdram32(pc + 4);
            if (
              hook >>> 26 !== 3 ||
              hi >>> 16 !== 0x3c0d ||
              lo >>> 16 !== 0x35ad ||
              rb.readRdram32(pc + 8) >>> 0 !== 0x8da80000
            )
              throw new Error('Unknown native Remix page flag instructions');
            const page = rb.readRdram32((((hi & 65535) << 16) | (lo & 65535)) >>> 0);
            const cursor = rb.readRdram32(0x80134948);
            if (![0, 1].includes(page)) throw new Error('Unknown Remix menu page ' + page);
            const wanted = page === 0 ? 4 : 0;
            inp = {
              buttons: role === 'host' && f % 60 < 8 ? (cursor === wanted ? 1 : 16) : 0,
              lx: 0,
              ly: 0,
              cx: 0,
              cy: 0,
            };
          } else if (twelveCb && sc === 16) {
            const slot = role === 'host' ? 0 : 1;
            const base = 0x8013ba88 + slot * 0xbc;
            const selected = rb.readRdram32(base + 0x88) === 1;
            const both = [0, 1].every((i) => rb.readRdram32(0x8013ba88 + i * 0xbc + 0x88) === 1);
            inp = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
            if (both) {
              if (role === 'host' && f % 60 < 8) inp.buttons = 8;
            } else if (!selected) {
              const puck = rb.readRdram32(base + 4),
                obj = rb.readRdram32(puck + 0x74);
              const float = (word) => {
                const a = new DataView(new ArrayBuffer(4));
                a.setUint32(0, word);
                return a.getFloat32(0);
              };
              const x = float(rb.readRdram32(obj + 0x58)),
                y = float(rb.readRdram32(obj + 0x5c));
              if (x > -100 && x < 420 && y > -100 && y < 340) {
                const dx = (slot === 0 ? 70 : 200) - x,
                  dy = 50 - y;
                if (Math.abs(dx) < 9 && Math.abs(dy) < 9) {
                  if (f % 60 < 8) inp.buttons = 1;
                } else if (f % 30 < 6) {
                  inp.lx = Math.abs(dx) > 8 ? Math.sign(dx) * 35 : 0;
                  inp.ly = Math.abs(dy) > 8 ? Math.sign(dy) * 35 : 0;
                }
              }
            }
          } else inp = actor(f);
          if (inp.buttons) {
            if (W.btnCool > f && W.btnHeld !== inp.buttons) inp = { ...inp, buttons: 0 };
            else {
              W.btnHeld = inp.buttons;
              W.btnCool = f + d + 4;
            }
          } else if (W.btnHeld) {
            W.btnHeld = 0;
            W.btnCool = f + d;
          }
          // What was sent, kept as the frames it changed on. A sync that
          // takes the page back replaces the frames from there on.
          while (W.menuInputs.length && W.menuInputs.at(-1).f >= f) W.menuInputs.pop();
          const last = W.menuInputs.at(-1);
          if (!last || last.buttons !== inp.buttons || last.lx !== inp.lx || last.ly !== inp.ly) {
            W.menuInputs.push({ f, scene: sc, buttons: inp.buttons, lx: inp.lx, ly: inp.ly });
          }
          return inp;
        }
        if (W.inBattleAt < 0) W.inBattleAt = f;
        // SYNC_FOLLOW_UP: the test sets this page's input itself for a while.
        if (window.__knInputOverride) return window.__knInputOverride(f);
        if (f >= until) {
          const r = Math.random();
          held = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
          if (r < 0.35) held.lx = Math.random() < 0.5 ? -70 : 70;
          else if (r < 0.55) held.buttons = 1 << BTN[(Math.random() * BTN.length) | 0];
          else if (r < 0.7) {
            held.lx = Math.random() < 0.5 ? -50 : 50;
            held.buttons = 1;
          } else if (r < 0.8) held.ly = -70;
          until = f + 8 + ((Math.random() * 40) | 0);
        }
        return held;
      };
      const m = window.EJS_emulator.gameManager.Module;
      const post = m._kn_post_tick;
      m._kn_post_tick = function (...a) {
        const r = post.apply(this, a);
        const idle = (m._kn_get_replay_depth?.() ?? 0) === 0;
        // The page's own lag, max + 1 of the window its engine was armed
        // with (tests/hash-lag.mjs says why); null until it is armed.
        const lag = window.__knHashLag?.lag ?? null;
        // A sync rewind (frame goes down with no replay running) makes hashes
        // already recorded at or after the new frame stale; re-record them.
        if (idle && W.lastR !== undefined && r < W.lastR) {
          if (lag !== null) for (const k of Object.keys(W.hashes)) if (+k >= r - lag) delete W.hashes[k];
          if (earlyLag) for (const k of Object.keys(W.early)) if (+k >= r - earlyLag) delete W.early[k];
        }
        if (idle) W.lastR = r;
        window.__knResyncOneBack?.afterTick(r, idle);
        if (idle && r > 40 && lag === null) W.ticksWithoutLag++;
        if (idle && r > 40 && lag !== null) {
          const f = r - lag;
          if (!(f in W.hashes))
            W.hashes[f] = [
              m._kn_gameplay_hash(f) >>> 0,
              m._kn_full_state_hash(f) >>> 0,
              (m._kn_game_state_hash?.(f) ?? 0) >>> 0,
            ];
        }
        // COMPARE_HASH_LAG: the same hashes read at that lag too, to show
        // what an earlier read would have compared.
        if (idle && earlyLag && r > 40) {
          const f = r - earlyLag;
          if (!(f in W.early)) W.early[f] = [m._kn_gameplay_hash(f) >>> 0, (m._kn_game_state_hash?.(f) ?? 0) >>> 0];
        }
        if (VISUAL_CHECK && idle && W.inBattleAt >= 0 && r >= W.inBattleAt) {
          try {
            const src = document.querySelector('#game canvas');
            if (src && src.width > 0 && src.height > 0) {
              visCtx.drawImage(src, 0, 0, 48, 36);
              const d = visCtx.getImageData(0, 0, 48, 36).data;
              const rgb = new Uint8Array(48 * 36 * 3);
              for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
                rgb[j] = d[i];
                rgb[j + 1] = d[i + 1];
                rgb[j + 2] = d[i + 2];
              }
              W.visualFrames.push({ f: r, bytes: rgb });
            }
          } catch (_) {}
        }
        return r;
      };
    },
    {
      role,
      VISUAL_CHECK,
      ADDRESS_MAP_CHECK,
      ADDRESS_MAP_OF,
      anyFighter: MENU_AUTOPILOT === 'any-fighter',
      twelveCb: process.env.TWELVE_CB === '1',
      earlyLag: COMPARE_HASH_LAG,
    },
  );
};
await install(host, 'host');
await install(guest, 'guest');

// #62 repro: click through the toolbar "more" menu into the feedback form
// and back out. Fire-and-forget from setTimeout callers below — a click
// round throwing (e.g. a selector not present) is logged, not fatal, so it
// can't hang the battle-length wait.
const clickThroughFeedback = async (page, label) => {
  console.log(`CLICK_DURING_BATTLE: ${label} click round starting`);
  await page.click('#toolbar-more');
  await page.waitForTimeout(300);
  await page.click('.kn-feedback-toolbar-item');
  await page.waitForTimeout(500);
  await page.click('.kn-feedback-cat');
  await page.click('.kn-feedback-close');
  console.log(`CLICK_DURING_BATTLE: ${label} click round done`);
};
const scheduleClickRound = (delayMs, roundLabel) => {
  setTimeout(() => {
    clickThroughFeedback(host, `${roundLabel} host`)
      .catch((e) => console.log(`CLICK_DURING_BATTLE: ${roundLabel} host round failed`, e.message))
      .then(() =>
        new Promise((r) => setTimeout(r, 2000)).then(() =>
          clickThroughFeedback(guest, `${roundLabel} guest`).catch((e) =>
            console.log(`CLICK_DURING_BATTLE: ${roundLabel} guest round failed`, e.message),
          ),
        ),
      );
  }, delayMs);
};

// Wait for the battle, then play.
const tb = Date.now();
const MENU_MS = Number(process.env.MENU_SECONDS || 600) * 1000;
let lastLog = 0;
let inBattle = false;
let desyncGuestStocksBase = -1; // DESYNC_GUEST: the map's address of P1's stock count
let desyncGuestAt = -1; // DESYNC_GUEST: the guest's frame when its stock count was changed
let throttleFlipped = null; // null until the 15s mark; then whether the flip Promise.all resolved or rejected
// DROP_PEER_MS / DELAY_SYNC_ANSWER_MS: where each page's sync log stood when
// the fault began ({seq, frame} of its last line), and what the test saw.
const dropPeer = { hostAt: null, guestAt: null, hostFrame: 0, closed: null, holeDropped: [] };
// HEAL_BOTH_SIDES: where the logs stood, what was silenced, and the frames after.
const healBoth = {
  hostAt: null,
  guestAt: null,
  guestEnd: null,
  silenced: null,
  guestChecked: false,
  recovered: false,
  framesAfter: 0,
};
const delaySyncAnswer = { hostAt: null, guestAt: null, timedOut: false, askedAgainAfterMs: null };
// MALFORMED_PEER: what each page sends the other, all off its schema
// (web/src/peer-protocol.ts). The "zz-" values must never reach a log line.
const MALFORMED_STRINGS = {
  lockstep: [
    'rb-check:zz-frame:1',
    'rb-check:zz-frame:2',
    'rb-delay:zz-delay',
    'roster:zz-frame:0,1',
    'rb-zz-unknown:1',
    JSON.stringify({ type: 'lockstep-ready', delay: 'zz-delay' }),
    '{zz-not json',
  ],
  syncState: ['sync-start:zz-frame:1:1:0'],
  // On its schema, but a state header from a page that is not the host: the
  // guest sends it, and the host must refuse it (`state header refused`).
  guestSyncState: ['sync-start:1:1:1:0'],
};
// What the host refuses: both of the guest's sync-start headers, the
// malformed one included, at the channel gate (not the current host's
// sync-state channel), which runs before the schema.
const MALFORMED_HOST_REFUSED = 2;
const MALFORMED_HOST_REFUSED_BY = 'state header refused: from non-current host channel';
// The `[protocol] dropped <kind>` each receiving page must log, once each, in any order.
const MALFORMED_DROPS = [
  'dc lockstep rb-check',
  'dc lockstep rb-delay',
  'dc lockstep roster',
  'dc lockstep (unknown)',
  'dc lockstep lockstep-ready',
  'dc lockstep (json)',
  'dc sync-state sync-start',
];
// The host never reaches the schema with a sync-state string from its guest
// (MALFORMED_HOST_REFUSED_BY), so it drops all but that one.
const MALFORMED_HOST_DROPS = MALFORMED_DROPS.filter((kind) => kind !== 'dc sync-state sync-start');
const malformedPeer = { hostAt: null, guestAt: null, sent: [false, false], frameLater: [0, 0] };
const MALFORMED_FRAMES_AFTER = 30;
// LOSE_INPUTS_BEFORE_FALLBACK: where each page's sync log stood when the drops began.
const loseBeforeFallback = { hostAt: null, guestAt: null, fellBack: false, rounds: 0 };
// LINK_KBPS on its own: where the logs stood when the guest asked for its plain resync.
const linkResync = { hostAt: null, guestAt: null, applied: false };
// DOUBLE_RESYNC_ASK: where the logs stood when the guest asked twice.
const doubleResyncAsk = { hostAt: null, guestAt: null, applied: false };
// CATCH_UP_MS: where the logs stood when the guest asked, and whether it caught up.
const catchUp = { hostAt: null, guestAt: null, seen: false };
// RESYNC_ONE_BACK / RESYNC_SAME_FRAME: where the guest's log stood when it paused, and what its page saw.
const resyncOneBack = { guestAt: null, applied: false, page: null };
// UNANSWERED_SOCKET_RESYNC: where the logs stood when the guest asked.
// SYNC_FOLLOW_UP: where the logs stood before the freeze and after the fault.
const syncFollowUp = { hostAt: null, guestAt: null, hostEnd: null, watched: false, attempts: 0, framesAfter: 0 };
const unansweredSocketResync = {
  hostAt: null,
  guestAt: null,
  applied: false,
  gaveUp: false,
  letGo: false,
  askedAgain: false,
  ignored: false,
  framesAfter: 0,
};
const syncLogOf = (page) => page.evaluate(() => window.NetplayRollback?.exportSyncLog?.() || '');
const seqOf = (line) => Number(line.split('\t')[0]);
const lastLogLine = async (page) => {
  const last = (await syncLogOf(page)).trimEnd().split('\n').at(-1)?.split('\t') ?? [];
  return { seq: Number(last[0]) || 0, frame: Number((last[2] || '').replace('f=', '')) || 0 };
};
// The lines of a sync log after the one numbered `seq`.
const linesAfter = (log, seq) => log.split('\n').filter((line) => seqOf(line) > seq);
const waitForLine = async (page, afterSeq, re, timeoutMs) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (linesAfter(await syncLogOf(page), afterSeq).some((line) => re.test(line))) return true;
    await page.waitForTimeout(250);
  }
  return false;
};
for (;;) {
  const s = await Promise.all(
    [host, guest].map((p) =>
      p.evaluate(() => ({
        f: window.NetplayRollback.getHudCounters().currentFrame,
        sc: window.__tp.scene,
        b: window.__tp.inBattleAt,
        fail: window.__tp.pilotFail,
      })),
    ),
  );
  if (Date.now() - lastLog > 15000) {
    console.log('menus', JSON.stringify(s));
    lastLog = Date.now();
  }
  if (s[0].b > 0 && s[1].b > 0) {
    inBattle = true;
    break;
  }
  if (s[0].fail || s[1].fail) {
    console.log('autopilot failed', s[0].fail, s[1].fail);
    break;
  }
  if (Date.now() - tb > MENU_MS) {
    console.log('MENUS TIMED OUT (peers desynced or autopilot stuck)');
    await host.screenshot({ path: `${OUT}/host-stuck.png` });
    break;
  }
  await host.waitForTimeout(1000);
}
if (inBattle) {
  console.log('in battle; playing', BATTLE_SECONDS, 's');
  if (THROTTLE_GUEST) {
    // Fire-and-forget: flips the guest's throttle flag ~15s into the
    // battle without blocking the battle-length wait below. Marks the
    // game-fps measurement window start on both peers at the same moment,
    // so gameFps is measured only over the throttled window (see
    // MIN_GAME_FPS in the header doc). Records success in throttleFlipped
    // so a failed flip fails the run below instead of silently comparing
    // an unthrottled guest against MIN_GAME_FPS.
    setTimeout(() => {
      Promise.all([
        guest.evaluate(() => {
          window.__knThrottle = true;
          window.__tp.markFpsWindowStart();
        }),
        host.evaluate(() => window.__tp.markFpsWindowStart()),
      ]).then(
        () => {
          throttleFlipped = true;
          console.log(`THROTTLE_GUEST: guest capped to ~${THROTTLE_GUEST_HZ}Hz; fps window started`);
        },
        (e) => {
          throttleFlipped = false;
          console.log('THROTTLE_GUEST: failed to flip flag/mark window', e.message);
        },
      );
    }, 15000);
  } else {
    // No throttle knob: measure game fps over the whole battle.
    await Promise.all([
      host.evaluate(() => window.__tp.markFpsWindowStart()),
      guest.evaluate(() => window.__tp.markFpsWindowStart()),
    ]);
  }
  if (CLICK_DURING_BATTLE) {
    // #62 repro: two click rounds (host, then guest ~2s later), fired via
    // setTimeout so they don't block the battle-length wait below and don't
    // change BATTLE_SECONDS.
    scheduleClickRound((BATTLE_SECONDS * 1000) / 3, 'round 1');
    scheduleClickRound((BATTLE_SECONDS * 1000 * 2) / 3, 'round 2');
  }
  if (FREEZE_MS > 0) {
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
    const frozen = FREEZE_HOST_MS > 0 ? host : guest;
    console.log('freezing', FREEZE_HOST_MS > 0 ? 'host' : 'guest', 'for', FREEZE_MS, 'ms');
    await frozen.evaluate((ms) => {
      const t = performance.now();
      while (performance.now() - t < ms);
    }, FREEZE_MS);
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
  } else if (HIDE_GUEST_MS > 0) {
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
    if (HIDE_GUEST_FROZEN) {
      console.log('freezing hidden guest tab for', HIDE_GUEST_MS, 'ms');
      await guest.evaluate((ms) => {
        window.__knHidden = true;
        document.dispatchEvent(new Event('visibilitychange'));
        const t = performance.now();
        while (performance.now() - t < ms);
        window.__knHidden = false;
        document.dispatchEvent(new Event('visibilitychange'));
      }, HIDE_GUEST_MS);
      console.log('guest tab thawed');
    } else {
      console.log('hiding guest tab for', HIDE_GUEST_MS, 'ms');
      await guest.evaluate(() => {
        window.__knHidden = true;
        window.__knThrottle = true;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await host.waitForTimeout(HIDE_GUEST_MS);
      await guest.evaluate(() => {
        window.__knHidden = false;
        window.__knThrottle = false;
        document.dispatchEvent(new Event('visibilitychange'));
      });
      console.log('guest tab shown again');
    }
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
  } else if (DESYNC_GUEST) {
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
    // P1's stock count, at the address the core's map has for it (SSB64 US:
    // SCPlayerData.stock_count, 0xA4D33). RDRAM is host-order words, so the byte
    // is at offset ^ 3. Held for 3 s so that every state the rollback ring
    // can still restore carries the change.
    ({ frame: desyncGuestAt, stocksBase: desyncGuestStocksBase } = await guest.evaluate(async () => {
      const mod = window.EJS_emulator.gameManager.Module;
      const stocksBase = mod._kn_field_map_value?.(0) ?? 0xa4d33;
      const at = mod._kn_get_rdram_ptr() + (stocksBase ^ 3);
      const wrong = mod.HEAPU8[at] ^ 1;
      const frame = window.NetplayRollback.getHudCounters?.()?.currentFrame ?? 0;
      const until = performance.now() + 3000;
      while (performance.now() < until) {
        mod.HEAPU8[at] = wrong;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return { frame, stocksBase };
    }));
    console.log('guest desynced on purpose: P1 stock count changed at frame', desyncGuestAt);
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 2);
  } else if (HEAL_BOTH_SIDES) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    const frameOf = (page) => page.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
    const sinceBoundary = (f) => f % 300;
    // Both pages just past a health check: the next one comes after the
    // sim's stall and the phantom, so it has to heal a phantom.
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      const [hf, gf] = await Promise.all([frameOf(host), frameOf(guest)]);
      const h = sinceBoundary(hf);
      const g = sinceBoundary(gf);
      if (h >= 1 && h <= HEAL_AFTER_BOUNDARY_WITHIN && g >= 1 && g <= HEAL_AFTER_BOUNDARY_WITHIN) break;
      await host.waitForTimeout(50);
    }
    [healBoth.hostAt, healBoth.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
    // A silent death: the channel reads closed, nothing fires, and nothing
    // arrives on it or on the unreliable input channel beside it, on either
    // page (the case the mesh health check exists for). Inputs stop, so each
    // page stalls and then marks the other a phantom.
    const silence = (slot) => {
      const entry = Object.values(window.KNState?.peers ?? {}).find((peer) => peer.slot === slot);
      if (!entry?.dc || !entry.pc) return { ok: false, why: `no channel to slot ${slot}` };
      Object.defineProperty(entry.dc, 'readyState', { configurable: true, get: () => 'closed' });
      entry.dc.onclose = null;
      entry.dc.onerror = null;
      entry.pc.onconnectionstatechange = null;
      entry.pc.oniceconnectionstatechange = null;
      const drop = () => {};
      entry.dc.onmessage = drop;
      if (entry.rbDc) entry.rbDc.onmessage = drop;
      return { ok: true, frame: window.NetplayRollback.getHudCounters().currentFrame };
    };
    healSignalHold.on = true;
    healBoth.silenced = { host: await host.evaluate(silence, 1), guest: await guest.evaluate(silence, 0) };
    console.log('HEAL_BOTH_SIDES: both channels died silently', JSON.stringify(healBoth.silenced));
    // Until the guest's health check has found the dead channel, the host's
    // signaling to it waits.
    healBoth.guestChecked = await waitForLine(guest, healBoth.guestAt.seq, /MESH-HEAL f=/, HEAL_RECOVER_MS);
    healSignalHold.heldCount = healSignalHold.held.length;
    healSignalHold.release();
    console.log(
      `HEAL_BOTH_SIDES: the guest's check ran: ${healBoth.guestChecked}; ` +
        `${healSignalHold.heldCount} signal(s) to it held until then`,
    );
    healBoth.recovered = await waitForLine(guest, healBoth.guestAt.seq, /sync #\d+ applied/, HEAL_RECOVER_MS);
    // A second state racing the first would be applied within this window.
    if (healBoth.recovered) await guest.waitForTimeout(HEAL_SECOND_STATE_MS);
    healBoth.guestEnd = await lastLogLine(guest);
    const frameAt = await frameOf(guest);
    await guest.waitForTimeout(5000);
    healBoth.framesAfter = (await frameOf(guest)) - frameAt;
    console.log(
      `HEAL_BOTH_SIDES: guest resynced after the reconnect: ${healBoth.recovered} (${Date.now() - started} ms); ` +
        `${healBoth.framesAfter} frames in the next 5 s`,
    );
    if (ASK_UNANSWERED_PHANTOM && healBoth.recovered) {
      [askPhantom.hostAt, askPhantom.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
      askPhantom.range = await guest.evaluate(() => {
        const frame = window.NetplayRollback.getHudCounters().currentFrame;
        window.__knDropInputFrom = frame + 20;
        window.__knDropInputTo = frame + 21;
        return [window.__knDropInputFrom, window.__knDropInputTo];
      });
      askPhantom.armed = true;
      console.log(`ASK_UNANSWERED_PHANTOM: the guest drops its input for frame ${askPhantom.range[0]} for good`);
      await guest.waitForTimeout(ASK_PHANTOM_RECOVER_MS);
      askPhantom.dropped = await guest.evaluate(() => window.__knInputsDroppedUntil);
    }
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (DROP_PEER_MS > 0) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    [dropPeer.hostAt, dropPeer.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
    const frameNow = () => window.NetplayRollback.getHudCounters().currentFrame;
    dropPeer.hostFrame = await host.evaluate(frameNow);
    if (CATCH_UP_HOLE_MS > 0) {
      await host.evaluate((ms) => {
        window.__knDropInputsAfterOpenMs = ms;
        window.__knDropArmedAt = performance.now();
        // The host's ticks pause while the connection is down, so the guest
        // (which marks it a phantom and runs on) is ahead of the state it is
        // sent at the reconnect, and catches up from it.
        window.NetplayRollback.pauseTick();
        setTimeout(() => window.NetplayRollback.resumeTick(), 8000);
      }, CATCH_UP_HOLE_MS);
    }
    peerSignalBlock.until = Date.now() + DROP_PEER_MS;
    dropPeer.closed = await guest.evaluate(() => {
      const frame = window.NetplayRollback.getHudCounters().currentFrame;
      const entry = Object.values(window.KNState?.peers ?? {}).find((peer) => peer.slot === 0);
      if (!entry?.pc) return { closed: false, frame, why: 'no peer entry for slot 0' };
      const was = { pc: entry.pc.connectionState, dc: entry.dc?.readyState ?? null };
      entry.pc.close();
      return { closed: true, frame, was };
    });
    console.log(`DROP_PEER_MS: guest closed its connection to the host`, JSON.stringify(dropPeer.closed));
    console.log(`DROP_PEER_MS: WebRTC signaling to and from the guest dropped for ${DROP_PEER_MS} ms`);
    // Until the guest has applied the reconnect's resync, or the window runs out.
    const reconnected = await waitForLine(
      guest,
      dropPeer.guestAt.seq,
      /sync #\d+ applied/,
      DROP_PEER_MS + DROP_PEER_RECOVER_MS + 30000,
    );
    console.log(`DROP_PEER_MS: guest resynced after the reconnect: ${reconnected} (${Date.now() - started} ms)`);
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
    if (CATCH_UP_HOLE_MS > 0)
      dropPeer.holeDropped = await host.evaluate(() => window.__knInputsDroppedAfterOpen.slice());
  } else if (delayBootSyncAnswer) {
    // The boot sync's answer was held from the start; by the battle the
    // guest has normally timed out, asked again and been answered.
    const started = Date.now();
    delaySyncAnswer.hostAt = delaySyncAnswer.guestAt = { seq: -1, frame: 0 };
    delaySyncAnswer.timedOut = await waitForLine(
      guest,
      -1,
      /RESYNC-REQUEST-TIMEOUT/,
      DELAY_SYNC_ANSWER_MS + DELAY_SYNC_ANSWER_RECOVER_MS,
    );
    console.log(
      delaySyncAnswer.timedOut
        ? 'DELAY_SYNC_ANSWER_MS: the boot sync timed out'
        : 'DELAY_SYNC_ANSWER_MS: the guest never logged RESYNC-REQUEST-TIMEOUT',
    );
    await waitForLine(guest, -1, /SYNC-LATE-ANSWER-DROPPED/, DELAY_SYNC_ANSWER_RECOVER_MS);
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - (Date.now() - started)));
  } else if (DELAY_SYNC_ANSWER_MS > 0) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    [delaySyncAnswer.hostAt, delaySyncAnswer.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
    await host.evaluate((ms) => {
      window.__knHoldSyncAnswerMs = ms;
    }, DELAY_SYNC_ANSWER_MS);
    // The guest's network-change handler: an immediate, numbered sync-request-full.
    await guest.evaluate(() => window.dispatchEvent(new Event('online')));
    console.log(`DELAY_SYNC_ANSWER_MS: guest asked for a resync; the host's answer is held ${DELAY_SYNC_ANSWER_MS} ms`);
    delaySyncAnswer.timedOut = await waitForLine(
      guest,
      delaySyncAnswer.guestAt.seq,
      /RESYNC-REQUEST-TIMEOUT/,
      DELAY_SYNC_ANSWER_MS + DELAY_SYNC_ANSWER_RECOVER_MS,
    );
    if (delaySyncAnswer.timedOut) {
      // The guest asks again on its own at the deadline (RESYNC-REASK).
      if (await waitForLine(guest, delaySyncAnswer.guestAt.seq, /RESYNC-REASK .*: sent/, 5000)) {
        delaySyncAnswer.askedAgainAfterMs = Date.now() - started;
        console.log(`DELAY_SYNC_ANSWER_MS: guest timed out and asked again ${delaySyncAnswer.askedAgainAfterMs} ms in`);
      } else {
        console.log('DELAY_SYNC_ANSWER_MS: the guest timed out and did not ask again');
      }
    } else {
      console.log('DELAY_SYNC_ANSWER_MS: the guest never logged RESYNC-REQUEST-TIMEOUT');
    }
    await waitForLine(guest, delaySyncAnswer.guestAt.seq, /sync #\d+ applied/, DELAY_SYNC_ANSWER_RECOVER_MS);
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (SYNC_FOLLOW_UP === 'socket' || SYNC_FOLLOW_UP === 'owed') {
    // `owed`: the held request is delivered while the replay the released
    // inputs caused is still in flight (rb-page-network.mjs, __knReleaseOnReplay).
    const owedMode = SYNC_FOLLOW_UP === 'owed';
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    const NEUTRAL = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
    while (!syncFollowUp.watched && syncFollowUp.attempts < SYNC_FOLLOW_UP_ATTEMPTS) {
      syncFollowUp.attempts++;
      await guest.evaluate((n) => {
        window.__knInputOverride = () => n;
      }, NEUTRAL);
      await guest.waitForTimeout(3000);
      [syncFollowUp.hostAt, syncFollowUp.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
      // The host's next answer on `sync-state` loses its chunks; the guest's
      // chunk timeout then asks over the socket.
      // The socket request is held on the host page and delivered right
      // after the guest's kept-back inputs are taken in (below).
      // This attempt's request is the one held after the records kept so far.
      const heldBefore = await host.evaluate((owed) => {
        window.__knSyncAnswerDrops.push('chunks');
        window.__knHoldSocketRequests = 1;
        window.__knReleaseOnReplay = owed;
        return window.__knSocketRequestsHeld.length;
      }, owedMode);
      await guest.evaluate(() => window.dispatchEvent(new Event('online')));
      await guest.waitForTimeout(SYNC_FOLLOW_UP_SOCKET_HOLD_FROM_MS);
      // A button down, its packets kept back until the host holds the socket
      // request. Released then, they reach the host before it (the request
      // is delivered right after the first of them): the host takes in the
      // differing inputs, with a rollback owed for its next tick, and answers
      // before that tick, as the channel orders `direct`'s request. Inputs
      // that arrive after the answer instead are settled by it and never fed
      // in two players (docs/roadmap.md), so the frame would not change.
      await guest.evaluate((n) => {
        window.__knInputGate = true;
        window.__knInputOverride = () => ({ ...n, buttons: 1 });
      }, NEUTRAL);
      const asked = await waitForLine(guest, syncFollowUp.guestAt.seq, /sent socket sync-request-full to host/, 8000);
      const held = await host
        .waitForFunction((n) => window.__knSocketRequestsHeld.length > n, heldBefore, { timeout: 8000 })
        .then(
          () => true,
          () => false,
        );
      const released = await guest.evaluate(() => window.__knReleaseInputs());
      console.log(
        `SYNC_FOLLOW_UP=socket: ${released} input packet(s) released while the host holds the request (${held})`,
      );
      console.log(
        `SYNC_FOLLOW_UP=socket: attempt ${syncFollowUp.attempts}: socket request ${asked ? 'sent' : 'not sent'}`,
      );
      await host.waitForTimeout(8000);
      const hostLines = linesAfter(await syncLogOf(host), syncFollowUp.hostAt.seq);
      const received = hostLines.findIndex((l) => /received socket sync-request-full/.test(l));
      // Reached, on any engine: after the host took the socket answer's state
      // at F, a replay starts at or before F and rewrites it. With the fix the
      // host also logs SYNC-FOLLOW-UP-NEEDED; without it nothing is watched,
      // so only the replay shows it. Stopping on it keeps that answer the last
      // one applied, where the frames compared start: an engine without the
      // fix then shows the split instead of trying again past it.
      const tail = received < 0 ? [] : hostLines.slice(received);
      const read = tail.findIndex((l) => /host kn_sync_read:/.test(l));
      const takenAt = read < 0 ? NaN : Number((tail[read].split('\t')[2] || '').replace('f=', ''));
      // `owed`: reached once the request was delivered with a replay in
      // flight (any engine records it), so the answer's state was taken
      // with a correction owed.
      const record = await host.evaluate((n) => window.__knSocketRequestsHeld[n] ?? null, heldBefore);
      syncFollowUp.releasedInReplay = (record?.replayDepth ?? 0) > 0;
      syncFollowUp.watched = owedMode
        ? received >= 0 && syncFollowUp.releasedInReplay
        : received >= 0 &&
          (tail.some((l) => /SYNC-FOLLOW-UP-NEEDED /.test(l)) ||
            tail
              .slice(read + 1)
              .some(
                (l) =>
                  /C-REPLAY start: depth=[1-9]/.test(l) &&
                  Number((l.split('\t')[2] || '').replace('f=', '')) <= takenAt,
              ));
      await guest.evaluate((n) => {
        window.__knReleaseInputs();
        window.__knInputOverride = () => n;
      }, NEUTRAL);
      await host.evaluate(() => {
        window.__knHoldSocketRequests = 0;
        window.__knReleaseOnReplay = false;
      });
      console.log(
        `SYNC_FOLLOW_UP=${SYNC_FOLLOW_UP}: ` +
          (owedMode
            ? syncFollowUp.watched
              ? 'the request was answered with a replay in flight'
              : 'no replay in flight when the request was delivered; trying again'
            : syncFollowUp.watched
              ? 'a replay rewrote the frame the socket answer was taken at'
              : 'no replay rewrote it; trying again'),
      );
      if (!syncFollowUp.watched) await guest.waitForTimeout(5000);
    }
    await guest.waitForTimeout(12000);
    await guest.evaluate(() => {
      window.__knInputOverride = null;
    });
    syncFollowUp.hostEnd = await lastLogLine(host);
    const guestFrame = () => guest.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
    const frameAt = await guestFrame();
    await guest.waitForTimeout(5000);
    syncFollowUp.framesAfter = (await guestFrame()) - frameAt;
    console.log(
      `SYNC_FOLLOW_UP=socket: done (${Date.now() - started} ms, ${syncFollowUp.attempts} attempt(s)); ` +
        `the guest made ${syncFollowUp.framesAfter} frames in the next 5 s`,
    );
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (SYNC_FOLLOW_UP === 'direct') {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    const NEUTRAL = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
    while (!syncFollowUp.watched && syncFollowUp.attempts < SYNC_FOLLOW_UP_ATTEMPTS) {
      syncFollowUp.attempts++;
      // Fixed, so the host predicts it: neutral.
      await guest.evaluate((n) => {
        window.__knInputOverride = () => n;
      }, NEUTRAL);
      await guest.waitForTimeout(3000);
      [syncFollowUp.hostAt, syncFollowUp.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
      // A button down while its packets are held: the host runs those frames
      // on its prediction (neutral) and takes them in late. The request goes
      // on the host's `lockstep` channel; with the reliable input transport
      // (rb-transport adopted=reliable, these runs) the inputs are on that
      // channel too, so it arrives right behind them. On the unreliable
      // transport the inputs go on `rollback-input` and nothing orders the
      // request after them: the attempt may not reach the condition, and the
      // run then fails as not exercised rather than passing.
      await guest.evaluate(
        ({ ms, n }) => {
          window.__knHoldInputsUntil = performance.now() + ms;
          window.__knInputOverride = () => ({ ...n, buttons: 1 });
        },
        { ms: SYNC_FOLLOW_UP_DIRECT_HOLD_MS, n: NEUTRAL },
      );
      await guest.waitForTimeout(SYNC_FOLLOW_UP_DIRECT_ASK_MS);
      // The engine's own BOOT-SYNC: a numbered `sync-request-full` on the
      // host's channel at its next tick.
      await guest.evaluate(() => {
        window._knBootSyncDone = false;
      });
      const asked = await waitForLine(guest, syncFollowUp.guestAt.seq, /BOOT-SYNC: guest requesting/, 5000);
      // Inputs from here go out as usual; those held still go out together.
      await guest.evaluate(() => {
        window.__knHoldInputsUntil = 0;
      });
      console.log(
        `SYNC_FOLLOW_UP=direct: attempt ${syncFollowUp.attempts}: BOOT-SYNC ${asked ? 'logged' : 'not logged'}`,
      );
      await host.waitForTimeout(8000);
      syncFollowUp.watched = linesAfter(await syncLogOf(host), syncFollowUp.hostAt.seq).some((l) =>
        /SYNC-FOLLOW-UP-NEEDED /.test(l),
      );
      await guest.evaluate((n) => {
        window.__knInputOverride = () => n;
      }, NEUTRAL);
      console.log(
        `SYNC_FOLLOW_UP=direct: ${syncFollowUp.watched ? 'a prediction the answer was taken on differed' : 'no differing prediction seen; trying again'}`,
      );
      if (!syncFollowUp.watched) await guest.waitForTimeout(5000);
    }
    await guest.waitForTimeout(12000);
    await guest.evaluate(() => {
      window.__knInputOverride = null;
    });
    syncFollowUp.hostEnd = await lastLogLine(host);
    const guestFrame = () => guest.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
    const frameAt = await guestFrame();
    await guest.waitForTimeout(5000);
    syncFollowUp.framesAfter = (await guestFrame()) - frameAt;
    console.log(
      `SYNC_FOLLOW_UP=direct: done (${Date.now() - started} ms, ${syncFollowUp.attempts} attempt(s)); ` +
        `the guest made ${syncFollowUp.framesAfter} frames in the next 5 s`,
    );
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (SYNC_FOLLOW_UP) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    const NEUTRAL = { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
    while (!syncFollowUp.watched && syncFollowUp.attempts < SYNC_FOLLOW_UP_ATTEMPTS) {
      syncFollowUp.attempts++;
      // The guest's input, fixed: the host predicts the guest's last input,
      // so while it stays fixed every prediction holds.
      await guest.evaluate((n) => {
        window.__knInputOverride = () => n;
      }, NEUTRAL);
      await guest.waitForTimeout(3000);
      [syncFollowUp.hostAt, syncFollowUp.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
      console.log(
        `SYNC_FOLLOW_UP=${SYNC_FOLLOW_UP}: attempt ${syncFollowUp.attempts}, ` +
          `freezing the host for ${SYNC_FOLLOW_UP_FREEZE_MS} ms`,
      );
      await host.evaluate((ms) => {
        const t = performance.now();
        while (performance.now() - t < ms);
      }, SYNC_FOLLOW_UP_FREEZE_MS);
      // The guest's input packets are held from here until the host has
      // answered its recovery request, so the host answers on predicted
      // inputs. With `changed` a button is held down meanwhile, so the held
      // inputs differ from the prediction.
      await guest.evaluate(
        ({ ms, changed, n }) => {
          window.__knHoldInputsMs = ms;
          if (changed) window.__knInputOverride = () => ({ ...n, buttons: 1 });
        },
        { ms: SYNC_FOLLOW_UP_HOLD_MS, changed: SYNC_FOLLOW_UP === 'changed', n: NEUTRAL },
      );
      // Unconfirmed: the host watches the frame it sent. Confirmed: it just
      // dispatches, and the attempt is tried again.
      const answered = await waitForLine(
        host,
        syncFollowUp.hostAt.seq,
        /SYNC-FOLLOW-UP-WATCH |coord sync dispatch: /,
        20000,
      );
      if (answered) await host.waitForTimeout(500);
      syncFollowUp.watched = linesAfter(await syncLogOf(host), syncFollowUp.hostAt.seq).some((l) =>
        /SYNC-FOLLOW-UP-WATCH /.test(l),
      );
      await guest.evaluate((n) => {
        window.__knHoldInputsMs = 0;
        window.__knInputOverride = () => n;
      }, NEUTRAL);
      console.log(
        `SYNC_FOLLOW_UP=${SYNC_FOLLOW_UP}: ` +
          (syncFollowUp.watched
            ? 'the host answered unconfirmed; inputs released'
            : answered
              ? 'the host answered confirmed; trying again'
              : 'no answer seen'),
      );
      if (!syncFollowUp.watched) await guest.waitForTimeout(5000);
    }
    // The held inputs arrive, the frame is confirmed, and the follow-up is
    // decided (and, if sent, applied).
    await guest.waitForTimeout(12000);
    await guest.evaluate(() => {
      window.__knInputOverride = null;
    });
    syncFollowUp.hostEnd = await lastLogLine(host);
    // I1: the guest goes on making frames after the fault.
    const guestFrame = () => guest.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
    const frameAt = await guestFrame();
    await guest.waitForTimeout(5000);
    syncFollowUp.framesAfter = (await guestFrame()) - frameAt;
    console.log(
      `SYNC_FOLLOW_UP=${SYNC_FOLLOW_UP}: done (${Date.now() - started} ms, ${syncFollowUp.attempts} attempt(s)); ` +
        `the guest made ${syncFollowUp.framesAfter} frames in the next 5 s`,
    );
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (PAST_WINDOW_INPUT) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    [pastWindow.hostAt, pastWindow.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
    // F is a second or so ahead of the host: its input is nothing up to F
    // and a button from F, so the guest's prediction for F (the last input
    // it has, nothing) is wrong.
    pastWindow.frame = await host.evaluate(() => {
      const F = window.NetplayRollback.getHudCounters().currentFrame + 30;
      // The button on F alone: C predicts from the newest input it has, so
      // F differs from both its neighbours and the guest predicts it wrong.
      window.__knInputOverride = (f) =>
        f === F ? { buttons: 1, lx: 0, ly: 0, cx: 0, cy: 0 } : { buttons: 0, lx: 0, ly: 0, cx: 0, cy: 0 };
      return F;
    });
    // The guest takes in nothing for F, as a packet or inside a later
    // packet's redundancy; the packet itself is kept to hand over later.
    await guest.evaluate((F) => {
      const shared = window.KNShared;
      const decode = shared.decodeInput;
      window.__knHeldInput = { frame: F, held: 0, packet: null, decode };
      shared.decodeInput = (data) => {
        const d = decode(data);
        const hold = window.__knHeldInput;
        if (!hold || hold.frame < 0 || !d) return d;
        if (d.frame === hold.frame) {
          hold.held++;
          if (!hold.packet) hold.packet = data.slice(0);
          return { ...d, frame: NaN };
        }
        if (d.redundant?.some((r) => r.frame === hold.frame)) {
          hold.held++;
          return { ...d, redundant: d.redundant.filter((r) => r.frame !== hold.frame) };
        }
        return d;
      };
    }, pastWindow.frame);
    console.log(`${PAST_KNOB}: the host presses a button from frame ${pastWindow.frame}; the guest holds it`);
    // Forced: the edge stall lets F through (test-only switch).
    if (PAST_WINDOW_FORCED)
      await guest.evaluate((F) => {
        window.__test_runPastEdgeFor = F;
      }, pastWindow.frame);
    // Release at the edge (the guest stalls there) or, forced, past it.
    const depth = PAST_WINDOW_FORCED ? PAST_WINDOW_FORCED_DEPTH : ROLLBACK_CAP;
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      const hud = await guest.evaluate(() => window.NetplayRollback.getHudCounters());
      if (hud.currentFrame >= pastWindow.frame + (hud.delay ?? 0) + depth) break;
      await guest.waitForTimeout(20);
    }
    // At the edge, let the stall take hold before the input comes.
    if (ROLLBACK_AT_EDGE) await guest.waitForTimeout(500);
    await host.evaluate(() => {
      window.__knInputOverride = null;
    });
    const release = await guest.evaluate(() => {
      const hold = window.__knHeldInput;
      const frame = window.NetplayRollback.getHudCounters().currentFrame;
      hold.frame = -1;
      window.KNShared.decodeInput = hold.decode;
      window.__test_runPastEdgeFor = undefined;
      // Hand the held packet to the channel it would have come in on.
      const host = Object.values(window.KNState?.peers ?? {}).find((peer) => peer.slot === 0);
      if (hold.packet && host?.dc?.onmessage) host.dc.onmessage({ data: hold.packet });
      return { frame, held: hold.held, delivered: !!(hold.packet && host?.dc?.onmessage) };
    });
    pastWindow.held = release.held;
    pastWindow.releasedAt = release.frame;
    pastWindow.released = release.delivered;
    console.log(`${PAST_KNOB}: let go at guest frame ${release.frame}:`, JSON.stringify(release));
    if (PAST_WINDOW_FORCED)
      await waitForLine(guest, pastWindow.guestAt.seq, /sync #\d+ applied/, PAST_WINDOW_RECOVER_MS);
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (ASK_UNANSWERED_STALL_MS > 0) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    [askUnanswered.hostAt, askUnanswered.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
    askUnanswered.range = await guest.evaluate(
      ([ms, acksToo]) => {
        // A range just ahead of the guest's frame: dropped for good.
        const frame = window.NetplayRollback.getHudCounters().currentFrame;
        window.__knDropInputFrom = frame + 20;
        window.__knDropInputTo = frame + 28;
        if (acksToo) window.__knDropSettledUntil = performance.now() + ms;
        return [window.__knDropInputFrom, window.__knDropInputTo];
      },
      [ASK_UNANSWERED_STALL_MS, ASK_UNANSWERED_ACK_LOST],
    );
    if (ASK_UNANSWERED_ACKS)
      await host.evaluate((ms) => {
        window.__knDropSyncStateUntil = performance.now() + ms;
      }, ASK_UNANSWERED_STALL_MS);
    console.log(
      `ASK_UNANSWERED_STALL_MS: the guest drops its inputs for frames ${askUnanswered.range[0]}..${askUnanswered.range[1] - 1} for good` +
        (ASK_UNANSWERED_ACKS ? `, and the host's states never reach it for ${ASK_UNANSWERED_STALL_MS} ms` : '') +
        (ASK_UNANSWERED_ACK_LOST ? `, and its acknowledgements for ${ASK_UNANSWERED_STALL_MS} ms` : ''),
    );
    // The longest the host's frame stood still while this ran (sampled).
    let sampling = true;
    const sampler = (async () => {
      const hostFrame = () => host.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
      let lastFrame = await hostFrame();
      let lastAt = Date.now();
      while (sampling) {
        await host.waitForTimeout(200);
        const f = await hostFrame().catch(() => lastFrame);
        if (f !== lastFrame) {
          lastFrame = f;
          lastAt = Date.now();
        } else askUnanswered.freezeMs = Math.max(askUnanswered.freezeMs, Date.now() - lastAt);
      }
    })();
    const settled = await waitForLine(
      host,
      askUnanswered.hostAt.seq,
      RESYNC_OFF
        ? /RB-INPUT-STALL-TIMEOUT .*slot=1 |PEER-PHANTOM slot=1 lastAdvance=[\d.]+ staleSec=5\./
        : ASK_UNANSWERED_ACKS
          ? /INPUT-ASK-PUSH-GAVEUP|INPUT-ASK-PUSH-ENDED .*phantom/
          : ASK_UNANSWERED_ACK_LOST
            ? /INPUT-ASK-PUSH-ENDED/
            : /INPUT-ASK-PUSH-SETTLED/,
      ASK_UNANSWERED_STALL_MS + ASK_UNANSWERED_RECOVER_MS,
    );
    // A stall on main ends at its 5 s deadline; keep sampling past that.
    await host.waitForTimeout(STALL_DEADLINE_MS + 2000);
    sampling = false;
    await sampler;
    askUnanswered.dropped = await guest.evaluate(() => window.__knInputsDroppedUntil);
    if (ASK_UNANSWERED_ACKS) askUnanswered.statesDropped = await host.evaluate(() => window.__knSyncStateDropped);
    console.log(`ASK_UNANSWERED_STALL_MS: the push ended as the mode expects: ${settled} (${Date.now() - started} ms)`);
    if (ASK_UNANSWERED_ACKS && settled) {
      // The guest is told it was dropped and joins again late by itself
      // (specs/drop_is_final.qnt). Its engine starts over (and its sync log
      // with it), so the drop is read from its client events. The player
      // taps the page's gesture prompt as at the start; the input and hash
      // driver goes on the new engine once the late join has loaded.
      const told = Date.now() + 15000;
      while (Date.now() < told && !askUnanswered.droppedByHost) {
        askUnanswered.droppedByHost = await guest
          .evaluate(() => (window.__knEvents ?? []).find((e) => e.meta?.kind === 'dropped-by-host') ?? null)
          .catch(() => null);
        if (!askUnanswered.droppedByHost) await guest.waitForTimeout(200);
      }
      const joined = Date.now() + ASK_LATE_JOIN_MS;
      while (Date.now() < joined && !askUnanswered.lateJoinedAt) {
        if (await guest.locator('#gesture-prompt:not(.hidden)').count())
          await guest
            .locator('#gesture-prompt')
            .click({ force: true })
            .catch(() => {});
        const log = await guest.evaluate(() => window.NetplayRollback?.exportSyncLog?.() ?? '').catch(() => '');
        const m = log.match(/late-join loaded at frame (\d+)/);
        if (m) askUnanswered.lateJoinedAt = +m[1];
        else await guest.waitForTimeout(500);
      }
      if (askUnanswered.lateJoinedAt !== null) await install(guest, 'guest');
      console.log(
        `ASK_UNANSWERED_ACKS: told: ${!!askUnanswered.droppedByHost}; joined again late at frame ${askUnanswered.lateJoinedAt}`,
      );
    }
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (CATCH_UP_MS > 0) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    [catchUp.hostAt, catchUp.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
    await host.evaluate((ms) => {
      window.__knHoldSyncAnswerMs = ms;
    }, CATCH_UP_MS);
    // The guest's network-change handler: an immediate, numbered sync-request-full.
    await guest.evaluate(() => window.dispatchEvent(new Event('online')));
    console.log(`CATCH_UP_MS: guest asked for a resync; the host's answer is held ${CATCH_UP_MS} ms`);
    catchUp.seen = await waitForLine(
      guest,
      catchUp.guestAt.seq,
      /SYNC-CATCH-UP from=/,
      CATCH_UP_MS + CATCH_UP_RECOVER_MS,
    );
    console.log(
      catchUp.seen ? 'CATCH_UP_MS: the guest caught up' : 'CATCH_UP_MS: the guest never logged SYNC-CATCH-UP',
    );
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (RESYNC_FAULT) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    resyncOneBack.guestAt = await lastLogLine(guest);
    // Paused a second first, so the host's answer is for a frame the guest has not run.
    await guest.evaluate(async (sameFrame) => {
      window.__knResyncOneBack.start(sameFrame);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      window.__knResyncOneBack.ask();
    }, RESYNC_FAULT === 'same-frame');
    console.log(`${RESYNC_FAULT_KNOB}: guest paused a second and asked for a full resync`);
    resyncOneBack.applied = await waitForLine(
      guest,
      resyncOneBack.guestAt.seq,
      /sync #\d+ applied/,
      RESYNC_ONE_BACK_RECOVER_MS,
    );
    resyncOneBack.page = await guest.evaluate(() => {
      const { target, headerAt, replyAt, releasedAt, released, loaded, missed, flips, holds, savedNotRunAt } =
        window.__knResyncOneBack;
      return { target, headerAt, replyAt, releasedAt, released, loaded, missed, flips, holds, savedNotRunAt };
    });
    console.log(
      `${RESYNC_FAULT_KNOB}: resync applied: ${resyncOneBack.applied} (${Date.now() - started} ms)`,
      JSON.stringify(resyncOneBack.page),
    );
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (UNANSWERED_SOCKET_RESYNC) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    [unansweredSocketResync.hostAt, unansweredSocketResync.guestAt] = await Promise.all([
      lastLogLine(host),
      lastLogLine(guest),
    ]);
    const guestFrame = () => guest.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
    const stopDropping = () =>
      host.evaluate(() => {
        window.__knSyncAnswerDrops = [];
        window.__knDropSocketAnswers = 0;
      });
    if (UNANSWERED_VARIANT === 'guard') {
      // The answer to the guest's ask loses its chunks; the socket answer
      // that follows the chunk timeout is dropped, and the whole of the
      // answer to the first ask again.
      await host.evaluate(() => {
        window.__knSyncAnswerDrops = ['chunks', 'whole'];
        window.__knDropSocketAnswers = 1;
      });
      await guest.evaluate(() => window.dispatchEvent(new Event('online')));
      console.log('UNANSWERED_SOCKET_RESYNC: guest asked for a resync; its answers are dropped');
      // The guard times out at 15 s and the request's deadline asks a second
      // time at 16 s; that answer goes through.
      const asked = await waitForLine(
        guest,
        unansweredSocketResync.guestAt.seq,
        /RESYNC-REASK .*ask=2\/2/,
        UNANSWERED_SOCKET_RESYNC_RECOVER_MS,
      );
      unansweredSocketResync.applied =
        asked && (await waitForLine(guest, unansweredSocketResync.guestAt.seq, /sync #\d+ applied/, 15000));
    } else if (UNANSWERED_VARIANT === 'giveup') {
      await host.evaluate(() => {
        window.__knSyncAnswerDrops = Array(8).fill('whole');
        window.__knDropSocketAnswers = 8;
      });
      await guest.evaluate(() => window.dispatchEvent(new Event('online')));
      console.log('UNANSWERED_SOCKET_RESYNC=giveup: guest asked for a resync; every answer is dropped');
      unansweredSocketResync.gaveUp = await waitForLine(
        guest,
        unansweredSocketResync.guestAt.seq,
        /RESYNC-REASK-GIVEUP/,
        UNANSWERED_SOCKET_RESYNC_RECOVER_MS,
      );
      await stopDropping();
    } else if (UNANSWERED_VARIANT === 'ignored') {
      // The answer to the guest's ask loses its chunks; the guest holds the
      // socket answer the chunk timeout brings until the next answer on the
      // channel (the ask again's) is in.
      await host.evaluate(() => {
        window.__knSyncAnswerDrops = ['chunks'];
      });
      await guest.evaluate(() => {
        window.__knHoldSocketAnswers = 1;
      });
      await guest.evaluate(() => window.dispatchEvent(new Event('online')));
      console.log('UNANSWERED_SOCKET_RESYNC=ignored: guest asked; the socket answer will come late');
      unansweredSocketResync.ignored = await waitForLine(
        guest,
        unansweredSocketResync.guestAt.seq,
        /SYNC-LATE-ANSWER-IGNORED/,
        UNANSWERED_SOCKET_RESYNC_RECOVER_MS,
      );
      unansweredSocketResync.applied = await waitForLine(
        guest,
        unansweredSocketResync.guestAt.seq,
        /sync #\d+ applied/,
        15000,
      );
      await stopDropping();
    } else {
      await host.evaluate(() => {
        window.__knSyncAnswerDrops = ['whole'];
        window.__knSyncAnswerDropRepeats = true;
      });
      console.log(`UNANSWERED_SOCKET_RESYNC=letgo: freezing the host for ${UNANSWERED_LETGO_FREEZE_MS} ms`);
      await host.evaluate((ms) => {
        const t = performance.now();
        while (performance.now() - t < ms);
      }, UNANSWERED_LETGO_FREEZE_MS);
      unansweredSocketResync.askedAgain = await waitForLine(
        guest,
        unansweredSocketResync.guestAt.seq,
        /RESYNC-REASK /,
        UNANSWERED_SOCKET_RESYNC_RECOVER_MS,
      );
      // The state applied after the ask again (the report checks the order).
      if (unansweredSocketResync.askedAgain) {
        const until = Date.now() + 15000;
        while (Date.now() < until && !unansweredSocketResync.applied) {
          const lines = linesAfter(await syncLogOf(guest), unansweredSocketResync.guestAt.seq);
          const ask = lines.findIndex((l) => /RESYNC-REASK /.test(l));
          unansweredSocketResync.applied = ask >= 0 && lines.slice(ask).some((l) => /sync #\d+ applied/.test(l));
          if (!unansweredSocketResync.applied) await guest.waitForTimeout(250);
        }
      }
      await stopDropping();
    }
    // I1: the guest goes on making frames after the fault.
    const frameAt = await guestFrame();
    await guest.waitForTimeout(5000);
    unansweredSocketResync.framesAfter = (await guestFrame()) - frameAt;
    console.log(
      `UNANSWERED_SOCKET_RESYNC=${UNANSWERED_VARIANT}: done (${Date.now() - started} ms); ` +
        `the guest made ${unansweredSocketResync.framesAfter} frames in the next 5 s`,
    );
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (DOUBLE_RESYNC_ASK) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    [doubleResyncAsk.hostAt, doubleResyncAsk.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
    // The network-change handler twice at once: two immediate, numbered requests.
    await guest.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('online'));
    });
    console.log('DOUBLE_RESYNC_ASK: guest asked for a resync twice');
    doubleResyncAsk.applied = await waitForLine(
      guest,
      doubleResyncAsk.guestAt.seq,
      /sync #\d+ applied/,
      DOUBLE_RESYNC_ASK_RECOVER_MS,
    );
    console.log(`DOUBLE_RESYNC_ASK: resync applied: ${doubleResyncAsk.applied} (${Date.now() - started} ms)`);
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (LINK_RESYNC) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    [linkResync.hostAt, linkResync.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
    // The guest's network-change handler: an immediate, numbered sync-request-full.
    await guest.evaluate(() => window.dispatchEvent(new Event('online')));
    console.log(`LINK_KBPS: guest asked for a resync over a ${LINK_KBPS} kbit/s link`);
    linkResync.applied = await waitForLine(guest, linkResync.guestAt.seq, /sync #\d+ applied/, LINK_RESYNC_RECOVER_MS);
    console.log(`LINK_KBPS: resync applied: ${linkResync.applied} (${Date.now() - started} ms)`);
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (LOSE_INPUTS_BEFORE_FALLBACK) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    [loseBeforeFallback.hostAt, loseBeforeFallback.guestAt] = await Promise.all([
      lastLogLine(host),
      lastLogLine(guest),
    ]);
    await host.evaluate(() => {
      window.__knLoseRbInputs = true;
    });
    console.log("LOSE_INPUTS_BEFORE_FALLBACK: the host's inputs on rollback-input are dropped from here on");
    const framesLost = () => host.evaluate(() => new Set(window.__knRbInputsLost).size);
    while (loseBeforeFallback.rounds < 5) {
      loseBeforeFallback.rounds++;
      const at = await lastLogLine(host);
      // The host takes the unreliable transport up again and tells the guest,
      // as at the match start (knDiag.setTransport, host-authoritative).
      const asked = await host.evaluate(() => window.knDiag?.setTransport?.('unreliable') === 'unreliable');
      loseBeforeFallback.fellBack = asked && (await waitForLine(host, at.seq, /DC-FALLBACK reason=/, 30000));
      const lost = await framesLost();
      console.log(
        `LOSE_INPUTS_BEFORE_FALLBACK: round ${loseBeforeFallback.rounds}: the host switched to the reliable ` +
          `channel: ${loseBeforeFallback.fellBack}; ${lost} frames dropped (${Date.now() - started} ms)`,
      );
      if (!loseBeforeFallback.fellBack || lost >= 2) break;
    }
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else if (DROP_SIGNALING_MS > 0) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    // Only reconnects after this point count: one during setup must not satisfy the check.
    for (const p of [host, guest]) {
      signaling.get(p).reconnectsBefore = await p.evaluate(
        () => window.__knEvents.filter((e) => e.type === 'reconnect').length,
      );
      // Stalls count from here too. One before the outage is not its doing:
      // on a slow machine a page that freezes for 2 s during boot leaves the
      // other waiting on it, and that wait is logged as TICK-STUCK.
      // The boundary is the last line logged, by its sequence number: a
      // stuck page logs on one frame for seconds, so a frame cannot tell a
      // line from just before the outage from one after it.
      signaling.get(p).outageAt = await p.evaluate(() => {
        const last = (window.NetplayRollback?.exportSyncLog?.() || '').trimEnd().split('\n').at(-1)?.split('\t') ?? [];
        return { seq: Number(last[0]) || 0, frame: Number((last[2] || '').replace('f=', '')) || 0 };
      });
    }
    await Promise.all([setSignalingDown(host, true), setSignalingDown(guest, true)]);
    console.log(`signaling sockets cut on both pages for ${DROP_SIGNALING_MS} ms`);
    await host.waitForTimeout(DROP_SIGNALING_MS);
    // With DROP_SIGNALING_GUEST_LATE_MS the host comes back first and must
    // see a room without the guest before the guest rejoins under a new
    // socket id. Opening the host's gate does not make that happen, so wait
    // for the host's engine to log the one-player roster; if it has not by
    // the end of the window, the run did not test what it claims and fails.
    const soloRosters = () =>
      host.evaluate(
        () => (window.NetplayRollback?.exportSyncLog?.() || '').match(/onUsersUpdated: 1 players/g)?.length ?? 0,
      );
    const soloRostersBefore = DROP_SIGNALING_GUEST_LATE_MS > 0 ? await soloRosters() : 0;
    const restoreStarted = Date.now();
    await setSignalingDown(host, false);
    if (DROP_SIGNALING_GUEST_LATE_MS > 0) {
      console.log(`host signaling allowed to reconnect; guest held up to ${DROP_SIGNALING_GUEST_LATE_MS} ms longer`);
      while (Date.now() - restoreStarted < DROP_SIGNALING_GUEST_LATE_MS) {
        if ((await soloRosters()) > soloRostersBefore) {
          hostSawRoomWithoutGuest = true;
          break;
        }
        await host.waitForTimeout(500);
      }
      console.log(`host saw the room without the guest: ${hostSawRoomWithoutGuest}`);
    }
    await setSignalingDown(guest, false);
    console.log('signaling allowed to reconnect');
    const guestLateFor = Date.now() - restoreStarted;
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - DROP_SIGNALING_MS - guestLateFor));
    // Socket.IO retries on a backoff, and an attempt can take many seconds on
    // a slow machine, so a page may still be mid-retry when the battle time is
    // up. Give each page until DROP_SIGNALING_RECONNECT_WAIT_MS to record its
    // reconnect; one that still has not is reported as never reconnected.
    for (const p of [host, guest]) {
      await p
        .waitForFunction(
          (reconnectsBefore) => window.__knEvents.filter((e) => e.type === 'reconnect').length > reconnectsBefore,
          signaling.get(p).reconnectsBefore,
          { timeout: DROP_SIGNALING_RECONNECT_WAIT_MS },
        )
        .catch(() => {});
    }
    // The guest's reconnect is recorded when its socket connects, before it
    // has rejoined the room. The host's handling of that rejoin is the thing
    // under test, so wait for the host to log the two-player roster again and
    // then long enough for a stall to be logged (TICK-STUCK errors at 5 s).
    if (hostSawRoomWithoutGuest) {
      const guestIsBack = () =>
        host.evaluate(() => {
          const log = window.NetplayRollback?.exportSyncLog?.() || '';
          return log.slice(log.lastIndexOf('onUsersUpdated: 1 players')).includes('onUsersUpdated: 2 players');
        });
      const until = Date.now() + DROP_SIGNALING_RECONNECT_WAIT_MS;
      while (Date.now() < until && !hostSawGuestReturn) {
        hostSawGuestReturn = await guestIsBack();
        if (!hostSawGuestReturn) await host.waitForTimeout(500);
      }
      console.log(`host saw the guest back in the room: ${hostSawGuestReturn}`);
      await host.waitForTimeout(8000);
    }
  } else if (C_ROLLBACK_TRAP) {
    await host.waitForTimeout((BATTLE_SECONDS * 1000) / 3);
    const trap = { hostAt: null, guestAt: null };
    [trap.hostAt, trap.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
    const frameOf = (p) => p.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame);
    // From here every call of the guest's kn_pre_tick throws what a WASM trap
    // throws, as a trap the engine cannot get past would.
    trap.frame = await guest.evaluate(() => {
      window.EJS_emulator.gameManager.Module._kn_pre_tick = () => {
        throw new WebAssembly.RuntimeError('memory access out of bounds (C_ROLLBACK_TRAP)');
      };
      return window.NetplayRollback.getHudCounters().currentFrame;
    });
    console.log(`C_ROLLBACK_TRAP: the guest's kn_pre_tick traps from frame ${trap.frame}`);
    trap.fatal = await waitForLine(guest, trap.guestAt.seq, /FATAL-CORE-ABORT branch=c-rollback/, 10000);
    // The host waits on the stopped guest's inputs, then drops it at the deadline.
    trap.hostDropped = await waitForLine(host, trap.hostAt.seq, /PEER-PHANTOM slot=1/, 20000);
    const [guestBefore, hostBefore] = await Promise.all([frameOf(guest), frameOf(host)]);
    await host.waitForTimeout(5000);
    const [guestAfter, hostAfter] = await Promise.all([frameOf(guest), frameOf(host)]);
    trap.guestFramesAfter = guestAfter - guestBefore;
    trap.hostFramesAfter = hostAfter - hostBefore;
    trap.error = await guest.evaluate(() => {
      const el = document.getElementById('error-msg');
      return el && !el.classList.contains('hidden') ? el.textContent.trim() : null;
    });
    const [hostSync, guestSync] = await Promise.all([syncLogOf(host), syncLogOf(guest)]);
    fs.writeFileSync(`${OUT}/host-sync.txt`, hostSync);
    fs.writeFileSync(`${OUT}/guest-sync.txt`, guestSync);
    const guestLines = linesAfter(guestSync, trap.guestAt.seq);
    trap.throws = guestLines.filter((line) => /C-ROLLBACK-THROW/.test(line)).length;
    trap.fellBack = guestLines.some((line) => /C-ROLLBACK-FALLBACK/.test(line));
    // No worker replay may land on the trapped core: its coprocessor is off.
    trap.coprocOff = /WORKER-COPROC AUTO-DISABLED/.test(guestSync);
    const trapFailed = !(
      trap.fatal &&
      trap.throws === 1 &&
      !trap.fellBack &&
      trap.coprocOff &&
      trap.guestFramesAfter === 0 &&
      /emulator crashed/i.test(trap.error || '') &&
      trap.hostDropped &&
      trap.hostFramesAfter > 0
    );
    fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify({ mode: MODE, cRollbackTrap: trap }, null, 1));
    console.log(
      trapFailed
        ? 'C_ROLLBACK_TRAP: the trap did not end the match on the guest alone, or the host did not play on:'
        : 'C_ROLLBACK_TRAP: the guest ended its match at the trap; the host dropped it and played on:',
      JSON.stringify(trap),
    );
    for (const b of new Set([hostBrowser, guestBrowser])) await b.close();
    process.exit(trapFailed ? 1 : 0);
  } else if (MALFORMED_PEER) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    [malformedPeer.hostAt, malformedPeer.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
    // Each page sends the other, on its real channels, what no handler may read.
    malformedPeer.sent = await Promise.all(
      [host, guest].map((p, i) =>
        p.evaluate(
          ([strings, isGuest]) => {
            const peer = Object.values(window.KNState.peers).find((q) => q?.dc?.readyState === 'open');
            if (!peer || peer.syncDc?.readyState !== 'open') return false;
            for (const text of strings.lockstep) peer.dc.send(text);
            for (const text of strings.syncState) peer.syncDc.send(text);
            if (isGuest) for (const text of strings.guestSyncState) peer.syncDc.send(text);
            return true;
          },
          [MALFORMED_STRINGS, i === 1],
        ),
      ),
    );
    console.log(`MALFORMED_PEER: strings off their schema sent (host, guest): ${malformedPeer.sent}`);
    await host.waitForTimeout(10000);
    malformedPeer.frameLater = await Promise.all(
      [host, guest].map((p) => p.evaluate(() => window.NetplayRollback.getHudCounters().currentFrame)),
    );
    await host.waitForTimeout(Math.max(0, BATTLE_SECONDS * 1000 - before - (Date.now() - started)));
  } else {
    await host.waitForTimeout(BATTLE_SECONDS * 1000);
  }
}

const collect = (p, VISUAL_CHECK) =>
  p.evaluate((VISUAL_CHECK) => {
    const fpsWindowEnd = {
      f: window.__tp.lastR ?? window.NetplayRollback.getHudCounters().currentFrame,
      t: performance.now(),
    };
    const m = window.EJS_emulator.gameManager.Module;
    let visual = null;
    if (VISUAL_CHECK) {
      const frames = window.__tp.visualFrames;
      const frameBytes = 48 * 36 * 3;
      const buf = new Uint8Array(frames.length * frameBytes);
      let off = 0;
      for (const x of frames) {
        buf.set(x.bytes, off);
        off += frameBytes;
      }
      // base64-encode in chunks: String.fromCharCode.apply chokes on huge arrays.
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
      visual = { frames: frames.map((x) => x.f), frameBytes, b64: btoa(bin) };
    }
    return {
      hashes: window.__tp.hashes,
      // The lag this page read its hashes at, and each time its engine was
      // armed (tests/hash-lag.mjs).
      hashLag: window.__knHashLag ?? null,
      ticksWithoutLag: window.__tp.ticksWithoutLag,
      // The frame of the last post_tick run outside a replay: the last
      // frame read at was this minus the lag.
      lastR: window.__tp.lastR ?? null,
      early: window.__tp.early,
      inBattleAt: window.__tp.inBattleAt,
      menuInputs: window.__tp.menuInputs,
      delay: window.NetplayRollback.getHudCounters?.()?.delay ?? null,
      extraDelay: window.NetplayRollback.getHudCounters?.()?.extraDelay ?? null,
      frame: window.NetplayRollback.getHudCounters().currentFrame,
      // The mode the page's info panel shows.
      infoMode: window.NetplayRollback.getInfo?.()?.mode ?? null,
      fpsWindowStart: window.__tp.fpsWindowStart,
      fpsWindowEnd,
      clog: m.UTF8ToString(m._kn_get_debug_log()),
      // A core with kn_clear_debug_log is emptied at each drain into the sync log.
      clogDrained: typeof m._kn_clear_debug_log === 'function',
      // Lines the C log dropped since kn_rollback_init, read now: a drop after
      // the last drain has no C-LOG-DROPPED line in the sync log yet.
      clogDropped: m._kn_get_debug_log_dropped?.() ?? 0,
      sync: window.NetplayRollback.exportSyncLog?.() || '',
      syncAnswersHeld: window.__knSyncAnswersHeld ?? [],
      rbInputsLost: window.__knRbInputsLost ?? [],
      syncAnswersDropped: window.__knSyncAnswersDropped ?? [],
      socketAnswersDropped: window.__knSocketAnswersDropped ?? [],
      socketAnswersHeld: window.__knSocketAnswersHeld ?? [],
      workerResultsHeld: window.__knWorkerResultsHeld ?? [],
      link: window.__knLink ?? null,
      rollbacks: m._kn_get_rollback_count?.(),
      failed: m._kn_get_failed_rollbacks?.(),
      // Frames run on a prediction nothing will correct (PREDICTED-KNOWN).
      predictedKnown: window.NetplayRollback.getHudCounters?.()?.predictedKnown ?? null,
      // 64 KB RDRAM blocks kn_game_state_hash leaves out (of 128).
      taintedBlocks: m._kn_get_tainted_block_count?.() ?? null,
      mapRom: window.__tp.mapRom,
      mapScenes: window.__tp.mapScenes,
      mapOngoing: window.__tp.mapOngoing,
      mapLiveHeaderPointer: window.__tp.mapLiveHeaderPointer,
      mapSamples: window.__tp.mapSamples,
      resyncExtras: window.__knResyncExtras
        ? { ...window.__knResyncExtras, stillWrapped: window.__knResyncExtras.stillWrapped() }
        : null,
      visual,
    };
  }, VISUAL_CHECK);
const [H, G] = await Promise.all([collect(host, VISUAL_CHECK), collect(guest, VISUAL_CHECK)]);
// The lag each page read its hashes at (tests/hash-lag.mjs), and the largest
// any page used at any point (a re-arm mid-match can change it): how far
// behind a frame an event can show in the hashes.
const lagOf = (peer) => peer.hashLag?.lag ?? null;
const HASH_LAG = Math.max(0, ...[H, G].flatMap((peer) => (peer.hashLag?.inits ?? []).map((i) => i.lag)));
const ROLLBACK_MAX = Math.max(0, ...[H, G].flatMap((peer) => (peer.hashLag?.inits ?? []).map((i) => i.max)));
// The whole C engine log. The page drains it into its sync log as [C] lines,
// and a core with kn_clear_debug_log is emptied each time: the log is those
// lines, then what has not been drained yet. An older core keeps it all.
// The sync log is a ring of SYNC_LOG_MAX entries numbered from 0: once its
// first entry is gone, so may be drained C lines, and the C log is not whole.
const syncRotated = (peer) => Number(peer.sync.slice(0, peer.sync.indexOf('\t'))) > 0;
const cLogPartial = { host: H.clogDrained && syncRotated(H), guest: G.clogDrained && syncRotated(G) };
// C lines the engine's buffer had no room for: reported by a drain
// (C-LOG-DROPPED), and counted since kn_rollback_init up to now.
const cLogDropped = {
  host: { reported: (H.sync.match(/C-LOG-DROPPED/g) || []).length, sinceInit: H.clogDropped },
  guest: { reported: (G.sync.match(/C-LOG-DROPPED/g) || []).length, sinceInit: G.clogDropped },
};
const wholeCLog = (peer) =>
  peer.clogDrained
    ? [
        ...peer.sync
          .split('\n')
          .filter((line) => line.includes('\t[C] '))
          .map((line) => line.slice(line.indexOf('\t[C] ') + 5)),
        peer.clog,
      ].join('\n')
    : peer.clog;
H.clog = wholeCLog(H);
G.clog = wholeCLog(G);
const knEventsOf = (page) => page.evaluate(() => window.__knEvents ?? []);
const [hostEvents, guestEvents] = await Promise.all([knEventsOf(host), knEventsOf(guest)]);
// The observers' reports: sync-log lines, the client events the pages sent,
// and (KN_DB) the rows the server stored, once the last posts have landed.
await host.waitForTimeout(2000);
const observers = {
  host: { syncLog: observerLinesIn(H.sync), events: observerEventsIn(hostEvents) },
  guest: { syncLog: observerLinesIn(G.sync), events: observerEventsIn(guestEvents) },
  db: await observerEventsInDb(KN_DB, [room]).catch((e) => ({ error: e.message })),
};
const observerDisagreements =
  observerTotal(observers.host.syncLog, observers.host.events, observers.guest.syncLog, observers.guest.events) +
  (observers.db?.error ? 0 : observerTotal(observers.db));
const observerNote = observerDbNote(KN_DB, [room]);
if (observerNote) console.log(observerNote);
if (observers.db?.error) console.log(`KN_DB could not be read: ${observers.db.error}`);
await host.screenshot({ path: `${OUT}/host.png` });
await guest.screenshot({ path: `${OUT}/guest.png` });
fs.writeFileSync(`${OUT}/host-clog.txt`, H.clog);
fs.writeFileSync(`${OUT}/guest-clog.txt`, G.clog);
fs.writeFileSync(`${OUT}/host-sync.txt`, H.sync);
fs.writeFileSync(`${OUT}/guest-sync.txt`, G.sync);
fs.writeFileSync(
  `${OUT}/menu-inputs.json`,
  JSON.stringify(
    {
      romHash: ROM_HASH,
      menuAutopilot: MENU_AUTOPILOT,
      delay: { host: H.delay, guest: G.delay },
      extraDelay: { host: H.extraDelay, guest: G.extraDelay },
      battleStart: { host: H.inBattleAt, guest: G.inBattleAt },
      host: H.menuInputs,
      guest: G.menuInputs,
    },
    null,
    1,
  ),
);

// Freeze mode: peers legitimately diverge while the host is a phantom, so
// only frames from the guest's last applied resync onward must match.
// Cross-engine boot (see HOST_BROWSER/GUEST_BROWSER doc above): frames
// before the guest's applied BOOT-SYNC are excluded the same way — never
// widen this to a same-engine run, where a boot-window mismatch is real.
const crossEngine = hostBrowser !== guestBrowser;
// Each state the guest took: a resync, or a late join's state (a page the
// host dropped joins again late, specs/drop_is_final.qnt).
const resyncs = [...G.sync.matchAll(/sync #\d+ applied \(frame \d+ -> (\d+)|late-join loaded at frame (\d+)/g)].map(
  (m) => +(m[1] ?? m[2]),
);
const bootSyncFrame = crossEngine && resyncs.length ? resyncs[0] : 0;
// RESYNC_ONE_BACK / RESYNC_SAME_FRAME: the guest's frame reset after it
// paused (none for the same frame) and the resync it applied. The compare
// starts at the answer's frame, that frame included.
const oneBackReset = (() => {
  if (!RESYNC_FAULT || !resyncOneBack.guestAt) return null;
  const line = linesAfter(G.sync, resyncOneBack.guestAt.seq).find((l) => /sync frame reset: \d+ → \d+/.test(l));
  const m = line?.match(/sync frame reset: (\d+) → (\d+)/);
  return m ? { from: +m[1], to: +m[2] } : null;
})();
const faultResyncApplied = (() => {
  if (!RESYNC_FAULT || !resyncOneBack.guestAt) return null;
  const line = linesAfter(G.sync, resyncOneBack.guestAt.seq).find((l) =>
    /sync #\d+ applied \(frame \d+ -> \d+/.test(l),
  );
  const m = line?.match(/sync #\d+ applied \(frame (\d+) -> (\d+)/);
  return m ? { frame: +m[1], counter: +m[2] } : null;
})();
const faultTarget = resyncOneBack.page?.target ?? null;
const resyncFaultLanded =
  RESYNC_FAULT === 'one-back'
    ? !!oneBackReset && oneBackReset.from === oneBackReset.to + 1 && oneBackReset.to === faultTarget
    : RESYNC_FAULT === 'same-frame'
      ? !oneBackReset &&
        resyncOneBack.page?.savedNotRunAt === faultTarget &&
        faultResyncApplied?.frame === faultTarget &&
        faultResyncApplied?.counter === faultTarget
      : false;
const recoveredAt = RESYNC_OFF
  ? bootSyncFrame
  : RESYNC_FAULT
    ? resyncFaultLanded
      ? faultTarget
      : Infinity
    : FREEZE_LIKE
      ? resyncs.length
        ? resyncs[resyncs.length - 1]
        : Infinity
      : bootSyncFrame;
// RESYNC_OFF: the last frame compared is the one before the hole.
const compareUntil = RESYNC_OFF && askUnanswered.range ? askUnanswered.range[0] : Infinity;
let both = 0,
  gpMis = 0,
  fullMis = 0,
  firstGp = null,
  firstFull = null,
  battleCompared = 0,
  gsMis = 0,
  firstGs = null,
  gpMisBeforeDesync = 0,
  gpMisAfterDesync = 0;
// A page that froze, was dropped as a phantom and resynced: its frames
// differ by design and are left out, like the frames before the resync in
// freeze mode (tests/frozen-recovery.mjs says what counts as proof). Freeze
// mode makes its own phantom on purpose and has its own exclusion.
// LINK_KBPS: when each page's input messages (every channel but
// `sync-state`) were starved on its link, in that page's frames. A phantom
// of a page whose inputs were stuck there is the link's doing, not a frozen
// page, and is not left out (withoutLinkStarved).
const starvedFramesOf = (peer) =>
  spansInFrames(
    peer.sync,
    Object.entries(peer.link?.stats.byLabel ?? {})
      .filter(([label]) => label !== 'sync-state')
      .flatMap(([, s]) => s.starvedSpans),
  );
const linkStarvedFrames = LINK_KBPS > 0 ? { host: starvedFramesOf(H), guest: starvedFramesOf(G) } : null;
const recoveries = FREEZE_LIKE
  ? []
  : linkStarvedFrames
    ? withoutLinkStarved(frozenRecoveries({ host: H.sync, guest: G.sync }, { hashLag: HASH_LAG }), linkStarvedFrames)
    : frozenRecoveries({ host: H.sync, guest: G.sync }, { hashLag: HASH_LAG });
let framesExcluded = 0,
  mismatchesExcluded = 0;
// DROP_PEER_MS: the reconnect as the logs show it, after the drop. From
// HASH_LAG frames before the drop (the hashes trail the head by that) to the frame the
// guest's reconnect resync lands on, each page ran on predicted input for
// the other, so the two timelines split by design; those frames are left
// out, as a proven frozen-page recovery's are. Only when every step of the
// reconnect is in the logs: otherwise every frame is compared.
const dropPeerReport = (() => {
  if (!DROP_PEER_MS || !dropPeer.guestAt) return null;
  const guestLines = linesAfter(G.sync, dropPeer.guestAt.seq);
  const hostLines = linesAfter(H.sync, dropPeer.hostAt.seq);
  const lineOf = (lines, re) => lines.find((line) => re.test(line)) ?? null;
  const resyncSent = guestLines.findIndex((line) => /reconnect resync: sent/.test(line));
  const applied = (resyncSent < 0 ? [] : guestLines.slice(resyncSent))
    .map((line) => line.match(/sync #\d+ applied \(frame \d+ -> (\d+)/))
    .filter(Boolean)
    .map((m) => Number(m[1]));
  let to = applied.length ? applied[0] : null;
  // A second resync right after the first ends the split, as in frozen-recovery.mjs.
  for (const at of applied) if (to !== null && at > to && at <= to + 12) to = at;
  const paths = {
    reconnectOffer: lineOf(guestLines, /received reconnect offer from/),
    answer: lineOf(hostLines, /onWebRTCSignal: answer from/),
    channelOpen: lineOf(guestLines, /DC open with \S+ slot: 0/),
    reconnectResync: lineOf(guestLines, /reconnect resync: sent/),
    resyncApplied: resyncSent < 0 ? null : lineOf(guestLines.slice(resyncSent), /sync #\d+ applied/),
  };
  const proven = !!dropPeer.closed?.closed && Object.values(paths).every(Boolean) && to !== null;
  // The fault itself: signaling was really dropped, and a drop that outlasts
  // an attempt's deadline took the host through a timed-out attempt and a retry.
  const retryExpected = DROP_PEER_MS > RECONNECT_ATTEMPT_TIMEOUT_MS;
  const retry =
    lineOf(hostLines, /reconnect attempt 1 timeout/) ??
    lineOf(hostLines, /initiating reconnect to \S+ \(attempt [2-9]/);
  const exercised = peerSignalBlock.dropped > 0 && (!retryExpected || !!retry);
  return {
    ms: DROP_PEER_MS,
    closed: dropPeer.closed,
    signalsDropped: peerSignalBlock.dropped,
    attemptTimeoutMs: RECONNECT_ATTEMPT_TIMEOUT_MS,
    retryExpected,
    retry,
    exercised,
    frameAtDrop: { host: dropPeer.hostFrame, guest: dropPeer.closed?.frame ?? null },
    reconnectAttempts: hostLines.filter((line) => /initiating reconnect to/.test(line)).length,
    paths,
    window: {
      declaredBy: 'DROP_PEER_MS',
      from: Math.min(dropPeer.hostFrame, dropPeer.closed?.frame ?? dropPeer.hostFrame) - HASH_LAG,
      to,
      stoppedPage: null,
      stoppedMs: null,
      proven,
    },
    framesExcluded: 0,
    mismatchesExcluded: 0,
  };
})();
const dropWindows = dropPeerReport ? [dropPeerReport.window] : [];
// DELAY_SYNC_ANSWER_MS: the held answer, the guest's deadline and second
// request, and which of the rules for a late answer took it.
const delaySyncAnswerReport = (() => {
  if (!DELAY_SYNC_ANSWER_MS || !delaySyncAnswer.guestAt) return null;
  const guestLines = linesAfter(G.sync, delaySyncAnswer.guestAt.seq);
  const hostLines = linesAfter(H.sync, delaySyncAnswer.hostAt.seq);
  const countIn = (lines, re) => lines.filter((line) => re.test(line)).length;
  // The guest's second request (its ask again at the deadline) must come
  // before the held answer's header reaches it, or the answer was not late.
  const asks = guestLines.flatMap((line, i) =>
    /network change detected|BOOT-SYNC: guest requesting|RESYNC-REASK .*: sent/.test(line) ? [i] : [],
  );
  const firstAnswer = guestLines.findIndex((line) => /sync-start received/.test(line));
  // The request is settled only when an answer to the newest one was applied:
  // after the second ask, a `resync ready` whose answerFor is the newest
  // request and ends it, then a `sync #k applied` before any other answer.
  const newestReady =
    asks.length < 2
      ? -1
      : guestLines.findIndex(
          (line, i) => i > asks[1] && /resync ready \(.*answerFor=(\d+) newest=\1 endsRequest=true\)/.test(line),
        );
  const afterReady = newestReady < 0 ? [] : guestLines.slice(newestReady + 1);
  const nextAnswer = afterReady.findIndex((line) => /resync ready \(/.test(line));
  const newestApplied =
    newestReady < 0
      ? null
      : ((nextAnswer < 0 ? afterReady : afterReady.slice(0, nextAnswer)).find((line) =>
          /sync #\d+ applied/.test(line),
        ) ?? null);
  return {
    ms: DELAY_SYNC_ANSWER_MS,
    at: DELAY_SYNC_ANSWER_AT,
    held: H.syncAnswersHeld,
    timedOut: delaySyncAnswer.timedOut,
    timeouts: guestLines.filter((line) => /RESYNC-REQUEST-TIMEOUT/.test(line)),
    askedAgainAfterMs: delaySyncAnswer.askedAgainAfterMs,
    guestAsks: asks.length,
    requestsReceivedByHost: countIn(hostLines, /received sync-request-full from/),
    rateLimited: countIn(hostLines, /rate-limited sync-request/),
    lateAnswerAfterSecondAsk: asks.length >= 2 && firstAnswer > asks[1],
    lateAnswerHandled: {
      'SYNC-LATE-ANSWER-DROPPED': countIn(guestLines, /SYNC-LATE-ANSWER-DROPPED/),
      'SYNC-LATE-ANSWER-IGNORED': countIn(guestLines, /SYNC-LATE-ANSWER-IGNORED/),
      'not the answer awaited': countIn(guestLines, /sync state is not the answer awaited/),
      'chunk timeout for older request': countIn(guestLines, /sync chunks timeout: .* for older request/),
    },
    answers: guestLines.filter((line) =>
      /resync ready \(|sync-start received|not the answer awaited|SYNC-LATE-ANSWER/.test(line),
    ),
    resyncsApplied: countIn(guestLines, /sync #\d+ applied/),
    newestAnswer: newestReady < 0 ? null : guestLines[newestReady],
    newestApplied,
    applied: guestLines.filter((line) => /sync #\d+ applied/.test(line)),
  };
})();
// CATCH_UP_MS: the held answer was the request's own, behind the guest, and
// the guest caught up from it to the frame it was on.
const catchUpReport = (() => {
  if (!CATCH_UP_MS || !catchUp.guestAt) return null;
  const guestLines = linesAfter(G.sync, catchUp.guestAt.seq);
  const catchUps = guestLines.flatMap((line) => {
    const m = line.match(/SYNC-CATCH-UP from=(\d+) to=(\d+) of=(\d+) frames=(\d+) ms=([\d.]+)/);
    return m ? [{ from: +m[1], to: +m[2], of: +m[3], frames: +m[4], ms: +m[5], stopped: /stopped:/.test(line) }] : [];
  });
  return {
    ms: CATCH_UP_MS,
    held: H.syncAnswersHeld,
    catchUps,
    tooOld: guestLines.filter((line) => /SYNC-TOO-OLD-DROPPED/.test(line)),
    answers: guestLines.filter((line) => /resync ready \(|SYNC-LATE-ANSWER/.test(line)),
    applied: guestLines.filter((line) => /sync #\d+ applied/.test(line)),
  };
})();
// Every run: what each engine dropped as off its schema, by the kind it logged.
const droppedIn = (log) =>
  log
    .split('\n')
    .map((line) => line.match(/\[protocol\] dropped ([^:]+):/))
    .filter(Boolean)
    .map((m) => m[1]);
const peerDropped = { host: droppedIn(H.sync), guest: droppedIn(G.sync) };
// MALFORMED_PEER: each page dropped exactly what the other sent, only after it
// was sent and without logging what it was, and went on playing.
const malformedPeerReport = (() => {
  if (!MALFORMED_PEER) return null;
  const side = (log, at, frameAfter, refusedExpected, refusedBy, dropsExpected) => {
    const refused = log
      .split('\n')
      .filter((line) => (at ? seqOf(line) > at.seq : false) && line.includes('state header refused'));
    const refusedOther = refused.filter((line) => !line.includes(refusedBy)).length;
    const lines = log.split('\n').filter((line) => line.includes('[protocol] dropped'));
    const after = at ? lines.filter((line) => seqOf(line) > at.seq) : [];
    const kinds = droppedIn(after.join('\n'));
    const valuesLogged = lines.filter((line) => /zz-/.test(line)).length;
    // Frames played in the ten seconds after the strings arrived. A headless
    // emulator in the cloud container runs at 7-11 fps: 30 is a page still playing.
    const framesAfter = frameAfter - (at?.frame ?? 0);
    return {
      kinds,
      before: lines.length - after.length,
      valuesLogged,
      framesAfter,
      refused: refused.length,
      refusedOther,
      passed:
        !!at &&
        refused.length === refusedExpected &&
        refusedOther === 0 &&
        lines.length === after.length &&
        // In any order: the sync-state channel is not ordered against lockstep.
        JSON.stringify([...kinds].sort()) === JSON.stringify([...dropsExpected].sort()) &&
        valuesLogged === 0 &&
        framesAfter >= MALFORMED_FRAMES_AFTER,
    };
  };
  // The host refuses both of the guest's state headers at its channel gate;
  // the guest refuses nothing (the host's malformed one is dropped by the
  // schema, on the current host's channel).
  const host = side(
    H.sync,
    malformedPeer.hostAt,
    malformedPeer.frameLater[0],
    MALFORMED_HOST_REFUSED,
    MALFORMED_HOST_REFUSED_BY,
    MALFORMED_HOST_DROPS,
  );
  const guest = side(G.sync, malformedPeer.guestAt, malformedPeer.frameLater[1], 0, '', MALFORMED_DROPS);
  return {
    sent: malformedPeer.sent,
    host,
    guest,
    passed: malformedPeer.sent.every(Boolean) && host.passed && guest.passed,
  };
})();
// LOSE_INPUTS_BEFORE_FALLBACK: the transport, the drops and the switch, and
// whether the dropped inputs had to be asked for.
const loseBeforeFallbackReport = (() => {
  if (!LOSE_INPUTS_BEFORE_FALLBACK || !loseBeforeFallback.guestAt) return null;
  const guestLines = linesAfter(G.sync, loseBeforeFallback.guestAt.seq);
  const hostLines = linesAfter(H.sync, loseBeforeFallback.hostAt.seq);
  const linesIn = (lines, re) => lines.filter((line) => re.test(line));
  const lost = [...new Set(H.rbInputsLost)].sort((a, b) => a - b);
  const rearmed = linesIn(hostLines, /rb-transport: host broadcast=unreliable \(knDiag, mid-match\)/);
  const unreliable = {
    host:
      /rb-transport: host broadcast=unreliable/.test(H.sync) &&
      /rb-input DC open .*ordered=false maxRetransmits=0/.test(H.sync),
    guest: /rb-transport: host=unreliable adopted=unreliable/.test(G.sync),
  };
  const firstRearm = hostLines.findIndex((line) =>
    /rb-transport: host broadcast=unreliable \(knDiag, mid-match\)/.test(line),
  );
  const fallback =
    firstRearm < 0 ? null : (hostLines.slice(firstRearm).find((line) => /DC-FALLBACK reason=/.test(line)) ?? null);
  const exercised = unreliable.host && unreliable.guest && rearmed.length > 0 && lost.length >= 2 && !!fallback;
  const after = {
    guestAsksForHostInputs: linesIn(guestLines, /RB-INPUT-ASK .*slot=0\b/),
    peerPhantoms: [...linesIn(hostLines, /PEER-PHANTOM/), ...linesIn(guestLines, /PEER-PHANTOM/)],
    stallTimeouts: [...linesIn(hostLines, /RB-INPUT-STALL-TIMEOUT/), ...linesIn(guestLines, /RB-INPUT-STALL-TIMEOUT/)],
  };
  return {
    unreliable,
    rounds: loseBeforeFallback.rounds,
    rearmed: rearmed.length,
    dropped: H.rbInputsLost.length,
    framesLost: lost.length ? { first: lost[0], last: lost.at(-1), count: lost.length } : null,
    fallback,
    hostFallbackLines: linesIn(hostLines, /DC-FALLBACK/),
    guestFallbackLines: linesIn(guestLines, /DC-FALLBACK/),
    exercised,
    ...after,
    passed: exercised && Object.values(after).every((lines) => lines.length === 0),
  };
})();
// UNANSWERED_SOCKET_RESYNC: the chunk timeout and the guard it armed, the
// dropped answers, the guard's timeout, the second ask again and the state
// applied after it, in that order.
const unansweredSocketResyncReport = (() => {
  if (!UNANSWERED_SOCKET_RESYNC || !unansweredSocketResync.guestAt) return null;
  const guestLines = linesAfter(G.sync, unansweredSocketResync.guestAt.seq);
  const at = (re, from = 0) => {
    const i = guestLines.slice(from).findIndex((line) => re.test(line));
    return i < 0 ? -1 : from + i;
  };
  const chunkTimeout = at(/sync chunks timeout: /);
  const guardArmed = at(/sync-chunk-timeout: lifecycle resync guard armed/);
  const guardTimedOut = at(/lifecycle resync guard timeout: lifecycle resync guard cleared/, Math.max(0, guardArmed));
  const secondAsk = at(/RESYNC-REASK .*ask=2\/2/, Math.max(0, guardTimedOut));
  const appliedAfter = secondAsk < 0 ? -1 : at(/sync #\d+ applied/, secondAsk);
  const line = (i) => (i < 0 ? null : guestLines[i]);
  const giveUp = at(/RESYNC-REASK-GIVEUP/);
  const ignoredAt = at(/SYNC-LATE-ANSWER-IGNORED/);
  const appliedAfterIgnored = ignoredAt < 0 ? -1 : at(/sync #\d+ applied/, ignoredAt);
  const letGo = at(/RESYNC-REQUEST-TIMEOUT .*step=letGo/);
  const recoveryDeadline = at(/RESYNC-REQUEST-TIMEOUT .*step=askAgain/);
  const recoveryAskAgain = recoveryDeadline < 0 ? -1 : at(/RESYNC-REASK /, recoveryDeadline);
  const appliedAfterAskAgain = recoveryAskAgain < 0 ? -1 : at(/sync #\d+ applied/, recoveryAskAgain);
  const recoveryAsk = at(/peer-recovery resync: sent sync-request-full-at:/);
  const appliedBefore = (end) => guestLines.slice(0, end).filter((l) => /sync #\d+ applied/.test(l)).length;
  const asksAfter = (from) => guestLines.slice(from + 1).filter((l) => /RESYNC-REASK /.test(l)).length;
  // I1: the guest made frames after the fault (frames in the 5 s that followed).
  const ticking = unansweredSocketResync.framesAfter >= 10;
  const variantPassed =
    UNANSWERED_VARIANT === 'giveup'
      ? giveUp >= 0 && appliedBefore(giveUp) === 0 && asksAfter(giveUp) === 0 && ticking
      : UNANSWERED_VARIANT === 'letgo'
        ? recoveryAsk >= 0 &&
          H.syncAnswersDropped.some((d) => d.drop === 'whole') &&
          recoveryDeadline > recoveryAsk &&
          appliedBefore(recoveryDeadline) === appliedBefore(recoveryAsk) &&
          recoveryAskAgain > recoveryDeadline &&
          appliedAfterAskAgain > recoveryAskAgain &&
          letGo < 0 &&
          ticking
        : UNANSWERED_VARIANT === 'ignored'
          ? H.syncAnswersDropped.some((d) => d.drop === 'chunks') &&
            G.socketAnswersHeld.some((h) => h.releasedAt !== null) &&
            ignoredAt >= 0 &&
            appliedAfterIgnored > ignoredAt &&
            ticking
          : null;
  return {
    variant: UNANSWERED_VARIANT,
    ignored: line(ignoredAt),
    appliedAfterIgnored: line(appliedAfterIgnored),
    socketAnswersHeld: G.socketAnswersHeld,
    workerResultsHeld: G.workerResultsHeld,
    giveUp: line(giveUp),
    letGo: line(letGo),
    recoveryDeadline: line(recoveryDeadline),
    recoveryAskAgain: line(recoveryAskAgain),
    appliedAfterAskAgain: line(appliedAfterAskAgain),
    recoveryAsk: line(recoveryAsk),
    framesAfter: unansweredSocketResync.framesAfter,
    syncAnswersDropped: H.syncAnswersDropped,
    socketAnswersDropped: H.socketAnswersDropped,
    chunkTimeout: line(chunkTimeout),
    guardArmed: line(guardArmed),
    guardTimedOut: line(guardTimedOut),
    secondAsk: line(secondAsk),
    appliedAfter: line(appliedAfter),
    timeouts: guestLines.filter((l) => /RESYNC-REQUEST-TIMEOUT/.test(l)),
    asksAgain: guestLines.filter((l) => /RESYNC-REASK/.test(l)),
    applied: guestLines.filter((l) => /sync #\d+ applied/.test(l)),
    passed:
      variantPassed ??
      (chunkTimeout >= 0 &&
        guardArmed >= 0 &&
        H.socketAnswersDropped.length >= 1 &&
        H.syncAnswersDropped.some((d) => d.drop === 'whole') &&
        guardTimedOut > guardArmed &&
        secondAsk > guardTimedOut &&
        appliedAfter > secondAsk &&
        ticking),
  };
})();
// DOUBLE_RESYNC_ASK: the rate-limited second request, the dropped late
// answer, the deadline and the ask again, and the state applied after.
const doubleResyncAskReport = (() => {
  if (!DOUBLE_RESYNC_ASK || !doubleResyncAsk.guestAt) return null;
  const guestLines = linesAfter(G.sync, doubleResyncAsk.guestAt.seq);
  const hostLines = linesAfter(H.sync, doubleResyncAsk.hostAt.seq);
  const countIn = (lines, re) => lines.filter((line) => re.test(line)).length;
  return {
    guestAsks: countIn(guestLines, /network change detected/),
    requestsReceivedByHost: countIn(hostLines, /received sync-request-full from/),
    rateLimited: countIn(hostLines, /rate-limited sync-request/),
    lateAnswerDropped: countIn(guestLines, /SYNC-LATE-ANSWER-DROPPED/),
    timeouts: guestLines.filter((line) => /RESYNC-REQUEST-TIMEOUT/.test(line)),
    asksAgain: guestLines.filter((line) => /RESYNC-REASK /.test(line)),
    gaveUp: countIn(guestLines, /RESYNC-REASK-GIVEUP/),
    answers: guestLines.filter((line) => /resync ready \(|SYNC-LATE-ANSWER|not the answer awaited/.test(line)),
    applied: guestLines.filter((line) => /sync #\d+ applied/.test(line)),
  };
})();
// RESYNC_ONE_BACK: the reset must be one frame back onto the answer's frame.
// RESYNC_SAME_FRAME: no reset, the state applied at the answer's frame after
// kn_pre_tick saved it.
const resyncOneBackReport = (() => {
  if (!RESYNC_FAULT || !resyncOneBack.guestAt) return null;
  const guestLines = linesAfter(G.sync, resyncOneBack.guestAt.seq);
  return {
    ordering: RESYNC_FAULT,
    ...resyncOneBack.page,
    reset: oneBackReset,
    landed: resyncFaultLanded,
    applied: guestLines.filter((line) => /sync #\d+ applied/.test(line)),
    comparedFrom: recoveredAt,
  };
})();
// Every state the guest applied (resyncExtrasProbeInitScript): its hidden
// words, fingerprint and HLE state once the apply step is done, against the
// host's as it read that state. A state carries kn_sync_read's bytes and,
// beside them, the hidden words and HLE state; any difference here is one the
// resync left behind.
const resyncExtrasReport = (() => {
  const reads = H.resyncExtras?.reads ?? [];
  const applies = G.resyncExtras?.applies ?? [];
  const same = (r, a) => r.fp === a.fp && r.hle === a.hle && JSON.stringify(r.words) === JSON.stringify(a.words);
  const compared = [];
  const unmatched = [];
  for (const a of applies) {
    const atFrame = reads.filter((r) => r.frame === a.frame);
    if (!atFrame.length) {
      unmatched.push(a.frame);
      continue;
    }
    const r = atFrame.find((x) => same(x, a)) ?? atFrame.at(-1);
    compared.push({
      frame: a.frame,
      equal: same(r, a),
      fp: r.fp === a.fp ? null : { host: r.fp, guest: a.fp },
      hle: r.hle === a.hle ? null : { host: r.hle, guest: a.hle },
      words: (r.words ?? []).flatMap((w, i) => (w === a.words?.[i] ? [] : [{ i, host: w, guest: a.words?.[i] }])),
    });
  }
  return {
    probed: { host: !!H.resyncExtras?.wrapped, guest: !!G.resyncExtras?.wrapped },
    modules: { host: H.resyncExtras?.modules ?? 0, guest: G.resyncExtras?.modules ?? 0 },
    stillWrapped: { host: !!H.resyncExtras?.stillWrapped, guest: !!G.resyncExtras?.stillWrapped },
    hostReads: reads.length,
    guestApplies: applies.length,
    hleBytes: reads[0]?.hleBytes ?? applies[0]?.hleBytes ?? null,
    compared: compared.length,
    unmatched,
    mismatched: compared.filter((c) => !c.equal),
  };
})();
// DESYNC_GUEST holds its change for 3 s. A rollback in that time re-runs
// frames from before the change with the change already in memory, so the
// hashes and digests of up to a rollback window of earlier frames (the
// engine's rollbackMax, 22 in practice) carry it too. Those belong to the change.
const DESYNC_REACHES_BACK_FRAMES = ROLLBACK_MAX || 22;
const battleFrom = Math.max(H.inBattleAt, G.inBattleAt);
// Frames one page read and the other has no hash for, or read as 0 (not in
// its ring then): not compared, but counted, over the frames compared.
const unrecorded = { host: { missing: 0, zero: 0 }, guest: { missing: 0, zero: 0 } };
for (const f of new Set([...Object.keys(H.hashes), ...Object.keys(G.hashes)])) {
  const a = H.hashes[f],
    b = G.hashes[f];
  if (+f < recoveredAt || +f >= compareUntil) continue;
  if (!a || !b || !a[0] || !b[0]) {
    for (const [side, h] of [
      ['host', a],
      ['guest', b],
    ])
      if (!h) unrecorded[side].missing++;
      else if (!h[0]) unrecorded[side].zero++;
    continue;
  }
  if (inFrozenRecovery(dropWindows, +f)) {
    dropPeerReport.framesExcluded++;
    if (a[0] !== b[0] || a[2] !== b[2]) dropPeerReport.mismatchesExcluded++;
    continue;
  }
  if (inFrozenRecovery(recoveries, +f)) {
    framesExcluded++;
    if (a[0] !== b[0] || a[2] !== b[2]) mismatchesExcluded++;
    continue;
  }
  both++;
  if (battleFrom > 0 && +f >= Math.max(battleFrom, recoveredAt)) battleCompared++;
  if (a[0] !== b[0]) {
    gpMis++;
    if (firstGp === null) firstGp = +f;
    // DESYNC_GUEST: the hash must differ because of the change, so only
    // frames from the change on count, and none may differ before it.
    if (DESYNC_GUEST && desyncGuestAt >= 0) {
      if (+f >= desyncGuestAt - DESYNC_REACHES_BACK_FRAMES) gpMisAfterDesync++;
      else gpMisBeforeDesync++;
    }
  }
  if (a[1] !== b[1]) {
    fullMis++;
    if (firstFull === null) firstFull = +f;
  }
  if (a[2] !== b[2]) {
    gsMis++;
    if (firstGs === null) firstGs = +f;
  }
}
const count = (log, re) => (log.match(re) || []).length;
const bootInputStallTimeoutsOf = (log) =>
  [...log.matchAll(/RB-INPUT-STALL-TIMEOUT f=(\d+)/g)].filter(([, frame]) => +frame < 300).length;
const INTEGRITY =
  /REPLAY-NORUN|RB-INVARIANT-VIOLATION|FATAL-RING-STALE|RB-LIVE-MISMATCH|STEP-THREW|FATAL-CORE-ABORT|FAILED-ROLLBACK|DEEP-MISPREDICT-SKIP|RESTORE-FAILED/g;
const bad = (log) => count(log, INTEGRITY);
const delayOf = (log) => (log.match(/kn_rollback_init: max=\d+ delay=(\d+)/) || [])[1]; // what the engine uses

// HIDE_GUEST_MS mode (issues #64/#69): unlike FREEZE mode, there is no exclusion
// window — a backgrounded-then-returned guest must never desync the match,
// so any of these events anywhere in either peer's sync log is a failure.
const tickStuckErrorsOf = (log) => count(log, /TICK-STUCK severity=error/g);
const peerPhantomsOf = (log) => count(log, /PEER-PHANTOM/g);
const rbInputStallTimeoutsOf = (log) => count(log, /RB-INPUT-STALL-TIMEOUT/g);
// The run must actually exercise the fix, not just avoid tripping on a
// no-op path: the guest's sync log must show it went through the real
// bg-return handler ("tab visible (was background") and that
// _noteLifecycleReturn skipped fast-forward/resync ("rollback mode — no
// fast-forward/resync").
// Their absence means the hide/throttle/visibilitychange plumbing didn't
// reach netplay-rollback.js, and a pass wouldn't mean anything.
const guestExercisedTabVisible = (log) => log.includes('tab visible (was background');
const guestExercisedRollbackSkip = (log) => log.includes('rollback mode — no fast-forward/resync');
// Same reasoning for SUSPEND_GUEST_AUDIO: a pass where the guest never hit
// the boot-audio-stall watchdog at all (fix path unexercised) wouldn't mean
// anything either.
const guestExercisedStandInClock = (log) => log.includes('stand-in audio clock installed');

// Game fps over the measurement window (see MIN_GAME_FPS doc above): frames
// advanced (last non-replay _kn_post_tick frame) / wall seconds, per peer.
const gameFpsOf = (peer) => {
  const start = peer.fpsWindowStart;
  const end = peer.fpsWindowEnd;
  if (!start || !end || end.t <= start.t) return null;
  return +(((end.f - start.f) * 1000) / (end.t - start.t)).toFixed(1);
};
const gameFps = { host: gameFpsOf(H), guest: gameFpsOf(G) };

// Pacing episodes within the measurement window, from the unsampled
// per-300-frame `PACING f=...` summary lines (#47) in each peer's own sync
// log (t is that page's performance.now(), same clock as fpsWindowStart) —
// not the `PACING-THROTTLE start/end` lines, which are rate-limited to 1/s
// and so miss most episodes on a busy peer. Each summary line's
// capsCount/capsFrames cover the 300 frames preceding it.
const pacingInWindow = (peer) => {
  const start = peer.fpsWindowStart;
  if (!start) return null;
  const lines = peer.sync.split('\n').filter((l) => {
    if (!l.includes('PACING f=')) return false;
    const t = parseFloat(l.split('\t')[1]);
    return Number.isFinite(t) && t >= start.t;
  });
  let capsCount = 0,
    capsFrames = 0;
  for (const l of lines) {
    const m = l.match(/capsCount=(\d+) capsFrames=(\d+)/);
    if (m) {
      capsCount += +m[1];
      capsFrames += +m[2];
    }
  }
  return { capsCount, capsFrames, summaries: lines.length };
};
const pacing = { host: pacingInWindow(H), guest: pacingInWindow(G) };

// Cumulative scheduler counters from the last TICK-PERF line (#47):
// droppedSlots (backlog drops) and catchupFrames (extra forward frames run
// to catch up a throttled pump) — never reset, so this is the session
// total, not scoped to the fps window.
const lastTickPerf = (log) => {
  const matches = [...log.matchAll(/TICK-PERF f=(\d+).*?droppedSlots=(\d+) catchupFrames=(\d+)/g)];
  if (!matches.length) return null;
  const m = matches[matches.length - 1];
  return { f: +m[1], droppedSlots: +m[2], catchupFrames: +m[3] };
};
const schedulerCounters = { host: lastTickPerf(H.sync), guest: lastTickPerf(G.sync) };
// Finalized battle frames both peers could have hashed (each page's hashing
// trails its head by its lag); coverage below 80% means the comparison
// proves little. Every frame of the span counts, so a frame either page left
// without a hash (missing, or 0: not in its ring when read) lowers it, and
// those frames are counted per page in battleUnrecorded.
const spanFrom = Math.max(battleFrom, recoveredAt);
const lastReadOf = (peer) => (peer.lastR ?? peer.frame) - (lagOf(peer) ?? 0);
const spanTo = Math.min(lastReadOf(H), lastReadOf(G), compareUntil - 1);
const battleSpan = battleFrom > 0 ? spanTo - spanFrom + 1 : 0;
const battleCoverage = battleSpan > 0 ? Math.min(1, battleCompared / battleSpan) : 0;
const battleUnrecorded =
  battleSpan > 0
    ? { host: unrecordedIn(H.hashes, spanFrom, spanTo), guest: unrecordedIn(G.hashes, spanFrom, spanTo) }
    : null;
// COMPARE_HASH_LAG: the frames read at that lag, compared as the run's own
// are (same exclusions), and how many of those that differ agree at the
// run's own lag: a difference there was a frame a rollback rewrote after it
// was read.
let earlyLagCompare = null;
if (COMPARE_HASH_LAG) {
  const e = { lag: COMPARE_HASH_LAG, framesCompared: 0, gameplayMismatches: 0, gameStateMismatches: 0 };
  e.mismatchesAgreeingAtRunLag = 0;
  e.mismatchesStillDifferingAtRunLag = 0;
  e.mismatchesNotComparedAtRunLag = 0;
  for (const f of Object.keys(H.early ?? {})) {
    const a = H.early[f],
      b = G.early?.[f];
    if (!b || !a[0] || !b[0] || +f < recoveredAt || +f >= compareUntil) continue;
    if (inFrozenRecovery(dropWindows, +f) || inFrozenRecovery(recoveries, +f)) continue;
    e.framesCompared++;
    const gp = a[0] !== b[0],
      gs = a[1] !== b[1];
    if (gp) e.gameplayMismatches++;
    if (gs) e.gameStateMismatches++;
    if (!gp && !gs) continue;
    const x = H.hashes[f],
      y = G.hashes[f];
    if (!x || !y || !x[0] || !y[0]) e.mismatchesNotComparedAtRunLag++;
    else if (x[0] === y[0] && x[2] === y[2]) e.mismatchesAgreeingAtRunLag++;
    else e.mismatchesStillDifferingAtRunLag++;
  }
  earlyLagCompare = e;
}

// Visual check: decode both peers' downscaled canvas captures and diff
// frames present on both sides at the same frame number — mean absolute
// difference over all RGB bytes of the 48x36 signature (sum(|h[i]-g[i]|)
// over all 5184 bytes, divided by 5184). Baseline (matching render) is a
// few points; noise up to the low 30s is expected and not a bug: headless
// replay intentionally holds the last presented frame during a rollback
// (see RB_FULL_HEADLESS_DURING_REPLAY in netplay-rollback.js), so a frame
// captured right at catch-up can legitimately show the pre-rollback picture
// on one peer (e.g. a character still on the respawn platform) while the
// other has already moved on — a held-frame/capture-timing difference, not
// corruption. An independent census across old-core and fixed-core runs
// found a clean gap: held/timing noise topped out at 30.8, corruption (the
// #43 GLSM-state bug — vanished stage geometry/fighters, a stray polygon)
// started at 40 and ran up to 74.3, with zero frames in between (31-40).
// 40 is therefore the corruption cutoff; frames above 15 but at or below 40
// are reported informationally (heldOrTimingDiffs) and do not fail the run.
let visualCheck = null;
if (VISUAL_CHECK) {
  const decode = (v) => {
    const map = new Map();
    if (!v) return map;
    const buf = Buffer.from(v.b64, 'base64');
    let off = 0;
    for (const f of v.frames) {
      map.set(f, buf.subarray(off, off + v.frameBytes));
      off += v.frameBytes;
    }
    return map;
  };
  const hMap = decode(H.visual),
    gMap = decode(G.visual);
  const replayEndFrames = new Set();
  for (const m of H.sync.matchAll(/C-REPLAY done: caught up at f=(\d+)/g)) {
    const n = +m[1];
    replayEndFrames.add(n);
    replayEndFrames.add(n + 1);
  }
  const CORRUPT_THRESHOLD = 40;
  const HELD_OR_TIMING_THRESHOLD = 15;
  let framesCompared = 0,
    corrupted = 0,
    corruptedNearReplayEnd = 0,
    firstCorrupted = null,
    heldOrTimingDiffs = 0,
    maxDiff = 0;
  let windowFramesExcluded = 0;
  for (const [f, hb] of hMap) {
    const gb = gMap.get(f);
    if (!gb || f < recoveredAt || f >= compareUntil) continue;
    // The proven windows the hash compare leaves out (a frozen-page recovery,
    // a DROP_PEER_MS reconnect): the peers' pictures differ there by design too.
    if (inFrozenRecovery([...recoveries, ...dropWindows], f)) {
      windowFramesExcluded++;
      continue;
    }
    framesCompared++;
    let sum = 0;
    for (let i = 0; i < hb.length; i++) sum += Math.abs(hb[i] - gb[i]);
    const mean = sum / hb.length;
    if (mean > maxDiff) maxDiff = mean;
    if (mean > CORRUPT_THRESHOLD) {
      corrupted++;
      if (firstCorrupted === null) firstCorrupted = f;
      if (replayEndFrames.has(f)) corruptedNearReplayEnd++;
    } else if (mean > HELD_OR_TIMING_THRESHOLD) {
      heldOrTimingDiffs++;
    }
  }
  visualCheck = {
    framesCompared,
    framesExcluded: windowFramesExcluded,
    corrupted,
    corruptedNearReplayEnd,
    firstCorrupted,
    heldOrTimingDiffs,
    maxDiff: +maxDiff.toFixed(2),
  };
}

// ADDRESS_MAP_CHECK: what one peer read through the map, judged against
// what the game must have been doing. Each check is {name, ok, detail}.
const addressMapChecksOf = (side) => {
  if (!side.mapRom)
    return [{ name: 'the ROM has an address map', ok: false, detail: 'KNCore.addressMapFor gave none' }];
  const samples = side.mapSamples;
  const scenes = side.mapScenes;
  const atSelect = samples.filter((x) => x.scene === scenes.characterSelect);
  const inBattle = samples.filter((x) => x.scene === scenes.battle);
  const lastSelect = atSelect.at(-1);
  const underWayFrom = inBattle.findIndex((x) => x.status === side.mapOngoing);
  const strict = MENU_AUTOPILOT !== 'any-fighter';
  const inRam = (x) => x.ftPtr >>> 24 === 0x80 && (x.ftPtr & 0xffffff) + x.ftBufferSize <= 0x800000;
  const checks = [
    {
      name: 'scene reads the character select, then the battle',
      ok: atSelect.length > 0 && inBattle.length > 0 && atSelect[0].f < inBattle[0].f,
      detail: `${atSelect.length} samples at scene ${scenes.characterSelect}, ${inBattle.length} at ${scenes.battle}; scenes seen ${[...new Set(samples.map((x) => x.scene))].join(',')}`,
    },
    {
      name: strict
        ? "character ids are the autopilot's picks (Mario 0, Donkey Kong 2)"
        : 'character ids are fighter kinds',
      ok:
        !!lastSelect &&
        (strict ? lastSelect.charIds.join() === '0,2' : lastSelect.charIds.every((id) => id !== null && id < 64)),
      detail: lastSelect
        ? `P1,P2 = ${lastSelect.charIds.join(',')} at frame ${lastSelect.f}`
        : 'no sample at the character select',
    },
    {
      // A dormant copy of the battle state has everything in range and
      // never says a match is on; this is the check that tells them apart.
      // The scene opens on the countdown, before the status changes.
      name: 'the battle header says the match gets under way and stays so',
      ok: underWayFrom >= 0 && inBattle.slice(underWayFrom).every((x) => x.status === side.mapOngoing),
      detail:
        underWayFrom < 0
          ? `status never read ${side.mapOngoing}; values seen ${[...new Set(inBattle.map((x) => x.status))].join(',')}`
          : `status ${side.mapOngoing} from battle sample ${underWayFrom + 1} of ${inBattle.length} on`,
    },
    {
      // The game's own pointer to the battle state it runs from names the
      // mapped one. In SSB64 it is moved to the other copy only for a
      // sudden death, which this run never reaches.
      name: "the game's battle-state pointer names the mapped battle state",
      ok: underWayFrom >= 0 && inBattle.slice(underWayFrom).every((x) => x.pointer === side.mapLiveHeaderPointer),
      detail: `values seen: ${[...new Set(inBattle.slice(Math.max(0, underWayFrom)).map((x) => (x.pointer ?? 0).toString(16)))].slice(0, 4).join(' ')}`,
    },
    {
      name: 'stock counts in battle are plausible',
      ok: inBattle.length > 0 && inBattle.every((x) => x.stocks.every((n) => n !== null && n <= 98)),
      detail: `P1,P2 values seen: ${[...new Set(inBattle.map((x) => x.stocks.join('/')))].slice(0, 6).join(' ')}`,
    },
    {
      name: 'the battle header is not empty',
      ok: inBattle.length > 0 && inBattle.every((x) => x.headerNonZero),
      detail: `${inBattle.filter((x) => x.headerNonZero).length} of ${inBattle.length} battle samples non-zero`,
    },
    {
      name: 'the RNG seed moves',
      // Three, not more: on a slow machine most battle samples are the
      // countdown, where the game hardly draws from it. An address that is
      // not the seed reads one value throughout.
      ok: new Set(inBattle.map((x) => x.rng)).size >= Math.min(3, inBattle.length),
      detail: `${new Set(inBattle.map((x) => x.rng)).size} distinct values in ${inBattle.length} battle samples`,
    },
    {
      // Null while the battle scene is still loading; once set it must be
      // an address whose buffer lies inside RAM.
      name: 'the fighter-buffer pointer, once set, points into RAM',
      ok: inBattle.some((x) => x.ftPtr) && inBattle.filter((x) => x.ftPtr).every(inRam),
      detail: `values seen: ${[...new Set(inBattle.map((x) => (x.ftPtr ?? 0).toString(16)))].slice(0, 4).join(' ')}`,
    },
  ];
  return checks;
};

const taintCoverage = (side) => (Number.isInteger(side.taintedBlocks) ? 128 - side.taintedBlocks : null);

// DESYNC_GUEST: the detector's cross-peer flags in one peer's sync log, split
// at the frame the guest was desynced.
const desyncFlagsOf = (log) => {
  const flags = [...log.matchAll(/KNDesync suspect frame=(\d+) field=(\w+) slot=(\w+) trigger=flag/g)].map((m) => ({
    frame: Number(m[1]),
    field: m[2],
    slot: m[3],
  }));
  const after = flags.filter((f) => f.frame >= desyncGuestAt - DESYNC_REACHES_BACK_FRAMES);
  // A page the container froze splits the two timelines until the resync;
  // the detector is right to flag those frames, and they are not the change.
  const inRecovery = flags.filter((f) => inFrozenRecoveryAftermath(recoveries, f.frame)).length;
  return {
    before: flags.length - after.length - inRecovery,
    inFrozenRecovery: inRecovery,
    after: after.length,
    // The change is to P1's stock count: slot 0, and no other player's.
    stocksAfter: after.filter((f) => f.field === 'stocks' && f.slot === '0').length,
    firstAfter: after[0] ?? null,
    fields: [...new Set(after.map((f) => f.field))],
    // The frame this peer screenshot for each flagged frame: suspect -> capture.
    captures: Object.fromEntries(
      [...log.matchAll(/KNDesync capture frame=(\d+) suspect=(\d+) field=stocks slot=0/g)].map((m) => [
        m[2],
        Number(m[1]),
      ]),
    ),
  };
};

const signalingDropOf = (page, events, log) => {
  // Stalls are counted from the log line the outage began after; the ones
  // before it are reported beside them and do not fail the run.
  const outageAt = signaling.get(page)?.outageAt ?? { seq: 0, frame: 0 };
  const seqOf = (line) => Number(line.split('\t')[0]);
  const lines = log.split('\n');
  const sinceOutage = lines.filter((line) => seqOf(line) > outageAt.seq).join('\n');
  const beforeOutage = lines.filter((line) => seqOf(line) <= outageAt.seq).join('\n');
  return {
    reconnectsAfterOutage:
      events.filter((e) => e.type === 'reconnect').length - (signaling.get(page)?.reconnectsBefore ?? 0),
    lifecycleReports: events.filter((e) => e.type === 'session-disagree' || e.type === 'late-join-stranded'),
    outageFrame: outageAt.frame,
    tickStuck: count(sinceOutage, /TICK-STUCK/g),
    tickStuckBeforeOutage: count(beforeOutage, /TICK-STUCK/g),
    // The lockstep-path stall (waiting on a peer's input), not the rollback engine's routine RB-INPUT-STALL.
    inputStalls: count(sinceOutage, /(?<!RB-)INPUT-STALL (start|hard-timeout)/g),
    // The rollback engine gave up waiting on a peer's input (not its routine RB-INPUT-STALL pacing).
    rbStallTimeouts: count(sinceOutage, /RB-INPUT-STALL-TIMEOUT/g),
    meshHeals: count(log, /MESH-HEAL/g),
  };
};

// Rollback-integrity reports made while a proven frozen-page recovery was
// under way are part of it (tests/frozen-recovery.mjs). A sync-log line has
// its frame in the third column; a C-log line names the frame it concerns;
// one with no frame is never excused.
const frameOfSyncLine = (line) => Number((line.split('\t')[2] || '').replace('f=', ''));
const frameOfCLine = (line) => Number((line.match(/myF=(\d+)/) || line.match(/\bf=(\d+)/) || [])[1]);
const excusedIn = (windows, log, frameOf, weigh) =>
  log
    .split('\n')
    .filter((line) => inFrozenRecoveryAftermath(windows, frameOf(line)))
    .reduce((sum, line) => sum + weigh(line), 0);
// The same for the split a DROP_PEER_MS reconnect makes (its windows).
const integrityExcusedIn = (windows) => ({
  integrityEventsExcluded:
    excusedIn(windows, H.sync, frameOfSyncLine, bad) +
    excusedIn(windows, G.sync, frameOfSyncLine, bad) +
    excusedIn(windows, H.clog, frameOfCLine, bad) +
    excusedIn(windows, G.clog, frameOfCLine, bad),
  // The engine's own counter has no frames; the sync log says when it rose.
  failedRollbacksExcluded: [H.sync, G.sync].reduce(
    (sum, log) =>
      sum +
      excusedIn(windows, log, frameOfSyncLine, (line) =>
        Number((line.match(/FAILED-ROLLBACK detected: \+(\d+)/) || [])[1] || 0),
      ),
    0,
  ),
});
const recoveryIntegrity = integrityExcusedIn(recoveries);
const dropIntegrity = integrityExcusedIn(dropWindows);
if (dropPeerReport) Object.assign(dropPeerReport, dropIntegrity);
// What the pass/fail rule subtracts: the reports inside any proven window,
// each counted once. The two counts above are for reporting only; a report
// inside both a recovery and the drop window is in each of them, and
// subtracting both would cancel a real report outside either window.
const excusedIntegrity = integrityExcusedIn([...recoveries, ...dropWindows]);

// LINK_KBPS: what the capped link did, and what followed the fault (the
// DELAY_SYNC_ANSWER_MS request, or the plain resync): a skipped rollback
// after it, outside a proven frozen-page recovery, is the desync this mode
// exists to catch. The integrity rule above already fails on it anywhere in
// the run; this names it.
const linkReport = (() => {
  if (!(LINK_KBPS > 0)) return null;
  const at = DELAY_SYNC_ANSWER_MS > 0 ? delaySyncAnswer : linkResync;
  const linkOf = (peer, starved) => {
    const st = peer.link?.stats;
    if (!st) return null;
    return {
      messages: st.messages,
      bytesQueued: st.bytes,
      maxBacklogBytes: st.maxBacklogBytes,
      byLabel: Object.fromEntries(
        Object.entries(st.byLabel).map(([label, l]) => [
          label,
          { messages: l.messages, bytes: l.bytes, maxQueueMs: Math.round(l.maxQueueMs), starved: l.starved },
        ]),
      ),
      inputsStarvedFrames: starved,
      unmappedChannels: peer.link.unmappedChannels,
    };
  };
  const afterFault = (peer, pageAt) => {
    if (!pageAt) return null;
    const lines = linesAfter(peer.sync, pageAt.seq);
    const unexcused = (line) => !inFrozenRecoveryAftermath(recoveries, frameOfSyncLine(line));
    const deepSync = lines.filter((line) => /DEEP-MISPREDICT-SKIP/.test(line));
    const deepC = peer.clog
      .split('\n')
      .filter((line) => /DEEP-MISPREDICT-SKIP/.test(line) && !(frameOfCLine(line) < pageAt.frame));
    return {
      fromFrame: pageAt.frame,
      peerPhantoms: lines.filter((line) => /PEER-PHANTOM/.test(line)).length,
      deepMispredictSkips: {
        syncLog: deepSync.length,
        syncLogUnexcused: deepSync.filter(unexcused).length,
        cLog: deepC.length,
        cLogUnexcused: deepC.filter((line) => !inFrozenRecoveryAftermath(recoveries, frameOfCLine(line))).length,
      },
      syncSendStalled: lines.filter((line) => /SYNC-SEND-STALLED/.test(line)).length,
      dcFallbacks: lines.filter((line) => /DC-FALLBACK/.test(line)).length,
      phantomLines: lines.filter((line) => /PEER-PHANTOM/.test(line)).slice(0, 4),
      firstDeepMispredictSkip: deepSync[0] ?? deepC[0] ?? null,
    };
  };
  return {
    kbps: LINK_KBPS,
    plainResync: LINK_RESYNC ? { applied: linkResync.applied } : null,
    host: linkOf(H, linkStarvedFrames.host),
    guest: linkOf(G, linkStarvedFrames.guest),
    afterFault: { host: afterFault(H, at.hostAt), guest: afterFault(G, at.guestAt) },
    recoveriesLinkStarved: recoveries.filter((recovery) => recovery.linkStarved).length,
  };
})();

const summary = {
  room,
  mode: MODE,
  // Lockstep: each page logged that it predicts nothing, and how often a
  // missing input was given up on (each drops the other player).
  ...(MODE === 'lockstep'
    ? {
        lockstep: {
          predictionsOff: {
            host: H.sync.includes('LOCKSTEP mode: predictions off'),
            guest: G.sync.includes('LOCKSTEP mode: predictions off'),
          },
          infoMode: { host: H.infoMode, guest: G.infoMode },
          waitTimeouts: {
            host: (H.sync.match(/LOCKSTEP-WAIT-TIMEOUT/g) || []).length,
            guest: (G.sync.match(/LOCKSTEP-WAIT-TIMEOUT/g) || []).length,
          },
        },
      }
    : {}),
  ...(ADDRESS_MAP_CHECK
    ? { addressMapCheck: { rom: H.mapRom, host: addressMapChecksOf(H), guest: addressMapChecksOf(G) } }
    : {}),
  ...(DESYNC_GUEST
    ? {
        desyncGuest: {
          atFrame: desyncGuestAt,
          gameplayMismatches: { before: gpMisBeforeDesync, after: gpMisAfterDesync },
          host: desyncFlagsOf(H.sync),
          guest: desyncFlagsOf(G.sync),
        },
      }
    : {}),
  observers,
  ...(DROP_SIGNALING_MS
    ? {
        signalingDrop: {
          ms: DROP_SIGNALING_MS,
          host: signalingDropOf(host, hostEvents, H.sync),
          guest: signalingDropOf(guest, guestEvents, G.sync),
        },
      }
    : {}),
  latencyMs: LAT,
  jitterMs: JITTER,
  ...(FREEZE_MS > 0
    ? { freezeHostMs: FREEZE_HOST_MS, freezeGuestMs: FREEZE_GUEST_MS, guestResyncs: resyncs, comparedFrom: recoveredAt }
    : {}),
  ...(HOST_BROWSER !== 'chromium' || GUEST_BROWSER !== 'chromium'
    ? { hostBrowser: HOST_BROWSER, guestBrowser: GUEST_BROWSER, crossEngine, ...(crossEngine ? { bootSyncFrame } : {}) }
    : {}),
  ...(THROTTLE_GUEST ? { throttleGuest: true, throttleGuestHz: THROTTLE_GUEST_HZ, throttleFlipped } : {}),
  ...(HIDE_GUEST_MS > 0
    ? {
        hideGuest: {
          hideGuestMs: HIDE_GUEST_MS,
          frozen: HIDE_GUEST_FROZEN,
          tickStuckErrors: { host: tickStuckErrorsOf(H.sync), guest: tickStuckErrorsOf(G.sync) },
          peerPhantoms: { host: peerPhantomsOf(H.sync), guest: peerPhantomsOf(G.sync) },
          rbInputStallTimeouts: { host: rbInputStallTimeoutsOf(H.sync), guest: rbInputStallTimeoutsOf(G.sync) },
          guestExercisedTabVisible: guestExercisedTabVisible(G.sync),
          guestExercisedRollbackSkip: guestExercisedRollbackSkip(G.sync),
        },
      }
    : {}),
  ...(SUSPEND_GUEST_AUDIO ? { guestBootTaps, guestExercisedStandInClock: guestExercisedStandInClock(G.sync) } : {}),
  ...(CLICK_DURING_BATTLE ? { clickDuringBattle: true } : {}),
  ...(MIN_GAME_FPS !== null ? { minGameFps: MIN_GAME_FPS } : {}),
  gameFps,
  pacing,
  schedulerCounters,
  frames: { host: H.frame, guest: G.frame, battleStart: [H.inBattleAt, G.inBattleAt] },
  rollbacks: { host: H.rollbacks, guest: G.rollbacks },
  failedRollbacks: { host: H.failed, guest: G.failed },
  predictedKnown: { host: H.predictedKnown, guest: G.predictedKnown },
  engineDelay: { host: delayOf(H.sync), guest: delayOf(G.sync) },
  integrityEvents: { host: bad(H.clog) + bad(H.sync), guest: bad(G.clog) + bad(G.sync) },
  cLogDropped,
  cLogPartial,
  bootInputStallTimeouts: { host: bootInputStallTimeoutsOf(H.sync), guest: bootInputStallTimeoutsOf(G.sync) },
  tickStuck: { host: count(H.sync, /TICK-STUCK/g), guest: count(G.sync, /TICK-STUCK/g) },
  hashCompare: {
    framesCompared: both,
    unrecorded,
    battleFramesCompared: battleCompared,
    battleCoverage: +battleCoverage.toFixed(3),
    battleSpan,
    // Battle-span frames a page has no hash for (missing) or read as 0 (not
    // in its ring): counted against battleCoverage, never compared.
    battleUnrecorded,
    // The lag each page read its hashes at (rollback window + 1), every
    // time its engine was armed, and the post_tick reads made before it was.
    hashLag: {
      host: lagOf(H),
      guest: lagOf(G),
      inits: { host: H.hashLag?.inits ?? [], guest: G.hashLag?.inits ?? [] },
      ticksWithoutLag: { host: H.ticksWithoutLag, guest: G.ticksWithoutLag },
    },
    // COMPARE_HASH_LAG only; null without it.
    earlyLagCompare,
    gameplayMismatches: gpMis,
    firstGameplayMismatch: firstGp,
    gameStateMismatches: gsMis,
    firstGameStateMismatch: firstGs,
    fullStateMismatches: fullMis,
    firstFullMismatch: firstFull,
    // What "zero game-state mismatches" covers: kn_game_state_hash skips
    // every RDRAM block an audio or framebuffer write has tainted, and
    // samples every 16th byte of the rest.
    gameStateRdramBlocksHashed: { host: taintCoverage(H), guest: taintCoverage(G), of: 128 },
  },
  frozenRecovery: { recoveries, framesExcluded, mismatchesExcluded, ...recoveryIntegrity },
  ...(VISUAL_CHECK ? { visualCheck } : {}),
};
if (dropPeerReport) summary.dropPeer = dropPeerReport;
if (START_LOST) {
  const armDelayOf = (log) => (log.match(/C-ROLLBACK init: max=\d+ delay=(\d+)/) || [])[1];
  const armLine = G.sync.split('\n').find((l) => /C-ROLLBACK init: max=/.test(l)) || '';
  Object.assign(startLostReport, {
    armLine,
    hostDelay: armDelayOf(H.sync),
    armedWithHostDelay: !!armDelayOf(H.sync) && armDelayOf(G.sync) === armDelayOf(H.sync),
    // Every start message the host sent before the close was dropped, so
    // the guest can only have armed from the ones sent when its channel opened.
    stopped: /START-FAIL/.test(G.sync),
  });
  if (START_HIDDEN) {
    Object.assign(startLostReport, {
      returned: /tab visible \(was background/.test(G.sync),
      keptFrame: /bg-return: waiting to arm — no fast-forward\/resync/.test(G.sync),
      fastForward: /fast-forward: /.test(G.sync),
    });
  }
  summary.startLost = startLostReport;
}
if (delaySyncAnswerReport) summary.delaySyncAnswer = delaySyncAnswerReport;
if (catchUpReport) summary.catchUp = catchUpReport;
if (LOSE_INPUTS_BEFORE_FALLBACK) summary.loseBeforeFallback = loseBeforeFallbackReport;
summary.peerDropped = peerDropped;
if (malformedPeerReport) summary.malformedPeer = malformedPeerReport;
if (linkReport) summary.link = linkReport;
if (doubleResyncAskReport) summary.doubleResyncAsk = doubleResyncAskReport;
if (RESYNC_FAULT) summary[RESYNC_ONE_BACK ? 'resyncOneBack' : 'resyncSameFrame'] = resyncOneBackReport;
if (unansweredSocketResyncReport) summary.unansweredSocketResync = unansweredSocketResyncReport;
summary.resyncExtras = resyncExtrasReport;
fs.writeFileSync(`${OUT}/hashes.json`, JSON.stringify({ H: H.hashes, G: G.hashes }));
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary, null, 1));
const recoveryNote = frozenRecoveryNote(
  recoveries,
  framesExcluded,
  mismatchesExcluded,
  recoveryIntegrity.integrityEventsExcluded + recoveryIntegrity.failedRollbacksExcluded,
);
if (recoveryNote) console.log(recoveryNote);
if (
  dropPeerReport?.framesExcluded ||
  dropPeerReport?.integrityEventsExcluded ||
  dropPeerReport?.failedRollbacksExcluded
)
  console.log(
    `Left out for DROP_PEER_MS (frames ${dropPeerReport.window.from} to ${dropPeerReport.window.to - 1}, ` +
      `from 12 before the drop to the guest's reconnect resync): ${dropPeerReport.framesExcluded} frames, ` +
      `${dropPeerReport.mismatchesExcluded} of them differing; ${dropPeerReport.integrityEventsExcluded} integrity ` +
      `reports and ${dropPeerReport.failedRollbacksExcluded} failed rollbacks.`,
  );
// Keep the ordinary battle/hash report unchanged; this opt-in scenario runs last.
let resetComboFailed = false;
if (process.env.RESET_COMBO_CHECK === '1') {
  const { checkPausedReset } = await import('./rb-reset-combo.mjs');
  try {
    summary.resetCombo = await checkPausedReset([host, guest], OUT);
  } catch (error) {
    resetComboFailed = true;
    summary.resetCombo = { passed: false, error: String(error) };
  }
  fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 1));
  console.log('RESET_COMBO_CHECK:', JSON.stringify(summary.resetCombo));
}
if (process.env.HOST_END_CHECK === '1') {
  const { checkHostEnd } = await import('./rb-end-game.mjs');
  summary.hostEnd = await checkHostEnd([host, guest], OUT);
  fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 1));
}
if (process.env.FIGHT_RETURN_CHECK === '1') {
  summary.fightReturn = await checkFightReturn({
    host,
    guest,
    baseUrl: URL,
    room,
    out: OUT,
    mode: MODE,
    jitter: JITTER,
  });
  fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 1));
  console.log('FIGHT_RETURN_CHECK:', JSON.stringify(summary.fightReturn));
}
// Close each distinct browser instance once (host and guest may share one,
// e.g. the Chromium/Chromium default, or both resolve to the one WebKit
// instance with HOST_BROWSER=webkit GUEST_BROWSER=webkit).
for (const b of new Set([hostBrowser, guestBrowser])) await b.close();
// A freeze makes deep mispredictions and skipped rollbacks expected before
// the resync; what must hold is that the resync happened, fixed it, and held:
// no integrity events once recovery settled (each peer's lines after its last
// recovery marker, 30+ frames past the resync; late pre-resync inputs can
// still land just after it), and a meaningful window of matching frames.
const POST_RECOVERY_MIN_FRAMES = 120;
const integrityAfterRecovery = (log, marker) => {
  const lines = log.split('\n');
  let from = -1;
  if (marker)
    lines.forEach((l, i) => {
      if (marker.test(l)) from = i;
    });
  return from < 0 && marker
    ? 0
    : lines.slice(from + 1).filter((l) => {
        // A line the engine's C log wrote is copied here in batches, under
        // the frame of the copy. The frame it concerns is the one it names
        // (myF=), as cIntegrityAfterRecovery reads the same line below.
        const named = l.includes('[C] ') ? l.match(/myF=(\d+)/) : null;
        const f = named ? +named[1] : +(l.split('\t')[2] || '').replace('f=', '');
        return f >= recoveredAt + 30 && f < compareUntil && count(l, INTEGRITY) > 0;
      }).length;
};
// The C debug log has no frame column; its entries name the frame they
// concern (f= / myF=). The guest's last `kn_set_frame:` is its resync; the
// host never rewinds, so its frames alone place an entry.
const cIntegrityAfterRecovery = (clog, marker) => {
  const lines = clog.split('\n');
  let from = -1;
  if (marker)
    lines.forEach((l, i) => {
      if (marker.test(l)) from = i;
    });
  return lines.slice(from + 1).filter((l) => {
    if (count(l, INTEGRITY) === 0) return false;
    const m = l.match(/myF=(\d+)/) || l.match(/\bf=(\d+)/);
    return !m || (+m[1] >= recoveredAt + 30 && +m[1] < compareUntil);
  }).length;
};
const postRecoveryIntegrity =
  FREEZE_LIKE || RESYNC_FAULT
    ? integrityAfterRecovery(H.sync, RESYNC_FAULT ? null : /coord sync dispatch/) +
      integrityAfterRecovery(G.sync, /sync #\d+ applied/) +
      cIntegrityAfterRecovery(H.clog, null) +
      cIntegrityAfterRecovery(G.clog, /kn_set_frame: \d+/)
    : 0;
if (FREEZE_LIKE || RESYNC_FAULT)
  console.log('post-recovery integrity events:', postRecoveryIntegrity, 'battle frames compared:', battleCompared);
const integrityFailed =
  FREEZE_LIKE || RESYNC_FAULT
    ? !Number.isFinite(recoveredAt) || postRecoveryIntegrity > 0 || battleCompared < POST_RECOVERY_MIN_FRAMES
    : (H.failed || 0) + (G.failed || 0) - excusedIntegrity.failedRollbacksExcluded > 0 ||
      summary.integrityEvents.host + summary.integrityEvents.guest - excusedIntegrity.integrityEventsExcluded > 0;
const minGameFpsFailed = MIN_GAME_FPS !== null && (!(gameFps.host >= MIN_GAME_FPS) || !(gameFps.guest >= MIN_GAME_FPS));
// A C log line with no room in the engine's buffer is one the checks above
// could not read: reported by a drain (C-LOG-DROPPED), or counted since the
// last drain. So is a drained one the sync log's ring no longer holds.
const cLogDroppedFailed =
  cLogDropped.host.reported + cLogDropped.host.sinceInit + cLogDropped.guest.reported + cLogDropped.guest.sinceInit > 0;
if (cLogDroppedFailed) console.log('C-LOG-DROPPED: the C log dropped lines:', JSON.stringify(cLogDropped));
const cLogPartialFailed = cLogPartial.host || cLogPartial.guest;
if (cLogPartialFailed) {
  console.log('C-LOG-PARTIAL: the sync log ring rotated, so drained C lines may be gone:', JSON.stringify(cLogPartial));
}
if (minGameFpsFailed) {
  console.log(`MIN_GAME_FPS=${MIN_GAME_FPS} not met:`, JSON.stringify(gameFps));
}
const hideGuestFailed =
  HIDE_GUEST_MS > 0 &&
  (summary.hideGuest.tickStuckErrors.host > 0 ||
    summary.hideGuest.tickStuckErrors.guest > 0 ||
    summary.hideGuest.peerPhantoms.host > 0 ||
    summary.hideGuest.peerPhantoms.guest > 0 ||
    summary.hideGuest.rbInputStallTimeouts.host > 0 ||
    summary.hideGuest.rbInputStallTimeouts.guest > 0 ||
    !summary.hideGuest.guestExercisedTabVisible ||
    !summary.hideGuest.guestExercisedRollbackSkip);
if (hideGuestFailed) {
  console.log('HIDE_GUEST_MS: desync-indicating events or unexercised fix path:', JSON.stringify(summary.hideGuest));
}
const suspendGuestAudioFailed = SUSPEND_GUEST_AUDIO && (guestBootTaps > 1 || !summary.guestExercisedStandInClock);
if (suspendGuestAudioFailed) {
  if (guestBootTaps > 1) {
    console.log(`SUSPEND_GUEST_AUDIO: guest needed ${guestBootTaps} taps to boot (expected 1)`);
  }
  if (!summary.guestExercisedStandInClock) {
    console.log('SUSPEND_GUEST_AUDIO: guest never installed the stand-in audio clock (fix path unexercised)');
  }
}
const hostFirstUnverified = DROP_SIGNALING_GUEST_LATE_MS > 0 && !(hostSawRoomWithoutGuest && hostSawGuestReturn);
if (hostFirstUnverified) {
  console.log(
    'DROP_SIGNALING_GUEST_LATE_MS: the host must see the room without the guest and then the guest back in it; ' +
      `saw the first: ${hostSawRoomWithoutGuest}, the second: ${hostSawGuestReturn}`,
  );
}
const signalingDropFailed =
  hostFirstUnverified ||
  (DROP_SIGNALING_MS > 0 &&
    [summary.signalingDrop.host, summary.signalingDrop.guest].some(
      (side) =>
        side.reconnectsAfterOutage < 1 ||
        side.lifecycleReports.length > 0 ||
        side.tickStuck > 0 ||
        side.inputStalls > 0 ||
        side.rbStallTimeouts > 0,
    ));
if (signalingDropFailed) {
  console.log('DROP_SIGNALING_MS: a page never reconnected, stalled, or its lifecycle machine reported:');
  console.log(JSON.stringify(summary.signalingDrop));
}
// The peers' screenshots of a flagged frame are compared with each other, so
// both must have captured the first flagged frame, and at the same frame.
const desyncCapturesAgree = (hostSide, guestSide) => {
  const suspect = hostSide.firstAfter?.frame;
  if (suspect === undefined) return false;
  const hostAt = hostSide.captures[suspect];
  return hostAt !== undefined && hostAt === guestSide.captures[suspect];
};
// kn_gameplay_hash has its own table of addresses, compiled in and SSB64's.
// It sees the changed stock count only when the map's stock address is the
// one in that table (the live battle state's, 0xA4D33), so only then is it
// required to.
const desyncGuestGameplayHashCovers = desyncGuestStocksBase === 0xa4d33;
// DESYNC_GUEST inverts the run: the peers were desynced on purpose. The
// detector must flag the changed field on both peers, and nothing before
// the change; and the gameplay hash, which lists the stock counts, must
// differ on at least one frame. The game-state and full-state hashes are
// not judged: the stock counts are in a block the first leaves out, and the
// second samples one byte in 64.
const desyncGuestFailed =
  DESYNC_GUEST &&
  (desyncGuestAt < 0 ||
    (desyncGuestGameplayHashCovers && gpMisAfterDesync < 1) ||
    gpMisBeforeDesync > 0 ||
    [summary.desyncGuest.host, summary.desyncGuest.guest].some((side) => side.before > 0 || side.stocksAfter < 1) ||
    !desyncCapturesAgree(summary.desyncGuest.host, summary.desyncGuest.guest));
if (DESYNC_GUEST) {
  console.log(
    desyncGuestFailed ? 'DESYNC_GUEST: the detector did not flag the desync as expected:' : 'DESYNC_GUEST: flagged:',
    JSON.stringify(summary.desyncGuest),
  );
  // An unreadable KN_DB fails this mode as it does the others: the rows it holds were not counted.
  process.exit(
    desyncGuestFailed || observerDisagreements > 0 || observers.db?.error || H.inBattleAt < 0 || G.inBattleAt < 0
      ? 1
      : 0,
  );
}
const addressMapFailed =
  ADDRESS_MAP_CHECK && [...summary.addressMapCheck.host, ...summary.addressMapCheck.guest].some((check) => !check.ok);
if (ADDRESS_MAP_CHECK) {
  for (const side of ['host', 'guest'])
    for (const check of summary.addressMapCheck[side])
      console.log(`ADDRESS_MAP_CHECK ${side} ${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
}
// HEAL_BOTH_SIDES: both health checks found the dead channel. Only the lower
// slot (the host) offered; every heal on the guest went to MESH-HEAL-WAIT,
// and the guest came back on the host's offer (specs/peer_connection.qnt,
// peer_connection_heal_one_side). Today the guest offers too and the two
// offers cross (crossedHealOffersTest).
const healBothReport = (() => {
  if (!HEAL_BOTH_SIDES || !healBoth.hostAt) return null;
  const hostLines = linesAfter(H.sync, healBoth.hostAt.seq);
  const guestLines = linesAfter(G.sync, healBoth.guestAt.seq);
  const heals = (lines) => lines.filter((l) => /MESH-HEAL f=/.test(l));
  const waits = (lines) => lines.filter((l) => /MESH-HEAL-WAIT /.test(l));
  const hostHeals = heals(hostLines);
  const hostWaits = waits(hostLines);
  const guestHeals = heals(guestLines);
  const guestWaits = waits(guestLines);
  // The host marked the guest a phantom before its check healed it: the
  // check heals a phantom (mesh_heal_c_tick_only skips one).
  const firstAt = (lines, re) => lines.findIndex((l) => re.test(l));
  const hostPhantomAt = firstAt(hostLines, /PEER-PHANTOM slot=1/);
  const hostHealAt = firstAt(hostLines, /MESH-HEAL f=/);
  const healedAPhantom = hostPhantomAt >= 0 && hostHealAt > hostPhantomAt;
  // One state after the reconnect, not two racing (atMostOneResyncPerReconnect).
  const applied = guestLines.filter((l) => /sync #\d+ applied/.test(l) && seqOf(l) <= healBoth.guestEnd.seq);
  return {
    silenced: healBoth.silenced,
    hostHeals,
    hostWaits,
    guestHeals,
    guestWaits,
    healedAPhantom,
    signalsHeld: healSignalHold.heldCount,
    applied,
    recovered: healBoth.recovered,
    framesAfter: healBoth.framesAfter,
    passed:
      hostHeals.length >= 1 &&
      hostWaits.length === 0 &&
      guestHeals.length >= 1 &&
      guestWaits.length === guestHeals.length &&
      healedAPhantom &&
      applied.length === 1 &&
      healBoth.recovered &&
      healBoth.framesAfter >= 10,
  };
})();
const healBothFailed = HEAL_BOTH_SIDES && !healBothReport?.passed;
if (HEAL_BOTH_SIDES) {
  console.log(
    healBothFailed
      ? 'HEAL_BOTH_SIDES: not exercised, or the guest offered too:'
      : 'HEAL_BOTH_SIDES: the host offered, the guest waited:',
    JSON.stringify(healBothReport),
  );
}
// DROP_PEER_MS: the signaling was dropped, every step of the reconnect is in
// the logs, and a retry is too when the drop outlasted an attempt.
const dropPeerFailed = DROP_PEER_MS > 0 && !(dropPeerReport?.window.proven && dropPeerReport.exercised);
if (dropPeerReport) {
  console.log(
    dropPeerFailed
      ? 'DROP_PEER_MS: no signaling dropped, no retry, or the reconnect is not all in the logs:'
      : 'DROP_PEER_MS: reconnected:',
    JSON.stringify(dropPeerReport),
  );
}
// CATCH_UP_HOLE_MS: the host's inputs were dropped on the reconnected
// channel, the guest's catch-up after the reconnect did not stop on a
// missing input, and the host did not run away from the guest
// (specs/catch_up_wait.qnt).
const catchUpHoleReport = (() => {
  if (!(CATCH_UP_HOLE_MS > 0) || !dropPeer.guestAt) return null;
  const dropped = dropPeer.holeDropped;
  const guestLines = linesAfter(G.sync, dropPeer.guestAt.seq);
  const catchUps = guestLines.filter((l) => /SYNC-CATCH-UP from=/.test(l));
  const stoppedOnHole = catchUps.filter((l) => /stopped: slot \d+ input \d+ not here/.test(l));
  return { dropped: dropped.length, droppedFrames: dropped.slice(0, 8), catchUps, stoppedOnHole };
})();
const finalGap = Math.abs(H.frame - G.frame);
// ASK_UNANSWERED_STALL_MS: the host's asks went overdue, it pushed its state to
// the guest, and the guest's inputs-settled answered the push
// (specs/ask_escalation.qnt).
const askUnansweredReport = (() => {
  if (!(ASK_UNANSWERED_STALL_MS > 0) || !askUnanswered.hostAt) return null;
  const hostLines = linesAfter(H.sync, askUnanswered.hostAt.seq);
  const overdue = hostLines.filter((l) => /INPUT-ASK-OVERDUE .*→ push/.test(l));
  const settled = hostLines.filter((l) => /INPUT-ASK-PUSH-SETTLED/.test(l));
  const gaveUp = hostLines.filter((l) => /INPUT-ASK-PUSH-GAVEUP/.test(l));
  const hardDisconnected = hostLines.filter((l) => /peer hard-disconnected: .* slot: 1/.test(l));
  const pushes = hostLines.filter((l) => /INPUT-ASK-PUSH-AGAIN/.test(l));
  const endedOnPhantom = hostLines.filter((l) => /INPUT-ASK-PUSH-ENDED .*phantom/.test(l));
  const recovered = hostLines.filter((l) => /PEER-RECOVERED slot=1/.test(l));
  // Main's recovery for a stalled hole; the escalation should come first.
  const stallTimeouts = hostLines.filter((l) => /RB-INPUT-STALL-TIMEOUT/.test(l));
  // After a drop, the health check may offer to the player again: each
  // drop and heal is counted, so a cycle that does not end shows.
  const heals = hostLines.filter((l) => /MESH-HEAL f=.* slot=1/.test(l));
  // Which way the push ended (ASK_UNANSWERED_ACKS takes either): the push
  // limit and a drop, or the host's stall making the guest a phantom.
  const route = gaveUp.length > 0 ? 'gaveUp' : endedOnPhantom.length > 0 ? 'phantom' : 'none';
  return {
    route,
    baselineWithoutResync: RESYNC_OFF
      ? resyncOffEvidence({
          lines: hostLines,
          range: askUnanswered.range,
          dropped: askUnanswered.dropped,
          lastFrame: H.frame,
        })
      : null,
    range: askUnanswered.range,
    dropped: askUnanswered.dropped,
    overdue,
    settled,
    pushes,
    gaveUp,
    hardDisconnected,
    heals: heals.length,
    stallTimeouts,
    notSent: hostLines.filter((l) => /INPUT-ASK-PUSH-NOT-SENT/.test(l)).length,
    endedOnPhantom,
    recovered: recovered.length,
    statesDropped: askUnanswered.statesDropped,
    // ACKS: the drop is final (specs/drop_is_final.qnt): the guest's page
    // was told and ended its match, and nothing on the host followed it.
    droppedByHost: askUnanswered.droppedByHost ? [askUnanswered.droppedByHost] : [],
    lateJoined: askUnanswered.lateJoinedAt === null ? [] : [askUnanswered.lateJoinedAt],
    pastWindowAfterDrop: gaveUp.length
      ? linesAfter(H.sync, seqOf(gaveUp[0])).filter((l) => /INPUT-PAST-WINDOW-MISMATCH/.test(l)).length
      : null,
    freezeMs: askUnanswered.freezeMs,
    lastPushFrame: Math.max(-1, ...settled.map((l) => +(l.match(/ frame=(\d+)/) || [])[1] || -1)),
    comparedFrom: recoveredAt,
  };
})();
if (RESYNC_OFF) fs.writeFileSync(`${OUT}/resync-off-evidence.json`, JSON.stringify(askUnansweredReport, null, 2));
const askUnansweredFailed = RESYNC_OFF
  ? // Resync off: the injected hole takes the normal stall path, never recovery.
    ASK_UNANSWERED_STALL_MS > 0 &&
    !(
      askUnansweredReport &&
      askUnansweredReport.dropped > 0 &&
      askUnansweredReport.baselineWithoutResync?.passed === true &&
      askUnansweredReport.notSent === 0 &&
      askUnansweredReport.overdue.length === 0 &&
      askUnansweredReport.settled.length === 0 &&
      askUnansweredReport.pushes.length === 0 &&
      askUnansweredReport.gaveUp.length === 0 &&
      askUnansweredReport.hardDisconnected.length === 0
    )
  : ASK_UNANSWERED_STALL_MS > 0 &&
    !(
      askUnansweredReport &&
      askUnansweredReport.dropped > 0 &&
      askUnansweredReport.overdue.length > 0 &&
      (ASK_UNANSWERED_ACK_LOST
        ? // The phantom the host's stall makes ends the push; its own resync
          // recovers the guest, and nobody is dropped.
          askUnansweredReport.endedOnPhantom.length > 0 &&
          askUnansweredReport.recovered > 0 &&
          askUnansweredReport.gaveUp.length === 0 &&
          askUnansweredReport.hardDisconnected.length === 0
        : ASK_UNANSWERED_ACKS
          ? askUnansweredReport.statesDropped > 0 &&
            (askUnansweredReport.endedOnPhantom.length > 0
              ? // The host's own 5 s stall deadline can make the guest a phantom
                // before the push limit: the phantom ends the push and its own
                // resync recovers the guest, nobody dropped (as ACK_LOST).
                askUnansweredReport.recovered > 0 &&
                askUnansweredReport.gaveUp.length === 0 &&
                askUnansweredReport.hardDisconnected.length === 0
              : // Every push unanswered: pushed again to the limit, then the player dropped.
                askUnansweredReport.pushes.length >= 2 &&
                askUnansweredReport.gaveUp.length > 0 &&
                askUnansweredReport.hardDisconnected.length > 0 &&
                askUnansweredReport.droppedByHost.length > 0 &&
                // It joined again late, onto the host's state; frames are compared
                // from there (FREEZE_LIKE).
                askUnansweredReport.lateJoined.length > 0 &&
                askUnansweredReport.heals === 0 &&
                askUnansweredReport.pastWindowAfterDrop === 0)
          : askUnansweredReport.settled.length > 0 &&
            askUnansweredReport.gaveUp.length === 0 &&
            // The difference from main: no stall waits out its deadline.
            askUnansweredReport.stallTimeouts.length === 0 &&
            askUnansweredReport.freezeMs < STALL_DEADLINE_MS &&
            // The frames compared start at or after the last push's frame.
            recoveredAt >= askUnansweredReport.lastPushFrame)
    );
if (ASK_UNANSWERED_STALL_MS > 0) {
  console.log(
    askUnansweredFailed
      ? 'ASK_UNANSWERED_STALL_MS: no input dropped, no overdue push, the push not acknowledged, or a stall waited out its deadline:'
      : 'ASK_UNANSWERED_STALL_MS: the overdue ask ended in a pushed state the guest applied:',
    JSON.stringify(askUnansweredReport),
  );
}
// Hash mismatches from a frame on (both pages' finalized frames).
const mismatchesFrom = (from) =>
  Object.keys(H.hashes).filter((f) => {
    const a = H.hashes[f],
      b = G.hashes[f];
    return +f >= from && b && a[0] && b[0] && (a[0] !== b[0] || a[2] !== b[2]);
  }).length;
// ASK_UNANSWERED_PHANTOM: the input dropped, the host asked for it, and the
// frames after the guest's last state match (FREEZE_LIKE compares from it).
const askPhantomReport = (() => {
  if (!ASK_UNANSWERED_PHANTOM) return null;
  if (!askPhantom.armed) return { armed: false };
  const hostLines = linesAfter(H.sync, askPhantom.hostAt.seq);
  const frame = askPhantom.range[0];
  const asked = hostLines.filter((l) => {
    const m = l.match(/RB-INPUT-ASK .*frames=(\d+)\.\.(\d+)/);
    return m && +m[1] <= frame && frame <= +m[2];
  });
  return {
    armed: true,
    frame,
    dropped: askPhantom.dropped,
    asked: asked.length,
    stalled: hostLines.filter((l) => /RB-INPUT-STALL f=/.test(l)).length,
    overdue: hostLines.filter((l) => /INPUT-ASK-OVERDUE/.test(l)),
    settled: hostLines.filter((l) => /INPUT-ASK-PUSH-SETTLED/.test(l)),
    stallTimeouts: hostLines.filter((l) => /RB-INPUT-STALL-TIMEOUT/.test(l)).length,
    mismatchesFromFrame: mismatchesFrom(frame),
    comparedFrom: recoveredAt,
  };
})();
const askPhantomFailed =
  ASK_UNANSWERED_PHANTOM &&
  !(
    askPhantomReport?.armed &&
    askPhantomReport.dropped > 0 &&
    // The difference from main, whose stall deadline recovers the hole:
    // the ask escalates, the push is acknowledged, no stall times out.
    askPhantomReport.settled.length > 0 &&
    askPhantomReport.stallTimeouts === 0 &&
    gpMis === 0 &&
    gsMis === 0 &&
    recoveredAt > askPhantomReport.frame
  );
if (ASK_UNANSWERED_PHANTOM)
  console.log(
    askPhantomFailed
      ? 'ASK_UNANSWERED_PHANTOM: not dropped, no acknowledged push, a stall timed out, or the frames after the last state differ:'
      : 'ASK_UNANSWERED_PHANTOM: the hole ended in a state both pages agree on:',
    JSON.stringify(askPhantomReport),
  );
// ROLLBACK_AT_EDGE: C rolled the held input back at the window's edge.
// PAST_WINDOW_FORCED: it came past the window and different (C's
// DEEP-MISPREDICT-SKIP), the guest escalated, and a state applied after it
// left the pages agreeing.
const pastWindowReport = (() => {
  if (!PAST_WINDOW_INPUT || !pastWindow.guestAt) return null;
  const guestLines = linesAfter(G.sync, pastWindow.guestAt.seq);
  const F = pastWindow.frame;
  const skipped = G.clog
    .split('\n')
    .filter((l) => new RegExp(`(DEEP-MISPREDICT-SKIP|FAILED-ROLLBACK) slot=0 f=${F} `).test(l));
  const rolledBack = G.clog
    .split('\n')
    .map((l) => l.match(new RegExp(`MISPREDICTION slot=0 f=${F} .*depth=(\\d+)`)))
    .filter(Boolean)
    .map((m) => +m[1]);
  return {
    rolledBackDepth: rolledBack.length ? Math.max(...rolledBack) : null,
    frame: F,
    held: pastWindow.held,
    releasedAt: pastWindow.releasedAt,
    released: pastWindow.released,
    skipped,
    mismatch: guestLines.filter((l) => /INPUT-PAST-WINDOW-MISMATCH/.test(l)),
    overdueAsk: guestLines.filter((l) => /INPUT-ASK-OVERDUE/.test(l)),
    applied: guestLines.filter((l) => /sync #\d+ applied/.test(l)).length,
    mismatchesFromFrame: mismatchesFrom(F),
    comparedFrom: recoveredAt,
  };
})();
const pastWindowFailed = ROLLBACK_AT_EDGE
  ? !(
      pastWindowReport &&
      pastWindowReport.released &&
      pastWindowReport.rolledBackDepth >= 5 &&
      pastWindowReport.skipped.length === 0 &&
      gpMis === 0 &&
      gsMis === 0
    )
  : PAST_WINDOW_FORCED &&
    !(
      pastWindowReport &&
      pastWindowReport.released &&
      pastWindowReport.skipped.length > 0 &&
      pastWindowReport.mismatch.length > 0 &&
      pastWindowReport.applied > 0 &&
      recoveredAt > pastWindowReport.frame &&
      gpMis === 0 &&
      gsMis === 0
    );
if (PAST_WINDOW_INPUT)
  console.log(
    pastWindowFailed
      ? ROLLBACK_AT_EDGE
        ? 'ROLLBACK_AT_EDGE: not rolled back at the edge, skipped, or the frames differ:'
        : 'PAST_WINDOW_FORCED: not held past the window, not escalated, or the frames after the state differ:'
      : ROLLBACK_AT_EDGE
        ? 'ROLLBACK_AT_EDGE: rolled back at the edge and the frames match:'
        : 'PAST_WINDOW_FORCED: the late input escalated to a state both pages agree on:',
    JSON.stringify(pastWindowReport),
  );
const catchUpHoleFailed =
  CATCH_UP_HOLE_MS > 0 &&
  !(
    catchUpHoleReport &&
    catchUpHoleReport.dropped > 0 &&
    catchUpHoleReport.catchUps.length > 0 &&
    catchUpHoleReport.stoppedOnHole.length === 0 &&
    finalGap < RUNAWAY_FRAMES
  );
if (CATCH_UP_HOLE_MS > 0) {
  console.log(
    catchUpHoleFailed
      ? 'CATCH_UP_HOLE_MS: no input dropped, the catch-up stopped on a hole, or the host ran away:'
      : 'CATCH_UP_HOLE_MS: the catch-up filled its hole and the pages stayed together:',
    JSON.stringify({ ...catchUpHoleReport, finalGap }),
  );
}
// DELAY_SYNC_ANSWER_MS: the late answer must have been late, and handled.
const delaySyncAnswerFailed =
  DELAY_SYNC_ANSWER_MS > 0 &&
  (!delaySyncAnswerReport ||
    delaySyncAnswerReport.held.length < 1 ||
    !delaySyncAnswerReport.timedOut ||
    delaySyncAnswerReport.requestsReceivedByHost < 2 ||
    !delaySyncAnswerReport.lateAnswerAfterSecondAsk ||
    Object.values(delaySyncAnswerReport.lateAnswerHandled).every((n) => n === 0) ||
    delaySyncAnswerReport.resyncsApplied < 1 ||
    !delaySyncAnswerReport.newestApplied);
if (delaySyncAnswerReport) {
  console.log(
    delaySyncAnswerFailed
      ? 'DELAY_SYNC_ANSWER_MS: the late answer did not take the path under test:'
      : 'DELAY_SYNC_ANSWER_MS: late answer handled:',
    JSON.stringify(delaySyncAnswerReport),
  );
}
// CATCH_UP_MS: the answer was held and caught up from, all the way.
const catchUpFailed =
  CATCH_UP_MS > 0 &&
  (!catchUpReport ||
    catchUpReport.held.length < 1 ||
    !catchUpReport.catchUps.some((c) => c.frames > 0 && c.to === c.of) ||
    catchUpReport.applied.length < 1);
if (catchUpReport) {
  console.log(
    catchUpFailed ? 'CATCH_UP_MS: the answer was not caught up from:' : 'CATCH_UP_MS: caught up:',
    JSON.stringify(catchUpReport),
  );
}
// DOUBLE_RESYNC_ASK: the host dropped the newest request, the guest dropped
// the older one's answer, and a host state was applied all the same.
const doubleResyncAskFailed =
  DOUBLE_RESYNC_ASK &&
  (!doubleResyncAskReport ||
    doubleResyncAskReport.guestAsks < 2 ||
    doubleResyncAskReport.rateLimited < 1 ||
    doubleResyncAskReport.lateAnswerDropped < 1 ||
    doubleResyncAskReport.applied.length < 1);
if (doubleResyncAskReport) {
  console.log(
    doubleResyncAskFailed
      ? 'DOUBLE_RESYNC_ASK: no request dropped, no late answer dropped, or no state applied after:'
      : 'DOUBLE_RESYNC_ASK: the owed resync was applied:',
    JSON.stringify(doubleResyncAskReport),
  );
}
// SYNC_FOLLOW_UP: the host answered the guest's recovery request unconfirmed
// and watched the frame it sent. `same`: no input that ran before it differed
// from its prediction, so the follow-up was skipped and nothing else went out
// for it. `changed`: one did, and the follow-up went out and was applied.
// specs/sync_follow_up.qnt.
const syncFollowUpReport = (() => {
  if (!SYNC_FOLLOW_UP || !syncFollowUp.hostAt) return null;
  const endSeq = syncFollowUp.hostEnd?.seq ?? Infinity;
  const hostLines = linesAfter(H.sync, syncFollowUp.hostAt.seq).filter((l) => seqOf(l) <= endSeq);
  const guestLines = linesAfter(G.sync, syncFollowUp.guestAt.seq);
  const at = (lines, re, from = 0) => {
    const i = lines.slice(from).findIndex((l) => re.test(l));
    return i < 0 ? -1 : from + i;
  };
  const line = (lines, i) => (i < 0 ? null : lines[i]);
  const recoveryAsk = at(
    guestLines,
    SYNC_FOLLOW_UP === 'direct'
      ? /BOOT-SYNC: guest requesting host state/
      : SYNC_FOLLOW_UP === 'socket' || SYNC_FOLLOW_UP === 'owed'
        ? /sent socket sync-request-full to host/
        : /peer-recovery resync: sent sync-request-full-at:/,
  );
  // With `socket`, the answer under test is the one to the socket request.
  const viaSocket = SYNC_FOLLOW_UP === 'socket' || SYNC_FOLLOW_UP === 'owed';
  const socketReceived = viaSocket ? at(hostLines, /received socket sync-request-full/) : 0;
  const watch = socketReceived < 0 ? -1 : at(hostLines, /SYNC-FOLLOW-UP-WATCH /, socketReceived);
  const after = (re) => (watch < 0 ? -1 : at(hostLines, re, watch));
  const needed = after(/SYNC-FOLLOW-UP-NEEDED /);
  const skipped = after(/SYNC-FOLLOW-UP-SKIPPED /);
  // The watch is logged as its state is taken, just after its dispatch: a
  // dispatch after it is the follow-up.
  const followUpDispatch = after(viaSocket ? /coord sync dispatch: .*over the socket/ : /coord sync dispatch: /);
  const applied = recoveryAsk < 0 ? [] : guestLines.slice(recoveryAsk).filter((l) => /sync #\d+ applied/.test(l));
  const ticking = syncFollowUp.framesAfter >= 10;
  const passed =
    recoveryAsk >= 0 &&
    watch >= 0 &&
    ticking &&
    (SYNC_FOLLOW_UP === 'same'
      ? needed < 0 && skipped > watch && followUpDispatch < 0 && applied.length >= 1
      : SYNC_FOLLOW_UP === 'owed'
        ? // Taken with a correction owed: the watch starts changed (owed=1),
          // so the follow-up goes out over the socket without any input
          // flagging it, and the guest applies it.
          syncFollowUp.releasedInReplay &&
          / owed=1:/.test(hostLines[watch] || '') &&
          followUpDispatch > watch &&
          (skipped < 0 || skipped > followUpDispatch) &&
          applied.length >= 2
        : needed > watch &&
          followUpDispatch > needed &&
          // The follow-up itself is not skipped. With `direct` a follow-up sent
          // at its deadline, still unconfirmed, is watched in turn, and its own
          // follow-up may rightly be skipped after it.
          (skipped < 0 || (['direct', 'socket'].includes(SYNC_FOLLOW_UP) && skipped > followUpDispatch)) &&
          applied.length >= 2);
  return {
    mode: SYNC_FOLLOW_UP,
    attempts: syncFollowUp.attempts,
    recoveryAsk: line(guestLines, recoveryAsk),
    watch: line(hostLines, watch),
    needed: line(hostLines, needed),
    skipped: line(hostLines, skipped),
    followUpDispatch: line(hostLines, followUpDispatch),
    releasedInReplay: syncFollowUp.releasedInReplay ?? null,
    dispatches: hostLines.filter((l) => /coord sync dispatch: |COORD-SYNC-TIMEOUT/.test(l)),
    applied,
    framesAfter: syncFollowUp.framesAfter,
    passed,
  };
})();
const syncFollowUpFailed = SYNC_FOLLOW_UP !== '' && !syncFollowUpReport?.passed;
if (SYNC_FOLLOW_UP) {
  console.log(
    syncFollowUpFailed
      ? `SYNC_FOLLOW_UP=${SYNC_FOLLOW_UP}: not exercised, or the path under test did not hold:`
      : `SYNC_FOLLOW_UP=${SYNC_FOLLOW_UP}: the path under test held:`,
    JSON.stringify(syncFollowUpReport),
  );
}
// UNANSWERED_SOCKET_RESYNC: the guard timed out under the owed resync, and
// the request's own deadline still asked again and got it.
const unansweredSocketResyncFailed = UNANSWERED_SOCKET_RESYNC && !unansweredSocketResyncReport?.passed;
if (UNANSWERED_SOCKET_RESYNC) {
  console.log(
    unansweredSocketResyncFailed
      ? `UNANSWERED_SOCKET_RESYNC=${UNANSWERED_VARIANT}: not exercised, or the path under test did not hold:`
      : `UNANSWERED_SOCKET_RESYNC=${UNANSWERED_VARIANT}: the path under test held:`,
    JSON.stringify(unansweredSocketResyncReport),
  );
}
// LINK_KBPS: every channel was on its connection's shared link, the fault
// happened (a plain resync was applied, or DELAY_SYNC_ANSWER_MS's own checks
// above), and no rollback was skipped after it outside a proven recovery.
const linkFailed =
  LINK_KBPS > 0 &&
  (!linkReport.host ||
    !linkReport.guest ||
    linkReport.host.unmappedChannels > 0 ||
    linkReport.guest.unmappedChannels > 0 ||
    (LINK_RESYNC && !linkResync.applied) ||
    !linkReport.afterFault.host ||
    !linkReport.afterFault.guest ||
    [linkReport.afterFault.host, linkReport.afterFault.guest].some(
      (side) => side.deepMispredictSkips.syncLogUnexcused > 0 || side.deepMispredictSkips.cLogUnexcused > 0,
    ));
if (linkReport) {
  console.log(
    linkFailed
      ? 'LINK_KBPS: a channel off the shared link, no fault, or a skipped rollback after it:'
      : 'LINK_KBPS: link capped, no skipped rollback after the fault:',
    JSON.stringify(linkReport),
  );
}
// LOSE_INPUTS_BEFORE_FALLBACK: the fault ran, and nothing it dropped had to be asked for.
const loseBeforeFallbackFailed = LOSE_INPUTS_BEFORE_FALLBACK && !loseBeforeFallbackReport?.passed;
if (LOSE_INPUTS_BEFORE_FALLBACK) {
  console.log(
    loseBeforeFallbackFailed
      ? 'LOSE_INPUTS_BEFORE_FALLBACK: not exercised, or inputs dropped before the switch were lost:'
      : 'LOSE_INPUTS_BEFORE_FALLBACK: every dropped input reached the guest unasked:',
    JSON.stringify(loseBeforeFallbackReport),
  );
}
// A peer message dropped as off its schema, in a run that sent none on purpose:
// a string real pages send that peer-protocol.ts does not describe.
const peerDroppedFailed = !MALFORMED_PEER && (peerDropped.host.length > 0 || peerDropped.guest.length > 0);
if (peerDroppedFailed) console.log('PEER-DROPPED: a real peer message was dropped:', JSON.stringify(peerDropped));
const malformedPeerFailed = MALFORMED_PEER && !malformedPeerReport?.passed;
if (MALFORMED_PEER) {
  console.log(
    malformedPeerFailed
      ? 'MALFORMED_PEER: not sent, not dropped as expected, a value logged, or a page stopped:'
      : 'MALFORMED_PEER: every string dropped once, no value logged, both pages played on:',
    JSON.stringify(malformedPeerReport),
  );
}
// A disagreement is what the fault modes exist to find: it fails the run like a mismatch.
const observersFailed = observerDisagreements > 0 || !!observers.db?.error;
console.log(
  observersFailed ? 'OBSERVERS: disagreement reported (or KN_DB unreadable):' : 'OBSERVERS: no disagreement:',
  JSON.stringify(observers),
);
// RESYNC_ONE_BACK / RESYNC_SAME_FRAME: the ordering it is for was reached,
// or the run says why not.
const resyncOneBackFailed = !!RESYNC_FAULT && (!resyncOneBackReport?.landed || !!resyncOneBackReport?.missed);
if (RESYNC_FAULT)
  console.log(
    resyncOneBackFailed
      ? `${RESYNC_FAULT_KNOB}: the resync did not land as the mode is for:`
      : RESYNC_ONE_BACK
        ? 'RESYNC_ONE_BACK: the resync landed one frame back:'
        : 'RESYNC_SAME_FRAME: the resync landed on a frame kn_pre_tick had saved and not run:',
    JSON.stringify(resyncOneBackReport),
  );
// Any applied state whose hidden or HLE state is not the host's fails the
// run; a mode that forces a resync must also have compared one.
const resyncExtrasFailed =
  resyncExtrasReport.mismatched.length > 0 ||
  !resyncExtrasReport.probed.host ||
  !resyncExtrasReport.probed.guest ||
  (!!RESYNC_FAULT && resyncExtrasReport.compared === 0);
console.log(
  resyncExtrasFailed
    ? "RESYNC-EXTRAS: an applied state left the guest with hidden or HLE state not the host's (or none compared):"
    : "RESYNC-EXTRAS: every applied state left the guest with the host's hidden and HLE state:",
  JSON.stringify(resyncExtrasReport),
);
const startLostFailed =
  START_LOST &&
  !(
    startLostReport.dropped >= 2 &&
    startLostReport.waited &&
    startLostReport.closed &&
    startLostReport.armLine &&
    startLostReport.armedWithHostDelay &&
    !startLostReport.stopped &&
    (!START_HIDDEN ||
      (startLostReport.hiddenAndShown &&
        startLostReport.returned &&
        startLostReport.keptFrame &&
        !startLostReport.fastForward))
  );
if (START_LOST)
  console.log(
    startLostFailed
      ? "START_LOST: the guest did not arm with the host's delay after its channel came back:"
      : 'START_LOST: the host sent its delay and start frame again on the new channel and the guest armed with them:',
    JSON.stringify(startLostReport),
  );
// Every mode: no frame run on a prediction of an input the peer is known to
// have made, or one C did not record (specs/reconnect_inputs.qnt).
const predictedKnownFailed = (H.predictedKnown || 0) + (G.predictedKnown || 0) > 0;
console.log(
  predictedKnownFailed ? 'PREDICTED-KNOWN: frames run on a prediction nothing corrects:' : 'PREDICTED-KNOWN: none:',
  JSON.stringify({
    host: H.predictedKnown,
    guest: G.predictedKnown,
    lines: [...H.sync.split('\n'), ...G.sync.split('\n')].filter((l) => l.includes('PREDICTED-KNOWN')).slice(0, 6),
  }),
);
const failed =
  startLostFailed ||
  predictedKnownFailed ||
  resetComboFailed ||
  summary.fightReturn?.passed === false ||
  addressMapFailed ||
  resyncOneBackFailed ||
  resyncExtrasFailed ||
  linkFailed ||
  dropPeerFailed ||
  catchUpHoleFailed ||
  askUnansweredFailed ||
  askPhantomFailed ||
  pastWindowFailed ||
  healBothFailed ||
  delaySyncAnswerFailed ||
  catchUpFailed ||
  loseBeforeFallbackFailed ||
  peerDroppedFailed ||
  malformedPeerFailed ||
  doubleResyncAskFailed ||
  unansweredSocketResyncFailed ||
  syncFollowUpFailed ||
  observersFailed ||
  signalingDropFailed ||
  gpMis > 0 ||
  gsMis > 0 ||
  summary.bootInputStallTimeouts.host > 0 ||
  summary.bootInputStallTimeouts.guest > 0 ||
  integrityFailed ||
  cLogDroppedFailed ||
  cLogPartialFailed ||
  H.inBattleAt < 0 ||
  G.inBattleAt < 0 ||
  battleCoverage < 0.8 ||
  (VISUAL_CHECK && visualCheck.corrupted > 0) ||
  minGameFpsFailed ||
  (THROTTLE_GUEST && !throttleFlipped) ||
  hideGuestFailed ||
  suspendGuestAudioFailed ||
  // A lockstep run whose pages did not turn predictions off, or did not say
  // lockstep in the info panel, did not test lockstep.
  (MODE === 'lockstep' &&
    !(
      summary.lockstep.predictionsOff.host &&
      summary.lockstep.predictionsOff.guest &&
      summary.lockstep.infoMode.host === 'lockstep' &&
      summary.lockstep.infoMode.guest === 'lockstep'
    ));
process.exit(failed ? 1 : 0);
