"""Match metrics + parquet rotation.

Sweeps ended session_logs rows, merges all peers of each match into one
Parquet file on disk, and writes a precomputed summary row into the
`match_metrics` table. Designed to run as a background asyncio task
inside the live server (60-second tick) and as a manual CLI tool for
backfills (`python -m src.match_rotation`).

Why this exists
---------------
Every match's session log lives in `session_logs.log_data` as a JSON
array string — which is fine for ingestion (small, append-only writes
per peer) but awful for analysis. Every admin query currently has to
re-parse the blob on every request. Worse, as soon as we want
cross-match aggregates (rollback success rates over time, desync
counts by game mode, etc.) we'd be re-parsing every blob every time.

Rotation does that parsing exactly once per match and writes two
artifacts:

  1. `data/parquet/YYYY-MM/<match_id>.zstd.parquet` — one row per log
     entry, all peers unioned, `slot`/`player_name`/`session_id`
     columns preserved. This is the "canonical" shape for analyze
     tools to scan with DuckDB/Polars.

  2. A row in `match_metrics` holding the aggregates that we already
     compute by hand in `tools/analyze_match.py` — mismatch counts,
     first divergence frame, summed rollback stats, pacing throttle
     counts, etc.

Rotation is idempotent: the sweep query excludes matches that already
have a `match_metrics` row, so restart/retry is safe. `log_data` is
not deleted — Parquet is purely additive for now. A TTL cleaner can
come later once we trust rotation in production.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
from dataclasses import dataclass
from pathlib import Path

from src import db

log = logging.getLogger(__name__)

# ── Config ───────────────────────────────────────────────────────────────────

# Where rotated Parquet files live. Default sits next to the SQLite DB so it
# shares the same persistent volume in Docker. Override with PARQUET_DIR for
# separate storage (e.g. S3-mounted path).
_DEFAULT_PARQUET_DIR = os.path.join("data", "parquet")

# Background sweeper interval. Short enough that analyze_match.py on a just-
# ended match reliably sees metrics on a second attempt.
SWEEP_INTERVAL_SEC = 60


def _parquet_dir() -> Path:
    p = Path(os.environ.get("PARQUET_DIR", _DEFAULT_PARQUET_DIR))
    p.mkdir(parents=True, exist_ok=True)
    return p


# ── Metric extraction ────────────────────────────────────────────────────────


@dataclass
class MatchMetrics:
    """Aggregate stats for one match, summed/maxed across all peers."""

    match_id: str
    mode: str | None
    peer_count: int
    frames: int
    duration_sec: float
    ended_by: str | None
    mismatch_count: int
    first_divergence_frame: int | None
    last_clean_frame: int | None
    rollbacks: int
    predictions: int
    correct_predictions: int
    max_rollback_depth: int
    failed_rollbacks: int
    tolerance_hits: int
    pacing_throttle_count: int
    parquet_path: str | None
    parquet_bytes: int | None
    entry_count: int


_LAST_GOOD_RE = re.compile(r"lastGood=(\d+)")


def _compute_metrics(
    match_id: str,
    session_rows: list[dict],
    merged_entries: list[dict],
    parquet_path: Path | None,
    parquet_bytes: int | None,
) -> MatchMetrics:
    """Build a MatchMetrics row from the raw session_logs rows + merged entries.

    `session_rows` is the list of aiosqlite Row dicts (one per peer).
    `merged_entries` is every log_data entry from every peer, with
    `slot` / `session_id` stamped on. We walk it once to compute all
    the per-entry aggregates so this scales O(N) in entries, not
    O(N * metrics).
    """
    # Mode: prefer the first non-null mode across peers (they should all
    # agree for a given match, but be defensive).
    mode = next((r.get("mode") for r in session_rows if r.get("mode")), None)
    ended_by = next((r.get("ended_by") for r in session_rows if r.get("ended_by")), None)

    # Summary-level stats: sum rollback counters across peers, max frames/duration.
    # We don't average — the host's frame count is typically the ground truth but
    # we don't know who was host from this row alone, so max() is a safe upper
    # bound that also covers streaming mode (where only one peer has frames).
    frames = 0
    duration_sec = 0.0
    rb_totals = {
        "rollbacks": 0,
        "predictions": 0,
        "correctPredictions": 0,
        "failedRollbacks": 0,
        "toleranceHits": 0,
    }
    max_depth = 0
    for r in session_rows:
        summary = r.get("summary") or "{}"
        if isinstance(summary, str):
            try:
                summary = json.loads(summary)
            except json.JSONDecodeError:
                summary = {}
        if not isinstance(summary, dict):
            continue
        frames = max(frames, int(summary.get("frames") or 0))
        with contextlib.suppress(TypeError, ValueError):
            duration_sec = max(duration_sec, float(summary.get("duration_sec") or 0))
        rb = summary.get("rollback") or {}
        if isinstance(rb, dict):
            for k in rb_totals:
                with contextlib.suppress(TypeError, ValueError):
                    rb_totals[k] += int(rb.get(k) or 0)
            with contextlib.suppress(TypeError, ValueError):
                max_depth = max(max_depth, int(rb.get("maxDepth") or 0))

    # Per-entry aggregates: single pass.
    mismatch_count = 0
    first_divergence_frame: int | None = None
    last_clean_frame: int | None = None
    pacing_throttle_count = 0

    for e in merged_entries:
        msg = e.get("msg")
        if not isinstance(msg, str):
            continue
        if "MISMATCH" in msg:
            mismatch_count += 1
            f = e.get("f")
            if isinstance(f, (int, float)):
                fi = int(f)
                if first_divergence_frame is None or fi < first_divergence_frame:
                    first_divergence_frame = fi
            m = _LAST_GOOD_RE.search(msg)
            if m:
                lg = int(m.group(1))
                if last_clean_frame is None or lg > last_clean_frame:
                    last_clean_frame = lg
        if "PACING-THROTTLE start" in msg:
            pacing_throttle_count += 1

    return MatchMetrics(
        match_id=match_id,
        mode=mode,
        peer_count=len(session_rows),
        frames=frames,
        duration_sec=duration_sec,
        ended_by=ended_by,
        mismatch_count=mismatch_count,
        first_divergence_frame=first_divergence_frame,
        last_clean_frame=last_clean_frame,
        rollbacks=rb_totals["rollbacks"],
        predictions=rb_totals["predictions"],
        correct_predictions=rb_totals["correctPredictions"],
        max_rollback_depth=max_depth,
        failed_rollbacks=rb_totals["failedRollbacks"],
        tolerance_hits=rb_totals["toleranceHits"],
        pacing_throttle_count=pacing_throttle_count,
        parquet_path=str(parquet_path) if parquet_path else None,
        parquet_bytes=parquet_bytes,
        entry_count=len(merged_entries),
    )


# ── Parquet writer ───────────────────────────────────────────────────────────


def _write_parquet(match_id: str, merged_entries: list[dict], created_at: str | None) -> tuple[Path, int] | None:
    """Write merged entries to `<parquet_dir>/YYYY-MM/<match_id>.zstd.parquet`.

    Returns (path, size_in_bytes) on success, or None if polars is not
    installed or the entry list is empty. Polars is in the `analysis`
    optional dependency group; this function is the only place it's
    imported, so a server missing the dep just falls back to
    metrics-only rotation and logs a warning once.
    """
    if not merged_entries:
        return None

    try:
        import polars as pl
    except (ImportError, Exception) as exc:
        log.warning(
            "polars unavailable — skipping Parquet write for match %s: %s",
            match_id[:8],
            exc,
        )
        return None

    # Partition by the month the match was created in, not the rotation
    # time. Keeps backfills stable regardless of when they run.
    partition = "unknown"
    if created_at:
        # SQLite datetime('now') format: "YYYY-MM-DD HH:MM:SS"
        partition = created_at[:7] if len(created_at) >= 7 else "unknown"
    out_dir = _parquet_dir() / partition
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{match_id}.zstd.parquet"

    # Polars is strict about schema mismatches across rows; use
    # infer_schema_length=None so it scans every row to find the widest
    # type. Small cost compared to JSON parsing.
    df = pl.DataFrame(merged_entries, infer_schema_length=None, strict=False)
    df.write_parquet(out_path, compression="zstd", compression_level=3)

    try:
        size = out_path.stat().st_size
    except OSError:
        size = 0
    return out_path, size


# ── Core rotation logic ──────────────────────────────────────────────────────


def _merge_entries(session_rows: list[dict]) -> list[dict]:
    """Flatten all peers' log_data arrays into one list, stamping per-row metadata."""
    merged: list[dict] = []
    for r in session_rows:
        log_data = r.get("log_data") or "[]"
        if isinstance(log_data, str):
            try:
                log_data = json.loads(log_data)
            except json.JSONDecodeError:
                log_data = []
        if not isinstance(log_data, list):
            continue
        stamp = {
            "session_id": r.get("id"),
            "match_id": r.get("match_id"),
            "slot": r.get("slot"),
            "player_name": r.get("player_name"),
        }
        merged.extend({**stamp, **entry} for entry in log_data if isinstance(entry, dict))
    return merged


