"""The scripts the front page shares with the play and demo pages, in a browser.

Their logic is web/src/site (window.KNSite, set by dist/kn-site.js on the
front page and by dist/kn-core.js on the play and demo pages); the files in
web/static only start it. A caller placed before its bundle would throw as
the page loads, so every page that has one is loaded here.

Run: pytest tests/test_site_scripts.py -v
"""

import json

import pytest

FRONT = "/"
PLAY = "/play.html?host=1&name=Host&mode=rollback&room="
DEMO = "/demo.html"


def _url(server_url, path, room):
    """The page's address; the play page gets this test's own room."""
    return f"{server_url}{path}{room}" if path == PLAY else f"{server_url}{path}"


@pytest.mark.parametrize("path", [FRONT, PLAY, DEMO])
def test_no_caller_runs_before_its_bundle(page, server_url, room, path):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(_url(server_url, path, room))
    page.wait_for_function("window.KNSite !== undefined", timeout=10000)
    page.wait_for_timeout(1000)
    assert page.evaluate("typeof window.KNSite.startVersionGuard") == "function"
    assert page.evaluate("typeof window.KNSite.startVersion") == "function"
    assert page.evaluate("typeof window.KNSite.startFeedback") == "function"
    assert [e for e in errors if "KNSite" in e or "startVersion" in e or "startFeedback" in e] == []


@pytest.mark.parametrize("path", [FRONT, PLAY])
def test_the_feedback_api_keeps_its_shape(page, server_url, room, path):
    """play.js calls window.KNFeedback.prompt after a game."""
    page.goto(_url(server_url, path, room))
    page.wait_for_selector(".kn-feedback-fab", state="attached", timeout=10000)
    assert page.evaluate("Object.keys(window.KNFeedback)") == ["prompt", "open"]
    page.evaluate("window.KNFeedback.prompt()")
    page.locator(".kn-feedback-session-prompt a").click()
    page.locator(".kn-feedback-backdrop.open").wait_for(state="visible", timeout=5000)
    assert page.evaluate("document.activeElement.id") == "kn-fb-message"


@pytest.mark.parametrize("path", [FRONT, PLAY])
def test_the_version_guard_asks_the_server_as_the_page_loads(page, server_url, room, path):
    with page.expect_request("**/api/version") as asked:
        page.goto(_url(server_url, path, room))
    assert asked.value.method == "GET"


def test_a_front_page_older_than_the_server_reloads(page, server_url):
    """An idle page reloads once the server reports another version."""
    stale = {"answers": 1}

    def version(route):
        # Only the first answer is stale, so the reloaded page settles.
        if stale["answers"] == 0:
            route.continue_()
            return
        stale["answers"] -= 1
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"version": "not-this-page"}))

    page.route("**/api/version", version)
    warnings = []
    page.on("console", lambda message: warnings.append(message.text) if message.type == "warning" else None)
    page.goto(f"{server_url}{FRONT}")
    page.wait_for_function("() => performance.getEntriesByType('navigation')[0].type === 'reload'", timeout=10000)
    assert any("VERSION-MISMATCH" in w and "server=not-this-page action=reload" in w for w in warnings)


@pytest.mark.parametrize("path", [FRONT, PLAY])
def test_the_footer_shows_the_version_and_opens_the_changelog(page, server_url, room, path):
    page.goto(_url(server_url, path, room))
    page.wait_for_function("document.getElementById('kn-version').textContent.startsWith('v')", timeout=10000)
    shipped = page.request.get(f"{server_url}/static/version.json").json()["version"]
    version = page.locator("#kn-version")
    assert version.inner_text() == f"v{shipped}"
    version.click()
    changelog = page.locator("#kn-changelog-modal")
    changelog.wait_for(state="visible", timeout=10000)
    assert "Changelog" in changelog.inner_text()
    assert f"v{shipped}" in changelog.inner_text()
    page.keyboard.press("Escape")
    changelog.wait_for(state="detached", timeout=5000)


@pytest.mark.parametrize("path", [FRONT, PLAY])
def test_about_opens_and_closes(page, server_url, room, path):
    page.goto(_url(server_url, path, room))
    page.locator("#kn-about").click()
    about = page.locator("#kn-about-modal")
    about.wait_for(state="visible", timeout=10000)
    assert "Kaillera (2001)" in about.inner_text()
    assert about.locator("a", has_text="GitHub").get_attribute("href") == "https://github.com/kwilson21/kaillera-next"
    assert about.locator("a", has_text="GitHub").get_attribute("rel") == "noopener"
    about.locator("button").click()
    about.wait_for(state="detached", timeout=5000)
