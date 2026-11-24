"""Verify that the watch link (spectate=1) mid-game join shows a video stream,
NOT the emulator/ROM prompt.

Run: pytest tests/test_watch_link.py -v
"""

import pytest
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect


def _mark_rom_ready(page):
    """Simulate a player having loaded a ROM (client state + server signal)."""
    page.evaluate("""
        if (window.__test_setRomLoaded) window.__test_setRomLoaded();
        window.__test_socket.emit('rom-ready', { ready: true });
    """)


def _start_game_via_socket(page, mode="rollback"):
    """Emit start-game directly via socket, bypassing the client-side ROM check."""
    page.evaluate(f"""
        window.__test_socket.emit('start-game', {{
            mode: '{mode}',
            rollbackEnabled: false,
            romHash: null
        }})
    """)


def test_watch_link_midgame_no_rom_prompt(browser, server_url):
    """Spectator joining mid-game via watch link should NOT see ROM prompt.

    They should see the toolbar (game UI) and the engine should be initialized
    in spectator mode — no emulator boot, no ROM drop zone.
    """
    host = browser.new_page()
    guest = browser.new_page()
    spectator = browser.new_page()

    try:
        # Host creates room
        host.goto(f"{server_url}/play.html?room=WATCH01&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Guest joins as player
        guest.goto(f"{server_url}/play.html?room=WATCH01&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Mark both players as ROM-ready
        _mark_rom_ready(host)
        _mark_rom_ready(guest)

        # Start button enables with 2 players + ROMs
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)

        # Start game via socket (bypasses client-side _romBlob check)
        _start_game_via_socket(host)

        # Host and guest enter game (toolbar visible, overlay hidden)
        # Note: without a real ROM, bootEmulator won't fully work, but
        # onGameStarted still fires and shows the toolbar
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)
        expect(guest.locator("#toolbar")).to_be_visible(timeout=10000)

        # Now spectator joins mid-game via watch link (no ROM, no host param)
        spectator.goto(f"{server_url}/play.html?room=WATCH01&name=Watcher&spectate=1")

        # Spectator should see the toolbar (game is running), NOT the overlay/ROM prompt
        expect(spectator.locator("#toolbar")).to_be_visible(timeout=10000)

        # The overlay (which contains ROM drop) should be hidden
        expect(spectator.locator("#overlay")).to_be_hidden(timeout=5000)

        # The late-join ROM message should NOT exist
        late_join_msg = spectator.locator("#late-join-msg")
        expect(late_join_msg).to_have_count(0)

        # Verify the engine was initialized as spectator (not as a player)
        is_spectator = spectator.evaluate("window._isSpectator")
        assert is_spectator is True, (
            f"Expected spectator mode, got _isSpectator={is_spectator}"
        )

        # Verify no emulator was booted (no EJS_emulator global)
        has_emulator = spectator.evaluate(
            "typeof window.EJS_emulator !== 'undefined' && window.EJS_emulator !== null"
        )
        assert has_emulator is False, "Emulator should NOT be booted for spectators"

    finally:
        host.close()
        guest.close()
        spectator.close()


