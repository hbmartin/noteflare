import { useEffect, useState } from "react";
import type { Backlink, SearchResponse, SearchResult } from "../shared/types";
import { api } from "./api";

export function BacklinksPanel({
  pageId,
  revision,
  onSelect,
}: {
  pageId: string;
  revision: number;
  onSelect: (pageId: string) => void;
}) {
  const [result, setResult] = useState<{
    pageId: string;
    revision: number;
    backlinks: Backlink[];
    error: string;
  }>(() => ({ pageId, revision, backlinks: [], error: "" }));
  const [relatedResult, setRelatedResult] = useState<{
    pageId: string;
    revision: number;
    related: SearchResult[];
    status?: SearchResponse["retrievalStatus"];
  }>();
  useEffect(() => {
    const controller = new AbortController();
    void api<{ related: SearchResult[]; retrievalStatus: SearchResponse["retrievalStatus"] }>(
      `/api/pages/${pageId}/related`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!controller.signal.aborted)
          setRelatedResult({
            pageId,
            revision,
            related: data.related ?? [],
            status: data.retrievalStatus ?? "disabled",
          });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRelatedResult({ pageId, revision, related: [], status: "unavailable" });
      });
    return () => controller.abort();
  }, [pageId, revision]);
  const related = relatedResult?.pageId === pageId && relatedResult.revision === revision ? relatedResult : undefined;
  const currentResult = result.pageId === pageId && result.revision === revision;
  const backlinks = currentResult ? result.backlinks : [];
  const error = currentResult ? result.error : "";
  useEffect(() => {
    let active = true;
    void api<{ backlinks: Backlink[] }>(`/api/pages/${pageId}/backlinks`)
      .then((data) => {
        if (active) setResult({ pageId, revision, backlinks: data.backlinks, error: "" });
      })
      .catch(() => {
        if (active) {
          setResult({ pageId, revision, backlinks: [], error: "Backlinks could not be loaded. Try again." });
        }
      });
    return () => {
      active = false;
    };
  }, [pageId, revision]);
  return (
    <aside className="side-panel backlinks-panel">
      <h2>Backlinks</h2>
      <p className="muted">Pages that mention this page.</p>
      {error && <p className="form-error">{error}</p>}
      <div className="backlink-list">
        {backlinks.map((backlink) => (
          <button key={backlink.page.id} onClick={() => onSelect(backlink.page.id)}>
            <strong>
              {backlink.page.icon ?? "□"} {backlink.page.title}
            </strong>
            <span>{backlink.excerpt || "No preview yet."}</span>
          </button>
        ))}
        {!error && !backlinks.length && <p className="empty-copy">No pages link here yet.</p>}
      </div>
      {related && related.status !== "disabled" && (
        <section aria-label="Related pages">
          <h2>Related pages</h2>
          <p className="muted">Pages with similar content.</p>
          <div className="backlink-list">
            {related.related.map((item) => (
              <button key={item.page.id} onClick={() => onSelect(item.page.id)}>
                <strong>
                  {item.page.icon ?? "□"} {item.page.title}
                </strong>
                <span>{item.snippet.text}</span>
              </button>
            ))}
            {!related.related.length && (
              <p className="empty-copy">
                {related.status === "available"
                  ? "No related pages yet."
                  : "Related pages are temporarily unavailable."}
              </p>
            )}
          </div>
        </section>
      )}
    </aside>
  );
}
