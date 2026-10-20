CREATE TABLE comment_operations (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content_epoch INTEGER NOT NULL,
  thread_id TEXT NOT NULL REFERENCES comment_threads(id) ON DELETE CASCADE,
  request_hash TEXT NOT NULL,
  PRIMARY KEY(user_id,operation_id)
);
