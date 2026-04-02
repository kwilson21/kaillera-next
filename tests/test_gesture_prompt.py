"""Test gesture prompt overlay for guests.

Validates that non-host players see a clean "Tap to start" overlay
that sits above EmulatorJS, and that clicking it dismisses the overlay.

Run: pytest tests/test_gesture_prompt.py -v -s
"""

from playwright.sync_api import expect


ROM_PATH = "/Users/kazon/Downloads/Super Smash Bros. (USA)/Super Smash Bros. (USA).z64"


def test_gesture_prompt_visible_for_guest(browser, server_url):
    """Guest sees gesture prompt overlay after game starts."""
    host = browser.new_page()
    guest = browser.new_page()

    guest_logs = []
    guest.on("console", lambda msg: guest_logs.append(msg.text))

    try:
        # Host creates room, loads ROM, enables sharing
        host.goto(f"{server_url}/play.html?room=GESTURE1&host=1&name=Host&mode=lockstep")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(ROM_PATH)
        host.wait_for_timeout(500)
        host.locator("#opt-rom-sharing").check()
        host.wait_for_timeout(300)

        # Guest joins, accepts ROM sharing
        guest.goto(f"{server_url}/play.html?room=GESTURE1&name=Guest")
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


def test_host_does_not_see_gesture_prompt(browser, server_url):
    """Host should auto-boot without gesture prompt."""
    host = browser.new_page()
    guest = browser.new_page()

    host_logs = []
    host.on("console", lambda msg: host_logs.append(msg.text))

    try:
        host.goto(f"{server_url}/play.html?room=GESTURE2&host=1&name=Host&mode=lockstep")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(ROM_PATH)
        host.wait_for_timeout(500)

        guest.goto(f"{server_url}/play.html?room=GESTURE2&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        guest.evaluate("window.__test_socket.emit('rom-ready', { ready: true })")

        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")

        # Host should NOT see gesture prompt
        host.wait_for_timeout(2000)
        expect(host.locator("#gesture-prompt")).to_be_hidden()

        # Host should auto-boot
        assert any("host auto-boot" in l for l in host_logs), \
            "Host should log 'host auto-boot'"

    finally:
        host.close()
        guest.close()
