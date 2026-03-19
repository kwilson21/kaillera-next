"""Shared fixtures for all tests (REST and Playwright E2E)."""

import subprocess
import time
from pathlib import Path

import pytest
import requests

SERVER_URL = "http://localhost:8000"
SERVER_DIR = str(Path(__file__).parent.parent / "server")


@pytest.fixture(scope="session")
def server_url():
    """Start the kaillera-next server and return its URL."""
    proc = subprocess.Popen(
        ["python", "-c", "from src.main import run; run()"],
        cwd=SERVER_DIR,
    )
    for _ in range(30):
        try:
            r = requests.get(f"{SERVER_URL}/health", timeout=1)
            if r.status_code == 200:
                break
        except Exception:
            pass
        time.sleep(0.5)
    else:
        proc.terminate()
        pytest.fail("Server did not start within 15 seconds")
    yield SERVER_URL
    proc.terminate()
    proc.wait()
