"""Tests for session logging and HMAC token functions (commits b18789d, ab97158).

Run: pytest tests/test_session_logging.py -v
"""

import asyncio
import json
import os
import threading

import pytest


def _run_async(coro):
    """Run a coroutine in a dedicated thread with a fresh event loop. Bypasses
    any session-level event loop pytest-playwright may have started on the
    main thread (which would otherwise make asyncio.run() raise)."""
    result: list = []
    exc: list = []

    def _target():
        loop = asyncio.new_event_loop()
        try:
            result.append(loop.run_until_complete(coro))
        except BaseException as e:
            exc.append(e)
        finally:
            loop.close()

    t = threading.Thread(target=_target)
    t.start()
    t.join()
    if exc:
        raise exc[0]
    return result[0] if result else None


@pytest.fixture()
def tmp_db(tmp_path):
    db_path = str(tmp_path / "test.db")
    os.environ["DB_PATH"] = db_path
    yield db_path
    os.environ.pop("DB_PATH", None)


def test_game_end_does_not_overwrite_disconnect(tmp_db):
    """game-end broadcast should NOT overwrite a prior disconnect ended_by."""
    _run_async(_run_ended_by_no_overwrite(tmp_db))


async def _run_ended_by_no_overwrite(tmp_db):
    from src.db import append_session_log, close_db, init_db, query, set_session_ended

    await init_db(tmp_db)

    for slot, name, ip in [(0, "P1", "a"), (1, "P2", "b")]:
        await append_session_log({
            "match_id": "m1", "room": "R1", "slot": slot,
            "player_name": name, "mode": "rollback",
            "entries": [], "summary": "{}", "context": "{}", "ip_hash": ip,
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
    from src.api.signaling import make_reconnect_token, verify_reconnect_token

    token = make_reconnect_token("ROOM1", "pid-123")
    assert verify_reconnect_token("ROOM1", "pid-123", token)
    assert not verify_reconnect_token("ROOM1", "pid-123", "forged")
    assert not verify_reconnect_token("ROOM1", "wrong-pid", token)
    assert not verify_reconnect_token("ROOM2", "pid-123", token)


def test_previous_release_token_survives_rollout_until_expiry(monkeypatch):
    from src.api import signaling

    token = signaling._make_token({"k": "reconnect", "pid": "player", "exp": 200})
    monkeypatch.setattr(signaling.time, "time", lambda: 150)
    assert signaling.verify_reconnect_token("ROOM1", "player", token)
    monkeypatch.setattr(signaling.time, "time", lambda: 201)
    assert not signaling.verify_reconnect_token("ROOM1", "player", token)


def test_long_match_renews_tokens_only_for_connected_members(monkeypatch):
    from unittest.mock import AsyncMock

    from src.api import signaling

    now = 1_000
    room_code, pid = "ROOM1", "player"
    monkeypatch.setattr(signaling.time, "time", lambda: now)
    first = signaling.make_reconnect_token(room_code, pid)
    emitted = AsyncMock()
    monkeypatch.setattr(signaling, "_emit", emitted)
    monkeypatch.setattr(signaling, "_sid_host", {"current": "example"})
    monkeypatch.setattr(signaling, "_sid_to_room", {
        "current": (room_code, pid, False),
        "disconnected": (room_code, "away", False),
    })

    async def wait(seconds):
        nonlocal now
        if emitted.await_count:
            raise asyncio.CancelledError
        assert seconds < signaling._RECONNECT_TOKEN_TTL_S
        now += seconds

    monkeypatch.setattr(signaling.asyncio, "sleep", wait)

    async def renew():
        with pytest.raises(asyncio.CancelledError):
            await signaling.renew_member_tokens()

    _run_async(renew())
    assert [call.kwargs["to"] for call in emitted.await_args_list] == ["current", "current"]
    (_, upload), (_, refresh) = (call.args for call in emitted.await_args_list)
    now = 1_001 + signaling._RECONNECT_TOKEN_TTL_S
    assert not signaling.verify_reconnect_token(room_code, pid, first)
    assert signaling.verify_reconnect_token(room_code, pid, refresh["token"], allow_legacy=False)
    assert signaling.verify_upload_token(room_code, upload["token"])


def test_upload_token_roundtrip():
    """HMAC upload tokens verify correctly."""
    from src.api.signaling import make_upload_token, verify_upload_token

    token = make_upload_token("ROOM1")
    assert verify_upload_token("ROOM1", token) is True
    assert verify_upload_token("ROOM1", "bad") is False


def test_older_upload_preserves_exit_omissions_in_same_epoch(tmp_db):
    async def scenario():
        from src.db import append_session_log, close_db, init_db, query

        await init_db(tmp_db)
        try:
            base = {"match_id": "m1", "room": "R1", "slot": 1, "epoch": "log"}
            omissions = {"logEntries": 8, "auditEntries": 2}
            await append_session_log({
                **base,
                "entries": [{"seq": 10, "msg": "exit"}],
                "summary": json.dumps({"frames": 20, "omittedOnExit": omissions}),
            })
            await append_session_log({
                **base,
                "entries": [{"seq": 1, "msg": "older"}],
                "summary": json.dumps({"frames": 8}),
            })
            [row] = await query("SELECT summary FROM session_logs WHERE match_id='m1'", ())
            assert json.loads(row["summary"])["omittedOnExit"] == omissions

            await append_session_log({**base, "epoch": "new", "summary": "{}"})
            [row] = await query("SELECT summary FROM session_logs WHERE match_id='m1'", ())
            assert "omittedOnExit" not in json.loads(row["summary"])
        finally:
            await close_db()

    _run_async(scenario())
