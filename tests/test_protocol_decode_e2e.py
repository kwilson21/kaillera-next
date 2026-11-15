"""The page decodes what a real server sends, and drops a message that is off its schema.

web/src/socket-boundary.ts decodes every server-authored Socket.IO event, the
join-room ack, the relays play.js handles and the ROM transfer channel's
strings, against the schemas generated from server/src/api/payloads.py and
web/src/peer-protocol.ts. play.js's handlers run on the decoded value; a
message that does not match is dropped and logged (`[protocol] dropped ...`).
These tests run real pages against the live server and check that nothing
real is dropped, and that a payload of the wrong shape is, without its
handler running.

The rollback engine decodes the strings its DataChannels deliver, and the
session-log ack, the same way, with a boundary of its own that logs to its
sync log and the console; these tests check those too.

Run: pytest tests/test_protocol_decode_e2e.py -v   (needs the server running)
"""

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


def _dropped(page):
    """What this page's boundaries (play.js's and the engine's) have dropped, as they logged it."""
    return [line for line in page.__dict__.setdefault("_kn_console", []) if line.startswith("[protocol] dropped")]


def _open(browser, url):
    page = browser.new_page()
    lines = page.__dict__.setdefault("_kn_console", [])
    page.on("console", lambda message: lines.append(message.text))
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

        # Nothing real was dropped.
        for page in (host, guest, watcher):
            assert _dropped(page) == []
    finally:
        host.close()
        guest.close()
        watcher.close()


def test_a_payload_off_its_schema_is_dropped_and_its_handler_does_not_run(browser, server_url, room):
    host = _open(browser, f"{server_url}/play.html?room={room}&host=1&name=Host")
    guest = _open(browser, f"{server_url}/play.html?room={room}&name=Guest")
    try:
        expect(host.locator('.player-slot[data-slot="1"] .name')).to_contain_text("Guest", timeout=10000)
        prompt = guest.locator("#rom-sharing-prompt")
        expect(prompt).to_be_hidden()
        # Deliver an event as if the server had sent it: `romSharing` should be a boolean.
        deliver = """(payload) => {
            const s = window.__test_socket;
            s.onevent({ type: 2, nsp: '/', data: ['rom-sharing-updated', payload] });
        }"""
        guest.evaluate(deliver, {"romSharing": "yes"})
        guest.evaluate(deliver, {"romSharing": "yes"})
        guest.wait_for_timeout(500)
        # Handled raw, "yes" would have turned sharing on and shown the prompt.
        expect(prompt).to_be_hidden()
        dropped = _dropped(guest)
        assert len(dropped) == 1, dropped
        assert dropped[0].startswith("[protocol] dropped rom-sharing-updated:"), dropped
        assert "romSharing" in dropped[0]
        assert "yes" not in dropped[0]  # the path is logged, never the value

        # The same event as the server sends it is handled.
        guest.evaluate(deliver, {"romSharing": True})
        expect(prompt).to_be_visible(timeout=5000)
        assert len(_dropped(guest)) == 1
        assert guest.evaluate("window.__test_socket.connected")
    finally:
        host.close()
        guest.close()


# Beside the page's and the engine's own boundaries: every message either
# checks, and what the schemas say about it. The engine makes its boundary when
# its first DataChannel string arrives, after this has wrapped the maker.
_RECORD_PEER = """
    window.__peer = [];
    const protocol = window.KNCore.protocol;
    const create = protocol.createBoundary;
    protocol.createBoundary = (log) => {
        const boundary = create(log);
        const peerText = boundary.peerText;
        boundary.peerText = (channel, text) => {
            const verdict = protocol.checkPeerText(channel, text);
            window.__peer.push({ kind: 'dc ' + verdict.kind, issue: verdict.issue });
            return peerText(channel, text);
        };
        return boundary;
    };
    window.__test_socket.onAny((event, data) => {
        const relay = protocol.checkRelay(event, data);
        if (relay) window.__peer.push({ kind: relay.kind, issue: relay.issue });
        else window.__peer.push({ kind: event, issue: protocol.checkServerMessage(event, data) });
    });
"""

_ROM_READY = """
    if (window.__test_setRomLoaded) window.__test_setRomLoaded();
    window.__test_socket.emit('rom-ready', { ready: true });
"""


