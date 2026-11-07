-- Forward-only repair for already-applied platform migrations.
ALTER TABLE publications ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE publications ADD COLUMN built_content_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publications ADD COLUMN build_content_version INTEGER;
ALTER TABLE publications ADD COLUMN build_checkpoint_json TEXT CHECK(build_checkpoint_json IS NULL OR json_valid(build_checkpoint_json));
ALTER TABLE publications ADD COLUMN dependencies_ready INTEGER NOT NULL DEFAULT 0;
ALTER TABLE share_links ADD COLUMN content_generation INTEGER NOT NULL DEFAULT 1;
CREATE TABLE publication_dependencies (
 publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN('page','ancestor','attachment','view')),
 target_id TEXT NOT NULL,PRIMARY KEY(publication_id,generation,kind,target_id)
);
CREATE INDEX publication_dependencies_target ON publication_dependencies(kind,target_id,publication_id,generation);
DROP TRIGGER publications_page_access;
DROP TRIGGER publications_page_delete;
DROP TRIGGER publications_page_content;
DROP TRIGGER publications_page_create;
DROP TRIGGER publications_table_content;
DROP TRIGGER publications_attachment_delete;
DROP TRIGGER public_delivery_page_update;
DROP TRIGGER public_delivery_page_insert;
DROP TRIGGER public_delivery_page_delete;
DROP TRIGGER public_delivery_attachment_delete;
DROP TRIGGER public_delivery_table;
DROP TRIGGER publications_reference_delete;
DROP TRIGGER publications_source_delete;
DROP TRIGGER publications_view_change;
DROP TRIGGER publications_view_delete;
DROP TRIGGER publications_column_delete;
DROP TRIGGER publications_row_delete;
DROP TRIGGER public_cache_content;
DROP TRIGGER public_cache_publication;
CREATE TRIGGER publications_page_access AFTER UPDATE OF archived_at,parent_id,space_id,import_job_id,is_template ON pages WHEN OLD.archived_at IS NOT NEW.archived_at OR OLD.parent_id IS NOT NEW.parent_id OR OLD.space_id IS NOT NEW.space_id OR OLD.import_job_id IS NOT NEW.import_job_id OR OLD.is_template IS NOT NEW.is_template BEGIN
 UPDATE publications SET generation=generation+1,access_generation=access_generation+1,build_checkpoint_json=NULL,build_content_version=NULL,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.id) AND (dependencies_ready=0 OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('page','ancestor') AND d.target_id=NEW.id) OR EXISTS(WITH RECURSIVE ancestry(id,parent_id,depth) AS (
 SELECT id,parent_id,0 FROM pages WHERE id=NEW.id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT 1 FROM ancestry a JOIN publication_roots r ON r.page_id=a.id WHERE r.publication_id=publications.id));
END;
CREATE TRIGGER publications_page_delete BEFORE DELETE ON pages  BEGIN
 UPDATE publications SET generation=generation+1,access_generation=access_generation+1,build_checkpoint_json=NULL,build_content_version=NULL,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=OLD.id) AND (dependencies_ready=0 OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('page','ancestor') AND d.target_id=OLD.id) OR EXISTS(WITH RECURSIVE ancestry(id,parent_id,depth) AS (
 SELECT id,parent_id,0 FROM pages WHERE id=OLD.id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT 1 FROM ancestry a JOIN publication_roots r ON r.page_id=a.id WHERE r.publication_id=publications.id));
END;
CREATE TRIGGER publications_page_content AFTER UPDATE OF title,icon,cover_attachment_id,cover_x,cover_y,indexed_seq,full_width ON pages WHEN OLD.title IS NOT NEW.title OR OLD.icon IS NOT NEW.icon OR OLD.cover_attachment_id IS NOT NEW.cover_attachment_id OR OLD.cover_x IS NOT NEW.cover_x OR OLD.cover_y IS NOT NEW.cover_y OR OLD.indexed_seq IS NOT NEW.indexed_seq OR OLD.full_width IS NOT NEW.full_width BEGIN
 UPDATE publications SET generation=generation+CASE WHEN needs_build=0 THEN 1 ELSE 0 END,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.id) AND ((dependencies_ready=0 AND space_id=(SELECT space_id FROM pages WHERE id=NEW.id)) OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('page','ancestor') AND d.target_id=NEW.id) OR EXISTS(WITH RECURSIVE ancestry(id,parent_id,depth) AS (
 SELECT id,parent_id,0 FROM pages WHERE id=NEW.id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT 1 FROM ancestry a JOIN publication_roots r ON r.page_id=a.id WHERE r.publication_id=publications.id));
