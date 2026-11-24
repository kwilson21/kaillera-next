"""A guest has the same bounded return window whether anyone else is connected."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

import pytest

from src.api import signaling
from src.api.signaling import Room, _sid_host, _sid_to_room, rooms


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


def _stubbed(stack: ExitStack) -> None:
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


@pytest.mark.parametrize("connected", [(), ("host",)])
def test_a_reserved_guest_is_removed_at_its_deadline_with_or_without_a_live_host(connected):
    room = _playing_room(connected=connected)
    deadline = 100_150
    room.players["pid-guest"]["returnDeadline"] = deadline
    _sid_to_room.clear()  # A restart restores seats without their reverse socket mappings.

    async def scenario():
        now = 100_000
        with patch.object(signaling, "_now_ms", lambda: now):
            signaling._schedule_return("ROOM1", room, "pid-guest")
            assert room.players["pid-guest"]["returnDeadline"] == deadline
            assert "pid-guest" in room.players
            now = deadline
            await asyncio.wait_for(signaling._disconnect_grace_tasks["ROOM1", "pid-guest"], timeout=2)
            assert "pid-guest" not in room.players
            assert room.slots == {0: "pid-host"}
            assert signaling._disconnect_grace_tasks == {}
            assert rooms["ROOM1"].match_id == "match-1"

    with ExitStack() as stack:
        _stubbed(stack)
        _run(scenario())
