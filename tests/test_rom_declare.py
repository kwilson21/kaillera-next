"""Verify ROM ownership declaration flow for streaming mode.

Single room test to stay within the open-room rate limit (5/60s).
Tests all declaration behaviors in sequence using one room.

Run: pytest tests/test_rom_declare.py -v
"""

import random
import string
from playwright.sync_api import expect


def _room_code():
    return 'D' + ''.join(random.choices(string.ascii_uppercase + string.digits, k=7))


def _wait_for_socket(page, timeout=10000):
    page.wait_for_function(
        "window._socket && window._socket.connected", timeout=timeout)


def test_rom_declaration_full_flow(browser, server_url):
    """End-to-end ROM declaration test: one room, all behaviors.

    Validates:
    1. Declaration hidden in lockstep (default)
    2. Declaration visible for guest in streaming mode
    3. Host does NOT see declaration
    4. Checking declaration hides ROM drop zone
    5. Start button shows "Waiting for declarations" until guest checks
    6. Checkbox stays checked across mode toggles (page-lifetime cache)
    7. Spectators do NOT see declaration
    8. Spectator claiming a slot sees declaration
    """
    room = _room_code()
    ctx = browser.new_context()

    try:
        host = ctx.new_page()
        guest = ctx.new_page()
        spectator = ctx.new_page()

        # ── Setup: host creates room, guest + spectator join ──
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        _wait_for_socket(host)

        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        _wait_for_socket(guest)

        spectator.goto(f"{server_url}/play.html?room={room}&name=Watcher&spectate=1")
        expect(spectator.locator("#overlay")).to_be_visible(timeout=10000)
        _wait_for_socket(spectator)

        # ── 1. Default lockstep: declaration hidden for everyone ──
        expect(guest.locator("#rom-declare-prompt")).to_be_hidden(timeout=3000)
        expect(host.locator("#rom-declare-prompt")).to_be_hidden()
        expect(spectator.locator("#rom-declare-prompt")).to_be_hidden()

        # ── 2. Host selects streaming: guest sees declaration ──
        host.select_option("#mode-select", "streaming")
        expect(guest.locator("#rom-declare-prompt")).to_be_visible(timeout=5000)
        expect(guest.locator("#rom-declare-cb")).to_be_visible()

        # ── 3. Host does NOT see declaration ──
        expect(host.locator("#rom-declare-prompt")).to_be_hidden(timeout=3000)

        # ── 7. Spectator does NOT see declaration ──
        expect(spectator.locator("#rom-declare-prompt")).to_be_hidden(timeout=3000)

        # ── 4. ROM drop visible before check, hidden after ──
        expect(guest.locator("#rom-drop")).to_be_visible()
        guest.locator("#rom-declare-cb").check()
        expect(guest.locator("#rom-drop")).to_be_hidden(timeout=3000)

        # ── 5. Start button: waits for declarations, then enables ──
        # Uncheck to test the waiting state
        guest.locator("#rom-declare-cb").uncheck()
        expect(host.locator("#start-btn")).to_contain_text("Waiting for declarations", timeout=5000)
        expect(host.locator("#start-btn")).to_be_disabled()

        guest.locator("#rom-declare-cb").check()
        expect(host.locator("#start-btn")).to_be_enabled(timeout=5000)
        expect(host.locator("#start-btn")).to_contain_text("Start Game")

        # ── 6. Mode toggle: checkbox stays checked (page-lifetime cache) ──
        host.select_option("#mode-select", "lockstep")
        expect(guest.locator("#rom-declare-prompt")).to_be_hidden(timeout=5000)

        host.select_option("#mode-select", "streaming")
        expect(guest.locator("#rom-declare-prompt")).to_be_visible(timeout=5000)
        expect(guest.locator("#rom-declare-cb")).to_be_checked()

        # ── 8. Spectator claims slot: declaration appears ──
        spectator.evaluate("window._socket.emit('claim-slot', { slot: 2 })")
        expect(spectator.locator("#rom-declare-prompt")).to_be_visible(timeout=5000)

    finally:
        for page in ctx.pages:
            try:
                page.evaluate("window._socket && window._socket.disconnect()")
            except Exception:
                pass
        try:
            ctx.pages[0].wait_for_timeout(300)
        except Exception:
            pass
        ctx.close()
