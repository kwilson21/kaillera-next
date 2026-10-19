"""POST /api/session-log (the HTTP fallback) only accepts registered, open matches;
GET /admin/api/input-audit diffs the input history those logs carry.

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
    append = AsyncMock(return_value={"lastSeq": 7, "auditLastSeq": -1})
    accepts = AsyncMock(return_value=True)
    monkeypatch.setattr(db, "append_session_flush", append)
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


@pytest.mark.parametrize("match_id", [["m1"], {"a": 1}, 5, "x" * 65])
def test_match_id_must_be_a_short_string(client, match_id):
    """It becomes a cache key: an unbounded or unhashable value is refused."""
    http, append, accepts = client
    r = _post(http, {**BODY, "matchId": match_id})
    assert r.status_code == 400
    accepts.assert_not_awaited()
    append.assert_not_awaited()


def test_live_match_in_this_room_is_accepted_without_a_db_check(client, monkeypatch):
    """Matches running across a deploy, or whose registration failed, have no
    match_retention row; the room's live match id is enough."""
    from types import SimpleNamespace

    from src.api import app as appmod

    http, append, accepts = client
    accepts.return_value = False
    monkeypatch.setitem(appmod.rooms, "ROOM1", SimpleNamespace(match_id="m1"))
    r = _post(http, BODY)
    assert r.status_code == 200
    accepts.assert_not_awaited()


# ── GET /admin/api/input-audit/{match_id} ─────────────────────────────────────


@pytest.fixture
def audit_client(monkeypatch):
    from fastapi.testclient import TestClient

    import src.db as db
    from src.api import app as appmod

    monkeypatch.setattr(appmod, "check_ip", lambda ip, event: True)
    monkeypatch.setenv("ADMIN_KEY", "k")
    query = AsyncMock()
    monkeypatch.setattr(db, "query", query)
    # No streamed records: each peer's audit comes from context.inputAudit.
    monkeypatch.setattr(db, "get_input_audit", AsyncMock(return_value=[]))
    return TestClient(appmod.create_app()), query


def _rec(f, b=0, lx=0):
    return {"f": f, "b": b, "lx": lx, "ly": 0, "cx": 0, "cy": 0}


# Host (slot 0) input changes, as the host recorded them.
HOST_LOCAL = [_rec(0), _rec(104, lx=-70), _rec(120), _rec(130, b=16), _rec(140)]
# Guest (slot 1) changes; the host received them in order.
GUEST_LOCAL = [_rec(0), _rec(200, b=1), _rec(210)]


def _audit(query, host_remote_of_guest, guest_remote_of_host):
    import json

    query.return_value = [
        {
            "slot": 0,
            "player_name": "host",
            "context": json.dumps({"inputAudit": {"local": HOST_LOCAL, "remote": {"1": host_remote_of_guest}}}),
        },
        {
            "slot": 1,
            "player_name": "guest",
            "context": json.dumps({"inputAudit": {"local": GUEST_LOCAL, "remote": {"0": guest_remote_of_host}}}),
        },
    ]


def _diff(http, sender, receiver):
    r = http.get("/admin/api/input-audit/m1", headers={"X-Admin-Key": "k"})
    assert r.status_code == 200
    return next(d for d in r.json()["diffs"] if d["sender_slot"] == sender and d["receiver_slot"] == receiver)


def test_input_audit_ignores_a_late_arriving_packet(audit_client):
    """The guest got frame 103's packet after 104's, so its arrival-order
    stream has a stale change back to lx 0 and then lx -70 again. The inputs
    applied were the same; the verdict must say so."""
    http, query = audit_client
    late = [_rec(0), _rec(104, lx=-70), _rec(103), _rec(105, lx=-70), _rec(120), _rec(130, b=16), _rec(140)]
    _audit(query, GUEST_LOCAL, late)
    d = _diff(http, 0, 1)
    assert d["verdict"] == "IDENTICAL"
    assert d["sender_entries"] == d["receiver_entries"] == d["compared"] == len(HOST_LOCAL)
    assert d["first_mismatches"] == [] and d["late_matches"] == 0
    assert _diff(http, 1, 0)["verdict"] == "IDENTICAL"


