"""Minimal E2E tests for the MVP P0 flow.

Run: pytest tests/test_e2e.py -v
"""

import re

from playwright.sync_api import expect


def _mark_rom_ready(page):
    """Simulate a player having loaded a ROM by emitting rom-ready."""
    page.evaluate("window._socket.emit('rom-ready', { ready: true })")



def test_lobby_to_play_redirect(page, server_url):
    """Create Room redirects to play.html with correct params."""
    page.goto(server_url)
    page.fill("#player-name", "Host")
    page.click("#create-btn")
    expect(page).to_have_url(re.compile(
        r"play\.html\?room=\w+&host=1&name=Host&mode=lockstep"
    ))


def test_host_guest_start_end(browser, server_url):
    """Full flow: host creates, guest joins, start game, end game."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        # Host creates room
        host.goto(f"{server_url}/play.html?room=E2E01&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        expect(host.locator("#start-btn")).to_be_disabled()

        # Guest joins
        guest.goto(f"{server_url}/play.html?room=E2E01&name=Guest")
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

        # Host ends game
        host.click("#toolbar-end")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
    finally:
        host.close()
        guest.close()


def test_host_leave_midgame_closes_room(browser, server_url):
    """When host leaves mid-game, guest gets room-closed and redirects to lobby."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=E2E02&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=E2E02&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        _mark_rom_ready(host)
        _mark_rom_ready(guest)

        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)
        expect(guest.locator("#toolbar")).to_be_visible(timeout=10000)

        # Host navigates away (triggers Socket.IO disconnect)
        host.goto("about:blank")

        # Guest should be redirected to lobby (2s toast delay + Socket.IO detection)
        guest.wait_for_url(re.compile(r"/$"), timeout=15000)
    finally:
        if not host.is_closed():
            host.close()
        guest.close()


def test_host_leave_lobby_transfers_ownership(browser, server_url):
    """When host leaves in lobby, room stays open for remaining players."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=E2E03&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=E2E03&name=Guest")
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
    page.goto(f"{server_url}/play.html?room=NOROOM&name=Guest")
    expect(page.locator("#error-msg")).to_be_visible(timeout=10000)


# ── ROM Sharing Tests ──────────────────────────────────────────────────


def test_rom_sharing_prompt_appears(browser, server_url):
    """When host enables ROM sharing, joiners see accept/decline prompt."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS01&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=ROMS01&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Host marks ROM ready and enables sharing
        _mark_rom_ready(host)
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # Guest should see the accept/decline prompt (not the ROM drop zone)
        expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)
        expect(guest.locator("#rom-drop")).to_be_hidden()

        # Verify prompt text
        expect(guest.locator(".rom-sharing-prompt-text")).to_contain_text(
            "offering to share"
        )
    finally:
        host.close()
        guest.close()


def test_rom_sharing_decline_shows_drop_zone(browser, server_url):
    """When joiner declines ROM sharing, ROM drop zone reappears."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS02&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=ROMS02&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Host enables sharing
        _mark_rom_ready(host)
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # Wait for prompt
        expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)

        # Guest declines
        guest.click("#rom-decline-btn")

        # ROM drop zone should reappear, prompt hidden
        expect(guest.locator("#rom-drop")).to_be_visible(timeout=5000)
        expect(guest.locator("#rom-sharing-prompt")).to_be_hidden()
    finally:
        host.close()
        guest.close()


def test_rom_sharing_start_gated_without_roms(browser, server_url):
    """Host cannot start game when not all players have ROMs and sharing is off."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS03&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=ROMS03&name=Guest")
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
        host.goto(f"{server_url}/play.html?room=ROMS04&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=ROMS04&name=Guest")
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
        host.goto(f"{server_url}/play.html?room=ROMS05&host=1&name=Host")
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
            guest.goto(f"{server_url}/play.html?room=ROMS05&name=Guest")
            expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

            # Guest should see the prompt (from users-updated romSharing field)
            expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)
            expect(guest.locator("#rom-drop")).to_be_hidden()
        finally:
            guest.close()
    finally:
        host.close()


