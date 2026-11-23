-- Small values the server keeps between restarts, by key. The first user is
-- the weekly orphan sweep (src/retention.py, sweep_orphans):
-- 'last_orphan_sweep' is when its last full pass over the blob store ended,
-- 'orphan_sweep_cursor' the match id a pass in progress resumes after.

CREATE TABLE IF NOT EXISTS server_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
