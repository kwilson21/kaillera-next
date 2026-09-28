"""Tests for the plain-SQL migration runner and the baseline schema.

Run: cd server && uv run --extra dev pytest ../tests/test_migrate.py -q
"""

import sqlite3

import pytest
from db_test_support import make_backend, run_async


@pytest.fixture(autouse=True, scope="session")
def _patch_browser_ssl():
    """No browser needed (overrides the Playwright fixture in conftest.py)."""
    yield


# ── split_statements ─────────────────────────────────────────────────────────


def test_split_statements_skips_comments_and_blank_lines():
    from src.migrate import split_statements

    sql = "-- header\n\nCREATE TABLE a (x INTEGER);\n-- between\nCREATE INDEX i ON a (x);\n"
    assert split_statements(sql) == ["CREATE TABLE a (x INTEGER);", "CREATE INDEX i ON a (x);"]


def test_split_statements_handles_multiline_statement():
    from src.migrate import split_statements

    sql = "CREATE TABLE a (\n  x INTEGER,\n  y TEXT\n);\n"
    assert split_statements(sql) == ["CREATE TABLE a (\n  x INTEGER,\n  y TEXT\n);"]


def test_split_statements_keeps_semicolon_inside_string():
    from src.migrate import split_statements

    sql = "INSERT INTO a (y) VALUES ('one;\ntwo');\nSELECT 1;\n"
    assert split_statements(sql) == ["INSERT INTO a (y) VALUES ('one;\ntwo');", "SELECT 1;"]


def test_split_statements_rejects_incomplete_statement():
    from src.migrate import split_statements

    with pytest.raises(ValueError, match="Incomplete"):
        split_statements("CREATE TABLE a (x INTEGER)\n")


# ── load_migrations ──────────────────────────────────────────────────────────


def test_load_migrations_orders_by_version(tmp_path):
    from src.migrate import load_migrations

    (tmp_path / "0002_second.sql").write_text("CREATE TABLE b (x INTEGER);\n")
    (tmp_path / "0001_first.sql").write_text("CREATE TABLE a (x INTEGER);\n")
    assert [(m.version, m.name) for m in load_migrations(tmp_path)] == [("0001", "first"), ("0002", "second")]


def test_load_migrations_rejects_bad_filename(tmp_path):
    from src.migrate import load_migrations

    (tmp_path / "1_bad.sql").write_text("SELECT 1;\n")
    with pytest.raises(ValueError, match="Bad migration filename"):
        load_migrations(tmp_path)


def test_load_migrations_rejects_duplicate_version(tmp_path):
    from src.migrate import load_migrations

    (tmp_path / "0001_a.sql").write_text("SELECT 1;\n")
    (tmp_path / "0001_b.sql").write_text("SELECT 1;\n")
    with pytest.raises(ValueError, match="Duplicate migration version"):
        load_migrations(tmp_path)


# ── apply_migrations ─────────────────────────────────────────────────────────


def test_apply_migrations_applies_pending_once(tmp_path):
    from src.migrate import apply_migrations

    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "0001_first.sql").write_text("CREATE TABLE a (x INTEGER);\n")
    (migrations / "0002_second.sql").write_text("CREATE TABLE b (x INTEGER);\n")
    backend = make_backend("sqlite", tmp_path)

    async def scenario():
        await backend.open()
        try:
            first = await apply_migrations(backend, migrations)
            second = await apply_migrations(backend, migrations)
            recorded = await backend.query("SELECT version, name FROM schema_migrations ORDER BY version", ())
            return first, second, recorded
        finally:
            await backend.close()

    first, second, recorded = run_async(scenario())
    assert first == ["0001", "0002"]
    assert second == []
    assert recorded == [{"version": "0001", "name": "first"}, {"version": "0002", "name": "second"}]


