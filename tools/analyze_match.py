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
  8f. Boot funnel analysis (pre-gameplay failure classification)
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


_ssim_cache: dict[str, list[dict]] = {}

def _fetch_ssim(base: str, key: str, match_id: str) -> list[dict]:
    """Fetch SSIM comparison data from the screenshots endpoint. Cached."""
    if match_id in _ssim_cache:
        return _ssim_cache[match_id]
    import time
    for attempt in range(3):
        try:
            r = requests.get(
                f"{base}/admin/api/screenshots/{match_id}/comparisons",
                headers={"X-Admin-Key": key},
                verify=False,
                timeout=10,
            )
            if r.status_code == 429:
                time.sleep(1)
                continue
            if r.status_code != 200:
                _ssim_cache[match_id] = []
                return []
            data = r.json()
            result = data.get("comparisons", []) if isinstance(data, dict) else data
            _ssim_cache[match_id] = result
            return result
        except (requests.RequestException, ValueError):
            _ssim_cache[match_id] = []
            return []
    _ssim_cache[match_id] = []
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
    first_visual_desync_frame: int | None = None
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
                try:
                    first_visual_desync_frame = int(frame)
                except (ValueError, TypeError):
                    pass
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
        # 4b-bis. Visual-only desync detection. SSIM drops while gameplay/
        # RDRAM hashes agree indicates a RENDERING divergence (GPU/GL
        # path, screenshot capture timing, cursor offset, etc.) rather
        # than a logical desync. These are a distinct bug class from the
        # network-state deadlocks MF1-MF6 target. Per
        # `feedback_visual_over_rdram.md` the visual output is still
        # ground truth — a visual-only desync still needs fixing, but
        # the root cause is in rendering, not state sync.
        if first_visual_desync_frame is not None:
            phase = (
                "intro/splash"
                if first_visual_desync_frame < 200
                else "character-select"
                if first_visual_desync_frame < 900
                else "mid-match"
                if first_visual_desync_frame < 3000
                else "late-match"
            )
            print(
                f"  !! VISUAL-ONLY DESYNC detected: SSIM divergence at f={first_visual_desync_frame} "
                f"({phase} phase) while gameplay hashes agree."
            )
            print("     This is a RENDERING divergence, not a state-sync bug.")
            print("     Likely causes: GL framebuffer readback, GPU driver differences,")
            print("     screenshot capture timing skew, CSS cursor offset. Fix belongs")
            print("     in the rendering pipeline, not the netplay layer.")
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

    # PACING-SAFETY-FREEZE is a harder escalation than PACING-THROTTLE —
    # it fires when fAdv exceeds rbMax (rollback budget exhausted), at
    # which point the engine skips frame advance entirely. A cluster of
    # these preceding a TICK-STUCK is the signature of a pacing cascade
    # triggered by tab-focus loss, CPU starvation, or a peer running
    # slow. We call it out distinctly because it's both a symptom
    # worth knowing about and a common trigger for downstream problems.
    safety_freeze = df.filter(pl.col("msg").str.contains("PACING-SAFETY-FREEZE"))
    if safety_freeze.height > 0:
        print(f"\n  PACING-SAFETY-FREEZE events: {safety_freeze.height} (rollback budget exhausted)")
        for slot_val in sorted(
            safety_freeze.filter(pl.col("slot").is_not_null()).get_column("slot").unique().to_list()
        ):
            ss = safety_freeze.filter(pl.col("slot") == slot_val)
            first = ss.head(1).row(0, named=True)
            last = ss.tail(1).row(0, named=True)
            print(
                f"    slot={slot_val}: {ss.height} events, first f={first.get('f')} "
                f"last f={last.get('f')}"
            )
        # Show the first event inline so the reader sees the fAdv/rbMax context
        first_row = safety_freeze.head(1).row(0, named=True)
        print(f"    example: slot={first_row.get('slot')} f={first_row.get('f')} {first_row['msg'][:220]}")


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
            # Cause breakdown across BOTH severities (warn is enough to
            # diagnose — no need to wait for error).
            causes: dict[str, int] = defaultdict(int)
            for row in matches.iter_rows(named=True):
                m = re.search(r"cause=([a-z0-9\-_]+)", row.get("msg", "") or "")
                if m:
                    causes[m.group(1)] += 1
            if causes:
                top = sorted(causes.items(), key=lambda kv: kv[1], reverse=True)
                print(f"    cause breakdown: {', '.join(f'{k}={v}' for k, v in top)}")

            # TAB-FOCUS correlation: if a TAB-FOCUS event (lost/gained)
            # occurred within ±2 seconds of any TICK-STUCK, surface
            # that explicitly. Browser tab-switching is a common
            # pacing-throttle trigger (emulator ticks freeze when the
            # tab is hidden, then try to catch up when focused).
            tab_focus = df.filter(pl.col("msg").str.contains("TAB-FOCUS"))
            if tab_focus.height > 0 and "t" in matches.columns:
                correlated = 0
                for row in matches.iter_rows(named=True):
                    t = row.get("t")
                    slot = row.get("slot")
                    if t is None:
                        continue
                    nearby = tab_focus.filter(
                        (pl.col("slot") == slot)
                        & (pl.col("t") >= t - 2000)
                        & (pl.col("t") <= t + 2000)
                    )
                    if nearby.height > 0:
                        correlated += 1
                if correlated > 0:
                    print(
                        f"    !! TAB-FOCUS correlation: {correlated}/{matches.height} TICK-STUCK events "
                        f"had a TAB-FOCUS event within ±2s on the same slot."
                    )
                    print(
                        "       Tab-switching freezes the browser rAF and Emscripten"
                    )
                    print(
                        "       timers, which causes the pacing-throttle cascade. The"
                    )
                    print(
                        "       stall is legitimate (not a bug) but the watchdog will"
                    )
                    print(
                        "       still fire. Consider excluding tab-hidden periods"
                    )
                    print(
                        "       from TICK-STUCK thresholds if this is noisy in prod."
                    )

            # Show first 3 of each severity
            for row in err.head(3).iter_rows(named=True):
                print(f"    ERROR slot={row.get('slot')} f={row.get('f')} {row['msg'][:240]}")
            for row in warn.head(3).iter_rows(named=True):
                print(f"    warn  slot={row.get('slot')} f={row.get('f')} {row['msg'][:240]}")
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


