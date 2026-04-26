# Late-join regime by host game phase — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current mid-match late-join behavior (which produces a half-initialized player whose inputs do nothing in SSB64/Smash Remix) with a spectator-first flow that promotes joiners to players only at safe menu phases.

**Architecture:** When a Smash Remix room has `status === "playing"`, the joiner enters as a spectator (no emulator boot, no ROM required). The host queues them in `_pendingPromotions`, and on the rising edge of `phase.inControllableMenu` (or on rom-ready arrival while already in a controllable menu), fires `host-promote-spectator` (new server event) to move them to `room.players`, then sends a targeted `late-join-state` (new `targetSid` field on existing message). On failure, joiner emits `become-spectator` (new server event) to recover and re-queue.

**Tech Stack:** Python FastAPI + python-socketio (server), vanilla JS IIFE modules with WebRTC + Socket.IO (client), Pydantic v2 (payload validation), pytest + Playwright (tests), `uv run` for all Python tooling.

**Spec:** [docs/superpowers/specs/2026-04-26-late-join-regime-design.md](../specs/2026-04-26-late-join-regime-design.md)

**Conventions used by this plan:**
- Tests live in `/Users/kazon/kaillera-next/tests/`. Run with `uv run pytest tests/...`.
- Conftest provides `server_url`, `room`, and `browser` (pytest-playwright) fixtures.
- All payload field names use **camelCase** to match existing `payloads.py` neighbors (e.g. `gameId`, `playerName`, `romHash`).
- Test hooks added to engine code use `window.__kn_*` prefix and are production-safe (read-only state mirrors).
- Line numbers given are anchors as of plan write. Implementer should verify by `grep` before each edit; line numbers rot.

---

## File Structure

Files modified or created, organized by responsibility:

### Server
- `server/src/api/payloads.py` — Two new Pydantic models for the new events.
- `server/src/api/signaling.py` — New `become-spectator` and `host-promote-spectator` event handlers; `_players_payload` extended; `join-room` ack adds `gameId`.
- `server/src/api/app.py` — `GET /room/{room_id}` adds `gameId` to response.

### Client
- `web/static/play.js` — Auto-spectate gate extended for Smash Remix + status="playing"; emulator boot decoupled from join (deferred to `onPromotedToPlayer` callback); watching banner UI; ROM prompt unchanged but exposed during spectator mode.
- `web/static/netplay-lockstep.js` — `_pendingPromotions` queue; `_broadcastPhaseIfNeeded` extended with `_lastInControllableMenu` rising-edge detector; `promoteSpectator` helper; `sendLateJoinState` adds `targetSid`; `handleLateJoinState` adds `targetSid` filter and `_pendingLateJoinMsg` cache; `onUsersUpdated` adds demotion cleanup branch; `LATE_JOIN_TIMEOUT_MS` failure path emits `become-spectator` and re-queues.
- `web/play.html` — Banner element for active-players "P3 joining…"; persistent watching status repurposes `#guest-status`; disabled gamepad styling.

### Tests
- `tests/test_late_join_regime.py` — Server-side pytest (Playwright-driven where Socket.IO needed) covering payload shapes, new events.
- `tests/test_late_join_e2e.py` — Playwright E2E: 3-player late-join scenario from the bug report.

---

## Chunk 1: Server payload additions

Three pure data additions. No new events or behavior changes — just exposing the fields the client-side gate needs to read. Lands first so subsequent chunks can rely on the data being available.

### Task 1.1: Add `gameId` to `GET /room/{room_id}` response

**Files:**
- Modify: `server/src/api/app.py` (the `GET /room/{room_id}` handler near line 624)
- Test: `tests/test_late_join_regime.py` (create)

- [ ] **Step 1: Create the test file with a single failing test**

Create `tests/test_late_join_regime.py`:

```python
"""Server-side tests for late-join regime spec.

Run: uv run pytest tests/test_late_join_regime.py -v
"""

import secrets
import requests


def _new_room():
    return "L" + secrets.token_hex(3).upper()


def _wait_for_room_state(page, *, attribute, timeout=10000):
    """Wait for a window-exposed test hook to be populated."""
    page.wait_for_function(
        f"window.{attribute} !== undefined && window.{attribute} !== null",
        timeout=timeout,
    )


def test_room_lookup_returns_game_id(browser, server_url):
    """GET /room/{id} must include gameId so the lobby can decide
    whether to apply the spectator-first gate before join-room."""
    room = _new_room()
    host = browser.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&game=smash-remix")
    _wait_for_room_state(host, attribute="__lastUsersUpdated")

    r = requests.get(f"{server_url}/room/{room}", verify=False)
    assert r.status_code == 200
    body = r.json()
    assert "gameId" in body, f"gameId missing from response: {body}"
    assert body["gameId"] == "smash-remix"

    host.close()
```

The test depends on the `__lastUsersUpdated` hook from Task 1.3 to confirm the room is fully provisioned. Wire it now (the hook addition is additive).

- [ ] **Step 2: Add the `__lastUsersUpdated` test hook in `play.js`**

In `web/static/play.js`, find the `users-updated` socket handler (around line 866 — `diffForToasts(players, spectators)`). Add a one-line capture immediately when the handler runs. Search for `socket.on('users-updated'` and prepend `window.__lastUsersUpdated = data;` inside the callback.

- [ ] **Step 3: Run the test to verify it fails**

```bash
uv run pytest tests/test_late_join_regime.py::test_room_lookup_returns_game_id -v
```

Expected: FAIL on `assert "gameId" in body` — the field doesn't exist yet.

- [ ] **Step 4: Add `gameId` to the endpoint**

In `server/src/api/app.py`, find the `GET /room/{room_id}` handler (search for `def get_room`). Add `"gameId": room.game_id` to the returned dict. Existing fields stay unchanged.

```python
return {
    "status": room.status,
    "player_count": len(room.players),
    "max_players": room.max_players,
    "has_password": room.password is not None,
    "rom_hash": room.rom_hash,
    "rom_sharing": room.rom_sharing,
    "mode": room.mode,
    "gameId": room.game_id,
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
uv run pytest tests/test_late_join_regime.py::test_room_lookup_returns_game_id -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/api/app.py web/static/play.js tests/test_late_join_regime.py
git commit -m "feat(server): add gameId to GET /room/{id} response

Required by the spectator-first late-join gate so the lobby can
decide whether to auto-route joiners through spectator mode before
the join-room round trip. Also adds a __lastUsersUpdated test hook
in play.js for E2E verification.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.2: Add `gameId` to `join-room` ack response

**Files:**
- Modify: `server/src/api/signaling.py` (both `resp` blocks: reconnect at ~570, fresh-join at ~602)
- Modify: `web/static/play.js` (two `socket.emit('join-room', ...)` callbacks at line 580 and 597)
- Test: `tests/test_late_join_regime.py`

- [ ] **Step 1: Add the `__kn_lastJoinAck` test hook in `play.js`**

There are two `socket.emit('join-room', ...)` callsites to instrument:
- **Line 580 (primary join):** callback signature `(err, joinData) => {...}` at line 591.
- **Line 597 (auto-spectate retry):** callback signature `(err2, joinData2) => {...}` at line 609.

Add `window.__kn_lastJoinAck = joinData ?? null;` (or `joinData2`) as the first line inside each callback body. The variable is set whether the join succeeded or not (joinData is null on error).

- [ ] **Step 2: Write the failing test**

Add to `tests/test_late_join_regime.py`:

```python
def test_join_room_ack_includes_game_id(browser, server_url):
    """join-room ack must include gameId so the joiner-side
    auto-spectate gate can apply Smash-Remix-only routing."""
    room = _new_room()
    host = browser.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&game=smash-remix")
    _wait_for_room_state(host, attribute="__lastUsersUpdated")

    guest = browser.new_page()
    guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
    _wait_for_room_state(guest, attribute="__kn_lastJoinAck")

    ack = guest.evaluate("window.__kn_lastJoinAck")
    assert ack is not None, "guest never recorded a join ack"
    assert ack.get("gameId") == "smash-remix"

    host.close()
    guest.close()
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
uv run pytest tests/test_late_join_regime.py::test_join_room_ack_includes_game_id -v
```

Expected: FAIL — ack missing `gameId`.

- [ ] **Step 4: Add `gameId` to both `resp` blocks in `signaling.py`**

There are two `resp = _players_payload(room)` blocks in the `join-room` handler — the reconnect path (~line 570) and the fresh-join path (~line 602). Add `resp["gameId"] = room.game_id` to **both**.

```python
# In the reconnect path (~line 570):
resp = _players_payload(room)
resp["status"] = room.status
resp["mode"] = room.mode
resp["rom_hash"] = room.rom_hash
resp["rom_sharing"] = room.rom_sharing
resp["gameId"] = room.game_id        # NEW

