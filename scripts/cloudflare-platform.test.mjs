import { describe, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  platformProfile,
  retentionRules,
  mergeRules,
  edgeRules,
  deploymentConfigs,
  provision,
  prepare,
  configureEdges,
  bootstrap,
  platformConnection,
  parseActivation,
  main,
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
      applicationVars: {
        AUTH_MODE: "access_required",
        IMAGES_ENABLED: "false",
        AUDIT_ARCHIVE_DAYS: "730",
        AUDIT_ARCHIVE_LOCK_DAYS: "1",
        BETTER_AUTH_URL: "https://old.example.com",
      },
      publicVars: { PUBLIC_PUBLISHING_ENABLED: "false", FORMS_DAILY_LIMIT: "22" },
      enable: parseActivation("--enable= semantic, ,costs, semantic "),
    });
    expect(stage.application.vars).toMatchObject({
      AUTH_MODE: "access_required",
      IMAGES_ENABLED: "false",
      AUDIT_ARCHIVE_DAYS: "730",
      AUDIT_ARCHIVE_LOCK_DAYS: "365",
      BETTER_AUTH_URL: platformProfile("staging").appOrigin,
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
    for (const option of ["--enable=", "--enable= ", "--enable=,"])
      expect(() => parseActivation(option)).toThrow("Choose features");
    expect(() => parseActivation("--enable=semantic, access")).toThrow("Choose features");
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
    const api = vi.fn(async (path) => (path.endsWith("-public/settings") ? null : { bindings: [] })),
      execute = vi.fn();
    await expect(bootstrap(platformProfile(), api, "/tmp/noteflare-bootstrap-test", {}, execute)).rejects.toThrow(
      "never generated or replaced",
    );
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      "/workers/scripts/cloudflare-realtime-notes/settings",
      "/workers/scripts/cloudflare-realtime-notes-public/settings",
    ]);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "initializes identity separately from the old Turnstile sitekey (existing public %s)",
    async (existingPublic) => {
      const profile = platformProfile();
      const directory = mkdtempSync(join(tmpdir(), "noteflare-bootstrap-mismatch-"));
      const execute = vi.fn(() => ({ status: 0 }));
      const appSettings = {
        bindings: [
          { type: "plain_text", name: "TURNSTILE_SITE_KEY", text: "previous-widget" },
          { type: "secret_text", name: "BETTER_AUTH_SECRET" },
        ],
      };
      const api = vi.fn(async (path, options) => {
        if (path === `/workers/scripts/${profile.name}/settings`) return appSettings;
        if (path === `/workers/scripts/${profile.publicName}/settings`)
          return existingPublic ? { bindings: appSettings.bindings.slice(0, 1) } : { bindings: [] };
        if (path.startsWith("/challenges/widgets?"))
          return { result: [{ name: `${profile.name}-platform`, sitekey: "managed-widget" }] };
        if (path === "/challenges/widgets/managed-widget")
          return {
            name: `${profile.name}-platform`,
            sitekey: "managed-widget",
            secret: "test-secret",
            domains: [new URL(profile.appOrigin).hostname, new URL(profile.publicOrigin).hostname],
          };
        if (path.endsWith("/secrets") && options?.method === "PUT") return {};
        throw new Error(`Unexpected request ${path}`);
      });
      if (!existingPublic) api.mockImplementationOnce(async () => appSettings).mockResolvedValueOnce(null);
      try {
        const result = await bootstrap(
          profile,
          api,
          directory,
          {
            BETTER_AUTH_SECRET: "x".repeat(32),
            CF_ANALYTICS_API_TOKEN: "analytics-test-token",
          },
          execute,
        );
        expect(result.awaitingTurnstileReplacement).toEqual(
          existingPublic ? [profile.name, profile.publicName] : [profile.name],
        );
        expect(execute).toHaveBeenCalledTimes(existingPublic ? 0 : 1);
        const writes = api.mock.calls
          .filter(([, options]) => options?.method === "PUT")
          .map(([path, options]) => [path, options.body.name]);
        const publicPath = `/workers/scripts/${profile.publicName}/secrets`;
        expect(writes).toEqual([
          [publicPath, "BETTER_AUTH_SECRET"],
          [`/workers/scripts/${profile.name}/secrets`, "CF_ANALYTICS_API_TOKEN"],
          ...(!existingPublic ? [[publicPath, "TURNSTILE_SECRET_KEY"]] : []),
        ]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
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
    ).rejects.toThrow("PLATFORM_STAGING_BETTER_AUTH_SECRET");
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      "/workers/scripts/cloudflare-realtime-notes-platform-staging/settings",
      "/workers/scripts/cloudflare-realtime-notes-platform-staging-public/settings",
    ]);
  });
  it("initializes staging credentials and skips installed secrets on a rerun", async () => {
    const profile = platformProfile("staging");
    const directory = mkdtempSync(join(tmpdir(), "noteflare-bootstrap-"));
    let configured = false;
    const api = vi.fn(async (path, options) => {
      if (path.endsWith("/settings")) {
        if (!configured) return null;
        return {
          bindings: [
            { type: "plain_text", name: "BETTER_AUTH_URL", text: profile.appOrigin },
            { type: "plain_text", name: "TURNSTILE_SITE_KEY", text: "staging-widget" },
            ...["BETTER_AUTH_SECRET", "TURNSTILE_SECRET_KEY", "BOOTSTRAP_TOKEN"].map((name) => ({
              type: "secret_text",
              name,
            })),
          ],
        };
      }
      if (path.startsWith("/challenges/widgets?"))
        return { result: [{ name: `${profile.name}-platform`, sitekey: "staging-widget" }] };
      if (path === "/challenges/widgets/staging-widget")
        return {
          name: `${profile.name}-platform`,
          sitekey: "staging-widget",
          secret: "initial-test-secret",
          domains: [new URL(profile.appOrigin).hostname, new URL(profile.publicOrigin).hostname],
        };
      if (path.endsWith("/secrets") && options.method === "PUT") return {};
      throw new Error(`Unexpected fixture request: ${path}`);
    });
    const productionOnly = { BETTER_AUTH_SECRET: "prod-test-secret-".repeat(3), BOOTSTRAP_TOKEN: "prod-test-token" };
    const execute = vi.fn(() => ({ status: 0 }));
    try {
      await bootstrap(profile, api, directory, productionOnly, execute);
      const persisted = readFileSync(join(directory, "bootstrap.env"), "utf8");
      expect(persisted).toMatch(/^BETTER_AUTH_SECRET=[\w-]{64}\nBOOTSTRAP_TOKEN=[\w-]{64}\n$/);
      expect(persisted).not.toContain(productionOnly.BETTER_AUTH_SECRET);
      expect(JSON.stringify(api.mock.calls)).not.toContain(productionOnly.BOOTSTRAP_TOKEN);
      expect(execute).toHaveBeenCalledTimes(2);
      configured = true;
      api.mockClear();
      execute.mockClear();
      await bootstrap(profile, api, directory, productionOnly, execute);
      expect(execute).not.toHaveBeenCalled();
      expect(api.mock.calls.filter(([, options]) => options?.method === "PUT")).toEqual([]);
      expect(readFileSync(join(directory, "bootstrap.env"), "utf8")).toBe(persisted);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("rejects replayed workflow activations and malformed empty selections before provider preflight", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_RUN_ATTEMPT", "2");
    try {
      await expect(main(["prepare", "production", "--enable= "])).rejects.toThrow("Choose features");
      await expect(main(["prepare", "production", "--enable= forms, tables, turnstile "])).rejects.toThrow(
        "new dispatch",
      );
      await expect(main(["prepare", "production", "--replace-turnstile"])).rejects.toThrow("new dispatch");
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("pins an explicit widget replacement in the prepared release without writing its secret", async () => {
    const profile = platformProfile();
    const directory = mkdtempSync(join(tmpdir(), "noteflare-replace-widget-"));
    const base = unstable_readConfig({ config: "wrangler.jsonc", env: "production" }, { hideWarnings: true });
    const rules = retentionRules();
    let partialActivation = false;
    const widget = {
      name: `${profile.name}-platform`,
      sitekey: "managed-widget",
      domains: [new URL(profile.appOrigin).hostname, new URL(profile.publicOrigin).hostname],
      secret: "test-secret-must-stay-out-of-prepared-files",
    };
    const api = vi.fn(async (path) => {
      if (path.startsWith("/r2/buckets?"))
        return {
          result: { buckets: [profile.original, profile.publications, profile.audit].map((name) => ({ name })) },
        };
      if (path.endsWith("/domains/managed")) return { enabled: false };
      if (path.endsWith("/domains/custom")) return { domains: [] };
      if (path.endsWith("/lock")) return { rules: [rules.lock] };
      if (path.endsWith("/lifecycle")) return { rules: rules.lifecycle };
      if (path.endsWith("/metadata_index/list"))
        return { metadataIndexes: [{ propertyName: "spaceId", indexType: "String" }] };
      if (path.startsWith("/vectorize")) return { config: { dimensions: 384, metric: "cosine" } };
      if (path.startsWith("/challenges/widgets?")) return { result: [widget] };
      if (path.startsWith("/d1/database?"))
        return { result: [{ name: profile.name, uuid: base.d1_databases[0].database_id }] };
      if (path.endsWith("/settings"))
        return {
          bindings: [
            { type: "plain_text", name: "BETTER_AUTH_URL", text: profile.appOrigin },
            { type: "plain_text", name: "TURNSTILE_SITE_KEY", text: "previous-widget" },
            { type: "plain_text", name: "TURNSTILE_ENABLED", text: "true" },
            { type: "secret_text", name: "BETTER_AUTH_SECRET" },
            ...(partialActivation && path === `/workers/scripts/${profile.name}/settings`
              ? [
                  { type: "plain_text", name: "FORMS_ENABLED", text: "true" },
                  { type: "plain_text", name: "TABLE_AUTHORITY_ENABLED", text: "true" },
                ]
              : []),
          ],
        };
      throw new Error(`Unexpected request ${path}`);
    });
    try {
      await expect(prepare(profile, api, directory)).rejects.toThrow("--replace-turnstile");
      expect(readdirSync(directory)).toEqual([]);
      partialActivation = true;
      await expect(prepare(profile, api, directory, false, [], true)).rejects.toThrow(
        "FORMS_ENABLED (application true, public false)",
      );
      expect(readdirSync(directory)).toEqual([]);
      const prepared = await prepare(profile, api, directory, false, ["forms", "tables"], true);
      const manifest = readFileSync(join(directory, "settings-fingerprints.json"), "utf8");
      expect(JSON.parse(manifest).turnstileReplacementSitekey).toBe(widget.sitekey);
      for (const path of Object.values(prepared)) {
        const content = readFileSync(path, "utf8");
        expect(JSON.parse(content).vars.TURNSTILE_SITE_KEY).toBe(widget.sitekey);
        expect(JSON.parse(content).vars.FORMS_ENABLED).toBe("true");
        expect(content).not.toContain(widget.secret);
      }
      expect(manifest).not.toContain(widget.secret);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
