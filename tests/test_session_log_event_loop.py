"""Reading a long session log never holds the event loop for long.

On 2026-11-22 one admin export of a 19-minute match (a ~14 MB log) parsed and
serialized the whole log on the event loop; /health stopped answering for
5 s and Render restarted the server. Here a synthetic log of tens of
thousands of entries is exported, and a match rotated, while /health is
polled on the same event loop, as uvicorn serves both.

Run: cd server && uv run --extra dev pytest ../tests/test_session_log_event_loop.py -q
"""

import asyncio
import gc
import json
import time

import pytest
from db_test_support import run_async


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


FLUSHES = 80  # one chunk each
ENTRIES_PER_FLUSH = 800
PROBE_EVERY = 0.01


async def _seed_long_log(db, slots=(0,)):
    """FLUSHES x ENTRIES_PER_FLUSH entries per slot: about 11 MB of JSON each, near the 12 MB cap."""
    for slot in slots:
        for flush in range(FLUSHES):
            first = flush * ENTRIES_PER_FLUSH
            entries = [
                {"seq": seq, "t": seq * 16.6, "f": seq, "msg": f"RB-TICK f={seq} depth=3 lastGood={seq - 2} " + "x" * 60}
                for seq in range(first, first + ENTRIES_PER_FLUSH)
            ]
            await db.append_session_flush(
                {"match_id": "m1", "room": "ROOM1", "slot": slot, "epoch": "e", "entries": entries, "mode": "rollback"}
            )


async def _worst_health_wait(http, work):
    """Run `work` while /health is requested every PROBE_EVERY seconds.

    Returns (work's result, how long it took, the longest any /health request
    waited past the time it was due).
    """
    done = asyncio.Event()
    waits = []

    async def probe():
        while not done.is_set():
            due = time.perf_counter() + PROBE_EVERY
            await asyncio.sleep(PROBE_EVERY)
            resp = await http.get("/health")
            assert resp.status_code == 200
            waits.append(time.perf_counter() - due)

    # A full cyclic-GC pass pauses every thread, and its length grows with the
    # heap: in CI's single pytest process, every test file's objects. Freezing
    # what exists now leaves the pauses this work's own objects cause.
    gc.collect()
    gc.freeze()
    prober = asyncio.create_task(probe())
    await asyncio.sleep(0.05)
    started = time.perf_counter()
    try:
        result = await work()
    finally:
        done.set()
        took = time.perf_counter() - started
        await prober
        gc.unfreeze()
    assert len(waits) > 3, "the probe never ran alongside the work"
    return result, took, max(waits)


def _assert_loop_stayed_free(took, worst):
    # Under 5 s is what Render's health check needs. The relative bound is
    # what tells the old code from the new on any machine: the old export and
    # rotation held the loop for nearly their whole run (ratio ~0.9); now the
    # longest wait is a page of work or a GC pass, a small part of it.
    assert worst < 1.0, f"/health waited {worst:.3f}s"
    assert worst < took / 4, f"/health waited {worst:.3f}s of a {took:.3f}s run"


@pytest.fixture
def app_db(tmp_path, monkeypatch):
    """Open a real SQLite database in tmp_path; yields an async context for one test scenario."""
    monkeypatch.setenv("ADMIN_KEY", "k")
    monkeypatch.setenv("PARQUET_DIR", str(tmp_path / "parquet"))
    from src.api import app as appmod

    monkeypatch.setattr(appmod, "check_ip", lambda ip, event: True)

    async def open_db():
        import src.db as db
        from src.blobstore import LocalBlobStore

        await db.init_db(str(tmp_path / "kn.db"), blobs=LocalBlobStore(tmp_path / "blobs"))
        return db

    return open_db


def _client(app):
    import httpx

    # In-process: the app's handlers and these requests share one event loop.
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


def test_health_answers_while_a_long_log_is_exported(app_db):
    async def scenario():
        from src.api.app import create_app

        db = await app_db()
        try:
            await _seed_long_log(db)
            async with _client(create_app()) as http:

                async def export():
                    lines = 0
                    path = "/admin/api/session-logs/1/export?format=jsonl"
                    async with http.stream("GET", path, headers={"X-Admin-Key": "k"}) as resp:
                        assert resp.status_code == 200
                        async for chunk in resp.aiter_bytes():
                            lines += chunk.count(b"\n")
                        return resp.headers["x-entry-count"], lines

                return await _worst_health_wait(http, export)
        finally:
            await db.close_db()

    (entry_count, lines), took, worst = run_async(scenario())
    assert entry_count == str(FLUSHES * ENTRIES_PER_FLUSH)
    assert lines == FLUSHES * ENTRIES_PER_FLUSH + 1  # the meta line, then every entry
    _assert_loop_stayed_free(took, worst)


