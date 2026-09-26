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


@pytest.fixture(autouse=True)
def _clear_proxy_warned(monkeypatch):
    # Each test starts with a clean slate so the once-per-reason dedup in
    # _warn_proxy_once doesn't leak state between tests.
    monkeypatch.setattr(ratelimit, "_proxy_warned", {})


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


def test_landing_worker_ip_trusted_only_with_the_secret(monkeypatch):
    # Through the landing Worker, CF-Connecting-IP is the Worker's own
    # address; the visitor's IP arrives in X-KN-Client-IP with the secret.
    monkeypatch.setattr(ratelimit, "_ON_RENDER", True)
    monkeypatch.setattr(ratelimit, "_PROXY_SECRET", "s3cret")
    worker_ip = "2a06:98c0:3600::103"
    worker = {"cf-connecting-ip": worker_ip, "x-kn-client-ip": "5.6.7.8"}
    good = {**worker, "x-kn-proxy-auth": "s3cret"}
    assert ratelimit.extract_ip(request(good)) == "5.6.7.8"
    environ = {"HTTP_X_KN_CLIENT_IP": "5.6.7.8", "HTTP_X_KN_PROXY_AUTH": "s3cret"}
    assert ratelimit.extract_ip(environ) == "5.6.7.8"
    # A wrong or missing secret: ignored, the usual rule applies.
    bad = {**worker, "x-kn-proxy-auth": "guess"}
    assert ratelimit.extract_ip(request(bad)) == worker_ip
    assert ratelimit.extract_ip(request(worker)) == worker_ip
    # No secret configured: never trusted, whatever the request carries.
    monkeypatch.setattr(ratelimit, "_PROXY_SECRET", "")
    empty = {**worker, "x-kn-proxy-auth": ""}
    assert ratelimit.extract_ip(request(empty)) == worker_ip


def test_landing_worker_rejects_non_single_ip_values(monkeypatch):
    # engineio joins duplicate headers with ',' — a visitor sending their own
    # x_kn_client_ip alongside the Worker's would otherwise smuggle a second
    # value through. Only a single valid IP is ever trusted.
    monkeypatch.setattr(ratelimit, "_ON_RENDER", True)
    monkeypatch.setattr(ratelimit, "_PROXY_SECRET", "s3cret")
    worker_ip = "2a06:98c0:3600::103"

    # Comma-joined (duplicate header) value with the right secret: falls
    # back rather than returning the joined string.
    joined = {
        "cf-connecting-ip": worker_ip,
        "x-kn-client-ip": "5.6.7.8,9.9.9.9",
        "x-kn-proxy-auth": "s3cret",
    }
    assert ratelimit.extract_ip(request(joined)) == worker_ip
    environ_joined = {
        "HTTP_CF_CONNECTING_IP": worker_ip,
        "HTTP_X_KN_CLIENT_IP": "5.6.7.8,9.9.9.9",
        "HTTP_X_KN_PROXY_AUTH": "s3cret",
    }
    assert ratelimit.extract_ip(environ_joined) == worker_ip

    # A non-IP value: falls back too.
    not_ip = {
        "cf-connecting-ip": worker_ip,
        "x-kn-client-ip": "not-an-ip",
        "x-kn-proxy-auth": "s3cret",
    }
    assert ratelimit.extract_ip(request(not_ip)) == worker_ip

    # A valid IPv6 value is accepted and normalized.
    v6 = {
        "cf-connecting-ip": worker_ip,
        "x-kn-client-ip": "2001:db8::1",
        "x-kn-proxy-auth": "s3cret",
    }
    assert ratelimit.extract_ip(request(v6)) == "2001:db8::1"


def test_proxy_mismatch_warns_once_per_reason(monkeypatch, caplog):
    # A silent secret mismatch would otherwise merge every visitor into the
    # Worker's single IP without anyone noticing; make sure it's logged, but
    # only once per reason so a flood of bad requests can't spam the log.
    monkeypatch.setattr(ratelimit, "_ON_RENDER", True)
    monkeypatch.setattr(ratelimit, "_PROXY_SECRET", "s3cret")
    monkeypatch.setattr(ratelimit, "_proxy_warned", {})
    worker_ip = "5.5.5.5"
    bad = {
        "cf-connecting-ip": worker_ip,
        "x-kn-client-ip": "5.6.7.8",
        "x-kn-proxy-auth": "guess",
    }
    with caplog.at_level("WARNING", logger=ratelimit.log.name):
        ratelimit.extract_ip(request(bad))
        ratelimit.extract_ip(request(bad))
        ratelimit.extract_ip(request(bad))
    warnings = [r for r in caplog.records if "proxy auth didn't match" in r.message]
    assert len(warnings) == 1
    for r in caplog.records:
        assert "s3cret" not in r.message
        assert "guess" not in r.message


def test_proxy_warns_when_server_secret_is_set_but_worker_sends_nothing(monkeypatch, caplog):
    # KN_PROXY_SECRET is configured here, but the request carries no
    # X-KN-Client-IP at all and the normal rule lands on the Worker's own
    # address range — the landing Worker almost certainly has no
    # PROXY_SECRET of its own, so it's silently folding every visitor into
    # one IP. That must be logged even though no X-KN-Client-IP arrived.
    monkeypatch.setattr(ratelimit, "_ON_RENDER", True)
    monkeypatch.setattr(ratelimit, "_PROXY_SECRET", "s3cret")
    worker_ip = "2a06:98c0:3600::103"
    bare = {"cf-connecting-ip": worker_ip}
    with caplog.at_level("WARNING", logger=ratelimit.log.name):
        assert ratelimit.extract_ip(request(bare)) == worker_ip
    warnings = [r for r in caplog.records if "without X-KN-Client-IP" in r.message]
    assert len(warnings) == 1
    assert "PROXY_SECRET set on the landing Worker" in warnings[0].message


