-- Private preparations never enter public comment/search/integration tables.
CREATE TABLE anchored_comment_submissions (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content_epoch INTEGER NOT NULL,
  thread_id TEXT NOT NULL,
  comment_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  body_json TEXT,
  state TEXT NOT NULL CHECK(state IN ('prepared','published','canceled','expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  anchor_token TEXT,
  anchor_expires_at INTEGER,
  PRIMARY KEY(user_id,operation_id)
);
CREATE INDEX idx_anchored_comment_expiry ON anchored_comment_submissions(state,expires_at);
-- A failed guard rolls back the entire D1 publication batch, including fanout.
CREATE TABLE anchored_comment_publication_guards (
  user_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  ok INTEGER NOT NULL CONSTRAINT anchored_comment_publication_conflict CHECK(ok=1),
  PRIMARY KEY(user_id,operation_id)
);
