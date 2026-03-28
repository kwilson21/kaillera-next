"""Playwright E2E tests for OG card meta tags.

Run: pytest tests/test_og_e2e.py -v
"""

import re

from playwright.sync_api import expect


def test_homepage_og_tags(page, server_url):
    """Homepage has OG meta tags."""
    page.goto(f"{server_url}/")
    og_title = page.locator('meta[property="og:title"]')
    expect(og_title).to_have_attribute("content", "kaillera-next")
    og_desc = page.locator('meta[property="og:description"]')
    expect(og_desc).to_have_attribute("content", re.compile(r"Play retro games online"))
    og_image = page.locator('meta[property="og:image"]')
    expect(og_image).to_have_attribute("content", re.compile(r"/static/og/home\.png"))


def test_play_invite_og_tags(page, server_url):
    """Play invite link has dynamic OG meta tags."""
    page.goto(f"{server_url}/play.html?room=TESTROOM")
    og_title = page.locator('meta[property="og:title"]')
    expect(og_title).to_have_attribute("content", re.compile(r"Join"))
    og_image = page.locator('meta[property="og:image"]')
    expect(og_image).to_have_attribute("content", re.compile(r"/og-image/TESTROOM\.png"))
    twitter = page.locator('meta[name="twitter:card"]')
    expect(twitter).to_have_attribute("content", "summary_large_image")


def test_watch_invite_og_tags(page, server_url):
    """Watch invite has WATCH in title and spectate param in image URL."""
    page.goto(f"{server_url}/play.html?room=TESTROOM&spectate=1")
    og_title = page.locator('meta[property="og:title"]')
    expect(og_title).to_have_attribute("content", re.compile(r"Watch"))
    og_image = page.locator('meta[property="og:image"]')
    expect(og_image).to_have_attribute("content", re.compile(r"spectate=1"))


def test_og_image_loads(page, server_url):
    """OG image endpoint returns a loadable image."""
    response = page.request.get(f"{server_url}/og-image/ANYROOM.png")
    assert response.status == 200
    assert response.headers["content-type"] == "image/png"
    assert len(response.body()) > 1000
