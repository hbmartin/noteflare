import { describe, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";
import {
  platformProfile,
  retentionRules,
  mergeRules,
  edgeRules,
  deploymentConfigs,
  provision,
  configureEdges,
  bootstrap,
  platformConnection,
  parseActivation,
} from "./cloudflare-platform.mjs";
import { validatePlatformConfiguration } from "./platform-config.mjs";

describe("Cloudflare platform provisioning", () => {
  it("keeps staging resources and hostnames separate", () => {
    const production = platformProfile(),
      staging = platformProfile("staging");
    for (const key of [
      "name",
      "publicName",
      "original",
      "publications",
      "audit",
      "index",
      "dataset",
      "appOrigin",
      "publicOrigin",
    ])
      expect(staging[key]).not.toBe(production[key]);
    expect(() => platformProfile("typo")).toThrow("Choose production or staging");
  });
  it("scopes lifecycle rules to disposable prefixes and preserves unrelated rules", () => {
    const wanted = retentionRules();
    expect(wanted.lock.condition.maxAgeSeconds).toBe(365 * 86400);
    expect(wanted.lifecycle.map((rule) => rule.conditions.prefix)).toEqual(["link-previews/", "job-artifacts/"]);
    const multipart = {
      id: "multipart",
      enabled: true,
      abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } },
    };
    expect(mergeRules([multipart], wanted.lifecycle)[0]).toBe(multipart);
    expect(mergeRules(mergeRules([multipart], wanted.lifecycle), wanted.lifecycle)).toHaveLength(3);
  });
  it("generates Free-compatible path-only rate limits and hostname-scoped method restrictions", () => {
    const rules = edgeRules(platformProfile());
    expect(rules.rate.expression).not.toContain("http.host");
    expect(rules.rate.expression).not.toContain("http.request.method");
    expect(rules.rate.ratelimit).toMatchObject({ period: 10, requests_per_period: 100, mitigation_timeout: 10 });
    expect(rules.custom[0].expression).toContain('http.host eq "public.sparkedinnovations.training"');
    const staging = edgeRules(platformProfile("staging"));
    expect(staging.custom[0].ref).not.toBe(rules.custom[0].ref);
    expect(staging.rate).toEqual(rules.rate);
  });
  it("refuses to replace an unrelated rate rule even when apply was requested", async () => {
    const api = vi.fn(async (path) =>
      path.includes("http_ratelimit") ? { rules: [{ ref: "another-service" }] } : { rules: [] },
    );
    await expect(configureEdges(platformProfile(), api, { apply: true })).rejects.toThrow("allowance is occupied");
    expect(api.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it("requires edge rule readback and preserves unrelated rules when applying twice", async () => {
    const free = {
      id: "free",
      name: "Cloudflare Managed Free Ruleset",
      kind: "managed",
      phase: "http_request_firewall_managed",
    };
    const entries = {
      http_request_firewall_custom: {
        id: "custom",
        rules: [{ id: "existing", ref: "operator-protection", action: "block" }],
      },
      http_ratelimit: { id: "rate", rules: [] },
      http_request_firewall_managed: {
        id: "managed",
        rules: [
          {
            id: "operator-managed",
            ref: "operator-managed",
            action: "execute",
            action_parameters: { id: "another-managed-ruleset" },
          },
        ],
      },
    };
    let nextId = 0;
    const api = vi.fn(async (path, options = {}) => {
      if (path === "/__zone/rulesets") return [free];
      const phase = Object.keys(entries).find((name) => path.includes(`/phases/${name}/`));
      if (phase) return structuredClone(entries[phase]);
      const entry = Object.values(entries).find((item) => path.includes(`/rulesets/${item.id}/rules`));
      if (entry && options.method) {
        if (options.method === "POST") entry.rules.push({ id: `created-${++nextId}`, ...options.body });
        else {
          const rule = entry.rules.find((item) => item.id === path.split("/").at(-1));
          if (!rule) throw new Error("Unknown rule");
          Object.assign(rule, options.body);
        }
        return {};
      }
      throw new Error(path);
    });
    await configureEdges(platformProfile(), api, { apply: true });
    await configureEdges(platformProfile(), api, { apply: true });
    expect(entries.http_request_firewall_custom.rules).toHaveLength(2);
    expect(entries.http_request_firewall_custom.rules[0].ref).toBe("operator-protection");
    expect(entries.http_ratelimit.rules).toHaveLength(1);
    expect(entries.http_request_firewall_managed.rules).toHaveLength(2);
    const managed = entries.http_request_firewall_managed.rules[1];
    expect(managed.expression).toContain('"public.sparkedinnovations.training"');
    expect(managed.expression).toContain('"public-staging.sparkedinnovations.training"');
    managed.action_parameters.overrides = { rules: [{ id: "operator-override", enabled: false }] };
    await configureEdges(platformProfile("staging"), api, { apply: true });
    expect(entries.http_request_firewall_custom.rules.map((rule) => rule.ref)).toEqual([
      "operator-protection",
      "noteflare_public_methods",
      "noteflare_public_methods_staging",
    ]);
    expect(entries.http_request_firewall_managed.rules).toHaveLength(2);
    expect(entries.http_request_firewall_managed.rules[1].action_parameters.overrides).toEqual(
      managed.action_parameters.overrides,
    );
    entries.http_ratelimit.rules = [];
    api.mockImplementation(async (path) =>
      path === "/__zone/rulesets"
        ? [free]
        : structuredClone(
            path.includes("http_ratelimit")
              ? entries.http_ratelimit
              : path.includes("http_request_firewall_managed")
                ? entries.http_request_firewall_managed
                : entries.http_request_firewall_custom,
          ),
    );
    await expect(configureEdges(platformProfile(), api, { apply: true })).rejects.toThrow("readback failed");
  });
  it("preserves an operator's existing Free managed scope and overrides", async () => {
    const free = {
      id: "free",
      name: "Cloudflare Managed Free Ruleset",
      kind: "managed",
      phase: "http_request_firewall_managed",
    };
    const operatorRule = {
      id: "operator",
      ref: "operator",
      action: "execute",
      enabled: false,
      expression: "true",
      action_parameters: { id: free.id, overrides: { enabled: false } },
    };
    const api = vi.fn(async (path) =>
      path === "/__zone/rulesets"
        ? [free]
        : path.includes("http_request_firewall_managed")
          ? { rules: [operatorRule] }
          : { rules: [] },
    );
    const result = await configureEdges(platformProfile(), api);
    expect(result.managed).toContain("operator-disabled");
    expect(api.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it("fails closed when managed protection readback does not confirm its scope", async () => {
    const free = {
      id: "free",
      name: "Cloudflare Managed Free Ruleset",
      kind: "managed",
      phase: "http_request_firewall_managed",
    };
    const overrides = { rules: [{ id: "operator-override", enabled: false }] };
    const api = vi.fn(async (path) => {
      if (path === "/__zone/rulesets") return [free];
      if (path.includes("http_request_firewall_managed"))
        return {
          id: "managed",
          rules: [
            {
              id: "owned",
              ref: "noteflare_free_managed",
              action: "execute",
              enabled: false,
              expression: "true",
              action_parameters: { id: free.id, overrides },
            },
          ],
        };
      return { rules: [] };
    });
    await expect(configureEdges(platformProfile(), api, { apply: true })).rejects.toThrow(
      "managed protection readback failed",
    );
    const writes = api.mock.calls.filter(([, options]) => options?.method);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe("/__zone/rulesets/managed/rules/owned");
    expect(writes[0][1].body.action_parameters.overrides).toEqual(overrides);
  });
  it("generates complete configs without copying inference or administrative credentials to public delivery", () => {
    const base = unstable_readConfig({ config: "wrangler.jsonc", env: "production" }, { hideWarnings: true });
    const publicBase = unstable_readConfig({ config: "wrangler.public.jsonc", env: "" }, { hideWarnings: true });
    const configs = deploymentConfigs(platformProfile(), "database", "sitekey", base, publicBase);
    expect(() => validatePlatformConfiguration(configs.application)).not.toThrow();
    expect(() => validatePlatformConfiguration(configs.publicWorker, { publicWorker: true })).not.toThrow();
    expect(configs.application.vars.AUTH_MODE).toBe("local");
    expect(configs.application.vars.SEMANTIC_DAILY_QUERY_LIMIT).toBe("2000");
    expect(configs.publicWorker).not.toHaveProperty("ai");
    expect(configs.publicWorker.r2_buckets.map((item) => item.binding)).toEqual(["BUCKET", "PUBLICATIONS_BUCKET"]);
    expect(configs.publicWorker.durable_objects.bindings.every((item) => item.script_name === base.name)).toBe(true);
    expect(configs.application).not.toHaveProperty("configPath");
    const stage = deploymentConfigs(platformProfile("staging"), "database", "sitekey", base, publicBase, {
      applicationVars: { AUTH_MODE: "access_required", IMAGES_ENABLED: "false", AUDIT_ARCHIVE_DAYS: "730" },
      publicVars: { PUBLIC_PUBLISHING_ENABLED: "false", FORMS_DAILY_LIMIT: "22" },
      enable: parseActivation("--enable=semantic,costs"),
    });
    expect(stage.application.vars).toMatchObject({
      AUTH_MODE: "access_required",
      IMAGES_ENABLED: "false",
      AUDIT_ARCHIVE_DAYS: "730",
      SEMANTIC_SEARCH_ENABLED: "true",
      COST_REPORTING_ENABLED: "true",
      FORMS_ENABLED: "false",
    });
    expect(stage.publicWorker.vars).toMatchObject({
      PUBLIC_PUBLISHING_ENABLED: "false",
      FORMS_DAILY_LIMIT: "22",
      COST_REPORTING_ENABLED: "true",
    });
    for (const worker of ["application", "publicWorker"]) {
      const productionIds = new Set(configs[worker].ratelimits.map((binding) => binding.namespace_id));
      expect(stage[worker].ratelimits.every((binding) => !productionIds.has(binding.namespace_id))).toBe(true);
    }
    expect(() => parseActivation("--enable=access")).toThrow("Choose features");
  });
  it("checks existing private buckets and reads back merged policy updates idempotently", async () => {
    const profile = platformProfile(),
      policies = new Map();
    const multipart = {
      id: "default",
      enabled: true,
      conditions: {},
      abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } },
    };
    policies.set(`/r2/buckets/${profile.original}/lifecycle`, { rules: [multipart] });
    const lockPath = `/r2/buckets/${profile.audit}/lock`;
    const globalLock = { ...retentionRules().lock, prefix: "" };
    policies.set(lockPath, { rules: [globalLock] });
    const api = vi.fn(async (path, options = {}) => {
      if (policies.has(path)) {
        if (options.method) policies.set(path, options.body);
        return structuredClone(policies.get(path));
      }
      if (path === "/r2/buckets?per_page=100")
        return { result: { buckets: [{ name: profile.original }] }, result_info: { cursor: "next" } };
      if (path === "/r2/buckets?per_page=100&cursor=next")
        return { result: { buckets: [profile.publications, profile.audit].map((name) => ({ name })) } };
      if (path.endsWith("/domains/managed")) return { enabled: false };
      if (path.endsWith("/domains/custom")) return { domains: [] };
      if (path.endsWith("/metadata_index/list"))
        return { metadataIndexes: [{ propertyName: "spaceId", indexType: "String" }] };
      if (path.startsWith("/vectorize")) return { config: { dimensions: 384, metric: "cosine" } };
      if (path.startsWith("/challenges") || path.startsWith("/d1")) {
        if (path.endsWith("page=1")) return { result: [], result_info: { total_pages: 2 } };
        if (path.startsWith("/d1")) return { result: [{ name: profile.name, uuid: "database" }] };
        return {
          result: [
            {
              sitekey: "sitekey",
              name: `${profile.name}-platform`,
              domains: [new URL(profile.appOrigin).hostname, new URL(profile.publicOrigin).hostname],
            },
          ],
        };
      }
      throw new Error(path);
    });
    await provision(profile, api, { apply: true });
    expect(policies.get(lockPath).rules).toEqual([globalLock]);
    expect(policies.get(`/r2/buckets/${profile.original}/lifecycle`).rules).toContainEqual(multipart);
    const writes = api.mock.calls.filter(([, options]) => options?.method).length;
    const next = await provision(profile, api, { apply: true });
    expect(api.mock.calls.filter(([, options]) => options?.method)).toHaveLength(writes);
    expect(next.changes.every((change) => !change.changed)).toBe(true);
  });
  it("never generates a replacement production authentication secret", async () => {
    const api = vi.fn(),
      execute = vi.fn();
    await expect(bootstrap(platformProfile(), api, "/tmp/noteflare-bootstrap-test", {}, execute)).rejects.toThrow(
      "never generated or replaced",
    );
    expect(api).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects a different account before reading credentials", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "a".repeat(32));
    const readCredentials = vi.fn();
    try {
      await expect(platformConnection(platformProfile(), { readCredentials })).rejects.toThrow("account override");
      expect(readCredentials).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("requires the original staging secret if either Worker already exists", async () => {
    const api = vi.fn(async (path) => (path.endsWith("-public/settings") ? { bindings: [] } : null));
    await expect(
      bootstrap(platformProfile("staging"), api, "/tmp/noteflare-missing-bootstrap-test", {}),
    ).rejects.toThrow("original staging BETTER_AUTH_SECRET");
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      "/workers/scripts/cloudflare-realtime-notes-platform-staging/settings",
      "/workers/scripts/cloudflare-realtime-notes-platform-staging-public/settings",
    ]);
  });
  it("rejects public Worker secrets beyond its two required purposes", () => {
    const config = deploymentConfigs(
      platformProfile(),
      "database",
      "sitekey",
      unstable_readConfig({ config: "wrangler.jsonc", env: "production" }, { hideWarnings: true }),
      unstable_readConfig({ config: "wrangler.public.jsonc", env: "" }, { hideWarnings: true }),
    ).publicWorker;
    for (const name of ["CF_ANALYTICS_API_TOKEN", "CF_EDGE_API_TOKEN", "UNRECOGNIZED_ADMIN_SECRET"])
      expect(() =>
        validatePlatformConfiguration(config, {
          publicWorker: true,
          secretNames: ["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY", name],
        }),
      ).toThrow("must not be configured");
  });
});
