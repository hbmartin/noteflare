-- Queue recovery timing is separate from when a consumer can execute the job.
ALTER TABLE platform_jobs ADD COLUMN queue_redispatch_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform_jobs ADD COLUMN queue_send_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE platform_jobs ADD COLUMN queue_dispatch_revision INTEGER NOT NULL DEFAULT 0;

-- This also covers generations written by publication triggers and older Workers.
CREATE TRIGGER platform_jobs_reset_queue_dispatch
AFTER UPDATE OF generation, available_at, lease_token ON platform_jobs
WHEN OLD.queue_dispatch_revision=NEW.queue_dispatch_revision
  AND (OLD.generation IS NOT NEW.generation OR OLD.available_at IS NOT NEW.available_at
       OR OLD.lease_token IS NOT NEW.lease_token)
BEGIN
  UPDATE platform_jobs
  SET queue_redispatch_at=0, queue_send_failures=0, queue_dispatch_revision=queue_dispatch_revision+1
  WHERE id=NEW.id;
END;
