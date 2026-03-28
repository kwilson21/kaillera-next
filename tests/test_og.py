"""Tests for OG image generation.

Run: pytest tests/test_og.py -v
"""

import io
import sys
from pathlib import Path

# Ensure server src is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

from PIL import Image


def test_generate_og_image_with_game():
    """Generate a play invite card with game background."""
    from src.api.og import generate_og_image

    img_bytes = generate_og_image(
        room_name="Agent 21's room",
        game_id="ssb64",
        spectate=False,
    )
    assert isinstance(img_bytes, bytes)
    assert len(img_bytes) > 0
    img = Image.open(io.BytesIO(img_bytes))
    assert img.size == (1200, 630)
    assert img.format == "PNG"


def test_generate_og_image_spectate():
    """Generate a watch invite card."""
    from src.api.og import generate_og_image

    img_bytes = generate_og_image(
        room_name="Agent 21's room",
        game_id="ssb64",
        spectate=True,
    )
    assert isinstance(img_bytes, bytes)
    img = Image.open(io.BytesIO(img_bytes))
    assert img.size == (1200, 630)


def test_generate_og_image_unknown_game():
    """Generate a generic card for unknown game_id."""
    from src.api.og import generate_og_image

    img_bytes = generate_og_image(
        room_name="Test Room",
        game_id="unknown_game",
        spectate=False,
    )
    assert isinstance(img_bytes, bytes)
    img = Image.open(io.BytesIO(img_bytes))
    assert img.size == (1200, 630)


def test_generate_og_image_homepage():
    """Generate homepage card (no room info)."""
    from src.api.og import generate_og_image

    img_bytes = generate_og_image(
        room_name=None,
        game_id=None,
        spectate=False,
    )
    assert isinstance(img_bytes, bytes)
    img = Image.open(io.BytesIO(img_bytes))
    assert img.size == (1200, 630)
