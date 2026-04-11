#!/usr/bin/env python3
"""Analyze a kaillera-next match — comprehensive diagnostics.

Downloads session logs for all peers via the admin export endpoint,
loads them with Polars (via DuckDB scan), and runs every diagnostic
query needed to debug desyncs, freezes, and performance issues.

Sections:
  1. Match metrics (precomputed summary)
  2. Rollback summary (per-peer stats from session meta)
  3. Event counts (log entry types by peer)
  4. Desync timeline (SSIM, hash agreement, mismatch timing, diverging regions)
  5. Performance timeline (frame timing, serialize skip rate, replay stats)
  6. Network health (ack lag trends, input lateness, DC events)
  7. Pacing analysis (throttle frequency, frame advantage distribution)
  8. Freeze detection (render stall, input dead, audio stall, zero-input runs)
  9. Rollback detail (failed rollbacks, misprediction breakdown, tolerance)
  10. C debug log highlights

Usage:
    python tools/analyze_match.py <match_id>
    python tools/analyze_match.py <match_id> --base PROD_URL --key PROD_KEY
    python tools/analyze_match.py <match_id> --keep   # keep downloaded files

Requires: pip install duckdb polars requests
"""

from __future__ import annotations

import argparse
import json
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


def _fetch_match_metrics(base: str, key: str, match_id: str) -> dict | None:
    try:
        r = requests.get(
            f"{base}/admin/api/matches/{match_id}",
            headers={"X-Admin-Key": key},
            verify=False,
            timeout=10,
        )
    except requests.RequestException:
        return None
    if r.status_code != 200:
        return None
    try:
        return r.json()
    except ValueError:
        return None


def _fetch_ssim(base: str, key: str, match_id: str) -> list[dict]:
    """Fetch SSIM comparison data from the screenshots endpoint."""
    try:
        r = requests.get(
            f"{base}/admin/api/screenshots/{match_id}/comparisons",
            headers={"X-Admin-Key": key},
            verify=False,
            timeout=10,
        )
        if r.status_code != 200:
            return []
        data = r.json()
        return data.get("comparisons", []) if isinstance(data, dict) else data
    except (requests.RequestException, ValueError):
        return []


def _fetch_client_events(base: str, key: str, sessions: list[dict]) -> list[dict]:
    """Fetch client_events from each session's detail endpoint.

    Client events (room_created, peer_joined, webrtc_connected, emulator_booted,
    game_started, game_ended, disconnect) are stored separately from log_data.
    They cover the full session lifecycle including server-side events.
    """
    all_events = []
    for s in sessions:
        try:
            r = requests.get(
                f"{base}/admin/api/session-logs/{s['id']}",
                headers={"X-Admin-Key": key},
                verify=False,
                timeout=10,
            )
            if r.status_code == 200:
                detail = r.json()
                for ev in detail.get("client_events", []):
                    ev["_session_slot"] = s.get("slot")
                    all_events.append(ev)
        except (requests.RequestException, ValueError):
            pass
    # Deduplicate by event id (both sessions may report the same server event)
    seen_ids = set()
    deduped = []
    for ev in all_events:
        eid = ev.get("id")
        if eid and eid in seen_ids:
            continue
        if eid:
            seen_ids.add(eid)
        deduped.append(ev)
    return sorted(deduped, key=lambda e: e.get("created_at", ""))


def _list_sessions_for_match(base: str, key: str, match_id: str) -> list[dict]:
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
        sessions = [e for e in data.get("entries", []) if e.get("match_id") == match_id]
    return sessions


def _list_sessions_for_room(base: str, key: str, room: str) -> list[dict]:
    """Find all sessions for a given room code. Returns the most recent match
    in that room (a single room may have multiple matches over time)."""
    r = requests.get(
        f"{base}/admin/api/session-logs?days=7&limit=200",
        headers={"X-Admin-Key": key},
        verify=False,
        timeout=10,
    )
    r.raise_for_status()
    data = r.json()
    room_sessions = [e for e in data.get("entries", []) if e.get("room") == room]
    if not room_sessions:
        return []
    # Pick the most recent match_id from this room
    room_sessions.sort(key=lambda e: e.get("updated_at", ""), reverse=True)
    latest_match = room_sessions[0].get("match_id")
    return [e for e in room_sessions if e.get("match_id") == latest_match]


def _download_jsonl(base: str, key: str, session_id: int, dest: Path) -> int:
    """Stream the JSONL export to a local file. Returns line count."""
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

    # Fallback: legacy detail endpoint → convert to JSONL
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
            log_data = json.loads(log_data)
        except json.JSONDecodeError:
            log_data = []
    summary = detail.get("summary") or {}
    if isinstance(summary, str):
        try:
            summary = json.loads(summary)
        except json.JSONDecodeError:
            summary = {}
    context_obj = detail.get("context") or {}
    if isinstance(context_obj, str):
        try:
            context_obj = json.loads(context_obj)
        except json.JSONDecodeError:
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
        f.write((json.dumps(meta) + "\n").encode("utf-8"))
        line_count += 1
        for row_entry in log_data:
            if not isinstance(row_entry, dict):
                continue
            merged = {**per_line_meta, **row_entry}
            f.write((json.dumps(merged, separators=(",", ":")) + "\n").encode("utf-8"))
            line_count += 1
    return line_count


# ── Data loading ─────────────────────────────────────────────────────────────


def _load_match(jsonl_paths: list[Path]) -> pl.DataFrame:
    """Load all peer JSONL files into one Polars DataFrame via DuckDB."""
    con = duckdb.connect(":memory:")
    paths_str = ", ".join(f"'{p}'" for p in jsonl_paths)
    df = con.execute(
        f"""
        SELECT * FROM read_json_auto([{paths_str}],
            format='newline_delimited',
            union_by_name=true,
            ignore_errors=true)
        """
    ).pl()
    if "msg" in df.columns:
        df = df.filter(pl.col("msg").is_not_null())
    return df


def _print_section(title: str) -> None:
    print(f"\n{'=' * 70}\n{title}\n{'=' * 70}")


# ── 1. Match metrics ────────────────────────────────────────────────────────


