-- Forward-only follow-up: builders must be paused while this migration is installed.
ALTER TABLE publications ADD COLUMN build_failure_checkpoint_json TEXT CHECK(build_failure_checkpoint_json IS NULL OR json_valid(build_failure_checkpoint_json));
-- Cleanup survives publication/page deletion: these are intents, deliberately without cascading FKs.
CREATE TABLE publication_table_snapshots (
 handle TEXT PRIMARY KEY, object_id TEXT NOT NULL, page_id TEXT NOT NULL,
 publication_id TEXT NOT NULL, generation INTEGER NOT NULL, access_generation INTEGER NOT NULL,
 created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX publication_table_snapshots_cleanup ON publication_table_snapshots(next_attempt_at,handle);
CREATE INDEX publication_table_snapshots_build ON publication_table_snapshots(publication_id,generation,access_generation);
-- Older continuations have no pinned source. Retire them once, preserving public manifests.
UPDATE publications SET generation=generation+1,build_checkpoint_json=NULL,build_content_version=NULL,
 build_error=NULL,build_failure_checkpoint_json=NULL
 WHERE active=1 AND needs_build=1 AND build_checkpoint_json IS NOT NULL;
DROP TRIGGER public_delivery_page_update;
CREATE TRIGGER public_delivery_page_update AFTER UPDATE OF position,title,icon,indexed_seq,full_width,cover_attachment_id,cover_x,cover_y,archived_at,parent_id,space_id,import_job_id ON pages WHEN OLD.position IS NOT NEW.position OR OLD.title IS NOT NEW.title OR OLD.icon IS NOT NEW.icon OR OLD.indexed_seq IS NOT NEW.indexed_seq OR OLD.full_width IS NOT NEW.full_width OR OLD.cover_attachment_id IS NOT NEW.cover_attachment_id OR OLD.cover_x IS NOT NEW.cover_x OR OLD.cover_y IS NOT NEW.cover_y OR OLD.archived_at IS NOT NEW.archived_at OR OLD.parent_id IS NOT NEW.parent_id OR OLD.space_id IS NOT NEW.space_id OR OLD.import_job_id IS NOT NEW.import_job_id BEGIN UPDATE share_links SET content_generation=content_generation+1 WHERE revoked_at IS NULL AND workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.id)
 AND (root_page_id=NEW.id OR (include_subpages=1 AND root_page_id IN(
 WITH RECURSIVE ancestry(id,parent_id,depth) AS (SELECT id,parent_id,0 FROM pages WHERE id=NEW.id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT id FROM ancestry))); END;
CREATE TRIGGER publications_authority_insert AFTER INSERT ON table_authority WHEN NEW.state='do' BEGIN
 UPDATE publications SET generation=generation+1,content_version=content_version+1,needs_build=1,
 build_checkpoint_json=NULL,build_content_version=NULL,build_error=NULL,build_failure_checkpoint_json=NULL,
 updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.page_id) AND (
 (dependencies_ready=0 AND space_id=(SELECT space_id FROM pages WHERE id=NEW.page_id)) OR
 EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind='page' AND d.target_id=NEW.page_id));
END;
CREATE TRIGGER publications_authority_cutover AFTER UPDATE OF state ON table_authority WHEN NEW.state='do' AND OLD.state IN('d1','seeding') BEGIN
 UPDATE publications SET generation=generation+1,content_version=content_version+1,needs_build=1,
 build_checkpoint_json=NULL,build_content_version=NULL,build_error=NULL,build_failure_checkpoint_json=NULL,
 updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.page_id) AND (
 (dependencies_ready=0 AND space_id=(SELECT space_id FROM pages WHERE id=NEW.page_id)) OR
 EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind='page' AND d.target_id=NEW.page_id));
END;
