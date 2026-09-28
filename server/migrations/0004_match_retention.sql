-- One row per match, created at start-game (db.register_match). The HTTP
-- log-upload fallback checks it now; the retention, archive and eviction
-- columns are filled by later work (spec §1 "Archive and eviction", §2).
-- All spec columns are created here so the table isn't altered later.

CREATE TABLE IF NOT EXISTS match_retention (
    match_id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    tier TEXT NOT NULL DEFAULT 'normal',
    flag_reasons TEXT NOT NULL DEFAULT '[]',
    auto_flag_capped INTEGER NOT NULL DEFAULT 0,
    resolved_at TEXT,
    resolved_note TEXT,
    last_touched_at TEXT NOT NULL DEFAULT (datetime('now')),
    deleting_at TEXT,
    archived_at TEXT,
    archived_max_chunk_id INTEGER,
    archived_updated_at TEXT,
    archive_bytes INTEGER,
    evicted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_match_retention_created_at ON match_retention (created_at);
