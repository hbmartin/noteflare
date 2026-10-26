import { useState } from "react";
import { retryCellDraftPersistence, type StoredCellDraft } from "./cell-drafts";
/** This action only retries local storage; it never submits a table mutation. */
export function CellDraftPersistenceRetry({ draft }: { draft: StoredCellDraft }) {
  const [failedVersion, setFailedVersion] = useState<string>();
  return (
    <>
      <button
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setFailedVersion(retryCellDraftPersistence(draft) ? undefined : draft.version)}
      >
        Retry saving locally
      </button>
      {failedVersion === draft.version && (
        <output>Draft storage is still unavailable. Keep this tab open or copy your text.</output>
      )}
    </>
  );
}
