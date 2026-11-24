"""A guest keeps its slot longer while every player's signaling socket is down.

The host has a separate deadline tested in test_disconnect_cleanup.py.
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
    task = asyncio.create_task(_disconnect_grace_expiry(f"sid-{name}", "ROOM1", f"pid-{name}", "disconnect", GRACE))
    signaling._disconnect_grace_tasks["ROOM1", f"pid-{name}"] = task
    return task


def test_places_are_kept_while_nobody_is_connected():
    room = _playing_room(connected=())

    async def scenario():
        tasks = [_expire("guest")]
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


def test_a_guest_who_never_returns_is_removed_at_the_silent_room_limit():
    _playing_room(connected=())

    async def scenario():
        await _expire("guest")

    with ExitStack() as stack:
        _stubbed(stack, silent_room_grace=GRACE * 3)
        _run(scenario())

    assert sorted(rooms["ROOM1"].players) == ["pid-host"]
