"""Socket.IO origin check and client-IP extraction for the public deploys.

configure_cors() used to set an attribute nothing reads, leaving Engine.IO's
origin check off: any website could open a socket. These tests go through a
real Engine.IO handshake (polling), so they fail if the check stops happening
however it's configured.

    pytest tests/test_socket_cors.py --noconftest -p no:playwright
"""

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
import socketio

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from src import ratelimit  # noqa: E402
from src.api import signaling  # noqa: E402

HANDSHAKE = "/socket.io/?EIO=4&transport=polling"


@pytest.fixture
def allowed():
    before = signaling.sio.eio.cors_allowed_origins
    signaling.configure_cors(["https://play.example", "https://x.onrender.com"])
    yield
    signaling.sio.eio.cors_allowed_origins = before


def handshake(origin: str | None) -> httpx.Response:
    async def go():
        transport = httpx.ASGITransport(app=socketio.ASGIApp(signaling.sio))
        async with httpx.AsyncClient(
            transport=transport, base_url="http://testserver"
        ) as c:
            headers = {"Origin": origin} if origin else {}
            return await c.get(HANDSHAKE, headers=headers)

    return asyncio.run(go())


@pytest.mark.parametrize("origin", ["https://play.example", "https://x.onrender.com"])
def test_allowed_origin_handshake_succeeds(allowed, origin):
    r = handshake(origin)
    assert r.status_code == 200 and r.text.startswith("0{")


def test_unlisted_origin_handshake_is_refused(allowed):
    r = handshake("https://evil.example")
    assert r.status_code == 400


def test_no_origin_header_is_not_a_browser_and_connects(allowed):
    assert handshake(None).status_code == 200


# ── Client IP ────────────────────────────────────────────────────────────────


def request(headers: dict, peer: str = "10.0.0.1"):
    return SimpleNamespace(headers=headers, client=SimpleNamespace(host=peer))


def test_render_uses_cloudflare_set_headers_never_forwarded_for(monkeypatch):
    monkeypatch.setattr(ratelimit, "_ON_RENDER", True)
    spoof = {"x-forwarded-for": "1.2.3.4, 9.9.9.9"}
    assert (
        ratelimit.extract_ip(request({**spoof, "true-client-ip": "5.6.7.8"}))
        == "5.6.7.8"
    )
    assert (
        ratelimit.extract_ip(request({**spoof, "cf-connecting-ip": "5.6.7.8"}))
        == "5.6.7.8"
    )
    assert ratelimit.extract_ip(request(spoof)) == "unknown"
    environ = {
        "HTTP_X_FORWARDED_FOR": "1.2.3.4",
        "HTTP_TRUE_CLIENT_IP": "5.6.7.8",
        "REMOTE_ADDR": "10.0.0.1",
    }
    assert ratelimit.extract_ip(environ) == "5.6.7.8"


def test_default_order_unchanged(monkeypatch):
    monkeypatch.setattr(ratelimit, "_ON_RENDER", False)
    assert (
        ratelimit.extract_ip(
            request({"cf-connecting-ip": "5.6.7.8", "x-forwarded-for": "1.2.3.4"})
        )
        == "5.6.7.8"
    )
    assert (
        ratelimit.extract_ip(request({"x-forwarded-for": "1.2.3.4, 9.9.9.9"}))
        == "1.2.3.4"
    )
    assert ratelimit.extract_ip(request({})) == "10.0.0.1"
    assert ratelimit.extract_ip({"REMOTE_ADDR": "10.0.0.2"}) == "10.0.0.2"