def query_precomputed_metrics(base: str, key: str, match_id: str) -> None:
    _print_section("1. MATCH METRICS (precomputed)")
    m = _fetch_match_metrics(base, key, match_id)
    if not m:
        print("(match not rotated yet — sweeper runs every 60s; retry shortly)")
        return
    print(f"  match_id:    {m.get('match_id')}")
    print(f"  mode:        {m.get('mode')}  peers={m.get('peer_count')}  ended_by={m.get('ended_by')}")
    print(f"  frames:      {m.get('frames')}  duration={m.get('duration_sec')}s  entries={m.get('entry_count')}")
    print(
        f"  determinism: mismatches={m.get('mismatch_count')} "
        f"first_divergence={m.get('first_divergence_frame')} "
        f"last_clean={m.get('last_clean_frame')}"
    )
    rb_preds = m.get("predictions") or 0
    rb_correct = m.get("correct_predictions") or 0
    accuracy = f"{(rb_correct / rb_preds * 100):.1f}%" if rb_preds else "n/a"
    print(
        f"  rollback:    rollbacks={m.get('rollbacks')} predictions={rb_preds} "
        f"correct={rb_correct} ({accuracy}) max_depth={m.get('max_rollback_depth')} "
        f"failed={m.get('failed_rollbacks')} tol_hits={m.get('tolerance_hits')}"
    )
    print(f"  pacing:      throttle_events={m.get('pacing_throttle_count')}")
    pq = m.get("parquet_path")
    if pq:
        size = m.get("parquet_bytes") or 0
        print(f"  parquet:     {pq} ({size:,} bytes)")
    else:
        print("  parquet:     (not written)")
    print(f"  rotated_at:  {m.get('rotated_at')}")


# ── 2. Rollback summary ─────────────────────────────────────────────────────


def query_rollback_summary(meta_paths: list[Path]) -> None:
    _print_section("2. ROLLBACK SUMMARY (per peer)")
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
        context = meta.get("context", {}) or {}
        print(
            f"  slot={meta.get('slot')} player={meta.get('player_name')} "
            f"frames={summary.get('frames')} dur={summary.get('duration_sec')}s "
            f"ended={meta.get('ended_by')}"
        )
        print(f"    ua={context.get('ua', '?')[:60]}...")
        print(f"    mobile={context.get('mobile')} forkedCore={context.get('forkedCore')} transport={context.get('rbTransport')}")
        for k in [
            "rollbacks", "predictions", "correctPredictions", "maxDepth",
            "failedRollbacks", "toleranceHits",
        ]:
            if k in rollback:
                print(f"    {k}: {rollback[k]}")
        breakdown = rollback.get("mispredBreakdown") or {}
        if breakdown:
            print(f"    mispredBreakdown: {breakdown}")
        rb_transport = summary.get("rbTransport") or {}
        if isinstance(rb_transport, dict) and rb_transport:
            print(f"    transport: mode={rb_transport.get('mode')} sent={rb_transport.get('packetsSent')} dupsRecv={rb_transport.get('dupsRecv')} dupRate={rb_transport.get('dupRate')}")


# ── 3. Event counts ─────────────────────────────────────────────────────────


def query_event_counts(df: pl.DataFrame) -> None:
    _print_section("3. EVENT COUNTS BY PEER")
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
        .head(50)
    )
    print(counts)


# ── 4. Desync timeline ──────────────────────────────────────────────────────


def query_desync_timeline(df: pl.DataFrame, base: str, key: str, match_id: str) -> None:
    _print_section("4. DESYNC TIMELINE")
    if "msg" not in df.columns or "f" not in df.columns:
        print("(missing msg/f columns)")
        return

    # 4a. SSIM progression (from screenshots API)
    ssim_data = _fetch_ssim(base, key, match_id)
    if ssim_data:
        print("  SSIM progression (visual similarity, 1.0 = identical):")
        desync_start = None
        for s in ssim_data:
            frame = s.get("frame", "?")
            ssim = s.get("ssim", 0)
            is_desync = s.get("is_desync", 0)
            marker = " << DESYNC" if is_desync else ""
            if is_desync and desync_start is None:
                desync_start = frame
            # Only show transitions and boundaries, not every entry
            print(f"    f={frame:>6}  ssim={ssim:.4f}{marker}")
        total_desync = sum(1 for s in ssim_data if s.get("is_desync"))
        print(f"  Summary: {total_desync}/{len(ssim_data)} frames desynced", end="")
        if desync_start is not None:
            print(f", first visual desync at f={desync_start}")
        else:
            print()
    else:
        print("  (no SSIM data — screenshots not captured or match not found)")

    # 4b. Mismatch timing (from hash comparison events)
    print()
    mismatches = df.filter(pl.col("msg").str.contains("MISMATCH"))
    if mismatches.height == 0:
        print("  Hash comparison: no MISMATCH events — hashes agreed across all peers.")
    else:
        by_slot = (
            mismatches.group_by("slot")
            .agg(count=pl.len(), first_frame=pl.col("f").min(), last_frame=pl.col("f").max())
            .sort("slot")
        )
        print("  Hash MISMATCH events per peer:")
        print(by_slot)
        last_good = (
            mismatches.with_columns(lastGood=pl.col("msg").str.extract(r"lastGood=(\d+)", 1).cast(pl.Int64))
            .filter(pl.col("lastGood").is_not_null())
            .group_by("slot")
            .agg(last_clean_frame=pl.col("lastGood").max())
        )
        if last_good.height:
            print("\n  Last clean frame per peer:")
            print(last_good)

    # 4c. RB-CHECK hash agreement (cross-peer rollback verification)
    print()
    rb_checks = df.filter(pl.col("msg").str.contains("RB-CHECK"))
    if rb_checks.height > 0:
        stale = rb_checks.filter(pl.col("msg").str.contains("STALE"))
        match_ok = rb_checks.filter(pl.col("msg").str.contains("MATCH"))
        mismatch_rb = rb_checks.filter(pl.col("msg").str.contains("MISMATCH"))
        print(f"  RB-CHECK: {rb_checks.height} total — {match_ok.height} MATCH, {mismatch_rb.height} MISMATCH, {stale.height} STALE")
        if mismatch_rb.height > 0:
            print("  First RB-CHECK mismatches:")
            for row in mismatch_rb.head(5).iter_rows(named=True):
                print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:150]}")

    # 4d. INPUT-DIFF (C vs JS input discrepancy)
    input_diffs = df.filter(pl.col("msg").str.contains("INPUT-DIFF"))
    if input_diffs.height > 0:
        print(f"\n  INPUT-DIFF events: {input_diffs.height}")
        for row in input_diffs.head(5).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:180]}")

    # 4e. Top diverging regions
    region_diffs = df.filter(
        pl.col("msg").str.contains("RB-REGION-DIFF") & pl.col("msg").str.contains("regions differ")
    )
    if region_diffs.height > 0:
        print(f"\n  Top diverging savestate regions ({region_diffs.height} RB-REGION-DIFF events):")
        region_hits: dict[int, int] = defaultdict(int)
        for m in region_diffs.get_column("msg").to_list():
            for ri in re.findall(r"r(\d+):", m):
                region_hits[int(ri)] += 1
        top = sorted(region_hits.items(), key=lambda kv: kv[1], reverse=True)[:15]
        for ri, n in top:
            print(f"    r{ri:>3}: {n} occurrences")


