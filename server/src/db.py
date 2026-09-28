"""SQLite database module — aiosqlite connection, Alembic migrations, query helpers.

Owns the single kn.db connection. Call init_db() on startup, close_db() on shutdown.
"""

from __future__ import annotations

import asyncio
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


_SESSION_LOG_CHUNK_CAP = 12 * 1024 * 1024  # 12MB per (match_id, slot) — same budget
# the old single-blob rewrite used. Enforced by deleting the oldest chunks
# first so the latest entries (reconnect/desync events) survive.

_MAX_VALID_SEQ = 2**53  # exact-integer boundary for a JS double


def _valid_seq(value: object) -> int | None:
    """A client `seq` we can safely compare and dedupe by, or None.

    Must be a real int (bools are ints in Python — excluded explicitly) in
    [0, 2**53): the range a JS number represents exactly, since the client
    ring's `seq` originates as a JS integer. Anything else (missing, wrong
    type, negative, out of range) can't be trusted for ordering, so the
    caller keeps the entry but skips it for dedupe/high-water-mark purposes
    rather than dropping client data outright.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if not (0 <= value < _MAX_VALID_SEQ):
        return None
    return value


# Serializes append_session_log per (match_id, slot) so two concurrent
# flushes (e.g. a socket flush racing an HTTP fallback retry) can't both
# read the same `last_seq`, both decide their entries are new, and both
# insert a chunk. Reference-counted so the lock dict doesn't grow for the
# life of the process — an entry is dropped as soon as nothing holds it.
_append_locks: dict[tuple[str, int | None], asyncio.Lock] = {}
_append_lock_refcounts: dict[tuple[str, int | None], int] = {}
_append_locks_guard = asyncio.Lock()


async def _acquire_append_lock(key: tuple[str, int | None]) -> asyncio.Lock:
    async with _append_locks_guard:
        _append_lock_refcounts[key] = _append_lock_refcounts.get(key, 0) + 1
        return _append_locks.setdefault(key, asyncio.Lock())


async def _release_append_lock(key: tuple[str, int | None]) -> None:
    async with _append_locks_guard:
        remaining = _append_lock_refcounts.get(key, 1) - 1
        if remaining <= 0:
            _append_lock_refcounts.pop(key, None)
            _append_locks.pop(key, None)
        else:
            _append_lock_refcounts[key] = remaining


async def append_session_log(data: dict) -> int:
    """Append new, deduped log entries as a chunk and update session metadata.

    This never rewrites the `log_data` blob: new entries land in
    `session_log_chunks`, keyed by the client's monotonic `seq`. Entries
    with `seq` <= the stored `last_seq` are dropped — this dedupes resends
    and old cached clients that still send their entire ring on every
    flush. Returns the new `last_seq` so the caller can ack it back to the
    client.

    `data["epoch"]` identifies the client's in-memory ring instance (see
    migration 0008). When it differs from the epoch already stored for this
    (match_id, slot), `last_seq` is treated as -1 for this flush (and the
    new epoch adopted) instead of deduping the new ring's entries against
    the old one's high-water mark — otherwise a reload, reconnect, or a
    spectator claiming a slot a previous player used would have every entry
    look like a dup of stale state and get silently dropped. A missing/empty
    epoch (legacy caller) skips this check entirely, preserving the old
    dedupe-by-last_seq-only behavior.

    Concurrent flushes for the same (match_id, slot) are serialized by
    `_acquire_append_lock` so two overlapping calls can't both read the same
    `last_seq` and both insert a chunk for entries the other has already
    covered.
    """
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    match_id = data["match_id"]
    slot = data.get("slot")
    epoch = data.get("epoch") or ""
    lock = await _acquire_append_lock((match_id, slot))
    async with lock:
        try:
            return await _append_session_log_locked(data, match_id, slot, epoch)
        finally:
            await _release_append_lock((match_id, slot))


async def _append_session_log_locked(data: dict, match_id: str, slot: int | None, epoch: str) -> int:
    cursor = await _db.execute(
        "SELECT last_seq, log_epoch FROM session_logs WHERE match_id = ? AND slot IS ?",
        (match_id, slot),
    )
    row = await cursor.fetchone()
    stored_epoch = row[1] if row and row[1] is not None else ""
    # No epoch supplied (legacy caller) behaves exactly as before: dedupe
    # against whatever last_seq is already stored. A supplied epoch that
    # doesn't match the stored one resets the high-water mark.
    same_epoch = not epoch or epoch == stored_epoch
    # -1 means "no entries acked yet" (client seqs start at 0).
    current_last_seq = row[0] if row and row[0] is not None and same_epoch else -1

    entries = data.get("entries") or []
    new_entries = []
    max_seq = current_last_seq
    for e in entries:
        if not isinstance(e, dict):
            continue
        seq = _valid_seq(e.get("seq"))
        if seq is not None:
            if seq <= current_last_seq:
                continue
            max_seq = max(max_seq, seq)
        # An entry without a usable seq can't be deduped safely, so it's
        # always kept rather than silently dropped — see _valid_seq.
        new_entries.append(e)

    if new_entries:
        entries_json = json.dumps(new_entries)
        seqs = [_valid_seq(e.get("seq")) for e in new_entries]
        seqs = [s for s in seqs if s is not None]
        first_seq = min(seqs) if seqs else current_last_seq
        await _db.execute(
            "INSERT INTO session_log_chunks (match_id, slot, first_seq, last_seq, entries, size) VALUES (?, ?, ?, ?, ?, ?)",
            (match_id, slot, first_seq, max_seq, entries_json, len(entries_json)),
        )
        await _enforce_chunk_cap(match_id, slot)

    await _db.execute(
        """INSERT INTO session_logs (match_id, room, slot, player_name, mode, log_data, summary, context, ip_hash, last_seq, log_epoch, updated_at)
           VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(match_id, slot) DO UPDATE SET
             summary=excluded.summary, context=excluded.context,
             ip_hash=excluded.ip_hash, updated_at=datetime('now'),
             last_seq=CASE WHEN session_logs.log_epoch = excluded.log_epoch
                            THEN MAX(session_logs.last_seq, excluded.last_seq)
                            ELSE excluded.last_seq END,
             log_epoch=excluded.log_epoch""",
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
            epoch,
        ),
    )
    await _db.commit()
    return max_seq


async def _enforce_chunk_cap(match_id: str, slot: int | None) -> None:
    """Delete the oldest chunks for (match_id, slot) until total size is under the cap.

    Uses the `size` column recorded at insert time instead of re-reading
    `length(entries)` for every stored chunk on every flush — with a long
    match accumulating dozens of chunks, that re-read cost was paid again
    on every single flush.
    """
    if _db is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    cursor = await _db.execute(
        "SELECT COALESCE(SUM(size), 0) FROM session_log_chunks WHERE match_id = ? AND slot IS ?",
        (match_id, slot),
    )
    row = await cursor.fetchone()
    if not row or row[0] <= _SESSION_LOG_CHUNK_CAP:
        return
    # Keep the newest chunks whose cumulative size (counted from the newest
    # backwards) still fits the cap; delete everything older in one
    # statement — equivalent to the old "pop the oldest until under cap"
    # loop, without a per-row DELETE.
    await _db.execute(
        """
        DELETE FROM session_log_chunks
        WHERE match_id = ? AND slot IS ?
          AND id NOT IN (
              SELECT id FROM (
                  SELECT id, SUM(size) OVER (ORDER BY id DESC) AS running_total
                  FROM session_log_chunks
                  WHERE match_id = ? AND slot IS ?
              )
              WHERE running_total <= ?
          )
        """,
        (match_id, slot, match_id, slot, _SESSION_LOG_CHUNK_CAP),
    )


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
