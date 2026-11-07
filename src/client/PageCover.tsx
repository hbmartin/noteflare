import { useState } from "react";
import type { Page } from "../shared/types";
import { api, apiErrorMessage, json } from "./api";
import { uploadAttachment } from "./uploads";
export function PageCover({
  page,
  editable,
  enabled = false,
  onChanged,
}: {
  page: Page;
  editable: boolean;
  enabled?: boolean;
  onChanged: (page: Page) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save(attachmentId: string | null, x = page.cover?.x ?? 0.5, y = page.cover?.y ?? 0.5) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ page: Page }>(`/api/pages/${page.id}/cover`, {
        method: "PATCH",
        body: json({ attachmentId, x, y, revision: page.revision }),
      });
      onChanged(result.page);
    } catch (cause) {
      setError(apiErrorMessage(cause, "The cover could not be changed."));
    } finally {
      setBusy(false);
    }
  }
  if (!enabled) return null;
  return (
    <div className="page-cover">
      {page.cover && (
        <img
          src={`/api/media/${page.cover.attachmentId}/cover-v1`}
          alt=""
          style={{ width: "100%", maxHeight: 300, objectFit: "cover" }}
        />
      )}
      {editable && (
        <details>
          <summary>{page.cover ? "Change cover" : "Add cover"}</summary>
          <label>
            Upload image (up to 10 MiB)
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
              disabled={busy}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (!file) return;
                if (file.size > 10 * 1024 * 1024) {
                  setError("Choose an image of at most 10 MiB.");
                  return;
                }
                setBusy(true);
                void uploadAttachment(page.id, file)
                  .then((attachment) => save(attachment.id))
                  .catch((cause) => {
                    setError(apiErrorMessage(cause, "The image could not be uploaded."));
                    setBusy(false);
                  });
              }}
            />
          </label>
          {page.cover && (
            <>
              <label>
                Horizontal focus
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  defaultValue={page.cover.x}
                  disabled={busy}
                  onChange={(event) => void save(page.cover!.attachmentId, Number(event.currentTarget.value))}
                />
              </label>
              <label>
                Vertical focus
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  defaultValue={page.cover.y}
                  disabled={busy}
                  onChange={(event) =>
                    void save(page.cover!.attachmentId, page.cover!.x, Number(event.currentTarget.value))
                  }
                />
              </label>
              <button disabled={busy} onClick={() => void save(null)}>
                Remove cover
              </button>
            </>
          )}
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
