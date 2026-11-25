"""Streaming: two pages connect, and a connection that drops is offered again.

specs/streaming_connection.qnt (streaming_connection_current): the host keeps
a deadline for every member its roster lists whose channel to it is not
open, and offers a new connection when it expires; every signal names the
connection it belongs to, so a guest still holding the old connection
replaces it for the newer offer (guestStillHoldsTheOldConnectionTest).
Before the deadline the guest was left on the last frame of the video for
good (droppedGuestTest).

The host runs a painted canvas in place of the emulator (no ROM); the pages,
the server and WebRTC are real.

Run: pytest tests/test_streaming_reconnect.py -v   (needs the server running)
"""

import secrets

import pytest

from playwright.sync_api import expect
from test_streaming_late_join import _HAS_VIDEO, _install_fake_streaming_host, _wait_for_socket

# The guest's connection to the host, and the host's to the guest.
_GUEST_HOST_PEER = "Object.values(window.KNState?.peers || {}).find((p) => p.slot === 0)"
_HOST_GUEST_PEER = "(window.KNState?.peers || {})[sid]"


def _start(browser, server_url, before_start=None):
    room = f"STR{secrets.token_hex(3).upper()}"
    host = browser.new_page()
    guest = browser.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=streaming")
    expect(host.locator("#overlay")).to_be_visible(timeout=10000)
    _wait_for_socket(host)
    _install_fake_streaming_host(host)
    guest.goto(f"{server_url}/play.html?room={room}&name=P2")
    expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
    _wait_for_socket(guest)
    expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
    if before_start:
        before_start(host, guest)
    host.click("#start-btn")
    host.wait_for_function(
        "document.querySelector('#toolbar-status')?.textContent.includes('Hosting')",
        timeout=30000,
    )
    guest.wait_for_function(_HAS_VIDEO, timeout=30000)
    return host, guest


def _close(pages):
    for page in pages:
        try:
            page.evaluate("window.__test_socket && window.__test_socket.disconnect()")
        except Exception:
            pass
        if not page.is_closed():
            page.close()


def _input_reaches_host(host, guest):
    """A key the guest presses and lets go is applied to slot 1 on the host."""
    host.evaluate("window.__test_input_writes.length = 0")
    guest.bring_to_front()
    guest.keyboard.down("c")
    host.wait_for_function(
        "window.__test_input_writes?.some((w) => w.slot === 1 && w.index === 0 && w.value === 1)",
        timeout=10000,
    )
    guest.keyboard.up("c")
    host.wait_for_function(
        "window.__test_input_writes?.some((w) => w.slot === 1 && w.index === 0 && w.value === 0)",
        timeout=10000,
    )


def _attempts(host, guest, sid):
    """The attempt each page's connection to the other names, and whether its channel is open."""
    return {
        "host": host.evaluate(
            f"(sid) => {{ const p = {_HOST_GUEST_PEER}; return p ? [p.attempt?.attempt ?? 0, p.dc?.readyState] : null; }}",
            sid,
        ),
        "guest": guest.evaluate(
            f"() => {{ const p = {_GUEST_HOST_PEER}; return p ? [p.attempt?.attempt ?? 0, p.dc?.readyState] : null; }}"
        ),
    }


def test_two_player_stream_connects_and_carries_input(browser, server_url):
    """Host and guest connect on one named connection; video reaches the guest and its input reaches the host."""
    pages = []
    try:
        host, guest = _start(browser, server_url)
        pages = [host, guest]
        sid = guest.evaluate("window.__test_socket.id")
        host.wait_for_function(f"(sid) => {_HOST_GUEST_PEER}?.dc?.readyState === 'open'", arg=sid, timeout=10000)
        assert _attempts(host, guest, sid) == {"host": [1, "open"], "guest": [1, "open"]}
        _input_reaches_host(host, guest)
        # Both pages name the same connection, made by the host's page.
        same = host.evaluate(f"(sid) => {_HOST_GUEST_PEER}.attempt.page", sid) == guest.evaluate(
            f"{_GUEST_HOST_PEER}.attempt.page"
        )
        assert same
    finally:
        _close(pages)


