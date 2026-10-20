import { useCallback, useEffect, useRef, useState } from "react";
import type { DeletionJobSummary, DeletionJobsPage } from "../shared/deletion-jobs";
import { api, apiErrorMessage, ApiClientError } from "./api";

const STATUS_LABELS: Record<DeletionJobSummary["status"], string> = {
  blocked: "Paused",
  retrying: "Retry scheduled",
  pending: "Deleting",
};

async function fetchDeletionPages(
  cursor: string | undefined,
  pageLimit: number,
  signal: AbortSignal,
): Promise<DeletionJobsPage> {
  let after = cursor ?? null;
  const jobs: DeletionJobSummary[] = [];
  for (let page = 0; page < pageLimit; page++) {
    signal.throwIfAborted();
    const query = after ? `?cursor=${encodeURIComponent(after)}` : "";
    const result = await api<DeletionJobsPage>(`/api/deletion-jobs${query}`, { signal });
    signal.throwIfAborted();
    jobs.push(...result.jobs);
    after = result.nextCursor;
    if (!after) break;
  }
  return { jobs, nextCursor: after };
}

/** Mounted only for owners, keyed to the workspace, while Trash is visible. */
export function PendingDeletions() {
  const [jobs, setJobs] = useState<DeletionJobSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [accessLost, setAccessLost] = useState(false);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const requests = useRef<AbortController | null>(null);
  const lifetime = useRef(new AbortController());
  const loadedPages = useRef(1);
  const retrying = useRef(new Set<string>());

  const revokeAccess = useCallback(() => {
    lifetime.current.abort();
    requests.current?.abort();
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
      setLoading(true);
      try {
        const result = await fetchDeletionPages(cursor, cursor ? 1 : loadedPages.current, request.signal);
        if (request.signal.aborted) return;
        if (cursor) loadedPages.current++;
        setJobs((current) => [
          ...new Map([...(cursor ? current : []), ...result.jobs].map((job) => [job.id, job])).values(),
        ]);
        setNextCursor(result.nextCursor);
        setError("");
      } catch (cause) {
        if (request.signal.aborted) return;
        if (cause instanceof ApiClientError && (cause.status === 401 || cause.status === 403)) revokeAccess();
        else setError(apiErrorMessage(cause, "Pending deletions could not be loaded."));
      } finally {
        if (!request.signal.aborted) {
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

  useEffect(() => {
    if (loading || accessLost) return undefined;
    const active = jobs.filter((job) => job.status !== "blocked");
    if (!active.length) return undefined;
    const delay = active.some((job) => job.status === "pending")
      ? 5_000
      : Math.max(5_000, Math.min(60_000, ...active.map((job) => (job.nextAttemptAt ?? Date.now()) - Date.now())));
    const timer = setTimeout(() => void load(), delay);
    return () => clearTimeout(timer);
  }, [jobs, loading, accessLost, load]);

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
              {job.pageCount} {job.pageCount === 1 ? "page" : "pages"} · {STATUS_LABELS[job.status]}
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
