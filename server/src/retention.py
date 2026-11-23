"""Retention tiers: which matches are kept until someone resolves them.

A match is flagged when its session logs show a crash, freeze or desync
(including a field-detector `KNDesync suspect` raised by a real mismatch), a
client reports a fatal error, a vision check finds a visual desync, or a
player sends feedback about it (docs/superpowers/specs/
2026-09-25-offbox-log-storage-design.md §2). Flagged matches are kept until
resolved; the rest follow the normal retention window. Flags are stored by
db.flag_match; this module decides what counts as a problem in the logs and
runs the sweep that deletes expired matches.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

from sqlalchemy import ColumnElement, and_, case, delete, func, or_, select, update

from src import db
from src.blobstore import BlobStoreError
from src.schema import (
    ClientEvent,
    DesyncEvent,
    MatchMetrics,
    MatchRetention,
    Screenshot,
    SessionLog,
    SessionLogChunk,
    SessionLogEviction,
)

log = logging.getLogger(__name__)

# First word of a session-log message that flags a match on any occurrence:
# rollback integrity violations, emulator step failures, stalls and freezes.
_ANY_TAGS = frozenset(
    {
        "REPLAY-NORUN",
        "RB-INVARIANT-VIOLATION",
        "RB-LIVE-MISMATCH",
        "STEP-THREW",
        "TICK-STUCK",
        "RB-INPUT-STALL-TIMEOUT",
        "PEER-PHANTOM",
        "LOCAL-FREEZE",
    }
)
# ...and any tag with one of these prefixes: the C engine's FATAL lines
# (FATAL, FATAL-RING-STALE, ...) and rollback-invariant events
# (RB-INVARIANT-FIXUP).
_ANY_PREFIXES = ("FATAL", "RB-INVARIANT-")
# The field desync detector (web/src/page/desync-detector.ts) logs
# `KNDesync suspect frame=... field=... slot=... trigger=flag ...` when the
# peers' per-field hashes differ for a confirmed frame. It only compares
# frames a confirm window behind the newest, past the rollback window, so a
# suspect is a real split, not a stale prediction a rollback would correct.
# It flags as KNDESYNC-SUSPECT. Mode B's heartbeat logs the same line with
# `trigger=heartbeat` on healthy matches; that one, and every other
# `KNDesync ...` line (init, confirm window, capture, disabled, ...), is not a
# signal.
_KNDESYNC_SUSPECT = "KNDESYNC-SUSPECT"
# Out-of-range inputs from one peer this many times in a match is a storm.
_INPUT_OOR_STORM = 20


def classify_entries(entries: Iterable[dict]) -> list[dict]:
    """Flag reasons found in a match's session-log entries (all slots merged).

    Each reason is {"signal", "count", "slot", "first_f"}: how often the
    signal appeared, the slot it first came from, and its earliest frame.
    Only the message's first word is matched, since the client logs every
    event as `TAG key=value ...`.
    """
    found: dict[str, dict] = {}
    oor: dict[object, list[dict]] = {}
    for entry in entries:
        msg = entry.get("msg")
        if not isinstance(msg, str):
            continue
        # The C engine's own log lines are relayed with a "[C] " prefix.
        tag = msg.removeprefix("[C] ").split(" ", 1)[0].rstrip(":")
        if tag == "INPUT-OOR":
            oor.setdefault(entry.get("slot"), []).append(entry)
            continue
        if tag == "RB-CHECK" and "MISMATCH" in msg:
            signal = "RB-CHECK-MISMATCH"
        elif tag == "KNDesync":
            words = msg.removeprefix("[C] ").split()
            if len(words) < 2 or words[1] != "suspect" or "trigger=flag" not in words:
                continue
            signal = _KNDESYNC_SUSPECT
        elif tag in _ANY_TAGS or tag.startswith(_ANY_PREFIXES):
            signal = tag
        else:
            continue
        _count(found, signal, entry)
    for slot_entries in oor.values():
        if len(slot_entries) >= _INPUT_OOR_STORM:
            for entry in slot_entries:
                _count(found, "INPUT-OOR-STORM", entry)
    return list(found.values())


def _count(found: dict[str, dict], signal: str, entry: dict) -> None:
    frame = entry.get("f")
    reason = found.get(signal)
    if reason is None:
        found[signal] = {"signal": signal, "count": 1, "slot": entry.get("slot"), "first_f": frame}
        return
    reason["count"] += 1
    if isinstance(frame, int | float) and (reason["first_f"] is None or frame < reason["first_f"]):
        reason["first_f"] = frame


# ── Sweep ────────────────────────────────────────────────────────────────────
#
# A match expires when (spec §2 "Tiers and windows"):
#   normal:             LOG_RETENTION_DAYS after it ended (or started, if it never ended)
#   flagged, unresolved: untouched for FLAGGED_STALE_DAYS
#   flagged, resolved:   LOG_RETENTION_DAYS after it was resolved
_BATCH = 200


def window_days(name: str, default: int) -> int:
    """A retention window in days, never below 1: 0 would delete live matches."""
    try:
        value = int(os.environ.get(name, default))
    except ValueError:
        log.warning("Retention: %s is not a whole number of days; using %d", name, default)
        return default
    return max(value, 1)


def _retention_window() -> str:
    return f"-{window_days('LOG_RETENTION_DAYS', 7)} days"


def _expired() -> ColumnElement[bool]:
    """The match_retention rows whose window has passed (see the three cases above)."""
    kept_until = db.ago(_retention_window())
    stale = db.ago(f"-{window_days('FLAGGED_STALE_DAYS', 180)} days")
    return or_(
        and_(
            MatchRetention.tier == "normal",
            func.coalesce(MatchRetention.ended_at, MatchRetention.created_at) < kept_until,
        ),
        and_(
            MatchRetention.tier == "flagged",
            MatchRetention.resolved_at.is_(None),
            MatchRetention.last_touched_at < stale,
        ),
        and_(
            MatchRetention.tier == "flagged",
            MatchRetention.resolved_at.is_not(None),
            MatchRetention.resolved_at < kept_until,
        ),
    )


def _event_match_id() -> ColumnElement:
    """The match a client event belongs to: meta.match_id, or NULL when meta isn't JSON."""
    return case((func.json_valid(ClientEvent.meta), db.json_field(ClientEvent.meta, "$.match_id")))


