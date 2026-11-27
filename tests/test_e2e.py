"""Minimal E2E tests for the MVP P0 flow.

Run: pytest tests/test_e2e.py -v
"""

import re
import secrets

import pytest
from playwright.sync_api import expect

_R = secrets.token_hex(3).upper()  # unique per run to avoid stale room collisions


def _mark_rom_ready(page):
    """Simulate a player having loaded a ROM (client state + server signal)."""
    page.wait_for_function(
        "window.__test_socket && window.__test_socket.connected", timeout=10000
    )
    page.evaluate("""
        if (window.__test_setRomLoaded) window.__test_setRomLoaded();
        window.__test_socket.emit('rom-ready', { ready: true });
    """)



def test_lobby_to_play_redirect(page, server_url):
    """Create a room redirects to play.html as host (the room asks for a name)."""
    page.goto(server_url)
    page.click("#create-btn")
    expect(page).to_have_url(re.compile(r"play\.html\?room=\w+&mode=rollback$"))
    expect(page.locator("#host-controls")).to_be_visible()


def test_reopened_host_url_uses_the_rooms_current_mode(page, server_url, room):
    url = f"{server_url}/play.html?room={room}&host=1&mode=rollback"
    page.goto(url)
    expect(page.locator("#host-controls")).to_be_visible()
    page.locator("#opt-listed").check()
    page.locator("#mode-select").select_option("streaming", force=True)
    assert page.request.get(f"{server_url}/room/{room}").json()["mode"] == "streaming"

    # A duplicate inherits this tab's credentials while its host is still connected.
    with page.expect_popup() as popup:
        page.evaluate("window.open(location.href)")
    duplicate = popup.value
    expect(duplicate.locator("#host-return-dialog [role=status]")).to_contain_text("still connected")
    duplicate.close()
    assert page.evaluate("KNState.isLocalHost")

    page.reload()
    expect(page.locator("#host-controls")).to_be_visible()
    expect(page.locator("#mode-select")).to_have_value("streaming")
    expect(page.locator("#opt-listed")).to_be_checked()
    assert page.evaluate("KNState.slot") == 0
    assert page.locator("#rollback-options").evaluate("e => e.style.display") == "none"
    assert page.request.get(f"{server_url}/room/{room}").json()["mode"] == "streaming"


@pytest.mark.parametrize("playing", [False, True], ids=["lobby", "match"])
def test_reopened_host_url_does_not_recreate_an_expired_room(browser, page, short_host_return_url, room, playing):
    url = f"{short_host_return_url}/play.html?room={room}&host=1"
    page.goto(url)
    page.wait_for_function("room => !!sessionStorage.getItem('kn-reconnect-token:' + room)", arg=room)
    bookmark = f"{short_host_return_url}/play.html?room={room}"
    expect(page).to_have_url(bookmark)
    with browser.new_page() as guest:
        guest.goto(f"{short_host_return_url}/play.html?room={room}&name=Guest")
        guest.wait_for_function("KNState.slot === 1")
        if playing:
            for player in (page, guest):
                _mark_rom_ready(player)
            page.click("#start-btn")
            expect(guest.locator("#toolbar")).to_be_visible()
            page.once("dialog", lambda dialog: dialog.accept())
        page.goto(short_host_return_url)
        expect(page.get_by_role("link", name="Return to room", exact=True)).to_be_visible()
        expect(page.get_by_role("timer")).to_contain_text("Room closes in")
        expect(guest.locator("#host-wait-banner [role=timer]")).to_be_visible()
        deadline = guest.request.get(f"{short_host_return_url}/room/{room}").json()
        assert 0 < deadline["hostReturnDeadline"] - deadline["serverTime"] <= 5000

        expect(guest).to_have_url(f"{short_host_return_url}/?roomEnded=host-timeout", timeout=15000)
        expect(guest.get_by_role("status")).to_contain_text("The room closed because the host did not return in time.")
        expect(page.get_by_role("link", name="Return to room", exact=True)).to_have_count(0)
        assert page.request.get(f"{short_host_return_url}/room/{room}").status == 404

    # Even a browser with no history of the room can safely open the address the host bookmarked.
    with browser.new_page() as visitor:
        visitor.goto(bookmark)
        expect(visitor.locator(".error-card")).to_contain_text("Room not found")
        assert visitor.request.get(f"{short_host_return_url}/room/{room}").status == 404

    # A fresh tab has no copy of the original tab's credentials. Replaying the literal
    # creation URL still cannot create the old room after the homepage clears its ticket.
    page.reload()
    page.wait_for_function("room => !localStorage.getItem('kn-host-return:' + room)", arg=room)
    with page.context.new_page() as fresh:
        fresh.goto(url)
        assert fresh.evaluate("room => sessionStorage.getItem('kn-reconnect-token:' + room)", room) is None
        expect(fresh.locator(".error-card")).to_contain_text("Room not found")
        assert fresh.request.get(f"{short_host_return_url}/room/{room}").status == 404
        fresh.goto(short_host_return_url)
        fresh.click("#create-btn")
        expect(fresh.locator("#host-controls")).to_be_visible()
        new_room = fresh.evaluate("KNState.room")
        assert new_room and new_room != room
        assert fresh.request.get(f"{short_host_return_url}/room/{new_room}").ok

    # A bookmark in the original tab cannot recreate the room even after its ticket expires.
    page.add_init_script("const now = Date.now.bind(Date); Date.now = () => now() + 3600000;")
    page.goto(url)
    expect(page.locator(".error-card")).to_contain_text("Room not found")
    assert page.request.get(f"{short_host_return_url}/room/{room}").status == 404


