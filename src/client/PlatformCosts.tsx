/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- A named overflow region needs keyboard scrolling. */
import { useEffect, useId, useState } from "react";
import { api, apiErrorMessage } from "./api";
import type { CostSort, CostWindow, PlatformCostReport } from "../shared/platform-costs";
import "./PlatformCosts.css";

const money = (value: number) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(value);
const resourceNames = {
  requests: "Worker requests",
  r2ClassA: "R2 Class A operations",
  r2ClassB: "R2 Class B operations",
  d1RowsRead: "D1 rows read",
  d1RowsWritten: "D1 rows written",
  embeddingTokens: "Embedding tokens",
  vectorQueryDimensions: "Vector dimensions queried",
  vectorWriteDimensions: "Vector dimensions written",
};
export function PlatformCosts() {
  const id = useId();
  const [window, setWindow] = useState<CostWindow>("7d"),
    [sort, setSort] = useState<CostSort>("cost");
  const [revision, setRevision] = useState(0);
  const key = `${window}:${sort}:${revision}`;
  const [result, setResult] = useState<{ key: string; report?: PlatformCostReport; error?: string } | null>(null);
  const current = result?.key === key ? result : null;
  const report = current?.report,
    error = current?.error,
    loading = current === null;
  useEffect(() => {
    const controller = new AbortController();
    void api<PlatformCostReport>(`/api/platform/costs?window=${window}&sort=${sort}`, { signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted) setResult({ key, report: value });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setResult({ key, error: apiErrorMessage(cause, "Usage reporting is unavailable.") });
      });
    return () => controller.abort();
  }, [window, sort, key]);
  return (
    <section className="platform-costs">
      <h3>Usage and cost</h3>
      <p>
        Estimates cover measured variable resources before account allowances. Fixed subscriptions, CPU, live storage,
        and uninstrumented work are excluded. These amounts are not your Cloudflare bill.
      </p>
      <div className="platform-cost-controls">
        <label htmlFor={`${id}-window`}>Period</label>
        <select id={`${id}-window`} value={window} onChange={(event) => setWindow(event.target.value as CostWindow)}>
          <option value="24h">Last 24 hours</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
        </select>
        <label htmlFor={`${id}-sort`}>Sort pages by</label>
        <select id={`${id}-sort`} value={sort} onChange={(event) => setSort(event.target.value as CostSort)}>
          <option value="cost">Estimated cost</option>
          <option value="requests">Requests</option>
          <option value="latency">Average operation time</option>
        </select>
        <button type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>
          Refresh usage
        </button>
      </div>
      {loading && <progress aria-label="Loading usage" />}
      {error && <output>{error}</output>}
      {report && (
        <>
          {report.firstObservedAt === null ? (
            <p>No measured usage is available for this period.</p>
          ) : (
            <p>
              Measured total: {money(report.totals.estimatedCostUsd)} · shared work:{" "}
              {money(report.shared.estimatedCostUsd)} · {report.totals.usage.requests.toLocaleString()} requests.
            </p>
          )}
          <p>
            First available event in this period:{" "}
            {report.firstObservedAt === null ? "No data yet" : new Date(report.firstObservedAt).toLocaleString()}.
            Historical page costs are available only after collection starts.{" "}
            {report.coverage.sampled && "Counts are sampling-adjusted estimates."}
          </p>
          {report.pages.length ? (
            <section className="platform-cost-table" aria-labelledby={`${id}-caption`} tabIndex={0}>
              <table>
                <caption id={`${id}-caption`}>Top 50 pages by measured usage</caption>
                <thead>
                  <tr>
                    {[
                      "Page",
                      "Estimated USD",
                      "Requests",
                      "Average operation time",
                      "R2 operations",
                      "D1 measured rows",
                      "Embedding tokens",
                    ].map((label) => (
                      <th scope="col" key={label}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.pages.map((page, index) => (
                    <tr key={page.pageId ?? `deleted-${index}`}>
                      <th scope="row">
                        {page.pageId ? (
                          <a href={`/?page=${encodeURIComponent(page.pageId)}`}>{page.title || "Untitled"}</a>
                        ) : (
                          page.title
                        )}
                      </th>
                      <td data-label="Estimated USD">{money(page.estimatedCostUsd)}</td>
                      <td data-label="Requests">{page.usage.requests.toLocaleString()}</td>
                      <td data-label="Average operation time">
                        {page.averageLatencyMs === null
                          ? "Unavailable"
                          : `${page.averageLatencyMs.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`}
                      </td>
                      <td data-label="R2 operations">
                        A: {page.usage.r2ClassA.toLocaleString()} · B: {page.usage.r2ClassB.toLocaleString()}
                      </td>
                      <td data-label="D1 measured rows">
                        {page.usage.d1MeasuredQueries
                          ? `${page.usage.d1RowsRead.toLocaleString()} read · ${page.usage.d1RowsWritten.toLocaleString()} written`
                          : "Unavailable"}
                      </td>
                      <td data-label="Embedding tokens">{page.usage.embeddingTokens.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : (
            <p>No page-attributed usage in this period. Background and multi-page work appears in the shared total.</p>
          )}
          <details>
            <summary>Coverage and rates</summary>
            <p>
              Rate card: {report.rateCardDate}. Reports may lag ingestion and are cached for up to 60 seconds. Average
              operation time measures elapsed time, including I/O, and is not billed CPU.
            </p>
            <ul>
              {report.coverage.unmeasured.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <ul>
              {report.resources.map((resource) => (
                <li key={resource.resource}>
                  {resourceNames[resource.resource]}:{" "}
                  {resource.units === null ? "Unavailable" : resource.units.toLocaleString()}
                  {resource.estimatedCostUsd !== null && ` · ${money(resource.estimatedCostUsd)}`}
                </li>
              ))}
            </ul>
            {report.firstObservedAt !== null && (
              <p>{report.totals.usage.bytes.toLocaleString()} known response bytes.</p>
            )}
          </details>
        </>
      )}
    </section>
  );
}
