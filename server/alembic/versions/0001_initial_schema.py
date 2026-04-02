"""Initial schema — feedback and session_logs tables.

Revision ID: 0001
Revises:
Create Date: 2026-04-01
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "feedback",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("category", sa.Text, nullable=False),
        sa.Column("message", sa.Text, nullable=False),
        sa.Column("email", sa.Text),
        sa.Column("page", sa.Text),
        sa.Column("context", sa.Text),  # JSON stored as text
        sa.Column("ip_hash", sa.Text),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )
    op.create_table(
        "session_logs",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("room", sa.Text, nullable=False),
        sa.Column("slot", sa.Integer),
        sa.Column("player_name", sa.Text),
        sa.Column("mode", sa.Text),
        sa.Column("source", sa.Text),
        sa.Column("sync_log", sa.Text),
        sa.Column("context", sa.Text),  # JSON stored as text
        sa.Column("ip_hash", sa.Text),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )


def downgrade() -> None:
    op.drop_table("session_logs")
    op.drop_table("feedback")
