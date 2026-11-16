"""The sender stamp on relayed messages.

`data-message`, `snapshot` and `input` are relayed from any member of a
room, spectators included, and everything in them is the sender's own words.
The pages act on some of it (load this emulator state, send state to that
socket, change the mode), so the server stamps who really sent each message:
its socket id, its player slot (none for a spectator) and whether it owns
the room. The pages check the stamp (web/src/relay-sender.ts).

Run: cd server && uv run pytest --noconftest ../tests/test_relay_sender.py -v
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, patch

import pytest

from src.api import signaling
from src.api.payloads import RELAY_SENDER_KEY, RelaySender
from src.api.signaling import Room, _sid_to_room, rooms


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


@pytest.fixture
def room() -> Room:
    room = Room(owner="sid-host", room_name="Test", game_id="ssb64", password=None, max_players=4)
    room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
    room.players["pid-guest"] = {"socketId": "sid-guest", "playerName": "Guest"}
    room.spectators["pid-spec"] = {"socketId": "sid-spec", "playerName": "Spec"}
    room.slots[0] = "pid-host"
    room.slots[1] = "pid-guest"
    rooms["ROOM1"] = room
    _sid_to_room["sid-host"] = ("ROOM1", "pid-host", False)
    _sid_to_room["sid-guest"] = ("ROOM1", "pid-guest", False)
    _sid_to_room["sid-spec"] = ("ROOM1", "pid-spec", True)
    return room


def _relayed(handler, sid: str, data: dict) -> list[tuple[dict, dict]]:
    """Run a relay handler; return (payload, emit kwargs) for each message sent on."""
    emit = AsyncMock()
    with patch.object(signaling.sio, "emit", new=emit), patch.object(signaling, "check", new=lambda *a, **k: True):
        _run(handler(sid, data))
    return [(call.args[1], call.kwargs) for call in emit.call_args_list]


def _stamp(payload: dict) -> dict:
    # The stamp is exactly the model the client's schema is generated from.
    RelaySender.model_validate(payload[RELAY_SENDER_KEY], strict=True)
    return payload[RELAY_SENDER_KEY]


def test_the_owner_in_slot_0_is_stamped_as_such(room):
    sent = _relayed(signaling.data_message, "sid-host", {"type": "save-state", "data": "abc"})
    assert len(sent) == 1
    payload, kwargs = sent[0]
    assert _stamp(payload) == {"sid": "sid-host", "slot": 0, "owner": True}
    # The rest of the message goes on as sent, to the room but not its sender.
    assert payload["type"] == "save-state" and payload["data"] == "abc"
    assert kwargs == {"room": "ROOM1", "skip_sid": "sid-host"}


def test_a_guest_is_stamped_with_its_own_slot(room):
    payload, _ = _relayed(signaling.data_message, "sid-guest", {"type": "request-late-join"})[0]
    assert _stamp(payload) == {"sid": "sid-guest", "slot": 1, "owner": False}


def test_a_spectators_stamp_has_no_slot(room):
    payload, _ = _relayed(signaling.data_message, "sid-spec", {"type": "late-join-state", "data": "x"})[0]
    assert _stamp(payload) == {"sid": "sid-spec", "slot": None, "owner": False}


def test_a_forged_stamp_is_replaced(room):
    forged = {"sid": "sid-host", "slot": 0, "owner": True}
    msg = {"type": "sync-state-socket", "targetSid": "sid-guest", RELAY_SENDER_KEY: forged}
    sent = _relayed(signaling.data_message, "sid-spec", msg)
    assert len(sent) == 1
    payload, kwargs = sent[0]
    assert _stamp(payload) == {"sid": "sid-spec", "slot": None, "owner": False}
    assert kwargs == {"to": "sid-guest"}
    # The sender's own dict is not written to.
    assert msg[RELAY_SENDER_KEY] == forged


def test_a_forged_stamp_that_is_not_an_object_is_replaced(room):
    payload, _ = _relayed(signaling.data_message, "sid-spec", {"type": "mode-select", RELAY_SENDER_KEY: None})[0]
    assert _stamp(payload) == {"sid": "sid-spec", "slot": None, "owner": False}


def test_the_players_only_fan_out_is_stamped(room):
    sent = _relayed(signaling.data_message, "sid-host", {"type": "save-state", "toPlayers": True})
    assert [kwargs for _, kwargs in sent] == [{"to": "sid-guest"}]
    assert _stamp(sent[0][0]) == {"sid": "sid-host", "slot": 0, "owner": True}


def test_snapshot_and_input_are_stamped_too(room):
    for handler in (signaling.snapshot, signaling.game_input):
        payload, _ = _relayed(handler, "sid-guest", {"frame": 1, RELAY_SENDER_KEY: {"slot": 0}})[0]
        assert _stamp(payload) == {"sid": "sid-guest", "slot": 1, "owner": False}


def test_a_player_holding_no_slot_has_none(room):
    del room.slots[1]
    payload, _ = _relayed(signaling.data_message, "sid-guest", {"type": "rom-accepted"})[0]
    assert _stamp(payload) == {"sid": "sid-guest", "slot": None, "owner": False}


def test_a_sender_outside_any_room_is_not_relayed(room):
    assert _relayed(signaling.data_message, "sid-stranger", {"type": "save-state"}) == []
