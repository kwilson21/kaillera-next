# Coordinated Lockstep Roster Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace independent per-player input roster discovery with host-authoritative coordinated roster, eliminating the class of desyncs where players disagree on which slots are active.

**Architecture:** The host (slot 0) broadcasts the full active slot list over DataChannels whenever the roster changes (join, leave, game start). All players apply the roster identically — `_activeRoster` replaces `_peerInputStarted` as the source of truth for input application. The existing stall/fabrication mechanism handles missing inputs for roster slots with no DC.

**Tech Stack:** Browser JS (IIFE + window globals, no ES modules), Playwright for E2E verification.

**Spec:** `docs/superpowers/specs/2026-04-04-coordinated-lockstep-roster-design.md`

---

## File Map

All changes are in one file:
- **Modify:** `web/static/netplay-lockstep.js` — all roster logic lives here
- **Create:** `tests/test_roster.py` — Playwright E2E test for 4-player roster coordination

---

## Chunk 1: Core Roster State and Message Handling

### Task 1: Add `_activeRoster` state and roster message parser

**Files:**
- Modify: `web/static/netplay-lockstep.js` (state declarations ~line 391, DC message handler ~line 1781)

- [ ] **Step 1: Add `_activeRoster` state variable**

Near the existing `_peerInputStarted` declaration (~line 391), add:

```javascript
let _activeRoster = null;  // Set<number> of active slots — host-authoritative, null until first roster
```

Also add resets in `startLockstep()` (the `_frameNum === 0` block ~line 3450) and in `stop()` (~line 5217 where `_peerInputStarted = {}` is):

```javascript
_activeRoster = null;
```

- [ ] **Step 2: Add roster message parser in DC string handler**

In the `setupDataChannel` function's `onmessage` handler, where other string messages are parsed (near `late-join-pause`, `late-join-resume`, etc. ~line 1781), add:

```javascript
if (e.data.startsWith('roster:')) {
  const parts = e.data.split(':');
  const rosterFrame = parseInt(parts[1], 10);
  const slots = parts[2] ? parts[2].split(',').map(Number) : [];
  _activeRoster = new Set(slots);
  _syncLog(`ROSTER received: frame=${rosterFrame} slots=[${slots.join(',')}]`);
}
```

- [ ] **Step 3: Verify the parser handles edge cases**

The message format is `roster:<frame>:<slot>,<slot>,...`. The parser must handle:
- `roster:0:0,1` (2 players at game start)
- `roster:4772:0,1,2,3` (4 players after late-join)
- `roster:8500:0,1` (after 2 players drop)

No test file needed — this will be verified by the E2E test in Task 5.

- [ ] **Step 4: Commit**

```
feat: add _activeRoster state and DC roster message parser
```

---

### Task 2: Add host roster broadcast function

**Files:**
- Modify: `web/static/netplay-lockstep.js` (new function near `sendLateJoinState` ~line 2835)

- [ ] **Step 1: Create `_broadcastRoster()` function**

Add near the other broadcast/send functions:

```javascript
const _broadcastRoster = () => {
  if (_playerSlot !== 0) return;  // only host broadcasts
  // Build roster from all player peers + self
  const slots = [_playerSlot];
  for (const p of Object.values(_peers)) {
    if (p.slot !== null && p.slot !== undefined && !p._intentionalLeave) {
      slots.push(p.slot);
    }
  }
  slots.sort((a, b) => a - b);
  _activeRoster = new Set(slots);
  const msg = `roster:${_frameNum}:${slots.join(',')}`;
  _syncLog(`ROSTER broadcast: frame=${_frameNum} slots=[${slots.join(',')}]`);
  for (const p of Object.values(_peers)) {
    if (p.dc?.readyState === 'open') {
      try { p.dc.send(msg); } catch (_) {}
    }
  }
};
```

- [ ] **Step 2: Commit**

```
feat: add host _broadcastRoster function
```

---

### Task 3: Integrate roster broadcast into game lifecycle

