"""Archive a match's session log to the blob store, then evict it from D1.

D1's free tier holds 500 MB, and a two-player ten-minute match's logs are
about 20 MB, so a 7-day retention window fits about 23 matches. A match's
logs are only read when something went wrong, so they don't need to sit in
D1 for the whole window: once a match can no longer receive uploads, its
stored entries are uploaded to the blob store (R2 in production, a folder in
dev), and `D1_HOT_DAYS` later its chunks are deleted from D1.

Modelled in specs/log_archive.qnt (`just spec`); the properties there are
what the steps below are for:

- **archive** (`archive_match`): note the newest chunk id, upload what D1
  holds up to it under keys carrying a token of this attempt's own, then
  record `archived_at`, `archived_max_chunk_id`, `archive_token`,
  `archived_updated_at` and `archive_bytes` in one statement — only if every
  upload succeeded, no other attempt recorded first and no delete has
  started. A failed upload or a refused record takes back what this attempt
  uploaded, because retention's prefix delete may have run between the
  upload and the record (`retentionLeavesNothing`); the token keeps that from
  touching another attempt's objects (`archivedOnlyWhenComplete`).
- **evict** (`evict_match`): one batch sets `evicted_at`, deletes the chunks
  the archive holds, and clears the `log_data` and `context` it covered.
  `evicted_at` goes first and the other two are conditional on it, so a
  batch that runs in parts (D1's HTTP batch isn't documented as a
  transaction) is read the same at every point, and running it again
  finishes it without touching anything written since.
- **read** (`archived_entries`, `archived_context`, used by db.py's readers):
  D1 until `evicted_at`; after it, the archive for the chunks it holds and D1
  for the rest (db._chunks_past). A flush can land after the archive, or
  after the eviction, because the Socket.IO path takes a room's live match
  past its upload window. Each chunk is read from exactly one place
  (`logAlwaysReadable`). An archive that can't be read raises
  ArchiveUnreadable rather than reading as an empty log.

Retention deletes the whole `matches/<id>/` prefix before the match's rows
(src/retention.py), so the archive objects go with it.

All of it runs only into a durable blob store, R2 (`archive_enabled`): a
local folder is wiped on deploy, so without R2 the logs stay in D1.
"""

from __future__ import annotations

import asyncio
import contextlib
import gzip
import io
import json
import logging
import os
import secrets
from collections.abc import AsyncIterator
from pathlib import Path

from sqlalchemy import ColumnElement, and_, delete, func, insert, or_, select, update

from src import db, retention
from src.blobstore import BlobStoreError
from src.schema import MatchMetrics, MatchRetention, SessionLog, SessionLogChunk

log = logging.getLogger(__name__)

# Matches archived per sweep, which runs every 6 h. Each one re-runs the
# rotation (seconds of CPU for a long match) and uploads a few MB, so a
# backlog is worked through over several sweeps rather than in one.
_ARCHIVE_LIMIT = 10
# Matches evicted per sweep: one small batch each.
_EVICT_LIMIT = 50
# Entries per page when an archived log is read back, so a long log is
# parsed in pieces off the event loop (as iter_chunk_entries does in D1).
_PAGE_ENTRIES = 2000
_GZIP_LEVEL = 6


_warned_not_durable = False


def archive_enabled() -> bool:
    """Whether the archive and the eviction may run: only into a durable store.

    Without R2 the blob store is a folder on the instance's disk, which a
    deploy wipes. An archive there would be evicted from D1 two days later
    and gone at the next deploy, so nothing is archived and the log stays in
    D1 (specs/log_archive.qnt, log_archive_any_store). `LOG_ARCHIVE_LOCAL=1`
    lets tests and local development use the folder; production never sets it.
    """
    global _warned_not_durable
    if db.blob_store_durable() or os.environ.get("LOG_ARCHIVE_LOCAL") == "1":
        return True
    if not _warned_not_durable:
        _warned_not_durable = True
        log.warning(
            "Log archive is off: the blob store is not durable (no R2 configured), so session logs stay in the"
            " database. Set the R2 variables to archive them, or LOG_ARCHIVE_LOCAL=1 for local development."
        )
    return False


