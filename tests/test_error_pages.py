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


def test_sync_logs_rejected_with_bad_token(server_url):
    """Sync log upload with invalid HMAC token is rejected."""
    r = requests.post(
        f"{server_url}/api/sync-logs?room=FAKROOM&slot=0&token=forged",
        data=b"test log data",
        headers={"Content-Type": "text/plain"},
        timeout=5,
    )
    assert r.status_code == 403


def test_sync_logs_rejected_without_token(server_url):
    """Sync log upload with no token is rejected."""
    r = requests.post(
        f"{server_url}/api/sync-logs?room=FAKROOM&slot=0",
        data=b"test log data",
        headers={"Content-Type": "text/plain"},
        timeout=5,
    )
    assert r.status_code == 403


def test_cache_state_rejected_with_bad_token(server_url):
    """Cache state upload with invalid HMAC token is rejected."""
    r = requests.post(
        f"{server_url}/api/cache-state/abcdef1234567890?room=FAKROOM&token=forged",
        data=b"fake state data",
        timeout=5,
    )
    assert r.status_code == 403
