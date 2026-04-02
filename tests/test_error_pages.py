"""Tests for custom error pages.

Run: pytest tests/test_error_pages.py -v
Uses the shared server_url fixture from conftest.py.
"""

import pytest
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



def test_cache_state_rejected_with_bad_token(server_url):
    """Cache state upload with invalid HMAC token is rejected."""
    r = requests.post(
        f"{server_url}/api/cache-state/abcdef1234567890?room=FAKROOM&token=forged",
        data=b"fake state data",
        timeout=5,
    )
    assert r.status_code == 403


_skip_ratelimit = pytest.mark.skipif(
    not __import__("os").environ.get("DISABLE_RATE_LIMIT"),
    reason="Feedback tests need DISABLE_RATE_LIMIT=1 (rate-limited on live server)",
)


@_skip_ratelimit
def test_feedback_accepts_valid_submission(server_url):
    """Valid feedback submission returns 200 with saved status."""
    r = requests.post(
        f"{server_url}/api/feedback",
        json={
            "category": "bug",
            "message": "Test bug report from automated test",
            "page": "home",
        },
        timeout=5,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "saved"
    assert data["id"] >= 1


@_skip_ratelimit
def test_feedback_rejects_missing_category(server_url):
    """Feedback without required category field is rejected."""
    r = requests.post(
        f"{server_url}/api/feedback",
        json={"message": "No category"},
        timeout=5,
    )
    assert r.status_code == 422


@_skip_ratelimit
def test_feedback_rejects_empty_message(server_url):
    """Feedback with empty message is rejected."""
    r = requests.post(
        f"{server_url}/api/feedback",
        json={"category": "bug", "message": ""},
        timeout=5,
    )
    assert r.status_code == 422


@_skip_ratelimit
def test_feedback_honeypot_silently_discards(server_url):
    """Feedback with honeypot field filled returns 200 but id=0 (discarded)."""
    r = requests.post(
        f"{server_url}/api/feedback",
        json={
            "category": "bug",
            "message": "I am a bot",
            "company_fax": "555-1234",
        },
        timeout=5,
    )
    assert r.status_code == 200
    assert r.json()["id"] == 0


@_skip_ratelimit
def test_feedback_rejects_invalid_category(server_url):
    """Feedback with unknown category is rejected."""
    r = requests.post(
        f"{server_url}/api/feedback",
        json={"category": "spam", "message": "Bad category"},
        timeout=5,
    )
    assert r.status_code == 422


def test_admin_feedback_list_requires_auth(server_url):
    """Admin feedback list requires ADMIN_KEY."""
    r = requests.get(f"{server_url}/admin/api/feedback", timeout=5)
    # Returns 401 or 403 depending on whether ADMIN_KEY is configured
    assert r.status_code in (401, 403)


def test_admin_feedback_single_requires_auth(server_url):
    """Admin feedback single entry requires ADMIN_KEY."""
    r = requests.get(f"{server_url}/admin/api/feedback/1", timeout=5)
    assert r.status_code in (401, 403)
