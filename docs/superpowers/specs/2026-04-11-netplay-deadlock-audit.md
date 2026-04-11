# Netplay Deadlock & Race-Condition Audit

**Date:** 2026-04-11
**Status:** Proposed design, pending approval
**Trigger:** Commit `788add0` — BOOT-LOCKSTEP + coord-sync deadlock
in room `1Q6ZF7N6`

## Problem

A playtest produced a permanent freeze where a guest's DataChannel
died during rollback boot convergence. The guest reconnected and sent
`sync-request-full-at:${frame+15}`, which asked the host to capture
state at frame 129. The host was stuck at frame 117 in BOOT-LOCKSTEP
waiting for the guest's frame 110 input (which had been in flight when
the DC died). Host's frame counter never reached 129 — scheduled sync
never fired — both peers deadlocked forever.

Commit `788add0` fixed that specific chicken-and-egg (immediate sync
on reconnect, clear stale `_remoteInputs`, 3s BOOT-LOCKSTEP timeout).
This spec is the broader followup: **eliminate the entire class of
bugs, not just that instance.** An audit of `web/static/netplay-lockstep.js`
(8,332 lines) surfaced ~10 unbounded or incompletely-bounded stall
sites and incomplete per-peer cleanup on DC death. Any of them can
produce a forever-freeze under the right network conditions.

## Goal

Zero unbounded waits in the netplay tick loop. Every reconnect starts
from a known-clean peer state. A runtime backstop catches anything
slipping through. Everything is documented so future-us does not
re-introduce the same bugs.

## Non-goals

- No new netplay features.
- No refactor of tick-loop structure beyond what's needed to enforce
  the invariants.
- No unit-test infrastructure buildout — we use the real two-tab
  stack plus a session-log replay fixture.
- No rewrite of `hardDisconnectPeer` callers — they continue to call
  `hardDisconnectPeer`; that function internally routes through the
  new `resetPeerState`.

## Invariants

Two invariants are codified in code and documentation. A new file
`docs/netplay-invariants.md` explains them; `CLAUDE.md` gets a pointer;
inline comments at each stall site name the invariant they satisfy.

A third element — a tick watchdog — exists solely as a **detection
and logging aid**, not a recovery mechanism. It emits rich diagnostic
state when a freeze persists beyond a deadline, but takes no action.
Its job is to make residual deadlocks loud enough to diagnose, not to
hide them. See MF6 below.

### I1 — No stall without a timeout

Every `return` in the tick loop that waits on a condition must have:

1. **A wall-clock deadline** (`performance.now()`-based).
2. **A recovery action** when the deadline expires.
3. **An inline comment** stating what is being waited on, the deadline
   value, and the recovery action.

"Stall" means an early return or awaited promise that depends on
external events (DC message arrival, peer connection state, remote
frame progress, state decompression completion). Logic branches that
return based purely on local state (`if (!_running) return;`) are not
stalls.

### I2 — Reconnect starts clean

A single function `resetPeerState(slot, reason)` owns all per-peer
state cleanup. Every disconnect, reconnect, phantom-clear, and
game-stop path routes through it. It clears:

- `_remoteInputs[slot]`
- `_peerInputStarted[slot]` (host only — guests wait for roster)
- `_lastRemoteFramePerSlot[slot]`
- `_peerLastAdvanceTime[slot]`
- `_peerPhantom[slot]`
- `_consecutiveFabrications[slot]`
- `_auditRemoteInputs[slot]`
- `_inputLateLogTime[slot]`
- `_pendingCInputs[slot]` (if present)
- ack state (`peer.lastAckFromPeer`, `peer.lastAckSentFrame`,
  `peer.lastAckAdvanceTime`)
- `_scheduledSyncRequests` entries targeting the slot's sid
- `_bootStallFrame` tracking if the missing slot matches

The function's header docstring enumerates every cleared field and
the invariant it upholds. Adding new per-peer state that is NOT
cleared in `resetPeerState` is a code-review-level violation.

### Rejected alternative — auto-recovery watchdog

An earlier draft proposed a top-level watchdog that would force
recovery (guest-side immediate resync, host-side force-advance) if
`_frameNum` had not incremented in 5s. This was rejected:

- It masks root causes. A deadlock that recovers "silently" via
  watchdog looks normal in aggregate; we lose the signal that tells
  us a specific stall site is misbehaving.
