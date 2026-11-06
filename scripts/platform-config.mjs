const need = (condition, message) => {
  if (!condition) throw new Error(`Platform configuration: ${message}`);
};
/** Validate explicit optional configuration without creating or subscribing to products. */
export function validatePlatformConfiguration(config, { secretNames, publicWorker = false } = {}) {
  const vars = config.vars ?? {},
    names = new Set(secretNames ?? []);
  const enabled = (flag) => vars[flag] === "true";
  const has = (kind, binding) => (config[kind] ?? []).some((item) => item.binding === binding || item.name === binding);
  const secret = (name) => {
    if (secretNames) need(names.has(name), `set the ${name} Worker secret before enabling this capability`);
  };
  if (publicWorker) secret("BETTER_AUTH_SECRET");
  if (enabled("SEMANTIC_SEARCH_ENABLED")) {
    need(config.ai?.binding === "AI", "AI binding is required");
    need(has("vectorize", "SEMANTIC_INDEX"), "SEMANTIC_INDEX binding is required");
  }
  if (enabled("IMAGES_ENABLED")) need(config.images?.binding === "IMAGES", "IMAGES binding is required");
  if (enabled("TURNSTILE_ENABLED")) {
    need(!!vars.TURNSTILE_SITE_KEY, "TURNSTILE_SITE_KEY is required");
    secret("TURNSTILE_SECRET_KEY");
  }
  if (enabled("FORMS_ENABLED")) {
    need(enabled("TABLE_AUTHORITY_ENABLED"), "Forms requires TableAuthority");
    need(enabled("TURNSTILE_ENABLED"), "Forms requires Turnstile");
    need(!!vars.PUBLIC_BASE_URL, "Forms requires the canonical PUBLIC_BASE_URL");
  }
  if (enabled("TABLE_GALLERY_ENABLED")) need(enabled("TABLE_AUTHORITY_ENABLED"), "Galleries require TableAuthority");
  if (enabled("PUBLIC_PUBLISHING_ENABLED") || publicWorker) {
    need(has("r2_buckets", "PUBLICATIONS_BUCKET"), "a separate private PUBLICATIONS_BUCKET is required");
    const original = config.r2_buckets?.find((row) => row.binding === "BUCKET"),
      published = config.r2_buckets?.find((row) => row.binding === "PUBLICATIONS_BUCKET");
    need(
      original?.bucket_name !== published?.bucket_name,
      "publication storage must not reuse the mixed-use attachment bucket",
    );
    let url;
    try {
      url = new URL(vars.PUBLIC_BASE_URL);
    } catch {
      need(false, "PUBLIC_BASE_URL must be an HTTPS origin");
    }
    need(
      url.protocol === "https:" &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        !url.username &&
        !url.password &&
        !url.hostname.endsWith(".workers.dev"),
      "PUBLIC_BASE_URL requires a custom HTTPS hostname",
    );
    need(vars.PUBLIC_BASE_URL !== vars.BETTER_AUTH_URL, "private and public origins must be separate");
  }
  if (vars.AUTH_MODE === "access_required") {
    need(!!vars.ACCESS_TEAM_DOMAIN && !!vars.ACCESS_AUD, "Access requires team issuer and audience");
    let url;
    try {
      url = new URL(vars.BETTER_AUTH_URL);
    } catch {
      need(false, "Access requires an explicit canonical app origin");
    }
    need(
      url.protocol === "https:" && !url.hostname.endsWith(".workers.dev"),
      "Access requires a custom canonical app hostname",
    );
  } else need(vars.AUTH_MODE === undefined || vars.AUTH_MODE === "local", "AUTH_MODE must be local or access_required");
  if (enabled("CUSTOM_HOSTNAMES_ENABLED")) {
    need(
      enabled("PUBLIC_PUBLISHING_ENABLED") && !!vars.CF_ZONE_ID && !!vars.SAAS_CNAME_TARGET,
      "custom hostnames require publishing, CF_ZONE_ID and SAAS_CNAME_TARGET",
    );
    secret("CF_SAAS_API_TOKEN");
  }
  if (enabled("BASIN_ENABLED")) {
    need(
      has("pipelines", "AUDIT_PIPELINE") && has("pipelines", "HEATMAP_PIPELINE"),
      "Basin requires both explicitly provisioned pipeline bindings and Workers Paid",
    );
  }
  if (enabled("HEATMAPS_ENABLED")) secret("HEATMAP_HMAC_KEY");
  if (names.has("CF_CACHE_PURGE_API_TOKEN")) {
    need(!publicWorker, "configure cache purge credentials on the private application Worker only");
    need(!!vars.CF_ZONE_ID && !!vars.PUBLIC_BASE_URL, "cache purges require CF_ZONE_ID and PUBLIC_BASE_URL");
    need(
      config.durable_objects?.bindings?.some((binding) => binding.name === "PLATFORM"),
      "cache purges require PLATFORM recovery",
    );
    let publicOrigin;
    try {
      publicOrigin = new URL(vars.PUBLIC_BASE_URL);
    } catch {
      need(false, "cache purges require a canonical public HTTPS origin");
    }
    need(
      publicOrigin.protocol === "https:" &&
        publicOrigin.pathname === "/" &&
        !publicOrigin.search &&
        !publicOrigin.hash &&
        !publicOrigin.username &&
        !publicOrigin.password &&
        !publicOrigin.hostname.endsWith(".workers.dev"),
      "cache purges require a canonical public HTTPS origin",
    );
  }
  if (
    !publicWorker &&
    [
      "SEMANTIC_SEARCH_ENABLED",
      "PUBLIC_PUBLISHING_ENABLED",
      "AUDIT_ENABLED",
      "HEATMAPS_ENABLED",
      "IMAGES_ENABLED",
      "FORMS_ENABLED",
    ].some(enabled)
  )
    need(
      config.durable_objects?.bindings?.some((binding) => binding.name === "PLATFORM"),
      "PLATFORM coordinator is required for durable recovery",
    );
  for (const [name, fallback, maximum] of [
    ["SEMANTIC_MAX_STORED_CHUNKS", 10000, 1000000],
    ["SEMANTIC_DAILY_TOKEN_LIMIT", 100000, 100000000],
    ["FORMS_DAILY_LIMIT", 100, 100000],
    ["AUDIT_HOT_DAYS", 30, 365],
    ["AUDIT_ARCHIVE_DAYS", 365, 3650],
  ]) {
    const value = Number(vars[name] ?? fallback);
    need(
      Number.isSafeInteger(value) && value >= 1 && value <= maximum,
      `${name} must be an integer from 1 to ${maximum}`,
    );
  }
}
