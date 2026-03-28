"""Tests for OG image generation.

Run: pytest tests/test_og.py -v
"""

import io
import sys
from pathlib import Path

# Ensure server src is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

from PIL import Image  # still used for PNG validation in tests


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
        room_name="Agent 21",
        game_id="ssb64",
        spectate=True,
    )
    assert isinstance(img_bytes, bytes)
    img = Image.open(io.BytesIO(img_bytes))
    assert img.size == (1200, 630)


def test_generate_og_image_spectate_with_players():
    """Generate a watch card showing player matchup."""
    from src.api.og import generate_og_image

    img_bytes = generate_og_image(
        room_name="Agent 21",
        game_id="ssb64",
        spectate=True,
        player_names=["Agent 21", "Player2"],
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


# ── Server route tests (require running server) ──────────────────────────────


def test_og_image_endpoint_no_room(server_url):
    """OG image endpoint returns a PNG even when room doesn't exist (generic card)."""
    import requests

    r = requests.get(f"{server_url}/og-image/NONEXIST.png", timeout=5, verify=False)
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    img = Image.open(io.BytesIO(r.content))
    assert img.size == (1200, 630)


def test_play_html_has_og_tags(server_url):
    """play.html served with OG meta tags injected."""
    import requests

    r = requests.get(f"{server_url}/play.html?room=TESTROOM", timeout=5, verify=False)
    assert r.status_code == 200
    assert 'og:title' in r.text
    assert 'og:image' in r.text
    assert 'twitter:card' in r.text


def test_homepage_has_og_tags(server_url):
    """Homepage served with static OG meta tags."""
    import requests

    r = requests.get(f"{server_url}/", timeout=5, verify=False)
    assert r.status_code == 200
    assert 'og:title' in r.text
    assert 'kaillera-next' in r.text


def test_og_image_no_coep_header(server_url):
    """OG image endpoint must not have COEP header (blocks crawler fetches)."""
    import requests

    r = requests.get(f"{server_url}/og-image/TEST.png", timeout=5, verify=False)
    assert "cross-origin-embedder-policy" not in r.headers