def test_host_return_after_a_temporary_lookup_failure(page, server_url, room):
    url = f"{server_url}/play.html?room={room}&host=1"
    page.goto(url)
    page.wait_for_function("room => !!sessionStorage.getItem('kn-reconnect-token:' + room)", arg=room)
    page.route(f"**/room/{room}", lambda route: route.fulfill(status=503))
    page.reload()
    expect(page.locator(".error-card")).to_contain_text("try again")
    page.unroute(f"**/room/{room}")
    page.reload()
    expect(page.locator("#host-controls")).to_be_visible()


def test_socket_replacement_cancels_the_old_room_lookup(browser, page, server_url, room):
    url = f"{server_url}/play.html?room={room}"
    page.goto(f"{url}&host=1")
    expect(page.locator("#host-controls")).to_be_visible()
    with browser.new_page() as guest:
        guest.add_init_script("""
            const fetchRoom = window.fetch.bind(window);
            window.fetch = (url, options) => {
                if (!window.answerOldLookup && String(url).startsWith('/room/')) {
                    window.stalledLookup = options?.signal;
                    return new Promise(resolve => {
                        window.answerOldLookup = () => resolve(new Response(null, { status: 404 }));
                    });
                }
                return fetchRoom(url, options);
            };
        """)
        guest.goto(f"{url}&name=Guest")
        guest.wait_for_function("typeof window.answerOldLookup === 'function'")
        guest.evaluate("window.__test_socket.disconnect().connect()")
        guest.wait_for_function("KNState.slot === 1")
        assert guest.evaluate("window.stalledLookup.aborted")
        guest.evaluate("window.answerOldLookup()")
        expect(guest.locator("#error-msg")).to_be_hidden()
        expect(guest.locator("#guest-status")).to_be_visible()


def test_intentional_lobby_leave_transfers_the_room_and_clears_the_return_offer(browser, server_url, room):
    url = f"{server_url}/play.html?room={room}"
    original = browser.new_page()
    guest = browser.new_page()
    try:
        original.goto(f"{url}&host=1&name=Original")
        original.wait_for_function("room => !!sessionStorage.getItem('kn-reconnect-token:' + room)", arg=room)
        guest.goto(f"{url}&name=Guest")
        guest.wait_for_function("KNState.slot === 1")
        original.click("#leave-btn")
        expect(original).to_have_url(f"{server_url}/")
        expect(original.get_by_role("link", name="Return to room", exact=True)).to_have_count(0)
        guest.wait_for_function("KNState.isLocalHost && KNState.slot === 0", timeout=15000)

        original.goto(f"{url}&name=Original")
        original.wait_for_function("KNState.slot === 1")
        expect(original.locator("#guest-status")).to_be_visible()
        expect(original.locator("#host-controls")).to_be_hidden()
        original.wait_for_function("room => !localStorage.getItem('kn-host-return:' + room)", arg=room)
        assert guest.evaluate("room => !!localStorage.getItem('kn-host-return:' + room)", room)
        assert guest.evaluate("KNState.isLocalHost")
    finally:
        original.close()
        guest.close()


def test_host_countdown_tracks_the_game_link_between_roster_updates(page, server_url, room):
    page.goto(f"{server_url}/play.html?room={room}&host=1")
    expect(page.locator("#host-controls")).to_be_visible()
    page.clock.install(time="2025-01-01T00:00:00Z")
    page.clock.pause_at("2025-01-01T00:00:01Z")
    page.evaluate("""() => {
        window.gameLinkOpen = false;
        window.showHostWait = KNCore.play.hostReturn.hostWaitNotice(() => window.gameLinkOpen);
        window.showHostWait({
            status: 'playing', hostReturnDeadline: 121000, serverTime: 1000,
        });
    }""")
    assert page.locator("#toolbar-status").evaluate("element => element.hidden")
    status = page.locator("#host-wait-banner [role=status]")
    timer = page.locator("#host-wait-banner [role=timer]")
    expect(status).to_contain_text("Waiting for them to return")
    expect(timer).to_have_text("2:00")
    page.evaluate("window.gameLinkOpen = true")
    # The display refreshes every half second; allow it to render after the second changes.
    page.clock.run_for(1250)
    expect(status).to_contain_text("game connection is still active")
    expect(timer).to_have_text("1:59")
    page.evaluate("window.gameLinkOpen = false")
    page.clock.run_for(1000)
    expect(status).to_contain_text("Waiting for them to return")
    expect(timer).to_have_text("1:58")
    page.evaluate("() => window.showHostWait(null)")
    expect(status).to_be_hidden()
    assert not page.locator("#toolbar-status").evaluate("element => element.hidden")


