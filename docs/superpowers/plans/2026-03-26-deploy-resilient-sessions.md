# Deploy-Resilient Sessions Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make running games survive server deploys by persisting room state to Redis and handling player reconnection seamlessly.

**Architecture:** Redis stores serialized Room state. On startup, rooms are hydrated from Redis. When players reconnect after a deploy, the server recognizes them by a persistent client-generated UUID and restores their slot. Blue-green Swarm deploys ensure zero-gap container replacement.

**Tech Stack:** Python 3.11+, redis[hiredis], FastAPI, python-socketio, Docker Swarm

**Spec:** `docs/superpowers/specs/2026-03-26-deploy-resilient-sessions-design.md`

---

## Chunk 1: Redis State Module + Dependency

### Task 1: Add redis dependency

**Files:**
- Modify: `server/pyproject.toml:6-11`

- [ ] **Step 1: Add redis[hiredis] to dependencies**

In `server/pyproject.toml`, add `"redis[hiredis]>=5.0.0"` to the `dependencies` list:

```toml
dependencies = [
    "fastapi>=0.110.0",
    "uvicorn[standard]>=0.29.0",
    "python-socketio>=5.11.0",
    "python-dotenv>=1.0.0",
    "redis[hiredis]>=5.0.0",
]
```

- [ ] **Step 2: Install updated dependencies**

Run: `cd /Users/kazon/kaillera-next/server && pip install -e .`
Expected: Successfully installed redis and hiredis packages.

- [ ] **Step 3: Commit**

```bash
git add server/pyproject.toml
git commit -m "deps: add redis[hiredis] for session persistence"
```

---

### Task 2: Create state.py — Redis persistence module

**Files:**
- Create: `server/src/state.py`
- Reference: `server/src/api/signaling.py:80-108` (Room dataclass)

- [ ] **Step 1: Write the failing test for serialization round-trip**

Create `tests/test_state.py`:

```python
"""Tests for Redis state persistence module.

Run: pytest tests/test_state.py -v
"""

import asyncio
import json

from src.api.signaling import Room
from src.state import _deserialize_room, _serialize_room


def test_serialize_roundtrip_basic():
    """Room survives JSON round-trip with all field types preserved."""
    room = Room(
        owner="sid-owner",
        room_name="Test Room",
        game_id="ssb64",
        password=None,
        max_players=4,
    )
    room.players["pid-1"] = {"socketId": "sid-1", "playerName": "Alice"}
    room.slots[0] = "pid-1"
    room.rom_ready.add("sid-1")
    room.rom_declared.add("sid-1")
    room.input_types["sid-1"] = "gamepad"
    room.device_types["sid-1"] = "mobile"
    room.status = "playing"
    room.mode = "lockstep"
    room.rom_hash = "abc123"
    room.rom_sharing = True

    serialized = _serialize_room(room)
    parsed = json.loads(serialized)
    restored = _deserialize_room(parsed)

    assert restored.owner == "sid-owner"
    assert restored.room_name == "Test Room"
    assert restored.game_id == "ssb64"
    assert restored.password is None
    assert restored.max_players == 4
    assert restored.players["pid-1"]["socketId"] == "sid-1"
    assert restored.players["pid-1"]["playerName"] == "Alice"
    assert restored.slots[0] == "pid-1"  # int key preserved
    assert isinstance(restored.slots, dict)
    assert all(isinstance(k, int) for k in restored.slots)
    assert "sid-1" in restored.rom_ready
    assert isinstance(restored.rom_ready, set)
    assert "sid-1" in restored.rom_declared
    assert isinstance(restored.rom_declared, set)
    assert restored.input_types["sid-1"] == "gamepad"
    assert restored.device_types["sid-1"] == "mobile"
    assert restored.status == "playing"
    assert restored.mode == "lockstep"
    assert restored.rom_hash == "abc123"
    assert restored.rom_sharing is True


def test_serialize_roundtrip_empty_room():
    """Minimal room with defaults survives round-trip."""
    room = Room(
        owner="sid-x",
        room_name="Empty",
        game_id="unknown",
        password="secret",
        max_players=2,
    )

    serialized = _serialize_room(room)
    restored = _deserialize_room(json.loads(serialized))

    assert restored.owner == "sid-x"
    assert restored.password == "secret"
    assert restored.max_players == 2
    assert restored.players == {}
    assert restored.slots == {}
    assert restored.spectators == {}
    assert restored.rom_ready == set()
    assert restored.rom_declared == set()
    assert restored.status == "lobby"
    assert restored.mode is None


def test_serialize_roundtrip_with_spectators():
    """Room with both players and spectators round-trips correctly."""
    room = Room(
        owner="sid-host",
        room_name="Full Room",
        game_id="ssb64",
        password=None,
        max_players=2,
    )
    room.players["pid-1"] = {"socketId": "sid-1", "playerName": "P1"}
    room.players["pid-2"] = {"socketId": "sid-2", "playerName": "P2"}
    room.slots[0] = "pid-1"
    room.slots[1] = "pid-2"
    room.spectators["pid-3"] = {"socketId": "sid-3", "playerName": "Watcher"}

    serialized = _serialize_room(room)
    restored = _deserialize_room(json.loads(serialized))

    assert len(restored.players) == 2
    assert len(restored.spectators) == 1
    assert restored.spectators["pid-3"]["playerName"] == "Watcher"
    assert restored.slots[0] == "pid-1"
    assert restored.slots[1] == "pid-2"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/kazon/kaillera-next/server && python -m pytest ../tests/test_state.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'src.state'`

