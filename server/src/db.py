"""Database module: backend selection, migrations, query helpers.

Owns the single database backend. Call init_db() on startup, close_db() on
shutdown. The backend is local SQLite unless Cloudflare D1 is configured
(see src/dbbackend/__init__.py); both run the same SQLite-dialect SQL, and
schema changes are plain-SQL files in server/migrations/ (src/migrate.py).
Screenshot bytes live in the blob store (src/blobstore.py); rows keep the key.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path

from src.blobstore import BlobStore, BlobStoreError, blobstore_from_env
from src.dbbackend import DEFAULT_DB_PATH, Backend, backend_from_env
from src.migrate import apply_migrations

log = logging.getLogger(__name__)

_backend: Backend | None = None
_blobs: BlobStore | None = None


async def init_db(
    db_path: str | None = None, *, backend: Backend | None = None, blobs: BlobStore | None = None
) -> None:
    """Open the backend and apply pending migrations.

    `backend` and `blobs` override the environment-selected ones (tests pass
    fakes). Without R2 configured, blobs go in a `blobs` folder next to the
    SQLite file.
    """
    global _backend, _blobs, _flag_lock
    _flag_lock = asyncio.Lock()  # bound to the event loop that opens the database
    _upload_check_cache.clear()
    _registered_matches.clear()
    local_root = Path(db_path or os.environ.get("DB_PATH", DEFAULT_DB_PATH)).parent / "blobs"
    _blobs = blobs or blobstore_from_env(local_root)
    backend = backend or backend_from_env(db_path)
    await backend.open()
    try:
        applied = await apply_migrations(backend)
    except Exception:
        await backend.close()
        raise
    _backend = backend
    log.info(
        "Database connected: %s (migrations applied: %s; blobs: %s)",
        backend.name,
        ", ".join(applied) or "none",
        _blobs.name,
    )


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


_SESSION_LOG_CHUNK_CAP = 12 * 1024 * 1024  # 12MB per (match_id, slot) — same budget
# the old single-blob rewrite used. Enforced by deleting the oldest chunks
# first so the latest entries (reconnect/desync events) survive.

# Largest chunk written in one row. A reconnect re-sends the whole ring (MBs)
# in one flush, and a Cloudflare D1 row holds at most 2 MB, so a flush is
# split into chunks of at most this many bytes of JSON.
_SESSION_LOG_CHUNK_MAX = 512 * 1024

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
    migration 0002_session_log_chunks.sql). When it differs from the epoch
    already stored for this (match_id, slot), `last_seq` is treated as -1
    for this flush (and the new epoch adopted) instead of deduping the new
    ring's entries against the old one's high-water mark — otherwise a
    reload, reconnect, or a spectator claiming a slot a previous player used
    would have every entry look like a dup of stale state and get silently
    dropped. A missing/empty epoch (legacy caller) skips this check
    entirely, preserving the old dedupe-by-last_seq-only behavior.

    Concurrent flushes for the same (match_id, slot) are serialized by
    `_acquire_append_lock` so two overlapping calls can't both read the same
    `last_seq` and both insert a chunk for entries the other has already
    covered.
    """
    _require()
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
    backend = _require()
    rows = await backend.query(
        "SELECT last_seq, log_epoch FROM session_logs WHERE match_id = ? AND slot IS ?",
        (match_id, slot),
    )
    row = rows[0] if rows else None
    stored_epoch = row["log_epoch"] if row and row["log_epoch"] is not None else ""
    # No epoch supplied (legacy caller) behaves exactly as before: dedupe
    # against whatever last_seq is already stored. A supplied epoch that
    # doesn't match the stored one resets the high-water mark.
    same_epoch = not epoch or epoch == stored_epoch
    # -1 means "no entries acked yet" (client seqs start at 0).
    current_last_seq = row["last_seq"] if row and row["last_seq"] is not None and same_epoch else -1

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

    # The chunk inserts, cap enforcement and metadata upsert commit together.
    statements: list[tuple[str, tuple]] = []
    if new_entries:
        high_seq = current_last_seq
        new_bytes = 0
        for group in _split_entries(new_entries):
            entries_json = json.dumps(group)
            seqs = [s for s in (_valid_seq(e.get("seq")) for e in group) if s is not None]
            first_seq = min(seqs) if seqs else high_seq
            high_seq = max([high_seq, *seqs])
            new_bytes += len(entries_json)
            statements.append(
                (
                    "INSERT INTO session_log_chunks (match_id, slot, first_seq, last_seq, entries, size) VALUES (?, ?, ?, ?, ?, ?)",
                    (match_id, slot, first_seq, high_seq, entries_json, len(entries_json)),
                )
            )
        if await _stored_chunk_bytes(match_id, slot) + new_bytes > _SESSION_LOG_CHUNK_CAP:
            statements.append(_chunk_cap_statement(match_id, slot))

    statements.append(
        (
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
    )
    await backend.batch(statements)
    return max_seq


def _split_entries(entries: list[dict]) -> list[list[dict]]:
    """Group entries in order so each group's JSON is at most _SESSION_LOG_CHUNK_MAX.

    A single entry larger than the limit gets a group of its own.
    """
    groups: list[list[dict]] = []
    current: list[dict] = []
    current_bytes = 2  # the enclosing "[]"
    for entry in entries:
        entry_bytes = len(json.dumps(entry)) + 2  # ", " separator
        if current and current_bytes + entry_bytes > _SESSION_LOG_CHUNK_MAX:
            groups.append(current)
            current, current_bytes = [], 2
        current.append(entry)
        current_bytes += entry_bytes
    if current:
        groups.append(current)
    return groups


async def _stored_chunk_bytes(match_id: str, slot: int | None) -> int:
    """Total size of the chunks already stored for (match_id, slot).

    Uses the `size` column recorded at insert time instead of re-reading
    `length(entries)` for every stored chunk on every flush.
    """
    rows = await _require().query(
        "SELECT COALESCE(SUM(size), 0) AS total FROM session_log_chunks WHERE match_id = ? AND slot IS ?",
        (match_id, slot),
    )
    return int(rows[0]["total"]) if rows else 0


def _chunk_cap_statement(match_id: str, slot: int | None) -> tuple[str, tuple]:
    """DELETE the oldest chunks for (match_id, slot) until the total fits the cap.

    Keeps the newest chunks whose cumulative size (counted from the newest
    backwards) still fits, in one statement rather than a per-row DELETE.
    """
    return (
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

    if _backend is None:
        return entries

    rows = await _backend.query(
        "SELECT entries FROM session_log_chunks WHERE match_id = ? AND slot IS ? ORDER BY id",
        (match_id, slot),
    )
    for r in rows:
        try:
            chunk = json.loads(r["entries"])
        except (json.JSONDecodeError, TypeError):
            chunk = []
        if isinstance(chunk, list):
            entries.extend(chunk)
    return entries


# Log uploads for a match are accepted until 30 min after game-end, or 4 h
# after start when no end was recorded (crash, restart, room closed): spec §5.
_UPLOAD_GRACE_AFTER_END = "-30 minutes"
_UPLOAD_WINDOW_WITHOUT_END = "-4 hours"
_UPLOAD_CHECK_TTL_SEC = 60.0
_UPLOAD_CHECK_CACHE_MAX = 10_000
_upload_check_cache: dict[tuple[str, str], tuple[bool, float]] = {}
_registered_matches: set[str] = set()


async def register_match(match_id: str, room: str) -> None:
    """Record a match. Idempotent, and writes at most once per process.

    Called at start-game and again from every Socket.IO log flush for the
    room's live match, which covers matches started before a deploy and
    start-game registrations that failed.
    """
    if match_id in _registered_matches:
        return
    await _require().execute(
        "INSERT OR IGNORE INTO match_retention (match_id, room) VALUES (?, ?)",
        (match_id, room),
    )
    if len(_registered_matches) >= _UPLOAD_CHECK_CACHE_MAX:
        _registered_matches.clear()
    _registered_matches.add(match_id)
    _upload_check_cache.pop((match_id, room), None)


async def match_accepts_uploads(match_id: str, room: str) -> bool:
    """Whether log uploads for `match_id` from `room` are still accepted.

    Cached per (match, room) for 60 s, hits and misses alike, so uploads
    quoting made-up match ids cost at most one query a minute each.
    """
    key = (match_id, room)
    now = time.monotonic()
    cached = _upload_check_cache.get(key)
    if cached and cached[1] > now:
        return cached[0]
    rows = await _require().query(
        """SELECT 1 AS ok FROM match_retention
           WHERE match_id = ? AND room = ? AND deleting_at IS NULL
             AND ((ended_at IS NOT NULL AND ended_at > datetime('now', ?))
                  OR (ended_at IS NULL AND created_at > datetime('now', ?)))""",
        (match_id, room, _UPLOAD_GRACE_AFTER_END, _UPLOAD_WINDOW_WITHOUT_END),
    )
    accepted = bool(rows)
    if len(_upload_check_cache) >= _UPLOAD_CHECK_CACHE_MAX:
        _upload_check_cache.clear()
    _upload_check_cache[key] = (accepted, now + _UPLOAD_CHECK_TTL_SEC)
    return accepted


async def find_recent_match(room: str) -> str | None:
    """The room's most recent match still inside its upload window, or None.

    Links feedback that carries only a room code to the match it's about.
    """
    rows = await _require().query(
        """SELECT match_id FROM match_retention
           WHERE room = ? AND deleting_at IS NULL
             AND ((ended_at IS NOT NULL AND ended_at > datetime('now', ?))
                  OR (ended_at IS NULL AND created_at > datetime('now', ?)))
           ORDER BY created_at DESC LIMIT 1""",
        (room, _UPLOAD_GRACE_AFTER_END, _UPLOAD_WINDOW_WITHOUT_END),
    )
    return rows[0]["match_id"] if rows else None


async def flag_match(match_id: str, reasons: list[dict], *, auto: bool = True) -> None:
    """Mark a match flagged (kept until resolved) and merge `reasons` into it.

    Idempotent: a reason whose signal is already stored keeps the larger
    count and the earliest frame, so classifying the same logs again doesn't
    double-count. Only an existing row is flagged: callers pass client-chosen
    ids, and creating a row would reopen uploads for them (a match from
    before registration is registered by rotation first). Matches being
    deleted are left alone.

    `auto` flags come from signals a client can trigger (logs, crash events,
    vision); once flagged matches hold more than BUDGET_AUTO_FLAGGED_BYTES,
    they're recorded with auto_flag_capped = 1 but keep the normal tier.
    Feedback and manual flags pass auto=False and are never capped.
    """
    if not reasons:
        return
    async with _flag_lock:
        await _flag_match_locked(match_id, reasons, auto)


# flag_match reads, merges and rewrites flag_reasons; concurrent calls for
# the same match would overwrite each other. Flags are rare, so one lock.
_flag_lock = asyncio.Lock()


# Spec §5 sizes this for R2; while logs live in D1 (500 MB free) it's lower.
_DEFAULT_BUDGET_AUTO_FLAGGED_BYTES = 200 * 1024 * 1024


async def _flagged_bytes() -> int:
    """Bytes of session-log chunks and screenshots held by flagged matches."""
    rows = await _require().query(
        """SELECT
             COALESCE((SELECT SUM(c.size) FROM session_log_chunks c
                       JOIN match_retention r ON r.match_id = c.match_id WHERE r.tier = 'flagged'), 0)
           + COALESCE((SELECT SUM(COALESCE(s.size, length(s.data), 0)) FROM screenshots s
                       JOIN match_retention r ON r.match_id = s.match_id WHERE r.tier = 'flagged'), 0) AS bytes""",
        (),
    )
    return int(rows[0]["bytes"] or 0) if rows else 0


async def _flag_match_locked(match_id: str, reasons: list[dict], auto: bool) -> None:
    backend = _require()
    rows = await backend.query(
        "SELECT flag_reasons, deleting_at, tier FROM match_retention WHERE match_id = ?", (match_id,)
    )
    if not rows or rows[0]["deleting_at"]:
        return
    try:
        stored = json.loads(rows[0]["flag_reasons"] or "[]")
    except (json.JSONDecodeError, TypeError):
        stored = []
    by_signal = {r.get("signal"): dict(r) for r in stored if isinstance(r, dict)}
    for reason in reasons:
        old = by_signal.get(reason.get("signal"))
        if old is None:
            by_signal[reason.get("signal")] = dict(reason)
            continue
        old["count"] = max(int(old.get("count") or 0), int(reason.get("count") or 0))
        frame = reason.get("first_f")
        if isinstance(frame, int | float) and (old.get("first_f") is None or frame < old["first_f"]):
            old["first_f"] = frame
    merged = json.dumps(list(by_signal.values()))
    budget = int(os.environ.get("BUDGET_AUTO_FLAGGED_BYTES", _DEFAULT_BUDGET_AUTO_FLAGGED_BYTES))
    if auto and rows[0]["tier"] != "flagged" and await _flagged_bytes() > budget:
        await backend.execute(
            "UPDATE match_retention SET flag_reasons = ?, auto_flag_capped = 1 WHERE match_id = ? AND deleting_at IS NULL",
            (merged, match_id),
        )
        return
    await backend.execute(
        """UPDATE match_retention
           SET tier = 'flagged', flag_reasons = ?, last_touched_at = datetime('now')
           WHERE match_id = ? AND deleting_at IS NULL""",
        (merged, match_id),
    )


async def set_session_ended(match_id: str, slot: int | None, ended_by: str) -> None:
    """Mark how a session ended."""
    backend = _require()
    if slot is not None:
        await backend.execute(
            "UPDATE session_logs SET ended_by=?, updated_at=datetime('now') WHERE match_id=? AND slot=?",
            (ended_by, match_id, slot),
        )
    else:
        # Game end: mark sessions without an existing ended_by (don't overwrite
        # leave/disconnect) and record when the match ended.
        await backend.batch(
            [
                (
                    "UPDATE session_logs SET ended_by=?, updated_at=datetime('now') WHERE match_id=? AND ended_by IS NULL",
                    (ended_by, match_id),
                ),
                (
                    "UPDATE match_retention SET ended_at=datetime('now') WHERE match_id=? AND ended_at IS NULL",
                    (match_id,),
                ),
            ]
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


async def execute_write(sql: str, params: tuple) -> int:
    """Run a write query (DELETE, UPDATE) and commit. Returns rows changed."""
    return (await _require().execute(sql, params)).changes


def _blob_store() -> BlobStore:
    if _blobs is None:
        raise RuntimeError("Database not initialized -- call init_db() first")
    return _blobs


async def insert_screenshot(match_id: str, slot: int, frame: int, data: bytes) -> int | None:
    """Store a gameplay screenshot and return its row ID.

    The bytes go to the blob store under matches/<match_id>/screenshots/;
    the row keeps the key and size. Screenshots are best-effort diagnostics:
    a non-integer slot/frame or a failed upload stores nothing and returns
    None rather than raising into the Socket.IO handler.
    """
    try:
        slot, frame = int(slot), int(frame)
    except (TypeError, ValueError):
        return None
    key = f"matches/{match_id}/screenshots/{slot}-{frame}.jpg"
    try:
        await _blob_store().put(key, data, "image/jpeg")
    except BlobStoreError as exc:
        log.warning("Screenshot not stored (match=%s slot=%s frame=%s): %s", match_id[:8], slot, frame, exc)
        return None
    result = await _require().execute(
        "INSERT INTO screenshots (match_id, slot, frame, blob_key, size) VALUES (?, ?, ?, ?, ?)",
        (match_id, slot, frame, key, len(data)),
    )
    return result.last_row_id


async def get_screenshots(match_id: str) -> list[dict]:
    """Return screenshot metadata (without data) for a match."""
    return await _require().query(
        "SELECT id, match_id, slot, frame, COALESCE(size, length(data)) as size, created_at FROM screenshots WHERE match_id = ? ORDER BY slot, frame",
        (match_id,),
    )


async def read_screenshot(row: dict) -> bytes | None:
    """Bytes for a screenshots row: from the blob store, or `data` for rows
    written before migration 0003."""
    if row.get("blob_key"):
        return await _blob_store().get(row["blob_key"])
    return row.get("data")


async def get_screenshot_data(screenshot_id: int) -> bytes | None:
    """Return raw JPEG bytes for a screenshot."""
    rows = await _require().query("SELECT blob_key, data FROM screenshots WHERE id = ?", (screenshot_id,))
    return await read_screenshot(rows[0]) if rows else None


async def delete_match_blobs(match_id: str) -> None:
    """Delete every blob stored under the match's prefix (screenshots now)."""
    await _blob_store().delete_prefix(f"matches/{match_id}/")


async def delete_blobs(keys: list[str]) -> None:
    await _blob_store().delete(keys)


async def query(sql: str, params: tuple) -> list[dict]:
    """Run a read query and return results as a list of dicts."""
    return await _require().query(sql, params)
