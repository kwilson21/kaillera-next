"""Tests for background pause, DC reconnect, and mobile ROM transfer.

Run: pytest tests/test_pause_reconnect.py -v

Requires: dev server running at localhost:8000, ROM file at ROM_PATH.
"""

import os
import re
import time

import pytest
from playwright.sync_api import expect

ROM_PATH = "/Users/kazon/Downloads/Super Smash Bros. (USA)/Super Smash Bros. (USA).z64"


@pytest.fixture(autouse=True)
def _require_rom():
    """Skip all tests if ROM file is not available."""
    if not os.path.exists(ROM_PATH):
        pytest.skip(f"ROM file not found: {ROM_PATH}")


def _load_rom(page):
    """Load the real ROM via file chooser."""
    with page.expect_file_chooser() as fc_info:
        page.click("#rom-drop")
    fc_info.value.set_files(ROM_PATH)
    page.wait_for_function(
        "document.querySelector('#rom-status') && "
        "document.querySelector('#rom-status').textContent.includes('Loaded')",
        timeout=15000,
    )


def _start_lockstep_game(host, guest, server_url, room):
    """Set up a 2-player lockstep game with real ROM, wait for lockstep loop."""
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
    expect(host.locator("#overlay")).to_be_visible(timeout=10000)

    guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
    expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

    _load_rom(host)
    _load_rom(guest)

    expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
    host.click("#start-btn")

    # Wait for game to start (toolbar visible)
    expect(host.locator("#toolbar")).to_be_visible(timeout=15000)
    expect(guest.locator("#toolbar")).to_be_visible(timeout=15000)

    # Wait for lockstep loop to actually start (emulator booted, synced)
    host.wait_for_function("window._lockstepActive === true", timeout=30000)
    guest.wait_for_function("window._lockstepActive === true", timeout=30000)

    # Wait for DCs to be open
    host.wait_for_function(
        """window._peers && Object.values(window._peers).some(function(p) {
            return p.dc && p.dc.readyState === 'open';
        })""",
        timeout=10000,
    )


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

        # Pause broadcast is debounced by 500ms
        time.sleep(0.8)

        # Host should see "paused" toast
        host.wait_for_function(
            "document.getElementById('toast-container').textContent.includes('paused')",
            timeout=5000,
        )

        # Simulate guest returning (>500ms later to trigger resume path)
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

        # Kill guest's DataChannel (only DC in 2-player game)
        guest.evaluate("""
            var peers = Object.values(window._peers);
            for (var i = 0; i < peers.length; i++) {
                if (peers[i].dc) peers[i].dc.close();
            }
        """)

        # Host should see "disconnected" or "reconnecting" toast
        host.wait_for_function(
            """document.getElementById('toast-container').textContent.includes('disconnected')
               || document.getElementById('toast-container').textContent.includes('reconnecting')""",
            timeout=10000,
        )

        # Guest's reconnect overlay should appear (all DCs dead)
        expect(guest.locator("#reconnect-overlay")).not_to_have_class(
            re.compile(r"hidden"), timeout=15000
        )

        # Wait for reconnect to resolve — overlay disappears or rejoin appears
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

        _load_rom(host)

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

        # Start game
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")

        # Wait for ROM transfer to complete
        guest.wait_for_function(
            "document.getElementById('toast-container').textContent.includes('ROM loaded from host')",
            timeout=60000,
        )
    finally:
        host.close()
        guest.close()
        mobile_ctx.close()


def test_paused_peer_input_excluded(browser, server_url):
    """Paused peer is marked as paused on the host side."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        _start_lockstep_game(host, guest, server_url, "PAUSE02")

        # Record frame number
        initial_frame = host.evaluate("window._frameNum")

        # Simulate guest going to background
        guest.evaluate("""
            Object.defineProperty(document, 'hidden', {
                value: true, configurable: true
            });
            document.dispatchEvent(new Event('visibilitychange'));
        """)

        # Wait for debounced pause broadcast
        time.sleep(0.8)

        # Verify peer is marked as paused on host side
        host.wait_for_function(
            """(() => {
                var peers = Object.values(window._peers || {});
                return peers.length > 0 && peers[0].paused === true;
            })()""",
            timeout=5000,
        )

        # Verify host game continues (frames advance despite paused peer)
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
