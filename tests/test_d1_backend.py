"""D1Backend behavior beyond the shared contract, and backend selection.

Run: cd server && uv run --extra dev pytest ../tests/test_d1_backend.py -q
"""

import httpx
import pytest
from db_test_support import FAKE_TOKEN, FakeD1, run_async


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


def _backend(transport):
    from src.dbbackend.d1 import D1Backend

    return D1Backend("acct-1", "db-1", FAKE_TOKEN, transport=transport)


async def _run(backend, call):
    await backend.open()
    try:
        return await call(backend)
    finally:
        await backend.close()


def test_d1_posts_to_the_query_endpoint_with_bearer_token():
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        return httpx.Response(200, json={"success": True, "errors": [], "messages": [], "result": [{"results": []}]})

    run_async(_run(_backend(httpx.MockTransport(handler)), lambda b: b.query("SELECT 1", ())))
    assert seen["url"] == "https://api.cloudflare.com/client/v4/accounts/acct-1/d1/database/db-1/query"
    assert seen["auth"] == f"Bearer {FAKE_TOKEN}"


def test_d1_sends_batch_as_one_request():
    fake = FakeD1()

    async def call(b):
        await b.execute("CREATE TABLE t (x INTEGER)", ())
        await b.batch([("INSERT INTO t VALUES (?)", (1,)), ("INSERT INTO t VALUES (?)", (2,))])

    run_async(_run(_backend(fake.transport()), call))
    assert fake.requests[-1] == {
        "batch": [
            {"sql": "INSERT INTO t VALUES (?)", "params": [1]},
            {"sql": "INSERT INTO t VALUES (?)", "params": [2]},
        ]
    }


def test_d1_empty_batch_makes_no_request():
    fake = FakeD1()
    assert run_async(_run(_backend(fake.transport()), lambda b: b.batch([]))) == []
    assert fake.requests == []


def test_d1_rejects_binary_params():
    fake = FakeD1()
    with pytest.raises(TypeError, match="binary"):
        run_async(_run(_backend(fake.transport()), lambda b: b.execute("SELECT ?", (b"\x00",))))
    assert fake.requests == []


def test_d1_error_response_surfaces_d1_message():
    from src.dbbackend import BackendError

    fake = FakeD1()
    with pytest.raises(BackendError, match="no such table: missing"):
        run_async(_run(_backend(fake.transport()), lambda b: b.query("SELECT * FROM missing", ())))


def test_d1_non_json_error_is_backend_error_without_token():
    from src.dbbackend import BackendError

    def handler(request):
        return httpx.Response(502, text="<html>Bad gateway</html>")

    with pytest.raises(BackendError) as info:
        run_async(_run(_backend(httpx.MockTransport(handler)), lambda b: b.query("SELECT 1", ())))
    assert "502" in str(info.value)
    assert FAKE_TOKEN not in str(info.value)


def test_d1_network_error_is_backend_error():
    from src.dbbackend import BackendError

    def handler(request):
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(BackendError, match="ConnectError") as info:
        run_async(_run(_backend(httpx.MockTransport(handler)), lambda b: b.query("SELECT 1", ())))
    assert FAKE_TOKEN not in str(info.value)


# ── backend_from_env ─────────────────────────────────────────────────────────


