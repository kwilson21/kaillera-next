"""Archiving a match's session log to the blob store, and evicting it from D1.

One test per scenario in specs/log_archive.qnt, named after it, plus the
reader checks the design doc asks for (§7: "admin detail, export and
input-audit return identical data before and after eviction").

Run: cd server && uv run --extra dev pytest ../tests/test_log_archive.py -q
"""

from __future__ import annotations

import asyncio
import gzip
import json

import pytest
from db_test_support import run_async


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("LOG_RETENTION_DAYS", "7")
    monkeypatch.setenv("FLAGGED_STALE_DAYS", "180")
    monkeypatch.delenv("D1_HOT_DAYS", raising=False)
    monkeypatch.delenv("PARQUET_DIR", raising=False)
    # The store here is a local folder, which isn't durable: the archive runs
    # into it only because tests opt in (log_archive.archive_enabled).
    monkeypatch.setenv("LOG_ARCHIVE_LOCAL", "1")


MATCH = "11111111-1111-4111-8111-111111111111"


class CountingStore:
    """A LocalBlobStore that records its puts and can fail a chosen one."""

    name = "counting"
    durable = False  # a local folder, as without R2

    def __init__(self, inner, fail_on: str | None = None):
        self.inner = inner
        self.fail_on = fail_on
        self.puts: list[str] = []
        self.after_put = None

    async def put(self, key, data, content_type="application/octet-stream"):
        from src.blobstore import BlobStoreError

        if self.fail_on and self.fail_on in key:
            raise BlobStoreError(f"refused {key}")
        self.puts.append(key)
        await self.inner.put(key, data, content_type)
        if self.after_put:
            await self.after_put(key)

    async def get(self, key):
        return await self.inner.get(key)

    async def delete(self, keys):
        await self.inner.delete(keys)

    async def delete_prefix(self, prefix):
        await self.inner.delete_prefix(prefix)

    async def list_match_prefixes(self, *, after=None, limit=500):
        return await self.inner.list_match_prefixes(after=after, limit=limit)


def with_db(tmp_path, body, *, fail_on=None):
    """Run `body(db, store)` against a fresh database and blob store.

    Closes the database even when an assert fails: aiosqlite's connection
    worker is not a daemon thread, so a database left open keeps the pytest
    process alive after the run.
    """

    async def run():
        import src.db as db
        from src.blobstore import LocalBlobStore

        store = CountingStore(LocalBlobStore(tmp_path / "blobs"), fail_on)
        # register_match writes at most once per process per match, and every
        # test here uses the same id against its own fresh database.
        db._registered_matches.clear()
        db._upload_check_cache.clear()
        await db.init_db(str(tmp_path / "kn.db"), blobs=store)
        try:
            await body(db, store)
        finally:
            await db.close_db()

    run_async(run())


async def _flush(db, slot, entries, audit=None, *, seq_base=0):
    payload = {
        "match_id": MATCH,
        "room": "ROOM1",
        "slot": slot,
        "player_name": f"P{slot}",
        "mode": "rollback",
        "epoch": "e1",
        "entries": [{"seq": seq_base + i, "f": i, "msg": msg} for i, msg in enumerate(entries)],
        "context": json.dumps({"delay": 3, "slot": slot}),
    }
    if audit is not None:
        payload["audit_epoch"] = "a1"
        payload["audit_entries"] = [{"seq": seq_base + i, "f": i, "s": "L", "b": v} for i, v in enumerate(audit)]
    return await db.append_session_flush(payload)


async def _match(db, *, slots=(0, 1), ended_minutes_ago=None):
    await db.register_match(MATCH, "ROOM1")
    for slot in slots:
        await _flush(db, slot, [f"TICK slot={slot} a", f"[C] rb slot={slot}"], audit=[1, 2])
    if ended_minutes_ago is not None:
        await _ended(db, ended_minutes_ago)


async def _ended(db, minutes_ago):
    """The match ended that many minutes ago, flushes and all.

    The stored rows are aged with it: a real archive runs at least 30 minutes
    after the last flush (the ingest window), and what the eviction clears
    turns on `session_logs.updated_at` being older than `archived_at`.
    """
    offset = f"-{minutes_ago} minutes"
    for statement in (
        "UPDATE match_retention SET ended_at = datetime('now', ?) WHERE match_id = ?",
        "UPDATE session_logs SET updated_at = datetime(updated_at, ?), created_at = datetime(created_at, ?)"
        " WHERE match_id = ?",
        "UPDATE session_log_chunks SET created_at = datetime(created_at, ?) WHERE match_id = ?",
        "UPDATE session_log_evictions SET updated_at = datetime(updated_at, ?) WHERE match_id = ?",
    ):
        params = (offset, offset, MATCH) if statement.startswith("UPDATE session_logs") else (offset, MATCH)
        await db.execute_write(statement, params)


