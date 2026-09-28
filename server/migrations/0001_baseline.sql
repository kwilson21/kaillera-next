-- Baseline: the schema Alembic migrations 0001-0007 produced.
-- Re-runnable: applies cleanly over an existing Alembic-created database.

CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    email TEXT,
    page TEXT,
    context TEXT,
    ip_hash TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_logs (
    id INTEGER PRIMARY KEY,
    match_id TEXT NOT NULL,
    room TEXT NOT NULL,
    slot INTEGER,
    player_name TEXT,
    mode TEXT,
    log_data TEXT,
    summary TEXT,
    context TEXT,
    ended_by TEXT,
    ip_hash TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_logs_game_slot ON session_logs (match_id, slot);

CREATE TABLE IF NOT EXISTS client_events (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    message TEXT,
    meta TEXT,
    room TEXT,
    slot INTEGER,
    ip_hash TEXT,
    user_agent TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS screenshots (
    id INTEGER PRIMARY KEY,
    match_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    frame INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_screenshots_match ON screenshots (match_id, slot, frame);

CREATE TABLE IF NOT EXISTS match_metrics (
    match_id TEXT PRIMARY KEY,
    mode TEXT,
    peer_count INTEGER,
    frames INTEGER,
    duration_sec FLOAT,
    ended_by TEXT,
    mismatch_count INTEGER,
    first_divergence_frame INTEGER,
    last_clean_frame INTEGER,
    rollbacks INTEGER,
    predictions INTEGER,
    correct_predictions INTEGER,
    max_rollback_depth INTEGER,
    failed_rollbacks INTEGER,
    tolerance_hits INTEGER,
    pacing_throttle_count INTEGER,
    parquet_path TEXT,
    parquet_bytes INTEGER,
    entry_count INTEGER,
    rotated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_match_metrics_created_at ON match_metrics (created_at DESC);

CREATE TABLE IF NOT EXISTS desync_events (
    id INTEGER PRIMARY KEY,
    match_id TEXT NOT NULL,
    frame INTEGER NOT NULL,
    field TEXT NOT NULL,
    slot INTEGER,
    "trigger" TEXT NOT NULL,
    hashes_json TEXT,
    vision_verdict_json TEXT,
    vision_equal BOOLEAN,
    vision_confidence TEXT,
    replay_meta_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_desync_events_match_frame ON desync_events (match_id, frame);

DROP TABLE IF EXISTS alembic_version;
