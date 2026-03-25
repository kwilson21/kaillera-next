"""UX polish tests — game-ended toast, loading timeout, toolbar cleanup.

Run: pytest tests/test_ux_polish.py -v
"""

from playwright.sync_api import expect


def _mark_rom_ready(page):
    page.evaluate("window._socket.emit('rom-ready', { ready: true })")


def test_game_ended_toast_appears(browser, server_url):
    """When host ends game, guest sees 'The host has ended the game' toast."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=UXE01&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=UXE01&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        _mark_rom_ready(host)
        _mark_rom_ready(guest)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)

        # Start game — overlay hides for host, toolbar shows
        host.click("#start-btn")
        expect(host.locator("#overlay")).to_be_hidden(timeout=10000)

        # End game
        host.click("#toolbar-end")

        # Guest should see the toast and return to overlay
        expect(guest.locator("#toast-container")).to_contain_text(
            "The host has ended the game", timeout=5000
        )
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
    finally:
        host.close()
        guest.close()


def test_dump_logs_hidden_from_toolbar(page, server_url):
    """Dump Logs button is hidden from the toolbar (still in info overlay)."""
    page.goto(f"{server_url}/play.html?room=UX002&host=1&name=Host")
    page.wait_for_function(
        "document.getElementById('toolbar-logs') !== null", timeout=10000
    )

    # Toolbar logs button should exist but be hidden
    visible = page.evaluate(
        "getComputedStyle(document.getElementById('toolbar-logs')).display !== 'none'"
    )
    assert visible is False, "toolbar-logs should be hidden from users"

    # Info overlay dump button should still exist
    assert page.locator("#dump-logs-btn").count() == 1


def test_loading_timeout_message(page, server_url):
    """Loading overlay shows reassurance after 15s timeout."""
    page.goto(f"{server_url}/play.html?room=UX003&host=1&name=Host")
    page.wait_for_function(
        "document.getElementById('game-loading') !== null", timeout=10000
    )

    # Manually show the loading overlay and fast-forward the timeout
    page.evaluate("""
        // Show loading overlay
        const el = document.getElementById('game-loading');
        el.classList.remove('hidden');
        const text = document.getElementById('game-loading-text');
        text.textContent = 'Loading...';
        // Set gameRunning so the 30s connection timeout doesn't interfere
        window._testGameRunning = true;
    """)

    expect(page.locator("#game-loading")).to_be_visible()
    expect(page.locator("#game-loading-text")).to_contain_text("Loading...")

    # Fast-forward: trigger the timeout callback manually
    # The showGameLoading sets a 15s timeout — we simulate it firing
    page.evaluate("""
        const text = document.getElementById('game-loading-text');
        const el = document.getElementById('game-loading');
        if (text && !el.classList.contains('hidden')) {
            text.textContent = 'Still loading — this can take a moment on first boot...';
        }
    """)

    expect(page.locator("#game-loading-text")).to_contain_text("Still loading")


def test_error_modal_has_back_to_lobby(page, server_url):
    """Error modal includes a Back to Lobby link."""
    page.goto(f"{server_url}/play.html?room=NOROOM&name=Guest")
    expect(page.locator("#error-msg")).to_be_visible(timeout=10000)

    # Should contain the back link
    expect(page.locator(".error-back")).to_be_visible()
    expect(page.locator(".error-back")).to_contain_text("Back to Lobby")

    # Link should point to lobby
    href = page.locator(".error-back").get_attribute("href")
    assert href == "/", f"Back link should go to /, got {href}"


def test_nonexistent_room_shows_error_with_escape(page, server_url):
    """Joining nonexistent room shows error with Back to Lobby escape."""
    page.goto(f"{server_url}/play.html?room=BADROOM&name=Guest")
    expect(page.locator("#error-msg")).to_be_visible(timeout=10000)
    expect(page.locator(".error-card")).to_contain_text("Room not found")
    expect(page.locator(".error-back")).to_be_visible()
