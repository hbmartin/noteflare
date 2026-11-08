-- Apply before the compatible builder. Healthy captures and active manifests remain intact.
ALTER TABLE publications ADD COLUMN build_failure_json TEXT CHECK(build_failure_json IS NULL OR json_valid(build_failure_json));
ALTER TABLE publication_table_snapshots ADD COLUMN cleanup_attempts INTEGER NOT NULL DEFAULT 0;
DROP TRIGGER publications_page_content;
CREATE TRIGGER publications_page_content AFTER UPDATE OF position,title,icon,cover_attachment_id,cover_x,cover_y,indexed_seq,full_width ON pages WHEN OLD.position IS NOT NEW.position OR OLD.title IS NOT NEW.title OR OLD.icon IS NOT NEW.icon OR OLD.cover_attachment_id IS NOT NEW.cover_attachment_id OR OLD.cover_x IS NOT NEW.cover_x OR OLD.cover_y IS NOT NEW.cover_y OR OLD.indexed_seq IS NOT NEW.indexed_seq OR OLD.full_width IS NOT NEW.full_width BEGIN
 UPDATE publications SET generation=generation+CASE WHEN needs_build=0 THEN 1 ELSE 0 END,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.id) AND ((dependencies_ready=0 AND space_id=(SELECT space_id FROM pages WHERE id=NEW.id)) OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('page','ancestor') AND d.target_id=NEW.id) OR EXISTS(WITH RECURSIVE ancestry(id,parent_id,depth) AS (
 SELECT id,parent_id,0 FROM pages WHERE id=NEW.id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT 1 FROM ancestry a JOIN publication_roots r ON r.page_id=a.id WHERE r.publication_id=publications.id));
END;

-- Failure state belongs to the old build identity, including access-trigger resets.
CREATE TRIGGER publications_failure_reset AFTER UPDATE OF generation,active,build_checkpoint_json ON publications
WHEN OLD.generation<>NEW.generation OR NEW.active=0 OR (OLD.build_checkpoint_json IS NOT NULL AND NEW.build_checkpoint_json IS NULL)
BEGIN UPDATE publications SET build_error=NULL,build_failure_checkpoint_json=NULL,build_failure_json=NULL WHERE id=NEW.id; END;
-- Durable intent commits atomically with every new build, including trigger-created generations.
CREATE TRIGGER publications_job_insert AFTER INSERT ON publications WHEN NEW.active=1 AND NEW.needs_build=1 BEGIN

 INSERT INTO platform_jobs(id,workspace_id,kind,job_key,generation,payload_json,available_at,created_at,updated_at)
 VALUES(json_array(NEW.workspace_id,'publication',NEW.id),NEW.workspace_id,'publication',NEW.id,CAST(NEW.generation AS TEXT),
 json_object('publicationId',NEW.id,'generation',NEW.generation),unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(workspace_id,kind,job_key) DO UPDATE SET generation=excluded.generation,payload_json=excluded.payload_json,
 available_at=excluded.available_at,attempts=0,last_error=NULL,updated_at=excluded.updated_at,
 lease_token=CASE WHEN platform_jobs.lease_until>excluded.updated_at THEN platform_jobs.lease_token ELSE NULL END,
 lease_until=CASE WHEN platform_jobs.lease_until>excluded.updated_at THEN platform_jobs.lease_until ELSE NULL END
 WHERE platform_jobs.generation<>excluded.generation;
END;
CREATE TRIGGER publications_job_update AFTER UPDATE OF generation,active,needs_build ON publications
WHEN NEW.active=1 AND NEW.needs_build=1 AND (OLD.generation<>NEW.generation OR OLD.active=0 OR OLD.needs_build=0) BEGIN

 INSERT INTO platform_jobs(id,workspace_id,kind,job_key,generation,payload_json,available_at,created_at,updated_at)
 VALUES(json_array(NEW.workspace_id,'publication',NEW.id),NEW.workspace_id,'publication',NEW.id,CAST(NEW.generation AS TEXT),
 json_object('publicationId',NEW.id,'generation',NEW.generation),unixepoch()*1000,unixepoch()*1000,unixepoch()*1000)
 ON CONFLICT(workspace_id,kind,job_key) DO UPDATE SET generation=excluded.generation,payload_json=excluded.payload_json,
 available_at=excluded.available_at,attempts=0,last_error=NULL,updated_at=excluded.updated_at,
 lease_token=CASE WHEN platform_jobs.lease_until>excluded.updated_at THEN platform_jobs.lease_token ELSE NULL END,
 lease_until=CASE WHEN platform_jobs.lease_until>excluded.updated_at THEN platform_jobs.lease_until ELSE NULL END
 WHERE platform_jobs.generation<>excluded.generation;
END;
CREATE INDEX platform_jobs_publication ON platform_jobs(kind,generation,json_extract(payload_json,'$.publicationId'));
