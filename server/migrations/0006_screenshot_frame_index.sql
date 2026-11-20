-- Seek within a match by frame for bounded admin comparison windows.
CREATE INDEX IF NOT EXISTS idx_screenshots_match_frame ON screenshots (match_id, frame);
