"""Database backends. The interface is in base.py; db.py is the only caller."""

from __future__ import annotations

import os

from src.dbbackend.base import Backend, BackendError, ExecResult, Params, Statement

DEFAULT_DB_PATH = os.path.join("data", "kn.db")

__all__ = ["DEFAULT_DB_PATH", "Backend", "BackendError", "ExecResult", "Params", "Statement", "backend_from_env"]


def backend_from_env(db_path: str | None = None) -> Backend:
    """Pick the backend. An explicit db_path always means local SQLite."""
    from src.dbbackend.sqlite import SqliteBackend

    return SqliteBackend(db_path or os.environ.get("DB_PATH", DEFAULT_DB_PATH))
