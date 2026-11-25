"""Tests for Redis state persistence module.

Run: pytest tests/test_state.py -v
"""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest
import redis.asyncio as aioredis
from redis.exceptions import AuthenticationError, ConnectionError
from src import state
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
    room.input_types["sid-1"] = "gamepad"
    room.device_types["sid-1"] = "mobile"
    room.status = "playing"
    room.mode = "rollback"
    room.rom_hash = "abc123"
    room.rom_name = "Super Smash Bros.z64"
    room.rom_size = 16 * 1024 * 1024
    room.rom_sharing = True
    room.rom_changing = True

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
    assert restored.input_types["sid-1"] == "gamepad"
    assert restored.device_types["sid-1"] == "mobile"
    assert restored.status == "playing"
    assert restored.mode == "rollback"
    assert restored.rom_hash == "abc123"
    assert restored.rom_name == "Super Smash Bros.z64"
    assert restored.rom_size == 16 * 1024 * 1024
    assert restored.rom_sharing is True
    assert restored.rom_changing is True


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


def test_a_lockstep_room_is_restored_as_lockstep():
    """A room saved in lockstep mode comes back in lockstep mode. ("lockstep"
    was once the old name of rollback and was read as rollback; it is its own
    mode now, and rooms last hours, so none is left saved in the old sense.)
    """
    legacy_payload = {
        "owner": "sid-owner",
        "room_name": "Legacy Room",
        "game_id": "ssb64",
        "max_players": 4,
        "players": {},
        "slots": {},
        "spectators": {},
        "status": "lobby",
        "mode": "lockstep",
        "rom_ready": [],
        "rom_declared": [],
        "input_types": {},
        "device_types": {},
    }
    restored = _deserialize_room(legacy_payload)
    assert restored.mode == "lockstep"


def test_restore_retries_incomplete_scan_before_serving(monkeypatch):
    room = Room(owner="host", room_name="Survivor", game_id="ssb64", password=None, max_players=4)
    client = MagicMock()
    client.get = AsyncMock(side_effect=[_serialize_room(room), "{}", _serialize_room(room)])
    client.aclose = AsyncMock()
    attempts = 0

    async def scan(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            yield "kn:room:stale"
            raise ConnectionError("connection lost during scan")
        yield "kn:room:incomplete"
        yield "kn:room:healthy"

    client.scan_iter = scan
    monkeypatch.setenv("REDIS_URL", "redis://localhost")
    monkeypatch.setattr(aioredis, "from_url", lambda *a, **kw: client)
    monkeypatch.setattr(state, "_redis", None)
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())
    restored = asyncio.run(state.init())
    assert list(restored) == ["healthy"]
    assert restored["healthy"] == room
    assert state.enabled() and attempts == 2
    asyncio.run(state.close())
    client.aclose.assert_awaited_once()


@pytest.mark.parametrize(("error", "expected_attempts"), [(AuthenticationError, 1), (ConnectionError, 3)])
def test_failed_configured_restore_cannot_become_ephemeral(monkeypatch, error, expected_attempts):
    client = MagicMock()
    client.scan_iter.side_effect = error("storage unavailable")
    client.aclose = AsyncMock()
    monkeypatch.setenv("REDIS_URL", "redis://localhost")
    monkeypatch.setattr(aioredis, "from_url", lambda *a, **kw: client)
    monkeypatch.setattr(state, "_redis", None)
    monkeypatch.setattr(asyncio, "sleep", AsyncMock())
    with pytest.raises(error):
        asyncio.run(state.init())
    assert client.scan_iter.call_count == expected_attempts
    assert not state.enabled()
    assert not asyncio.run(state.ping())
    client.aclose.assert_awaited_once()
    monkeypatch.delenv("REDIS_URL")
    monkeypatch.delenv("REDIS_PASSWORD", raising=False)
    assert asyncio.run(state.init()) == {}
    assert asyncio.run(state.ping())


@pytest.mark.parametrize("failure", [None, "migration", "restore"])
def test_lifespan_restores_after_database_startup_and_closes_storage(monkeypatch, tmp_path, failure):
    from src import main, state_cache
    from src.blobstore import LocalBlobStore
    from src.dbbackend import BackendError
    from src.dbbackend.sqlite import SqliteBackend

    cache, store = AsyncMock(), AsyncMock()
    if failure == "restore":
        cache.ping.side_effect = AuthenticationError("cannot connect")
    monkeypatch.setenv("REDIS_URL", "redis://localhost")
    monkeypatch.setattr(aioredis, "from_url", lambda url, *, decode_responses: store if decode_responses else cache)
    monkeypatch.setattr(state_cache, "_redis", None)
    monkeypatch.setattr(state, "_redis", None)
    monkeypatch.setattr(main, "rooms", {})
    monkeypatch.setattr(main, "restore_member_reservations", AsyncMock())
    monkeypatch.setattr(main, "finish_room_shutdown", AsyncMock())

    records = {}
    backend = SqliteBackend(str(tmp_path / "test.db"))
    initialize = main.db.init_db
    if failure == "migration":
        monkeypatch.setattr(main.db, "apply_migrations", AsyncMock(side_effect=BackendError("cannot migrate")))

    async def open_database():
        await initialize(backend=backend, blobs=LocalBlobStore(tmp_path))
        # The serving process saves this lobby while its replacement starts.
        records["kn:room:NEW"] = _serialize_room(Room("host", "New lobby", "", None, 4))

    async def scan(pattern):
        if failure == "restore":
            raise AuthenticationError("cannot restore")
        for key in records:
            yield key

    monkeypatch.setattr(main.db, "init_db", open_database)
    store.scan_iter = scan
    store.get.side_effect = records.__getitem__

    async def check():
        if failure:
            with pytest.raises(BackendError if failure == "migration" else AuthenticationError):
                async with main.lifespan(None):
                    pytest.fail("served before room storage was restored")
        else:
            async with main.lifespan(None):
                visible = "NEW" in main.rooms
            assert visible
        assert bool(records) == (failure != "migration")
        assert backend._conn is None
        assert not state.enabled() and state_cache._redis is None
        cache.aclose.assert_awaited_once()
        if failure == "migration":
            store.aclose.assert_not_awaited()
        else:
            store.aclose.assert_awaited_once()

    asyncio.run(check())
