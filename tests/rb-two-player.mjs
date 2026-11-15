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
 *   - gameplay hash of every finalized frame (12 frames behind the head,
 *     past the rollback window) is identical on both peers
 *   - no failed rollbacks or integrity events (R2-R5 and fatal WASM traps
 *     in docs/netplay-invariants.md) in either peer's engine or sync log
 *   - no rollback input-stall timeouts below frame 300 on either peer
 *   - TICK-STUCK stalls, negotiated delay and rollback counts, for context
 *   - no `peer-disagree` or `resync-disagree` from the two observers beside
 *     the engine (tests/observer-reports.mjs), in either page's sync log or
 *     client events, nor, with KN_DB set to the server's DB_PATH, in the
 *     server's client_events table for this room (without KN_DB the query to
 *     run by hand is printed). Reading KN_DB needs Node >= 22.13 (node:sqlite);
 *     on an older Node, or a database that cannot be read, the run fails.
 * Exits 1 for gameplay divergence; rollback failure; integrity events; a match
 * that never reaches a battle; fewer than 80% of finalized battle frames
 * compared; a boot input stall timeout; or an observer disagreement.
 *
 *   just serve        # the real server on :27888, in another terminal
 *   KN_ROM=/path/ssb64-us.z64 [LAT=50] [JITTER=0] [LINK_KBPS=0] [BATTLE_SECONDS=60] [FREEZE_HOST_MS=0 | FREEZE_GUEST_MS=0] \
 *     [HEADED=1] [OUT=/tmp/two-player] [KN_DB=server DB_PATH, Node >= 22.13] node tests/rb-two-player.mjs
 *
 * Extra knobs, all off by default:
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
 *     page's DataChannel send wrapper (initScript below) holds the first
 *     `sync-answer-id:` it sends on the `sync-state` channel, and with it the
 *     `sync-start:` header and binary chunks queued behind it, then releases
 *     them in order. No engine hook. Once the guest logs
 *     RESYNC-REQUEST-TIMEOUT it is made to ask again the same way; the late
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
 *     DataChannel send wrapper (initScript below) drops every binary input it
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
 *     either page logged PEER-PHANTOM, RB-INPUT-STALL-TIMEOUT or
 *     INPUT-STALL-RESYNC. Frames are compared as usual: no exclusion.
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
import { chromium, webkit } from 'playwright';
import fs from 'fs';
import {
  frozenRecoveries,
  frozenRecoveryNote,
  inFrozenRecovery,
  inFrozenRecoveryAftermath,
  withoutLinkStarved,
} from './frozen-recovery.mjs';
import { createLinkSchedule, spansInFrames } from './link-schedule.mjs';
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
const MIN_GAME_FPS = process.env.MIN_GAME_FPS ? Number(process.env.MIN_GAME_FPS) : null;
const SUSPEND_GUEST_AUDIO = process.env.SUSPEND_GUEST_AUDIO === '1';
const CLICK_DURING_BATTLE = process.env.CLICK_DURING_BATTLE === '1';
const DESYNC_GUEST = process.env.DESYNC_GUEST === '1';
const DROP_PEER_MS = Number(process.env.DROP_PEER_MS || 0);
const DELAY_SYNC_ANSWER_MS = Number(process.env.DELAY_SYNC_ANSWER_MS || 0);
const LOSE_INPUTS_BEFORE_FALLBACK = process.env.LOSE_INPUTS_BEFORE_FALLBACK === '1';
const LINK_KBPS = Number(process.env.LINK_KBPS || 0);
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
// LINK_KBPS without DELAY_SYNC_ANSWER_MS: one plain resync a third of the way in.
const LINK_RESYNC = LINK_KBPS > 0 && !(DELAY_SYNC_ANSWER_MS > 0);
const LINK_RESYNC_RECOVER_MS = 30000;
// Both start a third of the way in; what follows must fit in the remaining two thirds.
const DROP_PEER_RECOVER_MS = 30000;
// How long the host's reconnect attempt waits before it retries: the
// engine's own _RECONNECT_ATTEMPT_TIMEOUT, read from netplay-rollback.js so
// the two cannot drift. A DROP_PEER_MS longer than this drops the first
// attempt's offer and outlasts its deadline, so the run must show a retry.
const RECONNECT_ATTEMPT_TIMEOUT_MS = (() => {
  const source = fs.readFileSync(
    // URL is the server's address in this file.
    new globalThis.URL('../web/static/netplay-rollback.js', import.meta.url),
    'utf8',
  );
  const m = source.match(/const _RECONNECT_ATTEMPT_TIMEOUT = (\d+);/);
  if (!m) {
    console.log('netplay-rollback.js no longer defines _RECONNECT_ATTEMPT_TIMEOUT: update DROP_PEER_MS in this test');
    process.exit(1);
  }
  return Number(m[1]);
})();
const DELAY_SYNC_ANSWER_RECOVER_MS = 20000;
const faultNeedsSeconds = Math.ceil(
  (((DROP_PEER_MS > 0 ? DROP_PEER_MS + DROP_PEER_RECOVER_MS : 0) +
    (DELAY_SYNC_ANSWER_MS > 0 ? DELAY_SYNC_ANSWER_MS + DELAY_SYNC_ANSWER_RECOVER_MS : 0) +
    (LINK_RESYNC ? LINK_RESYNC_RECOVER_MS : 0)) *
    1.5) /
    1000,
);
if ((DROP_PEER_MS > 0 || DELAY_SYNC_ANSWER_MS > 0 || LINK_RESYNC) && !(BATTLE_SECONDS >= faultNeedsSeconds)) {
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

const initScript = ({ lat, jitter, kbps }, createLinkSchedule) => {
  // Simulated network (tests/link-schedule.mjs): every outgoing DataChannel
  // message is held (DELAY_SYNC_ANSWER_MS), carried by its connection's link
  // at LINK_KBPS (no limit when 0), then delayed LAT ms + up to JITTER ms.
  // Jitter never reorders a channel: real SCTP data channels deliver in
  // order, and chunked transfers (compressed save states) rely on it.
  const orig = RTCDataChannel.prototype.send;
  const net = createLinkSchedule({ kbps, lat, jitter });
  window.__knLink = { stats: net.stats, unmappedChannels: 0 };
  // Which connection a channel belongs to: the ones this page creates, and
  // the ones the other page creates (the `datachannel` event). The listener
  // is added as the connection is made, so it runs before the page's own
  // ondatachannel handler, which sends on the channel.
  const pcOf = new WeakMap();
  const RealPC = window.RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(RealPC, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget);
      pc.addEventListener('datachannel', (e) => pcOf.set(e.channel, pc));
      return pc;
    },
  });
  const realCreate = RealPC.prototype.createDataChannel;
  RealPC.prototype.createDataChannel = function (...args) {
    const ch = realCreate.apply(this, args);
    pcOf.set(ch, this);
    return ch;
  };
  const links = new WeakMap(); // connection (or a channel with none known) -> {link, timer}
  const channels = new WeakMap(); // RTCDataChannel -> its channel on the link
  const scheduleOf = (dc) => {
    let ch = channels.get(dc);
    if (ch) return ch;
    let owner = pcOf.get(dc);
    if (!owner) {
      // Not seen being made: it gets a link of its own, and the summary says so.
      owner = dc;
      window.__knLink.unmappedChannels++;
    }
    let l = links.get(owner);
    if (!l) links.set(owner, (l = { link: net.link(), timer: null, dcs: [] }));
    ch = net.channel(l.link, dc.label);
    ch.pumped = l;
    l.dcs.push([dc, ch]);
    channels.set(dc, ch);
    return ch;
  };
  const pump = (l) => {
    l.timer = null;
    const now = performance.now();
    for (const [dc, ch] of l.dcs) {
      for (const data of net.take(ch, now)) {
        try {
          if (dc.readyState === 'open') orig.call(dc, data);
        } catch (_) {}
      }
    }
    arm(l);
  };
  const arm = (l) => {
    const at = net.wakeAt(l.link, performance.now());
    if (at === Infinity) return;
    clearTimeout(l.timer);
    l.timer = setTimeout(() => pump(l), Math.max(0, at - performance.now()));
  };
  // What a channel has been handed by send() and not yet sent is its
  // bufferedAmount. On `sync-state`, everything still in the simulated
  // network for it, held or on the link or in flight: the engine hands its
  // resync state over a chunk at a time, waiting for bufferedAmount to fall
  // below a low-water mark (KNCore.syncSend), and without this the queue hid
  // a held answer from it, and on release the whole of it, 2.9 MB with the
  // next answer behind it, went into the connection at once. On the other
  // channels, only the bytes the capped link has not carried yet (none
  // without LINK_KBPS): those are the channel's own unsent bytes, as on a
  // congested real connection, while bytes in flight are not, so the input
  // channels' own buffer checks (DC-FALLBACK) see what they would see there.
  const realBuffered = Object.getOwnPropertyDescriptor(RTCDataChannel.prototype, 'bufferedAmount');
  const bytesOf = (data) => (typeof data === 'string' ? data.length : (data?.byteLength ?? data?.size ?? 0));
  Object.defineProperty(RTCDataChannel.prototype, 'bufferedAmount', {
    configurable: true,
    get() {
      const real = realBuffered.get.call(this);
      const ch = channels.get(this);
      if (!ch) return real;
      return real + (this.label === 'sync-state' ? net.queued(ch) : net.unsent(ch, performance.now()));
    },
  });
  // DELAY_SYNC_ANSWER_MS: once the test sets window.__knHoldSyncAnswerMs, the
  // next numbered answer to a resync request on the `sync-state` channel is
  // held that long. The channel's order keeps the header and the binary
  // chunks that follow it behind it, so they are released in order after it;
  // the other channels' messages do not wait for it, until it is on the link.
  // That channel carries state transfers only, never input.
  window.__knHoldSyncAnswerMs = 0;
  window.__knSyncAnswersHeld = [];
  // LOSE_INPUTS_BEFORE_FALLBACK: once the test sets window.__knLoseRbInputs,
  // every binary input sent on `rollback-input` (the unordered input channel)
  // is dropped before it reaches the simulated link (it is neither queued
  // nor counted there), and its frame (the packet's first word) kept.
  window.__knLoseRbInputs = false;
  window.__knRbInputsLost = [];
  RTCDataChannel.prototype.send = function (data) {
    if (window.__knLoseRbInputs && this.label === 'rollback-input' && data instanceof ArrayBuffer) {
      if (data.byteLength >= 4) window.__knRbInputsLost.push(new Int32Array(data, 0, 1)[0]);
      return;
    }
    const ch = scheduleOf(this);
    let hold = 0;
    if (
      window.__knHoldSyncAnswerMs > 0 &&
      this.label === 'sync-state' &&
      typeof data === 'string' &&
      data.startsWith('sync-answer-id:')
    ) {
      hold = window.__knHoldSyncAnswerMs;
      window.__knHoldSyncAnswerMs = 0;
      window.__knSyncAnswersHeld.push({ answer: data, heldAt: performance.now(), ms: hold });
    }
    net.send(ch, data, bytesOf(data), hold, performance.now());
    arm(ch.pumped);
  };
};

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

