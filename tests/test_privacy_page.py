"""Privacy notice routes are public, self-contained, and linked before play."""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "server"))

from src.api.app import create_app  # noqa: E402


@pytest.mark.parametrize("path", ["/privacy", "/privacy.html"])
def test_notice_is_served_by_the_app_without_a_session(path):
    with TestClient(create_app()) as client:
        response = client.get(path)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "no-store" in response.headers["cache-control"]
    assert "script-src 'self'" in response.headers["content-security-policy"]
    assert 'id="image-controls"' in response.text
    assert 'id="retention"' in response.text
    assert "<script" not in response.text


@pytest.mark.parametrize("page", ["index.html", "join.html", "play.html"])
def test_privacy_notice_is_linked_from_entry_and_game_pages(page):
    assert 'href="/privacy"' in (REPO / "web" / page).read_text()