async def rotate_match(match_id: str) -> MatchMetrics | None:
    """Rotate one match: load peers, write Parquet, upsert match_metrics.

    Idempotent. If the match has no rows or all rows have empty log_data,
    still writes a metrics row (peer_count=0 or entry_count=0) so the
    sweeper doesn't keep picking it up on every tick.
    """
    rows = await db.query(
        "SELECT * FROM session_logs WHERE match_id = ? ORDER BY slot",
        (match_id,),
    )
    if not rows:
        log.warning("rotate_match: no session_logs rows for match %s", match_id[:8])
        return None

    merged = _merge_entries(rows)
    # Earliest created_at across peers determines the partition month.
    created_at = min((r.get("created_at") or "") for r in rows) or None

    parquet_result = _write_parquet(match_id, merged, created_at)
    parquet_path, parquet_bytes = parquet_result if parquet_result else (None, None)

    metrics = _compute_metrics(match_id, rows, merged, parquet_path, parquet_bytes)
    await _upsert_metrics(metrics)

    log.info(
        "rotated match=%s peers=%d entries=%d mismatches=%d parquet=%s",
        match_id[:8],
        metrics.peer_count,
        metrics.entry_count,
        metrics.mismatch_count,
        f"{parquet_bytes} bytes" if parquet_bytes else "skipped",
    )
    return metrics


