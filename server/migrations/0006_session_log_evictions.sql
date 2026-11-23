-- What a session log's size caps deleted (db._eviction_statements): one row
-- per (match_id, slot, kind), from the first time a cap deletes that
-- stream's oldest chunks, with how many entries are gone and the seq of the
-- last of them, in the epoch its chunk was sent in. The log's readers show
-- it as the log's first line, so a log whose oldest lines were deleted
-- doesn't read as one that started late (specs/session_log_store.qnt,
-- truncationIsVisible). Kept apart from the chunks, which a later cap could
-- delete. Retention deletes it with the match (retention._MATCH_TABLES).

CREATE TABLE IF NOT EXISTS session_log_evictions (
    id INTEGER PRIMARY KEY,
    match_id TEXT NOT NULL,
    slot INTEGER,
    kind TEXT NOT NULL,
    entries INTEGER NOT NULL DEFAULT 0,
    through_seq INTEGER NOT NULL DEFAULT -1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_session_log_evictions_match_slot ON session_log_evictions (match_id, slot, kind);