def test_health_answers_while_a_long_match_is_rotated(app_db):
    async def scenario():
        from src import match_rotation
        from src.api.app import create_app

        db = await app_db()
        try:
            await _seed_long_log(db, slots=(0, 1))
            await db.set_session_ended("m1", None, "game-end")
            async with _client(create_app()) as http:
                return await _worst_health_wait(http, lambda: match_rotation.rotate_match("m1"))
        finally:
            await db.close_db()

    metrics, took, worst = run_async(scenario())
    assert metrics.entry_count == 2 * FLUSHES * ENTRIES_PER_FLUSH
    assert metrics.parquet_bytes
    _assert_loop_stayed_free(took, worst)


def test_export_and_detail_keep_every_entry_the_old_reader_kept(app_db):
    """Legacy blob first, then chunks in order; non-dict entries count but get no line;
    a chunk that isn't a JSON list holds no entries."""

    async def scenario():
        from src.api.app import create_app

        db = await app_db()
        try:
            base = {"match_id": "m1", "room": "ROOM1", "slot": 0, "epoch": "e"}
            await db.append_session_flush({**base, "entries": [{"seq": 0, "msg": "a"}, {"seq": 1, "msg": "b"}]})
            legacy = json.dumps([{"msg": "legacy"}, 5])
            await db.execute_write("UPDATE session_logs SET log_data = ?", (legacy,))
            for text in ("{not json", '{"a": 1}', '[7, {"msg": "c"}]'):
                await db.execute_write(
                    "INSERT INTO session_log_chunks (match_id, slot, kind, first_seq, last_seq, entries, size)"
                    " VALUES ('m1', 0, 'log', 0, 0, ?, 0)",
                    (text,),
                )
            async with _client(create_app()) as http:
                key = {"X-Admin-Key": "k"}
                export = await http.get("/admin/api/session-logs/1/export", headers=key)
                detail = await http.get("/admin/api/session-logs/1", headers=key)
            return export, detail.json(), await db.get_full_log_entries("m1", 0, legacy)
        finally:
            await db.close_db()

    export, detail, full = run_async(scenario())
    expected = [{"msg": "legacy"}, 5, {"seq": 0, "msg": "a"}, {"seq": 1, "msg": "b"}, 7, {"msg": "c"}]
    assert full == expected
    assert detail["log_data"] == expected
    assert export.headers["x-entry-count"] == "6"
    meta, *lines = export.text.splitlines()
    assert json.loads(meta)["entry_count"] == 6
    stamp = {"session_id": 1, "match_id": "m1", "slot": 0}
    assert [json.loads(line) for line in lines] == [{**stamp, **e} for e in expected if isinstance(e, dict)]


def test_export_streams_only_the_chunks_it_counted(app_db):
    """A live match appends chunks while its log is exported: the stream stops
    at the chunks counted for the meta line and header."""

    async def scenario():
        db = await app_db()
        try:
            base = {"match_id": "m1", "room": "ROOM1", "slot": 0, "epoch": "e"}
            await db.append_session_flush({**base, "entries": [{"seq": 0, "msg": "a"}, {"seq": 1, "msg": "b"}]})
            counted, through_id = await db.count_log_entries("m1", 0)
            await db.append_session_flush({**base, "entries": [{"seq": 2, "msg": "late"}]})
            streamed = [e async for page in db.iter_chunk_entries("m1", 0, through_id=through_id) for e in page]
            everything = [e async for page in db.iter_chunk_entries("m1", 0) for e in page]
            return counted, streamed, everything, await db.count_log_entries("m1", 9)
        finally:
            await db.close_db()

    counted, streamed, everything, nothing = run_async(scenario())
    assert counted == len(streamed) == 2
    assert [e["msg"] for e in everything] == ["a", "b", "late"]
    assert nothing == (0, 0)


# ── Rotation off the loop keeps what rotation did on it ─────────────────────


