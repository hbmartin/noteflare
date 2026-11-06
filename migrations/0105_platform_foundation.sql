-- Durable work is authoritative; queue messages are only wakeups.
CREATE TABLE platform_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  job_key TEXT NOT NULL,
  generation TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(workspace_id,kind,job_key)
);
CREATE INDEX platform_jobs_due ON platform_jobs(available_at,lease_until);
CREATE TABLE platform_settings (
  workspace_id TEXT PRIMARY KEY,
  heatmaps_enabled INTEGER NOT NULL DEFAULT 0 CHECK(heatmaps_enabled IN (0,1)),
  updated_at INTEGER NOT NULL
);

-- Context exists only inside a request's atomic D1 batch, never between writers.
CREATE TABLE audit_mutation_context(id INTEGER PRIMARY KEY CHECK(id=1),actor_type TEXT NOT NULL,actor_id TEXT,workspace_id TEXT,correlation_id TEXT,committed_at INTEGER NOT NULL);
CREATE TRIGGER audit_pages_insert AFTER INSERT ON pages
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'page.insert','page',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_pages_update AFTER UPDATE ON pages
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.title IS NOT NEW.title OR OLD.icon IS NOT NEW.icon OR OLD.parent_id IS NOT NEW.parent_id OR OLD.space_id IS NOT NEW.space_id OR OLD.archived_at IS NOT NEW.archived_at OR OLD.is_template IS NOT NEW.is_template)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'page.update','page',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_pages_delete AFTER DELETE ON pages
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(OLD.workspace_id,workspace_id),actor_type,actor_id,'page.delete','page',OLD.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(OLD.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_spaces_insert AFTER INSERT ON spaces
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'space.insert','space',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_spaces_update AFTER UPDATE ON spaces
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.name IS NOT NEW.name OR OLD.visibility IS NOT NEW.visibility OR OLD.description IS NOT NEW.description)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'space.update','space',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_spaces_delete AFTER DELETE ON spaces
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(OLD.workspace_id,workspace_id),actor_type,actor_id,'space.delete','space',OLD.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(OLD.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_workspace_members_insert AFTER INSERT ON workspace_members
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'membership.insert','membership',NEW.user_id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_workspace_members_update AFTER UPDATE ON workspace_members
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.role IS NOT NEW.role)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'membership.update','membership',NEW.user_id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_workspace_members_delete AFTER DELETE ON workspace_members
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(OLD.workspace_id,workspace_id),actor_type,actor_id,'membership.delete','membership',OLD.user_id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(OLD.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_space_members_insert AFTER INSERT ON space_members
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM spaces WHERE id=NEW.space_id),workspace_id),actor_type,actor_id,'space_membership.insert','space_membership',NEW.space_id||':'||NEW.user_id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM spaces WHERE id=NEW.space_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_space_members_update AFTER UPDATE ON space_members
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.role IS NOT NEW.role)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM spaces WHERE id=NEW.space_id),workspace_id),actor_type,actor_id,'space_membership.update','space_membership',NEW.space_id||':'||NEW.user_id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM spaces WHERE id=NEW.space_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_space_members_delete AFTER DELETE ON space_members
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM spaces WHERE id=OLD.space_id),workspace_id),actor_type,actor_id,'space_membership.delete','space_membership',OLD.space_id||':'||OLD.user_id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM spaces WHERE id=OLD.space_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_share_links_insert AFTER INSERT ON share_links
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'share.insert','share',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_share_links_update AFTER UPDATE ON share_links
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.include_subpages IS NOT NEW.include_subpages OR OLD.allow_indexing IS NOT NEW.allow_indexing OR OLD.show_toc IS NOT NEW.show_toc OR OLD.show_last_updated IS NOT NEW.show_last_updated OR OLD.revoked_at IS NOT NEW.revoked_at OR OLD.updated_at IS NOT NEW.updated_at)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'share.update','share',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_share_links_delete AFTER DELETE ON share_links
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(OLD.workspace_id,workspace_id),actor_type,actor_id,'share.delete','share',OLD.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(OLD.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_attachments_insert AFTER INSERT ON attachments
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'attachment.insert','attachment',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_attachments_update AFTER UPDATE ON attachments
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.page_id IS NOT NEW.page_id OR OLD.name IS NOT NEW.name)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'attachment.update','attachment',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_attachments_delete AFTER DELETE ON attachments
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(OLD.workspace_id,workspace_id),actor_type,actor_id,'attachment.delete','attachment',OLD.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(OLD.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_comment_threads_insert AFTER INSERT ON comment_threads
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'comment_thread.insert','comment_thread',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_comment_threads_update AFTER UPDATE ON comment_threads
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.resolved_at IS NOT NEW.resolved_at)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'comment_thread.update','comment_thread',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_comment_threads_delete AFTER DELETE ON comment_threads
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(OLD.workspace_id,workspace_id),actor_type,actor_id,'comment_thread.delete','comment_thread',OLD.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(OLD.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_comments_insert AFTER INSERT ON comments
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM comment_threads WHERE id=NEW.thread_id),workspace_id),actor_type,actor_id,'comment.insert','comment',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM comment_threads WHERE id=NEW.thread_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_comments_update AFTER UPDATE ON comments
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.body_json IS NOT NEW.body_json OR OLD.deleted_at IS NOT NEW.deleted_at)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM comment_threads WHERE id=NEW.thread_id),workspace_id),actor_type,actor_id,'comment.update','comment',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM comment_threads WHERE id=NEW.thread_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_comments_delete AFTER DELETE ON comments
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM comment_threads WHERE id=OLD.thread_id),workspace_id),actor_type,actor_id,'comment.delete','comment',OLD.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM comment_threads WHERE id=OLD.thread_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_integrations_insert AFTER INSERT ON integrations
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'integration.insert','integration',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_integrations_update AFTER UPDATE ON integrations
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.name IS NOT NEW.name OR OLD.read_content IS NOT NEW.read_content OR OLD.insert_content IS NOT NEW.insert_content OR OLD.update_content IS NOT NEW.update_content OR OLD.read_comments IS NOT NEW.read_comments OR OLD.insert_comments IS NOT NEW.insert_comments OR OLD.user_information IS NOT NEW.user_information OR OLD.revoked_at IS NOT NEW.revoked_at)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'integration.update','integration',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_integrations_delete AFTER DELETE ON integrations
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(OLD.workspace_id,workspace_id),actor_type,actor_id,'integration.delete','integration',OLD.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(OLD.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_integration_tokens_insert AFTER INSERT ON integration_tokens
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM integrations WHERE id=NEW.integration_id),workspace_id),actor_type,actor_id,'integration_token.insert','integration_token',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM integrations WHERE id=NEW.integration_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_integration_tokens_update AFTER UPDATE ON integration_tokens
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.revoked_at IS NOT NEW.revoked_at)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM integrations WHERE id=NEW.integration_id),workspace_id),actor_type,actor_id,'integration_token.update','integration_token',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM integrations WHERE id=NEW.integration_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_integration_tokens_delete AFTER DELETE ON integration_tokens
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM integrations WHERE id=OLD.integration_id),workspace_id),actor_type,actor_id,'integration_token.delete','integration_token',OLD.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM integrations WHERE id=OLD.integration_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_integration_grants_insert AFTER INSERT ON integration_grants
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM integrations WHERE id=NEW.integration_id),workspace_id),actor_type,actor_id,'integration_grant.insert','integration_grant',NEW.integration_id||':'||NEW.root_page_id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM integrations WHERE id=NEW.integration_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_integration_grants_delete AFTER DELETE ON integration_grants
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM integrations WHERE id=OLD.integration_id),workspace_id),actor_type,actor_id,'integration_grant.delete','integration_grant',OLD.integration_id||':'||OLD.root_page_id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM integrations WHERE id=OLD.integration_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_invites_insert AFTER INSERT ON invites
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'invitation.insert','invitation',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_invites_update AFTER UPDATE ON invites
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.used_at IS NOT NEW.used_at OR OLD.expires_at IS NOT NEW.expires_at)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'invitation.update','invitation',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_invites_delete AFTER DELETE ON invites
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(OLD.workspace_id,workspace_id),actor_type,actor_id,'invitation.delete','invitation',OLD.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce(OLD.workspace_id,workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_webhook_subscriptions_insert AFTER INSERT ON webhook_subscriptions
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM integrations WHERE id=NEW.integration_id),workspace_id),actor_type,actor_id,'webhook.insert','webhook',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM integrations WHERE id=NEW.integration_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_webhook_subscriptions_update AFTER UPDATE ON webhook_subscriptions
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.updated_at IS NOT NEW.updated_at)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM integrations WHERE id=NEW.integration_id),workspace_id),actor_type,actor_id,'webhook.update','webhook',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM integrations WHERE id=NEW.integration_id),workspace_id) IS NOT NULL;
END;
CREATE TRIGGER audit_webhook_subscriptions_delete AFTER DELETE ON webhook_subscriptions
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM integrations WHERE id=OLD.integration_id),workspace_id),actor_type,actor_id,'webhook.delete','webhook',OLD.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM integrations WHERE id=OLD.integration_id),workspace_id) IS NOT NULL;
END;

