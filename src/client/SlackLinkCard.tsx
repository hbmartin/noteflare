import { useEffect, useRef, useState } from "react";
import type { SlackLinkPreview } from "../shared/slack-links";
import { api, apiErrorMessage, json } from "./api";

export function SlackLinkCard({ url }: { url: string }) {
  const [preview, setPreview] = useState<SlackLinkPreview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    const clear = () => {
      request.current?.abort();
      setPreview(null);
    };
    window.addEventListener("offline", clear);
    window.addEventListener("notes:workspace-event", clear);
    const hidden = () => {
      if (document.hidden) clear();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      request.current?.abort();
      window.removeEventListener("offline", clear);
      window.removeEventListener("notes:workspace-event", clear);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    if (!preview) return undefined;
    const timer = setTimeout(() => setPreview(null), 15_000);
    return () => clearTimeout(timer);
  }, [preview]);
  async function load() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const result = await api<{ preview: SlackLinkPreview }>("/api/slack/link-preview", {
        method: "POST",
        readOnly: true,
        body: json({ url }),
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setPreview(result.preview);
    } catch (cause) {
      if (!controller.signal.aborted) setError(apiErrorMessage(cause, "The Slack message could not be previewed."));
    } finally {
      if (request.current === controller) setBusy(false);
    }
  }
  return (
    <section className="slack-private-preview" contentEditable={false}>
      <button type="button" disabled={busy} onClick={() => void load()}>
        {busy ? "Checking Slack access…" : "Preview privately"}
      </button>
      {preview && (
        <div>
          <small>Only visible to you · #{preview.channel}</small>
          <p>{preview.text}</p>
        </div>
      )}
      {error && <output>{error}</output>}
    </section>
  );
}
