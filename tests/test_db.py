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


def test_append_session_log_inserts_then_updates_on_conflict(tmp_db):
    """append_session_log inserts a session_logs row, then updates it in
    place on a second flush for the same (match_id, slot) — the insert+
    update-on-conflict behavior that used to live in the now-removed
    upsert_session_log (dropped once nothing but tests called it; the
    delta-flush path below covers the same row lifecycle)."""
    _run_async(_run_append_insert_then_update(tmp_db))


async def _run_append_insert_then_update(tmp_db):
    from src.db import append_session_log, close_db, init_db, query

    await init_db(tmp_db)
    row_id = await append_session_log({
        "match_id": "test-match-1",
        "room": "ABC123",
        "slot": 0,
        "player_name": "Player 1",
        "mode": "rollback",
        "entries": [{"seq": 0, "t": 1.0, "f": 1, "msg": "test"}],
        "summary": '{"desyncs":0}',
        "context": '{"ua":"test"}',
        "ip_hash": "abc",
    })
    assert row_id == 0  # append_session_log returns the new last_seq, not a row id

    await append_session_log({
        "match_id": "test-match-1",
        "room": "ABC123",
        "slot": 0,
        "player_name": "Player 1",
        "mode": "rollback",
        "entries": [{"seq": 1, "t": 2.0, "f": 2, "msg": "updated"}],
        "summary": '{"desyncs":1}',
        "context": '{"ua":"test"}',
        "ip_hash": "abc",
    })

    rows = await query("SELECT * FROM session_logs WHERE match_id='test-match-1' AND slot=0", ())
    assert len(rows) == 1
    assert rows[0]["last_seq"] == 1
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
    from src.db import append_session_log, close_db, init_db, query, set_session_ended

    await init_db(tmp_db)
    await append_session_log({
        "match_id": "end-test-1",
        "room": "XYZ",
        "slot": 0,
        "player_name": "P1",
        "mode": "rollback",
        "entries": [],
        "summary": "{}",
        "context": "{}",
        "ip_hash": "abc",
    })
    await set_session_ended("end-test-1", 0, "disconnect")
    rows = await query("SELECT ended_by FROM session_logs WHERE match_id='end-test-1' AND slot=0", ())
    assert rows[0]["ended_by"] == "disconnect"

    await append_session_log({
        "match_id": "end-test-1",
        "room": "XYZ",
        "slot": 1,
        "player_name": "P2",
        "mode": "rollback",
        "entries": [],
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

    import src.db as db_mod
    from src.db import append_session_log, close_db, get_full_log_entries, init_db

    await init_db(tmp_db)
    legacy_entries = [{"seq": 0, "t": 0, "f": 0, "msg": "legacy-a"}, {"seq": 1, "t": 1, "f": 1, "msg": "legacy-b"}]
    # Simulate a row written under the old full-blob scheme, before
    # append_session_log (and its last_seq bookkeeping) existed. There's no
    # write helper for this shape anymore — insert it directly, the way a
    # pre-migration row would already look on disk.
    await db_mod.execute_write(
        "INSERT INTO session_logs (match_id, room, slot, player_name, mode, log_data, summary, context, ip_hash) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ("m4", "R1", 0, "P1", "rollback", json.dumps(legacy_entries), "{}", "{}", "abc"),
    )

    # A last_seq of 0 (default before this feature existed on the row) would
    # be wrong here since it would dedupe away seq=0 forever; the migration
    # defaults new rows to -1, but this row was inserted directly (bypassing
    # append_session_log) so last_seq is whatever the column default leaves —
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


def test_session_log_chunks_records_size_at_insert_time(tmp_db):
    """`size` is stored at insert time (used to enforce the cap without
    re-reading length(entries) on every flush — see _enforce_chunk_cap)."""
    _run_async(_run_chunk_size_column(tmp_db))


async def _run_chunk_size_column(tmp_db):
    from src.db import append_session_log, close_db, init_db, query

    await init_db(tmp_db)
    await append_session_log({
        "match_id": "m-size", "room": "R1", "slot": 0, "player_name": "P1", "mode": "rollback",
        "entries": [{"seq": 0, "t": 0, "f": 0, "msg": "hello"}], "summary": "{}", "context": "{}", "ip_hash": "abc",
    })
    rows = await query(
        "SELECT size, length(entries) as len FROM session_log_chunks WHERE match_id='m-size' AND slot=0", ()
    )
    assert rows[0]["size"] == rows[0]["len"]
    assert rows[0]["size"] > 0
    await close_db()


# ── epoch reset (reload / reconnect / slot-reuse) ────────────────────────────
#
# A page reload, a fresh reconnect tab, or a spectator claiming a slot a
# previous player used all create a brand-new client ring that restarts
# `seq` at 0, while the server's stored `last_seq` for that (match_id, slot)
# is already high from the previous ring. Without a per-ring epoch, every
# entry from the new ring looks like a dup of the old one's high-water mark
# and gets silently dropped.


def test_append_session_log_epoch_change_resets_dedup_for_reload(tmp_db):
    _run_async(_run_epoch_reset(tmp_db))


async def _run_epoch_reset(tmp_db):
    from src.db import append_session_log, close_db, get_full_log_entries, init_db, query

    await init_db(tmp_db)
    base = {
        "match_id": "m-reload", "room": "R1", "slot": 0, "player_name": "P1", "mode": "rollback",
        "summary": "{}", "context": "{}", "ip_hash": "abc",
    }

    # First "session" (epoch e1) plays for a while and racks up a high last_seq.
    await append_session_log(
        {**base, "epoch": "e1", "entries": [{"seq": i, "t": i, "f": i, "msg": f"e1-{i}"} for i in range(50)]}
    )
    rows = await query("SELECT last_seq, log_epoch FROM session_logs WHERE match_id='m-reload' AND slot=0", ())
    assert rows[0]["last_seq"] == 49
    assert rows[0]["log_epoch"] == "e1"

    # Page reload: a brand-new ring starts at seq 0 again, under a new epoch.
    last_seq = await append_session_log(
        {
            **base,
            "epoch": "e2",
            "entries": [
                {"seq": 0, "t": 0, "f": 0, "msg": "e2-0"},
                {"seq": 1, "t": 1, "f": 1, "msg": "e2-1"},
            ],
        }
    )
    # Without the epoch reset, seq 0/1 would be <= the old last_seq (49) and
    # silently dropped as dupes.
    assert last_seq == 1

    full = await get_full_log_entries("m-reload", 0, None)
    msgs = {e["msg"] for e in full}
    assert "e2-0" in msgs
    assert "e2-1" in msgs

    rows = await query("SELECT last_seq, log_epoch FROM session_logs WHERE match_id='m-reload' AND slot=0", ())
    assert rows[0]["last_seq"] == 1
    assert rows[0]["log_epoch"] == "e2"
    await close_db()


def test_append_session_log_same_epoch_still_dedupes_normally(tmp_db):
    """Sanity check: the epoch mechanism must not disable normal dedup when
    the epoch hasn't changed (e.g. an ordinary resend of an unacked flush)."""
    _run_async(_run_same_epoch_dedupe(tmp_db))


async def _run_same_epoch_dedupe(tmp_db):
    from src.db import append_session_log, close_db, get_full_log_entries, init_db

    await init_db(tmp_db)
    base = {
        "match_id": "m-same-epoch", "room": "R1", "slot": 0, "player_name": "P1", "mode": "rollback",
        "summary": "{}", "context": "{}", "ip_hash": "abc", "epoch": "e1",
    }
    await append_session_log({**base, "entries": [{"seq": 0, "t": 0, "f": 0, "msg": "a"}]})
    last_seq = await append_session_log(
        {**base, "entries": [{"seq": 0, "t": 0, "f": 0, "msg": "a"}, {"seq": 1, "t": 1, "f": 1, "msg": "b"}]}
    )
    assert last_seq == 1
    full = await get_full_log_entries("m-same-epoch", 0, None)
    assert [e["msg"] for e in full] == ["a", "b"]
    await close_db()


# ── seq validation ────────────────────────────────────────────────────────
#
# Only a non-bool int in [0, 2**53) is trusted for dedup/high-water-mark
# purposes. An entry with any other seq (missing, float, negative, too
# large, or a bool) can't be safely compared, so it is always kept rather
# than silently dropped — it just never participates in dedup.


def test_append_session_log_validates_seq(tmp_db):
    _run_async(_run_seq_validation(tmp_db))


async def _run_seq_validation(tmp_db):
    from src.db import append_session_log, close_db, get_full_log_entries, init_db

    await init_db(tmp_db)
    base = {
        "match_id": "m-seq", "room": "R1", "slot": 0, "player_name": "P1", "mode": "rollback",
        "summary": "{}", "context": "{}", "ip_hash": "abc",
    }
    entries = [
        {"seq": 0, "t": 0, "f": 0, "msg": "valid-0"},
        {"seq": True, "t": 1, "f": 1, "msg": "bool-seq"},  # bool is not a valid seq
        {"seq": -1, "t": 2, "f": 2, "msg": "negative"},  # out of range
        {"seq": 2**53, "t": 3, "f": 3, "msg": "too-big"},  # out of range
        {"seq": 1.5, "t": 4, "f": 4, "msg": "float-seq"},  # not an int
        {"msg": "no-seq"},  # missing seq entirely
        {"seq": 1, "t": 5, "f": 5, "msg": "valid-1"},
    ]
    last_seq = await append_session_log({**base, "entries": entries})
    # Only entries with a valid seq (0 and 1) participate in the high-water mark.
    assert last_seq == 1

    full = await get_full_log_entries("m-seq", 0, None)
    # All 7 entries are kept — an invalid seq means "can't dedupe", not
    # "discard the client's data".
    assert len(full) == 7
    assert {e["msg"] for e in full} == {
        "valid-0", "bool-seq", "negative", "too-big", "float-seq", "no-seq", "valid-1",
    }

    # A second flush resending the exact same entries: the two with a valid,
    # already-acked seq (0 and 1) are deduped away as usual, but the ones
    # without a usable seq are appended again every time — that's the
    # documented tradeoff of "always keep" over "silently drop".
    last_seq2 = await append_session_log({**base, "entries": entries})
    assert last_seq2 == 1
    full2 = await get_full_log_entries("m-seq", 0, None)
    assert len(full2) == 7 + 5
    await close_db()


# ── concurrent appends ───────────────────────────────────────────────────────
#
# Two overlapping flushes for the same (match_id, slot) — e.g. a socket
# flush racing an HTTP fallback retry of the same interval — must not both
# read the same last_seq and both decide the same entries are new.


def test_append_session_log_concurrent_overlapping_appends_do_not_duplicate(tmp_db):
    _run_async(_run_concurrent_appends(tmp_db))


async def _run_concurrent_appends(tmp_db):
    import asyncio

    from src.db import append_session_log, close_db, get_full_log_entries, init_db, query

    await init_db(tmp_db)
    base = {
        "match_id": "m-concurrent", "room": "R1", "slot": 0, "player_name": "P1", "mode": "rollback",
        "summary": "{}", "context": "{}", "ip_hash": "abc", "epoch": "e1",
    }

    # One flush sends 0-2 (new); a second, racing flush resends 0-2 plus one
    # genuinely new entry (3) — as a retried/duplicated flush would. Without
    # serialization, both could read last_seq=-1 before either commits and
    # both store entries 0-2, duplicating them.
    results = await asyncio.gather(
        append_session_log(
            {**base, "entries": [{"seq": i, "t": i, "f": i, "msg": f"a{i}"} for i in range(3)]}
        ),
        append_session_log(
            {**base, "entries": [{"seq": i, "t": i, "f": i, "msg": f"a{i}"} for i in range(4)]}
        ),
    )
    assert max(results) == 3

    full = await get_full_log_entries("m-concurrent", 0, None)
    seqs = sorted(e["seq"] for e in full)
    assert seqs == [0, 1, 2, 3]  # no duplicates, regardless of interleaving order

    rows = await query("SELECT last_seq FROM session_logs WHERE match_id='m-concurrent' AND slot=0", ())
    assert rows[0]["last_seq"] == 3
    await close_db()


# ── retention sweep (cleanup_old_data) ───────────────────────────────────────


def test_cleanup_old_data_also_cleans_session_log_chunks(tmp_db):
    """cleanup_old_data must delete stale session_log_chunks rows too —
    they accumulate independently of their parent session_logs row's own
    created_at/updated_at (see migration 0002_session_log_chunks.sql), so without their own sweep
    they'd outlive every other retention-governed table."""
    _run_async(_run_cleanup_chunks(tmp_db))


async def _run_cleanup_chunks(tmp_db):
    import asyncio
    import contextlib
    from unittest.mock import patch

    import src.db as db_mod
    from src.api.app import cleanup_old_data
    from src.db import close_db, init_db, query

    await init_db(tmp_db)
    await db_mod.execute_write(
        "INSERT INTO session_log_chunks (match_id, slot, first_seq, last_seq, entries, size, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-31 days'))",
        ("m-old", 0, 0, 0, "[]", 2),
    )
    await db_mod.execute_write(
        "INSERT INTO session_log_chunks (match_id, slot, first_seq, last_seq, entries, size, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
        ("m-new", 0, 0, 0, "[]", 2),
    )

    # cleanup_old_data is `while True: await asyncio.sleep(86400); ...`.
    # Make the sleep resolve instantly so one iteration runs almost
    # immediately, then cancel the task once it has had its effect.
    async def _instant_sleep(_seconds):
        return None

    with patch("src.api.app.asyncio.sleep", new=_instant_sleep):
        task = asyncio.ensure_future(cleanup_old_data())
        try:
            for _ in range(200):
                await asyncio.sleep(0)
                rows = await query("SELECT match_id FROM session_log_chunks", ())
                if len(rows) == 1:
                    break
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    rows = await query("SELECT match_id FROM session_log_chunks", ())
    assert [r["match_id"] for r in rows] == ["m-new"]
    await close_db()


def test_init_db_records_migrations_and_is_rerunnable(tmp_db):
    """init_db applies the SQL migrations once; a second start applies nothing."""
    _run_async(_run_init_twice(tmp_db))


async def _run_init_twice(tmp_db):
    from src.db import close_db, init_db, query

    await init_db(tmp_db)
    await close_db()
    await init_db(tmp_db)
    rows = await query("SELECT version FROM schema_migrations ORDER BY version", ())
    assert [r["version"] for r in rows] == ["0001", "0002"]
    await close_db()
