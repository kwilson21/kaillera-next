"""A signaling outage that hits every player does not cost them their match.

Players run a match over their own connections; the server only signals. When
every player's socket was down for longer than the disconnect grace window (a
server restart, a network drop), each was removed after its own window, the
room was emptied and deleted, and the returning players were refused and sent
to the lobby. The server now keeps their places while nobody in a playing
room is connected, up to a much longer bound. The model is
specs/room_lifecycle.qnt (aMatchIsNotLostToTheGraceWindow, everyoneDropsTest).

Run: cd server && uv run pytest --noconftest ../tests/test_silent_room_grace.py -v
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

import pytest

from src.api import signaling
from src.api.signaling import Room, _disconnect_grace_expiry, _sid_host, _sid_to_room, rooms

GRACE = 0.02
POLL = 0.01


def _run(coro):
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(coro)).result()


@pytest.fixture(autouse=True)
def clean_state():
    for store in (rooms, _sid_to_room, _sid_host, signaling._disconnect_grace_tasks):
        store.clear()
    yield
    for store in (rooms, _sid_to_room, _sid_host, signaling._disconnect_grace_tasks):
        store.clear()


def _playing_room(connected: tuple[str, ...]) -> Room:
    """A two-player match; `connected` names the players whose socket is up."""
    room = Room(owner="sid-host", room_name="Test", game_id="ssb64", password=None, max_players=4)
    for slot, name in enumerate(("host", "guest")):
        room.players[f"pid-{name}"] = {"socketId": f"sid-{name}", "playerName": name}
        room.slots[slot] = f"pid-{name}"
        _sid_to_room[f"sid-{name}"] = ("ROOM1", f"pid-{name}", False)
        if name in connected:
            _sid_host[f"sid-{name}"] = "localhost"
    room.status = "playing"
    room.match_id = "match-1"
    rooms["ROOM1"] = room
    return room


def _stubbed(stack: ExitStack, silent_room_grace: float) -> None:
    for target, name in (
        (signaling.sio, "emit"),
        (signaling.sio, "enter_room"),
        (signaling.sio, "leave_room"),
        (signaling.state, "save_room"),
        (signaling.state, "delete_room"),
        (signaling.db, "set_session_ended"),
        (signaling.db, "insert_client_event"),
        (signaling.desync_vision, "run_postmortem"),
    ):
        stack.enter_context(patch.object(target, name, new=AsyncMock()))
    stack.enter_context(patch.object(signaling, "_SILENT_ROOM_GRACE_SECONDS", silent_room_grace))
    stack.enter_context(patch.object(signaling, "_SILENT_ROOM_POLL_SECONDS", POLL))


def _expire(name: str) -> asyncio.Task:
    return asyncio.create_task(_disconnect_grace_expiry(f"sid-{name}", "ROOM1", f"pid-{name}", "disconnect", GRACE))


def test_places_are_kept_while_nobody_is_connected():
    room = _playing_room(connected=())

    async def scenario():
        tasks = [_expire("host"), _expire("guest")]
        await asyncio.sleep(GRACE * 10)
        kept = sorted(room.players)
        for task in tasks:
            task.cancel()  # both players reconnect
        await asyncio.gather(*tasks)
        return kept

    with ExitStack() as stack:
        _stubbed(stack, silent_room_grace=60)
        kept = _run(scenario())

    assert kept == ["pid-guest", "pid-host"]
    assert rooms["ROOM1"].status == "playing"
    assert rooms["ROOM1"].match_id == "match-1"


def test_a_dropped_player_is_removed_on_time_while_another_is_connected():
    room = _playing_room(connected=("host",))

    async def scenario():
        await _expire("guest")

    with ExitStack() as stack:
        _stubbed(stack, silent_room_grace=60)
        _run(scenario())

    assert sorted(room.players) == ["pid-host"]
    assert "ROOM1" in rooms


def test_a_player_still_away_is_removed_once_another_returns():
    room = _playing_room(connected=())

    async def scenario():
        task = _expire("guest")
        await asyncio.sleep(GRACE * 5)
        assert "pid-guest" in room.players
        _sid_host["sid-host"] = "localhost"  # the host's socket is back
        await task

    with ExitStack() as stack:
        _stubbed(stack, silent_room_grace=60)
        _run(scenario())

    assert sorted(room.players) == ["pid-host"]


def test_a_room_nobody_returns_to_is_given_up():
    _playing_room(connected=())

    async def scenario():
        await asyncio.gather(_expire("host"), _expire("guest"))

    with ExitStack() as stack:
        _stubbed(stack, silent_room_grace=GRACE * 3)
        _run(scenario())

    assert "ROOM1" not in rooms


def test_a_lobby_owner_is_not_kept_past_its_grace():
    room = _playing_room(connected=())
    room.status = "lobby"
    room.match_id = None

    async def scenario():
        await _expire("host")

    with ExitStack() as stack:
        _stubbed(stack, silent_room_grace=60)
        _run(scenario())

    assert "pid-host" not in room.players