def test_parquet_types_a_mixed_nested_column_as_one_build_would(app_db, monkeypatch):
    """A field that is a number in one slice and an object in another is
    typed as one build over every entry types it (the number becomes null),
    not wrapped into a struct by the slices' concat."""
    import polars as pl
    from src import match_rotation

    monkeypatch.setattr(match_rotation, "_FRAME_SLICE_ROWS", 2)
    entries = [{"f": 1, "v": 0}, {"f": 2, "v": 7}, {"f": 3, "v": {"x": 1}}, {"f": 4, "v": {}}]
    frame = match_rotation._entries_frame(pl, entries)
    whole = pl.DataFrame(entries, infer_schema_length=None, strict=False)
    assert frame.schema == whole.schema
    assert frame.to_dicts() == whole.to_dicts()
    assert frame["v"].to_list()[:2] == [None, None]

    scalars = [{"f": 1, "t": 1}, {"f": 2, "t": 2}, {"f": 3, "t": 2.5}, {"f": 4, "t": "s"}, {"f": 5}]
    frame = match_rotation._entries_frame(pl, scalars)
    assert frame.to_dicts() == pl.DataFrame(scalars, infer_schema_length=None, strict=False).to_dicts()


def test_metrics_are_stored_even_when_the_classifier_raises(app_db):
    """The sweeper skips a match once its metrics row exists, so a log the
    classifier can't read must not leave the match to be rotated every minute."""

    async def scenario():
        from src import match_rotation

        db = await app_db()
        try:
            base = {"match_id": "m1", "room": "ROOM1", "slot": 0, "epoch": "e"}
            # The first frame isn't a number, so comparing the second with it raises.
            entries = [{"seq": 0, "f": "bad", "msg": "TICK-STUCK f=?"}, {"seq": 1, "f": 5, "msg": "TICK-STUCK f=5"}]
            await db.append_session_flush({**base, "entries": entries})
            await db.set_session_ended("m1", None, "game-end")
            with pytest.raises(TypeError):
                await match_rotation.rotate_match("m1")
            return await db.query("SELECT entry_count FROM match_metrics WHERE match_id = 'm1'", ())
        finally:
            await db.close_db()

    assert run_async(scenario()) == [{"entry_count": 2}]


def test_health_answers_while_a_long_log_is_archived_and_its_evicted_copy_exported(app_db, monkeypatch):
    """The archive gzips page by page in worker threads, and an evicted log is
    read back a page at a time (src/log_archive.py): neither holds the loop."""
    monkeypatch.setenv("LOG_ARCHIVE_LOCAL", "1")  # the store is a local folder

    async def scenario():
        from src import log_archive
        from src.api.app import create_app

        db = await app_db()
        try:
            await db.register_match("m1", "ROOM1")
            await _seed_long_log(db)
            for statement in (
                "UPDATE match_retention SET ended_at = datetime('now', '-45 minutes')",
                "UPDATE session_logs SET updated_at = datetime(updated_at, '-45 minutes')",
                "UPDATE session_log_chunks SET created_at = datetime(created_at, '-45 minutes')",
            ):
                await db.execute_write(statement, ())
            async with _client(create_app()) as http:
                archived, archive_took, archive_worst = await _worst_health_wait(
                    http, lambda: log_archive.archive_match("m1")
                )
                await db.execute_write(
                    "UPDATE match_retention SET archived_at = datetime(archived_at, '-3 days'),"
                    " archived_updated_at = datetime(archived_updated_at, '-3 days')",
                    (),
                )
                # D1_HOT_DAYS pass: the whole match moves back, as time would
                # leave it, so its chunks are still older than the archive.
                await db.execute_write("UPDATE session_logs SET updated_at = datetime(updated_at, '-3 days')", ())
                await db.execute_write(
                    "UPDATE session_log_chunks SET created_at = datetime(created_at, '-3 days')", ()
                )
                evicted = await log_archive.evict_match("m1")
                left = await db.query("SELECT COUNT(*) AS n FROM session_log_chunks", ())

                async def export():
                    lines = 0
                    path = "/admin/api/session-logs/1/export?format=jsonl"
                    async with http.stream("GET", path, headers={"X-Admin-Key": "k"}) as resp:
                        assert resp.status_code == 200
                        async for chunk in resp.aiter_bytes():
                            lines += chunk.count(b"\n")
                        return resp.headers["x-entry-count"], lines

                exported, export_took, export_worst = await _worst_health_wait(http, export)
            return archived, evicted, left[0]["n"], (archive_took, archive_worst), exported, (export_took, export_worst)
        finally:
            await db.close_db()

    archived, evicted, left, archive_timing, (entry_count, lines), export_timing = run_async(scenario())
    assert archived and evicted and left == 0
    assert entry_count == str(FLUSHES * ENTRIES_PER_FLUSH)
    assert lines == FLUSHES * ENTRIES_PER_FLUSH + 1
    _assert_loop_stayed_free(*archive_timing)
    _assert_loop_stayed_free(*export_timing)
