"""Tests for OG card serving.

OG cards are now prebuilt static PNGs in web/static/og/cards/. The runtime
server has no browser dependency. Generation lives in
scripts/generate_og_cards.py and runs at build time.

Run: pytest tests/test_og.py -v
"""

import io
import sys
from pathlib import Path

# Ensure server src is importable
sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

from PIL import Image  # validates PNG dimensions of the prebuilt cards

REPO_ROOT = Path(__file__).resolve().parent.parent
CARDS_DIR = REPO_ROOT / "web" / "static" / "og" / "cards"


def test_static_cards_exist_for_all_games():
    """Every game in GAME_INFO must have prebuilt play+watch cards on disk."""
    from src.api.og import GAME_INFO

    for game_id in GAME_INFO:
        for suffix in ("play", "watch"):
            card = CARDS_DIR / f"{game_id}-{suffix}.png"
            assert card.exists(), f"missing OG card: {card}"
            img = Image.open(card)
            assert img.size == (1200, 630)
            assert img.format == "PNG"


def test_homepage_card_exists():
    """Homepage card (no game) must exist."""
    home = REPO_ROOT / "web" / "static" / "og" / "home.png"
    assert home.exists()
    img = Image.open(home)
    assert img.size == (1200, 630)


def test_build_og_tags_points_at_static_per_game_card():
    """Recognized game_id → /static/og/cards/{game}-{play|watch}.png."""
    from src.api.og import build_og_tags

    tags = build_og_tags("example.com", room_id="ABC123", room_name="Alice", game_id="ssb64", spectate=False)
    assert "/static/og/cards/ssb64-play.png" in tags

    tags = build_og_tags("example.com", room_id="ABC123", room_name="Alice", game_id="ssb64", spectate=True)
    assert "/static/og/cards/ssb64-watch.png" in tags


def test_build_og_tags_falls_back_to_home_for_unknown_game():
    """Unknown game_id → home.png fallback (no per-game card)."""
    from src.api.og import build_og_tags

    tags = build_og_tags("example.com", room_id="ABC123", room_name="Alice", game_id="unknown_game", spectate=False)
    assert "/static/og/home.png" in tags
    assert "/static/og/cards/" not in tags


# ── Server route tests (require running server) ──────────────────────────


def test_play_html_has_og_tags(server_url):
    """play.html served with OG meta tags injected."""
    import requests

    r = requests.get(f"{server_url}/play.html?room=TESTROOM", timeout=5, verify=False)
    assert r.status_code == 200
    assert "og:title" in r.text
    assert "og:image" in r.text
    assert "twitter:card" in r.text


def test_homepage_has_og_tags(server_url):
    """Homepage served with static OG meta tags."""
    import requests

    r = requests.get(f"{server_url}/", timeout=5, verify=False)
    assert r.status_code == 200
    assert "og:title" in r.text
    assert "kaillera-next" in r.text


def test_static_card_no_coep_header(server_url):
    """Static OG cards must not have COEP header (blocks crawler fetches)."""
    import requests

    r = requests.get(f"{server_url}/static/og/cards/ssb64-play.png", timeout=10, verify=False)
    assert r.status_code == 200
    assert "cross-origin-embedder-policy" not in r.headers
    img = Image.open(io.BytesIO(r.content))
    assert img.size == (1200, 630)