END;
CREATE TRIGGER publications_page_create AFTER INSERT ON pages  BEGIN
 UPDATE publications SET generation=generation+CASE WHEN needs_build=0 THEN 1 ELSE 0 END,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.id) AND ((dependencies_ready=0 AND space_id=(SELECT space_id FROM pages WHERE id=NEW.id)) OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('page','ancestor') AND d.target_id=NEW.id) OR EXISTS(WITH RECURSIVE ancestry(id,parent_id,depth) AS (
 SELECT id,parent_id,0 FROM pages WHERE id=NEW.id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT 1 FROM ancestry a JOIN publication_roots r ON r.page_id=a.id WHERE r.publication_id=publications.id));
END;
CREATE TRIGGER publications_table_content AFTER UPDATE OF revision ON table_state WHEN OLD.revision<>NEW.revision BEGIN
 UPDATE publications SET generation=generation+CASE WHEN needs_build=0 THEN 1 ELSE 0 END,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.page_id) AND ((dependencies_ready=0 AND space_id=(SELECT space_id FROM pages WHERE id=NEW.page_id)) OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('page','ancestor') AND d.target_id=NEW.page_id) OR EXISTS(WITH RECURSIVE ancestry(id,parent_id,depth) AS (
 SELECT id,parent_id,0 FROM pages WHERE id=NEW.page_id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT 1 FROM ancestry a JOIN publication_roots r ON r.page_id=a.id WHERE r.publication_id=publications.id));
END;
CREATE TRIGGER publications_attachment_delete BEFORE DELETE ON attachments  BEGIN
 UPDATE publications SET generation=generation+1,access_generation=access_generation+1,build_checkpoint_json=NULL,build_content_version=NULL,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=OLD.workspace_id AND (dependencies_ready=0 OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('attachment') AND d.target_id=OLD.id));
END;
CREATE TRIGGER publications_reference_delete BEFORE DELETE ON transclusion_references  BEGIN
 UPDATE publications SET generation=generation+1,access_generation=access_generation+1,build_checkpoint_json=NULL,build_content_version=NULL,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=OLD.reference_page_id) AND (dependencies_ready=0 OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('page','ancestor') AND d.target_id=OLD.reference_page_id) OR EXISTS(WITH RECURSIVE ancestry(id,parent_id,depth) AS (
 SELECT id,parent_id,0 FROM pages WHERE id=OLD.reference_page_id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT 1 FROM ancestry a JOIN publication_roots r ON r.page_id=a.id WHERE r.publication_id=publications.id));
END;
CREATE TRIGGER publications_source_delete BEFORE DELETE ON transclusion_sources  BEGIN
 UPDATE publications SET generation=generation+1,access_generation=access_generation+1,build_checkpoint_json=NULL,build_content_version=NULL,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=OLD.page_id) AND (dependencies_ready=0 OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('page','ancestor') AND d.target_id=OLD.page_id) OR EXISTS(WITH RECURSIVE ancestry(id,parent_id,depth) AS (
 SELECT id,parent_id,0 FROM pages WHERE id=OLD.page_id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT 1 FROM ancestry a JOIN publication_roots r ON r.page_id=a.id WHERE r.publication_id=publications.id));
END;
CREATE TRIGGER publications_view_change AFTER UPDATE OF value_json,owner_id ON table_views WHEN OLD.value_json IS NOT NEW.value_json OR OLD.owner_id IS NOT NEW.owner_id BEGIN
 UPDATE publications SET generation=generation+1,access_generation=access_generation+1,build_checkpoint_json=NULL,build_content_version=NULL,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.page_id) AND (dependencies_ready=0 OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('view') AND d.target_id=json_array(NEW.page_id,NEW.id)));
END;
CREATE TRIGGER publications_view_delete BEFORE DELETE ON table_views  BEGIN
 UPDATE publications SET generation=generation+1,access_generation=access_generation+1,build_checkpoint_json=NULL,build_content_version=NULL,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=OLD.page_id) AND (dependencies_ready=0 OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('view') AND d.target_id=json_array(OLD.page_id,OLD.id)));
