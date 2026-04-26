#!/usr/bin/env python3
"""Diff GOBJ-THREAD-SAMPLE across two peers from session logs.

Pulls the two most recent session-log entries for the current/last
match, extracts GOBJ-THREAD-SAMPLE f=<frame> tid=<n> lines, and reports
per-frame cross-peer delta plus the first frame where the delta
changes (meaning a peer created an extra thread since the last sample
window).

Usage: uv run python tools/diff_thread_samples.py [room=AUTO...]
       uv run python tools/diff_thread_samples.py --match-id <uuid>
"""
import argparse
import json
import re
import ssl
import sys
import urllib.request

BASE = "https://localhost:27888"
ADMIN_KEY = "1234"
SAMPLE_RE = re.compile(r"GOBJ-THREAD-SAMPLE f=(\d+) tid=(\d+)")


def admin_get(path):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(f"{BASE}{path}", headers={"X-Admin-Key": ADMIN_KEY})
    with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
        return json.loads(r.read().decode())


def extract_samples(log_entries):
    """Returns dict frame -> tid from log."""
    out = {}
    for e in log_entries:
        msg = e.get("msg") or ""
        m = SAMPLE_RE.search(msg)
        if m:
            f, tid = int(m.group(1)), int(m.group(2))
            out[f] = tid
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--room", default=None)
    ap.add_argument("--match-id", default=None)
    args = ap.parse_args()

    listing = admin_get("/admin/api/session-logs?days=1&limit=10")
    entries = listing["entries"]
    if args.match_id:
        entries = [e for e in entries if e["match_id"] == args.match_id]
    elif args.room:
        entries = [e for e in entries if e["room"] == args.room]
    else:
        # Pick the 2 most recent with matching match_id
        if not entries:
            print("No entries found", file=sys.stderr)
            sys.exit(1)
        latest_match = entries[0]["match_id"]
        entries = [e for e in entries if e["match_id"] == latest_match]

    if len(entries) < 2:
        print(f"Need 2 peers, got {len(entries)}", file=sys.stderr)
        for e in entries:
            print(f"  match={e['match_id']} slot={e['slot']} name={e.get('player_name','?')}")
        sys.exit(1)

    entries = sorted(entries, key=lambda e: e["slot"])[:2]
    print(f"Match: {entries[0]['match_id']}")
    print(f"Peer A: slot={entries[0]['slot']} name={entries[0].get('player_name','?')}")
    print(f"Peer B: slot={entries[1]['slot']} name={entries[1].get('player_name','?')}")
    print()

    logs = [admin_get(f"/admin/api/session-logs/{e['id']}") for e in entries]
    samples = [extract_samples(l.get("log_data", [])) for l in logs]

    all_frames = sorted(set(samples[0]) | set(samples[1]))
    if not all_frames:
        print("No GOBJ-THREAD-SAMPLE found in either log")
        sys.exit(1)

    print(f"{'frame':>8} | {'A tid':>10} | {'B tid':>10} | {'Δ(B-A)':>8} | note")
    print("-" * 60)
    prev_delta = None
    first_drift_frame = None
    first_growth_frame = None
    growth_events = []  # frames where delta changes
    for f in all_frames:
        a = samples[0].get(f)
        b = samples[1].get(f)
        if a is None or b is None:
            continue
        delta = b - a
        note = ""
        if prev_delta is None:
            note = "baseline"
        elif delta != prev_delta:
            growth = delta - prev_delta
            note = f"Δ changed by {growth:+d}"
            growth_events.append((f, prev_delta, delta, growth))
            if first_growth_frame is None:
                first_growth_frame = f
        if delta != 0 and first_drift_frame is None:
            first_drift_frame = f
        print(f"{f:>8} | {a:>10} | {b:>10} | {delta:>+8} | {note}")
        prev_delta = delta

    print()
    print("=== Summary ===")
    print(f"First frame with any drift (delta != 0): {first_drift_frame}")
    print(f"First frame where delta GROWS (an extra thread spawn): {first_growth_frame}")
    print(f"Total growth events: {len(growth_events)}")
    if growth_events:
        print("Growth events (frame, prev_delta, new_delta, Δ):")
        for f, pd, nd, g in growth_events[:20]:
            print(f"  f={f:<6} {pd:+3d} -> {nd:+3d} ({g:+d})")


if __name__ == "__main__":
    main()
