export const USAGE_SCHEMA = "notes.usage.v1";
// Append-only: double positions are shared by the writer and SQL reader.
export const USAGE_COUNTERS = [
  "requests",
  "durationMs",
  "bytes",
  "r2ClassA",
  "r2ClassB",
  "d1RowsRead",
  "d1RowsWritten",
  "embeddingTokens",
  "vectorQueryDimensions",
  "vectorWriteDimensions",
  "d1Queries",
  "d1MeasuredQueries",
  "operations",
] as const;
export type UsageCounter = (typeof USAGE_COUNTERS)[number];
export type UsageCounters = Record<UsageCounter, number>;
export type CostWindow = "24h" | "7d" | "30d";
export type CostSort = "cost" | "requests" | "latency";
export type CostRow = {
  pageId: string | null;
  title: string;
  usage: UsageCounters;
  estimatedCostUsd: number;
  averageLatencyMs: number | null;
};
export type PlatformCostReport = {
  window: CostWindow;
  generatedAt: number;
  firstObservedAt: number | null;
  rateCardDate: string;
  totals: CostRow;
  shared: CostRow;
  pages: CostRow[];
  resources: Array<{
    resource: keyof typeof USAGE_RATES;
    units: number | null;
    rateUsdPerUnit: number;
    estimatedCostUsd: number | null;
  }>;
  coverage: { sampled: boolean; partial: boolean; unmeasured: string[] };
};
export function emptyUsage(): UsageCounters {
  return Object.fromEntries(USAGE_COUNTERS.map((key) => [key, 0])) as UsageCounters;
}
// Gross variable equivalents before shared account allowances; never an invoice.
// Rate sources and exclusions: docs/implementation/cloudflare-production-enablement.md
export const USAGE_RATES = {
  requests: 0.3 / 1_000_000,
  r2ClassA: 4.5 / 1_000_000,
  r2ClassB: 0.36 / 1_000_000,
  d1RowsRead: 0.001 / 1_000_000,
  d1RowsWritten: 1 / 1_000_000,
  embeddingTokens: 0.0202 / 1_000_000,
  vectorQueryDimensions: 0.01 / 1_000_000,
  vectorWriteDimensions: 0.01 / 1_000_000,
} as const;
export const RATE_CARD_DATE = "2026-11-22";
export function usageCost(usage: UsageCounters) {
  return Object.entries(USAGE_RATES).reduce(
    (sum, [key, rate]) => sum + usage[key as keyof typeof USAGE_RATES] * rate,
    0,
  );
}
