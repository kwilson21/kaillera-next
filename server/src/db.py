"""SQLite database module — aiosqlite connection, Alembic migrations, query helpers.

Owns the single kn.db connection. Call init_db() on startup, close_db() on shutdown.
"""

from __future__ import annotations

import json
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
    # (for example, a migration was added then later removed), stamp to the
    # latest known revision and retry. This keeps deploys from crashing on
    # older data volumes that still carry the orphaned revision marker.
    try:
        command.upgrade(cfg, "head")
    except Exception as exc:
        if "No such revision" not in str(exc) and "Can't locate revision" not in str(exc):
            raise
        log.warning("Alembic revision mismatch -- fixing: %s", exc)
        from alembic.script import ScriptDirectory

        script = ScriptDirectory.from_config(cfg)
        head = script.get_current_head()
        conn = sqlite3.connect(db_path)
        try:
            conn.execute("UPDATE alembic_version SET version_num = ?", (head,))
            conn.commit()
        finally:
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


_SESSION_LOG_CHUNK_CAP = 12 * 1024 * 1024  # 12MB per (match_id, slot) — same budget
# the old single-blob rewrite used. Enforced by deleting the oldest chunks
# first so the latest entries (reconnect/desync events) survive.


async def append_session_log(data: dict) -> int:
    """Append new, deduped log entries as a chunk and update session metadata.

    Unlike `upsert_session_log`, this never rewrites the `log_data` blob:
    new entries land in `session_log_chunks`, keyed by the client's
    monotonic `seq`. Entries with `seq` <= the stored `last_seq` are
    dropped — this dedupes resends and old cached clients that still send
    their entire ring on every flush. Returns the new `last_seq` so the
    caller can ack it back to the client.
    """
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    match_id = data["match_id"]
    slot = data.get("slot")

    cursor = await _db.execute(
        "SELECT last_seq FROM session_logs WHERE match_id = ? AND slot IS ?",
        (match_id, slot),
    )
    row = await cursor.fetchone()
    # -1 means "no entries acked yet" (client seqs start at 0).
    current_last_seq = row[0] if row and row[0] is not None else -1

    entries = data.get("entries") or []
    new_entries = []
    max_seq = current_last_seq
    for e in entries:
        if not isinstance(e, dict):
            continue
        seq = e.get("seq")
        if isinstance(seq, (int, float)):
            if seq <= current_last_seq:
                continue
            max_seq = max(max_seq, seq)
        new_entries.append(e)

    if new_entries:
        seqs = [e.get("seq") for e in new_entries if isinstance(e.get("seq"), (int, float))]
        first_seq = min(seqs) if seqs else current_last_seq
        await _db.execute(
            "INSERT INTO session_log_chunks (match_id, slot, first_seq, last_seq, entries) VALUES (?, ?, ?, ?, ?)",
            (match_id, slot, first_seq, max_seq, json.dumps(new_entries)),
        )
        await _enforce_chunk_cap(match_id, slot)

    await _db.execute(
        """INSERT INTO session_logs (match_id, room, slot, player_name, mode, log_data, summary, context, ip_hash, last_seq, updated_at)
           VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(match_id, slot) DO UPDATE SET
             summary=excluded.summary, context=excluded.context,
             ip_hash=excluded.ip_hash, updated_at=datetime('now'), last_seq=excluded.last_seq""",
        (
            match_id,
            data["room"],
            slot,
            data.get("player_name"),
            data.get("mode"),
            data.get("summary"),
            data.get("context"),
            data.get("ip_hash"),
            max_seq,
        ),
    )
    await _db.commit()
    return max_seq


async def _enforce_chunk_cap(match_id: str, slot: int | None) -> None:
    """Delete the oldest chunks for (match_id, slot) until total size is under the cap."""
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    cursor = await _db.execute(
        "SELECT id, length(entries) as sz FROM session_log_chunks WHERE match_id = ? AND slot IS ? ORDER BY id",
        (match_id, slot),
    )
    rows = await cursor.fetchall()
    total = sum(r[1] for r in rows)
    idx = 0
    while total > _SESSION_LOG_CHUNK_CAP and idx < len(rows):
        await _db.execute("DELETE FROM session_log_chunks WHERE id = ?", (rows[idx][0],))
        total -= rows[idx][1]
        idx += 1


async def get_full_log_entries(match_id: str, slot: int | None, log_data_str: str | None) -> list[dict]:
    """Assemble a session's full entry list: legacy `log_data` (if any) plus
    every `session_log_chunks` row for (match_id, slot), in insertion order.

    Used anywhere that used to just `json.loads(log_data)` — admin detail,
    export, and match_rotation — so their response/output shapes are
    unchanged even though storage moved to append-only chunks.
    """
    entries: list = []
    if log_data_str:
        try:
            legacy = json.loads(log_data_str)
        except (json.JSONDecodeError, TypeError):
            legacy = []
        if isinstance(legacy, list):
            entries.extend(legacy)

    if _db is None:
        return entries

    cursor = await _db.execute(
        "SELECT entries FROM session_log_chunks WHERE match_id = ? AND slot IS ? ORDER BY id",
        (match_id, slot),
    )
    rows = await cursor.fetchall()
    for r in rows:
        try:
            chunk = json.loads(r[0])
        except (json.JSONDecodeError, TypeError):
            chunk = []
        if isinstance(chunk, list):
            entries.extend(chunk)
    return entries


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


async def insert_screenshot(match_id: str, slot: int, frame: int, data: bytes) -> int:
    """Insert a gameplay screenshot and return row ID."""
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    cursor = await _db.execute(
        "INSERT INTO screenshots (match_id, slot, frame, data) VALUES (?, ?, ?, ?)",
        (match_id, slot, frame, data),
    )
    await _db.commit()
    return cursor.lastrowid


async def get_screenshots(match_id: str) -> list[dict]:
    """Return screenshot metadata (without data) for a match."""
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    cursor = await _db.execute(
        "SELECT id, match_id, slot, frame, length(data) as size, created_at FROM screenshots WHERE match_id = ? ORDER BY slot, frame",
        (match_id,),
    )
    rows = await cursor.fetchall()
    if not rows:
        return []
    columns = [desc[0] for desc in cursor.description]
    return [dict(zip(columns, row, strict=False)) for row in rows]


async def get_screenshot_data(screenshot_id: int) -> bytes | None:
    """Return raw JPEG bytes for a screenshot."""
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    cursor = await _db.execute("SELECT data FROM screenshots WHERE id = ?", (screenshot_id,))
    row = await cursor.fetchone()
    return row[0] if row else None


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
