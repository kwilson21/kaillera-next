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
from collections.abc import AsyncIterator
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

# The C rollback engine's lines get their own budget too: chunks of kind =
# 'clog', so a long match's JS lines can't push them out and a burst of them
# can't push the JS lines out (specs/session_log_store.qnt). They ride in the
# log's own seq stream as "[C] " lines (netplay-rollback.js, _drainCDebugLog),
# so the server splits each flush into runs of one kind, in order, and the
# log's readers take both kinds in row-id order. About 120-160 KB a minute of
# 60 fps play, so this holds about an hour.
_SESSION_LOG_C_CAP = 8 * 1024 * 1024
_C_LINE_PREFIX = "[C] "

# The chunk kinds a reader of each stream takes, in row-id order.
_STREAM_KINDS = {"log": ("log", "clog"), "audit": ("audit",)}

# Each run of one kind is at least one row, in one batch (one D1 request,
# which must finish within 30 s). A page's flush holds a run of JS lines and
# a run of C lines for each 5 s window it covers: two, or a few dozen in a
# 5,000-entry resend after an outage (about 40 at 30 fps). Many more can
# only come from a modified client alternating its lines; past this many
# runs, the rest of the flush is stored as one 'log' run, still in order.
_MAX_KIND_RUNS = 64


def _chunk_cap(kind: str) -> int:
    if kind == "audit":
        return _SESSION_LOG_AUDIT_CAP
    if kind == "clog":
        return _SESSION_LOG_C_CAP
    return _SESSION_LOG_CHUNK_CAP


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
    """Append new, deduped log entries as chunks and update session metadata.

    This never rewrites the `log_data` blob: new entries land in
    `session_log_chunks`, keyed by the client's monotonic `seq`. Entries
    with `seq` <= the stored `last_seq` are dropped — this dedupes resends
    and old cached clients that still send their entire ring on every
    flush. Each run of JS lines or of C engine lines ("[C] ") becomes chunks
    of its own kind ('log' or 'clog'), in order, each kind under its own cap
    (_kind_runs). Returns `{"lastSeq": ..., "auditLastSeq": ...}` so the
    caller can ack both back to the client.

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
    statements = await _chunk_statements(match_id, slot, _kind_runs(new_entries), current_last_seq)

    stored_audit_epoch = row["audit_epoch"] if row and row["audit_epoch"] is not None else ""
    stored_audit_seq = row["audit_last_seq"] if row and row["audit_last_seq"] is not None else -1
    audit_epoch = data.get("audit_epoch") or ""
    if audit_epoch:
        audit_last_seq = stored_audit_seq if audit_epoch == stored_audit_epoch else -1
        new_audit, audit_max_seq = _entries_past(data.get("audit_entries") or [], audit_last_seq)
        statements += await _chunk_statements(match_id, slot, [("audit", new_audit)], audit_last_seq)
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


def _entry_kind(entry: dict) -> str:
    """The chunk kind a log entry is stored as: 'clog' for a C engine line."""
    msg = entry.get("msg")
    return "clog" if isinstance(msg, str) and msg.startswith(_C_LINE_PREFIX) else "log"


def _kind_runs(entries: list[dict]) -> list[tuple[str, list[dict]]]:
    """A flush's log entries split, in order, into runs of one kind.

    Each run becomes chunks of its own, so the log's readers, taking both
    kinds in row-id order, get every entry back in the order it was sent
    (specs/session_log_store.qnt). One chunk of C lines per flush would
    not: a re-init drains the C log in the middle of a flush window, and JS
    lines follow it. Past _MAX_KIND_RUNS runs, the rest is one 'log' run.
    """
    runs: list[tuple[str, list[dict]]] = []
    for entry in entries:
        kind = _entry_kind(entry)
        if runs and runs[-1][0] == kind:
            runs[-1][1].append(entry)
        else:
            runs.append((kind, [entry]))
    if len(runs) > _MAX_KIND_RUNS:
        rest = [entry for _, run_entries in runs[_MAX_KIND_RUNS - 1 :] for entry in run_entries]
        runs = [*runs[: _MAX_KIND_RUNS - 1], ("log", rest)]
    return runs


async def _chunk_statements(
    match_id: str, slot: int | None, runs: list[tuple[str, list[dict]]], last_seq: int
) -> list[Executable]:
    """INSERTs storing each run as chunks of its kind, in order, plus each kind's cap DELETE when needed."""
    statements: list[Executable] = []
    high_seq = last_seq
    new_bytes: dict[str, int] = {}
    for kind, run_entries in runs:
        for group in _split_entries(run_entries):
            entries_json = json.dumps(group)
            seqs = [s for s in (_valid_seq(e.get("seq")) for e in group) if s is not None]
            first_seq = min(seqs) if seqs else high_seq
            high_seq = max([high_seq, *seqs])
            new_bytes[kind] = new_bytes.get(kind, 0) + len(entries_json)
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
    for kind, added in new_bytes.items():
        if await _stored_chunk_bytes(match_id, slot, kind) + added > _chunk_cap(kind):
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
        select(func.coalesce(func.sum(SessionLogChunk.size), 0).label("total")).where(
            *_chunks_of(match_id, slot, (kind,))
        )
    )
    return int(rows[0]["total"]) if rows else 0