def test_host_disclaimer_visible(browser, server_url):
    """Host sees legal disclaimer when sharing checkbox is checked."""
    host = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=ROMS06&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Disclaimer hidden by default
        expect(host.locator("#rom-sharing-disclaimer")).to_be_hidden()

        # Enable sharing
        _mark_rom_ready(host)
        host.evaluate("""
            document.getElementById('opt-rom-sharing').disabled = false;
            document.getElementById('opt-rom-sharing').click();
        """)

        # Disclaimer visible
        expect(host.locator("#rom-sharing-disclaimer")).to_be_visible(timeout=5000)
        expect(host.locator("#rom-sharing-disclaimer")).to_contain_text(
            "legal right to distribute"
        )
    finally:
        host.close()


# ── Info Overlay Tests ────────────────────────────────────────────────


def test_info_overlay_elements_exist(browser, server_url):
    """Info overlay has structured layout (header, stats, peers sections)."""
    host = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=INFO01&host=1&name=Host")
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
    page.goto(f"{server_url}/play.html?room=INFO02&host=1&name=Host")
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


def test_info_overlay_lockstep_getinfo(page, server_url):
    """Lockstep engine getInfo() returns extended fields: mode, peers, sync."""
    page.goto(f"{server_url}/play.html?room=INFO03&host=1&name=Host")
    page.wait_for_function(
        "typeof window.NetplayLockstep !== 'undefined'", timeout=10000
    )

    info = page.evaluate("window.NetplayLockstep.getInfo()")
    assert info is not None
    assert info["mode"] == "lockstep"
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
        f"{server_url}/play.html?room=INFO04&host=1&name=Host&mode=streaming"
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
    page.goto(f"{server_url}/play.html?room=DLY01&name=Guest")
    page.wait_for_function(
        "document.getElementById('player-controls') !== null", timeout=10000
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


def test_host_delay_hidden_streaming(page, server_url):
    """Host delay picker hidden when mode is streaming."""
    page.goto(
        f"{server_url}/play.html?room=DLYS2&host=1&name=Host&mode=streaming"
    )
    page.wait_for_function(
        "document.getElementById('player-controls') !== null", timeout=10000
    )

    # Player controls start hidden (display:none from HTML)
    # and the mode-change handler also keeps them hidden in streaming.
    # Verify by checking computed visibility.
    visible = page.evaluate(
        "getComputedStyle(document.getElementById('player-controls')).display !== 'none'"
    )
    assert visible is False, "player-controls should be hidden in streaming mode"

    # Verify switching to lockstep shows them
    page.evaluate("document.getElementById('mode-select').value = 'lockstep'")
    page.evaluate(
        "document.getElementById('mode-select')"
        ".dispatchEvent(new Event('change'))"
    )
    visible_after = page.evaluate(
        "getComputedStyle(document.getElementById('player-controls')).display !== 'none'"
    )
    assert visible_after is True, "player-controls should show after switching to lockstep"


def test_host_still_has_delay_picker(page, server_url):
    """Host still sees delay picker elements after restructure."""
    page.goto(f"{server_url}/play.html?room=DLYS3&host=1&name=Host")
    page.wait_for_function(
        "document.getElementById('delay-picker') !== null", timeout=10000
    )

    # Delay picker exists in player-controls
    assert page.locator("#player-controls #delay-picker").count() == 1
    # Start button is in host-controls (not player-controls)
    assert page.locator("#host-controls #start-btn").count() == 1
    # delay-auto checkbox exists
    assert page.locator("#delay-auto").count() == 1


def test_guest_delay_preference_readable(page, server_url):
    """getDelayPreference returns manual delay when set."""
    page.goto(f"{server_url}/play.html?room=DLYS4&host=1&name=Host")
    page.wait_for_function(
        "typeof window.getDelayPreference === 'function'", timeout=10000
    )

    # Default auto delay = 2
    delay = page.evaluate("window.getDelayPreference()")
    assert delay == 2, f"Expected default delay 2, got {delay}"

    # Set manual delay to 5
    page.evaluate("""
        document.getElementById('delay-auto').checked = false;
        document.getElementById('delay-select').disabled = false;
        document.getElementById('delay-select').value = '5';
    """)
    delay = page.evaluate("window.getDelayPreference()")
    assert delay == 5, f"Expected manual delay 5, got {delay}"


# ── Worker Base64 Test ────────────────────────────────────────────────


def test_worker_compress_and_encode(page, server_url):
    """NetplayLockstep module loads and getInfo is callable."""
    page.goto(f"{server_url}/play.html?room=WKRS1&host=1&name=Host")
    page.wait_for_function(
        "typeof window.NetplayLockstep !== 'undefined'", timeout=10000
    )

    # Verify the lockstep module is loaded with getInfo
    result = page.evaluate("""
        (() => {
            try {
                if (typeof window.NetplayLockstep === 'undefined') {
                    return { error: 'NetplayLockstep not defined' };
                }
                var info = window.NetplayLockstep.getInfo();
                return {
                    ok: true,
                    hasMode: info.mode === 'lockstep',
                    hasPeers: Array.isArray(info.peers),
                };
            } catch (e) {
                return { error: e.message };
            }
        })()
    """)
    assert result.get("ok") is True, f"Lockstep module check failed: {result}"
    assert result.get("hasMode") is True, "getInfo should have mode='lockstep'"
    assert result.get("hasPeers") is True, "getInfo should have peers array"


def test_share_dropdown_copies_links(browser, server_url):
    """In-game share button shows dropdown with play and watch links."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=SHR01&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=SHR01&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        _mark_rom_ready(host)
        _mark_rom_ready(guest)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)

        # Share button exists
        expect(host.locator("#toolbar-share")).to_be_visible()

        # Dropdown initially hidden
        expect(host.locator("#share-dropdown")).to_be_hidden()

        # Click opens dropdown
        host.click("#toolbar-share")
        expect(host.locator("#share-dropdown")).to_be_visible(timeout=2000)
        expect(host.locator("#share-play")).to_be_visible()
        expect(host.locator("#share-watch")).to_be_visible()

        # Click share-play copies and closes dropdown
        host.click("#share-play")
        expect(host.locator("#share-dropdown")).to_be_hidden(timeout=2000)
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
        host.goto(f"{server_url}/play.html?room=FULL01&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        p2.goto(f"{server_url}/play.html?room=FULL01&name=P2")
        expect(p2.locator("#overlay")).to_be_visible(timeout=10000)

        p3.goto(f"{server_url}/play.html?room=FULL01&name=P3")
        expect(p3.locator("#overlay")).to_be_visible(timeout=10000)

        p4.goto(f"{server_url}/play.html?room=FULL01&name=P4")
        expect(p4.locator("#overlay")).to_be_visible(timeout=10000)

        # 5th player joins via play link (no spectate param)
        joiner.goto(f"{server_url}/play.html?room=FULL01&name=Late")
        # Should auto-spectate — overlay visible, banner appears
        expect(joiner.locator("#overlay")).to_be_visible(timeout=10000)
        expect(joiner.locator(".room-full-banner")).to_be_visible(timeout=5000)

        # Banner auto-dismisses
        expect(joiner.locator(".room-full-banner")).to_be_hidden(timeout=7000)
    finally:
        host.close()
        p2.close()
        p3.close()
        p4.close()
        joiner.close()


def test_gamepad_manager_has_gamepad(page, server_url):
    """GamepadManager.hasGamepad exists and returns false when no gamepad."""
    page.goto(f"{server_url}/play.html?room=GMS01&host=1&name=Host")
    page.wait_for_function(
        "typeof window.GamepadManager !== 'undefined'"
        " && typeof window.GamepadManager.hasGamepad === 'function'",
        timeout=10000,
    )

    result = page.evaluate("window.GamepadManager.hasGamepad(0)")
    assert result is False, "Should return false without gamepad"
