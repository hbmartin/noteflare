ALTER TABLE realtime_revocations ADD COLUMN last_attempted_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX realtime_revocations_attempts ON realtime_revocations(last_attempted_at,workspace_id) WHERE revision>completed_revision;
