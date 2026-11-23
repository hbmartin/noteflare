import { isDeepStrictEqual } from "node:util";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { unstable_readConfig } from "wrangler";
import { cloudflare } from "./deploy.mjs";
import { validatePlatformConfiguration } from "./platform-config.mjs";
import { notionOpenApi } from "../src/shared/notion-request-schemas.ts";

const ACCOUNT = "940db9a80e285cf3f700d5d903d8e182";
const ZONE = "986af780c629979d91800d7e569f4b9c";
const DAY = 86400;
const AUDIT_LOCK_DAYS = 365;
export function platformProfile(environment = "production") {
  if (!["production", "staging"].includes(environment)) throw new Error("Choose production or staging.");
  const name =
    environment === "production" ? "cloudflare-realtime-notes" : "cloudflare-realtime-notes-platform-staging";
  return {
    environment,
    name,
    account: ACCOUNT,
    zone: ZONE,
    publicName: `${name}-public`,
    appOrigin: `https://${environment === "production" ? "notes" : "notes-staging"}.sparkedinnovations.training`,
    publicOrigin: `https://${environment === "production" ? "public" : "public-staging"}.sparkedinnovations.training`,
    original: environment === "production" ? name : `${name}-originals`,
    publications: `${name}-publications`,
    audit: `${name}-audit`,
    index: `${name}-semantic`,
    dataset:
      environment === "production"
        ? "cloudflare_realtime_notes_production"
        : "cloudflare_realtime_notes_platform_staging",
  };
}
export function retentionRules() {
  return {
    lock: {
      id: "noteflare-audit-365d",
      enabled: true,
      prefix: "audit/",
      condition: { type: "Age", maxAgeSeconds: AUDIT_LOCK_DAYS * DAY },
    },
    lifecycle: [
      {
        id: "noteflare-link-previews-2d",
        enabled: true,
        conditions: { prefix: "link-previews/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 2 * DAY } },
      },
      {
        id: "noteflare-job-artifacts-8d",
        enabled: true,
        conditions: { prefix: "job-artifacts/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 8 * DAY } },
      },
    ],
  };
}
export function mergeRules(existing, wanted) {
  const rules = [...existing];
  for (const rule of wanted) {
    const index = rules.findIndex((item) => (rule.id && item.id === rule.id) || (rule.ref && item.ref === rule.ref));
    if (index === -1) rules.push(rule);
    else rules[index] = { ...rules[index], ...rule };
  }
  return rules;
}
export function edgeRules(profile) {
  const host = new URL(profile.publicOrigin).hostname;
  return {
    custom: [
      {
        ref: `noteflare_public_methods${profile.environment === "staging" ? "_staging" : ""}`,
        description: "NoteFlare public interaction methods",
        action: "block",
        enabled: true,
        expression: `(http.host eq "${host}" and ((starts_with(http.request.uri.path, "/forms/") and not http.request.method in {"GET" "POST"}) or (starts_with(http.request.uri.path, "/share/") and not http.request.method in {"GET" "HEAD"} and not (http.request.method eq "POST" and ends_with(http.request.uri.path, "/unlock")))))`,
      },
    ],
    rate: {
      ref: "noteflare_public_rate",
      description: "NoteFlare public Forms and shares",
      action: "block",
      enabled: true,
      expression: '(starts_with(http.request.uri.path, "/forms/") or starts_with(http.request.uri.path, "/share/"))',
      ratelimit: {
        characteristics: ["cf.colo.id", "ip.src"],
        period: 10,
        requests_per_period: 100,
        mitigation_timeout: 10,
      },
    },
  };
}
const features = {
  semantic: "SEMANTIC_SEARCH_ENABLED",
  images: "IMAGES_ENABLED",
  publishing: "PUBLIC_PUBLISHING_ENABLED",
  audit: "AUDIT_ENABLED",
  turnstile: "TURNSTILE_ENABLED",
  forms: "FORMS_ENABLED",
  tables: "TABLE_AUTHORITY_ENABLED",
  costs: "COST_REPORTING_ENABLED",
};
const publicFlags = new Set([
  features.images,
  features.publishing,
  features.turnstile,
  features.forms,
  features.tables,
  features.costs,
]);
export function parseActivation(option) {
  if (option === undefined) return [];
  const names = option
    .slice(9)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!option.startsWith("--enable=") || !names.length || names.some((name) => !Object.hasOwn(features, name)))
    throw new Error("Choose features with --enable=" + Object.keys(features).join(","));
  return [...new Set(names)];
}
export function assertSharedReleaseFlags(application, publicWorker) {
  const mismatched = [...publicFlags].flatMap((flag) => {
    const app = application[flag] ?? "false";
    const pub = publicWorker[flag] ?? "false";
    if (![app, pub].every((value) => value === "true" || value === "false"))
      throw new Error(`Invalid shared flag: ${flag}.`);
    return app === pub ? [] : [`${flag} (application ${app}, public ${pub})`];
  });
  if (mismatched.length)
    throw new Error(
      `Shared release flags differ: ${mismatched.join(", ")}. Align the live flags or explicitly enable the intended features in a fresh release.`,
    );
}
function liveVars(settings) {
  if (settings && !Array.isArray(settings.bindings)) throw new Error("Invalid Worker settings readback.");
  return Object.fromEntries(
    (settings?.bindings ?? []).filter((binding) => binding.type === "plain_text").map(({ name, text }) => [name, text]),
  );
}
function workerSettings(profile, api) {
  return Promise.all(
    [profile.name, profile.publicName].map((name) => api(`/workers/scripts/${name}/settings`, { allowMissing: true })),
  );
}
function hasInstalledSecret(settings, name) {
  return settings?.bindings.some((binding) => binding.name === name && binding.type === "secret_text");
}
export function turnstilePairing(settings, sitekey) {
  const vars = liveVars(settings);
  if (vars.TURNSTILE_SITE_KEY === sitekey) return "matched";
  if (
    !vars.TURNSTILE_SITE_KEY &&
    vars.TURNSTILE_ENABLED !== "true" &&
    !hasInstalledSecret(settings, "TURNSTILE_SECRET_KEY")
  )
    return "first";
  return "replace";
}
export function firstTurnstilePairWorkers(names, settings, sitekey) {
  return names.filter((worker, index) => {
    const pairing = turnstilePairing(settings[index], sitekey);
    if (pairing === "replace")
      throw new Error(
        `Live Turnstile pairing differs or is unknown for ${worker}. Prepare an explicit --replace-turnstile release.`,
      );
    return pairing === "first";
  });
}
export function settingsFingerprint(settings) {
  const vars = Object.entries(liveVars(settings)).sort(([a], [b]) => a.localeCompare(b));
  const secrets = (settings?.bindings ?? [])
    .filter((binding) => binding.type === "secret_text")
    .map((binding) => binding.name)
    .sort();
  return createHash("sha256")
    .update(JSON.stringify([!!settings, vars, secrets]))
    .digest("hex");
}
function releaseVars(profile, sitekey, baseline, live, enable, publicWorker = false) {
  // Dashboard settings win over defaults. Deployment identity comes from the verified profile.
  const vars = { ...baseline, ...live };
  for (const flag of Object.values(features)) {
    if (publicWorker && !publicFlags.has(flag)) continue;
    const value = live[flag] ?? "false";
    if (value !== "true" && value !== "false") throw new Error(`Invalid flag: ${flag}.`);
    vars[flag] = value;
  }
  for (const name of enable) {
    const flag = features[name];
    if (!publicWorker || publicFlags.has(flag)) vars[flag] = "true";
  }
  Object.assign(vars, {
    BETTER_AUTH_URL: profile.appOrigin,
    PUBLIC_BASE_URL: profile.publicOrigin,
    TURNSTILE_SITE_KEY: sitekey,
    OBSERVABILITY_DATASET: profile.dataset,
    CANONICAL_REDIRECTS_ENABLED: "true",
  });
  if (publicWorker) {
    // Read back only public settings that this Worker uses.
    return Object.fromEntries(
      Object.entries(vars).filter(
        ([key]) =>
          publicFlags.has(key) ||
          [
            "BETTER_AUTH_URL",
            "PUBLIC_BASE_URL",
            "TURNSTILE_SITE_KEY",
            "OBSERVABILITY_DATASET",
            "CANONICAL_REDIRECTS_ENABLED",
            "FORMS_DAILY_LIMIT",
          ].includes(key),
      ),
    );
  }
  return {
    ...vars,
    AUTH_MODE: vars.AUTH_MODE ?? "local",
    CF_ACCOUNT_ID: profile.account,
    CF_ZONE_ID: profile.zone,
    AUDIT_ARCHIVE_LOCK_DAYS: String(AUDIT_LOCK_DAYS),
  };
}
export function deploymentConfigs(
  profile,
  databaseId,
  sitekey,
  base,
  publicBase,
  { applicationVars = {}, publicVars = {}, enable = [] } = {},
) {
  const allowed = new Set([
    "name",
    "main",
    "compatibility_date",
    "compatibility_flags",
    "keep_vars",
    "upload_source_maps",
    "observability",
    "version_metadata",
    "assets",
    "d1_databases",
    "r2_buckets",
    "browser",
    "durable_objects",
    "workflows",
    "queues",
    "pipelines",
    "ratelimits",
    "migrations",
    "triggers",
    "vars",
    "images",
    "analytics_engine_datasets",
  ]);
  base = Object.fromEntries(Object.entries(base).filter(([key]) => allowed.has(key)));
  publicBase = Object.fromEntries(Object.entries(publicBase).filter(([key]) => allowed.has(key)));
  const shared = {
    account_id: profile.account,
    workers_dev: true,
    preview_urls: false,
    ai: { binding: "AI" },
    images: { binding: "IMAGES" },
    analytics_engine_datasets: [{ binding: "OBSERVABILITY", dataset: profile.dataset }],
    d1_databases: [
      {
        binding: "DB",
        database_name: profile.environment === "production" ? "cloudflare-realtime-notes" : profile.name,
        database_id: databaseId,
        migrations_dir: resolve("migrations"),
      },
    ],
  };
  const application = {
    ...base,
    ...shared,
    name: profile.name,
    main: resolve("src/worker/index.ts"),
    assets: { ...base.assets, binding: "ASSETS", run_worker_first: true, directory: resolve("dist/client") },
    routes: [{ pattern: new URL(profile.appOrigin).hostname, custom_domain: true }],
    r2_buckets: [
      { binding: "BUCKET", bucket_name: profile.original },
      { binding: "PUBLICATIONS_BUCKET", bucket_name: profile.publications },
      { binding: "AUDIT_BUCKET", bucket_name: profile.audit },
    ],
    vectorize: [{ binding: "SEMANTIC_INDEX", index_name: profile.index }],
    services: [{ binding: "PUBLIC_OPERATOR_SETTINGS", service: profile.publicName }],
    vars: releaseVars(profile, sitekey, base.vars, applicationVars, enable),
  };
  if (profile.environment === "staging") {
    application.workflows = [
      { name: `${profile.name}-jobs`, binding: "NOTES_WORKFLOW", class_name: "NotesJobWorkflow" },
    ];
    application.queues = {
      producers: [
        { binding: "DELIVERY_QUEUE", queue: `${profile.name}-delivery` },
        { binding: "DELIVERY_DEAD_LETTER_QUEUE", queue: `${profile.name}-dlq` },
      ],
      consumers: [
        {
          queue: `${profile.name}-delivery`,
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 5,
          dead_letter_queue: `${profile.name}-dlq`,
        },
      ],
    };
  }
  const publicWorker = {
    ...publicBase,
    ...shared,
    name: profile.publicName,
    main: resolve("src/worker/public-worker.ts"),
    routes: [{ pattern: new URL(profile.publicOrigin).hostname, custom_domain: true }],
    r2_buckets: application.r2_buckets.filter((binding) => binding.binding !== "AUDIT_BUCKET"),
    durable_objects: {
      bindings: publicBase.durable_objects.bindings.map((binding) => ({ ...binding, script_name: profile.name })),
    },
    vars: releaseVars(profile, sitekey, publicBase.vars, publicVars, enable, true),
  };
  delete publicWorker.ai;
  if (profile.environment === "staging") {
    for (const worker of [application, publicWorker])
      worker.ratelimits = (worker.ratelimits ?? []).map((binding) => ({
        ...binding,
        namespace_id: String(Number(binding.namespace_id) + 1000),
      }));
  }
  return { application, publicWorker };
}
const equal = isDeepStrictEqual;
function contains(actual, expected) {
  if (expected && typeof expected === "object" && !Array.isArray(expected))
    return actual && Object.entries(expected).every(([key, value]) => contains(actual[key], value));
  return equal(actual, expected);
}
async function policy(api, path, wanted, apply) {
  const current = await api(path);
  if (path.endsWith("/lock")) {
    wanted = wanted.map((desired) => {
      const rule = current.rules?.find((item) => item.id === desired.id && item.enabled);
      if (!rule) return desired;
      const oldPrefix = rule.prefix ?? "";
      const covers = desired.prefix.startsWith(oldPrefix);
      const duration = rule.condition?.maxAgeSeconds;
      if (
        covers &&
        (rule.condition?.type === "Indefinite" ||
          (rule.condition?.type === "Age" && duration >= desired.condition.maxAgeSeconds))
      )
        return rule;
      if (
        rule.condition?.type !== "Age" ||
        !Number.isSafeInteger(duration) ||
        duration > desired.condition.maxAgeSeconds ||
        !oldPrefix.startsWith(desired.prefix)
      )
        throw new Error("Refusing to weaken an existing audit lock.");
      return desired;
    });
  }
  for (const rule of current.rules ?? []) {
    if (
      path.endsWith("/lifecycle") &&
      rule.enabled &&
      rule.deleteObjectsTransition &&
      (!rule.conditions?.prefix ||
        "jobs/".startsWith(rule.conditions.prefix) ||
        rule.conditions.prefix.startsWith("jobs/"))
    )
      throw new Error("Existing lifecycle could remove resumable jobs; reconcile it before activation.");
  }
  const rules = mergeRules(current.rules ?? [], wanted);
  if (!equal(rules, current.rules ?? []) && apply) {
    await api(path, { method: "PUT", body: { rules } });
    const readback = await api(path);
    for (const rule of wanted)
      if (
        !readback.rules?.some(
          (item) => item.id === rule.id && Object.keys(rule).every((key) => equal(item[key], rule[key])),
        )
      )
        throw new Error("Retention policy readback failed.");
  }
  return { path, changed: !equal(rules, current.rules ?? []) };
}
async function inventory(api, path, { cursor = false, select = (value) => value } = {}) {
  const items = [];
  const seen = new Set();
  let next;
  for (let page = 1; page <= 1000; page++) {
    const query = new URLSearchParams({ per_page: "100" });
    if (cursor) {
      if (next) query.set("cursor", next);
    } else query.set("page", String(page));
    const { result, result_info: info } = await api(`${path}${path.includes("?") ? "&" : "?"}${query}`, {
      paginated: true,
    });
    const batch = select(result);
    if (!Array.isArray(batch)) throw new Error("Cloudflare returned an invalid resource inventory.");
    items.push(...batch);
    if (cursor) {
      next = info?.cursor;
      if (!next) return items;
      if (seen.has(next)) throw new Error("Cloudflare repeated a resource inventory cursor.");
      seen.add(next);
    } else if (
      typeof info?.total_pages === "number" ? page >= info.total_pages : batch.length < (info?.per_page || 100)
    ) {
      return items;
    }
  }
  throw new Error("Cloudflare resource inventory exceeded the page limit.");
}
function exactMatch(items, name, field = "name") {
  const matches = items.filter((item) => item[field] === name);
  if (matches.length > 1) throw new Error(`Ambiguous Cloudflare resource: ${name}.`);
  return matches[0];
}
function findWidget(profile, api) {
  return inventory(api, "/challenges/widgets").then((widgets) => exactMatch(widgets, `${profile.name}-platform`));
}
function widgetDomains(profile) {
  return [new URL(profile.appOrigin).hostname, new URL(profile.publicOrigin).hostname];
}
function assertWidgetDomains(profile, widget) {
  if (!widgetDomains(profile).every((domain) => widget.domains?.includes(domain)))
    throw new Error("Existing Turnstile widget has different hostnames; update it explicitly.");
}
export async function turnstileReplacementSecret(profile, api, sitekey) {
  const widget = await api(`/challenges/widgets/${encodeURIComponent(sitekey)}`);
  if (
    widget?.sitekey !== sitekey ||
    widget.name !== `${profile.name}-platform` ||
    typeof widget.secret !== "string" ||
    !widget.secret.trim()
  )
    throw new Error("The prepared Turnstile widget or its secret is unavailable. Prepare again before deploying.");
  assertWidgetDomains(profile, widget);
  return widget.secret;
}
export async function provision(
  profile,
  api,
  { apply = false, directory = resolve(`.wrangler/platform/${profile.environment}`) } = {},
) {
  const changes = [];
  const buckets = await inventory(api, "/r2/buckets", { cursor: true, select: (value) => value?.buckets });
  for (const name of [profile.original, profile.publications, profile.audit]) {
    if (!buckets.some((bucket) => bucket.name === name)) {
      changes.push(`create private bucket ${name}`);
      if (apply) await api("/r2/buckets", { method: "POST", body: { name } });
    }
    if (!apply && !buckets.some((bucket) => bucket.name === name)) continue;
    const managed = await api(`/r2/buckets/${name}/domains/managed`);
    const custom = await api(`/r2/buckets/${name}/domains/custom`);
    if (managed.enabled || custom.domains?.some((domain) => domain.enabled))
      throw new Error(`Bucket ${name} has public access; refuse to expose installation storage.`);
  }
  const rules = retentionRules();
  if (apply || buckets.some((bucket) => bucket.name === profile.audit))
    changes.push(await policy(api, `/r2/buckets/${profile.audit}/lock`, [rules.lock], apply));
  if (apply || buckets.some((bucket) => bucket.name === profile.original))
    changes.push(await policy(api, `/r2/buckets/${profile.original}/lifecycle`, rules.lifecycle, apply));
  let index = await api(`/vectorize/v2/indexes/${profile.index}`, { allowMissing: true });
  if (!index) {
    changes.push(`create Vectorize index ${profile.index}`);
    if (apply) {
      await api("/vectorize/v2/indexes", {
        method: "POST",
        body: { name: profile.index, config: { dimensions: 384, metric: "cosine" } },
      });
      index = await api(`/vectorize/v2/indexes/${profile.index}`);
    }
  }
  if (index && (index.config.dimensions !== 384 || index.config.metric !== "cosine"))
    throw new Error("Existing Vectorize index has incompatible dimensions or metric.");
  if (index) {
    const metadata = await api(`/vectorize/v2/indexes/${profile.index}/metadata_index/list`);
    const fields = metadata.metadataIndexes ?? metadata.indexes ?? metadata;
    const field = fields.find((item) => item.propertyName === "spaceId");
    if (field && field.indexType?.toLowerCase() !== "string")
      throw new Error("spaceId metadata index must be a string index.");
    if (!field) {
      changes.push("create spaceId metadata index");
      if (apply) {
        await api(`/vectorize/v2/indexes/${profile.index}/metadata_index/create`, {
          method: "POST",
          body: { propertyName: "spaceId", indexType: "string" },
        });
        let ready = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          if (attempt) await delay(1000 * 2 ** (attempt - 1));
          const verified = await api(`/vectorize/v2/indexes/${profile.index}/metadata_index/list`);
          ready = (verified.metadataIndexes ?? verified.indexes ?? verified).some(
            (item) => item.propertyName === "spaceId" && item.indexType?.toLowerCase() === "string",
          );
          if (ready) break;
        }
        if (!ready)
          throw new Error("Vectorize metadata creation is still pending; repeat preflight before ingesting vectors.");
      }
    }
  }
  let widget = await findWidget(profile, api);
  if (widget) assertWidgetDomains(profile, widget);
  if (!widget) {
    changes.push("create canonical-host Turnstile widget");
    if (apply) {
      widget = await api("/challenges/widgets", {
        method: "POST",
        body: {
          name: `${profile.name}-platform`,
          domains: widgetDomains(profile),
          mode: "managed",
          clearance_level: "no_clearance",
        },
      });
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = resolve(directory, `turnstile-${randomBytes(8).toString("hex")}.env`);
      try {
        writeFileSync(temporary, `TURNSTILE_SECRET_KEY=${widget.secret}\n`, { mode: 0o600, flag: "wx" });
        renameSync(temporary, resolve(directory, "turnstile.env"));
      } finally {
        rmSync(temporary, { force: true });
      }
    }
  }
  const databases = await inventory(api, `/d1/database?name=${encodeURIComponent(profile.name)}`);
  let database = exactMatch(databases, profile.name);
  if (!database) {
    changes.push("create staging D1 database");
    if (apply && profile.environment === "staging")
      database = await api("/d1/database", { method: "POST", body: { name: profile.name } });
  }
  if (!database && profile.environment === "production")
    throw new Error("Production database missing; refusing to create a replacement.");
  if (profile.environment === "staging") {
    const queues = await inventory(api, "/queues");
    for (const queue_name of [`${profile.name}-delivery`, `${profile.name}-dlq`])
      if (!exactMatch(queues, queue_name, "queue_name")) {
        changes.push(`create staging queue ${queue_name}`);
        if (apply) await api("/queues", { method: "POST", body: { queue_name } });
      }
  }
  return { changes, databaseId: database?.uuid ?? database?.id, sitekey: widget?.sitekey };
}
export async function prepare(profile, api, directory, cutoverReady = false, enable = [], replaceTurnstile = false) {
  const state = await provision(profile, api);
  if (
    !state.databaseId ||
    !state.sitekey ||
    state.changes.some((change) => typeof change === "string" || change.changed)
  )
    throw new Error("Platform resources are not ready. Run platform:provision apply and repeat preflight.");
  const [settings, publicSettings] = await workerSettings(profile, api);
  if (!settings || !publicSettings) throw new Error("Both Worker shells must exist. Run platform bootstrap first.");
  const saved = liveVars(settings);
  const firstPair = replaceTurnstile
    ? []
    : firstTurnstilePairWorkers([profile.name, profile.publicName], [settings, publicSettings], state.sitekey);
  if (profile.environment === "production" && saved.BETTER_AUTH_URL !== profile.appOrigin && !cutoverReady)
    throw new Error(
      "Origin cutover requires completed staging acceptance and verified owner recovery; set PLATFORM_CUTOVER_READY=true only after those checks.",
    );
  const base = unstable_readConfig({ config: "wrangler.jsonc", env: "production" }, { hideWarnings: true });
  const publicBase = unstable_readConfig({ config: "wrangler.public.jsonc", env: "" }, { hideWarnings: true });
  if (
    profile.environment === "production" &&
    state.databaseId !== base.d1_databases.find((binding) => binding.binding === "DB")?.database_id
  )
    throw new Error("Production database identity differs from the reviewed configuration; refusing a replacement.");
  const configs = deploymentConfigs(profile, state.databaseId, state.sitekey, base, publicBase, {
    applicationVars: saved,
    publicVars: liveVars(publicSettings),
    enable,
  });
  assertSharedReleaseFlags(configs.application.vars, configs.publicWorker.vars);
  const secretNames = (workerState, name) => [
    ...(workerState?.bindings ?? []).filter((binding) => binding.type === "secret_text").map((binding) => binding.name),
    ...(replaceTurnstile || firstPair.includes(name) ? ["TURNSTILE_SECRET_KEY"] : []),
  ];
  validatePlatformConfiguration(configs.application, { secretNames: secretNames(settings, profile.name) });
  validatePlatformConfiguration(configs.publicWorker, {
    publicWorker: true,
    secretNames: secretNames(publicSettings, profile.publicName),
  });
  mkdirSync(directory, { recursive: true });
  for (const [name, config] of Object.entries(configs))
    writeFileSync(resolve(directory, `${name}.jsonc`), JSON.stringify(config, null, 2) + "\n");
  writeFileSync(
    resolve(directory, "settings-fingerprints.json"),
    JSON.stringify({
      [profile.name]: settingsFingerprint(settings),
      [profile.publicName]: settingsFingerprint(publicSettings),
      ...(replaceTurnstile ? { turnstileReplacementSitekey: state.sitekey } : {}),
      ...(firstPair.length ? { turnstileFirstPair: { sitekey: state.sitekey, workers: firstPair } } : {}),
    }) + "\n",
  );
  return {
    application: resolve(directory, "application.jsonc"),
    publicWorker: resolve(directory, "publicWorker.jsonc"),
  };
}
export async function configureEdges(
  profile,
  api,
  { apply = false, schemaEntitled = false, enforceSchema = false } = {},
) {
  const wanted = edgeRules(profile),
    zone = `/__zone`;
  const custom = await api(`${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`, { allowMissing: true });
  const rate = await api(`${zone}/rulesets/phases/http_ratelimit/entrypoint`, { allowMissing: true });
  const customRules = mergeRules(custom?.rules ?? [], wanted.custom),
    rateRules = mergeRules(rate?.rules ?? [], [wanted.rate]);
  const schemaRef = `noteflare_v1_schema${profile.environment === "staging" ? "_staging" : ""}`;
  const schemaSlot = schemaEntitled && enforceSchema && !customRules.some((rule) => rule.ref === schemaRef) ? 1 : 0;
  if (customRules.length + schemaSlot > 5 || rateRules.length > 1)
    throw new Error("Free zone rule allowance is occupied; existing unrelated rules were preserved.");
  const results = {
    custom: customRules.length,
    rate: rateRules.length,
    managed: await configureFreeManaged(profile, api, apply),
    schema: "worker-enforced; edge entitlement unavailable",
  };
  if (apply)
    for (const phase of ["http_request_firewall_custom", "http_ratelimit"]) {
      // Per-rule writes preserve unrelated settings and avoid replacing their definitions.
      let entry = await api(`${zone}/rulesets/phases/${phase}/entrypoint`, { allowMissing: true });
      if (!entry)
        entry = await api(`${zone}/rulesets`, {
          method: "POST",
          body: { name: "NoteFlare zone security", kind: "zone", phase, rules: [] },
        });
      for (const rule of phase === "http_ratelimit" ? [wanted.rate] : wanted.custom) {
        const existing = entry.rules?.find((item) => item.ref === rule.ref);
        await api(`${zone}/rulesets/${entry.id}/rules${existing ? `/${existing.id}` : ""}`, {
          method: existing ? "PATCH" : "POST",
          body: rule,
        });
      }
      const readback = await api(`${zone}/rulesets/phases/${phase}/entrypoint`);
      for (const rule of phase === "http_ratelimit" ? [wanted.rate] : wanted.custom)
        if (!readback.rules?.some((item) => item.ref === rule.ref && contains(item, rule)))
          throw new Error("Edge rule readback failed; keep the release gated and reconcile zone security.");
    }
  if (schemaEntitled) {
    results.schema = enforceSchema ? "edge enforcement requested" : "edge evaluation; Worker body enforcement";
    if (apply) {
      const source = JSON.stringify(notionOpenApi(profile.appOrigin, true));
      const schemas = await api(`${zone}/schema_validation/schemas`);
      let schema = (schemas ?? []).find((item) => item.name === `${profile.name}-v1`);
      if (schema && schema.source !== source)
        throw new Error("An existing schema needs a versioned update; preserve it until the replacement is evaluated.");
      if (!schema)
        schema = await api(`${zone}/schema_validation/schemas`, {
          method: "POST",
          body: { name: `${profile.name}-v1`, kind: "openapi_v3", source, validation_enabled: false },
        });
      const schemaId = schema.schema_id;
      let page = 1;
      for (;;) {
        const operations = await api(
          `${zone}/schema_validation/schemas/${schemaId}/operations?operation_status=new&page=${page}&per_page=50`,
          { paginated: true },
        );
        if (operations.result.length)
          await api(`${zone}/api_gateway/operations`, {
            method: "POST",
            body: operations.result.map(({ method, host, endpoint }) => ({ method, host, endpoint })),
          });
        if (page >= (operations.result_info?.total_pages ?? 1)) break;
        page++;
      }
      await api(`${zone}/schema_validation/schemas/${schemaId}`, {
        method: "PATCH",
        body: { validation_enabled: true },
      });
      if ((await api(`${zone}/schema_validation/schemas/${schemaId}`)).validation_enabled !== true)
        throw new Error("Schema evaluation readback failed.");
      if (enforceSchema) {
        const entry = await api(`${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`);
        const existing = entry.rules?.find((item) => item.ref === schemaRef);
        const rule = {
          ref: schemaRef,
          action: "block",
          enabled: true,
          description: "NoteFlare evaluated API schema",
          expression: `(http.host eq "${new URL(profile.appOrigin).hostname}" and starts_with(http.request.uri.path, "/v1/") and cf.schema_validation.uploaded.violated)`,
        };
        await api(`${zone}/rulesets/${entry.id}/rules${existing ? `/${existing.id}` : ""}`, {
          method: existing ? "PATCH" : "POST",
          body: rule,
        });
        const readback = await api(`${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`);
        if (!readback.rules?.some((item) => contains(item, rule)))
          throw new Error("Schema mitigation readback failed.");
      }
    }
  }
  return results;
}
async function configureFreeManaged(profile, api, apply) {
  const rulesets = await api("/__zone/rulesets");
  const free = rulesets.find(
    (item) =>
      item.kind === "managed" &&
      item.phase === "http_request_firewall_managed" &&
      ["Cloudflare Managed Free Ruleset", "Cloudflare Free Managed Ruleset"].includes(item.name),
  );
  if (!free) return "unavailable; the zone advertises no Free managed ruleset";
  const path = "/__zone/rulesets/phases/http_request_firewall_managed/entrypoint";
  const entry = await api(path, { allowMissing: true });
  const existing = entry?.rules?.find((item) => item.action === "execute" && item.action_parameters?.id === free.id);
  const ref = "noteflare_free_managed";
  if (existing && existing.ref !== ref)
    return `${existing.enabled === false ? "operator-disabled" : "existing"} Free managed execution preserved; review its scope and overrides`;
  // A managed ruleset can execute once per zone. Share it across the two reviewed environments.
  const hosts = ["production", "staging"]
    .map(platformProfile)
    .filter((item) => item.zone === profile.zone)
    .flatMap((item) => [item.appOrigin, item.publicOrigin])
    .map((origin) => `"${new URL(origin).hostname}"`);
  const rule = {
    ref,
    description: "NoteFlare Free managed protection",
    action: "execute",
    enabled: true,
    expression: `(http.host in {${hosts.join(" ")}})`,
    action_parameters: { ...existing?.action_parameters, id: free.id },
  };
  if (!apply)
    return existing && contains(existing, rule) ? "Free managed execution verified" : "Free managed deployment planned";
  if (!entry)
    await api("/__zone/rulesets", {
      method: "POST",
      body: {
        name: "NoteFlare managed protection",
        kind: "zone",
        phase: "http_request_firewall_managed",
        rules: [rule],
      },
    });
  else if (!existing || !contains(existing, rule))
    await api(`/__zone/rulesets/${entry.id}/rules${existing ? `/${existing.id}` : ""}`, {
      method: existing ? "PATCH" : "POST",
      body: rule,
    });
  const readback = await api(path);
  if (!readback.rules?.some((item) => item.ref === ref && contains(item, rule)))
    throw new Error("Free managed protection readback failed; keep the release gated.");
  return "Free managed execution verified for application/public hostnames";
}
/** Create unreachable shells so secrets can be installed before any public route. */
export async function bootstrap(profile, api, directory, environment = process.env, execute = spawnSync) {
  const secretsPath = resolve(directory, "bootstrap.env");
  const staging = profile.environment === "staging";
  let authSecret = staging ? environment.PLATFORM_STAGING_BETTER_AUTH_SECRET : environment.BETTER_AUTH_SECRET;
  const names = staging ? [profile.name, profile.publicName] : [profile.publicName];
  const [applicationSettings, publicSettings] = await workerSettings(profile, api);
  const states = staging ? [applicationSettings, publicSettings] : [publicSettings];
  if (!staging && !applicationSettings) throw new Error("Production application Worker is missing.");
  for (const settings of [applicationSettings, publicSettings]) liveVars(settings);
  const needsAuthSecret = states.some((settings) => !hasInstalledSecret(settings, "BETTER_AUTH_SECRET"));
  if (!staging && needsAuthSecret && !authSecret)
    throw new Error(
      "BETTER_AUTH_SECRET must be supplied from the existing production installation; it is never generated or replaced.",
    );
  let bootstrapToken = environment.PLATFORM_STAGING_BOOTSTRAP_TOKEN;
  let persistIdentity = false;
  const stagingSetupPending = staging && !liveVars(states[0]).BETTER_AUTH_URL;
  if (staging) {
    const local = existsSync(secretsPath) ? readFileSync(secretsPath, "utf8") : "";
    const recorded = local.match(/^BETTER_AUTH_SECRET=(.+)$/m)?.[1];
    const recordedBootstrap = local.match(/^BOOTSTRAP_TOKEN=(.+)$/m)?.[1];
    if (
      (recorded && authSecret && recorded !== authSecret) ||
      (recordedBootstrap && bootstrapToken && recordedBootstrap !== bootstrapToken)
    )
      throw new Error("Supplied staging credentials conflict with the recorded installation credentials.");
    authSecret ??= recorded;
    bootstrapToken ??= recordedBootstrap;
    if (needsAuthSecret && states.some(Boolean) && !authSecret)
      throw new Error(
        "Supply the original PLATFORM_STAGING_BETTER_AUTH_SECRET or restore the recorded staging credentials.",
      );
    if (!states.some(Boolean)) {
      authSecret ??= randomBytes(48).toString("base64url");
      bootstrapToken ??= randomBytes(48).toString("base64url");
    }
    if (stagingSetupPending && !hasInstalledSecret(states[0], "BOOTSTRAP_TOKEN") && !bootstrapToken)
      throw new Error(
        "Supply the original PLATFORM_STAGING_BOOTSTRAP_TOKEN or restore the recorded staging credentials.",
      );
    if (/[\r\n]/.test(authSecret ?? "") || /[\r\n]/.test(bootstrapToken ?? ""))
      throw new Error("Staging identity credentials must be single-line values.");
    persistIdentity = !local && !states.some(Boolean);
  }
  if (needsAuthSecret && (!authSecret || authSecret.length < 32))
    throw new Error("A valid installation authentication secret is required.");
  if (persistIdentity) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(secretsPath, `BETTER_AUTH_SECRET=${authSecret}\nBOOTSTRAP_TOKEN=${bootstrapToken}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  }
  const putSecret = (worker, name, text) =>
    api(`/workers/scripts/${worker}/secrets`, {
      method: "PUT",
      body: { name, text, type: "secret_text" },
    });
  const workerPath = resolve(directory, "bootstrap-worker.mjs");
  if (states.some((settings) => !settings)) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(workerPath, 'export default { fetch() { return new Response("Not found.", { status: 404 }); } };\n');
  }
  for (const [index, name] of names.entries()) {
    const settings = states[index];
    if (!settings) {
      const path = resolve(directory, `bootstrap-${name}.jsonc`);
      writeFileSync(
        path,
        JSON.stringify({
          name,
          main: workerPath,
          account_id: profile.account,
          compatibility_date: "2026-08-14",
          workers_dev: false,
          preview_urls: false,
          routes: [],
        }),
      );
      const result = execute(
        process.execPath,
        [createRequire(import.meta.url).resolve("wrangler"), "deploy", "--config", path],
        { stdio: "inherit" },
      );
      if (result.status !== 0) throw new Error("Private Worker shell deployment failed.");
    }
    for (const [key, value] of [
      ["BETTER_AUTH_SECRET", authSecret],
      ...(name === profile.name && stagingSetupPending ? [["BOOTSTRAP_TOKEN", bootstrapToken]] : []),
    ])
      if (!hasInstalledSecret(settings, key)) await putSecret(name, key, value);
  }
  if (environment.CF_ANALYTICS_API_TOKEN)
    await putSecret(profile.name, "CF_ANALYTICS_API_TOKEN", environment.CF_ANALYTICS_API_TOKEN);

  const widget = await findWidget(profile, api);
  if (!widget) throw new Error("Provision the environment’s Turnstile widget to finish bootstrap.");
  const workers = [
    [profile.name, applicationSettings],
    [profile.publicName, publicSettings],
  ];
  const awaitingTurnstileReplacement = [];
  const awaitingTurnstileFirstPair = [];
  const missingTurnstile = [];
  function canFillTurnstile(name, settings) {
    const pairing = turnstilePairing(settings, widget.sitekey);
    if (pairing === "replace") awaitingTurnstileReplacement.push(name);
    if (pairing === "first") awaitingTurnstileFirstPair.push(name);
    return pairing === "matched" && !hasInstalledSecret(settings, "TURNSTILE_SECRET_KEY");
  }
  for (const [name, settings] of workers) {
    if (canFillTurnstile(name, settings)) missingTurnstile.push(name);
  }
  if (missingTurnstile.length) {
    const secret = await turnstileReplacementSecret(profile, api, widget.sitekey);
    for (const name of missingTurnstile) {
      const live = await api(`/workers/scripts/${name}/settings`);
      if (canFillTurnstile(name, live)) await putSecret(name, "TURNSTILE_SECRET_KEY", secret);
    }
  }
  return {
    publicIngress: states.at(-1) ? "unchanged; unverified" : "private shell; ingress disabled",
    secrets: "installed without changing production application identity",
    awaitingTurnstileReplacement,
    awaitingTurnstileFirstPair,
  };
}
export async function platformConnection(profile, options) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_ACCOUNT_ID !== profile.account)
    throw new Error("Cloudflare account override differs from the selected platform profile.");
  const connection = await cloudflare(profile.account, options);
  if (connection.account !== profile.account) throw new Error("Cloudflare account differs from the selected profile.");
  return connection;
}
export async function main(argv = process.argv.slice(2)) {
  const [command = "plan", environment = "production", ...flags] = argv;
  const activation = flags.filter((option) => option.startsWith("--enable="));
  const replaceTurnstile = flags.includes("--replace-turnstile");
  if (
    (flags.length && command !== "prepare") ||
    activation.length > 1 ||
    flags.length !== activation.length + Number(replaceTurnstile)
  )
    throw new Error("Only prepare accepts --enable and --replace-turnstile, once each.");
  const enable = parseActivation(activation[0]);
  if (
    command === "prepare" &&
    process.env.GITHUB_ACTIONS === "true" &&
    Number(process.env.GITHUB_RUN_ATTEMPT) > 1 &&
    (enable.length || replaceTurnstile)
  )
    throw new Error("Review current Worker settings and start a new dispatch for activation or widget replacement.");
  if (!["plan", "apply", "prepare", "bootstrap", "edges-plan", "edges-apply"].includes(command))
    throw new Error(
      "Usage: cloudflare-platform.mjs plan|apply|prepare|bootstrap|edges-plan|edges-apply [production|staging]",
    );
  const profile = platformProfile(environment),
    directory = resolve(`.wrangler/platform/${environment}`);
  const { api } = await platformConnection(profile, {
    request: (url, options) => {
      const zoneRequest = url.includes("/__zone/");
      if (zoneRequest && !process.env.CF_EDGE_API_TOKEN)
        throw new Error("CF_EDGE_API_TOKEN is required for zone security and API Gateway configuration.");
      const headers = new Headers(options.headers);
      if (zoneRequest) headers.set("Authorization", `Bearer ${process.env.CF_EDGE_API_TOKEN}`);
      return fetch(zoneRequest ? url.replace(`/accounts/${profile.account}/__zone/`, `/zones/${profile.zone}/`) : url, {
        ...options,
        headers,
      });
    },
  });
  const result = command.startsWith("edges-")
    ? await configureEdges(profile, api, {
        apply: command === "edges-apply",
        schemaEntitled: process.env.CF_SCHEMA_ENTITLED === "true",
        enforceSchema: process.env.CF_SCHEMA_EVALUATED === "true",
      })
    : command === "bootstrap"
      ? await bootstrap(profile, api, directory)
      : command === "prepare"
        ? await prepare(
            profile,
            api,
            directory,
            process.env.PLATFORM_CUTOVER_READY === "true",
            enable,
            replaceTurnstile,
          )
        : await provision(profile, api, { apply: command === "apply", directory });
  console.log(JSON.stringify(result, null, 2));
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
