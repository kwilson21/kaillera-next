-- Screenshot bytes move to the blob store (src/blobstore.py: Cloudflare R2
-- in production). Rows keep the object key and byte size; `data` stays,
-- now nullable, only for rows written before this migration.
--
-- SQLite can't drop NOT NULL in place, so the table is rebuilt. Not
-- re-runnable on its own: the runner records it in the same batch.

CREATE TABLE screenshots_new (
    id INTEGER PRIMARY KEY,
    match_id TEXT NOT NULL,
    slot INTEGER NOT NULL,
    frame INTEGER NOT NULL,
    data BLOB,
    blob_key TEXT,
    size INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO screenshots_new (id, match_id, slot, frame, data, size, created_at)
SELECT id, match_id, slot, frame, data, length(data), created_at FROM screenshots;

DROP TABLE screenshots;

ALTER TABLE screenshots_new RENAME TO screenshots;

CREATE INDEX IF NOT EXISTS idx_screenshots_match ON screenshots (match_id, slot, frame);