async def _hot_days_pass(db):
    """Move the match's whole history back three days, so its archive is due
    for eviction. Only `archived_at` would invert its order against the
    session rows' `updated_at`, which decides what the eviction clears."""
    for statement, params in (
        (
            "UPDATE match_retention SET archived_at = datetime(archived_at, '-3 days'),"
            " archived_updated_at = datetime(archived_updated_at, '-3 days') WHERE match_id = ?",
            (MATCH,),
        ),
        (
            "UPDATE session_logs SET updated_at = datetime(updated_at, '-3 days'),"
            " created_at = datetime(created_at, '-3 days') WHERE match_id = ?",
            (MATCH,),
        ),
        (
            "UPDATE session_log_chunks SET created_at = datetime(created_at, '-3 days') WHERE match_id = ?",
            (MATCH,),
        ),
        (
            "UPDATE session_log_evictions SET updated_at = datetime(updated_at, '-3 days') WHERE match_id = ?",
            (MATCH,),
        ),
    ):
        await db.execute_write(statement, params)


async def _retention_row(db):
    rows = await db.query("SELECT * FROM match_retention WHERE match_id = ?", (MATCH,))
    return rows[0] if rows else None


async def _archived_through(db):
    row = await _retention_row(db)
    return row["archived_max_chunk_id"] if row else None


async def _token(db):
    """The recorded attempt's token, which its object keys carry."""
    row = await _retention_row(db)
    return row["archive_token"] if row else None


def _objects(tmp_path):
    """Every object the blob store holds for the match."""
    root = tmp_path / "blobs" / "matches" / MATCH
    return sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()) if root.exists() else []


async def _chunk_ids(db):
    rows = await db.query("SELECT id FROM session_log_chunks WHERE match_id = ? ORDER BY id", (MATCH,))
    return [r["id"] for r in rows]


async def _read(db, slot):
    """What the admin endpoints show for one slot: log, audit and context."""
    rows = await db.query("SELECT log_data, context FROM session_logs WHERE match_id = ? AND slot IS ?", (MATCH, slot))
    stored = rows[0] if rows else {}
    count, through = await db.count_log_entries(MATCH, slot)
    streamed: list = []
    async for page in db.iter_chunk_entries(MATCH, slot, through_id=through):
        streamed.extend(page)
    return {
        "detail": await db.get_full_log_entries(MATCH, slot, stored.get("log_data")),
        "count": count,
        "streamed": streamed,
        "audit": await db.get_input_audit(MATCH, slot),
        "context": await db.get_session_context(MATCH, slot, stored.get("context")),
    }


def _msgs(entries):
    return [e.get("msg") for e in entries]


# ── archiveThenEvictTest ─────────────────────────────────────────────────────


def test_a_closed_match_is_archived_and_then_evicted(tmp_path):
    """The model's archiveThenEvictTest: archived once the window has closed,
    evicted D1_HOT_DAYS later, and a reader gets the same log throughout."""

    async def body(db, store):
        from src import log_archive

        await _match(db, ended_minutes_ago=45)
        before = {slot: await _read(db, slot) for slot in (0, 1)}

        assert await log_archive.sweep() == (1, 0)
        row = await _retention_row(db)
        assert row["archived_at"] and row["archived_max_chunk_id"] == max(await _chunk_ids(db))
        assert row["archive_bytes"] > 0 and row["evicted_at"] is None
        # Archived, but nothing has left D1 yet: these are the D1 reads.
        assert {slot: await _read(db, slot) for slot in (0, 1)} == before
        assert await _chunk_ids(db)

        await _hot_days_pass(db)
        assert await log_archive.sweep() == (0, 1)
        assert await _chunk_ids(db) == []
        assert (await _retention_row(db))["evicted_at"]
        # The eviction cleared the rows' own `log_data` and `context`, so
        # these reads come from the archive.
        stored = await db.query("SELECT log_data, context FROM session_logs WHERE match_id = ?", (MATCH,))
        assert [(r["log_data"], r["context"]) for r in stored] == [("[]", None), ("[]", None)]
        after = {slot: await _read(db, slot) for slot in (0, 1)}
        assert after == before
        assert _msgs(after[0]["detail"]) == ["TICK slot=0 a", "[C] rb slot=0"]
        assert after[0]["context"] and json.loads(after[0]["context"])["slot"] == 0
        assert [r["b"] for r in after[0]["audit"]] == [1, 2]

    with_db(tmp_path, body)


