"""Shared fixtures for all tests (REST and Playwright E2E)."""

import os
import secrets
import subprocess
import time
from pathlib import Path

import pytest
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

SERVER_URL = "http://localhost:27888"
SERVER_DIR = str(Path(__file__).parent.parent / "server")


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args):
    """Accept self-signed certs (Tailscale HTTPS dev server)."""
    return {**browser_context_args, "ignore_https_errors": True}


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl(browser):
    """Make browser.new_page() always create an SSL-tolerant context."""
    _orig_new_page = browser.new_page

    def _ssl_new_page(**kwargs):
        ctx = browser.new_context(ignore_https_errors=True)
        return ctx.new_page(**kwargs)

    browser.new_page = _ssl_new_page


@pytest.fixture(autouse=True, scope="session")
def _patch_requests_ssl():
    """Disable SSL verification for all requests calls in tests."""
    _orig = requests.Session.request

    def _patched(self, *args, **kwargs):
        kwargs.setdefault("verify", False)
        return _orig(self, *args, **kwargs)

    requests.Session.request = _patched


_room_n = 0


@pytest.fixture
def room():
    """Generate a unique room code per test to avoid stale-state conflicts."""
    global _room_n
    _room_n += 1
    return f"T{secrets.token_hex(3).upper()}{_room_n:02d}"


@pytest.fixture(scope="session")
def server_url():
    """Return the server URL, reusing an already-running server if available."""
    # Check if server is already running
    for url in [SERVER_URL, SERVER_URL.replace("http://", "https://")]:
        try:
            r = requests.get(f"{url}/health", timeout=2, verify=False)
            if r.status_code == 200:
                yield url
                return
        except Exception:
            pass

    # No server running — start one
    env = {**os.environ, "DISABLE_RATE_LIMIT": "1", "DISABLE_HTTPS": "1"}
    proc = subprocess.Popen(
        ["python", "-c", "from src.main import run; run()"],
        cwd=SERVER_DIR,
        env=env,
    )
    actual_url = SERVER_URL
    for _ in range(30):
        for url in [SERVER_URL, SERVER_URL.replace("http://", "https://")]:
            try:
                r = requests.get(f"{url}/health", timeout=1, verify=False)
                if r.status_code == 200:
                    actual_url = url
                    break
            except Exception:
                pass
        else:
            time.sleep(0.5)
            continue
        break
    else:
        proc.terminate()
        pytest.fail("Server did not start within 15 seconds")
    yield actual_url
    proc.terminate()
    proc.wait()
