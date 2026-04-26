# Netplay Invariants

The netplay stack ([web/static/netplay-lockstep.js](../web/static/netplay-lockstep.js))
enforces two invariants that together eliminate the class of
DataChannel-death freeze bugs uncovered by the 2026-04-11 audit. This
document is the canonical reference — inline comments at each stall
site point back here. A passive tick watchdog (MF6) surfaces any
residual deadlock that slips past these invariants, but it does
**not** take recovery action.

## I1 — No stall without a timeout

Every `return` in `tick()` that waits on an external event (DC message
arrival, peer connection state, remote frame progress, state
decompression) must have:

1. A wall-clock deadline, typically based on `performance.now()`.
2. A recovery action when the deadline expires.
3. An inline comment stating what is being waited on, the deadline
   value, and the recovery action.

"Stall" means an early return that depends on external events. Pure
local-state branches (`if (!_running) return;`) are not stalls.

### Sites with timeouts

| Stall | Constant | Recovery | Event | Spec |
|-------|----------|----------|-------|------|
| `_rbPendingInit` (guest defers rollback init on host's `rb-delay:` broadcast) | `RB_INIT_TIMEOUT_MS = 3000` | Fall back to local delay and init anyway | `RB-INIT-TIMEOUT` | §MF2 |
| `_syncTargetFrame` (guest holds state for coordinated frame-boundary apply) | `SYNC_COORD_TIMEOUT_MS = 3000` | Drop target, apply pending state at current frame (non-coord branch) | `COORD-SYNC-TIMEOUT` | §MF3 |
| `_scheduledSyncRequests` entries (host captures state at scheduled target frame) | `SYNC_COORD_TIMEOUT_MS = 3000` | Dispatch request at current frame | `COORD-SYNC-TIMEOUT` | §MF3 |
| `INPUT-STALL` hard-timeout (fabricate ZERO_INPUT after input missing) | `MAX_STALL_MS + RESEND_TIMEOUT_MS = 5000` | Fabricate AND request full resync so divergence converges | `INPUT-STALL-RESYNC` | §MF4 |
| `_lateJoinPaused` (host pauses tick loop while late-joiner loads state) | `LATE_JOIN_TIMEOUT_MS = 15000` | Resume, broadcast roster, `hardDisconnectPeer()` the joining peer | `LATE-JOIN-TIMEOUT` | §MF5 |
| Late-join worker round-trip (joiner decompresses initial state) | `LATE_JOIN_TIMEOUT_MS = 15000` | Abort late-join; host's timeout cleans up the joiner | `WORKER-STALL` | §MF5 |
| BOOT-LOCKSTEP stall (pure-lockstep boot convergence) | 3000ms (in tick loop) | Guest requests immediate `sync-request-full` | `BOOT-DEADLOCK-RECOVERY` | commit 788add0 |
| `_awaitingResync` (guest waiting for state after coord stall) | 3000ms | Resume without corrected state (known livelock, see SF5) | (timeout log only) | spec SF5 |
| `_framePacingActive` (pacing throttle skipping frame advance) | `PACING_THROTTLE_TIMEOUT_MS = 5000` | Force-phantom slowest peer, release pacing | `PACING-THROTTLE-TIMEOUT` | match f0566d95 |
| Menu-start barrier (Smash Remix: suppress input until all peers confirm controllable scene) | `MENU_START_BARRIER_SETTLE_MS = 500` (via `_menuStartReleaseAt = nowMs + MENU_START_BARRIER_SETTLE_MS`) | Set `_menuStartBarrierReleased = true`, release barrier | `MENU-BARRIER released` | commit 2 (feat(rollback): menu-start barrier) |

## I2 — Reconnect starts clean

A single function `resetPeerState(slot, reason, opts)` owns all
per-peer state cleanup. Every disconnect, reconnect, phantom clear,
tab-visibility reset, and game-stop path routes through it.

### Fields cleared

**Slot-indexed globals** (keyed by player slot 0-3):

- `_remoteInputs[slot]` — input buffer (frame → input map)
- `_peerInputStarted[slot]` — first-input-received flag
- `_lastRemoteFramePerSlot[slot]` — highest received frame
- `_peerLastAdvanceTime[slot]` — wall-clock of last new frame
- `_peerPhantom[slot]` — dead-peer flag
- `_consecutiveFabrications[slot]` — fabrication counter
- `_inputLateLogTime[slot]` — rate-limit timestamp
- `_auditRemoteInputs[slot]` — audit log buffer

**Per-peer-object ack state** (on `_peers[sid]`):

- `peer.lastAckFromPeer`
- `peer.lastFrameFromPeer`
- `peer.lastAckAdvanceTime`

**Shared queues**:

- `_pendingCInputs` (entries filtered by slot)
- `_scheduledSyncRequests` (entries filtered by targetSid when provided)

**Boot-stall tracking** (when currently stalled):

- `_bootStallFrame`, `_bootStallStartTime`, `_bootStallRecoveryFired`

### Call sites

| Call site | Reason string |
|-----------|---------------|
| `hardDisconnectPeer` (host path) | `hard-disconnect` |
| `hardDisconnectPeer` (non-host, roster-gated) | `hard-disconnect-non-host` |
| Reconnect resync (after DC close + rebuild) | `reconnect` |

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
- **Diagnostic tool:** `tools/analyze_match.py` (see `reference_analyze_match.md`) — section 8d surfaces all I1/I2/MF6 recovery events

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

### R3 — Ring coverage within the rollback window

For any frame F where `rb.frame - F <= rb.max_frames`, the ring
buffer must hold valid state for F. As of v0.43.0, state is saved
every frame unconditionally (the previous dirty-input serialize gate
was removed after FATAL-RING-STALE at f=23410 proved that skipping
saves created ring coverage gaps). Violations during a
misprediction-triggered restore log `FATAL-RING-STALE` and throw
in dev (RF7).

### R4 — Post-replay live state equals ring state

After a replay completes at frame N, the emulator's live state
(fresh `retro_serialize` + `kn_gameplay_hash`) must match the ring's
stored hash for frame N. Mismatches log `RB-LIVE-MISMATCH` with both
hashes and throw in dev (RF5).

### R5 — Pre-tick return value consistency

If `rb.replay_depth > 0` after `kn_pre_tick` returns, the return
value must equal 2 (replay frame). A return value of 0 with
`replay_depth > 0` logs `RB-INVARIANT-VIOLATION` and throws in dev
(RF3). This is the smallest defense-in-depth check and ships first
as an insurance policy that would have caught the B190OHFY bug on
the first run regardless of root cause.

### R6 — Audio/video state survives restore

Any subsystem driven by RDRAM contents (AudioWorklet, OpenAL, GL
framebuffer) must either survive `retro_unserialize` intact or be
explicitly re-initialized in the restore sequence. RF6 Part A adds
`lastRb`/`rbDelta`/`resetAudioCalls`/`ctxState`/`workletPort` fields
to the `audio-empty`/`audio-silent` log so the analyzer can infer
whether a cluster of audio-death events correlates with a recent
rollback. RF6 Part B (explicit `kn_reset_audio` in the rollback
restore path) is contingent: ships only if real-session playtesting
shows residual AUDIO-DEATH after RF1-RF5 are in the field.

### Detection events

Every violation of R1-R6 produces a loud analyzer event. Zero of
any of these events across a real session log means the integrity
invariants held.

| Event | Invariant | Spec RF |
|-------|-----------|---------|
| `REPLAY-NORUN` | R2 | RF2 |
| `RB-INVARIANT-VIOLATION` | R5 | RF3 |
| `FATAL-RING-STALE` | R3 | RF7 |
| `RB-LIVE-MISMATCH` | R4 | RF5 |
| `AUDIO-DEATH` (enriched) | R6 diagnostic | RF6 Part A |
