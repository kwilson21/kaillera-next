"""Backend-neutral types for the database layer.

A backend runs SQLite-dialect SQL somewhere: a local file (SqliteBackend) or
Cloudflare D1 over HTTPS (D1Backend). src/db.py is the only caller.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

Params = Sequence[Any]
Statement = tuple[str, Params]


class BackendError(RuntimeError):
    """A query failed or the backend is unavailable."""


@dataclass(frozen=True)
class ExecResult:
    last_row_id: int | None
    changes: int


class Backend(Protocol):
    name: str
    # False when the backend can't store BLOB values (D1's HTTP API is JSON).
    supports_blobs: bool

    async def open(self) -> None: ...

    async def close(self) -> None: ...

    async def query(self, sql: str, params: Params = ()) -> list[dict[str, Any]]: ...

    async def execute(self, sql: str, params: Params = ()) -> ExecResult: ...

    async def batch(self, statements: Sequence[Statement]) -> list[ExecResult]: ...
