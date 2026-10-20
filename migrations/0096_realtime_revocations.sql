CREATE TABLE realtime_revocations (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  completed_revision INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER realtime_member_role AFTER UPDATE OF role ON workspace_members WHEN NEW.role<>OLD.role BEGIN
  INSERT INTO realtime_revocations(workspace_id,revision) VALUES(NEW.workspace_id,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER realtime_member_removed AFTER DELETE ON workspace_members BEGIN
  INSERT INTO realtime_revocations(workspace_id,revision) SELECT OLD.workspace_id,1
  WHERE EXISTS(SELECT 1 FROM workspaces WHERE id=OLD.workspace_id)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER realtime_space_role AFTER UPDATE OF role ON space_members WHEN NEW.role<>OLD.role BEGIN
  INSERT INTO realtime_revocations(workspace_id,revision) SELECT workspace_id,1 FROM spaces WHERE id=NEW.space_id
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER realtime_space_removed AFTER DELETE ON space_members BEGIN
  INSERT INTO realtime_revocations(workspace_id,revision) SELECT workspace_id,1 FROM spaces WHERE id=OLD.space_id
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER realtime_space_visibility AFTER UPDATE OF visibility ON spaces WHEN NEW.visibility<>OLD.visibility BEGIN
  INSERT INTO realtime_revocations(workspace_id,revision) VALUES(NEW.workspace_id,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER realtime_page_space AFTER UPDATE OF space_id ON pages WHEN NEW.space_id<>OLD.space_id BEGIN
  INSERT INTO realtime_revocations(workspace_id,revision) VALUES(NEW.workspace_id,1)
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER realtime_session_removed AFTER DELETE ON session BEGIN
  INSERT INTO realtime_revocations(workspace_id,revision)
  SELECT workspace_id,1 FROM workspace_members WHERE user_id=OLD.userId
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER realtime_security_generation AFTER UPDATE OF generation ON account_security WHEN NEW.generation<>OLD.generation BEGIN
  INSERT INTO realtime_revocations(workspace_id,revision)
  SELECT workspace_id,1 FROM workspace_members WHERE user_id=NEW.user_id
  ON CONFLICT(workspace_id) DO UPDATE SET revision=revision+1;
END;
