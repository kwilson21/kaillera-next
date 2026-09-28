"""Retention tiers: which matches get flagged (kept until resolved).

Run: cd server && uv run --extra dev pytest ../tests/test_retention.py -q
"""

import json
from unittest.mock import AsyncMock

import pytest
from db_test_support import FAKE_TOKEN, FakeD1, run_async


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


def _e(msg, slot=0, f=100):
    return {"slot": slot, "f": f, "msg": msg}


# ── classify_entries ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("msg", "signal"),
    [
        ("REPLAY-NORUN f=10 rbFrame=8", "REPLAY-NORUN"),
        ("RB-INVARIANT-VIOLATION kind=x", "RB-INVARIANT-VIOLATION"),
        ("FATAL-RING-STALE f=10 ring[3]=7", "FATAL-RING-STALE"),
        ("RB-LIVE-MISMATCH f=10 ring=0x1 live=0x2", "RB-LIVE-MISMATCH"),
        ("TICK-STUCK severity=warn f=10 stuckMs=5000", "TICK-STUCK"),
        ("RB-INPUT-STALL-TIMEOUT f=10 apply=9 slot=1", "RB-INPUT-STALL-TIMEOUT"),
        ("PEER-PHANTOM slot=2 reason=gone", "PEER-PHANTOM"),
        ("LOCAL-FREEZE f=10 gap=900ms", "LOCAL-FREEZE"),
        ("RB-CHECK f=10 MISMATCH peer=0x1 local=0x2 lastGood=5", "RB-CHECK-MISMATCH"),
    ],
)
def test_each_signal_flags(msg, signal):
    from src.retention import classify_entries

    reasons = classify_entries([_e("TICK f=1"), _e(msg, slot=1, f=42)])
    assert reasons == [{"signal": signal, "count": 1, "slot": 1, "first_f": 42}]


@pytest.mark.parametrize(
    "msg",
    [
        "RB-CHECK f=10 STALE (frame not in ring) peer=0x1",  # not a desync
        "VISUAL-FREEZE failed count=1 Error: x",  # the detector failing, not a freeze
        "note: TICK-STUCK mentioned mid-message",  # tag must be the first word
        "INPUT-OOR slot=1 recvF=5 myF=9",  # one OOR is not a storm
    ],
)
def test_non_signals_do_not_flag(msg):
    from src.retention import classify_entries

    assert classify_entries([_e(msg)]) == []


def test_input_oor_flags_at_20_on_one_slot():
    from src.retention import classify_entries

    nineteen = [_e(f"INPUT-OOR slot=1 recvF={i}", slot=1, f=i) for i in range(19)]
    assert classify_entries(nineteen) == []
    twenty = nineteen + [_e("INPUT-OOR slot=1 recvF=99", slot=1, f=99)]
    assert classify_entries(twenty) == [{"signal": "INPUT-OOR-STORM", "count": 20, "slot": 1, "first_f": 0}]


def test_input_oor_is_counted_per_slot():
    from src.retention import classify_entries

    split = [_e("INPUT-OOR x", slot=i % 2, f=i) for i in range(30)]  # 15 per slot
    assert classify_entries(split) == []


def test_repeats_are_counted_with_the_first_frame():
    from src.retention import classify_entries

    entries = [_e("TICK-STUCK a", f=300), _e("TICK-STUCK b", f=100), _e("TICK-STUCK c", f=200)]
    assert classify_entries(entries) == [{"signal": "TICK-STUCK", "count": 3, "slot": 0, "first_f": 100}]


# ── db.flag_match ────────────────────────────────────────────────────────────


async def _open(tmp_path, d1=False):
    import src.db as db
    from src.blobstore import LocalBlobStore
    from src.dbbackend.d1 import D1Backend

    backend = D1Backend("acct", "db", FAKE_TOKEN, transport=FakeD1().transport()) if d1 else None
    await db.init_db(None if d1 else str(tmp_path / "kn.db"), backend=backend, blobs=LocalBlobStore(tmp_path / "b"))
    return db


async def _row(db, match_id):
    rows = await db.query("SELECT tier, flag_reasons, room FROM match_retention WHERE match_id = ?", (match_id,))
    return {**rows[0], "flag_reasons": json.loads(rows[0]["flag_reasons"])} if rows else None


@pytest.mark.parametrize("d1", [False, True], ids=["sqlite", "d1"])
def test_flag_match_sets_tier_and_merges_idempotently(tmp_path, d1):
    async def scenario():
        db = await _open(tmp_path, d1)
        try:
            await db.register_match("m1", "ROOM1")
            reasons = [{"signal": "TICK-STUCK", "count": 3, "slot": 0, "first_f": 100}]
            await db.flag_match("m1", reasons)
            await db.flag_match("m1", reasons)  # same classification again: no double count
            await db.flag_match("m1", [{"signal": "feedback", "count": 1, "feedback_id": 7}])
            return await _row(db, "m1")
        finally:
            await db.close_db()

    row = run_async(scenario())
    assert row["tier"] == "flagged"
    assert row["flag_reasons"] == [
        {"signal": "TICK-STUCK", "count": 3, "slot": 0, "first_f": 100},
        {"signal": "feedback", "count": 1, "feedback_id": 7},
    ]