async def _upsert_metrics(m: MatchMetrics) -> None:
    """Insert-or-replace one match_metrics row."""
    await db.execute_write(
        """
        INSERT INTO match_metrics (
            match_id, mode, peer_count, frames, duration_sec, ended_by,
            mismatch_count, first_divergence_frame, last_clean_frame,
            rollbacks, predictions, correct_predictions, max_rollback_depth,
            failed_rollbacks, tolerance_hits, pacing_throttle_count,
            parquet_path, parquet_bytes, entry_count, rotated_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, datetime('now')
        )
        ON CONFLICT(match_id) DO UPDATE SET
            mode=excluded.mode,
            peer_count=excluded.peer_count,
            frames=excluded.frames,
            duration_sec=excluded.duration_sec,
            ended_by=excluded.ended_by,
            mismatch_count=excluded.mismatch_count,
            first_divergence_frame=excluded.first_divergence_frame,
            last_clean_frame=excluded.last_clean_frame,
            rollbacks=excluded.rollbacks,
            predictions=excluded.predictions,
            correct_predictions=excluded.correct_predictions,
            max_rollback_depth=excluded.max_rollback_depth,
            failed_rollbacks=excluded.failed_rollbacks,
            tolerance_hits=excluded.tolerance_hits,
            pacing_throttle_count=excluded.pacing_throttle_count,
            parquet_path=excluded.parquet_path,
            parquet_bytes=excluded.parquet_bytes,
            entry_count=excluded.entry_count,
            rotated_at=datetime('now')
        """,
        (
            m.match_id,
            m.mode,
            m.peer_count,
            m.frames,
            m.duration_sec,
            m.ended_by,
            m.mismatch_count,
            m.first_divergence_frame,
            m.last_clean_frame,
            m.rollbacks,
            m.predictions,
            m.correct_predictions,
            m.max_rollback_depth,
            m.failed_rollbacks,
            m.tolerance_hits,
            m.pacing_throttle_count,
            m.parquet_path,
            m.parquet_bytes,
            m.entry_count,
        ),
    )


