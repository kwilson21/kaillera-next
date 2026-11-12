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

from sqlalchemy import ColumnElement, Executable, Select, and_, case, delete, func, insert, or_, select, update
from sqlalchemy.dialects import sqlite
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from src.blobstore import BlobStore, BlobStoreError, blobstore_from_env
from src.dbbackend import DEFAULT_DB_PATH, Backend, backend_from_env
from src.dbbackend.base import ExecResult, Statement
from src.migrate import apply_migrations
from src.schema import ClientEvent, Feedback, MatchRetention, Screenshot, SessionLog, SessionLogChunk

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


# ── Query builder ────────────────────────────────────────────────────────────
# Statements are built from the tables in src/schema.py and compiled here to
# SQLite-dialect SQL with positional parameters, which is what both backends
# take. SQLAlchemy never opens a connection.

_DIALECT = sqlite.dialect(paramstyle="qmark")


def compile_statement(statement: Executable) -> Statement:
    """The (sql, params) a backend runs for a built statement.

    Values are passed through as given: no type conversion is applied.
    """
    compiled = statement.compile(dialect=_DIALECT, compile_kwargs={"render_postcompile": True})
    return str(compiled), tuple(compiled.params[name] for name in compiled.positiontup or ())


async def fetch(statement: Executable) -> list[dict]:
    """Run a built SELECT and return its rows as dicts."""
    return await _require().query(*compile_statement(statement))


async def run(statement: Executable) -> ExecResult:
    """Run a built INSERT, UPDATE or DELETE."""
    return await _require().execute(*compile_statement(statement))


async def run_batch(statements: list[Executable]) -> None:
    """Run built write statements as one atomic batch (one D1 request)."""
    await _require().batch([compile_statement(s) for s in statements])


async def count(statement: Select) -> int:
    """How many rows a built SELECT would return."""
    rows = await fetch(select(func.count().label("cnt")).select_from(statement.subquery()))
    return int(rows[0]["cnt"]) if rows else 0


def json_field(column: ColumnElement, path: str) -> ColumnElement:
    """One value out of a JSON text column, e.g. json_field(events.meta, "$.match_id")."""
    return func.json_extract(column, path)


def now() -> ColumnElement:
    """SQLite's current UTC time, as stored in the *_at columns."""
    return func.datetime("now")


def ago(offset: str) -> ColumnElement:
    """A time relative to now, e.g. ago("-30 minutes")."""
    return func.datetime("now", offset)


async def insert_feedback(data: dict) -> int:
    """Insert a feedback row and return the new row ID."""
    result = await run(
        insert(Feedback).values(
            category=data["category"],
            message=data["message"],
            email=data.get("email"),
            page=data.get("page"),
            context=data.get("context"),
            ip_hash=data.get("ip_hash"),
        )
    )
    return result.last_row_id


_SESSION_LOG_CHUNK_CAP = 12 * 1024 * 1024  # 12MB per (match_id, slot) — same budget
# the old single-blob rewrite used. Enforced by deleting the oldest chunks
# first so the latest entries (reconnect/desync events) survive.

# Input audit chunks (kind = 'audit') get their own budget, so a long match's
# audit can't push its log entries out. A busy player's audit (own inputs plus
# the opponent's) grows ~4-5 KB/s, so this holds about half an hour of play.
_SESSION_LOG_AUDIT_CAP = 8 * 1024 * 1024


def _chunk_cap(kind: str) -> int:
    return _SESSION_LOG_AUDIT_CAP if kind == "audit" else _SESSION_LOG_CHUNK_CAP


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

# At most one running and one waiting append per (match_id, slot); later
# flushes are turned away. Every waiter holds its decoded flush (~15 MB late
# in a match, mostly the input audit), and a desync's burst of critical-log
# flushes once queued 32 of them and ran a 512 MB instance out of memory.
# A turned-away flush loses nothing: the client resends unacked entries.
_APPEND_MAX_PENDING = 2


def session_log_busy(match_id: str, slot: int | None) -> bool:
    """True when append_session_log would turn a flush for this key away."""
    return _append_lock_refcounts.get((match_id, slot), 0) >= _APPEND_MAX_PENDING