def test_flag_match_creates_a_row_for_an_unregistered_match(tmp_path):
    async def scenario():
        db = await _open(tmp_path)
        try:
            await db.flag_match("old", [{"signal": "client-wasm-fail", "count": 1}], room="ROOM9")
            return await _row(db, "old")
        finally:
            await db.close_db()

    row = run_async(scenario())
    assert row["tier"] == "flagged" and row["room"] == "ROOM9"


def test_flag_match_skips_a_match_being_deleted(tmp_path):
    async def scenario():
        db = await _open(tmp_path)
        try:
            await db.register_match("m1", "ROOM1")
            await db.execute_write("UPDATE match_retention SET deleting_at = datetime('now') WHERE match_id = 'm1'", ())
            await db.flag_match("m1", [{"signal": "TICK-STUCK", "count": 1}])
            return await _row(db, "m1")
        finally:
            await db.close_db()

    assert run_async(scenario())["tier"] == "normal"


def test_find_match_for_feedback_uses_the_rooms_recent_match(tmp_path):
    async def scenario():
        db = await _open(tmp_path)
        try:
            await db.register_match("older", "ROOM1")
            await db.execute_write(
                "UPDATE match_retention SET created_at = datetime('now', '-2 hours'), ended_at = datetime('now', '-90 minutes') WHERE match_id = 'older'",
                (),
            )
            await db.register_match("current", "ROOM1")
            return await db.find_recent_match("ROOM1"), await db.find_recent_match("NOPE")
        finally:
            await db.close_db()

    assert run_async(scenario()) == ("current", None)


# ── Hooks ────────────────────────────────────────────────────────────────────


def test_rotation_flags_a_match_whose_logs_show_a_problem(tmp_path, monkeypatch):
    monkeypatch.setenv("PARQUET_DIR", str(tmp_path / "parquet"))

    async def scenario():
        from src import match_rotation

        db = await _open(tmp_path)
        try:
            await db.register_match("m1", "ROOM1")
            base = {"match_id": "m1", "room": "ROOM1", "player_name": "P", "mode": "rollback", "epoch": "e"}
            await db.append_session_log({**base, "slot": 0, "entries": [{"seq": 0, "f": 5, "msg": "TICK f=5"}]})
            await db.append_session_log(
                {**base, "slot": 1, "entries": [{"seq": 0, "f": 9, "msg": "TICK-STUCK severity=warn f=9"}]}
            )
            await db.set_session_ended("m1", None, "game-end")
            await match_rotation.rotate_match("m1")
            return await _row(db, "m1")
        finally:
            await db.close_db()

    row = run_async(scenario())
    assert row["tier"] == "flagged"
    assert row["flag_reasons"] == [{"signal": "TICK-STUCK", "count": 1, "slot": 1, "first_f": 9}]


@pytest.fixture
def http(monkeypatch):
    from fastapi.testclient import TestClient

    import src.db as db
    from src.api import app as appmod

    monkeypatch.setattr(appmod, "check_ip", lambda ip, event: True)
    monkeypatch.setitem(appmod.rooms, "ROOM1", object())  # client events need a live room
    flag = AsyncMock()
    monkeypatch.setattr(db, "flag_match", flag)
    monkeypatch.setattr(db, "insert_client_event", AsyncMock(return_value=1))
    monkeypatch.setattr(db, "insert_feedback", AsyncMock(return_value=11))
    monkeypatch.setattr(db, "find_recent_match", AsyncMock(return_value="m-room"))
    return TestClient(appmod.create_app()), flag


def _event(client, body, room="ROOM1"):
    from src.api.signaling import make_upload_token

    return client.post(f"/api/client-event?room={room}&token={make_upload_token(room)}", json=body)


def test_wasm_crash_event_flags_its_match(http):
    client, flag = http
    r = _event(client, {"type": "wasm-fail", "msg": "RuntimeError: unreachable", "meta": {"match_id": "m1"}, "slot": 1})
    assert r.status_code == 200
    flag.assert_awaited_once()
    match_id, reasons = flag.await_args.args[:2]
    assert match_id == "m1"
    assert reasons[0]["signal"] == "client-wasm-fail" and reasons[0]["slot"] == 1
    assert flag.await_args.kwargs["room"] == "ROOM1"