def test_apply_one_is_safe_to_repeat(tmp_path):
    """Two instances starting at once may both apply the baseline."""
    from src.migrate import apply_migrations, apply_one, load_migrations

    backend = make_backend("sqlite", tmp_path)
    baseline = load_migrations()[0]

    async def scenario():
        await backend.open()
        try:
            await apply_migrations(backend)
            await apply_one(backend, baseline)
            return await backend.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE version = '0001'", ())
        finally:
            await backend.close()

    assert run_async(scenario()) == [{"n": 1}]


# ── Baseline schema ──────────────────────────────────────────────────────────

# fmt: off
EXPECTED_COLUMNS = {
    "feedback": ["id", "category", "message", "email", "page", "context", "ip_hash", "created_at"],
    "session_logs": [
        "id", "match_id", "room", "slot", "player_name", "mode", "log_data", "summary",
        "context", "ended_by", "ip_hash", "created_at", "updated_at",
    ],
    "client_events": ["id", "type", "message", "meta", "room", "slot", "ip_hash", "user_agent", "created_at"],
    "screenshots": ["id", "match_id", "slot", "frame", "data", "created_at"],
    "match_metrics": [
        "match_id", "mode", "peer_count", "frames", "duration_sec", "ended_by", "mismatch_count",
        "first_divergence_frame", "last_clean_frame", "rollbacks", "predictions", "correct_predictions",
        "max_rollback_depth", "failed_rollbacks", "tolerance_hits", "pacing_throttle_count",
        "parquet_path", "parquet_bytes", "entry_count", "rotated_at", "created_at",
    ],
    "desync_events": [
        "id", "match_id", "frame", "field", "slot", "trigger", "hashes_json", "vision_verdict_json",
        "vision_equal", "vision_confidence", "replay_meta_json", "created_at",
    ],
}
# fmt: on

EXPECTED_INDEXES = {
    "idx_session_logs_game_slot": ("session_logs", 1),
    "idx_screenshots_match": ("screenshots", 0),
    "idx_match_metrics_created_at": ("match_metrics", 0),
    "idx_desync_events_match_frame": ("desync_events", 0),
}


def test_baseline_creates_expected_schema(tmp_path):
    from src.migrate import apply_migrations

    backend = make_backend("sqlite", tmp_path)

    async def scenario():
        await backend.open()
        try:
            await apply_migrations(backend)
        finally:
            await backend.close()

    run_async(scenario())
    conn = sqlite3.connect(backend.path)
    try:
        for table, columns in EXPECTED_COLUMNS.items():
            actual = [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]
            assert actual == columns, table
        for index, (table, unique) in EXPECTED_INDEXES.items():
            listed = {row[1]: row[2] for row in conn.execute(f"PRAGMA index_list({table})")}
            assert listed.get(index) == unique, index
    finally:
        conn.close()


def test_baseline_upgrades_existing_alembic_database(tmp_path):
    """A database created by the old Alembic migrations keeps its data."""
    from src.migrate import apply_migrations

    backend = make_backend("sqlite", tmp_path)
    conn = sqlite3.connect(backend.path)
    conn.executescript(
        """
        CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL, PRIMARY KEY (version_num));
        INSERT INTO alembic_version VALUES ('0007');
        CREATE TABLE feedback (
            id INTEGER NOT NULL, category TEXT NOT NULL, message TEXT NOT NULL, email TEXT, page TEXT,
            context TEXT, ip_hash TEXT, created_at TEXT DEFAULT (datetime('now')), PRIMARY KEY (id)
        );
        INSERT INTO feedback (category, message) VALUES ('bug', 'kept');
        """
    )
    conn.commit()
    conn.close()

    async def scenario():
        await backend.open()
        try:
            applied = await apply_migrations(backend)
            feedback = await backend.query("SELECT message FROM feedback", ())
            leftover = await backend.query(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alembic_version'", ()
            )
            return applied, feedback, leftover
        finally:
            await backend.close()

    applied, feedback, leftover = run_async(scenario())
    assert applied == ["0001"]
    assert feedback == [{"message": "kept"}]
    assert leftover == []