**Files:**
- Modify: `web/static/netplay-lockstep.js` (`startLockstep`, `sendLateJoinState`, `hardDisconnectPeer`, DC `onopen`)

- [ ] **Step 1: Broadcast initial roster in `startLockstep()`**

In `startLockstep()`, after the `_syncLog('lockstep started ...')` line (~line after 3462), add:

```javascript
// Host: broadcast initial roster so all peers have an authoritative baseline
_broadcastRoster();
```

- [ ] **Step 2: Broadcast updated roster in `sendLateJoinState()`**

In `sendLateJoinState()`, right before the `_lateJoinPaused = true` line (before pausing), add:

```javascript
// Broadcast roster including the new slot BEFORE pausing, so all peers
// know the new slot is active from this frame onward
_broadcastRoster();
```

- [ ] **Step 3: Broadcast updated roster in `hardDisconnectPeer()` (host only)**

In `hardDisconnectPeer()`, AFTER `delete _peers[remoteSid]` but before the UI notifications, add:

```javascript
// Host: broadcast updated roster without the dropped slot
if (_playerSlot === 0 && _running) {
  _broadcastRoster();
}
```

- [ ] **Step 4: Re-send current roster on DC reconnect**

In `setupDataChannel` → `ch.onopen`, after the existing reconnect handling (~line 1698), add:

```javascript
// Host: send current roster to newly connected/reconnected peer
if (_playerSlot === 0 && _activeRoster) {
  const slots = [..._activeRoster].sort((a, b) => a - b);
  try { ch.send(`roster:${_frameNum}:${slots.join(',')}`); } catch (_) {}
}
```

- [ ] **Step 5: Commit**

```
feat: integrate roster broadcast into game lifecycle
```

---

## Chunk 2: Replace Input Roster Logic

### Task 4: Rewrite `getInputPeers()` and input application to use `_activeRoster`

**Files:**
- Modify: `web/static/netplay-lockstep.js` (`getInputPeers` ~line 2284, input application ~line 4116, zero-clearing ~line 4180)

- [ ] **Step 1: Rewrite `getInputPeers()`**

Replace the current `getInputPeers` function:

```javascript
const getInputPeers = () => {
  if (_activeRoster) {
    // Roster mode: return peers for all roster slots (excluding self).
    // Peers may have dead DCs — the stall/fabrication path handles that.
    return Object.values(_peers).filter((p) => {
      if (p.slot === null || p.slot === undefined) return false;
      return _activeRoster.has(p.slot);
    });
  }
  // Legacy mode (pre-roster): original behavior
  return getActivePeers().filter((p) => {
    if (p.reconnecting) return false;
    if (_peerCatchingUp?.[p.slot]) return false;
    if (_peerInputStarted[p.slot]) return true;
    return _frameNum < BOOT_GRACE_FRAMES;
  });
};
```

- [ ] **Step 2: Rewrite input application loop**

Replace the input write section in the tick loop (currently lines ~4116-4125 and ~4180-4191) with:

```javascript
// Zero ALL 4 slots first, then overwrite with real input.
// This ensures consistency: every slot is either written from real
// input or zeroed, with no conditional checks on peer state.
for (let zs = 0; zs < 4; zs++) {
  writeInputToMemory(zs, 0);
}

// Write local player's input
const localInput = _localInputs[applyFrame] || KNShared.ZERO_INPUT;
writeInputToMemory(_playerSlot, localInput);

// Write remote inputs for peers in the input roster
for (let m = 0; m < inputPeers.length; m++) {
  const peerSlot = inputPeers[m].slot;
  const remoteInput = (_remoteInputs[peerSlot] && _remoteInputs[peerSlot][applyFrame]) || KNShared.ZERO_INPUT;
  writeInputToMemory(peerSlot, remoteInput);
  if (_remoteInputs[peerSlot]) delete _remoteInputs[peerSlot][applyFrame];
}

// Also write input for roster slots that have no peer object yet
// (e.g., late joiner whose DC hasn't formed). They get zeros, which
// is what every other player also writes for that slot.
if (_activeRoster) {
  for (const rosterSlot of _activeRoster) {
    if (rosterSlot === _playerSlot) continue;
    const hasPeer = inputPeers.some((p) => p.slot === rosterSlot);
    if (!hasPeer) writeInputToMemory(rosterSlot, 0);
  }
}
```

