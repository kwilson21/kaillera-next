"""Opening and joining a room on the real play page.

The requests a page sends and what each answer means are
web/src/play/connect.ts and web/src/play/join-plan.ts. onConnect in play.js
still makes each decision itself, with the TypeScript rules computing it
beside and a difference reported as a `play-disagree` client event. This
fills a room, sends a fifth person in, and checks that everyone lands where
they should and that the two agree throughout.

Not covered here: the mid-game rejoin (tests/rb-two-player.mjs with
DROP_SIGNALING_MS) and joining a match in progress (tests/lifecycle-e2e.mjs).

Run: pytest tests/test_connect_e2e.py -v   (needs the server running)
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

# The requests the page emits, as sent.
_KEEP_REQUESTS = """
    window.__requests = [];
    const wait = setInterval(() => {
        const socket = window.__test_socket;
        if (!socket) return;
        clearInterval(wait);
        const emit = socket.emit.bind(socket);
        socket.emit = (event, ...args) => {
            if (event === 'open-room' || event === 'join-room') window.__requests.push([event, args[0]]);
            return emit(event, ...args);
        };
    }, 0);
"""


def _open(browser, url):
    page = browser.new_page()
    page.add_init_script(_KEEP_BEACONS)
    page.add_init_script(_KEEP_REQUESTS)
    page.goto(url)
    expect(page.locator("#overlay")).to_be_visible(timeout=10000)
    page.wait_for_function("window.__test_socket && window.__test_socket.connected", timeout=10000)
    return page


def _disagreements(page):
    # Any comparison sends what is waiting; this one is certain to be made with a token.
    page.wait_for_function("!!window.KNState.uploadToken", timeout=10000)
    page.evaluate("window.getDelayPreference()")
    page.wait_for_timeout(300)
    events = [json.loads(text) for text in page.evaluate("window.__beacons")]
    return [e for e in events if e.get("type") == "play-disagree"]


def test_a_full_room_takes_a_fifth_person_as_a_spectator(browser, server_url, room):
    pages = []
    try:
        host = _open(browser, f"{server_url}/play.html?room={room}&host=1&name=Host")
        pages.append(host)
        for i in range(1, 4):
            pages.append(_open(browser, f"{server_url}/play.html?room={room}&name=Guest{i}"))
            expect(host.locator(f'.player-slot[data-slot="{i}"] .name')).to_have_text(f"Guest{i}", timeout=10000)

        fifth = _open(browser, f"{server_url}/play.html?room={room}&name=Fifth")
        pages.append(fifth)
        expect(fifth.locator(".room-full-banner")).to_be_visible(timeout=10000)
        expect(host.locator("#spectator-list")).to_have_text("Watching: Fifth", timeout=10000)

        # What went on the wire: one request each, in the shape the server's models describe.
        opened = host.evaluate("window.__requests")
        assert [event for event, _ in opened] == ["open-room"]
        assert opened[0][1]["extra"]["fresh"] is True
        assert opened[0][1]["extra"]["sessionid"] == room
        assert opened[0][1]["maxPlayers"] == 4
        assert set(opened[0][1]["extra"]) == {
            "sessionid", "player_name", "room_name", "game_id", "persistentId", "reconnectToken", "fresh",
        }  # fmt: skip

        joined = pages[1].evaluate("window.__requests")
        assert [event for event, _ in joined] == ["join-room"]
        assert joined[0][1]["extra"]["spectate"] is False
        assert set(joined[0][1]["extra"]) == {
            "sessionid", "player_name", "spectate", "persistentId", "reconnectToken",
        }  # fmt: skip

        watched = fifth.evaluate("window.__requests")
        assert [event for event, _ in watched] == ["join-room"]
        assert watched[0][1]["extra"]["spectate"] is True

        for page in pages:
            assert _disagreements(page) == []
    finally:
        for page in pages:
            page.close()
