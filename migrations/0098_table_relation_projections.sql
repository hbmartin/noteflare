-- Canonical forward values remain in TableAuthority. These records are derived.
CREATE TABLE table_relation_sources (
  source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  relation_id TEXT NOT NULL,
  target_page_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(source_page_id,relation_id)
);
CREATE INDEX table_relation_targets ON table_relation_sources(target_page_id,source_page_id,relation_id) WHERE deleted=0;
CREATE TABLE table_relation_cells (
  source_page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  relation_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  row_ids_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(source_page_id,relation_id,row_id)
);
