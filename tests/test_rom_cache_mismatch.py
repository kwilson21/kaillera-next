"""Test that cached ROMs from previous games don't load when they don't match the host's ROM.

Scenario:
  1. Guest loads ROM-A in a solo room, caching it in IndexedDB
  2. Host creates a new room and loads ROM-B
  3. Guest joins the host's room
  4. Guest's cached ROM-A should be cleared (hash mismatch)
  5. Guest's drop zone should show the default "drop to load" state

Run: pytest tests/test_rom_cache_mismatch.py -v -s
"""

import os
import tempfile

from playwright.sync_api import expect


def _make_fake_rom(content_byte: int, size: int = 4096) -> str:
    """Create a temporary .z64 file filled with a given byte value."""
    fd, path = tempfile.mkstemp(suffix=".z64")
    os.write(fd, bytes([content_byte]) * size)
    os.close(fd)
    return path


def test_cached_rom_cleared_on_host_mismatch(browser, server_url):
    """A guest's cached ROM from a previous game is cleared when joining
    a host whose ROM has a different hash."""
    rom_a = _make_fake_rom(0xAA)
    rom_b = _make_fake_rom(0xBB)

    import random, string
    tag = ''.join(random.choices(string.ascii_uppercase, k=4))

    # Separate contexts so each has its own IndexedDB / localStorage
    host_ctx = browser.new_context(ignore_https_errors=True)
    guest_ctx = browser.new_context(ignore_https_errors=True)
    host = host_ctx.new_page()
    guest = guest_ctx.new_page()

    guest_logs = []
    guest.on("console", lambda msg: guest_logs.append(msg.text))

    try:
        # ── Step 1: Guest caches ROM-A by loading it in a solo room ──
        guest.goto(f"{server_url}/play.html?room=C1{tag}&host=1&name=Guest")
        guest.wait_for_selector("#player-list", timeout=10000)
        guest.locator("#rom-drop input[type='file']").set_input_files(rom_a)
        guest.wait_for_timeout(1000)
        assert guest.evaluate(
            "document.getElementById('rom-drop').classList.contains('loaded')"
        ), "ROM-A should be loaded in guest's solo room"

        # Verify ROM is cached in IndexedDB
        cached_hash_a = guest.evaluate("window.KNState?.romHash || null")
        print(f"Guest cached ROM-A hash: {cached_hash_a}")
        assert cached_hash_a, "ROM-A hash should be computed"

        # ── Step 2: Host creates a different room with ROM-B ──
        host.goto(f"{server_url}/play.html?room=C2{tag}&host=1&name=Host")
        host.wait_for_selector("#player-list", timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(rom_b)
        host.wait_for_timeout(1000)
        assert host.evaluate(
            "document.getElementById('rom-drop').classList.contains('loaded')"
        ), "ROM-B should be loaded for host"

        host_hash = host.evaluate("window.KNState?.romHash || null")
        print(f"Host ROM-B hash: {host_hash}")
        assert host_hash, "Host ROM-B hash should be computed"
        assert host_hash != cached_hash_a, "ROM-A and ROM-B hashes should differ"

        # ── Step 3: Guest joins host's room (navigates away from solo room) ──
        guest.goto(f"{server_url}/play.html?room=C2{tag}&name=Guest")
        guest.wait_for_selector("#player-list", timeout=10000)

        # Wait for the users-updated event to propagate the host's ROM hash
        guest.wait_for_timeout(2000)

        # ── Step 4: Verify guest's cached ROM was cleared ──
        rom_drop_loaded = guest.evaluate(
            "document.getElementById('rom-drop').classList.contains('loaded')"
        )
        print(f"Guest rom-drop has 'loaded' class: {rom_drop_loaded}")
        assert not rom_drop_loaded, "Guest's ROM drop zone should NOT show 'loaded' after mismatch"

        guest_rom_hash = guest.evaluate("window.KNState?.romHash || null")
        print(f"Guest ROM hash after joining: {guest_rom_hash}")
        assert not guest_rom_hash, "Guest's ROM hash should be cleared"

        ejs_game_url = guest.evaluate("window.EJS_gameUrl || null")
        print(f"Guest EJS_gameUrl after joining: {ejs_game_url}")
        assert not ejs_game_url, "Guest's EJS_gameUrl should be cleared"

        # Verify the mismatch was logged
        mismatch_logged = any("mismatch" in log and "clearing" in log for log in guest_logs)
        print(f"Mismatch clearing logged: {mismatch_logged}")
        assert mismatch_logged, "Expected a console log about clearing mismatched cached ROM"

        # ── Step 5: Verify guest can still load ROM-B manually ──
        guest.locator("#rom-drop input[type='file']").set_input_files(rom_b)
        guest.wait_for_timeout(1000)
        assert guest.evaluate(
            "document.getElementById('rom-drop').classList.contains('loaded')"
        ), "Guest should be able to load ROM-B manually"

        guest_hash_after = guest.evaluate("window.KNState?.romHash || null")
        print(f"Guest ROM hash after loading ROM-B: {guest_hash_after}")
        assert guest_hash_after == host_hash, "Guest's hash should now match the host's"

        # Start button should be enabled (both players have matching ROMs)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)

    finally:
        guest.close()
        host.close()
        guest_ctx.close()
        host_ctx.close()
        os.unlink(rom_a)
        os.unlink(rom_b)


def test_cached_rom_kept_when_hash_matches(browser, server_url):
    """A guest's cached ROM is kept when it matches the host's ROM hash."""
    rom = _make_fake_rom(0xCC)

    import random, string
    tag = ''.join(random.choices(string.ascii_uppercase, k=4))

    # Separate contexts so each has its own IndexedDB / localStorage
    host_ctx = browser.new_context(ignore_https_errors=True)
    guest_ctx = browser.new_context(ignore_https_errors=True)
    host = host_ctx.new_page()
    guest = guest_ctx.new_page()

    try:
        # ── Step 1: Guest caches the ROM in a solo room ──
        guest.goto(f"{server_url}/play.html?room=M1{tag}&host=1&name=Guest")
        guest.wait_for_selector("#player-list", timeout=10000)
        guest.locator("#rom-drop input[type='file']").set_input_files(rom)
        guest.wait_for_timeout(1000)
        assert guest.evaluate(
            "document.getElementById('rom-drop').classList.contains('loaded')"
        )

        # ── Step 2: Host creates room with the same ROM ──
        host.goto(f"{server_url}/play.html?room=M2{tag}&host=1&name=Host")
        host.wait_for_selector("#player-list", timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(rom)
        host.wait_for_timeout(1000)
        assert host.evaluate(
            "document.getElementById('rom-drop').classList.contains('loaded')"
        )

        # ── Step 3: Guest joins host's room ──
        guest.goto(f"{server_url}/play.html?room=M2{tag}&name=Guest")
        guest.wait_for_selector("#player-list", timeout=10000)
        guest.wait_for_timeout(2000)

        # ── Step 4: Guest's cached ROM should still be loaded (hashes match) ──
        rom_drop_loaded = guest.evaluate(
            "document.getElementById('rom-drop').classList.contains('loaded')"
        )
        print(f"Guest rom-drop has 'loaded' class: {rom_drop_loaded}")
        assert rom_drop_loaded, "Guest's cached ROM should remain loaded when hash matches"

        guest_rom_hash = guest.evaluate("window.KNState?.romHash || null")
        assert guest_rom_hash, "Guest's ROM hash should still be set"

        # Start button should be enabled
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)

    finally:
        host.close()
        guest.close()
        host_ctx.close()
        guest_ctx.close()
        os.unlink(rom)