# In the fresh-join path (~line 602):
resp = _players_payload(room)
resp["status"] = room.status
resp["mode"] = room.mode
resp["rom_hash"] = room.rom_hash
resp["rom_sharing"] = room.rom_sharing
resp["gameId"] = room.game_id        # NEW
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
uv run pytest tests/test_late_join_regime.py::test_join_room_ack_includes_game_id -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/api/signaling.py web/static/play.js tests/test_late_join_regime.py
git commit -m "feat(server): add gameId to join-room ack (both reconnect and fresh-join)

Required by the spectator-first late-join gate. Hooks
__kn_lastJoinAck on both fresh-join and auto-spectate-retry
callbacks for E2E verification.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.3: Expose `romReady` for spectators in `_players_payload`

**Files:**
- Modify: `server/src/api/signaling.py` (`_players_payload` near line 220)
- Test: `tests/test_late_join_regime.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_late_join_regime.py`:

```python
def test_users_updated_includes_spectator_rom_ready(browser, server_url):
    """The host's promotion gate reads romReady for queued spectators
    via users-updated. Today the spectator dict in _players_payload
    omits romReady; this test pins the new behavior."""
    room = _new_room()
    host = browser.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&game=smash-remix")
    _wait_for_room_state(host, attribute="__lastUsersUpdated")

    spec = browser.new_page()
    spec.goto(f"{server_url}/play.html?room={room}&name=Spec&spectate=1")
    _wait_for_room_state(spec, attribute="__kn_lastJoinAck")
    # Wait for the host's roster to update
    host.wait_for_function(
        "window.__lastUsersUpdated && Object.keys(window.__lastUsersUpdated.spectators || {}).length >= 1",
        timeout=10000,
    )

    payload = host.evaluate("window.__lastUsersUpdated")
    specs = payload.get("spectators") or {}
    assert len(specs) >= 1
    one_spec = next(iter(specs.values()))
    assert "romReady" in one_spec, f"spectator missing romReady: {one_spec}"
    assert one_spec["romReady"] is False  # no ROM declared yet

    host.close()
    spec.close()
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run pytest tests/test_late_join_regime.py::test_users_updated_includes_spectator_rom_ready -v
```

Expected: FAIL — `romReady` not in spectator dict.

- [ ] **Step 3: Extend `_players_payload`**

In `server/src/api/signaling.py` find `_players_payload` (around line 218). Add `romReady` to the spectator comprehension to mirror the players' shape:

```python
"spectators": {
    pid: {
        "socketId": info["socketId"],
        "playerName": info.get("playerName", "Player"),
        "romReady": info["socketId"] in room.rom_ready,
    }
    for pid, info in room.spectators.items()
},
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
uv run pytest tests/test_late_join_regime.py::test_users_updated_includes_spectator_rom_ready -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/signaling.py tests/test_late_join_regime.py
git commit -m "feat(server): expose romReady for spectators in users-updated

The late-join promotion gate needs to know which queued spectators
have a ROM ready before firing host-promote-spectator. _players_payload
previously included romReady only on the players dict.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 2: Server events (`become-spectator`, `host-promote-spectator`)

Two new Socket.IO events and their Pydantic models. Used by the host to drive spectator → player promotion (happy path) and by the joiner to drop back to spectator on failure (recovery path).

### Task 2.1: Define Pydantic payload models

**Files:**
- Modify: `server/src/api/payloads.py` (append near other models)
- Test: `tests/test_late_join_regime.py`

- [ ] **Step 1: Write the failing test**

```python
def test_payloads_module_exports_new_models():
    """The two new events need Pydantic models for @validated decoration."""
    from src.api import payloads
    assert hasattr(payloads, "HostPromoteSpectatorPayload")
    assert hasattr(payloads, "BecomeSpectatorPayload")

    # Schema sanity (camelCase to match neighbors like StartGamePayload.gameId)
    p = payloads.HostPromoteSpectatorPayload(targetSid="abc123")
    assert p.targetSid == "abc123"
    p2 = payloads.BecomeSpectatorPayload()
    assert p2 is not None
```

Note: existing models in this file (e.g. `StartGamePayload.gameId`, `JoinRoomPayload.player_name`) mix conventions, but field names exposed to the wire (the JS side emits the field) consistently use camelCase. The new models follow the camelCase convention.

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run pytest tests/test_late_join_regime.py::test_payloads_module_exports_new_models -v
```

Expected: FAIL — `AttributeError`.

- [ ] **Step 3: Add the models in `server/src/api/payloads.py`**

Append to the file, mirroring the `EndGamePayload` and `ClaimSlotPayload` style:

```python
# ── host-promote-spectator ────────────────────────────────────────────────────


class HostPromoteSpectatorPayload(BaseModel):
    """Host-only event: promote a spectator into a free player slot.

    Used by the late-join regime when the host is at a controllable
    menu (CSS, stage select) and a queued spectator's ROM is ready.
    Mirrors claim-slot but with host identity check and no
    room.status block. See spec § Server-side state transitions.
    """
    targetSid: str = Field(..., min_length=1, max_length=64)


# ── become-spectator ──────────────────────────────────────────────────────────


class BecomeSpectatorPayload(BaseModel):
    """Joiner-side event: move self from players to spectators.

    Used only on failure-recovery paths (post-promotion handshake
    timeout). The sender's sid is the target; no body fields needed.
    """
    pass
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
uv run pytest tests/test_late_join_regime.py::test_payloads_module_exports_new_models -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/payloads.py tests/test_late_join_regime.py
git commit -m "feat(server): add Pydantic models for late-join promotion events

HostPromoteSpectatorPayload (targetSid: str) and BecomeSpectatorPayload
(empty body) back the two new Socket.IO events. camelCase field
names match wire conventions of neighboring models.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.2: Implement `become-spectator` event

**Files:**
- Modify: `server/src/api/signaling.py` (add after `_claim_slot_locked` near line 666; add import at top)
- Test: `tests/test_late_join_regime.py`

- [ ] **Step 1: Write the failing tests (happy path + host-blocked)**

```python
def test_become_spectator_moves_player_to_spectators(browser, server_url):
    """become-spectator moves the caller from players to spectators
    and broadcasts users-updated."""
    room = _new_room()
    host = browser.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&game=smash-remix")
    _wait_for_room_state(host, attribute="__lastUsersUpdated")

    guest = browser.new_page()
    guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
    guest.wait_for_function(
        "window.__test_socket && window.__test_socket.connected && window.__kn_lastJoinAck",
        timeout=10000,
    )

    err = guest.evaluate("""new Promise(r => {
        window.__test_socket.emit('become-spectator', {}, r);
    })""")
    assert err is None, f"become-spectator returned error: {err}"

    host.wait_for_function(
        "window.__lastUsersUpdated && Object.keys(window.__lastUsersUpdated.spectators || {}).length >= 1",
        timeout=5000,
    )
    payload = host.evaluate("window.__lastUsersUpdated")
    assert len(payload.get("players") or {}) == 1, "expected only host as player"
    assert len(payload.get("spectators") or {}) == 1, "expected guest as spectator"

    host.close()
    guest.close()


def test_become_spectator_host_blocked(browser, server_url):
    """The host (room owner) cannot become a spectator via this event;
    host departure goes through leave-room."""
    room = _new_room()
    host = browser.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&game=smash-remix")
    host.wait_for_function(
        "window.__test_socket && window.__test_socket.connected",
        timeout=10000,
    )

    err = host.evaluate("""new Promise(r => {
        window.__test_socket.emit('become-spectator', {}, r);
    })""")
    assert err is not None and "host" in err.lower()

    host.close()
```

(Idempotent-no-op and not-in-room cases are verified by inspection of the handler — keeping per-event tests minimal per project convention.)

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest tests/test_late_join_regime.py -k "become_spectator" -v
```

Expected: Both FAIL — event not registered.

- [ ] **Step 3: Implement the handler in `signaling.py`**

Add the import at the top of `signaling.py`:

```python
from src.api.payloads import (
    BecomeSpectatorPayload,
    HostPromoteSpectatorPayload,
    # ... existing imports
)
```

Add the handler after the `claim-slot` block (after `_claim_slot_locked` ends, around line 666):

```python
@sio.on("become-spectator")
@validated(BecomeSpectatorPayload)
async def become_spectator(sid: str, payload: BecomeSpectatorPayload) -> str | None:
    """Move the caller from room.players to room.spectators.

    Used only on failure-recovery paths (post-promotion handshake
    timeout). Returns None on success or an error string for diagnostics.
    """
    if not check(sid, "become-spectator"):
        return "Rate limited"
    async with _room_lock:
        return await _become_spectator_locked(sid)


async def _become_spectator_locked(sid: str) -> str | None:
    entry = _sid_to_room.get(sid)
    if entry is None:
        return "Not in a room"
    session_id, persistent_id, is_spectator = entry
    if is_spectator:
        return None  # idempotent no-op
    room = rooms.get(session_id)
    if room is None:
        return "Room not found"
    if room.owner == sid:
        return "Cannot self-demote: host"

    player_info = room.players.pop(persistent_id, None)
    if player_info is None:
        return "Not a player"
    player_name = player_info.get("playerName", "Player")
    for slot, slot_pid in list(room.slots.items()):
        if slot_pid == persistent_id:
            del room.slots[slot]
            break
    room.spectators[persistent_id] = {"socketId": sid, "playerName": player_name}
    _sid_to_room[sid] = (session_id, persistent_id, True)

    await sio.emit("users-updated", _players_payload(room), room=session_id)
    await state.save_room(session_id, room)
    log.info("SIO %s self-demoted to spectator in room %s", sid, session_id)
    return None
```

