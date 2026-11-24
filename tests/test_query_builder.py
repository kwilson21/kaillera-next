"""What the query builder hands to a backend: SQLite SQL and positional params.

Both backends (local SQLite, D1 over HTTPS) take `?` placeholders and a
params tuple in order, so the compile step is pinned here.

Run: cd server && uv run pytest ../tests/test_query_builder.py -v
"""

import sqlite3

from sqlalchemy import insert, select
from src import db
from src.schema import Feedback, SessionLog, SessionLogChunk


def test_params_come_out_in_placeholder_order():
    sql, params = db.compile_statement(insert(Feedback).values(message="m", category="bug", email=None))
    assert sql.count("?") == len(params) == 3
    columns = sql[sql.index("(") + 1 : sql.index(")")].split(", ")
    assert dict(zip(columns, params, strict=True)) == {"category": "bug", "message": "m", "email": None}


def test_slot_matches_null_and_numbers_alike():
    """`slot IS ?` in the hand-written SQL: a spectator's slot is NULL."""
    sql, params = db.compile_statement(select(SessionLog.id).where(SessionLog.slot.is_(None)))
    assert "slot IS NULL" in sql and params == ()
    sql, params = db.compile_statement(select(SessionLog.id).where(SessionLog.slot.is_(2)))
    assert "slot IS ?" in sql and params == (2,)


def test_in_lists_expand_to_one_placeholder_per_value():
    sql, params = db.compile_statement(select(Feedback.id).where(Feedback.category.in_(["bug", "idea"])))
    assert "IN (?, ?)" in sql and params == ("bug", "idea")


def test_chunk_cap_keeps_the_newest_chunks_that_fit(monkeypatch):
    """The cap DELETE, run for real: oldest chunks go, newest that fit stay."""
    monkeypatch.setattr(db, "_SESSION_LOG_CHUNK_CAP", 25)
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE session_log_chunks (id INTEGER PRIMARY KEY, match_id TEXT, slot INTEGER, first_seq INTEGER,"
        " last_seq INTEGER, entries TEXT, size INTEGER, created_at TEXT, kind TEXT)"
    )
    rows = [
        ("m", 0, "log", 10),
        ("m", 0, "log", 10),
        ("m", 0, "log", 10),
        ("m", 0, "audit", 99),
        ("m", None, "log", 99),
    ]
    for match_id, slot, kind, size in rows:
        conn.execute(
            *db.compile_statement(
                insert(SessionLogChunk).values(
                    match_id=match_id, slot=slot, kind=kind, first_seq=0, last_seq=0, entries="[]", size=size
                )
            )
        )
    conn.execute(*db.compile_statement(db._chunk_cap_statement("m", 0, "log")))
    kept = conn.execute("SELECT id FROM session_log_chunks ORDER BY id").fetchall()
    # ids 1-3 are slot 0's log chunks (10 bytes each, cap 25): the oldest goes.
    # The audit chunk and the spectator's chunk belong to other streams.
    assert [row[0] for row in kept] == [2, 3, 4, 5]
