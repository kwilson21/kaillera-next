# Off-box logs, Plan A: database backends and SQL migrations

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the server's database behind a backend interface with two implementations (local SQLite and Cloudflare D1 over HTTPS), and replace Alembic with plain-SQL migrations that both backends run.

**Architecture:** `server/src/dbbackend/` holds the interface (`base.py`), `SqliteBackend` (`sqlite.py`) and `D1Backend` (`d1.py`), plus `backend_from_env()` to select one. `server/src/migrate.py` applies `server/migrations/NNNN_name.sql` files through whichever backend is active. `server/src/db.py` keeps every public function and SQL string it has today and delegates to the backend. No behavior change while D1 env vars are unset, and they stay unset until Plan E.

**Tech Stack:** Python 3.11, aiosqlite, httpx (already a direct dependency), pytest, uv.

**Spec:** `docs/superpowers/specs/2026-09-25-offbox-log-storage-design.md` (§1 "Backends" and "Migrations", §8 PRs 1–2)

**Series:** This is Plan A of five. B: blob store, spool, shipper, ingest validation (PRs 3–4). C: retention classifier and sweep (PRs 5–6). D: admin API and page (PRs 7–8). E: Render cutover and feedback routine (PRs 9–10). Each later plan is written after the previous one merges.

## Global Constraints

- Python ≥ 3.11; ruff (line length 120, rules in `server/pyproject.toml`) must pass. The pre-commit hook runs `ruff check` and `ruff format`.
- Run all Python commands from `server/`: `cd server && uv run --extra dev pytest ../tests/<file> -q`.
- Test files in `tests/` that don't need a browser must override the session fixture `_patch_browser_ssl` (see `tests/test_db.py`). Otherwise `tests/conftest.py` pulls in Playwright.
- Async tests run through `run_async` (fresh loop in a thread). A backend must be opened, used and closed inside one `run_async` call.
- Selection rule (spec §1): D1 env vars set → D1; unset → SQLite at `DB_PATH` (default `data/kn.db`). An explicit `db_path` argument always means SQLite.
- Env var names, verbatim: `CF_ACCOUNT_ID`, `D1_DATABASE_ID`, `D1_API_TOKEN`, `DB_PATH`.
- Never print or log the D1 token; error messages must not contain it.
- Migrations: numbered `NNNN_name.sql` in `server/migrations/`, tracked in `schema_migrations(version TEXT PRIMARY KEY, name, applied_at)`; statements must be safe to re-run where SQLite allows (`IF NOT EXISTS`, `INSERT OR IGNORE`).
- D1Backend never binds binary values (blobs move to R2 in Plan B).
- Conventional commits. PR 1 title: `refactor(db): backend interface and plain-SQL migrations replace Alembic`. PR 2 title: `feat(db): Cloudflare D1 backend`. End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Keep PRs small. Before merging, check `git diff --stat origin/main...HEAD` and flag anything unexpectedly large. Open PR 2 from `main` after PR 1 merges (no stacked PRs).

## Review Focus

1. **D1 rejects or retypes non-string params.** The API docs type `params` as "array of string". Expected: integers, floats, NULL and `LIMIT ?` behave exactly as on SQLite, or we find out before cutover. Pinned by the live test in Task 5 (`test_live_param_types_round_trip`, `test_live_limit_param`).
2. **A migration statement containing `;` inside a string literal.** Expected: kept as one statement. Pinned in Task 2 (`test_split_statements_keeps_semicolon_inside_string`).
3. **An existing Alembic-created database with data (the self-hosted VPS, dev machines).** Expected: the baseline applies over it, data is kept, and `alembic_version` is dropped. Pinned in Task 2 (`test_baseline_upgrades_existing_alembic_database`).
4. **Two instances start at once during a deploy and both apply the baseline.** Expected: the second run succeeds and doesn't crash the server. Pinned in Task 2 (`test_apply_one_is_safe_to_repeat`).
5. **D1 returns HTML or a 5xx, or the network fails.** Expected: `BackendError` with a readable message that never includes the token. Pinned in Task 4 (`test_d1_non_json_error_is_backend_error_without_token`, `test_d1_network_error_is_backend_error`).

---

## File structure

| Path | Responsibility |
|---|---|
| `server/src/dbbackend/__init__.py` (create) | Re-exports the types; `backend_from_env()` |
| `server/src/dbbackend/base.py` (create) | `Backend` protocol, `ExecResult`, `BackendError`, `Params`, `Statement` |
| `server/src/dbbackend/sqlite.py` (create) | `SqliteBackend` (aiosqlite) |
| `server/src/dbbackend/d1.py` (create, Task 4) | `D1Backend` (httpx) |
| `server/src/migrate.py` (create) | Load, split and apply SQL migrations |
| `server/migrations/0001_baseline.sql` (create) | Today's schema (Alembic 0001–0007), re-runnable |
| `server/src/db.py` (modify) | Same public API, delegates to the backend |
| `server/alembic/`, `server/alembic.ini` (delete) | Replaced by the above |
| `server/pyproject.toml`, `server/uv.lock` (modify) | Drop `alembic`, `sqlalchemy` |
| `CLAUDE.md:58`, `README.md:153` (modify) | Describe the new DB layer |
| `tests/db_test_support.py` (create) | `run_async`, `make_backend`, `FakeD1` |
| `tests/test_db_backends.py` (create) | Contract suite run against every backend |
| `tests/test_migrate.py` (create) | Runner and baseline tests |
| `tests/test_d1_backend.py` (create, Task 4) | D1-specific behavior and backend selection |
| `tests/test_d1_live.py` (create, Task 5) | Opt-in test against a real D1 database |

---

## PR 1: `refactor(db)`

### Task 1: Backend interface and SqliteBackend

