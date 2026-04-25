"""desync_events: vision-validated desync verdicts.

Persists every Claude vision verdict triggered by the desync detector,
indexed by (match_id, frame) for post-mortem and admin timeline queries.

Revision ID: 0006
Revises: 0005
Create Date: 2026-04-25
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "desync_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("match_id", sa.Text, nullable=False),
        sa.Column("frame", sa.Integer, nullable=False),
        sa.Column("field", sa.Text, nullable=False),
        sa.Column("slot", sa.Integer, nullable=True),
        sa.Column("trigger", sa.Text, nullable=False),
        sa.Column("hashes_json", sa.Text, nullable=True),
        sa.Column("vision_verdict_json", sa.Text, nullable=True),
        sa.Column("vision_equal", sa.Boolean, nullable=True),
        sa.Column("vision_confidence", sa.Text, nullable=True),
        sa.Column("replay_meta_json", sa.Text, nullable=True),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )
    op.create_index(
        "idx_desync_events_match_frame",
        "desync_events",
        ["match_id", "frame"],
    )


def downgrade() -> None:
    op.drop_index("idx_desync_events_match_frame", table_name="desync_events")
    op.drop_table("desync_events")