- [ ] **Step 4: Run the tests**

```bash
uv run pytest tests/test_late_join_regime.py -k "become_spectator" -v
```

Expected: Both PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/signaling.py tests/test_late_join_regime.py
git commit -m "feat(server): become-spectator event for late-join failure recovery

Inverse of claim-slot; moves the caller from room.players to
room.spectators, frees their slot, blocks the host from self-demoting.
Idempotent no-op when already a spectator.

Used only on failure-recovery paths in the late-join regime.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.3: Implement `host-promote-spectator` event

**Files:**
- Modify: `server/src/api/signaling.py` (add after `_become_spectator_locked`)
- Test: `tests/test_late_join_regime.py`

- [ ] **Step 1: Write the failing tests (happy path + non-host blocked)**

```python
def test_host_promote_spectator_moves_to_player_slot(browser, server_url):
    """host-promote-spectator moves targetSid from spectators to a
    free player slot, even while room.status == 'playing'."""
    room = _new_room()
    host = browser.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&game=smash-remix")
    _wait_for_room_state(host, attribute="__lastUsersUpdated")

    spec = browser.new_page()
    spec.goto(f"{server_url}/play.html?room={room}&name=Spec&spectate=1")
    spec.wait_for_function(
        "window.__test_socket && window.__test_socket.connected",
        timeout=10000,
    )
    spec_sid = spec.evaluate("window.__test_socket.id")
    host.wait_for_function(
        "window.__lastUsersUpdated && Object.keys(window.__lastUsersUpdated.spectators || {}).length >= 1",
        timeout=5000,
    )

    err = host.evaluate(f"""new Promise(r => {{
        window.__test_socket.emit('host-promote-spectator', {{ targetSid: '{spec_sid}' }}, r);
    }})""")
    assert err is None, f"promotion failed: {err}"

    host.wait_for_function(
        "window.__lastUsersUpdated && Object.keys(window.__lastUsersUpdated.players || {}).length >= 2",
        timeout=5000,
    )
    payload = host.evaluate("window.__lastUsersUpdated")
    assert len(payload.get("players") or {}) == 2
    assert len(payload.get("spectators") or {}) == 0

    host.close()
    spec.close()


def test_host_promote_spectator_non_host_blocked(browser, server_url):
    """Only the host may emit this event; non-host returns 'Not host'."""
    room = _new_room()
    host = browser.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&game=smash-remix")
    _wait_for_room_state(host, attribute="__lastUsersUpdated")

    spec = browser.new_page()
    spec.goto(f"{server_url}/play.html?room={room}&name=Spec&spectate=1")
    spec.wait_for_function(
        "window.__test_socket && window.__test_socket.connected",
        timeout=10000,
    )
    spec_sid = spec.evaluate("window.__test_socket.id")

    err = spec.evaluate(f"""new Promise(r => {{
        window.__test_socket.emit('host-promote-spectator', {{ targetSid: '{spec_sid}' }}, r);
    }})""")
    assert err is not None and "host" in err.lower()

    host.close()
    spec.close()
```

(No-slots case verified by inspection: `room.next_slot()` returns `None` when full, handler returns `"No slots available"`.)

- [ ] **Step 2: Run the tests to verify they fail**

```bash
uv run pytest tests/test_late_join_regime.py -k "host_promote_spectator" -v
```

Expected: Both FAIL — event not registered.

- [ ] **Step 3: Implement the handler in `signaling.py`**

Add after `_become_spectator_locked`:

```python
@sio.on("host-promote-spectator")
@validated(HostPromoteSpectatorPayload)
async def host_promote_spectator(sid: str, payload: HostPromoteSpectatorPayload) -> str | None:
    """Host-only: move targetSid from room.spectators into a free player slot.

    Mirror of claim-slot but with a host identity check replacing the
    room.status block — the host asserts it's a safe phase to promote.
    """
    if not check(sid, "host-promote-spectator"):
        return "Rate limited"
    async with _room_lock:
        return await _host_promote_spectator_locked(sid, payload)


async def _host_promote_spectator_locked(sid: str, payload: HostPromoteSpectatorPayload) -> str | None:
    entry = _sid_to_room.get(sid)
    if entry is None:
        return "Not in a room"
    session_id, _persistent_id, _is_spec = entry
    room = rooms.get(session_id)
    if room is None:
        return "Room not found"
    if room.owner != sid:
        return "Not host"

    target_pid = None
    for pid, info in room.spectators.items():
        if info["socketId"] == payload.targetSid:
            target_pid = pid
            break
    if target_pid is None:
        return "Target not spectator"

    slot = room.next_slot()
    if slot is None:
        return "No slots available"

    spec_info = room.spectators.pop(target_pid)
    player_name = spec_info.get("playerName", "Player")
    room.players[target_pid] = {"socketId": payload.targetSid, "playerName": player_name}
    room.slots[slot] = target_pid
    _sid_to_room[payload.targetSid] = (session_id, target_pid, False)

    await sio.emit("users-updated", _players_payload(room), room=session_id)
    await state.save_room(session_id, room)
    log.info(
        "SIO %s host-promoted spec %s to slot %d in room %s",
        sid, payload.targetSid, slot, session_id,
    )
    return None
```

- [ ] **Step 4: Run the tests**

```bash
uv run pytest tests/test_late_join_regime.py -k "host_promote_spectator" -v
```

Expected: Both PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/signaling.py tests/test_late_join_regime.py
git commit -m "feat(server): host-promote-spectator event for late-join promotion

Mirrors claim-slot with a host identity check replacing the
room.status block. The host asserts the in-game phase is safe
(verified via _readMenuLockstepPhase before emitting). Used by
the late-join regime to bring queued spectators onto the active
roster at controllable menu boundaries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 3: Targeted late-join-state (sender + receiver filter + buffering)

Adds `targetSid` to the existing `late-join-state` payload so multiple in-flight promotions don't collide on the receiver side. Also adds the `_pendingLateJoinMsg` buffer for the spectator-first flow where state can arrive before the joiner's emulator boots.

### Task 3.1: Sender adds `targetSid` to `late-join-state`

**Files:**
- Modify: `web/static/netplay-lockstep.js` (`sendLateJoinState`, the emit near line 4639)

- [ ] **Step 1: Add `targetSid` to the emit payload**

Find `sendLateJoinState` (around line 4516) and locate the `socket.emit('data-message', ...)` call near line 4639. Add `targetSid: remoteSid`:

```javascript
socket.emit('data-message', {
  type: 'late-join-state',
  targetSid: remoteSid,           // NEW: filter on receiver side
  frame: capturedFrame,
  data: encoded.data,
  effectiveDelay: DELAY_FRAMES,
  rbTransport: _rbTransport,
  rngValues,
  saveData,
});
```

- [ ] **Step 2: Verify by inspection**

```bash
grep -n "targetSid" web/static/netplay-lockstep.js
```

Expected: One match showing the emit site (more matches will be added in 3.2).

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat(lockstep): add targetSid to late-join-state emit

Forward-compatible field addition; old client receivers ignore it.
With multiple queued promotions in the new spectator-first regime,
late-join-state messages can be in flight to different SIDs
simultaneously; targetSid lets receivers filter cleanly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.2: Receiver filters on `targetSid`

**Files:**
- Modify: `web/static/netplay-lockstep.js` (`handleLateJoinState` at line 4653; expose a test handle)
- Test: `tests/test_late_join_regime.py`

- [ ] **Step 1: Expose the handler for unit-style testing**

The plan tests the filter as a unit: it doesn't rely on the server relaying a synthetic `data-message` (which may have ownership / phase guards). Instead, expose `handleLateJoinState` on `window` for tests, and call it directly.

Just below where the engine sets `window.__test_socket` (line 4584), add:

```javascript
window.__kn_handleLateJoinState = handleLateJoinState;
```

This is read-only test surface and is always safe to call — the function already returns early for spectators / running peers.

- [ ] **Step 2: Add an observable for the test (`__kn_lateJoinStateRan`)**

Inside `handleLateJoinState`, add ONE line that fires after the new targetSid filter, BEFORE any state mutation, to make "did the body actually run" observable:

```javascript
const handleLateJoinState = async (msg) => {
  if (msg.targetSid && msg.targetSid !== socket.id) return;
  window.__kn_lateJoinStateRan = (window.__kn_lateJoinStateRan || 0) + 1;
  if (_isSpectator) return;
  if (_phase === PHASE_RUNNING) return;
  // ... existing body unchanged
```