def _reconnected(host, guest, sid):
    """The host's deadline made a second connection, and both pages hold it open, with video and input flowing."""
    host.wait_for_function(
        f"(sid) => {{ const p = {_HOST_GUEST_PEER}; return p?.attempt?.attempt >= 2 && p.dc?.readyState === 'open'; }}",
        arg=sid,
        timeout=40000,
    )
    guest.wait_for_function(
        f"(() => {{ const p = {_GUEST_HOST_PEER}; return p?.attempt?.attempt >= 2 && p.dc?.readyState === 'open'; }})()",
        timeout=10000,
    )
    guest.wait_for_function(
        """
        (() => {
          const v = document.querySelector('#guest-video');
          return !!v?.srcObject?.getVideoTracks().some((t) => t.readyState === 'live');
        })()
        """,
        timeout=10000,
    )
    attempts = _attempts(host, guest, sid)
    assert attempts["host"] == attempts["guest"], attempts
    _input_reaches_host(host, guest)
    # The sync logs (one tab-separated line per entry) say what each page did.
    host_log = host.evaluate("window.NetplayStreaming.exportSyncLog()")
    assert f"STREAM-REOFFER {sid}" in host_log, host_log[-3000:]
    return guest.evaluate("window.NetplayStreaming.exportSyncLog()")


@pytest.mark.parametrize("drop", ["offer", "answer"])
def test_media_negotiation_retries_on_the_open_input_channel(browser, server_url, drop):
    def lose_one_signal(host, guest):
        for page, field in ((host, "offer"), (guest, "answer")):
            page.evaluate(
                """([field, drop]) => {
                    const socket = window.__test_socket, emit = socket.emit;
                    window.mediaSignals = [];
                    socket.emit = function(event, packet, ...args) {
                        if (event === 'webrtc-signal' && packet?.[field]?.sdp?.includes('m=video')) {
                            window.mediaSignals.push({ attempt: packet.attemptId, sdp: packet[field].sdp });
                            if (field === drop && window.mediaSignals.length === 1) return this;
                        }
                        return emit.call(this, event, packet, ...args);
                    };
                }""",
                [field, drop],
            )

    host, guest = _start(browser, server_url, lose_one_signal)
    try:
        host.wait_for_function("window.mediaSignals.length >= 2", timeout=20000)
        guest.wait_for_function("window.mediaSignals.length >= 1", timeout=10000)
        host.wait_for_function(
            "Object.values(KNState.peers).some(p => p.dc?.readyState === 'open' && !p.mediaPending)"
        )
        offers = host.evaluate("window.mediaSignals")
        assert offers[0] == offers[1]
        if drop == "answer":
            answers = guest.evaluate("window.mediaSignals")
            assert len(answers) == 2
            assert answers[0]["attempt"] == answers[1]["attempt"]
        _input_reaches_host(host, guest)
    finally:
        _close([host, guest])


def test_host_return_banner_requires_fresh_video_on_the_current_connection(browser, server_url):
    host, guest = _start(browser, server_url)
    try:
        guest.wait_for_function("window.NetplayStreaming.hostGameConnected()")
        host.evaluate("window.__test_socket.disconnect()")
        status = guest.locator("#host-wait-banner [role=status]")
        expect(status).to_contain_text("game connection is still active")
        host.evaluate("""async () => {
            const pc = Object.values(KNState.peers).find(p => p.slot === 1).pc;
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            window.resumeVideo = sender.replaceTrack.bind(sender, sender.track);
            await sender.replaceTrack(null);
        }""")
        expect(status).to_contain_text("Waiting for them to return", timeout=10000)
        assert guest.evaluate(f"{_GUEST_HOST_PEER}.dc.readyState") == "open"
        assert guest.evaluate(f"{_GUEST_HOST_PEER}.pc.connectionState") == "connected"
        host.evaluate("window.resumeVideo()")
        expect(status).to_contain_text("game connection is still active", timeout=10000)
    finally:
        _close([host, guest])


def test_a_dropped_connection_is_offered_again(browser, server_url):
    """droppedGuestTest: the connection drops, both pages forget it, and the host's deadline offers a new one."""
    pages = []
    try:
        host, guest = _start(browser, server_url)
        pages = [host, guest]
        sid = guest.evaluate("window.__test_socket.id")
        host.wait_for_function(f"(sid) => {_HOST_GUEST_PEER}?.dc?.readyState === 'open'", arg=sid, timeout=10000)
        _input_reaches_host(host, guest)

        # The connection goes away: the guest's channel closes and it forgets
        # the host, and so does the host its guest. Nothing else offers again.
        guest.evaluate(f"{_GUEST_HOST_PEER}.pc.close()")
        host.wait_for_function(f"(sid) => {_HOST_GUEST_PEER}?.dc?.readyState !== 'open'", arg=sid, timeout=10000)
        guest_log = _reconnected(host, guest, sid)
        assert "Connection to the host lost — reconnecting" in guest_log, guest_log[-3000:]
    finally:
        _close(pages)


