#!/usr/bin/env python3
"""PC → symbol lookup for SSB64 MIPS addresses.

Reads the ssb-decomp-re linker map and maps an N64 virtual PC (0x80xxxxxx)
to the nearest lower symbol. Used by the cross-peer log diff workflow:
when RNG-SAMPLE or FT-COUNT-DELTA shows a divergence frame, lift the PC
from the log, run it through this tool, grep the function name in the
decomp to find the branch that fires asymmetrically cross-JIT.

Usage:
  tools/pc_to_symbol.py 0x80131488
  tools/pc_to_symbol.py 0x80131488 0x80142a20 0x80045f00
  echo "pc=0x80131488 pc=0x80142a20" | tools/pc_to_symbol.py -
"""
import re
import sys
from pathlib import Path

MAP = Path(
    "build/recomp/vendor/smash64r/lib/ssb-decomp-re/build/smashbrothers.us.map"
)
SYM_RE = re.compile(r"^\s*0x0*([0-9a-fA-F]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*$")


def load_map(path: Path) -> list[tuple[int, str]]:
    syms: list[tuple[int, str]] = []
    for line in path.read_text().splitlines():
        m = SYM_RE.match(line)
        if not m:
            continue
        addr = int(m.group(1), 16)
        name = m.group(2)
        # Skip non-code sections — code is in 0x80xxxxxx range
        if addr < 0x80000000 or addr > 0x80800000:
            continue
        syms.append((addr, name))
    syms.sort()
    return syms


def lookup(syms: list[tuple[int, str]], pc: int) -> str:
    lo, hi = 0, len(syms) - 1
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        if syms[mid][0] <= pc:
            best = syms[mid]
            lo = mid + 1
        else:
            hi = mid - 1
    if best is None:
        return f"<no symbol ≤ 0x{pc:08x}>"
    delta = pc - best[0]
    return f"{best[1]}+0x{delta:x}" if delta else best[1]


def main() -> None:
    args = sys.argv[1:]
    if not args:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    syms = load_map(MAP)
    if args == ["-"]:
        text = sys.stdin.read()
        for pc_str in re.findall(r"0x[0-9a-fA-F]{7,8}", text):
            pc = int(pc_str, 16)
            print(f"{pc_str} -> {lookup(syms, pc)}")
        return
    for arg in args:
        pc = int(arg, 16)
        print(f"{arg} -> {lookup(syms, pc)}")


if __name__ == "__main__":
    main()
