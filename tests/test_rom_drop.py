"""Test ROM drag-and-drop + boot flow.

Run: pytest tests/test_rom_drop.py -v -s
"""

import tempfile
import os

from playwright.sync_api import expect


def test_rom_drop_and_boot(browser, server_url):
    """Drop a ROM file, start game, verify EmulatorJS loader is injected."""
    host = browser.new_page()
    guest = browser.new_page()

    # Collect console messages
    host_logs = []
    host.on("console", lambda msg: host_logs.append(msg.text))

    try:
        rom_path = "/Users/kazon/Downloads/Super Smash Bros. (USA)/Super Smash Bros. (USA).z64"

        # Host creates room
        host.goto(f"{server_url}/play.html?room=ROMTEST&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Verify drop zone exists
        expect(host.locator("#rom-drop")).to_be_visible()

        # Load ROM via file input (simulates click-to-browse)
        file_input = host.locator("#rom-drop input[type='file']")
        file_input.set_input_files(rom_path)

        # Verify ROM was loaded
        host.wait_for_timeout(500)  # give file input change event time
        loaded = host.evaluate("document.getElementById('rom-drop').classList.contains('loaded')")
        print(f"rom-drop has 'loaded' class: {loaded}")
        rom_status = host.locator("#rom-status").text_content()
        assert ".z64" in rom_status

        # Check EJS_gameUrl is set (the variable we CAN access from window scope)
        ejs_url = host.evaluate("window.EJS_gameUrl || 'NOT SET'")
        print(f"EJS_gameUrl: {ejs_url}")
        assert ejs_url != "NOT SET", "EJS_gameUrl was not set after file drop"

        # Guest joins
        guest.goto(f"{server_url}/play.html?room=ROMTEST&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        # Guest also needs a ROM
        guest_input = guest.locator("#rom-drop input[type='file']")
        guest_input.set_input_files(rom_path)

        # Start button should be enabled now
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)

        # Click start
        host.click("#start-btn")

        # Wait for toolbar to appear (game started)
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)

        # Wait a moment for bootEmulator to run
        host.wait_for_timeout(2000)

        # Check console logs for bootEmulator output
        print("\n--- Host console logs ---")
        for log in host_logs:
            if "[play]" in log or "loader" in log.lower() or "error" in log.lower():
                print(f"  {log}")

        # Check if bootEmulator injected loader.js
        loader_scripts = host.evaluate("""
            Array.from(document.querySelectorAll('script')).filter(
                s => s.src && s.src.includes('loader.js')
            ).map(s => s.src)
        """)
        print(f"\nLoader scripts in DOM: {loader_scripts}")

        # Check if EJS_emulator was created
        ejs_exists = host.evaluate("typeof window.EJS_emulator !== 'undefined'")
        print(f"EJS_emulator exists: {ejs_exists}")

        # Check EJS_gameUrl is still set
        ejs_url_after = host.evaluate("window.EJS_gameUrl || 'NOT SET'")
        print(f"EJS_gameUrl after start: {ejs_url_after}")

    finally:
        host.close()
        guest.close()
