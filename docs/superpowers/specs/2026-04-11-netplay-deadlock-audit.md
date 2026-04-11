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

Three invariants are codified in code and documentation. A new file
`docs/netplay-invariants.md` explains them; `CLAUDE.md` gets a pointer;
inline comments at each stall site name the invariant they satisfy.

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

### I3 — Tick watchdog is the last line of defense

A single wall-clock watchdog at the top of `tick()` fires when
`_frameNum` has not incremented in `TICK_WATCHDOG_MS` (5000ms) while
`_running && !_lateJoinPaused`. On fire:

1. Log `TICK-WATCHDOG` with the stuck frame, elapsed ms, and a
   snapshot of every candidate stall state (`_rbPendingInit`,
   `_syncTargetFrame`, `_awaitingResync`, `_bootStallFrame`,
   in-flight `_scheduledSyncRequests`).
2. If guest: request immediate `sync-request-full` to host.
3. If host: force-fall-through — unblock pacing throttles, clear
   `_bootStallFrame`, let the main loop advance a frame so scheduled
   captures can fire.
4. Reset the watchdog timer so it won't fire again for at least
   `TICK_WATCHDOG_MS`.

This invariant exists because I1 requires enumerating every stall
site — and enumeration is inductive reasoning. The watchdog is a
deductive backstop: even if we miss a stall, the game cannot be
frozen for more than 5 seconds.

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

Ordered by dependency: watchdog first (backstop), reset consolidation
next (enables clean reconnect semantics), then specific stalls.

### MF1 — Tick watchdog (I3)

Add `_tickWatchdogLastFrame`, `_tickWatchdogLastAdvanceAt`, constant
`TICK_WATCHDOG_MS = 5000`, and a check at the top of `tick()`:

```javascript
// I3: Tick watchdog. If the frame counter has not advanced in
// TICK_WATCHDOG_MS while running, the tick loop is stuck. Log a
// diagnostic snapshot and trigger recovery.
const _tickNow = performance.now();
if (_running && !_lateJoinPaused) {
  if (_frameNum !== _tickWatchdogLastFrame) {
    _tickWatchdogLastFrame = _frameNum;
    _tickWatchdogLastAdvanceAt = _tickNow;
  } else if (_tickNow - _tickWatchdogLastAdvanceAt > TICK_WATCHDOG_MS) {
    _tickWatchdogFire(_tickNow);
    _tickWatchdogLastAdvanceAt = _tickNow; // cooldown
  }
}
```

`_tickWatchdogFire()` emits `TICK-WATCHDOG` with a snapshot, then
routes to guest-side immediate resync or host-side force-advance.
Test: with MF1 alone, all pre-existing deadlock classes must recover
within 5s. `analyze_match.py` gets a TICK-WATCHDOG counter.

**Verification:** Playwright two-tab test — start a rollback match,
kill host DC during boot, assert both tabs log TICK-WATCHDOG and
recover within 10s.

### MF2 — `resetPeerState(slot, reason)` consolidation (I2)

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

### MF3 — `_rbPendingInit` timeout (A2, D1)

Add a deadline inside `window._rbDoInit` registration. If
`_rbPendingInit` is still true after `RB_INIT_TIMEOUT_MS` (3000ms)
and the guest has not received `rb-delay:`, fall back to locally
computed delay with a `RB-INIT-TIMEOUT` warning log. Guest enters
rollback with its own delay estimate — host will either accept it
(they'll share a DELAY_FRAMES value because both use the same RTT
math) or trigger a resync once asymmetry is detected.

This is not ideal (symmetric delay was a load-bearing fix —
`project_c_rollback_working.md` item 9) but is strictly better than
infinite freeze, and the watchdog I3 backs it up.

**Verification:** Playwright two-tab — start rollback, kill host DC
before its `rb-delay:` sends, assert guest logs RB-INIT-TIMEOUT and
resumes within 3s.

### MF4 — Coord-sync target deadline (A3, B1, D2)

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

### MF5 — INPUT-STALL drop → resync (A7)

Current behavior: after 5s INPUT-STALL, fabricate ZERO_INPUT and
continue. Late arrivals are dropped. Result: host and guest have
permanently different inputs for those frames → silent desync.

