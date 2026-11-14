"""The delay preference on the real play page: play.js decides, delay.ts agrees.

web/src/play/delay.ts computes a player's delay preference beside the play.js
code that is still in charge of it, and a difference is reported as a
`play-disagree` client event (web/src/play/observe.ts). This walks the picker
through its states on the live page and checks that nothing is reported.

Run: pytest tests/test_delay_observe_e2e.py -v   (needs the server running)
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
    page.wait_for_function("!!window.KNState.uploadToken", timeout=10000)
    return page


def _disagreements(page):
    events = [json.loads(text) for text in page.evaluate("window.__beacons")]
    return [e for e in events if e.get("type") == "play-disagree"]


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


def test_solo_and_two_player_pickers_agree(browser, server_url, room):
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
        guest.evaluate(_WALK)

        host.wait_for_timeout(300)
        assert _disagreements(host) == []
        assert _disagreements(guest) == []
    finally:
        host.close()
        if guest:
            guest.close()
