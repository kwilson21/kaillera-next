"""Tests for session logging and HMAC token functions (commits b18789d, ab97158).

Run: pytest tests/test_session_logging.py -v
"""

import asyncio
import os

import pytest


@pytest.fixture()
def tmp_db(tmp_path):
    db_path = str(tmp_path / "test.db")
    os.environ["DB_PATH"] = db_path
    yield db_path
    os.environ.pop("DB_PATH", None)


def test_game_end_does_not_overwrite_disconnect(tmp_db):
    """game-end broadcast should NOT overwrite a prior disconnect ended_by."""
    asyncio.run(_run_ended_by_no_overwrite(tmp_db))


async def _run_ended_by_no_overwrite(tmp_db):
    from src.db import close_db, init_db, query, set_session_ended, upsert_session_log

    await init_db(tmp_db)

    for slot, name, ip in [(0, "P1", "a"), (1, "P2", "b")]:
        await upsert_session_log({
            "match_id": "m1", "room": "R1", "slot": slot,
            "player_name": name, "mode": "lockstep",
            "log_data": "[]", "summary": "{}", "context": "{}", "ip_hash": ip,
        })

    # P1 disconnects first
    await set_session_ended("m1", 0, "disconnect")
    # Then host ends game (all slots)
    await set_session_ended("m1", None, "game-end")

    rows = await query("SELECT slot, ended_by FROM session_logs WHERE match_id='m1' ORDER BY slot", ())
    assert rows[0]["ended_by"] == "disconnect", "disconnect should not be overwritten"
    assert rows[1]["ended_by"] == "game-end"
    await close_db()


def test_reconnect_token_roundtrip():
    """HMAC reconnect tokens verify correctly; forged tokens are rejected."""
    from src.api.signaling import make_reconnect_token, verify_reconnect_token

    token = make_reconnect_token("pid-123")
    assert verify_reconnect_token("pid-123", token) is True
    assert verify_reconnect_token("pid-123", "forged") is False
    assert verify_reconnect_token("wrong-pid", token) is False


def test_upload_token_roundtrip():
    """HMAC upload tokens verify correctly."""
    from src.api.signaling import make_upload_token, verify_upload_token

    token = make_upload_token("ROOM1")
    assert verify_upload_token("ROOM1", token) is True
    assert verify_upload_token("ROOM1", "bad") is False