def _chunks_of(match_id: str, slot: int | None, kinds: tuple[str, ...]) -> tuple[ColumnElement[bool], ...]:
    """The WHERE terms selecting one player's chunks of the given kinds."""
    return (SessionLogChunk.match_id == match_id, SessionLogChunk.slot.is_(slot), SessionLogChunk.kind.in_(kinds))


def _chunk_cap_statement(match_id: str, slot: int | None, kind: str = "log") -> Executable:
    """DELETE the oldest `kind` chunks for (match_id, slot) until the total fits its cap.

    Keeps the newest chunks whose cumulative size (counted from the newest
    backwards) still fits, in one statement rather than a per-row DELETE.
    Only chunks of `kind` count and go: each kind has its own budget.
    """
    newest_first = (
        select(
            SessionLogChunk.id,
            func.sum(SessionLogChunk.size).over(order_by=SessionLogChunk.id.desc()).label("running_total"),
        )
        .where(*_chunks_of(match_id, slot, (kind,)))
        .subquery()
    )
    fits = select(newest_first.c.id).where(newest_first.c.running_total <= _chunk_cap(kind))
    return delete(SessionLogChunk).where(*_chunks_of(match_id, slot, (kind,)), SessionLogChunk.id.not_in(fits))


# Chunks read per query when a stored log is assembled or streamed: at most
# 16 x _SESSION_LOG_CHUNK_MAX (8 MB) of JSON text in memory at once.
_CHUNK_PAGE_ROWS = 16


def _entry_list(text: str | None) -> list:
    """The entries a stored JSON array holds; a missing, malformed or non-list value holds none."""
    try:
        value = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return []
    return value if isinstance(value, list) else []


def _page_entries(texts: list[str]) -> list:
    return [entry for text in texts for entry in _entry_list(text)]


async def parse_log_data(log_data_str: str | None) -> list:
    """A session's legacy `log_data` blob as a list of entries, parsed in a worker thread."""
    return await asyncio.to_thread(_entry_list, log_data_str) if log_data_str else []


async def iter_chunk_entries(
    match_id: str, slot: int | None, kind: str = "log", *, through_id: int | None = None
) -> AsyncIterator[list]:
    """One player's stored chunks of one stream, oldest first, as lists of entries.

    `kind` names the stream: "log" takes the JS lines' chunks and the C
    lines' ('clog') together in row-id order, which is the order the entries
    were sent in (_kind_runs); "audit" the input audit's.
    Reads a page of chunks per query and parses each page in a worker thread,
    so a long log never holds the event loop for long (see the admin export
    in api/app.py). `through_id` stops at that chunk id.
    """
    after = 0
    while True:
        page = select(SessionLogChunk.id, SessionLogChunk.entries).where(
            *_chunks_of(match_id, slot, _STREAM_KINDS[kind]), SessionLogChunk.id > after
        )
        if through_id is not None:
            page = page.where(SessionLogChunk.id <= through_id)
        rows = await fetch(page.order_by(SessionLogChunk.id).limit(_CHUNK_PAGE_ROWS))
        if not rows:
            return
        after = rows[-1]["id"]
        yield await asyncio.to_thread(_page_entries, [r["entries"] for r in rows])
        if len(rows) < _CHUNK_PAGE_ROWS:
            return


