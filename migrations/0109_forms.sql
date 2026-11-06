-- Compatibility principal for NOT NULL table_rows.created_by. Never a workspace member or login account.
-- Retain the exclusion even after workspace deletion; the identity must never become login-capable.
CREATE TABLE service_identities (
 user_id TEXT PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind='public_form')
);
CREATE TABLE public_forms (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, url_key TEXT NOT NULL UNIQUE,
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', success_message TEXT NOT NULL DEFAULT 'Thank you. Your response was received.',
 fields_json TEXT NOT NULL CHECK(json_valid(fields_json)), version INTEGER NOT NULL DEFAULT 1,
 active INTEGER NOT NULL DEFAULT 0, expires_at INTEGER, created_by TEXT NOT NULL REFERENCES user(id),
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX public_forms_page ON public_forms(page_id);
CREATE TRIGGER forms_column_update AFTER UPDATE OF type,property_generation ON table_columns
WHEN OLD.type IS NOT NEW.type OR OLD.property_generation IS NOT NEW.property_generation BEGIN
 UPDATE public_forms SET active=0,version=version+1,updated_at=unixepoch()*1000 WHERE page_id=NEW.page_id;
END;
CREATE TRIGGER forms_column_delete BEFORE DELETE ON table_columns BEGIN
 UPDATE public_forms SET active=0,version=version+1,updated_at=unixepoch()*1000 WHERE page_id=OLD.page_id;
END;
CREATE TRIGGER forms_option_delete BEFORE DELETE ON table_select_options BEGIN
 UPDATE public_forms SET active=0,version=version+1,updated_at=unixepoch()*1000 WHERE page_id=(SELECT page_id FROM table_columns WHERE id=OLD.column_id);
END;

CREATE TABLE public_form_attempts (
 form_id TEXT NOT NULL REFERENCES public_forms(id) ON DELETE CASCADE,
 source TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL,
 PRIMARY KEY(form_id,source)
);
CREATE INDEX public_form_attempts_expiry ON public_form_attempts(window);
