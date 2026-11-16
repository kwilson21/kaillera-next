"""The room's player slots and Start button on the real play page.

What they show, and whether the host may start, is web/src/play/room-view.ts
(tested against the old play.js code in tests/ts/play-room-view.test.ts),
which play.js calls. This walks a room through the states that change the
button and checks the page.

Run: pytest tests/test_room_view_e2e.py -v   (needs the server running)
"""

from playwright.sync_api import expect


def _open(browser, url):
    page = browser.new_page()
    page.goto(url)
    expect(page.locator("#overlay")).to_be_visible(timeout=10000)
    page.wait_for_function("window.__test_socket && window.__test_socket.connected", timeout=10000)
    return page


def _rom_ready(page):
    page.evaluate(
        """() => {
            window.__test_setRomLoaded();
            window.__test_socket.emit('rom-ready', { ready: true });
        }"""
    )


def test_slots_and_start_button_follow_the_room(browser, server_url, room):
    host = _open(browser, f"{server_url}/play.html?room={room}&host=1&name=Host")
    guest = None
    try:
        start = host.locator("#start-btn")
        slot0 = host.locator('.player-slot[data-slot="0"]')
        slot1 = host.locator('.player-slot[data-slot="1"]')

        expect(slot0.locator(".name")).to_have_text("Host (host)")
        expect(slot0.locator(".rom-status")).to_have_text("needs ROM")
        expect(slot1.locator(".name")).to_have_text("Open")
        expect(start).to_be_disabled()
        expect(start).to_have_text("Waiting for ROMs (0/1)")

        _rom_ready(host)
        expect(slot0.locator(".rom-status")).to_have_text("✓ ROM")
        expect(start).to_be_enabled()
        expect(start).to_have_text("Start Game")

        guest = _open(browser, f"{server_url}/play.html?room={room}&name=Guest")
        expect(slot1.locator(".name")).to_have_text("Guest")
        expect(slot1.locator(".rom-status")).to_have_text("needs ROM")
        expect(slot1.locator(".gamepad")).to_have_attribute("aria-label", "Keyboard")
        expect(start).to_be_disabled()
        expect(start).to_have_text("Waiting for ROMs (1/2)")

        # A streamed game needs no ROM from the guest.
        host.select_option("#mode-select", "streaming")
        expect(start).to_be_enabled()
        expect(start).to_have_text("Start Game")
        host.select_option("#mode-select", "rollback")
        expect(start).to_have_text("Waiting for ROMs (1/2)")

        _rom_ready(guest)
        expect(slot1.locator(".rom-status")).to_have_text("✓ ROM")
        expect(start).to_be_enabled()
    finally:
        host.close()
        if guest:
            guest.close()
