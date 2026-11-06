import { describe, expect, it } from "vitest";
import { validatePlatformConfiguration } from "./platform-config.mjs";
describe("optional platform deployment", () => {
  it("accepts an installation without optional services", () =>
    expect(() => validatePlatformConfiguration({ vars: { AUTH_MODE: "local" } })).not.toThrow());
  it("rejects enabled missing services without provisioning them", () =>
    expect(() => validatePlatformConfiguration({ vars: { SEMANTIC_SEARCH_ENABLED: "true" } })).toThrow("AI binding"));
  it("rejects the mixed-use bucket and noncanonical publishing origins", () => {
    const config = {
      vars: { PUBLIC_BASE_URL: "https://public.example.com", PUBLIC_PUBLISHING_ENABLED: "true" },
      r2_buckets: [
        { binding: "BUCKET", bucket_name: "shared" },
        { binding: "PUBLICATIONS_BUCKET", bucket_name: "shared" },
      ],
    };
    expect(() => validatePlatformConfiguration(config)).toThrow("mixed-use");
    config.r2_buckets[1].bucket_name = "private-publications";
    config.vars.PUBLIC_BASE_URL = "https://app.workers.dev";
    expect(() => validatePlatformConfiguration(config)).toThrow("custom HTTPS");
  });
  it("checks configured secrets without accepting their public vars", () =>
    expect(() =>
      validatePlatformConfiguration(
        { vars: { TURNSTILE_ENABLED: "true", TURNSTILE_SITE_KEY: "site", TURNSTILE_SECRET_KEY: "unsafe" } },
        { secretNames: [] },
      ),
    ).toThrow("Worker secret"));
  it("requires Forms authority and a challenge", () =>
    expect(() =>
      validatePlatformConfiguration({ vars: { FORMS_ENABLED: "true", TABLE_AUTHORITY_ENABLED: "true" } }),
    ).toThrow("Turnstile"));
  it("requires durable recovery for image jobs and purge credentials", () => {
    expect(() =>
      validatePlatformConfiguration({ vars: { IMAGES_ENABLED: "true" }, images: { binding: "IMAGES" } }),
    ).toThrow("PLATFORM");
    expect(() => validatePlatformConfiguration({ vars: {} }, { secretNames: ["CF_CACHE_PURGE_API_TOKEN"] })).toThrow(
      "CF_ZONE_ID",
    );
    expect(() =>
      validatePlatformConfiguration(
        { vars: { CF_ZONE_ID: "zone", PUBLIC_BASE_URL: "https://public.example.com" } },
        { secretNames: ["CF_CACHE_PURGE_API_TOKEN"] },
      ),
    ).toThrow("PLATFORM");
  });
  it("accepts explicitly configured optional capabilities without provisioning", () => {
    const config = {
      vars: {
        AUTH_MODE: "access_required",
        ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        ACCESS_AUD: "audience",
        BETTER_AUTH_URL: "https://app.example.com",
        PUBLIC_BASE_URL: "https://public.example.com",
        CF_ZONE_ID: "zone",
        SAAS_CNAME_TARGET: "public.example.com",
        TURNSTILE_SITE_KEY: "site",
        SEMANTIC_SEARCH_ENABLED: "true",
        IMAGES_ENABLED: "true",
        TURNSTILE_ENABLED: "true",
        TABLE_AUTHORITY_ENABLED: "true",
        TABLE_GALLERY_ENABLED: "true",
        FORMS_ENABLED: "true",
        PUBLIC_PUBLISHING_ENABLED: "true",
        CUSTOM_HOSTNAMES_ENABLED: "true",
        AUDIT_ENABLED: "true",
        HEATMAPS_ENABLED: "true",
        BASIN_ENABLED: "true",
      },
      ai: { binding: "AI" },
      vectorize: [{ binding: "SEMANTIC_INDEX" }],
      images: { binding: "IMAGES" },
      r2_buckets: [
        { binding: "BUCKET", bucket_name: "private-originals" },
        { binding: "PUBLICATIONS_BUCKET", bucket_name: "private-publications" },
      ],
      pipelines: [{ binding: "AUDIT_PIPELINE" }, { binding: "HEATMAP_PIPELINE" }],
      durable_objects: { bindings: [{ name: "PLATFORM" }] },
    };
    expect(() =>
      validatePlatformConfiguration(config, {
        secretNames: ["TURNSTILE_SECRET_KEY", "CF_SAAS_API_TOKEN", "CF_CACHE_PURGE_API_TOKEN", "HEATMAP_HMAC_KEY"],
      }),
    ).not.toThrow();
  });
});
