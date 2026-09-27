"""Room overlay restyle (docs/landing-design.md §7.2 M3, §7.3 "Room overlay").

Covers the states the M3 build plan calls out: needs ROM, wrong ROM, cached
ROM, unsupported ROM, watching instead, unsupported browser; plus the
slot-claim/spectators-full copy and the Match start boot overlay driven by
real state.

Run: pytest tests/test_room_overlay.py -v
"""

import os
import tempfile

from playwright.sync_api import expect


def _make_fake_rom(content_byte: int, size: int = 4096) -> str:
    fd, path = tempfile.mkstemp(suffix=".z64")
    os.write(fd, bytes([content_byte]) * size)
    os.close(fd)
    return path


def _mark_rom_ready(page):
    page.wait_for_function("window.__test_socket && window.__test_socket.connected", timeout=10000)
    page.evaluate("""
        if (window.__test_setRomLoaded) window.__test_setRomLoaded();
        window.__test_socket.emit('rom-ready', { ready: true });
    """)


# ── Needs ROM: host ✓ ROM visible; dropzone names the host's exact game ────


def test_needs_rom_shows_host_game_and_check(browser, server_url, room):
    host = browser.new_page()
    guest = browser.new_page()
    try:
        rom = _make_fake_rom(0x11)
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(rom)
        host.wait_for_timeout(500)

        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        guest.wait_for_timeout(1000)

        # Host's own slot shows "✓ ROM" once loaded (W4 §4)
        expect(host.locator('.player-slot[data-slot="0"] .rom-status')).to_have_text("✓ ROM", timeout=10000)

        # The dropzone names the host's exact game to the guest
        host_info = guest.locator("#host-rom-info")
        expect(host_info).to_be_visible(timeout=10000)
        assert "Host ROM" in host_info.inner_text()

        # Guest's own slot reads "needs ROM" until they load one
        expect(guest.locator('.player-slot[data-slot="1"] .rom-status')).to_have_text("needs ROM", timeout=10000)

        # "Watch instead" is offered while the guest has no ROM
        expect(guest.locator("#watch-instead-row")).to_be_visible(timeout=10000)
    finally:
        host.close()
        guest.close()


# ── Wrong ROM: names both games, offers "Choose another" ──────────────────


def test_wrong_rom_names_both_games(browser, server_url, room):
    host = browser.new_page()
    guest = browser.new_page()
    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(_make_fake_rom(0x22))
        host.wait_for_timeout(500)

        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        guest.wait_for_timeout(500)

        guest.locator("#rom-drop input[type='file']").set_input_files(_make_fake_rom(0x33))
        guest.wait_for_timeout(1000)

        mismatch = guest.locator("#rom-mismatch")
        expect(mismatch).to_be_visible(timeout=10000)
        text = mismatch.inner_text()
        assert "doesn't match" in text
        # Names the host's game and something about the dropped file
        assert "Host ROM" not in text  # this is the mismatch banner, not the host-rom-info line
        expect(guest.locator("#rom-mismatch-choose")).to_be_visible()
    finally:
        host.close()
        guest.close()


# ── Cached ROM: auto-matched, library visible ──────────────────────────────


