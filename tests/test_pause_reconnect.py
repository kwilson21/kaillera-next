"""Tests for background pause, DC reconnect, and mobile ROM transfer.

Run: pytest tests/test_pause_reconnect.py -v

Requires: dev server running at localhost:8000, ROM file at ROM_PATH.
"""

import os
import random
import re
import string
import time

import pytest
from playwright.sync_api import expect

ROM_PATH = "/Users/kazon/Downloads/Super Smash Bros. (USA)/Super Smash Bros. (USA).z64"


def _room_id(prefix):
    """Generate a unique room name to avoid stale room conflicts."""
    suffix = "".join(random.choices(string.ascii_uppercase + string.digits, k=4))
    return f"{prefix}{suffix}"


@pytest.fixture(scope="module")
def server_url():
    """Use the already-running dev server (user manages it)."""
    import requests
    url = "http://localhost:8000"
    try:
        r = requests.get(f"{url}/health", timeout=2)
        if r.status_code != 200:
            pytest.skip("Dev server not running on localhost:8000")
    except Exception:
        pytest.skip("Dev server not running on localhost:8000")
    return url


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


def _cleanup(*pages_and_contexts):
    """Navigate pages to about:blank (forces Socket.IO disconnect), then close."""
    for item in pages_and_contexts:
        try:
            if hasattr(item, "goto") and not item.is_closed():
                item.goto("about:blank")
        except Exception:
            pass
    time.sleep(0.3)
    for item in pages_and_contexts:
        try:
            item.close()
        except Exception:
            pass


def _start_lockstep_game(host, guest, server_url, room):
    """Set up a 2-player lockstep game with real ROM, wait for lockstep loop."""
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host",
              wait_until="networkidle")
    expect(host.locator("#overlay")).to_be_visible(timeout=10000)

    guest.goto(f"{server_url}/play.html?room={room}&name=Guest",
               wait_until="networkidle")
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
    ctx = browser.new_context()
    host = ctx.new_page()
    guest = ctx.new_page()

    try:
        _start_lockstep_game(host, guest, server_url, _room_id("P1"))

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
        _cleanup(host, guest, ctx)


def test_reconnect_toast_on_dc_close(browser, server_url):
    """DC death shows toast notifications (no blocking overlay)."""
    ctx = browser.new_context()
    host = ctx.new_page()
    guest = ctx.new_page()

    try:
        _start_lockstep_game(host, guest, server_url, _room_id("RC"))

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

        # Wait for reconnect or timeout (15s) — check for "reconnected" or "dropped" toast
        host.wait_for_function(
            """document.getElementById('toast-container').textContent.includes('reconnected')
               || document.getElementById('toast-container').textContent.includes('dropped')""",
            timeout=20000,
        )
    finally:
        _cleanup(host, guest, ctx)


def test_rom_transfer_mobile_ua(browser, server_url):
    """ROM transfer completes with mobile user agent (smaller chunks)."""
    room = _room_id("MR")
    host_ctx = browser.new_context()
    host = host_ctx.new_page()
    mobile_ctx = browser.new_context(
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                   "AppleWebKit/605.1.15"
    )
    guest = mobile_ctx.new_page()

    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host",
                  wait_until="networkidle")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        _load_rom(host)

        # Enable ROM sharing
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # Guest joins
        guest.goto(f"{server_url}/play.html?room={room}&name=Guest",
                   wait_until="networkidle")
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
        _cleanup(host, guest, host_ctx, mobile_ctx)


def test_paused_peer_input_excluded(browser, server_url):
    """Paused peer is marked as paused on the host side."""
    ctx = browser.new_context()
    host = ctx.new_page()
    guest = ctx.new_page()

    try:
        _start_lockstep_game(host, guest, server_url, _room_id("P2"))

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
        _cleanup(host, guest, ctx)
