"""E2E tests for OG card meta tags and the card images they point at.

Invite cards are prebuilt per game (scripts/generate_og_cards.py) and served
as static files from /static/og/cards/; see server/src/api/og.py.

Run: pytest tests/test_og_e2e.py -v
"""

import io
import re
from urllib.parse import urlsplit

import requests
from PIL import Image


def _og(html: str, prop: str) -> str | None:
    m = re.search(rf'property="og:{prop}" content="([^"]*)"', html)
    return m.group(1) if m else None


def test_homepage_og_tags(server_url):
    """Homepage has OG meta tags."""
    r = requests.get(f"{server_url}/", timeout=5, verify=False)
    assert r.status_code == 200
    assert 'property="og:title" content="kaillera-next"' in r.text
    assert re.search(r'property="og:description" content=".*Play retro games online', r.text)
    assert re.search(r'property="og:image" content=".*?/static/og/home\.png"', r.text)


def test_play_invite_og_tags(server_url):
    """Play invite link has dynamic OG meta tags: the room in the title, the game's play card as image."""
    r = requests.get(f"{server_url}/play.html?room=TESTROOM&game=ssb64", timeout=5, verify=False)
    assert r.status_code == 200
    assert re.search(r'property="og:title" content=".*Ready to fight\? TESTROOM is waiting', r.text)
    assert re.search(r'property="og:image" content=".*?/static/og/cards/ssb64-play\.jpg"', r.text)
    assert 'property="og:image:type" content="image/jpeg"' in r.text
    assert re.search(r'property="og:url" content=".*?/play\.html\?room=TESTROOM&amp;game=ssb64"', r.text)
    assert 'name="twitter:card" content="summary_large_image"' in r.text


def test_watch_invite_og_tags(server_url):
    """Watch invite has watch text in title, the game's watch card as image, and spectate=1 in its URL."""
    r = requests.get(f"{server_url}/play.html?room=TESTROOM&game=ssb64&spectate=1", timeout=5, verify=False)
    assert r.status_code == 200
    assert re.search(r'property="og:title" content=".*Come watch', r.text)
    assert re.search(r'property="og:image" content=".*?/static/og/cards/ssb64-watch\.jpg"', r.text)
    assert re.search(r'property="og:url" content=".*spectate=1"', r.text)


def test_og_image_loads(server_url):
    """The image each invite's og:image names is served as a loadable 1200x630 image."""
    for query in ("room=ANYROOM&game=ssb64", "room=ANYROOM&game=ssb64&spectate=1", "room=ANYROOM"):
        page = requests.get(f"{server_url}/play.html?{query}", timeout=5, verify=False)
        assert page.status_code == 200
        image_url = _og(page.text, "image")
        assert image_url, f"no og:image for {query}"
        # The tag names the public https origin; fetch the same path from the test server.
        r = requests.get(f"{server_url}{urlsplit(image_url).path}", timeout=10, verify=False)
        assert r.status_code == 200, f"{image_url} -> {r.status_code}"
        assert r.headers["content-type"] == _og(page.text, "image:type")
        assert len(r.content) > 1000
        assert Image.open(io.BytesIO(r.content)).size == (1200, 630)
