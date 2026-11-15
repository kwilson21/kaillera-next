"""What the server passes on of a `webrtc-signal`.

The server relays a signal to its target in the same room, keeping only the
keys it knows and adding `sender`. `attemptId` ({page, attempt}) names the
connection attempt a signal belongs to (web/src/peer-observe.ts): it must
reach the other page as it was sent, and a signal without one (from a page
made before it) must still be relayed. `startupReconnect` must arrive too:
it is how a page tells a startup retry from a gameplay reconnect.

Run: cd server && uv run pytest --noconftest ../tests/test_webrtc_signal_relay.py -v
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import AsyncMock, patch

import pytest

from src.api import signaling
from src.api.signaling import Room, _sid_to_room, rooms


def _run(coro):
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(coro)).result()


@pytest.fixture(autouse=True)
def room():
    rooms.clear()
    _sid_to_room.clear()
    room = Room(owner="sid-host", room_name="Test", game_id="ssb64", password=None, max_players=4)
    room.players["pid-host"] = {"socketId": "sid-host", "playerName": "Host"}
    room.players["pid-guest"] = {"socketId": "sid-guest", "playerName": "Guest"}
    room.slots[0] = "pid-host"
    room.slots[1] = "pid-guest"
    rooms["ROOM1"] = room
    _sid_to_room["sid-host"] = ("ROOM1", "pid-host", False)
    _sid_to_room["sid-guest"] = ("ROOM1", "pid-guest", False)
    yield room
    rooms.clear()
    _sid_to_room.clear()


def _relayed(sid: str, data: dict) -> list[tuple[str, dict, dict]]:
    emit = AsyncMock()
    with patch.object(signaling.sio, "emit", new=emit), patch.object(signaling, "check", new=lambda *a, **k: True):
        _run(signaling.webrtc_signal(sid, data))
    return [(call.args[0], call.args[1], call.kwargs) for call in emit.call_args_list]


def test_an_offer_keeps_its_attempt_id():
    attempt = {"page": "a1b2c3", "attempt": 2}
    sent = _relayed("sid-host", {"target": "sid-guest", "offer": {"type": "offer", "sdp": "v=0"}, "reconnect": True, "attemptId": attempt})
    assert sent == [
        (
            "webrtc-signal",
            {
                "sender": "sid-host",
                "target": "sid-guest",
                "offer": {"type": "offer", "sdp": "v=0"},
                "reconnect": True,
                "attemptId": attempt,
            },
            {"to": "sid-guest"},
        )
    ]


def test_answers_and_candidates_keep_the_offers_attempt_id():
    attempt = {"page": "a1b2c3", "attempt": 1}
    answer = _relayed("sid-guest", {"target": "sid-host", "answer": {"type": "answer", "sdp": "v=0"}, "attemptId": attempt})
    candidate = _relayed("sid-guest", {"target": "sid-host", "candidate": {"candidate": "c"}, "attemptId": attempt})
    assert answer[0][1]["attemptId"] == attempt
    assert candidate[0][1]["attemptId"] == attempt


def test_a_signal_without_one_is_relayed_as_before():
    sent = _relayed("sid-guest", {"target": "sid-host", "candidate": {"candidate": "c"}})
    assert sent == [
        ("webrtc-signal", {"sender": "sid-guest", "target": "sid-host", "candidate": {"candidate": "c"}}, {"to": "sid-host"})
    ]


def test_a_startup_retry_keeps_its_flag():
    # A page that has started tells a startup retry from a gameplay reconnect
    # only by this flag (specs/peer_connection.qnt, startupRetryIsNotAReconnect).
    attempt = {"page": "a1b2c3", "attempt": 2}
    offer = {"type": "offer", "sdp": "v=0"}
    sent = _relayed(
        "sid-host",
        {"target": "sid-guest", "offer": offer, "reconnect": True, "startupReconnect": True, "attemptId": attempt},
    )
    assert sent == [
        (
            "webrtc-signal",
            {
                "sender": "sid-host",
                "target": "sid-guest",
                "offer": offer,
                "reconnect": True,
                "startupReconnect": True,
                "attemptId": attempt,
            },
            {"to": "sid-guest"},
        )
    ]


def test_keys_the_server_does_not_know_are_dropped():
    sent = _relayed("sid-host", {"target": "sid-guest", "offer": {"type": "offer"}, "reconnect": True, "extra": 1})
    assert sent[0][1]["reconnect"] is True
    assert "extra" not in sent[0][1]


def test_an_attempt_id_too_large_drops_the_signal():
    sent = _relayed("sid-host", {"target": "sid-guest", "candidate": {"candidate": "c"}, "attemptId": {"page": "x" * 70_000}})
    assert sent == []
