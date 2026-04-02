"""Session logging schema — recreate session_logs with structured JSON, add client_events.

Revision ID: 0002
Revises: 0001
Create Date: 2026-04-01
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_table("session_logs")
    op.create_table(
        "session_logs",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("match_id", sa.Text, nullable=False),
        sa.Column("room", sa.Text, nullable=False),
        sa.Column("slot", sa.Integer),
        sa.Column("player_name", sa.Text),
        sa.Column("mode", sa.Text),
        sa.Column("log_data", sa.Text),
        sa.Column("summary", sa.Text),
        sa.Column("context", sa.Text),
        sa.Column("ended_by", sa.Text),
        sa.Column("ip_hash", sa.Text),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
        sa.Column("updated_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )
    op.create_index("idx_session_logs_game_slot", "session_logs", ["match_id", "slot"], unique=True)
    op.create_table(
        "client_events",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("type", sa.Text, nullable=False),
        sa.Column("message", sa.Text),
        sa.Column("meta", sa.Text),
        sa.Column("room", sa.Text),
        sa.Column("slot", sa.Integer),
        sa.Column("ip_hash", sa.Text),
        sa.Column("user_agent", sa.Text),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )


def downgrade() -> None:
    op.drop_table("client_events")
    op.drop_index("idx_session_logs_game_slot", "session_logs")
    op.drop_table("session_logs")
    op.create_table(
        "session_logs",
        sa.Column("id", sa.Integer, primary_key=True, autoincrement=True),
        sa.Column("room", sa.Text, nullable=False),
        sa.Column("slot", sa.Integer),
        sa.Column("player_name", sa.Text),
        sa.Column("mode", sa.Text),
        sa.Column("source", sa.Text),
        sa.Column("sync_log", sa.Text),
        sa.Column("context", sa.Text),
        sa.Column("ip_hash", sa.Text),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )
