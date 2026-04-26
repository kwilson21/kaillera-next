#!/usr/bin/env python3
"""Build side-by-side host|guest composite screenshots for vision-model review.

Pairs files matching /tmp/det-live-NNN-hfX-gfY-host.png with their guest twin,
glues them horizontally with a labeled separator, and writes
/tmp/composite-NNN-hfX-gfY.png. Subsamples to ~12 evenly-spaced pairs by
default (controllable via --max) so a vision model can read the whole match
arc in one batch.

Usage:
  python tools/composite_screenshots.py [--dir /tmp] [--max 12] [--out /tmp]
"""
import argparse
import glob
import os
import re
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print('pillow required: uv pip install Pillow', file=sys.stderr)
    sys.exit(1)


def find_pairs(directory: str) -> list[tuple[str, Path, Path]]:
    files = sorted(glob.glob(f'{directory}/det-live-*-host.png'))
    pairs = []
    for host_p in files:
        guest_p = host_p.replace('-host.png', '-guest.png')
        if not os.path.exists(guest_p):
            continue
        m = re.search(r'det-live-(\d+)-hf(\d+)-gf(\d+)', host_p)
        label = f'{m.group(1)}-hf{m.group(2)}-gf{m.group(3)}' if m else os.path.basename(host_p)
        pairs.append((label, Path(host_p), Path(guest_p)))
    return pairs


def make_composite(host_p: Path, guest_p: Path, label: str, out_p: Path) -> None:
    h_img = Image.open(host_p).convert('RGB')
    g_img = Image.open(guest_p).convert('RGB')
    # Normalize heights
    H = max(h_img.height, g_img.height)
    if h_img.height != H:
        h_img = h_img.resize((int(h_img.width * H / h_img.height), H))
    if g_img.height != H:
        g_img = g_img.resize((int(g_img.width * H / g_img.height), H))

    # Header bar with label
    bar_h = 28
    sep_w = 4
    W = h_img.width + sep_w + g_img.width
    out = Image.new('RGB', (W, H + bar_h), (24, 24, 28))
    out.paste(h_img, (0, bar_h))
    out.paste(g_img, (h_img.width + sep_w, bar_h))

    draw = ImageDraw.Draw(out)
    try:
        font = ImageFont.truetype('/System/Library/Fonts/Menlo.ttc', 14)
    except Exception:
        font = ImageFont.load_default()
    draw.text((6, 6), f'HOST  ({label})', fill=(220, 240, 220), font=font)
    draw.text((h_img.width + sep_w + 6, 6), f'GUEST  ({label})', fill=(240, 220, 220), font=font)

    out.save(out_p, 'PNG', optimize=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', default='/tmp')
    ap.add_argument('--out', default='/tmp')
    ap.add_argument('--max', type=int, default=12, help='subsample to at most N composites')
    args = ap.parse_args()

    pairs = find_pairs(args.dir)
    if not pairs:
        print(f'No det-live-*-{{host,guest}}.png pairs in {args.dir}', file=sys.stderr)
        sys.exit(1)

    print(f'Found {len(pairs)} pairs total.')
    if len(pairs) > args.max:
        step = len(pairs) // args.max
        sampled = pairs[::step][: args.max]
        print(f'Subsampled to {len(sampled)} (every {step}th).')
    else:
        sampled = pairs

    for label, host_p, guest_p in sampled:
        out_p = Path(args.out) / f'composite-{label}.png'
        make_composite(host_p, guest_p, label, out_p)
        print(f'  → {out_p}')


if __name__ == '__main__':
    main()
