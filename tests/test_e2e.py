"""Minimal E2E tests for the MVP P0 flow.

Run: pytest tests/test_e2e.py -v
"""

import re

from playwright.sync_api import expect


def test_lobby_to_play_redirect(page, server_url):
    """Create Room redirects to play.html with correct params."""
    page.goto(server_url)
    page.fill("#player-name", "Host")
    page.click("#create-btn")
    expect(page).to_have_url(re.compile(
        r"play\.html\?room=\w+&host=1&name=Host&mode=lockstep"
    ))


def test_host_guest_start_end(browser, server_url):
    """Full flow: host creates, guest joins, start game, end game."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        # Host creates room
        host.goto(f"{server_url}/play.html?room=E2E01&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        expect(host.locator("#start-btn")).to_be_disabled()

        # Guest joins
        guest.goto(f"{server_url}/play.html?room=E2E01&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        expect(guest.locator("#guest-status")).to_be_visible()

        # Start button enables with 2 players
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)

        # Host starts game
        host.click("#start-btn")
        expect(host.locator("#overlay")).to_be_hidden(timeout=10000)
        expect(guest.locator("#overlay")).to_be_hidden(timeout=10000)
        expect(host.locator("#toolbar")).to_be_visible()

        # Host ends game
        host.click("#toolbar-end")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
    finally:
        host.close()
        guest.close()


def test_host_leave_midgame_closes_room(browser, server_url):
    """When host leaves mid-game, guest gets room-closed and redirects to lobby."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=E2E02&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=E2E02&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)
        expect(guest.locator("#toolbar")).to_be_visible(timeout=10000)

        # Host navigates away (triggers Socket.IO disconnect)
        host.goto("about:blank")

        # Guest should be redirected to lobby (2s toast delay + Socket.IO detection)
        guest.wait_for_url(re.compile(r"/$"), timeout=15000)
    finally:
        if not host.is_closed():
            host.close()
        guest.close()


def test_host_leave_lobby_transfers_ownership(browser, server_url):
    """When host leaves in lobby, room stays open for remaining players."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=E2E03&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=E2E03&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Host leaves via button
        host.click("#leave-btn")
        host.wait_for_url("**/", timeout=10000)

        # Guest should still be in the room (overlay visible, no error)
        expect(guest.locator("#overlay")).to_be_visible(timeout=5000)
        expect(guest.locator("#error-msg")).to_be_hidden()
    finally:
        if not host.is_closed():
            host.close()
        guest.close()


def test_guest_nonexistent_room(page, server_url):
    """Guest joining nonexistent room sees error."""
    page.goto(f"{server_url}/play.html?room=NOROOM&name=Guest")
    expect(page.locator("#error-msg")).to_be_visible(timeout=10000)
