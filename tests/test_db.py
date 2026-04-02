"""Tests for the database module.

Run: pytest tests/test_db.py -v
"""

import asyncio
import os

import pytest


@pytest.fixture()
def tmp_db(tmp_path):
    """Provide a temporary DB path and set env var."""
    db_path = str(tmp_path / "test.db")
    os.environ["DB_PATH"] = db_path
    yield db_path
    os.environ.pop("DB_PATH", None)


def test_init_creates_tables(tmp_db):
    """init_db creates feedback and session_logs tables."""
    asyncio.run(_run_init_and_query(tmp_db))


async def _run_init_and_query(tmp_db):
    from src.db import close_db, init_db, query

    await init_db(tmp_db)
    tables = await query(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", ()
    )
    table_names = [t["name"] for t in tables]
    assert "feedback" in table_names
    assert "session_logs" in table_names
    await close_db()


def test_insert_feedback(tmp_db):
    """insert_feedback stores a row and returns its ID."""
    asyncio.run(_run_insert_feedback(tmp_db))


async def _run_insert_feedback(tmp_db):
    from src.db import close_db, init_db, insert_feedback, query

    await init_db(tmp_db)
    row_id = await insert_feedback({
        "category": "bug",
        "message": "Test bug report",
        "email": "test@example.com",
        "page": "game",
        "context": '{"mode": "lockstep"}',
        "ip_hash": "abc123",
    })
    assert row_id == 1
    rows = await query("SELECT * FROM feedback WHERE id = ?", (row_id,))
    assert len(rows) == 1
    assert rows[0]["category"] == "bug"
    assert rows[0]["message"] == "Test bug report"
    await close_db()


def test_query_returns_dicts(tmp_db):
    """query() returns list of dicts with column names as keys."""
    asyncio.run(_run_query_dicts(tmp_db))


async def _run_query_dicts(tmp_db):
    from src.db import close_db, init_db, insert_feedback, query

    await init_db(tmp_db)
    await insert_feedback({
        "category": "feature",
        "message": "Add dark mode",
        "email": None,
        "page": "home",
        "context": None,
        "ip_hash": "def456",
    })
    rows = await query("SELECT id, category, message FROM feedback", ())
    assert isinstance(rows[0], dict)
    assert "id" in rows[0]
    assert "category" in rows[0]
    await close_db()


def test_upsert_session_log(tmp_db):
    """upsert_session_log inserts then updates on conflict."""
    asyncio.run(_run_upsert_session_log(tmp_db))


async def _run_upsert_session_log(tmp_db):
    from src.db import close_db, init_db, query, upsert_session_log

    await init_db(tmp_db)
    row_id = await upsert_session_log({
        "match_id": "test-match-1",
        "room": "ABC123",
        "slot": 0,
        "player_name": "Player 1",
        "mode": "lockstep",
        "log_data": '[{"seq":0,"t":1.0,"f":1,"msg":"test"}]',
        "summary": '{"desyncs":0}',
        "context": '{"ua":"test"}',
        "ip_hash": "abc",
    })
    assert row_id >= 1

    await upsert_session_log({
        "match_id": "test-match-1",
        "room": "ABC123",
        "slot": 0,
        "player_name": "Player 1",
        "mode": "lockstep",
        "log_data": '[{"seq":0,"t":1.0,"f":1,"msg":"updated"}]',
        "summary": '{"desyncs":1}',
        "context": '{"ua":"test"}',
        "ip_hash": "abc",
    })

    rows = await query("SELECT * FROM session_logs WHERE match_id='test-match-1' AND slot=0", ())
    assert len(rows) == 1
    assert '"updated"' in rows[0]["log_data"]
    assert '"desyncs":1' in rows[0]["summary"] or '"desyncs": 1' in rows[0]["summary"]
    await close_db()


def test_insert_client_event(tmp_db):
    """insert_client_event stores a row."""
    asyncio.run(_run_insert_client_event(tmp_db))


async def _run_insert_client_event(tmp_db):
    from src.db import close_db, init_db, insert_client_event, query

    await init_db(tmp_db)
    row_id = await insert_client_event({
        "type": "desync",
        "message": "test desync",
        "meta": '{"frame":100}',
        "room": "ABC123",
        "slot": 0,
        "ip_hash": "def",
        "user_agent": "TestBrowser/1.0",
    })
    assert row_id >= 1
    rows = await query("SELECT * FROM client_events WHERE id=?", (row_id,))
    assert rows[0]["type"] == "desync"
    await close_db()


def test_set_session_ended(tmp_db):
    """set_session_ended updates the ended_by field."""
    asyncio.run(_run_set_session_ended(tmp_db))


async def _run_set_session_ended(tmp_db):
    from src.db import close_db, init_db, query, set_session_ended, upsert_session_log

    await init_db(tmp_db)
    await upsert_session_log({
        "match_id": "end-test-1",
        "room": "XYZ",
        "slot": 0,
        "player_name": "P1",
        "mode": "lockstep",
        "log_data": "[]",
        "summary": "{}",
        "context": "{}",
        "ip_hash": "abc",
    })
    await set_session_ended("end-test-1", 0, "disconnect")
    rows = await query("SELECT ended_by FROM session_logs WHERE match_id='end-test-1' AND slot=0", ())
    assert rows[0]["ended_by"] == "disconnect"

    await upsert_session_log({
        "match_id": "end-test-1",
        "room": "XYZ",
        "slot": 1,
        "player_name": "P2",
        "mode": "lockstep",
        "log_data": "[]",
        "summary": "{}",
        "context": "{}",
        "ip_hash": "def",
    })
    await set_session_ended("end-test-1", None, "game-end")
    rows = await query("SELECT ended_by FROM session_logs WHERE match_id='end-test-1'", ())
    assert all(r["ended_by"] == "game-end" for r in rows)
    await close_db()