# ── 5. Performance timeline ─────────────────────────────────────────────────


def query_performance(df: pl.DataFrame) -> None:
    _print_section("5. PERFORMANCE TIMELINE")
    if "msg" not in df.columns:
        print("(missing msg column)")
        return

    # 5a. Frame timing from C-PERF entries
    cperf = df.filter(pl.col("msg").str.contains("C-PERF") & pl.col("msg").str.contains("preTick="))
    if cperf.height > 0:
        # Extract timing fields: preTick, step, total (in ms)
        timing = cperf.with_columns(
            preTick_ms=pl.col("msg").str.extract(r"preTick=([0-9.]+)ms", 1).cast(pl.Float64),
            step_ms=pl.col("msg").str.extract(r"step=([0-9.]+)ms", 1).cast(pl.Float64),
            total_ms=pl.col("msg").str.extract(r"total=([0-9.]+)ms", 1).cast(pl.Float64),
            serSkip=pl.col("msg").str.extract(r"serSkip=(\d+)", 1).cast(pl.Int64),
            rb_count=pl.col("msg").str.extract(r"rb=(\d+)", 1).cast(pl.Int64),
            pred_count=pl.col("msg").str.extract(r"pred=(\d+)", 1).cast(pl.Int64),
            correct_count=pl.col("msg").str.extract(r"correct=(\d+)", 1).cast(pl.Int64),
        ).filter(pl.col("step_ms").is_not_null())

        if timing.height > 0:
            print("  Frame timing distribution (from C-PERF, ms):")
            for slot_val in sorted(timing.get_column("slot").unique().to_list()):
                st = timing.filter(pl.col("slot") == slot_val)
                step = st.get_column("step_ms")
                print(f"    slot={slot_val}: step min={step.min():.1f} median={step.median():.1f} "
                      f"p95={step.quantile(0.95):.1f} max={step.max():.1f} (n={st.height})")

            # Serialize skip rate
            print("\n  Serialize skip rate:")
            for slot_val in sorted(timing.get_column("slot").unique().to_list()):
                st = timing.filter(pl.col("slot") == slot_val)
                skips = st.get_column("serSkip").to_list()
                frames = st.get_column("f").to_list()
                if len(skips) >= 2 and len(frames) >= 2:
                    total_skips = skips[-1] - skips[0] if skips[-1] is not None and skips[0] is not None else 0
                    total_frames = frames[-1] - frames[0] if frames[-1] is not None and frames[0] is not None else 1
                    rate = (total_skips / max(total_frames, 1)) * 100
                    print(f"    slot={slot_val}: {total_skips}/{total_frames} frames skipped ({rate:.1f}%)")

            # Slow frames (>10ms step time)
            slow = timing.filter(pl.col("step_ms") > 10)
            if slow.height > 0:
                print(f"\n  Slow frames (step > 10ms): {slow.height}")
                for row in slow.head(10).iter_rows(named=True):
                    print(f"    slot={row.get('slot')} f={row.get('f')} step={row.get('step_ms')}ms total={row.get('total_ms')}ms")
    else:
        print("  (no C-PERF entries)")

    # 5b. Replay events
    print()
    replay_starts = df.filter(pl.col("msg").str.contains("C-REPLAY start"))
    replay_dones = df.filter(pl.col("msg").str.contains("C-REPLAY done"))
    if replay_starts.height > 0:
        print(f"  Replay events: {replay_starts.height} starts, {replay_dones.height} dones")
        # Extract depth and duration
        replays = replay_starts.with_columns(
            depth=pl.col("msg").str.extract(r"depth=(\d+)", 1).cast(pl.Int64),
            took_ms=pl.col("msg").str.extract(r"took=([0-9.]+)ms", 1).cast(pl.Float64),
        )
        for slot_val in sorted(replays.get_column("slot").unique().to_list()):
            sr = replays.filter(pl.col("slot") == slot_val)
            depths = sr.get_column("depth").drop_nulls()
            times = sr.get_column("took_ms").drop_nulls()
            print(f"    slot={slot_val}: {sr.height} replays, depth range={depths.min()}-{depths.max()}, "
                  f"time min={times.min():.1f}ms max={times.max():.1f}ms")

        # Replay preempts
        preempts = df.filter(pl.col("msg").str.contains("C-REPLAY-PREEMPT"))
        if preempts.height > 0:
            print(f"    Replay preempts: {preempts.height}")
    else:
        print("  No replay events.")


# ── 6. Network health ───────────────────────────────────────────────────────


