-- The legacy FTS5 `page_search` index has had no readers since `page_search_v2`
-- replaced it (0012, rebuilt in 0097), yet every compaction still rewrote it.
--
-- Migrations apply before the new Worker uploads, and Upgrading documents a
-- rollback path, so a Worker that still writes the old table must keep working.
-- An empty view with no-op INSTEAD OF triggers accepts those writes and stores
-- nothing. A later release can drop the view and its triggers.
DROP TABLE IF EXISTS page_search;

CREATE VIEW page_search(page_id, workspace_id, title, body) AS
  SELECT NULL, NULL, NULL, NULL WHERE 0;

CREATE TRIGGER page_search_retired_insert INSTEAD OF INSERT ON page_search BEGIN SELECT 1; END;
CREATE TRIGGER page_search_retired_update INSTEAD OF UPDATE ON page_search BEGIN SELECT 1; END;
CREATE TRIGGER page_search_retired_delete INSTEAD OF DELETE ON page_search BEGIN SELECT 1; END;
