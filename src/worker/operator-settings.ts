import { operatorFlags, operatorLimits, type OperatorSnapshot } from "../shared/operator-settings";
import type { Env } from "./env";

const publicFlags = new Set([
  "IMAGES_ENABLED",
  "PUBLIC_PUBLISHING_ENABLED",
  "TURNSTILE_ENABLED",
  "FORMS_ENABLED",
  "TABLE_AUTHORITY_ENABLED",
  "COST_REPORTING_ENABLED",
]);

export function operatorSnapshot(env: Env, publicWorker = false): OperatorSnapshot {
  const dependencies: Partial<Record<keyof typeof operatorFlags, Record<string, boolean>>> = {
    SEMANTIC_SEARCH_ENABLED: { AI: !!env.AI, SEMANTIC_INDEX: !!env.SEMANTIC_INDEX, PLATFORM: !!env.PLATFORM },
    IMAGES_ENABLED: { IMAGES: !!env.IMAGES },
    PUBLIC_PUBLISHING_ENABLED: {
      PUBLICATIONS_BUCKET: !!env.PUBLICATIONS_BUCKET,
      PUBLIC_BASE_URL: !!env.PUBLIC_BASE_URL,
    },
    AUDIT_ENABLED: { archiveStorage: !!(env.AUDIT_BUCKET ?? env.BUCKET), PLATFORM: !!env.PLATFORM },
    TURNSTILE_ENABLED: { siteKey: !!env.TURNSTILE_SITE_KEY, secretKey: !!env.TURNSTILE_SECRET_KEY },
    FORMS_ENABLED: {
      TABLE_AUTHORITY_ENABLED: env.TABLE_AUTHORITY_ENABLED === "true",
      TURNSTILE_ENABLED: env.TURNSTILE_ENABLED === "true",
      PUBLIC_BASE_URL: !!env.PUBLIC_BASE_URL,
    },
    TABLE_AUTHORITY_ENABLED: { TABLE: !!env.TABLE },
    COST_REPORTING_ENABLED: {
      OBSERVABILITY: !!env.OBSERVABILITY,
      ...(!publicWorker && {
        analyticsRead: !!env.CF_ANALYTICS_API_TOKEN,
        analyticsDataset: !!env.OBSERVABILITY_DATASET,
      }),
    },
    HEATMAPS_ENABLED: { heatmapKey: !!env.HEATMAP_HMAC_KEY, PLATFORM: !!env.PLATFORM },
    BASIN_ENABLED: { AUDIT_PIPELINE: !!env.AUDIT_PIPELINE, HEATMAP_PIPELINE: !!env.HEATMAP_PIPELINE },
    CUSTOM_HOSTNAMES_ENABLED: {
      hostnameManagement: !!env.CF_SAAS_API_TOKEN,
      SAAS_CNAME_TARGET: !!env.SAAS_CNAME_TARGET,
    },
  };
  const values: OperatorSnapshot["values"] = {};
  for (const flag of Object.keys(operatorFlags) as (keyof typeof operatorFlags)[]) {
    if (publicWorker && !publicFlags.has(flag)) continue;
    const value = env[flag] === "true";
    values[flag] = {
      value,
      source: env[flag] === undefined ? "default" : "configured",
      missing: value
        ? Object.entries(dependencies[flag] ?? {})
            .filter(([, present]) => !present)
            .map(([key]) => key)
        : [],
    };
  }
  for (const key of Object.keys(operatorLimits) as (keyof typeof operatorLimits)[]) {
    if (publicWorker && key !== "FORMS_DAILY_LIMIT") continue;
    const value = Number(env[key] ?? operatorLimits[key][1]);
    values[key] = {
      value: Number.isFinite(value) ? value : null,
      source: env[key] === undefined ? "default" : "configured",
      missing: [],
    };
  }
  if (!publicWorker)
    values.AUTH_MODE = {
      value: env.AUTH_MODE === "access_required" ? "Cloudflare Access required" : "Local sign-in",
      source: env.AUTH_MODE === undefined ? "default" : "configured",
      missing:
        env.AUTH_MODE === "access_required" && (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN)
          ? ["Access configuration"]
          : [],
    };
  return {
    origin: (publicWorker ? env.PUBLIC_BASE_URL : env.BETTER_AUTH_URL) ?? null,
    version: env.CF_VERSION_METADATA?.id ?? null,
    observedAt: Date.now(),
    values,
  };
}

export async function readPublicOperatorSettings(env: Env): Promise<OperatorSnapshot | null> {
  if (!env.PUBLIC_OPERATOR_SETTINGS) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([
      env.PUBLIC_OPERATOR_SETTINGS.getOperatorSettings(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 2000);
      }),
    ]);
    return snapshot && Number.isFinite(snapshot.observedAt) && snapshot.values ? snapshot : null;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