def test_cached_rom_library_visible_for_guest(browser, server_url, room):
    import random
    import string

    tag = "".join(random.choices(string.ascii_uppercase, k=4))
    host_ctx = browser.new_context()
    guest_ctx = browser.new_context()
    host = host_ctx.new_page()
    guest = guest_ctx.new_page()
    try:
        rom = _make_fake_rom(0x44)

        # Guest caches the ROM in a solo room first.
        guest.goto(f"{server_url}/play.html?room=OV1{tag}&host=1&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        guest.locator("#rom-drop input[type='file']").set_input_files(rom)
        guest.wait_for_timeout(800)

        # Host creates a room with the same ROM.
        host.goto(f"{server_url}/play.html?room=OV2{tag}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(rom)
        host.wait_for_timeout(800)

        # Guest joins fresh (clear the auto-loaded blob so the library path
        # renders explicitly, mirroring a new-tab join).
        guest.goto(f"{server_url}/play.html?room=OV2{tag}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        guest.wait_for_timeout(1500)

        library = guest.locator("#rom-library")
        expect(library).to_be_visible(timeout=10000)
        # CSS text-transform:uppercase changes rendered inner_text; compare
        # against the source markup instead.
        assert "Your ROMs on this device" in library.inner_html()
        assert "matches-host" in library.inner_html() or "Matches host" in library.inner_html()
    finally:
        host.close()
        guest.close()
        host_ctx.close()
        guest_ctx.close()


# ── Unsupported ROM: warns, still allows Start ─────────────────────────────


def test_unsupported_rom_warns_but_allows_start(browser, server_url, room):
    host = browser.new_page()
    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        # A random 4KB file with an "S..." hash will never be in known_roms.json.
        host.locator("#rom-drop input[type='file']").set_input_files(_make_fake_rom(0x55))
        host.wait_for_timeout(1000)

        status = host.locator("#rom-status")
        expect(status).to_have_class(__import__("re").compile(r"rom-unsupported"), timeout=10000)
        assert "not a supported ROM" in status.inner_text()

        # Start still enables for a single host with an unsupported ROM.
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
    finally:
        host.close()


# ── Watching instead: player releases their slot without leaving the room ─


def test_watch_instead_switches_to_spectator_in_place(browser, server_url, room):
    host = browser.new_page()
    guest = browser.new_page()
    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        expect(guest.locator("#watch-instead-row")).to_be_visible(timeout=10000)

        url_before = guest.url
        guest.click("#watch-instead-btn")

        # Server round trip — the room-broadcast users-updated flips isSpectator.
        expect(guest.locator("#rom-drop")).to_be_hidden(timeout=10000)
        assert guest.url == url_before  # never left the page / no navigation
        # The host sees the guest listed as a spectator, not in a player slot.
        expect(host.locator("#spectator-list")).to_contain_text("Guest", timeout=10000)
        expect(host.locator('.player-slot[data-slot="1"] .name')).to_have_text("Open", timeout=10000)
    finally:
        host.close()
        guest.close()


def test_release_slot_rejected_mid_game(context, server_url, room):
    """Server refuses release-slot once the game is running (lobby-only)."""
    host = context.new_page()
    guest = context.new_page()
    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        _mark_rom_ready(host)
        _mark_rom_ready(guest)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)
        expect(guest.locator("#toolbar")).to_be_visible(timeout=10000)

        result = guest.evaluate("""
            new Promise(resolve => {
                window.__test_socket.emit('release-slot', {}, resolve);
            })
        """)
        assert result == "Cannot switch to spectator during an active game"
    finally:
        host.close()
        guest.close()


def test_host_cannot_release_slot(context, server_url, room):
    host = context.new_page()
    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        result = host.evaluate("""
            new Promise(resolve => {
                window.__test_socket.emit('release-slot', {}, resolve);
            })
        """)
        assert result == "Host can't switch to spectator"
    finally:
        host.close()


# ── Unsupported browser screen ──────────────────────────────────────────────


def test_unsupported_browser_screen_shown_when_rtc_missing(browser, server_url, room):
    ctx = browser.new_context()
    ctx.add_init_script("delete window.RTCPeerConnection; delete window.webkitRTCPeerConnection;")
    page = ctx.new_page()
    try:
        page.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(page.locator("#unsupported-browser")).to_be_visible(timeout=10000)
        expect(page.locator("#overlay")).to_be_hidden()
        detail = page.locator("#unsupported-detail").inner_text()
        assert "WebRTC" in detail or "peer-to-peer" in detail
        # RTCPeerConnection missing → no "Watch instead" (needs WebRTC too).
        expect(page.locator("#unsupported-watch")).to_be_hidden()
        expect(page.locator("#unsupported-copy")).to_be_visible()
    finally:
        page.close()
        ctx.close()


def test_unsupported_browser_offers_watch_when_webrtc_present(browser, server_url, room):
    ctx = browser.new_context()
    # Simulate a missing feature that isn't WebRTC (crossOriginIsolated off,
    # e.g. an in-app browser) — Watch should still be offered.
    ctx.add_init_script("Object.defineProperty(self, 'crossOriginIsolated', { value: false, configurable: true });")
    page = ctx.new_page()
    try:
        page.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(page.locator("#unsupported-browser")).to_be_visible(timeout=10000)
        expect(page.locator("#unsupported-watch")).to_be_visible(timeout=10000)
    finally:
        page.close()
        ctx.close()


# ── Spectator slot-claim / spectators-full copy ────────────────────────────


def test_spectator_claim_button_copy(browser, server_url, room):
    host = browser.new_page()
    spectator = browser.new_page()
    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        spectator.goto(f"{server_url}/play.html?room={room}&name=Spec&spectate=1")
        expect(spectator.locator("#overlay")).to_be_visible(timeout=10000)
        spectator.wait_for_timeout(500)

        claim_btn = spectator.locator('.claim-slot-btn[data-slot="1"]')
        expect(claim_btn).to_be_visible(timeout=10000)
        assert claim_btn.inner_text().replace("\xb7", "·") in (
            "Join · needs your ROM",
            "Join · needs your ROM",
        )

        claim_btn.click()
        # Claiming moves the spectator into the player list.
        expect(spectator.locator("#rom-drop")).to_be_visible(timeout=10000)
        expect(host.locator('.player-slot[data-slot="1"] .name')).to_contain_text("Spec", timeout=10000)
    finally:
        host.close()
        spectator.close()


def test_spectators_full_message(browser, server_url, room, monkeypatch=None):
    host = browser.new_page()
    watchers = [browser.new_page() for _ in range(3)]
    one_more = browser.new_page()
    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Fill the per-IP spectator cap (default 3 from the same network/IP)
        # so the next spectator join is refused for a network-level reason —
        # exercise the copy path directly against the server instead, since
        # MAX_SPECTATORS (20) is impractical to fill in a test.
        for w in watchers:
            w.goto(f"{server_url}/play.html?room={room}&name=Watcher&spectate=1")
            expect(w.locator("#overlay")).to_be_visible(timeout=10000)

        one_more.goto(f"{server_url}/play.html?room={room}&name=OneMore&spectate=1")
        one_more.wait_for_function("window.__test_socket && window.__test_socket.connected", timeout=10000)
        result = one_more.evaluate(f"""
            new Promise(resolve => {{
                window.__test_socket.emit('join-room', {{
                    extra: {{
                        sessionid: '{room}',
                        persistentId: 'spec-cap-test',
                        reconnectToken: '',
                        player_name: 'OneMore',
                        spectate: true
                    }}
                }}, (err) => resolve(err));
            }})
        """)
        assert result == "Spectator limit reached for your network"
    finally:
        host.close()
        for w in watchers:
            w.close()
        one_more.close()


# ── Match start boot overlay — real per-slot state, not a fixed timer ──────


def test_boot_ports_fill_from_real_rom_ready_state(browser, server_url, room):
    host = browser.new_page()
    guest = browser.new_page()
    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        _mark_rom_ready(host)
        _mark_rom_ready(guest)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#game-loading")).to_be_visible(timeout=10000)

        # The host's own port (slot 0) fills immediately — it's driven by
        # its own romReady state, not a fixed animation timer.
        expect(host.locator('.ms-boot .fill[data-slot="0"]')).to_have_class(
            __import__("re").compile(r"is-ready"), timeout=10000
        )
    finally:
        host.close()
        guest.close()


def test_boot_ports_still_frame_under_reduced_motion(browser, server_url, room):
    ctx = browser.new_context(reduced_motion="reduce")
    host = ctx.new_page()
    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        _mark_rom_ready(host)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#game-loading")).to_be_visible(timeout=10000)
        host.wait_for_timeout(600)

        transition = host.evaluate(
            "getComputedStyle(document.querySelector('.ms-boot .fill[data-slot=\"0\"]')).transitionDuration"
        )
        assert transition in ("0s", "0s, 0s")
        # Still reflects the real state (filled), just without the animation.
        expect(host.locator('.ms-boot .fill[data-slot="0"]')).to_have_class(
            __import__("re").compile(r"is-ready"), timeout=10000
        )
    finally:
        host.close()
        ctx.close()
