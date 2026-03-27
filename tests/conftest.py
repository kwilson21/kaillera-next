"""Shared fixtures for all tests (REST and Playwright E2E)."""

import os
import subprocess
import time
from pathlib import Path

import pytest
import requests

SERVER_URL = "http://localhost:27888"
SERVER_DIR = str(Path(__file__).parent.parent / "server")


@pytest.fixture(scope="session")
def browser_context_args(browser_context_args):
    """Accept self-signed certs (Tailscale HTTPS dev server)."""
    return {**browser_context_args, "ignore_https_errors": True}


@pytest.fixture(scope="session")
def server_url():
    """Start the kaillera-next server and return its URL."""
    env = {**os.environ, "DISABLE_RATE_LIMIT": "1", "DISABLE_HTTPS": "1"}
    proc = subprocess.Popen(
        ["python", "-c", "from src.main import run; run()"],
        cwd=SERVER_DIR,
        env=env,
    )
    # Server may start in HTTPS mode (Tailscale certs auto-detected)
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