def query_freeze_detection(df: pl.DataFrame, jsonl_dir: str = "") -> None:
    _print_section("8. FREEZE DETECTION")
    if "msg" not in df.columns:
        print("(missing msg column)")
        return

    found_any = False
    slots = sorted(df.filter(pl.col("slot").is_not_null()).get_column("slot").unique().to_list())

    # Audio death — extended audio-empty or audio-silent runs.
    # RF6 Part A: enriched with rollback-correlation fields (lastRb,
    # rbDelta, resetAudioCalls) and AudioContext/AudioWorklet state
    # (ctxState, workletPort) so the analyzer can infer whether a
    # cluster of audio-death events correlates with a recent rollback.
    audio_empty = df.filter(pl.col("msg").str.contains("audio-empty f="))
    audio_silent = df.filter(pl.col("msg").str.contains("audio-silent:"))
    if audio_empty.height >= 10 or audio_silent.height > 0:
        found_any = True
        print(
            f"  AUDIO-DEATH: {audio_empty.height} audio-empty + "
            f"{audio_silent.height} audio-silent events"
        )
        if audio_silent.height > 0:
            for row in audio_silent.head(3).iter_rows(named=True):
                print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:240]}")
        if audio_empty.height >= 10:
            audio_empty_parsed = audio_empty.with_columns(
                rb_delta=pl.col("msg").str.extract(r"rbDelta=(-?\d+)", 1).cast(pl.Int64),
                last_rb=pl.col("msg").str.extract(r"lastRb=(-?\d+)", 1).cast(pl.Int64),
                reset_calls=pl.col("msg").str.extract(r"resetAudioCalls=(\d+)", 1).cast(pl.Int64),
                ctx_state=pl.col("msg").str.extract(r"ctxState=(\w+)", 1),
                worklet_port=pl.col("msg").str.extract(r"workletPort=(\w+)", 1),
            )
            first_empty = audio_empty_parsed.head(1).row(0, named=True)
            last_empty = audio_empty_parsed.tail(1).row(0, named=True)
            print(
                f"    audio-empty range: f={first_empty.get('f')} -> "
                f"f={last_empty.get('f')} on slot={first_empty.get('slot')}"
            )
            rb_delta = first_empty.get("rb_delta")
            last_rb = first_empty.get("last_rb")
            reset_calls = first_empty.get("reset_calls")
            ctx_state = first_empty.get("ctx_state") or "unknown"
            worklet_port = first_empty.get("worklet_port") or "unknown"
            if last_rb is not None and last_rb >= 0 and rb_delta is not None and rb_delta >= 0:
                if rb_delta < 10:
                    correlation = "strong"
                elif rb_delta < 100:
                    correlation = "moderate"
                else:
                    correlation = "independent"
                print(
                    f"    rollback correlation: C-REPLAY done at f={last_rb} "
                    f"(Δ={rb_delta}f, {correlation})"
                )
                if correlation == "strong" and reset_calls is not None and reset_calls == 0:
                    print(
                        "    likely cause: rollback path missed audio reset "
                        "(resetAudioCalls=0)"
                    )
            else:
                print("    rollback correlation: no prior C-REPLAY done (independent)")
            print(f"    ctxState={ctx_state} workletPort={worklet_port}")

    # RF2/RF3: JS-side invariant violations
    # REPLAY-NORUN = stepOneFrame called with null runner during replay
    # RB-INVARIANT-VIOLATION = kn_pre_tick returned !=2 with replay_depth>0
    replay_norun = df.filter(pl.col("msg").str.contains("REPLAY-NORUN"))
    if replay_norun.height > 0:
        found_any = True
        print(
            f"  REPLAY-NORUN: {replay_norun.height} events "
            f"(R2 violation — stepOneFrame no-op during replay)"
        )
        for row in replay_norun.head(5).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:240]}")

    rb_invariant = df.filter(pl.col("msg").str.contains("RB-INVARIANT-VIOLATION"))
    if rb_invariant.height > 0:
        found_any = True
        print(
            f"  RB-INVARIANT-VIOLATION: {rb_invariant.height} events "
            f"(R5 violation — kn_pre_tick return-value inconsistent with replay_depth)"
        )
        for row in rb_invariant.head(5).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:240]}")

    # RF7: fatal stale-ring
    fatal_stale = df.filter(pl.col("msg").str.contains("FATAL-RING-STALE"))
    if fatal_stale.height > 0:
        found_any = True
        print(
            f"  FATAL-RING-STALE: {fatal_stale.height} events "
            f"(R3 violation — rollback targeted a frame no longer in the ring)"
        )
        for row in fatal_stale.head(5).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:240]}")

    # RF5: post-replay live-state drift
    live_mismatch = df.filter(pl.col("msg").str.contains("RB-LIVE-MISMATCH"))
    if live_mismatch.height > 0:
        found_any = True
        print(
            f"  RB-LIVE-MISMATCH: {live_mismatch.height} events "
            f"(R4 violation — live state after replay differs from ring)"
        )
        for row in live_mismatch.head(5).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:240]}")

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
            zero_gp = sum(1 for c in corruptions if c["replay_gp"] == "0x0")
            if zero_gp:
                print(f"    ({zero_gp} with replay_gp=0x0 — ring lookup failed, hash not computed)")
            for c in corruptions[:10]:
                print(f"    slot={c['slot']} f={c['replay_f']} replay_gp={c['replay_gp']} post_gp={c['post_gp']}")

    # C-REPLAY done detail: parse per-replay hash values
    c_replay_done = df.filter(pl.col("msg").str.contains("C-REPLAY done"))
    if c_replay_done.height > 0:
        found_any = True
        parsed = c_replay_done.with_columns(
            rp_f=pl.col("msg").str.extract(r"caught up at f=(\d+)", 1).cast(pl.Int64, strict=False),
            rp_gp=pl.col("msg").str.extract(r"gp=(0x[-0-9a-f]+)", 1),
            rp_game=pl.col("msg").str.extract(r"game=(0x[-0-9a-f]+)", 1),
            rp_full=pl.col("msg").str.extract(r"full=(0x[-0-9a-f]+)", 1),
            rp_taint=pl.col("msg").str.extract(r"taint=(\d+)", 1).cast(pl.Int64, strict=False),
        )
        total = parsed.height
        zero_gp = parsed.filter(pl.col("rp_gp") == "0x0").height
        zero_all = parsed.filter(
            (pl.col("rp_gp") == "0x0") & (pl.col("rp_game") == "0x0") & (pl.col("rp_full") == "0x0")
        ).height
        print(f"  C-REPLAY done detail: {total} replays, {zero_gp} with gp=0x0, {zero_all} with all-zero hashes")
        for row in parsed.head(5).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('rp_f')} gp={row.get('rp_gp')} "
                  f"game={row.get('rp_game')} full={row.get('rp_full')} taint={row.get('rp_taint')}")

    # REPLAY-REMAINING-FIXUP: defensive fixup events (should not fire if rollback is healthy)
    fixup_events = df.filter(pl.col("msg").str.contains("REPLAY-REMAINING-FIXUP"))
    if fixup_events.height > 0:
        found_any = True
        print(f"  REPLAY-REMAINING-FIXUP: {fixup_events.height} events (replay_remaining was corrupted after restore)")
        for row in fixup_events.head(5).iter_rows(named=True):
            print(f"    slot={row.get('slot')} f={row.get('f')} {row['msg'][:200]}")

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

    # ── Log truncation + viewport freeze detection ─────────────────────────
    # Compare max frame in the log vs summary-reported frames. A large gap
    # means the sync log buffer filled (usually with diagnostic dumps) and
    # the host kept ticking without logging. Combined with RENDER-STALL,
    # this is the signature of the "viewport freeze" bug: game runs internally
    # but canvas stops updating, diagnostics flood the log, and the user sees
    # a frozen screen.
    _print_section("8g. VIEWPORT FREEZE ANALYSIS")
    vf_found = False
    # Parse summary frames from JSONL meta lines directly (DuckDB flattens nested dicts unpredictably)
    import glob as _glob
    slot_summaries = {}
    for path in sorted(_glob.glob(f"{jsonl_dir}/session-*.jsonl")):
        try:
            with open(path) as _mf:
                first_line = json.loads(_mf.readline())
                if first_line.get("_kind") == "meta":
                    s = first_line.get("slot")
                    summary_frames = first_line.get("summary", {}).get("frames")
                    summary_dur = first_line.get("summary", {}).get("duration_sec")
                    if s is not None and summary_frames is not None:
                        slot_summaries[s] = (summary_frames, summary_dur)
        except Exception:
            continue

    for slot_val, (summary_frames, summary_dur) in slot_summaries.items():

            # Max frame in actual log entries for this slot
            # _kind is null for regular entries (only "meta" for session metadata)
            slot_entries = df.filter(
                (pl.col("slot") == slot_val) & (pl.col("_kind").is_null()) & pl.col("f").is_not_null()
            )
            if slot_entries.height == 0:
                continue
            max_logged_frame = slot_entries.get_column("f").max()
            missing = summary_frames - max_logged_frame

            if missing > 60:  # more than 1 second of unlogged frames
                vf_found = True
                # Calculate logged duration
                wall_times = slot_entries.filter(pl.col("t") > 10000).get_column("t")
                logged_dur = (wall_times.max() - wall_times.min()) / 1000 if wall_times.len() > 1 else 0
                print(
                    f"  !! LOG TRUNCATION slot={slot_val}: log ends at f={max_logged_frame} "
                    f"but summary reports {summary_frames} frames ({missing} unlogged frames)"
                )
                print(
                    f"     Logged duration: {logged_dur:.1f}s, "
                    f"summary duration: {summary_dur}s"
                )
                # Check if diagnostic dumps caused the truncation
                diag_dumps = slot_entries.filter(
                    pl.col("msg").str.contains("RB-REGION-BYTES|RB-SUBHASH-DIFF|RB-REGION-DIFF")
                )
                if diag_dumps.height > 50:
                    print(
                        f"     Cause: {diag_dumps.height} diagnostic dump entries "
                        f"filled the sync log buffer"
                    )

                # Check for RENDER-STALL preceding the truncation
                render_stalls = slot_entries.filter(
                    pl.col("msg").str.contains("RENDER-STALL")
                )
                if render_stalls.height > 0:
                    first_stall = render_stalls.head(1).row(0, named=True)
                    stall_f = first_stall.get("f", 0)
                    # Check for hash mismatches near the render stall
                    mismatches = slot_entries.filter(
                        pl.col("msg").str.contains("MISMATCH")
                    )
                    first_mm_f = None
                    if mismatches.height > 0:
                        first_mm_f = mismatches.get_column("f").min()

                    print(
                        f"\n  ** VIEWPORT FREEZE DETECTED (slot={slot_val}):"
                    )
                    print(
                        f"     RENDER-STALL at f={stall_f} (canvas stopped updating)"
                    )
                    if first_mm_f is not None:
                        print(
                            f"     First hash MISMATCH at f={first_mm_f} "
                            f"({'after' if first_mm_f > stall_f else 'before'} render stall)"
                        )
                    # Audio death
                    audio_dead = slot_entries.filter(pl.col("msg").str.contains("audio-empty"))
                    if audio_dead.height > 5:
                        first_audio = audio_dead.get_column("f").min()
                        print(
                            f"     Audio dead from f={first_audio} "
                            f"({audio_dead.height} audio-empty events)"
                        )
                    print(
                        f"     Game ticked to f={summary_frames} internally but "
                        f"UI was frozen from ~f={stall_f}"
                    )

    if not vf_found:
        print("  No viewport freeze detected.")