def test_guest_returns_first_to_empty_fight_then_leaves_their_seat(browser, server_url, room):
    play_url = f"{server_url}/play.html?room={room}"
    lookup = f"{server_url}/room/{room}"
    with browser.new_context() as host_device, browser.new_context() as guest_device:
        host = host_device.new_page()
        guest = guest_device.new_page()
        host.goto(f"{play_url}&host=1&name=Original")
        expect(host.locator("#host-controls")).to_be_visible()
        guest.goto(f"{play_url}&name=Guest")
        guest.wait_for_function("KNState.slot === 1")
        for page in (host, guest):
            _mark_rom_ready(page)
        expect(host.locator("#start-btn")).to_be_enabled()
        host.click("#start-btn")
        expect(guest.locator("#toolbar")).to_be_visible()
        guest_id = guest.evaluate("sessionStorage.getItem('kn-player-id')")
        ticket = guest.evaluate("room => sessionStorage.getItem('kn-reconnect-token:' + room)", room)
        assert guest_id and ticket
        host.close()
        guest.close()

        guest = guest_device.new_page()
        guest.goto(f"{server_url}/join?room={room}")
        offer = guest.get_by_role("link", name="Return to room", exact=True)
        expect(offer).to_be_visible()
        before = guest.request.get(lookup).json()
        assert before["status"] == "playing" and before["hostReturnDeadline"] > before["serverTime"]
        # Let the server's real roster and credentials reach the new tab before its join acknowledgement.
        guest.add_init_script("""document.addEventListener('load', ({ target }) => {
            if (!(target instanceof HTMLScriptElement) || !target.src.includes('/socket.io.min.js')) return;
            const emit = io.Socket.prototype.emit;
            io.Socket.prototype.emit = function(event, ...args) {
                if (event === 'join-room' && args[0]?.extra?.returnPlayer) {
                    const ack = args.pop();
                    args.push((...reply) => { window.finishSeatReturn = () => ack(...reply); });
                }
                return emit.call(this, event, ...args);
            };
        }, true);""")
        offer.click()
        guest.wait_for_function("typeof window.finishSeatReturn === 'function'")
        assert guest.evaluate("[KNState.slot, KNState.isLocalHost, sessionStorage.getItem('kn-player-id')]") == [
            1, False, guest_id,
        ]
        guest.evaluate("window.finishSeatReturn()")
        assert guest.evaluate("sessionStorage.getItem('kn-player-id')") == guest_id
        expect(guest.locator("#overlay")).to_be_visible()
        expect(guest.locator("#host-wait-banner [role=timer]")).to_be_visible()
        returned = guest.request.get(lookup).json()
        assert returned["status"] == "lobby" and returned["hostReturnDeadline"] == before["hostReturnDeadline"]

        host = host_device.new_page()
        host.goto(server_url)
        host.get_by_role("link", name="Return to room", exact=True).click()
        host.wait_for_function("window.KNState?.slot === 0 && KNState.isLocalHost")
        expect(host.locator("#host-controls")).to_be_visible()
        expect(guest.locator("#host-wait-banner")).to_be_hidden()
        after = host.request.get(lookup).json()
        assert after["status"] == "lobby" and after["player_count"] == 2 and "hostReturnDeadline" not in after

        guest.click("#leave-btn")
        expect(guest).to_have_url(f"{server_url}/")
        assert guest.request.get(lookup, headers={"Authorization": f"Bearer {ticket}"}).status == 404
        expect(guest.get_by_role("link", name="Return to room", exact=True)).to_have_count(0)
        guest.goto(f"{server_url}/join?room={room}")
        expect(guest.locator("#inv-loading")).to_be_hidden()
        expect(guest.get_by_role("link", name="Return to room", exact=True)).to_have_count(0)
        assert host.request.get(lookup).json()["player_count"] == 1