@pytest.fixture
def d1_env(monkeypatch):
    for name in ("CF_ACCOUNT_ID", "D1_DATABASE_ID", "D1_API_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def test_backend_from_env_selects_d1_when_configured(d1_env):
    from src.dbbackend import backend_from_env
    from src.dbbackend.d1 import D1Backend

    d1_env.setenv("CF_ACCOUNT_ID", "acct")
    d1_env.setenv("D1_DATABASE_ID", "db")
    d1_env.setenv("D1_API_TOKEN", "tok")
    assert isinstance(backend_from_env(), D1Backend)


def test_backend_from_env_rejects_partial_d1_config(d1_env):
    from src.dbbackend import BackendError, backend_from_env

    d1_env.setenv("D1_DATABASE_ID", "db")
    with pytest.raises(BackendError, match="CF_ACCOUNT_ID, D1_API_TOKEN"):
        backend_from_env()


def test_explicit_db_path_means_sqlite_even_with_d1_env(d1_env, tmp_path):
    from src.dbbackend import backend_from_env
    from src.dbbackend.sqlite import SqliteBackend

    d1_env.setenv("CF_ACCOUNT_ID", "acct")
    d1_env.setenv("D1_DATABASE_ID", "db")
    d1_env.setenv("D1_API_TOKEN", "tok")
    assert isinstance(backend_from_env(str(tmp_path / "x.db")), SqliteBackend)


def test_baseline_migration_applies_through_d1():
    from src.migrate import apply_migrations

    fake = FakeD1()

    async def call(b):
        first = await apply_migrations(b)
        second = await apply_migrations(b)
        tables = await b.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", ())
        return first, second, [t["name"] for t in tables]

    first, second, tables = run_async(_run(_backend(fake.transport()), call))
    assert first == ["0001", "0002", "0003", "0004", "0005", "0006"]
    assert second == []
    assert {"feedback", "session_logs", "client_events", "screenshots", "match_metrics", "desync_events"} <= set(tables)



def test_archive_and_eviction_run_through_d1(tmp_path):
    """Every statement the archive and the eviction build, run on D1's HTTP
    API: the flush, the record, the batch, and the readers afterwards.

    `tests/test_log_archive.py` covers the behaviour on SQLite. This checks
    the SQL itself is SQLite that D1 runs — the window-function cap DELETE,
    `INSERT … SELECT … GROUP BY … HAVING … LIMIT`, a DELETE and an UPDATE
    with an EXISTS subquery, and `ORDER BY created_at, id … LIMIT … OFFSET`.
    """
    from src.blobstore import LocalBlobStore

    match_id = "22222222-2222-4222-8222-222222222222"
    fake = FakeD1()

    async def body():
        import src.db as db
        from src import log_archive

        db._registered_matches.clear()
        db._upload_check_cache.clear()
        await db.init_db(backend=_backend(fake.transport()), blobs=LocalBlobStore(tmp_path / "blobs"))
        try:
            await db.register_match(match_id, "ROOM1")
            await db.append_session_flush(
                {
                    "match_id": match_id,
                    "room": "ROOM1",
                    "slot": 0,
                    "epoch": "e1",
                    "entries": [{"seq": 0, "msg": "TICK f=1"}, {"seq": 1, "msg": "[C] rb f=1"}],
                    "audit_epoch": "a1",
                    "audit_entries": [{"seq": 0, "s": "L", "b": 1}],
                    "context": '{"delay": 3}',
                }
            )
            for statement in (
                "UPDATE match_retention SET ended_at = datetime('now', '-45 minutes') WHERE match_id = ?",
                "UPDATE session_logs SET updated_at = datetime(updated_at, '-45 minutes') WHERE match_id = ?",
                "UPDATE session_log_chunks SET created_at = datetime(created_at, '-45 minutes') WHERE match_id = ?",
            ):
                await db.execute_write(statement, (match_id,))
            before = await db.get_full_log_entries(match_id, 0, None)

            archived, evicted = await log_archive.sweep()
            for statement in (
                "UPDATE match_retention SET archived_at = datetime(archived_at, '-3 days'),"
                " archived_updated_at = datetime(archived_updated_at, '-3 days') WHERE match_id = ?",
                "UPDATE session_logs SET updated_at = datetime(updated_at, '-3 days') WHERE match_id = ?",
            ):
                await db.execute_write(statement, (match_id,))
            archived_too, evicted_now = await log_archive.sweep()

            rows = await db.query("SELECT context FROM session_logs WHERE match_id = ?", (match_id,))
            chunks = await db.query(
                "SELECT COUNT(*) AS n FROM session_log_chunks WHERE match_id = ?", (match_id,)
            )
            return {
                "sweeps": [(archived, evicted), (archived_too, evicted_now)],
                "before": before,
                "after": await db.get_full_log_entries(match_id, 0, None),
                "audit": await db.get_input_audit(match_id, 0),
                "context": await db.get_session_context(match_id, 0, rows[0]["context"]),
                "cleared": rows[0]["context"] is None,
                "chunks_left": chunks[0]["n"],
            }
        finally:
            await db.close_db()

    out = run_async(body())
    assert out["sweeps"] == [(1, 0), (0, 1)]
    assert out["chunks_left"] == 0 and out["cleared"]
    assert [e["msg"] for e in out["before"]] == ["TICK f=1", "[C] rb f=1"]
    assert out["after"] == out["before"]
    assert [r["b"] for r in out["audit"]] == [1]
    assert out["context"] == '{"delay": 3}'