Remove the old separate zero-clearing loop (the `// Zero disconnected player slots` block).

- [ ] **Step 3: Update `hardDisconnectPeer()` for non-host**

In `hardDisconnectPeer()`, wrap the `delete _peerInputStarted[peer.slot]` line in a host check. Non-hosts should NOT remove slots from their input tracking — the host's roster update handles that:

```javascript
if (peer.slot !== null && peer.slot !== undefined) {
  try {
    writeInputToMemory(peer.slot, 0);
  } catch (_) {}
  delete _remoteInputs[peer.slot];
  delete _peerCatchingUp[peer.slot];
  // Only host modifies the input roster — non-hosts wait for
  // the host's roster broadcast to remove the slot
  if (_playerSlot === 0 || !_activeRoster) {
    delete _peerInputStarted[peer.slot];
  }
}
```

- [ ] **Step 4: Add roster to periodic INPUT-LOG**

In the periodic INPUT-LOG (~line 4142), add the roster to the log string:

```javascript
`INPUT-LOG f=${_frameNum} apply=${applyFrame} ... roster=[${_activeRoster ? [..._activeRoster].join(',') : 'none'}]`
```

This enables post-mortem comparison of roster state across players.

- [ ] **Step 5: Commit**

```
feat: rewrite input application to use host-authoritative roster
```

---

## Chunk 3: E2E Verification

### Task 5: Playwright 4-player roster verification test

**Files:**
- Create: `tests/test_roster.py`

- [ ] **Step 1: Write the test**

This test verifies that all 4 players agree on the roster after a late-join. It uses 4 browser pages, starts a 2-player game, late-joins P2 then P3, and verifies via the sync log that all players have the same roster.

```python
"""4-player roster coordination E2E test.

Verifies that the host-authoritative roster is consistent across
all players after late-joins. Uses __test_skipBoot to avoid
needing a real ROM — we only need the lockstep engine's signaling
and roster logic, not the emulator.

Run: pytest tests/test_roster.py -v
"""

import json
import secrets
import time

import pytest


def _connect_player(context, server_url, room, name, is_host=False):
    """Open a page and join a room."""
    page = context.new_page()
    params = f"room={room}&name={name}"
    if is_host:
        params += "&host=1"
    page.goto(f"{server_url}/play.html?{params}")
    # Set test flags to skip emulator boot
    page.evaluate("window.__test_skipBoot = true")
    page.wait_for_function(
        "window.__test_socket && window.__test_socket.connected",
        timeout=10000,
    )
    return page


def _mark_rom_ready(page):
    page.evaluate("""
        if (window.__test_setRomLoaded) window.__test_setRomLoaded();
        window.__test_socket.emit('rom-ready', { ready: true });
    """)


def _get_roster(page):
    """Extract _activeRoster from the lockstep engine."""
    return page.evaluate("""
        (() => {
            const engine = window.NetplayLockstep;
            if (!engine || !engine.getDebugState) return null;
            const state = engine.getDebugState();
            return state.activeRoster ? [...state.activeRoster] : null;
        })()
    """)


def _get_input_peers(page):
    """Extract inputPeers slot list from the lockstep engine."""
    return page.evaluate("""
        (() => {
            const engine = window.NetplayLockstep;
            if (!engine || !engine.getDebugState) return null;
            const state = engine.getDebugState();
            return state.inputPeerSlots || null;
        })()
    """)


def test_4player_roster_coordination(context, server_url):
    """All 4 players must agree on the roster after late-joins."""
    room = f"ROST{secrets.token_hex(3).upper()}"
    pages = []

    try:
        # Host + P1 join
        host = _connect_player(context, server_url, room, "Host", is_host=True)
        p1 = _connect_player(context, server_url, room, "P1")
        pages = [host, p1]

        _mark_rom_ready(host)
        _mark_rom_ready(p1)

        # Start game
        host.wait_for_selector("#start-btn:not([disabled])", timeout=10000)
        host.click("#start-btn")

        # Wait for lockstep to start
        time.sleep(2)

        # Verify initial 2-player roster
        host_roster = _get_roster(host)
        p1_roster = _get_roster(p1)
        assert host_roster is not None, "Host should have roster"
        assert sorted(host_roster) == [0, 1], f"Host roster should be [0,1], got {host_roster}"
        assert sorted(p1_roster) == [0, 1], f"P1 roster should be [0,1], got {p1_roster}"

        # P2 late-joins
        p2 = _connect_player(context, server_url, room, "P2")
        pages.append(p2)
        _mark_rom_ready(p2)
        time.sleep(3)  # Wait for late-join state transfer

        # All 3 should agree on roster
        for i, page in enumerate(pages):
            roster = _get_roster(page)
            assert roster is not None, f"P{i} should have roster"
            assert sorted(roster) == [0, 1, 2], f"P{i} roster should be [0,1,2], got {roster}"

        # P3 late-joins
        p3 = _connect_player(context, server_url, room, "P3")
        pages.append(p3)
        _mark_rom_ready(p3)
        time.sleep(3)

        # All 4 should agree on roster
        for i, page in enumerate(pages):
            roster = _get_roster(page)
            assert roster is not None, f"P{i} should have roster"
            assert sorted(roster) == [0, 1, 2, 3], f"P{i} roster should be [0,1,2,3], got {roster}"

    finally:
        for page in pages:
            page.close()
```

