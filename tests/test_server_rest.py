"""Tests for server REST endpoints.

Run: pytest tests/test_server_rest.py -v
Uses the shared server_url fixture from conftest.py.
"""

import asyncio
from unittest.mock import AsyncMock

import pytest
import requests


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """REST tests do not need a Playwright browser."""
    yield


@pytest.fixture
def wake_client(monkeypatch):
    from fastapi.testclient import TestClient
    from src import db
    from src.api import app as appmod

    insert = AsyncMock(return_value=1)
    monkeypatch.setattr(db, "insert_client_event", insert)
    monkeypatch.setattr(appmod, "check_ip", lambda ip, event: True)
    return TestClient(appmod.create_app()), insert


def test_wake_event_rejects_oversized_body(wake_client):
    client, insert = wake_client
    response = client.post(
        "/api/wake-event",
        content=b'{"page":"front","elapsed_ms":1,"direct_wake_sent":true}'
        + b" " * 4096,
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 413
    insert.assert_not_awaited()


def test_wake_event_rejects_oversized_content_length_without_reading():
    from fastapi import HTTPException
    from src.api.app import _read_limited_body

    class Request:
        def __init__(self):
            self.headers = {"content-length": "4097"}
            self.stream_calls = 0

        async def stream(self):
            self.stream_calls += 1
            yield b"unread"

    request = Request()
    with pytest.raises(HTTPException) as exc:
        asyncio.run(_read_limited_body(request, 4096))

    assert exc.value.status_code == 413
    assert request.stream_calls == 0


def test_wake_event_rejects_oversized_stream_without_reading_past_crossing_chunk():
    from fastapi import HTTPException
    from src.api.app import _read_limited_body

    class Request:
        def __init__(self):
            self.headers = {}
            self.consumed = 0

        async def stream(self):
            self.consumed += 1
            yield b"x" * 4096
            self.consumed += 1
            yield b"y"
            self.consumed += 1
            raise AssertionError("stream consumed after the body exceeded the cap")

    request = Request()
    with pytest.raises(HTTPException) as exc:
        asyncio.run(_read_limited_body(request, 4096))

    assert exc.value.status_code == 413
    assert request.consumed == 2


def test_wake_event_rate_limit_is_six_per_hour():
    from src.ratelimit import _LIMITS

    assert _LIMITS["wake-event"] == (6, 3600)


def test_wake_event_rate_limit_runs_before_body_validation(wake_client, monkeypatch):
    from src.api import app as appmod

    client, insert = wake_client
    calls = []

    def reject(ip, event):
        calls.append(event)
        return False

    monkeypatch.setattr(appmod, "check_ip", reject)
    response = client.post("/api/wake-event", content=b"not json")
    assert response.status_code == 429
    assert calls == ["wake-event"]
    insert.assert_not_awaited()


def test_wake_event_rejects_elapsed_time_over_one_hour(wake_client):
    client, insert = wake_client
    response = client.post(
        "/api/wake-event",
        json={"page": "front", "elapsed_ms": 3_600_001, "direct_wake_sent": True},
    )
    assert response.status_code == 422
    insert.assert_not_awaited()


def test_health(server_url):
    r = requests.get(f"{server_url}/health", timeout=5)
    assert r.status_code == 200
    data = r.json()
    assert data["status"] in ("ok", "degraded")
    assert "redis" in data
    assert "rooms" in data
    assert "players" in data


def test_wake_event_accepts_only_the_fixed_public_payload(server_url):
    valid = requests.post(
        f"{server_url}/api/wake-event",
        json={"page": "front", "elapsed_ms": 42000, "direct_wake_sent": True},
        timeout=5,
    )
    assert valid.status_code == 204

    invalid = requests.post(
        f"{server_url}/api/wake-event",
        json={
            "page": "front",
            "elapsed_ms": 42000,
            "direct_wake_sent": True,
            "ip": "203.0.113.8",
        },
        timeout=5,
    )
    assert invalid.status_code == 422


def test_room_not_found(server_url):
    r = requests.get(f"{server_url}/room/NONEXIST", timeout=5)
    assert r.status_code == 404
    assert "detail" in r.json()


def test_rom_hashes(server_url):
    """GET /api/rom-hashes returns known ROM hash table."""
    r = requests.get(f"{server_url}/api/rom-hashes", timeout=5)
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, dict)
    assert len(data) >= 1
    for info in data.values():
        assert "game" in info
    assert "max-age" in r.headers.get("Cache-Control", "")
