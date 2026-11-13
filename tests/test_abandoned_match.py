"""A playing room that none of its players is running is ended by the server.

Late-join state comes only from a player running the match. When the players
who were running it leave, a player who joined mid-match and has not got in
yet would wait for ever: the room stayed "playing", the joiner timed out, and
a reload put it straight back on the late-join path. The model is
specs/room_lifecycle.qnt (anAbandonedMatchIsEnded).

Run: cd server && uv run pytest --noconftest ../tests/test_abandoned_match.py -v
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

import pytest
from src import state
from src.api import signaling
from src.api.payloads import JoinRoomPayload, MatchJoinedPayload
from src.api.signaling import (
    Room,
    _join_room_locked,
    _leave,
    _sid_to_room,
    make_reconnect_token,
    match_is_abandoned,
    match_joined,
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


def _call(coro_fn, *args):
    """Run a handler with the network and the database stubbed; returns (result, emitted events)."""
    emit = AsyncMock()
    with ExitStack() as stack:
        stack.enter_context(patch.object(signaling.sio, "emit", new=emit))
        stack.enter_context(patch.object(signaling.sio, "enter_room", new=AsyncMock()))
        stack.enter_context(patch.object(signaling.sio, "leave_room", new=AsyncMock()))
        stack.enter_context(patch.object(signaling.state, "save_room", new=AsyncMock()))
        stack.enter_context(patch.object(signaling.state, "delete_room", new=AsyncMock()))
        stack.enter_context(patch.object(signaling.db, "set_session_ended", new=AsyncMock()))
        stack.enter_context(patch.object(signaling.db, "insert_client_event", new=AsyncMock()))
        stack.enter_context(patch.object(signaling.desync_vision, "run_postmortem", new=AsyncMock()))
        stack.enter_context(patch.object(signaling, "room_is_live", new=lambda room: True))
        stack.enter_context(patch.object(signaling, "check", new=lambda *a, **k: True))
        result = _run(coro_fn(*args))
    return result, [call.args[0] for call in emit.call_args_list]


def _join(pid: str, sid: str, *, resume: bool = False):
    payload = JoinRoomPayload(
        extra={
            "sessionid": "ROOM1",
            "persistentId": pid,
            "reconnectToken": make_reconnect_token(pid),
            "resume": resume,
        }
    )
    return _call(_join_room_locked, sid, payload)


def test_a_player_who_joins_a_match_in_play_is_waiting_until_it_says_it_is_in():
    room = _playing_room()

    (err, _resp), _events = _join("pid-guest", "sid-guest")
    assert err is None
    assert room.waiting_for_state == {"pid-guest"}
    assert not match_is_abandoned(room)

    result, _events = _call(match_joined, "sid-guest", {"matchId": "match-1"})
    assert result is None
    assert room.waiting_for_state == set()


def test_the_match_ends_when_only_a_waiting_joiner_is_left():
    room = _playing_room()
    _join("pid-guest", "sid-guest")

    _result, events = _call(_leave, "sid-host", "leave")

    assert room.status == "lobby"
    assert room.match_id is None
    assert "game-ended" in events
    assert room.waiting_for_state == set()
    assert "pid-guest" in room.players


def test_the_match_goes_on_when_the_joiner_had_got_in():
    room = _playing_room()
    _join("pid-guest", "sid-guest")
    _call(match_joined, "sid-guest", {"matchId": "match-1"})

    _result, events = _call(_leave, "sid-host", "leave")

    assert room.status == "playing"
    assert "game-ended" not in events


def test_the_match_goes_on_while_a_player_who_was_running_it_remains():
    room = _playing_room()
    room.players["pid-two"] = {"socketId": "sid-two", "playerName": "Two"}
    room.slots[1] = "pid-two"
    _sid_to_room["sid-two"] = ("ROOM1", "pid-two", False)
    _join("pid-guest", "sid-guest")

    _result, events = _call(_leave, "sid-host", "leave")

    assert room.status == "playing"
    assert "game-ended" not in events


def test_a_spectator_leaving_ends_nothing():
    room = _playing_room()
    room.spectators["pid-spec"] = {"socketId": "sid-spec", "playerName": "Spec"}
    _sid_to_room["sid-spec"] = ("ROOM1", "pid-spec", True)

    _result, events = _call(_leave, "sid-spec", "leave")

    assert room.status == "playing"
    assert "game-ended" not in events


def test_the_only_player_reloading_into_its_own_match_ends_it():
    """A fresh page has no emulator: with nobody else running, the match is over."""
    room = _playing_room()
    room.owner = "sid-other"  # not the owner, so open-room's own rule does not apply

    (err, resp), events = _join("pid-host", "sid-host-2", resume=False)

    assert err is None
    assert room.status == "lobby"
    assert "game-ended" in events
    assert resp["status"] == "lobby"


def test_a_page_resuming_under_its_running_game_is_not_waiting():
    room = _playing_room()

    (err, _resp), events = _join("pid-host", "sid-host-2", resume=True)

    assert err is None
    assert room.waiting_for_state == set()
    assert room.status == "playing"
    assert "game-ended" not in events


def test_match_joined_for_another_match_changes_nothing():
    room = _playing_room()
    _join("pid-guest", "sid-guest")

    _call(match_joined, "sid-guest", {"matchId": "match-0"})

    assert room.waiting_for_state == {"pid-guest"}


def test_a_new_match_starts_with_nobody_waiting():
    room = _playing_room()
    _join("pid-guest", "sid-guest")
    _call(_leave, "sid-host", "leave")
    assert room.status == "lobby"
    # The next start clears the set; here the end already did.
    assert room.waiting_for_state == set()
    assert MatchJoinedPayload(matchId="m").matchId == "m"


def test_the_waiting_set_survives_a_restart():
    room = _playing_room()
    room.waiting_for_state.add("pid-guest")

    import json

    restored = state._deserialize_room(json.loads(state._serialize_room(room)))

    assert restored.waiting_for_state == {"pid-guest"}
