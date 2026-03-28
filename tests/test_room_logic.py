"""Unit tests for Room model and helper functions.

Run: cd server && uv run pytest ../tests/test_room_logic.py -v
"""

import pytest

from src.api.signaling import Room, _get_room, _players_payload, _swap_sid, rooms, _sid_to_room


@pytest.fixture(autouse=True)
def clean_state():
    """Reset global room state between tests."""
    rooms.clear()
    _sid_to_room.clear()
    yield
    rooms.clear()
    _sid_to_room.clear()


def _make_room(**overrides) -> Room:
    defaults = dict(owner="sid-host", room_name="Test", game_id="ssb64", password=None, max_players=4)
    defaults.update(overrides)
    return Room(**defaults)


# ── Room.next_slot ────────────────────────────────────────────────────────────


class TestNextSlot:
    def test_empty_room_returns_zero(self):
        room = _make_room()
        assert room.next_slot() == 0

    def test_one_player_returns_next(self):
        room = _make_room()
        room.slots[0] = "pid-1"
        assert room.next_slot() == 1

    def test_gap_returns_lowest(self):
        room = _make_room()
        room.slots[0] = "pid-1"
        room.slots[2] = "pid-3"
        assert room.next_slot() == 1

    def test_full_returns_none(self):
        room = _make_room(max_players=2)
        room.slots[0] = "pid-1"
        room.slots[1] = "pid-2"
        assert room.next_slot() is None


# ── _players_payload ──────────────────────────────────────────────────────────


class TestPlayersPayload:
    def test_basic_payload(self):
        room = _make_room()
        room.players["pid-1"] = {"socketId": "sid-1", "playerName": "Alice"}
        room.slots[0] = "pid-1"
        room.rom_ready.add("sid-1")

        payload = _players_payload(room)

        assert payload["owner"] == "sid-host"
        assert payload["status"] == "lobby"
        assert "pid-1" in payload["players"]
        p1 = payload["players"]["pid-1"]
        assert p1["slot"] == 0
        assert p1["romReady"] is True
        assert p1["romDeclared"] is False
        assert p1["inputType"] == "keyboard"
        assert p1["deviceType"] == "desktop"

    def test_spectators_included(self):
        room = _make_room()
        room.spectators["spec-1"] = {"socketId": "sid-spec", "playerName": "Bob"}

        payload = _players_payload(room)

        assert "spec-1" in payload["spectators"]

    def test_rom_sharing_and_mode(self):
        room = _make_room()
        room.rom_sharing = True
        room.mode = "streaming"

        payload = _players_payload(room)

        assert payload["romSharing"] is True
        assert payload["mode"] == "streaming"


# ── _get_room ─────────────────────────────────────────────────────────────────


class TestGetRoom:
    def test_returns_none_for_unknown_sid(self):
        assert _get_room("unknown") is None

    def test_returns_room_for_known_sid(self):
        room = _make_room()
        rooms["ROOM1"] = room
        _sid_to_room["sid-1"] = ("ROOM1", "pid-1", False)

        result = _get_room("sid-1")

        assert result is not None
        assert result[0] == "ROOM1"
        assert result[1] is room

    def test_returns_none_if_room_deleted(self):
        _sid_to_room["sid-1"] = ("GONE", "pid-1", False)

        assert _get_room("sid-1") is None


# ── _swap_sid ─────────────────────────────────────────────────────────────────


class TestSwapSid:
    def test_swaps_owner(self):
        room = _make_room(owner="old-sid")
        _swap_sid(room, "pid-1", "old-sid", "new-sid")
        assert room.owner == "new-sid"

    def test_swaps_player_socket_id(self):
        room = _make_room()
        room.players["pid-1"] = {"socketId": "old-sid", "playerName": "Alice"}
        _swap_sid(room, "pid-1", "old-sid", "new-sid")
        assert room.players["pid-1"]["socketId"] == "new-sid"

    def test_swaps_spectator_socket_id(self):
        room = _make_room()
        room.spectators["pid-1"] = {"socketId": "old-sid", "playerName": "Bob"}
        _swap_sid(room, "pid-1", "old-sid", "new-sid")
        assert room.spectators["pid-1"]["socketId"] == "new-sid"

    def test_swaps_rom_ready(self):
        room = _make_room()
        room.rom_ready.add("old-sid")
        _swap_sid(room, "pid-1", "old-sid", "new-sid")
        assert "new-sid" in room.rom_ready
        assert "old-sid" not in room.rom_ready

    def test_swaps_rom_declared(self):
        room = _make_room()
        room.rom_declared.add("old-sid")
        _swap_sid(room, "pid-1", "old-sid", "new-sid")
        assert "new-sid" in room.rom_declared
        assert "old-sid" not in room.rom_declared

    def test_swaps_input_and_device_types(self):
        room = _make_room()
        room.input_types["old-sid"] = "gamepad"
        room.device_types["old-sid"] = "mobile"
        _swap_sid(room, "pid-1", "old-sid", "new-sid")
        assert room.input_types.get("new-sid") == "gamepad"
        assert room.device_types.get("new-sid") == "mobile"
        assert "old-sid" not in room.input_types
        assert "old-sid" not in room.device_types

    def test_noop_when_sid_not_present(self):
        room = _make_room(owner="other-sid")
        room.players["pid-1"] = {"socketId": "other-sid", "playerName": "X"}
        _swap_sid(room, "pid-2", "nonexistent", "new-sid")
        assert room.owner == "other-sid"
        assert room.players["pid-1"]["socketId"] == "other-sid"
