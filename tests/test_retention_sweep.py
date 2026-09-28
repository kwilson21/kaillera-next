"""Tiered retention sweep: normal matches go after LOG_RETENTION_DAYS, flagged
ones are kept until resolved (or stale), and deletion survives interruption.

Run: cd server && uv run --extra dev pytest ../tests/test_retention_sweep.py -q
"""

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
    monkeypatch.delenv("BUDGET_AUTO_FLAGGED_BYTES", raising=False)


JPEG = b"\xff\xd8jpeg"


async def _open(tmp_path):
    import src.db as db
    from src.blobstore import LocalBlobStore

    await db.init_db(str(tmp_path / "kn.db"), blobs=LocalBlobStore(tmp_path / "blobs"))
    return db


async def _match(db, match_id, *, ended_days_ago=None, created_days_ago=0):
    """A registered match with a session log, a chunk, a screenshot, a client
    event and a desync verdict, dated the given number of days back."""
    await db.register_match(match_id, "ROOM1")
    base = {"match_id": match_id, "room": "ROOM1", "player_name": "P", "mode": "rollback", "epoch": "e"}
    await db.append_session_log({**base, "slot": 0, "entries": [{"seq": 0, "f": 1, "msg": "TICK f=1"}]})
    await db.insert_screenshot(match_id, 0, 300, JPEG)
    await db.insert_client_event({"type": "stall", "meta": json.dumps({"match_id": match_id}), "room": "ROOM1"})
    await db.execute_write(
        "INSERT INTO desync_events (match_id, frame, field, \"trigger\") VALUES (?, 1, 'f', 't')", (match_id,)
    )
    created = f"-{created_days_ago} days"
    await db.execute_write(
        "UPDATE match_retention SET created_at = datetime('now', ?), last_touched_at = datetime('now', ?) WHERE match_id = ?",
        (created, created, match_id),
    )
    if ended_days_ago is not None:
        await db.execute_write(
            "UPDATE match_retention SET ended_at = datetime('now', ?) WHERE match_id = ?",
            (f"-{ended_days_ago} days", match_id),
        )


_TABLES = ("session_logs", "session_log_chunks", "screenshots", "desync_events")


async def _left(db, match_id, tmp_path):
    counts = {}
    for table in _TABLES:
        rows = await db.query(f"SELECT COUNT(*) AS n FROM {table} WHERE match_id = ?", (match_id,))
        counts[table] = rows[0]["n"]
    events = await db.query(
        "SELECT COUNT(*) AS n FROM client_events WHERE json_extract(meta, '$.match_id') = ?", (match_id,)
    )
    counts["client_events"] = events[0]["n"]
    retention = await db.query("SELECT deleting_at FROM match_retention WHERE match_id = ?", (match_id,))
    counts["match_retention"] = len(retention)
    counts["blobs"] = len(list((tmp_path / "blobs" / "matches" / match_id).rglob("*.jpg")))
    return counts


GONE = dict.fromkeys((*_TABLES, "client_events", "match_retention", "blobs"), 0)
KEPT = dict.fromkeys((*_TABLES, "client_events", "match_retention", "blobs"), 1)


def _sweep_and_count(tmp_path, setup, *match_ids):
    async def scenario():
        from src import retention

        db = await _open(tmp_path)
        try:
            await setup(db)
            await retention.sweep()
            return [await _left(db, m, tmp_path) for m in match_ids]
        finally:
            await db.close_db()

    return run_async(scenario())


def test_normal_match_goes_after_the_retention_window(tmp_path):
    async def setup(db):
        await _match(db, "old", ended_days_ago=8, created_days_ago=8)
        await _match(db, "recent", ended_days_ago=6, created_days_ago=6)

    old, recent = _sweep_and_count(tmp_path, setup, "old", "recent")
    assert old == GONE
    assert recent == KEPT


def test_match_that_never_ended_ages_from_its_start(tmp_path):
    async def setup(db):
        await _match(db, "crashed", created_days_ago=8)

    assert _sweep_and_count(tmp_path, setup, "crashed") == [GONE]