def hot_days() -> int:
    """`D1_HOT_DAYS` (default 2): how long an archived match's chunks stay in D1.

    Never below 1, like the retention windows it shares a reader with: 0
    would evict a match the moment it is archived.
    """
    return retention.window_days("D1_HOT_DAYS", 2)


# ── Object keys ──────────────────────────────────────────────────────────────
#
# Everything for a match sits under matches/<id>/, the prefix retention
# deletes. A NULL slot (a page that never claimed one) reads as "slot-none".
#
# Each attempt's keys carry a random token of its own, which the record
# stores as `archive_token`, so readers name the objects of the attempt that
# was recorded. Two servers can archive one match at once (Render keeps the
# old instance up while a deploy's new one boots, and both sweep); both see
# the same newest chunk id, so keys made from it would be shared, and the
# attempt that is refused would take back the recorded one's objects
# (specs/log_archive.qnt, log_archive_key_by_through).


def new_token() -> str:
    return secrets.token_hex(8)


def _slot_name(slot: int | None) -> str:
    return "slot-none" if slot is None else str(int(slot))


def entries_key(match_id: str, slot: int | None, token: str) -> str:
    """The log stream: its eviction lines, legacy `log_data`, then its chunks."""
    return f"matches/{match_id}/sessions/{token}/{_slot_name(slot)}.entries.jsonl.gz"


def audit_key(match_id: str, slot: int | None, token: str) -> str:
    return f"matches/{match_id}/sessions/{token}/{_slot_name(slot)}.audit.jsonl.gz"


def context_key(match_id: str, slot: int | None, token: str) -> str:
    return f"matches/{match_id}/sessions/{token}/{_slot_name(slot)}.context.json.gz"


def parquet_key(match_id: str, token: str) -> str:
    """The rotation's Parquet copy, for DuckDB/Polars. No reader here serves it."""
    return f"matches/{match_id}/sessions/{token}/entries.zstd.parquet"


# ── Writing ──────────────────────────────────────────────────────────────────