**Files:**
- Create: `server/src/dbbackend/__init__.py`, `server/src/dbbackend/base.py`, `server/src/dbbackend/sqlite.py`
- Create: `tests/db_test_support.py`, `tests/test_db_backends.py`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `src.dbbackend.ExecResult(last_row_id: int | None, changes: int)` (frozen dataclass)
  - `src.dbbackend.BackendError(RuntimeError)`
  - `src.dbbackend.Params = Sequence[Any]`, `src.dbbackend.Statement = tuple[str, Params]`
  - `src.dbbackend.Backend` protocol:
    - `name: str`
    - `async open() -> None`, `async close() -> None`
    - `async query(sql, params=()) -> list[dict[str, Any]]`
    - `async execute(sql, params=()) -> ExecResult`
    - `async batch(statements: Sequence[Statement]) -> list[ExecResult]`
  - `src.dbbackend.sqlite.SqliteBackend(path: str)`, with attribute `path`
  - `src.dbbackend.backend_from_env(db_path: str | None = None) -> Backend`
  - `src.dbbackend.DEFAULT_DB_PATH`
  - `tests/db_test_support.py`: `run_async(coro)`, `make_backend(kind: str, tmp_path: Path)`

- [ ] **Step 1: Write the test support module**

Create `tests/db_test_support.py`:

```python
"""Helpers shared by the database backend tests."""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path


def run_async(coro):
    """Run a coroutine on a fresh event loop in its own thread.

    pytest-playwright may own an event loop on the main thread, which makes
    asyncio.run() raise there (same approach as tests/test_db.py). Open, use
    and close a backend inside one call: connections are bound to the loop.
    """
    result: list = []
    error: list = []

    def target() -> None:
        loop = asyncio.new_event_loop()
        try:
            result.append(loop.run_until_complete(coro))
        except BaseException as exc:
            error.append(exc)
        finally:
            loop.close()

    thread = threading.Thread(target=target)
    thread.start()
    thread.join()
    if error:
        raise error[0]
    return result[0] if result else None


def make_backend(kind: str, tmp_path: Path):
    """Return an unopened backend of the given kind."""
    from src.dbbackend.sqlite import SqliteBackend

    if kind == "sqlite":
        return SqliteBackend(str(tmp_path / "contract.db"))
    raise ValueError(f"unknown backend kind: {kind}")
```

- [ ] **Step 2: Write the failing contract tests**

Create `tests/test_db_backends.py`:

```python
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && uv run --extra dev pytest ../tests/test_db_backends.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.dbbackend'`

- [ ] **Step 4: Write the interface**

Create `server/src/dbbackend/base.py`:

```python
"""Backend-neutral types for the database layer.

A backend runs SQLite-dialect SQL somewhere: a local file (SqliteBackend) or
Cloudflare D1 over HTTPS (D1Backend). src/db.py is the only caller.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

Params = Sequence[Any]
Statement = tuple[str, Params]


class BackendError(RuntimeError):
    """A query failed or the backend is unavailable."""


@dataclass(frozen=True)
class ExecResult:
    last_row_id: int | None
    changes: int


class Backend(Protocol):
    name: str

    async def open(self) -> None: ...

    async def close(self) -> None: ...

    async def query(self, sql: str, params: Params = ()) -> list[dict[str, Any]]: ...

    async def execute(self, sql: str, params: Params = ()) -> ExecResult: ...

    async def batch(self, statements: Sequence[Statement]) -> list[ExecResult]: ...
```

Create `server/src/dbbackend/__init__.py`:

```python
"""Database backends. The interface is in base.py; db.py is the only caller."""

from __future__ import annotations

import os

from src.dbbackend.base import Backend, BackendError, ExecResult, Params, Statement

DEFAULT_DB_PATH = os.path.join("data", "kn.db")

__all__ = ["DEFAULT_DB_PATH", "Backend", "BackendError", "ExecResult", "Params", "Statement", "backend_from_env"]


def backend_from_env(db_path: str | None = None) -> Backend:
    """Pick the backend. An explicit db_path always means local SQLite."""
    from src.dbbackend.sqlite import SqliteBackend

    return SqliteBackend(db_path or os.environ.get("DB_PATH", DEFAULT_DB_PATH))
```

- [ ] **Step 5: Write SqliteBackend**

Create `server/src/dbbackend/sqlite.py`:

```python
"""Local SQLite backend (aiosqlite). Used for dev, tests and self-hosting."""

from __future__ import annotations

import sqlite3
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import aiosqlite

from src.dbbackend.base import BackendError, ExecResult, Params, Statement


class SqliteBackend:
    name = "sqlite"

    def __init__(self, path: str) -> None:
        self.path = path
        self._conn: aiosqlite.Connection | None = None

    async def open(self) -> None:
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    def _require(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise BackendError("SQLite backend is not open")
        return self._conn

    async def query(self, sql: str, params: Params = ()) -> list[dict[str, Any]]:
        conn = self._require()
        try:
            cursor = await conn.execute(sql, tuple(params))
            rows = await cursor.fetchall()
        except sqlite3.Error as exc:
            raise BackendError(str(exc)) from exc
        return [dict(row) for row in rows]

    async def execute(self, sql: str, params: Params = ()) -> ExecResult:
        conn = self._require()
        try:
            cursor = await conn.execute(sql, tuple(params))
            await conn.commit()
        except sqlite3.Error as exc:
            await conn.rollback()
            raise BackendError(str(exc)) from exc
        return ExecResult(cursor.lastrowid, max(cursor.rowcount, 0))

    async def batch(self, statements: Sequence[Statement]) -> list[ExecResult]:
        """Run the statements in one transaction; any failure rolls back all of them."""
        conn = self._require()
        results: list[ExecResult] = []
        try:
            await conn.execute("BEGIN")
            for sql, params in statements:
                cursor = await conn.execute(sql, tuple(params))
                results.append(ExecResult(cursor.lastrowid, max(cursor.rowcount, 0)))
            await conn.commit()
        except sqlite3.Error as exc:
            await conn.rollback()
            raise BackendError(str(exc)) from exc
        return results
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && uv run --extra dev pytest ../tests/test_db_backends.py -q`
Expected: PASS (14 passed)

- [ ] **Step 7: Lint and commit**

```bash
cd server && uv run --extra dev ruff check src/dbbackend ../tests/db_test_support.py ../tests/test_db_backends.py && uv run --extra dev ruff format src/dbbackend ../tests/db_test_support.py ../tests/test_db_backends.py
cd .. && git add server/src/dbbackend tests/db_test_support.py tests/test_db_backends.py
git commit -m "refactor(db): add backend interface and SqliteBackend

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Migration runner and baseline schema

**Files:**
- Create: `server/src/migrate.py`, `server/migrations/0001_baseline.sql`
- Create: `tests/test_migrate.py`

**Interfaces:**
- Consumes: `Backend`, `SqliteBackend`, `run_async`, `make_backend` (Task 1).
- Produces:
  - `src.migrate.MIGRATIONS_DIR: Path`
  - `src.migrate.Migration(version: str, name: str, statements: list[str])`
  - `src.migrate.split_statements(sql: str) -> list[str]`
  - `src.migrate.load_migrations(directory: Path = MIGRATIONS_DIR) -> list[Migration]`
  - `async src.migrate.apply_migrations(backend: Backend, directory: Path = MIGRATIONS_DIR) -> list[str]` (the versions it applied)
  - `async src.migrate.apply_one(backend: Backend, migration: Migration) -> None`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_migrate.py`:

