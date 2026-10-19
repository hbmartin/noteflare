ALTER TABLE deletion_jobs ADD COLUMN failure_code TEXT;
ALTER TABLE deletion_jobs ADD COLUMN blocked_at INTEGER;
ALTER TABLE deletion_jobs ADD COLUMN root_title TEXT;
UPDATE deletion_jobs SET root_title=(SELECT title FROM pages WHERE id=deletion_jobs.root_page_id AND workspace_id=deletion_jobs.workspace_id);
-- Historical parking did not distinguish causes. Require recheck without guessing.
UPDATE deletion_jobs SET failure_code='deletion_recheck_required',blocked_at=updated_at
 WHERE phase<>'staging' AND next_attempt_at=9007199254740991;
CREATE INDEX idx_deletion_jobs_workspace ON deletion_jobs(workspace_id,created_at DESC,id DESC) WHERE phase IN ('rows','cleanup');
-- The count guard must inspect index entries, not reparse retained JSON chunks.
CREATE INDEX idx_deletion_evidence_chunks ON deletion_targets(job_id,json_extract(target,'$.pageId'))
 WHERE kind='table_do' AND json_valid(target) AND json_extract(target,'$.stage')='evidence';
