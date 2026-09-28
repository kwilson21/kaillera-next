"""Helpers shared by the database backend tests."""

from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from pathlib import Path

import httpx


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
    from src.dbbackend.d1 import D1Backend
    from src.dbbackend.sqlite import SqliteBackend

    if kind == "sqlite":
        return SqliteBackend(str(tmp_path / "contract.db"))
    if kind == "d1":
        return D1Backend("acct", "db", FAKE_TOKEN, transport=FakeD1().transport())
    raise ValueError(f"unknown backend kind: {kind}")


FAKE_TOKEN = "test-token"


class FakeD1:
    """In-process stand-in for D1's HTTP query API.

    Runs the SQL on an in-memory SQLite database and answers in D1's JSON
    shape: {"success", "errors", "messages", "result": [{"success",
    "results", "meta": {"last_row_id", "changes"}}]}. A failed batch is
    rolled back, like the Worker binding's documented behavior; whether the
    HTTP API does the same is checked by tests/test_d1_live.py.
    """

    def __init__(self) -> None:
        self.conn = sqlite3.connect(":memory:", check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.requests: list[dict] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)

    def handler(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("authorization") != f"Bearer {FAKE_TOKEN}":
            return httpx.Response(403, json={"success": False, "errors": [{"code": 10000, "message": "auth"}]})
        body = json.loads(request.content)
        self.requests.append(body)
        statements = body.get("batch", [body])
        results = []
        try:
            self.conn.execute("BEGIN")
            for statement in statements:
                cursor = self.conn.execute(statement["sql"], statement.get("params", []))
                rows = [dict(row) for row in cursor.fetchall()]
                results.append(
                    {
                        "success": True,
                        "results": rows,
                        "meta": {"last_row_id": cursor.lastrowid, "changes": max(cursor.rowcount, 0)},
                    }
                )
            self.conn.commit()
        except sqlite3.Error as exc:
            self.conn.rollback()
            return httpx.Response(
                400,
                json={"success": False, "errors": [{"code": 7500, "message": str(exc)}], "messages": [], "result": []},
            )
        return httpx.Response(200, json={"success": True, "errors": [], "messages": [], "result": results})
