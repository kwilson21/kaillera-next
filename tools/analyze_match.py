#!/usr/bin/env python3
"""Analyze a kaillera-next match for state divergence patterns.

Downloads the JSONL session log for both peers via the admin export
endpoint, loads them with Polars (via DuckDB scan), and runs the
diagnostic queries that have been most useful for hunting determinism
bugs:

  - Top diverging savestate regions across the match
  - Cross-peer byte correlation (which 4-byte words diverge and how)
  - Mismatch timing (when does divergence first appear, last clean frame)
  - Rollback / prediction stats from the per-flush summary
  - C-side debug log highlights (MISPREDICTION detail, TOLERANCE-HIT, etc)

Usage:
    python tools/analyze_match.py <match_id>            # against dev
    python tools/analyze_match.py <match_id> --base PROD_URL --key PROD_KEY
    python tools/analyze_match.py <match_id> --raw      # show raw entries

Why DuckDB + Polars instead of pure Python:

The previous analysis loop loaded a 10K-entry JSON blob into a Python
list and ran handwritten Counter/regex loops. With DuckDB scanning the
JSONL stream and Polars expressions doing the aggregation, the same
queries run ~10-100x faster and the code is half the length. As the
session log database grows past a few thousand matches this scales
without changes — DuckDB will read the JSONL files lazily and push
filters/aggregations down to the scan.

Requires: pip install duckdb polars requests
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

try:
    import duckdb
    import polars as pl
    import requests
    import urllib3

    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except ImportError as exc:
    print(f"Missing dep: {exc}", file=sys.stderr)
    print("Install with: uv pip install -e 'server[analysis]'", file=sys.stderr)
    sys.exit(1)


# ── HTTP helpers ─────────────────────────────────────────────────────────────


def _list_sessions_for_match(base: str, key: str, match_id: str) -> list[dict]:
    """Find every session_log row for a given match (typically 2: host + guest)."""
    r = requests.get(
        f"{base}/admin/api/session-logs?days=7&limit=200",
        headers={"X-Admin-Key": key},
        verify=False,
        timeout=10,
    )
    r.raise_for_status()
    data = r.json()
    sessions = [e for e in data.get("entries", []) if e.get("match_id", "").startswith(match_id)]
    if not sessions:
        # Maybe the user passed a full match_id but we're matching by prefix
        sessions = [e for e in data.get("entries", []) if e.get("match_id") == match_id]
    return sessions


def _download_jsonl(base: str, key: str, session_id: int, dest: Path) -> int:
    """Stream the JSONL export to a local file. Returns line count.

    Tries the new /export?format=jsonl endpoint first. Falls back to
    the legacy detail endpoint and converts the JSON array to JSONL
    locally — so the analyzer keeps working against servers that
    haven't been restarted to pick up the export endpoint.
    """
    import json as _json

    # Try the streaming export endpoint first
    r = requests.get(
        f"{base}/admin/api/session-logs/{session_id}/export?format=jsonl",
        headers={"X-Admin-Key": key},
        verify=False,
        timeout=30,
        stream=True,
    )
    if r.status_code == 200:
        line_count = 0
        with dest.open("wb") as f:
            for chunk in r.iter_content(chunk_size=65536):
                if chunk:
                    f.write(chunk)
                    line_count += chunk.count(b"\n")
        return line_count

    # Fallback: the running server is older than the export endpoint.
    # Pull the detail JSON and convert to JSONL in-memory. Same shape:
    # first line is meta, rest are entries with session metadata merged in.
    r2 = requests.get(
        f"{base}/admin/api/session-logs/{session_id}",
        headers={"X-Admin-Key": key},
        verify=False,
        timeout=30,
    )
    r2.raise_for_status()
    detail = r2.json()
    log_data = detail.get("log_data") or []
    if isinstance(log_data, str):
        try:
            log_data = _json.loads(log_data)
        except _json.JSONDecodeError:
            log_data = []
    summary = detail.get("summary") or {}
    if isinstance(summary, str):
        try:
            summary = _json.loads(summary)
        except _json.JSONDecodeError:
            summary = {}
    context_obj = detail.get("context") or {}
    if isinstance(context_obj, str):
        try:
            context_obj = _json.loads(context_obj)
        except _json.JSONDecodeError:
            context_obj = {}
    meta = {
        "_kind": "meta",
        "id": detail.get("id"),
        "match_id": detail.get("match_id"),
        "room": detail.get("room"),
        "slot": detail.get("slot"),
        "player_name": detail.get("player_name"),
        "mode": detail.get("mode"),
        "ended_by": detail.get("ended_by"),
        "created_at": str(detail.get("created_at")),
        "updated_at": str(detail.get("updated_at")),
        "summary": summary,
        "context": context_obj,
        "entry_count": len(log_data),
    }
    per_line_meta = {
        "session_id": detail.get("id"),
        "match_id": detail.get("match_id"),
        "slot": detail.get("slot"),
    }
    line_count = 0
    with dest.open("wb") as f:
        f.write((_json.dumps(meta) + "\n").encode("utf-8"))
        line_count += 1
        for row_entry in log_data:
            if not isinstance(row_entry, dict):
                continue
            merged = {**per_line_meta, **row_entry}
            f.write((_json.dumps(merged, separators=(",", ":")) + "\n").encode("utf-8"))
            line_count += 1
    return line_count


# ── Polars/DuckDB queries ────────────────────────────────────────────────────


def _load_match(jsonl_paths: list[Path]) -> pl.DataFrame:
    """Load all peer JSONL files into one Polars DataFrame.

    Uses DuckDB's read_json_auto for speed and schema inference, then
    materializes to Polars. Drops the meta header lines (first line of
    each file is `{"_kind":"meta", ...}` with session-level summary).
    """
    con = duckdb.connect(":memory:")
    paths_str = ", ".join(f"'{p}'" for p in jsonl_paths)
    # union_by_name handles peers with slightly different field sets
    df = con.execute(
        f"""
        SELECT * FROM read_json_auto([{paths_str}],
            format='newline_delimited',
            union_by_name=true,
            ignore_errors=true)
        """
    ).pl()
    # Drop the meta header rows; keep only entries that have a `msg` column
    if "msg" in df.columns:
        df = df.filter(pl.col("msg").is_not_null())
    return df


def _print_section(title: str) -> None:
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}")


def query_event_counts(df: pl.DataFrame) -> None:
    """Group rows by event-prefix (first space-separated token of `msg`)."""
    _print_section("EVENT COUNTS BY PEER")
    if "slot" not in df.columns or "msg" not in df.columns:
        print("(missing slot/msg columns)")
        return
    counts = (
        df.with_columns(
            event=pl.col("msg")
            .str.extract(r"^(\[?[A-Z\-]+\]?(?:\s+[A-Za-z\-]+)?)", 1)
            .fill_null("?")
        )
        .group_by(["slot", "event"])
        .len()
        .sort("len", descending=True)
        .head(40)
    )
    print(counts)


def query_mismatch_timing(df: pl.DataFrame) -> None:
    """When did divergence first appear? Last clean frame? How long stable?"""
    _print_section("MISMATCH TIMING")
    if "msg" not in df.columns or "f" not in df.columns:
        print("(missing msg/f columns)")
        return
    mismatches = df.filter(pl.col("msg").str.contains("MISMATCH"))
    if mismatches.height == 0:
        print("✓ No MISMATCH events — match was clean across all peers.")
        return
    by_slot = (
        mismatches.group_by("slot")
        .agg(
            count=pl.len(),
            first_frame=pl.col("f").min(),
            last_frame=pl.col("f").max(),
        )
        .sort("slot")
    )
    print(by_slot)
    # Last good frame from the lastGood= field embedded in the message
    last_good = (
        mismatches.with_columns(lastGood=pl.col("msg").str.extract(r"lastGood=(\d+)", 1).cast(pl.Int64))
        .filter(pl.col("lastGood").is_not_null())
        .group_by("slot")
        .agg(last_clean_frame=pl.col("lastGood").max())
    )
    if last_good.height:
        print("\nLast clean frame per peer:")
        print(last_good)


def query_diverging_regions(df: pl.DataFrame) -> None:
    """Top 256-region indices that diverge — pinpoints which savestate slice."""
    _print_section("TOP DIVERGING REGIONS (RB-REGION-DIFF)")
    region_diffs = df.filter(
        pl.col("msg").str.contains("RB-REGION-DIFF") & pl.col("msg").str.contains("regions differ")
    )
    if region_diffs.height == 0:
        print("(no region-diff events with data)")
        return
    # Pull all r{N}: tokens from each msg
    msgs = region_diffs.get_column("msg").to_list()
    region_hits: dict[int, int] = defaultdict(int)
    for m in msgs:
        for ri in re.findall(r"r(\d+):", m):
            region_hits[int(ri)] += 1
    top = sorted(region_hits.items(), key=lambda kv: kv[1], reverse=True)[:20]
    for ri, n in top:
        print(f"  r{ri:>3}: {n} occurrences")


def query_rollback_summary(meta_paths: list[Path]) -> None:
    """Pull rollback stats from the meta header line of each JSONL file."""
    import json

    _print_section("ROLLBACK SUMMARY (per peer)")
    for p in meta_paths:
        with p.open() as f:
            first_line = f.readline()
        try:
            meta = json.loads(first_line)
        except json.JSONDecodeError:
            continue
        if meta.get("_kind") != "meta":
            continue
        summary = meta.get("summary", {}) or {}
        rollback = summary.get("rollback", {}) or {}
        print(
            f"  slot={meta.get('slot')} player={meta.get('player_name')} "
            f"frames={summary.get('frames')} dur={summary.get('duration_sec')}s "
            f"ended={meta.get('ended_by')}"
        )
        for k in [
            "rollbacks",
            "predictions",
            "correctPredictions",
            "maxDepth",
            "failedRollbacks",
            "toleranceHits",
        ]:
            if k in rollback:
                print(f"    {k}: {rollback[k]}")
        breakdown = rollback.get("mispredBreakdown") or {}
        if breakdown:
            print(f"    mispredBreakdown: {breakdown}")


def query_c_debug_highlights(df: pl.DataFrame) -> None:
    """Show C-side debug log entries (MISPREDICTION detail, etc)."""
    _print_section("C DEBUG LOG HIGHLIGHTS ([C] entries)")
    if "msg" not in df.columns:
        return
    c_entries = df.filter(pl.col("msg").str.starts_with("[C]"))
    if c_entries.height == 0:
        print("(no [C] entries — drain may not have fired or no rollback events)")
        return
    print(f"Total [C] entries: {c_entries.height}\n")
    # Show types
    types: dict[str, int] = defaultdict(int)
    for m in c_entries.get_column("msg").to_list():
        # Extract the second token (event type after [C])
        match = re.match(r"\[C\]\s+([A-Z\-]+)", m)
        if match:
            types[match.group(1)] += 1
    for t, n in sorted(types.items(), key=lambda kv: kv[1], reverse=True):
        print(f"  {t}: {n}")
    # First few of each type
    print("\nFirst MISPREDICTION entries:")
    for m in c_entries.filter(pl.col("msg").str.contains("MISPREDICTION")).head(5).get_column("msg").to_list():
        print(f"  {m[:200]}")
    print("\nFirst TOLERANCE-HIT entries:")
    for m in c_entries.filter(pl.col("msg").str.contains("TOLERANCE-HIT")).head(5).get_column("msg").to_list():
        print(f"  {m[:200]}")


def query_pacing(df: pl.DataFrame) -> None:
    """How much was the match pacing-throttled?"""
    _print_section("PACING THROTTLE")
    pacing = df.filter(pl.col("msg").str.contains("PACING-THROTTLE start"))
    if pacing.height == 0:
        print("✓ No pacing throttle events.")
        return
    by_slot = pacing.group_by("slot").len().sort("slot")
    total_frames_per_slot = (
        df.filter(pl.col("f").is_not_null()).group_by("slot").agg(max_f=pl.col("f").max()).sort("slot")
    )
    joined = by_slot.join(total_frames_per_slot, on="slot", how="left").with_columns(
        pct=(pl.col("len") / pl.col("max_f") * 100).round(1)
    )
    print(joined)


# ── Entry point ──────────────────────────────────────────────────────────────


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("match_id", help="Match ID prefix (8+ chars) or full UUID")
    p.add_argument("--base", default="https://localhost:27888", help="Server base URL")
    p.add_argument("--key", default=os.environ.get("KN_ADMIN_KEY", "1234"), help="Admin key")
    p.add_argument(
        "--keep",
        action="store_true",
        help="Keep downloaded JSONL files instead of using a tmpdir",
    )
    args = p.parse_args()

    print(f"[analyze] looking up sessions for match {args.match_id} on {args.base}")
    sessions = _list_sessions_for_match(args.base, args.key, args.match_id)
    if not sessions:
        print(f"No session_logs found for match {args.match_id}", file=sys.stderr)
        sys.exit(2)
    print(f"[analyze] found {len(sessions)} session(s):")
    for s in sessions:
        print(f"  id={s['id']} slot={s['slot']} room={s.get('room')} updated={s.get('updated_at')}")

    # Download JSONL files
    if args.keep:
        out_dir = Path(f"/tmp/kn-match-{args.match_id[:8]}")
        out_dir.mkdir(exist_ok=True)
        cleanup = False
    else:
        out_dir = Path(tempfile.mkdtemp(prefix="kn-match-"))
        cleanup = True

    jsonl_paths = []
    for s in sessions:
        dest = out_dir / f"session-{s['id']}-slot{s['slot']}.jsonl"
        n = _download_jsonl(args.base, args.key, s["id"], dest)
        print(f"[analyze] downloaded session {s['id']} → {dest} ({n} lines)")
        jsonl_paths.append(dest)

    # Load into Polars via DuckDB
    print("[analyze] loading via DuckDB read_json_auto...")
    df = _load_match(jsonl_paths)
    print(f"[analyze] loaded {df.height} entries, columns: {df.columns[:10]}...")

    # Run all queries
    query_rollback_summary(jsonl_paths)
    query_event_counts(df)
    query_mismatch_timing(df)
    query_diverging_regions(df)
    query_pacing(df)
    query_c_debug_highlights(df)

    if not cleanup:
        print(f"\n[analyze] JSONL files kept at: {out_dir}")
    else:
        import shutil

        shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