def test_host_guest_start_end(browser, server_url):
    """Full flow: host creates, guest joins, start game, end game."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        # Host creates room
        host.goto(f"{server_url}/play.html?room=E2E01{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        expect(host.locator("#start-btn")).to_be_disabled()

        # Guest joins
        guest.goto(f"{server_url}/play.html?room=E2E01{_R}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        expect(guest.locator("#guest-status")).to_be_visible()

        # Mark both players as ROM-ready
        _mark_rom_ready(host)
        _mark_rom_ready(guest)

        # Start button enables with 2 players + ROMs
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)

        # Host starts game
        host.click("#start-btn")
        expect(host.locator("#overlay")).to_be_hidden(timeout=10000)
        expect(guest.locator("#overlay")).to_be_hidden(timeout=10000)
        expect(host.locator("#toolbar")).to_be_visible()

        # Host ends game (button is inside the more-dropdown)
        host.click("#toolbar-more")
        expect(host.locator("#toolbar-end")).to_be_visible(timeout=2000)
        host.click("#toolbar-end")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
    finally:
        host.close()
        guest.close()


@pytest.mark.parametrize("offer_delay_ms", [0, 1000], ids=["normal", "delayed-offer"])
def test_disconnected_host_keeps_room_during_return_window(browser, server_url, offer_delay_ms):
    """The guest stays in the playing room while the disconnected host can still return."""
    host = browser.new_page()
    guest = browser.new_page()
    if offer_delay_ms:
        # The toolbar is visible before WebRTC connects. A delayed offer makes
        # that ordering deterministic instead of relying on runner load.
        delay_offer = f"""(() => {{
            const createOffer = RTCPeerConnection.prototype.createOffer;
            RTCPeerConnection.prototype.createOffer = async function(...args) {{
                await new Promise(resolve => setTimeout(resolve, {offer_delay_ms}));
                return createOffer.apply(this, args);
            }};
        }})();"""
        for player in (host, guest):
            player.add_init_script(delay_offer)
    room_code = f"E2E02{_R}{offer_delay_ms}"

    try:
        host.goto(f"{server_url}/play.html?room={room_code}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room={room_code}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        _mark_rom_ready(host)
        _mark_rom_ready(guest)

        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)
        expect(guest.locator("#toolbar")).to_be_visible(timeout=10000)

        # Toolbar visibility only says that the start was received. Departing
        # before either channel opens tests a never-connected startup instead
        # of the established peer disconnect this test asserts below.
        for player in (host, guest):
            player.wait_for_function(
                "Object.values(window.KNState.peers || {}).some(peer => peer.dc?.readyState === 'open')",
                timeout=10000,
            )

        # Host navigates away (Socket.IO disconnect; 'leaving' over the DataChannel)
        host.once("dialog", lambda dialog: dialog.accept())
        host.goto("about:blank")

        # Guest is told the host left ("Host dropped" once the host's 'leaving'
        # arrives; "Host disconnected — reconnecting..." if the channel closed first)...
        expect(guest.locator("#toast-container")).to_contain_text(
            re.compile(r"Host (dropped|disconnected)"), timeout=15000
        )
        # ...and is not sent back to the lobby (the old redirect came 2 s after its toast)
        guest.wait_for_timeout(3000)
        expect(guest).to_have_url(re.compile(rf"/play\.html\?room={room_code}"))
        expect(guest.locator("#toolbar")).to_be_visible()
        expect(guest.locator("#overlay")).to_be_hidden()

        # The room is still open, with its match still running
        resp = guest.request.get(f"{server_url}/room/{room_code}")
        assert resp.ok, f"room lookup failed: {resp.status}"
        assert resp.json()["status"] == "playing"
        assert resp.json()["hostReturnDeadline"] > resp.json()["serverTime"]
    finally:
        if not host.is_closed():
            host.close()
        guest.close()


def test_host_leave_lobby_transfers_ownership(browser, server_url):
    """When host leaves in lobby, room stays open for remaining players."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=E2E03{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=E2E03{_R}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Host leaves via button
        host.click("#leave-btn")
        host.wait_for_url("**/", timeout=10000)

        # Guest should still be in the room (overlay visible, no error)
        expect(guest.locator("#overlay")).to_be_visible(timeout=5000)
        expect(guest.locator("#error-msg")).to_be_hidden()
    finally:
        if not host.is_closed():
            host.close()
        guest.close()


def test_guest_nonexistent_room(page, server_url):
    """Guest joining nonexistent room sees error."""
    page.goto(f"{server_url}/play.html?room=NOROOM{_R}&name=Guest")
    expect(page.locator("#error-msg")).to_be_visible(timeout=10000)


# ── ROM Sharing Tests ──────────────────────────────────────────────────


def test_rom_sharing_prompt_appears(browser, server_url):
    """When host enables ROM sharing, joiners see accept/decline prompt.

    Accepting is the "Accept from Host" button; declining is loading your own
    ROM, so the drop zone stays beside the offer (the separate Decline button
    is gone).
    """
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS01{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=ROMS01{_R}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Host marks ROM ready and enables sharing
        _mark_rom_ready(host)
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # Guest sees the offer to accept the host's ROM...
        expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)
        expect(guest.locator("#rom-accept-btn")).to_be_visible()
        expect(guest.locator("#rom-accept-btn")).to_contain_text("Accept from Host")
        # ...beside the drop zone for loading their own instead
        expect(guest.locator("#rom-drop")).to_be_visible()

        # Verify prompt text
        expect(guest.locator(".rom-sharing-prompt-text")).to_contain_text(
            "accept ROM from host"
        )
    finally:
        host.close()
        guest.close()