def test_flagged_match_is_kept_until_stale(tmp_path):
    async def setup(db):
        await _match(db, "flagged", ended_days_ago=30, created_days_ago=30)
        await _match(db, "stale", ended_days_ago=200, created_days_ago=200)
        for mid in ("flagged", "stale"):
            await db.flag_match(mid, [{"signal": "TICK-STUCK", "count": 1}])
        await db.execute_write(
            "UPDATE match_retention SET last_touched_at = datetime('now', '-181 days') WHERE match_id = 'stale'", ()
        )

    flagged, stale = _sweep_and_count(tmp_path, setup, "flagged", "stale")
    assert flagged == KEPT
    assert stale == GONE


def test_resolved_match_goes_a_retention_window_after_resolving(tmp_path):
    async def setup(db):
        await _match(db, "resolved-old", ended_days_ago=60, created_days_ago=60)
        await _match(db, "resolved-new", ended_days_ago=60, created_days_ago=60)
        for mid, days in (("resolved-old", 8), ("resolved-new", 6)):
            await db.flag_match(mid, [{"signal": "TICK-STUCK", "count": 1}])
            await db.execute_write(
                "UPDATE match_retention SET resolved_at = datetime('now', ?) WHERE match_id = ?", (f"-{days} days", mid)
            )

    old, new = _sweep_and_count(tmp_path, setup, "resolved-old", "resolved-new")
    assert old == GONE
    assert new == KEPT


def test_interrupted_delete_is_hidden_then_finished(tmp_path):
    """A failed blob delete leaves a tombstoned match that the next sweep finishes."""

    async def scenario():
        import src.db as dbmod
        from src import retention
        from src.blobstore import BlobStoreError

        db = await _open(tmp_path)
        try:
            await _match(db, "old", ended_days_ago=8, created_days_ago=8)
            store = dbmod._blob_store()
            real_delete_prefix = store.delete_prefix

            async def failing(prefix):
                raise BlobStoreError("R2 delete_objects failed: InternalError")

            store.delete_prefix = failing
            await retention.sweep()
            mid = await _left(db, "old", tmp_path)
            tombstone = await db.query("SELECT deleting_at FROM match_retention WHERE match_id = 'old'", ())
            accepts = await db.match_accepts_uploads("old", "ROOM1")
            store.delete_prefix = real_delete_prefix
            await retention.sweep()
            return mid, tombstone[0]["deleting_at"], accepts, await _left(db, "old", tmp_path)
        finally:
            await db.close_db()

    mid, tombstone, accepts, after = run_async(scenario())
    # Client events go first (one scan per sweep); everything else waits for the blobs.
    assert mid == {**KEPT, "client_events": 0} and tombstone is not None and accepts is False
    assert after == GONE


def test_tombstone_is_not_set_on_a_match_flagged_meanwhile(tmp_path):
    """The mark UPDATE re-checks expiry, so a flag landing between the SELECT
    and the UPDATE wins."""

    async def scenario():
        import src.db as dbmod
        from src import retention

        db = await _open(tmp_path)
        try:
            await _match(db, "old", ended_days_ago=8, created_days_ago=8)
            real_query = dbmod.query

            async def query_then_flag(sql, params):
                rows = await real_query(sql, params)
                if "deleting_at IS NULL" in sql and rows:
                    await db.flag_match("old", [{"signal": "feedback", "count": 1}], auto=False)
                return rows

            dbmod.query = query_then_flag
            try:
                marked = await retention.mark_expired()
            finally:
                dbmod.query = real_query
            return marked, await _left(db, "old", tmp_path)
        finally:
            await db.close_db()

    marked, left = run_async(scenario())
    assert marked == [] and left == KEPT


