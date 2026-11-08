-- Preserve healthy captures and active manifests; only budget automatic state repair.
ALTER TABLE publications ADD COLUMN build_state_recovery_count INTEGER NOT NULL DEFAULT 0
 CHECK(build_state_recovery_count IN (0,1));
CREATE TRIGGER publications_state_recovery_reset AFTER UPDATE OF access_generation,active ON publications
WHEN (OLD.access_generation<>NEW.access_generation OR NEW.active=0) AND NEW.build_state_recovery_count<>0
BEGIN UPDATE publications SET build_state_recovery_count=0 WHERE id=NEW.id; END;