- [ ] **Step 3: Write state.py**

Create `server/src/state.py`:

```python
"""Redis-backed room state persistence.

Persists Room objects to Redis so they survive server restarts.
Operates as a write-through cache — in-memory `rooms` dict is primary,
Redis is the backing store. If REDIS_URL is not set, all operations
are silent no-ops (graceful degradation).

Keys: kn:room:{sessionId} — JSON-serialized Room dataclass
TTL: 12 hours (refreshed on each write)
"""

import json
import logging
import os
from dataclasses import asdict

from src.api.signaling import Room

log = logging.getLogger(__name__)

_KEY_PREFIX = "kn:room:"
_TTL_SECONDS = 12 * 60 * 60  # 12 hours

_redis = None  # redis.asyncio.Redis instance or None


def _serialize_room(room: Room) -> str:
    """Convert Room dataclass to JSON string."""
    d = asdict(room)
    # Sets are not JSON-serializable — convert to lists
    d["rom_ready"] = list(d["rom_ready"])
    d["rom_declared"] = list(d["rom_declared"])
    # Slot keys must be strings in JSON; we convert back on load
    d["slots"] = {str(k): v for k, v in d["slots"].items()}
    return json.dumps(d)


def _deserialize_room(d: dict) -> Room:
    """Reconstruct Room from a parsed JSON dict."""
    return Room(
        owner=d["owner"],
        room_name=d["room_name"],
        game_id=d["game_id"],
        password=d.get("password"),
        max_players=d["max_players"],
        players=d.get("players", {}),
        slots={int(k): v for k, v in d.get("slots", {}).items()},
        spectators=d.get("spectators", {}),
        status=d.get("status", "lobby"),
        mode=d.get("mode"),
        rom_hash=d.get("rom_hash"),
        rom_sharing=d.get("rom_sharing", False),
        rom_ready=set(d.get("rom_ready", [])),
        rom_declared=set(d.get("rom_declared", [])),
        input_types=d.get("input_types", {}),
        device_types=d.get("device_types", {}),
    )


async def init() -> None:
    """Connect to Redis if REDIS_URL is configured."""
    global _redis
    url = os.environ.get("REDIS_URL", "")
    if not url:
        log.warning("REDIS_URL not configured — rooms will not survive restarts")
        return
    try:
        import redis.asyncio as aioredis

        _redis = aioredis.from_url(url, decode_responses=True)
        await _redis.ping()
        log.info("Connected to Redis at %s", url.split("@")[-1])  # hide credentials
    except Exception:
        log.exception("Failed to connect to Redis — falling back to in-memory only")
        _redis = None


async def close() -> None:
    """Close the Redis connection."""
    global _redis
    if _redis:
        await _redis.aclose()
        _redis = None


async def save_room(session_id: str, room: Room) -> None:
    """Persist room to Redis with 12h TTL. No-op if Redis is unavailable."""
    if not _redis:
        return
    try:
        data = _serialize_room(room)
        await _redis.set(f"{_KEY_PREFIX}{session_id}", data, ex=_TTL_SECONDS)
    except Exception:
        log.exception("Failed to save room %s to Redis", session_id)


async def delete_room(session_id: str) -> None:
    """Remove room from Redis. No-op if Redis is unavailable."""
    if not _redis:
        return
    try:
        await _redis.delete(f"{_KEY_PREFIX}{session_id}")
    except Exception:
        log.exception("Failed to delete room %s from Redis", session_id)


async def load_all_rooms() -> dict[str, Room]:
    """Load all rooms from Redis. Returns empty dict if Redis is unavailable."""
    if not _redis:
        return {}
    try:
        result = {}
        async for key in _redis.scan_iter(f"{_KEY_PREFIX}*"):
            session_id = key[len(_KEY_PREFIX):]
            raw = await _redis.get(key)
            if raw:
                result[session_id] = _deserialize_room(json.loads(raw))
        log.info("Hydrated %d room(s) from Redis", len(result))
        return result
    except Exception:
        log.exception("Failed to load rooms from Redis")
        return {}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/kazon/kaillera-next/server && python -m pytest ../tests/test_state.py -v`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/state.py tests/test_state.py
