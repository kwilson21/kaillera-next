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
