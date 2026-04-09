"""Match metrics + parquet rotation bookkeeping.

One row per finished match with precomputed aggregate stats (pulled from
session_logs.log_data + summary by src/match_rotation.py). Makes admin
listings and analyze_match.py summaries a cheap SELECT instead of a
re-parse of the JSON blob every time.

Revision ID: 0004
Revises: 0003
Create Date: 2026-04-08
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "match_metrics",
        sa.Column("match_id", sa.Text, primary_key=True),
        sa.Column("mode", sa.Text),
        sa.Column("peer_count", sa.Integer),
        sa.Column("frames", sa.Integer),
        sa.Column("duration_sec", sa.Float),
        sa.Column("ended_by", sa.Text),
        # Determinism
        sa.Column("mismatch_count", sa.Integer),
        sa.Column("first_divergence_frame", sa.Integer),
        sa.Column("last_clean_frame", sa.Integer),
        # Rollback (summed across peers)
        sa.Column("rollbacks", sa.Integer),
        sa.Column("predictions", sa.Integer),
        sa.Column("correct_predictions", sa.Integer),
        sa.Column("max_rollback_depth", sa.Integer),
        sa.Column("failed_rollbacks", sa.Integer),
        sa.Column("tolerance_hits", sa.Integer),
        # Pacing
        sa.Column("pacing_throttle_count", sa.Integer),
        # Parquet file on disk (relative to DB_PATH parent or absolute)
        sa.Column("parquet_path", sa.Text),
        sa.Column("parquet_bytes", sa.Integer),
        sa.Column("entry_count", sa.Integer),
        sa.Column("rotated_at", sa.Text, server_default=sa.text("(datetime('now'))")),
        sa.Column("created_at", sa.Text, server_default=sa.text("(datetime('now'))")),
    )
    op.create_index(
        "idx_match_metrics_created_at",
        "match_metrics",
        [sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("idx_match_metrics_created_at", "match_metrics")
    op.drop_table("match_metrics")
