"""Database backends. The interface is in base.py; db.py is the only caller."""

from __future__ import annotations

import os

from src.dbbackend.base import Backend, BackendError, ExecResult, Params, Statement

DEFAULT_DB_PATH = os.path.join("data", "kn.db")

__all__ = ["DEFAULT_DB_PATH", "Backend", "BackendError", "ExecResult", "Params", "Statement", "backend_from_env"]


def backend_from_env(db_path: str | None = None) -> Backend:
    """Pick the backend. An explicit db_path always means local SQLite.

    D1 is used when D1_DATABASE_ID or D1_API_TOKEN is set; a partial D1
    configuration is an error rather than a silent fallback to local disk.
    """
    from src.dbbackend.sqlite import SqliteBackend

    if db_path is None and (os.environ.get("D1_DATABASE_ID") or os.environ.get("D1_API_TOKEN")):
        from src.dbbackend.d1 import D1Backend

        values = {name: os.environ.get(name, "") for name in ("CF_ACCOUNT_ID", "D1_DATABASE_ID", "D1_API_TOKEN")}
        missing = [name for name, value in values.items() if not value]
        if missing:
            raise BackendError(f"D1 is partially configured; missing {', '.join(missing)}")
        return D1Backend(values["CF_ACCOUNT_ID"], values["D1_DATABASE_ID"], values["D1_API_TOKEN"])
    return SqliteBackend(db_path or os.environ.get("DB_PATH", DEFAULT_DB_PATH))