# Everything keyed by match_id, in deletion order.
_MATCH_TABLES = (Screenshot, DesyncEvent, SessionLogChunk, SessionLogEviction, SessionLog, MatchMetrics)


async def mark_expired() -> list[str]:
    """Tombstone expired matches (step 1 of deletion). Returns those marked.

    The UPDATE re-checks expiry, so a flag or resolve that lands between the
    SELECT and the UPDATE makes it a no-op. A tombstoned match is refused for
    uploads and flags.
    """
    live = MatchRetention.deleting_at.is_(None)
    rows = await db.fetch(select(MatchRetention.match_id).where(live, _expired()).limit(_BATCH))
    marked = []
    for row in rows:
        tombstone = (
            update(MatchRetention)
            .values(deleting_at=db.now())
            .where(MatchRetention.match_id == row["match_id"], live, _expired())
        )
        if (await db.run(tombstone)).changes:
            marked.append(row["match_id"])
    return marked


async def finish_deletes() -> int:
    """Delete every tombstoned match: its blobs, then its rows, retention last.

    Each step is idempotent, so a sweep interrupted anywhere leaves a hidden
    match that the next sweep finishes (spec §4). Returns matches finished.
    """
    tombstoned = MatchRetention.deleting_at.is_not(None)
    rows = await db.fetch(
        select(MatchRetention.match_id).where(tombstoned).order_by(MatchRetention.deleting_at).limit(_BATCH)
    )
    if not rows:
        return 0
    # client_events has no index on meta.match_id, so delete every tombstoned
    # match's events in one scan rather than one scan per match (D1 bills
    # rows read). The matches are already hidden, so doing this first is safe.
    await db.run(delete(ClientEvent).where(_event_match_id().in_(select(MatchRetention.match_id).where(tombstoned))))
    finished = 0
    for row in rows:
        match_id = row["match_id"]
        try:
            await db.delete_match_blobs(match_id)
            await db.run_batch(
                [
                    delete(table).where(table.match_id == match_id)
                    # MatchRetention last: the tombstone goes only when everything else has
                    for table in (*_MATCH_TABLES, MatchRetention)
                ]
            )
        except Exception as exc:
            # One match that keeps failing must not stop the others; it stays
            # tombstoned and is retried next sweep.
            log.warning("Retention: match %s not deleted yet: %s", match_id[:8], exc)
            continue
        finished += 1
    return finished


async def sweep_unregistered() -> None:
    """Age out rows that belong to no match_retention row: logs from before
    registration existed, and client events outside any match."""
    old = db.ago(_retention_window())

    def unregistered(table) -> ColumnElement[bool]:
        registered = select(MatchRetention.match_id).where(MatchRetention.match_id == table.match_id).exists()
        return and_(table.created_at < old, ~registered)

    shots = await db.fetch(
        select(Screenshot.blob_key).where(Screenshot.blob_key.is_not(None), unregistered(Screenshot))
    )
    if shots:
        await db.delete_blobs([r["blob_key"] for r in shots])
    for table in _MATCH_TABLES:
        await db.run(delete(table).where(unregistered(table)))
    in_a_match = select(MatchRetention.match_id).where(MatchRetention.match_id == _event_match_id()).exists()
    await db.run(delete(ClientEvent).where(ClientEvent.created_at < old, ~in_a_match))


