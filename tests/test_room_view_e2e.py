"""The room's player slots and Start button on the real play page.

What they show is web/src/play/room-view.ts (unit-tested against the old
code in tests/ts/play-room-view.test.ts). Whether the host may start is
still decided by play.js, with room-view.ts computing it beside and a
difference reported as a `play-disagree` client event. This walks a room
through the states that change the button and checks the page and that the
two agree.

Run: pytest tests/test_room_view_e2e.py -v   (needs the server running)
"""

import json

from playwright.sync_api import expect

# Client events leave through navigator.sendBeacon with a Blob body, which the
# browser does not expose to request listeners: keep a readable copy.
_KEEP_BEACONS = """
    window.__beacons = [];
    const send = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, body) => {
        if (String(url).includes('/api/client-event') && body && body.text) {
            body.text().then((text) => window.__beacons.push(text));
        }
        return send(url, body);
    };
"""


def _open(browser, url):
    page = browser.new_page()
    page.add_init_script(_KEEP_BEACONS)
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


def _disagreements(page):
    # Any comparison sends what is waiting; this one is certain to be made with a token.
    page.wait_for_function("!!window.KNState.uploadToken", timeout=10000)
    page.evaluate("window.getDelayPreference()")
    page.wait_for_timeout(300)
    events = [json.loads(text) for text in page.evaluate("window.__beacons")]
    return [e for e in events if e.get("type") == "play-disagree"]


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

        assert _disagreements(host) == []
        assert _disagreements(guest) == []
    finally:
        host.close()
        if guest:
            guest.close()