def query_network_health(df: pl.DataFrame) -> None:
    _print_section("6. NETWORK HEALTH")
    if "msg" not in df.columns:
        print("(missing msg column)")
        return

    # 6a. INPUT-ACK lag trends
    ack_entries = df.filter(pl.col("msg").str.contains("INPUT-ACK"))
    if ack_entries.height > 0:
        ack_lag = ack_entries.with_columns(
            lag=pl.col("msg").str.extract(r"lag=(\d+)", 1).cast(pl.Int64),
            confirmed=pl.col("msg").str.extract(r"confirmed=(-?\d+)", 1).cast(pl.Int64),
        ).filter(pl.col("lag").is_not_null())

        if ack_lag.height > 0:
            print("  Ack lag distribution (frames behind):")
            for slot_val in sorted(ack_lag.get_column("slot").unique().to_list()):
                sl = ack_lag.filter(pl.col("slot") == slot_val)
                lag = sl.get_column("lag")
                print(f"    slot={slot_val}: min={lag.min()} median={lag.median():.0f} "
                      f"p95={lag.quantile(0.95):.0f} max={lag.max()} (n={sl.height})")
            # High lag spikes (>10 frames)
            high_lag = ack_lag.filter(pl.col("lag") > 10)
            if high_lag.height > 0:
                print(f"\n  High ack lag spikes (>10 frames): {high_lag.height}")
                for row in high_lag.head(5).iter_rows(named=True):
                    print(f"    slot={row.get('slot')} f={row.get('f')} lag={row.get('lag')}")

    # 6b. INPUT-LATE events
    late_entries = df.filter(pl.col("msg").str.contains("INPUT-LATE"))
    if late_entries.height > 0:
        late_parsed = late_entries.with_columns(
            behind=pl.col("msg").str.extract(r"behind=(\d+)", 1).cast(pl.Int64),
        ).filter(pl.col("behind").is_not_null())
        print(f"\n  INPUT-LATE events: {late_entries.height}")
        if late_parsed.height > 0:
            for slot_val in sorted(late_parsed.get_column("slot").unique().to_list()):
                sl = late_parsed.filter(pl.col("slot") == slot_val)
                behind = sl.get_column("behind")
                print(f"    slot={slot_val}: {sl.height} events, behind min={behind.min()} max={behind.max()} median={behind.median():.0f}")

    # 6c. INPUT-STALL events (rollback budget exhausted)
    stalls = df.filter(pl.col("msg").str.contains("RB-INPUT-STALL"))
    if stalls.height > 0:
        print(f"\n  RB-INPUT-STALL events: {stalls.height}")
        for slot_val in sorted(stalls.get_column("slot").unique().to_list()):
            sl = stalls.filter(pl.col("slot") == slot_val)
            print(f"    slot={slot_val}: {sl.height} stalls")
        # First few
        for row in stalls.head(3).iter_rows(named=True):
            print(f"    f={row.get('f')} {row['msg'][:150]}")

    # 6d. DC health events (fallback, rotation, buffer stale)
    dc_events = df.filter(
        pl.col("msg").str.contains("DC-FALLBACK")
        | pl.col("msg").str.contains("DC-ROTATE")
        | pl.col("msg").str.contains("DC-BUFFER-STALE")
        | pl.col("msg").str.contains("TRANSPORT-SWITCH")
    )
    if dc_events.height > 0:
        print(f"\n  DataChannel health events: {dc_events.height}")
        for row in dc_events.head(10).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:150]}")

    # 6e. WebRTC connection events
    webrtc = df.filter(
        pl.col("msg").str.contains("webrtc")
        | pl.col("msg").str.contains("PEER-RECOVERED")
        | pl.col("msg").str.contains("PEER-PHANTOM")
    )
    if webrtc.height > 0:
        print(f"\n  WebRTC/peer events: {webrtc.height}")
        for row in webrtc.head(10).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:150]}")

    if ack_entries.height == 0 and late_entries.height == 0:
        print("  (no network health data)")


# ── 7. Pacing analysis ──────────────────────────────────────────────────────


def query_pacing(df: pl.DataFrame) -> None:
    _print_section("7. PACING ANALYSIS")
    pacing_starts = df.filter(pl.col("msg").str.contains("PACING-THROTTLE start"))
    if pacing_starts.height == 0:
        print("  No pacing throttle events.")
        return

    # Count and percentage
    by_slot = pacing_starts.group_by("slot").len().sort("slot")
    total_frames = (
        df.filter(pl.col("f").is_not_null()).group_by("slot").agg(max_f=pl.col("f").max()).sort("slot")
    )
    joined = by_slot.join(total_frames, on="slot", how="left").with_columns(
        pct=(pl.col("len") / pl.col("max_f") * 100).round(1)
    )
    print("  Throttle frequency:")
    print(joined)

    # Frame advantage distribution
    pacing_parsed = pacing_starts.with_columns(
        fAdv=pl.col("msg").str.extract(r"fAdv=(\d+)", 1).cast(pl.Int64),
        smooth=pl.col("msg").str.extract(r"smooth=([0-9.]+)", 1).cast(pl.Float64),
    ).filter(pl.col("fAdv").is_not_null())

    if pacing_parsed.height > 0:
        print("\n  Frame advantage when throttled:")
        for slot_val in sorted(pacing_parsed.get_column("slot").unique().to_list()):
            sp = pacing_parsed.filter(pl.col("slot") == slot_val)
            fadv = sp.get_column("fAdv")
            smooth = sp.get_column("smooth").drop_nulls()
            print(f"    slot={slot_val}: fAdv min={fadv.min()} median={fadv.median():.0f} max={fadv.max()} "
                  f"smooth min={smooth.min():.1f} max={smooth.max():.1f}")


# ── 8. Freeze detection ─────────────────────────────────────────────────────


