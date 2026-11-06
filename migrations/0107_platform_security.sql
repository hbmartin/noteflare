-- Public access grants, explicit Access identities, and resumable key migration.
ALTER TABLE share_links ADD COLUMN password_hash TEXT;
ALTER TABLE share_links ADD COLUMN expires_at INTEGER;
ALTER TABLE share_links ADD COLUMN access_generation INTEGER NOT NULL DEFAULT 1;
CREATE TABLE share_access_grants (
 token_hash TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL, hostname TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX share_access_expiry ON share_access_grants(expires_at);
CREATE TABLE share_access_exchanges (
 code_hash TEXT PRIMARY KEY, share_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
 generation INTEGER NOT NULL, hostname TEXT NOT NULL, return_path TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX share_exchange_expiry ON share_access_exchanges(expires_at);
CREATE TABLE access_identities (
 issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL, PRIMARY KEY(issuer,subject), UNIQUE(issuer,user_id)
);
CREATE TABLE access_primary_proofs (
 session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, issuer TEXT NOT NULL, subject TEXT NOT NULL,
 security_generation INTEGER NOT NULL, expires_at INTEGER NOT NULL,
 FOREIGN KEY(issuer,subject) REFERENCES access_identities(issuer,subject) ON DELETE CASCADE
);
CREATE TABLE encryption_rotation_progress (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 purpose TEXT NOT NULL, target_key_id TEXT NOT NULL, source TEXT NOT NULL,
 cursor TEXT NOT NULL DEFAULT '', scanned INTEGER NOT NULL DEFAULT 0,
 changed INTEGER NOT NULL DEFAULT 0, completed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,purpose,target_key_id,source)
);