@pytest.mark.parametrize("mode", ["rollback", "lockstep"])
@pytest.mark.parametrize(
    "scenario", ["relay", "stun", "transient", "managed", "expired"]
)
def test_watch_link_waits_for_relay_before_answering(
    browser, server_url, mode, scenario
):
    """Watchers wait for TURN, and a later offer may recover a transient lookup."""
    host, guest, watcher = [browser.new_page() for _ in range(3)]
    room = f"W{mode[0].upper()}{scenario[:3].upper()}"
    relay_available = scenario == "relay"
    delayed_ice = []
    turn_url = "turn:127.0.0.1:3478"
    watcher.route("**/ice-servers?token=*", lambda route: delayed_ice.append(route))
    watcher.add_init_script("""
        window.__watchOffers = new Set();
        window.__watchOfferCount = 0;
        window.__watchAnswers = [];
        const now = Date.now.bind(Date);
        window.__watchClockOffset = 0;
        Date.now = () => now() + window.__watchClockOffset;
        Object.defineProperty(window, 'io', {
            configurable: true,
            set(nativeIo) {
                Object.defineProperty(window, 'io', {
                    configurable: true,
                    value(...options) {
                        const socket = nativeIo(...options);
                        socket.onAny((event, signal) => {
                            if (event === 'webrtc-signal' && signal?.offer) {
                                window.__watchOffers.add(signal.sender);
                                window.__watchOfferCount++;
                            }
                        });
                        return socket;
                    },
                });
            },
        });
        const NativePeerConnection = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends NativePeerConnection {
            setLocalDescription(description) {
                if (description?.type === 'answer') {
                    const { iceServers, iceTransportPolicy } = this.getConfiguration();
                    window.__watchAnswers.push({
                        iceTransportPolicy,
                        urls: iceServers.flatMap((server) => server.urls),
                    });
                }
                return super.setLocalDescription(description);
            }
        };
    """)

    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        for player in (host, guest):
            expect(player.locator("#overlay")).to_be_visible(timeout=10000)
            _mark_rom_ready(player)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        _start_game_via_socket(host, mode)
        for player in (host, guest):
            expect(player.locator("#toolbar")).to_be_visible(timeout=10000)
            player.wait_for_function(
                "Object.values(window.KNState?.peers || {}).some((p) => p.dc?.readyState === 'open')",
                timeout=10000,
            )
            player.evaluate(
                "window.__watchPlayerChannel = Object.values(window.KNState.peers)"
                ".find((p) => p.dc?.readyState === 'open').dc"
            )

        watcher.goto(f"{server_url}/play.html?room={room}&name=Watcher&spectate=1")
        watcher.wait_for_function(
            "window._isSpectator && window.__watchOffers.size === 2", timeout=10000
        )
        assert delayed_ice, "expected the authenticated ICE request to be held"
        stun = {"urls": "stun:127.0.0.1:3478"}
        turn = {"urls": turn_url, "username": "fixture", "credential": "fixture"}
        for route in delayed_ice:
            if scenario in ("transient", "expired"):
                route.fulfill(status=503)
            elif scenario == "managed":
                route.fulfill(json=[stun], headers={"X-KN-Relay-Retry-After": "60"})
            else:
                route.fulfill(
                    json=[stun, turn] if relay_available else [stun],
                    headers={"X-KN-Relay-Ttl": "86400"} if relay_available else {},
                )

        if relay_available:
            watcher.wait_for_function(
                "window.__watchAnswers.length === 2", timeout=10000
            )
            # Rejoin after the old 30-minute cap. The new request fails,
            # but the first response guaranteed the opaque static relay for 24 hours.
            watcher.evaluate("window.__watchClockOffset = 31 * 60 * 1000")
            assert len(delayed_ice) == 1
            old_sid = watcher.evaluate("window.__test_socket.id")
            with watcher.expect_request("**/ice-servers?token=*", timeout=10000):
                watcher.evaluate("window.__test_socket.io.engine.close()")
            watcher.wait_for_function(
                "(oldSid) => window.__test_socket.connected && window.__test_socket.id !== oldSid",
                arg=old_sid,
                timeout=10000,
            )
            assert len(delayed_ice) >= 2
            delayed_ice[-1].fulfill(status=503)
            watcher.wait_for_function(
                "window.__watchAnswers.length === 4", timeout=10000
            )
            assert watcher.locator("#error-msg").is_hidden()
            for answer in watcher.evaluate("window.__watchAnswers"):
                assert answer["iceTransportPolicy"] == "relay"
                assert turn_url in answer["urls"]
        else:
            expect(watcher.locator("#error-msg")).to_contain_text(
                "private spectator connection is unavailable"
            )
            assert watcher.evaluate("window.__watchAnswers.length") == 0
            assert len(delayed_ice) == 1

            spectator_sid = watcher.evaluate("window.__test_socket.id")

            def later_offers():
                for player in (host, guest):
                    player.evaluate(
                        """
                        (sid) => {
                          const pc = window.KNState.peers[sid].pc;
                          window.__test_socket.emit('webrtc-signal', {
                            target: sid, offer: pc.localDescription, attemptId: pc._knAttempt,
                          });
                        }
                        """,
                        spectator_sid,
                    )

            if scenario == "managed":
                watcher.evaluate("window.__watchClockOffset = 30 * 1000")
                with (
                    pytest.raises(PlaywrightTimeoutError),
                    watcher.expect_request("**/ice-servers?token=*", timeout=500),
                ):
                    later_offers()
                assert len(delayed_ice) == 1
                assert watcher.evaluate("window.__watchAnswers.length") == 0
                watcher.evaluate("window.__watchClockOffset = 61 * 1000")

            if scenario in ("transient", "managed"):
                with watcher.expect_request("**/ice-servers?token=*", timeout=3000):
                    later_offers()
                watcher.wait_for_function(
                    "(expected) => window.__watchOfferCount >= expected",
                    arg=6 if scenario == "managed" else 4,
                    timeout=3000,
                )
                assert len(delayed_ice) == 2
                delayed_ice[-1].fulfill(
                    json=[stun, turn], headers={"X-KN-Relay-Ttl": "86400"}
                )
                watcher.wait_for_function(
                    "window.__watchAnswers.length === 2", timeout=3000
                )
                assert all(
                    answer["iceTransportPolicy"] == "relay"
                    and turn_url in answer["urls"]
                    for answer in watcher.evaluate("window.__watchAnswers")
                )
                assert watcher.evaluate("window.__test_socket.id") == spectator_sid
            else:
                if scenario == "expired":
                    watcher.evaluate("window.__watchClockOffset = 31 * 60 * 1000")
                with (
                    pytest.raises(PlaywrightTimeoutError),
                    watcher.expect_request("**/ice-servers?token=*", timeout=500),
                ):
                    later_offers()
                assert watcher.evaluate("window.__watchOfferCount") >= 4
                assert len(delayed_ice) == 1
                assert watcher.evaluate("window.__watchAnswers.length") == 0
        assert watcher.evaluate("!window.EJS_emulator")

        for player in (host, guest):
            assert player.evaluate(
                "Object.values(window.KNState.peers)"
                ".some((p) => p.dc === window.__watchPlayerChannel && p.dc.readyState === 'open')"
            )
    finally:
        watcher.close()
        guest.close()
        host.close()