git commit -m "feat: add Redis state persistence module with serialization"
```

---

## Chunk 2: Server Integration — Hydration, Shutdown Guard, Persist-on-Write

### Task 3: Startup hydration + graceful shutdown + disconnect guard

**Files:**
- Modify: `server/src/main.py:24-48`
- Modify: `server/src/api/signaling.py:720-724`

**Critical:** When the server shuts down, Socket.IO fires `disconnect` for every connected client, which calls `_leave(sid)`. After Task 4 adds persist-on-write, `_leave` would save depleted rooms to Redis (or delete them as empty) — destroying the state that should survive the restart. The `disconnect` handler must skip `_leave` during shutdown.

- [ ] **Step 1: Add shutdown guard flag to signaling.py**

At the top of `server/src/api/signaling.py`, after line 114 (`_sid_to_room` dict), add:

```python
_shutting_down = False
```

And add a setter function after the `configure_cors` function (after line 65):

```python
def set_shutting_down() -> None:
    global _shutting_down
    _shutting_down = True
```

- [ ] **Step 2: Guard the `disconnect` handler**

Replace the `disconnect` handler (lines 720-724) with:

```python
@sio.event
async def disconnect(sid: str) -> None:
    log.info("SIO disconnect %s", sid)
    unregister_sid(sid)
    if not _shutting_down:
        await _leave(sid)
```

- [ ] **Step 3: Update lifespan to init/close Redis, hydrate rooms, and set shutdown flag**

In `server/src/main.py`, add the imports (after existing imports at line 24):
```python
from src import state
from src.api.signaling import set_shutting_down
```

Replace the lifespan function (lines 33-48) with:
```python
@asynccontextmanager
async def lifespan(_app):
    await state.init()
    restored = await state.load_all_rooms()
    if restored:
        rooms.update(restored)
        log.info("Restored %d room(s) from Redis", len(restored))
    task = asyncio.create_task(_cleanup_empty_rooms())
    log_task = asyncio.create_task(cleanup_old_logs())
    yield
    set_shutting_down()
    task.cancel()
    log_task.cancel()
    if rooms:
        log.info("Shutting down gracefully, %d room(s) preserved in Redis", len(rooms))
    await state.close()
```

- [ ] **Step 4: Verify server starts and shuts down cleanly**

Run: `cd /Users/kazon/kaillera-next/server && timeout 5 python -c "from src.main import run; run()" 2>&1 || true`
Expected: Server starts, logs "REDIS_URL not configured" warning, runs briefly, exits. No crash.

- [ ] **Step 5: Commit**

```bash
git add server/src/main.py server/src/api/signaling.py
git commit -m "feat: hydrate rooms from Redis on startup, shutdown guard prevents disconnect cascade"
```

---

### Task 4: Add persist-on-write calls to signaling.py

**Files:**
- Modify: `server/src/api/signaling.py`

This task adds `await state.save_room()` or `await state.delete_room()` after every room mutation. No logic changes — just persistence calls.

- [ ] **Step 1: Add state import**

At the top of `server/src/api/signaling.py`, after line 48 (`from src.ratelimit import ...`), add:
```python
from src import state
```

- [ ] **Step 2: Add persist calls to `_leave`**

In the `_leave` function, add persistence at two points:

After `del rooms[session_id]` on line 188 (empty room deletion), add:
```python
        await state.delete_room(session_id)