async def _acquire_append_lock(key: tuple[str, int | None]) -> asyncio.Lock | None:
    async with _append_locks_guard:
        count = _append_lock_refcounts.get(key, 0)
        if count >= _APPEND_MAX_PENDING:
            return None
        _append_lock_refcounts[key] = count + 1
        return _append_locks.setdefault(key, asyncio.Lock())


async def _release_append_lock(key: tuple[str, int | None]) -> None:
    async with _append_locks_guard:
        remaining = _append_lock_refcounts.get(key, 1) - 1
        if remaining <= 0:
            _append_lock_refcounts.pop(key, None)
            _append_locks.pop(key, None)
        else:
            _append_lock_refcounts[key] = remaining


async def append_session_log(data: dict) -> int | None:
    """append_session_flush's log `last_seq` alone (None when turned away)."""
    acks = await append_session_flush(data)
    return None if acks is None else acks["lastSeq"]


async def append_session_flush(data: dict) -> dict | None:
    """Append new, deduped log entries as a chunk and update session metadata.

    This never rewrites the `log_data` blob: new entries land in
    `session_log_chunks`, keyed by the client's monotonic `seq`. Entries
    with `seq` <= the stored `last_seq` are dropped — this dedupes resends
    and old cached clients that still send their entire ring on every
    flush. Returns `{"lastSeq": ..., "auditLastSeq": ...}` so the caller can
    ack both back to the client.

    `data["epoch"]` identifies the client's in-memory ring instance (see
    migration 0002_session_log_chunks.sql). When it differs from the epoch
    already stored for this (match_id, slot), `last_seq` is treated as -1
    for this flush (and the new epoch adopted) instead of deduping the new
    ring's entries against the old one's high-water mark — otherwise a
    reload, reconnect, or a spectator claiming a slot a previous player used
    would have every entry look like a dup of stale state and get silently
    dropped. A missing/empty epoch (legacy caller) skips this check
    entirely, preserving the old dedupe-by-last_seq-only behavior.

    `data["audit_entries"]` are the flush's input audit records, appended
    the same way as `kind = 'audit'` chunks under their own seq and
    `data["audit_epoch"]` (migration 0005_audit_chunks.sql). A flush with no
    audit epoch (an older client) leaves the stored audit position as is.

    Concurrent flushes for the same (match_id, slot) are serialized by
    `_acquire_append_lock` so two overlapping calls can't both read the same
    `last_seq` and both insert a chunk for entries the other has already
    covered. Returns None, storing nothing, when one append is already
    running and another waiting for the key (see _APPEND_MAX_PENDING).
    """
    _require()
    match_id = data["match_id"]
    slot = data.get("slot")
    epoch = data.get("epoch") or ""
    lock = await _acquire_append_lock((match_id, slot))
    if lock is None:
        return None
    async with lock:
        try:
            return await _append_session_log_locked(data, match_id, slot, epoch)
        finally:
            await _release_append_lock((match_id, slot))


