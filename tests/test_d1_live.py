"""Live checks against a real Cloudflare D1 database. Skipped by default.

Run (from server/, against a scratch or not-yet-live database):
  KN_D1_LIVE=1 CF_ACCOUNT_ID=... D1_DATABASE_ID=... D1_API_TOKEN=... \
    uv run --extra dev pytest ../tests/test_d1_live.py -q -s

Answers two questions the docs leave open: whether non-string params bind
with their real types (the docs type params as strings), and whether an
HTTP batch that fails part-way is rolled back.
"""

import os
import secrets

import pytest
from db_test_support import run_async

pytestmark = pytest.mark.skipif(
    os.environ.get("KN_D1_LIVE") != "1"
    or not all(os.environ.get(n) for n in ("CF_ACCOUNT_ID", "D1_DATABASE_ID", "D1_API_TOKEN")),
    reason="set KN_D1_LIVE=1 and the D1 env vars to run against real D1",
)


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


def _live_backend():
    from src.dbbackend.d1 import D1Backend

    return D1Backend(os.environ["CF_ACCOUNT_ID"], os.environ["D1_DATABASE_ID"], os.environ["D1_API_TOKEN"])


async def _with_table(scenario):
    backend = _live_backend()
    table = f"kn_live_{secrets.token_hex(4)}"
    await backend.open()
    try:
        await backend.execute(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY, n INTEGER, s TEXT)", ())
        return await scenario(backend, table)
    finally:
        await backend.execute(f"DROP TABLE IF EXISTS {table}", ())
        await backend.close()


def test_live_param_types_round_trip():
    async def scenario(b, table):
        await b.execute(f"INSERT INTO {table} (n, s) VALUES (?, ?)", (42, None))
        rows = await b.query(f"SELECT n, s, typeof(n) AS tn, typeof(s) AS ts FROM {table} WHERE n = ?", (42,))
        literal = await b.query("SELECT ? AS i, ? AS f, ? AS z", (7, 1.5, None))
        return rows, literal

    rows, literal = run_async(_with_table(scenario))
    assert rows == [{"n": 42, "s": None, "tn": "integer", "ts": "null"}]
    assert literal == [{"i": 7, "f": 1.5, "z": None}]


def test_live_limit_param():
    async def scenario(b, table):
        await b.batch([(f"INSERT INTO {table} (n) VALUES (?)", (i,)) for i in range(3)])
        return await b.query(f"SELECT n FROM {table} ORDER BY n LIMIT ?", (2,))

    assert run_async(_with_table(scenario)) == [{"n": 0}, {"n": 1}]


def test_live_batch_atomicity_report():
    """Records whether a failing HTTP batch rolls back. The design works either way."""
    from src.dbbackend import BackendError

    async def scenario(b, table):
        with pytest.raises(BackendError):
            await b.batch(
                [(f"INSERT INTO {table} (n) VALUES (?)", (1,)), ("INSERT INTO kn_missing_table VALUES (1)", ())]
            )
        return await b.query(f"SELECT COUNT(*) AS c FROM {table}", ())

    count = run_async(_with_table(scenario))[0]["c"]
    print(f"\nD1 HTTP batch atomic: {count == 0} (rows left after failed batch: {count})")


def test_live_large_text_param_fits_one_row():
    """Session-log context is capped at 1.5 MB (_SESSION_LOG_CONTEXT_MAX) to fit
    a D1 row; check the HTTP API accepts a parameter that size."""
    from src.api.signaling import _SESSION_LOG_CONTEXT_MAX

    big = "x" * _SESSION_LOG_CONTEXT_MAX

    async def scenario(b, table):
        await b.execute(f"INSERT INTO {table} (n, s) VALUES (?, ?)", (1, big))
        return await b.query(f"SELECT length(s) AS n FROM {table}", ())

    assert run_async(_with_table(scenario)) == [{"n": _SESSION_LOG_CONTEXT_MAX}]