```

After `del rooms[session_id]` on line 200 (host left mid-game), add:
```python
        await state.delete_room(session_id)
```

Before the final `await sio.emit("users-updated", ...)` on line 224, add:
```python
    await state.save_room(session_id, room)
```

- [ ] **Step 3: Add persist calls to `open_room`**

After `rooms[session_id] = room` on line 296, add:
```python
    await state.save_room(session_id, room)
```

- [ ] **Step 4: Add persist calls to `join_room`**

After `await sio.emit("users-updated", ...)` on line 345, add:
```python
    await state.save_room(session_id, room)
```

- [ ] **Step 5: Add persist calls to `claim_slot`**

After `await sio.emit("users-updated", ...)` on line 389, add:
```python
    await state.save_room(session_id, room)
```

- [ ] **Step 6: Add persist calls to `start_game`**

After `await sio.emit("game-started", ...)` (line 451-459), add:
```python
    await state.save_room(session_id, room)
```

- [ ] **Step 7: Add persist calls to `end_game`**

After the second `await sio.emit(...)` on line 480, add:
```python
    await state.save_room(session_id, room)
```

- [ ] **Step 8: Add persist calls to `set_mode`**

After `await sio.emit("users-updated", ...)` on line 503, add:
```python
    await state.save_room(session_id, room)
```

- [ ] **Step 9: Add persist calls to `rom_sharing_toggle`**

After `await sio.emit("rom-sharing-updated", ...)` on line 521, add:
```python
    await state.save_room(session_id, room)
```

- [ ] **Step 10: Add persist calls to `rom_ready`**

After `await sio.emit("users-updated", ...)` on line 540, add:
```python
    await state.save_room(session_id, room)
```

- [ ] **Step 11: Add persist calls to `rom_declare`**

After `await sio.emit("users-updated", ...)` on line 559, add:
```python
    await state.save_room(session_id, room)
```

- [ ] **Step 12: Add delete call to `_cleanup_empty_rooms`**

In `_cleanup_empty_rooms`, after `del rooms[sid]` on line 247, add:
```python
            await state.delete_room(sid)
```

- [ ] **Step 13: Verify lint passes**

Run: `cd /Users/kazon/kaillera-next && ruff check server/src/api/signaling.py`
Expected: No errors.

- [ ] **Step 14: Commit**

```bash
git add server/src/api/signaling.py
git commit -m "feat: persist room state to Redis on every mutation"
```

---

## Chunk 3: Persistent Client ID + Reconnect-Aware Handlers

### Task 5: Add `_swap_sid` helper and persistent ID support to signaling.py

**Files:**
- Modify: `server/src/api/signaling.py`

- [ ] **Step 1: Add `_swap_sid` helper function**

After the `_get_room` function (after line 152), add:

```python
def _swap_sid(room: Room, persistent_id: str, old_sid: str, new_sid: str) -> None:
    """Update all SID-keyed fields when a player reconnects with a new socket."""
    if room.owner == old_sid:
        room.owner = new_sid
    # Update socketId in player/spectator entry
    if persistent_id in room.players:
        room.players[persistent_id]["socketId"] = new_sid
    if persistent_id in room.spectators:
        room.spectators[persistent_id]["socketId"] = new_sid
    # Update SID-keyed sets
    if old_sid in room.rom_ready:
        room.rom_ready.discard(old_sid)
        room.rom_ready.add(new_sid)
    if old_sid in room.rom_declared:
        room.rom_declared.discard(old_sid)
        room.rom_declared.add(new_sid)
    # Update SID-keyed dicts
    if old_sid in room.input_types:
        room.input_types[new_sid] = room.input_types.pop(old_sid)
    if old_sid in room.device_types:
        room.device_types[new_sid] = room.device_types.pop(old_sid)
