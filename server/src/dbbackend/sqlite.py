"""Local SQLite backend (aiosqlite). Used for dev, tests and self-hosting."""

from __future__ import annotations

import asyncio
import sqlite3
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import aiosqlite

from src.dbbackend.base import BackendError, ExecResult, Params, Statement


class SqliteBackend:
    """One shared connection. A lock serializes calls so that one caller's
    commit or rollback can't land in the middle of another's batch."""

    name = "sqlite"
    supports_blobs = True

    def __init__(self, path: str) -> None:
        self.path = path
        self._conn: aiosqlite.Connection | None = None
        self._lock = asyncio.Lock()

    async def open(self) -> None:
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    def _require(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise BackendError("SQLite backend is not open")
        return self._conn

    async def query(self, sql: str, params: Params = ()) -> list[dict[str, Any]]:
        conn = self._require()
        async with self._lock:
            try:
                cursor = await conn.execute(sql, tuple(params))
                rows = await cursor.fetchall()
            except sqlite3.Error as exc:
                raise BackendError(str(exc)) from exc
        return [dict(row) for row in rows]

    async def execute(self, sql: str, params: Params = ()) -> ExecResult:
        conn = self._require()
        async with self._lock:
            try:
                cursor = await conn.execute(sql, tuple(params))
                await conn.commit()
            except BaseException as exc:
                await conn.rollback()
                if isinstance(exc, sqlite3.Error):
                    raise BackendError(str(exc)) from exc
                raise
        return ExecResult(cursor.lastrowid, max(cursor.rowcount, 0))

    async def batch(self, statements: Sequence[Statement]) -> list[ExecResult]:
        """Run the statements in one transaction; any failure rolls back all of them."""
        conn = self._require()
        results: list[ExecResult] = []
        async with self._lock:
            try:
                await conn.execute("BEGIN")
                for sql, params in statements:
                    cursor = await conn.execute(sql, tuple(params))
                    results.append(ExecResult(cursor.lastrowid, max(cursor.rowcount, 0)))
                await conn.commit()
            except BaseException as exc:
                await conn.rollback()
                if isinstance(exc, sqlite3.Error):
                    raise BackendError(str(exc)) from exc
                raise
        return results
