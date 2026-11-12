"""The page lifecycle machine's reports must reach the database.

The machine in web/src/session.ts observes before it decides: it reports
`session-disagree` and `late-join-stranded` as client events, and it takes
over from play.js only once production shows no disagreement. The server
accepts a fixed list of event types and answers 400 to anything else, so a
report type missing from that list is dropped without a trace, and "no
reports" would be read as "no disagreement".

Run: cd server && uv run pytest ../tests/test_session_reports.py -v
"""

import re
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

SESSION_TS = Path(__file__).parent.parent / "web" / "src" / "session.ts"


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


def _report_types() -> list[str]:
    """The `type` literals of the SessionReport union in session.ts."""
    source = SESSION_TS.read_text()
    union = source[source.index("export type SessionReport") : source.index("/** Where reports go.")]
    return re.findall(r"readonly type: '([^']+)'", union)


def test_the_union_is_found():
    assert set(_report_types()) >= {"session-disagree", "late-join-stranded"}


@pytest.mark.parametrize("report_type", _report_types())
def test_server_stores_every_report_type(report_type, monkeypatch):
    import src.db as db
    from src.api import app as appmod
    from src.api.signaling import make_upload_token

    stored = AsyncMock(return_value=1)
    monkeypatch.setattr(appmod, "check_ip", lambda ip, event: True)
    monkeypatch.setitem(appmod.rooms, "ROOM1", object())  # client events need a live room
    monkeypatch.setattr(db, "insert_client_event", stored)
    client = TestClient(appmod.create_app())

    response = client.post(
        f"/api/client-event?room=ROOM1&token={make_upload_token('ROOM1')}",
        json={"type": report_type, "msg": "", "meta": {"matchId": None}},
    )

    assert response.status_code == 200, response.text
    assert stored.await_args.args[0]["type"] == report_type
