"""Report the game's mode while retaining the original value in session logs."""

from sqlalchemy import case
from sqlalchemy.sql.elements import ColumnElement

from src.schema import SessionLog


def reported_session_mode() -> ColumnElement[str]:
    # The Lockstep ID referred to Rollback before v0.64.0. Leave the release
    # day and the gap before host-selectable Lockstep (v0.69.0) ambiguous.
    mode = SessionLog.mode
    created = SessionLog.created_at
    return case(
        ((mode == "lockstep") & (created < "2026-09-30"), "rollback"),
        ((mode == "lockstep") & (created >= "2026-11-16"), "classic"),
        else_=mode,
    )
