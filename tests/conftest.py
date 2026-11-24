"""Shared fixtures for all tests (REST and Playwright E2E)."""

import contextlib
import os
import secrets
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest
import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# KN_TEST_PORT lets parallel checkouts each run their own test server.
SERVER_URL = f"http://localhost:{os.environ.get('KN_TEST_PORT', '27888')}"
SERVER_DIR = str(Path(__file__).parent.parent / "server")


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args):
    """Accept self-signed certs (Tailscale HTTPS dev server)."""
    return {**browser_context_args, "ignore_https_errors": True}


@pytest.fixture(scope="session")
def browser(browser):
    """Accept self-signed certs for tests that create their own contexts."""
    _orig_new_context = browser.new_context
    original_new_page = browser.new_page

    def _ssl_new_context(**kwargs):
        kwargs.setdefault("ignore_https_errors", True)
        return _orig_new_context(**kwargs)

    def _ssl_new_page(**kwargs):
        kwargs.setdefault("ignore_https_errors", True)
        return original_new_page(**kwargs)

    browser.new_context = _ssl_new_context
    browser.new_page = _ssl_new_page
    return browser


@pytest.fixture(autouse=True, scope="session")
def _patch_requests_ssl():
    """Disable SSL verification for all requests calls in tests."""
    _orig = requests.Session.request

    def _patched(self, *args, **kwargs):
        kwargs.setdefault("verify", False)
        return _orig(self, *args, **kwargs)

    requests.Session.request = _patched


# A real game needs a real ROM, which the repository does not ship. Tests that
# boot one take it from KN_ROM, the variable tests/rb-two-player.mjs reads, and
# are skipped without it.
@pytest.fixture(scope="session")
def rom_path():
    path = os.environ.get("KN_ROM", "")
    if not path:
        pytest.skip("needs a ROM: set KN_ROM to the path of the SSB64 (USA) .z64")
    if not os.path.isfile(path):
        pytest.skip(f"KN_ROM is not a file: {path}")
    return path


@pytest.fixture
def start_game():
    """Start a game from the host's page and wait until it runs on every page.

    After Start, a page may show the "tap to start" prompt (#gesture-prompt)
    and stay on frame 0 until it is clicked, whatever the browser's autoplay
    policy, so each page's prompt is clicked whenever it is shown, as
    tests/rb-two-player.mjs does. Returns once window._lockstepActive is true
    on all of them; fails after timeout_s seconds.
    """

    def start(host, *others, timeout_s=120):
        pages = [host, *others]
        host.wait_for_selector("#start-btn:not([disabled])", timeout=30000)
        host.click("#start-btn")
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            for page in pages:
                if page.locator("#gesture-prompt:not(.hidden)").count():
                    # It may be hidden again before the click lands.
                    with contextlib.suppress(Exception):
                        page.locator("#gesture-prompt").click(force=True, timeout=2000)
            if all(page.evaluate("window._lockstepActive === true") for page in pages):
                return
            time.sleep(0.5)
        running = [page.evaluate("window._lockstepActive === true") for page in pages]
        pytest.fail(f"game not running on every page after {timeout_s}s (running: {running})")

    return start


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

    yield from _start_test_server(int(os.environ.get("KN_TEST_PORT", "27888")))


@pytest.fixture(scope="session")
def short_host_return_url(tmp_path_factory):
    """An isolated server where browser tests can observe actual host reservation expiry."""
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    yield from _start_test_server(
        port,
        HOST_RETURN_GRACE_SECONDS="5",
        DB_PATH=str(tmp_path_factory.mktemp("host-return") / "rooms.db"),
        D1_DATABASE_ID="",
        D1_API_TOKEN="",
        REDIS_URL="",
        REDIS_PASSWORD="",
    )


def _start_test_server(port, **settings):
    env = {**os.environ, "DISABLE_RATE_LIMIT": "1", "DISABLE_HTTPS": "1", "PORT": str(port), **settings}
    url = f"http://localhost:{port}"
    proc = subprocess.Popen([sys.executable, "-c", "from src.main import run; run()"], cwd=SERVER_DIR, env=env)
    try:
        for _ in range(30):
            if proc.poll() is not None:
                pytest.fail(f"Server exited with status {proc.returncode}")
            try:
                if requests.get(f"{url}/health", timeout=2).status_code == 200:
                    break
            except requests.RequestException:
                pass
            time.sleep(0.5)
        else:
            pytest.fail("Server did not start within 15 seconds")
        yield url
    finally:
        proc.terminate()
        proc.wait()
