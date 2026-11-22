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