def query_boot_deadlock(df: pl.DataFrame) -> None:
    """Detect BOOT-LOCKSTEP deadlock: frame counter stuck in boot phase
    (frame < 300) after a WebRTC peer disconnect, with emulation never
    resuming. Signature of this pattern:
      - Last BOOT-LOCKSTEP log is < 300
      - Followed by peer disconnect events
      - Frame counter has a long stuck period (many log entries, same f)
      - Session still has many log entries after the stuck point (wall
        time continues) but no frame advancement
    """
    _print_section("8a. BOOT-LOCKSTEP DEADLOCK DETECTION")
    if "msg" not in df.columns or "f" not in df.columns:
        print("(missing msg/f columns)")
        return

    # Recovery events (new mechanism — if these fire, deadlock was caught)
    recovery_events = df.filter(pl.col("msg").str.contains("BOOT-DEADLOCK-RECOVERY"))
    if recovery_events.height > 0:
        print(f"  BOOT-DEADLOCK-RECOVERY fired: {recovery_events.height} events")
        for row in recovery_events.iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:200]}")
        print()

    found_deadlock = False
    slots = sorted(df.filter(pl.col("slot").is_not_null()).get_column("slot").unique().to_list())

    for slot_val in slots:
        slot_df = df.filter(pl.col("slot") == slot_val).sort("t", nulls_last=True)
        if slot_df.height == 0:
            continue

        # Find last BOOT-LOCKSTEP entry for this slot
        boot_entries = slot_df.filter(pl.col("msg").str.contains("BOOT-LOCKSTEP"))
        if boot_entries.height == 0:
            continue
        last_boot_f = boot_entries.get_column("f").max()
        if last_boot_f is None or last_boot_f >= 300:
            continue  # Not in boot phase or converged past it

        # Check if there are peer disconnects after boot phase
        disconnects = slot_df.filter(
            pl.col("msg").str.contains("connection-state: disconnected")
            | pl.col("msg").str.contains("DC died")
            | pl.col("msg").str.contains("disconnect grace expired")
        )
        if disconnects.height == 0:
            continue

        # Find the maximum frame this slot ever reached
        frames = slot_df.filter(pl.col("f").is_not_null()).get_column("f")
        if frames.len() == 0:
            continue
        max_frame = frames.max()
        if max_frame >= 300:
            continue  # Advanced past boot phase — not a boot deadlock

        # Count log entries at max_frame (stuck-frame run length)
        stuck_entries = slot_df.filter(pl.col("f") == max_frame)
        stuck_count = stuck_entries.height

        # Wall-time span of the stuck period (from first entry at max_frame to last)
        times = stuck_entries.get_column("t").drop_nulls()
        if times.len() >= 2:
            wall_span = times.max() - times.min()
        else:
            wall_span = 0

        # Deadlock criteria: stuck at boot frame with >10 subsequent log entries
        # and >5 seconds of wall time at that frame
        if stuck_count >= 10 and wall_span >= 5000:
            found_deadlock = True
            print(
                f"  DEADLOCK slot={slot_val}: stuck at f={max_frame} (boot phase, <300) "
                f"for {wall_span:.0f}ms across {stuck_count} log entries"
            )
            print(f"    Last BOOT-LOCKSTEP: f={boot_entries.get_column('f').max()}")
            print(f"    Disconnect events: {disconnects.height}")
            first_disc = disconnects.head(1)
            if first_disc.height > 0:
                row = first_disc.row(0, named=True)
                print(f"    First disconnect: f={row.get('f')} {row['msg'][:150]}")
            # Show what kept the slot busy while stuck
            stuck_event_types: dict[str, int] = defaultdict(int)
            for m in stuck_entries.get_column("msg").to_list():
                match = re.match(r"^(\[?[A-Z\-a-z]+\]?(?:\s+[A-Za-z\-]+)?)", m)
                if match:
                    stuck_event_types[match.group(1)] += 1
            top_activity = sorted(stuck_event_types.items(), key=lambda kv: kv[1], reverse=True)[:5]
            print(f"    Activity while stuck: {', '.join(f'{k}={v}' for k, v in top_activity)}")

    if not found_deadlock:
        print("  No BOOT-LOCKSTEP deadlock detected.")


def query_deadlock_audit_events(df: pl.DataFrame) -> None:
    """Detect the new recovery events introduced by the netplay
    deadlock audit (MF1-MF6). Every event here is a signal that
    a specific fix caught a real stall.

    See docs/superpowers/specs/2026-04-11-netplay-deadlock-audit.md.
    """
    _print_section("8d. DEADLOCK AUDIT RECOVERY EVENTS")
    if "msg" not in df.columns:
        print("(missing msg column)")
        return

    # (event_name, human_label, spec_section) — order matters for readability
    events = [
        ("PEER-RESET", "MF1 resetPeerState", "§MF1"),
        ("RB-INIT-TIMEOUT", "MF2 _rbPendingInit fallback", "§MF2"),
        ("COORD-SYNC-TIMEOUT", "MF3 coord-sync deadline", "§MF3"),
        ("INPUT-STALL-RESYNC", "MF4 input-stall resync", "§MF4"),
        ("LATE-JOIN-TIMEOUT", "MF5 late-join deadline", "§MF5"),
        ("WORKER-STALL", "MF5 worker timeout", "§MF5"),
        ("TICK-STUCK", "MF6 tick watchdog", "§MF6"),
        ("VERSION-MISMATCH", "cache-bust version guard", "version-guard.js"),
    ]

    any_fired = False
    for event_name, label, section in events:
        matches = df.filter(pl.col("msg").str.contains(event_name))
        if matches.height == 0:
            continue
        any_fired = True
        # TICK-STUCK has warn/error severity — break out separately
        if event_name == "TICK-STUCK":
            warn = matches.filter(pl.col("msg").str.contains("severity=warn"))
            err = matches.filter(pl.col("msg").str.contains("severity=error"))
            print(f"  {event_name} ({label} {section}): warn={warn.height} error={err.height}")
            # For error-level events, extract inferred cause to surface root-cause clustering
            if err.height > 0:
                causes: dict[str, int] = defaultdict(int)
                for row in err.iter_rows(named=True):
                    m = re.search(r"cause=([a-z0-9\-_]+)", row.get("msg", "") or "")
                    if m:
                        causes[m.group(1)] += 1
                if causes:
                    top = sorted(causes.items(), key=lambda kv: kv[1], reverse=True)
                    print(f"    cause breakdown: {', '.join(f'{k}={v}' for k, v in top)}")
            # Show first 3 of each severity
            for row in err.head(3).iter_rows(named=True):
                print(f"    ERROR slot={row.get('slot')} f={row.get('f')} {row['msg'][:200]}")
            for row in warn.head(3).iter_rows(named=True):
                print(f"    warn  slot={row.get('slot')} f={row.get('f')} {row['msg'][:200]}")
            continue

        print(f"  {event_name} ({label} {section}): {matches.height} events")

        # For PEER-RESET, group by reason so we can see disconnect-path attribution
        if event_name == "PEER-RESET":
            reasons: dict[str, int] = defaultdict(int)
            for row in matches.iter_rows(named=True):
                m = re.search(r"reason=(\S+)", row.get("msg", "") or "")
                if m:
                    reasons[m.group(1)] += 1
            if reasons:
                top = sorted(reasons.items(), key=lambda kv: kv[1], reverse=True)
                print(f"    reason breakdown: {', '.join(f'{k}={v}' for k, v in top)}")
            # First few events inline
            for row in matches.head(3).iter_rows(named=True):
                print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:200]}")
            continue

        # VERSION-MISMATCH: serious signal — client was running stale JS.
        # Always surface every event and mark the session as suspect because
        # any analysis assumptions may be wrong if code was old.
        if event_name == "VERSION-MISMATCH":
            print("    !! STALE CLIENT CODE DETECTED — slot(s) below were running")
            print("    !! an older netplay-lockstep.js than the server was shipping.")
            print("    !! Any desync/freeze analysis for this match is suspect;")
            print("    !! cross-reference page/server tags before drawing conclusions.")
            pages: dict[str, int] = defaultdict(int)
            servers: dict[str, int] = defaultdict(int)
            actions: dict[str, int] = defaultdict(int)
            for row in matches.iter_rows(named=True):
                msg = row.get("msg", "") or ""
                pm = re.search(r"page=(\S+)", msg)
                sm = re.search(r"server=(\S+)", msg)
                am = re.search(r"action=(\S+)", msg)
                if pm:
                    pages[pm.group(1)] += 1
                if sm:
                    servers[sm.group(1)] += 1
                if am:
                    actions[am.group(1)] += 1
            if pages:
                print(f"    page versions seen: {dict(pages)}")
            if servers:
                print(f"    server versions seen: {dict(servers)}")
            if actions:
                print(f"    actions: {dict(actions)}")
            for row in matches.head(5).iter_rows(named=True):
                print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:240]}")
            continue

        # Default: show the first 3 events with full msg
        for row in matches.head(3).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:200]}")

    if not any_fired:
        print("  No deadlock audit recovery events — either clean session or fixes not triggered.")


