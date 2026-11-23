import { ID_PATTERN } from "../shared/validation";
import { logger } from "./observability";
import type { Env } from "./env";
import { HttpError } from "./http";
import {
  USAGE_SCHEMA,
  USAGE_COUNTERS,
  USAGE_RATES,
  RATE_CARD_DATE,
  emptyUsage,
  usageCost,
  type CostWindow,
  type CostSort,
  type CostRow,
  type PlatformCostReport,
} from "../shared/platform-costs";

export type Options = { window: CostWindow; sort: CostSort; pageId?: string };
const windows = { "24h": 24, "7d": 168, "30d": 720 };
export function costOptions(parameters: URLSearchParams): Options {
  const window = parameters.get("window") ?? "7d",
    sort = parameters.get("sort") ?? "cost",
    pageId = parameters.get("pageId");
  if (
    !Object.hasOwn(windows, window) ||
    !["cost", "requests", "latency"].includes(sort) ||
    (pageId !== null && !ID_PATTERN.test(pageId))
  )
    throw new HttpError(422, "invalid_cost_query", "Choose a supported usage window, sort order and page ID.");
  return { window: window as CostWindow, sort: sort as CostSort, ...(pageId ? { pageId } : {}) };
}

const columns = USAGE_COUNTERS.map((key, index) => `SUM(_sample_interval * double${index + 1}) AS ${key}`).join(",\n");
const costExpression = Object.entries(USAGE_RATES)
  .map(
    ([key, rate]) =>
      // Analytics Engine accepts decimal literals, but rejects JavaScript's exponent notation.
      `SUM(_sample_interval * double${USAGE_COUNTERS.indexOf(key as keyof typeof USAGE_RATES) + 1}) * ${rate.toFixed(18)}`,
  )
  .join(" + ");