```

- [ ] **Step 2: Make `open_room` reconnect-aware with persistent ID**

Replace the `open_room` handler (lines 255-302) with:

```python
@sio.on("open-room")
async def open_room(sid: str, data: dict) -> str | None:
    if not isinstance(data, dict):
        return "Invalid data"
    if not check(sid, "open-room"):
        return "Rate limited"

    extra = data.get("extra", {})
    session_id: str = extra.get("sessionid", "")
    persistent_id: str = extra.get("persistentId", "") or sid
    player_name: str = extra.get("player_name", "Player")
    room_name: str = extra.get("room_name", "Room")
    game_id: str = extra.get("game_id", "")
    password: str | None = data.get("password") or extra.get("room_password") or None
    max_players: int = int(data.get("maxPlayers", 4))

    if not session_id:
        return "Missing sessionid"
    if not _ALNUM_RE.match(session_id) or not (3 <= len(session_id) <= 16):
        return "Invalid room code"

    # Reconnect detection — BEFORE _leave
    existing = rooms.get(session_id)
    if existing and persistent_id in existing.players:
        old_sid = existing.players[persistent_id]["socketId"]
        _swap_sid(existing, persistent_id, old_sid, sid)
        _sid_to_room.pop(old_sid, None)
        _sid_to_room[sid] = (session_id, persistent_id, False)
        await sio.enter_room(sid, session_id)
        await sio.emit("users-updated", _players_payload(existing), room=session_id)
        await state.save_room(session_id, existing)
        log.info("SIO %s reconnected to room %s (host, persistentId=%s)", sid, session_id, persistent_id)
        return None

    if session_id in rooms:
        return "Room already exists"

    await _leave(sid)  # clean up if already in another room

    if len(rooms) >= MAX_ROOMS:
        return "Server is full"

    player_name = _sanitize_str(player_name, 32)
    room_name = _sanitize_str(room_name, 64)
    if not _ALNUM_HYPHEN_RE.match(game_id) or len(game_id) > 32:
        game_id = "unknown"
    max_players = max(1, min(4, max_players))

    room = Room(
        owner=sid,
        room_name=room_name,
        game_id=game_id,
        password=password,
        max_players=max_players,
    )
    room.players[persistent_id] = {"socketId": sid, "playerName": player_name}
    room.slots[0] = persistent_id
    rooms[session_id] = room
    _sid_to_room[sid] = (session_id, persistent_id, False)

    await sio.enter_room(sid, session_id)
    await sio.emit("users-updated", _players_payload(room), room=session_id)
    await state.save_room(session_id, room)
    log.info("SIO %s opened room %s (game=%s, persistentId=%s)", sid, session_id, game_id, persistent_id)
    return None  # success
```

- [ ] **Step 3: Make `join_room` reconnect-aware with persistent ID**

Replace the `join_room` handler (lines 305-347) with:

```python
@sio.on("join-room")
async def join_room(sid: str, data: dict) -> tuple[str | None, dict | None]:
    if not isinstance(data, dict):
        return ("Invalid data", None)
    if not check(sid, "join-room"):
        return ("Rate limited", None)

    extra = data.get("extra", {})
    session_id: str = extra.get("sessionid", "")
    persistent_id: str = extra.get("persistentId", "") or sid
    player_name: str = extra.get("player_name", "Player")
    password: str | None = data.get("password") or None
    spectate: bool = extra.get("spectate", False)

    player_name = _sanitize_str(player_name, 32)

    if not session_id or not _ALNUM_RE.match(session_id) or not (3 <= len(session_id) <= 16):
        return ("Invalid room code", None)

    room = rooms.get(session_id)
    if room is None:
        return ("Room not found", None)

    # Reconnect detection — BEFORE _leave
    is_returning_player = persistent_id in room.players
    is_returning_spectator = persistent_id in room.spectators
    if is_returning_player or is_returning_spectator:
        entry = room.players.get(persistent_id) or room.spectators.get(persistent_id)
        old_sid = entry["socketId"]
        _swap_sid(room, persistent_id, old_sid, sid)
        _sid_to_room.pop(old_sid, None)
        _sid_to_room[sid] = (session_id, persistent_id, is_returning_spectator)
        await sio.enter_room(sid, session_id)
        await sio.emit("users-updated", _players_payload(room), room=session_id)
        await state.save_room(session_id, room)
        log.info("SIO %s reconnected to room %s (persistentId=%s)", sid, session_id, persistent_id)
        return (None, _players_payload(room))

    await _leave(sid)  # clean up if already in another room

    if room.password and not hmac.compare_digest(room.password, password or ""):
        return ("Wrong password", None)

    if spectate:
        if len(room.spectators) >= MAX_SPECTATORS:
            return ("Room spectator limit reached", None)
        room.spectators[persistent_id] = {"socketId": sid, "playerName": player_name}
        _sid_to_room[sid] = (session_id, persistent_id, True)
    else:
        slot = room.next_slot()
        if slot is None:
            return ("Room is full", None)
        room.players[persistent_id] = {"socketId": sid, "playerName": player_name}
        room.slots[slot] = persistent_id
        _sid_to_room[sid] = (session_id, persistent_id, False)

    await sio.enter_room(sid, session_id)
    await sio.emit("users-updated", _players_payload(room), room=session_id)
    await state.save_room(session_id, room)
    log.info("SIO %s %s room %s (persistentId=%s)", sid, "spectating" if spectate else "joined", session_id, persistent_id)
    return (None, _players_payload(room))
