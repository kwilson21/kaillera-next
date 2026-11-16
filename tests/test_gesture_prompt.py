"""Test the "Tap to start" overlay every player is shown before boot.

Validates that it sits above EmulatorJS, that clicking it dismisses it, and
that the host gets it too. A guest at the ROM prompt, or one whose player
never taps, does not hold the host's start: it joins late.

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

        # The guest drops the ROM; its engine starts as a late joiner, and its
        # emulator boots on its tap, as every player's does.
        guest.locator("#rom-drop input[type='file']").set_input_files(rom_path)
        expect(guest.locator("#late-join-msg")).to_have_count(0, timeout=30000)
        guest_prompt = guest.locator("#gesture-prompt")
        expect(guest_prompt).to_be_visible(timeout=60000)
        guest_prompt.click()
        # It joins the running match. A late joiner boots cold and then waits
        # for its state: in the cloud container that took 158-176 s in
        # lifecycle-e2e's late-join runs.
        joined_at = _frame(host)
        guest.wait_for_function(
            f"(window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? 0) > {joined_at}",
            timeout=240000,
        )
        # Both keep playing.
        host_then, guest_then = _frame(host), _frame(guest)
        host.wait_for_timeout(3000)
        assert _frame(host) > host_then
        assert _frame(guest) > guest_then

    finally:
        host.close()
        guest.close()


# Record whether each engine start on the page is a late join.
_RECORD_ENGINE_STARTS = """() => {
    window.__engineStarts = [];
    const engine = window.NetplayRollback;
    const init = engine.init.bind(engine);
    engine.init = (config) => {
        window.__engineStarts.push(!!config.lateJoin);
        return init(config);
    };
}"""


def test_a_guest_that_never_loads_does_not_hold_the_hosts_start_and_joins_late(browser, server_url, rom_path, room):
    """A guest that answers the start but never loads is left out at the host's load deadline, and joins late.

    The guest's page connects to the host, but its player does not tap "Tap
    to start", so its emulator never loads (as a core that crashed, or a tab
    frozen after it connected). Before, the host waited at "Waiting for Guest
    to load" for ever. The host's load deadline (60 s from when its own
    emulator has loaded) leaves the guest out and tells it; the host plays,
    and the guest's page starts again as a late joiner, which joins the
    running match once its player taps (specs/start_group.qnt, loadDeadline).
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
        guest.locator("#rom-drop input[type='file']").set_input_files(rom_path)
        guest.wait_for_function("!!window.NetplayRollback", timeout=10000)
        guest.evaluate(_RECORD_ENGINE_STARTS)

        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")

        # The host taps and loads; the guest's channel opens (it answered),
        # and its prompt waits untapped.
        prompt = host.locator("#gesture-prompt")
        expect(prompt).to_be_visible(timeout=15000)
        prompt.click()
        expect(guest.locator("#gesture-prompt")).to_be_visible(timeout=15000)

        # At the load deadline the host leaves the guest out and plays.
        host.wait_for_function(
            "(window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? 0) > 60",
            timeout=180000,
        )
        log = host.evaluate("window.NetplayRollback.exportSyncLog()")
        assert "START-LOAD-DEADLINE" in log, log[-3000:]
        assert "reason=it did not load in time" in log, log[-3000:]

        # The guest heard it and started again as a late joiner.
        guest.wait_for_function("window.__engineStarts.length >= 2", timeout=30000)
        assert guest.evaluate("window.__engineStarts") == [False, True]

        # Its player taps, and it joins the running match.
        guest_prompt = guest.locator("#gesture-prompt")
        expect(guest_prompt).to_be_visible(timeout=30000)
        guest_prompt.click()
        joined_at = _frame(host)
        # A late joiner boots cold and then waits for its state: in the cloud
        # container that took 158-176 s in lifecycle-e2e's late-join runs.
        guest.wait_for_function(
            f"(window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? 0) > {joined_at}",
            timeout=240000,
        )
        # Both keep playing.
        host_then, guest_then = _frame(host), _frame(guest)
        host.wait_for_timeout(3000)
        assert _frame(host) > host_then
        assert _frame(guest) > guest_then

    finally:
        host.close()
        guest.close()


