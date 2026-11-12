"""src/schema.py must describe the database the migrations build.

Run: cd server && uv run pytest ../tests/test_schema.py -v
"""

import asyncio
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from src import db, schema


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


def _run(coro):
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(coro)).result()


@pytest.fixture(scope="module")
def migrated(tmp_path_factory):
    path = str(tmp_path_factory.mktemp("schema") / "t.db")

    async def build():
        await db.init_db(path)
        await db.close_db()

    _run(build())
    conn = sqlite3.connect(path)
    yield conn
    conn.close()


def _columns(conn, table):
    return {
        row[1]: {"notnull": bool(row[3]), "pk": bool(row[5])} for row in conn.execute(f'PRAGMA table_info("{table}")')
    }


def test_every_migrated_table_is_declared(migrated):
    in_db = {
        row[0]
        for row in migrated.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    }
    assert in_db - {"schema_migrations"} == set(schema.Base.metadata.tables)


@pytest.mark.parametrize("table", sorted(schema.Base.metadata.tables))
def test_columns_match_the_migrations(migrated, table):
    declared = schema.Base.metadata.tables[table]
    actual = _columns(migrated, table)
    assert set(actual) == {c.name for c in declared.columns}
    for column in declared.columns:
        assert actual[column.name]["pk"] == column.primary_key, column.name
        if not column.primary_key:
            assert actual[column.name]["notnull"] == (not column.nullable), column.name
