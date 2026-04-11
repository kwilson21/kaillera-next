# Netplay Deadlock & Race-Condition Audit Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate every unbounded stall and incomplete per-peer cleanup path in `web/static/netplay-lockstep.js`, with exhaustive documentation, so a DataChannel dying at any moment can never freeze the game forever.

**Architecture:** Two codified invariants — I1 ("no stall without a timeout") and I2 ("reconnect starts clean" via a single `resetPeerState` function) — enforced through six commits that fix root causes in dependency order (MF1 peer state → MF2 rb-delay → MF3 coord-sync → MF4 input-stall → MF5 late-join → MF6 detection-only watchdog). Each commit verified against a real two-tab session with `tools/analyze_match.py` showing no regressions.

**Tech Stack:** Vanilla JavaScript (IIFE + window globals, no ES modules per `feedback_no_es_modules.md`), Playwright MCP for two-tab verification, `tools/analyze_match.py` (uv run) for session log analysis, `just deploy` workflow.

**Spec:** [docs/superpowers/specs/2026-04-11-netplay-deadlock-audit.md](../specs/2026-04-11-netplay-deadlock-audit.md)

**Constraints:**
- Modern ECMAScript (const/let, arrow functions, template literals, async/await, optional chaining) — `feedback_ecmascript_modern.md`
- IIFE + window globals required — `feedback_no_es_modules.md`
- Only fix root causes, don't mask symptoms — `feedback_no_js_cascade_fix.md`
- Never deploy without explicit user approval — `feedback_no_deploy_without_testing.md`
- User manages the dev server — don't start/stop it — `feedback_no_server_management.md`
- Always test with Playwright MCP two-tab before claiming anything works — `feedback_playwright_before_deploy.md`

---

## File Structure

Files this plan creates or modifies:

| File | Role | Change |
|------|------|--------|
| `web/static/netplay-lockstep.js` | Main netplay engine | Heavy: add `resetPeerState`, timeouts, watchdog; replace ad-hoc cleanup |
| `docs/netplay-invariants.md` | New invariants reference doc | Create |
| `CLAUDE.md` | Project context | Add "Netplay invariants" subsection with pointer |
| `tools/analyze_match.py` | Match diagnostic tool | Add detection for new event types (PEER-RESET, RB-INIT-TIMEOUT, COORD-SYNC-TIMEOUT, INPUT-STALL-RESYNC, LATE-JOIN-TIMEOUT, WORKER-STALL, TICK-STUCK) |
| `tests/deadlock/*.spec.mjs` | Playwright two-tab regression tests | New directory; one spec per MF verification scenario |

**Test strategy (per `feedback_minimal_tests.md`):** One Playwright two-tab scenario per MUST FIX category. No exhaustive unit-test buildout. The real-stack two-tab harness is the primary verification; `analyze_match.py` is secondary. Session-log replay of `1Q6ZF7N6` is deferred to post-MF6 if the initial MFs leave any residual.

---

## Chunk 1: MF1 — `resetPeerState` consolidation

### Task 1.1: Audit per-peer state fields

**Files:**
- Read: [web/static/netplay-lockstep.js](web/static/netplay-lockstep.js)

- [ ] **Step 1: Grep every slot-indexed and per-peer-object field**

Run:
```bash
grep -nE '_remoteInputs\[|_peerInputStarted\[|_lastRemoteFramePerSlot\[|_peerLastAdvanceTime\[|_peerPhantom\[|_consecutiveFabrications\[|_inputLateLogTime\[|_auditRemoteInputs\[|peer\.(lastAckFromPeer|lastAckSentFrame|lastAckAdvanceTime|lastFrameFromPeer)' web/static/netplay-lockstep.js
```

- [ ] **Step 2: Confirm the canonical list**

Verify the per-peer fields touched anywhere in the file match exactly this set:

**Slot-indexed globals (keyed by slot number):**
1. `_remoteInputs[slot]` — input buffer (object: frame → input)
2. `_peerInputStarted[slot]` — bool, first-input-received flag
3. `_lastRemoteFramePerSlot[slot]` — highest received frame
4. `_peerLastAdvanceTime[slot]` — wall-clock of last new frame (phantom detection)
5. `_peerPhantom[slot]` — bool, dead flag
6. `_consecutiveFabrications[slot]` — fabrication counter
7. `_inputLateLogTime[slot]` — rate-limit timestamp for INPUT-LATE log
8. `_auditRemoteInputs[slot]` — audit log buffer (array)

**Per-peer-object fields (on `_peers[sid]`):**
9. `peer.lastAckFromPeer`
10. `peer.lastFrameFromPeer`
11. `peer.lastAckAdvanceTime`

**Sid-indexed:**
12. `_scheduledSyncRequests` entries filtered by `targetSid`

**Shared queue:**
13. `_pendingCInputs` entries filtered by `slot`

If the grep reveals additional slot-indexed state, add it to the list before proceeding.

- [ ] **Step 3: Find existing cleanup call sites**

Run:
```bash
grep -nE 'delete _remoteInputs\[|delete _peerInputStarted\[|_peerPhantom\[.+\] = false|_remoteInputs = \{\}|_peerInputStarted = \{\}|_peerPhantom = \{\}' web/static/netplay-lockstep.js
```

