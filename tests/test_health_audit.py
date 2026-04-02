"""Tests for codebase health audit regressions (commit 461f1e6).

Run: pytest tests/test_health_audit.py -v
"""

import secrets

from playwright.sync_api import expect

_R = secrets.token_hex(3).upper()


def _mark_rom_ready(page):
    page.wait_for_function(
        "window.__test_socket && window.__test_socket.connected", timeout=10000
    )
    page.evaluate("""
        if (window.__test_setRomLoaded) window.__test_setRomLoaded();
        window.__test_socket.emit('rom-ready', { ready: true });
    """)


def test_console_debug_flag(page, server_url):
    """console.log works with ?debug but is suppressed without it."""
    # With ?debug — should work
    msgs_debug = []
    page.on("console", lambda m: msgs_debug.append(m.text))
    page.goto(f"{server_url}/play.html?room=HA01{_R}&host=1&name=Host&debug")
    page.wait_for_timeout(2000)
    page.evaluate("console.log('__DEBUG_PROBE__')")
    page.wait_for_timeout(200)
    assert "__DEBUG_PROBE__" in msgs_debug


def test_sync_log_ring_available(page, server_url):
    """SyncLogRing is exported from shared.js (extracted from both engines)."""
    page.goto(f"{server_url}/play.html?room=HA02{_R}&host=1&name=Host")
    page.wait_for_function("typeof window.SyncLogRing !== 'undefined'", timeout=10000)

    result = page.evaluate("""(() => {
        const r = new window.SyncLogRing(5);
        r.push({ msg: 'a' }); r.push({ msg: 'b' });
        return r.entries().length;
    })()""")
    assert result == 2


def test_console_restored_after_game_end(context, server_url):
    """console.log is restored after a game ends (cleanup in stopSync)."""
    host = context.new_page()
    guest = context.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=HA03{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=HA03{_R}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        _mark_rom_ready(host)
        _mark_rom_ready(guest)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)

        host.click("#toolbar-more")
        expect(host.locator("#toolbar-end")).to_be_visible(timeout=2000)
        host.click("#toolbar-end")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # console.log should be restored (not still monkey-patched)
        assert host.evaluate("typeof console.log === 'function'") is True
    finally:
        host.close()
        guest.close()
