#!/usr/bin/env python3
"""Pointer-aware byte-level diff of two 8 MB RDRAM dumps.

Identifies cross-peer divergences that are NOT just pointer-value shifts
(0x80xxxxxx RDRAM addresses differing due to heap non-determinism).

Usage:
    python tools/rdram_diff.py /tmp/rdram-host.bin /tmp/rdram-guest.bin
    python tools/rdram_diff.py <host> <guest> --block 19       # single block
    python tools/rdram_diff.py <host> <guest> --syms SYMS.toml # annotate

Outputs:
    - Per-block byte-diff summary
    - Aligned-4 word diffs that look like pointers (both 0x80xxxxxx)
    - Aligned-4 word diffs that look like non-pointer data (likely real bug)
    - For non-pointer diffs: nearest named symbol from smash64r data_dump.toml
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def load(path: str) -> bytes:
    p = Path(path)
    if not p.exists():
        print(f"Missing: {path}", file=sys.stderr)
        sys.exit(2)
    data = p.read_bytes()
    if len(data) != 0x800000:
        print(f"Warning: {path} is {len(data)} bytes, expected {0x800000}", file=sys.stderr)
    return data


def load_syms(sym_path: Path) -> list[tuple[int, str]]:
    """Return sorted list of (addr, name) from smash64r data_dump.toml."""
    if not sym_path.exists():
        return []
    text = sym_path.read_text()
    out: list[tuple[int, str]] = []
    for m in re.finditer(r'\{\s*name\s*=\s*"([^"]+)",\s*vram\s*=\s*(0x[0-9a-fA-F]+)', text):
        name = m.group(1)
        vram = int(m.group(2), 16)
        if 0x80000000 <= vram < 0x80800000:
            out.append((vram - 0x80000000, name))
    out.sort()
    return out


def nearest_symbol(syms: list[tuple[int, str]], addr: int) -> str:
    """Find closest symbol at or before addr (using binary-search-ish)."""
    if not syms:
        return ""
    lo, hi = 0, len(syms)
    while lo < hi:
        mid = (lo + hi) // 2
        if syms[mid][0] <= addr:
            lo = mid + 1
        else:
            hi = mid
    if lo == 0:
        return ""
    sym_addr, name = syms[lo - 1]
    return f"{name}+0x{addr - sym_addr:x}"


def is_rdram_pointer(u32: int) -> bool:
    """True if u32 looks like an N64 RDRAM pointer (KSEG0 0x80000000-0x807FFFFF)."""
    return 0x80000000 <= u32 < 0x80800000


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("host", help="Host RDRAM dump (8 MB)")
    ap.add_argument("guest", help="Guest RDRAM dump (8 MB)")
    ap.add_argument("--block", type=int, help="Only analyze this 64-KB block index")
    ap.add_argument(
        "--syms",
        default="build/recomp/vendor/smash64r/smash64rsyms/data_dump.toml",
        help="Path to smash64r data_dump.toml for symbol annotation",
    )
    ap.add_argument("--max-report", type=int, default=50, help="Max diffs to print per category")
    args = ap.parse_args()

    h = load(args.host)
    g = load(args.guest)
    syms = load_syms(Path(args.syms))
    print(f"Loaded {len(syms)} symbols from {args.syms}")

    # 1. Per-block byte diff summary (128 blocks of 64 KB)
    print("\n=== Per-block byte-diff summary ===")
    print(f"{'blk':>3}  {'rdram':>10}  {'diff_bytes':>10}  {'diff_%':>7}")
    block_diffs: list[tuple[int, int]] = []
    for blk in range(128):
        if args.block is not None and blk != args.block:
            continue
        start = blk * 0x10000
        end = start + 0x10000
        diff = sum(1 for i in range(start, end) if h[i] != g[i])
        if diff > 0:
            block_diffs.append((blk, diff))
            pct = diff / 0x10000 * 100
            print(f"  {blk:>3}  0x{start:08x}  {diff:>10}  {pct:>6.2f}%")
    total_diff_bytes = sum(d for _, d in block_diffs)
    print(f"\nTotal: {len(block_diffs)} blocks differ, {total_diff_bytes} bytes total")

    # 2. Aligned-4 word diffs — classify as pointer-only vs data
    print("\n=== 4-byte-aligned word diffs (classified) ===")
    pointer_diffs: list[tuple[int, int, int]] = []
    data_diffs: list[tuple[int, int, int]] = []
    for blk, _ in block_diffs:
        start = blk * 0x10000
        end = start + 0x10000
        for i in range(start, end, 4):
            hw = int.from_bytes(h[i:i + 4], "big")  # N64 is big-endian in RDRAM
            gw = int.from_bytes(g[i:i + 4], "big")
            if hw == gw:
                continue
            if is_rdram_pointer(hw) and is_rdram_pointer(gw):
                pointer_diffs.append((i, hw, gw))
            else:
                data_diffs.append((i, hw, gw))

    print(f"\nPointer-only diffs: {len(pointer_diffs)} words (heap address shifts)")
    print("  → likely benign: same object, different heap address cross-peer")
    print(f"\nData diffs (real potential bugs): {len(data_diffs)} words")
    if data_diffs:
        print(f"  → these are non-pointer values that differ cross-peer — investigate first")
        print(f"\n  First {min(args.max_report, len(data_diffs))} data diffs:")
        print(f"    {'rdram':>10}  {'host':>10}  {'guest':>10}  {'diff':>10}  nearest_symbol")
        for addr, hw, gw in data_diffs[:args.max_report]:
            diff = hw ^ gw  # xor shows which bits differ
            sym = nearest_symbol(syms, addr)
            print(f"    0x{addr:08x}  {hw:08x}  {gw:08x}  {diff:08x}  {sym}")

    # 3. Pointer-diff heap-base inference
    if pointer_diffs:
        print(f"\n=== Pointer diff analysis ===")
        # For each pointer-only diff, compute host - guest delta
        # If one consistent delta, it's a heap base shift
        deltas = [hw - gw for _, hw, gw in pointer_diffs]
        from collections import Counter
        c = Counter(deltas)
        print(f"  Top deltas (host_ptr - guest_ptr):")
        for delta, cnt in c.most_common(5):
            sign = "+" if delta >= 0 else "-"
            print(f"    {sign}0x{abs(delta):x}  ({cnt} pointers = {cnt/len(deltas)*100:.1f}%)")


if __name__ == "__main__":
    main()
