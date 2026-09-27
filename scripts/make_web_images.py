"""Prepare landing screenshots as size-bounded WebP images.

Usage: python scripts/make_web_images.py CAPTURE_DIR
The directory may instead be supplied as KN_CAPTURE_DIR. Files whose stem
contains ``photo`` receive the 120 KiB budget; other captures receive 60 KiB.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "web" / "static" / "shots"
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}


def encode(source: Path, destination: Path, limit: int) -> tuple[int, int, int]:
    with Image.open(source) as opened:
        image = ImageOps.exif_transpose(opened).convert("RGB")
    scale = 1.0
    while scale >= 0.35:
        candidate = (
            image
            if scale == 1
            else image.resize(
                (
                    max(1, round(image.width * scale)),
                    max(1, round(image.height * scale)),
                ),
                Image.Resampling.LANCZOS,
            )
        )
        for quality in range(86, 34, -4):
            destination.parent.mkdir(parents=True, exist_ok=True)
            candidate.save(destination, "WEBP", quality=quality, method=6)
            size = destination.stat().st_size
            if size <= limit:
                return candidate.width, candidate.height, size
        scale *= 0.85
    destination.unlink(missing_ok=True)
    raise RuntimeError(f"could not fit {source.name} within {limit // 1024} KiB")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "captures", nargs="?", help="directory containing source captures"
    )
    args = parser.parse_args()
    raw = args.captures or os.environ.get("KN_CAPTURE_DIR")
    if not raw:
        parser.error("provide CAPTURE_DIR or set KN_CAPTURE_DIR")
    source_dir = Path(raw).expanduser()
    if not source_dir.is_dir():
        parser.error(f"not a directory: {source_dir}")
    sources = sorted(
        p
        for p in source_dir.iterdir()
        if p.is_file() and p.suffix.lower() in EXTENSIONS
    )
    if not sources:
        parser.error(f"no supported images in {source_dir}")
    for source in sources:
        limit = (120 if "photo" in source.stem.lower() else 60) * 1024
        destination = OUTPUT / f"{source.stem}.webp"
        width, height, size = encode(source, destination, limit)
        print(f"{destination.relative_to(ROOT)}: {width}x{height}, {size} bytes")


if __name__ == "__main__":
    main()