def test_rom_sharing_decline_shows_drop_zone(browser, server_url):
    """When joiner declines ROM sharing, the ROM drop zone is theirs to use.

    There is no Decline button any more: the drop zone stays beside the offer,
    and a joiner declines by loading their own ROM there, which takes the offer
    away.
    """
    host = browser.new_page()
    guest = browser.new_page()
    # A generated file stands in for the ROM: nothing is booted.
    guest.add_init_script("window.__test_skipBoot = true;")

    try:
        host.goto(f"{server_url}/play.html?room=ROMS02{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=ROMS02{_R}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Host enables sharing
        _mark_rom_ready(host)
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # Wait for prompt, with the drop zone beside it
        expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)
        expect(guest.locator("#rom-drop")).to_be_visible()

        # Guest declines by loading their own ROM from the drop zone
        guest.set_input_files(
            "#rom-drop input[type=file]",
            {"name": "own.z64", "mimeType": "application/octet-stream", "buffer": bytes(range(256)) * 16},
        )
        expect(guest.locator("#rom-status")).to_contain_text("own.z64", timeout=10000)

        # ROM drop zone stays (showing their ROM), prompt hidden
        expect(guest.locator("#rom-drop")).to_be_visible(timeout=5000)
        expect(guest.locator("#rom-sharing-prompt")).to_be_hidden(timeout=5000)

        # Removing that ROM leaves them with none, so the offer comes back
        guest.locator("#rom-library .rom-library-item.active .rom-delete").click(timeout=10000)
        expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=5000)
    finally:
        host.close()
        guest.close()


def test_rom_sharing_start_gated_without_roms(browser, server_url):
    """Host cannot start game when not all players have ROMs and sharing is off."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS03{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=ROMS03{_R}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Only host has ROM
        _mark_rom_ready(host)

        # Start button should show waiting for ROMs
        expect(host.locator("#start-btn")).to_be_disabled(timeout=10000)
        expect(host.locator("#start-btn")).to_contain_text("Waiting for ROMs")

        # Guest loads ROM
        _mark_rom_ready(guest)

        # Now start button should be enabled
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        expect(host.locator("#start-btn")).to_contain_text("Start Game")
    finally:
        host.close()
        guest.close()


def test_rom_sharing_bypasses_rom_requirement(browser, server_url):
    """When host enables sharing, start game is allowed even if guests have no ROM."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS04{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=ROMS04{_R}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Only host has ROM
        _mark_rom_ready(host)

        # Without sharing: disabled
        expect(host.locator("#start-btn")).to_be_disabled(timeout=10000)

        # Enable sharing
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # With sharing: enabled (server allows it)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
    finally:
        host.close()
        guest.close()


def test_rom_sharing_joiner_after_toggle(browser, server_url):
    """Joiner who connects after host enables sharing sees the prompt immediately."""
    host = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS05{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Host enables sharing BEFORE guest joins
        _mark_rom_ready(host)
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # Now guest joins
        guest = browser.new_page()
        try:
            guest.goto(f"{server_url}/play.html?room=ROMS05{_R}&name=Guest")
            expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

            # Guest should see the prompt (from users-updated romSharing field),
            # offered beside the drop zone
            expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)
            expect(guest.locator("#rom-accept-btn")).to_be_visible()
            expect(guest.locator("#rom-drop")).to_be_visible()
        finally:
            guest.close()
    finally:
        host.close()