async def _append_session_log_locked(data: dict, match_id: str, slot: int | None, epoch: str) -> dict:
    rows = await fetch(
        select(SessionLog.last_seq, SessionLog.log_epoch, SessionLog.audit_last_seq, SessionLog.audit_epoch).where(
            SessionLog.match_id == match_id, SessionLog.slot.is_(slot)
        )
    )
    row = rows[0] if rows else None
    stored_epoch = row["log_epoch"] if row and row["log_epoch"] is not None else ""
    # No epoch supplied (legacy caller) behaves exactly as before: dedupe
    # against whatever last_seq is already stored. A supplied epoch that
    # doesn't match the stored one resets the high-water mark.
    same_epoch = not epoch or epoch == stored_epoch
    # -1 means "no entries acked yet" (client seqs start at 0).
    current_last_seq = row["last_seq"] if row and row["last_seq"] is not None and same_epoch else -1

    # The chunk inserts, cap enforcement and metadata upsert commit together.
    new_entries, max_seq = _entries_past(data.get("entries") or [], current_last_seq)
    statements = await _chunk_statements(match_id, slot, "log", new_entries, current_last_seq)

    stored_audit_epoch = row["audit_epoch"] if row and row["audit_epoch"] is not None else ""
    stored_audit_seq = row["audit_last_seq"] if row and row["audit_last_seq"] is not None else -1
    audit_epoch = data.get("audit_epoch") or ""
    if audit_epoch:
        audit_last_seq = stored_audit_seq if audit_epoch == stored_audit_epoch else -1
        new_audit, audit_max_seq = _entries_past(data.get("audit_entries") or [], audit_last_seq)
        statements += await _chunk_statements(match_id, slot, "audit", new_audit, audit_last_seq)
    else:
        audit_epoch, audit_max_seq = stored_audit_epoch, stored_audit_seq

    upsert = sqlite_insert(SessionLog).values(
        match_id=match_id,
        room=data["room"],
        slot=slot,
        player_name=data.get("player_name"),
        mode=data.get("mode"),
        log_data="[]",
        summary=data.get("summary"),
        context=data.get("context"),
        ip_hash=data.get("ip_hash"),
        last_seq=max_seq,
        log_epoch=epoch,
        audit_last_seq=audit_max_seq,
        audit_epoch=audit_epoch,
        updated_at=now(),
    )
    new = upsert.excluded
    # Within one epoch the high-water mark only moves forward; a new epoch replaces it.
    statements.append(
        upsert.on_conflict_do_update(
            index_elements=[SessionLog.match_id, SessionLog.slot],
            set_={
                "summary": new.summary,
                "context": new.context,
                "ip_hash": new.ip_hash,
                "updated_at": now(),
                "last_seq": case(
                    (SessionLog.log_epoch == new.log_epoch, func.max(SessionLog.last_seq, new.last_seq)),
                    else_=new.last_seq,
                ),
                "log_epoch": new.log_epoch,
                "audit_last_seq": case(
                    (
                        SessionLog.audit_epoch == new.audit_epoch,
                        func.max(SessionLog.audit_last_seq, new.audit_last_seq),
                    ),
                    else_=new.audit_last_seq,
                ),
                "audit_epoch": new.audit_epoch,
            },
        )
    )
    await run_batch(statements)
    return {"lastSeq": max_seq, "auditLastSeq": audit_max_seq}


def _entries_past(entries: list, last_seq: int) -> tuple[list[dict], int]:
    """The entries with a seq past `last_seq`, and the highest seq seen."""
    new_entries = []
    max_seq = last_seq
    for e in entries:
        if not isinstance(e, dict):
            continue
        seq = _valid_seq(e.get("seq"))
        if seq is not None:
            if seq <= last_seq:
                continue
            max_seq = max(max_seq, seq)
        # An entry without a usable seq can't be deduped safely, so it's
        # always kept rather than silently dropped — see _valid_seq.
        new_entries.append(e)
    return new_entries, max_seq


async def _chunk_statements(
    match_id: str, slot: int | None, kind: str, new_entries: list[dict], last_seq: int
) -> list[Executable]:
    """INSERTs storing `new_entries` as `kind` chunks, plus the cap DELETE when needed."""
    statements: list[Executable] = []
    if not new_entries:
        return statements
    high_seq = last_seq
    new_bytes = 0
    for group in _split_entries(new_entries):
        entries_json = json.dumps(group)
        seqs = [s for s in (_valid_seq(e.get("seq")) for e in group) if s is not None]
        first_seq = min(seqs) if seqs else high_seq
        high_seq = max([high_seq, *seqs])
        new_bytes += len(entries_json)
        statements.append(
            insert(SessionLogChunk).values(
                match_id=match_id,
                slot=slot,
                kind=kind,
                first_seq=first_seq,
                last_seq=high_seq,
                entries=entries_json,
                size=len(entries_json),
            )
        )
    if await _stored_chunk_bytes(match_id, slot, kind) + new_bytes > _chunk_cap(kind):
        statements.append(_chunk_cap_statement(match_id, slot, kind))
    return statements


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


async def _stored_chunk_bytes(match_id: str, slot: int | None, kind: str = "log") -> int:
    """Total size of the `kind` chunks already stored for (match_id, slot).

    Uses the `size` column recorded at insert time instead of re-reading
    `length(entries)` for every stored chunk on every flush.
    """
    rows = await fetch(
        select(func.coalesce(func.sum(SessionLogChunk.size), 0).label("total")).where(*_chunks_of(match_id, slot, kind))
    )
    return int(rows[0]["total"]) if rows else 0


