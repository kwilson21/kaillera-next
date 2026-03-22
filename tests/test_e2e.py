"""Minimal E2E tests for the MVP P0 flow.

Run: pytest tests/test_e2e.py -v
"""

import re

from playwright.sync_api import expect


def _mark_rom_ready(page):
    """Simulate a player having loaded a ROM by emitting rom-ready."""
    page.evaluate("window._socket.emit('rom-ready', { ready: true })")


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

        # Mark both players as ROM-ready
        _mark_rom_ready(host)
        _mark_rom_ready(guest)

        # Start button enables with 2 players + ROMs
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

        _mark_rom_ready(host)
        _mark_rom_ready(guest)

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


# ── ROM Sharing Tests ──────────────────────────────────────────────────


def test_rom_sharing_prompt_appears(browser, server_url):
    """When host enables ROM sharing, joiners see accept/decline prompt."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS01&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=ROMS01&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Host marks ROM ready and enables sharing
        _mark_rom_ready(host)
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # Guest should see the accept/decline prompt (not the ROM drop zone)
        expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)
        expect(guest.locator("#rom-drop")).to_be_hidden()

        # Verify prompt text
        expect(guest.locator(".rom-sharing-prompt-text")).to_contain_text(
            "offering to share"
        )
    finally:
        host.close()
        guest.close()


def test_rom_sharing_decline_shows_drop_zone(browser, server_url):
    """When joiner declines ROM sharing, ROM drop zone reappears."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS02&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=ROMS02&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Host enables sharing
        _mark_rom_ready(host)
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # Wait for prompt
        expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)

        # Guest declines
        guest.click("#rom-decline-btn")

        # ROM drop zone should reappear, prompt hidden
        expect(guest.locator("#rom-drop")).to_be_visible(timeout=5000)
        expect(guest.locator("#rom-sharing-prompt")).to_be_hidden()
    finally:
        host.close()
        guest.close()


def test_rom_sharing_start_gated_without_roms(browser, server_url):
    """Host cannot start game when not all players have ROMs and sharing is off."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS03&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=ROMS03&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Only host has ROM
        _mark_rom_ready(host)

        # Start button should show waiting for ROMs
        expect(host.locator("#start-btn")).to_be_disabled(timeout=10000)
        expect(host.locator("#start-btn")).to_contain_text("Waiting for ROMs")

        # Guest loads ROM
        _mark_rom_ready(guest)

        # Now start button should be enabled
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        expect(host.locator("#start-btn")).to_contain_text("Start Game")
    finally:
        host.close()
        guest.close()


def test_rom_sharing_bypasses_rom_requirement(browser, server_url):
    """When host enables sharing, start game is allowed even if guests have no ROM."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS04&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=ROMS04&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Only host has ROM
        _mark_rom_ready(host)

        # Without sharing: disabled
        expect(host.locator("#start-btn")).to_be_disabled(timeout=10000)

        # Enable sharing
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # With sharing: enabled (server allows it)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
    finally:
        host.close()
        guest.close()


def test_rom_sharing_joiner_after_toggle(browser, server_url):
    """Joiner who connects after host enables sharing sees the prompt immediately."""
    host = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS05&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Host enables sharing BEFORE guest joins
        _mark_rom_ready(host)
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # Now guest joins
        guest = browser.new_page()
        try:
            guest.goto(f"{server_url}/play.html?room=ROMS05&name=Guest")
            expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

            # Guest should see the prompt (from users-updated romSharing field)
            expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)
            expect(guest.locator("#rom-drop")).to_be_hidden()
        finally:
            guest.close()
    finally:
        host.close()


def test_host_disclaimer_visible(browser, server_url):
    """Host sees legal disclaimer when sharing checkbox is checked."""
    host = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS06&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Disclaimer hidden by default
        expect(host.locator("#rom-sharing-disclaimer")).to_be_hidden()

        # Enable sharing
        _mark_rom_ready(host)
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # Disclaimer visible
        expect(host.locator("#rom-sharing-disclaimer")).to_be_visible(timeout=5000)
        expect(host.locator("#rom-sharing-disclaimer")).to_contain_text(
            "legal right to distribute"
        )
    finally:
        host.close()