def test_a_guest_that_still_holds_the_old_connection_replaces_it(browser, server_url):
    """guestStillHoldsTheOldConnectionTest: the host notices the drop first; its new offer replaces the guest's old one."""
    pages = []
    try:
        host, guest = _start(browser, server_url)
        pages = [host, guest]
        sid = guest.evaluate("window.__test_socket.id")
        host.wait_for_function(f"(sid) => {_HOST_GUEST_PEER}?.dc?.readyState === 'open'", arg=sid, timeout=10000)

        # The guest has not noticed yet: it hears nothing more from its old
        # connection. The host's channel to it closes and the host forgets it.
        guest.evaluate(
            f"""(() => {{
              const p = {_GUEST_HOST_PEER};
              p.dc.onclose = null;
              p.pc.onconnectionstatechange = null;
            }})()"""
        )
        host.evaluate(f"(sid) => {_HOST_GUEST_PEER}.dc.close()", sid)
        host.wait_for_function(f"(sid) => !{_HOST_GUEST_PEER}", arg=sid, timeout=10000)

        # The host's next offer names a newer connection than the one the guest
        # holds: the guest closes the old one and answers from a new one.
        guest_log = _reconnected(host, guest, sid)
        assert "for a new connection" in guest_log, guest_log[-3000:]
    finally:
        _close(pages)


def test_streaming_host_returns_to_saved_game(browser, server_url, room, rom_path):
    """A fresh host restores its native save before the original guest receives video again."""
    context = browser.new_context()
    guest = browser.new_page()
    try:
        host = context.new_page()
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=streaming")
        host.locator("#rom-drop input[type=file]").set_input_files(rom_path)
        guest.goto(f"{server_url}/play.html?room={room}&name=P2")
        host.locator("#start-btn:not([disabled])").click()
        guest.wait_for_function(_HAS_VIDEO, timeout=60000)
        first = host.evaluate("() => KNState.matchId")
        assert first
        # A save must commit before closing the tab. Playwright's DOM predicate
        # accepts a pending Promise as truthy, so poll the resolved IndexedDB read.
        def committed():
            return host.evaluate(
                """async room => {
                  if (!(await indexedDB.databases()).some(d => d.name === 'kn-match-return')) return false;
                  return new Promise((resolve, reject) => {
                    const open = indexedDB.open('kn-match-return');
                    open.onerror = () => reject(open.error);
                    open.onsuccess = () => {
                      const db = open.result;
                      const read = db.transaction('matches').objectStore('matches').get(room);
                      read.onsuccess = () => {
                        db.close();
                        resolve(read.result?.scope.matchId === KNState.matchId && read.result.frame > 15);
                      };
                      read.onerror = () => reject(read.error);
                    };
                  });
                }""",
                room,
            )

        for _ in range(80):
            if committed():
                break
            host.wait_for_timeout(250)
        else:
            raise AssertionError("Streaming host did not save the running match")
        guest.evaluate("""() => {
          window.returnEvents = [];
          __test_socket.on('match-return-go', packet => returnEvents.push(packet.matchId));
        }""")
        host.close()
        expect(guest.locator("#host-wait-banner")).to_be_visible()
        host = context.new_page()
        host.goto(server_url)
        host.get_by_role("link", name="Return to room", exact=True).click()
        guest.wait_for_function("returnEvents.length === 1", timeout=75000)
        guest.wait_for_function(_HAS_VIDEO, timeout=30000)
        expect(guest.locator("#host-wait-banner")).to_be_hidden()
        continued = guest.evaluate("() => returnEvents[0]")
        assert continued != first
        assert host.evaluate("() => KNState.matchId") == continued
        assert guest.evaluate("() => KNState.slot") == 1
        host.wait_for_function("EJS_emulator.gameManager.Module._get_current_frame_count() > 120", timeout=30000)
    finally:
        context.close()
        guest.close()
