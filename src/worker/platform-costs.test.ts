import { afterEach, expect, it, vi } from "vitest";
import { costOptions, costQueries, platformCosts } from "./platform-costs";
import type { Env } from "./env";
import { emptyUsage, usageCost, USAGE_COUNTERS, USAGE_RATES } from "../shared/platform-costs";
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  return {
    COST_REPORTING_ENABLED: "true",
    CF_ACCOUNT_ID: "a".repeat(32),
    OBSERVABILITY_DATASET: "notes",
    CF_ANALYTICS_API_TOKEN: "private-analytics-token",
    DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ all: async () => ({ results: [{ id: "page", title: "Page" }] }) })),
      })),
    },
  } as unknown as Env;
}
it("bounds the query interface and safely quotes identifiers and opaque IDs", () => {
  for (const query of ["window=all", "sort=drop", "pageId=", `pageId=${"x".repeat(129)}`])
    expect(() => costOptions(new URLSearchParams(query))).toThrow("Choose a supported usage");
  expect(() => costQueries("bad;drop", "workspace", { window: "7d", sort: "cost" })).toThrow(
    "invalid_analytics_dataset",
  );
  const queries = costQueries("notes", "workspace'quoted", { window: "24h", sort: "latency", pageId: "page'quoted" });
  expect(queries[2]).toContain("LIMIT 50");
  expect(queries[0]).toContain("workspace''quoted");
  expect(queries[0]).toContain("page''quoted");
  USAGE_COUNTERS.forEach((key, index) =>
    expect(queries[0]).toContain(`SUM(_sample_interval * double${index + 1}) AS ${key}`),
  );
});
it("emits supported decimal SQL rates without losing small resource prices", () => {
  const pages = costQueries("notes", "workspace", { window: "7d", sort: "cost" })[2]!;
  const rates = [...pages.matchAll(/\) \* (\d+\.\d+)/g)].map((match) => Number(match[1]));
  expect(pages).not.toMatch(/\d[eE][+-]\d/);
  expect(rates).toHaveLength(Object.keys(USAGE_RATES).length);
  Object.values(USAGE_RATES).forEach((rate, index) => {
    expect(rates[index]).toBeGreaterThan(0);
    expect(rates[index]).toBeCloseTo(rate, 20);
  });
});
it("returns weighted usage, rate estimates, and separate shared costs through server-only credentials", async () => {
  const usage = {
    ...emptyUsage(),
    requests: 10,
    operations: 5,
    durationMs: 250,
    r2ClassA: 2,
    d1Queries: 3,
    d1MeasuredQueries: 1,
  };
  const fetcher = vi.fn(async (_url, options) =>
    Response.json({
      data: [{ ...usage, pageId: "page", firstObserved: "2026-11-22 00:00:00", sampleInterval: 2 }].filter(
        () => !String(options.body).includes("AND blob3=''"),
      ),
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const report = await platformCosts(fixture(), crypto.randomUUID(), { window: "7d", sort: "cost" });
  expect(report.pages[0]).toMatchObject({
    pageId: "page",
    title: "Page",
    averageLatencyMs: 50,
    estimatedCostUsd: usageCost(usage),
  });
  expect(report.shared.usage.operations).toBe(0);
  expect(report.coverage.sampled).toBe(true);
  expect(report.resources.reduce((sum, item) => sum + item.estimatedCostUsd!, 0)).toBe(report.totals.estimatedCostUsd);
  expect(JSON.stringify(report)).not.toContain("private-analytics-token");
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("caches only successful scoped results and never shares workspace data", async () => {
  const fetcher = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal("fetch", fetcher);
  const env = fixture(),
    workspace = crypto.randomUUID(),
    options = { window: "24h", sort: "cost" } as const;
  const empty = await platformCosts(env, workspace, options);
  expect(empty.firstObservedAt).toBeNull();
  expect(empty.resources.every((item) => item.units === null && item.estimatedCostUsd === null)).toBe(true);
  await platformCosts(env, workspace, options);
  expect(fetcher).toHaveBeenCalledTimes(3);
  await platformCosts(env, crypto.randomUUID(), options);
  expect(fetcher).toHaveBeenCalledTimes(6);
});
it("keeps missing telemetry distinct from measured zero and sanitizes provider failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("private-provider-diagnostic", { status: 403 })),
  );
  await expect(platformCosts(fixture(), crypto.randomUUID(), { window: "7d", sort: "requests" })).rejects.toMatchObject(
    { status: 503, code: "cost_reporting_unavailable" },
  );
  const env = fixture();
  delete env.CF_ANALYTICS_API_TOKEN;
  await expect(platformCosts(env, "workspace", { window: "7d", sort: "requests" })).rejects.toMatchObject({
    status: 503,
  });
});