# Drop the host's starting state on its way to this page, as a relay that
# stalls would: the page's handler for `data-message` never sees a
# `save-state` while `window.__dropStates` is set. The late join's state is
# another message, and gets through.
_DROP_THE_HOSTS_STATE = """() => {
    const socket = window.__test_socket;
    const emitEvent = socket.emitEvent.bind(socket);
    window.__droppedStates = 0;
    window.__dropStates = true;
    socket.emitEvent = (args) => {
        if (window.__dropStates && args[0] === 'data-message' && args[1]?.type === 'save-state') {
            window.__droppedStates++;
            return;
        }
        emitEvent(args);
    };
}"""


def test_a_guest_the_hosts_state_never_reaches_is_left_out_at_the_barrier_and_joins_late(
    browser, server_url, rom_path, room
):
    """A guest that loaded but never gets the host's state does not hold the start: it joins late.

    The guest taps and loads first, then the host; the host syncs and is
    ready, but its state never reaches the guest (the relay stalls), so the
    guest never says it is ready. There is one sync per start: the host's
    sync timeout no longer sends it back to wait for emu-ready. Its load
    deadline, measured from each player's last start step, leaves the guest
    out once it has made none for a whole window; the host plays alone, and
    the guest's page starts again as a late joiner and joins from the
    running state (specs/start_group.qnt, aStateThatNeverArrivesTest).

    `knStartLoadMs=5000` is the test-only window (60 s in play): it only
    shortens the deadline, and never below 5 s.
    """
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback&knStartLoadMs=5000")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        host.locator("#rom-drop input[type='file']").set_input_files(rom_path)
        host.wait_for_timeout(500)

        # No cached copy for the guest either: it waits for the host's state.
        guest.route("**/api/cached-state/**", lambda route: route.abort())
        guest.goto(f"{server_url}/play.html?room={room}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)
        guest.locator("#rom-drop input[type='file']").set_input_files(rom_path)
        guest.wait_for_function("!!window.NetplayRollback && !!window.__test_socket", timeout=10000)
        guest.evaluate(_RECORD_ENGINE_STARTS)
        guest.evaluate(_DROP_THE_HOSTS_STATE)

        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")

        # The guest taps and loads first, so the host finds it loaded and
        # waits for it at the barrier, not at the emu-ready wait.
        guest_prompt = guest.locator("#gesture-prompt")
        expect(guest_prompt).to_be_visible(timeout=15000)
        guest_prompt.click()
        guest.wait_for_function(
            "window.NetplayRollback.exportSyncLog().includes('emulator ready')",
            timeout=120000,
        )
        host_prompt = host.locator("#gesture-prompt")
        expect(host_prompt).to_be_visible(timeout=15000)
        host_prompt.click()

        # The host leaves the guest out at its deadline and plays alone.
        host.wait_for_function(
            "(window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? 0) > 60",
            timeout=180000,
        )
        log = host.evaluate("window.NetplayRollback.exportSyncLog()")
        assert "START-LOAD-DEADLINE" in log, log[-3000:]
        assert "reason=it did not get ready in time" in log, log[-3000:]
        assert "reason=it did not load in time" not in log, log[-3000:]
        assert guest.evaluate("window.__droppedStates") >= 1

        # The guest heard it and started again as a late joiner; the late
        # join's state reaches it.
        guest.evaluate("window.__dropStates = false")
        guest.wait_for_function("window.__engineStarts.length >= 2", timeout=30000)
        assert guest.evaluate("window.__engineStarts") == [False, True]
        late_prompt = guest.locator("#gesture-prompt")
        expect(late_prompt).to_be_visible(timeout=30000)
        late_prompt.click()
        joined_at = _frame(host)
        # A late joiner boots cold and then waits for its state: in the cloud
        # container that took 158-176 s in lifecycle-e2e's late-join runs.
        guest.wait_for_function(
            f"(window.NetplayRollback?.getHudCounters?.()?.currentFrame ?? 0) > {joined_at}",
            timeout=240000,
        )
        host_then, guest_then = _frame(host), _frame(guest)
        host.wait_for_timeout(3000)
        assert _frame(host) > host_then
        assert _frame(guest) > guest_then

    finally:
        host.close()
        guest.close()
