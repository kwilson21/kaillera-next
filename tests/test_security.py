"""Tests for security hardening (commit 275a87f).

Run: pytest tests/test_security.py -v
"""

import secrets

import requests
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


def test_reconnect_token_issued_and_forged_rejected(browser, server_url):
    """Reconnect token is issued on join; forged tokens are rejected."""
    host = browser.new_page()
    impersonator = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=SEC01{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        # Verify token was issued (play.js keeps both in sessionStorage)
        host.wait_for_function(
            "sessionStorage.getItem('kn-player-id') && sessionStorage.getItem('kn-reconnect-token:' + KNState.room)",
            timeout=10000,
        )
        host_pid = host.evaluate(
            "({ pid: sessionStorage.getItem('kn-player-id'), tok: sessionStorage.getItem('kn-reconnect-token:' + KNState.room) })"
        )
        assert len(host_pid["tok"]) > 16

        # Impersonator tries to hijack session with forged token
        impersonator.goto(f"{server_url}/play.html?room=SEC01{_R}&name=Fake")
        impersonator.wait_for_function(
            "window.__test_socket && window.__test_socket.connected", timeout=10000
        )
        result = impersonator.evaluate(f"""
            new Promise(resolve => {{
                window.__test_socket.emit('join-room', {{
                    extra: {{
                        sessionid: 'SEC01{_R}',
                        persistentId: '{host_pid["pid"]}',
                        reconnectToken: 'forged',
                        player_name: 'Fake'
                    }}
                }}, (err, data) => resolve(err));
            }})
        """)
        assert result == "Invalid reconnect token"
    finally:
        host.close()
        impersonator.close()


def test_spectator_cannot_claim_slot_during_game(browser, server_url):
    """Spectator slot claims blocked while game is active."""
    host = browser.new_page()
    guest = browser.new_page()
    spectator = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=SEC02{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=SEC02{_R}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        spectator.goto(f"{server_url}/play.html?room=SEC02{_R}&name=Spec&spectate=1")
        expect(spectator.locator("#overlay")).to_be_visible(timeout=10000)

        _mark_rom_ready(host)
        _mark_rom_ready(guest)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)

        result = spectator.evaluate("""
            new Promise(resolve => {
                window.__test_socket.emit('claim-slot', { slot: 2 }, resolve);
            })
        """)
        assert result == "Cannot claim slot during active game"
    finally:
        host.close()
        guest.close()
        spectator.close()


def test_ice_servers_no_turn_without_token(server_url):
    """ICE servers returns only STUN without a valid upload token."""
    servers = requests.get(f"{server_url}/ice-servers", timeout=5).json()
    for s in servers:
        assert "credential" not in s, "TURN credentials should not be exposed without auth"


def test_og_tags_ignore_spoofed_host(monkeypatch):
    """OG meta tags don't reflect a spoofed Host header.

    The server holds the Host header to ALLOWED_ORIGIN, which production sets;
    with it unset (a dev server, like the one these tests start) every host is
    let through. So the app is built here as production configures it.
    """
    from fastapi.testclient import TestClient

    from src.api import app as appmod

    monkeypatch.setenv("ALLOWED_ORIGIN", "https://play.example")
    client = TestClient(appmod.create_app())
    r = client.get("/", headers={"Host": "evil.example.com", "Accept": "text/html"})
    assert r.status_code == 200
    assert "evil.example.com" not in r.text
    # The configured host stands in for the spoofed one.
    assert 'content="https://play.example/static/og/home.png"' in r.text


def test_sanitize_strips_angle_brackets(page, server_url):
    """Player names with <script> tags are sanitized."""
    page.goto(f"{server_url}/play.html?room=SEC03{_R}&host=1&name=%3Cscript%3Ealert(1)%3C/script%3E")
    expect(page.locator("#overlay")).to_be_visible(timeout=10000)
    # The server strips angle brackets from the name before anyone sees it.
    name = page.locator('.player-slot[data-slot="0"] .name')
    expect(name).to_contain_text("script", timeout=10000)
    assert "<" not in name.inner_text() and ">" not in name.inner_text()
    assert "<script>" not in page.locator("#player-list").inner_html()


def test_oversized_snapshot_dropped(browser, server_url):
    """Snapshot payloads exceeding 64KB are silently dropped (input/snapshot cap)."""
    host = browser.new_page()
    guest = browser.new_page()

    try:
        host.goto(f"{server_url}/play.html?room=SEC04{_R}&host=1&name=Host")
        expect(host.locator("#overlay")).to_be_visible(timeout=10000)

        guest.goto(f"{server_url}/play.html?room=SEC04{_R}&name=Guest")
        expect(guest.locator("#overlay")).to_be_visible(timeout=10000)

        _mark_rom_ready(host)
        _mark_rom_ready(guest)
        expect(host.locator("#start-btn")).to_be_enabled(timeout=10000)
        host.click("#start-btn")
        expect(host.locator("#toolbar")).to_be_visible(timeout=10000)

        # Guest sets up listener, host sends >64KB snapshot, wait to see if it arrives
        guest.evaluate("window.__test_relay_received = false")
        guest.evaluate("""
            window.__test_socket.on('snapshot', () => { window.__test_relay_received = true; });
        """)
        host.evaluate("""
            window.__test_socket.emit('snapshot', { type: 'test', data: 'x'.repeat(70000) });
        """)
        guest.wait_for_timeout(2000)
        assert guest.evaluate("window.__test_relay_received") is False, \
            "Oversized snapshot should be dropped"
    finally:
        host.close()
        guest.close()