END;
CREATE TRIGGER publications_column_delete BEFORE DELETE ON table_columns  BEGIN
 UPDATE publications SET generation=generation+1,access_generation=access_generation+1,build_checkpoint_json=NULL,build_content_version=NULL,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=OLD.page_id) AND (dependencies_ready=0 OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('page','ancestor') AND d.target_id=OLD.page_id) OR EXISTS(WITH RECURSIVE ancestry(id,parent_id,depth) AS (
 SELECT id,parent_id,0 FROM pages WHERE id=OLD.page_id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT 1 FROM ancestry a JOIN publication_roots r ON r.page_id=a.id WHERE r.publication_id=publications.id));
END;
CREATE TRIGGER publications_row_delete BEFORE DELETE ON table_rows  BEGIN
 UPDATE publications SET generation=generation+1,access_generation=access_generation+1,build_checkpoint_json=NULL,build_content_version=NULL,content_version=content_version+1,needs_build=1,updated_at=unixepoch()*1000 WHERE active=1 AND workspace_id=(SELECT workspace_id FROM pages WHERE id=OLD.page_id) AND (dependencies_ready=0 OR EXISTS(SELECT 1 FROM publication_dependencies d WHERE d.publication_id=publications.id
 AND d.generation IN(publications.generation,publications.active_generation) AND d.kind IN('page','ancestor') AND d.target_id=OLD.page_id) OR EXISTS(WITH RECURSIVE ancestry(id,parent_id,depth) AS (
 SELECT id,parent_id,0 FROM pages WHERE id=OLD.page_id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT 1 FROM ancestry a JOIN publication_roots r ON r.page_id=a.id WHERE r.publication_id=publications.id));
END;
CREATE TRIGGER public_delivery_page_update AFTER UPDATE OF title,icon,indexed_seq,full_width,cover_attachment_id,cover_x,cover_y,archived_at,parent_id,space_id,import_job_id ON pages  BEGIN UPDATE share_links SET content_generation=content_generation+1 WHERE revoked_at IS NULL AND workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.id)
 AND (root_page_id=NEW.id OR (include_subpages=1 AND root_page_id IN(
 WITH RECURSIVE ancestry(id,parent_id,depth) AS (SELECT id,parent_id,0 FROM pages WHERE id=NEW.id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT id FROM ancestry))); END;
CREATE TRIGGER public_delivery_page_move BEFORE UPDATE OF archived_at,parent_id,space_id,import_job_id ON pages WHEN OLD.archived_at IS NOT NEW.archived_at OR OLD.parent_id IS NOT NEW.parent_id OR OLD.space_id IS NOT NEW.space_id OR OLD.import_job_id IS NOT NEW.import_job_id BEGIN UPDATE share_links SET content_generation=content_generation+1 WHERE revoked_at IS NULL AND workspace_id=(SELECT workspace_id FROM pages WHERE id=OLD.id)
 AND (root_page_id=OLD.id OR (include_subpages=1 AND root_page_id IN(
 WITH RECURSIVE ancestry(id,parent_id,depth) AS (SELECT id,parent_id,0 FROM pages WHERE id=OLD.id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT id FROM ancestry))); END;
CREATE TRIGGER public_delivery_page_insert AFTER INSERT ON pages  BEGIN UPDATE share_links SET content_generation=content_generation+1 WHERE revoked_at IS NULL AND workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.id)
 AND (root_page_id=NEW.id OR (include_subpages=1 AND root_page_id IN(
 WITH RECURSIVE ancestry(id,parent_id,depth) AS (SELECT id,parent_id,0 FROM pages WHERE id=NEW.id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT id FROM ancestry))); END;
CREATE TRIGGER public_delivery_page_delete BEFORE DELETE ON pages  BEGIN UPDATE share_links SET content_generation=content_generation+1 WHERE revoked_at IS NULL AND workspace_id=(SELECT workspace_id FROM pages WHERE id=OLD.id)
 AND (root_page_id=OLD.id OR (include_subpages=1 AND root_page_id IN(
 WITH RECURSIVE ancestry(id,parent_id,depth) AS (SELECT id,parent_id,0 FROM pages WHERE id=OLD.id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT id FROM ancestry))); END;
CREATE TRIGGER public_delivery_attachment_delete BEFORE DELETE ON attachments  BEGIN UPDATE share_links SET content_generation=content_generation+1 WHERE revoked_at IS NULL AND workspace_id=(SELECT workspace_id FROM pages WHERE id=OLD.page_id)
 AND (root_page_id=OLD.page_id OR (include_subpages=1 AND root_page_id IN(
 WITH RECURSIVE ancestry(id,parent_id,depth) AS (SELECT id,parent_id,0 FROM pages WHERE id=OLD.page_id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT id FROM ancestry))); END;
CREATE TRIGGER public_delivery_table AFTER UPDATE OF revision ON table_state WHEN OLD.revision<>NEW.revision BEGIN UPDATE share_links SET content_generation=content_generation+1 WHERE revoked_at IS NULL AND workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.page_id)
 AND (root_page_id=NEW.page_id OR (include_subpages=1 AND root_page_id IN(
 WITH RECURSIVE ancestry(id,parent_id,depth) AS (SELECT id,parent_id,0 FROM pages WHERE id=NEW.page_id
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestry a ON p.id=a.parent_id WHERE a.depth<50)
 SELECT id FROM ancestry))); END;
CREATE TRIGGER public_cache_publication AFTER UPDATE OF access_generation,active ON publications
WHEN OLD.access_generation<>NEW.access_generation OR OLD.active<>NEW.active BEGIN
 INSERT INTO public_cache_dirty VALUES(NEW.workspace_id,1,unixepoch()*1000)
 ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at;
END;
DROP TRIGGER semantic_page_insert;
CREATE TRIGGER semantic_page_insert AFTER INSERT ON pages BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) VALUES(NEW.id,NEW.workspace_id,1,NEW.updated_at)
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1
 WHERE semantic_dirty.pending=0 OR EXISTS(SELECT 1 FROM semantic_builds b WHERE b.page_id=excluded.page_id)
 OR EXISTS(SELECT 1 FROM platform_jobs j WHERE j.kind='semantic' AND j.job_key=excluded.page_id);
END;
DROP TRIGGER semantic_page_update;
CREATE TRIGGER semantic_page_update AFTER UPDATE OF title,space_id,revision,content_epoch,archived_at,import_job_id,is_template ON pages
WHEN NEW.title IS NOT OLD.title OR NEW.space_id IS NOT OLD.space_id OR NEW.revision IS NOT OLD.revision OR NEW.content_epoch IS NOT OLD.content_epoch
 OR NEW.archived_at IS NOT OLD.archived_at OR NEW.import_job_id IS NOT OLD.import_job_id OR NEW.is_template IS NOT OLD.is_template BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) VALUES(NEW.id,NEW.workspace_id,1,NEW.updated_at)
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1
 WHERE semantic_dirty.pending=0 OR EXISTS(SELECT 1 FROM semantic_builds b WHERE b.page_id=excluded.page_id)
 OR EXISTS(SELECT 1 FROM platform_jobs j WHERE j.kind='semantic' AND j.job_key=excluded.page_id);
END;
DROP TRIGGER semantic_page_delete;
CREATE TRIGGER semantic_page_delete AFTER DELETE ON pages BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) VALUES(OLD.id,OLD.workspace_id,1,CAST(unixepoch('subsec')*1000 AS INTEGER))
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1
 WHERE semantic_dirty.pending=0 OR EXISTS(SELECT 1 FROM semantic_builds b WHERE b.page_id=excluded.page_id)
 OR EXISTS(SELECT 1 FROM platform_jobs j WHERE j.kind='semantic' AND j.job_key=excluded.page_id);
