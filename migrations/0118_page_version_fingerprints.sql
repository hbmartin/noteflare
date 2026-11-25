-- Earlier Workers can keep inserting versions without a fingerprint.
ALTER TABLE page_versions ADD COLUMN content_fingerprint TEXT;
