"""The database tables, declared once for the query builder.

server/migrations/*.sql remain the source of truth for what exists in the
database; these declarations are what Python builds queries from.
tests/test_schema.py fails if the two disagree on a table or column.

SQLAlchemy is used only to build statements: src/db.py compiles them to
SQLite-dialect SQL and hands that to the backend (local SQLite or D1 over
HTTPS). Nothing here opens a connection.
"""

from __future__ import annotations

from sqlalchemy import Boolean, Column, Float, Integer, LargeBinary, MetaData, Table, Text

metadata = MetaData()

feedback = Table(
    "feedback",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("category", Text, nullable=False),
    Column("message", Text, nullable=False),
    Column("email", Text),
    Column("page", Text),
    Column("context", Text),
    Column("ip_hash", Text),
    Column("created_at", Text),
)

client_events = Table(
    "client_events",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("type", Text, nullable=False),
    Column("message", Text),
    Column("meta", Text),
    Column("room", Text),
    Column("slot", Integer),
    Column("ip_hash", Text),
    Column("user_agent", Text),
    Column("created_at", Text),
)

session_logs = Table(
    "session_logs",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("match_id", Text, nullable=False),
    Column("room", Text, nullable=False),
    Column("slot", Integer),
    Column("player_name", Text),
    Column("mode", Text),
    Column("log_data", Text),
    Column("summary", Text),
    Column("context", Text),
    Column("ended_by", Text),
    Column("ip_hash", Text),
    Column("created_at", Text),
    Column("updated_at", Text),
    Column("last_seq", Integer, nullable=False),
    Column("log_epoch", Text, nullable=False),
    Column("audit_last_seq", Integer, nullable=False),
    Column("audit_epoch", Text, nullable=False),
)

session_log_chunks = Table(
    "session_log_chunks",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("match_id", Text, nullable=False),
    Column("slot", Integer),
    Column("first_seq", Integer, nullable=False),
    Column("last_seq", Integer, nullable=False),
    Column("entries", Text, nullable=False),
    Column("size", Integer, nullable=False),
    Column("created_at", Text),
    Column("kind", Text, nullable=False),
)

screenshots = Table(
    "screenshots",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("match_id", Text, nullable=False),
    Column("slot", Integer, nullable=False),
    Column("frame", Integer, nullable=False),
    Column("data", LargeBinary),
    Column("blob_key", Text),
    Column("size", Integer),
    Column("created_at", Text),
)

match_metrics = Table(
    "match_metrics",
    metadata,
    Column("match_id", Text, primary_key=True),
    Column("mode", Text),
    Column("peer_count", Integer),
    Column("frames", Integer),
    Column("duration_sec", Float),
    Column("ended_by", Text),
    Column("mismatch_count", Integer),
    Column("first_divergence_frame", Integer),
    Column("last_clean_frame", Integer),
    Column("rollbacks", Integer),
    Column("predictions", Integer),
    Column("correct_predictions", Integer),
    Column("max_rollback_depth", Integer),
    Column("failed_rollbacks", Integer),
    Column("tolerance_hits", Integer),
    Column("pacing_throttle_count", Integer),
    Column("parquet_path", Text),
    Column("parquet_bytes", Integer),
    Column("entry_count", Integer),
    Column("rotated_at", Text),
    Column("created_at", Text),
)

desync_events = Table(
    "desync_events",
    metadata,
    Column("id", Integer, primary_key=True),
    Column("match_id", Text, nullable=False),
    Column("frame", Integer, nullable=False),
    Column("field", Text, nullable=False),
    Column("slot", Integer),
    Column("trigger", Text, nullable=False),
    Column("hashes_json", Text),
    Column("vision_verdict_json", Text),
    Column("vision_equal", Boolean),
    Column("vision_confidence", Text),
    Column("replay_meta_json", Text),
    Column("created_at", Text),
)

match_retention = Table(
    "match_retention",
    metadata,
    Column("match_id", Text, primary_key=True),
    Column("room", Text, nullable=False),
    Column("created_at", Text, nullable=False),
    Column("ended_at", Text),
    Column("tier", Text, nullable=False),
    Column("flag_reasons", Text, nullable=False),
    Column("auto_flag_capped", Integer, nullable=False),
    Column("resolved_at", Text),
    Column("resolved_note", Text),
    Column("last_touched_at", Text, nullable=False),
    Column("deleting_at", Text),
    Column("archived_at", Text),
    Column("archived_max_chunk_id", Integer),
    Column("archived_updated_at", Text),
    Column("archive_bytes", Integer),
    Column("evicted_at", Text),
)