END;
DROP TRIGGER semantic_document_insert;
CREATE TRIGGER semantic_document_insert AFTER INSERT ON document_projections BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT NEW.page_id,workspace_id,1,NEW.updated_at FROM pages WHERE id=NEW.page_id
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1
 WHERE semantic_dirty.pending=0 OR EXISTS(SELECT 1 FROM semantic_builds b WHERE b.page_id=excluded.page_id)
 OR EXISTS(SELECT 1 FROM platform_jobs j WHERE j.kind='semantic' AND j.job_key=excluded.page_id);
END;
DROP TRIGGER semantic_document_update;
CREATE TRIGGER semantic_document_update AFTER UPDATE ON document_projections
WHEN NEW.content_hash IS NOT OLD.content_hash OR NEW.content_epoch IS NOT OLD.content_epoch OR NEW.sequence IS NOT OLD.sequence BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT NEW.page_id,workspace_id,1,NEW.updated_at FROM pages WHERE id=NEW.page_id
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1
 WHERE semantic_dirty.pending=0 OR EXISTS(SELECT 1 FROM semantic_builds b WHERE b.page_id=excluded.page_id)
 OR EXISTS(SELECT 1 FROM platform_jobs j WHERE j.kind='semantic' AND j.job_key=excluded.page_id);
