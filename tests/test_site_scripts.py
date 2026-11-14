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
PLAY = "/play.html?room=SITE01&host=1&name=Host&mode=rollback"
DEMO = "/demo.html"


@pytest.mark.parametrize("path", [FRONT, PLAY, DEMO])
def test_no_caller_runs_before_its_bundle(page, server_url, path):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(f"{server_url}{path}")
    page.wait_for_function("window.KNSite !== undefined", timeout=10000)
    page.wait_for_timeout(1000)
    assert page.evaluate("typeof window.KNSite.startVersionGuard") == "function"
    assert [e for e in errors if "KNSite" in e or "startVersionGuard" in e] == []


@pytest.mark.parametrize("path", [FRONT, PLAY])
def test_the_version_guard_asks_the_server_as_the_page_loads(page, server_url, path):
    with page.expect_request("**/api/version") as asked:
        page.goto(f"{server_url}{path}")
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