```python
"""Tests for the plain-SQL migration runner and the baseline schema.

Run: cd server && uv run --extra dev pytest ../tests/test_migrate.py -q
"""

import sqlite3

import pytest
from db_test_support import make_backend, run_async


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


# ── split_statements ─────────────────────────────────────────────────────────


def test_split_statements_skips_comments_and_blank_lines():
    from src.migrate import split_statements

    sql = "-- header\n\nCREATE TABLE a (x INTEGER);\n-- between\nCREATE INDEX i ON a (x);\n"
    assert split_statements(sql) == ["CREATE TABLE a (x INTEGER);", "CREATE INDEX i ON a (x);"]


def test_split_statements_handles_multiline_statement():
    from src.migrate import split_statements

    sql = "CREATE TABLE a (\n  x INTEGER,\n  y TEXT\n);\n"
    assert split_statements(sql) == ["CREATE TABLE a (\n  x INTEGER,\n  y TEXT\n);"]


def test_split_statements_keeps_semicolon_inside_string():
    from src.migrate import split_statements

    sql = "INSERT INTO a (y) VALUES ('one;\ntwo');\nSELECT 1;\n"
    assert split_statements(sql) == ["INSERT INTO a (y) VALUES ('one;\ntwo');", "SELECT 1;"]


def test_split_statements_rejects_incomplete_statement():
    from src.migrate import split_statements

    with pytest.raises(ValueError, match="Incomplete"):
        split_statements("CREATE TABLE a (x INTEGER)\n")


# ── load_migrations ──────────────────────────────────────────────────────────


def test_load_migrations_orders_by_version(tmp_path):
    from src.migrate import load_migrations

    (tmp_path / "0002_second.sql").write_text("CREATE TABLE b (x INTEGER);\n")
    (tmp_path / "0001_first.sql").write_text("CREATE TABLE a (x INTEGER);\n")
    assert [(m.version, m.name) for m in load_migrations(tmp_path)] == [("0001", "first"), ("0002", "second")]


def test_load_migrations_rejects_bad_filename(tmp_path):
    from src.migrate import load_migrations

    (tmp_path / "1_bad.sql").write_text("SELECT 1;\n")
    with pytest.raises(ValueError, match="Bad migration filename"):
        load_migrations(tmp_path)


def test_load_migrations_rejects_duplicate_version(tmp_path):
    from src.migrate import load_migrations

    (tmp_path / "0001_a.sql").write_text("SELECT 1;\n")
    (tmp_path / "0001_b.sql").write_text("SELECT 1;\n")
    with pytest.raises(ValueError, match="Duplicate migration version"):
        load_migrations(tmp_path)


# ── apply_migrations ─────────────────────────────────────────────────────────


def test_apply_migrations_applies_pending_once(tmp_path):
    from src.migrate import apply_migrations

    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "0001_first.sql").write_text("CREATE TABLE a (x INTEGER);\n")
    (migrations / "0002_second.sql").write_text("CREATE TABLE b (x INTEGER);\n")
    backend = make_backend("sqlite", tmp_path)

    async def scenario():
        await backend.open()
        try:
            first = await apply_migrations(backend, migrations)
            second = await apply_migrations(backend, migrations)
            recorded = await backend.query("SELECT version, name FROM schema_migrations ORDER BY version", ())
            return first, second, recorded
        finally:
            await backend.close()

    first, second, recorded = run_async(scenario())
    assert first == ["0001", "0002"]
    assert second == []
    assert recorded == [{"version": "0001", "name": "first"}, {"version": "0002", "name": "second"}]


def test_apply_one_is_safe_to_repeat(tmp_path):
    """Two instances starting at once may both apply the baseline."""
    from src.migrate import apply_migrations, apply_one, load_migrations

    backend = make_backend("sqlite", tmp_path)
    baseline = load_migrations()[0]

    async def scenario():
        await backend.open()
        try:
            await apply_migrations(backend)
            await apply_one(backend, baseline)
            return await backend.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '0001'", ())
        finally:
            await backend.close()

    assert run_async(scenario()) == [{"n": 1}]


# ── Baseline schema ──────────────────────────────────────────────────────────

# fmt: off
EXPECTED_COLUMNS = {
    "feedback": ["id", "category", "message", "email", "page", "context", "ip_hash", "created_at"],
    "session_logs": [
        "id", "match_id", "room", "slot", "player_name", "mode", "log_data", "summary",
        "context", "ended_by", "ip_hash", "created_at", "updated_at",
    ],
    "client_events": ["id", "type", "message", "meta", "room", "slot", "ip_hash", "user_agent", "created_at"],
    "screenshots": ["id", "match_id", "slot", "frame", "data", "created_at"],
    "match_metrics": [
        "match_id", "mode", "peer_count", "frames", "duration_sec", "ended_by", "mismatch_count",
        "first_divergence_frame", "last_clean_frame", "rollbacks", "predictions", "correct_predictions",
        "max_rollback_depth", "failed_rollbacks", "tolerance_hits", "pacing_throttle_count",
        "parquet_path", "parquet_bytes", "entry_count", "rotated_at", "created_at",
    ],
    "desync_events": [
        "id", "match_id", "frame", "field", "slot", "trigger", "hashes_json", "vision_verdict_json",
        "vision_equal", "vision_confidence", "replay_meta_json", "created_at",
    ],
}
# fmt: on

EXPECTED_INDEXES = {
    "idx_session_logs_game_slot": ("session_logs", 1),
    "idx_screenshots_match": ("screenshots", 0),
    "idx_match_metrics_created_at": ("match_metrics", 0),
    "idx_desync_events_match_frame": ("desync_events", 0),
}


def test_baseline_creates_expected_schema(tmp_path):
    from src.migrate import apply_migrations

    backend = make_backend("sqlite", tmp_path)

    async def scenario():
        await backend.open()
        try:
            await apply_migrations(backend)
        finally:
            await backend.close()

    run_async(scenario())
    conn = sqlite3.connect(backend.path)
    try:
        for table, columns in EXPECTED_COLUMNS.items():
            actual = [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]
            assert actual == columns, table
        for index, (table, unique) in EXPECTED_INDEXES.items():
            listed = {row[1]: row[2] for row in conn.execute(f"PRAGMA index_list({table})")}
            assert listed.get(index) == unique, index
    finally:
        conn.close()


def test_baseline_upgrades_existing_alembic_database(tmp_path):
    """A database created by the old Alembic migrations keeps its data."""
    from src.migrate import apply_migrations

    backend = make_backend("sqlite", tmp_path)
    conn = sqlite3.connect(backend.path)
    conn.executescript(
        """
        CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL, PRIMARY KEY (version_num));
        INSERT INTO alembic_version VALUES ('0007');
        CREATE TABLE feedback (
            id INTEGER NOT NULL, category TEXT NOT NULL, message TEXT NOT NULL, email TEXT, page TEXT,
            context TEXT, ip_hash TEXT, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (id)
        );
        INSERT INTO feedback (category, message) VALUES ('bug', 'kept');
        """
    )
    conn.commit()
    conn.close()

    async def scenario():
        await backend.open()
        try:
            applied = await apply_migrations(backend)
            feedback = await backend.query("SELECT message FROM feedback", ())
            leftover = await backend.query(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alembic_version'", ()
            )
            return applied, feedback, leftover
        finally:
            await backend.close()

    applied, feedback, leftover = run_async(scenario())
    assert applied == ["0001"]
    assert feedback == [{"message": "kept"}]
    assert leftover == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && uv run --extra dev pytest ../tests/test_migrate.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.migrate'`

