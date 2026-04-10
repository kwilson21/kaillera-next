"""Add screenshot_comparisons table for automated SSIM desync detection.

Stores per-frame SSIM scores comparing slot 0 vs slot 1 screenshots.
Triggered server-side whenever both slots submit a screenshot for the same frame.

Revision ID: 0005
Revises: 0004
Create Date: 2026-04-10
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
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


def downgrade() -> None:
    op.drop_table("screenshot_comparisons")
