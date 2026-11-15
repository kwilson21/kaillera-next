"""4-player roster coordination E2E test.

Verifies that the host-authoritative roster is consistent across
all players after late-joins. The rollback engine sets the roster when its
tick loop starts and re-broadcasts it as each late joiner becomes ready, and
both need a booted emulator (a late joiner loads the host's save state), so
the pages load a real ROM: set KN_ROM to it. Without one the test is skipped.
The flow follows the late-join-two-player scenario in tests/lifecycle-e2e.mjs.

Run: KN_ROM=/path/ssb64-us.z64 pytest tests/test_roster.py -v
"""

import contextlib
import os
import secrets
import time

import pytest


@pytest.fixture
def rom_path():
    """The ROM every page boots, from KN_ROM; skip when none is given."""
    path = os.environ.get("KN_ROM")
    if not path or not os.path.isfile(path):
        pytest.skip("needs a ROM: set KN_ROM (the roster only exists once the emulator runs)")
    return path


def _connect_player(browser, server_url, room, name, rom_path, is_host=False):
    """Open a page in its own browser context, join the room and load the ROM."""
    page = browser.new_context().new_page()
    params = f"room={room}&name={name}"
    if is_host:
        params += "&host=1&mode=rollback"
    page.goto(f"{server_url}/play.html?{params}")
    page.wait_for_selector("#rom-drop", state="visible", timeout=30000)
    page.locator("#rom-drop input[type='file']").set_input_files(rom_path)
    return page


def _click_gesture_prompt(page):
    """Dismiss the tap-to-start prompt a guest (or late joiner) is shown."""
    if page.locator("#gesture-prompt:not(.hidden)").count():
        with contextlib.suppress(Exception):
            page.locator("#gesture-prompt").click(force=True, timeout=2000)


def _get_roster(page):
    """Extract the active roster from the rollback engine."""
    return page.evaluate("""
        (() => {
            const engine = window.NetplayRollback;
            if (!engine || !engine.getDebugState) return null;
            const state = engine.getDebugState();
            return state.activeRoster ? [...state.activeRoster] : null;
        })()
    """)


def _wait_for_rosters(pages, expected, timeout_s):
    """Poll until every page's roster is `expected` (or time runs out); return the last rosters seen."""
    deadline = time.time() + timeout_s
    rosters = []
    while True:
        for page in pages:
            _click_gesture_prompt(page)
        rosters = [_get_roster(page) for page in pages]
        if all(r is not None and sorted(r) == expected for r in rosters) or time.time() > deadline:
            return rosters
        time.sleep(0.5)


def test_4player_roster_coordination(browser, server_url, rom_path):
    """All 4 players must agree on the roster after late-joins."""
    room = f"ROST{secrets.token_hex(3).upper()}"
    pages = []

    try:
        # Host + P1 join
        host = _connect_player(browser, server_url, room, "Host", rom_path, is_host=True)
        pages.append(host)
        p1 = _connect_player(browser, server_url, room, "P1", rom_path)
        pages.append(p1)

        # Start game
        host.wait_for_selector("#start-btn:not([disabled])", timeout=60000)
        host.click("#start-btn")

        # Wait for the tick loop to start on both (it broadcasts the first roster)
        host_roster, p1_roster = _wait_for_rosters(pages, [0, 1], 240)

        # Verify initial 2-player roster
        assert host_roster is not None, "Host should have roster"
        assert sorted(host_roster) == [0, 1], f"Host roster should be [0,1], got {host_roster}"
        assert p1_roster is not None, "P1 should have roster"
        assert sorted(p1_roster) == [0, 1], f"P1 roster should be [0,1], got {p1_roster}"

        # P2 late-joins
        p2 = _connect_player(browser, server_url, room, "P2", rom_path)
        pages.append(p2)

        # All 3 should agree on roster
        for i, roster in enumerate(_wait_for_rosters(pages, [0, 1, 2], 420)):
            assert roster is not None, f"P{i} should have roster"
            assert sorted(roster) == [0, 1, 2], f"P{i} roster should be [0,1,2], got {roster}"

        # P3 late-joins
        p3 = _connect_player(browser, server_url, room, "P3", rom_path)
        pages.append(p3)

        # All 4 should agree on roster
        for i, roster in enumerate(_wait_for_rosters(pages, [0, 1, 2, 3], 420)):
            assert roster is not None, f"P{i} should have roster"
            assert sorted(roster) == [0, 1, 2, 3], f"P{i} roster should be [0,1,2,3], got {roster}"

    finally:
        for page in pages:
            page.context.close()
