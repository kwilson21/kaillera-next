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
