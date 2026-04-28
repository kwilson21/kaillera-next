"""Drop screenshot_comparisons table.

The SSIM-based visual desync detector was unreliable as a cross-peer
divergence signal (see memory/feedback_ssim_useless_use_vision.md and
the prod log noise on near-identical frames flagged as 'desync' below
the 0.95 threshold). It has been superseded by the vision-based
pipeline: KNDesync flags suspect frames from RDRAM hash diffs, then
Claude vision produces a structured verdict in `desync_events`.

Revision ID: 0007
Revises: 0006
Create Date: 2026-04-27
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Indices are dropped automatically with the table in SQLite, but be
    # explicit for engines that don't (and so downgrade is symmetric).
    with op.batch_alter_table("screenshot_comparisons") as batch:
        batch.drop_index("idx_sc_desync")
        batch.drop_index("idx_sc_match_frame")
    op.drop_table("screenshot_comparisons")


def downgrade() -> None:
    op.create_table(
        "screenshot_comparisons",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("match_id", sa.Text, nullable=False),
        sa.Column("frame", sa.Integer, nullable=False),
        sa.Column("slot_a", sa.Integer, nullable=False),
        sa.Column("slot_b", sa.Integer, nullable=False),
        sa.Column("ssim", sa.Float, nullable=False),
        sa.Column("is_desync", sa.Boolean, nullable=False),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )
    op.create_index(
        "idx_sc_match_frame",
        "screenshot_comparisons",
        ["match_id", "frame"],
        unique=True,
    )
    op.create_index(
        "idx_sc_desync",
        "screenshot_comparisons",
        ["match_id", "is_desync"],
    )
