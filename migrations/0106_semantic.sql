-- A local, transactional dirty ledger is independent of optional AI bindings.
-- Deletion tombstones deliberately have no pages FK until remote vectors vanish.
CREATE TABLE semantic_dirty (
  page_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL, pending INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE semantic_documents (
  page_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, space_id TEXT NOT NULL,
  generation INTEGER NOT NULL, content_epoch INTEGER NOT NULL, revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL, table_generation INTEGER NOT NULL DEFAULT 0,
  model_version TEXT NOT NULL, content_hash TEXT NOT NULL, indexed_at INTEGER NOT NULL
);
CREATE TABLE semantic_chunks (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  generation INTEGER NOT NULL, ordinal INTEGER NOT NULL, source_json TEXT NOT NULL,
  content_hash TEXT NOT NULL, created_at INTEGER NOT NULL, embedded INTEGER NOT NULL DEFAULT 0, delete_mutation_id TEXT, delete_requested_at INTEGER,
  UNIQUE(page_id,generation,ordinal)
);
CREATE INDEX semantic_chunks_page ON semantic_chunks(page_id,generation);
CREATE INDEX semantic_chunks_workspace ON semantic_chunks(workspace_id);
CREATE TABLE semantic_usage (
  day INTEGER PRIMARY KEY, tokens INTEGER NOT NULL DEFAULT 0, queries INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE semantic_search_sessions (
  id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL,
  query_hash TEXT NOT NULL, results_json TEXT NOT NULL, retrieval_status TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX semantic_search_expiry ON semantic_search_sessions(expires_at);

CREATE TRIGGER semantic_page_insert AFTER INSERT ON pages BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) VALUES(NEW.id,NEW.workspace_id,1,NEW.updated_at)
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1;
END;
CREATE TRIGGER semantic_page_update AFTER UPDATE OF title,space_id,revision,content_epoch,archived_at,import_job_id,is_template ON pages
WHEN NEW.title IS NOT OLD.title OR NEW.space_id IS NOT OLD.space_id OR NEW.revision IS NOT OLD.revision OR NEW.content_epoch IS NOT OLD.content_epoch
 OR NEW.archived_at IS NOT OLD.archived_at OR NEW.import_job_id IS NOT OLD.import_job_id OR NEW.is_template IS NOT OLD.is_template BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) VALUES(NEW.id,NEW.workspace_id,1,NEW.updated_at)
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1;
END;
CREATE TRIGGER semantic_page_delete AFTER DELETE ON pages BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) VALUES(OLD.id,OLD.workspace_id,1,CAST(unixepoch('subsec')*1000 AS INTEGER))
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1;
END;
CREATE TRIGGER semantic_document_insert AFTER INSERT ON document_projections BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT NEW.page_id,workspace_id,1,NEW.updated_at FROM pages WHERE id=NEW.page_id
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1;
END;
CREATE TRIGGER semantic_document_update AFTER UPDATE ON document_projections
WHEN NEW.content_hash IS NOT OLD.content_hash OR NEW.content_epoch IS NOT OLD.content_epoch OR NEW.sequence IS NOT OLD.sequence BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT NEW.page_id,workspace_id,1,NEW.updated_at FROM pages WHERE id=NEW.page_id
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1;
END;
CREATE TRIGGER semantic_diagram_insert AFTER INSERT ON diagram_projections BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT NEW.page_id,workspace_id,1,NEW.updated_at FROM pages WHERE id=NEW.page_id
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1;
END;
CREATE TRIGGER semantic_diagram_update AFTER UPDATE ON diagram_projections
WHEN NEW.content_hash IS NOT OLD.content_hash OR NEW.content_epoch IS NOT OLD.content_epoch OR NEW.sequence IS NOT OLD.sequence BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT NEW.page_id,workspace_id,1,NEW.updated_at FROM pages WHERE id=NEW.page_id
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1;
END;
CREATE TRIGGER semantic_table_update AFTER UPDATE OF revision ON table_state WHEN NEW.revision<>OLD.revision BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT NEW.page_id,workspace_id,1,updated_at FROM pages WHERE id=NEW.page_id
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1;
END;
INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT id,workspace_id,1,updated_at FROM pages;

ALTER TABLE ai_messages ADD COLUMN retrieval_status TEXT NOT NULL DEFAULT 'disabled';

CREATE TABLE semantic_builds (
  page_id TEXT NOT NULL,generation INTEGER NOT NULL,cursor TEXT,chunk_offset INTEGER NOT NULL DEFAULT 0,
  ordinal INTEGER NOT NULL DEFAULT 0,content_hash TEXT NOT NULL DEFAULT '',revision INTEGER NOT NULL,
  PRIMARY KEY(page_id,generation)
);

CREATE TRIGGER semantic_table_generation AFTER UPDATE OF generation,state ON table_authority
WHEN NEW.state='do' AND (NEW.generation<>OLD.generation OR NEW.state<>OLD.state) BEGIN
  INSERT INTO semantic_dirty(page_id,workspace_id,generation,updated_at) SELECT NEW.page_id,workspace_id,1,updated_at FROM pages WHERE id=NEW.page_id
  ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,generation=generation+1,updated_at=excluded.updated_at,pending=1;
END;