New behavior: after 5s INPUT-STALL, fabricate ZERO_INPUT **and**
request full resync. The fabrication keeps the game moving; the
resync corrects the divergence.

**Verification:** Playwright two-tab — induce sustained input loss
via `knDiag.blockInputs(2000ms)`, assert game recovers to matching
hash after resync, no permanent desync.

### MF6 — Late-join pause timeout (D3)

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

### V1 — TICK-WATCHDOG telemetry (continuous)

The watchdog itself is ground truth. Every test scenario below must
end with `analyze_match.py` showing `TICK-WATCHDOG` count = 0 (or
only fires matching the intended fault injection). `analyze_match.py`
gains a TICK-WATCHDOG detection in section 6 (network health) and
section 8 (freeze detection).

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
| MF1 | Kill DC during boot (`knDiag.killDc(0)` at frame 10) | Both tabs resume within 10s, TICK-WATCHDOG logged once |
| MF2 | Reconnect after mid-game drop | No PEER-PHANTOM on recovered peer after state reset |
| MF3 | Block host's rb-delay send (`knDiag.blockMessages('rb-delay:')`) | Guest logs RB-INIT-TIMEOUT and enters rollback within 3s |
| MF4 | Stall guest at frame < targetFrame | Host fires COORD-SYNC-TIMEOUT, state applied immediately |
| MF5 | Block inputs for 6s (`knDiag.blockInputs(6000)`) | Game recovers to matching hash within 10s |
| MF6 | Large state on late join | Either both progress within 10s or both cleanly recover |

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
   I1/I2/I3 in prose with cross-references to code.
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
5. **`tools/analyze_match.py`** — new detection sections for
   TICK-WATCHDOG, RB-INIT-TIMEOUT, COORD-SYNC-TIMEOUT,
   LATE-JOIN-TIMEOUT, WORKER-STALL, RESYNC-LIVELOCK.
6. **Changelog entry** — `CHANGELOG.md` records MF1-MF6 as
   `fix(netplay): eliminate deadlock class ...` per conventional
   commits.

## Implementation order (Phase 2)

Each MF is its own commit. Each commit is verified against a fresh
test session with `analyze_match.py` showing no regressions before
moving on. Playwright two-tab test passes before any deploy.

1. **MF1 — Tick watchdog** (backstop first; everything after is
   safer because the watchdog is live)
2. **MF2 — `resetPeerState` consolidation** (enables clean
   reconnects for subsequent fixes)
3. **MF3 — `_rbPendingInit` timeout**
4. **MF4 — Coord-sync target deadline**
5. **MF5 — INPUT-STALL → resync**
6. **MF6 — Late-join timeout tuning + worker timeout**
7. **Documentation commits** — `netplay-invariants.md`, CLAUDE.md,
   inline stall-site comments, analyze_match.py updates
8. **SF1-SF5** — bundled in one followup commit each
9. **NH1-NH4** — optional, bundled if time permits

## Risks and mitigations

- **Watchdog false positives.** Legitimate long stalls (paused tab,
  user alt-tabbed, late-join in progress) must not trip it. Mitigation:
  gate on `!_lateJoinPaused` and skip when `document.hidden`. If false
  positives still occur, raise `TICK_WATCHDOG_MS` rather than weaken
  detection.
- **`resetPeerState` missing a field.** Any per-peer state not listed
  is a silent bug. Mitigation: grep audit of all `[slot]`-indexed
  variables before merge; add a unit test that enumerates expected
  reset fields.
- **RB-INIT-TIMEOUT asymmetric delay.** Falls back to local delay
  estimate instead of host's authoritative value. May cause rollback
  asymmetry. Mitigation: the subsequent resync fixes divergence; the
  watchdog catches it if not.
- **Coord-sync deadline premature firing.** 3s may be too short on
  poor networks where capture legitimately takes 2-3s. Mitigation:
  start with 3s, instrument via analyzer, tune based on real sessions.

## Out of scope for this spec

- WebRTC DC reconnect over live Socket.IO signaling
  (`project_webrtc_reconnect_plan.md`) — separate effort.
- Delta resync / checkpoint reconciliation — not shipped; not
  required by any MUST FIX.
- Rewriting the tick loop as an explicit state machine — nice-to-have
  long-term but out of scope.
- Formal verification / TLA+ modeling — overkill for the scale.
