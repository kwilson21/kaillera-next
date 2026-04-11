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
