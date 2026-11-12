"""The database tables, declared once for the query builder.

server/migrations/*.sql remain the source of truth for what exists in the
database; these models are what Python builds queries from.
tests/test_schema.py fails if the two disagree on a table or column.

SQLAlchemy is used only to build statements: src/db.py compiles them to
SQLite-dialect SQL and hands that to the backend (local SQLite or D1 over
HTTPS). Nothing here opens a connection, and no model is ever instantiated:
queries return plain dicts.
"""

from __future__ import annotations

from sqlalchemy import Boolean, Float, Integer, LargeBinary, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Feedback(Base):
    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    category: Mapped[str] = mapped_column(Text)
    message: Mapped[str] = mapped_column(Text)
    email: Mapped[str | None] = mapped_column(Text)
    page: Mapped[str | None] = mapped_column(Text)
    context: Mapped[str | None] = mapped_column(Text)
    ip_hash: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str | None] = mapped_column(Text)


class ClientEvent(Base):
    __tablename__ = "client_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    type: Mapped[str] = mapped_column(Text)
    message: Mapped[str | None] = mapped_column(Text)
    meta: Mapped[str | None] = mapped_column(Text)
    room: Mapped[str | None] = mapped_column(Text)
    slot: Mapped[int | None] = mapped_column(Integer)
    ip_hash: Mapped[str | None] = mapped_column(Text)
    user_agent: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str | None] = mapped_column(Text)


class SessionLog(Base):
    __tablename__ = "session_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    match_id: Mapped[str] = mapped_column(Text)
    room: Mapped[str] = mapped_column(Text)
    slot: Mapped[int | None] = mapped_column(Integer)
    player_name: Mapped[str | None] = mapped_column(Text)
    mode: Mapped[str | None] = mapped_column(Text)
    log_data: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
    context: Mapped[str | None] = mapped_column(Text)
    ended_by: Mapped[str | None] = mapped_column(Text)
    ip_hash: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[str | None] = mapped_column(Text)
    last_seq: Mapped[int] = mapped_column(Integer)
    log_epoch: Mapped[str] = mapped_column(Text)
    audit_last_seq: Mapped[int] = mapped_column(Integer)
    audit_epoch: Mapped[str] = mapped_column(Text)


class SessionLogChunk(Base):
    __tablename__ = "session_log_chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    match_id: Mapped[str] = mapped_column(Text)
    slot: Mapped[int | None] = mapped_column(Integer)
    first_seq: Mapped[int] = mapped_column(Integer)
    last_seq: Mapped[int] = mapped_column(Integer)
    entries: Mapped[str] = mapped_column(Text)
    size: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[str | None] = mapped_column(Text)
    kind: Mapped[str] = mapped_column(Text)


class Screenshot(Base):
    __tablename__ = "screenshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    match_id: Mapped[str] = mapped_column(Text)
    slot: Mapped[int] = mapped_column(Integer)
    frame: Mapped[int] = mapped_column(Integer)
    data: Mapped[bytes | None] = mapped_column(LargeBinary)
    blob_key: Mapped[str | None] = mapped_column(Text)
    size: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[str | None] = mapped_column(Text)


class MatchMetrics(Base):
    __tablename__ = "match_metrics"

    match_id: Mapped[str] = mapped_column(Text, primary_key=True)
    mode: Mapped[str | None] = mapped_column(Text)
    peer_count: Mapped[int | None] = mapped_column(Integer)
    frames: Mapped[int | None] = mapped_column(Integer)
    duration_sec: Mapped[float | None] = mapped_column(Float)
    ended_by: Mapped[str | None] = mapped_column(Text)
    mismatch_count: Mapped[int | None] = mapped_column(Integer)
    first_divergence_frame: Mapped[int | None] = mapped_column(Integer)
    last_clean_frame: Mapped[int | None] = mapped_column(Integer)
    rollbacks: Mapped[int | None] = mapped_column(Integer)
    predictions: Mapped[int | None] = mapped_column(Integer)
    correct_predictions: Mapped[int | None] = mapped_column(Integer)
    max_rollback_depth: Mapped[int | None] = mapped_column(Integer)
    failed_rollbacks: Mapped[int | None] = mapped_column(Integer)
    tolerance_hits: Mapped[int | None] = mapped_column(Integer)
    pacing_throttle_count: Mapped[int | None] = mapped_column(Integer)
    parquet_path: Mapped[str | None] = mapped_column(Text)
    parquet_bytes: Mapped[int | None] = mapped_column(Integer)
    entry_count: Mapped[int | None] = mapped_column(Integer)
    rotated_at: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str | None] = mapped_column(Text)


class DesyncEvent(Base):
    __tablename__ = "desync_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    match_id: Mapped[str] = mapped_column(Text)
    frame: Mapped[int] = mapped_column(Integer)
    field: Mapped[str] = mapped_column(Text)
    slot: Mapped[int | None] = mapped_column(Integer)
    trigger: Mapped[str] = mapped_column(Text)
    hashes_json: Mapped[str | None] = mapped_column(Text)
    vision_verdict_json: Mapped[str | None] = mapped_column(Text)
    vision_equal: Mapped[bool | None] = mapped_column(Boolean)
    vision_confidence: Mapped[str | None] = mapped_column(Text)
    replay_meta_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[str | None] = mapped_column(Text)


class MatchRetention(Base):
    __tablename__ = "match_retention"

    match_id: Mapped[str] = mapped_column(Text, primary_key=True)
    room: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(Text)
    ended_at: Mapped[str | None] = mapped_column(Text)
    tier: Mapped[str] = mapped_column(Text)
    flag_reasons: Mapped[str] = mapped_column(Text)
    auto_flag_capped: Mapped[int] = mapped_column(Integer)
    resolved_at: Mapped[str | None] = mapped_column(Text)
    resolved_note: Mapped[str | None] = mapped_column(Text)
    last_touched_at: Mapped[str] = mapped_column(Text)
    deleting_at: Mapped[str | None] = mapped_column(Text)
    archived_at: Mapped[str | None] = mapped_column(Text)
    archived_max_chunk_id: Mapped[int | None] = mapped_column(Integer)
    archived_updated_at: Mapped[str | None] = mapped_column(Text)
    archive_bytes: Mapped[int | None] = mapped_column(Integer)
    evicted_at: Mapped[str | None] = mapped_column(Text)
