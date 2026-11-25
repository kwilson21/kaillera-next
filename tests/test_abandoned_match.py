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
            "reconnectToken": make_reconnect_token("ROOM1", pid),
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


@pytest.mark.parametrize("owner", ["host", "guest"])
def test_fresh_owner_using_the_invite_reclaims_the_lobby_with_other_players(monkeypatch, owner):
    room = _playing_room()
    room.players["pid-guest"] = {"socketId": "sid-guest", "playerName": "Guest"}
    room.slots[1] = "pid-guest"
    room.owner = f"sid-{owner}"
    emit = AsyncMock(wraps=signaling._emit)
    monkeypatch.setattr(signaling, "_emit", emit)

    (err, ack), events = _join(f"pid-{owner}", "sid-returning")

    assert err is None
    assert ack["owner"] == "sid-returning"
    assert ack["status"] == "lobby"
    assert ack["matchId"] is None
    assert ack["players"][f"pid-{owner}"]["slot"] == 0
    other = "guest" if owner == "host" else "host"
    assert ack["players"][f"pid-{other}"]["slot"] == 1
    assert events.count("game-ended") == 1
    emit.assert_any_await("game-ended", {"matchId": "match-1", "reason": "host-reload"}, room="ROOM1")


def _return_host(room_id="ROOM1", sid="sid-new", pid="pid-host", token=None):
    extra = {
        "sessionid": room_id,
        "persistentId": pid,
        "reconnectToken": make_reconnect_token(room_id, pid) if token is None else token,
        "returnHost": True,
    }
    return _call(signaling.join_room, sid, {"extra": extra})


def test_return_host_waits_for_the_old_tab_and_only_reclaims_once(monkeypatch):
    room = _playing_room()
    monkeypatch.setattr(signaling, "_sid_host", {"sid-host": "localhost", "sid-new": "localhost"})
    (err, ack), events = _return_host()
    assert (err, ack) == ("Host tab is still connected", None)
    assert not events and room.owner == "sid-host" and room.match_id == "match-1"

    del signaling._sid_host["sid-host"]
    (err, ack), events = _return_host()
    assert err is None and ack["status"] == "lobby" and room.owner == "sid-new"
    assert events.count("game-ended") == 1

    room.status, room.match_id = "playing", "rematch"
    (err, ack), events = _return_host()
    assert err is None and ack["matchId"] == "rematch"
    assert not events


@pytest.mark.parametrize("event", ["open-room", "join-room"])
def test_fresh_owner_requests_never_replace_a_connected_host(monkeypatch, event):
    room = _playing_room()
    monkeypatch.setattr(signaling, "_sid_host", {"sid-host": "localhost", "sid-new": "localhost"})
    extra = {"sessionid": "ROOM1", "persistentId": "pid-host", "reconnectToken": make_reconnect_token("ROOM1", "pid-host")}

    def request(sid, *, resume=False):
        if event == "open-room":
            return _call(signaling.open_room, sid, {"extra": {**extra, "fresh": not resume, "resume": resume}})
        (error, _), events = _call(signaling.join_room, sid, {"extra": {**extra, "resume": resume}})
        return error, events

    assert request("sid-new") == ("Host tab is still connected", [])
    assert request("sid-host") == (None, [])
    assert room.owner == "sid-host" and room.match_id == "match-1"
    err, events = request("sid-new", resume=True)
    assert err is None and "game-ended" not in events
    assert room.owner == "sid-new" and room.match_id == "match-1"

    del signaling._sid_host["sid-new"]
    err, events = request("sid-host")
    assert err is None and events.count("game-ended") == 1
    assert room.owner == "sid-host" and room.status == "lobby"


@pytest.mark.parametrize("token", [
    "",
    make_reconnect_token("OTHER", "pid-host"),
    signaling._make_token({"k": "reconnect", "pid": "pid-host", "exp": 2**40}),
    signaling._make_token({"k": "reconnect", "room": "ROOM1", "pid": "pid-host", "exp": 0}),
], ids=["missing", "wrong-room", "legacy", "expired"])
def test_return_host_requires_current_room_bound_proof(token):
    room = _playing_room()
    (err, ack), events = _return_host(token=token)
    assert (err, ack) == ("Host seat is no longer available", None)
    assert not events and room.owner == "sid-host" and room.match_id == "match-1"
    assert "sid-new" not in _sid_to_room


def test_return_host_preserves_transferred_ownership():
    room = _playing_room()
    _join("pid-guest", "sid-guest")
    _call(_leave, "sid-host", "leave")
    assert room.owner == "sid-guest"
    (err, ack), events = _return_host()
    assert (err, ack) == ("Host seat is no longer available", None)
    assert not events and "pid-host" not in room.players


def test_return_host_preserves_a_guest_membership():
    room = _playing_room()
    _join("pid-guest", "sid-guest")
    (err, ack), events = _return_host(pid="pid-guest")
    assert (err, ack) == ("Host seat is no longer available", None)
    assert not events and room.players["pid-guest"]["socketId"] == "sid-guest"


def test_return_host_cannot_open_a_closed_room():
    (err, ack), events = _return_host()
    assert (err, ack) == ("Host seat is no longer available", None)
    assert not events and not rooms and not _sid_to_room


def test_invite_without_the_owners_token_cannot_end_the_match():
    room = _playing_room()
    payload = JoinRoomPayload(extra={"sessionid": "ROOM1", "persistentId": "pid-host"})
    (err, ack), events = _call(_join_room_locked, "sid-other", payload)

    assert err == "Invalid reconnect token"
    assert ack is None
    assert room.owner == "sid-host" and room.match_id == "match-1"
    assert "game-ended" not in events


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