def test_watch_link_pregame_no_rom_needed(browser, server_url):
    """Spectator joining before game starts, then game starts — no ROM needed."""
    host = browser.new_page()
    guest = browser.new_page()
    spectator = browser.new_page()

    try:
        # Host creates room
        host.goto(f"{server_url}/play.html?room=WATCH02&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Spectator joins pre-game via watch link
        spectator.goto(f"{server_url}/play.html?room=WATCH02&name=Watcher&spectate=1")
        expect(spectator.locator("#overlay")).to_be_visible(timeout=10000)

        # Guest joins as player
        guest.goto(f"{server_url}/play.html?room=WATCH02&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Mark players ROM-ready (spectator should NOT need ROM)
        _mark_rom_ready(host)
        _mark_rom_ready(guest)

        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)

        # Start game via socket
        _start_game_via_socket(host)

        # All should see toolbar
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)
        expect(guest.locator("#toolbar")).to_be_visible(timeout=10000)
        expect(spectator.locator("#toolbar")).to_be_visible(timeout=10000)

        # Spectator overlay should be hidden
        expect(spectator.locator("#overlay")).to_be_hidden(timeout=5000)

        # Verify spectator mode
        is_spectator = spectator.evaluate("window._isSpectator")
        assert is_spectator is True

        # No emulator booted
        has_emulator = spectator.evaluate(
            "typeof window.EJS_emulator !== 'undefined' && window.EJS_emulator !== null"
        )
        assert has_emulator is False

    finally:
        host.close()
        guest.close()
        spectator.close()


def test_play_link_midgame_still_shows_rom_prompt(browser, server_url):
    """Player (not spectator) joining mid-game without ROM should still see ROM prompt."""
    host = browser.new_page()
    guest = browser.new_page()
    late_player = browser.new_page()

    try:
        # Host creates room
        host.goto(f"{server_url}/play.html?room=WATCH03&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Guest joins as player
        guest.goto(f"{server_url}/play.html?room=WATCH03&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Mark both players as ROM-ready
        _mark_rom_ready(host)
        _mark_rom_ready(guest)

        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)

        # Start game
        _start_game_via_socket(host)
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)

        # Late player joins mid-game via PLAY link (no spectate param, no ROM)
        late_player.goto(f"{server_url}/play.html?room=WATCH03&name=LateJoiner")

        # Late player should see the ROM prompt (they need a ROM to play)
        expect(late_player.locator("#late-join-msg")).to_be_visible(timeout=10000)

        # Toolbar should NOT be visible (they haven't loaded ROM yet)
        expect(late_player.locator("#toolbar")).to_be_hidden()

    finally:
        host.close()
        guest.close()
        late_player.close()
