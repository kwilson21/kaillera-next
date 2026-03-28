"""E2E tests for OG card meta tags and image endpoint.

Run: pytest tests/test_og_e2e.py -v
"""

import re

import requests


def test_homepage_og_tags(server_url):
    """Homepage has OG meta tags."""
    r = requests.get(f"{server_url}/", timeout=5, verify=False)
    assert r.status_code == 200
    assert 'property="og:title" content="kaillera-next"' in r.text
    assert re.search(r'property="og:description" content=".*Play retro games online', r.text)
    assert re.search(r'property="og:image" content=".*?/static/og/home\.png"', r.text)


def test_play_invite_og_tags(server_url):
    """Play invite link has dynamic OG meta tags."""
    r = requests.get(f"{server_url}/play.html?room=TESTROOM", timeout=5, verify=False)
    assert r.status_code == 200
    assert re.search(r'property="og:title" content=".*Ready to fight', r.text)
    assert re.search(r'property="og:image" content=".*?/og-image/TESTROOM\.png"', r.text)
    assert 'name="twitter:card" content="summary_large_image"' in r.text


def test_watch_invite_og_tags(server_url):
    """Watch invite has watch text in title and spectate param in image URL."""
    r = requests.get(f"{server_url}/play.html?room=TESTROOM&spectate=1", timeout=5, verify=False)
    assert r.status_code == 200
    assert re.search(r'property="og:title" content=".*Come watch', r.text)
    assert re.search(r'property="og:image" content=".*spectate=1"', r.text)


def test_og_image_loads(server_url):
    """OG image endpoint returns a loadable PNG image."""
    r = requests.get(f"{server_url}/og-image/ANYROOM.png", timeout=10, verify=False)
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert len(r.content) > 1000