def test_client_events_without_a_match_go_after_the_window(tmp_path):
    async def scenario():
        from src import retention

        db = await _open(tmp_path)
        try:
            await db.insert_client_event({"type": "room_created", "meta": "{}", "room": "R"})
            await db.insert_client_event({"type": "room_created", "meta": "{}", "room": "R"})
            await db.execute_write("UPDATE client_events SET created_at = datetime('now', '-8 days') WHERE id = 1", ())
            await retention.sweep()
            return [r["id"] for r in await db.query("SELECT id FROM client_events", ())]
        finally:
            await db.close_db()

    assert run_async(scenario()) == [2]


def test_logs_from_before_registration_go_after_the_window(tmp_path):
    """Rows whose match never got a match_retention row still age out."""

    async def scenario():
        from src import retention

        db = await _open(tmp_path)
        try:
            base = {"match_id": "legacy", "room": "R", "player_name": "P", "mode": "rollback", "epoch": "e"}
            await db.append_session_log({**base, "slot": 0, "entries": [{"seq": 0, "f": 1, "msg": "x"}]})
            await db.insert_screenshot("legacy", 0, 1, JPEG)
            for table in ("session_logs", "session_log_chunks", "screenshots"):
                await db.execute_write(f"UPDATE {table} SET created_at = datetime('now', '-8 days')", ())
            await retention.sweep()
            return await _left(db, "legacy", tmp_path)
        finally:
            await db.close_db()

    left = run_async(scenario())
    assert {k: v for k, v in left.items() if k in ("session_logs", "session_log_chunks", "screenshots", "blobs")} == {
        "session_logs": 0,
        "session_log_chunks": 0,
        "screenshots": 0,
        "blobs": 0,
    }


def test_auto_flags_stop_at_the_budget_but_feedback_still_flags(tmp_path, monkeypatch):
    """Clients can trigger auto flags; past the budget they're recorded but
    the match keeps the normal tier. Feedback and manual flags ignore it."""
    monkeypatch.setenv("BUDGET_AUTO_FLAGGED_BYTES", "1")  # any flagged data exceeds it

    async def scenario():
        db = await _open(tmp_path)
        try:
            for mid in ("first", "second", "third"):
                await _match(db, mid)
            await db.flag_match("first", [{"signal": "TICK-STUCK", "count": 1}])  # under budget (nothing flagged yet)
            await db.flag_match("second", [{"signal": "TICK-STUCK", "count": 1}])  # over
            await db.flag_match("third", [{"signal": "feedback", "count": 1}], auto=False)
            rows = await db.query(
                "SELECT match_id, tier, auto_flag_capped, flag_reasons FROM match_retention ORDER BY match_id", ()
            )
            return {r["match_id"]: (r["tier"], r["auto_flag_capped"], json.loads(r["flag_reasons"])) for r in rows}
        finally:
            await db.close_db()

    rows = run_async(scenario())
    assert rows["first"][:2] == ("flagged", 0)
    assert rows["second"][:2] == ("normal", 1) and rows["second"][2][0]["signal"] == "TICK-STUCK"
    assert rows["third"][:2] == ("flagged", 0)


def test_local_delete_prefix_removes_only_that_prefix(tmp_path):
    from src.blobstore import LocalBlobStore

    store = LocalBlobStore(tmp_path)

    async def scenario():
        await store.put("matches/a/screenshots/0-1.jpg", b"1")
        await store.put("matches/ab/screenshots/0-1.jpg", b"2")
        await store.delete_prefix("matches/a/")
        await store.delete_prefix("matches/missing/")
        return await store.get("matches/a/screenshots/0-1.jpg"), await store.get("matches/ab/screenshots/0-1.jpg")

    assert run_async(scenario()) == (None, b"2")


