"""4-player roster coordination E2E test.

Verifies that the host-authoritative roster is consistent across
all players after late-joins. Uses __test_skipBoot to avoid
needing a real ROM — we only need the lockstep engine's signaling
and roster logic, not the emulator.

Run: pytest tests/test_roster.py -v
"""

import secrets
import time


def _connect_player(context, server_url, room, name, is_host=False):
    """Open a page and join a room."""
    page = context.new_page()
    params = f"room={room}&name={name}"
    if is_host:
        params += "&host=1"
    page.goto(f"{server_url}/play.html?{params}")
    page.evaluate("window.__test_skipBoot = true")
    page.wait_for_function(
        "window.__test_socket && window.__test_socket.connected",
        timeout=10000,
    )
    return page


def _mark_rom_ready(page):
    page.evaluate("""
        if (window.__test_setRomLoaded) window.__test_setRomLoaded();
        window.__test_socket.emit('rom-ready', { ready: true });
    """)


def _get_roster(page):
    """Extract _activeRoster from the lockstep engine."""
    return page.evaluate("""
        (() => {
            const engine = window.NetplayLockstep;
            if (!engine || !engine.getDebugState) return null;
            const state = engine.getDebugState();
            return state.activeRoster ? [...state.activeRoster] : null;
        })()
    """)


def test_4player_roster_coordination(context, server_url):
    """All 4 players must agree on the roster after late-joins."""
    room = f"ROST{secrets.token_hex(3).upper()}"
    pages = []

    try:
        # Host + P1 join
        host = _connect_player(context, server_url, room, "Host", is_host=True)
        p1 = _connect_player(context, server_url, room, "P1")
        pages = [host, p1]

        _mark_rom_ready(host)
        _mark_rom_ready(p1)

        # Start game
        host.wait_for_selector("#start-btn:not([disabled])", timeout=10000)
        host.click("#start-btn")

        # Wait for lockstep to start
        time.sleep(2)

        # Verify initial 2-player roster
        host_roster = _get_roster(host)
        p1_roster = _get_roster(p1)
        assert host_roster is not None, "Host should have roster"
        assert sorted(host_roster) == [0, 1], f"Host roster should be [0,1], got {host_roster}"
        assert sorted(p1_roster) == [0, 1], f"P1 roster should be [0,1], got {p1_roster}"

        # P2 late-joins
        p2 = _connect_player(context, server_url, room, "P2")
        pages.append(p2)
        _mark_rom_ready(p2)
        time.sleep(3)

        # All 3 should agree on roster
        for i, page in enumerate(pages):
            roster = _get_roster(page)
            assert roster is not None, f"P{i} should have roster"
            assert sorted(roster) == [0, 1, 2], f"P{i} roster should be [0,1,2], got {roster}"

        # P3 late-joins
        p3 = _connect_player(context, server_url, room, "P3")
        pages.append(p3)
        _mark_rom_ready(p3)
        time.sleep(3)

        # All 4 should agree on roster
        for i, page in enumerate(pages):
            roster = _get_roster(page)
            assert roster is not None, f"P{i} should have roster"
            assert sorted(roster) == [0, 1, 2, 3], f"P{i} roster should be [0,1,2,3], got {roster}"

    finally:
        for page in pages:
            page.close()
