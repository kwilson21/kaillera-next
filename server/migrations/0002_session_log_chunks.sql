-- Session log chunks: append-only delta storage for session logs (was
-- Alembic 0008). Clients flush only new entries by monotonic `seq`; the
-- server appends them as a chunk instead of rewriting session_logs.log_data.
-- See db.append_session_log for last_seq / log_epoch semantics.
--
-- Not re-runnable (ALTER TABLE ADD COLUMN): databases Alembic already took
-- to 0008 get this recorded as applied instead (migrate._ALEMBIC_EQUIVALENTS).

-- -1 means "no entries acked yet": client seqs start at 0.
ALTER TABLE session_logs ADD COLUMN last_seq INTEGER NOT NULL DEFAULT -1;

-- Identifies the client's in-memory ring; a new epoch resets dedupe.
ALTER TABLE session_logs ADD COLUMN log_epoch TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS session_log_chunks (
    id INTEGER PRIMARY KEY,
    match_id TEXT NOT NULL,
    slot INTEGER,
    first_seq INTEGER NOT NULL,
    last_seq INTEGER NOT NULL,
    entries TEXT NOT NULL,
    -- Byte length of entries at insert time, so the size cap needn't re-read them.
    size INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_session_log_chunks_match_slot ON session_log_chunks (match_id, slot, id);
