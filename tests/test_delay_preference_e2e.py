"""The delay preference on the real play page.

What a player asks the match for is web/src/play/delay.ts (tested against the
old play.js code in tests/ts/play-delay.test.ts), which play.js calls. This
walks the picker through its states on the live page, alone and with a
second player.

Run: pytest tests/test_delay_preference_e2e.py -v   (needs the server running)
"""

from playwright.sync_api import expect


def _open(browser, url):
    page = browser.new_page()
    page.goto(url)
    expect(page.locator("#overlay")).to_be_visible(timeout=10000)
    page.wait_for_function("window.__test_socket && window.__test_socket.connected", timeout=10000)
    return page


_WALK = """() => {
    const auto = document.getElementById('delay-auto');
    const select = document.getElementById('delay-select');
    const seen = [];
    for (const checked of [true, false]) {
        for (const autoValue of [0, 1, 4, 9, 12, 'junk', null]) {
            for (const value of ['0', '1', '2', '5', '9']) {
                auto.checked = checked;
                select.value = value;
                window.KNState.delayAutoValue = autoValue;
                seen.push(window.getDelayPreference());
            }
        }
    }
    return seen;
}"""


def test_solo_and_two_player_pickers(browser, server_url, room):
    host = _open(browser, f"{server_url}/play.html?room={room}&host=1&name=Host")
    guest = None
    try:
        # Alone in the room: no delay, whatever the picker says.
        assert set(host.evaluate(_WALK)) == {0}

        guest = _open(browser, f"{server_url}/play.html?room={room}&name=Guest")
        expect(host.locator("#player-list")).to_contain_text("Guest", timeout=10000)
        seen = host.evaluate(_WALK)
        assert min(seen) >= 1 and max(seen) <= 9
        assert len(set(seen)) > 1
        # The guest's picker comes to the same values: the walk sets the same controls.
        assert guest.evaluate(_WALK) == seen
    finally:
        host.close()
        if guest:
            guest.close()
