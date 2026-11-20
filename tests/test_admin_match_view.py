"""Browser check for the admin dashboard using fake match and image responses."""

from urllib.parse import urlsplit

from playwright.sync_api import expect


def test_match_opens_before_capture_traffic_and_navigates_range(page, server_url):
    requests = []
    captures = [
        {
            "id": screenshot_id,
            "slot": slot,
            "frame": frame,
            "created_at": "2026-11-20T22:00:00",
        }
        for screenshot_id, slot, frame in [(4, 0, 299), (5, 1, 300)]
    ]
    session = {"id": 42, "slot": 0, "player_name": "Synthetic", "match_id": "sandbox", "room": "LOCAL"}

    def respond(route):
        url = urlsplit(route.request.url)
        requests.append((url.path, url.query))
        assert route.request.headers.get("x-admin-key") == "admin-browser-fixture"
        if url.path.endswith("/stats"):
            route.fulfill(json={})
        elif url.path.endswith("/session-logs"):
            route.fulfill(json={"entries": [session]})
        elif url.path.endswith("/summary"):
            route.fulfill(json=session)
        elif url.path.endswith("/session-timeline"):
            route.fulfill(status=500)
        elif url.path.endswith("/window"):
            if url.query == "frame=0":
                route.fulfill(json={"screenshots": captures, "start_frame": 0, "end_frame": 2249, "next_frame": 12300})
            else:
                route.fulfill(json={"screenshots": [], "start_frame": 11850, "end_frame": 14249, "previous_frame": 300})
        elif "/img/" in url.path:
            route.fulfill(status=404)
        else:
            route.fulfill(json={"entries": [], "events": []})

    page.add_init_script("sessionStorage.setItem('kn-admin-key', 'admin-browser-fixture')")
    page.route("**/admin/api/**", respond)
    page.goto(f"{server_url}/admin.html")
    page.get_by_role("row").filter(has_text="Synthetic").click()
    expect(page.locator("#viewer-content")).to_contain_text("Synthetic")
    expect(page.get_by_text("Could not load the session timeline.")).to_be_visible()
    assert not any("/screenshots/" in path or path.endswith("/export") for path, _ in requests)

    page.get_by_role("button", name="Show screenshots").click()
    expect(page.get_by_role("heading", name="Player Comparison (P0 / P1)")).to_be_visible()
    expect(page.locator("#comp-frame-label")).to_contain_text("f300")
    expect(page.locator("#captures-content").get_by_text("Image unavailable").first).to_be_visible()
    assert all("key=" not in query for path, query in requests if "/img/" in path)

    page.get_by_role("button", name="Later captures").click()
    expect(page.get_by_text("No screenshots in this range.")).to_be_visible()
    assert ("/admin/api/screenshots/sandbox/window", "frame=12300") in requests
    page.get_by_role("button", name="Close", exact=True).click()
    expect(page.locator("#log-viewer")).to_be_hidden()
