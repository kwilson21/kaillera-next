---
name: Rollback audit session notes
date: 2026-04-07
status: implementation complete, awaiting device test
---

# Rollback audit session — historical record

Conversational record of the rollback audit + improvement session on
2026-04-07. Captures the reasoning, dead-ends considered, and decisions
made, so the next session (or reviewer) can understand *why* the changes
look the way they do, not just *what* they do.

## Context at start of session

The C-level rollback engine had just shipped mobile↔mobile (see
[project_c_rollback_working.md](../../../.claude-memory-placeholder) in
user's auto-memory — 8min clean iPhone↔iPad sync on commit `7b8476f`,
ending on DC drop not desync). User asked for a quick audit comparing our
implementation to GGPO and identifying improvements.

## Audit findings (GGPO vs kaillera-next)

**What we do as well or better than GGPO:**
- **Bit-identical replay** — JS drives `stepOneFrame` for both normal and
  replay ticks via `kn_pre_tick`'s `return 2` contract. Equivalent to
  GGPO's same-code-path guarantee, but uniquely hard across the Asyncify
  boundary.
- **Taint-filtered state hash** — RSP HLE audio and GLideN64 framebuffer
  copyback writes are flagged via `kn_taint_rdram` and skipped when
  computing `kn_game_state_hash`. GGPO's sync-test just hashes the whole
  state and assumes core determinism.
- **SoftFloat FPU + deterministic timing patches** — not a GGPO concern
  (it runs locally-compiled games) but critical for cross-platform WASM
  and mobile Safari.
- **Symmetric delay negotiation** — host broadcasts `rb-delay:N` and
  guests defer `kn_rollback_init` until it arrives. GGPO peers can drift
  on their view of delay; we can't.
- **Replay determinism self-test** (`kn_replay_self_test`) — equivalent
  to GGPO's sync test with dual-hash comparison.

**Gaps identified:**

