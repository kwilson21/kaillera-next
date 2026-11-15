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

from playwright.sync_api import expect
from test_streaming_late_join import _HAS_VIDEO, _install_fake_streaming_host, _wait_for_socket

# The guest's connection to the host, and the host's to the guest.
_GUEST_HOST_PEER = "Object.values(window.KNState?.peers || {}).find((p) => p.slot === 0)"
_HOST_GUEST_PEER = "(window.KNState?.peers || {})[sid]"


def _start(context, server_url):
    room = f"STR{secrets.token_hex(3).upper()}"
    host = context.new_page()
    guest = context.new_page()
    host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=streaming")
    expect(host.locator("#overlay")).to_be_visible(timeout=10000)
    _wait_for_socket(host)
    _install_fake_streaming_host(host)
    guest.goto(f"{server_url}/play.html?room={room}&name=P2")
    expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
    _wait_for_socket(guest)
    expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
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


def test_two_player_stream_connects_and_carries_input(context, server_url):
    """Host and guest connect on one named connection; video reaches the guest and its input reaches the host."""
    pages = []
    try:
        host, guest = _start(context, server_url)
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
        assert host.evaluate("window.NetplayStreaming.observed().disagreed") == 0
        assert guest.evaluate("window.NetplayStreaming.observed().disagreed") == 0
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
    assert host.evaluate("window.NetplayStreaming.observed().disagreed") == 0
    assert guest.evaluate("window.NetplayStreaming.observed().disagreed") == 0
    return guest.evaluate("window.NetplayStreaming.exportSyncLog()")


def test_a_dropped_connection_is_offered_again(context, server_url):
    """droppedGuestTest: the connection drops, both pages forget it, and the host's deadline offers a new one."""
    pages = []
    try:
        host, guest = _start(context, server_url)
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


def test_a_guest_that_still_holds_the_old_connection_replaces_it(context, server_url):
    """guestStillHoldsTheOldConnectionTest: the host notices the drop first; its new offer replaces the guest's old one."""
    pages = []
    try:
        host, guest = _start(context, server_url)
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
