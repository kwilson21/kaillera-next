"""Cloudflare TURN credentials (server/src/api/turn.py) and the server-side
ROM-sharing off switch the public deploy relies on."""

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from src.api import turn  # noqa: E402

CF_RESPONSE = {
    "iceServers": [
        {"urls": ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"]},
        {
            "urls": [
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turn:turn.cloudflare.com:53?transport=udp",
                "turns:turn.cloudflare.com:443?transport=tcp",
            ],
            "username": "u",
            "credential": "c",
        },
    ]
}


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("CF_TURN_KEY_ID", "key123")
    monkeypatch.setenv("CF_TURN_API_TOKEN", "tok456")
    turn.reset_cache()
    yield
    turn.reset_cache()


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def test_generates_turn_servers_and_drops_port_53_and_stun():
    seen = []

    def handler(req):
        seen.append(req)
        return httpx.Response(200, json=CF_RESPONSE)

    servers = asyncio.run(turn.ice_servers(_client(handler)))
    assert servers == [
        {
            "urls": [
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turns:turn.cloudflare.com:443?transport=tcp",
            ],
            "username": "u",
            "credential": "c",
        }
    ]
    req = seen[0]
    assert req.url.path == "/v1/turn/keys/key123/credentials/generate-ice-servers"
    assert req.headers["authorization"] == "Bearer tok456"
    assert json.loads(req.content) == {"ttl": turn.TTL_SECONDS}


def test_cached_between_calls():
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(200, json=CF_RESPONSE)

    async def twice():
        async with _client(handler) as c:
            return await turn.ice_servers(c), await turn.ice_servers(c)

    a, b = asyncio.run(twice())
    assert a == b and len(calls) == 1


def test_single_object_response_shape():
    body = {
        "iceServers": {
            "urls": "turn:turn.cloudflare.com:3478",
            "username": "u",
            "credential": "c",
        }
    }
    servers = asyncio.run(
        turn.ice_servers(_client(lambda r: httpx.Response(200, json=body)))
    )
    assert servers == [
        {"urls": ["turn:turn.cloudflare.com:3478"], "username": "u", "credential": "c"}
    ]


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(401, json={"error": "bad"}),
        httpx.Response(200, text="not json"),
        httpx.Response(200, json=[]),
        httpx.Response(
            200, json={"iceServers": [{"urls": 5, "username": "u", "credential": "c"}]}
        ),
    ],
)
def test_failure_returns_empty_and_backs_off(response):
    calls = []

    def handler(req):
        calls.append(req)
        return response

    async def twice():
        async with _client(handler) as c:
            return await turn.ice_servers(c), await turn.ice_servers(c)

    assert asyncio.run(twice()) == ([], [])
    assert len(calls) == 1  # the second call is inside the failure backoff


def test_rotated_credentials_refetch(monkeypatch):
    calls = []

    def handler(req):
        calls.append(req.headers["authorization"])
        return httpx.Response(200, json=CF_RESPONSE)

    async def run():
        async with _client(handler) as c:
            await turn.ice_servers(c)
            monkeypatch.setenv("CF_TURN_API_TOKEN", "rotated")
            await turn.ice_servers(c)

    asyncio.run(run())
    assert calls == ["Bearer tok456", "Bearer rotated"]


def test_unconfigured_makes_no_request(monkeypatch):
    monkeypatch.delenv("CF_TURN_API_TOKEN")

    def handler(req):
        raise AssertionError("no request expected")

    assert not turn.configured()
    assert asyncio.run(turn.ice_servers(_client(handler))) == []


def test_endpoint_falls_back_to_hmac_turn_when_cloudflare_fails(monkeypatch):
    from fastapi.testclient import TestClient

    from src.api import app as appmod
    from src.api.signaling import rooms

    async def no_cf_turn():
        return []

    monkeypatch.setattr(appmod.turn, "ice_servers", no_cf_turn)
    monkeypatch.setattr(appmod, "verify_upload_token", lambda room, token: True)
    monkeypatch.setitem(rooms, "TURNFB", object())
    monkeypatch.setenv("TURN_SECRET", "s")
    monkeypatch.setenv("TURN_SERVERS", "turn:turn.example:3478")
    servers = (
        TestClient(appmod.create_app())
        .get("/ice-servers", params={"room": "TURNFB", "token": "t"})
        .json()
    )
    assert servers[-1]["urls"] == "turn:turn.example:3478" and servers[-1]["credential"]


# ── ROM sharing off switch (server side) ─────────────────────────────────────


@pytest.fixture
def sig(monkeypatch):
    from src.api import signaling

    emitted, relayed = [], []

    async def emit(*a, **kw):
        emitted.append(a)

    async def save_room(*a):
        return None

    async def relay(sid, data, event, keys):
        relayed.append(event)

    room = signaling.Room(
        owner="host", room_name="r", game_id="ssb64", password=None, max_players=4
    )
    monkeypatch.setattr(signaling, "check", lambda sid, event: True)
    monkeypatch.setattr(signaling, "_get_room", lambda sid: ("ROOM1", room))
    monkeypatch.setitem(signaling.rooms, "ROOM1", room)
    for s in ("host", "guest"):
        monkeypatch.setitem(signaling._sid_to_room, s, ("ROOM1", s, False))
    monkeypatch.setattr(signaling.sio, "emit", emit)
    monkeypatch.setattr(signaling.state, "save_room", save_room)
    monkeypatch.setattr(signaling, "_relay_signal", relay)
    monkeypatch.setitem(signaling._sid_host, "host", "play.example")
    monkeypatch.setitem(signaling._sid_host, "guest", "other.example")
    return signaling, room, emitted, relayed


@pytest.mark.parametrize(
    "raw,allowed",
    [
        ("false", False),
        ("0", False),
        (" FALSE ", False),
        ("true", True),
        ("play.example", True),
        ("other.example", False),
    ],
)
def test_rom_sharing_handlers_follow_the_switch(sig, monkeypatch, raw, allowed):
    signaling, room, emitted, relayed = sig
    monkeypatch.setenv("ROM_SHARING_ENABLED", raw)
    err = asyncio.run(signaling.rom_sharing_toggle("host", {"enabled": True}))
    assert (err is None) is allowed
    assert room.rom_sharing is allowed
    assert bool(emitted) is allowed
    asyncio.run(signaling.rom_signal("host", {"target": "guest", "offer": {}}))
    assert relayed == (["rom-signal"] if allowed else [])


def test_restored_room_flag_is_not_advertised_when_off(sig, monkeypatch):
    signaling, room, _, _ = sig
    room.rom_sharing = True  # e.g. restored from Redis
    monkeypatch.setenv("ROM_SHARING_ENABLED", "false")
    assert signaling._players_payload(room)["romSharing"] is False
    monkeypatch.setenv("ROM_SHARING_ENABLED", "true")
    assert signaling._players_payload(room)["romSharing"] is True


def test_guest_on_unlisted_host_can_answer_an_allowed_host(sig, monkeypatch):
    signaling, room, _, relayed = sig
    monkeypatch.setenv("ROM_SHARING_ENABLED", "play.example")
    asyncio.run(signaling.rom_signal("guest", {"target": "host", "answer": {}}))
    assert relayed == []  # host hasn't enabled sharing yet
    assert asyncio.run(signaling.rom_sharing_toggle("host", {"enabled": True})) is None
    asyncio.run(signaling.rom_signal("guest", {"target": "host", "answer": {}}))
    assert relayed == ["rom-signal"]