def test_proxy_no_warning_when_worker_address_but_no_server_secret(monkeypatch, caplog):
    # If KN_PROXY_SECRET isn't set here either, the Worker's address is
    # simply the normal (unproxied) behavior — nothing to warn about.
    monkeypatch.setattr(ratelimit, "_ON_RENDER", True)
    monkeypatch.setattr(ratelimit, "_PROXY_SECRET", "")
    worker_ip = "2a06:98c0:3600::103"
    bare = {"cf-connecting-ip": worker_ip}
    with caplog.at_level("WARNING", logger=ratelimit.log.name):
        assert ratelimit.extract_ip(request(bare)) == worker_ip
    assert not [r for r in caplog.records if "without X-KN-Client-IP" in r.message]


def test_proxy_warning_unset_secret_reason(monkeypatch, caplog):
    # The Worker sent X-KN-Client-IP but this server has no KN_PROXY_SECRET
    # configured at all: a distinct reason from a mismatched secret.
    monkeypatch.setattr(ratelimit, "_ON_RENDER", True)
    monkeypatch.setattr(ratelimit, "_PROXY_SECRET", "")
    worker_ip = "5.5.5.5"
    headers = {
        "cf-connecting-ip": worker_ip,
        "x-kn-client-ip": "5.6.7.8",
        "x-kn-proxy-auth": "",
    }
    with caplog.at_level("WARNING", logger=ratelimit.log.name):
        assert ratelimit.extract_ip(request(headers)) == worker_ip
    warnings = [r for r in caplog.records if "KN_PROXY_SECRET is unset" in r.message]
    assert len(warnings) == 1


def test_proxy_warning_refires_after_interval(monkeypatch, caplog):
    monkeypatch.setattr(ratelimit, "_ON_RENDER", True)
    monkeypatch.setattr(ratelimit, "_PROXY_SECRET", "s3cret")
    worker_ip = "5.5.5.5"
    bad = {
        "cf-connecting-ip": worker_ip,
        "x-kn-client-ip": "5.6.7.8",
        "x-kn-proxy-auth": "guess",
    }
    clock = [1_000.0]
    monkeypatch.setattr(ratelimit.time, "monotonic", lambda: clock[0])
    with caplog.at_level("WARNING", logger=ratelimit.log.name):
        ratelimit.extract_ip(request(bad))
        clock[0] += ratelimit._PROXY_WARN_INTERVAL - 1
        ratelimit.extract_ip(request(bad))  # too soon: no second warning
        clock[0] += 2
        ratelimit.extract_ip(request(bad))  # past the interval: warns again
    warnings = [r for r in caplog.records if "proxy auth didn't match" in r.message]
    assert len(warnings) == 2


def test_proxy_warning_fires_first_time_even_near_zero_monotonic(monkeypatch, caplog):
    # time.monotonic() can start near 0 right after process boot; the "last
    # warned" check must not mistake that for "already warned".
    monkeypatch.setattr(ratelimit, "_ON_RENDER", True)
    monkeypatch.setattr(ratelimit, "_PROXY_SECRET", "s3cret")
    monkeypatch.setattr(ratelimit.time, "monotonic", lambda: 0.05)
    worker_ip = "5.5.5.5"
    bad = {
        "cf-connecting-ip": worker_ip,
        "x-kn-client-ip": "5.6.7.8",
        "x-kn-proxy-auth": "guess",
    }
    with caplog.at_level("WARNING", logger=ratelimit.log.name):
        ratelimit.extract_ip(request(bad))
    warnings = [r for r in caplog.records if "proxy auth didn't match" in r.message]
    assert len(warnings) == 1


def test_engineio_joins_duplicate_headers_but_extract_ip_falls_back(monkeypatch):
    # A visitor who sends their own x_kn_client_ip alongside the Worker's
    # X-KN-Client-IP would have engineio's real ASGI translation join them
    # with ',' (both header spellings normalize to the same WSGI-style key).
    # Build the environ the same way Socket.IO does, from a raw ASGI scope,
    # rather than constructing the joined string by hand.
    from engineio.async_drivers.asgi import translate_request

    async def go():
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/socket.io/",
            "query_string": b"EIO=4&transport=polling",
            "headers": [
                (b"cf-connecting-ip", b"2a06:98c0:3600::103"),
                (b"x-kn-client-ip", b"5.6.7.8"),
                (b"x-kn-proxy-auth", b"s3cret"),
                # The visitor's own duplicate, same normalized WSGI key.
                (b"x_kn_client_ip", b"9.9.9.9"),
            ],
        }

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(_message):
            pass

        return await translate_request(scope, receive, send)

    environ = asyncio.run(go())
    assert environ["HTTP_X_KN_CLIENT_IP"] == "5.6.7.8,9.9.9.9"

    monkeypatch.setattr(ratelimit, "_PROXY_SECRET", "s3cret")
    monkeypatch.setattr(ratelimit, "_ON_RENDER", True)
    assert ratelimit.extract_ip(environ) == "2a06:98c0:3600::103"