def test_nothing_is_archived_while_the_upload_window_is_open(tmp_path):
    """Before the window closes a page can still upload, so nothing moves."""

    async def body(db, store):
        from src import log_archive

        await _match(db, ended_minutes_ago=5)
        assert await log_archive.sweep() == (0, 0)
        # Nor on its own: a CLI or a test can't archive a live match either.
        assert await log_archive.archive_match(MATCH) is False
        assert (await _retention_row(db))["archived_at"] is None
        assert store.puts == []
        assert await _chunk_ids(db)

    with_db(tmp_path, body)


# ── failedUploadTest ─────────────────────────────────────────────────────────


def test_a_failed_upload_leaves_the_match_un_archived(tmp_path):
    """The model's failedUploadTest: nothing is recorded, so nothing is
    evicted, and the next sweep archives the match once the store works."""

    async def body(db, store):
        from src import log_archive

        await _match(db, ended_minutes_ago=45)
        assert await log_archive.archive_match(MATCH) is False
        row = await _retention_row(db)
        assert row["archived_at"] is None and row["archived_max_chunk_id"] is None
        assert await _chunk_ids(db)
        # Slot 0's objects landed before slot 1's upload failed, and were
        # taken back: an archive that is not recorded leaves nothing
        # (specs/log_archive.qnt, noStrayObjects).
        assert any(".entries.jsonl.gz" in key for key in store.puts)
        assert _objects(tmp_path) == []

        store.fail_on = None
        assert await log_archive.archive_match(MATCH) is True
        assert (await _retention_row(db))["archived_at"]
        assert await _read(db, 0)

    with_db(tmp_path, body, fail_on="/1.entries")


# ── refusedRecordTest ────────────────────────────────────────────────────────


def test_an_attempt_that_loses_the_race_removes_only_its_own_objects(tmp_path):
    """The model's refusedRecordTest: the record is refused because another
    attempt archived the match first (two servers sweep during a deploy).

    The loser deletes what it uploaded and the winner's objects stay: each
    attempt's keys carry a token of its own. Keyed by the chunk id, both
    would have uploaded through the same id to the same keys
    (log_archive_key_by_through).
    """

    async def body(db, store):
        from src import log_archive

        await _match(db, slots=(0,), ended_minutes_ago=45)
        through = max(await _chunk_ids(db))
        await db.put_blob(log_archive.entries_key(MATCH, 0, "winner"), b"winner")

        async def archive_first(key):
            await db.execute_write(
                "UPDATE match_retention SET archived_at = datetime('now'), archived_max_chunk_id = ?,"
                " archive_token = 'winner' WHERE match_id = ? AND archived_at IS NULL",
                (through, MATCH),
            )

        store.after_put = archive_first
        assert await log_archive.archive_match(MATCH) is False
        row = await _retention_row(db)
        assert row["archive_token"] == "winner" and row["archived_max_chunk_id"] == through
        assert _objects(tmp_path) == ["sessions/winner/0.entries.jsonl.gz"]

    with_db(tmp_path, body)


def test_two_archives_at_once_leave_one_complete_archive(tmp_path):
    """Two servers' sweeps archive the same match concurrently, interleaving
    every upload. One records; the other takes back its own objects; the
    recorded archive is whole, and reads the same after eviction."""

    async def body(db, store):
        from src import log_archive

        await _match(db, ended_minutes_ago=45)
        before = {slot: await _read(db, slot) for slot in (0, 1)}

        async def yield_after_put(key):
            await asyncio.sleep(0)

        store.after_put = yield_after_put
        results = await asyncio.gather(log_archive.archive_match(MATCH), log_archive.archive_match(MATCH))
        assert sorted(results) == [False, True]
        token = await _token(db)
        assert {key.split("/")[1] for key in _objects(tmp_path) if key.startswith("sessions/")} == {token}

        await _hot_days_pass(db)
        assert await log_archive.evict_match(MATCH) is True
        assert await _chunk_ids(db) == []
        assert {slot: await _read(db, slot) for slot in (0, 1)} == before

    with_db(tmp_path, body)


# ── lateChunkTest and chunkAfterEvictionTest ─────────────────────────────────