- [ ] **Step 2: Expose `getDebugState()` from the lockstep engine**

In the lockstep engine's public API (near the `return { init, stop, ... }` block at the end of the IIFE), add:

```javascript
getDebugState: () => ({
  activeRoster: _activeRoster ? [..._activeRoster] : null,
  inputPeerSlots: getInputPeers().map((p) => p.slot),
  running: _running,
  frameNum: _frameNum,
  playerSlot: _playerSlot,
  peerCount: Object.keys(_peers).length,
}),
```

- [ ] **Step 3: Run the test**

Run: `pytest tests/test_roster.py -v`

Expected: All assertions pass — all 4 players agree on roster `[0,1,2,3]` after both late-joins.

Note: This test uses `__test_skipBoot` so no ROM is needed. It tests the signaling and roster coordination layer only. If the test infrastructure doesn't support 4 pages in one context, use multiple contexts from the browser fixture.

- [ ] **Step 4: Commit**

```
feat: add 4-player roster coordination E2E test
```

---

## Chunk 4: Cleanup

### Task 6: Remove dead code and update comments

**Files:**
- Modify: `web/static/netplay-lockstep.js`

- [ ] **Step 1: Remove `_peerCatchingUp` mechanism**

The catching-up tracking was a workaround for independent roster discovery. With host-authoritative roster, it's unnecessary — the host controls when a slot becomes active. Remove:
- The `_peerCatchingUp` declaration
- The catching-up detection in the INPUT-FIRST handler
- The catching-up check in `getInputPeers()` legacy path
- The `_peerCatchingUp` reset in `startLockstep()`, `stop()`, and `hardDisconnectPeer()`
- The `sendLateJoinResync` function and `handleLateJoinResync` (the roster + state transfer handles this now)
- The `late-join-resync` handler in `onDataMessage`

- [ ] **Step 2: Update the file header comment**

The lockstep engine's header comment (top of file) describes the input flow. Update it to mention the host-authoritative roster.

- [ ] **Step 3: Run full test suite**

Run: `pytest tests/ -v --timeout=60`

Expected: All existing tests pass, no regressions.

- [ ] **Step 4: Commit**

```
refactor: remove _peerCatchingUp and independent roster discovery code
```