Counter is reset by tests via `window.__kn_lateJoinStateRan = 0` between calls.

- [ ] **Step 3: Write the failing test**

```python
def test_late_join_state_filters_on_target_sid(browser, server_url):
    """A late-join-state with targetSid != socket.id is filtered out
    before the handler body runs."""
    room = _new_room()
    host = browser.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&game=smash-remix")
    _wait_for_room_state(host, attribute="__lastUsersUpdated")

    # Reset the counter
    host.evaluate("window.__kn_lateJoinStateRan = 0;")

    # Mistargeted call: targetSid does not match host's socket id
    host.evaluate("""window.__kn_handleLateJoinState({
        type: 'late-join-state',
        targetSid: 'NOT_A_REAL_SID',
        frame: 0,
        data: '',
    });""")
    host.wait_for_timeout(100)

    ran = host.evaluate("window.__kn_lateJoinStateRan || 0")
    assert ran == 0, f"handler body ran despite targetSid mismatch (count={ran})"

    # Correctly-targeted call: targetSid matches; counter increments
    host.evaluate("""const sid = window.__test_socket.id;
        window.__kn_handleLateJoinState({
            type: 'late-join-state',
            targetSid: sid,
            frame: 0,
            data: '',
        });""")
    host.wait_for_timeout(100)
    ran2 = host.evaluate("window.__kn_lateJoinStateRan || 0")
    assert ran2 == 1, f"expected counter=1 after matching targetSid, got {ran2}"

    host.close()
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
uv run pytest tests/test_late_join_regime.py::test_late_join_state_filters_on_target_sid -v
```

Expected: FAIL on the first assertion — without the filter, the body runs even on a mistargeted call.

- [ ] **Step 5: Add the targetSid filter**

In `handleLateJoinState` (around line 4653), add the filter as the FIRST check, before any state read:

```javascript
const handleLateJoinState = async (msg) => {
  if (msg.targetSid && msg.targetSid !== socket.id) return;
  window.__kn_lateJoinStateRan = (window.__kn_lateJoinStateRan || 0) + 1;  // test observability
  if (_isSpectator) return;
  if (_phase === PHASE_RUNNING) return; // already running, ignore duplicate
  // ... rest of existing body unchanged
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
uv run pytest tests/test_late_join_regime.py::test_late_join_state_filters_on_target_sid -v
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/static/netplay-lockstep.js tests/test_late_join_regime.py
git commit -m "feat(lockstep): filter late-join-state on targetSid

Forward-compatible filter: messages without targetSid (old clients)
fall through unchanged. With targetSid set, only the intended
receiver runs handleLateJoinState — prevents collisions when
multiple promotions are in flight.

Adds window.__kn_handleLateJoinState test handle and
__kn_lateJoinStateRan counter for unit-style verification.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.3: Buffer late-join-state when emulator isn't booted

**Files:**
- Modify: `web/static/netplay-lockstep.js` (declare `_pendingLateJoinMsg` near `_awaitingLateJoinState` at line 1537; modify `handleLateJoinState`; add `applyPendingLateJoinState` and expose it)
- Test: `tests/test_late_join_regime.py`

- [ ] **Step 1: Declare the buffer and observable**

Find the `_awaitingLateJoinState` declaration (line 1537). Add immediately below:

```javascript
let _awaitingLateJoinState = false; // existing
let _pendingLateJoinMsg = null;     // joiner-local: cached late-join-state awaiting emulator boot
```

Also expose a test mirror at the same location where other window globals are set (look near line 580 where `KN_DEV_BUILD` is exposed; or at the same spot as `__test_socket` at line 4584):

```javascript
Object.defineProperty(window, '__kn_pendingLateJoinMsg', {
  get: () => _pendingLateJoinMsg ? { frame: _pendingLateJoinMsg.frame, hasData: !!_pendingLateJoinMsg.data } : null,
  configurable: true,
});
```

- [ ] **Step 2: Modify `handleLateJoinState` to buffer when emulator not ready**

Inside `handleLateJoinState`, after the targetSid filter and before the existing decompress block:

```javascript
const handleLateJoinState = async (msg) => {
  if (msg.targetSid && msg.targetSid !== socket.id) return;
  window.__kn_lateJoinStateRan = (window.__kn_lateJoinStateRan || 0) + 1;
  if (_isSpectator) return;
  if (_phase === PHASE_RUNNING) return;

  // Spectator-first promotion: the targeted state can arrive before
  // bootEmulator finishes. Cache the message and let the boot path
  // call applyPendingLateJoinState when gameManager is ready.
  const mod = window.EJS_emulator?.gameManager?.Module;
  if (!mod?.HEAPU8) {
    _pendingLateJoinMsg = msg;
    _syncLog(`late-join-state buffered (emulator not ready); ${Math.round((msg.data?.length || 0) / 1024)}KB`);
    return;
  }

  // ... existing decompress + apply logic continues
};
```

- [ ] **Step 3: Add `applyPendingLateJoinState` and expose it**

Right after `handleLateJoinState`, add:

```javascript
const applyPendingLateJoinState = async () => {
  if (!_pendingLateJoinMsg) return;
  const msg = _pendingLateJoinMsg;
  _pendingLateJoinMsg = null;
  _syncLog(`applying buffered late-join-state for frame ${msg.frame}`);
  return handleLateJoinState(msg);
};
```

Expose it at the same location as `__test_socket` (line 4584):

```javascript
window.kn_applyPendingLateJoinState = applyPendingLateJoinState;
```

(Naming: `kn_` prefix matches the C-level export naming used elsewhere in the engine, e.g. `kn_load_state_immediate`. This is the same pattern used for the engine's other public callable surfaces. It is NOT a private/test hook — production code in `play.js` will call it from the boot completion path in Chunk 4.)

- [ ] **Step 4: Write the test**

```python
def test_late_join_state_buffered_when_emulator_not_ready(browser, server_url):
    """A targeted late-join-state arriving before gameManager is
    ready is cached in _pendingLateJoinMsg and not applied until
    applyPendingLateJoinState is called."""
    room = _new_room()
    host = browser.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&game=smash-remix")
    _wait_for_room_state(host, attribute="__lastUsersUpdated")

    # Force "emulator not ready" by clearing the gameManager reference
    # via a sentinel. Cleanest path: use a fresh page that hasn't
    # booted emulator yet — but the host has booted. Instead, simulate
    # the buffer write by calling handleLateJoinState while spoofing
    # the "no Module" branch via a test toggle.
    #
    # For unit-level coverage, drive the buffer via a non-host page
    # that joins as a guest BEFORE booting (spectator), where
    # gameManager won't exist yet.
    spec = browser.new_page()
    spec.goto(f"{server_url}/play.html?room={room}&name=Spec&spectate=1")
    spec.wait_for_function(
        "window.__test_socket && window.__test_socket.connected && window.__kn_handleLateJoinState",
        timeout=10000,
    )
    spec_sid = spec.evaluate("window.__test_socket.id")

    # Spectator's _isSpectator is true so the function will return at
    # the spectator early-out before the emulator-not-ready branch.
    # To exercise the buffer branch, we toggle off _isSpectator via a
    # temporary test override and confirm the buffer fills.
    # Keep this test minimal: assert that calling apply on a fresh
    # page with no buffered message is a safe no-op (regression check).
    spec.evaluate("window.kn_applyPendingLateJoinState && window.kn_applyPendingLateJoinState();")
    pending = spec.evaluate("window.__kn_pendingLateJoinMsg")
    assert pending is None, f"unexpected buffered message: {pending}"

    spec.close()
    host.close()
```

The buffer-fill happy path is covered end-to-end in the Chunk 7 E2E test (the spectator-first flow exercises it naturally). This unit test verifies the apply function is a safe no-op when no message is buffered — that's the only piece worth pinning at this level.

- [ ] **Step 5: Run the test**

```bash
uv run pytest tests/test_late_join_regime.py::test_late_join_state_buffered_when_emulator_not_ready -v
```

Expected: PASS (apply is a no-op without a buffered message).

- [ ] **Step 6: Commit**

```bash
git add web/static/netplay-lockstep.js tests/test_late_join_regime.py
git commit -m "feat(lockstep): buffer late-join-state until emulator boots

In the spectator-first late-join regime, a targeted late-join-state
can arrive before the joiner's emulator has booted (the host fires
host-promote-spectator and then the targeted state on the same tick;
the joiner's bootEmulator is still completing). _pendingLateJoinMsg
caches the message; window.kn_applyPendingLateJoinState is called
from the boot completion path in Chunk 4 to apply the cached state
once gameManager is ready.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 4: Auto-spectate gate + decoupled emulator boot

Joiner-side: extend the existing auto-spectate gate to fire on `status === "playing"` for Smash Remix rooms. Defer emulator boot until promotion. Drive `kn_applyPendingLateJoinState` from the boot completion path.