def test_input_audit_accepts_a_change_frame_overtaken_by_a_later_packet(audit_client):
    """Frame 105's packet (same lx -70) beat frame 104's, so the client dropped
    104 as a repeat and recorded the change at 105. Still within the sender's
    lx -70 run, so it matches, and is counted as late."""
    http, query = audit_client
    overtaken = [_rec(0), _rec(105, lx=-70), _rec(120), _rec(130, b=16), _rec(140)]
    _audit(query, GUEST_LOCAL, overtaken)
    d = _diff(http, 0, 1)
    assert d["verdict"] == "IDENTICAL"
    assert d["mismatch_count"] == 0 and d["late_matches"] == 1


@pytest.mark.parametrize(
    "frame",
    [103, 120],
    ids=["before-the-sender-changed", "after-the-sender-changed-again"],
)
def test_input_audit_reports_a_change_outside_the_senders_run(audit_client, frame):
    """The host held lx -70 for frames 104-119; the guest receiving it at a
    frame outside that run is a real divergence."""
    http, query = audit_client
    shifted = [_rec(0), _rec(frame, lx=-70), _rec(121), _rec(130, b=16), _rec(140)]
    _audit(query, GUEST_LOCAL, shifted)
    d = _diff(http, 0, 1)
    assert d["verdict"] == "MISMATCH"
    assert d["mismatch_count"] == 1
    m = d["first_mismatches"][0]
    assert m["index"] == 1 and m["sender"]["f"] == 104 and m["receiver"]["f"] == frame


def test_input_audit_still_reports_a_different_input(audit_client):
    """Normalizing arrival order must not hide an input that really differs,
    even when a late packet is also in the stream."""
    http, query = audit_client
    wrong = [_rec(0), _rec(104, lx=-70), _rec(103), _rec(105, lx=-70), _rec(120), _rec(130, b=32), _rec(140)]
    _audit(query, GUEST_LOCAL, wrong)
    d = _diff(http, 0, 1)
    assert d["verdict"] == "MISMATCH"
    assert d["mismatch_count"] == 1
    m = d["first_mismatches"][0]
    assert m["index"] == 3 and m["sender"]["b"] == 16 and m["receiver"]["b"] == 32
    assert _diff(http, 1, 0)["verdict"] == "IDENTICAL"


def test_input_audit_reports_a_missing_tail_as_partial(audit_client):
    http, query = audit_client
    _audit(query, GUEST_LOCAL, HOST_LOCAL[:3])
    d = _diff(http, 0, 1)
    assert d["verdict"] == "PARTIAL"
    assert (d["sender_entries"], d["receiver_entries"], d["compared"]) == (5, 3, 3)


def test_admin_input_audit_is_assembled_from_streamed_records(client, monkeypatch):
    import src.db as db

    http, _append, _accepts = client
    monkeypatch.setenv("ADMIN_KEY", "k")

    def rec(seq, s, f):
        return {"seq": seq, "s": s, "f": f, "b": 0, "lx": f, "ly": 0, "cx": 0, "cy": 0}

    records = {0: [rec(0, "L", 1), rec(1, 1, 1)], 1: [rec(0, "L", 1), rec(1, 0, 1)]}
    rows = [{"slot": 0, "player_name": "A", "context": "{}"}, {"slot": 1, "player_name": "B", "context": "{}"}]
    monkeypatch.setattr(db, "query", AsyncMock(return_value=rows))
    monkeypatch.setattr(db, "get_input_audit", AsyncMock(side_effect=lambda match_id, slot: records[slot]))

    r = http.get("/admin/api/input-audit/m1", headers={"X-Admin-Key": "k"})
    assert r.status_code == 200
    assert {d["verdict"] for d in r.json()["diffs"]} == {"IDENTICAL"}