# ── 8b-pre. Boot funnel analysis ─────────────────────────────────────────────


def query_boot_funnel(df: pl.DataFrame, client_events: list[dict]) -> None:
    """Analyze the boot funnel: lobby → room → ROM → WebRTC → game → boot → input.

    Classifies sessions into boot-phase failure categories:
      PRE-GAMEPLAY-FAILURE  — emulator_booted event missing
      AUDIO-CONTEXT-BLOCKED — NotAllowedError or audio resume failed in first 120 frames
      INPUT-STARVED-AT-BOOT — 0% non-zero input + TAB-FOCUS lost in first 60 frames
      BOOT-TIMEOUT          — boot duration > 30s
      BOOT-SLOW             — boot duration > 10s
      PRE-MATCH-DISCONNECT  — ended_by=disconnect with frames < 200
      BOOT-OK               — none of the above
    """
    _print_section("8f. BOOT FUNNEL ANALYSIS")

    # ── 1. Boot timeline from client_events ─────────────────────────────
    FUNNEL_STAGES = [
        "room_created", "peer_joined", "rom_loaded",
        "webrtc_connected", "server_game_started",
        "first_frame_rendered", "emulator_booted",
    ]

    if not client_events:
        print("  (no client events — cannot build boot timeline)")
        print("\n  Boot classification: PRE-GAMEPLAY-FAILURE (no events)")
        return

    # Build timeline: first occurrence of each stage type
    stage_times: dict[str, str] = {}
    stage_slots: dict[str, list] = {}
    for ev in client_events:
        etype = ev.get("type", "")
        created = ev.get("created_at", "")
        slot = ev.get("slot", ev.get("_session_slot", "?"))
        if etype in FUNNEL_STAGES:
            if etype not in stage_times:
                stage_times[etype] = created
            stage_slots.setdefault(etype, []).append(slot)

    # Parse timestamps for delta calculation
    from datetime import datetime

    def _parse_ts(ts_str: str) -> datetime | None:
        for fmt in ("%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"):
            try:
                return datetime.strptime(ts_str.replace("Z", "").replace("+00:00", ""), fmt)
            except ValueError:
                continue
        return None

    base_ts = None
    print("  Boot timeline:")
    for stage in FUNNEL_STAGES:
        ts_str = stage_times.get(stage)
        if not ts_str:
            print(f"    {stage:25s} — MISSING")
            continue
        ts = _parse_ts(ts_str)
        if ts and base_ts is None:
            base_ts = ts
        delta = f"+{(ts - base_ts).total_seconds():.1f}s" if ts and base_ts else "?"
        slots_str = ",".join(str(s) for s in stage_slots.get(stage, []))
        print(f"    {stage:25s} → {delta:>8s}  (slot(s): {slots_str})")

    # ── 2. Boot duration ────────────────────────────────────────────────
    game_started_ts = _parse_ts(stage_times.get("server_game_started", ""))
    emu_booted_ts = _parse_ts(stage_times.get("emulator_booted", ""))

    boot_duration = None
    if game_started_ts and emu_booted_ts:
        boot_duration = (emu_booted_ts - game_started_ts).total_seconds()
        flag = ""
        if boot_duration > 30:
            flag = " [BOOT-TIMEOUT]"
        elif boot_duration > 10:
            flag = " [BOOT-SLOW]"
        print(f"\n  Boot duration: {boot_duration:.1f}s (game_started → emulator_booted){flag}")
    elif game_started_ts and not emu_booted_ts:
        print("\n  Boot duration: FAILED (emulator_booted event never fired)")
    else:
        print("\n  Boot duration: unknown (missing server_game_started)")

    # ── 3. Check inter-stage delays ─────────────────────────────────────
    prev_ts = None
    prev_stage = None
    for stage in FUNNEL_STAGES:
        ts_str = stage_times.get(stage)
        if not ts_str:
            continue
        ts = _parse_ts(ts_str)
        if ts and prev_ts:
            delta = (ts - prev_ts).total_seconds()
            if delta > 5:
                print(f"  SLOW-BOOT-STAGE: {prev_stage} → {stage} took {delta:.1f}s (> 5s)")
        prev_ts = ts
        prev_stage = stage

    # ── 4. AudioContext failures ────────────────────────────────────────
    classifications = []

    if "msg" in df.columns:
        boot_df = df
        if "f" in df.columns:
            boot_df = df.filter(pl.col("f") <= 120)

        audio_failures = boot_df.filter(
            pl.col("msg").str.contains("(?i)NotAllowedError|audio resume failed|audio-silent|AUDIO-DEATH")
        )
        if audio_failures.height > 0:
            classifications.append("AUDIO-CONTEXT-BLOCKED")
            print(f"\n  Audio issues during boot ({audio_failures.height} events):")
            for row in audio_failures.head(5).iter_rows(named=True):
                f_val = row.get("f", "?")
                slot = row.get("slot", "?")
                msg = str(row.get("msg", ""))[:120]
                print(f"    slot={slot} f={f_val} {msg}")

        # ── 5. Input starvation at boot ─────────────────────────────────
        tab_focus_lost = boot_df.filter(
            pl.col("msg").str.contains("TAB-FOCUS lost")
        )
        if "f" in df.columns:
            early_focus_lost = tab_focus_lost.filter(pl.col("f") <= 60)
        else:
            early_focus_lost = tab_focus_lost

        # Check for NORMAL-INPUT in first 200 frames
        if "f" in df.columns:
            early_inputs = df.filter(
                (pl.col("f") <= 200) & pl.col("msg").str.contains("NORMAL-INPUT")
            )
        else:
            early_inputs = df.filter(pl.col("msg").str.contains("NORMAL-INPUT")).head(10)

        # Parse for zero-only input
        has_nonzero_input = False
        slots_with_data = set()
        for row in early_inputs.iter_rows(named=True):
            msg = str(row.get("msg", ""))
            slot = row.get("slot", 0)
            slots_with_data.add(slot)
            # Check each slot's input: s0[buttons,lx,ly] — nonzero = active
            for m in re.finditer(r"s\d+\[(\d+),(-?\d+),(-?\d+)", msg):
                buttons, lx, ly = int(m.group(1)), int(m.group(2)), int(m.group(3))
                if buttons != 0 or lx != 0 or ly != 0:
                    has_nonzero_input = True
                    break
            if has_nonzero_input:
                break

        if not has_nonzero_input and early_focus_lost.height > 0:
            classifications.append("INPUT-STARVED-AT-BOOT")
            focus_frames = [str(r.get("f", "?")) for r in early_focus_lost.iter_rows(named=True)]
            print(f"\n  INPUT-STARVED-AT-BOOT: no non-zero input in first 200 frames")
            print(f"    TAB-FOCUS lost at frames: {', '.join(focus_frames[:5])}")

        # ── 6. Boot convergence stalls ──────────────────────────────────
        boot_lockstep_events = df.filter(
            pl.col("msg").str.contains("BOOT-LOCKSTEP|BOOT-DEADLOCK-RECOVERY")
        )
        if boot_lockstep_events.height > 0:
            print(f"\n  Boot convergence: {boot_lockstep_events.height} BOOT-LOCKSTEP events")
            recovery = boot_lockstep_events.filter(
                pl.col("msg").str.contains("BOOT-DEADLOCK-RECOVERY")
            )
            if recovery.height > 0:
                print(f"    BOOT-DEADLOCK-RECOVERY fired {recovery.height} time(s)")

    # ── 7. Pre-match disconnect classification ──────────────────────────
    # Check total frame count from the data
    max_frame = 0
    if "f" in df.columns:
        f_max = df.get_column("f").max()
        if f_max is not None:
            max_frame = int(f_max)

    ended_by_disconnect = any(
        ev.get("type") == "session-end" and "disconnect" in str(ev.get("message", "")).lower()
        for ev in client_events
    )
    # Also check from session meta
    if not ended_by_disconnect:
        ended_by_disconnect = any(
            ev.get("type") == "disconnect" for ev in client_events
        )

    if max_frame < 200 and ended_by_disconnect:
        classifications.append("PRE-MATCH-DISCONNECT")

    if boot_duration is not None:
        if boot_duration > 30:
            classifications.append("BOOT-TIMEOUT")
        elif boot_duration > 10:
            classifications.append("BOOT-SLOW")

    if not emu_booted_ts and game_started_ts:
        classifications.append("PRE-GAMEPLAY-FAILURE")

    if not classifications:
        classifications.append("BOOT-OK")

    # ── 8. Summary ──────────────────────────────────────────────────────
    print(f"\n  Boot classification: {', '.join(classifications)}")
    print(f"  Total frames: {max_frame}")

    # Root cause inference
    if len(classifications) > 1 or classifications[0] != "BOOT-OK":
        print("\n  Root cause inference:")
        if "INPUT-STARVED-AT-BOOT" in classifications and "AUDIO-CONTEXT-BLOCKED" in classifications:
            print("    Tab lost focus during boot → AudioContext blocked →")
            print("    gamepad input zeroed → boot convergence stalled →")
            if "PRE-MATCH-DISCONNECT" in classifications:
                print(f"    disconnected after {max_frame} frames with no gameplay.")
            else:
                print(f"    degraded boot ({max_frame} frames).")
        elif "PRE-GAMEPLAY-FAILURE" in classifications:
            missing = [s for s in FUNNEL_STAGES if s not in stage_times]
            if missing:
                print(f"    Boot funnel broke at: {missing[0]}")
                print(f"    Missing stages: {', '.join(missing)}")
            else:
                print("    Emulator failed to boot despite all funnel stages completing.")
        elif "BOOT-TIMEOUT" in classifications:
            print(f"    Boot took {boot_duration:.1f}s (expected <5s).")
            if "AUDIO-CONTEXT-BLOCKED" in classifications:
                print("    Likely cause: AudioContext suspension stalled emulator boot.")
        elif "BOOT-SLOW" in classifications:
            print(f"    Boot took {boot_duration:.1f}s (expected <5s).")
        elif "PRE-MATCH-DISCONNECT" in classifications:
            print(f"    Session ended at {max_frame} frames — never reached gameplay.")


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


