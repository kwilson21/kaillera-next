"""Tests for Redis state persistence module.

Run: pytest tests/test_state.py -v
"""

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
