"""A host that reloads mid-game must not leave the room stuck "playing".

Production, 2026-11-09: the host reloaded, open-room's reconnect path kept
status "playing", the host's page showed the lobby, and two joiners were sent
down the late-join path to a host with no emulator running. The model of this
is specs/room_lifecycle.qnt (invariant ownerSeesGame).

Run: cd server && uv run pytest ../tests/test_host_reload.py -v
"""

import asyncio
import re
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from src.api import signaling
from src.api.payloads import OpenRoomPayload
from src.api.signaling import Room, _open_room_locked, _sid_to_room, make_reconnect_token, rooms

ENGINE = Path(__file__).parent.parent / "web" / "static" / "netplay-rollback.js"


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


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
    room.players["pid-guest"] = {"socketId": "sid-guest", "playerName": "Guest"}
    room.slots[0] = "pid-host"
    room.slots[1] = "pid-guest"
    room.status = "playing"
    room.match_id = "match-1"
    rooms[code] = room
    _sid_to_room["sid-host"] = (code, "pid-host", False)
    _sid_to_room["sid-guest"] = (code, "pid-guest", False)
    return room


def _reopen(pid: str, new_sid: str, *, fresh: bool):
    """open-room from `pid` on a new socket; returns (error, emitted event names)."""
    emit = AsyncMock()
    payload = OpenRoomPayload(
        extra={
            "sessionid": "ROOM1",
            "persistentId": pid,
            "reconnectToken": make_reconnect_token(pid),
            "fresh": fresh,
        }
    )
    with ExitStack() as stack:
        stack.enter_context(patch.object(signaling.sio, "emit", new=emit))
        stack.enter_context(patch.object(signaling.sio, "enter_room", new=AsyncMock()))
        stack.enter_context(patch.object(signaling.state, "save_room", new=AsyncMock()))
        stack.enter_context(patch.object(signaling.db, "set_session_ended", new=AsyncMock()))
        stack.enter_context(patch.object(signaling.db, "insert_client_event", new=AsyncMock()))
        stack.enter_context(patch.object(signaling.desync_vision, "run_postmortem", new=AsyncMock()))
        err = _run(_open_room_locked(new_sid, payload))
    return err, [call.args[0] for call in emit.call_args_list]


def test_fresh_host_page_ends_the_match():
    room = _playing_room()

    err, events = _reopen("pid-host", "sid-host-2", fresh=True)

    assert err is None
    assert room.status == "lobby"
    assert room.match_id is None
    assert room.owner == "sid-host-2"
    assert "game-ended" in events
    assert "pid-guest" in room.players


def test_socket_reconnect_under_a_running_game_keeps_the_match():
    room = _playing_room()

    err, events = _reopen("pid-host", "sid-host-2", fresh=False)

    assert err is None
    assert room.status == "playing"
    assert room.match_id == "match-1"
    assert "game-ended" not in events


def test_clients_from_before_the_field_keep_the_match():
    """No `fresh` in the payload (a page loaded before this deploy) means not fresh."""
    assert OpenRoomPayload(extra={"sessionid": "ROOM1"}).extra.fresh is False


def test_fresh_reopen_by_a_non_owner_does_not_end_the_match():
    """Ownership moved to the guest; a returning ex-host can't end their game.

    It is not shown a lobby over the match either: it is sent to join-room.
    """
    room = _playing_room()
    room.owner = "sid-guest"

    err, events = _reopen("pid-host", "sid-host-2", fresh=True)

    assert err == signaling.NOT_THE_OWNER
    assert room.status == "playing"
    assert "game-ended" not in events
    assert room.players["pid-host"]["socketId"] == "sid-host"


def test_fresh_reopen_in_the_lobby_changes_nothing():
    room = _playing_room()
    room.status = "lobby"
    room.match_id = None

    err, events = _reopen("pid-host", "sid-host-2", fresh=True)

    assert err is None
    assert room.status == "lobby"
    assert "game-ended" not in events


def test_engine_never_compares_the_roster_against_the_raw_socket_id():
    """While the signaling socket is down `socket.id` is undefined, so a raw
    comparison makes a player's own roster entry look like a missing peer.
    Production, 2026-11-09: the host opened a connection to itself and stalled
    5 s at a time on input from its own slot. Use _isOwnSid(sid).
    """
    src = ENGINE.read_text()
    # _isOwnSid itself is the one place allowed to look at socket.id.
    helper = re.search(r"const _isOwnSid = .*\n", src)
    assert helper, "_isOwnSid helper is gone"
    rest = src.replace(helper.group(0), "")
    lines = rest.split("\n")
    starts = [i for i, line in enumerate(lines) if "Object.entries(_knownPlayers)) {" in line]
    assert starts, "no roster loops found"
    for i in starts:
        code = [ln for ln in lines[i + 1 : i + 8] if not ln.strip().startswith("//")]
        for ln in code[:3]:
            assert "socket.id" not in ln and "socket?.id" not in ln, f"line {i + 1}: {ln.strip()}"