def test_a_started_match_decodes_cleanly_peer_messages_included(browser, server_url, room):
    """Start and end a match (no real ROM: the emulators never boot).

    That is enough for game-started and game-ended, the WebRTC signal relays,
    and the first messages peers exchange once their DataChannel opens.
    """
    host = _open(browser, f"{server_url}/play.html?room={room}&host=1&name=Host")
    guest = _open(browser, f"{server_url}/play.html?room={room}&name=Guest")
    try:
        for page in (host, guest):
            page.evaluate(_RECORD_PEER)
            page.evaluate(_ROM_READY)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(guest.locator("#overlay")).to_be_hidden(timeout=10000)
        # The peers connect and greet each other over the lockstep channel.
        for page in (host, guest):
            page.wait_for_function("window.__peer.some((m) => m.kind.startsWith('dc lockstep '))", timeout=30000)
        host.wait_for_timeout(3000)
        host.click("#toolbar-more")
        host.click("#toolbar-end")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        # The guest's lobby can be back before the host has had its own copy.
        for page in (host, guest):
            page.wait_for_function("window.__peer.some((m) => m.kind === 'game-ended')", timeout=10000)

        for page in (host, guest):
            seen = page.evaluate("window.__peer")
            kinds = {m["kind"] for m in seen}
            assert [m for m in seen if m["issue"]] == []
            assert {"game-started", "game-ended", "webrtc-signal"} <= kinds, kinds
            assert any(k.startswith("dc lockstep ") for k in kinds), kinds
            assert _dropped(page) == []
        print("peer kinds seen:", sorted({m["kind"] for p in (host, guest) for m in p.evaluate("window.__peer")}))
    finally:
        host.close()
        guest.close()


# What a peer sends that is off its schema: known kinds with a bad field, a kind
# no page knows, JSON with a field of the wrong type, and text that is not JSON.
# The "zz-" values must never reach a log line.
_MALFORMED = """async () => {
    const peer = Object.values(window.KNState.peers)[0];
    const open = (dc) => dc && dc.readyState === 'open';
    for (let i = 0; i < 50 && !(open(peer.dc) && open(peer.syncDc)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (let i = 0; i < 3; i++) peer.dc.send(`rb-check:zz-secret-${i}:1`);
    peer.dc.send('rb-future-kind:1');
    peer.dc.send(JSON.stringify({ type: 'lockstep-ready', delay: 'zz-two' }));
    peer.dc.send('{zz-not json');
    peer.syncDc.send('sync-start:zz-frame');
    return { lockstep: peer.dc.readyState, syncState: peer.syncDc.readyState };
}"""


def test_a_peer_string_off_its_schema_is_dropped_by_the_engine(browser, server_url, room):
    """A guest sends the host malformed DataChannel strings mid-match.

    The host's engine drops each one before any handler reads it, logs the
    first of each kind and reason once (sync log and console), never with what
    was sent, and the match goes on: the host still ends it normally.
    """
    host = _open(browser, f"{server_url}/play.html?room={room}&host=1&name=Host")
    guest = _open(browser, f"{server_url}/play.html?room={room}&name=Guest")
    try:
        for page in (host, guest):
            page.evaluate(_ROM_READY)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(guest.locator("#overlay")).to_be_hidden(timeout=10000)
        guest.wait_for_function(
            "Object.values(window.KNState.peers || {}).some((p) => p.dc && p.dc.readyState === 'open')",
            timeout=30000,
        )
        assert guest.evaluate(_MALFORMED) == {"lockstep": "open", "syncState": "open"}
        host.wait_for_function(
            "() => (window.NetplayRollback.exportSyncLog() || '').includes('dropped dc sync-state')", timeout=10000
        )

        expected = [
            "[protocol] dropped dc lockstep rb-check",
            "[protocol] dropped dc lockstep (unknown)",
            "[protocol] dropped dc lockstep lockstep-ready",
            "[protocol] dropped dc lockstep (json)",
            "[protocol] dropped dc sync-state sync-start",
        ]
        dropped = _dropped(host)
        assert [line[: line.index(":")] for line in dropped] == expected, dropped
        sync_log = host.evaluate("window.NetplayRollback.exportSyncLog()")
        for line in dropped:
            assert line in sync_log
            assert "zz-" not in line and "future" not in line, line
        assert _dropped(guest) == []

        # The host's page is still in charge of its match.
        host.click("#toolbar-more")
        host.click("#toolbar-end")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
    finally:
        host.close()
        guest.close()