CREATE TABLE platform_usage (
  workspace_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  period TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK(amount >= 0),
  PRIMARY KEY(workspace_id,metric,period)
);
-- Audit identifiers deliberately have no deletion-cascade foreign keys.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  outcome TEXT NOT NULL,
  committed_at INTEGER NOT NULL,
  correlation_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  archive_id TEXT,
  basin_exported_at INTEGER
);
CREATE INDEX audit_events_workspace_time ON audit_events(workspace_id,committed_at,id);
CREATE INDEX audit_events_unarchived ON audit_events(archive_id,committed_at,id);
CREATE INDEX audit_events_unexported ON audit_events(basin_exported_at,committed_at,id);
CREATE TRIGGER audit_event_immutable BEFORE UPDATE OF id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id,metadata_json ON audit_events
BEGIN SELECT RAISE(ABORT,'audit_event_immutable'); END;
CREATE TABLE audit_archives (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  digest TEXT NOT NULL,
  event_count INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX audit_archives_workspace ON audit_archives(workspace_id,last_at,id);
CREATE TABLE heatmap_readers (
  workspace_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  section_id TEXT NOT NULL,
  week_start INTEGER NOT NULL,
  reader_key TEXT NOT NULL,
  dwell_bucket INTEGER NOT NULL,
  scroll_bucket INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,page_id,revision,section_id,week_start,reader_key)
);
CREATE INDEX heatmap_readers_week ON heatmap_readers(week_start,updated_at);
CREATE TABLE heatmap_aggregates (
  workspace_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  section_id TEXT NOT NULL,
  week_start INTEGER NOT NULL,
  readers INTEGER NOT NULL CHECK(readers >= 5),
  dwell_total INTEGER NOT NULL,
  scroll_total INTEGER NOT NULL,
  finalized_at INTEGER NOT NULL,
  basin_exported_at INTEGER,
  PRIMARY KEY(workspace_id,page_id,revision,section_id,week_start)
);
