-- Expansion-only grants still publish invalidation events; they need no fence.
DROP TRIGGER realtime_space_added;
CREATE TRIGGER realtime_space_added AFTER INSERT ON space_members
WHEN NEW.role='viewer' AND EXISTS (
  SELECT 1 FROM spaces space
  JOIN workspace_members member ON member.workspace_id=space.workspace_id
    AND member.user_id=NEW.user_id AND member.role='editor'
  WHERE space.id=NEW.space_id AND space.visibility='workspace'
) BEGIN
  INSERT INTO realtime_revocations(workspace_id,revision)
  SELECT workspace_id,1 FROM spaces WHERE id=NEW.space_id
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
