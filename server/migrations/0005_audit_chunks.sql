-- Input audit as deltas (spec 2026-09-25 §8 item 3). Clients send only the
-- audit records the server hasn't acked; they are appended as
-- session_log_chunks rows with kind = 'audit' instead of riding in
-- session_logs.context, deduped by their own seq and epoch. See
-- db.append_session_flush.
--
-- Not re-runnable (ALTER TABLE ADD COLUMN).

ALTER TABLE session_log_chunks ADD COLUMN kind TEXT NOT NULL DEFAULT 'log';

-- -1 means "no audit records acked yet": client audit seqs start at 0.
ALTER TABLE session_logs ADD COLUMN audit_last_seq INTEGER NOT NULL DEFAULT -1;

-- Identifies the client's audit run; a new epoch resets dedupe.
ALTER TABLE session_logs ADD COLUMN audit_epoch TEXT NOT NULL DEFAULT '';