def query_tick_performance(jsonl_dir: str) -> None:
    """Per-peer FPS and tick timing from TICK-PERF entries."""
    _print_section("11a. TICK PERFORMANCE (per peer)")
    import glob as _glob

    for path in sorted(_glob.glob(f"{jsonl_dir}/session-*.jsonl")):
        try:
            with open(path) as f:
                first = json.loads(f.readline())
                slot = first.get("slot", "?")
                ua = (first.get("context") or {}).get("ua", "")
                mobile = (first.get("context") or {}).get("mobile", False)
                f.seek(0)
                fps_vals = []
                pump_fps_vals = []
                median_vals = []
                p95_vals = []
                for line in f:
                    d = json.loads(line)
                    msg = d.get("msg", "")
                    if "TICK-PERF" not in msg:
                        continue
                    m = re.search(
                        r"fps=([0-9.]+)(?:\s+pumpFps=([0-9.]+))?.*median=([0-9.]+).*p95=([0-9.]+)",
                        msg,
                    )
                    if m:
                        fps_vals.append(float(m.group(1)))
                        if m.group(2) is not None:
                            pump_fps_vals.append(float(m.group(2)))
                        median_vals.append(float(m.group(3)))
                        p95_vals.append(float(m.group(4)))
                if fps_vals:
                    avg_fps = sum(fps_vals) / len(fps_vals)
                    avg_pump_fps = (
                        sum(pump_fps_vals) / len(pump_fps_vals) if pump_fps_vals else None
                    )
                    avg_med = sum(median_vals) / len(median_vals)
                    avg_p95 = sum(p95_vals) / len(p95_vals)
                    device = "mobile" if mobile else "desktop"
                    pump_part = f" pumpFps={avg_pump_fps:.1f}" if avg_pump_fps is not None else ""
                    print(
                        f"  Slot {slot} ({device}): fps={avg_fps:.1f}{pump_part} "
                        f"tickMs median={avg_med:.1f} p95={avg_p95:.1f} ({len(fps_vals)} samples)"
                    )
                    if avg_fps < 55:
                        if avg_pump_fps is not None and avg_pump_fps >= 55:
                            print(
                                "    !! BELOW 60fps: frame advancement is slow but timer pump is healthy"
                                " — check pacing/stalls"
                            )
                            continue
                        # Check C-PERF total to see how much is code vs browser
                        f.seek(0)
                        totals = []
                        for line2 in f:
                            d2 = json.loads(line2)
                            msg2 = d2.get("msg", "")
                            if "C-PERF" in msg2:
                                m2 = re.search(r"total=([0-9.]+)ms", msg2)
                                if m2:
                                    totals.append(float(m2.group(1)))
                        if totals:
                            avg_total = sum(totals) / len(totals)
                            gap = avg_med - avg_total
                            print(f"    !! BELOW 60fps: tick={avg_med:.1f}ms but code={avg_total:.1f}ms → {gap:.1f}ms idle gap")
                            if gap > 5:
                                print(f"    Browser scheduling at {avg_fps:.0f}Hz — not a code performance issue")
                            else:
                                print(f"    Code is near budget — optimization may help")
        except Exception:
            continue


def query_gp_dump_comparison(jsonl_dir: str) -> None:
    """Compare GP-DUMP and GP-DRIFT values between peers."""
    _print_section("11b. GAMEPLAY ADDRESS COMPARISON")
    import glob as _glob

    dumps_by_slot: dict[int, list] = defaultdict(list)
    for path in sorted(_glob.glob(f"{jsonl_dir}/session-*.jsonl")):
        try:
            with open(path) as f:
                first = json.loads(f.readline())
                slot = first.get("slot", -1)
                f.seek(0)
                for line in f:
                    d = json.loads(line)
                    msg = d.get("msg", "")
                    fr = d.get("f", -1)
                    if msg.startswith("GP-DUMP") or msg.startswith("GP-DRIFT") or msg.startswith("GP-CSS"):
                        dumps_by_slot[slot].append((fr, msg))
        except Exception:
            continue

    if not dumps_by_slot:
        print("  No GP-DUMP or GP-DRIFT entries.")
        return

    for s in sorted(dumps_by_slot.keys()):
        entries = dumps_by_slot[s]
        print(f"  Slot {s}: {len(entries)} dumps")
        for fr, msg in entries[:5]:
            print(f"    f={fr:>6} {msg[:160]}")
        if len(entries) > 5:
            print(f"    ... +{len(entries) - 5} more")
    print()

    # Cross-peer comparison at same frame
    if len(dumps_by_slot) >= 2:
        slots = sorted(dumps_by_slot.keys())
        s0_by_frame = {fr: msg for fr, msg in dumps_by_slot[slots[0]]}
        s1_by_frame = {fr: msg for fr, msg in dumps_by_slot[slots[1]]}
        common_frames = sorted(set(s0_by_frame.keys()) & set(s1_by_frame.keys()))
        if common_frames:
            print(f"  Cross-peer comparison at {len(common_frames)} common frames:")
            for fr in common_frames[:5]:
                m0 = s0_by_frame[fr]
                m1 = s1_by_frame[fr]
                if m0 == m1:
                    print(f"    f={fr}: IDENTICAL")
                else:
                    # Find which fields differ
                    parts0 = {p.split("=")[0]: p.split("=", 1)[1] for p in m0.split() if "=" in p}
                    parts1 = {p.split("=")[0]: p.split("=", 1)[1] for p in m1.split() if "=" in p}
                    diffs = [k for k in parts0 if k in parts1 and parts0[k] != parts1[k]]
                    print(f"    f={fr}: {len(diffs)} fields differ: {', '.join(diffs[:8])}")