END;
DROP TRIGGER semantic_diagram_insert;
CREATE TRIGGER semantic_diagram_insert AFTER INSERT ON diagram_projections BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT NEW.page_id,workspace_id,1,NEW.updated_at FROM pages WHERE id=NEW.page_id
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1
 WHERE semantic_dirty.pending=0 OR EXISTS(SELECT 1 FROM semantic_builds b WHERE b.page_id=excluded.page_id)
 OR EXISTS(SELECT 1 FROM platform_jobs j WHERE j.kind='semantic' AND j.job_key=excluded.page_id);
END;
DROP TRIGGER semantic_diagram_update;
CREATE TRIGGER semantic_diagram_update AFTER UPDATE ON diagram_projections
WHEN NEW.content_hash IS NOT OLD.content_hash OR NEW.content_epoch IS NOT OLD.content_epoch OR NEW.sequence IS NOT OLD.sequence BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT NEW.page_id,workspace_id,1,NEW.updated_at FROM pages WHERE id=NEW.page_id
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1
 WHERE semantic_dirty.pending=0 OR EXISTS(SELECT 1 FROM semantic_builds b WHERE b.page_id=excluded.page_id)
 OR EXISTS(SELECT 1 FROM platform_jobs j WHERE j.kind='semantic' AND j.job_key=excluded.page_id);
END;
DROP TRIGGER semantic_table_update;
CREATE TRIGGER semantic_table_update AFTER UPDATE OF revision ON table_state WHEN NEW.revision<>OLD.revision BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT NEW.page_id,workspace_id,1,updated_at FROM pages WHERE id=NEW.page_id
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1
 WHERE semantic_dirty.pending=0 OR EXISTS(SELECT 1 FROM semantic_builds b WHERE b.page_id=excluded.page_id)
 OR EXISTS(SELECT 1 FROM platform_jobs j WHERE j.kind='semantic' AND j.job_key=excluded.page_id);
END;
DROP TRIGGER semantic_table_generation;
CREATE TRIGGER semantic_table_generation AFTER UPDATE OF generation,state ON table_authority
WHEN NEW.state='do' AND (NEW.generation<>OLD.generation OR NEW.state<>OLD.state) BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT NEW.page_id,workspace_id,1,updated_at FROM pages WHERE id=NEW.page_id
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1
 WHERE semantic_dirty.pending=0 OR EXISTS(SELECT 1 FROM semantic_builds b WHERE b.page_id=excluded.page_id)
 OR EXISTS(SELECT 1 FROM platform_jobs j WHERE j.kind='semantic' AND j.job_key=excluded.page_id);
END;
DROP TRIGGER forms_column_update;
DROP TRIGGER forms_column_delete;
DROP TRIGGER forms_option_delete;
CREATE TRIGGER forms_column_update AFTER UPDATE OF type,property_generation ON table_columns WHEN OLD.type IS NOT NEW.type OR OLD.property_generation IS NOT NEW.property_generation BEGIN
 UPDATE public_forms SET active=0,version=version+1,updated_at=unixepoch()*1000 WHERE page_id=NEW.page_id AND active=1
 AND EXISTS(SELECT 1 FROM json_each(public_forms.fields_json) f WHERE json_extract(f.value,'$.columnId')=NEW.id);
END;
CREATE TRIGGER forms_column_delete BEFORE DELETE ON table_columns  BEGIN
 UPDATE public_forms SET active=0,version=version+1,updated_at=unixepoch()*1000 WHERE page_id=OLD.page_id AND active=1
 AND EXISTS(SELECT 1 FROM json_each(public_forms.fields_json) f WHERE json_extract(f.value,'$.columnId')=OLD.id);
END;
CREATE TRIGGER forms_option_delete BEFORE DELETE ON table_select_options BEGIN
 UPDATE public_forms SET active=0,version=version+1,updated_at=unixepoch()*1000
 WHERE page_id=(SELECT page_id FROM table_columns WHERE id=OLD.column_id) AND active=1
 AND EXISTS(SELECT 1 FROM json_each(public_forms.fields_json) f WHERE json_extract(f.value,'$.columnId')=OLD.column_id
 AND EXISTS(SELECT 1 FROM json_each(f.value,'$.options') o WHERE json_extract(o.value,'$.id')=OLD.id));
END;
