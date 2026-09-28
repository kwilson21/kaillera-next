"""Helpers shared by the database backend tests."""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path


def run_async(coro):
    """Run a coroutine on a fresh event loop in its own thread.

    pytest-playwright may own an event loop on the main thread, which makes
    asyncio.run() raise there (same approach as tests/test_db.py). Open, use
    and close a backend inside one call: connections are bound to the loop.
    """
    result: list = []
    error: list = []

    def target() -> None:
        loop = asyncio.new_event_loop()
        try:
            result.append(loop.run_until_complete(coro))
        except BaseException as exc:
            error.append(exc)
        finally:
            loop.close()

    thread = threading.Thread(target=target)
    thread.start()
    thread.join()
    if error:
        raise error[0]
    return result[0] if result else None


def make_backend(kind: str, tmp_path: Path):
    """Return an unopened backend of the given kind."""
    from src.dbbackend.sqlite import SqliteBackend

    if kind == "sqlite":
        return SqliteBackend(str(tmp_path / "contract.db"))
    raise ValueError(f"unknown backend kind: {kind}")
