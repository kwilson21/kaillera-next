"""Toasts, the error card, the invite menu and the More menu on the real play page.

These moved from web/static/play.js to web/src/play/notices.ts and
web/src/play/menus.ts. Nearly all of it is DOM work, which Node cannot run,
so it is checked here in Chromium against the live server.

Not covered: the phone share sheet (navigator.share), which headless
Chromium does not have.

Run: pytest tests/test_play_menus_e2e.py -v   (needs the server running)
"""

from playwright.sync_api import expect

# Keep what the page copies, whichever way it copies it.
_KEEP_COPIES = """
    window.__copied = [];
    if (navigator.clipboard) {
        navigator.clipboard.writeText = async (text) => { window.__copied.push(text); };
    }
"""


def _open(browser, server_url, room):
    page = browser.new_page()
    page.add_init_script(_KEEP_COPIES)
    page.goto(f"{server_url}/play.html?room={room}&host=1&name=Host")
    expect(page.locator("#overlay")).to_be_visible(timeout=10000)
    page.wait_for_function("window.__test_socket && window.__test_socket.connected", timeout=10000)
    return page


def test_a_toast_shows_then_removes_itself(browser, server_url, room):
    page = _open(browser, server_url, room)
    try:
        page.evaluate("window.knShowToast('Hello <b>there</b>')")
        toast = page.locator("#toast-container .toast", has_text="Hello")
        expect(toast).to_be_visible()
        # Text, never markup.
        assert toast.inner_html() == "Hello &lt;b&gt;there&lt;/b&gt;"
        expect(toast).to_have_class("toast fade-out", timeout=4000)
        expect(toast).to_have_count(0, timeout=2000)
    finally:
        page.close()


def test_the_error_card_shows_the_message_and_the_way_back(browser, server_url, room):
    page = _open(browser, server_url, room)
    try:
        page.evaluate("window.knShowError('first')")
        page.evaluate("window.knShowError('It <i>broke</i>')")
        card = page.locator("#error-msg .error-card")
        expect(page.locator("#error-msg")).to_be_visible()
        # The second message replaces the first.
        expect(card.locator("p")).to_have_count(1)
        expect(card.locator("p")).to_have_text("It <i>broke</i>")
        expect(card.locator("h3")).to_have_text("Error")
        assert card.locator("a.error-back").get_attribute("href") == "/"
    finally:
        page.close()


def test_the_invite_menu_copies_play_and_watch_links(browser, server_url, room):
    page = _open(browser, server_url, room)
    try:
        menu = page.locator("#kn-invite-dropdown")
        page.click("#copy-link")
        expect(menu).to_be_visible()
        expect(menu.locator("button")).to_have_text(["Play", "Watch"])

        menu.locator("button", has_text="Play").click()
        expect(menu).to_have_count(0)
        expect(page.locator("#toast-container .toast", has_text="Play link copied!")).to_be_visible()

        page.click("#copy-link")
        menu.locator("button", has_text="Watch").click()
        expect(page.locator("#toast-container .toast", has_text="Watch link copied!")).to_be_visible()

        copied = page.evaluate("window.__copied")
        assert copied == [f"{server_url}/join?room={room}", f"{server_url}/join?room={room}&spectate=1"]

        # The button toggles the menu, and a click elsewhere closes it.
        page.click("#copy-link")
        expect(menu).to_be_visible()
        page.click("#copy-link")
        expect(menu).to_have_count(0)
        page.click("#copy-link")
        expect(menu).to_be_visible()
        # The outside-click listener is added a task after the menu opens.
        page.wait_for_timeout(100)
        page.mouse.click(5, 5)
        expect(menu).to_have_count(0)
    finally:
        page.close()


def test_the_more_menu_opens_above_its_button_and_closes(browser, server_url, room):
    page = _open(browser, server_url, room)
    try:
        # The toolbar replaces the lobby overlay when a game starts; swap them as the page does.
        page.evaluate(
            """() => {
                document.getElementById('overlay').classList.add('hidden');
                document.getElementById('toolbar').classList.remove('hidden');
            }"""
        )
        button = page.locator("#toolbar-more")
        menu = page.locator("#more-dropdown")
        expect(button).to_be_visible()
        expect(menu).to_be_hidden()

        button.click()
        expect(menu).to_be_visible()
        expect(button).to_have_attribute("aria-expanded", "true")
        placed = page.evaluate(
            """() => {
                const m = document.getElementById('more-dropdown').getBoundingClientRect();
                const b = document.getElementById('toolbar-more').getBoundingClientRect();
                return { menuBottom: m.bottom, menuRight: m.right, menuLeft: m.left, menuTop: m.top,
                         buttonTop: b.top, buttonRight: b.right, width: window.innerWidth,
                         onBody: document.getElementById('more-dropdown').parentElement === document.body };
            }"""
        )
        assert placed["onBody"] is True
        assert placed["menuBottom"] <= placed["buttonTop"]
        assert placed["menuLeft"] >= 0 and placed["menuRight"] <= placed["width"]
        assert placed["menuTop"] >= 0

        page.keyboard.press("Escape")
        expect(menu).to_be_hidden()
        expect(button).to_have_attribute("aria-expanded", "false")
        home = "document.getElementById('more-dropdown').parentElement.id"
        assert page.evaluate(home) == "more-wrapper"
        assert page.evaluate("document.getElementById('more-dropdown').getAttribute('style')") is None

        # The button toggles it; a click elsewhere closes it.
        button.click()
        expect(menu).to_be_visible()
        button.click()
        expect(menu).to_be_hidden()
        button.click()
        expect(menu).to_be_visible()
        page.mouse.click(5, 5)
        expect(menu).to_be_hidden()

        # Sharing from the menu copies the link and closes the menu.
        button.click()
        page.click("#share-watch")
        expect(menu).to_be_hidden()
        assert page.evaluate("window.__copied") == [f"{server_url}/join?room={room}&spectate=1"]
    finally:
        page.close()
