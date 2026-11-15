"""Test the "Tap to start" overlay every player is shown before boot.

Validates that it sits above EmulatorJS, that clicking it dismisses it, and
that the host gets it too.

Run: pytest tests/test_gesture_prompt.py -v -s
"""

from playwright.sync_api import expect


def test_gesture_prompt_visible_for_guest(browser, server_url, rom_path, room):
    """Guest sees gesture prompt overlay after game starts."""
    host = browser.new_page()
    guest = browser.new_page()

    guest_logs = []
    guest.on("console", lambda msg: guest_logs.append(msg.text))

    try:
        # Host creates room, loads ROM, enables sharing
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(rom_path)
        host.wait_for_timeout(500)
        # The sharing checkbox is in the host's Advanced options
        host.click("#host-controls .advanced-options > summary")
        host.locator("#opt-rom-sharing").check()
        host.wait_for_timeout(300)

        # Guest joins, accepts ROM sharing
        # ?debug: the guest's console logs, read below, are muted without it.
        guest.goto(f"{server_url}/play.html?room={room}&name=Guest&debug")
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
        assert any("gesture received" in line for line in guest_logs), "Guest should log 'gesture received'"

    finally:
        host.close()
        guest.close()


def test_host_taps_to_start_too(browser, server_url, rom_path, room):
    """The host gets the tap-to-start prompt too, and its tap starts the emulator.

    Every player is shown the prompt before boot, the host included, so that the
    AudioContext is made inside the tap: Safari suspends one made outside a
    gesture after about 10 s, which left the host's earlier one stale (see
    showGesturePrompt in netplay-rollback.js). The host used to boot without it.
    """
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(rom_path)
        host.wait_for_timeout(500)

        # The guest loads the ROM too, so it plays: with no ROM it takes the ROM
        # prompt at the start (gameStartPlan's askForRom) and the host starts
        # without it, which is what the next test is for.
        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        guest.locator("#rom-drop input[type='file']").set_input_files(rom_path)

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


def _frame(page):
    return page.evaluate("window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? 0")


def test_a_guest_at_the_rom_prompt_joins_late_once_it_drops_one(browser, server_url, rom_path, room):
    """A guest with no ROM at the start does not hold the host's start, and joins late.

    The server counts the guest ready though its page has no ROM (a harness
    step: a start taken while its "no ROM" was on its way, as #260 found). The
    guest takes the ROM prompt and says it has none; the host, whose ROM is not
    shared, starts without it and plays (specs/start_group.qnt). The guest
    drops the ROM and joins the running match late. Before, the host waited
    for the guest's connection, gave up after three retries and never started.
    """
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(rom_path)
        host.wait_for_timeout(500)

        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        guest.evaluate("window.__test_socket.emit('rom-ready', { ready: true })")

        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")

        # The guest asks for a ROM; the host starts alone, before its first
        # startup retry (8 s), and plays.
        expect(guest.locator("#late-join-msg")).to_be_visible(timeout=10000)
        prompt = host.locator("#gesture-prompt")
        expect(prompt).to_be_visible(timeout=6000)
        prompt.click()
        host.wait_for_function("(window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? 0) > 60", timeout=60000)
        log = host.evaluate("window.NetplayRollback.exportSyncLog()")
        assert "reason=it is at the ROM prompt" in log, log[-3000:]

        # The guest drops the ROM and joins the running match.
        guest.locator("#rom-drop input[type='file']").set_input_files(rom_path)
        expect(guest.locator("#late-join-msg")).to_have_count(0, timeout=30000)
        joined_at = _frame(host)
        guest.wait_for_function(
            f"(window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? 0) > {joined_at}",
            timeout=90000,
        )
        # Both keep playing.
        host_then, guest_then = _frame(host), _frame(guest)
        host.wait_for_timeout(3000)
        assert _frame(host) > host_then
        assert _frame(guest) > guest_then

    finally:
        host.close()
        guest.close()