def query_desync_summary(jsonl_dir: str, base: str = "", key: str = "", match_id: str = "") -> None:
    """Quick-glance desync diagnosis: screen, stage, character, CSS state, SSIM per slot."""
    _print_section("11c. DESYNC SUMMARY (screen, stage, character, CSS, SSIM)")
    import glob as _glob

    # Extract key state per slot over time
    slot_data: dict[int, dict] = {}  # slot -> {gp_dumps, css_dumps}
    for path in sorted(_glob.glob(f"{jsonl_dir}/session-*.jsonl")):
        try:
            with open(path) as f:
                first = json.loads(f.readline())
                slot = first.get("slot", -1)
                f.seek(0)
                gp = []
                css = []
                ssim_entries = []
                for line in f:
                    d = json.loads(line)
                    msg = d.get("msg", "")
                    fr = d.get("f", -1)
                    if msg.startswith("GP-DUMP"):
                        gp.append((fr, msg))
                    elif msg.startswith("GP-CSS"):
                        css.append((fr, msg))
                    elif "SSIM" in msg or "visual_desync" in msg.lower():
                        ssim_entries.append((fr, msg))
                slot_data[slot] = {"gp": gp, "css": css, "ssim": ssim_entries}
        except Exception:
            continue

    if not slot_data:
        print("  No GP-DUMP data found.")
        return

    # Parse GP-DUMP fields
    def parse_gp(msg):
        fields = {}
        for part in msg.split():
            if "=" in part:
                k, v = part.split("=", 1)
                fields[k] = v
        return fields

    # Per-slot timeline
    for s in sorted(slot_data.keys()):
        gp = slot_data[s]["gp"]
        css = slot_data[s]["css"]
        print(f"\n  ── Slot {s} ──")

        # Screen + game_status transitions
        print(f"  Screen/game_status progression:")
        last_scr = None
        last_gs = None
        for fr, msg in gp:
            fields = parse_gp(msg)
            scr = fields.get("scr", "?")
            gs = fields.get("gs", "?")
            if scr != last_scr or gs != last_gs:
                print(f"    f={fr:>6}  scr={scr}  gs={gs}")
                last_scr = scr
                last_gs = gs

        # Stage ID from vs= field (byte 0 of first word)
        print(f"  Stage ID progression:")
        last_vs0 = None
        for fr, msg in gp:
            fields = parse_gp(msg)
            vs = fields.get("vs", "")
            vs0 = vs.split(",")[0] if vs else "?"
            if vs0 != last_vs0:
                # Stage byte is at offset +1 in VS settings — extract from first word
                try:
                    w = int(vs0, 16)
                    # VS settings at 0x0A4D08: stage_id is N64 byte +1 = LE bits 23-16
                    stage = (w >> 16) & 0xff
                    print(f"    f={fr:>6}  vs[0]=0x{vs0}  stage_id=0x{stage:02X} ({stage})")
                except ValueError:
                    print(f"    f={fr:>6}  vs[0]={vs0}")
                last_vs0 = vs0

        # Character ID from chr= field
        print(f"  Character IDs (in-game struct):")
        last_chr = None
        for fr, msg in gp:
            fields = parse_gp(msg)
            chr_val = fields.get("chr", "?")
            if chr_val != last_chr:
                print(f"    f={fr:>6}  chr={chr_val}")
                last_chr = chr_val

        # CSS state transitions (non-zero cid)
        css_transitions = []
        last_css_state = None
        for fr, msg in css:
            # Extract p1 and p2 cid values
            p1_cid = p2_cid = "?"
            for part in msg.split():
                if part.startswith("p1_css:"):
                    for kv in part[7:].split(","):
                        if kv.startswith("cid="):
                            p1_cid = kv[4:]
                elif part.startswith("p2_css:"):
                    for kv in part[7:].split(","):
                        if kv.startswith("cid="):
                            p2_cid = kv[4:]
            state_key = f"p1={p1_cid},p2={p2_cid}"
            if state_key != last_css_state:
                css_transitions.append((fr, state_key, msg))
                last_css_state = state_key
        if css_transitions:
            print(f"  CSS character selection timeline:")
            for fr, state_key, msg in css_transitions[:15]:
                # Extract p1/p2 full state
                parts = {}
                for token in msg.split():
                    if token.startswith("p1_css:") or token.startswith("p2_css:"):
                        label = token[:6]
                        kvs = token[7:]
                        parts[label] = kvs
                p1 = parts.get("p1_css", "?")
                p2 = parts.get("p2_css", "?")
                print(f"    f={fr:>6}  P1[{p1}]  P2[{p2}]")
            if len(css_transitions) > 15:
                print(f"    ... +{len(css_transitions) - 15} more transitions")

    # Cross-peer comparison at key moments
    if len(slot_data) >= 2:
        slots = sorted(slot_data.keys())
        print(f"\n  ── Cross-Peer Comparison ──")

        # Compare stage IDs
        for label, key in [("gp", "GP-DUMP")]:
            s0_gp = {fr: parse_gp(msg) for fr, msg in slot_data[slots[0]][label]}
            s1_gp = {fr: parse_gp(msg) for fr, msg in slot_data[slots[1]][label]}
            common = sorted(set(s0_gp.keys()) & set(s1_gp.keys()))
            if not common:
                continue

            # Find first frame where stage or chr differs
            stage_diff = None
            chr_diff = None
            scr_diff = None
            rng_diff = None
            for fr in common:
                f0, f1 = s0_gp[fr], s1_gp[fr]
                if f0.get("vs") != f1.get("vs") and stage_diff is None:
                    stage_diff = (fr, f0.get("vs", "?"), f1.get("vs", "?"))
                if f0.get("chr") != f1.get("chr") and chr_diff is None:
                    chr_diff = (fr, f0.get("chr", "?"), f1.get("chr", "?"))
                if f0.get("scr") != f1.get("scr") and scr_diff is None:
                    scr_diff = (fr, f0.get("scr", "?"), f1.get("scr", "?"))
                if f0.get("rng") != f1.get("rng") and rng_diff is None:
                    rng_diff = (fr, f0.get("rng", "?"), f1.get("rng", "?"))

            if scr_diff:
                fr, v0, v1 = scr_diff
                print(f"  SCREEN DIVERGE at f={fr}: slot{slots[0]}={v0} slot{slots[1]}={v1}")
            else:
                print(f"  Screen: IDENTICAL across {len(common)} common frames")

            if stage_diff:
                fr, v0, v1 = stage_diff
                # Parse stage byte from vs[0]
                try:
                    s0_stage = (int(v0.split(",")[0], 16) >> 16) & 0xff
                    s1_stage = (int(v1.split(",")[0], 16) >> 16) & 0xff
                    print(f"  STAGE DIVERGE at f={fr}: slot{slots[0]}=0x{s0_stage:02X} slot{slots[1]}=0x{s1_stage:02X}")
                except (ValueError, IndexError):
                    print(f"  STAGE DIVERGE at f={fr}: slot{slots[0]}={v0.split(',')[0]} slot{slots[1]}={v1.split(',')[0]}")
            else:
                print(f"  Stage: IDENTICAL across {len(common)} common frames")

            if chr_diff:
                fr, v0, v1 = chr_diff
                print(f"  CHARACTER DIVERGE at f={fr}: slot{slots[0]}={v0} slot{slots[1]}={v1}")
            else:
                print(f"  Character: IDENTICAL across {len(common)} common frames")

            if rng_diff:
                fr, v0, v1 = rng_diff
                print(f"  RNG DIVERGE at f={fr}: slot{slots[0]}={v0} slot{slots[1]}={v1}")
            else:
                print(f"  RNG: IDENTICAL across {len(common)} common frames")

        # CSS cross-comparison
        s0_css = {fr: msg for fr, msg in slot_data[slots[0]]["css"]}
        s1_css = {fr: msg for fr, msg in slot_data[slots[1]]["css"]}
        css_common = sorted(set(s0_css.keys()) & set(s1_css.keys()))
        if css_common:
            css_diffs = [(fr, s0_css[fr], s1_css[fr]) for fr in css_common if s0_css[fr] != s1_css[fr]]
            if css_diffs:
                print(f"\n  CSS state differs at {len(css_diffs)}/{len(css_common)} common frames:")
                for fr, m0, m1 in css_diffs[:5]:
                    # Show the p1/p2 cid differences
                    def extract_cids(msg):
                        cids = {}
                        for token in msg.split():
                            for px in ["p1_css:", "p2_css:", "p3_css:", "p4_css:"]:
                                if token.startswith(px):
                                    for kv in token[len(px):].split(","):
                                        if kv.startswith("cid="):
                                            cids[px[:6]] = kv[4:]
                        return cids
                    c0 = extract_cids(m0)
                    c1 = extract_cids(m1)
                    diffs = [f"{k}:{c0.get(k,'?')}→{c1.get(k,'?')}" for k in sorted(set(c0) | set(c1)) if c0.get(k) != c1.get(k)]
                    print(f"    f={fr:>6} char_id diffs: {', '.join(diffs)}")
            else:
                print(f"\n  CSS state: IDENTICAL across {len(css_common)} common frames")

        # SSIM visual comparison
        if base and key and match_id:
            ssim_data = _fetch_ssim(base, key, match_id)
            if ssim_data:
                print(f"\n  ── SSIM Visual Comparison ({len(ssim_data)} frames) ──")
                desynced = [s for s in ssim_data if s.get("is_desync")]
                synced = [s for s in ssim_data if not s.get("is_desync")]
                print(f"  Synced: {len(synced)}/{len(ssim_data)}  Desynced: {len(desynced)}/{len(ssim_data)}")
                if desynced:
                    first = desynced[0]
                    worst = min(desynced, key=lambda s: s.get("ssim", 1))
                    print(f"  First visual desync: f={first.get('frame')} ssim={first.get('ssim', 0):.4f}")
                    print(f"  Worst visual desync: f={worst.get('frame')} ssim={worst.get('ssim', 0):.4f}")
                    print(f"  SSIM timeline (desynced frames):")
                    for s in desynced[:20]:
                        print(f"    f={s.get('frame', '?'):>6}  ssim={s.get('ssim', 0):.4f}")
                    if len(desynced) > 20:
                        print(f"    ... +{len(desynced) - 20} more")
                if synced:
                    avg_ssim = sum(s.get("ssim", 0) for s in synced) / len(synced)
                    print(f"  Average SSIM (synced frames): {avg_ssim:.4f}")
            else:
                print(f"\n  (no SSIM data available)")


