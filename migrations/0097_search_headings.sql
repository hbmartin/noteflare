ALTER TABLE pages ADD COLUMN headings_text TEXT NOT NULL DEFAULT '';
ALTER TABLE page_search_v2 RENAME TO page_search_v2_previous;
CREATE VIRTUAL TABLE page_search_v2 USING fts5(
  page_id UNINDEXED, workspace_id UNINDEXED, space_id UNINDEXED,
  title,tags,body,comments,attachments,headings,tokenize='unicode61'
);
INSERT INTO page_search_v2(page_id,workspace_id,space_id,title,tags,body,comments,attachments,headings)
SELECT page_id,workspace_id,space_id,title,tags,body,comments,attachments,'' FROM page_search_v2_previous;
DROP TABLE page_search_v2_previous;
CREATE TABLE search_heading_backfill(page_id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,attempted_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO search_heading_backfill(page_id) SELECT id FROM pages WHERE kind='document' AND import_job_id IS NULL;
CREATE TRIGGER search_heading_epoch AFTER UPDATE OF content_epoch ON pages WHEN NEW.content_epoch<>OLD.content_epoch BEGIN
  UPDATE pages SET headings_text='' WHERE id=NEW.id;
  INSERT OR IGNORE INTO search_heading_backfill(page_id) VALUES(NEW.id);
END;
