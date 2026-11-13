"""The page decodes what a real server sends, and reports a message that is off its schema.

web/src/socket-boundary.ts checks every server-authored Socket.IO event and
the join-room ack against the schemas generated from server/src/api/payloads.py.
It only observes: handlers still get the raw payload. These tests run a host
and a guest against the live server and check that nothing real is reported,
and that a payload of the wrong shape is.

Run: pytest tests/test_protocol_observe_e2e.py -v   (needs the server running)
"""

import json

from playwright.sync_api import expect

# Record every server-authored event the page receives and what the client's
# schema says about it, beside the page's own observer.
_RECORD = """
    window.__seen = [];
    window.__test_socket.onAny((event, data) => {
        const known = ['users-updated', 'game-started', 'game-ended', 'rom-sharing-updated',
                       'upload-token', 'reconnect-token'];
        if (known.includes(event)) {
            window.__seen.push({ event, issue: window.KNCore.protocol.checkServerMessage(event, data) });
        }
    });
"""


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


def _mismatch_reports(page):
    """The protocol-mismatch client events this page has posted since it loaded."""
    events = [json.loads(text) for text in page.evaluate("window.__beacons")]
    return [e for e in events if e.get("type") == "protocol-mismatch"]


def _open(browser, url):
    page = browser.new_page()
    page.add_init_script(_KEEP_BEACONS)
    page.goto(url)
    expect(page.locator("#overlay")).to_be_visible(timeout=10000)
    page.wait_for_function("window.__test_socket && window.__test_socket.connected", timeout=10000)
    return page


def test_a_lobby_session_decodes_cleanly(browser, server_url, room):
    host = _open(browser, f"{server_url}/play.html?room={room}&host=1&name=Host")
    host.evaluate(_RECORD)
    guest = _open(browser, f"{server_url}/play.html?room={room}&name=Guest")
    watcher = _open(browser, f"{server_url}/play.html?room={room}&name=Watcher&spectate=1")
    try:
        expect(host.locator('.player-slot[data-slot="1"] .name')).to_contain_text("Guest", timeout=10000)
        # More server-authored traffic: a rename and a mode change, each a users-updated.
        guest.evaluate("window.__test_socket.emit('set-name', { name: 'Guest2' })")
        host.evaluate("window.__test_socket.emit('set-mode', { mode: 'streaming' })")
        expect(host.locator('.player-slot[data-slot="1"] .name')).to_contain_text("Guest2", timeout=10000)
        host.wait_for_timeout(500)

        seen = host.evaluate("window.__seen")
        assert len([s for s in seen if s["event"] == "users-updated"]) >= 3, seen
        assert [s for s in seen if s["issue"]] == []

        # The join-room ack, as this server builds it, matches too.
        ack = guest.evaluate(
            """() => new Promise((resolve) => {
                const s = window.__test_socket;
                s.emit('join-room', { extra: {
                    sessionid: new URLSearchParams(location.search).get('room'),
                    persistentId: sessionStorage.getItem('kn-player-id') || '',
                    reconnectToken: sessionStorage.getItem('kn-reconnect-token') || '',
                    player_name: 'Guest2',
                } }, (err, data) => resolve({ err, issue: data ?
                    window.KNCore.protocol.checkServerMessage('join-room ack', data) : 'no data' }));
            })"""
        )
        assert ack == {"err": None, "issue": None}, ack

        # Every page did post client events (so reports had a way out), none a mismatch.
        for page in (host, guest, watcher):
            assert page.evaluate("window.__beacons.length") > 0
            assert _mismatch_reports(page) == []
    finally:
        host.close()
        guest.close()
        watcher.close()


def test_a_payload_off_its_schema_is_reported_once_and_still_handled(browser, server_url, room):
    host = _open(browser, f"{server_url}/play.html?room={room}&host=1&name=Host")
    try:
        host.wait_for_function("window.KNState && window.KNState.uploadToken", timeout=10000)
        # Deliver an event as if the server had sent it without `romSharing`.
        deliver = """(payload) => {
            const s = window.__test_socket;
            s.onevent({ type: 2, nsp: '/', data: ['rom-sharing-updated', payload] });
        }"""
        host.evaluate(deliver, {"unexpected": True})
        host.evaluate(deliver, {"unexpected": True})
        host.wait_for_timeout(1000)

        reports = _mismatch_reports(host)
        assert len(reports) == 1, reports
        assert reports[0]["msg"] == "rom-sharing-updated"
        assert "romSharing" in reports[0]["meta"]["issue"]
        # Observing only: the page is still up and connected.
        assert host.evaluate("window.__test_socket.connected")
    finally:
        host.close()
