"""Retention tiers: which matches are kept until someone resolves them.

A match is flagged when its session logs show a crash, freeze or desync, a
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

from src import db
from src.blobstore import BlobStoreError

log = logging.getLogger(__name__)

# First word of a session-log message that flags a match on any occurrence:
# rollback integrity violations, stalls and freezes.
_ANY_TAGS = frozenset(
    {
        "REPLAY-NORUN",
        "RB-INVARIANT-VIOLATION",
        "RB-LIVE-MISMATCH",
        "TICK-STUCK",
        "RB-INPUT-STALL-TIMEOUT",
        "PEER-PHANTOM",
        "LOCAL-FREEZE",
    }
)
# ...and any tag with one of these prefixes: the C engine's FATAL lines
# (FATAL, FATAL-RING-STALE, ...) and rollback-invariant events
# (RB-INVARIANT-FIXUP, RB-INVARIANT-VIOLATION).
_ANY_PREFIXES = ("FATAL", "RB-INVARIANT-")
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
_EXPIRED = """(
    (tier = 'normal' AND COALESCE(ended_at, created_at) < datetime('now', ?))
    OR (tier = 'flagged' AND resolved_at IS NULL AND last_touched_at < datetime('now', ?))
    OR (tier = 'flagged' AND resolved_at IS NOT NULL AND resolved_at < datetime('now', ?))
)"""
_BATCH = 200


def _windows() -> tuple[str, str, str]:
    retention_days = int(os.environ.get("LOG_RETENTION_DAYS", "7"))
    stale_days = int(os.environ.get("FLAGGED_STALE_DAYS", "180"))
    return f"-{retention_days} days", f"-{stale_days} days", f"-{retention_days} days"


async def mark_expired() -> list[str]:
    """Tombstone expired matches (step 1 of deletion). Returns those marked.

    The UPDATE re-checks expiry, so a flag or resolve that lands between the
    SELECT and the UPDATE makes it a no-op. A tombstoned match is refused for
    uploads and flags, and hidden from the admin API.
    """
    windows = _windows()
    rows = await db.query(
        f"SELECT match_id FROM match_retention WHERE deleting_at IS NULL AND {_EXPIRED} LIMIT ?",
        (*windows, _BATCH),
    )
    marked = []
    for row in rows:
        changed = await db.execute_write(
            f"UPDATE match_retention SET deleting_at = datetime('now') WHERE match_id = ? AND deleting_at IS NULL AND {_EXPIRED}",
            (row["match_id"], *windows),
        )
        if changed:
            marked.append(row["match_id"])
    return marked


async def finish_deletes() -> int:
    """Delete every tombstoned match: its blobs, then its rows, retention last.

    Each step is idempotent, so a sweep interrupted anywhere leaves a hidden
    match that the next sweep finishes (spec §4). Returns matches finished.
    """
    rows = await db.query("SELECT match_id FROM match_retention WHERE deleting_at IS NOT NULL LIMIT ?", (_BATCH,))
    finished = 0
    for row in rows:
        match_id = row["match_id"]
        try:
            await db.delete_match_blobs(match_id)
        except BlobStoreError as exc:
            log.warning("Retention: blobs of %s not deleted yet: %s", match_id[:8], exc)
            continue
        for sql in (
            "DELETE FROM screenshots WHERE match_id = ?",
            "DELETE FROM desync_events WHERE match_id = ?",
            "DELETE FROM client_events WHERE json_valid(meta) AND json_extract(meta, '$.match_id') = ?",
            "DELETE FROM session_log_chunks WHERE match_id = ?",
            "DELETE FROM session_logs WHERE match_id = ?",
            "DELETE FROM match_metrics WHERE match_id = ?",
            "DELETE FROM match_retention WHERE match_id = ?",
        ):
            await db.execute_write(sql, (match_id,))
        finished += 1
    return finished


async def sweep_unregistered() -> None:
    """Age out rows that belong to no match_retention row: logs from before
    registration existed, and client events outside any match."""
    cutoff = (_windows()[0],)
    orphan = "created_at < datetime('now', ?) AND NOT EXISTS (SELECT 1 FROM match_retention r WHERE r.match_id = {t}.match_id)"
    shots = await db.query(
        f"SELECT blob_key FROM screenshots WHERE blob_key IS NOT NULL AND {orphan.format(t='screenshots')}", cutoff
    )
    if shots:
        await db.delete_blobs([r["blob_key"] for r in shots])
    for table in ("screenshots", "desync_events", "session_log_chunks", "session_logs", "match_metrics"):
        await db.execute_write(f"DELETE FROM {table} WHERE {orphan.format(t=table)}", cutoff)
    await db.execute_write(
        """DELETE FROM client_events WHERE created_at < datetime('now', ?)
           AND NOT EXISTS (SELECT 1 FROM match_retention r
                           WHERE json_valid(client_events.meta)
                             AND r.match_id = json_extract(client_events.meta, '$.match_id'))""",
        cutoff,
    )


async def sweep() -> None:
    """One retention pass: finish interrupted deletes, tombstone and delete
    newly expired matches, then age out unregistered rows."""
    await finish_deletes()
    marked = await mark_expired()
    finished = await finish_deletes()
    await sweep_unregistered()
    log.info("Retention sweep: %d match(es) expired, %d deleted", len(marked), finished)