Expected findings (confirm all present — the actual line numbers may drift, verify by content):
- `hardDisconnectPeer` ([~3316](web/static/netplay-lockstep.js#L3316), [~3320](web/static/netplay-lockstep.js#L3320)) — `delete _remoteInputs[peer.slot]`, `delete _peerInputStarted[peer.slot]`
- Reconnect resync ([~2768](web/static/netplay-lockstep.js#L2768)) — `_remoteInputs[peer.slot] = {}`
- Tab-visibility resync ([~5356](web/static/netplay-lockstep.js#L5356)) — `_remoteInputs = {}`
- `startLockstep` bulk reset ([~4973](web/static/netplay-lockstep.js#L4973), [~4987-4991](web/static/netplay-lockstep.js#L4987-L4991))
- `stop()` bulk reset ([~8062-8086](web/static/netplay-lockstep.js#L8062-L8086))

No code changes yet — this step locks the cleanup sites we will consolidate.

### Task 1.2: Implement `resetPeerState`

**Files:**
- Modify: `web/static/netplay-lockstep.js` — add new function near `hardDisconnectPeer`

- [ ] **Step 1: Add `resetPeerState` function above `handlePeerDisconnect`**

Insert before the `// -- Peer disconnect (drop handling) --` comment block near [line 3257](web/static/netplay-lockstep.js#L3257):

```javascript
  // -- Per-peer state cleanup (Invariant I2) --------------------------------

  /**
   * Resets ALL per-peer state for a given slot. This is the single
   * authoritative cleanup path for peer disconnects, reconnects,
   * phantom clears, tab-visibility resets, and game stop.
   *
   * Invariant I2 ("Reconnect starts clean"): every disconnect,
   * reconnect, or cleanup path must route through this function.
   * Adding new per-peer state without updating this function is a
   * code-review-level violation.
   *
   * See docs/netplay-invariants.md §I2.
   *
   * Fields reset for slot-indexed globals:
   *   - _remoteInputs[slot]          (input buffer)
   *   - _peerInputStarted[slot]      (first-input-received flag)
   *   - _lastRemoteFramePerSlot[slot](highest received frame)
   *   - _peerLastAdvanceTime[slot]   (wall-clock of last new frame)
   *   - _peerPhantom[slot]           (dead-peer flag)
   *   - _consecutiveFabrications[slot] (fabrication counter)
   *   - _inputLateLogTime[slot]      (rate-limit timestamp)
   *   - _auditRemoteInputs[slot]     (audit log buffer)
   *
   * Fields reset for per-peer-object state (if peer provided):
   *   - peer.lastAckFromPeer
   *   - peer.lastFrameFromPeer
   *   - peer.lastAckAdvanceTime
   *
   * Shared queues filtered to remove entries for this slot:
   *   - _pendingCInputs
   *   - _scheduledSyncRequests (filtered by targetSid if sid provided)
   *
   * Boot-stall tracking cleared if this slot matches:
   *   - _bootStallFrame / _bootStallStartTime / _bootStallRecoveryFired
   *
   * @param {number} slot - player slot to clear (0-3)
   * @param {string} reason - short human-readable reason for the reset;
   *   used in PEER-RESET log and analyze_match.py attribution
   * @param {Object} [opts] - optional extras
   * @param {Object} [opts.peer] - peer object to clear ack state on
   * @param {string} [opts.sid] - socket.io sid to filter scheduled syncs
   */
  const resetPeerState = (slot, reason, opts = {}) => {
    if (slot === null || slot === undefined) return;

    // Slot-indexed globals
    delete _remoteInputs[slot];
    delete _peerInputStarted[slot];
    delete _lastRemoteFramePerSlot[slot];
    delete _peerLastAdvanceTime[slot];
    delete _peerPhantom[slot];
    delete _consecutiveFabrications[slot];
    delete _inputLateLogTime[slot];
    delete _auditRemoteInputs[slot];

    // Per-peer-object ack state
    if (opts.peer) {
      opts.peer.lastAckFromPeer = -1;
      opts.peer.lastFrameFromPeer = -1;
      opts.peer.lastAckAdvanceTime = 0;
    }

    // Shared queues — filter out entries for this slot/sid
    for (let i = _pendingCInputs.length - 1; i >= 0; i--) {
      if (_pendingCInputs[i].slot === slot) _pendingCInputs.splice(i, 1);
    }
    if (opts.sid) {
      _scheduledSyncRequests = _scheduledSyncRequests.filter(
        (r) => r.targetSid !== opts.sid,
      );
    }

    // Boot-stall tracking — if we were stalled waiting on this slot's
    // apply frame, clear the tracking so the stall clock restarts
    // cleanly once a new peer fills the slot.
    if (_bootStallFrame >= 0) {
      _bootStallFrame = -1;
      _bootStallStartTime = 0;
      _bootStallRecoveryFired = false;
    }

    _syncLog(`PEER-RESET slot=${slot} reason=${reason}`);
  };
```

- [ ] **Step 2: Run syntax check**

Run:
```bash
node -c web/static/netplay-lockstep.js
```

Expected: no output (syntax valid). If error, fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "$(cat <<'EOF'
feat(netplay): add resetPeerState for unified per-peer cleanup (MF1 part 1)

Introduces a single authoritative cleanup function for per-peer state
(Invariant I2: "Reconnect starts clean"). No call sites switched over
yet — that's the next commit. Establishes the function with full
docstring enumerating every reset field so code review can catch
additions that skip the cleanup path.

See docs/superpowers/specs/2026-04-11-netplay-deadlock-audit.md §MF1.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.3: Route `hardDisconnectPeer` through `resetPeerState`

**Files:**
- Modify: `web/static/netplay-lockstep.js` — `hardDisconnectPeer` function

- [ ] **Step 1: Replace manual cleanup with `resetPeerState` call**

Find the slot-cleanup block inside `hardDisconnectPeer`:

```javascript
    if (peer.slot !== null && peer.slot !== undefined) {
      try {
        writeInputToMemory(peer.slot, 0);
      } catch (_) {}
      delete _remoteInputs[peer.slot];
      // Only host modifies the input roster — non-hosts wait for
      // the host's roster broadcast to remove the slot
      if (_playerSlot === 0 || !_activeRoster) {
        delete _peerInputStarted[peer.slot];
      }
    }
```

Replace with:

```javascript
    if (peer.slot !== null && peer.slot !== undefined) {
      try {
        writeInputToMemory(peer.slot, 0);
      } catch (_) {}
      // Non-hosts preserve _peerInputStarted until the host's roster
      // broadcast removes the slot, so we guard the cleanup call.
      if (_playerSlot === 0 || !_activeRoster) {
        resetPeerState(peer.slot, 'hard-disconnect', { peer, sid: remoteSid });
      } else {
        // Clear everything except _peerInputStarted (roster-gated)
        const startedBefore = _peerInputStarted[peer.slot];
        resetPeerState(peer.slot, 'hard-disconnect-non-host', { peer, sid: remoteSid });
        if (startedBefore) _peerInputStarted[peer.slot] = startedBefore;
      }
    }
```

- [ ] **Step 2: Syntax check**

Run:
```bash
node -c web/static/netplay-lockstep.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "$(cat <<'EOF'
feat(netplay): route hardDisconnectPeer through resetPeerState (MF1 part 2)

Previously hardDisconnectPeer only cleared _remoteInputs and
_peerInputStarted, leaving stale _peerPhantom, _lastRemoteFramePerSlot,
_consecutiveFabrications, _inputLateLogTime, and per-peer ack state.
On reconnect those stale values caused false phantom detection and
spammed INPUT-LATE logs. Now routes through the unified resetPeerState
(I2), with a roster guard to preserve _peerInputStarted when a
non-host is still waiting for the host's roster broadcast.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.4: Route reconnect resync cleanup through `resetPeerState`

**Files:**
- Modify: `web/static/netplay-lockstep.js` — reconnect-resync block near [line 2765](web/static/netplay-lockstep.js#L2765)

- [ ] **Step 1: Find the reconnect cleanup**

Locate the block that was added in commit `788add0`:

```javascript
          // Clear stale remote inputs from before the disconnect. Any inputs
          // in flight when the DC died are gone; keeping them can cause the
          // rollback engine to read stale values after state resync.
          if (_remoteInputs[peer.slot]) {
            _remoteInputs[peer.slot] = {};
          }
```

- [ ] **Step 2: Replace with full `resetPeerState` call**

```javascript
          // Full per-peer reset on DC reconnect. Clears stale inputs,
          // phantom state, ack tracking — everything that could
          // survive the reconnect and cause confusion on the new DC.
          // See Invariant I2.
          if (peer.slot !== null && peer.slot !== undefined) {
            resetPeerState(peer.slot, 'reconnect', { peer, sid: remoteSid });
          }
```

- [ ] **Step 3: Syntax check**

Run:
```bash
node -c web/static/netplay-lockstep.js
```

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "$(cat <<'EOF'
feat(netplay): route reconnect cleanup through resetPeerState (MF1 part 3)

Expands the commit 788add0 reconnect fix from clearing only
_remoteInputs to clearing every per-peer field (phantom, ack state,
audit log, fabrication counter, etc). This is the same code path that
surfaced the original deadlock — now it starts from a guaranteed
clean slate for the new DC.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.5: Two-tab verification for MF1

**Files:**
- Read: existing Playwright test infrastructure under `tests/`

- [ ] **Step 1: Ask the user to run a two-tab session with a forced reconnect**

Message to user:
> "MF1 resetPeerState consolidation is ready. Could you run a fresh two-tab test session and force a DC reconnect mid-game? I want to verify PEER-RESET fires with the correct reason and no PEER-PHANTOM false positive appears on the recovered peer."

Wait for the user to provide a match ID.

- [ ] **Step 2: Analyze the session**

Run (substitute the match ID the user provides):
```bash
cd /Users/kazon/kaillera-next/server && uv run python ../tools/analyze_match.py <match_id>
```

Verify in the output:
- `PEER-RESET` events appear in the event timeline with reasons like `hard-disconnect`, `reconnect`
- **No** `PEER-PHANTOM` event for the recovered peer in the post-reconnect window
- No new desync introduced

If analysis shows regressions, fix before proceeding.

- [ ] **Step 3: Mark MF1 verified in the plan**

Move on to Chunk 2.

---

## Chunk 2: MF2 — `_rbPendingInit` timeout

### Task 2.1: Add wall-clock deadline to `_rbPendingInit`

**Files:**
- Modify: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Read the current `_rbPendingInit` site**

Locate the block near [line 5124](web/static/netplay-lockstep.js#L5124):

```javascript
          if (window._rbHostDelay !== undefined && window._rbHostDelay > 0) {
            DELAY_FRAMES = window._rbHostDelay;
            doRollbackInit(window._rbHostDelay);
          } else {
            window._rbPendingInit = true;
            _syncLog(`C-ROLLBACK deferred: waiting for host rb-delay broadcast...`);
          }
```

- [ ] **Step 2: Add timestamp when entering pending state**

Replace the `else` branch:

```javascript
          } else {
            window._rbPendingInit = true;
            window._rbPendingInitAt = performance.now();
            _syncLog(`C-ROLLBACK deferred: waiting for host rb-delay broadcast...`);
          }
```

- [ ] **Step 3: Add constant near top of the module**

Find the existing timing constants block (search for `DELAY_FRAMES` or `MAX_STALL_MS`) and add:

```javascript
  const RB_INIT_TIMEOUT_MS = 3000; // I1: _rbPendingInit fallback deadline (MF2)
```

- [ ] **Step 4: Add fallback check at top of `tick()`**

Find [line 5569](web/static/netplay-lockstep.js#L5569):

```javascript
    if (window._rbPendingInit) return;
```

Replace with:

```javascript
    // I1: _rbPendingInit deadline (MF2). If the host's rb-delay
    // broadcast never arrives (DC died before send, or message lost),
    // fall back to a locally computed delay after RB_INIT_TIMEOUT_MS
    // so the guest does not freeze forever. The next hash mismatch
    // → resync will converge both peers if the fallback delay
    // differs from what the host would have broadcast.
    // See docs/netplay-invariants.md §I1 and spec §MF2.
    if (window._rbPendingInit) {
      const pendingStart = window._rbPendingInitAt || 0;
      if (pendingStart > 0 && performance.now() - pendingStart > RB_INIT_TIMEOUT_MS) {
        const fallbackDelay = DELAY_FRAMES > 0 ? DELAY_FRAMES : 3;
        _syncLog(
          `RB-INIT-TIMEOUT elapsed=${Math.round(performance.now() - pendingStart)}ms — ` +
          `host rb-delay never arrived, falling back to local delay=${fallbackDelay}`,
        );
        window._rbPendingInit = false;
        window._rbPendingInitAt = 0;
        if (window._rbDoInit) {
          try {
            window._rbDoInit(fallbackDelay);
          } catch (e) {
            _syncLog(`RB-INIT-TIMEOUT fallback init failed: ${e}`);
          }
        }
      } else {
        return;
      }
    }
```

- [ ] **Step 5: Clear timestamp when rb-delay DOES arrive**

Find the `rb-delay:` handler near [line 2978](web/static/netplay-lockstep.js#L2978):

```javascript
            window._rbHostDelay = hostDelay;
            if (window._rbPendingInit && window._rbDoInit) {
              window._rbPendingInit = false;
              DELAY_FRAMES = hostDelay;
              window._rbDoInit(hostDelay);
            }
```

Add a timestamp clear line:

```javascript
            window._rbHostDelay = hostDelay;
            if (window._rbPendingInit && window._rbDoInit) {
              window._rbPendingInit = false;
              window._rbPendingInitAt = 0;
              DELAY_FRAMES = hostDelay;
              window._rbDoInit(hostDelay);
            }
```

- [ ] **Step 6: Syntax check**

Run:
```bash
node -c web/static/netplay-lockstep.js
```

- [ ] **Step 7: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "$(cat <<'EOF'
fix(netplay): add RB_INIT_TIMEOUT_MS deadline on _rbPendingInit (MF2)

Guest previously froze forever if host's rb-delay DataChannel
broadcast was lost or the host DC closed before sending. Now after
3 seconds the guest falls back to a locally-computed delay and
initializes C rollback anyway, logging RB-INIT-TIMEOUT. If the
fallback delay differs from what the host would have broadcast, the
next hash mismatch triggers a resync that converges both peers.

Implements Invariant I1 (no stall without a timeout) for the
_rbPendingInit site; see spec §MF2.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.2: Two-tab verification for MF2

- [ ] **Step 1: Ask user to run a fresh session** (user drives the two-tab test)

Message to user:
> "MF2 ready. I need a two-tab rollback session where you can force the host DC to close before rb-delay is broadcast — easiest way is to refresh the host tab after clicking Start but before the guest's rollback banner appears. I want to see whether the guest logs RB-INIT-TIMEOUT and continues into rollback instead of freezing."

Wait for match ID and user confirmation.

- [ ] **Step 2: Analyze the session**

Run:
```bash
cd /Users/kazon/kaillera-next/server && uv run python ../tools/analyze_match.py <match_id>
```

Verify: `RB-INIT-TIMEOUT` event present in guest's timeline, guest entered rollback mode within ~3s of host disconnect, no frozen tick loop.

---

## Chunk 3: MF3 — Coord-sync target deadline

### Task 3.1: Add wall-clock deadline tracking for `_syncTargetFrame`

**Files:**
- Modify: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Add companion state variables near `_syncTargetFrame`**

Find the declaration near [line 1840](web/static/netplay-lockstep.js#L1840):

```javascript
  let _syncTargetFrame = -1; // guest: hold incoming state until this frame, then apply (or stall)
```

Add below it:

```javascript
  let _syncTargetDeadlineAt = 0; // I1: wall-clock deadline for _syncTargetFrame (MF3)
  const SYNC_COORD_TIMEOUT_MS = 3000;
```

- [ ] **Step 2: Set the deadline whenever `_syncTargetFrame` is set to a positive value**

Find every assignment of `_syncTargetFrame = <frame>` where the value is positive (coord sync) and add a deadline line immediately after. Expected sites (verify by content):

Near [line 2649](web/static/netplay-lockstep.js#L2649):
```javascript
          _syncTargetFrame = _recoveryTarget;
          _syncTargetDeadlineAt = performance.now() + SYNC_COORD_TIMEOUT_MS;
```

Near [line 3113](web/static/netplay-lockstep.js#L3113):
```javascript
            _syncTargetFrame = _coordTarget;
            _syncTargetDeadlineAt = performance.now() + SYNC_COORD_TIMEOUT_MS;
```

Near [line 3158](web/static/netplay-lockstep.js#L3158) in the host's `sync-request-full-at:N` handler — wherever the host parses the coord target frame and sets `_syncTargetFrame`:

```javascript
            _syncTargetFrame = targetFrame;
            _syncTargetDeadlineAt = performance.now() + SYNC_COORD_TIMEOUT_MS;
```

(Verify the grep results before editing. Use `grep -n '_syncTargetFrame = ' web/static/netplay-lockstep.js` to find all assignments.)

- [ ] **Step 3: Clear the deadline when `_syncTargetFrame` is reset to -1**

Every site that does `_syncTargetFrame = -1` should also do `_syncTargetDeadlineAt = 0`. Sites (verify by grep):

- Line ~2660, ~2784, ~3123, ~5368, ~5404, ~5581, ~7142, ~7755, ~8107

Use sed to do this safely:
```bash
grep -n '_syncTargetFrame = -1' web/static/netplay-lockstep.js
```

Then Edit each matching site individually to add the companion line. Do not use `replace_all` because surrounding context differs.

- [ ] **Step 4: Add deadline check in tick() coord-sync block**

Find the block near [line 5574](web/static/netplay-lockstep.js#L5574):

```javascript
    // Async resync: apply buffered state at clean frame boundary.
    // Coordinated injection: hold state until _syncTargetFrame so host and guest
    // both reach that frame before the state is applied — snap = 0.
    if (_syncTargetFrame > 0) {
      if (_frameNum >= _syncTargetFrame) {
```

Insert a deadline check before the frame-boundary check:

```javascript
    // Async resync: apply buffered state at clean frame boundary.
    // Coordinated injection: hold state until _syncTargetFrame so host and guest
    // both reach that frame before the state is applied — snap = 0.
    //
    // I1: coord-sync deadline (MF3). If frame pacing prevents
    // reaching _syncTargetFrame within SYNC_COORD_TIMEOUT_MS, apply
    // the pending state immediately at current frame (snap != 0) or
    // process the scheduled capture immediately. Frame-target waits
    // that can't be reached were the deadlock class from room
    // 1Q6ZF7N6 — this deadline closes that entire class.
    // See docs/netplay-invariants.md §I1 and spec §MF3.
    if (
      _syncTargetFrame > 0 &&
      _syncTargetDeadlineAt > 0 &&
      performance.now() > _syncTargetDeadlineAt
    ) {
      const elapsed = Math.round(performance.now() - (_syncTargetDeadlineAt - SYNC_COORD_TIMEOUT_MS));
      _syncLog(
        `COORD-SYNC-TIMEOUT target=${_syncTargetFrame} f=${_frameNum} ` +
        `elapsed=${elapsed}ms — applying/capturing immediately`,
      );
      _syncTargetFrame = -1;
      _syncTargetDeadlineAt = 0;
      _awaitingResync = false;
      // Fall through: if _pendingResyncState is set, the block below
      // will apply it immediately via the non-coord branch. On host,
      // scheduled captures will fire at the next _scheduledSyncRequests
      // drain because targetFrame <= _frameNum.
    }

    if (_syncTargetFrame > 0) {
      if (_frameNum >= _syncTargetFrame) {
```

- [ ] **Step 5: Syntax check**

Run:
```bash
node -c web/static/netplay-lockstep.js
```

- [ ] **Step 6: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "$(cat <<'EOF'
fix(netplay): add SYNC_COORD_TIMEOUT_MS deadline on _syncTargetFrame (MF3)

Coord-sync previously deadlocked when frame pacing prevented
reaching the target frame — the exact chicken-and-egg class that
commit 788add0 fixed only at the boot-lockstep site. Now every
coord-sync target has a 3-second wall-clock deadline: if the frame
counter can't reach the target in time, the pending state is applied
immediately (snap) or the scheduled capture fires at current frame,
logging COORD-SYNC-TIMEOUT.

This closes the full frame-target-unreachable deadlock class, not
just the boot instance.

Implements Invariant I1 for every _syncTargetFrame site; see spec
§MF3.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.2: Two-tab verification for MF3

- [ ] **Step 1: Ask user to reproduce the coord-sync stall**

Message:
> "MF3 ready. Can you run a two-tab session and force a resync while one tab is stalled on input (e.g., block its network briefly)? I want to see COORD-SYNC-TIMEOUT fire and the state apply at current frame instead of the loop deadlocking."

- [ ] **Step 2: Analyze**

Run:
```bash
cd /Users/kazon/kaillera-next/server && uv run python ../tools/analyze_match.py <match_id>
```

Verify COORD-SYNC-TIMEOUT appears where expected and frame advance resumes.

---

## Chunk 4: MF4 — INPUT-STALL drop → resync

### Task 4.1: Trigger resync on INPUT-STALL hard-timeout

**Files:**
- Modify: `web/static/netplay-lockstep.js` — INPUT-STALL hard-timeout block near [line 6974](web/static/netplay-lockstep.js#L6974)

- [ ] **Step 1: Read the existing hard-timeout block**

Find the section that fabricates ZERO_INPUT after `MAX_STALL_MS + RESEND_TIMEOUT_MS` has elapsed. Reference grep:

```bash
grep -n 'INPUT-STALL\|MAX_STALL_MS\|RESEND_TIMEOUT_MS\|ZERO_INPUT' web/static/netplay-lockstep.js
```

- [ ] **Step 2: Add resync request after fabrication**

After the ZERO_INPUT fabrication loop (the block that does `_remoteInputs[s][applyFrame] = KNShared.ZERO_INPUT`), add a request for full resync. The exact location is inside the "hard timeout" branch of the stall handler. Do NOT replace the fabrication — keep it (the game must keep moving). ADD the resync request alongside it.

Pattern to add, gated so it only fires once per stall (rate-limited):

```javascript
            // MF4: INPUT-STALL hard-timeout drop → resync.
            // Fabricating ZERO_INPUT keeps the game moving but creates
            // a permanent hash divergence from peers that had the
            // real input. Request a full resync so the divergence
            // converges at the next coord-sync window. Rate-limit to
            // once per INPUT_STALL_RESYNC_COOLDOWN_MS so we don't
            // spam resyncs under sustained WiFi loss.
            // See docs/netplay-invariants.md §I1 and spec §MF4.
            const _nowStallResync = performance.now();
            if (
              _nowStallResync - _lastInputStallResyncAt > INPUT_STALL_RESYNC_COOLDOWN_MS
            ) {
              _lastInputStallResyncAt = _nowStallResync;
              _syncLog(
                `INPUT-STALL-RESYNC f=${_frameNum} apply=${applyFrame} ` +
                `missing=[${_missingSlots.join(',')}] — requesting full resync`,
              );
              const hostPeer = Object.values(_peers).find((p) => p.slot === 0);
              const hostDc = hostPeer?.dc;
              if (_playerSlot !== 0 && hostDc?.readyState === 'open') {
                try {
                  hostDc.send('sync-request-full');
                } catch (e) {
                  _syncLog(`INPUT-STALL-RESYNC send failed: ${e}`);
                }
              }
            }
```

- [ ] **Step 3: Add state variables near other stall tracking**

Find where `_stallStart` or similar is declared and add:

```javascript
  let _lastInputStallResyncAt = 0;
  const INPUT_STALL_RESYNC_COOLDOWN_MS = 10000; // one resync per 10s under sustained loss
```

- [ ] **Step 4: Syntax check**

Run:
```bash
node -c web/static/netplay-lockstep.js
```

- [ ] **Step 5: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "$(cat <<'EOF'
fix(netplay): trigger resync on INPUT-STALL hard-timeout (MF4)

INPUT-STALL hard-timeout previously fabricated ZERO_INPUT and
silently dropped any late-arriving real inputs, creating permanent
hash divergence between the stalled peer and peers that had the real
inputs. Now the fabrication still happens (game keeps moving) but a
full resync is also requested so the divergence converges. Rate-
limited to once per 10 seconds to avoid resync storms under sustained
marginal WiFi.

Closes Category A7 in the audit. See spec §MF4.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.2: Two-tab verification for MF4

- [ ] **Step 1: Ask user to reproduce sustained input loss**

Message:
> "MF4 ready. Can you run a two-tab session and simulate sustained packet loss — blocking one tab's network for ~6 seconds while the game is running? I want to see INPUT-STALL-RESYNC fire and the game converge to matching hashes after the block lifts."

- [ ] **Step 2: Analyze**

Run analyze_match.py; verify INPUT-STALL-RESYNC presence and subsequent sync completion, no permanent desync.

---

## Chunk 5: MF5 — Late-join pause timeout

### Task 5.1: Raise late-join timeout and wait for `late-join-ready`

**Files:**
- Modify: `web/static/netplay-lockstep.js` — late-join block near [line 4275](web/static/netplay-lockstep.js#L4275)

- [ ] **Step 1: Read the current block**

Grep for `_lateJoinPaused = true` to find both sites (the host sets it, and a timeout resumes it):

```bash
grep -n '_lateJoinPaused' web/static/netplay-lockstep.js
```

- [ ] **Step 2: Replace the 200ms blind setTimeout with a bounded wait-for-ready**

Find the host-side block that looks like:

```javascript
      _lateJoinPaused = true;
      ...
      setTimeout(() => {
        if (_lateJoinPaused) {
          _lateJoinPaused = false;
          ...
        }
      }, 200);
```

Replace the timeout constant with a new `LATE_JOIN_TIMEOUT_MS` constant:

```javascript
  const LATE_JOIN_TIMEOUT_MS = 10000; // I1: late-join ready deadline (MF5)
```

And replace the `setTimeout(..., 200)` with `setTimeout(..., LATE_JOIN_TIMEOUT_MS)`. Also update the timeout body to log `LATE-JOIN-TIMEOUT` and hard-disconnect the joining peer so they can retry fresh:

```javascript
      _lateJoinPaused = true;
      _lateJoinPausedAt = performance.now();
      ...
      setTimeout(() => {
        if (_lateJoinPaused) {
          const elapsed = Math.round(performance.now() - _lateJoinPausedAt);
          _syncLog(
            `LATE-JOIN-TIMEOUT elapsed=${elapsed}ms — resuming without joiner, ` +
            `hard-disconnecting joiner so they can retry`,
          );
          _lateJoinPaused = false;
          // Hard-disconnect the joining peer to force a clean retry
          // rather than leave them in an unknown half-loaded state.
          for (const [sid, p] of Object.entries(_peers)) {
            if (p.isLateJoining) hardDisconnectPeer(sid);
          }
        }
      }, LATE_JOIN_TIMEOUT_MS);
```

(If `peer.isLateJoining` isn't already set, add it when the late-join flow begins. Verify by grepping for `isLateJoining` before editing.)

- [ ] **Step 3: Add `_lateJoinPausedAt` declaration**

Near other late-join state:

```javascript
  let _lateJoinPausedAt = 0;
```

- [ ] **Step 4: Wrap worker decompression on the joiner side**

Find the `handleLateJoinState` async function near [line 4319](web/static/netplay-lockstep.js#L4319). Locate the `decodeAndDecompress` or `workerPost` call. Wrap it in Promise.race with a 10s timeout:

```javascript
      const bytes = await Promise.race([
        decodeAndDecompress(msg.data),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('WORKER-STALL: late-join decompress')), LATE_JOIN_TIMEOUT_MS),
        ),
      ]);
```

Wrap in try/catch so that a WORKER-STALL rejection logs and aborts the late-join rather than hanging:

```javascript
      let bytes;
      try {
        bytes = await Promise.race([
          decodeAndDecompress(msg.data),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('WORKER-STALL: late-join decompress')), LATE_JOIN_TIMEOUT_MS),
          ),
        ]);
      } catch (e) {
        _syncLog(`WORKER-STALL late-join decompress failed: ${e.message}`);
        return;
      }
```

- [ ] **Step 5: Syntax check**

Run:
```bash
node -c web/static/netplay-lockstep.js
```

- [ ] **Step 6: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "$(cat <<'EOF'
fix(netplay): late-join timeout tuning and worker stall guard (MF5)

Two fixes for late-join races:

1. Host's _lateJoinPaused resume timeout was 200ms, which is much
   shorter than mobile state decompression (500ms+). Raised to 10s.
   On timeout the host logs LATE-JOIN-TIMEOUT AND hard-disconnects
   the joining peer, forcing a clean retry instead of leaving them
   half-loaded.

2. The joiner's worker decompression promise was unbounded. Wrapped
   in Promise.race with a 10s WORKER-STALL timeout so a stuck worker
   can't freeze the late-join flow indefinitely.

See spec §MF5 and audit §D3/§C5.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.2: Two-tab verification for MF5

- [ ] **Step 1: Ask user to test late-join flow**

Message:
> "MF5 ready. Can you run a two-tab session where the second tab late-joins an in-progress game? Test both the fast path (joiner loads within 10s) and an induced failure (refresh the joiner during state transfer). I want to see the host either resume normally or log LATE-JOIN-TIMEOUT and hard-disconnect the joiner cleanly."

- [ ] **Step 2: Analyze**

Run analyze_match.py and confirm the expected event patterns.

---

## Chunk 6: MF6 — Detection-only tick watchdog

### Task 6.1: Add `TICK-STUCK` detection without recovery

**Files:**
- Modify: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Add module-level state**

Near other diagnostic state (around line 500, where `_bootStallFrame` lives), add:

```javascript
  // MF6: Detection-only tick watchdog state. Logs TICK-STUCK when
  // the tick loop has been stuck for longer than the thresholds.
  // Does NOT attempt recovery — its sole purpose is to surface
  // residual deadlocks we haven't found yet. If this fires in
  // production, we have a new bug to diagnose; the fix belongs in
  // one of the MF categories, not in the watchdog itself.
  // See docs/netplay-invariants.md §MF6 and spec §MF6.
  let _tickStuckLastFrame = -1;
  let _tickStuckLastAdvanceAt = 0;
  let _tickStuckWarnFired = false;
  let _tickStuckErrorFired = false;
  const TICK_STUCK_WARN_MS = 2000;
  const TICK_STUCK_ERROR_MS = 5000;
```

- [ ] **Step 2: Add the detection block at the top of `tick()`**

Find the `const tick = () => {` start (around [line 5560](web/static/netplay-lockstep.js#L5560)). Insert immediately after the `if (!_running) return;` guard:

```javascript
  const tick = () => {
    if (!_running) return;

    // MF6: Detection-only watchdog. Logs TICK-STUCK with a rich
    // diagnostic snapshot when the frame counter has not advanced
    // for longer than the warn/error thresholds. Takes NO recovery
    // action — the user still sees the freeze, and the fix belongs
    // in whichever MF category covers the root cause.
    const _tickNow = performance.now();
    if (!_lateJoinPaused && !document.hidden) {
      if (_frameNum !== _tickStuckLastFrame) {
        _tickStuckLastFrame = _frameNum;
        _tickStuckLastAdvanceAt = _tickNow;
        _tickStuckWarnFired = false;
        _tickStuckErrorFired = false;
      } else if (_tickStuckLastAdvanceAt > 0) {
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

    if (_lateJoinPaused) return; // frozen while late-joiner loads state
```

(Keep the existing `if (_lateJoinPaused) return;` line — the watchdog check runs before it but skips its logic when late-join is active.)

- [ ] **Step 3: Implement `_emitTickStuckSnapshot`**

Add near the other diagnostic helpers (near `_syncLog`, search for `const _syncLog`):

```javascript
  const _emitTickStuckSnapshot = (severity, stuckMs) => {
    // Gather a rich snapshot of every candidate stall state so the
    // analyzer can attribute the stuck frame to a specific root cause.
    const peerSnap = {};
    for (const [sid, p] of Object.entries(_peers)) {
      peerSnap[sid] = {
        slot: p.slot,
        dc: p.dc?.readyState ?? 'null',
        buffered: p.dc?.bufferedAmount ?? 0,
        lastFrameFromPeer: p.lastFrameFromPeer ?? -1,
        lastAckAdvanceMs:
          p.lastAckAdvanceTime > 0
            ? Math.round(performance.now() - p.lastAckAdvanceTime)
            : -1,
        phantom: !!_peerPhantom[p.slot],
        lastRemoteFrame: _lastRemoteFramePerSlot[p.slot] ?? -1,
        bufSize: Object.keys(_remoteInputs[p.slot] || {}).length,
      };
    }

    // Inferred cause: pick the most likely culprit flag.
    let cause = 'unknown';
    if (window._rbPendingInit) cause = 'rb-pending-init';
    else if (_awaitingResync) cause = 'awaiting-resync';
    else if (_syncTargetFrame > 0) cause = `coord-sync-waiting-for-f${_syncTargetFrame}`;
    else if (_bootStallFrame >= 0) cause = `boot-lockstep-f${_bootStallFrame}`;
    else if (_skipFrameAdvance) cause = 'pacing-freeze';

    _syncLog(
      `TICK-STUCK severity=${severity} f=${_frameNum} stuckMs=${Math.round(stuckMs)} ` +
      `cause=${cause} rbPending=${!!window._rbPendingInit} ` +
      `awaitingResync=${_awaitingResync} syncTargetFrame=${_syncTargetFrame} ` +
      `bootStallFrame=${_bootStallFrame} scheduledSyncs=${_scheduledSyncRequests.length} ` +
      `peers=${JSON.stringify(peerSnap)}`,
    );
  };
```

- [ ] **Step 4: Reset watchdog state in `startLockstep` and `stop`**

Find the `startLockstep` reset block (near [line 4972](web/static/netplay-lockstep.js#L4972)) and add:

```javascript
      _tickStuckLastFrame = -1;
      _tickStuckLastAdvanceAt = 0;
      _tickStuckWarnFired = false;
      _tickStuckErrorFired = false;
```

Same in the `stop()` cleanup block near [line 8062](web/static/netplay-lockstep.js#L8062).

- [ ] **Step 5: Syntax check**

Run:
```bash
node -c web/static/netplay-lockstep.js
```

- [ ] **Step 6: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "$(cat <<'EOF'
feat(netplay): detection-only tick watchdog for residual deadlocks (MF6)

Adds a passive watchdog that emits TICK-STUCK (warn at 2s, error at
5s) with a rich diagnostic snapshot when the frame counter has not
advanced. Takes NO recovery action — its sole purpose is to surface
deadlocks that slipped past MF1-MF5 so we can diagnose them. If
TICK-STUCK fires in production after MF1-MF5 ship, we have a new
bug; the fix belongs in whichever MF category covers the root cause,
never in the watchdog itself.

Deliberately named TICK-STUCK (not TICK-WATCHDOG) to emphasize the
passive role. Skips while _lateJoinPaused or document.hidden to
avoid false positives on legitimate pauses.

See spec §MF6 and the rejected-alternatives section explaining why
auto-recovery is off the table.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6.2: Two-tab verification for MF6

- [ ] **Step 1: Ask user to verify TICK-STUCK does NOT fire on normal play**

Message:
> "MF6 ready. Run a normal two-tab session for 3-5 minutes. I want to verify TICK-STUCK count is zero across the session — any hits would mean one of MF1-MF5 missed something."

- [ ] **Step 2: Analyze**

Run analyze_match.py; confirm zero TICK-STUCK events in the log. If any fire, diagnose the root cause and file a new MF — do NOT add recovery to the watchdog.

---

## Chunk 7: Analyzer updates

### Task 7.1: Add new event detection to `analyze_match.py`

**Files:**
- Modify: `tools/analyze_match.py`

- [ ] **Step 1: Read the existing event-detection sections**

Run:
```bash
grep -n 'BOOT-DEADLOCK-RECOVERY\|RENDER-STALL\|INPUT-STALL\|event_counts' tools/analyze_match.py
```

- [ ] **Step 2: Add detection for new event types**

Find the sections that detect existing events (e.g., the BOOT-DEADLOCK-RECOVERY detection added in commit 788add0) and add similar detection for:

- `PEER-RESET` — log attribution by reason, count per slot
- `RB-INIT-TIMEOUT` — count, inferred fallback delay
- `COORD-SYNC-TIMEOUT` — count, target frame
- `INPUT-STALL-RESYNC` — count, frame, missing slots
- `LATE-JOIN-TIMEOUT` — count
- `WORKER-STALL` — count, source (late-join-decompress, etc.)
- `TICK-STUCK` — count, severity (warn/error), cause breakdown

These go into the freeze-detection and network-health sections of the analyzer (sections 6 and 8 per `reference_analyze_match.md`).

- [ ] **Step 3: Test with an existing session**

Run against any recent match:
```bash
cd /Users/kazon/kaillera-next/server && uv run python ../tools/analyze_match.py <any_match_id>
```

Confirm the analyzer still runs without errors and the new event sections appear (even if counts are zero for older sessions).

- [ ] **Step 4: Commit**

```bash
git add tools/analyze_match.py
git commit -m "$(cat <<'EOF'
feat(analyzer): detect new netplay recovery events

Adds counters and timeline detection for the events introduced by
the netplay deadlock audit fixes: PEER-RESET, RB-INIT-TIMEOUT,
COORD-SYNC-TIMEOUT, INPUT-STALL-RESYNC, LATE-JOIN-TIMEOUT,
WORKER-STALL, TICK-STUCK (with severity and cause breakdown).

See spec docs/superpowers/specs/2026-04-11-netplay-deadlock-audit.md.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 8: Documentation

### Task 8.1: Write `docs/netplay-invariants.md`

**Files:**
- Create: `docs/netplay-invariants.md`

- [ ] **Step 1: Write the invariants reference doc**

```markdown
# Netplay Invariants

The netplay stack (`web/static/netplay-lockstep.js`) enforces two
invariants that together eliminate the entire class of
DataChannel-death freeze bugs. This document is the canonical
reference — inline comments at each stall site point back here.

## I1 — No stall without a timeout

Every `return` in `tick()` that waits on an external event (DC
message arrival, peer connection state, remote frame progress, state
decompression) must have:

1. A wall-clock deadline (`performance.now()`-based).
2. A recovery action when the deadline expires.
3. An inline comment stating both.

"Stall" means an early return that depends on external events. Pure
local-state branches (`if (!_running) return;`) are not stalls.

Sites with timeouts:

- `_rbPendingInit` — `RB_INIT_TIMEOUT_MS = 3000` → fall back to local
  delay, log RB-INIT-TIMEOUT (spec §MF2)
- `_syncTargetFrame` — `SYNC_COORD_TIMEOUT_MS = 3000` → apply state
  immediately at current frame, log COORD-SYNC-TIMEOUT (spec §MF3)
- INPUT-STALL hard-timeout — `MAX_STALL_MS + RESEND_TIMEOUT_MS = 5000`
  → fabricate ZERO_INPUT AND request resync, log INPUT-STALL-RESYNC
  (spec §MF4)
- `_awaitingResync` — 3000ms → resume without corrected state (may
  livelock; see SF5)
- Late-join pause — `LATE_JOIN_TIMEOUT_MS = 10000` → hard-disconnect
  joining peer, log LATE-JOIN-TIMEOUT (spec §MF5)
- Late-join worker decompress — `LATE_JOIN_TIMEOUT_MS` → abort
  late-join, log WORKER-STALL (spec §MF5)
- BOOT-LOCKSTEP stall — 3000ms → request immediate sync, log
  BOOT-DEADLOCK-RECOVERY (shipped in commit 788add0)

## I2 — Reconnect starts clean

A single function `resetPeerState(slot, reason, opts)` owns all
per-peer state cleanup. Every disconnect, reconnect, phantom clear,
tab-visibility reset, and game-stop path routes through it.

Fields cleared (see the function's docstring for the authoritative
list). Adding new per-peer state without updating `resetPeerState` is
a code-review-level violation.

Call sites:

- `hardDisconnectPeer` — reason `hard-disconnect` (or
  `hard-disconnect-non-host` for the roster-gated path)
- Reconnect resync — reason `reconnect`
- Tab-visibility resync — reason `tab-visibility`
- `stop()` — reason `stop`

## Detection-only watchdog (MF6)

A passive tick watchdog emits `TICK-STUCK` warnings when the frame
counter has not advanced for 2 seconds (warn) or 5 seconds (error).
It takes NO recovery action. Its sole purpose is to surface residual
deadlocks we haven't found yet.

**Any TICK-STUCK fire in production is a bug report, not a safety
net doing its job.** The fix belongs in whichever MF category covers
the root cause, never in the watchdog.

### Rejected alternative — auto-recovery watchdog

An earlier draft of the deadlock audit proposed an auto-recovery
watchdog. This was rejected:

- It masks root causes. Silent recovery hides the signal that a
  specific stall site is misbehaving.
- It creates a temptation to stop diagnosing.
- It violates the no-cascade-fix rule (`feedback_no_js_cascade_fix`).

If MF6 ever becomes "recovery" rather than "detection," re-read this
section before writing the PR.

## References

- Spec: [docs/superpowers/specs/2026-04-11-netplay-deadlock-audit.md](superpowers/specs/2026-04-11-netplay-deadlock-audit.md)
- Trigger: commit 788add0 "fix(rollback): eliminate BOOT-LOCKSTEP + coord-sync deadlock"
- Diagnostic tool: `tools/analyze_match.py` (see `reference_analyze_match.md`)
```

- [ ] **Step 2: Add a pointer in `CLAUDE.md`**

Find the "Key decisions" section (near the bottom of CLAUDE.md's architecture section). Add a new subsection:

```markdown
## Netplay invariants

Two codified invariants govern the netplay tick loop. See
[docs/netplay-invariants.md](docs/netplay-invariants.md):

- **I1 — No stall without a timeout:** every tick-loop early-return
  that waits on external events has a wall-clock deadline and a
  recovery action.
- **I2 — Reconnect starts clean:** all per-peer cleanup routes
  through `resetPeerState(slot, reason)`. Adding per-peer state
  without updating `resetPeerState` is a review-level violation.

A detection-only watchdog logs `TICK-STUCK` for any residual stall
past MF1-MF5. It takes no recovery action by design.
```

- [ ] **Step 3: Commit**

```bash
git add docs/netplay-invariants.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(netplay): add invariants reference and CLAUDE.md pointer

Canonical reference for I1 (no stall without a timeout) and I2
(reconnect starts clean via resetPeerState), plus the rejected
auto-recovery-watchdog alternative as load-bearing documentation
against future regressions in that direction.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 8.2: Add inline comments at every stall site

**Files:**
- Modify: `web/static/netplay-lockstep.js` — inline comments only

- [ ] **Step 1: At each stall `return`, add or update the comment to match the I1 format**

Format:

```javascript
// I1: Stall waiting for <what>.
// Deadline: <N>ms via <mechanism>.
// Recovery: <what happens on timeout>.
// See docs/netplay-invariants.md §I1.
return;
```

Sites to touch (verify by audit spec §Category A):

1. A1 `_lateJoinPaused` — covered by MF5 timeout
2. A2 `_rbPendingInit` — covered by MF2 timeout
3. A3 `_syncTargetFrame` coord stall — covered by MF3 timeout
4. A4 BOOT-LOCKSTEP — covered by 788add0 + MF1 reset
5. A5 RB-INPUT-STALL — existing 5s PEER_DEAD_MS
6. A7 INPUT-STALL lockstep — covered by MF4 resync
7. A8 `_awaitingResync` — existing 3s timeout (known livelock, SF5)

Don't rewrite the logic, just add the invariant comment above each return.

- [ ] **Step 2: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "$(cat <<'EOF'
docs(netplay): annotate every tick-loop stall with I1 comment

Every early-return in tick() that waits on an external event now has
an inline comment naming the invariant (I1), the deadline, and the
recovery action. Matches docs/netplay-invariants.md format so future
readers can trace a stall site back to its invariant without
guessing.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 9: Final verification and deploy gate

### Task 9.1: Full two-tab regression pass

- [ ] **Step 1: Ask user to run a comprehensive verification session**

Message:
> "All six MFs landed plus docs. Ready for a comprehensive two-tab regression pass. Please run a normal full rollback match (3-5 minutes) with both tabs, then a second session where you force a mid-game DC reconnect. I want to see:
> - Zero TICK-STUCK events in the normal match
> - PEER-RESET fires with correct reasons in the reconnect scenario
> - No regressions in RB-CHECK hash matches, freeze detection, or pacing compared to pre-MF sessions"

- [ ] **Step 2: Analyze both sessions**

```bash
cd /Users/kazon/kaillera-next/server && uv run python ../tools/analyze_match.py <normal_match_id>
cd /Users/kazon/kaillera-next/server && uv run python ../tools/analyze_match.py <reconnect_match_id>
```

Confirm:
- No TICK-STUCK events in the normal match
- PEER-RESET fires correctly in the reconnect match
- No new desyncs introduced
- Pacing/RB-CHECK stats comparable to recent pre-MF sessions

- [ ] **Step 3: If any regressions, diagnose and fix forward**

Do not revert. Per `feedback_no_sentinel_tests.md` / `feedback_no_reverting.md`, fix forward from the first-regression commit.

### Task 9.2: Deploy gate

- [ ] **Step 1: Ask for explicit deploy approval**

Per `feedback_no_deploy_without_testing.md`: do NOT deploy without explicit user go-ahead. Message:

> "Verification complete. All six MF commits landed, docs are in place, two-tab regression pass shows clean. Ready to deploy — awaiting your explicit go-ahead. Deploy via `just deploy` when you approve."

- [ ] **Step 2: Wait for approval**

Do not run any deploy command until the user says go.

- [ ] **Step 3: On approval, run `just deploy`**

```bash
just deploy
```

Per `reference_deploy_workflow.md`: this runs the full release path. After deploy, confirm via production admin API that the new events appear in live match telemetry.

---

## Post-implementation followups (not part of this plan)

These come from the spec's "Should-fix" and "Nice-to-have" sections.
Bundle each as a separate followup PR after MF1-MF6 are shipped and
stable in production for at least a few days:

- **SF1** — WebRTC promise timeouts on createOffer/setLocalDescription/setRemoteDescription
- **SF2** — General `workerPost` timeout (beyond the late-join path covered by MF5)
- **SF3** — RB-INPUT-STALL phantom-entry dampening
- **SF4** — Roster broadcast ack
- **SF5** — `_awaitingResync` livelock (second resync request before giving up)
- **NH1** — IndexedDB hang handling
- **NH2** — Audio worklet load timeout
- **NH3** — `rb-transport:` broadcast ack
- **NH4** — Explicit disconnect reason strings

Track these as memory entries or GitHub issues, not this plan.
