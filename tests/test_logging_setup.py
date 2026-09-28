"""Server logging setup.

Run: cd server && uv run --extra dev pytest ../tests/test_logging_setup.py -q
"""

import logging

import pytest


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


def test_httpx_request_lines_are_not_logged_at_info():
    """Every D1 query is an httpx request; at INFO each one adds a log line."""
    from src.main import _configure_logging

    httpx_logger = logging.getLogger("httpx")
    before = httpx_logger.level
    try:
        _configure_logging()
        assert not httpx_logger.isEnabledFor(logging.INFO)
        assert httpx_logger.isEnabledFor(logging.WARNING)
    finally:
        httpx_logger.setLevel(before)
