-- Attribute optional platform configuration changes without retaining secrets or bodies.

CREATE TRIGGER audit_public_forms_insert AFTER INSERT ON public_forms
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'form.insert','form',NEW.id,'success',committed_at,correlation_id
 FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_public_forms_update AFTER UPDATE ON public_forms
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.version IS NOT NEW.version OR OLD.active IS NOT NEW.active)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'form.update','form',NEW.id,'success',committed_at,correlation_id
 FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_public_forms_delete BEFORE DELETE ON public_forms
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(OLD.workspace_id,workspace_id),actor_type,actor_id,'form.delete','form',OLD.id,'success',committed_at,correlation_id
 FROM audit_mutation_context WHERE id=1 AND coalesce(OLD.workspace_id,workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_publications_insert AFTER INSERT ON publications
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'publication.insert','publication',NEW.id,'success',committed_at,correlation_id
 FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_publications_update AFTER UPDATE ON publications
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.config_json IS NOT NEW.config_json OR OLD.active IS NOT NEW.active)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'publication.update','publication',NEW.id,'success',committed_at,correlation_id
 FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_publications_delete BEFORE DELETE ON publications
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(OLD.workspace_id,workspace_id),actor_type,actor_id,'publication.delete','publication',OLD.id,'success',committed_at,correlation_id
 FROM audit_mutation_context WHERE id=1 AND coalesce(OLD.workspace_id,workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_publication_hostnames_insert AFTER INSERT ON publication_hostnames
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM publications WHERE id=NEW.publication_id),workspace_id),actor_type,actor_id,'hostname.insert','hostname',NEW.hostname,'success',committed_at,correlation_id
 FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM publications WHERE id=NEW.publication_id),workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_publication_hostnames_update AFTER UPDATE ON publication_hostnames
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.status IS NOT NEW.status OR OLD.ssl_status IS NOT NEW.ssl_status)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM publications WHERE id=NEW.publication_id),workspace_id),actor_type,actor_id,'hostname.update','hostname',NEW.hostname,'success',committed_at,correlation_id
 FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM publications WHERE id=NEW.publication_id),workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_publication_hostnames_delete BEFORE DELETE ON publication_hostnames
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM publications WHERE id=OLD.publication_id),workspace_id),actor_type,actor_id,'hostname.delete','hostname',OLD.hostname,'success',committed_at,correlation_id
 FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM publications WHERE id=OLD.publication_id),workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_access_identities_insert AFTER INSERT ON access_identities
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM workspace_members WHERE user_id=NEW.user_id LIMIT 1),workspace_id),actor_type,actor_id,'access_identity.insert','access_identity',NEW.user_id,'success',committed_at,correlation_id
 FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM workspace_members WHERE user_id=NEW.user_id LIMIT 1),workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_access_identities_delete BEFORE DELETE ON access_identities
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce((SELECT workspace_id FROM workspace_members WHERE user_id=OLD.user_id LIMIT 1),workspace_id),actor_type,actor_id,'access_identity.delete','access_identity',OLD.user_id,'success',committed_at,correlation_id
 FROM audit_mutation_context WHERE id=1 AND coalesce((SELECT workspace_id FROM workspace_members WHERE user_id=OLD.user_id LIMIT 1),workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_encryption_rotation_progress_insert AFTER INSERT ON encryption_rotation_progress
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id,metadata_json)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'encryption_rotation.insert','encryption_rotation',NEW.purpose,'success',committed_at,correlation_id,json_object('keyId',NEW.target_key_id,'operationId',NEW.source,'count',NEW.scanned)
 FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_encryption_rotation_progress_update AFTER UPDATE ON encryption_rotation_progress
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.scanned IS NOT NEW.scanned OR OLD.changed IS NOT NEW.changed OR OLD.completed IS NOT NEW.completed)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id,metadata_json)
 SELECT lower(hex(randomblob(16))),coalesce(NEW.workspace_id,workspace_id),actor_type,actor_id,'encryption_rotation.update','encryption_rotation',NEW.purpose,'success',committed_at,correlation_id,json_object('keyId',NEW.target_key_id,'operationId',NEW.source,'count',NEW.scanned)
 FROM audit_mutation_context WHERE id=1 AND coalesce(NEW.workspace_id,workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_encryption_rotation_progress_delete BEFORE DELETE ON encryption_rotation_progress
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),coalesce(OLD.workspace_id,workspace_id),actor_type,actor_id,'encryption_rotation.delete','encryption_rotation',OLD.purpose,'success',committed_at,correlation_id
 FROM audit_mutation_context WHERE id=1 AND coalesce(OLD.workspace_id,workspace_id) IS NOT NULL;
END;

CREATE TRIGGER audit_user_delete BEFORE DELETE ON user
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),member.workspace_id,context.actor_type,context.actor_id,'user.delete','user',OLD.id,'success',context.committed_at,context.correlation_id
 FROM workspace_members member CROSS JOIN audit_mutation_context context WHERE member.user_id=OLD.id AND context.id=1;
END;

CREATE TRIGGER audit_page_cover AFTER UPDATE OF cover_attachment_id,cover_x,cover_y ON pages
WHEN EXISTS(SELECT 1 FROM audit_mutation_context WHERE id=1) AND (OLD.cover_attachment_id IS NOT NEW.cover_attachment_id OR OLD.cover_x IS NOT NEW.cover_x OR OLD.cover_y IS NOT NEW.cover_y)
BEGIN
 INSERT INTO audit_events(id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id)
 SELECT lower(hex(randomblob(16))),NEW.workspace_id,actor_type,actor_id,'page.cover','page',NEW.id,'success',committed_at,correlation_id FROM audit_mutation_context WHERE id=1;
END;