### Task 4.1: Extend auto-spectate gate

**Files:**
- Modify: `web/static/play.js` (the `auto-spectate` block at line 571–577)
- Test: `tests/test_late_join_regime.py`

- [ ] **Step 1: Write the failing test**

```python
def test_auto_spectate_when_status_playing_smash_remix(browser, server_url):
    """A guest joining a Smash Remix room with status='playing' is
    routed to spectator mode automatically, even when slots are free."""
    room = _new_room()
    host = browser.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&game=smash-remix")
    _wait_for_room_state(host, attribute="__lastUsersUpdated")

    # Server's start-game handler rejects with "Not all players have
    # a ROM loaded" until rom-ready is emitted (signaling.py:726).
    # See tests/test_security.py:20 and tests/test_watch_link.py:14
    # for the same setup pattern.
    host.evaluate("window.__test_socket.emit('rom-ready', { ready: true });")
    err = host.evaluate("""new Promise(r => {
        window.__test_socket.emit('start-game', { mode: 'lockstep' }, r);
    })""")
    assert err is None, f"start-game failed: {err}"
    host.wait_for_function(
        "window.__lastUsersUpdated && window.__lastUsersUpdated.status === 'playing'",
        timeout=5000,
    )

    guest = browser.new_page()
    guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
    guest.wait_for_function(
        "window.__kn_lastJoinAck && window.__kn_lastJoinAck.gameId === 'smash-remix'",
        timeout=10000,
    )
    # Auto-spectate flag should be set
    auto = guest.evaluate("window._autoSpectated || false")
    assert auto is True, "guest should have auto-spectated for Smash Remix mid-match join"

    host.close()
    guest.close()
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run pytest tests/test_late_join_regime.py::test_auto_spectate_when_status_playing_smash_remix -v
```

Expected: FAIL — guest joins as a player, `_autoSpectated` is `false`.

- [ ] **Step 3: Extend the gate in `play.js`**

In `web/static/play.js` find the auto-spectate block at line 571:

```javascript
if (!isSpectator && roomData.player_count >= roomData.max_players) {
  console.log(...);
  isSpectator = true;
  _autoSpectated = true;
}
```

Extend to also fire on Smash Remix mid-match:

```javascript
if (!isSpectator && roomData.player_count >= roomData.max_players) {
  console.log(`[play] auto-spectate: room full (${roomData.player_count}/${roomData.max_players})`);
  isSpectator = true;
  _autoSpectated = true;
}
if (!isSpectator && roomData.status === 'playing' && roomData.gameId === 'smash-remix') {
  console.log(`[play] auto-spectate: Smash Remix mid-match (will promote at next CSS)`);
  isSpectator = true;
  _autoSpectated = true;
}
```

Also expose `_autoSpectated` on `window` near `window._isSpectator` (search for that line):

```javascript
window._autoSpectated = _autoSpectated;
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
uv run pytest tests/test_late_join_regime.py::test_auto_spectate_when_status_playing_smash_remix -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/static/play.js tests/test_late_join_regime.py
git commit -m "feat(client): auto-spectate Smash Remix joiners when status=playing

Mid-match joiners on Smash Remix rooms are routed to spectator mode
automatically. The host promotes them at the next controllable menu
(CSS / stage select) via host-promote-spectator. Other games keep
today's player-first behavior.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 4.2: Drive `kn_applyPendingLateJoinState` from boot completion

**Files:**
- Modify: `web/static/play.js` (boot completion handler / `bootEmulator` finish path)

- [ ] **Step 1: Find the boot completion point**

In `play.js` and `netplay-lockstep.js`, locate where the engine signals boot is complete and `gameManager.Module.HEAPU8` is available. Two candidate sites:
- `bootEmulator()` finish path in play.js (search for `bootEmulator` and the post-`EJS_emulator` initialization where `gameManager` is asserted ready).
- `waitForEmu` callback site near `netplay-lockstep.js:3922`.

The cleanest place is right after the engine confirms the emulator is ready, just before the existing `request-late-join` emit at netplay-lockstep.js line 3931. That site already gates on `_lateJoin || hostAlreadyRunning`. Add a parallel call before the late-join request fires:

```javascript
// Apply any pre-boot-buffered late-join-state.
if (window.kn_applyPendingLateJoinState) {
  await window.kn_applyPendingLateJoinState();
}

const hostAlreadyRunning = _lastRemoteFrame > 0;
if ((_lateJoin || hostAlreadyRunning) && _playerSlot !== 0) {
  // ... existing code unchanged
}
```

The `applyPendingLateJoinState` call is a no-op when nothing is buffered (verified by Chunk 3.3 test).

**Important: avoid double-fire of `request-late-join`.** `handleLateJoinState` does NOT clear `_lateJoin` today (verified: only assignments are at engine init line 1336 and teardown line 9319). After `applyPendingLateJoinState` runs, `_lateJoin` is still true and the conditional at line 3929 (`_lateJoin || hostAlreadyRunning`) would fire `request-late-join` a second time — duplicate state transfer, two pause-and-load cycles.

Fix in `handleLateJoinState` near the top of its successful-path body (right after the `_awaitingLateJoinState = false` line at line 4658). Add:

```javascript
_awaitingLateJoinState = false;
_lateJoin = false; // prevents duplicate request-late-join after applyPendingLateJoinState
```

This is a one-line targeted change and must land in this same task before the apply call is wired in.

- [ ] **Step 2: Add a smoke test that the call is a no-op when nothing is buffered**

This is already covered by `test_late_join_state_buffered_when_emulator_not_ready` in Chunk 3.3 (apply with no buffer is a no-op). No new test needed for this task.

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat(lockstep): apply buffered late-join-state at boot completion

After bootEmulator finishes and gameManager.Module is ready, drain
the _pendingLateJoinMsg buffer by calling applyPendingLateJoinState.
No-op when nothing is buffered (regression-tested in Chunk 3.3).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 4.3: Watching banner UI (minimal)

**Files:**
- Modify: `web/play.html` (repurpose `#guest-status` for the watching banner; existing element)
- Modify: `web/static/play.js` (set the banner text when auto-spectated for the new flow)

- [ ] **Step 1: Identify the existing `#guest-status` element**

```bash
grep -n "guest-status" web/play.html web/static/play.js
```

The element exists; the spec calls for repurposing it. No new HTML element needed; just set its text and ensure visibility when `_autoSpectated && roomData.status === 'playing'`.

- [ ] **Step 2: Set the banner text in `play.js`**

In the auto-spectate branch added in Task 4.1, after setting `_autoSpectated = true` for the Smash Remix mid-match case, add:

```javascript
if (!isSpectator && roomData.status === 'playing' && roomData.gameId === 'smash-remix') {
  isSpectator = true;
  _autoSpectated = true;
  const guestStatus = document.getElementById('guest-status');
  if (guestStatus) {
    guestStatus.textContent = 'Watching current match — joining at next character select';
    guestStatus.style.display = '';
  }
}
```

The banner is cleared when promotion fires (Chunk 5 will clear it inside the promotion-receive handler).

- [ ] **Step 3: Smoke-test by inspection**

```bash
grep -n "Watching current match" web/static/play.js
```

Expected: One match.

A visual Playwright test of this banner is part of the Chunk 7 E2E (`test_late_join_e2e.py`).

- [ ] **Step 4: Commit**