- [ ] **Step 3: Write the runner**

Create `server/src/migrate.py`:

```python
"""Plain-SQL schema migrations shared by every database backend.

Files live in server/migrations/ as NNNN_name.sql and are applied in order;
applied versions are recorded in schema_migrations. This replaced Alembic,
which cannot reach Cloudflare D1 over HTTP.

Rules for migration files:
- Only SQL statements and `--` comment lines. End every statement with `;`
  at the end of a line, and put one statement per line group.
- Make statements safe to re-run where SQLite allows it (IF NOT EXISTS,
  INSERT OR IGNORE). D1's HTTP batch is not documented as atomic, and two
  server instances can start at once during a deploy.
"""

from __future__ import annotations

import logging
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from src.dbbackend import Backend

log = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).parent.parent / "migrations"
_FILENAME_RE = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")

_CREATE_TRACKING = """CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)"""

_RECORD = "INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)"


@dataclass(frozen=True)
class Migration:
    version: str
    name: str
    statements: list[str]


def split_statements(sql: str) -> list[str]:
    """Split a migration file into statements, dropping comment-only lines."""
    statements: list[str] = []
    buffer = ""
    for line in sql.splitlines(keepends=True):
        stripped = line.strip()
        if not buffer and (not stripped or stripped.startswith("--")):
            continue
        buffer += line
        if sqlite3.complete_statement(buffer):
            statements.append(buffer.strip())
            buffer = ""
    if buffer.strip():
        raise ValueError(f"Incomplete SQL statement at end of migration: {buffer.strip()[:80]!r}")
    return statements


def load_migrations(directory: Path = MIGRATIONS_DIR) -> list[Migration]:
    """Read every NNNN_name.sql file in version order."""
    migrations: list[Migration] = []
    seen: set[str] = set()
    for path in sorted(directory.glob("*.sql")):
        match = _FILENAME_RE.match(path.name)
        if not match:
            raise ValueError(f"Bad migration filename: {path.name} (expected NNNN_name.sql)")
        version, name = match.groups()
        if version in seen:
            raise ValueError(f"Duplicate migration version {version}")
        seen.add(version)
        migrations.append(Migration(version, name, split_statements(path.read_text())))
    return migrations


async def apply_one(backend: Backend, migration: Migration) -> None:
    """Apply one migration and record it, in a single batch."""
    statements = [(sql, ()) for sql in migration.statements]
    statements.append((_RECORD, (migration.version, migration.name)))
    await backend.batch(statements)


async def apply_migrations(backend: Backend, directory: Path = MIGRATIONS_DIR) -> list[str]:
    """Apply pending migrations in order. Returns the versions applied."""
    migrations = load_migrations(directory)
    await backend.execute(_CREATE_TRACKING)
    applied = {row["version"] for row in await backend.query("SELECT version FROM schema_migrations", ())}
    newly_applied: list[str] = []
    for migration in migrations:
        if migration.version in applied:
            continue
        await apply_one(backend, migration)
        newly_applied.append(migration.version)
        log.info("Applied migration %s_%s", migration.version, migration.name)
    return newly_applied
```

- [ ] **Step 4: Write the baseline schema**

Create `server/migrations/0001_baseline.sql`. It reproduces what Alembic 0001–0007 built (verified against a fresh `alembic upgrade head` database). `id INTEGER PRIMARY KEY` is the same rowid alias as Alembic's `id INTEGER NOT NULL, PRIMARY KEY (id)`.

