CREATE TRIGGER realtime_space_added AFTER INSERT ON space_members BEGIN
  INSERT INTO realtime_revocations(workspace_id,revision)
  SELECT workspace_id,1 FROM spaces WHERE id=NEW.space_id
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;

-- Fence grants that could have reduced an existing editor's access before the
-- INSERT trigger existed. Each affected workspace advances once, never backwards.
INSERT INTO realtime_revocations(workspace_id,revision)
SELECT DISTINCT space.workspace_id,1 FROM spaces space
JOIN space_members grant ON grant.space_id=space.id AND grant.role='viewer'
JOIN workspace_members member ON member.workspace_id=space.workspace_id
  AND member.user_id=grant.user_id AND member.role='editor'
WHERE space.visibility='workspace'
ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;

DROP TRIGGER search_heading_epoch;
CREATE TRIGGER search_heading_epoch AFTER UPDATE OF content_epoch ON pages
WHEN NEW.kind='document' AND NEW.content_epoch<>OLD.content_epoch BEGIN
  UPDATE pages SET headings_text='' WHERE id=NEW.id;
  INSERT OR IGNORE INTO search_heading_backfill(page_id) VALUES(NEW.id);
END;
DELETE FROM search_heading_backfill WHERE page_id IN (SELECT id FROM pages WHERE kind<>'document');

CREATE INDEX comment_operations_thread ON comment_operations(thread_id);
CREATE INDEX comment_operations_page ON comment_operations(page_id);
