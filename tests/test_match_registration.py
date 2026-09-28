"""match_retention: registration at start-game and the upload window.

Run: cd server && uv run --extra dev pytest ../tests/test_match_registration.py -q
"""

from unittest.mock import patch

import pytest
from db_test_support import FAKE_TOKEN, FakeD1, run_async


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


@pytest.fixture(autouse=True)
def _clear_cache():
    import src.db as db

    db._upload_check_cache.clear()
    db._registered_matches.clear()
    yield
    db._upload_check_cache.clear()
    db._registered_matches.clear()


async def _open(tmp_path, d1):
    import src.db as db
    from src.blobstore import LocalBlobStore
    from src.dbbackend.d1 import D1Backend

    backend = D1Backend("acct", "db", FAKE_TOKEN, transport=FakeD1().transport()) if d1 else None
    await db.init_db(None if d1 else str(tmp_path / "kn.db"), backend=backend, blobs=LocalBlobStore(tmp_path / "b"))
    return db


BACKENDS = pytest.mark.parametrize("d1", [False, True], ids=["sqlite", "d1"])


@BACKENDS
def test_registered_match_accepts_uploads_from_its_room_only(tmp_path, d1):
    async def scenario():
        db = await _open(tmp_path, d1)
        try:
            await db.register_match("m1", "ROOM1")
            await db.register_match("m1", "ROOM1")  # idempotent
            return (
                await db.match_accepts_uploads("m1", "ROOM1"),
                await db.match_accepts_uploads("m1", "OTHER"),
                await db.match_accepts_uploads("unknown", "ROOM1"),
            )
        finally:
            await db.close_db()

    assert run_async(scenario()) == (True, False, False)


@BACKENDS
def test_uploads_accepted_until_30_min_after_end(tmp_path, d1):
    async def scenario():
        db = await _open(tmp_path, d1)
        try:
            await db.register_match("m1", "ROOM1")
            await db.set_session_ended("m1", None, "game-end")
            ended = await db.query("SELECT ended_at FROM match_retention WHERE match_id = 'm1'", ())
            just_ended = await db.match_accepts_uploads("m1", "ROOM1")
            await db.execute_write(
                "UPDATE match_retention SET ended_at = datetime('now', '-31 minutes') WHERE match_id = 'm1'", ()
            )
            db._upload_check_cache.clear()
            return ended[0]["ended_at"] is not None, just_ended, await db.match_accepts_uploads("m1", "ROOM1")
        finally:
            await db.close_db()

    assert run_async(scenario()) == (True, True, False)


@BACKENDS
def test_unended_match_accepted_for_4_hours(tmp_path, d1):
    async def scenario():
        db = await _open(tmp_path, d1)
        try:
            await db.register_match("m1", "ROOM1")
            await db.execute_write(
                "UPDATE match_retention SET created_at = datetime('now', '-3 hours') WHERE match_id = 'm1'", ()
            )
            within = await db.match_accepts_uploads("m1", "ROOM1")
            await db.execute_write(
                "UPDATE match_retention SET created_at = datetime('now', '-5 hours') WHERE match_id = 'm1'", ()
            )
            db._upload_check_cache.clear()
            return within, await db.match_accepts_uploads("m1", "ROOM1")
        finally:
            await db.close_db()

    assert run_async(scenario()) == (True, False)


def test_tombstoned_match_refuses_uploads(tmp_path):
    async def scenario():
        db = await _open(tmp_path, False)
        try:
            await db.register_match("m1", "ROOM1")
            await db.execute_write("UPDATE match_retention SET deleting_at = datetime('now') WHERE match_id = 'm1'", ())
            return await db.match_accepts_uploads("m1", "ROOM1")
        finally:
            await db.close_db()

    assert run_async(scenario()) is False


def test_player_leaving_does_not_end_the_match(tmp_path):
    """Only game-end (slot None) stamps ended_at; one player leaving doesn't."""

    async def scenario():
        db = await _open(tmp_path, False)
        try:
            await db.register_match("m1", "ROOM1")
            await db.set_session_ended("m1", 2, "leave")
            rows = await db.query("SELECT ended_at FROM match_retention WHERE match_id = 'm1'", ())
            return rows[0]["ended_at"]
        finally:
            await db.close_db()

    assert run_async(scenario()) is None


def test_upload_check_is_cached(tmp_path):
    async def scenario():
        db = await _open(tmp_path, False)
        try:
            calls = []
            real_query = db._require().query

            async def counting_query(sql, params=()):
                calls.append(sql)
                return await real_query(sql, params)

            with patch.object(db._require(), "query", side_effect=counting_query):
                for _ in range(5):
                    await db.match_accepts_uploads("bogus", "ROOM1")
            return len(calls)
        finally:
            await db.close_db()

    assert run_async(scenario()) == 1


def test_registering_clears_a_cached_refusal(tmp_path):
    """Lazy registration from a live flush must take effect at once."""

    async def scenario():
        db = await _open(tmp_path, False)
        try:
            before = await db.match_accepts_uploads("m1", "ROOM1")
            await db.register_match("m1", "ROOM1")
            return before, await db.match_accepts_uploads("m1", "ROOM1")
        finally:
            await db.close_db()

    assert run_async(scenario()) == (False, True)


def test_register_match_writes_once_per_process(tmp_path):
    """Every Socket.IO flush calls it; only the first may reach D1."""

    async def scenario():
        db = await _open(tmp_path, False)
        try:
            calls = []
            real_execute = db._require().execute

            async def counting_execute(sql, params=()):
                calls.append(sql)
                return await real_execute(sql, params)

            with patch.object(db._require(), "execute", side_effect=counting_execute):
                for _ in range(5):
                    await db.register_match("m1", "ROOM1")
            return len(calls)
        finally:
            await db.close_db()

    assert run_async(scenario()) == 1


def test_init_db_clears_the_upload_caches(tmp_path):
    import src.db as db

    db._upload_check_cache[("m", "R")] = (True, float("inf"))
    db._registered_matches.add("m")

    async def scenario():
        await _open(tmp_path, False)
        await db.close_db()

    run_async(scenario())
    assert db._upload_check_cache == {} and db._registered_matches == set()