export function costQueries(dataset: string, workspaceId: string, options: Options) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(dataset)) throw new Error("invalid_analytics_dataset");
  if (!ID_PATTERN.test(workspaceId) || (options.pageId !== undefined && !ID_PATTERN.test(options.pageId)))
    throw new Error("analytics_identifier_invalid");
  const where = `FROM ${dataset} WHERE blob1='${USAGE_SCHEMA}' AND blob2='${workspaceId}' AND timestamp >= NOW() - INTERVAL '${windows[options.window]}' HOUR${options.pageId ? ` AND blob3='${options.pageId}'` : ""}`;
  const select = `${columns}, MIN(timestamp) AS firstObserved, MAX(_sample_interval) AS sampleInterval`;
  const order =
    options.sort === "cost" ? "estimatedCostUsd" : options.sort === "requests" ? "requests" : "durationMs / operations";
  return [
    `SELECT ${select} ${where} FORMAT JSON`,
    `SELECT ${select} ${where} AND blob3='' FORMAT JSON`,
    `SELECT blob3 AS pageId, ${select}, ${costExpression} AS estimatedCostUsd ${where} AND blob3<>'' GROUP BY pageId ORDER BY ${order} DESC, pageId ASC LIMIT 50 FORMAT JSON`,
  ];
}
async function query(env: Env, sql: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.CF_ANALYTICS_API_TOKEN}`, "content-type": "text/plain" },
      body: sql,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`analytics_http_${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("analytics_response_missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 512 * 1024) throw new Error("analytics_response_too_large");
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of chunks) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !value ||
    typeof value !== "object" ||
    !("data" in value) ||
    !Array.isArray(value.data) ||
    value.data.length > 50 ||
    value.data.some((item) => !item || typeof item !== "object" || Array.isArray(item))
  )
    throw new Error("analytics_response_invalid");
  return value.data;
}
function number(value: unknown) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value !== "number" && typeof value !== "string") throw new Error("analytics_counter_invalid");
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("analytics_counter_invalid");
  return parsed;
}
function row(source: Record<string, unknown> = {}, pageId: string | null = null, title = "Shared work"): CostRow {
  const usage = emptyUsage();
  for (const key of USAGE_COUNTERS) usage[key] = number(source[key]);
  return {
    pageId,
    title,
    usage,
    estimatedCostUsd: usageCost(usage),
    averageLatencyMs: usage.operations ? usage.durationMs / usage.operations : null,
  };
}
function analyticsFailureCode(error: unknown) {
  if (!(error instanceof Error)) return "analytics_failure";
  if (error.name === "TimeoutError" || error.name === "AbortError") return "analytics_timeout";
  if (error instanceof SyntaxError) return "analytics_response_invalid";
  const code = error.message;
  return /^analytics_http_[1-5]\d{2}$/.test(code) ||
    [
      "analytics_response_missing",
      "analytics_response_too_large",
      "analytics_response_invalid",
      "analytics_counter_invalid",
      "analytics_identifier_invalid",
      "analytics_page_invalid",
      "invalid_analytics_dataset",
    ].includes(code)
    ? code
    : "analytics_failure";
}
const cache = new Map<string, { expiresAt: number; value: PlatformCostReport }>();
export async function platformCosts(env: Env, workspaceId: string, options: Options): Promise<PlatformCostReport> {
  if (
    env.COST_REPORTING_ENABLED !== "true" ||
    !env.CF_ANALYTICS_API_TOKEN ||
    !/^[a-f0-9]{32}$/.test(env.CF_ACCOUNT_ID ?? "") ||
    !env.OBSERVABILITY_DATASET
  )
    throw new HttpError(
      503,
      "cost_reporting_unavailable",
      "Usage reporting needs the operator’s Analytics Read configuration.",
    );
  const key = JSON.stringify([env.CF_ACCOUNT_ID, env.OBSERVABILITY_DATASET, workspaceId, options]);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const [totals, shared, pages] = await Promise.all(
      costQueries(env.OBSERVABILITY_DATASET, workspaceId, options).map((sql) => query(env, sql)),
    );
    const ids = pages!.map((source) => {
      if (typeof source.pageId !== "string" || source.pageId.length > 128) throw new Error("analytics_page_invalid");
      return source.pageId;
    });
    const titles = ids.length
      ? await env.DB.prepare(
          "SELECT id,title FROM pages WHERE workspace_id=? AND id IN (SELECT value FROM json_each(?))",
        )
          .bind(workspaceId, JSON.stringify(ids))
          .all<{ id: string; title: string }>()
      : { results: [] };
    const names = new Map(titles.results.map((page) => [page.id, page.title]));
    const total = row(totals![0], null, "All measured work");
    const first = totals![0]?.firstObserved;
    const timestamp =
      total.usage.operations && typeof first === "string"
        ? Date.parse(first.includes("T") ? first : `${first.replace(" ", "T")}Z`)
        : NaN;
    const value: PlatformCostReport = {
      window: options.window,
      generatedAt: Date.now(),
      firstObservedAt: Number.isFinite(timestamp) ? timestamp : null,
      rateCardDate: RATE_CARD_DATE,
      totals: total,
      shared: row(shared![0]),
      resources: Object.entries(USAGE_RATES).map(([name, rate]) => {
        const resource = name as keyof typeof USAGE_RATES;
        const units = total.usage.operations ? total.usage[resource] : null;
        return { resource, units, rateUsdPerUnit: rate, estimatedCostUsd: units === null ? null : units * rate };
      }),
      pages: pages!.map((source) =>
        row(
          source,
          names.has(String(source.pageId)) ? String(source.pageId) : null,
          names.get(String(source.pageId)) ?? "Deleted page",
        ),
      ),
      coverage: {
        sampled: number(totals![0]?.sampleInterval) > 1,
        partial: true,
        unmeasured: [
          "Workers CPU and Durable Object duration",
          "Durable Object requests and SQLite storage operations",
          "Images transformations, Queues, Workflows, Analytics Engine ingestion and other AI models",
          "Live storage byte-days",
          "Fixed subscriptions and shared account allowances",
          "Installation work without a workspace attribution",
          "Streamed response bytes and uninstrumented background work",
          ...(total.usage.d1Queries > total.usage.d1MeasuredQueries ? ["D1 rows for first/raw queries"] : []),
        ],
      },
    };
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    cache.set(key, { expiresAt: Date.now() + 60_000, value });
    return value;
  } catch (error) {
    logger.warn("platform.costs.unavailable", "platform", "Usage reporting query failed.", {
      code: analyticsFailureCode(error),
    });
    throw new HttpError(
      503,
      "cost_reporting_unavailable",
      "Usage reporting is temporarily unavailable. Try again shortly.",
    );
  }
}