```sql
-- Baseline: the schema Alembic migrations 0001-0007 produced.
-- Re-runnable: applies cleanly over an existing Alembic-created database.

CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    email TEXT,
    page TEXT,
    context TEXT,
    ip_hash TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_logs (
    id INTEGER PRIMARY KEY,
    match_id TEXT NOT NULL,
    room TEXT NOT NULL,
    slot INTEGER,
    player_name TEXT,
    mode TEXT,
    log_data TEXT,
    summary TEXT,
    context TEXT,
    ended_by TEXT,
    ip_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_logs_game_slot ON session_logs (match_id, slot);

CREATE TABLE IF NOT EXISTS client_events (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    message TEXT,
    meta TEXT,
    room TEXT,
    slot INTEGER,
    ip_hash TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS screenshots (
    id INTEGER PRIMARY KEY,
    match_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    frame INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_screenshots_match ON screenshots (match_id, slot, frame);

CREATE TABLE IF NOT EXISTS match_metrics (
    match_id TEXT PRIMARY KEY,
    mode TEXT,
    peer_count INTEGER,
    frames INTEGER,
    duration_sec FLOAT,
    ended_by TEXT,
    mismatch_count INTEGER,
    first_divergence_frame INTEGER,
    last_clean_frame INTEGER,
    rollbacks INTEGER,
    predictions INTEGER,
    correct_predictions INTEGER,
    max_rollback_depth INTEGER,
    failed_rollbacks INTEGER,
    tolerance_hits INTEGER,
    pacing_throttle_count INTEGER,
    parquet_path TEXT,
    parquet_bytes INTEGER,
    entry_count INTEGER,
    rotated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_match_metrics_created_at ON match_metrics (created_at DESC);

CREATE TABLE IF NOT EXISTS desync_events (
    id INTEGER PRIMARY KEY,
    match_id TEXT NOT NULL,
    frame INTEGER NOT NULL,
    field TEXT NOT NULL,
    slot INTEGER,
    "trigger" TEXT NOT NULL,
    hashes_json TEXT,
    vision_verdict_json TEXT,
    vision_equal BOOLEAN,
    vision_confidence TEXT,
    replay_meta_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_desync_events_match_frame ON desync_events (match_id, frame);

DROP TABLE IF EXISTS alembic_version;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && uv run --extra dev pytest ../tests/test_migrate.py -q`
Expected: PASS (11 passed)

- [ ] **Step 6: Lint and commit**

```bash
cd server && uv run --extra dev ruff check src/migrate.py ../tests/test_migrate.py && uv run --extra dev ruff format src/migrate.py ../tests/test_migrate.py
cd .. && git add server/src/migrate.py server/migrations tests/test_migrate.py
git commit -m "refactor(db): add plain-SQL migration runner and baseline schema

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Switch db.py to the backend; remove Alembic

**Files:**
- Modify: `server/src/db.py` (full body; the public function names and SQL strings stay the same)
- Delete: `server/alembic/` (whole directory), `server/alembic.ini`
- Modify: `server/pyproject.toml` (drop the `aiosqlite`-adjacent lines `"alembic==1.15.2",` and `"sqlalchemy>=2.0.0",`), `server/uv.lock` (regenerate)
- Modify: `CLAUDE.md:58`, `README.md:153`
- Test: `tests/test_db.py` (add one test), existing `tests/test_session_logging.py`

**Interfaces:**
- Consumes: `backend_from_env`, `Backend` (Task 1); `apply_migrations` (Task 2).
- Produces: `src.db` public API. The names, signatures and return types are unchanged:
  - `init_db(db_path: str | None = None) -> None`, `close_db() -> None`
  - `insert_feedback(dict) -> int`, `upsert_session_log(dict) -> int`
  - `set_session_ended(match_id, slot, ended_by) -> None`, `insert_client_event(dict) -> int`
  - `execute_write(sql, params) -> None`
  - `insert_screenshot(match_id, slot, frame, data: bytes) -> int`, `get_screenshots(match_id) -> list[dict]`, `get_screenshot_data(id) -> bytes | None`
  - `query(sql, params) -> list[dict]`

  One behavior change: failed queries raise `src.dbbackend.BackendError` (a `RuntimeError`) instead of `sqlite3.Error`. No code outside `db.py` catches `sqlite3` errors (checked with `grep -rn "sqlite3\|aiosqlite\|IntegrityError" server/src`).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_db.py`:

```python
def test_init_db_records_baseline_and_is_rerunnable(tmp_db):
    """init_db applies the SQL baseline once; a second start applies nothing."""
    _run_async(_run_init_twice(tmp_db))


async def _run_init_twice(tmp_db):
    from src.db import close_db, init_db, query

    await init_db(tmp_db)
    await close_db()
    await init_db(tmp_db)
    rows = await query("SELECT version FROM schema_migrations ORDER BY version", ())
    assert [r["version"] for r in rows] == ["0001"]
    await close_db()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server && uv run --extra dev pytest ../tests/test_db.py::test_init_db_records_baseline_and_is_rerunnable -q`
Expected: FAIL. Alembic creates no `schema_migrations` table (`no such table: schema_migrations`).

- [ ] **Step 3: Rewrite db.py**

Replace the whole of `server/src/db.py` with:

