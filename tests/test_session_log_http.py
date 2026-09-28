"""POST /api/session-log (the HTTP fallback) only accepts registered, open matches.

Run: cd server && uv run --extra dev pytest ../tests/test_session_log_http.py -q
"""

from unittest.mock import AsyncMock

import pytest


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


@pytest.fixture
def client(monkeypatch):
    from fastapi.testclient import TestClient

    import src.db as db
    from src.api import app as appmod

    monkeypatch.setattr(appmod, "check_ip", lambda ip, event: True)
    append = AsyncMock(return_value=7)
    accepts = AsyncMock(return_value=True)
    monkeypatch.setattr(db, "append_session_log", append)
    monkeypatch.setattr(db, "match_accepts_uploads", accepts)
    return TestClient(appmod.create_app()), append, accepts


def _post(client, body, room="ROOM1"):
    from src.api.signaling import make_upload_token

    return client.post(f"/api/session-log?room={room}&token={make_upload_token(room)}", json=body)


BODY = {"matchId": "m1", "slot": 1, "playerName": "P", "mode": "rollback", "entries": [{"seq": 0, "msg": "a"}]}


def test_registered_open_match_is_stored(client):
    http, append, accepts = client
    r = _post(http, BODY)
    assert r.status_code == 200 and r.json()["lastSeq"] == 7
    accepts.assert_awaited_once_with("m1", "ROOM1")
    assert append.await_args.args[0]["slot"] == 1


def test_unknown_or_closed_match_is_refused(client):
    http, append, accepts = client
    accepts.return_value = False
    r = _post(http, BODY)
    assert r.status_code == 403
    append.assert_not_awaited()


@pytest.mark.parametrize("slot", [None, "1; DROP", "x", -1, 4, 1.5])
def test_slot_must_be_an_integer_0_to_3(client, slot):
    http, append, _ = client
    r = _post(http, {**BODY, "slot": slot})
    assert r.status_code == 400
    append.assert_not_awaited()
