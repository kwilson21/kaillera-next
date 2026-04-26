#!/usr/bin/env python3
"""Diff syUtilsRandom call count per 30-frame window across peers.

Pulls latest match session logs, extracts RNG-SAMPLE entries (seed
value per 30 frames), reverses the LCG to compute the number of
rand() calls between consecutive samples on each peer, and diffs
the counts to find the FIRST frame window where host and guest
made different numbers of rand() calls.

LCG: seed_{n+1} = (seed_n * 214013 + 2531011) mod 2^32

Usage: uv run python tools/diff_rand_calls.py
"""
import json
import re
import ssl
import sys
import urllib.request

BASE = "https://localhost:27888"
ADMIN_KEY = "1234"
LCG_MUL = 214013
LCG_ADD = 2531011
LCG_MOD = 1 << 32
MAX_CALLS_PER_WINDOW = 100000  # safety cap
SAMPLE_RE = re.compile(r"RNG-SAMPLE f=(\d+) seed=([0-9a-f]+)")


def admin_get(path):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(f"{BASE}{path}", headers={"X-Admin-Key": ADMIN_KEY})
    with urllib.request.urlopen(req, context=ctx, timeout=10) as r:
        return json.loads(r.read().decode())


def count_lcg_calls(from_seed: int, to_seed: int) -> int | None:
    """Return number of LCG iterations needed to go from `from_seed` to
    `to_seed`, or None if not reachable within MAX_CALLS_PER_WINDOW."""
    if from_seed == to_seed:
        return 0
    current = from_seed
    for i in range(1, MAX_CALLS_PER_WINDOW + 1):
        current = (current * LCG_MUL + LCG_ADD) % LCG_MOD
        if current == to_seed:
            return i
    return None


def extract_samples(entries):
    out = {}
    for e in entries:
        m = SAMPLE_RE.search(e.get("msg") or "")
        if m:
            f = int(m.group(1))
            seed = int(m.group(2), 16)
            # Dedup: keep first per frame
            if f not in out:
                out[f] = seed
    return out


def main():
    listing = admin_get("/admin/api/session-logs?days=1&limit=4")
    entries = [e for e in listing["entries"] if e["match_id"] == listing["entries"][0]["match_id"]]
    if len(entries) < 2:
        print(f"Need 2 peers, got {len(entries)}", file=sys.stderr)
        sys.exit(1)
    entries = sorted(entries, key=lambda e: e["slot"])[:2]
    print(f"Match: {entries[0]['match_id']}")
    print(f"Peer A (slot {entries[0]['slot']}): {entries[0].get('player_name','?')}")
    print(f"Peer B (slot {entries[1]['slot']}): {entries[1].get('player_name','?')}")

    logs = [admin_get(f"/admin/api/session-logs/{e['id']}") for e in entries]
    samples = [extract_samples(l.get("log_data", [])) for l in logs]
    common = sorted(set(samples[0]) & set(samples[1]))
    if not common:
        print("No common RNG-SAMPLE frames")
        sys.exit(1)

    # Compute calls-per-window for each peer
    print()
    print(f"{'window':>14} {'A_seed':>10} {'B_seed':>10} {'A_calls':>8} {'B_calls':>8} {'diff':>6} note")
    print("-" * 78)
    prev_a = prev_b = None
    prev_f = None
    first_diff_frame = None
    total_a = total_b = 0
    peer_seeds_match_last = True
    for f in common:
        a = samples[0][f]
        b = samples[1][f]
        if prev_a is None:
            prev_a, prev_b, prev_f = a, b, f
            print(f"  {f:>12}    {a:08x}   {b:08x}    {'-':>8} {'-':>8} {'-':>6} baseline")
            continue
        ca = count_lcg_calls(prev_a, a)
        cb = count_lcg_calls(prev_b, b)
        if ca is None or cb is None:
            ca_s = f"{ca if ca is not None else '>?'}"
            cb_s = f"{cb if cb is not None else '>?'}"
            print(f"  {prev_f:>6}-{f:>6}    {a:08x}   {b:08x}   {ca_s:>8} {cb_s:>8}  unreachable")
            prev_a, prev_b, prev_f = a, b, f
            continue
        total_a += ca
        total_b += cb
        diff = cb - ca
        note = ""
        peers_match = a == b
        if diff != 0 and first_diff_frame is None:
            first_diff_frame = f
            note = "FIRST-DIFF"
        if peer_seeds_match_last and not peers_match:
            note = (note + " PEERS-DIVERGE").strip()
        peer_seeds_match_last = peers_match
        print(f"  {prev_f:>6}-{f:>6}    {a:08x}   {b:08x}   {ca:>8} {cb:>8} {diff:>+6} {note}")
        prev_a, prev_b, prev_f = a, b, f

    print()
    print("=== Summary ===")
    print(f"Total A rand() calls: {total_a}")
    print(f"Total B rand() calls: {total_b}")
    print(f"Total drift (B-A): {total_b - total_a:+d}")
    print(f"First frame-window with cross-peer call count diff: {first_diff_frame}")


if __name__ == "__main__":
    main()
