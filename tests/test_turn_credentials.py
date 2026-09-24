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
            "urls": ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"],
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
    body = {"iceServers": {"urls": "turn:turn.cloudflare.com:3478", "username": "u", "credential": "c"}}
    servers = asyncio.run(turn.ice_servers(_client(lambda r: httpx.Response(200, json=body))))
    assert servers == [{"urls": ["turn:turn.cloudflare.com:3478"], "username": "u", "credential": "c"}]


@pytest.mark.parametrize(
    "response",
    [httpx.Response(401, json={"error": "bad"}), httpx.Response(200, text="not json"), httpx.Response(200, json=[])],
)
def test_failure_returns_empty_and_is_not_cached(response):
    assert asyncio.run(turn.ice_servers(_client(lambda r: response))) == []
    assert turn._cache is None


def test_unconfigured_makes_no_request(monkeypatch):
    monkeypatch.delenv("CF_TURN_API_TOKEN")

    def handler(req):
        raise AssertionError("no request expected")

    assert not turn.configured()
    assert asyncio.run(turn.ice_servers(_client(handler))) == []


def test_rom_sharing_off_switch(monkeypatch):
    from src.api import signaling

    for val, off in [("false", True), ("0", True), (" FALSE ", True), ("true", False), ("a.com", False)]:
        monkeypatch.setenv("ROM_SHARING_ENABLED", val)
        assert signaling._rom_sharing_disabled() is off, val
    monkeypatch.delenv("ROM_SHARING_ENABLED")
    assert signaling._rom_sharing_disabled() is False