```

- [ ] **Step 4: Verify lint passes**

Run: `cd /Users/kazon/kaillera-next && ruff check server/src/api/signaling.py`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/api/signaling.py
git commit -m "feat: persistent client ID + reconnect-aware open/join handlers"
```

---

### Task 6: Enhance zombie room cleanup

**Files:**
- Modify: `server/src/api/signaling.py` (the `_cleanup_empty_rooms` function)

- [ ] **Step 1: Add zombie detection to cleanup**

Replace the `_cleanup_empty_rooms` function with:

```python
async def _cleanup_empty_rooms() -> None:
    """Periodically remove empty rooms and zombie rooms (no live sockets)."""
    _zombie_ages: dict[str, int] = {}  # session_id -> consecutive zombie ticks
    while True:
        await asyncio.sleep(60)
        to_delete = []
        for session_id, r in list(rooms.items()):
            if not r.players and not r.spectators:
                to_delete.append(session_id)
                continue
            # Zombie check: room has entries but no live sockets
            has_live = False
            for info in list(r.players.values()) + list(r.spectators.values()):
                if info["socketId"] in _sid_to_room:
                    has_live = True
                    break
            if not has_live:
                _zombie_ages[session_id] = _zombie_ages.get(session_id, 0) + 1
                if _zombie_ages[session_id] >= 5:  # 5 minutes grace period
                    to_delete.append(session_id)
            else:
                _zombie_ages.pop(session_id, None)
        for session_id in to_delete:
            del rooms[session_id]
            _zombie_ages.pop(session_id, None)
            await state.delete_room(session_id)
            log.info("Cleanup: deleted room %s", session_id)
        cleanup()
```

- [ ] **Step 2: Verify lint passes**

Run: `cd /Users/kazon/kaillera-next && ruff check server/src/api/signaling.py`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/api/signaling.py
git commit -m "feat: zombie room cleanup — delete rooms with no live sockets after 5min"
```

---

## Chunk 4: Client-Side Changes

### Task 7: Add persistent ID to play.js

**Files:**
- Modify: `web/static/play.js:7-70` (state section + URL params)

- [ ] **Step 1: Add persistent ID generation**

After `let _autoSpectated = false;` (line 56), add:

```javascript
  const _persistentId = sessionStorage.getItem('kn-player-id') || crypto.randomUUID();
  sessionStorage.setItem('kn-player-id', _persistentId);
```

- [ ] **Step 2: Add `persistentId` to `open-room` payload**

In the `onConnect` function, in the `open-room` emit (around line 214-224), add `persistentId: _persistentId` to the `extra` object:

```javascript
        extra: {
            sessionid: roomCode,
            playerId: socket.id,
            player_name: playerName,
            room_name: `${playerName}'s room`,
            game_id: 'ssb64',
            persistentId: _persistentId,
        },
