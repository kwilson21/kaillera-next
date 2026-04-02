"""E2E tests for the feedback system (commits b18789d, 17f7e5a, fb0853e).

Run: pytest tests/test_feedback_e2e.py -v
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


def test_feedback_fab_and_modal_lifecycle(page, server_url):
    """FAB visible on lobby, opens modal, Escape closes it."""
    page.goto(server_url)
    page.wait_for_timeout(500)

    fab = page.locator(".kn-feedback-fab")
    expect(fab).to_be_visible()

    fab.click()
    expect(page.locator(".kn-feedback-backdrop")).to_be_visible(timeout=2000)

    # Submit disabled without category + message
    expect(page.locator(".kn-feedback-submit")).to_be_disabled()

    # Select category and type message — submit enables
    page.click('.kn-feedback-cat[data-cat="bug"]')
    page.fill(".kn-feedback-textarea", "Test bug")
    expect(page.locator(".kn-feedback-submit")).to_be_enabled()

    # Escape closes
    page.keyboard.press("Escape")
    page.wait_for_timeout(300)
    expect(page.locator(".kn-feedback-backdrop")).to_be_hidden()


def test_first_visit_callout(context, server_url):
    """First-time visitors see pulsing callout; returning visitors don't."""
    page = context.new_page()
    try:
        page.goto(server_url)
        page.evaluate("localStorage.removeItem('kn-feedback-seen')")
        page.goto(server_url)
        page.wait_for_timeout(500)

        expect(page.locator(".kn-feedback-callout.show")).to_be_visible(timeout=3000)

        # After dismissal (click FAB), localStorage is set
        page.click(".kn-feedback-fab")
        page.wait_for_timeout(500)
        seen = page.evaluate("localStorage.getItem('kn-feedback-seen')")
        assert seen == "1"
    finally:
        page.close()

    # Return visit — no callout
    page2 = context.new_page()
    try:
        page2.goto(server_url)
        page2.wait_for_timeout(1500)
        assert page2.locator(".kn-feedback-callout").count() == 0
    finally:
        page2.close()


def test_feedback_fab_hidden_during_game(context, server_url):
    """FAB hides when game starts; feedback item appears in toolbar dropdown."""
    host = context.new_page()
    guest = context.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=FB01{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)
        expect(host.locator(".kn-feedback-fab")).to_be_visible()

        guest.goto(f"{server_url}/play.html?room=FB01{_R}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        _mark_rom_ready(host)
        _mark_rom_ready(guest)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)

        host.wait_for_timeout(1500)
        expect(host.locator(".kn-feedback-fab")).to_be_hidden()

        host.click("#toolbar-more")
        expect(host.locator(".kn-feedback-toolbar-item")).to_be_visible(timeout=2000)
    finally:
        host.close()
        guest.close()