def query_full_state_comparison(jsonl_dir: str) -> None:
    """Compare ALL hash levels between peers: gameplay, game_state, full_state, per-region."""
    _print_section("11. FULL STATE COMPARISON")
    import glob as _glob

    # Extract C-PERF hashes per slot per frame
    perf_by_slot: dict[int, dict[int, dict]] = defaultdict(dict)
    regions_by_slot: dict[int, dict[int, list]] = defaultdict(dict)

    for path in sorted(_glob.glob(f"{jsonl_dir}/session-*.jsonl")):
        try:
            with open(path) as f:
                first = json.loads(f.readline())
                slot = first.get("slot", -1)
                f.seek(0)
                for line in f:
                    d = json.loads(line)
                    msg = d.get("msg", "")
                    if "C-PERF" in msg:
                        m = re.search(
                            r"hashF=(\d+).*gp=0x([0-9a-f-]+).*game=0x([0-9a-f-]+).*full=0x([0-9a-f-]+)",
                            msg,
                        )
                        if m:
                            frame = int(m.group(1))
                            perf_by_slot[slot][frame] = {
                                "gp": m.group(2),
                                "game": m.group(3),
                                "full": m.group(4),
                            }
                    elif "C-REGIONS" in msg:
                        m = re.match(r"C-REGIONS f=(\d+) (.+)", msg)
                        if m:
                            frame = int(m.group(1))
                            regions_by_slot[slot][frame] = m.group(2).split(",")
        except Exception:
            continue

    if len(perf_by_slot) < 2:
        # Show what we have from one peer
        if len(perf_by_slot) == 1:
            s = list(perf_by_slot.keys())[0]
            print(f"  Only slot {s} has C-PERF data (other peer's log may have truncated).")
            print(f"  Slot {s} hashes:")
            for frame in sorted(perf_by_slot[s].keys()):
                p = perf_by_slot[s][frame]
                print(f"    f={frame:>6} gp={p['gp']} game={p['game']} full={p['full']}")
        else:
            print("  No C-PERF data from either peer.")

    # Region-level comparison (works even without C-PERF from both peers)
    if len(regions_by_slot) >= 2:
        r_slots = sorted(regions_by_slot.keys())
        rs0, rs1 = r_slots[0], r_slots[1]
        common_rf = sorted(set(regions_by_slot[rs0].keys()) & set(regions_by_slot[rs1].keys()))
        if common_rf:
            print(f"\n  Per-region comparison across {len(common_rf)} frames (slot {rs0} vs slot {rs1}):")
            first_div_frame = None
            for rf in common_rf:
                r0 = regions_by_slot[rs0][rf]
                r1 = regions_by_slot[rs1][rf]
                diffs = [i for i in range(min(len(r0), len(r1))) if r0[i] != r1[i]]
                status = f"{len(diffs)} regions differ" if diffs else "ALL MATCH"
                print(f"    f={rf:>6}: {status}" + (f" — {diffs[:20]}" if diffs else ""))
                if diffs and first_div_frame is None:
                    first_div_frame = rf
                    # Show detail for first divergence
                    print(f"    First divergence detail:")
                    for ri in diffs[:15]:
                        base = ri * 0x10000 if ri < 128 else 0
                        labels = []
                        if ri in {2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 19, 20} or (21 <= ri <= 112) or ri in {113, 121}:
                            labels.append("TAINTED")
                        if ri == 5: labels.append("RNG_primary")
                        elif ri == 10: labels.append("VS_settings/screen/RNG_alt")
                        elif ri == 19: labels.append("player_structs/char_id/damage")
                        elif 21 <= ri <= 112: labels.append("heap")
                        label = " ".join(labels) if labels else "NOT TAINTED"
                        print(f"      r{ri:>3} (0x{base:06X}): {label}")

            if first_div_frame:
                # Find rollbacks in window before first divergence
                prev_clean = None
                for rf in common_rf:
                    if rf < first_div_frame:
                        r0 = regions_by_slot[rs0][rf]
                        r1 = regions_by_slot[rs1][rf]
                        if all(r0[i] == r1[i] for i in range(min(len(r0), len(r1)))):
                            prev_clean = rf
                if prev_clean:
                    print(f"\n    Divergence window: f={prev_clean} (clean) → f={first_div_frame} (diverged)")
                    rb_count = 0
                    for path in sorted(_glob.glob(f"{jsonl_dir}/session-*.jsonl")):
                        try:
                            with open(path) as fp:
                                first_line = json.loads(fp.readline())
                                sl = first_line.get("slot", -1)
                                fp.seek(0)
                                for line in fp:
                                    d = json.loads(line)
                                    msg = d.get("msg", "")
                                    fr = d.get("f", -1)
                                    if prev_clean <= fr <= first_div_frame and any(
                                        k in msg for k in ["INVARIANT", "MISPREDICTION", "C-REPLAY"]
                                    ):
                                        if rb_count < 15:
                                            print(f"      slot={sl} f={fr} {msg[:120]}")
                                        rb_count += 1
                        except Exception:
                            continue
                    if rb_count == 0:
                        print(f"      (none — divergence from normal execution)")
                    elif rb_count > 15:
                        print(f"      ... +{rb_count - 15} more")

    if len(perf_by_slot) < 2:
        return
    slots = sorted(perf_by_slot.keys())
    s0, s1 = slots[0], slots[1]
    common_frames = sorted(set(perf_by_slot[s0].keys()) & set(perf_by_slot[s1].keys()))

    if not common_frames:
        print("  No common C-PERF frames between peers.")
        return

    print(f"  Hash comparison across {len(common_frames)} common frames (slot {s0} vs slot {s1}):")
    print()
    print(f"  {'frame':>8} | {'gp_hash':^10} | {'game_hash':^10} | {'full_hash':^10}")
    print(f"  {'-'*8}-+-{'-'*10}-+-{'-'*10}-+-{'-'*10}")

    first_game_div = None
    first_full_div = None
    for frame in common_frames:
        p0 = perf_by_slot[s0][frame]
        p1 = perf_by_slot[s1][frame]
        gp_match = p0["gp"] == p1["gp"]
        game_match = p0["game"] == p1["game"]
        full_match = p0["full"] == p1["full"]
        gp_str = "MATCH" if gp_match else "DIFFER"
        game_str = "MATCH" if game_match else "!! DIFFER"
        full_str = "MATCH" if full_match else "!! DIFFER"
        print(f"  {frame:>8} | {gp_str:^10} | {game_str:^10} | {full_str:^10}")
        if not game_match and first_game_div is None:
            first_game_div = frame
        if not full_match and first_full_div is None:
            first_full_div = frame

    if first_game_div:
        print(f"\n  ** GAME STATE diverges at f={first_game_div} (taint-filtered RDRAM hash)")
        print(f"     gameplay_hash still matches — divergence is in non-gameplay addresses")
        print(f"     that are NOT tainted (player positions, velocities, animation, objects)")
    elif first_full_div:
        print(f"\n  ** FULL STATE diverges at f={first_full_div} (raw hash including tainted)")
        print(f"     game_state_hash matches — divergence is only in tainted regions (audio/heap)")
    else:
        print(f"\n  All hashes match across all frames — perfect sync.")

    # Region-level diff at first divergence (C-PERF based — see also region comparison below)
    if False and (first_game_div or first_full_div):
        div_frame = first_game_div or first_full_div
        # Find closest region frame
        common_region_frames = sorted(
            set(regions_by_slot.get(s0, {}).keys()) & set(regions_by_slot.get(s1, {}).keys())
        )
        closest = None
        for rf in common_region_frames:
            if rf >= div_frame - 300:
                closest = rf
                break

        if closest and closest in regions_by_slot.get(s0, {}) and closest in regions_by_slot.get(s1, {}):
            r0 = regions_by_slot[s0][closest]
            r1 = regions_by_slot[s1][closest]
            diffs = []
            for i in range(min(len(r0), len(r1))):
                if r0[i] != r1[i]:
                    diffs.append(i)
            if diffs:
                print(f"\n  Region diff at f={closest}: {len(diffs)} regions diverge")
                for ri in diffs[:20]:
                    base = ri * 0x10000 if ri < 128 else 0
                    tainted = "TAINTED" if ri in {2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 19, 20} or (21 <= ri <= 112) or ri in {113, 121} else ""
                    has_gameplay = ""
                    if ri == 5:
                        has_gameplay = " [RNG_primary]"
                    elif ri == 10:
                        has_gameplay = " [VS_settings, current_screen, RNG_alt]"
                    elif ri == 19:
                        has_gameplay = " [char_id, damage, player structs]"
                    print(f"    r{ri:>3} (0x{base:06X}): {tainted}{has_gameplay}")
            else:
                print(f"\n  Region diff at f={closest}: ALL MATCH (divergence in post-RDRAM section?)")

    # Check for rollbacks in the divergence window
    if first_game_div or first_full_div:
        div_frame = first_game_div or first_full_div
        prev_clean = None
        for frame in common_frames:
            if frame < div_frame:
                p0 = perf_by_slot[s0][frame]
                p1 = perf_by_slot[s1][frame]
                if p0["game"] == p1["game"]:
                    prev_clean = frame
        if prev_clean:
            print(f"\n  Divergence window: f={prev_clean} (clean) → f={div_frame} (diverged)")
            print(f"  Rollbacks in this window:")
            rb_count = 0
            for path in sorted(_glob.glob(f"{jsonl_dir}/session-*.jsonl")):
                try:
                    with open(path) as f:
                        first = json.loads(f.readline())
                        slot = first.get("slot", -1)
                        f.seek(0)
                        for line in f:
                            d = json.loads(line)
                            msg = d.get("msg", "")
                            fr = d.get("f", -1)
                            if prev_clean <= fr <= div_frame and any(
                                k in msg for k in ["INVARIANT", "MISPREDICTION", "C-REPLAY"]
                            ):
                                print(f"    slot={slot} f={fr} {msg[:140]}")
                                rb_count += 1
                except Exception:
                    continue
            if rb_count == 0:
                print(f"    (none — divergence is from normal execution, not rollback)")