def test_a_chunk_written_after_the_archive_is_not_evicted(tmp_path):
    """The model's lateChunkTest: the Socket.IO path takes a room's live
    match past its window, so a chunk can land after the archive. It stays in
    D1 and a reader still gets the whole log, in order."""

    async def body(db, store):
        from src import log_archive

        await _match(db, slots=(0,), ended_minutes_ago=45)
        assert await log_archive.archive_match(MATCH) is True
        archived_max = await _archived_through(db)
        await _flush(db, 0, ["TICK late"], seq_base=50)
        late = [cid for cid in await _chunk_ids(db) if cid > archived_max]
        assert len(late) == 1

        await _hot_days_pass(db)
        assert await log_archive.evict_match(MATCH) is True
        assert await _chunk_ids(db) == late
        read = await _read(db, 0)
        assert _msgs(read["detail"]) == ["TICK slot=0 a", "[C] rb slot=0", "TICK late"]
        assert read["count"] == 3 and _msgs(read["streamed"]) == _msgs(read["detail"])
        # The late flush rewrote `context` after the archive read it, so the
        # eviction left that row's own copy in place.
        stored = await db.query("SELECT context FROM session_logs WHERE match_id = ?", (MATCH,))
        assert stored[0]["context"] is not None
        assert json.loads(read["context"])["slot"] == 0

    with_db(tmp_path, body)


def test_a_chunk_written_after_the_eviction_is_read_after_the_archive(tmp_path):
    """The model's chunkAfterEvictionTest: a flush that lands once the chunks
    have gone is read from D1, after the archived ones."""

    async def body(db, store):
        from src import log_archive

        await _match(db, slots=(0,), ended_minutes_ago=45)
        assert await log_archive.archive_match(MATCH) is True
        await _hot_days_pass(db)
        assert await log_archive.evict_match(MATCH) is True
        await _flush(db, 0, ["TICK after eviction"], seq_base=90)
        read = await _read(db, 0)
        assert _msgs(read["detail"]) == ["TICK slot=0 a", "[C] rb slot=0", "TICK after eviction"]
        assert read["count"] == 3
        assert _msgs(read["streamed"]) == _msgs(read["detail"])

    with_db(tmp_path, body)


# ── partialEvictionTest and deleteAgainAfterReuseTest ────────────────────────


def test_a_partial_eviction_reads_the_same_and_the_next_sweep_finishes_it(tmp_path):
    """The model's partialEvictionTest: D1's HTTP batch is not documented as a
    transaction, so the eviction can stop after setting evicted_at. The
    archived chunks still in D1 are read once, from the archive (reading
    every chunk left in D1 would read them twice), and the next sweep
    finishes the DELETE."""

    async def body(db, store):
        from src import log_archive

        await _match(db, ended_minutes_ago=45)
        before = {slot: await _read(db, slot) for slot in (0, 1)}
        assert await log_archive.archive_match(MATCH) is True
        await _hot_days_pass(db)
        # The batch's first statement alone.
        await db.execute_write("UPDATE match_retention SET evicted_at = datetime('now') WHERE match_id = ?", (MATCH,))
        assert await _chunk_ids(db)
        assert {slot: await _read(db, slot) for slot in (0, 1)} == before

        assert await log_archive.sweep() == (0, 1)
        assert await _chunk_ids(db) == []
        assert {slot: await _read(db, slot) for slot in (0, 1)} == before

    with_db(tmp_path, body)


def test_a_delete_run_again_keeps_a_chunk_that_reused_an_archived_id(tmp_path):
    """The model's deleteAgainAfterReuseTest: once the eviction has deleted
    the newest rows, SQLite gives the next chunk an id the archive covers. A
    second run of the eviction (a second server's sweep) must not take it:
    the DELETE picks the archive's chunks by created_at as well as by id."""

    async def body(db, store):
        from src import log_archive

        await _match(db, slots=(0,), ended_minutes_ago=45)
        assert await log_archive.archive_match(MATCH) is True
        through = await _archived_through(db)
        await _hot_days_pass(db)
        assert await log_archive.evict_match(MATCH) is True
        await _flush(db, 0, ["TICK after eviction"], seq_base=90)
        reused = await _chunk_ids(db)
        assert len(reused) == 1 and reused[0] <= through, "the table was emptied, so SQLite reuses the id"

        assert await log_archive.evict_match(MATCH) is True
        assert await _chunk_ids(db) == reused
        assert _msgs((await _read(db, 0))["detail"]) == ["TICK slot=0 a", "[C] rb slot=0", "TICK after eviction"]

    with_db(tmp_path, body)


# ── An archive that can't be read ────────────────────────────────────────────


