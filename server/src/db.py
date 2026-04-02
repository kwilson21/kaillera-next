"""SQLite database module — aiosqlite connection, Alembic migrations, query helpers.

Owns the single kn.db connection. Call init_db() on startup, close_db() on shutdown.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import aiosqlite

log = logging.getLogger(__name__)

_db: aiosqlite.Connection | None = None

_DEFAULT_DB_PATH = os.path.join("data", "kn.db")


async def init_db(db_path: str | None = None) -> None:
    """Run Alembic migrations and open the aiosqlite connection."""
    global _db
    path = db_path or os.environ.get("DB_PATH", _DEFAULT_DB_PATH)
    Path(path).parent.mkdir(parents=True, exist_ok=True)

    # Run Alembic migrations synchronously (they use their own connection)
    _run_migrations(path)

    _db = await aiosqlite.connect(path)
    _db.row_factory = aiosqlite.Row
    await _db.execute("PRAGMA journal_mode=WAL")
    log.info("Database connected: %s", path)


def _run_migrations(db_path: str) -> None:
    """Run Alembic upgrade head against the given database path."""
    import sqlite3

    from alembic import command
    from alembic.config import Config

    alembic_dir = Path(__file__).parent.parent / "alembic"
    ini_path = Path(__file__).parent.parent / "alembic.ini"

    cfg = Config(str(ini_path))
    cfg.set_main_option("script_location", str(alembic_dir))
    cfg.set_main_option("sqlalchemy.url", f"sqlite:///{db_path}")

    # Guard: if the DB was stamped with a revision that no longer exists
    # (e.g. a migration was added then removed), fix it by stamping to the
    # latest known revision before running upgrade.
    try:
        command.upgrade(cfg, "head")
    except Exception as exc:
        if "No such revision" not in str(exc) and "Can't locate revision" not in str(exc):
            raise
        log.warning("Alembic revision mismatch — fixing: %s", exc)
        from alembic.script import ScriptDirectory

        script = ScriptDirectory.from_config(cfg)
        head = script.get_current_head()
        conn = sqlite3.connect(db_path)
        conn.execute("UPDATE alembic_version SET version_num = ?", (head,))
        conn.commit()
        conn.close()
        log.info("Stamped alembic_version to %s, retrying migrations", head)
        command.upgrade(cfg, "head")


async def close_db() -> None:
    """Close the aiosqlite connection."""
    global _db
    if _db:
        await _db.close()
        _db = None
        log.info("Database connection closed")


async def insert_feedback(data: dict) -> int:
    """Insert a feedback row and return the new row ID."""
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    cursor = await _db.execute(
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
    await _db.commit()
    return cursor.lastrowid


async def upsert_session_log(data: dict) -> int:
    """Insert or update a session log by (match_id, slot). Returns row ID."""
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    cursor = await _db.execute(
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
    await _db.commit()
    return cursor.lastrowid


async def set_session_ended(match_id: str, slot: int | None, ended_by: str) -> None:
    """Mark how a session ended."""
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    if slot is not None:
        await _db.execute(
            "UPDATE session_logs SET ended_by=?, updated_at=datetime('now') WHERE match_id=? AND slot=?",
            (ended_by, match_id, slot),
        )
    else:
        # Only update rows without an existing ended_by (don't overwrite leave/disconnect with game-end)
        await _db.execute(
            "UPDATE session_logs SET ended_by=?, updated_at=datetime('now') WHERE match_id=? AND ended_by IS NULL",
            (ended_by, match_id),
        )
    await _db.commit()


async def insert_client_event(data: dict) -> int:
    """Insert a client event and return row ID."""
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    cursor = await _db.execute(
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
    await _db.commit()
    return cursor.lastrowid


async def execute_write(sql: str, params: tuple) -> None:
    """Run a write query (DELETE, UPDATE) and commit."""
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    await _db.execute(sql, params)
    await _db.commit()


async def query(sql: str, params: tuple) -> list[dict]:
    """Run a read query and return results as a list of dicts."""
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    cursor = await _db.execute(sql, params)
    rows = await cursor.fetchall()
    if not rows:
        return []
    columns = [desc[0] for desc in cursor.description]
    return [dict(zip(columns, row, strict=False)) for row in rows]
