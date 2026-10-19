-- Legacy unaccepted staging evidence may mix valid identities with primitives.
-- Replace the 0092 triggers without changing already-applied migration history.
DROP TRIGGER deletion_evidence_lookup_update;
CREATE TRIGGER deletion_evidence_lookup_update AFTER UPDATE OF job_id,kind,target ON deletion_targets WHEN (OLD.kind='table_do' AND json_valid(OLD.target) AND json_extract(OLD.target,'$.stage')='evidence') OR (NEW.kind='table_do' AND json_valid(NEW.target) AND json_extract(NEW.target,'$.stage')='evidence') BEGIN
 DELETE FROM deletion_evidence_lookup WHERE job_id=OLD.job_id
  AND OLD.kind='table_do' AND json_valid(OLD.target) AND json_extract(OLD.target,'$.stage')='evidence'
  AND table_id=json_extract(OLD.target,'$.pageId')
  AND detail_page_id IN(SELECT json_extract(CASE WHEN type='object' THEN value ELSE json_object() END,'$.detailPageId') FROM json_each(OLD.target,'$.records'))
  AND detail_page_id NOT IN(SELECT detail_page_id FROM deletion_evidence_records
    WHERE job_id=OLD.job_id AND table_id=json_extract(OLD.target,'$.pageId'));
 INSERT OR IGNORE INTO deletion_evidence_lookup
  SELECT DISTINCT job_id,table_id,workspace_id,generation,detail_page_id,row_id,source_kind
  FROM deletion_evidence_records WHERE job_id=NEW.job_id AND source_target=NEW.target;
END;

DROP TRIGGER deletion_evidence_lookup_delete;
CREATE TRIGGER deletion_evidence_lookup_delete AFTER DELETE ON deletion_targets WHEN OLD.kind='table_do' AND json_valid(OLD.target) AND json_extract(OLD.target,'$.stage')='evidence' BEGIN
 DELETE FROM deletion_evidence_lookup WHERE job_id=OLD.job_id
  AND OLD.kind='table_do' AND json_valid(OLD.target) AND json_extract(OLD.target,'$.stage')='evidence'
  AND table_id=json_extract(OLD.target,'$.pageId')
  AND detail_page_id IN(SELECT json_extract(CASE WHEN type='object' THEN value ELSE json_object() END,'$.detailPageId') FROM json_each(OLD.target,'$.records'))
  AND detail_page_id NOT IN(SELECT detail_page_id FROM deletion_evidence_records
    WHERE job_id=OLD.job_id AND table_id=json_extract(OLD.target,'$.pageId'));
END;