# ── Orphan sweep ─────────────────────────────────────────────────────────────
#
# A blob-store prefix `matches/<id>/` can outlive its match's rows: an upload
# that lands after finish_deletes removed the prefix and the rows, or a crash
# between an upload and its record. Nothing else ever deletes those objects.
# Weekly (spec §4 "Retention sweep"), the sweep lists the prefixes and
# deletes the orphans.
#
# The rule: a prefix is deleted only when BOTH
#   1. no match_retention row has its id — not a live, flagged or tombstoned
#      match (a tombstoned one is finish_deletes's to delete, objects first,
#      row last), and
#   2. its newest object is older than LOG_RETENTION_DAYS (at least a day).
# Rule 2 is what keeps a match that is still being written. Its writers are
# game-screenshot (for the room's live match, which can run before
# register_match has committed the row) and log_archive.archive_match (for a
# match with a row; an upload can be in flight while finish_deletes removes
# that row). Either leaves an object minutes old, far inside the window, so
# the prefix is kept, and a later sweep finds it again. A write landing
# between the listing and the delete would need a prefix whose objects are
# all a window old and that has no row: a match gone for days, which nothing
# writes for again, since match ids are fresh uuid4s (api/signaling.py, _start_game_locked).
_ORPHAN_SWEEP_EVERY = timedelta(days=7)
# Prefixes looked at per sweep (one listing call each on R2). A bigger bucket
# is worked through over several 6-hourly sweeps, resuming at the cursor.
_ORPHAN_PREFIXES_PER_RUN = 500
# D1 caps bound parameters per statement at 100.
_ID_QUERY_BATCH = 90
LAST_ORPHAN_SWEEP = "last_orphan_sweep"
ORPHAN_SWEEP_CURSOR = "orphan_sweep_cursor"


def _parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


async def _registered(match_ids: list[str]) -> set[str]:
    found: set[str] = set()
    for start in range(0, len(match_ids), _ID_QUERY_BATCH):
        batch = match_ids[start : start + _ID_QUERY_BATCH]
        rows = await db.fetch(select(MatchRetention.match_id).where(MatchRetention.match_id.in_(batch)))
        found.update(row["match_id"] for row in rows)
    return found


async def sweep_orphans(now: datetime | None = None) -> int | None:
    """Delete blob-store prefixes that belong to no match (see the rule above).

    Runs only when the last full pass ended a week ago, or a pass is part way
    through (`orphan_sweep_cursor`); each call looks at one bounded page of
    prefixes. A listing that fails logs a warning and changes neither marker,
    so the next sweep tries again. Returns prefixes deleted, or None when it
    didn't run.
    """
    now = now or datetime.now(UTC)
    cursor = await db.get_server_state(ORPHAN_SWEEP_CURSOR)
    last = _parse_time(await db.get_server_state(LAST_ORPHAN_SWEEP))
    if cursor is None and last is not None and now - last < _ORPHAN_SWEEP_EVERY:
        return None
    try:
        listing = await db.list_match_prefixes(after=cursor, limit=_ORPHAN_PREFIXES_PER_RUN)
    except BlobStoreError as exc:
        log.warning("Orphan sweep: listing the blob store failed; retrying next sweep: %s", exc)
        return None

    # The database first: most prefixes have a row, and each newest-time
    # check below is a listing call (an R2 Class A operation).
    registered = await _registered(listing.match_ids) if listing.match_ids else set()
    cutoff = now - timedelta(days=window_days("LOG_RETENTION_DAYS", 7))
    deleted = 0
    for match_id in listing.match_ids:
        if match_id in registered:
            continue
        try:
            newest = await db.newest_in_match(match_id)
        except BlobStoreError as exc:
            log.warning("Orphan sweep: prefix of %s not listed: %s", match_id[:8], exc)
            continue
        if newest is None:
            log.warning("Orphan sweep: prefix of %s kept: its newest object time isn't known", match_id[:8])
            continue
        if newest >= cutoff:
            continue
        try:
            await db.delete_match_blobs(match_id)
        except BlobStoreError as exc:
            # Still an orphan next week; one failure doesn't stop the others.
            log.warning("Orphan sweep: prefix of %s not deleted: %s", match_id[:8], exc)
            continue
        deleted += 1

    await db.set_server_state(ORPHAN_SWEEP_CURSOR, listing.next_after)
    if listing.next_after is None:
        await db.set_server_state(LAST_ORPHAN_SWEEP, now.isoformat())
    log.info(
        "Orphan sweep: %d prefix(es) listed, %d orphan(s) deleted%s",
        len(listing.match_ids),
        deleted,
        "" if listing.next_after is None else "; continuing next sweep",
    )
    return deleted


async def sweep(*, include_unregistered: bool = True) -> None:
    """One retention pass: finish interrupted deletes, tombstone and delete
    newly expired matches, archive and evict what is left, then (unless told
    not to) age out unregistered rows, which scans whole tables and so runs
    less often. Last, the weekly orphan sweep, which gates itself.

    Expiry runs before the archive so a match past its window is deleted
    rather than uploaded first (src/log_archive.py)."""
    from src import log_archive

    await finish_deletes()
    marked = await mark_expired()
    finished = await finish_deletes()
    await log_archive.sweep()
    if include_unregistered:
        await sweep_unregistered()
    await sweep_orphans()
    log.info("Retention sweep: %d match(es) expired, %d deleted", len(marked), finished)
