"""Contract tests every database backend must pass.

Run: cd server && uv run --extra dev pytest ../tests/test_db_backends.py -q
"""

import pytest
from db_test_support import make_backend, run_async

BACKENDS = ["sqlite"]


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


@pytest.fixture(params=BACKENDS)
def backend(request, tmp_path):
    return make_backend(request.param, tmp_path)


async def _with_open(backend, scenario):
    await backend.open()
    try:
        return await scenario(backend)
    finally:
        await backend.close()


async def _make_table(b):
    await b.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)")


def test_query_returns_dicts_keyed_by_column(backend):
    async def scenario(b):
        await _make_table(b)
        await b.execute("INSERT INTO t (name) VALUES (?)", ("a",))
        return await b.query("SELECT id, name FROM t", ())

    assert run_async(_with_open(backend, scenario)) == [{"id": 1, "name": "a"}]


def test_query_with_no_rows_returns_empty_list(backend):
    async def scenario(b):
        await _make_table(b)
        return await b.query("SELECT * FROM t", ())

    assert run_async(_with_open(backend, scenario)) == []


def test_execute_reports_last_row_id_and_changes(backend):
    async def scenario(b):
        await _make_table(b)
        await b.execute("INSERT INTO t (name) VALUES (?)", ("a",))
        second = await b.execute("INSERT INTO t (name) VALUES (?)", ("b",))
        updated = await b.execute("UPDATE t SET name = ?", ("z",))
        return second, updated

    second, updated = run_async(_with_open(backend, scenario))
    assert second.last_row_id == 2
    assert updated.changes == 2


def test_int_float_null_and_text_params_round_trip(backend):
    async def scenario(b):
        return await b.query("SELECT ? AS i, ? AS f, ? AS n, ? AS s", (7, 1.5, None, "x"))

    assert run_async(_with_open(backend, scenario)) == [{"i": 7, "f": 1.5, "n": None, "s": "x"}]


def test_bool_param_binds_as_integer(backend):
    async def scenario(b):
        return await b.query("SELECT ? AS v", (True,))

    assert run_async(_with_open(backend, scenario)) == [{"v": 1}]


def test_limit_param_accepts_int(backend):
    async def scenario(b):
        await _make_table(b)
        for name in ("a", "b", "c"):
            await b.execute("INSERT INTO t (name) VALUES (?)", (name,))
        return await b.query("SELECT name FROM t ORDER BY id LIMIT ?", (2,))

    assert run_async(_with_open(backend, scenario)) == [{"name": "a"}, {"name": "b"}]


def test_json_extract_is_available(backend):
    """The admin API filters on json_extract(summary, ...)."""

    async def scenario(b):
        return await b.query("SELECT json_extract(?, '$.a') AS v", ('{"a": 3}',))

    assert run_async(_with_open(backend, scenario)) == [{"v": 3}]


def test_batch_applies_statements_in_order(backend):
    async def scenario(b):
        await _make_table(b)
        results = await b.batch(
            [
                ("INSERT INTO t (name) VALUES (?)", ("a",)),
                ("INSERT INTO t (name) VALUES (?)", ("b",)),
                ("UPDATE t SET name = ? WHERE name = ?", ("c", "a")),
            ]
        )
        rows = await b.query("SELECT name FROM t ORDER BY id", ())
        return results, rows

    results, rows = run_async(_with_open(backend, scenario))
    assert [r.last_row_id for r in results[:2]] == [1, 2]
    assert results[2].changes == 1
    assert rows == [{"name": "c"}, {"name": "b"}]


def test_batch_with_bad_statement_raises_backend_error(backend):
    from src.dbbackend import BackendError

    async def scenario(b):
        await _make_table(b)
        with pytest.raises(BackendError):
            await b.batch([("INSERT INTO t (name) VALUES (?)", ("a",)), ("INSERT INTO missing VALUES (1)", ())])

    run_async(_with_open(backend, scenario))


def test_sql_error_raises_backend_error(backend):
    from src.dbbackend import BackendError

    async def scenario(b):
        with pytest.raises(BackendError):
            await b.query("SELECT * FROM missing", ())

    run_async(_with_open(backend, scenario))


def test_query_before_open_raises_backend_error(backend):
    from src.dbbackend import BackendError

    with pytest.raises(BackendError):
        run_async(backend.query("SELECT 1", ()))


# ── SQLite-only behavior ─────────────────────────────────────────────────────


def test_sqlite_batch_failure_rolls_back(tmp_path):
    from src.dbbackend import BackendError

    backend = make_backend("sqlite", tmp_path)

    async def scenario(b):
        await _make_table(b)
        with pytest.raises(BackendError):
            await b.batch([("INSERT INTO t (name) VALUES (?)", ("a",)), ("INSERT INTO missing VALUES (1)", ())])
        return await b.query("SELECT COUNT(*) AS n FROM t", ())

    assert run_async(_with_open(backend, scenario)) == [{"n": 0}]


def test_sqlite_binds_binary_values(tmp_path):
    backend = make_backend("sqlite", tmp_path)

    async def scenario(b):
        await b.execute("CREATE TABLE blobs (data BLOB)")
        await b.execute("INSERT INTO blobs (data) VALUES (?)", (b"\x00\xffjpeg",))
        return await b.query("SELECT data FROM blobs", ())

    assert run_async(_with_open(backend, scenario)) == [{"data": b"\x00\xffjpeg"}]


def test_backend_from_env_defaults_to_sqlite_at_db_path(tmp_path, monkeypatch):
    from src.dbbackend import backend_from_env
    from src.dbbackend.sqlite import SqliteBackend

    monkeypatch.setenv("DB_PATH", str(tmp_path / "env.db"))
    backend = backend_from_env()
    assert isinstance(backend, SqliteBackend)
    assert backend.path == str(tmp_path / "env.db")