```bash
git add web/static/play.js
git commit -m "feat(client): show watching banner during Smash Remix mid-match join

Repurposes the existing #guest-status element with the watching copy
when _autoSpectated for the new flow. Banner is cleared at promotion
time in Chunk 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 5: Host promotion logic (queue, edge detector, helper)

Host-side: maintain `_pendingPromotions`, detect the rising edge of `phase.inControllableMenu` inside `_broadcastPhaseIfNeeded`, fire `host-promote-spectator` per ROM-ready entry, then send a targeted `late-join-state`.

### Task 5.1: Add the `_pendingPromotions` queue and `promoteSpectator` helper

**Files:**
- Modify: `web/static/netplay-lockstep.js` (state declarations, new helper near `sendLateJoinState`)

- [ ] **Step 1: Add state declarations**

Near `_awaitingLateJoinState` (line 1537) add:

```javascript
let _pendingPromotions = []; // host-only: [{ sid, romReady, queuedAt }, ...]
let _lastInControllableMenu = false; // host-only: prev-frame value for rising-edge detection
```

- [ ] **Step 2: Add the `promoteSpectator` helper**

Just before `sendLateJoinState` (line 4516), add:

```javascript
async function promoteSpectator(targetSid) {
  if (_playerSlot !== 0) return; // host only
  if (!socket || !socket.connected) return;

  // Step 1: server-side move (spectators -> players)
  const err = await new Promise((resolve) => {
    socket.emit('host-promote-spectator', { targetSid }, resolve);
  });
  if (err) {
    _syncLog(`promoteSpectator(${targetSid}) failed: ${err}; re-queueing`);
    // Re-queue at the back (will retry at next safe-phase edge)
    _pendingPromotions.push({ sid: targetSid, romReady: true, queuedAt: performance.now() });
    return;
  }

  _syncLog(`promoteSpectator(${targetSid}) server ack OK; sending targeted late-join-state`);
  // Step 2: targeted state transfer (existing machinery; targetSid added in Chunk 3.1)
  await sendLateJoinState(targetSid);
}
```

- [ ] **Step 3: Verify the helper compiles in the page**

```bash
grep -n "promoteSpectator\b" web/static/netplay-lockstep.js
```

Expected: function declaration + usages once Task 5.2 lands.

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat(lockstep): add _pendingPromotions queue and promoteSpectator helper

State scaffolding for the host-driven promotion path. promoteSpectator
emits host-promote-spectator first (server move + users-updated
broadcast), then runs sendLateJoinState (which now carries targetSid
from Chunk 3.1). Re-queues on server-side error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5.2: Hook `onUsersUpdated` to enqueue new spectators

**Files:**
- Modify: `web/static/netplay-lockstep.js` (`onUsersUpdated` at line 2137)
- Test: `tests/test_late_join_regime.py`

- [ ] **Step 1: Write the failing test**

```python
def test_host_queues_new_spectator_in_pending_promotions(browser, server_url):
    """When a guest joins a playing Smash Remix room as a spectator,
    the host enqueues them in _pendingPromotions."""
    room = _new_room()
    host = browser.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&game=smash-remix")
    _wait_for_room_state(host, attribute="__lastUsersUpdated")
    # Start the game so room.status flips to 'playing'.
    # rom-ready required first (signaling.py:726).
    host.evaluate("window.__test_socket.emit('rom-ready', { ready: true });")
    host.evaluate("window.__test_socket.emit('start-game', { mode: 'lockstep' });")
    host.wait_for_function(
        "window.__lastUsersUpdated && window.__lastUsersUpdated.status === 'playing'",
        timeout=5000,
    )

    guest = browser.new_page()
    guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
    guest.wait_for_function(
        "window._autoSpectated === true",  # set by Chunk 4.1
        timeout=10000,
    )
    guest_sid = guest.evaluate("window.__test_socket.id")

    host.wait_for_function(
        f"window.__kn_pendingPromotions && window.__kn_pendingPromotions.some(p => p.sid === '{guest_sid}')",
        timeout=5000,
    )
    queue = host.evaluate("window.__kn_pendingPromotions")
    assert any(entry["sid"] == guest_sid for entry in queue), f"guest not enqueued: {queue}"

    host.close()
    guest.close()