```python
"""Database module: backend selection, migrations, query helpers.

Owns the single database backend. Call init_db() on startup, close_db() on
shutdown. The backend is local SQLite unless Cloudflare D1 is configured
(see src/dbbackend/__init__.py); both run the same SQLite-dialect SQL, and
schema changes are plain-SQL files in server/migrations/ (src/migrate.py).
"""

from __future__ import annotations

import logging

from src.dbbackend import Backend, backend_from_env
from src.migrate import apply_migrations

log = logging.getLogger(__name__)

_backend: Backend | None = None


async def init_db(db_path: str | None = None) -> None:
    """Open the backend and apply pending migrations."""
    global _backend
    backend = backend_from_env(db_path)
    await backend.open()
    try:
        applied = await apply_migrations(backend)
    except Exception:
        await backend.close()
        raise
    _backend = backend
    log.info("Database connected: %s (migrations applied: %s)", backend.name, ", ".join(applied) or "none")


async def close_db() -> None:
    """Close the backend."""
    global _backend
    if _backend is not None:
        await _backend.close()
        _backend = None
        log.info("Database connection closed")


def _require() -> Backend:
    if _backend is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    return _backend


async def insert_feedback(data: dict) -> int:
    """Insert a feedback row and return the new row ID."""
    result = await _require().execute(
        """INSERT INTO feedback (category, message, email, page, context, ip_hash)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (
            data["category"],
            data["message"],
            data.get("email"),
            data.get("page"),
            data.get("context"),
            data.get("ip_hash"),
        ),
    )
    return result.last_row_id


async def upsert_session_log(data: dict) -> int:
    """Insert or update a session log by (match_id, slot). Returns row ID."""
    result = await _require().execute(
        """INSERT INTO session_logs (match_id, room, slot, player_name, mode, log_data, summary, context, ip_hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(match_id, slot) DO UPDATE SET
             log_data=excluded.log_data, summary=excluded.summary,
             context=excluded.context, updated_at=datetime('now')""",
        (
            data["match_id"],
            data["room"],
            data.get("slot"),
            data.get("player_name"),
            data.get("mode"),
            data.get("log_data"),
            data.get("summary"),
            data.get("context"),
            data.get("ip_hash"),
        ),
    )
    return result.last_row_id


async def set_session_ended(match_id: str, slot: int | None, ended_by: str) -> None:
    """Mark how a session ended."""
    backend = _require()
    if slot is not None:
        await backend.execute(
            "UPDATE session_logs SET ended_by=?, updated_at=datetime('now') WHERE match_id=? AND slot=?",
            (ended_by, match_id, slot),
        )
    else:
        # Only update rows without an existing ended_by (don't overwrite leave/disconnect with game-end)
        await backend.execute(
            "UPDATE session_logs SET ended_by=?, updated_at=datetime('now') WHERE match_id=? AND ended_by IS NULL",
            (ended_by, match_id),
        )


async def insert_client_event(data: dict) -> int:
    """Insert a client event and return row ID."""
    result = await _require().execute(
        """INSERT INTO client_events (type, message, meta, room, slot, ip_hash, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            data["type"],
            data.get("message"),
            data.get("meta"),
            data.get("room"),
            data.get("slot"),
            data.get("ip_hash"),
            data.get("user_agent"),
        ),
    )
    return result.last_row_id


async def execute_write(sql: str, params: tuple) -> None:
    """Run a write query (DELETE, UPDATE) and commit."""
    await _require().execute(sql, params)


async def insert_screenshot(match_id: str, slot: int, frame: int, data: bytes) -> int:
    """Insert a gameplay screenshot and return row ID."""
    result = await _require().execute(
        "INSERT INTO screenshots (match_id, slot, frame, data) VALUES (?, ?, ?, ?)",
        (match_id, slot, frame, data),
    )
    return result.last_row_id


async def get_screenshots(match_id: str) -> list[dict]:
    """Return screenshot metadata (without data) for a match."""
    return await _require().query(
        "SELECT id, match_id, slot, frame, length(data) as size, created_at FROM screenshots WHERE match_id = ? ORDER BY slot, frame",
        (match_id,),
    )


async def get_screenshot_data(screenshot_id: int) -> bytes | None:
    """Return raw JPEG bytes for a screenshot."""
    rows = await _require().query("SELECT data FROM screenshots WHERE id = ?", (screenshot_id,))
    return rows[0]["data"] if rows else None


async def query(sql: str, params: tuple) -> list[dict]:
    """Run a read query and return results as a list of dicts."""
    return await _require().query(sql, params)
```

- [ ] **Step 4: Run the DB tests**

Run: `cd server && uv run --extra dev pytest ../tests/test_db.py ../tests/test_session_logging.py ../tests/test_db_backends.py ../tests/test_migrate.py -q`
Expected: PASS (all; `test_db.py` and `test_session_logging.py` previously had 9 passing tests and still pass unchanged)

- [ ] **Step 5: Remove Alembic and SQLAlchemy**

```bash
git rm -r -q server/alembic server/alembic.ini
```

In `server/pyproject.toml`, delete these two lines from `dependencies`:

```toml
    "alembic==1.15.2",
    "sqlalchemy>=2.0.0",
```

Then regenerate the lock and confirm nothing else imports them:

```bash
cd server && uv lock && grep -rn "alembic\|sqlalchemy" src ../tools ../scripts ../tests ; echo "exit=$?"
```
Expected: `uv lock` succeeds; grep prints no matches and `exit=1`.

- [ ] **Step 6: Update the docs lines**

In `CLAUDE.md` line 58, replace:
```
│       ├── db.py            # SQLite database (aiosqlite + Alembic migrations)
```
with:
```
│       ├── db.py            # database: SQLite or Cloudflare D1 backend (src/dbbackend/), SQL migrations in server/migrations/
```

In `README.md` line 153, replace:
```
    db.py              SQLite database (aiosqlite + Alembic migrations)
```
with:
```
    db.py              Database: SQLite or Cloudflare D1 backend, SQL migrations in server/migrations/
```

- [ ] **Step 7: Start the real server once**

Starting it proves the startup path (`src/main.py` lifespan → `init_db`) works end to end.

Use the Bash tool with `run_in_background: true`, then check the log with the Read tool, then stop it.

```bash
cd server && DB_PATH=$TMPDIR/kn-plan-a.db PORT=27999 uv run python -c "from src.main import run; run()" > $TMPDIR/kn-plan-a.log 2>&1
```
Wait until the log contains `Database connected: sqlite (migrations applied: 0001)`, then `curl -s localhost:27999/health` must return JSON with status ok. Stop the background task.

- [ ] **Step 8: Lint and commit**

```bash
cd server && uv run --extra dev ruff check src/db.py ../tests/test_db.py && uv run --extra dev ruff format src/db.py ../tests/test_db.py
cd .. && git add server/src/db.py server/pyproject.toml server/uv.lock tests/test_db.py CLAUDE.md README.md
git commit -m "refactor(db): route db.py through the backend; remove Alembic

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Open PR 1**

```bash
git fetch origin && git diff --stat origin/main...HEAD
```
Expected: only the files listed in Tasks 1–3 plus the spec and plan documents. Flag anything else to the user before continuing.

```bash
git push -u origin HEAD
gh pr create --base main --title "refactor(db): backend interface and plain-SQL migrations replace Alembic" --body "$(cat <<'EOF'
Part 1 of off-box log storage (spec: docs/superpowers/specs/2026-09-25-offbox-log-storage-design.md).

- `src/dbbackend/`: backend interface + `SqliteBackend`
- `src/migrate.py` + `server/migrations/0001_baseline.sql` replace Alembic (re-runnable over existing Alembic databases)
- `db.py` keeps its public API and SQL; now delegates to the backend
- Drops `alembic` and `sqlalchemy`

No behavior change: SQLite at `DB_PATH` as before.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Wait for the user to merge PR 1 before starting PR 2.

---

## PR 2: `feat(db)`

Start from the merged `main`: `git fetch origin && git switch -c feat/d1-backend origin/main`.

### Task 4: D1Backend and backend selection

**Files:**
- Create: `server/src/dbbackend/d1.py`
- Modify: `server/src/dbbackend/__init__.py` (`backend_from_env`)
- Modify: `tests/db_test_support.py` (add `FakeD1`, extend `make_backend`)
- Modify: `tests/test_db_backends.py` (`BACKENDS = ["sqlite", "d1"]`)
- Create: `tests/test_d1_backend.py`

