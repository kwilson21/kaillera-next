"""Tests for the database module.

Run: pytest tests/test_db.py -v
"""

import asyncio
import os
import threading

import pytest


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """DB tests don't need the Playwright browser fixture (which would also
    parameterize them with [chromium] and pull in an event loop that breaks
    asyncio.run())."""
    yield


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
    """Provide a temporary DB path and set env var."""
    db_path = str(tmp_path / "test.db")
    os.environ["DB_PATH"] = db_path
    yield db_path
    os.environ.pop("DB_PATH", None)


def test_init_creates_tables(tmp_db):
    """init_db creates feedback and session_logs tables."""
    _run_async(_run_init_and_query(tmp_db))


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
    _run_async(_run_insert_feedback(tmp_db))


async def _run_insert_feedback(tmp_db):
    from src.db import close_db, init_db, insert_feedback, query

    await init_db(tmp_db)
    row_id = await insert_feedback({
        "category": "bug",
        "message": "Test bug report",
        "email": "test@example.com",
        "page": "game",
        "context": '{"mode": "rollback"}',
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
    _run_async(_run_query_dicts(tmp_db))


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
    _run_async(_run_upsert_session_log(tmp_db))


async def _run_upsert_session_log(tmp_db):
    from src.db import close_db, init_db, query, upsert_session_log

    await init_db(tmp_db)
    row_id = await upsert_session_log({
        "match_id": "test-match-1",
        "room": "ABC123",
        "slot": 0,
        "player_name": "Player 1",
        "mode": "rollback",
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
        "mode": "rollback",
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
    _run_async(_run_insert_client_event(tmp_db))


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
    _run_async(_run_set_session_ended(tmp_db))


async def _run_set_session_ended(tmp_db):
    from src.db import close_db, init_db, query, set_session_ended, upsert_session_log

    await init_db(tmp_db)
    await upsert_session_log({
        "match_id": "end-test-1",
        "room": "XYZ",
        "slot": 0,
        "player_name": "P1",
        "mode": "rollback",
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
        "mode": "rollback",
        "log_data": "[]",
        "summary": "{}",
        "context": "{}",
        "ip_hash": "def",
    })
    await set_session_ended("end-test-1", None, "game-end")
    rows = await query(
        "SELECT slot, ended_by FROM session_logs WHERE match_id='end-test-1' ORDER BY slot",
        (),
    )
    # slot=None broadcast only fills rows without an existing ended_by — it
    # must not overwrite a prior disconnect/leave (covered separately by
    # test_session_logging::test_game_end_does_not_overwrite_disconnect).
    assert rows[0]["ended_by"] == "disconnect"
    assert rows[1]["ended_by"] == "game-end"
    await close_db()


# ── append_session_log / get_full_log_entries (delta session-log flushes) ────
#
# The old path re-wrote the entire `log_data` blob on every 5s flush (up to
# 60,000 entries, ~3MB after 2m45s), which queued behind `end-game` on the
# same Socket.IO connection and delayed the game-ended broadcast in prod.
# append_session_log stores only new entries (deduped by monotonic `seq`)
# as a chunk, so a resend or a stale client still sending its whole ring
# is cheap.


def test_append_session_log_migration_adds_last_seq_and_chunks_table(tmp_db):
    _run_async(_run_migration_schema(tmp_db))


async def _run_migration_schema(tmp_db):
    from src.db import close_db, init_db, query

    await init_db(tmp_db)
    cols = await query("PRAGMA table_info(session_logs)", ())
    col_names = {c["name"] for c in cols}
    assert "last_seq" in col_names

    tables = await query("SELECT name FROM sqlite_master WHERE type='table'", ())
    table_names = {t["name"] for t in tables}
    assert "session_log_chunks" in table_names
    await close_db()


def test_append_session_log_first_flush_returns_last_seq(tmp_db):
    _run_async(_run_append_first_flush(tmp_db))


async def _run_append_first_flush(tmp_db):
    from src.db import append_session_log, close_db, get_full_log_entries, init_db, query

    await init_db(tmp_db)
    entries = [{"seq": 0, "t": 0.0, "f": 0, "msg": "a"}, {"seq": 1, "t": 1.0, "f": 1, "msg": "b"}]
    last_seq = await append_session_log({
        "match_id": "m1", "room": "R1", "slot": 0, "player_name": "P1", "mode": "rollback",
        "entries": entries, "summary": "{}", "context": "{}", "ip_hash": "abc",
    })
    assert last_seq == 1

    rows = await query("SELECT last_seq FROM session_logs WHERE match_id='m1' AND slot=0", ())
    assert rows[0]["last_seq"] == 1

    full = await get_full_log_entries("m1", 0, None)
    assert [e["seq"] for e in full] == [0, 1]
    await close_db()


def test_append_session_log_dedupes_resends_by_seq(tmp_db):
    _run_async(_run_append_dedupe(tmp_db))


async def _run_append_dedupe(tmp_db):
    from src.db import append_session_log, close_db, get_full_log_entries, init_db, query

    await init_db(tmp_db)
    base = {"match_id": "m2", "room": "R1", "slot": 0, "player_name": "P1", "mode": "rollback",
            "summary": "{}", "context": "{}", "ip_hash": "abc"}

    await append_session_log({**base, "entries": [{"seq": 0, "t": 0, "f": 0, "msg": "a"}, {"seq": 1, "t": 1, "f": 1, "msg": "b"}]})

    # A resend of the whole ring (old-style client, or a retried flush)
    # includes already-stored entries plus one new one — only the new one
    # should be appended.
    last_seq = await append_session_log({
        **base,
        "entries": [
            {"seq": 0, "t": 0, "f": 0, "msg": "a"},
            {"seq": 1, "t": 1, "f": 1, "msg": "b"},
            {"seq": 2, "t": 2, "f": 2, "msg": "c"},
        ],
    })
    assert last_seq == 2

    full = await get_full_log_entries("m2", 0, None)
    assert [e["seq"] for e in full] == [0, 1, 2]

    chunks = await query("SELECT COUNT(*) as cnt FROM session_log_chunks WHERE match_id='m2' AND slot=0", ())
    # First flush -> one chunk of 2 entries; second flush -> one chunk of
    # just the new entry (the two dupes were dropped before insert).
    assert chunks[0]["cnt"] == 2
    await close_db()


def test_append_session_log_flush_with_no_new_entries_still_updates_summary(tmp_db):
    """A flush where every entry dedupes away should still persist summary/context
    (and not error) — the client flushes those on every interval even when idle."""
    _run_async(_run_append_no_new_entries(tmp_db))


async def _run_append_no_new_entries(tmp_db):
    from src.db import append_session_log, close_db, init_db, query

    await init_db(tmp_db)
    base = {"match_id": "m3", "room": "R1", "slot": 0, "player_name": "P1", "mode": "rollback", "ip_hash": "abc"}
    await append_session_log({**base, "entries": [{"seq": 0, "t": 0, "f": 0, "msg": "a"}], "summary": "{}", "context": "{}"})
    last_seq = await append_session_log({**base, "entries": [{"seq": 0, "t": 0, "f": 0, "msg": "a"}], "summary": '{"frames": 10}', "context": "{}"})
    assert last_seq == 0

    rows = await query("SELECT summary FROM session_logs WHERE match_id='m3' AND slot=0", ())
    assert rows[0]["summary"] == '{"frames": 10}'
    await close_db()


def test_get_full_log_entries_concatenates_legacy_log_data_and_chunks(tmp_db):
    """A row created under the old full-blob scheme (log_data populated) that
    then receives new delta flushes must expose both in order — the admin
    API and analyze_match.py must keep working across the migration."""
    _run_async(_run_legacy_plus_chunks(tmp_db))


async def _run_legacy_plus_chunks(tmp_db):
    import json

    from src.db import append_session_log, close_db, get_full_log_entries, init_db, upsert_session_log

    await init_db(tmp_db)
    legacy_entries = [{"seq": 0, "t": 0, "f": 0, "msg": "legacy-a"}, {"seq": 1, "t": 1, "f": 1, "msg": "legacy-b"}]
    await upsert_session_log({
        "match_id": "m4", "room": "R1", "slot": 0, "player_name": "P1", "mode": "rollback",
        "log_data": json.dumps(legacy_entries), "summary": "{}", "context": "{}", "ip_hash": "abc",
    })

    # A last_seq of 0 (default before this feature existed on the row) would
    # be wrong here since it would dedupe away seq=0 forever; the migration
    # defaults new rows to -1, but this row was upserted directly (bypassing
    # append_session_log) so last_seq is whatever upsert_session_log leaves —
    # confirm new entries starting at seq=2 still land correctly regardless.
    await append_session_log({
        "match_id": "m4", "room": "R1", "slot": 0, "player_name": "P1", "mode": "rollback",
        "entries": [{"seq": 2, "t": 2, "f": 2, "msg": "chunk-a"}], "summary": "{}", "context": "{}", "ip_hash": "abc",
    })

    full = await get_full_log_entries("m4", 0, json.dumps(legacy_entries))
    assert [e["msg"] for e in full] == ["legacy-a", "legacy-b", "chunk-a"]
    await close_db()


def test_session_log_chunk_cap_drops_oldest_chunks(tmp_db):
    """Total chunk size per (match_id, slot) is capped — oldest chunks are
    dropped first so the latest entries (reconnect/desync events) survive,
    matching the old single-blob 'keep latest' behavior."""
    _run_async(_run_chunk_cap(tmp_db))


async def _run_chunk_cap(tmp_db):
    import src.db as db_mod
    from src.db import append_session_log, close_db, init_db, query

    await init_db(tmp_db)
    # Shrink the cap so the test doesn't need megabytes of fixture data.
    original_cap = db_mod._SESSION_LOG_CHUNK_CAP
    db_mod._SESSION_LOG_CHUNK_CAP = 200
    try:
        base = {"match_id": "m5", "room": "R1", "slot": 0, "player_name": "P1", "mode": "rollback",
                "summary": "{}", "context": "{}", "ip_hash": "abc"}
        big_msg = "x" * 100
        # Each flush's chunk is comfortably larger than 200 bytes on its own
        # once a couple of entries land, so repeated flushes force eviction.
        for i in range(5):
            await append_session_log({**base, "entries": [{"seq": i, "t": i, "f": i, "msg": big_msg}]})

        chunks = await query(
            "SELECT first_seq, last_seq FROM session_log_chunks WHERE match_id='m5' AND slot=0 ORDER BY id",
            (),
        )
        total_size = await query(
            "SELECT SUM(length(entries)) as sz FROM session_log_chunks WHERE match_id='m5' AND slot=0",
            (),
        )
        assert total_size[0]["sz"] <= 200
        # The oldest chunk(s) (seq 0, 1, ...) should have been evicted first,
        # so whatever remains should include the most recent entry (seq=4).
        assert chunks[-1]["last_seq"] == 4
    finally:
        db_mod._SESSION_LOG_CHUNK_CAP = original_cap
    await close_db()