def query_freeze_detection(df: pl.DataFrame) -> None:
    _print_section("8. FREEZE DETECTION")
    if "msg" not in df.columns:
        print("(missing msg column)")
        return

    found_any = False
    slots = sorted(df.filter(pl.col("slot").is_not_null()).get_column("slot").unique().to_list())

    # Audio death — extended audio-empty or audio-silent runs
    audio_empty = df.filter(pl.col("msg").str.contains("audio-empty f="))
    audio_silent = df.filter(pl.col("msg").str.contains("audio-silent:"))
    if audio_empty.height >= 10 or audio_silent.height > 0:
        found_any = True
        print(f"  AUDIO-DEATH: {audio_empty.height} audio-empty + {audio_silent.height} audio-silent events")
        if audio_silent.height > 0:
            for row in audio_silent.head(3).iter_rows(named=True):
                print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:200]}")
        if audio_empty.height >= 10:
            first_empty = audio_empty.head(1).row(0, named=True)
            last_empty = audio_empty.tail(1).row(0, named=True)
            print(f"    audio-empty range: f={first_empty.get('f')} -> f={last_empty.get('f')} on slot={first_empty.get('slot')}")

    # Rollback restore corruption — RB-POST-RB gp hash differs from C-REPLAY done gp
    replay_done = df.filter(pl.col("msg").str.contains("C-REPLAY done:"))
    post_rb = df.filter(pl.col("msg").str.contains("RB-POST-RB"))
    if replay_done.height > 0 and post_rb.height > 0:
        # Extract gp= hash from both, pair them by adjacency in time per slot
        replay_done_parsed = replay_done.with_columns(
            replay_gp=pl.col("msg").str.extract(r"gp=(0x[-0-9a-f]+)", 1),
            replay_f=pl.col("msg").str.extract(r"caught up at f=(\d+)", 1).cast(pl.Int64),
        )
        post_rb_parsed = post_rb.with_columns(
            post_gp=pl.col("msg").str.extract(r"gp=(0x[-0-9a-f]+)", 1),
            post_f=pl.col("msg").str.extract(r"RB-POST-RB f=(\d+)", 1).cast(pl.Int64),
        )
        # For each slot, pair replay_done[N] with post_rb[N] and compare
        corruptions = []
        for slot_val in slots:
            rd = replay_done_parsed.filter(pl.col("slot") == slot_val).sort("t")
            pr = post_rb_parsed.filter(pl.col("slot") == slot_val).sort("t")
            rd_rows = list(rd.iter_rows(named=True))
            pr_rows = list(pr.iter_rows(named=True))
            n = min(len(rd_rows), len(pr_rows))
            for i in range(n):
                if rd_rows[i].get("replay_gp") and pr_rows[i].get("post_gp"):
                    if rd_rows[i]["replay_gp"] != pr_rows[i]["post_gp"]:
                        corruptions.append({
                            "slot": slot_val,
                            "replay_f": rd_rows[i].get("replay_f"),
                            "post_f": pr_rows[i].get("post_f"),
                            "replay_gp": rd_rows[i]["replay_gp"],
                            "post_gp": pr_rows[i]["post_gp"],
                        })
        if corruptions:
            found_any = True
            print(f"  ROLLBACK-RESTORE-CORRUPTION: {len(corruptions)} events (replay gp != post-restore gp)")
            for c in corruptions[:10]:
                print(f"    slot={c['slot']} f={c['replay_f']} replay_gp={c['replay_gp']} post_gp={c['post_gp']}")

    # Explicit freeze signals
    for event_name in ["RENDER-STALL", "INPUT-DEAD", "AUDIO-STALL", "AUDIO-RESUME", "TAB-FOCUS"]:
        events = df.filter(pl.col("msg").str.contains(event_name))
        if events.height > 0:
            found_any = True
            print(f"  {event_name} events: {events.height}")
            for row in events.iter_rows(named=True):
                print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:200]}")

    # Heuristic: extended zero-input periods from NORMAL-INPUT logs
    normal_inputs = df.filter(pl.col("msg").str.contains("NORMAL-INPUT"))
    if normal_inputs.height > 0:
        for slot_val in slots:
            slot_inputs = normal_inputs.filter(pl.col("slot") == slot_val)
            if slot_inputs.height == 0:
                continue
            zero_count = 0
            max_zero_run = 0
            zero_start = None
            worst_start = None
            worst_end = None
            for row in slot_inputs.iter_rows(named=True):
                msg = row.get("msg", "")
                f = row.get("f", 0)
                marker = f"s{slot_val}["
                if marker in msg:
                    idx = msg.index(marker) + len(marker)
                    segment = msg[idx: msg.index("]", idx)]
                    if segment == "0,0,0":
                        if zero_count == 0:
                            zero_start = f
                        zero_count += 1
                    else:
                        if zero_count > max_zero_run:
                            max_zero_run = zero_count
                            worst_start = zero_start
                            worst_end = f
                        zero_count = 0
            if zero_count > max_zero_run:
                max_zero_run = zero_count
                worst_start = zero_start
                worst_end = slot_inputs.get_column("f").to_list()[-1]
            if max_zero_run >= 5:  # 5 * 60f = 300+ frames
                found_any = True
                print(
                    f"  ZERO-INPUT-RUN slot={slot_val}: {max_zero_run} consecutive "
                    f"zero-input logs (~{max_zero_run * 60}f) from f={worst_start} to f={worst_end}"
                )

    if not found_any:
        print("  No freeze signals detected.")