**Interfaces:**
- Consumes: `Backend`, `BackendError`, `ExecResult`, `Params`, `Statement` (Task 1).
- Produces:
  - `src.dbbackend.d1.D1Backend(account_id: str, database_id: str, api_token: str, *, transport: httpx.AsyncBaseTransport | None = None, timeout: float = 15.0)`, `name = "d1"`
  - `backend_from_env()` returns `D1Backend` when `D1_DATABASE_ID` or `D1_API_TOKEN` is set and `db_path` is None. It raises `BackendError` naming any missing variable among `CF_ACCOUNT_ID`, `D1_DATABASE_ID`, `D1_API_TOKEN`.
  - `tests/db_test_support.FakeD1()` with `.handler(request) -> httpx.Response`, `.transport() -> httpx.MockTransport`, `.requests: list[dict]`. `FAKE_TOKEN = "test-token"`.

- [ ] **Step 1: Add the fake D1 to the test support module**

In `tests/db_test_support.py`, add these imports under `from pathlib import Path`:

```python
import json
import sqlite3

import httpx
```

Append:

```python
FAKE_TOKEN = "test-token"


class FakeD1:
    """In-process stand-in for D1's HTTP query API.

    Runs the SQL on an in-memory SQLite database and answers in D1's JSON
    shape: {"success", "errors", "messages", "result": [{"success",
    "results", "meta": {"last_row_id", "changes"}}]}. A failed batch is
    rolled back, like the Worker binding's documented behavior; whether the
    HTTP API does the same is checked by tests/test_d1_live.py.
    """

    def __init__(self) -> None:
        self.conn = sqlite3.connect(":memory:", check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.requests: list[dict] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != f"Bearer {FAKE_TOKEN}":
            return httpx.Response(403, json={"success": False, "errors": [{"code": 10000, "message": "auth"}]})
        body = json.loads(request.content)
        self.requests.append(body)
        statements = body["batch"] if "batch" in body else [body]
        results = []
        try:
            self.conn.execute("BEGIN")
            for statement in statements:
                cursor = self.conn.execute(statement["sql"], statement.get("params", []))
                rows = [dict(row) for row in cursor.fetchall()]
                results.append(
                    {
                        "success": True,
                        "results": rows,
                        "meta": {"last_row_id": cursor.lastrowid, "changes": max(cursor.rowcount, 0)},
                    }
                )
            self.conn.commit()
        except sqlite3.Error as exc:
            self.conn.rollback()
            return httpx.Response(
                400,
                json={"success": False, "errors": [{"code": 7500, "message": str(exc)}], "messages": [], "result": []},
            )
        return httpx.Response(200, json={"success": True, "errors": [], "messages": [], "result": results})
```

Change `make_backend` to:

```python
def make_backend(kind: str, tmp_path: Path):
    """Return an unopened backend of the given kind."""
    from src.dbbackend.d1 import D1Backend
    from src.dbbackend.sqlite import SqliteBackend

    if kind == "sqlite":
        return SqliteBackend(str(tmp_path / "contract.db"))
    if kind == "d1":
        return D1Backend("acct", "db", FAKE_TOKEN, transport=FakeD1().transport())
    raise ValueError(f"unknown backend kind: {kind}")
```

In `tests/test_db_backends.py` change `BACKENDS = ["sqlite"]` to `BACKENDS = ["sqlite", "d1"]`.

- [ ] **Step 2: Write the D1-specific failing tests**

Create `tests/test_d1_backend.py`:

```python
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
        "batch": [{"sql": "INSERT INTO t VALUES (?)", "params": [1]}, {"sql": "INSERT INTO t VALUES (?)", "params": [2]}]
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && uv run --extra dev pytest ../tests/test_d1_backend.py ../tests/test_db_backends.py -q`
Expected: FAIL with `ModuleNotFoundError: No module named 'src.dbbackend.d1'`

- [ ] **Step 4: Write D1Backend**

Create `server/src/dbbackend/d1.py`:

```python
"""Cloudflare D1 backend over the HTTP query API.

POST https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query
with a Bearer token. Only the Worker binding's batch is documented as a
transaction, so callers must not rely on batch() being all-or-nothing here.
The token is sent in a header and never appears in error messages.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import httpx

from src.dbbackend.base import BackendError, ExecResult, Params, Statement

_API_URL = "https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{database}/query"


def _encode_params(params: Params) -> list[Any]:
    encoded: list[Any] = []
    for value in params:
        if isinstance(value, bytes | bytearray | memoryview):
            raise TypeError("D1Backend cannot bind binary values; store blobs in the blob store")
        encoded.append(int(value) if isinstance(value, bool) else value)
    return encoded


def _exec_result(item: dict[str, Any]) -> ExecResult:
    meta = item.get("meta") or {}
    last_row_id = meta.get("last_row_id")
    return ExecResult(int(last_row_id) if last_row_id is not None else None, int(meta.get("changes") or 0))


class D1Backend:
    name = "d1"

    def __init__(
        self,
        account_id: str,
        database_id: str,
        api_token: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 15.0,
    ) -> None:
        self._url = _API_URL.format(account=account_id, database=database_id)
        self._token = api_token
        self._transport = transport
        self._timeout = timeout
        self._client: httpx.AsyncClient | None = None

    async def open(self) -> None:
        self._client = httpx.AsyncClient(
            transport=self._transport,
            timeout=self._timeout,
            headers={"Authorization": f"Bearer {self._token}"},
        )

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _post(self, body: dict[str, Any]) -> list[dict[str, Any]]:
        if self._client is None:
            raise BackendError("D1 backend is not open")
        try:
            response = await self._client.post(self._url, json=body)
        except httpx.HTTPError as exc:
            raise BackendError(f"D1 request failed: {type(exc).__name__}: {exc}") from exc
        try:
            payload = response.json()
        except ValueError:
            raise BackendError(f"D1 returned HTTP {response.status_code} with a non-JSON body") from None
        if not isinstance(payload, dict):
            raise BackendError(f"D1 returned HTTP {response.status_code} with an unexpected body")
        if response.status_code != 200 or not payload.get("success"):
            errors = payload.get("errors") or []
            detail = "; ".join(str(e.get("message", e)) if isinstance(e, dict) else str(e) for e in errors)
            raise BackendError(f"D1 query failed (HTTP {response.status_code}): {detail or 'no error detail'}")
        result = payload.get("result")
        if not isinstance(result, list):
            raise BackendError("D1 response has no result list")
        return result

    async def query(self, sql: str, params: Params = ()) -> list[dict[str, Any]]:
        result = await self._post({"sql": sql, "params": _encode_params(params)})
        return [dict(row) for row in (result[0].get("results") or [])] if result else []

    async def execute(self, sql: str, params: Params = ()) -> ExecResult:
        result = await self._post({"sql": sql, "params": _encode_params(params)})
        return _exec_result(result[0] if result else {})

    async def batch(self, statements: Sequence[Statement]) -> list[ExecResult]:
        if not statements:
            return []
        body = {"batch": [{"sql": sql, "params": _encode_params(params)} for sql, params in statements]}
        return [_exec_result(item) for item in await self._post(body)]
```

