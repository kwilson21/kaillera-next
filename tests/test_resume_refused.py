"""A rejoin marked `resume` from a player the room has dropped.

A page whose socket was down for longer than the disconnect grace window is
no longer in the room, but may still be playing: the players' connections
are their own. If the room is still playing that match and the slot is free
the player is taken back; otherwise it is refused, so the page ends its game
instead of carrying on with no signaling. Before, a host's open-room could
create a second, empty room under a page still showing a match, or was
refused and never got back in. The model is specs/room_lifecycle.qnt
(nobodyIsStrandedInADroppedMatch).

Run: cd server && uv run pytest --noconftest ../tests/test_resume_refused.py -v
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

import pytest
from src.api import signaling
from src.api.payloads import JoinRoomPayload, OpenRoomPayload
from src.api.signaling import (
    NOT_IN_ROOM,
    NOT_THE_OWNER,
    Room,
    _join_room_locked,
    _open_room_locked,
    _sid_to_room,
    make_reconnect_token,
    rooms,
)


def _run(coro):
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(coro)).result()


@pytest.fixture(autouse=True)
def clean_state():
    rooms.clear()
    _sid_to_room.clear()
    yield
    rooms.clear()
    _sid_to_room.clear()


def _playing_room(code="ROOM1") -> Room:
    room = Room(owner="sid-host", room_name="Test", game_id="ssb64", password=None, max_players=4)
    room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
    room.slots[0] = "pid-host"
    room.status = "playing"
    room.match_id = "match-1"
    rooms[code] = room
    _sid_to_room["sid-host"] = (code, "pid-host", False)
    return room


def _call(handler, sid, payload):
    with ExitStack() as stack:
        stack.enter_context(patch.object(signaling.sio, "emit", new=AsyncMock()))
        stack.enter_context(patch.object(signaling.sio, "enter_room", new=AsyncMock()))
        stack.enter_context(patch.object(signaling.state, "save_room", new=AsyncMock()))
        # No real sockets here: the host counts as connected.
        stack.enter_context(patch.object(signaling, "room_is_live", new=lambda room: True))
        stack.enter_context(patch.object(signaling, "_leave", new=AsyncMock()))
        return _run(handler(sid, payload))


def _join(pid: str, sid: str, *, resume: bool, slot: int | None = 1, match_id: str = "match-1"):
    payload = JoinRoomPayload(
        extra={
            "sessionid": "ROOM1",
            "persistentId": pid,
            "reconnectToken": make_reconnect_token(pid),
            "resume": resume,
            "slot": slot,
            "matchId": match_id,
        }
    )
    return _call(_join_room_locked, sid, payload)


def _open(pid: str, sid: str, code: str, *, resume: bool, slot: int | None = 0, match_id: str = "match-1"):
    payload = OpenRoomPayload(
        extra={
            "sessionid": code,
            "persistentId": pid,
            "reconnectToken": make_reconnect_token(pid),
            "resume": resume,
            "slot": slot,
            "matchId": match_id,
        }
    )
    return _call(_open_room_locked, sid, payload)


def test_a_dropped_guest_still_playing_the_match_is_taken_back_into_its_slot():
    room = _playing_room()

    err, resp = _join("pid-guest", "sid-guest-2", resume=True, slot=1)

    assert err is None
    assert resp["status"] == "playing"
    assert resp["matchId"] == "match-1"
    assert room.slots[1] == "pid-guest"
    assert room.players["pid-guest"]["socketId"] == "sid-guest-2"
    assert room.owner == "sid-host"


@pytest.mark.parametrize(
    ("why", "slot", "match_id", "status"),
    [
        ("the room started another match", 1, "match-0", "playing"),
        ("the room is back in the lobby", 1, "match-1", "lobby"),
        ("someone else has its slot", 0, "match-1", "playing"),
        ("it names no slot (a spectator)", None, "match-1", "playing"),
        ("it names no match", 1, "", "playing"),
    ],
)
def test_a_dropped_guest_is_refused_and_not_let_in_when(why, slot, match_id, status):
    room = _playing_room()
    room.status = status

    err, resp = _join("pid-guest", "sid-guest-2", resume=True, slot=slot, match_id=match_id)

    assert err == NOT_IN_ROOM, why
    assert resp is None
    assert "pid-guest" not in room.players
    assert "sid-guest-2" not in _sid_to_room


def test_a_dropped_guest_needs_the_password_to_be_taken_back():
    """Its token proves who it is, not that it was ever let in."""
    room = _playing_room()
    room.password = "secret"

    err, resp = _join("pid-guest", "sid-guest-2", resume=True, slot=1)

    assert err == "Wrong password"
    assert resp is None
    assert "pid-guest" not in room.players


def test_a_guest_still_in_the_room_resumes():
    room = _playing_room()
    room.players["pid-guest"] = {"socketId": "sid-guest", "playerName": "Guest"}
    room.slots[1] = "pid-guest"
    _sid_to_room["sid-guest"] = ("ROOM1", "pid-guest", False)

    err, resp = _join("pid-guest", "sid-guest-2", resume=True)

    assert err is None
    assert resp["status"] == "playing"
    assert resp["matchId"] == "match-1"
    assert room.players["pid-guest"]["socketId"] == "sid-guest-2"


def test_a_member_of_a_password_room_resumes_without_the_password():
    """The mid-game rejoin carries no password; the reconnect token is the proof."""
    room = _playing_room()
    room.password = "secret"
    room.players["pid-guest"] = {"socketId": "sid-guest", "playerName": "Guest"}
    room.slots[1] = "pid-guest"
    _sid_to_room["sid-guest"] = ("ROOM1", "pid-guest", False)

    err, resp = _join("pid-guest", "sid-guest-2", resume=True)

    assert err is None
    assert resp["status"] == "playing"


def test_a_password_room_still_asks_a_new_joiner_for_the_password():
    room = _playing_room()
    room.password = "secret"

    err, resp = _join("pid-stranger", "sid-stranger", resume=False)

    assert err == "Wrong password"
    assert resp is None
    assert "pid-stranger" not in room.players


def test_a_bad_reconnect_token_does_not_get_past_the_password():
    room = _playing_room()
    room.password = "secret"
    room.players["pid-guest"] = {"socketId": "sid-guest", "playerName": "Guest"}
    payload = JoinRoomPayload(
        extra={"sessionid": "ROOM1", "persistentId": "pid-guest", "reconnectToken": "forged", "resume": True}
    )

    err, resp = _call(_join_room_locked, "sid-attacker", payload)

    assert err == "Invalid reconnect token"
    assert resp is None
    assert room.players["pid-guest"]["socketId"] == "sid-guest"


def test_the_same_guest_joining_afresh_is_let_in():
    room = _playing_room()

    err, resp = _join("pid-guest", "sid-guest-2", resume=False)

    assert err is None
    assert resp["status"] == "playing"
    assert "pid-guest" in room.players


def test_a_host_resuming_a_room_that_is_gone_does_not_create_one():
    err = _open("pid-host", "sid-host-2", "GONE1", resume=True)

    assert err == NOT_IN_ROOM
    assert "GONE1" not in rooms


def _room_handed_on_from_the_host() -> Room:
    """The host was dropped mid-match: the guest owns the room, slot 0 is free."""
    room = Room(owner="sid-guest", room_name="Test", game_id="ssb64", password=None, max_players=4)
    room.players["pid-guest"] = {"socketId": "sid-guest", "playerName": "Guest"}
    room.slots[1] = "pid-guest"
    room.status = "playing"
    room.match_id = "match-1"
    rooms["ROOM1"] = room
    _sid_to_room["sid-guest"] = ("ROOM1", "pid-guest", False)
    return room


def test_a_dropped_host_still_playing_the_match_is_taken_back_as_a_player():
    room = _room_handed_on_from_the_host()

    err = _open("pid-host", "sid-host-2", "ROOM1", resume=True, slot=0)

    assert err is None
    assert room.slots[0] == "pid-host"
    assert room.status == "playing"
    assert room.match_id == "match-1"
    assert room.owner == "sid-guest"


def test_a_dropped_host_is_refused_once_the_room_has_moved_on():
    room = _room_handed_on_from_the_host()
    room.status = "lobby"
    room.match_id = None

    err = _open("pid-host", "sid-host-2", "ROOM1", resume=True, slot=0)

    assert err == NOT_IN_ROOM
    assert "pid-host" not in room.players


def test_a_taken_back_host_that_reloads_is_sent_to_join_room():
    """Its URL still says host, but the room is someone else's and is playing."""
    room = _room_handed_on_from_the_host()
    assert _open("pid-host", "sid-host-2", "ROOM1", resume=True, slot=0) is None

    payload = OpenRoomPayload(
        extra={
            "sessionid": "ROOM1",
            "persistentId": "pid-host",
            "reconnectToken": make_reconnect_token("pid-host"),
            "fresh": True,
        }
    )
    err = _call(_open_room_locked, "sid-host-3", payload)

    assert err == NOT_THE_OWNER
    assert room.status == "playing"
    # Nothing was changed: join-room does the reconnect.
    assert room.players["pid-host"]["socketId"] == "sid-host-2"

    err, resp = _join("pid-host", "sid-host-3", resume=False)
    assert err is None
    assert resp["status"] == "playing"
    assert room.players["pid-host"]["socketId"] == "sid-host-3"


def test_clients_from_before_the_field_are_not_resuming():
    assert JoinRoomPayload(extra={"sessionid": "ROOM1"}).extra.resume is False
    assert OpenRoomPayload(extra={"sessionid": "ROOM1"}).extra.resume is False