# ── 8b. Session lifecycle (server + client events) ──────────────────────────


def query_session_lifecycle(client_events: list[dict]) -> None:
    _print_section("8b. SESSION LIFECYCLE")
    if not client_events:
        print("  (no client events)")
        return

    print("  Chronological event timeline:")
    for ev in client_events:
        etype = ev.get("type", "?")
        slot = ev.get("slot", ev.get("_session_slot", "?"))
        created = ev.get("created_at", "?")
        msg = ev.get("message", "")
        meta = ev.get("meta", {}) or {}

        # Format meta compactly — only interesting fields
        meta_parts = []
        for mk in ["mode", "match_id", "slot", "remote_slot", "frames", "bytes",
                    "is_spectator", "playerId", "sid", "spectator"]:
            if mk in meta:
                val = meta[mk]
                if mk == "match_id" and isinstance(val, str) and len(val) > 8:
                    val = val[:8]
                meta_parts.append(f"{mk}={val}")
        meta_str = " " + " ".join(meta_parts) if meta_parts else ""

        print(f"    [{created}] slot={slot} {etype}{' — ' + msg if msg else ''}{meta_str}")

    # Summary: time from room creation to game start, game duration
    room_created = next((e for e in client_events if e["type"] == "room_created"), None)
    game_started = next((e for e in client_events if e["type"] == "server_game_started"), None)
    game_ended = next((e for e in client_events if e["type"] == "server_game_ended"), None)
    if room_created and game_started:
        print(f"\n  Lobby wait: {room_created['created_at']} -> {game_started['created_at']}")
    if game_started and game_ended:
        print(f"  Game duration: {game_started['created_at']} -> {game_ended['created_at']}")

    # Boot timing
    boots = [e for e in client_events if e["type"] == "emulator_booted"]
    if boots:
        for b in boots:
            meta = b.get("meta", {}) or {}
            print(f"  Boot: slot={b.get('slot')} frames={meta.get('frames')} at {b['created_at']}")


# ── 8c. Input analysis ──────────────────────────────────────────────────────


def query_input_analysis(df: pl.DataFrame) -> None:
    _print_section("8c. INPUT ANALYSIS")
    if "msg" not in df.columns:
        print("(missing msg column)")
        return

    normal_inputs = df.filter(pl.col("msg").str.contains("NORMAL-INPUT"))
    if normal_inputs.height == 0:
        print("  (no NORMAL-INPUT entries)")
        return

    slots = sorted(df.filter(pl.col("slot").is_not_null()).get_column("slot").unique().to_list())

    for slot_val in slots:
        slot_inputs = normal_inputs.filter(pl.col("slot") == slot_val)
        if slot_inputs.height == 0:
            continue

        # Parse input values for this slot's own controller
        marker = f"s{slot_val}["
        total = 0
        zero_count = 0
        button_frames = 0
        stick_frames = 0
        first_nonzero_f = None
        last_nonzero_f = None

        for row in slot_inputs.iter_rows(named=True):
            msg = row.get("msg", "")
            f = row.get("f", 0)
            if marker not in msg:
                continue
            total += 1
            idx = msg.index(marker) + len(marker)
            segment = msg[idx: msg.index("]", idx)]
            parts = segment.split(",")
            if len(parts) >= 3:
                buttons = int(parts[0])
                lx = int(parts[1])
                ly = int(parts[2])
                if buttons == 0 and lx == 0 and ly == 0:
                    zero_count += 1
                else:
                    if first_nonzero_f is None:
                        first_nonzero_f = f
                    last_nonzero_f = f
                    if buttons != 0:
                        button_frames += 1
                    if lx != 0 or ly != 0:
                        stick_frames += 1

        active = total - zero_count
        pct = (active / total * 100) if total > 0 else 0
        print(f"  slot={slot_val}: {total} input samples, {active} active ({pct:.0f}%), "
              f"{zero_count} zero ({100-pct:.0f}%)")
        print(f"    buttons active: {button_frames} samples, stick active: {stick_frames} samples")
        if first_nonzero_f is not None:
            print(f"    first input at f={first_nonzero_f}, last input at f={last_nonzero_f}")
        else:
            print(f"    !! NO INPUT EVER DETECTED — player may not have had focus/device")

    # INPUT-FIRST events (when each peer's input first arrived)
    input_firsts = df.filter(pl.col("msg").str.contains("INPUT-FIRST"))
    if input_firsts.height > 0:
        print(f"\n  First remote input received per peer:")
        for row in input_firsts.iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:150]}")


# ── 9. Rollback detail ──────────────────────────────────────────────────────