def _chunks_of(match_id: str, slot: int | None, kind: str) -> tuple[ColumnElement[bool], ...]:
    """The WHERE terms selecting one player's chunks of one kind."""
    return (SessionLogChunk.match_id == match_id, SessionLogChunk.slot.is_(slot), SessionLogChunk.kind == kind)


def _chunk_cap_statement(match_id: str, slot: int | None, kind: str = "log") -> Executable:
    """DELETE the oldest `kind` chunks for (match_id, slot) until the total fits its cap.

    Keeps the newest chunks whose cumulative size (counted from the newest
    backwards) still fits, in one statement rather than a per-row DELETE.
    """
    newest_first = (
        select(
            SessionLogChunk.id,
            func.sum(SessionLogChunk.size).over(order_by=SessionLogChunk.id.desc()).label("running_total"),
        )
        .where(*_chunks_of(match_id, slot, kind))
        .subquery()
    )
    fits = select(newest_first.c.id).where(newest_first.c.running_total <= _chunk_cap(kind))
    return delete(SessionLogChunk).where(*_chunks_of(match_id, slot, kind), SessionLogChunk.id.not_in(fits))


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

    rows = await fetch(_chunk_entries(match_id, slot, "log"))
    for r in rows:
        try:
            chunk = json.loads(r["entries"])
        except (json.JSONDecodeError, TypeError):
            chunk = []
        if isinstance(chunk, list):
            entries.extend(chunk)
    return entries


def _chunk_entries(match_id: str, slot: int | None, kind: str) -> Executable:
    """One player's stored chunks of one kind, oldest first."""
    return select(SessionLogChunk.entries).where(*_chunks_of(match_id, slot, kind)).order_by(SessionLogChunk.id)


async def get_input_audit(match_id: str, slot: int | None) -> list[dict]:
    """Every input audit record stored for (match_id, slot), oldest first."""
    rows = await fetch(_chunk_entries(match_id, slot, "audit"))
    records: list = []
    for r in rows:
        try:
            chunk = json.loads(r["entries"])
        except (json.JSONDecodeError, TypeError):
            chunk = []
        if isinstance(chunk, list):
            records.extend(chunk)
    return records


# Log uploads for a match are accepted until 30 min after game-end, or 4 h
# after start when no end was recorded (crash, restart, room closed): spec §5.
_UPLOAD_GRACE_AFTER_END = "-30 minutes"
_UPLOAD_WINDOW_WITHOUT_END = "-4 hours"
_UPLOAD_CHECK_TTL_SEC = 60.0
_UPLOAD_CHECK_CACHE_MAX = 10_000
_upload_check_cache: dict[tuple[str, str], tuple[bool, float]] = {}
_registered_matches: set[str] = set()


def _uploads_open() -> ColumnElement[bool]:
    """A match that isn't being deleted and is still inside its upload window."""
    return and_(
        MatchRetention.deleting_at.is_(None),
        or_(
            and_(MatchRetention.ended_at.is_not(None), MatchRetention.ended_at > ago(_UPLOAD_GRACE_AFTER_END)),
            and_(MatchRetention.ended_at.is_(None), MatchRetention.created_at > ago(_UPLOAD_WINDOW_WITHOUT_END)),
        ),
    )


