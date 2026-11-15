"""The page lifecycle machine's reports must reach the database.

The machine in web/src/session.ts reports `late-join-stranded`, and the
observers beside it report disagreements, as client events. The server
accepts a fixed list of event types and answers 400 to anything else, so a
report type missing from that list is dropped without a trace, and "no
reports" would be read as "nothing to report".

Run: cd server && uv run pytest ../tests/test_session_reports.py -v
"""

import re
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

SESSION_TS = Path(__file__).parent.parent / "web" / "src" / "session.ts"
SOCKET_BOUNDARY_TS = SESSION_TS.parent / "socket-boundary.ts"


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


def _report_types() -> list[str]:
    """The `type` literals of the SessionReport union in session.ts, and of
    the socket boundary's ProtocolReport."""
    source = SESSION_TS.read_text()
    union = source[source.index("export type SessionReport") : source.index("/** Where reports go.")]
    boundary = SOCKET_BOUNDARY_TS.read_text()
    report = boundary[boundary.index("export type ProtocolReport") :]
    report = report[: report.index("};")]
    observe = (SESSION_TS.parent / "play" / "observe.ts").read_text()
    disagree = observe[observe.index("export type DisagreeReport") :]
    disagree = disagree[: disagree.index("};")]
    streaming = (SESSION_TS.parent / "streaming" / "observe.ts").read_text()
    streaming = streaming[streaming.index("export type StreamingDisagreeReport") :]
    streaming = streaming[: streaming.index("};")]
    return re.findall(r"readonly type: '([^']+)'", union + report + disagree + streaming)


def test_the_union_is_found():
    assert set(_report_types()) >= {"late-join-stranded", "protocol-mismatch", "play-disagree", "streaming-disagree"}


# The engine reports with createComparer too, under its own types (the peer
# mesh's decisions against web/src/peer-signaling.ts, the resync request
# rules against web/src/resync-request.ts, in netplay-rollback.js).
ENGINE_REPORT_TYPES = ["mesh-disagree", "resync-disagree"]

# The play page sends how often each observed decision ran when it closes
# (web/src/play/observe.ts counts, web/static/play.js sends).
PAGE_SUMMARY_TYPES = ["play-observed"]


def test_the_play_page_sends_its_observed_counts():
    play = (SESSION_TS.parents[1] / "static" / "play.js").read_text()
    assert "KNEvent('play-observed', '', { counts: observed });" in play
    # Sent before the page asks to leave: a room its last player leaves is
    # deleted, and the server takes client events only for a live room.
    leave = play[play.index("const leaveGame = () => {") :]
    assert leave.index("_sendObservedCounts();") < leave.index("socket.emit('leave-room'")


def test_the_engine_sends_the_type_it_is_allowed():
    engine = (SESSION_TS.parents[1] / "static" / "netplay-rollback.js").read_text()
    for report_type in ENGINE_REPORT_TYPES:
        assert f"window.KNEvent?.('{report_type}'," in engine


@pytest.mark.parametrize("report_type", _report_types() + ENGINE_REPORT_TYPES + PAGE_SUMMARY_TYPES)
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