async def count_log_entries(match_id: str, slot: int | None) -> tuple[int, int]:
    """How many entries one player's stored log chunks hold, and the id of the newest one.

    The log's chunks are its JS lines' and its C lines' ('clog'), as
    iter_chunk_entries reads them. SQLite counts them, so nothing is parsed
    here. A chunk that isn't valid JSON counts none, as it holds none for
    iter_chunk_entries. Reading `through_id=` the returned id leaves out
    chunks a live match appends afterwards. It can't bring back chunks a size
    cap deletes meanwhile (a live log near its cap), so a stream can hold
    fewer entries than counted.
    """
    entries = SessionLogChunk.entries
    length = case((func.json_valid(entries), func.json_array_length(entries)), else_=0)
    rows = await fetch(
        select(
            func.coalesce(func.sum(length), 0).label("n"),
            func.coalesce(func.max(SessionLogChunk.id), 0).label("through"),
        ).where(*_chunks_of(match_id, slot, _STREAM_KINDS["log"]))
    )
    return (int(rows[0]["n"]), int(rows[0]["through"])) if rows else (0, 0)


async def get_full_log_entries(match_id: str, slot: int | None, log_data_str: str | None) -> list[dict]:
    """Assemble a session's full entry list: legacy `log_data` (if any) plus
    every log `session_log_chunks` row for (match_id, slot), JS and C lines
    alike, in insertion order.

    Used by the admin detail endpoint and match_rotation, so their output
    shapes are unchanged even though storage moved to append-only chunks.
    The parsing runs in worker threads (iter_chunk_entries); the export
    endpoint streams the same entries a page at a time instead.
    """
    entries = await parse_log_data(log_data_str)
    if _backend is None:
        return entries
    async for page in iter_chunk_entries(match_id, slot):
        entries.extend(page)
    return entries


async def get_input_audit(match_id: str, slot: int | None) -> list[dict]:
    """Every input audit record stored for (match_id, slot), oldest first."""
    records: list = []
    async for page in iter_chunk_entries(match_id, slot, "audit"):
        records.extend(page)
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


async def reopen_session(match_id: str, slot: int) -> None:
    """Clear how a session ended: the player is back in that match and slot.

    A player the room dropped (its grace window ran out) was marked ended by
    the disconnect. If it is taken back while still playing, leaving the mark
    would record a player who finished the match as having left it, since the
    game-end update skips rows that already say how they ended.
    """
    await run(
        update(SessionLog)
        .values(ended_by=None, updated_at=now())
        .where(SessionLog.match_id == match_id, SessionLog.slot == slot)
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
    """Run a hand-written write and return rows changed.

    For tests and one-off tooling that need to arrange data; application code
    builds statements from src/schema.py and uses run()."""
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


async def get_screenshot_frame(match_id: str, frame: int | None) -> dict:
    """Return captures at one exact frame and locations of its neighbors."""
    shot = Screenshot
    slots = range(4)

    def seek(slot: int, column: str, *, anchor: int | None = None, before: bool = False):
        query = select(shot.frame).where(shot.match_id == match_id, shot.slot == slot, shot.frame >= 0)
        if anchor is not None:
            query = query.where(shot.frame < anchor if before else shot.frame > anchor)
        # Each seek uses the existing (match_id, slot, frame) index; no full
        # match scan or additional D1 migration is needed.
        return query.order_by(shot.frame.desc() if before else shot.frame).limit(1).scalar_subquery().label(column)

    starts = (await fetch(select(*(seek(slot, f"first_{slot}") for slot in slots))))[0]
    recorded_slots = [slot for slot in slots if starts[f"first_{slot}"] is not None]
    if frame is None and recorded_slots:
        frame = min(starts[f"first_{slot}"] for slot in recorded_slots)
    if frame is None or not recorded_slots:
        return {"frame": frame, "previous_frame": None, "next_frame": None, "slots": [], "screenshots": []}

    bounds = (
        await fetch(
            select(
                *(seek(slot, f"previous_{slot}", anchor=frame, before=True) for slot in recorded_slots),
                *(seek(slot, f"next_{slot}", anchor=frame) for slot in recorded_slots),
            )
        )
    )[0]
    previous = [bounds[f"previous_{slot}"] for slot in recorded_slots if bounds[f"previous_{slot}"] is not None]
    following = [bounds[f"next_{slot}"] for slot in recorded_slots if bounds[f"next_{slot}"] is not None]
    captures = await fetch(
        select(shot.slot, shot.frame, func.max(shot.id).label("id"))
        .where(shot.match_id == match_id, shot.slot.in_(recorded_slots), shot.frame == frame)
        .group_by(shot.slot, shot.frame)
        .order_by(shot.slot)
    )
    return {
        "frame": frame,
        "previous_frame": max(previous, default=None),
        "next_frame": min(following, default=None),
        "slots": recorded_slots,
        "screenshots": captures,
    }


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
    """Run a hand-written read and return rows as dicts.

    For tests and one-off tooling; application code builds statements from
    src/schema.py and uses fetch()."""
    return await _require().query(sql, params)
