"""Image controls in the real play-page UI; synthetic rooms, no ROM/gameplay required."""

import pytest
from playwright.sync_api import expect


def _open_room(page, server_url, room, query=""):
    page.goto(f"{server_url}/play.html?room={room}&host=1&name=PrivacyTest{query}")
    expect(page.locator("#overlay")).to_be_visible(timeout=10000)
    expect(page.locator("#opt-diagnostic-images")).to_be_visible()


def test_preference_survives_reload_and_syncs_between_tabs(context, page, server_url, room):
    _open_room(page, server_url, room)
    checkbox = page.locator("#opt-diagnostic-images")
    expect(checkbox).to_be_checked()
    for _ in range(3):
        checkbox.uncheck()
        assert page.evaluate("KNCapture.allowed()") is False
        checkbox.check()
        assert page.evaluate("KNCapture.allowed()") is True
    expect(page.locator("#opt-listed")).not_to_be_checked()
    checkbox.uncheck()
    page.reload()
    expect(checkbox).not_to_be_checked()
    other = context.new_page()
    try:
        other.goto(f"{server_url}/play.html?room={room}&name=PrivacyGuest")
        other_box = other.locator("#opt-diagnostic-images")
        expect(other_box).to_be_visible()
        expect(other_box).not_to_be_checked()
        other_box.check()
        expect(checkbox).to_be_checked()
        checkbox.uncheck()
        expect(other_box).not_to_be_checked()
    finally:
        other.close()


@pytest.mark.parametrize("query", ["&screenshots=off", "&knperf=light"])
def test_url_opt_out_is_visible_and_cannot_be_overridden(page, server_url, room, query):
    _open_room(page, server_url, room, query)
    expect(page.locator("#opt-diagnostic-images")).not_to_be_checked()
    expect(page.locator("#opt-diagnostic-images")).to_be_disabled()
    expect(page.locator("#diagnostic-images-status")).to_be_visible()
    page.evaluate("KNCapture.setEnabled(true)")
    assert page.evaluate("KNCapture.allowed()") is False
    expect(page.locator("#toolbar-diagnostic-images")).to_be_disabled()


@pytest.mark.parametrize("width", [360, 1280])
def test_game_menu_toggle_dismissal_and_notice_do_not_navigate_away(page, server_url, room, width):
    page.set_viewport_size({"width": width, "height": 900})
    _open_room(page, server_url, room)
    original_url = page.url
    # Exercise the actual menu handlers without booting an emulator or using a ROM.
    page.evaluate("""() => {
      document.getElementById('overlay').classList.add('hidden');
      document.getElementById('toolbar').classList.remove('hidden');
    }""")
    menu = page.locator("#more-dropdown")
    button = page.locator("#toolbar-diagnostic-images")
    for _ in range(3):
        page.locator("#toolbar-more").click()
        expect(menu).to_be_visible()
        button.click()
        expect(button).to_have_attribute("aria-checked", "false")
        button.click()
        expect(button).to_have_attribute("aria-checked", "true")
        page.keyboard.press("Escape")
        expect(menu).to_be_hidden()
        expect(page.locator("#toolbar-more")).to_have_attribute("aria-expanded", "false")
    page.locator("#toolbar-more").click()
    box = menu.bounding_box()
    assert box["x"] >= 0 and box["x"] + box["width"] <= width
    with page.expect_popup() as popup:
        menu.get_by_role("menuitem", name="Privacy notice").click()
    notice = popup.value
    try:
        expect(notice.get_by_role("heading", name="Privacy", exact=True)).to_be_visible()
        assert page.url == original_url
    finally:
        notice.close()
    page.mouse.click(5, 200)
    expect(menu).to_be_hidden()
    assert page.evaluate("KNCapture.allowed()") is True
    assert page.url == original_url