def test_an_unreadable_archive_is_an_error_not_an_empty_log(tmp_path):
    """Once evicted, the chunks are gone from D1, so a missing object or a
    failed fetch must not read as a log that never had them."""

    async def body(db, store):
        from src import log_archive
        from src.blobstore import BlobStoreError

        await _match(db, slots=(0,), ended_minutes_ago=45)
        assert await log_archive.archive_match(MATCH) is True
        token = await _token(db)
        await _hot_days_pass(db)
        assert await log_archive.evict_match(MATCH) is True

        await db.delete_blobs([log_archive.entries_key(MATCH, 0, token)])
        with pytest.raises(log_archive.ArchiveUnreadable, match="missing"):
            await db.get_full_log_entries(MATCH, 0, None)
        with pytest.raises(log_archive.ArchiveUnreadable, match="missing"):
            await db.count_log_entries(MATCH, 0)

        async def broken_get(key):
            raise BlobStoreError("R2 get_object failed: InternalError")

        store.get = broken_get
        with pytest.raises(log_archive.ArchiveUnreadable, match="unreadable"):
            await db.get_input_audit(MATCH, 0)
        with pytest.raises(log_archive.ArchiveUnreadable, match="unreadable"):
            await db.get_session_context(MATCH, 0, None)

    with_db(tmp_path, body)


def test_a_slot_first_written_after_the_archive_reads_from_the_database(tmp_path):
    """A slot whose first flush came after the archive has no objects; that is
    expected, not an error, and its log is read from D1."""

    async def body(db, store):
        from src import log_archive

        await _match(db, slots=(0,), ended_minutes_ago=45)
        assert await log_archive.archive_match(MATCH) is True
        await _hot_days_pass(db)
        assert await log_archive.evict_match(MATCH) is True
        await _flush(db, 1, ["TICK new slot"])
        read = await _read(db, 1)
        assert _msgs(read["detail"]) == ["TICK new slot"] and read["count"] == 1
        assert json.loads(read["context"])["slot"] == 1

    with_db(tmp_path, body)


def test_the_admin_endpoints_read_an_evicted_match_and_answer_502_without_its_archive(tmp_path, monkeypatch):
    """Through the HTTP API: detail, export and input-audit return the same
    before and after eviction, and 502 naming the object once it is gone."""
    import httpx

    monkeypatch.setenv("ADMIN_KEY", "k")
    from src.api import app as appmod

    monkeypatch.setattr(appmod, "check_ip", lambda ip, event: True)

    async def body(db, store):
        from src import log_archive

        await _match(db, ended_minutes_ago=45)
        key = {"X-Admin-Key": "k"}
        ids = [r["id"] for r in await db.query("SELECT id FROM session_logs ORDER BY slot", ())]

        async def responses():
            transport = httpx.ASGITransport(app=appmod.create_app())
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
                out = []
                for log_id in ids:
                    detail = await http.get(f"/admin/api/session-logs/{log_id}", headers=key)
                    export = await http.get(f"/admin/api/session-logs/{log_id}/export", headers=key)
                    out.append((detail.status_code, detail.json(), export.status_code, export.text))
                audit = await http.get(f"/admin/api/input-audit/{MATCH}", headers=key)
                out.append((audit.status_code, audit.json()))
                return out

        before = await responses()
        assert all(r[0] == 200 for r in before)
        assert await log_archive.archive_match(MATCH) is True
        token = await _token(db)
        await _hot_days_pass(db)
        assert await log_archive.evict_match(MATCH) is True
        after = await responses()
        # The detail carries the row as stored: its cleared columns and
        # updated_at differ; the log, summary and context do not.
        for b, a in zip(before[:-1], after[:-1], strict=True):
            assert a[0] == 200 and a[2] == 200
            for field in ("log_data", "context", "summary", "match_id", "slot"):
                assert a[1][field] == b[1][field], field
            assert a[3].splitlines()[1:] == b[3].splitlines()[1:]
        assert after[-1] == before[-1]

        await db.delete_blobs([log_archive.entries_key(MATCH, 0, token)])
        transport = httpx.ASGITransport(app=appmod.create_app())
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
            detail = await http.get(f"/admin/api/session-logs/{ids[0]}", headers=key)
            export = await http.get(f"/admin/api/session-logs/{ids[0]}/export", headers=key)
        assert detail.status_code == 502 and "missing" in detail.json()["detail"]
        assert export.status_code == 502

    with_db(tmp_path, body)


# ── deleteDuringArchiveTest ──────────────────────────────────────────────────


def test_a_delete_that_starts_during_the_archive_takes_the_upload_with_it(tmp_path):
    """The model's deleteDuringArchiveTest: retention's prefix delete can run
    between an upload and its record, so a record refused for a tombstone
    deletes what it uploaded (retentionLeavesNothing)."""

    async def body(db, store):
        from src import log_archive

        await _match(db, ended_minutes_ago=45)
        tombstoned: list[bool] = []

        async def tombstone(key):
            if not tombstoned:
                tombstoned.append(True)
                await db.execute_write(
                    "UPDATE match_retention SET deleting_at = datetime('now') WHERE match_id = ?", (MATCH,)
                )

        store.after_put = tombstone
        assert await log_archive.archive_match(MATCH) is False
        row = await _retention_row(db)
        assert row["archived_at"] is None and row["deleting_at"]
        assert _objects(tmp_path) == []

    with_db(tmp_path, body)


