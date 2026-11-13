"""The control remap wizard on the real play page, driven by the keyboard.

Its rules are web/src/play/remap-wizard.ts (unit-tested in
tests/ts/play-remap-wizard.test.ts); play.js keeps the key listener, the
debounce, the prompts and the saving. This checks the two together: keys
pressed on the page end up in the saved mapping, Back undoes one, Skip leaves
one alone, and Escape saves nothing.

No gamepad is connected in these runs, so the gamepad half is not covered here.

Run: pytest tests/test_remap_wizard_e2e.py -v   (needs the server running)
"""

import json

from playwright.sync_api import expect

STEPS = 18
DEBOUNCE_MS = 200  # play.js ignores input for 150 ms after each step


def _open(browser, server_url, room):
    page = browser.new_page()
    page.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
    expect(page.locator("#overlay")).to_be_visible(timeout=10000)
    page.wait_for_function("typeof window._startIngameRemap === 'function'", timeout=10000)
    return page


def _press(page, key):
    page.keyboard.press(key)
    page.wait_for_timeout(DEBOUNCE_MS)


def _saved(page):
    raw = page.evaluate("localStorage.getItem('keyboard-mapping')")
    return None if raw is None else json.loads(raw)


def test_keys_back_and_skip_reach_the_saved_mapping(browser, server_url, room):
    page = _open(browser, server_url, room)
    try:
        page.evaluate("window._startIngameRemap()")
        prompt = page.locator("#ingame-remap-prompt")
        progress = page.locator("#ingame-remap-progress")
        back = page.locator("#ingame-remap-back")
        expect(page.locator("#ingame-remap")).to_be_visible()
        expect(prompt).to_have_text("Press: A (gamepad or key)")
        expect(progress).to_have_text("(1/18)")
        expect(back).to_be_disabled()
        assert page.evaluate("window.KNState.remapActive") is True

        _press(page, "q")  # A = Q (81)
        expect(prompt).to_have_text("Press: B (gamepad or key)")
        expect(back).to_be_enabled()

        _press(page, "e")  # B = E (69) ... then think better of it
        expect(progress).to_have_text("(3/18)")
        back.click()
        page.wait_for_timeout(DEBOUNCE_MS)
        expect(prompt).to_have_text("Press: B (gamepad or key)")
        _press(page, "r")  # B = R (82)

        page.locator("#ingame-remap-skip").click()  # Start: left alone
        page.wait_for_timeout(DEBOUNCE_MS)
        expect(prompt).to_have_text("Press: Z (gamepad or key)")

        for _ in range(STEPS - 3):
            page.locator("#ingame-remap-skip").click()
            page.wait_for_timeout(DEBOUNCE_MS)

        expect(page.locator("#ingame-remap")).to_be_hidden()
        assert page.evaluate("window.KNState.remapActive") is False
        saved = _saved(page)
        assert saved["81"] == 0  # Q drives A
        assert saved["82"] == 1  # R drives B
        assert "69" not in saved  # the E that Back undid
        assert saved["86"] == 3  # Start still on its default key, V
        assert saved["67"] == 0  # the default key for A is still bound too
    finally:
        page.close()


def test_escape_cancels_without_saving(browser, server_url, room):
    page = _open(browser, server_url, room)
    try:
        page.evaluate("window._startIngameRemap()")
        expect(page.locator("#ingame-remap")).to_be_visible()
        _press(page, "q")
        page.keyboard.press("Escape")
        expect(page.locator("#ingame-remap")).to_be_hidden()
        assert _saved(page) is None
        assert page.evaluate("window.KNState.remapActive") is False

        # A second run starts from the first step again.
        page.evaluate("window._startIngameRemap()")
        expect(page.locator("#ingame-remap-progress")).to_have_text("(1/18)")
        expect(page.locator("#ingame-remap-back")).to_be_disabled()
    finally:
        page.close()
