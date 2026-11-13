"""A rejoin marked `resume` from a client the room has dropped is refused.

A page whose socket was down for longer than the disconnect grace window is
no longer in the room. Before, a guest's join-room took it for a new player
and let it in while its page carried on with the old game, and a host's
open-room could create a second, empty room under a page still showing a
match. The model is specs/room_lifecycle.qnt
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


def _join(pid: str, sid: str, *, resume: bool):
    payload = JoinRoomPayload(
        extra={
            "sessionid": "ROOM1",
            "persistentId": pid,
            "reconnectToken": make_reconnect_token(pid),
            "resume": resume,
        }
    )
    return _call(_join_room_locked, sid, payload)


def _open(pid: str, sid: str, code: str, *, resume: bool):
    payload = OpenRoomPayload(
        extra={
            "sessionid": code,
            "persistentId": pid,
            "reconnectToken": make_reconnect_token(pid),
            "resume": resume,
        }
    )
    return _call(_open_room_locked, sid, payload)


def test_a_dropped_guest_resuming_is_refused_and_not_let_in():
    room = _playing_room()

    err, resp = _join("pid-guest", "sid-guest-2", resume=True)

    assert err == NOT_IN_ROOM
    assert resp is None
    assert "pid-guest" not in room.players
    assert "sid-guest-2" not in _sid_to_room


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


def test_a_host_resuming_a_room_that_has_another_owner_is_refused():
    room = _playing_room()

    err = _open("pid-old-host", "sid-old-host-2", "ROOM1", resume=True)

    assert err == NOT_IN_ROOM
    assert "pid-old-host" not in room.players


def test_clients_from_before_the_field_are_not_resuming():
    assert JoinRoomPayload(extra={"sessionid": "ROOM1"}).extra.resume is False
    assert OpenRoomPayload(extra={"sessionid": "ROOM1"}).extra.resume is False
