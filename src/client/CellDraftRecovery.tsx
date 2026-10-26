import { CellDraftPersistenceRetry } from "./CellDraftPersistenceRetry";
import { useState } from "react";
import {
  discardCellDraft,
  useCellDrafts,
  cellDraftCleanupError,
  retryCellDraftCleanup,
  type StoredCellDraft,
  type CellDraftSelection,
} from "./cell-drafts";
function originalContext(draft: StoredCellDraft) {
  const host = draft.scope.host.match(/^\/api\/pages\/([^/]+)\/linked-tables\//)?.[1];
  try {
    return host ? decodeURIComponent(host) : draft.scope.tableId;
  } catch {
    return draft.scope.tableId;
  }
}
export function CellDraftRecovery({
  account,
  filter,
  scope,
  classify,
  save,
}: {
  account: string;
  filter?: (draft: StoredCellDraft) => boolean;
  scope?: CellDraftSelection;
  classify?: (draft: StoredCellDraft) => string;
  save?: (draft: StoredCellDraft, reviewed?: boolean) => Promise<boolean>;
}) {
  const drafts = useCellDrafts(account, scope, Boolean(scope)).filter(filter ?? (() => true));
  const [error, setError] = useState(""),
    [saving, setSaving] = useState<string | null>(null);
  const cleanupError = cellDraftCleanupError(account);
  if (!drafts.length && !error && !cleanupError) return null;
  return (
    <section aria-label="Pending cell edits">
      <h3>
        {drafts.length} pending cell {drafts.length === 1 ? "edit" : "edits"}
      </h3>
      {drafts.some((draft) => !draft.durable) && (
        <p role="alert">Draft storage is unavailable. Keep this tab open; these edits exist only in memory.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {cleanupError && (
        <p role="alert">
          {cleanupError}{" "}
          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              try {
                retryCellDraftCleanup(account);
                setError("");
              } catch {
                setError(cleanupError);
              }
            }}
          >
            Retry draft cleanup
          </button>
        </p>
      )}
      {drafts.map((draft) => {
        const state = classify?.(draft) ?? "Text recovery. Open the original table to verify access and save.";
        return (
          <div key={JSON.stringify([draft.scope, draft.rowId, draft.columnId])}>
            <p>{state}</p>
            <textarea aria-label="Recovered cell draft" readOnly value={draft.text} />
            {!draft.durable && <CellDraftPersistenceRetry draft={draft} />}
            {!save && <a href={`/?page=${encodeURIComponent(originalContext(draft))}`}>Open original table context</a>}
            {save && ["Ready to save", "Outside the loaded view"].includes(state) && (
              <button
                onMouseDown={(event) => event.preventDefault()}
                disabled={saving !== null}
                onClick={() => {
                  setSaving(draft.version);
                  void save(draft)
                    .catch(() => setError("The draft could not be saved. Your text is preserved."))
                    .finally(() => setSaving(null));
                }}
              >
                Save draft
              </button>
            )}
            {save && state.startsWith("Server value changed:") && (
              <button
                onMouseDown={(event) => event.preventDefault()}
                disabled={saving !== null}
                onClick={() => {
                  setSaving(draft.version);
                  void save(draft, true)
                    .catch(() => setError("The draft could not be saved. Your text is preserved."))
                    .finally(() => setSaving(null));
                }}
              >
                Keep my edit
              </button>
            )}
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(draft.text);
                } catch {
                  setError("Copy failed. Select and copy the text manually.");
                }
              }}
            >
              Copy draft
            </button>
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                try {
                  discardCellDraft(draft);
                } catch (cause) {
                  setError(String(cause));
                }
              }}
            >
              Discard draft
            </button>
          </div>
        );
      })}
    </section>
  );
}
