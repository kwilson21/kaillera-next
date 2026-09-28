"""Unit tests for Room model and helper functions.

Run: cd server && uv run pytest ../tests/test_room_logic.py -v
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, patch

import pytest

from src.api import signaling
from src.api.signaling import (
    Room,
    _get_room,
    _leave,
    _players_payload,
    _sid_to_room,
    _swap_sid,
    rooms,
)


def _run_async(coro):
    """Run a coroutine in a worker thread.

    pytest-playwright's autouse fixture (conftest.py) holds the main thread's
    event loop, so asyncio.run() collides. Off-thread asyncio.run is loop-clean.
    """
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(coro)).result()


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
        assert p1["inputType"] == "keyboard"
        assert p1["deviceType"] == "desktop"

    def test_spectators_included(self):
        room = _make_room()
        room.spectators["spec-1"] = {"socketId": "sid-spec", "playerName": "Bob"}

        payload = _players_payload(room)

        assert "spec-1" in payload["spectators"]

    def test_rom_sharing_and_mode(self):
        room = _make_room(game_id="smash-remix")
        room.rom_sharing = True
        room.mode = "streaming"
        room.rom_hash = "S" + "a" * 64
        room.rom_name = "Smash Remix.z64"
        room.rom_size = 67108864

        payload = _players_payload(room)

        assert payload["romSharing"] is True
        assert payload["mode"] == "streaming"
        assert payload["gameId"] == "smash-remix"
        assert payload["game_id"] == "smash-remix"
        assert payload["romHash"] == "S" + "a" * 64
        assert payload["romName"] == "Smash Remix.z64"
        assert payload["romSize"] == 67108864
        assert payload["hostRom"]["name"] == "Smash Remix.z64"
        assert payload["hostRom"]["gameId"] == "smash-remix"


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


# ── _leave ────────────────────────────────────────────────────────────────────


class TestLeave:
    """_leave() handles spectator vs player removal, ownership transfer, and
    empty-room cleanup. Regression coverage for the rm_slot UnboundLocalError
    that previously fired on every spectator disconnect.
    """

    def _run(self, coro):
        """Patch sio + db + state so _leave() can run without real I/O."""
        with (
            patch.object(signaling.sio, "leave_room", new=AsyncMock()),
            patch.object(signaling.sio, "emit", new=AsyncMock()),
            patch.object(signaling.db, "insert_client_event", new=AsyncMock()),
            patch.object(signaling.db, "set_session_ended", new=AsyncMock()),
            patch.object(signaling.state, "save_room", new=AsyncMock()),
            patch.object(signaling.state, "delete_room", new=AsyncMock()),
        ):
            return _run_async(coro)

    def test_spectator_leave_does_not_raise(self):
        """Regression: rm_slot was undefined on the spectator branch."""
        room = _make_room()
        room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
        room.slots[0] = "pid-host"
        room.spectators["pid-spec"] = {"socketId": "sid-spec", "playerName": "Spec"}
        rooms["ROOM1"] = room
        _sid_to_room["sid-spec"] = ("ROOM1", "pid-spec", True)

        self._run(_leave("sid-spec", "disconnect"))

        assert "pid-spec" not in room.spectators
        assert "ROOM1" in rooms  # host still present, room stays

    def test_player_leave_clears_slot(self):
        room = _make_room()
        room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
        room.slots[0] = "pid-host"
        room.players["pid-2"] = {"socketId": "sid-2", "playerName": "P2"}
        room.slots[1] = "pid-2"
        rooms["ROOM2"] = room
        _sid_to_room["sid-2"] = ("ROOM2", "pid-2", False)

        self._run(_leave("sid-2", "disconnect"))

        assert "pid-2" not in room.players
        assert 1 not in room.slots
        assert room.slots[0] == "pid-host"

    def test_empty_room_is_deleted(self):
        room = _make_room(owner="sid-only")
        room.players["pid-only"] = {"socketId": "sid-only", "playerName": "Solo"}
        room.slots[0] = "pid-only"
        rooms["ROOM3"] = room
        _sid_to_room["sid-only"] = ("ROOM3", "pid-only", False)

        self._run(_leave("sid-only", "disconnect"))

        assert "ROOM3" not in rooms

    def test_owner_leave_transfers_ownership(self):
        room = _make_room(owner="sid-host")
        room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
        room.slots[0] = "pid-host"
        room.players["pid-2"] = {"socketId": "sid-2", "playerName": "P2"}
        room.slots[1] = "pid-2"
        rooms["ROOM4"] = room
        _sid_to_room["sid-host"] = ("ROOM4", "pid-host", False)

        self._run(_leave("sid-host", "disconnect"))

        assert room.owner == "sid-2"
        assert room.slots.get(0) == "pid-2"  # promoted to P1 in lobby
        assert "ROOM4" in rooms

    def test_unknown_sid_is_noop(self):
        self._run(_leave("sid-ghost", "disconnect"))  # must not raise


# ── rom-ready ────────────────────────────────────────────────────────────────


class TestRomReady:
    def _run(self, sid, payload):
        with (
            patch.object(signaling, "check", return_value=True),
            patch.object(signaling.sio, "emit", new=AsyncMock()),
            patch.object(signaling.state, "save_room", new=AsyncMock()),
        ):
            return _run_async(signaling.rom_ready(sid, payload))

    def test_host_rom_change_invalidates_other_ready_state(self):
        room = _make_room(owner="sid-host")
        room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
        room.players["pid-2"] = {"socketId": "sid-2", "playerName": "P2"}
        room.slots[0] = "pid-host"
        room.slots[1] = "pid-2"
        room.rom_ready.update({"sid-host", "sid-2"})
        rooms["ROOM5"] = room
        _sid_to_room["sid-host"] = ("ROOM5", "pid-host", False)

        err = self._run(
            "sid-host",
            {"ready": True, "hash": "S" + "a" * 64, "name": "Host Game.z64", "size": 4096},
        )

        assert err is None
        assert room.rom_hash == "S" + "a" * 64
        assert room.rom_name == "Host Game.z64"
        assert room.rom_size == 4096
        assert room.rom_ready == {"sid-host"}

    def test_guest_mismatched_hash_is_not_ready(self):
        room = _make_room(owner="sid-host")
        room.rom_hash = "S" + "a" * 64
        room.rom_size = 4096
        room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
        room.players["pid-2"] = {"socketId": "sid-2", "playerName": "P2"}
        room.slots[0] = "pid-host"
        room.slots[1] = "pid-2"
        rooms["ROOM6"] = room
        _sid_to_room["sid-2"] = ("ROOM6", "pid-2", False)

        err = self._run("sid-2", {"ready": True, "hash": "S" + "b" * 64, "name": "Other.z64", "size": 4096})

        assert err == "ROM does not match host"
        assert "sid-2" not in room.rom_ready


class TestReleaseSlot:
    def test_same_ip_spectator_cap_refuses_release(self):
        room = _make_room(owner="sid-host")
        room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
        room.players["pid-2"] = {"socketId": "sid-2", "playerName": "P2"}
        room.slots[0] = "pid-host"
        room.slots[1] = "pid-2"
        for index in range(signaling._PER_IP_SPECTATOR_CAP):
            room.spectators[f"pid-spec-{index}"] = {
                "socketId": f"sid-spec-{index}",
                "playerName": "Spec",
            }
        rooms["ROOM7"] = room
        _sid_to_room["sid-2"] = ("ROOM7", "pid-2", False)

        with patch.object(signaling, "ip_hash_for_sid", return_value="same-ip"):
            err = _run_async(signaling._release_slot_locked("sid-2"))

        assert err == "Spectator limit reached for your network"
        assert "pid-2" in room.players
        assert room.slots[1] == "pid-2"
        assert "pid-2" not in room.spectators


# ── data-message relay ───────────────────────────────────────────────────────


class TestDataMessageRelay:
    def test_target_sid_relays_only_to_target_in_same_room(self):
        rooms["ROOM1"] = _make_room()
        _sid_to_room["sid-host"] = ("ROOM1", "pid-host", False)
        _sid_to_room["sid-late"] = ("ROOM1", "pid-late", False)

        emit = AsyncMock()
        with patch.object(signaling.sio, "emit", new=emit):
            _run_async(
                signaling._relay(
                    "sid-host",
                    {"type": "late-join-state", "targetSid": "sid-late", "data": "payload"},
                    "data-message",
                    "data-message",
                    max_bytes=4096,
                )
            )

        emit.assert_awaited_once()
        args, kwargs = emit.await_args
        assert args[0] == "data-message"
        assert kwargs["to"] == "sid-late"
        assert "room" not in kwargs

    def test_to_players_relays_to_players_only(self):
        room = _make_room()
        room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
        room.players["pid-2"] = {"socketId": "sid-2", "playerName": "P2"}
        room.players["pid-3"] = {"socketId": "sid-3", "playerName": "P3"}
        room.spectators["pid-spec"] = {"socketId": "sid-spec", "playerName": "Spec"}
        rooms["ROOM1"] = room
        _sid_to_room["sid-host"] = ("ROOM1", "pid-host", False)

        emit = AsyncMock()
        with patch.object(signaling.sio, "emit", new=emit):
            _run_async(
                signaling._relay(
                    "sid-host",
                    {"type": "save-state", "toPlayers": True, "data": "payload"},
                    "data-message",
                    "data-message",
                    max_bytes=4096,
                )
            )

        targets = sorted(call.kwargs["to"] for call in emit.await_args_list)
        assert targets == ["sid-2", "sid-3"]
        assert all("room" not in call.kwargs for call in emit.await_args_list)

    def test_target_sid_outside_room_is_not_relayed(self):
        rooms["ROOM1"] = _make_room()
        rooms["ROOM2"] = _make_room()
        _sid_to_room["sid-host"] = ("ROOM1", "pid-host", False)
        _sid_to_room["sid-other"] = ("ROOM2", "pid-other", False)

        emit = AsyncMock()
        with patch.object(signaling.sio, "emit", new=emit):
            _run_async(
                signaling._relay(
                    "sid-host",
                    {"type": "late-join-state", "targetSid": "sid-other", "data": "payload"},
                    "data-message",
                    "data-message",
                    max_bytes=4096,
                )
            )

        emit.assert_not_awaited()


# ── end-game ─────────────────────────────────────────────────────────────────
#
# In prod, a host's End Game click could take 5-8s to process because
# _end_game_locked awaited db.set_session_ended() (which could queue behind
# a client's session-log flush on the same connection) BEFORE broadcasting
# game-ended, so the client's 5s fallback fired first. game-ended now
# broadcasts before the DB write.


class TestEndGameBroadcastOrder:
    def _run(self, coro, *, order: list):
        """Patch sio.emit / db.set_session_ended / db.insert_client_event /
        state.save_room / desync_vision.run_postmortem so _end_game_locked
        runs without real I/O, recording call order in `order`."""

        async def _record_emit(event, *args, **kwargs):
            order.append(f"emit:{event}")

        async def _record_set_session_ended(*args, **kwargs):
            order.append("db.set_session_ended")

        async def _record_save_room(*args, **kwargs):
            order.append("state.save_room")

        with (
            patch.object(signaling.sio, "emit", new=AsyncMock(side_effect=_record_emit)),
            patch.object(signaling.db, "set_session_ended", new=AsyncMock(side_effect=_record_set_session_ended)),
            patch.object(signaling.db, "insert_client_event", new=AsyncMock()),
            patch.object(signaling.state, "save_room", new=AsyncMock(side_effect=_record_save_room)),
            patch.object(signaling.desync_vision, "run_postmortem", new=AsyncMock()),
        ):
            return _run_async(coro)

    def test_game_ended_broadcast_before_db_write(self):
        from src.api.payloads import EndGamePayload
        from src.api.signaling import _end_game_locked

        room = _make_room(owner="sid-host")
        room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
        room.slots[0] = "pid-host"
        room.status = "playing"
        room.match_id = "match-1"
        rooms["ROOM1"] = room
        _sid_to_room["sid-host"] = ("ROOM1", "pid-host", False)

        order: list = []
        result = self._run(_end_game_locked("sid-host", EndGamePayload()), order=order)

        assert result is None
        assert "emit:game-ended" in order
        assert "db.set_session_ended" in order
        assert order.index("emit:game-ended") < order.index("db.set_session_ended")
        # users-updated should also land before the DB write.
        assert order.index("emit:users-updated") < order.index("db.set_session_ended")
        # Redis is updated before the DB write, so a set_session_ended
        # failure can never leave Redis still claiming the room is playing
        # after every client was already told the game ended.
        assert order.index("state.save_room") < order.index("db.set_session_ended")
        # Room state already reflects the end even though the DB write is
        # ordered after the broadcasts.
        assert room.status == "lobby"
        assert room.match_id is None

    def test_end_game_without_active_match_does_not_call_set_session_ended(self):
        from src.api.payloads import EndGamePayload
        from src.api.signaling import _end_game_locked

        room = _make_room(owner="sid-host")
        room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
        room.slots[0] = "pid-host"
        room.status = "lobby"
        room.match_id = None
        rooms["ROOM2"] = room
        _sid_to_room["sid-host"] = ("ROOM2", "pid-host", False)

        order: list = []
        self._run(_end_game_locked("sid-host", EndGamePayload()), order=order)

        assert "db.set_session_ended" not in order
        assert "emit:game-ended" in order


# ── match registration and screenshot slots ─────────────────────────────────


def _patched_start(extra=None):
    patches = [
        patch.object(signaling.sio, "emit", new=AsyncMock()),
        patch.object(signaling.state, "save_room", new=AsyncMock()),
        patch.object(signaling.db, "insert_client_event", new=AsyncMock()),
        patch.object(signaling.stats, "record_match", new=AsyncMock()),
    ]
    return patches + (extra or [])


def _host_room(code="ROOM1"):
    room = _make_room(owner="sid-host")
    room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
    room.slots[0] = "pid-host"
    room.rom_ready.add("sid-host")
    rooms[code] = room
    _sid_to_room["sid-host"] = (code, "pid-host", False)
    return room


def _run_with(patches, coro):
    from contextlib import ExitStack

    with ExitStack() as stack:
        for p in patches:
            stack.enter_context(p)
        return _run_async(coro)


def test_start_game_registers_the_match_before_announcing_it():
    from src.api.payloads import StartGamePayload
    from src.api.signaling import _start_game_locked

    room = _host_room()
    order = []
    register = AsyncMock(side_effect=lambda mid, code: order.append(("register", mid, code)))
    emit = AsyncMock(side_effect=lambda event, *a, **k: order.append(("emit", event)))
    patches = _patched_start([patch.object(signaling.db, "register_match", new=register)])
    patches[0] = patch.object(signaling.sio, "emit", new=emit)

    assert _run_with(patches, _start_game_locked("sid-host", StartGamePayload(mode="rollback"))) is None
    assert order[0] == ("register", room.match_id, "ROOM1")
    assert ("emit", "game-started") in order


def test_start_game_survives_register_failure():
    from src.api.payloads import StartGamePayload
    from src.api.signaling import _start_game_locked

    room = _host_room()
    failing = AsyncMock(side_effect=RuntimeError("D1 down"))
    patches = _patched_start([patch.object(signaling.db, "register_match", new=failing)])

    assert _run_with(patches, _start_game_locked("sid-host", StartGamePayload(mode="rollback"))) is None
    assert room.status == "playing" and room.match_id


def _screenshot_room():
    room = _host_room()
    room.match_id = "match-1"
    room.players["pid-guest"] = {"socketId": "sid-guest", "playerName": "Guest"}
    room.slots[1] = "pid-guest"
    _sid_to_room["sid-guest"] = ("ROOM1", "pid-guest", False)
    return room


def _send_screenshot(sid, slot):
    import base64

    from src.api.signaling import game_screenshot

    insert = AsyncMock()
    data = {"matchId": "match-1", "slot": slot, "frame": 300, "data": base64.b64encode(b"\xff\xd8jpeg").decode()}
    patches = [
        patch.object(signaling, "check", new=lambda sid, event: True),
        patch.object(signaling.db, "insert_screenshot", new=insert),
    ]
    _run_with(patches, game_screenshot(sid, data))
    return insert


def test_screenshot_with_own_slot_is_stored():
    _screenshot_room()
    insert = _send_screenshot("sid-guest", 1)
    insert.assert_awaited_once_with("match-1", 1, 300, b"\xff\xd8jpeg")


def test_screenshot_claiming_another_players_slot_is_dropped():
    _screenshot_room()
    insert = _send_screenshot("sid-guest", 0)
    insert.assert_not_awaited()