def test_a_tombstoned_match_is_neither_archived_nor_evicted(tmp_path):
    """A match being deleted is skipped by both steps (spec §1)."""

    async def body(db, store):
        from src import log_archive

        await _match(db, ended_minutes_ago=45)
        assert await log_archive.archive_match(MATCH) is True
        await _hot_days_pass(db)
        await db.execute_write(
            "UPDATE match_retention SET deleting_at = datetime('now') WHERE match_id = ?", (MATCH,)
        )
        assert await log_archive.evict_match(MATCH) is False
        assert await _chunk_ids(db)
        assert (await _retention_row(db))["evicted_at"] is None
        assert await log_archive.sweep() == (0, 0)

    with_db(tmp_path, body)


# ── Retention ────────────────────────────────────────────────────────────────


def test_retention_deletes_an_evicted_match_and_its_archive(tmp_path):
    """The whole `matches/<id>/` prefix goes with the match, archive included."""

    async def body(db, store):
        from src import log_archive, retention

        await _match(db, ended_minutes_ago=45)
        assert await log_archive.archive_match(MATCH) is True
        token = await _token(db)
        await _hot_days_pass(db)
        assert await log_archive.evict_match(MATCH) is True
        assert await db.get_blob(log_archive.entries_key(MATCH, 0, token)) is not None

        await _ended(db, 30 * 24 * 60)
        await retention.sweep(include_unregistered=False)
        assert await _retention_row(db) is None
        assert _objects(tmp_path) == []
        assert await db.query("SELECT COUNT(*) AS n FROM session_logs WHERE match_id = ?", (MATCH,)) == [{"n": 0}]

    with_db(tmp_path, body)


def test_an_old_match_with_no_retention_row_is_registered_and_archived(tmp_path):
    """The design doc's backfill: matches from before registration existed
    get a row, so the sweep archives them instead of leaving them in D1."""

    async def body(db, store):
        from src import log_archive

        await _flush(db, 0, ["TICK old"])
        await db.execute_write("DELETE FROM match_retention WHERE match_id = ?", (MATCH,))
        await db.execute_write(
            "UPDATE session_logs SET updated_at = datetime('now', '-2 days'),"
            " created_at = datetime('now', '-2 days') WHERE match_id = ?",
            (MATCH,),
        )
        assert await log_archive.sweep() == (1, 0)
        row = await _retention_row(db)
        assert row["room"] == "ROOM1" and row["archived_at"]

    with_db(tmp_path, body)


def test_a_match_past_its_retention_window_is_not_registered_for_the_archive(tmp_path):
    """An unregistered match older than the window is deleted by the
    unregistered pass, not uploaded first."""

    async def body(db, store):
        from src import log_archive

        await _flush(db, 0, ["TICK ancient"])
        await db.execute_write("DELETE FROM match_retention WHERE match_id = ?", (MATCH,))
        await db.execute_write(
            "UPDATE session_logs SET updated_at = datetime('now', '-30 days'),"
            " created_at = datetime('now', '-30 days') WHERE match_id = ?",
            (MATCH,),
        )
        assert await log_archive.register_old_matches() == 0
        assert await _retention_row(db) is None
        assert store.puts == []

    with_db(tmp_path, body)


# ── The archived objects ─────────────────────────────────────────────────────


def test_the_archived_objects_hold_the_log_the_audit_and_the_context(tmp_path):
    """One gzipped object per stream per slot, plus the context, under the
    match's prefix — JSON Lines, as the design doc's §1 step 2 names them."""

    async def body(db, store):
        from src import log_archive

        await _match(db, slots=(0,), ended_minutes_ago=45)
        assert await log_archive.archive_match(MATCH) is True
        token = await _token(db)

        base = f"matches/{MATCH}/sessions/{token}/0"
        entries = gzip.decompress(await db.get_blob(f"{base}.entries.jsonl.gz")).splitlines()
        assert [json.loads(line)["msg"] for line in entries] == ["TICK slot=0 a", "[C] rb slot=0"]
        audit = gzip.decompress(await db.get_blob(f"{base}.audit.jsonl.gz")).splitlines()
        assert [json.loads(line)["b"] for line in audit] == [1, 2]
        context = gzip.decompress(await db.get_blob(f"{base}.context.json.gz"))
        assert json.loads(context)["delay"] == 3

        # The rotation's Parquet copy goes up too, and the metrics row points
        # at it instead of this instance's disk, which a deploy wipes.
        key = f"matches/{MATCH}/sessions/{token}/entries.zstd.parquet"
        assert key in store.puts
        rows = await db.query("SELECT parquet_path FROM match_metrics WHERE match_id = ?", (MATCH,))
        assert rows[0]["parquet_path"] == key

    with_db(tmp_path, body)