async def register_match(match_id: str, room: str) -> None:
    """Record a match. Idempotent, and writes at most once per process.

    Called at start-game and again from every Socket.IO log flush for the
    room's live match, which covers matches started before a deploy and
    start-game registrations that failed.
    """
    if match_id in _registered_matches:
        return
    await run(insert(MatchRetention).prefix_with("OR IGNORE").values(match_id=match_id, room=room))
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
    rows = await fetch(
        select(MatchRetention.match_id).where(
            MatchRetention.match_id == match_id, MatchRetention.room == room, _uploads_open()
        )
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
    rows = await fetch(
        select(MatchRetention.match_id)
        .where(MatchRetention.room == room, _uploads_open())
        .order_by(MatchRetention.created_at.desc())
        .limit(1)
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
    flagged = MatchRetention.tier == "flagged"
    chunk_bytes = (
        select(func.sum(SessionLogChunk.size))
        .join(MatchRetention, MatchRetention.match_id == SessionLogChunk.match_id)
        .where(flagged)
        .scalar_subquery()
    )
    shot_bytes = (
        select(func.sum(func.coalesce(Screenshot.size, func.length(Screenshot.data), 0)))
        .join(MatchRetention, MatchRetention.match_id == Screenshot.match_id)
        .where(flagged)
        .scalar_subquery()
    )
    rows = await fetch(select((func.coalesce(chunk_bytes, 0) + func.coalesce(shot_bytes, 0)).label("bytes")))
    return int(rows[0]["bytes"] or 0) if rows else 0


async def _flag_match_locked(match_id: str, reasons: list[dict], auto: bool) -> None:
    rows = await fetch(
        select(MatchRetention.flag_reasons, MatchRetention.deleting_at, MatchRetention.tier).where(
            MatchRetention.match_id == match_id
        )
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
    live = update(MatchRetention).where(MatchRetention.match_id == match_id, MatchRetention.deleting_at.is_(None))
    if auto and rows[0]["tier"] != "flagged" and await _flagged_bytes() > budget:
        await run(live.values(flag_reasons=merged, auto_flag_capped=1))
        return
    await run(live.values(tier="flagged", flag_reasons=merged, last_touched_at=now()))


async def set_session_ended(match_id: str, slot: int | None, ended_by: str) -> None:
    """Mark how a session ended."""
    ended = update(SessionLog).values(ended_by=ended_by, updated_at=now()).where(SessionLog.match_id == match_id)
    if slot is not None:
        await run(ended.where(SessionLog.slot == slot))
        return
    # Game end: mark sessions without an existing ended_by (don't overwrite
    # leave/disconnect) and record when the match ended.
    await run_batch(
        [
            ended.where(SessionLog.ended_by.is_(None)),
            update(MatchRetention)
            .values(ended_at=now())
            .where(MatchRetention.match_id == match_id, MatchRetention.ended_at.is_(None)),
        ]
    )


async def insert_client_event(data: dict) -> int:
    """Insert a client event and return row ID."""
    result = await run(
        insert(ClientEvent).values(
            type=data["type"],
            message=data.get("message"),
            meta=data.get("meta"),
            room=data.get("room"),
            slot=data.get("slot"),
            ip_hash=data.get("ip_hash"),
            user_agent=data.get("user_agent"),
        )
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
    result = await run(
        insert(Screenshot).values(match_id=match_id, slot=slot, frame=frame, blob_key=key, size=len(data))
    )
    return result.last_row_id


async def get_screenshots(match_id: str) -> list[dict]:
    """Return screenshot metadata (without data) for a match."""
    return await fetch(
        select(
            Screenshot.id,
            Screenshot.match_id,
            Screenshot.slot,
            Screenshot.frame,
            func.coalesce(Screenshot.size, func.length(Screenshot.data)).label("size"),
            Screenshot.created_at,
        )
        .where(Screenshot.match_id == match_id)
        .order_by(Screenshot.slot, Screenshot.frame)
    )


async def read_screenshot(row: dict) -> bytes | None:
    """Bytes for a screenshots row: from the blob store, or `data` for rows
    written before migration 0003."""
    if row.get("blob_key"):
        return await _blob_store().get(row["blob_key"])
    return row.get("data")


async def get_screenshot_data(screenshot_id: int) -> bytes | None:
    """Return raw JPEG bytes for a screenshot."""
    rows = await fetch(select(Screenshot.blob_key, Screenshot.data).where(Screenshot.id == screenshot_id))
    return await read_screenshot(rows[0]) if rows else None


async def execute_batch(statements: list[tuple[str, tuple]]) -> None:
    """Run write statements as one atomic batch (one D1 request)."""
    await _require().batch(statements)


async def delete_match_blobs(match_id: str) -> None:
    """Delete every blob stored under the match's prefix (screenshots now).

    The id must be a single path segment: an empty id would name every
    match's folder, and one with "/" another match's.
    """
    if not match_id or "/" in match_id or match_id in (".", ".."):
        raise BlobStoreError(f"Refusing to delete blobs for match id {match_id!r}")
    await _blob_store().delete_prefix(f"matches/{match_id}/")


async def delete_blobs(keys: list[str]) -> None:
    await _blob_store().delete(keys)


async def query(sql: str, params: tuple) -> list[dict]:
    """Run a read query and return results as a list of dicts."""
    return await _require().query(sql, params)