# ── Sweeper ──────────────────────────────────────────────────────────────────


async def sweep_pending(limit: int = 50) -> int:
    """Rotate any ended matches that don't yet have a match_metrics row.

    Returns the number of matches rotated. Caps the batch so one sweep
    tick can't stall the event loop if a backfill is in progress.
    """
    # A match is "ended" when at least one of its session_log rows has
    # ended_by set. We find distinct match_ids meeting that, minus the
    # ones already rotated.
    rows = await db.query(
        """
        SELECT DISTINCT s.match_id
        FROM session_logs s
        LEFT JOIN match_metrics m ON m.match_id = s.match_id
        WHERE s.ended_by IS NOT NULL
          AND m.match_id IS NULL
        LIMIT ?
        """,
        (limit,),
    )
    rotated = 0
    for r in rows:
        mid = r.get("match_id")
        if not mid:
            continue
        try:
            await rotate_match(mid)
            rotated += 1
        except Exception as exc:  # pragma: no cover — defensive
            log.exception("rotate_match failed for %s: %s", mid[:8], exc)
    return rotated


async def _sweeper_loop(interval: int) -> None:
    """Forever-loop that calls sweep_pending every `interval` seconds."""
    log.info("match_rotation sweeper started (interval=%ds)", interval)
    try:
        while True:
            try:
                n = await sweep_pending()
                if n:
                    log.info("match_rotation sweep rotated %d match(es)", n)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover
                log.exception("sweep_pending error: %s", exc)
            await asyncio.sleep(interval)
    except asyncio.CancelledError:
        log.info("match_rotation sweeper cancelled")
        raise


def start_sweeper(interval: int = SWEEP_INTERVAL_SEC) -> asyncio.Task:
    """Fire-and-forget launcher for the sweeper loop.

    Returns the task so lifespan shutdown can cancel it cleanly.
    """
    return asyncio.create_task(_sweeper_loop(interval), name="match_rotation_sweeper")


# ── CLI entrypoint (backfill) ────────────────────────────────────────────────


async def _cli_main() -> None:
    """`python -m src.match_rotation` — backfill all ended matches."""
    import argparse

    from dotenv import load_dotenv

    load_dotenv()

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--match-id", help="Rotate only this one match (repeatable)")
    parser.add_argument("--limit", type=int, default=1000, help="Max matches to rotate in one pass")
    parser.add_argument("--force", action="store_true", help="Re-rotate even if already in match_metrics")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(name)s  %(message)s")
    await db.init_db()
    try:
        if args.match_id:
            await rotate_match(args.match_id)
            return
        if args.force:
            rows = await db.query(
                "SELECT DISTINCT match_id FROM session_logs WHERE ended_by IS NOT NULL LIMIT ?",
                (args.limit,),
            )
            for r in rows:
                mid = r.get("match_id")
                if mid:
                    await rotate_match(mid)
            print(f"Rotated {len(rows)} matches (forced)")
        else:
            n = await sweep_pending(limit=args.limit)
            print(f"Rotated {n} match(es)")
    finally:
        await db.close_db()


def _cli_entry() -> None:
    asyncio.run(_cli_main())


if __name__ == "__main__":
    _cli_entry()
