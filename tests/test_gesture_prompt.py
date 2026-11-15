"""Test the "Tap to start" overlay every player is shown before boot.

Validates that it sits above EmulatorJS, that clicking it dismisses it, and
that the host gets it too.

Run: pytest tests/test_gesture_prompt.py -v -s
"""

from playwright.sync_api import expect




def test_gesture_prompt_visible_for_guest(browser, server_url, rom_path):
    """Guest sees gesture prompt overlay after game starts."""
    host = browser.new_page()
    guest = browser.new_page()

    guest_logs = []
    guest.on("console", lambda msg: guest_logs.append(msg.text))

    try:
        # Host creates room, loads ROM, enables sharing
        host.goto(f"{server_url}/play.html?room=GESTURE1&host=1&name=Host&mode=rollback")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(rom_path)
        host.wait_for_timeout(500)
        # The sharing checkbox is in the host's Advanced options
        host.click("#host-controls .advanced-options > summary")
        host.locator("#opt-rom-sharing").check()
        host.wait_for_timeout(300)

        # Guest joins, accepts ROM sharing
        # ?debug: the guest's console logs, read below, are muted without it.
        guest.goto(f"{server_url}/play.html?room=GESTURE1&name=Guest&debug")
        expect(guest.locator("#rom-sharing-prompt")).to_be_visible(timeout=10000)
        guest.click("#rom-accept-btn")

        # Wait for ROM transfer
        expect(guest.locator("#rom-drop.loaded")).to_be_visible(timeout=30000)

        # Start game
        expect(host.locator("#start-btn")).to_be_enabled(timeout=5000)
        host.click("#start-btn")

        # Guest should see gesture prompt (not hidden, above EJS)
        gesture = guest.locator("#gesture-prompt")
        expect(gesture).to_be_visible(timeout=10000)

        # Verify the prompt has the CSS triangle (not emoji)
        icon = guest.locator(".gesture-prompt-icon")
        expect(icon).to_be_visible()

        # Verify the triangle is rendered via CSS borders (no text content)
        icon_text = icon.text_content()
        assert icon_text.strip() == "", f"Icon should be empty (CSS triangle), got: '{icon_text}'"

        # Verify prompt text
        text = guest.locator(".gesture-prompt-text").text_content()
        assert "Tap to start" in text

        # Take screenshot for visual verification
        guest.screenshot(path="/tmp/gesture-prompt.png")
        print("\nScreenshot saved to /tmp/gesture-prompt.png")

        # Click the gesture prompt
        gesture.click()

        # Prompt should dismiss
        expect(gesture).to_be_hidden(timeout=3000)

        # Confirm gesture was received in logs
        assert any("gesture received" in l for l in guest_logs), \
            "Guest should log 'gesture received'"

    finally:
        host.close()
        guest.close()


def test_host_taps_to_start_too(browser, server_url, rom_path):
    """The host gets the tap-to-start prompt too, and its tap starts the emulator.

    Every player is shown the prompt before boot, the host included, so that the
    AudioContext is made inside the tap: Safari suspends one made outside a
    gesture after about 10 s, which left the host's earlier one stale (see
    showGesturePrompt in netplay-rollback.js). The host used to boot without it.
    """
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=GESTURE2&host=1&name=Host&mode=rollback")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(rom_path)
        host.wait_for_timeout(500)

        guest.goto(f"{server_url}/play.html?room=GESTURE2&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        guest.evaluate("window.__test_socket.emit('rom-ready', { ready: true })")

        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")

        # The host sees the prompt, and tapping it starts the emulator
        prompt = host.locator("#gesture-prompt")
        expect(prompt).to_be_visible(timeout=10000)
        prompt.click()
        expect(prompt).to_be_hidden(timeout=3000)
        host.wait_for_function(
            "window.NetplayRollback.exportSyncLog().includes('gesture received')",
            timeout=5000,
        )

    finally:
        host.close()
        guest.close()
