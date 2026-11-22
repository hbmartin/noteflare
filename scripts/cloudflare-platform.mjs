import { isDeepStrictEqual } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import { unstable_readConfig } from "wrangler";
import { cloudflare } from "./deploy.mjs";
import { validatePlatformConfiguration } from "./platform-config.mjs";
import { notionOpenApi } from "../src/shared/notion-request-schemas.ts";

const ACCOUNT = "940db9a80e285cf3f700d5d903d8e182";
const ZONE = "986af780c629979d91800d7e569f4b9c";
const DAY = 86400;
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
      condition: { type: "Age", maxAgeSeconds: 365 * DAY },
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
function activeVars(profile, sitekey) {
  return {
    BETTER_AUTH_URL: profile.appOrigin,
    PUBLIC_BASE_URL: profile.publicOrigin,
    AUTH_MODE: "local",
    SEMANTIC_SEARCH_ENABLED: "true",
    SEMANTIC_MAX_STORED_CHUNKS: "10000",
    SEMANTIC_DAILY_QUERY_LIMIT: "2000",
    SEMANTIC_DAILY_TOKEN_LIMIT: "100000",
    IMAGES_ENABLED: "true",
    PUBLIC_PUBLISHING_ENABLED: "true",
    AUDIT_ENABLED: "true",
    AUDIT_HOT_DAYS: "30",
    AUDIT_ARCHIVE_DAYS: "365",
    TURNSTILE_ENABLED: "true",
    TURNSTILE_SITE_KEY: sitekey,
    FORMS_ENABLED: "true",
    TABLE_AUTHORITY_ENABLED: "true",
    COST_REPORTING_ENABLED: "true",
    OBSERVABILITY_DATASET: profile.dataset,
    CF_ACCOUNT_ID: profile.account,
    CF_ZONE_ID: profile.zone,
  };
}
export function deploymentConfigs(profile, databaseId, sitekey, base, publicBase) {
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
    workers_dev: false,
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
    assets: { ...base.assets, directory: resolve("dist/client") },
    routes: [{ pattern: new URL(profile.appOrigin).hostname, custom_domain: true }],
    r2_buckets: [
      { binding: "BUCKET", bucket_name: profile.original },
      { binding: "PUBLICATIONS_BUCKET", bucket_name: profile.publications },
      { binding: "AUDIT_BUCKET", bucket_name: profile.audit },
    ],
    vectorize: [{ binding: "SEMANTIC_INDEX", index_name: profile.index }],
    vars: { ...base.vars, ...activeVars(profile, sitekey) },
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
  if (base.vars.AUTH_MODE === "access_required") application.vars.AUTH_MODE = "access_required";
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
    vars: Object.fromEntries(
      Object.entries({ ...publicBase.vars, ...activeVars(profile, sitekey) }).filter(
        ([key]) =>
          ![
            "AUTH_MODE",
            "CF_ACCOUNT_ID",
            "CF_ZONE_ID",
            "SEMANTIC_SEARCH_ENABLED",
            "SEMANTIC_MAX_STORED_CHUNKS",
            "SEMANTIC_DAILY_QUERY_LIMIT",
            "SEMANTIC_DAILY_TOKEN_LIMIT",
            "AUDIT_ENABLED",
            "AUDIT_HOT_DAYS",
            "AUDIT_ARCHIVE_DAYS",
          ].includes(key),
      ),
    ),
  };
  delete publicWorker.ai;
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
  for (const rule of current.rules ?? []) {
    if (
      path.endsWith("/lock") &&
      wanted.some((item) => item.id === rule.id) &&
      rule.enabled &&
      (rule.condition?.type !== "Age" || rule.condition.maxAgeSeconds > 365 * DAY)
    )
      throw new Error("Refusing to weaken an existing audit lock.");
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
export async function provision(
  profile,
  api,
  { apply = false, directory = resolve(`.wrangler/platform/${profile.environment}`) } = {},
) {
  const changes = [];
  const buckets = await api("/r2/buckets");
  for (const name of [profile.original, profile.publications, profile.audit]) {
    if (!buckets.buckets.some((bucket) => bucket.name === name)) {
      changes.push(`create private bucket ${name}`);
      if (apply) await api("/r2/buckets", { method: "POST", body: { name } });
    }
    if (!apply && !buckets.buckets.some((bucket) => bucket.name === name)) continue;
    const managed = await api(`/r2/buckets/${name}/domains/managed`);
    const custom = await api(`/r2/buckets/${name}/domains/custom`);
    if (managed.enabled || custom.domains?.some((domain) => domain.enabled))
      throw new Error(`Bucket ${name} has public access; refuse to expose installation storage.`);
  }
  const rules = retentionRules();
  if (apply || buckets.buckets.some((bucket) => bucket.name === profile.audit))
    changes.push(await policy(api, `/r2/buckets/${profile.audit}/lock`, [rules.lock], apply));
  if (apply || buckets.buckets.some((bucket) => bucket.name === profile.original))
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
  const widgets = await api("/challenges/widgets?per_page=100");
  let widget = widgets.find((item) => item.name === `${profile.name}-platform`);
  const domains = [new URL(profile.appOrigin).hostname, new URL(profile.publicOrigin).hostname];
  if (widget && !domains.every((domain) => widget.domains.includes(domain)))
    throw new Error("Existing Turnstile widget has different hostnames; update it explicitly.");
  if (!widget) {
    changes.push("create canonical-host Turnstile widget");
    if (apply) {
      widget = await api("/challenges/widgets", {
        method: "POST",
        body: { name: `${profile.name}-platform`, domains, mode: "managed", clearance_level: "no_clearance" },
      });
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(resolve(directory, "turnstile.env"), `TURNSTILE_SECRET_KEY=${widget.secret}\n`, {
        mode: 0o600,
        flag: "wx",
      });
    }
  }
  const databases = await api("/d1/database?per_page=100");
  let database = databases.find(
    (item) => item.name === (profile.environment === "production" ? "cloudflare-realtime-notes" : profile.name),
  );
  if (!database) {
    changes.push("create staging D1 database");
    if (apply && profile.environment === "staging")
      database = await api("/d1/database", { method: "POST", body: { name: profile.name } });
  }
  if (!database && profile.environment === "production")
    throw new Error("Production database missing; refusing to create a replacement.");
  if (profile.environment === "staging") {
    const queues = await api("/queues?per_page=100");
    for (const queue_name of [`${profile.name}-delivery`, `${profile.name}-dlq`])
      if (!queues.some((queue) => queue.queue_name === queue_name)) {
        changes.push(`create staging queue ${queue_name}`);
        if (apply) await api("/queues", { method: "POST", body: { queue_name } });
      }
  }
  return { changes, databaseId: database?.uuid ?? database?.id, sitekey: widget?.sitekey };
}
export async function prepare(profile, api, directory, cutoverReady = false) {
  const state = await provision(profile, api);
  if (
    !state.databaseId ||
    !state.sitekey ||
    state.changes.some((change) => typeof change === "string" || change.changed)
  )
    throw new Error("Platform resources are not ready. Run platform:provision apply and repeat preflight.");
  const settings = await api(`/workers/scripts/${profile.name}/settings`, { allowMissing: true });
  const saved = Object.fromEntries(
    (settings?.bindings ?? [])
      .filter((binding) => binding.type === "plain_text")
      .map((binding) => [binding.name, binding.text]),
  );
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
  // Preserve an explicitly enabled operator Access configuration and installed integrations.
  base.vars = { ...base.vars, ...saved };
  const configs = deploymentConfigs(profile, state.databaseId, state.sitekey, base, publicBase);
  if (saved.AUTH_MODE === "access_required") configs.application.vars.AUTH_MODE = saved.AUTH_MODE;
  const secretNames = (settings?.bindings ?? [])
    .filter((binding) => binding.type === "secret_text")
    .map((binding) => binding.name);
  const analyticsReady = secretNames.includes("CF_ANALYTICS_API_TOKEN");
  // Staging can exercise the included products before the operator supplies SQL access.
  // Production remains gated on the complete owner-reporting configuration.
  if (!analyticsReady && profile.environment === "staging") {
    configs.application.vars.COST_REPORTING_ENABLED = "false";
    configs.publicWorker.vars.COST_REPORTING_ENABLED = "false";
  }
  validatePlatformConfiguration(configs.application, { secretNames });
  if (!analyticsReady && profile.environment === "production")
    throw new Error("Configure the application’s CF_ANALYTICS_API_TOKEN with Account Analytics Read.");
  const publicSettings = await api(`/workers/scripts/${profile.publicName}/settings`, { allowMissing: true });
  validatePlatformConfiguration(configs.publicWorker, {
    publicWorker: true,
    secretNames: (publicSettings?.bindings ?? [])
      .filter((binding) => binding.type === "secret_text")
      .map((binding) => binding.name),
  });
  mkdirSync(directory, { recursive: true });
  for (const [name, config] of Object.entries(configs))
    writeFileSync(resolve(directory, `${name}.jsonc`), JSON.stringify(config, null, 2) + "\n");
  return {
    application: resolve(directory, "application.jsonc"),
    publicWorker: resolve(directory, "publicWorker.jsonc"),
    analytics: analyticsReady ? "configured" : "unavailable; staging product checks may proceed without SQL access",
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
        const ref = schemaRef,
          existing = entry.rules?.find((item) => item.ref === ref);
        await api(`${zone}/rulesets/${entry.id}/rules${existing ? `/${existing.id}` : ""}`, {
          method: existing ? "PATCH" : "POST",
          body: {
            ref,
            action: "block",
            enabled: true,
            description: "NoteFlare evaluated API schema",
            expression: `(http.host eq "${new URL(profile.appOrigin).hostname}" and starts_with(http.request.uri.path, "/v1/") and cf.schema_validation.uploaded.violated)`,
          },
        });
        const readback = await api(`${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`);
        if (!readback.rules?.some((rule) => rule.ref === ref && rule.enabled && rule.action === "block"))
          throw new Error("Schema mitigation readback failed.");
      }
    }
  }
  return results;
}
async function configureFreeManaged(profile, api, apply) {
  const inventory = await api("/__zone/rulesets");
  const free = inventory.find(
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
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const secretsPath = resolve(directory, "bootstrap.env");
  let authSecret = environment.BETTER_AUTH_SECRET;
  if (profile.environment === "production" && !authSecret)
    throw new Error(
      "BETTER_AUTH_SECRET must be supplied from the existing production installation; it is never generated or replaced.",
    );
  if (profile.environment === "staging") {
    if (existsSync(secretsPath))
      authSecret = readFileSync(secretsPath, "utf8").match(/^BETTER_AUTH_SECRET=(.+)$/m)?.[1];
    else {
      authSecret ??= randomBytes(48).toString("base64url");
      writeFileSync(
        secretsPath,
        `BETTER_AUTH_SECRET=${authSecret}\nBOOTSTRAP_TOKEN=${randomBytes(48).toString("base64url")}\n`,
        { mode: 0o600, flag: "wx" },
      );
    }
  }
  if (!authSecret || authSecret.length < 32) throw new Error("A valid installation authentication secret is required.");
  const widgets = await api("/challenges/widgets?per_page=100");
  const widget = widgets.find((item) => item.name === `${profile.name}-platform`);
  if (!widget) throw new Error("Provision the environment’s Turnstile widget first.");
  const challenge = await api(`/challenges/widgets/${widget.sitekey}`);
  if (!challenge.secret) throw new Error("Turnstile secret is unavailable; configure Worker secrets explicitly.");
  const workerPath = resolve(directory, "bootstrap-worker.mjs");
  writeFileSync(workerPath, 'export default { fetch() { return new Response("Not found.", { status: 404 }); } };\n');
  const names = profile.environment === "staging" ? [profile.name, profile.publicName] : [profile.publicName];
  for (const name of names) {
    const settings = await api(`/workers/scripts/${name}/settings`, { allowMissing: true });
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
    await api(`/workers/scripts/${name}/secrets`, {
      method: "PUT",
      body: { name: "BETTER_AUTH_SECRET", text: authSecret, type: "secret_text" },
    });
    await api(`/workers/scripts/${name}/secrets`, {
      method: "PUT",
      body: { name: "TURNSTILE_SECRET_KEY", text: challenge.secret, type: "secret_text" },
    });
    if (name === profile.name) {
      const bootstrapToken = readFileSync(secretsPath, "utf8").match(/^BOOTSTRAP_TOKEN=(.+)$/m)?.[1];
      await api(`/workers/scripts/${name}/secrets`, {
        method: "PUT",
        body: { name: "BOOTSTRAP_TOKEN", text: bootstrapToken, type: "secret_text" },
      });
    }
  }
  // Production application identity stays untouched. Install only the new product credentials.
  await api(`/workers/scripts/${profile.name}/secrets`, {
    method: "PUT",
    body: { name: "TURNSTILE_SECRET_KEY", text: challenge.secret, type: "secret_text" },
  });
  if (environment.CF_ANALYTICS_API_TOKEN)
    await api(`/workers/scripts/${profile.name}/secrets`, {
      method: "PUT",
      body: { name: "CF_ANALYTICS_API_TOKEN", text: environment.CF_ANALYTICS_API_TOKEN, type: "secret_text" },
    });
  return {
    publicIngress: "disabled until the coordinated deployment",
    secrets: "installed without changing production application identity",
  };
}
export async function main(argv = process.argv.slice(2)) {
  const [command = "plan", environment = "production"] = argv;
  if (!["plan", "apply", "prepare", "bootstrap", "edges-plan", "edges-apply"].includes(command))
    throw new Error(
      "Usage: cloudflare-platform.mjs plan|apply|prepare|bootstrap|edges-plan|edges-apply [production|staging]",
    );
  const profile = platformProfile(environment),
    directory = resolve(`.wrangler/platform/${environment}`);
  const { api } = await cloudflare(profile.account, {
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
        ? await prepare(profile, api, directory, process.env.PLATFORM_CUTOVER_READY === "true")
        : await provision(profile, api, { apply: command === "apply", directory });
  console.log(JSON.stringify(result, null, 2));
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
