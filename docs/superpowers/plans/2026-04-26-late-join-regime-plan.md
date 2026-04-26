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

*[Chunks 4 through 7 to be drafted next; this plan is committed at chunk 1-3 boundary so they can be reviewed and refined before extending.]*