const mkPage = async (browser, name, { throttleHz = 0, hidden = false, suspendAudio = false } = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  // As source text: the link schedule is a function, which an init script's argument cannot carry.
  await ctx.addInitScript({
    content: `(${initScript})(${JSON.stringify({ lat: LAT, jitter: JITTER, kbps: LINK_KBPS })}, ${createLinkSchedule});`,
  });
  if (throttleHz) await ctx.addInitScript(throttleInitScript, throttleHz);
  if (hidden) await ctx.addInitScript(hiddenInitScript);
  if (suspendAudio) await ctx.addInitScript(suspendAudioInitScript);
  // Every run: the observers' client events are counted from these.
  await ctx.addInitScript(recordEventsInitScript);
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
  hidden: HIDE_GUEST_MS > 0,
  suspendAudio: SUSPEND_GUEST_AUDIO,
});
await host.goto(`${URL}/play.html?room=${room}&host=1&name=Host&mode=rollback${QUERY}`);
await host.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
await guest.goto(`${URL}/play.html?room=${room}&name=Guest${QUERY}`);
await guest.waitForSelector('#overlay', { state: 'visible', timeout: 20000 });
for (const p of [host, guest]) await p.locator("#rom-drop input[type='file']").setInputFiles(ROM);
await host.waitForSelector('#start-btn:not([disabled])', { timeout: 60000 });
ROM_HASH = (await host.evaluate(() => window.KNState?.romHash)) || '';
if (!MENU_AUTOPILOT) {
  MENU_AUTOPILOT = ROM_HASH && ROM_HASH !== SSB64_US_HASH ? 'any-fighter' : 'ssb64';
  if (MENU_AUTOPILOT === 'any-fighter') console.log('ROM is not SSB64 US: MENU_AUTOPILOT=any-fighter');
}
console.log('room', room, 'both ROM-ready; starting');
// LOSE_INPUTS_BEFORE_FALLBACK: the host broadcasts the transport when the game starts.
if (LOSE_INPUTS_BEFORE_FALLBACK) await host.evaluate(() => (window._knTransportOverride = 'unreliable'));
await host.click('#start-btn');

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
  await p.evaluate(
    (args) => {
      const { role, VISUAL_CHECK, ADDRESS_MAP_CHECK, ADDRESS_MAP_OF, anyFighter } = args;
      const W = (window.__tp = {
        role,
        hashes: {},
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
        orig(slot, keyMap, heldKeys);
        const f = frameNow();
        const sc = (rb.readRdram32(0x800a4ad0) >>> 24) & 0xff;
        W.scene = sc;
        if (rom && f % 30 === 0 && W.mapSamples.at(-1)?.f !== f) sampleMap(f);
        if (sc !== 22) {
          // Space button presses by the input delay so a press lands (and the
          // closed loop sees it) before the next one; sticks pass through.
          const d = (rb.getHudCounters?.()?.delay ?? 2) + 6;
          let inp = actor(f);
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
        // A sync rewind (frame goes down with no replay running) makes hashes
        // already recorded at or after the new frame stale; re-record them.
        if (idle && W.lastR !== undefined && r < W.lastR) {
          for (const k of Object.keys(W.hashes)) if (+k >= r - 12) delete W.hashes[k];
        }
        if (idle) W.lastR = r;
        if (idle && r > 40) {
          const f = r - 12;
          if (!(f in W.hashes))
            W.hashes[f] = [
              m._kn_gameplay_hash(f) >>> 0,
              m._kn_full_state_hash(f) >>> 0,
              (m._kn_game_state_hash?.(f) ?? 0) >>> 0,
            ];
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
    { role, VISUAL_CHECK, ADDRESS_MAP_CHECK, ADDRESS_MAP_OF, anyFighter: MENU_AUTOPILOT === 'any-fighter' },
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
const dropPeer = { hostAt: null, guestAt: null, hostFrame: 0, closed: null };
const delaySyncAnswer = { hostAt: null, guestAt: null, timedOut: false, askedAgainAfterMs: null };
// LOSE_INPUTS_BEFORE_FALLBACK: where each page's sync log stood when the drops began.
const loseBeforeFallback = { hostAt: null, guestAt: null, fellBack: false, rounds: 0 };
// LINK_KBPS on its own: where the logs stood when the guest asked for its plain resync.
const linkResync = { hostAt: null, guestAt: null, applied: false };
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
  } else if (DROP_PEER_MS > 0) {
    const before = (BATTLE_SECONDS * 1000) / 3;
    await host.waitForTimeout(before);
    const started = Date.now();
    [dropPeer.hostAt, dropPeer.guestAt] = await Promise.all([lastLogLine(host), lastLogLine(guest)]);
    const frameNow = () => window.NetplayRollback.getHudCounters().currentFrame;
    dropPeer.hostFrame = await host.evaluate(frameNow);
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
      await guest.evaluate(() => window.dispatchEvent(new Event('online')));
      delaySyncAnswer.askedAgainAfterMs = Date.now() - started;
      console.log(`DELAY_SYNC_ANSWER_MS: guest timed out and asked again ${delaySyncAnswer.askedAgainAfterMs} ms in`);
    } else {
      console.log('DELAY_SYNC_ANSWER_MS: the guest never logged RESYNC-REQUEST-TIMEOUT');
    }
    await waitForLine(guest, delaySyncAnswer.guestAt.seq, /sync #\d+ applied/, DELAY_SYNC_ANSWER_RECOVER_MS);
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
      inBattleAt: window.__tp.inBattleAt,
      menuInputs: window.__tp.menuInputs,
      delay: window.NetplayRollback.getHudCounters?.()?.delay ?? null,
      extraDelay: window.NetplayRollback.getHudCounters?.()?.extraDelay ?? null,
      frame: window.NetplayRollback.getHudCounters().currentFrame,
      fpsWindowStart: window.__tp.fpsWindowStart,
      fpsWindowEnd,
      clog: m.UTF8ToString(m._kn_get_debug_log()),
      sync: window.NetplayRollback.exportSyncLog?.() || '',
      syncAnswersHeld: window.__knSyncAnswersHeld ?? [],
      rbInputsLost: window.__knRbInputsLost ?? [],
      link: window.__knLink ?? null,
      rollbacks: m._kn_get_rollback_count?.(),
      failed: m._kn_get_failed_rollbacks?.(),
      // 64 KB RDRAM blocks kn_game_state_hash leaves out (of 128).
      taintedBlocks: m._kn_get_tainted_block_count?.() ?? null,
      mapRom: window.__tp.mapRom,
      mapScenes: window.__tp.mapScenes,
      mapOngoing: window.__tp.mapOngoing,
      mapLiveHeaderPointer: window.__tp.mapLiveHeaderPointer,
      mapSamples: window.__tp.mapSamples,
      visual,
    };
  }, VISUAL_CHECK);
const [H, G] = await Promise.all([collect(host, VISUAL_CHECK), collect(guest, VISUAL_CHECK)]);
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
const resyncs = [...G.sync.matchAll(/sync #\d+ applied \(frame \d+ -> (\d+)/g)].map((m) => +m[1]);
const bootSyncFrame = crossEngine && resyncs.length ? resyncs[0] : 0;
const recoveredAt = FREEZE_MS > 0 ? (resyncs.length ? resyncs[resyncs.length - 1] : Infinity) : bootSyncFrame;
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
const recoveries =
  FREEZE_MS > 0
    ? []
    : linkStarvedFrames
      ? withoutLinkStarved(frozenRecoveries({ host: H.sync, guest: G.sync }), linkStarvedFrames)
      : frozenRecoveries({ host: H.sync, guest: G.sync });
let framesExcluded = 0,
  mismatchesExcluded = 0;
// DROP_PEER_MS: the reconnect as the logs show it, after the drop. From 12
// frames before the drop (the hashes trail the head by 12) to the frame the
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
      from: Math.min(dropPeer.hostFrame, dropPeer.closed?.frame ?? dropPeer.hostFrame) - 12,
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
  // The guest's second request (its second network change) must come before
  // the held answer's header reaches it, or the answer was not late.
  const asks = guestLines.flatMap((line, i) => (/network change detected/.test(line) ? [i] : []));
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
    stallResyncs: [...linesIn(hostLines, /INPUT-STALL-RESYNC/), ...linesIn(guestLines, /INPUT-STALL-RESYNC/)],
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
// DESYNC_GUEST holds its change for 3 s. A rollback in that time re-runs
// frames from before the change with the change already in memory, so the
// hashes and digests of up to a rollback window of earlier frames (22, the
// engine's rollbackMax) carry it too. Those belong to the change.
const DESYNC_REACHES_BACK_FRAMES = 22;
const battleFrom = Math.max(H.inBattleAt, G.inBattleAt);
for (const f of Object.keys(H.hashes)) {
  const a = H.hashes[f],
    b = G.hashes[f];
  if (!b || !a[0] || !b[0] || +f < recoveredAt) continue;
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
// _requestLifecycleFullResync skipped fast-forward/resync while C rollback
// was active ("rollback mode — no fast-forward/resync").
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
// Finalized battle frames both peers could have hashed (hashing trails the
// head by 12 frames); coverage below 80% means the comparison proves little.
const spanFrom = Math.max(battleFrom, recoveredAt);
const battleSpan = battleFrom > 0 ? Math.min(H.frame, G.frame) - 12 - spanFrom + 1 : 0;
const battleCoverage = battleSpan > 0 ? Math.min(1, battleCompared / battleSpan) : 0;

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
    if (!gb || f < recoveredAt) continue;
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
  engineDelay: { host: delayOf(H.sync), guest: delayOf(G.sync) },
  integrityEvents: { host: bad(H.clog) + bad(H.sync), guest: bad(G.clog) + bad(G.sync) },
  bootInputStallTimeouts: { host: bootInputStallTimeoutsOf(H.sync), guest: bootInputStallTimeoutsOf(G.sync) },
  tickStuck: { host: count(H.sync, /TICK-STUCK/g), guest: count(G.sync, /TICK-STUCK/g) },
  hashCompare: {
    framesCompared: both,
    battleFramesCompared: battleCompared,
    battleCoverage: +battleCoverage.toFixed(3),
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
if (delaySyncAnswerReport) summary.delaySyncAnswer = delaySyncAnswerReport;
if (LOSE_INPUTS_BEFORE_FALLBACK) summary.loseBeforeFallback = loseBeforeFallbackReport;
if (linkReport) summary.link = linkReport;
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
  lines.forEach((l, i) => {
    if (marker.test(l)) from = i;
  });
  return from < 0
    ? 0
    : lines.slice(from + 1).filter((l) => {
        // A line the engine's C log wrote is copied here in batches, under
        // the frame of the copy. The frame it concerns is the one it names
        // (myF=), as cIntegrityAfterRecovery reads the same line below.
        const named = l.includes('[C] ') ? l.match(/myF=(\d+)/) : null;
        const f = named ? +named[1] : +(l.split('\t')[2] || '').replace('f=', '');
        return f >= recoveredAt + 30 && count(l, INTEGRITY) > 0;
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
    return !m || +m[1] >= recoveredAt + 30;
  }).length;
};
const postRecoveryIntegrity =
  FREEZE_MS > 0
    ? integrityAfterRecovery(H.sync, /coord sync dispatch/) +
      integrityAfterRecovery(G.sync, /sync #\d+ applied/) +
      cIntegrityAfterRecovery(H.clog, null) +
      cIntegrityAfterRecovery(G.clog, /kn_set_frame: \d+/)
    : 0;
if (FREEZE_MS > 0)
  console.log('post-recovery integrity events:', postRecoveryIntegrity, 'battle frames compared:', battleCompared);
const integrityFailed =
  FREEZE_MS > 0
    ? !Number.isFinite(recoveredAt) || postRecoveryIntegrity > 0 || battleCompared < POST_RECOVERY_MIN_FRAMES
    : (H.failed || 0) + (G.failed || 0) - excusedIntegrity.failedRollbacksExcluded > 0 ||
      summary.integrityEvents.host + summary.integrityEvents.guest - excusedIntegrity.integrityEventsExcluded > 0;
const minGameFpsFailed = MIN_GAME_FPS !== null && (!(gameFps.host >= MIN_GAME_FPS) || !(gameFps.guest >= MIN_GAME_FPS));
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
// A disagreement is what the fault modes exist to find: it fails the run like a mismatch.
const observersFailed = observerDisagreements > 0 || !!observers.db?.error;
console.log(
  observersFailed ? 'OBSERVERS: disagreement reported (or KN_DB unreadable):' : 'OBSERVERS: no disagreement:',
  JSON.stringify(observers),
);
const failed =
  addressMapFailed ||
  linkFailed ||
  dropPeerFailed ||
  delaySyncAnswerFailed ||
  loseBeforeFallbackFailed ||
  observersFailed ||
  signalingDropFailed ||
  gpMis > 0 ||
  gsMis > 0 ||
  summary.bootInputStallTimeouts.host > 0 ||
  summary.bootInputStallTimeouts.guest > 0 ||
  integrityFailed ||
  H.inBattleAt < 0 ||
  G.inBattleAt < 0 ||
  battleCoverage < 0.8 ||
  (VISUAL_CHECK && visualCheck.corrupted > 0) ||
  minGameFpsFailed ||
  (THROTTLE_GUEST && !throttleFlipped) ||
  hideGuestFailed ||
  suspendGuestAudioFailed;
process.exit(failed ? 1 : 0);
