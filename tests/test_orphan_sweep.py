"""The weekly orphan sweep (src/retention.py, sweep_orphans): blob-store
prefixes under matches/<id>/ that no match_retention row owns are deleted
once their newest object is older than LOG_RETENTION_DAYS.

Run: cd server && uv run --extra dev pytest ../tests/test_orphan_sweep.py -q
"""

import os
from datetime import UTC, datetime, timedelta

import pytest
from db_test_support import run_async


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("LOG_RETENTION_DAYS", "7")


NOW = datetime.now(UTC)


async def _open(tmp_path, blobs=None):
    import src.db as db
    from src.blobstore import LocalBlobStore

    await db.init_db(str(tmp_path / "kn.db"), blobs=blobs or LocalBlobStore(tmp_path / "blobs"))
    return db


def _blob(tmp_path, match_id, *, days_old, name="screenshots/0-1.jpg"):
    """An object under the match's prefix, last written `days_old` days ago."""
    path = tmp_path / "blobs" / "matches" / match_id / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x")
    when = (NOW - timedelta(days=days_old)).timestamp()
    os.utime(path, (when, when))


def _exists(tmp_path, match_id):
    return (tmp_path / "blobs" / "matches" / match_id).exists()


def _run(tmp_path, scenario, blobs=None):
    async def wrapped():
        db = await _open(tmp_path, blobs)
        try:
            return await scenario(db)
        finally:
            await db.close_db()

    return run_async(wrapped())


def test_an_orphan_older_than_the_window_is_deleted(tmp_path):
    from src import retention

    _blob(tmp_path, "gone", days_old=8)
    deleted = _run(tmp_path, lambda db: retention.sweep_orphans(NOW))
    assert deleted == 1 and not _exists(tmp_path, "gone")


def test_an_orphan_with_any_object_inside_the_window_is_kept(tmp_path):
    """A match still being written (no row yet, or an archive upload in
    flight) has a fresh object, so its prefix stays."""
    from src import retention

    _blob(tmp_path, "writing", days_old=30)
    _blob(tmp_path, "writing", days_old=0, name="sessions/tok/0.log.gz")
    _blob(tmp_path, "new", days_old=6)
    deleted = _run(tmp_path, lambda db: retention.sweep_orphans(NOW))
    assert deleted == 0 and _exists(tmp_path, "writing") and _exists(tmp_path, "new")


@pytest.mark.parametrize("state", ["live", "flagged", "tombstoned"])
def test_a_match_with_a_retention_row_is_kept(tmp_path, state):
    from src import retention

    _blob(tmp_path, "owned", days_old=30)

    async def scenario(db):
        await db.register_match("owned", "ROOM1")
        if state == "flagged":
            await db.execute_write("UPDATE match_retention SET tier = 'flagged' WHERE match_id = 'owned'", ())
        if state == "tombstoned":
            await db.execute_write(
                "UPDATE match_retention SET deleting_at = datetime('now') WHERE match_id = 'owned'", ()
            )
        return await retention.sweep_orphans(NOW)

    assert _run(tmp_path, scenario) == 0 and _exists(tmp_path, "owned")


class _WatchingStore:
    """A local store that records which prefixes the sweep asked the time of."""

    name = "local"
    durable = False

    def __init__(self, inner, unknown=()):
        self.inner = inner
        self.asked = []
        self.unknown = set(unknown)

    async def list_match_prefixes(self, *, after=None, limit=500):
        return await self.inner.list_match_prefixes(after=after, limit=limit)

    async def newest_in_match(self, match_id):
        self.asked.append(match_id)
        return None if match_id in self.unknown else await self.inner.newest_in_match(match_id)

    async def delete_prefix(self, prefix):
        await self.inner.delete_prefix(prefix)


def test_registered_prefixes_are_never_listed_for_their_objects(tmp_path):
    """The database is asked first; only unregistered prefixes cost a listing."""
    from src import retention
    from src.blobstore import LocalBlobStore

    _blob(tmp_path, "owned", days_old=30)
    _blob(tmp_path, "orphan", days_old=30)
    store = _WatchingStore(LocalBlobStore(tmp_path / "blobs"))

    async def scenario(db):
        await db.register_match("owned", "ROOM1")
        return await retention.sweep_orphans(NOW)

    assert _run(tmp_path, scenario, blobs=store) == 1
    assert store.asked == ["orphan"] and _exists(tmp_path, "owned")


