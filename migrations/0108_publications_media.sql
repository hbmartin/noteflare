ALTER TABLE pages ADD COLUMN cover_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL;
ALTER TABLE pages ADD COLUMN cover_x REAL NOT NULL DEFAULT 0.5 CHECK(cover_x>=0 AND cover_x<=1);
ALTER TABLE pages ADD COLUMN cover_y REAL NOT NULL DEFAULT 0.5 CHECK(cover_y>=0 AND cover_y<=1);
CREATE TABLE image_derivatives (
 id TEXT PRIMARY KEY, attachment_id TEXT REFERENCES attachments(id) ON DELETE CASCADE,
 source_key TEXT NOT NULL, preset TEXT NOT NULL, r2_key TEXT NOT NULL, mime TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX image_derivatives_attachment ON image_derivatives(attachment_id);
CREATE TABLE publications (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, url_key TEXT NOT NULL UNIQUE,
 config_json TEXT NOT NULL CHECK(json_valid(config_json)), active INTEGER NOT NULL DEFAULT 0,
 generation INTEGER NOT NULL DEFAULT 1, access_generation INTEGER NOT NULL DEFAULT 1,
 active_generation INTEGER, active_access_generation INTEGER, manifest_key TEXT,
 needs_build INTEGER NOT NULL DEFAULT 1, build_error TEXT, created_by TEXT NOT NULL REFERENCES user(id),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX publications_pending ON publications(active,needs_build,updated_at);
CREATE TABLE publication_roots (
 publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
 page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, PRIMARY KEY(publication_id,page_id)
);
CREATE TABLE publication_hostnames (
 hostname TEXT PRIMARY KEY, publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
 provider_id TEXT, status TEXT NOT NULL DEFAULT 'pending', ssl_status TEXT NOT NULL DEFAULT 'pending',
 verification_json TEXT, last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX publication_hostnames_publication ON publication_hostnames(publication_id);
CREATE TRIGGER publications_page_access AFTER UPDATE OF archived_at,parent_id,space_id,import_job_id,is_template ON pages
WHEN OLD.archived_at IS NOT NEW.archived_at OR OLD.parent_id IS NOT NEW.parent_id OR OLD.space_id IS NOT NEW.space_id OR OLD.import_job_id IS NOT NEW.import_job_id OR OLD.is_template IS NOT NEW.is_template
BEGIN
 UPDATE publications SET access_generation=access_generation+1,generation=generation+1,needs_build=1,updated_at=unixepoch()*1000
 WHERE workspace_id=NEW.workspace_id;
END;
CREATE TRIGGER publications_page_delete BEFORE DELETE ON pages BEGIN
 UPDATE publications SET access_generation=access_generation+1,generation=generation+1,needs_build=1,updated_at=unixepoch()*1000 WHERE workspace_id=OLD.workspace_id;
END;
CREATE TRIGGER publications_page_content AFTER UPDATE OF title,icon,cover_attachment_id,cover_x,cover_y,indexed_seq,full_width ON pages BEGIN
 UPDATE publications SET generation=generation+1,needs_build=1,updated_at=unixepoch()*1000 WHERE space_id=NEW.space_id;
END;
CREATE TRIGGER publications_page_create AFTER INSERT ON pages BEGIN
 UPDATE publications SET generation=generation+1,needs_build=1,updated_at=unixepoch()*1000 WHERE space_id=NEW.space_id;
END;
CREATE TRIGGER publications_table_content AFTER UPDATE OF revision ON table_state BEGIN
 UPDATE publications SET generation=generation+1,needs_build=1,updated_at=unixepoch()*1000 WHERE space_id=(SELECT space_id FROM pages WHERE id=NEW.page_id);
END;
CREATE TRIGGER publications_attachment_delete BEFORE DELETE ON attachments BEGIN
 UPDATE publications SET access_generation=access_generation+1,generation=generation+1,needs_build=1,updated_at=unixepoch()*1000 WHERE workspace_id=OLD.workspace_id;
END;
CREATE TABLE publication_build_entries (
 publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL, page_id TEXT NOT NULL, part INTEGER NOT NULL DEFAULT 1,
 r2_key TEXT NOT NULL, og_key TEXT, diagram_key TEXT, assets_json TEXT NOT NULL CHECK(json_valid(assets_json)),
 PRIMARY KEY(publication_id,generation,page_id,part)
);
CREATE TABLE public_delivery_state (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,generation INTEGER NOT NULL DEFAULT 1);
INSERT INTO public_delivery_state(workspace_id) SELECT id FROM workspaces;
CREATE TRIGGER public_delivery_workspace AFTER INSERT ON workspaces BEGIN INSERT INTO public_delivery_state(workspace_id) VALUES(NEW.id); END;
CREATE TRIGGER public_delivery_page_update AFTER UPDATE ON pages BEGIN UPDATE public_delivery_state SET generation=generation+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER public_delivery_page_insert AFTER INSERT ON pages BEGIN UPDATE public_delivery_state SET generation=generation+1 WHERE workspace_id=NEW.workspace_id; END;
CREATE TRIGGER public_delivery_page_delete BEFORE DELETE ON pages BEGIN UPDATE public_delivery_state SET generation=generation+1 WHERE workspace_id=OLD.workspace_id; END;
CREATE TRIGGER public_delivery_attachment_delete BEFORE DELETE ON attachments BEGIN UPDATE public_delivery_state SET generation=generation+1 WHERE workspace_id=OLD.workspace_id; END;
CREATE TRIGGER public_delivery_table AFTER UPDATE OF revision ON table_state BEGIN UPDATE public_delivery_state SET generation=generation+1 WHERE workspace_id=(SELECT workspace_id FROM pages WHERE id=NEW.page_id); END;

-- Scope-reducing edits fence every artifact, including feeds, navigation and cached transclusions.
CREATE TRIGGER publications_reference_delete BEFORE DELETE ON transclusion_references BEGIN
 UPDATE publications SET access_generation=access_generation+1,generation=generation+1,needs_build=1,updated_at=unixepoch()*1000 WHERE space_id=(SELECT space_id FROM pages WHERE id=OLD.reference_page_id);
END;
CREATE TRIGGER publications_source_delete BEFORE DELETE ON transclusion_sources BEGIN
 UPDATE publications SET access_generation=access_generation+1,generation=generation+1,needs_build=1,updated_at=unixepoch()*1000 WHERE workspace_id=(SELECT workspace_id FROM pages WHERE id=OLD.page_id);
END;
CREATE TRIGGER publications_view_change AFTER UPDATE OF value_json,owner_id ON table_views
WHEN OLD.value_json IS NOT NEW.value_json OR OLD.owner_id IS NOT NEW.owner_id BEGIN
 UPDATE publications SET access_generation=access_generation+1,generation=generation+1,needs_build=1,updated_at=unixepoch()*1000 WHERE space_id=(SELECT space_id FROM pages WHERE id=NEW.page_id);
END;
CREATE TRIGGER publications_view_delete BEFORE DELETE ON table_views BEGIN
 UPDATE publications SET access_generation=access_generation+1,generation=generation+1,needs_build=1,updated_at=unixepoch()*1000 WHERE space_id=(SELECT space_id FROM pages WHERE id=OLD.page_id);
END;
CREATE TRIGGER publications_column_delete BEFORE DELETE ON table_columns BEGIN
 UPDATE publications SET access_generation=access_generation+1,generation=generation+1,needs_build=1,updated_at=unixepoch()*1000 WHERE space_id=(SELECT space_id FROM pages WHERE id=OLD.page_id);
END;
CREATE TRIGGER publications_row_delete BEFORE DELETE ON table_rows BEGIN
 UPDATE publications SET access_generation=access_generation+1,generation=generation+1,needs_build=1,updated_at=unixepoch()*1000 WHERE space_id=(SELECT space_id FROM pages WHERE id=OLD.page_id);
END;

CREATE TABLE image_derivative_gc(r2_key TEXT PRIMARY KEY,queued_at INTEGER NOT NULL);
CREATE TRIGGER image_derivative_gc_delete BEFORE DELETE ON image_derivatives BEGIN
 INSERT OR IGNORE INTO image_derivative_gc VALUES(OLD.r2_key,unixepoch()*1000);
END;
CREATE TABLE publication_artifacts (
 r2_key TEXT PRIMARY KEY, publication_id TEXT NOT NULL, generation INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX publication_artifacts_cleanup ON publication_artifacts(created_at);
CREATE INDEX publication_artifacts_generation ON publication_artifacts(publication_id,generation);
CREATE TABLE publication_hostname_gc(hostname TEXT PRIMARY KEY,provider_id TEXT NOT NULL,queued_at INTEGER NOT NULL);
CREATE TRIGGER publication_hostname_cleanup BEFORE DELETE ON publication_hostnames WHEN OLD.provider_id IS NOT NULL BEGIN
 INSERT INTO publication_hostname_gc VALUES(OLD.hostname,OLD.provider_id,unixepoch()*1000)
 ON CONFLICT(hostname) DO UPDATE SET provider_id=excluded.provider_id,queued_at=excluded.queued_at
 WHERE publication_hostname_gc.provider_id NOT LIKE '{%' OR publication_hostname_gc.queued_at<=unixepoch()*1000;
END;

-- Retain logical invalidation separately from optional global purge cleanup. No workspace FK:
-- a deleted workspace still needs its already-cached public hostnames retired.
CREATE TABLE public_cache_dirty(workspace_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE public_cache_purges(hostname TEXT PRIMARY KEY,generation INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE public_cache_purge_control(id INTEGER PRIMARY KEY CHECK(id=1),next_at INTEGER NOT NULL);
CREATE TRIGGER public_cache_content AFTER UPDATE OF generation ON public_delivery_state
WHEN EXISTS(SELECT 1 FROM publications WHERE workspace_id=NEW.workspace_id AND active=1)
 OR EXISTS(SELECT 1 FROM share_links WHERE workspace_id=NEW.workspace_id AND revoked_at IS NULL) BEGIN
 INSERT INTO public_cache_dirty VALUES(NEW.workspace_id,1,unixepoch()*1000)
 ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at;
END;
CREATE TRIGGER public_cache_publication AFTER UPDATE OF generation,access_generation,active ON publications BEGIN
 INSERT INTO public_cache_dirty VALUES(NEW.workspace_id,1,unixepoch()*1000)
 ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at;
END;
CREATE TRIGGER public_cache_publication_delete BEFORE DELETE ON publications BEGIN
 INSERT INTO public_cache_dirty VALUES(OLD.workspace_id,1,unixepoch()*1000)
 ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at;
END;
CREATE TRIGGER public_cache_share AFTER UPDATE OF access_generation,revoked_at ON share_links BEGIN
 INSERT INTO public_cache_dirty VALUES(NEW.workspace_id,1,unixepoch()*1000)
 ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at;
END;
CREATE TRIGGER public_cache_share_delete BEFORE DELETE ON share_links BEGIN
 INSERT INTO public_cache_dirty VALUES(OLD.workspace_id,1,unixepoch()*1000)
 ON CONFLICT(workspace_id) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at;
END;
CREATE TRIGGER public_cache_hostname AFTER UPDATE OF status,ssl_status ON publication_hostnames
WHEN (OLD.status='active' AND OLD.ssl_status='active') OR (NEW.status='active' AND NEW.ssl_status='active') BEGIN
 INSERT INTO public_cache_purges VALUES(NEW.hostname,1,unixepoch()*1000)
 ON CONFLICT(hostname) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at;
END;
CREATE TRIGGER public_cache_hostname_delete BEFORE DELETE ON publication_hostnames
WHEN OLD.status='active' AND OLD.ssl_status='active' BEGIN
 INSERT INTO public_cache_purges VALUES(OLD.hostname,1,unixepoch()*1000)
 ON CONFLICT(hostname) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at;
END;