```

- [ ] **Step 3: Add `persistentId` to `join-room` payload in `onConnect`**

In the non-host `join-room` emit (around line 254-262), add `persistentId: _persistentId` to the `extra` object:

```javascript
            extra: {
              sessionid: roomCode,
              userid: socket.id,
              player_name: playerName,
              spectate: isSpectator,
              persistentId: _persistentId,
            },
```

- [ ] **Step 4: Add `persistentId` to `join-room` in the auto-spectate retry**

In the "Room is full" auto-spectate retry emit (around line 270-278), add `persistentId: _persistentId` to the `extra` object:

```javascript
                    extra: {
                      sessionid: roomCode,
                      userid: socket.id,
                      player_name: playerName,
                      spectate: true,
                      persistentId: _persistentId,
                    },
```

- [ ] **Step 5: Add `persistentId` to `reconnect` handler's `join-room` payload**

In the `reconnect` event handler (around line 154-161), add `persistentId: _persistentId` to the `extra` object:

```javascript
          extra: {
            sessionid: roomCode,
            userid: socket.id,
            player_name: playerName,
            spectate: isSpectator,
            persistentId: _persistentId,
          },
```

- [ ] **Step 6: Update reconnect handler — host should emit `open-room` not `join-room`**

Replace the `reconnect` event handler (lines 150-185) with:

```javascript
    socket.on('reconnect', (attempt) => {
      console.log('[play] socket reconnected after', attempt, 'attempts, new id:', socket.id);
      const rejoinEvent = isHost ? 'open-room' : 'join-room';
      const payload = isHost
        ? {
            extra: {
              sessionid: roomCode,
              player_name: playerName,
              room_name: `${playerName}'s room`,
              game_id: 'ssb64',
              persistentId: _persistentId,
            },
            maxPlayers: 4,
          }
        : {
            extra: {
              sessionid: roomCode,
              userid: socket.id,
              player_name: playerName,
              spectate: isSpectator,
              persistentId: _persistentId,
            },
          };
      socket.emit(rejoinEvent, payload, (err, joinData) => {
        // open-room callback has 1 arg (err), join-room has 2 (err, data)
        const data = isHost ? undefined : joinData;
        if (err) {
          console.log('[play] rejoin failed:', err);
          if (!gameRunning) {
            showToast('Room is no longer available');
            setTimeout(() => { window.location.href = '/'; }, 2000);
          }
          return;
        }
        console.log('[play] rejoined room after reconnect');
        if (data?.players) {
          for (const entry of Object.values(data.players)) {
            if (entry.socketId === socket.id) {
              mySlot = entry.slot;
              break;
            }
          }
        }
        sendDeviceType();
      });
    });
```

- [ ] **Step 7: Commit**

```bash
git add web/static/play.js
git commit -m "feat: persistent client ID in play.js for deploy-resilient reconnect"
```

---

### Task 8: Silent reconnection — remove scary messages

**Files:**
- Modify: `web/static/play.js:146-194`

- [ ] **Step 1: Make disconnect handler silent during games**

Replace the `disconnect` handler (lines 146-149) with:

```javascript
    socket.on('disconnect', (reason) => {
      console.log('[play] socket disconnected:', reason, 'id was:', socket.id);
      // During games: silent — Socket.IO reconnects automatically
      // During lobby: show subtle message only after a delay
      if (!gameRunning) {
        setTimeout(() => {
          if (!socket.connected) showToast('Reconnecting to server...');
        }, 5000);
      }
    });
```

- [ ] **Step 2: Make connect_error silent during games**

Replace the `connect_error` handler (lines 186-195) with:

```javascript
    socket.on('connect_error', (e) => {
      console.log('[play] connect_error:', e.message);
      // During games: silent — Socket.IO keeps retrying
      // During lobby: show error only if not yet connected
      if (!gameRunning && !socket.connected) {
        showError(`Connection error: ${e.message}`);
      }
    });
