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

`log_epoch` (added on `session_logs`) carries a random string the client
generates when its in-memory ring is created (and regenerates on
clear()). A page reload, a fresh reconnect tab, or a spectator claiming
a slot a previous player already used all restart the client's `seq`
counter at 0 while the server's `last_seq` for that (match_id, slot) is
already high — without `log_epoch`, every entry from the new ring would
look like a dedup of an old one and get silently dropped. When the
incoming epoch differs from the stored one, the server treats
`last_seq` as -1 for that flush and adopts the new epoch.

`session_log_chunks.size` records each chunk's JSON byte length at
insert time, so enforcing the per-(match_id, slot) size cap doesn't
need to re-read `length(entries)` for every stored chunk on every
flush.

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
        # Empty string, not NULL, so a plain `= excluded.log_epoch` comparison
        # in the upsert never has to special-case NULL != NULL.
        batch.add_column(sa.Column("log_epoch", sa.Text, nullable=False, server_default=""))

    op.create_table(
        "session_log_chunks",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("match_id", sa.Text, nullable=False),
        sa.Column("slot", sa.Integer, nullable=True),
        sa.Column("first_seq", sa.Integer, nullable=False),
        sa.Column("last_seq", sa.Integer, nullable=False),
        sa.Column("entries", sa.Text, nullable=False),
        # Byte length of `entries`, recorded at insert time — see module
        # docstring. Defaults to 0 for any row inserted without it, which the
        # cap-enforcement query treats as "unknown, don't count against
        # size" rather than crashing.
        sa.Column("size", sa.Integer, nullable=False, server_default="0"),
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
        batch.drop_column("log_epoch")
