"""Lobby page UX tests — tagline, validation, naming, input constraints.

Run: pytest tests/test_lobby_ux.py -v
"""

import secrets

from playwright.sync_api import expect

_R = secrets.token_hex(3).upper()


def test_tagline_visible(page, server_url):
    """First-time visitors see explanatory tagline."""
    page.goto(server_url)
    tagline = page.locator(".tagline")
    expect(tagline).to_be_visible()
    expect(tagline).to_contain_text("no download needed")


def test_name_input_has_maxlength(page, server_url):
    """Player name input enforces maxlength=24."""
    page.goto(server_url)
    maxlen = page.locator("#player-name").get_attribute("maxlength")
    assert maxlen == "24", f"Expected maxlength=24, got {maxlen}"


def test_spectate_button_label(page, server_url):
    """Watch button is labeled 'Spectate' with tooltip."""
    page.goto(server_url)
    btn = page.locator("#watch-btn")
    expect(btn).to_have_text("Spectate")
    assert btn.get_attribute("title") == "Join as spectator"


def test_empty_code_shakes_input(page, server_url):
    """Clicking Join with empty code shakes the input."""
    page.goto(server_url)
    page.click("#join-btn")
    # Input should get the shake class briefly
    expect(page.locator("#room-code.shake")).to_be_visible(timeout=1000)
    # After animation ends, shake class is removed
    page.wait_for_timeout(500)
    has_shake = page.evaluate(
        "document.getElementById('room-code').classList.contains('shake')"
    )
    assert has_shake is False, "shake class should be removed after animation"


def test_create_button_disables_on_click(page, server_url):
    """Create Room button disables immediately on click to prevent double-click."""
    page.goto(server_url)
    page.fill("#player-name", "Host")
    # Check disabled state via click handler before navigation fires
    disabled = page.evaluate("""(() => {
        const btn = document.getElementById('create-btn');
        btn.addEventListener('click', () => { window.__btnDisabled = btn.disabled; }, { once: true });
        btn.click();
        return window.__btnDisabled;
    })()""")
    assert disabled is True


def test_meta_description_lobby(page, server_url):
    """Lobby page has meta description for social sharing."""
    page.goto(server_url)
    desc = page.locator('meta[name="description"]').get_attribute("content")
    assert desc and "N64" in desc


def test_meta_description_play(page, server_url):
    """Play page has meta description for social sharing."""
    page.goto(f"{server_url}/play.html?room=META{_R}&host=1&name=Host")
    desc = page.locator('meta[name="description"]').get_attribute("content")
    assert desc and "N64" in desc


def test_console_log_suppressed(page, server_url):
    """Console.log is suppressed on play page (no ?debug param)."""
    messages = []
    page.on("console", lambda msg: messages.append(msg.text))
    page.goto(f"{server_url}/play.html?room=LOG{_R}&host=1&name=Host")
    page.wait_for_timeout(2000)
    page.evaluate("console.log('__KN_TEST_PROBE__')")
    page.wait_for_timeout(200)
    assert "__KN_TEST_PROBE__" not in messages, "console.log should be suppressed"


def test_about_button_works(page, server_url):
    """About button opens modal even if version.json fetch fails."""
    page.goto(server_url)
    page.click("#kn-about")
    expect(page.locator("#kn-about-modal")).to_be_visible(timeout=3000)