```

- [ ] **Step 2: Expose `_pendingPromotions` for tests**

Near where `__test_socket` is exposed (line 4584):

```javascript
Object.defineProperty(window, '__kn_pendingPromotions', {
  get: () => _pendingPromotions.map((p) => ({ sid: p.sid, romReady: p.romReady, queuedAt: p.queuedAt })),
  configurable: true,
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
uv run pytest tests/test_late_join_regime.py::test_host_queues_new_spectator_in_pending_promotions -v
```

Expected: FAIL — queue is empty; no enqueue logic yet.

- [ ] **Step 4: Add the enqueue branch in `onUsersUpdated`**

In `onUsersUpdated` (line 2137), find the spectator iteration block (search for `Object.values(spectators)`). Inside it, on the host side (`_playerSlot === 0`), enqueue any new spectator that's not already in the queue, when `room.status === 'playing'`:

```javascript
// Inside onUsersUpdated, after the existing spectator handling:
if (_playerSlot === 0 && data.status === 'playing') {
  for (const s of Object.values(data.spectators || {})) {
    if (s.socketId === socket.id) continue;
    if (_pendingPromotions.some((p) => p.sid === s.socketId)) continue;
    _pendingPromotions.push({
      sid: s.socketId,
      romReady: !!s.romReady,
      queuedAt: performance.now(),
    });
    _syncLog(`pending-promote: queued ${s.socketId} (romReady=${!!s.romReady})`);
  }
  // Drop entries for spectators who left
  _pendingPromotions = _pendingPromotions.filter(
    (p) => Object.values(data.spectators || {}).some((s) => s.socketId === p.sid),
  );
  // Update romReady on entries (in case rom-ready arrived since enqueue)
  for (const entry of _pendingPromotions) {
    const fresh = Object.values(data.spectators || {}).find((s) => s.socketId === entry.sid);
    if (fresh && fresh.romReady) entry.romReady = true;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
uv run pytest tests/test_late_join_regime.py::test_host_queues_new_spectator_in_pending_promotions -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/static/netplay-lockstep.js tests/test_late_join_regime.py
git commit -m "feat(lockstep): enqueue spectators in _pendingPromotions on users-updated

The host watches users-updated for spectator entries while
status=='playing'. New spectators are pushed onto _pendingPromotions;
existing entries get romReady refreshed; departed spectators are
removed. Drained later by the phase-edge detector (Task 5.3).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5.3: Phase-edge detector — drain queue on rising edge

**Files:**
- Modify: `web/static/netplay-lockstep.js` (`_broadcastPhaseIfNeeded` at line 5026)
- Test: by inspection (full E2E in Chunk 7)

- [ ] **Step 1: Add the rising-edge detection and drain**

In `_broadcastPhaseIfNeeded` (line 5026):

```javascript
const _broadcastPhaseIfNeeded = (nowMs) => {
  if (!_isSmashRemix()) return;
  const phase = _readMenuLockstepPhase(true);

  // Phase-edge detector: drain pending promotions when entering a controllable menu.
  if (_playerSlot === 0) {
    const nowControllable = !!phase.inControllableMenu;
    const wasControllable = _lastInControllableMenu;
    _lastInControllableMenu = nowControllable;
    const onRisingEdge = nowControllable && !wasControllable;
    // Drain on rising edge OR if already in controllable menu and ROM became ready since last tick
    if ((onRisingEdge || nowControllable) && _pendingPromotions.length > 0) {
      const ready = _pendingPromotions.filter((p) => p.romReady);
      const remaining = _pendingPromotions.filter((p) => !p.romReady);
      _pendingPromotions = remaining;
      for (const entry of ready) {
        _syncLog(`pending-promote: draining ${entry.sid} (controllable menu)`);
        promoteSpectator(entry.sid).catch((err) => {
          _syncLog(`promoteSpectator threw: ${err}`);
        });
      }
    }
  }

  // ... existing broadcast code unchanged
  const key = `${phase.sceneCurr}:${phase.gameStatus}`;
  if (key === _lastPhaseBroadcastKey && nowMs - _lastPhaseBroadcastAt < PHASE_BROADCAST_INTERVAL_MS) return;
  // ...
};
```

- [ ] **Step 2: Smoke-verify by inspection**

```bash
grep -n "pending-promote: draining" web/static/netplay-lockstep.js
```

Expected: One match.

The full edge-detector test runs at E2E level in Chunk 7 (3-player late-join scenario verifies both the queue + the drain end-to-end).

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat(lockstep): drain _pendingPromotions on inControllableMenu rising edge

The host's phase detector inside _broadcastPhaseIfNeeded watches
phase.inControllableMenu; on the false→true edge (or any tick where
controllable menu is true and a queued spectator just became
ROM-ready), drain ROM-ready entries via promoteSpectator(). Entries
without ROM stay queued across cycles.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 5.4: Joiner-side handling of promotion-induced `users-updated`

**Files:**
- Modify: `web/static/play.js` (the `users-updated` socket handler around line 866)

- [ ] **Step 1: Detect self-promotion in users-updated**

When the joiner sees their own SID move from `spectators` to `players`, they need to clear the watching banner and set up for the incoming `late-join-state`. The Chunk 3.3 buffer already handles state-arrives-before-boot; this task is about UI state.

In `play.js`, in the `users-updated` handler, add:

```javascript
socket.on('users-updated', (data) => {
  window.__lastUsersUpdated = data;
  // ... existing logic

  // Self-promotion detection
  const myEntry = (data.players || {})[Object.keys(data.players || {}).find(
    (pid) => data.players[pid].socketId === socket.id
  )];
  const wasSpectator = isSpectator;
  if (wasSpectator && myEntry) {
    isSpectator = false;
    _autoSpectated = false;
    mySlot = myEntry.slot;
    window._isSpectator = false;
    window._playerSlot = mySlot;
    const guestStatus = document.getElementById('guest-status');
    if (guestStatus) guestStatus.style.display = 'none';
    // Trigger emulator boot now that we're a player.
    // bootEmulator() at play.js:2177 early-returns if window.EJS_emulator
    // already exists. Spectators never boot EJS today (auto-spectate
    // gate at play.js:571-577 + downstream isSpectator checks short-
    // circuit boot), so the call here will actually run rather than
    // bail out. Verify with a Playwright probe in Chunk 7.3.
    if (typeof bootEmulator === 'function') bootEmulator();
  }
});
```

- [ ] **Step 2: Smoke-verify by inspection**

```bash
grep -n "Self-promotion detection" web/static/play.js
```

Expected: One match.

End-to-end coverage in Chunk 7.

- [ ] **Step 3: Commit**

```bash
git add web/static/play.js
git commit -m "feat(client): on self-promotion via users-updated, boot emulator + clear banner

When the host fires host-promote-spectator, the server broadcasts a
users-updated showing the joiner in players. The joiner's handler
detects self-promotion, clears the watching banner, sets _isSpectator
false, and triggers bootEmulator. The targeted late-join-state arrives
on the same tick; if it lands first it's buffered (Chunk 3.3) and
applied at boot completion (Chunk 4.2).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 6: Demotion cleanup in `onUsersUpdated`

When a SID moves from `room.players` to `room.spectators` (failure recovery via `become-spectator`, or admin action), every peer's view needs to reset that peer's per-slot state, attach the spectator stream, and (for the demoted self) flip back to spectator mode.

### Task 6.1: Detect demotion in `onUsersUpdated`

**Files:**
- Modify: `web/static/netplay-lockstep.js` (`onUsersUpdated` at line 2137)
- Test: by inspection + Chunk 7 E2E

- [ ] **Step 1: Track the prior-tick player roster on the host**

The handler today already maintains `_knownPlayers` (rebuilt every call). To detect demotion (was-player-now-spectator) we need the previous tick's player set. Add a shadow:

```javascript
let _prevPlayerSidToSlot = {}; // SID -> slot from the previous users-updated
```

Near `_knownPlayers` initialization in the engine state block.

- [ ] **Step 2: At the top of `onUsersUpdated`, compute the demotion set**

```javascript
const onUsersUpdated = (data) => {
  const { players = {}, spectators = {} } = data;

  // Demotion detection: was in players last tick, now in spectators
  const newPlayerSids = new Set(Object.values(players).map((p) => p.socketId));
  const newSpecSids = new Set(Object.values(spectators).map((s) => s.socketId));
  const demotedSids = [];
  for (const [sid, oldSlot] of Object.entries(_prevPlayerSidToSlot)) {
    if (!newPlayerSids.has(sid) && newSpecSids.has(sid)) {
      demotedSids.push({ sid, oldSlot });
    }
  }

  // Process demotions before the rest of the handler updates _knownPlayers etc.
  for (const { sid, oldSlot } of demotedSids) {
    _syncLog(`demotion detected: ${sid} (was slot ${oldSlot}) -> spectator`);
    if (oldSlot !== null && oldSlot !== undefined) {
      // resetPeerState is for REMOTE peer state (per-slot input maps,
      // pacing, phantom flags). Calling it on the local self-slot is a
      // no-op for those maps. The local-self teardown (stopping the
      // tick loop, clearing _localInputs, resetting _phase) is the
      // step below.
      resetPeerState(oldSlot, 'demoted-to-spectator');
    }
    if (_peers[sid]) {
      _peers[sid].slot = null;
    }
    if (_playerSlot === 0 && typeof startSpectatorStreamForPeer === 'function') {
      startSpectatorStreamForPeer(sid);
    }
    if (sid === socket.id) {
      // Self-demotion: real local teardown.
      _playerSlot = null;
      _isSpectator = true;
      window._isSpectator = true;
      window._playerSlot = null;
      // Stop the local tick loop and reset engine phase so we don't
      // continue emitting inputs that the server no longer accepts.
      _phase = PHASE_IDLE;
      _runSubstate = RUN_NORMAL;
      // Clear any pending local input batches so we don't replay them
      // post-demotion. _localInputs is a plain object (frame -> input)
      // declared at line 1245, not a Map.
      _localInputs = {};
      // The engine's existing tick scheduler observes _phase and exits
      // its loop on PHASE_IDLE; no explicit cancelAnimationFrame needed.
      _syncLog('self-demoted to spectator: tick loop will exit on next iteration');
    }
  }

  // ... existing handler body (rebuilding _knownPlayers, peer mesh, etc.)

  // At the end of the handler, refresh the shadow for the next tick
  _prevPlayerSidToSlot = {};
  for (const p of Object.values(players)) {
    _prevPlayerSidToSlot[p.socketId] = p.slot;
  }
};
```

- [ ] **Step 3: Smoke-verify by inspection**

```bash
grep -n "demoted-to-spectator" web/static/netplay-lockstep.js
```

Expected: One or two matches (the resetPeerState reason and the log line).

End-to-end coverage in Chunk 7's E2E test (failure path triggers demotion).

- [ ] **Step 4: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat(lockstep): clean up peer state on player->spectator demotion

onUsersUpdated now tracks the prior-tick player roster and detects
SIDs that moved from players to spectators between ticks. For each
demoted SID: resetPeerState(oldSlot, 'demoted-to-spectator') (I2),
clear peer.slot, host attaches startSpectatorStreamForPeer, and if
self is demoted, flip _playerSlot to null and _isSpectator to true.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Chunk 7: Failure path + UX polish + integration test

### Task 7.1: Failure path — emit `become-spectator` and re-queue on timeout

**Files:**
- Modify: `web/static/netplay-lockstep.js` (`LATE_JOIN_TIMEOUT_MS` host-side handler around line 4633)

- [ ] **Step 1: Modify the host-side timeout handler**

The current handler at line 4633 calls `hardDisconnectPeer(remoteSid)` on timeout. For the new flow, emit `become-spectator` for the joiner, leave the peer's WebRTC connection up so they keep getting video, and re-queue them in `_pendingPromotions`:

```javascript
}, LATE_JOIN_TIMEOUT_MS);

// (existing log of the send) unchanged
```

Locate the timeout body (search for `hardDisconnectPeer(remoteSid)` after `LATE_JOIN_TIMEOUT_MS`). Replace the body inside the timeout callback with:

```javascript
const timer = setTimeout(() => {
  // The behavior change here applies ONLY to Smash Remix (the new
  // spectator-first regime). Non-Smash games keep today's recovery
  // (hardDisconnectPeer) — they don't have a phase-edge detector or
  // _pendingPromotions queue, so re-queueing would silently strand
  // them.
  if (_isSmashRemix()) {
    _syncLog(`LATE-JOIN-TIMEOUT for ${remoteSid}; re-queueing for next safe phase`);
    _pendingPromotions.push({ sid: remoteSid, romReady: true, queuedAt: performance.now() });
    // Notify the joiner so they can self-demote via become-spectator.
    socket.emit('data-message', {
      type: 'late-join-timeout',
      targetSid: remoteSid,
    });
  } else {
    // Existing behavior unchanged for non-Smash games.
    if (_peers[remoteSid]) hardDisconnectPeer(remoteSid);
  }
}, LATE_JOIN_TIMEOUT_MS);
```

Add a corresponding handler on the joiner side in `onDataMessage`:

```javascript
if (msg.type === 'late-join-timeout' && msg.targetSid === socket.id) {
  _syncLog('host reported LATE-JOIN-TIMEOUT; demoting self to spectator');
  if (_playerSlot !== null && _playerSlot !== undefined) {
    resetPeerState(_playerSlot, 'late-join-timeout-self');
  }
  socket.emit('become-spectator', {});
  setStatus('Sync failed — back to watching. Will retry at next character select.');
}
```

- [ ] **Step 2: Smoke-verify by inspection**

```bash
grep -n "LATE-JOIN-TIMEOUT" web/static/netplay-lockstep.js
```

Expected: At least two matches.

End-to-end coverage in the Chunk 7 E2E test below.

- [ ] **Step 3: Commit**

```bash
git add web/static/netplay-lockstep.js
git commit -m "feat(lockstep): on LATE-JOIN-TIMEOUT, demote joiner and re-queue

Replaces hardDisconnectPeer with a softer recovery: host re-queues
the joiner in _pendingPromotions and notifies them via a targeted
late-join-timeout DC message. Joiner emits become-spectator to clear
server-side player state and resets their own peer state via
resetPeerState (I2). Status copy reflects the retry semantics.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 7.2: Active-player banner + stage-aware joiner status copy

**Files:**
- Modify: `web/play.html` (add a banner element)
- Modify: `web/static/play.js` (drive the banner from `_runSubstate` observation)

- [ ] **Step 1: Add the banner element to `web/play.html`**

Inside the toolbar area (find the existing toolbar div), add:

```html
<div id="late-join-banner" class="late-join-banner hidden" aria-live="polite">
  <span id="late-join-banner-text">Player joining…</span>
</div>
```

Add minimal CSS in the same file or in the existing style block:

```css
.late-join-banner {
  position: absolute;
  top: 8px;
  right: 8px;
  background: rgba(0, 0, 0, 0.7);
  color: #6af;
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 13px;
  z-index: 100;
}
.late-join-banner.hidden { display: none; }
```

- [ ] **Step 2: Drive the banner from `play.js` via CustomEvents**

Replace polling with event-driven dispatch. The engine already has TWO sites that flip `_runSubstate` to/from `RUN_LATE_JOIN_PAUSE`:
- Pause start: assignment around `netplay-lockstep.js:2854` (DC `late-join-pause` handler).
- Pause end: clear at `netplay-lockstep.js:2107` (Socket.IO `late-join-ready`) and `:2858` (DC `late-join-ready`) and `:4614` (timeout cleanup).

At each of these four sites, dispatch a CustomEvent on `document`:

```javascript
// At pause start:
_runSubstate = RUN_LATE_JOIN_PAUSE;
document.dispatchEvent(new CustomEvent('kn-late-join-pause', { detail: { startedAt: performance.now() } }));

// At each pause clear (three sites):
if (_runSubstate === RUN_LATE_JOIN_PAUSE) {
  _runSubstate = RUN_NORMAL;
  document.dispatchEvent(new CustomEvent('kn-late-join-resume'));
}
```

In `play.js`, add a single listener pair (no `setInterval`):

```javascript
let _lateJoinBannerTimer = null;
document.addEventListener('kn-late-join-pause', (e) => {
  const banner = document.getElementById('late-join-banner');
  const txt = document.getElementById('late-join-banner-text');
  if (!banner || !txt) return;
  const startedAt = e.detail?.startedAt || performance.now();
  const tick = () => {
    const seconds = Math.max(0, Math.round((performance.now() - startedAt) / 1000));
    txt.textContent = `Player joining… (${seconds}s)`;
  };
  tick();
  banner.classList.remove('hidden');
  if (_lateJoinBannerTimer) clearInterval(_lateJoinBannerTimer);
  _lateJoinBannerTimer = setInterval(tick, 1000);
});
document.addEventListener('kn-late-join-resume', () => {
  const banner = document.getElementById('late-join-banner');
  if (banner) banner.classList.add('hidden');
  if (_lateJoinBannerTimer) {
    clearInterval(_lateJoinBannerTimer);
    _lateJoinBannerTimer = null;
  }
});
```

The 1Hz `setInterval` runs only during the pause and stops on resume — no perpetual polling.

- [ ] **Step 3: Stage-aware joiner status copy**

In the joiner's status callback (the `onStatus` config callback registered when `play.js` constructs the engine), map the existing engine status strings to friendlier copy:

| Engine status | UX copy |
|---|---|
| `Requesting game state...` | `Connecting…` |
| `Loading late-join state...` | `Syncing game state…` |
| `late-join-paused` (substate) | `Almost ready…` |

Implement as a simple lookup map in the existing `onStatus` callback. No new plumbing needed.

- [ ] **Step 4: Smoke-verify by inspection**

```bash
grep -n "late-join-banner" web/play.html web/static/play.js
```

Expected: At least three matches across the two files.

- [ ] **Step 5: Commit**

```bash
git add web/play.html web/static/play.js web/static/netplay-lockstep.js
git commit -m "feat(client): active-player banner + stage-aware joiner copy

During a late-join pause, active players see a small "Player joining…"
banner with a wall-clock counter, replacing the previous silent
freeze. Joiner sees 'Connecting…' / 'Syncing game state…' / 'Almost
ready…' instead of generic 'Loading…' or engine-internal status
strings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 7.3: End-to-end test — 3-player late-join scenario

**Files:**
- Create: `tests/test_late_join_e2e.py`

- [ ] **Step 1: Write the E2E test**

```python
"""End-to-end test of the spectator-first late-join regime.

Reproduces the user-reported bug:
  "Two iPhones playing, laptop joins as 3rd; original game freezes,
   eventually a DC toast appears, 3rd player loads but inputs don't work."

After the fix:
  - 3rd player auto-spectates when joining a Smash Remix mid-match room.
  - Watching banner is visible.
  - When the host returns to a controllable menu, host-promote-spectator
    fires, late-join-state is targeted to the joiner, joiner becomes a
    player with controls enabled.
  - No half-initialized player slot.

Run: uv run pytest tests/test_late_join_e2e.py -v --headed
"""

import secrets
from playwright.sync_api import expect


def _new_room():
    return "E" + secrets.token_hex(3).upper()


def test_three_player_late_join_spectator_first(browser, server_url):
    room = _new_room()
    host = browser.new_page()
    p2 = browser.new_page()
    pages = [host, p2]

    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&game=smash-remix")
        host.wait_for_function("window.__lastUsersUpdated", timeout=10000)

        p2.goto(f"{server_url}/play.html?room={room}&name=P2")
        p2.wait_for_function("window.__lastUsersUpdated", timeout=10000)

        # Host starts the game (status flips to playing).
        # rom-ready required first (signaling.py:726).
        host.evaluate("window.__test_socket.emit('rom-ready', { ready: true });")
        host.evaluate("window.__test_socket.emit('start-game', { mode: 'lockstep' });")
        host.wait_for_function(
            "window.__lastUsersUpdated && window.__lastUsersUpdated.status === 'playing'",
            timeout=5000,
        )

        # 3rd player joins
        p3 = browser.new_page()
        pages.append(p3)
        p3.goto(f"{server_url}/play.html?room={room}&name=P3")
        p3.wait_for_function("window._autoSpectated === true", timeout=10000)

        # Watching banner visible
        guest_status = p3.locator("#guest-status")
        expect(guest_status).to_contain_text("Watching current match")

        # Host has p3 in pendingPromotions
        host.wait_for_function(
            "window.__kn_pendingPromotions && window.__kn_pendingPromotions.length >= 1",
            timeout=5000,
        )

        # Simulate "host returns to controllable menu" by setting a test
        # override on _readMenuLockstepPhase. The engine exposes a test
        # hook for this purpose (added below).
        host.evaluate("window.__kn_forceInControllableMenu = true;")
        # Wait for drain — host-promote-spectator fires + late-join-state
        # is sent + p3 sees self in players
        p3.wait_for_function(
            "window._isSpectator === false && window._playerSlot !== null",
            timeout=15000,
        )

        # Watching banner cleared
        expect(guest_status).to_be_hidden()

    finally:
        for p in pages:
            p.close()
```

The test relies on a `__kn_forceInControllableMenu` test override that bypasses the RDRAM phase read. **Guard it behind `KN_DEV_BUILD`** (already exists at `netplay-lockstep.js:573-580`) so it is not callable in production:

```javascript
const _readMenuLockstepPhase = (enabled) => {
  if (window.KN_DEV_BUILD && window.__kn_forceInControllableMenu) {
    return {
      gameStatus: 0,
      sceneCurr: 18,
      inControllableMenu: true,
      gameplay: false,
      active: true,
      waitingPeerSlots: [],
    };
  }
  // ... existing body
};
```

`KN_DEV_BUILD` is set per-build; production builds set it to `false` so the override is dead code.

- [ ] **Step 2: Run the test (allow up to 60s)**

```bash
uv run pytest tests/test_late_join_e2e.py -v --headed
```

Expected: PASS (note: the actual emulator is involved; first run may need ROM cache warmup).

If the test is flaky in CI, pin it under a `@pytest.mark.e2e` marker and document running it locally only.

- [ ] **Step 3: Commit**

```bash
git add tests/test_late_join_e2e.py web/static/netplay-lockstep.js
git commit -m "test: end-to-end 3-player late-join scenario

Reproduces the original bug from the user report and verifies the
spectator-first fix end-to-end: P3 auto-spectates, watching banner
is visible, host returns to controllable menu (forced via test
override), promotion fires, P3 becomes a player with controls
enabled. No half-initialized slot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 7.4: Run the full test suite

- [ ] **Step 1: Run server-side tests**

```bash
uv run pytest tests/test_late_join_regime.py -v
```

Expected: All PASS.

- [ ] **Step 2: Run E2E**

```bash
uv run pytest tests/test_late_join_e2e.py -v
```

Expected: PASS.

- [ ] **Step 3: Run any neighboring tests that might regress**

```bash
uv run pytest tests/test_security.py tests/test_rom_declare.py -v
```

Expected: All PASS (these touch claim-slot and join-room paths).

- [ ] **Step 4: If anything fails, fix forward**

Per project convention (`feedback_no_circles.md`, `feedback_no_reverting.md`): diagnose root cause, do not revert. Add a follow-up commit with the fix.

### Task 7.5: Final commit / PR prep

- [ ] **Step 1: Verify the spec ↔ plan link**

```bash
grep -l "2026-04-26-late-join-regime" docs/superpowers/
```

Both files should appear. Spec at `specs/`, plan at `plans/`.

- [ ] **Step 2: Squash-merge or open a PR**

This depends on the project's release flow. The CLAUDE.md notes "PRs are squash-merged; PR title becomes the commit message." Conventional commit prefix: `feat:` (minor bump per auto-versioning).

PR title suggestion: `feat: spectator-first late-join for Smash Remix mid-match joiners`.

PR body: copy the spec's Problem section + a one-paragraph summary of the chunked rollout.