def test_host_disclaimer_visible(context, server_url):
    """Host sees legal disclaimer when sharing checkbox is checked.

    The sharing checkbox and its disclaimer live in the host's collapsed
    Advanced section, so the host opens it first.
    """
    host = context.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS06{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Open the host's Advanced options, where the sharing checkbox is
        host.click("#host-controls .advanced-options > summary")
        expect(host.locator("#opt-rom-sharing")).to_be_visible(timeout=5000)

        # Disclaimer hidden by default, even with Advanced open
        expect(host.locator("#rom-sharing-disclaimer")).to_be_hidden()

        # Enable sharing (the checkbox is enabled once a ROM is loaded)
        _mark_rom_ready(host)
        host.evaluate("document.getElementById('opt-rom-sharing').disabled = false;")
        host.check("#opt-rom-sharing")

        # Disclaimer visible
        expect(host.locator("#rom-sharing-disclaimer")).to_be_visible(timeout=5000)
        expect(host.locator("#rom-sharing-disclaimer")).to_contain_text(
            "legal right to distribute"
        )
        host.reload()
        expect(host.locator("#host-controls")).to_be_visible()
        host.click("#host-controls .advanced-options > summary")
        expect(host.locator("#opt-rom-sharing")).to_be_checked()
        expect(host.locator("#rom-sharing-disclaimer")).to_be_visible()
    finally:
        host.close()


# ── Info Overlay Tests ────────────────────────────────────────────────


def test_info_overlay_elements_exist(context, server_url):
    """Info overlay has structured layout (header, stats, peers sections)."""
    host = context.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=INFO01{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Info overlay exists in DOM with sub-sections (hidden by default)
        expect(host.locator("#info-overlay")).to_be_hidden()
        assert host.locator("#info-header").count() == 1
        assert host.locator("#info-stats").count() == 1
        assert host.locator("#info-peers").count() == 1

        # Toolbar info button exists (but toolbar is hidden pre-game)
        assert host.locator("#toolbar-info").count() == 1
    finally:
        host.close()


def test_info_overlay_toggle_via_js(page, server_url):
    """Info overlay toggles visibility when toggled programmatically."""
    page.goto(f"{server_url}/play.html?room=INFO02{_R}&host=1&name=Host")
    page.wait_for_function(
        "document.getElementById('info-overlay') !== null", timeout=10000
    )

    # Info overlay starts hidden
    expect(page.locator("#info-overlay")).to_be_hidden()

    # Force-show overlay and toolbar for testing (simulate game running)
    page.evaluate("""
        document.getElementById('toolbar').classList.remove('hidden');
        document.getElementById('info-overlay').classList.remove('hidden');
        document.getElementById('info-header').textContent = 'Lockstep | Keyboard';
        document.getElementById('info-stats').textContent = 'FPS: 60 | Ping: 5ms | Delay: 2f | Players: 2';
    """)

    # Verify overlay is visible with correct content
    expect(page.locator("#info-overlay")).to_be_visible()
    expect(page.locator("#info-header")).to_contain_text("Lockstep")
    expect(page.locator("#info-stats")).to_contain_text("FPS:")
    expect(page.locator("#info-stats")).to_contain_text("Delay:")


def test_info_overlay_rollback_getinfo(page, server_url):
    """Rollback engine getInfo() returns extended fields: mode, peers, sync."""
    page.goto(f"{server_url}/play.html?room=INFO03{_R}&host=1&name=Host")
    page.wait_for_function(
        "typeof window.NetplayRollback !== 'undefined'", timeout=10000
    )

    info = page.evaluate("window.NetplayRollback.getInfo()")
    assert info is not None
    assert info["mode"] == "rollback"
    assert "fps" in info
    assert "frameDelay" in info
    assert "ping" in info
    assert "peers" in info
    assert isinstance(info["peers"], list)
    assert "syncEnabled" in info
    assert "resyncCount" in info


def test_info_overlay_streaming_getinfo(page, server_url):
    """Streaming engine getInfo() exists and returns correct shape."""
    page.goto(
        f"{server_url}/play.html?room=INFO04{_R}&host=1&name=Host&mode=streaming"
    )
    page.wait_for_function(
        "typeof window.NetplayStreaming !== 'undefined'", timeout=10000
    )

    has_getinfo = page.evaluate(
        "typeof window.NetplayStreaming.getInfo === 'function'"
    )
    assert has_getinfo, "NetplayStreaming.getInfo should be a function"

    # getInfo returns null before game starts — should not throw
    page.evaluate("window.NetplayStreaming.getInfo()")


# ── Per-Player Frame Delay Tests ──────────────────────────────────────


def test_guest_sees_delay_picker(page, server_url):
    """Guest player sees frame delay picker elements (lockstep mode)."""
    # Load as guest in lockstep mode — player-controls visible for non-spectators
    page.goto(f"{server_url}/play.html?room=DLY01{_R}&name=Guest")
    page.wait_for_function(
        "document.getElementById('player-controls') !== null", timeout=10000
    )
    page.wait_for_function(
        "typeof window.getDelayPreference === 'function'", timeout=10000
    )

    # Player controls with delay picker exists
    assert page.locator("#player-controls #delay-picker").count() == 1

    # Auto checkbox should be checked by default
    auto_checked = page.evaluate(
        "document.getElementById('delay-auto').checked"
    )
    assert auto_checked is True

    # Select element exists
    assert page.locator("#delay-select").count() == 1
    assert page.evaluate("document.getElementById('delay-select').hidden") is True
    assert page.evaluate("document.querySelector('#delay-select option[value=\"0\"]')?.textContent.trim() === '0'")
    assert page.evaluate(
        "[...document.querySelectorAll('#delay-select option')].every((o) => o.textContent.trim() !== '--')"
    )


def test_host_delay_hidden_streaming(page, server_url):
    """Host delay picker hidden when mode is streaming."""
    page.goto(
        f"{server_url}/play.html?room=DLYS2{_R}&host=1&name=Host&mode=streaming"
    )
    page.wait_for_function(
        "document.getElementById('player-controls') !== null", timeout=10000
    )

    # Host player controls stay hidden; host delay now lives in host Advanced.
    visible = page.evaluate(
        "getComputedStyle(document.getElementById('player-controls')).display !== 'none'"
    )
    assert visible is False, "player-controls should be hidden for hosts"
    delay_visible = page.evaluate(
        "getComputedStyle(document.getElementById('delay-picker')).display !== 'none'"
    )
    assert delay_visible is False, "delay picker should be hidden in streaming mode"

    # Verify switching to rollback shows delay inside host Advanced, not a
    # second player-controls disclosure.
    page.evaluate("document.getElementById('mode-select').value = 'rollback'")
    page.evaluate(
        "document.getElementById('mode-select')"
        ".dispatchEvent(new Event('change'))"
    )
    page.wait_for_function(
        "getComputedStyle(document.getElementById('delay-picker')).display !== 'none'",
        timeout=10000,
    )
    visible_after = page.evaluate(
        "getComputedStyle(document.getElementById('player-controls')).display !== 'none'"
    )
    assert visible_after is False, "player-controls should remain hidden for hosts"
    delay_visible_after = page.evaluate(
        "getComputedStyle(document.getElementById('delay-picker')).display !== 'none'"
    )
    assert delay_visible_after is True, "host delay picker should show in lockstep"


def test_faster_rendering_is_a_local_advanced_option(browser, server_url, room):
    with browser.new_page() as host, browser.new_page() as guest:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        host.locator("#host-controls .advanced-options > summary").click()
        guest.locator("#player-controls .advanced-options > summary").click()

        name = "Faster rendering (experimental)"
        host_option = host.get_by_role("checkbox", name=name)
        guest_option = guest.get_by_role("checkbox", name=name)
        expect(host_option).to_be_visible()
        expect(guest_option).to_be_visible()
        expect(host_option).not_to_be_checked()
        expect(guest_option).not_to_be_checked()

        guest_option.check()
        expect(host_option).not_to_be_checked()
        assert guest.evaluate("KNCore.ejs.earlyVideoPresentationEnabled(window)")
        assert not host.evaluate("KNCore.ejs.earlyVideoPresentationEnabled(window)")
        guest_option.uncheck()
        assert not guest.evaluate("KNCore.ejs.earlyVideoPresentationEnabled(window)")


def test_host_still_has_delay_picker(page, server_url):
    """Host still sees delay picker elements after restructure."""
    page.goto(f"{server_url}/play.html?room=DLYS3{_R}&host=1&name=Host")
    page.wait_for_function(
        "document.getElementById('delay-picker') !== null", timeout=10000
    )

    # Delay picker exists in host Advanced, not as a second Advanced section.
    assert page.locator("#host-controls .advanced-options #delay-picker").count() == 1
    assert page.locator("#player-controls #delay-picker").count() == 0
    # Start button is in host-controls (not player-controls)
    assert page.locator("#host-controls #start-btn").count() == 1
    # delay-auto checkbox exists
    assert page.locator("#delay-auto").count() == 1


def test_guest_delay_preference_readable(browser, server_url):
    """getDelayPreference returns manual delay when set."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=DLYS4{_R}&host=1&name=Host")
        host.wait_for_function(
            "typeof window.getDelayPreference === 'function'", timeout=10000
        )
        host.wait_for_function("window.getDelayPreference() === 0", timeout=10000)

        solo_state = host.evaluate("""
            ({
                delay: window.getDelayPreference(),
                value: document.getElementById('delay-select').value,
                hidden: document.getElementById('delay-select').hidden,
                effective: document.getElementById('delay-effective').textContent,
                summary: document.querySelector('#host-controls .summary-status')?.textContent,
            });
        """)
        assert solo_state == {
            "delay": 0,
            "value": "0",
            "hidden": True,
            "effective": "(solo: no delay)",
            "summary": "Resync on · Dual input on · ROM sharing off · Solo · no delay",
        }

        guest.goto(f"{server_url}/play.html?room=DLYS4{_R}&name=Guest")
        host.wait_for_function("window.getDelayPreference() === 2", timeout=10000)

        # Set manual delay to 5 once there is an actual netplay peer.
        host.evaluate("""
            document.getElementById('delay-auto').checked = false;
            document.getElementById('delay-select').disabled = false;
            document.getElementById('delay-select').value = '5';
            document.getElementById('delay-select').dispatchEvent(new Event('change', { bubbles: true }));
        """)
        manual_state = host.evaluate("""
            ({
                delay: window.getDelayPreference(),
                hidden: document.getElementById('delay-select').hidden,
                effective: document.getElementById('delay-effective').textContent,
                summary: document.querySelector('#host-controls .summary-status')?.textContent,
            });
        """)
        assert manual_state["delay"] == 5, f"Expected manual delay 5, got {manual_state['delay']}"
        assert manual_state["hidden"] is False
        assert manual_state["effective"] == "(Average)"
        assert manual_state["summary"].endswith("Fixed 5")

        reset_state = host.evaluate("""
            const auto = document.getElementById('delay-auto');
            const select = document.getElementById('delay-select');
            auto.checked = true;
            auto.dispatchEvent(new Event('change', { bubbles: true }));
            ({
                disabled: select.disabled,
                hidden: select.hidden,
                value: select.value,
                delay: window.getDelayPreference(),
                effective: document.getElementById('delay-effective').textContent,
            });
        """)
        assert reset_state == {"disabled": True, "hidden": True, "value": "2", "delay": 2, "effective": "(Excellent)"}

        # DOM-tampered values stay in the picker-safe range.
        host.evaluate("""
            document.getElementById('delay-auto').checked = false;
            const sel = document.getElementById('delay-select');
            sel.disabled = false;
            sel.appendChild(new Option('999', '999'));
            sel.value = '999';
        """)
        delay = host.evaluate("window.getDelayPreference()")
        assert delay == 9, f"Expected clamped delay 9, got {delay}"

        zero_state = host.evaluate("""
            const sel = document.getElementById('delay-select');
            sel.value = '0';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            ({
                value: sel.value,
                delay: window.getDelayPreference(),
                effective: document.getElementById('delay-effective').textContent,
                summary: document.querySelector('#host-controls .summary-status')?.textContent,
            });
        """)
        assert zero_state == {
            "value": "2",
            "delay": 2,
            "effective": "(Excellent)",
            "summary": "Resync on · Dual input on · ROM sharing off · Fixed 2",
        }
    finally:
        host.close()
        guest.close()


# ── Worker Base64 Test ────────────────────────────────────────────────


def test_worker_compress_and_encode(page, server_url):
    """NetplayRollback module loads and getInfo is callable."""
    page.goto(f"{server_url}/play.html?room=WKRS1{_R}&host=1&name=Host")
    page.wait_for_function(
        "typeof window.NetplayRollback !== 'undefined'", timeout=10000
    )

    # Verify the rollback module is loaded with getInfo
    result = page.evaluate("""
        (() => {
            try {
                if (typeof window.NetplayRollback === 'undefined') {
                    return { error: 'NetplayRollback not defined' };
                }
                var info = window.NetplayRollback.getInfo();
                return {
                    ok: true,
                    hasMode: info.mode === 'rollback',
                    hasPeers: Array.isArray(info.peers),
                };
            } catch (e) {
                return { error: e.message };
            }
        })()
    """)
    assert result.get("ok") is True, f"Rollback module check failed: {result}"
    assert result.get("hasMode") is True, "getInfo should have mode='rollback'"
    assert result.get("hasPeers") is True, "getInfo should have peers array"


def test_share_dropdown_copies_links(browser, server_url):
    """In-game share menu offers play and watch links and copies one.

    The links are the Invite group of the toolbar's More menu (they had a
    toolbar button and dropdown of their own once).
    """
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=SHR01{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=SHR01{_R}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        _mark_rom_ready(host)
        _mark_rom_ready(guest)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)

        # The More button (which holds the Invite links) exists
        expect(host.locator("#toolbar-more")).to_be_visible()

        # Menu initially hidden
        expect(host.locator("#more-dropdown")).to_be_hidden()

        # Click opens the menu with both invite links
        host.click("#toolbar-more")
        expect(host.locator("#more-dropdown")).to_be_visible(timeout=2000)
        expect(host.locator("#invite-submenu")).to_contain_text("Invite")
        expect(host.locator("#share-play")).to_be_visible()
        expect(host.locator("#share-watch")).to_be_visible()

        # Click share-play copies the play link and closes the menu
        host.click("#share-play")
        expect(host.locator("#toast-container")).to_contain_text("Play link copied!", timeout=2000)
        expect(host.locator("#more-dropdown")).to_be_hidden(timeout=2000)
    finally:
        host.close()
        guest.close()


def test_auto_spectate_when_room_full(browser, server_url):
    """Joining a full room auto-spectates with a banner."""
    host = browser.new_page()
    p2 = browser.new_page()
    p3 = browser.new_page()
    p4 = browser.new_page()
    joiner = browser.new_page()

    try:
        # Fill room to 4 players
        host.goto(f"{server_url}/play.html?room=FULL01{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        p2.goto(f"{server_url}/play.html?room=FULL01{_R}&name=P2")
        expect(p2.locator("#overlay")).to_be_visible(timeout=10000)

        p3.goto(f"{server_url}/play.html?room=FULL01{_R}&name=P3")
        expect(p3.locator("#overlay")).to_be_visible(timeout=10000)

        p4.goto(f"{server_url}/play.html?room=FULL01{_R}&name=P4")
        expect(p4.locator("#overlay")).to_be_visible(timeout=10000)

        # 5th player joins via play link (no spectate param)
        joiner.goto(f"{server_url}/play.html?room=FULL01{_R}&name=Late")
        # Auto-spectating keeps the overlay visible and shows a notice.
        expect(joiner.locator("#overlay")).to_be_visible(timeout=10000)
        expect(joiner.locator("#toast-container .toast", has_text="joined as a spectator")).to_be_visible(timeout=5000)

        # The notice expires.
        expect(joiner.locator("#toast-container .toast", has_text="joined as a spectator")).to_be_hidden(timeout=7000)
    finally:
        host.close()
        p2.close()
        p3.close()
        p4.close()
        joiner.close()


def test_gamepad_manager_has_gamepad(page, server_url):
    """GamepadManager.hasGamepad exists and returns false when no gamepad."""
    page.goto(f"{server_url}/play.html?room=GMS01{_R}&host=1&name=Host")
    page.wait_for_function(
        "typeof window.GamepadManager !== 'undefined'"
        " && typeof window.GamepadManager.hasGamepad === 'function'",
        timeout=10000,
    )

    result = page.evaluate("window.GamepadManager.hasGamepad(0)")
    assert result is False, "Should return false without gamepad"
