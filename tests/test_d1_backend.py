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
    assert first == ["0001", "0002", "0003"]
    assert second == []
    assert {"feedback", "session_logs", "client_events", "screenshots", "match_metrics", "desync_events"} <= set(tables)

