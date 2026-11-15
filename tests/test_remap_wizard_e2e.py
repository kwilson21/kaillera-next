"""The control remap wizard on the real play page.

play.js polls the pads, listens for keys and shows the prompts; what each
input does is web/src/play/remap-wizard.ts (whether a step takes it is
remap-step.ts, proved). tests/ts/play-remap-wizard.test.ts holds those rules
to the wizard play.js had before, over every kind of input; this checks the
page carries them out.

With the keyboard: keys pressed end up in the saved mapping, Back undoes one,
Skip leaves one alone, Escape saves nothing.

With a gamepad (a harness step: the page is given a pad the test presses
through `Navigator.prototype.getGamepads`, read before any page script): a
button, a stick and both kinds of C button are captured and saved, and a
stick direction pushed on the wrong axis is refused. Back after that refusal
returns to the step before with nothing of it kept, so the stick can be
moved to the other axis. The old wizard kept a snapshot of the refused push,
so Back left the step's own direction captured and the other axis was
refused again.

Run: pytest tests/test_remap_wizard_e2e.py -v   (needs the server running)
"""

import json

from playwright.sync_api import expect

STEPS = 18
DEBOUNCE_MS = 200  # play.js ignores input for 150 ms after each step


def _open(browser, server_url, room, init_script=None):
    page = browser.new_page()
    if init_script:
        page.add_init_script(init_script)
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


# A standard-mapping pad the test holds buttons and sticks on. api-sandbox.js
# keeps Navigator.prototype.getGamepads as the page loads, so it is replaced
# before any page script runs.
_FAKE_PAD = """
    window.__pad = {
        id: 'KN Test Pad (STANDARD GAMEPAD)',
        index: 0,
        connected: true,
        mapping: 'standard',
        timestamp: 0,
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
        axes: [0, 0, 0, 0, 0, 0],
    };
    Navigator.prototype.getGamepads = function () {
        return [window.__pad, null, null, null];
    };
"""
PAD_ID = "KN Test Pad (STANDARD GAMEPAD)"
HOLD_MS = 120  # the wizard polls every 16 ms


def _button(page, index):
    page.evaluate(f"window.__pad.buttons[{index}].pressed = true")
    page.wait_for_timeout(HOLD_MS)
    page.evaluate(f"window.__pad.buttons[{index}].pressed = false")
    page.wait_for_timeout(DEBOUNCE_MS)


def _stick(page, axis, value):
    page.evaluate(f"window.__pad.axes[{axis}] = {value}")
    page.wait_for_timeout(HOLD_MS)
    page.evaluate(f"window.__pad.axes[{axis}] = 0")
    page.wait_for_timeout(DEBOUNCE_MS)


def _skip(page, times):
    for _ in range(times):
        page.locator("#ingame-remap-skip").click()
        page.wait_for_timeout(DEBOUNCE_MS)


def test_a_gamepad_is_captured_and_a_refused_stick_can_be_moved(browser, server_url, room):
    page = _open(browser, server_url, room, _FAKE_PAD)
    try:
        page.wait_for_function("window.GamepadManager.getDetected().length === 1", timeout=5000)
        page.evaluate("window._startIngameRemap()")
        prompt = page.locator("#ingame-remap-prompt")
        expect(prompt).to_have_text("Press: A (gamepad or key)")

        _button(page, 7)  # A on button 7
        expect(prompt).to_have_text("Press: B (gamepad or key)")
        _skip(page, 9)  # B to D-Right
        expect(prompt).to_have_text("Push stick UP (gamepad or key)")

        _stick(page, 1, -1)  # UP on axis 1
        expect(prompt).to_have_text("Push stick DOWN (gamepad or key)")
        _stick(page, 4, 1)  # DOWN on axis 4: not the stick UP is on
        expect(prompt).to_have_text("Must use same stick as UP — try again")

        # Back to UP, to put the stick on axis 4 instead.
        page.locator("#ingame-remap-back").click()
        page.wait_for_timeout(DEBOUNCE_MS)
        expect(prompt).to_have_text("Push stick UP (gamepad or key)")
        _stick(page, 4, -1)  # UP on axis 4: taken (the old wizard refused it)
        expect(prompt).to_have_text("Push stick DOWN (gamepad or key)")
        _stick(page, 4, 1)  # DOWN on axis 4
        expect(prompt).to_have_text("Push stick LEFT (gamepad or key)")
        _skip(page, 2)  # LEFT, RIGHT: the X stick stays as it was

        expect(prompt).to_have_text("Press: C-Up (gamepad or key)")
        _stick(page, 2, 1)  # C-Up on the right stick's X axis, pushed right
        _button(page, 3)  # C-Down on button 3
        expect(prompt).to_have_text("Press: C-Left (gamepad or key)")
        _skip(page, 2)

        expect(page.locator("#ingame-remap")).to_be_hidden()
        saved = json.loads(page.evaluate(f"localStorage.getItem('gamepad-profile:{PAD_ID}')"))
        assert saved["buttons"]["7"] == 1 << 0  # A
        assert saved["buttons"]["3"] == 1 << 22  # C-Down
        assert saved["axes"]["stickY"] == {"index": 4, "bits": [18, 19]}  # DOWN on +, UP on -
        assert saved["axes"]["stickX"] == {"index": 0, "bits": [16, 17]}  # skipped: as it was
        assert saved["axisButtons"]["2"]["pos"] == (1 << 21) | (1 << 23)  # C-Right as it was, and C-Up
    finally:
        page.close()