```

- [ ] **Step 3: Commit**

```bash
git add web/static/play.js
git commit -m "feat: silent reconnection during games — no scary toasts"
```

---

## Chunk 5: Docker Configuration

### Task 9: Update Dockerfile and Docker Compose

**Files:**
- Modify: `Dockerfile:27-32`
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Add REDIS_URL env var to Dockerfile**

In `Dockerfile`, add `REDIS_URL=""` to the ENV block (line 27-32):

```dockerfile
ENV ALLOWED_ORIGIN="" \
    PORT=27888 \
    MAX_ROOMS=100 \
    MAX_SPECTATORS=20 \
    ADMIN_KEY="" \
    LOG_RETENTION_DAYS=14 \
    REDIS_URL=""
```

- [ ] **Step 2: Add Redis service and REDIS_URL to docker-compose.prod.yml**

Replace `docker-compose.prod.yml` with:

```yaml
version: "3.8"

services:
  redis:
    image: redis:7-alpine
    restart: always
    volumes:
      - redis-data:/data
    command: redis-server --save 60 1 --loglevel warning
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3

  kaillera-next:
    image: ghcr.io/kwilson21/kaillera-next:latest
    environment:
      - ALLOWED_ORIGIN=${ALLOWED_ORIGIN}
      - ICE_SERVERS=${ICE_SERVERS}
      - PORT=${PORT}
      - MAX_ROOMS=${MAX_ROOMS}
      - MAX_SPECTATORS=${MAX_SPECTATORS}
      - LOG_RETENTION_DAYS=${LOG_RETENTION_DAYS}
      - LOG_MAX_FILES=${LOG_MAX_FILES}
      - SYNC_LOG_DIR=${SYNC_LOG_DIR}
      - ADMIN_KEY=${ADMIN_KEY}
      - DEBUG_MODE=${DEBUG_MODE}
      - REDIS_URL=redis://redis:6379/0
    ports:
      - "27888:27888"
    volumes:
      - kaillera-logs:/app/server/logs
    depends_on:
      redis:
        condition: service_healthy
    deploy:
      replicas: 1
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 3
      update_config:
        parallelism: 1
        delay: 10s
        order: start-first
    stop_grace_period: 30s
    healthcheck:
      test: ["CMD", "python", "-c", "import os,urllib.request;urllib.request.urlopen('http://localhost:'+os.environ.get('PORT','27888')+'/health')"]
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3

volumes:
  kaillera-logs:
  redis-data:
```

- [ ] **Step 3: Commit**

```bash
git add Dockerfile docker-compose.prod.yml
git commit -m "infra: add Redis service + REDIS_URL + stop_grace_period for deploy resilience"
```

---

## Chunk 6: Integration Verification

### Task 10: Manual integration test

This task is manual — verify the full flow works end-to-end.

- [ ] **Step 1: Start Redis locally**

Run: `docker run -d --name kn-redis -p 6379:6379 redis:7-alpine`

- [ ] **Step 2: Start server with REDIS_URL**

Run: `cd /Users/kazon/kaillera-next/server && REDIS_URL=redis://localhost:6379/0 python -c "from src.main import run; run()"`
Expected: Logs show "Connected to Redis at localhost:6379/0" and "Hydrated 0 room(s) from Redis".

- [ ] **Step 3: Open browser, create a room**

Open `http://localhost:27888`, create a room with a name.
Expected: Room created, you're in the lobby.

- [ ] **Step 4: Verify room persisted in Redis**

In another terminal, run: `docker exec kn-redis redis-cli keys 'kn:room:*'`
Expected: Shows one key matching your room code.

- [ ] **Step 5: Kill the server (Ctrl+C) and restart it**

Expected on restart: Logs show "Hydrated 1 room(s) from Redis" and "Restored 1 room(s) from Redis".

- [ ] **Step 6: Verify browser auto-reconnects**

Expected: Browser reconnects, rejoins room. No scary error messages. Room state is intact.

- [ ] **Step 7: Clean up**

Run: `docker stop kn-redis && docker rm kn-redis`

- [ ] **Step 8: Run existing tests to verify no regressions**

Run: `cd /Users/kazon/kaillera-next/server && python -m pytest ../tests/test_state.py ../tests/test_server_rest.py -v`
Expected: All tests pass.

- [ ] **Step 9: Final commit**

If any fixups were needed during verification, commit them:
```bash
git add -A
git commit -m "fix: integration test fixups for deploy-resilient sessions"
```