def test_admin_input_audit_compares_trimmed_histories_from_the_later_start(client, monkeypatch):
    import src.db as db

    http, _append, _accepts = client
    monkeypatch.setenv("ADMIN_KEY", "k")

    def rec(seq, s, f):
        return {"seq": seq, "s": s, "f": f, "b": 0, "lx": f, "ly": 0, "cx": 0, "cy": 0}

    # Slot 1's oldest chunk was dropped by the cap: its copy of slot 0's
    # inputs starts at frame 5, slot 0's own record at frame 1.
    records = {
        0: [rec(0, "L", 1), rec(1, "L", 5), rec(2, "L", 9), rec(3, 1, 5), rec(4, 1, 9)],
        1: [rec(10, 0, 5), rec(11, 0, 9), rec(12, "L", 5), rec(13, "L", 9)],
    }
    rows = [{"slot": 0, "player_name": "A", "context": "{}"}, {"slot": 1, "player_name": "B", "context": "{}"}]
    monkeypatch.setattr(db, "query", AsyncMock(return_value=rows))
    monkeypatch.setattr(db, "get_input_audit", AsyncMock(side_effect=lambda match_id, slot: records[slot]))

    r = http.get("/admin/api/input-audit/m1", headers={"X-Admin-Key": "k"})
    assert r.status_code == 200
    diffs = {(d["sender_slot"], d["receiver_slot"]): d for d in r.json()["diffs"]}
    assert diffs[(0, 1)]["verdict"] == "IDENTICAL"
    assert diffs[(0, 1)]["from_frame"] == 5
    assert diffs[(0, 1)]["compared"] == 2
    assert diffs[(1, 0)]["verdict"] == "IDENTICAL"


def test_admin_input_audit_keeps_the_senders_run_at_a_trimmed_start(client, monkeypatch):
    import src.db as db

    http, _append, _accepts = client
    monkeypatch.setenv("ADMIN_KEY", "k")

    def rec(seq, s, f, lx):
        return {"seq": seq, "s": s, "f": f, "b": 0, "lx": lx, "ly": 0, "cx": 0, "cy": 0}

    # Slot 1's capped copy of slot 0's inputs starts at frame 6: frame 5's
    # packet (the change to lx 5) arrived after frame 6's, so the change was
    # recorded at 6. Slot 0's own change at 5 must stay in the comparison.
    records = {
        0: [rec(0, "L", 1, 1), rec(1, "L", 5, 5), rec(2, "L", 9, 9), rec(3, 1, 6, 6)],
        1: [rec(10, 0, 6, 5), rec(11, 0, 9, 9), rec(12, "L", 6, 6)],
    }
    rows = [{"slot": 0, "player_name": "A", "context": "{}"}, {"slot": 1, "player_name": "B", "context": "{}"}]
    monkeypatch.setattr(db, "query", AsyncMock(return_value=rows))
    monkeypatch.setattr(db, "get_input_audit", AsyncMock(side_effect=lambda match_id, slot: records[slot]))

    r = http.get("/admin/api/input-audit/m1", headers={"X-Admin-Key": "k"})
    assert r.status_code == 200
    d = next(d for d in r.json()["diffs"] if (d["sender_slot"], d["receiver_slot"]) == (0, 1))
    assert d["verdict"] == "IDENTICAL"
    assert (d["from_frame"], d["compared"], d["late_matches"]) == (6, 2, 1)


def test_admin_input_audit_tolerates_non_integer_frames(client, monkeypatch):
    import src.db as db

    http, _append, _accepts = client
    monkeypatch.setenv("ADMIN_KEY", "k")
    bad = {"seq": 0, "s": "L", "f": "5", "b": 0, "lx": 0, "ly": 0, "cx": 0, "cy": 0}
    good = {"seq": 0, "s": 0, "f": 3, "b": 0, "lx": 0, "ly": 0, "cx": 0, "cy": 0}
    records = {0: [bad], 1: [good]}
    rows = [{"slot": 0, "player_name": "A", "context": "{}"}, {"slot": 1, "player_name": "B", "context": "{}"}]
    monkeypatch.setattr(db, "query", AsyncMock(return_value=rows))
    monkeypatch.setattr(db, "get_input_audit", AsyncMock(side_effect=lambda match_id, slot: records[slot]))

    r = http.get("/admin/api/input-audit/m1", headers={"X-Admin-Key": "k"})
    assert r.status_code == 200