def test_a_gamepad_takes_every_step_and_the_profile_is_saved_whole(browser, server_url, room):
    """All 18 steps captured from the pad, none skipped, with Back across the X stick's pair."""
    page = _open(browser, server_url, room, _FAKE_PAD)
    try:
        page.wait_for_function("window.GamepadManager.getDetected().length === 1", timeout=5000)
        page.evaluate("window._startIngameRemap()")
        prompt = page.locator("#ingame-remap-prompt")
        expect(prompt).to_have_text("Press: A (gamepad or key)")

        # The ten button steps, A to D-Right, on pad buttons 0 to 9.
        for button in range(10):
            _button(page, button)
        expect(prompt).to_have_text("Push stick UP (gamepad or key)")

        # The stick: up and down on axis 1, left on axis 0.
        _stick(page, 1, -1)
        _stick(page, 1, 1)
        _stick(page, 0, -1)
        expect(prompt).to_have_text("Push stick RIGHT (gamepad or key)")

        # Right on another axis than left: refused, and the step stays.
        _stick(page, 2, 1)
        expect(prompt).to_have_text("Must use same stick as LEFT — try again")
        expect(prompt).to_have_text("Push stick RIGHT (gamepad or key)", timeout=3000)

        # Back returns to LEFT with LEFT not taken, so LEFT can move to axis 2.
        page.locator("#ingame-remap-back").click()
        page.wait_for_timeout(DEBOUNCE_MS)
        expect(prompt).to_have_text("Push stick LEFT (gamepad or key)")
        _stick(page, 2, -1)
        expect(prompt).to_have_text("Push stick RIGHT (gamepad or key)")
        _stick(page, 2, 1)

        # The C buttons on the second stick, axes 3 and 4.
        expect(prompt).to_have_text("Press: C-Up (gamepad or key)")
        _stick(page, 4, -1)
        _stick(page, 4, 1)
        _stick(page, 3, -1)
        _stick(page, 3, 1)

        expect(page.locator("#ingame-remap")).to_be_hidden()
        saved = json.loads(page.evaluate(f"localStorage.getItem('gamepad-profile:{PAD_ID}')"))
        assert saved["name"] == "Custom"
        assert saved["buttons"]["0"] == 1 << 0  # A
        assert saved["buttons"]["3"] == 1 << 12  # Z
        assert saved["buttons"]["9"] == 1 << 7  # D-Right
        assert saved["axes"]["stickY"] == {"index": 1, "bits": [18, 19]}  # down, up
        assert saved["axes"]["stickX"] == {"index": 2, "bits": [16, 17]}  # right, left
        # A C button is added to what the pad's default profile already gives that axis.
        assert saved["axisButtons"]["4"]["pos"] & (1 << 22)  # C-Down
        assert saved["axisButtons"]["4"]["neg"] & (1 << 23)  # C-Up
        assert saved["axisButtons"]["3"]["pos"] & (1 << 21)  # C-Right
        assert saved["axisButtons"]["3"]["neg"] & (1 << 20)  # C-Left
    finally:
        page.close()