def test_a_size_caps_eviction_lines_are_archived_with_the_log(tmp_path):
    """A log whose oldest lines a cap deleted says so first, before and after
    eviction (specs/session_log_store.qnt, truncationIsVisible)."""

    async def body(db, store):
        from src import db as dbmod
        from src import log_archive

        await db.register_match(MATCH, "ROOM1")
        await _flush(db, 0, ["TICK first"])
        await db.execute_write(
            "INSERT INTO session_log_evictions (match_id, slot, kind, entries, through_seq)"
            " VALUES (?, 0, 'log', 7, 3)",
            (MATCH,),
        )
        await _ended(db, 45)
        before = await _read(db, 0)
        assert dbmod.SERVER_LOG_EVICTED in before["detail"][0]["msg"]

        assert await log_archive.archive_match(MATCH) is True
        await _hot_days_pass(db)
        assert await log_archive.evict_match(MATCH) is True
        after = await _read(db, 0)
        assert after == before
        assert dbmod.SERVER_LOG_EVICTED in after["detail"][0]["msg"]

    with_db(tmp_path, body)


def test_a_slotless_session_is_archived_under_slot_none(tmp_path):
    """A page that never claimed a slot stores NULL; its objects need a name."""

    async def body(db, store):
        from src import log_archive

        await db.register_match(MATCH, "ROOM1")
        await _flush(db, None, ["TICK no slot"])
        await _ended(db, 45)
        before = await _read(db, None)
        assert await log_archive.archive_match(MATCH) is True
        token = await _token(db)
        assert await db.get_blob(f"matches/{MATCH}/sessions/{token}/slot-none.entries.jsonl.gz") is not None
        await _hot_days_pass(db)
        assert await log_archive.evict_match(MATCH) is True
        assert await _read(db, None) == before

    with_db(tmp_path, body)


def test_legacy_entries_are_read_once_after_a_late_flush_keeps_the_row(tmp_path):
    """The archive's log object starts with a row's legacy `log_data`. A
    flush after the archive keeps the row from being cleared, so readers past
    evicted_at take legacy entries from the archive alone."""

    async def body(db, store):
        from src import log_archive

        await _match(db, slots=(0,), ended_minutes_ago=45)
        legacy = json.dumps([{"msg": "legacy"}])
        await db.execute_write("UPDATE session_logs SET log_data = ? WHERE match_id = ?", (legacy, MATCH))
        before = await _read(db, 0)
        assert _msgs(before["detail"])[0] == "legacy"
        assert await log_archive.archive_match(MATCH) is True
        await _flush(db, 0, ["TICK late"], seq_base=50)
        await _hot_days_pass(db)
        assert await log_archive.evict_match(MATCH) is True

        read = await _read(db, 0)
        assert _msgs(read["detail"]) == ["legacy", "TICK slot=0 a", "[C] rb slot=0", "TICK late"]
        # The export's own legacy entries are none now (the archive holds
        # them), so its total is the count, the same as the detail.
        assert await db.legacy_log_entries(MATCH, legacy) == []
        assert read["count"] == 4 and _msgs(read["streamed"]) == _msgs(read["detail"])

    with_db(tmp_path, body)


def test_lines_a_cap_deletes_after_the_archive_are_shown_where_the_archive_ends(tmp_path):
    """A live match past its window can flush after the archive and hit a
    size cap. The archive's first lines say what had gone before it; D1's
    record, changed since, is shown where the archive's entries end."""

    async def body(db, store):
        from src import db as dbmod
        from src import log_archive

        await _match(db, slots=(0,), ended_minutes_ago=45)
        assert await log_archive.archive_match(MATCH) is True
        await _flush(db, 0, ["TICK late"], seq_base=50)
        await db.execute_write(
            "INSERT INTO session_log_evictions (match_id, slot, kind, entries, through_seq) VALUES (?, 0, 'log', 4, 51)",
            (MATCH,),
        )
        await _hot_days_pass(db)
        await db.execute_write(
            "UPDATE session_log_evictions SET updated_at = datetime('now') WHERE match_id = ?", (MATCH,)
        )
        assert await log_archive.evict_match(MATCH) is True

        read = await _read(db, 0)
        msgs = _msgs(read["detail"])
        assert msgs[:2] == ["TICK slot=0 a", "[C] rb slot=0"]
        assert msgs[2].startswith(f"{dbmod.SERVER_LOG_EVICTED} kind=log entries=4 through_seq=51")
        assert msgs[3:] == ["TICK late"]
        assert read["count"] == 4 and _msgs(read["streamed"]) == msgs

    with_db(tmp_path, body)