def test_client_events_of_deleted_matches_are_removed_in_one_statement(tmp_path):
    """client_events has no index on meta.match_id; a delete per match would
    scan the table once per match, and D1 bills every row read."""

    async def scenario():
        import src.db as dbmod
        from src import retention

        db = await _open(tmp_path)
        try:
            for mid in ("a", "b", "c"):
                await _match(db, mid, ended_days_ago=8, created_days_ago=8)
            backend = dbmod._require()
            statements = []
            real_execute, real_batch = backend.execute, backend.batch

            async def count_execute(sql, params=()):
                statements.append(sql)
                return await real_execute(sql, params)

            async def count_batch(batch):
                statements.extend(sql for sql, _ in batch)
                return await real_batch(batch)

            backend.execute, backend.batch = count_execute, count_batch
            await retention.sweep()
            backend.execute, backend.batch = real_execute, real_batch
            left = [await _left(db, m, tmp_path) for m in ("a", "b", "c")]
            return sum("FROM client_events" in s and "json_extract" in s for s in statements), left
        finally:
            await db.close_db()

    event_deletes, left = run_async(scenario())
    assert left == [GONE, GONE, GONE]
    assert event_deletes <= 2  # one for tombstoned matches, one for unregistered rows


async def _backdate_rows(db, match_id, days):
    ago = (f"-{days} days", match_id)
    for table in ("session_logs", "session_log_chunks", "screenshots", "desync_events"):
        await db.execute_write(f"UPDATE {table} SET created_at = datetime('now', ?) WHERE match_id = ?", ago)
    await db.execute_write(
        "UPDATE client_events SET created_at = datetime('now', ?) WHERE json_extract(meta, '$.match_id') = ?", ago
    )


def test_flagged_matchs_old_rows_are_never_swept_as_unregistered(tmp_path):
    """The orphan cleanup must skip every row of a retained match, however old."""

    async def setup(db):
        await _match(db, "flagged", ended_days_ago=30, created_days_ago=30)
        await db.flag_match("flagged", [{"signal": "TICK-STUCK", "count": 1}])
        await _backdate_rows(db, "flagged", 30)

    assert _sweep_and_count(tmp_path, setup, "flagged") == [KEPT]


def test_normal_match_inside_its_window_keeps_rows_older_than_the_window(tmp_path):
    """A match ended 6 days ago whose first rows are 8 days old is still kept."""

    async def setup(db):
        await _match(db, "long", ended_days_ago=6, created_days_ago=8)
        await _backdate_rows(db, "long", 8)

    assert _sweep_and_count(tmp_path, setup, "long") == [KEPT]


def test_one_failing_match_does_not_stop_the_sweep(tmp_path):
    async def scenario():
        import src.db as dbmod
        from src import retention

        db = await _open(tmp_path)
        try:
            await _match(db, "bad", ended_days_ago=9, created_days_ago=9)
            await _match(db, "good", ended_days_ago=8, created_days_ago=8)
            real_batch = dbmod.execute_batch

            async def failing_for_bad(statements):
                if statements and statements[0][1] == ("bad",):
                    raise RuntimeError("D1 query failed (HTTP 500)")
                return await real_batch(statements)

            dbmod.execute_batch = failing_for_bad
            try:
                await retention.sweep()
            finally:
                dbmod.execute_batch = real_batch
            return await _left(db, "good", tmp_path)
        finally:
            await db.close_db()

    assert run_async(scenario()) == GONE


@pytest.mark.parametrize("match_id", ["", "a/b", ".."])
def test_blob_delete_refuses_ids_that_are_not_one_segment(tmp_path, match_id):
    from src.blobstore import BlobStoreError

    async def scenario():
        db = await _open(tmp_path)
        try:
            await db.insert_screenshot("keep", 0, 1, JPEG)
            with pytest.raises(BlobStoreError):
                await db.delete_match_blobs(match_id)
        finally:
            await db.close_db()

    run_async(scenario())
    assert (tmp_path / "blobs/matches/keep/screenshots/0-1.jpg").exists()


def test_retention_windows_have_a_one_day_floor(tmp_path, monkeypatch):
    monkeypatch.setenv("LOG_RETENTION_DAYS", "0")

    async def setup(db):
        await _match(db, "today", ended_days_ago=0, created_days_ago=0)
        await db.execute_write(
            "UPDATE match_retention SET created_at = datetime('now', '-12 hours'), ended_at = datetime('now', '-12 hours') WHERE match_id = 'today'",
            (),
        )

    assert _sweep_and_count(tmp_path, setup, "today") == [KEPT]
