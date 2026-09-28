"""Front page UX tests — line, code validation, buttons, meta.

Run: pytest tests/test_lobby_ux.py -v
"""

import secrets

from playwright.sync_api import expect

_R = secrets.token_hex(3).upper()


def test_line_visible(page, server_url):
    """First-time visitors see what this is in one line (landing-design §7.4)."""
    page.goto(server_url)
    line = page.locator(".line")
    expect(line).to_be_visible()
    expect(line).to_contain_text("In your browser. No install.")


def test_no_name_box_on_the_front_page(page, server_url):
    """The room asks for a name, not the front page (§7.2 M1)."""
    page.goto(server_url)
    assert page.locator("#player-name").count() == 0


def test_watch_button_label(page, server_url):
    """The code field's spectate button says what it does."""
    page.goto(server_url)
    expect(page.locator("#watch-btn")).to_have_text("Watch")


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
    # Check disabled state via click handler before navigation fires
    disabled = page.evaluate("""(() => {
        const btn = document.getElementById('create-btn');
        btn.addEventListener('click', () => { window.__btnDisabled = btn.disabled; }, { once: true });
        btn.click();
        return window.__btnDisabled;
    })()""")
    assert disabled is True


def test_meta_description_lobby(page, server_url):
    """Front page has meta description for social sharing."""
    page.goto(server_url)
    desc = page.locator('meta[name="description"]').get_attribute("content")
    assert desc and "Super Smash Bros. 64" in desc


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
