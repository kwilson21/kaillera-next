"""Tests for background pause, DC reconnect, and mobile ROM transfer.

Run: pytest tests/test_pause_reconnect.py -v
"""

import re

from playwright.sync_api import expect

ROM_PATH = "/Users/kazon/Downloads/Super Smash Bros. (USA)/Super Smash Bros. (USA).z64"


def _mark_rom_ready(page):
    """Simulate a player having loaded a ROM by emitting rom-ready."""
    page.evaluate("window._socket.emit('rom-ready', { ready: true })")


def _start_lockstep_game(host, guest, server_url, room):
    """Set up a 2-player lockstep game (host + guest in lobby, start game)."""
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
    expect(host.locator("#overlay")).to_be_visible(timeout=10000)

    guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
    expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

    _mark_rom_ready(host)
    _mark_rom_ready(guest)

    expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
    host.click("#start-btn")

    # Wait for game to start (toolbar visible = game running)
    expect(host.locator("#toolbar")).to_be_visible(timeout=10000)
    expect(guest.locator("#toolbar")).to_be_visible(timeout=10000)


def test_pause_toast_on_visibility_change(browser, server_url):
    """Background pause broadcasts pause/resume and shows toasts."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        _start_lockstep_game(host, guest, server_url, "PAUSE01")

        # Simulate guest going to background
        guest.evaluate("""
            Object.defineProperty(document, 'hidden', {
                value: true, configurable: true
            });
            document.dispatchEvent(new Event('visibilitychange'));
        """)

        # Host should see "paused" toast
        host.wait_for_function(
            "document.getElementById('toast-container').textContent.includes('paused')",
            timeout=5000,
        )

        # Simulate guest returning
        guest.evaluate("""
            Object.defineProperty(document, 'hidden', {
                value: false, configurable: true
            });
            document.dispatchEvent(new Event('visibilitychange'));
        """)

        # Host should see "returned" toast
        host.wait_for_function(
            "document.getElementById('toast-container').textContent.includes('returned')",
            timeout=5000,
        )
    finally:
        host.close()
        guest.close()


def test_reconnect_overlay_on_dc_close(browser, server_url):
    """Reconnect overlay appears when DataChannel dies."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        _start_lockstep_game(host, guest, server_url, "RECON01")

        # Wait for DC to be established
        guest.wait_for_function(
            "window._peers && Object.keys(window._peers).length > 0",
            timeout=10000,
        )

        # Kill guest's DataChannel
        guest.evaluate("""
            var peers = Object.values(window._peers);
            if (peers.length > 0 && peers[0].dc) {
                peers[0].dc.close();
            }
        """)

        # Guest should see reconnect overlay
        expect(guest.locator("#reconnect-overlay")).not_to_have_class(
            re.compile(r"hidden"), timeout=15000
        )

        # Host should see "disconnected" or "reconnecting" toast
        host.wait_for_function(
            """document.getElementById('toast-container').textContent.includes('disconnected')
               || document.getElementById('toast-container').textContent.includes('reconnecting')""",
            timeout=10000,
        )

        # Wait for reconnect attempt to resolve (success or timeout)
        # Either overlay disappears (reconnect success) or rejoin button appears (timeout)
        guest.wait_for_function(
            """document.getElementById('reconnect-overlay').classList.contains('hidden')
               || !document.getElementById('reconnect-rejoin').classList.contains('hidden')""",
            timeout=20000,
        )
    finally:
        host.close()
        guest.close()


def test_rom_transfer_mobile_ua(browser, server_url):
    """ROM transfer completes with mobile user agent (smaller chunks)."""
    host = browser.new_page()
    mobile_ctx = browser.new_context(
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                   "AppleWebKit/605.1.15"
    )
    guest = mobile_ctx.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=MOBROM01&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Host loads ROM via file chooser
        with host.expect_file_chooser() as fc_info:
            host.click("#rom-drop")
        fc_info.value.set_files(ROM_PATH)

        # Wait for ROM to load
        host.wait_for_function(
            "document.querySelector('#rom-status') && "
            "document.querySelector('#rom-status').textContent.includes('Loaded')",
            timeout=15000,
        )

        # Enable ROM sharing
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # Guest joins
        guest.goto(f"{server_url}/play.html?room=MOBROM01&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Guest accepts ROM sharing
        expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)
        guest.click("#rom-accept-btn")

        # Mark host ROM ready and start game
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")

        # Wait for ROM transfer to complete (guest sees "ROM loaded from host" toast)
        guest.wait_for_function(
            "document.getElementById('toast-container').textContent.includes('ROM loaded from host')",
            timeout=60000,
        )
    finally:
        host.close()
        guest.close()
        mobile_ctx.close()


def test_paused_peer_input_excluded(browser, server_url):
    """Paused peer's input is excluded — host game doesn't stall."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        _start_lockstep_game(host, guest, server_url, "PAUSE02")

        # Wait for lockstep to be active (if emulator is running)
        # Since we don't have a real emulator, check that the engine was initialized
        host.wait_for_function(
            "window._peers && Object.keys(window._peers).length > 0",
            timeout=10000,
        )

        # Record initial frame (if available)
        initial_frame = host.evaluate(
            "typeof window._frameNum === 'number' ? window._frameNum : -1"
        )

        # Simulate guest going to background
        guest.evaluate("""
            Object.defineProperty(document, 'hidden', {
                value: true, configurable: true
            });
            document.dispatchEvent(new Event('visibilitychange'));
        """)

        # Wait a moment, then check peer is marked as paused
        host.wait_for_function(
            """(() => {
                var peers = Object.values(window._peers || {});
                return peers.length > 0 && peers[0].paused === true;
            })()""",
            timeout=5000,
        )

        # If lockstep is running, verify frames advance (game not stalled)
        if initial_frame >= 0:
            import time
            time.sleep(2)
            later_frame = host.evaluate("window._frameNum")
            assert later_frame > initial_frame, (
                f"Game stalled: frame stayed at {initial_frame}"
            )

        # Simulate guest returning
        guest.evaluate("""
            Object.defineProperty(document, 'hidden', {
                value: false, configurable: true
            });
            document.dispatchEvent(new Event('visibilitychange'));
        """)

        # Verify peer is no longer paused
        host.wait_for_function(
            """(() => {
                var peers = Object.values(window._peers || {});
                return peers.length > 0 && peers[0].paused === false;
            })()""",
            timeout=5000,
        )
    finally:
        host.close()
        guest.close()
