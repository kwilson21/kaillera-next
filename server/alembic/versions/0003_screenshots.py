"""Add screenshots table for gameplay capture.

Revision ID: 0003
Revises: 0002
Create Date: 2026-04-03
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "screenshots",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("match_id", sa.Text, nullable=False),
        sa.Column("slot", sa.Integer, nullable=False),
        sa.Column("frame", sa.Integer, nullable=False),
        sa.Column("data", sa.LargeBinary, nullable=False),  # JPEG bytes
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )
    op.create_index("idx_screenshots_match", "screenshots", ["match_id", "slot", "frame"])


def downgrade() -> None:
    op.drop_table("screenshots")
