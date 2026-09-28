"""Session log chunks — append-only delta storage for session logs.

Every rollback client re-sent its ENTIRE sync log ring (up to 60,000
entries, ~3 MB after a couple of minutes) every 5s, and the server
rewrote the whole `session_logs.log_data` blob each time. That traffic
queued behind `end-game` on the same Socket.IO connection, delaying the
`game-ended` broadcast by several seconds in prod.

Clients now flush only new entries (by monotonic `seq`) each interval.
The server appends them as a chunk instead of rewriting the blob, and
tracks the highest stored `seq` per (match_id, slot) in a new
`last_seq` column so resends (and old cached clients still sending the
whole ring) are deduped for free.

`log_data` is kept as-is for old rows; a session's full entry list is
now legacy `log_data` (if any) plus its chunks in insertion order.

Revision ID: 0008
Revises: 0007
Create Date: 2026-09-27
"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # -1 means "no entries acked yet" — client seqs start at 0, so a default
    # of 0 would cause the very first entry (seq 0) to be deduped away by
    # append_session_log's `seq <= last_seq` check.
    with op.batch_alter_table("session_logs") as batch:
        batch.add_column(sa.Column("last_seq", sa.Integer, nullable=False, server_default="-1"))

    op.create_table(
        "session_log_chunks",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("match_id", sa.Text, nullable=False),
        sa.Column("slot", sa.Integer, nullable=True),
        sa.Column("first_seq", sa.Integer, nullable=False),
        sa.Column("last_seq", sa.Integer, nullable=False),
        sa.Column("entries", sa.Text, nullable=False),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )
    op.create_index(
        "idx_session_log_chunks_match_slot",
        "session_log_chunks",
        ["match_id", "slot", "id"],
    )


def downgrade() -> None:
    op.drop_index("idx_session_log_chunks_match_slot", table_name="session_log_chunks")
    op.drop_table("session_log_chunks")
    with op.batch_alter_table("session_logs") as batch:
        batch.drop_column("last_seq")