- It creates a temptation to stop diagnosing. If the safety net
  catches everything, there is no pressure to find the actual bug.
- It is at odds with `feedback_no_js_cascade_fix.md`: symptom-level
  recovery is a dead end; fix forward from root cause.

A **detection-only** watchdog is different — it logs rich diagnostic
state and takes no action. The game still freezes for the user, the
bug is still visible, but we get enough telemetry to find and fix it.
That version is included as MF6.

## Audit findings

Every finding includes file:line, one-line description, worst case,
and classification (MUST FIX / SHOULD FIX / NICE).

### Category A — Tick-loop early returns

| # | Line | Code | Waits on | Worst case | Class |
|---|------|------|----------|------------|-------|
| A1 | [netplay-lockstep.js:5562](web/static/netplay-lockstep.js#L5562) | `if (_lateJoinPaused) return;` | Late-joiner's state load + ready signal | Host frozen forever if joiner's DC dies mid-transfer and the 200ms resume timeout at line 4285 was already consumed | MUST |
| A2 | [netplay-lockstep.js:5569](web/static/netplay-lockstep.js#L5569) | `if (window._rbPendingInit) return;` | Host's `rb-delay:` DC broadcast → `window._rbDoInit()` | Guest tick loop frozen forever if host DC closes before broadcast arrives | MUST |
| A3 | [netplay-lockstep.js:5574-5604](web/static/netplay-lockstep.js#L5574-L5604) | `if (_syncTargetFrame > 0 && _frameNum >= _syncTargetFrame) { ... stall in _awaitingResync ... }` | State arrival at a future-targeted frame | Coord-sync deadlock: frame pacing prevents reaching target, state never captured. This is the class the 788add0 fix addressed only at boot. | MUST |
| A4 | [netplay-lockstep.js:5985](web/static/netplay-lockstep.js#L5985) | `return; // BOOT-LOCKSTEP` | All peers' input at `_frameNum - DELAY_FRAMES` during boot | Boot freeze. 788add0 added 3s BOOT-DEADLOCK-RECOVERY at line 5959-5978 that sends `sync-request-full` — but if send fails (DC error) or host's matching capture code path is itself stalled, recovery does not complete. | MUST (harden recovery) |
| A5 | [netplay-lockstep.js:6009](web/static/netplay-lockstep.js#L6009) | `return; // RB-INPUT-STALL` | Rollback peer's input or `PEER_DEAD_MS` elapse | Semi-bounded (5000ms until phantom marked). Can oscillate on/off phantom boundary indefinitely when network is marginal. | SHOULD |
| A6 | [netplay-lockstep.js:6933](web/static/netplay-lockstep.js#L6933) | `return; // INPUT-GAP-FILL` | Input gap fabrication completion | Bounded per-frame. | SHOULD (review) |
| A7 | [netplay-lockstep.js:7017-7020](web/static/netplay-lockstep.js#L7017-L7020) | `return; // INPUT-STALL (lockstep)` | Remote input or 5s timeout → fabricate ZERO_INPUT | Bounded, **but late input is silently dropped** after timeout, producing permanent divergence that looks like a desync to players. | MUST (change drop to resync) |
| A8 | [netplay-lockstep.js:7137-7147](web/static/netplay-lockstep.js#L7137-L7147) | `if (_awaitingResync) { ... 3s timeout ... }` | `_pendingResyncState` arrival | Resumes after 3s without corrected state; next desync re-triggers, loop repeats. Not a hard deadlock but a livelock. | SHOULD |

### Category B — Scheduled deferred operations

Operations keyed to "do X when we reach frame N," where the frame
counter can stop advancing.

| # | Line | Operation | Keyed on | Worst case | Class |
|---|------|-----------|----------|------------|-------|
| B1 | [netplay-lockstep.js:3158](web/static/netplay-lockstep.js#L3158) | `_scheduledSyncRequests.push({ targetFrame, ... })` | `_frameNum >= targetFrame` | Host's scheduled capture never fires if tick loop stalls before reaching target frame. Guest waits forever for state. | MUST (same fix as A3) |
| B2 | [netplay-lockstep.js:2649](web/static/netplay-lockstep.js#L2649), [3113](web/static/netplay-lockstep.js#L3113) | Guest sets `_syncTargetFrame = _frameNum + SYNC_COORD_DELTA` | Local frame advance | Same as A3: target unreachable under local stall. | MUST (covered by A3) |

### Category C — Promises without timeouts

| # | Line | Promise | Timeout? | Worst case | Class |
|---|------|---------|----------|------------|-------|
| C1 | [netplay-lockstep.js:2460-2461](web/static/netplay-lockstep.js#L2460-L2461), [3412-3413](web/static/netplay-lockstep.js#L3412-L3413) | `peer.pc.createOffer()`, `setLocalDescription()` | No | WebRTC negotiation hang. Existing PC state-change timeout (10s) catches connection failure but not the offer promise itself. | SHOULD |
| C2 | [netplay-lockstep.js:2537-2542](web/static/netplay-lockstep.js#L2537-L2542) | `setRemoteDescription` + `drainCandidates` + `createAndSendAnswer` | No | Same as C1. | SHOULD |
| C3 | [netplay-lockstep.js:1964](web/static/netplay-lockstep.js#L1964) | `audioWorklet.addModule()` | No | Audio init hangs on 404/CORS (fires before game starts, so not a gameplay deadlock but a boot deadlock). | NICE |
| C4 | [netplay-lockstep.js:4005-4021](web/static/netplay-lockstep.js#L4005-L4021) | `indexedDB.open`, `IDBTransaction` | Resolve(null) on error, not on hang | IDB hang on quota/cache exhaustion. | NICE |
| C5 | workerPost() sites (~7385, 7401, 7416, 7462, 7477) | Compression worker round-trip | No | State-transfer stall if worker hangs. Large contributor to late-join timeout violations. | SHOULD |

### Category D — Cross-peer coordination

| # | Locations | Coordination | Failure mode | Class |
|---|-----------|--------------|--------------|-------|
| D1 | `_rbPendingInit` (5130) ↔ `rb-delay:` handler (2978) ↔ `_rbDoInit` (4431) | Guest defers C-rollback init until host broadcast | If host DC closes before broadcast, guest freezes forever at A2 | MUST |
| D2 | Coord sync (A3) ↔ scheduled capture (B1) | Both peers reach target frame before state is captured/applied | If either side stalls on input before reaching target frame | MUST |
| D3 | `_lateJoinPaused` (5562) ↔ `late-join-ready` message (2856) | Host pauses tick while joiner loads state; resumes on message or 200ms timeout (4285) | 200ms is shorter than decompression time; timeout exists but fires too early. If `late-join-ready` is lost and joiner's DC dies, host resumes but joiner is in unknown state | MUST (tune timeout + add joiner-side watchdog) |
| D4 | Roster broadcast (3330) | All guests must receive roster before stalling on missing input | Asymmetric roster state causes different stall/fabricate decisions across peers, hidden desyncs | SHOULD |

### Category E — Incomplete state cleanup on DC death

Currently only `_remoteInputs[slot]` and (host-only)
`_peerInputStarted[slot]` are cleared in `hardDisconnectPeer`. These
remain stale:

- `_lastRemoteFramePerSlot[slot]` — pollutes phantom detection
- `_peerPhantom[slot]` — persists until explicit PEER-RECOVERED
- `_peerLastAdvanceTime[slot]` — triggers false re-phantom detection
- `_consecutiveFabrications[slot]` — affects stall logic
- `_auditRemoteInputs[slot]` — pollutes audit log
- `_inputLateLogTime[slot]` — spams INPUT-LATE after reconnect
- `_pendingCInputs[slot]` (where applicable)
- `peer.lastAckFromPeer`, `peer.lastAckSentFrame`,
  `peer.lastAckAdvanceTime` on the new peer object after reconnect

Commit 788add0 manually clears `_remoteInputs[peer.slot]` at
[line 2771](web/static/netplay-lockstep.js#L2771) on reconnect —
confirming this is a real bug class. A single `resetPeerState(slot)`
function (I2) replaces all ad-hoc cleanup.

**Class:** MUST (I2 is the fix).

### Category F — Event handlers that might never fire

These are the "external arrival" sources the tick loop depends on.
Most are addressed by I1+I3 because any stall that depends on one
gets a deadline via I1 (if we can name the stall) or the watchdog via
I3 (if we cannot).

- F1: `ch.onopen` (2661) — DC formation. No direct timeout.
  Boot sequence has a 30s overall timeout (3598) that covers it.
  **Class:** acceptable as-is.
- F2: `rb-delay:` handler (2978). Covered by A2.
- F3: `sync-request`/`sync-start`/`sync-chunk` handlers (3134, 3216).
  Covered by A3/A8.
- F4: `late-join-pause`/`late-join-resume`/`late-join-ready`
  handlers (2846-2859). Covered by D3.
- F5: `rb-transport:` broadcast (2998). Default is 'reliable' so a
  lost broadcast is silently safe. **Class:** NICE (document only).
- F6: Roster broadcast (3318). Covered by D4.

## Must-fix plan

Ordered by dependency. `resetPeerState` first because every
subsequent fix depends on clean reconnect semantics. Then each
specific stall site is eliminated at its root.

### MF1 — `resetPeerState(slot, reason)` consolidation (I2)

Create the function. Audit every `delete _remoteInputs[`,
`_peerPhantom[`, `_lastRemoteFramePerSlot[`, `_consecutiveFabrications[`,
etc. Replace with `resetPeerState(slot, reason)`. Call sites:

- `hardDisconnectPeer` (3304)
- Reconnect resync (2771)
- Tab-visibility resync (5356)
- `stop()` (cleanup path)
- `attemptReconnect` on new peer object

The function's docstring enumerates every cleared field with a
comment linking back to invariant I2.

**Verification:** `analyze_match.py` check — after DC rotation in a
real session, no PEER-PHANTOM events fire for the recovered peer
because `_peerLastAdvanceTime` is fresh.

### MF2 — `_rbPendingInit` timeout (A2, D1)

Add a deadline inside `window._rbDoInit` registration. If
`_rbPendingInit` is still true after `RB_INIT_TIMEOUT_MS` (3000ms)
and the guest has not received `rb-delay:`, fall back to locally
computed delay with a `RB-INIT-TIMEOUT` warning log. Guest enters
rollback with its own delay estimate — host will either accept it
(they'll share a DELAY_FRAMES value because both use the same RTT
math) or trigger a resync once asymmetry is detected.

This is not ideal (symmetric delay was a load-bearing fix —
`project_c_rollback_working.md` item 9) but is strictly better than
infinite freeze. If the fallback delay differs from what the host
would have broadcast, the next hash mismatch triggers a resync that
converges both peers.

**Verification:** Playwright two-tab — start rollback, kill host DC
before its `rb-delay:` sends, assert guest logs RB-INIT-TIMEOUT and
resumes within 3s.

### MF3 — Coord-sync target deadline (A3, B1, D2)

`_syncTargetFrame` needs a wall-clock deadline independent of frame
progress. Add `_syncTargetDeadlineAt = performance.now() + SYNC_COORD_TIMEOUT_MS`
(3000ms) when setting `_syncTargetFrame`. In tick(), if the deadline
expires without reaching target:

- Guest: drop the target, apply any `_pendingResyncState` immediately
  at current frame (snap = non-zero, logged as COORD-SYNC-TIMEOUT).
- Host: process the next `_scheduledSyncRequests` entry immediately
  at current frame rather than waiting for `targetFrame`.

**Verification:** Replay session logs from `1Q6ZF7N6` — the coord
sync should have fired within 3s instead of deadlocking. Analyzer
must surface COORD-SYNC-TIMEOUT events.

### MF4 — INPUT-STALL drop → resync (A7)

Current behavior: after 5s INPUT-STALL, fabricate ZERO_INPUT and
continue. Late arrivals are dropped. Result: host and guest have
permanently different inputs for those frames → silent desync.

New behavior: after 5s INPUT-STALL, fabricate ZERO_INPUT **and**
request full resync. The fabrication keeps the game moving; the
resync corrects the divergence.

**Verification:** Playwright two-tab — induce sustained input loss
via `knDiag.blockInputs(2000ms)`, assert game recovers to matching
hash after resync, no permanent desync.

### MF5 — Late-join pause timeout (D3)

200ms is too short — state decompression on mobile can take 500ms+.
Raise host's `_lateJoinPaused` timeout at
[line 4285](web/static/netplay-lockstep.js#L4285) to 10000ms but
**actually wait for `late-join-ready`** from the joiner rather than a
blind setTimeout. If `late-join-ready` doesn't arrive within 10s, log
`LATE-JOIN-TIMEOUT`, resume without the joiner, and
`hardDisconnectPeer()` the joiner so they can retry fresh.

Joiner-side: wrap worker decompression in `Promise.race` against a
10s timeout to prevent unbounded C5.

**Verification:** Playwright two-tab — force mobile-path state on
late join (large compressed state), assert both host and joiner make
progress within 10s or both recover cleanly on failure.

### MF6 — Detection-only tick watchdog (diagnostic aid, ships last)

**Purpose: find the deadlocks we missed.** Not recovery, not masking.
If a stall gets past MF1-MF5, this watchdog makes it loud enough
that we can diagnose it from logs alone. It ships **last**, after
every root-cause fix has landed, so any time it fires the answer is
"we have a new bug to find" not "the watchdog is doing its job."

Add wall-clock tracking at the top of `tick()`:

```javascript
// MF6: Detection-only watchdog. Logs diagnostic state when the tick
// loop has been stuck for TICK_STUCK_WARN_MS / TICK_STUCK_ERROR_MS.
// Takes NO recovery action — its only job is to surface residual
// deadlocks we haven't found yet. If this fires in production, we
// have a real bug to diagnose; the fix belongs in the relevant
// MF category (or a new one), not here.
const _tickNow = performance.now();
if (_running && !_lateJoinPaused && !document.hidden) {
  if (_frameNum !== _tickStuckLastFrame) {
    _tickStuckLastFrame = _frameNum;
    _tickStuckLastAdvanceAt = _tickNow;
    _tickStuckWarnFired = false;
    _tickStuckErrorFired = false;
  } else {
    const stuckMs = _tickNow - _tickStuckLastAdvanceAt;
    if (stuckMs > TICK_STUCK_ERROR_MS && !_tickStuckErrorFired) {
      _tickStuckErrorFired = true;
      _emitTickStuckSnapshot('error', stuckMs);
    } else if (stuckMs > TICK_STUCK_WARN_MS && !_tickStuckWarnFired) {
      _tickStuckWarnFired = true;
      _emitTickStuckSnapshot('warn', stuckMs);
    }
  }
}
```

`_emitTickStuckSnapshot()` logs a `TICK-STUCK` event (deliberately
not named `TICK-WATCHDOG` to make its passive role explicit)
containing:

- Current `_frameNum`, stuck ms, severity (warn/error)
- Every candidate stall state: `_rbPendingInit`, `_syncTargetFrame`,
  `_awaitingResync`, `_awaitingResyncAt`, `_bootStallFrame`,
  `_bootStallStartTime`, `_lateJoinPaused`, `_skipFrameAdvance`
- Peer snapshot: for each slot, `_lastRemoteFramePerSlot`,
  `_peerPhantom`, `_peerLastAdvanceTime`, ack state,
  `dc.readyState`, `dc.bufferedAmount`
- In-flight `_scheduledSyncRequests` entries
- Inferred cause (the handler decides which of the above flags is
  most likely the culprit and includes it in the log message)

Thresholds: `TICK_STUCK_WARN_MS = 2000` (early warning),
`TICK_STUCK_ERROR_MS = 5000` (something is genuinely wrong).

Gates:

- Skip while `_lateJoinPaused` (legitimate pause covered by MF5)
- Skip while `document.hidden` (tab backgrounded — legitimate stall)
- Skip during the first 2 seconds after `tick()` starts (warmup)
- One warn per stuck-frame-continuity (resets when frame advances)
- One error per stuck-frame-continuity

**No recovery action.** The user still sees the freeze, still reports
it, still feels the bug. We just get the telemetry we need to diagnose
it. If `TICK-STUCK` fires in production, the fix belongs in one of the
MF categories (or a new one), not in the watchdog itself.

`analyze_match.py` gains `TICK-STUCK` detection — count, severity,
inferred cause breakdown — in the freeze-detection section. Alerting
on `TICK-STUCK error` in production is the monitoring-level signal
that "something we thought we fixed isn't fixed."

**Verification:** Playwright two-tab — manually introduce a freeze
(revert one of the other fixes temporarily), assert `TICK-STUCK` log
appears with correct diagnostic fields. In CI after MF1-MF5 land,
verify `TICK-STUCK` count is **zero** across all scenarios — non-zero
count means we shipped a bug.

## Should-fix plan (bundled after must-fixes)

### SF1 — WebRTC promise timeouts (C1, C2)

Wrap `createOffer`/`setLocalDescription`/`setRemoteDescription` in
`Promise.race` with 10s timeout; on timeout, `hardDisconnectPeer()`.
Boot path gets its own 30s cap (already exists at line 3598).

### SF2 — Worker round-trip timeout (C5)

`workerPost()` wrapped in `Promise.race` with 5s timeout. On timeout,
log `WORKER-STALL`, treat as worker failure (fall back to
uncompressed path where possible, else `hardDisconnectPeer` the
affected peer).

### SF3 — RB-INPUT-STALL oscillation dampening (A5)

Phantom entry should be sticky for at least 1s once entered; re-entry
requires a fresh 5s PEER_DEAD_MS window. Prevents churn when a peer
is marginal.

### SF4 — Roster broadcast ack (D4)

Each guest acks roster receipt; host retries per-guest for 3s before
giving up. Prevents asymmetric stall decisions from a lost roster.

### SF5 — `_awaitingResync` livelock (A8)

When 3s timeout fires and state hasn't arrived, send a second
`sync-request-full` before resuming. If **that** also times out, log
`RESYNC-LIVELOCK` and hardDisconnect the remote — better to drop the
peer than livelock.

## Nice-to-have

- NH1 — IndexedDB hang handling (C4): `Promise.race` with 3s timeout.
- NH2 — Audio worklet load timeout (C3): 5s timeout, fall back to
  no-audio mode.
- NH3 — `rb-transport:` broadcast ack (F5): optional; default is safe.
- NH4 — Migrate `hardDisconnectPeer` callers to pass explicit
  `reason` strings so `analyze_match.py` can attribute disconnects.

## Verification harness

Three complementary layers, none of which requires new infra.

### V1 — Analyzer coverage

Every MUST FIX introduces a specific recovery event:
`RB-INIT-TIMEOUT`, `COORD-SYNC-TIMEOUT`, `INPUT-STALL-RESYNC`,
`LATE-JOIN-TIMEOUT`, `PEER-RESET` (from `resetPeerState`).
`tools/analyze_match.py` gains detection for each. A passing
verification run is one where the analyzer surfaces the recovery
event exactly when fault injection triggers it and zero otherwise.
No "silent recoveries" — every recovery path is named, logged, and
counted.

### V2 — Session-log replay fixture

`tools/replay_session.py` (new): loads JSONL from
`/admin/api/session-logs/{id}/export` for room `1Q6ZF7N6`, walks the
event timeline, asserts the BOOT-DEADLOCK-RECOVERY path fires within
3s and the subsequent sync-request-full lands. This is a **regression
lock** on the exact bug that triggered the audit — if future work
breaks recovery, the replay fails.

The fixture is checked in under `tests/fixtures/1Q6ZF7N6.jsonl`
(sanitized). Replay runs in CI as a pure Python test — no browser
needed.

### V3 — Playwright two-tab spot-checks

One scenario per MUST FIX:

| Scenario | Fault injection | Assertion |
|----------|-----------------|-----------|
| MF1 | Reconnect after mid-game drop | No PEER-PHANTOM on recovered peer; PEER-RESET logged with full field list |
| MF2 | Block host's rb-delay send (`knDiag.blockMessages('rb-delay:')`) | Guest logs RB-INIT-TIMEOUT and enters rollback within 3s |
| MF3 | Stall guest at frame < targetFrame | Host fires COORD-SYNC-TIMEOUT, state applied immediately at current frame |
| MF4 | Block inputs for 6s (`knDiag.blockInputs(6000)`) | INPUT-STALL-RESYNC fires, game converges to matching hash within 10s |
| MF5 | Large state on late join | Either both progress within 10s or LATE-JOIN-TIMEOUT fires and both cleanly recover |
| MF6 | Artificial freeze (revert one MF temporarily) | `TICK-STUCK` log fires with full snapshot. In all MF1-MF5 scenarios above, `TICK-STUCK` count must be zero. |

Implementation: extend `tests/design-mode.html` or create
`tests/deadlock-harness.html` exposing `knDiag` hooks:

- `knDiag.killDc(slot)` — close specified peer's DC
- `knDiag.blockMessages(prefix)` — swallow outbound DC messages
  matching prefix
- `knDiag.blockInputs(ms)` — suspend input send for N ms
- All hooks are test-mode-gated (require `?debug=1` query param)

Each scenario is a standalone `.spec.mjs` under `tests/deadlock/`;
Playwright runs them against the existing two-tab flow. Per
`feedback_playwright_before_deploy`, this suite runs before every
deploy that touches netplay code.

## Documentation

1. **`docs/netplay-invariants.md`** — new top-level doc describing
   I1/I2 in prose with cross-references to code, plus a section
   explaining why a global watchdog was rejected.
2. **`CLAUDE.md`** — add "Netplay invariants" subsection pointing to
   the doc.
3. **Inline comments** — every stall site gets a block comment naming
   its invariant, deadline, and recovery action. Format:

   ```javascript
   // I1: Stall waiting for <what>.
   // Deadline: <N>ms via <mechanism>.
   // Recovery: <what happens on timeout>.
   // See docs/netplay-invariants.md §<section>.
   return;
   ```

4. **`resetPeerState` docstring** — enumerates every cleared field;
   adding new per-peer state without updating `resetPeerState` is a
   code-review violation.
5. **`tools/analyze_match.py`** — new detection for PEER-RESET,
   RB-INIT-TIMEOUT, COORD-SYNC-TIMEOUT, INPUT-STALL-RESYNC,
   LATE-JOIN-TIMEOUT, TICK-STUCK (warn/error), WORKER-STALL,
   RESYNC-LIVELOCK.
6. **Changelog entry** — `CHANGELOG.md` records MF1-MF6 as
   `fix(netplay): eliminate deadlock class ...` per conventional
   commits.

## Implementation order (Phase 2)

Each MF is its own commit. Each commit is verified against a fresh
test session with `analyze_match.py` showing no regressions before
moving on. Playwright two-tab test passes before any deploy.

1. **MF1 — `resetPeerState` consolidation** (enables clean
   reconnects for every fix that follows)
2. **MF2 — `_rbPendingInit` timeout**
3. **MF3 — Coord-sync target deadline**
4. **MF4 — INPUT-STALL → resync**
5. **MF5 — Late-join timeout tuning + worker timeout**
6. **MF6 — Detection-only watchdog** (last — ships after every
   root-cause fix so `TICK-STUCK` becomes a trustworthy signal that
   we have a *new* bug, not a known one)
7. **Documentation commits** — `netplay-invariants.md`, CLAUDE.md,
   inline stall-site comments, analyze_match.py updates
8. **SF1-SF5** — bundled in one followup commit each
9. **NH1-NH4** — optional, bundled if time permits

## Risks and mitigations

- **`resetPeerState` missing a field.** Any per-peer state not listed
  is a silent bug. Mitigation: grep audit of every `[slot]`-indexed
  variable in `netplay-lockstep.js` before merge; enumerate expected
  reset fields in a comment and verify against the function body in
  code review. Adding new per-peer state in future work without
  updating `resetPeerState` must be treated as a review blocker.
- **RB-INIT-TIMEOUT asymmetric delay.** Falls back to local delay
  estimate instead of host's authoritative value. May cause rollback
  asymmetry. Mitigation: the subsequent hash-mismatch → resync path
  converges both peers; we instrument `RB-INIT-TIMEOUT` so we can
  measure how often the fallback fires and whether it produces
  follow-on resyncs.
- **Coord-sync deadline premature firing.** 3s may be too short on
  poor networks where capture legitimately takes 2-3s. Mitigation:
  start with 3s, instrument via analyzer, tune based on real sessions.
  Start generous and tighten, not the other way around.
- **MF4 fires too often under marginal WiFi.** INPUT-STALL-RESYNC
  will churn if real input loss is common. Mitigation: exponential
  cooldown on consecutive resync requests from the same peer; log
  `INPUT-STALL-COOLDOWN` so we can see it in the analyzer.
- **Watchdog becomes a crutch.** The MF6 watchdog is detection-only
  by design — if we ever feel tempted to "just make it auto-recover,"
  we must first re-read the rejected-alternatives section. Recovery
  inside the watchdog is the exact failure mode this spec rejects.
  Monitoring for `TICK-STUCK` in production is fine; silencing it via
  auto-recovery is not.

## Out of scope for this spec

- WebRTC DC reconnect over live Socket.IO signaling
  (`project_webrtc_reconnect_plan.md`) — separate effort.
- Delta resync / checkpoint reconciliation — not shipped; not
  required by any MUST FIX.
- Rewriting the tick loop as an explicit state machine — nice-to-have
  long-term but out of scope.
- Formal verification / TLA+ modeling — overkill for the scale.