def test_a_prefix_whose_newest_time_is_unknown_is_kept_with_a_warning(tmp_path, caplog):
    from src import retention
    from src.blobstore import LocalBlobStore

    _blob(tmp_path, "huge-match", days_old=30)
    store = _WatchingStore(LocalBlobStore(tmp_path / "blobs"), unknown={"huge-match"})
    with caplog.at_level("WARNING", logger="src.retention"):
        deleted = _run(tmp_path, lambda db: retention.sweep_orphans(NOW), blobs=store)
    assert deleted == 0 and _exists(tmp_path, "huge-match")
    assert "prefix of huge-mat kept" in caplog.text


class _FailingListing:
    """A blob store whose listing fails, as R2 does when unreachable."""

    name = "r2"
    durable = True

    def __init__(self):
        self.deleted = []

    async def list_match_prefixes(self, *, after=None, limit=500):
        from src.blobstore import BlobStoreError

        raise BlobStoreError("R2 list_objects_v2 failed: InternalError")

    async def delete_prefix(self, prefix):
        self.deleted.append(prefix)


def test_a_listing_failure_warns_and_leaves_the_marker_for_a_retry(tmp_path, caplog):
    from src import retention

    store = _FailingListing()
    week_ago = (NOW - timedelta(days=8)).isoformat()

    async def scenario(db):
        await db.set_server_state(retention.LAST_ORPHAN_SWEEP, week_ago)
        result = await retention.sweep_orphans(NOW)
        return result, await db.get_server_state(retention.LAST_ORPHAN_SWEEP)

    with caplog.at_level("WARNING", logger="src.retention"):
        result, marker = _run(tmp_path, scenario, blobs=store)
    assert result is None and marker == week_ago and store.deleted == []
    assert "listing the blob store failed" in caplog.text


def test_the_sweep_runs_only_when_the_last_pass_is_a_week_old(tmp_path):
    from src import retention

    _blob(tmp_path, "orphan", days_old=8)

    async def scenario(db):
        first = await retention.sweep_orphans(NOW)  # never ran: runs
        marker = await db.get_server_state(retention.LAST_ORPHAN_SWEEP)
        _blob(tmp_path, "orphan2", days_old=8)
        too_soon = await retention.sweep_orphans(NOW + timedelta(days=6))
        due = await retention.sweep_orphans(NOW + timedelta(days=7))
        return first, marker, too_soon, due, await db.get_server_state(retention.LAST_ORPHAN_SWEEP)

    first, marker, too_soon, due, last = _run(tmp_path, scenario)
    assert first == 1 and marker == NOW.isoformat()
    assert too_soon is None and due == 1
    assert last == (NOW + timedelta(days=7)).isoformat()


def test_a_bounded_pass_resumes_at_its_cursor_before_the_week_is_up(tmp_path, monkeypatch):
    from src import retention

    monkeypatch.setattr(retention, "_ORPHAN_PREFIXES_PER_RUN", 2)
    for i in range(3):
        _blob(tmp_path, f"m{i}", days_old=8)

    async def scenario(db):
        first = await retention.sweep_orphans(NOW)
        cursor = await db.get_server_state(retention.ORPHAN_SWEEP_CURSOR)
        marker = await db.get_server_state(retention.LAST_ORPHAN_SWEEP)
        second = await retention.sweep_orphans(NOW + timedelta(hours=6))
        return first, cursor, marker, second, await db.get_server_state(retention.ORPHAN_SWEEP_CURSOR)

    first, cursor, marker, second, cursor_after = _run(tmp_path, scenario)
    assert (first, cursor, marker) == (2, "m1", None)
    assert second == 1 and cursor_after is None
    assert not any(_exists(tmp_path, f"m{i}") for i in range(3))


def test_the_retention_sweep_runs_the_orphan_sweep(tmp_path):
    from src import retention

    _blob(tmp_path, "orphan", days_old=8)
    _run(tmp_path, lambda db: retention.sweep())
    assert not _exists(tmp_path, "orphan")
