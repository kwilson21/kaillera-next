"""Dashboard browser coverage using the server's strict CSP and synthetic fixtures."""

from io import BytesIO
from urllib.parse import urlsplit

from PIL import Image
from playwright.sync_api import expect


def test_match_summary_and_exact_screenshots_under_strict_csp(page, server_url):
    requests = []
    session = {"id": 42, "slot": 0, "player_name": "Synthetic", "match_id": "sandbox", "room": "LOCAL"}
    image = BytesIO()
    Image.new("RGB", (16, 12), color=(40, 110, 160)).save(image, format="JPEG")

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
        elif url.path.endswith("/desync-events"):
            route.fulfill(json={"events": [{"frame": 300, "vision_equal": False, "vision_confidence": "high"}]})
        elif url.path.endswith("/frame"):
            if url.query == "frame=300":
                route.fulfill(
                    json={
                        "frame": 300,
                        "slots": [0, 1, 2],
                        "previous_frame": 299,
                        "screenshots": [{"id": 4, "slot": 0, "frame": 300}, {"id": 5, "slot": 1, "frame": 300}],
                    }
                )
            else:
                route.fulfill(
                    json={
                        "frame": 299,
                        "slots": [0, 1, 2],
                        "next_frame": 300,
                        "screenshots": [{"id": 3, "slot": 2, "frame": 299}],
                    }
                )
        elif url.path.endswith("/img/4"):
            route.fulfill(body=image.getvalue(), content_type="image/jpeg")
        elif url.path.endswith("/img/5"):
            route.fulfill(status=404)
        elif url.path.endswith("/img/3"):
            route.fulfill(status=500)
        else:
            route.fulfill(json={"entries": [], "events": []})

    page.add_init_script("sessionStorage.setItem('kn-admin-key', 'admin-browser-fixture')")
    page.route("**/admin/api/**", respond)
    document = page.goto(f"{server_url}/admin.html")
    policy = document.headers["content-security-policy"]
    assert "img-src 'self' data:;" in policy
    page.get_by_role("row").filter(has_text="Synthetic").click()
    expect(page.locator("#viewer-content")).to_contain_text("Synthetic")
    expect(page.get_by_text("Could not load the session timeline.")).to_be_visible()
    assert not any("/screenshots/" in path or path.endswith("/export") for path, _ in requests)

    page.get_by_role("button", name="Compare screenshots").click()
    expect(page.get_by_text("Frame 299 · 1 of 3 captured players")).to_be_visible()
    expect(page.get_by_text("Could not load the screenshot.", exact=True)).to_be_visible()
    assert not any(path.endswith("/img/4") or path.endswith("/img/5") for path, _ in requests)
    assert not page.locator("#captures-verdict").inner_text()

    page.get_by_role("button", name="Next capture").click()
    expect(page.get_by_text("Frame 300 · 2 of 3 captured players")).to_be_visible()
    expect(page.get_by_text("Vision flagged a mismatch at this frame.")).to_be_visible()
    expect(page.get_by_text("Stored screenshot is missing.", exact=True)).to_be_visible()
    expect(page.get_by_text("No exact capture at this frame.", exact=True)).to_be_visible()
    screenshot = page.get_by_role("img", name="Player 0 at frame 300")
    expect(screenshot).to_be_visible()
    expect(screenshot).to_have_js_property("naturalWidth", 16)
    assert all("key=" not in query for path, query in requests if "/img/" in path)

    page.get_by_role("button", name="Close", exact=True).click()
    expect(page.locator("#log-viewer")).to_be_hidden()