def test_an_evicted_flagged_match_still_counts_against_the_flagged_budget(tmp_path):
    """Its chunks left D1, but its archive is kept as long as the match, so
    the budget counts the archive in their place."""

    async def body(db, store):
        from src import log_archive

        await _match(db, ended_minutes_ago=45)
        await db.execute_write("UPDATE match_retention SET tier = 'flagged' WHERE match_id = ?", (MATCH,))
        chunk_bytes = (await db.query("SELECT SUM(size) AS n FROM session_log_chunks", ()))[0]["n"]
        assert await db._flagged_bytes() == chunk_bytes
        assert await log_archive.archive_match(MATCH) is True
        assert await db._flagged_bytes() == chunk_bytes, "archived but not evicted: the chunks still count"
        await _hot_days_pass(db)
        assert await log_archive.evict_match(MATCH) is True
        archive_bytes = (await _retention_row(db))["archive_bytes"]
        assert archive_bytes > 0
        assert await db._flagged_bytes() == archive_bytes

    with_db(tmp_path, body)


def test_a_rotation_after_the_archive_keeps_the_uploaded_parquet_key(tmp_path):
    """The minute sweeper or a forced backfill can rotate the match again; it
    writes to this instance's disk, and the row keeps pointing at R2."""

    async def body(db, store):
        from src import log_archive, match_rotation

        await _match(db, slots=(0,), ended_minutes_ago=45)
        assert await log_archive.archive_match(MATCH) is True
        key = f"matches/{MATCH}/sessions/{await _token(db)}/entries.zstd.parquet"
        before = await db.query("SELECT parquet_path, parquet_bytes FROM match_metrics", ())
        assert before[0]["parquet_path"] == key
        await match_rotation.rotate_match(MATCH)
        assert await db.query("SELECT parquet_path, parquet_bytes FROM match_metrics", ()) == before

    with_db(tmp_path, body)


def test_without_a_durable_store_nothing_is_archived_or_evicted(tmp_path, monkeypatch, caplog):
    """The model's localStoreTest: without R2 the blob store is a folder that a
    deploy wipes. An archive there would be evicted from D1 and lost at the
    next deploy, so the archive stays off and the log stays in D1, and the
    log says so once."""
    import logging

    monkeypatch.delenv("LOG_ARCHIVE_LOCAL")

    async def body(db, store):
        from src import log_archive

        monkeypatch.setattr(log_archive, "_warned_not_durable", False)
        await _match(db, ended_minutes_ago=45)
        before = {slot: await _read(db, slot) for slot in (0, 1)}
        with caplog.at_level(logging.WARNING, logger="src.log_archive"):
            assert log_archive.archive_enabled() is False
            assert await log_archive.sweep() == (0, 0)
            assert await log_archive.archive_match(MATCH) is False
        assert (await _retention_row(db))["archived_at"] is None
        # Even an archived match isn't evicted into it.
        await db.execute_write(
            "UPDATE match_retention SET archived_at = datetime('now', '-3 days'), archived_max_chunk_id = 99,"
            " archive_token = 'x' WHERE match_id = ?",
            (MATCH,),
        )
        assert await log_archive.evict_match(MATCH) is False
        assert await _chunk_ids(db)
        assert (await _retention_row(db))["evicted_at"] is None
        assert store.puts == []
        assert {slot: await _read(db, slot) for slot in (0, 1)} == before
        warnings = [r for r in caplog.records if "Log archive is off" in r.getMessage()]
        assert len(warnings) == 1

    with_db(tmp_path, body)


def test_only_r2_is_a_durable_store(tmp_path):
    from src.blobstore import LocalBlobStore, R2BlobStore

    assert LocalBlobStore(tmp_path).durable is False
    assert R2BlobStore("acct", "key", "secret", "bucket", client=object()).durable is True


def test_hot_days_is_never_zero(monkeypatch):
    """D1_HOT_DAYS=0 would evict a match the moment it was archived."""
    from src import log_archive

    monkeypatch.setenv("D1_HOT_DAYS", "0")
    assert log_archive.hot_days() == 1
    monkeypatch.setenv("D1_HOT_DAYS", "not a number")
    assert log_archive.hot_days() == 2
    monkeypatch.setenv("D1_HOT_DAYS", "5")
    assert log_archive.hot_days() == 5
