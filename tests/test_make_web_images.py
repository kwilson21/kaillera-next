"""Tests for the landing screenshot conversion pipeline."""

import random
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent.parent))

from scripts.make_web_images import encode


def test_failed_encode_preserves_existing_output(tmp_path):
    """An impossible size budget must not destroy the last good screenshot."""
    source = tmp_path / "noisy.png"
    pixels = random.Random(0).randbytes(32 * 32 * 3)
    Image.frombytes("RGB", (32, 32), pixels).save(source)

    destination = tmp_path / "shot.webp"
    existing = b"existing screenshot"
    destination.write_bytes(existing)

    with pytest.raises(RuntimeError, match="could not fit"):
        encode(source, destination, limit=1)

    assert destination.read_bytes() == existing
    assert not (tmp_path / "shot.webp.tmp").exists()
