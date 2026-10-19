import { useCallback, useEffect, useRef, useState } from "react";
import type { DeletionJobSummary, DeletionJobsPage } from "../shared/deletion-jobs";
import { api, apiErrorMessage, ApiClientError } from "./api";

/** Mounted only for owners, keyed to the workspace, while Trash is visible. */
export function PendingDeletions() {
  const [jobs, setJobs] = useState<DeletionJobSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [accessLost, setAccessLost] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const requests = useRef<AbortController | null>(null);
  const lifetime = useRef(new AbortController());
  const loadedPages = useRef(1);
  const loadingRequest = useRef(false);
  const retrying = useRef(new Set<string>());

  const revokeAccess = useCallback(() => {
    lifetime.current.abort();
    requests.current?.abort();
    loadingRequest.current = false;
    setLoading(false);
    setJobs([]);
    setNextCursor(null);
    setAccessLost(true);
  }, []);

  const load = useCallback(
    async (cursor?: string) => {
      if (lifetime.current.signal.aborted) return;
      requests.current?.abort();
      const request = new AbortController();
      requests.current = request;
      loadingRequest.current = true;
      setLoading(true);
      try {
        let after = cursor ?? null;
        const incoming: DeletionJobSummary[] = [];
        for (let page = 0; page < (cursor ? 1 : loadedPages.current); page++) {
          const result = await api<DeletionJobsPage>(
            `/api/deletion-jobs${after ? `?cursor=${encodeURIComponent(after)}` : ""}`,
            { signal: request.signal },
          );
          if (request.signal.aborted) return;
          incoming.push(...result.jobs);
          after = result.nextCursor;
          if (!after) break;
        }
        if (request.signal.aborted) return;
        if (cursor) loadedPages.current++;
        setJobs((current) => [
          ...new Map([...(cursor ? current : []), ...incoming].map((job) => [job.id, job])).values(),
        ]);
        setNextCursor(after);
        setError("");
      } catch (cause) {
        if (request.signal.aborted) return;
        if (cause instanceof ApiClientError && (cause.status === 401 || cause.status === 403)) revokeAccess();
        else setError(apiErrorMessage(cause, "Pending deletions could not be loaded."));
      } finally {
        if (!request.signal.aborted) {
          loadingRequest.current = false;
          setLoading(false);
        }
      }
    },
    [revokeAccess],
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    queueMicrotask(() => {
      if (!controller.signal.aborted) void load();
    });
    return () => {
      controller.abort();
      requests.current?.abort();
    };
  }, [load]);

  const active = jobs.some((job) => job.status !== "blocked");
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      if (!loadingRequest.current) void load();
    }, 5_000);
    return () => clearInterval(timer);
  }, [active, load]);

  async function retry(jobId: string) {
    if (retrying.current.has(jobId)) return;
    retrying.current.add(jobId);
    setPending(new Set(retrying.current));
    const signal = lifetime.current.signal;
    try {
      await api(`/api/deletion-jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST", signal });
      if (!signal.aborted) await load();
    } catch (cause) {
      if (signal.aborted) return;
      if (cause instanceof ApiClientError && (cause.status === 401 || cause.status === 403)) revokeAccess();
      else if (cause instanceof ApiClientError && cause.status === 404) await load();
      else setError(apiErrorMessage(cause, "This deletion could not be checked again."));
    } finally {
      retrying.current.delete(jobId);
      if (!signal.aborted) setPending(new Set(retrying.current));
    }
  }

  if (accessLost) return null;

  return (
    <section aria-label="Pending permanent deletions">
      <h2>Pending permanent deletions</h2>
      <p className="muted">These deletions have already been accepted. Their pages cannot be restored.</p>
      <button className="quiet-button" disabled={loading} onClick={() => void load()}>
        Refresh pending deletions
      </button>
      {error && <p role="alert">{error}</p>}
      {loading && <output>Refreshing pending deletions…</output>}
      <div className="trash-list">
        {jobs.map((job) => (
          <div key={job.id}>
            <strong>{job.title}</strong>
            <span>
              {job.pageCount} {job.pageCount === 1 ? "page" : "pages"} ·{" "}
              {job.status === "blocked" ? "Paused" : job.status === "retrying" ? "Retry scheduled" : "Deleting"}
            </span>
            <p>{job.reason ?? "Permanent deletion is in progress."}</p>
            {job.canRetry && (
              <button disabled={pending.has(job.id)} onClick={() => void retry(job.id)}>
                {pending.has(job.id) ? "Checking…" : "Check again"}
              </button>
            )}
          </div>
        ))}
      </div>
      {nextCursor && (
        <button disabled={loading} onClick={() => void load(nextCursor)}>
          Load more pending deletions
        </button>
      )}
      {!jobs.length && !loading && !error && <p className="empty-copy">No pending permanent deletions.</p>}
    </section>
  );
}