1. **Frame-advantage stalling / timesync** — GGPO stalls local sim for 1
   frame when local is >=2 frames ahead of remote. We had *RTT-based
   delay at game start* but (at first reading) nothing during the match.
   **Update mid-audit:** discovered the existing proportional-throttle
   pacing at [netplay-lockstep.js#L4582](../../../web/static/netplay-lockstep.js#L4582)
   already handles this with smoothing and per-excess-level skip ratios.
   Audit was incomplete — gap #1 is effectively already fixed.
2. **Reliable DC head-of-line blocking** — WebRTC reliable DCs retransmit
   in-order, so a single dropped packet delays all subsequent inputs by
   RTT+. GGPO solves this with unreliable UDP + per-packet input
   redundancy (last ~8 frames). We were using fully reliable, no
   redundancy. **Biggest unaddressed gap.**
3. **Amortized replay vs preemption race** — the amortized-replay path
   holds new `pending_rollback` until `replay_remaining == 0`. If a newer
   (earlier-frame) misprediction arrives mid-replay, we finish the stale
   catch-up before correcting, burning frames on known-wrong state.
4. **No last-confirmed-frame bound on state ring** — we mod by
   `ring_size` and accept `FAILED-ROLLBACK` as silent desync. GGPO's
   `sync.MAX_PREDICTION_FRAMES` stalls the sim if it would predict past
   the confirmed window. In practice covered by (1)'s existing pacing.
5. **`failed_rollbacks` is a counter with no action** — on silent desync
   we log and increment a stat, but don't trigger any recovery. The
   existing host-authoritative resync path from lockstep would be a
   trivial safety net.
6. `rb-check` sent every hash frame scales O(N²) with player count —
   cosmetic for 2P, wasteful at 4P.
7. `rollbackMax = min(20, max(12, delay+8))` is 2–3× GGPO's typical 7–8
   frame window. Tuned for mobile network jitter; could shrink with
   frame-advantage + redundancy wins.
8. **Prediction strategy = last-known-input repeat** — same as GGPO but
   potentially suboptimal for SSB64's stick-flick smash attack style.
   The only item with real design freedom.

## Decision: defer prediction strategy until we have data

Initial instinct was to ideate SSB64-specific prediction heuristics
(button-release bias, stick-decay, velocity extrapolation, misprediction
cost weighting, etc.). User correctly pushed back: **"would collecting
real input data from games be the best way to inform us of the most
effective prediction strategy?"** Yes.

Verified the existing input audit recorder
([netplay-lockstep.js#L789-L829](../../../web/static/netplay-lockstep.js#L789-L829))
captures raw uncontaminated human input on BOTH sides:

- **Local inputs** recorded in the tick loop via `readLocalInput()`
  *before* `kn_pre_tick`. Never touched by prediction.
- **Remote inputs** recorded from the decoded WebRTC packet on receipt,
  *before* `kn_feed_input`. That's the peer's raw input from their side.

Audit data is uncontaminated. Delta-encoded. Uploaded with session log
on every flush. We already have match recordings from every rollback
game played to date.

**Decision: prediction strategy = follow-up session.** Add richer
telemetry this session so the next batch of matches produces better data.
Then analyze, then design, then implement. No guessing.

## Priority list acted on this session

1. **T1-T4: Telemetry** — folded in at user request so next matches
   produce analyzable data without rebuild
2. **P3: Preemptive rollback** — C-level, small, isolated
3. **P1: Frame-advantage / ring safety** — downgraded to defensive log
   after discovering existing proportional pacing already solves it
4. **P4: Silent-desync → resync wiring** — glue between C counter and
   existing resync path
5. **P2: Host-negotiated unreliable DC + redundancy** — biggest change

**Deferred:**
- Prediction strategy (#8) — waits for data
- `rb-check` sampling rate (#6) — cosmetic until 4P
- `rollbackMax` tuning (#7) — wait to see if P1/P2 let us shrink it
- WebRTC DC reconnect on signaling survival — separate plan in
  `project_webrtc_reconnect_plan.md`

## Design decisions and rationale

### P2 transport negotiation: host-authoritative via broadcast

User picked option (c) over (a) always-on or (b) flagged rollout:

> host-negotiated like `rb-delay` — host picks reliable vs unreliable at
> match start and broadcasts, so both peers always agree. Most robust,
> slightly more code.

Rationale: consistent with how we already negotiate delay, guarantees
both peers agree on transport, and works with the existing deferred-init
pattern on guests.

### P2 implementation: dual DC, not recreation

Three options considered for how to get an unordered DC:

1. Recreate the lockstep DC on mode negotiation — requires new
   offer/answer, brittle
2. Always create an additional unordered DC alongside the lockstep DC,
   use it only when host broadcasts `rb-transport:unreliable`
3. Skip entirely

Chose **(2)**. Cost is one extra DC per peer (cheap). `lockstep` DC stays
ordered for protocol messages (`rb-delay`, `sync-request`, `rb-check`,
`rb-transport` itself). New `rollback-input` DC is unordered with
`maxRetransmits: 0`. The `_pickInputDc(peer)` helper routes outgoing
input to the right DC based on negotiated mode AND verified actual DC
properties (not what we asked for — some browsers historically ignored
init options).

Fallback is automatic: if the unordered DC didn't negotiate with
`ordered === false && maxRetransmits === 0`, we log
`TRANSPORT-MISMATCH` and keep using the reliable DC. Safety > perf.

### P2 wire format: backward-compatible extension

Old format was 5 int32 (20 bytes): `[frame, buttons, lstick, cstick, ackFrame]`.
New format extends to 6-int header + N × 4-int redundancy entries:
`[frame, buttons, lstick, cstick, ackFrame, redCount, ...N×(relFrame, buttons, lstick, cstick)]`.

Old decoders read the first 5 fields correctly and ignore the rest. New
decoders detect `redCount > 0` and decode the tail. Lockstep-mode senders
omit the redundancy tail entirely (waste of bandwidth on reliable DC);
rollback-mode senders emit up to 8 frames of history per packet.

Wire format verified via round-trip tests in `/tmp/wire_test.js`:
- Legacy 5-int32 packets decode correctly
- New format with 0/3/8 redundant frames all round-trip
- Negative analog values survive pack/unpack
- Max redundancy (8 frames) = 152 bytes per packet, well under SCTP limits

### P3 correctness: `rb.frame` re-entry into normal tick

During amortized replay, `rb.frame` walks forward. The preempted restore
targets an earlier frame; new `depth = rb.frame - rb_pending`. After
replay catches up to the preempted `rb.frame`, normal pre_tick resumes
stepping. The "extra" frames (original replay target minus preempted
rb.frame) are re-executed as *normal* ticks, not replay ticks. This is
correct because:

- Normal pre_tick and amortized-replay pre_tick both save state before
  stepping and both invoke `stepOneFrame` via JS
- Normal pre_tick reads stored ring inputs for frames `< rb.frame` (via
  `apply_frame = rb.frame - delay_frames`)
- The only difference is that normal pre_tick *also* stores NEW local
  input for the current frame, which is what we want

So preemption has no "lost frames" problem — just a shift from replay
amortization to normal-tick amortization after the replay window ends.

### P3 bonus fix: RESTORE-FAILED now increments `failed_rollbacks`

The original code logged `RESTORE-FAILED` but didn't bump the counter.
That was an oversight — it's a silent desync just like a stale ring
entry. Incrementing the counter means P4's wiring triggers the resync
path on this case too.

## Files changed

**C (requires WASM rebuild):**
- `build/kn_rollback/kn_rollback.c`:
  - T1: extended `MISPREDICTION` + `FAILED-ROLLBACK` logs with
    `btn_xor`, `lx_d`, `ly_d`, `cx_d`, `cy_d`
  - T2: three new counters (`button_mispredictions`, `stick_mispredictions`,
    `both_mispredictions`), exported via `kn_get_mispred_breakdown`
  - P3: preempt active replay when newer `pending_rollback` is earlier
    than current `replay_start`; log `C-REPLAY-PREEMPT`
  - `RESTORE-FAILED` path now bumps `failed_rollbacks` for P4
- `build/kn_rollback/kn_rollback.h`:
  - Added `kn_get_failed_rollbacks` and `kn_get_mispred_breakdown`

**JS (no rebuild needed):**
- `web/static/shared.js`:
  - `encodeInput` gains optional `redundantFrames` param
  - `decodeInput` detects and parses redundancy tail
  - Backward-compatible with legacy 5-int32 format
- `web/static/netplay-lockstep.js`:
  - New state: `_rbTransport`, `_rbLocalHistory`, `_rbTransportPacketsSent`,
    `_rbTransportDupsRecv`, `_rbLastFailedRollbacks`
  - `rb-transport:` message handler (guests adopt host's mode)
  - Host broadcasts `rb-transport:unreliable` after `rb-delay`
  - Unordered DC (`rollback-input`) created in all 3 createPeerConnection
    sites, handled in all 4 `ondatachannel` sites
  - `setupRollbackInputDataChannel` with T4 logging (actual DC props
    vs requested, `TRANSPORT-MISMATCH` on drift)
  - `_processInputPacket` extracted as shared helper for both DCs
  - `_pickInputDc(peer)` routes outgoing input based on negotiated mode
    AND verified DC properties
  - Tick loop: maintains 8-frame local history ring, attaches as
    redundancy when `_useCRollback && _rbTransport === 'unreliable'`
  - Tick loop: polls `kn_get_failed_rollbacks` after `kn_post_tick`; on
    increase, guest triggers existing `sync-request-full-at:FRAME` path
  - `_buildRollbackStats` helper: pulls T2 breakdown + full counters
  - Flush payload: `summary.rollback` (T2), `summary.rbTransport` (T4),
    `context.rbTransport` (per-match tag)
  - T3: explicit `audit: recording enabled mode=rollback transport=<mode>`
    log at rollback init so the analyzer can filter by mode
  - P1: `RB-RING-NEAR-FULL` defensive warning if raw frame advantage >= 10

## Verification done

- `node -e "new Function(src)"` syntax-checks on both JS files: pass
- `cc -fsyntax-only build/kn_rollback/kn_rollback.c`: pass
- Wire format round-trip tests in `/tmp/wire_test.js`: all 5 test
  scenarios pass (legacy compat, no-red, 3-red, max-red 8 frames,
  negative analog values)

**Deferred to device test (not possible in this environment):**
- Full match run — memory says EJS can't boot in Playwright
- WASM rebuild + unified rollback init
- Real mobile↔mobile test against current 8min baseline
- Session log inspection for the new telemetry fields

## Verification plan for device test

1. **Rebuild WASM** via existing Docker pipeline (`build/build.sh` or
   `build/build-via-orchestrator.sh`), deploy new core.
2. **Lobby smoke test** — create room, join from second device, verify no
   DC errors in console.
3. **rb-transport negotiation** — confirm session log contains:
   - Host: `rb-transport: host broadcast=unreliable`
   - Guest: `rb-transport: host=unreliable adopted=unreliable`
   - Both: `rb-input DC open sid=... ordered=false maxRetransmits=0`
4. **No TRANSPORT-MISMATCH** on either side in the session log.
5. **Start rollback match, play ~1 minute** — verify session log shows:
   - `audit: recording enabled mode=rollback transport=unreliable`
   - Input packets flowing (FPS counter alive)
6. **Inject a misprediction** — any real input divergence should produce
   new-format logs: `MISPREDICTION slot=N f=X myF=Y depth=D btn_xor=0xH lx_d=N ly_d=N cx_d=N cy_d=N`
7. **Session log flush** — verify uploaded payload includes:
   - `summary.rollback.mispredBreakdown = {button, stick, both}`
   - `summary.rbTransport = {mode, packetsSent, dupsRecv, dupRate}`
   - `context.rbTransport = "unreliable"`
8. **Full match target:** ≥10 minute clean iPhone↔iPad sync (current
   baseline: 8min, ended on DC drop, not desync).
9. **Post-match analysis:** pull session logs via admin API, verify
   input audit entries are present and delta-encoded.

## Open questions for follow-up

- **Prediction strategy:** needs data. Once 3-5 real matches upload
  with the new telemetry, write an analysis script that expands the
  delta-encoded audit into a per-frame signal and produces:
  - Button hold duration histograms per button (A, B, Z, R, dpad)
  - Stick deflection duration histograms (flick vs hold)
  - Frame-to-frame delta size distribution
  - Sub-deadzone jitter rate
  - Misprediction breakdown over total predictions
  Then design the targeted intervention based on what the data actually
  shows. No guessing.
- **Unreliable DC cross-browser behavior:** Safari and Firefox may
  negotiate differently from Chromium. T4's TRANSPORT-MISMATCH log will
  tell us immediately. If mismatch happens often, we may need a
  per-browser override.
- **rollbackMax shrinking:** once we have data on how well the new
  pacing + redundancy combo holds up, we may be able to drop
  `rollbackMax` from `delay+8` to `delay+4` and cut state-ring memory
  in half (~160MB → ~80MB on mobile).

## Dead ends considered and rejected

- **Recreating the lockstep DC on mode negotiation** — rejected for
  complexity and brittleness (new offer/answer round-trip mid-connect).
- **Always-on unreliable DC regardless of mode** — rejected; breaks
  lockstep mode's protocol message ordering guarantees.
- **Implementing prediction strategy changes this session** — rejected
  as guessing without data; folded telemetry in instead.
- **Changing the prediction function in C without data** — same reason.
- **Adding a second "frame advantage" mechanism alongside existing
  proportional pacing** — rejected after re-reading code; the existing
  smoothed throttle already handles it. Downgraded P1 to a defensive
  warning log only.

## Commit plan

Single feature commit on `feat/rollback-audit-improvements` worktree.
After device test passes, squash-merge to main; auto-versioning will
bump minor version (feat:).
