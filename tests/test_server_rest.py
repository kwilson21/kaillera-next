"""Tests for server REST endpoints.

Run: pytest tests/test_server_rest.py -v
Uses the shared server_url fixture from conftest.py.
"""

import asyncio
import json
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


@pytest.fixture
def upload_event_client(monkeypatch):
    from types import SimpleNamespace

    from fastapi.testclient import TestClient

    from src import db
    from src.api import app as appmod

    monkeypatch.setattr(appmod, "check_ip", lambda ip, event: True)
    monkeypatch.setattr(appmod, "verify_upload_token", lambda room, token: True)
    monkeypatch.setitem(appmod.rooms, "ROOM1", SimpleNamespace(match_id="other-match"))
    monkeypatch.setattr(db, "match_accepts_uploads", AsyncMock(return_value=True))
    monkeypatch.setattr(db, "session_log_busy", lambda match_id, slot: False)
    insert = AsyncMock(return_value=12)
    monkeypatch.setattr(db, "insert_client_event", insert)
    append = AsyncMock(return_value={"accepted": 0})
    monkeypatch.setattr(db, "append_session_flush", append)

    client = TestClient(appmod.create_app())
    return client, insert, append


@pytest.fixture
def feedback_client(monkeypatch):
    from fastapi.testclient import TestClient

    from src import db
    from src.api import app as appmod

    insert = AsyncMock(return_value=23)
    monkeypatch.setattr(db, "insert_feedback", insert)
    monkeypatch.setattr(db, "find_recent_match", AsyncMock(return_value=None))
    monkeypatch.setattr(appmod, "check_ip", lambda ip, event: True)
    return TestClient(appmod.create_app()), insert


def _post_chunked_body(app, path, cap):
    """Post a chunked body and verify the endpoint stops after crossing its cap."""
    import httpx

    chunks_consumed = 0
    request_headers = []

    async def body_chunks():
        nonlocal chunks_consumed
        chunks_consumed += 1
        yield b"x" * cap
        chunks_consumed += 1
        yield b"y"
        chunks_consumed += 1
        raise AssertionError("request body was read after exceeding the cap")

    async def send_request():
        async def record_headers(scope, receive, send):
            request_headers.extend(scope.get("headers", []))
            await app(scope, receive, send)

        transport = httpx.ASGITransport(app=record_headers)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            return await client.post(path, content=body_chunks())

    response = asyncio.run(send_request())
    assert not any(name == b"content-length" for name, _ in request_headers)
    assert chunks_consumed == 2
    return response


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


def test_wake_event_saves_wake_time_and_metadata(wake_client):
    client, insert = wake_client
    response = client.post(
        "/api/wake-event",
        json={"page": "front", "elapsed_ms": 42000, "direct_wake_sent": True},
    )

    assert response.status_code == 204
    insert.assert_awaited_once()
    saved_event = insert.await_args.args[0]
    assert saved_event["type"] == "wake-time"
    assert json.loads(saved_event["meta"]) == {
        "page": "front",
        "elapsed_ms": 42000,
        "direct_wake_sent": True,
    }


def test_client_event_rejects_wake_time(wake_client, monkeypatch):
    from src.api import app as appmod

    client, insert = wake_client
    monkeypatch.setitem(appmod.rooms, "ROOM1", object())
    monkeypatch.setattr(appmod, "verify_upload_token", lambda room, token: True)
    response = client.post(
        "/api/client-event?room=ROOM1&token=valid",
        json={"type": "wake-time", "msg": "forged", "meta": {"elapsed_ms": 1}},
    )

    assert response.status_code == 400
    insert.assert_not_awaited()


def test_client_event_rejects_oversized_content_length(upload_event_client):
    client, _, _ = upload_event_client
    response = client.post(
        "/api/client-event?room=ROOM1&token=valid",
        content=b" " * (4 * 1024 + 1),
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Event too large"}


def test_client_event_stops_reading_chunked_body_at_cap(upload_event_client):
    client, _, _ = upload_event_client
    response = _post_chunked_body(
        client.app,
        "/api/client-event?room=ROOM1&token=valid",
        4 * 1024,
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Event too large"}


def test_client_event_accepts_valid_request(upload_event_client):
    client, insert, _ = upload_event_client
    response = client.post(
        "/api/client-event?room=ROOM1&token=valid",
        json={"type": "webrtc-fail", "msg": "failed", "meta": {}},
    )

    assert response.status_code == 200
    assert response.json() == {"status": "saved", "id": 12}
    insert.assert_awaited_once()


def test_session_log_rejects_oversized_content_length(upload_event_client):
    client, _, append = upload_event_client
    response = client.post(
        "/api/session-log?room=ROOM1&token=valid",
        content=b" " * (2 * 1024 * 1024 + 1),
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Payload too large"}
    append.assert_not_awaited()


def test_session_log_stops_reading_chunked_body_at_cap(upload_event_client):
    client, _, append = upload_event_client
    response = _post_chunked_body(
        client.app,
        "/api/session-log?room=ROOM1&token=valid",
        2 * 1024 * 1024,
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Payload too large"}
    append.assert_not_awaited()


def test_session_log_accepts_valid_request(upload_event_client):
    client, _, append = upload_event_client
    response = client.post(
        "/api/session-log?room=ROOM1&token=valid",
        json={"matchId": "match-1", "slot": 0, "entries": []},
    )

    assert response.status_code == 200
    assert response.json() == {"status": "saved", "accepted": 0}
    append.assert_awaited_once()


def test_feedback_rejects_oversized_content_length(feedback_client):
    client, insert = feedback_client
    response = client.post(
        "/api/feedback",
        content=b" " * (64 * 1024 + 1),
        headers={"content-type": "application/json"},
    )

    assert response.status_code == 413
    assert response.json() == {"detail": "Payload too large"}
    insert.assert_not_awaited()


def test_feedback_stops_reading_chunked_body_at_cap(feedback_client):
    client, insert = feedback_client
    response = _post_chunked_body(client.app, "/api/feedback", 64 * 1024)

    assert response.status_code == 413
    assert response.json() == {"detail": "Payload too large"}
    insert.assert_not_awaited()


def test_feedback_accepts_maximum_form_payload(feedback_client):
    client, insert = feedback_client
    body = {
        "category": "bug",
        "message": "m" * 2000,
        "email": "e" * 249 + "@x.io",
        "company_fax": "",
        "page": "g" * 20,
        "context": {"metadata": "c" * 4080},
    }
    assert len(json.dumps(body["context"])) == 4096
    assert len(json.dumps(body)) < 64 * 1024

    response = client.post("/api/feedback", json=body)

    assert response.status_code == 200
    assert response.json() == {"status": "saved", "id": 23}
    insert.assert_awaited_once()


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
