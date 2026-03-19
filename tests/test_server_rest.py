"""Tests for server REST endpoints.

Run: pytest tests/test_server_rest.py -v
Uses the shared server_url fixture from conftest.py.
"""

import requests


def test_health(server_url):
    r = requests.get(f"{server_url}/health", timeout=5)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_room_not_found(server_url):
    r = requests.get(f"{server_url}/room/NONEXIST", timeout=5)
    assert r.status_code == 404
    assert "detail" in r.json()
