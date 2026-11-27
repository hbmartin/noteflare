-- Existing rows keep matching their legacy cooldowns until they finish.
ALTER TABLE platform_jobs ADD COLUMN dispatch_incarnation TEXT;

-- All insert paths, including publication triggers and older Workers, get a fresh token.
CREATE TRIGGER platform_jobs_assign_dispatch_incarnation
AFTER INSERT ON platform_jobs WHEN NEW.dispatch_incarnation IS NULL
BEGIN
  UPDATE platform_jobs SET dispatch_incarnation=lower(hex(randomblob(16))) WHERE id=NEW.id;
END;
