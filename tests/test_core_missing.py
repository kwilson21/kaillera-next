"""The play and demo pages when the TypeScript core (dist/kn-core.js) fails to load.

The engine and the room logic call the core, so a page without it cannot work.
It must say so and stop, not join a room half-working.

Run: pytest tests/test_core_missing.py -v
"""

MESSAGE = "Part of this page did not load. Reload the page to try again."


def _block_core(page):
    page.route("**/static/dist/kn-core.js*", lambda route: route.abort())


def test_play_page_says_to_reload_and_does_not_join(page, server_url, room):
    _block_core(page)
    page.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback")
    error = page.locator("#error-msg")
    error.wait_for(state="visible", timeout=10000)
    assert MESSAGE in error.inner_text()
    # It stopped before connecting: no room was opened on the server.
    page.wait_for_timeout(1500)
    assert page.evaluate("window.KNCore === undefined")
    assert page.request.get(f"{server_url}/room/{room}").status == 404


def test_play_page_starts_normally_with_the_core(page, server_url, room):
    page.goto(f"{server_url}/play.html?room={room}&host=1&name=Host&mode=rollback")
    page.wait_for_function("window.KNCore !== undefined", timeout=10000)
    page.wait_for_timeout(1500)
    assert page.locator("#error-msg").is_hidden()
    assert page.request.get(f"{server_url}/room/{room}").status == 200


def test_demo_page_says_to_reload(page, server_url):
    _block_core(page)
    page.goto(f"{server_url}/demo.html")
    page.wait_for_function(
        "message => document.getElementById('demo-status')?.textContent === message",
        arg=MESSAGE,
        timeout=10000,
    )


def test_demo_page_loads_the_core(page, server_url):
    page.goto(f"{server_url}/demo.html")
    page.wait_for_function("window.KNCore !== undefined", timeout=10000)
    assert page.locator("#demo-status").inner_text() != MESSAGE
