import { api, ApiClientError, json } from "./api";

export type BookmarkPreview = {
  id: string;
  url: string;
  title: string;
  description: string;
  siteName: string;
  imageUrl: string | null;
  expiresAt: number;
};
export type BookmarkPreviewResult = { preview: BookmarkPreview | null; error: unknown };
type Entry = {
  listeners: Set<(result: BookmarkPreviewResult) => void>;
  controller: AbortController;
  result: BookmarkPreviewResult | null;
  expiresAt: number;
};
const entries = new Map<string, Entry>();
const MAX_ENTRIES = 128;

/** Public metadata only. Private provider previews must use a separate authorization-aware cache. */
export function subscribeBookmarkPreview(
  account: string,
  url: string,
  receive: (result: BookmarkPreviewResult) => void,
) {
  const key = JSON.stringify([account, url]);
  let entry = entries.get(key);
  if (entry?.result && entry.expiresAt <= Date.now()) {
    entries.delete(key);
    entry = undefined;
  }
  if (!entry) {
    for (const [candidate, value] of entries) {
      if (entries.size < MAX_ENTRIES) break;
      if (value.listeners.size === 0 && value.result) entries.delete(candidate);
    }
    if (entries.size >= MAX_ENTRIES) {
      receive({ preview: null, error: new Error("Too many previews are loading. Try again shortly.") });
      return () => undefined;
    }
    entry = { listeners: new Set(), controller: new AbortController(), result: null, expiresAt: 0 };
    const current = entry;
    entries.set(key, current);
    void api<{ preview: BookmarkPreview }>("/api/link-previews", {
      method: "POST",
      readOnly: true,
      body: json({ url }),
      signal: current.controller.signal,
    })
      .then(({ preview }) => {
        if (current.controller.signal.aborted) return;
        current.result = { preview, error: null };
        current.expiresAt = Math.min(preview.expiresAt, Date.now() + 5 * 60_000);
        for (const listener of current.listeners) listener(current.result);
      })
      .catch((error: unknown) => {
        if (current.controller.signal.aborted) return;
        current.result = { preview: null, error };
        current.expiresAt = Date.now() + (error instanceof ApiClientError && error.status >= 500 ? 5_000 : 30_000);
        for (const listener of current.listeners) listener(current.result);
      });
  }
  const listener = (result: BookmarkPreviewResult) => receive(result);
  entry.listeners.add(listener);
  if (entry.result) receive(entry.result);
  const current = entry;
  return () => {
    current.listeners.delete(listener);
    if (!current.listeners.size && !current.result) {
      current.controller.abort();
      if (entries.get(key) === current) entries.delete(key);
    }
  };
}
