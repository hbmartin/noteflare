export const operatorFlags = {
  SEMANTIC_SEARCH_ENABLED: "Meaning-based search",
  IMAGES_ENABLED: "Images",
  PUBLIC_PUBLISHING_ENABLED: "Publishing",
  AUDIT_ENABLED: "Audit archives",
  TURNSTILE_ENABLED: "Turnstile",
  FORMS_ENABLED: "Forms",
  TABLE_AUTHORITY_ENABLED: "TableAuthority",
  COST_REPORTING_ENABLED: "Usage and cost",
  HEATMAPS_ENABLED: "Reading heatmaps",
  BASIN_ENABLED: "Basin export",
  CUSTOM_HOSTNAMES_ENABLED: "Customer hostnames",
  D1_READ_REPLICATION_ENABLED: "Read replication",
} as const;

export const operatorLimits = {
  SEMANTIC_MAX_STORED_CHUNKS: ["Stored search chunks", 10000],
  SEMANTIC_DAILY_QUERY_LIMIT: ["Daily meaning searches", 2000],
  SEMANTIC_DAILY_TOKEN_LIMIT: ["Daily embedding tokens", 100000],
  FORMS_DAILY_LIMIT: ["Daily Form submissions", 100],
  AUDIT_HOT_DAYS: ["Audit database retention (days)", 30],
  AUDIT_ARCHIVE_DAYS: ["Audit archive retention (days)", 365],
} as const;

export type OperatorValue = {
  value: boolean | number | string | null;
  source: "configured" | "default";
  missing: string[];
};
export type OperatorSnapshot = {
  origin: string | null;
  version: string | null;
  observedAt: number;
  values: Record<string, OperatorValue>;
};
export type OperatorSettings = {
  application: OperatorSnapshot;
  publicWorker: OperatorSnapshot | null;
};