def test_other_client_events_and_events_without_a_match_do_not_flag(http):
    """'unhandled' carries browser noise (extensions, ResizeObserver) and would
    flag healthy matches; only a WASM abort is a crash signal."""
    client, flag = http
    assert _event(client, {"type": "unhandled", "msg": "Script error.", "meta": {"match_id": "m1"}}).status_code == 200
    assert _event(client, {"type": "webrtc-fail", "msg": "x", "meta": {"match_id": "m1"}}).status_code == 200
    assert _event(client, {"type": "wasm-fail", "msg": "boot timeout", "meta": {}}).status_code == 200
    flag.assert_not_awaited()


def test_feedback_flags_the_match_it_names(http):
    client, flag = http
    r = client.post("/api/feedback", json={"category": "bug", "message": "froze", "context": {"matchId": "m1"}})
    assert r.status_code == 200
    assert flag.await_args.args[0] == "m1"
    assert flag.await_args.args[1] == [{"signal": "feedback", "count": 1, "feedback_id": 11}]


def test_feedback_without_match_id_falls_back_to_the_rooms_recent_match(http):
    client, flag = http
    r = client.post("/api/feedback", json={"category": "bug", "message": "froze", "context": {"roomCode": "ROOM1"}})
    assert r.status_code == 200
    assert flag.await_args.args[0] == "m-room"


def test_non_bug_feedback_without_match_id_does_not_guess_a_match(http):
    client, flag = http
    r = client.post(
        "/api/feedback", json={"category": "feature", "message": "more stages", "context": {"roomCode": "ROOM1"}}
    )
    assert r.status_code == 200
    flag.assert_not_awaited()


def test_feedback_about_nothing_does_not_flag(http):
    client, flag = http
    assert client.post("/api/feedback", json={"category": "feature", "message": "more stages"}).status_code == 200
    flag.assert_not_awaited()


def test_vision_desync_verdict_flags_the_match(monkeypatch):
    import src.db as db
    from src.api import desync_vision

    flag = AsyncMock()
    monkeypatch.setattr(db, "flag_match", flag)
    run_async(desync_vision._flag_if_desynced("m1", 300, {"equal": False, "confidence": "high"}))
    run_async(desync_vision._flag_if_desynced("m2", 300, {"equal": True}))
    flag.assert_awaited_once_with("m1", [{"signal": "vision-desync", "count": 1, "first_f": 300}])


def test_match_is_classified_again_once_its_upload_window_closes(tmp_path, monkeypatch):
    """Rotation first runs when any player leaves; problems logged after that
    must still flag the match."""
    monkeypatch.setenv("PARQUET_DIR", str(tmp_path / "parquet"))

    async def scenario():
        from src import match_rotation

        db = await _open(tmp_path)
        try:
            await db.register_match("m1", "ROOM1")
            base = {"match_id": "m1", "room": "ROOM1", "player_name": "P", "mode": "rollback", "epoch": "e"}
            await db.append_session_log({**base, "slot": 2, "entries": [{"seq": 0, "f": 5, "msg": "TICK f=5"}]})
            await db.set_session_ended("m1", 2, "leave")  # one player leaves: rotation runs on clean logs
            assert await match_rotation.sweep_pending() == 1
            await db.append_session_log(
                {**base, "slot": 0, "entries": [{"seq": 0, "f": 900, "msg": "TICK-STUCK severity=warn f=900"}]}
            )
            await db.set_session_ended("m1", None, "game-end")
            first = (await _row(db, "m1"))["tier"]
            # Upload window closes: ended 31 min ago, rotated before that.
            await db.execute_write(
                "UPDATE match_retention SET ended_at = datetime('now', '-31 minutes') WHERE match_id = 'm1'", ()
            )
            await db.execute_write(
                "UPDATE match_metrics SET rotated_at = datetime('now', '-40 minutes') WHERE match_id = 'm1'", ()
            )
            second_sweep = await match_rotation.sweep_pending()
            third_sweep = await match_rotation.sweep_pending()  # already final: not re-rotated
            return first, second_sweep, third_sweep, await _row(db, "m1")
        finally:
            await db.close_db()

    first, second_sweep, third_sweep, row = run_async(scenario())
    assert first == "normal"
    assert (second_sweep, third_sweep) == (1, 0)
    assert row["tier"] == "flagged"
    assert row["flag_reasons"][0]["signal"] == "TICK-STUCK"


def test_concurrent_flags_keep_every_reason(tmp_path):
    import asyncio

    async def scenario():
        db = await _open(tmp_path)
        try:
            await db.register_match("m1", "ROOM1")
            await asyncio.gather(*(db.flag_match("m1", [{"signal": f"s{i}", "count": 1}]) for i in range(5)))
            return await _row(db, "m1")
        finally:
            await db.close_db()

    row = run_async(scenario())
    assert sorted(r["signal"] for r in row["flag_reasons"]) == ["s0", "s1", "s2", "s3", "s4"]
