"""Signaling (Socket.IO) reconnect in the lobby.

Socket.IO v4 emits `reconnect` on the Manager, not the Socket, so play.js
detects a reconnect as a second `connect`. These tests drop the transport
with `socket.io.engine.close()` and check what the page does when it returns.

Run: pytest tests/test_signaling_reconnect.py -v
"""

import os
import tempfile

from playwright.sync_api import expect

# Longer than the 2 s the page waits before showing the banner, so the banner
# is up when the socket comes back.
_SLOW_RECONNECT = """
    const s = window.__test_socket;
    s.io.reconnectionDelay(3000);
    s.io.reconnectionDelayMax(3000);
    s.io.randomizationFactor(0);
"""

_COUNT_REJOINS = """
    const s = window.__test_socket;
    window.__rejoins = 0;
    const emit = s.emit.bind(s);
    s.emit = (ev, ...args) => {
        if (ev === 'open-room' || ev === 'join-room') window.__rejoins++;
        return emit(ev, ...args);
    };
"""


def _wait_connected(page):
    page.wait_for_function("window.__test_socket && window.__test_socket.connected", timeout=10000)


def _drop_socket(page):
    page.evaluate(_SLOW_RECONNECT + "s.io.engine.close();")


def _make_fake_rom(content_byte: int, size: int = 4096) -> str:
    fd, path = tempfile.mkstemp(suffix=".z64")
    os.write(fd, bytes([content_byte]) * size)
    os.close(fd)
    return path


def test_no_handler_on_event_the_socket_never_emits(browser, server_url, room):
    host = browser.new_page()
    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        _wait_connected(host)
        assert host.evaluate("window.__test_socket.listeners('reconnect').length") == 0
    finally:
        host.close()


def test_lobby_reconnect_counts_hides_banner_and_rejoins_once(browser, server_url, room):
    host = browser.new_page()
    guest = browser.new_page()
    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        expect(host.locator('.player-slot[data-slot="1"] .name')).to_contain_text("Guest", timeout=10000)

        for page in (host, guest):
            _wait_connected(page)
            # The first connect is not a reconnect.
            assert page.evaluate("KNState.sessionStats.reconnects") == 0
            page.evaluate(_COUNT_REJOINS)

        for page in (guest, host):
            _drop_socket(page)
            expect(page.locator("#reconnecting-banner")).to_be_visible(timeout=5000)
            _wait_connected(page)
            expect(page.locator("#reconnecting-banner")).to_be_hidden(timeout=5000)
            assert page.evaluate("KNState.sessionStats.reconnects") == 1
            # Both players are back in the room on both pages.
            for view in (host, guest):
                expect(view.locator('.player-slot[data-slot="0"] .name')).to_contain_text("Host", timeout=10000)
                expect(view.locator('.player-slot[data-slot="1"] .name')).to_contain_text("Guest", timeout=10000)
            assert page.evaluate("window.__rejoins") == 1
            expect(page.locator("#error-msg")).to_be_hidden()
    finally:
        host.close()
        guest.close()


def test_lobby_reconnect_resumes_stalled_rom_transfer(browser, server_url, room):
    rom = _make_fake_rom(0x41)
    host = browser.new_page()
    guest = browser.new_page()
    guest_logs = []
    guest.on("console", lambda msg: guest_logs.append(msg.text))
    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(rom)
        expect(host.locator("#opt-rom-sharing")).to_be_enabled(timeout=5000)
        # The checkbox sits in a collapsed options panel.
        host.evaluate("document.getElementById('opt-rom-sharing').click()")

        # debug=1 keeps console.log alive so the resume path can be asserted.
        guest.goto(f"{server_url}/play.html?room={room}&name=Guest&debug=1")
        expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)
        _wait_connected(guest)

        # Accept while offline: the request never reaches the host, so the
        # transfer sits in 'resuming' until something asks again.
        _drop_socket(guest)
        guest.click("#rom-accept-btn")
        guest.wait_for_timeout(500)
        assert not guest.evaluate("document.getElementById('rom-drop').classList.contains('loaded')")

        _wait_connected(guest)
        # Well inside the 15 s resume timeout that would otherwise retry.
        expect(guest.locator("#rom-drop.loaded")).to_be_visible(timeout=8000)
        assert any("resuming ROM transfer after reconnect" in line for line in guest_logs)
    finally:
        host.close()
        guest.close()
        os.unlink(rom)
