---
name: Rollback audit improvements
date: 2026-04-07
status: in-progress
---

# Rollback audit improvements — design

Result of auditing `kn_rollback.c` against GGPO. Four core priority gaps plus
telemetry to unblock a future data-driven prediction design. All changes land
in a single worktree (`feat/rollback-audit-improvements`) and ship together.

## Scope

**In scope:**
- T1-T4: Telemetry additions (misprediction detail, per-category counters, audit verification, transport logging)
- P1: Frame-advantage stalling + sync_frame backpressure (GGPO-style pacing)
- P2: Host-negotiated unreliable DC with input redundancy
- P3: Preemptive rollback during active replay
- P4: Silent-desync → host-authoritative resync wiring

**Out of scope (deferred):**
- Prediction strategy improvements (gap #8) — waits for real input data from T1-T4 telemetry
- WebRTC DC reconnect on live signaling — separate memory entry, separate plan
- Custom libco (ASYNCIFY_REMOVE replacement)
- Native spectator input forwarding

## T1 — Misprediction detail logging

Extend `MISPREDICTION` log in [kn_rollback.c:365](build/kn_rollback/kn_rollback.c#L365)
to include predicted vs actual values. New format:

```
MISPREDICTION slot=%d f=%d myF=%d depth=%d btn_xor=0x%x lx_d=%d ly_d=%d cx_d=%d cy_d=%d
```

`btn_xor = predicted.buttons ^ actual.buttons` (bitmask of flipped buttons).
Deltas are `actual - predicted` for each analog axis. Per-event cost: ~80 bytes.
Expected volume: 100-300 per match → 10-25 KB of log data. Well under 2 MB cap.

## T2 — Per-category prediction counters

Add three counters to `rb` struct:

- `button_mispredictions` — btn_xor != 0 AND all stick deltas == 0
- `stick_mispredictions` — btn_xor == 0 AND any stick delta != 0
- `both_mispredictions` — btn_xor != 0 AND any stick delta != 0

Exported via `kn_get_mispred_breakdown(int *out)` writing 3 ints.
JS flushes in session-log summary alongside existing counters.

Purpose: with T1 giving us *which* mispredictions happen, T2 gives us
aggregate rates per match for quick triage without log expansion.

## T3 — Audit recorder verification in rollback mode

Current audit recorder ([netplay-lockstep.js:789-829](web/static/netplay-lockstep.js#L789-L829))
already captures raw uncontaminated input because:
- `_auditRecordLocal` fires from `readLocalInput()` path, not rollback ring
- `_auditRecordRemote` fires on DC receive, before `kn_feed_input`

No code changes needed — just add a one-line `_syncLog('audit: recording
enabled mode=<lockstep|rollback>')` at match start so session logs clearly
record which mode each audit was captured in. This lets the future analysis
script filter cleanly.

## T4 — Transport negotiation logging

For P2's host-negotiated transport:
- At rollback init, host broadcasts `rb-transport:reliable` or `rb-transport:unreliable` alongside `rb-delay:N`
- Both peers `_syncLog` the received mode AND the actual DC properties (`peer.dc.ordered`, `peer.dc.maxRetransmits`) read from the channel, not the requested values — catches browser quirks
- Include negotiated transport in session-log `context` block alongside `forkedCore`
- On per-peer mismatch (host says unreliable, DC came up reliable), log `TRANSPORT-MISMATCH` error and fall back to reliable for both peers
- Periodic (every 60 frames) `rb-transport-stats` flush entry: packets sent, duplicate frames received. Dup rate is a direct proxy for loss+reorder rate (free packet-loss telemetry from the redundancy mechanism)

## P1 — Frame-advantage stalling + sync_frame backpressure

Two coupled mechanisms that share data.

**Frame-advantage stalling (GGPO timesync):**

Each outgoing input packet includes `_frameNum` as a new field
`senderFrame`. On receipt, peer stores `peer.remoteFrame = senderFrame`.
Compute `localAdvantage = _frameNum - peer.remoteFrame` each tick. If
`localAdvantage >= 2` for any peer, skip local `stepOneFrame()` for this
tick (stall once). Re-check next tick. This caps drift at ~1-2 frames
without changing `delay_frames`.

Log `FRAME-ADVANTAGE-STALL adv=%d peer=%d` on each stall.

**sync_frame backpressure:**

Track `peer.lastConfirmedFrame = max(senderFrame received so far)` per peer.
Compute `sync_frame = min(lastConfirmedFrame for all peers)`. Before
`kn_pre_tick`, if `_frameNum - sync_frame >= max_frames - 1`, stall — we're
about to predict past what the ring can safely roll back. Prevents
`FAILED-ROLLBACK` silent desync.

Log `SYNC-FRAME-STALL frame=%d sync=%d` on each stall.

Both use the same new `senderFrame` field — zero additional packets.
`senderFrame` is already semantically `recvFrame` on the other side (input
packets already carry the frame they're for), so we're just giving that
field a name-level usage for pacing math.

## P2 — Host-negotiated unreliable DC with input redundancy

**Negotiation:**
- Host decides: `reliable` for lockstep mode; `unreliable` for rollback mode (default)
- Host broadcasts `rb-transport:<mode>` at game start alongside `rb-delay:<N>`
- Guests defer DC creation/reconfiguration until the transport broadcast arrives (same deferred-init pattern as `rb-delay`)
- Both peers create DCs with `{ordered: false, maxRetransmits: 0}` when unreliable

**Input redundancy:**
- Every input packet includes the last `REDUNDANCY_FRAMES = 8` frames of local inputs, not just the current frame
- Wire format: append `count` + `count × encodedInput` entries after the current frame's input. Backward-compatible with lockstep decoder if `count == 0`
- Receiver: process each redundant input through existing `kn_feed_input`. Deduplication is automatic — the frame-tag check already rejects stale entries ([kn_rollback.c:479](build/kn_rollback/kn_rollback.c#L479)), and corrections are idempotent
- Increment `_redundantDupsReceived` counter for every redundant entry whose frame ≤ highest already-received frame from that peer (for T4 dup-rate telemetry)

**Fallback:** if `peer.dc.maxRetransmits` comes back non-zero (browser ignored the option), log `TRANSPORT-MISMATCH` and fall back to reliable for both peers. Safety over performance.

## P3 — Preemptive rollback during active replay

In [kn_rollback.c:401](build/kn_rollback/kn_rollback.c#L401), the current
guard `rb.pending_rollback >= 0 && rb.replay_remaining == 0` holds a newer
(earlier) misprediction until the active replay finishes. If the newer
misprediction targets an *earlier* frame than the replay start, we waste
frames replaying known-wrong state.

**Change:** allow preemption when the new pending rollback is *earlier*
than `rb.replay_start`:

```c
if (rb.pending_rollback >= 0 &&
    (rb.replay_remaining == 0 || rb.pending_rollback < rb.replay_start)) {
    /* Restart from earlier frame — discard in-progress replay */
    rb.replay_remaining = 0;
    /* ... existing restore logic ... */
}
```

Correctness: discarding the in-progress replay is safe because we're about
to restart from an earlier frame anyway — any frames we've replayed will be
replayed again as part of the new catch-up window. No state loss because
`retro_unserialize` fully overwrites emulator state.

## P4 — Silent-desync → resync wiring

Currently `FAILED-ROLLBACK` increments `rb.failed_rollbacks` and logs, but
takes no action ([kn_rollback.c:370-378](build/kn_rollback/kn_rollback.c#L370-L378)).
Match silently desyncs.

**Change:** JS polls `kn_get_failed_rollbacks()` in the tick loop (cheap —
it's one int). On any increase, trigger the existing host-authoritative
resync path (same mechanism lockstep uses when desync detection fires).

The resync path already exists and has been validated in lockstep mode —
this is just wiring it into the rollback tick loop as an additional trigger
source. No new resync infrastructure.

## Verification plan

**Playwright (what we can automate on this machine):**
- Lobby create/join flow still works
- Rollback mode still initializes (`rb-delay` + `rb-transport` both broadcast)
- Session-log payload shape includes new fields (`mispredBreakdown`, `transport`, etc.)
- `kn_replay_self_test(30)` still returns 1 (deterministic) after P3 changes
- Synthetic misprediction → verify new MISPREDICTION log format

**Real device (user, post-merge):**
- iPhone↔iPad rollback match, target ≥10 minute clean sync
- Current baseline: 8min ending on DC drop
- Verify session log contains new telemetry fields
- Confirm transport negotiation logged correctly on both peers

## Rollout

Single worktree, single merge to main. No feature flag — user testing on
prod is the release gate. Version bump to minor (feat:) per existing
auto-versioning conventions.