def query_rollback_detail(df: pl.DataFrame) -> None:
    _print_section("9. ROLLBACK DETAIL")
    if "msg" not in df.columns:
        print("(missing msg column)")
        return

    # 9a. Failed rollbacks (C-level detail)
    c_failed = df.filter(pl.col("msg").str.contains(r"\[C\] FAILED-ROLLBACK"))
    js_failed = df.filter(pl.col("msg").str.contains("FAILED-ROLLBACK detected"))
    if c_failed.height > 0 or js_failed.height > 0:
        print(f"  Failed rollbacks: {c_failed.height} C-level, {js_failed.height} JS-level detections")
        if c_failed.height > 0:
            # Parse depth and reason
            stale_ring = c_failed.filter(pl.col("msg").str.contains("stale"))
            exceeds_max = c_failed.filter(pl.col("msg").str.contains("exceeds max"))
            print(f"    Breakdown: {stale_ring.height} stale ring, {exceeds_max.height} exceeds max")
            print("    All C-level FAILED-ROLLBACK entries:")
            for row in c_failed.iter_rows(named=True):
                print(f"      slot={row.get('slot')} f={row.get('f')} {row['msg'][:200]}")
    else:
        print("  No failed rollbacks.")

    # 9b. Misprediction detail (from [C] MISPREDICTION)
    c_mispred = df.filter(pl.col("msg").str.contains(r"\[C\] MISPREDICTION"))
    if c_mispred.height > 0:
        print(f"\n  Mispredictions: {c_mispred.height} total")
        parsed = c_mispred.with_columns(
            depth=pl.col("msg").str.extract(r"depth=(\d+)", 1).cast(pl.Int64),
            btn_xor=pl.col("msg").str.extract(r"btn_xor=(0x[0-9a-f]+)", 1),
        )
        depths = parsed.get_column("depth").drop_nulls()
        if depths.len() > 0:
            print(f"    Depth range: {depths.min()}-{depths.max()}")
        btn_mismatches = parsed.filter(pl.col("btn_xor").is_not_null() & (pl.col("btn_xor") != "0x0"))
        stick_only = parsed.filter(pl.col("btn_xor") == "0x0")
        print(f"    Button mispredictions: {btn_mismatches.height}, stick-only: {stick_only.height}")
        print("    First entries:")
        for row in c_mispred.head(5).iter_rows(named=True):
            print(f"      f={row.get('f')} {row['msg'][:200]}")

    # 9c. Tolerance hits
    c_tolerance = df.filter(pl.col("msg").str.contains("TOLERANCE-HIT"))
    if c_tolerance.height > 0:
        print(f"\n  Tolerance hits (rollbacks avoided by zone match): {c_tolerance.height}")
        for row in c_tolerance.head(3).iter_rows(named=True):
            print(f"    f={row.get('f')} {row['msg'][:200]}")

    # 9d. DEEP-MISPREDICT-SKIP
    deep_skip = df.filter(pl.col("msg").str.contains("DEEP-MISPREDICT-SKIP"))
    if deep_skip.height > 0:
        print(f"\n  Deep misprediction skips (beyond visible cap): {deep_skip.height}")
        for row in deep_skip.head(5).iter_rows(named=True):
            print(f"    f={row.get('f')} {row['msg'][:200]}")


# ── 10. C debug log highlights ──────────────────────────────────────────────


def query_c_debug_highlights(df: pl.DataFrame) -> None:
    _print_section("10. C DEBUG LOG HIGHLIGHTS")
    if "msg" not in df.columns:
        return
    c_entries = df.filter(pl.col("msg").str.starts_with("[C]"))
    if c_entries.height == 0:
        print("(no [C] entries)")
        return
    print(f"Total [C] entries: {c_entries.height}\n")
    types: dict[str, int] = defaultdict(int)
    for m in c_entries.get_column("msg").to_list():
        match = re.match(r"\[C\]\s+([A-Z\-]+)", m)
        if match:
            types[match.group(1)] += 1
    for t, n in sorted(types.items(), key=lambda kv: kv[1], reverse=True):
        print(f"  {t}: {n}")


# ── Entry point ──────────────────────────────────────────────────────────────


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("target", nargs="?", help="Match ID prefix (8+ chars), full UUID, or room code (use --room)")
    p.add_argument("--room", action="store_true", help="Target is a room code instead of a match_id")
    p.add_argument("--base", default="https://localhost:27888", help="Server base URL")
    p.add_argument("--key", default=os.environ.get("KN_ADMIN_KEY", "1234"), help="Admin key")
    p.add_argument(
        "--keep",
        action="store_true",
        help="Keep downloaded JSONL files instead of using a tmpdir",
    )
    args = p.parse_args()

    if not args.target:
        print("Error: provide a match_id prefix or --room <code>", file=sys.stderr)
        sys.exit(2)

    if args.room:
        print(f"[analyze] looking up sessions for room {args.target} on {args.base}")
        sessions = _list_sessions_for_room(args.base, args.key, args.target)
        if not sessions:
            print(f"No session_logs found for room {args.target}", file=sys.stderr)
            sys.exit(2)
        args.match_id = sessions[0].get("match_id", "")
        print(f"[analyze] resolved to match {args.match_id[:8]}")
    else:
        args.match_id = args.target
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
        print(f"[analyze] downloaded session {s['id']} -> {dest} ({n} lines)")
        jsonl_paths.append(dest)

    # Fetch client events (server-side lifecycle events)
    print("[analyze] fetching client events...")
    client_events = _fetch_client_events(args.base, args.key, sessions)
    print(f"[analyze] fetched {len(client_events)} client events")

    # Load into Polars via DuckDB
    print("[analyze] loading via DuckDB read_json_auto...")
    df = _load_match(jsonl_paths)
    print(f"[analyze] loaded {df.height} entries, columns: {df.columns[:10]}...")

    # Resolve full match_id from sessions (user may pass prefix)
    full_match_id = sessions[0].get("match_id", args.match_id)

    # Run all queries
    query_precomputed_metrics(args.base, args.key, args.match_id)
    query_rollback_summary(jsonl_paths)
    query_event_counts(df)
    query_desync_timeline(df, args.base, args.key, full_match_id)
    query_performance(df)
    query_network_health(df)
    query_pacing(df)
    query_boot_deadlock(df)
    query_deadlock_audit_events(df)
    query_freeze_detection(df)
    query_session_lifecycle(client_events)
    query_input_analysis(df)
    query_rollback_detail(df)
    query_c_debug_highlights(df)

    if not cleanup:
        print(f"\n[analyze] JSONL files kept at: {out_dir}")
    else:
        import shutil

        shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
