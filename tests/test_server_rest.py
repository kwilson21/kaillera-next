"""Tests for server REST endpoints.

Run: pytest tests/test_server_rest.py -v
Uses the shared server_url fixture from conftest.py.
"""

import requests


def test_health(server_url):
    r = requests.get(f"{server_url}/health", timeout=5)
    assert r.status_code == 200
    data = r.json()
    assert data["status"] in ("ok", "degraded")
    assert "redis" in data
    assert "rooms" in data
    assert "players" in data


def test_room_not_found(server_url):
    r = requests.get(f"{server_url}/room/NONEXIST", timeout=5)
    assert r.status_code == 404
    assert "detail" in r.json()


def test_rom_hashes(server_url):
    """GET /api/rom-hashes returns known ROM hash table."""
    r = requests.get(f"{server_url}/api/rom-hashes", timeout=5)
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, dict)
    assert len(data) >= 1
    for sha, info in data.items():
        assert "game" in info
    assert "max-age" in r.headers.get("Cache-Control", "")
