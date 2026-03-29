"""Tests for custom error pages.

Run: pytest tests/test_error_pages.py -v
Uses the shared server_url fixture from conftest.py.
"""

import requests


def test_404_returns_html_for_browser(server_url):
    """Browser navigation to unknown path gets HTML error page."""
    r = requests.get(
        f"{server_url}/nonexistent-page",
        headers={"Accept": "text/html"},
        timeout=5,
    )
    assert r.status_code == 404
    assert "text/html" in r.headers["content-type"]
    assert "data-error-code" in r.text


def test_404_returns_default_for_api_client(server_url):
    """API clients (no text/html Accept) get default response, not HTML error page."""
    r = requests.get(
        f"{server_url}/nonexistent-page",
        headers={"Accept": "application/json"},
        timeout=5,
    )
    assert r.status_code == 404
    assert "text/html" not in r.headers.get("content-type", "")


def test_api_paths_not_intercepted(server_url):
    """API endpoints return JSON errors, not HTML error pages."""
    r = requests.get(
        f"{server_url}/room/NONEXIST",
        headers={"Accept": "text/html"},
        timeout=5,
    )
    assert r.status_code == 404
    assert r.json()["detail"] == "Room not found"


def test_health_still_works(server_url):
    """Health endpoint unaffected by error middleware."""
    r = requests.get(f"{server_url}/health", timeout=5)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