def query_byte_level_diff(jsonl_dir: str) -> None:
    """Byte-level diff of REGION-BYTES from both peers at the same frame+region+sub-chunk."""
    _print_section("12. BYTE-LEVEL STATE DIFF")
    import glob as _glob

    # Collect all RB-REGION-BYTES entries keyed by (frame, region, sub-chunk)
    # slot -> { (frame, region, sub) -> hex_bytes }
    per_slot: dict[int, dict[tuple[int, int, int], str]] = defaultdict(dict)
    for path in sorted(_glob.glob(f"{jsonl_dir}/session-*.jsonl")):
        try:
            with open(path) as f:
                first = json.loads(f.readline())
                slot = first.get("slot", -1)
                f.seek(0)
                for line in f:
                    d = json.loads(line)
                    msg = d.get("msg", "")
                    if "RB-REGION-BYTES" not in msg:
                        continue
                    # Parse: RB-REGION-BYTES f=N rR:RDRAM sub=S/T off=0xX len=L: HEXDATA
                    m = re.match(
                        r"RB-REGION-BYTES f=(\d+) r(\d+):\w+ sub=(\d+)/\d+ off=0x[0-9a-f]+ len=\d+: ([0-9a-f]+)",
                        msg,
                    )
                    if m:
                        frame, region, sub = int(m.group(1)), int(m.group(2)), int(m.group(3))
                        per_slot[slot][(frame, region, sub)] = m.group(4)
        except Exception:
            continue

    if len(per_slot) < 2:
        print("  Need REGION-BYTES from both peers for diffing.")
        return

    slots = sorted(per_slot.keys())
    s0, s1 = slots[0], slots[1]
    # Find overlapping keys
    common = set(per_slot[s0].keys()) & set(per_slot[s1].keys())
    if not common:
        print(f"  No overlapping frame+region+sub between slot {s0} and slot {s1}.")
        print(f"  Slot {s0}: {len(per_slot[s0])} entries, Slot {s1}: {len(per_slot[s1])} entries")
        # Fall back: show per-slot byte dumps at first divergence
        for s in slots:
            entries = sorted(per_slot[s].keys())
            if entries:
                frame, region, sub = entries[0]
                print(f"\n  First REGION-BYTES from slot {s}: f={frame} r{region} sub={sub}")
                hex_data = per_slot[s][(frame, region, sub)]
                # Show first 128 bytes as formatted hex
                for off in range(0, min(len(hex_data), 256), 64):
                    chunk = hex_data[off : off + 64]
                    byte_off = off // 2
                    rdram_base = region * 0x10000 + sub * 256
                    print(f"    0x{rdram_base + byte_off:06X}: {chunk}")
        return

    print(f"  Found {len(common)} overlapping frame+region+sub entries between slots {s0} and {s1}")
    # Sort by frame, then region, then sub
    common_sorted = sorted(common)
    diffs_found = 0
    for frame, region, sub in common_sorted:
        h0 = per_slot[s0][(frame, region, sub)]
        h1 = per_slot[s1][(frame, region, sub)]
        if h0 == h1:
            continue
        min_len = min(len(h0), len(h1))
        byte_diffs = []
        for i in range(0, min_len, 2):
            if h0[i : i + 2] != h1[i : i + 2]:
                byte_off = i // 2
                rdram_addr = region * 0x10000 + sub * 256 + byte_off
                byte_diffs.append((byte_off, rdram_addr, h0[i : i + 2], h1[i : i + 2]))
        if byte_diffs:
            diffs_found += 1
            rdram_base = region * 0x10000 + sub * 256
            print(f"\n  f={frame} r{region} sub={sub} (RDRAM 0x{rdram_base:06X}): {len(byte_diffs)} bytes differ")
            for byte_off, rdram_addr, b0, b1 in byte_diffs[:20]:
                print(f"    offset {byte_off:>3} (0x{rdram_addr:06X}): slot{s0}=0x{b0} slot{s1}=0x{b1}")
            if len(byte_diffs) > 20:
                print(f"    ... +{len(byte_diffs) - 20} more")
            if diffs_found >= 10:
                print(f"\n  (showing first 10 diverging sub-chunks, {len(common_sorted) - diffs_found} more)")
                break

    if diffs_found == 0:
        print("  All overlapping REGION-BYTES are identical between peers.")

    # Also dump gameplay address values from live RDRAM if GP-DUMP entries exist
    gp_dumps: dict[int, list[str]] = defaultdict(list)
    for path in sorted(_glob.glob(f"{jsonl_dir}/session-*.jsonl")):
        try:
            with open(path) as f:
                first = json.loads(f.readline())
                slot = first.get("slot", -1)
                f.seek(0)
                for line in f:
                    d = json.loads(line)
                    msg = d.get("msg", "")
                    if msg.startswith("GP-DUMP") or msg.startswith("GP-CSS"):
                        gp_dumps[slot].append(msg)
        except Exception:
            continue

    if gp_dumps:
        print(f"\n  === GAMEPLAY ADDRESS DUMPS (from JS) ===")
        for s in sorted(gp_dumps.keys()):
            print(f"\n  Slot {s}:")
            for msg in gp_dumps[s][:5]:
                print(f"    {msg}")

    # Extract gameplay address values from REGION-BYTES data
    gameplay_addrs = [
        (0xA4AD0, 1, "current_screen"),
        (0xA4D08, 4, "VS_settings[0]"),
        (0xA4D0C, 4, "VS_settings[1]"),
        (0xA4D10, 4, "VS_settings[2]"),
        (0xA4D14, 4, "VS_settings[3]"),
        (0xA4D18, 4, "VS_settings[4] (game_status)"),
        (0xA4D1C, 4, "VS_settings[5]"),
        (0xA4D20, 4, "VS_settings[6]"),
        (0xA4D53, 1, "P1_stocks"),
        (0xA4DC7, 1, "P2_stocks"),
        (0xA4E3B, 1, "P3_stocks"),
        (0xA4EAF, 1, "P4_stocks"),
        (0x130D8C, 4, "P1_char_id"),
        (0x130DB0, 4, "P1_damage"),
        (0x1318DC, 4, "P2_char_id"),
        (0x131900, 4, "P2_damage"),
        (0x13242C, 4, "P3_char_id"),
        (0x132450, 4, "P3_damage"),
        (0x132F7C, 4, "P4_char_id"),
        (0x132FA0, 4, "P4_damage"),
        (0x05B940, 4, "RNG_primary"),
        (0x0A0578, 4, "RNG_alt"),
        # CSS player struct state (VS mode, base 0x8013BA88, stride 0xBC)
        (0x13BAD0, 4, "P1_css_char_id"),
        (0x13BADC, 4, "P1_css_cursor_state"),
        (0x13BAE0, 4, "P1_css_selected"),
        (0x13BAE4, 4, "P1_css_recalling"),
        (0x13BB04, 4, "P1_css_state_7C"),
        (0x13BB08, 4, "P1_css_held_token"),
        (0x13BB0C, 4, "P1_css_panel_state"),
        (0x13BB10, 4, "P1_css_selected2"),
        (0x13BB8C, 4, "P2_css_char_id"),
        (0x13BB98, 4, "P2_css_cursor_state"),
        (0x13BB9C, 4, "P2_css_selected"),
        (0x13BBA0, 4, "P2_css_recalling"),
        (0x13BBC0, 4, "P2_css_state_7C"),
        (0x13BBC4, 4, "P2_css_held_token"),
        (0x13BBC8, 4, "P2_css_panel_state"),
        (0x13BBCC, 4, "P2_css_selected2"),
        (0x13BC48, 4, "P3_css_char_id"),
        (0x13BC54, 4, "P3_css_cursor_state"),
        (0x13BC58, 4, "P3_css_selected"),
        (0x13BC5C, 4, "P3_css_recalling"),
        (0x13BC7C, 4, "P3_css_state_7C"),
        (0x13BC80, 4, "P3_css_held_token"),
        (0x13BC84, 4, "P3_css_panel_state"),
        (0x13BC88, 4, "P3_css_selected2"),
        (0x13BD04, 4, "P4_css_char_id"),
        (0x13BD10, 4, "P4_css_cursor_state"),
        (0x13BD14, 4, "P4_css_selected"),
        (0x13BD18, 4, "P4_css_recalling"),
        (0x13BD38, 4, "P4_css_state_7C"),
        (0x13BD3C, 4, "P4_css_held_token"),
        (0x13BD40, 4, "P4_css_panel_state"),
        (0x13BD44, 4, "P4_css_selected2"),
        # RNG frame counters
        (0x03CB30, 4, "frame_counter"),
        (0x03B6E4, 4, "screen_frame_count"),
    ]

    # Build lookup: (region, sub, byte_offset_in_sub) -> (slot, frame, hex_value)
    # For each gameplay addr, find if we have REGION-BYTES covering it
    print(f"\n  === GAMEPLAY ADDRESS VALUES (from REGION-BYTES) ===")
    # Find first MISMATCH frame
    first_mismatch_frame = None
    for path in sorted(_glob.glob(f"{jsonl_dir}/session-*.jsonl")):
        try:
            with open(path) as f:
                for line in f:
                    d = json.loads(line)
                    msg = d.get("msg", "")
                    if "RB-CHECK" in msg and "MISMATCH" in msg:
                        m = re.search(r"RB-CHECK f=(\d+)", msg)
                        if m:
                            mf = int(m.group(1))
                            if first_mismatch_frame is None or mf < first_mismatch_frame:
                                first_mismatch_frame = mf
        except Exception:
            continue

    if first_mismatch_frame is None:
        print("  No MISMATCH detected — gameplay addresses not compared.")
        return

    print(f"  First MISMATCH at f={first_mismatch_frame}")
    print()

    # For each gameplay address, check if we have bytes in any nearby frame
    search_range = range(first_mismatch_frame - 5, first_mismatch_frame + 10)
    for addr, size, name in gameplay_addrs:
        region = addr >> 16
        sub = (addr & 0xFFFF) >> 8
        byte_off = addr & 0xFF
        # Check both slots for this region+sub in the search range
        values: dict[int, dict[int, str]] = {}  # slot -> frame -> hex_value
        for s in slots:
            for frame in search_range:
                key = (frame, region, sub)
                if key in per_slot[s]:
                    hex_data = per_slot[s][key]
                    # Extract bytes at byte_off
                    hex_start = byte_off * 2
                    hex_end = hex_start + size * 2
                    if hex_end <= len(hex_data):
                        val = hex_data[hex_start:hex_end]
                        if s not in values:
                            values[s] = {}
                        values[s][frame] = val

        if values:
            slot_strs = []
            for s in sorted(values.keys()):
                frames = sorted(values[s].keys())
                for frame in frames[:2]:
                    slot_strs.append(f"slot{s}@f{frame}=0x{values[s][frame]}")
            match_str = ""
            # Check if values match across slots at same frame
            for frame in search_range:
                vals_at_frame = {}
                for s in sorted(values.keys()):
                    if frame in values.get(s, {}):
                        vals_at_frame[s] = values[s][frame]
                if len(vals_at_frame) == 2:
                    v = list(vals_at_frame.values())
                    match_str = " MATCH" if v[0] == v[1] else f" DIFFER"
                    break
            print(f"  0x{addr:06X} {name:30s} r{region}:sub{sub}:off{byte_off} {' | '.join(slot_strs)}{match_str}")
        else:
            print(f"  0x{addr:06X} {name:30s} r{region}:sub{sub}:off{byte_off} (no REGION-BYTES data)")


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
    query_freeze_detection(df, str(out_dir))
    query_boot_funnel(df, client_events)
    query_session_lifecycle(client_events)
    query_input_analysis(df)
    query_rollback_detail(df)
    query_c_debug_highlights(df)
    query_tick_performance(str(out_dir))
    query_gp_dump_comparison(str(out_dir))
    query_desync_summary(str(out_dir), args.base, args.key, full_match_id)
    query_full_state_comparison(str(out_dir))
    query_byte_level_diff(str(out_dir))

    if not cleanup:
        print(f"\n[analyze] JSONL files kept at: {out_dir}")
    else:
        import shutil

        shutil.rmtree(out_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