- [ ] **Step 5: Select D1 from the environment**

In `server/src/dbbackend/__init__.py`, replace `backend_from_env` with:

```python
def backend_from_env(db_path: str | None = None) -> Backend:
    """Pick the backend. An explicit db_path always means local SQLite.

    D1 is used when D1_DATABASE_ID or D1_API_TOKEN is set; a partial D1
    configuration is an error rather than a silent fallback to local disk.
    """
    from src.dbbackend.sqlite import SqliteBackend

    if db_path is None and (os.environ.get("D1_DATABASE_ID") or os.environ.get("D1_API_TOKEN")):
        from src.dbbackend.d1 import D1Backend

        values = {name: os.environ.get(name, "") for name in ("CF_ACCOUNT_ID", "D1_DATABASE_ID", "D1_API_TOKEN")}
        missing = [name for name, value in values.items() if not value]
        if missing:
            raise BackendError(f"D1 is partially configured; missing {', '.join(missing)}")
        return D1Backend(values["CF_ACCOUNT_ID"], values["D1_DATABASE_ID"], values["D1_API_TOKEN"])
    return SqliteBackend(db_path or os.environ.get("DB_PATH", DEFAULT_DB_PATH))
```

- [ ] **Step 6: Run all backend tests**

Run: `cd server && uv run --extra dev pytest ../tests/test_d1_backend.py ../tests/test_db_backends.py ../tests/test_migrate.py ../tests/test_db.py ../tests/test_session_logging.py -q`
Expected: PASS. The contract suite now runs every shared test against both `sqlite` and `d1`.

- [ ] **Step 7: Run the baseline migration through the fake D1**

This confirms the baseline SQL is accepted over the HTTP path (statement splitting, the batch shape). Append to `tests/test_d1_backend.py`:

```python
def test_baseline_migration_applies_through_d1():
    from src.migrate import apply_migrations

    fake = FakeD1()

    async def call(b):
        first = await apply_migrations(b)
        second = await apply_migrations(b)
        tables = await b.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", ())
        return first, second, [t["name"] for t in tables]

    first, second, tables = run_async(_run(_backend(fake.transport()), call))
    assert first == ["0001"]
    assert second == []
    assert {"feedback", "session_logs", "client_events", "screenshots", "match_metrics", "desync_events"} <= set(tables)
```

Run: `cd server && uv run --extra dev pytest ../tests/test_d1_backend.py -q`
Expected: PASS

- [ ] **Step 8: Lint and commit**

```bash
cd server && uv run --extra dev ruff check src/dbbackend ../tests/db_test_support.py ../tests/test_db_backends.py ../tests/test_d1_backend.py && uv run --extra dev ruff format src/dbbackend ../tests/db_test_support.py ../tests/test_db_backends.py ../tests/test_d1_backend.py
cd .. && git add server/src/dbbackend tests/db_test_support.py tests/test_db_backends.py tests/test_d1_backend.py
git commit -m "feat(db): add Cloudflare D1 backend over the HTTP query API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Opt-in live D1 test

**Files:**
- Create: `tests/test_d1_live.py`

**Interfaces:**
- Consumes: `D1Backend`, `run_async`.
- Produces: an opt-in test. Plan E runs it against the real database before cutover. It needs `KN_D1_LIVE=1` plus `CF_ACCOUNT_ID`, `D1_DATABASE_ID`, `D1_API_TOKEN`.

- [ ] **Step 1: Write the live test**

Create `tests/test_d1_live.py`:

```python
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
            await b.batch([(f"INSERT INTO {table} (n) VALUES (?)", (1,)), ("INSERT INTO kn_missing_table VALUES (1)", ())])
        return await b.query(f"SELECT COUNT(*) AS c FROM {table}", ())

    count = run_async(_with_table(scenario))[0]["c"]
    print(f"\nD1 HTTP batch atomic: {count == 0} (rows left after failed batch: {count})")
```

- [ ] **Step 2: Confirm it skips cleanly without credentials**

Run: `cd server && uv run --extra dev pytest ../tests/test_d1_live.py -q`
Expected: `3 skipped`

- [ ] **Step 3: Lint and commit**

```bash
cd server && uv run --extra dev ruff check ../tests/test_d1_live.py && uv run --extra dev ruff format ../tests/test_d1_live.py
cd .. && git add tests/test_d1_live.py
git commit -m "test(db): add opt-in live D1 checks for param types and batch atomicity

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Open PR 2**

```bash
git diff --stat origin/main...HEAD
```
Expected: only `server/src/dbbackend/d1.py`, `server/src/dbbackend/__init__.py`, and the four test files. Flag anything else to the user.

```bash
git push -u origin HEAD
gh pr create --base main --title "feat(db): Cloudflare D1 backend" --body "$(cat <<'EOF'
Part 2 of off-box log storage (spec: docs/superpowers/specs/2026-09-25-offbox-log-storage-design.md).

- `D1Backend`: D1's HTTP query API via httpx; errors never include the token; binary params rejected (blobs go to R2 in a later PR)
- `backend_from_env()` selects D1 when `CF_ACCOUNT_ID`/`D1_DATABASE_ID`/`D1_API_TOKEN` are set; partial config is an error
- Contract suite now runs against SQLite and a fake D1; opt-in live test (`KN_D1_LIVE=1`) for param types and batch atomicity

Not enabled anywhere yet: no D1 env vars are set until the cutover PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
