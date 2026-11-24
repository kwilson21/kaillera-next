-- The token an archive attempt's object keys carry (src/log_archive.py):
-- matches/<id>/sessions/<archive_token>/<slot>.*.gz. Recorded with
-- archived_at, so readers name the objects of the attempt that was recorded.
-- Two servers can archive one match at once during a deploy; with keys of
-- their own, the attempt refused can take back what it uploaded without
-- touching the recorded one's (specs/log_archive.qnt, log_archive_key_by_through).
--
-- Not re-runnable (ALTER TABLE ADD COLUMN); migrate.py applies it once.

ALTER TABLE match_retention ADD COLUMN archive_token TEXT;
