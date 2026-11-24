"""Tests for background pause, DC reconnect, and mobile ROM transfer.

Run: pytest tests/test_pause_reconnect.py -v

Requires KN_ROM, the ROM's path. The server is the one tests/conftest.py starts
when none is running.
"""

import os
import random
import re
import string
import time

import pytest
from playwright.sync_api import expect

ROM_PATH = os.environ.get("KN_ROM", "")


def _room_id(prefix):
    """Generate a unique room name to avoid stale room conflicts."""
    suffix = "".join(random.choices(string.ascii_uppercase + string.digits, k=4))
    return f"{prefix}{suffix}"


@pytest.fixture(autouse=True)
def _require_rom():
    """Skip all tests if ROM file is not available."""
    if not ROM_PATH:
        pytest.skip("needs a ROM: set KN_ROM to the path of the SSB64 (USA) .z64")
    if not os.path.isfile(ROM_PATH):
        pytest.skip(f"KN_ROM is not a file: {ROM_PATH}")


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
                item.once("dialog", lambda dialog: dialog.accept())
                item.goto("about:blank")
        except Exception:
            pass
    time.sleep(0.3)
    for item in pages_and_contexts:
        try:
            item.close()
        except Exception:
            pass


def _start_lockstep_game(host, guest, server_url, room, start_game):
    """Set up a 2-player lockstep game with real ROM, wait for lockstep loop."""
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host",
              wait_until="networkidle")
    expect(host.locator("#overlay")).to_be_visible(timeout=10000)

    guest.goto(f"{server_url}/play.html?room={room}&name=Guest",
               wait_until="networkidle")
    expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

    _load_rom(host)
    _load_rom(guest)

    # Start, and wait for the lockstep loop to run on both (emulator booted, synced)
    start_game(host, guest)

    # Wait for DCs to be open
    host.wait_for_function(
        """window.KNState.peers && Object.values(window.KNState.peers).some(function(p) {
            return p.dc && p.dc.readyState === 'open';
        })""",
        timeout=10000,
    )


@pytest.mark.parametrize("mode", ["rollback", "lockstep"])
@pytest.mark.parametrize("first_loss", ["signaling", "game"])
def test_running_guest_waits_for_an_absent_host(browser, server_url, room, start_game, mode, first_loss):
    frame = "window.EJS_emulator.gameManager.Module._kn_get_frame()"
    host_channel = "Object.values(KNState.peers || {}).some(p => p.slot === 0 && p.dc?.readyState === 'open')"
    with browser.new_context() as creator, browser.new_context() as player:
        host, guest = creator.new_page(), player.new_page()
        url = f"{server_url}/play.html?room={room}"
        host.goto(f"{url}&host=1&name=Host&mode={mode}")
        expect(host.locator("#host-controls")).to_be_visible()
        guest.goto(f"{url}&name=Guest")
        guest.wait_for_function("window.KNState?.slot === 1")
        for page in (host, guest):
            _load_rom(page)
        start_game(host, guest)
        guest.wait_for_function(f"{frame} > 120 && {host_channel}", timeout=30000)
        match = guest.evaluate("KNState.matchId")
        assert guest.request.get(f"{server_url}/room/{room}").json()["mode"] == mode
        timer = guest.locator("#host-wait-banner [role=timer]")
        status = guest.locator("#host-wait-banner [role=status]")

        if first_loss == "signaling":
            host.evaluate("window.__test_socket.disconnect()")
            expect(timer).to_be_visible()
            expect(status).to_contain_text("game connection is still active")
            healthy = guest.evaluate(frame)
            guest.wait_for_function(f"before => {frame} >= before + 12 && {host_channel}", arg=healthy)
            # A remote tab can disappear while local WebRTC still reports an open channel.
            host.evaluate("RTCDataChannel.prototype.send = function () {}")
            expect(status).to_contain_text("Waiting for them to return", timeout=10000)
            assert guest.evaluate(host_channel)
            held = guest.evaluate(frame)
            guest.wait_for_timeout(1500)
            assert guest.evaluate(frame) == held
        else:
            guest.evaluate("Object.values(KNState.peers).find(p => p.slot === 0).pc.close()")
            guest.wait_for_function(f"!({host_channel})")
            expect(timer).to_be_hidden()

        host.close()
        expect(timer).to_be_visible()
        guest.wait_for_function("!window.NetplayRollback.hostGameConnected()")
        expect(status).to_contain_text("Waiting for them to return")
        frozen = guest.evaluate(frame)
        guest.wait_for_timeout(1500)
        assert guest.evaluate(frame) == frozen
        assert guest.evaluate("KNState.matchId") == match
        guest.locator("#toolbar-leave").click()
        expect(guest).to_have_url(f"{server_url}/")
        expect(guest.get_by_role("link", name="Return to room", exact=True)).to_have_count(0)


def test_resume_toast_on_visibility_change(browser, server_url, start_game):
    """Returning from background sends 'returned' toast to peers."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        _start_lockstep_game(host, guest, server_url, _room_id("P1"), start_game)

        # Simulate guest going to background then returning after >500ms
        guest.evaluate("""
            Object.defineProperty(document, 'hidden', {
                value: true, configurable: true
            });
            document.dispatchEvent(new Event('visibilitychange'));
        """)

        time.sleep(0.8)

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
        _cleanup(host, guest)


def test_reconnect_toast_on_dc_close(browser, server_url, start_game):
    """DC death shows toast notifications (no blocking overlay)."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        _start_lockstep_game(host, guest, server_url, _room_id("RC"), start_game)

        # Kill guest's DataChannel (only DC in 2-player game)
        guest.evaluate("""
            var peers = Object.values(window.KNState.peers);
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
        _cleanup(host, guest)


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

        # Wait for the ROM transfer to complete: the guest's ROM status then
        # reads "Loaded: <name> (from host)". The whole ROM crosses in small
        # chunks, which takes a while in a slow container.
        expect(guest.locator("#rom-status")).to_contain_text("(from host)", timeout=120000)
    finally:
        _cleanup(host, guest, host_ctx, mobile_ctx)


def test_background_tab_resumes_cleanly(browser, server_url, start_game):
    """Background tab resumes on return."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        _start_lockstep_game(host, guest, server_url, _room_id("P2"), start_game)

        # Record host frame
        initial_frame = host.evaluate("window.KNState.frameNum")

        # Simulate guest going to background then returning after >500ms
        guest.evaluate("""
            Object.defineProperty(document, 'hidden', {
                value: true, configurable: true
            });
            document.dispatchEvent(new Event('visibilitychange'));
        """)

        # Let host advance while guest is paused
        time.sleep(2)

        # Host should keep advancing
        later_frame = host.evaluate("window.KNState.frameNum")
        assert later_frame > initial_frame, (
            f"Host stalled: frame stayed at {initial_frame}"
        )

        # Guest returns
        guest.evaluate("""
            Object.defineProperty(document, 'hidden', {
                value: false, configurable: true
            });
            document.dispatchEvent(new Event('visibilitychange'));
        """)

        # Guest should resume (frame advances past 0)
        guest.wait_for_function(
            "window.KNState.frameNum > 0",
            timeout=10000,
        )
    finally:
        _cleanup(host, guest)
