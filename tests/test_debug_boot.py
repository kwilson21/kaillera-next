"""Test EmulatorJS boot flow: ROM drop → start game → emulator loads and runs."""

import os
from playwright.sync_api import expect

ROM_PATH = "/Users/kazon/Downloads/Super Smash Bros. (USA)/Super Smash Bros. (USA).z64"


def test_ejs_boot_full(browser, server_url):
    """Drop ROM, start game, confirm emulator boots with gameManager."""
    host = browser.new_page()
    guest = browser.new_page()

    errors = []
    host.on("pageerror", lambda err: errors.append(str(err)))
    csp_errors = []
    host.on("console", lambda msg: csp_errors.append(msg.text) if "Content Security Policy" in msg.text else None)

    try:
        host.goto(f"{server_url}/play.html?room=BOOTTEST&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        host.locator("#rom-drop input[type='file']").set_input_files(ROM_PATH)
        host.wait_for_timeout(500)

        guest.goto(f"{server_url}/play.html?room=BOOTTEST&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        guest.locator("#rom-drop input[type='file']").set_input_files(ROM_PATH)
        guest.wait_for_timeout(500)

        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)

        # Wait for EmulatorJS to fully load (core decompression + game boot)
        # Poll for gameManager to exist (means emulator is running)
        for i in range(60):  # up to 60 seconds
            has_gm = host.evaluate("!!(window.EJS_emulator && window.EJS_emulator.gameManager)")
            if has_gm:
                print(f"\ngameManager ready after ~{i}s")
                break
            host.wait_for_timeout(1000)
        else:
            # Gather diagnostics on failure
            print("\nFAILED: gameManager never appeared after 60s")
            print(f"CSP errors: {csp_errors}")
            print(f"EJS_emulator exists: {host.evaluate('!!window.EJS_emulator')}")
            print(f"EJS start button: {host.evaluate('!!document.querySelector(\".ejs_start_button\")')}")
            canvases = host.evaluate("document.querySelectorAll('canvas').length")
            print(f"Canvas count: {canvases}")
            assert False, "EmulatorJS gameManager never loaded"

        # Verify no CSP errors
        assert len(csp_errors) == 0, f"CSP blocked resources: {csp_errors}"

        # Verify canvas exists (game is rendering)
        canvas_count = host.evaluate("document.querySelectorAll('canvas').length")
        print(f"Canvas count: {canvas_count}")
        assert canvas_count > 0, "No canvas elements found"

        # Verify game has run some frames
        frames = host.evaluate("""
            (function() {
                var gm = window.EJS_emulator.gameManager;
                if (gm && gm.Module && gm.Module._get_current_frame_count) {
                    return gm.Module._get_current_frame_count();
                }
                return -1;
            })()
        """)
        print(f"Frame count: {frames}")
        assert frames > 0, "Emulator has not run any frames"

        print("\nSUCCESS: EmulatorJS booted, game running")

    finally:
        host.close()
        guest.close()
