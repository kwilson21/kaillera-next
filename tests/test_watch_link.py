"""Verify that the watch link (spectate=1) mid-game join shows a video stream,
NOT the emulator/ROM prompt.

Run: pytest tests/test_watch_link.py -v
"""

from playwright.sync_api import expect


def _mark_rom_ready(page):
    """Simulate a player having loaded a ROM by emitting rom-ready."""
    page.evaluate("window._socket.emit('rom-ready', { ready: true })")


def _start_game_via_socket(page, mode="lockstep"):
    """Emit start-game directly via socket, bypassing the client-side ROM check."""
    page.evaluate(f"""
        window._socket.emit('start-game', {{
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
        assert is_spectator is True, f"Expected spectator mode, got _isSpectator={is_spectator}"

        # Verify no emulator was booted (no EJS_emulator global)
        has_emulator = spectator.evaluate(
            "typeof window.EJS_emulator !== 'undefined' && window.EJS_emulator !== null"
        )
        assert has_emulator is False, "Emulator should NOT be booted for spectators"

    finally:
        host.close()
        guest.close()
        spectator.close()


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
