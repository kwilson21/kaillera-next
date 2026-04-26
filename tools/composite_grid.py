#!/usr/bin/env python3
"""Build a single grid image showing cross-peer divergence over time.

Each row = one captured moment, two columns = host | guest.
Subsamples to fit `--rows` rows (default 8). Output is a single PNG that a
vision model can read in one go to spot when divergence starts.

Usage:
  uv run --with pillow python tools/composite_grid.py [--dir /tmp] [--rows 8] [--out /tmp/grid.png]
"""
import argparse
import glob
import os
import re
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def find_pairs(directory: str) -> list[tuple[str, Path, Path]]:
    files = sorted(glob.glob(f'{directory}/det-live-*-host.png'))
    pairs = []
    for host_p in files:
        guest_p = host_p.replace('-host.png', '-guest.png')
        if not os.path.exists(guest_p):
            continue
        m = re.search(r'det-live-(\d+)-hf(\d+)-gf(\d+)', host_p)
        if not m:
            continue
        idx, hf, gf = m.group(1), m.group(2), m.group(3)
        pairs.append((f'#{idx} hF={hf} gF={gf}', Path(host_p), Path(guest_p)))
    return pairs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default='/tmp')
    ap.add_argument('--rows', type=int, default=8)
    ap.add_argument('--cell_w', type=int, default=320, help='per-screenshot width in grid cell')
    ap.add_argument('--out', default='/tmp/grid.png')
    args = ap.parse_args()

    pairs = find_pairs(args.dir)
    if not pairs:
        print(f'No det-live-*-{{host,guest}}.png in {args.dir}', file=sys.stderr)
        sys.exit(1)

    if len(pairs) > args.rows:
        step = len(pairs) // args.rows
        sampled = pairs[::step][: args.rows]
    else:
        sampled = pairs
    print(f'{len(pairs)} pairs total, sampled {len(sampled)} rows')

    # Determine cell height by aspect of first image
    first = Image.open(sampled[0][1]).convert('RGB')
    aspect = first.height / first.width
    cell_w = args.cell_w
    cell_h = int(cell_w * aspect)
    label_w = 130

    sep_w = 6
    grid_w = label_w + cell_w + sep_w + cell_w
    grid_h = (cell_h + 2) * len(sampled) + 36  # header

    grid = Image.new('RGB', (grid_w, grid_h), (16, 16, 20))
    draw = ImageDraw.Draw(grid)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 13)
        font_big = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 16)
    except Exception:
        font = ImageFont.load_default()
        font_big = font

    # Header row
    draw.text((label_w + 6, 8), 'HOST', fill=(180, 240, 180), font=font_big)
    draw.text((label_w + cell_w + sep_w + 6, 8), 'GUEST', fill=(240, 180, 180), font=font_big)

    y = 36
    for label, host_p, guest_p in sampled:
        h_img = Image.open(host_p).convert('RGB').resize((cell_w, cell_h))
        g_img = Image.open(guest_p).convert('RGB').resize((cell_w, cell_h))
        grid.paste(h_img, (label_w, y))
        grid.paste(g_img, (label_w + cell_w + sep_w, y))
        # Label in left margin, vertically centered
        draw.text((4, y + cell_h // 2 - 8), label, fill=(220, 220, 220), font=font)
        y += cell_h + 2

    grid.save(args.out, 'PNG', optimize=True)
    print(f'wrote {args.out}  size={grid.size}')


if __name__ == '__main__':
    main()