def _jsonl(entries: list) -> bytes:
    return "".join(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n" for e in entries).encode("utf-8")


def _gz(text: str) -> bytes:
    return gzip.compress(text.encode("utf-8"), _GZIP_LEVEL, mtime=0)


async def _jsonl_gz(first: list, pages: AsyncIterator[list]) -> bytes:
    """`first` and then every page, one JSON object per line, gzipped.

    Compressed page by page: a player's log can be 12 MB of JSON text and
    its audit 8 MB (db.py's caps), and holding one of those as parsed
    entries, as one string and as bytes at once is tens of MB on a small
    instance. `mtime=0` keeps the bytes a function of the entries alone.
    """
    buffer = io.BytesIO()
    with gzip.GzipFile(fileobj=buffer, mode="wb", compresslevel=_GZIP_LEVEL, mtime=0) as out:
        if first:
            await asyncio.to_thread(out.write, _jsonl(first))
        async for page in pages:
            if page:
                await asyncio.to_thread(out.write, await asyncio.to_thread(_jsonl, page))
    return buffer.getvalue()


def _window_closed() -> ColumnElement[bool]:
    """The match can no longer receive uploads.

    The same window ingest checks (db._uploads_open): 30 min after the end,
    or 4 h after the start when no end was recorded (crash, restart).
    """
    return db.match_upload_deadline() < db.now()


async def _archive_due() -> list[dict]:
    """Matches to archive: no delete started, not archived, uploads closed."""
    return await db.fetch(
        select(MatchRetention.match_id)
        .where(MatchRetention.deleting_at.is_(None), MatchRetention.archived_at.is_(None), _window_closed())
        .order_by(MatchRetention.created_at)
        .limit(_ARCHIVE_LIMIT)
    )


async def _slot_payloads(match_id: str, through_id: int, token: str) -> tuple[list[tuple[str, bytes]], str]:
    """Each slot's three objects, and the newest `session_logs.updated_at` they cover.

    The log object is what a D1 read gives: the eviction lines a size cap
    left, the legacy `log_data` entries, then the chunks up to `through_id`
    (db.iter_chunk_entries, db.get_full_log_entries). The audit object is the
    'audit' chunks; the context object is the stored `context` string.
    """
    rows = await db.fetch(
        select(SessionLog.slot, SessionLog.context, SessionLog.log_data, SessionLog.updated_at)
        .where(SessionLog.match_id == match_id)
        .order_by(SessionLog.slot)
    )
    objects: list[tuple[str, bytes]] = []
    covered = ""
    for row in rows:
        slot = row.get("slot")
        covered = max(covered, str(row.get("updated_at") or ""))
        # iter_chunk_entries starts the log with its eviction lines, as the
        # readers see it; the legacy `log_data` entries come before those
        # (get_full_log_entries).
        legacy = await db.parse_log_data(row.get("log_data"))
        log_pages = db.iter_chunk_entries(match_id, slot, through_id=through_id, archived=False)
        audit_pages = db.iter_chunk_entries(match_id, slot, "audit", through_id=through_id, archived=False)
        objects.append((entries_key(match_id, slot, token), await _jsonl_gz(legacy, log_pages)))
        objects.append((audit_key(match_id, slot, token), await _jsonl_gz([], audit_pages)))
        objects.append((context_key(match_id, slot, token), await asyncio.to_thread(_gz, row.get("context") or "")))
    return objects, covered


async def _parquet_object(match_id: str, token: str) -> tuple[str, bytes] | None:
    """The rotation's Parquet file, if it wrote one to this instance's disk."""
    rows = await db.fetch(select(MatchMetrics.parquet_path).where(MatchMetrics.match_id == match_id))
    path = rows[0].get("parquet_path") if rows else None
    if not path:
        return None
    try:
        data = await asyncio.to_thread(Path(path).read_bytes)
    except OSError as exc:
        # Render's disk is wiped on deploy, so an older rotation's file is
        # often gone. The entries objects above are the archive; this is a
        # convenience copy for analysis.
        log.info("Archive %s: no Parquet file to upload (%s)", match_id[:8], exc)
        return None
    return parquet_key(match_id, token), data


async def archive_match(match_id: str) -> bool:
    """Upload one match's stored log, then record the archive. True when recorded.

    Idempotent: a match already archived, tombstoned, or still inside its
    upload window is left alone. Rotation runs first, so `match_metrics` and
    the retention classifier see the complete log before it leaves D1.
    """
    from src import match_rotation

    if not archive_enabled():
        return False
    rows = await db.fetch(
        select(MatchRetention.match_id).where(
            MatchRetention.match_id == match_id,
            MatchRetention.deleting_at.is_(None),
            MatchRetention.archived_at.is_(None),
            _window_closed(),
        )
    )
    if not rows:
        return False

    await match_rotation.rotate_match(match_id)
    newest = await db.fetch(
        select(func.coalesce(func.max(SessionLogChunk.id), 0).label("id")).where(SessionLogChunk.match_id == match_id)
    )
    through_id = int(newest[0]["id"]) if newest else 0
    token = new_token()

    objects, covered = await _slot_payloads(match_id, through_id, token)
    parquet = await _parquet_object(match_id, token)
    if parquet:
        objects.append(parquet)
    if not objects:
        log.info("Archive %s: no session_logs rows; nothing to archive", match_id[:8])
        return False

    landed: list[str] = []
    for key, data in objects:
        try:
            await db.put_blob(key, data, "application/gzip" if key.endswith(".gz") else "application/octet-stream")
        except BlobStoreError as exc:
            # The match stays un-archived for the next sweep, which uploads
            # under a token of its own; what landed here is this attempt's
            # alone, and is taken back.
            log.warning("Archive %s: upload of %s failed: %s", match_id[:8], key, exc)
            with contextlib.suppress(BlobStoreError):
                await db.delete_blobs(landed)
            return False
        landed.append(key)

    # One statement, and only if no delete has started and no other attempt
    # recorded an archive meanwhile.
    recorded = await db.run(
        update(MatchRetention)
        .values(
            archived_at=db.now(),
            archived_max_chunk_id=through_id,
            archive_token=token,
            archived_updated_at=covered,
            archive_bytes=sum(len(data) for _, data in objects),
        )
        .where(
            MatchRetention.match_id == match_id,
            MatchRetention.deleting_at.is_(None),
            MatchRetention.archived_at.is_(None),
        )
    )
    if not recorded.changes:
        # Retention may have deleted the prefix between the upload and here,
        # which would leave these objects for a match that no longer exists;
        # or another attempt recorded first. The keys carry this attempt's
        # token, so they are no other attempt's objects.
        log.info("Archive %s: not recorded (deleted or archived meanwhile); removing the upload", match_id[:8])
        await db.delete_blobs([key for key, _ in objects])
        return False
    if parquet:
        # The local file is on this instance's disk, which Render wipes on
        # deploy; the row points at the uploaded copy from now on (the design
        # doc's §2 table).
        await db.run(update(MatchMetrics).values(parquet_path=parquet[0]).where(MatchMetrics.match_id == match_id))
    log.info(
        "Archived match=%s objects=%d bytes=%d through_chunk=%d",
        match_id[:8],
        len(objects),
        sum(len(data) for _, data in objects),
        through_id,
    )
    return True


def _held(through_id: int, archived_at: str) -> ColumnElement[bool]:
    """The chunks a recorded archive holds: no newer id than it went through,
    and written no later than it was recorded.

    By id alone, a delete that runs again after the first could take a chunk
    written since: SQLite gives a new row max(id) + 1, so once the eviction
    has deleted the newest rows a later chunk can reuse an id the archive
    covers (specs/log_archive.qnt, log_archive_delete_by_id_only). It is the
    complement of what readers take from D1 after the archive
    (db._chunks_past).
    """
    return and_(SessionLogChunk.id <= through_id, SessionLogChunk.created_at <= archived_at)


async def evict_match(match_id: str) -> bool:
    """Delete an archived match's chunks from D1. True when the batch ran.

    One batch: `evicted_at` first, then the DELETE of the chunks the archive
    holds and the `context`/`log_data` clear, both conditional on it. D1's
    HTTP batch is not documented as a transaction, so it may stop part-way;
    readers skip what the archive holds, so every point of it reads the same,
    and running it again (the next sweep, or a second server's) finishes it
    without touching anything written since (specs/log_archive.qnt).
    """
    if not archive_enabled():
        return False
    rows = await db.fetch(
        select(
            MatchRetention.archived_max_chunk_id, MatchRetention.archived_updated_at, MatchRetention.archived_at
        ).where(
            MatchRetention.match_id == match_id,
            MatchRetention.deleting_at.is_(None),
            MatchRetention.archived_at.is_not(None),
        )
    )
    if not rows:
        return False
    through_id = int(rows[0].get("archived_max_chunk_id") or 0)
    covered = str(rows[0].get("archived_updated_at") or "")
    archived_at = str(rows[0].get("archived_at") or "")
    evicted = (
        select(MatchRetention.match_id)
        .where(
            MatchRetention.match_id == match_id,
            MatchRetention.deleting_at.is_(None),
            MatchRetention.evicted_at.is_not(None),
        )
        .exists()
    )
    await db.run_batch(
        [
            update(MatchRetention)
            .values(evicted_at=db.now())
            .where(
                MatchRetention.match_id == match_id,
                MatchRetention.deleting_at.is_(None),
                MatchRetention.archived_at.is_not(None),
                MatchRetention.evicted_at.is_(None),
            ),
            delete(SessionLogChunk).where(
                SessionLogChunk.match_id == match_id, _held(through_id, archived_at), evicted
            ),
            # Legacy `log_data` never changes once written (a flush's upsert
            # leaves it alone), so every row's is in the archive: readers past
            # evicted_at skip it either way (db.legacy_log_entries).
            update(SessionLog).values(log_data="[]").where(SessionLog.match_id == match_id, evicted),
            # The rows the archive read (`<= covered`) and nothing has
            # written since (`< archived_at`, which rules out a write in the
            # same second as `covered`): their `context` is in the archive.
            update(SessionLog)
            .values(context=None)
            .where(
                SessionLog.match_id == match_id,
                SessionLog.updated_at <= covered,
                SessionLog.updated_at < archived_at,
                evicted,
            ),
        ]
    )
    log.info("Evicted match=%s chunks through id=%d", match_id[:8], through_id)
    return True


async def _evict_due() -> list[dict]:
    """Archived matches whose chunks have been in D1 for `D1_HOT_DAYS`, and
    evicted ones whose batch stopped before its DELETE finished."""
    left_behind = (
        select(SessionLogChunk.id)
        .where(
            SessionLogChunk.match_id == MatchRetention.match_id,
            SessionLogChunk.id <= MatchRetention.archived_max_chunk_id,
            SessionLogChunk.created_at <= MatchRetention.archived_at,
        )
        .exists()
    )
    return await db.fetch(
        select(MatchRetention.match_id)
        .where(
            MatchRetention.deleting_at.is_(None),
            MatchRetention.archived_at.is_not(None),
            or_(
                and_(
                    MatchRetention.evicted_at.is_(None),
                    MatchRetention.archived_at < db.ago(f"-{hot_days()} days"),
                ),
                and_(MatchRetention.evicted_at.is_not(None), left_behind),
            ),
        )
        .order_by(MatchRetention.archived_at)
        .limit(_EVICT_LIMIT)
    )


async def register_old_matches() -> int:
    """Give ended matches with no `match_retention` row one, so they archive too.

    Matches from before registration existed (and any whose start-game
    registration failed) otherwise sit in D1 until the retention sweep's
    unregistered pass deletes them. `ended_at` is their newest flush, so
    their upload window is already closed; one past the retention window is
    left to that pass instead.
    """
    result = await db.run(
        insert(MatchRetention)
        .prefix_with("OR IGNORE")
        .from_select(
            ["match_id", "room", "created_at", "ended_at", "last_touched_at"],
            select(
                SessionLog.match_id,
                func.coalesce(func.min(SessionLog.room), ""),
                func.min(SessionLog.created_at),
                func.max(SessionLog.updated_at),
                func.max(SessionLog.updated_at),
            )
            .where(
                SessionLog.match_id.is_not(None),
                SessionLog.match_id != "",
                ~select(MatchRetention.match_id).where(MatchRetention.match_id == SessionLog.match_id).exists(),
            )
            .group_by(SessionLog.match_id)
            .having(
                func.max(SessionLog.updated_at) < db.ago("-4 hours"),
                # A match whose logs are past the retention window is deleted,
                # not archived (retention.sweep expires before archiving).
                func.max(SessionLog.updated_at) > db.ago(f"-{retention.window_days('LOG_RETENTION_DAYS', 7)} days"),
            )
            .limit(_ARCHIVE_LIMIT),
        )
    )
    return result.changes


async def sweep() -> tuple[int, int]:
    """One archive pass: register old matches, archive closed ones, evict due ones.

    Called from the retention sweep (src/retention.py), which runs an hour
    after boot and every 6 hours after that. Every step is idempotent and
    depends only on timestamps, so a skipped or interrupted sweep is
    finished by the next one. Off unless the blob store is durable
    (archive_enabled).
    """
    if not archive_enabled():
        return 0, 0
    try:
        registered = await register_old_matches()
        if registered:
            log.info("Archive sweep: registered %d match(es) that had no retention row", registered)
    except Exception as exc:  # pragma: no cover — one bad row must not stop the sweep
        log.warning("Archive sweep: registering old matches failed: %s", exc)
    archived = 0
    for row in await _archive_due():
        match_id = row.get("match_id")
        if not match_id:
            continue
        try:
            if await archive_match(match_id):
                archived += 1
        except Exception as exc:
            log.warning("Archive sweep: match %s not archived: %s", match_id[:8], exc)
    evicted = 0
    for row in await _evict_due():
        match_id = row.get("match_id")
        if not match_id:
            continue
        try:
            if await evict_match(match_id):
                evicted += 1
        except Exception as exc:
            log.warning("Archive sweep: match %s not evicted: %s", match_id[:8], exc)
    if archived or evicted:
        log.info("Archive sweep: %d archived, %d evicted", archived, evicted)
    return archived, evicted


# ── Reading ──────────────────────────────────────────────────────────────────


class ArchiveUnreadable(RuntimeError):
    """An evicted match's archive could not be read, so its log can't be shown.

    Raised rather than reading as an empty log: the chunks are no longer in
    D1, so an empty answer would look like a log that never had them. The
    admin endpoints answer 502 with this message.
    """


async def _archived_object(match_id: str, slot: int | None, key: str, archived_at: str) -> bytes | None:
    """One archived object, or None when the slot has none.

    A slot whose session row was first written after the archive has no
    objects, and reads from D1 alone. Any other missing object, or a failed
    fetch, raises ArchiveUnreadable. A row created in the archive's own
    second may be either, and reads as having none.
    """
    try:
        data = await db.get_blob(key)
    except BlobStoreError as exc:
        log.warning("Archive read of %s failed: %s", key, exc)
        raise ArchiveUnreadable(f"archived log unreadable: {key}: {exc}") from exc
    if data is not None:
        return data
    rows = await db.fetch(
        select(SessionLog.created_at).where(
            SessionLog.match_id == match_id, SessionLog.slot.is_(slot), SessionLog.created_at < archived_at
        )
    )
    if rows:
        log.warning("Archive object %s is missing", key)
        raise ArchiveUnreadable(f"archived log missing: {key}")
    return None


def _lines_of(data: bytes) -> list[bytes]:
    return [line for line in gzip.decompress(data).splitlines() if line.strip()]


def _stream_key(match_id: str, slot: int | None, token: str, kind: str) -> str:
    return entries_key(match_id, slot, token) if kind == "log" else audit_key(match_id, slot, token)


async def archived_entries(
    match_id: str, slot: int | None, point: tuple[int, str, str], kind: str = "log"
) -> AsyncIterator[list]:
    """An evicted match's archived entries, in pages, oldest first.

    `point` is the match's `(archived_max_chunk_id, archived_at,
    archive_token)` (db.eviction_point); the token names the objects. The object is fetched and
    decompressed once (a match's log is a few MB gzipped), then parsed a page
    at a time, so the caller works on it in pieces as it does D1's chunks.
    """
    data = await _archived_object(match_id, slot, _stream_key(match_id, slot, point[2], kind), point[1])
    if not data:
        return
    lines = await asyncio.to_thread(_lines_of, data)
    for start in range(0, len(lines), _PAGE_ENTRIES):
        page = lines[start : start + _PAGE_ENTRIES]
        yield await asyncio.to_thread(lambda rows=page: [json.loads(line) for line in rows])


async def archived_context(match_id: str, slot: int | None, point: tuple[int, str, str]) -> str | None:
    """An evicted match's archived `context` string, or None when it has none."""
    data = await _archived_object(match_id, slot, context_key(match_id, slot, point[2]), point[1])
    if not data:
        return None
    text = await asyncio.to_thread(lambda: gzip.decompress(data).decode("utf-8", "replace"))
    return text or None


async def archived_entry_count(match_id: str, slot: int | None, point: tuple[int, str, str], kind: str = "log") -> int:
    """How many entries an evicted match's archived object holds.

    Counts the lines rather than parsing them. The export endpoint needs the
    count before it streams, so an evicted match's export fetches the object
    twice; it is a few MB and only an admin asks for it.
    """
    data = await _archived_object(match_id, slot, _stream_key(match_id, slot, point[2], kind), point[1])
    if not data:
        return 0
    return await asyncio.to_thread(lambda: sum(1 for line in gzip.decompress(data).splitlines() if line.strip()))
