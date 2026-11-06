import { useCallback, useEffect, useState } from "react";
import { api, apiErrorMessage, json } from "./api";
type Status = {
  capabilities: Record<string, { enabled: boolean; ready: boolean; missing: string[] }>;
  jobs: { kind: string; pending: number; oldestAt: number; failures: number }[];
  usage: { metric: string; period: string; amount: number }[];
  heatmapsEnabled: boolean;
  replication: boolean;
  queueConfigured: boolean;
  semantic: {
    indexedPages: number;
    storedChunks: number;
    installationStoredChunks: number;
    pendingPages: number;
    oldestPendingAt: number | null;
    buildingPages: number;
    today: { tokens: number; queries: number };
  };
  budgets: Record<string, number>;
  archive: { pending: number; oldestAt: number | null };
};
type AuditEvent = {
  id: string;
  committedAt: number;
  actorType: string;
  actorId: string | null;
  action: string;
  targetId: string | null;
  outcome: string;
};
type AuditPage = { events: AuditEvent[]; next: { before: number; beforeId: string } | null };
export function PlatformSettings() {
  const [status, setStatus] = useState<Status | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<AuditPage | null>(null),
    [actor, setActor] = useState(""),
    [action, setAction] = useState("");
  const load = useCallback(async () => {
    setStatus(await api<Status>("/api/platform"));
  }, []);
  useEffect(() => {
    let active = true;
    void api<Status>("/api/platform")
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch((cause) => {
        if (active) setError(apiErrorMessage(cause, "Platform status is unavailable."));
      });
    return () => {
      active = false;
    };
  }, []);

  const filters = () => new URLSearchParams({ ...(actor ? { actor } : {}), ...(action ? { action } : {}) });
  async function browseAudit(next = false) {
    setError("");
    setBusy(true);
    try {
      const params = filters();
      if (next && audit?.next) {
        params.set("before", String(audit.next.before));
        params.set("beforeId", audit.next.beforeId);
      }
      setAudit(await api<AuditPage>(`/api/audit?${params}`));
    } catch (cause) {
      setError(apiErrorMessage(cause, "Audit events could not be loaded."));
    } finally {
      setBusy(false);
    }
  }
  async function change(path: string, method: string, body?: unknown) {
    setError("");
    setBusy(true);
    try {
      await api(path, { method, ...(body !== undefined ? { body: json(body) } : {}) });
      await load();
    } catch (cause) {
      setError(apiErrorMessage(cause, "The platform setting could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section id="settings-platform">
      <h2>Cloudflare platform</h2>
      <p>
        Optional services use your Cloudflare account’s allowances. Budgets below are application limits; other
        applications may consume the same account quotas.
      </p>
      {error && <p role="alert">{error}</p>}
      <button
        disabled={busy}
        onClick={() => void load().catch((cause) => setError(apiErrorMessage(cause, "Status could not be refreshed.")))}
      >
        Refresh platform status
      </button>
      {status && (
        <>
          <table>
            <thead>
              <tr>
                <th>Capability</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(status.capabilities).map(([name, value]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td>{value.ready ? "Ready" : value.enabled ? `Missing: ${value.missing.join(", ")}` : "Disabled"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {status.replication ? "Read replication enabled" : "Primary database reads"} ·{" "}
            {status.queueConfigured ? "Platform queue configured" : "Durable alarm processing"}
          </p>
          <dl>
            {Object.entries(status.budgets).map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value.toLocaleString()}</dd>
              </div>
            ))}
          </dl>
          <h3>Search indexing</h3>
          <p>
            {status.semantic.indexedPages.toLocaleString()} indexed pages ·{" "}
            {status.semantic.pendingPages.toLocaleString()} changes pending ·{" "}
            {status.semantic.buildingPages.toLocaleString()} pages being processed.
          </p>
          <p>
            {status.semantic.storedChunks.toLocaleString()} chunks in this workspace;{" "}
            {status.semantic.installationStoredChunks.toLocaleString()} of{" "}
            {status.budgets.semanticChunks?.toLocaleString()} reserved chunks across the installation.
          </p>
          <p>
            Today’s installation usage: {status.semantic.today.tokens.toLocaleString()} embedding tokens and{" "}
            {status.semantic.today.queries.toLocaleString()} meaning searches. Related pages and automatic writing
            sources use this same allowance.
          </p>
          {status.semantic.oldestPendingAt !== null && (
            <p>Oldest pending change: {new Date(status.semantic.oldestPendingAt).toLocaleString()}.</p>
          )}
          <h3>Background work</h3>
          {status.jobs.length ? (
            <ul>
              {status.jobs.map((job) => (
                <li key={job.kind}>
                  {job.kind}: {job.pending} pending, {job.failures} awaiting retry; oldest{" "}
                  {new Date(job.oldestAt).toLocaleString()}
                </li>
              ))}
            </ul>
          ) : (
            <p>No pending platform jobs.</p>
          )}
          <button disabled={busy || !status.jobs.length} onClick={() => void change("/api/platform/retry", "POST")}>
            Retry pending work
          </button>
          <p>{status.archive.pending} audit events awaiting verified archive storage.</p>
          <details>
            <summary>Recent application usage</summary>
            <ul>
              {status.usage.map((row) => (
                <li key={`${row.metric}:${row.period}`}>
                  {row.period} · {row.metric}: {row.amount.toLocaleString()}
                </li>
              ))}
            </ul>
          </details>
          <h3>Reading heatmaps</h3>
          <p>
            Members can opt in to section reading summaries. Only completed weeks with at least five distinct readers
            are shown to the page creator and workspace owners. Raw summaries expire after seven days.
          </p>
          <label>
            <input
              type="checkbox"
              checked={status.heatmapsEnabled}
              disabled={busy || !status.capabilities.heatmaps?.ready}
              onChange={(event) => void change("/api/platform", "PATCH", { heatmapsEnabled: event.target.checked })}
            />
            Enable member reading summaries
          </label>
          <h3>Audit log</h3>
          <label>
            Actor ID
            <input value={actor} onChange={(event) => setActor(event.target.value)} />
          </label>
          <label>
            Action
            <input value={action} onChange={(event) => setAction(event.target.value)} />
          </label>
          <button disabled={busy} onClick={() => void browseAudit()}>
            Search audit log
          </button>{" "}
          <a href={`/api/audit?${filters()}&format=csv`} download>
            Export this page as CSV
          </a>
          {audit && (
            <>
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Actor</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.events.map((event) => (
                    <tr key={event.id}>
                      <td>{new Date(event.committedAt).toLocaleString()}</td>
                      <td>{event.actorId ?? event.actorType}</td>
                      <td>{event.action}</td>
                      <td>{event.targetId}</td>
                      <td>{event.outcome}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button disabled={busy || !audit.next} onClick={() => void browseAudit(true)}>
                Older events
              </button>
            </>
          )}
        </>
      )}
    </section>
  );
}
